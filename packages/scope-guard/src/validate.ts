import { type JWTPayload, jwtVerify } from "jose";
import { type JwksGetter, type JwksOptions, getOrCreateJwksGetter, resetCache } from "./jwks";
import { parseScopes } from "./parse";
import {
  type RevocationCache,
  type RevocationFetcher,
  createRevocationCache,
} from "./revocation-cache";

/**
 * Hub-issued JWT validation, factored out of vault/scribe/parachute-agent's
 * near-identical implementations.
 *
 * Trust model:
 *   - The hub origin is the trust pin. `iss` MUST equal it; without that
 *     check, anyone could mint a token against any RSA key and pass JWKS
 *     verification (jose verifies the signature, not who issued the token).
 *   - JWKS is fetched from `<origin>/.well-known/jwks.json`.
 *   - `aud` is strict-checked against `expectedAudience` when supplied —
 *     this is the resource-server backstop for per-resource binding.
 *
 * Scope-shape policy (e.g. "no broad `vault:<verb>` from hub JWTs") is
 * enforced one layer up by the consumer — this function stays focused on
 * JWT-level concerns and is generic across all Parachute resource servers.
 */

/** Surface of claims returned to callers. Everything else is dropped. */
export interface HubJwtClaims {
  /** Subject — operator's stable id. */
  sub: string;
  /** Parsed `scope` claim (whitespace-separated → array). */
  scopes: string[];
  /**
   * Representative audience. When `expectedAudience` is supplied and
   * matches, this is that exact value. Otherwise it's the first array
   * element (or the string itself if `aud` was a single string), or
   * `undefined` if no `aud` claim was present.
   */
  aud: string | undefined;
  /** Token id. Surfaced for logging / future revocation lookups. */
  jti: string | undefined;
  /** Client id from the `client_id` claim, if present. */
  clientId: string | undefined;
}

/** Reasons a hub JWT may fail validation. Each maps to a `HubJwtError.code`. */
export type HubJwtErrorCode =
  | "signature"
  | "issuer"
  | "expired"
  | "kid"
  | "jwks"
  | "audience"
  | "shape"
  /**
   * The token's `jti` is in the hub's revocation list. The token has been
   * intentionally retired by the operator (compromise cleanup, key rotation,
   * etc.) — distinct from "we couldn't load the list," which is `revocation_unavailable`.
   */
  | "revoked"
  /**
   * Couldn't load the revocation list and have no last-good cache yet, so we
   * fail-closed and reject. Operationally distinct from `revoked`: the token
   * may be perfectly valid; the AS side has a problem (hub down, cold start,
   * network blip). Operators chasing a regression need this discrimination
   * at the moment of failure rather than seeing every cold-cache 401 look
   * like an intentional revocation.
   */
  | "revocation_unavailable";

/**
 * Single error class for all validation failures. Branch on `code` rather
 * than catching a subclass — services format their error responses anyway,
 * and a flat error keeps consumer code simple.
 */
export class HubJwtError extends Error {
  override name = "HubJwtError";
  readonly code: HubJwtErrorCode;

