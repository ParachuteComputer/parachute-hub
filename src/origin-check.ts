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
 *
 * Malformed inputs are dropped silently — the function returns whatever it
 * could parse. Callers should always include the issuer as a baseline so
 * an empty parse-result is never the whole story.
 */
export function buildHubBoundOrigins(opts: {
  issuer: string;
  loopbackPort?: number;
  exposeHubOrigin?: string;
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
  add(opts.issuer);
  add(opts.exposeHubOrigin);
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
  if (origin) {
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
