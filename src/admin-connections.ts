/**
 * `GET /api/connections/catalog` + `GET/POST/DELETE /admin/connections` — the
 * general module event→action Connections engine (2026-06-09 modular-UI
 * architecture, P5). Generalizes the channel-specific `/admin/channels`
 * endpoint (hub#624 era; retired in boundary D1): "add a vault-backed channel"
 * is just the first connection, `vault.note.created (filter
 * #agent-message/inbound) → agent.message.deliver`.
 *
 * THE CONCEPT. A connection wires "when [EVENT] in [source module] (filter) →
 * do [ACTION] in [sink module]". The sink is ALWAYS an action. Modules declare
 * the `events` they emit + the `actions` they accept in `module.json` (landed
 * P4). The hub is the only thing with cross-module authority (mint tokens,
 * register vault triggers), so this is hub-native.
 *
 * WHY IT'S GENERAL, NOT CHANNEL-HARDCODED. The provisioning engine reads
 * everything it needs from the declarations:
 *   - the SINK action's `endpoint` → the hub-proxied webhook the vault calls
 *     (`<hub-origin>/<sink-mount><endpoint>`). NOT a hardcoded channel path.
 *   - the SINK action's `scope` → the OAuth scope minted into the webhook's
 *     `Authorization: Bearer`. NOT a hardcoded `agent:send`.
 *   - the SOURCE event key → the vault trigger's `events` (`note.created` →
 *     `["created"]`, `note.updated` → `["updated"]`).
 *   - the SOURCE filter → the vault trigger's `when` predicate (`tags` /
 *     `has_metadata` / `missing_metadata` / `has_content`), 1:1.
 * Any future `vault-trigger` sink (a different module's action) provisions
 * through the same path with zero hub code changes.
 *
 * THE ONE SINK-SPECIFIC PREREQUISITE. A vault-backed channel additionally needs
 * its reply path wired: a `vault:<v>:write` token + a `channels.json` entry so
 * the session can reply. That's a property of the agent SINK, not of the
 * engine — it runs only for `sink.module === "agent"` and is clearly fenced
 * (`prepareAgentSink`). Everything else is declaration-driven.
 *
 * AUTH. Same gate as the admin-token mints: a cookie-gated operator session
 * pinned to the first admin. The catalog (`/api/connections/catalog`) is
 * operator-only metadata; it uses the same session gate. TWO exceptions:
 * `POST /admin/connections/:id/renew` (H4 credential renewal) and
 * `POST /admin/connections/:id/claim` (surface#113 claim/reconcile) both
 * authenticate by PROOF OF POSSESSION of the connection's current
 * still-valid credential as Bearer — no operator click; an expired
 * credential can neither renew nor claim (the operator re-links in the UI).
 *
 * THE SECOND KIND — `kind: "credential"` (H4, surface-runtime design). A
 * module declares `credentials` in module.json (scope TEMPLATE
 * `vault:{vault}:read|write` — never admin, never another namespace; both
 * the manifest validator and this engine enforce it). The operator approves
 * granting <module> a standing tag-scoped credential on <vault>: the hub
 * mints a REGISTERED 90-day JWT carrying `permissions.scoped_tags`, delivers
 * it to the module's declared endpoint over loopback (authenticated with a
 * short-lived `<module>:admin` bearer — the channel-config delivery shape),
 * and persists the jti + scope + tags on the ConnectionRecord. Teardown
 * revokes the jtis + best-effort notifies the endpoint with a removal
 * payload. Tags are REQUIRED for write scopes (tags are the sharing scope);
 * read may be tag-scoped or vault-wide per the operator's choice (the
 * approval UI defaults to tag-scoped).
 *
 * CLAIM / RECONCILE (surface#113). A credential delivered to a module
 * OUTSIDE this engine (e.g. minted via the CLI and POSTed straight to the
 * module's delivery endpoint) leaves no ConnectionRecord, so jti-bound
 * renewal 404s at the pre-expiry window. `POST /admin/connections/:id/claim`
 * lets the module backfill the record: it presents the credential it ALREADY
 * holds as Bearer (the renew endpoint's proof-of-possession posture), and
 * the hub — after verifying the jti is REGISTERED in the tokens table and
 * that the token's scope/aud/vault_scope match what the claimed connection
 * id implies — writes the record in `status: "pending"`. A claim grants
 * NOTHING: renewal refuses pending records; only the operator-gated
 * `POST /admin/connections/:id/approve` flips it active, after which the
 * existing renewal flow proceeds unchanged. Expired/revoked/unregistered/
 * mismatched claims are refused with ONE generic error (no oracle on
 * registry contents); re-linking through the operator flow is the recovery
 * path. Rejecting a claim = DELETE on the pending record (which revokes the
 * claimed jti — the safe direction).
 */
import type { Database } from "bun:sqlite";
import {
  type ConnectionRecord,
  type ConnectionSink,
  type ConnectionSource,
  putConnection,
  readConnections,
  removeConnection,
} from "./connections-store.ts";
import {
  findTokenRowByJti,
  recordTokenMint,
  revokeTokenByJti,
  signAccessToken,
  validateAccessToken,
} from "./jwt-sign.ts";
import {
  CREDENTIAL_SCOPE_TEMPLATE_RE,
  type ModuleAction,
  type ModuleCredential,
  type ModuleEvent,
  type ModuleManifest,
} from "./module-manifest.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";

/** Short TTL — provisioning calls use these immediately. */
const PROVISION_TOKEN_TTL_SECONDS = 60;
/**
 * The webhook bearer is persisted as the vault trigger's `action.auth.bearer` —
 * the vault re-presents it on every callback, so it must outlive the request.
 * Long-lived (~90d) to match the daemon's headless-credential posture.
 */
const WEBHOOK_BEARER_TTL_SECONDS = 90 * 24 * 60 * 60;
const PROVISION_CLIENT_ID = "parachute-hub-spa";

/**
 * Connection id charset. The id lands in a URL path segment (DELETE) and is the
 * basis for the derived vault trigger name — keep it a conservative slug.
 */
