import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUB_DB_BUSY_TIMEOUT_MS, hubDbPath, migrate, openHubDb } from "../hub-db.ts";

interface Harness {
  configDir: string;
  dbPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const configDir = mkdtempSync(join(tmpdir(), "phub-db-"));
  return {
    configDir,
    dbPath: hubDbPath(configDir),
    cleanup: () => rmSync(configDir, { recursive: true, force: true }),
  };
}

describe("openHubDb + migrate", () => {
  test("creates schema_version + signing_keys on a fresh db", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const tables = (
          db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() ?? []
        ).map((r) => r.name);
        expect(tables).toContain("schema_version");
        expect(tables).toContain("signing_keys");
        const versions = (
          db.query<{ version: number }, []>("SELECT version FROM schema_version").all() ?? []
        ).map((r) => r.version);
        expect(versions).toContain(1);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("re-opening an already-migrated db is a no-op (no duplicate version rows)", () => {
    const h = makeHarness();
    try {
      const db1 = openHubDb(h.dbPath);
      db1.close();
      const db2 = openHubDb(h.dbPath);
      try {
        const rows = db2
          .query<{ version: number; applied_at: string }, []>(
            "SELECT version, applied_at FROM schema_version",
          )
          .all();
        // Each migration recorded exactly once — re-open is idempotent.
        const versions = rows.map((r) => r.version).sort();
        expect(new Set(versions).size).toBe(versions.length);
        expect(versions).toContain(1);
        expect(versions).toContain(2);
      } finally {
        db2.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // hub#861. Every hub write — the pubkey-linkage challenge-consume + link
  // commit among them — runs on a connection from here, so the busy posture is
  // set once, at open, rather than per call site.
  test("opens with a non-zero busy_timeout so a contended write waits", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        expect(HUB_DB_BUSY_TIMEOUT_MS).toBeGreaterThan(0);
        expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(
          HUB_DB_BUSY_TIMEOUT_MS,
        );
      } finally {
        db.close();
      }
      // Control: the pin above is not a tautology. A connection opened without
      // our pragma reports 0 — SQLite's default, and the pre-fix behavior, in
      // which the first SQLITE_BUSY fails the statement outright.
      const bare = new Database(h.dbPath);
      try {
        expect(bare.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(0);
      } finally {
        bare.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("signing_keys schema enforces required columns", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        // Missing private_key_pem must fail (NOT NULL).
        expect(() =>
          db
            .prepare(
              "INSERT INTO signing_keys (kid, public_key_pem, algorithm, created_at) VALUES (?, ?, ?, ?)",
            )
            .run("k1", "pem", "RS256", new Date().toISOString()),
        ).toThrow();
        // Full row works; retired_at is nullable.
        db.prepare(
          `INSERT INTO signing_keys (kid, public_key_pem, private_key_pem, algorithm, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("k2", "pub", "priv", "RS256", new Date().toISOString());
        const row = db
          .query<{ retired_at: string | null }, [string]>(
            "SELECT retired_at FROM signing_keys WHERE kid = ?",
          )
          .get("k2");
        expect(row?.retired_at).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v2 creates users + tokens tables with the expected columns", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const tables = (
          db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() ?? []
        ).map((r) => r.name);
        expect(tables).toContain("users");
        expect(tables).toContain("tokens");
        const versions = (
          db.query<{ version: number }, []>("SELECT version FROM schema_version").all() ?? []
        ).map((r) => r.version);
        expect(versions).toContain(2);

        // users.username UNIQUE constraint enforced.
        db.prepare(
          "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).run("u1", "owner", "h", "2026-01-01", "2026-01-01");
        expect(() =>
          db
            .prepare(
              "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            )
            .run("u2", "owner", "h2", "2026-01-01", "2026-01-01"),
        ).toThrow();

        // tokens.user_id FK enforced.
        expect(() =>
          db
            .prepare(
              `INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run("t1", "no-such-user", "c", "s", "2030-01-01", "2026-01-01"),
        ).toThrow();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v8 added password_changed column (still present at v10)", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const versions = (
          db.query<{ version: number }, []>("SELECT version FROM schema_version").all() ?? []
        ).map((r) => r.version);
        expect(versions).toContain(8);
        // PRAGMA table_info returns the column shape; password_changed
        // should still be on users at v10 (only assigned_vault was
        // dropped in v10's recreate).
        interface ColInfo {
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }
        const cols = db
          .query<ColInfo, []>(
            "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('users')",
          )
          .all();
        const byName = new Map(cols.map((c) => [c.name, c]));
        const pc = byName.get("password_changed");
        expect(pc).toBeDefined();
        expect(pc?.type).toBe("INTEGER");
        expect(pc?.notnull).toBe(1);
        // Default literal — SQLite returns it as a string "0".
        expect(pc?.dflt_value).toBe("0");
        // v10 dropped assigned_vault — verify the column is gone.
        expect(byName.has("assigned_vault")).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v8 backfills password_changed=1 for users that pre-date the migration", () => {
    const h = makeHarness();
    try {
      // Stand up a DB at the v7 state by recreating the users table
      // without the v8/v10 columns and re-running migrate().
      const db = openHubDb(h.dbPath);
      try {
        // Build a v7-shape users table and copy the v8-shape rows.
        db.exec(`
          DROP TABLE IF EXISTS user_vaults;
          CREATE TABLE users_v7 (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO users_v7 (id, username, password_hash, created_at, updated_at)
          SELECT id, username, password_hash, created_at, updated_at FROM users;
          DROP TABLE users;
          ALTER TABLE users_v7 RENAME TO users;
        `);
        db.exec("DELETE FROM schema_version WHERE version IN (8, 10)");
        // Insert a row that pre-dates v8 (no password_changed column yet).
        db.prepare(
          `INSERT INTO users (id, username, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("legacy-user", "owner", "h", "2026-01-01", "2026-01-01");
        // Now re-run migrations — v8 + v10 apply.
        migrate(db);
        const row = db
          .query<{ password_changed: number }, [string]>(
            "SELECT password_changed FROM users WHERE id = ?",
          )
          .get("legacy-user");
        expect(row).not.toBeNull();
        expect(row?.password_changed).toBe(1);
        const versions = (
          db.query<{ version: number }, []>("SELECT version FROM schema_version").all() ?? []
        ).map((r) => r.version);
        expect(versions).toContain(8);
        expect(versions).toContain(10);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v8 — fresh inserts default password_changed=0 (v10 dropped assigned_vault)", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        // Insert via the bare-columns SQL to confirm the column DEFAULTs work.
        db.prepare(
          `INSERT INTO users (id, username, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("u-default", "owner", "h", "2026-01-01", "2026-01-01");
        const row = db
          .query<{ password_changed: number }, [string]>(
            "SELECT password_changed FROM users WHERE id = ?",
          )
          .get("u-default");
        expect(row?.password_changed).toBe(0);
        // user_vaults table is empty for a default insert.
        const vaultCount = db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?")
          .get("u-default");
        expect(vaultCount?.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // v10 — user_vaults many-to-many membership (multi-user Phase 2 PR 2)
  // ---------------------------------------------------------------------------

  test("v10 creates user_vaults table with the expected shape", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const versions = (
          db.query<{ version: number }, []>("SELECT version FROM schema_version").all() ?? []
        ).map((r) => r.version);
        expect(versions).toContain(10);
        const tables = (
          db
            .query<{ name: string }, []>(
              "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() ?? []
        ).map((r) => r.name);
        expect(tables).toContain("user_vaults");
        interface ColInfo {
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
        }
        const cols = db
          .query<ColInfo, []>(
            "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('user_vaults')",
          )
          .all();
        const names = cols.map((c) => c.name);
        expect(names).toContain("user_id");
        expect(names).toContain("vault_name");
        expect(names).toContain("role");
        expect(names).toContain("created_at");
        const role = cols.find((c) => c.name === "role");
        expect(role?.notnull).toBe(1);
        // SQLite represents the default literal verbatim — `'write'`.
        expect(role?.dflt_value).toBe("'write'");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v10 backfills user_vaults from v9 assigned_vault column", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        // Rebuild a v9-shape users table (with assigned_vault column),
        // mark v10 unapplied, drop user_vaults, populate fixture rows,
        // then re-run migrate to apply v10's backfill.
        db.exec(`
          DROP TABLE IF EXISTS user_vaults;
          CREATE TABLE users_v9 (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            password_changed INTEGER NOT NULL DEFAULT 0,
            assigned_vault TEXT
          );
          INSERT INTO users_v9 (id, username, password_hash, created_at, updated_at, password_changed, assigned_vault)
          VALUES
            ('u-admin', 'admin', 'h', '2026-01-01', '2026-01-01', 1, NULL),
            ('u-alice', 'alice', 'h', '2026-01-02', '2026-01-02', 1, 'personal'),
            ('u-bob',   'bob',   'h', '2026-01-03', '2026-01-03', 1, 'family');
          DROP TABLE users;
          ALTER TABLE users_v9 RENAME TO users;
        `);
        db.exec("DELETE FROM schema_version WHERE version = 10");
        migrate(db);
        // Expect 2 rows in user_vaults (admin had NULL → no row).
        const rows = db
          .query<{ user_id: string; vault_name: string; role: string }, []>(
            "SELECT user_id, vault_name, role FROM user_vaults ORDER BY user_id ASC",
          )
          .all();
        expect(rows.length).toBe(2);
        expect(rows[0]).toMatchObject({
          user_id: "u-alice",
          vault_name: "personal",
          role: "write",
        });
        expect(rows[1]).toMatchObject({ user_id: "u-bob", vault_name: "family", role: "write" });
        // No row for the admin.
        const adminRows = db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?")
          .get("u-admin");
        expect(adminRows?.n).toBe(0);
        // assigned_vault column should be gone.
        interface ColInfo {
          name: string;
        }
        const cols = db.query<ColInfo, []>("SELECT name FROM pragma_table_info('users')").all();
        expect(cols.map((c) => c.name)).not.toContain("assigned_vault");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v13 adds invites.username; pre-existing invite rows keep NULL (no backfill)", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        // Simulate a real v12 install: strip the v13 column, mark v13
        // unapplied, and seed an invite row that pre-dates pre-naming.
        db.exec(`
          ALTER TABLE invites DROP COLUMN username;
          INSERT INTO invites (token, created_by, vault_name, role, provision_vault,
                               default_mirror, expires_at, created_at)
          VALUES ('hash-v12', NULL, 'maya', 'write', 1, NULL,
                  '2099-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
        `);
        db.exec("DELETE FROM schema_version WHERE version = 13");
        migrate(db);
        const cols = db
          .query<{ name: string }, []>("SELECT name FROM pragma_table_info('invites')")
          .all()
          .map((c) => c.name);
        expect(cols).toContain("username");
        // Grandfathered row → NULL (redeemer picks their own name).
        const row = db
          .query<{ username: string | null }, [string]>(
            "SELECT username FROM invites WHERE token = ?",
          )
          .get("hash-v12");
        expect(row?.username).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v19 backfills tokens.user_id where subject equals a users.id; leaves the rest", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const stamp = new Date().toISOString();
        db.prepare(
          `INSERT INTO users (id, username, password_hash, created_at, updated_at, password_changed)
           VALUES (?, ?, 'x', ?, ?, 1)`,
        ).run("user-backfill", "owner", stamp, stamp);
        db.prepare(
          `INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at, created_via, subject)
           VALUES (?, NULL, 'c', 'vault:read', ?, ?, 'cli_mint', ?)`,
        ).run("t-account", stamp, stamp, "user-backfill");
        db.prepare(
          `INSERT INTO tokens (jti, user_id, client_id, scopes, expires_at, created_at, created_via, subject)
           VALUES (?, NULL, 'c', 'vault:read', ?, ?, 'operator_mint', 'operator')`,
        ).run("t-operator", stamp, stamp);
        db.exec("DELETE FROM schema_version WHERE version = 19");
        migrate(db);
        const account = db
          .query<{ user_id: string | null }, [string]>("SELECT user_id FROM tokens WHERE jti = ?")
          .get("t-account");
        const operator = db
          .query<{ user_id: string | null }, [string]>("SELECT user_id FROM tokens WHERE jti = ?")
          .get("t-operator");
        expect(account?.user_id).toBe("user-backfill");
        expect(operator?.user_id).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v10 FK cascade: deleting a user drops their user_vaults rows", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const stamp = "2026-05-27T00:00:00.000Z";
        db.prepare(
          "INSERT INTO users (id, username, password_hash, created_at, updated_at, password_changed) VALUES (?, ?, ?, ?, ?, ?)",
        ).run("u1", "alice", "h", stamp, stamp, 1);
        db.prepare(
          "INSERT INTO user_vaults (user_id, vault_name, role, created_at) VALUES (?, ?, ?, ?)",
        ).run("u1", "personal", "write", stamp);
        db.prepare(
          "INSERT INTO user_vaults (user_id, vault_name, role, created_at) VALUES (?, ?, ?, ?)",
        ).run("u1", "family", "write", stamp);
        // sanity
        const before = db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?")
          .get("u1");
        expect(before?.n).toBe(2);
        // Delete the user — ON DELETE CASCADE should drop the user_vaults rows.
        db.prepare("DELETE FROM users WHERE id = ?").run("u1");
        const after = db
          .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?")
          .get("u1");
        expect(after?.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v10 (user_id, vault_name) PRIMARY KEY blocks duplicate (user, vault) pairs", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const stamp = "2026-05-27T00:00:00.000Z";
        db.prepare(
          "INSERT INTO users (id, username, password_hash, created_at, updated_at, password_changed) VALUES (?, ?, ?, ?, ?, ?)",
        ).run("u1", "alice", "h", stamp, stamp, 1);
        db.prepare(
          "INSERT INTO user_vaults (user_id, vault_name, role, created_at) VALUES (?, ?, ?, ?)",
        ).run("u1", "personal", "write", stamp);
        expect(() =>
          db
            .prepare(
              "INSERT INTO user_vaults (user_id, vault_name, role, created_at) VALUES (?, ?, ?, ?)",
            )
            .run("u1", "personal", "write", stamp),
        ).toThrow();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("migration v20 — users.hub_role (hub#881)", () => {
  test("adds hub_role, backfills the earliest user to admin, leaves later users 'user'", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        // Stand up a pre-v20 `users` shape: drop the column, mark v20
        // unapplied, seed three rows in known created_at order. Same
        // rebuild-the-old-shape pattern as the v8 / v10 fixtures above.
        db.exec("ALTER TABLE users DROP COLUMN hub_role");
        db.exec("DELETE FROM schema_version WHERE version = 20");
        db.exec(`
          INSERT INTO users (id, username, password_hash, created_at, updated_at, password_changed)
          VALUES
            ('u-owner', 'owner', 'h', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1),
            ('u-alice', 'alice', 'h', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 1),
            ('u-bob',   'bob',   'h', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 1);
        `);
        migrate(db);

        const cols = db
          .query<{ name: string }, []>("SELECT name FROM pragma_table_info('users')")
          .all()
          .map((c) => c.name);
        expect(cols).toContain("hub_role");

        // The backfill must reproduce the pre-v20 definition of "the
        // admin" exactly — `getFirstAdminId`'s earliest-created row — so
        // an already-bootstrapped hub keeps the admin it had.
        const roles = db
          .query<{ id: string; hub_role: string }, []>(
            "SELECT id, hub_role FROM users ORDER BY created_at ASC",
          )
          .all();
        expect(roles).toEqual([
          { id: "u-owner", hub_role: "admin" },
          { id: "u-alice", hub_role: "user" },
          { id: "u-bob", hub_role: "user" },
        ]);

        const versions = db
          .query<{ version: number }, []>("SELECT version FROM schema_version")
          .all()
          .map((r) => r.version);
        expect(versions).toContain(20);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("a row inserted without hub_role lands as 'user' (fail-closed DEFAULT)", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        // Code that doesn't know about the column must produce a
        // NON-admin, never an admin.
        db.prepare(
          "INSERT INTO users (id, username, password_hash, created_at, updated_at, password_changed) VALUES (?, ?, ?, ?, ?, ?)",
        ).run("u1", "alice", "h", "2026-05-01", "2026-05-01", 1);
        const row = db
          .query<{ hub_role: string }, [string]>("SELECT hub_role FROM users WHERE id = ?")
          .get("u1");
        expect(row?.hub_role).toBe("user");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v20 on an empty users table applies cleanly and creates no admin", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        db.exec("ALTER TABLE users DROP COLUMN hub_role");
        db.exec("DELETE FROM schema_version WHERE version = 20");
        expect(() => migrate(db)).not.toThrow();
        const n = db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE hub_role = 'admin'")
          .get();
        expect(n?.n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("migration v23 — channel_vaults (channel-attached vaults PR 1)", () => {
  test("a fresh db gets the table, the composite PK, and the inverse index", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const cols = db
          .query<{ name: string; type: string; notnull: number; dflt_value: string | null }, []>(
            "SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('channel_vaults')",
          )
          .all();
        expect(cols.map((c) => c.name)).toEqual([
          "relay_host",
          "channel_id",
          "vault",
          "mode",
          "relay_self_pubkey",
          "synced_at",
          "created_at",
        ]);
        // `mode` defaults to 'sync' so a writer that doesn't know the column
        // lands on the syncing (not the frozen) side, matching the CLI default.
        expect(cols.find((c) => c.name === "mode")?.dflt_value).toBe("'sync'");
        // The two nullable columns PR 4/5 fill.
        expect(cols.find((c) => c.name === "relay_self_pubkey")?.notnull).toBe(0);
        expect(cols.find((c) => c.name === "synced_at")?.notnull).toBe(0);

        const pk = db
          .query<{ name: string; pk: number }, []>(
            "SELECT name, pk FROM pragma_table_info('channel_vaults') WHERE pk > 0 ORDER BY pk",
          )
          .all()
          .map((c) => c.name);
        expect(pk).toEqual(["relay_host", "channel_id"]);

        const indexes = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='channel_vaults'",
          )
          .all()
          .map((r) => r.name);
        expect(indexes).toContain("channel_vaults_vault");

        expect(
          db
            .query<{ version: number }, []>("SELECT version FROM schema_version")
            .all()
            .map((r) => r.version),
        ).toContain(23);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v23 applies on top of an already-migrated db that has not seen it", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        // Stand up the pre-v23 shape — same drop-the-artifact / unmark-the-
        // version fixture the v10 / v13 / v20 tests use. On `next` the highest
        // migration before this one is v21; hub#945 lands v22 ahead of it, so
        // this proves "applies on a DB at the previous head" either way.
        const head = db
          .query<{ v: number }, []>(
            "SELECT MAX(version) AS v FROM schema_version WHERE version < 23",
          )
          .get();
        expect(head?.v).toBeGreaterThanOrEqual(21);
        db.exec("DROP TABLE channel_vaults");
        db.exec("DELETE FROM schema_version WHERE version = 23");

        migrate(db);

        const tables = db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((r) => r.name);
        expect(tables).toContain("channel_vaults");
        expect(
          db
            .query<{ version: number }, []>("SELECT version FROM schema_version")
            .all()
            .map((r) => r.version),
        ).toContain(23);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("one channel binds to one vault; one vault may back several channels", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const ins = db.prepare(
          "INSERT INTO channel_vaults (relay_host, channel_id, vault, mode, created_at) VALUES (?, ?, ?, 'sync', '2026-09-02T00:00:00.000Z')",
        );
        ins.run("relay.example", "chan-a", "shared");
        // Same vault, different channel — allowed (no UNIQUE on `vault`).
        ins.run("relay.example", "chan-b", "shared");
        // Same relay + channel again — refused by the composite PK.
        expect(() => ins.run("relay.example", "chan-a", "other")).toThrow();
        // The same channel id on a DIFFERENT relay is a different channel.
        expect(() => ins.run("other.example", "chan-a", "elsewhere")).not.toThrow();

        const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM channel_vaults").get();
        expect(n?.n).toBe(3);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("a row inserted without `mode` lands as 'sync' (the column DEFAULT)", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        db.prepare(
          "INSERT INTO channel_vaults (relay_host, channel_id, vault, created_at) VALUES (?, ?, ?, ?)",
        ).run("relay.example", "chan-a", "v1", "2026-09-02T00:00:00.000Z");
        const row = db
          .query<{ mode: string; synced_at: string | null }, []>(
            "SELECT mode, synced_at FROM channel_vaults",
          )
          .get();
        expect(row?.mode).toBe("sync");
        expect(row?.synced_at).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
