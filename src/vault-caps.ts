/**
 * Per-vault storage caps (migration v15, DEMO-PREP-2026-06-25 Workstream B,
 * task B4). A vault provisioned through a capped signup link gets a row in
 * the `vault_caps` table recording its byte ceiling. This module is the
 * read/write seam over that table.
 *
 * Split of responsibility, on purpose:
 *   - THIS PR (B1/B2/B4) PERSISTS the cap at provision time — nothing more.
 *     The public-signup flow stamps a row here when it provisions a vault.
 *   - A SEPARATE Phase-2 PR (B3, parachute-vault + hub wiring) READS this
 *     row and ENFORCES it at upload time (4xx over cap). The brief is
 *     explicit: "at minimum store the cap so the later PR can read + enforce
 *     it." So `getVaultCapBytes` exists for that future reader; this PR only
 *     calls `setVaultCap`.
 *
 * Keyed by `vault_name` — the same instance-name space used across
 * services.json / `user_vaults` / `invites.vault_name`. No FK to a vaults
 * table (there isn't one — vault names resolve through services.json, the
 * established hub pattern). A vault with NO row is "uncapped," which is what
 * the Phase-2 reader treats every pre-existing / admin-provisioned vault as.
 */
import type { Database } from "bun:sqlite";

/**
 * Default per-vault cap stamped by the public-signup flow when an invite
 * carries no explicit cap but the flow wants one: ~1 GB (DEMO-PREP decision
 * "1 GB per vault, configurable"). 1 GiB = 1024^3 bytes.
 */
export const DEFAULT_VAULT_CAP_BYTES = 1024 * 1024 * 1024;

export interface VaultCap {
  vaultName: string;
  capBytes: number;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  vault_name: string;
  cap_bytes: number;
  created_at: string;
  updated_at: string;
}

function rowToCap(r: Row): VaultCap {
  return {
    vaultName: r.vault_name,
    capBytes: r.cap_bytes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Persist (or update) a vault's storage cap. Upsert on `vault_name`: a
 * re-provision (or a future admin edit) overwrites the cap and bumps
 * `updated_at` while preserving the original `created_at`. `capBytes` must
 * be a positive integer — callers validate before reaching here; this
 * floors to an int defensively.
 */
export function setVaultCap(
  db: Database,
  vaultName: string,
  capBytes: number,
  now: Date = new Date(),
): VaultCap {
  const stamp = now.toISOString();
  const bytes = Math.floor(capBytes);
  db.prepare(
    `INSERT INTO vault_caps (vault_name, cap_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(vault_name) DO UPDATE SET
       cap_bytes = excluded.cap_bytes,
       updated_at = excluded.updated_at`,
  ).run(vaultName, bytes, stamp, stamp);
  // Re-read so the returned createdAt reflects the preserved original on an
  // update (excluded.created_at is NOT written on conflict).
  const cap = getVaultCap(db, vaultName);
  // The row was just written, so it always exists; the non-null assertion
  // is safe but we fall back defensively rather than throw.
  return cap ?? { vaultName, capBytes: bytes, createdAt: stamp, updatedAt: stamp };
}

/** Read a vault's cap, or `null` when the vault has no cap row (uncapped). */
export function getVaultCap(db: Database, vaultName: string): VaultCap | null {
  const row = db
    .query<Row, [string]>("SELECT * FROM vault_caps WHERE vault_name = ?")
    .get(vaultName);
  return row ? rowToCap(row) : null;
}

/**
 * Convenience for the Phase-2 enforcement reader: the cap in bytes, or
 * `null` (uncapped) when no row exists. Thin wrapper over {@link getVaultCap}.
 */
export function getVaultCapBytes(db: Database, vaultName: string): number | null {
  return getVaultCap(db, vaultName)?.capBytes ?? null;
}

/**
 * List every persisted vault cap (B5 admin visibility). Returns only vaults
 * that HAVE a cap row — the admin surface joins this against the live
 * services.json vault list so an uncapped vault still appears (as "uncapped")
 * while a capped vault shows its ceiling. Ordered by `vault_name` for a
 * deterministic table.
 */
export function listVaultCaps(db: Database): VaultCap[] {
  const rows = db.query<Row, []>("SELECT * FROM vault_caps ORDER BY vault_name ASC").all();
  return rows.map(rowToCap);
}

/**
 * Vault-delete cascade hook (parity with the other per-vault identity
 * artifacts swept in admin-vaults.ts `handleDeleteVault`): drop the cap row
 * when its vault is deleted so a re-created same-name vault doesn't inherit a
 * stale cap. Exact `=` match, no pattern. Returns rows deleted (0 or 1).
 */
export function removeVaultCap(db: Database, vaultName: string): number {
  const res = db.prepare("DELETE FROM vault_caps WHERE vault_name = ?").run(vaultName);
  return Number(res.changes);
}
