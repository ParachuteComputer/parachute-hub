/**
 * Agent-connector GRANTS — the approval-gated resource-grant subsystem for
 * vault-native agents (Phase 4b-1, agent-connectors design 2026-06-17).
 *
 * An agent (a `#agent/definition` note in the agent module) declares connections
 * it WANTS beyond its own def-vault — other LOCAL vaults (tag-scoped) and
 * external SERVICE credentials (GitHub, Cloudflare). The agent module registers
 * each as a PENDING grant here; the operator approves per-connection in hub
 * admin; the hub mints (vault) / stores (service) the secret; the agent module
 * fetches the material at spawn and injects it. The `mcp` (remote/OAuth) kind is
 * MODELED but not grantable in 4b-1 — it stays `pending` with a clear reason
 * (slice 2 is hub-as-OAuth-client).
 *
 * The one invariant: **a vault note can only REQUEST; it can never GRANT.** A
 * grant created by the module sits `pending` and grants nothing until the
 * operator approves. Worst case, a note written by anyone sits pending forever.
 *
 * Generalizes the hub's Connections engine from "event→action triggers" to
 * "approval-gated resource grants": same vault-token mint path (`mintVaultGrant`
 * mirrors `admin-connections.ts:mintCredential`), same registered-mint /
 * revoke-on-teardown discipline, same auth gates.
 *
 * ── Endpoints (all under `/admin/grants`) ────────────────────────────────────
 *
 * MODULE-AUTH (a `parachute:host:admin` Bearer — the agent module presents one,
 * minted the same way the SPA mints via `/admin/host-admin-token`):
 *
 *   PUT  /admin/grants                       { agent, connection } → upsert (idempotent
 *                                              by (agent, connection-key)); returns the
 *                                              grant (NO material). New mcp grants land
 *                                              pending with reason "oauth not yet
 *                                              supported".
 *   GET  /admin/grants?agent=<name>          → { grants: [...] } — NO material on any row.
 *   GET  /admin/grants/<id>/material         → APPROVED grants only: the injectable
 *                                              secret. vault → { kind, token, mcpUrl };
 *                                              service → { kind, token, inject }.
 *                                              404 unknown id, 409 not approved.
 *
 * OPERATOR-AUTH (a first-admin session cookie; CSRF-belted by the dispatch in
 * hub-server.ts, exactly like /admin/connections POST/DELETE):
 *
 *   POST /admin/grants/<id>/approve          { token? } → vault: MINT now + store;
 *                                              service: store the pasted `token`. Returns
 *                                              the updated grant (no material).
 *   POST /admin/grants/<id>/revoke           → drop the stored material + status=revoked
 *                                              (the agent loses it next spawn).
 *
 * ── Secret discipline ────────────────────────────────────────────────────────
 * The minted/pasted secret lives in the grant store on disk (0600), is NEVER
 * logged, NEVER returned by PUT/GET-list/approve/revoke — ONLY by the
 * approved-only, module-auth-gated `/material` endpoint.
 */
import type { Database } from "bun:sqlite";
import {
  type AdminAuthContext,
  type AdminAuthError,
  adminAuthErrorResponse,
  requireScope,
} from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import {
  type ConnectionSpec,
  type GrantAccess,
  type GrantInject,
  type GrantRecord,
  connectionKey,
  getGrant,
  grantId,
  listGrantsForAgent,
  putGrant,
  readGrants,
} from "./grants-store.ts";
import {
  type signAccessToken as SignAccessTokenFn,
  recordTokenMint,
  revokeTokenByJti,
  signAccessToken,
} from "./jwt-sign.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";

/**
 * TTL of a minted vault grant token. 90 days — matches the Connections
 * engine's standing-credential posture (a headless agent re-fetches at spawn;
 * a long-lived token spares a re-mint every turn). Registered in the tokens
 * table so revoke can drop it.
 */
const VAULT_GRANT_TTL_SECONDS = 90 * 24 * 60 * 60;
const GRANT_CLIENT_ID = "parachute-hub-spa";

