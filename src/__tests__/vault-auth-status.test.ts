import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVaultAuthStatus } from "../vault/auth-status.ts";

function makeVaultHome(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "pcli-vault-auth-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

function writeConfig(vaultHome: string, body: string): void {
  writeFileSync(join(vaultHome, "config.yaml"), body);
}

function seedVault(vaultHome: string, name: string, opts: { withDb?: boolean } = {}): string {
  const dir = join(vaultHome, "data", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vault.yaml"), "# placeholder\n");
  const dbPath = join(dir, "vault.db");
  if (opts.withDb) writeFileSync(dbPath, ""); // exists but opaque to the fake counter
  return dbPath;
}

/**
 * Default tests pass a `probeHubDbHasUserPassword` of `() => undefined`
 * (hub.db unreachable) so existing YAML-fallback behavior is exercised
 * verbatim. Tests that specifically exercise the hub.db path pass their
 * own probe.
 */
const hubDbUnreachable = () => undefined;

describe("readVaultAuthStatus — hub.db source of truth (multi-user Phase 1+)", () => {
  test("hub.db has a user with password_hash → hasOwnerPassword: true (no YAML needed)", () => {
    const env = makeVaultHome();
    try {
      // No config.yaml at all on disk.
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: () => true,
        probeHubDbHasTotp: () => false,
      });
      expect(status.hasOwnerPassword).toBe(true);
      // No TOTP enrolled in hub.db (and no legacy YAML) → false.
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db users empty, YAML has owner_password_hash → falls back to YAML (legacy install)", () => {
    const env = makeVaultHome();
    try {
      writeConfig(env.path, 'owner_password_hash: "$2b$12$legacyhash"\n');
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: () => false,
        probeHubDbHasTotp: () => false,
      });
      expect(status.hasOwnerPassword).toBe(true);
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db unreachable, YAML has owner_password_hash → falls back to YAML", () => {
    const env = makeVaultHome();
    try {
      writeConfig(env.path, 'owner_password_hash: "$2b$12$superlegacyhash"\n');
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: hubDbUnreachable,
      });
      expect(status.hasOwnerPassword).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db users empty AND no YAML → hasOwnerPassword: false (fresh wide-open install)", () => {
    const env = makeVaultHome();
    try {
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: () => false,
        probeHubDbHasTotp: () => false,
      });
      expect(status.hasOwnerPassword).toBe(false);
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db password=true, hub.db TOTP unreachable → TOTP falls back to YAML state", () => {
    const env = makeVaultHome();
    try {
      // hub#473: hub.db is the canonical TOTP source, but when the TOTP probe
      // is unreachable (pre-v11 column absent) it falls back to the legacy
      // vault YAML totp_secret. password=true (hub.db), totp=true (YAML fallback).
      writeConfig(env.path, 'totp_secret: "JBSWY3DPEHPK3PXP"\n');
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: () => true,
        probeHubDbHasTotp: () => undefined,
      });
      expect(status.hasOwnerPassword).toBe(true);
      expect(status.hasTotp).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db TOTP=true is the real signal — overrides absent YAML", () => {
    const env = makeVaultHome();
    try {
      // No YAML totp_secret, but a hub.db user has enrolled real 2FA (hub#473).
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: () => true,
        probeHubDbHasTotp: () => true,
      });
      expect(status.hasTotp).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db TOTP=false (column present, none enrolled) overrides a stale YAML true", () => {
    const env = makeVaultHome();
    try {
      // Legacy YAML totp_secret present, but hub.db definitively says no user
      // has enrolled real hub-login 2FA → report false (the real signal wins).
      writeConfig(env.path, 'totp_secret: "JBSWY3DPEHPK3PXP"\n');
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: () => true,
        probeHubDbHasTotp: () => false,
      });
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

