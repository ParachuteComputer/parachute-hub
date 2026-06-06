import { describe, expect, test } from "bun:test";
import {
  type HubUnitDeps,
  NO_MANAGER_MESSAGE,
  NO_UNIT_MESSAGE,
  ensureHubUnit,
  ensureHubVersionMatches,
  installAndStartHubUnit,
  queryHubUnitState,
  restartHubUnit,
  stopHubUnit,
} from "../hub-unit.ts";
import {
  HUB_LAUNCHD_LABEL,
  HUB_SYSTEMD_UNIT_NAME,
  type ServiceCommandResult,
  launchdPlistPathForLabel,
  systemdUnitPathForName,
} from "../managed-unit.ts";

// Use the SHARED exported unit identifiers (not local re-declarations) so the
// assertions can't silently pass if the canonical label/unit name ever drifts.
const HUB_LABEL = HUB_LAUNCHD_LABEL;
const HUB_UNIT = HUB_SYSTEMD_UNIT_NAME;

interface FakeState {
  deps: HubUnitDeps;
  calls: string[][];
  files: Map<string, string>;
}

/**
 * Build a fully-stubbed {@link HubUnitDeps}. No launchctl/systemctl/socket/HTTP
 * call touches the real OS — every side effect is recorded in `calls` / `files`.
 * `probeHealth` / `portListening` accept arrays so a test can script the
 * "down at first, up after start" readiness sequence.
 */
