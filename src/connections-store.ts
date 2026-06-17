/**
 * `connections.json` — the persisted registry of operator-created Connections
 * (2026-06-09 modular-UI architecture, P5).
 *
 * A **connection** wires "when [EVENT] in [source module] (filter) → do [ACTION]
 * in [sink module]". The hub is the only thing with cross-module authority
 * (mint tokens, register vault triggers), so connections are hub-native + the
 * record of what got provisioned lives here, in the hub state dir.
 *
 * One file, a flat array of records. Each record carries enough to (a) render
 * the Connections list and (b) tear down what was provisioned — notably the
 * `provisioned.triggerName` + `provisioned.vault` so DELETE can remove the exact
 * vault trigger that was registered. We keep the store deliberately small +
 * synchronous (Bun file I/O); the cardinality is "a handful of connections per
 * hub", not a hot path.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The source side — an event a module emits, with an operator-set filter. */
export interface ConnectionSource {
  /** Source module short name, e.g. `vault`. */
  readonly module: string;
  /** For vault events, which vault instance the event is scoped to. */
  readonly vault?: string;
  /** Event key declared in the source module's `module.json`, e.g. `note.created`. */
  readonly event: string;
  /**
   * Operator-set filter, shaped by the event's `filterSchema`. For a vault
   * event this maps to the trigger predicate (`tags` / `has_metadata` /
   * `missing_metadata` / `has_content`).
   */
  readonly filter?: Record<string, unknown>;
}

/** The sink side — an action a module accepts (the sink is ALWAYS an action). */
export interface ConnectionSink {
  /** Sink module short name, e.g. `agent`. */
  readonly module: string;
  /** Action key declared in the sink module's `module.json`, e.g. `message.deliver`. */
  readonly action: string;
  /** Action params, shaped by the action's `inputSchema` (e.g. `{ channel }`). */
  readonly params?: Record<string, unknown>;
}

/** What the provisioning engine actually wired, for teardown + display. */
export interface ConnectionProvisioned {
  /** How the action was provisioned, e.g. `vault-trigger` or `credential`. */
  readonly type: string;
  /** The vault instance the trigger was registered on (vault-trigger), or
   *  the vault a credential connection grants access to (credential). Either
   *  way it's the field the vault-delete cascade matches on. */
  readonly vault?: string;
  /** The exact vault trigger name registered — DELETE removes this. */
  readonly triggerName?: string;
  /** Credential connections (H4): the exact scope minted, e.g.
   *  `vault:default:read` — renewal re-mints THIS, never request input. */
  readonly scope?: string;
  /** Credential connections (H4): the tag allowlist baked into the minted
   *  token's `permissions.scoped_tags`. Empty/absent = vault-wide (read
   *  scopes only — writes always carry tags). */
  readonly scopedTags?: readonly string[];
  /** Credential connections (H4): the declared credential key. */
  readonly credentialKey?: string;
  /** Credential connections (H4): the module's daemon-root-relative delivery
   *  endpoint — also the best-effort removal-notification target. */
  readonly endpoint?: string;
  /**
   * jtis of the LONG-LIVED tokens minted for this connection (the webhook
   * bearer, and for a channel sink the vault-write reply token). Each is
   * registered in the hub's tokens table (`created_via='connection_provision'`)
   * at mint time so teardown can revoke them — an unregistered long-lived
   * token is unrevocable by construction (hub-module-boundary charter,
   * registered-mint rule). Records written before this field existed read back
   * as `undefined`; their tokens were never registered and ride to expiry
   * (surfaced as `legacy: true` in the list wire shape).
   */
  readonly mintedJtis?: readonly string[];
}

export interface ConnectionRecord {
  readonly id: string;
  /**
   * Connection kind discriminator (H4). Absent = the original event→action
   * shape; `"credential"` = a standing tag-scoped vault credential held by a
   * module (the source is the granting vault, the sink is the holding
   * module). Optional for back-compat: pre-H4 records read back undefined.
   */
  readonly kind?: "credential";
  /**
   * Approval state (surface#113 claim/reconcile). Absent = active (every
   * operator-provisioned record, and pre-claim records, read back undefined
   * = active). `"pending"` = a module-initiated CLAIM for a directly-delivered
   * credential, awaiting operator approval in the hub admin Connections view.
   * A pending record grants nothing: renewal refuses it, and only the
   * operator-gated approve endpoint flips it to active.
   */
  readonly status?: "pending";
  readonly source: ConnectionSource;
  readonly sink: ConnectionSink;
  readonly provisioned: ConnectionProvisioned;
  readonly createdAt: string;
  /**
   * Provenance — WHO requested this connection (modular-UI R2, module-initiated
   * connections). A module-owned config UI that creates a connection on the
   * operator's behalf (e.g. the agent module's admin page "link to a vault" flow)
   * labels itself here (e.g. `"agent"`); a connection built by hand in the
   * hub's own Connections builder is `"custom"`. Lets the operator see which
   * connections a module initiated vs which they wired themselves. Optional for
   * back-compat: records written before R2 read back as `undefined`, which the
   * SPA treats as `"custom"`.
   */
  readonly requestedBy?: string;
}

interface ConnectionsFile {
  connections: ConnectionRecord[];
}

function emptyFile(): ConnectionsFile {
  return { connections: [] };
}

/** Read the store. A missing/garbage file reads as empty (fresh hub). */
export function readConnections(storePath: string): ConnectionRecord[] {
  let buf: string;
  try {
    buf = readFileSync(storePath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const arr = (parsed as { connections?: unknown }).connections;
  if (!Array.isArray(arr)) return [];
  // Lenient: drop any malformed row rather than failing the whole read, so one
  // bad hand-edit doesn't take down the Connections view (mirrors the
  // services.json lenient-read posture).
  return arr.filter((r): r is ConnectionRecord => {
    if (!r || typeof r !== "object") return false;
    const rec = r as Record<string, unknown>;
    return (
      typeof rec.id === "string" &&
      !!rec.source &&
      typeof rec.source === "object" &&
      !!rec.sink &&
      typeof rec.sink === "object"
    );
  });
}

function writeAll(storePath: string, records: ConnectionRecord[]): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const file: ConnectionsFile = { connections: records };
  // Written WITHOUT 0o600 because this file holds NO secrets — the provisioned
  // webhook bearer lives only in the vault trigger's row, never here; records
  // carry source/sink/trigger-name metadata only. Consistent with the default
  // perms on services.json / expose-state.json.
  writeFileSync(storePath, `${JSON.stringify(file, null, 2)}\n`);
}

/** Upsert by id (replace an existing record with the same id, else append). */
export function putConnection(storePath: string, record: ConnectionRecord): void {
  const records = readConnections(storePath);
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  writeAll(storePath, records);
}

/** Remove a connection by id. Returns the removed record, or null if absent. */
export function removeConnection(storePath: string, id: string): ConnectionRecord | null {
  const records = readConnections(storePath);
  const idx = records.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const [removed] = records.splice(idx, 1);
  writeAll(storePath, records);
  return removed ?? null;
}

export function getConnection(storePath: string, id: string): ConnectionRecord | null {
  return readConnections(storePath).find((r) => r.id === id) ?? null;
}

/** Re-export for the unused-import linter when only the type is consumed. */
export const _emptyConnectionsFile = emptyFile;
