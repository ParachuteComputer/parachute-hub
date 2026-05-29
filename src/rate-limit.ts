/**
 * Rate-limit primitives for hub auth-surface endpoints.
 *
 * Two limiters today (one floor each — neither is the primary defense):
 *
 *   - `/login` (per-IP, hub#187 / hub#188): 5 attempts / 15 min.
 *     Lands as a floor under brute-force after hub#187 collapsed the
 *     public-reach matrix: with a cloudflare tunnel up, `/login` is now
 *     reachable from the open internet, and 2FA (#186) is the next PR
 *     rather than this one. A 5-attempts-per-15-minute bucket per IP is
 *     the standard login-form floor; it's not the primary defense, just
 *     the one that turns "infinite credential grinding" into "rotate IPs".
 *     (Endpoint was `/admin/login` pre-rename; bucket logic is path-
 *     agnostic so the rename was a comment-only change here.)
 *
 *   - `/account/change-password` (per-user, hub#282): 3 attempts / 5 min.
 *     The endpoint is session-gated, so the threat model isn't open-
 *     internet brute-force — it's a compromised session (stolen cookie)
 *     hammering argon2id verifications against the current password
 *     without bound. Keyed by user-id (not IP) because the session
 *     already identifies the user — sharing across IPs is correct here
 *     (an attacker rotating egress IPs against the same stolen cookie
 *     shouldn't get five fresh buckets).
 *
 * Shape: sliding window. Each key keeps the last N attempt timestamps; on
 * a new attempt we prune anything older than the window, count what
 * remains, decide allow / deny, and (on allow) append the current
 * timestamp. Sliding gives an exact `Retry-After` (seconds until the
 * *oldest* in-window timestamp falls off) rather than the rough next-
 * refill of a token bucket.
 *
 * Storage: process-local `Map` per limiter instance. Persistence isn't
 * worth a SQLite write per attempt — process restart is itself a defense
 * (the attacker loses all progress against any one bucket). Memory is
 * bounded by an opportunistic prune of empty buckets every time we touch
 * the map, so an attacker cycling through keys can't grow the map
 * without also leaving timestamps in each.
 *
 * One edge case worth naming: a per-stable-key limiter (e.g. /change-password
 * keyed by user.id) can leave an empty bucket for a user who hit the limit
 * once and never returned — the prune only fires on `checkAndRecord` for
 * that same key. Real-world scale is tiny (hundreds of users → hundreds of
 * empty bucket entries at worst), so this is a documentation note, not a
 * leak. Per-IP limiters (e.g. /login) self-prune as attackers cycle keys.
 *
 * Auth-stage independence: callers MUST gate via `checkAndRecord` *before*
 * the credential check. A 2FA (or password) failure should count toward
 * the same bucket as a wrong password — an attacker who knows the
 * password shouldn't get unlimited grinding against backup codes.
 *
 * Layer-independent: the limiter applies on every layer (loopback
 * included). A buggy script hammering loopback gets 429'd just like a
 * public attacker. The one wrinkle is `tailscale serve` proxying from
 * `127.0.0.1`, so all tailnet logins share the loopback bucket —
 * acceptable because tailnet is authed at the network layer and brute-
 * force isn't the threat model there.
 *
 * Testable: inject the clock via `now` so the tests can advance time
 * deterministically without `setTimeout`. Per-limiter state is reset via
 * `RateLimiter.reset()` so the test file can clear between cases without
 * recreating the module.
 */

/** `/login` window length: 15 minutes. */
export const WINDOW_MS = 15 * 60 * 1000;
/** `/login` attempts allowed per window. 6th attempt within the window is denied. */
export const MAX_ATTEMPTS = 5;
/**
 * `/account/change-password` window length: 5 minutes. Tighter than
 * `/login`'s 15-minute floor because the endpoint is session-gated —
 * the threat model is a compromised session hammering argon2id, which
 * a smaller window with a smaller cap chokes off without inconveniencing
 * a legitimate user who fat-fingered their current password.
 */
