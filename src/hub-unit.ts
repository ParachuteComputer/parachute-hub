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
import { enrichedUnitPath } from "./spawn-path.ts";

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
  /**
   * HTTP `/health` probe that ALSO reads the JSON `version` field of the
   * running hub (#590). Resolves to `{ ok, version }` — `ok` mirrors
   * {@link probeHealth} (2xx), `version` is the running hub's reported version
   * (or `undefined` when the body has no `version` field — a very old hub that
   * predates the field; the caller treats that as a mismatch). Resolves to
   * `null` when the hub doesn't answer at all (connection-refused / timeout).
   * Production uses a bounded `fetch`; tests inject a deterministic stub.
   */
  probeHealthVersion: (port: number) => Promise<{ ok: boolean; version?: string } | null>;
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

/**
 * Default version-aware `/health` probe (#590). Reads the JSON body and pulls
 * out the `version` field. Returns `null` on any network error / timeout (the
 * hub isn't answering); `{ ok, version }` otherwise — `version` is `undefined`
 * when the body has no string `version` field (a very old hub, or a non-JSON
 * body), which the caller treats as a mismatch. 1.5s timeout, mirroring
 * {@link defaultProbeHealth}.
 */
async function defaultProbeHealthVersion(
  port: number,
): Promise<{ ok: boolean; version?: string } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    let version: string | undefined;
    try {
      const body = (await res.json()) as unknown;
      if (body && typeof body === "object" && "version" in body) {
        const v = (body as { version?: unknown }).version;
        if (typeof v === "string" && v.length > 0) version = v;
      }
    } catch {
      // Non-JSON body → no version. Leave `version` undefined (→ mismatch).
    }
    return version !== undefined ? { ok: res.ok, version } : { ok: res.ok };
  } catch {
    return null;
  }
}