  constructor(code: HubJwtErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface CreateScopeGuardOptions {
  /**
   * The hub's origin. Either a literal string or a resolver function — the
   * function form lets consumers layer their own env-var precedence (e.g.
   * parachute-agent's `PARACHUTE_AGENT_HUB_ORIGIN` over
   * `PARACHUTE_HUB_ORIGIN`). Trailing slashes are stripped so the canonical
   * form matches what the hub mints.
   */
  hubOrigin: string | (() => string);

  /** Optional JWKS cache tuning. Defaults: 5min cacheMaxAge, 30s cooldown. */
  jwks?: JwksOptions;

  /**
   * Inject a JWKS getter directly. When provided, the lib uses it verbatim
   * and does NOT consult the cache or `jwks` options. Tests use this to
   * point at a fake JWKS endpoint without needing to register the origin
   * with jose's remote-fetcher; non-default JWKS topologies (e.g. local
   * static keys) can use it to bypass the network entirely.
   */
  jwksGetter?: JwksGetter;

  /**
   * Inject a revocation-list fetcher. Tests use this to drive list contents
   * (revoked / clear / failure) deterministically without needing a real
   * `<origin>/.well-known/parachute-revocation.json` endpoint. Production
   * uses the default fetcher (`globalThis.fetch` against the hub origin).
   */
  revocationFetcher?: RevocationFetcher;

  /**
   * Override the revocation cache TTL (ms). Tests use small values to
   * exercise stale/refresh paths without sleeping. Defaults to 60s, matching
   * hub's published `Cache-Control: max-age=60` on the revocation endpoint.
   */
  revocationTtlMs?: number;

  /**
   * Test seam for time used inside the revocation cache. Defaults to
   * `Date.now`. Override to drive freshness windows deterministically.
   */
  revocationNow?: () => number;
}

export interface ValidateHubJwtOptions {
  /**
   * If set, strict-check the JWT `aud` claim against this exact value.
   * Used by per-resource auth paths: each request derives the expected
   * audience (e.g. `vault.work`) and rejects tokens stamped for a
   * different resource. Pass `null` (or omit) to skip.
   *
   * The audience strict-check is the resource-server backstop. Even if
   * scope narrowing slips upstream, `aud=vault.work` cannot reach
   * `/vault/personal/*` because the audience-mismatch reject fires first.
   */
  expectedAudience?: string | null;
}

export interface ScopeGuard {
  /**
   * Verify a presented JWT. Returns surfaced claims on success; throws
   * `HubJwtError` (with a `code`) on any failure.
   */
  validateHubJwt(token: string, opts?: ValidateHubJwtOptions): Promise<HubJwtClaims>;

  /**
   * Drop the cached JWKS getter for this guard's origin. Tests use this to
   * switch fake JWKS endpoints between cases; production callers shouldn't
   * need it (origin is process-stable, key rotation is handled inside the
   * jose getter by re-fetching after `cacheMaxAge`).
   */
  resetJwksCache(): void;

  /**
   * Drop this guard's revocation-list cache. Tests use this to start cases
   * from a clean fail-closed state; production callers shouldn't need it
   * (the cache refreshes itself on TTL expiry).
   */
  resetRevocationCache(): void;
}

function resolveOrigin(input: string | (() => string)): string {
  const raw = typeof input === "function" ? input() : input;
  return raw.replace(/\/$/, "");
}

/**
 * Build a scope guard bound to a hub origin. The guard holds the JWKS
 * getter, so the cache lives across requests — instantiate once per process
 * and reuse.
 */
export function createScopeGuard(opts: CreateScopeGuardOptions): ScopeGuard {
  const { hubOrigin, jwks: jwksOpts, jwksGetter: injected } = opts;

  function pickGetter(origin: string): JwksGetter {
    if (injected) return injected;
    return getOrCreateJwksGetter(origin, jwksOpts);
  }

  // One revocation cache per guard, lazily bound to whatever the origin
  // resolves to on first use. The hubOrigin resolver may layer env-var
  // precedence (per CreateScopeGuardOptions); we honour that by binding the
  // cache to the resolved value the first time it's needed and rebuilding
  // if the origin ever changes (rare in practice — process-stable).
  let revocation: { origin: string; cache: RevocationCache } | undefined;
  function pickRevocationCache(origin: string): RevocationCache {
    if (revocation && revocation.origin === origin) return revocation.cache;
    const cache = createRevocationCache({
      origin,
      fetcher: opts.revocationFetcher,
      ttlMs: opts.revocationTtlMs,
      now: opts.revocationNow,
    });
    revocation = { origin, cache };
    return cache;
  }

  return {
    async validateHubJwt(token, validateOpts = {}) {
      const origin = resolveOrigin(hubOrigin);
      const getter = pickGetter(origin);

      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(token, getter, { issuer: origin });
        payload = verified.payload;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = classifyJoseError(err);
        throw new HubJwtError(code, `hub JWT verification failed: ${msg}`);
      }

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new HubJwtError("shape", "hub JWT missing required `sub` claim");
      }

      // RFC 7519 §4.1.3: `aud` may be a string OR an array of strings. We
      // unify into an array internally and check membership; the value
      // surfaced to callers collapses to a single representative — the
      // matched expectation when supplied, else the first array element.
      const audRaw = payload.aud;
      const auds: string[] =
        typeof audRaw === "string"
          ? [audRaw]
          : Array.isArray(audRaw)
            ? audRaw.filter((a): a is string => typeof a === "string")
            : [];

      if (validateOpts.expectedAudience != null) {
        if (!auds.includes(validateOpts.expectedAudience)) {
          const got = auds.length === 0 ? "(missing)" : auds.join(", ");
          throw new HubJwtError(
            "audience",
            `hub JWT audience mismatch: expected "${validateOpts.expectedAudience}", got "${got}"`,
          );
        }
      }
      const aud: string | undefined =
        validateOpts.expectedAudience != null ? validateOpts.expectedAudience : auds[0];

      const scopeRaw = (payload as { scope?: unknown }).scope;
      const scopes = typeof scopeRaw === "string" ? parseScopes(scopeRaw) : [];

      const jti = typeof payload.jti === "string" ? payload.jti : undefined;
      const clientIdRaw = (payload as { client_id?: unknown }).client_id;
      const clientId = typeof clientIdRaw === "string" ? clientIdRaw : undefined;

      // Revocation enforcement runs LAST — only consulted if the JWT is
      // otherwise valid. Cheaper checks (signature, iss, aud, expiry) reject
      // first, so a bad signature never costs a network roundtrip. A token
      // with no jti claim can't appear on any revocation list (lists are
      // keyed by jti); we let it through. The hub always stamps jti on
      // OAuth-issued tokens — only ad-hoc/legacy tokens lack one, and those
      // are out of scope for revocation.
      if (jti !== undefined) {
        const cache = pickRevocationCache(origin);
        const outcome = await cache.check(jti);
        if (outcome === "revoked") {
          // Surface the jti in the error message for operator audit visibility.
          // Consumers translate this to a generic 401 for the unauthenticated
          // caller; the jti is a server-side log artifact, not a response body.
          throw new HubJwtError(
            "revoked",
            `hub JWT revoked: jti "${jti}" is in the revocation list`,
          );
        }
        if (outcome === "unknown") {
          throw new HubJwtError(
            "revocation_unavailable",
            "hub JWT cannot be validated: revocation list unavailable (no last-good cache)",
          );
        }
      }

      return { sub: payload.sub, scopes, aud, jti, clientId };
    },

    resetJwksCache() {
      if (injected) return; // injected getter has no cache we own
      const origin = resolveOrigin(hubOrigin);
      resetCache(origin);
    },

    resetRevocationCache() {
      if (revocation) revocation.cache.reset();
      revocation = undefined;
    },
  };
}

