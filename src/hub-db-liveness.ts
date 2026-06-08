import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";

/**
 * SQLite-handle liveness + self-heal policy (#594, #610).
 *
 * Field repro: an operator deleted `~/.parachute` while the hub unit was
 * running. The process kept an fd to the now-unlinked `hub.db` inode — cached
 * reads half-worked, every write / WAL op threw `SQLiteError: disk I/O error`.
 * Result: `/health` stayed 200 (it never touched the DB), every DB-touching
 * route 500'd indefinitely, and operator-facing CLI checks lied (served from
 * the dead handle's cached pages). An hour of clean 500s behind a green
 * /health is the worst possible failure shape — a crash-restart would have
 * self-healed in seconds (the platform manager re-`openHubDb`s a fresh handle).
 *
 * The REACTIVE policy (#594): on a request that hits the persistent-corruption
 * error class, attempt ONE reopen of the handle; if reopen fails OR the error
 * recurs immediately, log loudly and `process.exit(1)` so the platform manager
 * (launchd / systemd / container runtime) restarts with a fresh handle. We are
 * careful to scope "fatal" to the persistent class — a transient `SQLITE_BUSY`
 * (a momentary write lock) must NOT kill the hub.
 *
 * The PROACTIVE policy (#610): the reactive path above only fires on a THROWN
 * error. But on Linux, `rm -rf ~/.parachute` under a running hub does NOT throw
 * — the kernel keeps the unlinked `hub.db` inode alive behind the open fd, so
 * `SELECT 1` and even writes keep succeeding against the ghost (deleted) inode
 * indefinitely. Nothing throws ⇒ the reactive self-heal never fires ⇒ `/health`
 * lies `db:"ok"` forever against a database that's gone from disk. The proactive
 * check closes this gap WITHOUT relying on a thrown error: at open time we record
 * the db file's inode (`st_dev`/`st_ino`); a low-frequency probe (and `/health`'s
 * db check) re-`stat()`s the configured path and compares. ENOENT on the path, or
 * an inode mismatch, means the on-disk DB the handle points at is gone / replaced
 * ⇒ trigger the SAME reopen-or-exit machinery (here the path is gone, so reopen's
 * verify fails and we exit, letting the platform manager restart with a fresh,
 * on-disk handle in seconds rather than "never").
 *
 * SAFETY (both policies): we only ever escalate to reopen/exit on the genuine
 * persistent signal — a thrown fatal error, or a definitively gone/replaced path.
 * Transient conditions (SQLITE_BUSY, a momentary lock, a stat() that fails for a
 * reason OTHER than ENOENT — e.g. EACCES, EINTR) NEVER trigger it. The exit fn is
 * injectable so no test can kill the test process (hub#535 precedent), and the
 * proactive timer is bounded so it can't spin.
 */

/**
 * How a thrown DB error should be treated.
 *   - `fatal`     → persistent corruption / dead handle (disk I/O error,
 *                   database disk image is malformed, NOTADB, CORRUPT, IOERR).
 *                   Triggers the reopen-once-or-exit machinery.
 *   - `transient` → a momentary lock (SQLITE_BUSY / SQLITE_LOCKED). Never
 *                   fatal; the caller surfaces it as an ordinary error and
 *                   the next request likely succeeds.
 *   - `other`     → not a recognized SQLite-handle failure (e.g. a constraint
 *                   violation, a programming error). Not the liveness concern;
 *                   the caller handles it as a normal error.
 */
export type DbErrorClass = "fatal" | "transient" | "other";

/**
 * Pull a lowercase "<code> <message>" string out of an unknown thrown value
 * for substring matching. `bun:sqlite` throws `SQLiteError` with a `code`
 * (e.g. `SQLITE_IOERR`, `SQLITE_BUSY`) and a `message` (e.g. "disk I/O
 * error"). We match on both so a runtime that surfaces one but not the other
 * still classifies correctly.
 */
function errorSignature(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown; name?: unknown };
    const code = typeof e.code === "string" ? e.code : "";
    const message = typeof e.message === "string" ? e.message : "";
    const name = typeof e.name === "string" ? e.name : "";
    return `${code} ${name} ${message}`.toLowerCase();
  }
  return String(err).toLowerCase();
}

/**
 * Classify a thrown DB error. Order matters: a transient BUSY/LOCKED is
 * checked FIRST so it's never mistaken for the fatal class, even if a future
 * message happened to share a substring.
 */
