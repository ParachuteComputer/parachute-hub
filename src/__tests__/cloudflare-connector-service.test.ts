import { describe, expect, test } from "bun:test";
import {
  type ConnectorServiceDeps,
  type ServiceCommandResult,
  installConnectorService,
  launchdLabel,
  launchdPlistPath,
  removeConnectorService,
  renderLaunchdPlist,
  renderSystemdUnit,
  systemdUnitName,
  systemdUnitPath,
} from "../cloudflare/connector-service.ts";

const TUNNEL = "parachute-vault-example-com";
const CONFIG = "/home/op/.parachute/cloudflared/parachute-vault-example-com/config.yml";
const LOG = "/home/op/.parachute/cloudflared/parachute-vault-example-com/cloudflared.log";
const CF_BIN = "/usr/local/bin/cloudflared";

interface FakeDepsState {
  deps: ConnectorServiceDeps;
  calls: string[][];
  files: Map<string, string>;
}

/**
 * Build a fully-injected dep set. Defaults to a happy macOS/Linux path where
 * `which` resolves both cloudflared and the init tool and every command exits
 * 0. Override per-test via `over`.
 */
function fakeDeps(
  over: Partial<ConnectorServiceDeps> & { runResults?: ServiceCommandResult[] } = {},
): FakeDepsState {
  const calls: string[][] = [];
  const files = new Map<string, string>();
  let runIdx = 0;
  const ok: ServiceCommandResult = { code: 0, stdout: "", stderr: "" };
  const deps: ConnectorServiceDeps = {
    platform: over.platform ?? "darwin",
    getuid: over.getuid ?? (() => 501),
    homeDir: over.homeDir ?? (() => "/home/op"),
    userName: over.userName ?? (() => "op"),
    which:
      over.which ??
      ((b) => {
        if (b === "cloudflared") return CF_BIN;
        if (b === "launchctl" || b === "systemctl" || b === "loginctl") return `/usr/bin/${b}`;
        return null;
      }),
    run:
      over.run ??
      ((cmd) => {
        calls.push([...cmd]);
        const r = over.runResults?.[runIdx++];
        return r ?? ok;
      }),
    writeFile: over.writeFile ?? ((p, c) => void files.set(p, c)),
    removeFile: over.removeFile ?? ((p) => void files.delete(p)),
    readFile: over.readFile ?? ((p) => files.get(p)),
    exists: over.exists ?? ((p) => files.has(p)),
  };
  return { deps, calls, files };
}

describe("renderLaunchdPlist", () => {
  test("produces a valid plist with RunAtLoad + KeepAlive and the absolute argv", () => {
    const plist = renderLaunchdPlist({
      tunnelName: TUNNEL,
      cloudflaredPath: CF_BIN,
      configPath: CONFIG,
      logPath: LOG,
    });
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain(`<string>${launchdLabel(TUNNEL)}</string>`);
    // argv: absolute binary + the same `tunnel --config <path> run` shape the
    // transient spawn used.
    expect(plist).toContain(`<string>${CF_BIN}</string>`);
    expect(plist).toContain("<string>tunnel</string>");
    expect(plist).toContain("<string>--config</string>");
    expect(plist).toContain(`<string>${CONFIG}</string>`);
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain(`<string>${LOG}</string>`);
  });

  test("label + plist path use the reverse-DNS scheme under LaunchAgents", () => {
    expect(launchdLabel(TUNNEL)).toBe(`computer.parachute.cloudflared.${TUNNEL}`);
    expect(launchdPlistPath(TUNNEL, "/home/op")).toBe(
      `/home/op/Library/LaunchAgents/computer.parachute.cloudflared.${TUNNEL}.plist`,
    );
  });
});