const CONNECTION_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Channel-name charset. A channel name lands in a services.json key, a URL
 * path segment, and an MCP server name — keep it a conservative slug to close
 * injection across all of them.
 */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Provenance label charset (modular-UI R2). `requestedBy` is an operator-/module-
 * supplied label that lands in the Connections SPA as a grouping key — keep it a
 * conservative slug so it can't carry markup or odd characters into the view.
 * Defaults to `"custom"` (the hub's own builder) when omitted.
 */
const REQUESTED_BY_RE = /^[a-z0-9][a-z0-9_-]*$/i;
const DEFAULT_REQUESTED_BY = "custom";

/** A module installed on this hub, with its manifest + resolved mount path. */
export interface InstalledModuleInfo {
  /** Module short name (the catalog/wire key). */
  readonly short: string;
  /** Parsed `.parachute/module.json`. */
  readonly manifest: ModuleManifest;
  /**
   * The module's user-facing mount path under the hub origin (e.g. `/agent`),
   * used to build a hub-proxied webhook from a sink action's `endpoint`.
   * `null` when the module declares no user-facing mount.
   */
  readonly mount: string | null;
}

export interface ConnectionsDeps {
  db: Database;
  /** Public hub origin — webhook URL + connect lines + minted-token `iss`. */
  hubOrigin: string;
  /**
   * Snapshot of installed modules + their manifests + mounts, read at request
   * time so a freshly-installed module's events/actions show up without a hub
   * restart. Keyed scan is fine — cardinality is small.
   */
  modules: InstalledModuleInfo[];
  /**
   * Resolve a vault's loopback origin (e.g. `http://127.0.0.1:1940`) from
   * services.json, or `null` when no vault by that name is installed.
   */
  resolveVaultOrigin: (vaultName: string) => string | null;
  /**
   * Resolve a module's loopback origin (e.g. `http://127.0.0.1:1946`) by
   * short name, or `null` when not installed (H4 — credential delivery +
   * removal notification go direct to the daemon, not through the hub
   * proxy). Optional: callers that never touch credential connections (and
   * the vault-delete cascade on a hub without H4 consumers) may omit it;
   * delivery then fails with a clear `module_unreachable` step error and
   * teardown logs the skipped notification.
   */
  resolveModuleOrigin?: (short: string) => string | null;
  /** Loopback origin for the agent daemon, or `null` when not installed. */
  agentOrigin: string | null;
  /** Absolute path to `connections.json` in the hub state dir. */
  storePath: string;
  /** Test seam — `globalThis.fetch` in production. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to the real `signAccessToken`. */
  signToken?: typeof signAccessToken;
  /** Test seam for the clock. */
  now?: () => Date;
}

// ===========================================================================
// Catalog — GET /api/connections/catalog
// ===========================================================================

interface CatalogEvent {
  module: string;
  key: string;
  title: string;
  filterSchema: unknown;
}
interface CatalogAction {
  module: string;
  key: string;
  title: string;
  inputSchema: unknown;
  /** The provision descriptor (e.g. `{ type: "vault-trigger" }`), opaque to the SPA. */
  provision: unknown;
}
/**
 * A credential declaration (H4) surfaced through the catalog so module UIs
 * can render the link flow (which vaults to offer, which tags to suggest).
 * NO tokens, NO secrets — declaration metadata only, like everything else
 * in the catalog.
 */
interface CatalogCredential {
  module: string;
  key: string;
  title: string;
  description: string | null;
  /** The scope TEMPLATE, e.g. `vault:{vault}:read`. */
  scope: string;
  endpoint: string;
}
/**
 * A connection preset declared in a module's `module.json`
 * `connectionTemplates` (boundary D2). Drives the SPA builder's one-click
 * preset buttons — declaration-driven, replacing the SPA's hardcoded
 * channel preset (the charter's per-module-view test).
 */
interface CatalogTemplate {
  /** Short of the DECLARING module (the template can wire other modules). */
  module: string;
  key: string;
  title: string;
  description: string | null;
  requestedBy: string | null;
  source: { module: string; event: string; filter: unknown };
  sink: { module: string; action: string };
  parameters: {
    key: string;
    target: string;
    title: string | null;
    description: string | null;
    example: string | null;
  }[];
}

/**
 * Build the catalog from the installed modules' declared
 * events/actions/templates. Drives the SPA builder's source/sink dropdowns +
 * preset buttons. NO tokens, NO secrets — pure declaration metadata read from
 * each `module.json`.
 */
export function buildCatalog(modules: InstalledModuleInfo[]): {
  events: CatalogEvent[];
  actions: CatalogAction[];
  templates: CatalogTemplate[];
  credentials: CatalogCredential[];
} {
  const events: CatalogEvent[] = [];
  const actions: CatalogAction[] = [];
  const templates: CatalogTemplate[] = [];
  const credentials: CatalogCredential[] = [];
  for (const { short, manifest } of modules) {
    for (const e of manifest.events ?? []) {
      events.push({
        module: short,
        key: e.key,
        title: e.title,
        filterSchema: e.filterSchema ?? null,
      });
    }
    for (const a of manifest.actions ?? []) {
      actions.push({
        module: short,
        key: a.key,
        title: a.title,
        inputSchema: a.inputSchema ?? null,
        provision: a.provision ?? null,
      });
    }
    for (const c of manifest.credentials ?? []) {
      credentials.push({
        module: short,
        key: c.key,
        title: c.title,
        description: c.description ?? null,
        scope: c.scope,
        endpoint: c.endpoint,
      });
    }
    for (const t of manifest.connectionTemplates ?? []) {
      // Only event→action presets surface here — a template without BOTH
      // source and sink (e.g. scribe's `kind: "config"` link, consumed by
      // scribe's own UI) isn't something the hub builder can pre-fill.
      if (!t.source || !t.sink) continue;
      templates.push({
        module: short,
        key: t.key,
        title: t.title,
        description: t.description ?? null,
        requestedBy: t.requestedBy ?? null,
        source: { module: t.source.module, event: t.source.event, filter: t.source.filter ?? null },
        sink: { module: t.sink.module, action: t.sink.action },
        parameters: (t.parameters ?? []).map((p) => ({
          key: p.key,
          target: p.target,
          title: p.title ?? null,
          description: p.description ?? null,
          example: p.example ?? null,
        })),
      });
    }
  }
  return { events, actions, templates, credentials };
}

export async function handleConnectionsCatalog(
  req: Request,
  deps: ConnectionsDeps,
): Promise<Response> {
  const gate = operatorGate(req, deps);
  if (gate) return gate;
  return json(200, buildCatalog(deps.modules));
}

// ===========================================================================
// Collection + item — GET/POST /admin/connections, DELETE /admin/connections/:id
// ===========================================================================

export async function handleConnections(
  req: Request,
  /** Path after `/admin/connections` — `""` for the collection, `/<id>` for
   *  an item, `/<id>/renew` for credential renewal (H4). */
  subPath: string,
  deps: ConnectionsDeps,
): Promise<Response> {
  const method = req.method;
  const segments = subPath.startsWith("/")
    ? subPath
        .slice(1)
        .split("/")
        .map((s) => decodeURIComponent(s))
    : [];

  // H4 — credential renewal. Routed BEFORE the operator gate: the renew
  // endpoint authenticates by proof of possession of the connection's
  // current still-valid credential (Bearer), not by an operator session —
  // a headless module daemon renews without a click. Everything else below
  // stays operator-gated.
  if (segments.length === 2 && segments[1] === "renew") {
    if (method !== "POST") {
      return jsonError(405, "method_not_allowed", "use POST on /admin/connections/:id/renew");
    }
    return renewCredentialConnection(req, segments[0] ?? "", deps);
  }

  // surface#113 — claim/reconcile. Same auth class as renew (proof of
  // possession of the credential as Bearer, no operator session), so it's
  // routed before the gate too. A successful claim only writes a PENDING
  // record — the operator-gated approve below is what activates it.
  if (segments.length === 2 && segments[1] === "claim") {
    if (method !== "POST") {
      return jsonError(405, "method_not_allowed", "use POST on /admin/connections/:id/claim");
    }
    return claimCredentialConnection(req, segments[0] ?? "", deps);
  }

  const gate = operatorGate(req, deps);
  if (gate) return gate;
  const { userId } = sessionUser(req, deps);

  const itemId = segments.length === 1 ? (segments[0] ?? "") : "";

  // surface#113 — operator approval of a pending claim. Cookie-gated like
  // create/teardown (and CSRF-belted by the dispatch in hub-server.ts).
  if (segments.length === 2 && segments[1] === "approve") {
    if (method !== "POST") {
      return jsonError(405, "method_not_allowed", "use POST on /admin/connections/:id/approve");
    }
    return approveCredentialConnection(segments[0] ?? "", deps);
  }

  if (segments.length === 0 && method === "GET") return listConnections(deps);
  if (segments.length === 0 && method === "POST") return createConnection(req, userId, deps);
  if (itemId !== "" && method === "DELETE") return teardownConnection(itemId, userId, deps);
  return jsonError(
    405,
    "method_not_allowed",
    "use GET/POST on /admin/connections, DELETE on /admin/connections/:id, or POST on /admin/connections/:id/renew, /claim, /approve",
  );
}

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

function listConnections(deps: ConnectionsDeps): Response {
  // The store never holds a token — records carry source/sink/provisioned
  // metadata only — so this is a straight read. Project to the wire shape so
  // the response is stable regardless of the on-disk record shape.
  const connections = readConnections(deps.storePath).map((c) => ({
    id: c.id,
    // Kind discriminator (H4): absent = event→action; "credential" = a
    // standing module credential. Projected so the SPA can render the two
    // shapes distinctly.
    ...(c.kind !== undefined ? { kind: c.kind } : {}),
    // Approval state (surface#113): "pending" = a module-initiated claim
    // awaiting the operator's one-click approve in the Connections view.
    // Absent = active.
    ...(c.status !== undefined ? { status: c.status } : {}),
    source: c.source,
    sink: c.sink,
    provisioned: c.provisioned,
    created_at: c.createdAt,
    // Provenance (modular-UI R2). Records written before R2 carry no
    // `requestedBy`; project them as the default so the SPA grouping is total.
    requested_by: c.requestedBy ?? DEFAULT_REQUESTED_BY,
    // Records provisioned before the registered-mint rule (B0) carry no
    // mintedJtis — their long-lived tokens were never registered, so teardown
    // can't revoke them (they ride to their original ~90d expiry).
    ...(isLegacyRecord(c) ? { legacy: true } : {}),
  }));
  return json(200, { ok: true, connections });
}

/** A record minted before B0 — no registered jtis, tokens unrevocable. */
function isLegacyRecord(c: ConnectionRecord): boolean {
  return (c.provisioned?.mintedJtis?.length ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// POST — create + provision
// ---------------------------------------------------------------------------

interface CreateBody {
  /** `"credential"` routes to the H4 flow; absent/anything-else = event→action. */
  kind?: unknown;
  source?: {
    module?: unknown;
    vault?: unknown;
    event?: unknown;
    filter?: unknown;
  };
  sink?: {
    module?: unknown;
    action?: unknown;
    params?: unknown;
  };
  /** H4 — the credential request: which module/key, which vault, which tags. */
  credential?: {
    module?: unknown;
    key?: unknown;
    vault?: unknown;
    tags?: unknown;
  };
  /** Optional operator-supplied id; otherwise derived from source/sink. */
  id?: unknown;
  /**
   * Provenance — WHO requested this connection (modular-UI R2). A module-owned
   * config UI calling this endpoint on the operator's behalf labels itself (e.g.
   * `"agent"`); the hub's own builder omits it and falls back to `"custom"`.
   */
  requestedBy?: unknown;
}

async function createConnection(
  req: Request,
  userId: string,
  deps: ConnectionsDeps,
): Promise<Response> {
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return jsonError(400, "invalid_request", "request body must be JSON");
  }

  // H4 — the second kind. Routed by an explicit discriminator so the two
  // body shapes never ambiguously overlap.
  if (str(body.kind) === "credential") {
    return createCredentialConnection(body, userId, deps);
  }

  const sourceModule = str(body.source?.module);
  const sourceEvent = str(body.source?.event);
  const sinkModule = str(body.sink?.module);
  const sinkAction = str(body.sink?.action);

  // Provenance label (modular-UI R2). Default to the hub's own builder; a
  // module-owned config UI that POSTs on the operator's behalf labels itself.
  // Validated to a slug so a bad value can't poison the SPA grouping.
  const requestedByRaw = str(body.requestedBy);
  const requestedBy = requestedByRaw === "" ? DEFAULT_REQUESTED_BY : requestedByRaw.toLowerCase();
  if (!REQUESTED_BY_RE.test(requestedBy)) {
    return jsonError(
      400,
      "invalid_request",
      `requestedBy "${requestedByRaw}" is not a valid label (letters, numbers, dash, underscore)`,
    );
  }
  if (!sourceModule || !sourceEvent || !sinkModule || !sinkAction) {
    return jsonError(
      400,
      "invalid_request",
      "source.module, source.event, sink.module, sink.action are all required",
    );
  }

  // --- Validate event + action existence against the declared catalog. -----
  const src = deps.modules.find((m) => m.short === sourceModule);
  if (!src) return jsonError(400, "unknown_module", `no installed module "${sourceModule}"`);
  const event = findEvent(src.manifest, sourceEvent);
  if (!event) {
    return jsonError(
      400,
      "unknown_event",
      `module "${sourceModule}" declares no event "${sourceEvent}"`,
    );
  }
  const sink = deps.modules.find((m) => m.short === sinkModule);
  if (!sink) return jsonError(400, "unknown_module", `no installed module "${sinkModule}"`);
  const action = findAction(sink.manifest, sinkAction);
  if (!action) {
    return jsonError(
      400,
      "unknown_action",
      `module "${sinkModule}" declares no action "${sinkAction}"`,
    );
  }

  const provisionType = readProvisionType(action.provision);
  if (provisionType !== "vault-trigger") {
    return jsonError(
      400,
      "unsupported_provision",
      `action "${sinkModule}.${sinkAction}" provision type ${provisionType ? `"${provisionType}"` : "(none)"} is not supported (only "vault-trigger" today)`,
    );
  }

  // vault-trigger requires the source to be a vault event on a named vault.
  if (sourceModule !== "vault") {
    return jsonError(
      400,
      "invalid_source",
      `a "vault-trigger" sink requires a vault source event; got "${sourceModule}"`,
    );
  }
  // The source event must map to a vault-trigger verb. `note.deleted` is a
  // declared vault event (passes the catalog check above) but has no trigger
  // verb today — reject it cleanly here rather than 500ing downstream.
  try {
    eventsForSourceEvent(sourceEvent);
  } catch {
    return jsonError(
      400,
      "unsupported_event",
      `source event "${sourceEvent}" has no vault-trigger mapping (supported: note.created, note.updated)`,
    );
  }
  const vault = str(body.source?.vault);
  if (!VAULT_NAME_CHARSET_RE.test(vault)) {
    return jsonError(400, "invalid_request", `source.vault "${vault}" is not a valid identifier`);
  }
  const vaultOrigin = deps.resolveVaultOrigin(vault);
  if (vaultOrigin === null) {
    return jsonError(400, "unknown_vault", `no vault named "${vault}" in this hub`);
  }

  // The sink action MUST declare its webhook endpoint + scope for the hub to
  // wire it generically. A vault-trigger action without these is mis-declared.
  if (!action.endpoint || !action.scope) {
    return jsonError(
      400,
      "action_underdeclared",
      `action "${sinkModule}.${sinkAction}" is a vault-trigger sink but declares no endpoint/scope`,
    );
  }
  if (sink.mount === null) {
    return jsonError(
      400,
      "sink_unmounted",
      `sink module "${sinkModule}" has no mount path — cannot build a hub-proxied webhook`,
    );
  }

  const filter = readFilter(body.source?.filter);
  const sourceRec: ConnectionSource = {
    module: sourceModule,
    vault,
    event: sourceEvent,
    ...(filter ? { filter } : {}),
  };
  const sinkParams = readParams(body.sink?.params);
  const sinkRec: ConnectionSink = {
    module: sinkModule,
    action: sinkAction,
    ...(sinkParams ? { params: sinkParams } : {}),
  };

  // Connection id — operator-supplied or derived. Drives the trigger name.
  const id = deriveId(body.id, sourceRec, sinkRec);
  if (!CONNECTION_ID_RE.test(id)) {
    return jsonError(400, "invalid_request", `connection id "${id}" is not a valid identifier`);
  }

  // jtis of the long-lived tokens minted for this connection — persisted on
  // the record so teardown can revoke them (registered-mint rule).
  const mintedJtis: string[] = [];

  // --- Sink prerequisite (agent message-delivery reply path). --------------
  // Everything below this is general; THIS block is the only sink-specific step.
  // It is gated on the ACTION, not just the module: ONLY `message.deliver` needs
  // a session reply path (a vault-backed channel's connected session replies via
  // a `vault:<v>:write` token + a `channels.json` entry). Other agent actions —
  // e.g. `definition.reload`, a pure inbound webhook with no session and no
  // reply — need none of it. A module-level gate here 400'd every
  // non-`message.deliver` agent sink for want of a `channel` param (agent#117:
  // the def-reload connectors could never provision). The channel name comes
  // from `sink.params.channel` — it becomes a services.json key + an MCP server
  // name, so it must be a slug. (The session-channel concept is kept; only the
  // MODULE renamed channel → agent in the 2026-06-17 rename.)
  if (sinkModule === "agent" && sinkAction === "message.deliver") {
    const channelName = typeof sinkParams?.channel === "string" ? sinkParams.channel : "";
    if (!CHANNEL_NAME_RE.test(channelName)) {
      return jsonError(
        400,
        "invalid_request",
        `agent sink requires sink.params.channel as a valid identifier; got "${channelName}"`,
      );
    }
    const prep = await prepareAgentSink(channelName, vault, vaultOrigin, userId, deps);
    if (prep.error) return prep.error;
    mintedJtis.push(prep.replyTokenJti);
  }

  // --- Mint the webhook bearer at the action's DECLARED scope. -------------
  let webhookBearer: string;
  try {
    const signed = await mint(deps, userId, {
      scopes: [action.scope],
      audience: audienceForScope(action.scope, sinkModule),
      vaultScope: [],
      ttlSeconds: WEBHOOK_BEARER_TTL_SECONDS,
    });
    webhookBearer = signed.token;
    mintedJtis.push(signed.jti);
  } catch (err) {
    return stepError("mint_webhook_bearer", err);
  }

  // --- Build the trigger from the declarations + filter. -------------------
  const triggerName = `conn_${id}`;
  const webhook = buildWebhook(deps.hubOrigin, sink.mount, action.endpoint);
  const trigger = buildVaultTrigger(triggerName, sourceEvent, filter, webhook, webhookBearer);

  // --- Register the trigger on the vault (upsert: POST replaces by name). ---
  try {
    const vaultAdminToken = (
      await mint(deps, userId, {
        scopes: [`vault:${vault}:admin`],
        audience: `vault.${vault}`,
        vaultScope: [vault],
        ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
      })
    ).token;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const res = await fetchImpl(`${vaultOrigin}/vault/${vault}/api/triggers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${vaultAdminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(trigger),
    });
    if (!res.ok) return stepError("vault_trigger", await describeRemote(res));
  } catch (err) {
    return stepError("vault_trigger", err);
  }

  // --- Persist the connection record. --------------------------------------
  const record: ConnectionRecord = {
    id,
    source: sourceRec,
    sink: sinkRec,
    provisioned: { type: "vault-trigger", vault, triggerName, mintedJtis },
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    requestedBy,
  };
  putConnection(deps.storePath, record);

  // --- Response. For a channel-deliver sink, hand back the connect lines
  //     (parity with hub#624) so the operator can join a session.
  const out: {
    ok: true;
    connection: typeof record;
    connect?: { mcpAdd: string; launch: string };
  } = { ok: true, connection: record };
  if (sinkModule === "agent" && typeof sinkParams?.channel === "string") {
    out.connect = channelConnectLines(deps.hubOrigin, sinkParams.channel);
  }
  return json(200, out);
}

/**
 * The agent sink's reply-path prerequisite (mirrors hub#624). Mints a
 * `vault:<v>:write` for the channel + writes the `channels.json` entry on the
 * agent daemon so the session can reply. Fenced to the agent `message.deliver`
 * action (the only one with a reply path) — sink-specific config, not part of
 * the general vault-trigger engine.
 * Returns `{ error }` on failure, or `{ error: null, replyTokenJti }` on
 * success — the jti of the long-lived reply token, so the caller can persist
 * it for teardown revocation. (Renamed from `prepareChannelSink` 2026-06-17;
 * the agent daemon's session-channel CRUD is still `/api/channels`.)
 */
async function prepareAgentSink(
  channelName: string,
  vault: string,
  vaultOrigin: string,
  userId: string,
  deps: ConnectionsDeps,
): Promise<{ error: Response } | { error: null; replyTokenJti: string }> {
  if (deps.agentOrigin === null) {
    return {
      error: jsonError(503, "agent_unavailable", "the agent module is not installed on this hub"),
    };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const vaultWriteSigned = await mint(deps, userId, {
      scopes: [`vault:${vault}:write`],
      audience: `vault.${vault}`,
      vaultScope: [vault],
      ttlSeconds: WEBHOOK_BEARER_TTL_SECONDS, // agent keeps it for its lifetime
    });
    const channelAdminToken = (
      await mint(deps, userId, {
        scopes: ["agent:admin"],
        audience: "agent",
        vaultScope: [],
        ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
      })
    ).token;
    const res = await fetchImpl(`${deps.agentOrigin}/api/channels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${channelAdminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: channelName,
        transport: "vault",
        config: { vault, vaultUrl: vaultOrigin, token: vaultWriteSigned.token },
      }),
    });
    if (!res.ok) return { error: stepError("agent_config", await describeRemote(res)) };
    return { error: null, replyTokenJti: vaultWriteSigned.jti };
  } catch (err) {
    return { error: stepError("agent_config", err) };
  }
}

