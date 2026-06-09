/**
 * Vault-name validator tests (hub#267). Mirrors the vault repo's
 * `vault-name.test.ts` — hub keeps its own copy because it doesn't
 * depend on @openparachute/vault at runtime. The two must stay in
 * lockstep so the typed name hub validates is the one vault accepts.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_VAULT_NAME, RESERVED_VAULT_NAMES, validateVaultName } from "../vault-name.ts";

describe("validateVaultName", () => {
  test("accepts lowercase alphanumeric + hyphens/underscores", () => {
    const cases = ["aaron", "my-vault", "smoke_2026", "abc", "vault123", "a-b_c-d"];
    for (const name of cases) {
      const result = validateVaultName(name);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.name).toBe(name);
    }
  });

  test("trims surrounding whitespace", () => {
    const result = validateVaultName("  aaron  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.name).toBe("aaron");
  });

  test("rejects uppercase letters", () => {
    const result = validateVaultName("Aaron");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("lowercase alphanumeric");
  });

  test("rejects spaces", () => {
    const result = validateVaultName("my vault");
    expect(result.ok).toBe(false);
  });

  test("rejects special characters", () => {
    for (const name of ["my!vault", "vault.dot", "vault/slash", "vault@home"]) {
      const result = validateVaultName(name);
      expect(result.ok).toBe(false);
    }
  });

  test("rejects too-short names (< 2 chars)", () => {
    const result = validateVaultName("a");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("2");
  });

  test("rejects too-long names (> 32 chars)", () => {
    const result = validateVaultName("a".repeat(33));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("32");
  });

  test("accepts boundary lengths (2 and 32)", () => {
    expect(validateVaultName("ab").ok).toBe(true);
    expect(validateVaultName("a".repeat(32)).ok).toBe(true);
  });

  test("rejects empty / whitespace-only names", () => {
    expect(validateVaultName("").ok).toBe(false);
    expect(validateVaultName("   ").ok).toBe(false);
  });

  test("rejects every consolidated reserved name (B2h: list, new, assets, admin)", () => {
    // One set for every hub edge — wizard, invite redemption, POST /vaults.
    // `list` mirrors vault's CLI reservation; `new`/`assets` shadow SPA
    // routes; `admin` shadows the daemon-level /vault/admin mount (B-route).
    for (const name of ["list", "new", "assets", "admin"]) {
      const result = validateVaultName(name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("reserved");
    }
  });

  test("near-miss names of the reserved set still pass (admins, listing, my-admin)", () => {
    for (const name of ["admins", "listing", "my-admin", "assets2", "newer"]) {
      expect(validateVaultName(name).ok).toBe(true);
    }
  });

  test("RESERVED_VAULT_NAMES is the consolidated four-name set", () => {
    expect([...RESERVED_VAULT_NAMES].sort()).toEqual(["admin", "assets", "list", "new"]);
  });

  test("DEFAULT_VAULT_NAME is 'default'", () => {
    expect(DEFAULT_VAULT_NAME).toBe("default");
    // And it passes the validator (sanity check — vault uses this as
    // the canonical fallback).
    expect(validateVaultName(DEFAULT_VAULT_NAME).ok).toBe(true);
  });
});