export const defaultHubUnitDeps: HubUnitDeps = {
  ...defaultManagedUnitDeps,
  probeHealth: defaultProbeHealth,
  probeHealthVersion: defaultProbeHealthVersion,
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
      // NOTE: `launchctl print` emits the service STATE DESCRIPTOR (load state,
      // last exit code, pid, env), NOT a log tail — unlike the systemd arm's
      // `journalctl -n 50` which is a genuine tail of the unit's output. It's
      // still diagnostically useful (a crash-looping unit shows its last exit
      // code here), but it won't show the hub's recent stderr. The richer
      // launchd equivalent is `log show --predicate 'process == "bun"' --last 5m`
      // (or scoped by the unit's logPath) — a future refinement; not wired now.
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

/** Outcome of a `stop hub` / `restart hub` via the platform manager (§3.3). */
export type HubUnitManagerOpOutcome =
  /** The manager command succeeded (the unit was stopped / restarted). */
  | "ok"
  /** No service manager (systemd/launchd) is available. */
  | "no-manager"
  /** No hub unit is installed. */
  | "no-unit"
  /** The platform manager rejected the command (carries its stderr). */
  | "failed";

export interface HubUnitManagerOpResult {
  outcome: HubUnitManagerOpOutcome;
  /** Human-readable lines the caller should surface. */
  messages: string[];
}

/**
 * Stop the hub UNIT via the platform manager (design §3.3 `stop hub` row).
 *
 * MUST go through the manager — NEVER a PID signal. launchd `KeepAlive` and
 * systemd `Restart=always` would immediately respawn a killed PID (R17), so a
 * `kill` would be silently undone. The manager call deregisters the unit's
 * keep-alive intent so the hub actually stays down:
 *   - launchd  → `launchctl bootout gui/<uid>/<label>` (unloads + stops; a
 *     subsequent `start hub` re-bootstraps via the install path / `init`).
 *   - systemd  → `systemctl [--user] stop <unit>` (Restart=always does not
 *     re-trigger on an explicit `stop`).
 *
 * Children die with the hub (`serve`'s stop() SIGTERMs all supervised children
 * before `server.stop()`), so stopping the unit stops every module too.
 *
 * Returns a structured outcome; the caller maps it to exit code + messaging.
 * Does NOT install a unit when none exists, and does NOT signal any PID.
 */
export function stopHubUnit(deps: HubUnitDeps): HubUnitManagerOpResult {
  if (!hasServiceManager(deps)) {
    return { outcome: "no-manager", messages: [NO_MANAGER_MESSAGE] };
  }
  if (!isHubUnitInstalled(deps)) {
    return { outcome: "no-unit", messages: [NO_UNIT_MESSAGE] };
  }
  let res: ServiceCommandResult;
  if (deps.platform === "darwin") {
    const uid = deps.getuid() ?? 0;
    // bootout unloads + stops the LaunchAgent so KeepAlive can't resurrect it.
    res = deps.run(["launchctl", "bootout", `gui/${uid}/${HUB_LAUNCHD_LABEL}`]);
  } else {
    const root = (deps.getuid() ?? 1000) === 0;
    const scope = root ? [] : ["--user"];
    res = deps.run(["systemctl", ...scope, "stop", HUB_SYSTEMD_UNIT_NAME]);
  }
  if (res.code !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || "unknown error";
    return {
      outcome: "failed",
      messages: [`failed to stop the hub unit via the service manager (${detail})`],
    };
  }
  return { outcome: "ok", messages: [] };
}

/**
 * Restart the hub UNIT via the platform manager (design §3.3 `restart hub`
 * row). MUST go through the manager — NEVER a PID signal (same R17 reasoning as
 * {@link stopHubUnit}). NOT a per-module fan-out: restarting the hub tears down
 * all supervised children and re-boots every module from `services.json`, so a
 * unit restart is already a total restart of the box's modules.
 *   - launchd  → `launchctl kickstart -k gui/<uid>/<label>` (force-restart;
 *     the same command the start path uses, which on an already-loaded unit
 *     kills + relaunches).
 *   - systemd  → `systemctl [--user] restart <unit>`.
 *
 * Returns a structured outcome; the caller maps it to exit code + messaging.
 */
export function restartHubUnit(deps: HubUnitDeps): HubUnitManagerOpResult {
  if (!hasServiceManager(deps)) {
    return { outcome: "no-manager", messages: [NO_MANAGER_MESSAGE] };
  }
  if (!isHubUnitInstalled(deps)) {
    return { outcome: "no-unit", messages: [NO_UNIT_MESSAGE] };
  }
  let res: ServiceCommandResult;
  if (deps.platform === "darwin") {
    const uid = deps.getuid() ?? 0;
    res = deps.run(["launchctl", "kickstart", "-k", `gui/${uid}/${HUB_LAUNCHD_LABEL}`]);
  } else {
    const root = (deps.getuid() ?? 1000) === 0;
    const scope = root ? [] : ["--user"];
    res = deps.run(["systemctl", ...scope, "restart", HUB_SYSTEMD_UNIT_NAME]);
  }
  if (res.code !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || "unknown error";
    return {
      outcome: "failed",
      messages: [`failed to restart the hub unit via the service manager (${detail})`],
    };
  }
  return { outcome: "ok", messages: [] };
}

/**
 * Outcome of {@link ensureHubVersionMatches} (#590).
 */
export type HubVersionOutcome =
  /** The running hub's version matched the installed version — no action. */
  | "match"
  /** Hub wasn't answering `/health` at all — nothing to compare (no-op). */
  | "not-running"
  /**
   * Versions mismatched, the hub is unit-managed, the unit was restarted, and
   * the running version now matches the installed version. The zombie was
   * cleared.
   */
  | "restarted"
  /**
   * Versions mismatched and the hub is unit-managed, but after the (single)
   * restart the running version STILL doesn't match — e.g. a bun-linked
   * checkout on a feature branch whose package.json version trails the running
   * code, or a restart that adopted yet-another stale build. We restart at most
   * once and then continue rather than loop (the restart-loop guard).
   */
  | "still-mismatched"
  /**
   * Versions mismatched but the running hub is NOT unit-managed (a legacy
   * detached pid, or a dev `bun run serve` in a terminal, or no service
   * manager at all). We do NOT kill it blindly — we surface the mismatch +
   * an actionable message and stop.
   */
  | "not-unit-managed"
  /**
   * Versions mismatched, the hub is unit-managed, but the restart command
   * itself failed (the manager rejected it). Surface the manager's error.
   */
  | "restart-failed";

export interface EnsureHubVersionMatchesResult {
  outcome: HubVersionOutcome;
  /** The running hub's reported version (undefined when it had no version field / wasn't running). */
  runningVersion?: string;
  /** The installed package version we compared against. */
  installedVersion: string;
  /** Human-readable lines the caller should surface (mismatch notice, actionable hints). */
  messages: string[];
}

export interface EnsureHubVersionMatchesOpts {
  /** The installed package version (the caller reads its own `package.json`). */
  installedVersion: string;
  /** Hub port to probe (default 1939). */
  port?: number;
  /** Injectable deps (defaults to production). */
  deps?: HubUnitDeps;
  /** Readiness budget after a restart, in ms (default 15s). */
  readyTimeoutMs?: number;
  /** Poll interval for the post-restart re-probe, in ms (default 250). */
  readyPollMs?: number;
  log?: (line: string) => void;
}

/**
 * Version-check-and-restart at a hub adoption point (#590).
 *
 * The field bug: a freshly-installed hub (e.g. 0.6.4-rc.9) adopts an
 * arbitrarily-stale RUNNING hub (0.5.14-rc.4) merely because it answers
 * `/health` on 1939 — a zombie LaunchAgent survives `rm -rf ~/.parachute`, and
 * everything downstream (tunnel, wizard, vault install) then binds to month-old
 * code running against a directory deleted out from under it.
 *
 * This helper closes that edge. Given the INSTALLED package version (the caller
 * reads its own `package.json` at runtime), it:
 *   1. Probes `/health` for the RUNNING version. Not answering → `not-running`
 *      (nothing to adopt; the caller's bringup path handles starting it).
 *   2. Version matches → `match` (today's behavior, no extra restart).
 *   3. Version mismatches (INCLUDING a hub with no `version` field — a very old
 *      hub — which reads as "undefined ≠ installed"):
 *        a. If the running hub is NOT unit-managed (no manager / no unit
 *           installed) → `not-unit-managed`. We do NOT kill it blindly: a
 *           detached legacy pid or a dev `bun run serve` may be the operator's,
 *           and KeepAlive-less processes aren't ours to reap. Surface an
 *           actionable message and stop.
 *        b. If it IS unit-managed → restart the unit ONCE
 *           ({@link restartHubUnit}), then re-probe `/health` until the version
 *           matches or the timeout elapses:
 *             - now matches → `restarted` (zombie cleared).
 *             - still mismatched → `still-mismatched` (restart-loop guard: we
 *               restart at most once; a bun-linked branch checkout whose
 *               package.json trails the code stays here — warn + continue, do
 *               not loop).
 *             - restart command failed → `restart-failed`.
 *
 * The CALLER decides whether a given outcome is fatal. `init` and the expose
 * chains both want: `match`/`not-running`/`restarted` → continue silently-ish;
 * `not-unit-managed`/`still-mismatched`/`restart-failed` → warn loudly (and, for
 * init, optionally bail) so a brand-new tunnel never wires to a zombie.
 *
 * Everything is behind the {@link HubUnitDeps} seam — no real launchctl /
 * systemctl / HTTP call in tests.
 */
export async function ensureHubVersionMatches(
  opts: EnsureHubVersionMatchesOpts,
): Promise<EnsureHubVersionMatchesResult> {
  const deps = opts.deps ?? defaultHubUnitDeps;
  const port = opts.port ?? HUB_UNIT_DEFAULT_PORT;
  const installedVersion = opts.installedVersion;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
  const readyPollMs = opts.readyPollMs ?? 250;
  const log = opts.log ?? (() => {});

  const probe = await deps.probeHealthVersion(port);
  if (probe === null) {
    // Hub isn't answering — nothing to compare. The caller's bringup path owns
    // starting it; this helper is a no-op here.
    return { outcome: "not-running", installedVersion, messages: [] };
  }

  const runningVersion = probe.version;
  if (runningVersion === installedVersion) {
    // Exactly today's behavior — versions agree, no extra restart.
    return { outcome: "match", runningVersion, installedVersion, messages: [] };
  }

  // Mismatch (includes the no-`version`-field very-old-hub case → undefined).
  const runningLabel = runningVersion ?? "an older version (no version field)";

  // Is this hub one we can restart through the manager? If there's no manager,
  // or no unit installed, the running hub is a legacy detached pid / a dev
  // foreground `serve` — NOT ours to reap. Surface + stop (do not kill blindly).
  if (!hasServiceManager(deps) || !isHubUnitInstalled(deps)) {
    return {
      outcome: "not-unit-managed",
      runningVersion,
      installedVersion,
      messages: [
        `⚠ the running hub is ${runningLabel} but ${installedVersion} is installed.`,
        "  The running hub is NOT managed by a Parachute service unit (a detached process or a foreground `parachute serve`), so it won't be restarted automatically.",
        `  Stop it yourself (find it with \`lsof -ti :${port}\` then \`kill <pid>\`, or quit the foreground \`parachute serve\`), then re-run so the new code is adopted.`,
      ],
    };
  }

  // Unit-managed mismatch: restart the unit ONCE to pick up the new code.
  log(
    `⚠ the running hub is ${runningLabel} but ${installedVersion} is installed — restarting the hub unit to pick up the new code.`,
  );
  const restart = restartHubUnit(deps);
  if (restart.outcome !== "ok") {
    return {
      outcome: "restart-failed",
      runningVersion,
      installedVersion,
      messages: [
        `⚠ the running hub is ${runningLabel} but ${installedVersion} is installed, and the hub unit restart failed.`,
        ...restart.messages,
      ],
    };
  }

  // Builders for the two terminal outcomes of the post-restart re-probe loop.
  const restartedResult = (v: string): EnsureHubVersionMatchesResult => ({
    outcome: "restarted",
    runningVersion: v,
    installedVersion,
    messages: [`✓ hub unit restarted; now running ${installedVersion}.`],
  });
  const stillMismatchedResult = (last: string | undefined): EnsureHubVersionMatchesResult => {
    const reports = last ? ` (reports ${last})` : "";
    return {
      outcome: "still-mismatched",
      ...(last !== undefined ? { runningVersion: last } : {}),
      installedVersion,
      messages: [
        `⚠ restarted the hub unit, but it is still not reporting ${installedVersion}${reports}.`,
        "  This can happen with a bun-linked checkout on a feature branch whose package.json version trails the running code.",
        `  Continuing — verify with \`parachute status\` / \`curl http://127.0.0.1:${port}/health\` if the hub should be on a specific version.`,
      ],
    };
  };

  // Re-probe `/health` until the running version matches the installed version
  // or the readiness budget elapses. Restart-loop guard: we restart AT MOST
  // once — if it still mismatches after this single restart (e.g. a bun-linked
  // checkout on a branch), we warn + continue rather than looping.
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    const after = await deps.probeHealthVersion(port);
    if (after !== null && after.version === installedVersion) {
      return restartedResult(installedVersion);
    }
    if (Date.now() >= deadline) {
      // Report the last-observed (still-stale) version if the hub came back.
      return stillMismatchedResult(after?.version ?? runningVersion);
    }
    if (readyPollMs > 0) await deps.sleep(readyPollMs);
    else break;
  }
  // readyPollMs === 0 fast-path: one more probe, then settle.
  const finalProbe = await deps.probeHealthVersion(port);
  if (finalProbe !== null && finalProbe.version === installedVersion) {
    return restartedResult(installedVersion);
  }
  return stillMismatchedResult(finalProbe?.version ?? runningVersion);
}

