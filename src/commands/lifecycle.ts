import { existsSync } from "node:fs";
import { join } from "node:path";
import { rethrowIfMissing } from "@openparachute/depcheck";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { readExposeState } from "../expose-state.ts";
import { HUB_SVC, readHubPort } from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { deriveHubOrigin } from "../hub-origin.ts";
import {
  type EnsureHubUnitOpts,
  type EnsureHubUnitResult,
  HUB_UNIT_DEFAULT_PORT,
  type HubUnitDeps,
  type HubUnitManagerOpResult,
  defaultHubUnitDeps,
  ensureHubUnit as ensureHubUnitImpl,
  isHubUnitInstalled,
  restartHubUnit as restartHubUnitImpl,
  stopHubUnit as stopHubUnitImpl,
} from "../hub-unit.ts";
import {
  type MigrateOfferOpts,
  type MigrateOfferResult,
  offerMigrateToSupervised,
} from "../migrate-offer.ts";
import {
  type DriveModuleOpDeps,
  type ModuleOp,
  ModuleOpHttpError,
  type ModuleOpResult,
  NoOperatorTokenError,
  OperatorTokenExpiredError,
  driveModuleOp as driveModuleOpImpl,
} from "../module-ops-client.ts";
import { type PortListeningFn, defaultPortListening } from "../port-probe.ts";
import { type AliveFn, logPath as logPathFor, processState } from "../process-state.ts";
import { getSpec, knownServices } from "../service-spec.ts";
import { readManifest } from "../services-manifest.ts";

/**
 * Tiny seam over `Bun.spawn`, retained for the `parachute logs <svc> --follow`
 * tail (`LogsOpts.tailSpawner`). The detached MODULE spawner (`defaultSpawner`)
 * was retired in Phase 5b — modules are spawned by the supervisor under `serve`,
 * not by a detached pidfile daemon. `logs` is the last consumer of this seam, and
 * its tail only needs `cmd` (the `opts` is unused there but kept on the interface
 * for a future caller).
 */
export interface SpawnerOptions {
  env?: Record<string, string>;
  cwd?: string;
}

export interface Spawner {
  spawn(cmd: readonly string[], logFile: string, opts?: SpawnerOptions): number;
}

export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;
export type SleepFn = (ms: number) => Promise<void>;

/**
 * Port-readiness probe seam + its production impl now live in `port-probe.ts`
 * (design 2026-06-01 §6.5) so the supervisor can share the exact same TCP
 * connect-probe without dragging lifecycle's heavy import graph. Re-exported
 * here so this module's public API (and its tests) are unchanged. Pairs with
 * the spawn-then-die settle (hub#194) to catch the alive-but-never-bound shape
 * (hub#487): a service that clears the liveness check but never binds its port
 * because it's already held — `alive(pid)` says "running" while `status` shows
 * it inactive because nothing answers on the port.
 */
export { type PortListeningFn, defaultPortListening };

/**
 * Group-aware liveness: returns true if the process group (pgid == pid)
 * still has any member. The detached module spawner that created these process
 * groups is retired (Phase 5b — the supervisor under `serve` owns module
 * spawning now, with its own group-spawn + `defaultKillGroup` in `supervisor.ts`),
 * but this stays as the liveness primitive for `parachute logs`'s
 * "running-but-no-logfile" diagnostic over any pidfile still on disk (the readers
 * §7.5 keeps for one release).
 *
 * Falls back to a single-pid check when no group with that pgid exists:
 * `kill(-pid, 0)` returns ESRCH, and we still honor the bare-pid alive signal.
 */
export const defaultAlive: AliveFn = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Sends `signal` to the entire process group rooted at `pid`. Reaches a wrapper
 * and any grandchildren in one syscall when the pid is a group leader. ESRCH on
 * the group send means the pgid is gone (the leader exited and the group emptied,
 * or a non-group pid) — fall back to a bare-pid signal so the caller's intent
 * still lands. The supervisor's `defaultKillGroup` (supervisor.ts) is the
 * production reaper now; this export survives for the group-aware test coverage
 * + any future on-box use.
 */
