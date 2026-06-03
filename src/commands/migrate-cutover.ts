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

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import {
  HUB_DEFAULT_PORT,
  type KillFn,
  type PidOnPortFn,
  type StopHubOpts,
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
import { type AliveFn, clearPid, readPid } from "../process-state.ts";
import { shortNameForManifest } from "../service-spec.ts";
import { type ServiceEntry, readManifestLenient } from "../services-manifest.ts";
import { enrichedUnitPath } from "../spawn-path.ts";
import {
  type DisableStaleModuleUnitsOpts,
  type DisableStaleModuleUnitsResult,
  disableStaleModuleUnits,
} from "../stale-module-units.ts";

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
 * Best-effort command-line probe for a pid (the orphan-sweep ownership check).
 * Returns the process's command line, or undefined when it can't be read. See
 * `CutoverDeps.ownerOfPid`.
 */
export type OwnerProbeFn = (pid: number) => string | undefined;

/**
 * Production `ownerOfPid`: `ps -o command= -p <pid>` returns the full argv of the
 * process (one line). macOS + Linux both ship `ps` and accept `-o command=` (the
 * trailing `=` suppresses the header). Any failure — `ps` missing, pid gone,
 * permission, garbage — returns undefined so the caller treats the orphan as
 * UNATTRIBUTABLE (and refuses to kill it). Mirrors `defaultPidOnPort`'s
 * shell-out-and-swallow shape.
 */
export const defaultOwnerOfPid: OwnerProbeFn = (pid) => {
  try {
    const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (result.status !== 0) return undefined;
    const line = result.stdout
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    return line === undefined || line.length === 0 ? undefined : line;
  } catch {
    return undefined;
  }
};

/**
 * Injectable side-effect seam for the cutover. Production wires the real
 * implementations; tests inject fakes so no real process is stopped, no real
 * unit installed, no real port probed.
 */
export interface CutoverDeps {
  /** Process-liveness probe (pidfile readers + this = "is the detached proc alive?"). */
  alive: AliveFn;
  /** Send a signal to a pid (orphan-sweep kill). Group-aware (negative-pid) by default. */
  kill: KillFn;
  /** Which pid is bound to a port (orphan-sweep lsof). */
  pidOnPort: PidOnPortFn;
  /**
   * Best-effort command-line of a pid (the orphan-sweep ownership probe). Returns
   * the process's argv joined (e.g. `bun .../server.ts --port 1940`) or undefined
   * when it can't be read (pid gone, permission, no `ps`). Used by
   * `sweepOrphanOnPort` to decide whether an orphan holding a MODULE port is
   * plausibly that parachute module before adopting + killing it — so the cutover
   * never blind-kills an operator's unrelated process that happens to squat a
   * declared port. Injectable so tests drive attribution without shelling to `ps`.
   */
  ownerOfPid: OwnerProbeFn;
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
  /**
   * Detect + DISABLE any stale per-module autostart unit (#522 — the load-bearing
   * fix). A leftover standalone `parachute-<short>.service` (systemd KeepAlive) /
   * `computer.parachute.<short>` (launchd KeepAlive) from the pre-supervisor era
   * keeps RESPAWNING an unsupervised module that binds the module's port — the
   * supervised child then EADDRINUSE-crash-loops. Killing the process is
   * whack-a-mole (the unit resurrects it); we must disable the UNIT. Run in the
   * STOP phase (after the per-module detached stop, before the port-free verify)
   * so the freed port lets the supervised module bind. Ownership-safe (known
   * module shorts only; hub + cloudflared skipped), idempotent, non-fatal.
   * Injectable so tests never touch real systemctl/launchctl.
   */
  disableStaleModuleUnits: (opts?: DisableStaleModuleUnitsOpts) => DisableStaleModuleUnitsResult;
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
  /**
   * On a `fallback`, WHY — so the caller maps to the right `CutoverOutcome`
   * instead of conflating the two causes (the MUST-FIX NIT: a bun-not-found /
   * write failure previously surfaced as the wrong "no service manager" message,
   * and the `write-failed` outcome was dead):
   *   - "no-manager"  → no systemd/launchd here (the supervised model is impossible);
   *   - "write-failed" → a manager exists but the unit couldn't be written (bun
   *     unresolvable, write/daemon-reload failure).
   * Undefined when `outcome === "installed"`.
   */
  cause?: "no-manager" | "write-failed";
  messages: string[];
}

/**
 * Production `writeUnitWithoutStarting`: build the hub `ManagedUnit` descriptor
 * (captures the operator's current PARACHUTE_HOME per §4.2, resolves abs bun)
 * and `installManagedUnit(start:false)` — daemon-reload / write-the-plist but
 * NEVER enable --now / bootstrap. The §7.1 step-2 race-avoider.
 */
export function defaultWriteUnitWithoutStarting(opts: WriteUnitOpts): WriteUnitResult {
  const { deps } = opts;
  const bunInstall = `${deps.homeDir()}/.bun`;
  // Shared with the init-bringup path (hub-unit.ts) so the two unit-generation
  // sites can't drift — enriches the unit PATH with operator-tool dirs
  // (`$HOME/.local/bin`, brew bin) so a migrated launchd/systemd hub can find
  // scribe's `parakeet-mlx` + `ffmpeg`. See `spawn-path.ts`.
  const path = enrichedUnitPath(bunInstall, deps.homeDir(), deps.platform);
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
    // disk: not resumable from here. A manager may well exist; this is a WRITE
    // failure (can't compose a valid unit), NOT a no-manager host — surface it as
    // such so the operator sees "bun not found / could not write the unit".
    return {
      written: false,
      outcome: "fallback",
      cause: "write-failed",
      messages: [err instanceof Error ? err.message : String(err)],
    };
  }
  const res = installManagedUnit({
    unit,
    deps,
    messages: hubUnitMessages(),
    start: false,
  });
  // `installed` → the file is on disk (resumable). `fallback` → either no manager
  // (host can't host a unit) or the install/write failed (manager present). Thread
  // the manager's `reason` through so the caller distinguishes them; default to
  // "write-failed" if (somehow) absent — the conservative non-no-manager message.
  return {
    written: res.outcome === "installed",
    outcome: res.outcome,
    cause: res.outcome === "fallback" ? (res.reason ?? "write-failed") : undefined,
    messages: res.messages,
  };
}

