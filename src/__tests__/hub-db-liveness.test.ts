import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  type DbInode,
  type StatInodeFn,
  classifyDbError,
  classifyPathLiveness,
  createDbHolder,
  probeDbLiveness,
  startDbPathLivenessTimer,
} from "../hub-db-liveness.ts";

/** Build a `SQLiteError`-shaped object with the given code + message. */
function sqliteErr(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.name = "SQLiteError";
  e.code = code;
  return e;
}

describe("classifyDbError (#594)", () => {
  test("the persistent-corruption class is fatal", () => {
    expect(classifyDbError(sqliteErr("SQLITE_IOERR", "disk I/O error"))).toBe("fatal");
    expect(classifyDbError(new Error("disk I/O error"))).toBe("fatal");
    expect(classifyDbError(sqliteErr("SQLITE_CORRUPT", "database disk image is malformed"))).toBe(
      "fatal",
    );
    expect(classifyDbError(sqliteErr("SQLITE_NOTADB", "file is not a database"))).toBe("fatal");
  });

  test("transient locks are NOT fatal", () => {
    expect(classifyDbError(sqliteErr("SQLITE_BUSY", "database is locked"))).toBe("transient");
    expect(classifyDbError(sqliteErr("SQLITE_LOCKED", "database table is locked"))).toBe(
      "transient",
    );
  });

  test("unrelated errors classify as other", () => {
    expect(classifyDbError(new Error("UNIQUE constraint failed: users.id"))).toBe("other");
    expect(classifyDbError(new TypeError("undefined is not a function"))).toBe("other");
    expect(classifyDbError(null)).toBe("other");
  });
});

describe("probeDbLiveness (#594)", () => {
  test("returns ok on a live in-memory db", () => {
    const db = new Database(":memory:");
    expect(probeDbLiveness(db)).toBe("ok");
    db.close();
  });

  test("returns error: <class> on a closed handle, never throws", () => {
    const db = new Database(":memory:");
    db.close();
    const result = probeDbLiveness(db);
    expect(result.startsWith("error:")).toBe(true);
  });
});

describe("createDbHolder (#594)", () => {
  test("non-fatal errors are ignored (no reopen, no exit)", () => {
    const initial = new Database(":memory:");
    let reopens = 0;
    let exits = 0;
    const holder = createDbHolder(initial, {
      reopen: () => {
        reopens += 1;
        return new Database(":memory:");
      },
      exit: () => {
        exits += 1;
      },
      log: () => {},
    });
    expect(holder.healOrExit(sqliteErr("SQLITE_BUSY", "database is locked"))).toBe("ignored");
    expect(holder.healOrExit(new Error("UNIQUE constraint failed"))).toBe("ignored");
    expect(reopens).toBe(0);
    expect(exits).toBe(0);
    expect(holder.get()).toBe(initial);
  });

  test("a fatal error reopens the handle ONCE and swaps it in", () => {
    const initial = new Database(":memory:");
    const fresh = new Database(":memory:");
    let reopens = 0;
    let exits = 0;
    let closedOld = false;
    const holder = createDbHolder(initial, {
      reopen: () => {
        reopens += 1;
        return fresh;
      },
      exit: () => {
        exits += 1;
      },
      closeOld: () => {
        closedOld = true;
      },
      log: () => {},
    });
    expect(holder.healOrExit(sqliteErr("SQLITE_IOERR", "disk I/O error"))).toBe("healed");
    expect(reopens).toBe(1);
    expect(exits).toBe(0);
    expect(closedOld).toBe(true);
    expect(holder.get()).toBe(fresh);
    fresh.close();
  });

  test("a fatal error exits(1) when reopen throws", () => {
    const initial = new Database(":memory:");
    let exitCode: number | undefined;
    const holder = createDbHolder(initial, {
      reopen: () => {
        throw sqliteErr("SQLITE_IOERR", "disk I/O error");
      },
      // Non-exiting spy so the test process survives.
      exit: (code) => {
        exitCode = code;
      },
      log: () => {},
    });
    expect(holder.healOrExit(sqliteErr("SQLITE_IOERR", "disk I/O error"))).toBe("exited");
    expect(exitCode).toBe(1);
    // Handle is unchanged (we couldn't reopen).
    expect(holder.get()).toBe(initial);
    initial.close();
  });

  test("a fatal error exits(1) when the REOPENED handle is also dead", () => {
    const initial = new Database(":memory:");
    // Reopen returns an already-closed handle → the holder's SELECT 1 verify
    // throws → exit. This is the "state dir still gone after reopen" case.
    const deadFresh = new Database(":memory:");
    deadFresh.close();
    let exitCode: number | undefined;
    const holder = createDbHolder(initial, {
      reopen: () => deadFresh,
      exit: (code) => {
        exitCode = code;
      },
      log: () => {},
    });
    expect(holder.healOrExit(sqliteErr("SQLITE_IOERR", "disk I/O error"))).toBe("exited");
    expect(exitCode).toBe(1);
    initial.close();
  });
});

