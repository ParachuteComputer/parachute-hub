/**
 * Per-module child supervisor for container-mode hub.
 *
 * The on-box flow (`parachute start <svc>`) spawns module daemons
 * detached + unref'd, writes a pidfile, and walks away — process
 * lifecycle becomes the operator's problem (launchd, systemd, or a
 * follow-up `parachute restart`). That shape doesn't work in a
 * container:
 *
 *   - There's no external supervisor watching the children. If vault
 *     crashes, nothing brings it back.
 *   - Render's log viewer only surfaces hub's stdout. A detached child
 *     whose stdout goes to `~/.parachute/<svc>/logs/<svc>.log` is
 *     invisible to the operator clicking through the dashboard.
 *
 * This supervisor solves both. It spawns each module attached (no
 * `detached: true`, no `unref()`), pipes their stdout/stderr through a
 * line-prefixing tap into hub's own stdout (`[vault] …`,
 * `[scribe] …`), watches `proc.exited`, and restarts crashed children
 * up to a small budget before giving up + marking the module
 * `crashed`. The budget keeps a wedged-on-boot module from chewing
 * forever; once it's exhausted the operator sees the crash via /api/modules
 * (or, post-1B, the per-module log view).
 *
 * Out of scope for this module: spawning the hub HTTP server itself
 * (that's `Bun.serve` in the same process), driving the on-box
 * `parachute start <svc>` path (still uses `commands/lifecycle.ts`),
 * persisting child state to disk (transient — re-derived from
 * services.json on boot).
 */

export type ModuleStatus = "starting" | "running" | "stopped" | "crashed" | "restarting";

export interface ModuleState {
  /** Short name (vault / notes / scribe / …). */
  readonly short: string;
  /** Last-observed lifecycle phase. */
  readonly status: ModuleStatus;
  /** PID of the current Bun.spawn child, if any. */
  readonly pid?: number;
  /** ISO timestamp of the most recent spawn. */
  readonly startedAt?: string;
  /** Crash count within the current restart window. Resets after the window passes without a crash. */
  readonly restartsInWindow: number;
  /** ISO timestamp of the most recent crash, or undefined if never crashed. */
  readonly lastCrashAt?: string;
  /** Exit code of the most recent crash. */
  readonly lastExitCode?: number | null;
}

export interface SpawnRequest {
  /** Short name — used as the log prefix and the supervisor map key. */
  readonly short: string;
  /** argv passed to `Bun.spawn`. */
  readonly cmd: readonly string[];
  /** Optional cwd for the child. */
  readonly cwd?: string;
  /**
   * Optional env merged on top of `process.env`. The supervisor doesn't
   * mutate `process.env`; the merge happens at spawn time.
   */
  readonly env?: Record<string, string>;
}