export function classifyDbError(err: unknown): DbErrorClass {
  const sig = errorSignature(err);
  if (sig.length === 0) return "other";

  // Transient locks — explicitly NON-fatal. SQLITE_BUSY is a momentary write
  // lock under WAL contention; killing the hub on it would turn ordinary
  // concurrency into a restart loop. SQLITE_LOCKED is the same class.
  if (sig.includes("sqlite_busy") || sig.includes("sqlite_locked")) return "transient";
  if (/\bdatabase is locked\b/.test(sig) || /\bdatabase table is locked\b/.test(sig)) {
    return "transient";
  }
  // A handful of SQLITE_IOERR *sub-codes* are contention, not corruption:
  // SQLITE_IOERR_BLOCKED (a legacy busy variant) and SQLITE_IOERR_LOCK (a
  // lock-acquisition failure). The generic `sqlite_ioerr` substring match
  // below would otherwise sweep these into the fatal class and exit the hub on
  // transient I/O contention. Check them FIRST so they classify as transient.
  if (sig.includes("sqlite_ioerr_blocked") || sig.includes("sqlite_ioerr_lock")) {
    return "transient";
  }

  // Persistent-corruption / dead-handle class → fatal (reopen-once-or-exit).
  // `disk I/O error` is the exact field message (state dir deleted under a
  // running hub); the malformed-image + corrupt + notadb codes are the
  // related on-disk-corruption shapes the issue calls out.
  //
  // `sqlite_ioerr` matches the GENERIC `SQLITE_IOERR` code, which is what Bun
  // surfaces for the dead-handle case (the unlinked-inode field repro reports
  // exactly `code: "SQLITE_IOERR", message: "disk I/O error"`, not a
  // sub-code). The two transient IOERR sub-codes are already filtered out
  // above, so reaching this `includes` means either the generic code or a
  // corruption sub-code — both fatal. (`disk i/o error` is also matched
  // directly so a runtime that surfaces the message but not the code still
  // classifies.)
  if (
    sig.includes("disk i/o error") ||
    sig.includes("sqlite_ioerr") ||
    sig.includes("database disk image is malformed") ||
    sig.includes("sqlite_corrupt") ||
    sig.includes("sqlite_notadb") ||
    sig.includes("file is not a database")
  ) {
    return "fatal";
  }

  return "other";
}

/**
 * Cheap DB liveness probe for `/health` (#594). Runs `SELECT 1`. Returns
 * `"ok"` on success, or `"error: <class>"` where class is the
 * {@link classifyDbError} verdict, so a monitor can tell "hub up but DB dead"
 * apart from "hub up, DB fine". NEVER throws — a probe that threw would make
 * /health itself 500, defeating the point (/health must stay fast + reliable).
 */
export function probeDbLiveness(db: Database): "ok" | string {
  try {
    db.query("SELECT 1").get();
    return "ok";
  } catch (err) {
    return `error: ${classifyDbError(err)}`;
  }
}

/**
 * The identity of an on-disk file — `st_dev`/`st_ino`, the only two fields that
 * uniquely identify an inode across a delete+recreate. We snapshot this for the
 * db path at open time so the proactive probe (#610) can tell "same file the
 * handle points at" from "path now resolves to a DIFFERENT (or no) inode".
 */
export interface DbInode {
  dev: number;
  ino: number;
}

/**
 * Injectable `stat` of the db PATH (not the open handle). Production wires
 * {@link defaultStatInode} (`fs.statSync`); tests inject a function that returns
 * a chosen inode, `undefined` for ENOENT (path gone), or throws a non-ENOENT
 * error (e.g. EACCES — a TRANSIENT failure that must NOT trigger self-heal).
 *
 * Contract: return the {@link DbInode} on success, `undefined` when the path
 * does not exist (ENOENT — the genuine "wiped" signal), and THROW for any other
 * error (so the caller can treat it as transient and leave the hub alone).
 */
export type StatInodeFn = (path: string) => DbInode | undefined;

/**
 * Production `stat`: returns the path's inode, or `undefined` on ENOENT. Any
 * other error (EACCES, EINTR, …) is re-thrown so the caller classifies it as
 * transient — we only ever self-heal on a DEFINITIVELY-gone path.
 */
export const defaultStatInode: StatInodeFn = (path) => {
  try {
    const st = statSync(path);
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: unknown }).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
};

