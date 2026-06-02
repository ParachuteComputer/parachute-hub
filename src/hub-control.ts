import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import { type AliveFn, clearPid, defaultAlive, readPid, runDir } from "./process-state.ts";

/**
 * Hub identity + port helpers + `stopHub` (the detached-stop path the migrate
 * cutover still uses). The hub is *not* a user-facing service (not in
 * services.json). Phase 5b retired the detached `ensureHubRunning` bringup — the
 * hub now runs under a platform unit (`parachute serve`, see `hub-unit.ts` /
 * `managed-unit.ts`); `init` brings it up via `installAndStartHubUnit`. This
 * file keeps `stopHub` (used by `migrate` to stop a legacy detached hub during
 * the cutover) + the canonical-port readers/writers.
 *
 * The hub lives under `svc = "hub"` in the process-state world, so its PID,
 * logs, and runtime files land at `~/.parachute/hub/{run,logs}/…`.
 */

export const HUB_SVC = "hub";
export const HUB_PACKAGE = "@openparachute/hub";
export const HUB_DEFAULT_PORT = 1939;
/**
 * The container `PARACHUTE_HOME` — the Render Blueprint (and the shared Fly
 * image) pins this exact path. `PARACHUTE_HOME === CONTAINER_HOME` is the most
 * reliable container-mode signal the hub has. Single source of truth so the
 * `/api/hub` status surface (`api-hub.ts`) and the in-place-vs-redeploy
 * detection (`hub-upgrade-mode.ts`) can't drift on the magic path.
 */
export const CONTAINER_HOME = "/parachute";

export function hubPortPath(configDir: string = CONFIG_DIR): string {
  return join(runDir(HUB_SVC, configDir), `${HUB_SVC}.port`);
}

