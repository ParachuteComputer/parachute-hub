/**
 * /admin/modules — admin UI for installing / restarting / upgrading /
 * uninstalling Parachute modules at runtime.
 *
 * The v0.6 release bar: a friend can fork + click Deploy to Render +
 * land here + install vault / notes / scribe via UI in under 5 minutes.
 *
 * Two response shapes off the API:
 *   - Restart / uninstall are synchronous — the POST returns the new
 *     state and we re-fetch the catalog.
 *   - Install / upgrade are async — the POST returns an operation_id
 *     and we poll GET /api/modules/operations/:id every second until
 *     terminal. The op's `log` array drives a small progress banner.
 *
 * Layout (hub#260 closeout): two clear sections, **Installed modules**
 * on top + **Install a module** below. The split makes the "what's
 * available to add?" affordance discoverable — pre-hub#260 the install
 * + upgrade actions were wired but every module rendered as one row in
 * a single list, so a fresh-deploy operator had to scan past three
 * tagline+meta blocks to find the Install buttons. With the split, an
 * empty hub lands on a near-empty Installed section + a clear "Install
 * a module" catalog underneath; a populated hub lands on its modules
 * up top + a smaller "available to add" list underneath.
 *
 * `supervisor_available: false` is the on-box CLI path (no `parachute
 * serve`). Actions get disabled and a small banner tells the operator
 * to use `parachute install/upgrade/restart` from their shell instead.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ModuleInstallChannel,
  type ModuleListing,
  type ModuleOperation,
  type ModulesCatalog,
  getModuleOperation,
  installModule,
  listModules,
  restartModule,
  setModuleChannel,
  uninstallModule,
  upgradeModule,
} from "../lib/api.ts";

type CatalogState =
  | { kind: "loading" }
  | { kind: "ok"; catalog: ModulesCatalog }
  | { kind: "error"; message: string };

interface PendingOp {
  kind: "install" | "upgrade";
  operationId: string;
  short: string;
  log: string[];
  status: ModuleOperation["status"];
  error?: string;
}

const POLL_INTERVAL_MS = 1000;

export function Modules() {
  const [catalog, setCatalog] = useState<CatalogState>({ kind: "loading" });
  const [pendingOps, setPendingOps] = useState<PendingOp[]>([]);
  // Per-module disabled state for the sync actions, so a fast-finger
  // operator can't fire restart twice in flight.
  const [syncBusy, setSyncBusy] = useState<Record<string, boolean>>({});
  // Surfaces a sync action's error message inline on the row.
  const [syncError, setSyncError] = useState<Record<string, string>>({});

  const refreshCatalog = useCallback(async () => {
    try {
      const next = await listModules();
      setCatalog({ kind: "ok", catalog: next });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setCatalog({ kind: "error", message: msg });
    }
  }, []);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  // Poll any pending async operations. One interval per page mount,
  // batched against all current pendingOps each tick so an operator
  // who kicks off install on every module sees a single timer driving
  // them all.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (pendingOps.length === 0) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      void Promise.all(
        pendingOps.map(async (p) => {
          try {
            const op = await getModuleOperation(p.operationId);
            setPendingOps((prev) =>
              prev.map((q) =>
                q.operationId === op.id
                  ? { ...q, log: op.log, status: op.status, error: op.error }
                  : q,
              ),
            );
            if (op.status === "succeeded" || op.status === "failed") {
              // Terminal — drop after a beat so the operator can see
              // the final log line, then refresh the catalog.
              setTimeout(() => {
                setPendingOps((prev) => prev.filter((q) => q.operationId !== op.id));
                void refreshCatalog();
              }, 1500);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            setPendingOps((prev) =>
              prev.map((q) =>
                q.operationId === p.operationId ? { ...q, status: "failed", error: msg } : q,
              ),
            );
          }
        }),
      );
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [pendingOps, refreshCatalog]);

  async function onInstall(short: string) {
    // Clear any previous error on this module so a retry isn't shadowed
    // by stale text — same shape as onRestart / onUninstall below.
    setSyncError((prev) => {
      const next = { ...prev };
      delete next[short];
      return next;
    });
    try {
      const operationId = await installModule(short);
      setPendingOps((prev) => [
        ...prev,
        { kind: "install", operationId, short, log: [], status: "pending" },
      ]);
    } catch (err) {
      setSyncError((prev) => ({
        ...prev,
        [short]: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function onUpgrade(short: string) {
    setSyncError((prev) => {
      const next = { ...prev };
      delete next[short];
      return next;
    });
    try {
      const operationId = await upgradeModule(short);
      setPendingOps((prev) => [
        ...prev,
        { kind: "upgrade", operationId, short, log: [], status: "pending" },
      ]);
    } catch (err) {
      setSyncError((prev) => ({
        ...prev,
        [short]: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function onRestart(short: string) {
    if (syncBusy[short]) return;
    setSyncBusy((prev) => ({ ...prev, [short]: true }));
    setSyncError((prev) => {
      const next = { ...prev };
      delete next[short];
      return next;
    });
    try {
      await restartModule(short);
      await refreshCatalog();
    } catch (err) {
      setSyncError((prev) => ({
        ...prev,
        [short]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setSyncBusy((prev) => ({ ...prev, [short]: false }));
    }
  }

  async function onUninstall(short: string) {
    if (syncBusy[short]) return;
    if (
      !window.confirm(
        `Uninstall ${short}? The container will stop the service, remove the package, and drop its services.json entry. The persistent disk's data dir is left intact.`,
      )
    ) {
      return;
    }
    setSyncBusy((prev) => ({ ...prev, [short]: true }));
    setSyncError((prev) => {
      const next = { ...prev };
      delete next[short];
      return next;
    });
    try {
      await uninstallModule(short);
      await refreshCatalog();
    } catch (err) {
      setSyncError((prev) => ({
        ...prev,
        [short]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setSyncBusy((prev) => ({ ...prev, [short]: false }));
    }
  }

  if (catalog.kind === "loading") {
    return <div className="empty">Loading modules…</div>;
  }
  if (catalog.kind === "error") {
    if (catalog.message.includes("setup_required")) {
      return (
        <div className="empty">
          Hub not yet configured. <a href="/admin/setup">Finish first-boot setup</a> first.
        </div>
      );
    }
    return (
      <div className="empty">
        Failed to load modules: {catalog.message}.{" "}
        <button type="button" onClick={() => void refreshCatalog()}>
          Retry
        </button>
      </div>
    );
  }

  // Narrow snapshot for the synchronous render path. `setCatalog` calls
  // inside `onChangeChannel` use the functional form (`prev =>`) to avoid
  // re-narrowing the outer `catalog` ref across the await boundary.
  const okCatalog = catalog.catalog;
  const { modules, supervisor_available, module_install_channel } = okCatalog;

  // Two visual buckets driven entirely off the wire shape — no client
  // re-derivation of "is this available". Modules with `installed: true`
  // go on top (operator's running set); modules with `available: true`
  // and `!installed` go below as the install catalog.
  const installedModules = modules.filter((m) => m.installed);
  const installableModules = modules.filter((m) => !m.installed && m.available);

  // While an install op is in flight for a given short, the catalog
  // hasn't refreshed yet (we wait for the terminal poll) so the module
  // still appears under "Install a module". Track shorts with an
  // in-flight install op so we can suppress the duplicate render until
  // the catalog refresh moves the row to the Installed section.
  const installingShorts = new Set(
    pendingOps.filter((p) => p.kind === "install").map((p) => p.short),
  );
  const visibleInstallable = installableModules.filter((m) => !installingShorts.has(m.short));

  async function onChangeChannel(next: ModuleInstallChannel) {
    if (next === module_install_channel) return;
    // Optimistic update so the radio reflects the click before the
    // round-trip lands; on failure we surface an error state.
    setCatalog({
      kind: "ok",
      catalog: { ...okCatalog, module_install_channel: next },
    });
    try {
      const written = await setModuleChannel(next);
      // Trust the server's echo (it's the source of truth).
      setCatalog((prev) =>
        prev.kind === "ok"
          ? { kind: "ok", catalog: { ...prev.catalog, module_install_channel: written } }
          : prev,
      );
    } catch (err) {
      // On PUT failure, collapse to error state (matches existing
      // catalog-fetch failure UX). The retry button reloads the whole
      // catalog from scratch.
      const msg = err instanceof Error ? err.message : String(err);
      setCatalog({ kind: "error", message: `Failed to update channel — ${msg}` });
    }
  }

  return (
    <section className="modules">
      <h1>Modules</h1>
      <p className="muted">
        Install, upgrade, and manage Parachute modules. Available modules are pinned for the v0.6
        release; the marketplace is on the roadmap.
      </p>

      <ChannelToggle
        channel={module_install_channel}
        disabled={!supervisor_available}
        onChange={(c) => void onChangeChannel(c)}
      />

      {!supervisor_available && (
        <div className="banner banner-info">
          This hub is running outside container mode (no supervisor wired). Module install / restart
          / upgrade is available only under <code>parachute serve</code>. On-box installs use{" "}
          <code>parachute install vault</code> etc. from a shell instead.
        </div>
      )}

      {pendingOps.length > 0 && (
        <div className="banner" data-testid="pending-ops-banner">
          <strong>In progress:</strong>
          <ul>
            {pendingOps.map((p) => (
              <li key={p.operationId}>
                <code>{p.short}</code> · {p.kind} · status: {p.status}
                {p.error ? ` · error: ${p.error}` : null}
                {p.log.length > 0 && (
                  <details>
                    <summary>{p.log.length} log line(s)</summary>
                    <pre>{p.log.join("\n")}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="modules-installed" data-testid="installed-section">
        <h2>Installed modules</h2>
        {installedModules.length === 0 ? (
          <p className="muted" data-testid="installed-empty">
            No modules installed yet. Pick one from <strong>Install a module</strong> below to get
            started.
          </p>
        ) : (
          <ul className="module-list">
            {installedModules.map((mod) => (
              <ModuleRow
                key={mod.short}
                module={mod}
                supervisorAvailable={supervisor_available}
                syncBusy={Boolean(syncBusy[mod.short])}
                errorMessage={syncError[mod.short]}
                onUpgrade={() => void onUpgrade(mod.short)}
                onRestart={() => void onRestart(mod.short)}
                onUninstall={() => void onUninstall(mod.short)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="modules-installable" data-testid="installable-section">
        <h2>Install a module</h2>
        {visibleInstallable.length === 0 ? (
          <p className="muted" data-testid="installable-empty">
            {installingShorts.size > 0
              ? "Install in progress — see In progress above."
              : "All available modules are installed."}
          </p>
        ) : (
          <ul className="install-list">
            {visibleInstallable.map((mod) => (
              <InstallableCard
                key={mod.short}
                module={mod}
                supervisorAvailable={supervisor_available}
                installing={installingShorts.has(mod.short)}
                errorMessage={syncError[mod.short]}
                onInstall={() => void onInstall(mod.short)}
              />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

interface ModuleRowProps {
  module: ModuleListing;
  supervisorAvailable: boolean;
  syncBusy: boolean;
  errorMessage: string | undefined;
  onUpgrade: () => void;
  onRestart: () => void;
  onUninstall: () => void;
}

/**
 * Row for an installed module — shows version + supervisor status +
 * Configure / Restart / Upgrade / Uninstall affordances. The "install"
 * action lives on `InstallableCard` instead; this row is only rendered
 * for `installed: true` modules.
 */
