import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.ts";
import { hubDbPath } from "./hub-db.ts";
import {
  type AliveFn,
  clearPid,
  defaultAlive,
  ensureLogPath,
  readPid,
  runDir,
  writePid,
} from "./process-state.ts";
import { WELL_KNOWN_DIR } from "./well-known.ts";

/**
 * Lifecycle for the internal hub HTTP server. The hub is *not* a user-facing
 * service (not in services.json) — it's an implementation detail of
 * `parachute expose`, spawned implicitly on bringup and torn down on the
 * final teardown.
 *
 * The hub lives under `svc = "hub"` in the process-state world, so its PID,
 * logs, and runtime files land at `~/.parachute/hub/{run,logs}/…` alongside
 * every other managed service.
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
/**
 * Default fallback range is 1 — the hub binds 1939 or fails. Walking up would
 * steal another Parachute service's slot from the canonical 1939–1949 range.
 * Tests and debug tooling can pass a larger `fallbackRange` explicitly.
 */
export const HUB_PORT_FALLBACK_RANGE = 1;

const HUB_SERVER_PATH = fileURLToPath(new URL("./hub-server.ts", import.meta.url));

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

/**
 * Seam over `Bun.spawn`, mirroring the lifecycle Spawner — tests never want
 * to actually fork a process. The real implementation opens the log file,
 * pipes stdout+stderr into it, and detaches.
 */
export interface HubSpawner {
  spawn(cmd: readonly string[], logFile: string): number;
}

export const defaultHubSpawner: HubSpawner = {
  spawn(cmd, logFile) {
    const fd = openSync(logFile, "a");
    // Inherit env so the hub child process sees PATH, HOME, PARACHUTE_HOME,
    // etc. Bun.spawn defaults to empty env — see api-modules-ops.ts.
    const proc = Bun.spawn([...cmd], {
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    proc.unref();
    return proc.pid;
  },
};

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

export interface EnsureHubOpts {
  configDir?: string;
  wellKnownDir?: string;
  spawner?: HubSpawner;
  alive?: AliveFn;
  probe?: HubPortProbe;
  sleep?: SleepFn;
  /**
   * Look up the PID listening on `port`. Production default uses `lsof`;
   * tests inject a stub. Used to report which orphan process is holding
   * the canonical hub port when the bind probe fails — so the operator
   * has a concrete PID to point `parachute restart hub` at, not just an
   * "unavailable" error. See hub#287.
   */
  pidOnPort?: PidOnPortFn;
  /** Starting port (default 1939). First port that probe()s true wins. */
  startPort?: number;
  /** How many ports to try before giving up (default 20). */
  fallbackRange?: number;
  /**
   * Ports to skip during fallback — typically service ports from services.json
   * so the hub doesn't steal a port a registered service will bind later.
   * Probed ports that happen to be listening still fail the probe on their own;
   * this guards the case where the service isn't running yet.
   */
  reservedPorts?: Iterable<number>;
  /** How long to wait after spawn before claiming readiness. Short — tests set to 0. */
  readyWaitMs?: number;
  /**
   * Public origin to use as the OAuth `iss` claim and as the base for the
   * authorization-server metadata document. Forwarded to the hub server as
   * `--issuer <url>`. When omitted, the hub falls back to the request's own
   * origin — fine for loopback testing, wrong under tailscale where the
   * request origin is `http://127.0.0.1:<port>`.
   */
  issuer?: string;
  log?: (line: string) => void;
}

export interface EnsureHubResult {
  pid: number;
  port: number;
  /** True when this call spawned the hub; false when it was already running. */
  started: boolean;
}

export async function ensureHubRunning(opts: EnsureHubOpts = {}): Promise<EnsureHubResult> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const wellKnownDir = opts.wellKnownDir ?? WELL_KNOWN_DIR;
  const spawner = opts.spawner ?? defaultHubSpawner;
  const alive = opts.alive ?? defaultAlive;
  const probe = opts.probe ?? defaultPortProbe;
  const sleep = opts.sleep ?? defaultSleep;
  const pidOnPort = opts.pidOnPort ?? defaultPidOnPort;
  const startPort = opts.startPort ?? HUB_DEFAULT_PORT;
  const fallbackRange = opts.fallbackRange ?? HUB_PORT_FALLBACK_RANGE;
  const reservedPorts = new Set(opts.reservedPorts ?? []);
  const readyWaitMs = opts.readyWaitMs ?? 150;
  const log = opts.log ?? (() => {});

  const existingPid = readPid(HUB_SVC, configDir);
  const existingPort = readHubPort(configDir);
  if (existingPid !== undefined && alive(existingPid) && existingPort !== undefined) {
    return { pid: existingPid, port: existingPort, started: false };
  }
  // Any stale state (pid without live process, port without pid) — wipe.
  if (existingPid !== undefined) clearPid(HUB_SVC, configDir);
  clearHubPort(configDir);

  let chosenPort: number | undefined;
  for (let i = 0; i < fallbackRange; i++) {
    const candidate = startPort + i;
    if (reservedPorts.has(candidate)) continue;
    if (await probe(candidate)) {
      chosenPort = candidate;
      break;
    }
  }
  if (chosenPort === undefined) {
    // Port is held by *something*. If we can name the PID (lsof on macOS /
    // Linux), point the operator at `parachute restart hub` — which now
    // detects and kills the orphan even when hub.port is missing or stale
    // (hub#287). Without a PID, fall back to the classic lsof hint.
    const range =
      fallbackRange === 1 ? `${startPort}` : `${startPort}..${startPort + fallbackRange - 1}`;
    const orphanPid = fallbackRange === 1 ? pidOnPort(startPort) : undefined;
    if (orphanPid !== undefined) {
      throw new Error(
        `hub: port ${range} unavailable — PID ${orphanPid} is already listening. Run \`parachute restart hub\` to clean up and restart, or \`kill ${orphanPid}\` then \`parachute start hub\`.`,
      );
    }
    throw new Error(
      `hub: port ${range} unavailable. Run \`lsof -iTCP:${startPort}\` to find what's using it, or pass --hub-port to override.`,
    );
  }

  const logFile = ensureLogPath(HUB_SVC, configDir);
  const cmd = [
    "bun",
    HUB_SERVER_PATH,
    "--port",
    String(chosenPort),
    "--well-known-dir",
    wellKnownDir,
    "--db",
    hubDbPath(configDir),
    ...(opts.issuer ? ["--issuer", opts.issuer] : []),
  ];
  const pid = spawner.spawn(cmd, logFile);
  writePid(HUB_SVC, pid, configDir);
  writeHubPort(chosenPort, configDir);

  // A tiny grace period so the subsequent `tailscale serve` proxy target
  // isn't pointed at a not-yet-listening socket.
  if (readyWaitMs > 0) await sleep(readyWaitMs);

  log(`hub listening on 127.0.0.1:${chosenPort} (pid ${pid}); logs: ${logFile}`);
  return { pid, port: chosenPort, started: true };
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