/**
 * The verdict of a proactive path-liveness check (#610), against the inode the
 * handle was opened on:
 *   - `"ok"`       → the path still resolves to the SAME inode the handle holds.
 *   - `"gone"`     → the path no longer exists (ENOENT) — the state dir was wiped.
 *   - `"replaced"` → the path exists but resolves to a DIFFERENT inode — the DB
 *                    file was deleted + recreated underneath the handle.
 *   - `"unknown"`  → we couldn't snapshot the open inode (no baseline) so we
 *                    can't compare; treated as a non-signal (never self-heals).
 *
 * Only `"gone"`/`"replaced"` are the genuine wipe signal that triggers self-heal.
 */
export type PathLivenessClass = "ok" | "gone" | "replaced" | "unknown";

/**
 * Pure classifier: compare the inode the path resolves to NOW (or `undefined`
 * for ENOENT) against the inode the open handle was created on. No I/O — the
 * caller does the `stat()` and the open-inode snapshot; this is the decision so
 * it's trivially unit-testable and the "never fire on transient" rule is a
 * single, auditable function.
 *
 * A non-ENOENT stat error is NOT represented here — the caller (`statInode`'s
 * contract) THROWS on it, and the probe treats a thrown stat as transient
 * (leaves the hub alone). Only a clean ENOENT (`current === undefined`) or a
 * clean inode mismatch reaches a self-heal verdict.
 */
export function classifyPathLiveness(args: {
  /** The inode the open db handle was created on (snapshot at open). */
  expected: DbInode | undefined;
  /** The inode the path resolves to NOW, or `undefined` for ENOENT. */
  current: DbInode | undefined;
}): PathLivenessClass {
  const { expected, current } = args;
  // No baseline → we can't compare; never self-heal on a missing snapshot.
  if (expected === undefined) return "unknown";
  if (current === undefined) return "gone";
  if (current.dev === expected.dev && current.ino === expected.ino) return "ok";
  return "replaced";
}

/**
 * A mutable holder for the hub's `Database` handle so a request handler that
 * hits the fatal error class can swap in a freshly-reopened handle without
 * re-threading the closure-captured `db` through every call site. `getDb()`
 * in hub-server reads `holder.get()`; the reactive self-heal path calls
 * `holder.healOrExit(err)`; the proactive (#610) path calls `holder.probePath()`.
 */
export interface DbHolder {
  /** The current live handle. */
  get(): Database;
  /**
   * React to a thrown DB error per the liveness policy:
   *   - `transient`/`other` → return `"ignored"` (caller surfaces a normal error).
   *   - `fatal`, reopen succeeds + a `SELECT 1` passes on the new handle →
   *     swap the handle in, return `"healed"` (caller retries / surfaces a
   *     transient error the next request clears).
   *   - `fatal`, reopen fails OR the new handle still fails `SELECT 1` →
   *     log loudly + `exit(1)`. Returns `"exited"` only in tests (the injected
   *     exit fn doesn't actually exit the process).
   *
   * Reopen-once semantics: a single fatal error triggers one reopen attempt.
   * If the *reopened* handle is also dead (e.g. the underlying dir is still
   * gone), we exit rather than loop — the platform manager owns the restart.
   */
  healOrExit(err: unknown): "ignored" | "healed" | "exited";
  /**
   * PROACTIVE path-liveness probe (#610). `stat()`s the configured db PATH and
   * compares its inode to the one the open handle was created on. On a genuine
   * wipe signal (`"gone"`/`"replaced"`) it triggers the SAME reopen-or-exit
   * machinery as `healOrExit` (here the path is gone, so reopen's verify fails
   * → exit → platform manager restarts with a fresh on-disk handle). On `"ok"`,
   * `"unknown"`, or a thrown (transient) stat it does NOTHING.
   *
   * Returns the {@link PathLivenessClass} verdict so `/health` and tests can see
   * what was observed; the `"healed"`/`"exited"` side effects mirror `healOrExit`.
   * Wired into the bounded liveness timer in hub-server AND into `/health`'s db
   * check, so monitoring + the #591 adoption probe see the fault instead of a lie.
   */
  probePath(): PathLivenessClass;
}