function ModuleRow({
  module: mod,
  supervisorAvailable,
  syncBusy,
  errorMessage,
  onUpgrade,
  onRestart,
  onUninstall,
}: ModuleRowProps) {
  const canAct = supervisorAvailable && !syncBusy;
  const upgradeAvailable =
    mod.installed_version !== mod.latest_version && mod.latest_version !== null;

  return (
    <li className="module-row" data-short={mod.short}>
      <header>
        <h2>
          {mod.display_name} <span className="muted">({mod.short})</span>
        </h2>
        <span className={`status status-${mod.supervisor_status ?? "absent"}`}>
          {statusLabel(mod)}
        </span>
      </header>
      {mod.tagline ? <p className="tagline">{mod.tagline}</p> : null}

      <dl className="meta">
        <dt>Package</dt>
        <dd>
          <code>{mod.package}</code>
        </dd>
        <dt>Installed</dt>
        <dd>
          v{mod.installed_version ?? "unknown"}
          {upgradeAvailable && <span className="badge">v{mod.latest_version} available</span>}
        </dd>
        {mod.pid && (
          <>
            <dt>PID</dt>
            <dd>{mod.pid}</dd>
          </>
        )}
      </dl>

      <div className="actions">
        {/* Configure link routes to the generic per-module config form
            (hub#260). Rendered as a Link rather than a button because
            it's pure navigation — no async action attached, no
            supervisor requirement. Stays clickable even when the
            supervisor is offline so an operator on a hub-only CLI
            install can still edit config (the config endpoints are
            served by the module itself, not the supervisor). */}
        <Link className="btn" to={`/modules/${encodeURIComponent(mod.short)}/config`}>
          Configure
        </Link>
        <button type="button" disabled={!canAct} onClick={onRestart}>
          Restart
        </button>
        <button type="button" disabled={!canAct || !upgradeAvailable} onClick={onUpgrade}>
          {upgradeAvailable ? `Upgrade to v${mod.latest_version}` : "Up to date"}
        </button>
        <button type="button" className="destructive" disabled={!canAct} onClick={onUninstall}>
          Uninstall
        </button>
      </div>

      {errorMessage && <div className="error">{errorMessage}</div>}
    </li>
  );
}

