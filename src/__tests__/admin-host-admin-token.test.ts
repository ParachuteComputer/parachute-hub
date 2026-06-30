/**
 * Tests for the SPA's session→bearer mint endpoint. Covers:
 *   - 401 when no admin session cookie is present.
 *   - 401 when the cookie names a deleted/expired session.
 *   - 200 + JWT carrying parachute:host:admin AND parachute:host:auth.
 *   - Token validates against the hub's own keys and the configured issuer.
 *   - Method-not-allowed on POST.
 *   - End-to-end regression: the minted JWT actually unlocks the new
 *     `/api/auth/tokens` endpoint (hub#212 Phase 2 backend) — the bug from
 *     end-to-end testing that motivated adding `parachute:host:auth` here.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ADMIN_TOKEN_TTL_SECONDS, handleHostAdminToken } from "../admin-host-admin-token.ts";
import { handleApiTokens } from "../api-tokens.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import {
  SESSION_TTL_MS,
  buildSessionCookie,
  createSession,
  deleteSession,
  findSession,
} from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-host-admin-token-"));
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

async function withSession(): Promise<{ cookie: string; userId: string }> {
  const user = await createUser(harness.db, "operator", "hunter2");
  const session = createSession(harness.db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  return { cookie, userId: user.id };
}

/**
 * Seed an admin (first-created user) + a second non-admin "friend"
 * account, return cookies + ids for both. Used by the first-admin-gate
 * tests.
 */
async function withAdminAndFriend(): Promise<{
  adminCookie: string;
  adminId: string;
  friendCookie: string;
  friendId: string;
}> {
  const admin = await createUser(harness.db, "admin", "admin-passphrase");
  const friend = await createUser(harness.db, "alice", "alice-passphrase", {
    allowMulti: true,
  });
  const adminSession = createSession(harness.db, { userId: admin.id });
  const friendSession = createSession(harness.db, { userId: friend.id });
  return {
    adminCookie: buildSessionCookie(adminSession.id, Math.floor(SESSION_TTL_MS / 1000)),
    adminId: admin.id,
    friendCookie: buildSessionCookie(friendSession.id, Math.floor(SESSION_TTL_MS / 1000)),
    friendId: friend.id,
  };
}

