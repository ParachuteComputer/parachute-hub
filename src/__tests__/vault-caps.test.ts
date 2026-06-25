/**
 * Per-vault storage cap store (`src/vault-caps.ts`, migration v15, B4). The
 * cap is PERSISTED here at provision time; a separate Phase-2 PR reads + enforces
 * it. These tests cover the read/write/upsert/remove primitives + the "no row
 * = uncapped" contract the Phase-2 reader relies on.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  DEFAULT_VAULT_CAP_BYTES,
  getVaultCap,
  getVaultCapBytes,
  removeVaultCap,
  setVaultCap,
} from "../vault-caps.ts";

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "phub-vault-caps-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("vault-caps", () => {
  test("default cap constant is ~1 GiB", () => {
    expect(DEFAULT_VAULT_CAP_BYTES).toBe(1024 * 1024 * 1024);
  });

  test("no row = uncapped (null) — the Phase-2 reader's contract", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(getVaultCap(db, "nope")).toBeNull();
      expect(getVaultCapBytes(db, "nope")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("setVaultCap persists, getVaultCapBytes reads it back", () => {
    const { db, cleanup } = makeDb();
    try {
      const now = new Date("2026-06-25T00:00:00Z");
      const cap = setVaultCap(db, "alice", DEFAULT_VAULT_CAP_BYTES, now);
      expect(cap.vaultName).toBe("alice");
      expect(cap.capBytes).toBe(DEFAULT_VAULT_CAP_BYTES);
      expect(cap.createdAt).toBe(now.toISOString());
      expect(getVaultCapBytes(db, "alice")).toBe(DEFAULT_VAULT_CAP_BYTES);
    } finally {
      cleanup();
    }
  });

  test("upsert: re-set overwrites cap_bytes, bumps updated_at, preserves created_at", () => {
    const { db, cleanup } = makeDb();
    try {
      const t0 = new Date("2026-06-25T00:00:00Z");
      const t1 = new Date("2026-06-26T00:00:00Z");
      setVaultCap(db, "alice", 1000, t0);
      const updated = setVaultCap(db, "alice", 2000, t1);
      expect(updated.capBytes).toBe(2000);
      expect(updated.createdAt).toBe(t0.toISOString()); // preserved
      expect(updated.updatedAt).toBe(t1.toISOString()); // bumped
      expect(getVaultCapBytes(db, "alice")).toBe(2000);
    } finally {
      cleanup();
    }
  });

  test("removeVaultCap drops the row (cascade parity) — returns count", () => {
    const { db, cleanup } = makeDb();
    try {
      setVaultCap(db, "alice", 1000);
      expect(removeVaultCap(db, "alice")).toBe(1);
      expect(getVaultCapBytes(db, "alice")).toBeNull();
      // Idempotent — removing a missing row is 0.
      expect(removeVaultCap(db, "alice")).toBe(0);
    } finally {
      cleanup();
    }
  });
});
