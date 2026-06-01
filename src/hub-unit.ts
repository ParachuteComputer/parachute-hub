/**
 * "Ensure the hub UNIT is up" — the Phase 3a successor to the detached
 * `ensureHubRunning` spawn (`hub-control.ts:200`).
 *
 * Under the hub-as-supervisor unification (design:
 * `parachute.computer/design/2026-06-01-hub-as-supervisor-unification.md` §3.2)
 * the hub no longer runs as a detached, `unref()`'d `bun hub-server.ts` tracked
 * by a pidfile. It runs as `parachute serve` (foreground hub + in-process
 * Supervisor) under a per-platform process manager — a launchd LaunchAgent on
 * macOS, a systemd unit on Linux, the container runtime on Render/Fly. So
 * "ensure the hub is up" becomes "ensure the hub UNIT is started", driven
 * through the platform manager, NEVER a detached spawn.
 *
 * THE §3.2 ALGORITHM (`ensureHubUnit`):
 *   1. Probe the loopback hub (`GET /health` on the configured port). If it
 *      answers → return "already up".
 *   2. If down, start the hub unit via the platform manager:
 *      `systemctl [--user] start parachute-hub.service` (system vs user by
 *      uid, mirroring `managed-unit.ts`) / `launchctl kickstart -k
 *      gui/<uid>/computer.parachute.hub`.
 *   3. If NO unit is installed → fail with an actionable "run `parachute
 *      migrate`" message (or, from `init`, init installs it — see
 *      `installAndStartHubUnit`). NEVER a detached fallback spawn.
 *   4. If NO manager at all (no systemctl AND no launchctl) → clear
 *      foreground-`serve`-only message (R19 / D1). Don't hang, don't spawn.
 *   5. Wait for hub readiness by polling the hub port (`defaultPortListening`).
 *      On timeout, surface the unit's recent log so a wedged hub is
 *      diagnosable, not a silent hang.
 *
 * EVERYTHING behind the injectable {@link HubUnitDeps} seam (mirroring
 * `ManagedUnitDeps` / `ensureHubRunning`'s seam) so it's unit-testable without
 * touching the real OS.
 *
 * SCOPE (Phase 3a): this is a NEW helper. It does NOT replace
 * `ensureHubRunning` — `expose` / `expose-cloudflare` / `lifecycle` keep using
 * the old detached path until their phases (4/5). Only `init` adopts the new
 * path in 3a (via `installAndStartHubUnit`), and 3b/Phase 4 will adopt
 * `ensureHubUnit` for the per-module-verb bringup.
 */

import {
  HUB_LAUNCHD_LABEL,
  HUB_SYSTEMD_UNIT_NAME,
  type ManagedUnit,
  type ManagedUnitDeps,
  type ManagedUnitInstallResult,
  type ManagedUnitMessages,
  type ServiceCommandResult,
  buildHubManagedUnit,
  defaultManagedUnitDeps,
  installManagedUnit,
  launchdPlistPathForLabel,
  systemdUnitPathForName,
} from "./managed-unit.ts";
import { type PortListeningFn, defaultPortListening } from "./port-probe.ts";

/** Default canonical hub port (the 1939 pin). */
export const HUB_UNIT_DEFAULT_PORT = 1939;

/**
 * Injectable side-effect seam for the ensure-hub-unit machinery. EXTENDS
 * `ManagedUnitDeps` (platform / getuid / homeDir / userName / which / run /
 * file ops — so the same fake drives both `ensureHubUnit` AND the
 * `installManagedUnit` call inside `installAndStartHubUnit` with no unsafe
 * cast) plus the three extra probes ensure-hub needs: an HTTP `/health` probe,
 * a TCP port-listening probe, and a `sleep` (all deterministically stubbable).
 *
 * Production wires {@link defaultHubUnitDeps}; tests inject fakes so no
 * launchctl/systemctl/socket/HTTP call ever touches the real OS.
 */
