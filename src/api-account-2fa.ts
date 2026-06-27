/**
 * `/api/account/*` — JSON self-service account surfaces for the admin SPA
 * (hub#85). The server-rendered `/account/2fa` + `/account/change-password`
 * pages stay (they work without JS, the friend-facing path); these are the
 * JSON twins the in-`/admin` SPA "My account" page drives.
 *
 *   POST /api/account/2fa/start    → mint a fresh secret + QR + otpauth URL
 *                                     (NOT persisted — confirm seals it)
 *   POST /api/account/2fa/confirm  → verify a live code vs the in-flight
 *                                     secret, persist enrollment, return the
 *                                     backup codes ONCE
 *   POST /api/account/2fa/disable  → verify current password, clear 2FA
 *   POST /api/account/password     → verify current, set new (+ revoke the
 *                                     user's still-active tokens)
 *
 * Auth posture: every endpoint is **self-service** — it acts on the
 * SIGNED-IN user's OWN account (`session.userId`), never a client-supplied
 * user id. ANY authenticated user reaches them (the owner / first-admin is
 * NOT special — same path, no privilege bypass). This is deliberately the
 * `/api/admin-lock` cookie+CSRF posture, NOT the host-admin Bearer posture:
 * a user managing their own credentials shouldn't need (or have) the
 * `parachute:host:admin` scope. Order on every POST:
 *
 *   1. Session cookie (else 401).
 *   2. CSRF double-submit `__csrf` in the JSON body (else 403). Same-origin
 *      belt is applied by the hub-server dispatcher before this runs.
 *   3. Per-action validation.
 *
 * The crypto + persistence is REUSED, never duplicated: secret generation +
 * code verification live in `totp.ts`; enrollment storage lives in
 * `two-factor-store.ts`; password validation + hashing live in `users.ts`.
 * This file is the JSON wire layer only.
 *
 * In-flight-secret model (mirrors the server-rendered flow): `start` returns
 * the secret, the SPA holds it client-side, and `confirm` sends it back with
 * the live code. Nothing is persisted until `confirm` verifies — an abandoned
 * setup leaves zero state.
 */
import type { Database } from "bun:sqlite";
import { hash as argonHash } from "@node-rs/argon2";
import QRCode from "qrcode";
import { verifyCsrfToken } from "./csrf.ts";
import { changePasswordRateLimiter, totpEnrollConfirmRateLimiter } from "./rate-limit.ts";
import { findActiveSession } from "./sessions.ts";
import { generateTotpSecret, otpauthUrlFor, verifyTotpCode } from "./totp.ts";
import {
  clearEnrollment,
  getTotpState,
  isTotpEnrolled,
  persistEnrollment,
} from "./two-factor-store.ts";
import {
  PASSWORD_MAX_LEN,
  type User,
  UserNotFoundError,
  getUserById,
  validatePassword,
  verifyPassword,
} from "./users.ts";