function fakeDeps(
  over: Partial<HubUnitDeps> & {
    runResults?: ServiceCommandResult[];
    healthSeq?: boolean[];
    /**
     * #590: scripted version-aware /health probe results. Each element is
     * `null` (hub not answering) or `{ ok, version }`. Drives
     * `probeHealthVersion` across the version-check + post-restart re-probe.
     */
    healthVersionSeq?: ({ ok: boolean; version?: string; db?: string } | null)[];
    listeningSeq?: boolean[];
    installedUnit?: boolean;
  } = {},
): FakeState {
  const calls: string[][] = [];
  const files = new Map<string, string>();
  let runIdx = 0;
  let healthIdx = 0;
  let healthVersionIdx = 0;
  let listeningIdx = 0;
  const ok: ServiceCommandResult = { code: 0, stdout: "", stderr: "" };

  const platform: NodeJS.Platform = over.platform ?? "linux";
  const getuid = over.getuid ?? (() => 1000);
  const homeDir = over.homeDir ?? (() => "/home/op");

  // Optionally seed the unit file so isHubUnitInstalled() sees it.
  if (over.installedUnit) {
    const home = homeDir();
    if (platform === "darwin") {
      files.set(launchdPlistPathForLabel(HUB_LABEL, home), "<plist/>");
    } else {
      const root = (getuid() ?? 1000) === 0;
      files.set(systemdUnitPathForName(HUB_UNIT, home, root), "[Unit]");
    }
  }

  const deps: HubUnitDeps = {
    platform,
    getuid,
    homeDir,
    userName: over.userName ?? (() => "op"),
    which:
      over.which ??
      ((b) => {
        if (b === "bun") return "/home/op/.bun/bin/bun";
        if (b === "launchctl" || b === "systemctl" || b === "loginctl" || b === "journalctl") {
          return `/usr/bin/${b}`;
        }
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
    probeHealth:
      over.probeHealth ??
      (async () => {
        const seq = over.healthSeq;
        if (!seq) return false;
        return seq[Math.min(healthIdx++, seq.length - 1)] ?? false;
      }),
    probeHealthVersion:
      over.probeHealthVersion ??
      (async () => {
        const seq = over.healthVersionSeq;
        if (!seq) return null;
        return seq[Math.min(healthVersionIdx++, seq.length - 1)] ?? null;
      }),
    portListening:
      over.portListening ??
      (async () => {
        const seq = over.listeningSeq;
        if (!seq) return true;
        return seq[Math.min(listeningIdx++, seq.length - 1)] ?? false;
      }),
    sleep: over.sleep ?? (async () => {}),
  };
  return { deps, calls, files };
}

describe("ensureHubUnit — §3.2 algorithm", () => {
  test("hub already up: /health 200 → returns already-up, NO manager call", async () => {
    const f = fakeDeps({ healthSeq: [true] });
    const res = await ensureHubUnit({ port: 1939, deps: f.deps, readyPollMs: 0 });
    expect(res.outcome).toBe("already-up");
    expect(res.port).toBe(1939);
    // No systemctl/launchctl invocation at all — the probe short-circuited.
    expect(f.calls).toEqual([]);
  });

  test("hub down, unit present (systemd user): starts the unit + readiness poll succeeds", async () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      healthSeq: [false],
      listeningSeq: [true],
    });
    const res = await ensureHubUnit({ port: 1939, deps: f.deps, readyPollMs: 0 });
    expect(res.outcome).toBe("started");
    // systemctl --user start parachute-hub.service was driven.
    expect(f.calls).toContainEqual(["systemctl", "--user", "start", "parachute-hub.service"]);
  });

  test("hub down, unit present (systemd root): no --user scope", async () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 0,
      userName: () => "root",
      installedUnit: true,
      healthSeq: [false],
      listeningSeq: [true],
    });
    const res = await ensureHubUnit({ port: 1939, deps: f.deps, readyPollMs: 0 });
    expect(res.outcome).toBe("started");
    expect(f.calls).toContainEqual(["systemctl", "start", "parachute-hub.service"]);
  });

  test("hub down, unit present (launchd): kickstart -k gui/<uid>/<label>", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      healthSeq: [false],
      listeningSeq: [true],
    });
    const res = await ensureHubUnit({ port: 1939, deps: f.deps, readyPollMs: 0 });
    expect(res.outcome).toBe("started");
    expect(f.calls).toContainEqual([
      "launchctl",
      "kickstart",
      "-k",
      "gui/501/computer.parachute.hub",
    ]);
  });

  test("no unit installed → actionable 'run parachute migrate' error, no manager call", async () => {
    const f = fakeDeps({
      platform: "linux",
      installedUnit: false,
      healthSeq: [false],
    });
    const res = await ensureHubUnit({ port: 1939, deps: f.deps, readyPollMs: 0 });
    expect(res.outcome).toBe("no-unit");
    expect(res.messages).toContain(NO_UNIT_MESSAGE);
    // Did NOT try to start anything.
    expect(f.calls).toEqual([]);
  });

  test("no manager at all (linux, no systemctl) → actionable foreground-serve message", async () => {
    const f = fakeDeps({
      platform: "linux",
      installedUnit: true, // even with a unit file, no systemctl = no manager
      healthSeq: [false],
      which: () => null, // nothing resolvable
    });
    const res = await ensureHubUnit({ port: 1939, deps: f.deps, readyPollMs: 0 });
    expect(res.outcome).toBe("no-manager");
    expect(res.messages).toContain(NO_MANAGER_MESSAGE);
    expect(f.calls).toEqual([]);
  });

  test("readiness timeout: surfaces the unit log (journald), does not hang", async () => {
    const journalLog = "May 31 hub: boot failed: corrupt hub.db";
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      healthSeq: [false],
      listeningSeq: [false], // never binds
      run: (cmd) => {
        // journalctl tail returns the boot error; start returns ok.
        if (cmd[0] === "journalctl") {
          return { code: 0, stdout: journalLog, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const res = await ensureHubUnit({
      port: 1939,
      deps: f.deps,
      readyTimeoutMs: 0, // immediate deadline → one poll then timeout
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("timeout");
    const joined = res.messages.join("\n");
    expect(joined).toContain("did not become ready");
    expect(joined).toContain(journalLog);
  });

  test("manager start command fails → start-failed with stderr surfaced", async () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      healthSeq: [false],
      run: (cmd) => {
        if (cmd.includes("start")) {
          return { code: 1, stdout: "", stderr: "Unit parachute-hub.service not found." };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const res = await ensureHubUnit({ port: 1939, deps: f.deps, readyPollMs: 0 });
    expect(res.outcome).toBe("start-failed");
    expect(res.messages.join("\n")).toContain("Unit parachute-hub.service not found.");
  });
});

describe("installAndStartHubUnit — init bringup (§3.3 / §4.2)", () => {
  test("installs the hub unit (start:true) + waits readiness → started", async () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      listeningSeq: [true],
    });
    const res = await installAndStartHubUnit({
      parachuteHome: "/home/op/.parachute",
      cliPath: "/home/op/parachute-hub/src/cli.ts",
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("started");
    expect(res.install.outcome).toBe("installed");
    // The systemd unit file was written, carrying the captured PARACHUTE_HOME
    // and the serve ExecStart.
    const unitPath = systemdUnitPathForName(HUB_UNIT, "/home/op", false);
    const written = f.files.get(unitPath);
    expect(written).toBeDefined();
    expect(written).toContain("Environment=PARACHUTE_HOME=/home/op/.parachute");
    expect(written).toContain("src/cli.ts serve");
    // The default unit PATH is enriched with operator-tool dirs so the managed
    // hub + its supervised children can find scribe's parakeet-mlx / ffmpeg
    // (hub launchd-PATH regression). $HOME/.local/bin is the Linux operator dir.
    expect(written).toContain("/home/op/.bun/bin:/usr/local/bin:/usr/bin:/bin:/home/op/.local/bin");
    // enable --now drove the start.
    expect(f.calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      "parachute-hub.service",
    ]);
  });

  test("launchd default on Mac (D2): writes the LaunchAgent plist + bootstraps", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      homeDir: () => "/Users/op",
      listeningSeq: [true],
    });
    const res = await installAndStartHubUnit({
      parachuteHome: "/Users/op/.parachute",
      cliPath: "/Users/op/parachute-hub/src/cli.ts",
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("started");
    const plistPath = launchdPlistPathForLabel(HUB_LABEL, "/Users/op");
    const plist = f.files.get(plistPath);
    expect(plist).toBeDefined();
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("computer.parachute.hub");
  });

  test("captures a NON-default PARACHUTE_HOME (§4.2)", async () => {
    const f = fakeDeps({ platform: "linux", getuid: () => 1000, listeningSeq: [true] });
    await installAndStartHubUnit({
      parachuteHome: "/custom/home/.parachute",
      cliPath: "/home/op/parachute-hub/src/cli.ts",
      deps: f.deps,
      readyPollMs: 0,
    });
    const unitPath = systemdUnitPathForName(HUB_UNIT, "/home/op", false);
    expect(f.files.get(unitPath)).toContain("Environment=PARACHUTE_HOME=/custom/home/.parachute");
  });

  test("no service manager → no-manager outcome, NOTHING installed or spawned", async () => {
    const f = fakeDeps({
      platform: "linux",
      which: () => null, // no systemctl
      listeningSeq: [true],
    });
    const res = await installAndStartHubUnit({
      parachuteHome: "/home/op/.parachute",
      cliPath: "/home/op/parachute-hub/src/cli.ts",
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("no-manager");
    expect(res.messages).toContain(NO_MANAGER_MESSAGE);
    // No unit file written, no command run.
    expect(f.files.size).toBe(0);
    expect(f.calls).toEqual([]);
  });

  test("install succeeds but hub never binds → timeout with the unit log", async () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      listeningSeq: [false], // never binds
      run: (cmd) => {
        if (cmd[0] === "journalctl") {
          return { code: 0, stdout: "hub: EADDRINUSE 1939", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const res = await installAndStartHubUnit({
      parachuteHome: "/home/op/.parachute",
      cliPath: "/home/op/parachute-hub/src/cli.ts",
      deps: f.deps,
      readyTimeoutMs: 0,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("timeout");
    expect(res.messages.join("\n")).toContain("EADDRINUSE");
  });
});

describe("stopHubUnit — manager-only hub stop (§3.3, R17)", () => {
  test("systemd user: `systemctl --user stop` (NEVER a PID signal)", () => {
    const f = fakeDeps({ platform: "linux", getuid: () => 1000, installedUnit: true });
    const res = stopHubUnit(f.deps);
    expect(res.outcome).toBe("ok");
    expect(f.calls).toEqual([["systemctl", "--user", "stop", HUB_UNIT]]);
    // No `kill`-shaped call — the manager is the only thing driven.
    expect(f.calls.flat()).not.toContain("kill");
  });

  test("systemd root: `systemctl stop` (no --user scope)", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 0,
      userName: () => "root",
      installedUnit: true,
    });
    const res = stopHubUnit(f.deps);
    expect(res.outcome).toBe("ok");
    expect(f.calls).toEqual([["systemctl", "stop", HUB_UNIT]]);
  });

  test("launchd: `launchctl bootout gui/<uid>/<label>` (KeepAlive can't resurrect)", () => {
    const f = fakeDeps({ platform: "darwin", getuid: () => 501, installedUnit: true });
    const res = stopHubUnit(f.deps);
    expect(res.outcome).toBe("ok");
    expect(f.calls).toEqual([["launchctl", "bootout", `gui/501/${HUB_LABEL}`]]);
    // Specifically NOT `launchctl kill` / a PID signal.
    expect(f.calls.flat()).not.toContain("kill");
  });

  test("no unit installed → no-unit, no manager call", () => {
    const f = fakeDeps({ platform: "linux", getuid: () => 1000 /* installedUnit: false */ });
    const res = stopHubUnit(f.deps);
    expect(res.outcome).toBe("no-unit");
    expect(res.messages).toEqual([NO_UNIT_MESSAGE]);
    expect(f.calls).toEqual([]);
  });

  test("no service manager → no-manager", () => {
    const f = fakeDeps({ platform: "linux", which: () => null, installedUnit: true });
    const res = stopHubUnit(f.deps);
    expect(res.outcome).toBe("no-manager");
    expect(res.messages).toEqual([NO_MANAGER_MESSAGE]);
  });

  test("manager rejects the command → failed, carries stderr", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      runResults: [{ code: 1, stdout: "", stderr: "unit not loaded" }],
    });
    const res = stopHubUnit(f.deps);
    expect(res.outcome).toBe("failed");
    expect(res.messages.join("\n")).toContain("unit not loaded");
  });
});

describe("restartHubUnit — manager-only hub restart (§3.3, R17)", () => {
  test("systemd user: `systemctl --user restart` (NEVER a PID signal)", () => {
    const f = fakeDeps({ platform: "linux", getuid: () => 1000, installedUnit: true });
    const res = restartHubUnit(f.deps);
    expect(res.outcome).toBe("ok");
    expect(f.calls).toEqual([["systemctl", "--user", "restart", HUB_UNIT]]);
    expect(f.calls.flat()).not.toContain("kill");
  });

  test("launchd: `launchctl kickstart -k gui/<uid>/<label>`", () => {
    const f = fakeDeps({ platform: "darwin", getuid: () => 501, installedUnit: true });
    const res = restartHubUnit(f.deps);
    expect(res.outcome).toBe("ok");
    expect(f.calls).toEqual([["launchctl", "kickstart", "-k", `gui/501/${HUB_LABEL}`]]);
    expect(f.calls.flat()).not.toContain("kill");
  });

  test("no unit installed → no-unit", () => {
    const f = fakeDeps({ platform: "linux", getuid: () => 1000 });
    const res = restartHubUnit(f.deps);
    expect(res.outcome).toBe("no-unit");
    expect(f.calls).toEqual([]);
  });

  test("manager rejects → failed, carries stderr", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      runResults: [{ code: 1, stdout: "", stderr: "job failed" }],
    });
    const res = restartHubUnit(f.deps);
    expect(res.outcome).toBe("failed");
    expect(res.messages.join("\n")).toContain("job failed");
  });
});