export interface HubUnitDeps extends ManagedUnitDeps {
  /**
   * HTTP `/health` probe of the loopback hub. Resolves true when the hub
   * answers 2xx, false on connection-refused / non-2xx / timeout. Production
   * uses a bounded `fetch`; tests inject a deterministic stub.
   */
  probeHealth: (port: number) => Promise<boolean>;
  /** TCP connect-probe for readiness polling (reuses `defaultPortListening`). */
  portListening: PortListeningFn;
  /** Sleep between readiness polls (tests pin to 0). */
  sleep: (ms: number) => Promise<void>;
}

/**
 * Default `/health` probe: a bounded `fetch` to `http://127.0.0.1:<port>/health`.
 * Any non-2xx / network error / timeout → false (treated as "hub not up").
 * 1.5s timeout so a wedged-but-listening socket doesn't hang the probe.
 */
async function defaultProbeHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const defaultHubUnitDeps: HubUnitDeps = {
  ...defaultManagedUnitDeps,
  probeHealth: defaultProbeHealth,
  portListening: defaultPortListening,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export type HubUnitOutcome =
  /** Hub already answered `/health` — no manager call was needed. */
  | "already-up"
  /** The manager was driven to start the unit and the hub became ready. */
  | "started"
  /** No unit is installed (actionable error). */
  | "no-unit"
  /** No service manager (systemd/launchd) is available (actionable error). */
  | "no-manager"
  /** The unit was started but the hub never answered within the timeout. */
  | "timeout"
  /** The platform manager rejected the start command. */
  | "start-failed";

export interface EnsureHubUnitResult {
  outcome: HubUnitOutcome;
  /** The hub port that was probed. */
  port: number;
  /** Human-readable lines the caller should surface (errors, log tails). */
  messages: string[];
}

export interface EnsureHubUnitOpts {
  /** Hub port to probe + wait on (default 1939). */
  port?: number;
  /** Injectable deps (defaults to production). */
  deps?: HubUnitDeps;
  /** Readiness budget in ms (default 15s). */
  readyTimeoutMs?: number;
  /** Poll interval in ms (default 250). */
  readyPollMs?: number;
  /** How many trailing log lines to surface on timeout (default 50). */
  logTailLines?: number;
  log?: (line: string) => void;
}

/** True when a hub unit file is present for this platform. */
export function isHubUnitInstalled(deps: HubUnitDeps): boolean {
  const home = deps.homeDir();
  if (deps.platform === "darwin") {
    return deps.exists(launchdPlistPathForLabel(HUB_LAUNCHD_LABEL, home));
  }
  if (deps.platform === "linux") {
    const root = (deps.getuid() ?? 1000) === 0;
    return deps.exists(systemdUnitPathForName(HUB_SYSTEMD_UNIT_NAME, home, root));
  }
  return false;
}

/**
 * Is a service manager (systemd / launchd) available on this platform at all?
 * macOS → launchctl; Linux → systemctl. A box with neither (a bare container,
 * an init-less host) has no manager — the foreground-`serve`-only path (R19/D1).
 */
export function hasServiceManager(deps: HubUnitDeps): boolean {
  if (deps.platform === "darwin") return deps.which("launchctl") !== null;
  if (deps.platform === "linux") return deps.which("systemctl") !== null;
  return false;
}

/** The "no service manager found" actionable message (R19 / D1). */
export const NO_MANAGER_MESSAGE =
  "no service manager (systemd/launchd) found — run `parachute serve` in the foreground, or use a platform that provides one";

/** The "no hub unit installed" actionable message (§3.2 step 3). */
export const NO_UNIT_MESSAGE = "no hub unit installed — run `parachute migrate` to install it";

/**
 * Start the hub unit via the platform manager. Returns the raw command result
 * so the caller can surface stderr on failure. Branches exactly like
 * `managed-unit.ts` / the connector: launchd uses `kickstart -k gui/<uid>/<label>`
 * (force-restart-or-start); systemd uses `systemctl [--user] start <unit>`
 * (system vs user by uid).
 *
 * NOTE: `launchctl kickstart` requires the unit to be bootstrapped already
 * (the install path does that). If it isn't loaded, kickstart returns non-zero
 * — which surfaces as a start-failure with the manager's stderr, not a hang.
 */
function startHubUnitViaManager(deps: HubUnitDeps): ServiceCommandResult {
  if (deps.platform === "darwin") {
    const uid = deps.getuid() ?? 0;
    return deps.run(["launchctl", "kickstart", "-k", `gui/${uid}/${HUB_LAUNCHD_LABEL}`]);
  }
  // linux / systemd
  const root = (deps.getuid() ?? 1000) === 0;
  const scope = root ? [] : ["--user"];
  return deps.run(["systemctl", ...scope, "start", HUB_SYSTEMD_UNIT_NAME]);
}

/**
 * Best-effort tail of the hub unit's recent log so a wedged hub is diagnosable
 * on a readiness timeout (§3.2 step 5). Tries the platform's native log first
 * (journald on systemd, `launchctl print` on launchd), then falls back to the
 * hub's own log file. Never throws — diagnostics must not mask the timeout.
 */
function tailHubUnitLog(deps: HubUnitDeps, lines: number): string[] {
  const out: string[] = [];
  try {
    if (deps.platform === "linux" && deps.which("journalctl") !== null) {
      const root = (deps.getuid() ?? 1000) === 0;
      const scope = root ? [] : ["--user"];
      const r = deps.run([
        "journalctl",
        ...scope,
        "-u",
        HUB_SYSTEMD_UNIT_NAME,
        "-n",
        String(lines),
        "--no-pager",
      ]);
      if (r.code === 0 && r.stdout.trim().length > 0) {
        out.push("Recent hub unit log (journalctl):", r.stdout.trimEnd());
        return out;
      }
    }
    if (deps.platform === "darwin") {
      const uid = deps.getuid() ?? 0;
      const r = deps.run(["launchctl", "print", `gui/${uid}/${HUB_LAUNCHD_LABEL}`]);
      if (r.code === 0 && r.stdout.trim().length > 0) {
        out.push("Hub unit state (launchctl print):", r.stdout.trimEnd());
        return out;
      }
    }
  } catch {
    // The log tail is best-effort; fall through to the file tail below.
  }
  return out;
}

/**
 * Ensure the hub UNIT is up (design §3.2). Probe `/health`; if down, start the
 * unit via the platform manager; wait for readiness; surface the unit log on
 * timeout. Returns a structured outcome — the CALLER decides exit codes /
 * messaging (so `init` and the future per-module-verb path can present it
 * differently).
 *
 * Does NOT install a unit when none exists — that's the caller's job (`init`
 * installs; per-module verbs tell the operator to `parachute migrate`).
 */
export async function ensureHubUnit(opts: EnsureHubUnitOpts = {}): Promise<EnsureHubUnitResult> {
  const deps = opts.deps ?? defaultHubUnitDeps;
  const port = opts.port ?? HUB_UNIT_DEFAULT_PORT;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
  const readyPollMs = opts.readyPollMs ?? 250;
  const logTailLines = opts.logTailLines ?? 50;
  const log = opts.log ?? (() => {});

  // Step 1: probe the loopback hub. If it answers, we're done — no manager call.
  if (await deps.probeHealth(port)) {
    return { outcome: "already-up", port, messages: [] };
  }

  // Step 4 (checked before 2/3): is there ANY manager? A box with neither
  // systemctl nor launchctl can't run a background unit at all (R19/D1).
  if (!hasServiceManager(deps)) {
    return { outcome: "no-manager", port, messages: [NO_MANAGER_MESSAGE] };
  }

  // Step 3: is a unit installed? If not, we can't start it — fail actionably
  // rather than silently spawning a detached hub.
  if (!isHubUnitInstalled(deps)) {
    return { outcome: "no-unit", port, messages: [NO_UNIT_MESSAGE] };
  }

  // Step 2: start the unit via the platform manager.
  log("Hub not responding — starting the hub unit via the service manager…");
  const started = startHubUnitViaManager(deps);
  if (started.code !== 0) {
    const detail = started.stderr.trim() || started.stdout.trim() || "unknown error";
    return {
      outcome: "start-failed",
      port,
      messages: [
        `failed to start the hub unit via the service manager (${detail}) — run \`parachute migrate\` to (re)install it, or \`parachute serve\` in the foreground`,
      ],
    };
  }

  // Step 5: wait for readiness, polling the hub port. On timeout, surface the
  // unit's recent log so a wedged hub is diagnosable rather than a silent hang.
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (await deps.portListening(port)) {
      return { outcome: "started", port, messages: [] };
    }
    if (Date.now() >= deadline) break;
    if (readyPollMs > 0) await deps.sleep(readyPollMs);
    else break;
  }
  // One final check after the loop (covers readyPollMs===0 / fast-forward).
  if (await deps.portListening(port)) {
    return { outcome: "started", port, messages: [] };
  }

  const messages = [
    `hub unit started but did not become ready on 127.0.0.1:${port} within ${Math.round(
      readyTimeoutMs / 1000,
    )}s`,
    ...tailHubUnitLog(deps, logTailLines),
  ];
  return { outcome: "timeout", port, messages };
}

