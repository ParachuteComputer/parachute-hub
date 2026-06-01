import { existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MissingDependencyError,
  ensureExecutable,
  rethrowIfMissing,
} from "@openparachute/depcheck";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { readEnvFileValues } from "../env-file.ts";
import { readExposeState } from "../expose-state.ts";
import {
  type EnsureHubOpts,
  type EnsureHubResult,
  HUB_SVC,
  type StopHubOpts,
  ensureHubRunning,
  readHubPort,
  stopHub,
} from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { HUB_ORIGIN_ENV, deriveHubOrigin } from "../hub-origin.ts";
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
import { ModuleManifestError, readModuleManifest } from "../module-manifest.ts";
import {
  type DriveModuleOpDeps,
  type ModuleOp,
  ModuleOpHttpError,
  type ModuleOpResult,
  NoOperatorTokenError,
  OperatorTokenExpiredError,
  driveModuleOp as driveModuleOpImpl,
} from "../module-ops-client.ts";
import { type OperatorIssuerHealStatus, selfHealOperatorTokenIssuer } from "../operator-token.ts";
import { type PortListeningFn, defaultPortListening } from "../port-probe.ts";
import {
  type AliveFn,
  clearPid,
  ensureLogPath,
  logPath as logPathFor,
  processState,
  readPid,
  writePid,
} from "../process-state.ts";
import {
  KNOWN_MODULES,
  type ServiceSpec,
  composeKnownModuleSpec,
  getSpec,
  getSpecFromInstallDir,
  knownServices,
  shortNameForManifest,
} from "../service-spec.ts";
import {
  type ServiceEntry,
  clearStartError,
  readManifest,
  recordStartError,
} from "../services-manifest.ts";
import { persistVaultHubOrigin, selfHealVaultHubOrigin } from "../vault-hub-origin-env.ts";

/**
 * Tiny seam over `Bun.spawn` for lifecycle tests. The real spawner opens the
 * log file, appends stdout+stderr to it, and `unref()`s the child so parent
 * exit doesn't bring it down.
 *
 * `env`, when provided, is merged into the child's environment on top of the
 * parent's — today's only caller is `start`, which injects
 * PARACHUTE_HUB_ORIGIN so vault's OAuth issuer matches the hub URL.
 *
 * `cwd`, when provided, is the child's working directory. Set to the
 * service's installDir for third-party modules so manifest-declared
 * relative startCmds (e.g. `["bun", "web/server/src/server.ts"]`) resolve
 * against the package root.
 */
export interface SpawnerOptions {
  env?: Record<string, string>;
  cwd?: string;
}

export interface Spawner {
  spawn(cmd: readonly string[], logFile: string, opts?: SpawnerOptions): number;
}

export const defaultSpawner: Spawner = {
  spawn(cmd, logFile, opts) {
    const fd = openSync(logFile, "a");
    const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
      stdio: ["ignore", fd, fd],
      // Spawn in a fresh process group (pid == pgid) so kill(-pid, sig)
      // reaches every descendant, not just the wrapper. Without this,
      // wrapped startCmds like `pnpm exec tsx server.ts` leave the tsx
      // grandchild bound to the port after stop → restart hits EADDRINUSE.
      detached: true,
      // Inherit env so child sees PATH, HOME, PARACHUTE_HOME, etc.
      // Bun.spawn defaults to empty env — see api-modules-ops.ts:defaultRun.
      // Per-call `opts.env` overrides merge on top below.
      env: process.env,
    };
    if (opts?.env) spawnOpts.env = { ...process.env, ...opts.env };
    if (opts?.cwd) spawnOpts.cwd = opts.cwd;
    const proc = Bun.spawn([...cmd], spawnOpts);
    proc.unref();
    return proc.pid;
  },
};

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
 * still has any member. Pairs with `defaultSpawner`'s `detached: true` —
 * the recorded pid is the pgid we created, so the group's existence is
 * the right "is the service still up?" signal (catches the wrapper-dead-
 * but-grandchild-listening case that causes EADDRINUSE on restart).
 *
 * Falls back to a single-pid check for legacy pidfiles written before
 * detached-spawn landed: `kill(-pid, 0)` returns ESRCH because no group
 * with that pgid exists, and we still want to honor the bare-pid alive
 * signal so a follow-up `stop` runs.
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
 * Sends `signal` to the entire process group rooted at `pid`. With
 * `defaultSpawner` putting the child in its own group, this reaches the
 * wrapper and any grandchildren in one syscall. ESRCH on the group send
 * means the pgid is gone (legacy pidfile, or the leader exited and the
 * group emptied) — fall back to a bare-pid signal so the caller's intent
 * still lands when there's a positive-pid process to receive it.
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

/**
 * Read the trailing `n` lines of a logfile, best-effort. Used to surface the
 * real boot error when a start fails — operators shouldn't have to manually
 * `tail` the log to learn *why* the daemon died. Returns [] on any read
 * error (missing file, permissions) so the caller falls back to the generic
 * "tail the log" hint without throwing.
 */
function readLogTail(logFile: string, n: number): string[] {
  try {
    const content = readFileSync(logFile, "utf8");
    const trimmed = content.replace(/\n$/, "");
    if (trimmed === "") return [];
    return trimmed.split("\n").slice(-n);
  } catch {
    return [];
  }
}

