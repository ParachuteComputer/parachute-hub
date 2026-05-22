import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autoWireScribeAuth } from "../auto-wire.ts";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  type ModuleManifest,
  ModuleManifestError,
  readModuleManifest,
  validateModuleManifest,
} from "../module-manifest.ts";
import { assignServicePort } from "../port-assign.ts";
import { finalizeModuleInstall, stampInstallDirOnRow } from "../post-install.ts";
import {
  CANONICAL_PORT_MAX,
  CANONICAL_PORT_MIN,
  FIRST_PARTY_FALLBACKS,
  type FirstPartyExtras,
  type FirstPartyFallback,
  KNOWN_MODULES,
  type KnownModule,
  type ServiceSpec,
  composeServiceSpec,
  isCanonicalPort,
  synthesizeManifestForKnownModule,
} from "../service-spec.ts";
import { findService, readManifest, upsertService } from "../services-manifest.ts";
import { WELL_KNOWN_PATH } from "../well-known.ts";
import { start as lifecycleStart } from "./lifecycle.ts";
import { migrateNotice } from "./migrate.ts";
import {
  type InteractiveAvailability,
  type SetupScribeProviderOpts,
  setupScribeProvider,
} from "./scribe-provider-interactive.ts";

export type Runner = (cmd: readonly string[]) => Promise<number>;

/**
 * Transition aliases for services that were renamed. Accepted for one
 * release cycle with a rename notice, then removed. `lens → notes`
 * exists because the frontend was briefly renamed Notes → Lens (Apr 19)
 * and then reverted (Apr 22) on launch eve. Anyone who ran `parachute
 * install lens` during the ~3-day window keeps working. Remove after
 * launch sinks in and `parachute install lens` has stopped appearing
 * in support threads.
 */
const SERVICE_ALIASES: Record<string, string> = {
  lens: "notes",
};