export const CHANGE_PASSWORD_WINDOW_MS = 5 * 60 * 1000;
/**
 * `/account/change-password` attempts allowed per window. 4th attempt
 * within the window is denied. Tighter than `/login`'s 5 because the
 * legitimate-user path here is "I'm rotating my password" — typing the
 * current password wrong 3 times is already an outlier, and a stolen-
 * cookie attacker shouldn't get a 5-shot grind window.
 */
export const CHANGE_PASSWORD_MAX_ATTEMPTS = 3;
/**
 * `/login/2fa` window length: 15 minutes — same as `/login`. The second-
 * factor step (hub#473) sits behind a verified password + a short-lived
 * pending-login token, so the threat model is "attacker who already has the
 * password grinding 6-digit codes / backup codes." A 5-attempt / 15-min
 * bucket per IP turns 10^6-space TOTP grinding into "rotate IPs," same floor
 * as `/login`. Keyed by IP (the pending-login token is short-lived and an
 * attacker could mint many, so IP is the stable actor key here).
 */
export const TOTP_WINDOW_MS = 15 * 60 * 1000;
/** `/login/2fa` attempts allowed per window. 6th within the window is denied. */
export const TOTP_MAX_ATTEMPTS = 5;
/**
 * `POST /account/vault-token/<name>` window length: 10 minutes. The endpoint
 * is session-gated and assignment-capped (a friend can only mint
 * `vault:<assigned>:read|write`), so this limiter isn't the primary defense —
 * it's a floor that stops a compromised session (stolen cookie) from
 * machine-gunning the registry with mint rows. Keyed by user-id (identity is
 * established by the session before the limiter is reached), same posture as
 * the change-password limiter.
 */
export const VAULT_TOKEN_MINT_WINDOW_MS = 10 * 60 * 1000;
/**
 * `POST /account/vault-token/<name>` attempts allowed per window. A friend
 * minting a token for a script does it a handful of times at most; 10 per 10
 * minutes is generous for a human and still chokes a stolen-cookie flood.
 */
export const VAULT_TOKEN_MINT_MAX_ATTEMPTS = 10;
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
   * `Math.max(1, ...)` clamp inside `RateLimiter.checkAndRecord` is a
   * defense-in-depth floor in case the filter logic is ever loosened.
   */
  retryAfterSeconds?: number;
}

/**
 * A configurable sliding-window rate limiter. Each instance owns its own
 * bucket map — limiters with different capacities (`/login` vs
 * `/account/change-password`) don't share state.
 *
 * Shape mirrors the original module-level `checkAndRecord` exactly; this
 * class is the same algorithm, parameterized, so the test suite from
 * hub#188 still applies to the `/login` limiter unchanged.
 */
export class RateLimiter {
  /**
   * Module-level state. `Map<key, attemptsTimestampsMs[]>`. Each array holds
   * raw `Date.now()`-style millisecond timestamps for in-window attempts.
   */
  private readonly buckets: Map<string, number[]> = new Map();

  constructor(
    /** Attempts allowed within the window. */
    private readonly maxAttempts: number,
    /** Window length, in milliseconds. */
    private readonly windowMs: number,
  ) {}