describe("renderSystemdUnit", () => {
  test("user unit: WantedBy=default.target, no User=, absolute ExecStart", () => {
    const unit = renderSystemdUnit({
      tunnelName: TUNNEL,
      cloudflaredPath: CF_BIN,
      configPath: CONFIG,
      logPath: LOG,
      root: false,
      userName: "op",
    });
    expect(unit).toContain(`ExecStart=${CF_BIN} tunnel --config ${CONFIG} run`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("User=");
  });

  test("system unit (root): WantedBy=multi-user.target, pins User=", () => {
    const unit = renderSystemdUnit({
      tunnelName: TUNNEL,
      cloudflaredPath: CF_BIN,
      configPath: CONFIG,
      logPath: LOG,
      root: true,
      userName: "op",
    });
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("User=op");
  });

  test("unit name + path differ by scope", () => {
    expect(systemdUnitName(TUNNEL)).toBe(`parachute-cloudflared-${TUNNEL}.service`);
    expect(systemdUnitPath(TUNNEL, "/home/op", false)).toBe(
      `/home/op/.config/systemd/user/parachute-cloudflared-${TUNNEL}.service`,
    );
    expect(systemdUnitPath(TUNNEL, "/home/op", true)).toBe(
      `/etc/systemd/system/parachute-cloudflared-${TUNNEL}.service`,
    );
  });
});

describe("installConnectorService — macOS launchd", () => {
  test("writes the plist + bootstraps it into the per-user GUI domain", () => {
    const f = fakeDeps({ platform: "darwin", getuid: () => 501 });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("installed");
    expect(result.kind).toBe("launchd");
    const plistPath = launchdPlistPath(TUNNEL, "/home/op");
    expect(result.servicePath).toBe(plistPath);
    expect(f.files.get(plistPath)).toContain("<key>RunAtLoad</key>");
    // bootout (idempotent unload) then bootstrap gui/501 <plist>.
    expect(f.calls).toContainEqual(["launchctl", "bootout", `gui/501/${launchdLabel(TUNNEL)}`]);
    expect(f.calls).toContainEqual(["launchctl", "bootstrap", "gui/501", plistPath]);
  });

  test("re-install is idempotent: bootout-then-bootstrap each time", () => {
    const f = fakeDeps({ platform: "darwin" });
    installConnectorService({ tunnelName: TUNNEL, configPath: CONFIG, logPath: LOG, deps: f.deps });
    const firstCount = f.calls.length;
    installConnectorService({ tunnelName: TUNNEL, configPath: CONFIG, logPath: LOG, deps: f.deps });
    // Second install re-runs the same bootout+bootstrap sequence (no crash, no
    // dependence on prior state).
    expect(f.calls.length).toBe(firstCount * 2);
    const bootstraps = f.calls.filter((c) => c[1] === "bootstrap");
    expect(bootstraps.length).toBe(2);
  });

  test("graceful fallback when launchctl is absent", () => {
    const f = fakeDeps({
      platform: "darwin",
      which: (b) => (b === "cloudflared" ? CF_BIN : null),
    });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("fallback");
    expect(result.messages.join(" ")).toContain("launchctl not found");
    // No plist written when the tool is unavailable.
    expect(f.files.size).toBe(0);
  });

  test("graceful fallback (no plist left behind) when bootstrap + legacy load both fail", () => {
    const f = fakeDeps({
      platform: "darwin",
      // bootout(ignored) → bootstrap FAIL → load -w FAIL.
      runResults: [
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" },
        { code: 1, stdout: "", stderr: "nothing found to load" },
      ],
    });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("fallback");
    // The half-written plist is cleaned up so a stale, never-loaded file
    // doesn't linger.
    expect(f.files.size).toBe(0);
    expect(result.messages.join(" ")).toContain("won't survive a reboot");
  });
});

describe("installConnectorService — Linux systemd", () => {
  test("non-root: writes a USER unit, enables linger, enable --now --user", () => {
    const f = fakeDeps({ platform: "linux", getuid: () => 1000, userName: () => "op" });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("installed");
    expect(result.kind).toBe("systemd-user");
    const unitPath = systemdUnitPath(TUNNEL, "/home/op", false);
    expect(result.servicePath).toBe(unitPath);
    expect(f.files.get(unitPath)).toContain("WantedBy=default.target");
    expect(f.files.get(unitPath)).not.toContain("User=");
    // linger + the --user-scoped daemon-reload + enable.
    expect(f.calls).toContainEqual(["loginctl", "enable-linger", "op"]);
    expect(f.calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
    expect(f.calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      systemdUnitName(TUNNEL),
    ]);
  });

  test("root: writes a SYSTEM unit, no --user scope, no linger", () => {
    const f = fakeDeps({ platform: "linux", getuid: () => 0, userName: () => "root" });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("installed");
    expect(result.kind).toBe("systemd-system");
    const unitPath = systemdUnitPath(TUNNEL, "/home/op", true);
    expect(result.servicePath).toBe(unitPath);
    expect(unitPath.startsWith("/etc/systemd/system/")).toBe(true);
    expect(f.files.get(unitPath)).toContain("WantedBy=multi-user.target");
    expect(f.files.get(unitPath)).toContain("User=root");
    // System scope: no `--user` on any systemctl call, and no linger.
    expect(f.calls.some((c) => c.includes("--user"))).toBe(false);
    expect(f.calls.some((c) => c[0] === "loginctl")).toBe(false);
    expect(f.calls).toContainEqual(["systemctl", "daemon-reload"]);
    expect(f.calls).toContainEqual(["systemctl", "enable", "--now", systemdUnitName(TUNNEL)]);
  });

  test("non-root: linger failure is a soft warning, still installs", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      userName: () => "op",
      // #528 probe: show-user → Linger=no (off, so we proceed to enable);
      // then enable-linger FAIL, daemon-reload OK, enable --now OK.
      runResults: [
        { code: 0, stdout: "Linger=no\n", stderr: "" },
        { code: 1, stdout: "", stderr: "Failed to enable linger" },
        { code: 0, stdout: "", stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      ],
    });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("installed");
    expect(result.messages.join(" ")).toContain("could not enable lingering");
    // The warning is actionable — points at the root/system-unit path (EC2 /
    // headless case).
    expect(result.messages.join(" ")).toContain("re-run this command as root");
  });

  test("non-root: systemctl present but loginctl ABSENT → installs, warns, never throws", () => {
    // The real robustness gap: production `Bun.spawnSync(["loginctl",…])`
    // THROWS on ENOENT. With systemctl present but loginctl missing (a
    // container with systemd but no logind), the unguarded linger call would
    // propagate that throw out and hard-fail the whole expose. The `which`
    // probe must skip the call and degrade to a soft warning.
    let lingerRan = false;
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      userName: () => "op",
      which: (b) => {
        if (b === "cloudflared") return CF_BIN;
        if (b === "systemctl") return "/usr/bin/systemctl";
        if (b === "loginctl") return null; // absent
        return null;
      },
      run: (cmd) => {
        if (cmd[0] === "loginctl") lingerRan = true;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("installed");
    expect(result.kind).toBe("systemd-user");
    // loginctl was NOT invoked (the probe short-circuited it).
    expect(lingerRan).toBe(false);
    expect(result.messages.join(" ")).toContain("could not enable lingering");
    expect(result.messages.join(" ")).toContain("re-run this command as root");
  });

  test("non-root: loginctl present but the run THROWS → caught, installs, warns", () => {
    // Belt-and-suspenders for the race where loginctl passes the `which` probe
    // but the spawn itself throws (binary removed between probe and run, or an
    // EACCES). The try/catch keeps it non-fatal.
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      userName: () => "op",
      run: (cmd) => {
        if (cmd[0] === "loginctl") throw new Error("spawn loginctl ENOENT");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("installed");
    expect(result.messages.join(" ")).toContain("could not enable lingering");
  });

  test("graceful fallback when systemctl is absent", () => {
    const f = fakeDeps({
      platform: "linux",
      which: (b) => (b === "cloudflared" ? CF_BIN : null),
    });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("fallback");
    expect(result.messages.join(" ")).toContain("systemctl not found");
    expect(f.files.size).toBe(0);
  });

  test("graceful fallback (unit removed) when enable --now fails", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 0,
      userName: () => "root",
      // daemon-reload OK, enable --now FAIL.
      runResults: [
        { code: 0, stdout: "", stderr: "" },
        { code: 1, stdout: "", stderr: "Failed to enable unit: ..." },
      ],
    });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("fallback");
    // The unit file is removed on failure so a half-installed (written but not
    // enabled) unit doesn't linger.
    expect(f.files.size).toBe(0);
  });
});

