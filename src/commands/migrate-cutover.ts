/**
 * `parachute migrate --to-supervised` (and `--teardown`) — the idempotent
 * detached→supervised CUTOVER, Phase 5a of the hub-as-supervisor unification
 * (design `parachute.computer/design/2026-06-01-hub-as-supervisor-unification.md`
 * §7.1–§7.5).
 *
 * This file is the MACHINERY; the BRIDGE stays intact. After 5a an un-migrated
 * box still works on the detached path (`defaultSpawner` / `ensureHubRunning`
 * remain — Phase 5b retires them). The cutover is opt-in (`--to-supervised`) or
 * auto-offered (§7.5, in `lifecycle.ts`). It NEVER runs implicitly.
 *
 * The cutover is the most dangerous operation in the CLI: it stops real running
 * services and installs a process-manager unit. So the ORDERING is load-bearing
 * and the whole path is FAIL-SAFE + RESUMABLE:
 *
 *   §7.1 ordering (stop-detached-FIRST-then-start-unit, to dodge the port-1939
 *   double-spawn race the canonical-ports 1939-pin would turn into a crash-loop):
 *     1. DETECT the current model (detached hub alive? each module alive?). If a
 *        hub unit already exists AND the hub is supervised → idempotent no-op.
 *     2. WRITE the unit file WITHOUT starting it (`installManagedUnit start:false`
 *        — daemon-reload but NOT enable --now / bootstrap). This is the §7.1
 *        race-avoider: the unit is on disk + resumable, but no second hub is
 *        started yet.
 *     3. STOP the detached processes — `stopHub` for the hub, a per-module
 *        pidfile stop for each module.
 *     4. §7.2 ORPHAN SWEEP — lsof per services.json port + the hub port; adopt +
 *        kill any process still bound to a declared port (mirrors stopHub's 1939
 *        orphan-adoption, per-module-port).
 *     5. VERIFY the hub port + each module port is free (bounded poll). If a port
 *        won't free, FAIL leaving the unit written-but-not-started so a retry is
 *        clean.
 *     6. START the unit (`installManagedUnit start:true` / enable --now). The hub
 *        comes up on a free 1939 and boots modules from services.json.
 *     7. VERIFY the hub answers /health and the expected modules are running.
 *     8. The cloudflared connector (if any) is left intact — it's its own unit.
 *
 * RESUMABILITY: a partial cutover (unit written, not started) is the canonical
 * recoverable state. Re-running `--to-supervised` from there:
 *   - DETECT sees a unit installed but the hub NOT supervised (no /health) → it
 *     does NOT no-op; it re-runs steps 2-7. Step 2 (write start:false) is
 *     idempotent (overwrites the same file), the stop steps are no-ops if the
 *     detached procs already died, and step 6 brings the unit up.
 *
 * FAIL-SAFE: every failure leaves a recoverable state. The only states we refuse
 * to leave the box in are (a) detached-stopped + unit-failed-to-start + no
 * recovery path. Step 6's start-failure leaves the unit written (re-runnable);
 * step 5's port-won't-free fails BEFORE stopping nothing-more and before
 * starting, with the unit written for a clean retry.
 *
 * EVERYTHING is behind injectable seams (the `CutoverDeps`) so the destructive
 * tests run in a sandbox `PARACHUTE_HOME` with NO real Bun.spawn / systemctl /
 * launchctl / lsof / process kills.
 */

import { fileURLToPath } from "node:url";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  HUB_DEFAULT_PORT,
  type KillFn,
  type PidOnPortFn,
  type StopHubOpts,
  defaultKill,
  defaultPidOnPort,
  stopHub,
} from "../hub-control.ts";
import {
  type HubUnitDeps,
  type InstallAndStartHubUnitOpts,
  type InstallAndStartHubUnitResult,
  defaultHubUnitDeps,
  hubUnitMessages,
  installAndStartHubUnit,
  isHubUnitInstalled,
} from "../hub-unit.ts";
import {
  HUB_LAUNCHD_LABEL,
  HUB_SYSTEMD_UNIT_NAME,
  type ManagedUnit,
  type ManagedUnitDeps,
  type ManagedUnitRemoveResult,
  buildHubManagedUnit,
  installManagedUnit,
  removeManagedUnit,
} from "../managed-unit.ts";
import { type PortListeningFn, defaultPortListening } from "../port-probe.ts";
import { type AliveFn, clearPid, defaultAlive, readPid } from "../process-state.ts";
import { shortNameForManifest } from "../service-spec.ts";
import { type ServiceEntry, readManifestLenient } from "../services-manifest.ts";

