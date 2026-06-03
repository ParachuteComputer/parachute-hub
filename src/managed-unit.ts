import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { guardServiceManagerCommand } from "./launchctl-guard.ts";

/**
 * Platform-agnostic "managed unit" machinery — the reusable launchd/systemd
 * install + remove + render core that powers BOTH the reboot-persistent
 * cloudflared connector (`src/cloudflare/connector-service.ts`) and the hub
 * unit (`buildHubManagedUnit`, the Phase 3+ `parachute serve` keeper).
 *
 * This file was extracted in Phase 2b of the hub-as-supervisor unification
 * (design: `parachute.computer/design/2026-06-01-hub-as-supervisor-unification.md`
 * §4.1, §4.2, §7.1). The cloudflared connector was the prototype: it already
 * had the per-platform install/remove seam, the graceful no-throw contract, and
 * the launchd-bootstrap / systemd-enable command sequences. Phase 2b factors the
 * cloudflared-specifics out into a `ManagedUnit` descriptor so the SAME machinery
 * can emit a hub unit running `<bun> <cli.ts> serve`.
 *
 * THE HARD CONSTRAINT (design §"preserve connector behavior exactly"): the
 * cloudflared connector is LIVE on both production boxes. The rendered systemd
 * unit text, the rendered launchd plist text, and the install/remove command
 * sequences must be BYTE-identical before and after this extraction. The
 * generalization adds three NEW, OPTIONAL capabilities — an env block, a
 * crash-loop ceiling, and an install-without-start mode — each gated so that a
 * descriptor that leaves them unset (the connector) renders exactly as before:
 *   - env block: emitted only when `env` is non-empty (connector passes `{}`).
 *   - crash-loop ceiling: emitted only when `crashLoop` is set (connector omits).
 *   - install-without-start: `start` defaults to `true` (connector's behavior).
 *
 * Platform shapes (carried over verbatim from the connector):
 *   - macOS  → a launchd LaunchAgent plist (RunAtLoad + KeepAlive), bootstrapped
 *     into the per-user GUI domain. No sudo.
 *   - Linux (non-root) → a systemd *user* unit, `systemctl --user enable --now`,
 *     plus a best-effort `loginctl enable-linger` (hub#494).
 *   - Linux (root) → a systemd *system* unit, `systemctl enable --now`.
 *
 * Everything is behind the injectable `ManagedUnitDeps` seam (identical shape to
 * the connector's old `ConnectorServiceDeps`) so tests drive install/remove
 * without touching real launchctl/systemctl or the operator's home directory.
 */

/** Synchronous command result from the injected service runner. */
export interface ServiceCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Injectable side-effect seam for the managed-unit machinery. Production wires
 * the real fs / os / child-process implementations (`defaultManagedUnitDeps`);
 * tests inject fakes to assert generated file content + the install/remove
 * command sequence without a live launchctl/systemctl.
 */
export interface ManagedUnitDeps {
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /**
   * Effective uid. Linux uses `0 === root` to pick a system vs user systemd
   * unit. `undefined` (Windows / platforms without getuid) → treated as
   * non-root. macOS ignores this (LaunchAgents are always per-user).
   */
  getuid: () => number | undefined;
  /** `$HOME`. */
  homeDir: () => string;
  /** Username for the linger call + systemd unit `User=` (system unit). */
  userName: () => string;
  /** Resolve a binary to an absolute path (launchd/systemd don't inherit PATH). */
  which: (binary: string) => string | null;
  /** Run launchctl/systemctl/loginctl synchronously. */
  run: (cmd: readonly string[]) => ServiceCommandResult;
  /** Write a service file (creates parent dirs). */
  writeFile: (path: string, content: string) => void;
  /** Remove a service file if present (no-op when absent). */
  removeFile: (path: string) => void;
  /** Read a service file, or undefined when absent. */
  readFile: (path: string) => string | undefined;
  /** True when the path exists. */
  exists: (path: string) => boolean;
}

