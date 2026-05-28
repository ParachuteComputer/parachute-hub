import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePid } from "../process-state.ts";
import { type ClassifyOpts, classifyUpstream } from "../proxy-state.ts";
import type { ModuleState, Supervisor } from "../supervisor.ts";

/**
 * Stub supervisor — only `get(short)` is exercised by `classifyUpstream`.
 * We construct it directly instead of standing up a real `Supervisor`
 * + driving the spawn lifecycle, so test cases stay focused on the
 * classifier's per-status branching.
 */
function stubSupervisor(states: Record<string, ModuleState>): Supervisor {
  return {
    get: (short: string) => states[short],
    list: () => Object.values(states),
    // Unused by classifyUpstream — present to satisfy the Supervisor type.
    start: async () => {
      throw new Error("not implemented");
    },
    stop: async () => undefined,
    restart: async () => undefined,
  } as unknown as Supervisor;
}

function moduleState(partial: Partial<ModuleState> & { short: string }): ModuleState {
  return {
    status: "running",
    restartsInWindow: 0,
    ...partial,
  };
}

describe("classifyUpstream — supervisor mode", () => {
  test("status=starting → transient", () => {
    const sup = stubSupervisor({
      vault: moduleState({ short: "vault", status: "starting" }),
    });
    expect(classifyUpstream("vault", { supervisor: sup })).toBe("transient");
  });

  test("status=restarting → transient", () => {
    const sup = stubSupervisor({
      vault: moduleState({ short: "vault", status: "restarting" }),
    });
    expect(classifyUpstream("vault", { supervisor: sup })).toBe("transient");
  });

  test("status=crashed → persistent", () => {
    const sup = stubSupervisor({
      vault: moduleState({ short: "vault", status: "crashed" }),
    });
    expect(classifyUpstream("vault", { supervisor: sup })).toBe("persistent");
  });

  test("status=stopped → persistent", () => {
    const sup = stubSupervisor({
      vault: moduleState({ short: "vault", status: "stopped" }),
    });
    expect(classifyUpstream("vault", { supervisor: sup })).toBe("persistent");
  });

  test("status=running, inside boot window → transient", () => {
    const now = 1_700_000_000_000;
    const startedAt = new Date(now - 10_000).toISOString(); // 10s ago
    const sup = stubSupervisor({
      vault: moduleState({ short: "vault", status: "running", startedAt }),
    });
    expect(classifyUpstream("vault", { supervisor: sup, now: () => now })).toBe("transient");
  });

  test("status=running, outside boot window → persistent", () => {
    const now = 1_700_000_000_000;
    const startedAt = new Date(now - 60_000).toISOString(); // 60s ago
    const sup = stubSupervisor({
      vault: moduleState({ short: "vault", status: "running", startedAt }),
    });
    expect(classifyUpstream("vault", { supervisor: sup, now: () => now })).toBe("persistent");
  });

  test("status=running, exactly at boot-window boundary → persistent", () => {
    // The check is strict-less-than, so exactly 30s falls into persistent.
    const now = 1_700_000_000_000;
    const startedAt = new Date(now - 30_000).toISOString();
    const sup = stubSupervisor({
      vault: moduleState({ short: "vault", status: "running", startedAt }),
    });
    expect(classifyUpstream("vault", { supervisor: sup, now: () => now })).toBe("persistent");
  });

  test("status=running, missing startedAt → persistent", () => {
    // Can't classify a running module without a start time; safer to call
    // persistent and let the operator hit refresh than to lie that it's
    // booting.
    const sup = stubSupervisor({
      vault: moduleState({ short: "vault", status: "running" }),
    });
    expect(classifyUpstream("vault", { supervisor: sup })).toBe("persistent");
  });

  test("custom boot window honored", () => {
    const now = 1_700_000_000_000;
    const startedAt = new Date(now - 5_000).toISOString(); // 5s ago
    const sup = stubSupervisor({
      vault: moduleState({ short: "vault", status: "running", startedAt }),
    });
    expect(
      classifyUpstream("vault", { supervisor: sup, now: () => now, bootWindowMs: 2_000 }),
    ).toBe("persistent");
    expect(
      classifyUpstream("vault", { supervisor: sup, now: () => now, bootWindowMs: 10_000 }),
    ).toBe("transient");
  });

  test("module not tracked → falls back to pidfile path", () => {
    // Empty supervisor map. Classifier must call through to processState;
    // we inject a stub via readProcessState.
    const sup = stubSupervisor({});
    const opts: ClassifyOpts = {
      supervisor: sup,
      readProcessState: () => ({ status: "unknown" }),
    };
    expect(classifyUpstream("vault", opts)).toBe("persistent");
  });
});

describe("classifyUpstream — on-box CLI mode (no supervisor)", () => {
  test("running pidfile inside boot window → transient", () => {
    const now = 1_700_000_000_000;
    const opts: ClassifyOpts = {
      now: () => now,
      readProcessState: () => ({
        status: "running",
        pid: 12345,
        startedAt: new Date(now - 5_000), // 5s old pidfile
      }),
    };
    expect(classifyUpstream("vault", opts)).toBe("transient");
  });

  test("running pidfile outside boot window → persistent", () => {
    const now = 1_700_000_000_000;
    const opts: ClassifyOpts = {
      now: () => now,
      readProcessState: () => ({
        status: "running",
        pid: 12345,
        startedAt: new Date(now - 60_000),
      }),
    };
    expect(classifyUpstream("vault", opts)).toBe("persistent");
  });

  test("stopped pidfile (stale) → persistent", () => {
    const opts: ClassifyOpts = {
      readProcessState: () => ({ status: "stopped", pid: 12345 }),
    };
    expect(classifyUpstream("vault", opts)).toBe("persistent");
  });

  test("no pidfile (unknown) → persistent", () => {
    const opts: ClassifyOpts = {
      readProcessState: () => ({ status: "unknown" }),
    };
    expect(classifyUpstream("vault", opts)).toBe("persistent");
  });

  test("readProcessState throws → persistent (defensive)", () => {
    // pidfile read can race with cleanup. Don't blow up the proxy.
    const opts: ClassifyOpts = {
      readProcessState: () => {
        throw new Error("ENOENT");
      },
    };
    expect(classifyUpstream("vault", opts)).toBe("persistent");
  });

  test("integration with real processState — running pid is alive + fresh mtime", () => {
    // Write a real pidfile pointing at this test process (always alive),
    // so `defaultAlive` returns true. Pidfile mtime will be ~now, so it
    // falls inside the boot window.
    const dir = mkdtempSync(join(tmpdir(), "proxy-state-"));
    try {
      writePid("vault", process.pid, dir);
      expect(classifyUpstream("vault", { configDir: dir })).toBe("transient");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
