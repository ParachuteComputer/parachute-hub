/**
 * The hub's in-process module supervisor — the single runtime everywhere.
 *
 * As of Phase 5b there is ONE process model: `parachute serve` runs the hub
 * in the foreground with this Supervisor, and the platform's process manager
 * (launchd on a Mac, systemd on a Linux VM, the container runtime on Render /
 * Fly) keeps that `serve` process alive across crashes and reboots. The old
 * manager-less detached-daemon model (per-module `detached + unref()` spawns
 * tracked by pidfiles) is retired — the on-box `parachute start/stop/restart
 * <svc>` verbs are now clients of THIS supervisor, driving it over the
 * loopback module-ops API (`api-modules-ops.ts` → `commands/lifecycle.ts`).
 *
 * What this supervisor does:
 *
 *   - Spawns each module as an attached child in its own process group
 *     (`detached: true` for group-signalling only; stdio stays piped — see
 *     `defaultSpawnFn` / `defaultKillGroup`), so a wrapped startCmd's
 *     grandchildren are reaped on stop/restart (no EADDRINUSE-on-restart).
 *   - Pipes each child's stdout/stderr through a line-prefixing tap into the
 *     hub's own stdout (`[vault] …`, `[scribe] …`) and a bounded per-module
 *     ring buffer, so the operator sees module output in the hub log /
 *     platform log viewer and `parachute logs <svc>` can replay recent lines.
 *   - Gates a freshly-spawned module to `running` only once its port binds
 *     (port-readiness), and records a structured start-error on preflight
 *     failure, so `status` / the SPA keep the friendly missing-dependency
 *     surface.
 *   - Watches `proc.exited` and crash-restarts children up to a small budget
 *     before marking the module `crashed`. The budget keeps a wedged-on-boot
 *     module from chewing forever; the hub unit's own StartLimit / Throttle
 *     bounds the outer keeper.
 *
 * Out of scope: supervising the hub HTTP server itself (that's `Bun.serve` in
 * this same process — the platform manager is the hub's keeper) and persisting
 * child state to disk (transient — re-derived from services.json on every boot).
 */

import {
  MissingDependencyError,
  type MissingDependencyWire,
  ensureExecutable,
  rethrowIfMissing,
} from "@openparachute/depcheck";
import { type PortListeningFn, defaultPortListening } from "./port-probe.ts";

export type ModuleStatus = "starting" | "running" | "stopped" | "crashed" | "restarting";

/**
 * Structured start-failure detail recorded onto `ModuleState` (§6.5). Mirrors
 * depcheck's `MissingDependencyWire` for the missing-dependency case and the
 * services.json-row `ServiceEntryStartError` shape `commands/lifecycle.ts`
 * records, so `status` / the SPA keep the SAME friendly missing-dependency
 * surface whether a module was started via the detached path or the
 * supervisor. `error_type` is left open for a future non-dependency failure.
 */
