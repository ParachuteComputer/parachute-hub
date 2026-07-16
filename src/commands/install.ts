import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { autoWireScribeAuth } from "../auto-wire.ts";
import { bunGlobalPrefixes, isLinked as defaultIsLinkedShared } from "../bun-link.ts";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { type ExposeState, readExposeState } from "../expose-state.ts";
import {
  HUB_DEFAULT_PORT,
  type KillFn,
  type PidOnPortFn,
  type SleepFn,
  defaultKill,
  defaultPidOnPort,
  defaultSleep,
  readHubPort,
} from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { resolveRootRedirectDetailed, setRootRedirect } from "../hub-settings.ts";
import { type HubUnitDeps, defaultHubUnitDeps, isHubUnitInstalled } from "../hub-unit.ts";
import {
  type ModuleManifest,
  ModuleManifestError,
  readModuleManifest,
  validateModuleManifest,
} from "../module-manifest.ts";
import { orphanAttributable } from "../orphan-attribution.ts";
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
  RETIRED_MODULES,
  type ServiceSpec,
  composeServiceSpec,
  isCanonicalPort,
  synthesizeManifestForKnownModule,
} from "../service-spec.ts";
import { findService, readManifest, upsertService } from "../services-manifest.ts";
import {
  type DisableStaleModuleUnitsOpts,
  type DisableStaleModuleUnitsResult,
  disableStaleModuleUnits as defaultDisableStaleModuleUnits,
} from "../stale-module-units.ts";
import { type OwnerProbeFn, defaultOwnerOfPid } from "../supervisor.ts";
import { WELL_KNOWN_PATH } from "../well-known.ts";
import { type LifecycleOpts, start as lifecycleStart } from "./lifecycle.ts";
import { migrateNotice } from "./migrate.ts";
import {
  type InteractiveAvailability,
  type SetupScribeProviderOpts,
  setupScribeProvider,
} from "./scribe-provider-interactive.ts";

export type Runner = (cmd: readonly string[]) => Promise<number>;

/**
 * Env var that defaults the install channel for `parachute install <svc>`
 * (hub#337). When set to `rc` or `latest`, becomes the default channel for
 * every `bun add -g <pkg>@<channel>` the install command composes. The
 * explicit `--channel` flag (and `--tag`) override the env var per call.
 *
 * Rationale: the canonical Render deploy ships the hub container from
 * `main` (which tracks the rc chain per governance rule 2). Without this
 * env var the supervisor's `/admin/modules` install API would still
 * resolve `@latest` for vault / surface / scribe — leaving a hub-on-rc
 * cluster bootstrapping its other modules on stable, which silently
 * fragments the cluster's version axis. Setting `PARACHUTE_INSTALL_CHANNEL=rc`
 * at the platform level cascades the rc-ness across every module install,
 * matching what an `npm i -g @openparachute/hub@rc` operator does on the
 * CLI side.
 *
 * Garbage values (`PARACHUTE_INSTALL_CHANNEL=banana`) fall back to `latest`
 * with a warning so an operator typo can't crash the install path.
 */
export const PARACHUTE_INSTALL_CHANNEL_ENV = "PARACHUTE_INSTALL_CHANNEL";

const VALID_INSTALL_CHANNELS = ["latest", "rc"] as const;
export type InstallChannel = (typeof VALID_INSTALL_CHANNELS)[number];

function isInstallChannel(v: string): v is InstallChannel {
  return (VALID_INSTALL_CHANNELS as readonly string[]).includes(v);
}

/**
 * Resolve the dist-tag to use for `bun add -g <pkg>@<tag>` in `parachute
 * install`. Precedence (highest → lowest):
 *
 *   1. explicit `--tag <name>` (programmatic — exact pin, may be a version)
 *   2. explicit `--channel rc|latest` (operator-facing dist-tag override)
 *   3. `PARACHUTE_INSTALL_CHANNEL` env var (platform-default cascade)
 *   4. `"latest"` fallback (the npm default; back-compat for existing operators)
 *
 * Garbage env-var values fall back to `"latest"` with a warning. The
 * `env` + `warn` knobs are test seams; production uses `process.env` +
 * `console.warn`.
 */
export function resolveInstallChannel(opts: {
  tag?: string;
  channel?: string;
  env?: NodeJS.ProcessEnv;
  warn?: (msg: string) => void;
}): string {
  if (opts.tag) return opts.tag;
  if (opts.channel) return opts.channel;
  const env = opts.env ?? process.env;
  const fromEnv = env[PARACHUTE_INSTALL_CHANNEL_ENV];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    if (isInstallChannel(fromEnv)) return fromEnv;
    const warn = opts.warn ?? ((msg: string) => console.warn(msg));
    warn(
      `[parachute install] ${PARACHUTE_INSTALL_CHANNEL_ENV}="${fromEnv}" is not a valid channel — expected one of ${VALID_INSTALL_CHANNELS.join(", ")}. Falling back to "latest".`,
    );
  }
  return "latest";
}