/**
 * Absolute path to this hub checkout's `src/cli.ts` — the entry the hub unit's
 * `ExecStart`/`ProgramArguments` runs `serve` against. This file is
 * `src/commands/migrate-cutover.ts`, so `cli.ts` is one directory up. Mirrors
 * `init.ts`'s `defaultHubCliPath`.
 */
export function defaultHubCliPath(): string {
  return fileURLToPath(new URL("../cli.ts", import.meta.url));
}

/**
 * Injectable side-effect seam for the cutover. Production wires the real
 * implementations; tests inject fakes so no real process is stopped, no real
 * unit installed, no real port probed.
 */
export interface CutoverDeps {
  /** Process-liveness probe (pidfile readers + this = "is the detached proc alive?"). */
  alive: AliveFn;
  /** Send a signal to a pid (orphan-sweep kill). */
  kill: KillFn;
  /** Which pid is bound to a port (orphan-sweep lsof). */
  pidOnPort: PidOnPortFn;
  /** TCP connect-probe for the verify-ports-free + verify-hub-ready steps. */
  portListening: PortListeningFn;
  /** Stop the detached hub (SIGTERM→SIGKILL + 1939 orphan adoption). */
  stopHub: (opts: StopHubOpts) => Promise<boolean>;
  /**
   * Install + start the hub unit (the §7.1 step-6 start). Calls
   * `installAndStartHubUnit` in production. The cutover does NOT call
   * `installManagedUnit start:false` directly for the WRITE step — instead it
   * reuses the higher-level builder so the env capture / bun resolution / readiness
   * wait all match `init`. See `writeUnitWithoutStarting`.
   */
  installAndStartHubUnit: (
    opts: InstallAndStartHubUnitOpts,
  ) => Promise<InstallAndStartHubUnitResult>;
  /**
   * Write the hub unit file WITHOUT starting it (§7.1 step 2 — the race-avoider).
   * Production builds the descriptor + calls `installManagedUnit(start:false)`;
   * tests stub it. Returns true on a successful write (or fallback-but-recoverable),
   * false when even the write failed (no unit on disk → not resumable here).
   */
  writeUnitWithoutStarting: (opts: WriteUnitOpts) => WriteUnitResult;
  /** Is a hub unit file installed? (the §7.1 step-1 detect discriminant). */
  isHubUnitInstalled: (deps: HubUnitDeps) => boolean;
  /** Probe whether the loopback hub answers /health (detect "supervised" + verify). */
  probeHealth: (port: number) => Promise<boolean>;
  /** Sleep between port-free / readiness polls (tests pin to 0). */
  sleep: (ms: number) => Promise<void>;
  /** The hub-unit deps for install / detect / manager calls. */
  hubUnitDeps: HubUnitDeps;
}

export interface WriteUnitOpts {
  parachuteHome: string;
  cliPath: string;
  port: number;
  deps: HubUnitDeps;
}

export interface WriteUnitResult {
  /** True when the unit file is on disk (resumable). False = write failed. */
  written: boolean;
  /** "installed" (file on disk) or "fallback" (no manager / write failed). */
  outcome: "installed" | "fallback";
  messages: string[];
}

/**
 * Production `writeUnitWithoutStarting`: build the hub `ManagedUnit` descriptor
 * (captures the operator's current PARACHUTE_HOME per §4.2, resolves abs bun)
 * and `installManagedUnit(start:false)` — daemon-reload / write-the-plist but
 * NEVER enable --now / bootstrap. The §7.1 step-2 race-avoider.
 */
function defaultUnitPath(bunInstall: string): string {
  return `${bunInstall}/bin:/usr/local/bin:/usr/bin:/bin`;
}

