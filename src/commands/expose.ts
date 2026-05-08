import { existsSync, unlinkSync } from "node:fs";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  EXPOSE_STATE_PATH,
  type ExposeLayer,
  type ExposeState,
  clearExposeState,
  readExposeState,
  writeExposeState,
} from "../expose-state.ts";
import {
  type EnsureHubOpts,
  type StopHubOpts,
  defaultPortProbe,
  ensureHubRunning,
  readHubPort,
  stopHub,
} from "../hub-control.ts";
import { deriveHubOrigin } from "../hub-origin.ts";
import { HUB_PATH, writeHubFile } from "../hub.ts";
import { type AliveFn, processState } from "../process-state.ts";
import { shortNameForManifest } from "../service-spec.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";
import { type ServeEntry, bringupCommand, teardownCommand } from "../tailscale/commands.ts";
import { getFqdn, isTailscaleInstalled } from "../tailscale/detect.ts";
import { type Runner, defaultRunner } from "../tailscale/run.ts";
import {
  WELL_KNOWN_DIR,
  WELL_KNOWN_MOUNT,
  WELL_KNOWN_PATH,
  buildWellKnown,
  shortName,
  writeWellKnownFile,
} from "../well-known.ts";
import { restart } from "./lifecycle.ts";

/**
 * Two exposure layers share a single tailscale serve config on this node.
 * Public layer adds `--funnel` to each handler; everything else is identical.
 *
 * Single-rule shape: tailnet bringup emits exactly one `tailscale serve`
 * mount — `/ → http://127.0.0.1:<hubPort>/`. The hub does all internal
 * routing per request: hub UI, OAuth, well-known, vault SPA + per-vault
 * proxy, and generic services.json-driven `/<svc>/*` dispatch. Layer
 * detection (loopback / tailnet / public) and `publicExposure` enforcement
 * also live in the hub (`layerOf` + `effectivePublicExposure`), so this
 * plan layer no longer partitions services up-front. Cloudflare ingress
 * shipped the same shape on 0.5.2 in #178; this closes the symmetry.
 *
 * Funnel constraint, mostly historical now: Tailscale allows at most three
 * public HTTPS ports per node (443, 8443, 10000). With one rule there is
 * one port — symbolic but the constraint is what motivated path-routing
 * over subdomain-per-service in the first place.
 *
 * Hub mount is an HTTP proxy to the internal Bun.serve (see `hub-control.ts`).
 * Used to be `--set-path=<mount> <file>` entries but macOS `tailscaled` runs
 * sandboxed and can't read arbitrary files; proxy mode is the only reliable
 * shape.
 */

export interface ExposeOpts {
  runner?: Runner;
  manifestPath?: string;
  statePath?: string;
  wellKnownPath?: string;
  hubPath?: string;
  /** Directory holding hub.html (passed to the hub server). */
  wellKnownDir?: string;
  configDir?: string;
  port?: number;
  log?: (line: string) => void;
  /** Override detected FQDN — primarily for tests. */
  fqdnOverride?: string;
  /** Overrides for the hub lifecycle — primarily for tests. */
  hubEnsureOpts?: Omit<EnsureHubOpts, "configDir" | "wellKnownDir" | "log">;
  hubStopOpts?: Omit<StopHubOpts, "configDir" | "log">;
  /** Skip spawning the hub server. Tests flip this off to verify it's called. */
  skipHub?: boolean;
  /**
   * Probe a port to decide whether a service is responding. Returns true when
   * something is listening (i.e., bind-probe fails). Primarily a test seam —
   * the default walks every service port before bringup and warns on any
   * that don't answer.
   */
  servicePortProbe?: (port: number) => Promise<boolean>;
  /**
   * Override the computed hub origin. Lets the user pin the OAuth issuer to
   * something other than the detected tailnet FQDN — e.g., a custom domain
   * fronting tailscale funnel, or a staging URL during a migration. Passed
   * through to vault (and future services) via PARACHUTE_HUB_ORIGIN.
   */
  hubOrigin?: string;
  /** Process-liveness check for auto-restart — test seam. */
  alive?: AliveFn;
  /**
   * Restart a service by short name after exposure changes. Defaults to the
   * lifecycle `restart`; tests inject a fake to assert the call without
   * spawning real child processes.
   */
  restartService?: (short: string) => Promise<number>;
}

/**
 * Short names whose running process caches the hub origin (today:
 * PARACHUTE_HUB_ORIGIN → vault's OAuth issuer). `exposeUp` restarts these
 * after writing new expose-state so in-memory state matches what clients see.
 * Hard-coded while vault is the only dependent; a services.json field will
 * generalize this once a second service needs it.
 */