export const defaultKill: KillFn = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    process.kill(pid, signal);
  }
};

export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export interface LifecycleOpts {
  manifestPath?: string;
  configDir?: string;
  log?: (line: string) => void;
  /**
   * Override the hub origin used as the operator token's `iss` validator on the
   * loopback module-ops call. If unset, derived from `expose-state.json` (when
   * exposed) or the hub.port file (local dev).
   */
  hubOrigin?: string;
  /**
   * Supervisor-path seams (design §3.3) — the ONLY runtime as of Phase 5b.
   * `start/stop/restart` drive the RUNNING hub's in-process Supervisor over the
   * loopback module-ops API (per-module verbs) or the platform manager (hub
   * verbs / no-svc). The detached spawners are retired; a box with no hub unit
   * goes through the §7.5 auto-offer / actionable error (`migrateOffer`), never
   * a detached spawn.
   *
   * Everything here is injectable so tests can (a) force the unit-installed
   * branch without a real launchd/systemd, and (b) assert the module-ops /
   * manager calls without a live hub. Production wires the real
   * {@link driveModuleOp} / {@link ensureHubUnit} / {@link stopHubUnit} /
   * {@link restartHubUnit} against an opened hub.db + the resolved hub origin.
   *
   * `unitInstalled` is the discriminant that decides whether the box is already
   * supervised. When OMITTED entirely it defaults to `false` → the verb runs the
   * no-unit path (auto-offer / error). The production CLI dispatch passes
   * `supervisor: {}` so the real `isHubUnitInstalled` probe decides.
   */
  supervisor?: {
    /**
     * Is a hub unit installed (the dual-dispatch discriminant)? Production
     * uses `isHubUnitInstalled(hubUnitDeps)`. Tests set this `true`/`false`
     * directly to pick the branch deterministically. When set, it wins over
     * the `hubUnitDeps`-derived detection.
     */
    unitInstalled?: boolean;
    /** Deps for the real `isHubUnitInstalled` probe + the hub-unit manager ops. */
    hubUnitDeps?: HubUnitDeps;
    /** Drive a per-module op against the running hub (reads operator.token). */
    driveModuleOp?: (
      short: string,
      op: ModuleOp,
      deps: DriveModuleOpDeps,
    ) => Promise<ModuleOpResult>;
    /** Ensure the hub unit is up before a module op (§3.2). */
    ensureHubUnit?: (opts: EnsureHubUnitOpts) => Promise<EnsureHubUnitResult>;
    /** Stop the hub unit via the platform manager (NEVER a PID signal, §3.3). */
    stopHubUnit?: (deps: HubUnitDeps) => HubUnitManagerOpResult;
    /** Restart the hub unit via the platform manager (NEVER a PID signal, §3.3). */
    restartHubUnit?: (deps: HubUnitDeps) => HubUnitManagerOpResult;
    /**
     * Probe whether the loopback hub answers `/health`. Used by `stop <svc>`:
     * if the hub is down, the supervised module is already down (children die
     * with the hub) → report "already stopped" WITHOUT starting the hub.
     * Production reuses the hub-unit deps' `probeHealth`.
     */
    probeHubHealth?: (port: number) => Promise<boolean>;
    /**
     * Open the hub DB used to validate/auto-rotate the operator token in
     * `driveModuleOp`. Production opens `<configDir>/hub.db`; tests inject an
     * in-memory/seeded db. Returns a handle the caller closes.
     */
    openDb?: (configDir: string) => import("bun:sqlite").Database;
    /** Loopback hub base URL override (default derives from the hub port). */
    baseUrl?: string;
  };
  /**
   * §7.5 auto-detect-and-offer seam. When a verb takes the DETACHED arm (no hub
   * unit installed) and a prior detached install is detected, the verb offers
   * the supervised cutover (interactive) or prints the command (non-TTY) BEFORE
   * doing detached work. Injectable so tests can (a) stub the offer to assert it
   * fires / migrates / declines, and (b) DISABLE it entirely (`enabled:false`)
   * so the hundreds of existing detached-arm lifecycle tests don't trip an
   * interactive prompt. Production wires the real `offerMigrateToSupervised`.
   *
   * Default when OMITTED: disabled, so existing tests (which never opt in) stay
   * deterministic. The production CLI dispatch passes `{ enabled: true }`.
   */
  migrateOffer?: {
    /** Master switch. Default `false` when the whole block is omitted. */
    enabled?: boolean;
    /** The offer implementation (default `offerMigrateToSupervised`). */
    offer?: (opts: MigrateOfferOpts) => Promise<MigrateOfferResult>;
  };
}

