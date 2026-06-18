/**
 * Tests for the agent-connector GRANTS subsystem (`admin-agent-grants.ts`, 4b-1).
 *
 * The handler has two auth classes:
 *   - module-auth (a `parachute:host:admin` Bearer): PUT /admin/grants,
 *     GET /admin/grants, GET /admin/grants/<id>/material.
 *   - operator-auth (a first-admin session cookie): POST /admin/grants/<id>/approve,
 *     POST /admin/grants/<id>/revoke.
 *
 * Tokens are real (minted by the actual `signAccessToken`), so an approved vault
 * grant's `/material` token can be decoded + asserted (scope/aud/permissions) the
 * way the vault would read it. The store is a real tmpdir JSON file, so the
 * 0600 + secret-not-in-list invariants are exercised end to end.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { type AgentGrantsDeps, handleAgentGrants } from "../admin-agent-grants.ts";
import { readGrants } from "../grants-store.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { findTokenRowByJti } from "../jwt-sign.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const HUB_ORIGIN = "https://hub.test";
const VAULT_ORIGIN = "http://127.0.0.1:1940";

interface Harness {
  db: Database;
  storePath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-agent-grants-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  return {
    db,
    storePath: join(dir, "agent-grants.json"),
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

/** Vaults that "exist" for resolveVaultOrigin. */
let installedVaults = new Set<string>(["research"]);
beforeEach(() => {
  installedVaults = new Set<string>(["research"]);
});

function deps(): AgentGrantsDeps {
  return {
    db: harness.db,
    hubOrigin: HUB_ORIGIN,
    storePath: harness.storePath,
    resolveVaultOrigin: (name) => (installedVaults.has(name) ? VAULT_ORIGIN : null),
  };
}

// --- Auth helpers -----------------------------------------------------------
//
// Robust to call order: the FIRST user created in a test is the first-admin
// (the operator). `ensureFirstAdmin` lazily creates + memoizes that user so
// `moduleBearer`/`operatorCookie`/`friendCookie` can be called in any order
// without tripping the single-user guard.

let firstAdminId: string | null = null;
beforeEach(() => {
  firstAdminId = null;
});

async function ensureFirstAdmin(): Promise<string> {
  if (firstAdminId) return firstAdminId;
  const user = await createUser(harness.db, "operator", "pw");
  firstAdminId = user.id;
  return user.id;
}

async function moduleBearer(scopes = ["parachute:host:admin"]): Promise<string> {
  // The module is some on-box caller — it just needs a valid host-admin Bearer.
  // Reuse the first-admin as its subject (it's a token-scope gate, not a
  // session gate, so the subject identity doesn't matter for these routes).
  const sub = await ensureFirstAdmin();
  const minted = await signAccessToken(harness.db, {
    sub,
    scopes,
    audience: "hub",
    clientId: "parachute-hub-spa",
    issuer: HUB_ORIGIN,
    ttlSeconds: 600,
  });
  return minted.token;
}

async function operatorCookie(): Promise<string> {
  const userId = await ensureFirstAdmin();
  const session = createSession(harness.db, { userId });
  return buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
}

async function friendCookie(): Promise<string> {
  await ensureFirstAdmin(); // first-admin must exist
  const friend = await createUser(harness.db, "friend", "pw", { allowMulti: true });
  const session = createSession(harness.db, { userId: friend.id });
  return buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
}

// --- Request builders -------------------------------------------------------

