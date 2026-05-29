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
import { EXPOSE_STATE_PATH, readExposeState } from "./expose-state.ts";
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
    // `0.0.0.0` is a bind-all wildcard, not a reachable origin — `deriveHubOrigin`
    // never emits it, but `--hub-origin http://0.0.0.0:1939` flows straight
    // through `persistVaultHubOrigin`. Baking it into vault/.env would advertise
    // a non-functional issuer and recreate the iss-mismatch class this guard
    // exists to prevent. Refuse it like any other loopback.
    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    );
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

/**
 * The public origin a live exposure advertises, or undefined when no exposure
 * is active. Both the Tailscale and Cloudflare expose paths populate
 * `expose-state.json` with a `hubOrigin` (the URL stamped into OAuth tokens'
 * `iss` claim); older state files predating Phase 0 may carry only
 * `canonicalFqdn`, so we synthesize `https://<fqdn>` as a fallback. Loopback /
 * empty values resolve to undefined — there's no public origin to persist.
 */
export function publicOriginFromExposeState(
  exposeStatePath: string = EXPOSE_STATE_PATH,
): string | undefined {
  let state: ReturnType<typeof readExposeState>;
  try {
    state = readExposeState(exposeStatePath);
  } catch {
    // A malformed expose-state must never block a vault start — treat it as
    // "no exposure" and let the loopback default stand.
    return undefined;
  }
  if (!state) return undefined;
  const origin = state.hubOrigin ?? (state.canonicalFqdn ? `https://${state.canonicalFqdn}` : "");
  if (!origin || isLoopbackOrigin(origin)) return undefined;
  return origin.replace(/\/+$/, "");
}

/**
 * Self-heal vault's persisted `PARACHUTE_HUB_ORIGIN` from `expose-state.json`.
 *
 * The bug this closes (the Cloudflare 401 P0): on a Cloudflare-tunnel deploy the
 * expose path writes a public `hubOrigin` into `expose-state.json`, but — unlike
 * the Tailscale path, which auto-restarts vault and so flows the public origin
 * into `vault/.env` via `persistVaultHubOrigin` — it never wrote vault's `.env`.
 * So the launchd / systemd daemon kept booting vault with NO `PARACHUTE_HUB_ORIGIN`,
 * vault fell back to loopback as its expected issuer, and every hub-minted token
 * (whose `iss` is the public origin) failed the `iss` check → 401 on every vault
 * request → "You're not signed in to the hub."
 *
 * Called on `parachute start|restart vault`: when expose-state advertises a
 * public origin AND vault's persisted value is unset or loopback, write the
 * public origin. Existing broken deploys self-correct on the next restart, not
 * just fresh ones. We deliberately do NOT overwrite a *different* non-loopback
 * value already in `.env` — that could be a deliberate `--hub-origin` override;
 * `persistVaultHubOrigin` (the explicit, resolved-origin path) owns that case.
 *
 * Returns true iff `.env` was written this call.
 */
export function selfHealVaultHubOrigin(
  configDir: string,
  log: (line: string) => void,
  exposeStatePath: string = EXPOSE_STATE_PATH,
): boolean {
  const publicOrigin = publicOriginFromExposeState(exposeStatePath);
  if (!publicOrigin) return false;
  const current = parseEnvFile(vaultEnvPath(configDir)).values[HUB_ORIGIN_ENV];
  // Only heal the broken shapes: unset (daemon falls back to loopback) or an
  // already-persisted loopback (a value that itself causes the iss mismatch).
  // A current public value — including one equal to publicOrigin — is left to
  // persistVaultHubOrigin's idempotent path so we don't double-log.
  if (current !== undefined && !isLoopbackOrigin(current)) return false;
  return persistVaultHubOrigin(configDir, publicOrigin, log);
}