/**
 * Translate a jose error into our coarse `code` taxonomy. jose uses string
 * `name`s like `JWTExpired`, `JWTClaimValidationFailed`, `JWSSignatureVerificationFailed`,
 * `JWKSNoMatchingKey`. Anything we can't classify is bucketed as `signature`
 * — a conservative default since the wrapped message still surfaces.
 */
function classifyJoseError(err: unknown): HubJwtErrorCode {
  if (!(err instanceof Error)) return "signature";
  const name = err.name;
  if (name === "JWTExpired") return "expired";
  if (name === "JWKSNoMatchingKey") return "kid";
  if (name === "JWKSInvalid" || name === "JWKSTimeout" || name === "JWKSMultipleMatchingKeys") {
    return "jwks";
  }
  if (name === "JWTClaimValidationFailed") {
    // jose throws this for issuer/audience claim mismatches. We only
    // configure `issuer` on jwtVerify, so map to `issuer`. Audience handling
    // is done by us, not jose, and surfaces as `audience`.
    return "issuer";
  }
  // Low-level fetch failures surface as TypeError when JWKS is unreachable.
  if (name === "TypeError") return "jwks";
  // Generic `JOSEError` for non-200 JWKS HTTP responses (e.g. 503). The
  // typed JWKS* subclasses cover the structural cases above; HTTP-level
  // failures fall through to the base class with a "JSON Web Key Set HTTP
  // response" message.
  if (name === "JOSEError" && /JSON Web Key Set/i.test(err.message)) return "jwks";
  return "signature";
}