/**
 * Group-aware kill — INLINED from `lifecycle.ts`'s `defaultKill` (NOT imported,
 * to avoid the import cycle `lifecycle.ts → migrate-offer.ts → migrate-cutover.ts`).
 * MUST stay byte-equivalent to lifecycle's group-aware kill.
 *
 * Modules are spawned `detached: true` by `defaultSpawner` (lifecycle.ts), so the
 * recorded pid is a process-GROUP leader (pid == pgid). A wrapper startCmd like
 * `pnpm exec tsx server.ts` leaves the real server as a GRANDCHILD inside that
 * group. The cutover originally used the BARE-PID `hub-control.ts:defaultKill`
 * (`process.kill(pid, sig)`), which signals only the wrapper — the tsx grandchild
 * survives, keeps holding the module's port, `waitPortFree` times out, and the
 * cutover returns `port-stuck` on the FIRST run for any wrapper-startCmd module
 * (the exact hub#88 footgun). `process.kill(-pid, sig)` signals the whole group;
 * ESRCH (legacy pidfile written before detached-spawn, or the leader already
 * exited and the group emptied) falls back to a bare-pid signal so the intent
 * still lands when there's a positive-pid process to receive it.
 */
const groupAwareKill: KillFn = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    process.kill(pid, signal);
  }
};

/**
 * Group-aware liveness — INLINED from `lifecycle.ts`'s `defaultAlive` (same
 * import-cycle reason as `groupAwareKill`). Returns true if the process GROUP
 * (pgid == pid) still has any member, so the stop-then-wait loop keeps polling
 * until the wrapper AND its grandchild are both gone (the bare-pid
 * `process-state.ts:defaultAlive` would report the leader dead while the
 * grandchild lingers, prematurely clearing the pidfile + skipping the SIGKILL
 * escalation, re-opening the hub#88 port hold). ESRCH on the group probe (legacy
 * pidfile, or the leader exited and the group emptied) falls back to a bare-pid
 * check so a positive-pid process is still honored.
 */
