/**
 * @openparachute/door-contract
 *
 * The Parachute *door contract*: the OAuth-issuer + `/account/*` wire types,
 * constants, and conformance vectors that BOTH doors implement — the self-host
 * hub (`@openparachute/hub`, Bun) and the hosted cloud (`@openparachute/cloud`,
 * Cloudflare Workers). Cloud "reproduces the hub's issuer contract exactly";
 * this package is where "exactly" is written down once instead of twice.
 *
 * Sibling to `@openparachute/scope-guard` (which owns resource-server JWT
 * validation + the vault scope matcher). This package owns the DOOR side: the
 * issuer's advertised shape, token constants, the account scope grammar, and the
 * shared conformance corpus.
 *
 * Pure data + types + pure functions — no runtime dependencies, no `jose`, no
 * D1/SQLite. A door imports the constants/types at runtime and drives the
 * conformance helpers from its test suite against its own live handlers.
 *
 * Relative imports carry `.js` extensions (resolved back to `.ts` by bundler +
 * bun consumers) so a future NodeNext/npm build stays a mechanical flip — the
 * `@openparachute/scope-guard` convention, see its #225.
 */

export {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  REFRESH_GRACE_MS,
  TOKEN_TYPE,
  SIGNING_ALG,
  type AccessTokenClaims,
  type TokenResponse,
} from "./tokens.js";

export {
  type AccountVerb,
  ACCOUNT_VERB_RANK,
  ACCOUNT_SELF_ID,
  ACCOUNT_SELF_ADMIN_SCOPE,
  ACCOUNT_SELF_READ_SCOPE,
  isAccountVerb,
  accountScope,
  parseAccountScope,
  hasAccountScope,
} from "./scopes.js";

export {
  RESPONSE_TYPES_SUPPORTED,
  GRANT_TYPES_SUPPORTED,
  CODE_CHALLENGE_METHODS_SUPPORTED,
  TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED,
  BEARER_METHODS_SUPPORTED,
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata,
  expectedAuthorizationServerMetadata,
  expectedProtectedResourceMetadata,
} from "./discovery.js";

export {
  type AccountRoute,
  ACCOUNT_ROUTES,
  type AccountAuthDescriptor,
  type ParachuteAccountDescriptor,
  type AccountPlanSummary,
  type AccountCapabilities,
  type AccountVaultSummary,
  type CreateVaultRequest,
  type MintVaultTokenRequest,
  type AccountBootstrap,
  type AccountSessionResponse,
  type AccountTokenMintResponse,
  type VaultTokenMintResponse,
  ACCOUNT_ERROR_CODES,
  type AccountErrorCode,
} from "./account-contract.js";

export {
  type VaultScopesResult,
  validateVaultScopes,
} from "./vault-scopes.js";

export {
  type ConformanceIssue,
  checkAuthorizationServerMetadata,
  checkProtectedResourceMetadata,
  checkTokenResponseInvariants,
  checkAccountDescriptor,
  checkAccountSessionResponse,
  checkAccountTokenMintResponse,
  checkVaultTokenMintResponse,
  ACCOUNT_ROUTE_VECTORS,
} from "./conformance.js";
