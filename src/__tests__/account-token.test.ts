/**
 * Tests for `POST /account/token` — the cookie→account-bearer mint (Parachute
 * App campaign, Phase 2 H1). Covers:
 *   - 405 on a non-POST method.
 *   - 401 when no admin session cookie is present (unauthenticated → refused).
 *   - 401 when the cookie names a deleted session.
 *   - 403 csrf_failed when the double-submit CSRF token is missing / mismatched.
 *   - 403 not_admin when a signed-in non-first-admin (friend) hits the endpoint.
 *   - 200 mint carrying the superset {account:self:admin, parachute:host:admin,
 *     parachute:host:auth}, aud="account", validating against the hub's keys.
 *   - scope-guard admin ⊇ read: account:self:read is inherited by the minted
 *     account:self:admin (the RS-side check the `/account/*` validator runs).
 *   - the superset actually unlocks a host-admin-gated endpoint (requireScope
 *     accepts parachute:host:admin even though aud="account" — SCOPE-b).
 *   - sliding session renewal on the success path.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_ERROR_CODES, checkAccountTokenMintResponse } from "@openparachute/door-contract";
// The `/account/*` validator (H2 / cloud) hand-rolls its scope check via
// scope-guard's hasScope — hub never imports scope-guard at runtime (the
// issuer/validator boundary), but the test asserts the RS-side inheritance
// the account grammar must satisfy. Same relative import as account-setup.test.
import { hasScope } from "../../packages/scope-guard/src/scope.ts";
import {
  ACCOUNT_TOKEN_AUDIENCE,
  ACCOUNT_TOKEN_TTL_SECONDS,
  handleAccountToken,
} from "../account-token.ts";
import { requireScope } from "../admin-auth.ts";
import { CSRF_FIELD_NAME, buildCsrfCookie, generateCsrfToken } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { ACCOUNT_SELF_ADMIN_SCOPE, ACCOUNT_SELF_READ_SCOPE } from "../scope-explanations.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "phub-account-token-"));
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

/**
 * Build a first-admin session + a matching CSRF token pair. Returns the cookie
 * header (session + csrf) and the CSRF token to place in the JSON body — the
 * double-submit both halves must agree on.
 */
async function withAdminSession(): Promise<{
  cookie: string;
  csrf: string;
  userId: string;
}> {
  const user = await createUser(harness.db, "operator", "operator-passphrase");
  const session = createSession(harness.db, { userId: user.id });
  const csrf = generateCsrfToken();
  const cookie = [
    buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)).split(";")[0],
    buildCsrfCookie(csrf).split(";")[0],
  ].join("; ");
  return { cookie, csrf, userId: user.id };
}

/** Seed an admin + a second non-admin friend; return the friend's cookie/csrf. */
async function withFriendSession(): Promise<{ cookie: string; csrf: string }> {
  await createUser(harness.db, "admin", "admin-passphrase");
  const friend = await createUser(harness.db, "alice", "alice-passphrase", { allowMulti: true });
  const session = createSession(harness.db, { userId: friend.id });
  const csrf = generateCsrfToken();
  const cookie = [
    buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)).split(";")[0],
    buildCsrfCookie(csrf).split(";")[0],
  ].join("; ");
  return { cookie, csrf };
}

