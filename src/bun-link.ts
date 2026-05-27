/**
 * bun-link detection — shared helper used by both the CLI install path
 * (`commands/install.ts`) and the API/wizard install path (`api-modules-ops.ts`).
 *
 * "Linked" means a global symlink shape under `~/.bun/install/global/node_modules/<pkg>`
 * created by `bun link` (from a local checkout). When the package is already linked,
 * `bun add -g <pkg>` is at best a wasted npm round-trip (~3s) and at worst a hard
 * failure when the global bun.lock has unrelated noise — neither outcome is desirable
 * given the linked checkout already provides the binary on PATH.
 *
 * Both install paths gate the `bun add -g` call on `isLinked(pkg) === false`.
 * Centralizing the detection here keeps the CLI and wizard in lockstep — diverging
 * (as the wizard did pre-hub#433) is the bug class this module exists to prevent.
 */

import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The set of bun global-prefix locations to probe for a `<pkg>` symlink.
 * Honors `BUN_INSTALL` (the canonical override) before falling back to the
 * default `~/.bun` layout. Order matters — env-set prefix wins on a custom
 * bun layout (containers, CI).
 */
export function bunGlobalPrefixes(): string[] {
  const prefixes: string[] = [];
  const fromEnv = process.env.BUN_INSTALL;
  if (fromEnv) prefixes.push(join(fromEnv, "install", "global", "node_modules"));
  prefixes.push(join(homedir(), ".bun", "install", "global", "node_modules"));
  return prefixes;
}

/**
 * True iff `<pkg>` resolves to a symlink under any bun global prefix —
 * i.e. the package was installed via `bun link` from a local checkout
 * rather than `bun add -g` from npm. Used to short-circuit `bun add -g`
 * in both the CLI and the wizard install paths.
 *
 * Scoped packages (`@openparachute/vault`) are split on `/` so the probe
 * lands at `<prefix>/@openparachute/vault`. Non-symlink resolutions
 * (real dir from `bun add -g`) return false — we only want to skip the
 * `bun add -g` when the symlink-shape is in place.
 */
export function isLinked(pkg: string): boolean {
  for (const prefix of bunGlobalPrefixes()) {
    const path = join(prefix, ...pkg.split("/"));
    try {
      if (lstatSync(path).isSymbolicLink()) return true;
    } catch {
      // Not present at this prefix; try the next.
    }
  }
  return false;
}
