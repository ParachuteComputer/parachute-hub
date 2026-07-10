/**
 * OAuth discovery-document contract (RFC 8414 authorization-server metadata +
 * RFC 9728 protected-resource metadata).
 *
 * Both doors serve `/.well-known/oauth-authorization-server` and
 * `/.well-known/oauth-protected-resource` with a byte-identical shape (self-host
 * hub `src/oauth-handlers.ts`, hosted cloud `workers/identity/src/oauth-metadata.ts`).
 * The supported-value arrays and the endpoint layout are the same for both; the
 * only per-door variable is the issuer origin. `expected*Metadata(issuer)`
 * returns the canonical object a door MUST emit — the vector its conformance
 * suite asserts its live `/.well-known/*` response against.
 */

export const RESPONSE_TYPES_SUPPORTED = ["code"] as const;
export const GRANT_TYPES_SUPPORTED = ["authorization_code", "refresh_token"] as const;
export const CODE_CHALLENGE_METHODS_SUPPORTED = ["S256"] as const;
export const TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED = ["none", "client_secret_post"] as const;
export const BEARER_METHODS_SUPPORTED = ["header"] as const;

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  scopes_supported: string[];
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
}

/**
 * The RFC 8414 authorization-server metadata a door must emit for `issuer`.
 * `scopes_supported` is door-advertised (RFC 8414 §2 — advertise only what a
 * client may request), so it is a parameter: pass the door's advertised list.
 */
export function expectedAuthorizationServerMetadata(
  issuer: string,
  scopesSupported: readonly string[],
): AuthorizationServerMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: [...RESPONSE_TYPES_SUPPORTED],
    grant_types_supported: [...GRANT_TYPES_SUPPORTED],
    code_challenge_methods_supported: [...CODE_CHALLENGE_METHODS_SUPPORTED],
    token_endpoint_auth_methods_supported: [...TOKEN_ENDPOINT_AUTH_METHODS_SUPPORTED],
    scopes_supported: [...scopesSupported],
  };
}

/** The RFC 9728 protected-resource metadata a door must emit for `issuer`. */
export function expectedProtectedResourceMetadata(issuer: string): ProtectedResourceMetadata {
  return {
    resource: issuer,
    authorization_servers: [issuer],
    bearer_methods_supported: [...BEARER_METHODS_SUPPORTED],
  };
}
