/**
 * /vaults — feature-detected compatibility route (B5, 2026-06-09
 * hub-module-boundary migration).
 *
 * Vault instance-lifecycle UX is module-owned now: vault's own surface at
 * `/vault/admin/` carries the list / create / delete experience. This route
 * exists to keep old bookmarks + old boxes working:
 *
 *   - **New-manifest vault** (`/api/modules` reports vault's
 *     `config_ui_url === "/vault/admin/"`): full-document
 *     `window.location.replace` to `/vault/admin/`. Full document — not a
 *     router navigation — because the target is a different SPA served by
 *     the vault daemon; `replace` keeps the forwarder out of history so
 *     Back doesn't bounce.
 *   - **Old-manifest vault** (config_ui_url absent/different — the box's
 *     vault predates the vault wave): render the legacy hub-side list,
 *     unchanged in spirit — anonymous well-known read, one row per vault,
 *     Manage mint + per-row usage. Creation is no longer hub-rendered (the
 *     NewVault form left with B5): the empty state deep-links the
 *     re-enterable wizard vault step; with vaults already present, new
 *     instances come from the CLI until the vault module upgrades.
 *
 * The detect read needs the host-admin Bearer (like every /api consumer);
 * a detect failure degrades to the legacy list, which still works from the
 * anonymous well-known doc.
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
  listModules,
  listVaults,
  mintVaultAdminToken,
  resolveManagementUrl,
} from "../lib/api.ts";

/**
 * The daemon-level multi-vault admin home — vault's new manifest declares
 * `configUiUrl: "/vault/admin/"` and the hub catalog resolves it verbatim
 * (origin-absolute, B4 semantics). The feature-detect is an EXACT match on
 * this resolved value: anything else (null, an http(s) escape hatch, a
 * legacy mount-joined per-instance path) keeps the legacy list.
 */
const VAULT_ADMIN_HOME = "/vault/admin/";

/** Feature-detect phase — gates all legacy rendering + fetching. */
type DetectState = "detecting" | "redirecting" | "legacy";

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
  const [detect, setDetect] = useState<DetectState>("detecting");
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [manage, setManage] = useState<ManageState>({ kind: "idle" });
  // Which row's MCP-connect card is expanded. Single-open: clicking
  // Connect on another row swaps the open card rather than stacking them.
  const [connectFor, setConnectFor] = useState<string | null>(null);
  // Per-vault usage cells, keyed by vault name. Populated by the fan-out effect
  // below once the vault list resolves.
  const [usage, setUsage] = useState<Record<string, UsageCell>>({});

  // Feature-detect FIRST — before any legacy fetch/render, so a new-vault box
  // never flashes the legacy list before the page swaps out underneath it.
  useEffect(() => {
    let cancelled = false;
    listModules()
      .then((catalog) => {
        if (cancelled) return;
        const vault = catalog.modules.find((m) => m.short === "vault");
        if (vault?.installed && vault.config_ui_url === VAULT_ADMIN_HOME) {
          setDetect("redirecting");
          window.location.replace(VAULT_ADMIN_HOME);
          return;
        }
        setDetect("legacy");
      })
      .catch(() => {
        // Catalog unreadable (network blip, non-admin session, older hub API)
        // — degrade to the legacy list; its data comes from the anonymous
        // well-known doc and still renders.
        if (cancelled) return;
        setDetect("legacy");
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    // Legacy data load waits for the feature-detect: on a new-vault box this
    // page is just a forwarder and never fetches the well-known doc.
    if (detect !== "legacy") return;
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
  }, [reload, detect]);

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

  if (detect !== "legacy") {
    // Detecting, or already navigating to /vault/admin/ — render a quiet
    // placeholder either way (the redirect replaces the document).
    return (
      <div>
        <div className="list-header">
          <h1>Vaults</h1>
        </div>
        <p className="muted" data-testid="vaults-detecting">
          {detect === "redirecting" ? "Opening the vault admin…" : "Loading…"}
        </p>
      </div>
    );
  }

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

  // When the vault MODULE isn't installed at all there's nothing to
  // provision a vault against — route the operator to /admin/modules first.
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
        ) : null}
      </div>

      <p className="muted">
        Vaults registered with this hub at <code>/.well-known/parachute.json</code>.{" "}
        <strong>Manage</strong> opens the vault's own admin app (outside the hub shell); use your
        browser's back button to return here.
      </p>
      {/* This page only renders on a box whose vault module predates the
          /vault/admin/ surface (the feature-detect above forwards everyone
          else), and the hub-side create form left with B5 — so creation here
          is CLI-or-upgrade. */}
      {state.vaults.length > 0 ? (
        <p className="muted" data-testid="vaults-legacy-create-hint">
          To create another vault, upgrade the vault module from <Link to="/modules">Modules</Link>{" "}
          (its own admin app includes create), or run{" "}
          <code>parachute vault create &lt;name&gt;</code> on the host.
        </p>
      ) : null}

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
              {/* The setup wizard's re-enterable vault step (server-rendered,
                  outside the SPA — full-document anchor, B5 bootstrap
                  exception). */}
              <a href="/admin/setup?step=vault">Create a vault →</a>
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
