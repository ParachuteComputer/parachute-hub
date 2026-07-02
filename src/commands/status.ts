import type { Database } from "bun:sqlite";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { readHubPort } from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { type SelfProbeState, readHubInstanceFile } from "../hub-instance.ts";
import {
  HUB_UNIT_DEFAULT_PORT,
  type HubUnitDeps,
  type HubUnitState,
  type HubUnitStateResult,
  defaultHubUnitDeps,
  queryHubUnitState as queryHubUnitStateImpl,
} from "../hub-unit.ts";
import {
  type DetectInstallSourceDeps,
  detectHubInstallSource,
  detectInstallSource,
  formatInstallSourceLabel,
  isStale,
} from "../install-source.ts";
import {
  type DriveModuleOpDeps,
  type ModuleStateSnapshot,
  type ModuleStatesResult,
  NoOperatorTokenError,
  OperatorTokenExpiredError,
  fetchModuleStates as fetchModuleStatesImpl,
} from "../module-ops-client.ts";
import { canonicalPortForManifest, getSpec, shortNameForManifest } from "../service-spec.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";

export interface StatusOpts {
  manifestPath?: string;
  print?: (line: string) => void;
  configDir?: string;
  /**
   * Test seam for install-source detection. Production reads the filesystem
   * + shells out to git; tests inject stubs so each case (npm / bun-linked /
   * unknown / stale) is exercised deterministically without depending on
   * the operator's actual bun globals.
   */
  installSourceDeps?: DetectInstallSourceDeps;
  /**
   * Directory containing the running hub source. Defaults to `import.meta.dir`
   * (the directory of this file). Tests override so the hub row's install
   * source classification doesn't depend on the test runner's location.
   */
  hubSrcDir?: string;
  /**
   * Supervisor-path seams (design §6.4) — the ONLY runtime as of Phase 5b.
   * `status` reads the hub row from the PLATFORM MANAGER (`queryHubUnitState`)
   * + `/health`, and the module rows from the RUNNING supervisor (`GET
   * /api/modules` via the operator-token→Bearer path). The detached
   * pidfile/`processState` arm was retired in Phase 5b.
   *
   * Everything here is injectable so tests drive it without a real
   * launchd/systemd/socket/HTTP call. Production wires the real machinery; the
   * read paths are bounded + degrade gracefully on every failure (no manager,
   * hub down, no token, API error) so `status` never hangs or crashes.
   */
  supervisor?: {
    /** Deps for `queryHubUnitState` + the `/health` probe. */
    hubUnitDeps?: HubUnitDeps;
    /** Query the platform manager for the hub unit's run-state (§6.4 hub row). */
    queryHubUnitState?: (deps: HubUnitDeps) => HubUnitStateResult;
    /**
     * Probe whether the loopback hub answers `/health`. The liveness signal for
     * the hub row (§6.4) AND the gate for reading module states: if the hub is
     * down, skip the API read and show modules degraded. Production reuses the
     * hub-unit deps' bounded `probeHealth`.
     */
    probeHubHealth?: (port: number) => Promise<boolean>;
    /** Read the running supervisor's module states (§6.4 module rows). */
    fetchModuleStates?: (deps: DriveModuleOpDeps) => Promise<ModuleStatesResult>;
    /**
     * Unauthenticated module-liveness probe (#700). Used ONLY on the degraded
     * path where the supervisor run-state read couldn't run (no/expired/invalid
     * operator token, or any API error) but the hub itself is up: probes a
     * module's own `/health` directly on its loopback port. Treats 2xx AND 401
     * as live (mirrors the "auth-gated health = healthy" rule, #423: a module
     * that answers 401 is authenticated-but-alive, not down). Bounded; never
     * throws. Production reuses the same bounded fetch shape as the hub probe;
     * tests inject so they don't hit the network.
     */
    probeModuleHealth?: (port: number, health: string) => Promise<boolean>;
    /**
     * Open the hub DB used to validate/auto-rotate the operator token in
     * `fetchModuleStates`. Production opens `<configDir>/hub.db`; tests inject a
     * seeded db. Returns a handle the caller closes.
     */
    openDb?: (configDir: string) => Database;
    /** Loopback hub base URL override (default derives from the hub port). */
    baseUrl?: string;
    /**
     * Read the running serve process's last loopback self-probe verdict from
     * `hub-instance.json` (hub#737). Read from DISK, not over loopback — during
     * a hijack the loopback /health (and the module-ops API) reach the WRONG
     * hub, so the on-disk verdict the real serve wrote is the only trustworthy
     * source. A `hijacked` verdict overrides the hub row (which would otherwise
     * read `active` off the rogue's 200). Default {@link readHubInstanceFile}'s
     * `selfProbe`; tests inject a state (or undefined).
     */
    readInstanceState?: (configDir: string) => SelfProbeState | undefined;
  };
}

