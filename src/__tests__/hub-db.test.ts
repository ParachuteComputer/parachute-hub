import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, migrate, openHubDb } from "../hub-db.ts";

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

  test("v8 adds password_changed + assigned_vault columns on a fresh DB", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        const versions = (
          db.query<{ version: number }, []>("SELECT version FROM schema_version").all() ?? []
        ).map((r) => r.version);
        expect(versions).toContain(8);
        // PRAGMA table_info returns the column shape; we want both new
        // columns present with the right defaults / nullability.
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
        const av = byName.get("assigned_vault");
        expect(av).toBeDefined();
        expect(av?.type).toBe("TEXT");
        expect(av?.notnull).toBe(0);
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
      // Stand up a DB at the v7 state by partially-applying migrations:
      // open Database directly, call migrate after stripping the v8 entry
      // would be invasive. Instead, drive the same migration shape by hand
      // for v1-v7 then insert a row, then call migrate() to apply v8.
      // Cleanest path: openHubDb runs everything, but we want a v7 snapshot.
      // Approach: open with openHubDb (runs all migrations), drop the v8
      // changes, mark v8 unapplied, insert a user with password_changed=0
      // (simulating a row from before the backfill), then re-run migrate.
      // SQLite doesn't have DROP COLUMN pre-3.35 universally, so we do the
      // recreate-and-rename: drop v8's columns by recreating users without
      // them, then delete the v8 schema_version row, then call migrate().
      const db = openHubDb(h.dbPath);
      try {
        // Build a v7-shape users table and copy the v8-shape rows.
        db.exec(`
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
        db.exec("DELETE FROM schema_version WHERE version = 8");
        // Insert a row that pre-dates v8 (no password_changed column yet).
        db.prepare(
          `INSERT INTO users (id, username, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("legacy-user", "owner", "h", "2026-01-01", "2026-01-01");
        // Now re-run migrations — v8 should ALTER the table and backfill.
        migrate(db);
        const row = db
          .query<{ password_changed: number; assigned_vault: string | null }, [string]>(
            "SELECT password_changed, assigned_vault FROM users WHERE id = ?",
          )
          .get("legacy-user");
        expect(row).not.toBeNull();
        expect(row?.password_changed).toBe(1);
        expect(row?.assigned_vault).toBeNull();
        const versions = (
          db.query<{ version: number }, []>("SELECT version FROM schema_version").all() ?? []
        ).map((r) => r.version);
        expect(versions).toContain(8);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("v8 — fresh inserts default password_changed=0 and assigned_vault NULL", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(h.dbPath);
      try {
        // Insert via the bare-columns SQL (mirrors what a pre-v8 caller
        // would emit) to confirm the column DEFAULTs work.
        db.prepare(
          `INSERT INTO users (id, username, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run("u-default", "owner", "h", "2026-01-01", "2026-01-01");
        const row = db
          .query<{ password_changed: number; assigned_vault: string | null }, [string]>(
            "SELECT password_changed, assigned_vault FROM users WHERE id = ?",
          )
          .get("u-default");
        expect(row?.password_changed).toBe(0);
        expect(row?.assigned_vault).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