const HUB_DEPENDENT_SHORTS = ["vault"] as const;

/**
 * Single tailscale serve mount: `/ → http://127.0.0.1:<hubPort>/`. The hub
 * dispatches everything internally (hub page, /admin, /api, /hub SPA, /oauth,
 * /.well-known, /vault SPA + proxy, /vaults POST, generic /<svc>/*), so the
 * tailscale plan stays at this single rule regardless of how many services
 * are installed. `publicExposure: "loopback"` enforcement happens inside the
 * hub via `layerOf` — see `proxyToService` / `proxyToVault` in hub-server.ts.
 */
const HUB_CATCHALL_MOUNT = "/";

/**
 * Warn (but don't rewrite) for legacy `paths: ["/"]` entries. Pre-#144 these
 * were remapped to `/<shortname>` so they didn't collide with the hub page
 * at `/`. Now that the entire tailnet is one catchall to the hub, the hub
 * dispatches by services.json `paths[]` per request — a `paths: ["/"]` entry
 * still wouldn't route correctly, but the failure is hub-side rather than a
 * tailscale plan collision. Emit the warning so operators know to re-install.
 */
function warnLegacyRoot(services: readonly ServiceEntry[], log: (line: string) => void): void {
  for (const s of services) {
    if (s.paths[0] !== "/") continue;
    const sn = shortName(s.name);
    log(
      `note: ${s.name} claims "/"; hub page lives there — re-run \`parachute install ${sn}\` to update services.json.`,
    );
  }
}

/**
 * Build the tailscale plan: one rule, `/ → http://127.0.0.1:<hubPort>/`.
 * Hub does internal dispatch (UI, OAuth, well-known, vault SPA + per-vault
 * proxy, generic /<svc>/* services.json dispatch) and per-request layer
 * gating for `publicExposure: "loopback"` services. See `layerOf` in
 * `hub-server.ts` for the access-control matrix.
 */
function planEntries(hubPort: number): ServeEntry[] {
  return [
    {
      kind: "proxy",
      mount: HUB_CATCHALL_MOUNT,
      target: `http://127.0.0.1:${hubPort}/`,
      service: "hub",
    },
  ];
}

async function runEach(
  runner: Runner,
  commands: string[][],
  log: (line: string) => void,
): Promise<number> {
  for (const cmd of commands) {
    log(`  $ ${cmd.join(" ")}`);
    const { code, stderr } = await runner(cmd);
    if (code !== 0) {
      if (stderr.trim()) log(stderr.trim());
      return code;
    }
  }
  return 0;
}

/**
 * Tailscale's `serve/funnel … off` exits non-zero with stderr like
 * `error: failed to remove web serve: handler does not exist` when the entry
 * is already absent from tailscale's state. This happens when the user ran
 * `tailscale funnel reset` externally, tailscaled restarted and dropped
 * ephemeral state, or a prior teardown partially succeeded. From the user's
 * perspective `off` is idempotent — the goal is "this handler is gone" and
 * it already is. Match the narrow `does not exist` phrase; real errors
 * (auth, daemon down) don't include it and still abort.
 */
function teardownAlreadyGone(stderr: string): boolean {
  return stderr.toLowerCase().includes("does not exist");
}

/**
 * Like `runEach` but tolerant of already-gone entries. Each command that
 * fails with a "does not exist" stderr is logged and skipped; any other
 * non-zero exit still aborts so real failures surface.
 */
async function runTeardown(
  runner: Runner,
  commands: string[][],
  log: (line: string) => void,
): Promise<number> {
  for (const cmd of commands) {
    log(`  $ ${cmd.join(" ")}`);
    const { code, stderr } = await runner(cmd);
    if (code === 0) continue;
    if (teardownAlreadyGone(stderr)) {
      const firstLine = stderr.trim().split("\n")[0] ?? "already gone";
      log(`  (already gone — ${firstLine})`);
      continue;
    }
    if (stderr.trim()) log(stderr.trim());
    return code;
  }
  return 0;
}

function layerLabel(layer: ExposeLayer): string {
  return layer === "public" ? "Public (Funnel)" : "Tailnet";
}

