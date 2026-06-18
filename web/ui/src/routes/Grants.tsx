/**
 * /admin/grants — the agent-connector GRANTS approval view (Phase 4b-1).
 *
 * An agent (a `#agent/definition` note in the agent module) declares connections
 * it WANTS beyond its own def-vault — other LOCAL vaults (tag-scoped) and
 * external SERVICE credentials (GitHub, Cloudflare). The agent module registers
 * each as a PENDING grant with the hub; THIS view is where the operator approves
 * per-connection. On approve, the hub mints (vault) / stores the pasted token
 * (service). Revoke drops the stored secret — the agent loses it next spawn.
 *
 * The one invariant (design 2026-06-17): a vault note can only REQUEST; it can
 * never GRANT. A pending grant grants nothing until the operator clicks Approve
 * here. So defining agents "from any chat" is safe — worst case a request sits
 * pending.
 *
 * The `mcp` (remote/OAuth) kind is modeled but not grantable in 4b-1 — its
 * Approve is disabled with "OAuth coming in 4b-2 — not yet grantable."
 *
 * Auth: list is host-admin-Bearer (`lib/api.ts:listAgentGrants`); approve/revoke
 * are cookie-authed first-admin routes. The `lib/api.ts` helpers redirect to
 * login on 401 and surface `error_description` verbatim. Modeled on
 * Connections.tsx for visual continuity.
 */
import { useEffect, useState } from "react";
import {
  type GrantConnection,
  type GrantListing,
  HttpError,
  approveAgentGrant,
  listAgentGrants,
  revokeAgentGrant,
} from "../lib/api.ts";

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; grants: GrantListing[] }
  | { kind: "error"; message: string };

/** Per-row action state. `tokenFor` carries the in-progress service token paste. */
type RowState =
  | { kind: "idle" }
  | { kind: "pasting"; id: string; token: string }
  | { kind: "working"; id: string }
  | { kind: "error"; id: string; message: string };

function errMessage(err: unknown, verb: string): string {
  if (err instanceof HttpError) return err.message;
  if (err instanceof Error) return err.message;
  return `${verb} failed`;
}

