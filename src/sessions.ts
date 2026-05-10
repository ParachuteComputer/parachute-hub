/**
 * Browser sessions for the `/oauth/authorize` login + consent flow. The hub
 * sets a session cookie when the user signs in; subsequent authorize requests
 * with that cookie skip the login form and go straight to consent.
 *
 * Stored in `sessions` (one row per active session), so logout / forced
 * revocation is just a delete. Cookies are 24h; sliding extension is a
 * follow-up — for now, a session expires absolutely at `expires_at`.
 *
 * The cookie value is the session id directly. It's a 32-byte base64url
 * random; collision is statistically impossible. No HMAC needed because the
 * value is already opaque to the client and only ever compared to a row in
 * the DB.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "parachute_hub_session";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

interface Row {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

function rowToSession(r: Row): Session {
  return {
    id: r.id,
    userId: r.user_id,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  };
}

export interface CreateSessionOpts {
  userId: string;
  now?: () => Date;
}

export function createSession(db: Database, opts: CreateSessionOpts): Session {
  const id = randomBytes(32).toString("base64url");
  const now = opts.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    opts.userId,
    expiresAt,
    createdAt,
  );
  return { id, userId: opts.userId, expiresAt, createdAt };
}

/**
 * Returns the session row if it exists and isn't expired; otherwise null.
 * Caller is expected to use this to gate the consent screen — no session
 * means show the login form.
 */
export function findSession(
  db: Database,
  id: string,
  now: () => Date = () => new Date(),
): Session | null {
  const row = db.query<Row, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!row) return null;
  const session = rowToSession(row);
  if (now().getTime() > new Date(session.expiresAt).getTime()) return null;
  return session;
}

export function deleteSession(db: Database, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/**
 * Build a `Set-Cookie` header value for the given session id. HttpOnly +
 * SameSite=Lax + Secure (we always assume a TLS terminator; localhost dev
 * still sets Secure because Tailscale serves with HTTPS even on the tailnet
 * mount). Path=/ covers the whole hub origin: the operator's session is "logged
 * into this hub", and admin pages outside /oauth/ (config portal, etc.) ride
 * the same session. State-changing admin POSTs require a CSRF token (see
 * src/csrf.ts) since SameSite=Lax alone doesn't prevent same-site CSRF.
 */
export function buildSessionCookie(sessionId: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) return rest.join("=");
  }
  return null;
}

/**
 * Returns the active (un-expired) session for this request, or null. The
 * canonical "is the operator logged in to this hub?" check — combines
 * `parseSessionCookie` + `findSession` (which already enforces expiry) so
 * callers don't repeat the parse+find+null-check dance.
 *
 * Caller decides what to do on null — admin pages redirect to
 * `/login?next=<path>`, OAuth's DCR endpoint falls through to
 * status=`pending` (closes #199).
 */
export function findActiveSession(
  db: Database,
  req: Request,
  now: () => Date = () => new Date(),
): Session | null {
  const sid = parseSessionCookie(req.headers.get("cookie"));
  return sid ? findSession(db, sid, now) : null;
}
