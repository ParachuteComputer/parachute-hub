/**
 * `parachute upgrade [<service>]` — pull / re-install / restart in one step.
 *
 * Detects whether the target service is bun-linked from a local checkout (the
 * dev-mode install shape) or npm-installed from a published artifact, then
 * does the right thing for each:
 *
 *   bun-linked:   git -C <checkout> pull --ff-only;
 *                 bun install --frozen-lockfile (if package.json/bun.lock changed);
 *                 bun run build (frontend kind, if `build` script exists);
 *                 parachute restart <svc>.
 *
 *   npm-installed: bun add -g <pkg>@<tag>; parachute restart <svc>.
 *
 * Skip-restart heuristics: bun-linked path skips when HEAD is unchanged after
 * pull; npm path skips when the installed package.json `version` is unchanged
 * after `bun add -g`. Idempotent — re-running the command on an up-to-date
 * install is a fast no-op rather than a needless restart.
 *
 * Refuses to operate on a dirty git working tree. The whole point of the
 * dev-mode flow is to make the operator's checkout a first-class artifact;
 * blowing past their uncommitted changes with `git pull` is exactly what we
 * shouldn't do. They can stash and re-run.
 *
 * Detection of "is this a git checkout?" goes through git itself (`git
 * rev-parse --is-inside-work-tree`). A bare bun-link symlink isn't enough —
 * `bun add -g <abspath>` produces a non-symlinked install dir whose realpath
 * is still the operator's checkout, and we want to treat that the same as a
 * `bun link` install. The git-repo test is the right load-bearing signal.
 *
 * The npm-install branch reads the package.json `version` before and after
 * `bun add -g` to detect "already at latest" (the dist-tag didn't move).
 * Doing this avoids an unnecessary restart on a stable channel — a lot
 * cheaper than re-spawning a daemon that's already running the right code.
 *
 * Channel preservation (hub#332). The npm branch infers which dist-tag to
 * use from the currently-installed version string: a `-rc(\.\d+)?$` suffix
 * means the operator is on the rc chain → upgrade via `@rc`; otherwise
 * `@latest`. This is load-bearing under pre-1.0 RC governance (parachute-
 * patterns/patterns/governance.md rule 2): rc operators must stay on rc
 * unless they explicitly promote. Before #332 the upgrade unconditionally
 * pulled `@latest`, which silently downgraded an rc operator the moment
 * `@latest` pointed at a prior stable. Operators can override the
 * detection with `--channel rc|latest`. We also gate against silent
 * downgrades: if `npm view <pkg>@<channel> version` resolves to something
 * lower than what's installed, we abort with an actionable message
 * (override with `--allow-downgrade`).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { HUB_PACKAGE, HUB_SVC } from "../hub-control.ts";
import { ModuleManifestError } from "../module-manifest.ts";
import {
  type ServiceSpec,
  getSpec,
  getSpecFromInstallDir,
  knownServices,
  shortNameForManifest,
} from "../service-spec.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";
import { type LifecycleOpts, restart as lifecycleRestart } from "./lifecycle.ts";

export interface UpgradeRunner {
  /** Run a command, inheriting stdio. Returns the child's exit code. */
  run(cmd: readonly string[], opts?: { cwd?: string }): Promise<number>;
  /** Run a command, capturing combined stdout+stderr. Used for git rev-parse / status / diff. */
  capture(
    cmd: readonly string[],
    opts?: { cwd?: string },
  ): Promise<{ code: number; stdout: string }>;
}

