/**
 * Same-origin defense for cookie-based POST endpoints. The function is the
 * server-side belt for `SameSite=Lax` cookies: a cookie-bearing POST coming
 * from anywhere other than the hub's own origin gets rejected here so a
 * stolen-cookie + forged-form attack can't ride the session.
 *
 * The check used to compare strictly against `deps.issuer` (the configured
 * OAuth issuer URL). That's correct only on a single-origin hub. Real
 * self-hosted setups have multiple legitimate origins:
 *
 *   - Loopback (`http://localhost:1939`, `http://127.0.0.1:1939`) — what
 *     the operator hits when running everything on their box.
 *   - Tailnet hostname (e.g. `https://parachute.taildf9ce2.ts.net`) — what
 *     they hit from a remote device on the tailnet.
 *   - Funnel hostname (when public-funnel is up).
 *   - Custom domain (when an operator wires a cname).
 *
 * The strict `issuer === origin` check rejected legitimate operator paths
 * from any of the non-issuer origins (closes #245). We now match against
 * the SET of origins hub is bound to. Real third-party origins still get
 * rejected; legitimate operator paths from any bound origin work.
 *
 * Header-stripped fallback (also closes #245): Tailscale Serve and some
 * reverse proxies don't always forward Origin/Referer on POSTs. When both
 * are absent, we fall back to the Host header. Host is browser-controlled
 * but reflects "what the operator's browser thought it was talking to";
 * matching it against a bound origin is weaker than Origin/Referer but
 * preserves the same-origin signal in the proxy-stripped legitimate-flow
 * case. CSRF + session gates upstream are the real auth defense — this is
 * a belt for browser flows where the legitimate Origin/Referer got dropped.
 */
import { parseSessionCookie } from "./sessions.ts";

/**
 * Build the bound-origin set from the hub's configuration. Returns
 * canonical "scheme://host:port" strings (no trailing slash). The set is
 * order-independent; consumers compare exact-equal against parsed Origin
 * URLs.
 *
 *   - `issuer`: the configured OAuth issuer URL, always included.
 *   - `loopbackPort`: the hub's local listen port; both `localhost` and
 *     `127.0.0.1` aliases are included for that port.
 *   - `exposeHubOrigin`: the `hubOrigin` from `expose-state.json` if set;
 *     typically equal to `issuer` post-`parachute expose`, but kept as an
 *     independent input so a tailnet bring-up after hub start is reflected
 *     without restart.
 *   - `platformOrigin`: a platform-injected public origin (Render's
 *     `RENDER_EXTERNAL_URL`, etc.). Always trusted — the platform
 *     guarantees this is the public URL the operator's browser sees.
 *     Included independently of `issuer` so a stale `hub_settings.hub_origin`
 *     stored to a non-public URL (e.g. a loopback value entered during
 *     setup) doesn't lock the operator out of cookie-POST flows that
 *     legitimately arrive from the public URL. Caught on a Render deploy
 *     2026-05-25 when `hub_settings.hub_origin` was loopback but the
 *     browser POSTed from the public Render URL — Origin mismatch
 *     rejected legitimate operator-initiated approves.
 *
 * Malformed inputs are dropped silently — the function returns whatever it
 * could parse. Callers should always include the issuer as a baseline so
 * an empty parse-result is never the whole story.
 */
export function buildHubBoundOrigins(opts: {
  issuer: string;
  loopbackPort?: number;
  exposeHubOrigin?: string;
  platformOrigin?: string;
}): readonly string[] {
  const set = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      const u = new URL(raw);
      set.add(u.origin);
    } catch {
      // Malformed URL — skip.
    }
  };
  // `opts.issuer` is the PER-REQUEST issuer, which `resolveIssuer` derives
  // from the request's Host header (hub-server.ts, "closes #245"). Including a
  // Host-derived value in the known-issuers set is SAFE — it is NOT a
  // forged-`iss` bypass. Token provenance is signature-gated: the JWKS verify
  // in `validateAccessToken` / `validateHostAdminToken` runs UNCONDITIONALLY
  // FIRST, before `iss` is ever checked against this set. So a token whose
  // `iss` matches an attacker-injected Host (and thus lands in this set) but
  // which isn't signed by THIS hub's key is still rejected at the signature
  // step. The known-issuers membership check is belt-and-suspenders layered on
  // top of the signature gate, never a substitute for it.
  add(opts.issuer);
  add(opts.exposeHubOrigin);
  add(opts.platformOrigin);
  if (typeof opts.loopbackPort === "number" && Number.isInteger(opts.loopbackPort)) {
    set.add(`http://localhost:${opts.loopbackPort}`);
    set.add(`http://127.0.0.1:${opts.loopbackPort}`);
  }
  return Array.from(set);
}