export interface ModuleStartError {
  readonly error_type: string;
  readonly error_description: string;
  /** Present for `error_type: "missing_dependency"`. */
  readonly binary?: string;
  readonly why?: string | null;
  readonly docs_url?: string | null;
  readonly install?: { darwin?: string; linux?: string; generic?: string };
  readonly sysadmin_hint?: string;
  /** ISO timestamp of when the failure was recorded. */
  readonly at: string;
}

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
  /**
   * Structured start-failure detail (§6.5). Set when a preflight
   * `MissingDependencyError` aborts the spawn, OR when a spawned child stays
   * alive but never binds its port within the readiness window
   * (started-but-unbound, hub#487). Cleared on a clean, port-confirmed start.
   * The `status` enum is intentionally NOT extended (proxy-state Mode-1 + the
   * SPA read `running`); this field carries the friendly diagnostic instead.
   */
  readonly startError?: ModuleStartError;
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
   * Max time to wait for a child to exit after SIGTERM before
   * escalating to SIGKILL, in ms. Default 5000 — long enough for a
   * well-behaved module to flush its log buffer + drop its listeners,
   * short enough that a wedged child doesn't keep `stop()` (and the
   * container shutdown path that calls it) hanging indefinitely.
   *
   * Tests pass a short timeout (1–10ms) to exercise the SIGKILL
   * escalation path without real waiting.
   */
  readonly killTimeoutMs?: number;
  /**
   * Where prefixed child output goes. Default `process.stdout.write`.
   * Tests inject a collector so they can assert on the multiplexed
   * stream without spelunking stdout.
   */
  readonly output?: (line: string) => void;
  /**
   * Cap, in bytes, of the per-module log ring buffer (§6.5). The supervisor
   * keeps the most-recent ~`logBufferBytes` of each child's output so a
   * `GET /api/modules/:short/logs` tap can replay the boot/crash lines that
   * happened *before* the reader connected — the detached path got this for
   * free via the per-service logfile; the supervisor streams-and-discards, so
   * without a buffer the crash cause (the most important line) is lost. The
   * oldest whole lines are dropped once the cap is exceeded. Default 64 KiB.
   */
  readonly logBufferBytes?: number;
  /**
   * Test seam over `Bun.spawn`. Returns a Subprocess-shaped handle.
   */
  readonly spawnFn?: SpawnFn;
  /**
   * Group-aware kill seam (hub#88). Production sends the signal to the child's
   * whole process group (`process.kill(-pid, signal)`) so wrapped startCmds
   * like `pnpm exec tsx server.ts` reap the tsx grandchild — not just the
   * wrapper that would otherwise leave the grandchild bound to the port →
   * EADDRINUSE on restart. Pairs with `defaultSpawnFn`'s `detached: true`
   * (each child is its own process-group leader, `pid === pgid`). Defaults to
   * {@link defaultKillGroup}; tests inject a stub so they stay deterministic
   * (no real signals) and can assert the negative pid (group send) was used.
   */
  readonly killFn?: KillFn;
  /**
   * Test seam over wall-clock. Production passes `Date.now`.
   */
  readonly now?: () => number;
  /**
   * Test seam over `setTimeout`. Production resolves a real Promise
   * with `setTimeout`. Tests stub to advance time deterministically.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Port-readiness probe (§6.5). After a child spawns, the supervisor polls
   * this until the module's port (from `req.env.PORT`) binds, to catch the
   * alive-but-never-bound shape (hub#487). Defaults to `defaultPortListening`
   * (a loopback TCP connect). Tests inject a deterministic stub.
   *
   * Defaulting policy (mirrors `commands/lifecycle.ts`): the readiness gate is
   * SKIPPED unless this is the production path (no `spawnFn` override) OR a
   * test explicitly opts in by injecting `portListening` / `startReadyMs`.
   * Without that guard, every existing stub-spawner test (fake procs that
   * never bind a real port) would block the full readiness window.
   */
  readonly portListening?: PortListeningFn;
  /**
   * How long the post-spawn port-readiness gate polls before recording a
   * `started-but-unbound` start-error, in ms. Default 4000 on the production
   * path; 0 (skipped) on the stub-spawner test path unless `portListening` /
   * `startReadyMs` is set explicitly.
   */
  readonly startReadyMs?: number;
  /** Poll interval while waiting for the port to bind, in ms. Default 200. */
  readonly startReadyPollMs?: number;
  /**
   * How long the background late-bind watch keeps re-probing AFTER the
   * readiness window elapsed with the port unbound, in ms. Heavy modules
   * (vault — SQLite + git mirror + well-known init) can legitimately take
   * longer than `startReadyMs` to bind; without a re-probe the recorded
   * `started_but_unbound` note sticks for the module's whole lifetime and
   * `parachute status` shows a perpetual "failed to start" on a healthy
   * module. The watch clears the note once the port binds. Default 60s;
   * `0` disables the watch (the note then behaves as before).
   */
  readonly lateBindWatchMs?: number;
  /** Poll interval for the late-bind watch, in ms. Default 1000. */
  readonly lateBindPollMs?: number;
  /**
   * PATH-resolution seam for the pre-spawn `ensureExecutable` preflight
   * (`@openparachute/depcheck`). Production uses the real `Bun.which`; a
   * missing startCmd binary then aborts the spawn with a structured
   * `MissingDependencyError` recorded onto `ModuleState.startError`.
   *
   * Defaulting policy mirrors the readiness gate: a stub `spawnFn` (test path)
   * gets a permissive resolver so the preflight doesn't trip on binaries
   * absent from the test host's PATH; production gets the real `Bun.which`.
   * Tests exercising the missing-binary branch inject `which: () => null`.
   */
  readonly which?: (cmd: string) => string | null;
}

