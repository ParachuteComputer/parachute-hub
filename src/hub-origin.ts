/**
 * The Parachute hub is the ecosystem's OAuth issuer (Phase 0 of the hub-as-
 * portal design at DESIGN-2026-04-20-hub-as-portal-oauth-and-service-catalog.md).
 * Every service that participates in OAuth (today just vault; scribe + channel
 * later) needs to know what URL clients will use to discover and reach the
 * issuer — and that URL has to match what tailscale actually serves.
 *
 *   exposed (tailnet or public) → `https://<fqdn>`
 *   not exposed (local dev)     → `http://127.0.0.1:<hub-port>`
 *   user override               → whatever --hub-origin was passed
 *
 * One source of truth — expose/start both route through `deriveHubOrigin`.
 */

export const HUB_ORIGIN_ENV = "PARACHUTE_HUB_ORIGIN";

/**
 * The env var carrying the SET of origins the hub legitimately answers on,
 * comma-separated (multi-origin iss-set, onboarding-streamline 2026-06-25).
 *
 * Supervised resource servers (vault, scribe) read this in addition to the
 * single canonical `PARACHUTE_HUB_ORIGIN` and widen their accepted-`iss` check
 * from one string to this set — so a token minted under one URL of a
 * multi-URL box (loopback ∪ `<ip>.sslip.io` ∪ a custom domain behind Caddy)
 * validates when the resource is reached via another URL of the SAME box. The
 * signing key is stable + origin-independent, so only the `iss` string varies.
 *
 * SECURITY INVARIANT: the value MUST be the hub's `buildHubBoundOrigins`
 * output — configured issuer ∪ loopback aliases ∪ expose-state public origin ∪
 * platform origin — published BY THE HUB. It must NEVER contain an unvalidated
 * request `Host` / `X-Forwarded-Host`. Accepting `iss ∈ this-set` is safe
 * ONLY because the resource server's JWKS signature verify runs first and
 * proves the hub minted the token.
 *
 * `PARACHUTE_HUB_ORIGIN` (the single canonical origin) is ALWAYS written
 * alongside this var for back-compat: a resource server on an older
 * scope-guard that doesn't read `PARACHUTE_HUB_ORIGINS` keeps its existing
 * single-origin behavior.
 */
export const HUB_ORIGINS_ENV = "PARACHUTE_HUB_ORIGINS";

/**
 * Serialize an origin SET into the comma-separated `PARACHUTE_HUB_ORIGINS`
 * wire form. Dedupes, drops empties, preserves first-seen order. Returns
 * `undefined` when nothing survives (caller skips setting the env var so a
 * resource server falls back to single-origin behavior). Pair with
 * `buildHubBoundOrigins` to produce `origins`.
 */
export function serializeHubOrigins(origins: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const raw of origins) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (trimmed.length > 0) seen.add(trimmed);
  }
  if (seen.size === 0) return undefined;
  return Array.from(seen).join(",");
}

/**
 * Parse the comma-separated `PARACHUTE_HUB_ORIGINS` wire form back into an
 * origin array. Tolerant of surrounding whitespace + trailing slashes + empty
 * segments. The resource-server inverse of `serializeHubOrigins`; lives here
 * (rather than only in the consumer adapters) so the hub's own injection tests
 * can round-trip against the canonical parser. Returns `[]` for an
 * absent/empty/garbage value.
 */
export function parseHubOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of raw.split(",")) {
    const trimmed = seg.trim().replace(/\/+$/, "");
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export interface DeriveHubOriginOpts {
  /** Explicit user override (e.g., `--hub-origin`). Wins over everything else. */
  override?: string;
  /**
   * Tailnet FQDN from a live exposure. Present when `expose-state.json`
   * carries a canonicalFqdn; absent for unexposed local dev.
   */
  exposeFqdn?: string;
  /**
   * Bound hub port for the localhost fallback. When no exposure and no hub
   * port exists, we pass through `undefined` and callers decide what to do
   * (typically: skip setting the env so vault advertises its own issuer).
   */
  hubPort?: number;
}

/**
 * Resolve the canonical hub origin. Returns `undefined` only when no source
 * of truth is available (no override, no exposure, no hub port). Callers that
 * set `PARACHUTE_HUB_ORIGIN` on a child process should skip the env var
 * entirely in that case so the service falls back to its own defaults.
 */
export function deriveHubOrigin(opts: DeriveHubOriginOpts): string | undefined {
  if (opts.override) return opts.override.replace(/\/+$/, "");
  if (opts.exposeFqdn) return `https://${opts.exposeFqdn}`;
  if (opts.hubPort !== undefined) return `http://127.0.0.1:${opts.hubPort}`;
  return undefined;
}
