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
 *                                              service → { kind, token, inject };
 *                                              surface → { kind, token, remoteUrl }.
 *                                              404 unknown id, 409 not approved.
 *
 * OPERATOR-AUTH (a first-admin session cookie; CSRF-belted by the dispatch in
 * hub-server.ts, exactly like /admin/connections POST/DELETE):
 *
 *   POST /admin/grants/<id>/approve          { token? } → vault: MINT now + store;
 *                                              surface: MINT a `surface:<name>:<verb>`
 *                                              token now + store; service: store the
 *                                              pasted `token`. Returns the updated
 *                                              grant (no material).
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
import { SURFACE_NAME_RE, surfaceGitRemoteUrl } from "./git-registry.ts";
import {
  type ConnectionSpec,
  type GrantAccess,
  type GrantInject,
  type GrantMaterial,
  type GrantRecord,
  connectionKey,
  getGrant,
  grantId,
  listGrantsForAgent,
  putGrant,
  readGrants,
  removeGrant,
} from "./grants-store.ts";
import {
  type signAccessToken as SignAccessTokenFn,
  recordTokenMint,
  revokeTokenByJti,
  signAccessToken,
} from "./jwt-sign.ts";
import { type OAuthClient, deriveVaultScopeFromMcpUrl, realOAuthClient } from "./oauth-client.ts";
import { type PendingFlow, deleteFlow, getFlowByState, putFlow } from "./oauth-flows-store.ts";
import { isSafeHubReturnTo } from "./oauth-handlers.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";
import { validateVaultName } from "./vault-name.ts";

/**
 * TTL of a minted vault grant token. 90 days — matches the Connections
 * engine's standing-credential posture (a headless agent re-fetches at spawn;
 * a long-lived token spares a re-mint every turn). Registered in the tokens
 * table so revoke can drop it.
 */
const VAULT_GRANT_TTL_SECONDS = 90 * 24 * 60 * 60;
/**
 * TTL of a minted surface grant token — 90 days, matching the vault grant posture
 * (a headless agent re-fetches at spawn; a long-lived token spares a re-mint every
 * turn). Registered in the tokens table so revoke can drop it (registered-mint rule).
 */
const SURFACE_GRANT_TTL_SECONDS = 90 * 24 * 60 * 60;
const GRANT_CLIENT_ID = "parachute-hub-spa";

/** Agent-name charset — lands in the grant id + a `?agent=` query. Conservative slug. */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/i;
/** Grant-id charset — lands in a URL path segment. */
const GRANT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Service key charset — `github`, `cloudflare`, … lands in env-var / MCP names. */
const SERVICE_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/i;
/** A tag the agent declares for vault tag-scope. Conservative — no whitespace. */
const TAG_RE = /^\S+$/;

/**
 * Input length caps (reviewer N3). A host-admin Bearer is already
 * high-privilege, but these bound disk bloat from a runaway/misconfigured
 * module registering grants on the operator's own machine.
 */
const MAX_AGENT_LEN = 128;
const MAX_TARGET_LEN = 512;
const MAX_TAG_LEN = 128;
/** Cap the operator-pasted service token. Operator-gated (nil trust exposure), but
 *  bounds a fat-finger paste from bloating the on-disk store — matches the other caps. */
const MAX_TOKEN_LEN = 8192;
const MAX_TAGS = 64;
/**
 * Reconcile cap (#96). A host-admin Bearer is high-privilege, but this bounds a
 * runaway/misconfigured module from POSTing a giant liveConnections array. The cap
 * is generous vs. realistic agent connection counts ("a handful per agent"); each
 * entry is further validated + bounded by parseConnectionSpec.
 */
const MAX_LIVE_KEYS = 256;

export interface AgentGrantsDeps {
  db: Database;
  /**
   * Hub origin — the minted-token `iss`, the base of the vault MCP URL, AND the
   * base of the OAuth-client `redirect_uri`
   * (`<hubOrigin>/oauth/agent-grant/callback`).
   */
  hubOrigin: string;
  /**
   * SET of origins the hub answers on (loopback ∪ expose-state ∪ platform ∪
   * per-request issuer), built via `buildHubBoundOrigins`. The module's
   * host-admin bearer `iss` is validated against THIS set rather than the
   * single `hubOrigin`, so the agent module's credential minted under a
   * still-valid prior origin keeps working across an origin switch (hub#516
   * parity). Minted tokens still carry `hubOrigin`. Absent → falls back to
   * `[hubOrigin]` (the prior strict per-request behavior).
   */
  knownIssuers?: readonly string[];
  /** Absolute path to `agent-grants.json` in the hub state dir. */
  storePath: string;
  /** Absolute path to `agent-oauth-flows.json` (the in-flight OAuth consents, 4b-2). */
  flowsStorePath: string;
  /**
   * Resolve a vault's loopback origin from services.json, or `null` when no
   * vault by that name is installed. Mirrors `ConnectionsDeps.resolveVaultOrigin`
   * — used here purely as the "does this vault exist?" check at approve time.
   */
  resolveVaultOrigin: (vaultName: string) => string | null;
  /** Test seam — defaults to the real `signAccessToken`. */
  signToken?: typeof SignAccessTokenFn;
  /** Test seam — the OAuth-client engine (defaults to the real, network-bound one). */
  oauthClient?: OAuthClient;
  /** Test seam for the clock. */
  now?: () => Date;
}

