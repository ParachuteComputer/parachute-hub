/**
 * CORS posture for the public OAuth + discovery surface.
 *
 * Background. Third-party SPAs (Aaron's Gitcoin Brain UI on
 * `https://unforced-dev.github.io`, future user-built clients, OIDC libraries
 * pulling discovery + JWKS) need to talk to a self-hosted hub from a foreign
 * origin. The OAuth Dynamic Client Registration spec (RFC 7591) is *designed*
 * for cross-origin use: any SPA registers itself, runs the auth-code flow,
 * exchanges the code at `/oauth/token`. Without CORS headers on those
 * endpoints, browser preflights fail and the entire third-party-SPA story is
 * broken before it starts.
 *
 * The matrix:
 *
 *   in-scope (echo-origin + `Allow-Credentials: true` for browser callers,
 *             wildcard `*` + `Allow-Credentials: false` for non-browser
 *             callers without an Origin header):
 *     /oauth/*                                — DCR, authorize, token, revoke
 *
 *   `/.well-known/*` handlers carry their own inline CORS posture in
 *   `hub-server.ts` (a narrower `Allow-Methods: GET, OPTIONS` since they're
 *   read-only) and aren't routed through this module.
 *
 *   out-of-scope (same-origin only, no CORS headers):
 *     /api/*                                  — admin Bearer surface
 *     /admin/*                                — admin SPA shell
 *     /login, /logout, /account/*             — interactive session pages
 *     /vault/*, /<service-mount>/*            — module-level content proxy
 *
 * Why echo the request Origin instead of `*`:
 *
 * The rc.17 posture used a static `Access-Control-Allow-Origin: *` +
 * `Allow-Credentials: false`. That works for SPAs that fetch with
 * `credentials: 'omit'`, but most SPA frameworks (the Gitcoin Brain UI's
 * default among them) fetch with `credentials: 'include'`. Browsers reject
 * any `*` ACAO response when the request was made with credentials mode
 * `include` — even when the endpoint doesn't actually use cookies. The CORS
 * spec requires an *explicit* origin echo paired with
 * `Access-Control-Allow-Credentials: true` for that combination to work.
 *
 * Why this isn't a security regression vs `*`:
 *
 * Browsers already restrict the *response* readability by Origin under SOP —
 * an attacker page at `evil.example` issuing a `fetch(hub, {credentials:
 * 'include'})` only gets to *read* the response if the server says yes by
 * echoing `evil.example` back in ACAO. Echoing back the same origin the
 * browser already sent reveals nothing the attacker couldn't reach by
 * standing up their own server. The protocol-level gates (PKCE +
 * redirect_uri matching + the operator-driven approval flow) still bound
 * what a malicious cross-origin caller can *do*. This is the canonical
 * posture for OAuth authorization servers — see [Okta], [Auth0],
 * [Keycloak] — for exactly this reason: OAuth endpoints are public by
 * design, bearer-token-based not cookie-based, and an allowlist at this
 * layer adds friction without preventing any attack the protocol doesn't
 * already cover.
 *
 * Why fall back to `*` + `credentials: false` when there's no Origin:
 *
 * A request without an `Origin` header is a non-browser caller (`curl`
 * without `-H Origin: …`, a server-side fetch). Echoing back nothing would
 * leave the response with no ACAO at all — fine for non-browser callers
 * since they don't enforce CORS, but breaks the contract that a
 * curl-shaped probe to `/oauth/...` should still come back with a
 * well-formed CORS preamble for diagnostic purposes. The wildcard +
 * credentials:false branch matches the rc.17 shape exactly for that case.
 *
 * Why we don't allowlist per-Origin:
 *
 * For OAuth specifically: an allowlist defeats the purpose of an open
 * identity provider. For the broader admin / API surface, an allowlist
 * *is* the right shape — but that surface stays same-origin-only here and
 * doesn't pass through this module.
 *
 * Header rationale:
 *
 *   Access-Control-Allow-Origin
 *     The request's `Origin` header verbatim when present; `*` otherwise
 *     (non-browser caller — see fallback note above).
 *
 *   Access-Control-Allow-Credentials
 *     `true` when echoing a specific origin (required for browsers fetching
 *     with `credentials: 'include'`); `false` on the `*` fallback (the
 *     wildcard branch must pair with credentials:false per CORS spec).
 *
 *   Vary: Origin
 *     Set on every echo-origin response. Without it, a response for
 *     `evil.example` can be cached by the browser's HTTP cache (or a
 *     downstream CDN) and reused for a subsequent `good.example` request,
 *     leaking the wrong ACAO and breaking CORS in unpredictable ways.
 *     Critical for cache correctness.
 *
 *   Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
 *     The union of methods the in-scope route family supports (DELETE for the
 *     RFC 7592 `DELETE /oauth/clients/<id>` deregistration, hub#640). Per-route
 *     could be narrower (e.g. /oauth/token is POST-only), but advertising
 *     the union is the simpler shape and browsers don't enforce a per-route
 *     check anyway — the *actual* request method gates execution at the
 *     handler.
 *
 *   Access-Control-Allow-Headers: Authorization, Content-Type, X-Requested-With
 *     The headers SPAs realistically send: bearer auth, JSON bodies, and the
 *     X-Requested-With marker some HTTP clients add automatically. Anything
 *     else (custom headers) lands in the preflight rejection at the browser,
 *     which is the right shape — surface unexpected headers to the developer.
 *
 *   Access-Control-Max-Age: 86400
 *     24h preflight cache. The route surface is stable (RFCs nailed down
 *     years ago); long max-age cuts preflight chatter to ~1/day per SPA.
 *
 *   Access-Control-Expose-Headers: WWW-Authenticate
 *     OAuth error responses ride in `WWW-Authenticate` (RFC 6750 §3); a
 *     cross-origin SPA needs to read it to surface "invalid_token" /
 *     "insufficient_scope" failure modes. Other headers (Content-Type,
 *     Content-Length, Date, …) are CORS-safelisted by default — no need to
 *     enumerate them.
 *
 * [Okta]: https://developer.okta.com/docs/concepts/api-access-management/#cors
 * [Auth0]: https://auth0.com/docs/get-started/applications/configure-cors
 * [Keycloak]: https://www.keycloak.org/docs/latest/server_admin/#con-web-origins-keycloak_server_administration_guide
 */

