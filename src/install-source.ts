/**
 * Detects where each service is *running from* — bun-linked against a local
 * checkout, or installed from npm — so `parachute status` can surface the
 * provenance alongside version/health.
 *
 * Motivation: hub#243. After a bun-linked rebuild, `services.json`'s cached
 * `version` field can lag the live `package.json` version, and the operator
 * has no way to spot the drift from `status` output alone. Surfacing
 * install-source + a STALE flag turns a three-step diagnosis into one
 * glance.
 *
 * Pure read path: filesystem + (optional) one-shot `git rev-parse` per
 * service. No network. Every external dependency is injectable via the
 * Deps bag so tests don't touch real bun-globals or git.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveBundleDistFrom } from "./bundle-serve.ts";
import { FIRST_PARTY_FALLBACKS, KNOWN_MODULES, shortNameForManifest } from "./service-spec.ts";

export type InstallSourceKind = "bun-linked" | "npm" | "unknown";

export interface InstallSource {
  readonly kind: InstallSourceKind;
  /**
   * Absolute path to the source checkout (bun-linked) or the installed
   * package dir under bun globals (npm). Undefined when `kind === "unknown"`.
   */
  readonly path?: string;
  /** Short git HEAD hash for bun-linked sources where the path is a git repo. */
  readonly gitHead?: string;
  /**
   * Version from the live `package.json` at `path`. For bun-linked sources
   * this can differ from the entry's cached `services.json.version` — that's
   * the drift case we surface.
   */
  readonly livePackageVersion?: string;
}

export interface DetectInstallSourceDeps {
  /**
   * Returns the absolute path the bun-global symlink for `packageName` points
   * at, or null if no symlink/install exists at any known prefix. Mirrors
   * `defaultLinkedPath` in commands/install.ts so the contracts stay aligned.
   */
  readonly resolveBunGlobal?: (packageName: string) => string | null;
  /** Returns the bun-global node_modules prefixes to consider "npm-installed". */
  readonly bunGlobalPrefixes?: () => readonly string[];
  /** Reads + parses a JSON file. Test seam — keeps the module synchronously testable. */
  readonly readJson?: (path: string) => unknown;
  /** Returns the short git HEAD at `path`, or undefined if unavailable. */
  readonly readGitHead?: (path: string) => string | undefined;
}

export function bunGlobalPrefixes(): readonly string[] {
  const prefixes: string[] = [];
  const fromEnv = process.env.BUN_INSTALL;
  if (fromEnv) prefixes.push(join(fromEnv, "install", "global", "node_modules"));
  prefixes.push(join(homedir(), ".bun", "install", "global", "node_modules"));
  return prefixes;
}

export function defaultResolveBunGlobal(packageName: string): string | null {
  for (const prefix of bunGlobalPrefixes()) {
    const pkgJson = join(prefix, ...packageName.split("/"), "package.json");
    try {
      return dirname(realpathSync(pkgJson));
    } catch {
      // Try the next prefix.
    }
  }
  return null;
}