// ===========================================================================
// kind: "credential" — provision / renew / deliver (H4)
// ===========================================================================

/** TTL of the standing credential (matches the engine's webhook bearer). */
const CREDENTIAL_TTL_SECONDS = WEBHOOK_BEARER_TTL_SECONDS;

/**
 * The payload POSTed to the module's declared endpoint over loopback. One
 * shape for all three lifecycle moments, discriminated by `op`:
 * `"provisioned"` and `"renewed"` carry the token; `"removed"` carries only
 * the identity fields (the module drops its stored credential).
 */
interface CredentialPayload {
  kind: "credential";
  op: "provisioned" | "renewed" | "removed";
  connection_id: string;
  key: string;
  vault: string;
  scope: string;
  /** Tag allowlist. Empty = vault-wide (read scopes only). */
  scoped_tags: string[];
  token?: string;
  jti?: string;
  expires_at?: string;
  /** Hub path the module POSTs (Bearer = this token) to renew before expiry. */
  renew_path?: string;
}

/**
 * Mint the standing credential for a credential connection: a REGISTERED
 * (created_via "connection_credential") 90-day JWT at `vault:<v>:<verb>`,
 * audience-bound + vault_scope-pinned to the vault, carrying
 * `permissions.scoped_tags` when tags were chosen (the claim path vault's
 * tag-scope enforcement reads — vault/src/auth.ts `scoped_tags`).
 */