export interface SupervisorOpts {
  /**
   * Max crashes within `restartWindowMs` before the supervisor gives up
   * and marks the module `crashed`. Default 3 — enough to ride out a
   * transient race (DB lock, port still releasing), few enough to stop
   * a wedged-on-boot module from looping forever.
   */
  readonly maxRestarts?: number;
  /**
   * Sliding window for the restart budget, in ms. A crash older than
   * this falls out of the count. Default 60_000 (1 minute).
   */
  readonly restartWindowMs?: number;
  /**
   * Delay between a crash being observed and the restart spawn, in ms.
   * Default 500 — gives sockets time to release on EADDRINUSE.
   */
  readonly restartDelayMs?: number;
  /**
   * Where prefixed child output goes. Default `process.stdout.write`.
   * Tests inject a collector so they can assert on the multiplexed
   * stream without spelunking stdout.
   */
  readonly output?: (line: string) => void;
  /**
   * Test seam over `Bun.spawn`. Returns a Subprocess-shaped handle.
   */
  readonly spawnFn?: SpawnFn;
  /**
   * Test seam over wall-clock. Production passes `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Test seam over `setTimeout`. Production resolves a real Promise
   * with `setTimeout`. Tests stub to advance time deterministically.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Subprocess-shaped seam. Production passes through to `Bun.spawn`;
 * tests construct a fake that exposes a controllable `exited` Promise
 * and pipe-able stdout/stderr.
 */
export type SpawnFn = (req: SpawnRequest) => SupervisedProc;

/**
 * The minimal Subprocess shape the supervisor depends on. Bun's real
 * `Subprocess` matches this; the test fake mirrors it.
 */
export interface SupervisedProc {
  readonly pid: number;
  readonly exited: Promise<number | null>;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  kill(signal?: NodeJS.Signals | number): void;
}

const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_WINDOW_MS = 60_000;
const DEFAULT_RESTART_DELAY_MS = 500;

/**
 * Per-module supervisor. Owns the spawn → watch → restart loop.
 *
 * Single-process semantics: instances of `Supervisor` aren't safe to
 * share across processes (the underlying Subprocess handles are
 * process-local). Hub creates one Supervisor per `parachute serve`
 * boot and threads it into the API handlers.
 */
export class Supervisor {
  private readonly opts: Required<Omit<SupervisorOpts, "spawnFn">> & {
    readonly spawnFn: SpawnFn;
  };
  private readonly modules = new Map<string, ModuleEntry>();

