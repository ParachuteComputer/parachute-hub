import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { hubDbPath } from "../hub-db.ts";
import { vaultRenameReservedUntil } from "../vault-rename-guard.ts";

export async function dispatchVault(args: readonly string[]): Promise<number> {
  try {
    // The passthrough create verb must honor the same old-name quarantine as
    // POST /vaults. Read-only: the running hub remains the identity writer.
    let createName: string | undefined;
    if (args[0] === "create") {
      // Match vault create's positional parsing, including flags before name.
      for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--token" || arg === "--scope") {
          i++;
          continue;
        }
        if (arg.startsWith("--")) continue;
        createName = arg.trim();
        break;
      }
    }
    if (createName && existsSync(hubDbPath())) {
      const db = new Database(hubDbPath(), { readonly: true });
      try {
        const until = vaultRenameReservedUntil(db, createName);
        if (until) {
          console.error(`Vault name "${createName}" is reserved after rename until ${until}`);
          return 1;
        }
      } finally {
        db.close();
      }
    }
    const proc = Bun.spawn(["parachute-vault", ...args], {
      stdio: ["inherit", "inherit", "inherit"],
      // Inherit env so parachute-vault sees PATH, HOME, PARACHUTE_HOME, etc.
      // Bun.spawn defaults to empty env — see api-modules-ops.ts:defaultRun.
      env: process.env,
    });
    return await proc.exited;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("enoent") || msg.toLowerCase().includes("not found")) {
      console.error("parachute-vault not found on PATH.");
      console.error("Install it with: parachute install vault");
      return 127;
    }
    console.error(`failed to run parachute-vault: ${msg}`);
    return 1;
  }
}