async function mintCredential(
  deps: ConnectionsDeps,
  userId: string,
  vault: string,
  scope: string,
  scopedTags: readonly string[],
): Promise<{ token: string; jti: string; expiresAt: string }> {
  const signed = await mint(deps, userId, {
    scopes: [scope],
    audience: `vault.${vault}`,
    vaultScope: [vault],
    ttlSeconds: CREDENTIAL_TTL_SECONDS,
    createdVia: "connection_credential",
    ...(scopedTags.length > 0 ? { permissions: { scoped_tags: [...scopedTags] } } : {}),
  });
  return { token: signed.token, jti: signed.jti, expiresAt: signed.expiresAt };
}

/**
 * POST a credential payload to the module's declared endpoint over loopback,
 * authenticated with a short-lived `<module>:admin` bearer (the engine's
 * channel-config delivery shape — the module's endpoint gates on its own
 * admin scope, so a random on-box process can't plant a forged credential).
 */
async function deliverCredentialPayload(
  deps: ConnectionsDeps,
  userId: string,
  moduleShort: string,
  endpoint: string,
  payload: CredentialPayload,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const moduleOrigin = deps.resolveModuleOrigin?.(moduleShort) ?? null;
  if (moduleOrigin === null) {
    return { ok: false, detail: `module "${moduleShort}" has no resolvable loopback origin` };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const adminBearer = (
      await mint(deps, userId, {
        scopes: [`${moduleShort}:admin`],
        audience: moduleShort,
        vaultScope: [],
        ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
      })
    ).token;
    const res = await fetchImpl(`${moduleOrigin}${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminBearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, detail: await remoteDetail(res) };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: errMsg(err) };
  }
}

/**
 * POST /admin/connections with `kind: "credential"` — the operator approves
 * granting <module> a standing tag-scoped credential on <vault>.
 *
 * Validation (the privilege-escalation guard's runtime half):
 *   - the module must be installed AND must DECLARE the credential key;
 *   - the declared scope template must (still) be `vault:{vault}:read|write`
 *     — re-checked here even though the manifest validator enforces it, so a
 *     manifest read through a non-validating path can't widen the grant;
 *   - the vault must exist; tags must be non-empty strings;
 *   - WRITE scopes require non-empty tags (tags are the sharing scope —
 *     an untagged write credential would be a vault-wide write). Read may be
 *     vault-wide per operator choice (the UI defaults to tag-scoped).
 *
 * Provision order: mint (registered) → deliver to the module's endpoint →
 * persist. A failed delivery revokes the fresh mint — an undelivered live
 * credential must not outlive the request.
 *
 * Re-approval: POSTing the same module/key/vault again (the expired-renewal
 * path) upserts by the derived id; the prior record's jtis are revoked first
 * so exactly one live credential exists per connection.
 */
async function createCredentialConnection(
  body: CreateBody,
  userId: string,
  deps: ConnectionsDeps,
): Promise<Response> {
  const moduleShort = str(body.credential?.module);
  const key = str(body.credential?.key);
  const vault = str(body.credential?.vault);
  if (!moduleShort || !key || !vault) {
    return jsonError(
      400,
      "invalid_request",
      "credential.module, credential.key, credential.vault are all required",
    );
  }

  const requestedByRaw = str(body.requestedBy);
  const requestedBy = requestedByRaw === "" ? DEFAULT_REQUESTED_BY : requestedByRaw.toLowerCase();
  if (!REQUESTED_BY_RE.test(requestedBy)) {
    return jsonError(
      400,
      "invalid_request",
      `requestedBy "${requestedByRaw}" is not a valid label (letters, numbers, dash, underscore)`,
    );
  }

  // --- Declaration check: installed module, declared key, sane template. ---
  const mod = deps.modules.find((m) => m.short === moduleShort);
  if (!mod) return jsonError(400, "unknown_module", `no installed module "${moduleShort}"`);
  const decl = findCredentialDecl(mod.manifest, key);
  if (!decl) {
    return jsonError(
      400,
      "unknown_credential",
      `module "${moduleShort}" declares no credential "${key}"`,
    );
  }
  // Escalation guard, runtime half: ONLY vault:{vault}:read|write. A module
  // requesting vault:{vault}:admin, scribe:{vault}:read, or a literal vault
  // name is refused regardless of what its manifest says.
  if (!CREDENTIAL_SCOPE_TEMPLATE_RE.test(decl.scope)) {
    return jsonError(
      400,
      "invalid_scope",
      `credential "${moduleShort}.${key}" declares scope "${decl.scope}" — only "vault:{vault}:read" or "vault:{vault}:write" are grantable (never admin, never another namespace)`,
    );
  }
  if (!decl.endpoint || !decl.endpoint.startsWith("/")) {
    return jsonError(
      400,
      "credential_underdeclared",
      `credential "${moduleShort}.${key}" declares no delivery endpoint`,
    );
  }

  // --- Vault + tags. ---------------------------------------------------------
  if (!VAULT_NAME_CHARSET_RE.test(vault)) {
    return jsonError(
      400,
      "invalid_request",
      `credential.vault "${vault}" is not a valid identifier`,
    );
  }
  if (deps.resolveVaultOrigin(vault) === null) {
    return jsonError(400, "unknown_vault", `no vault named "${vault}" in this hub`);
  }
  const rawTags = body.credential?.tags;
  if (rawTags !== undefined && !Array.isArray(rawTags)) {
    return jsonError(400, "invalid_request", "credential.tags must be an array of tag names");
  }
  const tags: string[] = [];
  for (const t of (rawTags as unknown[] | undefined) ?? []) {
    if (typeof t !== "string" || t.trim().length === 0) {
      return jsonError(400, "invalid_request", "credential.tags entries must be non-empty strings");
    }
    tags.push(t.trim());
  }
  const verb = decl.scope.endsWith(":write") ? "write" : "read";
  if (verb === "write" && tags.length === 0) {
    return jsonError(
      400,
      "invalid_request",
      "a write credential requires a non-empty tag scope — tags are the sharing scope; vault-wide write is not grantable here",
    );
  }
  const scope = `vault:${vault}:${verb}`;

  // --- Id (stable per module/key/vault → re-approve upserts). ----------------
  const suppliedId = str(body.id);
  const id = (suppliedId || `cred-${moduleShort}-${key}-${vault}`).toLowerCase();
  if (!CONNECTION_ID_RE.test(id)) {
    return jsonError(400, "invalid_request", `connection id "${id}" is not a valid identifier`);
  }

  // Re-approval path: revoke the prior record's still-registered jtis BEFORE
  // minting the replacement, so exactly one live credential exists per
  // connection (idempotent for already-revoked/expired rows).
  const prior = readConnections(deps.storePath).find((r) => r.id === id);
  if (prior) {
    const now = deps.now?.() ?? new Date();
    for (const jti of prior.provisioned?.mintedJtis ?? []) {
      try {
        revokeTokenByJti(deps.db, jti, now);
      } catch {
        // Best-effort — a missing registry row leaves nothing to revoke.
      }
    }
  }

  // --- Mint (registered) → deliver → persist. --------------------------------
  let minted: { token: string; jti: string; expiresAt: string };
  try {
    minted = await mintCredential(deps, userId, vault, scope, tags);
  } catch (err) {
    return stepError("mint_credential", err);
  }

  const payload: CredentialPayload = {
    kind: "credential",
    op: "provisioned",
    connection_id: id,
    key,
    vault,
    scope,
    scoped_tags: tags,
    token: minted.token,
    jti: minted.jti,
    expires_at: minted.expiresAt,
    renew_path: `/admin/connections/${id}/renew`,
  };
  const delivered = await deliverCredentialPayload(
    deps,
    userId,
    moduleShort,
    decl.endpoint,
    payload,
  );
  if (!delivered.ok) {
    // An undelivered live credential must not outlive the request.
    try {
      revokeTokenByJti(deps.db, minted.jti, deps.now?.() ?? new Date());
    } catch {
      // Registry row just written by mint() — failure here is exotic; the
      // step error below still surfaces the delivery fault.
    }
    return stepError("credential_delivery", delivered.detail);
  }

  const record: ConnectionRecord = {
    id,
    kind: "credential",
    // The source of authority is the granting vault; the sink is the module
    // holding the credential. Populating both keeps the store filter, the
    // list projection, and the vault-delete cascade (`source.vault === name
    // || provisioned.vault === name`) uniform across both kinds.
    source: { module: "vault", vault, event: "credential" },
    sink: {
      module: moduleShort,
      action: `credential.${key}`,
      ...(tags.length > 0 ? { params: { tags } } : {}),
    },
    provisioned: {
      type: "credential",
      vault,
      mintedJtis: [minted.jti],
      scope,
      scopedTags: tags,
      credentialKey: key,
      endpoint: decl.endpoint,
    },
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    requestedBy,
  };
  putConnection(deps.storePath, record);

  return json(200, { ok: true, connection: record, expires_at: minted.expiresAt });
}

/**
 * POST /admin/connections/:id/renew — credential renewal by PROOF OF
 * POSSESSION: the caller presents the connection's CURRENT still-valid
 * credential as Bearer. No operator click — a headless module daemon renews
 * before expiry.
 *
 * The possession check is the load-bearing gate: the presented token must
 * (a) verify against the hub's JWKS (signature, expiry, revocation — via
 * `validateAccessToken` WITHOUT an issuer pin; the signature proves the hub
 * minted it, and the jti binding below makes a foreign-issuer replay
 * structurally impossible), and (b) carry the EXACT jti recorded on this
 * connection. An expired or revoked credential fails (a) → 401 → the
 * operator re-approves in the UI (the upsert path in create).
 *
 * Renewal re-mints the SAME scope + tags from the record (never request
 * input), delivers the fresh credential in the RESPONSE BODY (the caller is
 * the proven credential holder — that's the delivery; no second loopback
 * POST), revokes the old jti, and updates the record.
 */
async function renewCredentialConnection(
  req: Request,
  id: string,
  deps: ConnectionsDeps,
): Promise<Response> {
  if (!CONNECTION_ID_RE.test(id)) {
    return jsonError(400, "invalid_request", `connection id "${id}" is not a valid identifier`);
  }
  const record = readConnections(deps.storePath).find((r) => r.id === id);
  if (!record || record.kind !== "credential") {
    return jsonError(404, "not_found", `no credential connection "${id}"`);
  }

  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(
      401,
      "unauthenticated",
      "renewal requires the connection's current credential as Authorization: Bearer",
    );
  }
  const bearer = auth.slice("Bearer ".length).trim();
  let presentedJti: string;
  try {
    // Deliberately NO expectedIssuer pin here — unlike the audience gate's
    // Bearer branch (audience-gate.ts → validateHostAdminToken, iss ∈ the
    // hub's bound-origin set). See the fn docstring: the JWKS signature
    // proves local issuance, and the jti binding below makes a foreign
    // replay structurally impossible — an iss check would add nothing but
    // the #516 loopback-vs-public false-reject class.
    const validated = await validateAccessToken(deps.db, bearer);
    presentedJti = typeof validated.payload.jti === "string" ? validated.payload.jti : "";
  } catch (err) {
    // Signature/expiry/revocation failure — including the EXPIRED case the
    // design calls out: an expired credential cannot renew itself; the
    // operator re-approves in the UI.
    return jsonError(
      401,
      "invalid_credential",
      `credential is not valid (expired credentials require operator re-approval in the hub UI): ${errMsg(err)}`,
    );
  }
  const currentJtis = record.provisioned?.mintedJtis ?? [];
  if (!presentedJti || !currentJtis.includes(presentedJti)) {
    return jsonError(
      403,
      "not_credential_holder",
      "the presented token is not this connection's current credential",
    );
  }

  // surface#113 — a CLAIMED record grants nothing until the operator
  // approves. Checked AFTER the possession proof so the pending state is
  // revealed only to the actual credential holder (the claimant itself).
  if (record.status === "pending") {
    return jsonError(
      403,
      "pending_approval",
      "this connection's claim awaits operator approval in the hub admin Connections view — renewal is enabled after approval",
    );
  }

  const vault = record.provisioned?.vault ?? "";
  const scope = record.provisioned?.scope ?? "";
  const scopedTags = record.provisioned?.scopedTags ?? [];
  const key = record.provisioned?.credentialKey ?? "";
  if (!vault || !scope) {
    return jsonError(500, "record_corrupt", `credential connection "${id}" has no minted shape`);
  }

  // Renewal authority is the connection itself (operator approved the
  // standing grant; renewal extends it without escalation — same scope, same
  // tags). No operator user is in the loop, so the registry row carries the
  // provenance subject only (empty userId → mint() omits user_id).
  let minted: { token: string; jti: string; expiresAt: string };
  try {
    minted = await mintCredential(deps, "", vault, scope, scopedTags);
  } catch (err) {
    return stepError("mint_credential", err);
  }

  // Revoke the old credential, persist the new jti. The ORDERING (mint new →
  // revoke old → write record → respond) is a deliberate trade-off: a
  // connection drop after the record write but before the response leaves
  // the module holding NEITHER credential (old revoked, new never received)
  // → operator re-approval required. We fail toward lockout, never toward
  // two live credentials. If that window ever bites in practice, the future
  // option is a retrieve-current-by-jti endpoint (present the revoked-but-
  // recorded predecessor, fetch its successor) — not reordering the steps.
  const now = deps.now?.() ?? new Date();
  for (const jti of currentJtis) {
    try {
      revokeTokenByJti(deps.db, jti, now);
    } catch {
      // Best-effort; the new mint is already the only one the record names.
    }
  }
  const updated: ConnectionRecord = {
    ...record,
    provisioned: {
      ...record.provisioned,
      mintedJtis: [minted.jti],
    },
  };
  putConnection(deps.storePath, updated);

  const payload: CredentialPayload = {
    kind: "credential",
    op: "renewed",
    connection_id: id,
    key,
    vault,
    scope,
    scoped_tags: [...scopedTags],
    token: minted.token,
    jti: minted.jti,
    expires_at: minted.expiresAt,
    renew_path: `/admin/connections/${id}/renew`,
  };
  return json(200, { ok: true, credential: payload });
}

