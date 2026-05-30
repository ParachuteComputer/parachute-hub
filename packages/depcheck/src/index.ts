/**
 * @openparachute/depcheck
 *
 * Canonical missing-dependency UX for Parachute modules. Three layers:
 *
 *   - REGISTRY (`registry.ts`)  — `DEPENDENCY_REGISTRY` / `lookupDep`: what
 *     each external binary is for + how to install it, in one place.
 *   - FORMATTER (`format.ts`)   — `formatMissingDependency` /
 *     `resolveInstallCommands` / `toMissingDependencyWire`: turn a spec into
 *     the operator-facing block or the structured wire shape.
 *   - HELPERS (`error.ts`)      — `MissingDependencyError`, `ensureExecutable`,
 *     `isBinaryNotFoundError`, `rethrowIfMissing`: pre-flight a spawn site or
 *     classify a spawn failure into the typed error.
 *
 * Per-repo code calls these at spawn sites so the install strings + the
 * ENOENT matcher stop drifting (vault's `git-preflight.ts` + hub's
 * `cloudflare/detect.ts` were already divergent copies).
 *
 * Note: relative imports MUST carry `.js` extensions even though the source
 * files are `.ts`. tsc emits the extension verbatim into dist, and NodeNext-
 * strict consumers require it to resolve compiled JS. Bun + bundler-resolution
 * consumers (hub workspace, vault, scribe) resolve `.js` back to `.ts`
 * transparently. Mirrors scope-guard's convention (see its index.ts).
 */

export {
  type DepSpec,
  type LinuxBinaryUrl,
  DEPENDENCY_REGISTRY,
  lookupDep,
} from "./registry.js";
export {
  type FormatOpts,
  type MissingDependencyWire,
  formatMissingDependency,
  resolveInstallCommands,
  toMissingDependencyWire,
} from "./format.js";
export {
  MissingDependencyError,
  ensureExecutable,
  isBinaryNotFoundError,
  rethrowIfMissing,
} from "./error.js";