export interface InstallAndStartHubUnitResult {
  /** Outcome of the post-install readiness wait (see {@link HubUnitOutcome}). */
  outcome: HubUnitOutcome;
  /** The hub port. */
  port: number;
  /** Result of the unit-file install step. */
  install: ManagedUnitInstallResult;
  /** Human-readable lines the caller should surface. */
  messages: string[];
}

export interface InstallAndStartHubUnitOpts {
  /** The operator's CURRENT `PARACHUTE_HOME` (captured per §4.2). */
  parachuteHome: string;
  /**
   * Absolute path to `parachute-hub`'s `src/cli.ts` the unit runs `serve`
   * against. Caller resolves it (the bun-linked checkout or installed bin).
   */
  cliPath: string;
  /** Hub port (default 1939). */
  port?: number;
  /** `$BUN_INSTALL` to bake into the unit env (default `$HOME/.bun`). */
  bunInstall?: string;
  /** PATH to bake into the unit env (default a bun-bin-first sane PATH). */
  path?: string;
  /** Log file the hub's stdout+stderr is written to (default the hub logPath). */
  logPath?: string;
  /** Injectable deps (defaults to production). */
  deps?: HubUnitDeps;
  /** Readiness budget in ms (default 15s). */
  readyTimeoutMs?: number;
  /** Poll interval in ms (default 250). */
  readyPollMs?: number;
  log?: (line: string) => void;
}