export async function exposeUp(layer: ExposeLayer, opts: ExposeOpts = {}): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const statePath = opts.statePath ?? EXPOSE_STATE_PATH;
  const wellKnownFilePath = opts.wellKnownPath ?? WELL_KNOWN_PATH;
  const hubFilePath = opts.hubPath ?? HUB_PATH;
  const wellKnownDir = opts.wellKnownDir ?? WELL_KNOWN_DIR;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const port = opts.port ?? 443;
  const log = opts.log ?? ((line) => console.log(line));
  const funnel = layer === "public";

  if (!(await isTailscaleInstalled(runner))) {
    log("tailscale is not installed or not on PATH.");
    log("Install from https://tailscale.com/download and run `tailscale up`.");
    return 1;
  }

  const manifest = readManifest(manifestPath);
  if (manifest.services.length === 0) {
    log("No services installed yet. Try: parachute install vault");
    return 1;
  }

  const fqdn = opts.fqdnOverride ?? (await getFqdn(runner));
  const canonicalOrigin = `https://${fqdn}`;

  const prior = readExposeState(statePath);
  if (prior && prior.entries.length > 0) {
    const priorLabel = layerLabel(prior.layer);
    log(`Found prior ${priorLabel} exposure; tearing down ${prior.entries.length} entries first…`);
    const teardownCmds = prior.entries.map((e) =>
      teardownCommand(e, { port: prior.port, funnel: prior.funnel }),
    );
    const code = await runTeardown(runner, teardownCmds, log);
    if (code !== 0) {
      log("Teardown of prior state failed; aborting.");
      return code;
    }
  }

  // Plan no longer partitions services — every service goes through the
  // single hub catchall, and hub gates per request (`publicExposure` +
  // `layerOf` in hub-server.ts). Just surface the legacy `paths: ["/"]`
  // warning so operators know to re-install. `warnLegacyRoot` is
  // side-effect-only (warning to `log`); use `manifest.services` directly
  // downstream.
  warnLegacyRoot(manifest.services, log);

  /**
   * Probe each service port before wiring tailscale up. A service that's
   * quietly stopped would otherwise get proxied for silent 502s. Warn and
   * continue — users sometimes expose paths ahead of starting a service,
   * and we don't want probe flakes to block bringup.
   */
  const portProbe = opts.servicePortProbe ?? (async (p: number) => !(await defaultPortProbe(p)));
  const probeResults = await Promise.all(
    manifest.services.map(async (s) => ({ svc: s, up: await portProbe(s.port) })),
  );
  for (const { svc, up } of probeResults) {
    if (up) continue;
    const short = shortNameForManifest(svc.name) ?? svc.name;
    log(
      `⚠ ${svc.name} (port ${svc.port}) is not responding; its path will proxy to a dead port. Run \`parachute start ${short}\`.`,
    );
  }

  // Kept for manual debugging / inspection only — the hub server now builds
  // /.well-known/parachute.json dynamically from services.json at request time
  // (#135), so this on-disk copy is no longer load-bearing for any consumer.
  const wellKnownDoc = buildWellKnown({ services: manifest.services, canonicalOrigin });
  writeWellKnownFile(wellKnownDoc, wellKnownFilePath);
  log(`Wrote ${wellKnownFilePath}`);
  writeHubFile(hubFilePath);
  log(`Wrote ${hubFilePath}`);

  // Resolve the public hub origin before spawning the hub server — it gets
  // baked into the OAuth `iss` claim via the `--issuer` flag. Falling back to
  // the request origin would put `http://127.0.0.1:<port>` in tokens, which
  // any client following RFC 8414 would reject.
  const hubOrigin =
    deriveHubOrigin({ override: opts.hubOrigin, exposeFqdn: fqdn }) ?? canonicalOrigin;

  let hubPort: number;
  if (opts.skipHub) {
    const existing = readHubPort(configDir);
    if (existing === undefined) {
      throw new Error("skipHub set but no hub.port on disk — tests must seed one");
    }
    hubPort = existing;
  } else {
    const hub = await ensureHubRunning({
      reservedPorts: manifest.services.map((s) => s.port),
      ...(opts.hubEnsureOpts ?? {}),
      configDir,
      wellKnownDir,
      issuer: hubOrigin,
      log,
    });
    hubPort = hub.port;
    if (hub.started) log(`✓ hub started (pid ${hub.pid}, port ${hub.port}).`);
    else log(`✓ hub already running (pid ${hub.pid}, port ${hub.port}).`);
  }

  const entries = planEntries(hubPort);
  log(`Exposing under ${canonicalOrigin} (${layerLabel(layer)}, path-routing, port ${port}):`);
  for (const e of entries) {
    const suffix = e.kind === "proxy" ? `→ ${e.target}  (${e.service})` : `→ ${e.target}`;
    log(`  ${e.mount.padEnd(30, " ")} ${suffix}`);
  }

  const cmds = entries.map((e) => bringupCommand(e, { port, funnel }));
  const code = await runEach(runner, cmds, log);
  if (code !== 0) {
    log("Bringup failed; see error above. Prior tailscale state may be partially applied.");
    return code;
  }

  const state: ExposeState = {
    version: 1,
    layer,
    mode: "path",
    canonicalFqdn: fqdn,
    port,
    funnel,
    entries,
    hubOrigin,
  };
  writeExposeState(state, statePath);

  log("");
  if (layer === "public") {
    log(`✓ Public exposure active (Funnel). Open: ${canonicalOrigin}/`);
    log("  This node is reachable from the public internet.");
    log(
      "  Note: public is exploratory. Tailnet is the supported exposure shape today; the hub's OAuth + scope work targets tailnet first. Prefer `parachute expose tailnet` unless you specifically need a public URL.",
    );
  } else {
    log(`✓ Tailnet exposure active. Open: ${canonicalOrigin}/`);
  }
  log(`  Discovery: ${canonicalOrigin}${WELL_KNOWN_MOUNT}`);
  log(`  OAuth issuer: ${hubOrigin}`);

  // Auto-restart services that cache the hub origin. Aaron hit this on launch
  // day: after `expose public` first-run, vault kept its stale (loopback)
  // PARACHUTE_HUB_ORIGIN, the OAuth issuer didn't match what clients saw, and
  // claude.ai MCP failed with a cryptic "Couldn't reach the MCP server". The
  // old output told the user to restart manually; it got buried in the wall
  // of expose output. Do the restart ourselves.
  const doRestart =
    opts.restartService ?? ((short: string) => restart(short, { manifestPath, configDir, log }));
  for (const short of HUB_DEPENDENT_SHORTS) {
    if (processState(short, configDir, opts.alive).status !== "running") continue;
    log("");
    log(`Restarting ${short} to pick up new hub origin…`);
    const rcode = await doRestart(short);
    if (rcode !== 0) {
      log(
        `⚠ ${short} restart failed. Run manually once the issue is resolved: parachute restart ${short}`,
      );
    }
  }
  return 0;
}

