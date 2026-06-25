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
import { readHubPort } from "./hub-control.ts";
import { HUB_ORIGINS_ENV, HUB_ORIGIN_ENV, serializeHubOrigins } from "./hub-origin.ts";
import { HUB_UNIT_DEFAULT_PORT } from "./hub-unit.ts";
import { buildHubBoundOrigins } from "./origin-check.ts";

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

/**
 * Canonicalize a candidate public origin for use as the hub's OAuth issuer:
 * strip trailing slashes, then accept it only when it parses as an absolute
 * `http(s)` URL that is NOT loopback. Returns the canonical origin or
 * undefined when it fails any check.
 *
 * Shared by the two expose-state issuer fallbacks (`resolveStartupIssuer` in
 * commands/serve.ts and `exposeIssuerOrigin` in hub-server.ts) so the guard
 * — never let a non-http(s) or loopback value pin the issuer — stays
 * identical on both origin-resolution chokepoints (#531). The loopback
 * rejection is defensive: expose-state.hubOrigin should always be the public
 * origin, but a stray loopback value would re-pin the degraded
 * request-origin mode the fix exists to escape.
 */
export function sanitizePublicOrigin(raw: string | undefined): string | undefined {
  const trimmed = raw?.replace(/\/+$/, "");
  if (!trimmed) return undefined;
  let proto: string;
  try {
    proto = new URL(trimmed).protocol;
  } catch {
    return undefined;
  }
  if (proto !== "http:" && proto !== "https:") return undefined;
  if (isLoopbackOrigin(trimmed)) return undefined;
  return trimmed;
}

function vaultEnvPath(configDir: string): string {
  return join(configDir, "vault", ".env");
}

/**
 * Compose `https://${FLY_APP_NAME}.fly.dev` when FLY_APP_NAME is a plausible
 * Fly app slug (no slashes — Fly slugs don't contain them). Mirrors the
 * private helper in operator-token.ts / hub-server.ts; kept local so the
 * origin-SET assembly here doesn't reach across modules for a 3-line guard.
 */
function flyDefaultOriginFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const app = env.FLY_APP_NAME;
  if (typeof app !== "string" || app.length === 0 || app.includes("/")) return undefined;
  return `https://${app}.fly.dev`;
}

/**
 * Assemble the comma-separated `PARACHUTE_HUB_ORIGINS` value the hub injects
 * into supervised resource servers (multi-origin iss-set). The SET is the
 * hub's own legitimate origins — the env-injection sibling of the operator
 * token's `buildKnownIssuersForOperatorToken` and the per-request
 * `buildHubBoundOrigins` call in hub-server.ts. Inputs:
 *
 *   - `issuer` — the canonical hub origin the child also receives as the
 *     single `PARACHUTE_HUB_ORIGIN` (the seed; always included).
 *   - loopback aliases — `http://127.0.0.1:<port>` ∪ `http://localhost:<port>`
 *     for the hub's port (`readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT`).
 *   - the expose-state public origin — `expose-state.json`'s `hubOrigin`.
 *   - the platform/env public origin — `RENDER_EXTERNAL_URL` ∪ the composed
 *     Fly default (container deploys where the public origin comes from the
 *     platform, not expose-state).
 *
 * SECURITY INVARIANT: every input is hub/operator-controlled config or
 * on-disk state — NEVER an unvalidated request `Host` / `X-Forwarded-Host`.
 * The accepted-`iss` widening this enables is safe only because the resource
 * server verifies the JWKS signature first; this set is the belt-and-
 * suspenders allowlist layered on top.
 *
 * Returns `undefined` when the seed issuer is absent AND nothing else resolves
 * (caller skips the env var so the child keeps single-origin behavior).
 */