/**
 * Transition aliases for services that were renamed. Accepted for one
 * release cycle with a rename notice, then removed. `lens → notes`
 * exists because the frontend was briefly renamed Notes → Lens (Apr 19)
 * and then reverted (Apr 22) on launch eve. Anyone who ran `parachute
 * install lens` during the ~3-day window keeps working. Remove after
 * launch sinks in and `parachute install lens` has stopped appearing
 * in support threads.
 *
 */
const SERVICE_ALIASES: Record<string, string> = {
  lens: "notes",
};

/**
 * Former first-party shorts that were RETIRED from the registries (not
 * renamed — no alias target). Without this guard the bare short would fall
 * through resolveInstallTarget's "anything else is npm" arm and `bun add -g`
 * an UNRELATED npm package that happens to share the name (`runner` is a
 * real, non-Parachute package on npm). Install refuses with the message
 * instead.
 */
const AGENT_RETIRED_MESSAGE =
  "parachute-agent was retired from the hub on 2026-07-15. " +
  "Parachute product development is focused on Vault and Surface.";

const RETIRED_INSTALL_SHORTS: Record<string, string> = {
  agent: AGENT_RETIRED_MESSAGE,
  channel:
    "parachute-channel (later parachute-agent) was retired from the hub on 2026-07-15. " +
    "Parachute product development is focused on Vault and Surface.",
  runner:
    "parachute-runner was retired from the hub's module registry on 2026-07-01 " +
    "(the module set of record is vault, hub, scribe, surface, app). " +
    "An existing install keeps running under `parachute serve`; to install it anyway, " +
    "pass the explicit npm package name (@openparachute/runner) or a local checkout path.",
};

const RETIRED_AGENT_PACKAGES = [
  "@openparachute/agent",
  "@openparachute/parachute-agent",
  "@openparachute/channel",
  "@openparachute/parachute-channel",
] as const;

function isRetiredAgentPackage(packageName: string): boolean {
  return RETIRED_AGENT_PACKAGES.some(
    (retired) => packageName === retired || packageName.startsWith(`${retired}@`),
  );
}

