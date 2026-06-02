/**
 * In-place-vs-redeploy detection for `POST /api/hub/upgrade` (design
 * 2026-06-01 §5.3 — the OPEN implementation detail flagged for D4).
 *
 * The hub-upgrade endpoint must decide, BEFORE it spawns the detached helper,
 * whether an on-disk binary rewrite (`bun add -g @openparachute/hub@<channel>`
 * / a linked git-pull) will actually PERSIST across the next restart:
 *
 *   - **in-place** — the hub binary lives on a writable, persistent location
 *     (a bun-linked checkout, or a `bun add -g` install under a $BUN_INSTALL
 *     that survives restart). A rewrite + restart genuinely upgrades the hub.
 *
 *   - **redeploy-required** — the hub binary is baked into a container image
 *     (Render/Fly image-pinned). `bun add -g` would write to the image's
 *     ephemeral layer and be LOST on the next container restart, so the rewrite
 *     is a misleading no-op. The honest path is a platform redeploy from the
 *     operator's dashboard, NOT a false "upgraded."
 *
 * ── THE HEURISTIC (conservative; flagged for review) ───────────────────────
 *
 * Signals, in priority order:
 *
 *   1. **bun-linked** (`detectHubInstallSource` → `bun-linked`): the hub runs
 *      from a git checkout on disk. A `git pull` in that checkout is always
 *      persistent (the checkout is the operator's own filesystem, not an image
 *      layer). → **in-place**. This is Aaron's dev box + every VM/Mac that
 *      bun-linked the hub.
 *
 *   2. **container, BUN_INSTALL on the persistent disk**: a container (the
 *      Render Blueprint pins `PARACHUTE_HOME=/parachute`) whose `$BUN_INSTALL`
 *      points INSIDE the persistent mount (`/parachute/...` — the same place
 *      runtime module installs land via `/api/modules/:short/install`). A
 *      `bun add -g` there writes to the mounted volume, which survives a
 *      container restart. → **in-place**. This is the "hub installed to the
 *      persistent disk" arm §5.3 calls out.
 *
 *   3. **container, BUN_INSTALL NOT on the persistent disk** (or unset): the
 *      hub is image-pinned — `bun add -g` writes to the ephemeral image layer
 *      and is lost on restart. → **redeploy-required**. This is the default
 *      Render/Fly image shape today (the Dockerfile `bun add`s the hub into the
 *      image; $BUN_INSTALL defaults to `/root/.bun`, not the mount).
 *
 *   4. **npm, non-container**: a `bun add -g` install on a VM/Mac (not a
 *      container). The global bun prefix is on the operator's own writable
 *      filesystem → persistent. → **in-place**.
 *
 *   5. **unknown / anything else**: we couldn't classify the install source.
 *      → **redeploy-required** (the honest fallback — §5.3: "When uncertain,
 *      prefer redeploy-required over a silent no-op"). The SPA then tells the
 *      operator to redeploy rather than promising an upgrade that may evaporate.
 *
 * ── FALSE-POSITIVE / FALSE-NEGATIVE RISK (for the reviewer) ─────────────────
 *
 *   - **False "in-place" (the dangerous direction)** would tell the operator
 *     "upgraded" while the rewrite silently evaporates on the next restart.
 *     The only path that risks this is signal #2: a container whose
 *     `$BUN_INSTALL` is under the persistent mount but where the operator
 *     mounted the disk read-only, or where the bun cache (not the install) is
 *     what's on the mount. We mitigate by requiring `$BUN_INSTALL` to be a
 *     descendant of the persistent-home prefix — the strictest signal available
 *     without probing writability (which we can't do reliably from the request
 *     handler before spawning the helper). A residual risk remains; see the
 *     note in `detectHubUpgradeMode` on tightening this with a write-probe in
 *     the helper if it proves wrong in the field.
 *
 *   - **False "redeploy-required" (the safe direction)** merely tells the
 *     operator to redeploy when an in-place upgrade would have worked — annoying
 *     but never destructive. Signals #3/#5 deliberately err here.
 *
 * Pure + injectable: no I/O beyond the (already-injectable) install-source
 * detection. The env + srcDir are passed in so tests drive every branch.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTAINER_HOME } from "./hub-control.ts";
import {
  type DetectInstallSourceDeps,
  type InstallSource,
  detectHubInstallSource,
} from "./install-source.ts";

/** The two upgrade modes the SPA branches on. */
export type HubUpgradeMode = "in-place" | "redeploy-required";