export interface InstallOpts {
  runner?: Runner;
  manifestPath?: string;
  configDir?: string;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * True when the package is already globally linked (via `bun link`) so
   * `bun add -g` would be redundant — or worse, fail with a 404 for a
   * package that isn't published to npm yet (the scribe case on 2026-04-19).
   * Defaults to a symlink check against bun's global node_modules prefix.
   */
  isLinked?: (pkg: string) => boolean;
  /**
   * Returns the absolute path a global symlink points at, or null if no
   * symlink exists. Used by local-path installs to skip a redundant
   * `bun add -g <abspath>` when the path is already wired up — repeatedly
   * `bun add -g <abspath>`'ing the same path appends duplicate entries to
   * `~/.bun/install/global/package.json` until the lockfile parser breaks
   * (hub#89). Defaults to a `readlink` against bun's global prefixes.
   */
  linkedPath?: (pkg: string) => string | null;
  /**
   * Optional npm dist-tag or exact version to install. When set, the
   * `bun add -g` call is composed as `<package>@<tag>` so RC testers can
   * pin a pre-release channel. `isLinked` still short-circuits — if the
   * package is bun-linked locally, the tag is moot.
   */
  tag?: string;
  /**
   * Override the random-token source for the vault↔scribe auto-wire.
   * Tests pass a deterministic string; production uses crypto.randomBytes.
   */
  randomToken?: () => string;
  /**
   * Probe whether `pkg` is present at bun's global node_modules (returns the
   * package.json path on hit, null on miss). Used after `bun add -g` returns
   * non-zero to distinguish a real failure from bun 1.2.x's noisy
   * lockfile-recovery path — where the package *is* actually installed
   * despite the exit code. Defaults to a filesystem probe against
   * `bunGlobalPrefixes()`.
   */
  findGlobalInstall?: (pkg: string) => string | null;
  /**
   * Skip the post-install daemon start. The launch-day default is to leave
   * the service running so users don't have to remember the second command;
   * pass `true` for piped / CI installs that own their own process model.
   */
  noStart?: boolean;
  /**
   * Test seam: lifecycle start hook used by the post-install auto-start.
   * Defaults to `lifecycle.start(short, …)`. Tests inject a fake to assert
   * the call without spawning a real child.
   */
  startService?: (short: string) => Promise<number>;
  /**
   * `parachute install vault` only: skip the vault-name prompt by forwarding
   * `--vault-name <name>` to `parachute-vault init`. Used by `parachute setup`
   * (#45) to pre-collect the answer up front. Ignored for non-vault installs.
   */
  vaultName?: string;
  /**
   * `parachute install scribe` only: pre-pick the transcription provider so
   * the prompt doesn't fire. Validated against scribe's known providers — an
   * unknown name is logged and the config is left at default.
   */
  scribeProvider?: string;
  /**
   * `parachute install scribe` only: pre-supply the API key for the chosen
   * provider. Ignored for local providers (parakeet-mlx / onnx-asr / whisper).
   */
  scribeKey?: string;
  /**
   * Test seam for the scribe provider picker. Tests pass `{ kind: "available",
   * prompt: ... }` to drive the prompt without a real TTY; production lets
   * the default sense `process.stdin.isTTY`.
   */
  scribeAvailability?: InteractiveAvailability;
  /**
   * Test seam for the canonical-slot TCP probe. Production probes
   * `127.0.0.1:<port>` with a short timeout; tests inject deterministic
   * answers. Always returns false in tests so canonical slots stay free
   * unless the test populates services.json directly.
   */
  portProbe?: (port: number) => Promise<boolean>;
  /**
   * Test seam for reading `<packageDir>/.parachute/module.json`. Production
   * uses the real file reader; tests inject a map from package-dir → manifest
   * (or throw to simulate malformed JSON). Returns null when the package
   * doesn't ship a manifest.
   */
  readManifest?: (packageDir: string) => Promise<ModuleManifest | null>;
  /**
   * Test seam for reading `<absPath>/package.json` during local-path install.
   * Production reads + parses the file; tests inject a stub. Returns the
   * package's `name` (used to find the install dir post-bun-add).
   */
  readPackageName?: (absPath: string) => string | null;
  /**
   * Override the on-disk path for the regenerated `/.well-known/parachute.json`
   * (test seam). When unset and `manifestPath` is the production default,
   * defaults to `WELL_KNOWN_PATH` so an interactive `parachute install`
   * refreshes the inspection artifact. When `manifestPath` is overridden
   * (tests with tempdir services.json) AND this is unset, the regen is
   * skipped — tests that want to assert on the well-known doc opt in by
   * passing a tempdir path here.
   */
  wellKnownPath?: string;
  /**
   * Origin to embed in the regenerated well-known's `url` fields. When
   * unset (the typical CLI case), the regen still runs but the
   * canonicalOrigin defaults to `http://localhost:1939` — the live HTTP
   * path at `/.well-known/parachute.json` rebuilds per request with the
   * request's actual origin, so the on-disk doc's origin is best-effort
   * for tooling that reads the file directly. Tests pass a synthetic
   * origin for stable assertions.
   */
  wellKnownOrigin?: string;
}

async function defaultRunner(cmd: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...cmd], { stdio: ["inherit", "inherit", "inherit"] });
  return await proc.exited;
}

function bunGlobalPrefixes(): string[] {
  const prefixes: string[] = [];
  const fromEnv = process.env.BUN_INSTALL;
  if (fromEnv) prefixes.push(join(fromEnv, "install", "global", "node_modules"));
  prefixes.push(join(homedir(), ".bun", "install", "global", "node_modules"));
  return prefixes;
}