function postReq(cookie: string, body: Record<string, unknown>): Request {
  return new Request(`${ISSUER}/account/token`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("handleAccountToken", () => {
  test("405 on GET", async () => {
    const { cookie } = await withAdminSession();
    const req = new Request(`${ISSUER}/account/token`, { headers: { cookie } });
    const res = await handleAccountToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
    // H1.3 — pin the CURRENT shape: account-token.ts emits {error,
    // error_description} uniformly (its own local `jsonError`), including for
    // this 405 — DIFFERENT from account-session.ts's 405, which emits {error,
    // message} (see that file's test). A decisions-needed inconsistency
    // across /account/*, not fixed here.
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body).toEqual({ error: "method_not_allowed", error_description: "use POST" });
    expect(ACCOUNT_ERROR_CODES as readonly string[]).toContain(body.error);
  });

  test("401 when no session cookie is present (unauthenticated → refused)", async () => {
    // No session AND no CSRF: the session gate fires first, so the refusal is a
    // clean 401 rather than a CSRF 403.
    const req = postReq("", { [CSRF_FIELD_NAME]: "anything" });
    const res = await handleAccountToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("unauthenticated");
    // H1.3 — pin the CURRENT shape: auth-gate failures on /account/* emit
    // {error, error_description} (door-contract account-contract.ts:244-246).
    expect(typeof body.error_description).toBe("string");
    expect(body.error_description.length).toBeGreaterThan(0);
    expect(ACCOUNT_ERROR_CODES as readonly string[]).toContain(body.error);
  });

  test("401 when the cookie names a deleted session", async () => {
    const { cookie, csrf } = await withAdminSession();
    const sid = cookie.match(/parachute_hub_session=([^;]+)/)?.[1] ?? "";
    deleteSession(harness.db, sid);
    const res = await handleAccountToken(postReq(cookie, { [CSRF_FIELD_NAME]: csrf }), {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(401);
  });

  test("403 csrf_failed when the CSRF token is absent from the body", async () => {
    const { cookie } = await withAdminSession();
    rotateSigningKey(harness.db);
    const res = await handleAccountToken(postReq(cookie, {}), { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("csrf_failed");
    // H1.3 — pin the {error, error_description} shape + ACCOUNT_ERROR_CODES membership.
    expect(typeof body.error_description).toBe("string");
    expect(ACCOUNT_ERROR_CODES as readonly string[]).toContain(body.error);
  });

  test("403 csrf_failed when the body token doesn't match the cookie token", async () => {
    const { cookie } = await withAdminSession();
    rotateSigningKey(harness.db);
    // A well-formed but wrong token (never the cookie's value).
    const res = await handleAccountToken(
      postReq(cookie, { [CSRF_FIELD_NAME]: generateCsrfToken() }),
      { db: harness.db, issuer: ISSUER },
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("csrf_failed");
  });

  test("403 not_admin when a signed-in friend (non-first-admin) mints", async () => {
    // Privesc closure: a valid friend session + valid CSRF must still be
    // refused — the account superset carries host:admin + host:auth, which a
    // non-admin must never hold. The gate keys off first-admin (account ≡ box).
    const { cookie, csrf } = await withFriendSession();
    rotateSigningKey(harness.db);
    const res = await handleAccountToken(postReq(cookie, { [CSRF_FIELD_NAME]: csrf }), {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("not_admin");
    expect(body.error_description).toContain("/account/");
    // H1.3 — DECISIONS-NEEDED (cataloged, not fixed here): "not_admin" is a
    // real emitted /account/* error code but is NOT a member of door-contract's
    // ACCOUNT_ERROR_CODES union — a gap in the shared vocabulary. See the PR
    // body's decisions-needed section rather than asserting membership here.
  });

  test("200 mints the account superset with aud=account, validating against the hub keys", async () => {
    const { cookie, csrf, userId } = await withAdminSession();
    rotateSigningKey(harness.db);
    const res = await handleAccountToken(postReq(cookie, { [CSRF_FIELD_NAME]: csrf }), {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      token: string;
      expires_at: string;
      scopes: string[];
      aud: string;
    };
    // The superset (SCOPE-b): account scope + the host superset.
    expect(body.scopes).toEqual([
      "account:self:admin",
      "parachute:host:admin",
      "parachute:host:auth",
    ]);
    expect(body.aud).toBe(ACCOUNT_TOKEN_AUDIENCE);
    // H1.2 — door-contract conformance against the live `POST /account/token`
    // success body (V1.4/C1.4 twin coverage, hub half).
    expect(checkAccountTokenMintResponse(body)).toEqual([]);

    // TTL is roughly the 10-min window.
    const skew = new Date(body.expires_at).getTime() - Date.now();
    expect(skew).toBeGreaterThan((ACCOUNT_TOKEN_TTL_SECONDS - 30) * 1000);
    expect(skew).toBeLessThan((ACCOUNT_TOKEN_TTL_SECONDS + 30) * 1000);

    // JWT verifies against the hub's own signing key + issuer, and carries the
    // explicit account audience (SCOPE-a).
    const validated = await validateAccessToken(harness.db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(userId);
    expect(validated.payload.iss).toBe(ISSUER);
    expect(validated.payload.aud).toBe(ACCOUNT_TOKEN_AUDIENCE);
    const scopes = ((validated.payload as { scope?: string }).scope ?? "").split(/\s+/);
    expect(scopes).toContain("account:self:admin");
    expect(scopes).toContain("parachute:host:admin");
    expect(scopes).toContain("parachute:host:auth");
  });

  test("scope-guard: account:self:read is inherited by the minted account:self:admin", async () => {
    // The `/account/*` validator (H2 / cloud) hand-rolls admin ⊇ read via
    // scope-guard. The minted token carries account:self:admin; a read-gated
    // account endpoint must accept it, an admin-gated one too, and neither a
    // different account id nor an unrelated resource must match.
    const { cookie, csrf } = await withAdminSession();
    rotateSigningKey(harness.db);
    const res = await handleAccountToken(postReq(cookie, { [CSRF_FIELD_NAME]: csrf }), {
      db: harness.db,
      issuer: ISSUER,
    });
    const { scopes } = (await res.json()) as { scopes: string[] };

    expect(hasScope(scopes, ACCOUNT_SELF_ADMIN_SCOPE)).toBe(true);
    expect(hasScope(scopes, ACCOUNT_SELF_READ_SCOPE)).toBe(true); // admin ⊇ read
    // A different account id must NOT be satisfied (name-pinned inheritance).
    expect(hasScope(scopes, "account:other:read")).toBe(false);
    // account:self:admin must never satisfy a vault scope.
    expect(hasScope(scopes, "vault:self:read")).toBe(false);
  });

  test("the minted superset unlocks a host-admin-gated endpoint (SCOPE-b, aud not pinned)", async () => {
    // requireScope validates signature + iss + the scope claim but does NOT pin
    // aud, so the aud="account" token is accepted on the host-scoped surfaces
    // (POST /vaults, /api/auth/*) it wraps — no existing gate needs rewiring.
    const { cookie, csrf } = await withAdminSession();
    rotateSigningKey(harness.db);
    const res = await handleAccountToken(postReq(cookie, { [CSRF_FIELD_NAME]: csrf }), {
      db: harness.db,
      issuer: ISSUER,
    });
    const { token } = (await res.json()) as { token: string };

    const bearerReq = new Request(`${ISSUER}/vaults`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const ctx = await requireScope(harness.db, bearerReq, "parachute:host:admin", ISSUER);
    expect(ctx.scopes).toContain("account:self:admin");
    expect(ctx.audience).toBe(ACCOUNT_TOKEN_AUDIENCE);
  });

  test("200 slides the session expiry forward and re-issues the cookie", async () => {
    const user = await createUser(harness.db, "operator", "operator-passphrase");
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const session = createSession(harness.db, { userId: user.id, now: () => twelveHoursAgo });
    const originalExpiry = new Date(session.expiresAt).getTime();
    const csrf = generateCsrfToken();
    const cookie = [
      buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)).split(";")[0],
      buildCsrfCookie(csrf).split(";")[0],
    ].join("; ");
    rotateSigningKey(harness.db);

    const res = await handleAccountToken(postReq(cookie, { [CSRF_FIELD_NAME]: csrf }), {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("parachute_hub_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure"); // ISSUER is https
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie.toLowerCase()).not.toContain("domain=");

    const found = findSession(harness.db, session.id);
    expect(new Date(found?.expiresAt ?? 0).getTime()).toBeGreaterThan(originalExpiry);
  });
});
