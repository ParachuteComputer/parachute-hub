import { createRemoteJWKSet } from "jose";

/**
 * JWKS getter caching. `jose.createRemoteJWKSet` returns a getter that
 * internally caches keys with a configurable TTL. We hold one getter per
 * origin in a module-scoped map so that retries / kid lookups across
 * `validateHubJwt` calls reuse the same in-flight fetches and the same
 * cached key set.
 *
 * The cache is per-process. jose's getter self-heals for exactly one
 * rotation case: an *unknown kid* (a key it's never seen) triggers a
 * reactive re-fetch inside the getter, rate-limited by `cooldownDuration`.
 * It does NOT self-heal a *same-kid* rotation (the kid is unchanged but the
 * key bytes rotated → `JWSSignatureVerificationFailed`, thrown outside the
 * getter), a no-kid token against a multi-key set (`JWKSMultipleMatchingKeys`),
 * or staleness inside the `cacheMaxAge` window. `cacheMaxAge` is only the
 * *periodic* refresh ceiling — it does not react to a verification failure.
 * `validateHubJwt` covers those gaps with a force-reload-and-retry-once on
 * rotation-class errors (see `forceReloadJwks` below). Tests use
 * `resetCache()` to drop entries between cases (e.g. swapping the fake JWKS
 * endpoint origin).
 */

export type JwksGetter = ReturnType<typeof createRemoteJWKSet>;

/**
 * A JWKS getter that exposes jose's `.reload()` escape hatch. The
 * `createRemoteJWKSet` return carries it (verified in jose v6.2.2 —
 * `remote.d.ts`: `reload: () => Promise<void>`); a test-injected bare-function
 * getter generally does NOT. We narrow at the call site rather than assume,
 * so injected getters without a reload seam degrade to "no forced refresh"
 * instead of crashing.
 *
 * jose types `.reload()` with a `/** @ignore *​/` tag — it's a public runtime
 * member but intentionally undocumented, so it's an API jose could drop in a
 * future major without it being a documented break. The runtime `hasReload`
 * guard is the insurance: if a jose major removes `.reload`, `forceReloadJwks`
 * returns `false` and we degrade to no-retry (the pre-hardening behavior)
 * rather than crashing. Whoever bumps jose past v6 should re-verify `.reload`
 * is still present and re-run the rotation-recovery tests.
 */
type ReloadableGetter = JwksGetter & { reload: () => Promise<void> };

function hasReload(getter: JwksGetter): getter is ReloadableGetter {
  return typeof (getter as { reload?: unknown }).reload === "function";
}

/**
 * Force the getter to re-fetch the JWKS *now*, bypassing jose's
 * `cooldownDuration` gate. This is the recovery seam for rotation-class
 * verification failures that jose's reactive path can't reach on its own
 * (same-kid rotation, no-kid-multi-key, within-`cacheMaxAge` staleness — see
 * the module docstring). Returns `true` when a reload was actually issued,
 * `false` when the getter has no `.reload` (an injected bare function) so the
 * caller can decide not to retry.
 *
 * NOTE: `.reload()` deliberately bypasses the cooldown — callers MUST throttle
 * their own invocations (a flood of genuinely-bad-signature tokens would
 * otherwise drive a refetch storm). `validateHubJwt` owns that throttle.
 *
 * A failed reload (JWKS endpoint down, malformed, etc.) is swallowed and
 * reported as `false`: the caller should then fall through to its original
 * verification error rather than surface a raw jose fetch error. The retry
 * only runs when a reload actually succeeded.
 */
export async function forceReloadJwks(getter: JwksGetter): Promise<boolean> {
  if (!hasReload(getter)) return false;
  try {
    await getter.reload();
    return true;
  } catch {
    return false;
  }
}

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
