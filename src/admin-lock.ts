/**
 * Optional idle screen-lock for the hub ADMIN UI (phone-style lock).
 *
 * ## What this guards (and what it deliberately doesn't)
 *
 * The hub admin UI is reachable remotely once `parachute expose` is up
 * (Tailscale / Cloudflare). A grabbed or left-logged-in admin browser session
 * is a real risk: the password-login session cookie lasts 24h, so an
 * unattended tab is a standing admin console. This adds an OPTIONAL operator
 * PIN that LOCKS THE WHOLE ADMIN SURFACE — one lock over everything, not
 * per-action gating (per-action would friction-up configuration, which is the
 * dangerous stuff we most want behind the lock anyway). Unlock with the PIN →
 * a frictionless working window; admin activity refreshes it; idle re-locks.
 *
 * THREAT MODEL: this is a WEB/UI-layer guard for the EXPOSED admin portal. It
 * does NOT protect against someone with a SHELL on the box — they read
 * `~/.parachute/operator.token` / the vault DB directly and bypass the hub
 * entirely. That's an OS concern (disk encryption, a locked OS screen, SSH-key
 * hygiene). The lock shuts the *portal* door — the one the internet can reach —
 * which is the point.
 *
 * ## The single chokepoint
 *
 * The admin SPA + every module config UI get their working Bearer from one of
 * the cookie-gated mint endpoints:
 *   - `GET /admin/host-admin-token`        (the SPA's own Bearer)
 *   - `GET /admin/channel-token`           (channel chat + config UIs)
 *   - `GET /admin/vault-admin-token/<name>`(per-vault admin SPA)
 *   - `GET /admin/module-token/<short>`    (generic module config UI Bearer)
 *
 * All four share the exact `parseSessionCookie → findSession → [isFirstAdmin]
 * → signAccessToken` shape. Inserting {@link requireUnlocked} into each makes
 * the lock cascade to EVERY admin surface with no per-module changes: when
 * locked, the mint returns 423 and the relevant UI shows the lock screen / its
 * admin calls fail closed (no Bearer). A surface OAuth'ing in via `/oauth/*`
 * never touches these endpoints, so the OAuth issuer is untouched — see the
 * design note (`design/2026-06-17-admin-ui-lock.md`).
 *
 * ## Unlock state — per-session, in-memory, "unlocked-until"
 *
 * Simplest workable model. A successful PIN unlock records `unlockedUntil` for
 * the session id (the cookie value) in a process-local Map. The session is
 * UNLOCKED iff a future `unlockedUntil` exists; genuine USER activity (the SPA's
 * debounced `/heartbeat`, fired on pointer/key/scroll) slides it forward by the
 * idle window. Token mints do NOT slide it — the SPA polls some endpoints in the
 * background, and letting a poll's re-mint extend the window would keep an
 * idle-but-open tab unlocked forever. LOCKED when:
 *   - no PIN is set → feature OFF, never locked (today's behavior);
 *   - PIN set + no unlock recorded (fresh load / first visit);
 *   - PIN set + the recorded unlock is in the past (idle-expired);
 *   - a hub restart wipes the Map → re-lock (a feature, not a bug).
 *
 * The unlock state is NEVER persisted and NEVER put in the cookie — a stolen
 * cookie alone can't carry an unlocked window; the attacker still needs the
 * PIN. (The cookie already authenticates the password session; the PIN is the
 * second, idle-bounded gate on top.)
 */
import type { Database } from "bun:sqlite";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { deleteSetting, getSetting, setSetting } from "./hub-settings.ts";
import { RateLimiter } from "./rate-limit.ts";

/** Default idle window before a session re-locks. Phone-lock territory. */
export const DEFAULT_ADMIN_LOCK_IDLE_SECONDS = 15 * 60;

/** Clamp on the operator-configurable idle window: 1 min … 24h. */
export const MIN_ADMIN_LOCK_IDLE_SECONDS = 60;
export const MAX_ADMIN_LOCK_IDLE_SECONDS = 24 * 60 * 60;

