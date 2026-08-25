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
import {
  TokenMintPrincipalGoneError,
  recordTokenMint,
  signAccessToken,
  validateAccessToken,
} from "./jwt-sign.ts";
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
import { getUserById, resolveUser } from "./users.ts";

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
  /**
   * SET of origins the hub legitimately answers on (loopback ∪ expose-state ∪
   * platform ∪ per-request `issuer`), built via `buildHubBoundOrigins`. The
   * caller's bearer `iss` is validated against THIS set rather than the single
   * `issuer`, so a credential minted under a still-valid prior origin keeps
   * minting across an origin switch (hub#516 parity — the live "mint refused"
   * after `set-origin`). Minted tokens still carry the single canonical
   * `issuer` as their `iss`. Absent → falls back to `[issuer]` (the prior
   * strict per-request behavior; tests/non-HTTP callers unaffected).
   */
  knownIssuers?: readonly string[];
  /**
   * Names of vault instances currently registered in services.json (item D /
   * hub#450). When provided, a `vault:<name>:admin` mint whose `<name>` is not
   * in this set is rejected with 400 — a typo'd name can no longer mint
   * `vault:typo:admin` (an unusable token that authenticates against no real
   * vault, only confusing automation that's debugging a typo). Mirrors the
   * session-cookie path (`/admin/vault-admin-token/<name>`), which already
   * 404s unknown vault names via `knownVaultNames.has`.
   *
   * Optional: when undefined the existence check is skipped (the documented
   * "caller is responsible for a real vault name" fallback, and the shape used
   * by unit tests that don't wire a manifest). Production wires it from
   * services.json in hub-server.ts.
   */
  knownVaultNames?: ReadonlySet<string>;
  /** Test seam for time. */
  now?: () => Date;
  /**
   * Test seam (hub#833): runs after `signAccessToken` and before
   * `recordTokenMint`. The CAS insert is what keeps a signed JWT from
   * leaking when the target account vanishes during the crypto await;
   * this hook is how the race test deletes / resets the user in that
   * window. Production callers omit it.
   */
  afterSign?: (ctx: { token: string; jti: string; userId: string | null }) => void | Promise<void>;
}

interface MintTokenRequest {
  scope?: unknown;
  audience?: unknown;
  expires_in?: unknown;
  /** @deprecated Use `label` (display) or `user` (account principal). */
  subject?: unknown;
  label?: unknown;
  user?: unknown;
  service?: unknown;
  permissions?: unknown;
}

