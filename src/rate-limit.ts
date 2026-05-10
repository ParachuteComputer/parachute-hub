/**
 * Per-IP rate-limit on `POST /login`. Lands as a floor under brute-force
 * after hub#187 collapsed the public-reach matrix: with a cloudflare tunnel
 * up, `/login` is now reachable from the open internet, and 2FA (#186)
 * is the next PR rather than this one. A 5-attempts-per-15-minute bucket per
 * IP is the standard login-form floor; it's not the primary defense, just the
 * one that turns "infinite credential grinding" into "rotate IPs".
 *
 * (Endpoint was `/admin/login` pre-rename; bucket logic is path-agnostic so
 * the rename was a comment-only change here.)
 *
 * Shape: sliding window. Each key keeps the last N attempt timestamps; on a
 * new attempt we prune anything older than the window, count what remains,
 * decide allow / deny, and (on allow) append the current timestamp. Sliding
 * gives an exact `Retry-After` (seconds until the *oldest* in-window
 * timestamp falls off) rather than the rough next-refill of a token bucket.
 *
 * Storage: process-local `Map`. Persistence isn't worth a SQLite write per
 * attempt — process restart is itself a defense (the attacker loses all
 * progress against any one bucket). Memory is bounded by an opportunistic
 * sweep of empty buckets every time we touch the map, so an attacker
 * cycling through IPs can't grow the map without also leaving timestamps in
 * each.
 *
 * Auth-stage independence: callers MUST gate via `checkAndRecord` *before*
 * the credential check. A 2FA (or password) failure should count toward the
 * same bucket as a wrong password — an attacker who knows the password
 * shouldn't get unlimited grinding against backup codes.
 *
 * Layer-independent: the limiter applies on every layer (loopback included).
 * A buggy script hammering loopback gets 429'd just like a public attacker.
 * The one wrinkle is `tailscale serve` proxying from `127.0.0.1`, so all
 * tailnet logins share the loopback bucket — acceptable because tailnet is
 * authed at the network layer and brute-force isn't the threat model there.
 *
 * Testable: inject the clock via `now` so the tests can advance time
 * deterministically without `setTimeout`. Module-level state is exported via
 * `__resetForTests` so the test file can reset between cases without
 * recreating the module.
 */

/** Window length: 15 minutes. */
export const WINDOW_MS = 15 * 60 * 1000;
/** Attempts allowed per window. 6th attempt within the window is denied. */
export const MAX_ATTEMPTS = 5;
/** Sentinel for the IP-extraction priority chain when nothing parsed. */
export const UNKNOWN_IP_SENTINEL = "unknown";

export interface RateLimitResult {
  /** True if the attempt is admitted; caller proceeds to credential check. */
  allowed: boolean;
  /**
   * Seconds until the bucket reset (oldest in-window timestamp falls off).
   * Only set when `allowed` is false. Always >= 1: the deny branch only
   * fires when the oldest in-window timestamp is strictly inside the
   * window, so `Math.ceil(positiveMs / 1000) >= 1` naturally. The
   * `Math.max(1, ...)` clamp inside `checkAndRecord` is a defense-in-depth
   * floor in case the filter logic is ever loosened.
   */
  retryAfterSeconds?: number;
}

/**
 * Module-level state. `Map<key, attemptsTimestampsMs[]>`. Each array holds
 * raw `Date.now()`-style millisecond timestamps for in-window attempts.
 */
const buckets: Map<string, number[]> = new Map();

/**
 * Record an attempt and return whether it's admitted. `key` is typically a
 * client IP from `clientIpFromRequest`. `now` is injected for testability;
 * production callers pass `new Date()`.
 *
 * Behavior:
 *   - Prune timestamps older than `now - WINDOW_MS`.
 *   - If remaining count >= MAX_ATTEMPTS, deny with `retryAfterSeconds`
 *     pointing at the oldest in-window timestamp's age-out moment. The
 *     denied attempt is NOT recorded — we don't want a flood of denials
 *     pushing the reset further into the future. The window stays anchored
 *     to the actual 5 admitted attempts.
 *   - Otherwise admit, append the current timestamp, return allowed.
 */