/**
 * Heuristic EADDRINUSE detector over a logfile tail. cloudflared, Bun, and
 * Node all surface port collisions with recognizable phrases; we match the
 * common ones rather than parse a structured error (there isn't one across
 * runtimes). False positives are harmless — the worst case is we *also* print
 * the port-in-use remedy on an unrelated failure, which is still actionable.
 */
function detectAddrInUse(logTail: readonly string[]): boolean {
  return logTail.some((line) => /EADDRINUSE|address already in use|port .* in use/i.test(line));
}

export interface LifecycleOpts {
  spawner?: Spawner;
  kill?: KillFn;
  alive?: AliveFn;
  sleep?: SleepFn;
  now?: () => number;
  manifestPath?: string;
  configDir?: string;
  log?: (line: string) => void;
  /** How long stop waits for SIGTERM before escalating to SIGKILL. */
  killWaitMs?: number;
  /** Poll interval while waiting for SIGTERM to land. */
  pollIntervalMs?: number;
  /**
   * How long `start` sleeps before re-checking `alive(pid)` to catch the
   * spawn-then-immediately-die failure shape (hub#194: notes-serve crashed
   * 50ms in on Bun.resolveSync, but `start` reported success because the
   * spawn returned a pid). 250ms is the default in production — long
   * enough to catch real silent-crashes (resolve failures, port
   * collisions, missing args) without making `parachute start` feel
   * laggy.
   *
   * Defaulting policy: if `alive` is not overridden, the settle defaults
   * to 0 (skipped). Stub spawners hand back fake pids that the real
   * `defaultAlive` would mark as dead, which would make every existing
   * stub-spawner test fail spuriously. Tests that want to exercise the
   * settle path inject both `alive` and `startSettleMs` explicitly.
   * Production paths use the real `defaultAlive` and get the real 250ms
   * settle.
   */
  startSettleMs?: number;
  /**
   * Probe whether the service's port is listening, post-spawn. Pairs with the
   * settle (hub#194) to catch the EADDRINUSE-orphan shape (hub#487): the
   * process survives the liveness window (vault lingers / retries) but never
   * binds because the port is already held, so `start` would otherwise report
   * "✓ started" while `status` shows it inactive. Tests inject a stub;
   * production uses `defaultPortListening` (a loopback TCP connect probe).
   */
  portListening?: PortListeningFn;
  /**
   * How long `start` polls for the service to bind its port after the
   * liveness settle passes. Default 4000ms in production — long enough to
   * cover vault/scribe cold-boot (DB open, route registration) without making
   * a healthy start feel laggy. Polled at `startReadyPollMs` intervals; the
   * first time the port answers we declare success. If the window elapses
   * with the process still alive but the port silent, we print a non-fatal
   * warning (the daemon may still be coming up) rather than failing — only a
   * *dead* process is a hard failure. Defaulting policy mirrors
   * `startSettleMs`: 0 (skipped) unless `portListening` is injected or the
   * production path (no spawner override) is active.
   */
  startReadyMs?: number;
  /** Poll interval while waiting for the port to come up. Default 200ms. */
  startReadyPollMs?: number;
  /**
   * Override the hub origin passed to services as PARACHUTE_HUB_ORIGIN. If
   * unset, `start` derives it from `expose-state.json` (when exposed) or
   * the hub.port file (local dev). Undefined → no env var is set at all,
   * and the service advertises its own default issuer.
   */
  hubOrigin?: string;
  /**
   * Hub-lifecycle seams for `parachute start|stop|restart hub`. The hub
   * doesn't go through the generic services-manifest path because its
   * start has special semantics (port-fallback probe, port-file write,
   * --issuer flag) — `lifecycle.start("hub")` dispatches to
   * `ensureHubRunning` and `lifecycle.stop("hub")` dispatches to
   * `stopHub`. Tests inject stubs to avoid spawning real bun processes.
   */
  /**
   * PATH-resolution seam for the start preflight (`@openparachute/depcheck`
   * `ensureExecutable`). Production uses the real `Bun.which`; a missing
   * startCmd binary then surfaces the friendly missing-dependency UX +
   * persists it to services.json.
   *
   * Defaulting policy mirrors `startSettleMs`: when a stub `spawner` is
   * injected (the test path) `which` defaults to a permissive resolver
   * (`() => "<stub>"`) so existing stub-spawner tests don't trip the preflight
   * against binaries that aren't on the test host's PATH (`parachute-vault`,
   * `notes-serve`). Production (no spawner override) gets the real `Bun.which`.
   * Tests that want to exercise the missing-binary branch inject `which`
   * explicitly (e.g. `which: () => null`).
   */
  which?: (cmd: string) => string | null;
  hub?: {
    ensureRunning?: (opts: EnsureHubOpts) => Promise<EnsureHubResult>;
    stop?: (opts: StopHubOpts) => Promise<boolean>;
    /**
     * Self-heal the operator token's stale `iss` after `start hub` (hub#481).
     * Production opens hub.db at `<configDir>/hub.db` and delegates to
     * `selfHealOperatorTokenIssuer`. Tests inject a stub to assert the call
     * happens — or to make it throw and prove a self-heal failure never fails
     * `start hub`.
     */
    selfHealOperatorToken?: (args: {
      issuer: string;
      configDir: string;
      log: (line: string) => void;
    }) => Promise<OperatorIssuerHealStatus>;
  };
  /**
   * Phase 3b supervisor-path seams (design §3.3). When a hub UNIT is installed
   * (launchd/systemd/container — detected via {@link isHubUnitInstalled}),
   * `start/stop/restart` drive the RUNNING hub's in-process Supervisor over the
   * loopback module-ops API instead of spawning detached pidfile daemons. The
   * detached arm (`spawner`/`hub.ensureRunning`/`hub.stop`) remains the no-unit
   * fallback until Phase 5 retires it.
   *
   * Everything here is injectable so tests can (a) force the unit-installed
   * branch without a real launchd/systemd, and (b) assert the module-ops /
   * manager calls without a live hub. Production wires the real
   * {@link driveModuleOp} / {@link ensureHubUnit} / {@link stopHubUnit} /
   * {@link restartHubUnit} against an opened hub.db + the resolved hub origin.
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
}

interface Resolved {
  spawner: Spawner;
  kill: KillFn;
  alive: AliveFn;
  sleep: SleepFn;
  now: () => number;
  manifestPath: string;
  configDir: string;
  log: (line: string) => void;
  killWaitMs: number;
  pollIntervalMs: number;
  startSettleMs: number;
  portListening: PortListeningFn;
  startReadyMs: number;
  startReadyPollMs: number;
  which: (cmd: string) => string | null;
  hubOrigin: string | undefined;
  ensureHub: (opts: EnsureHubOpts) => Promise<EnsureHubResult>;
  stopHubFn: (opts: StopHubOpts) => Promise<boolean>;
  selfHealOperatorTokenFn: (args: {
    issuer: string;
    configDir: string;
    log: (line: string) => void;
  }) => Promise<OperatorIssuerHealStatus>;
  sup: ResolvedSupervisor;
}

/** Resolved Phase 3b supervisor-path seams (see `LifecycleOpts.supervisor`). */
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

/**
 * Production self-heal: open hub.db at `<configDir>/hub.db`, run
 * `selfHealOperatorTokenIssuer`, and close the db. Derives the db path the
 * same way the rest of the repo does (`hubDbPath(configDir)`); `openHubDb`
 * runs migrations + WAL on open, matching `commands/auth.ts`. Tests override
 * this whole seam, so the db-open only happens on the production path.
 */
async function defaultSelfHealOperatorToken(args: {
  issuer: string;
  configDir: string;
  log: (line: string) => void;
}): Promise<OperatorIssuerHealStatus> {
  const db = openHubDb(hubDbPath(args.configDir));
  try {
    return await selfHealOperatorTokenIssuer(db, {
      issuer: args.issuer,
      configDir: args.configDir,
      log: args.log,
    });
  } finally {
    db.close();
  }
}

function resolve(opts: LifecycleOpts): Resolved {
  const configDir = opts.configDir ?? CONFIG_DIR;
  return {
    spawner: opts.spawner ?? defaultSpawner,
    kill: opts.kill ?? defaultKill,
    alive: opts.alive ?? defaultAlive,
    sleep: opts.sleep ?? defaultSleep,
    now: opts.now ?? Date.now,
    manifestPath: opts.manifestPath ?? SERVICES_MANIFEST_PATH,
    configDir,
    log: opts.log ?? ((line) => console.log(line)),
    killWaitMs: opts.killWaitMs ?? 10_000,
    pollIntervalMs: opts.pollIntervalMs ?? 200,
    // See `LifecycleOpts.startSettleMs` doc. Production (no spawner
    // override, no alive override) gets the 250ms settle. Tests that
    // inject a stub spawner without a stub alive get 0 — `defaultAlive`
    // against a fake pid would always report dead and break unrelated
    // tests. Tests that want to exercise the settle path explicitly
    // override `alive`, which re-enables the default 250ms.
    startSettleMs:
      opts.startSettleMs ?? (opts.spawner === undefined || opts.alive !== undefined ? 250 : 0),
    portListening: opts.portListening ?? defaultPortListening,
    // Same defaulting policy as startSettleMs: production (no spawner
    // override) gets the real 4s readiness window; tests that inject a stub
    // spawner get 0 (skipped) unless they explicitly opt in via
    // `portListening` or `startReadyMs`, so existing stub-spawner tests don't
    // start probing a fake port.
    startReadyMs:
      opts.startReadyMs ??
      (opts.spawner === undefined || opts.portListening !== undefined ? 4000 : 0),
    startReadyPollMs: opts.startReadyPollMs ?? 200,
    // Same defaulting policy as startSettleMs/startReadyMs: production (no
    // spawner override) preflights with the real Bun.which; stub-spawner tests
    // get a permissive resolver so the preflight doesn't trip against binaries
    // that aren't on the test host's PATH. Explicit `which` always wins.
    which:
      opts.which ?? (opts.spawner === undefined ? Bun.which : () => "/stub/bin/preflight-skipped"),
    hubOrigin: resolveHubOrigin(opts.hubOrigin, configDir),
    ensureHub: opts.hub?.ensureRunning ?? ensureHubRunning,
    stopHubFn: opts.hub?.stop ?? stopHub,
    selfHealOperatorTokenFn: opts.hub?.selfHealOperatorToken ?? defaultSelfHealOperatorToken,
    sup: resolveSupervisor(opts.supervisor),
  };
}

/**
 * Resolve the Phase 3b supervisor-path seams (the dual-dispatch arm).
 *
 * The discriminant `unitInstalled` decides which arm a verb takes:
 *   - When the caller PROVIDES a `supervisor` block (even `{}`, which the
 *     production CLI dispatch passes), `unitInstalled` is the explicit override
 *     if set, else the real `isHubUnitInstalled` probe over the hub-unit deps —
 *     so on a box with a launchd/systemd hub unit the verbs drive the running
 *     supervisor, and on a legacy detached box they take the detached arm.
 *   - When the caller OMITS `supervisor` entirely (the shape of every existing
 *     lifecycle test, which never opts into the new path), `unitInstalled`
 *     defaults to `false` → the detached arm. This keeps those tests
 *     DETERMINISTIC regardless of whether the test host happens to have a real
 *     hub unit installed. New Phase 3b tests opt into the supervisor arm by
 *     passing `supervisor: { unitInstalled: true, … }`.
 */
function resolveSupervisor(opts: LifecycleOpts["supervisor"]): ResolvedSupervisor {
  const hubUnitDeps = opts?.hubUnitDeps ?? defaultHubUnitDeps;
  // No `supervisor` block at all → detached arm, deterministically. Only probe
  // the real filesystem when the caller opted into the new path (production CLI
  // passes `supervisor: {}`; tests pass the seams they want to assert).
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
 * Resolve the hub origin used as the operator token's `iss` validator in the
 * supervisor path. Unlike {@link resolveHubOrigin} (which returns `undefined`
 * for pure loopback so the spawn env omits PARACHUTE_HUB_ORIGIN), the operator
 * token ALWAYS carries an `iss`, so this falls back to the canonical loopback
 * origin. Mirrors `commands/auth.ts`'s `resolveHubIssuer` so the issuer the CLI
 * validates the token against matches what `auth rotate-operator` minted under.
 * The fallback differs cosmetically — here `readHubPort(configDir) ??
 * HUB_UNIT_DEFAULT_PORT`, in auth.ts `127.0.0.1:${HUB_DEFAULT_PORT}` — but both
 * resolve to 1939 under canonical-ports today, so they agree in practice.
 * TODO: consolidate with auth.ts:resolveHubIssuer to prevent drift.
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

interface ResolvedTarget {
  short: string;
  entry: ServiceEntry;
  /**
   * Lifecycle spec resolved at request time. First-party comes from
   * `getSpec(short)`; third-party comes from
   * `getSpecFromInstallDir(entry.installDir, ...)`. May be undefined when
   * a row has neither — `start` prints the actionable "no installDir"
   * re-install message for an installDir-less third-party row, or
   * "lifecycle not yet supported" otherwise; `stop`/`logs` keep working
   * via pidfile/logfile semantics keyed by `short`.
   */
  spec: ServiceSpec | undefined;
}

async function specForEntry(
  short: string,
  entry: ServiceEntry,
): Promise<{ spec: ServiceSpec | undefined; error?: string }> {
  const firstParty = getSpec(short);
  // KNOWN_MODULES shorts (vault / scribe / runner — post hub#310 FALLBACK
  // retirement): if installDir is stamped (typical post-self-register),
  // compose the spec from the module's own `.parachute/module.json` so the
  // module is authoritative for its startCmd / paths / health. Falls back
  // to the minimal `getSpec` (which carries an imperative `extras.startCmd`
  // matching the module's canonical declaration) when installDir is absent
  // or module.json is unreadable — covers legacy services.json rows from
  // before installDir stamping landed.
  const km = KNOWN_MODULES[short];
  if (km) {
    if (entry.installDir) {
      try {
        const manifest = await readModuleManifest(entry.installDir);
        if (manifest) return { spec: composeKnownModuleSpec(km, manifest) };
      } catch (err) {
        if (err instanceof ModuleManifestError) {
          // Surface the parse/validation error but keep the legacy
          // imperative-startCmd spec so `start` can still spawn — better
          // than no lifecycle at all when a module ships a typo'd manifest.
          return { spec: firstParty, error: err.message };
        }
        throw err;
      }
    }
    return { spec: firstParty };
  }
  // FIRST_PARTY_FALLBACKS shorts (notes / channel): the vendored manifest
  // is authoritative — startCmd is composed from extras + manifest at
  // `getSpec` time, no installDir read needed.
  if (firstParty) return { spec: firstParty };
  // Third-party rows: spec lives in the module's installDir/module.json.
  if (!entry.installDir) return { spec: undefined };
  try {
    const spec = await getSpecFromInstallDir(entry.installDir, entry.name);
    return { spec: spec ?? undefined };
  } catch (err) {
    if (err instanceof ModuleManifestError) {
      return { spec: undefined, error: err.message };
    }
    throw err;
  }
}

/**
 * Services selected by the `[svc]` positional. `undefined` targets every
 * manageable service (first-party shortnames OR third-party rows that
 * carry `installDir`). Unknown names get a friendly error up front rather
 * than a confusing spawn failure downstream.
 *
 * Third-party modules are addressed by the `name` field from their
 * `module.json` (which is what install copied to `entry.name` for
 * third-party). First-party are addressed by their short name (vault,
 * notes, …) and matched via `shortNameForManifest`.
 *
 * Named-path detail: a third-party row whose name matches but lacks
 * `installDir` resolves to the entry with `spec: undefined` (rather than
 * an "unknown service" error). `stop`/`logs` handle the spec-less case
 * via pidfile/logfile semantics; `start` surfaces an actionable
 * re-install hint downstream. The genuinely-unknown path (no first-party
 * fallback AND no row in services.json) still errors as `unknown service`.
 */
async function resolveTargets(
  svc: string | undefined,
  manifestPath: string,
): Promise<{ targets: ResolvedTarget[] } | { error: string }> {
  const manifest = readManifest(manifestPath);
  if (manifest.services.length === 0) {
    return { error: "No services installed yet. Try: parachute install vault" };
  }

  if (svc !== undefined) {
    // Try first-party (svc is a short name → known fallback).
    const firstPartySpec = getSpec(svc);
    if (firstPartySpec) {
      const entry = manifest.services.find((s) => s.name === firstPartySpec.manifestName);
      if (!entry) {
        return { error: `${svc} isn't installed. Run \`parachute install ${svc}\` first.` };
      }
      // KNOWN_MODULES path (hub#310): `getSpec` returns a startCmd-less
      // minimal spec for vault / scribe / runner. Compose the full
      // spawnable spec by reading installDir's module.json so `start` /
      // `restart` see the real startCmd. FIRST_PARTY_FALLBACKS path:
      // `firstPartySpec.startCmd` is already populated, and `specForEntry`
      // short-circuits without re-reading.
      const { spec, error } = await specForEntry(svc, entry);
      if (error) return { error: `${svc}: invalid module.json — ${error}` };
      return { targets: [{ short: svc, entry, spec: spec ?? firstPartySpec }] };
    }
    // Third-party: match a services.json row by name. Rows with `installDir`
    // resolve a full spec from the on-disk module.json. Rows without it are
    // still managed (stop/logs use pidfile/logfile semantics keyed by short
    // name), but with `spec: undefined` — `start` will surface an
    // installDir-specific error downstream rather than reject up front.
    const entry = manifest.services.find((s) => s.name === svc);
    if (entry) {
      if (entry.installDir) {
        const { spec, error } = await specForEntry(svc, entry);
        if (error) return { error: `${svc}: invalid module.json — ${error}` };
        return { targets: [{ short: svc, entry, spec }] };
      }
      return { targets: [{ short: svc, entry, spec: undefined }] };
    }
    return {
      error: `unknown service "${svc}". known: ${knownServices().join(", ")}`,
    };
  }

  const targets: ResolvedTarget[] = [];
  for (const entry of manifest.services) {
    const short = shortNameForManifest(entry.name);
    if (short) {
      // KNOWN_MODULES path (hub#310): minimal `getSpec` returns no startCmd
      // for vault / scribe / runner — read installDir's module.json to
      // compose the spawnable spec. FIRST_PARTY_FALLBACKS shorts get
      // back the same vendored-startCmd-bearing spec from `getSpec`.
      const { spec } = await specForEntry(short, entry);
      targets.push({ short, entry, spec });
      continue;
    }
    if (entry.installDir) {
      const { spec } = await specForEntry(entry.name, entry);
      targets.push({ short: entry.name, entry, spec });
    }
  }
  if (targets.length === 0) {
    return { error: "No manageable services in services.json." };
  }
  return { targets };
}

export async function start(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const r = resolve(opts);
  // Phase 3b dual-dispatch (design §3.3). On a box with a hub unit installed,
  // drive the RUNNING supervisor; otherwise fall through to the unchanged
  // detached arm below. Phase 5 deletes the else-arm — keep this a clean
  // top-level branch so that deletion is a one-liner.
  if (r.sup.unitInstalled) return startViaSupervisor(svc, r);
  // --- no-unit detached fallback (unchanged; preserved until Phase 5) ---
  if (svc === HUB_SVC) return startHubSvc(r);
  const picked = await resolveTargets(svc, r.manifestPath);
  if ("error" in picked) {
    r.log(picked.error);
    return 1;
  }

  let failures = 0;
  for (const { short, entry, spec } of picked.targets) {
    const state = processState(short, r.configDir, r.alive);
    if (state.status === "running") {
      r.log(`${short} already running (pid ${state.pid}).`);
      continue;
    }
    if (state.pid !== undefined) {
      // Stale PID file for a dead process — clear it before we spawn fresh.
      clearPid(short, r.configDir);
    }

    const cmd = spec?.startCmd?.(entry);
    if (!cmd || cmd.length === 0) {
      // Distinguish the missing-installDir case from "spec resolved but has
      // no startCmd" — the former is fixable by re-registering the module,
      // the latter is a hub-level limitation. Third-party rows hit the first
      // branch when their self-registration predates the installDir contract.
      if (!getSpec(short) && !entry.installDir) {
        r.log(
          `${short}: services.json entry has no installDir, so the start command can't be resolved. Re-run \`parachute install <path-to-${short}>\` to refresh its registration, or upgrade the module to a version that self-registers with installDir.`,
        );
      } else {
        r.log(`${short}: lifecycle not yet supported for this service.`);
      }
      failures++;
      continue;
    }

    const logFile = ensureLogPath(short, r.configDir);
    // Merge `<configDir>/<short>/.env` into the spawn env so service-specific
    // values (auto-wired SCRIBE_AUTH_TOKEN/SCRIBE_URL on vault, GROQ/OPENAI
    // API keys on scribe written by the install prompt) reach the daemon.
    // Vault still loads its own .env at runtime (it has its own start.sh
    // wrapper for launchd / systemd) — this is idempotent there. Hub-origin
    // override wins on collision; that's the live-exposure source of truth.
    const fileEnv = readEnvFileValues(join(r.configDir, short, ".env"));
    // PORT override (hub#356): same shape as `spawnSupervised` in
    // api-modules-ops.ts. Without this, operators running `parachute start
    // vault` inside a container that has PORT in env (Render / Fly / etc.)
    // hit EADDRINUSE on hub's port. Local dev typically doesn't set PORT, so
    // this is a no-op there. fileEnv wins on collision so per-service .env
    // can still override if an operator deliberately set PORT in there.
    const env: Record<string, string> = { PORT: String(entry.port), ...fileEnv };
    if (r.hubOrigin) env[HUB_ORIGIN_ENV] = r.hubOrigin;
    const spawnerOpts: { env?: Record<string, string>; cwd?: string } = {};
    if (Object.keys(env).length > 0) spawnerOpts.env = env;
    // Third-party modules ship clean relative startCmds — `cwd: installDir`
    // makes those resolve. First-party fallbacks use absolute / PATH binaries
    // so their cwd is irrelevant; passing it doesn't hurt.
    if (entry.installDir) spawnerOpts.cwd = entry.installDir;
    const passOpts =
      spawnerOpts.env !== undefined || spawnerOpts.cwd !== undefined ? spawnerOpts : undefined;

    // Pre-flight the startCmd binary (`@openparachute/depcheck`) so a missing
    // executable surfaces the friendly install UX inline AND is persisted onto
    // the services.json row, so a *later* `parachute status` (a separate
    // invocation that only reads the manifest) + the SPA modules pane show
    // "vault: failed to start — parachute-vault not installed" with install
    // info, rather than a bare "failed"/orphan-timeout. The binary is `cmd[0]`
    // (e.g. `parachute-vault` for an npm install, `bun` for a bun-linked one).
    const startBinary = cmd[0];
    if (startBinary) {
      try {
        ensureExecutable(startBinary, { which: r.which });
      } catch (err) {
        if (err instanceof MissingDependencyError) {
          failures++;
          r.log(`✗ ${short} failed to start:`);
          for (const line of err.message.split("\n")) r.log(`  ${line}`);
          recordStartError(entry.name, err.toWire(), r.manifestPath);
          continue;
        }
        throw err;
      }
    }

    let pid: number;
    try {
      pid = r.spawner.spawn(cmd, logFile, passOpts);
    } catch (err) {
      // Belt-and-suspenders: a missing binary that slipped past the pre-flight
      // (race) still becomes a MissingDependencyError via rethrowIfMissing.
      if (startBinary) {
        try {
          rethrowIfMissing(err, startBinary);
        } catch (missing) {
          if (missing instanceof MissingDependencyError) {
            failures++;
            r.log(`✗ ${short} failed to start:`);
            for (const line of missing.message.split("\n")) r.log(`  ${line}`);
            recordStartError(entry.name, missing.toWire(), r.manifestPath);
            continue;
          }
        }
      }
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      r.log(`✗ ${short} failed to start: ${msg}`);
      continue;
    }
    // A successful spawn clears any stale start-error recorded from a prior
    // missing-dependency failure so `parachute status` doesn't keep showing it.
    clearStartError(entry.name, r.manifestPath);
    writePid(short, pid, r.configDir);

    // Boot-readiness gating (hub#194 + hub#487). A spawn returning a pid only
    // proves the kernel forked the process — it says nothing about whether the
    // service survived its boot or bound its port. Two silent-start shapes:
    //
    //   (1) spawn-then-immediately-die (hub#194): the child throws before
    //       listening (notes-serve's Bun.resolveSync failing for bun-linked
    //       installs) and exits microseconds later. Caught by the settle below.
    //
    //   (2) alive-but-never-bound (hub#487): the port is already held by an
    //       orphan, the child hits EADDRINUSE, but its process *lingers* (or a
    //       supervisor retries) long enough to clear the liveness check. `start`
    //       would report "✓ started" while `parachute status` shows it inactive
    //       because nothing answers on the port. Aaron hit exactly this with an
    //       orphan holding vault's 1940 on a fresh EC2 box. Caught by the
    //       port-readiness poll below.
    //
    // On any failure we surface the tail of the logfile so the operator sees
    // the real boot error inline, and we specifically call out EADDRINUSE with
    // the `lsof -ti:<port>` remedy.
    const reportStartFailure = (reason: string): void => {
      clearPid(short, r.configDir);
      failures++;
      const tail = readLogTail(logFile, 20);
      if (detectAddrInUse(tail)) {
        r.log(
          `✗ ${short} failed to start: port ${entry.port} is already in use. Stop the existing process first — find it with \`lsof -ti:${entry.port}\` (then \`kill <pid>\`), or run \`parachute restart ${short}\`.`,
        );
      } else {
        r.log(`✗ ${short} failed to start: ${reason}`);
      }
      if (tail.length > 0) {
        r.log(`  ── last ${tail.length} log line(s) (${logFile}) ──`);
        for (const line of tail) r.log(`  │ ${line}`);
      } else {
        r.log(`  Tail the log for details: tail -50 ${logFile}`);
      }
    };

    if (r.startSettleMs > 0) {
      await r.sleep(r.startSettleMs);
      if (!r.alive(pid)) {
        reportStartFailure(
          `spawned pid ${pid} but the process exited within ${r.startSettleMs}ms.`,
        );
        continue;
      }
    }

    // Port-readiness poll (hub#487). The process is alive; now confirm it
    // actually bound its port before claiming success. Poll up to
    // `startReadyMs`, re-checking liveness each iteration so a *later* death
    // (e.g. a slow EADDRINUSE crash) is still reported as a failure. A process
    // that stays alive but never binds within the window gets a non-fatal
    // warning rather than a hard failure — some daemons legitimately do slow
    // boot work, and we'd rather not flip a healthy-but-slow start to red.
    if (r.startReadyMs > 0) {
      const deadline = r.now() + r.startReadyMs;
      let listening = false;
      let died = false;
      while (r.now() < deadline) {
        if (!r.alive(pid)) {
          died = true;
          break;
        }
        if (await r.portListening(entry.port)) {
          listening = true;
          break;
        }
        await r.sleep(r.startReadyPollMs);
      }
      if (died) {
        reportStartFailure(`spawned pid ${pid} but the process exited during startup.`);
        continue;
      }
      if (!listening) {
        // Last-chance liveness check — the loop may have exited on the
        // deadline right as the process died.
        if (!r.alive(pid)) {
          reportStartFailure(`spawned pid ${pid} but the process exited during startup.`);
          continue;
        }
        r.log(
          `⚠ ${short} started (pid ${pid}) but port ${entry.port} isn't accepting connections yet after ${r.startReadyMs}ms.`,
        );
        r.log(
          `  It may still be coming up — check \`parachute status\` and \`parachute logs ${short}\`.`,
        );
        if (r.hubOrigin) r.log(`  ${HUB_ORIGIN_ENV}=${r.hubOrigin}`);
        if (short === "vault") persistVaultHubOriginForStart(r);
        continue;
      }
    }

    r.log(`✓ ${short} started (pid ${pid}); logs: ${logFile}`);
    if (r.hubOrigin) r.log(`  ${HUB_ORIGIN_ENV}=${r.hubOrigin}`);
    if (short === "vault") persistVaultHubOriginForStart(r);
  }
  return failures === 0 ? 0 : 1;
}

/**
 * Durable-persist vault's `PARACHUTE_HUB_ORIGIN` on a vault `start`. Two cases,
 * in order:
 *
 *  1. The resolved spawn origin (`r.hubOrigin`) is a real public origin — write
 *     it. This is the long-standing happy path: an exposure is live, the
 *     launchd / systemd daemon (which boots vault out-of-band and never sees
 *     this spawn env) needs it in `.env` to validate hub-minted JWTs' `iss`.
 *     `persistVaultHubOrigin` skips loopback / unchanged values itself.
 *
 *  2. Self-heal: even when `r.hubOrigin` resolved to loopback or undefined
 *     (e.g. the hub.port file outran the expose-state read, or this is a bare
 *     `restart vault` on a deploy whose `.env` was never written), consult
 *     `expose-state.json` directly. If it advertises a public origin and
 *     vault's persisted value is unset / loopback, write the public origin.
 *     This is what lets an EXISTING broken Cloudflare deploy self-correct on
 *     the next `parachute restart vault`, not only fresh exposes.
 *
 * Case 1 covers the override / freshly-resolved path; case 2 catches the gap
 * the Cloudflare 401 P0 fell through. See `vault-hub-origin-env.ts`.
 */
function persistVaultHubOriginForStart(r: Resolved): void {
  if (r.hubOrigin) persistVaultHubOrigin(r.configDir, r.hubOrigin, r.log);
  selfHealVaultHubOrigin(r.configDir, r.log, join(r.configDir, "expose-state.json"));
}

export async function stop(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const r = resolve(opts);
  // Phase 3b dual-dispatch (design §3.3). Unit-installed → drive the supervisor
  // / platform manager; else the unchanged detached arm below.
  if (r.sup.unitInstalled) return stopViaSupervisor(svc, r);
  // --- no-unit detached fallback (unchanged; preserved until Phase 5) ---
  if (svc === HUB_SVC) return stopHubSvc(r);
  const picked = await resolveTargets(svc, r.manifestPath);
  if ("error" in picked) {
    r.log(picked.error);
    return 1;
  }

  let failures = 0;
  for (const { short } of picked.targets) {
    const pid = readPid(short, r.configDir);
    if (pid === undefined) {
      r.log(`${short} wasn't running.`);
      continue;
    }
    if (!r.alive(pid)) {
      clearPid(short, r.configDir);
      r.log(`${short} wasn't running (cleaned stale pid file).`);
      continue;
    }

    try {
      r.kill(pid, "SIGTERM");
    } catch (err) {
      failures++;
      r.log(`✗ ${short}: SIGTERM failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const deadline = r.now() + r.killWaitMs;
    while (r.now() < deadline && r.alive(pid)) {
      await r.sleep(r.pollIntervalMs);
    }

    if (r.alive(pid)) {
      r.log(`${short} didn't exit after ${r.killWaitMs}ms; sending SIGKILL.`);
      try {
        r.kill(pid, "SIGKILL");
      } catch (err) {
        failures++;
        r.log(`✗ ${short}: SIGKILL failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    clearPid(short, r.configDir);
    r.log(`✓ ${short} stopped.`);
  }
  return failures === 0 ? 0 : 1;
}

export async function restart(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const r = resolve(opts);
  // Phase 3b dual-dispatch (design §3.3). Unit-installed → drive the supervisor
  // / platform manager (with the 404-fallthrough for modules, §6.2); else the
  // unchanged detached stop-then-start below.
  if (r.sup.unitInstalled) return restartViaSupervisor(svc, r);
  // --- no-unit detached fallback (unchanged; preserved until Phase 5) ---
  // Pass `supervisor: undefined` to the inner stop/start so their own
  // `resolveSupervisor` short-circuits to `unitInstalled: false` without
  // re-probing `isHubUnitInstalled` (two redundant `stat`s per call) — we
  // already resolved no-unit above, so both inner calls would re-take this
  // same detached arm regardless. Behavior-preserving; just drops the probes.
  const detachedOpts = { ...opts, supervisor: undefined };
  const stopCode = await stop(svc, detachedOpts);
  if (stopCode !== 0) return stopCode;
  return await start(svc, detachedOpts);
}

// ---------------------------------------------------------------------------
// Phase 3b supervisor-path verb dispatch (design §3.3).
//
// These are the NEW arm of the dual-dispatch: when a hub unit is installed,
// `start/stop/restart` drive the RUNNING hub's in-process Supervisor over the
// loopback module-ops API (per-module verbs) or the platform manager (hub
// verbs / no-svc). The detached arm above is untouched and Phase 5 deletes it
// + this comment block's `unitInstalled` guard, collapsing to this path only.
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
 * false when it isn't (and the messages were surfaced). The `no-unit` outcome
 * shouldn't reach here under the dual-dispatch (we only take the supervisor arm
 * when a unit IS installed), but it's handled defensively.
 */
async function ensureHubForOp(r: Resolved, port: number): Promise<boolean> {
  const ensured = await r.sup.ensureHubUnit({
    port,
    deps: r.sup.hubUnitDeps,
    log: r.log,
  });
  if (ensured.outcome === "already-up" || ensured.outcome === "started") return true;
  // Defensive / unreachable under dual-dispatch: this arm catches the `no-unit`
  // outcome (and any other non-up outcome), but we only reach `ensureHubForOp`
  // on the supervisor path, which is gated on `unitInstalled === true` — the
  // same `isHubUnitInstalled` probe that makes `ensureHubUnit` return `no-unit`
  // only when it's false. So `no-unit` can't surface here in production; it's
  // harmless surface. Candidate for removal in the Phase 5 bridge-collapse —
  // the deletion sweep should not overlook this branch.
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
    r.log(`${svc} already stopped (the hub isn't running, so its modules are down).`);
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

/**
 * Start the internal hub. Delegates to `ensureHubRunning`, which owns the
 * port-fallback probe, the port-file write, and the issuer flag — none of
 * which fit a generic `SERVICE_SPECS` entry. The hub origin (when known)
 * doubles as the OAuth `iss` claim, so we forward it as `issuer`.
 *
 * Silences `ensureHubRunning`'s own log and emits our own `✓ hub started …`
 * line so the output matches the service-start shape (`✓ vault started
 * (pid X); logs: …`) and `stopHubSvc`'s `✓ hub stopped.` symmetry.
 */
async function startHubSvc(r: Resolved): Promise<number> {
  const ensureOpts: EnsureHubOpts = { configDir: r.configDir, log: () => {} };
  if (r.hubOrigin) ensureOpts.issuer = r.hubOrigin;
  try {
    const result = await r.ensureHub(ensureOpts);
    if (result.started) {
      const logFile = logPathFor(HUB_SVC, r.configDir);
      r.log(`✓ hub started (pid ${result.pid}) on port ${result.port}; logs: ${logFile}`);
    } else {
      r.log(`hub already running (pid ${result.pid}) on port ${result.port}.`);
    }
    // Self-heal a stale operator-token issuer (hub#481). Runs whether the hub
    // was freshly started OR already running — a token stamped at loopback
    // before exposure must heal even when the hub is already up. The loopback /
    // provenance guards live inside `selfHealOperatorTokenIssuer`, so the only
    // gate here is "is there a real issuer to heal toward?".
    await selfHealOperatorTokenOnStart(r);
    return 0;
  } catch (err) {
    r.log(`✗ hub failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * Re-issue the operator token under the hub's current origin when its `iss`
 * went stale after an init-at-loopback → expose transition (hub#481). Mirrors
 * `persistVaultHubOriginForStart`'s quiet style: emit a single line only when
 * a rotation actually happens; stay silent for fresh / absent / skipped.
 *
 * The ENTIRE self-heal is wrapped here so it can NEVER block or fail
 * `start hub` — a db-open error, a corrupt token, anything — degrades to a
 * brief warning and `start hub` still returns 0.
 */
async function selfHealOperatorTokenOnStart(r: Resolved): Promise<void> {
  if (!r.hubOrigin) return;
  try {
    const status = await r.selfHealOperatorTokenFn({
      issuer: r.hubOrigin,
      configDir: r.configDir,
      log: r.log,
    });
    if (status.kind === "rotated") {
      r.log(`  refreshed operator.token issuer → ${r.hubOrigin} (was stale after exposure)`);
    }
  } catch (err) {
    r.log(
      `  note: operator.token issuer self-heal skipped (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
}

/**
 * Stop the internal hub. `stopHub` returns false when nothing was running
 * (no pidfile, or stale pidfile cleared) — that's a clean no-op for the
 * operator, so we still exit 0.
 */
async function stopHubSvc(r: Resolved): Promise<number> {
  try {
    const stopped = await r.stopHubFn({
      configDir: r.configDir,
      log: r.log,
      killWaitMs: r.killWaitMs,
      pollIntervalMs: r.pollIntervalMs,
    });
    r.log(stopped ? "✓ hub stopped." : "hub wasn't running.");
    return 0;
  } catch (err) {
    r.log(`✗ hub failed to stop: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
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