interface InstallableCardProps {
  module: ModuleListing;
  supervisorAvailable: boolean;
  installing: boolean;
  errorMessage: string | undefined;
  onInstall: () => void;
}

/**
 * Card for an available-but-not-installed module. Lives in the
 * "Install a module" section and renders a name + tagline + npm
 * version + a single Install button. Distinct from the installed
 * ModuleRow because there's nothing to configure / restart / upgrade
 * yet — the affordance is exactly one action ("get me this module").
 *
 * `installing` short-circuits to a spinner-ish label even before the
 * row drops out of the visible list (which it does as soon as the
 * pendingOps tracker picks up the kick-off). Belt-and-suspenders
 * against a fast-finger double-click in the ~50ms gap before the op
 * lands in `pendingOps`.
 */
function InstallableCard({
  module: mod,
  supervisorAvailable,
  installing,
  errorMessage,
  onInstall,
}: InstallableCardProps) {
  const canInstall = supervisorAvailable && !installing;
  return (
    <li className="install-card" data-short={mod.short}>
      <div className="install-card-body">
        <h3>
          {mod.display_name} <span className="muted">({mod.short})</span>
        </h3>
        {mod.tagline ? <p className="tagline">{mod.tagline}</p> : null}
        <p className="muted install-card-meta">
          <code>{mod.package}</code>
          {mod.latest_version ? (
            <>
              {" · "}latest <code>v{mod.latest_version}</code>
            </>
          ) : null}
        </p>
      </div>
      <div className="install-card-actions">
        <button type="button" disabled={!canInstall} onClick={onInstall}>
          {installing ? "Installing…" : "Install"}
        </button>
      </div>
      {errorMessage && <div className="error">{errorMessage}</div>}
    </li>
  );
}