export function defaultWriteUnitWithoutStarting(opts: WriteUnitOpts): WriteUnitResult {
  const { deps } = opts;
  const bunInstall = `${deps.homeDir()}/.bun`;
  const path = defaultUnitPath(bunInstall);
  const logPath = `${opts.parachuteHome}/hub/logs/hub.log`;
  let unit: ManagedUnit;
  try {
    unit = buildHubManagedUnit({
      parachuteHome: opts.parachuteHome,
      port: opts.port,
      bunInstall,
      path,
      cliPath: opts.cliPath,
      logPath,
      deps,
    });
  } catch (err) {
    // `bun` couldn't be resolved — refuse to bake a broken ExecStart. No unit on
    // disk: not resumable from here (the caller surfaces it as a hard failure).
    return {
      written: false,
      outcome: "fallback",
      messages: [err instanceof Error ? err.message : String(err)],
    };
  }
  const res = installManagedUnit({
    unit,
    deps,
    messages: hubUnitMessages(),
    start: false,
  });
  // `installed` → the file is on disk (resumable). `fallback` → no manager /
  // write failed; the messages explain. We treat a `fallback` whose cause is
  // "no manager" as not-written (can't host a unit), and a write-failed fallback
  // likewise — both leave no usable unit on disk.
  return {
    written: res.outcome === "installed",
    outcome: res.outcome,
    messages: res.messages,
  };
}

export const defaultCutoverDeps: CutoverDeps = {
  alive: defaultAlive,
  kill: defaultKill,
  pidOnPort: defaultPidOnPort,
  portListening: defaultPortListening,
  stopHub,
  installAndStartHubUnit,
  writeUnitWithoutStarting: defaultWriteUnitWithoutStarting,
  isHubUnitInstalled,
  probeHealth: defaultHubUnitDeps.probeHealth,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  hubUnitDeps: defaultHubUnitDeps,
};

export interface CutoverOpts {
  configDir?: string;
  manifestPath?: string;
  /** Hub port (default 1939). */
  port?: number;
  /** Absolute cli.ts path the unit runs `serve` against (default resolved here). */
  cliPath?: string;
  log?: (line: string) => void;
  deps?: Partial<CutoverDeps>;
  /** Port-free / readiness budget in ms (default 15s). */
  timeoutMs?: number;
  /** Poll interval in ms (default 250). */
  pollMs?: number;
}

export type CutoverOutcome =
  /** A hub unit already exists AND the hub answers /health → nothing to do. */
  | "already-migrated"
  /** The full cutover ran end-to-end and the hub is supervised + healthy. */
  | "migrated"
  /** No service manager (container / init-less) — cutover is impossible here. */
  | "no-manager"
  /** A declared port wouldn't free; unit written-but-not-started, re-runnable. */
  | "port-stuck"
  /** The unit failed to start; written-but-not-started, re-runnable. */
  | "start-failed"
  /** The unit came up but never answered /health within the budget. */
  | "verify-timeout"
  /** Couldn't even write the unit file (e.g. bun unresolvable). */
  | "write-failed";

export interface CutoverResult {
  outcome: CutoverOutcome;
  /** The hub port. */
  port: number;
  messages: string[];
}

/** A module's short name + the port it declares in services.json. */
interface ModuleTarget {
  short: string;
  port: number;
}

/** Read each services.json module's short name + declared port (lenient). */
function moduleTargets(manifestPath: string): ModuleTarget[] {
  let services: ServiceEntry[];
  try {
    services = readManifestLenient(manifestPath).services;
  } catch {
    return [];
  }
  const out: ModuleTarget[] = [];
  for (const entry of services) {
    const short = shortNameForManifest(entry.name) ?? entry.name;
    out.push({ short, port: entry.port });
  }
  return out;
}

/**
 * Stop a single detached module by its pidfile (mirrors lifecycle.ts's detached
 * stop arm). SIGTERM → bounded wait → SIGKILL → clear pidfile. A missing/stale
 * pidfile is a no-op. Returns true when the module is now stopped.
 */
