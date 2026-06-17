/**
 * Admin screen-lock management API (hub admin-lock feature).
 *
 * All endpoints are session-cookie-gated to the first admin — the same gate
 * the admin-token mints use (`isFirstAdmin`). These manage the lock itself, so
 * they are NOT behind the lock gate (you must be able to unlock + set the PIN
 * even when the surface is locked).
 *
 *   GET  /api/admin-lock           → status { configured, locked, idle_seconds, unlock_seconds_remaining }
 *   POST /api/admin-lock/set       → set the FIRST PIN (no PIN configured yet)
 *   POST /api/admin-lock/change    → rotate PIN (requires current PIN or unlocked session)
 *   POST /api/admin-lock/remove    → turn the feature OFF (requires current PIN or unlocked session)
 *   POST /api/admin-lock/unlock    → verify PIN, open an unlock window
 *   POST /api/admin-lock/lock      → "Lock now" — drop the session's unlock window
 *   POST /api/admin-lock/heartbeat → slide the idle window forward on activity
 *
 * The chicken-and-egg: setting the FIRST PIN is an authenticated admin action
 * (logged-in session, no PIN yet → allowed). Once a PIN exists, change/remove
 * require proving knowledge of the current PIN OR an already-unlocked session
 * (the operator just unlocked, so they hold the PIN — re-typing would be
 * friction). Setting over an existing PIN is rejected (use change).
 *
 * State-changing POSTs additionally require a CSRF token (`__csrf`) — these
 * are JSON endpoints on the same origin as the cookie, and SameSite=Lax alone
 * doesn't stop same-site CSRF (see src/csrf.ts). The SPA sources the token
 * from `/api/me`.
 */
import type { Database } from "bun:sqlite";
import {
  clampIdleSeconds,
  clearPin,
  getIdleSeconds,
  isLockConfigured,
  isSessionUnlocked,
  lockSession,
  recordUnlock,
  refreshActivity,
  setIdleSeconds,
  setPin,
  unlockLimiter,
  unlockSecondsRemaining,
  validatePin,
  verifyPin,
} from "./admin-lock.ts";
import { verifyCsrfToken } from "./csrf.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";