export interface DbHolderDeps {
  /** Open a fresh handle (production: `() => openHubDb(dbPath)`). */
  reopen: () => Database;
  /** Loud log sink (default `console.error`). */
  log?: (line: string) => void;
  /** Process-exit fn (default `process.exit`; tests inject a spy). */
  exit?: (code: number) => void;
  /** Close a (presumed-dead) handle best-effort before swapping (default `db.close()`). */
  closeOld?: (db: Database) => void;
  /**
   * The on-disk db PATH the proactive probe (#610) stat()s. When omitted,
   * `probePath()` is a no-op (`"unknown"`) — backwards-compatible for the
   * reactive-only callers + tests that don't exercise the proactive path.
   */
  dbPath?: string;
  /** Injectable path stat for the proactive probe (default {@link defaultStatInode}). */
  statInode?: StatInodeFn;
  /**
   * The inode the INITIAL handle was opened on. Production passes the snapshot
   * taken right after `openHubDb`; when omitted (or when the snapshot itself
   * failed), `probePath()` returns `"unknown"` and never self-heals.
   */
  initialInode?: DbInode | undefined;
}

/**
 * Build a {@link DbHolder} over an initial handle. Production wires
 * `reopen: () => openHubDb(dbPath)` and the default exit/log; tests inject a
 * fake reopen + a non-exiting `exit` spy so the fatal branch is exercised
 * without killing the test process.
 */
export function createDbHolder(initial: Database, deps: DbHolderDeps): DbHolder {
  let current = initial;
  // The inode the CURRENT handle is bound to. Updated on every successful
  // reopen so the proactive probe (#610) compares against the live handle, not
  // a one-time snapshot that would go stale after a heal.
  let currentInode: DbInode | undefined = deps.initialInode;
  const log = deps.log ?? ((line) => console.error(line));
  const exit = deps.exit ?? ((code) => process.exit(code));
  const statInode = deps.statInode ?? defaultStatInode;
  const closeOld =
    deps.closeOld ??
    ((db) => {
      try {
        db.close();
      } catch {
        // Best-effort — a dead handle may throw on close; we're replacing it.
      }
    });

  /**
   * Shared reopen-once-or-exit core for BOTH the reactive (`healOrExit`) and
   * proactive (`probePath`) self-heal paths. `reason` is the loud-log preamble
   * describing what triggered it. Returns `"healed"` (fresh handle swapped in +
   * verified) or `"exited"` (reopen failed / new handle dead → exit, which only
   * returns in tests where `exit` is a non-killing spy).
   */
  const reopenOrExit = (reason: string): "healed" | "exited" => {
    log(`parachute hub: ${reason}. Attempting one DB handle reopen…`);

    let reopened: Database;
    try {
      reopened = deps.reopen();
      // Confirm the fresh handle is actually live before trusting it.
      reopened.query("SELECT 1").get();
    } catch (reopenErr) {
      const rd = reopenErr instanceof Error ? reopenErr.message : String(reopenErr);
      log(
        `parachute hub: DB reopen failed (${rd}); exiting so the platform manager restarts the hub with a fresh handle.`,
      );
      exit(1);
      return "exited";
    }

    // Reopen succeeded + verified. Swap it in; the old handle is dead.
    closeOld(current);
    current = reopened;
    // Re-snapshot the inode of the path the fresh handle now points at, so the
    // proactive probe tracks the NEW file (best-effort — a failed snapshot
    // leaves `currentInode` undefined → probe returns "unknown", never fires).
    if (deps.dbPath !== undefined) {
      try {
        currentInode = statInode(deps.dbPath);
      } catch {
        currentInode = undefined;
      }
    }
    log("parachute hub: DB handle reopened successfully; continuing.");
    return "healed";
  };

  return {
    get: () => current,
    healOrExit(err: unknown) {
      const klass = classifyDbError(err);
      if (klass !== "fatal") return "ignored";
      const detail = err instanceof Error ? err.message : String(err);
      return reopenOrExit(`persistent SQLite failure (${detail})`);
    },
    probePath(): PathLivenessClass {
      // No path configured → proactive probe disabled (reactive-only callers).
      if (deps.dbPath === undefined) return "unknown";

      // `pathInode` (NOT `current`) — the inode the db PATH resolves to right
      // now. Named distinctly from the outer `current` (the live Database
      // handle) so a reader can't misread this as the DB handle.
      let pathInode: DbInode | undefined;
      try {
        pathInode = statInode(deps.dbPath);
      } catch {
        // A non-ENOENT stat failure (EACCES, EINTR, a transient FS hiccup) is
        // explicitly NOT a wipe signal. Leave the hub alone — the next probe
        // re-reads. This is the "never fire on transient" guard for the
        // proactive path; only a clean ENOENT/mismatch below self-heals.
        return "ok";
      }

      const verdict = classifyPathLiveness({ expected: currentInode, current: pathInode });
      if (verdict === "ok" || verdict === "unknown") return verdict;

      // Genuine wipe signal: the on-disk DB the handle points at is gone
      // ("gone") or was replaced underneath us ("replaced"). Trigger the SAME
      // reopen-or-exit machinery. When the path is gone, reopen's SELECT-1
      // verify fails → exit → platform manager restarts with a fresh on-disk
      // handle (seconds, not "never"). When replaced, we adopt the fresh inode.
      //
      // ONE-TICK /health ANOMALY (intentional): on a "replaced" verdict the
      // reopenOrExit below heals SYNCHRONOUSLY, but we still RETURN "replaced"
      // for this one call — so the /health request that drove this probe reports
      // `db:"error: path-replaced"` even though the handle is now healthy; the
      // very next request reads `ok`. We don't mask it (returning "ok" here would
      // hide that a heal just happened, which is exactly what monitoring wants to
      // see). It's safe because #591's adoption probe checks only HTTP 200
      // (`res.ok`), not the specific `db` string, so a single transient error
      // string can't cascade.
      reopenOrExit(
        verdict === "gone"
          ? `db path ${deps.dbPath} no longer exists (state dir wiped under a running hub, #610)`
          : `db path ${deps.dbPath} now resolves to a different inode (DB file replaced underneath the open handle, #610)`,
      );
      return verdict;
    },
  };
}