function defaultIsLinked(pkg: string): boolean {
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

function defaultLinkedPath(pkg: string): string | null {
  // bun has two install shapes for "linked-style" globals:
  //   - `bun link`: <prefix>/node_modules/<pkg> is itself a symlink to source.
  //   - `bun add -g <abspath>`: <prefix>/node_modules/<pkg> is a real dir
  //     whose entries (package.json, etc.) are file-level symlinks to source.
  // Resolving <prefix>/node_modules/<pkg>/package.json follows the link to
  // the source package.json in either shape; dirname is the source dir.
  for (const prefix of bunGlobalPrefixes()) {
    const pkgJson = join(prefix, ...pkg.split("/"), "package.json");
    try {
      return dirname(realpathSync(pkgJson));
    } catch {
      // Not present at this prefix; try the next.
    }
  }
  return null;
}

/**
 * Short-timeout TCP probe of `127.0.0.1:<port>`. Used by `parachute install`
 * to detect canonical slots that something else is already on. Fail-open:
 * timeouts and errors return `false` so a flaky probe never blocks an
 * install.
 */
async function defaultPortProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (taken: boolean) => {
      if (settled) return;
      settled = true;
      resolve(taken);
    };
    try {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(150, () => {
        socket.destroy();
        finish(false);
      });
      socket.on("connect", () => {
        socket.end();
        finish(true);
      });
      socket.on("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

async function collectOccupiedPorts(
  manifestPath: string,
  selfManifestName: string,
  selfPort: number | undefined,
  probe: (port: number) => Promise<boolean>,
): Promise<Set<number>> {
  const ports = new Set<number>();
  try {
    const manifest = readManifest(manifestPath);
    for (const svc of manifest.services) {
      if (svc.name === selfManifestName) continue;
      ports.add(svc.port);
    }
  } catch {
    // Manifest missing or malformed — fall back to the TCP probe alone.
  }
  for (let p = CANONICAL_PORT_MIN; p <= CANONICAL_PORT_MAX; p++) {
    if (selfPort !== undefined && p === selfPort) continue;
    try {
      if (await probe(p)) ports.add(p);
    } catch {
      // Probe error — fail-open per CLI port-authority policy.
    }
  }
  return ports;
}

function defaultFindGlobalInstall(pkg: string): string | null {
  for (const prefix of bunGlobalPrefixes()) {
    const pkgJsonPath = join(prefix, ...pkg.split("/"), "package.json");
    try {
      const parsed = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (typeof parsed?.name === "string" && typeof parsed?.version === "string") {
        return pkgJsonPath;
      }
    } catch {
      // Not present / not valid at this prefix; try the next.
    }
  }
  return null;
}

function defaultReadPackageName(absPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(absPath, "package.json"), "utf8"));
    return typeof parsed?.name === "string" && parsed.name.length > 0 ? parsed.name : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute path to the installed package directory. Local-path
 * installs are their own source. Npm installs land under a bun globals
 * prefix; we locate via `findGlobalInstall`. Returns null when the dir
 * can't be located (first-party fallback path: not fatal; third-party:
 * the manifest read downstream surfaces the error).
 */
function resolveInstallDir(
  target: ResolvedTarget,
  findGlobalInstall: (pkg: string) => string | null,
): string | null {
  if (target.kind === "local-path") {
    // The local checkout itself is the source. We could also re-read from
    // bun's globals after install, but reading the original avoids any
    // weirdness with bun symlinking the dir vs. copying it.
    return target.absPath;
  }
  const pkgJsonPath = findGlobalInstall(target.packageName);
  return pkgJsonPath ? dirname(pkgJsonPath) : null;
}

/**
 * Read the installed package's `.parachute/module.json`.
 *
 * Returns `null` when the package doesn't ship one (first-party falls back to
 * the vendored manifest; third-party hard-errors at the call site). Returns
 * `"error"` when the manifest exists but is malformed (or the install
 * directory itself can't be located post-install) — caller treats both as
 * an install-aborting error and the helper has already logged.
 */
async function readInstalledManifest(
  target: ResolvedTarget,
  packageDir: string | null,
  deps: {
    readManifest: (packageDir: string) => Promise<ModuleManifest | null>;
    log: (line: string) => void;
  },
): Promise<ModuleManifest | null | "error"> {
  if (!packageDir) {
    // First-party fallback path (typical in tests): we don't actually need
    // a real install dir — the vendored manifest covers us.
    // Third-party: bun-add succeeded but we couldn't locate the install dir;
    // caller already logged a probe-list — just say nothing's there.
    return null;
  }
  try {
    return await deps.readManifest(packageDir);
  } catch (err) {
    if (err instanceof ModuleManifestError) {
      deps.log(`✗ ${target.packageName}: invalid .parachute/module.json — ${err.message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log(`✗ ${target.packageName}: failed to read .parachute/module.json — ${msg}`);
    }
    return "error";
  }
}

/**
 * What `parachute install <input>` resolved to. The CLI accepts three forms,
 * and the resolution decides everything downstream — package name to bun-add,
 * whether a vendored fallback applies, whether a missing
 * `.parachute/module.json` is a hard error.
 *
 * The first-party path splits two ways post-hub#310:
 *
 *   - **fallback**: notes / channel still ship a vendored manifest + extras
 *     in FIRST_PARTY_FALLBACKS. Missing `module.json` is non-fatal — the
 *     embedded manifest carries the install through.
 *   - **known**: vault / scribe / runner have retired their FALLBACK entries.
 *     We know the package + manifestName + imperative extras (init,
 *     postInstallFooter, urlForEntry, hasAuth) but NOT the static manifest;
 *     `module.json` is the contract and a missing one is a hard error,
 *     same posture as third-party.
 */
type ResolvedTarget =
  | {
      readonly kind: "first-party";
      readonly short: string;
      readonly packageName: string;
      readonly fallback: FirstPartyFallback;
    }
  | {
      readonly kind: "known-module";
      readonly short: string;
      readonly packageName: string;
      readonly known: KnownModule;
    }
  | {
      readonly kind: "npm";
      readonly packageName: string;
    }
  | {
      readonly kind: "local-path";
      readonly absPath: string;
      readonly packageName: string;
    };

/**
 * Map an `<input>` (shortname / npm package / absolute path) to a target.
 * Returns null on resolution failure (with logs already written).
 *
 * Order matters: first-party shortnames win over a hypothetical npm package
 * literally named "vault", and absolute-path detection has to come before the
 * "anything else is npm" fallback.
 */
function resolveInstallTarget(
  input: string,
  opts: InstallOpts,
  log: (line: string) => void,
): ResolvedTarget | null {
  // Aliases (lens → notes) apply only to shortnames — npm packages and
  // absolute paths pass through unaltered.
  const aliased = SERVICE_ALIASES[input];
  const candidate = aliased ?? input;

  const fb = FIRST_PARTY_FALLBACKS[candidate];
  if (fb) {
    if (aliased !== undefined) {
      log(`"${input}" has been renamed to "${aliased}"; installing ${aliased}.`);
    }
    return {
      kind: "first-party",
      short: candidate,
      packageName: fb.package,
      fallback: fb,
    };
  }
  const km = KNOWN_MODULES[candidate];
  if (km) {
    if (aliased !== undefined) {
      log(`"${input}" has been renamed to "${aliased}"; installing ${aliased}.`);
    }
    return {
      kind: "known-module",
      short: candidate,
      packageName: km.package,
      known: km,
    };
  }

  if (input.startsWith("/")) {
    if (!existsSync(input)) {
      log(`unknown service: "${input}" (path does not exist)`);
      return null;
    }
    const readName = opts.readPackageName ?? defaultReadPackageName;
    const packageName = readName(input);
    if (!packageName) {
      log(`✗ ${input} has no readable package.json — can't install as a Parachute module.`);
      return null;
    }
    return { kind: "local-path", absPath: input, packageName };
  }

  // Anything else is treated as an npm package (bare or @scope/name). The
  // module.json contract gates this — third-party packages without a
  // manifest fail post-install with a clear error, not silently.
  return { kind: "npm", packageName: input };
}

export async function install(input: string, opts: InstallOpts = {}): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line) => console.log(line));
  const isLinked = opts.isLinked ?? defaultIsLinked;
  const linkedPath = opts.linkedPath ?? defaultLinkedPath;
  const findGlobalInstall = opts.findGlobalInstall ?? defaultFindGlobalInstall;
  const readManifest = opts.readManifest ?? readModuleManifest;

  const target = resolveInstallTarget(input, opts, log);
  if (!target) return 1;

  // bun-add gate: skip when the package is already wired up.
  //   - first-party + isLinked: scribe-style `bun link` against an unpublished
  //     local checkout. `bun add -g` would 404.
  //   - local-path + symlink already points at this path: re-installing the
  //     same checkout. `bun add -g <abspath>` accumulates duplicate entries
  //     in `~/.bun/install/global/package.json` until bun's lockfile parser
  //     gives up (hub#89 — caught during paraclaw smoke testing 2026-04-27).
  // Otherwise run `bun add -g <spec>` so bun's link plumbing produces a
  // binary on PATH.
  const localAlreadyLinkedTo = target.kind === "local-path" ? linkedPath(target.packageName) : null;
  // Compare via realpath on the input side too, so symlinks in the path
  // the user typed don't make us miss an existing match.
  let targetReal: string | undefined;
  if (target.kind === "local-path") {
    try {
      targetReal = realpathSync(target.absPath);
    } catch {
      targetReal = target.absPath;
    }
  }
  if (
    (target.kind === "first-party" || target.kind === "known-module") &&
    isLinked(target.packageName)
  ) {
    log(`${target.packageName} is already linked globally (bun link) — skipping bun add.`);
  } else if (target.kind === "local-path" && localAlreadyLinkedTo === targetReal) {
    log(`${target.packageName} is already linked at ${target.absPath} — skipping bun add.`);
  } else {
    const addSpec =
      target.kind === "local-path"
        ? target.absPath
        : opts.tag
          ? `${target.packageName}@${opts.tag}`
          : target.packageName;
    log(`Installing ${addSpec}…`);
    const addCode = await runner(["bun", "add", "-g", addSpec]);
    if (addCode !== 0) {
      // Bun 1.2.x has a noisy lockfile-recovery path where `bun add -g` prints
      // InvalidPackageResolution + "Failed to install 1 package" and exits 1,
      // *even though the package is successfully installed* (you can see
      // "installed @openparachute/<foo> with binaries" in the same output).
      // Bailing here on exit code alone means the caller-visible install
      // fails and downstream init/seed never runs — so probe the global
      // prefix before treating non-zero as fatal.
      const foundAt = findGlobalInstall(target.packageName);
      if (foundAt) {
        log(
          `bun add reported exit ${addCode} but ${target.packageName} is installed at ${foundAt}.`,
        );
        log(
          "Known bun 1.2.x lockfile quirk — the package landed despite the warning. Proceeding. `bun upgrade` to 1.3.x avoids it.",
        );
      } else {
        // Make the failure mode legible: enumerating the prefixes we probed
        // turns "bun add -g failed" into something an operator on a non-
        // standard bun layout can act on. (Surfaced by parachute-hub#44 — a
        // bun 1.2.x report where `notes` never registered; if the same
        // failure mode ever manifests via findGlobalInstall returning null,
        // the log tells us where to look.)
        log(`bun add -g ${addSpec} failed (exit ${addCode})`);
        log(`  probed bun globals at: ${bunGlobalPrefixes().join(", ")}`);
        return addCode;
      }
    }
  }

  // Read the installed `.parachute/module.json` (target convention). For
  // first-party we fall back to the vendored manifest when absent; for
  // third-party (npm / local-path) the manifest is the contract — its
  // absence hard-errors here. See
  // `parachute-patterns/patterns/module-json-extensibility.md`.
  const installDir = resolveInstallDir(target, findGlobalInstall);
  const installedManifest = await readInstalledManifest(target, installDir, {
    readManifest,
    log,
  });
  if (installedManifest === "error") return 1;

  let manifest: ModuleManifest;
  let extras: FirstPartyExtras | undefined;
  if (target.kind === "first-party") {
    manifest = installedManifest ?? target.fallback.manifest;
    extras = target.fallback.extras;
  } else if (target.kind === "known-module") {
    // KNOWN_MODULES shorts (vault / scribe / runner) carry no vendored
    // manifest (hub#310). The module's own `.parachute/module.json` is the
    // canonical source. When it's unreadable (legacy installs from before
    // module.json shipped, or test fixtures that mock the disk path without
    // writing a real manifest), synthesize a minimal manifest from
    // KNOWN_MODULES' canonical fields so the install path can still seed
    // services.json. The synthesized version mirrors what the module's
    // module.json carries — kept in sync as a graceful-degrade safety net.
    // The CLI imperative bits (init, postInstallFooter, urlForEntry,
    // hasAuth) come from `target.known.extras`.
    manifest = installedManifest ?? synthesizeManifestForKnownModule(target.known);
    if (!installedManifest) {
      log(
        `${target.packageName} did not ship .parachute/module.json — using hub's vendored canonical manifest as a fallback. Re-install with a newer module to pick up its own module.json.`,
      );
    }
    extras = target.known.extras;
  } else {
    if (!installedManifest) {
      log(`✗ ${target.packageName} does not ship .parachute/module.json — not a Parachute module.`);
      log(
        "  Authors: see parachute-patterns/patterns/module-json-extensibility.md for the contract.",
      );
      return 1;
    }
    // Third-party `name` collides with a first-party shortname → reject
    // before we mint a services.json row that would hide a real first-party
    // install. (Scope namespace is also `name`; collision == squatting.)
    if (
      FIRST_PARTY_FALLBACKS[installedManifest.name] !== undefined ||
      KNOWN_MODULES[installedManifest.name] !== undefined
    ) {
      log(
        `✗ ${target.packageName}: module name "${installedManifest.name}" collides with a first-party Parachute module.`,
      );
      return 1;
    }
    manifest = installedManifest;
  }

  const short =
    target.kind === "first-party" || target.kind === "known-module" ? target.short : manifest.name;
  const spec: ServiceSpec = composeServiceSpec({
    packageName: target.packageName,
    manifest,
    extras,
  });
  // services.json key. Third-party modules key by `manifest.name` (canonical
  // short — what `parachute start <svc>` accepts). First-party services keep
  // keying by `manifestName` ("parachute-vault" etc.) because the upstream
  // services write themselves to services.json under that name; switching the
  // CLI seed alone would create dueling rows. The first-party migration to
  // name-keyed rows happens when each upstream ships its own module.json
  // (parachute-hub#56 follow-ups). See parachute-hub#85.
  const entryName =
    target.kind === "first-party" || target.kind === "known-module"
      ? spec.manifestName
      : manifest.name;

  if (spec.init) {
    // Forward --vault-name from the InstallOpts when set so `parachute setup`
    // (and any future programmatic caller) can pre-answer the name prompt.
    const initCmd =
      short === "vault" && opts.vaultName
        ? [...spec.init, "--vault-name", opts.vaultName]
        : spec.init;
    log(`Running ${initCmd.join(" ")}…`);
    const initCode = await runner(initCmd);
    if (initCode !== 0) {
      log(`${initCmd.join(" ")} exited ${initCode}`);
      return initCode;
    }
  }

  // Hub-as-port-authority (#53): pick the service's port now and reflect it
  // in services.json. Pre-hub#206 the install path also wrote `PORT=<port>`
  // into the service's `.env`; post-#206 (option A) services.json is the
  // single source of truth — services follow the 4-tier resolvePort ladder
  // (services.json → service config → bare PORT env → compiled-in default,
  // per parachute-scribe#41 / parachute-agent#146 / parachute-agent#148 /
  // parachute-patterns#45), so the duplicate `.env` PORT was at best dead
  // weight and at worst a source of drift on re-install. Existing `.env`
  // PORT lines on operator machines stay where they are — harmless — and
  // future installs no longer touch them.
  const preInitEntry = findService(entryName, manifestPath);
  const probe = opts.portProbe ?? defaultPortProbe;
  const occupied = await collectOccupiedPorts(manifestPath, entryName, preInitEntry?.port, probe);
  const canonicalPort = spec.seedEntry?.().port ?? preInitEntry?.port;
  const portResult = assignServicePort({
    canonical: canonicalPort,
    occupied,
  });
  if (portResult.warning) {
    log(`⚠ ${portResult.warning}`);
  }

  // Find-or-seed the manifest entry. Re-read after the seed write so a silent
  // upsert failure (filesystem permission, races against an external writer)
  // surfaces as a loud log line instead of a phantom "registered" claim.
  // parachute-hub#44 reported notes not appearing in services.json on a fresh
  // bun 1.2.x install; the gate logic was already correct, but a verify-step
  // turns silent loss into something an operator can spot.
  let entry = findService(entryName, manifestPath);
  if (!entry && spec.seedEntry) {
    const seedBase = spec.seedEntry();
    // seedEntryFromManifest sets `name = manifest.manifestName`; for
    // third-party we override to `entryName` (= manifest.name) so the row
    // matches the lifecycle lookup key. First-party leaves it alone.
    const withName = seedBase.name === entryName ? seedBase : { ...seedBase, name: entryName };
    const seed =
      withName.port === portResult.port ? withName : { ...withName, port: portResult.port };
    upsertService(seed, manifestPath);
    entry = findService(entryName, manifestPath);
    if (entry) {
      log(
        `Seeded services.json entry for ${entryName} (placeholder; service's own boot will overwrite).`,
      );
    } else {
      log(
        `⚠ tried to seed services.json entry for ${entryName}, but the readback came back empty.`,
      );
      log(`  manifest path: ${manifestPath}`);
      log("  Re-run `parachute install` once the underlying issue is resolved.");
    }
  } else if (entry && entry.port !== portResult.port) {
    // init wrote an entry on the canonical port but the CLI assigned a
    // different one (collision). Reflect the CLI's choice so the hub and
    // status views stay consistent with the canonical-port assignment.
    upsertService({ ...entry, port: portResult.port }, manifestPath);
    entry = findService(entryName, manifestPath);
    log(
      `Updated services.json port to ${portResult.port} for ${entryName} (was ${preInitEntry?.port ?? "—"}).`,
    );
  }

  // Stamp installDir on the row. Lifecycle reads it back to find the
  // module's `.parachute/module.json` (third-party startCmd) and to spawn
  // with cwd. Done after seed/port-update so we cover all paths uniformly:
  // the service's own init may have written the row without installDir, and
  // the seed itself doesn't carry it (composeServiceSpec → seedEntry uses
  // the manifest, which doesn't know its own install location).
  if (entry && installDir) {
    const stamped = stampInstallDirOnRow({
      manifestName: entryName,
      installDir,
      servicesJsonPath: manifestPath,
    });
    if (stamped) entry = findService(entryName, manifestPath);
  }

  if (!entry) {
    log(
      `Installed, but no services.json entry for "${entryName}" yet. Run \`parachute status\` after the service has started.`,
    );
  } else {
    log(`✓ ${entryName} registered on port ${entry.port}`);
    if (!isCanonicalPort(entry.port)) {
      log(
        `⚠ port ${entry.port} is outside the canonical Parachute range (${CANONICAL_PORT_MIN}–${CANONICAL_PORT_MAX}); may conflict with other software.`,
      );
    }
  }

  // Auto-wire the vault↔scribe shared secret + SCRIBE_URL when both services
  // end up installed. Fires from either install order (scribe then vault, or
  // vault then scribe). Idempotent — preserves any pre-existing values in
  // vault .env. Restarts vault if it's running so the worker re-reads .env.
  if (spec.manifestName === "parachute-vault" || spec.manifestName === "parachute-scribe") {
    const vaultPresent = !!findService("parachute-vault", manifestPath);
    const scribePresent = !!findService("parachute-scribe", manifestPath);
    if (vaultPresent && scribePresent) {
      const autoWireOpts: Parameters<typeof autoWireScribeAuth>[0] = { configDir, log };
      if (opts.randomToken) autoWireOpts.randomToken = opts.randomToken;
      await autoWireScribeAuth(autoWireOpts);
    }
  }

  // Scribe-only: prompt for transcription provider (or accept --scribe-provider
  // / --scribe-key). Has to land before auto-start so the very first scribe
  // boot reads the right provider — and inside the prompt we restart scribe
  // ourselves if it was already running, mirroring the auto-wire pattern.
  // Failure here doesn't fail the install: a flaky restart shouldn't undo a
  // successful `bun add`.
  if (short === "scribe") {
    const setupOpts: SetupScribeProviderOpts = { configDir, log };
    if (opts.scribeProvider) setupOpts.preselectProvider = opts.scribeProvider;
    if (opts.scribeKey) setupOpts.preselectKey = opts.scribeKey;
    if (opts.scribeAvailability) setupOpts.availability = opts.scribeAvailability;
    await setupScribeProvider(setupOpts);
  }

  const notice = migrateNotice(configDir, now());
  if (notice) log(notice);

  // Auto-start: vault and notes' inits historically left a daemon running, but
  // scribe (and any service without a daemon-launching init) didn't — so
  // launch-day `install scribe` ended with a silent install and the user
  // wondering why nothing happened. Always end with the daemon running unless
  // the caller opted out (CI / piped scripts). Idempotent: if the service is
  // already up, lifecycle.start no-ops via the existing PID-file check.
  if (!opts.noStart) {
    const startService =
      opts.startService ??
      ((short: string) => lifecycleStart(short, { manifestPath, configDir, log }));
    const startCode = await startService(short);
    if (startCode !== 0) {
      log(`⚠ ${short} didn't start cleanly. Run manually: parachute start ${short}`);
    }
  }

  // Per-service install footer — canonical next-step URLs and configuration
  // hints. Vault prints its own (richer) footer from `parachute-vault init`
  // (PR #166), so the spec leaves vault out and we don't double up here.
  const footer = spec.postInstallFooter?.();
  if (footer) {
    for (const line of footer) log(line);
  }

  // Final registration check — the service may have written its own
  // authoritative entry during init or first boot, replacing the seed (or
  // filling a gap when the service had no seedEntry). Re-read at exit so the
  // last line of the install always reflects ground truth, not an early
  // snapshot. Surfaced by parachute-hub#44 — defensive logging that turns a
  // missing entry into a visible failure rather than a silent one.
  let finalEntry = findService(entryName, manifestPath);
  // Re-stamp installDir if the service's first boot rewrote the row without
  // it, AND refresh the on-disk well-known so the inspection artifact
  // tracks the post-boot row. Lifecycle commands beyond install
  // (start/stop/restart/logs) need installDir present; we own this field,
  // services don't have to know it exists. The well-known regen mirrors
  // what the API install path does (`runInstall` in api-modules-ops.ts) so
  // CLI + API installs leave identical disk state — shared helper in
  // `post-install.ts`, hub#293.
  //
  // Well-known regen is gated on `wellKnownPath` resolving to a non-null
  // path. The production default (`manifestPath === SERVICES_MANIFEST_PATH`)
  // falls back to `WELL_KNOWN_PATH`; tests with a tempdir manifestPath get
  // `undefined` unless they opt in by passing `wellKnownPath` explicitly,
  // so the test suite never writes to the operator's real
  // `~/.parachute/well-known/`.
  const wellKnownPath =
    opts.wellKnownPath ?? (manifestPath === SERVICES_MANIFEST_PATH ? WELL_KNOWN_PATH : undefined);
  if (finalEntry && installDir) {
    if (wellKnownPath !== undefined) {
      await finalizeModuleInstall({
        manifestName: entryName,
        installDir,
        servicesJsonPath: manifestPath,
        canonicalOrigin: opts.wellKnownOrigin ?? "http://localhost:1939",
        wellKnownPath,
        log,
      });
    } else {
      stampInstallDirOnRow({
        manifestName: entryName,
        installDir,
        servicesJsonPath: manifestPath,
      });
    }
    finalEntry = findService(entryName, manifestPath);
  }
  if (!finalEntry) {
    log(
      `⚠ ${entryName} is not in services.json after install. \`parachute status\` won't see it. Re-run install or file a bug.`,
    );
  }

  return 0;
}
