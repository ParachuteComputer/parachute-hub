/**
 * Tests for the optional admin-UI screen-lock (admin-lock.ts +
 * api-admin-lock.ts) and the lock gate's cascade through the four
 * admin-token mint chokepoints.
 *
 * Coverage map (from the feature brief):
 *   - PIN set / verify / change / remove.
 *   - The gate: locked → host-admin-token mint refused (423); unlocked → mint
 *     works; idle-expired → locked again; cascade to agent/vault/module mints.
 *   - **OAuth path works while the admin session is locked** (the critical
 *     boundary — a surface OAuth'ing in never hits the lock).
 *   - Optional: no PIN → no lock, the mint works exactly as today.
 *   - argon2 hash is never stored plaintext / never in the cookie.
 *   - Brute-force limiter on unlock.
 *   - "Lock now" + heartbeat (idle window slide).
 *   - First-PIN chicken-and-egg + change/remove authorization.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentToken } from "../admin-agent-token.ts";
import { handleHostAdminToken } from "../admin-host-admin-token.ts";
import {
  DEFAULT_ADMIN_LOCK_IDLE_SECONDS,
  _resetUnlockStateForTest,
  clearPin,
  getIdleSeconds,
  isLockConfigured,
  isSessionUnlocked,
  recordLoginUnlock,
  recordUnlock,
  refreshActivity,
  requireUnlocked,
  setIdleSeconds,
  setPin,
  unlockLimiter,
  validatePin,
  verifyPin,
} from "../admin-lock.ts";
import { handleModuleToken } from "../admin-module-token.ts";
import { handleVaultAdminToken } from "../admin-vault-admin-token.ts";
import { handleAdminLock } from "../api-admin-lock.ts";
import { registerClient } from "../clients.ts";
import { CSRF_COOKIE_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { getSetting } from "../hub-settings.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { handleAuthorizePost, handleToken } from "../oauth-handlers.ts";
import type { ServicesManifest } from "../services-manifest.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";
const TEST_CSRF = "csrf-test-token";
const CSRF_COOKIE = `${CSRF_COOKIE_NAME}=${TEST_CSRF}`;
const ORIGIN_HEADERS = { "content-type": "application/json", origin: ISSUER };

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-admin-lock-"));
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
  _resetUnlockStateForTest();
  unlockLimiter.reset();
});
afterEach(() => {
  harness.cleanup();
  _resetUnlockStateForTest();
  unlockLimiter.reset();
});

/** Create the first admin + a session, return { cookie, sessionId, userId }. */
async function withAdmin(): Promise<{ cookie: string; sessionId: string; userId: string }> {
  const user = await createUser(harness.db, "operator", "admin-passphrase");
  const session = createSession(harness.db, { userId: user.id });
  const cookie = `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`;
  return { cookie, sessionId: session.id, userId: user.id };
}

function lockReq(subpath: string, cookie: string, body: Record<string, unknown>): Request {
  return new Request(`${ISSUER}/api/admin-lock${subpath}`, {
    method: "POST",
    headers: { ...ORIGIN_HEADERS, cookie },
    body: JSON.stringify({ __csrf: TEST_CSRF, ...body }),
  });
}

// ---------------------------------------------------------------------------
// Pure module: validate / hash / verify / idle.
// ---------------------------------------------------------------------------

