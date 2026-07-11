/**
 * `GET /account/session` — the same-origin boot oracle (hub-parity P1; the
 * hub's twin of cloud `account-session.ts`). Returns `{ signed_in, csrf, ... }`
 * so the same-origin `parachute-app` — served at the hub's own origin — can
 * (a) decide whether to render the signed-in UI or the sign-in ceremony, and
 * (b) echo `csrf` back as `__csrf` on its next same-origin `POST /account/token`
 * mint (C2). The CSRF cookie is `HttpOnly` (csrf.ts), so the SPA can't read it
 * directly; this hands the token over the same way a server-rendered form's
 * hidden input does.
 *
 * PUBLIC — no Bearer, no scope gate. It drives the `parachute_hub_session`
 * cookie directly, same as `/api/me`: a client with no account Bearer yet has
 * nothing else to authenticate a read with, and this endpoint IS the
 * bootstrap. Mounted ABOVE the force-change-password gate (hub-server.ts
 * CHOKE POINT 1) — it's a pure state oracle, not a mutating surface, so a
 * pre-rotation user must still be able to read it (the app needs `signed_in` +
 * `csrf` to drive the rotation ceremony itself, not get walled off before it
 * can even ask). `POST /account/token` stays BELOW the gate — a pre-rotation
 * user hits its 403 `force_change_password` there, and the app is expected to
 * weather that (P4).
 *
 * SAME-ORIGIN ONLY, by design — mirrors cloud's posture exactly: the response
 * is CREDENTIALED (it reflects the session cookie and sets the CSRF cookie),
 * so it carries NO CORS headers. A cross-origin caller simply gets no
 * `access-control-allow-origin`, so the browser blocks it from reading the
 * body — intended, not an oversight.
 */
import type { Database } from "bun:sqlite";
import { ensureCsrfToken } from "./csrf.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import {
  SESSION_TTL_MS,
  buildSessionCookie,
  findActiveSession,
  shouldSlideSession,
  touchSession,
} from "./sessions.ts";
import { getUserById } from "./users.ts";

export interface AccountSessionDeps {
  db: Database;
}

/** Matches the `/account/*` 405 shape (`account-api.ts`'s `methodNotAllowed`)
 * — same `{error, message}` body + `Allow` header, kept local to this file
 * per the one-handler-one-file convention (`api-me.ts`, `account-token.ts`). */
function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed", message: `use ${allow}` }), {
    status: 405,
    headers: { "content-type": "application/json", allow },
  });
}

/**
 * A credentialed JSON reply that can carry MULTIPLE Set-Cookie headers (the
 * CSRF mint and the session slide's re-issue can coincide — a plain
 * `Record`-keyed header init can't hold two `set-cookie` values). NO CORS
 * headers (see the module note); `no-store` so a back/forward navigation
 * never replays a stale csrf/session state. Mirrors cloud's `sessionJson`.
 */
function sessionJson(body: unknown, cookies: readonly string[]): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

export function handleAccountSession(req: Request, deps: AccountSessionDeps): Response {
  if (req.method !== "GET") return methodNotAllowed("GET");

  // CSRF token for BOTH branches (G2 — anonymous CSRF; the piece `api-me.ts`
  // lacks, since it mints only when signed in). ensureCsrfToken reuses an
  // existing CSRF cookie or mints one (setCookie only when it minted) — it
  // works WITHOUT a session and authorizes NOTHING alone (it's one half of a
  // double-submit that also needs the matching cookie + same-origin + a live
  // session at the mint gate it protects). Returning it on the signed-OUT
  // branch lets the app run the sign-in moment in-app.
  const csrf = ensureCsrfToken(req);
  const cookies: string[] = [];
  if (csrf.setCookie) cookies.push(csrf.setCookie);

  // findActiveSession is the single chokepoint: it refuses an expired row (a
  // logged-out row is gone outright). Nothing below rolls or reads a
  // dead/absent session.
  const session = findActiveSession(deps.db, req);
  if (!session) {
    return sessionJson({ signed_in: false, csrf: csrf.token }, cookies);
  }

  // Bounded slide (the G3 twin, and the reason NOT to call bare
  // `touchSession` unconditionally here): this endpoint is POLLED — the
  // app's `/check-email` screen hits it every few seconds while it waits for
  // a magic-link-style click — so sliding only past
  // `SESSION_SLIDE_THRESHOLD_MS` of remaining life bounds the write (and the
  // cookie re-issue) to ~once per threshold per session, not per request.
  if (shouldSlideSession(session)) {
    touchSession(deps.db, session.id);
    cookies.push(
      buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000), {
        secure: isHttpsRequest(req),
      }),
    );
  }

  const user = getUserById(deps.db, session.userId);
  if (!user) {
    // Session row points at a deleted user — treat as signed-out (the
    // `api-me.ts` precedent) rather than surface a stale identity. Any slide
    // cookie computed above still rides along; it's harmless (the row is
    // about to be orphaned regardless) and keeping the branch simple beats
    // special-casing a cookie rollback for a should-never-happen state.
    return sessionJson({ signed_in: false, csrf: csrf.token }, cookies);
  }

  return sessionJson(
    {
      signed_in: true,
      csrf: csrf.token,
      // users.email is null-by-history (migration v15) — username is always
      // present, email only when the row has one (B2 signup capture).
      username: user.username,
      ...(user.email ? { email: user.email } : {}),
      account_created_at: user.createdAt,
      // HUB EXTRA — additive, not part of the door-contract pin
      // (`checkAccountSessionResponse` tolerates extra fields): lets the app
      // hop a temp-password user straight to the change-password ceremony
      // instead of hitting the force-change-password 403 wall on their next
      // `/account/*` call.
      ...(user.passwordChanged === false ? { password_change_required: true } : {}),
    },
    cookies,
  );
}