export const defaultManagedUnitDeps: ManagedUnitDeps = {
  platform: process.platform,
  getuid: () => (typeof process.getuid === "function" ? process.getuid() : undefined),
  homeDir: () => homedir(),
  userName: () => process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? "",
  which: (binary) => Bun.which(binary),
  run: (cmd) => {
    // hub#535 boundary guard: under a test runner, REFUSE destructive
    // launchctl/systemctl verbs (bootout/bootstrap/load/kickstart, etc.) instead
    // of spawning the REAL service manager — a test that forgot to inject a fake
    // `run` must not be able to tear down the operator's live daemon by omission.
    // No-op in production (NODE_ENV !== "test"); see src/launchctl-guard.ts.
    guardServiceManagerCommand(cmd);
    const proc = Bun.spawnSync([...cmd], { env: process.env });
    return {
      code: proc.exitCode ?? 1,
      stdout: proc.stdout?.toString() ?? "",
      stderr: proc.stderr?.toString() ?? "",
    };
  },
  writeFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  },
  removeFile: (path) => {
    if (existsSync(path)) rmSync(path, { force: true });
  },
  readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
  exists: (path) => existsSync(path),
};

/**
 * Optional crash-loop ceiling for a managed unit. Caps the respawn rate so a
 * wedged process (corrupt DB, held port) becomes a visible `failed` unit rather
 * than an infinite tight loop (design §4.1 / §6.3). The connector leaves this
 * unset (its respawn is unbounded as before); the hub unit sets it.
 */
export interface CrashLoopCeiling {
  /** systemd `StartLimitIntervalSec` — the rate-limit window, seconds. */
  intervalSec: number;
  /** systemd `StartLimitBurst` — max restarts within the window. */
  burst: number;
  /**
   * launchd `ThrottleInterval` — minimum seconds between respawns. launchd has
   * no burst concept, so this bounds the rate by spacing rather than capping a
   * count (design §4.1 — "the same hub-crash-loop story as systemd's
   * StartLimit").
   */
  throttleIntervalSec: number;
}

/**
 * Platform-agnostic descriptor of a process to keep alive under launchd /
 * systemd. The connector and the hub both reduce to one of these; the renderers
 * + installer below consume only this shape.
 */
export interface ManagedUnit {
  /**
   * launchd Label (also the plist basename, minus `.plist`), reverse-DNS style,
   * e.g. `computer.parachute.cloudflared.<tunnel>` or `computer.parachute.hub`.
   */
  launchdLabel: string;
  /** systemd unit name including the `.service` suffix, e.g. `parachute-hub.service`. */
  systemdUnitName: string;
  /** First line of every rendered unit file (provenance comment). */
  headerComment: string;
  /** systemd `[Unit] Description=`. */
  systemdDescription: string;
  /**
   * The argv to run. `execStart[0]` MUST be an absolute binary path (launchd
   * does not search `$PATH`, systemd uses no login `$PATH`); callers resolve it
   * via `deps.which` at build time.
   */
  execStart: string[];
  /**
   * Environment to inject into the unit. EMPTY → no env block is emitted at all
   * (the connector's behavior — keeps its output byte-identical). Non-empty →
   * a systemd `Environment=KEY=VAL` line per entry / a launchd
   * `EnvironmentVariables` dict.
   */
  env: Record<string, string>;
  /** Where the process's stdout+stderr are written. */
  logPath: string;
  /**
   * Optional crash-loop ceiling. Unset → no StartLimit / ThrottleInterval lines
   * (connector). Set → emitted (hub unit).
   */
  crashLoop?: CrashLoopCeiling;
  /**
   * When `true`, a systemd *system* unit pins `User=<userName>` so the process
   * drops root. `false` → never pin `User=` even on a system unit. The connector
   * sets this `true` (it has always pinned `User=` on the root/system unit); the
   * hub sets it `true` as well (design §4.1 "User=<operator> on the system
   * unit only"). It is a descriptor field rather than a hard-coded behavior so a
   * future unit that wants to genuinely run as root can opt out.
   */
  runAsInvokingUserOnSystemUnit: boolean;
}