interface Resolved {
  manifestPath: string;
  configDir: string;
  log: (line: string) => void;
  hubOrigin: string | undefined;
  sup: ResolvedSupervisor;
  /** §7.5 resolved auto-offer (enabled flag + the offer impl). */
  migrateOffer: {
    enabled: boolean;
    offer: (opts: MigrateOfferOpts) => Promise<MigrateOfferResult>;
  };
}

/** Resolved supervisor-path seams (see `LifecycleOpts.supervisor`). */
interface ResolvedSupervisor {
  /** Whether a hub unit is installed — the dual-dispatch discriminant. */
  unitInstalled: boolean;
  hubUnitDeps: HubUnitDeps;
  driveModuleOp: (short: string, op: ModuleOp, deps: DriveModuleOpDeps) => Promise<ModuleOpResult>;
  ensureHubUnit: (opts: EnsureHubUnitOpts) => Promise<EnsureHubUnitResult>;
  stopHubUnit: (deps: HubUnitDeps) => HubUnitManagerOpResult;
  restartHubUnit: (deps: HubUnitDeps) => HubUnitManagerOpResult;
  probeHubHealth: (port: number) => Promise<boolean>;
  openDb: (configDir: string) => import("bun:sqlite").Database;
  baseUrl: string | undefined;
}

function resolve(opts: LifecycleOpts): Resolved {
  const configDir = opts.configDir ?? CONFIG_DIR;
  return {
    manifestPath: opts.manifestPath ?? SERVICES_MANIFEST_PATH,
    configDir,
    log: opts.log ?? ((line) => console.log(line)),
    hubOrigin: resolveHubOrigin(opts.hubOrigin, configDir),
    sup: resolveSupervisor(opts.supervisor),
    migrateOffer: {
      // Default OFF when omitted so the existing supervised-arm + no-unit
      // lifecycle tests (which don't opt in) don't trip an interactive prompt.
      // The production CLI dispatch passes `{ enabled: true }`.
      enabled: opts.migrateOffer?.enabled ?? false,
      offer: opts.migrateOffer?.offer ?? offerMigrateToSupervised,
    },
  };
}

/**
 * Resolve the supervisor-path seams.
 *
 * The discriminant `unitInstalled` decides whether the box is already supervised:
 *   - When the caller PROVIDES a `supervisor` block (even `{}`, which the
 *     production CLI dispatch passes), `unitInstalled` is the explicit override
 *     if set, else the real `isHubUnitInstalled` probe over the hub-unit deps.
 *   - When the caller OMITS `supervisor` entirely, `unitInstalled` defaults to
 *     `false` → the verb runs the no-unit path (§7.5 auto-offer / actionable
 *     error). Deterministic regardless of whether the test host happens to have a
 *     real hub unit installed.
 */
