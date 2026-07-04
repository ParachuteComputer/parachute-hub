/**
 * `parachute upgrade [<service>]` — pull / re-install / restart in one step.
 *
 * Detects whether the target service is bun-linked from a local checkout (the
 * dev-mode install shape) or npm-installed from a published artifact, then
 * does the right thing for each:
 *
 *   bun-linked:   git -C <checkout> pull --ff-only;
 *                 bun install --frozen-lockfile (if package.json/bun.lock changed);
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
 *
 * RC-channel best-of resolution (hub#659). Channel preservation (#332) made
 * the rc channel sticky — `parachute upgrade` follows `@rc`. But the rc
 * channel is a *canary*: when a train ships stable-direct without cutting an
 * rc (the common case under the post-#332 governance where trains start at
 * stable), `@rc` doesn't advance and the box strands BELOW `@latest` with no
 * visible path forward (the live case: friends.parachute.computer pinned at
 * 0.6.5-rc.8 while @latest moved to 0.7.1). The fix: on the rc channel we
 * resolve the target to the HIGHEST version above installed across BOTH `@rc`
 * AND `@latest`.
 *   - mid-chain (a newer rc exists) → take the rc; the canary stays ahead
 *     (UNCHANGED — this is the #332 behavior).
 *   - end-of-chain / skipped-rc train (no newer rc, but @latest > installed)
 *     → CONVERGE to @latest, with a loud log line. The operator stays ON the
 *     rc channel (the install/config notion of channel is unchanged) — only
 *     the resolved VERSION changes; they pick up the next rc when it ships.
 *   - nothing newer anywhere → the existing up-to-date no-op.
 * The `@latest` (stable) channel path is UNCHANGED — stable never reaches for
 * `@rc`. `--channel rc|latest` explicit overrides and `--allow-downgrade`
 * keep working.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { HUB_PACKAGE, HUB_SVC } from "../hub-control.ts";
import {
  type HubUnitDeps,
  type HubUnitManagerOpResult,
  defaultHubUnitDeps,
  restartHubUnit as restartHubUnitImpl,
} from "../hub-unit.ts";
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

/**
 * Exit code we synthesize when a binary can't be spawned at all. 127 is the
 * POSIX shell convention for "command not found" — it lets every git call
 * degrade to a normal non-zero result instead of crashing the whole command.
 */
const SPAWN_NOT_FOUND_CODE = 127;

/**
 * True when an error thrown by `Bun.spawn` means "the executable doesn't
 * exist on this host" (ENOENT). On a minimal server with no `git` installed —
 * a legitimate, common shape for a published-npm install on the canonical
 * install path — `Bun.spawn(["git", ...])` throws *synchronously* with this
 * shape. We catch it so `parachute upgrade` degrades to the npm path rather
 * than dying with an uncaught `Executable not found in $PATH: "git"`.
 */
function isSpawnNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return (
    code === "ENOENT" ||
    (typeof message === "string" && message.includes("Executable not found in $PATH"))
  );
}

