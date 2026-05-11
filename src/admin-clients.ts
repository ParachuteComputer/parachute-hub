/**
 * Admin endpoints for OAuth client lookup + approval. Standalone surface so
 * the hub's SPA approve-client page can deep-link to "approve this client_id"
 * without round-tripping through the `/oauth/authorize` flow (whose
 * `POST /oauth/authorize/approve` requires a `return_to` authorize URL).
 *
 *   GET  /api/oauth/clients/<client_id>            client details
 *   POST /api/oauth/clients/<client_id>/approve    flip status to approved
 *
 * Both gated by `parachute:host:admin` Bearer (same shape as /api/grants,
 * /api/auth/tokens, etc.). The SPA mints one via the session cookie at
 * `/admin/host-admin-token`.
 *
 * Audit: approval emits a `console.log("client approved: ...")` line in the
 * same `key=value` shape used elsewhere (`grant revoked`, `consent skipped`).
 * `parachute auth approve-client` writes to the same `approveClient` db
 * helper but no audit line — adding one to the CLI is a separate cleanup;
 * the API path logs because cross-machine "who approved this" is the
 * audit-grade signal we'd want when the operator approves from a browser
 * rather than a terminal they own.
 */
import type { Database } from "bun:sqlite";
import {
  type AdminAuthContext,
  type AdminAuthError,
  adminAuthErrorResponse,
  requireScope,
} from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { approveClient, getClient } from "./clients.ts";

export interface AdminClientsDeps {
  db: Database;
  /** Hub origin — passed through to JWT validation as the expected `iss`. */
  issuer: string;
}

export interface AdminClientView {
  client_id: string;
  /** May be null when the client never declared a `client_name` on /oauth/register. */
  client_name: string | null;
  redirect_uris: string[];
  /** Scopes the client requested at registration. The operator approves the client, not these. */
  scopes: string[];
  status: "pending" | "approved";
  registered_at: string;
}

export async function handleGetClient(
  req: Request,
  clientId: string,
  deps: AdminClientsDeps,
): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const client = getClient(deps.db, clientId);
  if (!client) {
    return jsonError(404, "not_found", `no client registered with id ${clientId}`);
  }
  const view: AdminClientView = {
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    scopes: client.scopes,
    status: client.status,
    registered_at: client.registeredAt,
  };
  return new Response(JSON.stringify(view), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export async function handleApproveClient(
  req: Request,
  clientId: string,
  deps: AdminClientsDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", "use POST");
  }
  let ctx: AdminAuthContext;
  try {
    ctx = await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const before = getClient(deps.db, clientId);
  if (!before) {
    return jsonError(404, "not_found", `no client registered with id ${clientId}`);
  }
  // Idempotent — approveClient is a no-op when the row is already approved.
  // The audit line only fires on the actual state change; a no-op approve
  // shouldn't pollute the log with "approved a thing that was already
  // approved" noise from a UI tab re-submit.
  const wasPending = before.status === "pending";
  const ok = approveClient(deps.db, clientId);
  if (!ok) {
    // Race: the row was deleted between getClient and approveClient. Same
    // surface as "no client" — the operator's intent (this client_id is
    // approved or doesn't exist) is satisfied.
    return jsonError(404, "not_found", `no client registered with id ${clientId}`);
  }
  if (wasPending) {
    console.log(
      `client approved: client_id=${clientId} client_name=${before.clientName ?? ""} approver_sub=${ctx.sub}`,
    );
  }
  return new Response(
    JSON.stringify({
      client_id: clientId,
      status: "approved",
      already_approved: !wasPending,
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
    headers: { "content-type": "application/json" },
  });
}