/**
 * PIN format: 4–12 digits. A numeric PIN is the phone-lock affordance the
 * feature is named for; the real defense is the idle window + brute-force
 * limiter, not PIN entropy (the session is already password-authenticated —
 * this is a second, convenience-grade gate). Operators wanting a full secret
 * use the OS lock / a strong account password; this is the "don't leave the
 * console open on the train" guard.
 */
export const ADMIN_LOCK_PIN_RE = /^[0-9]{4,12}$/;

export type ValidatePinResult = { valid: true } | { valid: false; reason: "format" };

export function validatePin(pin: string): ValidatePinResult {
  return ADMIN_LOCK_PIN_RE.test(pin) ? { valid: true } : { valid: false, reason: "format" };
}

// --- PIN storage (argon2id hash in hub_settings) ---------------------------

/** True iff an admin-lock PIN is configured (feature is ON). */
export function isLockConfigured(db: Database): boolean {
  const h = getSetting(db, "admin_lock_pin_hash");
  return typeof h === "string" && h.length > 0;
}

/**
 * Store (or rotate) the PIN. Hashes with argon2id — the same family the hub
 * already uses for passwords + TOTP backup codes (`@node-rs/argon2`). The
 * caller MUST have validated the PIN format first; this trusts its input.
 */
export async function setPin(db: Database, pin: string): Promise<void> {
  const h = await argonHash(pin);
  setSetting(db, "admin_lock_pin_hash", h);
}

/** Remove the PIN (turn the feature OFF). Idempotent. Also clears idle config. */
export function clearPin(db: Database): void {
  deleteSetting(db, "admin_lock_pin_hash");
  deleteSetting(db, "admin_lock_idle_seconds");
}

/**
 * Verify a submitted PIN against the stored hash. Returns false when no PIN is
 * configured (defensive — callers gate on {@link isLockConfigured} first) or
 * the hash is malformed.
 */
export async function verifyPin(db: Database, pin: string): Promise<boolean> {
  const h = getSetting(db, "admin_lock_pin_hash");
  if (typeof h !== "string" || h.length === 0) return false;
  try {
    return await argonVerify(h, pin);
  } catch {
    // Corrupt/unparseable hash — fail closed.
    return false;
  }
}

// --- idle window config ----------------------------------------------------

/** Read the configured idle window (clamped). Falls back to the default. */
export function getIdleSeconds(db: Database): number {
  const raw = getSetting(db, "admin_lock_idle_seconds");
  if (typeof raw !== "string") return DEFAULT_ADMIN_LOCK_IDLE_SECONDS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_ADMIN_LOCK_IDLE_SECONDS;
  return clampIdleSeconds(n);
}

export function clampIdleSeconds(n: number): number {
  if (n < MIN_ADMIN_LOCK_IDLE_SECONDS) return MIN_ADMIN_LOCK_IDLE_SECONDS;
  if (n > MAX_ADMIN_LOCK_IDLE_SECONDS) return MAX_ADMIN_LOCK_IDLE_SECONDS;
  return Math.floor(n);
}

/** Persist the operator's idle-window choice (clamped). */
export function setIdleSeconds(db: Database, seconds: number): void {
  setSetting(db, "admin_lock_idle_seconds", String(clampIdleSeconds(seconds)));
}

// --- per-session unlock state (in-memory, never persisted) -----------------

/**
 * sessionId → unlockedUntil epoch ms. Process-local; a restart wipes it (which
 * is the re-lock-on-fresh-process behavior we want). Bounded by an
 * opportunistic prune of expired rows on every touch, so an attacker churning
 * session ids can't grow it unboundedly.
 */
const unlockedUntil = new Map<string, number>();

function pruneExpired(now: number): void {
  for (const [sid, until] of unlockedUntil) {
    if (until <= now) unlockedUntil.delete(sid);
  }
}

/**
 * Record a fresh unlock for `sessionId`, valid for `idleSeconds` from now.
 * Called after a successful PIN verify.
 */