  constructor(opts: SupervisorOpts = {}) {
    this.opts = {
      maxRestarts: opts.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      restartWindowMs: opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS,
      restartDelayMs: opts.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      output: opts.output ?? ((line) => process.stdout.write(line)),
      spawnFn: opts.spawnFn ?? defaultSpawnFn,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  /**
   * Spawn a module under supervision. Idempotent: re-spawning an
   * already-running module is a no-op (returns the existing state).
   * Re-spawning a previously-crashed module clears the crash budget
   * and starts fresh.
   */
  async start(req: SpawnRequest): Promise<ModuleState> {
    const existing = this.modules.get(req.short);
    if (existing && (existing.state.status === "running" || existing.state.status === "starting")) {
      return existing.state;
    }
    // Crashed → operator intent is "try again." Wipe the budget.
    const entry: ModuleEntry = {
      req,
      state: {
        short: req.short,
        status: "starting",
        restartsInWindow: 0,
      },
      crashStamps: [],
    };
    this.modules.set(req.short, entry);
    this.spawnAndWatch(entry);
    return entry.state;
  }

  /**
   * Stop a supervised module. Sends SIGTERM, marks the state
   * `stopped`, and detaches the exit watcher so a normal termination
   * isn't seen as a crash. Idempotent on already-stopped modules.
   */
  async stop(short: string): Promise<ModuleState | undefined> {
    const entry = this.modules.get(short);
    if (!entry) return undefined;
    entry.stopRequested = true;
    if (entry.proc) {
      try {
        entry.proc.kill("SIGTERM");
      } catch {
        // Process may already be dead — fall through.
      }
    }
    entry.state = { ...entry.state, status: "stopped" };
    return entry.state;
  }

  /** Snapshot of every supervised module's current state. */
  list(): ModuleState[] {
    return Array.from(this.modules.values(), (e) => e.state);
  }

  /** Snapshot of a single module's state, or undefined if not supervised. */
  get(short: string): ModuleState | undefined {
    return this.modules.get(short)?.state;
  }

  /**
   * Restart a supervised module: stop, wait for exit, start with the
   * same SpawnRequest. Used by the `/api/modules/:name/restart`
   * handler. The on-box `parachute restart <svc>` path stays on
   * `commands/lifecycle.ts` — different surface, different ownership.
   */
  async restart(short: string): Promise<ModuleState | undefined> {
    const entry = this.modules.get(short);
    if (!entry) return undefined;
    const req = entry.req;
    entry.state = { ...entry.state, status: "restarting" };
    await this.stop(short);
    // Wait for the prior process to actually exit so the new spawn
    // doesn't race on EADDRINUSE.
    if (entry.proc) {
      try {
        await entry.proc.exited;
      } catch {
        // exited promise rejection is non-fatal — we're stopping anyway.
      }
    }
    // Drop the entry so `start` treats this as a clean spawn.
    this.modules.delete(short);
    return this.start(req);
  }

  private spawnAndWatch(entry: ModuleEntry): void {
    const proc = this.opts.spawnFn(entry.req);
    entry.proc = proc;
    entry.state = {
      ...entry.state,
      status: "running",
      pid: proc.pid,
      startedAt: new Date(this.opts.now()).toISOString(),
    };
    this.pipeOutput(entry.req.short, proc);
    void proc.exited.then((exitCode) => this.handleExit(entry, exitCode));
  }

  private async handleExit(entry: ModuleEntry, exitCode: number | null): Promise<void> {
    // Operator-driven stop: not a crash, don't restart.
    if (entry.stopRequested) {
      entry.state = {
        ...entry.state,
        status: "stopped",
        pid: undefined,
        lastExitCode: exitCode,
      };
      return;
    }

    const now = this.opts.now();
    // Drop crashes older than the window before counting.
    const cutoff = now - this.opts.restartWindowMs;
    entry.crashStamps = entry.crashStamps.filter((t) => t >= cutoff);
    entry.crashStamps.push(now);

    if (entry.crashStamps.length >= this.opts.maxRestarts) {
      this.opts.output(
        `[supervisor] ${entry.req.short} crashed ${entry.crashStamps.length}x within ${this.opts.restartWindowMs}ms — giving up.\n`,
      );
      entry.state = {
        ...entry.state,
        status: "crashed",
        pid: undefined,
        lastCrashAt: new Date(now).toISOString(),
        lastExitCode: exitCode,
        restartsInWindow: entry.crashStamps.length,
      };
      return;
    }

    entry.state = {
      ...entry.state,
      status: "restarting",
      pid: undefined,
      lastCrashAt: new Date(now).toISOString(),
      lastExitCode: exitCode,
      restartsInWindow: entry.crashStamps.length,
    };
    this.opts.output(
      `[supervisor] ${entry.req.short} exited (code=${exitCode ?? "?"}); restart ${entry.crashStamps.length}/${this.opts.maxRestarts} in window.\n`,
    );
    await this.opts.sleep(this.opts.restartDelayMs);
    // Operator may have called stop() during the sleep — re-check.
    if (entry.stopRequested) return;
    this.spawnAndWatch(entry);
  }

  /**
   * Tap a child's stdout + stderr into the supervisor's `output`
   * callback (hub's stdout by default), prefixing each line with the
   * module's short name. Line-buffered: partial chunks accumulate
   * until a newline arrives so multi-byte log lines don't get
   * scrambled across modules.
   */
  private pipeOutput(short: string, proc: SupervisedProc): void {
    const prefix = `[${short}] `;
    if (proc.stdout) void pumpLines(proc.stdout, prefix, this.opts.output);
    if (proc.stderr) void pumpLines(proc.stderr, prefix, this.opts.output);
  }
}

interface ModuleEntry {
  req: SpawnRequest;
  state: ModuleState;
  proc?: SupervisedProc;
  crashStamps: number[];
  stopRequested?: boolean;
}

async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  output: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Flush every complete line; keep the partial tail buffered.
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl + 1);
        output(prefix + line);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    // Flush any trailing partial line so we don't drop a module's
    // last log message (it's likely the most important one — the
    // exit cause).
    if (buf.length > 0) output(`${prefix + buf}\n`);
  } finally {
    reader.releaseLock();
  }
}

const defaultSpawnFn: SpawnFn = (req) => {
  const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (req.cwd) spawnOpts.cwd = req.cwd;
  if (req.env) spawnOpts.env = { ...process.env, ...req.env };
  const proc = Bun.spawn([...req.cmd], spawnOpts);
  return proc as unknown as SupervisedProc;
};
