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
import { defaultPortProbe, readHubPort } from "../hub-control.ts";
import { deriveHubOrigin } from "../hub-origin.ts";
import { HUB_UNIT_DEFAULT_PORT } from "../hub-unit.ts";
import { HUB_PATH, writeHubFile } from "../hub.ts";
import { shortNameForManifest } from "../service-spec.ts";
import { type ServiceEntry, readManifest } from "../services-manifest.ts";
import { type ServeEntry, bringupCommand, teardownCommand } from "../tailscale/commands.ts";
import { getFqdn, isTailscaleInstalled } from "../tailscale/detect.ts";
import { type Runner, defaultRunner } from "../tailscale/run.ts";
import { clearVaultHubOrigin } from "../vault-hub-origin-env.ts";
import type { VaultAuthStatus } from "../vault/auth-status.ts";
import {
  WELL_KNOWN_MOUNT,
  WELL_KNOWN_PATH,
  buildWellKnown,
  shortName,
  writeWellKnownFile,
} from "../well-known.ts";
import { printPublic2FAWarning } from "./expose-2fa-warning.ts";
import {
  type ExposeSupervisorOpts,
  ensureHubUnitForExpose,
  resolveExposeSupervisor,
  restartHubDependentViaSupervisor,
} from "./expose-supervisor.ts";

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
  configDir?: string;
  port?: number;
  log?: (line: string) => void;
  /** Override detected FQDN — primarily for tests. */
  fqdnOverride?: string;
  /** Skip ensuring the hub unit. Tests seed a `hub.port` and flip this on. */
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
  /**
   * Override `~/.parachute/vault` for the 2FA-enrollment probe on the public
   * (Funnel) layer. Tests point at a tmp dir; production omits and the probe
   * defaults to the resolved vault home. (#186)
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
   * `expose` "ensures the hub" by ensuring the UNIT is up (not a detached spawn),
   * the post-expose hub-dependent restart drives the running Supervisor over the
   * loopback module-ops API, and `expose off` leaves the hub RUNNING (a managed
   * hub with Restart=always/KeepAlive would just respawn a stopped one — D3).
   * A box with no hub unit gets `ensureHubUnit`'s actionable "run `parachute
   * migrate`" message rather than a detached spawn.
   *
   * The production CLI dispatch passes `supervisor: {}` so the real
   * `isHubUnitInstalled` probe resolves the seams; tests inject the seams they
   * want to assert.
   */
  supervisor?: ExposeSupervisorOpts;
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
  const configDir = opts.configDir ?? CONFIG_DIR;
  const port = opts.port ?? 443;
  const log = opts.log ?? ((line) => console.log(line));
  const funnel = layer === "public";
  // §4.3: ensure the hub UNIT is up (it guarantees loopback reachability) +
  // restart hub-dependent services via the Supervisor. The detached arm was
  // retired in Phase 5b.
  const sup = resolveExposeSupervisor(opts.supervisor);

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
    // §4.3a: "ensure the hub" = ensure the hub UNIT is up. The unit guarantees
    // the hub is reachable on loopback (all tailscale needs); it pins the
    // canonical 1939 (no walking fallback), so that's the target. Phase 5b
    // retired the detached `ensureHubRunning` bringup — a box with no hub unit
    // gets `ensureHubUnit`'s actionable "run `parachute migrate`" message, never
    // a detached spawn.
    const probePort = readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT;
    const ensured = await ensureHubUnitForExpose(sup, probePort, log);
    if (!ensured.ok) return 1;
    hubPort = ensured.port;
    log(`✓ hub unit up (port ${hubPort}).`);
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

  // 2FA-enrollment warning, public-layer only. /admin/login became reachable
  // from every layer when 0.5.3-rc.1 collapsed the access-control matrix into
  // the hub; on Funnel that means the open internet, where 2FA is the
  // defense beyond #188's rate-limit floor. Tailnet exposure stays
  // tailscale-authed at the ingress so the warning is moot there. See #186.
  if (layer === "public") {
    printPublic2FAWarning({
      log,
      publicUrl: canonicalOrigin,
      ...(opts.vaultHome !== undefined ? { vaultHome: opts.vaultHome } : {}),
      ...(opts.vaultAuthStatus !== undefined ? { status: opts.vaultAuthStatus } : {}),
    });
  }

  // Auto-restart services that cache the hub origin. Aaron hit this on launch
  // day: after `expose public` first-run, vault kept its stale (loopback)
  // PARACHUTE_HUB_ORIGIN, the OAuth issuer didn't match what clients saw, and
  // claude.ai MCP failed with a cryptic "Couldn't reach the MCP server". The
  // old output told the user to restart manually; it got buried in the wall
  // of expose output. Do the restart ourselves.
  // §4.3c: the hub-dependent restart goes through the running Supervisor
  // (`driveModuleOp(short, "restart")`), which re-injects the hub's current
  // origin; the origin self-heal (operator-token iss + vault `.env`) fires there.
  // Phase 5b retired the detached `lifecycle.restart` arm.
  for (const short of HUB_DEPENDENT_SHORTS) {
    log("");
    log(`Restarting ${short} to pick up new hub origin…`);
    const rcode = await restartHubDependentViaSupervisor({
      short,
      hubOrigin,
      configDir,
      sup,
      log,
    });
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
  // D3 (§4.3a): `expose off` tears down ONLY the exposure layer and leaves the
  // hub running — the hub is a persistent platform unit now, so stopping it
  // would just be respawned by the manager. The detached `stopHub` arm was
  // retired in Phase 5b, so there is no longer any hub-lifecycle dispatch here.

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
  // Drop the persisted PARACHUTE_HUB_ORIGIN from vault's `.env`. `expose up`
  // (via the vault restart) persisted the public origin so the launchd /
  // systemd daemon validates `iss` against it. With exposure gone, a
  // local-only hub mints loopback-`iss` tokens, so a stale public origin left
  // in `.env` would itself cause the mismatch on the next daemon restart.
  // Reverting to vault's loopback default (`getHubOrigin`) keeps them aligned.
  clearVaultHubOrigin(configDir, log);
  // Pair to the debug-only write at expose-up — clean up the inspection artifact
  // on teardown so it doesn't outlive the layer it described.
  if (existsSync(wellKnownFilePath)) {
    unlinkSync(wellKnownFilePath);
  }
  if (existsSync(hubFilePath)) {
    unlinkSync(hubFilePath);
  }

  // D3 (§4.3a) — `expose off` no longer stops the hub. The hub is a persistent
  // platform unit (Restart=always / KeepAlive) that runs whether or not a layer
  // is exposed: the "hub exists only while exposed" invariant inverted under the
  // supervised model, and the detached `stopHub` arm was retired in Phase 5b
  // (stopping it would just be respawned by the manager). We tear down ONLY the
  // exposure layer above and leave the hub running.

  log(`✓ ${layerLabel(layer)} exposure removed.`);
  return 0;
}

export async function exposeTailnet(action: "up" | "off", opts: ExposeOpts = {}): Promise<number> {
  return action === "off" ? exposeOff("tailnet", opts) : exposeUp("tailnet", opts);
}

export async function exposePublic(action: "up" | "off", opts: ExposeOpts = {}): Promise<number> {
  return action === "off" ? exposeOff("public", opts) : exposeUp("public", opts);
}
