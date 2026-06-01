import { describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import {
  type KillFn,
  type SpawnRequest,
  type SupervisedProc,
  Supervisor,
  defaultKillGroup,
} from "../supervisor.ts";

/**
 * A `killFn` stub that records every (pid, signal) it receives and forwards
 * the signal to the matching fake proc's own `kill` (so fakes that model
 * "only SIGKILL terminates me" still work). Mirrors how production's
 * `defaultKillGroup` would signal the process group, but stays in-process +
 * deterministic. Tests assert on `.calls` to prove a group send (negative
 * pid) happened. `register` wires a fake's pid → its `kill`.
 */
function makeKillRecorder(): {
  killFn: KillFn;
  calls: Array<{ pid: number; signal: NodeJS.Signals | number }>;
  register: (proc: FakeProc) => void;
} {
  const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
  const byPid = new Map<number, FakeProc>();
  return {
    calls,
    register: (proc) => byPid.set(proc.pid, proc),
    killFn: (pid, signal) => {
      calls.push({ pid, signal });
      // Production signals the group via the negative pid; the supervisor
      // passes the positive leader pid, so map back to the fake by |pid|.
      byPid.get(Math.abs(pid))?.kill(signal);
    },
  };
}

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

/**
 * No-op kill seam for tests that exercise `stop()`/`restart()` only as
 * lifecycle cleanup and don't assert on the signal. Keeps the default
 * `defaultKillGroup` (which calls the real `process.kill`) from firing a
 * signal at a fake pid that could collide with a real process on the host.
 */
const noopKill: KillFn = () => {};

describe("Supervisor.start + status transitions", () => {
  test("transitions starting → running after spawn", async () => {
    const proc = makeFakeProc(123);
    const spawner = makeQueueSpawner();
    spawner.enqueue(proc);
    const sup = new Supervisor({ spawnFn: spawner.spawn, killFn: noopKill });

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
    const sup = new Supervisor({ spawnFn: spawner.spawn, killFn: noopKill });

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
      killFn: noopKill,
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
      killFn: noopKill,
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
      killFn: noopKill,
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
    const killer = makeKillRecorder();
    killer.register(proc);
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      killFn: killer.killFn,
      restartDelayMs: 0,
      sleep: () => Promise.resolve(),
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });

    // stop() now awaits proc.exited (with SIGKILL escalation on
    // timeout) — kick it off, observe the SIGTERM landed, then
    // resolve exited so the await completes.
    const stopPromise = sup.stop("vault");
    expect(proc.killed).toBe(true);
    expect(proc.killSignal).toBe("SIGTERM");
    // The signal is sent through the group-aware killFn seam (hub#88), with
    // the child's leader pid.
    expect(killer.calls).toEqual([{ pid: 101, signal: "SIGTERM" }]);

    proc.closeStreams();
    proc.resolveExit(0);
    await stopPromise;

    // No second spawn — stop is an intentional exit.
    expect(spawner.calls).toHaveLength(1);
    expect(sup.get("vault")?.status).toBe("stopped");
  });

  test("escalates to SIGKILL when child ignores SIGTERM past killTimeoutMs", async () => {
    // Child that refuses to exit on SIGTERM. The fake records every
    // signal it receives; the supervisor should send SIGTERM,
    // observe no exit, then send SIGKILL after the timeout.
    const proc = makeFakeProc(101);
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    proc.kill = (signal) => {
      signals.push(signal);
      // Only SIGKILL actually terminates this fake child — SIGTERM
      // gets logged and ignored, simulating the wedged-module shape.
      if (signal === "SIGKILL") proc.resolveExit(null);
    };
    const spawner = makeQueueSpawner();
    spawner.enqueue(proc);
    const killer = makeKillRecorder();
    killer.register(proc);
    const outputs: string[] = [];
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      killFn: killer.killFn,
      restartDelayMs: 0,
      sleep: () => Promise.resolve(),
      killTimeoutMs: 5, // Short timeout so the test doesn't pause for 5s.
      output: (line) => outputs.push(line),
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });

    proc.closeStreams();
    await sup.stop("vault");

    // SIGTERM first, then SIGKILL after the timeout — both via the group-aware
    // killFn seam with the leader pid.
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(killer.calls).toEqual([
      { pid: 101, signal: "SIGTERM" },
      { pid: 101, signal: "SIGKILL" },
    ]);
    expect(outputs.some((l) => l.includes("escalating to SIGKILL"))).toBe(true);
    expect(sup.get("vault")?.status).toBe("stopped");
  });

  test("stop awaits child exit before returning (no SIGKILL needed)", async () => {
    // Well-behaved child: exits ~10ms after SIGTERM. stop() should
    // return only after the exit promise resolves, not immediately
    // post-SIGTERM. This is the log-flush guarantee that motivated
    // the await in the first place (hub#263).
    const proc = makeFakeProc(101);
    proc.kill = (signal) => {
      signals.push(signal);
      // Simulate the child taking a few ms to flush + exit.
      setTimeout(() => proc.resolveExit(0), 5);
    };
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    const spawner = makeQueueSpawner();
    spawner.enqueue(proc);
    const killer = makeKillRecorder();
    killer.register(proc);
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      killFn: killer.killFn,
      restartDelayMs: 0,
      sleep: () => Promise.resolve(),
      killTimeoutMs: 1000, // Plenty of headroom for the 5ms simulated exit.
    });
    await sup.start({ short: "vault", cmd: ["bun", "vault.ts"] });

    proc.closeStreams();
    let exitObservedBeforeReturn = false;
    void proc.exited.then(() => {
      exitObservedBeforeReturn = true;
    });
    await sup.stop("vault");

    // The exited-resolver awaited the same promise stop() did; if
    // stop returned without awaiting, this flag could still be false.
    // (Both promise chains fire from the same resolveExit call.
    // Microtask ordering guarantees they both run before await returns.)
    expect(exitObservedBeforeReturn).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
    expect(killer.calls).toEqual([{ pid: 101, signal: "SIGTERM" }]);
    expect(sup.get("vault")?.status).toBe("stopped");
  });
});

