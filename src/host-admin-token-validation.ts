/**
 * Issuer validation for the hub's OWN host-admin credentials (the operator
 * token + the SPA host-admin token) on the loopback module-ops surfaces.
 *
 * ## Why this is its own helper (hub#516)
 *
 * The on-box CLI drives the hub on loopback (`127.0.0.1:1939`) presenting
 * `~/.parachute/operator.token` — a hub-SELF-issued JWT (`aud: "operator"`,
 * scope-set carries `parachute:host:admin`). After `parachute expose`, the
 * operator token's `iss` is the hub's PUBLIC origin (e.g.
 * `https://parachute.taildf9ce2.ts.net`), because §3.1 self-heals it there so
 * on-box services validating public-origin bearers accept it.
 *
 * But the hub resolves its issuer PER-REQUEST from the Host header
 * (`resolveIssuer` in hub-server.ts, "closes #245") — so a LOOPBACK request
 * resolves the issuer to `http://127.0.0.1:1939`. The strict per-request
 * `validateAccessToken(db, token, <loopback-issuer>)` then rejects the
 * operator token's PUBLIC `iss` as `unexpected "iss" claim value`. Net:
 * `parachute status` / `start|stop|restart <svc>` fail on ANY exposed box
 * (tailnet or Cloudflare), even though the credential is the hub's own,
 * presented on the hub's own loopback.
 *
 * ## The scoped relaxation
 *
 * The operator token (and the SPA host-admin token) are SELF-issued — the hub
 * signs them with its own key, and {@link validateAccessToken} verifies that
 * signature against the hub's JWKS. The signature already proves provenance:
 * the only tokens that can verify are ones THIS hub minted. So for these
 * host-admin credentials, the `iss` claim should be accepted if it matches ANY
 * origin the hub legitimately answers on — loopback ∪ expose-state public
 * origin ∪ platform/env origin — not just the single per-request one.
 *
 * We deliberately do NOT drop the `iss` check entirely (belt-and-suspenders):
 * a token whose `iss` is none of the hub's known origins is still rejected,
 * so a hypothetical hub-signed token minted for a DIFFERENT origin can't be
 * replayed here.
 *
 * ## What this does NOT touch
 *
 * OAuth / access-token validation (vault / MCP tokens, `aud: "vault.<name>"`)
 * stays STRICT per-request-issuer and lives on entirely separate code paths
 * (the resource servers' own validators, hub's `/api/auth/*`, etc.). This
 * helper is invoked from the two loopback host-admin module surfaces
 * (`/api/modules` GET — the `status` read; `/api/modules/:short/*` POST — the
 * lifecycle ops), both of which already gate on the non-requestable
 * `parachute:host:admin` / `parachute:host:auth` scopes that no OAuth token
 * can carry, and from the per-UI audience gate's Bearer branch
 * (`src/audience-gate.ts`, H3) — same self-issued-token shape, same
 * iss-∈-bound-origins need (a PWA's token carries the public origin while
 * the proxied request resolves the loopback issuer), with the surface's
 * declared `scopes_required` enforced by the gate on top.
 */
import type { Database } from "bun:sqlite";
import { type ValidatedAccessToken, validateAccessToken } from "./jwt-sign.ts";

/**
 * Validate a host-admin bearer (operator token / SPA host-admin token)
 * presented on a loopback module surface, accepting its `iss` against the SET
 * of origins the hub legitimately answers on rather than the single
 * per-request issuer.
 *
 * Verification order:
 *   1. Signature + `exp` + revocation, via {@link validateAccessToken} WITHOUT
 *      an `expectedIssuer` — the signature proves the hub minted it (only this
 *      hub's key can produce a JWS that verifies against its JWKS). A throw
 *      here (bad/unknown/expired kid, jose `exp`, revoked jti) propagates
 *      unchanged.
 *   2. `iss` ∈ `knownIssuers` — belt-and-suspenders. Even though the signature
 *      proves provenance, we still require the issuer to be one of the hub's
 *      own origins. A foreign/garbage `iss` throws (matching the per-request
 *      strict check's message shape so callers' error rendering is unchanged).
 *
 * `knownIssuers` is the hub's own valid origin set — typically built from
 * `buildHubBoundOrigins` (per-request issuer ∪ loopback aliases ∪
 * expose-state public origin ∪ platform/env origin). Empty/garbage entries are
 * the caller's responsibility to filter; an empty set rejects every token
 * (fails closed).
 *
 * @throws Error when the signature/exp/revocation check fails, or when `iss`
 *   is absent / not a string / not in `knownIssuers`.
 */
export async function validateHostAdminToken(
  db: Database,
  token: string,
  knownIssuers: readonly string[],
): Promise<ValidatedAccessToken> {
  // Step 1: signature + exp + revocation, NOT pinning iss. Provenance is
  // proved by the signature verifying against the hub's own JWKS.
  const validated = await validateAccessToken(db, token);

  // Step 2: belt-and-suspenders iss ∈ known-origins. Never widen to arbitrary
  // issuers — the token's iss must be one of the hub's own legitimate origins.
  const iss = validated.payload.iss;
  if (typeof iss !== "string" || !knownIssuers.includes(iss)) {
    // Mirror jose's wording so the CLI's bearer-invalid error path renders the
    // same way it did for the strict per-request check.
    throw new Error('unexpected "iss" claim value');
  }
  return validated;
}