/**
 * True when the request's Origin/Referer (or Host as fallback) matches any
 * of the hub-bound origins. The check has three tiers in priority order:
 *
 *   1. `Origin` header — the canonical CSRF signal per Fetch standard.
 *   2. `Referer` header — fallback when Origin is absent (rare but spec).
 *   3. `Host` header — last-resort match when both above are stripped
 *      (proxy-mangling case). Compares against the host:port of each bound
 *      origin (not the scheme), since the proxy may have terminated TLS
 *      and the Host header reflects the operator's address bar regardless
 *      of how the request reached us.
 *
 * Empty `boundOrigins` always returns false — defense fails closed when no
 * origin info is configured.
 */
export function isSameOriginRequest(req: Request, boundOrigins: readonly string[]): boolean {
  if (boundOrigins.length === 0) return false;
  const boundOriginSet = new Set(boundOrigins);

  const origin = req.headers.get("origin");
  // "null" is the browser's opaque-origin signal — sent on form POSTs from
  // pages with restrictive referrer policies (`<meta name="referrer"
  // content="no-referrer">`), sandboxed iframes, or certain cross-origin
  // redirect chains. The browser is saying "I'm intentionally not telling
  // you where this came from" rather than "this is from origin null".
  // Treat as "Origin not informative" and fall through to Referer/Host —
  // the CSRF token check upstream is still the real authentication;
  // same-origin is belt-and-suspenders, not the only defense.
  //
  // Caught 2026-05-26 on Aaron's Render deploy: hub's OAuth pages set
  // `referrer-policy: no-referrer` for privacy, which made browsers
  // send `Origin: null` on the approve POST. The strict-reject behavior
  // here blocked the legitimate operator action; the Host fallback (tier
  // 3 below) would have correctly accepted the request.
  if (origin && origin !== "null") {
    try {
      return boundOriginSet.has(new URL(origin).origin);
    } catch {
      return false;
    }
  }
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return boundOriginSet.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  const host = req.headers.get("host");
  if (host) {
    // Build the set of acceptable host:port strings from the bound origins.
    // Match on `host:port` only, scheme-agnostic — the Host header doesn't
    // carry scheme, and a proxy may have terminated TLS upstream.
    const boundHosts = new Set<string>();
    for (const origin of boundOrigins) {
      try {
        const u = new URL(origin);
        boundHosts.add(u.host); // includes port if non-default
      } catch {
        // Skip malformed.
      }
    }
    return boundHosts.has(host);
  }
  return false;
}

// ===========================================================================
// CSRF belt for cookie-gated /admin/* JSON mutation endpoints (hub#632,
// 2026-06-09 hub-module-boundary Phase C1)
// ===========================================================================