function formatRow(cells: string[], widths: number[]): string {
  return cells
    .map((c, i) => c.padEnd(widths[i] ?? 0, " "))
    .join("  ")
    .trimEnd();
}

/**
 * Canonical user-facing state vocabulary, per [parachute-patterns/patterns/
 * design-system.md §6](../parachute-patterns/patterns/design-system.md)
 * (workstream F). Replaces the pre-F two-column `PROCESS` (running/stopped)
 * + `HEALTH` (ok/down/http <code>) split with a single rollup column the
 * SPA, well-known doc, and CLI all share.
 *
 *   active   — process supervised, probe ok.
 *   pending  — supervised, needs operator action (OAuth, config) — not
 *              reached from `parachute status` today; here for completeness
 *              so the union matches what the SPA renders.
 *   inactive — operator-stopped or never started.
 *   failing  — supervised but probe failed (down / non-2xx).
 */
type StateLabel = "active" | "pending" | "inactive" | "failing";

interface StatusRow {
  service: string;
  port: string;
  version: string;
  /**
   * Canonical four-state label per design-system.md §6 — what the operator
   * reads. Derived from the pre-F (PROCESS, HEALTH) tuple at the emit-time
   * site so the wider supervisor pipeline doesn't have to change shape.
   */
  stateLabel: StateLabel | "-";
  pidLabel: string;
  uptimeLabel: string;
  /**
   * Pre-F probe-result detail (`ok` / `http 503` / `ECONNREFUSED` / …).
   * Kept on the row so the continuation-line context is still available
   * when a row is `failing` and the operator wants to know why. Not a
   * column; surfaced inline beneath the row only when non-trivial.
   */
  healthDetail: string;
  latencyLabel: string;
  sourceLabel: string;
  url: string | undefined;
  healthy: boolean;
  skipped: boolean;
  /**
   * Canonical-port drift warning. Set when the entry has a known canonical
   * port (first-party / known short) AND the actual port differs. Surfaced
   * as a continuation line under the row so operators see a silent miswire
   * (e.g. parachute-hub#195: scribe + agent both at 1944) without us
   * hard-erroring on a deliberate operator port change.
   */
  driftWarning?: string;
  /**
   * Version-drift indicator (hub#243). Set when a bun-linked service's
   * `services.json.version` lags the live `package.json` version at its
   * checkout. Surfaced as a continuation line so operators can spot a
   * stale-after-rebuild row without comparing columns by eye.
   */
  staleNote?: string;
  /**
   * Persisted last-start failure (`lastStartError`, written by the lifecycle
   * start preflight when a startCmd binary is missing). Surfaced on a
   * continuation line so a *later* `parachute status` explains why the row
   * isn't active — "failed to start: <binary> not installed" — rather than
   * just showing it inactive. Cleared on the next successful start.
   */
  startErrorNote?: string;
  /**
   * Hub-row-only manager-context note (Phase 3c, §6.4). Surfaces the platform
   * manager's view when it adds signal the STATE column can't carry:
   *   - "container runtime (managed)" on Render/Fly (no on-box manager).
   *   - "service manager reports active; /health not answering yet (starting or
   *     unhealthy)" when the unit is up but the hub isn't serving.
   *   - the manager's failed-unit detail / last-exit code.
   * Printed on a continuation line like the other notes.
   */
  managerNote?: string;
  /**
   * Set on a module row whose STATE was derived from an unauthenticated
   * `/health` probe rather than the supervisor's run-state (#700) — the
   * degraded-read fallback (no/expired operator token, or an API error) where
   * the module is genuinely serving. Tells the operator the row is live-but-
   * thin: no PID/uptime/structured run-state until they sign in. Printed on a
   * continuation line like the other notes.
   */
  probeNote?: string;
}

/**
 * Canonical reachable URL for a row. Spec-driven where possible (vault appends
 * `/mcp`, scribe is at the root, …). Unknown services fall back to bare
 * `http://127.0.0.1:<port>` plus the first declared path so third-party
 * services still get a useful pointer rather than an empty cell.
 */
function urlForEntry(entry: ServiceEntry, short: string | undefined): string | undefined {
  const spec = short ? getSpec(short) : undefined;
  const fromSpec = spec?.urlForEntry?.(entry);
  if (fromSpec) return fromSpec;
  const first = entry.paths[0]?.replace(/\/+$/, "") ?? "";
  return `http://127.0.0.1:${entry.port}${first}`;
}