function bearerReq(method: string, path: string, bearer: string, body?: unknown): Request {
  return new Request(`${HUB_ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function cookieReq(method: string, path: string, cookie: string, body?: unknown): Request {
  return new Request(`${HUB_ORIGIN}${path}`, {
    method,
    headers: {
      cookie,
      origin: HUB_ORIGIN,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function dispatch(req: Request): Promise<Response> {
  const subPath = new URL(req.url).pathname.slice("/admin/grants".length);
  return handleAgentGrants(req, subPath, deps());
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// === PUT /admin/grants ======================================================

describe("PUT /admin/grants (upsert)", () => {
  test("creates a pending vault grant (201) — no material in the response", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "agent1",
        connection: { kind: "vault", target: "research", access: "read", tags: ["#published"] },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.status).toBe("pending");
    expect(body.agent).toBe("agent1");
    expect(body).not.toHaveProperty("material");
    expect((body.connection as Record<string, unknown>).tags).toEqual(["#published"]);
    expect(typeof body.id).toBe("string");
  });

  test("is idempotent — re-PUT the same connection returns 200, no duplicate row", async () => {
    const bearer = await moduleBearer();
    const spec = { kind: "vault", target: "research", access: "read" };
    const r1 = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, { agent: "a", connection: spec }),
    );
    expect(r1.status).toBe(201);
    const r2 = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, { agent: "a", connection: spec }),
    );
    expect(r2.status).toBe(200);
    expect(readGrants(harness.storePath)).toHaveLength(1);
  });

  test("a service grant carries inject hints", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "a",
        connection: { kind: "service", target: "github", inject: ["env", "mcp"] },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect((body.connection as Record<string, unknown>).inject).toEqual(["env", "mcp"]);
  });

  test("an mcp grant stays pending with the slice-2 reason", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "a",
        connection: { kind: "mcp", target: "https://remote.test/mcp" },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.status).toBe("pending");
    expect(body.reason).toBe("oauth not yet supported");
  });

  test("re-declaring an APPROVED grant does not downgrade it to pending", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const spec = { kind: "vault", target: "research", access: "read" };
    const created = await json(
      await dispatch(bearerReq("PUT", "/admin/grants", bearer, { agent: "a", connection: spec })),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    // re-declare
    const re = await json(
      await dispatch(bearerReq("PUT", "/admin/grants", bearer, { agent: "a", connection: spec })),
    );
    expect(re.status).toBe("approved");
  });

  test("401 without a Bearer", async () => {
    const req = new Request(`${HUB_ORIGIN}/admin/grants`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "a", connection: { kind: "vault", target: "research" } }),
    });
    const res = await dispatch(req);
    expect(res.status).toBe(401);
  });

  test("403 when the Bearer lacks parachute:host:admin", async () => {
    const bearer = await moduleBearer(["vault:research:read"]);
    const res = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "a",
        connection: { kind: "vault", target: "research" },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("400 on a bad agent name / bad spec", async () => {
    const bearer = await moduleBearer();
    expect(
      (
        await dispatch(
          bearerReq("PUT", "/admin/grants", bearer, {
            agent: "bad name!",
            connection: { kind: "vault", target: "research" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await dispatch(
          bearerReq("PUT", "/admin/grants", bearer, {
            agent: "a",
            connection: { kind: "nope", target: "x" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await dispatch(
          bearerReq("PUT", "/admin/grants", bearer, {
            agent: "a",
            connection: { kind: "vault", target: "Bad Vault" },
          }),
        )
      ).status,
    ).toBe(400);
  });

  test("400 on a reserved vault name (no phantom pending row)", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "a",
        connection: { kind: "vault", target: "admin" },
      }),
    );
    expect(res.status).toBe(400);
    expect(readGrants(harness.storePath)).toHaveLength(0);
  });

  test("400 on an over-long agent / tags array", async () => {
    const bearer = await moduleBearer();
    expect(
      (
        await dispatch(
          bearerReq("PUT", "/admin/grants", bearer, {
            agent: "x".repeat(200),
            connection: { kind: "vault", target: "research" },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await dispatch(
          bearerReq("PUT", "/admin/grants", bearer, {
            agent: "a",
            connection: {
              kind: "vault",
              target: "research",
              tags: Array.from({ length: 100 }, (_, i) => `#t${i}`),
            },
          }),
        )
      ).status,
    ).toBe(400);
  });
});

// === GET /admin/grants ======================================================