describe("queryHubUnitState — §6.4 hub-row manager query", () => {
  test("no service manager → no-manager (nothing to query)", () => {
    const f = fakeDeps({ platform: "linux", which: () => null });
    expect(queryHubUnitState(f.deps).state).toBe("no-manager");
  });

  test("manager present but no unit installed → no-unit", () => {
    const f = fakeDeps({ platform: "linux", installedUnit: false });
    expect(queryHubUnitState(f.deps).state).toBe("no-unit");
  });

  test("systemd is-active → active", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      runResults: [{ code: 0, stdout: "active\n", stderr: "" }],
    });
    const r = queryHubUnitState(f.deps);
    expect(r.state).toBe("active");
    // user-scope is-active was driven.
    expect(f.calls).toContainEqual(["systemctl", "--user", "is-active", HUB_UNIT]);
  });

  test("systemd is-active → failed (nonzero exit, stdout token classified)", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      // is-active exits 3 for a failed unit; the state word is on stdout.
      runResults: [{ code: 3, stdout: "failed\n", stderr: "" }],
    });
    expect(queryHubUnitState(f.deps).state).toBe("failed");
  });

  test("systemd is-active → inactive", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      runResults: [{ code: 3, stdout: "inactive\n", stderr: "" }],
    });
    expect(queryHubUnitState(f.deps).state).toBe("inactive");
  });

  test("systemd is-active → activating maps to activating", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      runResults: [{ code: 3, stdout: "activating\n", stderr: "" }],
    });
    expect(queryHubUnitState(f.deps).state).toBe("activating");
  });

  test("systemd root scope → no --user", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 0,
      userName: () => "root",
      installedUnit: true,
      runResults: [{ code: 0, stdout: "active\n", stderr: "" }],
    });
    queryHubUnitState(f.deps);
    expect(f.calls).toContainEqual(["systemctl", "is-active", HUB_UNIT]);
  });

  test("launchd print: state = running → active (+ last exit code parsed)", () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      runResults: [
        {
          code: 0,
          stdout:
            "computer.parachute.hub = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}",
          stderr: "",
        },
      ],
    });
    const r = queryHubUnitState(f.deps);
    expect(r.state).toBe("active");
    expect(r.lastExitCode).toBe(0);
    expect(f.calls).toContainEqual(["launchctl", "print", "gui/501/computer.parachute.hub"]);
  });

  test("launchd print: not running + nonzero last exit code → failed", () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      runResults: [
        {
          code: 0,
          stdout: "computer.parachute.hub = {\n\tstate = not running\n\tlast exit code = 78\n}",
          stderr: "",
        },
      ],
    });
    const r = queryHubUnitState(f.deps);
    expect(r.state).toBe("failed");
    expect(r.lastExitCode).toBe(78);
  });

  test("launchd print: label not loaded (empty stdout) → inactive, never throws", () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      runResults: [{ code: 1, stdout: "", stderr: "Could not find service" }],
    });
    expect(queryHubUnitState(f.deps).state).toBe("inactive");
  });

  test("a thrown manager run never escapes — degrades to unknown", () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      run: () => {
        throw new Error("spawn EPERM");
      },
    });
    const r = queryHubUnitState(f.deps);
    expect(r.state).toBe("unknown");
    expect(r.detail).toContain("spawn EPERM");
  });
});

