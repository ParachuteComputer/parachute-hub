#!/usr/bin/env bun
/**
 * The detached one-shot hub-upgrade helper (design 2026-06-01 §5.3 / D4).
 *
 * ── WHY A SEPARATE, DETACHED PROCESS ───────────────────────────────────────
 *
 * `POST /api/hub/upgrade` can't rewrite + restart the hub from inside the
 * request handler: restarting the hub kills the very process serving the
 * request, so the response would die with the old binary before it could
 * report success. The resolution (§5.3): the endpoint spawns THIS helper with
 * `detached: true` + `proc.unref()` — the ONE legitimate detached process in
 * the unified model, *because it must outlive the hub it's upgrading*. The
 * helper owns the restart; the request handler returns 202 immediately.
 *
 * Detached + unref'd means: no controlling terminal tie, its own process
 * group, and the parent (hub) exiting does NOT deliver SIGHUP/SIGTERM to it.
 * So when the helper later tears the hub down, it keeps running to completion.
 *
 * ── WHAT IT DOES ───────────────────────────────────────────────────────────
 *
 *   1. Mark the on-disk status file `running` (the SPA polls it — it's a FILE,
 *      not the in-memory ops registry, precisely because the hub goes down
 *      mid-upgrade; see hub-upgrade-status.ts).
 *   2. Rewrite the hub binary — REUSES `upgrade("hub", …)` from commands/
 *      upgrade.ts (the channel-aware `bun add -g @openparachute/hub@<channel>`
 *      / linked git-pull + downgrade guard). No duplicated rewrite logic.
 *   3. Trigger the platform-appropriate restart:
 *      - **unit-managed (VM/Mac)** → `restartHubUnit` (systemctl restart /
 *        launchctl kickstart -k). The manager tears the old hub down, starts
 *        the new binary, which re-boots every module from services.json.
 *      - **container (no unit manager)** → the runtime re-runs CMD on the
 *        hub's exit, so the helper sends the old hub a graceful SIGTERM (the
 *        `serve` loop's SIGTERM handler stops children + the server cleanly,
 *        then the process exits → the runtime brings it back on the rewritten
 *        binary). The hub PID is passed in via `--hub-pid`.
 *
 * The `upgrade("hub", …)` call ALSO does the unit restart itself on a
 * unit-managed box (its Phase-4 dual-dispatch — `supervisor: {}` opts into the
 * `restartHubUnit` arm). So on VM/Mac the helper's rewrite step already
 * restarts the unit; the helper does NOT double-restart. On a container,
 * `upgrade` finds no unit (its restart arm degrades to the no-unit fallback,
 * which is a detached lifecycle restart we DON'T want here) — so the helper
 * passes `restartFn: noop` to upgrade and owns the container restart itself
 * via the SIGTERM path. This keeps the restart authority unambiguous per
 * platform.
 *
 * ── TESTABILITY ────────────────────────────────────────────────────────────
 *
 * `runHubUpgradeHelper` is the pure, injectable core. Every side effect — the
 * status writes, the `upgrade()` call, the unit restart, the container exit
 * signal — is a seam, so the rewrite-then-restart sequence + the container
 * graceful-exit path are unit-tested with NO real `bun add -g`, NO real
 * systemctl, and NO real process signal. Only the thin argv-parsing `main()`
 * at the bottom touches the real OS, and it's only reached when this file is
 * the entrypoint (`import.meta.main`).
 */

import { type UpgradeOpts, upgrade as realUpgrade } from "./commands/upgrade.ts";
import { CONFIG_DIR } from "./config.ts";
import {
  type HubUnitDeps,
  type HubUnitManagerOpResult,
  defaultHubUnitDeps,
  isHubUnitInstalled,
  restartHubUnit as realRestartHubUnit,
} from "./hub-unit.ts";
import {
  type HubUpgradeStatus,
  appendHubUpgradeStatus,
  readHubUpgradeStatus,
} from "./hub-upgrade-status.ts";

