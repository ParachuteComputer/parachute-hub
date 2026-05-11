/**
 * `GET /api/me` — public who-am-I endpoint for hub-served surfaces.
 *
 * Reads the `parachute_hub_session` cookie. If present and active, returns
 * the user identity AND a CSRF token bound to the existing CSRF cookie (or
 * a freshly-minted one). Otherwise returns the minimal `{ hasSession: false }`
 * payload.
 *
 * Public — no auth required (returns "not signed in" rather than 401 when
 * no session, so the SPA / discovery page can render a consistent affordance
 * regardless of auth state). No CORS — same-origin only; hub-served UIs
 * are same-origin.
 *
 * Response shape:
 *
 *   { hasSession: false }
 *   { hasSession: true, user: { id, displayName }, csrf: "<token>" }
 *
 * `displayName` is the user's `username` today — there's no separate
 * display-name field on the User shape. Surfaced under a different key
 * here so a future profile-name migration can land without breaking
 * SPA / discovery consumers.
 *
 * Why include the CSRF token only when signed in: there's nothing to
 * sign-out (or otherwise mutate) without a session. Minting a token in
 * the unsigned-in case would just bloat the response and prime a cookie
 * the consumer has no use for.
 *
 * Why a dedicated endpoint rather than probing a session-gated SPA page:
 * those redirect to /login when unauthenticated, which is exactly the
 * wrong UX for an unconditionally-fetched "show sign-in affordance" call.
 * `/api/me` cleanly returns either state without a bounce.
 *
 * The CSRF token returned here is the same token any same-session
 * `<form>` would carry — the consumer (SPA fetch POST or
 * server-rendered discovery form) submits it back as `__csrf` against
 * the existing logout / mutation handlers.
 */
import type { Database } from "bun:sqlite";
import { ensureCsrfToken } from "./csrf.ts";
import { findActiveSession } from "./sessions.ts";
import { getUserById } from "./users.ts";

export interface ApiMeDeps {
  db: Database;
}

interface SignedInUser {
  id: string;
  displayName: string;
}

/**
 * Discriminated union mirroring the client-side `MeResponse` shape in
 * `web/ui/src/lib/api.ts`. The two early returns below (no-session,
 * deleted-user) construct the `false` arm; the success path constructs
 * the `true` arm. Typing it as a union (rather than an interface with
 * optional fields) means the compiler refuses any future construction
 * that mixes states — e.g. `{ hasSession: false, user: staleUser }`
 * fails at the type-check, not just at code-review.
 */
type ApiMeResponse = { hasSession: false } | { hasSession: true; user: SignedInUser; csrf: string };

export function handleApiMe(req: Request, deps: ApiMeDeps): Response {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }

  const session = findActiveSession(deps.db, req);
  if (!session) {
    return ok({ hasSession: false });
  }

  const user = getUserById(deps.db, session.userId);
  if (!user) {
    // Session row points at a deleted user — treat as not signed in.
    // The session row should be cleaned up by some future sweep, but
    // surfacing a stale identity to the UI would be worse than a
    // momentary "signed out" affordance.
    return ok({ hasSession: false });
  }

  // Mint a CSRF token (or reuse the existing cookie's). When this is the
  // first request to set the cookie, attach Set-Cookie so the browser
  // stores it for future logout submission.
  const csrf = ensureCsrfToken(req);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Don't cache — session can change at any time (login, logout,
    // expiry). The endpoint is cheap; revalidate on every request.
    "cache-control": "no-store",
  };
  if (csrf.setCookie) headers["set-cookie"] = csrf.setCookie;

  const body: ApiMeResponse = {
    hasSession: true,
    user: {
      id: user.id,
      displayName: user.username,
    },
    csrf: csrf.token,
  };
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function ok(body: ApiMeResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
