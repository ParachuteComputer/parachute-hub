/**
 * @openparachute/scope-guard
 *
 * Hub-issued JWT validation for Parachute resource servers. Build a
 * `ScopeGuard` bound to your hub origin once per process, then call
 * `guard.validateHubJwt(token, { expectedAudience? })` on each request.
 *
 * See README.md for the full API rundown and design.
 */

// Note: relative imports MUST carry `.js` extensions even though the source
// files are `.ts`. tsc emits the extension verbatim into dist, and NodeNext-
// strict consumers (e.g. agent's tsc + vitest under Node ESM) require the
// extension to resolve compiled JS modules. Bun + bundler-resolution
// consumers (vault, scribe, hub workspace) resolve `.js` back to `.ts`
// transparently. Dropping the extension breaks NodeNext silently — see #225
// for the bug that motivated 0.2.1.
export { extractBearer, looksLikeJwt, parseScopes } from "./parse.js";
export { enforceVaultScope, hasScope } from "./scope.js";
export type { JwksGetter, JwksOptions } from "./jwks.js";
// Revocation-cache surface: the cache itself is internal — `ScopeGuard` owns
// the lifecycle so downstream RSes don't accidentally instantiate parallel
// caches with diverging policies. The seam exposed here is `RevocationFetcher`
// (a custom fetch shape, e.g. a logged or auth-headered alternative to
// `defaultRevocationFetcher`); callers wire it via `createScopeGuard`'s
// `revocationFetcher` option.
export {
  REVOCATION_CACHE_TTL_MS,
  defaultRevocationFetcher,
  type RevocationFetcher,
  type RevocationListBody,
} from "./revocation-cache.js";
export {
  createScopeGuard,
  HubJwtError,
  type CreateScopeGuardOptions,
  type HubJwtClaims,
  type HubJwtErrorCode,
  type ScopeGuard,
  type ValidateHubJwtOptions,
} from "./validate.js";