/**
 * POST /admin/connections/:id/claim — backfill the hub-side record for a
 * credential that was delivered to a module OUTSIDE this engine (surface#113:
 * CLI-minted + POSTed straight to the module's delivery endpoint), so the
 * existing jti-bound renewal flow can find a record instead of 404ing.
 *
 * AUTH mirrors renew: proof of possession — the module presents the
 * credential it ALREADY holds as Bearer; the jti is derived from the
 * validated token, never from request input. The claim grants NOTHING:
 *
 *   - the presented token must verify (signature / expiry / revocation —
 *     an expired or revoked credential cannot be claimed; re-link via the
 *     operator flow is the path);
 *   - its jti must be REGISTERED in the tokens table (the registered-mint
 *     rule is the precondition for renewal anyway), with the registry row
 *     recording the same scope;
 *   - the token's scope / aud / vault_scope must carry EXACTLY the grant the
 *     claimed connection id implies (`cred-<module>-<key>-<vault>` +
 *     the module's DECLARED credential template — same declaration checks
 *     as create);
 *   - the record is written `status: "pending"`: renewal refuses it until
 *     the operator's one-click approve in the Connections view.
 *
 * So the only thing a claim can ever enable — and only after explicit
 * operator approval — is renewal of a token the module already holds, at the
 * scope/tags already baked into that token. NOTE the deliberate asymmetry
 * with create: a claim ACCEPTS the existing token's shape verbatim,
 * including an untagged write (create refuses those for NEW grants) — the
 * operator already granted that shape when they minted + delivered it, and
 * the approve click is the explicit sanction of carrying it forward.
 *
 * All post-authentication mismatches refuse with ONE generic error so the
 * endpoint is not an oracle on registry contents; the specific reason is
 * logged server-side (no token material).
 *
 * Idempotency: re-claiming with the same credential returns the same pending
 * record (no dupes). A pending record's claim may be superseded by another
 * fully-valid claim for the same id (pending grants nothing — last writer
 * wins until approval). An ACTIVE record is never touched: claiming it with
 * its own current credential reports "active" (renewal already works);
 * anything else is refused.
 */