/** XML-escape a string for safe inclusion in a plist `<string>` element. */
function plistEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a launchd LaunchAgent plist for a managed unit. `RunAtLoad` starts the
 * process on load (and on login/boot once bootstrapped); `KeepAlive` restarts it
 * if it exits. `ProgramArguments` is the descriptor's `execStart` verbatim
 * (absolute argv[0] — launchd does not search `$PATH`). Logs go to `logPath`.
 *
 * BYTE-IDENTICAL CONSTRAINT: when `unit.env` is empty and `unit.crashLoop` is
 * unset (the connector), this emits exactly the plist the connector emitted
 * before extraction — no `EnvironmentVariables` dict, no `ThrottleInterval`.
 */
export function renderManagedLaunchdPlist(unit: ManagedUnit): string {
  const argXml = unit.execStart.map((a) => `    <string>${plistEscape(a)}</string>`).join("\n");
  // EnvironmentVariables dict — emitted ONLY when env is non-empty (connector
  // passes {} and gets no dict, preserving its byte-identical output).
  const envKeys = Object.keys(unit.env);
  let envBlock = "";
  if (envKeys.length > 0) {
    const entries = envKeys
      .map(
        (k) =>
          `    <key>${plistEscape(k)}</key>\n    <string>${plistEscape(unit.env[k] ?? "")}</string>`,
      )
      .join("\n");
    envBlock = `  <key>EnvironmentVariables</key>\n  <dict>\n${entries}\n  </dict>\n`;
  }
  // ThrottleInterval — emitted ONLY when a crash-loop ceiling is set.
  const throttle = unit.crashLoop
    ? `  <key>ThrottleInterval</key>\n  <integer>${unit.crashLoop.throttleIntervalSec}</integer>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${unit.headerComment} -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistEscape(unit.launchdLabel)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
${envBlock}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${throttle}  <key>StandardOutPath</key>
  <string>${plistEscape(unit.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${plistEscape(unit.logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Render a systemd unit for a managed unit. `Restart=always` mirrors launchd's
 * KeepAlive; `WantedBy` differs by scope (system → multi-user.target; user →
 * default.target). A system unit pins `User=` (when `runAsInvokingUserOnSystemUnit`
 * + a known user) so the process doesn't run as root unnecessarily. `ExecStart`
 * uses the descriptor's absolute `execStart` joined by spaces.
 *
 * BYTE-IDENTICAL CONSTRAINT: when `unit.env` is empty and `unit.crashLoop` is
 * unset (the connector), this emits exactly the unit the connector emitted
 * before extraction — no `Environment=` lines, no `StartLimit*` lines.
 */
export function renderManagedSystemdUnit(
  unit: ManagedUnit,
  opts: { root: boolean; userName: string },
): string {
  const { root, userName } = opts;
  const execStart = unit.execStart.join(" ");
  const userLine =
    root && unit.runAsInvokingUserOnSystemUnit && userName ? `User=${userName}\n` : "";
  const wantedBy = root ? "multi-user.target" : "default.target";
  // Environment= lines — emitted ONLY when env is non-empty (connector passes {}
  // and gets none, preserving its byte-identical output). One line per entry,
  // insertion order, placed after the optional User= line.
  const envLines = Object.keys(unit.env)
    .map((k) => `Environment=${k}=${unit.env[k] ?? ""}\n`)
    .join("");
  // StartLimit* — emitted ONLY when a crash-loop ceiling is set, in the
  // [Service] section after RestartSec.
  const startLimit = unit.crashLoop
    ? `StartLimitIntervalSec=${unit.crashLoop.intervalSec}\nStartLimitBurst=${unit.crashLoop.burst}\n`
    : "";
  return `# ${unit.headerComment}
[Unit]
Description=${unit.systemdDescription}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLine}${envLines}ExecStart=${execStart}
Restart=always
RestartSec=5
${startLimit}
[Install]
WantedBy=${wantedBy}
`;
}

/** launchd plist path under the user's LaunchAgents dir for a label. */
export function launchdPlistPathForLabel(label: string, home: string): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/** systemd unit path — user-level under $HOME, system-level under /etc. */
export function systemdUnitPathForName(unitName: string, home: string, root: boolean): string {
  return root
    ? join("/etc/systemd/system", unitName)
    : join(home, ".config", "systemd", "user", unitName);
}

export interface ManagedUnitInstallResult {
  /**
   * "installed" → an OS service now owns the unit (survives reboot).
   * "fallback" → the service tool was unavailable / failed; the caller decides
   * what to do (the connector falls back to a transient `proc.unref()` spawn).
   */
  outcome: "installed" | "fallback";
  /**
   * On a `fallback`, WHY we fell back — so callers can give an accurate message
   * instead of conflating the two causes:
   *   - "no-manager" → no service manager is available here (launchctl/systemctl
   *     missing, or an unsupported platform). Boot-persistence is impossible.
   *   - "write-failed" → a manager exists but the install itself failed (couldn't
   *     write the unit file, daemon-reload / enable / bootstrap returned non-zero).
   * Undefined when `outcome === "installed"`. The connector ignores this (it only
   * branches on `outcome`); the Phase 5 cutover reads it to pick `no-manager` vs
   * `write-failed`.
   */
  reason?: "no-manager" | "write-failed";
  /** Which init system installed the service (when outcome === "installed"). */
  kind?: "launchd" | "systemd-user" | "systemd-system" | "unsupported";
  /** Path of the written service file (when outcome === "installed"). */
  servicePath?: string;
  /** Human-readable lines for the CLI to print (warnings, hints). */
  messages: string[];
}

export interface ManagedUnitMessages {
  /** Message when launchctl is missing — caller-specific (connector vs hub wording). */
  launchctlMissing: string;
  /** Message when systemctl is missing. */
  systemctlMissing: string;
  /** Soft warning when `loginctl enable-linger` couldn't run (non-root user unit). */
  lingerWarning: string;
  /** Prefix for the failed-to-write-file fallback message. */
  writeFailedPrefix: string;
  /** Prefix for the launchctl-could-not-load fallback message. */
  launchctlLoadFailedPrefix: string;
  /** Prefix for the systemctl-daemon-reload-failed fallback message. */
  daemonReloadFailedPrefix: string;
  /** Prefix for the systemctl-enable-failed fallback message. */
  enableFailedPrefix: string;
  /** Success message for a launchd install (`{label}` placeholder). */
  launchdInstalled: (label: string, started: boolean) => string;
  /** Success message for a systemd install. */
  systemdInstalled: (unitName: string, root: boolean, started: boolean) => string;
}

export interface InstallManagedUnitOpts {
  unit: ManagedUnit;
  deps: ManagedUnitDeps;
  messages: ManagedUnitMessages;
  /**
   * When `false`, write + register the unit WITHOUT starting it: systemd does
   * `daemon-reload` but NOT `enable --now`; launchd writes the plist but does
   * NOT `bootstrap`/`kickstart`. Used by the Phase 5 migration cutover to avoid
   * a second hub racing port 1939 (design §7.1). Defaults to `true` (full
   * behavior — the connector's path is unchanged).
   */
  start?: boolean;
}

/**
 * Install (or refresh) a managed unit on the current platform. Idempotent:
 * re-installing overwrites the unit file and re-loads it. Graceful: a missing /
 * failing tool returns `{ outcome: "fallback", messages }` WITHOUT throwing.
 *
 * Dispatches by platform; `execStart[0]` is assumed already resolved to an
 * absolute path by the caller (the connector resolves cloudflared, the hub
 * resolves bun — both via `deps.which`).
 */
export function installManagedUnit(opts: InstallManagedUnitOpts): ManagedUnitInstallResult {
  const { deps } = opts;
  if (deps.platform === "darwin") return installLaunchdUnit(opts);
  if (deps.platform === "linux") return installSystemdUnit(opts);
  return {
    outcome: "fallback",
    reason: "no-manager",
    messages: [
      `Boot-persistent unit isn't supported on ${deps.platform}; using a transient process.`,
    ],
  };
}