/**
 * Run-state of the hub UNIT as reported by the platform manager (design §6.4).
 * This is the manager's view — NOT a liveness verdict. The hub answering
 * `/health` is the liveness signal; the caller (`status`) composes the two
 * (manager says `active` + `/health` answers → "running"; `active` but no
 * `/health` yet → "starting/unhealthy"; `failed` → "failed").
 */
export type HubUnitState =
  /** systemd `is-active` → `active`; launchd `print` → `state = running`. */
  | "active"
  /** systemd `is-active` → `activating` / `reloading`; launchd transient. */
  | "activating"
  /** systemd `is-active` → `failed`; launchd nonzero `last exit code`. */
  | "failed"
  /** systemd `is-active` → `inactive` / `dead`; launchd not-running, clean. */
  | "inactive"
  /** A hub unit is installed but the manager couldn't classify it. */
  | "unknown"
  /** No hub unit file is installed on this platform. */
  | "no-unit"
  /**
   * No on-box service manager exists at all (container runtime / init-less
   * host). There is nothing to query — `status` reports "container runtime
   * (managed)" and leans on `/health` for liveness (§6.4).
   */
  | "no-manager";

export interface HubUnitStateResult {
  state: HubUnitState;
  /** Last exit code, when the manager surfaced one (launchd / failed unit). */
  lastExitCode?: number;
  /** Raw manager output (trimmed), for diagnostics on `unknown` / `failed`. */
  detail?: string;
}