function resolveSupervisor(opts: LifecycleOpts["supervisor"]): ResolvedSupervisor {
  const hubUnitDeps = opts?.hubUnitDeps ?? defaultHubUnitDeps;
  // No `supervisor` block at all → no-unit path, deterministically. Only probe
  // the real filesystem when the caller opted in (production CLI passes
  // `supervisor: {}`; tests pass the seams they want to assert).
  const unitInstalled =
    opts === undefined ? false : (opts.unitInstalled ?? isHubUnitInstalled(hubUnitDeps));
  return {
    unitInstalled,
    hubUnitDeps,
    driveModuleOp: opts?.driveModuleOp ?? driveModuleOpImpl,
    ensureHubUnit: opts?.ensureHubUnit ?? ensureHubUnitImpl,
    stopHubUnit: opts?.stopHubUnit ?? stopHubUnitImpl,
    restartHubUnit: opts?.restartHubUnit ?? restartHubUnitImpl,
    probeHubHealth: opts?.probeHubHealth ?? hubUnitDeps.probeHealth,
    openDb: opts?.openDb ?? ((configDir) => openHubDb(hubDbPath(configDir))),
    baseUrl: opts?.baseUrl,
  };
}

/**
 * §7.5 auto-detect-and-offer hook for the no-unit case of start/stop/restart.
 *
 * Called when a verb finds NO hub unit installed (Phase 5b removed the detached
 * spawners, so there is no detached arm to fall back to). When the offer is
 * enabled, it runs `offerMigrateToSupervised` (which itself checks "no unit +
 * prior detached" and prompts / prints). Returns `true` ONLY when the operator
 * accepted AND the cutover succeeded — i.e. the box is NOW supervised, so the
 * caller can dispatch through the supervisor path. Every other outcome (offer
 * disabled, no-offer, declined, printed in a non-TTY, migrate-failed) returns
 * `false` → the caller surfaces the actionable "run `parachute migrate
 * --to-supervised`" error (NOT a detached spawn — that path is gone).
 *
 * The migrate-failed case deliberately returns `false`: a failed cutover leaves
 * the box un-migrated (the cutover is fail-safe + re-runnable), so the verb
 * surfaces the error rather than dispatching into a supervisor that isn't up.
 */
async function maybeOfferAndMigrate(r: Resolved): Promise<boolean> {
  if (!r.migrateOffer.enabled) return false;
  const result = await r.migrateOffer.offer({
    configDir: r.configDir,
    manifestPath: r.manifestPath,
    log: r.log,
  });
  if (result.outcome === "migrated") {
    // The box is now supervised. Flip the resolved discriminant so the verb
    // takes the supervisor arm (the unit is freshly installed; `unitInstalled`
    // was resolved as false before the offer).
    r.sup.unitInstalled = true;
    return true;
  }
  return false;
}

/**
 * Phase 5b single-path gate (the point-of-no-return). The supervised path is the
 * ONLY runtime — the detached spawners are retired. So every per-module verb must
 * first establish that a hub unit is installed; if it isn't, there is no detached
 * fallback to take. Resolution order:
 *
 *   1. Unit installed → ready; dispatch through the supervisor.
 *   2. No unit → run the §7.5 auto-detect-and-offer. If the operator accepts the
 *      cutover and it succeeds, the box is now supervised → ready.
 *   3. Still no unit (offer disabled / no prior-detached evidence / declined /
 *      printed in a non-TTY / migrate-failed) → surface the actionable error and
 *      return NOT ready. The verb returns a non-zero exit; it NEVER spawns a
 *      detached daemon (that machinery is gone).
 *
 * The offer itself logs its own context (interactive prompt / printed command),
 * so when it fired we don't double-print the bare error. We only print the
 * actionable fallback line when no offer was surfaced (offer disabled or no
 * prior-detached evidence — a genuinely-unmigrated or clean box driven by a
 * script).
 */