async function stopDetachedModule(
  target: ModuleTarget,
  configDir: string,
  deps: CutoverDeps,
  killWaitMs: number,
  pollMs: number,
  log: (line: string) => void,
): Promise<void> {
  const pid = readPid(target.short, configDir);
  if (pid === undefined) return;
  if (!deps.alive(pid)) {
    clearPid(target.short, configDir);
    return;
  }
  try {
    deps.kill(pid, "SIGTERM");
  } catch {
    // Gone between alive() and kill(); treat as stopped.
    clearPid(target.short, configDir);
    return;
  }
  const deadline = Date.now() + killWaitMs;
  while (Date.now() < deadline && deps.alive(pid)) {
    if (pollMs > 0) await deps.sleep(pollMs);
    else break;
  }
  if (deps.alive(pid)) {
    log(`  ${target.short} didn't exit; sending SIGKILL.`);
    try {
      deps.kill(pid, "SIGKILL");
    } catch {
      // Racing a just-exited process.
    }
  }
  clearPid(target.short, configDir);
  log(`  ✓ stopped ${target.short}`);
}

/**
 * §7.2 orphan sweep: lsof a port, and if a live process is bound to it, adopt +
 * kill it (mirrors stopHub's 1939 orphan-adoption, per-module-port). A
 * stale-pidfile-but-alive module won't be found by `readPid` → without this it
 * stays bound → the supervised re-spawn hits EADDRINUSE.
 */
function sweepOrphanOnPort(
  port: number,
  label: string,
  deps: CutoverDeps,
  log: (line: string) => void,
): void {
  const orphan = deps.pidOnPort(port);
  if (orphan === undefined) return;
  if (!deps.alive(orphan)) return;
  log(`  orphan on ${label} port ${port} (PID ${orphan}) — stopping it.`);
  try {
    deps.kill(orphan, "SIGTERM");
  } catch {
    // Already gone.
    return;
  }
  // Best-effort SIGKILL follow-up if still alive (no long wait — the
  // verify-ports-free step below polls + escalates the failure if it persists).
  if (deps.alive(orphan)) {
    try {
      deps.kill(orphan, "SIGKILL");
    } catch {
      // Racing a just-exited process.
    }
  }
}

/**
 * Poll a port until nothing is listening on it (bounded). Returns true when the
 * port is free, false on timeout. The §7.1 step-5 race-guard: the unit must not
 * start until 1939 (and each module port) is released, or the new hub crash-loops
 * on EADDRINUSE under Restart=always.
 */
async function waitPortFree(
  port: number,
  deps: CutoverDeps,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await deps.portListening(port))) return true;
    if (Date.now() >= deadline) break;
    if (pollMs > 0) await deps.sleep(pollMs);
    else break;
  }
  return !(await deps.portListening(port));
}

/**
 * Poll the hub /health until it answers (bounded). The §7.1 step-7 verify.
 */
async function waitHubHealthy(
  port: number,
  deps: CutoverDeps,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await deps.probeHealth(port)) return true;
    if (Date.now() >= deadline) break;
    if (pollMs > 0) await deps.sleep(pollMs);
    else break;
  }
  return deps.probeHealth(port);
}

/**
 * The idempotent detached→supervised cutover (§7.1). See the file header for the
 * ordering + fail-safe + resumability contract. Returns a structured outcome;
 * the CLI maps it to an exit code + messaging.
 */
