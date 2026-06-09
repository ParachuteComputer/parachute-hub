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
import { McpConnectCard } from "../components/McpConnectCard.tsx";
import {
  HttpError,
  type VaultListing,
  type VaultUsage,
  formatBytes,
  getVaultUsage,
  listVaults,
  mintVaultAdminToken,
  resolveManagementUrl,
} from "../lib/api.ts";

type State =
  | { kind: "loading" }
  | { kind: "ok"; vaults: VaultListing[]; moduleInstalled: boolean }
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

/**
 * Per-vault usage cell state. Client-side fan-out: one small request per row,
 * each independently fault-tolerant — a vault whose usage endpoint fails (down,
 * older vault without the endpoint, mint failure) shows "—" rather than
 * breaking the list. `loading` while in flight, `ok` with the stat, `error`
 * collapses to the "—" placeholder.
 */
type UsageCell = { kind: "loading" } | { kind: "ok"; usage: VaultUsage } | { kind: "error" };

export function VaultsList() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [manage, setManage] = useState<ManageState>({ kind: "idle" });
  // Which row's MCP-connect card is expanded. Single-open: clicking
  // Connect on another row swaps the open card rather than stacking them.
  const [connectFor, setConnectFor] = useState<string | null>(null);
  // Per-vault usage cells, keyed by vault name. Populated by the fan-out effect
  // below once the vault list resolves.
  const [usage, setUsage] = useState<Record<string, UsageCell>>({});

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
      .then((result) => {
        if (cancelled) return;
        setState({
          kind: "ok",
          vaults: result.vaults,
          moduleInstalled: result.moduleInstalled,
        });
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

  // Fan out per-vault usage once the list resolves. Each row's fetch is
  // independent + fault-tolerant: success → its cell shows the stat, any failure
  // → "—". Re-runs when the vault set changes (create / reload). The cell is
  // seeded "loading" so the row shows a placeholder until its request settles.
  useEffect(() => {
    if (state.kind !== "ok") return;
    const names = state.vaults.map((v) => v.name);
    if (names.length === 0) return;
    let cancelled = false;
    setUsage((prev) => {
      const next = { ...prev };
      for (const name of names) if (!next[name]) next[name] = { kind: "loading" };
      return next;
    });
    for (const name of names) {
      getVaultUsage(name)
        .then((u) => {
          if (cancelled) return;
          setUsage((prev) => ({ ...prev, [name]: { kind: "ok", usage: u } }));
        })
        .catch(() => {
          if (cancelled) return;
          setUsage((prev) => ({ ...prev, [name]: { kind: "error" } }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [state]);

  if (state.kind === "loading") {
    return (
      <div>
        <div className="list-header">
          <h1>Vaults</h1>
        </div>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <div className="list-header">
          <h1>Vaults</h1>
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

  // When the vault MODULE isn't installed at all, "New vault" can't
  // succeed — the hub has no vault backend to provision against. Gate
  // both the header CTA + the empty-state copy on `moduleInstalled` so
  // the operator gets routed to /admin/modules first.
  const moduleMissing = state.vaults.length === 0 && !state.moduleInstalled;

  return (
    <div data-route-content="true">
      <div className="list-header">
        <h1>Vaults ({state.vaults.length})</h1>
        {moduleMissing ? (
          // Cross-SPA-route navigation stays inside the SPA basename, so
          // react-router's <Link> resolves to /admin/modules. Plain
          // anchor would 301-bounce or fail under the /admin basename.
          <Link to="/modules">
            <button type="button">Install vault module</button>
          </Link>
        ) : (
          <Link to="/vaults/new">
            <button type="button">New vault</button>
          </Link>
        )}
      </div>

      <p className="muted">
        Vaults registered with this hub at <code>/.well-known/parachute.json</code>.{" "}
        <strong>Manage</strong> opens the vault's own admin app (outside the hub shell); use your
        browser's back button to return here.
      </p>

      {state.vaults.length === 0 ? (
        moduleMissing ? (
          <div className="empty empty-rich">
            <p className="empty-headline">No vault module installed.</p>
            <p className="muted">
              The vault backend isn't installed on this hub yet, so there's nothing to provision a
              vault against. Install it from the Modules page first, then come back here to create
              your first vault.
            </p>
            <p style={{ marginTop: "0.75rem" }}>
              <Link to="/modules">Install vault module →</Link>
            </p>
          </div>
        ) : (
          <div className="empty empty-rich">
            <p className="empty-headline">No vaults yet.</p>
            <p className="muted">
              Create your first vault to start storing tokens, secrets, and notes scoped to this
              hub.
            </p>
            <p style={{ marginTop: "0.75rem" }}>
              <Link to="/vaults/new">Create a vault →</Link>
            </p>
          </div>
        )
      ) : (
        <div style={{ marginTop: "1rem" }}>
          {state.vaults.map((v) => {
            const isMinting = manage.kind === "minting" && manage.name === v.name;
            const rowError = manage.kind === "error" && manage.name === v.name ? manage : null;
            const isConnectOpen = connectFor === v.name;
            const usageCell = usage[v.name];
            const usageText =
              usageCell?.kind === "ok"
                ? `${usageCell.usage.notes} ${usageCell.usage.notes === 1 ? "note" : "notes"} · ${formatBytes(usageCell.usage.totalBytes)}`
                : usageCell?.kind === "loading"
                  ? "…"
                  : "—";
            return (
              <div key={v.name} className="vault-row-group">
                <div className="vault-row">
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
                    <div className="dim vault-usage" data-testid={`vault-usage-${v.name}`}>
                      {usageText}
                    </div>
                    {rowError ? (
                      <div className="error-banner" style={{ marginTop: "0.5rem" }}>
                        <code>{rowError.message}</code>
                      </div>
                    ) : null}
                  </div>
                  <div className="vault-row-actions">
                    <button
                      type="button"
                      className={isConnectOpen ? undefined : "secondary"}
                      aria-expanded={isConnectOpen}
                      aria-label={`Connect an MCP client to vault ${v.name}`}
                      onClick={() => setConnectFor((cur) => (cur === v.name ? null : v.name))}
                    >
                      {isConnectOpen ? "Hide connect" : "Connect"}
                    </button>
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
                </div>
                {isConnectOpen ? <McpConnectCard vaultName={v.name} vaultUrl={v.url} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