describe("GET /admin/grants (list — NO secrets)", () => {
  test("lists grants, never includes material even for approved grants", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    // pending service grant
    await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "a",
        connection: { kind: "service", target: "github" },
      }),
    );
    // approved vault grant (material stored on disk)
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    await dispatch(cookieReq("POST", `/admin/grants/${created.id}/approve`, cookie));

    const res = await dispatch(bearerReq("GET", "/admin/grants?agent=a", bearer));
    expect(res.status).toBe(200);
    const body = await json(res);
    const grants = body.grants as Record<string, unknown>[];
    expect(grants).toHaveLength(2);
    for (const g of grants) expect(g).not.toHaveProperty("material");
    // the raw JSON text must not leak the minted token
    const raw = JSON.stringify(body);
    const stored = readGrants(harness.storePath).find((r) => r.connection.kind === "vault");
    expect(stored?.material).toBeDefined();
    expect(raw).not.toContain((stored?.material as { token: string }).token);
  });

  test("?agent filter narrows to one agent", async () => {
    const bearer = await moduleBearer();
    await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "a",
        connection: { kind: "vault", target: "research" },
      }),
    );
    await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "b",
        connection: { kind: "service", target: "github" },
      }),
    );
    const a = await json(await dispatch(bearerReq("GET", "/admin/grants?agent=a", bearer)));
    expect((a.grants as unknown[]).length).toBe(1);
    const all = await json(await dispatch(bearerReq("GET", "/admin/grants", bearer)));
    expect((all.grants as unknown[]).length).toBe(2);
  });

  test("401 without a Bearer", async () => {
    const res = await dispatch(new Request(`${HUB_ORIGIN}/admin/grants`, { method: "GET" }));
    expect(res.status).toBe(401);
  });
});

// === POST /admin/grants/<id>/approve =======================================

describe("POST /admin/grants/<id>/approve", () => {
  test("vault: MINTS a registered vault:<target>:<access> token with scoped_tags", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research", access: "read", tags: ["#published"] },
        }),
      ),
    );
    const id = created.id as string;
    const res = await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("approved");
    expect(body).not.toHaveProperty("material");
    expect(body.approvedAt).toBeDefined();

    // material on disk: decode the minted token
    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    const mat = stored?.material as { kind: string; token: string; jti: string };
    expect(mat.kind).toBe("vault");
    const claims = decodeJwt(mat.token) as Record<string, unknown>;
    expect(claims.scope).toBe("vault:research:read");
    expect(claims.aud).toBe("vault.research");
    expect((claims.permissions as { scoped_tags: string[] }).scoped_tags).toEqual(["#published"]);
    // registered → revocable
    expect(findTokenRowByJti(harness.db, mat.jti)).not.toBeNull();
  });

  test("vault: re-approval revokes the prior minted token (no orphaned live token)", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const firstJti = (
      readGrants(harness.storePath).find((r) => r.id === id)?.material as { jti: string }
    ).jti;

    // approve again — should revoke the first token and mint a fresh one
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const secondJti = (
      readGrants(harness.storePath).find((r) => r.id === id)?.material as { jti: string }
    ).jti;

    expect(secondJti).not.toBe(firstJti);
    expect(findTokenRowByJti(harness.db, firstJti)?.revokedAt).toBeTruthy();
    expect(findTokenRowByJti(harness.db, secondJti)?.revokedAt).toBeFalsy();
  });

  test("vault: a revoked grant can be re-approved (re-mints fresh material)", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    await dispatch(cookieReq("POST", `/admin/grants/${id}/revoke`, cookie));
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("revoked");

    const res = await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    expect(res.status).toBe(200);
    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect(stored?.status).toBe("approved");
    expect((stored?.material as { kind: string }).kind).toBe("vault");
  });

  test("service: stores the operator-pasted token", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "service", target: "github", inject: ["env"] },
        }),
      ),
    );
    const id = created.id as string;
    const res = await dispatch(
      cookieReq("POST", `/admin/grants/${id}/approve`, cookie, { token: "ghp_secret123" }),
    );
    expect(res.status).toBe(200);
    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect((stored?.material as { kind: string; token: string }).token).toBe("ghp_secret123");
  });

  test("service: 400 when no token is pasted", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "service", target: "github" },
        }),
      ),
    );
    const res = await dispatch(cookieReq("POST", `/admin/grants/${created.id}/approve`, cookie));
    expect(res.status).toBe(400);
  });

  test("mcp: 409 not_grantable (stays pending)", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "mcp", target: "https://remote.test/mcp" },
        }),
      ),
    );
    const res = await dispatch(cookieReq("POST", `/admin/grants/${created.id}/approve`, cookie));
    expect(res.status).toBe(409);
    expect(readGrants(harness.storePath).find((r) => r.id === created.id)?.status).toBe("pending");
  });

  test("vault: 400 when the vault no longer exists", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    installedVaults.delete("research");
    const res = await dispatch(cookieReq("POST", `/admin/grants/${created.id}/approve`, cookie));
    expect(res.status).toBe(400);
  });

  test("401 without a session cookie", async () => {
    const bearer = await moduleBearer();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    const res = await dispatch(
      new Request(`${HUB_ORIGIN}/admin/grants/${created.id}/approve`, {
        method: "POST",
        headers: { origin: HUB_ORIGIN },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("403 for a non-first-admin (friend) session", async () => {
    const bearer = await moduleBearer();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    const cookie = await friendCookie();
    const res = await dispatch(cookieReq("POST", `/admin/grants/${created.id}/approve`, cookie));
    expect(res.status).toBe(403);
  });

  test("404 for an unknown grant id", async () => {
    const cookie = await operatorCookie();
    const res = await dispatch(cookieReq("POST", "/admin/grants/does-not-exist/approve", cookie));
    expect(res.status).toBe(404);
  });
});

// === GET /admin/grants/<id>/material =======================================

describe("GET /admin/grants/<id>/material", () => {
  test("vault: returns token + mcpUrl for an approved grant", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));

    const res = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.kind).toBe("vault");
    expect(typeof body.token).toBe("string");
    expect(body.mcpUrl).toBe("https://hub.test/vault/research/mcp");
  });

  test("service: returns token + inject for an approved grant", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "service", target: "github", inject: ["env", "mcp"] },
        }),
      ),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie, { token: "ghp_x" }));

    const res = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.kind).toBe("service");
    expect(body.token).toBe("ghp_x");
    expect(body.inject).toEqual(["env", "mcp"]);
  });

  test("409 when the grant is still pending (not approved)", async () => {
    const bearer = await moduleBearer();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    const res = await dispatch(bearerReq("GET", `/admin/grants/${created.id}/material`, bearer));
    expect(res.status).toBe(409);
  });

  test("404 for an unknown grant id", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(bearerReq("GET", "/admin/grants/nope/material", bearer));
    expect(res.status).toBe(404);
  });

  test("401 without a Bearer (material is module-auth gated)", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    await dispatch(cookieReq("POST", `/admin/grants/${created.id}/approve`, cookie));
    const res = await dispatch(
      new Request(`${HUB_ORIGIN}/admin/grants/${created.id}/material`, { method: "GET" }),
    );
    expect(res.status).toBe(401);
  });
});

