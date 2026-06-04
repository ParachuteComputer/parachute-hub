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
 * Auth — capability attenuation: any bearer may mint a token whose authority
 * is a SUBSET of its own. A requested scope `s` is grantable (`canGrant`) iff:
 *
 *   1. `s` is requestable AND the bearer holds `parachute:host:auth`
 *      — host:auth mints any requestable scope (vault/scribe verbs, etc.).
 *   2. `s` is `vault:<N>:admin` AND the bearer holds `parachute:host:admin`
 *      — box-wide admin attenuates to one named vault's admin.
 *   3. `s` is `vault:<N>:<verb>` (verb ∈ read/write/admin) AND the bearer
 *      holds `vault:<N>:admin` for the SAME `<N>` — a vault-admin attenuates
 *      to any same-vault subset, including an equal-level admin.
 *
 * Otherwise `s` is refused (400 `invalid_scope`). This single rule subsumes
 * the former two-part guard: the old hard `parachute:host:auth` gate is now
 * rule 1, and PR-A's `host:admin → vault:<name>:admin` carve-out (hub#449) is
 * now rule 2. Rule 3 is new — it lets a `vault:<name>:admin` bearer mint
 * same-vault sub-tokens (the canonical headless path to per-vault admin,
 * replacing deprecated `pvt_*` — vault#282 — and the path the SPA tokens
 * page uses via session → /admin/host-admin-token → here). Cross-vault and
 * host-authority escalation are always blocked: a `vault:work:admin` bearer
 * can never mint `vault:other:*` or any `parachute:host:*`.
 *
 * Entry gate: the bearer must hold at least one minting authority —
 * `parachute:host:auth`, `parachute:host:admin`, or some `vault:<*>:admin`.
 * A bearer with none (e.g. a read-only token) gets 403 `insufficient_scope`
 * before any per-scope check; it cannot mint anything.
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
  MINT_HOST_ADMIN_SCOPE,
  MINT_HOST_AUTH_SCOPE,
  canGrant,
  hasMintingAuthority,
  isOperatorBearer,
} from "./scope-attenuation.ts";
import {
  isVaultAdminScope,
  isWellFormedOrNonVaultScope,
  vaultScopeName,
} from "./scope-explanations.ts";

// Re-export `canGrant` so existing importers (and the symmetric revoke path)
// have a single name to reach for; the implementation lives in the shared
// `scope-attenuation.ts` module alongside `hasMintingAuthority`.
export { canGrant } from "./scope-attenuation.ts";

/** Default lifetime when --expires-in / `expires_in` is omitted. Matches the CLI. */
export const API_MINT_TOKEN_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;
/** Hard cap. Matches the CLI's --expires-in upper bound. */
export const API_MINT_TOKEN_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
/**
 * Bearer scope that authorises minting any *requestable* scope (rule 1 of the
 * attenuation model). Re-exported alias of the shared `MINT_HOST_AUTH_SCOPE`
 * for back-compat with existing importers.
 */
export const API_MINT_TOKEN_HOST_AUTH_SCOPE = MINT_HOST_AUTH_SCOPE;
/**
 * Bearer scope that authorises minting `vault:<name>:admin` (rule 2).
 * Re-exported alias of the shared `MINT_HOST_ADMIN_SCOPE`.
 */