/**
 * Subprocess-shaped seam. Production passes through to `Bun.spawn`;
 * tests construct a fake that exposes a controllable `exited` Promise
 * and pipe-able stdout/stderr.
 */
export type SpawnFn = (req: SpawnRequest) => SupervisedProc;

/**
 * Group-aware kill seam. Sends `signal` to the process group rooted at `pid`.
 * Production uses {@link defaultKillGroup}; tests inject a stub.
 */
export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;

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
const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_LOG_BUFFER_BYTES = 64 * 1024;
const DEFAULT_START_READY_MS = 4_000;
const DEFAULT_START_READY_POLL_MS = 200;
const DEFAULT_LATE_BIND_WATCH_MS = 60_000;
const DEFAULT_LATE_BIND_POLL_MS = 1_000;

/**
 * Bounded, line-oriented ring buffer (§6.5). Holds the most-recent lines of a
 * module's output up to `maxBytes`; pushing past the cap drops whole lines
 * from the front (oldest-first) until it fits. Bounding by bytes (not line
 * count) keeps a chatty module from pinning unbounded memory regardless of
 * line length. Each pushed string is already a single prefixed line from
 * `pumpLines` (it includes its trailing newline).
 */
export class LogRingBuffer {
  private readonly lines: string[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  push(line: string): void {
    this.lines.push(line);
    this.bytes += Buffer.byteLength(line);
    // Drop oldest whole lines until we're back under the cap. A single line
    // larger than the cap is kept (we never split a line) — the alternative
    // (dropping it) would lose exactly the long stack-trace we most want.
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      const dropped = this.lines.shift();
      if (dropped !== undefined) this.bytes -= Buffer.byteLength(dropped);
    }
  }

  /** Snapshot of the buffered lines, oldest-first. */
  snapshot(): string[] {
    return [...this.lines];
  }