/** Agent-name charset — lands in the grant id + a `?agent=` query. Conservative slug. */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
/** Grant-id charset — lands in a URL path segment. */
const GRANT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Service key charset — `github`, `cloudflare`, … lands in env-var / MCP names. */
const SERVICE_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/i;
/** A tag the agent declares for vault tag-scope. Conservative — no whitespace. */
const TAG_RE = /^\S+$/;

export interface AgentGrantsDeps {
  db: Database;
  /** Hub origin — the minted-token `iss` AND the base of the vault MCP URL. */
  hubOrigin: string;
  /** Absolute path to `agent-grants.json` in the hub state dir. */
  storePath: string;
  /**
   * Resolve a vault's loopback origin from services.json, or `null` when no
   * vault by that name is installed. Mirrors `ConnectionsDeps.resolveVaultOrigin`
   * — used here purely as the "does this vault exist?" check at approve time.
   */
  resolveVaultOrigin: (vaultName: string) => string | null;
  /** Test seam — defaults to the real `signAccessToken`. */
  signToken?: typeof SignAccessTokenFn;
  /** Test seam for the clock. */
  now?: () => Date;
}

// ===========================================================================
// Router
// ===========================================================================

/**
 * Dispatch `/admin/grants...`. `subPath` is the path AFTER `/admin/grants`
 * (`""` for the collection, `/<id>/material|approve|revoke` for items).
 *
 * The two auth classes split by route, mirroring the Connections engine:
 *   - module-auth (host-admin Bearer): PUT collection, GET collection, GET /material.
 *   - operator-auth (first-admin cookie): POST /approve, POST /revoke.
 */
export async function handleAgentGrants(
  req: Request,
  subPath: string,
  deps: AgentGrantsDeps,
): Promise<Response> {
  const method = req.method.toUpperCase();
  const segments = subPath.startsWith("/")
    ? subPath
        .slice(1)
        .split("/")
        .map((s) => decodeURIComponent(s))
        .filter((s) => s.length > 0)
    : [];

  // --- Collection: PUT (upsert) / GET (list) — module-auth. ---
  if (segments.length === 0) {
    if (method === "PUT") return upsertGrant(req, deps);
    if (method === "GET") return listGrants(req, deps);
    return jsonError(405, "method_not_allowed", "use PUT or GET on /admin/grants");
  }

  const id = segments[0] ?? "";
  const verb = segments[1];

  // --- Item: GET /<id>/material — module-auth. ---
  if (verb === "material") {
    if (method !== "GET") {
      return jsonError(405, "method_not_allowed", "use GET on /admin/grants/<id>/material");
    }
    return grantMaterial(req, id, deps);
  }

  // --- Item: POST /<id>/approve | /revoke — operator-auth. ---
  if (verb === "approve") {
    if (method !== "POST") {
      return jsonError(405, "method_not_allowed", "use POST on /admin/grants/<id>/approve");
    }
    return approveGrant(req, id, deps);
  }
  if (verb === "revoke") {
    if (method !== "POST") {
      return jsonError(405, "method_not_allowed", "use POST on /admin/grants/<id>/revoke");
    }
    return revokeGrant(req, id, deps);
  }

  return jsonError(
    404,
    "not_found",
    "use PUT/GET /admin/grants, GET /admin/grants/<id>/material, POST /admin/grants/<id>/approve|revoke",
  );
}

// ===========================================================================
// Auth
// ===========================================================================

/** Module-auth: a `parachute:host:admin` Bearer (the agent module's host-admin token). */
async function requireModuleAuth(
  req: Request,
  deps: AgentGrantsDeps,
): Promise<AdminAuthContext | Response> {
  try {
    return await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.hubOrigin);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
}

