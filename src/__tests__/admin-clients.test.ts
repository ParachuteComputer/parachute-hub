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

  // Workstream D — OAuth resume via `return_to`. The SPA approve page
  // can pass a hub-relative authorize URL as JSON body; the response
  // echoes it as `redirect_to` so the SPA can navigate the browser there
  // and resume the parked OAuth flow. The pre-D no-body shape continues
  // to work (no `redirect_to` field, share-link dead-end case).
  describe("workstream D — return_to / redirect_to", () => {
    function jsonApproveReq(clientId: string, bearer: string, body: unknown): Request {
      return new Request(`${ISSUER}/api/oauth/clients/${encodeURIComponent(clientId)}/approve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    test("echoes a same-origin /oauth/authorize?... return_to as redirect_to", async () => {
      const { bearer } = await makeOperatorBearer();
      const id = regPending();
      const returnTo =
        "/oauth/authorize?client_id=" +
        encodeURIComponent(id) +
        "&response_type=code&scope=vault%3Awork%3Aread";
      const res = await handleApproveClient(
        jsonApproveReq(id, bearer, { return_to: returnTo }),
        id,
        { db: harness.db, issuer: ISSUER },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.redirect_to).toBe(returnTo);
      expect(body.status).toBe("approved");
      expect(getClient(harness.db, id)?.status).toBe("approved");
    });

    test("omits redirect_to entirely when return_to is missing (share-link case preserved)", async () => {
      const { bearer } = await makeOperatorBearer();
      const id = regPending();
      // No body — the pre-D shape. The endpoint must continue to work.
      const res = await handleApproveClient(approveReq(id, bearer), id, {
        db: harness.db,
        issuer: ISSUER,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("redirect_to");
      expect(body.status).toBe("approved");
    });

    test("drops an off-origin return_to (scheme-relative) silently, still approves", async () => {
      const { bearer } = await makeOperatorBearer();
      const id = regPending();
      const res = await handleApproveClient(
        jsonApproveReq(id, bearer, { return_to: "//evil.example/oauth/authorize?foo=1" }),
        id,
        { db: harness.db, issuer: ISSUER },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // No redirect_to — server refuses to echo a bad value. The client
      // is still approved (we don't fail an otherwise-legitimate approve
      // over a malformed return_to).
      expect(body).not.toHaveProperty("redirect_to");
      expect(getClient(harness.db, id)?.status).toBe("approved");
    });

    test("drops a non-authorize return_to (off-path) silently", async () => {
      const { bearer } = await makeOperatorBearer();
      const id = regPending();
      const res = await handleApproveClient(
        jsonApproveReq(id, bearer, { return_to: "/admin/vaults" }),
        id,
        { db: harness.db, issuer: ISSUER },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // `/admin/vaults` is same-origin but isn't a `/oauth/authorize?...`
      // URL — the server-side gate is "authorize URL only" so the SPA
      // can't be used as a redirect gadget for arbitrary in-SPA navigation.
      expect(body).not.toHaveProperty("redirect_to");
    });

    test("drops absolute URL return_to silently", async () => {
      const { bearer } = await makeOperatorBearer();
      const id = regPending();
      const res = await handleApproveClient(
        jsonApproveReq(id, bearer, {
          return_to: "https://evil.example/oauth/authorize?foo=1",
        }),
        id,
        { db: harness.db, issuer: ISSUER },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("redirect_to");
    });

    test("non-JSON body is treated as 'no return_to' (no parser explosion)", async () => {
      const { bearer } = await makeOperatorBearer();
      const id = regPending();
      // text/plain body — pre-D / unknown clients send anything. The
      // endpoint must NOT throw on parse and must NOT echo a redirect_to.
      const req = new Request(`${ISSUER}/api/oauth/clients/${id}/approve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "text/plain",
        },
        body: "garbage",
      });
      const res = await handleApproveClient(req, id, {
        db: harness.db,
        issuer: ISSUER,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("redirect_to");
    });

    test("malformed JSON body is treated as 'no return_to'", async () => {
      const { bearer } = await makeOperatorBearer();
      const id = regPending();
      const req = new Request(`${ISSUER}/api/oauth/clients/${id}/approve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: "{not json",
      });
      const res = await handleApproveClient(req, id, {
        db: harness.db,
        issuer: ISSUER,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("redirect_to");
    });

    test("re-approve with return_to echoes redirect_to (idempotent path)", async () => {
      // The OAuth resume flow can legitimately race: operator opens the
      // approve link, an automated path approves the same client, then
      // operator clicks. We still want the redirect to fire so the
      // operator's flow resumes — not dead-end on already_approved.
      const { bearer } = await makeOperatorBearer();
      const id = regPending();
      approveClient(harness.db, id);
      const returnTo = `/oauth/authorize?client_id=${encodeURIComponent(id)}&response_type=code&scope=vault%3Awork%3Aread`;
      const res = await handleApproveClient(
        jsonApproveReq(id, bearer, { return_to: returnTo }),
        id,
        { db: harness.db, issuer: ISSUER },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.already_approved).toBe(true);
      expect(body.redirect_to).toBe(returnTo);
    });
  });
});
