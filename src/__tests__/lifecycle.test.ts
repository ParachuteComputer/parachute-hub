import { describe, expect, test } from "bun:test";
import { mkdtempSync, openSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LifecycleOpts,
  defaultAlive,
  defaultKill,
  logs,
  restart,
  start,
  stop,
} from "../commands/lifecycle.ts";
import type { HubUnitManagerOpResult } from "../hub-unit.ts";
import type { MigrateOfferOpts, MigrateOfferResult } from "../migrate-offer.ts";
import {
  type ModuleOp,
  ModuleOpHttpError,
  type ModuleOpResult,
  NoOperatorTokenError,
} from "../module-ops-client.ts";
import { ensureLogPath, writePid } from "../process-state.ts";
import { upsertService } from "../services-manifest.ts";

// ---------------------------------------------------------------------------
// Phase 5b: the supervised path is the ONLY runtime. The detached spawners were
// retired, so these suites exercise (a) the supervisor-path dispatch (hub UNIT
// installed → drive the running supervisor / platform manager), (b) the no-unit
// path (§7.5 auto-offer / actionable error — NEVER a detached spawn), and (c)
// the group-aware kill/alive primitives that survive for `logs` + future use.
//
// Coverage that MOVED with the retirement (no longer asserted here):
//   - per-module spawn / env injection / PORT override / cwd / startCmd
//     resolution / missing-dependency preflight → now the supervisor's job,
//     asserted in `supervisor.test.ts` + `api-modules-ops.test.ts`.
//   - hub#194 settle + hub#487 port-readiness → supervisor post-spawn readiness,
//     asserted in `supervisor.test.ts`.
//   - process-GROUP spawn (`detached: true`) → the supervisor's group-spawn,
//     asserted in `supervisor.test.ts` (`defaultKillGroup` + the real round-trip).
//   - `start|stop|restart hub` via `ensureHubRunning`/`stopHub` → now the
//     platform-manager path (`ensureHubUnit`/`stopHubUnit`/`restartHubUnit`),
//     asserted in the dual-dispatch suites below.
// ---------------------------------------------------------------------------

interface Harness {
  configDir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-life-"));
  return {
    configDir: dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedVault(manifestPath: string): void {
  upsertService(
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version: "0.2.4",
    },
    manifestPath,
  );
}

interface SupervisorStub {
  opts: NonNullable<LifecycleOpts["supervisor"]>;
  driveCalls: Array<{ short: string; op: ModuleOp }>;
  ensureCalls: Array<{ port?: number }>;
  stopHubCalls: number;
  restartHubCalls: number;
  healthProbes: number;
}

/**
 * Build a `supervisor` seam that forces the unit-installed arm and records the
 * supervisor / manager calls. `driveResponder` lets a test return a result or
 * throw a module-ops error per (short, op). The default responder returns a
 * benign sync-op result. `health` controls `probeHubHealth`.
 */
function makeSupervisorStub(opts?: {
  health?: boolean;
  ensureOutcome?: "already-up" | "started" | "no-unit" | "no-manager" | "timeout" | "start-failed";
  ensureMessages?: string[];
  driveResponder?: (short: string, op: ModuleOp) => ModuleOpResult | Promise<ModuleOpResult>;
  stopHubResult?: HubUnitManagerOpResult;
  restartHubResult?: HubUnitManagerOpResult;
}): SupervisorStub {
  const driveCalls: Array<{ short: string; op: ModuleOp }> = [];
  const ensureCalls: Array<{ port?: number }> = [];
  const stub: SupervisorStub = {
    driveCalls,
    ensureCalls,
    stopHubCalls: 0,
    restartHubCalls: 0,
    healthProbes: 0,
    opts: {
      unitInstalled: true,
      // openDb is never exercised by the stub driveModuleOp, but the dispatch
      // opens+closes it around the call — hand back a no-op closer.
      openDb: () => ({ close() {} }) as unknown as import("bun:sqlite").Database,
      driveModuleOp: async (short, op) => {
        driveCalls.push({ short, op });
        if (opts?.driveResponder) return await opts.driveResponder(short, op);
        return { status: 200, body: { short, state: { status: "running" } } };
      },
      ensureHubUnit: async (o) => {
        ensureCalls.push({ port: o.port });
        return {
          outcome: opts?.ensureOutcome ?? "already-up",
          port: o.port ?? 1939,
          messages: opts?.ensureMessages ?? [],
        };
      },
      stopHubUnit: () => {
        stub.stopHubCalls++;
        return opts?.stopHubResult ?? { outcome: "ok", messages: [] };
      },
      restartHubUnit: () => {
        stub.restartHubCalls++;
        return opts?.restartHubResult ?? { outcome: "ok", messages: [] };
      },
      probeHubHealth: async () => {
        stub.healthProbes++;
        return opts?.health ?? true;
      },
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Supervisor-path dispatch (design §3.3): a hub UNIT is installed → the verbs
// drive the running supervisor (per-module ops) / platform manager (hub verbs).
// ---------------------------------------------------------------------------

describe("start — supervisor path", () => {
  test("module svc, unit-installed → ensureHubUnit then driveModuleOp(start)", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub();
      const log: string[] = [];
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      expect(sup.ensureCalls).toHaveLength(1);
      expect(sup.driveCalls).toEqual([{ short: "vault", op: "start" }]);
      expect(log.join("\n")).toMatch(/✓ vault started/);
    } finally {
      h.cleanup();
    }
  });

  test("no svc, unit-installed → ensureHubUnit only (boots all modules), no driveModuleOp", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub();
      const code = await start(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      expect(sup.ensureCalls).toHaveLength(1);
      expect(sup.driveCalls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("module svc, NoOperatorTokenError → actionable message surfaced (not raw-thrown)", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub({
        driveResponder: () => {
          throw new NoOperatorTokenError();
        },
      });
      const log: string[] = [];
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        supervisor: sup.opts,
      });
      expect(code).toBe(1);
      expect(log.join("\n")).toMatch(/no operator token/);
      expect(log.join("\n")).toMatch(/parachute auth rotate-operator/);
    } finally {
      h.cleanup();
    }
  });

  test("module svc, 400 not_installed → actionable install hint", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub({
        driveResponder: () => {
          throw new ModuleOpHttpError(400, "not_installed", "vault is not installed");
        },
      });
      const log: string[] = [];
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        supervisor: sup.opts,
      });
      expect(code).toBe(1);
      expect(log.join("\n")).toMatch(/not installed/);
      expect(log.join("\n")).toMatch(/parachute install vault/);
    } finally {
      h.cleanup();
    }
  });
});

