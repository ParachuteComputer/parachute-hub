import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type SpawnRequest, type SupervisedProc, Supervisor } from "../supervisor.ts";

/**
 * Fake subprocess with controllable exited promise + injectable stdout
 * / stderr. The test drives `resolveExit(code)` to simulate the child
 * exiting (clean or crash) and `emit(stream, bytes)` to push log
 * output through the line-buffered tap.
 */
interface FakeProc extends SupervisedProc {
  resolveExit(code: number | null): void;
  emitStdout(chunk: string): void;
  emitStderr(chunk: string): void;
  closeStreams(): void;
  killed: boolean;
  killSignal?: NodeJS.Signals | number;
}

function makeFakeProc(pid: number): FakeProc {
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });

  const stdoutController = makeStreamController();
  const stderrController = makeStreamController();

  return {
    pid,
    exited,
    stdout: stdoutController.stream,
    stderr: stderrController.stream,
    kill(signal) {
      this.killed = true;
      this.killSignal = signal;
    },
    killed: false,
    resolveExit: (code) => resolveExit(code),
    emitStdout: (chunk) => stdoutController.push(chunk),
    emitStderr: (chunk) => stderrController.push(chunk),
    closeStreams: () => {
      stdoutController.close();
      stderrController.close();
    },
  };
}

function makeStreamController(): {
  stream: ReadableStream<Uint8Array>;
  push: (s: string) => void;
  close: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const enc = new TextEncoder();
  return {
    stream,
    push: (s) => controller.enqueue(enc.encode(s)),
    close: () => {
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * Programmable spawner. Hand it a queue of FakeProc instances, one per
 * expected spawn call (or one shared if every spawn uses the same
 * fake). Tests drive lifecycle by calling resolveExit on the returned
 * proc.
 */
function makeQueueSpawner(): {
  spawn: (req: SpawnRequest) => SupervisedProc;
  enqueue: (proc: FakeProc) => void;
  calls: SpawnRequest[];
} {
  const queue: FakeProc[] = [];
  const calls: SpawnRequest[] = [];
  return {
    enqueue: (proc) => queue.push(proc),
    calls,
    spawn: (req) => {
      calls.push(req);
      const next = queue.shift();
      if (!next) throw new Error(`unexpected spawn for ${req.short}`);
      return next;
    },
  };
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Supervisor.start + status transitions", () => {
  test("transitions starting → running after spawn", async () => {
    const proc = makeFakeProc(123);
    const spawner = makeQueueSpawner();
    spawner.enqueue(proc);
    const sup = new Supervisor({ spawnFn: spawner.spawn });

    const state = await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });
    expect(state.status).toBe("running");
    expect(state.pid).toBe(123);
    expect(state.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]?.short).toBe("vault");

    // Cleanup: resolve the exited promise so the watcher doesn't dangle.
    proc.closeStreams();
    sup.stop("vault");
    proc.resolveExit(0);
  });

  test("is idempotent on a running module — second start returns existing state", async () => {
    const proc = makeFakeProc(123);
    const spawner = makeQueueSpawner();
    spawner.enqueue(proc);
    const sup = new Supervisor({ spawnFn: spawner.spawn });

    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });
    // Only one spawn — the second start short-circuited.
    expect(spawner.calls).toHaveLength(1);

    proc.closeStreams();
    sup.stop("vault");
    proc.resolveExit(0);
  });
});

describe("Supervisor restart-on-crash", () => {
  test("restarts a crashed module within the budget", async () => {
    const first = makeFakeProc(101);
    const second = makeFakeProc(102);
    const spawner = makeQueueSpawner();
    spawner.enqueue(first);
    spawner.enqueue(second);

    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      restartDelayMs: 0,
      sleep: () => Promise.resolve(),
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });

    // First child crashes.
    first.closeStreams();
    first.resolveExit(1);
    // Let the handleExit microtask run + the spawn happen.
    await tick();

    expect(spawner.calls).toHaveLength(2);
    const state = sup.get("vault");
    expect(state?.status).toBe("running");
    expect(state?.pid).toBe(102);
    expect(state?.restartsInWindow).toBe(1);
    expect(state?.lastExitCode).toBe(1);

    second.closeStreams();
    sup.stop("vault");
    second.resolveExit(0);
  });

  test("gives up after maxRestarts crashes in window, marks crashed", async () => {
    const procs = Array.from({ length: 3 }, (_, i) => makeFakeProc(200 + i));
    const spawner = makeQueueSpawner();
    for (const p of procs) spawner.enqueue(p);

    const outputs: string[] = [];
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      maxRestarts: 3,
      restartDelayMs: 0,
      sleep: () => Promise.resolve(),
      output: (line) => outputs.push(line),
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });

    // Crash 3 times in quick succession.
    for (const p of procs) {
      p.closeStreams();
      p.resolveExit(2);
      await tick();
    }

    const state = sup.get("vault");
    expect(state?.status).toBe("crashed");
    expect(state?.restartsInWindow).toBe(3);
    expect(spawner.calls).toHaveLength(3); // initial + 2 restarts; 3rd crash trips the budget.
    expect(outputs.some((l) => l.includes("giving up"))).toBe(true);
  });

  test("crashes outside the window drop off and budget resets", async () => {
    const procs = Array.from({ length: 3 }, (_, i) => makeFakeProc(300 + i));
    const spawner = makeQueueSpawner();
    for (const p of procs) spawner.enqueue(p);

    let nowVal = 1_000_000;
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      maxRestarts: 2,
      restartWindowMs: 5_000,
      restartDelayMs: 0,
      sleep: () => Promise.resolve(),
      now: () => nowVal,
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });

    // First crash at t=0.
    procs[0]?.closeStreams();
    procs[0]?.resolveExit(1);
    await tick();
    expect(sup.get("vault")?.restartsInWindow).toBe(1);

    // Advance past the window; the first crash falls out before the
    // second is counted.
    nowVal += 10_000;
    procs[1]?.closeStreams();
    procs[1]?.resolveExit(1);
    await tick();
    // Budget reset — this crash is alone in its window.
    expect(sup.get("vault")?.restartsInWindow).toBe(1);
    expect(sup.get("vault")?.status).toBe("running");

    procs[2]?.closeStreams();
    sup.stop("vault");
    procs[2]?.resolveExit(0);
  });
});

