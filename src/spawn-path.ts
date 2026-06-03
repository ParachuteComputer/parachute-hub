/**
 * PATH enrichment for spawned modules + the hub's own boot env.
 *
 * The hub-as-supervisor unit bakes a hardcoded base PATH (see
 * `enrichedUnitPath` below), and `Bun.spawn` defaults to an empty env, so
 * supervised children only ever see the PATH the unit handed the hub. On a
 * launchd-managed Mac that PATH omits the two dirs operator tools actually live
 * in — `$HOME/.local/bin` (scribe's `parakeet-mlx`) and the Homebrew bin
 * (`ffmpeg`, `/opt/homebrew/bin` on Apple Silicon). The result: scribe's
 * `Bun.which("ffmpeg")` / `Bun.which("parakeet-mlx")` probes come up empty and
 * transcription is dead on canonical installs.
 *
 * `enrichedPath` is the shared fix. It takes a base env (defaults to
 * `process.env`), keeps whatever PATH was inherited, and APPENDS the operator-
 * tool dirs that exist on disk and aren't already present. Inherited PATH wins
 * (append, not prepend) so an operator's explicit PATH ordering is never
 * reordered out from under them. `PARACHUTE_EXTRA_PATH` (colon-joined) is
 * PREPENDED so an operator can intentionally shadow a system binary.
 *
 * Two consumers:
 *   1. The spawn side (`buildModuleSpawnRequest` in `commands/serve-boot.ts` +
 *      `spawnSupervised` in `api-modules-ops.ts`) injects `enrichedPath()` into
 *      every supervised child's env. This is the PRIMARY fix — it self-heals
 *      every existing install at the next hub restart, no re-init needed.
 *   2. The hub's own `serve` startup enriches `process.env.PATH` so the hub's
 *      own `Bun.which` probes (cloudflared / tailscale detection, etc.) also
 *      see brew + `.local`.
 *
 * The unit generator (`enrichedUnitPath`, used by `hub-unit.ts` +
 * `commands/migrate-cutover.ts`) bakes the same dirs into the launchd/systemd
 * unit PATH as belt-and-suspenders for fresh installs.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** Injectable seams so tests don't touch the real fs / os / platform. */
export interface EnrichedPathDeps {
  /** Operator home dir. */
  homeDir: () => string;
  /** True when `path` exists on disk. */
  exists: (path: string) => boolean;
  /** `process.platform` value (e.g. "darwin", "linux"). */
  platform: NodeJS.Platform;
  /** `process.arch` value (e.g. "arm64", "x64"). */
  arch: string;
}

export const defaultEnrichedPathDeps: EnrichedPathDeps = {
  homeDir: () => homedir(),
  exists: (path) => existsSync(path),
  platform: process.platform,
  arch: process.arch,
};

/**
 * The Homebrew bin dir for the current platform/arch, or null when there
 * isn't a canonical one (non-darwin — Linux brew is opt-in + non-canonical, so
 * we only contribute `$HOME/.local/bin` there).
 *
 * Apple Silicon brew installs under `/opt/homebrew`; Intel macOS brew under
 * `/usr/local`.
 */
function brewBinDir(platform: NodeJS.Platform, arch: string): string | null {
  if (platform !== "darwin") return null;
  return arch === "arm64" ? "/opt/homebrew/bin" : "/usr/local/bin";
}

/**
 * Operator-tool dirs to APPEND (in this order): `$HOME/.local/bin` (pipx /
 * `pip install --user` — scribe's `parakeet-mlx`), the platform brew bin
 * (`ffmpeg`), and `$HOME/.bun/bin` (bun-linked binaries on a cold boot). Order
 * is deterministic and stable. Pure of fs — the runtime enrichment filters by
 * existence, the unit generator includes them unconditionally.
 */
export function operatorToolDirs(home: string, platform: NodeJS.Platform, arch: string): string[] {
  const dirs = [`${home}/.local/bin`];
  const brew = brewBinDir(platform, arch);
  if (brew) dirs.push(brew);
  dirs.push(`${home}/.bun/bin`);
  return dirs;
}

function candidateDirs(deps: EnrichedPathDeps): string[] {
  return operatorToolDirs(deps.homeDir(), deps.platform, deps.arch);
}

function dedupe(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * The PATH baked into the launchd/systemd hub unit at generation time.
 *
 * `${bunInstall}/bin` first (so supervised children resolve a bun-linked binary
 * on cold boot, R20), then the usual system dirs, then the operator-tool dirs
 * (`$HOME/.local/bin`, the platform brew bin) so a managed hub — and the modules
 * it spawns — can find scribe's `parakeet-mlx` + `ffmpeg`. `PARACHUTE_EXTRA_PATH`
 * (if set at generation time) is PREPENDED for intentional operator shadowing.
 * Deduped end-to-end.
 *
 * Unlike `enrichedPath`, the unit-side dirs are included UNCONDITIONALLY (no
 * existence check): the unit is generated once at install/migrate time but
 * brew/tools may be installed afterward, and a non-existent PATH entry is simply
 * skipped by the OS — so baking them in is the robust choice for fresh installs.
 *
 * Shared by `hub-unit.ts` (init bringup) + `commands/migrate-cutover.ts`
 * (`--to-supervised` cutover) so the two unit-generation paths can't drift.
 */
export function enrichedUnitPath(
  bunInstall: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  extraPath: string | undefined = process.env.PARACHUTE_EXTRA_PATH,
): string {
  const extra = (extraPath ?? "").split(":").filter((e) => e.length > 0);
  const base = [`${bunInstall}/bin`, "/usr/local/bin", "/usr/bin", "/bin"];
  return dedupe([...extra, ...base, ...operatorToolDirs(home, platform, arch)]).join(":");
}

/**
 * Build a PATH that enriches `env.PATH` with operator-tool dirs.
 *
 * Ordering: `PARACHUTE_EXTRA_PATH` (prepended) : inherited PATH : appended
 * operator-tool dirs that exist and aren't already present. Deduped end-to-end
 * (first occurrence wins, so an inherited entry is never reordered).
 */
export function enrichedPath(
  env: NodeJS.ProcessEnv = process.env,
  deps: EnrichedPathDeps = defaultEnrichedPathDeps,
): string {
  const inherited = (env.PATH ?? "").split(":").filter((e) => e.length > 0);
  const extra = (env.PARACHUTE_EXTRA_PATH ?? "").split(":").filter((e) => e.length > 0);
  const appended = candidateDirs(deps).filter((d) => deps.exists(d));

  // PARACHUTE_EXTRA_PATH first (intentional operator shadow), then the
  // inherited PATH (inherited wins over our appended defaults), then our
  // appended operator-tool dirs.
  return dedupe([...extra, ...inherited, ...appended]).join(":");
}