describe("stop — supervisor path", () => {
  test("module svc, hub UP → driveModuleOp(stop), no ensureHubUnit", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub({ health: true });
      const log: string[] = [];
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      expect(sup.healthProbes).toBe(1);
      expect(sup.driveCalls).toEqual([{ short: "vault", op: "stop" }]);
      expect(sup.ensureCalls).toHaveLength(0); // never start the hub just to stop a module
      expect(log.join("\n")).toMatch(/✓ vault stopped/);
    } finally {
      h.cleanup();
    }
  });

  test("module svc, hub DOWN → success WITHOUT starting the hub or driving stop", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub({ health: false });
      const log: string[] = [];
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      expect(sup.healthProbes).toBe(1);
      expect(sup.driveCalls).toHaveLength(0); // nothing to stop — module already down
      expect(sup.ensureCalls).toHaveLength(0); // did NOT ensureHubUnit
      expect(log.join("\n")).toMatch(/already stopped/);
    } finally {
      h.cleanup();
    }
  });

  test("stop hub → platform manager (stopHubUnit), never a PID signal", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub();
      const log: string[] = [];
      const code = await stop("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      expect(sup.stopHubCalls).toBe(1);
      expect(sup.healthProbes).toBe(0);
      expect(log.join("\n")).toMatch(/✓ hub stopped/);
    } finally {
      h.cleanup();
    }
  });

  test("no svc, unit-installed → stop the hub unit (manager)", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub();
      const code = await stop(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      expect(sup.stopHubCalls).toBe(1);
      expect(sup.driveCalls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("restart — supervisor path", () => {
  test("module svc, unit-installed → ensureHubUnit then driveModuleOp(restart)", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub();
      const log: string[] = [];
      const code = await restart("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      expect(sup.ensureCalls).toHaveLength(1);
      expect(sup.driveCalls).toEqual([{ short: "vault", op: "restart" }]);
      expect(log.join("\n")).toMatch(/✓ vault restarted/);
    } finally {
      h.cleanup();
    }
  });

  test("404 not_supervised on restart → fall through to driveModuleOp(start)", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub({
        driveResponder: (_short, op) => {
          if (op === "restart") {
            throw new ModuleOpHttpError(404, "not_supervised", "vault is not currently supervised");
          }
          return { status: 200, body: { short: "vault", state: { status: "running" } } };
        },
      });
      const log: string[] = [];
      const code = await restart("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      // restart was attempted, then start as the 404-fallthrough (§6.2).
      expect(sup.driveCalls).toEqual([
        { short: "vault", op: "restart" },
        { short: "vault", op: "start" },
      ]);
      expect(log.join("\n")).toMatch(/✓ vault started/);
    } finally {
      h.cleanup();
    }
  });

  test("restart hub → platform manager (restartHubUnit), never a PID signal", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub();
      const log: string[] = [];
      const code = await restart("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      expect(sup.restartHubCalls).toBe(1);
      expect(sup.driveCalls).toHaveLength(0); // NOT a per-module fan-out
      expect(log.join("\n")).toMatch(/✓ hub restarted/);
    } finally {
      h.cleanup();
    }
  });

  test("no svc, unit-installed → restart the hub unit (manager), not a fan-out", async () => {
    const h = makeHarness();
    try {
      const sup = makeSupervisorStub();
      const code = await restart(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        supervisor: sup.opts,
      });
      expect(code).toBe(0);
      expect(sup.restartHubCalls).toBe(1);
      expect(sup.driveCalls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// §7.5 no-unit path: a box with NO hub unit gets the auto-offer (when enabled)
// or the actionable "run `parachute migrate --to-supervised`" error — NEVER a
// detached spawn (the spawners are retired in Phase 5b). Reworked from the
// former "fall through to the detached arm" tests: the intent (what happens on
// a no-unit box) is preserved, but the outcome inverted to single-runtime.
// ---------------------------------------------------------------------------

describe("§7.5 no-unit path in start/stop/restart", () => {
  /** A migrate-offer stub recording whether it was called + what it returns. */
  function makeOfferStub(outcome: MigrateOfferResult["outcome"]): {
    offer: (opts: MigrateOfferOpts) => Promise<MigrateOfferResult>;
    calls: number;
  } {
    const state = { calls: 0 };
    return {
      get calls() {
        return state.calls;
      },
      offer: async () => {
        state.calls++;
        return { outcome };
      },
    };
  }

  test("no unit + offer disabled (omitted) → actionable migrate error, exit 1, no spawn", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const log: string[] = [];
      // No `supervisor` block → unitInstalled defaults to false; no migrateOffer
      // → the offer hook stays OFF. There is no detached fallback anymore, so the
      // verb surfaces the actionable command and exits non-zero.
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(1);
      expect(log.join("\n")).toMatch(/No supervised hub unit is installed/);
      expect(log.join("\n")).toMatch(/parachute migrate --to-supervised/);
    } finally {
      h.cleanup();
    }
  });

  test("start: accept+migrate → dispatches through the supervisor (no detached spawn)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const offerStub = makeOfferStub("migrated");
      const sup = makeSupervisorStub();
      // Start on the no-unit arm (unitInstalled:false), with the offer enabled
      // and the supervisor stub ready for the post-migrate dispatch.
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        supervisor: { ...sup.opts, unitInstalled: false },
        migrateOffer: { enabled: true, offer: offerStub.offer },
      });
      expect(code).toBe(0);
      expect(offerStub.calls).toBe(1);
      // The migrate flipped the box to supervised → the verb drove the supervisor.
      expect(sup.driveCalls).toEqual([{ short: "vault", op: "start" }]);
    } finally {
      h.cleanup();
    }
  });

  test("start: declined → actionable-error path, exit 1 (no spawn)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const offerStub = makeOfferStub("declined");
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        migrateOffer: { enabled: true, offer: offerStub.offer },
      });
      // Declined → no migrate, no detached spawn (retired) → non-zero exit. The
      // offer itself surfaced its own decline guidance, so the verb just bails.
      expect(code).toBe(1);
      expect(offerStub.calls).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("start: migrate-failed → actionable-error path, exit 1 (fail-safe, no spawn)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const offerStub = makeOfferStub("migrate-failed");
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        migrateOffer: { enabled: true, offer: offerStub.offer },
      });
      // A failed cutover leaves the box un-migrated → the verb bails non-zero
      // (rather than dispatching into a supervisor that isn't up). No spawn.
      expect(code).toBe(1);
      expect(offerStub.calls).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("stop: accept+migrate → dispatches through the supervisor", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const offerStub = makeOfferStub("migrated");
      const sup = makeSupervisorStub();
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        supervisor: { ...sup.opts, unitInstalled: false },
        migrateOffer: { enabled: true, offer: offerStub.offer },
      });
      expect(code).toBe(0);
      expect(offerStub.calls).toBe(1);
      expect(sup.driveCalls).toEqual([{ short: "vault", op: "stop" }]);
    } finally {
      h.cleanup();
    }
  });

  test("restart: accept+migrate → dispatches through the supervisor", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const offerStub = makeOfferStub("migrated");
      const sup = makeSupervisorStub();
      const code = await restart("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        supervisor: { ...sup.opts, unitInstalled: false },
        migrateOffer: { enabled: true, offer: offerStub.offer },
      });
      expect(code).toBe(0);
      expect(offerStub.calls).toBe(1);
      expect(sup.driveCalls).toEqual([{ short: "vault", op: "restart" }]);
    } finally {
      h.cleanup();
    }
  });

  test("offer is NOT made on the supervisor arm (unit already installed)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const offerStub = makeOfferStub("migrated");
      const sup = makeSupervisorStub(); // unitInstalled: true
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        supervisor: sup.opts,
        migrateOffer: { enabled: true, offer: offerStub.offer },
      });
      expect(code).toBe(0);
      // Supervisor arm taken directly → the offer hook (no-unit only) never ran.
      expect(offerStub.calls).toBe(0);
      expect(sup.driveCalls).toEqual([{ short: "vault", op: "start" }]);
    } finally {
      h.cleanup();
    }
  });

  test("restart: declined → offer fires EXACTLY ONCE (MUST-FIX 3), exit 1", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      // The operator DECLINES the offer. `restart` makes a single offer via the
      // shared `requireSupervisedOrOffer` gate (no inner stop+start re-offer
      // anymore — the detached stop-then-start arm is gone).
      const offerStub = makeOfferStub("declined");
      const code = await restart("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        migrateOffer: { enabled: true, offer: offerStub.offer },
      });
      expect(code).toBe(1);
      // EXACTLY ONE offer.
      expect(offerStub.calls).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Group-aware kill / liveness primitives (hub#88). The detached MODULE spawner
// that created these process groups is retired (the supervisor's group-spawn +
// `defaultKillGroup` carry that role now, asserted in `supervisor.test.ts`), but
// `defaultKill` / `defaultAlive` survive as exported primitives — `logs` uses
// `defaultAlive`, and the supervisor's reaper mirrors `defaultKill`'s group/
// bare-pid fallback. These tests spawn a detached fixture process directly (not
// via the retired spawner) to keep that behavior under test.
// ---------------------------------------------------------------------------

/** Spawn a detached fixture child (its own process group) for the kill/alive tests. */
function spawnDetached(cmd: string[]): { pid: number; logFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-grp-"));
  const logFile = ensureLogPath("test", dir);
  const fd = openSync(logFile, "a");
  const proc = Bun.spawn(cmd, { stdio: ["ignore", fd, fd], detached: true, env: process.env });
  proc.unref();
  return { pid: proc.pid, logFile };
}

describe("group-aware kill / liveness (hub#88)", () => {
  test("defaultKill takes down the wrapper and its grandchildren together", async () => {
    // Wrapper sh forks `sleep 30 & echo $!` so we capture the grandchild PID via
    // the log file, then `wait` so the wrapper sticks around (mirrors `pnpm exec
    // tsx`'s shape). SIGKILL on the GROUP reaps both.
    const { pid: wrapperPid, logFile } = spawnDetached([
      "sh",
      "-c",
      "sleep 30 & echo $! >&2; wait",
    ]);
    await new Promise((r) => setTimeout(r, 200));
    const logText = await Bun.file(logFile).text();
    const grandchildPid = Number.parseInt(logText.trim().split("\n").pop() ?? "", 10);
    expect(grandchildPid).toBeGreaterThan(0);
    expect(grandchildPid).not.toBe(wrapperPid);
    expect(() => process.kill(grandchildPid, 0)).not.toThrow();

    defaultKill(wrapperPid, "SIGKILL");

    await new Promise((r) => setTimeout(r, 200));
    let grandchildStillAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      grandchildStillAlive = false;
    }
    expect(grandchildStillAlive).toBe(false);
  });

  test("defaultAlive reports group liveness for detached children", async () => {
    const { pid } = spawnDetached(["sh", "-c", "sleep 2"]);
    try {
      expect(defaultAlive(pid)).toBe(true);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(defaultAlive(pid)).toBe(false);
  });

  test("defaultAlive + defaultKill fall back to bare-pid for legacy (non-detached) processes", async () => {
    // A non-detached child shares the test runner's pgid, so kill(-pid, 0) will
    // ESRCH and both must fall back to a bare-pid path.
    const proc = Bun.spawn(["sh", "-c", "sleep 5"], { stdio: ["ignore", "ignore", "ignore"] });
    const pid = proc.pid;
    try {
      expect(defaultAlive(pid)).toBe(true);
      defaultKill(pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 100));
      expect(defaultAlive(pid)).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// `parachute logs <svc>`. Under hub-as-supervisor (Phase 5b) a module's output
// is multiplexed into the HUB log with a `[<svc>] ` line prefix, so `logs <svc>`
// reads that stream filtered to the service (hub#652). The per-service logfile
// keyed by short name (the readers §7.5 keeps) survives as the legacy source
// when it's fresher than the hub log (pre-supervised installs). `logs hub`
// reads the hub log unfiltered.
// ---------------------------------------------------------------------------

/** The supervisor's multiplexed hub-log shape (supervisor.ts pipeOutput). */
const INTERLEAVED_HUB_LOG =
  "[vault] vault boot\n" +
  "[scribe] scribe boot\n" +
  "[vault] GET /vault/default/api/notes 200 7ms\n" +
  "[surface] [app-dcr] client registered\n" +
  "[vaultx] not vault's line\n" +
  "[vault] sync ok\n";

const VAULT_LINES_STRIPPED = ["vault boot", "GET /vault/default/api/notes 200 7ms", "sync ok"];

function writeHubLog(configDir: string, content: string): string {
  const path = ensureLogPath("hub", configDir);
  writeFileSync(path, content);
  return path;
}

/** Backdate a file's mtime so freshness comparisons are deterministic. */
function backdate(path: string, secondsAgo: number): void {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, t, t);
}

describe("parachute logs", () => {
  test("hint when no log file exists", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log.join("\n")).toMatch(/no logs yet for vault/);
    } finally {
      h.cleanup();
    }
  });

  test("prints last N lines in one-shot mode", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const path = ensureLogPath("vault", h.configDir);
      writeFileSync(path, "line one\nline two\nline three\n");
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        lines: 2,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log).toEqual(["line two", "line three"]);
    } finally {
      h.cleanup();
    }
  });

  test("unknown service errors cleanly", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const log: string[] = [];
      const code = await logs("nope", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(1);
      expect(log.join("\n")).toMatch(/unknown service "nope"/);
    } finally {
      h.cleanup();
    }
  });

  test("running daemon + missing log file: surfaces alive-but-no-log shape (hub#335)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      // A pidfile reader still resolves: seed a live pid (this process) so the
      // running-but-no-logfile diagnostic fires.
      writePid("vault", process.pid, h.configDir);
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        alive: () => true,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log.join("\n")).toMatch(/is running \(pid .*\) but no log file/);
    } finally {
      h.cleanup();
    }
  });

  test("stale pidfile + missing log file: falls through to start hint", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 999999, h.configDir);
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        alive: () => false,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log.join("\n")).toMatch(/no logs yet for vault/);
    } finally {
      h.cleanup();
    }
  });

  test("log file exists: prints tail regardless of pidfile state (hub#335)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const path = ensureLogPath("vault", h.configDir);
      writeFileSync(path, "boot line\n");
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log).toEqual(["boot line"]);
    } finally {
      h.cleanup();
    }
  });

  test("logs hub: doesn't reject 'hub' as an unknown service", async () => {
    const h = makeHarness();
    try {
      const log: string[] = [];
      const code = await logs("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log.join("\n")).toMatch(/no logs yet for hub/);
    } finally {
      h.cleanup();
    }
  });

  test("logs hub: prints the tail when a log file exists", async () => {
    const h = makeHarness();
    try {
      const path = ensureLogPath("hub", h.configDir);
      writeFileSync(path, "hub line one\nhub line two\n");
      const log: string[] = [];
      const code = await logs("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log).toEqual(["hub line one", "hub line two"]);
    } finally {
      h.cleanup();
    }
  });

  // ---- hub#652: supervised modules read the hub log's [svc]-prefixed stream ----

  test("supervised module: reads the hub log filtered to its prefix, stripped (hub#652)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeHubLog(h.configDir, INTERLEAVED_HUB_LOG);
      // No per-service vault.log — the supervised steady state.
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      // Exact-prefix match: `[vaultx]` noise excluded; `[vault] ` stripped.
      expect(log).toEqual(VAULT_LINES_STRIPPED);
    } finally {
      h.cleanup();
    }
  });

  test("stale per-service file + fresher hub log: the hub stream wins (the live hub#652 shape)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const legacy = ensureLogPath("vault", h.configDir);
      writeFileSync(legacy, "stale pre-cutover line\n");
      backdate(legacy, 3600);
      writeHubLog(h.configDir, INTERLEAVED_HUB_LOG);
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log).toEqual(VAULT_LINES_STRIPPED);
      expect(log.join("\n")).not.toContain("stale pre-cutover line");
    } finally {
      h.cleanup();
    }
  });

  test("per-service file fresher than the hub log: legacy file wins (pre-supervised install)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const hubLog = writeHubLog(h.configDir, "[vault] old supervised line\n");
      backdate(hubLog, 3600);
      const legacy = ensureLogPath("vault", h.configDir);
      writeFileSync(legacy, "live detached line\n");
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log).toEqual(["live detached line"]);
    } finally {
      h.cleanup();
    }
  });

  test("lines cap applies to the FILTERED set, not raw hub-log lines", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeHubLog(h.configDir, INTERLEAVED_HUB_LOG);
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        lines: 2,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log).toEqual(VAULT_LINES_STRIPPED.slice(-2));
    } finally {
      h.cleanup();
    }
  });

  test("hub log has no lines for the service + no per-service file: start hint", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeHubLog(h.configDir, "[scribe] scribe boot\n");
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log.join("\n")).toMatch(/no logs yet for vault/);
    } finally {
      h.cleanup();
    }
  });

  test("hub log has no lines for the service + per-service file exists: legacy shown with a note", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const legacy = ensureLogPath("vault", h.configDir);
      writeFileSync(legacy, "old detached line\n");
      backdate(legacy, 3600);
      writeHubLog(h.configDir, "[scribe] scribe boot\n");
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      // The note distinguishes the stale per-service file from the live
      // stream — the exact "stale logs presented as current" trap in hub#652.
      expect(log[0]).toMatch(/no vault lines in the hub log/);
      expect(log).toContain("old detached line");
    } finally {
      h.cleanup();
    }
  });

  test("follow mode filters the hub stream and strips the prefix (hub#652)", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeHubLog(h.configDir, INTERLEAVED_HUB_LOG);
      const encoder = new TextEncoder();
      let streamedPath: string | undefined;
      const followStream = (path: string): ReadableStream<Uint8Array> => {
        streamedPath = path;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("[vault] live one\n[scribe] noise\n"));
            // Split a line across chunks to exercise the line buffer.
            controller.enqueue(encoder.encode("[vault] live "));
            controller.enqueue(encoder.encode("two\n"));
            controller.close();
          },
        });
      };
      const log: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        follow: true,
        followStream,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(streamedPath).toContain("hub.log");
      expect(log).toEqual([...VAULT_LINES_STRIPPED, "live one", "live two"]);
    } finally {
      h.cleanup();
    }
  });

  test("follow mode with a fresher per-service file tails THAT file via tail -f", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const hubLog = writeHubLog(h.configDir, "[vault] old supervised line\n");
      backdate(hubLog, 3600);
      const legacy = ensureLogPath("vault", h.configDir);
      writeFileSync(legacy, "live detached line\n");
      const spawned: string[][] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        follow: true,
        tailSpawner: {
          spawn(cmd) {
            spawned.push([...cmd]);
            return 12345;
          },
        },
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.[0]).toBe("tail");
      expect(spawned[0]?.at(-1)).toBe(legacy);
    } finally {
      h.cleanup();
    }
  });

  test("logs hub: stays unfiltered — module-prefixed lines included", async () => {
    const h = makeHarness();
    try {
      writeHubLog(h.configDir, INTERLEAVED_HUB_LOG);
      const log: string[] = [];
      const code = await logs("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log).toEqual(INTERLEAVED_HUB_LOG.replace(/\n$/, "").split("\n"));
    } finally {
      h.cleanup();
    }
  });
});
