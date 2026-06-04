/**
 * `/account/change-password` GET + POST — multi-user Phase 1 PR 3.
 *
 * Coverage:
 *   - GET without session → 302 /login (with `next` preserved)
 *   - GET with session, passwordChanged=false → 200 with "First-time" heading
 *   - GET with session, passwordChanged=true → 200 with "Change your password" heading
 *   - POST without session → 401
 *   - POST without CSRF → 400
 *   - POST happy path: hash updated + password_changed flips to 1
 *   - POST wrong current → 401
 *   - POST new too short (< 12) → 400
 *   - POST new too long (> PASSWORD_MAX_LEN) → 413 with timing pin
 *   - POST new !== confirm → 400
 *   - POST new === current → 400 (after verify, to avoid leaking that
 *     `new_password` matches any *attempted* current)
 *   - POST with passwordChanged=false: flag flips AND the page works
 *     normally (the only flag-gated behavior is the /login redirect)
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleAccountChangePasswordGet,
  handleAccountChangePasswordPost,
  handleAccountHomeGet,
  markPasswordChanged,
} from "../api-account.ts";
import { CSRF_COOKIE_NAME, CSRF_FIELD_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { recordTokenMint } from "../jwt-sign.ts";
import {
  CHANGE_PASSWORD_MAX_ATTEMPTS,
  CHANGE_PASSWORD_WINDOW_MS,
  changePasswordRateLimiter,
} from "../rate-limit.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { createUser, getUserById, verifyPassword } from "../users.ts";

const TEST_CSRF = "csrf-account-test-token";
const CSRF_COOKIE = `${CSRF_COOKIE_NAME}=${TEST_CSRF}`;

interface Harness {
  db: Database;
  configDir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const configDir = mkdtempSync(join(tmpdir(), "phub-api-account-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    configDir,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

async function sessionCookieFor(
  db: Database,
  username: string,
  password: string,
  opts: { passwordChanged?: boolean; allowMulti?: boolean } = {},
): Promise<{ userId: string; cookie: string }> {
  const user = await createUser(db, username, password, {
    passwordChanged: opts.passwordChanged ?? false,
    allowMulti: opts.allowMulti ?? false,
  });
  const session = createSession(db, { userId: user.id });
  const cookie = `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`;
  return { userId: user.id, cookie };
}

function formBody(values: Record<string, string>): {
  body: string;
  headers: Record<string, string>;
} {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) params.append(k, v);
  return {
    body: params.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
  // Per-test rate-limit reset — change-password tests share the
  // singleton `changePasswordRateLimiter`, and a test that exhausts a
  // user-id bucket would 429-cascade into the next test if the user-id
  // happened to collide. Per-harness DB → fresh user-ids, so in practice
  // there's no collision, but the explicit reset matches `admin-handlers`
  // discipline and pins the contract.
  changePasswordRateLimiter.reset();
});
afterEach(() => {
  harness.cleanup();
});

describe("GET /account/change-password", () => {
  test("no session → 302 /login with next preserved", () => {
    const req = new Request("http://hub.test/account/change-password");
    const res = handleAccountChangePasswordGet(req, { db: harness.db });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc.startsWith("/login?next=")).toBe(true);
    // The encoded next should bring the user back to this page.
    expect(decodeURIComponent(loc.split("?next=")[1] ?? "")).toBe("/account/change-password");
  });

  test("no session with a downstream next= bounces through /login carrying both legs", () => {
    const req = new Request("http://hub.test/account/change-password?next=%2Fadmin%2Fpermissions");
    const res = handleAccountChangePasswordGet(req, { db: harness.db });
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    // After /login the user should land at /account/change-password?next=/admin/permissions.
    // The location header carries that as a percent-encoded `next` param;
    // decode twice (once for the outer `?next=`, once for the inner
    // `?next=` inside the change-password target).
    const outerNext = decodeURIComponent(loc.split("?next=")[1] ?? "");
    expect(outerNext.startsWith("/account/change-password")).toBe(true);
    expect(decodeURIComponent(outerNext)).toContain("/admin/permissions");
  });

  test("passwordChanged=false renders the first-time heading", async () => {
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "default-pw", {
      passwordChanged: false,
    });
    const req = new Request("http://hub.test/account/change-password", {
      headers: { cookie },
    });
    const res = handleAccountChangePasswordGet(req, { db: harness.db });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("First-time login");
    // form posts back to the same path
    expect(html).toContain('action="/account/change-password"');
    // signed-in-as label includes the username
    expect(html).toContain("newbie");
  });

  test("passwordChanged=true renders the rotate heading (direct nav is allowed)", async () => {
    // Per design §"Direct navigation": a user with the flag flipped can
    // still navigate here to rotate their password. The redirect at /login
    // is the only flag-gated behavior.
    const { cookie } = await sessionCookieFor(harness.db, "admin", "admin-pw", {
      passwordChanged: true,
    });
    const req = new Request("http://hub.test/account/change-password", {
      headers: { cookie },
    });
    const res = handleAccountChangePasswordGet(req, { db: harness.db });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Change your password");
    expect(html).not.toContain("First-time login");
  });

  test("session pointing at non-existent user → 302 /login (graceful logout)", async () => {
    // Defends against the race where a session row outlives the user it
    // points at (a delete-user via SQL shell, a corrupted restore, etc.).
    // The on-disk FK normally guards against this state, so forge it
    // explicitly with `PRAGMA foreign_keys=OFF` around the INSERT.
    const sessionId = "test-stale-session-id-base64url-padding";
    harness.db.exec("PRAGMA foreign_keys = OFF");
    try {
      harness.db
        .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(
          sessionId,
          "nonexistent-user-uuid",
          new Date(Date.now() + 60_000).toISOString(),
          new Date().toISOString(),
        );
    } finally {
      harness.db.exec("PRAGMA foreign_keys = ON");
    }
    const cookie = `${CSRF_COOKIE}; ${buildSessionCookie(sessionId, Math.floor(SESSION_TTL_MS / 1000))}`;
    const req = new Request("http://hub.test/account/change-password", {
      headers: { cookie },
    });
    const res = handleAccountChangePasswordGet(req, { db: harness.db });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("POST /account/change-password", () => {
  test("no session → 401", async () => {
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "default-pw",
      new_password: "long-enough-passphrase",
      new_password_confirm: "long-enough-passphrase",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie: CSRF_COOKIE },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(401);
  });

  test("CSRF mismatch → 400", async () => {
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "default-pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: "wrong-token",
      current_password: "default-pw",
      new_password: "long-enough-passphrase",
      new_password_confirm: "long-enough-passphrase",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(400);
  });

  test("happy path: hash updates, password_changed flips to 1, 302 to next", async () => {
    const { userId, cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw", {
      passwordChanged: false,
    });
    const before = getUserById(harness.db, userId);
    expect(before?.passwordChanged).toBe(false);
    const oldHash = before?.passwordHash;
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphrase",
      next: "/admin/permissions",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/permissions");

    const after = getUserById(harness.db, userId);
    expect(after?.passwordChanged).toBe(true);
    expect(after?.passwordHash).not.toBe(oldHash);
    expect(after).toBeTruthy();
    if (after) {
      expect(await verifyPassword(after, "user-chosen-strong-passphrase")).toBe(true);
      expect(await verifyPassword(after, "old-default-pw")).toBe(false);
    }
  });

  // Item F / hub#469 — a successful self-service password change revokes the
  // user's still-active tokens (so a token minted under the admin's temp
  // password dies with the rotation). Mirrors `resetUserPassword`'s admin-reset
  // revoke. Tokens belonging to OTHER users are untouched.
  test("self-change revokes the user's active tokens, leaves other users' tokens (item F)", async () => {
    const { userId, cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw", {
      passwordChanged: false,
    });
    const other = await createUser(harness.db, "other", "other-strong-passphrase", {
      passwordChanged: true,
      allowMulti: true,
    });
    // Seed one active token for the changing user + one for another user.
    recordTokenMint(harness.db, {
      jti: "tok-self-1",
      createdVia: "cli_mint",
      subject: userId,
      userId,
      clientId: "parachute-account",
      scopes: ["vault:work:read"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    recordTokenMint(harness.db, {
      jti: "tok-other-1",
      createdVia: "cli_mint",
      subject: other.id,
      userId: other.id,
      clientId: "parachute-account",
      scopes: ["vault:work:read"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphrase",
      next: "/account/",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(302);

    const selfTok = harness.db
      .query<{ revoked_at: string | null }, [string]>("SELECT revoked_at FROM tokens WHERE jti = ?")
      .get("tok-self-1");
    const otherTok = harness.db
      .query<{ revoked_at: string | null }, [string]>("SELECT revoked_at FROM tokens WHERE jti = ?")
      .get("tok-other-1");
    expect(selfTok?.revoked_at).not.toBeNull(); // changing user's token revoked
    expect(otherTok?.revoked_at).toBeNull(); // other user's token untouched
  });

  test("non-admin user with no next defaults to /account/ (no admin-shell flash)", async () => {
    // Without this rewrite, a friend's change-password POST would 302 to
    // /admin/vaults, the SPA would load, the 403 from
    // /admin/host-admin-token would bounce them to /account/ — a visible
    // two-hop flash. Mirror the login-redirect rewrite in admin-handlers.ts.
    await createUser(harness.db, "operator", "operator-strong-passphrase");
    const { cookie } = await sessionCookieFor(harness.db, "friend", "old-default-pw", {
      passwordChanged: false,
      allowMulti: true,
    });
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphrase",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/account/");
  });

  test("non-admin user with next=/admin/users gets rewritten to /account/", async () => {
    await createUser(harness.db, "operator", "operator-strong-passphrase");
    const { cookie } = await sessionCookieFor(harness.db, "friend", "old-default-pw", {
      passwordChanged: false,
      allowMulti: true,
    });
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphrase",
      next: "/admin/users",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/account/");
  });

  test("non-admin user with non-admin next= passes through unchanged", async () => {
    // Friends with a legitimate non-admin destination (e.g. /oauth/authorize
    // mid-flow) should land where they intended — the rewrite only catches
    // /admin/* targets.
    await createUser(harness.db, "operator", "operator-strong-passphrase");
    const { cookie } = await sessionCookieFor(harness.db, "friend", "old-default-pw", {
      passwordChanged: false,
      allowMulti: true,
    });
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphrase",
      next: "/oauth/authorize?client_id=abc",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/oauth/authorize?client_id=abc");
  });

  test("non-admin with exact next=/admin (no trailing slash) rewrites to /account/", async () => {
    // Pins the exact-match arm of the prefix gate. Tests in #426 cover
    // /admin/users (prefix match) and the no-next case (POST_CHANGE_DEFAULT
    // → rewrite). This is the third arm.
    await createUser(harness.db, "operator", "operator-strong-passphrase");
    const { cookie } = await sessionCookieFor(harness.db, "friend", "old-default-pw", {
      passwordChanged: false,
      allowMulti: true,
    });
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphrase",
      next: "/admin",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/account/");
  });

  test("first admin with no next still defaults to /admin/vaults", async () => {
    // Existing behavior — preserved by the non-admin gate. The first user
    // is the admin under Phase 1; admin SPA is the intended landing.
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw", {
      passwordChanged: false,
    });
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphrase",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/vaults");
  });

  test("wrong current_password → 401, no state change", async () => {
    const { userId, cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw", {
      passwordChanged: false,
    });
    const oldHash = getUserById(harness.db, userId)?.passwordHash;
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "this-is-not-the-pw",
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphrase",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(401);
    const after = getUserById(harness.db, userId);
    expect(after?.passwordChanged).toBe(false);
    expect(after?.passwordHash).toBe(oldHash ?? "");
  });

  test("new password too short (< 12) → 400 invalid_password", async () => {
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: "short",
      new_password_confirm: "short",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("at least 12");
  });

  test("new password too long (> PASSWORD_MAX_LEN) → 413, fires before argon2id", async () => {
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw");
    const huge = "a".repeat(300);
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: huge,
      new_password_confirm: huge,
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const t0 = Date.now();
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(413);
    // Same timing-pin pattern PR 2 uses on /api/users — the cap should
    // reject in < 200ms even on a noisy runner; an argon2id verify of the
    // current password would push elapsed into the hundreds of ms.
    expect(elapsed).toBeLessThan(200);
  });

  test("current_password too long (> PASSWORD_MAX_LEN) → 413, fires before argonVerify (PR-3 fold N1)", async () => {
    // Fold N1: a session-authenticated caller could otherwise submit a
    // huge `current_password` and burn argon2id verify cycles on
    // arbitrary input. The cap should reject before verifyPassword
    // touches the body — pin with elapsed-time floor < 200ms.
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw", {
      passwordChanged: false,
    });
    const huge = "x".repeat(5000);
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: huge,
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphrase",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const t0 = Date.now();
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(413);
    const html = await res.text();
    expect(html).toContain("Current password must be");
    // Pin: cap-and-reject < 200ms even on a noisy runner. An argon2id
    // verify of the (correct length but mistyped) current password would
    // push elapsed into the hundreds of ms.
    expect(elapsed).toBeLessThan(200);
  });

  test("new !== confirm → 400 password_mismatch", async () => {
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      new_password: "user-chosen-strong-passphrase",
      new_password_confirm: "user-chosen-strong-passphraze", // typo
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("do not match");
  });

  test("new === current → 400 password_unchanged (after verify-current passes)", async () => {
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "same-old-password");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "same-old-password",
      new_password: "same-old-password",
      new_password_confirm: "same-old-password",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("differ from your current");
  });

  test("missing required field → 400", async () => {
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "old-default-pw",
      // new_password omitted
      new_password_confirm: "long-enough-passphrase",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(400);
  });

  test("re-render after failure keeps the user signed in (no session-clear)", async () => {
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "old-default-pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "wrong",
      new_password: "long-enough-passphrase",
      new_password_confirm: "long-enough-passphrase",
    });
    const req = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(req, { db: harness.db });
    expect(res.status).toBe(401);
    // The error re-renders the page; the failure must not clear the
    // session cookie (the user is still signed in, just typed the wrong
    // current password).
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain("Max-Age=0");
  });

  // hub#282 — per-user rate-limit on /account/change-password.
  // CHANGE_PASSWORD_MAX_ATTEMPTS attempts per CHANGE_PASSWORD_WINDOW_MS;
  // (CHANGE_PASSWORD_MAX_ATTEMPTS+1)th attempt within the window is 429.
  test("rapid wrong-current_password attempts exhaust the bucket and 429 with Retry-After", async () => {
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "correct-pw", {
      passwordChanged: false,
    });
    const buildReq = () => {
      const { body, headers } = formBody({
        [CSRF_FIELD_NAME]: TEST_CSRF,
        current_password: "this-is-wrong",
        new_password: "long-enough-passphrase",
        new_password_confirm: "long-enough-passphrase",
      });
      return new Request("http://hub.test/account/change-password", {
        method: "POST",
        headers: { ...headers, cookie },
        body,
      });
    };
    // First N attempts: wrong current → 401 each (admitted by rate limiter,
    // failed by argon2id verify).
    for (let i = 0; i < CHANGE_PASSWORD_MAX_ATTEMPTS; i++) {
      const r = await handleAccountChangePasswordPost(buildReq(), { db: harness.db });
      expect(r.status).toBe(401);
    }
    // (N+1)th attempt: rate-limit fires before argon2id → 429 + Retry-After.
    const denied = await handleAccountChangePasswordPost(buildReq(), { db: harness.db });
    expect(denied.status).toBe(429);
    const retryAfter = denied.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    const seconds = Number(retryAfter);
    expect(seconds).toBeGreaterThan(0);
    // Window is CHANGE_PASSWORD_WINDOW_MS, so retry-after sits in (0, window].
    expect(seconds).toBeLessThanOrEqual(CHANGE_PASSWORD_WINDOW_MS / 1000);
    // Body should re-render the form with the rate-limit message.
    const html = await denied.text();
    expect(html).toContain("Too many password-change attempts");
  });

  test("rate-limit is per-user: two users have independent buckets", async () => {
    const userA = await sessionCookieFor(harness.db, "user-a", "pw-a", {
      passwordChanged: false,
    });
    const userB = await sessionCookieFor(harness.db, "user-b", "pw-b", {
      passwordChanged: false,
      allowMulti: true,
    });
    const buildReq = (cookie: string) => {
      const { body, headers } = formBody({
        [CSRF_FIELD_NAME]: TEST_CSRF,
        current_password: "wrong",
        new_password: "long-enough-passphrase",
        new_password_confirm: "long-enough-passphrase",
      });
      return new Request("http://hub.test/account/change-password", {
        method: "POST",
        headers: { ...headers, cookie },
        body,
      });
    };
    // Exhaust user-a's bucket.
    for (let i = 0; i < CHANGE_PASSWORD_MAX_ATTEMPTS; i++) {
      await handleAccountChangePasswordPost(buildReq(userA.cookie), { db: harness.db });
    }
    const aDenied = await handleAccountChangePasswordPost(buildReq(userA.cookie), {
      db: harness.db,
    });
    expect(aDenied.status).toBe(429);
    // user-b's bucket is untouched — first attempt should be admitted
    // (and reject for wrong current → 401, not 429).
    const bAttempt = await handleAccountChangePasswordPost(buildReq(userB.cookie), {
      db: harness.db,
    });
    expect(bAttempt.status).toBe(401);
  });

  test("rate-limit gate fires before argon2id verify (denied request is fast)", async () => {
    // Pin the "fires before verifyPassword" property with an elapsed-time
    // floor on the 429 response — argon2id verify would push elapsed
    // into the hundreds of ms; the 429 path skips it.
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "correct-pw", {
      passwordChanged: false,
    });
    const buildReq = () => {
      const { body, headers } = formBody({
        [CSRF_FIELD_NAME]: TEST_CSRF,
        current_password: "wrong",
        new_password: "long-enough-passphrase",
        new_password_confirm: "long-enough-passphrase",
      });
      return new Request("http://hub.test/account/change-password", {
        method: "POST",
        headers: { ...headers, cookie },
        body,
      });
    };
    // Fill the bucket.
    for (let i = 0; i < CHANGE_PASSWORD_MAX_ATTEMPTS; i++) {
      await handleAccountChangePasswordPost(buildReq(), { db: harness.db });
    }
    // The (N+1)th attempt should 429-and-return without touching argon2id.
    const t0 = Date.now();
    const denied = await handleAccountChangePasswordPost(buildReq(), { db: harness.db });
    const elapsed = Date.now() - t0;
    expect(denied.status).toBe(429);
    // 200ms is enough headroom even on a noisy runner; an argon2id verify
    // would push elapsed into the hundreds of ms.
    expect(elapsed).toBeLessThan(200);
  });

  test("CSRF failure does NOT burn a rate-limit slot", async () => {
    // Gate-order invariant: rate-limit fires *after* CSRF, so a junk
    // cross-site POST (which would never have a valid CSRF token) doesn't
    // burn a bucket slot for the victim's session. Pin by sending
    // (max+1) CSRF-broken requests and then confirming a fresh, valid
    // attempt is admitted (would-be 401 for wrong current_password, not
    // 429).
    const { cookie } = await sessionCookieFor(harness.db, "newbie", "correct-pw", {
      passwordChanged: false,
    });
    const csrfBroken = () => {
      const { body, headers } = formBody({
        [CSRF_FIELD_NAME]: "wrong-token",
        current_password: "wrong",
        new_password: "long-enough-passphrase",
        new_password_confirm: "long-enough-passphrase",
      });
      return new Request("http://hub.test/account/change-password", {
        method: "POST",
        headers: { ...headers, cookie },
        body,
      });
    };
    for (let i = 0; i < CHANGE_PASSWORD_MAX_ATTEMPTS + 2; i++) {
      const r = await handleAccountChangePasswordPost(csrfBroken(), { db: harness.db });
      expect(r.status).toBe(400);
    }
    // Now send a CSRF-valid attempt — should NOT be 429 (CSRF-broken
    // attempts never reached the rate limiter).
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      current_password: "wrong",
      new_password: "long-enough-passphrase",
      new_password_confirm: "long-enough-passphrase",
    });
    const valid = new Request("http://hub.test/account/change-password", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAccountChangePasswordPost(valid, { db: harness.db });
    expect(res.status).toBe(401);
  });
});

describe("markPasswordChanged", () => {
  test("flips password_changed from 0 to 1 and bumps updated_at", async () => {
    const user = await createUser(harness.db, "newbie", "pw", { passwordChanged: false });
    const before = getUserById(harness.db, user.id);
    expect(before?.passwordChanged).toBe(false);
    const beforeStamp = before?.updatedAt ?? "";
    // Pin the clock so the assertion is deterministic.
    const fixed = new Date(Date.parse(beforeStamp) + 1000);
    markPasswordChanged(harness.db, user.id, () => fixed);
    const after = getUserById(harness.db, user.id);
    expect(after?.passwordChanged).toBe(true);
    expect(after?.updatedAt).toBe(fixed.toISOString());
  });

  test("idempotent — running against an already-true row stays true", async () => {
    const user = await createUser(harness.db, "admin", "pw", { passwordChanged: true });
    markPasswordChanged(harness.db, user.id);
    const after = getUserById(harness.db, user.id);
    expect(after?.passwordChanged).toBe(true);
  });
});

describe("handleAccountHomeGet", () => {
  // Integration smoke for `GET /account/` — verifies session gating
  // (302 → /login when missing) and the happy path (200 + rendered HTML
  // with the user's vault). The pure-renderer assertions live in
  // `account-home-ui.test.ts`; this suite pins handler-level wiring.

  const HUB_ORIGIN = "https://hub.test";

  test("302 → /login when no session cookie is present", async () => {
    const req = new Request(`${HUB_ORIGIN}/account/`);
    const res = await handleAccountHomeGet(req, { db: harness.db, hubOrigin: HUB_ORIGIN });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    // Round-trip /account/ as the `next` param so post-login lands back.
    expect(location).toBe(`/login?next=${encodeURIComponent("/account/")}`);
  });

  test("200 + HTML for a signed-in friend with an assigned vault", async () => {
    // Create the admin first (so the friend is NOT the first admin),
    // then a friend with an assigned vault.
    await createUser(harness.db, "admin", "admin-passphrase", { passwordChanged: true });
    const friend = await createUser(harness.db, "alice", "alice-passphrase", {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: ["alice"],
    });
    const session = createSession(harness.db, { userId: friend.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
    const req = new Request(`${HUB_ORIGIN}/account/`, { headers: { cookie } });
    const res = await handleAccountHomeGet(req, { db: harness.db, hubOrigin: HUB_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Welcome, alice");
    // Vault name visible.
    expect(html).toContain("<strong>alice</strong>");
    // Notes CTA carries the hub-origin-encoded vault URL.
    const encoded = encodeURIComponent(`${HUB_ORIGIN}/vault/alice`);
    expect(html).toContain(`https://notes.parachute.computer/add?url=${encoded}`);
  });

  test("200 + admin branch when the first-admin signs in (no vault assignments)", async () => {
    // The first-created user with no vault pin is the admin posture.
    const admin = await createUser(harness.db, "admin", "admin-passphrase", {
      passwordChanged: true,
    });
    const session = createSession(harness.db, { userId: admin.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
    const req = new Request(`${HUB_ORIGIN}/account/`, { headers: { cookie } });
    const res = await handleAccountHomeGet(req, { db: harness.db, hubOrigin: HUB_ORIGIN });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Welcome, admin");
    expect(html).toContain("hub administrator");
    expect(html).toContain('href="/admin/"');
  });

  test("302 → /login when the session points at a deleted user", async () => {
    // Stale-session shape: a session row outlives its user. The handler
    // hands back to /login rather than rendering against null.
    //
    // Construction note: `deleteUser` drops the session as part of its
    // cleanup transaction, and the sessions.user_id FK is RESTRICT, so
    // we briefly drop FK enforcement to fabricate the orphan-session
    // shape. The handler's job is robustness against an externally-
    // induced orphan (e.g. a race between session-read and user-delete
    // on a different connection); the test exercises that defensive
    // branch directly.
    const user = await createUser(harness.db, "ghost", "ghost-passphrase", {
      passwordChanged: true,
    });
    const session = createSession(harness.db, { userId: user.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
    harness.db.exec("PRAGMA foreign_keys = OFF");
    try {
      harness.db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
    } finally {
      harness.db.exec("PRAGMA foreign_keys = ON");
    }
    const req = new Request(`${HUB_ORIGIN}/account/`, { headers: { cookie } });
    const res = await handleAccountHomeGet(req, { db: harness.db, hubOrigin: HUB_ORIGIN });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  test("renders the per-vault usage stat when usage resolves", async () => {
    await createUser(harness.db, "admin", "admin-passphrase", { passwordChanged: true });
    const friend = await createUser(harness.db, "alice", "alice-passphrase", {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: ["alice"],
    });
    const session = createSession(harness.db, { userId: friend.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
    const req = new Request(`${HUB_ORIGIN}/account/`, { headers: { cookie } });
    const res = await handleAccountHomeGet(req, {
      db: harness.db,
      hubOrigin: HUB_ORIGIN,
      resolveVaultPort: () => 1940,
      // Stub the fetch: resolves to a known stat.
      fetchUsage: async () => ({ notes: 7, totalBytes: 2 * 1024 * 1024 }),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="vault-usage"');
    expect(html).toContain("7 notes · 2.0 MB");
  });

  test("omits the usage stat gracefully when the fetch fails (null)", async () => {
    await createUser(harness.db, "admin", "admin-passphrase", { passwordChanged: true });
    const friend = await createUser(harness.db, "alice", "alice-passphrase", {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: ["alice"],
    });
    const session = createSession(harness.db, { userId: friend.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
    const req = new Request(`${HUB_ORIGIN}/account/`, { headers: { cookie } });
    const res = await handleAccountHomeGet(req, {
      db: harness.db,
      hubOrigin: HUB_ORIGIN,
      resolveVaultPort: () => 1940,
      fetchUsage: async () => null,
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Tile still renders; just no usage stat.
    expect(html).toContain("<strong>alice</strong>");
    expect(html).not.toContain('data-testid="vault-usage"');
  });

  test("renders the 'Configure / back up this vault ↗' deep-link button for an assigned vault", async () => {
    await createUser(harness.db, "admin", "admin-passphrase", { passwordChanged: true });
    const friend = await createUser(harness.db, "alice", "alice-passphrase", {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: ["alice"],
    });
    const session = createSession(harness.db, { userId: friend.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
    const req = new Request(`${HUB_ORIGIN}/account/`, { headers: { cookie } });
    const res = await handleAccountHomeGet(req, { db: harness.db, hubOrigin: HUB_ORIGIN });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="vault-admin-button"');
    expect(html).toContain('action="/account/vault-admin-token/alice"');
  });
});