function installLaunchdUnit(opts: InstallManagedUnitOpts): ManagedUnitInstallResult {
  const { unit, deps, messages } = opts;
  const start = opts.start ?? true;
  if (deps.which("launchctl") === null) {
    return { outcome: "fallback", reason: "no-manager", messages: [messages.launchctlMissing] };
  }
  const home = deps.homeDir();
  const plistPath = launchdPlistPathForLabel(unit.launchdLabel, home);
  const label = unit.launchdLabel;
  const uid = deps.getuid() ?? 0;
  const domain = `gui/${uid}`;

  try {
    deps.writeFile(plistPath, renderManagedLaunchdPlist(unit));
  } catch (err) {
    return {
      outcome: "fallback",
      reason: "write-failed",
      messages: [
        `${messages.writeFailedPrefix} (${err instanceof Error ? err.message : String(err)}).`,
      ],
    };
  }

  if (!start) {
    // install-without-start: the plist is on disk + will load on next login/boot
    // (RunAtLoad), but we do NOT bootstrap/kickstart it now, so no process is
    // started in this call (design §7.1 — avoid racing port 1939 during cutover).
    // We also deliberately do NOT bootout any prior service: the CALLER (the
    // Phase 5 migrate cutover) owns stopping the detached/prior process before
    // installing this unit. Do not add a pre-bootout/stop here — it would break
    // the §7.1 ordering the caller relies on to avoid the double-spawn race.
    return {
      outcome: "installed",
      kind: "launchd",
      servicePath: plistPath,
      messages: [messages.launchdInstalled(label, false)],
    };
  }

  // Re-install must be idempotent: bootout any prior load (ignore failure when
  // nothing's loaded), then bootstrap the freshly-written plist. `bootstrap`
  // both loads AND starts (RunAtLoad), so no separate `kickstart` is needed on
  // the happy path; we add a `kickstart -k` to force a restart when the label
  // was already bootstrapped (bootstrap is a no-op then).
  deps.run(["launchctl", "bootout", `${domain}/${label}`]);
  const boot = deps.run(["launchctl", "bootstrap", domain, plistPath]);
  if (boot.code !== 0) {
    // Older macOS (or a sandboxed context) may not accept `bootstrap`; fall back
    // to the legacy `load -w`, then to a fallback outcome.
    const legacy = deps.run(["launchctl", "load", "-w", plistPath]);
    if (legacy.code !== 0) {
      deps.removeFile(plistPath);
      return {
        outcome: "fallback",
        reason: "write-failed",
        messages: [
          `${messages.launchctlLoadFailedPrefix} (${boot.stderr.trim() || legacy.stderr.trim() || "unknown error"}).`,
        ],
      };
    }
  } else {
    deps.run(["launchctl", "kickstart", "-k", `${domain}/${label}`]);
  }

  return {
    outcome: "installed",
    kind: "launchd",
    servicePath: plistPath,
    messages: [messages.launchdInstalled(label, true)],
  };
}