async function requireSupervisedOrOffer(r: Resolved): Promise<boolean> {
  if (r.sup.unitInstalled) return true;
  const migrated = await maybeOfferAndMigrate(r);
  if (migrated) return true;
  // No unit and not migrated. If the offer was enabled it already surfaced its
  // own guidance (prompt / printed command / declined note); otherwise print the
  // actionable command so a script on a never-migrated box isn't left guessing.
  if (!r.migrateOffer.enabled) {
    r.log(
      "No supervised hub unit is installed. Run `parachute migrate --to-supervised` to install it,",
    );
    r.log("or run `parachute serve` in the foreground.");
  }
  return false;
}

/**
 * Resolve the hub origin used as the operator token's `iss` validator in the
 * supervisor path. Unlike {@link resolveHubOrigin} (which returns `undefined`
 * for pure loopback so the spawn env omits PARACHUTE_HUB_ORIGIN), the operator
 * token ALWAYS carries an `iss`, so this falls back to the canonical loopback
 * origin. Mirrors `commands/auth.ts`'s `resolveHubIssuer` so the issuer the CLI
 * validates the token against matches what `auth rotate-operator` minted under.
 * The fallback differs cosmetically — here `readHubPort(configDir) ??
 * HUB_UNIT_DEFAULT_PORT`, in auth.ts `127.0.0.1:${HUB_DEFAULT_PORT}` — but both
 * resolve to 1939 under canonical-ports today, so they agree in practice.
 * See #508: consolidate with auth.ts:resolveHubIssuer to prevent drift.
 */
