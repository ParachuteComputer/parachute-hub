/**
 * WebSocket connection caps for the upgrade bridge (hub#649) — the gate
 * before any backed surface goes public-facing.
 *
 * The H1 bridge (`ws-bridge.ts`) holds one client socket + one upstream
 * socket per connection, and the only per-connection bound before this
 * module was the 8 MiB buffered-byte backpressure cap — a public client
 * could hold upgrade slots open indefinitely at near-zero send rate and
 * exhaust daemon memory at ~KB/connection. With the `surface` audience tier
 * (H3, hub#651) anonymous WS is REACHABLE BY DESIGN on surface-audience
 * mounts, so admission control can't lean on auth: the hub needs a blunt
 * concurrent-connection bound of its own.
 *
 * Enforcement lives in `maybeUpgradeWebSocket` (hub-server.ts), which calls
 * {@link WsConnectionTracker.tryAcquire} synchronously right before
 * `server.upgrade()` — over-cap upgrades are refused with a clean HTTP 429
 * (the upgrade never happens, so a normal Response is the correct refusal
 * shape in Bun) BEFORE the proxy commits any socket or upstream-dial
 * resources. The refusal body is generic: it never reveals counts, caps, or
 * which cap tripped (the hub log carries the specifics for the operator).
 *
 * Release rides the bridge's socket lifecycle: the acquire site threads a
 * self-disarming release closure into `ws.data` ({@link
 * WsBridgeData.releaseCap}), and the bridge's Bun-level `close` handler —
 * the single funnel every accepted socket passes through, whatever the
 * teardown reason (client close, upstream close, backpressure, connect
 * failure) — invokes it first thing. A failed `server.upgrade()` releases
 * inline (no socket ⇒ no close callback). The closure latches, so a stray
 * double-close can't corrupt the counters.
 *
 * Defaults (overridable via env, the hub's config precedent —
 * `PARACHUTE_HUB_ORIGIN` et al.):
 *
 *   - {@link DEFAULT_WS_MAX_PER_IP} = 32 per client IP
 *     (`PARACHUTE_WS_MAX_PER_IP`). An owner-operated box realistically
 *     serves a handful of humans; a collab surface opens a socket or two
 *     per tab, so 32 covers a small team behind one NAT egress IP with
 *     headroom, while turning a single-source flood into a rotate-IPs
 *     problem.
 *   - {@link DEFAULT_WS_MAX_TOTAL} = 512 total (`PARACHUTE_WS_MAX_TOTAL`).
 *     Bounds worst-case hub memory under a distributed flood (512 bridged
 *     pairs ≈ low MBs idle) at a ceiling far above any realistic legitimate
 *     concurrent load for a single-operator hub.
 *
 * Keying: callers derive the bucket key with `wsCapBucketKey`
 * (hub-server.ts), which follows the hub's substrate trust model — forwarded
 * IP headers are only believed when the peer is an on-box (loopback)
 * forwarder; direct network peers key by their socket address no matter
 * what headers they inject; an underivable IP lands in one shared bucket
 * (fail closed, same posture as rate-limit.ts's UNKNOWN_IP_SENTINEL).
 */

/** Default cap on concurrent bridged WS connections per client-IP bucket. */
export const DEFAULT_WS_MAX_PER_IP = 32;
/** Default cap on concurrent bridged WS connections across all clients. */
export const DEFAULT_WS_MAX_TOTAL = 512;

/** Env var overriding {@link DEFAULT_WS_MAX_PER_IP}. */
export const WS_MAX_PER_IP_ENV = "PARACHUTE_WS_MAX_PER_IP";
/** Env var overriding {@link DEFAULT_WS_MAX_TOTAL}. */
export const WS_MAX_TOTAL_ENV = "PARACHUTE_WS_MAX_TOTAL";

export interface WsCaps {
  maxPerIp: number;
  maxTotal: number;
}

/**
 * Parse the cap overrides from an env bag. Only positive integers are
 * honored; absent / malformed / non-positive values fall back to the
 * defaults (an operator typo must not silently disable the gate — fail to
 * the safe defaults, never to "unlimited").
 */
export function wsCapsFromEnv(env: NodeJS.ProcessEnv = process.env): WsCaps {
  return {
    maxPerIp: parseCap(env[WS_MAX_PER_IP_ENV], DEFAULT_WS_MAX_PER_IP),
    maxTotal: parseCap(env[WS_MAX_TOTAL_ENV], DEFAULT_WS_MAX_TOTAL),
  };
}

function parseCap(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== raw.trim()) return fallback;
  return n;
}

/** The verdict of {@link WsConnectionTracker.tryAcquire}. */
export type WsAcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "per_ip_cap" | "total_cap" };

/**
 * Concurrent-connection accounting: a per-key map + a global counter.
 *
 * Acquire and release are synchronous and O(1); `tryAcquire` is called in
 * the same synchronous block as `server.upgrade()` (no await between check
 * and commit), so the counters can't race the admission decision.
 *
 * The returned `release` closure is latched — calling it twice decrements
 * once. That makes leaks structurally hard: the caller doesn't need to know
 * which teardown paths can double-fire; any number of invocations after the
 * first are no-ops, and a key's bucket entry is deleted at zero so an
 * attacker cycling keys can't grow the map without also holding sockets.
 */
export class WsConnectionTracker {
  private readonly perKey = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly maxPerKey: number = DEFAULT_WS_MAX_PER_IP,
    private readonly maxTotal: number = DEFAULT_WS_MAX_TOTAL,
  ) {}

  /**
   * Admit-or-refuse a would-be connection for `key`. On admission the slot
   * is counted immediately and the caller MUST either hand the returned
   * `release` to the socket's close path or invoke it inline when the
   * upgrade fails to complete.
   */
  tryAcquire(key: string): WsAcquireResult {
    if (this.total >= this.maxTotal) return { ok: false, reason: "total_cap" };
    const current = this.perKey.get(key) ?? 0;
    if (current >= this.maxPerKey) return { ok: false, reason: "per_ip_cap" };
    this.perKey.set(key, current + 1);
    this.total += 1;

    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        const n = this.perKey.get(key) ?? 0;
        if (n <= 1) this.perKey.delete(key);
        else this.perKey.set(key, n - 1);
        if (this.total > 0) this.total -= 1;
      },
    };
  }

  /** Current global connection count (observability + tests). */
  get totalCount(): number {
    return this.total;
  }

  /** Current count for one key (observability + tests). 0 when absent. */
  countFor(key: string): number {
    return this.perKey.get(key) ?? 0;
  }

  /** Number of distinct keys currently holding connections (leak probe). */
  get keyCount(): number {
    return this.perKey.size;
  }
}

/**
 * The production tracker — one per hub process, shared by every upgrade.
 * Caps come from the env at module load (the hub reads its config once at
 * boot; changing the env requires a restart, same as every other
 * `PARACHUTE_*` knob). Tests construct their own trackers and inject them
 * via `HubFetchDeps.wsConnectionTracker` so they never consume (or depend
 * on) the shared process-level counters.
 */
const bootCaps = wsCapsFromEnv();
export const defaultWsConnectionTracker = new WsConnectionTracker(
  bootCaps.maxPerIp,
  bootCaps.maxTotal,
);
