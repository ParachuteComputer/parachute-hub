/**
 * Browser sessions for the `/oauth/authorize` login + consent flow. The hub
 * sets a session cookie when the user signs in; subsequent authorize requests
 * with that cookie skip the login form and go straight to consent.
 *
 * Stored in `sessions` (one row per active session), so logout / forced
 * revocation is just a delete. Sessions are ROLLING (hub-parity P1, Q4 —
 * adopts cloud's posture): `expires_at` starts at `created_at + SESSION_TTL_MS`
 * (90 days), and {@link touchSession} pushes it forward on genuine activity
 * (the admin SPA re-mints `/admin/host-admin-token` every ~10 min while a tab
 * is open; `GET /account/session`, the app's boot/poll oracle, slides once it
 * crosses {@link SESSION_SLIDE_THRESHOLD_MS} of its life — see
 * `account-session.ts`). There is NO absolute ceiling: an ACTIVELY-used
 * session rolls forward indefinitely, while an idle one (no more touches)
 * still lapses at the 90-day mark. Was 24h sliding / 30d hard cap through
 * 2026-07; the cap is gone. The ONLY thing that terminates a session row today
 * is logout (which deletes it). Note what does NOT: the admin screen-lock gates
 * token MINTS (it does not touch or expire the session row), and per-user
 * session revocation does not exist yet (P6-era). So an actively-used session
 * — including a stolen cookie — currently lives on until 90 idle days or an
 * explicit logout; a per-user revoke lever is the standing gap to close.
 *
 * The cookie value is the session id directly. It's a 32-byte base64url
 * random; collision is statistically impossible. No HMAC needed because the
 * value is already opaque to the client and only ever compared to a row in
 * the DB.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "parachute_hub_session";
/**
 * Session lifetime — 90 days (hub-parity P1, Q4: adopts cloud's rolling
 * posture). A session (and its cookie Max-Age) lasts 90 days from its last
 * slide; {@link findSession} still expires it hard past this, and logout
 * deletes the row outright. Was 24h (sliding, 30d hard cap) prior to this PR.
 */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Roll a session forward once it has been used past this much of its life
 * (30 days) — so an ACTIVE session stays alive indefinitely, while an idle one
 * still expires at the full 90-day TTL. Callers that slide on every touch
 * (the admin SPA's host-admin-token re-mint) don't need this threshold; it's
 * for a POLLING caller like `GET /account/session` (the app's `/check-email`
 * screen hits it every few seconds) that must NOT rewrite the row on every
 * request — see `shouldSlideSession` there. Mirrors cloud's
 * `SESSION_REFRESH_THRESHOLD_MS` (`workers/identity/src/sessions.ts`).
 */
export const SESSION_SLIDE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

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
 * Slide a session's expiry forward to `now + SESSION_TTL_MS`. No-op when the
 * session doesn't exist. NO ceiling (hub-parity P1, Q4) — cloud's posture,
 * adopted here: an ACTIVELY-used session rolls forward forever; a closed tab
 * / idle client (no more touches) still expires `SESSION_TTL_MS` after its
 * last activity. The old absolute cap (`SESSION_MAX_LIFETIME_MS`, 30d) is
 * removed — the bounds on a rolling session are logout, the admin
 * screen-lock, and (P6-era) per-user delete, not a lifetime ceiling.
 *
 * This is what makes sessions sliding rather than fixed-TTL: the admin SPA
 * re-mints `/admin/host-admin-token` roughly every ~10 min while a tab is
 * open, and each successful mint calls this unconditionally; `GET
 * /account/session` (the app's boot/poll oracle) instead calls this only
 * past `SESSION_SLIDE_THRESHOLD_MS` of remaining life (bounded slide — see
 * `account-session.ts`), since it's polled every few seconds and an
 * unconditional touch there would rewrite the row on every poll.
 *
 * Monotonic in practice: the production wall clock only moves forward, so the
 * slid value never undershoots a previously-written expiry. (The write is
 * unconditional — it does not read the current expiry — so an injected
 * backward `now` in tests would shorten the session: a conservative failure
 * mode, not a security issue.) `now` is injectable for tests, matching
 * {@link findSession}.
 */
export function touchSession(db: Database, id: string, now: () => Date = () => new Date()): void {
  const row = db.query<Row, [string]>("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!row) return;
  const newExpiresAt = new Date(now().getTime() + SESSION_TTL_MS).toISOString();
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(newExpiresAt, id);
}

export function deleteSession(db: Database, id: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

/**
 * Should this live session be rolled forward? True once it has been used past
 * {@link SESSION_SLIDE_THRESHOLD_MS} of its life — i.e. its remaining life has
 * dropped below `SESSION_TTL_MS - SESSION_SLIDE_THRESHOLD_MS`. A
 * freshly-created/-slid session is NOT slid; one that's crossed the threshold
 * is. Pure — the caller (`account-session.ts`'s bounded slide, the G3 twin of
 * cloud's `shouldSlideSession`) does the write ({@link touchSession}) + cookie
 * re-issue only when this returns true, bounding both to ~once per threshold
 * per session even under frequent polling.
 */
export function shouldSlideSession(session: Session, now: () => Date = () => new Date()): boolean {
  const remainingMs = new Date(session.expiresAt).getTime() - now().getTime();
  return remainingMs < SESSION_TTL_MS - SESSION_SLIDE_THRESHOLD_MS;
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
