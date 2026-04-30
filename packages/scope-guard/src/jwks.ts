import { createRemoteJWKSet } from "jose";

/**
 * JWKS getter caching. `jose.createRemoteJWKSet` returns a getter that
 * internally caches keys with a configurable TTL. We hold one getter per
 * origin in a module-scoped map so that retries / kid lookups across
 * `validateHubJwt` calls reuse the same in-flight fetches and the same
 * cached key set.
 *
 * The cache is per-process; rotation is handled inside jose by re-fetching
 * after `cacheMaxAge` expires. Tests use `resetCache()` to drop entries
 * between cases (e.g. swapping the fake JWKS endpoint origin).
 */

export type JwksGetter = ReturnType<typeof createRemoteJWKSet>;

export interface JwksOptions {
  /** Max age of a cached key set, in ms. Default 5min. */
  cacheMaxAge?: number;
  /** Min interval between failed JWKS fetches, in ms. Default 30s. */
  cooldownDuration?: number;
}

const DEFAULT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 1000;

interface CacheEntry {
  getter: JwksGetter;
  cacheMaxAge: number;
  cooldownDuration: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Resolve (and lazily create) the JWKS getter for a given origin. If the
 * options change between calls for the same origin, the entry is rebuilt —
 * configuration changes are rare but mid-process tuning shouldn't silently
 * use stale settings.
 */
export function getOrCreateJwksGetter(origin: string, opts: JwksOptions = {}): JwksGetter {
  const cacheMaxAge = opts.cacheMaxAge ?? DEFAULT_CACHE_MAX_AGE_MS;
  const cooldownDuration = opts.cooldownDuration ?? DEFAULT_COOLDOWN_MS;
  const existing = cache.get(origin);
  if (
    existing &&
    existing.cacheMaxAge === cacheMaxAge &&
    existing.cooldownDuration === cooldownDuration
  ) {
    return existing.getter;
  }
  const getter = createRemoteJWKSet(new URL(`${origin}/.well-known/jwks.json`), {
    cacheMaxAge,
    cooldownDuration,
  });
  cache.set(origin, { getter, cacheMaxAge, cooldownDuration });
  return getter;
}

/**
 * Drop a single cached entry (or all of them) — tests use this to switch
 * origins between cases. Production callers shouldn't need it; origin is
 * process-stable.
 */
export function resetCache(origin?: string): void {
  if (origin === undefined) {
    cache.clear();
    return;
  }
  cache.delete(origin);
}
