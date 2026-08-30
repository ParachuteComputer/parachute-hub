/**
 * Trust-layer classification for an incoming hub request.
 *
 * Extracted from `hub-server.ts` so NIP-98 URL reconstruction
 * (`requestAbsoluteUrl`) can consult `layerOf` without importing the
 * server module — `hub-server` already imports `nostr-http-auth`, and a
 * reverse import is a cycle.
 *
 * The classifier itself is unchanged (item E / hub#526, hub#704).
 */

/**
 * The trust layer a request arrived through. Hub binds `127.0.0.1:1939`, so
 * every request reaches it via one of three trusted forwarders (or directly
 * over loopback). The forwarder injects characteristic headers that we use to
 * classify; nothing else can reach the listener, so spoofing isn't a concern.
 *
 *   "loopback" — direct localhost call (CLI, on-box service, dev shell).
 *   "tailnet"  — `tailscale serve` forwarding an authed tailnet user.
 *   "public"   — `tailscale funnel` (public-over-tailnet, unauthed) OR a
 *                cloudflared tunnel forwarding from the public internet.
 *
 * Used to gate `publicExposure: "loopback"` services on the generic
 * `/<svc>/*` dispatch (the hub's only layer-gate). Hub-owned paths (`/`,
 * `/admin/*`, `/api/*`, `/hub/*`, `/oauth/*`, `/.well-known/*`, `/vault/*`,
 * `/vaults`) reach all layers and rely on app-level auth (admin session
 * cookie + 2FA, OAuth, per-service tokens) — they are NOT layer-blocked.
 */
export type RequestLayer = "loopback" | "tailnet" | "public";

/**
 * Peer address as resolved by Bun `Server.requestIP`. Bound once per
 * request in `hubFetch` so NIP-98 reconstruction (and anything else that
 * only has the `Request`) can see the same peer `layerOf` used for the
 * publicExposure cloak — without threading `peerAddr` through every
 * `requireScope` / `authenticateNostrRequest` call site.
 *
 * Same-object: `Request.clone()` is a new key. Bind the object the
 * handler will authenticate, which is the one `hubFetch` received.
 */
const peers = new WeakMap<Request, string | null>();

export function bindRequestPeer(req: Request, peerAddr: string | null): void {
  peers.set(req, peerAddr);
}

/** `undefined` when unbound; `null` when bound with no Server. */
export function peerAddrOf(req: Request): string | null | undefined {
  return peers.has(req) ? peers.get(req)! : undefined;
}

/**
 * Classify the trust layer for an incoming request by inspecting proxy
 * headers. Order matters: cloudflared headers come first because cloudflared
 * could in principle be deployed alongside tailscale on the same node.
 *
 * Header reference (verified against tailscale serve.go on 2026-05-08):
 *   - `Tailscale-User-Login` is set ONLY by `tailscale serve` for an authed
 *     tailnet user. Tagged-source nodes don't get it. Funnel never sets it.
 *   - `Tailscale-Funnel-Request: ?1` is set ONLY by Tailscale Funnel.
 *     Mutually exclusive with `Tailscale-User-Login` (the serve.go path
 *     returns early when funneled).
 *   - `CF-Ray` and `CF-Connecting-IP` are set by Cloudflare's edge for
 *     anything proxied through a cloudflared tunnel.
 *
 * Spoofing isn't a concern for the proxy-injected layers: the trusted
 * forwarders (tailscale serve/funnel, cloudflared) set these headers and a
 * peer can't forge them past the forwarder. Tailscale specifically strips the
 * same headers from incoming requests before re-injecting them, so even a
 * malicious tailnet peer can't impersonate a different user.
 *
 * Header-absence is NOT a loopback signal (item E / hub#526). The old default
 * returned "loopback" — the most-trusted layer — for any request with no proxy
 * headers, on the premise (true only on a loopback bind) that "external
 * requests can't reach the listener." Containers / Render legitimately bind
 * `0.0.0.0`, where a network peer can reach the listener directly with no proxy
 * headers and would be misclassified `loopback`, bypassing the
 * `publicExposure:"loopback"` 404-cloak on `proxyToService` / `proxyToVault`.
 *
 * Fix: derive loopback from the actual PEER ADDRESS (`peerAddr`, resolved by
 * the caller from `server.requestIP(req)` — `requestIP` lives on the Bun
 * Server, not the Request; see rate-limit.ts:282-285). A header-absent request
 * is `loopback` ONLY when its peer is `127.0.0.1` / `::1` (the on-box CLI
 * caller, which must stay loopback). A header-absent NON-loopback peer is the
 * untrusted direct-network case and is classified `public` (least-trusted) so
 * the cloak fires. When `peerAddr` is unknown (null/undefined — no Server
 * threaded, e.g. a unit test calling `layerOf(req)` directly), we fail CLOSED
 * to `public` rather than open to `loopback`.
 *
 * Caddy/nginx-direct (hub#704): a SAME-BOX reverse proxy dials loopback (peer
 * is 127.0.0.1) but, unlike cloudflared/tailscale, sets NO cf/tailscale header
 * — so a header-only-or-peer-only classifier would call every public request
 * through it "loopback" (most-trusted). The discriminator is the standard
 * reverse-proxy forwarding headers (X-Forwarded-For / X-Forwarded-Host /
 * Forwarded): a loopback peer that carries one is a proxied PUBLIC request →
 * `public`; a header-less loopback peer (direct on-box caller — CLI, probes,
 * the init bootstrap-token loopback probe) stays `loopback`. See the inline
 * comment in the function for the full rationale + spoof analysis.
 */