export function defaultReadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function defaultReadGitHead(path: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", path, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const head = out.trim();
    return head.length > 0 ? head : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when `candidate` is under one of the bun-global prefixes. Both sides
 * are realpath'd so symlinks in `candidate` (or in a parent of the prefix)
 * don't make us miss the match. Used to classify "is this installed in bun
 * globals" vs "is this a separate checkout that bun-link points at."
 */
function isUnderBunGlobals(candidate: string, prefixes: readonly string[]): boolean {
  let cand: string;
  try {
    cand = realpathSync(candidate);
  } catch {
    cand = resolve(candidate);
  }
  for (const prefix of prefixes) {
    let pre: string;
    try {
      pre = realpathSync(prefix);
    } catch {
      pre = resolve(prefix);
    }
    if (cand === pre) return true;
    const withSep = pre.endsWith("/") ? pre : `${pre}/`;
    if (cand.startsWith(withSep)) return true;
  }
  return false;
}

function packageNameFor(entryName: string): string | undefined {
  const short = shortNameForManifest(entryName);
  if (short === undefined) return undefined;
  const fb = FIRST_PARTY_FALLBACKS[short];
  if (fb) return fb.package;
  // KNOWN_MODULES (vault / scribe / agent / surface — post hub#310 FALLBACK
  // retirement) carries the package name without an embedded manifest.
  return KNOWN_MODULES[short]?.package;
}

function readVersion(packageDir: string, readJson: (p: string) => unknown): string | undefined {
  try {
    const parsed = readJson(join(packageDir, "package.json"));
    if (parsed && typeof parsed === "object") {
      const v = (parsed as Record<string, unknown>).version;
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch {
    // package.json missing / malformed — leave undefined so the caller can
    // still report kind without inventing a version.
  }
  return undefined;
}

export interface DetectArgs {
  /** The services.json row name (`parachute-vault`, `agent`, etc.). */
  readonly entryName: string;
  /** Absolute install dir from services.json, when known. */
  readonly installDir?: string;
}

/**
 * Classify a service's install source. Pure: no network, single optional
 * `git rev-parse` shell-out (mock via `readGitHead` in tests).
 *
 * Resolution order:
 *   1. If `installDir` is set: realpath + compare against bun globals. Under
 *      globals → `npm`; anywhere else → `bun-linked`.
 *   2. Else, if we can map the entry to a first-party package name: look up
 *      the bun-global symlink target. Bare `bun add -g <pkg>` lands under
 *      bun globals → `npm`; `bun link` lands somewhere else → `bun-linked`.
 *   3. Else: `unknown` — third-party rows missing `installDir` (legacy
 *      manifest from before installDir stamping) fall here. They should be
 *      rare and the operator's signal is "re-install to refresh."
 */
export function detectInstallSource(
  args: DetectArgs,
  deps: DetectInstallSourceDeps = {},
): InstallSource {
  const resolveBunGlobal = deps.resolveBunGlobal ?? defaultResolveBunGlobal;
  const prefixes = deps.bunGlobalPrefixes ?? bunGlobalPrefixes;
  const readJson = deps.readJson ?? defaultReadJson;
  const readGitHead = deps.readGitHead ?? defaultReadGitHead;

  const candidate =
    args.installDir ??
    (() => {
      const pkg = packageNameFor(args.entryName);
      return pkg ? resolveBunGlobal(pkg) : null;
    })();

  if (!candidate) return { kind: "unknown" };

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(candidate);
  } catch {
    resolvedPath = resolve(candidate);
  }

  const underGlobals = isUnderBunGlobals(resolvedPath, prefixes());
  const livePackageVersion = readVersion(resolvedPath, readJson);

  if (underGlobals) {
    return {
      kind: "npm",
      path: resolvedPath,
      ...(livePackageVersion !== undefined && { livePackageVersion }),
    };
  }

  const gitHead = readGitHead(resolvedPath);
  return {
    kind: "bun-linked",
    path: resolvedPath,
    ...(livePackageVersion !== undefined && { livePackageVersion }),
    ...(gitHead !== undefined && { gitHead }),
  };
}

/**
 * Detect the hub's own install source from the running process. The hub
 * doesn't have a services.json row of its own, but `parachute status` still
 * surfaces a row for it — so the same SOURCE column has to render. We
 * climb from `import.meta.dir` (the location of the running source files)
 * to the nearest `package.json`, then classify that path the same way we
 * classify a service's `installDir`.
 *
 * `srcDir` is injectable so tests can drive the function without depending
 * on `import.meta.dir` (which points at the test file, not at hub source).
 */
export function detectHubInstallSource(
  srcDir: string,
  deps: DetectInstallSourceDeps = {},
): InstallSource {
  // `import.meta.dir` is `<pkgDir>/src` in normal layouts.
  const pkgDir = findNearestPackageDir(srcDir, deps.readJson ?? defaultReadJson);
  if (!pkgDir) return { kind: "unknown" };
  return detectInstallSource({ entryName: "parachute-hub", installDir: pkgDir }, deps);
}

function findNearestPackageDir(
  start: string,
  readJson: (p: string) => unknown,
): string | undefined {
  let current = resolve(start);
  for (let i = 0; i < 16; i++) {
    try {
      readJson(join(current, "package.json"));
      return current;
    } catch {
      // No package.json here — climb.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/**
 * True when an entry's cached `services.json` version differs from the live
 * `package.json` version at its bun-linked path. The single drift case the
 * operator can act on — `parachute upgrade <svc>` for the bun-linked path
 * doesn't refresh `services.json` on rebuild, so a freshly-built source can
 * still report the pre-rebuild version through status.
 *
 * Only meaningful for `kind === "bun-linked"`. NPM-installed services
 * don't have a "live" source separate from the cached version.
 */
export function isStale(entryVersion: string, source: InstallSource): boolean {
  if (source.kind !== "bun-linked") return false;
  if (!source.livePackageVersion) return false;
  return source.livePackageVersion !== entryVersion;
}

/**
 * Compact `SOURCE` cell label for the status table. Verbose-friendly, never
 * wider than ~50 chars on typical inputs.
 *
 *   bun-linked: `bun-linked → <basename> @ <head>`     (head is the git short SHA)
 *   npm:        `npm (0.3.15-rc.1)` / `npm`            (version when known)
 *   unknown:    `unknown`
 *
 * The continuation `STALE` indicator is a separate line in the status
 * renderer — keeps the column narrow.
 */
export function formatInstallSourceLabel(source: InstallSource): string {
  if (source.kind === "bun-linked") {
    const basename = source.path
      ? (source.path.split("/").filter(Boolean).pop() ?? source.path)
      : undefined;
    if (basename && source.gitHead) return `bun-linked → ${basename} @ ${source.gitHead}`;
    if (basename) return `bun-linked → ${basename}`;
    return "bun-linked";
  }
  if (source.kind === "npm") {
    if (source.livePackageVersion) return `npm (${source.livePackageVersion})`;
    return "npm";
  }
  return "unknown";
}

// ---------------------------------------------------------------------------
// Served-bundle resolution guardrail (hub#780).
//
// The install-source detection above answers "where does the operator's bun
// link / installDir point?" — the SOURCE column. It does NOT answer "where does
// the bundle-serve shim actually resolve the bundle from at serve time?" On
// Aaron's box those two diverged silently: SOURCE read `bun-linked → app @ sha`
// (true of the link) while the shim, launched with cwd `/`, resolved the bundle
// from bun's install *cache* and served a months-old `@openparachute/app@0.22.5`
// for nine hours. Part 1 (dropping `/` as a resolution candidate) fixes the
// known cause; this makes any residual/future divergence self-evident in
// `status` at a glance instead of a multi-hour asset-hash trace.
// ---------------------------------------------------------------------------

/**
 * The cwd the supervisor launches shim-served (notes/app) processes with.
 * launchd/systemd hand a supervised child `/` when no per-module cwd is set —
 * exactly the bundle-serve case (hub#780). Served resolution is computed from
 * here so `status` mirrors the running shim rather than the CLI's own cwd.
 */
export const SUPERVISOR_CWD = "/";

export interface ServedResolution {
  /**
   * Absolute package root the bundle-serve shim actually resolves + serves from,
   * computed via the SAME candidate walk the shim uses. Undefined when the
   * package can't be resolved from the supervisor cwd (not installed).
   */
  readonly servedPath?: string;
  /** Version read from the served package's `package.json` — the version really served. */
  readonly servedVersion?: string;
  /** Where the bun-global link/install for the package points, if any. */
  readonly linkedPath?: string;
  /**
   * True when a global link exists for the package but shim resolution landed
   * somewhere else — the hub#780 divergence the operator can act on.
   */
  readonly divergent: boolean;
}

export interface DetectServedResolutionDeps {
  /** Home dir the resolution candidates are anchored on. Defaults to `homedir()`. */
  readonly home?: string;
  /** Supervisor launch cwd. Defaults to {@link SUPERVISOR_CWD} (`/`). */
  readonly cwd?: string;
  /** Override `Bun.resolveSync` for tests (passed straight to the shim resolver). */
  readonly resolveSync?: (specifier: string, base: string) => string;
  /** Override `existsSync` for tests (passed straight to the shim resolver). */
  readonly existsSync?: (path: string) => boolean;
  /** Reads + parses a JSON file. Shared shape with {@link DetectInstallSourceDeps}. */
  readonly readJson?: (path: string) => unknown;
  /** Returns the bun-global link target for a package, or null. Shared shape with detect. */
  readonly resolveBunGlobal?: (packageName: string) => string | null;
}

/**
 * Resolve a shim-served package the way `bundle-serve.ts` does at serve time and
 * compare against its bun-global link. Pure + total: never throws (status is a
 * diagnostic), degrading to `{ divergent: false }` when nothing resolves.
 *
 * `resolveBundleDistFrom` returns `<root>/dist`; the package root (where
 * `package.json` lives) is its parent. Post-fix, resolving from cwd `/` lands on
 * the global link, so `servedPath === linkedPath` and `divergent` is false — no
 * false positive. It fires only when resolution genuinely lands off the link.
 */
export function detectServedResolution(
  pkg: string,
  deps: DetectServedResolutionDeps = {},
): ServedResolution {
  const readJson = deps.readJson ?? defaultReadJson;
  const resolveBunGlobal = deps.resolveBunGlobal ?? defaultResolveBunGlobal;
  const cwd = deps.cwd ?? SUPERVISOR_CWD;

  let servedPath: string | undefined;
  try {
    const dist = resolveBundleDistFrom({
      pkg,
      cwd,
      ...(deps.home !== undefined && { home: deps.home }),
      ...(deps.resolveSync !== undefined && { resolveSync: deps.resolveSync }),
      ...(deps.existsSync !== undefined && { existsSync: deps.existsSync }),
    });
    servedPath = dirname(dist);
  } catch {
    // Not resolvable from the supervisor cwd (package not installed, or no
    // dist/). status still renders the row; nothing to compare against here.
    servedPath = undefined;
  }

  const servedVersion = servedPath ? readVersion(servedPath, readJson) : undefined;
  const linkedPath = resolveBunGlobal(pkg) ?? undefined;

  const divergent =
    linkedPath !== undefined &&
    servedPath !== undefined &&
    realpathOrResolve(servedPath) !== realpathOrResolve(linkedPath);

  return {
    ...(servedPath !== undefined && { servedPath }),
    ...(servedVersion !== undefined && { servedVersion }),
    ...(linkedPath !== undefined && { linkedPath }),
    divergent,
  };
}

/** realpath a path, falling back to a plain resolve so a missing target still compares. */
function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Continuation-line warning for `status` when a shim-served package resolves
 * somewhere other than its bun-global link (hub#780). Mirrors the `STALE:` note
 * shape for consistency. Returns undefined when resolution is consistent.
 */
export function servedDivergenceNote(pkg: string, served: ServedResolution): string | undefined {
  if (!served.divergent) return undefined;
  const version = served.servedVersion ?? "unknown";
  return `SERVED-DRIFT: serving ${pkg}@${version} from ${served.servedPath}, not the global link at ${served.linkedPath} — clear the stale \`~/.bun/install/cache\` entry and \`bun link\` the checkout, then restart`;
}