export async function exposeOff(layer: ExposeLayer, opts: ExposeOpts = {}): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  const statePath = opts.statePath ?? EXPOSE_STATE_PATH;
  const wellKnownFilePath = opts.wellKnownPath ?? WELL_KNOWN_PATH;
  const hubFilePath = opts.hubPath ?? HUB_PATH;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const log = opts.log ?? ((line) => console.log(line));

  const state = readExposeState(statePath);
  if (!state || state.entries.length === 0) {
    log(`No ${layerLabel(layer)} exposure recorded. Nothing to tear down.`);
    return 0;
  }
  if (state.layer !== layer) {
    log(`No ${layerLabel(layer)} exposure recorded.`);
    log(`Current exposure is ${layerLabel(state.layer)}.`);
    log(`Run: parachute expose ${state.layer} off`);
    return 0;
  }

  log(`Tearing down ${state.entries.length} ${layerLabel(layer)} serve entries…`);
  const cmds = state.entries.map((e) =>
    teardownCommand(e, { port: state.port, funnel: state.funnel }),
  );
  const code = await runTeardown(runner, cmds, log);
  if (code !== 0) {
    log("Teardown failed. State file left in place so you can retry.");
    return code;
  }

  clearExposeState(statePath);
  // Pair to the debug-only write at expose-up — clean up the inspection artifact
  // on teardown so it doesn't outlive the layer it described.
  if (existsSync(wellKnownFilePath)) {
    unlinkSync(wellKnownFilePath);
  }
  if (existsSync(hubFilePath)) {
    unlinkSync(hubFilePath);
  }

  // Hub lives only as long as some layer is exposed. State was just cleared,
  // so no layer is active — stop the hub. (Layer switch doesn't go through
  // here; that path reuses the running hub.)
  if (!opts.skipHub) {
    const stopped = await stopHub({ ...(opts.hubStopOpts ?? {}), configDir, log });
    if (stopped) log("✓ hub stopped.");
  }

  log(`✓ ${layerLabel(layer)} exposure removed.`);
  return 0;
}

export async function exposeTailnet(action: "up" | "off", opts: ExposeOpts = {}): Promise<number> {
  return action === "off" ? exposeOff("tailnet", opts) : exposeUp("tailnet", opts);
}

export async function exposePublic(action: "up" | "off", opts: ExposeOpts = {}): Promise<number> {
  return action === "off" ? exposeOff("public", opts) : exposeUp("public", opts);
}