/**
 * The MANIFEST-derived portion of a module row — port/version/URL/drift/source/
 * stale and the persisted `lastStartError` note. The supervisor read fills in
 * the run-state fields (STATE / PID / UPTIME) on top.
 *
 * Pure over the manifest entry + install-source deps; no process / network read.
 */
interface ManifestRowBase {
  short: string | undefined;
  url: string | undefined;
  driftWarning?: string;
  sourceLabel: string;
  staleNote?: string;
  /** The persisted `lastStartError` note (detached preflight wrote it). */
  manifestStartErrorNote?: string;
}

function manifestRowBase(
  entry: ServiceEntry,
  installSourceDeps: DetectInstallSourceDeps,
): ManifestRowBase {
  // Third-party rows (with `installDir`) live under `~/.parachute/<entry.name>/`,
  // matching what `parachute start` uses as the short. First-party rows still
  // map manifestName → short via the canonical fallback.
  const short = shortNameForManifest(entry.name) ?? (entry.installDir ? entry.name : undefined);
  const url = urlForEntry(entry, short);

  // Canonical-port drift detection (hub#195). Only fires for known first-party
  // services where we have a canonical assignment. Third-party rows have no
  // canonical to compare against. Informational — operators may have moved a
  // service off canonical deliberately.
  const canonical = canonicalPortForManifest(entry.name);
  const driftWarning =
    canonical !== undefined && canonical !== entry.port
      ? `canonical port is ${canonical}`
      : undefined;

  // Install-source detection (hub#243). One filesystem walk + maybe one
  // `git rev-parse` per row. Failures degrade silently to `unknown`.
  const detectArgs: { entryName: string; installDir?: string } = { entryName: entry.name };
  if (entry.installDir !== undefined) detectArgs.installDir = entry.installDir;
  const source = detectInstallSource(detectArgs, installSourceDeps);
  const sourceLabel = formatInstallSourceLabel(source);
  const staleNote = isStale(entry.version, source)
    ? `STALE: services.json cached ${entry.version}; live package.json ${source.livePackageVersion}`
    : undefined;

  // Persisted last-start failure (lifecycle preflight wrote a missing-dependency
  // wire onto services.json). Surface a one-line summary; the full install
  // recipe lives in services.json + the admin SPA card.
  const manifestStartErrorNote =
    entry.lastStartError !== undefined
      ? entry.lastStartError.binary !== undefined
        ? `failed to start: ${entry.lastStartError.binary} not installed — run \`parachute status\` detail or see /admin/modules for install steps`
        : `failed to start: ${entry.lastStartError.error_description.split("\n")[0]}`
      : undefined;

  return { short, url, driftWarning, sourceLabel, staleNote, manifestStartErrorNote };
}

export async function status(opts: StatusOpts = {}): Promise<number> {
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const print = opts.print ?? ((line) => console.log(line));
  const configDir = opts.configDir ?? CONFIG_DIR;
  const installSourceDeps = opts.installSourceDeps ?? {};
  const hubSrcDir = opts.hubSrcDir ?? import.meta.dir;

  const manifest = readManifest(manifestPath);

  // Supervised path only (Phase 5b — the detached pidfile arm is retired). Read
  // the hub row from the platform manager + `/health` and the module rows from
  // the RUNNING supervisor (§6.4). The hub row is meaningful even with zero
  // modules installed (the hub runs under a unit), so a "no modules" table is
  // rendered rather than the old "No services installed yet." early return.
  const sup = resolveStatusSupervisor(opts.supervisor);
  const rows = await buildSupervisorRows({
    manifest,
    configDir,
    installSourceDeps,
    hubSrcDir,
    sup,
  });
  renderRows(rows, print);
  // A row is `healthy: false` + `!skipped` only when the supervisor (or the
  // hub-row manager/health composition) says so (crashed / failing). A
  // stopped/inactive row is expected (skipped, exit 0); a `failing` one exits 1.
  const anyUnhealthy = rows.some((r) => !r.skipped && !r.healthy);
  return anyUnhealthy ? 1 : 0;
}

/**
 * Render the status table + continuation lines. Shared by the detached arm and
 * the Phase 3c supervisor arm so the table shape (design-system.md §6 columns +
 * the `→`/`!` continuation prefixes) is identical regardless of where each
 * row's run-state was sourced. Pure over `rows` + the `print` sink.
 */