const groupAwareAlive: AliveFn = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const defaultCutoverDeps: CutoverDeps = {
  alive: groupAwareAlive,
  kill: groupAwareKill,
  pidOnPort: defaultPidOnPort,
  ownerOfPid: defaultOwnerOfPid,
  portListening: defaultPortListening,
  stopHub,
  installAndStartHubUnit,
  writeUnitWithoutStarting: defaultWriteUnitWithoutStarting,
  isHubUnitInstalled,
  probeHealth: defaultHubUnitDeps.probeHealth,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  hubUnitDeps: defaultHubUnitDeps,
  disableStaleModuleUnits,
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
 * Decide whether an orphan pid bound to a MODULE port is plausibly attributable
 * to that parachute module — the MUST-FIX-2 guard against blind-killing an
 * operator's unrelated process that merely squats a declared port. Attributable
 * when ANY of:
 *   - the orphan pid equals the module's RECORDED pid (services.json/pidfile);
 *   - its command line mentions `parachute` (any parachute-managed process —
 *     the `~/.parachute/...` install path and the `@openparachute/<mod>`
 *     package name both carry this marker, so it catches every genuine
 *     parachute-managed module);
 *   - its command line mentions the module's start command (when a hint is
 *     supplied — currently always unset at the call site, the seam is kept
 *     for a future services.json-derived start command).
 * An unreadable command line (probe returned undefined) + a non-matching pid is
 * NOT attributable — we refuse to kill it.
 *
 * NOTE: the bare module short-name needle (`vault`/`runner`/`scribe`/`notes`)
 * was deliberately dropped — on the most destructive command (a process KILL),
 * a bare short-name is too loose: a `runner` substring matches an unrelated CI
 * runner squatting the port. The `parachute` marker already attributes every
 * genuine parachute-managed process, so the short-name arm only widened the
 * false-positive surface.
 */
function orphanAttributable(args: {
  orphan: number;
  recordedPid: number | undefined;
  short: string;
  startCmdHint: string | undefined;
  ownerOfPid: OwnerProbeFn;
}): { attributable: boolean; cmdline: string | undefined } {
  const { orphan, recordedPid, startCmdHint, ownerOfPid } = args;
  if (recordedPid !== undefined && orphan === recordedPid) {
    return { attributable: true, cmdline: undefined };
  }
  const cmdline = ownerOfPid(orphan);
  if (cmdline === undefined) return { attributable: false, cmdline: undefined };
  const haystack = cmdline.toLowerCase();
  const needles = ["parachute", ...(startCmdHint ? [startCmdHint.toLowerCase()] : [])].filter(
    (n) => n.length > 0,
  );
  const attributable = needles.some((n) => haystack.includes(n));
  return { attributable, cmdline };
}

/**
 * §7.2 orphan sweep: lsof a port, and if a live process is bound to it, adopt +
 * kill it (mirrors stopHub's 1939 orphan-adoption, per-module-port). A
 * stale-pidfile-but-alive module won't be found by `readPid` → without this it
 * stays bound → the supervised re-spawn hits EADDRINUSE.
 *
 * MUST-FIX 2 — OWNERSHIP CHECK (module ports only): for a declared MODULE port,
 * we refuse to kill an orphan unless it's plausibly attributable to that
 * parachute module (`orphanAttributable`). An operator's own dev server squatting
 * a module's port must NOT be nuked by the cutover — we emit a clear warning and
 * leave it; the subsequent verify-ports-free step turns the still-held port into
 * a `port-stuck` outcome the operator resolves. The HUB port retains the
 * pre-existing blind-adopt behavior (mirrors `stopHub`'s 1939 orphan-adoption) —
 * that scope is unchanged; pass `attribute: undefined` for it.
 *
 * Returns true when the orphan was adopted + signalled (or there was no orphan),
 * false when an UNATTRIBUTABLE process was found + deliberately left running.
 */