describe("ensureHubVersionMatches — version-check-and-restart at adoption (#590)", () => {
  const INSTALLED = "0.6.4-rc.9";

  test("versions match → no-op, NO restart, NO manager call", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      healthVersionSeq: [{ ok: true, version: INSTALLED }],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("match");
    expect(res.runningVersion).toBe(INSTALLED);
    // No launchctl/systemctl call at all — the version agreed.
    expect(f.calls).toEqual([]);
  });

  test("mismatch + unit-managed → restarts ONCE + re-probe shows new version → restarted", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      // first probe: stale zombie; after the restart the re-probe sees the new code.
      healthVersionSeq: [
        { ok: true, version: "0.5.14-rc.4" },
        { ok: true, version: INSTALLED },
      ],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("restarted");
    // Exactly ONE restart (launchctl kickstart -k) was issued.
    const restarts = f.calls.filter((c) => c.includes("kickstart"));
    expect(restarts).toHaveLength(1);
    expect(restarts[0]).toEqual(["launchctl", "kickstart", "-k", "gui/501/computer.parachute.hub"]);
  });

  test("/health has NO version field (very old hub) → treated as mismatch → restart", async () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      healthVersionSeq: [{ ok: true /* no version */ }, { ok: true, version: INSTALLED }],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("restarted");
    expect(f.calls).toContainEqual(["systemctl", "--user", "restart", "parachute-hub.service"]);
  });

  test("mismatch but NOT unit-managed (no unit installed) → not-unit-managed, NO kill, actionable message", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: false, // a detached legacy pid / dev `bun run serve`
      healthVersionSeq: [{ ok: true, version: "0.5.14-rc.4" }],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("not-unit-managed");
    // Did NOT issue any manager command — we never blindly kill a hub we don't own.
    expect(f.calls).toEqual([]);
    const joined = res.messages.join("\n");
    expect(joined).toContain("NOT managed by a Parachute service unit");
    expect(joined).toContain("0.5.14-rc.4");
    expect(joined).toContain(INSTALLED);
  });

  test("mismatch but no service manager at all → not-unit-managed (don't kill)", async () => {
    const f = fakeDeps({
      platform: "linux",
      installedUnit: true,
      which: () => null, // no systemctl → no manager
      healthVersionSeq: [{ ok: true, version: "0.5.14-rc.4" }],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("not-unit-managed");
    expect(f.calls).toEqual([]);
  });

  test("restart-loop guard: still mismatched after the single restart → still-mismatched, restarts ONCE", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      // bun-linked branch checkout: the restart comes back STILL on the old
      // version (package.json trails). Every probe returns the stale version.
      healthVersionSeq: [{ ok: true, version: "0.5.14-rc.4" }],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyTimeoutMs: 0, // immediate deadline → one re-probe then settle
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("still-mismatched");
    // Restarted AT MOST once — no loop.
    const restarts = f.calls.filter((c) => c.includes("kickstart"));
    expect(restarts).toHaveLength(1);
    expect(res.messages.join("\n")).toContain("still not reporting");
  });

  test("hub not answering /health at all → not-running (no-op, no restart)", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      healthVersionSeq: [null], // connection refused / timeout
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("not-running");
    expect(f.calls).toEqual([]);
  });

  test("mismatch + unit-managed but the restart command fails → restart-failed", async () => {
    const f = fakeDeps({
      platform: "linux",
      getuid: () => 1000,
      installedUnit: true,
      healthVersionSeq: [{ ok: true, version: "0.5.14-rc.4" }],
      run: (cmd) => {
        if (cmd.includes("restart")) {
          return { code: 1, stdout: "", stderr: "Unit parachute-hub.service not found." };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("restart-failed");
    expect(res.messages.join("\n")).toContain("Unit parachute-hub.service not found.");
  });

  // #594: a hub whose VERSION matches but whose /health reports a db fault
  // (dead handle — state dir deleted under it) must be treated as needing a
  // restart, through the same restart-once machinery.
  test("version matches but /health reports db fault → restart-once → restarted when db heals", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      // first probe: right version but dead DB handle; after the restart the
      // re-probe sees a live DB.
      healthVersionSeq: [
        { ok: true, version: INSTALLED, db: "error: fatal" },
        { ok: true, version: INSTALLED, db: "ok" },
      ],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("restarted");
    const restarts = f.calls.filter((c) => c.includes("kickstart"));
    expect(restarts).toHaveLength(1);
  });

  test("version + db both ok → match, NO restart (#594 doesn't fire on a healthy hub)", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      healthVersionSeq: [{ ok: true, version: INSTALLED, db: "ok" }],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("match");
    expect(f.calls).toEqual([]);
  });

  test("db fault persists after the restart → still-mismatched with a db-specific message (#594)", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      // Every probe reports the dead handle (state dir still gone). Restart
      // once, then settle — no loop.
      healthVersionSeq: [{ ok: true, version: INSTALLED, db: "error: fatal" }],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyTimeoutMs: 0,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("still-mismatched");
    const restarts = f.calls.filter((c) => c.includes("kickstart"));
    expect(restarts).toHaveLength(1);
    expect(res.messages.join("\n")).toContain("database still reports a fault");
  });

  test("a hub with NO db field (pre-#594) on a version match → match, not treated as a fault", async () => {
    const f = fakeDeps({
      platform: "darwin",
      getuid: () => 501,
      installedUnit: true,
      healthVersionSeq: [{ ok: true, version: INSTALLED /* no db field */ }],
    });
    const res = await ensureHubVersionMatches({
      installedVersion: INSTALLED,
      port: 1939,
      deps: f.deps,
      readyPollMs: 0,
    });
    expect(res.outcome).toBe("match");
    expect(f.calls).toEqual([]);
  });
});