async function claimCredentialConnection(
  req: Request,
  id: string,
  deps: ConnectionsDeps,
): Promise<Response> {
  if (!CONNECTION_ID_RE.test(id)) {
    return jsonError(400, "invalid_request", `connection id "${id}" is not a valid identifier`);
  }
  let body: { module?: unknown; key?: unknown; vault?: unknown };
  try {
    body = (await req.json()) as { module?: unknown; key?: unknown; vault?: unknown };
  } catch {
    return jsonError(400, "invalid_request", "request body must be JSON");
  }
  const moduleShort = str(body.module);
  const key = str(body.key);
  const vault = str(body.vault);
  if (!moduleShort || !key || !vault) {
    return jsonError(400, "invalid_request", "module, key, vault are all required");
  }
  if (!VAULT_NAME_CHARSET_RE.test(vault)) {
    return jsonError(400, "invalid_request", `vault "${vault}" is not a valid identifier`);
  }

  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(
      401,
      "unauthenticated",
      "a claim requires the delivered credential as Authorization: Bearer",
    );
  }
  const bearer = auth.slice("Bearer ".length).trim();
  let payload: Record<string, unknown>;
  try {
    // Same validation posture as renew (and the same deliberate absence of
    // an issuer pin — see renewCredentialConnection): signature proves local
    // issuance; the registry + claim-shape binding below does the rest.
    payload = (await validateAccessToken(deps.db, bearer)).payload as Record<string, unknown>;
  } catch (err) {
    // Signature/expiry/revocation failure — an expired or revoked credential
    // cannot be claimed; the operator re-links through the module's flow.
    return jsonError(
      401,
      "invalid_credential",
      `credential is not valid (expired or revoked credentials cannot be claimed — re-link via the operator flow): ${errMsg(err)}`,
    );
  }

  // Every post-authentication mismatch refuses identically (no oracle on
  // registry contents); the reason is logged server-side, token-free.
  const reject = (reason: string): Response => {
    console.warn(`[connections] claim for "${id}" rejected: ${reason}`);
    return jsonError(
      403,
      "claim_rejected",
      "the presented credential does not match a claimable connection",
    );
  };

  const jti = typeof payload.jti === "string" ? payload.jti : "";
  if (!jti) return reject("token carries no jti");

  // Registry half: the jti must be a REGISTERED mint (renewal's revocation
  // lifecycle depends on the row; an unregistered long-lived token is
  // unrevocable by construction and not reconcilable here).
  const registryRow = findTokenRowByJti(deps.db, jti);
  if (!registryRow) return reject("jti is not in the token registry");
  // NOTE: created_via is deliberately NOT filtered here. A claim grandfathers
  // a token that already exists and is already registered — provenance
  // (cli_mint, connection_credential, …) adds no authority either way, and
  // a connection_credential jti with an active record is already refused by
  // the existing-record check below.

  // Declaration half — the same checks create performs, so a claim can't
  // smuggle past anything the operator-initiated path would refuse.
  const mod = deps.modules.find((m) => m.short === moduleShort);
  if (!mod) return reject(`no installed module "${moduleShort}"`);
  const decl = findCredentialDecl(mod.manifest, key);
  if (!decl) return reject(`module "${moduleShort}" declares no credential "${key}"`);
  if (!CREDENTIAL_SCOPE_TEMPLATE_RE.test(decl.scope)) {
    return reject(`declared scope template "${decl.scope}" is not grantable`);
  }
  if (!decl.endpoint || !decl.endpoint.startsWith("/")) {
    return reject(`credential "${moduleShort}.${key}" declares no delivery endpoint`);
  }
  if (deps.resolveVaultOrigin(vault) === null) return reject(`no vault named "${vault}"`);

  // Identity half: the claimed id must be EXACTLY the id the hub derives for
  // this module/key/vault (the same derivation create uses by default) — the
  // id alone is ambiguous to parse (keys may contain dashes), so the body
  // names the parts and the derivation closes the loop.
  const impliedId = `cred-${moduleShort}-${key}-${vault}`.toLowerCase();
  if (id !== impliedId)
    return reject(`id does not match module/key/vault (implies "${impliedId}")`);

  // Token-shape half: the presented credential must carry EXACTLY the grant
  // the connection implies — scope at the declared verb, audience-bound and
  // vault_scope-pinned to the vault (what makes it usable there at all).
  const verb = decl.scope.endsWith(":write") ? "write" : "read";
  const scope = `vault:${vault}:${verb}`;
  const tokenScopes =
    typeof payload.scope === "string" ? payload.scope.split(" ").filter((s) => s.length > 0) : [];
  if (!tokenScopes.includes(scope)) return reject(`token scope does not include "${scope}"`);
  const aud = payload.aud;
  const audOk = aud === `vault.${vault}` || (Array.isArray(aud) && aud.includes(`vault.${vault}`));
  if (!audOk) return reject(`token aud is not "vault.${vault}"`);
  // vault_scope: connection-minted tokens pin the vault here; CLI-minted
  // tokens (the very population claims reconcile — surface#113's live case)
  // carry vault_scope: [] and pin the vault via scope + aud instead, both
  // already exact-matched above. An EMPTY vault_scope is therefore accepted;
  // a NON-empty one that omits this vault is a genuine mismatch (the token
  // was pinned elsewhere) and is refused.
  const vaultScopePin = Array.isArray(payload.vault_scope) ? payload.vault_scope : [];
  if (vaultScopePin.length > 0 && !vaultScopePin.includes(vault)) {
    return reject(`token vault_scope does not pin "${vault}"`);
  }
  if (!registryRow.scopes.includes(scope)) return reject("registry row scope mismatch");

  // Tags ride along verbatim from the SIGNED token (never request input) —
  // renewal will re-mint exactly this shape.
  const scopedTags = readScopedTagsClaim(payload);

  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const pendingRecord: ConnectionRecord = {
    id,
    kind: "credential",
    status: "pending",
    source: { module: "vault", vault, event: "credential" },
    sink: {
      module: moduleShort,
      action: `credential.${key}`,
      ...(scopedTags.length > 0 ? { params: { tags: scopedTags } } : {}),
    },
    provisioned: {
      type: "credential",
      vault,
      mintedJtis: [jti],
      scope,
      scopedTags,
      credentialKey: key,
      endpoint: decl.endpoint,
    },
    createdAt: nowIso,
    requestedBy: moduleShort,
  };

  const existing = readConnections(deps.storePath).find((r) => r.id === id);
  if (existing) {
    if (existing.kind !== "credential") {
      return reject("id names an existing non-credential connection");
    }
    const holdsCurrent = (existing.provisioned?.mintedJtis ?? []).includes(jti);
    if (existing.status !== "pending") {
      // ACTIVE record: never mutated by a claim. The current holder learns
      // renewal already works; anything else is refused generically.
      if (holdsCurrent) {
        return json(200, { ok: true, connection_id: id, status: "active" });
      }
      return reject("an active connection already exists for this id");
    }
    if (holdsCurrent) {
      // Idempotent re-claim — same pending record, no dupes, no rewrite.
      return json(202, claimPendingBody(id));
    }
    // A different fully-validated credential supersedes the unapproved claim
    // (pending grants nothing; last writer wins until the operator approves).
  }

  putConnection(deps.storePath, pendingRecord);
  return json(202, claimPendingBody(id));
}