describe("readVaultAuthStatus — YAML fallback (pre-multi-user installs)", () => {
  test("missing config.yaml AND hub.db unreachable → both signals false", () => {
    const env = makeVaultHome();
    try {
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: hubDbUnreachable,
        probeHubDbHasTotp: hubDbUnreachable,
      });
      expect(status.hasOwnerPassword).toBe(false);
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("both YAML keys present, hub.db unreachable → both true", () => {
    const env = makeVaultHome();
    try {
      writeConfig(
        env.path,
        [
          "port: 1940",
          'owner_password_hash: "$2b$12$somehashhere"',
          'totp_secret: "JBSWY3DPEHPK3PXP"',
          "",
        ].join("\n"),
      );
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: hubDbUnreachable,
        probeHubDbHasTotp: hubDbUnreachable,
      });
      expect(status.hasOwnerPassword).toBe(true);
      expect(status.hasTotp).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("empty quoted YAML values are absent (matches vault's readGlobalConfig)", () => {
    const env = makeVaultHome();
    try {
      writeConfig(env.path, ['owner_password_hash: ""', 'totp_secret: ""', ""].join("\n"));
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: hubDbUnreachable,
        probeHubDbHasTotp: hubDbUnreachable,
      });
      expect(status.hasOwnerPassword).toBe(false);
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("only YAML owner_password_hash present, hub.db unreachable", () => {
    const env = makeVaultHome();
    try {
      writeConfig(env.path, 'owner_password_hash: "$2b$12$abc"\n');
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: hubDbUnreachable,
        probeHubDbHasTotp: hubDbUnreachable,
      });
      expect(status.hasOwnerPassword).toBe(true);
      expect(status.hasTotp).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

describe("readVaultAuthStatus — vault discovery", () => {
  test("no data/ dir → vaultNames empty, tokenCount 0", () => {
    const env = makeVaultHome();
    try {
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 999,
        probeHubDbHasUserPassword: hubDbUnreachable,
      });
      expect(status.vaultNames).toEqual([]);
      expect(status.tokenCount).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  test("directories without vault.yaml are skipped", () => {
    const env = makeVaultHome();
    try {
      // "real" vault
      seedVault(env.path, "default", { withDb: true });
      // garbage dir that happens to sit under data/
      mkdirSync(join(env.path, "data", "stray"), { recursive: true });
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: () => 0,
        probeHubDbHasUserPassword: hubDbUnreachable,
      });
      expect(status.vaultNames).toEqual(["default"]);
    } finally {
      env.cleanup();
    }
  });
});

describe("readVaultAuthStatus — token count resilience", () => {
  test("sums across multiple vaults", () => {
    const env = makeVaultHome();
    try {
      seedVault(env.path, "default", { withDb: true });
      seedVault(env.path, "work", { withDb: true });
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: (dbPath) => (dbPath.includes("/default/") ? 2 : 3),
        probeHubDbHasUserPassword: hubDbUnreachable,
      });
      expect(status.tokenCount).toBe(5);
      expect(new Set(status.vaultNames)).toEqual(new Set(["default", "work"]));
    } finally {
      env.cleanup();
    }
  });

  test("vault.yaml present but vault.db missing → count that vault as 0, keep going", () => {
    const env = makeVaultHome();
    try {
      seedVault(env.path, "default", { withDb: false });
      seedVault(env.path, "work", { withDb: true });
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: (dbPath) => {
          // Should only be called for the vault whose DB exists.
          if (dbPath.includes("/default/")) throw new Error("should not open missing DB");
          return 4;
        },
        probeHubDbHasUserPassword: hubDbUnreachable,
      });
      expect(status.tokenCount).toBe(4);
    } finally {
      env.cleanup();
    }
  });

  test("countTokens throws → tokenCount degrades to null (not partial)", () => {
    const env = makeVaultHome();
    try {
      seedVault(env.path, "default", { withDb: true });
      seedVault(env.path, "work", { withDb: true });
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        countTokens: (dbPath) => {
          if (dbPath.includes("/work/")) throw new Error("locked");
          return 2;
        },
        probeHubDbHasUserPassword: hubDbUnreachable,
      });
      // Even though "default" succeeded with 2, we return null — callers
      // shouldn't see a misleading partial count.
      expect(status.tokenCount).toBeNull();
    } finally {
      env.cleanup();
    }
  });
});

describe("readVaultAuthStatus — defaultProbeHubDbHasUserPassword end-to-end", () => {
  // These tests exercise the real `bun:sqlite` probe (no injected fake)
  // to catch breakage in the on-disk read path: schema drift, opening
  // semantics, undefined-returns-on-failure.

  test("hub.db missing → probe returns undefined → falls back to YAML cleanly", () => {
    const env = makeVaultHome();
    try {
      writeConfig(env.path, 'owner_password_hash: "$2b$12$legacyfromYAML"\n');
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        hubDbPath: join(env.path, "definitely-not-here.db"),
        countTokens: () => 0,
      });
      expect(status.hasOwnerPassword).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db exists with users.password_hash set → hasOwnerPassword: true", () => {
    const env = makeVaultHome();
    try {
      // Build a real hub.db with the canonical schema + an `unforced` user.
      const { Database } = require("bun:sqlite");
      const dbPath = join(env.path, "hub.db");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          password_changed INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO users (id, username, password_hash, created_at, updated_at, password_changed)
        VALUES ('u1', 'unforced', '$argon2id$v=19$realhashhere', '2026-05-26T00:00:00Z', '2026-05-26T00:00:00Z', 1);
      `);
      db.close();
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        hubDbPath: dbPath,
        countTokens: () => 0,
      });
      expect(status.hasOwnerPassword).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db exists but users table empty → falls back to YAML", () => {
    const env = makeVaultHome();
    try {
      const { Database } = require("bun:sqlite");
      const dbPath = join(env.path, "hub.db");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          password_changed INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.close();
      // YAML provides the password — should still be true.
      writeConfig(env.path, 'owner_password_hash: "$2b$12$fallbackhash"\n');
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        hubDbPath: dbPath,
        countTokens: () => 0,
      });
      expect(status.hasOwnerPassword).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db exists but schema is missing the users table → probe returns undefined, YAML fallback", () => {
    const env = makeVaultHome();
    try {
      // A hub.db that hasn't run migration v2 yet (only signing_keys, v1).
      const { Database } = require("bun:sqlite");
      const dbPath = join(env.path, "hub.db");
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE signing_keys (kid TEXT PRIMARY KEY);
      `);
      db.close();
      writeConfig(env.path, 'owner_password_hash: "$2b$12$onlyinYAML"\n');
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        hubDbPath: dbPath,
        countTokens: () => 0,
      });
      // SELECT against nonexistent `users` throws → probe returns undefined
      // → YAML wins → password reported as set.
      expect(status.hasOwnerPassword).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("hub.db users table has a row with empty password_hash → treated as no password", () => {
    const env = makeVaultHome();
    try {
      const { Database } = require("bun:sqlite");
      const dbPath = join(env.path, "hub.db");
      const db = new Database(dbPath);
      // NOT NULL on password_hash, but allow empty string — schema check
      // is just for "non-empty hash exists."
      db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          password_changed INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO users (id, username, password_hash, created_at, updated_at, password_changed)
        VALUES ('u1', 'placeholder', '', '2026-05-26T00:00:00Z', '2026-05-26T00:00:00Z', 0);
      `);
      db.close();
      const status = readVaultAuthStatus({
        vaultHome: env.path,
        hubDbPath: dbPath,
        countTokens: () => 0,
      });
      // No YAML, no non-empty hub.db password → wide open.
      expect(status.hasOwnerPassword).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});