function statusLabel(mod: ModuleListing): string {
  if (!mod.installed) return "not installed";
  if (!mod.supervisor_status) return "not supervised";
  return mod.supervisor_status;
}

interface ChannelToggleProps {
  channel: ModuleInstallChannel;
  disabled: boolean;
  onChange: (next: ModuleInstallChannel) => void;
}

/**
 * Hub-wide install-channel toggle (hub#275). Radio group with two
 * options: Stable (`latest`) or Release candidates (`rc`). Driving
 * choice — Aaron specifically called out NOT adding per-install dropdowns
 * to keep the surface narrow. All future installs + upgrades pull from
 * the selected channel; already-installed modules don't move until the
 * operator clicks Upgrade.
 */
function ChannelToggle({ channel, disabled, onChange }: ChannelToggleProps) {
  return (
    <fieldset className="channel-toggle" data-testid="channel-toggle">
      <legend>Install channel</legend>
      <label>
        <input
          type="radio"
          name="module-install-channel"
          value="latest"
          checked={channel === "latest"}
          disabled={disabled}
          onChange={() => onChange("latest")}
        />
        Stable (<code>latest</code>)
      </label>
      <label>
        <input
          type="radio"
          name="module-install-channel"
          value="rc"
          checked={channel === "rc"}
          disabled={disabled}
          onChange={() => onChange("rc")}
        />
        Release candidates (<code>rc</code>)
      </label>
      <p className="muted">
        All future module installs and upgrades use this channel. Existing installed modules are
        unaffected — use <strong>Upgrade</strong> to pull a newer version.
      </p>
      <p className="muted">
        More hub settings (canonical URL, etc.) at <Link to="/settings">Settings</Link>.
      </p>
    </fieldset>
  );
}
