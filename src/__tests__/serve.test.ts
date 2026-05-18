import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedInitialAdminIfNeeded } from "../commands/serve.ts";
import { openHubDb } from "../hub-db.ts";
import { userCount } from "../users.ts";

describe("seedInitialAdminIfNeeded", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parachute-serve-"));
    dbPath = join(dir, "hub.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns 'needs-setup' on fresh state with no env vars", async () => {
    const db = openHubDb(dbPath);
    const result = await seedInitialAdminIfNeeded(db, {}, () => {});
    expect(result).toBe("needs-setup");
    expect(userCount(db)).toBe(0);
  });

  test("seeds an admin from PARACHUTE_INITIAL_ADMIN_* on fresh state", async () => {
    const db = openHubDb(dbPath);
    const log = mock<(line: string) => void>(() => {});
    const result = await seedInitialAdminIfNeeded(
      db,
      {
        PARACHUTE_INITIAL_ADMIN_USERNAME: "ops",
        PARACHUTE_INITIAL_ADMIN_PASSWORD: "correct horse battery staple",
      },
      log,
    );
    expect(result).toBe("seeded");
    expect(userCount(db)).toBe(1);
    // The log line carries the username so operators can grep container
    // logs to verify the seed fired.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0] ?? "").toContain("seeded initial admin");
    expect(log.mock.calls[0]?.[0] ?? "").toContain("ops");
  });

  test("returns 'exists' when an admin already exists, even with env vars set", async () => {
    // Seed once.
    const db = openHubDb(dbPath);
    await seedInitialAdminIfNeeded(
      db,
      {
        PARACHUTE_INITIAL_ADMIN_USERNAME: "ops",
        PARACHUTE_INITIAL_ADMIN_PASSWORD: "first-pw",
      },
      () => {},
    );

    // Same env on a second boot must NOT clobber the existing admin —
    // the seed is first-boot only. (Container restart with the env still
    // set from the Render dashboard is the canonical second-boot.)
    const result = await seedInitialAdminIfNeeded(
      db,
      {
        PARACHUTE_INITIAL_ADMIN_USERNAME: "ops",
        PARACHUTE_INITIAL_ADMIN_PASSWORD: "different-pw",
      },
      () => {},
    );
    expect(result).toBe("exists");
    expect(userCount(db)).toBe(1);
  });

  test("treats whitespace-only username as missing (needs-setup)", async () => {
    const db = openHubDb(dbPath);
    const result = await seedInitialAdminIfNeeded(
      db,
      {
        PARACHUTE_INITIAL_ADMIN_USERNAME: "   ",
        PARACHUTE_INITIAL_ADMIN_PASSWORD: "pw",
      },
      () => {},
    );
    expect(result).toBe("needs-setup");
    expect(userCount(db)).toBe(0);
  });

  test("requires both username and password — half-set env is needs-setup", async () => {
    const db = openHubDb(dbPath);
    const result = await seedInitialAdminIfNeeded(
      db,
      { PARACHUTE_INITIAL_ADMIN_USERNAME: "ops" },
      () => {},
    );
    expect(result).toBe("needs-setup");
    expect(userCount(db)).toBe(0);
  });
});