function installSystemdUnit(opts: InstallManagedUnitOpts): ManagedUnitInstallResult {
  const { unit, deps, messages } = opts;
  const start = opts.start ?? true;
  if (deps.which("systemctl") === null) {
    return { outcome: "fallback", reason: "no-manager", messages: [messages.systemctlMissing] };
  }
  const root = (deps.getuid() ?? 1000) === 0;
  const home = deps.homeDir();
  const unitName = unit.systemdUnitName;
  const unitPath = systemdUnitPathForName(unitName, home, root);
  const userName = deps.userName();

  try {
    deps.writeFile(unitPath, renderManagedSystemdUnit(unit, { root, userName }));
  } catch (err) {
    return {
      outcome: "fallback",
      reason: "write-failed",
      messages: [
        `${messages.writeFailedPrefix} (${err instanceof Error ? err.message : String(err)}).`,
      ],
    };
  }

  const scope = root ? [] : ["--user"];
  const outMessages: string[] = [];

  // Non-root: enable linger so the user unit runs without an active login (i.e.
  // after a reboot before the operator logs back in). Strictly best-effort —
  // linger may be unavailable: `loginctl` absent entirely (a container with
  // systemd but no logind), or present-but-failing. Either way we keep the
  // install and warn. The probe + try/catch matter because production
  // `Bun.spawnSync` THROWS on ENOENT — without the guard a box that has
  // systemctl but not loginctl would propagate the spawn error out and hard-fail
  // the calling command. (Run on both start + install-without-start: linger is a
  // boot-survival nicety independent of whether we start the unit now.)
  if (!root && userName) {
    if (deps.which("loginctl") === null) {
      outMessages.push(messages.lingerWarning);
    } else {
      try {
        const linger = deps.run(["loginctl", "enable-linger", userName]);
        if (linger.code !== 0) outMessages.push(messages.lingerWarning);
      } catch {
        // loginctl vanished between probe and run, or threw (ENOENT/EACCES) —
        // never fatal; linger is a best-effort nicety.
        outMessages.push(messages.lingerWarning);
      }
    }
  }

  const reload = deps.run(["systemctl", ...scope, "daemon-reload"]);
  if (reload.code !== 0) {
    deps.removeFile(unitPath);
    return {
      outcome: "fallback",
      reason: "write-failed",
      messages: [
        `${messages.daemonReloadFailedPrefix} (${reload.stderr.trim() || "unknown error"}).`,
      ],
    };
  }

  if (!start) {
    // install-without-start: the unit file is on disk + daemon-reloaded, but we
    // do NOT `enable --now` it, so no process is started in this call and the
    // unit is not yet enabled for boot (design §7.1 — avoid racing port 1939).
    // We also deliberately do NOT stop any prior service: the CALLER (the Phase 5
    // migrate cutover) owns stopping the detached/prior process before installing
    // this unit. Do not add a pre-stop here — it would break the §7.1 ordering the
    // caller relies on to avoid the double-spawn race.
    outMessages.unshift(messages.systemdInstalled(unitName, root, false));
    return {
      outcome: "installed",
      kind: root ? "systemd-system" : "systemd-user",
      servicePath: unitPath,
      messages: outMessages,
    };
  }

  const enable = deps.run(["systemctl", ...scope, "enable", "--now", unitName]);
  if (enable.code !== 0) {
    deps.removeFile(unitPath);
    deps.run(["systemctl", ...scope, "daemon-reload"]);
    return {
      outcome: "fallback",
      reason: "write-failed",
      messages: [`${messages.enableFailedPrefix} (${enable.stderr.trim() || "unknown error"}).`],
    };
  }

  outMessages.unshift(messages.systemdInstalled(unitName, root, true));
  return {
    outcome: "installed",
    kind: root ? "systemd-system" : "systemd-user",
    servicePath: unitPath,
    messages: outMessages,
  };
}

