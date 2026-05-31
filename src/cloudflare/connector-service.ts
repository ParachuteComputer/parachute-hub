import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Reboot-persistent cloudflared connector.
 *
 * Pre-0.6.2 `parachute expose public --cloudflare` spawned the connector as a
 * bare detached background process (`Bun.spawn(...).unref()`), which dies on
 * reboot — the operator had to re-run the expose command every time the box
 * restarted. This module installs a per-tunnel OS service that runs the same
 * `cloudflared tunnel --config <path> run` command on boot, so the connector
 * survives reboots.
 *
 * Platform shapes:
 *   - macOS  → a launchd LaunchAgent plist at
 *     `~/Library/LaunchAgents/computer.parachute.cloudflared.<tunnelName>.plist`
 *     (RunAtLoad + KeepAlive), bootstrapped into the per-user GUI domain. No
 *     sudo: a LaunchAgent runs as the logged-in user.
 *   - Linux (non-root) → a systemd *user* unit at
 *     `~/.config/systemd/user/parachute-cloudflared-<tunnelName>.service`,
 *     `systemctl --user enable --now`, plus a best-effort
 *     `loginctl enable-linger $USER` so the unit runs without an active login.
 *   - Linux (root) → a systemd *system* unit at
 *     `/etc/systemd/system/parachute-cloudflared-<tunnelName>.service`,
 *     `systemctl enable --now`. No linger needed — system units run on boot.
 *
 * Everything is behind an injectable `ConnectorServiceDeps` seam (mirrors the
 * `Runner`/`CloudflaredSpawner`/`KillFn` injection in expose-cloudflare.ts) so
 * tests drive the install/remove without touching real launchctl/systemctl or
 * the operator's home directory.
 *
 * Service name keyed by the same per-host tunnel name the 0.6.1 work derives
 * (`deriveTunnelName`), so install / remove always target the connector for
 * exactly one tunnel and the expose off / legacy-sweep paths can tear it down.
 */

/** Synchronous command result from the injected service runner. */
export interface ServiceCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Injectable side-effect seam for the connector-service module. Production
 * wires the real fs / os / child-process implementations (`defaultServiceDeps`);
 * tests inject fakes to assert generated file content + the install/remove
 * command sequence without a live launchctl/systemctl.
 */
