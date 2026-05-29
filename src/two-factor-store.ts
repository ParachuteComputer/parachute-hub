/**
 * Persistence for hub-login TOTP 2FA (hub#473). Reads/writes the three
 * `users` columns added in migration v11: `totp_secret`, `totp_backup_codes`
 * (JSON array of argon2id hashes), `totp_enrolled_at`.
 *
 * The pure crypto lives in `totp.ts`; this is the storage seam. The login +
 * enroll handlers compose both. Backup-code consumption is done here inside a
 * DB transaction so verify-then-remove is atomic against concurrent login
 * POSTs (two requests can't both consume the same code).
 */
import type { Database } from "bun:sqlite";
import { findBackupCodeIndex, generateBackupCodes, verifyTotpCode } from "./totp.ts";

export interface TotpState {
  /** Base32 secret, or null if 2FA isn't enrolled for this user. */
  secret: string | null;
  /** argon2id hashes of the remaining single-use backup codes. */
  backupCodes: string[];
  /** ISO-8601 enrollment timestamp, or null. */
  enrolledAt: string | null;
}

interface TotpRow {
  totp_secret: string | null;
  totp_backup_codes: string | null;
  totp_enrolled_at: string | null;
}

function parseBackupCodes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

/**
 * Read a user's TOTP state. Returns `secret: null` (not enrolled) when the
 * row is missing — callers treat "no row" identically to "not enrolled."
 */
export function getTotpState(db: Database, userId: string): TotpState {
  const row = db
    .query<TotpRow, [string]>(
      "SELECT totp_secret, totp_backup_codes, totp_enrolled_at FROM users WHERE id = ?",
    )
    .get(userId);
  if (!row) return { secret: null, backupCodes: [], enrolledAt: null };
  return {
    secret: row.totp_secret && row.totp_secret.length > 0 ? row.totp_secret : null,
    backupCodes: parseBackupCodes(row.totp_backup_codes),
    enrolledAt: row.totp_enrolled_at,
  };
}

/** Cheap "is 2FA on for this user?" check — true iff a non-empty secret is stored. */
export function isTotpEnrolled(db: Database, userId: string): boolean {
  return getTotpState(db, userId).secret !== null;
}

/** Number of unused backup codes remaining for a user. */
export function backupCodesRemaining(db: Database, userId: string): number {
  return getTotpState(db, userId).backupCodes.length;
}

export interface EnrollResult {
  /** Plaintext backup codes — show ONCE; never retrievable after. */
  backupCodes: string[];
  /** Enrollment timestamp persisted on the row. */
  enrolledAt: string;
}

/**
 * Persist a confirmed enrollment: store the (already-verified) secret, mint +
 * store a fresh set of backup-code hashes, stamp `totp_enrolled_at`. Returns
 * the plaintext backup codes for one-time display. Overwrites any prior
 * enrollment (re-enroll rotates the secret + codes).
 *
 * The caller MUST have verified a live code against `secret` before calling
 * this (proves the authenticator was provisioned correctly). The async hash
 * happens before the write (single statement, no transaction needed).
 */
export async function persistEnrollment(
  db: Database,
  userId: string,
  secret: string,
  now: () => Date = () => new Date(),
): Promise<EnrollResult> {
  const { codes, hashes } = await generateBackupCodes();
  const enrolledAt = now().toISOString();
  const result = db
    .prepare(
      `UPDATE users
         SET totp_secret = ?, totp_backup_codes = ?, totp_enrolled_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(secret, JSON.stringify(hashes), enrolledAt, enrolledAt, userId);
  if (result.changes === 0) {
    throw new Error(`persistEnrollment: no user row for id ${userId}`);
  }
  return { backupCodes: codes, enrolledAt };
}

/** Clear all TOTP state for a user (disenroll). Idempotent. */
export function clearEnrollment(
  db: Database,
  userId: string,
  now: () => Date = () => new Date(),
): void {
  const stamp = now().toISOString();
  db.prepare(
    `UPDATE users
       SET totp_secret = NULL, totp_backup_codes = NULL, totp_enrolled_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(stamp, userId);
}

export type SecondFactorResult =
  | { ok: true; via: "totp" }
  | { ok: true; via: "backup_code" }
  | { ok: false };

/**
 * Verify a submitted second factor for a user during login. Tries the TOTP
 * code first; if that fails, tries each stored backup code. On a backup-code
 * match the code is **consumed** — removed from the stored list inside a
 * transaction so a concurrent login can't reuse it.
 *
 * Returns which factor succeeded (for logging / "X backup codes left"
 * messaging) or `{ ok: false }`. A user who isn't enrolled returns `ok:false`
 * — but the login handler only reaches this when `totp_secret` is set, so that
 * path is defensive.
 *
 * `markUsed` is forwarded to {@link verifyTotpCode}'s replay cache (tests set
 * false to reuse a code; production leaves it true).
 */
export async function verifySecondFactor(
  db: Database,
  userId: string,
  submitted: string,
  markUsed = true,
): Promise<SecondFactorResult> {
  const state = getTotpState(db, userId);
  if (!state.secret) return { ok: false };

  const code = submitted.trim();
  if (!code) return { ok: false };

  // TOTP path: a 6-digit numeric is almost certainly a TOTP attempt. Try it
  // first (cheap, no DB write on success beyond the in-memory replay cache).
  if (verifyTotpCode(state.secret, code, markUsed)) {
    return { ok: true, via: "totp" };
  }

  // Backup-code path. Find a matching hash, then consume it transactionally.
  if (state.backupCodes.length === 0) return { ok: false };
  const idx = await findBackupCodeIndex(code, state.backupCodes);
  if (idx < 0) return { ok: false };

  // Consume inside a transaction: re-read the stored list, confirm the code
  // we matched is still present (defends against a concurrent login that
  // consumed it between our read and this write), splice it out, write back.
  let consumed = false;
  db.transaction(() => {
    const fresh = getTotpState(db, userId);
    // The matched hash (by value) must still be in the current list.
    const matchedHash = state.backupCodes[idx]!;
    const freshIdx = fresh.backupCodes.indexOf(matchedHash);
    if (freshIdx < 0) return; // already consumed by a racing request
    const remaining = fresh.backupCodes.filter((_, j) => j !== freshIdx);
    db.prepare("UPDATE users SET totp_backup_codes = ? WHERE id = ?").run(
      JSON.stringify(remaining),
      userId,
    );
    consumed = true;
  })();

  return consumed ? { ok: true, via: "backup_code" } : { ok: false };
}
