import { createHash } from "node:crypto";
/**
 * TOTP (RFC 6238) primitives + single-use backup codes for hub-login 2FA
 * (hub#473). The pure crypto layer — no DB, no HTTP. The persistence layer
 * (`two-factor-store.ts`) reads/writes these against `users` in hub.db; the
 * login + enroll handlers compose both.
 *
 * Approach ported from `parachute-vault/src/two-factor.ts` (the deprecated
 * vault impl), with two deliberate hub-side changes:
 *
 *   - Storage is hub.db's `users` row, not vault's `config.yaml`. That lives
 *     in `two-factor-store.ts`; this file stays storage-agnostic.
 *   - Backup codes are hashed with **argon2id** (`@node-rs/argon2`), the same
 *     hasher hub uses for passwords (`users.ts`), rather than vault's bcrypt.
 *     One hash family across the hub keeps the dependency surface minimal and
 *     matches the brief ("same hash as passwords").
 *
 * TOTP parameters (interop default — what Google Authenticator / 1Password /
 * Authy expect): SHA-1, 6 digits, 30s period. Validation accepts a ±1 window
 * (≈90s effective tolerance) for clock drift. A given (secret, counter) is
 * single-use within its acceptance lifetime — replays inside the window are
 * rejected via an in-memory cache.
 */
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import * as OTPAuth from "otpauth";

/** Issuer label shown in the authenticator app + encoded in the otpauth URI. */
export const TOTP_ISSUER = "Parachute Hub";
/** Number of single-use backup codes minted per enrollment. */
export const BACKUP_CODE_COUNT = 10;
/** Length (characters) of each backup code. */
const BACKUP_CODE_LENGTH = 10;
/** TOTP secret size in bytes (20 = 160 bits, the RFC 6238 / RFC 4226 default). */
const TOTP_SECRET_BYTES = 20;

function makeTotp(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export interface GeneratedSecret {
  /** Base32-encoded secret — show to the user for manual authenticator entry. */
  secret: string;
  /** `otpauth://totp/...` URI — encode as a QR code for scanning. */
  otpauthUrl: string;
}

/**
 * Generate a fresh TOTP secret + its `otpauth://` provisioning URI. `label`
 * is the account label rendered in the authenticator app (typically the
 * username). Does NOT persist anything — the caller stores the returned
 * `secret` only after the user confirms a code (proving the authenticator
 * was set up correctly).
 */
export function generateTotpSecret(label: string): GeneratedSecret {
  const secret = new OTPAuth.Secret({ size: TOTP_SECRET_BYTES }).base32;
  const totp = makeTotp(secret, label);
  return { secret, otpauthUrl: totp.toString() };
}

/** Build the `otpauth://` URI for an existing secret (e.g. re-display during enroll). */
export function otpauthUrlFor(secretBase32: string, label: string): string {
  return makeTotp(secretBase32, label).toString();
}

/**
 * In-memory cache of recently-used TOTP counters, to reject replay inside the
 * ±1 acceptance window. Key = "sha256(secret):counter"; value = expiry ms.
 * Bounded — entries auto-expire ~2 min after their window closes. Process-
 * local (a restart clears it, which is itself fine: the window is 90s).
 */
const usedTotpCounters = new Map<string, number>();

function gcUsedTotp(now: number): void {
  for (const [k, exp] of usedTotpCounters) {
    if (exp < now) usedTotpCounters.delete(k);
  }
}

/**
 * Verify a 6-digit TOTP code against `secretBase32`. Accepts ±1 window
 * (prev / current / next 30s period). A given (secret, counter) is single-use
 * within its acceptance lifetime — replays are rejected.
 *
 * `markUsed`: set false in tests that want to verify the same code twice.
 * Defaults to true in production so a captured code can't be replayed inside
 * its ~90s validity window.
 */
export function verifyTotpCode(secretBase32: string, code: string, markUsed = true): boolean {
  const trimmed = code.trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(trimmed)) return false;
  try {
    const totp = makeTotp(secretBase32, "owner");
    const delta = totp.validate({ token: trimmed, window: 1 });
    if (delta === null) return false;

    const now = Date.now();
    gcUsedTotp(now);
    const counter = Math.floor(now / 30_000) + delta;
    // Hash the secret so the in-memory replay cache never holds the plaintext
    // TOTP secret as a map key (defense in depth against heap dumps / logs).
    const secretHash = createHash("sha256").update(secretBase32).digest("hex");
    const key = `${secretHash}:${counter}`;
    if (usedTotpCounters.has(key)) return false;
    if (markUsed) {
      // Expire the entry a bit after the outer edge of the acceptance window.
      usedTotpCounters.set(key, now + 120_000);
    }
    return true;
  } catch {
    return false;
  }
}

/** Test-only: reset the replay-protection cache between cases. */
export function _resetTotpReplayCache(): void {
  usedTotpCounters.clear();
}

// ---------------------------------------------------------------------------
// Backup codes
// ---------------------------------------------------------------------------

function randomBackupCode(): string {
  // Lowercase alphanumeric minus ambiguous glyphs (0/o, 1/l/i). Read-aloud
  // friendly + unambiguous when typed back in. Formatted as two 5-char groups
  // (`abcde-fghij`) for legibility; the hyphen is cosmetic and stripped on
  // verify so the user can type it with or without.
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(BACKUP_CODE_LENGTH));
  let out = "";
  for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i === 4) out += "-";
  }
  return out;
}

/** Normalize a backup code for hashing / comparison: lowercase, no whitespace, no hyphens. */
export function normalizeBackupCode(code: string): string {
  return code
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "");
}

export interface GeneratedBackupCodes {
  /** Plaintext codes to show the user ONCE (hyphenated for display). */
  codes: string[];
  /** argon2id hashes of the normalized codes — what gets stored. */
  hashes: string[];
}

/**
 * Generate {@link BACKUP_CODE_COUNT} fresh backup codes + their argon2id
 * hashes. The plaintext `codes` are displayed once at enrollment; only the
 * `hashes` are persisted (as a JSON array). Each code is hashed in its
 * normalized form so display-formatting (hyphen) never affects verification.
 */
export async function generateBackupCodes(): Promise<GeneratedBackupCodes> {
  const codes: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const code = randomBackupCode();
    codes.push(code);
    hashes.push(await argonHash(normalizeBackupCode(code)));
  }
  return { codes, hashes };
}

/**
 * Check a submitted backup code against a stored hash list. Returns the
 * **index** of the matching hash (so the caller can splice it out and persist
 * the shorter list — single-use consumption), or `-1` for no match.
 *
 * Pure: does NOT mutate the input list or persist anything. Consumption +
 * persistence is the store layer's job (`two-factor-store.ts`), which holds
 * the DB transaction so verify-then-consume is atomic against concurrent
 * login attempts.
 */
export async function findBackupCodeIndex(
  code: string,
  hashes: readonly string[],
): Promise<number> {
  const normalized = normalizeBackupCode(code);
  if (!normalized) return -1;
  for (let i = 0; i < hashes.length; i++) {
    try {
      if (await argonVerify(hashes[i]!, normalized)) return i;
    } catch {
      // Corrupt / non-argon hash — skip.
    }
  }
  return -1;
}
