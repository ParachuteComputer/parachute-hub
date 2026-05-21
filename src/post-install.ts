/**
 * Tail-end helpers shared between the CLI install path
 * (`commands/install.ts`) and the API install path
 * (`api-modules-ops.ts`). Both have to (a) stamp `installDir` on the
 * services.json row so downstream resolvers (`uiUrl` / `displayName` /
 * `managementUrl`) can find the module's `.parachute/module.json`, and
 * (b) regenerate the on-disk `/.well-known/parachute.json` so the
 * inspection artifact tracks the new state.
 *
 * Background: hub#292 added both responsibilities inline in the API
 * path after reviewer (#298) caught that the API had diverged from the
 * CLI on the installDir stamp. The duplication is fragile — if either
 * path drifts again, modules silently stop appearing on the discovery
 * page. Co-locating the pairing in one helper makes that drift visible:
 * a new call site that imports `finalizeModuleInstall` gets both
 * responsibilities for free.
 *
 * Two entry points:
 *   - `finalizeModuleInstall` — stamp + regen, for install / upgrade.
 *   - `refreshWellKnown` — regen only, for uninstall (no row to stamp)
 *     and the API-path fallback when `installDir` can't be resolved.
 *
 * Both surface errors via `log` rather than throwing — the on-disk
 * well-known is an inspection / debug artifact, not the live discovery
 * source (hub-server.ts builds per-request), so a regen failure
 * shouldn't mask the op's actual outcome.
 */

import type { ModuleManifest } from "./module-manifest.ts";
import { findService, upsertService } from "./services-manifest.ts";
import { regenerateWellKnown } from "./well-known.ts";

export interface StampInstallDirOnRowOpts {
  /** services.json row key — `manifestName` (e.g. `"parachute-vault"`). */
  manifestName: string;
  /** Absolute path to the installed package directory. */
  installDir: string;
  /** Path to services.json. */
  servicesJsonPath: string;
}

/**
 * Idempotent stamp of `installDir` on the services.json row for
 * `manifestName`. Returns true when a write happened, false when the
 * row was absent or already carried the same `installDir` (no-op).
 *
 * Exported so callers that need only the stamp step (e.g. the CLI's
 * mid-install pre-startService stamp) can reuse the same logic without
 * pulling in the well-known regen.
 */
export function stampInstallDirOnRow(opts: StampInstallDirOnRowOpts): boolean {
  const entry = findService(opts.manifestName, opts.servicesJsonPath);
  if (!entry || entry.installDir === opts.installDir) return false;
  upsertService({ ...entry, installDir: opts.installDir }, opts.servicesJsonPath);
  return true;
}

export interface RefreshWellKnownOpts {
  /** Path to services.json. */
  servicesJsonPath: string;
  /**
   * Origin to embed in the doc's `url` fields. Production passes the
   * configured hub origin / issuer; tests pass a synthetic one.
   */
  canonicalOrigin: string;
  /** Path to write the regenerated `/.well-known/parachute.json`. */
  wellKnownPath: string;
  /**
   * Sink for progress / failure messages. CLI passes a `console.log`
   * style sink; API passes an op-log appender so the operator can see
   * "regenerated <path>" in the operation poll response.
   */
  log: (msg: string) => void;
  /**
   * Override the per-module `.parachute/module.json` reader used by
   * the well-known regen. Production defaults to `readModuleManifest`;
   * tests inject a stub. Mirrors the hub-server.ts seam so the disk
   * regen and the per-request HTTP build stay aligned.
   */
  readModuleManifest?: (installDir: string) => Promise<ModuleManifest | null>;
}

/**
 * Regenerate `/.well-known/parachute.json` on disk with errors logged
 * rather than thrown. Use this directly for uninstall (no row to
 * stamp) and for the API-path fallback when `installDir` can't be
 * resolved post-bun-add. Install + upgrade should call
 * `finalizeModuleInstall` instead, which pairs the regen with the
 * installDir stamp.
 */
export async function refreshWellKnown(opts: RefreshWellKnownOpts): Promise<void> {
  try {
    const regenOpts: Parameters<typeof regenerateWellKnown>[0] = {
      manifestPath: opts.servicesJsonPath,
      canonicalOrigin: opts.canonicalOrigin,
      wellKnownPath: opts.wellKnownPath,
    };
    if (opts.readModuleManifest !== undefined) {
      regenOpts.readModuleManifest = opts.readModuleManifest;
    }
    const { path } = await regenerateWellKnown(regenOpts);
    opts.log(`regenerated ${path}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.log(`well-known regen failed: ${msg}`);
  }
}

export interface FinalizeModuleInstallOpts
  extends StampInstallDirOnRowOpts,
    Omit<RefreshWellKnownOpts, "servicesJsonPath"> {
  // servicesJsonPath comes from StampInstallDirOnRowOpts; Omit on the
  // refresh side prevents the duplicate-key TS error.
}

/**
 * Stamp `installDir` then regenerate the well-known doc. The canonical
 * post-install / post-upgrade call. Single entry point so future call
 * sites (cloud-install, restore-from-backup, …) can't accidentally
 * ship one responsibility without the other.
 *
 * Errors from `refreshWellKnown` are logged, not thrown — see that
 * function's docstring for the rationale. The stamp step is synchronous
 * + cannot fail in any meaningful way (services-manifest writes are
 * atomic via rename); it doesn't need its own error-handling.
 */
export async function finalizeModuleInstall(opts: FinalizeModuleInstallOpts): Promise<void> {
  stampInstallDirOnRow(opts);
  await refreshWellKnown(opts);
}
