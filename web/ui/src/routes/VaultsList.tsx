/**
 * /vaults — index page.
 *
 * Reads the hub's well-known discovery doc anonymously and renders a row
 * per vault. No auth required for read; clicking "New vault" lands on the
 * create form which mints a host-admin JWT via session cookie.
 *
 * State is a tagged union (loading | ok | error) so the page never flashes
 * partial UI: either a skeleton, the rows, or an error banner with retry.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type VaultListing, listVaults } from "../lib/api.ts";

type State =
  | { kind: "loading" }
  | { kind: "ok"; vaults: VaultListing[] }
  | { kind: "error"; message: string };

export function VaultsList() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    // `reload` is the trigger — re-running the effect on bump is the
    // whole point of the dep. Biome's exhaustive-deps rule doesn't
    // know about "trigger only" deps, so suppress the warning here.
    void reload;
    let cancelled = false;
    listVaults()
      .then((vaults) => {
        if (cancelled) return;
        setState({ kind: "ok", vaults });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  if (state.kind === "loading") {
    return (
      <div>
        <div className="list-header">
          <h2>Vaults</h2>
        </div>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <div className="list-header">
          <h2>Vaults</h2>
          <Link to="/vaults/new">
            <button type="button">New vault</button>
          </Link>
        </div>
        <div className="error-banner">
          Couldn't load vaults: <code>{state.message}</code>
        </div>
        <button type="button" onClick={() => setReload((n) => n + 1)} className="secondary">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>Vaults ({state.vaults.length})</h2>
        <Link to="/vaults/new">
          <button type="button">New vault</button>
        </Link>
      </div>

      <p className="muted">
        Vaults registered with this hub at <code>/.well-known/parachute.json</code>.
      </p>

      {state.vaults.length === 0 ? (
        <div className="empty empty-rich">
          <p className="empty-headline">No vaults yet.</p>
          <p className="muted">
            Create your first vault to start storing tokens, secrets, and notes scoped to this hub.
          </p>
          <p style={{ marginTop: "0.75rem" }}>
            <Link to="/vaults/new">Create a vault →</Link>
          </p>
        </div>
      ) : (
        <div style={{ marginTop: "1rem" }}>
          {state.vaults.map((v) => (
            <Link key={v.name} to={`/vaults/${encodeURIComponent(v.name)}`} className="vault-row">
              <div className="body">
                <div className="name">
                  <code>{v.name}</code>
                  <span className="tag muted" title="Vault version">
                    v{v.version}
                  </span>
                </div>
                <div className="dim url">
                  <code>{v.url}</code>
                </div>
              </div>
              <span className="chev" aria-hidden="true">
                ›
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