function resolveOperatorTokenIssuer(hubOrigin: string | undefined, configDir: string): string {
  if (hubOrigin) return hubOrigin;
  const port = readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * Source of truth order for `PARACHUTE_HUB_ORIGIN`:
 *   1. explicit override (flag / opt)
 *   2. live exposure's hubOrigin / canonicalFqdn (what clients actually see)
 *   3. hub.port when the hub is running locally (local-dev loopback)
 *   4. undefined — don't set the env, let the service self-advertise
 */
function resolveHubOrigin(override: string | undefined, configDir: string): string | undefined {
  if (override) return deriveHubOrigin({ override });
  const state = readExposeState(join(configDir, "expose-state.json"));
  if (state?.hubOrigin) return state.hubOrigin;
  const exposeFqdn = state?.canonicalFqdn;
  return deriveHubOrigin({ exposeFqdn, hubPort: readHubPort(configDir) });
}

export async function start(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const r = resolve(opts);
  // Phase 5b single-path (design §8 Phase 5 + Appendix). The supervised path is
  // the ONLY runtime — the detached spawners are retired. A box without a hub
  // unit gets the §7.5 auto-offer / actionable error, NEVER a detached spawn.
  if (!(await requireSupervisedOrOffer(r))) return 1;
  return startViaSupervisor(svc, r);
}

export async function stop(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const r = resolve(opts);
  // Phase 5b single-path: supervised is the only runtime (see `start`).
  if (!(await requireSupervisedOrOffer(r))) return 1;
  return stopViaSupervisor(svc, r);
}

export async function restart(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const r = resolve(opts);
  // Phase 5b single-path: supervised is the only runtime. The 404-fallthrough
  // (a not-currently-supervised module → start, §6.2) lives in
  // `restartViaSupervisor`, which makes `restart <svc>` total over module state
  // just as the retired detached stop+start was.
  if (!(await requireSupervisedOrOffer(r))) return 1;
  return restartViaSupervisor(svc, r);
}

// ---------------------------------------------------------------------------
// Supervisor-path verb dispatch (design §3.3) — the ONLY runtime as of Phase 5b.
//
// `start/stop/restart` drive the RUNNING hub's in-process Supervisor over the
// loopback module-ops API (per-module verbs) or the platform manager (hub
// verbs / no-svc). The detached arm was retired in Phase 5b — a box with no hub
// unit goes through `requireSupervisedOrOffer` (§7.5 auto-offer / actionable
// error), never a detached spawn.
// ---------------------------------------------------------------------------

/**
 * Drive a single module-op against the running hub, mapping the module-ops
 * client's errors to actionable CLI output (§3.1). Opens hub.db (to validate /
 * auto-rotate the operator token), resolves the issuer the token was minted
 * under, and closes the db afterward. Returns the result on success; on a
 * surfaced error returns `undefined` so the caller can decide (e.g. the restart
 * 404-fallthrough). Re-throws nothing the caller can't handle: the operator-
 * token / HTTP errors are caught here and printed.
 */
async function driveSupervisorOp(
  short: string,
  op: ModuleOp,
  r: Resolved,
): Promise<{ result?: ModuleOpResult; httpError?: ModuleOpHttpError; failed: boolean }> {
  const issuer = resolveOperatorTokenIssuer(r.hubOrigin, r.configDir);
  const db = r.sup.openDb(r.configDir);
  try {
    const deps: DriveModuleOpDeps = {
      db,
      issuer,
      configDir: r.configDir,
      ...(r.sup.baseUrl !== undefined ? { baseUrl: r.sup.baseUrl } : {}),
    };
    const result = await r.sup.driveModuleOp(short, op, deps);
    return { result, failed: false };
  } catch (err) {
    if (err instanceof NoOperatorTokenError || err instanceof OperatorTokenExpiredError) {
      // Surface the already-actionable message (don't raw-throw a 401, §3.1).
      r.log(`✗ ${short}: ${err.message}`);
      return { failed: true };
    }
    if (err instanceof ModuleOpHttpError) {
      // Return the typed HTTP error so the caller can branch (404-fallthrough,
      // not_installed hint). Callers that don't branch print it via
      // `surfaceModuleOpHttpError`.
      return { httpError: err, failed: true };
    }
    // Unknown error — surface its message rather than crashing the CLI.
    r.log(`✗ ${short}: ${err instanceof Error ? err.message : String(err)}`);
    return { failed: true };
  } finally {
    db.close();
  }
}

/** Print a module-ops HTTP error with an actionable hint for the known codes. */
function surfaceModuleOpHttpError(short: string, err: ModuleOpHttpError, r: Resolved): void {
  if (err.status === 400 && err.code === "not_installed") {
    r.log(
      `✗ ${short} is not installed — run \`parachute install ${short}\` first, then \`parachute start ${short}\`.`,
    );
    return;
  }
  r.log(`✗ ${short}: ${err.message}`);
}

/**
 * Ensure the hub unit is up, mapping `ensureHubUnit`'s structured outcome to a
 * CLI exit signal. Returns true when the hub is up (already-up / started),
 * false when it isn't (and the messages were surfaced).
 *
 * The `no-unit` outcome shouldn't reach here: `requireSupervisedOrOffer` gates
 * every verb on `unitInstalled === true` before dispatching to the supervisor
 * path, which is the same `isHubUnitInstalled` probe `ensureHubUnit` uses to
 * decide `no-unit`. The defensive arm below still surfaces any non-up outcome's
 * messages rather than silently succeeding.
 */
async function ensureHubForOp(r: Resolved, port: number): Promise<boolean> {
  const ensured = await r.sup.ensureHubUnit({
    port,
    deps: r.sup.hubUnitDeps,
    log: r.log,
  });
  if (ensured.outcome === "already-up" || ensured.outcome === "started") return true;
  for (const m of ensured.messages) r.log(m);
  return false;
}

/** `start <svc>` / `start` (no svc) over the supervisor (§3.3). */
async function startViaSupervisor(svc: string | undefined, r: Resolved): Promise<number> {
  const port = readHubPort(r.configDir) ?? HUB_UNIT_DEFAULT_PORT;
  // `start hub` / `start` (no svc): ensure the hub unit is up — it transitively
  // boots every installed module from services.json via bootSupervisedModules.
  if (svc === HUB_SVC || svc === undefined) {
    const up = await ensureHubForOp(r, port);
    if (!up) return 1;
    r.log(svc === HUB_SVC ? "✓ hub is up." : "✓ hub is up (all installed modules booted).");
    return 0;
  }
  // `start <svc>`: ensure the hub is up first (chicken-and-egg §3.2), then drive
  // a pure supervisor.start of the already-installed module.
  if (!(await ensureHubForOp(r, port))) return 1;
  const { result, httpError, failed } = await driveSupervisorOp(svc, "start", r);
  if (httpError) {
    surfaceModuleOpHttpError(svc, httpError, r);
    return 1;
  }
  if (failed || !result) return 1;
  r.log(`✓ ${svc} started.`);
  return 0;
}

/** `stop <svc>` / `stop` (no svc) over the supervisor / platform manager (§3.3). */
async function stopViaSupervisor(svc: string | undefined, r: Resolved): Promise<number> {
  const port = readHubPort(r.configDir) ?? HUB_UNIT_DEFAULT_PORT;
  // `stop hub` / `stop` (no svc): stop the hub UNIT via the platform manager.
  // MUST go through the manager — a PID signal would be undone by launchd
  // KeepAlive / systemd Restart=always (R17). Children die with the hub.
  if (svc === HUB_SVC || svc === undefined) {
    const res = r.sup.stopHubUnit(r.sup.hubUnitDeps);
    for (const m of res.messages) r.log(m);
    if (res.outcome === "ok") {
      r.log("✓ hub stopped (all supervised modules stopped with it).");
      return 0;
    }
    return 1;
  }
  // `stop <svc>`: a supervised module dies WITH the hub. If the hub isn't
  // reachable, the module is already down — report success WITHOUT starting the
  // hub (do NOT ensureHubUnit just to stop one module). Only when the hub is up
  // do we drive the supervisor's stop.
  if (!(await r.sup.probeHubHealth(port))) {
    r.log(`✓ ${svc} already stopped (the hub isn't running, so its modules are down).`);
    return 0;
  }
  const { httpError, failed, result } = await driveSupervisorOp(svc, "stop", r);
  if (httpError) {
    surfaceModuleOpHttpError(svc, httpError, r);
    return 1;
  }
  if (failed || !result) return 1;
  r.log(`✓ ${svc} stopped.`);
  return 0;
}

/** `restart <svc>` / `restart` (no svc) over the supervisor / manager (§3.3). */
async function restartViaSupervisor(svc: string | undefined, r: Resolved): Promise<number> {
  // `restart hub` / `restart` (no svc): restart the hub UNIT via the platform
  // manager. NOT a per-module fan-out — restarting the hub re-boots all modules
  // anyway. MUST go through the manager (never a PID signal, R17).
  if (svc === HUB_SVC || svc === undefined) {
    const res = r.sup.restartHubUnit(r.sup.hubUnitDeps);
    for (const m of res.messages) r.log(m);
    if (res.outcome === "ok") {
      r.log("✓ hub restarted (all modules re-booted).");
      return 0;
    }
    return 1;
  }
  // `restart <svc>`: ensure the hub is up, then drive supervisor.restart.
  const port = readHubPort(r.configDir) ?? HUB_UNIT_DEFAULT_PORT;
  if (!(await ensureHubForOp(r, port))) return 1;
  const restartRes = await driveSupervisorOp(svc, "restart", r);
  if (restartRes.httpError) {
    // 404-fallthrough (§6.2): a module that isn't currently supervised (crashed
    // out of budget, skipped at boot, installed out-of-band) returns 404
    // `not_supervised`. `restart` must be total over module state (matching the
    // detached stop+start), so fall through to a pure `start`.
    if (restartRes.httpError.status === 404 && restartRes.httpError.code === "not_supervised") {
      const startRes = await driveSupervisorOp(svc, "start", r);
      if (startRes.httpError) {
        surfaceModuleOpHttpError(svc, startRes.httpError, r);
        return 1;
      }
      if (startRes.failed || !startRes.result) return 1;
      r.log(`✓ ${svc} started.`);
      return 0;
    }
    surfaceModuleOpHttpError(svc, restartRes.httpError, r);
    return 1;
  }
  if (restartRes.failed || !restartRes.result) return 1;
  r.log(`✓ ${svc} restarted.`);
  return 0;
}

export interface LogsOpts {
  configDir?: string;
  manifestPath?: string;
  log?: (line: string) => void;
  /** Tail stream — if omitted, uses `tail -n <lines> -f <file>` via spawn. */
  tailSpawner?: Spawner;
  /** Number of trailing lines to print (default 200). */
  lines?: number;
  follow?: boolean;
  /**
   * Liveness probe seam — tests inject deterministic pid-alive answers.
   * Defaults to the group-aware `defaultAlive` (hub#88).
   */
  alive?: AliveFn;
}

export async function logs(svc: string, opts: LogsOpts = {}): Promise<number> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const log = opts.log ?? ((line) => console.log(line));
  const lines = opts.lines ?? 200;
  const follow = opts.follow ?? false;
  const alive = opts.alive ?? defaultAlive;

  // logs only needs a valid short name to find the log file. First-party
  // wins via the spec lookup; third-party rows match by `entry.name`; the
  // internal hub is a known short outside of services.json. installDir is
  // irrelevant here — the log file is keyed by short name and exists once
  // the service has run, regardless of how it was registered. We just need
  // to confirm the name maps to something the CLI manages.
  const isFirstParty = getSpec(svc) !== undefined;
  if (!isFirstParty && svc !== HUB_SVC) {
    const entry = readManifest(manifestPath).services.find((s) => s.name === svc);
    if (!entry) {
      log(`unknown service "${svc}". known: ${[HUB_SVC, ...knownServices()].join(", ")}`);
      return 1;
    }
  }

  const path = logPathFor(svc, configDir);
  if (!existsSync(path)) {
    // Distinguish "daemon never started" from "daemon is running but the
    // log file is missing" (hub#335). The latter shape surfaces when a
    // module self-registers + spawns its own logger without going through
    // `parachute start <svc>` (no hub-managed log file), or when an
    // operator deletes the log mid-run. Previously both shapes printed the
    // same `parachute start ${svc}` hint, leading operators to think their
    // running daemon hadn't started.
    const state = processState(svc, configDir, alive);
    if (state.status === "running") {
      log(
        `${svc} is running (pid ${state.pid}) but no log file at ${path}. The daemon may be writing logs elsewhere — check its stdout/stderr or its own log destination.`,
      );
      return 0;
    }
    log(`no logs yet for ${svc}. \`parachute start ${svc}\` to begin.`);
    return 0;
  }

  if (follow) {
    const spawner = opts.tailSpawner ?? {
      spawn(cmd) {
        // Inherit env so `tail` sees PATH, etc. Bun.spawn defaults to empty
        // env — see api-modules-ops.ts:defaultRun.
        try {
          const proc = Bun.spawn([...cmd], {
            stdio: ["ignore", "inherit", "inherit"],
            env: process.env,
          });
          return proc.pid;
        } catch (err) {
          // A missing `tail` (minimal container without coreutils) surfaces
          // the friendly install UX instead of a raw spawn throw. The CLI
          // top-level catch in cli.ts renders the MissingDependencyError.
          rethrowIfMissing(err, "tail");
          throw err;
        }
      },
    };
    spawner.spawn(["tail", "-n", String(lines), "-f", path], path);
    // tail runs until user Ctrl-C; block this process until it exits.
    // When called from the real CLI, process.exit wraps us; in tests a
    // stub spawner returns immediately and we fall through.
    return 0;
  }

  // Non-follow path: read last N lines synchronously for a clean one-shot.
  const content = await Bun.file(path).text();
  const trimmed = content.replace(/\n$/, "");
  const allLines = trimmed === "" ? [] : trimmed.split("\n");
  const tail = allLines.slice(-lines);
  for (const line of tail) log(line);
  return 0;
}
