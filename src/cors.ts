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
 *   in-scope (wildcard `Access-Control-Allow-Origin: *`):
 *     /oauth/*                                — DCR, authorize, token, revoke
 *     /.well-known/oauth-authorization-server — RFC 8414 metadata
 *     /.well-known/parachute.json             — Parachute service catalog
 *     /.well-known/jwks.json                  — RFC 7517 JWKS (public keys)
 *     /.well-known/parachute-revocation.json  — revocation list
 *
 *   out-of-scope (same-origin only, no CORS headers):
 *     /api/*                                  — admin Bearer surface
 *     /admin/*                                — admin SPA shell
 *     /login, /logout, /account/*             — interactive session pages
 *     /vault/*, /<service-mount>/*            — module-level content proxy
 *
 * Why `*` and not an allowlist:
 *
 * These endpoints are public by design. The OAuth-authz spec (RFC 6749) plus
 * DCR (RFC 7591) put the access-control gate inside the protocol (PKCE +
 * redirect_uri matching + the operator-driven approval flow in #74/#199), not
 * at the network layer. Wildcard origin is the canonical posture for OAuth
 * authorization servers — see [Okta], [Auth0], [Keycloak] — because narrowing
 * the origin list at this layer breaks legitimate third-party SPAs without
 * preventing any attack the protocol doesn't already cover.
 *
 * Wildcard is safe to pair with `Allow-Credentials: false` because none of
 * these endpoints consult cookies — bearer tokens travel in the
 * `Authorization` header, which the wildcard-origin response *does* allow the
 * browser to send (the credentials-mode restriction is cookie-specific).
 *
 * Admin/API/content routes intentionally stay same-origin-only: those *do*
 * consult cookies / minted bearers tied to the operator's hub origin, and
 * opening them cross-origin would unwire CSRF defenses for no third-party
 * benefit (third parties talk to those surfaces through OAuth-issued tokens,
 * not direct admin API access).
 *
 * Header rationale:
 *
 *   Access-Control-Allow-Origin: *
 *     Public-by-design surface; allowlists at this layer add friction without
 *     security (see above).
 *
 *   Access-Control-Allow-Credentials: false
 *     No cookies cross this boundary. Bearer tokens in Authorization travel
 *     fine under credentials:false + origin:*.
 *
 *   Access-Control-Allow-Methods: GET, POST, OPTIONS
 *     The union of methods the in-scope route family supports. Per-route
 *     could be narrower (e.g. /oauth/token is POST-only), but advertising the
 *     union is the simpler shape and browsers don't enforce a per-route
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
 * Headers to fold onto *actual* (non-preflight) responses for in-scope routes.
 *
 * Use `applyCorsHeaders(response)` when you have an existing Response object;
 * spread these into a new Headers init when you're building one from scratch.
 */
export const CORS_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-credentials": "false",
  "access-control-expose-headers": "WWW-Authenticate",
};

/**
 * Headers for the OPTIONS preflight response. Superset of the response
 * headers — the actual request will re-send the response subset.
 */
export const CORS_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  ...CORS_RESPONSE_HEADERS,
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, X-Requested-With",
  "access-control-max-age": "86400",
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
 */
export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_PREFLIGHT_HEADERS } });
}

/**
 * Fold the CORS response headers onto an existing Response.
 *
 * Returns a *new* Response that shares the body but has the merged Headers.
 * Existing headers on the input response take precedence — but the CORS
 * headers don't typically collide with anything a handler would set, so in
 * practice this just adds three headers.
 *
 * Why a new Response: Response.headers is immutable post-construction. We
 * could mutate during the handler instead, but folding at the dispatcher
 * level keeps the per-handler code free of CORS concerns and makes "which
 * routes are CORS-friendly" a single-source-of-truth in `isCorsAllowedRoute`.
 */
export function applyCorsHeaders(response: Response): Response {
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_RESPONSE_HEADERS)) {
    if (!merged.has(k)) merged.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
