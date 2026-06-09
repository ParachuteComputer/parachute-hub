/**
 * `GET /api/connections/catalog` + `GET/POST/DELETE /admin/connections` — the
 * general module event→action Connections engine (2026-06-09 modular-UI
 * architecture, P5). Generalizes the channel-specific `admin-channels.ts`
 * (hub#624): "add a vault-backed channel" is just the first connection,
 * `vault.note.created (filter #channel-message/inbound) → channel.message.deliver`.
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
 *     `Authorization: Bearer`. NOT a hardcoded `channel:send`.
 *   - the SOURCE event key → the vault trigger's `events` (`note.created` →
 *     `["created"]`, `note.updated` → `["updated"]`).
 *   - the SOURCE filter → the vault trigger's `when` predicate (`tags` /
 *     `has_metadata` / `missing_metadata` / `has_content`), 1:1.
 * Any future `vault-trigger` sink (a different module's action) provisions
 * through the same path with zero hub code changes.
 *
 * THE ONE SINK-SPECIFIC PREREQUISITE. A vault-backed channel additionally needs
 * its reply path wired: a `vault:<v>:write` token + a `channels.json` entry so
 * the session can reply. That's a property of the channel SINK, not of the
 * engine — it runs only for `sink.module === "channel"` and is clearly fenced
 * (`prepareChannelSink`). Everything else is declaration-driven.
 *
 * AUTH. Same gate as `/admin/channels`: a cookie-gated operator session pinned
 * to the first admin. The catalog (`/api/connections/catalog`) is operator-only
 * metadata; it uses the same session gate.
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
import { recordTokenMint, revokeTokenByJti, signAccessToken } from "./jwt-sign.ts";
import type { ModuleAction, ModuleEvent, ModuleManifest } from "./module-manifest.ts";
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
 * Channel-name charset (mirrors `admin-channels.CHANNEL_NAME_RE`). A channel
 * name lands in a services.json key, a URL path segment, and an MCP server name
 * — keep it a conservative slug to close injection across all of them.
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
   * The module's user-facing mount path under the hub origin (e.g. `/channel`),
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
  /** Loopback origin for the channel daemon, or `null` when not installed. */
  channelOrigin: string | null;
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
 * Build the catalog from the installed modules' declared events/actions. Drives
 * the SPA builder's source/sink dropdowns. NO tokens, NO secrets — pure
 * declaration metadata read from each `module.json`.
 */