export interface ConnectorServiceDeps {
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

export const defaultServiceDeps: ConnectorServiceDeps = {
  platform: process.platform,
  getuid: () => (typeof process.getuid === "function" ? process.getuid() : undefined),
  homeDir: () => homedir(),
  userName: () => process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? "",
  which: (binary) => Bun.which(binary),
  run: (cmd) => {
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

/** Reverse-DNS prefix for the launchd label + plist filename. */
const LAUNCHD_LABEL_PREFIX = "computer.parachute.cloudflared";
/** systemd unit name prefix. */
const SYSTEMD_UNIT_PREFIX = "parachute-cloudflared-";

/** launchd label for a tunnel (also the plist basename, minus `.plist`). */
export function launchdLabel(tunnelName: string): string {
  return `${LAUNCHD_LABEL_PREFIX}.${tunnelName}`;
}

/** launchd plist path under the user's LaunchAgents dir. */
export function launchdPlistPath(tunnelName: string, home: string): string {
  return join(home, "Library", "LaunchAgents", `${launchdLabel(tunnelName)}.plist`);
}

/** systemd unit name (with `.service` suffix). */
export function systemdUnitName(tunnelName: string): string {
  return `${SYSTEMD_UNIT_PREFIX}${tunnelName}.service`;
}

/** systemd unit path — user-level under $HOME, system-level under /etc. */
export function systemdUnitPath(tunnelName: string, home: string, root: boolean): string {
  return root
    ? join("/etc/systemd/system", systemdUnitName(tunnelName))
    : join(home, ".config", "systemd", "user", systemdUnitName(tunnelName));
}

/** XML-escape a string for safe inclusion in a plist `<string>` element. */
function plistEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the launchd LaunchAgent plist. `RunAtLoad` starts the connector on
 * load (and on login/boot once bootstrapped); `KeepAlive` restarts it if it
 * exits. We pass `cloudflaredPath` (the resolved absolute binary) as argv[0]
 * because launchd does not search `$PATH`. Logs go to the same per-tunnel log
 * file the transient spawn used, so `parachute status`/the operator find them
 * in one place.
 */
export function renderLaunchdPlist(opts: {
  tunnelName: string;
  cloudflaredPath: string;
  configPath: string;
  logPath: string;
}): string {
  const { tunnelName, cloudflaredPath, configPath, logPath } = opts;
  const args = [cloudflaredPath, "tunnel", "--config", configPath, "run"];
  const argXml = args.map((a) => `    <string>${plistEscape(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by parachute expose public --cloudflare — do not edit by hand. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistEscape(launchdLabel(tunnelName))}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${plistEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${plistEscape(logPath)}</string>
</dict>
</plist>
`;
}

/**
 * Render a systemd unit. `Restart=always` mirrors launchd's KeepAlive;
 * `WantedBy` differs by scope (system → multi-user.target; user →
 * default.target). The system unit pins `User=` so the connector doesn't run
 * as root unnecessarily when we know the invoking user. `ExecStart` uses the
 * resolved absolute `cloudflaredPath` (systemd doesn't search a login `$PATH`).
 */
export function renderSystemdUnit(opts: {
  tunnelName: string;
  cloudflaredPath: string;
  configPath: string;
  logPath: string;
  root: boolean;
  userName: string;
}): string {
  const { tunnelName, cloudflaredPath, configPath, root, userName } = opts;
  const execStart = `${cloudflaredPath} tunnel --config ${configPath} run`;
  const userLine = root && userName ? `User=${userName}\n` : "";
  const wantedBy = root ? "multi-user.target" : "default.target";
  return `# Generated by parachute expose public --cloudflare — do not edit by hand.
[Unit]
Description=Parachute Cloudflare connector (${tunnelName})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${userLine}ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=${wantedBy}
`;
}

export interface InstallResult {
  /**
   * "installed" → an OS service now owns the connector (survives reboot).
   * "fallback" → the service tool was unavailable / failed; the caller should
   * fall back to the transient `proc.unref()` spawn (does NOT survive reboot).
   */
  outcome: "installed" | "fallback";
  /** Which init system installed the service (when outcome === "installed"). */
  kind?: "launchd" | "systemd-user" | "systemd-system" | "unsupported";
  /** Path of the written service file (when outcome === "installed"). */
  servicePath?: string;
  /** Human-readable lines for the CLI to print (warnings, hints). */
  messages: string[];
}

export interface ConnectorServiceOpts {
  tunnelName: string;
  configPath: string;
  logPath: string;
  deps?: ConnectorServiceDeps;
}

/**
 * Install (or refresh) the reboot-persistent connector service for one tunnel
 * and start it. Idempotent: re-installing overwrites the service file and
 * re-loads it, so re-`expose` of the same hostname converges on exactly one
 * managed connector.
 *
 * Graceful fallback: if the platform's service tool is missing or any step
 * fails, returns `{ outcome: "fallback", messages }` WITHOUT throwing — the
 * caller then spawns the transient connector and warns it won't survive a
 * reboot. We never hard-fail the expose because the service install didn't take.
 */
export function installConnectorService(opts: ConnectorServiceOpts): InstallResult {
  const deps = opts.deps ?? defaultServiceDeps;
  const cloudflaredPath = deps.which("cloudflared");
  if (!cloudflaredPath) {
    return {
      outcome: "fallback",
      messages: ["Could not resolve the cloudflared binary path; skipping boot-service install."],
    };
  }

  if (deps.platform === "darwin") {
    return installLaunchd({ ...opts, deps, cloudflaredPath });
  }
  if (deps.platform === "linux") {
    return installSystemd({ ...opts, deps, cloudflaredPath });
  }
  return {
    outcome: "fallback",
    messages: [
      `Boot-persistent connector isn't supported on ${deps.platform}; using a transient connector.`,
    ],
  };
}

function installLaunchd(
  opts: ConnectorServiceOpts & { deps: ConnectorServiceDeps; cloudflaredPath: string },
): InstallResult {
  const { deps, tunnelName, configPath, logPath, cloudflaredPath } = opts;
  if (deps.which("launchctl") === null) {
    return {
      outcome: "fallback",
      messages: ["launchctl not found; using a transient connector (won't survive a reboot)."],
    };
  }
  const home = deps.homeDir();
  const plistPath = launchdPlistPath(tunnelName, home);
  const label = launchdLabel(tunnelName);
  const uid = deps.getuid() ?? 0;
  const domain = `gui/${uid}`;

  try {
    deps.writeFile(
      plistPath,
      renderLaunchdPlist({ tunnelName, cloudflaredPath, configPath, logPath }),
    );
  } catch (err) {
    return {
      outcome: "fallback",
      messages: [
        `Failed to write LaunchAgent (${err instanceof Error ? err.message : String(err)}); using a transient connector (won't survive a reboot).`,
      ],
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
    // to the legacy `load -w`, then to a transient connector.
    const legacy = deps.run(["launchctl", "load", "-w", plistPath]);
    if (legacy.code !== 0) {
      deps.removeFile(plistPath);
      return {
        outcome: "fallback",
        messages: [
          `launchctl could not load the connector service (${boot.stderr.trim() || legacy.stderr.trim() || "unknown error"}); using a transient connector (won't survive a reboot).`,
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
    messages: [`Installed launchd LaunchAgent ${label} — the connector now starts on login/boot.`],
  };
}

function installSystemd(
  opts: ConnectorServiceOpts & { deps: ConnectorServiceDeps; cloudflaredPath: string },
): InstallResult {
  const { deps, tunnelName, configPath, logPath, cloudflaredPath } = opts;
  if (deps.which("systemctl") === null) {
    return {
      outcome: "fallback",
      messages: ["systemctl not found; using a transient connector (won't survive a reboot)."],
    };
  }
  const root = (deps.getuid() ?? 1000) === 0;
  const home = deps.homeDir();
  const unitName = systemdUnitName(tunnelName);
  const unitPath = systemdUnitPath(tunnelName, home, root);
  const userName = deps.userName();

  try {
    deps.writeFile(
      unitPath,
      renderSystemdUnit({ tunnelName, cloudflaredPath, configPath, logPath, root, userName }),
    );
  } catch (err) {
    return {
      outcome: "fallback",
      messages: [
        `Failed to write systemd unit (${err instanceof Error ? err.message : String(err)}); using a transient connector (won't survive a reboot).`,
      ],
    };
  }

  const scope = root ? [] : ["--user"];
  const messages: string[] = [];

  // Non-root: enable linger so the user unit runs without an active login
  // (i.e. after a reboot before the operator logs back in). Strictly
  // best-effort — linger may be unavailable: `loginctl` absent entirely (a
  // container with systemd but no logind), or present-but-failing. Either way
  // we keep the install (a user unit is still better than a transient spawn)
  // and warn. The probe + try/catch matter because production `Bun.spawnSync`
  // THROWS on ENOENT — without the guard a box that has systemctl but not
  // loginctl would propagate the spawn error out and hard-fail the expose.
  if (!root && userName) {
    const lingerWarning =
      "Note: could not enable lingering (loginctl enable-linger) — the connector will run while you're logged in but may not start on a cold boot before login. To run on cold boot without an active login, re-run this command as root (installs a system unit that needs no linger).";
    if (deps.which("loginctl") === null) {
      messages.push(lingerWarning);
    } else {
      try {
        const linger = deps.run(["loginctl", "enable-linger", userName]);
        if (linger.code !== 0) messages.push(lingerWarning);
      } catch {
        // loginctl vanished between probe and run, or threw (ENOENT/EACCES) —
        // never fatal; linger is a best-effort nicety.
        messages.push(lingerWarning);
      }
    }
  }

  const reload = deps.run(["systemctl", ...scope, "daemon-reload"]);
  if (reload.code !== 0) {
    deps.removeFile(unitPath);
    return {
      outcome: "fallback",
      messages: [
        `systemctl daemon-reload failed (${reload.stderr.trim() || "unknown error"}); using a transient connector (won't survive a reboot).`,
      ],
    };
  }
  const enable = deps.run(["systemctl", ...scope, "enable", "--now", unitName]);
  if (enable.code !== 0) {
    deps.removeFile(unitPath);
    deps.run(["systemctl", ...scope, "daemon-reload"]);
    return {
      outcome: "fallback",
      messages: [
        `systemctl enable --now failed (${enable.stderr.trim() || "unknown error"}); using a transient connector (won't survive a reboot).`,
      ],
    };
  }

  messages.unshift(
    `Installed systemd ${root ? "system" : "user"} unit ${unitName} — the connector now starts on boot.`,
  );
  return {
    outcome: "installed",
    kind: root ? "systemd-system" : "systemd-user",
    servicePath: unitPath,
    messages,
  };
}

export interface RemoveResult {
  /** True when a service file was found + removed (best-effort tool teardown ran). */
  removed: boolean;
  messages: string[];
}

/**
 * Stop + remove the reboot-persistent connector service for one tunnel.
 * Idempotent + best-effort: a missing service file is a no-op; tool failures
 * never throw (the expose-off path must always succeed at clearing state even
 * if the OS service tool hiccups). Mirrors `installConnectorService`'s seam.
 *
 * Called by `exposeCloudflareOff` (and the legacy-tunnel sweep) so tearing down
 * a tunnel also tears down its boot service — otherwise the service would
 * resurrect a dead connector on the next reboot.
 */
export function removeConnectorService(opts: {
  tunnelName: string;
  deps?: ConnectorServiceDeps;
}): RemoveResult {
  const deps = opts.deps ?? defaultServiceDeps;
  const { tunnelName } = opts;

  if (deps.platform === "darwin") {
    const home = deps.homeDir();
    const plistPath = launchdPlistPath(tunnelName, home);
    if (!deps.exists(plistPath)) return { removed: false, messages: [] };
    const uid = deps.getuid() ?? 0;
    const label = launchdLabel(tunnelName);
    // bootout unloads + stops; ignore its exit (nothing-loaded is fine).
    deps.run(["launchctl", "bootout", `gui/${uid}/${label}`]);
    deps.removeFile(plistPath);
    return {
      removed: true,
      messages: [`Removed launchd LaunchAgent ${label}.`],
    };
  }

  if (deps.platform === "linux") {
    const root = (deps.getuid() ?? 1000) === 0;
    const home = deps.homeDir();
    const unitName = systemdUnitName(tunnelName);
    const unitPath = systemdUnitPath(tunnelName, home, root);
    if (!deps.exists(unitPath)) return { removed: false, messages: [] };
    const scope = root ? [] : ["--user"];
    // disable --now stops + removes the enable symlink; ignore exit (best-effort).
    deps.run(["systemctl", ...scope, "disable", "--now", unitName]);
    deps.removeFile(unitPath);
    deps.run(["systemctl", ...scope, "daemon-reload"]);
    return {
      removed: true,
      messages: [`Removed systemd unit ${unitName}.`],
    };
  }

  return { removed: false, messages: [] };
}