export const defaultRunner: UpgradeRunner = {
  async run(cmd, opts) {
    // Inherit env so `bun add -g` etc. see TMPDIR, BUN_INSTALL, PATH, HOME.
    // Bun.spawn defaults to empty env — see api-modules-ops.ts:defaultRun.
    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn([...cmd], {
        cwd: opts?.cwd,
        stdio: ["inherit", "inherit", "inherit"],
        env: process.env,
      });
    } catch (err) {
      // Binary not on this host (e.g. no `git` on a minimal server). Degrade
      // to a non-zero exit rather than letting the throw crash the command.
      if (isSpawnNotFound(err)) return SPAWN_NOT_FOUND_CODE;
      throw err;
    }
    return await proc.exited;
  },
  async capture(cmd, opts) {
    // Inherit env — same rationale as `run` above.
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([...cmd], {
        cwd: opts?.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      });
    } catch (err) {
      // See `run` above: ENOENT (binary-not-found) becomes a captured
      // non-zero result so every git call degrades to "command failed".
      if (isSpawnNotFound(err)) {
        const bin = cmd[0] ?? "command";
        return { code: SPAWN_NOT_FOUND_CODE, stdout: `${bin}: not found on this host\n` };
      }
      throw err;
    }
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
   * https://github.com/ParachuteComputer/parachute-workspace/blob/main/docs/process/governance.md),
   * operators on the dev
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
  /**
   * Supervisor-path seams (design §5) — the ONLY runtime as of Phase 5b.
   * `upgrade hub` rewrites the binary as usual then RESTARTS THE UNIT via the
   * platform manager (`restartHubUnit` — systemctl restart / launchctl kickstart
   * -k): the manager tears down the old hub (children die), starts the new
   * binary, which re-boots every module from services.json. NEVER a PID-signal
   * restart (launchd KeepAlive / systemd Restart=always would fight). Module-
   * target restarts drive the running Supervisor (lifecycle's own dispatch, fed
   * a `supervisor` block here). The detached restart arm was retired in Phase 5b.
   *
   * Production CLI dispatch passes `supervisor: {}`; tests inject the seams they
   * want to assert.
   */
  supervisor?: {
    /** Deps for the `restartHubUnit` manager op. */
    hubUnitDeps?: HubUnitDeps;
    /** Restart the hub unit via the platform manager (never a PID signal, §5). */
    restartHubUnit?: (deps: HubUnitDeps) => HubUnitManagerOpResult;
  };
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
  hubUnitDeps: HubUnitDeps;
  restartHubUnit: (deps: HubUnitDeps) => HubUnitManagerOpResult;
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
    // Supervisor seams (the only runtime as of Phase 5b). Production passes
    // `supervisor: {}`; tests inject the seams they want to assert.
    ...resolveUpgradeSupervisor(opts.supervisor),
  };
}

/** Resolve the supervisor seams for the upgrade path. */
function resolveUpgradeSupervisor(opts: UpgradeOpts["supervisor"]): {
  hubUnitDeps: HubUnitDeps;
  restartHubUnit: (deps: HubUnitDeps) => HubUnitManagerOpResult;
} {
  return {
    hubUnitDeps: opts?.hubUnitDeps ?? defaultHubUnitDeps,
    restartHubUnit: opts?.restartHubUnit ?? restartHubUnitImpl,
  };
}

/**
 * Channel detection from a semver-ish version string. Pre-1.0 governance
 * (https://github.com/ParachuteComputer/parachute-workspace/blob/main/docs/process/governance.md
 * rule 2) ships rc chains as
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
  //
  // Phase 4 note (design §5 item 4): on a unit-managed box, restarting the hub
  // unit re-boots ALL modules from services.json. So the hub-first sweep already
  // boots every module onto current code when the hub binary upgrades; each
  // module target then upgrades its package + `supervisor.restart`s it
  // individually (idempotent — a no-op restart if its code didn't change). The
  // hub-first invariant still holds.
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

function readPackageVersion(pkgJsonPath: string): string | null {
  try {
    const json = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    return typeof json?.version === "string" ? json.version : null;
  } catch {
    return null;
  }
}

/**
 * Restart an upgraded target after its binary/package was rewritten (design §5).
 * Supervised path only (Phase 5b — the detached restart arm is retired):
 *   - HUB target → restart the hub UNIT via the platform manager
 *     (`restartHubUnit` — systemctl restart / launchctl kickstart -k). The
 *     manager tears down the old hub (children die), starts the new binary,
 *     which re-boots every module from services.json. NEVER a PID-signal restart
 *     (launchd KeepAlive / systemd Restart=always would fight). The command
 *     returns once the restart is dispatched; it does not need to outlive the
 *     old hub.
 *   - MODULE target → drive the running Supervisor by handing `lifecycle.restart`
 *     the SAME opts a bare `parachute restart <svc>` threads: `supervisor: {}`
 *     (so the real `isHubUnitInstalled` probe — not a forced override — decides)
 *     plus `migrateOffer: { enabled: true }`. Its dispatch then routes to
 *     `supervisor.restart` with the 404-fallthrough. The hub unit was already
 *     restarted hub-first in the sweep, so it's up to answer.
 *
 * A box with no hub unit takes the actionable migrate path: the hub-target
 * `restartHubUnit` returns `no-unit` (messages surfaced, non-zero), and the
 * module-target `lifecycle.restart` — driven with `supervisor: {}` +
 * `migrateOffer` — runs `requireSupervisedOrOffer`'s real probe, then the §7.5
 * auto-offer / actionable "run `parachute migrate --to-supervised`" error,
 * rather than a bare connection-refused from `driveModuleOp`.
 */
