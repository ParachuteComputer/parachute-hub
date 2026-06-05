/**
 * Per-vault backup (mirror) status fetch for the friend-facing `/account/` home.
 *
 * Vault serves `GET /vault/<name>/.parachute/mirror` (ADMIN-scoped) returning
 * the persisted mirror config + the runtime status the manager is tracking:
 *   { config: { enabled, location, external_path, sync_mode, auto_push, ... },
 *     status: { enabled, last_commit_sha, last_error, ... } }
 *
 * The `/account/` GET handler renders one tile per assigned vault; this module
 * fetches each vault's mirror status so the tile can show a warm, plain-language
 * backup line ("✓ Backed up — full version history", or "+ GitHub" when a push
 * remote is configured). Backup is the local git version-history mirror vault
 * stands up by default; the GitHub variant is the auto-push-to-a-remote setup.
 *
 * The endpoint gates on `vault:<name>:admin`, so this is only fetched for users
 * who hold the admin verb on the vault (same gate as the "Advanced vault
 * settings ↗" deep-link). We mint a short-lived `vault:<name>:admin` token —
 * the same authority the OAuth issuer / admin path would grant them — and call
 * the vault over loopback.
 *
 * Tolerant by design: any failure (vault down, endpoint absent on an older
 * vault, mint failure, malformed JSON, insufficient scope) resolves to `null`
 * so the tile simply omits the backup line rather than breaking the page —
 * exactly the posture of `account-usage.ts`'s `fetchVaultUsage`.
 *
 * Injectable seams (`fetchImpl`, `signToken`) keep it unit-testable without a
 * live vault or real signing key.
 */
import type { Database } from "bun:sqlite";
import { signAccessToken } from "./jwt-sign.ts";

/** The subset of vault's mirror report the `/account/` tile renders. */
export interface VaultMirrorStat {
  /** Backup is on — a version-history mirror is configured + bootstrapped. */
  enabled: boolean;
  /** A GitHub (or any git remote) push is configured — backup leaves the box. */
  pushing: boolean;
}

/** Short TTL for the admin token — used immediately for one loopback call. */
const MIRROR_READ_TOKEN_TTL_SECONDS = 60;

export interface FetchVaultMirrorStatusDeps {
  db: Database;
  /** Hub origin — `iss` of the minted token. */
  hubOrigin: string;
  /** Loopback port the vault backend listens on (from services.json). */
  vaultPort: number;
  /** The user minting against their own admin authority — `sub` of the token. */
  userId: string;
  /** Test seam — `globalThis.fetch` in production. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to the real `signAccessToken`. */
  signToken?: typeof signAccessToken;
  /** Test seam for the clock. */
  now?: () => Date;
}

/**
 * Fetch one vault's backup (mirror) status for the friend's tile, or `null` on
 * any failure.
 *
 * Mints a `vault:<name>:admin` bearer for `userId` (capped to that one vault via
 * `vaultScope`) and GETs the vault's loopback mirror endpoint. Never throws —
 * the page renders without the backup line on any error.
 *
 * "Backed up" is true when the persisted config says `enabled` (a version-
 * history mirror) — we read the persisted config, not just the runtime
 * `status.enabled`, so a freshly-configured-but-not-yet-bootstrapped vault still
 * reads as backed up. "Pushing" is true when an auto-push remote is configured
 * (the GitHub variant of backup).
 */
export async function fetchVaultMirrorStatus(
  vaultName: string,
  deps: FetchVaultMirrorStatusDeps,
): Promise<VaultMirrorStat | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sign = deps.signToken ?? signAccessToken;
  try {
    const scope = `vault:${vaultName}:admin`;
    const minted = await sign(deps.db, {
      sub: deps.userId,
      scopes: [scope],
      audience: `vault.${vaultName}`,
      clientId: "parachute-account",
      issuer: deps.hubOrigin,
      ttlSeconds: MIRROR_READ_TOKEN_TTL_SECONDS,
      vaultScope: [vaultName],
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    const url = `http://127.0.0.1:${deps.vaultPort}/vault/${vaultName}/.parachute/mirror`;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${minted.token}`, accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      config?: { enabled?: unknown; auto_push?: unknown };
    };
    const enabled = body.config?.enabled;
    if (typeof enabled !== "boolean") return null;
    const pushing = body.config?.auto_push === true;
    return { enabled, pushing };
  } catch {
    return null;
  }
}

/**
 * Format a mirror stat as the warm, plain-language backup line the tile shows,
 * or `null` when backup is off (the tile then omits the line entirely — we
 * don't nag with a "not backed up" warning on the everyday home).
 *
 * Exported for direct unit testing + reuse by the renderer.
 */
export function formatMirrorLine(stat: VaultMirrorStat): string | null {
  if (!stat.enabled) return null;
  return stat.pushing ? "Backed up — version history + GitHub" : "Backed up — full version history";
}
