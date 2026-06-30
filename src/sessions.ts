/**
 * Browser sessions for the `/oauth/authorize` login + consent flow. The hub
 * sets a session cookie when the user signs in; subsequent authorize requests
 * with that cookie skip the login form and go straight to consent.
 *
 * Stored in `sessions` (one row per active session), so logout / forced
 * revocation is just a delete. Sessions are SLIDING: `expires_at` starts at
 * `created_at + SESSION_TTL_MS`, and {@link touchSession} pushes it forward on
 * genuine activity (the admin SPA re-mints `/admin/host-admin-token` every
 * ~10 min while a tab is open). An idle session — no more mints — still
 * expires at the original 24h mark, and {@link SESSION_MAX_LIFETIME_MS} caps
 * total life so sliding can't keep a left-open tab alive forever.
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

/**
 * Absolute ceiling on a session's total lifetime, independent of sliding
 * renewal. Sliding ({@link touchSession}) keeps an active console signed in,
 * but a left-open-but-idle tab whose background polls keep re-minting must
 * still be force-logged-out eventually — this caps life at
 * `created_at + SESSION_MAX_LIFETIME_MS` so renewal can't extend forever.
 */
export const SESSION_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * Slide a session's expiry forward to `now + SESSION_TTL_MS`, capped at
 * `created_at + SESSION_MAX_LIFETIME_MS`. No-op when the session doesn't exist.
 *
 * This is what makes sessions sliding rather than fixed-24h: the admin SPA
 * re-mints `/admin/host-admin-token` roughly every ~10 min while a tab is open,
 * and each successful mint calls this — so an actively-used console isn't
 * hard-logged-out at the 24h mark, while a closed tab (no more mints) still
 * expires 24h after its last activity. The ceiling bounds a left-open-but-idle
 * tab (background polls keep re-minting) so sliding can't run forever.
 *
 * Monotonic by construction: `now` only moves forward, so the slid value never
 * undershoots a previously-written expiry; once it reaches the ceiling it stays
 * pinned there. `now` is injectable for tests, matching {@link findSession}.
 */
export function touchSession(db: Database, id: string, now: () => Date = () => new Date()): void {
  const row = db.query<Row, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!row) return;
  const nowMs = now().getTime();
  const slidMs = nowMs + SESSION_TTL_MS;
  const ceilingMs = new Date(row.created_at).getTime() + SESSION_MAX_LIFETIME_MS;
  const newExpiresAt = new Date(Math.min(slidMs, ceilingMs)).toISOString();
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(newExpiresAt, id);
}

export function deleteSession(db: Database, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/**
 * Build a `Set-Cookie` header value for the given session id. HttpOnly +
 * SameSite=Lax + Secure (conditional) + Path=/.
 *
 * Path=/ covers the whole hub origin: the operator's session is "logged
 * into this hub", and admin pages outside /oauth/ (config portal, etc.)
 * ride the same session. State-changing admin POSTs require a CSRF token
 * (see src/csrf.ts) since SameSite=Lax alone doesn't prevent same-site
 * CSRF.
 *
 * `Secure` defaults to true (production behind a TLS terminator).
 * Callers minting the cookie for a known-HTTP request — `/login` POST
 * over `http://localhost:1939`, the wizard's account POST same — pass
 * `secure: false` (computed from `isHttpsRequest(req)`) so the
 * browser actually keeps the cookie. Setting `Secure` unconditionally
 * over plain HTTP silently drops the cookie and breaks the very next
 * authenticated request.
 */
export function buildSessionCookie(
  sessionId: string,
  maxAgeSeconds: number,
  opts: { secure?: boolean } = {},
): string {
  const parts = [`${SESSION_COOKIE_NAME}=${sessionId}`, "HttpOnly"];
  if (opts.secure !== false) parts.push("Secure");
  parts.push("SameSite=Lax", "Path=/", `Max-Age=${maxAgeSeconds}`);
  return parts.join("; ");
}

export function buildSessionClearCookie(opts: { secure?: boolean } = {}): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, "HttpOnly"];
  if (opts.secure !== false) parts.push("Secure");
  parts.push("SameSite=Lax", "Path=/", "Max-Age=0");
  return parts.join("; ");
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
