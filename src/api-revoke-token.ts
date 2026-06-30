/**
 * `POST /api/auth/revoke-token` — HTTP companion to `parachute auth
 * revoke-token <jti>` (hub#221) and the backing endpoint for the admin
 * UI's revoke action. Closes hub#220.
 *
 * Auth — capability attenuation, SYMMETRIC to mint-token (hub#452): you may
 * revoke exactly what you could have minted. After validating the bearer
 * (signature / issuer / expiry — same as today):
 *
 *   1. If the bearer holds `parachute:host:auth` → it may revoke ANY jti
 *      (the original, broadest behavior — preserved unchanged).
 *   2. Otherwise the bearer must clear the entry gate — it must hold at least
 *      one minting authority (`parachute:host:auth`, `parachute:host:admin`,
 *      or some `vault:<*>:admin`, via `hasMintingAuthority`). A bearer with
 *      none (e.g. a read-only token) gets 403 up front — it can revoke
 *      nothing, just as it can mint nothing.
 *   3. The per-jti authority check then governs what such a bearer may
 *      actually revoke: the target jti is revocable iff EVERY one of its
 *      recorded scopes satisfies `canGrant(bearerScopes, scope)` — i.e. the
 *      bearer could have minted that exact token. A `vault:work:admin` bearer
 *      can revoke a `vault:work:write` or `vault:work:admin` jti, but NOT a
 *      `vault:other:*` jti and NOT a `parachute:host:*` jti — the same
 *      cross-vault / host-escalation walls mint enforces.
 *
 * Idempotency / no-info-leak: an UNKNOWN jti (no `tokens` row — never minted
 * or already purged) returns the SAME 404 `not_found` the endpoint has always
 * returned, for every caller including host:auth. The per-jti authority check
 * only runs when the row is FOUND. So an attenuated bearer probing a jti it
 * doesn't own cannot distinguish "exists but not yours" from "doesn't exist"
 * by the unknown-jti path — it gets the identical 404 a host:auth bearer
 * would. A jti that EXISTS but is out of the bearer's authority returns 403
 * (and is NOT revoked): the caller already knows the jti string, so "exists
 * but not yours" leaks nothing beyond what it already holds — and returning
 * idempotent-ok there would be a lie (it revoked nothing).
 *
 * Body: `{ jti: string }`.
 *
 * Responses (OAuth 2.0 error-shape vocabulary, matching mint-token):
 *
 *   - 200 `{ jti, revoked_at }` — success. Idempotent: re-revoking an
 *     already-revoked jti returns the existing `revoked_at` and 200.
 *   - 400 `invalid_request` — missing/malformed body, missing jti.
 *   - 401 `unauthenticated` — missing or invalid bearer.
 *   - 403 `insufficient_scope` — bearer holds no minting authority (entry
 *     gate), or the target jti carries a scope the bearer couldn't have
 *     minted (per-jti authority check).
 *   - 404 `not_found` — no `tokens` row matches the jti.
 *   - 405 `method_not_allowed` — non-POST.
 *
 * Identity field in audit-friendly success: not echoed in the response
 * body (the JSON shape is intentionally minimal — `jti` + `revoked_at`
 * is all a UI consumer needs); operator-side audit lives in hub logs.
 */
import type { Database } from "bun:sqlite";
import { findTokenRowByJti, revokeTokenByJti, validateAccessToken } from "./jwt-sign.ts";
import { MINT_HOST_AUTH_SCOPE, canGrant, hasMintingAuthority } from "./scope-attenuation.ts";

/**
 * Scope that authorises revoking ANY jti unconditionally (rule 1). A bearer
 * without it may still revoke via attenuation (rule 3) if it clears the
 * `hasMintingAuthority` entry gate.
 */
export const API_REVOKE_TOKEN_REQUIRED_SCOPE = MINT_HOST_AUTH_SCOPE;

/**
 * Maximum accepted length of a caller-supplied `jti`. A real jti is a UUID or
 * short opaque token; anything materially longer is malformed input. Capping
 * it keeps the verbatim-echoed value out of structured logs from bloating.
 */
export const MAX_JTI_LENGTH = 256;

export interface ApiRevokeTokenDeps {
  db: Database;
  /** Hub origin — used to validate the bearer's `iss`. */
  issuer: string;
  /**
   * SET of origins the hub answers on (loopback ∪ expose-state ∪ platform ∪
   * per-request `issuer`), built via `buildHubBoundOrigins`. The bearer's
   * `iss` is validated against THIS set rather than the single `issuer`, so a
   * credential minted under a still-valid prior origin keeps working across an
   * origin switch (hub#516 parity). Absent → falls back to `[issuer]` (the
   * prior strict per-request behavior; tests/non-HTTP callers unaffected).
   */
  knownIssuers?: readonly string[];
  /** Test seam for time. */
  now?: () => Date;
}

interface RevokeTokenRequest {
  jti?: unknown;
}

