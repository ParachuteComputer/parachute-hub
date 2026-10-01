import type { Database } from "bun:sqlite";

/** Durable name reservation in the existing settings table. All hub create
 * doors share provisionVault; raw module CLI operations bypass hub policy. */
export function vaultRenameReservedUntil(
  db: Database,
  name: string,
  now = new Date(),
): string | null {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM hub_settings WHERE key = ?")
    .get(`vault_rename_reserved:${name}`);
  return row && Date.parse(row.value) > now.getTime() ? row.value : null;
}