  /** Buffered lines joined into a single string (the wire/tail shape). */
  text(): string {
    return this.lines.join("");
  }
}

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
    // Defaulting policy for the port-readiness gate + preflight (§6.5),
    // mirroring `commands/lifecycle.ts`: production (no `spawnFn` override) gets
    // the real 4s readiness window + `Bun.which` preflight. The stub-spawner
    // test path gets 0 (skipped) + a permissive `which` UNLESS a test opts in
    // explicitly (injecting `portListening` / `startReadyMs` / `which`) — so
    // existing fake-proc tests (which never bind a real port) don't block.
    const isProductionPath = opts.spawnFn === undefined;
    const readinessOptedIn = opts.portListening !== undefined || opts.startReadyMs !== undefined;
    this.opts = {
      maxRestarts: opts.maxRestarts ?? DEFAULT_MAX_RESTARTS,
      restartWindowMs: opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS,
      restartDelayMs: opts.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
      killTimeoutMs: opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS,
      output: opts.output ?? ((line) => process.stdout.write(line)),
      logBufferBytes: opts.logBufferBytes ?? DEFAULT_LOG_BUFFER_BYTES,
      spawnFn: opts.spawnFn ?? defaultSpawnFn,
      killFn: opts.killFn ?? defaultKillGroup,
      now: opts.now ?? Date.now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      portListening: opts.portListening ?? defaultPortListening,
      startReadyMs:
        opts.startReadyMs ?? (isProductionPath || readinessOptedIn ? DEFAULT_START_READY_MS : 0),
      startReadyPollMs: opts.startReadyPollMs ?? DEFAULT_START_READY_POLL_MS,
      lateBindWatchMs: opts.lateBindWatchMs ?? DEFAULT_LATE_BIND_WATCH_MS,
      lateBindPollMs: opts.lateBindPollMs ?? DEFAULT_LATE_BIND_POLL_MS,
      which: opts.which ?? (isProductionPath ? Bun.which : () => "/stub/bin/preflight-skipped"),
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
    // A fresh ring buffer per entry — `start` is a clean spawn (the crash-
    // respawn path in `handleExit` reuses the existing entry + buffer, so a
    // crashed module's boot/crash lines survive into the restart for replay).
    const entry: ModuleEntry = {
      req,
      state: {
        short: req.short,
        status: "starting",
        restartsInWindow: 0,
      },
      crashStamps: [],
      logs: new LogRingBuffer(this.opts.logBufferBytes),
    };
    this.modules.set(req.short, entry);

    // Pre-spawn preflight (§6.5): resolve the startCmd binary on PATH before
    // spawning a doomed child. A missing binary records a structured
    // `MissingDependencyError` onto state (the same friendly missing-dependency
    // surface `commands/lifecycle.ts` records) and aborts — no spawn. Mirrors
    // `lifecycle.start`'s `ensureExecutable` preflight.
    const startBinary = req.cmd[0];
    if (startBinary) {
      try {
        ensureExecutable(startBinary, { which: this.opts.which });
      } catch (err) {
        if (err instanceof MissingDependencyError) {
          entry.state = {
            ...entry.state,
            status: "crashed",
            pid: undefined,
            startError: startErrorFromWire(err.toWire(), this.opts.now),
          };
          return entry.state;
        }
        throw err;
      }
    }

    // Belt-and-suspenders for a spawn that slips past the preflight (binary
    // removed between check + spawn, or a path that didn't preflight): a
    // not-found spawn throw becomes the same structured MissingDependencyError
    // recorded onto state, not a throw out of `start`. Mirrors
    // `lifecycle.start`'s `rethrowIfMissing` catch.
    try {
      this.spawnAndWatch(entry);
    } catch (err) {
      if (startBinary) {
        try {
          rethrowIfMissing(err, startBinary);
        } catch (missing) {
          if (missing instanceof MissingDependencyError) {
            entry.state = {
              ...entry.state,
              status: "crashed",
              pid: undefined,
              startError: startErrorFromWire(missing.toWire(), this.opts.now),
            };
            return entry.state;
          }
        }
      }
      throw err;
    }

    // Post-spawn port-readiness gate (§6.5, hub#487). A returned pid only
    // proves the kernel forked the process; it says nothing about whether the
    // module bound its port. Poll the port (from req.env.PORT) up to
    // `startReadyMs`. On success: clear any prior startError. On timeout while
    // the child is still alive: record a `started-but-unbound` structured
    // start-error WITHOUT touching the `running` status enum (proxy-state
    // Mode-1 + the SPA read `running`) — the friendly diagnostic rides the
    // startError field. A child that died during the window is left to the
    // crash watcher (`handleExit`), which owns the restart budget.
    await this.awaitPortReadiness(entry);
    return entry.state;
  }

  /**
   * Poll the module's port until it binds or `startReadyMs` elapses (§6.5).
   * Skipped when the gate is disabled (stub-spawner test path) or the request
   * carries no `PORT`. Records / clears `state.startError` accordingly; never
   * mutates `state.status` (see `start`).
   */
  private async awaitPortReadiness(entry: ModuleEntry): Promise<void> {
    if (this.opts.startReadyMs <= 0) return;
    const portStr = entry.req.env?.PORT;
    const port = portStr ? Number(portStr) : Number.NaN;
    if (!Number.isFinite(port) || port <= 0) return; // No port to probe.

    const deadline = this.opts.now() + this.opts.startReadyMs;
    while (this.opts.now() < deadline) {
      // The child may have crashed during the window — `handleExit` owns that
      // (budget / restart). Stop probing; don't overwrite a crash with a
      // port-readiness verdict.
      if (entry.stopRequested || entry.state.status !== "running") return;
      if (await this.opts.portListening(port)) {
        // Bound → healthy. Clear any stale started-but-unbound error.
        if (entry.state.startError) {
          const { startError: _drop, ...rest } = entry.state;
          entry.state = rest;
        }
        return;
      }
      await this.opts.sleep(this.opts.startReadyPollMs);
    }

    // Window elapsed, still alive but never bound — record the structured
    // started-but-unbound error so `status` / the SPA show why, not a silently
    // healthy `running`. Keep `running` (the process IS up); the diagnostic is
    // the startError field.
    if (entry.state.status === "running" && !entry.stopRequested) {
      entry.state = {
        ...entry.state,
        startError: {
          error_type: "started_but_unbound",
          error_description: `${entry.req.short} started (pid ${entry.state.pid}) but is not listening on port ${port} after ${this.opts.startReadyMs}ms — it may still be coming up, or the port is held by another process.`,
          at: new Date(this.opts.now()).toISOString(),
        },
      };
      // Keep watching in the background: heavy modules (vault) routinely bind
      // a moment after the window. Without the re-probe the note above would
      // stick for the module's whole lifetime — `parachute status` then shows
      // a perpetual "failed to start" on a healthy module. Fire-and-forget so
      // `start()`'s latency stays bounded by `startReadyMs`.
      if (this.opts.lateBindWatchMs > 0) {
        void this.lateBindWatch(entry, port).catch(() => {});
      }
    }
  }

  /**
   * Background re-probe after `awaitPortReadiness` recorded a
   * `started_but_unbound` note: poll (slower cadence, bounded window) and
   * clear the note once the port binds. Exits early when the module stops,
   * crashes, or the note is replaced by a different startError (a later
   * crash-restart's missing-dependency note must not be wiped).
   *
   * Restart safety: a crash-auto-restart reuses the same `entry` object and
   * clears `startError` on respawn — this watch's `error_type` guard then sees
   * `undefined` and exits, so a stale watch from spawn-1 never clobbers
   * spawn-2's state. If spawn-2 also misses its window, its own gate records a
   * fresh note and launches its own watch; two live watches clearing the same
   * note is idempotent. `stop()`/teardown set `stopRequested` before any entry
   * removal, so a watch holding a stale entry ref exits cleanly.
   */
  private async lateBindWatch(entry: ModuleEntry, port: number): Promise<void> {
    const deadline = this.opts.now() + this.opts.lateBindWatchMs;
    while (this.opts.now() < deadline) {
      await this.opts.sleep(this.opts.lateBindPollMs);
      if (entry.stopRequested || entry.state.status !== "running") return;
      // Only OUR note is clearable — anything else was recorded after us.
      if (entry.state.startError?.error_type !== "started_but_unbound") return;
      if (await this.opts.portListening(port)) {
        const { startError: _drop, ...rest } = entry.state;
        entry.state = rest;
        return;
      }
    }
  }

  /**
   * Stop a supervised module. Sends SIGTERM, awaits the child's exit
   * (so the log-pump drains the final flush before our stdout closes),
   * and escalates to SIGKILL if the child doesn't exit within
   * `killTimeoutMs`. Marks the state `stopped` and detaches the exit
   * watcher so a normal termination isn't seen as a crash. Idempotent
   * on already-stopped modules.
   *
   * The await matters in two places:
   *   - Container shutdown (hub PID 1 receiving SIGTERM from Render):
   *     without it, children's final log lines never make it through
   *     hub's stdout pipe before the platform reaps the pod.
   *   - `restart()`: a fresh spawn that races a still-listening prior
   *     PID will fail with EADDRINUSE.
   *
   * The SIGKILL escalation handles a wedged module (e.g. a broken
   * native binding ignoring SIGTERM). Without it, `stop()` would hang
   * forever and a re-deploy would leak the orphaned child until the
   * container itself was recycled.
   */
  async stop(short: string): Promise<ModuleState | undefined> {
    const entry = this.modules.get(short);
    if (!entry) return undefined;
    entry.stopRequested = true;
    const proc = entry.proc;
    if (proc) {
      try {
        // Group-aware kill (hub#88): signal the child's whole process group
        // via `killFn` (default `defaultKillGroup` → `process.kill(-pid)`) so
        // a wrapped startCmd's grandchild is reaped too, not just the wrapper.
        // Mirrors `commands/lifecycle.ts`'s `defaultKill` repointing of
        // `defaultSpawner`'s detached children. Without it, the grandchild
        // stays bound to the port → restart hits EADDRINUSE.
        this.opts.killFn(proc.pid, "SIGTERM");
      } catch {
        // Process may already be dead — fall through.
      }
      // Race the child's exit against the kill timeout. If the timer
      // wins, escalate to SIGKILL. Either way we end up awaiting the
      // exit promise so the log pump drains.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.opts.killTimeoutMs);
      });
      try {
        const winner = await Promise.race([proc.exited.then(() => "exited" as const), timeout]);
        if (winner === "timeout") {
          this.opts.output(
            `[supervisor] ${entry.req.short} did not exit ${this.opts.killTimeoutMs}ms after SIGTERM — escalating to SIGKILL.\n`,
          );
          try {
            // Group-aware SIGKILL escalation — same `killFn` seam as the
            // SIGTERM above so the whole group is reaped, not just the leader.
            this.opts.killFn(proc.pid, "SIGKILL");
          } catch {
            // Process may already be dead between the timeout firing
            // and us reaching kill() — fall through to the await.
          }
          try {
            await proc.exited;
            // SIGKILL cannot be caught; OS reaps the child promptly.
          } catch {
            // exited rejection is non-fatal — we're stopping anyway.
          }
        }
      } finally {
        clearTimeout(timer!);
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
    // stop() now awaits the prior process's exit (with SIGKILL
    // escalation) before returning, so the fresh spawn below doesn't
    // race on EADDRINUSE — no separate await needed here.
    await this.stop(short);
    // Drop the entry so `start` treats this as a clean spawn.
    this.modules.delete(short);
    return this.start(req);
  }

  private spawnAndWatch(entry: ModuleEntry): void {
    const proc = this.opts.spawnFn(entry.req);
    entry.proc = proc;
    // Clear any stale startError from a prior attempt — a fresh running pid is
    // the new ground truth; the readiness gate re-records if it still doesn't
    // bind.
    const { startError: _drop, ...prev } = entry.state;
    entry.state = {
      ...prev,
      status: "running",
      pid: proc.pid,
      startedAt: new Date(this.opts.now()).toISOString(),
    };
    this.pipeOutput(entry, proc);
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
   * Recent buffered output for a supervised module (§6.5), oldest-first, each
   * element a prefixed line. Returns `undefined` for a module that isn't
   * supervised (no entry) so a `GET /api/modules/:short/logs` handler can
   * distinguish "not supervised" (404) from "supervised but quiet" (empty
   * array). Survives a crash-respawn (same entry/buffer), so the boot/crash
   * lines that preceded the reader connecting are replayable — the whole point.
   */
  logs(short: string): string[] | undefined {
    return this.modules.get(short)?.logs.snapshot();
  }

  /**
   * Tap a child's stdout + stderr into the supervisor's `output` callback
   * (hub's stdout by default) AND the per-module ring buffer (§6.5),
   * prefixing each line with the module's short name. Line-buffered: partial
   * chunks accumulate until a newline arrives so multi-byte log lines don't
   * get scrambled across modules. The buffer is fed the same prefixed lines
   * the live stream gets, so a later `/logs` tap replays exactly what hub's
   * stdout already showed.
   */
  private pipeOutput(entry: ModuleEntry, proc: SupervisedProc): void {
    const prefix = `[${entry.req.short}] `;
    const sink = (line: string): void => {
      this.opts.output(line);
      entry.logs.push(line);
    };
    if (proc.stdout) void pumpLines(proc.stdout, prefix, sink);
    if (proc.stderr) void pumpLines(proc.stderr, prefix, sink);
  }
}

