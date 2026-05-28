/**
 * `POST /api/auth/mint-token` — HTTP companion to `parachute auth mint-token`.
 *
 * Same arg/return shape as the CLI; just the network path. Used by:
 *
 *   - automation that doesn't have CLI access (CI runners, cloud agents)
 *     but does hold an operator-bearer with `parachute:host:auth` scope;
 *   - the future admin SPA when the operator wants to mint a one-shot
 *     scope-narrow token without dropping to a terminal.
 *
 * Auth: `Authorization: Bearer <token>` where `token`'s `scope` claim
 * contains `parachute:host:auth`. The operator's local operator.token
 * (admin scope-set) covers this; a narrow `--scope-set=auth` operator
 * token also covers this.
 *
 * Mintable scopes: any requestable scope (vault/scribe/agent verbs, etc.).
 * Non-requestable scopes (`parachute:host:*`, `vault:<name>:admin`) are
 * refused — with ONE de-escalation exception: a bearer that carries
 * `parachute:host:admin` may mint `vault:<name>:admin`, because host:admin
 * already implies box-wide vault administration, so a vault-pinned admin is
 * strictly narrower. That's the canonical headless path to a per-vault admin
 * token (replacing deprecated `pvt_*` — vault#282) and the path the SPA
 * tokens page uses via session → /admin/host-admin-token → here.
 *
 * Why a separate endpoint instead of extending /admin/host-admin-token:
 * that endpoint is session-cookie-gated for the SPA's needs and only
 * mints `parachute:host:admin`. This endpoint is bearer-gated for
 * automation and mints arbitrary scope/permissions tuples per request.
 *
 * Every successful mint writes a row to the `tokens` registry
 * (`created_via='cli_mint'` — same provenance as the CLI path, since
 * HTTP mint is just CLI-by-network). Powers the
 * `/.well-known/parachute-revocation.json` endpoint.
 */
import type { Database } from "bun:sqlite";
import { inferAudience } from "./jwt-audience.ts";
import { recordTokenMint, signAccessToken, validateAccessToken } from "./jwt-sign.ts";
import {
  isNonRequestableScope,
  isVaultAdminScope,
  vaultAdminScopeName,
} from "./scope-explanations.ts";

/** Default lifetime when --expires-in / `expires_in` is omitted. Matches the CLI. */
export const API_MINT_TOKEN_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Hard cap. Matches the CLI's --expires-in upper bound. */
export const API_MINT_TOKEN_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Scope required on the bearer token to call this endpoint. */
export const API_MINT_TOKEN_REQUIRED_SCOPE = "parachute:host:auth";
/**
 * Bearer scope that admits an otherwise-non-requestable `vault:<name>:admin`
 * into a mint request. `parachute:host:admin` already implies box-wide
 * administration of every vault on the hub, so minting a vault-pinned admin
 * from it is a privilege *reduction* (de-escalation), not an escalation —
 * see the design doc `2026-05-28-operator-mintable-vault-admin.md`.
 */
export const API_MINT_TOKEN_VAULT_ADMIN_BEARER_SCOPE = "parachute:host:admin";
/** client_id stamped on minted tokens. Matches the CLI flow's value. */
export const API_MINT_TOKEN_CLIENT_ID = "parachute-hub";

export interface ApiMintTokenDeps {
  db: Database;
  /** Hub origin — written into the JWT `iss` of minted tokens AND used to validate the bearer. */
  issuer: string;
  /** Test seam for time. */
  now?: () => Date;
}

interface MintTokenRequest {
  scope?: unknown;
  audience?: unknown;
  expires_in?: unknown;
  subject?: unknown;
  permissions?: unknown;
}