export function buildCatalog(modules: InstalledModuleInfo[]): {
  events: CatalogEvent[];
  actions: CatalogAction[];
} {
  const events: CatalogEvent[] = [];
  const actions: CatalogAction[] = [];
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
  }
  return { events, actions };
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
  /** Path after `/admin/connections` — `""` for the collection, `/<id>` for an item. */
  subPath: string,
  deps: ConnectionsDeps,
): Promise<Response> {
  const gate = operatorGate(req, deps);
  if (gate) return gate;
  const { userId } = sessionUser(req, deps);

  const method = req.method;
  const itemId = subPath.startsWith("/") ? decodeURIComponent(subPath.slice(1)) : "";

  if (itemId === "" && method === "GET") return listConnections(deps);
  if (itemId === "" && method === "POST") return createConnection(req, userId, deps);
  if (itemId !== "" && method === "DELETE") return teardownConnection(itemId, userId, deps);
  return jsonError(
    405,
    "method_not_allowed",
    "use GET/POST on /admin/connections or DELETE on /admin/connections/:id",
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
  /** Optional operator-supplied id; otherwise derived from source/sink. */
  id?: unknown;
  /**
   * Provenance — WHO requested this connection (modular-UI R2). A module-owned
   * config UI calling this endpoint on the operator's behalf labels itself (e.g.
   * `"channel"`); the hub's own builder omits it and falls back to `"custom"`.
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

  // --- Sink prerequisite (channel reply path), fenced to the channel sink. --
  // Everything below this is general; THIS block is the only sink-specific step.
  // The channel name comes from the action params (`sink.params.channel`) — it
  // becomes a services.json key + an MCP server name, so it must be a slug.
  if (sinkModule === "channel") {
    const channelName = typeof sinkParams?.channel === "string" ? sinkParams.channel : "";
    if (!CHANNEL_NAME_RE.test(channelName)) {
      return jsonError(
        400,
        "invalid_request",
        `channel sink requires sink.params.channel as a valid identifier; got "${channelName}"`,
      );
    }
    const prep = await prepareChannelSink(channelName, vault, vaultOrigin, userId, deps);
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
  if (sinkModule === "channel" && typeof sinkParams?.channel === "string") {
    out.connect = channelConnectLines(deps.hubOrigin, sinkParams.channel);
  }
  return json(200, out);
}

/**
 * The channel sink's reply-path prerequisite (mirrors hub#624). Mints a
 * `vault:<v>:write` for the channel + writes the `channels.json` entry on the
 * channel daemon so the session can reply. Fenced to `sink.module === "channel"`
 * — this is sink-specific config, not part of the general vault-trigger engine.
 * Returns `{ error }` on failure, or `{ error: null, replyTokenJti }` on
 * success — the jti of the long-lived reply token, so the caller can persist
 * it for teardown revocation.
 */
async function prepareChannelSink(
  channelName: string,
  vault: string,
  vaultOrigin: string,
  userId: string,
  deps: ConnectionsDeps,
): Promise<{ error: Response } | { error: null; replyTokenJti: string }> {
  if (deps.channelOrigin === null) {
    return {
      error: jsonError(
        503,
        "channel_unavailable",
        "the channel module is not installed on this hub",
      ),
    };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const vaultWriteSigned = await mint(deps, userId, {
      scopes: [`vault:${vault}:write`],
      audience: `vault.${vault}`,
      vaultScope: [vault],
      ttlSeconds: WEBHOOK_BEARER_TTL_SECONDS, // channel keeps it for its lifetime
    });
    const channelAdminToken = (
      await mint(deps, userId, {
        scopes: ["channel:admin"],
        audience: "channel",
        vaultScope: [],
        ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
      })
    ).token;
    const res = await fetchImpl(`${deps.channelOrigin}/api/channels`, {
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
    if (!res.ok) return { error: stepError("channel_config", await describeRemote(res)) };
    return { error: null, replyTokenJti: vaultWriteSigned.jti };
  } catch (err) {
    return { error: stepError("channel_config", err) };
  }
}

// ---------------------------------------------------------------------------
// DELETE — teardown
// ---------------------------------------------------------------------------

async function teardownConnection(
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

  // --- Channel-sink teardown (remove the channel config entry). ------------
  if (record.sink.module === "channel" && deps.channelOrigin) {
    const channelName =
      typeof record.sink.params?.channel === "string" ? record.sink.params.channel : record.id;
    try {
      const channelAdminToken = (
        await mint(deps, userId, {
          scopes: ["channel:admin"],
          audience: "channel",
          vaultScope: [],
          ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
        })
      ).token;
      const res = await fetchImpl(
        `${deps.channelOrigin}/api/channels/${encodeURIComponent(channelName)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${channelAdminToken}` } },
      );
      if (!res.ok && res.status !== 404) {
        errors.push({ step: "channel_config", detail: await remoteDetail(res) });
      }
    } catch (err) {
      errors.push({ step: "channel_config", detail: errMsg(err) });
    }
  }

  // --- Revoke the registered long-lived mints (B0, registered-mint rule). ---
  // Marks each tokens-registry row revoked → the revocation list at
  // `/.well-known/parachute-revocation.json` advertises the jtis, and every
  // resource server (vault, channel) rejects the credential from its next
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
 * `channel:send`) takes the module namespace as its audience — matching how
 * the channel validates `aud: channel`. Falls back to the sink module name.
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
 * Derive the connection id. Operator-supplied wins; else for a channel sink use
 * the channel name (so the trigger + channel-config share a stable key), else a
 * `<srcModule>-<event>-<sinkModule>-<action>` slug.
 */
function deriveId(rawId: unknown, source: ConnectionSource, sink: ConnectionSink): string {
  const supplied = str(rawId);
  if (supplied) return supplied.toLowerCase();
  if (sink.module === "channel" && typeof sink.params?.channel === "string") {
    return `channel-${sink.params.channel}`.toLowerCase();
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
    mcpAdd: `claude mcp add --transport http --scope user channel-${channelName} ${origin}/channel/mcp/${channelName}`,
    launch: `claude --dangerously-load-development-channels=server:channel-${channelName} --dangerously-skip-permissions`,
  };
}

// --- Auth gate (mirrors admin-channels) ------------------------------------

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
 */
const REGISTERED_MINT_TTL_THRESHOLD_SECONDS = 10 * 60;

interface MintSpec {
  scopes: string[];
  audience: string;
  vaultScope: string[];
  ttlSeconds: number;
}

async function mint(deps: ConnectionsDeps, userId: string, spec: MintSpec) {
  const sign = deps.signToken ?? signAccessToken;
  const signed = await sign(deps.db, {
    sub: userId,
    scopes: spec.scopes,
    audience: spec.audience,
    clientId: PROVISION_CLIENT_ID,
    issuer: deps.hubOrigin,
    ttlSeconds: spec.ttlSeconds,
    vaultScope: spec.vaultScope,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // Register long-lived mints so they're revocable on teardown. Short-lived
  // provisioning tokens (60s, consumed inline) stay unregistered by design.
  if (spec.ttlSeconds > REGISTERED_MINT_TTL_THRESHOLD_SECONDS) {
    recordTokenMint(deps.db, {
      jti: signed.jti,
      createdVia: "connection_provision",
      subject: "connection",
      userId,
      clientId: PROVISION_CLIENT_ID,
      scopes: spec.scopes,
      expiresAt: signed.expiresAt,
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
