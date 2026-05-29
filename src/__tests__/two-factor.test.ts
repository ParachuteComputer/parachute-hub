import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as OTPAuth from "otpauth";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  _resetTotpReplayCache,
  findBackupCodeIndex,
  generateBackupCodes,
  generateTotpSecret,
  normalizeBackupCode,
  verifyTotpCode,
} from "../totp.ts";
import {
  backupCodesRemaining,
  clearEnrollment,
  getTotpState,
  isTotpEnrolled,
  persistEnrollment,
  verifySecondFactor,
} from "../two-factor-store.ts";
import { createUser } from "../users.ts";

/** Generate the current live TOTP code for a base32 secret. */
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

describe("totp — secret + code", () => {
  beforeEach(() => _resetTotpReplayCache());

  test("generateTotpSecret returns a base32 secret + an otpauth:// URI", () => {
    const { secret, otpauthUrl } = generateTotpSecret("alice");
    expect(secret.length).toBeGreaterThan(0);
    expect(/^[A-Z2-7]+$/.test(secret)).toBe(true);
    expect(otpauthUrl.startsWith("otpauth://totp/")).toBe(true);
    expect(otpauthUrl).toContain("Parachute%20Hub");
  });

  test("a live code verifies; a wrong code does not", () => {
    const { secret } = generateTotpSecret("alice");
    expect(verifyTotpCode(secret, liveCode(secret))).toBe(true);
    _resetTotpReplayCache();
    expect(verifyTotpCode(secret, "000000")).toBe(false);
  });

  test("non-6-digit input is rejected without throwing", () => {
    const { secret } = generateTotpSecret("alice");
    expect(verifyTotpCode(secret, "12345")).toBe(false);
    expect(verifyTotpCode(secret, "1234567")).toBe(false);
    expect(verifyTotpCode(secret, "abcdef")).toBe(false);
    expect(verifyTotpCode(secret, "")).toBe(false);
  });

  test("replay: a code accepted once is rejected on the second try (markUsed default)", () => {
    const { secret } = generateTotpSecret("alice");
    const code = liveCode(secret);
    expect(verifyTotpCode(secret, code)).toBe(true);
    expect(verifyTotpCode(secret, code)).toBe(false); // replay rejected
  });
});

describe("totp — backup codes", () => {
  test("generates 10 hyphenated codes + matching argon2id hashes", async () => {
    const { codes, hashes } = await generateBackupCodes();
    expect(codes.length).toBe(10);
    expect(hashes.length).toBe(10);
    for (const c of codes) {
      expect(/^[a-z2-9]{5}-[a-z2-9]{5}$/.test(c)).toBe(true);
    }
    for (const h of hashes) {
      expect(h.startsWith("$argon2")).toBe(true);
    }
  });

  test("findBackupCodeIndex matches a code (hyphen-insensitive) and rejects unknowns", async () => {
    const { codes, hashes } = await generateBackupCodes();
    // Match by normalized form (strip hyphen) and by raw hyphenated form.
    const idx0 = await findBackupCodeIndex(codes[0]!, hashes);
    expect(idx0).toBe(0);
    const idxNorm = await findBackupCodeIndex(normalizeBackupCode(codes[3]!), hashes);
    expect(idxNorm).toBe(3);
    const miss = await findBackupCodeIndex("zzzzz-zzzzz", hashes);
    expect(miss).toBe(-1);
  });
});

describe("two-factor-store", () => {
  let db: Database;
  let configDir: string;
  let userId: string;

  beforeEach(async () => {
    _resetTotpReplayCache();
    configDir = mkdtempSync(join(tmpdir(), "phub-2fa-store-"));
    db = openHubDb(hubDbPath(configDir));
    const u = await createUser(db, "owner", "owner-password-123");
    userId = u.id;
  });
  afterEach(() => {
    db.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("fresh user: not enrolled, no backup codes", () => {
    expect(isTotpEnrolled(db, userId)).toBe(false);
    expect(getTotpState(db, userId).secret).toBeNull();
    expect(backupCodesRemaining(db, userId)).toBe(0);
  });

  test("persistEnrollment stores the secret + 10 backup codes (hashed) + a timestamp", async () => {
    const { secret } = generateTotpSecret("owner");
    const result = await persistEnrollment(db, userId, secret);
    expect(result.backupCodes.length).toBe(10);
    expect(isTotpEnrolled(db, userId)).toBe(true);
    const state = getTotpState(db, userId);
    expect(state.secret).toBe(secret);
    expect(state.backupCodes.length).toBe(10);
    expect(state.enrolledAt).toBeTruthy();
    // Stored codes are hashes, NOT the plaintext returned to the user.
    for (const stored of state.backupCodes) {
      expect(stored.startsWith("$argon2")).toBe(true);
      expect(result.backupCodes).not.toContain(stored);
    }
  });

  test("verifySecondFactor accepts a live TOTP code", async () => {
    const { secret } = generateTotpSecret("owner");
    await persistEnrollment(db, userId, secret);
    const res = await verifySecondFactor(db, userId, liveCode(secret), false);
    expect(res).toEqual({ ok: true, via: "totp" });
  });

  test("verifySecondFactor accepts a backup code ONCE, then rejects its reuse (single-use)", async () => {
    const { secret } = generateTotpSecret("owner");
    const { backupCodes } = await persistEnrollment(db, userId, secret);
    const code = backupCodes[0]!;
    expect(backupCodesRemaining(db, userId)).toBe(10);

    const first = await verifySecondFactor(db, userId, code, false);
    expect(first).toEqual({ ok: true, via: "backup_code" });
    // Consumed: one fewer remaining.
    expect(backupCodesRemaining(db, userId)).toBe(9);

    // Reuse of the same code is rejected.
    const second = await verifySecondFactor(db, userId, code, false);
    expect(second).toEqual({ ok: false });
    expect(backupCodesRemaining(db, userId)).toBe(9);
  });

  test("verifySecondFactor rejects a wrong code without consuming anything", async () => {
    const { secret } = generateTotpSecret("owner");
    await persistEnrollment(db, userId, secret);
    const res = await verifySecondFactor(db, userId, "999999", false);
    expect(res).toEqual({ ok: false });
    expect(backupCodesRemaining(db, userId)).toBe(10);
  });

  test("clearEnrollment removes secret + backup codes (idempotent)", async () => {
    const { secret } = generateTotpSecret("owner");
    await persistEnrollment(db, userId, secret);
    expect(isTotpEnrolled(db, userId)).toBe(true);
    clearEnrollment(db, userId);
    expect(isTotpEnrolled(db, userId)).toBe(false);
    expect(backupCodesRemaining(db, userId)).toBe(0);
    // Idempotent — clearing again is a no-op.
    clearEnrollment(db, userId);
    expect(isTotpEnrolled(db, userId)).toBe(false);
  });

  test("verifySecondFactor on a not-enrolled user returns ok:false", async () => {
    expect(await verifySecondFactor(db, userId, "123456", false)).toEqual({ ok: false });
  });
});
