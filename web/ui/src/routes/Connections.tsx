/**
 * /admin/connections — the general Connections builder (modular-UI P5).
 *
 * A connection wires "when [EVENT] in [source module] (filter) → do [ACTION] in
 * [sink module]". The hub is the only thing with cross-module authority, so this
 * is hub-native. The IFTTT-style builder drives the cookie-gated
 * `/admin/connections` engine; dropdowns populate from
 * `/api/connections/catalog` (events + actions read from each module.json).
 *
 * "Add a vault-backed channel" is no longer a bespoke view — it's the first
 * connection (`vault.note.created` filtered to the inbound tag →
 * `channel.message.deliver`). One-click **presets** pre-fill the common cases;
 * they derive from the catalog's `templates` (each module declares its own
 * `connectionTemplates` in `module.json` — boundary D2), so nothing
 * module-specific lives in this view (the charter's per-module-view test).
 *
 * Modeled on Users.tsx for visual continuity. Auth: the
 * `/admin/*` + catalog endpoints are session-cookie-gated; the `lib/api.ts`
 * helpers redirect to login on 401 and surface `error_description` verbatim.
 */
import { type FormEvent, useEffect, useState } from "react";
import {
  type CatalogAction,
  type CatalogEvent,
  type CatalogTemplate,
  type ConnectionConnect,
  type ConnectionListing,
  type ConnectionsCatalog,
  HttpError,
  type VaultListing,
  approveConnection,
  createConnection,
  deleteConnection,
  getConnectionsCatalog,
  listConnections,
  listVaults,
} from "../lib/api.ts";

const SLUG_REGEX = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Pre-fill values for a template's `sink.params.<key>` parameters: the
 * declared `example` when the module ships one, else a generic editable
 * `my-<key>` sample (e.g. `{ "channel": "my-channel" }`). Parameters
 * targeting `source.vault` are covered by the vault dropdown and skipped.
 */
function sinkParamsFor(template: CatalogTemplate): Record<string, string> {
  const params: Record<string, string> = {};
  for (const p of template.parameters) {
    const m = /^sink\.params\.(.+)$/.exec(p.target);
    if (m?.[1]) params[m[1]] = p.example ?? `my-${p.key}`;
  }
  return params;
}

interface ConnectionsData {
  connections: ConnectionListing[];
  catalog: ConnectionsCatalog;
  vaults: VaultListing[];
}

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; data: ConnectionsData }
  | { kind: "error"; message: string };

type CreateState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "created"; connect?: ConnectionConnect }
  | { kind: "error"; message: string };

type RemoveState =
  | { kind: "idle" }
  | { kind: "confirming"; id: string }
  | { kind: "removing"; id: string }
  | { kind: "error"; id: string; message: string };

/**
 * Per-row approve state for pending credential claims (surface#113). One
 * click — approval mints nothing, it only lets the module's existing
 * credential renew, so no confirm dialog (Remove stays the destructive path).
 */
type ApproveState =
  | { kind: "idle" }
  | { kind: "approving"; id: string }
  | { kind: "error"; id: string; message: string };

