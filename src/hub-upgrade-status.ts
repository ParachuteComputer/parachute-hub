/**
 * The on-disk status file for an in-flight `POST /api/hub/upgrade` operation
 * (design 2026-06-01 §5.3 / D4).
 *
 * WHY A FILE, NOT THE IN-MEMORY OPERATIONS REGISTRY: a hub-upgrade tears the
 * hub DOWN mid-operation (the whole point — the new binary has to take over).
 * The module-ops `InMemoryOperationsRegistry` is process-local and evaporates
 * when the hub restarts, so it CANNOT carry hub-upgrade progress across the
 * restart the SPA is polling through. A JSON file under `PARACHUTE_HOME`
 * survives the hub bounce: the detached helper writes progress to it while the
 * old hub is dying, and the NEW hub reads it back to answer
 * `GET /api/hub/upgrade/status`. (On a container the file lives on the
 * persistent disk — same place the DB + module installs live.)
 *
 * The file is single-slot (one upgrade at a time — there is only one hub). A
 * stale file from a prior upgrade is simply overwritten when a new one starts.
 *
 * Wire shape mirrors the module-ops `Operation` enough that the SPA's polling
 * code reads familiarly: `status` + `log` + `error` + timestamps, plus the
 * hub-specific `mode` / `target_version` / `channel` the SPA branches on.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HubUpgradeMode } from "./hub-upgrade-mode.ts";

/** Phases of a hub-upgrade, polled by the SPA. */
export type HubUpgradeStatusPhase =
  /** The endpoint accepted the request + spawned the helper; not started yet. */
  | "pending"
  /** The helper is rewriting the binary / about to restart. */
  | "running"
  /**
   * The rewrite + restart were dispatched. The SPA now switches to polling
   * `/health` + the reported version directly — the helper may not get to
   * write a terminal state (the hub it would report to is being torn down).
   */
  | "restarting"
  /**
   * Terminal success. RESERVED / SPA-INFERRED: the helper does NOT write this —
   * it can't reliably record `succeeded` before the hub bounce tears down the
   * process. The SPA infers success from `/health` + the reported version
   * (HubUpgradeCard), not from this phase. Kept in the enum so the SPA success
   * detection + the 409 in-flight guard's terminal-phase check can reference it.
   */
  | "succeeded"
  /** Terminal failure (rewrite failed, downgrade refused, etc.). */
  | "failed"
  /**
   * The endpoint determined the hub is image-pinned (redeploy-required) and did
   * NOT spawn a helper — there's no in-place upgrade to run. The SPA shows
   * "redeploy from your platform dashboard" instead of a progress spinner.
   */
  | "redeploy-required";

export interface HubUpgradeStatus {
  /** Opaque id minted by the endpoint; echoed in the 202 body for polling. */
  operation_id: string;
  phase: HubUpgradeStatusPhase;
  /** In-place vs redeploy-required (the §5.3 detection result). */
  mode: HubUpgradeMode;
  /** The version the operator is currently on (read at request time). */
  current_version: string;
  /** Best-effort resolved target version (`npm view`), or null if unknown. */
  target_version: string | null;
  /** Closed-enum channel the rewrite targets. */
  channel: "rc" | "latest";
  /** Sparse progress log, appended by the helper. */
  log: string[];
  /** Error message when `phase === "failed"`. */
  error?: string;
  started_at: string;
  finished_at?: string;
}

/** Path of the single-slot hub-upgrade status file under `configDir`. */
export function hubUpgradeStatusPath(configDir: string): string {
  return join(configDir, "hub-upgrade-status.json");
}

/**
 * Atomically write the status file (write-temp + rename) so a poll that lands
 * mid-write never sees a half-serialized JSON. Creates the parent dir if
 * absent (a never-initialized PARACHUTE_HOME).
 */
export function writeHubUpgradeStatus(configDir: string, status: HubUpgradeStatus): void {
  const path = hubUpgradeStatusPath(configDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Read the current status file, or null when none exists / is unreadable.
 * Lenient: a malformed file reads as null (the SPA falls back to polling
 * `/health` directly), never throws.
 */
export function readHubUpgradeStatus(configDir: string): HubUpgradeStatus | null {
  const path = hubUpgradeStatusPath(configDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && "operation_id" in parsed) {
      return parsed as HubUpgradeStatus;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append a log line + (optionally) advance the phase, persisting atomically.
 * Used by the helper to record progress the SPA polls. A missing file (the
 * endpoint should always seed it first) is a no-op rather than a throw — the
 * helper's job is the upgrade, not bookkeeping.
 *
 * OPERATION GUARD: `operationId` is the op the caller (helper) was spawned
 * with. The status file is single-slot — a newer `POST /api/hub/upgrade` will
 * overwrite it with a fresh `operation_id`. A still-running helper from the
 * SUPERSEDED operation must not clobber the newer operation's status with its
 * stale progress. So we only write when the on-disk `operation_id` still
 * matches `operationId`; otherwise the append is a NO-OP (the newer operation
 * owns the slot now). This makes concurrent-upgrade status-file corruption
 * impossible from the helper side.
 */
export function appendHubUpgradeStatus(
  configDir: string,
  operationId: string,
  patch: Partial<Pick<HubUpgradeStatus, "phase" | "error">>,
  logLine?: string,
): void {
  const current = readHubUpgradeStatus(configDir);
  if (!current) return;
  // A newer operation superseded this one — do NOT clobber its status.
  if (current.operation_id !== operationId) return;
  const next: HubUpgradeStatus = { ...current };
  if (patch.phase) next.phase = patch.phase;
  if (patch.error !== undefined) next.error = patch.error;
  if (logLine) next.log = [...current.log, logLine];
  // `succeeded` is reserved/SPA-inferred (see HubUpgradeStatusPhase) — the
  // helper can't reliably write it before the hub bounce, so in practice only
  // `failed` reaches this branch. Both terminal phases stamp `finished_at`.
  if (patch.phase === "succeeded" || patch.phase === "failed") {
    next.finished_at = new Date().toISOString();
  }
  writeHubUpgradeStatus(configDir, next);
}
