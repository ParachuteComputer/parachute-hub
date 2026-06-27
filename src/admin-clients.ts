/**
 * Admin endpoints for OAuth client lookup + approval. Standalone surface so
 * the hub's SPA approve-client page can deep-link to "approve this client_id"
 * without round-tripping through the `/oauth/authorize` flow (whose
 * `POST /oauth/authorize/approve` requires a `return_to` authorize URL).
 *
 *   GET    /api/oauth/clients/<client_id>          client details
 *   POST   /api/oauth/clients/<client_id>/approve  flip status to approved
 *   DELETE /oauth/clients/<client_id>              deregister (RFC 7592) — note
 *                                                  the TOP-LEVEL prefix, see
 *                                                  handleDeleteClient
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
 *
 * ## OAuth resume via `return_to` (workstream D, AUDIT-UI-UX.md §5 row D)
 *
 * The SPA approve page (`web/ui/src/routes/ApproveClient.tsx`) was a
 * documented dead-end pre-D: it flipped the client to approved, then told
 * the operator to "return to the app and retry" — the parked OAuth flow
 * had no way to resume.
 *
 * D adds the affordance, not a behaviour change for existing callers. If
 * the POST body carries a `return_to` JSON field that's a hub-relative
 * `/oauth/authorize?...` URL, the response echoes it back as `redirect_to`
 * and the SPA navigates the browser there to resume the flow. Callers
 * that don't pass `return_to` (the "share this link with another admin"
 * case the unauth pending-client CTA renders) get the unchanged response
 * shape; the SPA renders its dead-end success state and the deep-link
 * UX is preserved.
 *
 * Two cases, one route — `return_to` is the discriminator. The pattern
 * doc is `parachute-patterns/patterns/oauth-dcr-approval.md` §"SPA
 * approve page (two cases, one route)".
 *
 * Validation reuses `isSafeAuthorizeReturnTo` from oauth-handlers.ts so
 * the SPA endpoint and the inline `/oauth/authorize/approve` endpoint
 * apply the same gate — single source of truth for "what's a valid OAuth
 * resume target?" Off-origin or non-authorize values are silently dropped
 * (the response omits `redirect_to`) rather than 4xx'ing — a bad
 * `return_to` shouldn't block an otherwise-legitimate approve.
 */
import type { Database } from "bun:sqlite";
import {
  type AdminAuthContext,
  type AdminAuthError,
  adminAuthErrorResponse,
  requireScope,
} from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { approveClient, deleteClient, getClient } from "./clients.ts";
import { isSafeAuthorizeReturnTo } from "./oauth-handlers.ts";

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
  /**
   * True when the client was registered by the operator of this hub
   * (bearer hub:admin OR session-cookie + same-origin DCR). Used by the
   * authorize handler to auto-approve non-admin scopes (hub#312). Surfaced
   * here so future SPA views can badge same-hub vs external clients.
   */
  same_hub: boolean;
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
    same_hub: client.sameHub,
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
  // Parse the body OPTIONALLY — pre-D callers send no body at all, so a
  // missing / empty / non-JSON body is fine. Only fish out `return_to` when
  // the caller actually provided a parseable JSON object; everything else
  // is treated as "no return_to specified," same as pre-D.
  const returnTo = await readReturnTo(req);
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
  // Only echo `redirect_to` when the caller's `return_to` passed the gate.
  // Bad / missing values just drop off the response — the SPA falls back
  // to its dead-end success state. We don't 4xx an otherwise-legitimate
  // approve over a bad return_to (the client is now approved either way).
  const body: ApproveClientResponse = {
    client_id: clientId,
    status: "approved",
    already_approved: !wasPending,
  };
  if (returnTo !== null && isSafeAuthorizeReturnTo(returnTo)) {
    body.redirect_to = returnTo;
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/**
 * RFC 7592 Dynamic Client Registration *deletion* (deregistration).
 *
 *   DELETE /oauth/clients/<client_id>    remove the client + its cascade
 *
 * Mounted at the TOP-LEVEL `/oauth/clients/` prefix (NOT under `/api/...`)
 * because that's the path parachute-surface's remove-flow actually calls
 * (`packages/surface-host/src/dcr.ts` → `DELETE <hub>/oauth/clients/<id>`),
 * carrying the operator token as a Bearer. Before this route existed the
 * hub 404'd every such DELETE, so every Notes/Claude reconnect orphaned a
 * `clients` row in the operator's DB (closes hub#640, 4/5 boxes — the GC
 * reaper for legacy orphans is a separate follow-up).
 *
 * Auth mirrors `handleGetClient`: `parachute:host:admin` Bearer via
 * `requireScope`. Returns 204 (no content) on a successful delete, 404 when
 * the client isn't registered — the same shape the surface already tolerates
 * (`hubDeleteStatus: "ok"` on 200/204, `"not_found"` on a JSON 404).
 *
 * Audit: emits a `client deleted: ...` line in the same `key=value` shape as
 * the `client approved: ...` line, so cross-machine "who removed this client"
 * is greppable in hub.log.
 */
export async function handleDeleteClient(
  req: Request,
  clientId: string,
  deps: AdminClientsDeps,
): Promise<Response> {
  if (req.method !== "DELETE") {
    return jsonError(405, "method_not_allowed", "use DELETE");
  }
  let ctx: AdminAuthContext;
  try {
    ctx = await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  // Capture the name BEFORE deleting so the audit line can carry it.
  const before = getClient(deps.db, clientId);
  const removed = deleteClient(deps.db, clientId);
  if (!removed) {
    return jsonError(404, "not_found", `no client registered with id ${clientId}`);
  }
  console.log(
    `client deleted: client_id=${clientId} client_name=${before?.clientName ?? ""} remover_sub=${ctx.sub}`,
  );
  // 204 No Content — RFC 7592 §2.3 prescribes 204 for a successful delete.
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

interface ApproveClientResponse {
  client_id: string;
  status: "approved";
  already_approved: boolean;
  /**
   * Hub-relative `/oauth/authorize?...` URL the SPA should navigate to
   * after approving, to resume a parked OAuth flow. Only present when the
   * POST body's `return_to` passed `isSafeAuthorizeReturnTo`. Absent for
   * the share-link case (no `return_to` provided) so the SPA's dead-end
   * success state still renders.
   */
  redirect_to?: string;
}

/**
 * Pull `return_to` out of the request body if present. Tolerant by design:
 * pre-D callers (and tests, and curl probes) send no body or a non-JSON
 * body, and the endpoint MUST continue to work in those shapes. Any parse
 * failure or missing field returns null; the response omits `redirect_to`
 * accordingly.
 *
 * Only `application/json` bodies are inspected — keeping the format
 * restricted to JSON matches the existing API conventions (the SPA's
 * other admin POSTs use JSON throughout) and avoids parser ambiguity
 * over form-encoded variants on a deliberately optional field.
 */
async function readReturnTo(req: Request): Promise<string | null> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) return null;
  try {
    const body = (await req.json()) as { return_to?: unknown };
    if (typeof body?.return_to !== "string") return null;
    return body.return_to;
  } catch {
    return null;
  }
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