/**
 * Static header set that's identical regardless of whether the caller had an
 * Origin: the always-allow exposure of WWW-Authenticate so cross-origin
 * SPAs can read RFC 6750 error responses.
 *
 * Origin / credentials / Vary are computed per-request in `applyCorsHeaders`
 * + `corsPreflightResponse` because they depend on the request's Origin
 * header.
 */
const CORS_STATIC_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "access-control-expose-headers": "WWW-Authenticate",
};

/**
 * Static portion of the preflight headers — method/header allowlists +
 * max-age. The dynamic Origin/credentials/Vary are computed in
 * `corsPreflightResponse`.
 */
const CORS_STATIC_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  // DELETE is in the union for RFC 7592 client deregistration
  // (`DELETE /oauth/clients/<id>`, hub#640). A cross-origin browser caller
  // (vs the server-side surface daemon) would otherwise fail the preflight.
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, X-Requested-With",
  "access-control-max-age": "86400",
};

/**
 * Compute the per-request CORS origin + credentials + Vary triple.
 *
 * Browser caller (Origin header present): echo the origin, set
 * `Allow-Credentials: true`, set `Vary: Origin` (cache correctness).
 *
 * Non-browser caller (no Origin): wildcard `*` + `Allow-Credentials: false`
 * — safer when there's no specific origin to honor, matches the rc.17
 * fallback shape for `curl`-style probes.
 */
function corsOriginHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (origin) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      vary: "Origin",
    };
  }
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-credentials": "false",
  };
}

/**
 * Headers folded onto *actual* (non-preflight) responses for in-scope routes.
 * Re-exported as a static lookup for tests + the rare caller that wants to
 * spread the always-on subset (Expose-Headers) into a fresh Headers init.
 *
 * The dynamic Origin/Credentials/Vary triple is *not* here — it's a function
 * of the incoming request's `Origin` header. Use `applyCorsHeaders(req,
 * response)` to attach the full set.
 */
export const CORS_RESPONSE_HEADERS = CORS_STATIC_RESPONSE_HEADERS;

/**
 * Static portion of the preflight headers. Exported for tests that pin the
 * method/header allowlist + max-age values. The per-request
 * Origin/Credentials/Vary triple is computed in `corsPreflightResponse`.
 */
export const CORS_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  ...CORS_STATIC_RESPONSE_HEADERS,
  ...CORS_STATIC_PREFLIGHT_HEADERS,
};

/**
 * Does this pathname participate in the public-CORS surface this module owns?
 *
 * Matches the OAuth surface (`/oauth/...`) only. The four `/.well-known/*`
 * documents (oauth-authorization-server, parachute.json, jwks.json,
 * parachute-revocation.json) are *also* part of the cross-origin contract,
 * but they each carry their own CORS handling inline in `hub-server.ts` (a
 * narrower `Allow-Methods: GET, OPTIONS` since they're read-only) and
 * predate this module. Including them here would mean two CORS code paths
 * disagreeing on the method list; leaving them in their existing block keeps
 * one CORS posture per route family.
 *
 * Anything else — admin/API/content/login — stays same-origin-only and must
 * NOT pass through this predicate.
 *
 * Prefix-match on `/oauth/` (with trailing slash) so the bare path `/oauth`
 * doesn't match — there's no route at `/oauth` and the prefix would
 * accidentally widen if anyone later mounts something there.
 */
export function isCorsAllowedRoute(pathname: string): boolean {
  return pathname.startsWith("/oauth/");
}

/**
 * 204 response for an OPTIONS preflight on an in-scope route.
 *
 * Browsers issue this before any non-simple cross-origin request (custom
 * Content-Type, Authorization header, non-GET/POST/HEAD method). The response
 * body is empty by spec; the browser only reads the headers.
 *
 * The Origin/Credentials/Vary triple is computed from the request's `Origin`
 * header — see `corsOriginHeaders` for the per-request shape.
 */
export function corsPreflightResponse(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsOriginHeaders(req),
      ...CORS_STATIC_RESPONSE_HEADERS,
      ...CORS_STATIC_PREFLIGHT_HEADERS,
    },
  });
}

/**
 * Fold the CORS response headers onto an existing Response.
 *
 * Returns a *new* Response that shares the body but has the merged Headers.
 * Existing headers on the input response take precedence — but the CORS
 * headers don't typically collide with anything a handler would set, so in
 * practice this just adds the three-to-four CORS headers.
 *
 * Why a new Response: Response.headers is immutable post-construction. We
 * could mutate during the handler instead, but folding at the dispatcher
 * level keeps the per-handler code free of CORS concerns and makes "which
 * routes are CORS-friendly" a single-source-of-truth in `isCorsAllowedRoute`.
 *
 * The signature takes the request so the Origin echo + credentials posture
 * can be computed per-call. The dispatcher in `hub-server.ts` already has
 * the request in scope at every `applyCorsHeaders` call site.
 */
export function applyCorsHeaders(req: Request, response: Response): Response {
  const merged = new Headers(response.headers);
  const dynamic = corsOriginHeaders(req);
  for (const [k, v] of Object.entries({ ...dynamic, ...CORS_STATIC_RESPONSE_HEADERS })) {
    if (!merged.has(k)) merged.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
