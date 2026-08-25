/**
 * `/api/account/tokens*` — self-service token list / mint / revoke (hub#833).
 *
 * Mounted under `/api/account/*` (`api-account-2fa.ts` routes here), so it
 * inherits that surface's posture:
 *
 *   1. session cookie (else 401) — identity from `session.userId`, never a
 *      client-supplied user id.
 *   2. CSRF double-submit `__csrf` on every mutation (else 403).
 *   3. same-origin belt, applied by the hub-server dispatcher before we run.
 *
 * Routes (`subpath` is relative to `/api/account/tokens`):
 *
 *   GET  ""                 → this user's tokens (unrevoked default;
 *                             `?revoked=all|true|false`)
 *   POST ""                 → mint as the session user
 *   POST "/:jti/revoke"     → revoke own jti only; 404 if not yours
 *                             (no cross-account existence oracle)
 *
 * Operator `/api/auth/tokens` and `/admin/tokens` stay the operator
 * registry. This surface is how a non-operator actually mints without
 * the operator bearer. Attenuation is a subset of THEIR authority
 * (assigned-vault verbs; first-admin requestable scopes). Nobody can
 * mint `parachute:host:*` here.
 *
 * Reuses `signAccessToken` + `recordTokenMint` + assigned-vault
 * authority. No second mint stack.
 */
import type { Database } from "bun:sqlite";
import { ACCOUNT_VAULT_TOKEN_TTL_SECONDS } from "./account-home-ui.ts";
import { inferAudience } from "./jwt-audience.ts";
import {
  TokenMintPrincipalGoneError,
  findTokenRowByJti,
  listTokens,
  recordTokenMint,
  revokeTokenByJti,
  signAccessToken,
} from "./jwt-sign.ts";
import { vaultTokenMintRateLimiter } from "./rate-limit.ts";
import {
  isNonRequestableScope,
  isWellFormedOrNonVaultScope,
  vaultScopeName,
} from "./scope-explanations.ts";
import { type User, isFirstAdmin, vaultVerbsForUserVault } from "./users.ts";

export interface AccountTokensDeps {
  db: Database;
  /** Hub origin — `iss` of minted tokens. Required on POST mint. */
  issuer?: string;
  now?: () => Date;
}

const ACCOUNT_TOKENS_CLIENT_ID = "parachute-account";
const MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
const REVOKE_PATH = /^\/([^/]+)\/revoke$/;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

/**
 * Can this session user mint `requestedScope` on the self-service surface?
 * First admin: any requestable scope except `parachute:host:*`. Friend:
 * `vault:<assigned>:<verb>` they hold. Nobody mints host operator scopes
 * here — those stay on `/api/auth/mint-token`.
 */
export function canAccountSelfMint(db: Database, user: User, scope: string): boolean {
  if (scope.toLowerCase().startsWith("parachute:host:")) return false;
  if (isFirstAdmin(db, user.id)) return !isNonRequestableScope(scope);
  const name = vaultScopeName(scope);
  if (name === null) return false;
  const verb = scope.split(":")[2];
  if (!verb) return false;
  const held = vaultVerbsForUserVault(db, user.id, name);
  return held !== null && (held as readonly string[]).includes(verb);
}

function hasAccountMintAuthority(db: Database, user: User): boolean {
  if (isFirstAdmin(db, user.id)) return true;
  return user.assignedVaults.some((name) => {
    const held = vaultVerbsForUserVault(db, user.id, name);
    return held !== null && held.length > 0;
  });
}

/**
 * Router. `subpath` is relative to `/api/account/tokens` ("" for the
 * collection). The caller (`handleApiAccount`) has already established the
 * session and, for POSTs, the CSRF token.
 */
export async function handleAccountTokens(
  req: Request,
  subpath: string,
  user: User,
  body: Record<string, unknown>,
  deps: AccountTokensDeps,
): Promise<Response> {
  if (req.method === "GET") {
    if (subpath !== "") return jsonError(404, "not_found", "no account route at that path");
    return handleList(req, user, deps);
  }
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", "use GET or POST");
  }
  if (subpath === "") return handleMint(req, user, body, deps);
  const revoke = REVOKE_PATH.exec(subpath);
  if (revoke) return handleRevoke(user, revoke[1]!, deps);
  return jsonError(404, "not_found", `no account route at /api/account/tokens${subpath}`);
}

function handleList(req: Request, user: User, deps: AccountTokensDeps): Response {
  const url = new URL(req.url);
  const raw = url.searchParams.get("revoked") ?? "false";
  if (raw !== "true" && raw !== "false" && raw !== "all") {
    return jsonError(400, "invalid_request", "revoked must be true, false, or all");
  }
  const page = listTokens(deps.db, { filter: { userId: user.id, revoked: raw } });
  return json(200, {
    tokens: page.rows.map((row) => ({
      jti: row.jti,
      user_id: row.userId,
      subject: row.subject,
      client_id: row.clientId,
      scopes: row.scopes,
      expires_at: row.expiresAt,
      revoked_at: row.revokedAt,
      created_at: row.createdAt,
      created_via: row.createdVia,
      subject_pubkey: row.subjectPubkey,
    })),
  });
}