export function buildHubOriginsEnvValue(
  configDir: string,
  issuer: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  exposeStatePath: string = EXPOSE_STATE_PATH,
): string | undefined {
  const loopbackPort = readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT;
  let exposeHubOrigin: string | undefined;
  try {
    exposeHubOrigin = readExposeState(exposeStatePath)?.hubOrigin;
  } catch {
    // A malformed expose-state.json must never block a module spawn — the seed
    // issuer + loopback aliases already cover legitimate access.
    exposeHubOrigin = undefined;
  }
  const platformOrigin = env.RENDER_EXTERNAL_URL ?? flyDefaultOriginFromEnv(env);
  const origins = buildHubBoundOrigins({
    // buildHubBoundOrigins requires `issuer`; pass "" when absent (it's dropped
    // by the URL parse) so the loopback aliases still seed the set.
    issuer: issuer ?? "",
    loopbackPort,
    ...(exposeHubOrigin !== undefined ? { exposeHubOrigin } : {}),
    ...(platformOrigin !== undefined ? { platformOrigin } : {}),
  });
  return serializeHubOrigins(origins);
}

/**
 * Upsert `PARACHUTE_HUB_ORIGIN=<origin>` into `vault/.env` when `origin` is a
 * non-loopback public origin, AND the `PARACHUTE_HUB_ORIGINS` set (the
 * multi-origin iss-set: origin ∪ loopback aliases ∪ expose-state ∪ platform)
 * so the daemon-boot path validates `iss` against every URL the box answers on
 * (a Caddy-fronted box reached via loopback + sslip.io + a custom domain at
 * once). The set is assembled from hub-controlled inputs only (see
 * `buildHubOriginsEnvValue`'s security invariant). Idempotent — skips the
 * write (and the log) when BOTH values are already current so repeated
 * `start`s don't churn the file. Returns true iff the file was written.
 */
export function persistVaultHubOrigin(
  configDir: string,
  origin: string,
  log: (line: string) => void,
): boolean {
  if (isLoopbackOrigin(origin)) return false;
  const path = vaultEnvPath(configDir);
  const parsed = parseEnvFile(path);
  const originsValue = buildHubOriginsEnvValue(configDir, origin);
  const originCurrent = parsed.values[HUB_ORIGIN_ENV] === origin;
  const originsCurrent =
    originsValue === undefined || parsed.values[HUB_ORIGINS_ENV] === originsValue;
  if (originCurrent && originsCurrent) return false;
  let lines = parsed.lines;
  if (!originCurrent) lines = upsertEnvLine(lines, HUB_ORIGIN_ENV, origin);
  if (!originsCurrent && originsValue !== undefined) {
    lines = upsertEnvLine(lines, HUB_ORIGINS_ENV, originsValue);
  }
  writeEnvFile(path, lines);
  if (!originCurrent) {
    log(`  persisted ${HUB_ORIGIN_ENV}=${origin} to ${path} (survives daemon restart)`);
  }
  if (!originsCurrent && originsValue !== undefined) {
    log(`  persisted ${HUB_ORIGINS_ENV}=${originsValue} to ${path} (multi-origin iss-set)`);
  }
  return true;
}

/**
 * Drop a previously-persisted `PARACHUTE_HUB_ORIGIN` (and `PARACHUTE_HUB_ORIGINS`)
 * from `vault/.env`. Called on `expose … off`: once exposure is torn down, a
 * local-only hub mints tokens with a loopback `iss`, so a stale public origin
 * left in `.env` would itself cause the mismatch. Removing the lines reverts
 * vault to its loopback default (`getHubOrigin`), which matches what the local
 * hub now stamps. No-op (returns false) when neither key is present. Returns
 * true iff the file was rewritten.
 */
export function clearVaultHubOrigin(configDir: string, log: (line: string) => void): boolean {
  const path = vaultEnvPath(configDir);
  const parsed = parseEnvFile(path);
  const hadOrigin = parsed.values[HUB_ORIGIN_ENV] !== undefined;
  const hadOrigins = parsed.values[HUB_ORIGINS_ENV] !== undefined;
  if (!hadOrigin && !hadOrigins) return false;
  let lines = parsed.lines;
  if (hadOrigin) lines = removeEnvLine(lines, HUB_ORIGIN_ENV);
  if (hadOrigins) lines = removeEnvLine(lines, HUB_ORIGINS_ENV);
  writeEnvFile(path, lines);
  if (hadOrigin) log(`  cleared ${HUB_ORIGIN_ENV} from ${path} (exposure torn down)`);
  if (hadOrigins) log(`  cleared ${HUB_ORIGINS_ENV} from ${path} (exposure torn down)`);
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
