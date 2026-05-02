/**
 * /vaults/:name — vault detail.
 *
 * Phase 1 placeholder. Phase 2+ will surface token mint/revoke,
 * attached-paraclaw-groups, and config edit. For now the page just
 * confirms the vault exists in the well-known doc and links the
 * operator to the vault's mounted URL.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { type VaultListing, listVaults } from "../lib/api.ts";

type State =
  | { kind: "loading" }
  | { kind: "ok"; vault: VaultListing }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function VaultDetail() {
  const { name } = useParams<{ name: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!name) {
      setState({ kind: "missing" });
      return;
    }
    listVaults()
      .then((vaults) => {
        if (cancelled) return;
        const vault = vaults.find((v) => v.name === name);
        setState(vault ? { kind: "ok", vault } : { kind: "missing" });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (state.kind === "loading") {
    return (
      <div>
        <h2>Vault</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div>
        <h2>Vault</h2>
        <div className="error-banner">
          <code>{state.message}</code>
        </div>
        <Link to="/vaults">← Back to vaults</Link>
      </div>
    );
  }
  if (state.kind === "missing") {
    return (
      <div>
        <h2>Vault not found</h2>
        <p className="muted">
          No vault named <code>{name}</code> is registered with this hub.
        </p>
        <Link to="/vaults">← Back to vaults</Link>
      </div>
    );
  }

  const { vault } = state;
  return (
    <div>
      <div className="list-header">
        <h2>
          Vault <code>{vault.name}</code>
        </h2>
        <Link to="/vaults" className="muted">
          ← All vaults
        </Link>
      </div>

      <div className="kv section">
        <div>Name</div>
        <div>
          <code>{vault.name}</code>
        </div>
        <div>Mount</div>
        <div>
          <code>{vault.path}</code>
        </div>
        <div>URL</div>
        <div>
          <a href={vault.url} target="_blank" rel="noreferrer">
            <code>{vault.url}</code>
          </a>
        </div>
        <div>Version</div>
        <div>
          <code>{vault.version}</code>
        </div>
      </div>

      <div className="section">
        <p className="muted">
          Token mint/revoke, paraclaw attachments, and config editing land here in Phase 2. For now,
          manage the vault directly with <code>parachute-vault</code> on the host.
        </p>
      </div>
    </div>
  );
}