// === POST /admin/grants/<id>/revoke ========================================

describe("POST /admin/grants/<id>/revoke", () => {
  test("drops the stored material, revokes the minted token, sets status=revoked", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const jti = (
      readGrants(harness.storePath).find((r) => r.id === id)?.material as { jti: string }
    ).jti;

    const res = await dispatch(cookieReq("POST", `/admin/grants/${id}/revoke`, cookie));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("revoked");

    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect(stored?.material).toBeUndefined();
    // the minted token is now revoked in the registry
    const row = findTokenRowByJti(harness.db, jti);
    expect(row?.revokedAt).toBeTruthy();

    // /material now 409s
    const mat = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(mat.status).toBe(409);
  });

  test("403 for a non-first-admin session", async () => {
    const bearer = await moduleBearer();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    const cookie = await friendCookie();
    const res = await dispatch(cookieReq("POST", `/admin/grants/${created.id}/revoke`, cookie));
    expect(res.status).toBe(403);
  });

  test("404 for an unknown grant id", async () => {
    const cookie = await operatorCookie();
    const res = await dispatch(cookieReq("POST", "/admin/grants/nope/revoke", cookie));
    expect(res.status).toBe(404);
  });
});

// === method/routing guards ==================================================

describe("routing", () => {
  test("405 on unsupported collection method", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(bearerReq("DELETE", "/admin/grants", bearer));
    expect(res.status).toBe(405);
  });

  test("405 on GET /approve (operator routes are POST-only)", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          connection: { kind: "vault", target: "research" },
        }),
      ),
    );
    const res = await dispatch(cookieReq("GET", `/admin/grants/${created.id}/approve`, cookie));
    expect(res.status).toBe(405);
  });

  test("404 on an unknown item verb", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(bearerReq("GET", "/admin/grants/x/bogus", bearer));
    expect(res.status).toBe(404);
  });
});