interface ModuleEntry {
  req: SpawnRequest;
  state: ModuleState;
  proc?: SupervisedProc;
  crashStamps: number[];
  stopRequested?: boolean;
  /** Bounded ring buffer of recent prefixed output lines (§6.5). */
  logs: LogRingBuffer;
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
    // Keep stdout/stderr explicitly piped — the supervisor pumps child output
    // into hub's log (`pipeOutput`/`pumpLines`) + the per-module ring buffer.
    // `detached: true` does NOT detach explicitly-piped stdio, so these stay
    // wired even though the child gets its own process group below.
    stdio: ["ignore", "pipe", "pipe"],
    // Spawn in a fresh process group (pid == pgid) so `killFn` (→
    // `process.kill(-pid, sig)`) reaches every descendant, not just the
    // wrapper. Without this, wrapped startCmds like `pnpm exec tsx server.ts`
    // leave the tsx grandchild bound to the port after stop → restart hits
    // EADDRINUSE (hub#88). Mirrors `commands/lifecycle.ts`'s `defaultSpawner`,
    // which set `detached: true` for exactly this reason. We do NOT `unref()`:
    // the supervisor must stay attached for the lifecycle (watch `exited`,
    // pump output, reap on stop).
    detached: true,
    // Inherit env so supervised module sees PATH, HOME, PARACHUTE_HOME, etc.
    // Bun.spawn defaults to empty env — see api-modules-ops.ts:defaultRun.
    // Per-call `req.env` overrides merge on top below.
    env: process.env,
  };
  if (req.cwd) spawnOpts.cwd = req.cwd;
  if (req.env) spawnOpts.env = { ...process.env, ...req.env };
  const proc = Bun.spawn([...req.cmd], spawnOpts);
  return proc as unknown as SupervisedProc;
};