export interface ManagedUnitRemoveResult {
  /** True when a service file was found + removed (best-effort tool teardown ran). */
  removed: boolean;
  messages: string[];
}

export interface RemoveManagedUnitOpts {
  launchdLabel: string;
  systemdUnitName: string;
  deps: ManagedUnitDeps;
  /** Success message for a launchd removal (`{label}` placeholder). */
  removedLaunchdMessage: (label: string) => string;
  /** Success message for a systemd removal. */
  removedSystemdMessage: (unitName: string) => string;
}

/**
 * Stop + remove a managed unit on the current platform. Idempotent +
 * best-effort: a missing service file is a no-op; tool failures never throw (the
 * teardown path must always succeed at clearing state even if the OS service
 * tool hiccups).
 */
export function removeManagedUnit(opts: RemoveManagedUnitOpts): ManagedUnitRemoveResult {
  const { deps, launchdLabel, systemdUnitName } = opts;

  if (deps.platform === "darwin") {
    const home = deps.homeDir();
    const plistPath = launchdPlistPathForLabel(launchdLabel, home);
    if (!deps.exists(plistPath)) return { removed: false, messages: [] };
    const uid = deps.getuid() ?? 0;
    // bootout unloads + stops; ignore its exit (nothing-loaded is fine).
    deps.run(["launchctl", "bootout", `gui/${uid}/${launchdLabel}`]);
    deps.removeFile(plistPath);
    return { removed: true, messages: [opts.removedLaunchdMessage(launchdLabel)] };
  }

  if (deps.platform === "linux") {
    const root = (deps.getuid() ?? 1000) === 0;
    const home = deps.homeDir();
    const unitPath = systemdUnitPathForName(systemdUnitName, home, root);
    if (!deps.exists(unitPath)) return { removed: false, messages: [] };
    const scope = root ? [] : ["--user"];
    // disable --now stops + removes the enable symlink; ignore exit (best-effort).
    deps.run(["systemctl", ...scope, "disable", "--now", systemdUnitName]);
    deps.removeFile(unitPath);
    deps.run(["systemctl", ...scope, "daemon-reload"]);
    return { removed: true, messages: [opts.removedSystemdMessage(systemdUnitName)] };
  }

  return { removed: false, messages: [] };
}

