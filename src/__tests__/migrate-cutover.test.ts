import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CutoverDeps,
  type WriteUnitResult,
  cutoverToSupervised,
  defaultCutoverDeps,
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
    // Default ownership probe: unattributable (returns undefined) — hermetic, no
    // real `ps` shell-out. Tests that exercise the ownership check override it.
    ownerOfPid: () => undefined,
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
      // The orphan IS the stale vault module (its command line is attributable),
      // so the ownership check (MUST-FIX 2) adopts + kills it.
      const fc = makeFakeCutover({
        ownerOfPid: (pid) =>
          pid === 4242
            ? "bun /home/op/.bun/install/global/@openparachute/vault/server.ts --port 1940"
            : undefined,
      });
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
          cause: "write-failed",
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
      // A write failure is distinct from no-manager (MUST-FIX NIT) — a manager
      // may exist; we just couldn't compose/write the unit.
      expect(result.outcome).toBe("write-failed");
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

// ===========================================================================
// MUST-FIX 1 — group-aware kill (hub#88 re-opened in the cutover).
//
// Modules are spawned `detached: true` → the recorded pid is a process-GROUP
// leader. A wrapper startCmd (`pnpm exec tsx server.ts`) leaves the real server
// as a GRANDCHILD in that group. The cutover used the BARE-pid kill, which
// signals only the wrapper → the tsx grandchild survives, keeps holding the
// module port → `waitPortFree` times out → `port-stuck` on the FIRST run. These
// tests pin the fix: `defaultCutoverDeps.kill` is GROUP-aware (negative pid).
// ===========================================================================

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("MUST-FIX 1: group-aware kill targets the process GROUP (negative pid)", () => {
  test("defaultCutoverDeps.kill signals -pid (the whole group), with an ESRCH bare-pid fallback", () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const realKill = process.kill.bind(process);
    const spy = (pid: number, signal?: NodeJS.Signals | number) => {
      calls.push({ pid, signal: signal ?? 0 });
      // Make the group send (negative pid) succeed so no fallback is taken.
      return true as unknown as ReturnType<typeof process.kill>;
    };
    try {
      // biome-ignore lint/suspicious/noExplicitAny: test spy on process.kill
      (process as any).kill = spy;
      defaultCutoverDeps.kill(4242, "SIGTERM");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).kill = realKill;
    }
    // The group send fired with the NEGATIVE pid — not the bare pid.
    expect(calls).toEqual([{ pid: -4242, signal: "SIGTERM" }]);
  });

  test("ESRCH on the group send falls back to a bare-pid signal (legacy pidfile)", () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const realKill = process.kill.bind(process);
    const spy = (pid: number, signal?: NodeJS.Signals | number) => {
      calls.push({ pid, signal: signal ?? 0 });
      if (pid < 0) {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      }
      return true as unknown as ReturnType<typeof process.kill>;
    };
    try {
      // biome-ignore lint/suspicious/noExplicitAny: test spy on process.kill
      (process as any).kill = spy;
      defaultCutoverDeps.kill(777, "SIGKILL");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).kill = realKill;
    }
    // First the group send (ESRCH), then the bare-pid fallback.
    expect(calls).toEqual([
      { pid: -777, signal: "SIGKILL" },
      { pid: 777, signal: "SIGKILL" },
    ]);
  });

  test("LOAD-BEARING: a wrapper-startCmd grandchild holding the module port is reaped → cutover migrates (NOT port-stuck)", async () => {
    const h = makeHarness();
    // Spawn a REAL detached wrapper that backgrounds a long-lived grandchild and
    // prints the grandchild's pid — faithfully modeling `pnpm exec tsx server.ts`
    // (a wrapper whose tsx grandchild is the thing actually holding the port). The
    // wrapper is its own process-group leader (detached: true → pid == pgid).
    const proc = Bun.spawn(["sh", "-c", "sleep 30 & echo $!; wait"], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      env: process.env,
    });
    const leaderPid = proc.pid; // group leader (the "wrapper")
    let grandchildPid = -1;
    try {
      const { value } = await proc.stdout.getReader().read();
      grandchildPid = Number.parseInt(
        new TextDecoder().decode(value ?? new Uint8Array()).trim(),
        10,
      );
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(pidAlive(grandchildPid)).toBe(true);

      seedManifest(h.manifestPath, [{ name: "vault", port: 1940 }]);
      // vault's pidfile points at the WRAPPER leader (what `parachute start`
      // recorded); the GRANDCHILD is what actually holds port 1940.
      writePid("vault", leaderPid, h.configDir);

      const fc = makeFakeCutover({
        // PRODUCTION group-aware kill + alive (the fix under test) — NOT the
        // harness fakes. Everything else stays stubbed (no real unit / health).
        kill: defaultCutoverDeps.kill,
        alive: defaultCutoverDeps.alive,
        // The module port reads as HELD while the grandchild is still alive, and
        // FREE the instant the grandchild dies — real-process backed, so only a
        // correct group-kill (which reaps the grandchild) frees it.
        portListening: async (port) => (port === 1940 ? pidAlive(grandchildPid) : false),
        // No lsof orphan beyond the pidfile path — the stop reaps the group.
        pidOnPort: () => undefined,
      });
      const w = getWorld(fc.deps);
      w.listening.add(1939); // hub port held; stopHub frees it.

      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 1,
        timeoutMs: 2000,
      });

      // The grandchild was reaped by the GROUP kill → port 1940 freed → the
      // cutover proceeded. A bare-pid kill would have left the grandchild alive,
      // 1940 held, and the outcome `port-stuck` (the hub#88 footgun).
      expect(result.outcome).toBe("migrated");
      expect(pidAlive(grandchildPid)).toBe(false);
    } finally {
      // Defensive cleanup — both should already be gone on the happy path.
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {}
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {}
      }
      h.cleanup();
    }
  });
});

