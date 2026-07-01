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
import {
  type AgentGrantsDeps,
  handleAgentGrants,
  handleOAuthGrantCallback,
} from "../admin-agent-grants.ts";
import { getGrant, readGrants } from "../grants-store.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { findTokenRowByJti } from "../jwt-sign.ts";
import { signAccessToken } from "../jwt-sign.ts";
import type { OAuthClient } from "../oauth-client.ts";
import { getFlowByState } from "../oauth-flows-store.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const HUB_ORIGIN = "https://hub.test";
const VAULT_ORIGIN = "http://127.0.0.1:1940";

interface Harness {
  db: Database;
  storePath: string;
  flowsStorePath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-agent-grants-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  return {
    db,
    storePath: join(dir, "agent-grants.json"),
    flowsStorePath: join(dir, "agent-oauth-flows.json"),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A fake OAuth client. Deterministic verifier/challenge/state so tests can assert
 * the persisted flow; the network methods return canned values or call recorded
 * spies. No real network ever happens.
 */
function fakeOAuth(over: Partial<OAuthClient> = {}): OAuthClient & {
  calls: { refresh: number; revoke: number; register: number; exchange: number };
} {
  const calls = { refresh: 0, revoke: 0, register: 0, exchange: 0 };
  const base: OAuthClient = {
    generateCodeVerifier: () => "fixed-verifier",
    generateCodeChallenge: (v) => `chal(${v})`,
    generateState: () => "fixed-state",
    discover: async () => ({
      issuer: "https://issuer.test",
      authorizationEndpoint: "https://issuer.test/oauth/authorize",
      tokenEndpoint: "https://issuer.test/oauth/token",
      registrationEndpoint: "https://issuer.test/oauth/register",
      revocationEndpoint: "https://issuer.test/oauth/revoke",
      scopesSupported: ["vault:eng:read", "vault:eng:write"],
    }),
    registerClient: async () => {
      calls.register++;
      return { clientId: "dcr-client-1" };
    },
    buildAuthorizeUrl: (o) =>
      `${o.authorizationEndpoint}?client_id=${o.clientId}&state=${o.state}&code_challenge=${o.codeChallenge}&code_challenge_method=S256${o.scope ? `&scope=${encodeURIComponent(o.scope)}` : ""}`,
    exchangeCode: async () => {
      calls.exchange++;
      return {
        access_token: "at-fresh",
        refresh_token: "rt-fresh",
        expiresAt: "2026-06-18T13:00:00.000Z",
      };
    },
    refreshToken: async () => {
      calls.refresh++;
      return {
        access_token: "at-refreshed",
        refresh_token: "rt-refreshed",
        expiresAt: "2026-06-18T14:00:00.000Z",
      };
    },
    revokeRemote: async () => {
      calls.revoke++;
    },
  };
  return Object.assign({ calls }, base, over);
}

let currentOAuth: OAuthClient | undefined;
beforeEach(() => {
  currentOAuth = undefined;
});

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

function deps(over: Partial<AgentGrantsDeps> = {}): AgentGrantsDeps {
  return {
    db: harness.db,
    hubOrigin: HUB_ORIGIN,
    storePath: harness.storePath,
    flowsStorePath: harness.flowsStorePath,
    resolveVaultOrigin: (name) => (installedVaults.has(name) ? VAULT_ORIGIN : null),
    ...(currentOAuth ? { oauthClient: currentOAuth } : {}),
    ...over,
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

  test("an mcp grant lands pending awaiting oauth consent (4b-2)", async () => {
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
    expect(body.reason).toBe("awaiting oauth consent");
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

  test("service approve rejects an over-long pasted token (400)", async () => {
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
      cookieReq("POST", `/admin/grants/${id}/approve`, cookie, { token: "x".repeat(9000) }),
    );
    expect(res.status).toBe(400);
    // not stored — the grant stays pending, no oversized material on disk.
    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect(stored?.status).toBe("pending");
    expect(stored?.material).toBeUndefined();
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

// === POST /admin/grants/reconcile (grant-GC, #96) ===========================

describe("POST /admin/grants/reconcile", () => {
  /** Create a grant via PUT; return its id + the connection spec (sent back as a liveConnection). */
  async function makeGrant(
    bearer: string,
    agent: string,
    connection: Record<string, unknown>,
  ): Promise<{ id: string; connection: Record<string, unknown> }> {
    const created = await json(
      await dispatch(bearerReq("PUT", "/admin/grants", bearer, { agent, connection })),
    );
    return { id: created.id as string, connection };
  }

  test("prunes grants whose spec is NOT in liveConnections; keeps those that are", async () => {
    const bearer = await moduleBearer();
    const keep = await makeGrant(bearer, "a", {
      kind: "vault",
      target: "research",
      access: "read",
    });
    const drop = await makeGrant(bearer, "a", { kind: "service", target: "github" });

    const res = await dispatch(
      bearerReq("POST", "/admin/grants/reconcile", bearer, {
        agent: "a",
        liveConnections: [keep.connection], // drop's spec is absent → it is pruned
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.pruned).toBe(1);
    expect(body.prunedIds).toEqual([drop.id]);

    // the kept grant survives; the dropped one is gone (row removed, not revoked)
    expect(getGrant(harness.storePath, keep.id)?.status).toBe("pending");
    expect(getGrant(harness.storePath, drop.id)).toBeNull();
  });

  test("REGRESSION: a still-wanted service / tagged-vault grant is NOT pruned (spec-based, no cross-repo key drift)", async () => {
    // The hub derives keys from the live SPECS with its own connectionKey — so a
    // service grant (hub key `service:github`) sent back as its spec matches and
    // survives. (Under the old "agent sends pre-computed keys" contract, the agent
    // would send `env:github`, the hub key `service:github` wouldn't match, and this
    // still-wanted grant would be WRONGLY pruned. Caught by live verification.)
    const bearer = await moduleBearer();
    const svc = await makeGrant(bearer, "a", {
      kind: "service",
      target: "github",
      inject: ["env"],
    });
    const tagged = await makeGrant(bearer, "a", {
      kind: "vault",
      target: "research",
      access: "read",
      tags: ["#published", "#wip"],
    });

    const res = await dispatch(
      bearerReq("POST", "/admin/grants/reconcile", bearer, {
        agent: "a",
        liveConnections: [svc.connection, tagged.connection],
      }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).pruned).toBe(0);
    expect(getGrant(harness.storePath, svc.id)).not.toBeNull();
    expect(getGrant(harness.storePath, tagged.id)).not.toBeNull();
  });

  test("a pruned APPROVED vault grant has its registry token revoked", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const g = await makeGrant(bearer, "a", { kind: "vault", target: "research", access: "read" });
    await dispatch(cookieReq("POST", `/admin/grants/${g.id}/approve`, cookie));
    const jti = (getGrant(harness.storePath, g.id)?.material as { jti: string }).jti;
    expect(findTokenRowByJti(harness.db, jti)?.revokedAt).toBeFalsy();

    // reconcile with NO live connections for this agent → prune everything
    const res = await dispatch(
      bearerReq("POST", "/admin/grants/reconcile", bearer, { agent: "a", liveConnections: [] }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).pruned).toBe(1);

    // the row is removed AND the minted token is revoked in the registry
    expect(getGrant(harness.storePath, g.id)).toBeNull();
    expect(findTokenRowByJti(harness.db, jti)?.revokedAt).toBeTruthy();
  });

  test("liveConnections=[] prunes ALL of the agent's grants", async () => {
    const bearer = await moduleBearer();
    await makeGrant(bearer, "a", { kind: "vault", target: "research", access: "read" });
    await makeGrant(bearer, "a", { kind: "service", target: "github" });

    const res = await dispatch(
      bearerReq("POST", "/admin/grants/reconcile", bearer, { agent: "a", liveConnections: [] }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).pruned).toBe(2);
    expect(readGrants(harness.storePath).filter((r) => r.agent === "a")).toHaveLength(0);
  });

  test("leaves OTHER agents' grants untouched", async () => {
    const bearer = await moduleBearer();
    const mine = await makeGrant(bearer, "a", { kind: "service", target: "github" });
    const theirs = await makeGrant(bearer, "b", { kind: "service", target: "github" });

    const res = await dispatch(
      bearerReq("POST", "/admin/grants/reconcile", bearer, { agent: "a", liveConnections: [] }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).pruned).toBe(1);
    expect(getGrant(harness.storePath, mine.id)).toBeNull();
    // agent b's grant is untouched even though it has the SAME connectionKey
    expect(getGrant(harness.storePath, theirs.id)?.agent).toBe("b");
  });

  test("returns the right count/ids (empty when nothing is pruned)", async () => {
    const bearer = await moduleBearer();
    const g = await makeGrant(bearer, "a", { kind: "service", target: "github" });

    const res = await dispatch(
      bearerReq("POST", "/admin/grants/reconcile", bearer, {
        agent: "a",
        liveConnections: [g.connection], // the only grant is still live → nothing pruned
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.pruned).toBe(0);
    expect(body.prunedIds).toEqual([]);
    expect(getGrant(harness.storePath, g.id)).not.toBeNull();
  });

  test("401 without the module Bearer (auth-gated)", async () => {
    const bearer = await moduleBearer();
    await makeGrant(bearer, "a", { kind: "service", target: "github" });

    // No Authorization header at all.
    const req = new Request(`${HUB_ORIGIN}/admin/grants/reconcile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "a", liveConnections: [] }),
    });
    const res = await handleAgentGrants(req, "/reconcile", deps());
    expect(res.status).toBe(401);
    // nothing was pruned
    expect(readGrants(harness.storePath).filter((r) => r.agent === "a")).toHaveLength(1);
  });

  test("a cookie-only request (no Bearer) is rejected — module-auth only", async () => {
    const bearer = await moduleBearer();
    await makeGrant(bearer, "a", { kind: "service", target: "github" });
    const cookie = await operatorCookie();
    // An operator cookie is NOT module-auth — reconcile is host-admin-Bearer only.
    const res = await dispatch(
      cookieReq("POST", "/admin/grants/reconcile", cookie, { agent: "a", liveConnections: [] }),
    );
    expect(res.status).toBe(401);
    expect(readGrants(harness.storePath).filter((r) => r.agent === "a")).toHaveLength(1);
  });

  test("405 on a non-POST method", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(bearerReq("GET", "/admin/grants/reconcile", bearer));
    expect(res.status).toBe(405);
  });

  test("400 on a missing/invalid agent or liveConnections", async () => {
    const bearer = await moduleBearer();
    // missing agent
    expect(
      (
        await dispatch(
          bearerReq("POST", "/admin/grants/reconcile", bearer, { liveConnections: [] }),
        )
      ).status,
    ).toBe(400);
    // liveConnections not an array
    expect(
      (
        await dispatch(
          bearerReq("POST", "/admin/grants/reconcile", bearer, {
            agent: "a",
            liveConnections: "x",
          }),
        )
      ).status,
    ).toBe(400);
    // an invalid liveConnections entry (not a valid connection spec)
    expect(
      (
        await dispatch(
          bearerReq("POST", "/admin/grants/reconcile", bearer, {
            agent: "a",
            liveConnections: [{ kind: "bogus" }],
          }),
        )
      ).status,
    ).toBe(400);
    // a bad agent charset
    expect(
      (
        await dispatch(
          bearerReq("POST", "/admin/grants/reconcile", bearer, {
            agent: "bad name",
            liveConnections: [],
          }),
        )
      ).status,
    ).toBe(400);
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

// === 4b-2: mcp grants (OAuth client + static bearer) ========================

describe("approve(mcp) — static bearer", () => {
  test("a pasted token → approved + mcp material (no discovery, no flow)", async () => {
    currentOAuth = fakeOAuth();
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
    const id = created.id as string;
    const res = await dispatch(
      cookieReq("POST", `/admin/grants/${id}/approve`, cookie, { token: "static-paste-123" }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("approved");
    expect(body).not.toHaveProperty("material");
    expect(body).not.toHaveProperty("authorizeUrl");

    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    const mat = stored?.material as { kind: string; access_token: string; mcpUrl: string };
    expect(mat.kind).toBe("mcp");
    expect(mat.access_token).toBe("static-paste-123");
    expect(mat.mcpUrl).toBe("https://remote.test/mcp");
    // no OAuth machinery ran, no pending flow persisted
    expect(getFlowByState(harness.flowsStorePath, "fixed-state")).toBeNull();
  });

  test("a static-bearer /material returns { kind:mcp, token, mcpUrl }", async () => {
    currentOAuth = fakeOAuth();
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
    const id = created.id as string;
    await dispatch(
      cookieReq("POST", `/admin/grants/${id}/approve`, cookie, { token: "static-paste-123" }),
    );
    const res = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.kind).toBe("mcp");
    expect(body.token).toBe("static-paste-123");
    expect(body.mcpUrl).toBe("https://remote.test/mcp");
    // no refresh occurred for a static bearer
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.refresh).toBe(0);
  });

  test("rejects an over-long pasted token (400)", async () => {
    currentOAuth = fakeOAuth();
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
    const res = await dispatch(
      cookieReq("POST", `/admin/grants/${created.id}/approve`, cookie, { token: "x".repeat(9000) }),
    );
    expect(res.status).toBe(400);
    expect(readGrants(harness.storePath).find((r) => r.id === created.id)?.status).toBe("pending");
  });
});

describe("approve(mcp) — start OAuth flow", () => {
  test("no token → discover + DCR + persist flow + return authorizeUrl (stays pending)", async () => {
    currentOAuth = fakeOAuth();
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
    const id = created.id as string;
    const res = await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe("pending");
    expect(body.reason).toBe("awaiting oauth consent");
    expect(typeof body.authorizeUrl).toBe("string");
    expect(body.authorizeUrl as string).toContain("code_challenge_method=S256");
    expect(body.authorizeUrl as string).toContain("state=fixed-state");
    // grant is still pending (no material yet)
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("pending");

    // a pending flow was persisted, bound to (state, grantId)
    const flow = getFlowByState(harness.flowsStorePath, "fixed-state");
    expect(flow?.grantId).toBe(id);
    expect(flow?.clientId).toBe("dcr-client-1");
    expect(flow?.verifier).toBe("fixed-verifier");
    expect(flow?.scope).toBe("vault:eng:read vault:eng:write");
    expect(flow?.redirectUri).toBe("https://hub.test/oauth/agent-grant/callback");
    // DCR happened once
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.register).toBe(1);
  });

  test("502 when discovery fails (grant stays pending, no flow)", async () => {
    currentOAuth = fakeOAuth({
      discover: async () => {
        throw new Error("no metadata");
      },
    });
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
    expect(res.status).toBe(502);
    expect(getFlowByState(harness.flowsStorePath, "fixed-state")).toBeNull();
  });

  // #671: least-privilege scope for a Parachute-vault MCP target. The fake
  // discovery advertises the broad set (vault:eng:read + vault:eng:write); for a
  // vault-shaped URL the flow must request ONLY vault:<name>:read instead.
  test("#671 vault-shaped MCP target → requests least-privilege vault:<name>:read", async () => {
    currentOAuth = fakeOAuth();
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "a",
          // A Parachute vault MCP URL at this hub's origin.
          connection: { kind: "mcp", target: "https://hub.test/vault/research/mcp" },
        }),
      ),
    );
    const id = created.id as string;
    const res = await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    expect(res.status).toBe(200);
    // The persisted flow's scope is the single least-privilege read scope, NOT
    // the resource's full advertised set.
    const flow = getFlowByState(harness.flowsStorePath, "fixed-state");
    expect(flow?.scope).toBe("vault:research:read");
    // And the authorize URL carries that scope, not the broad one.
    const body = await json(res);
    expect(body.authorizeUrl as string).toContain(encodeURIComponent("vault:research:read"));
    expect(body.authorizeUrl as string).not.toContain("vault%3Aeng%3Awrite");
  });

  // #671: the complement — a non-vault MCP target keeps the old behavior
  // (request the resource's advertised scopes_supported).
  test("#671 non-vault MCP target → falls back to the advertised scopes_supported", async () => {
    currentOAuth = fakeOAuth();
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
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const flow = getFlowByState(harness.flowsStorePath, "fixed-state");
    expect(flow?.scope).toBe("vault:eng:read vault:eng:write");
  });
});

// callback dispatch helper (the route is a browser GET, no auth)
async function callback(query: string): Promise<Response> {
  const req = new Request(`${HUB_ORIGIN}/oauth/agent-grant/callback${query}`, { method: "GET" });
  return handleOAuthGrantCallback(req, deps());
}

describe("GET /oauth/agent-grant/callback", () => {
  async function startFlow(): Promise<string> {
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
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    return id;
  }

  test("happy path → exchange + store material + status approved", async () => {
    currentOAuth = fakeOAuth();
    const id = await startFlow();

    const res = await callback("?code=auth-code-1&state=fixed-state");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Connected");
    // NEVER a token in the HTML
    expect(html).not.toContain("at-fresh");
    expect(html).not.toContain("rt-fresh");

    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect(stored?.status).toBe("approved");
    const mat = stored?.material as { kind: string; access_token: string; refresh_token: string };
    expect(mat.kind).toBe("mcp");
    expect(mat.access_token).toBe("at-fresh");
    expect(mat.refresh_token).toBe("rt-fresh");
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.exchange).toBe(1);

    // the flow was consumed (single-use)
    expect(getFlowByState(harness.flowsStorePath, "fixed-state")).toBeNull();
  });

  test("unknown / replayed state → error HTML, no material", async () => {
    currentOAuth = fakeOAuth();
    const id = await startFlow();
    // first use consumes the flow
    await callback("?code=auth-code-1&state=fixed-state");
    // replay
    const res = await callback("?code=auth-code-1&state=fixed-state");
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Connection failed");
    // exchange ran only once (the replay never reached it)
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.exchange).toBe(1);
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("approved");
  });

  test("a totally unknown state → 400, no exchange", async () => {
    currentOAuth = fakeOAuth();
    const res = await callback("?code=x&state=never-minted");
    expect(res.status).toBe(400);
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.exchange).toBe(0);
  });

  test("operator Deny (?error=access_denied) → grant stays pending with reason 'operator declined'", async () => {
    currentOAuth = fakeOAuth();
    const id = await startFlow();
    const res = await callback("?error=access_denied&state=fixed-state");
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("not authorized");
    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect(stored?.status).toBe("pending");
    // admin can now distinguish "not yet tried" from "tried + denied"
    expect(stored?.reason).toBe("operator declined");
    // flow consumed even on deny
    expect(getFlowByState(harness.flowsStorePath, "fixed-state")).toBeNull();
  });

  test("token exchange failure → error HTML, grant stays pending", async () => {
    currentOAuth = fakeOAuth({
      exchangeCode: async () => {
        throw new Error("invalid_grant");
      },
    });
    const id = await startFlow();
    const res = await callback("?code=bad&state=fixed-state");
    expect(res.status).toBe(502);
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("pending");
  });

  test("re-consent replaces material + best-effort revokes the old refresh", async () => {
    currentOAuth = fakeOAuth();
    const id = await startFlow();
    // complete the first consent → approved with rt-fresh + revocationEndpoint
    await callback("?code=c1&state=fixed-state");
    const cookie = await operatorCookie();
    // re-approve (already approved) → starts a fresh flow (reuses clientId, same issuer)
    const reApprove = await json(
      await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie)),
    );
    expect(reApprove.status).toBe("pending");
    expect(typeof reApprove.authorizeUrl).toBe("string");
    // DCR was NOT called again (clientId reused for the same issuer)
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.register).toBe(1);

    // complete the second consent → revokes the prior refresh
    const res = await callback("?code=c2&state=fixed-state");
    expect(res.status).toBe(200);
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.revoke).toBe(1);
  });
});

// === returnTo: send the operator back to where they started ================
//
// The OAuth-consent round-trip used to dead-end on a "close this tab" page. A
// same-origin (hub-relative) `returnTo` on the approve body is stashed on the
// flow + 302'd to on success (with `?mcp_connected=1`). The open-redirect guard
// (`isSafeHubReturnTo`, reused) is the load-bearing property: an off-origin /
// scheme-relative value is dropped at stash time and never lands in Location.
describe("approve(mcp) + callback — returnTo round-trip", () => {
  async function startFlowWithBody(body: Record<string, unknown>): Promise<string> {
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
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie, body));
    return id;
  }

  test("approve stashes a valid same-origin returnTo on the flow", async () => {
    currentOAuth = fakeOAuth();
    await startFlowWithBody({ returnTo: "/admin/grants" });
    const flow = getFlowByState(harness.flowsStorePath, "fixed-state");
    expect(flow?.returnTo).toBe("/admin/grants");
  });

  test("approve drops an off-origin returnTo (absolute URL) — open-redirect guard", async () => {
    currentOAuth = fakeOAuth();
    await startFlowWithBody({ returnTo: "https://evil.example/steal" });
    const flow = getFlowByState(harness.flowsStorePath, "fixed-state");
    expect(flow?.returnTo).toBeUndefined();
  });

  test("approve drops a scheme-relative returnTo (//host) — open-redirect guard", async () => {
    currentOAuth = fakeOAuth();
    await startFlowWithBody({ returnTo: "//evil.example/steal" });
    const flow = getFlowByState(harness.flowsStorePath, "fixed-state");
    expect(flow?.returnTo).toBeUndefined();
  });

  test("approve drops a `..` path-traversal returnTo — open-redirect guard", async () => {
    currentOAuth = fakeOAuth();
    await startFlowWithBody({ returnTo: "/admin/../../etc/passwd" });
    const flow = getFlowByState(harness.flowsStorePath, "fixed-state");
    expect(flow?.returnTo).toBeUndefined();
  });

  test("approve drops a PERCENT-ENCODED `..` returnTo (%2e%2e) — open-redirect guard", async () => {
    // `new URL()` decodes %2e%2e before emitting the redirect path, so the guard
    // must reject the encoded form too, not just the literal `..`.
    currentOAuth = fakeOAuth();
    await startFlowWithBody({ returnTo: "/%2e%2e/etc/passwd" });
    const flow = getFlowByState(harness.flowsStorePath, "fixed-state");
    expect(flow?.returnTo).toBeUndefined();
  });

  test("callback 302-redirects to a valid returnTo (with mcp_connected=1) on success", async () => {
    currentOAuth = fakeOAuth();
    const id = await startFlowWithBody({ returnTo: "/admin/grants?agent=a" });
    const res = await callback("?code=ok&state=fixed-state");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/admin/grants");
    expect(location).toContain("agent=a");
    expect(location).toContain("mcp_connected=1");
    // Same-origin only — never a host/scheme in Location.
    expect(location.startsWith("/")).toBe(true);
    expect(location.startsWith("//")).toBe(false);
    // The grant still flipped to approved (the success side-effects all ran).
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("approved");
  });

  test("callback overwrites a pre-existing mcp_connected param rather than duplicating it", async () => {
    currentOAuth = fakeOAuth();
    await startFlowWithBody({ returnTo: "/admin/grants?mcp_connected=0" });
    const res = await callback("?code=ok&state=fixed-state");
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("mcp_connected=1");
    expect(location).not.toContain("mcp_connected=0");
    // exactly one occurrence (searchParams.set semantics, not append)
    expect(location.match(/mcp_connected=/g)?.length).toBe(1);
  });

  test("callback falls back to the close-tab HTML when no returnTo was stashed", async () => {
    currentOAuth = fakeOAuth();
    const id = await startFlowWithBody({}); // no returnTo
    const res = await callback("?code=ok&state=fixed-state");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Connected");
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("approved");
  });

  test("callback falls back to the close-tab HTML for an unsafe returnTo (never 302s off-origin)", async () => {
    currentOAuth = fakeOAuth();
    // The unsafe value was already dropped at stash time, so the callback has no
    // returnTo to honor — it renders the back-compat page rather than redirecting.
    const id = await startFlowWithBody({ returnTo: "https://evil.example/steal" });
    const res = await callback("?code=ok&state=fixed-state");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain("Connected");
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("approved");
  });
});

describe("material(mcp) — auto-refresh", () => {
  // Drive a grant to approved-via-OAuth, with expiry in the (near) past/future.
  async function approvedViaOAuth(expiresAt: string): Promise<string> {
    currentOAuth = fakeOAuth({
      exchangeCode: async () => ({
        access_token: "at-initial",
        refresh_token: "rt-initial",
        expiresAt,
      }),
    });
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
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const req = new Request(`${HUB_ORIGIN}/oauth/agent-grant/callback?code=c&state=fixed-state`, {
      method: "GET",
    });
    await handleOAuthGrantCallback(req, deps());
    return id;
  }

  test("fresh token (far from expiry) → returned without a refresh", async () => {
    const far = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const id = await approvedViaOAuth(far);
    (currentOAuth as ReturnType<typeof fakeOAuth>).calls.refresh = 0;
    const bearer = await moduleBearer();
    const res = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(res.status).toBe(200);
    expect((await json(res)).token).toBe("at-initial");
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.refresh).toBe(0);
  });

  test("near-expiry token → refresh first, return the new token, persist it", async () => {
    // expiry within the 120s skew window
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    const id = await approvedViaOAuth(soon);
    const before = (currentOAuth as ReturnType<typeof fakeOAuth>).calls.refresh;
    const bearer = await moduleBearer();
    const res = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(res.status).toBe(200);
    expect((await json(res)).token).toBe("at-refreshed");
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.refresh).toBe(before + 1);
    // new access + rotated refresh persisted
    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    const mat = stored?.material as { access_token: string; refresh_token: string };
    expect(mat.access_token).toBe("at-refreshed");
    expect(mat.refresh_token).toBe("rt-refreshed");
  });

  test("refresh failure → status needs_consent + 409, material dropped", async () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    // approve via OAuth, THEN swap in a client whose refresh fails
    const id = await approvedViaOAuth(soon);
    currentOAuth = fakeOAuth({
      refreshToken: async () => {
        throw new Error("invalid_grant");
      },
    });
    const bearer = await moduleBearer();
    const res = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(res.status).toBe(409);
    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect(stored?.status).toBe("needs_consent");
    expect(stored?.material).toBeUndefined();
    expect(stored?.reason).toContain("refresh failed");
  });

  test("a needs_consent grant's /material 409 reason carries useful text", async () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    const id = await approvedViaOAuth(soon);
    currentOAuth = fakeOAuth({
      refreshToken: async () => {
        throw new Error("invalid_grant");
      },
    });
    const bearer = await moduleBearer();
    // first call drives it to needs_consent
    await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    // second call: 409 whose reason text tells the operator to re-consent
    const res = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toBe("not_approved");
    const desc = body.error_description as string;
    expect(desc).toContain("needs_consent");
    expect(desc).toMatch(/re-consent|reconnect|approve/i);
  });

  test("needs_consent → re-approve → callback revives to approved with fresh material", async () => {
    // Drive a grant to needs_consent (approved-via-OAuth, then a failed refresh).
    const soon = new Date(Date.now() + 60 * 1000).toISOString();
    const id = await approvedViaOAuth(soon);
    currentOAuth = fakeOAuth({
      refreshToken: async () => {
        throw new Error("invalid_grant");
      },
    });
    const bearer = await moduleBearer();
    await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("needs_consent");

    // Re-approve (no token) on a needs_consent grant → starts a FRESH OAuth flow.
    currentOAuth = fakeOAuth();
    const cookie = await operatorCookie();
    const reApprove = await json(
      await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie)),
    );
    expect(reApprove.status).toBe("pending");
    expect(typeof reApprove.authorizeUrl).toBe("string");
    // a fresh flow was persisted, bound to this grant
    const flow = getFlowByState(harness.flowsStorePath, "fixed-state");
    expect(flow?.grantId).toBe(id);

    // Complete the consent → revived to approved with fresh material.
    const res = await callback("?code=revive&state=fixed-state");
    expect(res.status).toBe(200);
    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect(stored?.status).toBe("approved");
    const mat = stored?.material as { kind: string; access_token: string };
    expect(mat.kind).toBe("mcp");
    expect(mat.access_token).toBe("at-fresh");
    // /material now serves a live token (the fake's hardcoded expiry is past, so
    // the lazy refresh kicks in and returns the refreshed token — proving the
    // revived grant is fully functional, no longer 409ing).
    const matRes = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(matRes.status).toBe(200);
    expect((await json(matRes)).token).toBe("at-refreshed");
  });
});

describe("revoke(mcp)", () => {
  test("best-effort revokes the remote refresh + drops material", async () => {
    currentOAuth = fakeOAuth();
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
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    await callback("?code=c&state=fixed-state"); // → approved with rt-fresh + revocationEndpoint

    const before = (currentOAuth as ReturnType<typeof fakeOAuth>).calls.revoke;
    const res = await dispatch(cookieReq("POST", `/admin/grants/${id}/revoke`, cookie));
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe("revoked");
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.revoke).toBe(before + 1);

    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect(stored?.material).toBeUndefined();
    // /material now 409s
    const mat = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(mat.status).toBe(409);
  });

  test("a static-bearer revoke drops material without a remote revoke call", async () => {
    currentOAuth = fakeOAuth();
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
    const id = created.id as string;
    await dispatch(
      cookieReq("POST", `/admin/grants/${id}/approve`, cookie, { token: "static-paste" }),
    );
    const before = (currentOAuth as ReturnType<typeof fakeOAuth>).calls.revoke;
    const res = await dispatch(cookieReq("POST", `/admin/grants/${id}/revoke`, cookie));
    expect(res.status).toBe(200);
    // no remote revoke for a static bearer (no refresh/revocation endpoint)
    expect((currentOAuth as ReturnType<typeof fakeOAuth>).calls.revoke).toBe(before);
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.material).toBeUndefined();
  });
});

// === surface grants (Surface Git Transport Phase 2, §6a) ===================

describe("surface grants (Phase 2)", () => {
  test("PUT: creates a pending surface grant (201) — no material, no self-grant", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "surfacer",
        connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    // A note can only REQUEST — it lands pending with NO material until the
    // operator approves. This IS the "a note can never GRANT" invariant.
    expect(body.status).toBe("pending");
    expect(body).not.toHaveProperty("material");
    expect((body.connection as Record<string, unknown>).kind).toBe("surface");
    expect((body.connection as Record<string, unknown>).access).toBe("write");
  });

  test("PUT: a pending surface grant's /material 409s (never grantable pre-approval)", async () => {
    const bearer = await moduleBearer();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
        }),
      ),
    );
    const res = await dispatch(bearerReq("GET", `/admin/grants/${created.id}/material`, bearer));
    expect(res.status).toBe(409);
  });

  test("PUT: rejects an invalid surface name (400)", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "surfacer",
        connection: { kind: "surface", target: "bad/name", access: "write" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("PUT: rejects a bad surface access verb (400)", async () => {
    const bearer = await moduleBearer();
    const res = await dispatch(
      bearerReq("PUT", "/admin/grants", bearer, {
        agent: "surfacer",
        connection: { kind: "surface", target: "gitcoin-brain", access: "admin" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("approve: MINTS a registered surface:<name>:write token (operator-gated)", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
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

    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    const mat = stored?.material as { kind: string; token: string; jti: string };
    expect(mat.kind).toBe("surface");
    const claims = decodeJwt(mat.token) as Record<string, unknown>;
    expect(claims.scope).toBe("surface:gitcoin-brain:write");
    expect(claims.aud).toBe("surface.gitcoin-brain");
    // registered → revocable
    expect(findTokenRowByJti(harness.db, mat.jti)).not.toBeNull();
  });

  test("approve: is operator-only — a module Bearer cannot approve", async () => {
    const bearer = await moduleBearer();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
        }),
      ),
    );
    const id = created.id as string;
    // A host-admin Bearer is module-auth, NOT the operator cookie the approve
    // path requires — so it 401s (a note/module can never self-approve).
    const res = await dispatch(bearerReq("POST", `/admin/grants/${id}/approve`, bearer));
    expect(res.status).toBe(401);
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("pending");
  });

  test("approve: a non-first-admin operator cannot approve (403)", async () => {
    const bearer = await moduleBearer();
    const friend = await friendCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
        }),
      ),
    );
    const id = created.id as string;
    const res = await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, friend));
    expect(res.status).toBe(403);
    expect(readGrants(harness.storePath).find((r) => r.id === id)?.status).toBe("pending");
  });

  test("material: an approved surface grant returns { kind:surface, token, remoteUrl }", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
        }),
      ),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const res = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(res.status).toBe(200);
    const mat = await json(res);
    expect(mat.kind).toBe("surface");
    expect(typeof mat.token).toBe("string");
    // The git remote the agent clones/pushes to — the git-transport endpoint.
    expect(mat.remoteUrl).toBe(`${HUB_ORIGIN}/git/gitcoin-brain`);
    const claims = decodeJwt(mat.token as string) as Record<string, unknown>;
    expect(claims.scope).toBe("surface:gitcoin-brain:write");
  });

  test("a read-only surface grant mints surface:<name>:read", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "read" },
        }),
      ),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const mat = await json(
      await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer)),
    );
    expect(mat.remoteUrl).toBe(`${HUB_ORIGIN}/git/gitcoin-brain`);
    const claims = decodeJwt(mat.token as string) as Record<string, unknown>;
    expect(claims.scope).toBe("surface:gitcoin-brain:read");
  });

  test("a mixed-case surface name is canonicalized to lowercase (scope + remote + idempotency)", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "GitCoin-Brain", access: "write" },
        }),
      ),
    );
    // Stored target is normalized to lowercase, so the minted scope + the /material
    // remote match a lowercase-registered surface and the agent's echoed-target key
    // stays consistent (no mixed-case collapse mismatch).
    expect((created.connection as Record<string, unknown>).target).toBe("gitcoin-brain");
    // A second PUT with the lowercase twin is the SAME grant (idempotent), not a fork.
    const twin = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
        }),
      ),
    );
    expect(twin.id).toBe(created.id);
    expect(readGrants(harness.storePath).filter((r) => r.agent === "surfacer")).toHaveLength(1);
    // Approve → the minted scope + the /material remote are both lowercase.
    await dispatch(cookieReq("POST", `/admin/grants/${created.id as string}/approve`, cookie));
    const mat = await json(
      await dispatch(bearerReq("GET", `/admin/grants/${created.id as string}/material`, bearer)),
    );
    expect(mat.remoteUrl).toBe(`${HUB_ORIGIN}/git/gitcoin-brain`);
    expect((decodeJwt(mat.token as string) as Record<string, unknown>).scope).toBe(
      "surface:gitcoin-brain:write",
    );
  });

  test("re-approval revokes the prior minted surface token", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
        }),
      ),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const firstJti = (
      readGrants(harness.storePath).find((r) => r.id === id)?.material as { jti: string }
    ).jti;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const secondJti = (
      readGrants(harness.storePath).find((r) => r.id === id)?.material as { jti: string }
    ).jti;
    expect(secondJti).not.toBe(firstJti);
    expect(findTokenRowByJti(harness.db, firstJti)?.revokedAt).toBeTruthy();
    expect(findTokenRowByJti(harness.db, secondJti)?.revokedAt).toBeFalsy();
  });

  test("revoke: drops the material AND revokes the minted token in the registry", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
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
    const stored = readGrants(harness.storePath).find((r) => r.id === id);
    expect(stored?.status).toBe("revoked");
    expect(stored?.material).toBeUndefined();
    expect(findTokenRowByJti(harness.db, jti)?.revokedAt).toBeTruthy();
    // /material now 409s
    const mat = await dispatch(bearerReq("GET", `/admin/grants/${id}/material`, bearer));
    expect(mat.status).toBe(409);
  });

  test("reconcile prunes a surface grant that's no longer wanted", async () => {
    const bearer = await moduleBearer();
    const cookie = await operatorCookie();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
        }),
      ),
    );
    const id = created.id as string;
    await dispatch(cookieReq("POST", `/admin/grants/${id}/approve`, cookie));
    const jti = (
      readGrants(harness.storePath).find((r) => r.id === id)?.material as { jti: string }
    ).jti;
    // reconcile with NO live connections → prune (tears down the token too)
    const res = await dispatch(
      bearerReq("POST", "/admin/grants/reconcile", bearer, {
        agent: "surfacer",
        liveConnections: [],
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.pruned).toBe(1);
    expect(getGrant(harness.storePath, id)).toBeNull();
    expect(findTokenRowByJti(harness.db, jti)?.revokedAt).toBeTruthy();
  });

  test("reconcile KEEPS a surface grant that's still declared (spec-derived key match)", async () => {
    const bearer = await moduleBearer();
    const created = await json(
      await dispatch(
        bearerReq("PUT", "/admin/grants", bearer, {
          agent: "surfacer",
          connection: { kind: "surface", target: "gitcoin-brain", access: "write" },
        }),
      ),
    );
    const id = created.id as string;
    // The agent sends the SPEC (not a pre-computed key); the hub re-derives the
    // key with its OWN connectionKey → the still-wanted grant is kept.
    const res = await dispatch(
      bearerReq("POST", "/admin/grants/reconcile", bearer, {
        agent: "surfacer",
        liveConnections: [{ kind: "surface", target: "gitcoin-brain", access: "write" }],
      }),
    );
    expect(res.status).toBe(200);
    expect((await json(res)).pruned).toBe(0);
    expect(getGrant(harness.storePath, id)).not.toBeNull();
  });
});
