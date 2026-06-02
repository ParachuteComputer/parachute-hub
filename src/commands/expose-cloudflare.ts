import { spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_TUNNEL_NAME,
  cloudflaredPathsFor,
  deriveTunnelName,
  writeConfig,
} from "../cloudflare/config.ts";
import {
  type ConnectorServiceDeps,
  type InstallResult,
  type RemoveResult,
  installConnectorService,
  removeConnectorService,
} from "../cloudflare/connector-service.ts";
import {
  DEFAULT_CLOUDFLARED_HOME,
  cloudflaredInstallHint,
  isCloudflaredInstalled,
  isCloudflaredLoggedIn,
} from "../cloudflare/detect.ts";
import {
  CLOUDFLARED_STATE_PATH,
  type CloudflaredState,
  type CloudflaredTunnelRecord,
  clearCloudflaredState,
  findTunnelRecord,
  listTunnelRecords,
  readCloudflaredState,
  withTunnelRecord,
  withoutTunnelRecord,
  writeCloudflaredState,
} from "../cloudflare/state.ts";
import {
  CloudflaredError,
  type Tunnel,
  createTunnel,
  credentialsPath,
  findTunnelByName,
  routeDns,
} from "../cloudflare/tunnel.ts";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  EXPOSE_STATE_PATH,
  type ExposeState,
  clearExposeState,
  writeExposeState,
} from "../expose-state.ts";
import { HUB_DEFAULT_PORT, readHubPort } from "../hub-control.ts";
import { deriveHubOrigin } from "../hub-origin.ts";
import { HUB_UNIT_DEFAULT_PORT } from "../hub-unit.ts";
import { type AliveFn, defaultAlive } from "../process-state.ts";
import { readManifest } from "../services-manifest.ts";
import { type Runner, defaultRunner } from "../tailscale/run.ts";
import type { VaultAuthStatus } from "../vault/auth-status.ts";
import { printPublic2FAWarning } from "./expose-2fa-warning.ts";
import {
  type ExposeSupervisorOpts,
  type ResolvedExposeSupervisor,
  ensureHubUnitForExpose,
  resolveExposeSupervisor,
  restartHubDependentViaSupervisor,
} from "./expose-supervisor.ts";

const AUTH_DOC_URL =
  "https://github.com/ParachuteComputer/parachute-vault/blob/main/docs/auth-model.md";

/**
 * Tunnel-name validation. We mirror the conservative shape Cloudflare itself
 * uses for tunnel identifiers — alphanumerics, hyphens, underscores — and
 * keep it short enough to fit in a path segment without surprising the
 * filesystem (e.g. macOS encoded NFC quirks). Anything more permissive would
 * just push validation work onto the cloudflared binary.
 */
export function isValidTunnelName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name);
}

/**
 * Hostname validation — permissive by design. We reject the obviously broken
 * shapes (empty, missing dot, label containing `/` or whitespace) and let
 * Cloudflare's own validation catch the rest. Pre-checking against every
 * RFC 1123 corner would be overkill for a CLI flag that the user just typed.
 */
export function isValidHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  if (!h.includes(".")) return false;
  const labelRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
  return h.split(".").every((label) => labelRe.test(label));
}

export interface CloudflaredSpawner {
  spawn(cmd: readonly string[], logFile: string): number;
}

