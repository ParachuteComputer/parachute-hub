/**
 * /permissions — operator's OAuth-grant skip-list.
 *
 * Lists every grant the operator has handed out via consent. A grant means
 * "next time this client asks for these scopes, skip the consent screen."
 * Revoking a grant *only* forces the consent screen back on the next
 * authorize flow; active tokens keep working until they expire (or the
 * operator hits /oauth/revoke separately, out of scope here).
 *
 * The `?vault=<name>` filter narrows to grants that touch a specific
 * vault. We pass it through as a query string on `listGrants`; the server
 * scope-matches `vault:<name>:*`. Empty filter means "all grants".
 *
 * Revoke flow is two-step: click → confirm modal → DELETE → refresh list.
 * The confirm modal exists because revoking is destructive (consent flow
 * comes back; the user re-approves from scratch); a stray click should
 * not erase a grant silently.
 *
 * Pagination: currently unpaginated — the grants table is small in
 * practice. When this grows pagination, mirror the canonical pattern in
 * Tokens.tsx `loadMore` (loadingMore boolean + disabled attr + early
 * return). See web/ui/CLAUDE.md § Pagination convention. (hub#229)
 */
import { type FormEvent, useEffect, useState } from "react";
import { type AdminGrantListing, HttpError, listGrants, revokeGrant } from "../lib/api.ts";

type State =
  | { kind: "loading" }
  | { kind: "ok"; grants: AdminGrantListing[] }
  | { kind: "error"; message: string };

type RevokeState =
  | { kind: "idle" }
  | { kind: "confirming"; grant: AdminGrantListing }
  | { kind: "revoking"; clientId: string }
  | { kind: "error"; clientId: string; message: string };

export function Permissions() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [vaultInput, setVaultInput] = useState("");
  const [vaultFilter, setVaultFilter] = useState<string>("");
  const [reload, setReload] = useState(0);
  const [revoke, setRevoke] = useState<RevokeState>({ kind: "idle" });

  useEffect(() => {
    // `reload` is a trigger dep — re-running the effect is the whole
    // point of incrementing it. Same pattern as VaultsList.
    void reload;
    let cancelled = false;
    setState({ kind: "loading" });
    const opts = vaultFilter ? { vault: vaultFilter } : {};
    listGrants(opts)
      .then((grants) => {
        if (cancelled) return;
        setState({ kind: "ok", grants });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [reload, vaultFilter]);

  function onSubmitFilter(e: FormEvent) {
    e.preventDefault();
    setVaultFilter(vaultInput.trim());
  }
  function onClearFilter() {
    setVaultInput("");
    setVaultFilter("");
  }

  async function onConfirmRevoke(grant: AdminGrantListing): Promise<void> {
    setRevoke({ kind: "revoking", clientId: grant.client_id });
    try {
      await revokeGrant(grant.client_id);
      setRevoke({ kind: "idle" });
      setReload((n) => n + 1);
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `revoke failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setRevoke({ kind: "error", clientId: grant.client_id, message });
    }
  }

  return (
    <div>
      <div className="list-header">
        <h2>Permissions</h2>
      </div>

      <p className="muted">
        Apps you've granted OAuth scopes to. Revoking a grant forces the consent screen on the next
        authorize flow — it does <em>not</em> invalidate tokens already issued.
      </p>

      <form onSubmit={onSubmitFilter} style={{ marginTop: "1rem", marginBottom: "1rem" }}>
        <label htmlFor="vault-filter" className="muted" style={{ marginRight: "0.5rem" }}>
          Filter by vault:
        </label>
        <input
          id="vault-filter"
          type="text"
          value={vaultInput}
          onChange={(e) => setVaultInput(e.target.value)}
          placeholder="e.g. work"
          style={{ marginRight: "0.5rem" }}
        />
        <button type="submit">Apply</button>
        {vaultFilter ? (
          <button
            type="button"
            onClick={onClearFilter}
            className="secondary"
            style={{ marginLeft: "0.5rem" }}
          >
            Clear
          </button>
        ) : null}
      </form>

      {renderBody({
        state,
        revoke,
        setRevoke,
        onConfirm: onConfirmRevoke,
        onRetry: () => setReload((n) => n + 1),
      })}
    </div>
  );
}

interface RenderBodyProps {
  state: State;
  revoke: RevokeState;
  setRevoke: (s: RevokeState) => void;
  onConfirm: (grant: AdminGrantListing) => Promise<void>;
  onRetry: () => void;
}

function renderBody({ state, revoke, setRevoke, onConfirm, onRetry }: RenderBodyProps) {
  if (state.kind === "loading") {
    return <p className="muted">Loading…</p>;
  }
  if (state.kind === "error") {
    return (
      <>
        <div className="error-banner">
          Couldn't load grants: <code>{state.message}</code>
        </div>
        <button type="button" onClick={onRetry} className="secondary">
          Retry
        </button>
      </>
    );
  }
  if (state.grants.length === 0) {
    return (
      <div className="empty empty-rich">
        <p className="empty-headline">No grants.</p>
        <p className="muted">
          When an app asks for OAuth scopes and you approve them, the grant lands here. Revoking it
          forces the consent screen on the next authorize flow.
        </p>
      </div>
    );
  }

  return (
    <div style={{ marginTop: "1rem" }}>
      {state.grants.map((g) => {
        const isRevoking = revoke.kind === "revoking" && revoke.clientId === g.client_id;
        const rowError = revoke.kind === "error" && revoke.clientId === g.client_id ? revoke : null;
        const isConfirming = revoke.kind === "confirming" && revoke.grant.client_id === g.client_id;

        return (
          <div key={g.client_id} className="vault-row">
            <div className="body">
              <div className="name">
                <code>{g.client_name ?? g.client_id}</code>
              </div>
              <div className="dim">
                <span className="muted">granted </span>
                <code title={g.granted_at}>{formatGrantedAt(g.granted_at)}</code>
              </div>
              <div className="dim" style={{ marginTop: "0.25rem" }}>
                <span className="muted">scopes: </span>
                {g.scopes.map((s, i) => (
                  <span key={s}>
                    <code>{s}</code>
                    {i < g.scopes.length - 1 ? " " : null}
                  </span>
                ))}
              </div>
              {rowError ? (
                <div className="error-banner" style={{ marginTop: "0.5rem" }}>
                  <code>{rowError.message}</code>
                </div>
              ) : null}
              {isConfirming ? (
                <dialog
                  open
                  className="error-banner"
                  style={{ marginTop: "0.5rem", background: "var(--bg-warn, #fffbe6)" }}
                  aria-label={`Confirm revoke ${g.client_name ?? g.client_id}`}
                >
                  <p>
                    Revoke <code>{g.client_name ?? g.client_id}</code>? Next OAuth flow for this app
                    will prompt you to consent again.
                  </p>
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                    <button
                      type="button"
                      onClick={() => {
                        void onConfirm(g);
                      }}
                      disabled={isRevoking}
                    >
                      {isRevoking ? "Revoking…" : "Revoke"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setRevoke({ kind: "idle" })}
                      disabled={isRevoking}
                    >
                      Cancel
                    </button>
                  </div>
                </dialog>
              ) : null}
            </div>
            {isConfirming ? null : (
              <button
                type="button"
                className="secondary"
                onClick={() => setRevoke({ kind: "confirming", grant: g })}
                aria-label={`Revoke ${g.client_name ?? g.client_id}`}
              >
                Revoke
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatGrantedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