export async function handleApiMintToken(req: Request, deps: ApiMintTokenDeps): Promise<Response> {
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

  // 2. Bearer validation (signature, issuer, expiry, revocation).
  let bearerSub: string;
  let bearerScopes: string[];
  try {
    const validated = await validateAccessToken(deps.db, bearer, deps.issuer);
    const sub = validated.payload.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    bearerSub = sub;
    bearerScopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }

  // 3. Scope gate.
  if (!bearerScopes.includes(API_MINT_TOKEN_REQUIRED_SCOPE)) {
    return jsonError(
      403,
      "insufficient_scope",
      `bearer token lacks ${API_MINT_TOKEN_REQUIRED_SCOPE}`,
    );
  }

  // 4. Body parsing.
  let body: MintTokenRequest;
  try {
    body = (await req.json()) as MintTokenRequest;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(400, "invalid_request", `body must be valid JSON — ${msg}`);
  }
  if (typeof body !== "object" || body === null) {
    return jsonError(400, "invalid_request", "body must be a JSON object");
  }

  // 5. Required + typed field extraction.
  if (typeof body.scope !== "string" || body.scope.trim().length === 0) {
    return jsonError(400, "invalid_request", "scope is required and must be a non-empty string");
  }
  const scopes = body.scope.split(/\s+/).filter((s) => s.length > 0);
  if (scopes.length === 0) {
    return jsonError(400, "invalid_request", "scope must contain at least one scope");
  }

  // Privilege-diffusion guard: mint paths cannot themselves mint tokens
  // carrying non-requestable scopes (parachute:host:admin, the host:*
  // narrow scopes, vault:<name>:admin). Holder of `parachute:host:auth`
  // can mint vault/scribe/agent verb scopes for downstream services, but
  // cannot mint another `:auth` (or any other non-requestable) without
  // forced re-auth via the operator.token rotation path. Same set the
  // public OAuth flow already rejects.
  //
  // Exception (de-escalation): a bearer that already carries
  // `parachute:host:admin` may mint `vault:<name>:admin`. host:admin
  // implies box-wide administration of every vault on the hub, so pinning
  // it to a single named vault is a privilege *reduction*. This is the
  // canonical headless path to a per-vault admin token (mcp-install via
  // operator.token; SPA via session → host-admin-token → here) and the
  // replacement for the deprecated `pvt_*` admin tokens (vault#282). The
  // host:* narrow scopes and a bare `vault:admin` (no name) stay blocked.
  const bearerHasHostAdmin = bearerScopes.includes(API_MINT_TOKEN_VAULT_ADMIN_BEARER_SCOPE);
  const blocked = scopes.filter((s) => {
    if (!isNonRequestableScope(s)) return false;
    if (bearerHasHostAdmin && isVaultAdminScope(s)) return false;
    return true;
  });
  if (blocked.length > 0) {
    return jsonError(
      400,
      "invalid_scope",
      `scope ${blocked.join(", ")} is not requestable via mint-token; use OAuth flow or operator rotation`,
    );
  }

  let audience: string;
  if (body.audience === undefined) {
    audience = inferAudience(scopes);
  } else if (typeof body.audience === "string" && body.audience.length > 0) {
    audience = body.audience;
  } else {
    return jsonError(400, "invalid_request", "audience must be a non-empty string when present");
  }

  let ttlSeconds = API_MINT_TOKEN_DEFAULT_TTL_SECONDS;
  if (body.expires_in !== undefined) {
    if (typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in)) {
      return jsonError(400, "invalid_request", "expires_in must be a positive integer (seconds)");
    }
    if (!Number.isInteger(body.expires_in) || body.expires_in <= 0) {
      return jsonError(400, "invalid_request", "expires_in must be a positive integer (seconds)");
    }
    if (body.expires_in > API_MINT_TOKEN_MAX_TTL_SECONDS) {
      return jsonError(
        400,
        "invalid_request",
        `expires_in exceeds 365d cap (${API_MINT_TOKEN_MAX_TTL_SECONDS} seconds)`,
      );
    }
    ttlSeconds = body.expires_in;
  }

  let subject: string;
  if (body.subject === undefined) {
    subject = bearerSub;
  } else if (typeof body.subject === "string" && body.subject.length > 0) {
    subject = body.subject;
  } else {
    return jsonError(400, "invalid_request", "subject must be a non-empty string when present");
  }

  let permissionsClaim: Record<string, unknown> | undefined;
  let permissionsCanonical: string | undefined;
  if (body.permissions !== undefined) {
    if (
      typeof body.permissions !== "object" ||
      body.permissions === null ||
      Array.isArray(body.permissions)
    ) {
      return jsonError(400, "invalid_request", "permissions must be a JSON object");
    }
    permissionsClaim = body.permissions as Record<string, unknown>;
    permissionsCanonical = JSON.stringify(permissionsClaim);
  }

  // Derive the `vault_scope` pin. For ordinary verb mints (read/write)
  // this stays `[]` — the "no per-user restriction" sentinel; the scope
  // string + audience are the authorization-bearing gate. For a
  // `vault:<name>:admin` mint (admitted above for host:admin bearers) we
  // pin the named vault(s) so the token can ONLY ever be used against
  // that vault, matching the canonical session-path mint in
  // `admin-vault-admin-token.ts` (defense-in-depth + least privilege).
  //
  // Note: `audience` is single-valued and `inferAudience` is first-wins,
  // so a multi-vault request (`vault:a:admin vault:b:admin`) gets
  // `aud=vault.a` and the resulting token only authenticates against `a`.
  // Mint one token per vault for the multi-vault case. The canonical
  // consumers (mcp-install, SPA tokens page) request a single vault.
  const vaultScopePin = scopes
    .map((s) => vaultAdminScopeName(s))
    .filter((n): n is string => n !== null);

  // 6. Mint + register.
  const minted = await signAccessToken(deps.db, {
    sub: subject,
    scopes,
    audience,
    clientId: API_MINT_TOKEN_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds,
    // Operator-driven CLI/API mint — the bearer already cleared the
    // privilege gate. `vault_scope` is `[]` (no restriction) for verb
    // mints, or the named vault(s) for an admin mint (see above).
    vaultScope: vaultScopePin,
    ...(permissionsClaim !== undefined ? { extraClaims: { permissions: permissionsClaim } } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  recordTokenMint(deps.db, {
    jti: minted.jti,
    createdVia: "cli_mint",
    subject,
    // user_id intentionally omitted — CLI-mint rows store subject only,
    // matching the CLI path's shape (so HTTP and CLI mints look identical
    // in the registry). The bearer's user identity is implicit via the
    // bearer's own user_id (which is in its own tokens row).
    clientId: API_MINT_TOKEN_CLIENT_ID,
    scopes,
    expiresAt: minted.expiresAt,
    ...(permissionsCanonical !== undefined ? { permissions: permissionsCanonical } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  return new Response(
    JSON.stringify({
      jti: minted.jti,
      token: minted.token,
      expires_at: minted.expiresAt,
      scope: scopes.join(" "),
      ...(permissionsClaim !== undefined ? { permissions: permissionsClaim } : {}),
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
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