export const API_MINT_TOKEN_VAULT_ADMIN_BEARER_SCOPE = MINT_HOST_ADMIN_SCOPE;
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

  // 3. Entry gate — the bearer must hold at least one minting authority
  //    (`parachute:host:auth`, `parachute:host:admin`, or some
  //    `vault:<*>:admin`). A bearer with none can mint nothing under the
  //    attenuation model, so we 403 before per-scope checks. Per-scope
  //    grantability (which authority covers which scope) is enforced below
  //    via `canGrant`.
  if (!hasMintingAuthority(bearerScopes)) {
    return jsonError(
      403,
      "insufficient_scope",
      `bearer token holds no minting authority (need ${API_MINT_TOKEN_HOST_AUTH_SCOPE}, ${API_MINT_TOKEN_VAULT_ADMIN_BEARER_SCOPE}, or vault:<name>:admin)`,
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

  // Shape guard (defensive hygiene — adversarial audit 2026-05-28): reject any
  // scope that is shaped like a *named* per-vault scope but malformed —
  // `vault:work:ADMIN` (uppercase verb), `vault::admin` (empty name),
  // `vault:work:read:admin` (extra segment), `VAULT:work:admin` (uppercase
  // resource). These slip past `isNonRequestableScope`'s strict regexes, so
  // `canGrant` rule 1 would admit them as "requestable" and mint a junk
  // registry row. They grant zero access today (the vault consumer's
  // `decomposeVaultScope` rejects all four), so this is NOT exploitable now —
  // the check is a backstop against a future consumer-normalization regression
  // plus registry hygiene. It's an input-shape check, orthogonal to authority,
  // so it runs for ALL callers before any `canGrant` attenuation. Non-vault
  // scopes and the unnamed `vault:<verb>` forms are unaffected.
  const malformed = scopes.filter((s) => !isWellFormedOrNonVaultScope(s));
  if (malformed.length > 0) {
    return jsonError(
      400,
      "invalid_scope",
      `malformed vault scope ${malformed.join(", ")}; expected vault:<name>:<read|write|admin>`,
    );
  }

  // Capability-attenuation guard: every requested scope must be a subset of
  // the bearer's own authority under `canGrant` (rules in the file docstring).
  // A `parachute:host:auth` bearer mints any requestable scope; a
  // `parachute:host:admin` bearer additionally mints `vault:<name>:admin`; a
  // `vault:<name>:admin` bearer mints same-vault subsets only. Anything else
  // — host:* escalation, cross-vault, a non-requestable with no covering
  // authority — is blocked. One blocked scope rejects the whole request.
  const blocked = scopes.filter((s) => !canGrant(bearerScopes, s));
  if (blocked.length > 0) {
    return jsonError(
      400,
      "invalid_scope",
      `scope ${blocked.join(", ")} is not grantable by this bearer; use OAuth flow or operator rotation`,
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
    // Subject override is an OPERATOR-only capability (audit-attribution
    // forgery otherwise). A host operator (`parachute:host:auth` /
    // `parachute:host:admin`) may stamp a service-account `sub` other than its
    // own — the documented service-account override. A merely vault-scoped
    // bearer (`vault:<N>:admin` only, no host authority) has no business
    // forging the minted token's subject: it would let a vault admin mint a
    // token the registry + revocation list attribute to a foreign subject. So
    // a non-operator bearer may only mint tokens carrying its OWN `sub`.
    if (!isOperatorBearer(bearerScopes) && body.subject !== bearerSub) {
      return jsonError(
        403,
        "insufficient_scope",
        "non-operator bearers may not override subject; omit `subject` to mint under your own identity",
      );
    }
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

  // Derive the `vault_scope` pin. Collect the set of vault names `<N>` from
  // every requested `vault:<N>:<verb>` scope that was authorized via a
  // vault-scoped authority — rule 2 (host:admin → vault:<N>:admin) or rule 3
  // (vault:<N>:admin → same-vault subset). These are the vault-scoped mints,
  // so we pin the token to those vault(s): it can ONLY ever be used against
  // them (defense-in-depth + least privilege), matching the canonical
  // session-path mint in `admin-vault-admin-token.ts`.
  //
  // Pure `parachute:host:auth` requestable mints (a `vault:<N>:read/write`
  // granted by rule 1 with no covering vault-admin authority) stay UNpinned
  // (`[]`) — the "no per-user restriction" sentinel; the scope string +
  // audience are the authorization-bearing gate there, as before. We
  // distinguish by checking the bearer's own vault-scoped authority: a vault
  // name is pinned only when the bearer held `vault:<N>:admin` (rule 3) or
  // host:admin and the scope is admin (rule 2).
  //
  // Note: `audience` is single-valued and `inferAudience` is first-wins, so a
  // multi-vault request gets `aud=vault.<first>` and only authenticates
  // against that vault. Mint one token per vault for the multi-vault case.
  // The canonical consumers (mcp-install, SPA tokens page) request a single
  // vault.
  const bearerHasHostAdmin = bearerScopes.includes(API_MINT_TOKEN_VAULT_ADMIN_BEARER_SCOPE);
  const vaultScopePinSet = new Set<string>();
  for (const s of scopes) {
    const name = vaultScopeName(s);
    if (name === null) continue;
    const grantedByVaultAdminBearer = bearerScopes.includes(`vault:${name}:admin`); // rule 3
    const grantedByHostAdminForAdmin = isVaultAdminScope(s) && bearerHasHostAdmin; // rule 2
    if (grantedByVaultAdminBearer || grantedByHostAdminForAdmin) {
      vaultScopePinSet.add(name);
    }
  }
  const vaultScopePin = [...vaultScopePinSet];

  // 6. Mint + register.
  const minted = await signAccessToken(deps.db, {
    sub: subject,
    scopes,
    audience,
    clientId: API_MINT_TOKEN_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds,
    // Operator-driven CLI/API mint — the bearer already cleared the
    // attenuation guard. `vault_scope` is `[]` (no restriction) for any
    // verb scope granted by rule 1, or the named vault(s) for vault-scoped
    // mints authorized via rule 2 / rule 3 (see above). The pin tracks the
    // grant rule, not the bearer: a host:admin bearer minting
    // `vault:work:write` goes through rule 1 (write is requestable), so it
    // ALSO gets `vault_scope:[]` — only its `vault:work:admin` mints (rule 2)
    // are pinned.
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
