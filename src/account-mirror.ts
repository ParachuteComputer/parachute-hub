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

/**
 * Outcome of the most recent push to the configured remote.
 *
 * `config.auto_push` says a remote is *set up*; it says nothing about whether
 * anything has ever landed there. These are the three cases the tile has to
 * tell apart, and `"never"` is deliberately its own state rather than a shade
 * of `"failing"`:
 *
 *   - `ok`      — a push has succeeded and the latest one did not fail.
 *   - `failing` — a push succeeded at some point, the latest one failed. A
 *                 blip: the remote exists and has accepted history before.
 *   - `never`   — no push has EVER succeeded. That is a setup bug (wrong
 *                 remote, unrelated history, bad credentials), not a blip,
 *                 and it means there is no off-site copy at all.
 *   - `n/a`     — no auto-push remote configured; local version history only.
 */
export type RemotePushState = "ok" | "failing" | "never" | "n/a";

/** The subset of vault's mirror report the `/account/` tile renders. */
export interface VaultMirrorStat {
  /** Backup is on — a version-history mirror is configured + bootstrapped. */
  enabled: boolean;
  /**
   * Backup leaves the box — an auto-push remote (GitHub or any git remote) is
   * configured (`config.auto_push`). Drives the "+ GitHub" line variant AND
   * gates the "Back up to GitHub ↗" action (suppressed once already pushing).
   * Threaded through as a proper boolean so the renderer never has to re-derive
   * "are we pushing?" from display-string content.
   *
   * NOTE: this is *configuration*, not outcome. Never render a claim that the
   * vault is backed up off-site from this field alone — that is exactly the
   * bug this module carried until vault#822: 122 consecutive rejected pushes
   * rendered as "Backed up — version history + GitHub" because a remote was
   * configured. Use `remotePushState` for anything that asserts success.
   */
  backedUpToRemote: boolean;
  /**
   * Outcome of the most recent push, from the vault's runtime status
   * (`status.last_push_at` / `status.last_push_error`) — NOT from config.
   * `"n/a"` when `backedUpToRemote` is false.
   */
  remotePushState: RemotePushState;
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
 * reads as backed up. `backedUpToRemote` is true when an auto-push remote is
 * configured (the GitHub variant of backup).
 *
 * That config-over-runtime read is deliberate for *local* history — bootstrap
 * lag is a few seconds and nagging through it is worse than waiting. It is NOT
 * safe for the off-site claim, which is why `remotePushState` comes from
 * `status.last_push_at` / `status.last_push_error` instead. A remote that has
 * been configured for five days and rejected every push is `"never"`, and the
 * tile must not call that backed up.
 *
 * Tolerant, same as the rest of this module: a vault too old to report
 * `status` at all leaves `remotePushState` at `"ok"` rather than crying wolf —
 * the fields were added in vault Cut 5, so their absence means "can't tell",
 * not "failing".
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
      status?: { last_push_at?: unknown; last_push_error?: unknown };
    };
    const enabled = body.config?.enabled;
    if (typeof enabled !== "boolean") return null;
    const backedUpToRemote = body.config?.auto_push === true;
    return {
      enabled,
      backedUpToRemote,
      remotePushState: derivePushState(backedUpToRemote, body.status),
    };
  } catch {
    return null;
  }
}

/**
 * Map the vault's runtime push fields onto {@link RemotePushState}.
 *
 * The vault reports `last_push_at` (ISO string of the last SUCCESSFUL push,
 * null until one lands) and `last_push_error` (message from the last FAILED
 * push, cleared on the next success). The pair distinguishes all three cases
 * without the vault needing a new field:
 *
 *   at=null  err=set   → never   (configured, nothing has ever landed)
 *   at=set   err=set   → failing (landed before, latest attempt failed)
 *   at=set   err=null  → ok
 *   at=null  err=null  → ok      (nothing attempted yet — a fresh mirror mid-
 *                                 bootstrap, not a failure. Same "don't cry
 *                                 wolf" posture as the missing-`status` case.)
 *
 * Exported for direct unit testing.
 */
export function derivePushState(
  backedUpToRemote: boolean,
  status: { last_push_at?: unknown; last_push_error?: unknown } | undefined,
): RemotePushState {
  if (!backedUpToRemote) return "n/a";
  // A vault too old to report these fields can't be judged — stay quiet.
  if (status === undefined || status === null) return "ok";
  const hasError = typeof status.last_push_error === "string" && status.last_push_error.length > 0;
  if (!hasError) return "ok";
  const everSucceeded = typeof status.last_push_at === "string" && status.last_push_at.length > 0;
  return everSucceeded ? "failing" : "never";
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
  if (!stat.backedUpToRemote) return "Backed up — full version history";
  switch (stat.remotePushState) {
    case "never":
      // The loudest line, and the only one that says a thing is missing. A
      // remote that has never accepted a push means there is no off-site copy
      // at all — the owner needs to know that plainly, not read "backed up".
      return "Version history saved here — GitHub backup has never worked";
    case "failing":
      return "Version history saved here — GitHub backup is failing";
    default:
      return "Backed up — version history + GitHub";
  }
}

/**
 * Whether the backup line describes a good state — drives the tile's `✓`.
 *
 * Split out as a proper boolean rather than sniffing the display string, the
 * same convention `backedUpToRemote` already set for the "Back up to GitHub ↗"
 * gate. A failing or never-worked remote must not render a green check next to
 * a sentence explaining that it is broken.
 */
export function isMirrorHealthy(stat: VaultMirrorStat): boolean {
  if (!stat.enabled) return false;
  return stat.remotePushState !== "never" && stat.remotePushState !== "failing";
}