function errMessage(err: unknown, verb: string): string {
  if (err instanceof HttpError) return `${verb} failed (${err.status}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Copy-to-clipboard button (mirrors McpConnectCard). */
function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        if (typeof navigator === "undefined" || !navigator.clipboard) return;
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

export function Connections() {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [createSt, setCreateSt] = useState<CreateState>({ kind: "idle" });
  const [removeSt, setRemoveSt] = useState<RemoveState>({ kind: "idle" });
  const [approveSt, setApproveSt] = useState<ApproveState>({ kind: "idle" });

  // Builder form fields.
  const [sourceModule, setSourceModule] = useState("");
  const [sourceEvent, setSourceEvent] = useState("");
  const [vault, setVault] = useState("");
  const [filterText, setFilterText] = useState("");
  const [sinkModule, setSinkModule] = useState("");
  const [sinkAction, setSinkAction] = useState("");
  const [paramsText, setParamsText] = useState("");

  useEffect(() => {
    void reload;
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([listConnections(), getConnectionsCatalog(), listVaults()])
      .then(([connections, catalog, vaultsResult]) => {
        if (cancelled) return;
        setState({ kind: "ok", data: { connections, catalog, vaults: vaultsResult.vaults } });
        setVault((cur) => cur || vaultsResult.vaults[0]?.name || "");
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  /** Pre-fill the builder from a module-declared preset (boundary D2). */
  function applyTemplate(t: CatalogTemplate): void {
    setSourceModule(t.source.module);
    setSourceEvent(t.source.event);
    setSinkModule(t.sink.module);
    setSinkAction(t.sink.action);
    setFilterText(t.source.filter ? JSON.stringify(t.source.filter, null, 2) : "");
    const params = sinkParamsFor(t);
    setParamsText(Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : "");
    setCreateSt({ kind: "idle" });
  }

  async function onSubmitCreate(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!sourceModule || !sourceEvent || !sinkModule || !sinkAction) {
      setCreateSt({ kind: "error", message: "Pick a source event and a sink action." });
      return;
    }
    let filter: Record<string, unknown> | undefined;
    let params: Record<string, unknown> | undefined;
    try {
      filter = filterText.trim() ? (JSON.parse(filterText) as Record<string, unknown>) : undefined;
    } catch {
      setCreateSt({ kind: "error", message: "Filter is not valid JSON." });
      return;
    }
    try {
      params = paramsText.trim() ? (JSON.parse(paramsText) as Record<string, unknown>) : undefined;
    } catch {
      setCreateSt({ kind: "error", message: "Action params are not valid JSON." });
      return;
    }
    // A vault source needs a vault selected.
    if (sourceModule === "vault" && !vault) {
      setCreateSt({ kind: "error", message: "Pick a vault for the source event." });
      return;
    }
    setCreateSt({ kind: "submitting" });
    try {
      const result = await createConnection({
        source: {
          module: sourceModule,
          ...(sourceModule === "vault" ? { vault } : {}),
          event: sourceEvent,
          ...(filter ? { filter } : {}),
        },
        sink: { module: sinkModule, action: sinkAction, ...(params ? { params } : {}) },
      });
      setCreateSt({ kind: "created", ...(result.connect ? { connect: result.connect } : {}) });
      setReload((n) => n + 1);
    } catch (err) {
      setCreateSt({ kind: "error", message: errMessage(err, "Create") });
    }
  }

  async function onConfirmRemove(id: string): Promise<void> {
    setRemoveSt({ kind: "removing", id });
    try {
      await deleteConnection(id);
      setRemoveSt({ kind: "idle" });
      setReload((n) => n + 1);
    } catch (err) {
      setRemoveSt({ kind: "error", id, message: errMessage(err, "Remove") });
    }
  }

  async function onApprove(id: string): Promise<void> {
    if (approveSt.kind === "approving") return;
    setApproveSt({ kind: "approving", id });
    try {
      await approveConnection(id);
      setApproveSt({ kind: "idle" });
      setReload((n) => n + 1);
    } catch (err) {
      setApproveSt({ kind: "error", id, message: errMessage(err, "Approve") });
    }
  }

  return (
    <div data-route-content="true">
      <div className="list-header">
        <h1>Connections</h1>
      </div>

      <p className="muted">
        A connection wires <em>when [event] in a module → do [action] in another module</em>. The
        hub mints the tokens and registers the trigger. Modules declare presets for the common cases
        — pick one below to pre-fill the builder.
      </p>

      {renderList(state, removeSt, setRemoveSt, onConfirmRemove, approveSt, onApprove, () =>
        setReload((n) => n + 1),
      )}

      {state.kind === "ok" && (
        <BuilderSection
          catalog={state.data.catalog}
          vaults={state.data.vaults}
          sourceModule={sourceModule}
          setSourceModule={setSourceModule}
          sourceEvent={sourceEvent}
          setSourceEvent={setSourceEvent}
          vault={vault}
          setVault={setVault}
          filterText={filterText}
          setFilterText={setFilterText}
          sinkModule={sinkModule}
          setSinkModule={setSinkModule}
          sinkAction={sinkAction}
          setSinkAction={setSinkAction}
          paramsText={paramsText}
          setParamsText={setParamsText}
          createSt={createSt}
          setCreateSt={setCreateSt}
          onSubmit={onSubmitCreate}
          onApplyTemplate={applyTemplate}
        />
      )}
    </div>
  );
}

function renderList(
  state: ListState,
  removeSt: RemoveState,
  setRemoveSt: (s: RemoveState) => void,
  onConfirmRemove: (id: string) => Promise<void>,
  approveSt: ApproveState,
  onApprove: (id: string) => Promise<void>,
  onRetry: () => void,
): React.ReactNode {
  if (state.kind === "loading") return <p className="muted">Loading connections…</p>;
  if (state.kind === "error") {
    return (
      <>
        <div className="error-banner">
          Couldn't load connections: <code>{state.message}</code>
        </div>
        <button type="button" onClick={onRetry} className="secondary">
          Retry
        </button>
      </>
    );
  }
  const { connections } = state.data;
  if (connections.length === 0) {
    return (
      <div className="empty empty-rich">
        <p className="empty-headline">No connections yet.</p>
        <p className="muted">Build one below, or start from a module's preset.</p>
      </div>
    );
  }
  return (
    <ConnectionsTable
      connections={connections}
      removeSt={removeSt}
      setRemoveSt={setRemoveSt}
      onConfirmRemove={onConfirmRemove}
      approveSt={approveSt}
      onApprove={onApprove}
    />
  );
}

/**
 * Provenance label for the group header (modular-UI R2). `"custom"` →
 * connections wired by hand in this builder; any module short name →
 * connections a module-owned config UI initiated on the operator's behalf.
 */
function provenanceOf(c: ConnectionListing): string {
  return c.requested_by && c.requested_by.length > 0 ? c.requested_by : "custom";
}

function provenanceHeading(provenance: string): string {
  return provenance === "custom" ? "Custom (built here)" : `Added from ${provenance}`;
}

/**
 * Group connections by provenance for display. "custom" sorts last so
 * module-initiated connections lead; within a group, insertion order is kept.
 */
function groupByProvenance(connections: ConnectionListing[]): [string, ConnectionListing[]][] {
  const groups = new Map<string, ConnectionListing[]>();
  for (const c of connections) {
    const key = provenanceOf(c);
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => {
    if (a === b) return 0;
    if (a === "custom") return 1;
    if (b === "custom") return -1;
    return a.localeCompare(b);
  });
}

function ConnectionsTable({
  connections,
  removeSt,
  setRemoveSt,
  onConfirmRemove,
  approveSt,
  onApprove,
}: {
  connections: ConnectionListing[];
  removeSt: RemoveState;
  setRemoveSt: (s: RemoveState) => void;
  onConfirmRemove: (id: string) => Promise<void>;
  approveSt: ApproveState;
  onApprove: (id: string) => Promise<void>;
}): React.ReactNode {
  const groups = groupByProvenance(connections);
  return (
    <>
      {groups.map(([provenance, rows]) => (
        <div
          key={provenance}
          className="channel-list"
          style={{ marginTop: "1rem" }}
          data-provenance-group={provenance}
        >
          <h3 style={{ marginBottom: "0.25rem" }}>{provenanceHeading(provenance)}</h3>
          <div className="table-scroll">
            <table className="channel-table">
              <thead>
                <tr>
                  <th scope="col">Connection</th>
                  <th scope="col">When</th>
                  <th scope="col">Do</th>
                  <th scope="col">Source</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) =>
                  renderConnectionRow(
                    c,
                    removeSt,
                    setRemoveSt,
                    onConfirmRemove,
                    approveSt,
                    onApprove,
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}

function renderConnectionRow(
  c: ConnectionListing,
  removeSt: RemoveState,
  setRemoveSt: (s: RemoveState) => void,
  onConfirmRemove: (id: string) => Promise<void>,
  approveSt: ApproveState,
  onApprove: (id: string) => Promise<void>,
): React.ReactNode {
  const isConfirming = removeSt.kind === "confirming" && removeSt.id === c.id;
  const isRemoving = removeSt.kind === "removing" && removeSt.id === c.id;
  const rowError = removeSt.kind === "error" && removeSt.id === c.id ? removeSt.message : null;
  const isPending = c.status === "pending";
  const isApproving = approveSt.kind === "approving" && approveSt.id === c.id;
  const approveError =
    approveSt.kind === "error" && approveSt.id === c.id ? approveSt.message : null;
  const when = `${c.source.module}.${c.source.event}${
    c.source.vault ? ` (${c.source.vault})` : ""
  }`;
  const doStr = `${c.sink.module}.${c.sink.action}`;
  const provenance = provenanceOf(c);
  return (
    <tr key={c.id} data-connection-id={c.id} data-requested-by={provenance}>
      <td>
        <code>{c.id}</code>
        {isPending && (
          <>
            {" "}
            <span
              className="tag"
              data-testid="pending-badge"
              title={`A module claimed a credential it already holds${
                c.provisioned.scope ? ` (${c.provisioned.scope})` : ""
              } — approving lets it renew before expiry. Nothing new is granted.`}
            >
              pending approval
            </span>
          </>
        )}
      </td>
      <td>
        <code>{when}</code>
      </td>
      <td>
        <code>{doStr}</code>
      </td>
      <td>
        {provenance === "custom" ? (
          <span className="muted">custom</span>
        ) : (
          <span className="tag" data-testid="provenance-badge">
            {provenance}
          </span>
        )}
      </td>
      <td>
        {isPending && (
          <button
            type="button"
            disabled={isApproving}
            onClick={() => void onApprove(c.id)}
            aria-label={`Approve ${c.id}`}
            data-testid="approve-connection"
            style={{ marginRight: "0.5rem" }}
          >
            {isApproving ? "Approving…" : "Approve"}
          </button>
        )}
        {isConfirming ? (
          <dialog
            open
            className="error-banner"
            style={{ marginTop: "0.25rem", background: "var(--bg-warn, #fffbe6)" }}
            aria-label={`Confirm remove ${c.id}`}
          >
            <p>
              Remove connection <code>{c.id}</code>? This tears down the provisioned trigger (and
              channel config, if any).
            </p>
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
              <button
                type="button"
                className="destructive"
                onClick={() => {
                  void onConfirmRemove(c.id);
                }}
                disabled={isRemoving}
              >
                {isRemoving ? "Removing…" : "Remove"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => setRemoveSt({ kind: "idle" })}
                disabled={isRemoving}
              >
                Cancel
              </button>
            </div>
          </dialog>
        ) : (
          <button
            type="button"
            className="secondary"
            disabled={isRemoving}
            onClick={() => setRemoveSt({ kind: "confirming", id: c.id })}
            aria-label={`Remove ${c.id}`}
          >
            {isRemoving ? "Removing…" : "Remove"}
          </button>
        )}
        {rowError && (
          <div className="error-banner" style={{ marginTop: "0.25rem" }}>
            <code>{rowError}</code>
          </div>
        )}
        {approveError && (
          <div className="error-banner" style={{ marginTop: "0.25rem" }}>
            <code>{approveError}</code>
          </div>
        )}
      </td>
    </tr>
  );
}

interface BuilderProps {
  catalog: ConnectionsCatalog;
  vaults: VaultListing[];
  sourceModule: string;
  setSourceModule: (s: string) => void;
  sourceEvent: string;
  setSourceEvent: (s: string) => void;
  vault: string;
  setVault: (s: string) => void;
  filterText: string;
  setFilterText: (s: string) => void;
  sinkModule: string;
  setSinkModule: (s: string) => void;
  sinkAction: string;
  setSinkAction: (s: string) => void;
  paramsText: string;
  setParamsText: (s: string) => void;
  createSt: CreateState;
  setCreateSt: (s: CreateState) => void;
  onSubmit: (e: FormEvent) => Promise<void>;
  onApplyTemplate: (t: CatalogTemplate) => void;
}

function BuilderSection(props: BuilderProps): React.ReactNode {
  const { catalog, createSt } = props;
  const submitting = createSt.kind === "submitting";

  // The set of source events for the selected source module, etc.
  const eventsForModule = (m: string): CatalogEvent[] =>
    catalog.events.filter((e) => e.module === m);
  const actionsForModule = (m: string): CatalogAction[] =>
    catalog.actions.filter((a) => a.module === m);
  const sourceModules = Array.from(new Set(catalog.events.map((e) => e.module)));
  const sinkModules = Array.from(new Set(catalog.actions.map((a) => a.module)));

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <h3 style={{ marginRight: "auto" }}>Build a connection</h3>
        {/* One preset button per module-declared template (boundary D2) —
            none render when no installed module declares any. */}
        {catalog.templates.map((t) => (
          <button
            key={`${t.module}/${t.key}`}
            type="button"
            className="secondary"
            onClick={() => props.onApplyTemplate(t)}
            data-testid={`preset-${t.module}-${t.key}`}
            {...(t.description ? { title: t.description } : {})}
          >
            Preset: {t.title}
          </button>
        ))}
      </div>

      <form onSubmit={(e) => void props.onSubmit(e)} aria-label="Build a connection">
        <fieldset style={{ border: "1px solid var(--border, #ddd)", padding: "0.75rem" }}>
          <legend>When (source event)</legend>
          <p>
            <label htmlFor="conn-source-module">Module</label>
            <br />
            <select
              id="conn-source-module"
              value={props.sourceModule}
              disabled={submitting}
              onChange={(e) => {
                props.setSourceModule(e.target.value);
                props.setSourceEvent("");
              }}
            >
              <option value="">— pick a module —</option>
              {sourceModules.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </p>
          {props.sourceModule && (
            <p>
              <label htmlFor="conn-source-event">Event</label>
              <br />
              <select
                id="conn-source-event"
                value={props.sourceEvent}
                disabled={submitting}
                onChange={(e) => props.setSourceEvent(e.target.value)}
              >
                <option value="">— pick an event —</option>
                {eventsForModule(props.sourceModule).map((ev) => (
                  <option key={ev.key} value={ev.key}>
                    {ev.title} ({ev.key})
                  </option>
                ))}
              </select>
            </p>
          )}
          {props.sourceModule === "vault" && (
            <p>
              <label htmlFor="conn-vault">Vault</label>
              <br />
              <select
                id="conn-vault"
                value={props.vault}
                disabled={submitting}
                onChange={(e) => props.setVault(e.target.value)}
              >
                {props.vaults.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
            </p>
          )}
          <p>
            <label htmlFor="conn-filter">
              Filter <span className="muted">(JSON — tags / has_metadata / missing_metadata)</span>
            </label>
            <br />
            <textarea
              id="conn-filter"
              value={props.filterText}
              disabled={submitting}
              rows={4}
              style={{ width: "100%", fontFamily: "monospace" }}
              onChange={(e) => props.setFilterText(e.target.value)}
              placeholder={'{ "tags": ["#channel-message/inbound"] }'}
            />
          </p>
        </fieldset>

        <fieldset
          style={{
            border: "1px solid var(--border, #ddd)",
            padding: "0.75rem",
            marginTop: "0.75rem",
          }}
        >
          <legend>Do (sink action)</legend>
          <p>
            <label htmlFor="conn-sink-module">Module</label>
            <br />
            <select
              id="conn-sink-module"
              value={props.sinkModule}
              disabled={submitting}
              onChange={(e) => {
                props.setSinkModule(e.target.value);
                props.setSinkAction("");
              }}
            >
              <option value="">— pick a module —</option>
              {sinkModules.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </p>
          {props.sinkModule && (
            <p>
              <label htmlFor="conn-sink-action">Action</label>
              <br />
              <select
                id="conn-sink-action"
                value={props.sinkAction}
                disabled={submitting}
                onChange={(e) => props.setSinkAction(e.target.value)}
              >
                <option value="">— pick an action —</option>
                {actionsForModule(props.sinkModule).map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.title} ({a.key})
                  </option>
                ))}
              </select>
            </p>
          )}
          <p>
            <label htmlFor="conn-params">
              Action params <span className="muted">(JSON — e.g. {'{ "channel": "eng" }'})</span>
            </label>
            <br />
            <textarea
              id="conn-params"
              value={props.paramsText}
              disabled={submitting}
              rows={3}
              style={{ width: "100%", fontFamily: "monospace" }}
              onChange={(e) => props.setParamsText(e.target.value)}
              placeholder={'{ "channel": "eng" }'}
            />
          </p>
        </fieldset>

        {createSt.kind === "error" && (
          <div className="error-banner" style={{ marginTop: "0.5rem" }}>
            <code>{createSt.message}</code>
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
          <button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Create connection"}
          </button>
        </div>
      </form>

      {createSt.kind === "created" && createSt.connect && (
        <ConnectPanel
          connect={createSt.connect}
          onDismiss={() => props.setCreateSt({ kind: "idle" })}
        />
      )}
      {createSt.kind === "created" && !createSt.connect && (
        <div
          className="success-banner"
          style={{ marginTop: "1rem" }}
          data-testid="connection-created"
        >
          Connection created.
        </div>
      )}
    </section>
  );
}

/** Connect-a-session panel for channel-deliver sinks (parity with hub#624). */
function ConnectPanel({
  connect,
  onDismiss,
}: {
  connect: ConnectionConnect;
  onDismiss: () => void;
}): React.ReactNode {
  return (
    <div
      className="mcp-connect-card"
      style={{ marginTop: "1rem" }}
      data-testid="connection-connect-panel"
    >
      <h3>Connect a session</h3>
      <p className="muted">
        Run these where your Claude Code session will live; authorize in the browser when prompted.
      </p>
      <div className="mcp-field">
        <span className="mcp-field-label">1 · Register the channel (MCP)</span>
        <div className="token-box">
          <code data-testid="connection-mcp-add">{connect.mcpAdd}</code>
          <CopyButton value={connect.mcpAdd} />
        </div>
      </div>
      <div className="mcp-field">
        <span className="mcp-field-label">2 · Launch a session on the channel</span>
        <div className="token-box">
          <code data-testid="connection-launch">{connect.launch}</code>
          <CopyButton value={connect.launch} />
        </div>
        <p className="muted" style={{ marginTop: "0.4rem" }}>
          ⚠ This launches Claude Code with unrestricted tool access (
          <code>--dangerously-skip-permissions</code>) — run it only on a machine you trust for that
          session.
        </p>
      </div>
      <div style={{ marginTop: "0.75rem" }}>
        <button type="button" className="secondary" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

// `SLUG_REGEX` retained for future client-side validation parity with the
// server's id/channel charset; referenced here to satisfy the linter.
export const _connectionsSlugRegex = SLUG_REGEX;