/** Handle to stop a running proactive-liveness timer (test cleanup + shutdown). */
export interface DbLivenessTimer {
  stop(): void;
}

export interface DbLivenessTimerDeps<H = unknown> {
  /** Poll cadence in ms. Default 15_000 (low-frequency — this is a safety net,
   * not a hot path; the cost is one `stat()` syscall per tick). */
  intervalMs?: number;
  /** Injectable scheduler (default `setInterval`). Tests drive ticks manually. */
  setIntervalFn?: (cb: () => void, ms: number) => H;
  /** Injectable clear (default `clearInterval`). */
  clearIntervalFn?: (handle: H) => void;
  /** Loud log sink for an unexpected probe throw (default `console.error`). */
  log?: (line: string) => void;
}

/**
 * Start the bounded, low-frequency PROACTIVE liveness timer (#610). Each tick
 * calls `holder.probePath()` — which self-heals (reopen-or-exit) on a genuine
 * wipe and no-ops otherwise. The cadence is fixed (default 15s) so it can NEVER
 * spin: a tick does exactly one `stat()` then sleeps the full interval; even if
 * the probe self-heals + exits, that's terminal. We swallow any unexpected
 * probe throw (logged) rather than let an interval callback crash the process —
 * the probe is a safety net, not a load-bearing request path.
 *
 * `unref()` is called so this timer never keeps the event loop alive on its own
 * (it's purely a watchdog over the already-running server).
 */
export function startDbPathLivenessTimer<H = ReturnType<typeof setInterval>>(
  holder: DbHolder,
  deps: DbLivenessTimerDeps<H> = {},
): DbLivenessTimer {
  const intervalMs = deps.intervalMs ?? 15_000;
  const setIntervalFn =
    deps.setIntervalFn ?? ((cb: () => void, ms: number) => setInterval(cb, ms) as unknown as H);
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((h: H) => clearInterval(h as unknown as ReturnType<typeof setInterval>));
  const log = deps.log ?? ((line) => console.error(line));

  const handle = setIntervalFn(() => {
    try {
      holder.probePath();
    } catch (err) {
      // A probe should never throw (statInode swallows non-ENOENT, the holder
      // handles the rest), but if it somehow does, don't take the process down
      // from inside a timer callback — log and let the next tick retry.
      const detail = err instanceof Error ? err.message : String(err);
      log(`parachute hub: proactive DB-liveness probe threw unexpectedly (${detail}); ignoring.`);
    }
  }, intervalMs);
  // Don't let the watchdog alone keep the process alive.
  (handle as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearIntervalFn(handle);
    },
  };
}