// ===========================================================================
// MUST-FIX 2 — ownership check in the per-module orphan sweep (no blind-kill).
//
// `sweepOrphanOnPort` must NOT kill whatever holds a declared MODULE port — only
// processes plausibly attributable to that parachute module. An operator's own
// dev server squatting a module port must survive (warning + port-stuck), not be
// nuked.
// ===========================================================================

describe("MUST-FIX 2: orphan-sweep ownership check on module ports", () => {
  test("an orphan attributable to the module (cmdline mentions it) is adopted + killed", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, [{ name: "vault", port: 1940 }]);
      const fc = makeFakeCutover({
        // The orphan's command line looks like a parachute vault process.
        ownerOfPid: (pid) =>
          pid === 4242
            ? "bun /home/op/.bun/install/global/@openparachute/vault/server.ts"
            : undefined,
      });
      const w = getWorld(fc.deps);
      w.listening.add(1939);
      w.listening.add(1940);
      w.orphanPorts.set(1940, 4242);
      w.alivePids.add(4242);
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
      // Attributable → adopted + killed.
      expect(fc.trace).toContain("kill 4242 SIGTERM");
    } finally {
      h.cleanup();
    }
  });

  test("an UNATTRIBUTABLE process on a module port is NOT killed → warning + port-stuck", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, [{ name: "vault", port: 1940 }]);
      const fc = makeFakeCutover({
        // The orphan is an operator's own dev server — nothing parachute-ish.
        ownerOfPid: (pid) => (pid === 7777 ? "node /Users/op/my-app/dev-server.js" : undefined),
      });
      const w = getWorld(fc.deps);
      w.listening.add(1939);
      w.listening.add(1940);
      // No vault pidfile (so no recorded-pid match) — the squatter is 7777.
      w.orphanPorts.set(1940, 7777);
      w.alivePids.add(7777);
      const log: string[] = [];
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: (l) => log.push(l),
        pollMs: 0,
        timeoutMs: 0,
      });
      // The cutover refused to nuke the unrelated process → the port stays held →
      // port-stuck (the operator resolves it).
      expect(result.outcome).toBe("port-stuck");
      // The squatter was NEVER signalled.
      expect(fc.trace).not.toContain("kill 7777 SIGTERM");
      expect(fc.trace).not.toContain("kill 7777 SIGKILL");
      expect(getWorld(fc.deps).alivePids.has(7777)).toBe(true);
      // A clear warning names the unrelated process + refuses.
      const out = log.join("\n");
      expect(out).toContain("held by an unrelated process");
      expect(out).toContain("7777");
      expect(out).toContain("dev-server.js");
    } finally {
      h.cleanup();
    }
  });

  test("an orphan whose command line is unreadable is treated as UNATTRIBUTABLE", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, [{ name: "vault", port: 1940 }]);
      const fc = makeFakeCutover({
        // ps failed / pid gone → no cmdline, and the pid doesn't match a record.
        ownerOfPid: () => undefined,
      });
      const w = getWorld(fc.deps);
      w.listening.add(1939);
      w.listening.add(1940);
      w.orphanPorts.set(1940, 5050);
      w.alivePids.add(5050);
      const result = await cutoverToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        deps: fc.deps,
        log: () => {},
        pollMs: 0,
        timeoutMs: 0,
      });
      expect(result.outcome).toBe("port-stuck");
      expect(fc.trace).not.toContain("kill 5050 SIGTERM");
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// MUST-FIX NIT — distinguish no-manager from write-failed in the cutover.
// ===========================================================================

describe("MUST-FIX NIT: no-manager vs write-failed are distinct outcomes", () => {
  test("bun-not-found (write-failed cause) → write-failed outcome with an accurate message", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, []);
      const fc = makeFakeCutover({
        writeUnitWithoutStarting: () => ({
          written: false,
          outcome: "fallback",
          cause: "write-failed",
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
      expect(result.outcome).toBe("write-failed");
      // NOT the "no service manager" message — names bun / the write failure.
      const out = result.messages.join("\n");
      expect(out).toContain("Could not write the hub unit file");
      expect(out).not.toContain("This host has no service manager");
      // FAIL-SAFE: nothing stopped (still before step 3).
      expect(fc.trace).not.toContain("stopHub");
      expect(fc.trace).not.toContain("startUnit");
    } finally {
      h.cleanup();
    }
  });

  test("genuine no-manager (no systemd/launchd) → no-manager outcome + service-manager message", async () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, []);
      const fc = makeFakeCutover({
        writeUnitWithoutStarting: () => ({
          written: false,
          outcome: "fallback",
          cause: "no-manager",
          messages: ["no service manager (launchctl) found on this host"],
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
      expect(result.outcome).toBe("no-manager");
      expect(result.messages.join("\n")).toContain("This host has no service manager");
      expect(fc.trace).not.toContain("stopHub");
    } finally {
      h.cleanup();
    }
  });
});