export async function cutoverToSupervised(opts: CutoverOpts = {}): Promise<CutoverResult> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const port = opts.port ?? HUB_DEFAULT_PORT;
  const cliPath = opts.cliPath ?? defaultHubCliPath();
  const log = opts.log ?? ((line) => console.log(line));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;
  const deps: CutoverDeps = { ...defaultCutoverDeps, ...(opts.deps ?? {}) };

  const targets = moduleTargets(manifestPath);

  // --- Step 1: DETECT the current model (and the idempotent no-op). ---
  const unitInstalled = deps.isHubUnitInstalled(deps.hubUnitDeps);
  const hubHealthy = await deps.probeHealth(port);
  if (unitInstalled && hubHealthy) {
    // A unit exists AND the hub answers /health → already supervised. No-op.
    return {
      outcome: "already-migrated",
      port,
      messages: ["Already migrated — a supervised hub unit is installed and healthy."],
    };
  }

  log("Migrating to the supervised model (parachute serve under a process manager).");
  if (unitInstalled) {
    // A unit is on disk but the hub isn't answering — a partial/failed prior
    // cutover (unit written, not started), or the unit is stopped. Resume.
    log("Found a hub unit already written (resuming a prior cutover).");
  }

  // --- Step 2: WRITE the unit WITHOUT starting it (the §7.1 race-avoider). ---
  log("Writing the hub unit file (not starting it yet)…");
  const write = deps.writeUnitWithoutStarting({
    parachuteHome: configDir,
    cliPath,
    port,
    deps: deps.hubUnitDeps,
  });
  for (const m of write.messages) log(`  ${m}`);
  if (!write.written) {
    if (write.outcome === "fallback") {
      // No service manager on this host (container / init-less) — there is no
      // unit to install; the runtime here is foreground `serve`. Bail cleanly
      // WITHOUT having stopped anything (we're still before step 3).
      return {
        outcome: "no-manager",
        port,
        messages: [
          "This host has no service manager (systemd/launchd) — the supervised model needs one.",
          "Run `parachute serve` in the foreground, or use a platform that provides a manager.",
          ...write.messages,
        ],
      };
    }
    // The write itself failed (e.g. bun unresolvable). Nothing stopped yet —
    // safe to bail.
    return {
      outcome: "write-failed",
      port,
      messages: ["Could not write the hub unit file — no changes made.", ...write.messages],
    };
  }

  // --- Step 3: STOP the detached processes (hub FIRST is not required vs
  // modules, but we stop the hub then each module so children of the detached
  // hub, if any, are released before their ports are swept). ---
  log("Stopping the detached hub + modules…");
  const stopped = await deps.stopHub({ configDir, log: (l) => log(`  ${l}`) });
  if (stopped) log("  ✓ stopped the detached hub");
  for (const target of targets) {
    await stopDetachedModule(target, configDir, deps, timeoutMs, pollMs, log);
  }

  // --- Step 4: §7.2 ORPHAN SWEEP — per services.json port + the hub port. ---
  log("Sweeping orphaned processes still bound to declared ports…");
  sweepOrphanOnPort(port, "hub", deps, log);
  for (const target of targets) {
    sweepOrphanOnPort(target.port, target.short, deps, log);
  }

  // --- Step 5: VERIFY the hub port + each module port is free. ---
  // Fail leaving the unit written-but-not-started so a retry is clean (§7.1).
  log("Verifying ports are free before starting the unit…");
  const portsToCheck: Array<{ port: number; label: string }> = [
    { port, label: "hub" },
    ...targets.map((t) => ({ port: t.port, label: t.short })),
  ];
  for (const p of portsToCheck) {
    const free = await waitPortFree(p.port, deps, timeoutMs, pollMs);
    if (!free) {
      return {
        outcome: "port-stuck",
        port,
        messages: [
          `Port ${p.port} (${p.label}) is still held after stopping the detached processes.`,
          "The hub unit is written but NOT started — your box is unchanged except the unit file.",
          `Find what's holding the port (\`lsof -iTCP:${p.port}\`), stop it, then re-run \`parachute migrate --to-supervised\`.`,
        ],
      };
    }
  }

  // --- Step 6: START the unit (enable --now / bootstrap). ---
  log("Starting the hub unit…");
  const started = await deps.installAndStartHubUnit({
    parachuteHome: configDir,
    cliPath,
    port,
    log: (l) => log(`  ${l}`),
  });
  if (started.outcome === "no-manager") {
    // The manager vanished between step 2 and step 6 (extremely unlikely), or
    // the install degraded. The detached procs are stopped + the unit is on
    // disk → re-runnable once the manager is available. Surface clearly.
    return {
      outcome: "start-failed",
      port,
      messages: [
        "Could not start the hub unit via the service manager.",
        "The unit file is written; re-run `parachute migrate --to-supervised` once the service manager is available,",
        "or run `parachute serve` in the foreground.",
        ...started.messages,
      ],
    };
  }
  if (started.outcome !== "started") {
    // `timeout` / `start-failed` — the unit was (re)installed but the hub didn't
    // become ready. Re-runnable; surface the unit log the helper tailed.
    return {
      outcome: started.outcome === "timeout" ? "verify-timeout" : "start-failed",
      port,
      messages: [
        "The hub unit was started but the hub didn't come up cleanly.",
        "Re-run `parachute migrate --to-supervised`, or check `parachute logs hub`.",
        ...started.messages,
      ],
    };
  }

  // --- Step 7: VERIFY the hub answers /health. ---
  log("Verifying the supervised hub is healthy…");
  const healthy = await waitHubHealthy(port, deps, timeoutMs, pollMs);
  if (!healthy) {
    return {
      outcome: "verify-timeout",
      port,
      messages: [
        `The hub unit started but did not answer /health on 127.0.0.1:${port}.`,
        "Re-run `parachute migrate --to-supervised`, or check `parachute logs hub`.",
        ...started.messages,
      ],
    };
  }

  // --- Step 8: the cloudflared connector (if any) is left intact — it's its
  // own unit; tailscale needs nothing. (Nothing to do here — documented for the
  // reader; the connector unit is never touched by the hub cutover.) ---

  return {
    outcome: "migrated",
    port,
    messages: [
      "✓ Migrated to the supervised model.",
      "The hub now runs under your platform's process manager (it survives reboots),",
      "and modules are supervised children that boot from services.json.",
      "Per-module CLI verbs (`parachute start|stop|restart <svc>`) now drive the running hub.",
    ],
  };
}