function renderRows(rows: StatusRow[], print: (line: string) => void): void {
  // Header per design-system.md §6 "CLI status column shape":
  //   SERVICE  PORT  VERSION  STATE   PID  UPTIME  LATENCY  SOURCE
  // Pre-F shape was SERVICE PORT VERSION PROCESS PID UPTIME HEALTH LATENCY
  // SOURCE — workstream F collapses PROCESS + HEALTH into a single STATE
  // column (both encoded the same rollup in two slots). LATENCY stays as
  // a separate measurement column.
  const header = ["SERVICE", "PORT", "VERSION", "STATE", "PID", "UPTIME", "LATENCY", "SOURCE"];
  const textRows = rows.map((r) => [
    r.service,
    r.port,
    r.version,
    r.stateLabel,
    r.pidLabel,
    r.uptimeLabel,
    r.latencyLabel,
    r.sourceLabel,
  ]);
  const widths = header.map((_, i) =>
    Math.max(header[i]?.length ?? 0, ...textRows.map((r) => r[i]?.length ?? 0)),
  );
  print(formatRow(header, widths));
  // URL, drift, stale, and probe-failure detail stay on continuation lines
  // rather than columns. URLs are long (vault's MCP path runs ~40 chars);
  // SOURCE labels can be long for bun-linked rows. Spreading them across
  // columns would push the table well past 80 cols on every install —
  // continuation lines keep the table scannable. The "  → " / "  ! "
  // prefixes group visually with the row above without misleading the
  // table widths.
  //
  // When STATE collapses to `failing`, the pre-F `HEALTH` column's detail
  // (`http 503`, `ECONNREFUSED`, etc.) surfaces on a continuation line so
  // the operator can still see "what kind of failing" without the column
  // overhead. Skipped on `active` / `inactive` rows (the detail is either
  // trivial or N/A).
  for (let i = 0; i < textRows.length; i++) {
    const cells = textRows[i];
    const row = rows[i];
    if (!cells || !row) continue;
    print(formatRow(cells, widths));
    if (row.url) print(`  → ${row.url}`);
    if (row.stateLabel === "failing" && row.healthDetail !== "-" && row.healthDetail.length > 0) {
      print(`  ! probe: ${row.healthDetail}`);
    }
    if (row.managerNote) print(`  ! ${row.managerNote}`);
    if (row.probeNote) print(`  → ${row.probeNote}`);
    if (row.driftWarning) print(`  ! ${row.driftWarning}`);
    if (row.staleNote) print(`  ! ${row.staleNote}`);
    if (row.startErrorNote) print(`  ! ${row.startErrorNote}`);
  }
}

// ---------------------------------------------------------------------------
// Supervisor-path status (design §6.4) — the ONLY runtime as of Phase 5b.
//
// `status` reads the hub row from the PLATFORM MANAGER (`queryHubUnitState`) +
// a `/health` probe, and the module rows from the RUNNING supervisor (`GET
// /api/modules` via the operator-token→Bearer path). Every read is bounded +
// degrades gracefully — `status` is a diagnostic and must NEVER hang or crash
// regardless of hub/manager/token state. The detached pidfile arm was retired
// in Phase 5b.
// ---------------------------------------------------------------------------

/**
 * Default unauthenticated module-liveness probe (#700). A bounded `fetch` to the
 * module's own `http://127.0.0.1:<port><health>`. Treats 2xx AND 401 as live —
 * an auth-gated `/health` that answers 401 is authenticated-but-alive, not down
 * (the "auth-gated health = healthy" rule, #423). Any other status / network
 * error / timeout → false. 1.5s timeout, mirroring hub-unit's `defaultProbeHealth`.
 */
