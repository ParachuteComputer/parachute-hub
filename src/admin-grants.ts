/**
 * Admin endpoints for the operator's OAuth-grant skip-list.
 *
 *   GET    /api/grants[?vault=<name>]    list operator's grants
 *   DELETE /api/grants/<client_id>       revoke one grant
 *
 * Both gated by `parachute:host:admin` Bearer (the SPA mints one via the
 * session cookie at `/admin/host-admin-token`). The "operator" is the JWT
 * `sub` — list and revoke are both scoped to that user, so a host-admin
 * token can't enumerate or delete another user's grants. (The hub is
 * single-operator today; this is forward-looking.)
 *
 * The grants table's primary key is composite `(user_id, client_id)`. Since
 * `user_id` is fixed by the bearer, `client_id` alone is sufficient as the
 * URL-segment "id" — and matches the operator's mental model: "revoke this
 * app's access".
 *
 * Optional `?vault=<name>` filter narrows the list to grants whose scope
 * set touches `vault:<name>:*`. The match is per-grant (any matching scope
 * keeps the row); the row's full scope set is still returned, not a slice.
 *
 * Audit: revocation emits a `console.log("grant revoked: ...")` line in the
 * same `key=value` shape as the existing `consent skipped:` line at
 * `oauth-handlers.ts`. No structured-logging infra exists in the hub yet;
 * matching the prevailing format keeps log-grep ergonomics consistent.
 */
import type { Database } from "bun:sqlite";
import {
  type AdminAuthContext,
  type AdminAuthError,
  adminAuthErrorResponse,
  requireScope,
} from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { listGrantsForUser, revokeGrant } from "./grants.ts";

export interface AdminGrantsDeps {
  db: Database;
  /** Hub origin — passed through to JWT validation as the expected `iss`. */
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
}

export interface AdminGrantListing {
  user_id: string;
  client_id: string;
  /** Display name from `clients.client_name`. Null when the client never set one. */
  client_name: string | null;
  scopes: string[];
  granted_at: string;
}

export async function handleListGrants(req: Request, deps: AdminGrantsDeps): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  let ctx: AdminAuthContext;
  try {
    ctx = await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }

  const url = new URL(req.url);
  const vaultFilter = url.searchParams.get("vault");
  if (vaultFilter !== null && !isValidVaultName(vaultFilter)) {
    return jsonError(400, "invalid_request", "?vault must match [a-zA-Z0-9_-]+");
  }

  const grants = listGrantsForUser(deps.db, ctx.sub);
  const filtered = vaultFilter
    ? grants.filter((g) => grantTouchesVault(g.scopes, vaultFilter))
    : grants;

  // One bulk lookup keyed by client_id, instead of N getClient calls. Empty
  // list short-circuits because `IN ()` is a SQL syntax error.
  const names = new Map<string, string | null>();
  if (filtered.length > 0) {
    const placeholders = filtered.map(() => "?").join(",");
    const rows = deps.db
      .query<{ client_id: string; client_name: string | null }, string[]>(
        `SELECT client_id, client_name FROM clients WHERE client_id IN (${placeholders})`,
      )
      .all(...filtered.map((g) => g.clientId));
    for (const r of rows) names.set(r.client_id, r.client_name);
  }

  const enriched: AdminGrantListing[] = filtered.map((g) => ({
    user_id: g.userId,
    client_id: g.clientId,
    client_name: names.get(g.clientId) ?? null,
    scopes: g.scopes,
    granted_at: g.grantedAt,
  }));

  return new Response(JSON.stringify({ grants: enriched }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export async function handleRevokeGrant(
  req: Request,
  clientId: string,
  deps: AdminGrantsDeps,
): Promise<Response> {
  if (req.method !== "DELETE") {
    return jsonError(405, "method_not_allowed", "use DELETE");
  }
  let ctx: AdminAuthContext;
  try {
    ctx = await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }

  // Capture the prior scopes for the audit line — `revokeGrant` only returns
  // a boolean, and we want the deleted scope set on disk in the log.
  const grants = listGrantsForUser(deps.db, ctx.sub);
  const target = grants.find((g) => g.clientId === clientId);
  if (!target) {
    return jsonError(404, "not_found", `no grant for client ${clientId}`);
  }

  const removed = revokeGrant(deps.db, ctx.sub, clientId);
  if (!removed) {
    // Race: another revoke landed between the read and the delete. Treat
    // as 404 since the operator's intent (no grant for this client) is
    // already satisfied.
    return jsonError(404, "not_found", `no grant for client ${clientId}`);
  }
  console.log(
    `grant revoked: client_id=${clientId} user_id=${ctx.sub} scopes=${target.scopes.join(" ")}`,
  );
  return new Response(null, { status: 204 });
}

const VAULT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const VAULT_SCOPE_PREFIX = /^vault:([^:]+):/;

function isValidVaultName(name: string): boolean {
  return VAULT_NAME_RE.test(name);
}

function grantTouchesVault(scopes: readonly string[], vault: string): boolean {
  for (const s of scopes) {
    const m = s.match(VAULT_SCOPE_PREFIX);
    if (m && m[1] === vault) return true;
  }
  return false;
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
