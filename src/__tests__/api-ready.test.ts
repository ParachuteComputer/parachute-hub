import { describe, expect, test } from "bun:test";
import { handleApiReady } from "../api-ready.ts";
import type { ModuleState, Supervisor } from "../supervisor.ts";

function stubSupervisor(states: ModuleState[]): Supervisor {
  return {
    list: () => states,
    get: (short: string) => states.find((s) => s.short === short),
    start: async () => {
      throw new Error("not implemented");
    },
    stop: async () => undefined,
    restart: async () => undefined,
  } as unknown as Supervisor;
}

function req(): Request {
  return new Request("http://127.0.0.1/api/ready", {
    headers: { accept: "application/json" },
  });
}

function moduleState(partial: Partial<ModuleState> & { short: string }): ModuleState {
  return {
    status: "running",
    restartsInWindow: 0,
    ...partial,
  };
}

describe("handleApiReady — no supervisor (CLI mode)", () => {
  test("returns ready=true + empty arrays when supervisor absent", async () => {
    const res = handleApiReady(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      ready_modules: string[];
      transient_modules: string[];
      persistent_modules: string[];
    };
    expect(body.ready).toBe(true);
    expect(body.ready_modules).toEqual([]);
    expect(body.transient_modules).toEqual([]);
    expect(body.persistent_modules).toEqual([]);
  });
});

describe("handleApiReady — supervisor mode", () => {
  test("all modules running past boot window → ready=true", async () => {
    const now = 1_700_000_000_000;
    const startedAt = new Date(now - 60_000).toISOString();
    const sup = stubSupervisor([
      moduleState({ short: "vault", status: "running", startedAt }),
      moduleState({ short: "scribe", status: "running", startedAt }),
    ]);
    const res = handleApiReady(req(), { supervisor: sup, now: () => now });
    const body = (await res.json()) as {
      ready: boolean;
      ready_modules: string[];
      transient_modules: string[];
      persistent_modules: string[];
    };
    expect(body.ready).toBe(true);
    expect(body.ready_modules.sort()).toEqual(["scribe", "vault"]);
    expect(body.transient_modules).toEqual([]);
    expect(body.persistent_modules).toEqual([]);
  });

  test("module inside boot window → transient, ready=false", async () => {
    const now = 1_700_000_000_000;
    const sup = stubSupervisor([
      moduleState({
        short: "vault",
        status: "running",
        startedAt: new Date(now - 10_000).toISOString(),
      }),
    ]);
    const res = handleApiReady(req(), { supervisor: sup, now: () => now });
    const body = (await res.json()) as {
      ready: boolean;
      ready_modules: string[];
      transient_modules: string[];
    };
    expect(body.ready).toBe(false);
    expect(body.transient_modules).toEqual(["vault"]);
    expect(body.ready_modules).toEqual([]);
  });

  test("starting + restarting + crashed all classified correctly", async () => {
    const now = 1_700_000_000_000;
    const sup = stubSupervisor([
      moduleState({ short: "vault", status: "starting" }),
      moduleState({ short: "scribe", status: "restarting" }),
      moduleState({ short: "notes", status: "crashed" }),
      moduleState({ short: "agent", status: "stopped" }),
      moduleState({
        short: "runner",
        status: "running",
        startedAt: new Date(now - 60_000).toISOString(),
      }),
    ]);
    const res = handleApiReady(req(), { supervisor: sup, now: () => now });
    const body = (await res.json()) as {
      ready: boolean;
      ready_modules: string[];
      transient_modules: string[];
      persistent_modules: string[];
    };
    expect(body.ready).toBe(false);
    expect(body.ready_modules).toEqual(["runner"]);
    expect(body.transient_modules.sort()).toEqual(["scribe", "vault"]);
    expect(body.persistent_modules.sort()).toEqual(["agent", "notes"]);
  });

  test("only crashed/stopped + nothing transient → ready=false (still failing)", async () => {
    const sup = stubSupervisor([moduleState({ short: "vault", status: "crashed" })]);
    const res = handleApiReady(req(), { supervisor: sup });
    const body = (await res.json()) as { ready: boolean };
    expect(body.ready).toBe(false);
  });
});

describe("handleApiReady — method check", () => {
  test("rejects non-GET", () => {
    const r = new Request("http://127.0.0.1/api/ready", { method: "POST" });
    const res = handleApiReady(r);
    expect(res.status).toBe(405);
  });

  test("accepts HEAD", () => {
    const r = new Request("http://127.0.0.1/api/ready", { method: "HEAD" });
    const res = handleApiReady(r);
    expect(res.status).toBe(200);
  });
});
