/**
 * Token wire constants + shapes — the single source of truth both doors mint
 * against.
 *
 * These values are currently duplicated byte-for-byte in each door's issuer
 * (self-host hub `src/jwt-sign.ts`, hosted cloud `workers/identity/src/tokens.ts`).
 * They live here so the two can converge on ONE definition; until each door
 * imports them at runtime (plan Phase B), a parity test in each door asserts its
 * local literal still equals the canon here (the drift detector).
 */

/** Access-token lifetime. RS256 JWT, `exp = iat + ACCESS_TOKEN_TTL_SECONDS`. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Opaque refresh-token lifetime (registry-row `expires_at`). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * One-generation rotation grace window (hub#685). A refresh of the immediately-
 * previous (just-rotated) token within this window is a benign concurrent/retried
 * refresh — the family converges onto the live tip instead of being revoked.
 * Anything older, or any replay past the window, still revokes the family.
 */
export const REFRESH_GRACE_MS = 30_000;

/** The `token_type` every token response carries. */
export const TOKEN_TYPE = "Bearer";

/** The JWS `alg` both issuers sign with, advertised in JWKS (`RS256`). */
export const SIGNING_ALG = "RS256";

/**
 * The access-token claim set both issuers emit. Registered claims (`sub`, `iss`,
 * `aud`, `iat`, `exp`, `jti`) plus the Parachute-specific `scope` (space-joined),
 * `client_id`, and `vault_scope` (the narrowed vault-name list, `[]` for
 * unnamed/admin).
 */
export interface AccessTokenClaims {
  /** Space-joined granted scopes. */
  scope: string;
  /** The client the token was issued to (DCR id or a first-party sentinel). */
  client_id: string;
  /** Narrowed vault names; `[]` when unnamed or admin. */
  vault_scope: string[];
  /** Subject — the user/account id. */
  sub: string;
  /** Issuer origin. */
  iss: string;
  /** Audience — the resource this token is spendable against. */
  aud: string;
  iat: number;
  exp: number;
  /** JWT id — the revocation + refresh-family key. */
  jti: string;
}

/**
 * The `POST /oauth/token` success body. `services` is the discovery catalog
 * (resource → URL); `vault` is the app-client convenience field, emitted only
 * when the granted scopes name exactly one vault.
 */
export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: typeof TOKEN_TYPE;
  /** Always `ACCESS_TOKEN_TTL_SECONDS`. */
  expires_in: number;
  scope: string;
  services?: Record<string, { url: string }>;
  vault?: string;
}