// ---------------------------------------------------------------------------
// Hub unit builder (design §4.1 + §4.2)
//
// NOT wired into any command in this PR — Phase 3 wires `init` to install it.
// Phase 2b only provides + tests the builder.
// ---------------------------------------------------------------------------

/** Reverse-DNS launchd label for the hub unit. */
export const HUB_LAUNCHD_LABEL = "computer.parachute.hub";
/** systemd unit name for the hub unit. */
export const HUB_SYSTEMD_UNIT_NAME = "parachute-hub.service";

/** Crash-loop ceiling for the hub unit (design §4.1 / §6.3). */
const HUB_CRASH_LOOP: CrashLoopCeiling = {
  intervalSec: 300,
  burst: 5,
  throttleIntervalSec: 10,
};

export interface BuildHubManagedUnitOpts {
  /**
   * The operator's CURRENT `PARACHUTE_HOME`, captured at install time and baked
   * into the unit env — NOT the hard-coded default (design §4.2). Phase 3 passes
   * the real captured home.
   */
  parachuteHome: string;
  /** Hub port (default 1939, the canonical pin). */
  port?: number;
  /** Path to the operator's bun install dir (`$BUN_INSTALL`), e.g. `/home/op/.bun`. */
  bunInstall: string;
  /** PATH the unit should run with (must include bun's global bin). */
  path: string;
  /**
   * Absolute path to the `parachute-hub` `src/cli.ts` entry the unit's
   * `ExecStart`/`ProgramArguments` runs `serve` against (the bun-linked checkout
   * or the installed bin). Caller supplies it — Phase 3 derives it.
   */
  cliPath: string;
  /** Log file the hub's stdout+stderr is written to. */
  logPath: string;
  /** Injectable deps for `which` resolution (defaults to production). */
  deps?: ManagedUnitDeps;
}

