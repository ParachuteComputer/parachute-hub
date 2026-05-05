import { existsSync, openSync } from "node:fs";
import { join } from "node:path";
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
import { HUB_ORIGIN_ENV, deriveHubOrigin } from "../hub-origin.ts";
import { ModuleManifestError } from "../module-manifest.ts";
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
  type ServiceSpec,
  getSpec,
  getSpecFromInstallDir,
  knownServices,
  shortNameForManifest,
} from "../service-spec.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";

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
  hub?: {
    ensureRunning?: (opts: EnsureHubOpts) => Promise<EnsureHubResult>;
    stop?: (opts: StopHubOpts) => Promise<boolean>;
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
  hubOrigin: string | undefined;
  ensureHub: (opts: EnsureHubOpts) => Promise<EnsureHubResult>;
  stopHubFn: (opts: StopHubOpts) => Promise<boolean>;
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
    hubOrigin: resolveHubOrigin(opts.hubOrigin, configDir),
    ensureHub: opts.hub?.ensureRunning ?? ensureHubRunning,
    stopHubFn: opts.hub?.stop ?? stopHub,
  };
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
  if (firstParty) return { spec: firstParty };
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
      return { targets: [{ short: svc, entry, spec: firstPartySpec }] };
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
      const spec = getSpec(short);
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
    const env: Record<string, string> = { ...fileEnv };
    if (r.hubOrigin) env[HUB_ORIGIN_ENV] = r.hubOrigin;
    const spawnerOpts: { env?: Record<string, string>; cwd?: string } = {};
    if (Object.keys(env).length > 0) spawnerOpts.env = env;
    // Third-party modules ship clean relative startCmds — `cwd: installDir`
    // makes those resolve. First-party fallbacks use absolute / PATH binaries
    // so their cwd is irrelevant; passing it doesn't hurt.
    if (entry.installDir) spawnerOpts.cwd = entry.installDir;
    const passOpts =
      spawnerOpts.env !== undefined || spawnerOpts.cwd !== undefined ? spawnerOpts : undefined;
    try {
      const pid = r.spawner.spawn(cmd, logFile, passOpts);
      writePid(short, pid, r.configDir);
      r.log(`✓ ${short} started (pid ${pid}); logs: ${logFile}`);
      if (r.hubOrigin) r.log(`  ${HUB_ORIGIN_ENV}=${r.hubOrigin}`);
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      r.log(`✗ ${short} failed to start: ${msg}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

export async function stop(svc: string | undefined, opts: LifecycleOpts = {}): Promise<number> {
  const r = resolve(opts);
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
  const stopCode = await stop(svc, opts);
  if (stopCode !== 0) return stopCode;
  return await start(svc, opts);
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
    return 0;
  } catch (err) {
    r.log(`✗ hub failed to start: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
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
}

export async function logs(svc: string, opts: LogsOpts = {}): Promise<number> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const log = opts.log ?? ((line) => console.log(line));
  const lines = opts.lines ?? 200;
  const follow = opts.follow ?? false;

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
    log(`no logs yet for ${svc}. \`parachute start ${svc}\` to begin.`);
    return 0;
  }

  if (follow) {
    const spawner = opts.tailSpawner ?? {
      spawn(cmd) {
        const proc = Bun.spawn([...cmd], { stdio: ["ignore", "inherit", "inherit"] });
        return proc.pid;
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
