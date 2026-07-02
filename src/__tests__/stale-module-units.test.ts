import { describe, expect, test } from "bun:test";
import type { ManagedUnitDeps, ServiceCommandResult } from "../managed-unit.ts";
import {
  disableStaleModuleUnits,
  moduleLaunchdLabel,
  moduleSystemdUnitName,
  targetModuleShorts,
} from "../stale-module-units.ts";

/**
 * #522 — migrate/teardown must DETECT + DISABLE any stale per-module autostart
 * unit (a leftover `parachute-<short>.service` systemd KeepAlive / a
 * `computer.parachute.<short>` launchd KeepAlive) so it stops respawning an
 * unsupervised module that fights the supervised hub for the module's port.
 *
 * ALL tests run against a stubbed `ManagedUnitDeps.run` — NO real
 * systemctl/launchctl. Each fake records the commands it received so we can
 * assert exactly which units were disabled, which were skipped, and that a
 * disable failure / system-level unit is non-fatal.
 */

type RunResponder = (cmd: readonly string[]) => ServiceCommandResult;

function ok(stdout = ""): ServiceCommandResult {
  return { code: 0, stdout, stderr: "" };
}
function fail(stderr = "boom", code = 1): ServiceCommandResult {
  return { code, stdout: "", stderr };
}

function makeDeps(platform: NodeJS.Platform, respond: RunResponder) {
  const calls: string[][] = [];
  const deps: ManagedUnitDeps = {
    platform,
    getuid: () => 501,
    homeDir: () => "/home/op",
    userName: () => "op",
    which: (b) => (b === "systemctl" || b === "launchctl" ? `/usr/bin/${b}` : null),
    run: (cmd) => {
      calls.push([...cmd]);
      return respond(cmd);
    },
    writeFile: () => {},
    removeFile: () => {},
    readFile: () => undefined,
    exists: () => false,
  };
  return { deps, calls };
}

function joined(calls: string[][]): string[] {
  return calls.map((c) => c.join(" "));
}

describe("targetModuleShorts() — known module shorts, never hub/cloudflared", () => {
  test("includes the canonical module shorts and excludes hub", () => {
    const shorts = targetModuleShorts();
    // The canonical knownServices() set: vault / scribe / surface / notes / agent.
    expect(shorts).toContain("vault");
    expect(shorts).toContain("scribe");
    expect(shorts).toContain("surface");
    expect(shorts).toContain("notes");
    // hub is the supervised model itself — never a target.
    expect(shorts).not.toContain("hub");
    expect(shorts).not.toContain("cloudflared");
  });
});

