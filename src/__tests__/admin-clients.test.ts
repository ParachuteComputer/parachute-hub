/**
 * Tests for /api/oauth/clients/:id and /api/oauth/clients/:id/approve.
 *
 * Covers:
 *   - GET: 401 without Bearer, 403 with the wrong scope, 200 with the right
 *     scope, 404 for unknown client_id, 405 on POST.
 *   - POST approve: same auth surface, 200 + audit log on a pending row,
 *     200 + `already_approved` on a re-approve, 404 unknown id, 405 on GET.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApproveClient, handleGetClient } from "../admin-clients.ts";
import { approveClient, getClient, registerClient } from "../clients.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-admin-clients-"));
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

function regPending(name?: string): string {
  const r = registerClient(harness.db, {
    redirectUris: ["https://app.example/cb"],
    scopes: ["vault:work:read"],
    status: "pending",
    ...(name !== undefined ? { clientName: name } : {}),
  });
  return r.client.clientId;
}

function getReq(clientId: string, bearer?: string): Request {
  const init: RequestInit = {};
  if (bearer) init.headers = { authorization: `Bearer ${bearer}` };
  return new Request(`${ISSUER}/api/oauth/clients/${encodeURIComponent(clientId)}`, init);
}

function approveReq(clientId: string, bearer?: string, method = "POST"): Request {
  const init: RequestInit = { method };
  if (bearer) init.headers = { authorization: `Bearer ${bearer}` };
  return new Request(`${ISSUER}/api/oauth/clients/${encodeURIComponent(clientId)}/approve`, init);
}

describe("handleGetClient", () => {
  test("401 without Bearer", async () => {
    const id = regPending("App");
    const res = await handleGetClient(getReq(id), id, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
  });

  test("403 with the wrong scope", async () => {
    const { bearer } = await makeOperatorBearer(["parachute:host:auth"]);
    const id = regPending("App");
    const res = await handleGetClient(getReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(403);
  });

  test("200 returns client details", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending("Notes");
    const res = await handleGetClient(getReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toBe(id);
    expect(body.client_name).toBe("Notes");
    expect(body.status).toBe("pending");
    expect(body.redirect_uris).toEqual(["https://app.example/cb"]);
    expect(body.scopes).toEqual(["vault:work:read"]);
    expect(typeof body.registered_at).toBe("string");
    // hub#312 — same_hub surfaced for future SPA badging. Default false
    // when the test registers via the helper (no operator-auth path).
    expect(body.same_hub).toBe(false);
  });

  test("same_hub=true client surfaces same_hub: true in the response (hub#312)", async () => {
    // The DCR path stamps same_hub=true on operator-authenticated
    // registrations. Pin that the admin view exposes that flag so future
    // SPA changes (per-client same-hub badge) can read it directly from
    // /api/oauth/clients/<id>.
    const { bearer } = await makeOperatorBearer();
    const r = registerClient(harness.db, {
      redirectUris: ["https://app.example/cb"],
      scopes: ["vault:work:read"],
      status: "approved",
      sameHub: true,
      clientName: "SameHubApp",
    });
    const id = r.client.clientId;
    const res = await handleGetClient(getReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.same_hub).toBe(true);
  });

  test("returns the row's status after approval (so the SPA can short-circuit re-approve)", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending("Notes");
    approveClient(harness.db, id);
    const res = await handleGetClient(getReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("approved");
  });

  test("404 for unknown client_id", async () => {
    const { bearer } = await makeOperatorBearer();
    const res = await handleGetClient(getReq("nope", bearer), "nope", {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  test("405 on POST", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending();
    const req = new Request(`${ISSUER}/api/oauth/clients/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
    });
    const res = await handleGetClient(req, id, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });

  test("client_name is null when never set", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending(); // no client_name
    const res = await handleGetClient(getReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_name).toBeNull();
  });
});

describe("handleApproveClient", () => {
  test("401 without Bearer", async () => {
    const id = regPending();
    const res = await handleApproveClient(approveReq(id), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(401);
    // Row still pending.
    expect(getClient(harness.db, id)?.status).toBe("pending");
  });

  test("403 with the wrong scope", async () => {
    const { bearer } = await makeOperatorBearer(["parachute:host:auth"]);
    const id = regPending();
    const res = await handleApproveClient(approveReq(id, bearer), id, {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(403);
    expect(getClient(harness.db, id)?.status).toBe("pending");
  });

  test("200 flips a pending row to approved + emits an audit log line", async () => {
    const { bearer, userId } = await makeOperatorBearer();
    const id = regPending("Notes");

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    let res: Response;
    try {
      res = await handleApproveClient(approveReq(id, bearer), id, {
        db: harness.db,
        issuer: ISSUER,
      });
    } finally {
      console.log = originalLog;
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.client_id).toBe(id);
    expect(body.status).toBe("approved");
    expect(body.already_approved).toBe(false);
    expect(getClient(harness.db, id)?.status).toBe("approved");

    const line = logs.find((l) => l.startsWith("client approved:"));
    expect(line).toBeDefined();
    expect(line).toContain(`client_id=${id}`);
    expect(line).toContain("client_name=Notes");
    expect(line).toContain(`approver_sub=${userId}`);
  });

  test("idempotent: re-approving returns already_approved: true + NO audit line", async () => {
    // Pin the audit-log idempotency contract explicitly: a no-op approve
    // (the row was already approved) must NOT emit the "client approved:"
    // line. Without this gate a UI tab re-submitting Approve, or a deep-
    // linked operator approving an already-approved client, would
    // pollute the log with confusing "approved a thing that was already
    // approved" noise. The handler captures `wasPending` BEFORE calling
    // approveClient so this property holds even if a future refactor
    // splits the read / write across statements.
    const { bearer } = await makeOperatorBearer();
    const id = regPending();
    approveClient(harness.db, id);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    let res: Response;
    try {
      res = await handleApproveClient(approveReq(id, bearer), id, {
        db: harness.db,
        issuer: ISSUER,
      });
    } finally {
      console.log = originalLog;
    }
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.already_approved).toBe(true);
    expect(body.status).toBe("approved");

    const approvedLine = logs.find((l) => l.startsWith("client approved:"));
    expect(approvedLine).toBeUndefined();
  });

  test("404 for unknown client_id", async () => {
    const { bearer } = await makeOperatorBearer();
    const res = await handleApproveClient(approveReq("nope", bearer), "nope", {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(404);
  });

  test("405 on GET", async () => {
    const { bearer } = await makeOperatorBearer();
    const id = regPending();
    const req = new Request(`${ISSUER}/api/oauth/clients/${id}/approve`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    const res = await handleApproveClient(req, id, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });
});
