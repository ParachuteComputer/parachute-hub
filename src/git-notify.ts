/**
 * Deploy hand-off for the Surface Git Transport (Phase 0b, design doc
 * 2026-06-30-surface-git-transport.md §5 step 5 + §7).
 *
 * After a successful `git push` to `/git/<name>` (receive-pack), the hub
 * NOTIFIES the surface module over HTTP so it can pull + build + serve the new
 * source. This is the settled "service-to-service via HTTP, not shell-out"
 * seam: the `post-receive` hook does NOT build the pushed tree (that would run
 * attacker-influenceable code as the hub/git user — RCE §7); the exec authority
 * stays inside surface-host's own sandbox. The hub only sends an authenticated
 * signal + a short-lived, narrowly-scoped read credential.
 *
 * Two hub-minted tokens ride this hand-off (both SHORT-LIVED + UNREGISTERED —
 * they expire in minutes and are consumed inline, mirroring the H4
 * credential-delivery provisioning-token pattern in admin-connections.ts):
 *
 *   1. notify-auth — a `surface:admin` bearer (aud `surface`) that
 *      authenticates the hub→surface-host POST. surface-host validates it with
 *      the SAME `enforceScope(surface:admin)` it uses for the hub's credential
 *      deliveries, so a random on-box process can't forge a push-notify.
 *   2. pull-token — a `surface:<name>:read` bearer (aud `surface`) that
 *      surface-host presents back to THIS hub's `/git/<name>` endpoint to
 *      `git clone` the freshly-pushed source. Least-privilege: read on exactly
 *      the one surface, valid only long enough to clone.
 *
 * Modular by design (§1): surface-host pulls over the network (not a shared
 * disk), so the seam already works when hub + surface-host are separate
 * containers. `clone_url` is the hub's own loopback origin today; a cloud
 * deploy supplies the internal hub URL instead. The token's `iss` is the hub
 * issuer, which is a member of the hub's own bound-origin set, so the clone
 * validates when it comes back in over loopback.
 */
import type { Database } from "bun:sqlite";
import { REGISTERED_MINT_TTL_THRESHOLD_SECONDS } from "./admin-connections.ts";
import { signAccessToken } from "./jwt-sign.ts";

/** Provenance identity stamped on the hub-internal notify + pull tokens. */
const NOTIFY_SUBJECT = "surface-git-transport";
const NOTIFY_CLIENT_ID = "surface-git-transport";

/** aud of both minted tokens — surface-host declares `aud: "surface"`. */
const SURFACE_AUDIENCE = "surface";

/**
 * notify-auth TTL. The POST is fired immediately; a small window covers a
 * momentarily-busy loopback without leaving a usable credential lying around.
 *
 * Exported for the TTL-policy guard test only.
 */
export const NOTIFY_TTL_SECONDS = 120;

/**
 * pull-token TTL. Long enough for surface-host to `git clone --depth 1` a
 * source surface right after the notify lands, short enough that a leaked
 * token is near-useless. Both TTLs here MUST stay well under the hub's
 * registered-mint threshold (`REGISTERED_MINT_TTL_THRESHOLD_SECONDS`, 600s —
 * imported from admin-connections.ts, where the policy lives) so these
 * fire-and-forget tokens remain unregistered-by-policy — bumping either past
 * it without registering them would leak unrevocable tokens. Enforced by
 * {@link assertUnregisteredMintTtl} at module load, not just this comment.
 *
 * Exported for the TTL-policy guard test only.
 */
export const PULL_TTL_SECONDS = 300;

/**
 * Registered-mint policy guard (hub-module-boundary charter): a TTL minted
 * WITHOUT a tokens-table registration must stay strictly under the
 * registered-mint threshold. Throws at module load when a future edit bumps
 * one of this file's fire-and-forget TTLs to/past the line — turning a silent
 * "unrevocable token" policy leak into an immediate boot failure.
 *
 * Exported for tests; not for reuse as a general validator (registered mint
 * sites legitimately exceed the threshold — they register the jti instead).
 */
export function assertUnregisteredMintTtl(name: string, ttlSeconds: number): void {
  if (ttlSeconds >= REGISTERED_MINT_TTL_THRESHOLD_SECONDS) {
    throw new Error(
      `git-notify: ${name} (${ttlSeconds}s) must stay under the registered-mint threshold (${REGISTERED_MINT_TTL_THRESHOLD_SECONDS}s). Tokens minted here are fire-and-forget and never registered in the tokens table — at/above the threshold they'd be long-lived AND unrevocable. Either shorten the TTL or register the mint (see admin-connections.ts registered-mint rule).`,
    );
  }
}