describe("Supervisor.stop", () => {
  test("operator stop is not a crash — does not restart", async () => {
    const proc = makeFakeProc(101);
    const spawner = makeQueueSpawner();
    spawner.enqueue(proc);
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      restartDelayMs: 0,
      sleep: () => Promise.resolve(),
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });

    await sup.stop("vault");
    expect(proc.killed).toBe(true);
    expect(proc.killSignal).toBe("SIGTERM");

    proc.closeStreams();
    proc.resolveExit(0);
    await tick();

    // No second spawn — stop is an intentional exit.
    expect(spawner.calls).toHaveLength(1);
    expect(sup.get("vault")?.status).toBe("stopped");
  });
});

describe("Supervisor.restart", () => {
  test("stops the current process and spawns fresh", async () => {
    const first = makeFakeProc(101);
    const second = makeFakeProc(102);
    const spawner = makeQueueSpawner();
    spawner.enqueue(first);
    spawner.enqueue(second);

    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      restartDelayMs: 0,
      sleep: () => Promise.resolve(),
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });

    // Kick off restart; we need to resolve the first proc's exited so
    // the awaitable in restart() doesn't hang.
    const restartPromise = sup.restart("vault");
    first.closeStreams();
    first.resolveExit(0);
    const state = await restartPromise;

    expect(state?.status).toBe("running");
    expect(state?.pid).toBe(102);
    expect(spawner.calls).toHaveLength(2);

    second.closeStreams();
    sup.stop("vault");
    second.resolveExit(0);
  });
});

describe("Supervisor output multiplexing", () => {
  test("prefixes child stdout lines with [short]", async () => {
    const proc = makeFakeProc(101);
    const spawner = makeQueueSpawner();
    spawner.enqueue(proc);
    const outputs: string[] = [];
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      output: (line) => outputs.push(line),
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });

    proc.emitStdout("listening on 1940\n");
    proc.emitStdout("ready\n");
    // Allow the async stream reader to flush.
    await tick(20);

    expect(outputs).toContain("[vault] listening on 1940\n");
    expect(outputs).toContain("[vault] ready\n");

    proc.closeStreams();
    sup.stop("vault");
    proc.resolveExit(0);
  });

  test("line-buffers split chunks so partial lines don't break the prefix", async () => {
    const proc = makeFakeProc(101);
    const spawner = makeQueueSpawner();
    spawner.enqueue(proc);
    const outputs: string[] = [];
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      output: (line) => outputs.push(line),
    });
    await sup.start({ short: "scribe", cmd: ["bun", "scribe.ts"] });

    // Single line arriving in two chunks should still be one prefixed
    // line — not "[scribe] listening" + "[scribe]  on 3200\n".
    proc.emitStdout("listening");
    await tick(10);
    proc.emitStdout(" on 3200\n");
    await tick(20);

    expect(outputs).toContain("[scribe] listening on 3200\n");

    proc.closeStreams();
    sup.stop("scribe");
    proc.resolveExit(0);
  });

  test("multiple children interleave without prefix collisions", async () => {
    const vault = makeFakeProc(101);
    const scribe = makeFakeProc(102);
    const spawner = makeQueueSpawner();
    spawner.enqueue(vault);
    spawner.enqueue(scribe);
    const outputs: string[] = [];
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      output: (line) => outputs.push(line),
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });
    await sup.start({ short: "scribe", cmd: ["bun", "scribe.ts"] });

    vault.emitStdout("vault-line-1\n");
    scribe.emitStdout("scribe-line-1\n");
    vault.emitStderr("vault-err\n");
    await tick(20);

    expect(outputs).toContain("[vault] vault-line-1\n");
    expect(outputs).toContain("[scribe] scribe-line-1\n");
    expect(outputs).toContain("[vault] vault-err\n");

    vault.closeStreams();
    scribe.closeStreams();
    sup.stop("vault");
    sup.stop("scribe");
    vault.resolveExit(0);
    scribe.resolveExit(0);
  });
});

describe("Supervisor.list + get", () => {
  test("list returns snapshot of all supervised modules", async () => {
    const vault = makeFakeProc(101);
    const scribe = makeFakeProc(102);
    const spawner = makeQueueSpawner();
    spawner.enqueue(vault);
    spawner.enqueue(scribe);
    const sup = new Supervisor({ spawnFn: spawner.spawn });

    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });
    await sup.start({ short: "scribe", cmd: ["bun", "scribe.ts"] });

    const states = sup.list();
    expect(states).toHaveLength(2);
    const shorts = states.map((s) => s.short).sort();
    expect(shorts).toEqual(["scribe", "vault"]);

    vault.closeStreams();
    scribe.closeStreams();
    sup.stop("vault");
    sup.stop("scribe");
    vault.resolveExit(0);
    scribe.resolveExit(0);
  });

  test("get returns undefined for an unknown module", () => {
    const sup = new Supervisor({ spawnFn: () => makeFakeProc(0) });
    expect(sup.get("nothing")).toBeUndefined();
  });
});