/**
 * Map a systemd `systemctl is-active` stdout token to a {@link HubUnitState}.
 * `is-active` prints exactly one of: `active`, `activating`, `reloading`,
 * `inactive`, `failed`, `deactivating`, `unknown`. We collapse the transient
 * tokens onto our smaller vocabulary so `status` doesn't have to know them all.
 */
function mapSystemdActiveToken(token: string): HubUnitState {
  switch (token.trim()) {
    case "active":
      return "active";
    case "activating":
    case "reloading":
    // `deactivating` (an in-flight stop transition) deliberately maps to
    // `activating` → our `pending` vocabulary: it's a transient transition, not
    // a terminal state. During a `parachute stop hub` the unit may momentarily
    // read `pending` here before settling to `inactive` — the next status poll
    // resolves it. Better a brief "pending" than flapping to a false "active".
    case "deactivating":
      return "activating";
    case "failed":
      return "failed";
    case "inactive":
    case "dead":
      return "inactive";
    default:
      return "unknown";
  }
}

/**
 * Parse a launchd `launchctl print gui/<uid>/<label>` state descriptor into a
 * {@link HubUnitStateResult}. The descriptor is multi-line key/value; we read
 * the `state = …` line and the `last exit code = …` line. A nonzero last-exit
 * with the service not running reads as `failed`; `state = running` reads as
 * `active`; anything else with the unit loaded reads as `inactive`.
 *
 * `launchctl print` exits nonzero when the label isn't loaded at all — the
 * caller treats that as `inactive` (unit installed on disk but not bootstrapped),
 * since the descriptor body is empty.
 */