// ---------------------------------------------------------------------------
// §7.4 teardown — the rollback path.
// ---------------------------------------------------------------------------

export interface TeardownOpts {
  log?: (line: string) => void;
  /** Injectable managed-unit deps (default production). */
  deps?: ManagedUnitDeps;
  /** Test seam: the removeManagedUnit implementation. */
  remove?: (opts: {
    launchdLabel: string;
    systemdUnitName: string;
    deps: ManagedUnitDeps;
    removedLaunchdMessage: (label: string) => string;
    removedSystemdMessage: (unitName: string) => string;
  }) => ManagedUnitRemoveResult;
}

/**
 * `parachute migrate --teardown` (§7.4) — remove the hub unit. Idempotent +
 * best-effort: a missing unit is a no-op; tool failures never throw (the
 * teardown must always succeed at clearing state). This is the ROLLBACK path if
 * the cutover misbehaves: tear down the unit and the operator falls back to a
 * foreground `serve` (or the still-intact detached path, until Phase 5b).
 *
 * NOTE: this removes the HUB unit only. It deliberately does NOT remove the
 * cloudflared connector unit (independent; `expose off --cloudflare` owns that),
 * and it does NOT re-spawn the detached hub — the operator decides what runtime
 * to fall back to.
 */
export function teardownHubUnit(opts: TeardownOpts = {}): { removed: boolean; messages: string[] } {
  const log = opts.log ?? ((line) => console.log(line));
  const deps = opts.deps ?? defaultHubUnitDeps;
  const remove = opts.remove ?? removeManagedUnit;
  const res = remove({
    launchdLabel: HUB_LAUNCHD_LABEL,
    systemdUnitName: HUB_SYSTEMD_UNIT_NAME,
    deps,
    removedLaunchdMessage: (label) =>
      `Removed launchd LaunchAgent ${label} — the hub no longer starts on login/boot.`,
    removedSystemdMessage: (unitName) =>
      `Removed systemd unit ${unitName} — the hub no longer starts on boot.`,
  });
  if (res.removed) {
    for (const m of res.messages) log(m);
    log("");
    log("The supervised hub unit is gone. To run the hub now, either:");
    log("  - `parachute serve` (foreground), or");
    log("  - `parachute migrate --to-supervised` to reinstall the unit.");
  } else {
    log("No hub unit was installed — nothing to tear down.");
  }
  return res;
}