// Module-load enforcement of the policy the comments above describe.
assertUnregisteredMintTtl("NOTIFY_TTL_SECONDS", NOTIFY_TTL_SECONDS);
assertUnregisteredMintTtl("PULL_TTL_SECONDS", PULL_TTL_SECONDS);

/** Bound the notify HTTP call so a wedged surface-host can't hang the caller. */
const NOTIFY_FETCH_TIMEOUT_MS = 10_000;

export interface GitNotifyLog {
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

export interface NotifySurfacePushedDeps {
  /** Hub DB — for `signAccessToken`'s active-signing-key lookup. */
  db: Database;
  /**
   * Hub issuer (the `iss` claim), resolved per-request via `resolveIssuer`
   * (`oauthDeps(req).issuer`). Both minted tokens carry it; the pull token
   * validates against the hub's own bound-origin set on the clone-back.
   */
  issuer: string;
  /**
   * Resolve a module's loopback origin by short name (`makeResolveModuleOrigin`
   * over services.json). Returns null when the surface module isn't installed —
   * in which case there's nothing to notify and we no-op.
   */
  resolveModuleOrigin: (short: string) => string | null;
  /**
   * Origin surface-host should `git clone` from — the hub's own loopback origin
   * today (`http://127.0.0.1:<port>`). The `/git/<name>` suffix is appended
   * here so the module gets a ready-to-use URL.
   */
  cloneBaseOrigin: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: GitNotifyLog;
  /** Test seam — defaults to the real `signAccessToken`. */
  signToken?: typeof signAccessToken;
}

/**
 * Notify surface-host that surface `<name>` was pushed. Best-effort +
 * fire-and-forget from the caller's perspective: this never throws (the git
 * transport handler already returned the push response to the client); every
 * failure path logs and returns.
 *
 * Returns a small outcome for tests/log assertions; production ignores it.
 */
export async function notifySurfacePushed(
  name: string,
  deps: NotifySurfacePushedDeps,
): Promise<{ notified: boolean; reason?: string }> {
  const log = deps.log ?? console;
  const sign = deps.signToken ?? signAccessToken;

  const moduleOrigin = deps.resolveModuleOrigin("surface");
  if (!moduleOrigin) {
    // No surface module installed on this hub — nothing to serve the push.
    log.info(`[git-notify] surface module not installed; skipping notify for "${name}"`);
    return { notified: false, reason: "surface-module-not-installed" };
  }

  let notifyAuth: string;
  let pullToken: string;
  try {
    const now = deps.now;
    const common = {
      sub: NOTIFY_SUBJECT,
      clientId: NOTIFY_CLIENT_ID,
      issuer: deps.issuer,
      audience: SURFACE_AUDIENCE,
      ...(now !== undefined ? { now } : {}),
    };
    notifyAuth = (
      await sign(deps.db, { ...common, scopes: ["surface:admin"], ttlSeconds: NOTIFY_TTL_SECONDS })
    ).token;
    pullToken = (
      await sign(deps.db, {
        ...common,
        scopes: [`surface:${name}:read`],
        ttlSeconds: PULL_TTL_SECONDS,
      })
    ).token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[git-notify] failed to mint notify tokens for "${name}": ${msg}`);
    return { notified: false, reason: "mint-failed" };
  }

  const cloneUrl = `${deps.cloneBaseOrigin.replace(/\/+$/, "")}/git/${name}`;
  const endpoint = `${moduleOrigin.replace(/\/+$/, "")}/surface/api/git-pushed`;
  const fetchImpl = deps.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${notifyAuth}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ surface: name, clone_url: cloneUrl, pull_token: pullToken }),
      signal: AbortSignal.timeout(NOTIFY_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const text = (await res.text()).trim();
        if (text) detail += `: ${text.slice(0, 300)}`;
      } catch {
        // best-effort detail
      }
      log.warn(`[git-notify] surface-host rejected push notify for "${name}" (${detail})`);
      return { notified: false, reason: `notify-rejected:${res.status}` };
    }
    log.info(`[git-notify] notified surface-host of push to "${name}"`);
    return { notified: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[git-notify] push notify to surface-host failed for "${name}": ${msg}`);
    return { notified: false, reason: "notify-error" };
  }
}