function parseLaunchctlPrint(stdout: string): HubUnitStateResult {
  const stateMatch = stdout.match(/^\s*state\s*=\s*(\S+)/im);
  const exitMatch = stdout.match(/last exit code\s*=\s*(-?\d+)/i);
  const lastExitCode = exitMatch?.[1] !== undefined ? Number(exitMatch[1]) : undefined;
  const stateToken = stateMatch?.[1]?.toLowerCase();
  const detail = stdout.trim().length > 0 ? stdout.trim() : undefined;
  if (stateToken === "running") {
    return lastExitCode !== undefined
      ? { state: "active", lastExitCode, ...(detail ? { detail } : {}) }
      : { state: "active", ...(detail ? { detail } : {}) };
  }
  // Not running: a nonzero recorded last-exit means the unit crashed/failed; a
  // zero / absent exit means it's loaded-but-idle (inactive). KeepAlive units
  // that crash-loop surface a nonzero last-exit here even between respawns.
  if (lastExitCode !== undefined && lastExitCode !== 0) {
    return { state: "failed", lastExitCode, ...(detail ? { detail } : {}) };
  }
  if (lastExitCode !== undefined) {
    return { state: "inactive", lastExitCode, ...(detail ? { detail } : {}) };
  }
  // No state and no exit-code line — the descriptor told us nothing usable.
  // Distinguish `unknown` (non-empty but unparseable stdout — e.g. a future
  // macOS `launchctl print` field layout we don't recognize) from `inactive`
  // (empty/absent body — the label isn't loaded). This is deliberate: a new
  // layout must NOT be misread as a false `inactive` (which would tell the
  // operator the hub is stopped when it may well be running) — `unknown` keeps
  // the raw `detail` for diagnosis instead.
  return detail ? { state: "unknown", detail } : { state: "inactive" };
}

