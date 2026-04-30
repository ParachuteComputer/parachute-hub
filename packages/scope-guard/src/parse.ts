/**
 * Cheap parsers + extractors used by every consumer of the lib. None of these
 * touch the network or the JWKS cache — they're pure string functions.
 */

/**
 * A presented bearer token is JWT-shaped iff it begins with `eyJ` — the
 * base64url encoding of `{"` from a `{"alg":...}` JSON header. Cheap
 * pre-check so we don't try to verify shared-secret / `pvt_*` tokens as JWTs.
 */
export function looksLikeJwt(token: string): boolean {
  return token.startsWith("eyJ");
}

/**
 * Parse a whitespace-separated OAuth `scope` claim into a scope list.
 *
 *   - Empty / null / undefined → []
 *   - Trim + split on any whitespace
 *   - Unrecognized scopes are preserved as-is — `hasScope` decides what
 *     each satisfies. The lib doesn't enforce a vocabulary.
 */
export function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pull the bearer token off an `Authorization` header. Case-insensitive on
 * the scheme; tolerant of extra whitespace. Returns `undefined` if the
 * header is missing, malformed, or non-Bearer.
 */
export function extractBearer(authHeader: string | null | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m || m[1] === undefined) return undefined;
  const token = m[1].trim();
  return token.length > 0 ? token : undefined;
}