export interface HubUpgradeHelperArgs {
  /** Operation id (matches the status file's `operation_id`). */
  operationId: string;
  /** Closed-enum channel (validated by the endpoint before spawn). */
  channel: "rc" | "latest";
  /** PARACHUTE_HOME (where the status file + services.json live). */
  configDir: string;
  /**
   * The PID of the hub process to gracefully terminate on the container path.
   * Undefined on the unit-managed path (the manager owns the restart there).
   */
  hubPid?: number;
}

/** Injectable side-effect seams (production wires the real impls). */
export interface HubUpgradeHelperDeps {
  /** Rewrite the hub binary. Production proxies to `commands/upgrade.ts`. */
  upgrade?: (svc: string, opts: UpgradeOpts) => Promise<number>;
  /** Is a hub unit installed? (Decides unit-managed vs container restart.) */
  isHubUnitInstalled?: (deps: HubUnitDeps) => boolean;
  /** Restart the hub unit (unit-managed path). */
  restartHubUnit?: (deps: HubUnitDeps) => HubUnitManagerOpResult;
  /** Deps for the unit probes/ops. */
  hubUnitDeps?: HubUnitDeps;
  /**
   * Send the graceful-exit signal to the hub (container path). Production
   * `process.kill(pid, "SIGTERM")`; tests record the call.
   */
  signalHub?: (pid: number, signal: NodeJS.Signals) => void;
  /** Append to the on-disk status file (test seam). */
  appendStatus?: (
    configDir: string,
    patch: Partial<Pick<HubUpgradeStatus, "phase" | "error">>,
    logLine?: string,
  ) => void;
}

/**
 * The pure helper core: rewrite the hub binary, then trigger the platform
 * restart. Returns a terminal exit code (0 = restart dispatched / success).
 * Records progress to the status file throughout.
 */