const INODE_A: DbInode = { dev: 1, ino: 100 };
const INODE_B: DbInode = { dev: 1, ino: 200 };

describe("classifyPathLiveness (#610)", () => {
  test("same inode → ok", () => {
    expect(classifyPathLiveness({ expected: INODE_A, current: INODE_A })).toBe("ok");
    expect(classifyPathLiveness({ expected: INODE_A, current: { ...INODE_A } })).toBe("ok");
  });
  test("ENOENT on the path (current undefined) → gone", () => {
    expect(classifyPathLiveness({ expected: INODE_A, current: undefined })).toBe("gone");
  });
  test("different inode → replaced", () => {
    expect(classifyPathLiveness({ expected: INODE_A, current: INODE_B })).toBe("replaced");
    // a different device counts too
    expect(classifyPathLiveness({ expected: INODE_A, current: { dev: 2, ino: 100 } })).toBe(
      "replaced",
    );
  });
  test("no baseline snapshot (expected undefined) → unknown, never self-heals", () => {
    expect(classifyPathLiveness({ expected: undefined, current: INODE_A })).toBe("unknown");
    expect(classifyPathLiveness({ expected: undefined, current: undefined })).toBe("unknown");
  });
});

describe("DbHolder.probePath (#610 proactive detection)", () => {
  /** A holder whose path stat is driven by the injected `statInode`. */
  function makeHolder(opts: {
    initialInode: DbInode | undefined;
    statInode: StatInodeFn;
    onReopen?: () => Database;
  }) {
    const initial = new Database(":memory:");
    let reopens = 0;
    let exits = 0;
    let exitCode: number | undefined;
    const holder = createDbHolder(initial, {
      dbPath: "/fake/hub.db",
      initialInode: opts.initialInode,
      statInode: opts.statInode,
      reopen: () => {
        reopens += 1;
        return opts.onReopen ? opts.onReopen() : new Database(":memory:");
      },
      exit: (code) => {
        exits += 1;
        exitCode = code;
      },
      log: () => {},
    });
    return {
      holder,
      stats: () => ({ reopens, exits, exitCode }),
      cleanup: () => {
        try {
          initial.close();
        } catch {}
      },
    };
  }

  test("healthy path (same inode) → no reopen, no exit", () => {
    const h = makeHolder({ initialInode: INODE_A, statInode: () => INODE_A });
    expect(h.holder.probePath()).toBe("ok");
    expect(h.stats().reopens).toBe(0);
    expect(h.stats().exits).toBe(0);
    h.cleanup();
  });

  test("path GONE (ENOENT) → reopen attempted; reopen verify fails → exit(1)", () => {
    // Reopen returns a closed handle (the dir is still gone) → SELECT 1 throws
    // → exit. This is the genuine `rm -rf ~/.parachute` field shape.
    const dead = new Database(":memory:");
    dead.close();
    const h = makeHolder({
      initialInode: INODE_A,
      statInode: () => undefined, // ENOENT
      onReopen: () => dead,
    });
    expect(h.holder.probePath()).toBe("gone");
    expect(h.stats().reopens).toBe(1);
    expect(h.stats().exits).toBe(1);
    expect(h.stats().exitCode).toBe(1);
    h.cleanup();
  });

  test("path REPLACED (different inode) → reopen + swap (heals, no exit)", () => {
    const h = makeHolder({
      initialInode: INODE_A,
      statInode: () => INODE_B, // path now resolves to a different inode
      onReopen: () => new Database(":memory:"),
    });
    expect(h.holder.probePath()).toBe("replaced");
    expect(h.stats().reopens).toBe(1);
    expect(h.stats().exits).toBe(0);
    h.cleanup();
  });

  test("NEVER fires on a transient stat throw (EACCES) — returns ok, no reopen/exit", () => {
    const h = makeHolder({
      initialInode: INODE_A,
      statInode: () => {
        const e = new Error("permission denied") as Error & { code: string };
        e.code = "EACCES";
        throw e;
      },
    });
    expect(h.holder.probePath()).toBe("ok");
    expect(h.stats().reopens).toBe(0);
    expect(h.stats().exits).toBe(0);
    h.cleanup();
  });

  test("no baseline inode → unknown, never self-heals (safe degradation)", () => {
    const h = makeHolder({ initialInode: undefined, statInode: () => undefined });
    expect(h.holder.probePath()).toBe("unknown");
    expect(h.stats().reopens).toBe(0);
    expect(h.stats().exits).toBe(0);
    h.cleanup();
  });

  test("no dbPath configured → probePath is a no-op (unknown)", () => {
    const initial = new Database(":memory:");
    const holder = createDbHolder(initial, {
      reopen: () => new Database(":memory:"),
      exit: () => {},
      log: () => {},
    });
    expect(holder.probePath()).toBe("unknown");
    initial.close();
  });

  test("after a heal (replaced), the inode baseline is re-snapshotted to the new file", () => {
    // First probe sees INODE_B (replaced) → reopen; statInode then returns
    // INODE_B again so the NEXT probe sees the SAME inode → ok (not a loop).
    let exits = 0;
    const initial = new Database(":memory:");
    const holder = createDbHolder(initial, {
      dbPath: "/fake/hub.db",
      initialInode: INODE_A,
      statInode: () => INODE_B,
      reopen: () => new Database(":memory:"),
      exit: () => {
        exits += 1;
      },
      log: () => {},
    });
    expect(holder.probePath()).toBe("replaced"); // A → B, heal
    expect(holder.probePath()).toBe("ok"); // B → B, no further action
    expect(exits).toBe(0);
    initial.close();
  });
});