/**
 * Build the `ManagedUnit` descriptor for the hub itself (design §4.1).
 *
 * Resolves the absolute `bun` path via the `which` seam (launchd/systemd don't
 * search `$PATH` — mirrors how the connector resolves cloudflared). The env
 * carries `PARACHUTE_BIND_HOST` / `PARACHUTE_HOME` / `PORT` / `PATH` /
 * `BUN_INSTALL` — and INTENTIONALLY OMITS `PARACHUTE_HUB_ORIGIN`: baking a stale
 * origin here would re-create the iss-mismatch class; `resolveStartupIssuer`
 * derives it and start-hub self-heals the operator token + vault `.env` to the
 * current origin (design §4.1 comment).
 *
 * BIND HOST — `PARACHUTE_BIND_HOST=127.0.0.1` is forced here so every
 * self-hosted supervised hub binds loopback. `parachute serve` itself defaults
 * the bind host to `0.0.0.0` (serve.ts), which is correct for the container
 * shape (the platform's HTTP forwarder must reach the hub) but WRONG for a
 * self-hosted box — bare `serve` would expose the admin/OAuth surfaces on every
 * interface, contradicting the pre-supervisor detached behavior and the trust
 * model `layerOf` (hub-server.ts) assumes (header-absent ⇒ "loopback"). The
 * container path never calls this builder (the Dockerfile pins
 * `ENV PARACHUTE_BIND_HOST=0.0.0.0` + runs `serve` directly), so it stays
 * 0.0.0.0. The canonical expose path is unaffected: cloudflared/tailscale dial
 * `127.0.0.1:<port>` from the same host, and the hub's own proxy targets
 * `http://127.0.0.1:<port>` (hub-server.ts). An operator who genuinely wants
 * all-interfaces can override the generated unit; the default is loopback.
 *
 * NOT called by any command in this PR (additive — Phase 3 wires it into `init`).
 */
export function buildHubManagedUnit(opts: BuildHubManagedUnitOpts): ManagedUnit {
  const deps = opts.deps ?? defaultManagedUnitDeps;
  const port = opts.port ?? 1939;
  // launchd/systemd do not search $PATH; resolve bun to an absolute path at build
  // time. Fail loud if it can't be resolved — falling back to the literal "bun"
  // would bake a non-functional ExecStart/ProgramArguments[0] into the unit
  // (cryptic start-time failure), so refuse to build a broken unit. (cliPath is
  // caller-supplied as an absolute path, not which-resolved, so it needs no guard.)
  const bunPath = deps.which("bun");
  if (bunPath === null) {
    throw new Error(
      "cannot build hub unit: 'bun' not found on PATH — install bun or ensure it is resolvable",
    );
  }
  return {
    launchdLabel: HUB_LAUNCHD_LABEL,
    systemdUnitName: HUB_SYSTEMD_UNIT_NAME,
    headerComment: "Generated by parachute — do not edit by hand.",
    systemdDescription: "Parachute hub (serve + supervisor)",
    execStart: [bunPath, opts.cliPath, "serve"],
    env: {
      // Force loopback on every self-hosted supervised hub. serve.ts defaults
      // to 0.0.0.0 (container-first); a self-hosted box must NOT bare-serve
      // all-interfaces. Container path bypasses this builder (Dockerfile pins
      // its own 0.0.0.0). See the docstring for the full trust-model rationale.
      PARACHUTE_BIND_HOST: "127.0.0.1",
      // PARACHUTE_HOME captured at install time (design §4.2) — NOT the default.
      PARACHUTE_HOME: opts.parachuteHome,
      PORT: String(port),
      // PATH + BUN_INSTALL are load-bearing for supervised children that resolve
      // a bun-linked binary on cold boot under a linger-started user unit
      // (design §4.1 / R20). PARACHUTE_HUB_ORIGIN is intentionally OMITTED.
      PATH: opts.path,
      BUN_INSTALL: opts.bunInstall,
    },
    logPath: opts.logPath,
    crashLoop: HUB_CRASH_LOOP,
    runAsInvokingUserOnSystemUnit: true,
  };
}
