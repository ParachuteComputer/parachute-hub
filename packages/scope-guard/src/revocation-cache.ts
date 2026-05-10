/**
 * Hub revocation list consumer.
 *
 * The hub publishes `<origin>/.well-known/parachute-revocation.json` — the
 * JTIs of revoked, not-yet-expired access tokens. Resource servers fetch on
 * a polling cadence and reject any presented JWT whose jti appears.
 *
 * Cache shape:
 *   - per-hub-origin entry in a module-scoped map (mirrors `jwks.ts`).
 *   - 60s TTL, matching hub's `Cache-Control: max-age=60` on the endpoint.
 *     The constant is duplicated rather than imported because scope-guard
 *     publishes to npm independently of @openparachute/hub — see
 *     `parachute-hub/src/api-revocation-list.ts` for the source of truth.
 *   - lazy: first JWT validation triggers the first fetch.
 *   - synchronous-on-stale: when the cache is older than the TTL, the next
 *     validation awaits a fresh fetch. Simpler than stale-while-revalidate;
 *     the loopback hub roundtrip is fast and the worst-case latency hit is
 *     bounded to one fetch per TTL window.
 *   - single-flight: concurrent validations during a refresh share one
 *     in-flight promise — no thundering herd against the hub.
 *
 * Failure semantics — the security boundary:
 *   - **Fail-open with last-good cache.** If a fetch fails but a previous
 *     successful fetch is still in memory, we keep using it. Worst-case a
 *     revoked token is accepted ~60s past revocation while the hub is
 *     unreachable; that's the published convergence target anyway.
 *   - **Fail-closed on first-fetch-failure.** If we have no last-good cache
 *     (process startup, hub down, or first time we've seen this origin),
 *     reject all hub-issued JWTs until a fetch succeeds. The validator
 *     surfaces this as `HubJwtError` with `code: "revocation_unavailable"`,
 *     distinct from `code: "revoked"` (a JTI actually in the list) so
 *     operators can tell "we couldn't load the list" from "this token has
 *     been retired by the operator."
 */

/** Cache TTL. Mirrors `REVOCATION_LIST_CACHE_SECONDS` in parachute-hub. */
export const REVOCATION_CACHE_TTL_MS = 60_000;

/**
 * Lookup result for a single jti against the cache. `revoked` is the only
 * "reject the JWT" outcome; `unknown` means the cache is empty AND the most
 * recent fetch attempt failed (fail-closed); `clear` means we have a
 * last-good list and the jti isn't in it (the happy path).
 */
export type RevocationCheckOutcome = "clear" | "revoked" | "unknown";

/**
 * Wire shape of `<origin>/.well-known/parachute-revocation.json`. The
 * `generated_at` field is ignored here; it's surfaced by the hub for
 * operator debugging but the consumer just trusts what's in the list.
 */
export interface RevocationListBody {
  generated_at: string;
  jtis: string[];
}

/**
 * Pluggable fetcher. Tests inject a stub; production uses `globalThis.fetch`.
 * The contract: resolve with the parsed list on 2xx; throw on anything else
 * (non-2xx, network failure, malformed JSON). The cache treats any throw as
 * "fetch failed" and falls back to the last-good list (or fail-closed if
 * none exists).
 */
export type RevocationFetcher = (origin: string) => Promise<RevocationListBody>;

/**
 * Default fetcher: GETs `<origin>/.well-known/parachute-revocation.json` and
 * validates the response shape minimally. Anything off → throw.
 */
export const defaultRevocationFetcher: RevocationFetcher = async (origin) => {
  const url = `${origin}/.well-known/parachute-revocation.json`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`revocation list fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as unknown;
  if (
    body == null ||
    typeof body !== "object" ||
    !Array.isArray((body as { jtis?: unknown }).jtis) ||
    !(body as { jtis: unknown[] }).jtis.every((j) => typeof j === "string")
  ) {
    throw new Error("revocation list fetch failed: malformed body");
  }
  return body as RevocationListBody;
};

interface CacheEntry {
  /** Set of revoked jtis — Set lookup avoids O(n) per validation. */
  jtis: Set<string>;
  /** ms-since-epoch when this entry was loaded. Drives TTL freshness. */
  fetchedAt: number;
}

/**
 * One revocation cache instance per `ScopeGuard`. Holds the per-origin
 * last-good entry, the in-flight fetch promise (single-flight), and the
 * fetcher injection seam. Construct via `createRevocationCache`; consumers
 * shouldn't instantiate this directly.
 */
export interface RevocationCache {
  /**
   * Check a jti against the cache. Refreshes synchronously when stale.
   *
   *   - "revoked"  → jti is in the (possibly stale) revocation list.
   *   - "clear"    → cache loaded successfully and jti isn't in it.
   *   - "unknown"  → no last-good cache AND this fetch attempt failed;
   *                  caller MUST fail-closed.
   */
  check(jti: string): Promise<RevocationCheckOutcome>;
  /** Drop the cached entry. Tests use this to start cases from a clean slate. */
  reset(): void;
}

export interface CreateRevocationCacheOptions {
  /** Hub origin (no trailing slash). The cache is bound to this single origin. */
  origin: string;
  /** Override the fetcher — tests use this to drive list contents and failures. */
  fetcher?: RevocationFetcher;
  /** Override the TTL (ms). Tests use small values to exercise refresh paths. */
  ttlMs?: number;
  /** Test seam for time. Defaults to `Date.now`. */
  now?: () => number;
}

export function createRevocationCache(opts: CreateRevocationCacheOptions): RevocationCache {
  const { origin } = opts;
  const fetcher = opts.fetcher ?? defaultRevocationFetcher;
  const ttlMs = opts.ttlMs ?? REVOCATION_CACHE_TTL_MS;
  const now = opts.now ?? (() => Date.now());

  let entry: CacheEntry | undefined;
  let inFlight: Promise<CacheEntry | undefined> | undefined;

  /**
   * Single-flight fetch. Concurrent callers share the same in-flight promise.
   * Returns the new entry on success, undefined on failure. Side-effects:
   *   - on success: replaces `entry`.
   *   - on failure WITH last-good `entry`: bumps `entry.fetchedAt` so the
   *     next check waits another TTL before retrying. Without this we'd
   *     re-attempt the (still-failing) fetch on every single validation
   *     call — a thundering-herd risk while the hub is down. Worst-case
   *     revocation latency degrades to ~2× TTL during an outage, which
   *     stays well within the security envelope.
   *   - on failure WITHOUT last-good `entry`: leaves `entry` undefined so
   *     fail-closed callers retry every check (they're already rejecting
   *     everything; aggressive retry is the only way out of cold-start).
   */
  function refresh(): Promise<CacheEntry | undefined> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const body = await fetcher(origin);
        const next: CacheEntry = { jtis: new Set(body.jtis), fetchedAt: now() };
        entry = next;
        return next;
      } catch {
        // Swallow — caller decides fail-open vs fail-closed based on whether
        // `entry` is set. Logging is the consumer's call (we don't know
        // their logger). When last-good exists, bump its timestamp so we
        // honour the TTL window before retrying — see comment above.
        if (entry) entry = { jtis: entry.jtis, fetchedAt: now() };
        return undefined;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  return {
    async check(jti) {
      const isStale = !entry || now() - entry.fetchedAt >= ttlMs;
      if (isStale) {
        await refresh();
      }
      if (!entry) {
        // First-fetch failed and we have no last-good cache → fail-closed.
        return "unknown";
      }
      return entry.jtis.has(jti) ? "revoked" : "clear";
    },
    reset() {
      entry = undefined;
      inFlight = undefined;
    },
  };
}