export const defaultCloudflaredSpawner: CloudflaredSpawner = {
  spawn(cmd, logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    // Inherit env so cloudflared sees HOME (where it reads ~/.cloudflared/),
    // PATH, etc. Bun.spawn defaults to empty env — see api-modules-ops.ts.
    const proc = Bun.spawn([...cmd], {
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    proc.unref();
    return proc.pid;
  },
};

export type KillFn = (pid: number, signal: NodeJS.Signals | number) => void;

const defaultKill: KillFn = (pid, signal) => {
  process.kill(pid, signal);
};

/**
 * Find the PIDs of every running `cloudflared` connector serving THIS tunnel.
 * "This tunnel" is identified by either the tunnel UUID or the config.yml path
 * appearing on the process command line — both are unique to Parachute's
 * connector for this tunnel, so we never touch an unrelated cloudflared the
 * operator may be running for a different tunnel.
 *
 * The motivating bug (hub#487): each `parachute expose public --cloudflare`
 * "reused the tunnel" but spawned a fresh connector (new pid) without killing
 * the prior ones, and the state file only tracked the most-recent pid. Orphan
 * connectors accumulated — multiple `cloudflared tunnel run` processes all
 * serving stale `config.yml` snapshots, so edge routing became nondeterministic
 * ("silent fails"). Sweeping by UUID/config-path catches the orphans that the
 * single-pid state record misses (prior runs that crashed mid-rewrite, or a
 * connector the operator started by hand for this tunnel).
 *
 * Injectable so tests assert the sweep without a live `pgrep`.
 */
export type ConnectorPidsFn = (tunnelUuid: string, configPath: string) => number[];

export const defaultConnectorPids: ConnectorPidsFn = (tunnelUuid, configPath) => {
  try {
    // `pgrep -fl cloudflared` lists "<pid> <full command line>" for every
    // process whose command line matches "cloudflared". We then filter to the
    // ones that name THIS tunnel (uuid or config path) so the kill is surgical.
    // macOS + Linux ship pgrep; Windows is out of scope (mirrors hub#287's lsof
    // assumption). Any failure → [] (caller falls back to state-tracked pid).
    const result = spawnSync("pgrep", ["-fl", "cloudflared"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return [];
    const selfPid = process.pid;
    const pids: number[] = [];
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const match = trimmed.match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number.parseInt(match[1]!, 10);
      const cmdline = match[2]!;
      if (!Number.isInteger(pid) || pid <= 0 || pid === selfPid) continue;
      // Surgical match: only connectors that name this tunnel's UUID or its
      // config path. A bare `cloudflared` (e.g. `--version`, `tunnel list`)
      // or a connector for a *different* tunnel won't match either token.
      if (cmdline.includes(tunnelUuid) || cmdline.includes(configPath)) {
        pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
};

/**
 * Resolve a hostname to its A/AAAA addresses. Returns [] when the name doesn't
 * resolve (NXDOMAIN, SERVFAIL, no records yet) — the signal the DNS
 * self-diagnosis keys on. Injectable so tests drive each case (unresolved /
 * Cloudflare / non-Cloudflare) deterministically.
 */
export type ResolveHostFn = (hostname: string) => Promise<string[]>;

export const defaultResolveHost: ResolveHostFn = async (hostname) => {
  try {
    // Bun.dns ships with the runtime; `node:dns/promises` is equally fine but
    // Bun.dns.lookup returns both families in one call. `all: true` gives every
    // record so a partially-propagated name still surfaces an address.
    const records = await Bun.dns.lookup(hostname, { family: 0 });
    return records.map((r) => r.address).filter((a) => typeof a === "string" && a.length > 0);
  } catch {
    return [];
  }
};

/**
 * Cloudflare's published anycast IPv4 ranges (the proxy edge). A proxied
 * (orange-cloud) record — which is what `cloudflared tunnel route dns` creates
 * — resolves to one of these. If the hostname resolves to something *outside*
 * these ranges, it's almost certainly shadowed: a Pages project, an A record,
 * or a grey-cloud CNAME pointing elsewhere. We keep the list to the v4 ranges
 * (the common case) and treat any IPv6 in Cloudflare's 2606:4700::/32 block as
 * Cloudflare too. Source: https://www.cloudflare.com/ips/ (stable for years).
 */
const CLOUDFLARE_V4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["173.245.48.0", 20],
  ["103.21.244.0", 22],
  ["103.22.200.0", 22],
  ["103.31.4.0", 22],
  ["141.101.64.0", 18],
  ["108.162.192.0", 18],
  ["190.93.240.0", 20],
  ["188.114.96.0", 20],
  ["197.234.240.0", 22],
  ["198.41.128.0", 17],
  ["162.158.0.0", 15],
  ["104.16.0.0", 13],
  ["104.24.0.0", 14],
  ["172.64.0.0", 13],
  ["131.0.72.0", 22],
];

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

/** True if any resolved address belongs to Cloudflare's edge. */
export function looksLikeCloudflare(addresses: readonly string[]): boolean {
  for (const addr of addresses) {
    // IPv6: Cloudflare's edge lives in 2606:4700::/32.
    if (addr.includes(":")) {
      if (addr.toLowerCase().startsWith("2606:4700")) return true;
      continue;
    }
    const ipInt = ipv4ToInt(addr);
    if (ipInt === undefined) continue;
    for (const [base, bits] of CLOUDFLARE_V4_RANGES) {
      const baseInt = ipv4ToInt(base);
      if (baseInt === undefined) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((ipInt & mask) === (baseInt & mask)) return true;
    }
  }
  return false;
}

export interface ExposeCloudflareOpts {
  runner?: Runner;
  spawner?: CloudflaredSpawner;
  alive?: AliveFn;
  kill?: KillFn;
  /**
   * Find every running cloudflared connector PID serving this tunnel (by UUID
   * or config-path match). Used to sweep orphan connectors before spawning a
   * fresh one (hub#487). Tests inject a stub; production uses
   * `defaultConnectorPids` (a filtered `pgrep -fl cloudflared`).
   */
  connectorPids?: ConnectorPidsFn;
  /**
   * Install/remove the reboot-persistent connector OS service (launchd on
   * macOS, systemd on Linux). Injectable so tests drive the install/remove
   * without touching real launchctl/systemctl or `~/Library/LaunchAgents`.
   * Defaults: the up-path installs (falls back to a transient `proc.unref()`
   * connector when the tool is absent); the off / legacy-sweep paths remove.
   * Tests inject fakes to assert the generated service file + command sequence.
   */
  installService?: (args: {
    tunnelName: string;
    configPath: string;
    logPath: string;
  }) => InstallResult;
  removeService?: (args: { tunnelName: string }) => RemoveResult;
  /**
   * Override the side-effect deps the default install/remove implementations
   * use (platform, getuid, fs, run). Only consulted when `installService` /
   * `removeService` aren't injected directly. Lets a test pin `platform` /
   * `getuid` while still exercising the real install/remove logic.
   */
  connectorServiceDeps?: ConnectorServiceDeps;
  /**
   * Resolve a hostname to its addresses, for the post-route DNS self-diagnosis
   * (hub#487). Returns the resolved IPs (empty when NXDOMAIN / not yet live).
   * Best-effort and non-fatal — a failure to resolve never blocks the expose.
   * Tests inject a stub; production uses `defaultResolveHost` (Bun DNS).
   */
  resolveHost?: ResolveHostFn;
  log?: (line: string) => void;
  manifestPath?: string;
  statePath?: string;
  /**
   * Path to `expose-state.json` — the shared cross-provider expose record the
   * Tailscale path also writes (`expose.ts`). Distinct from `statePath`
   * (cloudflared-state.json, the per-tunnel process record). The cloudflare
   * up-path writes this so downstream consumers (`resolveAdminUrl` in init,
   * `resolveHubOrigin` in lifecycle / auth) see the public URL instead of
   * loopback; the off-path clears it. Defaults to `EXPOSE_STATE_PATH`.
   */
  exposeStatePath?: string;
  /**
   * Tunnel name targeted by this invocation. The up-path defaults to a
   * per-hostname derived name (`deriveTunnelName(hostname)`) so each machine
   * gets its own tunnel and account-wide tunnels don't collide across boxes
   * (#491). Override to pin a specific name (e.g. multiple tunnels on one
   * box, #32). The off-path resolves the name from `cloudflared-state.json`
   * when omitted (it has no hostname to derive from).
   */
  tunnelName?: string;
  /**
   * Path to the cloudflared config.yml this invocation writes. Defaults to
   * the per-tunnel layout `~/.parachute/cloudflared/<tunnelName>/config.yml`.
   */
  configPath?: string;
  /**
   * Path to the log file the spawned cloudflared appends to. Defaults to
   * the per-tunnel layout `~/.parachute/cloudflared/<tunnelName>/cloudflared.log`.
   */
  logPath?: string;
  /** Override `~/.cloudflared` for tests and `$HOME`-free environments. */
  cloudflaredHome?: string;
  /**
   * Config root for hub PID / port / log files. Defaults to `~/.parachute`.
   * Threaded through so cloudflared's ingress target stays in sync with where
   * the hub actually bound.
   */
  configDir?: string;
  /**
   * Override the public hub origin (the `iss` claim baked into the OAuth
   * issuer). Mirrors the Tailscale path — when set, this URL is what the
   * hub advertises rather than the cloudflared hostname.
   */
  hubOrigin?: string;
  /**
   * Skip ensuring the hub unit. Tests flip this on and pre-seed
   * `<configDir>/hub/run/hub.port` so `readHubPort` can resolve the
   * cloudflared target without a live hub. Production always leaves this off so
   * the bringup ensures the hub unit is up.
   */
  skipHub?: boolean;
  now?: () => Date;
  /**
   * Override `~/.parachute/vault` for the 2FA-enrollment probe. Tests
   * point at a tmp dir; production omits and the probe defaults to the
   * resolved vault home. (#186)
   */
  vaultHome?: string;
  /**
   * Pre-computed vault auth status, primarily for tests. When set,
   * `printPublic2FAWarning` consults this instead of reading
   * `<vaultHome>/config.yaml` from disk. (#186)
   */
  vaultAuthStatus?: VaultAuthStatus;
  /**
   * Supervisor-path seams (design §4.3) — the ONLY runtime as of Phase 5b.
   * "ensure the hub" ensures the UNIT is up (not a detached spawn), and the
   * post-route vault restart drives the running Supervisor over the loopback
   * module-ops API (re-injecting the new public origin + firing the operator-
   * token / vault `.env` self-heal). The cloudflared CONNECTOR unit is
   * unchanged — it already installs/removes its own ManagedUnit
   * (`installConnectorService` / `removeConnectorService`), independent of the
   * hub's lifecycle.
   *
   * Production CLI dispatch passes `supervisor: {}` so the real
   * `isHubUnitInstalled` probe resolves the seams; tests inject the seams they
   * want to assert.
   */
  supervisor?: ExposeSupervisorOpts;
}

interface Resolved {
  runner: Runner;
  spawner: CloudflaredSpawner;
  alive: AliveFn;
  kill: KillFn;
  connectorPids: ConnectorPidsFn;
  installService: (args: {
    tunnelName: string;
    configPath: string;
    logPath: string;
  }) => InstallResult;
  removeService: (args: { tunnelName: string }) => RemoveResult;
  resolveHost: ResolveHostFn;
  log: (line: string) => void;
  manifestPath: string;
  statePath: string;
  exposeStatePath: string;
  tunnelName: string;
  configPath: string;
  logPath: string;
  cloudflaredHome: string;
  configDir: string;
  hubOrigin: string | undefined;
  skipHub: boolean;
  now: () => Date;
  vaultHome: string | undefined;
  vaultAuthStatus: VaultAuthStatus | undefined;
  sup: ResolvedExposeSupervisor;
}

/**
 * Resolve options into the fully-defaulted `Resolved` shape.
 *
 * `tunnelNameDefault` is the fallback tunnel name when the caller didn't pass
 * an explicit `opts.tunnelName`. The up-path passes `deriveTunnelName(hostname)`
 * so each machine/hostname gets its OWN dedicated tunnel (#491) — sharing one
 * account-wide tunnel across boxes collides their connectors. An explicit
 * `--tunnel-name` always wins (operators can override). The off-path has no
 * hostname to derive from, so it resolves the name from state before calling
 * in (see `exposeCloudflareOff`) and only relies on this default as a last
 * resort.
 */
function resolve(opts: ExposeCloudflareOpts, tunnelNameDefault: string): Resolved {
  const tunnelName = opts.tunnelName ?? tunnelNameDefault;
  const configDir = opts.configDir ?? CONFIG_DIR;
  // Derive per-tunnel config/log paths from the *resolved* configDir, not the
  // real `CONFIG_DIR`. When a test threads a tmp `configDir` but omits explicit
  // `configPath`/`logPath`, this keeps the derived files inside the tmp dir
  // instead of writing fixtures into the operator's real ~/.parachute.
  const paths = cloudflaredPathsFor(tunnelName, configDir);
  return {
    runner: opts.runner ?? defaultRunner,
    spawner: opts.spawner ?? defaultCloudflaredSpawner,
    alive: opts.alive ?? defaultAlive,
    kill: opts.kill ?? defaultKill,
    // Defaulting policy mirrors lifecycle's startReadyMs (hub#487): the real
    // implementations shell out (`pgrep`) / hit the network (DNS). When a test
    // injects a fake `spawner` but no explicit seam, fall back to inert stubs
    // (no orphans found; "resolves at Cloudflare" → no DNS warning) so suites
    // stay deterministic and offline. Production (no spawner override) always
    // gets the real `pgrep` sweep + DNS diagnosis.
    connectorPids:
      opts.connectorPids ?? (opts.spawner === undefined ? defaultConnectorPids : () => []),
    // Reboot-persistent connector seam. Defaulting policy mirrors
    // `connectorPids`/`resolveHost`: when a test injects a stub `spawner` (and
    // no explicit service seam), default to an inert "fallback" so existing
    // stub-spawner suites keep exercising the transient-spawn path without
    // touching real launchctl/systemctl. Production (no spawner override) gets
    // the real install/remove. An explicit `installService`/`removeService`
    // always wins; `connectorServiceDeps` lets a test pin platform/getuid
    // while running the real install/remove logic.
    installService:
      opts.installService ??
      (opts.spawner === undefined || opts.connectorServiceDeps !== undefined
        ? (args) =>
            installConnectorService({
              ...args,
              ...(opts.connectorServiceDeps !== undefined
                ? { deps: opts.connectorServiceDeps }
                : {}),
            })
        : () => ({
            outcome: "fallback",
            messages: [],
          })),
    removeService:
      opts.removeService ??
      (opts.spawner === undefined || opts.connectorServiceDeps !== undefined
        ? (args) =>
            removeConnectorService({
              ...args,
              ...(opts.connectorServiceDeps !== undefined
                ? { deps: opts.connectorServiceDeps }
                : {}),
            })
        : () => ({ removed: false, messages: [] })),
    resolveHost:
      opts.resolveHost ??
      (opts.spawner === undefined ? defaultResolveHost : async () => ["104.16.0.1"]),
    log: opts.log ?? ((line) => console.log(line)),
    manifestPath: opts.manifestPath ?? SERVICES_MANIFEST_PATH,
    statePath: opts.statePath ?? CLOUDFLARED_STATE_PATH,
    exposeStatePath: opts.exposeStatePath ?? EXPOSE_STATE_PATH,
    tunnelName,
    configPath: opts.configPath ?? paths.configPath,
    logPath: opts.logPath ?? paths.logPath,
    cloudflaredHome: opts.cloudflaredHome ?? DEFAULT_CLOUDFLARED_HOME,
    configDir,
    hubOrigin: opts.hubOrigin,
    skipHub: opts.skipHub ?? false,
    now: opts.now ?? (() => new Date()),
    vaultHome: opts.vaultHome,
    vaultAuthStatus: opts.vaultAuthStatus,
    sup: resolveExposeSupervisor(opts.supervisor),
  };
}

function printAuthGuidance(log: (line: string) => void, vaultUrl: string): void {
  log("");
  log("Security: your vault is auth-gated by default, and this exposure does not");
  log("change that. Anyone who hits the URL has to clear the auth gate before");
  log("they can read or write.");
  log("");
  log("Pick the path that matches how you'll reach it:");
  log("");
  log("  Humans (claude.ai / ChatGPT connectors, browser):");
  log("    parachute auth set-password         # set a STRONG owner password");
  log("    parachute auth 2fa enroll           # add a second factor (recommended)");
  log("    #  (or set 2FA up in the browser at /account/2fa for a scannable QR)");
  log("    then point your connector at:");
  log(`    ${vaultUrl}`);
  log("");
  log("  Scripts / machines (hub-issued JWT — set the owner password first):");
  log("    parachute auth mint-token --scope vault:<name>:read   # or :write");
  log("    Authorization: Bearer <hub-jwt>     # attach the printed token to every request");
  log("    (or: Admin → Vaults → Connect mints one and shows the header for you)");
  log("");
  log("The owner password gates both paths — browser sign-in and minting tokens.");
  log("Full auth reference:");
  log(`  ${AUTH_DOC_URL}`);
}

/**
 * Best-effort registrable-zone guess: the last two labels of the hostname
 * (`vault.example.com` → `example.com`, `gitcoin.parachute.computer` →
 * `parachute.computer`). This is a heuristic — multi-label public suffixes
 * (`foo.co.uk`) would guess `co.uk` — but it's only used to phrase the
 * `dig +short <zone> NS` remedy, where being off by a label is a harmless
 * nudge. We don't ship a full public-suffix list for one warning string.
 */
function guessZone(hostname: string): string {
  const labels = hostname.split(".").filter((l) => l.length > 0);
  if (labels.length <= 2) return hostname;
  return labels.slice(-2).join(".");
}

/**
 * Non-fatal post-route DNS diagnosis. Resolves `hostname` and warns when the
 * result looks wrong — see the call site for the two symptoms this addresses.
 * Never throws (resolveHost swallows its own errors) and never changes the
 * exit code; the worst case is no output.
 */
async function diagnoseDns(hostname: string, r: Resolved): Promise<void> {
  const zone = guessZone(hostname);
  const addresses = await r.resolveHost(hostname);
  if (addresses.length === 0) {
    r.log("");
    r.log(`⚠ DNS isn't live yet for ${hostname}.`);
    r.log(`  If ${zone} is a new Cloudflare zone, its nameservers may not be switched at your`);
    r.log("  registrar yet. Check with:");
    r.log(`    dig +short ${zone} NS          # should list *.ns.cloudflare.com`);
    r.log("  Propagation can take minutes to hours. The tunnel itself is up — the URLs below");
    r.log("  will start working once DNS resolves.");
    return;
  }
  if (!looksLikeCloudflare(addresses)) {
    r.log("");
    r.log(`⚠ ${hostname} resolves (${addresses.join(", ")}) but not to Cloudflare's edge.`);
    r.log(`  It may be shadowed by another DNS record or a Cloudflare Pages project on ${zone}.`);
    r.log("  Ensure it's a proxied (orange-cloud) CNAME to the tunnel — check");
    r.log(`  https://dash.cloudflare.com → DNS for ${zone}. A grey-cloud / A record / Pages`);
    r.log("  binding on this hostname will 404 the tunnel at the edge.");
  }
}

export async function exposeCloudflareUp(
  hostname: string,
  opts: ExposeCloudflareOpts = {},
): Promise<number> {
  // Default to a per-hostname dedicated tunnel (#491). An explicit
  // `--tunnel-name` still wins (handled inside `resolve`). Deriving from the
  // hostname keeps re-expose idempotent (same hostname → same name → reuse the
  // tunnel created last time) and stops two machines from colliding on the
  // single account-wide `"parachute"` tunnel.
  const r = resolve(opts, deriveTunnelName(hostname));

  if (!isValidTunnelName(r.tunnelName)) {
    r.log(
      `parachute expose public --cloudflare: --tunnel-name must be alphanumeric with -/_ (got "${r.tunnelName}").`,
    );
    return 1;
  }

  if (!isValidHostname(hostname)) {
    r.log(
      `parachute expose public --cloudflare: --domain must be a valid hostname (got "${hostname}").`,
    );
    r.log("Example: --domain vault.example.com");
    return 1;
  }

  if (!(await isCloudflaredInstalled(r.runner))) {
    r.log("cloudflared is not installed or not on PATH.");
    r.log("");
    r.log(cloudflaredInstallHint());
    r.log("");
    r.log("After install, run `cloudflared tunnel login` to authenticate,");
    r.log(`then re-run: parachute expose public --cloudflare --domain ${hostname}`);
    return 1;
  }

  if (!isCloudflaredLoggedIn(r.cloudflaredHome)) {
    r.log("cloudflared is not logged in.");
    r.log("");
    r.log("Run:  cloudflared tunnel login");
    r.log("");
    r.log("That opens a browser where you pick the domain you've added to Cloudflare.");
    r.log("If the domain isn't there yet, add it at https://dash.cloudflare.com → Add site");
    r.log("(Namecheap / Porkbun / any registrar is fine — Cloudflare just manages DNS).");
    r.log("");
    r.log(`After login, re-run: parachute expose public --cloudflare --domain ${hostname}`);
    return 1;
  }

  const manifest = readManifest(r.manifestPath);
  const vaultEntry = manifest.services.find((s) => s.name === "parachute-vault");
  if (!vaultEntry) {
    r.log("parachute-vault is not installed; nothing to route.");
    r.log("Run: parachute install vault");
    return 1;
  }

  // Resolve the public hub origin before spawning the hub server — it gets
  // baked into the OAuth `iss` claim via the `--issuer` flag. For Cloudflare
  // ingress the canonical origin is the user-supplied hostname (mirrors the
  // Tailscale Funnel path which uses the tailnet FQDN). Falling back to the
  // request origin would put `http://127.0.0.1:<port>` in tokens, which any
  // client following RFC 8414 would reject.
  const canonicalOrigin = `https://${hostname}`;
  const hubOrigin =
    deriveHubOrigin({ override: r.hubOrigin, exposeFqdn: hostname }) ?? canonicalOrigin;

  // Ensure the hub is running and figure out the loopback port cloudflared
  // should target. The hub does all internal routing (discovery, admin,
  // OAuth, well-known, per-vault proxy, generic /<svc>/* dispatch) — same
  // shape the Tailscale Funnel path uses (see `planEntries` in expose.ts).
  // Pre-2026-05-27 the cloudflared config routed straight at vault's port,
  // so a public URL like https://gitcoin.parachute.computer/ returned 404
  // from vault itself instead of the hub's discovery page; admin / OAuth
  // were unreachable. Aaron hit this on a fresh EC2 install.
  let hubPort: number;
  if (r.skipHub) {
    const existing = readHubPort(r.configDir);
    if (existing === undefined) {
      throw new Error("skipHub set but no hub.port on disk — tests must seed one");
    }
    hubPort = existing;
  } else {
    // §4.3a: "ensure the hub" = ensure the hub UNIT is up. The unit pins the
    // canonical 1939 (no walking fallback), so that's the target cloudflared's
    // ingress proxies to. Phase 5b retired the detached `ensureHubRunning`
    // bringup — a box with no hub unit gets `ensureHubUnit`'s actionable "run
    // `parachute migrate`" message, never a detached spawn.
    const probePort = readHubPort(r.configDir) ?? HUB_UNIT_DEFAULT_PORT;
    const ensured = await ensureHubUnitForExpose(r.sup, probePort, r.log);
    if (!ensured.ok) return 1;
    hubPort = ensured.port;
    r.log(`✓ hub unit up (port ${hubPort}).`);
  }
  if (hubPort === 0) hubPort = HUB_DEFAULT_PORT;

  let tunnel: Tunnel | undefined;
  try {
    tunnel = await findTunnelByName(r.runner, r.tunnelName);
  } catch (err) {
    return reportCloudflaredError(err, r.log);
  }
  if (!tunnel) {
    r.log(`Creating Cloudflare tunnel "${r.tunnelName}"…`);
    try {
      tunnel = await createTunnel(r.runner, r.tunnelName);
    } catch (err) {
      return reportCloudflaredError(err, r.log);
    }
    r.log(`✓ Created tunnel ${tunnel.id}`);
    r.log(
      "  Each machine gets its own dedicated tunnel — you don't need to run `cloudflared tunnel create` separately; expose does it.",
    );
  } else {
    r.log(`✓ Reusing existing tunnel "${r.tunnelName}" (${tunnel.id})`);
  }

  r.log(`Routing DNS: ${hostname} → tunnel ${tunnel.id}…`);
  try {
    await routeDns(r.runner, r.tunnelName, hostname);
  } catch (err) {
    if (err instanceof CloudflaredError) {
      r.log("");
      r.log(`✗ DNS route failed: ${err.message}`);
      r.log("");
      r.log("Common causes:");
      r.log(`  1. The apex of ${hostname} isn't a Cloudflare zone on this account.`);
      r.log("     Add the domain at https://dash.cloudflare.com → Add site, then re-run.");
      r.log(`  2. ${hostname} already has a conflicting DNS record.`);
      r.log("     Remove it at https://dash.cloudflare.com → DNS for that zone, then re-run.");
      return 1;
    }
    throw err;
  }
  r.log("✓ DNS routed.");

  // Post-route DNS self-diagnosis (hub#487). `cloudflared tunnel route dns`
  // can succeed (the CNAME is written in Cloudflare's API) while the hostname
  // is still NOT actually serving the tunnel — two shapes Aaron hit:
  //   (a) a "pending" zone whose nameservers aren't switched at the registrar
  //       yet, so the record exists in Cloudflare but nothing resolves; and
  //   (b) a subdomain shadowed by a Cloudflare Pages project on the same zone,
  //       so the edge 404s the tunnel.
  // Both previously printed "✓ DNS routed" + the URLs as if fine. This check
  // is best-effort and strictly NON-FATAL — it only adds a warning; it never
  // changes the exit code or blocks the expose. Fast: one DNS lookup with a
  // built-in timeout in `resolveHost`.
  await diagnoseDns(hostname, r);

  const credsFile = credentialsPath(tunnel.id, r.cloudflaredHome);
  writeConfig(
    {
      tunnelUuid: tunnel.id,
      credentialsFile: credsFile,
      hostname,
      // Route into the hub, not vault directly. The hub dispatches
      // discovery / admin / OAuth / per-vault proxy / generic /<svc>/*
      // — same shape Tailscale Funnel uses (single mount → hub catchall).
      // Pre-fix this was `vaultEntry.port`, which served vault's own 404
      // page on every request that wasn't /vault/<name>/… — admin SPA and
      // OAuth surfaces were unreachable from the public URL.
      servicePort: hubPort,
    },
    r.configPath,
  );
  r.log(`✓ Wrote ${r.configPath}`);

  // Orphan-connector sweep (hub#487). Before spawning a fresh connector, kill
  // EVERY cloudflared connector currently serving this tunnel so exactly one
  // process serves the config.yml we just wrote. Pre-fix, each re-expose
  // spawned a new connector without killing the prior ones (state tracked only
  // the most-recent pid), so orphans accumulated and edge routing became
  // nondeterministic. We union two sources:
  //   - the pid recorded in cloudflared-state.json (the prior `parachute`-
  //     spawned connector for this tunnel name), and
  //   - any pid found by scanning running processes for this tunnel's UUID or
  //     config path (catches orphans the state file lost track of — crashed
  //     mid-rewrite, or started by hand for this tunnel).
  const stateBefore = readCloudflaredState(r.statePath);
  const prior = findTunnelRecord(stateBefore, r.tunnelName);
  const toKill = new Set<number>();
  if (prior && r.alive(prior.pid)) toKill.add(prior.pid);
  for (const pid of r.connectorPids(tunnel.id, r.configPath)) {
    if (r.alive(pid)) toKill.add(pid);
  }
  for (const deadPid of toKill) {
    try {
      r.kill(deadPid, "SIGTERM");
      r.log(`Stopped prior cloudflared connector (pid ${deadPid}).`);
    } catch {
      // Process is already gone — safe to ignore; we replace the record below.
    }
  }

  // Legacy shared-tunnel migration sweep (#491). Aaron's running boxes were
  // exposed under the old single account-wide `"parachute"` tunnel; the bug
  // was that a second box reusing that name collided connectors. Now that the
  // default is per-hostname, a box upgrading and re-exposing will create/route
  // a NEW dedicated tunnel — but the OLD `"parachute"` connector is still
  // running, still registered on the shared tunnel, still able to pick up
  // load-balanced requests for OTHER hosts. Kill it + drop its state record so
  // the box self-heals immediately on this expose instead of at the next
  // reboot. Only fires when (a) we actually migrated AWAY from "parachute"
  // (the new derived name differs) and (b) a live legacy record exists.
  // `routeDns` above already used `--overwrite-dns`, so this hostname's CNAME
  // has been repointed to the new tunnel — the legacy connector can't serve it
  // anymore regardless; this just stops it from serving anyone else's.
  let migratedState = stateBefore;
  if (r.tunnelName !== DEFAULT_TUNNEL_NAME) {
    const legacy = findTunnelRecord(stateBefore, DEFAULT_TUNNEL_NAME);
    if (legacy) {
      // Remove any boot service for the legacy shared tunnel before killing its
      // connector, so a service doesn't restart the connector we're migrating
      // away from. Best-effort + idempotent (no-op when no service file exists,
      // which is the common pre-0.6.2 case).
      const legacyRemoval = r.removeService({ tunnelName: DEFAULT_TUNNEL_NAME });
      for (const line of legacyRemoval.messages) r.log(line);
      if (r.alive(legacy.pid)) {
        try {
          r.kill(legacy.pid, "SIGTERM");
        } catch {
          // Already gone between read and kill — fine; we drop the record below.
        }
        r.log(
          `Stopped legacy shared-tunnel connector (migrated ${hostname} to dedicated tunnel ${r.tunnelName}).`,
        );
      }
      // Drop the legacy shared-tunnel record whether or not its connector was
      // still alive. A dead record would otherwise linger across re-exposes
      // until the next `off`; clearing it here keeps state tidy (#491 review).
      migratedState = withoutTunnelRecord(stateBefore, DEFAULT_TUNNEL_NAME);
    }
  }

  // Install the reboot-persistent connector OS service (launchd / systemd) so
  // the connector survives a reboot — replacing the bare `proc.unref()` spawn
  // that died on restart (0.6.2). When the service installs successfully it
  // *becomes* the connector: it spawns + supervises `cloudflared tunnel run`,
  // so we do NOT also leave a duplicate transient connector — exactly one
  // process serves the config we wrote. We then discover the service-spawned
  // connector's pid (by UUID/config match) to record in state so the next
  // up-path's orphan sweep + the off-path's kill target the right process.
  //
  // Graceful fallback: if the service tool is missing / the install fails, we
  // fall back to the prior transient `proc.unref()` spawn and warn it won't
  // survive a reboot. The expose never hard-fails because the service didn't
  // take.
  const installResult = r.installService({
    tunnelName: r.tunnelName,
    configPath: r.configPath,
    logPath: r.logPath,
  });
  for (const line of installResult.messages) r.log(line);

  let pid: number;
  let serviceManaged = false;
  if (installResult.outcome === "installed") {
    serviceManaged = true;
    // The service (`enable --now` / `bootstrap` with RunAtLoad) already started
    // the connector; discover its pid for the state record so the next up-path's
    // orphan sweep + the off-path's kill target the right process. In practice
    // the connector is up by the time we look here.
    const managedPids = r.connectorPids(tunnel.id, r.configPath).filter((p) => r.alive(p));
    if (managedPids.length > 0) {
      pid = managedPids[0]!;
    } else {
      // Service is enabled (survives reboot) but we couldn't see its connector
      // yet. Spawn a transient one so state carries a live pid + connectivity
      // is immediate; the service takes over on the next reboot regardless.
      pid = r.spawner.spawn(["cloudflared", "tunnel", "--config", r.configPath, "run"], r.logPath);
    }
  } else {
    // Fallback: no boot service. Spawn the transient connector (won't survive
    // a reboot — warned below).
    pid = r.spawner.spawn(["cloudflared", "tunnel", "--config", r.configPath, "run"], r.logPath);
  }

  const record: CloudflaredTunnelRecord = {
    pid,
    tunnelUuid: tunnel.id,
    tunnelName: r.tunnelName,
    hostname,
    startedAt: r.now().toISOString(),
    configPath: r.configPath,
    // Only serialize the flag when true — keep the state JSON clean for the
    // common (transient-fallback) case; absent reads as unmanaged.
    ...(serviceManaged ? { serviceManaged: true } : {}),
  };
  writeCloudflaredState(withTunnelRecord(migratedState, record), r.statePath);

  // Persist the shared cross-provider expose record. Without this, the
  // Tailscale path was the only one writing expose-state.json — so after a
  // Cloudflare bring-up `readExposeState()` returned undefined and downstream
  // consumers fell back to loopback:
  //   - init's `resolveAdminUrl` printed http://127.0.0.1:1939/admin/ instead
  //     of the public URL.
  //   - lifecycle's `resolveHubOrigin` (and the hub#460 vault `.env`
  //     PARACHUTE_HUB_ORIGIN persistence) kept the loopback origin, so vault's
  //     OAuth `iss` claim didn't match the public host — the "rejected on
  //     reconnect" P0 on Cloudflare deploys.
  // Mode is "subdomain": cloudflared routes the whole FQDN at the hub catchall
  // (one ingress → hub), unlike the Tailscale path's "path" routing. The single
  // proxy entry mirrors the hub-catchall shape the Tailscale Funnel path plans.
  const exposeState: ExposeState = {
    version: 1,
    layer: "public",
    mode: "subdomain",
    canonicalFqdn: hostname,
    port: hubPort,
    funnel: false,
    entries: [
      {
        kind: "proxy",
        mount: "/",
        target: `http://localhost:${hubPort}`,
        service: "hub",
      },
    ],
    hubOrigin,
  };
  writeExposeState(exposeState, r.exposeStatePath);

  // Persist the public hub origin into vault's `.env` and restart vault — the
  // durable half of the OAuth issuer-mismatch fix on Cloudflare deploys.
  //
  // The bug (vault 401s every hub token on a Cloudflare deploy): the Tailscale
  // path gets this for free because it auto-restarts vault, and that restart
  // flows the freshly-written expose-state `hubOrigin` into `vault/.env` via
  // lifecycle's `persistVaultHubOrigin`. The Cloudflare path wrote expose-state
  // but never touched vault's `.env` or restarted it, so the launchd / systemd
  // daemon kept booting vault with NO `PARACHUTE_HUB_ORIGIN` → vault fell back
  // to loopback as its expected issuer → every hub-minted token (whose `iss`
  // is the public origin) failed the `iss` check → 401 → "You're not signed in
  // to the hub." We mirror the Tailscale path here exactly.
  //
  // The supervised restart helper writes the durable `.env` (skipping loopback,
  // so a `--hub-origin http://127.0.0.1` override never bakes a dead issuer in)
  // and makes the running vault re-read it immediately rather than waiting for
  // the next reboot.
  //
  // §4.3c: drive the restart through the running Supervisor
  // (`driveModuleOp("vault", "restart")`), which re-injects the hub's current
  // origin; `restartHubDependentViaSupervisor` also persists the durable `.env`
  // + self-heals the operator-token issuer. Phase 5b retired the detached
  // `lifecycle.restart` arm.
  r.log("");
  r.log("Restarting vault to pick up new hub origin…");
  const rcode = await restartHubDependentViaSupervisor({
    short: "vault",
    hubOrigin,
    configDir: r.configDir,
    sup: r.sup,
    log: r.log,
  });
  if (rcode !== 0) {
    r.log(
      "⚠ vault restart failed. Run manually once the issue is resolved: parachute restart vault",
    );
  }

  const baseUrl = `https://${hostname}`;
  // A well-formed vault manifest always lists at least one mount path. If
  // it's empty, something went sideways in `parachute install vault` — warn
  // so the user can fix services.json rather than chasing a phantom 404 on
  // /vault/default that may or may not exist.
  if (!vaultEntry.paths[0]) {
    r.log(
      `⚠ vault entry in services.json has no paths[]; defaulting to "/vault/default". Check the manifest.`,
    );
  }
  const vaultMount = vaultEntry.paths[0] ?? "/vault/default";
  const vaultUrl = `${baseUrl}${vaultMount}`;

  r.log("");
  r.log(`✓ Cloudflare tunnel up (pid ${pid}).`);
  r.log(`  Tunnel:  ${r.tunnelName} (dedicated to this machine)`);
  r.log(`  Open:    ${baseUrl}/`);
  r.log(`  Admin:   ${baseUrl}/admin/`);
  r.log(`  Vault:   ${vaultUrl}`);
  r.log(`  OAuth:   ${hubOrigin}`);
  r.log(`  Logs:    ${r.logPath}`);
  r.log("");
  if (serviceManaged) {
    // The connector is now an OS service (launchd LaunchAgent on macOS, systemd
    // unit on Linux), so it starts on boot — no need to re-run expose after a
    // reboot. `parachute expose public --cloudflare off` stops + removes it.
    r.log("The connector runs on boot (via launchd/systemd) — it survives reboots. Re-running");
    r.log("the same command is still idempotent (same hostname → same dedicated tunnel).");
  } else {
    // Honest reboot caveat for the fallback path: the boot service couldn't be
    // installed (tool missing / unsupported platform / install failed — see the
    // warning printed above), so the connector is a detached background process
    // that does NOT survive a reboot. Re-running the same command brings it back.
    r.log("Note: a boot service couldn't be installed (see above), so the connector runs in the");
    r.log("background but does NOT survive a reboot. After a reboot, re-run:");
    r.log(`  parachute expose public --cloudflare --domain ${hostname}`);
  }
  r.log("");
  r.log("Point a claude.ai / ChatGPT connector at:");
  r.log(`  ${vaultUrl}`);
  printAuthGuidance(r.log, vaultUrl);
  // 2FA-enrollment warning when /admin/login is now reachable on the public
  // internet but the operator hasn't enrolled TOTP. Cloudflare exposure is
  // always public; tailnet/funnel mirrors this in `expose.ts`. See #186.
  printPublic2FAWarning({
    log: r.log,
    publicUrl: baseUrl,
    ...(r.vaultHome !== undefined ? { vaultHome: r.vaultHome } : {}),
    ...(r.vaultAuthStatus !== undefined ? { status: r.vaultAuthStatus } : {}),
  });
  return 0;
}

/**
 * Tear down ONE tunnel record: SIGTERM its connector, sweep any orphan
 * connectors for it (hub#487), drop its state record, and emit the
 * reuse-hint copy. Pure-ish over `r` + the current state: returns the state
 * with the record removed (or undefined when that empties it) plus an exit
 * code, so the caller commits the disk write once after tearing down one or
 * many tunnels. The connector kill is non-fatal-on-already-gone, fatal only
 * when SIGTERM itself errors on a live pid.
 */
function teardownOne(
  r: Resolved,
  state: CloudflaredState | undefined,
  record: CloudflaredTunnelRecord,
): { state: CloudflaredState | undefined; code: number } {
  // Remove the reboot-persistent connector service FIRST (when one owns this
  // tunnel) so a still-enabled launchd/systemd service doesn't immediately
  // restart the connector we SIGTERM below. `removeConnectorService` is
  // idempotent + best-effort: a missing service file is a no-op (covers
  // transient-fallback tunnels and pre-0.6.2 records, which carry no service).
  // We always attempt it — even when `serviceManaged` is unset — so a record
  // written before this field existed, or an out-of-band service file, still
  // gets swept. The removal stops the service, after which the SIGTERM is final.
  const removal = r.removeService({ tunnelName: record.tunnelName });
  for (const line of removal.messages) r.log(line);
  if (r.alive(record.pid)) {
    try {
      r.kill(record.pid, "SIGTERM");
      r.log(`✓ Stopped cloudflared (pid ${record.pid}, tunnel "${record.tunnelName}").`);
    } catch (err) {
      r.log(`✗ Failed to stop cloudflared: ${err instanceof Error ? err.message : String(err)}`);
      return { state, code: 1 };
    }
  } else {
    r.log(`cloudflared (pid ${record.pid}) wasn't running; clearing stale state.`);
  }
  // Sweep any orphan connectors for this tunnel that the state record didn't
  // track (hub#487) so `off` leaves exactly zero connectors serving it. Match
  // by UUID/config-path; skip the record pid we already signalled above.
  for (const orphanPid of r.connectorPids(record.tunnelUuid, record.configPath)) {
    if (orphanPid === record.pid || !r.alive(orphanPid)) continue;
    try {
      r.kill(orphanPid, "SIGTERM");
      r.log(`✓ Stopped orphan cloudflared connector (pid ${orphanPid}).`);
    } catch {
      // Already gone between probe and kill — fine.
    }
  }
  r.log(`  ${record.hostname} is no longer reachable through this machine.`);
  r.log(
    `  Tunnel "${record.tunnelName}" (${record.tunnelUuid}) remains defined in Cloudflare; re-running`,
  );
  // Only suggest `--tunnel-name` for a custom name. The auto-derived name
  // (and the legacy shared "parachute" name) need no flag — re-running with
  // just --domain re-derives the per-hostname name (and migrates a legacy
  // record off the shared tunnel), which is exactly what we want.
  const isAutoName =
    record.tunnelName === deriveTunnelName(record.hostname) ||
    record.tunnelName === DEFAULT_TUNNEL_NAME;
  r.log(
    `  \`parachute expose public --cloudflare --domain ${record.hostname}${isAutoName ? "" : ` --tunnel-name ${record.tunnelName}`}\` reuses it.`,
  );
  return { state: withoutTunnelRecord(state, record.tunnelName), code: 0 };
}

export async function exposeCloudflareOff(opts: ExposeCloudflareOpts = {}): Promise<number> {
  // The off-path has no hostname to derive a name from. When `--tunnel-name`
  // is set we use it; otherwise we resolve from cloudflared-state.json (below).
  // `DEFAULT_TUNNEL_NAME` is only the inert `resolve` fallback here — the
  // state-driven branch never relies on it.
  const r = resolve(opts, DEFAULT_TUNNEL_NAME);
  const stateBefore = readCloudflaredState(r.statePath);
  const records = listTunnelRecords(stateBefore);

  // Decide which records to tear down.
  //   - explicit `--tunnel-name` → exactly that one (or a not-found message).
  //   - no flag, 0 tunnels        → nothing to do.
  //   - no flag, exactly 1        → that one.
  //   - no flag, ≥2               → ALL of them. A bare `expose public
  //     --cloudflare off` means "stop all public Cloudflare exposure on this
  //     machine"; tearing down only one would leave the box half-exposed with
  //     no obvious signal which tunnel survived.
  let targets: CloudflaredTunnelRecord[];
  if (opts.tunnelName !== undefined) {
    const record = findTunnelRecord(stateBefore, r.tunnelName);
    if (!record) {
      if (records.length > 0) {
        const others = records.map((t) => t.tunnelName).join(", ");
        r.log(
          `No Cloudflare exposure recorded for tunnel "${r.tunnelName}". Other tunnels: ${others}.`,
        );
      } else {
        r.log("No Cloudflare exposure recorded. Nothing to tear down.");
      }
      return 0;
    }
    targets = [record];
  } else {
    if (records.length === 0) {
      r.log("No Cloudflare exposure recorded. Nothing to tear down.");
      return 0;
    }
    if (records.length > 1) {
      r.log(
        `Tearing down all ${records.length} recorded Cloudflare tunnels: ${records
          .map((t) => t.tunnelName)
          .join(", ")}.`,
      );
    }
    targets = records;
  }

  let state = stateBefore;
  let failed = false;
  for (const record of targets) {
    const result = teardownOne(r, state, record);
    state = result.state;
    if (result.code !== 0) failed = true;
  }

  if (state) {
    writeCloudflaredState(state, r.statePath);
  } else {
    clearCloudflaredState(r.statePath);
  }
  // Clear the shared expose-state.json when no Cloudflare tunnels remain, so
  // downstream consumers stop resolving the now-dead public URL (mirrors the
  // up-path write above + the Tailscale off-path's expose-state teardown). When
  // other tunnels survive we leave it — a later off for the last one clears it.
  if (!state) {
    clearExposeState(r.exposeStatePath);
  }
  return failed ? 1 : 0;
}

function reportCloudflaredError(err: unknown, log: (line: string) => void): number {
  if (err instanceof CloudflaredError) {
    log(`✗ ${err.message}`);
    return 1;
  }
  throw err;
}
