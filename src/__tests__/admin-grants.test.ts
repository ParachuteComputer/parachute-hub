/**
 * Tests for /api/grants and /api/grants/:client_id.
 *
 * Covers:
 *   - GET: 401 without Bearer, 403 with the wrong scope, 200 with the right
 *     scope; vault filter; client_name surfaced; multi-user isolation.
 *   - DELETE: 401/403 mirror the GET surface; 404 when no grant exists; 204
 *     on success; audit log emitted.
 *   - 405 on wrong methods.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleListGrants, handleRevokeGrant } from "../admin-grants.ts";
import { registerClient } from "../clients.ts";
import { recordGrant } from "../grants.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-admin-grants-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

async function makeOperatorBearer(scopes = ["parachute:host:admin"]): Promise<{
  bearer: string;
  userId: string;
}> {
  const user = await createUser(harness.db, "operator", "pw");
  const minted = await signAccessToken(harness.db, {
    sub: user.id,
    scopes,
    audience: "hub",
    clientId: "parachute-hub-spa",
    issuer: ISSUER,
    ttlSeconds: 600,
  });
  return { bearer: minted.token, userId: user.id };
}

function reg(name?: string): string {
  const r = registerClient(harness.db, {
    redirectUris: ["https://app.example/cb"],
    ...(name !== undefined ? { clientName: name } : {}),
  });
  return r.client.clientId;
}

function listReq(query = ""): Request {
  return new Request(`${ISSUER}/api/grants${query}`);
}
function listReqWithBearer(bearer: string, query = ""): Request {
  return new Request(`${ISSUER}/api/grants${query}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
}
function deleteReq(clientId: string, bearer?: string): Request {
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return new Request(`${ISSUER}/api/grants/${clientId}`, {
    method: "DELETE",
    headers,
  });
}

describe("handleListGrants", () => {
  test("401 with no Authorization header", async () => {
    const res = await handleListGrants(listReq(), { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
  });

  test("403 when token lacks parachute:host:admin", async () => {
    const { bearer } = await makeOperatorBearer(["other:scope"]);
    const res = await handleListGrants(listReqWithBearer(bearer), {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(403);
  });

  test("405 on POST", async () => {
    const { bearer } = await makeOperatorBearer();
    const req = new Request(`${ISSUER}/api/grants`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
    });
    const res = await handleListGrants(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });

  test("200 returns operator's grants enriched with client_name", async () => {
    const { bearer, userId } = await makeOperatorBearer();
    const cidA = reg("App A");
    const cidB = reg(); // no display name
    recordGrant(harness.db, userId, cidA, ["vault:work:read", "vault:work:write"]);
    recordGrant(harness.db, userId, cidB, ["notes:read"]);

    const res = await handleListGrants(listReqWithBearer(bearer), {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { grants: Array<Record<string, unknown>> };
    expect(body.grants).toHaveLength(2);

    const a = body.grants.find((g) => g.client_id === cidA);
    expect(a).toBeDefined();
    expect(a?.client_name).toBe("App A");
    expect(a?.scopes).toEqual(["vault:work:read", "vault:work:write"]);

    const b = body.grants.find((g) => g.client_id === cidB);
    expect(b?.client_name).toBeNull();
  });

  test("?vault=<name> filters to grants whose scopes touch that vault", async () => {
    const { bearer, userId } = await makeOperatorBearer();
    const work = reg("Work app");
    const scratch = reg("Scratch app");
    recordGrant(harness.db, userId, work, ["vault:work:read"]);
    recordGrant(harness.db, userId, scratch, ["vault:scratch:read", "vault:scratch:write"]);

    const res = await handleListGrants(listReqWithBearer(bearer, "?vault=work"), {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grants: Array<{ client_id: string }> };
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]?.client_id).toBe(work);
  });

  test("?vault filter rejects garbage names with 400", async () => {
    const { bearer } = await makeOperatorBearer();
    const res = await handleListGrants(listReqWithBearer(bearer, "?vault=hi%2Fthere"), {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(400);
  });

  test("does not leak grants belonging to a different user", async () => {
    const { bearer, userId } = await makeOperatorBearer();
    // A second user with their own grant — must not appear in operator A's list.
    const otherUser = await createUser(harness.db, "other", "pw", { allowMulti: true });
    const cid = reg("Some app");
    recordGrant(harness.db, otherUser.id, cid, ["vault:work:read"]);
    recordGrant(harness.db, userId, cid, ["notes:read"]);

    const res = await handleListGrants(listReqWithBearer(bearer), {
      db: harness.db,
      issuer: ISSUER,
    });
    const body = (await res.json()) as { grants: Array<{ user_id: string; scopes: string[] }> };
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]?.user_id).toBe(userId);
    expect(body.grants[0]?.scopes).toEqual(["notes:read"]);
  });
});

describe("handleRevokeGrant", () => {
  test("401 with no Authorization header", async () => {
    const res = await handleRevokeGrant(deleteReq("nope"), "nope", {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(401);
  });

  test("403 when token lacks parachute:host:admin", async () => {
    const { bearer } = await makeOperatorBearer(["other:scope"]);
    const res = await handleRevokeGrant(deleteReq("nope", bearer), "nope", {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(403);
  });

  test("405 on GET", async () => {
    const { bearer } = await makeOperatorBearer();
    const cid = reg();
    const req = new Request(`${ISSUER}/api/grants/${cid}`, {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}` },
    });
    const res = await handleRevokeGrant(req, cid, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });

  test("404 when no grant exists for (user, client)", async () => {
    const { bearer } = await makeOperatorBearer();
    const cid = reg();
    const res = await handleRevokeGrant(deleteReq(cid, bearer), cid, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(404);
  });

  test("204 deletes the operator's grant and emits an audit log line", async () => {
    const { bearer, userId } = await makeOperatorBearer();
    const cid = reg("App A");
    recordGrant(harness.db, userId, cid, ["vault:work:read"]);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const res = await handleRevokeGrant(deleteReq(cid, bearer), cid, {
        db: harness.db,
        issuer: ISSUER,
      });
      expect(res.status).toBe(204);
    } finally {
      console.log = originalLog;
    }
    // Grant is gone.
    const followup = await handleRevokeGrant(deleteReq(cid, bearer), cid, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(followup.status).toBe(404);

    // Audit line carries client_id, user_id, and the scopes that were revoked.
    const line = logs.find((l) => l.startsWith("grant revoked:"));
    expect(line).toBeDefined();
    expect(line).toContain(`client_id=${cid}`);
    expect(line).toContain(`user_id=${userId}`);
    expect(line).toContain("scopes=vault:work:read");
  });

  test("404 when the operator tries to revoke another user's grant", async () => {
    const { bearer } = await makeOperatorBearer();
    const otherUser = await createUser(harness.db, "other", "pw", { allowMulti: true });
    const cid = reg();
    recordGrant(harness.db, otherUser.id, cid, ["vault:work:read"]);

    const res = await handleRevokeGrant(deleteReq(cid, bearer), cid, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(404);
  });
});