function claimPendingBody(id: string): Record<string, unknown> {
  return {
    ok: true,
    connection_id: id,
    status: "pending",
    detail:
      "claim recorded — awaiting operator approval in the hub admin Connections view; renewal is enabled after approval",
  };
}

/** `permissions.scoped_tags` from a validated token payload (strings only). */
function readScopedTagsClaim(payload: Record<string, unknown>): string[] {
  const permissions = payload.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return [];
  const tags = (permissions as Record<string, unknown>).scoped_tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
}

/**
 * POST /admin/connections/:id/approve — the operator's one-click activation
 * of a pending claim (surface#113). Operator-gated by the caller (same
 * session gate as create/teardown, CSRF-belted in hub-server.ts). Flips
 * `status: "pending"` → active by dropping the field; mints NOTHING and
 * delivers NOTHING — the module already holds the credential, approval only
 * lets the existing renewal flow find the record. Idempotent: approving an
 * already-active credential record reports active without rewriting it.
 */
function approveCredentialConnection(id: string, deps: ConnectionsDeps): Response {
  if (!CONNECTION_ID_RE.test(id)) {
    return jsonError(400, "invalid_request", `connection id "${id}" is not a valid identifier`);
  }
  const record = readConnections(deps.storePath).find((r) => r.id === id);
  if (!record) return jsonError(404, "not_found", `no connection "${id}"`);
  if (record.kind !== "credential") {
    return jsonError(400, "not_claimable", `connection "${id}" is not a credential connection`);
  }
  if (record.status !== "pending") {
    return json(200, { ok: true, id, status: "active" });
  }
  const { status: _pending, ...approved } = record;
  putConnection(deps.storePath, approved);
  return json(200, { ok: true, id, status: "active" });
}

function findCredentialDecl(m: ModuleManifest, key: string): ModuleCredential | undefined {
  return (m.credentials ?? []).find((c) => c.key === key);
}

// ---------------------------------------------------------------------------
// DELETE — teardown
// ---------------------------------------------------------------------------

/**
 * Tear down one connection by id: deregister the vault trigger, delete the
 * channel-config entry (channel sinks), revoke the registered long-lived
 * mints (B0), remove the record. Exported for the vault-delete cascade (B1)
 * — `admin-vaults.handleDeleteVault` reuses this per matching record so the
 * cascade and the operator-facing DELETE behave identically.
 */
export async function teardownConnection(
  id: string,
  userId: string,
  deps: ConnectionsDeps,
): Promise<Response> {
  if (!CONNECTION_ID_RE.test(id)) {
    return jsonError(400, "invalid_request", `connection id "${id}" is not a valid identifier`);
  }
  const record = readConnections(deps.storePath).find((r) => r.id === id);
  if (!record) {
    return jsonError(404, "not_found", `no connection "${id}"`);
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const errors: { step: string; detail: string }[] = [];

  // --- Vault trigger teardown. ---------------------------------------------
  const vault = record.provisioned.vault;
  const triggerName = record.provisioned.triggerName;
  if (vault && triggerName) {
    const vaultOrigin = deps.resolveVaultOrigin(vault);
    if (vaultOrigin) {
      try {
        const vaultAdminToken = (
          await mint(deps, userId, {
            scopes: [`vault:${vault}:admin`],
            audience: `vault.${vault}`,
            vaultScope: [vault],
            ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
          })
        ).token;
        const res = await fetchImpl(
          `${vaultOrigin}/vault/${vault}/api/triggers/${encodeURIComponent(triggerName)}`,
          { method: "DELETE", headers: { authorization: `Bearer ${vaultAdminToken}` } },
        );
        if (!res.ok && res.status !== 404) {
          errors.push({ step: "vault_trigger", detail: await remoteDetail(res) });
        }
      } catch (err) {
        errors.push({ step: "vault_trigger", detail: errMsg(err) });
      }
    } else {
      errors.push({ step: "vault_trigger", detail: `vault "${vault}" no longer installed` });
    }
  }

  // --- Credential removal notification (H4, best-effort). -------------------
  // The module holding the credential gets a removal payload at its declared
  // endpoint so it can drop the stored token. Best-effort by design: the jti
  // revocation below is the authoritative kill (the revocation list reaches
  // every resource server); a missed notification only leaves the module
  // holding a dead credential it will discover on first use.
  if (record.kind === "credential") {
    const endpoint = record.provisioned?.endpoint;
    const key = record.provisioned?.credentialKey ?? "";
    const credVault = record.provisioned?.vault ?? "";
    if (endpoint) {
      const removal: CredentialPayload = {
        kind: "credential",
        op: "removed",
        connection_id: record.id,
        key,
        vault: credVault,
        scope: record.provisioned?.scope ?? "",
        scoped_tags: [...(record.provisioned?.scopedTags ?? [])],
      };
      const notified = await deliverCredentialPayload(
        deps,
        userId,
        record.sink.module,
        endpoint,
        removal,
      );
      if (!notified.ok) {
        errors.push({ step: "credential_notify", detail: notified.detail });
      }
    }
  }

  // --- Agent-sink teardown (remove the channel config entry). --------------
  // Fenced to event→action records (a credential connection whose HOLDER is the
  // agent module must not delete an unrelated channel config entry) AND — like
  // the create-side prerequisite — to the `message.deliver` action: only that
  // action created a channel config entry, so only it has one to remove. A
  // module-level gate here would issue a spurious DELETE /api/channels/<id> for
  // a channel-less action (e.g. definition.reload — `record.id` as the channel
  // fallback), wasting an agent:admin mint on a never-created channel and
  // risking a real same-named channel. Symmetric to the create-side gate.
  if (
    record.kind !== "credential" &&
    record.sink.module === "agent" &&
    record.sink.action === "message.deliver" &&
    deps.agentOrigin
  ) {
    const channelName =
      typeof record.sink.params?.channel === "string" ? record.sink.params.channel : record.id;
    try {
      const channelAdminToken = (
        await mint(deps, userId, {
          scopes: ["agent:admin"],
          audience: "agent",
          vaultScope: [],
          ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
        })
      ).token;
      const res = await fetchImpl(
        `${deps.agentOrigin}/api/channels/${encodeURIComponent(channelName)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${channelAdminToken}` } },
      );
      if (!res.ok && res.status !== 404) {
        errors.push({ step: "agent_config", detail: await remoteDetail(res) });
      }
    } catch (err) {
      errors.push({ step: "agent_config", detail: errMsg(err) });
    }
  }

  // --- Revoke the registered long-lived mints (B0, registered-mint rule). ---
  // Marks each tokens-registry row revoked → the revocation list at
  // `/.well-known/parachute-revocation.json` advertises the jtis, and every
  // resource server (vault, agent) rejects the credential from its next
  // poll. Runs regardless of remote-teardown outcome — revocation is the safe
  // direction. Legacy records (provisioned before B0) carry no jtis: teardown
  // proceeds, but their tokens were never registered and ride to expiry.
  const mintedJtis = record.provisioned?.mintedJtis ?? [];
  if (mintedJtis.length === 0) {
    console.warn(
      `[connections] connection "${id}" predates registered mints — its provisioned tokens were never registered and ride to their original expiry`,
    );
  } else {
    const now = deps.now?.() ?? new Date();
    for (const jti of mintedJtis) {
      try {
        revokeTokenByJti(deps.db, jti, now);
      } catch (err) {
        errors.push({ step: "revoke_mints", detail: `jti ${jti}: ${errMsg(err)}` });
      }
    }
  }

  // Remove the record regardless — leaving a phantom record after a downstream
  // failure is worse than a possibly-orphaned trigger the operator can re-run.
  removeConnection(deps.storePath, id);

  if (errors.length > 0) {
    return json(207, { ok: false, id, partial: true, errors });
  }
  return json(200, { ok: true, id });
}

// ===========================================================================
// Derivation — the GENERAL mapping (filter→predicate, event→events, webhook)
// ===========================================================================

/** Shape of the vault runtime trigger we POST (vault#469 API). */
interface VaultTrigger {
  name: string;
  events: string[];
  when: Record<string, unknown>;
  action: { webhook: string; send: string; auth: { bearer: string } };
}