/**
 * Map a depcheck `MissingDependencyWire` onto the `ModuleStartError` shape
 * recorded on `ModuleState` (§6.5), stamping `at`. The wire's field names
 * already match (binary / why / docs_url / install / sysadmin_hint), so this
 * is a stamp + passthrough — keeping the supervisor's start-error surface
 * identical to the services.json `ServiceEntryStartError` the detached path
 * records, so the SPA renders the same install card from either source.
 */
function startErrorFromWire(wire: MissingDependencyWire, now: () => number): ModuleStartError {
  return {
    error_type: wire.error_type,
    error_description: wire.error_description,
    binary: wire.binary,
    why: wire.why,
    docs_url: wire.docs_url,
    install: wire.install,
    sysadmin_hint: wire.sysadmin_hint,
    at: new Date(now()).toISOString(),
  };
}

/**
 * Production group-aware kill (hub#88). Sends `signal` to the entire process
 * group rooted at `pid` (the negative-pid syscall) so a wrapped startCmd's
 * grandchildren are reaped alongside the wrapper. Mirrors
 * `commands/lifecycle.ts`'s `defaultKill`: on ESRCH the group is already gone
 * (or the child predates the detached-spawn change and has no group with that
 * pgid) — fall back to a bare-pid signal so the caller's intent still lands
 * when there's a positive-pid process to receive it.
 */
export const defaultKillGroup: KillFn = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    process.kill(pid, signal);
  }
};