export interface DetectHubUpgradeModeArgs {
  /** Override `process.env` lookups (test seam). */
  env?: Record<string, string | undefined>;
  /**
   * Directory used to locate the hub's package.json + classify install source.
   * Defaults to the running source dir. Test seam.
   */
  hubSrcDir?: string;
  /** Pass-through deps for `detectHubInstallSource` (test seam). */
  installSourceDeps?: DetectInstallSourceDeps;
  /**
   * Pre-classified install source — lets a caller that already ran
   * `detectHubInstallSource` (e.g. the `/api/hub` handler) avoid a second
   * filesystem walk. When set, `hubSrcDir`/`installSourceDeps` are ignored.
   */
  source?: InstallSource;
}

export interface HubUpgradeModeResult {
  mode: HubUpgradeMode;
  /** The classified install source (surfaced for diagnostics + the SPA copy). */
  source: InstallSource["kind"] | "container";
  /** Short human-readable reason — surfaced in the 202 body + SPA + tests. */
  reason: string;
}

/**
 * The Render Blueprint pins `PARACHUTE_HOME=/parachute` — the single most
 * reliable container-mode signal the hub has (mirrors `api-hub.ts`'s
 * container override; both use the shared `CONTAINER_HOME` constant). Fly uses
 * the same pin via the shared image.
 */
function isContainer(env: Record<string, string | undefined>): boolean {
  return env.PARACHUTE_HOME === CONTAINER_HOME;
}

/**
 * True when `$BUN_INSTALL` is a descendant of the persistent-home prefix —
 * i.e. `bun add -g` writes land on the mounted volume that survives a
 * container restart. The persistent home on the Render Blueprint is
 * `/parachute`; we treat any `$BUN_INSTALL` under it as persistent.
 *
 * Strict (descendant-of), not a substring match, so a stray `/parachute` in
 * an unrelated path component can't false-positive.
 */
function bunInstallOnPersistentDisk(env: Record<string, string | undefined>): boolean {
  const bunInstall = env.BUN_INSTALL;
  const home = env.PARACHUTE_HOME;
  if (!bunInstall || !home) return false;
  if (bunInstall === home) return true;
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return bunInstall.startsWith(prefix);
}

/**
 * Decide whether the hub is in-place-upgradable (rewrite + restart works) or
 * image-pinned (redeploy-only). See the module docstring for the full
 * heuristic + risk analysis.
 */
export function detectHubUpgradeMode(args: DetectHubUpgradeModeArgs = {}): HubUpgradeModeResult {
  const env = args.env ?? process.env;
  const hubSrcDir = args.hubSrcDir ?? dirname(fileURLToPath(import.meta.url));
  const source = args.source ?? detectHubInstallSource(hubSrcDir, args.installSourceDeps);

  const container = isContainer(env);

  // Signal 1: bun-linked checkout. A `git pull` in the operator's own checkout
  // is always persistent — even inside a container the checkout dir is on the
  // operator's filesystem, not the ephemeral image layer. (In practice a
  // container runs from /app/src image-pinned, not a checkout — but if it IS a
  // checkout, in-place is correct.)
  if (source.kind === "bun-linked") {
    return {
      mode: "in-place",
      source: container ? "container" : "bun-linked",
      reason: "bun-linked checkout — git pull + restart persists on disk",
    };
  }

  if (container) {
    // Signal 2: container with $BUN_INSTALL on the persistent mount → the
    // `bun add -g` write survives a container restart.
    if (bunInstallOnPersistentDisk(env)) {
      return {
        mode: "in-place",
        source: "container",
        reason:
          "container with $BUN_INSTALL on the persistent disk — bun add -g persists across restart",
      };
    }
    // Signal 3: container, image-pinned. `bun add -g` writes to the ephemeral
    // image layer → lost on restart. The honest path is a platform redeploy.
    //
    // NOTE (reviewer): we could tighten signal-2 confidence by having the
    // helper write-probe `$BUN_INSTALL` before committing to the rewrite. We
    // deliberately do the cheaper env-based classification here and accept
    // erring toward redeploy-required (the safe direction) when uncertain.
    return {
      mode: "redeploy-required",
      source: "container",
      reason:
        "container image-pinned ($BUN_INSTALL not on the persistent disk) — bun add -g would be lost on the next container restart; redeploy from your platform dashboard instead",
    };
  }

  // Signal 4: npm install on a VM/Mac (non-container). The global bun prefix is
  // on the operator's own writable filesystem → persistent.
  if (source.kind === "npm") {
    return {
      mode: "in-place",
      source: "npm",
      reason: "npm-installed on a persistent filesystem — bun add -g persists",
    };
  }

  // Signal 5: unknown. Honest fallback — prefer redeploy-required over a silent
  // no-op (§5.3).
  return {
    mode: "redeploy-required",
    source: "unknown",
    reason:
      "could not classify the hub install source — redeploy from your platform dashboard to be safe",
  };
}
