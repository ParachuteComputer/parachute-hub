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

export interface ExposeCloudflareOpts {
  runner?: Runner;
  spawner?: CloudflaredSpawner;
  alive?: AliveFn;
  kill?: KillFn;
  log?: (line: string) => void;
  manifestPath?: string;
  statePath?: string;
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
  log: (line: string) => void;
  manifestPath: string;
  statePath: string;
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
    log: opts.log ?? ((line) => console.log(line)),
    manifestPath: opts.manifestPath ?? SERVICES_MANIFEST_PATH,
    statePath: opts.statePath ?? CLOUDFLARED_STATE_PATH,
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
  log("    parachute auth set-password         # set an owner password");
  log("    parachute auth 2fa enroll           # (recommended) TOTP + backup codes");
  log("    then point your connector at:");
  log(`    ${vaultUrl}`);
  log("");
  log("  Scripts / machines:");
  log("    parachute vault tokens create       # creates a pvt_… bearer token");
  log("    Authorization: Bearer pvt_…         # attach to every request");
  log("");
  log("Neither is a prerequisite for the other. Full auth reference:");
  log(`  ${AUTH_DOC_URL}`);
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

  const stateBefore = readCloudflaredState(r.statePath);
  const prior = findTunnelRecord(stateBefore, r.tunnelName);
  if (prior && r.alive(prior.pid)) {
    try {
      r.kill(prior.pid, "SIGTERM");
      r.log(`Stopped prior cloudflared (pid ${prior.pid}).`);
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
  const stateAfter = withoutTunnelRecord(stateBefore, r.tunnelName);
  if (stateAfter) {
    writeCloudflaredState(stateAfter, r.statePath);
  } else {
    clearCloudflaredState(r.statePath);
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