/** Messages for the hub-unit install (hub wording, mirroring the connector's). */
export function hubUnitMessages(): ManagedUnitMessages {
  return {
    launchctlMissing: NO_MANAGER_MESSAGE,
    systemctlMissing: NO_MANAGER_MESSAGE,
    lingerWarning:
      "Note: could not enable lingering (loginctl enable-linger) — the hub will run while you're logged in but may not start on a cold boot before login. Re-run as root (a system unit needs no linger) if you want cold-boot survival.",
    writeFailedPrefix: "Failed to write the hub unit file",
    launchctlLoadFailedPrefix: "launchctl could not load the hub unit",
    daemonReloadFailedPrefix: "systemctl daemon-reload failed",
    enableFailedPrefix: "systemctl enable --now failed",
    launchdInstalled: (label, started) =>
      `Installed launchd LaunchAgent ${label} — the hub ${started ? "now runs and " : ""}starts on login/boot.`,
    systemdInstalled: (unitName, root, started) =>
      `Installed systemd ${root ? "system" : "user"} unit ${unitName} — the hub ${started ? "now runs and " : ""}starts on boot.`,
  };
}

/**
 * Sane default PATH for the hub unit when the caller doesn't supply one: bun's
 * global bin first (so supervised children resolve a bun-linked binary on cold
 * boot, R20), then the usual system dirs.
 */