async function defaultProbeModuleHealth(port: number, health: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${health}`, {
      signal: AbortSignal.timeout(1500),
      // Loopback-only target, but never chase a redirect off-box (defensive).
      redirect: "manual",
    });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

/** Resolved supervisor-path seams (see `StatusOpts.supervisor`). */
interface ResolvedStatusSupervisor {
  hubUnitDeps: HubUnitDeps;
  queryHubUnitState: (deps: HubUnitDeps) => HubUnitStateResult;
  probeHubHealth: (port: number) => Promise<boolean>;
  fetchModuleStates: (deps: DriveModuleOpDeps) => Promise<ModuleStatesResult>;
  probeModuleHealth: (port: number, health: string) => Promise<boolean>;
  openDb: (configDir: string) => Database;
  baseUrl: string | undefined;
  readInstanceState: (configDir: string) => SelfProbeState | undefined;
}

/**
 * Resolve the supervisor-path seams. Production passes `supervisor: {}` (or
 * omits it) and gets the real impls; tests inject the seams they want to assert.
 */
function resolveStatusSupervisor(opts: StatusOpts["supervisor"]): ResolvedStatusSupervisor {
  const hubUnitDeps = opts?.hubUnitDeps ?? defaultHubUnitDeps;
  return {
    hubUnitDeps,
    queryHubUnitState: opts?.queryHubUnitState ?? queryHubUnitStateImpl,
    probeHubHealth: opts?.probeHubHealth ?? hubUnitDeps.probeHealth,
    fetchModuleStates: opts?.fetchModuleStates ?? fetchModuleStatesImpl,
    probeModuleHealth: opts?.probeModuleHealth ?? defaultProbeModuleHealth,
    openDb: opts?.openDb ?? ((configDir) => openHubDb(hubDbPath(configDir))),
    baseUrl: opts?.baseUrl,
    readInstanceState:
      opts?.readInstanceState ?? ((configDir) => readHubInstanceFile(configDir)?.selfProbe),
  };
}

/**
 * Resolve the issuer the operator token is validated against — the hub's
 * current loopback origin. Mirrors lifecycle.ts's `resolveOperatorTokenIssuer`
 * fallback (`readHubPort ?? HUB_UNIT_DEFAULT_PORT`); both resolve to 1939 under
 * canonical-ports, so they agree with what `auth rotate-operator` minted under.
 */
function statusOperatorTokenIssuer(configDir: string): string {
  return `http://127.0.0.1:${readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT}`;
}

/**
 * Map a supervisor `ModuleState.status` to the canonical STATE rollup
 * (design-system.md §6). `running` is `active`; `crashed` is `failing`;
 * `starting` / `restarting` are `pending` (in-flight operator-visible
 * transition); `stopped` is `inactive`. An unknown/absent status (module not
 * tracked by the supervisor — never booted, skipped at boot) is `inactive`.
 */
function mapSupervisorStatus(status: string | null): {
  stateLabel: StateLabel;
  healthy: boolean;
  skipped: boolean;
} {
  switch (status) {
    case "running":
      return { stateLabel: "active", healthy: true, skipped: false };
    case "crashed":
      return { stateLabel: "failing", healthy: false, skipped: false };
    case "starting":
    case "restarting":
      // In-flight transition — supervised, mid-operation. `pending` is the
      // canonical "needs-attention transient" rollup; treat as not-a-failure
      // (skipped) so a mid-restart module doesn't flip `status` to exit 1.
      return { stateLabel: "pending", healthy: true, skipped: true };
    default:
      // stopped / null / unknown — operator-stopped or never started. The
      // `skipped: true` + `healthy: false` pairing is DELIBERATE, not a mismatch:
      //   - `healthy: false` is honest — an inactive module is genuinely not
      //     serving (so a detail renderer can style it as down, not green).
      //   - `skipped: true` keeps the exit-code check (`rows.some(r => !r.skipped
      //     && !r.healthy)` at the call site, ~:385) from counting an
      //     operator-stopped module as a FAILURE — `parachute stop vault` then
      //     `status` must still exit 0.
      // This is the same combination + exit semantics the detached arm uses for
      // its `inactive` (operator-stopped) rows.
      return { stateLabel: "inactive", healthy: false, skipped: true };
  }
}

/**
 * Format a supervisor `startError` (the structured missing-dependency /
 * started-but-unbound wire, §6.5) into the same one-line note the detached arm
 * shows from `services.json.lastStartError` (#188). Returns undefined when
 * there's no usable detail.
 */
function supervisorStartErrorNote(startError: unknown): string | undefined {
  if (!startError || typeof startError !== "object") return undefined;
  const e = startError as { binary?: unknown; error_description?: unknown };
  if (typeof e.binary === "string" && e.binary.length > 0) {
    return `failed to start: ${e.binary} not installed — see /admin/modules for install steps`;
  }
  if (typeof e.error_description === "string" && e.error_description.length > 0) {
    return `failed to start: ${e.error_description.split("\n")[0]}`;
  }
  return undefined;
}

interface BuildSupervisorRowsArgs {
  manifest: ReturnType<typeof readManifest>;
  configDir: string;
  installSourceDeps: DetectInstallSourceDeps;
  hubSrcDir: string;
  sup: ResolvedStatusSupervisor;
}

/**
 * Build the full status rows on a UNIT-MANAGED box (design §6.4): module rows
 * from the running supervisor, the hub row from the platform manager + /health.
 * Never throws — every read is wrapped + degrades to a sensible readout.
 */
