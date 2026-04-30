import { type JWTPayload, jwtVerify } from "jose";
import { type JwksGetter, type JwksOptions, getOrCreateJwksGetter, resetCache } from "./jwks";
import { parseScopes } from "./parse";

/**
 * Hub-issued JWT validation, factored out of vault/scribe/paraclaw's
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
  | "shape";

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
   * paraclaw's `PARACLAW_HUB_ORIGIN` over `PARACHUTE_HUB_ORIGIN`). Trailing
   * slashes are stripped so the canonical form matches what the hub mints.
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

      return { sub: payload.sub, scopes, aud, jti, clientId };
    },

    resetJwksCache() {
      if (injected) return; // injected getter has no cache we own
      const origin = resolveOrigin(hubOrigin);
      resetCache(origin);
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