/** The OAuth-client engine — injected for tests, the real (network) one by default. */
function oauth(deps: AgentGrantsDeps): OAuthClient {
  return deps.oauthClient ?? realOAuthClient;
}

/** `<hubOrigin>/oauth/agent-grant/callback` — the DCR-registered redirect_uri. */
function callbackUrl(hubOrigin: string): string {
  return `${hubOrigin.replace(/\/+$/, "")}/oauth/agent-grant/callback`;
}

/** Refresh skew — refresh an mcp access token this many ms before its expiry. */
const REFRESH_SKEW_MS = 120 * 1000;

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

  // --- Collection sub-action: POST /reconcile (grant-GC, #96) — module-auth. ---
  // `reconcile` is a reserved single-segment action, NOT a grant id (the
  // GRANT_ID_RE slug never collides — but anchoring it here makes the routing
  // explicit). The agent module POSTs the live connection keys for one holder;
  // the hub prunes every grant for that holder whose key is no longer live.
  if (segments.length === 1 && segments[0] === "reconcile") {
    if (method !== "POST") {
      return jsonError(405, "method_not_allowed", "use POST on /admin/grants/reconcile");
    }
    return reconcileGrants(req, deps);
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
    return await requireScope(
      deps.db,
      req,
      HOST_ADMIN_SCOPE,
      deps.knownIssuers ?? [deps.hubOrigin],
    );
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
  if (!agent || agent.length > MAX_AGENT_LEN || !AGENT_NAME_RE.test(agent)) {
    return jsonError(
      400,
      "invalid_request",
      `agent is required and must match [a-zA-Z0-9][a-zA-Z0-9_.-]* (max ${MAX_AGENT_LEN} chars)`,
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
  //
  // Recovery from `revoked` (reviewer N2): re-declaring does NOT re-open it —
  // the operator re-grants by approving the revoked row directly (the
  // operator-gated approve path accepts any non-mcp grant regardless of prior
  // status, re-minting fresh material). So a revoked grant is dormant, not
  // dead; an explicit operator approve revives it.
  if (existing) {
    // Re-declare may refresh the agent-side `inject` hints on a service spec
    // without changing the grant's identity (inject is not part of the key).
    const merged: GrantRecord = { ...existing, connection: spec };
    putGrant(deps.storePath, merged);
    return grantResponse(200, merged);
  }

  // 4b-2: an mcp want is now grantable — it sits pending awaiting the operator's
  // OAuth consent (or a pasted static bearer), not "not yet supported".
  const pendingReason = spec.kind === "mcp" ? "awaiting oauth consent" : undefined;
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
  if (kind !== "vault" && kind !== "service" && kind !== "surface" && kind !== "mcp") {
    return { error: `connection.kind must be "vault", "service", "surface", or "mcp"` };
  }
  const target = typeof c.target === "string" ? c.target.trim() : "";
  if (!target) return { error: "connection.target is required" };
  if (target.length > MAX_TARGET_LEN) {
    return { error: `connection.target exceeds the ${MAX_TARGET_LEN}-char limit` };
  }

  if (kind === "vault") {
    // Full vault-name validation (reviewer N4) — length + charset + reserved
    // names (`admin`, `list`, `new`, `assets`). Rejecting reserved names here
    // stops a phantom pending row that could never be approved.
    const v = validateVaultName(target);
    if (!v.ok) {
      return { error: `connection.target ${v.error}` };
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
      if (c.tags.length > MAX_TAGS) {
        return { error: `connection.tags exceeds the ${MAX_TAGS}-entry limit` };
      }
      for (const t of c.tags) {
        const trimmed = typeof t === "string" ? t.trim() : "";
        if (trimmed.length === 0 || trimmed.length > MAX_TAG_LEN || !TAG_RE.test(trimmed)) {
          return {
            error: `connection.tags entries must be non-empty whitespace-free strings (max ${MAX_TAG_LEN} chars)`,
          };
        }
        tags.push(trimmed);
      }
    }
    return {
      spec: { kind: "vault", target: v.name, access, ...(tags.length > 0 ? { tags } : {}) },
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

  if (kind === "surface") {
    // A surface's hub-hosted git repo (Phase 2). `target` is the surface name —
    // the SAME `SURFACE_NAME_RE` slug the git-transport URL parser + registry
    // enforce (no slashes/dots → no path traversal in the git endpoint), so a
    // grant can only ever name a well-formed surface. Case is PRESERVED (the
    // slug is case-sensitive at the transport); connectionKey lowercases only
    // for the idempotency slug. `access` is `read` (default) or `write`; the
    // agent always declares the verb explicitly (`surface:<name>:<verb>`).
    if (!SURFACE_NAME_RE.test(target)) {
      return { error: `connection.target "${target}" is not a valid surface name` };
    }
    let access: GrantAccess = "read";
    if (c.access !== undefined) {
      if (c.access !== "read" && c.access !== "write") {
        return { error: `connection.access must be "read" or "write"` };
      }
      access = c.access;
    }
    return { spec: { kind: "surface", target, access } };
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
    // For a needs_consent grant, tell the operator how to revive it (re-approve
    // re-runs the OAuth consent) so admin/agent surfaces can render an actionable
    // message rather than a bare "not approved".
    const hint =
      grant.status === "needs_consent"
        ? " — re-consent (approve again) to revive this connection"
        : " — material is available only for approved grants";
    return jsonError(
      409,
      "not_approved",
      `grant ${id} is ${grant.status}${grant.reason ? ` (${grant.reason})` : ""}${hint}`,
    );
  }

  // The injectable secret. vault → token + the vault's MCP URL (so the agent
  // can add it as an MCP server); service → token + the inject hints; mcp →
  // refresh-if-needed then token + the remote MCP URL.
  let payload: Record<string, unknown>;
  if (grant.material.kind === "vault") {
    payload = {
      kind: "vault",
      token: grant.material.token,
      mcpUrl: vaultMcpUrl(deps.hubOrigin, grant.connection.target),
    };
  } else if (grant.material.kind === "service") {
    payload = {
      kind: "service",
      token: grant.material.token,
      inject: grant.connection.kind === "service" ? (grant.connection.inject ?? []) : [],
    };
  } else if (grant.material.kind === "surface") {
    // The minted `surface:<name>:<verb>` token + the surface's git remote — the
    // agent injects the token into `git clone`/`git push` (via GIT_ASKPASS) to
    // the remote. One token covers clone AND push (write ⊇ read at the endpoint).
    payload = {
      kind: "surface",
      token: grant.material.token,
      remoteUrl: surfaceGitRemoteUrl(deps.hubOrigin, grant.connection.target),
    };
  } else {
    // mcp — refresh first if it's an OAuth grant near/past expiry. A refresh
    // FAILURE flips the grant to needs_consent (material dropped) and 409s.
    const resolved = await resolveMcpMaterial(grant, deps);
    if (resolved instanceof Response) return resolved;
    payload = {
      kind: "mcp",
      // Field-name seam: store field is `access_token`; wire field is `token`.
      token: resolved.access_token,
      mcpUrl: resolved.mcpUrl,
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

/**
 * Resolve an approved mcp grant's live access token, refreshing first if it's an
 * OAuth grant that's expired or within the skew window. A static-bearer grant (no
 * refresh_token / no expiresAt) returns its stored token unchanged. A refresh
 * FAILURE flips the grant to `needs_consent` (material dropped) and returns a 409
 * Response — the connection is simply absent next spawn until the operator
 * re-consents.
 *
 * Returns the live mcp material on success, or a `Response` (the 409) on failure.
 */
async function resolveMcpMaterial(
  grant: GrantRecord,
  deps: AgentGrantsDeps,
): Promise<Extract<GrantMaterial, { kind: "mcp" }> | Response> {
  const mat = grant.material;
  if (!mat || mat.kind !== "mcp") {
    return jsonError(409, "not_approved", `grant ${grant.id} has no mcp material`);
  }

  // Static bearer — no refresh token / no expiry → return as-is.
  if (!mat.refresh_token || !mat.expiresAt || !mat.tokenEndpoint || !mat.clientId) {
    return mat;
  }

  const now = deps.now?.() ?? new Date();
  const expiresMs = new Date(mat.expiresAt).getTime();
  const needsRefresh = !Number.isFinite(expiresMs) || expiresMs - now.getTime() <= REFRESH_SKEW_MS;
  if (!needsRefresh) return mat;

  // Refresh.
  try {
    const refreshed = await oauth(deps).refreshToken(
      {
        tokenEndpoint: mat.tokenEndpoint,
        refreshToken: mat.refresh_token,
        clientId: mat.clientId,
        now: deps.now ?? (() => new Date()),
      },
      undefined,
    );
    const updatedMaterial: GrantMaterial = {
      kind: "mcp",
      access_token: refreshed.access_token,
      // Rotated refresh, if returned; else keep the existing one.
      refresh_token: refreshed.refresh_token ?? mat.refresh_token,
      ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      ...(mat.issuer ? { issuer: mat.issuer } : {}),
      clientId: mat.clientId,
      tokenEndpoint: mat.tokenEndpoint,
      ...(mat.revocationEndpoint ? { revocationEndpoint: mat.revocationEndpoint } : {}),
      mcpUrl: mat.mcpUrl,
    };
    const updated: GrantRecord = {
      id: grant.id,
      agent: grant.agent,
      connection: grant.connection,
      status: "approved",
      createdAt: grant.createdAt,
      ...(grant.approvedAt ? { approvedAt: grant.approvedAt } : {}),
      material: updatedMaterial,
    };
    putGrant(deps.storePath, updated);
    return updatedMaterial;
  } catch (err) {
    // Refresh died (refresh token revoked/expired). Flip to needs_consent + drop
    // material — the operator re-consents to revive. NEVER log the token/error
    // detail that could carry one; the reason is the error message only.
    const reason = `refresh failed: ${err instanceof Error ? err.message : "unknown error"}`;
    const downgraded: GrantRecord = {
      id: grant.id,
      agent: grant.agent,
      connection: grant.connection,
      status: "needs_consent",
      reason,
      createdAt: grant.createdAt,
      ...(grant.approvedAt ? { approvedAt: grant.approvedAt } : {}),
      // material dropped.
    };
    putGrant(deps.storePath, downgraded);
    console.log(`agent grant needs re-consent: id=${grant.id} agent=${grant.agent} kind=mcp`);
    return jsonError(409, "not_approved", `grant ${grant.id} ${reason} — re-consent required`);
  }
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

  // `returnTo` is consumed ONLY by the mcp/OAuth path (approveMcpGrant), which
  // is the one approve flow that hands the browser off to a remote consent
  // screen and needs somewhere to land on return. vault/service approvals
  // complete synchronously and return JSON — there's no redirect, so they
  // ignore `returnTo` by design.
  let body: { token?: unknown; returnTo?: unknown } = {};
  try {
    const raw = await req.text();
    if (raw.trim().length > 0) body = JSON.parse(raw) as { token?: unknown; returnTo?: unknown };
  } catch {
    return jsonError(400, "invalid_request", "body must be JSON when present");
  }

  const conn = grant.connection;
  const now = deps.now?.() ?? new Date();
  const approvedAt = now.toISOString();

  if (conn.kind === "mcp") {
    return approveMcpGrant(grant, body, deps, approvedAt);
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

  if (conn.kind === "surface") {
    // Surface git grant (Phase 2, §6a step 3). The operator approving here IS the
    // "a note can only REQUEST, never GRANT" gate: the module registered this
    // pending, and only this operator-cookie + first-admin path mints the token.
    // We deliberately do NOT require the surface to be REGISTERED at approve time:
    // registration (surface-host discovering the `#surface` note) is async +
    // declarative and may lag the grant; the git-transport already fails closed
    // (404) on an unregistered name even with a valid token, so a pre-approved
    // grant for a not-yet-declared surface is simply inert until it's declared —
    // no escalation, and no ordering dependency between the two operator actions.
    //
    // Re-approval of an already-approved surface grant: revoke the prior minted
    // token first so exactly one live token exists per grant (mirrors vault).
    if (grant.material?.kind === "surface") {
      try {
        revokeTokenByJti(deps.db, grant.material.jti, now);
      } catch {
        // Best-effort — a missing registry row leaves nothing to revoke.
      }
    }
    const access = conn.access ?? "read";
    const scope = `surface:${conn.target}:${access}`;
    let minted: { token: string; jti: string; expiresAt: string };
    try {
      minted = await mintSurfaceGrant(deps, op.userId, scope);
    } catch (err) {
      return jsonError(
        500,
        "mint_failed",
        `failed to mint surface grant: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const updated: GrantRecord = {
      id: grant.id,
      agent: grant.agent,
      connection: grant.connection,
      status: "approved",
      createdAt: grant.createdAt,
      approvedAt,
      material: {
        kind: "surface",
        token: minted.token,
        jti: minted.jti,
        expiresAt: minted.expiresAt,
      },
    };
    putGrant(deps.storePath, updated);
    console.log(`agent grant approved: id=${id} agent=${grant.agent} kind=surface scope=${scope}`);
    return grantResponse(200, updated);
  }

  // service — store the operator-pasted API token.
  // Trim — a pasted "  tok  " must not inject whitespace into the eventual
  // `Authorization: Bearer` header (drive-by correctness fix; the mcp
  // static-bearer path has the same trim).
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length === 0) {
    return jsonError(
      400,
      "token_required",
      "approving a service grant requires a non-empty `token` (the API credential to store)",
    );
  }
  if (token.length > MAX_TOKEN_LEN) {
    return jsonError(400, "invalid_request", `token exceeds the ${MAX_TOKEN_LEN}-char limit`);
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
// approve(mcp) — static bearer OR start the OAuth consent flow (4b-2)
// ===========================================================================

/**
 * Approve a `kind:mcp` grant. Two paths:
 *
 *   - body `{ token }` (a pasted static bearer) → store
 *     `material:{kind:"mcp", access_token, mcpUrl}` (no refresh) + status
 *     `approved` immediately. No discovery. Weaker lifecycle (no expiry, no
 *     refresh, no issuer-side revoke).
 *   - body `{}` (no token) → START OAuth: discover → DCR (reuse a stored clientId
 *     for the SAME issuer, else register) → mint PKCE + state → persist a pending
 *     flow → return a `GrantListing` with `authorizeUrl` (status stays pending,
 *     reason "awaiting oauth consent"). The operator's browser follows the URL;
 *     the callback completes the flow.
 *
 * A re-approve of an already-approved mcp grant starts a FRESH flow; the callback
 * replaces the material + best-effort revokes the old refresh token.
 */
async function approveMcpGrant(
  grant: GrantRecord,
  body: { token?: unknown; returnTo?: unknown },
  deps: AgentGrantsDeps,
  approvedAt: string,
): Promise<Response> {
  const mcpUrl = grant.connection.target;

  // --- Static-bearer path: a pasted token short-circuits discovery. ---
  if (typeof body.token === "string" && body.token.trim().length > 0) {
    // Trim — a pasted "  tok  " must not inject whitespace into the eventual
    // `Authorization: Bearer` header.
    const token = body.token.trim();
    if (token.length > MAX_TOKEN_LEN) {
      return jsonError(400, "invalid_request", `token exceeds the ${MAX_TOKEN_LEN}-char limit`);
    }
    const updated: GrantRecord = {
      id: grant.id,
      agent: grant.agent,
      connection: grant.connection,
      status: "approved",
      createdAt: grant.createdAt,
      approvedAt,
      material: { kind: "mcp", access_token: token, mcpUrl },
    };
    putGrant(deps.storePath, updated);
    // NEVER log the token.
    console.log(
      `agent grant approved: id=${grant.id} agent=${grant.agent} kind=mcp mode=static-bearer`,
    );
    return grantResponse(200, updated);
  }
  // A non-empty-but-non-string token, or an over-long one, was handled above; a
  // present-but-empty token falls through to the OAuth path (treated as "no token").
  if (body.token !== undefined && typeof body.token !== "string") {
    return jsonError(400, "invalid_request", "token must be a string when present");
  }

  // --- OAuth path: discover → DCR → PKCE/state → persist flow → authorizeUrl. ---
  const client = oauth(deps);
  const redirectUri = callbackUrl(deps.hubOrigin);

  let discovery: Awaited<ReturnType<OAuthClient["discover"]>>;
  try {
    discovery = await client.discover(mcpUrl);
  } catch (err) {
    return jsonError(
      502,
      "discovery_failed",
      `could not discover OAuth metadata for ${mcpUrl}: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  // DCR client reuse: if the grant already has mcp material with a clientId for
  // the SAME issuer (a re-consent), reuse it; else register a fresh client.
  // ACCEPTED (per design): if the issuer rotates its registration (so the stored
  // clientId is no longer valid), a fresh register orphans the old DCR client at
  // the issuer. There is no cross-issuer client GC — orphans accrue only on issuer
  // rotation, which is rare; noted, not built.
  let clientId: string | undefined;
  if (
    grant.material?.kind === "mcp" &&
    grant.material.clientId &&
    grant.material.issuer === discovery.issuer
  ) {
    clientId = grant.material.clientId;
  }
  if (!clientId) {
    if (!discovery.registrationEndpoint) {
      return jsonError(
        502,
        "registration_unsupported",
        `the issuer ${discovery.issuer} does not advertise a registration_endpoint (RFC 7591 DCR) — paste a static bearer token instead`,
      );
    }
    try {
      const reg = await client.registerClient(discovery.registrationEndpoint, redirectUri);
      clientId = reg.clientId;
    } catch (err) {
      return jsonError(
        502,
        "registration_failed",
        `dynamic client registration failed: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  }

  const verifier = client.generateCodeVerifier();
  const challenge = client.generateCodeChallenge(verifier);
  const state = client.generateState();
  // Scope (#671). When the target is a Parachute vault MCP (`…/vault/<name>/mcp`),
  // request a single least-privilege `vault:<name>:read` scope rather than the
  // resource's full advertised set (which for a vault includes hub:admin,
  // vault:<name>:write, … — wildly over-privileged for a read-only agent).
  // Write is a deliberate future knob, not the default. For any non-vault MCP
  // URL, fall back to the resource's advertised scopes (9728→8414), space-joined;
  // omit if none.
  const vaultScope = deriveVaultScopeFromMcpUrl(mcpUrl);
  const scope = vaultScope
    ? vaultScope
    : discovery.scopesSupported?.length
      ? discovery.scopesSupported.join(" ")
      : undefined;

  // OPTIONAL `returnTo` — the same-origin (hub-relative) page the operator
  // started from (the agent ops surface / admin grants page). Stash it on the
  // flow ONLY when it passes the shared open-redirect guard; absent/invalid →
  // omit it (the callback then renders the back-compat close-tab page). This is
  // the open-redirect-load-bearing check — reuse, don't reinvent.
  const returnTo =
    typeof body.returnTo === "string" && isSafeHubReturnTo(body.returnTo)
      ? body.returnTo
      : undefined;

  const flow: PendingFlow = {
    state,
    grantId: grant.id,
    issuer: discovery.issuer,
    clientId,
    tokenEndpoint: discovery.tokenEndpoint,
    ...(discovery.revocationEndpoint ? { revocationEndpoint: discovery.revocationEndpoint } : {}),
    verifier,
    mcpUrl,
    ...(scope ? { scope } : {}),
    redirectUri,
    ...(returnTo ? { returnTo } : {}),
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  putFlow(deps.flowsStorePath, flow, (deps.now?.() ?? new Date()).getTime());

  const authorizeUrl = client.buildAuthorizeUrl({
    authorizationEndpoint: discovery.authorizationEndpoint,
    clientId,
    redirectUri,
    ...(scope ? { scope } : {}),
    state,
    codeChallenge: challenge,
  });

  // Keep the grant pending with the slice-2 reason; surface authorizeUrl so the
  // admin UI can redirect the browser. NEVER log the verifier/state.
  console.log(
    `agent grant oauth flow started: id=${grant.id} agent=${grant.agent} issuer=${discovery.issuer}`,
  );
  const listing: GrantListing & { authorizeUrl: string } = {
    id: grant.id,
    agent: grant.agent,
    connection: grant.connection,
    status: "pending",
    reason: "awaiting oauth consent",
    authorizeUrl,
  };
  return new Response(JSON.stringify(listing), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ===========================================================================
// GET /oauth/agent-grant/callback — the operator's browser redirect target (4b-2)
// ===========================================================================

/**
 * The OAuth-client callback. The remote issuer redirects the operator's browser
 * here with `?code&state` (success) or `?error&state` (RFC 6749 §4.1.2.1 — e.g.
 * the operator clicked Deny). GET, no Bearer; the single-use `state` is the CSRF
 * defense (this is a cross-site redirect IN — same-origin is NOT required).
 *
 * On success: look up the flow by `state` (delete-on-use), exchange the code,
 * store the mcp material, flip the grant `approved`. If the grant previously had
 * mcp material with a refresh_token + revocationEndpoint, best-effort revoke the
 * OLD one first (one live credential per grant).
 *
 * Renders minimal HTML — NEVER a token. On any error, an HTML error page; the
 * grant stays pending/needs_consent.
 */
export async function handleOAuthGrantCallback(
  req: Request,
  deps: AgentGrantsDeps,
): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const errorParam = url.searchParams.get("error");

  if (!state) {
    return htmlPage(400, "Connection failed", "The authorization response was missing its state.");
  }

  // Single-use: look up, then delete the flow (delete-on-use). The get→delete
  // pair is NOT atomic, but the race is benign: the auth `code` is single-use at
  // the ISSUER (RFC 6749 §10.5), so a concurrent second callback with the same
  // `state` exchanges the same code and the issuer rejects the second exchange.
  // The design's concurrency posture is first-wins; the loser sees a token-error
  // page, the grant ends approved exactly once.
  const flow = getFlowByState(deps.flowsStorePath, state, (deps.now?.() ?? new Date()).getTime());
  if (!flow) {
    // Unknown / replayed / expired state — never mint anything.
    return htmlPage(
      400,
      "Connection failed",
      "This authorization link is unknown, already used, or expired. Start the connection again from the admin page.",
    );
  }
  deleteFlow(deps.flowsStorePath, state);

  // The operator clicked Deny (or the issuer returned an error). Leave the grant
  // pending, but record WHY so admin can distinguish "not yet tried" from
  // "tried + denied". (htmlPage single-escapes its args — pass the RAW string.)
  if (errorParam) {
    const denied = getGrant(deps.storePath, flow.grantId);
    if (denied && denied.status === "pending") {
      putGrant(deps.storePath, {
        id: denied.id,
        agent: denied.agent,
        connection: denied.connection,
        status: "pending",
        reason: "operator declined",
        createdAt: denied.createdAt,
        ...(denied.approvedAt ? { approvedAt: denied.approvedAt } : {}),
      });
    }
    return htmlPage(
      400,
      "Connection not authorized",
      `The remote service did not grant access (${errorParam}). The connection stays pending — you can try again from the admin page.`,
    );
  }

  if (!code) {
    return htmlPage(
      400,
      "Connection failed",
      "The authorization response was missing its code. Start the connection again from the admin page.",
    );
  }

  const grant = getGrant(deps.storePath, flow.grantId);
  if (!grant) {
    // The grant was removed mid-consent — nothing to populate.
    return htmlPage(
      404,
      "Connection failed",
      "The grant this authorization belonged to no longer exists.",
    );
  }

  const client = oauth(deps);
  let tokens: Awaited<ReturnType<OAuthClient["exchangeCode"]>>;
  try {
    tokens = await client.exchangeCode({
      tokenEndpoint: flow.tokenEndpoint,
      code,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.verifier,
      clientId: flow.clientId,
      now: deps.now ?? (() => new Date()),
    });
  } catch (err) {
    // Token exchange failed — grant stays pending (the operator can retry).
    // htmlPage single-escapes its args — pass the RAW message.
    return htmlPage(
      502,
      "Connection failed",
      `The token exchange with the remote service failed: ${err instanceof Error ? err.message : "unknown error"}. The connection stays pending — try again from the admin page.`,
    );
  }

  // Best-effort revoke a prior refresh token (re-consent replaces material).
  if (
    grant.material?.kind === "mcp" &&
    grant.material.refresh_token &&
    grant.material.revocationEndpoint
  ) {
    await client.revokeRemote({
      revocationEndpoint: grant.material.revocationEndpoint,
      refreshToken: grant.material.refresh_token,
      clientId: flow.clientId,
    });
  }

  const material: GrantMaterial = {
    kind: "mcp",
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    issuer: flow.issuer,
    clientId: flow.clientId,
    tokenEndpoint: flow.tokenEndpoint,
    ...(flow.revocationEndpoint ? { revocationEndpoint: flow.revocationEndpoint } : {}),
    mcpUrl: flow.mcpUrl,
  };
  const updated: GrantRecord = {
    id: grant.id,
    agent: grant.agent,
    connection: grant.connection,
    status: "approved",
    createdAt: grant.createdAt,
    approvedAt: (deps.now?.() ?? new Date()).toISOString(),
    material,
  };
  putGrant(deps.storePath, updated);
  // NEVER log a token.
  console.log(`agent grant approved: id=${grant.id} agent=${grant.agent} kind=mcp mode=oauth`);

  // If the operator started from a hub page (agent ops surface / admin grants),
  // send them back there instead of a dead-end "close this tab" screen. Re-run
  // the open-redirect guard DEFENSIVELY at redirect time (the value was already
  // gated at stash time; this is belt-and-suspenders against a tampered store).
  // Append `?mcp_connected=1` (preserving any existing query) so the SPA can
  // react (toast / refetch the grant). Absent/invalid returnTo → the
  // back-compat close-tab page.
  if (flow.returnTo && isSafeHubReturnTo(flow.returnTo)) {
    return redirectToReturn(flow.returnTo);
  }

  return htmlPage(
    200,
    "Connected",
    "The connection is authorized. You can close this tab — the agent will use it on its next run.",
  );
}

/**
 * 302 back to a same-origin (hub-relative) `returnTo`, appending
 * `mcp_connected=1` so the SPA can show a success toast / refetch. The caller
 * MUST have already passed `returnTo` through `isSafeHubReturnTo` — this builds
 * the URL against a fixed dummy origin purely to merge the query param
 * correctly, then emits only the path+query (never the origin), so a
 * scheme-relative value can't leak through into the Location header.
 */
function redirectToReturn(returnTo: string): Response {
  // Parse against a fixed base so query-string merging is correct even when
  // returnTo already carries `?...`. Only `pathname + search + hash` is emitted.
  const u = new URL(returnTo, "http://hub.invalid");
  u.searchParams.set("mcp_connected", "1");
  const location = `${u.pathname}${u.search}${u.hash}`;
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

/** Minimal server-rendered HTML — NEVER carries a token. */
function htmlPage(status: number, heading: string, message: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)} — Parachute</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.5rem; }
  p { line-height: 1.6; color: #444; }
</style>
</head>
<body>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>
</body>
</html>
`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  await tearDownGrantMaterial(grant, deps, now);

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

/**
 * Tear down a grant's credential material — shared by `revoke` (operator intent,
 * keeps the row at status:revoked) and `reconcile` (the holder is gone, the row is
 * then removed entirely). Idempotent + best-effort: a missing registry row or a
 * failed remote revoke must not throw.
 *
 *   - vault   → revoke the minted token in the registry so it's dead immediately,
 *               not just absent from the next fetch.
 *   - surface → same as vault: revoke the minted `surface:<name>:<verb>` token in
 *               the registry so the git endpoint rejects it immediately (the
 *               revocation list), not just on the agent's next fetch.
 *   - mcp     → best-effort revoke the refresh token at the issuer so the remote
 *               credential dies, not just our local copy. A static bearer (no
 *               refresh/revocation endpoint) is a no-op (operator rotates upstream).
 *   - service → operator-owned external cred; nothing to revoke remotely — the
 *               caller drops our copy (the operator rotates upstream if needed).
 */
async function tearDownGrantMaterial(
  grant: GrantRecord,
  deps: AgentGrantsDeps,
  now: Date,
): Promise<void> {
  if (grant.material?.kind === "vault" || grant.material?.kind === "surface") {
    try {
      revokeTokenByJti(deps.db, grant.material.jti, now);
    } catch {
      // Best-effort — a missing registry row leaves nothing to revoke.
    }
  } else if (
    grant.material?.kind === "mcp" &&
    grant.material.refresh_token &&
    grant.material.revocationEndpoint &&
    grant.material.clientId
  ) {
    // Best-effort + locally guarded (reviewer NIT2): `revokeRemote` swallows its
    // own errors today, but don't rely on that — a throwing impl/test-double must
    // not abort a reconcile mid-loop and leave the remaining grants un-pruned.
    try {
      await oauth(deps).revokeRemote({
        revocationEndpoint: grant.material.revocationEndpoint,
        refreshToken: grant.material.refresh_token,
        clientId: grant.material.clientId,
      });
    } catch {
      // best-effort — the local material is dropped by the caller regardless.
    }
  }
}

// ===========================================================================
// POST /admin/grants/reconcile — grant-GC for a holder (#96; module-auth)
// ===========================================================================

/**
 * Reconcile (garbage-collect) one holder's grants against its CURRENTLY-declared
 * connections. The agent module POSTs the live connection SPECS a holder still
 * wants; the hub re-derives each key with its OWN `connectionKey()` and prunes
 * every grant for that holder whose key is NOT in the live set — tearing down its
 * material exactly like `revoke`, then REMOVING the row (the holder is gone, so a
 * lingering status:revoked row is just cruft).
 *
 * Module-auth (host-admin Bearer), mirroring PUT/GET — NOT operator-cookie-gated.
 * Pruning only ever REMOVES access (never escalates), so the "a note can only
 * REQUEST, never GRANT" invariant is untouched: this can't mint or approve.
 *
 * Body: `{ agent: "<name>", liveConnections: [<ConnectionSpec>, ...] }`.
 * `liveConnections: []` (the agent/def is gone) prunes ALL of that holder's grants.
 * Sending SPECS (not pre-computed keys) is deliberate: the hub re-derives keys with
 * the same normalization it stored them under, so there is NO dependency on the
 * agent module's separate connectionKey() impl (which diverges for service /
 * tagged-vault / mixed-case-mcp grants — a still-wanted grant would otherwise be
 * wrongly pruned; caught by live verification 2026-06-18).
 *
 * Returns `{ pruned: <number>, prunedIds: ["<id>", ...] }`.
 */
async function reconcileGrants(req: Request, deps: AgentGrantsDeps): Promise<Response> {
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
  if (!agent || agent.length > MAX_AGENT_LEN || !AGENT_NAME_RE.test(agent)) {
    return jsonError(
      400,
      "invalid_request",
      `agent is required and must match [a-zA-Z0-9][a-zA-Z0-9_.-]* (max ${MAX_AGENT_LEN} chars)`,
    );
  }

  // The caller sends the live CONNECTION SPECS (not pre-computed keys): the hub
  // re-derives each key with its OWN connectionKey() — the same normalization +
  // function it used to store/grantId the grants — so the keep-set is guaranteed
  // to match the stored keys. (Sending agent-computed keys would couple to the
  // agent module's separate connectionKey() impl, which diverges for service /
  // tagged-vault / mixed-case-mcp grants — caught live 2026-06-18.)
  if (!Array.isArray(b.liveConnections)) {
    return jsonError(
      400,
      "invalid_request",
      "liveConnections is required and must be an array of connection specs",
    );
  }
  if (b.liveConnections.length > MAX_LIVE_KEYS) {
    return jsonError(
      400,
      "invalid_request",
      `liveConnections exceeds the ${MAX_LIVE_KEYS}-entry limit`,
    );
  }
  const liveKeys = new Set<string>();
  for (const raw of b.liveConnections) {
    const parsed = parseConnectionSpec(raw);
    if ("error" in parsed) {
      return jsonError(400, "invalid_request", `liveConnections entry invalid: ${parsed.error}`);
    }
    liveKeys.add(connectionKey(parsed.spec));
  }

  const now = deps.now?.() ?? new Date();
  const held = listGrantsForAgent(deps.storePath, agent);
  const prunedIds: string[] = [];
  for (const grant of held) {
    // Both sides of this comparison use the HUB's connectionKey (stored grant +
    // re-derived live spec) — no cross-repo key-format dependency.
    if (liveKeys.has(connectionKey(grant.connection))) continue;
    await tearDownGrantMaterial(grant, deps, now);
    removeGrant(deps.storePath, grant.id);
    prunedIds.push(grant.id);
  }

  if (prunedIds.length > 0) {
    // Identity fields + count only — NEVER a token.
    console.log(`agent grants reconciled: agent=${agent} pruned=${prunedIds.length}`);
  }
  return new Response(JSON.stringify({ pruned: prunedIds.length, prunedIds }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
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

/**
 * Mint the token for an approved SURFACE grant (Phase 2): a REGISTERED
 * (created_via "agent_grant") `surface:<name>:<access>` JWT the git-transport
 * endpoint validates (`validateAccessToken` → signature + `iss` ∈ hub-bound set +
 * revocation, then `scopes.includes("surface:<name>:<verb>")`). Mirrors
 * {@link mintVaultGrant} — same TTL posture + registered-mint discipline — minus
 * the vault-only bits: NO `vaultScope` pin (surface isn't a per-user vault) and
 * NO `scoped_tags`. Audience is `surface.<name>` for symmetry with `vault.<name>`;
 * the git endpoint doesn't check `aud` (it keys purely off the URL path + the
 * scope), so it's cosmetic but honest.
 *
 * The scope is signed VERBATIM (no `capScopesToUserAuthority` — that caps only the
 * OAuth-consent/mint-token paths, never `signAccessToken`), so a
 * `surface:<name>:write` grant mints exactly that authority. The operator-cookie +
 * first-admin approve gate upstream is the governance (a note can only REQUEST).
 */
async function mintSurfaceGrant(
  deps: AgentGrantsDeps,
  userId: string,
  scope: string,
): Promise<{ token: string; jti: string; expiresAt: string }> {
  // `surface:<name>:<verb>` — the audience takes the surface name (parallel to
  // `vault.<name>`); split off the middle segment.
  const surfaceName = scope.split(":")[1] ?? "";
  const sign = deps.signToken ?? signAccessToken;
  const signed = await sign(deps.db, {
    sub: userId || "agent-grant",
    scopes: [scope],
    audience: `surface.${surfaceName}`,
    clientId: GRANT_CLIENT_ID,
    issuer: deps.hubOrigin,
    ttlSeconds: SURFACE_GRANT_TTL_SECONDS,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // Register the long-lived mint so revoke can drop it (registered-mint rule —
  // an unregistered long-lived token is unrevocable).
  recordTokenMint(deps.db, {
    jti: signed.jti,
    createdVia: "agent_grant",
    subject: "agent-grant",
    ...(userId ? { userId } : {}),
    clientId: GRANT_CLIENT_ID,
    scopes: [scope],
    expiresAt: signed.expiresAt,
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
  /**
   * Present ONLY on a fresh `approve(mcp)` that started an OAuth flow — the URL
   * the admin UI redirects the operator's browser to. A superset of the 4b-1
   * listing shape; the UI ignores it for vault/service approves (absent there).
   * Never persisted; `toListing` never emits it (it's a response-only field).
   */
  authorizeUrl?: string;
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