export interface ApiAccount2faDeps {
  db: Database;
  /** Test seam — defaults to the real clock. */
  now?: () => Date;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

/** Resolve the signed-in user, or an error Response (401). Self-only — no id from the client. */
function requireUser(
  db: Database,
  req: Request,
): { ok: true; user: User } | { ok: false; res: Response } {
  const session = findActiveSession(db, req);
  if (!session) {
    return {
      ok: false,
      res: jsonError(401, "unauthenticated", "no session — sign in at /login first"),
    };
  }
  const user = getUserById(db, session.userId);
  if (!user) {
    return {
      ok: false,
      res: jsonError(401, "unauthenticated", "signed-in account no longer exists"),
    };
  }
  return { ok: true, user };
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function checkCsrf(req: Request, body: Record<string, unknown>): boolean {
  const token = typeof body.__csrf === "string" ? body.__csrf : null;
  return verifyCsrfToken(req, token);
}

/**
 * Gate the password-verifying endpoints (`/password`, `/2fa/disable`) before the
 * argon2id `verifyPassword` call — a session-hijack attacker shouldn't get an
 * unbounded grind window against the hash. Keyed by `user.id` (identity is
 * already established by the session) and shares the `changePasswordRateLimiter`
 * bucket (3 attempts / 5 min) with the server-rendered change-password POST, so
 * a single user's argon2id budget is uniform across both surfaces. Returns a 429
 * Response when the bucket is exhausted, else null. Fires AFTER CSRF so a junk
 * cross-site POST can't burn the victim's bucket slot.
 */
function passwordRateLimit(userId: string, now: () => Date): Response | null {
  const gate = changePasswordRateLimiter.checkAndRecord(userId, now());
  if (gate.allowed) return null;
  const retryAfter = gate.retryAfterSeconds ?? 1;
  return json(
    429,
    {
      error: "too_many_attempts",
      error_description: `Too many attempts. Try again in ${retryAfter} seconds.`,
    },
    { "retry-after": String(retryAfter) },
  );
}

/**
 * Router for `/api/account/*`. `subpath` is the path AFTER `/api/account`
 * (e.g. "/2fa/start", "/password"). The hub-server dispatcher slices it.
 *
 * Every route here is a POST (state-changing); the read-side 2FA status the
 * SPA renders comes from `/api/me`'s `two_factor_enabled` field, so there's
 * no GET on this surface.
 */
export async function handleApiAccount(
  req: Request,
  subpath: string,
  deps: ApiAccount2faDeps,
): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");

  const gate = requireUser(deps.db, req);
  if (!gate.ok) return gate.res;
  const user = gate.user;

  const body = await readJsonBody(req);
  if (!checkCsrf(req, body)) {
    return jsonError(403, "csrf_failed", "missing or invalid CSRF token");
  }

  switch (subpath) {
    case "/2fa/start":
      return handleStart(deps.db, user);
    case "/2fa/confirm":
      return handleConfirm(deps, user, body);
    case "/2fa/disable":
      return handleDisable(deps, user, body);
    case "/password":
      return handlePassword(deps, user, body);
    default:
      return jsonError(404, "not_found", `no account route at /api/account${subpath}`);
  }
}

/**
 * POST /api/account/2fa/start — mint a fresh secret + provisioning artifacts.
 * Refuses if already enrolled (disable first to re-enroll) — same guard as
 * the server-rendered `start`. The secret is NOT persisted; the SPA holds it
 * and round-trips it back on confirm.
 */
async function handleStart(db: Database, user: User): Promise<Response> {
  if (isTotpEnrolled(db, user.id)) {
    return jsonError(
      409,
      "already_enrolled",
      "Two-factor is already enabled. Turn it off first to re-enroll.",
    );
  }
  const { secret, otpauthUrl } = generateTotpSecret(user.username);
  // PNG data-URL QR (margin:1 for scanner-friendly quiet zone). The repo
  // already depends on `qrcode`; returning a data-URL lets the SPA render a
  // plain <img> with no new client dependency, and the otpauth URL is
  // returned alongside for manual-entry / copy affordances.
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, errorCorrectionLevel: "M" });
  return json(200, { secret, otpauth_url: otpauthUrl, qr_data_url: qrDataUrl });
}

/** base32 alphabet (A–Z, 2–7) + optional `=` padding, ≥16 chars. Same N1 guard as the HTML flow. */
function isPlausibleBase32Secret(secret: string): boolean {
  return /^[A-Z2-7]+=*$/i.test(secret) && secret.length >= 16;
}

/**
 * POST /api/account/2fa/confirm {secret, code} — verify the live code vs the
 * in-flight secret, persist enrollment, return the backup codes ONCE.
 */
async function handleConfirm(
  deps: ApiAccount2faDeps,
  user: User,
  body: Record<string, unknown>,
): Promise<Response> {
  const secret = typeof body.secret === "string" ? body.secret : "";
  const code = typeof body.code === "string" ? body.code : "";

  if (!secret || !isPlausibleBase32Secret(secret)) {
    return jsonError(400, "setup_expired", "Setup expired or malformed. Start again.");
  }
  // Defensive — a confirm POST against an already-enrolled account.
  if (isTotpEnrolled(deps.db, user.id)) {
    return jsonError(409, "already_enrolled", "Two-factor is already enabled.");
  }
  // Bound a hijacked session grinding the in-flight (client-held) secret. Keyed
  // by user.id, lenient (10/15min) so honest enroll mistypes aren't punished —
  // defense-in-depth (#712). Fires AFTER the format + already-enrolled guards so
  // junk/no-op POSTs don't burn the legit enroller's budget, and BEFORE the
  // code verify so the grind window is actually bounded. A SUCCESSFUL confirm
  // also consumes one slot (checkAndRecord counts every attempt) — harmless,
  // since an enrolled account 409s on any further confirm anyway.
  const confirmLimited = totpEnrollConfirmRateLimiter.checkAndRecord(
    user.id,
    deps.now ? deps.now() : new Date(),
  );
  if (!confirmLimited.allowed) {
    const retryAfter = confirmLimited.retryAfterSeconds ?? 1;
    return json(
      429,
      {
        error: "too_many_attempts",
        error_description: `Too many attempts. Try again in ${retryAfter} seconds.`,
      },
      { "retry-after": String(retryAfter) },
    );
  }
  if (!verifyTotpCode(secret, code)) {
    return jsonError(
      400,
      "invalid_code",
      "That code didn't match. Check your device clock and try the current code.",
    );
  }
  const result = await persistEnrollment(deps.db, user.id, secret, deps.now ?? (() => new Date()));
  // Backup codes are shown ONCE — no-store so the response is never cached.
  return json(200, {
    enrolled: true,
    enrolled_at: result.enrolledAt,
    backup_codes: result.backupCodes,
  });
}