describe("admin-lock pure helpers", () => {
  test("validatePin accepts 4–12 digits, rejects others", () => {
    expect(validatePin("1234").valid).toBe(true);
    expect(validatePin("123456789012").valid).toBe(true);
    expect(validatePin("123").valid).toBe(false); // too short
    expect(validatePin("1234567890123").valid).toBe(false); // too long
    expect(validatePin("12a4").valid).toBe(false); // non-digit
    expect(validatePin("").valid).toBe(false);
  });

  test("setPin stores an argon2id hash — NOT plaintext", async () => {
    await setPin(harness.db, "4827");
    const stored = getSetting(harness.db, "admin_lock_pin_hash");
    expect(stored).toBeDefined();
    expect(stored).not.toBe("4827");
    expect(stored).not.toContain("4827");
    // argon2id hashes carry the canonical $argon2id$ prefix.
    expect(stored?.startsWith("$argon2id$")).toBe(true);
  });

  test("verifyPin matches the set PIN and rejects wrong ones", async () => {
    await setPin(harness.db, "4827");
    expect(await verifyPin(harness.db, "4827")).toBe(true);
    expect(await verifyPin(harness.db, "0000")).toBe(false);
  });

  test("verifyPin returns false when no PIN configured", async () => {
    expect(await verifyPin(harness.db, "anything")).toBe(false);
  });

  test("isLockConfigured tracks set/clear", async () => {
    expect(isLockConfigured(harness.db)).toBe(false);
    await setPin(harness.db, "4827");
    expect(isLockConfigured(harness.db)).toBe(true);
    clearPin(harness.db);
    expect(isLockConfigured(harness.db)).toBe(false);
  });

  test("idle seconds default + clamp", () => {
    expect(getIdleSeconds(harness.db)).toBe(DEFAULT_ADMIN_LOCK_IDLE_SECONDS);
    setIdleSeconds(harness.db, 5); // below min → clamped to 60
    expect(getIdleSeconds(harness.db)).toBe(60);
    setIdleSeconds(harness.db, 999_999); // above max → clamped to 24h
    expect(getIdleSeconds(harness.db)).toBe(24 * 60 * 60);
    setIdleSeconds(harness.db, 1200);
    expect(getIdleSeconds(harness.db)).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// requireUnlocked — the gate logic itself (clock-injected).
// ---------------------------------------------------------------------------

describe("requireUnlocked gate", () => {
  test("feature OFF (no PIN) → always allowed", () => {
    expect(requireUnlocked(harness.db, "sid-1", 1000).ok).toBe(true);
  });

  test("PIN set + no unlock → locked", async () => {
    await setPin(harness.db, "4827");
    expect(requireUnlocked(harness.db, "sid-1", 1000).ok).toBe(false);
  });

  test("PIN set + fresh unlock → allowed; the mint is a PURE CHECK (does NOT slide)", async () => {
    await setPin(harness.db, "4827");
    setIdleSeconds(harness.db, 60);
    const t0 = 1_000_000;
    recordUnlock("sid-1", 60, t0);
    const at30s = t0 + 30_000;
    // A mint at 30s is allowed but must NOT extend the window — only genuine
    // USER activity (the heartbeat) slides it; a background poll's mint shouldn't
    // keep an idle tab alive forever.
    expect(requireUnlocked(harness.db, "sid-1", at30s).ok).toBe(true);
    // Original window was t0 + 60s. The mint didn't move it, so at t0 + 61s it's
    // expired/locked.
    expect(isSessionUnlocked("sid-1", t0 + 61_000)).toBe(false);
  });

  test("refreshActivity (heartbeat) DOES slide the window for an unlocked session", async () => {
    await setPin(harness.db, "4827");
    setIdleSeconds(harness.db, 60);
    const t0 = 1_000_000;
    recordUnlock("sid-1", 60, t0);
    // A heartbeat at 30s re-anchors to 30s + 60s = t0 + 90s.
    refreshActivity("sid-1", 60, t0 + 30_000);
    expect(isSessionUnlocked("sid-1", t0 + 80_000)).toBe(true);
  });

  test("refreshActivity does NOT unlock a locked session (activity ≠ unlock)", async () => {
    await setPin(harness.db, "4827");
    // No unlock recorded → locked. A heartbeat must not create a window.
    refreshActivity("sid-1", 60, 1_000_000);
    expect(isSessionUnlocked("sid-1", 1_000_000)).toBe(false);
  });

  test("PIN set + idle-expired → locked again", async () => {
    await setPin(harness.db, "4827");
    setIdleSeconds(harness.db, 60);
    const t0 = 1_000_000;
    recordUnlock("sid-1", 60, t0);
    // 61s later, with no intervening activity → expired → locked.
    expect(requireUnlocked(harness.db, "sid-1", t0 + 61_000).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordLoginUnlock (Fix B) — unlock at the auth boundary so a fresh login
// doesn't immediately hit the PIN lock screen.
// ---------------------------------------------------------------------------

describe("recordLoginUnlock", () => {
  test("opens an unlock window when a PIN is configured", async () => {
    await setPin(harness.db, "4827");
    // A fresh session with a PIN set but no unlock is locked.
    expect(requireUnlocked(harness.db, "sid-login").ok).toBe(false);
    recordLoginUnlock(harness.db, "sid-login");
    // After login → the freshly-authenticated session is unlocked.
    expect(requireUnlocked(harness.db, "sid-login").ok).toBe(true);
    expect(isSessionUnlocked("sid-login")).toBe(true);
  });

  test("no-op when the lock feature is OFF (no PIN) — records nothing", () => {
    // Feature off → requireUnlocked is always ok anyway; the helper must not
    // record a spurious window (meaningless, and would grow the map).
    recordLoginUnlock(harness.db, "sid-no-pin");
    expect(isSessionUnlocked("sid-no-pin")).toBe(false);
    expect(requireUnlocked(harness.db, "sid-no-pin").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The cascade: a locked session refuses ALL four admin-token mints.
// ---------------------------------------------------------------------------

describe("lock cascade through the four admin-token mints", () => {
  test("host-admin-token: 200 when no PIN, 423 when locked, 200 after unlock", async () => {
    const { cookie, sessionId } = await withAdmin();
    rotateSigningKey(harness.db);
    const mk = () => new Request(`${ISSUER}/admin/host-admin-token`, { headers: { cookie } });

    // No PIN → today's behavior (200).
    expect((await handleHostAdminToken(mk(), { db: harness.db, issuer: ISSUER })).status).toBe(200);

    // Set a PIN → locked → 423.
    await setPin(harness.db, "4827");
    const lockedRes = await handleHostAdminToken(mk(), { db: harness.db, issuer: ISSUER });
    expect(lockedRes.status).toBe(423);
    expect(((await lockedRes.json()) as { error: string }).error).toBe("locked");

    // Unlock → 200.
    recordUnlock(sessionId, getIdleSeconds(harness.db));
    expect((await handleHostAdminToken(mk(), { db: harness.db, issuer: ISSUER })).status).toBe(200);
  });

  test("agent-token cascades (423 when locked)", async () => {
    const { cookie } = await withAdmin();
    rotateSigningKey(harness.db);
    await setPin(harness.db, "4827");
    const res = await handleAgentToken(
      new Request(`${ISSUER}/admin/agent-token`, { headers: { cookie } }),
      { db: harness.db, issuer: ISSUER },
    );
    expect(res.status).toBe(423);
  });

  test("vault-admin-token cascades (423 when locked)", async () => {
    const { cookie } = await withAdmin();
    rotateSigningKey(harness.db);
    await setPin(harness.db, "4827");
    const res = await handleVaultAdminToken(
      new Request(`${ISSUER}/admin/vault-admin-token/default`, { headers: { cookie } }),
      "default",
      { db: harness.db, issuer: ISSUER, knownVaultNames: new Set(["default"]) },
    );
    expect(res.status).toBe(423);
  });

  test("module-token cascades (423 when locked)", async () => {
    const { cookie } = await withAdmin();
    rotateSigningKey(harness.db);
    await setPin(harness.db, "4827");
    const res = await handleModuleToken(
      new Request(`${ISSUER}/admin/module-token/scribe`, { headers: { cookie } }),
      "scribe",
      {
        db: harness.db,
        issuer: ISSUER,
        // scribe is a KNOWN bootstrap short — no module.json read needed.
        readServices: () => [],
      },
    );
    expect(res.status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// THE CRITICAL BOUNDARY: OAuth issuance works while the admin UI is locked.
// ---------------------------------------------------------------------------

const FIXTURE_MANIFEST: ServicesManifest = {
  services: [
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/health",
      version: "0.3.0",
    },
  ],
};
function fixtureLoadServicesManifest(): ServicesManifest {
  return FIXTURE_MANIFEST;
}
function makePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("OAuth issuer is unaffected by the admin lock", () => {
  test("a third-party client completes authorize→token while the admin session is locked", async () => {
    const { db } = harness;
    rotateSigningKey(db);
    const user = await createUser(db, "owner", "owner-passphrase");
    const session = createSession(db, { userId: user.id });

    // Lock the admin surface: set a PIN, leave the admin session locked.
    await setPin(db, "4827");
    // Sanity: the admin token mint IS locked right now.
    const adminMint = await handleHostAdminToken(
      new Request(`${ISSUER}/admin/host-admin-token`, {
        headers: { cookie: buildSessionCookie(session.id, 86400) },
      }),
      { db, issuer: ISSUER },
    );
    expect(adminMint.status).toBe(423);

    // Now run a full OAuth authorization-code + PKCE flow. This must succeed —
    // the lock lives only on the `/admin/*-token` mints, never on `/oauth/*`.
    const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
    const { verifier, challenge } = makePkce();
    const consentForm = new URLSearchParams({
      __action: "consent",
      __csrf: TEST_CSRF,
      approve: "yes",
      client_id: reg.client.clientId,
      redirect_uri: "https://app.example/cb",
      response_type: "code",
      scope: "vault:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      vault_pick: "default",
    });
    const consentRes = await handleAuthorizePost(
      db,
      new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
        },
      }),
      { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
    );
    expect(consentRes.status).toBe(302);
    const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      client_id: reg.client.clientId,
      redirect_uri: "https://app.example/cb",
      code_verifier: verifier,
    });
    const tokenRes = await handleToken(
      db,
      new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: tokenForm,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
    );
    // The OAuth token endpoint issues normally despite the locked admin UI.
    expect(tokenRes.status).toBe(200);
    const body = (await tokenRes.json()) as { access_token: string; scope: string };
    expect(body.scope).toBe("vault:default:read");
    const { payload } = await validateAccessToken(db, body.access_token, ISSUER);
    expect(payload.aud).toBe("vault.default");
  });
});

// ---------------------------------------------------------------------------
// The management API: status, set/change/remove/unlock/lock/heartbeat.
// ---------------------------------------------------------------------------

describe("admin-lock management API", () => {
  test("GET status reflects unconfigured → configured → locked/unlocked", async () => {
    const { cookie, sessionId } = await withAdmin();
    const statusReq = () =>
      new Request(`${ISSUER}/api/admin-lock`, { method: "GET", headers: { cookie } });

    let res = await handleAdminLock(statusReq(), "", { db: harness.db });
    expect(res.status).toBe(200);
    let body = (await res.json()) as { configured: boolean; locked: boolean };
    expect(body).toMatchObject({ configured: false, locked: false });

    await setPin(harness.db, "4827");
    res = await handleAdminLock(statusReq(), "", { db: harness.db });
    body = (await res.json()) as { configured: boolean; locked: boolean };
    expect(body).toMatchObject({ configured: true, locked: true });

    recordUnlock(sessionId, getIdleSeconds(harness.db));
    res = await handleAdminLock(statusReq(), "", { db: harness.db });
    body = (await res.json()) as { configured: boolean; locked: boolean };
    expect(body).toMatchObject({ configured: true, locked: false });
  });

  test("set first PIN → 201; setting again → 409", async () => {
    const { cookie } = await withAdmin();
    const ok = await handleAdminLock(lockReq("/set", cookie, { pin: "4827" }), "/set", {
      db: harness.db,
    });
    expect(ok.status).toBe(201);
    expect(isLockConfigured(harness.db)).toBe(true);
    // hash is not the plaintext.
    expect(getSetting(harness.db, "admin_lock_pin_hash")).not.toContain("4827");

    const again = await handleAdminLock(lockReq("/set", cookie, { pin: "1111" }), "/set", {
      db: harness.db,
    });
    expect(again.status).toBe(409);
  });

  test("set rejects a bad PIN format with 400", async () => {
    const { cookie } = await withAdmin();
    const res = await handleAdminLock(lockReq("/set", cookie, { pin: "ab" }), "/set", {
      db: harness.db,
    });
    expect(res.status).toBe(400);
  });

  test("unlock with correct PIN opens the window; wrong PIN → 401", async () => {
    const { cookie, sessionId } = await withAdmin();
    await setPin(harness.db, "4827");

    const bad = await handleAdminLock(lockReq("/unlock", cookie, { pin: "0000" }), "/unlock", {
      db: harness.db,
    });
    expect(bad.status).toBe(401);
    expect(isSessionUnlocked(sessionId)).toBe(false);

    const good = await handleAdminLock(lockReq("/unlock", cookie, { pin: "4827" }), "/unlock", {
      db: harness.db,
    });
    expect(good.status).toBe(200);
    expect(isSessionUnlocked(sessionId)).toBe(true);
  });

  test("change requires current PIN (or unlocked session)", async () => {
    const { cookie, sessionId } = await withAdmin();
    await setPin(harness.db, "4827");

    // Locked + wrong current_pin → 401.
    const wrong = await handleAdminLock(
      lockReq("/change", cookie, { current_pin: "0000", new_pin: "1111" }),
      "/change",
      { db: harness.db },
    );
    expect(wrong.status).toBe(401);

    // Correct current_pin → 200, and the new PIN verifies.
    const ok = await handleAdminLock(
      lockReq("/change", cookie, { current_pin: "4827", new_pin: "1111" }),
      "/change",
      { db: harness.db },
    );
    expect(ok.status).toBe(200);
    expect(await verifyPin(harness.db, "1111")).toBe(true);
    expect(await verifyPin(harness.db, "4827")).toBe(false);
    // Changing re-opens the window for this session.
    expect(isSessionUnlocked(sessionId)).toBe(true);
  });

  test("change works from an already-unlocked session without current_pin", async () => {
    const { cookie, sessionId } = await withAdmin();
    await setPin(harness.db, "4827");
    recordUnlock(sessionId, getIdleSeconds(harness.db));
    const ok = await handleAdminLock(lockReq("/change", cookie, { new_pin: "1111" }), "/change", {
      db: harness.db,
    });
    expect(ok.status).toBe(200);
    expect(await verifyPin(harness.db, "1111")).toBe(true);
  });

  test("remove requires current PIN; turns the feature OFF", async () => {
    const { cookie } = await withAdmin();
    await setPin(harness.db, "4827");

    const wrong = await handleAdminLock(
      lockReq("/remove", cookie, { current_pin: "0000" }),
      "/remove",
      { db: harness.db },
    );
    expect(wrong.status).toBe(401);
    expect(isLockConfigured(harness.db)).toBe(true);

    const ok = await handleAdminLock(
      lockReq("/remove", cookie, { current_pin: "4827" }),
      "/remove",
      { db: harness.db },
    );
    expect(ok.status).toBe(200);
    expect(isLockConfigured(harness.db)).toBe(false);
  });

  test("lock-now drops the unlock window", async () => {
    const { cookie, sessionId } = await withAdmin();
    await setPin(harness.db, "4827");
    recordUnlock(sessionId, getIdleSeconds(harness.db));
    expect(isSessionUnlocked(sessionId)).toBe(true);

    const res = await handleAdminLock(lockReq("/lock", cookie, {}), "/lock", { db: harness.db });
    expect(res.status).toBe(200);
    expect(isSessionUnlocked(sessionId)).toBe(false);
  });

  test("heartbeat slides the window but does NOT unlock a locked session", async () => {
    const { cookie, sessionId } = await withAdmin();
    await setPin(harness.db, "4827");
    // Locked: heartbeat must not unlock.
    const r1 = await handleAdminLock(lockReq("/heartbeat", cookie, {}), "/heartbeat", {
      db: harness.db,
    });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { locked: boolean }).locked).toBe(true);
    expect(isSessionUnlocked(sessionId)).toBe(false);

    // Unlocked: heartbeat keeps it alive.
    recordUnlock(sessionId, getIdleSeconds(harness.db));
    const r2 = await handleAdminLock(lockReq("/heartbeat", cookie, {}), "/heartbeat", {
      db: harness.db,
    });
    const body2 = (await r2.json()) as { locked: boolean; idle_seconds?: number };
    expect(body2.locked).toBe(false);
    // The heartbeat MUST carry idle_seconds — the client re-anchors its local
    // idle timer from it on every heartbeat. Omitting it poisoned the timer
    // (undefined → NaN → instant re-lock). Regression guard for the PIN
    // re-prompt loop.
    expect(body2.idle_seconds).toBe(getIdleSeconds(harness.db));
  });

  test("unlock brute-force limiter: 6th attempt is 429", async () => {
    const { cookie } = await withAdmin();
    await setPin(harness.db, "4827");
    // 5 wrong attempts are allowed (and fail 401), the 6th is rate-limited.
    for (let i = 0; i < 5; i++) {
      const res = await handleAdminLock(lockReq("/unlock", cookie, { pin: "0000" }), "/unlock", {
        db: harness.db,
      });
      expect(res.status).toBe(401);
    }
    const limited = await handleAdminLock(lockReq("/unlock", cookie, { pin: "0000" }), "/unlock", {
      db: harness.db,
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  test("management endpoints require an admin session (401) and the first-admin (403)", async () => {
    // No session.
    const noSession = await handleAdminLock(
      new Request(`${ISSUER}/api/admin-lock`, { method: "GET" }),
      "",
      { db: harness.db },
    );
    expect(noSession.status).toBe(401);

    // A non-first-admin friend is 403.
    await createUser(harness.db, "operator", "admin-passphrase");
    const friend = await createUser(harness.db, "alice", "alice-passphrase", { allowMulti: true });
    const friendSession = createSession(harness.db, { userId: friend.id });
    const friendCookie = `${CSRF_COOKIE}; ${buildSessionCookie(friendSession.id, 86400)}`;
    const res = await handleAdminLock(
      new Request(`${ISSUER}/api/admin-lock`, { method: "GET", headers: { cookie: friendCookie } }),
      "",
      { db: harness.db },
    );
    expect(res.status).toBe(403);
  });

  test("POST without a CSRF token is rejected (403)", async () => {
    const { cookie } = await withAdmin();
    const res = await handleAdminLock(
      new Request(`${ISSUER}/api/admin-lock/set`, {
        method: "POST",
        headers: { ...ORIGIN_HEADERS, cookie },
        body: JSON.stringify({ pin: "4827" }), // no __csrf
      }),
      "/set",
      { db: harness.db },
    );
    expect(res.status).toBe(403);
  });

  test("the PIN hash never appears in any Set-Cookie header", async () => {
    const { cookie } = await withAdmin();
    const setRes = await handleAdminLock(lockReq("/set", cookie, { pin: "4827" }), "/set", {
      db: harness.db,
    });
    // No cookie is set by lock management at all, and certainly not the hash.
    const hash = getSetting(harness.db, "admin_lock_pin_hash") ?? "";
    expect(setRes.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify([...setRes.headers.entries()])).not.toContain(hash);
    // And the response body never echoes the hash or the PIN.
    const text = await setRes.text();
    expect(text).not.toContain("4827");
    expect(text).not.toContain(hash);
  });
});
