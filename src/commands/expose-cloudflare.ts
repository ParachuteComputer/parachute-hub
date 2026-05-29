import { spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_TUNNEL_NAME, cloudflaredPathsFor, writeConfig } from "../cloudflare/config.ts";
import {
  DEFAULT_CLOUDFLARED_HOME,
  cloudflaredInstallHint,
  isCloudflaredInstalled,
  isCloudflaredLoggedIn,
} from "../cloudflare/detect.ts";
import {
  CLOUDFLARED_STATE_PATH,
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
import {
  type EnsureHubOpts,
  HUB_DEFAULT_PORT,
  ensureHubRunning,
  readHubPort,
} from "../hub-control.ts";
import { deriveHubOrigin } from "../hub-origin.ts";
import { type AliveFn, defaultAlive } from "../process-state.ts";
import { readManifest } from "../services-manifest.ts";
import { type Runner, defaultRunner } from "../tailscale/run.ts";
import type { VaultAuthStatus } from "../vault/auth-status.ts";
import { WELL_KNOWN_DIR } from "../well-known.ts";
import { printPublic2FAWarning } from "./expose-2fa-warning.ts";

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
   * Tunnel name targeted by this invocation. Defaults to `parachute` —
   * the canonical single-tunnel name. Override to run multiple tunnels on
   * one box (#32).
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
   * Threaded into `ensureHubRunning` so cloudflared's ingress target stays
   * in sync with where the hub actually bound.
   */
  configDir?: string;
  /**
   * Override the public hub origin (the `iss` claim baked into the OAuth
   * issuer). Mirrors the Tailscale path — when set, this URL is what the
   * hub advertises rather than the cloudflared hostname.
   */
  hubOrigin?: string;
  /**
   * Overrides for hub lifecycle — primarily for tests. Tests pass
   * `skipHubLifecycle: true` (above) plus a seeded `hub.port` file so the
   * cloudflare path can resolve a port without actually spawning a hub.
   */
  hubEnsureOpts?: Omit<EnsureHubOpts, "configDir" | "wellKnownDir" | "log">;
  /**
   * Directory holding hub.html (passed through to the hub server on first
   * spawn). Defaults to the same `well-known/` resolution the Tailscale
   * path uses.
   */
  wellKnownDir?: string;
  /**
   * Skip spawning the hub server. Tests flip this on and pre-seed
   * `<configDir>/hub/run/hub.port` so `readHubPort` can resolve the
   * cloudflared target without a live process. Production always leaves
   * this off so the bringup self-heals a missing hub.
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
}

interface Resolved {
  runner: Runner;
  spawner: CloudflaredSpawner;
  alive: AliveFn;
  kill: KillFn;
  connectorPids: ConnectorPidsFn;
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
  hubEnsureOpts: Omit<EnsureHubOpts, "configDir" | "wellKnownDir" | "log">;
  wellKnownDir: string;
  skipHub: boolean;
  now: () => Date;
  vaultHome: string | undefined;
  vaultAuthStatus: VaultAuthStatus | undefined;
}

function resolve(opts: ExposeCloudflareOpts): Resolved {
  const tunnelName = opts.tunnelName ?? DEFAULT_TUNNEL_NAME;
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
    hubEnsureOpts: opts.hubEnsureOpts ?? {},
    wellKnownDir: opts.wellKnownDir ?? WELL_KNOWN_DIR,
    skipHub: opts.skipHub ?? false,
    now: opts.now ?? (() => new Date()),
    vaultHome: opts.vaultHome,
    vaultAuthStatus: opts.vaultAuthStatus,
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
  const r = resolve(opts);

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
    const hub = await ensureHubRunning({
      reservedPorts: manifest.services.map((s) => s.port),
      ...r.hubEnsureOpts,
      configDir: r.configDir,
      wellKnownDir: r.wellKnownDir,
      issuer: hubOrigin,
      log: r.log,
    });
    hubPort = hub.port;
    if (hub.started) r.log(`✓ hub started (pid ${hub.pid}, port ${hub.port}).`);
    else r.log(`✓ hub already running (pid ${hub.pid}, port ${hub.port}).`);
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

  const pid = r.spawner.spawn(
    ["cloudflared", "tunnel", "--config", r.configPath, "run"],
    r.logPath,
  );

  const record: CloudflaredTunnelRecord = {
    pid,
    tunnelUuid: tunnel.id,
    tunnelName: r.tunnelName,
    hostname,
    startedAt: r.now().toISOString(),
    configPath: r.configPath,
  };
  writeCloudflaredState(withTunnelRecord(stateBefore, record), r.statePath);

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
  r.log(`  Open:    ${baseUrl}/`);
  r.log(`  Admin:   ${baseUrl}/admin/`);
  r.log(`  Vault:   ${vaultUrl}`);
  r.log(`  OAuth:   ${hubOrigin}`);
  r.log(`  Logs:    ${r.logPath}`);
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

export async function exposeCloudflareOff(opts: ExposeCloudflareOpts = {}): Promise<number> {
  const r = resolve(opts);
  const stateBefore = readCloudflaredState(r.statePath);
  const record = findTunnelRecord(stateBefore, r.tunnelName);
  if (!record) {
    if (stateBefore && Object.keys(stateBefore.tunnels).length > 0) {
      const others = listTunnelRecords(stateBefore)
        .map((t) => t.tunnelName)
        .join(", ");
      r.log(
        `No Cloudflare exposure recorded for tunnel "${r.tunnelName}". Other tunnels: ${others}.`,
      );
    } else {
      r.log("No Cloudflare exposure recorded. Nothing to tear down.");
    }
    return 0;
  }
  if (r.alive(record.pid)) {
    try {
      r.kill(record.pid, "SIGTERM");
      r.log(`✓ Stopped cloudflared (pid ${record.pid}).`);
    } catch (err) {
      r.log(`✗ Failed to stop cloudflared: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
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
  const stateAfter = withoutTunnelRecord(stateBefore, r.tunnelName);
  if (stateAfter) {
    writeCloudflaredState(stateAfter, r.statePath);
  } else {
    clearCloudflaredState(r.statePath);
  }
  // Clear the shared expose-state.json when no Cloudflare tunnels remain, so
  // downstream consumers stop resolving the now-dead public URL (mirrors the
  // up-path write above + the Tailscale off-path's expose-state teardown). When
  // other tunnels survive we leave it — a later off for the last one clears it.
  if (!stateAfter) {
    clearExposeState(r.exposeStatePath);
  }
  r.log(`  ${record.hostname} is no longer reachable through this machine.`);
  r.log(
    `  Tunnel "${record.tunnelName}" (${record.tunnelUuid}) remains defined in Cloudflare; re-running`,
  );
  r.log(
    `  \`parachute expose public --cloudflare --domain ${record.hostname}${record.tunnelName === DEFAULT_TUNNEL_NAME ? "" : ` --tunnel-name ${record.tunnelName}`}\` reuses it.`,
  );
  return 0;
}

function reportCloudflaredError(err: unknown, log: (line: string) => void): number {
  if (err instanceof CloudflaredError) {
    log(`✗ ${err.message}`);
    return 1;
  }
  throw err;
}
