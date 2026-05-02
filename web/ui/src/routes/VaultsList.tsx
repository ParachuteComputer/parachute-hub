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
import {
  HttpError,
  type VaultListing,
  listVaults,
  mintVaultAdminToken,
  resolveManagementUrl,
} from "../lib/api.ts";

type State =
  | { kind: "loading" }
  | { kind: "ok"; vaults: VaultListing[] }
  | { kind: "error"; message: string };

/**
 * Per-row mint state. Lives here (not in api.ts) because it's UI-local —
 * the user clicks Manage, we surface a spinner / error inline, and on
 * success we hand off via `window.location.assign`. No retry, no cache.
 */
type ManageState =
  | { kind: "idle" }
  | { kind: "minting"; name: string }
  | { kind: "error"; name: string; message: string };

export function VaultsList() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [manage, setManage] = useState<ManageState>({ kind: "idle" });

  async function onManage(vault: VaultListing): Promise<void> {
    if (!vault.managementUrl) return;
    setManage({ kind: "minting", name: vault.name });
    try {
      const minted = await mintVaultAdminToken(vault.name);
      const target = resolveManagementUrl(vault.url, vault.managementUrl);
      // Per vault PR #219 contract: SPA reads `#token=<jwt>` from
      // location.hash on bootstrap, then strips it via replaceState.
      // JWTs are base64url, so every byte is fragment-safe — no URL
      // encoding needed.
      const sep = target.includes("#") ? "&" : "#";
      window.location.assign(`${target}${sep}token=${minted.token}`);
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `mint failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setManage({ kind: "error", name: vault.name, message });
    }
  }

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
          {state.vaults.map((v) => {
            const isMinting = manage.kind === "minting" && manage.name === v.name;
            const rowError = manage.kind === "error" && manage.name === v.name ? manage : null;
            return (
              <div key={v.name} className="vault-row">
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
                  {rowError ? (
                    <div className="error-banner" style={{ marginTop: "0.5rem" }}>
                      <code>{rowError.message}</code>
                    </div>
                  ) : null}
                </div>
                {v.managementUrl ? (
                  <button
                    type="button"
                    onClick={() => {
                      void onManage(v);
                    }}
                    disabled={isMinting}
                    aria-label={`Manage vault ${v.name}`}
                  >
                    {isMinting ? "Opening…" : "Manage"}
                  </button>
                ) : (
                  <span
                    className="muted"
                    title="This vault has no admin SPA — manage with parachute-vault on the host."
                  >
                    CLI only
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