export function readHubPort(configDir: string = CONFIG_DIR): number | undefined {
  const p = hubPortPath(configDir);
  if (!existsSync(p)) return undefined;
  const raw = readFileSync(p, "utf8").trim();
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

export function writeHubPort(port: number, configDir: string = CONFIG_DIR): void {
  const p = hubPortPath(configDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${port}\n`);
}

export function clearHubPort(configDir: string = CONFIG_DIR): void {
  const p = hubPortPath(configDir);
  if (existsSync(p)) rmSync(p, { force: true });
}

export type HubPortProbe = (port: number) => Promise<boolean>;
export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;
export type SleepFn = (ms: number) => Promise<void>;

/**
 * Find the PID of the process currently bound to `port` on the local host.
 * Returns undefined when nothing is listening (or when we couldn't determine
 * a PID — `lsof` missing, permission errors, etc.; the caller treats that
 * as "no orphan to adopt").
 *
 * The signature is injectable so tests can stub orphan detection without
 * shelling out to `lsof`. Production callers use `defaultPidOnPort` which
 * wraps `lsof -ti :<port> -sTCP:LISTEN`. macOS + Linux ship `lsof` by
 * default; Windows is out of scope for v0.6 — see hub#287.
 */
export type PidOnPortFn = (port: number) => number | undefined;

export const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Default orphan-PID probe: `lsof -ti :<port> -sTCP:LISTEN` returns the
 * single PID listening on `port`, one per line. We take the first numeric
 * line — multiple PIDs would be unusual for a TCP LISTEN socket and would
 * still resolve to a valid target. Any failure (lsof not installed, no
 * output, garbage) returns undefined so callers fall through to the
 * "port held by something we can't see" path.
 */
export const defaultPidOnPort: PidOnPortFn = (port) => {
  try {
    const result = spawnSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status !== 0) return undefined;
    const first = result.stdout
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (first === undefined) return undefined;
    const pid = Number.parseInt(first, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * True if `port` accepts a listen() on 127.0.0.1. We bind-then-close to
 * avoid racing: the common failure is "Aaron already has something on 1939",
 * and a listen probe catches both EADDRINUSE and EACCES without parsing
 * anything.
 */
export const defaultPortProbe: HubPortProbe = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });

/**
 * Ensure-hub options shape. Phase 5b retired the detached `ensureHubRunning`
 * spawn this used to drive; `init`'s `defaultEnsureHubViaUnit` (hub-unit-backed)
 * reuses this opts shape for its parameter signature. Only `configDir` /
 * `startPort` / `log` are read on that path.
 */
export interface EnsureHubOpts {
  configDir?: string;
  /** Starting port (default 1939). */
  startPort?: number;
  log?: (line: string) => void;
}

export interface StopHubOpts {
  configDir?: string;
  kill?: KillFn;
  alive?: AliveFn;
  sleep?: SleepFn;
  now?: () => number;
  /** How long SIGTERM gets before SIGKILL. */
  killWaitMs?: number;
  pollIntervalMs?: number;
  /**
   * Look up the PID listening on a port. Defaults to `lsof -ti :<port>`
   * (macOS + Linux). Used by `stopHub` for orphan adoption when hub.port
   * is missing/stale but something is still bound to the canonical hub
   * port — see hub#287. Tests inject a stub.
   */
  pidOnPort?: PidOnPortFn;
  /**
   * Canonical hub port to probe for orphan adoption. Defaults to
   * `HUB_DEFAULT_PORT` (1939). The `hub.port` file is the primary source
   * when present; this is the fallback when the file is missing or its
   * PID is dead but the port is still bound.
   */
  canonicalPort?: number;
  log?: (line: string) => void;
}

export async function stopHub(opts: StopHubOpts = {}): Promise<boolean> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const kill = opts.kill ?? defaultKill;
  const alive = opts.alive ?? defaultAlive;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const killWaitMs = opts.killWaitMs ?? 5_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const pidOnPort = opts.pidOnPort ?? defaultPidOnPort;
  const canonicalPort = opts.canonicalPort ?? HUB_DEFAULT_PORT;
  const log = opts.log ?? (() => {});

  // Resolve target PID: prefer the recorded pidfile (always-correct when
  // present + live), but fall back to probing the canonical hub port for
  // orphan processes. hub#287 — a stale or missing hub.port left
  // `parachute stop hub` / `parachute restart hub` blind to a bun proc
  // still holding 1939, leaving the operator stuck with EADDRINUSE on
  // the next `start`.
  let pid = readPid(HUB_SVC, configDir);
  let killedOrphan = false;

  if (pid !== undefined && !alive(pid)) {
    // Stale pidfile — clear it. Fall through to the port-probe below in
    // case the *port* is still held by an orphan (different PID than the
    // stale one we just cleared).
    clearPid(HUB_SVC, configDir);
    pid = undefined;
  }

  if (pid === undefined) {
    const orphanPid = pidOnPort(canonicalPort);
    if (orphanPid !== undefined && alive(orphanPid)) {
      log(
        `Detected orphan hub process holding port ${canonicalPort} (PID ${orphanPid}); stopping it.`,
      );
      pid = orphanPid;
      killedOrphan = true;
    }
  }

  if (pid === undefined) {
    clearHubPort(configDir);
    return false;
  }

  try {
    kill(pid, "SIGTERM");
  } catch {
    // PID gone between alive() and kill(); treat as stopped.
    clearPid(HUB_SVC, configDir);
    clearHubPort(configDir);
    return true;
  }

  const deadline = now() + killWaitMs;
  while (now() < deadline && alive(pid)) {
    await sleep(pollIntervalMs);
  }
  if (alive(pid)) {
    log(`hub didn't exit after ${killWaitMs}ms; sending SIGKILL.`);
    try {
      kill(pid, "SIGKILL");
    } catch {
      // Swallowed — racing against a just-exited process.
    }
  }

  clearPid(HUB_SVC, configDir);
  clearHubPort(configDir);
  if (killedOrphan) log(`✓ orphan hub process (PID ${pid}) stopped.`);
  return true;
}