/**
 * Map a source event key to the vault trigger's `events`. The vault hook system
 * fires on `"created"` / `"updated"`; the `note.<verb>` key carries the verb.
 */
export function eventsForSourceEvent(eventKey: string): string[] {
  if (eventKey === "note.created") return ["created"];
  if (eventKey === "note.updated") return ["updated"];
  // The catalog already validated the event exists upstream, so an unknown key
  // reaching here is a bug (or an event with no vault-trigger verb mapping, e.g.
  // note.deleted). Fail loud rather than silently registering the wrong trigger.
  throw new Error(`no vault-trigger event mapping for source event "${eventKey}"`);
}

/**
 * Map the operator-set `source.filter` to a vault trigger `when` predicate. The
 * filter keys are the trigger predicate keys 1:1 (`tags`, `has_metadata`,
 * `missing_metadata`, `has_content`) — this is what makes a vault event's
 * filterSchema drive the predicate with no per-module code.
 */
export function whenFromFilter(
  filter: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const when: Record<string, unknown> = {};
  if (!filter) return when;
  if (Array.isArray(filter.tags)) {
    const tags = filter.tags.filter((t): t is string => typeof t === "string");
    if (tags.length > 0) when.tags = tags;
  }
  if (Array.isArray(filter.has_metadata)) {
    const keys = filter.has_metadata.filter((k): k is string => typeof k === "string");
    if (keys.length > 0) when.has_metadata = keys;
  }
  if (Array.isArray(filter.missing_metadata)) {
    const keys = filter.missing_metadata.filter((k): k is string => typeof k === "string");
    if (keys.length > 0) when.missing_metadata = keys;
  }
  if (typeof filter.has_content === "boolean") when.has_content = filter.has_content;
  return when;
}

/** Build the hub-proxied webhook from the sink module's mount + action endpoint. */
export function buildWebhook(hubOrigin: string, mount: string, endpoint: string): string {
  const origin = hubOrigin.replace(/\/+$/, "");
  const m = mount.startsWith("/") ? mount.replace(/\/+$/, "") : `/${mount.replace(/\/+$/, "")}`;
  const ep = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return `${origin}${m}${ep}`;
}

function buildVaultTrigger(
  name: string,
  sourceEvent: string,
  filter: Record<string, unknown> | undefined,
  webhook: string,
  bearer: string,
): VaultTrigger {
  return {
    name,
    events: eventsForSourceEvent(sourceEvent),
    when: whenFromFilter(filter),
    action: { webhook, send: "json", auth: { bearer } },
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

function findEvent(m: ModuleManifest, key: string): ModuleEvent | undefined {
  return (m.events ?? []).find((e) => e.key === key);
}
function findAction(m: ModuleManifest, key: string): ModuleAction | undefined {
  return (m.actions ?? []).find((a) => a.key === key);
}

/** Extract `provision.type` from the opaque provision descriptor. */
function readProvisionType(provision: unknown): string | null {
  if (provision && typeof provision === "object" && !Array.isArray(provision)) {
    const t = (provision as Record<string, unknown>).type;
    if (typeof t === "string") return t;
  }
  return null;
}

/**
 * Audience for a minted sink bearer. A `<module>:<verb>` scope (e.g.
 * `agent:send`) takes the module namespace as its audience — matching how
 * the agent validates `aud: agent`. Falls back to the sink module name.
 */
function audienceForScope(scope: string, sinkModule: string): string {
  const colon = scope.indexOf(":");
  return colon > 0 ? scope.slice(0, colon) : sinkModule;
}

function readFilter(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}
function readParams(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Derive the connection id. Operator-supplied wins; else for an agent sink use
 * the channel name (so the trigger + channel-config share a stable key), else a
 * `<srcModule>-<event>-<sinkModule>-<action>` slug.
 */
function deriveId(rawId: unknown, source: ConnectionSource, sink: ConnectionSink): string {
  const supplied = str(rawId);
  if (supplied) return supplied.toLowerCase();
  if (sink.module === "agent" && typeof sink.params?.channel === "string") {
    return `agent-${sink.params.channel}`.toLowerCase();
  }
  const slug = `${source.module}-${source.event}-${sink.module}-${sink.action}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

function channelConnectLines(
  hubOrigin: string,
  channelName: string,
): { mcpAdd: string; launch: string } {
  const origin = hubOrigin.replace(/\/+$/, "");
  return {
    mcpAdd: `claude mcp add --transport http --scope user agent-${channelName} ${origin}/agent/mcp/${channelName}`,
    launch: `claude --dangerously-load-development-channels=server:agent-${channelName} --dangerously-skip-permissions`,
  };
}

// --- Auth gate (mirrors the admin-token mints) ------------------------------

/** Returns an error Response when the operator gate fails, else `null`. */
function operatorGate(req: Request, deps: ConnectionsDeps): Response | null {
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  if (!session) {
    return jsonError(401, "unauthenticated", "no admin session — sign in at /login first");
  }
  if (!isFirstAdmin(deps.db, session.userId)) {
    return jsonError(
      403,
      "not_admin",
      "connection provisioning is restricted to the hub admin — your account home is at /account/",
    );
  }
  return null;
}

function sessionUser(req: Request, deps: ConnectionsDeps): { userId: string } {
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  return { userId: session?.userId ?? "" };
}

// --- Mint -------------------------------------------------------------------

/**
 * TTL boundary between "interactive" mints (used immediately, ride to expiry
 * by design — the documented ≤10-min unregistered bound) and LONG-LIVED mints,
 * which MUST be registered in the tokens table so they stay revocable
 * (hub-module-boundary charter, registered-mint rule). The audit that produced
 * the rule found this engine minting ~90-day tokens with no registry row — an
 * unrevocable-by-construction credential (`api-revoke-token` 404s unknown
 * jtis; the revocation list only carries registered jtis).
 *
 * Exported so other unregistered-by-policy mint sites (git-notify.ts's
 * fire-and-forget notify/pull tokens) can statically assert their TTLs stay
 * under this policy line instead of restating `600` in a comment.
 */
export const REGISTERED_MINT_TTL_THRESHOLD_SECONDS = 10 * 60;

interface MintSpec {
  scopes: string[];
  audience: string;
  vaultScope: string[];
  ttlSeconds: number;
  /**
   * Registry provenance for long-lived mints. Defaults to the engine's
   * original `connection_provision`; credential connections (H4) pass
   * `connection_credential` so the registry distinguishes the two grants.
   */
  createdVia?: "connection_provision" | "connection_credential";
  /**
   * Extra `permissions` claim (H4 — `{ scoped_tags: [...] }`, the claim path
   * vault's tag-scope enforcement reads). Embedded in the JWT AND persisted
   * (JSON) on the registry row.
   */
  permissions?: Record<string, unknown>;
}

async function mint(deps: ConnectionsDeps, userId: string, spec: MintSpec) {
  const sign = deps.signToken ?? signAccessToken;
  const signed = await sign(deps.db, {
    // `sub` falls back to the provenance subject when no operator user is in
    // the loop (H4 renewal is module-initiated — no session, no user row).
    sub: userId || "connection",
    scopes: spec.scopes,
    audience: spec.audience,
    clientId: PROVISION_CLIENT_ID,
    issuer: deps.hubOrigin,
    ttlSeconds: spec.ttlSeconds,
    vaultScope: spec.vaultScope,
    ...(spec.permissions !== undefined ? { extraClaims: { permissions: spec.permissions } } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // Register long-lived mints so they're revocable on teardown. Short-lived
  // provisioning tokens (60s, consumed inline) stay unregistered by design.
  if (spec.ttlSeconds > REGISTERED_MINT_TTL_THRESHOLD_SECONDS) {
    recordTokenMint(deps.db, {
      jti: signed.jti,
      createdVia: spec.createdVia ?? "connection_provision",
      subject: "connection",
      // tokens.user_id carries an FK to users(id) — only write it when a
      // real operator user is in the loop (empty = renewal, no session).
      ...(userId ? { userId } : {}),
      clientId: PROVISION_CLIENT_ID,
      scopes: spec.scopes,
      expiresAt: signed.expiresAt,
      ...(spec.permissions !== undefined ? { permissions: JSON.stringify(spec.permissions) } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
  }
  return signed;
}

// --- Response helpers -------------------------------------------------------

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function stepError(step: string, cause: unknown): Response {
  return json(502, {
    error: "provision_failed",
    step,
    error_description: `provisioning failed at step "${step}": ${errMsg(cause)}`,
  });
}

function errMsg(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

async function describeRemote(res: Response): Promise<Error> {
  return new Error(await remoteDetail(res));
}

async function remoteDetail(res: Response): Promise<string> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 300);
  } catch {
    // status alone is informative enough
  }
  return `downstream ${res.status}${text ? `: ${text}` : ""}`;
}