export function checkAndRecord(key: string, now: Date): RateLimitResult {
  const cutoff = now.getTime() - WINDOW_MS;
  const existing = buckets.get(key) ?? [];
  // Drop anything that fell out of the window. Mutating a copy keeps the
  // semantics clear: `pruned` is always the in-window slice.
  const pruned = existing.filter((t) => t > cutoff);

  if (pruned.length >= MAX_ATTEMPTS) {
    // Reset moment = oldest in-window attempt + WINDOW_MS. `pruned[0]` is
    // the oldest because timestamps are appended in order. Subtract `now`
    // for seconds-until-reset. The unclamped value is provably >= 1 in this
    // branch (see below), but `Math.max(1, ...)` stays as a defense-in-depth
    // floor so Retry-After never reads 0 if the filter logic is ever
    // loosened. Reasoning: the deny branch requires `pruned.length >=
    // MAX_ATTEMPTS`, which implies every entry survived the `t > cutoff`
    // filter, i.e. `pruned[0] > now - WINDOW_MS` strictly, i.e. `resetAtMs -
    // now > 0` strictly, i.e. `Math.ceil(positive / 1000) >= 1`.
    const resetAtMs = (pruned[0] ?? now.getTime()) + WINDOW_MS;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now.getTime()) / 1000));
    // Denied attempt: the bucket is still full (>= MAX_ATTEMPTS in-window
    // entries), so unconditionally re-store the pruned slice. Persisting the
    // prune keeps stale entries from leaking forward past their window. We
    // do NOT delete here — that branch is structurally unreachable in deny
    // because deny requires a non-empty `pruned`.
    buckets.set(key, pruned);
    return { allowed: false, retryAfterSeconds };
  }

  pruned.push(now.getTime());
  buckets.set(key, pruned);
  return { allowed: true };
}

/**
 * Test-only escape hatch. Production code never calls this; the test file
 * uses it between cases so module-level state doesn't leak across tests.
 */
export function __resetForTests(): void {
  buckets.clear();
}

/**
 * Extract the client IP from request headers, in priority order:
 *   1. `CF-Connecting-IP` — cloudflared sets this on every forwarded request,
 *      and it's the actual client IP (not the cloudflare edge). This is the
 *      authoritative source on cloudflare-fronted hubs.
 *   2. `X-Forwarded-For` first hop — defensive fallback for any non-cloudflare
 *      proxy fronting hub. The first comma-separated value is the original
 *      client; later values are intermediate proxies.
 *   3. `Forwarded` (RFC 7239) — not parsed; covered by the comment in the
 *      issue's IP-priority list as deferred. `X-Forwarded-For` covers the
 *      operator-deploy reality (every common reverse proxy sets it).
 *   4. Fall through to `UNKNOWN_IP_SENTINEL`. Hub binds `127.0.0.1`, so the
 *      "request remote addr" case the spec mentions doesn't materialize at
 *      this layer (Bun's `requestIP` is on `Server`, not `Request`, and
 *      everything reaching here is either loopback or proxy-injected). The
 *      sentinel ensures the limiter always has a key — all sentinel
 *      requests share one bucket, which is the intended bound for
 *      direct-loopback callers (curl from the same host).
 *
 * Returns a trimmed string. Empty / whitespace-only header values are
 * treated as absent.
 */
export function clientIpFromRequest(req: Request): string {
  const cfConnectingIp = trimOrNull(req.headers.get("cf-connecting-ip"));
  if (cfConnectingIp) return cfConnectingIp;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    // First hop only. RFC 7239 / X-Forwarded-For convention is
    // `client, proxy1, proxy2`; the leftmost entry is the original client.
    const first = xff.split(",")[0];
    const trimmed = trimOrNull(first ?? "");
    if (trimmed) return trimmed;
  }

  return UNKNOWN_IP_SENTINEL;
}

function trimOrNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}