export function Grants(): React.ReactElement {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [rowSt, setRowSt] = useState<RowState>({ kind: "idle" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    void reload; // re-run on manual reload bumps (Approve/Revoke/Retry)
    let cancelled = false;
    setState({ kind: "loading" });
    listAgentGrants()
      .then((grants) => {
        if (!cancelled) setState({ kind: "ok", grants });
      })
      .catch((err) => {
        if (!cancelled) setState({ kind: "error", message: errMessage(err, "Load") });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  async function onApproveVault(id: string): Promise<void> {
    setRowSt({ kind: "working", id });
    try {
      await approveAgentGrant(id);
      setRowSt({ kind: "idle" });
      setReload((n) => n + 1);
    } catch (err) {
      setRowSt({ kind: "error", id, message: errMessage(err, "Approve") });
    }
  }

  async function onApproveService(id: string, token: string): Promise<void> {
    if (token.trim().length === 0) {
      setRowSt({ kind: "error", id, message: "Paste the API token before approving." });
      return;
    }
    setRowSt({ kind: "working", id });
    try {
      await approveAgentGrant(id, token);
      setRowSt({ kind: "idle" });
      setReload((n) => n + 1);
    } catch (err) {
      setRowSt({ kind: "error", id, message: errMessage(err, "Approve") });
    }
  }

  async function onRevoke(id: string): Promise<void> {
    setRowSt({ kind: "working", id });
    try {
      await revokeAgentGrant(id);
      setRowSt({ kind: "idle" });
      setReload((n) => n + 1);
    } catch (err) {
      setRowSt({ kind: "error", id, message: errMessage(err, "Revoke") });
    }
  }

  return (
    <div data-route-content="true">
      <div className="list-header">
        <h1>Grants</h1>
      </div>

      <p className="muted">
        Agents declare connections they want beyond their own vault — other vaults (tag-scoped) and
        external service credentials. Each one waits here for your approval. A vault note can only{" "}
        <em>request</em>; nothing is granted until you approve it below.
      </p>

      {renderBody(state, rowSt, setRowSt, {
        onApproveVault,
        onApproveService,
        onRevoke,
        onRetry: () => setReload((n) => n + 1),
      })}
    </div>
  );
}

interface RowActions {
  onApproveVault: (id: string) => Promise<void>;
  onApproveService: (id: string, token: string) => Promise<void>;
  onRevoke: (id: string) => Promise<void>;
  onRetry: () => void;
}

function renderBody(
  state: ListState,
  rowSt: RowState,
  setRowSt: (s: RowState) => void,
  actions: RowActions,
): React.ReactElement {
  if (state.kind === "loading") return <p className="muted">Loading grants…</p>;
  if (state.kind === "error") {
    return (
      <div>
        <div className="error-banner">{state.message}</div>
        <button type="button" onClick={actions.onRetry} className="secondary">
          Retry
        </button>
      </div>
    );
  }
  if (state.grants.length === 0) {
    return (
      <div className="empty empty-rich">
        <p className="empty-headline">No grant requests yet.</p>
        <p className="muted">
          When an agent declares a connection it wants, it shows up here for approval.
        </p>
      </div>
    );
  }

  // Group by agent for the approval UI.
  const byAgent = new Map<string, GrantListing[]>();
  for (const g of state.grants) {
    const list = byAgent.get(g.agent) ?? [];
    list.push(g);
    byAgent.set(g.agent, list);
  }
  const agents = [...byAgent.keys()].sort();

  return (
    <div className="grants-groups">
      {agents.map((agent) => (
        <section key={agent} aria-label={`Grants for ${agent}`} style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ marginBottom: "0.25rem" }}>{agent}</h3>
          <div className="table-scroll">
            <table className="channel-table">
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(byAgent.get(agent) ?? []).map((g) => (
                  <GrantRow
                    key={g.id}
                    grant={g}
                    rowSt={rowSt}
                    setRowSt={setRowSt}
                    actions={actions}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function connectionLabel(c: GrantConnection): string {
  if (c.kind === "vault") {
    const access = c.access ?? "read";
    const tags = c.tags && c.tags.length > 0 ? ` (${c.tags.join(", ")})` : "";
    return `vault: ${c.target} · ${access}${tags}`;
  }
  if (c.kind === "service") {
    const inject = c.inject && c.inject.length > 0 ? ` · inject: ${c.inject.join("+")}` : "";
    return `service: ${c.target}${inject}`;
  }
  return `mcp: ${c.target}`;
}

function GrantRow({
  grant,
  rowSt,
  setRowSt,
  actions,
}: {
  grant: GrantListing;
  rowSt: RowState;
  setRowSt: (s: RowState) => void;
  actions: RowActions;
}): React.ReactElement {
  const busy = rowSt.kind === "working" && rowSt.id === grant.id;
  const rowError = rowSt.kind === "error" && rowSt.id === grant.id ? rowSt.message : null;
  const c = grant.connection;
  const isMcp = c.kind === "mcp";
  const isService = c.kind === "service";
  const pasting = rowSt.kind === "pasting" && rowSt.id === grant.id ? rowSt.token : null;

  return (
    <tr data-grant-id={grant.id}>
      <td>
        <code>{connectionLabel(c)}</code>
      </td>
      <td>
        <span className={`status status-${grant.status}`}>{grant.status}</span>
        {grant.reason && <span className="muted"> — {grant.reason}</span>}
      </td>
      <td>
        {/* mcp — modeled, not grantable in 4b-1. */}
        {isMcp && <span className="muted">OAuth coming in 4b-2 — not yet grantable.</span>}

        {/* not-yet-granted vault (pending OR revoked) — single-click approve
            (the hub mints; approving a revoked grant re-mints fresh material). */}
        {!isMcp && grant.status !== "approved" && c.kind === "vault" && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => actions.onApproveVault(grant.id)}
          >
            {busy ? "Approving…" : grant.status === "revoked" ? "Re-approve" : "Approve"}
          </button>
        )}

        {/* not-yet-granted service (pending OR revoked) — paste the API token,
            then approve. */}
        {!isMcp && grant.status !== "approved" && isService && pasting === null && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => setRowSt({ kind: "pasting", id: grant.id, token: "" })}
          >
            {grant.status === "revoked" ? "Re-approve…" : "Approve…"}
          </button>
        )}
        {!isMcp && grant.status !== "approved" && isService && pasting !== null && (
          <span style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
            <input
              type="password"
              aria-label={`API token for ${c.target}`}
              placeholder={`${c.target} API token`}
              value={pasting}
              onChange={(e) => setRowSt({ kind: "pasting", id: grant.id, token: e.target.value })}
            />
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => actions.onApproveService(grant.id, pasting)}
            >
              {busy ? "Approving…" : "Save & approve"}
            </button>
            <button type="button" className="secondary" onClick={() => setRowSt({ kind: "idle" })}>
              Cancel
            </button>
          </span>
        )}

        {/* approved — revoke. */}
        {grant.status === "approved" && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => actions.onRevoke(grant.id)}
          >
            {busy ? "Revoking…" : "Revoke"}
          </button>
        )}

        {rowError && <span className="error-inline"> {rowError}</span>}
      </td>
    </tr>
  );
}