export async function runHubUpgradeHelper(
  args: HubUpgradeHelperArgs,
  deps: HubUpgradeHelperDeps = {},
): Promise<number> {
  const upgrade = deps.upgrade ?? realUpgrade;
  const unitInstalledFn = deps.isHubUnitInstalled ?? isHubUnitInstalled;
  const restartUnit = deps.restartHubUnit ?? realRestartHubUnit;
  const hubUnitDeps = deps.hubUnitDeps ?? defaultHubUnitDeps;
  const signalHub = deps.signalHub ?? ((pid, signal) => process.kill(pid, signal));
  const append = deps.appendStatus ?? appendHubUpgradeStatus;
  const { configDir } = args;

  append(configDir, { phase: "running" }, `hub-upgrade helper started (op ${args.operationId})`);

  const unitManaged = unitInstalledFn(hubUnitDeps);

  // ── Rewrite the binary ───────────────────────────────────────────────────
  // REUSE commands/upgrade.ts for the channel-aware rewrite (bun add -g
  // @openparachute/hub@<channel> / linked git-pull + downgrade guard) — but
  // REWRITE ONLY: suppress upgrade's own restart with a no-op `restartFn`. The
  // HELPER owns the restart explicitly below (the spec's "the helper owns the
  // restart"), so the restart authority is unambiguous per platform rather than
  // buried in upgrade.ts's dual-dispatch. `supervisor` is intentionally omitted
  // so upgrade takes its detached arm with our no-op restartFn (a pure rewrite,
  // no lifecycle restart fired).
  const upgradeOpts: UpgradeOpts = {
    channel: args.channel,
    configDir,
    restartFn: async () => 0,
    log: (line) => append(configDir, {}, line),
  };

  let code: number;
  try {
    code = await upgrade("hub", upgradeOpts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    append(configDir, { phase: "failed", error: msg }, `hub-upgrade failed: ${msg}`);
    return 1;
  }

  if (code !== 0) {
    append(
      configDir,
      { phase: "failed", error: `upgrade exited ${code}` },
      `hub-upgrade rewrite failed (exit ${code}) — binary NOT restarted`,
    );
    return code;
  }

  // ── Restart (helper-owned) ───────────────────────────────────────────────
  if (unitManaged) {
    // VM/Mac: restart the hub UNIT via the platform manager (systemctl restart
    // / launchctl kickstart -k). The manager tears the old hub down (children
    // die), starts the new binary, which re-boots every module from
    // services.json. NEVER a PID signal — launchd KeepAlive / systemd
    // Restart=always would fight it (R17). We mark `restarting`; we canNOT
    // reliably write `succeeded` — the new hub's version is the SPA's success
    // signal (it polls /health + /api/hub), not our file.
    const res = restartUnit(hubUnitDeps);
    for (const m of res.messages) append(configDir, {}, m);
    if (res.outcome !== "ok") {
      append(
        configDir,
        { phase: "failed", error: `hub unit restart ${res.outcome}` },
        `hub binary rewritten but the unit restart ${res.outcome} — restart it manually`,
      );
      return 1;
    }
    append(
      configDir,
      { phase: "restarting" },
      "hub unit restarted via the service manager — the SPA polls /health + version for the new binary",
    );
    return 0;
  }

  // Container path: the rewrite landed on the persistent disk (the endpoint
  // already gated on mode === "in-place"; an image-pinned hub never spawns a
  // helper). Now signal the hub to exit gracefully so the container runtime
  // re-runs CMD (`serve`) on the rewritten binary. The hub's SIGTERM handler
  // (cli.ts serve case) stops supervised children + the server cleanly, then
  // the process exits and the runtime brings it back.
  append(
    configDir,
    { phase: "restarting" },
    "container: signalling the hub to exit gracefully so the runtime restarts it on the new binary",
  );
  if (args.hubPid !== undefined && Number.isFinite(args.hubPid) && args.hubPid > 0) {
    try {
      signalHub(args.hubPid, "SIGTERM");
    } catch (err) {
      // The hub may have already exited (a racing restart). Not fatal — the
      // rewrite is done; the runtime will bring it back on the new binary
      // regardless. Record + succeed.
      const msg = err instanceof Error ? err.message : String(err);
      append(configDir, {}, `hub graceful-exit signal noted as already-gone (${msg})`);
    }
  } else {
    append(
      configDir,
      {},
      "no hub pid provided — relying on the platform runtime's own restart to pick up the new binary",
    );
  }
  return 0;
}

// ── Entrypoint (only runs when invoked directly as `bun hub-upgrade-helper.ts`) ──

function parseArgs(argv: string[]): HubUpgradeHelperArgs | { error: string } {
  let operationId: string | undefined;
  let channel: string | undefined;
  let configDir: string | undefined;
  let hubPid: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--op":
        operationId = next;
        i++;
        break;
      case "--channel":
        channel = next;
        i++;
        break;
      case "--config-dir":
        configDir = next;
        i++;
        break;
      case "--hub-pid":
        if (next !== undefined) hubPid = Number(next);
        i++;
        break;
      default:
        return { error: `unexpected argument "${arg}"` };
    }
  }
  if (!operationId) return { error: "--op <id> is required" };
  if (channel !== "rc" && channel !== "latest") {
    return { error: `--channel must be "rc" or "latest" (got "${channel ?? ""}")` };
  }
  const resolved: HubUpgradeHelperArgs = {
    operationId,
    channel,
    configDir: configDir ?? CONFIG_DIR,
  };
  if (hubPid !== undefined && Number.isFinite(hubPid)) resolved.hubPid = hubPid;
  return resolved;
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`hub-upgrade-helper: ${parsed.error}`);
    return 2;
  }
  // If the endpoint never seeded the status file (it always should), bail
  // visibly rather than silently no-op'ing.
  if (!readHubUpgradeStatus(parsed.configDir)) {
    console.error(
      `hub-upgrade-helper: no status file for op ${parsed.operationId} under ${parsed.configDir}`,
    );
    return 2;
  }
  return await runHubUpgradeHelper(parsed);
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("hub-upgrade-helper: fatal", err);
      process.exit(1);
    });
}