/** Operator-auth: a first-admin session cookie (CSRF belt is applied upstream). */
function requireOperator(req: Request, deps: AgentGrantsDeps): { userId: string } | Response {
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  if (!session) {
    return jsonError(401, "unauthenticated", "no admin session — sign in at /login first");
  }
  if (!isFirstAdmin(deps.db, session.userId)) {
    return jsonError(
      403,
      "not_admin",
      "grant approval is restricted to the hub admin — your account home is at /account/",
    );
  }
  return { userId: session.userId };
}

// ===========================================================================
// PUT /admin/grants — upsert a pending grant (module-auth)
// ===========================================================================

async function upsertGrant(req: Request, deps: AgentGrantsDeps): Promise<Response> {
  const auth = await requireModuleAuth(req, deps);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "invalid_request", "body must be JSON");
  }
  if (!body || typeof body !== "object") {
    return jsonError(400, "invalid_request", "body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const agent = typeof b.agent === "string" ? b.agent.trim() : "";
  if (!agent || !AGENT_NAME_RE.test(agent)) {
    return jsonError(
      400,
      "invalid_request",
      "agent is required and must match [a-zA-Z0-9][a-zA-Z0-9_.-]*",
    );
  }

  const parsed = parseConnectionSpec(b.connection);
  if ("error" in parsed) return jsonError(400, "invalid_request", parsed.error);
  const spec = parsed.spec;

  const id = grantId(agent, spec);
  const now = (deps.now?.() ?? new Date()).toISOString();
  const existing = getGrant(deps.storePath, id);

  // Idempotent upsert. An already-approved/revoked grant keeps its status +
  // material on re-declare (the module re-registering the same want must NOT
  // downgrade an active grant to pending, nor re-open a revoked one). A new
  // grant lands pending — mcp pending with its slice-2 reason.
  if (existing) {
    // Re-declare may refresh the agent-side `inject` hints on a service spec
    // without changing the grant's identity (inject is not part of the key).
    const merged: GrantRecord = { ...existing, connection: spec };
    putGrant(deps.storePath, merged);
    return grantResponse(200, merged);
  }

  const pendingReason = spec.kind === "mcp" ? "oauth not yet supported" : undefined;
  const record: GrantRecord = {
    id,
    agent,
    connection: spec,
    status: "pending",
    ...(pendingReason ? { reason: pendingReason } : {}),
    createdAt: now,
  };
  putGrant(deps.storePath, record);
  return grantResponse(201, record);
}

/**
 * Parse + validate a connection spec from the request body. Returns either the
 * normalized spec or a human-readable error. Normalizes `target`/`access`/`tags`
 * to keep the stored shape + derived key stable.
 */
function parseConnectionSpec(raw: unknown): { spec: ConnectionSpec } | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: "connection is required and must be an object" };
  }
  const c = raw as Record<string, unknown>;
  const kind = c.kind;
  if (kind !== "vault" && kind !== "service" && kind !== "mcp") {
    return { error: `connection.kind must be "vault", "service", or "mcp"` };
  }
  const target = typeof c.target === "string" ? c.target.trim() : "";
  if (!target) return { error: "connection.target is required" };

  if (kind === "vault") {
    if (!VAULT_NAME_CHARSET_RE.test(target)) {
      return { error: `connection.target "${target}" is not a valid vault name` };
    }
    let access: GrantAccess = "read";
    if (c.access !== undefined) {
      if (c.access !== "read" && c.access !== "write") {
        return { error: `connection.access must be "read" or "write"` };
      }
      access = c.access;
    }
    const tags: string[] = [];
    if (c.tags !== undefined) {
      if (!Array.isArray(c.tags)) {
        return { error: "connection.tags must be an array of tag strings" };
      }
      for (const t of c.tags) {
        if (typeof t !== "string" || !TAG_RE.test(t.trim()) || t.trim().length === 0) {
          return { error: "connection.tags entries must be non-empty whitespace-free strings" };
        }
        tags.push(t.trim());
      }
    }
    return {
      spec: { kind: "vault", target, access, ...(tags.length > 0 ? { tags } : {}) },
    };
  }

  if (kind === "service") {
    if (!SERVICE_KEY_RE.test(target)) {
      return { error: `connection.target "${target}" is not a valid service key` };
    }
    const inject: GrantInject[] = [];
    if (c.inject !== undefined) {
      if (!Array.isArray(c.inject)) {
        return { error: `connection.inject must be an array of "env"/"mcp"` };
      }
      for (const i of c.inject) {
        if (i !== "env" && i !== "mcp") {
          return { error: `connection.inject entries must be "env" or "mcp"` };
        }
        if (!inject.includes(i)) inject.push(i);
      }
    }
    return {
      spec: { kind: "service", target, ...(inject.length > 0 ? { inject } : {}) },
    };
  }

  // mcp — modeled, not grantable in 4b-1. Accept a URL target; the grant lands
  // pending with the slice-2 reason. Validate it parses as an http(s) URL so a
  // typo doesn't sit pending forever masquerading as an OAuth-blocked grant.
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { error: `connection.target "${target}" must be an absolute URL for kind "mcp"` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: `connection.target must be an http(s) URL for kind "mcp"` };
  }
  return { spec: { kind: "mcp", target } };
}

