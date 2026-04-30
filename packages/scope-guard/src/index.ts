/**
 * @openparachute/scope-guard
 *
 * Hub-issued JWT validation for Parachute resource servers. Build a
 * `ScopeGuard` bound to your hub origin once per process, then call
 * `guard.validateHubJwt(token, { expectedAudience? })` on each request.
 *
 * See README.md for the full API rundown and design.
 */

export { extractBearer, looksLikeJwt, parseScopes } from "./parse";
export { hasScope } from "./scope";
export type { JwksGetter, JwksOptions } from "./jwks";
export {
  createScopeGuard,
  HubJwtError,
  type CreateScopeGuardOptions,
  type HubJwtClaims,
  type HubJwtErrorCode,
  type ScopeGuard,
  type ValidateHubJwtOptions,
} from "./validate";