export async function handleApiMintToken(req: Request, deps: ApiMintTokenDeps): Promise<Response> {
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", "use POST");
  }

  // 1. Bearer presence + parsing.
  const auth = req.headers.get("authorization");
  // Bearer scheme is case-insensitive per RFC 7235; token passed verbatim (V1.4/C1.3 parity).
  if (!auth || !/^Bearer\s+/i.test(auth)) {
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
    const validated = await validateAccessToken(
      deps.db,
      bearer,
      deps.knownIssuers ?? [deps.issuer],
    );
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

  // Item B / hub#451 — bare (unnamed) `vault:admin` is non-requestable on the
  // HEADLESS mint path. The unnamed `vault:admin` form is a broad full-vault
  // admin grant with no resource pin (`aud=vault`, `vault_scope=[]`); minting
  // it via a host:auth bearer here would issue a surprising un-narrowed admin
  // credential. Vault rejects broad `vault:admin` on hub-JWTs anyway (it forces
  // resource-narrowing — `parachute-vault/src/auth.ts:428`), so the practical
  // blast radius is low, but a headless caller should never be handed it.
  //
  // This is mint-side, NOT in the OAuth-shared `NON_REQUESTABLE_SCOPES`, on
  // purpose: the public `/oauth/authorize` flow legitimately accepts an unnamed
  // `vault:admin` and NARROWS it to `vault:<picked>:admin` via the vault picker
  // (oauth-handlers.ts `narrowVaultScopes`) before any token is minted. Adding
  // it to `NON_REQUESTABLE_SCOPES` would reject that narrowing flow (the
  // requestability gate fires on the raw, pre-narrow scopes). Named
  // `vault:<name>:admin` — the post-narrow form — stays mintable. `vault:read`
  // / `vault:write` unnamed are unaffected (they carry no admin authority).
  const bareVaultAdmin = scopes.filter((s) => s === "vault:admin");
  if (bareVaultAdmin.length > 0) {
    return jsonError(
      400,
      "invalid_scope",
      "bare vault:admin is not mintable headlessly; request a resource-narrowed vault:<name>:admin instead",
    );
  }

  // Item D / hub#450 — vault-existence check for `vault:<name>:admin` mints.
  // The session-cookie path (`/admin/vault-admin-token/<name>`) already 404s an
  // unknown vault name; this mirrors it for the bearer path so a typo can't mint
  // `vault:typo:admin` — an unusable token (it authenticates against no real
  // vault) that only confuses automation debugging a typo. Gated on `<name>:admin`
  // (the one form #450 calls out); read/write are left alone (even more harmless,
  // and the broad-requestable path). Skipped entirely when `knownVaultNames` is
  // absent (the documented "caller responsible" fallback + unit-test shape).
  if (deps.knownVaultNames !== undefined) {
    const unknownAdminVaults = scopes.filter((s) => {
      if (!isVaultAdminScope(s)) return false;
      const name = vaultScopeName(s);
      return name !== null && !deps.knownVaultNames!.has(name);
    });
    if (unknownAdminVaults.length > 0) {
      return jsonError(
        400,
        "invalid_scope",
        `no vault named ${unknownAdminVaults
          .map((s) => `"${vaultScopeName(s)}"`)
          .join(", ")} in this hub; create the vault before minting an admin token for it`,
      );
    }
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

  // Identity (hub#833): person-mint JWT `sub` is always `users.id`.
  // `tokens.subject` is a display label. `subject` (body) is a deprecated
  // alias of `label`, unless the value matches a hub account — then it is
  // treated as `user` (one-release back-compat). Never silently mint a
  // fake principal.
  const warnings: string[] = [];
  const asNonEmpty = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  const readOptional = (
    value: unknown,
    present: boolean,
    field: string,
  ): { ok: true; value: string | null } | { ok: false; res: Response } => {
    if (!present) return { ok: true, value: null };
    const parsed = asNonEmpty(value);
    if (parsed === null) {
      return {
        ok: false,
        res: jsonError(400, "invalid_request", `${field} must be a non-empty string when present`),
      };
    }
    return { ok: true, value: parsed };
  };
  const labelField = readOptional(body.label, body.label !== undefined, "label");
  if (!labelField.ok) return labelField.res;
  const userField = readOptional(body.user, body.user !== undefined, "user");
  if (!userField.ok) return userField.res;
  const serviceField = readOptional(body.service, body.service !== undefined, "service");
  if (!serviceField.ok) return serviceField.res;
  const subjectField = readOptional(body.subject, body.subject !== undefined, "subject");
  if (!subjectField.ok) return subjectField.res;

  if (userField.value && serviceField.value) {
    return jsonError(400, "invalid_request", "pass user OR service, not both");
  }

  let asUser = userField.value;
  const asService = serviceField.value;
  let asLabel = labelField.value;
  if (subjectField.value !== null) {
    if (asUser || asService || asLabel) {
      return jsonError(
        400,
        "invalid_request",
        "`subject` is deprecated; pass `user`, `label`, or `service` instead (not together with `subject`)",
      );
    }
    const matched = resolveUser(deps.db, subjectField.value);
    if (matched) {
      warnings.push(
        "`subject` is deprecated; treating as `user` because it matches a hub account. JWT sub is the account id.",
      );
      asUser = matched.id;
    } else {
      warnings.push(
        "`subject` is deprecated; treating as `label`. JWT sub stays the bearer account id.",
      );
      asLabel = subjectField.value;
    }
  }

  let jwtSub: string;
  let mintUserId: string | null = null;
  let mintUserUpdatedAt: string | undefined;
  let subjectLabel: string;
  if (asService) {
    if (!isOperatorBearer(bearerScopes)) {
      return jsonError(
        403,
        "insufficient_scope",
        "non-operator bearers may not mint a service principal; omit `service` to mint under your own account",
      );
    }
    jwtSub = asService;
    subjectLabel = asLabel ?? asService;
  } else if (asUser) {
    const target = resolveUser(deps.db, asUser);
    if (!target) {
      return jsonError(400, "invalid_request", `no hub account matching user "${asUser}"`);
    }
    if (!isOperatorBearer(bearerScopes) && target.id !== bearerSub) {
      return jsonError(
        403,
        "insufficient_scope",
        "non-operator bearers may not mint as another account; omit `user` to mint under your own identity",
      );
    }
    jwtSub = target.id;
    mintUserId = target.id;
    mintUserUpdatedAt = target.updatedAt;
    subjectLabel = asLabel ?? target.id;
  } else {
    const bearerUser = getUserById(deps.db, bearerSub);
    if (!bearerUser) {
      return jsonError(
        401,
        "unauthenticated",
        "bearer subject is not a hub user; person-mint requires a users.id principal",
      );
    }
    jwtSub = bearerUser.id;
    mintUserId = bearerUser.id;
    mintUserUpdatedAt = bearerUser.updatedAt;
    subjectLabel = asLabel ?? bearerUser.id;
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

  // 6. Mint + register. Person-mint JWT sub is users.id; service mint uses
  // the service name. Registry insert for person-mints is a CAS against the
  // users row (hub#833) so a delete/reset racing the crypto await cannot
  // land a live unregistered JWT.
  const minted = await signAccessToken(deps.db, {
    sub: jwtSub,
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

  if (deps.afterSign) {
    await deps.afterSign({ token: minted.token, jti: minted.jti, userId: mintUserId });
  }

  try {
    recordTokenMint(deps.db, {
      jti: minted.jti,
      createdVia: "cli_mint",
      subject: subjectLabel,
      ...(mintUserId
        ? { userId: mintUserId, ...(mintUserUpdatedAt ? { userUpdatedAt: mintUserUpdatedAt } : {}) }
        : {}),
      clientId: API_MINT_TOKEN_CLIENT_ID,
      scopes,
      expiresAt: minted.expiresAt,
      ...(permissionsCanonical !== undefined ? { permissions: permissionsCanonical } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  } catch (err) {
    if (err instanceof TokenMintPrincipalGoneError) {
      return jsonError(409, "conflict", err.message);
    }
    throw err;
  }

  return new Response(
    JSON.stringify({
      jti: minted.jti,
      token: minted.token,
      expires_at: minted.expiresAt,
      scope: scopes.join(" "),
      ...(permissionsClaim !== undefined ? { permissions: permissionsClaim } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
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