describe("handleHostAdminToken", () => {
  test("401 when no session cookie is present", async () => {
    const req = new Request(`${ISSUER}/admin/host-admin-token`);
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("401 when the cookie names a deleted session", async () => {
    const { cookie } = await withSession();
    // Pluck the session id back out of the cookie + delete its row.
    const sid = cookie.match(/parachute_hub_session=([^;]+)/)?.[1] ?? "";
    deleteSession(harness.db, sid);
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      headers: { cookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
  });

  test("405 on POST", async () => {
    const { cookie } = await withSession();
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      method: "POST",
      headers: { cookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });

  test("200 mints a JWT carrying parachute:host:admin + parachute:host:auth and the configured issuer", async () => {
    const { cookie, userId } = await withSession();
    rotateSigningKey(harness.db);
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      headers: { cookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      token: string;
      expires_at: string;
      scopes: string[];
    };
    // Both scopes — the SPA now needs `:host:auth` for the hub#212 Phase 2
    // token-registry endpoints alongside the existing `:host:admin` for
    // vault provisioning + grant management.
    expect(body.scopes).toEqual(["parachute:host:admin", "parachute:host:auth"]);
    expect(body.token.length).toBeGreaterThan(20);

    // expires_at is roughly TTL_SECONDS in the future.
    const expMs = new Date(body.expires_at).getTime();
    const skew = expMs - Date.now();
    expect(skew).toBeGreaterThan((HOST_ADMIN_TOKEN_TTL_SECONDS - 30) * 1000);
    expect(skew).toBeLessThan((HOST_ADMIN_TOKEN_TTL_SECONDS + 30) * 1000);

    // JWT verifies against the hub's own signing key + issuer.
    const validated = await validateAccessToken(harness.db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(userId);
    expect(validated.payload.iss).toBe(ISSUER);
    const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
    const scopes = scopeClaim.split(/\s+/);
    expect(scopes).toContain("parachute:host:admin");
    expect(scopes).toContain("parachute:host:auth");
  });

  test("403 not_admin when a signed-in non-first-admin (friend) hits the endpoint", async () => {
    // Privesc closure: without the first-admin gate, any signed-in
    // friend account could mint a JWT carrying parachute:host:admin +
    // parachute:host:auth — the SPA bearer that gates vault provisioning,
    // grants, and the token registry. The friend's session is valid;
    // the endpoint must refuse because the session.userId doesn't match
    // the first-admin row.
    const { friendCookie } = await withAdminAndFriend();
    rotateSigningKey(harness.db);
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      headers: { cookie: friendCookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("not_admin");
    // The wire description steers the SPA-side handler toward /account/.
    expect(body.error_description).toContain("/account/");
  });

  test("first-admin path still succeeds when a friend exists alongside", async () => {
    // Belt-and-suspenders for the gate above: adding a second user must
    // not break the admin's own happy path. Same DB, same query — the
    // admin's session.userId matches the earliest-created row, so the
    // gate passes.
    const { adminCookie, adminId } = await withAdminAndFriend();
    rotateSigningKey(harness.db);
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      headers: { cookie: adminCookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const validated = await validateAccessToken(harness.db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(adminId);
  });

  // Sliding session renewal (Fix A) — a successful mint pushes the session's
  // expiry forward and re-issues the cookie, so an active operator (the SPA
  // re-mints ~every 10 min) isn't hard-logged-out at the 24h mark. The cookie
  // must keep the EXACT attributes creation uses — not broadened.
  test("200 renews the session cookie (HttpOnly/Secure/SameSite/host-only) and slides expiry", async () => {
    const user = await createUser(harness.db, "operator", "hunter2");
    // Create the session 12h in the past so the forward slide is observable.
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const session = createSession(harness.db, { userId: user.id, now: () => twelveHoursAgo });
    const originalExpiry = new Date(session.expiresAt).getTime();
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
    rotateSigningKey(harness.db);

    const res = await handleHostAdminToken(
      new Request(`${ISSUER}/admin/host-admin-token`, { headers: { cookie } }),
      { db: harness.db, issuer: ISSUER },
    );
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("parachute_hub_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure"); // ISSUER is https → Secure kept
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Path=/oauth");
    // Host-only: the renewed cookie must NOT add a Domain (no broadening).
    expect(setCookie.toLowerCase()).not.toContain("domain=");

    // The session's expiry slid forward (touchSession ran on the success path).
    const found = findSession(harness.db, session.id);
    expect(new Date(found?.expiresAt ?? 0).getTime()).toBeGreaterThan(originalExpiry);
  });

  test("renewed cookie omits Secure over plain HTTP (protocol-correct, not broadened)", async () => {
    const { cookie } = await withSession();
    rotateSigningKey(harness.db);
    // HTTP origin → isHttpsRequest false → no Secure, so the browser keeps the
    // cookie on http://localhost:1939 — mirrors how the session cookie is minted.
    const res = await handleHostAdminToken(
      new Request("http://hub.test/admin/host-admin-token", { headers: { cookie } }),
      { db: harness.db, issuer: ISSUER },
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("parachute_hub_session=");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  // Regression for the end-to-end bug that motivated adding `:host:auth`
  // here: the SPA's session-bearer was rejected by `/api/auth/tokens` (and
  // its peers) because it carried `:host:admin` only. This test mints
  // through the SPA path and exercises one of the new endpoints
  // end-to-end — the Phase 2 backend tests only minted operator-style
  // tokens with `:host:auth` directly, leaving the SPA-flow gap uncaught.
  test("regression: the minted SPA bearer is accepted by /api/auth/tokens", async () => {
    const { cookie } = await withSession();
    rotateSigningKey(harness.db);

    // Step 1: SPA grabs its bearer via the cookie path.
    const mintRes = await handleHostAdminToken(
      new Request(`${ISSUER}/admin/host-admin-token`, { headers: { cookie } }),
      { db: harness.db, issuer: ISSUER },
    );
    expect(mintRes.status).toBe(200);
    const { token } = (await mintRes.json()) as { token: string };

    // Step 2: SPA hits /api/auth/tokens with that bearer. Pre-fix this
    // returned 403 `bearer token lacks parachute:host:auth`; post-fix it
    // returns 200 with the (empty-by-default) tokens list.
    const tokensRes = await handleApiTokens(
      new Request(`${ISSUER}/api/auth/tokens`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      }),
      { db: harness.db, issuer: ISSUER },
    );
    expect(tokensRes.status).toBe(200);
    const tokensBody = (await tokensRes.json()) as {
      tokens: unknown[];
      next_cursor: string | null;
    };
    expect(Array.isArray(tokensBody.tokens)).toBe(true);
    expect(tokensBody.next_cursor).toBeNull();
  });
});