function sweepOrphanOnPort(
  port: number,
  label: string,
  deps: CutoverDeps,
  log: (line: string) => void,
  attribute?: { recordedPid: number | undefined; short: string; startCmdHint: string | undefined },
): boolean {
  const orphan = deps.pidOnPort(port);
  if (orphan === undefined) return true;
  if (!deps.alive(orphan)) return true;

  if (attribute !== undefined) {
    const { attributable, cmdline } = orphanAttributable({
      orphan,
      recordedPid: attribute.recordedPid,
      short: attribute.short,
      startCmdHint: attribute.startCmdHint,
      ownerOfPid: deps.ownerOfPid,
    });
    if (!attributable) {
      const desc = cmdline ? `${cmdline}` : "command line unavailable";
      log(
        `  ⚠ port ${port} for ${label} is held by an unrelated process (PID ${orphan}, ${desc}); refusing to kill it.`,
      );
      log(
        "    The cutover only adopts processes it can attribute to this module. Stop that process yourself,",
      );
      log("    then re-run `parachute migrate --to-supervised`.");
      return false;
    }
  }

  log(`  orphan on ${label} port ${port} (PID ${orphan}) — stopping it.`);
  try {
    deps.kill(orphan, "SIGTERM");
  } catch {
    // Already gone.
    return true;
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
  return true;
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
    // Distinguish the two fallback causes (MUST-FIX NIT). Both bail cleanly here —
    // we're still BEFORE step 3, so nothing has been stopped — but with accurate
    // messaging so a bun-not-found / write failure doesn't masquerade as a
    // missing-service-manager host.
    if (write.cause === "no-manager") {
      // No service manager on this host (container / init-less) — there is no
      // unit to install; the runtime here is foreground `serve`.
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
    // The write itself failed (bun unresolvable, or the manager errored writing
    // the unit). A manager may exist — this is NOT a no-manager host.
    return {
      outcome: "write-failed",
      port,
      messages: [
        "Could not write the hub unit file (bun not found, or the service manager errored) — no changes made.",
        ...write.messages,
      ],
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

  // --- Step 3b (#522): DISABLE stale per-module autostart UNITS. ---
  // The load-bearing fix for the recurring "port 1940 taken" crash-loop: a
  // leftover standalone `parachute-<short>.service` (systemd KeepAlive) or
  // `computer.parachute.<short>` (launchd KeepAlive) from the pre-supervisor era
  // keeps RESPAWNING an unsupervised module that binds the port — so the
  // per-module stop above (and the orphan sweep below) is whack-a-mole: the unit
  // resurrects the process within seconds, serving OLD code. We must DISABLE the
  // UNIT so the port stays free for the supervised child. MUST run HERE — after
  // the detached stop, BEFORE the verify-ports-free + unit start — so the freed
  // port lets the supervised module bind. Ownership-safe (known module shorts
  // only; hub + cloudflared skipped), idempotent, non-fatal (a failed disable
  // warns + continues; a system-level unit it can't disable → warn with the
  // manual sudo command). Every disabled unit is reported.
  log("Checking for stale per-module autostart units to disable…");
  deps.disableStaleModuleUnits({ deps: deps.hubUnitDeps, log: (l) => log(l) });

  // --- Step 4: §7.2 ORPHAN SWEEP — per services.json port + the hub port. ---
  // The HUB port keeps the pre-existing blind-adopt (mirrors stopHub's 1939
  // orphan-adoption — out of scope for MUST-FIX 2). The MODULE ports get the
  // ownership check: we read the module's recorded pid (so a still-alive process
  // we already know about is trivially attributable) and only adopt+kill an
  // orphan we can attribute to that parachute module; an UNATTRIBUTABLE squatter
  // is left running with a warning, and the verify-ports-free step turns the
  // still-held port into `port-stuck`.
  log("Sweeping orphaned processes still bound to declared ports…");
  sweepOrphanOnPort(port, "hub", deps, log);
  for (const target of targets) {
    sweepOrphanOnPort(target.port, target.short, deps, log, {
      recordedPid: readPid(target.short, configDir),
      short: target.short,
      startCmdHint: undefined,
    });
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
  /**
   * Test seam: the stale-per-module-autostart disable (#522). Teardown also
   * disables any leftover standalone module autostart unit so a rollback to
   * foreground `serve` doesn't leave a competing module respawning at boot.
   * Injectable so tests never touch real systemctl/launchctl.
   */
  disableStaleModuleUnits?: (opts?: DisableStaleModuleUnitsOpts) => DisableStaleModuleUnitsResult;
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
  const disableStale = opts.disableStaleModuleUnits ?? disableStaleModuleUnits;
  const res = remove({
    launchdLabel: HUB_LAUNCHD_LABEL,
    systemdUnitName: HUB_SYSTEMD_UNIT_NAME,
    deps,
    removedLaunchdMessage: (label) =>
      `Removed launchd LaunchAgent ${label} — the hub no longer starts on login/boot.`,
    removedSystemdMessage: (unitName) =>
      `Removed systemd unit ${unitName} — the hub no longer starts on boot.`,
  });
  // #522: also disable any leftover standalone per-module autostart unit so a
  // rollback to foreground `serve` doesn't leave a competing module respawning at
  // boot to race whatever the operator brings up next. Ownership-safe (known
  // module shorts only; hub + cloudflared skipped), idempotent, non-fatal.
  disableStale({ deps, log });
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
