import type { Database } from "bun:sqlite";

/**
 * SQLite-handle liveness + self-heal policy (#594).
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
 * The policy here: on a request that hits the persistent-corruption error
 * class, attempt ONE reopen of the handle; if reopen fails OR the error
 * recurs immediately, log loudly and `process.exit(1)` so the platform
 * manager (launchd / systemd / container runtime) restarts with a fresh
 * handle. We are careful to scope "fatal" to the persistent class — a
 * transient `SQLITE_BUSY` (a momentary write lock) must NOT kill the hub.
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

  // Persistent-corruption / dead-handle class → fatal (reopen-once-or-exit).
  // `disk I/O error` is the exact field message (state dir deleted under a
  // running hub); the malformed-image + corrupt + notadb codes are the
  // related on-disk-corruption shapes the issue calls out.
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
 * A mutable holder for the hub's `Database` handle so a request handler that
 * hits the fatal error class can swap in a freshly-reopened handle without
 * re-threading the closure-captured `db` through every call site. `getDb()`
 * in hub-server reads `holder.get()`; the self-heal path calls
 * `holder.healOrExit(err)`.
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
}

/**
 * Build a {@link DbHolder} over an initial handle. Production wires
 * `reopen: () => openHubDb(dbPath)` and the default exit/log; tests inject a
 * fake reopen + a non-exiting `exit` spy so the fatal branch is exercised
 * without killing the test process.
 */
export function createDbHolder(initial: Database, deps: DbHolderDeps): DbHolder {
  let current = initial;
  const log = deps.log ?? ((line) => console.error(line));
  const exit = deps.exit ?? ((code) => process.exit(code));
  const closeOld =
    deps.closeOld ??
    ((db) => {
      try {
        db.close();
      } catch {
        // Best-effort — a dead handle may throw on close; we're replacing it.
      }
    });

  return {
    get: () => current,
    healOrExit(err: unknown) {
      const klass = classifyDbError(err);
      if (klass !== "fatal") return "ignored";

      const detail = err instanceof Error ? err.message : String(err);
      log(`parachute hub: persistent SQLite failure (${detail}). Attempting one DB handle reopen…`);

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
      log("parachute hub: DB handle reopened successfully; continuing.");
      return "healed";
    },
  };
}