describe("disableStaleModuleUnits — systemd (Linux)", () => {
  test("a stale ENABLED user unit parachute-vault.service is disabled --now + reported", () => {
    const { deps, calls } = makeDeps("linux", (cmd) => {
      const line = cmd.join(" ");
      // Only vault's USER unit reads enabled; everything else is disabled.
      if (line === "systemctl --user is-enabled parachute-vault.service") return ok("enabled\n");
      if (line.startsWith("systemctl --user is-enabled")) return fail("disabled", 1);
      if (line.startsWith("systemctl is-enabled")) return fail("disabled", 1);
      if (line === "systemctl --user disable --now parachute-vault.service") return ok();
      return ok();
    });
    const log: string[] = [];
    const res = disableStaleModuleUnits({ deps, log: (l) => log.push(l) });

    // Exactly one unit acted on: vault, disabled at user scope.
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatchObject({
      short: "vault",
      kind: "systemd-user",
      unit: "parachute-vault.service",
      result: "disabled",
    });
    // The disable --now command was actually invoked.
    expect(joined(calls)).toContain("systemctl --user disable --now parachute-vault.service");
    // The action is reported so the operator sees what changed.
    expect(log.join("\n")).toContain("Disabled stale parachute-vault.service");
    expect(log.join("\n")).toContain("vault's port");
  });

  test("SKIPS the hub unit + cloudflared units — never queried, never disabled", () => {
    const { deps, calls } = makeDeps("linux", () => fail("disabled", 1));
    disableStaleModuleUnits({ deps });
    const lines = joined(calls);
    // The hub unit is never probed or disabled by this sweep.
    expect(lines.some((l) => l.includes("parachute-hub.service"))).toBe(false);
    // No cloudflared connector unit is touched.
    expect(lines.some((l) => l.includes("parachute-cloudflared"))).toBe(false);
    // And no disable command runs at all (everything reads disabled).
    expect(lines.some((l) => l.includes("disable"))).toBe(false);
  });

  test("a non-matching / arbitrary unit is never touched (only parachute-<known-short> is queried)", () => {
    const { deps, calls } = makeDeps("linux", () => fail("disabled", 1));
    disableStaleModuleUnits({ deps });
    const lines = joined(calls);
    // Every is-enabled probe targets a parachute-<known-short>.service and nothing else.
    const probes = lines.filter((l) => l.includes("is-enabled"));
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      const m = probe.match(/is-enabled (parachute-[a-z]+\.service)$/);
      expect(m).not.toBeNull();
      const unit = m?.[1] ?? "";
      // The probed unit must be a known module short, and never the hub/cloudflared.
      expect(targetModuleShorts().map(moduleSystemdUnitName)).toContain(unit);
      expect(unit).not.toBe("parachute-hub.service");
    }
  });

  test("idempotent: every unit already disabled → clean no-op (no disable, no actions)", () => {
    const { deps, calls } = makeDeps("linux", () => fail("disabled", 1));
    const res = disableStaleModuleUnits({ deps });
    expect(res.actions).toHaveLength(0);
    expect(joined(calls).some((l) => l.includes("disable"))).toBe(false);
  });

  test("system-level unit (no --user enabled, system enabled) → WARNS with manual sudo command, doesn't abort, doesn't sudo", () => {
    const { deps, calls } = makeDeps("linux", (cmd) => {
      const line = cmd.join(" ");
      // vault's USER unit is NOT enabled, but the SYSTEM unit IS.
      if (line === "systemctl --user is-enabled parachute-vault.service")
        return fail("disabled", 1);
      if (line === "systemctl is-enabled parachute-vault.service") return ok("enabled\n");
      if (line.startsWith("systemctl --user is-enabled")) return fail("disabled", 1);
      if (line.startsWith("systemctl is-enabled")) return fail("disabled", 1);
      return ok();
    });
    const log: string[] = [];
    const res = disableStaleModuleUnits({ deps, log: (l) => log.push(l) });

    const vaultAction = res.actions.find((a) => a.short === "vault");
    expect(vaultAction).toMatchObject({ kind: "systemd-system", result: "warn-system" });
    const out = log.join("\n");
    // The exact manual command is surfaced.
    expect(out).toContain("sudo systemctl disable --now parachute-vault.service");
    // It NEVER attempted a sudo / system disable itself.
    expect(joined(calls)).not.toContain("systemctl disable --now parachute-vault.service");
    expect(joined(calls).some((l) => l.startsWith("sudo"))).toBe(false);
  });

  test("non-fatal: a disable command that fails → warn + continue (the other units are still swept)", () => {
    const { deps, calls } = makeDeps("linux", (cmd) => {
      const line = cmd.join(" ");
      // Both vault + scribe user units read enabled; vault's disable FAILS.
      if (line === "systemctl --user is-enabled parachute-vault.service") return ok("enabled\n");
      if (line === "systemctl --user is-enabled parachute-scribe.service") return ok("enabled\n");
      if (line.startsWith("systemctl --user is-enabled")) return fail("disabled", 1);
      if (line.startsWith("systemctl is-enabled")) return fail("disabled", 1);
      if (line === "systemctl --user disable --now parachute-vault.service")
        return fail("permission denied");
      if (line === "systemctl --user disable --now parachute-scribe.service") return ok();
      return ok();
    });
    const log: string[] = [];
    const res = disableStaleModuleUnits({ deps, log: (l) => log.push(l) });

    const vault = res.actions.find((a) => a.short === "vault");
    const scribe = res.actions.find((a) => a.short === "scribe");
    // vault's disable failed → warned, not fatal; scribe was still disabled.
    expect(vault?.result).toBe("failed");
    expect(scribe?.result).toBe("disabled");
    // Both disable attempts ran — the failure didn't abort the sweep.
    expect(joined(calls)).toContain("systemctl --user disable --now parachute-vault.service");
    expect(joined(calls)).toContain("systemctl --user disable --now parachute-scribe.service");
    expect(log.join("\n")).toContain("Could not disable");
  });

  test("no systemctl on the box → clean no-op", () => {
    const calls: string[][] = [];
    const deps: ManagedUnitDeps = {
      platform: "linux",
      getuid: () => 501,
      homeDir: () => "/home/op",
      userName: () => "op",
      which: () => null, // no systemctl
      run: (cmd) => {
        calls.push([...cmd]);
        return ok();
      },
      writeFile: () => {},
      removeFile: () => {},
      readFile: () => undefined,
      exists: () => false,
    };
    const res = disableStaleModuleUnits({ deps });
    expect(res.actions).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("disableStaleModuleUnits — launchd (Mac)", () => {
  test("a loaded computer.parachute.vault LaunchAgent is booted out + reported", () => {
    const { deps, calls } = makeDeps("darwin", (cmd) => {
      const line = cmd.join(" ");
      // Only vault's label is loaded (print succeeds with content); others print empty.
      if (line === "launchctl print gui/501/computer.parachute.vault")
        return ok("com.apple...\nstate = running\n");
      if (line.startsWith("launchctl print")) return ok(""); // not loaded
      if (line === "launchctl bootout gui/501/computer.parachute.vault") return ok();
      return ok();
    });
    const log: string[] = [];
    const res = disableStaleModuleUnits({ deps, log: (l) => log.push(l) });

    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatchObject({
      short: "vault",
      kind: "launchd",
      unit: "computer.parachute.vault",
      result: "disabled",
    });
    expect(joined(calls)).toContain("launchctl bootout gui/501/computer.parachute.vault");
    expect(log.join("\n")).toContain("Disabled stale computer.parachute.vault");
  });

  test("SKIPS the hub label + cloudflared labels — never printed, never booted out", () => {
    const { deps, calls } = makeDeps("darwin", () => ok("")); // nothing loaded
    disableStaleModuleUnits({ deps });
    const lines = joined(calls);
    expect(lines.some((l) => l.includes("computer.parachute.hub"))).toBe(false);
    expect(lines.some((l) => l.includes("computer.parachute.cloudflared"))).toBe(false);
    // Every print targets a parachute.<known-short> label.
    const prints = lines.filter((l) => l.startsWith("launchctl print"));
    for (const p of prints) {
      const m = p.match(/computer\.parachute\.([a-z]+)$/);
      expect(m).not.toBeNull();
      expect(targetModuleShorts()).toContain(m?.[1] ?? "");
    }
  });

  test("idempotent: nothing loaded → clean no-op (no bootout, no actions)", () => {
    const { deps, calls } = makeDeps("darwin", () => ok("")); // print returns empty for all
    const res = disableStaleModuleUnits({ deps });
    expect(res.actions).toHaveLength(0);
    expect(joined(calls).some((l) => l.includes("bootout"))).toBe(false);
  });

  test("non-fatal: a bootout that fails → warn + continue", () => {
    const { deps } = makeDeps("darwin", (cmd) => {
      const line = cmd.join(" ");
      if (line === "launchctl print gui/501/computer.parachute.vault")
        return ok("state = running\n");
      if (line.startsWith("launchctl print")) return ok("");
      if (line === "launchctl bootout gui/501/computer.parachute.vault")
        return fail("Operation not permitted");
      return ok();
    });
    const log: string[] = [];
    const res = disableStaleModuleUnits({ deps, log: (l) => log.push(l) });
    expect(res.actions.find((a) => a.short === "vault")?.result).toBe("failed");
    expect(log.join("\n")).toContain("Could not disable the stale LaunchAgent");
  });
});

describe("disableStaleModuleUnits — unsupported platform", () => {
  test("no per-platform manager (e.g. win32) → clean no-op", () => {
    const { deps, calls } = makeDeps("win32", () => ok());
    const res = disableStaleModuleUnits({ deps });
    expect(res.actions).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("unit-name helpers", () => {
  test("moduleSystemdUnitName / moduleLaunchdLabel build the exact per-module names", () => {
    expect(moduleSystemdUnitName("vault")).toBe("parachute-vault.service");
    expect(moduleLaunchdLabel("vault")).toBe("computer.parachute.vault");
  });
});