/** Methods the belt gates. GET/HEAD/OPTIONS are read-shaped and pass. */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Strict same-origin belt for cookie-authenticated JSON mutations — the
 * defense-in-depth layer over `SameSite=Lax` on the hub's cookie-gated JSON
 * mutation endpoints (hub#632; hub-module-boundary charter, trust statement).
 *
 * BELTED ENDPOINTS (the explicit enumeration — every cookie-gated JSON
 * mutation under `/admin/*`; keep this list in sync with the dispatch in
 * `hub-server.ts`):
 *
 *   - `POST /admin/connections` + `DELETE /admin/connections/<id>` +
 *     `POST /admin/connections/<id>/approve`
 *     (connection provision/teardown/claim-approval — the seam's canonical
 *     consumers are the agent module's admin page and the hub SPA, both same-origin
 *     `fetch()` with `credentials: "include"`. The Bearer-authed
 *     `/<id>/renew` + `/<id>/claim` siblings pass the belt via the
 *     Authorization carve-out below.)
 *
 * (The legacy `POST/DELETE /admin/channels` pair was belted here until
 * boundary D1 retired the endpoint — superseded by `/admin/connections`.)
 *
 * NOT belted, and why:
 *   - GET/HEAD/OPTIONS — read-shaped; the mint GETs
 *     (`/admin/host-admin-token`, `/admin/agent-token`,
 *     `/admin/module-token/<short>`, `/admin/vault-admin-token/<name>`)
 *     enforce GET-only with a 405 and their response bodies are unreadable
 *     cross-origin (no CORS on these routes).
 *   - Bearer-authed requests — a cross-site page cannot attach an
 *     `Authorization` header without a CORS preflight these routes never
 *     approve, so a request carrying one is not a browser CSRF. The
 *     downstream auth gate still validates the credential; this belt sits
 *     only on the cookie path.
 *   - Server-rendered form posts (`/login`, `/logout`, `/admin/setup/*`,
 *     `/oauth/authorize` approve) — already carry the double-submit CSRF
 *     token (`csrf.ts`) and/or `isSameOriginRequest`; not double-gated here.
 *   - `/vaults` (POST) + `/vaults/<name>` (DELETE) — Bearer
 *     `parachute:host:admin` gated, CSRF-immune.
 *   - `/api/*` — Bearer-gated. `/oauth/*` — spec-shaped, own protections.
 *
 * Stricter than `isSameOriginRequest` ON PURPOSE: no Referer fallback and —
 * critically — no Host-header fallback. The Host fallback exists for
 * server-rendered form flows where the double-submit token is the real
 * defense and headers got proxy-stripped (#245). These JSON endpoints carry
 * NO token, so a Host fallback would be a genuine bypass: an attacker form
 * post under `referrer-policy: no-referrer` arrives with `Origin: null` and
 * no Referer, and the Host header always names the target. Browsers send a
 * real `Origin` on every non-GET `fetch()` (same-origin included — default
 * `mode: "cors"` is exempt from referrer-policy Origin masking), so every
 * legitimate consumer of these endpoints passes tier 1. `Origin: null` and
 * malformed values are affirmative mismatches; a missing header on a
 * cookie-authed mutation is rejected with its own error code
 * (`csrf_origin_required`) naming the fix (send Origin, or use a Bearer).
 *
 * Returns `null` when the request may proceed, or a 403 JSON `Response`
 * when the belt rejects. Rejections are logged (method, path, origin — no
 * cookies, no tokens).
 */
export function assertSameOriginForCookieMutation(
  req: Request,
  boundOrigins: readonly string[],
): Response | null {
  if (!MUTATION_METHODS.has(req.method.toUpperCase())) return null;
  // Authorization present → not a browser CSRF (custom headers require a
  // CORS preflight no /admin/* route approves). The endpoint's own gate
  // validates the credential — API clients with Bearers never see the belt.
  if (req.headers.get("authorization")) return null;
  // No session cookie → no ambient credential to ride; the endpoint's own
  // gate returns its usual 401. Presence is enough here — a forged/stale
  // session id fails downstream regardless of what the belt decides.
  if (!parseSessionCookie(req.headers.get("cookie"))) return null;

  const pathname = new URL(req.url).pathname;
  const origin = req.headers.get("origin");
  if (!origin) {
    console.warn(`csrf belt: rejected cookie-authed ${req.method} ${pathname} — no Origin header`);
    return csrfBeltError(
      "csrf_origin_required",
      "cookie-authenticated mutations require an Origin header matching the hub origin; browser fetch() sends it automatically — non-browser clients should authenticate with a Bearer token instead",
    );
  }
  if (origin !== "null") {
    try {
      if (new Set(boundOrigins).has(new URL(origin).origin)) return null;
    } catch {
      // Malformed Origin — fall through to the mismatch rejection.
    }
  }
  console.warn(`csrf belt: rejected cookie-authed ${req.method} ${pathname} — origin=${origin}`);
  return csrfBeltError(
    "csrf_origin_mismatch",
    "request Origin does not match this hub's origin — cross-site mutations are not allowed on cookie-authenticated endpoints",
  );
}

function csrfBeltError(code: string, description: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