describe("installConnectorService — unsupported / missing cloudflared", () => {
  test("fallback when cloudflared can't be resolved", () => {
    const f = fakeDeps({ which: () => null });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("fallback");
    expect(result.messages.join(" ")).toContain("cloudflared binary path");
  });

  test("fallback on an unsupported platform (win32)", () => {
    const f = fakeDeps({ platform: "win32" });
    const result = installConnectorService({
      tunnelName: TUNNEL,
      configPath: CONFIG,
      logPath: LOG,
      deps: f.deps,
    });
    expect(result.outcome).toBe("fallback");
    expect(result.messages.join(" ")).toContain("win32");
  });
});

describe("removeConnectorService", () => {
  test("macOS: boots out + removes the plist", () => {
    const f = fakeDeps({ platform: "darwin", getuid: () => 501 });
    const plistPath = launchdPlistPath(TUNNEL, "/home/op");
    f.files.set(plistPath, "<plist/>");
    const result = removeConnectorService({ tunnelName: TUNNEL, deps: f.deps });
    expect(result.removed).toBe(true);
    expect(f.files.has(plistPath)).toBe(false);
    expect(f.calls).toContainEqual(["launchctl", "bootout", `gui/501/${launchdLabel(TUNNEL)}`]);
  });

  test("Linux non-root: disable --now --user + removes the user unit + daemon-reload", () => {
    const f = fakeDeps({ platform: "linux", getuid: () => 1000 });
    const unitPath = systemdUnitPath(TUNNEL, "/home/op", false);
    f.files.set(unitPath, "[Unit]");
    const result = removeConnectorService({ tunnelName: TUNNEL, deps: f.deps });
    expect(result.removed).toBe(true);
    expect(f.files.has(unitPath)).toBe(false);
    expect(f.calls).toContainEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      systemdUnitName(TUNNEL),
    ]);
    expect(f.calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
  });

  test("no-op (no throw) when no service file exists", () => {
    const f = fakeDeps({ platform: "darwin" });
    const result = removeConnectorService({ tunnelName: TUNNEL, deps: f.deps });
    expect(result.removed).toBe(false);
    // Nothing run — pure no-op so the off-path always succeeds at clearing state.
    expect(f.calls.length).toBe(0);
  });
});