describe("startDbPathLivenessTimer (#610 bounded watchdog)", () => {
  test("each tick calls probePath exactly once; stop() clears the timer", () => {
    let probes = 0;
    const fakeHolder = {
      get: () => new Database(":memory:"),
      healOrExit: () => "ignored" as const,
      probePath: () => {
        probes += 1;
        return "ok" as const;
      },
    };
    let registered: (() => void) | undefined;
    let cleared = false;
    const timer = startDbPathLivenessTimer<number>(fakeHolder, {
      setIntervalFn: (cb) => {
        registered = cb;
        return 42;
      },
      clearIntervalFn: (h) => {
        expect(h).toBe(42);
        cleared = true;
      },
    });
    expect(registered).toBeDefined();
    registered?.();
    registered?.();
    expect(probes).toBe(2);
    timer.stop();
    expect(cleared).toBe(true);
  });

  test("a probe that throws is swallowed (the timer callback never crashes the process)", () => {
    const fakeHolder = {
      get: () => new Database(":memory:"),
      healOrExit: () => "ignored" as const,
      probePath: (): "ok" => {
        throw new Error("unexpected");
      },
    };
    let registered: (() => void) | undefined;
    startDbPathLivenessTimer<number>(fakeHolder, {
      setIntervalFn: (cb) => {
        registered = cb;
        return 1;
      },
      clearIntervalFn: () => {},
      log: () => {},
    });
    // Must NOT throw out of the callback.
    expect(() => registered?.()).not.toThrow();
  });
});