export function recordUnlock(
  sessionId: string,
  idleSeconds: number,
  now: number = Date.now(),
): void {
  pruneExpired(now);
  unlockedUntil.set(sessionId, now + idleSeconds * 1000);
}

/**
 * Slide the unlock window forward by `idleSeconds` IF the session is currently
 * unlocked. Called on admin activity (heartbeat + every successful mint) so an
 * actively-used console doesn't lock mid-work. Does NOT create an unlock for a
 * locked session — only an explicit PIN entry can do that.
 */
export function refreshActivity(
  sessionId: string,
  idleSeconds: number,
  now: number = Date.now(),
): void {
  const until = unlockedUntil.get(sessionId);
  if (until === undefined || until <= now) return; // locked — activity doesn't unlock
  unlockedUntil.set(sessionId, now + idleSeconds * 1000);
}

/** Is this session currently within an unlock window? */
export function isSessionUnlocked(sessionId: string, now: number = Date.now()): boolean {
  const until = unlockedUntil.get(sessionId);
  return until !== undefined && until > now;
}

/** Force-lock a session immediately ("Lock now"). Idempotent. */
export function lockSession(sessionId: string): void {
  unlockedUntil.delete(sessionId);
}

/** Remaining unlock seconds for a session (0 when locked). For status UI. */
export function unlockSecondsRemaining(sessionId: string, now: number = Date.now()): number {
  const until = unlockedUntil.get(sessionId);
  if (until === undefined || until <= now) return 0;
  return Math.ceil((until - now) / 1000);
}

/** Test seam: wipe all in-memory unlock state. */
export function _resetUnlockStateForTest(): void {
  unlockedUntil.clear();
}

// --- the gate the four token-mint chokepoints call -------------------------

/**
 * The single lock gate. Returns whether the mint may proceed.
 *
 *   - feature OFF (no PIN) → ALWAYS allow (today's behavior, byte-for-byte).
 *   - feature ON + session unlocked → allow.
 *   - feature ON + session locked → DENY (the caller returns 423 Locked).
 *
 * Deliberately a PURE CHECK — it does NOT slide the idle window. Sliding is
 * driven exclusively by genuine USER activity (the SPA's debounced
 * `/heartbeat`, fired on pointer/key/scroll), NOT by token mints. The SPA polls
 * some endpoints in the background (e.g. the version badge every 30s), and each
 * such poll re-mints a host-admin Bearer; if a mint extended the window, a
 * left-open-but-idle tab would never lock — defeating the whole feature. The
 * heartbeat is the one thing that means "a human is here."
 *
 * `now` is injectable for tests.
 */
export function requireUnlocked(
  db: Database,
  sessionId: string,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: "locked" } {
  if (!isLockConfigured(db)) return { ok: true };
  if (isSessionUnlocked(sessionId, now)) {
    return { ok: true };
  }
  return { ok: false, reason: "locked" };
}

/** RFC-shaped 423 the mint chokepoints return when locked. */
export function lockedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "locked",
      error_description:
        "the admin UI is locked — enter your PIN to unlock (POST /api/admin-lock/unlock)",
    }),
    {
      status: 423,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}

// --- unlock brute-force limiter --------------------------------------------

/**
 * Per-session unlock-attempt limiter. The unlock endpoint is session-gated, so
 * the threat is a compromised session (stolen cookie) grinding argon2id PIN
 * verifications without bound — keyed by session id, same posture as
 * `/account/change-password` (keyed by user). 5 wrong PINs / 5 min is the
 * floor; the idle window + the limiter together are the real defense (the PIN
 * itself is convenience-grade — see the module header).
 */
export const ADMIN_LOCK_UNLOCK_MAX_ATTEMPTS = 5;
export const ADMIN_LOCK_UNLOCK_WINDOW_MS = 5 * 60 * 1000;

export const unlockLimiter = new RateLimiter(
  ADMIN_LOCK_UNLOCK_MAX_ATTEMPTS,
  ADMIN_LOCK_UNLOCK_WINDOW_MS,
);
