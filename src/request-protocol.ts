/**
 * Detect whether an incoming `Request` arrived over HTTPS — the signal
 * cookie-mint helpers (`buildCsrfCookie`, `buildSessionCookie`,
 * `buildSessionClearCookie`) use to decide whether to set the `Secure`
 * attribute. Browsers DROP `Secure` cookies on `http://` connections; on
 * `http://localhost:1939` (the normal local-dev / on-box-CLI shape)
 * unconditionally setting `Secure` means the browser silently swallows
 * the cookie, the next POST has no cookie to double-submit against, and
 * CSRF verification fails with a "reload and try again" page.
 *
 * Signals checked, in priority order:
 *
 *   1. `new URL(req.url).protocol === "https:"` — direct HTTPS. Hub
 *      itself binds 127.0.0.1:1939 over plain HTTP, but a downstream
 *      caller (a test, an internal proxy) may rewrite the URL.
 *
 *   2. `X-Forwarded-Proto: https` — the standard reverse-proxy header.
 *      Tailscale Serve, cloudflared, and Render all terminate TLS at the
 *      edge and forward HTTP to the hub with this header set. Without
 *      this check, every cookie minted behind a reverse proxy would
 *      drop `Secure` and downgrade the security posture.
 *
 *   3. Otherwise: HTTP. The cookie is minted without `Secure` so the
 *      browser keeps it on `http://localhost:1939`.
 *
 * The pattern matches the standard double-submit / session-cookie
 * convention: secure-by-default unless explicit evidence the connection
 * is plain HTTP. We do NOT default to "secure" when the protocol is
 * ambiguous — an ambiguous request is one we can't prove is HTTPS, and
 * setting `Secure` on it would re-create the original bug. A real
 * MITM-able HTTP connection is a different problem (operators on
 * untrusted networks should expose the hub through tailnet/funnel, not
 * raw HTTP); the cookie-Secure attribute isn't the defense against it.
 */
export function isHttpsRequest(req: Request): boolean {
  // 1. Direct protocol on the parsed URL.
  try {
    if (new URL(req.url).protocol === "https:") return true;
  } catch {
    // Malformed URL on req — fall through to header sniffing.
  }
  // 2. Reverse-proxy header. The forwarded-proto header is a single
  //    token in practice ("http" or "https"); we lowercase + trim before
  //    compare so a stray "HTTPS" or " https" doesn't slip past.
  const xfp = req.headers.get("x-forwarded-proto");
  if (xfp && xfp.split(",")[0]?.trim().toLowerCase() === "https") return true;
  return false;
}