  /**
   * Record an attempt and return whether it's admitted. `key` is whatever
   * identifies the actor for this limiter (client IP for `/login`,
   * user-id for `/account/change-password`). `now` is injected for
   * testability; production callers pass `new Date()`.
   *
   * Behavior:
   *   - Prune timestamps older than `now - windowMs`.
   *   - If remaining count >= maxAttempts, deny with `retryAfterSeconds`
   *     pointing at the oldest in-window timestamp's age-out moment. The
   *     denied attempt is NOT recorded — we don't want a flood of denials
   *     pushing the reset further into the future. The window stays
   *     anchored to the actual N admitted attempts.
   *   - Otherwise admit, append the current timestamp, return allowed.
   */
  checkAndRecord(key: string, now: Date): RateLimitResult {
    const cutoff = now.getTime() - this.windowMs;
    const existing = this.buckets.get(key) ?? [];
    // Drop anything that fell out of the window. Mutating a copy keeps the
    // semantics clear: `pruned` is always the in-window slice.
    const pruned = existing.filter((t) => t > cutoff);

    if (pruned.length >= this.maxAttempts) {
      // Reset moment = oldest in-window attempt + windowMs. `pruned[0]` is
      // the oldest because timestamps are appended in order. Subtract `now`
      // for seconds-until-reset. The unclamped value is provably >= 1 in
      // this branch (see below), but `Math.max(1, ...)` stays as a
      // defense-in-depth floor so Retry-After never reads 0 if the filter
      // logic is ever loosened. Reasoning: the deny branch requires
      // `pruned.length >= maxAttempts`, which implies every entry survived
      // the `t > cutoff` filter, i.e. `pruned[0] > now - windowMs`
      // strictly, i.e. `resetAtMs - now > 0` strictly, i.e.
      // `Math.ceil(positive / 1000) >= 1`.
      const resetAtMs = (pruned[0] ?? now.getTime()) + this.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now.getTime()) / 1000));
      // Denied attempt: the bucket is still full (>= maxAttempts in-window
      // entries), so unconditionally re-store the pruned slice. Persisting
      // the prune keeps stale entries from leaking forward past their
      // window. We do NOT delete here — that branch is structurally
      // unreachable in deny because deny requires a non-empty `pruned`.
      this.buckets.set(key, pruned);
      return { allowed: false, retryAfterSeconds };
    }

    pruned.push(now.getTime());
    this.buckets.set(key, pruned);
    return { allowed: true };
  }

  /**
   * Test-only escape hatch. Production code never calls this; the test
   * files use it between cases so per-limiter state doesn't leak across
   * tests.
   */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * `/login` rate limiter — per-IP, 5 attempts / 15 min. Exported as a
 * singleton so all callers share one bucket map (rotating IPs across the
 * test suite or across a real attack must hit the same backing store).
 */
export const loginRateLimiter = new RateLimiter(MAX_ATTEMPTS, WINDOW_MS);

/**
 * `/account/change-password` rate limiter — per-user, 3 attempts / 5 min.
 * Keyed by user-id (session-gated endpoint, so identity is established
 * before this limiter is reached).
 */
export const changePasswordRateLimiter = new RateLimiter(
  CHANGE_PASSWORD_MAX_ATTEMPTS,
  CHANGE_PASSWORD_WINDOW_MS,
);

/**
 * `/login/2fa` rate limiter — per-IP, 5 attempts / 15 min (hub#473). Bounds
 * second-factor grinding by an attacker who already has the password. Separate
 * bucket from `/login` so a password failure and a TOTP failure don't share a
 * window — but both are per-IP so rotating egress IPs is the only escape, same
 * as the password floor.
 */
export const totpRateLimiter = new RateLimiter(TOTP_MAX_ATTEMPTS, TOTP_WINDOW_MS);

/**
 * `POST /account/vault-token/<name>` rate limiter — per-user, 10 attempts /
 * 10 min (friend vault-token mint). Keyed by user-id (session-gated endpoint,
 * identity established before this limiter is reached). Separate bucket from
 * change-password so a token-mint flurry and a password-change flurry don't
 * share a window.
 */
export const vaultTokenMintRateLimiter = new RateLimiter(
  VAULT_TOKEN_MINT_MAX_ATTEMPTS,
  VAULT_TOKEN_MINT_WINDOW_MS,
);

/**
 * Backwards-compat shim for hub#188's call sites: the original
 * top-level `checkAndRecord` was the login limiter. New code should
 * reach into `loginRateLimiter.checkAndRecord` directly.
 */
export function checkAndRecord(key: string, now: Date): RateLimitResult {
  return loginRateLimiter.checkAndRecord(key, now);
}

/**
 * Backwards-compat shim for hub#188's tests: the original
 * `__resetForTests` cleared the (only) bucket map. We now have two
 * limiters; reset both so any test that called this still gets the
 * fully-clean state it expected.
 */
export function __resetForTests(): void {
  loginRateLimiter.reset();
  changePasswordRateLimiter.reset();
  totpRateLimiter.reset();
  vaultTokenMintRateLimiter.reset();
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