/**
 * Query the platform manager for the hub unit's run-state (design §6.4 hub
 * row). This is the `status`-side counterpart to {@link stopHubUnit} /
 * {@link restartHubUnit}: a READ, never a mutation.
 *
 *   - No manager (container / init-less) → `no-manager`. `status` reports
 *     "container runtime (managed)" — there's nothing on-box to query, and the
 *     `/health` answer is the liveness signal.
 *   - No unit file installed → `no-unit` (a legacy detached box that somehow
 *     reached this read; the dual-dispatch branch in `status` guards against it).
 *   - systemd → `systemctl [--user] is-active <unit>`; the token maps via
 *     {@link mapSystemdActiveToken}. `is-active` exits nonzero for non-active
 *     states, so we read stdout regardless of exit code.
 *   - launchd → `launchctl print gui/<uid>/<label>`; parsed via
 *     {@link parseLaunchctlPrint}.
 *
 * Never throws — a query failure degrades to `unknown` with the manager's
 * stderr in `detail`, so `status` can render a sensible row rather than crash.
 */
export function queryHubUnitState(deps: HubUnitDeps): HubUnitStateResult {
  if (!hasServiceManager(deps)) return { state: "no-manager" };
  if (!isHubUnitInstalled(deps)) return { state: "no-unit" };
  try {
    if (deps.platform === "darwin") {
      const uid = deps.getuid() ?? 0;
      const r = deps.run(["launchctl", "print", `gui/${uid}/${HUB_LAUNCHD_LABEL}`]);
      // A nonzero exit with empty stdout means the label isn't loaded — the
      // unit file is on disk but never bootstrapped. Read as inactive.
      if (r.stdout.trim().length === 0) {
        const detail = r.stderr.trim();
        return detail ? { state: "inactive", detail } : { state: "inactive" };
      }
      return parseLaunchctlPrint(r.stdout);
    }
    // linux / systemd. `is-active` exits 0 only when active; we classify from
    // stdout (the state word) regardless of exit code.
    const root = (deps.getuid() ?? 1000) === 0;
    const scope = root ? [] : ["--user"];
    const r = deps.run(["systemctl", ...scope, "is-active", HUB_SYSTEMD_UNIT_NAME]);
    const token = r.stdout.trim() || r.stderr.trim();
    if (token.length === 0) return { state: "unknown" };
    const state = mapSystemdActiveToken(token);
    return state === "unknown" ? { state, detail: token } : { state };
  } catch (err) {
    // A manager-query failure must never crash `status` — degrade to unknown.
    return { state: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
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

// The hub-unit PATH is built by `enrichedUnitPath` (src/spawn-path.ts) so this
// init-bringup path and the `migrate --to-supervised` cutover path can't drift.

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
  const path = opts.path ?? enrichedUnitPath(bunInstall, deps.homeDir(), deps.platform);
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
