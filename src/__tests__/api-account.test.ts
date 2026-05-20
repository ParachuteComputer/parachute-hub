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
  markPasswordChanged,
} from "../api-account.ts";
import { CSRF_COOKIE_NAME, CSRF_FIELD_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
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

  test("missing next defaults to /admin/vaults", async () => {
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
