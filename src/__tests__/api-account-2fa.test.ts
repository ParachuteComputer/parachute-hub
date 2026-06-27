/**
 * `/api/account/*` JSON self-service endpoints (hub#85): password change +
 * 2FA start/confirm/disable. Plus `/api/me`'s `two_factor_enabled` field.
 *
 * Coverage:
 *   - auth: no session → 401; wrong CSRF → 403; self-only (keyed off session)
 *   - password: happy path (hash rotated + tokens revoked); wrong current →
 *     401; too short → 400; mismatch handled client-side (not here); new ===
 *     current → 400; too long → 413
 *   - 2fa start → secret + qr; already-enrolled → 409
 *   - 2fa confirm: round-trip with a live code persists + returns backup codes;
 *     bad code → 400; malformed secret → 400
 *   - 2fa disable: password-gated (wrong → 401), clears enrollment; idempotent
 *   - /api/me reflects two_factor_enabled
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as OTPAuth from "otpauth";
import { handleApiAccount } from "../api-account-2fa.ts";
import { handleApiMe } from "../api-me.ts";
import { CSRF_COOKIE_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { recordTokenMint } from "../jwt-sign.ts";
import { __resetForTests as resetRateLimit } from "../rate-limit.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { _resetTotpReplayCache, generateTotpSecret } from "../totp.ts";
import { isTotpEnrolled, persistEnrollment } from "../two-factor-store.ts";
import { createUser, verifyPassword } from "../users.ts";

const TEST_CSRF = "csrf-account-2fa-token";
const CSRF_COOKIE = `${CSRF_COOKIE_NAME}=${TEST_CSRF}`;

interface Harness {
  db: Database;
  configDir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const configDir = mkdtempSync(join(tmpdir(), "phub-api-account-2fa-"));
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

async function userWithSession(
  db: Database,
  username: string,
  password: string,
): Promise<{ userId: string; cookie: string }> {
  const user = await createUser(db, username, password, { passwordChanged: true });
  const session = createSession(db, { userId: user.id });
  const cookie = `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`;
  return { userId: user.id, cookie };
}

function post(
  subpath: string,
  cookie: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return handleApiAccount(
    new Request(`http://hub.test/api/account${subpath}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    subpath,
    { db: harness.db },
  );
}

function liveCode(secretBase32: string, label = "owner"): string {
  return new OTPAuth.TOTP({
    issuer: "Parachute Hub",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  }).generate();
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
  resetRateLimit();
  _resetTotpReplayCache();
});
afterEach(() => {
  harness.cleanup();
});

describe("/api/account/* — auth posture", () => {
  test("no session → 401", async () => {
    const res = await post("/password", null, {
      __csrf: TEST_CSRF,
      current_password: "x",
      new_password: "y",
    });
    expect(res.status).toBe(401);
  });

  test("wrong CSRF → 403", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/password", cookie, {
      __csrf: "not-the-token",
      current_password: "owner-password-123",
      new_password: "brand-new-passphrase",
    });
    expect(res.status).toBe(403);
  });

  test("unknown subpath → 404", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/bogus", cookie, { __csrf: TEST_CSRF });
    expect(res.status).toBe(404);
  });

  test("GET → 405", async () => {
    const res = await handleApiAccount(
      new Request("http://hub.test/api/account/password", { method: "GET" }),
      "/password",
      { db: harness.db },
    );
    expect(res.status).toBe(405);
  });
});

describe("/api/account/password", () => {
  test("happy path rotates the hash + revokes active tokens", async () => {
    const { userId, cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    // Seed an active token for this user — it should be revoked.
    recordTokenMint(harness.db, {
      jti: "tok-1",
      userId,
      subject: userId,
      clientId: "cli",
      scopes: ["vault:default:read"],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      createdVia: "cli_mint",
    });

    const res = await post("/password", cookie, {
      __csrf: TEST_CSRF,
      current_password: "owner-password-123",
      new_password: "brand-new-passphrase",
    });
    expect(res.status).toBe(200);

    // New password verifies; old does not.
    const row = harness.db
      .query<{ password_hash: string }, [string]>("SELECT password_hash FROM users WHERE id = ?")
      .get(userId);
    expect(row).not.toBeNull();
    const fakeUser = { passwordHash: row!.password_hash } as Parameters<typeof verifyPassword>[0];
    expect(await verifyPassword(fakeUser, "brand-new-passphrase")).toBe(true);
    expect(await verifyPassword(fakeUser, "owner-password-123")).toBe(false);

    // Token revoked.
    const tok = harness.db
      .query<{ revoked_at: string | null }, [string]>("SELECT revoked_at FROM tokens WHERE jti = ?")
      .get("tok-1");
    expect(tok?.revoked_at).not.toBeNull();
  });

  test("wrong current password → 401 invalid_credentials", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/password", cookie, {
      __csrf: TEST_CSRF,
      current_password: "WRONG",
      new_password: "brand-new-passphrase",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_credentials");
  });

  test("new password too short → 400 invalid_password", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/password", cookie, {
      __csrf: TEST_CSRF,
      current_password: "owner-password-123",
      new_password: "short",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_password");
  });

  test("new === current → 400 password_unchanged", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/password", cookie, {
      __csrf: TEST_CSRF,
      current_password: "owner-password-123",
      new_password: "owner-password-123",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("password_unchanged");
  });

  test("missing fields → 400", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/password", cookie, { __csrf: TEST_CSRF });
    expect(res.status).toBe(400);
  });

  test("new password over PASSWORD_MAX_LEN → 413 (before argon2id hash)", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/password", cookie, {
      __csrf: TEST_CSRF,
      current_password: "owner-password-123",
      new_password: "x".repeat(257),
    });
    expect(res.status).toBe(413);
  });

  test("rate-limited after repeated wrong-current attempts → 429", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    // Bucket is 3 attempts / 5 min (CHANGE_PASSWORD_*). Burn 3 wrong-current
    // attempts (each 401), then the 4th is rejected at 429 BEFORE the verify.
    for (let i = 0; i < 3; i++) {
      const r = await post("/password", cookie, {
        __csrf: TEST_CSRF,
        current_password: "WRONG",
        new_password: "brand-new-passphrase",
      });
      expect(r.status).toBe(401);
    }
    const limited = await post("/password", cookie, {
      __csrf: TEST_CSRF,
      current_password: "WRONG",
      new_password: "brand-new-passphrase",
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});

describe("/api/account/2fa start + confirm", () => {
  test("start returns a secret + otpauth_url + qr_data_url", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/2fa/start", cookie, { __csrf: TEST_CSRF });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      secret: string;
      otpauth_url: string;
      qr_data_url: string;
    };
    expect(body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(body.otpauth_url.startsWith("otpauth://totp/")).toBe(true);
    expect(body.qr_data_url.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("start refuses (409) when already enrolled", async () => {
    const { userId, cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    await persistEnrollment(harness.db, userId, generateTotpSecret("owner").secret);
    const res = await post("/2fa/start", cookie, { __csrf: TEST_CSRF });
    expect(res.status).toBe(409);
  });

  test("confirm with a live code persists enrollment + returns backup codes", async () => {
    const { userId, cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const startRes = await post("/2fa/start", cookie, { __csrf: TEST_CSRF });
    const { secret } = (await startRes.json()) as { secret: string };

    const confirmRes = await post("/2fa/confirm", cookie, {
      __csrf: TEST_CSRF,
      secret,
      code: liveCode(secret),
    });
    expect(confirmRes.status).toBe(200);
    const body = (await confirmRes.json()) as { enrolled: boolean; backup_codes: string[] };
    expect(body.enrolled).toBe(true);
    expect(body.backup_codes.length).toBe(10);
    expect(isTotpEnrolled(harness.db, userId)).toBe(true);
  });

  test("confirm with a wrong code → 400 invalid_code (not persisted)", async () => {
    const { userId, cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const startRes = await post("/2fa/start", cookie, { __csrf: TEST_CSRF });
    const { secret } = (await startRes.json()) as { secret: string };
    const res = await post("/2fa/confirm", cookie, {
      __csrf: TEST_CSRF,
      secret,
      code: "000000",
    });
    expect(res.status).toBe(400);
    expect(isTotpEnrolled(harness.db, userId)).toBe(false);
  });

  test("confirm with a malformed secret → 400 setup_expired", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/2fa/confirm", cookie, {
      __csrf: TEST_CSRF,
      secret: "not-base32!!",
      code: "123456",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("setup_expired");
  });
});

describe("/api/account/2fa/disable", () => {
  test("password-gated: wrong password → 401, enrollment intact", async () => {
    const { userId, cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    await persistEnrollment(harness.db, userId, generateTotpSecret("owner").secret);
    const res = await post("/2fa/disable", cookie, {
      __csrf: TEST_CSRF,
      password: "WRONG",
    });
    expect(res.status).toBe(401);
    expect(isTotpEnrolled(harness.db, userId)).toBe(true);
  });

  test("correct password clears enrollment", async () => {
    const { userId, cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    await persistEnrollment(harness.db, userId, generateTotpSecret("owner").secret);
    const res = await post("/2fa/disable", cookie, {
      __csrf: TEST_CSRF,
      password: "owner-password-123",
    });
    expect(res.status).toBe(200);
    expect(isTotpEnrolled(harness.db, userId)).toBe(false);
  });

  test("idempotent when already off", async () => {
    const { cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    const res = await post("/2fa/disable", cookie, {
      __csrf: TEST_CSRF,
      password: "owner-password-123",
    });
    expect(res.status).toBe(200);
  });

  test("missing password → 400", async () => {
    const { userId, cookie } = await userWithSession(harness.db, "owner", "owner-password-123");
    await persistEnrollment(harness.db, userId, generateTotpSecret("owner").secret);
    const res = await post("/2fa/disable", cookie, { __csrf: TEST_CSRF });
    expect(res.status).toBe(400);
  });
});

describe("/api/me — two_factor_enabled", () => {
  test("false when not enrolled, true after enrollment", async () => {
    const user = await createUser(harness.db, "owner", "owner-password-123", {
      passwordChanged: true,
    });
    const session = createSession(harness.db, { userId: user.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));

    const before = await handleApiMe(
      new Request("http://hub.test/api/me", { headers: { cookie } }),
      { db: harness.db },
    );
    const beforeBody = (await before.json()) as { two_factor_enabled?: boolean };
    expect(beforeBody.two_factor_enabled).toBe(false);

    await persistEnrollment(harness.db, user.id, generateTotpSecret("owner").secret);

    const after = await handleApiMe(
      new Request("http://hub.test/api/me", { headers: { cookie } }),
      { db: harness.db },
    );
    const afterBody = (await after.json()) as { two_factor_enabled?: boolean };
    expect(afterBody.two_factor_enabled).toBe(true);
  });
});