async function buildSupervisorRows(args: BuildSupervisorRowsArgs): Promise<StatusRow[]> {
  const { manifest, configDir, installSourceDeps, hubSrcDir, sup } = args;
  const port = readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT;

  // Probe the hub once: it's both the hub row's liveness signal AND the gate for
  // whether the supervisor (module states) is reachable. Bounded; never throws.
  let hubHealthy = false;
  try {
    hubHealthy = await sup.probeHubHealth(port);
  } catch {
    hubHealthy = false;
  }

  // Read the running supervisor's module states — ONLY when the hub answers
  // (children die with the hub, so a down hub means every module is down; no
  // point calling, and the call would just connection-refuse). Degrade on every
  // failure path: no token, expired token, HTTP error, anything — `status`
  // shows what it can rather than crashing.
  let states: ModuleStatesResult | undefined;
  let moduleReadNote: string | undefined;
  if (hubHealthy) {
    const db = sup.openDb(configDir);
    try {
      states = await sup.fetchModuleStates({
        db,
        issuer: statusOperatorTokenIssuer(configDir),
        configDir,
        ...(sup.baseUrl !== undefined ? { baseUrl: sup.baseUrl } : {}),
      });
    } catch (err) {
      if (err instanceof NoOperatorTokenError) {
        // No operator token AND none can be minted yet — on a fresh box the
        // first admin doesn't exist, so `rotate-operator` would itself hard-error
        // ("no hub users yet"). Point at `set-password` (create the first admin),
        // the actual unblocking step. We still can't read run-state, but the hub
        // is up — degrade gracefully (§6.4), do NOT 401-crash status (#700).
        moduleReadNote =
          "couldn't read live module state — run `parachute auth set-password` to create the first admin (then `parachute auth rotate-operator`)";
      } else if (err instanceof OperatorTokenExpiredError) {
        // Token exists but is stale: an admin already exists, so re-minting works.
        // Keep the rotate-operator guidance.
        moduleReadNote =
          "couldn't read live module state — run `parachute auth rotate-operator` to mint an operator token";
      } else {
        // HTTP error / parse / anything else — degrade with the message.
        moduleReadNote = `couldn't read live module state (${
          err instanceof Error ? err.message : String(err)
        })`;
      }
    } finally {
      db.close();
    }
  }

  const stateByShort = new Map<string, ModuleStateSnapshot>();
  for (const m of states?.modules ?? []) {
    if (m.short) stateByShort.set(m.short, m);
  }
  // Fall back to the full `supervised` snapshot for modules the curated
  // `modules` catalog omits — e.g. the `surface` UI host, which the supervisor
  // runs but isn't a curated installable. Without this it'd map to `inactive`
  // despite running (hub#539). Curated entries already in the map win (richer).
  for (const m of states?.supervised ?? []) {
    if (m.short && !stateByShort.has(m.short)) stateByShort.set(m.short, m);
  }

  // Unauthenticated-liveness fallback (#700). On the degraded path — the hub is
  // up but we couldn't read supervisor run-state (no/expired operator token, or
  // an API error) — probe each module's own `/health` directly so a module that
  // is genuinely serving reads LIVE instead of being mapped null→`inactive`
  // (which falsely told fresh-box operators a working install was broken). Keyed
  // by the unique `entry.name`; probed concurrently, bounded, never throws.
  const probeAlive = new Map<string, boolean>();
  if (hubHealthy && !states) {
    await Promise.all(
      manifest.services.map(async (entry) => {
        try {
          const alive = await sup.probeModuleHealth(entry.port, entry.health);
          if (alive) probeAlive.set(entry.name, true);
        } catch {
          // Probe must never crash status — absent from the map = treated as down.
        }
      }),
    );
  }

  const rows: StatusRow[] = manifest.services.map((entry) => {
    const base = manifestRowBase(entry, installSourceDeps);
    const snap = base.short ? stateByShort.get(base.short) : undefined;

    if (!hubHealthy) {
      // Hub is down → every supervised module is down with it. Show `inactive`
      // (expected, not a failure) with a note rather than a probe failure.
      return {
        service: entry.name,
        port: String(entry.port),
        version: entry.version,
        stateLabel: "inactive",
        pidLabel: "-",
        uptimeLabel: "-",
        healthDetail: "-",
        latencyLabel: "-",
        sourceLabel: base.sourceLabel,
        url: base.url,
        healthy: false,
        skipped: true,
        ...(base.driftWarning ? { driftWarning: base.driftWarning } : {}),
        ...(base.staleNote ? { staleNote: base.staleNote } : {}),
        managerNote: "hub is down — its modules are stopped",
      };
    }

    // Degraded read, but the module answered an unauthenticated `/health` probe
    // (#700): show it LIVE instead of null→`inactive`. We can't surface PID/
    // uptime/structured run-state (those need the operator token), so keep the
    // degraded `moduleReadNote` AND add a probe-derived continuation note so the
    // operator understands the row is from a liveness probe, not full supervisor
    // state. `skipped: true` keeps a working install at exit 0.
    if (!snap && probeAlive.get(entry.name)) {
      const row: StatusRow = {
        service: entry.name,
        port: String(entry.port),
        version: entry.version,
        stateLabel: "active",
        pidLabel: "-",
        uptimeLabel: "-",
        healthDetail: "-",
        latencyLabel: "-",
        sourceLabel: base.sourceLabel,
        url: base.url,
        healthy: true,
        skipped: true,
      };
      row.probeNote = "live via unauthenticated health probe — sign in for full supervisor state";
      if (base.driftWarning) row.driftWarning = base.driftWarning;
      if (base.staleNote) row.staleNote = base.staleNote;
      if (base.manifestStartErrorNote) row.startErrorNote = base.manifestStartErrorNote;
      // Surface the degraded-read note ONCE (first module row), same as below.
      if (moduleReadNote) {
        row.managerNote = moduleReadNote;
        moduleReadNote = undefined;
      }
      return row;
    }

    const { stateLabel, healthy, skipped } = mapSupervisorStatus(snap?.supervisor_status ?? null);
    // Prefer the supervisor's structured start-error (live), else the persisted
    // services.json note — same friendly surface either way (#188).
    const startErrorNote =
      supervisorStartErrorNote(snap?.supervisor_start_error) ?? base.manifestStartErrorNote;
    const healthDetail =
      stateLabel === "failing" ? `supervisor: ${snap?.supervisor_status ?? "crashed"}` : "-";

    const row: StatusRow = {
      service: entry.name,
      port: String(entry.port),
      version: entry.version,
      stateLabel,
      pidLabel: snap?.pid !== undefined && snap?.pid !== null ? String(snap.pid) : "-",
      uptimeLabel: "-",
      healthDetail,
      latencyLabel: "-",
      sourceLabel: base.sourceLabel,
      url: base.url,
      healthy,
      skipped,
    };
    if (base.driftWarning) row.driftWarning = base.driftWarning;
    if (base.staleNote) row.staleNote = base.staleNote;
    if (startErrorNote) row.startErrorNote = startErrorNote;
    // Surface the degraded-read note ONCE — on the first module row so the
    // operator sees why run-state is missing, without repeating it on every row.
    if (moduleReadNote) {
      row.managerNote = moduleReadNote;
      moduleReadNote = undefined;
    }
    return row;
  });

  const hub = buildSupervisorHubRow({
    configDir,
    hubSrcDir,
    installSourceDeps,
    sup,
    port,
    hubHealthy,
  });
  // Loopback-hijack override (hub#737). During a hijack the loopback `/health`
  // the hub row's liveness probe hit belongs to the ROGUE hub (a 200 → the row
  // reads `active`), so trust the running serve's own on-disk self-probe verdict
  // instead — read from disk, never over the hijacked loopback. A `hijacked`
  // verdict flips the row to `failing` with the loud, actionable note.
  //
  // GATED ON `hubHealthy` (review fix): the instance file is written per-boot
  // and only cleared on a *graceful* stop, so a hard-killed hub can leave a
  // stale `hijacked` verdict on disk. `hubHealthy` is true exactly when
  // SOMETHING is answering the loopback port right now — which is precisely the
  // live-hijack condition (the rogue keeps answering 200), so gating here never
  // suppresses a real hijack, but it does keep a stopped hub (nothing answering)
  // from rendering a phantom hijack over its normal down-hub row.
  let selfProbe: SelfProbeState | undefined;
  try {
    selfProbe = sup.readInstanceState(configDir);
  } catch {
    selfProbe = undefined;
  }
  if (hubHealthy && selfProbe?.status === "hijacked") {
    hub.stateLabel = "failing";
    hub.healthy = false;
    hub.skipped = false;
    hub.healthDetail = "loopback hijacked — /health answered by a foreign process";
    hub.managerNote = `LOOPBACK HIJACK on :${port} — module JWKS/API calls are NOT reaching this hub. Run \`parachute doctor\` and \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`.`;
  }
  // If the degraded-read note never landed on a module row (empty manifest),
  // surface it on the hub row so the operator still sees the actionable hint —
  // unless the hijack note already claimed it (the hijack is the bigger signal).
  if (moduleReadNote && !hub.managerNote) hub.managerNote = moduleReadNote;
  rows.push(hub);
  return rows;
}

interface BuildSupervisorHubRowArgs {
  configDir: string;
  hubSrcDir: string;
  installSourceDeps: DetectInstallSourceDeps;
  sup: ResolvedStatusSupervisor;
  port: number;
  hubHealthy: boolean;
}

/**
 * Build the hub row from the platform manager + /health (design §6.4). The
 * manager's `queryHubUnitState` is the run-state; `/health` is the liveness
 * signal. Composition:
 *   - manager `active` + /health OK → `active` (running).
 *   - manager `active` + /health down → `failing` with a "starting/unhealthy"
 *     note (the unit is up but not serving yet).
 *   - manager `failed` → `failing` (surface the last-exit code).
 *   - manager `inactive` → `inactive`.
 *   - no on-box manager (container/Render/Fly) → lean on /health for liveness;
 *     report "container runtime (managed)".
 * Never throws — a manager-query failure degrades to the /health verdict.
 */
function buildSupervisorHubRow(args: BuildSupervisorHubRowArgs): StatusRow {
  const { configDir, hubSrcDir, installSourceDeps, sup, port, hubHealthy } = args;
  const source = detectHubInstallSource(hubSrcDir, installSourceDeps);
  const base: Omit<StatusRow, "stateLabel" | "pidLabel" | "uptimeLabel" | "healthy" | "skipped"> & {
    healthDetail: string;
  } = {
    service: "parachute-hub (internal)",
    port: String(port),
    version: source.livePackageVersion ?? "-",
    healthDetail: "-",
    latencyLabel: "-",
    sourceLabel: formatInstallSourceLabel(source),
    url: `http://127.0.0.1:${port}`,
  };

  let managerState: HubUnitState;
  let lastExitCode: number | undefined;
  try {
    const q = sup.queryHubUnitState(sup.hubUnitDeps);
    managerState = q.state;
    lastExitCode = q.lastExitCode;
  } catch {
    // The manager query must never crash status — fall back to /health only.
    managerState = "unknown";
  }

  // No on-box manager (container / Render / Fly): there's nothing to query —
  // `/health` is the sole liveness signal. Report the managed-runtime nuance.
  if (managerState === "no-manager") {
    return {
      ...base,
      stateLabel: hubHealthy ? "active" : "failing",
      pidLabel: "-",
      uptimeLabel: "-",
      healthDetail: hubHealthy ? "-" : "down",
      healthy: hubHealthy,
      skipped: hubHealthy,
      managerNote: "container runtime (managed)",
    };
  }

  // Manager says failed: surface it as `failing` with the last-exit code even if
  // a respawn happens to be answering /health right now.
  if (managerState === "failed") {
    return {
      ...base,
      stateLabel: "failing",
      pidLabel: "-",
      uptimeLabel: "-",
      healthDetail: hubHealthy ? "service manager reports failed" : "down",
      healthy: false,
      skipped: false,
      managerNote:
        lastExitCode !== undefined
          ? `service manager reports the hub unit failed (last exit code ${lastExitCode})`
          : "service manager reports the hub unit failed",
    };
  }

  // Manager says active.
  if (managerState === "active") {
    if (hubHealthy) {
      return {
        ...base,
        stateLabel: "active",
        pidLabel: "-",
        uptimeLabel: "-",
        healthy: true,
        skipped: true,
      };
    }
    // Active per the manager but not answering /health: starting up or wedged.
    return {
      ...base,
      stateLabel: "failing",
      pidLabel: "-",
      uptimeLabel: "-",
      healthDetail: "manager active, /health not answering",
      healthy: false,
      skipped: false,
      managerNote:
        "service manager reports active; /health not answering yet (starting or unhealthy)",
    };
  }

  // Manager says activating: transient bring-up. If /health already answers,
  // call it active; else show it as pending (in-flight).
  if (managerState === "activating") {
    return {
      ...base,
      stateLabel: hubHealthy ? "active" : "pending",
      pidLabel: "-",
      uptimeLabel: "-",
      healthy: true,
      skipped: true,
      ...(hubHealthy ? {} : { managerNote: "service manager reports the hub unit is starting" }),
    };
  }

  // Manager says inactive / unknown / no-unit (defensive — no-unit shouldn't
  // reach here under the dual-dispatch). Trust /health as the tiebreaker: if the
  // hub somehow answers, show active; else inactive.
  if (hubHealthy) {
    return {
      ...base,
      stateLabel: "active",
      pidLabel: "-",
      uptimeLabel: "-",
      healthy: true,
      skipped: true,
    };
  }
  return {
    ...base,
    stateLabel: "inactive",
    pidLabel: "-",
    uptimeLabel: "-",
    healthy: false,
    skipped: true,
    ...(managerState === "unknown" ? { managerNote: "service manager state unknown" } : {}),
  };
}
