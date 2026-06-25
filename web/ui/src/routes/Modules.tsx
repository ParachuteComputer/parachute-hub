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
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HubUpgradeCard } from "../components/HubUpgradeCard.tsx";
import { renderOperationError } from "../components/MissingDependencyCard.tsx";
import {
  type ModuleInstallChannel,
  type ModuleListing,
  type ModuleOperation,
  type ModuleUiSubUnit,
  type ModulesCatalog,
  getModuleOperation,
  installModule,
  listModules,
  restartModule,
  setModuleChannel,
  uninstallModule,
  upgradeModule,
} from "../lib/api.ts";
import { type UnifiedState, unifiedStateForSupervisor, unifiedStateForUi } from "../lib/state.ts";

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
  /** Structured error detail (missing_dependency) — drives the install card. */
  errorDetail?: ModuleOperation["error_detail"];
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
                  ? {
                      ...q,
                      log: op.log,
                      status: op.status,
                      error: op.error,
                      errorDetail: op.error_detail,
                    }
                  : q,
              ),
            );
            if (op.status === "succeeded" || op.status === "failed") {
              // A missing-dependency failure carries an install card the
              // operator needs time to read + copy — keep it pinned (they
              // dismiss it by acting + re-installing). Everything else drops
              // after a beat so the final log line is visible, then refresh.
              const pinned =
                op.status === "failed" && op.error_detail?.error_type === "missing_dependency";
              if (!pinned) {
                setTimeout(() => {
                  setPendingOps((prev) => prev.filter((q) => q.operationId !== op.id));
                  void refreshCatalog();
                }, 1500);
              } else {
                void refreshCatalog();
              }
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
  // go on top (operator's running set); modules that are OFFERED for a fresh
  // install (`available_to_install` — installable AND not deprecated) and
  // `!installed` go below as the install catalog. A `deprecated` module
  // (notes-daemon / runner) that ISN'T installed is excluded here so it isn't
  // pushed on a fresh box; if it IS installed it still appears in the Installed
  // section (its own deprecated group) for management/uninstall (2026-06-25).
  const installedModules = modules.filter((m) => m.installed);
  const installableModules = modules.filter((m) => !m.installed && m.available_to_install);

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

      {/*
        Upgrade-hub affordance (design 2026-06-01 §5.3 / D4). The hub is NOT a
        supervised module — it's the host — so it isn't a row in the lists
        below; it sits at the top as its own card. This is the no-shell
        (Render/Fly) operator's path to upgrade the hub itself. Unlike module
        upgrades, it does NOT require a supervisor (the hub upgrades itself via
        a detached helper), so it renders regardless of `supervisor_available`.
      */}
      <HubUpgradeCard />

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
                {/* Structured missing-dependency failures render a dedicated
                    install card; other errors fall back to the plain string. */}
                {p.status === "failed" && (p.errorDetail || p.error) ? (
                  <div className="depcard-wrap">
                    {renderOperationError({ error: p.error, errorDetail: p.errorDetail })}
                  </div>
                ) : null}
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
          renderFocusGroups(
            installedModules,
            (group) => (
              <ul className="module-list">
                {group.map((mod) => (
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
            ),
            "installed",
          )
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
          renderFocusGroups(
            visibleInstallable,
            (group) => (
              <ul className="install-list">
                {group.map((mod) => (
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
            ),
            "installable",
          )
        )}
      </section>
    </section>
  );
}

/**
 * Split a module list into the `core` group, then the `experimental` group,
 * then the `deprecated` group (2026-06-25), rendering each via `renderList`.
 * The experimental + deprecated groups get a subtle subheading + a
 * de-emphasizing wrapper class — grouped + visually backgrounded, NEVER hidden
 * (2026-06-09 modular-UI architecture: show all installed; focus only sorts +
 * de-emphasizes). The server already sorts core → experimental → deprecated,
 * so we just partition.
 *
 * The deprecated group is reached only from the **Installed** section in
 * practice — `available_to_install` keeps deprecated modules out of the
 * installable catalog (the install list is pre-filtered), so an operator only
 * sees the Deprecated group when they already have notes-daemon / runner on
 * disk and need to manage / uninstall it.
 *
 * `keyPrefix` namespaces the per-group `data-testid` so the installed and
 * installable sections don't collide (`installed-experimental-group`,
 * `installable-experimental-group`, `installed-deprecated-group`).
 */
function renderFocusGroups(
  modules: ModuleListing[],
  renderList: (group: ModuleListing[]) => ReactElement,
  keyPrefix: string,
): ReactElement {
  const core = modules.filter((m) => m.focus === "core");
  const experimental = modules.filter((m) => m.focus === "experimental");
  const deprecated = modules.filter((m) => m.focus === "deprecated");
  return (
    <>
      {core.length > 0 && <div data-testid={`${keyPrefix}-core-group`}>{renderList(core)}</div>}
      {experimental.length > 0 && (
        <div className="modules-experimental" data-testid={`${keyPrefix}-experimental-group`}>
          <h3 className="muted experimental-heading">
            Experimental{" "}
            <span className="muted">— exploration modules; not part of the core surface</span>
          </h3>
          {renderList(experimental)}
        </div>
      )}
      {deprecated.length > 0 && (
        <div className="modules-deprecated" data-testid={`${keyPrefix}-deprecated-group`}>
          <h3 className="muted deprecated-heading">
            Deprecated{" "}
            <span className="muted">
              — retained for existing installs; not offered for new setups
            </span>
          </h3>
          {renderList(deprecated)}
        </div>
      )}
    </>
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
 * Open / Restart / Upgrade / Uninstall affordances.
 *
 * Two surface affordances, both module-owned (hub frames, never hosts):
 *   - **Open** (hub#342) → the module's `managementUrl` — its primary
 *     user/admin surface.
 *   - **Configure** (2026-06-09 modular-UI architecture, P3) → the module's
 *     `configUiUrl` — its own config/admin UI. Rendered consistently for
 *     every module that declares one; omitted (no dead button) otherwise.
 *
 * The old hub-hosted generic config form at `/admin/modules/<short>/config`
 * (+ the `/api/modules/:short/config{,/schema}` proxy endpoints) is RETIRED
 * as of P3: config is module-owned + hub-framed, never a bespoke React view
 * in the hub SPA. Each module ships its own UI handling both viewing AND
 * configuring; the hub is the dispatcher.
 *
 * Modules without a declared `management_url` get a disabled Open button
 * with a tooltip — pointing at Configure when the module declares
 * `configUiUrl` (runner's shape today), or a generic "no admin UI yet"
 * otherwise. Gentler than 404-on-click. (The old per-module follow-up map —
 * scribe#53 / runner#8 — retired in boundary D2: scribe ships `/scribe/admin`
 * and runner ships `/runner/admin`.)
 *
 * The "install" action lives on `InstallableCard` instead; this row is
 * only rendered for `installed: true` modules.
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
  const openUrl = mod.management_url;
  // Configure → the module's OWN config UI (2026-06-09 modular-UI architecture,
  // P3). Rendered only when the module declares `configUiUrl`; the module owns
  // the surface, hub just frames it. Full-page nav (leaving the SPA), same
  // shape as Open. No hub-hosted generic config form anymore.
  const configUrl = mod.config_ui_url;

  return (
    <li className="module-row" data-short={mod.short}>
      <header>
        <h2>
          {mod.display_name} <span className="muted">({mod.short})</span>
        </h2>
        {/*
          Status badge uses the four-state vocabulary from
          design-system.md §6 (workstream F): active / pending / inactive /
          failing. `statusBadge` maps the supervisor's lifecycle status
          (`starting | running | stopped | crashed | restarting`) onto the
          user-facing rollup at render time — the wire shape on
          /api/modules is intentionally unchanged.
        */}
        {(() => {
          const badge = statusBadge(mod);
          return (
            <span
              className={`status status-${badge.cssState}`}
              data-state={badge.cssState}
              data-testid={`module-status-${mod.short}`}
            >
              {badge.label}
            </span>
          );
        })()}
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

      {/*
        Hierarchical sub-units (hub#313). Rendered only when the module's
        services.json row declares a non-empty `uis` map — most modules
        today have none and this block is omitted entirely. parachute-app
        is the first consumer: the App module surfaces each hosted UI
        (Gitcoin Brain, Unforced Brain, ...) as its own discoverable
        sub-row. See parachute-app design doc §12.
      */}
      {mod.uis.length > 0 && <UiSubUnitsList uis={mod.uis} />}

      <div className="actions">
        {/* Open → the module's own UI (hub#342). Full-page navigation
            via <a href> rather than react-router Link because we're
            leaving the SPA — the module owns its surface. Disabled
            state for modules without a declared management_url
            telegraphs "this module hasn't shipped its UI yet" via
            tooltip rather than 404-ing the operator. */}
        {openUrl ? (
          <a className="btn" href={openUrl} data-testid={`open-${mod.short}`}>
            Open
          </a>
        ) : (
          <button
            type="button"
            className="btn"
            disabled
            title={
              configUrl
                ? "No separate Open surface — use Configure for this module's admin UI."
                : "This module hasn't shipped an admin UI yet."
            }
            data-testid={`open-${mod.short}`}
          >
            Open
          </button>
        )}
        {/* Configure → the module's own config UI (2026-06-09 modular-UI
            architecture, P3). Consistent affordance across every module that
            declares `configUiUrl`; full-page nav since the module owns the
            surface. Omitted entirely when a module declares no config UI —
            no dead button, no hub-hosted generic form. */}
        {configUrl ? (
          <a className="btn" href={configUrl} data-testid={`configure-${mod.short}`}>
            Configure
          </a>
        ) : null}
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

/**
 * Resolved status badge for a module row. `cssState` is the unified
 * `status-<state>` class (design-system.md §6); `label` is what the
 * operator reads. Pre-F the badge text was the raw supervisor status
 * (`running` / `stopped` / `crashed`); workstream F switches to the
 * four-state rollup so the SPA, CLI, and well-known doc all read the same
 * vocabulary. For not-installed / not-supervised rows we keep the
 * descriptive copy because those rows aren't supervisor lifecycle states
 * — they're "the supervisor has nothing to say about this row."
 */
interface ModuleStatusBadge {
  cssState: UnifiedState | "absent";
  label: string;
}

function statusBadge(mod: ModuleListing): ModuleStatusBadge {
  if (!mod.installed) return { cssState: "absent", label: "not installed" };
  if (!mod.supervisor_status) return { cssState: "absent", label: "not supervised" };
  const cssState = unifiedStateForSupervisor(mod.supervisor_status);
  return { cssState, label: cssState };
}

interface UiSubUnitsListProps {
  uis: ModuleUiSubUnit[];
}

/**
 * Hierarchical sub-units rendered under a module row (hub#313). The shape
 * mirrors parachute-app's per-UI registry: each entry surfaces an icon,
 * display name, mount path, and lifecycle status. Status badges follow
 * the same `status-<state>` class convention `ModuleRow` uses for the
 * supervisor badge — the four canonical states from design-system.md §6
 * (`active`, `pending`, `inactive`, `failing`) cover both surfaces from
 * one palette.
 *
 * `path` is rendered as a same-origin anchor so an operator clicking
 * "Gitcoin Brain" lands on `/app/gitcoin-brain` — not a SPA link
 * (`Link to`) because the sub-unit lives outside the SPA's mount basename
 * and we want the browser to hard-navigate. Aaron's call: keep the SPA
 * itself narrow, let the underlying module own its own UI shell.
 *
 * Status badges use the unified four-state vocabulary from
 * design-system.md §6 (workstream F): `status-active`, `status-pending`,
 * `status-inactive`, `status-failing`. Sub-units that publish the legacy
 * `pending-oauth` / `disabled` values pre-F get normalized at render time
 * via `unifiedStateForUi` so the badge palette stays consistent across
 * old + new sub-units during the alias window.
 */
function UiSubUnitsList({ uis }: UiSubUnitsListProps) {
  return (
    <details className="module-uis" data-testid="module-uis" open>
      <summary>
        Hosted UIs <span className="muted">({uis.length})</span>
      </summary>
      <ul className="ui-sub-units">
        {uis.map((u) => {
          const cssState = unifiedStateForUi(u.status);
          return (
            <li key={u.name} className="ui-sub-unit" data-name={u.name}>
              {u.icon_url && (
                <img
                  src={u.icon_url}
                  alt=""
                  className="ui-icon"
                  width={20}
                  height={20}
                  loading="lazy"
                />
              )}
              <div className="ui-sub-unit-body">
                <a href={u.path} className="ui-sub-unit-link">
                  <strong>{u.display_name}</strong>
                  <span className="muted"> · {u.path}</span>
                </a>
                {u.tagline ? <p className="tagline">{u.tagline}</p> : null}
              </div>
              <span
                className={`status status-${cssState}`}
                data-state={cssState}
                data-testid={`ui-status-${u.name}`}
              >
                {cssState}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
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