describe("Supervisor process-group reaping (hub#88 — EADDRINUSE-on-restart regression)", () => {
  /** Grab a free loopback port by opening + immediately closing a server. */
  async function freeEphemeralPort(): Promise<number> {
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    // `port` is `number | undefined` in Bun's types, but a live Bun.serve()
    // always has a bound port — assert it so the test stays type-clean.
    const port = probe.port as number;
    probe.stop(true);
    return port;
  }

  /** Connect-probe loopback:port — true if something is accepting. */
  function portListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket();
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(v);
      };
      socket.setTimeout(500);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
      socket.connect(port, "127.0.0.1");
    });
  }

  /** Poll until `pred()` is true or the deadline passes. Returns the outcome. */
  async function waitFor(pred: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await pred()) return true;
      await tick(25);
    }
    return pred();
  }

  test("stop signals the whole process group, not just the leader (deterministic seam check)", async () => {
    // The load-bearing contract: the supervisor hands `killFn` the child's
    // LEADER pid, and production's `defaultKillGroup` translates that into a
    // group send (`process.kill(-pid)`). A faithful stub records what `killFn`
    // received; we assert the supervisor signalled with the leader pid so the
    // group (wrapper + grandchildren) is reaped together. This is the
    // deterministic counterpart to the real-process round-trip below.
    const leader = makeFakeProc(4242);
    const spawner = makeQueueSpawner();
    spawner.enqueue(leader);
    const killer = makeKillRecorder();
    killer.register(leader);
    const sup = new Supervisor({
      spawnFn: spawner.spawn,
      killFn: killer.killFn,
      restartDelayMs: 0,
      sleep: () => Promise.resolve(),
    });
    await sup.start({ short: "wrapped", cmd: ["sh", "-c", "tsx server.ts"] });

    const stopP = sup.stop("wrapped");
    leader.closeStreams();
    leader.resolveExit(0);
    await stopP;

    // killFn received the LEADER pid (4242) — production's defaultKillGroup
    // turns this into `process.kill(-4242)`, reaping the wrapper's whole group
    // incl. the tsx grandchild that would otherwise hold the port (hub#88).
    expect(killer.calls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  });

  test("defaultKillGroup sends to the negative (group) pid, falling back to bare pid on ESRCH", () => {
    // Drive the real defaultKillGroup against a stubbed process.kill so we can
    // assert the group-vs-bare-pid syscall shape without signalling anything.
    const realKill = process.kill;
    const calls: Array<{ pid: number; signal: string | number }> = [];
    try {
      // Case 1: group send succeeds → only the negative-pid call happens.
      (process as { kill: typeof process.kill }).kill = ((
        pid: number,
        signal?: string | number,
      ) => {
        calls.push({ pid, signal: signal ?? 0 });
        return true;
      }) as typeof process.kill;
      defaultKillGroup(555, "SIGTERM");
      expect(calls).toEqual([{ pid: -555, signal: "SIGTERM" }]);

      // Case 2: group send throws ESRCH (no group / pre-detached child) →
      // fall back to a bare-pid send. Mirrors lifecycle.defaultKill.
      calls.length = 0;
      (process as { kill: typeof process.kill }).kill = ((
        pid: number,
        signal?: string | number,
      ) => {
        calls.push({ pid, signal: signal ?? 0 });
        if (pid < 0) {
          const err = new Error("no such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      }) as typeof process.kill;
      defaultKillGroup(777, "SIGKILL");
      expect(calls).toEqual([
        { pid: -777, signal: "SIGKILL" },
        { pid: 777, signal: "SIGKILL" },
      ]);

      // Case 3: a non-ESRCH error propagates (we never swallow EPERM etc.).
      (process as { kill: typeof process.kill }).kill = (() => {
        const err = new Error("operation not permitted") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }) as typeof process.kill;
      expect(() => defaultKillGroup(888, "SIGTERM")).toThrow("operation not permitted");
    } finally {
      process.kill = realKill;
    }
  });

  test("a wrapped startCmd's grandchild is reaped on restart → fresh spawn re-binds the same port (no EADDRINUSE)", async () => {
    const port = await freeEphemeralPort();
    // Wrapper (the leader the supervisor spawns) backgrounds a *grandchild*
    // bun listener that holds the port, then `wait`s on it. Pre-hub#88, the
    // supervisor killed only the leader (`sh`) — the bun grandchild kept the
    // socket, so the restart's fresh spawn hit EADDRINUSE. With group-spawn
    // (`detached: true`) + group-kill (`defaultKillGroup`), the whole group
    // dies and the port frees.
    const listener = [
      "bun",
      "-e",
      `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("ok") }); setInterval(() => {}, 1e9);`,
    ];
    const wrapper = ["sh", "-c", `${listener.map((a) => `'${a}'`).join(" ")} & wait`];

    // Real spawnFn + real defaultKillGroup (no seams) — this is the whole point.
    const sup = new Supervisor({ restartDelayMs: 50 });
    try {
      await sup.start({ short: "wrapped", cmd: wrapper });

      // Grandchild binds the port.
      expect(await waitFor(() => portListening(port), 8000)).toBe(true);

      // Restart: stop (group-kill reaps the grandchild) → wait for the port
      // to FREE → fresh spawn re-binds it. If the grandchild leaked, the
      // fresh listener would EADDRINUSE-crash and the port would either stay
      // held by the orphan or flap — the round-trip below would fail.
      const restarted = await sup.restart("wrapped");
      expect(restarted?.status).toBe("running");

      // The port answers again under the fresh spawn — proves no EADDRINUSE.
      expect(await waitFor(() => portListening(port), 8000)).toBe(true);

      // The discriminating signal: after a final stop, the port FREES. If the
      // group-kill failed to reach the bun grandchild, an orphan would keep
      // the socket and this would never go quiet.
      await sup.stop("wrapped");
      expect(await waitFor(async () => !(await portListening(port)), 8000)).toBe(true);
    } finally {
      await sup.stop("wrapped").catch(() => {});
    }
  }, 20_000);
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
      killFn: noopKill,
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
      killFn: noopKill,
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
      killFn: noopKill,
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
      killFn: noopKill,
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
    const sup = new Supervisor({ spawnFn: spawner.spawn, killFn: noopKill });

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