export function layerOf(req: Request, peerAddr?: string | null): RequestLayer {
  const h = req.headers;
  if (h.get("cf-ray") !== null || h.get("cf-connecting-ip") !== null) return "public";
  // Match the structured-header value (`?1`) rather than mere presence:
  // serve.go only ever emits `?1`, so insisting on the canonical value keeps
  // the classifier's intent obvious to a future reader (don't loosen this to
  // `!== null` — Tailscale's contract is the value, not the header name).
  // CF-Ray / CF-Connecting-IP are open-string identifiers with no canonical
  // value to compare against, hence the presence-check above.
  if (h.get("tailscale-funnel-request") === "?1") return "public";
  if (h.get("tailscale-user-login") !== null) return "tailnet";
  // Caddy/nginx-direct deploy (hub#704): a same-box reverse proxy terminates
  // TLS and `reverse_proxy 127.0.0.1:1939` — so it dials loopback (peer is
  // 127.0.0.1) and, unlike cloudflared/tailscale, stamps NO cf/tailscale
  // header. Without this branch every PUBLIC request through such a proxy
  // would classify "loopback" (the MOST-trusted layer): the GET /admin/setup
  // bootstrap-token JSON probe would hand the token to any public visitor, and
  // the publicExposure:"loopback" 404-cloak would stop hiding loopback-only
  // services/vaults from the network.
  //
  // The discriminator is the standard reverse-proxy forwarding headers. A
  // same-box proxy carrying a PUBLIC request sets X-Forwarded-For /
  // X-Forwarded-Host / Forwarded; a direct on-box caller (the CLI, health
  // probes, the init bootstrap-token loopback probe `curl 127.0.0.1/admin/setup`,
  // the hub's own loopback self-requests) sets none of them — the hub never
  // injects X-Forwarded-* on the INBOUND request it classifies (it only stamps
  // X-Forwarded-Host/Proto on OUTBOUND proxy requests to modules). So a
  // loopback peer that ALSO carries a forwarding header is a proxied public
  // request → "public"; a header-less loopback peer stays "loopback".
  //
  // No spoof vector: a NON-loopback peer is already "public" regardless of
  // headers (the branch below), so adding these headers can only DOWNGRADE a
  // loopback caller (the on-box operator hurting only their own request) —
  // never upgrade a network peer to "loopback".
  //
  // Presence check (`!== null`), NOT a trim: an empty/whitespace forwarding
  // header still means "a proxy is in front" → err to public. Downgrading on
  // ambiguity is the safe direction for a trust classifier; a future ".trim()
  // tidy-up" that let an empty XFF fall back to loopback would re-open the leak.
  if (
    isLoopbackPeer(peerAddr) &&
    (h.get("x-forwarded-for") !== null ||
      h.get("x-forwarded-host") !== null ||
      h.get("forwarded") !== null)
  ) {
    return "public";
  }
  // No proxy headers — classify by peer address, failing closed when unknown.
  return isLoopbackPeer(peerAddr) ? "loopback" : "public";
}

/**
 * True when `peerAddr` (a `server.requestIP(req)?.address`) is a loopback
 * address. Handles the IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) Bun can emit
 * on a dual-stack listener. A null/undefined/unparseable address is NOT
 * loopback — `layerOf` fails closed to `public` in that case.
 */
export function isLoopbackPeer(peerAddr: string | null | undefined): boolean {
  if (!peerAddr) return false;
  const addr = peerAddr.trim().toLowerCase();
  return (
    addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.")
  );
}
