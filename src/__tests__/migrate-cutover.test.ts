import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CutoverDeps,
  type WriteUnitResult,
  cutoverToSupervised,
  teardownHubUnit,
} from "../commands/migrate-cutover.ts";
import type { HubUnitDeps, InstallAndStartHubUnitResult } from "../hub-unit.ts";
import type { ManagedUnitRemoveResult } from "../managed-unit.ts";
import { writePid } from "../process-state.ts";

/**
 * ALL destructive-path tests run in a FRESH sandbox `PARACHUTE_HOME` with stubbed
 * seams — NO real Bun.spawn / systemctl / launchctl / lsof / process kills, NO
 * touching the operator's `~/.parachute`. The sandbox dir is only used to seed
 * services.json + pidfiles (real `writePid`) so the detector + per-module stop
 * read genuine on-disk state; everything that would touch a live process is a
 * fake.
 */
interface Harness {
  configDir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-cutover-"));
  return {
    configDir: dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedManifest(manifestPath: string, services: Array<{ name: string; port: number }>): void {
  const full = services.map((s) => ({
    name: s.name,
    port: s.port,
    paths: [`/${s.name}`],
    health: "/health",
    version: "1.0.0",
  }));
  Bun.write(manifestPath, JSON.stringify({ services: full }));
}

/** A trace-recording set of cutover deps, with sane defaults for the happy path. */
interface FakeCutover {
  deps: Partial<CutoverDeps>;
  trace: string[];
  hubUnitDeps: HubUnitDeps;
}

function fakeHubUnitDeps(): HubUnitDeps {
  return {
    platform: "linux",
    getuid: () => 1000,
    homeDir: () => "/home/op",
    userName: () => "op",
    which: (b) => (b === "bun" ? "/home/op/.bun/bin/bun" : `/usr/bin/${b}`),
    run: () => ({ code: 0, stdout: "", stderr: "" }),
    writeFile: () => {},
    removeFile: () => {},
    readFile: () => undefined,
    exists: () => false,
    probeHealth: async () => false,
    portListening: async () => false,
    sleep: async () => {},
  };
}

function makeFakeCutover(over: Partial<CutoverDeps> = {}): FakeCutover {
  const trace: string[] = [];
  const hubUnitDeps = fakeHubUnitDeps();
  // Mutable "world" the fakes read so we can model state transitions (a port
  // that frees after the stop, a unit that becomes installed after a write).
  const world = {
    unitInstalled: false,
    hubHealthy: false,
    /** Ports currently "listening" (held). The verify-free step polls this. */
    listening: new Set<number>(),
    /** Ports an orphan (lsof) reports a pid on. */
    orphanPorts: new Map<number, number>(),
    alivePids: new Set<number>(),
  };
  const deps: Partial<CutoverDeps> = {
    hubUnitDeps,
    alive: (pid) => world.alivePids.has(pid),
    kill: (pid, signal) => {
      trace.push(`kill ${pid} ${signal}`);
      // SIGKILL / SIGTERM removes the process from the world.
      world.alivePids.delete(pid);
    },
    pidOnPort: (port) => world.orphanPorts.get(port),
    portListening: async (port) => world.listening.has(port),
    stopHub: async () => {
      trace.push("stopHub");
      world.listening.delete(1939);
      return true;
    },
    isHubUnitInstalled: () => world.unitInstalled,
    probeHealth: async () => world.hubHealthy,
    sleep: async () => {},
    writeUnitWithoutStarting: (): WriteUnitResult => {
      trace.push("writeUnit");
      world.unitInstalled = true;
      return { written: true, outcome: "installed", messages: ["wrote unit (not started)"] };
    },
    installAndStartHubUnit: async (): Promise<InstallAndStartHubUnitResult> => {
      trace.push("startUnit");
      world.hubHealthy = true;
      return {
        outcome: "started",
        port: 1939,
        install: { outcome: "installed", kind: "systemd-user", messages: [] },
        messages: ["started unit"],
      };
    },
    ...over,
  };
  // Expose the world via closure for tests that want to manipulate it.
  (deps as { _world?: typeof world })._world = world;
  return { deps, trace, hubUnitDeps };
}

function getWorld(deps: Partial<CutoverDeps>): {
  unitInstalled: boolean;
  hubHealthy: boolean;
  listening: Set<number>;
  orphanPorts: Map<number, number>;
  alivePids: Set<number>;
} {
  const w = (deps as { _world?: ReturnType<typeof Object> })._world;
  if (!w) throw new Error("no world");
  return w as ReturnType<typeof getWorld>;
}

describe("cutoverToSupervised — happy path (§7.1)", () => {
  test("detached box with running hub + modules migrates end-to-end", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, [{ name: "vault", port: 1940 }]);
      const fc = makeFakeCutover();
      const w = getWorld(fc.deps);
      // The detached hub + vault are alive + bound to their ports. vault is
      // tracked by a real pidfile (pid 5555); stopping it frees port 1940.
      w.listening.add(1939);
      w.listening.add(1940);
      w.alivePids.add(5555);
      writePid("vault", 5555, h.configDir);
      const baseKill = fc.deps.kill;
      fc.deps.kill = (pid, signal) => {
        baseKill?.(pid, signal);
        if (pid === 5555) getWorld(fc.deps).listening.delete(1940);
      };
      const log: string[] = [];
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: (l) => log.push(l),
        pollMs: 0,
      });
      expect(result.outcome).toBe("migrated");
      // ORDERING: write the unit BEFORE stopping detached, verify ports free
      // BEFORE starting the unit, start AFTER stop. The trace proves the order.
      const writeIdx = fc.trace.indexOf("writeUnit");
      const stopIdx = fc.trace.indexOf("stopHub");
      const startIdx = fc.trace.indexOf("startUnit");
      expect(writeIdx).toBeGreaterThanOrEqual(0);
      expect(writeIdx).toBeLessThan(stopIdx); // unit written before stop
      expect(stopIdx).toBeLessThan(startIdx); // detached stopped before unit start
      // The hub is now supervised + healthy.
      expect(getWorld(fc.deps).hubHealthy).toBe(true);
      expect(getWorld(fc.deps).unitInstalled).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("verify-ports-free runs before start (start never races a held port)", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, [{ name: "vault", port: 1940 }]);
      const fc = makeFakeCutover();
      const w = getWorld(fc.deps);
      w.listening.add(1939);
      w.listening.add(1940);
      w.alivePids.add(5555);
      writePid("vault", 5555, h.configDir);
      const baseKill = fc.deps.kill;
      fc.deps.kill = (pid, signal) => {
        baseKill?.(pid, signal);
        if (pid === 5555) getWorld(fc.deps).listening.delete(1940);
      };
      // Record the world's listening state at the instant startUnit is called.
      let listeningAtStart: number[] = [];
      const baseStart = fc.deps.installAndStartHubUnit;
      fc.deps.installAndStartHubUnit = async (opts) => {
        listeningAtStart = [...getWorld(fc.deps).listening];
        return baseStart?.(opts) as Promise<InstallAndStartHubUnitResult>;
      };
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 0,
      });
      expect(result.outcome).toBe("migrated");
      // By the time the unit starts, both ports must be free.
      expect(listeningAtStart).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe("cutoverToSupervised — idempotency + resumability", () => {
  test("already-supervised box is a no-op (unit installed + /health answers)", async () => {
    const h = makeHarness();
    try {
      const fc = makeFakeCutover();
      const w = getWorld(fc.deps);
      w.unitInstalled = true;
      w.hubHealthy = true;
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 0,
      });
      expect(result.outcome).toBe("already-migrated");
      // No destructive step ran.
      expect(fc.trace).not.toContain("stopHub");
      expect(fc.trace).not.toContain("startUnit");
      expect(fc.trace).not.toContain("writeUnit");
    } finally {
      h.cleanup();
    }
  });

  test("resumes a partial cutover (unit written but hub not healthy)", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, []);
      const fc = makeFakeCutover();
      const w = getWorld(fc.deps);
      // Unit on disk from a prior aborted run, but the hub never came up.
      w.unitInstalled = true;
      w.hubHealthy = false;
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 0,
      });
      // NOT a no-op — it resumes (re-write idempotent, stop no-ops, start).
      expect(result.outcome).toBe("migrated");
      expect(fc.trace).toContain("writeUnit");
      expect(fc.trace).toContain("startUnit");
    } finally {
      h.cleanup();
    }
  });
});