async function handleMint(
  _req: Request,
  user: User,
  body: Record<string, unknown>,
  deps: AccountTokensDeps,
): Promise<Response> {
  if (!deps.issuer) {
    return jsonError(500, "server_error", "hub issuer is not configured");
  }
  if (!user.passwordChanged) {
    return jsonError(
      403,
      "password_change_required",
      "change your password before minting a token",
    );
  }
  if (!hasAccountMintAuthority(deps.db, user)) {
    return jsonError(
      403,
      "insufficient_scope",
      "this account holds no minting authority (no assigned vaults)",
    );
  }
  if (typeof body.scope !== "string" || body.scope.trim().length === 0) {
    return jsonError(400, "invalid_request", "scope is required and must be a non-empty string");
  }
  const scopes = body.scope.split(/\s+/).filter((s) => s.length > 0);
  if (scopes.length === 0) {
    return jsonError(400, "invalid_request", "scope must contain at least one scope");
  }
  const malformed = scopes.filter((s) => !isWellFormedOrNonVaultScope(s));
  if (malformed.length > 0) {
    return jsonError(
      400,
      "invalid_scope",
      `malformed vault scope ${malformed.join(", ")}; expected vault:<name>:<read|write|admin>`,
    );
  }
  const blocked = scopes.filter((s) => !canAccountSelfMint(deps.db, user, s));
  if (blocked.length > 0) {
    return jsonError(
      400,
      "invalid_scope",
      `scope ${blocked.join(", ")} is not grantable by this account`,
    );
  }

  let ttlSeconds = ACCOUNT_VAULT_TOKEN_TTL_SECONDS;
  if (body.expires_in !== undefined) {
    if (
      typeof body.expires_in !== "number" ||
      !Number.isInteger(body.expires_in) ||
      body.expires_in <= 0
    ) {
      return jsonError(400, "invalid_request", "expires_in must be a positive integer (seconds)");
    }
    if (body.expires_in > MAX_TTL_SECONDS) {
      return jsonError(
        400,
        "invalid_request",
        `expires_in exceeds 365d cap (${MAX_TTL_SECONDS} seconds)`,
      );
    }
    ttlSeconds = body.expires_in;
  }

  let label: string = user.id;
  if (body.label !== undefined) {
    if (typeof body.label !== "string" || body.label.length === 0) {
      return jsonError(400, "invalid_request", "label must be a non-empty string when present");
    }
    label = body.label;
  }

  const now = deps.now ?? (() => new Date());
  const gate = vaultTokenMintRateLimiter.checkAndRecord(user.id, now());
  if (!gate.allowed) {
    const retryAfter = gate.retryAfterSeconds ?? 1;
    return json(
      429,
      {
        error: "too_many_attempts",
        error_description: `Too many token-mint attempts. Try again in ${retryAfter} seconds.`,
      },
      { "retry-after": String(retryAfter) },
    );
  }

  const vaultScopePin = [
    ...new Set(scopes.map((s) => vaultScopeName(s)).filter((n): n is string => n !== null)),
  ];
  const minted = await signAccessToken(deps.db, {
    sub: user.id,
    scopes,
    audience: inferAudience(scopes),
    clientId: ACCOUNT_TOKENS_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds,
    vaultScope: vaultScopePin,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  try {
    recordTokenMint(deps.db, {
      jti: minted.jti,
      createdVia: "cli_mint",
      subject: label,
      userId: user.id,
      userUpdatedAt: user.updatedAt,
      clientId: ACCOUNT_TOKENS_CLIENT_ID,
      scopes,
      expiresAt: minted.expiresAt,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  } catch (err) {
    if (err instanceof TokenMintPrincipalGoneError) {
      return jsonError(409, "conflict", err.message);
    }
    throw err;
  }

  return json(200, {
    jti: minted.jti,
    token: minted.token,
    expires_at: minted.expiresAt,
    scope: scopes.join(" "),
  });
}

function handleRevoke(user: User, jti: string, deps: AccountTokensDeps): Response {
  const row = findTokenRowByJti(deps.db, jti);
  // Same 404 for "not yours" and "does not exist" — no cross-account oracle.
  if (!row || row.userId !== user.id) {
    return jsonError(404, "not_found", "no token with that jti");
  }
  const now = deps.now?.() ?? new Date();
  if (!row.revokedAt) revokeTokenByJti(deps.db, jti, now);
  return json(200, { revoked: true, jti });
}
