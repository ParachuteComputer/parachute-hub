/**
 * Persist the resolved hub PUBLIC origin into `<configDir>/vault/.env` so the
 * launchd / systemd daemon validates hub-minted JWTs against it.
 *
 * The OAuth issuer-mismatch P0 (this module's reason to exist): hub stamps the
 * public origin (e.g. `https://parachute-x.ts.net`) on every JWT it mints.
 * Vault, as the resource server, validates the `iss` claim against
 * `getHubOrigin()` (`parachute-vault/src/hub-jwt.ts`), which reads ONLY
 * `PARACHUTE_HUB_ORIGIN` from its process env and falls back to loopback
 * `http://127.0.0.1:1939` when unset.
 *
 * `parachute start|restart vault` injects `PARACHUTE_HUB_ORIGIN` into the
 * *spawn* env (see `commands/lifecycle.ts`). But the real-world boot path on an
 * owner-operated box is the autostart daemon: `parachute-vault init` registers
 * a launchd agent (macOS) / systemd unit (Linux) with `KeepAlive`/`Restart`,
 * and that daemon boots vault out-of-band via `~/.parachute/vault/start.sh`.
 * The wrapper sources `~/.parachute/vault/.env` and never reads expose-state,
 * and the launchd plist carries no `EnvironmentVariables`. So on every reboot
 * or crash-restart, launchd starts vault with NO `PARACHUTE_HUB_ORIGIN`, vault
 * falls back to loopback, and every token stamped with the public FQDN fails
 * the `iss` check → `HubJwtError('issuer')` → 401 on every OAuth/MCP reconnect.
 * Bricks team onboarding on any exposed deploy.
 *
 * The durable fix: write `PARACHUTE_HUB_ORIGIN` into `vault/.env` so the daemon
 * boot path picks it up too. Mirrors `auto-wire.ts`'s vault-.env writes
 * (SCRIBE_AUTH_TOKEN / SCRIBE_URL) — hub owns these keys, vault's boot wrapper
 * reads them.
 */
import { join } from "node:path";
import { parseEnvFile, removeEnvLine, upsertEnvLine, writeEnvFile } from "./env-file.ts";
import { HUB_ORIGIN_ENV } from "./hub-origin.ts";

/**
 * Loopback origins (`http://127.0.0.1:<port>`, `localhost`, `[::1]`) are the
 * local-dev fallback `deriveHubOrigin` returns when no exposure is active. We
 * never *persist* one — baking a loopback value into `.env` would SHADOW a
 * later exposure on the daemon boot path (which has no other source of truth),
 * recreating the exact `iss` mismatch this fix prevents. Worse than absent.
 */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    // URL.hostname keeps IPv6 in bracket form (`[::1]`); strip them so the
    // comparison is on the bare address.
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function vaultEnvPath(configDir: string): string {
  return join(configDir, "vault", ".env");
}

/**
 * Upsert `PARACHUTE_HUB_ORIGIN=<origin>` into `vault/.env` when `origin` is a
 * non-loopback public origin. Idempotent — skips the write (and the log) when
 * the value is already current so repeated `start`s don't churn the file.
 * Returns true iff the file was written this call.
 */
export function persistVaultHubOrigin(
  configDir: string,
  origin: string,
  log: (line: string) => void,
): boolean {
  if (isLoopbackOrigin(origin)) return false;
  const path = vaultEnvPath(configDir);
  const parsed = parseEnvFile(path);
  if (parsed.values[HUB_ORIGIN_ENV] === origin) return false;
  writeEnvFile(path, upsertEnvLine(parsed.lines, HUB_ORIGIN_ENV, origin));
  log(`  persisted ${HUB_ORIGIN_ENV}=${origin} to ${path} (survives daemon restart)`);
  return true;
}

/**
 * Drop a previously-persisted `PARACHUTE_HUB_ORIGIN` from `vault/.env`. Called
 * on `expose … off`: once exposure is torn down, a local-only hub mints tokens
 * with a loopback `iss`, so a stale public origin left in `.env` would itself
 * cause the mismatch. Removing the line reverts vault to its loopback default
 * (`getHubOrigin`), which matches what the local hub now stamps. No-op (returns
 * false) when the key isn't present. Returns true iff the file was rewritten.
 */
export function clearVaultHubOrigin(configDir: string, log: (line: string) => void): boolean {
  const path = vaultEnvPath(configDir);
  const parsed = parseEnvFile(path);
  if (parsed.values[HUB_ORIGIN_ENV] === undefined) return false;
  writeEnvFile(path, removeEnvLine(parsed.lines, HUB_ORIGIN_ENV));
  log(`  cleared ${HUB_ORIGIN_ENV} from ${path} (exposure torn down)`);
  return true;
}