// ===========================================================================
// GET /admin/grants?agent=<name> — list (module-auth, NO material)
// ===========================================================================

async function listGrants(req: Request, deps: AgentGrantsDeps): Promise<Response> {
  const auth = await requireModuleAuth(req, deps);
  if (auth instanceof Response) return auth;

  const agent = new URL(req.url).searchParams.get("agent");
  if (agent !== null && !AGENT_NAME_RE.test(agent)) {
    return jsonError(400, "invalid_request", "?agent must match [a-zA-Z0-9][a-zA-Z0-9_.-]*");
  }

  // Default to all grants when no agent filter is given (the approval UI lists
  // every agent's grants); narrow to one agent for the module's status check.
  const records = agent ? listGrantsForAgent(deps.storePath, agent) : readGrants(deps.storePath);

  const grants = records.map(toListing);
  return new Response(JSON.stringify({ grants }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ===========================================================================
// GET /admin/grants/<id>/material — approved-only secret (module-auth)
// ===========================================================================

async function grantMaterial(req: Request, id: string, deps: AgentGrantsDeps): Promise<Response> {
  const auth = await requireModuleAuth(req, deps);
  if (auth instanceof Response) return auth;

  if (!GRANT_ID_RE.test(id)) {
    return jsonError(400, "invalid_request", "grant id is not a valid identifier");
  }
  const grant = getGrant(deps.storePath, id);
  if (!grant) {
    return jsonError(404, "not_found", `no grant ${id}`);
  }
  if (grant.status !== "approved" || !grant.material) {
    return jsonError(
      409,
      "not_approved",
      `grant ${id} is ${grant.status}${grant.reason ? ` (${grant.reason})` : ""} — material is available only for approved grants`,
    );
  }

  // The injectable secret. vault → token + the vault's MCP URL (so the agent
  // can add it as an MCP server); service → token + the inject hints.
  let payload: Record<string, unknown>;
  if (grant.material.kind === "vault") {
    payload = {
      kind: "vault",
      token: grant.material.token,
      mcpUrl: vaultMcpUrl(deps.hubOrigin, grant.connection.target),
    };
  } else {
    payload = {
      kind: "service",
      token: grant.material.token,
      inject: grant.connection.kind === "service" ? (grant.connection.inject ?? []) : [],
    };
  }

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      // The body carries a live secret — never cache it.
      "cache-control": "no-store",
    },
  });
}

/** `<hub-origin>/vault/<name>/mcp` — the MCP endpoint a client connects to. */
function vaultMcpUrl(hubOrigin: string, vaultName: string): string {
  return `${hubOrigin.replace(/\/+$/, "")}/vault/${vaultName}/mcp`;
}

// ===========================================================================
// POST /admin/grants/<id>/approve — operator approves (operator-auth)
// ===========================================================================