async function restartTarget(target: ResolvedTarget, r: Resolved): Promise<number> {
  if (target.short === HUB_SVC) {
    const res = r.restartHubUnit(r.hubUnitDeps);
    for (const m of res.messages) r.log(m);
    if (res.outcome === "ok") {
      r.log(`${target.short}: restarted the hub unit (all modules re-booted).`);
      return 0;
    }
    return 1;
  }
  // Module target: route through lifecycle's supervisor arm with the SAME opts a
  // bare `parachute restart <svc>` threads — `supervisor: {}` (let the real
  // `isHubUnitInstalled` probe decide; do NOT force `unitInstalled: true` and
  // bypass it) plus `migrateOffer: { enabled: true }`. On a supervised box this
  // drives `supervisor.restart` over the loopback module-ops API; on a no-unit
  // box it gets the §7.5 auto-offer / actionable migrate error instead of a bare
  // connection-refused. `hubUnitDeps` threads through so the real probe + manager
  // ops use the resolved deps (production defaults; tests inject the seams).
  return await r.restartFn(target.short, {
    manifestPath: r.manifestPath,
    configDir: r.configDir,
    supervisor: { hubUnitDeps: r.hubUnitDeps },
    migrateOffer: { enabled: true },
  });
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

  r.log(`${target.short}: ${before.sha.slice(0, 7)} → ${after.sha.slice(0, 7)}; restarting…`);
  return await restartTarget(target, r);
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

/**
 * The dist-tag / version `upgradeNpm` will hand to `bun add -g`, after the
 * rc-channel best-of resolution (hub#659). `installSpec` is what follows the
 * `@` in `bun add -g <pkg>@<installSpec>` — usually a dist-tag (`rc` /
 * `latest`), but a pinned concrete version when we converge an rc-channel box
 * onto stable (so a moving `@latest` can't race the resolution). `channel` is
 * the dist-tag we resolved against, used by the downgrade-guard messaging.
 */
interface ResolvedNpmTarget {
  installSpec: string;
  channel: string;
}

/**
 * Resolve which version the rc channel should actually move to (hub#659).
 *
 * Channel preservation (#332) keeps an rc operator following `@rc`. But `@rc`
 * is a canary that only advances when a train cuts an rc; a stable-direct
 * train leaves it stranded below `@latest`. So on the rc channel we look at
 * BOTH dist-tags and take the highest one that's actually ABOVE installed:
 *   - a newer `@rc` exists → stay on rc (mid-chain canary; UNCHANGED).
 *   - no newer rc but `@latest` > installed → converge to `@latest`, pinned to
 *     the concrete resolved version, with a LOUD log. The operator stays ON
 *     the rc channel; only this upgrade's resolved version changes.
 *   - neither tag is above installed → fall through to the rc tag and let the
 *     normal "already at <v>" no-op fire after `bun add -g`.
 *
 * Returns the original `{ installSpec: "rc" }` unchanged whenever we can't read
 * the installed version or can't resolve a higher stable (fail-open: never
 * block a legitimate `@rc` upgrade on a flaky probe).
 */
async function resolveRcBestOf(
  target: ResolvedTarget,
  beforeVersion: string | null,
  r: Resolved,
): Promise<ResolvedNpmTarget> {
  const rcTarget: ResolvedNpmTarget = { installSpec: "rc", channel: "rc" };
  if (!beforeVersion) return rcTarget;

  const [rcVersion, latestVersion] = await Promise.all([
    r.resolveChannelVersion(target.packageName, "rc"),
    r.resolveChannelVersion(target.packageName, "latest"),
  ]);

  const rcAbove = rcVersion !== null && (compareVersions(rcVersion, beforeVersion) ?? -1) > 0;
  if (rcAbove) {
    // A newer rc exists — the canary stays ahead (the #332 mid-chain path).
    return rcTarget;
  }

  const latestAbove =
    latestVersion !== null && (compareVersions(latestVersion, beforeVersion) ?? -1) > 0;
  // (`latestVersion !== null` already guaranteed by `latestAbove`; the second
  // term only narrows it for TS.)
  if (latestAbove && latestVersion) {
    // End-of-chain / skipped-rc train: nothing newer on @rc, but stable moved
    // ahead. Converge to @latest — pinned to the concrete version so a moving
    // dist-tag can't race us — and say so LOUDLY (the hub#659 stranding fix).
    r.log(
      `${target.short}: the rc channel has nothing newer than ${beforeVersion}; ` +
        `converging to stable ${latestVersion} — you'll pick up the next rc when it ships.`,
    );
    return { installSpec: latestVersion, channel: "latest" };
  }

  // Neither tag is above installed — stay on @rc and let the post-install
  // "already at <v>" no-op fire (handled in upgradeNpm). When both probes
  // resolved and both are ≤ installed, name that explicitly.
  if (rcVersion !== null && latestVersion !== null) {
    r.log(
      `${target.short}: on the rc channel — @rc (${rcVersion}) and @latest (${latestVersion}) ` +
        `are both at or below installed ${beforeVersion}.`,
    );
  }
  return rcTarget;
}

async function upgradeNpm(target: ResolvedTarget, sourceDir: string, r: Resolved): Promise<number> {
  r.log(`${target.short}: npm-installed (${sourceDir})`);
  const beforeVersion = readPackageVersion(join(sourceDir, "package.json"));
  const pickedChannel = pickChannel(beforeVersion, r);

  // RC-channel best-of resolution (hub#659). On the rc channel, resolve to the
  // highest version above installed across @rc AND @latest — so an end-of-chain
  // box converges to stable instead of stranding below it. The stable channel
  // and explicit programmatic `--tag` are UNCHANGED: only an *auto-detected or
  // --channel-rc* resolution reaches for stable. An explicit `--channel rc`
  // ALSO flows through best-of (a deliberate rc operator still gets converge);
  // `r.tag` (programmatic pin) and `--channel latest` both leave it untouched.
  let installSpec = pickedChannel;
  let channel = pickedChannel;
  if (pickedChannel === "rc" && !r.tag) {
    const resolved = await resolveRcBestOf(target, beforeVersion, r);
    installSpec = resolved.installSpec;
    channel = resolved.channel;
  }

  // Downgrade guard: refuse to silently move backward. Only applies when
  // we can read both sides — beforeVersion from disk, targetVersion via
  // `npm view`. A null on either side means we fail-open (legacy
  // behavior: just run `bun add -g`). This is the load-bearing fix for
  // hub#332 — Aaron got `0.5.13-rc.13` → `0.5.10` because the implicit
  // `@latest` resolved to a prior stable while he was on the rc chain.
  //
  // After hub#659's best-of resolution `channel` is already the tag we're
  // actually shipping (rc on the canary path, latest on the converge path), so
  // the guard checks the version we'll really install.
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

  const spec = `${target.packageName}@${installSpec}`;
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
  return await restartTarget(target, r);
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