describe("cutoverToSupervised — §7.2 orphan sweep", () => {
  test("a process bound to a module port (stale pidfile) is adopted + killed before start", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, [{ name: "vault", port: 1940 }]);
      const fc = makeFakeCutover();
      const w = getWorld(fc.deps);
      // vault's pidfile is gone, but an orphan PID 4242 still holds port 1940.
      w.listening.add(1939);
      w.listening.add(1940);
      w.orphanPorts.set(1940, 4242);
      w.alivePids.add(4242);
      // When the orphan is killed, free its port (model the OS releasing it).
      const baseKill = fc.deps.kill;
      fc.deps.kill = (pid, signal) => {
        baseKill?.(pid, signal);
        if (pid === 4242) getWorld(fc.deps).listening.delete(1940);
      };
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 0,
      });
      expect(result.outcome).toBe("migrated");
      // The orphan was killed (adopted from lsof, not from a pidfile).
      expect(fc.trace).toContain("kill 4242 SIGTERM");
    } finally {
      h.cleanup();
    }
  });
});

describe("cutoverToSupervised — fail-safe recovery states", () => {
  test("port-stuck: a port that won't free fails with the unit written-but-not-started", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, [{ name: "vault", port: 1940 }]);
      const fc = makeFakeCutover();
      const w = getWorld(fc.deps);
      w.listening.add(1939);
      w.listening.add(1940);
      // stopHub frees 1939, but NOTHING frees 1940 (no orphan to adopt, the
      // detached stop didn't release it) — the port stays held forever.
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 0,
        timeoutMs: 0,
      });
      expect(result.outcome).toBe("port-stuck");
      // FAIL-SAFE: the unit WAS written (recoverable), and the unit was NOT
      // started (we never raced the held port).
      expect(fc.trace).toContain("writeUnit");
      expect(fc.trace).not.toContain("startUnit");
      expect(getWorld(fc.deps).unitInstalled).toBe(true);
      expect(result.messages.join("\n")).toContain("re-run");
    } finally {
      h.cleanup();
    }
  });

  test("write-failed (bun unresolvable): bails BEFORE stopping anything", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, [{ name: "vault", port: 1940 }]);
      const fc = makeFakeCutover({
        writeUnitWithoutStarting: () => ({
          written: false,
          outcome: "fallback",
          messages: ["cannot build hub unit: 'bun' not found on PATH"],
        }),
      });
      const w = getWorld(fc.deps);
      w.listening.add(1939);
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 0,
      });
      // A write-fallback is treated as no-manager (can't host a unit here).
      expect(result.outcome).toBe("no-manager");
      // FAIL-SAFE: nothing was stopped — we never reached step 3.
      expect(fc.trace).not.toContain("stopHub");
      expect(fc.trace).not.toContain("startUnit");
    } finally {
      h.cleanup();
    }
  });

  test("start-failed: unit start degrades → recoverable (unit written, re-runnable)", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, []);
      const fc = makeFakeCutover({
        installAndStartHubUnit: async () => ({
          outcome: "no-manager",
          port: 1939,
          install: { outcome: "fallback", messages: ["manager gone"] },
          messages: ["manager gone"],
        }),
      });
      const w = getWorld(fc.deps);
      w.listening.add(1939);
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 0,
      });
      expect(result.outcome).toBe("start-failed");
      expect(result.messages.join("\n")).toContain("re-run");
      // The unit was written (recoverable); we stopped detached but the unit is
      // on disk so a re-run is clean.
      expect(getWorld(fc.deps).unitInstalled).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("verify-timeout: unit starts but /health never answers → recoverable", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, []);
      const fc = makeFakeCutover({
        // The unit "starts" but the world's hubHealthy stays false.
        installAndStartHubUnit: async () => ({
          outcome: "started",
          port: 1939,
          install: { outcome: "installed", kind: "systemd-user", messages: [] },
          messages: ["started"],
        }),
      });
      const w = getWorld(fc.deps);
      w.listening.add(1939);
      // Note: probeHealth reads world.hubHealthy which stays false.
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 0,
        timeoutMs: 0,
      });
      expect(result.outcome).toBe("verify-timeout");
      expect(result.messages.join("\n")).toContain("logs hub");
    } finally {
      h.cleanup();
    }
  });
});

describe("teardownHubUnit (§7.4)", () => {
  test("removes the hub unit (idempotent success path)", () => {
    let removeArgs: { launchdLabel: string; systemdUnitName: string } | undefined;
    const log: string[] = [];
    const res = teardownHubUnit({
      log: (l) => log.push(l),
      remove: (opts): ManagedUnitRemoveResult => {
        removeArgs = { launchdLabel: opts.launchdLabel, systemdUnitName: opts.systemdUnitName };
        return { removed: true, messages: [opts.removedSystemdMessage(opts.systemdUnitName)] };
      },
    });
    expect(res.removed).toBe(true);
    expect(removeArgs?.launchdLabel).toBe("computer.parachute.hub");
    expect(removeArgs?.systemdUnitName).toBe("parachute-hub.service");
    // Surfaces the fallback hint.
    expect(log.join("\n")).toContain("parachute serve");
  });

  test("no unit installed → no-op, friendly message", () => {
    const log: string[] = [];
    const res = teardownHubUnit({
      log: (l) => log.push(l),
      remove: (): ManagedUnitRemoveResult => ({ removed: false, messages: [] }),
    });
    expect(res.removed).toBe(false);
    expect(log.join("\n")).toContain("nothing to tear down");
  });
});