async function approveGrant(req: Request, id: string, deps: AgentGrantsDeps): Promise<Response> {
  const op = requireOperator(req, deps);
  if (op instanceof Response) return op;

  if (!GRANT_ID_RE.test(id)) {
    return jsonError(400, "invalid_request", "grant id is not a valid identifier");
  }
  const grant = getGrant(deps.storePath, id);
  if (!grant) return jsonError(404, "not_found", `no grant ${id}`);

  let body: { token?: unknown } = {};
  try {
    const raw = await req.text();
    if (raw.trim().length > 0) body = JSON.parse(raw) as { token?: unknown };
  } catch {
    return jsonError(400, "invalid_request", "body must be JSON when present");
  }

  const conn = grant.connection;
  const now = deps.now?.() ?? new Date();
  const approvedAt = now.toISOString();

  if (conn.kind === "mcp") {
    // 4b-1: remote MCP / OAuth is not implemented. Approval is refused; the
    // grant stays pending with its reason. (Slice 2 wires hub-as-OAuth-client.)
    return jsonError(
      409,
      "not_grantable",
      "mcp (remote/OAuth) grants are not yet supported — coming in 4b-2",
    );
  }

  if (conn.kind === "vault") {
    // Re-approval of an already-approved vault grant: revoke the prior minted
    // token first so exactly one live token exists per grant.
    if (grant.material?.kind === "vault") {
      try {
        revokeTokenByJti(deps.db, grant.material.jti, now);
      } catch {
        // Best-effort — a missing registry row leaves nothing to revoke.
      }
    }
    // Approve-time existence check: the vault must still be installed.
    if (deps.resolveVaultOrigin(conn.target) === null) {
      return jsonError(400, "unknown_vault", `no vault named "${conn.target}" in this hub`);
    }
    const access = conn.access ?? "read";
    const scope = `vault:${conn.target}:${access}`;
    let minted: { token: string; jti: string; expiresAt: string };
    try {
      minted = await mintVaultGrant(deps, op.userId, conn.target, scope, conn.tags ?? []);
    } catch (err) {
      return jsonError(
        500,
        "mint_failed",
        `failed to mint vault grant: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Rebuild from the identity fields rather than spreading `grant` — that
    // drops any pending `reason` cleanly (no mutate-after-spread).
    const updated: GrantRecord = {
      id: grant.id,
      agent: grant.agent,
      connection: grant.connection,
      status: "approved",
      createdAt: grant.createdAt,
      approvedAt,
      material: {
        kind: "vault",
        token: minted.token,
        jti: minted.jti,
        expiresAt: minted.expiresAt,
      },
    };
    putGrant(deps.storePath, updated);
    console.log(`agent grant approved: id=${id} agent=${grant.agent} kind=vault scope=${scope}`);
    return grantResponse(200, updated);
  }

  // service — store the operator-pasted API token.
  const token = typeof body.token === "string" ? body.token : "";
  if (token.trim().length === 0) {
    return jsonError(
      400,
      "token_required",
      "approving a service grant requires a non-empty `token` (the API credential to store)",
    );
  }
  // Rebuild from identity fields (drops any pending `reason`).
  const updated: GrantRecord = {
    id: grant.id,
    agent: grant.agent,
    connection: grant.connection,
    status: "approved",
    createdAt: grant.createdAt,
    approvedAt,
    material: { kind: "service", token },
  };
  putGrant(deps.storePath, updated);
  // NEVER log the token. Identity fields only.
  console.log(
    `agent grant approved: id=${id} agent=${grant.agent} kind=service target=${conn.target}`,
  );
  return grantResponse(200, updated);
}

// ===========================================================================
// POST /admin/grants/<id>/revoke — operator revokes (operator-auth)
// ===========================================================================

async function revokeGrant(req: Request, id: string, deps: AgentGrantsDeps): Promise<Response> {
  const op = requireOperator(req, deps);
  if (op instanceof Response) return op;

  if (!GRANT_ID_RE.test(id)) {
    return jsonError(400, "invalid_request", "grant id is not a valid identifier");
  }
  const grant = getGrant(deps.storePath, id);
  if (!grant) return jsonError(404, "not_found", `no grant ${id}`);

  const now = deps.now?.() ?? new Date();
  // Revoke the minted vault token in the registry so it's dead immediately, not
  // just absent from the next fetch. Service tokens are operator-owned external
  // creds — we drop our copy (the operator rotates them upstream if needed).
  if (grant.material?.kind === "vault") {
    try {
      revokeTokenByJti(deps.db, grant.material.jti, now);
    } catch {
      // Best-effort.
    }
  }

  const updated: GrantRecord = {
    id: grant.id,
    agent: grant.agent,
    connection: grant.connection,
    status: "revoked",
    createdAt: grant.createdAt,
    ...(grant.approvedAt ? { approvedAt: grant.approvedAt } : {}),
    // material + reason intentionally dropped — the secret leaves the store.
  };
  putGrant(deps.storePath, updated);
  console.log(`agent grant revoked: id=${id} agent=${grant.agent} kind=${grant.connection.kind}`);
  return grantResponse(200, updated);
}

// ===========================================================================
// Mint
// ===========================================================================

/**
 * Mint the vault token for an approved vault grant: a REGISTERED
 * (created_via "agent_grant") `vault:<target>:<access>` JWT, audience-bound +
 * vault_scope-pinned to the target, carrying `permissions.scoped_tags` when
 * tags were declared (the vault's tag-scope enforcement reads them). Mirrors
 * `admin-connections.ts:mintCredential`.
 */
async function mintVaultGrant(
  deps: AgentGrantsDeps,
  userId: string,
  vault: string,
  scope: string,
  scopedTags: readonly string[],
): Promise<{ token: string; jti: string; expiresAt: string }> {
  const sign = deps.signToken ?? signAccessToken;
  const signed = await sign(deps.db, {
    sub: userId || "agent-grant",
    scopes: [scope],
    audience: `vault.${vault}`,
    clientId: GRANT_CLIENT_ID,
    issuer: deps.hubOrigin,
    ttlSeconds: VAULT_GRANT_TTL_SECONDS,
    vaultScope: [vault],
    ...(scopedTags.length > 0
      ? { extraClaims: { permissions: { scoped_tags: [...scopedTags] } } }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // Register the long-lived mint so revoke can drop it (hub-module-boundary
  // registered-mint rule — an unregistered long-lived token is unrevocable).
  recordTokenMint(deps.db, {
    jti: signed.jti,
    createdVia: "agent_grant",
    subject: "agent-grant",
    ...(userId ? { userId } : {}),
    clientId: GRANT_CLIENT_ID,
    scopes: [scope],
    expiresAt: signed.expiresAt,
    ...(scopedTags.length > 0
      ? { permissions: JSON.stringify({ scoped_tags: [...scopedTags] }) }
      : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  return { token: signed.token, jti: signed.jti, expiresAt: signed.expiresAt };
}

// ===========================================================================
// Wire shapes
// ===========================================================================

/**
 * The list/echo wire shape for a grant — id, agent, connection, status,
 * optional reason + approvedAt. **Carries NO `material`** (the secret never
 * leaves via this shape). This is what PUT, GET-list, approve, and revoke all
 * return.
 */
export interface GrantListing {
  id: string;
  agent: string;
  connection: ConnectionSpec;
  status: GrantRecord["status"];
  reason?: string;
  approvedAt?: string;
}

function toListing(g: GrantRecord): GrantListing {
  return {
    id: g.id,
    agent: g.agent,
    connection: g.connection,
    status: g.status,
    ...(g.reason ? { reason: g.reason } : {}),
    ...(g.approvedAt ? { approvedAt: g.approvedAt } : {}),
  };
}

function grantResponse(status: number, g: GrantRecord): Response {
  return new Response(JSON.stringify(toListing(g)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Re-exported so callers/tests can reuse the stable key derivation. */
export { connectionKey, grantId };