export interface AdminLockDeps {
  db: Database;
  /** Injectable clock for tests. */
  now?: () => Date;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function err(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

/**
 * Resolve the first-admin session for this request, or an error Response.
 * Mirrors the gate the token-mint endpoints apply, so the lock-management
 * surface has the same audience.
 */
function requireAdminSession(
  db: Database,
  req: Request,
): { ok: true; sessionId: string; userId: string } | { ok: false; res: Response } {
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(db, sid) : null;
  if (!session || !sid) {
    return {
      ok: false,
      res: err(401, "unauthenticated", "no admin session — sign in at /login first"),
    };
  }
  if (!isFirstAdmin(db, session.userId)) {
    return {
      ok: false,
      res: err(
        403,
        "not_admin",
        "admin lock management is restricted to the hub admin — your account home is at /account/",
      ),
    };
  }
  return { ok: true, sessionId: sid, userId: session.userId };
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
 * The lock-management router. `subpath` is the path AFTER `/api/admin-lock`
 * (e.g. "" for status, "/unlock", "/set"). The hub-server dispatcher slices it.
 */
export async function handleAdminLock(
  req: Request,
  subpath: string,
  deps: AdminLockDeps,
): Promise<Response> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  // GET status (no body, no CSRF — read-only).
  if (subpath === "" || subpath === "/") {
    if (req.method !== "GET") return err(405, "method_not_allowed", "use GET");
    const gate = requireAdminSession(db, req);
    if (!gate.ok) return gate.res;
    const configured = isLockConfigured(db);
    const nowMs = now().getTime();
    const locked = configured && !isSessionUnlocked(gate.sessionId, nowMs);
    return json(200, {
      configured,
      locked,
      idle_seconds: getIdleSeconds(db),
      unlock_seconds_remaining: configured ? unlockSecondsRemaining(gate.sessionId, nowMs) : 0,
    });
  }

  // Everything below is a POST.
  if (req.method !== "POST") return err(405, "method_not_allowed", "use POST");
  const gate = requireAdminSession(db, req);
  if (!gate.ok) return gate.res;
  const body = await readJsonBody(req);
  if (!checkCsrf(req, body)) {
    return err(403, "csrf_failed", "missing or invalid CSRF token");
  }

  switch (subpath) {
    case "/set":
      return handleSet(db, gate.sessionId, body);
    case "/change":
      return handleChange(db, gate.sessionId, body, now);
    case "/remove":
      return handleRemove(db, gate.sessionId, body, now);
    case "/unlock":
      return handleUnlock(db, gate.sessionId, gate.userId, body, now);
    case "/lock":
      lockSession(gate.sessionId);
      return json(200, { locked: true });
    case "/heartbeat":
      // Slide the idle window forward if (and only if) currently unlocked.
      refreshActivity(gate.sessionId, getIdleSeconds(db), now().getTime());
      return json(200, {
        locked: isLockConfigured(db) && !isSessionUnlocked(gate.sessionId, now().getTime()),
        unlock_seconds_remaining: unlockSecondsRemaining(gate.sessionId, now().getTime()),
      });
    default:
      return err(404, "not_found", `no admin-lock route at /api/admin-lock${subpath}`);
  }
}

/** Optional idle-seconds override from a request body field. Clamped; undefined when absent/invalid. */
function readIdleSeconds(body: Record<string, unknown>): number | undefined {
  const raw = body.idle_seconds;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return clampIdleSeconds(raw);
}

async function handleSet(
  db: Database,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  // Setting the FIRST PIN — refuse if one already exists (use /change).
  if (isLockConfigured(db)) {
    return err(409, "already_configured", "a PIN is already set — use /api/admin-lock/change");
  }
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!validatePin(pin).valid) {
    return err(400, "invalid_pin", "PIN must be 4–12 digits");
  }
  const idle = readIdleSeconds(body);
  if (idle !== undefined) setIdleSeconds(db, idle);
  await setPin(db, pin);
  // Setting the PIN immediately opens an unlock window for this session — the
  // operator who just typed it isn't locked out of their own current session.
  recordUnlock(sessionId, getIdleSeconds(db));
  return json(201, { configured: true, locked: false, idle_seconds: getIdleSeconds(db) });
}

async function handleChange(
  db: Database,
  sessionId: string,
  body: Record<string, unknown>,
  now: () => Date,
): Promise<Response> {
  if (!isLockConfigured(db)) {
    return err(409, "not_configured", "no PIN is set — use /api/admin-lock/set");
  }
  const newPin = typeof body.new_pin === "string" ? body.new_pin : "";
  if (!validatePin(newPin).valid) {
    return err(400, "invalid_pin", "new PIN must be 4–12 digits");
  }
  // Authorize the change: an already-unlocked session OR a correct current PIN.
  const authorized = await authorizeMutation(db, sessionId, body, now);
  if (!authorized.ok) return authorized.res;
  const idle = readIdleSeconds(body);
  if (idle !== undefined) setIdleSeconds(db, idle);
  await setPin(db, newPin);
  // Re-open the unlock window for this session under the new PIN.
  recordUnlock(sessionId, getIdleSeconds(db), now().getTime());
  return json(200, { configured: true, locked: false, idle_seconds: getIdleSeconds(db) });
}

async function handleRemove(
  db: Database,
  sessionId: string,
  body: Record<string, unknown>,
  now: () => Date,
): Promise<Response> {
  if (!isLockConfigured(db)) {
    // Idempotent — already off.
    return json(200, { configured: false, locked: false });
  }
  const authorized = await authorizeMutation(db, sessionId, body, now);
  if (!authorized.ok) return authorized.res;
  clearPin(db);
  // Feature is off now — drop any unlock window (it no longer means anything).
  lockSession(sessionId);
  return json(200, { configured: false, locked: false });
}

/**
 * Shared authorization for change/remove: succeed when the session is already
 * unlocked, OR a correct `current_pin` is supplied. The current-PIN path runs
 * through the same brute-force limiter as /unlock.
 */
async function authorizeMutation(
  db: Database,
  sessionId: string,
  body: Record<string, unknown>,
  now: () => Date,
): Promise<{ ok: true } | { ok: false; res: Response }> {
  if (isSessionUnlocked(sessionId, now().getTime())) return { ok: true };
  const currentPin = typeof body.current_pin === "string" ? body.current_pin : "";
  if (!currentPin) {
    return {
      ok: false,
      res: err(
        401,
        "pin_required",
        "this session is locked — supply current_pin (or unlock first)",
      ),
    };
  }
  // Rate-limit BEFORE the argon2id verify (a stolen cookie shouldn't grind).
  const rl = unlockLimiter.checkAndRecord(sessionId, now());
  if (!rl.allowed) {
    return {
      ok: false,
      res: new Response(
        JSON.stringify({
          error: "too_many_attempts",
          error_description: `too many PIN attempts — retry in ${rl.retryAfterSeconds}s`,
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "retry-after": String(rl.retryAfterSeconds ?? 60),
          },
        },
      ),
    };
  }
  const ok = await verifyPin(db, currentPin);
  if (!ok) return { ok: false, res: err(401, "wrong_pin", "incorrect PIN") };
  return { ok: true };
}

async function handleUnlock(
  db: Database,
  sessionId: string,
  _userId: string,
  body: Record<string, unknown>,
  now: () => Date,
): Promise<Response> {
  if (!isLockConfigured(db)) {
    // No PIN → nothing to unlock; treat as already-open so the SPA proceeds.
    return json(200, { unlocked: true, configured: false, idle_seconds: getIdleSeconds(db) });
  }
  const pin = typeof body.pin === "string" ? body.pin : "";
  // Rate-limit BEFORE the argon2id verify — keyed by session (the session
  // already identifies the actor; a stolen cookie shouldn't get fresh buckets
  // across IPs). The denied attempt still counts toward the bucket so a wrong
  // PIN can't be retried infinitely.
  const rl = unlockLimiter.checkAndRecord(sessionId, now());
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({
        error: "too_many_attempts",
        error_description: `too many PIN attempts — retry in ${rl.retryAfterSeconds}s`,
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "retry-after": String(rl.retryAfterSeconds ?? 60),
        },
      },
    );
  }
  const ok = await verifyPin(db, pin);
  if (!ok) {
    return err(401, "wrong_pin", "incorrect PIN");
  }
  recordUnlock(sessionId, getIdleSeconds(db), now().getTime());
  return json(200, {
    unlocked: true,
    configured: true,
    idle_seconds: getIdleSeconds(db),
    unlock_seconds_remaining: unlockSecondsRemaining(sessionId, now().getTime()),
  });
}