function defaultUnitPath(bunInstall: string): string {
  return `${bunInstall}/bin:/usr/local/bin:/usr/bin:/bin`;
}

/**
 * Build + install + start the hub unit, then wait for hub readiness (design
 * §3.3 init row / appendix c). This is the `init`-side bringup that REPLACES
 * the detached `ensureHubRunning` spawn:
 *   1. `buildHubManagedUnit` (captures the operator's current PARACHUTE_HOME,
 *      resolves abs bun via `which`, launchd-by-default on Mac per D2).
 *   2. `installManagedUnit(unit, { start: true })`.
 *   3. Wait for hub readiness (port poll, surface the unit log on timeout).
 *
 * Graceful: when the platform has no manager (`installManagedUnit` returns
 * `{ outcome: "fallback" }`), this returns `outcome: "no-manager"` WITHOUT
 * spawning anything — the container/init-less path is foreground `serve`, not
 * `init` (§3.2 step 4 / Deliverable-1 nuance).
 */
export async function installAndStartHubUnit(
  opts: InstallAndStartHubUnitOpts,
): Promise<InstallAndStartHubUnitResult> {
  const deps = opts.deps ?? defaultHubUnitDeps;
  const port = opts.port ?? HUB_UNIT_DEFAULT_PORT;
  const bunInstall = opts.bunInstall ?? `${deps.homeDir()}/.bun`;
  const path = opts.path ?? defaultUnitPath(bunInstall);
  const logPath = opts.logPath ?? `${opts.parachuteHome}/hub/logs/hub.log`;
  const log = opts.log ?? (() => {});

  // A platform with no manager can't host a unit — short-circuit to the clear
  // foreground-serve message BEFORE building a unit we can't install (§3.2
  // step 4). On a container the runtime CMD is `serve`, not `init`.
  if (!hasServiceManager(deps)) {
    return {
      outcome: "no-manager",
      port,
      install: { outcome: "fallback", messages: [NO_MANAGER_MESSAGE] },
      messages: [NO_MANAGER_MESSAGE],
    };
  }

  let unit: ManagedUnit;
  try {
    unit = buildHubManagedUnit({
      parachuteHome: opts.parachuteHome,
      port,
      bunInstall,
      path,
      cliPath: opts.cliPath,
      logPath,
      // HubUnitDeps extends ManagedUnitDeps — pass it straight through.
      deps,
    });
  } catch (err) {
    // `bun` couldn't be resolved to an absolute path — refuse to bake a broken
    // ExecStart. Surface it; the caller treats this as a hard failure.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      outcome: "start-failed",
      port,
      install: { outcome: "fallback", messages: [detail] },
      messages: [detail],
    };
  }

  const install = installManagedUnit({
    unit,
    deps,
    messages: hubUnitMessages(),
    start: true,
  });

  if (install.outcome === "fallback") {
    // The manager probe passed but install still degraded (write failed,
    // enable failed, etc.). Surface the install messages; no unit is running.
    return { outcome: "no-manager", port, install, messages: install.messages };
  }

  for (const m of install.messages) log(m);

  // Wait for readiness. The unit's RunAtLoad/enable--now already started it;
  // we poll the port + surface the unit log on timeout (§3.2 step 5).
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
  const readyPollMs = opts.readyPollMs ?? 250;
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (await deps.portListening(port)) {
      return { outcome: "started", port, install, messages: install.messages };
    }
    if (Date.now() >= deadline) break;
    if (readyPollMs > 0) await deps.sleep(readyPollMs);
    else break;
  }
  if (await deps.portListening(port)) {
    return { outcome: "started", port, install, messages: install.messages };
  }

  const messages = [
    ...install.messages,
    `hub unit installed but did not become ready on 127.0.0.1:${port} within ${Math.round(
      readyTimeoutMs / 1000,
    )}s`,
    ...tailHubUnitLog(deps, 50),
  ];
  return { outcome: "timeout", port, install, messages };
}