export const defaultRunner: UpgradeRunner = {
  async run(cmd, opts) {
    const proc = Bun.spawn([...cmd], {
      cwd: opts?.cwd,
      stdio: ["inherit", "inherit", "inherit"],
    });
    return await proc.exited;
  },
  async capture(cmd, opts) {
    const proc = Bun.spawn([...cmd], {
      cwd: opts?.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { code, stdout: stdout + stderr };
  },
};

export interface UpgradeOpts {
  runner?: UpgradeRunner;
  manifestPath?: string;
  configDir?: string;
  log?: (line: string) => void;
  /**
   * Override how we locate a package's bun-globals install. Defaults to
   * scanning bun's standard global node_modules prefixes for
   * `<prefix>/<pkg>/package.json`. Tests inject a deterministic stub that
   * points at a tmp dir.
   */
  findGlobalInstall?: (pkg: string) => string | null;
  /**
   * Override the lifecycle restart call. Production proxies to
   * `lifecycle.restart(svc, opts)`; tests inject `async () => 0` so the
   * upgrade flow can be exercised without spawning real children.
   */
  restartFn?: (svc: string, opts: LifecycleOpts) => Promise<number>;
  /**
   * Explicit npm dist-tag for the npm-installed branch. When set, this
   * overrides channel auto-detection AND the operator's `--channel` flag
   * (it's a programmatic pin used by callers that already know what they
   * want — e.g. tests). Operators don't pass `tag` directly; they pass
   * `--channel rc|latest` which flows into `channel` below.
   *
   * Ignored when bun-linked.
   */
  tag?: string;
  /**
   * Operator-facing channel override (`--channel rc|latest`). Bypasses the
   * auto-detection that infers the channel from the currently-installed
   * version string. When unset, `parachute upgrade` reads the installed
   * package.json `version` and picks `@rc` if it matches `/-rc(\.\d+)?$/`,
   * `@latest` otherwise.
   *
   * Per governance rule 2 (pre-1.0 RC versioning,
   * `parachute-patterns/patterns/governance.md`), operators on the dev
   * chain run `@rc`; `@latest` is the explicit-stable channel. The default
   * `parachute upgrade` (pre hub#332) hard-coded `@latest`, which silently
   * downgraded rc operators when `@latest` pointed at a prior stable.
   */
  channel?: "rc" | "latest";
  /**
   * Bypass the "refuses-to-downgrade" guard. The npm-install branch
   * compares the target version (what `npm view <pkg>@<channel> version`
   * resolves to) against the installed version and aborts if it would go
   * backward. Set true to opt in to a real downgrade.
   */
  allowDowngrade?: boolean;
  /**
   * Test seam for resolving a dist-tag to a concrete version. Defaults to
   * `npm view <pkg>@<channel> version` via the injected runner. Returning
   * null is treated as "unknown — skip the downgrade guard" (network down,
   * registry unreachable, package not yet published on that channel) so a
   * flaky probe never blocks a legitimate upgrade.
   */
  resolveChannelVersion?: (pkg: string, channel: string) => Promise<string | null>;
}

interface ResolvedTarget {
  short: string;
  entry: ServiceEntry;
  spec: ServiceSpec | undefined;
  packageName: string;
}

interface Resolved {
  runner: UpgradeRunner;
  manifestPath: string;
  configDir: string;
  log: (line: string) => void;
  findGlobalInstall: (pkg: string) => string | null;
  restartFn: (svc: string, opts: LifecycleOpts) => Promise<number>;
  /**
   * Explicit pin (programmatic). When set, overrides both auto-detection
   * and `channelOverride`. Undefined in the operator-facing default path.
   */
  tag: string | undefined;
  /** Operator override (`--channel rc|latest`). Undefined → auto-detect. */
  channelOverride: "rc" | "latest" | undefined;
  allowDowngrade: boolean;
  resolveChannelVersion: (pkg: string, channel: string) => Promise<string | null>;
}

function bunGlobalPrefixes(): string[] {
  const prefixes: string[] = [];
  const fromEnv = process.env.BUN_INSTALL;
  if (fromEnv) prefixes.push(join(fromEnv, "install", "global", "node_modules"));
  prefixes.push(join(homedir(), ".bun", "install", "global", "node_modules"));
  return prefixes;
}

function defaultFindGlobalInstall(pkg: string): string | null {
  for (const prefix of bunGlobalPrefixes()) {
    const pkgJsonPath = join(prefix, ...pkg.split("/"), "package.json");
    if (existsSync(pkgJsonPath)) return pkgJsonPath;
  }
  return null;
}

function resolve(opts: UpgradeOpts): Resolved {
  const runner = opts.runner ?? defaultRunner;
  return {
    runner,
    manifestPath: opts.manifestPath ?? SERVICES_MANIFEST_PATH,
    configDir: opts.configDir ?? CONFIG_DIR,
    log: opts.log ?? ((line) => console.log(line)),
    findGlobalInstall: opts.findGlobalInstall ?? defaultFindGlobalInstall,
    restartFn: opts.restartFn ?? ((svc, lifecycleOpts) => lifecycleRestart(svc, lifecycleOpts)),
    tag: opts.tag,
    channelOverride: opts.channel,
    allowDowngrade: opts.allowDowngrade ?? false,
    resolveChannelVersion:
      opts.resolveChannelVersion ?? ((pkg, channel) => npmViewVersion(pkg, channel, runner)),
  };
}

/**
 * Channel detection from a semver-ish version string. Pre-1.0 governance
 * (parachute-patterns/patterns/governance.md rule 2) ships rc chains as
 * `<x>.<y>.<z>-rc.<N>` (or sometimes `-rc` with no N). Anything matching that
 * trailing suffix is the rc channel; everything else is the stable channel.
 */
export function detectChannel(installedVersion: string): "rc" | "latest" {
  return /-rc(\.\d+)?$/.test(installedVersion) ? "rc" : "latest";
}

/**
 * Inline semver-ish comparator. Returns < 0 / 0 / > 0 like `Array.prototype.sort`.
 *
 * Hub doesn't depend on `semver` and adding it for one call is overkill —
 * npm dist-tags resolve to fully-qualified versions like `0.5.13-rc.13` or
 * `0.5.10`, and we only need an ordering predicate ("would this be a
 * downgrade?"). Spec compliance: split into [major, minor, patch] + an
 * optional prerelease tail; numeric-compare the triple, then break ties by
 * "no prerelease > has prerelease" (semver §11.4.3) and lex/numeric compare
 * the prerelease dot-segments (§11.4.1–11.4.2). Returns null on malformed
 * inputs so the caller can fail-open (skip the downgrade guard rather than
 * block on a parser disagreement).
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const av = pa.parts[i] ?? 0;
    const bv = pb.parts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  // Equal triple: pre-release loses to no-pre-release.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  // Both have pre-releases: dot-segment compare.
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const av = pa.pre[i];
    const bv = pb.pre[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = /^\d+$/.test(av) ? Number(av) : null;
    const bn = /^\d+$/.test(bv) ? Number(bv) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an - bn;
      continue;
    }
    if (an !== null) return -1; // numeric < non-numeric
    if (bn !== null) return 1;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function parseSemver(v: string): { parts: number[]; pre: string[] } | null {
  // Tolerate a leading `v` and ignore build metadata after `+`.
  const stripped = v.replace(/^v/, "").split("+")[0];
  if (!stripped) return null;
  const [core, ...preTail] = stripped.split("-");
  if (!core) return null;
  const partStrs = core.split(".");
  if (partStrs.length < 1 || partStrs.length > 3) return null;
  const parts: number[] = [];
  for (const p of partStrs) {
    if (!/^\d+$/.test(p)) return null;
    parts.push(Number(p));
  }
  const pre = preTail.length === 0 ? [] : preTail.join("-").split(".").filter(Boolean);
  return { parts, pre };
}

/**
 * Resolve `<pkg>@<channel>` to a concrete version via `npm view`. Returns
 * null when the probe fails (network down, registry unreachable, package
 * not yet published on that channel) so callers can fail-open on the
 * downgrade guard rather than block on a parser disagreement.
 */
async function npmViewVersion(
  pkg: string,
  channel: string,
  runner: UpgradeRunner,
): Promise<string | null> {
  const { code, stdout } = await runner.capture(["npm", "view", `${pkg}@${channel}`, "version"]);
  if (code !== 0) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // `npm view <pkg>@<tag> version` prints a single line ("0.5.10\n").
  // Tag points to no version → empty stdout → return null above.
  // Belt-and-braces: take the last non-empty line in case npm decided to be
  // chatty.
  const lines = trimmed.split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? null;
}

/**
 * Synthetic services.json row for the hub. The hub isn't in services.json
 * (it's an implementation detail of `parachute expose`, not a user-facing
 * service), so callers passing `hub` as the upgrade target need a fabricated
 * `ResolvedTarget`. Only `installDir` is read downstream — left undefined so
 * `findGlobalInstall("@openparachute/hub")` is the sole locate path, which
 * works the same for npm installs and `bun link` checkouts.
 */
function hubTarget(): ResolvedTarget {
  const entry: ServiceEntry = {
    name: HUB_PACKAGE,
    port: 0,
    paths: [],
    health: "",
    version: "",
  };
  return { short: HUB_SVC, entry, spec: undefined, packageName: HUB_PACKAGE };
}

async function resolveTargets(
  svc: string | undefined,
  manifestPath: string,
): Promise<{ targets: ResolvedTarget[] } | { error: string }> {
  const manifest = readManifest(manifestPath);

  if (svc !== undefined) {
    if (svc === HUB_SVC) return { targets: [hubTarget()] };

    if (manifest.services.length === 0) {
      return { error: "No services installed yet. Try: parachute install <service>" };
    }

    const firstPartySpec = getSpec(svc);
    if (firstPartySpec) {
      const entry = manifest.services.find((s) => s.name === firstPartySpec.manifestName);
      if (!entry) {
        return { error: `${svc} isn't installed. Run \`parachute install ${svc}\` first.` };
      }
      return {
        targets: [{ short: svc, entry, spec: firstPartySpec, packageName: firstPartySpec.package }],
      };
    }
    const entry = manifest.services.find((s) => s.name === svc);
    if (entry?.installDir) {
      try {
        const spec = (await getSpecFromInstallDir(entry.installDir, entry.name)) ?? undefined;
        return {
          targets: [{ short: svc, entry, spec, packageName: spec?.package ?? entry.name }],
        };
      } catch (err) {
        if (err instanceof ModuleManifestError) {
          return { error: `${svc}: invalid module.json — ${err.message}` };
        }
        throw err;
      }
    }
    return {
      error: `unknown service "${svc}". known: ${[HUB_SVC, ...knownServices()].join(", ")}`,
    };
  }

  // Sweep mode: hub first, then everything in services.json. Hub-first means a
  // dispatcher upgrade can't be undermined mid-sweep by a service upgrade that
  // restarts hub for reasons unrelated to its own code change.
  const targets: ResolvedTarget[] = [hubTarget()];
  for (const entry of manifest.services) {
    const short = shortNameForManifest(entry.name);
    if (short) {
      const spec = getSpec(short);
      if (spec) targets.push({ short, entry, spec, packageName: spec.package });
      continue;
    }
    if (entry.installDir) {
      try {
        const spec = (await getSpecFromInstallDir(entry.installDir, entry.name)) ?? undefined;
        targets.push({
          short: entry.name,
          entry,
          spec,
          packageName: spec?.package ?? entry.name,
        });
      } catch {
        // Malformed third-party manifest — skip silently here; lifecycle/install
        // surface that error in their own paths.
      }
    }
  }
  return { targets };
}

/**
 * Realpath the package.json in bun's globals to find where the source
 * actually lives. For npm installs this stays inside bun globals; for `bun
 * link` and `bun add -g <abspath>` it follows out to the operator's checkout.
 */
function resolveSourceDir(
  packageName: string,
  findGlobalInstall: (pkg: string) => string | null,
  fallbackInstallDir: string | undefined,
): string | null {
  const fromGlobals = findGlobalInstall(packageName);
  if (fromGlobals) {
    try {
      return dirname(realpathSync(fromGlobals));
    } catch {
      // fall through to manifest-recorded installDir
    }
  }
  if (fallbackInstallDir) {
    try {
      return realpathSync(fallbackInstallDir);
    } catch {
      return fallbackInstallDir;
    }
  }
  return null;
}

async function isGitCheckout(dir: string, runner: UpgradeRunner): Promise<boolean> {
  const { code } = await runner.capture(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
  });
  return code === 0;
}

async function readGitHead(
  dir: string,
  runner: UpgradeRunner,
): Promise<{ code: number; sha: string }> {
  const { code, stdout } = await runner.capture(["git", "rev-parse", "HEAD"], { cwd: dir });
  return { code, sha: stdout.trim() };
}

async function listChangedFiles(
  dir: string,
  before: string,
  after: string,
  runner: UpgradeRunner,
): Promise<string[]> {
  if (before === after) return [];
  const { code, stdout } = await runner.capture(
    ["git", "diff", "--name-only", `${before}..${after}`],
    { cwd: dir },
  );
  if (code !== 0) return [];
  return stdout.trim().split("\n").filter(Boolean);
}

function packageHasScript(pkgJsonPath: string, name: string): boolean {
  try {
    const json = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    return Boolean(json?.scripts && typeof json.scripts[name] === "string");
  } catch {
    return false;
  }
}

function readPackageVersion(pkgJsonPath: string): string | null {
  try {
    const json = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    return typeof json?.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

async function upgradeLinked(
  target: ResolvedTarget,
  sourceDir: string,
  r: Resolved,
): Promise<number> {
  r.log(`${target.short}: bun-linked checkout at ${sourceDir}`);

  const status = await r.runner.capture(["git", "status", "--porcelain"], { cwd: sourceDir });
  if (status.code !== 0) {
    r.log(`✗ ${target.short}: git status failed in ${sourceDir}`);
    return status.code;
  }
  if (status.stdout.trim().length > 0) {
    r.log(
      `✗ ${target.short}: dirty working tree at ${sourceDir} — commit or stash first, then re-run.`,
    );
    return 1;
  }

  const before = await readGitHead(sourceDir, r.runner);
  if (before.code !== 0) {
    r.log(`✗ ${target.short}: failed to read HEAD in ${sourceDir}`);
    return before.code;
  }

  r.log(`${target.short}: git pull --ff-only`);
  const pull = await r.runner.run(["git", "pull", "--ff-only"], { cwd: sourceDir });
  if (pull !== 0) {
    r.log(`✗ ${target.short}: git pull --ff-only failed (exit ${pull}). Resolve and retry.`);
    return pull;
  }

  const after = await readGitHead(sourceDir, r.runner);
  if (after.code !== 0) {
    r.log(`✗ ${target.short}: failed to read HEAD post-pull`);
    return after.code;
  }

  if (before.sha === after.sha) {
    r.log(`${target.short}: already up to date (${before.sha.slice(0, 7)}). Skipping restart.`);
    return 0;
  }

  const changed = await listChangedFiles(sourceDir, before.sha, after.sha, r.runner);
  const depsChanged =
    changed.includes("package.json") ||
    changed.includes("bun.lock") ||
    changed.includes("bun.lockb");
  if (depsChanged) {
    r.log(`${target.short}: package.json/bun.lock changed — bun install --frozen-lockfile`);
    const inst = await r.runner.run(["bun", "install", "--frozen-lockfile"], { cwd: sourceDir });
    if (inst !== 0) {
      r.log(`✗ ${target.short}: bun install failed (exit ${inst})`);
      return inst;
    }
  }

  if (target.spec?.kind === "frontend") {
    const pkgJsonPath = join(sourceDir, "package.json");
    if (packageHasScript(pkgJsonPath, "build")) {
      r.log(`${target.short}: bun run build`);
      const build = await r.runner.run(["bun", "run", "build"], { cwd: sourceDir });
      if (build !== 0) {
        r.log(`✗ ${target.short}: bun run build failed (exit ${build})`);
        return build;
      }
    }
  }

  r.log(`${target.short}: ${before.sha.slice(0, 7)} → ${after.sha.slice(0, 7)}; restarting…`);
  return await r.restartFn(target.short, { manifestPath: r.manifestPath, configDir: r.configDir });
}

/**
 * Pick which dist-tag we're going to ship at. Precedence:
 *
 *   1. explicit `tag` (programmatic — caller passed it directly)
 *   2. operator `--channel rc|latest` flag
 *   3. auto-detected from the installed version string (`-rc` suffix → rc)
 *   4. `latest` fallback (no installed version to read — fresh-install case)
 */
function pickChannel(installedVersion: string | null, r: Resolved): string {
  if (r.tag) return r.tag;
  if (r.channelOverride) return r.channelOverride;
  if (installedVersion) return detectChannel(installedVersion);
  return "latest";
}

async function upgradeNpm(target: ResolvedTarget, sourceDir: string, r: Resolved): Promise<number> {
  r.log(`${target.short}: npm-installed (${sourceDir})`);
  const beforeVersion = readPackageVersion(join(sourceDir, "package.json"));
  const channel = pickChannel(beforeVersion, r);

  // Downgrade guard: refuse to silently move backward. Only applies when
  // we can read both sides — beforeVersion from disk, targetVersion via
  // `npm view`. A null on either side means we fail-open (legacy
  // behavior: just run `bun add -g`). This is the load-bearing fix for
  // hub#332 — Aaron got `0.5.13-rc.13` → `0.5.10` because the implicit
  // `@latest` resolved to a prior stable while he was on the rc chain.
  if (beforeVersion && !r.allowDowngrade) {
    const targetVersion = await r.resolveChannelVersion(target.packageName, channel);
    if (targetVersion) {
      const cmp = compareVersions(targetVersion, beforeVersion);
      if (cmp !== null && cmp < 0) {
        const channelHint =
          channel === "rc" ? "" : " or rerun with `--channel rc` to stay on the rc chain";
        const rcNote =
          channel === "rc"
            ? "  (Unusual but possible: the @rc dist-tag may have been re-pointed at an older release.)"
            : null;
        r.log(
          `✗ ${target.short}: refusing to downgrade — installed ${beforeVersion}, ` +
            `target @${channel} resolves to ${targetVersion}.`,
        );
        if (rcNote) r.log(rcNote);
        r.log(
          `  To force this downgrade, run: bun add -g ${target.packageName}@${targetVersion}${channelHint}`,
        );
        r.log("  Or re-run with --allow-downgrade to bypass this check.");
        return 1;
      }
    }
  }

  const spec = `${target.packageName}@${channel}`;
  r.log(`${target.short}: bun add -g ${spec}`);
  const code = await r.runner.run(["bun", "add", "-g", spec]);
  if (code !== 0) {
    r.log(`✗ ${target.short}: bun add -g failed (exit ${code})`);
    return code;
  }

  const afterVersion = readPackageVersion(join(sourceDir, "package.json"));
  if (beforeVersion && afterVersion && beforeVersion === afterVersion) {
    r.log(`${target.short}: already at ${afterVersion}. Skipping restart.`);
    return 0;
  }

  r.log(`${target.short}: ${beforeVersion ?? "?"} → ${afterVersion ?? "?"}; restarting…`);
  return await r.restartFn(target.short, { manifestPath: r.manifestPath, configDir: r.configDir });
}

async function upgradeOne(target: ResolvedTarget, r: Resolved): Promise<number> {
  const sourceDir = resolveSourceDir(
    target.packageName,
    r.findGlobalInstall,
    target.entry.installDir,
  );
  if (!sourceDir) {
    r.log(
      `✗ ${target.short}: can't locate install dir for ${target.packageName}. Try \`parachute install ${target.short}\` first.`,
    );
    return 1;
  }
  if (!existsSync(sourceDir)) {
    r.log(`✗ ${target.short}: install dir ${sourceDir} does not exist.`);
    return 1;
  }

  if (await isGitCheckout(sourceDir, r.runner)) {
    return await upgradeLinked(target, sourceDir, r);
  }
  return await upgradeNpm(target, sourceDir, r);
}

/**
 * Sweep one or all installed services through the upgrade flow. Returns 0
 * when every target succeeds; non-zero is the exit code of the first failure
 * (subsequent targets still run — partial success is preferable to halting
 * mid-sweep on a flake).
 */
export async function upgrade(svc: string | undefined, opts: UpgradeOpts = {}): Promise<number> {
  const r = resolve(opts);
  const picked = await resolveTargets(svc, r.manifestPath);
  if ("error" in picked) {
    r.log(picked.error);
    return 1;
  }

  let firstFailure = 0;
  for (const target of picked.targets) {
    const code = await upgradeOne(target, r);
    if (code !== 0 && firstFailure === 0) firstFailure = code;
  }
  return firstFailure;
}