export async function handleApiRevokeToken(
  req: Request,
  deps: ApiRevokeTokenDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", "use POST");
  }

  // 1. Bearer presence + parsing.
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) {
    return jsonError(401, "unauthenticated", "empty bearer token");
  }

  // 2. Bearer validation (signature, issuer, expiry, hub-side revocation).
  let bearerScopes: string[];
  try {
    const validated = await validateAccessToken(
      deps.db,
      bearer,
      deps.knownIssuers ?? [deps.issuer],
    );
    if (typeof validated.payload.sub !== "string" || validated.payload.sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    bearerScopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }

  // 3. Entry gate. A `parachute:host:auth` bearer may revoke anything
  //    (rule 1) and skips the per-jti authority check below. Any other
  //    bearer must hold SOME minting authority (host:admin or a
  //    `vault:<*>:admin`) to attempt a revoke at all — a bearer with none
  //    can revoke nothing under attenuation, so we 403 it here rather than
  //    looking up the jti. Whether such a bearer may revoke a SPECIFIC jti
  //    is decided per-jti in step 5 via `canGrant`.
  const bearerHasHostAuth = bearerScopes.includes(API_REVOKE_TOKEN_REQUIRED_SCOPE);
  if (!bearerHasHostAuth && !hasMintingAuthority(bearerScopes)) {
    return jsonError(
      403,
      "insufficient_scope",
      `bearer token holds no revoke authority (need ${API_REVOKE_TOKEN_REQUIRED_SCOPE}, parachute:host:admin, or vault:<name>:admin)`,
    );
  }

  // 4. Body parsing + field extraction.
  let body: RevokeTokenRequest;
  try {
    body = (await req.json()) as RevokeTokenRequest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(400, "invalid_request", `body must be valid JSON — ${msg}`);
  }
  if (typeof body !== "object" || body === null) {
    return jsonError(400, "invalid_request", "body must be a JSON object");
  }
  if (typeof body.jti !== "string" || body.jti.length === 0) {
    return jsonError(400, "invalid_request", "jti is required and must be a non-empty string");
  }
  // Cap the jti length. It's echoed verbatim into `error_description` and
  // structured log lines; a real jti is a UUID/short token (well under 256
  // chars), so a longer value is malformed input — reject it before it can
  // bloat log lines. JSON-encoded responses already neutralize injection;
  // this is a size guard, not an escaping one.
  if (body.jti.length > MAX_JTI_LENGTH) {
    return jsonError(400, "invalid_request", `jti exceeds ${MAX_JTI_LENGTH}-character maximum`);
  }
  const jti = body.jti;

  // 5. Lookup + per-jti authority + revoke. Order: row-existence first
  // (404 if missing — same response for every caller, no leak), then the
  // attenuation authority check (for non-host:auth bearers), then attempt
  // revoke. Idempotent: if already revoked, surface the existing revoked_at
  // — same CLI semantics from hub#221.
  const existing = findTokenRowByJti(deps.db, jti);
  if (!existing) {
    return jsonError(404, "not_found", `no token with jti ${jti} found in registry`);
  }

  // Per-jti authority (rule 3 / symmetric to mint attenuation). A host:auth
  // bearer skips this — it may revoke anything. Any other bearer may revoke
  // this jti only if EVERY one of its recorded scopes is one the bearer could
  // have minted (`canGrant`). One out-of-authority scope (cross-vault, a
  // host:* scope, etc.) blocks the whole revoke with 403 — and the token is
  // left intact. The caller already knows the jti, so "exists but not yours"
  // leaks nothing beyond what it holds; idempotent-ok would falsely imply a
  // revoke happened.
  if (!bearerHasHostAuth) {
    // A scopeless target (recorded `scopes: []`) would otherwise pass the
    // `canGrant` filter vacuously — `[].filter(...)` is empty, so
    // `ungrantable.length === 0`. That's silently permissive: any bearer
    // clearing the entry gate could revoke a zero-scope token. Such tokens
    // shouldn't exist (the CLI/SPA never mint them), but if one does, only a
    // host:auth bearer may revoke it — a non-host:auth bearer has no
    // attenuation authority that "covers" the empty scope set.
    if (existing.scopes.length === 0) {
      return jsonError(
        403,
        "insufficient_scope",
        `bearer token cannot revoke jti ${jti}: target has no recorded scopes (only ${API_REVOKE_TOKEN_REQUIRED_SCOPE} may revoke a scopeless token)`,
      );
    }
    const ungrantable = existing.scopes.filter((s) => !canGrant(bearerScopes, s));
    if (ungrantable.length > 0) {
      return jsonError(
        403,
        "insufficient_scope",
        `bearer token cannot revoke jti ${jti}: its scope(s) ${ungrantable.join(", ")} are outside the bearer's authority`,
      );
    }
  }

  if (existing.revokedAt) {
    return ok({ jti, revoked_at: existing.revokedAt });
  }

  const now = deps.now?.() ?? new Date();
  const flipped = revokeTokenByJti(deps.db, jti, now);
  if (!flipped) {
    // Race: row vanished or was concurrently revoked between our lookup
    // and the UPDATE. Re-read to surface the now-current revoked_at if
    // someone else won. If still nothing, 404 (the row genuinely went
    // away — a concurrent prune, perhaps).
    const reRead = findTokenRowByJti(deps.db, jti);
    if (reRead?.revokedAt) {
      return ok({ jti, revoked_at: reRead.revokedAt });
    }
    return jsonError(404, "not_found", `no token with jti ${jti} found in registry`);
  }
  return ok({ jti, revoked_at: now.toISOString() });
}

function ok(body: { jti: string; revoked_at: string }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
