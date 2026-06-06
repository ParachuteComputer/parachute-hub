import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { classifyDbError, createDbHolder, probeDbLiveness } from "../hub-db-liveness.ts";

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