function isRetiredAgentManifest(manifest: ModuleManifest): boolean {
  if (RETIRED_MODULES[manifest.name] !== undefined) return true;
  if (manifest.manifestName && RETIRED_MODULES[manifest.manifestName] !== undefined) return true;
  return manifest.name === "claw" && manifest.paths[0] === "/claw";
}

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
   *
   * Precedence: `tag` > `channel` > `PARACHUTE_INSTALL_CHANNEL` env > `"latest"`.
   */
  tag?: string;
  /**
   * Operator-facing channel (`--channel rc|latest`, hub#337). Picks a npm
   * dist-tag for the `bun add -g <pkg>@<channel>` call. Wins over the
   * `PARACHUTE_INSTALL_CHANNEL` env var but loses to `tag` (which is the
   * programmatic-pin escape hatch — e.g. an exact version string). The
   * CLI argv parser rejects values outside `rc`/`latest` before this
   * point; the install command itself trusts the caller's input.
   */
  channel?: string;
  /**
   * Override `process.env` for channel resolution (test seam). Production
   * reads from `process.env`. Tests inject a deterministic object to
   * exercise the `PARACHUTE_INSTALL_CHANNEL` precedence + invalid-value
   * fallback without polluting the real environment.
   */
  envOverride?: NodeJS.ProcessEnv;
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
   * "Install the module, but don't create a first vault instance" (hub#168 — the
   * wizard-parity work for Aaron's 2026-05-28 directive: "always install the
   * vault module, but creating a vault should be optional").
   *
   * Default: false (today's behavior — install runs the service's `init` and
   * starts the daemon, which for vault auto-creates a `default` row).
   *
   * When true:
   *   - The `bun add -g <pkg>` step still runs (puts the binary on PATH).
   *   - `spec.init` is SKIPPED. For vault this means no `parachute-vault init`
   *     → no default-vault row is created from this code path.
   *   - `lifecycle.start` is SKIPPED. The supervisor/wizard owns spawning;
   *     starting vault here would trigger its server-side auto-init (which
   *     creates a `default` vault on first boot when `listVaults().length === 0`).
   *   - services.json is still seeded (`spec.seedEntry`) + installDir stamped
   *     so subsequent supervisor spawns find the module + module.json.
   *
   * Intended for `parachute init` — install the module so the wizard can offer
   * Create/Import/Skip without a follow-up bun-add round-trip, but defer
   * vault-instance creation to whichever path the wizard's vault step takes.
   * On the existing CLI surfaces (`parachute install vault`, `parachute setup`),
   * leave it false so today's behavior is unchanged.
   */
  noCreate?: boolean;
  /**
   * `parachute install vault --interactive` (#579 / #580 item 1): opt back into
   * the FULL interactive module setup — the service's own `spec.init` (vault's
   * vault-name prompt, "install as MCP in Claude Code?", "mint an API token?")
   * and, for vault, its self-registered standalone daemon.
   *
   * Default: false. The manual `parachute install <svc>` path is now LIGHT
   * (matching `parachute init`'s Step 2.5): install the package, seed/register
   * services.json, start under the supervisor, and print a short guidance block
   * pointing at the admin UI + the optional extras (`parachute-vault
   * mcp-install`, token minting in the UI). No interactive interview, no
   * vault-side daemon registration that would race the supervisor for :1940.
   *
   * The old "drag me through the full init" behavior is opt-in via this flag.
   * When `true` AND the spec ships an `init` command, install runs `spec.init`
   * as it did pre-#579. When `false` (the default) for a module whose `init`
   * would otherwise run an interview, install SKIPS `spec.init` (the
   * `noCreate`-equivalent quiet path) and emits the guidance block instead.
   *
   * Orthogonal to `noCreate` (which `parachute init` uses to ALSO skip the
   * post-install start). The light manual path still starts the module under
   * the supervisor; only the interactive interview is suppressed.
   */
  interactive?: boolean;
  /**
   * Test seam for the supervised-hub probe + admin-URL resolution that drive
   * the light-install guidance block. Production reads the real expose-state /
   * hub-port / hub-unit deps; tests inject deterministic values so the guidance
   * assertions don't depend on the operator's live box.
   */
  guidanceCtx?: {
    /** Is a hub unit installed (→ supervised box)? Defaults to the real probe. */
    hubUnitInstalled?: boolean;
    /** Hub-unit deps for the real `isHubUnitInstalled` probe. */
    hubUnitDeps?: HubUnitDeps;
    /** Live expose state (→ public admin URL). Defaults to `readExposeState()`. */
    exposeState?: ExposeState | undefined;
    /** Hub loopback port for the admin URL fallback. Defaults to `readHubPort()`. */
    hubPort?: number | undefined;
  };
  /**
   * Test seam for the install-time stale-unit sweep (#580 item 3). Production
   * wires `disableStaleModuleUnits` (the #522 migrate/teardown sweep, reused
   * verbatim — known-module shorts only, hub + cloudflared skipped, idempotent,
   * non-fatal). Tests inject a fake so no real launchctl/systemctl runs and the
   * sweep's invocation (and logged actions) can be asserted.
   *
   * The sweep fires only when a supervised hub is present (the same
   * `guidanceCtx.hubUnitInstalled` discriminant) and the module is being
   * started — a leftover standalone `parachute-<short>` unit (KeepAlive /
   * RunAtLoad) would otherwise keep an unsupervised module bound to the port,
   * crash-looping the supervisor's own child (the #580 field signature).
   */
  disableStaleModuleUnits?: (opts?: DisableStaleModuleUnitsOpts) => DisableStaleModuleUnitsResult;
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
   * Test seam for the install-time port-squatter naming (#590 item 2). When the
   * canonical port walk has to assign a fallback port because the canonical one
   * is held, this looks up the pid LISTENing on the canonical port so the
   * warning can name the holder (`pid 1234 (bun .../vault/src/server.ts)`) — the
   * same #581 `pidOnPort` / `ownerOfPid` seams the supervisor start-path uses,
   * reused (not duplicated). Detection-only — never kills. Production wires
   * `defaultPidOnPort` (`lsof -ti :<port>`); tests inject a deterministic stub.
   */
  pidOnPort?: PidOnPortFn;
  /**
   * Test seam for the install-time port-squatter naming (#590 item 2): the
   * best-effort command line of the squatting pid. Production wires
   * `defaultOwnerOfPid` (`ps -o command= -p <pid>`); tests inject a stub.
   */
  ownerOfPid?: OwnerProbeFn;
  /**
   * Test seam for the install-time canonical-port ADOPT-KILL (#609). When the
   * canonical port is held by an attributable prior instance of THE SAME module
   * (a surviving orphan child after `rm -rf ~/.parachute` + re-`init`), we
   * SIGTERM→SIGKILL it to reclaim the canonical port instead of walking to a
   * non-canonical fallback. Reuses the #601 `orphanAttributable` machinery in
   * per-module mode (marker = this install's `installDir`); a foreign /
   * unattributable holder is NEVER killed — it falls through to the #590
   * warn-and-walk path. Production wires `defaultKill` (`process.kill`); tests
   * inject a spy so no real process is signalled.
   */
  killPid?: KillFn;
  /**
   * Test seam for the grace delay between SIGTERM and the SIGKILL escalation in
   * the #609 adopt-kill. Production wires `defaultSleep`; tests inject a no-op
   * so the path runs instantly.
   */
  sleep?: SleepFn;
  /**
   * Test seam: ms to wait after SIGTERM before re-probing + escalating to
   * SIGKILL in the #609 adopt-kill. Default 1500ms (a listener-release grace);
   * tests pass 0.
   */
  reclaimDelayMs?: number;
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
  /**
   * Test seam for the `app`-only set-if-unset root-redirect write (hub-parity
   * P5). Production opens `openHubDb(hubDbPath(configDir))` fresh and closes
   * it after the write; passing this injects an already-open DB (e.g. a
   * tempdir `hub.db`) so a test never touches the real `~/.parachute/hub.db`.
   * Passing this ALSO opts a tempdir-manifestPath test INTO the write path —
   * mirrors `guidanceCtx`'s discriminant: without it, the production gate
   * (`manifestPath === SERVICES_MANIFEST_PATH`) skips the write entirely.
   */
  rootRedirectDb?: Database;
}

async function defaultRunner(cmd: readonly string[]): Promise<number> {
  // Inherit env (TMPDIR, BUN_INSTALL, PATH, HOME, PARACHUTE_*, etc.) — see
  // api-modules-ops.ts:defaultRun for the rationale. Same Bun.spawn-defaults-
  // to-empty-env bug; same one-line fix. See hub#349.
  const proc = Bun.spawn([...cmd], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  return await proc.exited;
}

// `bunGlobalPrefixes` + `defaultIsLinked` were extracted to `src/bun-link.ts`
// so the wizard's parallel install path (`api-modules-ops.ts:runInstall`) can
// reuse the same detection — the two paths diverging is the bug class hub#433
// fixed (smoke 2026-05-27, finding 1). `defaultIsLinkedShared` is imported at
// module scope; alias kept for the in-function local-shadow convention below.
const defaultIsLinked = defaultIsLinkedShared;

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

/**
 * Adopt-kill an ATTRIBUTABLE orphan holding the canonical port (#609). The
 * caller has ALREADY confirmed attribution (per-module marker) — this is purely
 * the signal sequence, mirroring the supervisor's `adoptKillOrphanOnPort`:
 * SIGTERM, a listener-release grace, then SIGKILL only if the SAME pid still
 * holds the SAME port. Best-effort: a kill that doesn't free the port degrades
 * to the normal warn-and-walk path (the subsequent `collectOccupiedPorts` still
 * sees the port held and `assignServicePort` walks).
 *
 * The re-probe before SIGKILL is deliberately NOT re-attributed: we already
 * attributed `holder` to this module, and only escalate if that exact pid still
 * holds the port (the same accepted, vanishingly-small TOCTOU window the
 * supervisor + migrate sweep carry).
 */
async function adoptKillOnPort(args: {
  port: number;
  holder: number;
  kill: KillFn;
  sleep: SleepFn;
  pidOnPort: PidOnPortFn;
  delayMs: number;
  log: (line: string) => void;
}): Promise<void> {
  const { port, holder, kill, sleep, pidOnPort, delayMs, log } = args;
  try {
    kill(holder, "SIGTERM");
  } catch {
    // ESRCH (already gone) / EPERM (can't signal) — nothing more to do; the
    // re-probe + walk path handles a still-held port.
    return;
  }
  await sleep(delayMs);
  if (pidOnPort(port) === holder) {
    try {
      kill(holder, "SIGKILL");
      log(`  pid ${holder} did not release ${port} on SIGTERM; escalated to SIGKILL.`);
    } catch {
      // Already gone / can't signal — best-effort; fall through to the walk.
    }
  } else {
    log(`  reclaimed canonical port ${port} (pid ${holder} released it).`);
  }
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
 *   - **known**: vault / scribe / agent / surface have retired their FALLBACK
 *     entries (runner had too, before its 2026-07-01 registry removal).
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

  // Retired shorts refuse BEFORE the npm fallback: `install runner` must not
  // `bun add -g` npm's unrelated `runner` package. Explicit package names /
  // paths still pass through the arms below.
  const retiredMessage = RETIRED_INSTALL_SHORTS[candidate];
  if (retiredMessage !== undefined) {
    log(`✗ ${retiredMessage}`);
    return null;
  }

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
    if (isRetiredAgentPackage(packageName)) {
      log(`✗ ${AGENT_RETIRED_MESSAGE}`);
      return null;
    }
    return { kind: "local-path", absPath: input, packageName };
  }

  // Anything else is treated as an npm package (bare or @scope/name). The
  // module.json contract gates this — third-party packages without a
  // manifest fail post-install with a clear error, not silently.
  if (isRetiredAgentPackage(input)) {
    log(`✗ ${AGENT_RETIRED_MESSAGE}`);
    return null;
  }
  return { kind: "npm", packageName: input };
}

/**
 * Build the LifecycleOpts the install auto-start uses (hub#573).
 *
 * The auto-start MUST thread the SAME supervisor + migrate-offer opts the
 * production CLI dispatch passes for `parachute start <svc>` (cli.ts:
 * `supervisor: {}` + `migrateOffer: { enabled: true }`). Without them, `start`
 * resolved `unitInstalled` to its omitted-supervisor default of `false` and
 * `migrateOffer.enabled` to `false` — so the auto-start ALWAYS took the no-unit
 * path, printed "No supervised hub unit is installed. Run `parachute migrate
 * --to-supervised`…", and returned non-zero → the "⚠ didn't start cleanly"
 * warning. Meanwhile `parachute migrate` (which DOES run the real
 * `isHubUnitInstalled` probe + /health) reported the unit already installed +
 * healthy: the two paths disagreed because only `migrate` opted into real
 * detection. `supervisor: {}` makes the auto-start run the same probe;
 * `migrateOffer: { enabled: true }` makes it offer the cutover on a genuinely-
 * unmigrated box instead of dumping a bare error mid-install.
 *
 * Exported so the convergence is unit-testable without driving a real start.
 */
export function defaultStartLifecycleOpts(ctx: {
  manifestPath: string;
  configDir: string;
  log: (line: string) => void;
}): LifecycleOpts {
  return {
    manifestPath: ctx.manifestPath,
    configDir: ctx.configDir,
    log: ctx.log,
    supervisor: {},
    migrateOffer: { enabled: true },
  };
}

/**
 * Read the expose-state, swallowing a malformed-file error to undefined so the
 * guidance block degrades to the loopback admin URL instead of throwing mid-
 * install. Mirrors init's tolerant read of the same file.
 */
function safeReadExposeState(): ExposeState | undefined {
  try {
    return readExposeState();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the canonical admin URL the light-install guidance points at — the
 * SAME resolution `parachute init` uses (`init.ts:resolveAdminUrl`): the live
 * expose-state public FQDN when the hub is exposed, otherwise the loopback
 * `http://127.0.0.1:<port>/admin/`. Kept as a thin local copy (rather than
 * importing init.ts) so the install command doesn't pull in the wizard module
 * graph; the shape is asserted against init's in tests.
 */
function resolveGuidanceAdminUrl(
  exposeState: ExposeState | undefined,
  hubPort: number | undefined,
): string {
  if (exposeState?.canonicalFqdn) {
    return `https://${exposeState.canonicalFqdn}/admin/`;
  }
  return `http://127.0.0.1:${hubPort ?? HUB_DEFAULT_PORT}/admin/`;
}

/**
 * The post-install guidance block for the LIGHT manual install path (#579).
 *
 * Replaces the old interactive interview ("name your vault / install MCP / mint
 * a token") with a short pointer to where the operator manages + creates vaults
 * (the admin UI) plus one-liners for the optional extras they used to be dragged
 * through up front. Aaron's framing: "I just wanna install vault and then I'm
 * managing it through the UI" — the install confirms the module is up and tells
 * them where to go next, no token minted, no MCP wired, until they ask.
 *
 * Returns an empty array for modules that don't carry the interactive-init
 * footprint (so the generic `postInstallFooter` stays the surface for those).
 *
 * VAULT-ONLY for now, intentionally (N4). Vault is the only SERVICE_SPECS module
 * that ships an interactive `spec.init` today, so it's the only one whose light
 * path drops an interview that needs replacing with guidance. When a FUTURE
 * module ships its own `spec.init` (and thus takes the light-path skip), add its
 * guidance arm HERE — or, if the per-module copy starts to diverge meaningfully,
 * lift the guidance text onto the ServiceSpec shape (e.g. a
 * `lightInstallGuidance?: (adminUrl) => string[]` extra) so each module owns its
 * own next-steps block instead of this central switch. The empty-array fallback
 * keeps every other module silent here regardless.
 */
export function buildLightInstallGuidance(short: string, adminUrl: string): string[] {
  if (short === "vault") {
    return [
      "",
      "Vault is installed and running under the hub supervisor.",
      "Manage + create vaults in the admin UI:",
      `  ${adminUrl}`,
      "",
      "Optional, when you want them (not needed to start):",
      "  • Connect a vault to Claude Code:  parachute-vault mcp-install",
      "  • Mint an API token for other MCP clients: do it from the admin UI (Tokens).",
      "",
      "Run the full interactive setup instead with: parachute install vault --interactive",
    ];
  }
  return [];
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
    // Channel resolution (hub#337): `--tag` > `--channel` > env > "latest".
    // Local-path installs always pass the absolute path through verbatim
    // (no channel applies — we're installing from the filesystem, not npm).
    let addSpec: string;
    if (target.kind === "local-path") {
      addSpec = target.absPath;
    } else {
      const resolveOpts: Parameters<typeof resolveInstallChannel>[0] = {
        warn: (msg) => log(`⚠ ${msg}`),
      };
      if (opts.tag !== undefined) resolveOpts.tag = opts.tag;
      if (opts.channel !== undefined) resolveOpts.channel = opts.channel;
      if (opts.envOverride !== undefined) resolveOpts.env = opts.envOverride;
      const channel = resolveInstallChannel(resolveOpts);
      // Suppress `@latest` from the displayed/composed spec when nothing
      // was explicitly requested — bun resolves bare names to @latest
      // anyway, and keeping the spec bare preserves byte-identical
      // back-compat with pre-hub#337 logs ("Installing @openparachute/vault…"
      // not "Installing @openparachute/vault@latest…"). Any explicit
      // tag/channel/env value still flows through.
      const explicit = opts.tag !== undefined || opts.channel !== undefined;
      const envSet =
        opts.envOverride !== undefined
          ? typeof opts.envOverride[PARACHUTE_INSTALL_CHANNEL_ENV] === "string" &&
            opts.envOverride[PARACHUTE_INSTALL_CHANNEL_ENV] !== ""
          : typeof process.env[PARACHUTE_INSTALL_CHANNEL_ENV] === "string" &&
            process.env[PARACHUTE_INSTALL_CHANNEL_ENV] !== "";
      addSpec = explicit || envSet ? `${target.packageName}@${channel}` : target.packageName;
    }
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
  // `docs/contracts/module-json-extensibility.md`.
  const installDir = resolveInstallDir(target, findGlobalInstall);
  const installedManifest = await readInstalledManifest(target, installDir, {
    readManifest,
    log,
  });
  if (installedManifest === "error") return 1;
  if (installedManifest && isRetiredAgentManifest(installedManifest)) {
    log(`✗ ${target.packageName}: ${AGENT_RETIRED_MESSAGE}`);
    return 1;
  }

  let manifest: ModuleManifest;
  let extras: FirstPartyExtras | undefined;
  if (target.kind === "first-party") {
    manifest = installedManifest ?? target.fallback.manifest;
    extras = target.fallback.extras;
  } else if (target.kind === "known-module") {
    // KNOWN_MODULES shorts (vault / scribe / surface) carry no vendored
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
        "  Authors: see parachute-hub/docs/contracts/module-json-extensibility.md for the contract.",
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

  // Whether to run the module's interactive `spec.init` (#579 / #580 item 1).
  //
  // The manual `parachute install <svc>` path is now LIGHT by default: we do
  // NOT drag the operator through `spec.init`'s interview (for vault: vault-name
  // prompt, "install as MCP?", "mint a token?", and a self-registered standalone
  // daemon that would race the supervisor for :1940). The operator installs the
  // module and manages it from the admin UI. `spec.init` runs ONLY when the
  // caller explicitly opts back in with `--interactive` (and isn't in the
  // `noCreate` quiet path the wizard uses). Modules without a `spec.init` are
  // unaffected — there's no interview to suppress.
  const runInteractiveInit = spec.init !== undefined && opts.interactive === true && !opts.noCreate;
  if (runInteractiveInit && spec.init) {
    // Reviewer surprise 2 / #580: the interactive path runs the module's OWN
    // init, which (for vault today) registers a standalone platform daemon
    // (launchd KeepAlive / systemd Restart=always). On a SUPERVISED hub that
    // daemon races the supervisor for the module's port — the exact #580
    // EADDRINUSE-crash-loop condition the light path avoids by not running init.
    // Warn so an operator who reaches for --interactive on a supervised box
    // knows to pass the daemon-off flag (or prefer the light default).
    const supervisedForWarn =
      opts.guidanceCtx?.hubUnitInstalled ??
      (opts.guidanceCtx !== undefined || manifestPath === SERVICES_MANIFEST_PATH
        ? isHubUnitInstalled(opts.guidanceCtx?.hubUnitDeps ?? defaultHubUnitDeps)
        : false);
    if (supervisedForWarn) {
      log(
        `⚠ --interactive runs ${short}'s own setup, which may register a standalone daemon. On a supervised hub that daemon races the supervisor for ${short}'s port (#580). Prefer the light default, or pass --no-autostart through to ${short}'s init.`,
      );
    }
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
  } else if (spec.init && opts.noCreate) {
    log(`(skipping ${spec.init.join(" ")} — --no-create: module installed, no instance created)`);
  } else if (spec.init) {
    // Light path: the module ships an interactive init but the operator didn't
    // ask for it. Skip the interview; the guidance block at the end of install
    // tells them where to manage + create instances. The supervisor (started
    // below) owns the lifecycle, so vault's own daemon registration is
    // deliberately NOT triggered here — that's the :1940 race #580 fixed.
    log(
      `(skipping ${spec.init.join(" ")} — manage ${short} from the admin UI; re-run with --interactive for the full setup)`,
    );
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
  const pidOnPort = opts.pidOnPort ?? defaultPidOnPort;
  const ownerOfPid = opts.ownerOfPid ?? defaultOwnerOfPid;
  const canonicalPort = spec.seedEntry?.().port ?? preInitEntry?.port;

  // #609 wipe-recovery adopt-kill: BEFORE assigning, if the canonical port is
  // held by an attributable prior instance of THE SAME module (the classic
  // `rm -rf ~/.parachute` + re-`init` case — the supervised vault child keeps
  // running on :1940 and the fresh install would otherwise port-walk to 1944),
  // reclaim the port by adopt-killing the orphan rather than walking. Reuses the
  // #601 `orphanAttributable` machinery in PER-MODULE mode (marker = THIS
  // install's installDir, the same module-specific marker the supervisor's
  // crash-restart path uses) so a FOREIGN / sibling-module / operator process is
  // NEVER killed — it falls through to the #590 warn-and-walk path below.
  // Detection + module-specific attribution only; the kill is gated hard.
  // Gate the probe on the canonical port actually being OCCUPIED — when it's
  // free there's nothing to reclaim, and probing pid would be wasted work (and
  // a false "I looked at the port" signal). `probe` is the same TCP listen probe
  // `collectOccupiedPorts` uses below; a services.json row on the canonical port
  // also counts as occupied (a prior install's lingering entry).
  const canonicalOccupied =
    canonicalPort !== undefined &&
    (preInitEntry?.port === canonicalPort ||
      (await (async () => {
        try {
          return await probe(canonicalPort);
        } catch {
          return false;
        }
      })()));
  if (canonicalPort !== undefined && installDir && canonicalOccupied) {
    const holder = pidOnPort(canonicalPort);
    if (holder !== undefined && holder !== process.pid) {
      const { attributable, cmdline } = orphanAttributable({
        orphan: holder,
        // No recorded pid to trust here — a wiped services.json carries none —
        // so attribution rides entirely on the per-module cmdline marker.
        recordedPid: undefined,
        short,
        startCmdHint: undefined,
        ownerOfPid,
        // Per-module marker = installDir (e.g. `~/.parachute/vault/`); a prior
        // instance of this module was launched from there, so its `ps` cmdline
        // carries it. NOT the broad `parachute` marker — that would let a
        // sibling module's orphan on this port be (wrongly) adopted.
        moduleMarker: installDir,
      });
      if (attributable) {
        log(
          `Canonical port ${canonicalPort} is held by an attributable prior ${short} instance (pid ${holder}${cmdline ? `, ${cmdline}` : ""}) — reclaiming it (adopt-kill) instead of walking to a fallback (#609).`,
        );
        await adoptKillOnPort({
          port: canonicalPort,
          holder,
          kill: opts.killPid ?? defaultKill,
          sleep: opts.sleep ?? defaultSleep,
          pidOnPort,
          delayMs: opts.reclaimDelayMs ?? 1500,
          log,
        });
      }
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
  //
  // collectOccupiedPorts runs AFTER the #609 adopt-kill above so a reclaimed
  // canonical port is seen as free and the assignment lands on it (no walk).
  const occupied = await collectOccupiedPorts(manifestPath, entryName, preInitEntry?.port, probe);
  const portResult = assignServicePort({
    canonical: canonicalPort,
    occupied,
  });
  if (portResult.warning) {
    log(`⚠ ${portResult.warning}`);
    // #590 item 2: the canonical port was held by a NON-attributable holder (the
    // #609 adopt-kill above already reclaimed an attributable same-module
    // orphan), so we walked to a fallback. Name the squatter — the supervisor
    // start-path does this post-#581; do it here at install-time too. Reuse the
    // #581 pidOnPort / ownerOfPid seams (detection only; never kill). When the
    // holder is a foreign pid (not one of OUR rows — which is the common case
    // when a stale pre-supervisor daemon is squatting), surface its pid +
    // command line + a hint.
    if (canonicalPort !== undefined && portResult.source !== "canonical") {
      const holder = pidOnPort(canonicalPort);
      if (holder !== undefined) {
        const cmdline = ownerOfPid(holder);
        const who = cmdline ? `pid ${holder} (${cmdline})` : `pid ${holder}`;
        log(`  canonical port ${canonicalPort} is held by ${who}.`);
        log(
          `  This may be a stale pre-supervisor daemon. If so, stop it (kill ${holder}) and re-run \`parachute install ${entryName}\` to reclaim the canonical port.`,
        );
      }
    }
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

  // Install-time stale-unit sweep (#580 item 3 / #522 part 2). Before we start
  // the module under the supervisor, disable any leftover STANDALONE per-module
  // autostart unit (a pre-supervisor `parachute-<short>.service` with
  // Restart=always, or a `computer.parachute.<short>` LaunchAgent with
  // KeepAlive). Such a unit keeps RESPAWNING an unsupervised module that binds
  // the module's port; the supervised child then EADDRINUSE-crash-loops and
  // lands `crashed` — the recurring field signature in #580 / #522. Reuses the
  // exact #522 migrate/teardown sweep (`disableStaleModuleUnits`): known-module
  // shorts only, hub + cloudflared explicitly skipped, idempotent (already-
  // disabled/absent = silent no-op), non-fatal (a failed disable warns +
  // continues). Gated on a supervised hub being present — on a non-supervised
  // box the per-module unit IS the legitimate lifecycle and we must not touch
  // it. Only runs on the start path (skipped under --no-start / --no-create).
  const willStart = !opts.noStart && !opts.noCreate;
  if (willStart) {
    const gctx = opts.guidanceCtx;
    const sweepAllowed =
      opts.disableStaleModuleUnits !== undefined || manifestPath === SERVICES_MANIFEST_PATH;
    const supervisedForSweep =
      gctx?.hubUnitInstalled ?? isHubUnitInstalled(gctx?.hubUnitDeps ?? defaultHubUnitDeps);
    if (sweepAllowed && supervisedForSweep) {
      const sweep = opts.disableStaleModuleUnits ?? defaultDisableStaleModuleUnits;
      const result = sweep({ log: (l) => log(l) });
      const disabled = result.actions.filter((a) => a.result === "disabled");
      if (disabled.length > 0) {
        log(
          `Swept ${disabled.length} stale per-module autostart unit(s) so the supervisor owns the port(s): ${disabled
            .map((a) => a.unit)
            .join(", ")}.`,
        );
      }
    }
  }

  // Auto-start: vault and notes' inits historically left a daemon running, but
  // scribe (and any service without a daemon-launching init) didn't — so
  // launch-day `install scribe` ended with a silent install and the user
  // wondering why nothing happened. Always end with the daemon running unless
  // the caller opted out (CI / piped scripts). Idempotent: if the service is
  // already up, lifecycle.start no-ops via the existing PID-file check.
  //
  // `noCreate` (hub#168) also suppresses auto-start: starting vault would
  // trigger its server-side first-boot auto-init (creating a default vault),
  // which is exactly what --no-create is supposed to defer.
  if (!opts.noStart && !opts.noCreate) {
    const startService =
      opts.startService ??
      ((short: string) =>
        lifecycleStart(short, defaultStartLifecycleOpts({ manifestPath, configDir, log })));
    const startCode = await startService(short);
    if (startCode !== 0) {
      log(`⚠ ${short} didn't start cleanly. Run manually: parachute start ${short}`);
    }
  }

  // App-only: default the hub's bare `/` redirect to the app's front door on
  // first install (hub-parity P5, 2026-07-11) — SET-IF-UNSET ONLY, never
  // clobbering an operator's existing choice (`parachute hub
  // set-root-redirect` or the admin SPA PUT both still win on any later run,
  // and either can change it back). "Unset" means the resolved redirect is
  // still the built-in `/admin` DEFAULT — i.e. NEITHER the DB row NOR the
  // `PARACHUTE_HUB_ROOT_REDIRECT` env var (container deploys pin their landing
  // page there) has set it. Gating on `getRootRedirect(db) === null` would
  // miss the env tier and silently override an env-configured operator, since
  // the DB row we'd write wins over env on read (`resolveRootRedirectDetailed`
  // is DB-first). Gated on the same production-vs-test discriminant the
  // guidance probe below uses: a test driving install against a tempdir
  // manifestPath never opens the real `~/.parachute/hub.db` unless it opts in
  // via `opts.rootRedirectDb`.
  if (short === "app") {
    const dbProbeAllowed =
      opts.rootRedirectDb !== undefined || manifestPath === SERVICES_MANIFEST_PATH;
    if (dbProbeAllowed) {
      const db = opts.rootRedirectDb ?? openHubDb(hubDbPath(configDir));
      try {
        if (resolveRootRedirectDetailed(db).source === "default") {
          setRootRedirect(db, "/app/");
          log("✓ The hub's front page (`/`) now opens the app at /app/.");
          log("  Change it any time: `parachute hub set-root-redirect <path>` or the admin SPA.");
        }
      } finally {
        if (!opts.rootRedirectDb) db.close();
      }
    }
  }

  // Per-service install footer — canonical next-step URLs and configuration
  // hints. Vault prints its own (richer) footer from `parachute-vault init`
  // (PR #166), so the spec leaves vault out and we don't double up here.
  const footer = spec.postInstallFooter?.();
  if (footer) {
    for (const line of footer) log(line);
  }

  // Light-install guidance block (#579 / #580 item 1). When we suppressed the
  // module's interactive init (light path: it ships an init, the operator
  // didn't pass --interactive, and this isn't the wizard's noCreate path),
  // replace the absent interview with a short pointer to the admin UI + the
  // optional extras. Skipped for --interactive (the service's own footer
  // covers it) and for noCreate (the wizard prints its own admin URL).
  //
  // INFORMATIONAL, independent of the start path (N3): this block is *guidance*,
  // not an action, so it deliberately does NOT gate on `willStart` /
  // `!opts.noStart` the way the stale-unit sweep above does. Even under
  // `--no-start` (CI / piped installs) the operator still benefits from "here's
  // where to manage it once it's up" — the admin URL + extras are equally true
  // whether or not THIS invocation started the daemon.
  //
  // The supervised-hub probe + admin-URL resolution touch real on-disk state
  // (the hub plist / expose-state / hub-port file). Gate the production probe
  // on `manifestPath === SERVICES_MANIFEST_PATH` — the same isolation gate the
  // well-known regen uses — so a test driving install against a tempdir
  // manifestPath never reads the operator's real `~/.parachute`. Tests opt into
  // the guidance assertions by passing `guidanceCtx` explicitly.
  const guidanceProbeAllowed =
    opts.guidanceCtx !== undefined || manifestPath === SERVICES_MANIFEST_PATH;
  if (spec.init && !opts.interactive && !opts.noCreate && guidanceProbeAllowed) {
    const gctx = opts.guidanceCtx;
    const supervised =
      gctx?.hubUnitInstalled ?? isHubUnitInstalled(gctx?.hubUnitDeps ?? defaultHubUnitDeps);
    // Only emit the "managed under the supervisor" guidance when there's a
    // supervised hub to manage it through. On a non-supervised box (no hub
    // unit) the admin UI may not be reachable, so we stay quiet and let the
    // generic install output stand — the operator can run --interactive.
    if (supervised) {
      const exposeState = gctx && "exposeState" in gctx ? gctx.exposeState : safeReadExposeState();
      const hubPort = gctx && "hubPort" in gctx ? gctx.hubPort : readHubPort(configDir);
      const adminUrl = resolveGuidanceAdminUrl(exposeState, hubPort);
      for (const line of buildLightInstallGuidance(short, adminUrl)) log(line);
    }
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
