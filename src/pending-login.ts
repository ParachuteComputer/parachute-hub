/**
 * Pending-login state for the two-step TOTP login (hub#473).
 *
 * When a user with 2FA enrolled posts a correct username+password to `/login`,
 * we do NOT mint a session yet — the user still has to prove the second
 * factor. We stash the half-authenticated state under an opaque token and hand
 * the browser a short-lived `parachute_hub_pending_login` cookie. The user
 * then posts their TOTP / backup code to `/login/2fa`, which looks up the
 * pending state, verifies the factor, and only then mints the real session.
 *
 * Storage: a process-local Map with per-entry expiry — same posture as the
 * rate-limiter (`rate-limit.ts`). Persistence isn't worth a DB write: the
 * window is 5 minutes, and a process restart simply forces the user to
 * re-enter their password (the password POST is cheap to repeat, and losing
 * an in-flight half-login on restart is fine — no security regression). This
 * also avoids a second schema migration for a 5-minute-lived ephemeral row.
 *
 * The token is a 32-byte base64url random (same shape as a session id), so it
 * is unguessable and opaque to the client. It carries no claims — everything
 * is server-side in the Map.
 */
import { randomBytes } from "node:crypto";
import { isHttpsRequest } from "./request-protocol.ts";

export const PENDING_LOGIN_COOKIE_NAME = "parachute_hub_pending_login";
/** Pending logins are valid for 5 minutes — long enough to open an
 *  authenticator app, short enough to bound a half-authenticated window. */
export const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;

interface PendingLogin {
  userId: string;
  /** The post-2FA redirect target resolved at password-verify time. */
  next: string;
  /** Absolute expiry (ms epoch). */
  expiresAtMs: number;
}

const pending = new Map<string, PendingLogin>();

function gc(nowMs: number): void {
  for (const [token, p] of pending) {
    if (p.expiresAtMs <= nowMs) pending.delete(token);
  }
}

/**
 * Create a pending-login entry and return its opaque token. The caller sets
 * the token as a cookie on the "enter your code" response.
 */
export function createPendingLogin(
  userId: string,
  next: string,
  now: () => Date = () => new Date(),
): string {
  const nowMs = now().getTime();
  gc(nowMs);
  const token = randomBytes(32).toString("base64url");
  pending.set(token, { userId, next, expiresAtMs: nowMs + PENDING_LOGIN_TTL_MS });
  return token;
}

/**
 * Resolve a pending-login token to its state, or null if absent/expired.
 * Does NOT consume — the caller consumes only after the second factor
 * verifies (so a failed 2FA attempt can retry against the same pending login
 * without re-entering the password).
 */
export function getPendingLogin(
  token: string | null,
  now: () => Date = () => new Date(),
): { userId: string; next: string } | null {
  if (!token) return null;
  const nowMs = now().getTime();
  gc(nowMs);
  const p = pending.get(token);
  if (!p) return null;
  if (p.expiresAtMs <= nowMs) {
    pending.delete(token);
    return null;
  }
  return { userId: p.userId, next: p.next };
}

/** Delete a pending-login entry (after successful 2FA, or on cancel). Idempotent. */
export function consumePendingLogin(token: string | null): void {
  if (token) pending.delete(token);
}

/** Test-only: clear all pending logins between cases. */
export function _resetPendingLogins(): void {
  pending.clear();
}

export function buildPendingLoginCookie(token: string, req: Request): string {
  const parts = [`${PENDING_LOGIN_COOKIE_NAME}=${token}`, "HttpOnly"];
  if (isHttpsRequest(req)) parts.push("Secure");
  // Path=/login so the cookie only rides /login and /login/2fa requests.
  parts.push("SameSite=Lax", "Path=/login", `Max-Age=${Math.floor(PENDING_LOGIN_TTL_MS / 1000)}`);
  return parts.join("; ");
}

export function buildPendingLoginClearCookie(req: Request): string {
  const parts = [`${PENDING_LOGIN_COOKIE_NAME}=`, "HttpOnly"];
  if (isHttpsRequest(req)) parts.push("Secure");
  parts.push("SameSite=Lax", "Path=/login", "Max-Age=0");
  return parts.join("; ");
}

export function parsePendingLoginCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === PENDING_LOGIN_COOKIE_NAME) return rest.join("=");
  }
  return null;
}