/**
 * POST /api/account/2fa/disable {password} — verify the current password,
 * clear 2FA. Password-gated (same safety as the HTML flow): disabling a
 * second factor with only a session cookie would let a hijacked session
 * strip the very protection that defends the account.
 */
async function handleDisable(
  deps: ApiAccount2faDeps,
  user: User,
  body: Record<string, unknown>,
): Promise<Response> {
  const db = deps.db;
  if (!isTotpEnrolled(db, user.id)) {
    // Idempotent — already off.
    return json(200, { enrolled: false });
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    return jsonError(
      400,
      "password_required",
      "Enter your current password to turn off two-factor.",
    );
  }
  // Cap before argon2id verify (CPU-DoS guard — same posture as /login).
  if (password.length > PASSWORD_MAX_LEN) {
    return jsonError(
      413,
      "password_too_long",
      `Password must be ≤ ${PASSWORD_MAX_LEN} characters.`,
    );
  }
  // Rate-limit before the argon2id verify (a stolen session shouldn't grind).
  const limited = passwordRateLimit(user.id, deps.now ?? (() => new Date()));
  if (limited) return limited;
  const ok = await verifyPassword(user, password);
  if (!ok) {
    return jsonError(401, "invalid_credentials", "That password is incorrect.");
  }
  clearEnrollment(db, user.id);
  return json(200, { enrolled: false });
}

/**
 * POST /api/account/password {current_password, new_password} — JSON twin of
 * the server-rendered `/account/change-password` POST. Same validation +
 * atomic hash-write-and-revoke-tokens as `api-account.ts`, reusing the same
 * `users.ts` validators. Self-only (the signed-in user's own hash).
 *
 * Check order mirrors the HTML handler:
 *   1. fields present (400)
 *   2. current too long → 413 (before argon2id verify)
 *   3. new too long → 413 (before argon2id hash)
 *   4. validatePassword(new) → 400
 *   5. rate-limit (429, before the argon2id verify — same as the HTML twin)
 *   6. verifyPassword(current) → 401
 *   7. new === current → 400 (after verify — see api-account.ts rationale)
 *   8. hash new + UPDATE + revoke tokens (one tx)
 */
async function handlePassword(
  deps: ApiAccount2faDeps,
  user: User,
  body: Record<string, unknown>,
): Promise<Response> {
  const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
  const newPassword = typeof body.new_password === "string" ? body.new_password : "";

  if (!currentPassword || !newPassword) {
    return jsonError(400, "missing_fields", "current_password and new_password are required.");
  }
  if (currentPassword.length > PASSWORD_MAX_LEN) {
    return jsonError(
      413,
      "password_too_long",
      `Current password must be ≤ ${PASSWORD_MAX_LEN} characters.`,
    );
  }
  if (newPassword.length > PASSWORD_MAX_LEN) {
    return jsonError(
      413,
      "password_too_long",
      `New password must be ≤ ${PASSWORD_MAX_LEN} characters.`,
    );
  }
  if (!validatePassword(newPassword).valid) {
    return jsonError(
      400,
      "invalid_password",
      "New password must be at least 12 characters (a passphrase is fine).",
    );
  }
  // Rate-limit before the argon2id verify (a stolen session shouldn't grind
  // the current-password check). Shares the bucket with the HTML twin + the
  // disable endpoint — uniform per-user argon2id budget.
  const limited = passwordRateLimit(user.id, deps.now ?? (() => new Date()));
  if (limited) return limited;
  const currentOk = await verifyPassword(user, currentPassword);
  if (!currentOk) {
    return jsonError(401, "invalid_credentials", "Current password is incorrect.");
  }
  if (newPassword === currentPassword) {
    return jsonError(
      400,
      "password_unchanged",
      "New password must differ from your current password.",
    );
  }

  // Hash OUTSIDE the transaction — argon2id is async and bun:sqlite's
  // `db.transaction()` is sync; an async closure silently breaks atomicity
  // (same constraint api-account.ts documents). Then write the hash, flip
  // `password_changed`, and revoke the user's still-active tokens in one tx.
  const now = deps.now ?? (() => new Date());
  const passwordHash = await argonHash(newPassword);
  const stamp = now().toISOString();
  try {
    deps.db.transaction(() => {
      const result = deps.db
        .prepare(
          "UPDATE users SET password_hash = ?, password_changed = 1, updated_at = ? WHERE id = ?",
        )
        .run(passwordHash, stamp, user.id);
      if (result.changes === 0) throw new UserNotFoundError(user.id);
      deps.db
        .prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(stamp, user.id);
    })();
  } catch (err) {
    if (err instanceof UserNotFoundError) {
      return jsonError(401, "unauthenticated", "The signed-in account no longer exists.");
    }
    throw err;
  }
  return json(200, { ok: true });
}
