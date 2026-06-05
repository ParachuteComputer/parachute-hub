import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../config.ts";

export const CLOUDFLARED_STATE_PATH = join(CONFIG_DIR, "cloudflared-state.json");

/**
 * Per-tunnel state. The fields that used to live at the top of the file in
 * v1 (#32) — pid, hostname, etc. — now hang off a per-tunnel record so we
 * can track multiple coexisting Cloudflare tunnels on one box.
 */
export interface CloudflaredTunnelRecord {
  pid: number;
  tunnelUuid: string;
  tunnelName: string;
  hostname: string;
  /** ISO-8601 start timestamp — debugging only. */
  startedAt: string;
  /** Absolute path to the cloudflared config.yml driving this tunnel. */
  configPath: string;
  /**
   * True when a reboot-persistent OS service (launchd/systemd) owns this
   * connector (0.6.2). Drives the off-path to remove the service (not just
   * SIGTERM the pid — a still-enabled service would otherwise restart the
   * connector it just killed). Optional + defaults false so pre-0.6.2 state
   * files (and the transient-fallback path) validate + read as unmanaged.
   */
  serviceManaged?: boolean;
}

/**
 * v2 (current) — keys tunnels by name so a host can run multiple tunnels.
 *
 * v1 had a single record at top level. `readCloudflaredState` migrates v1
 * files in place: parses the legacy shape, wraps the record under its
 * `tunnelName`, returns v2. The next write commits the migration to disk.
 */
export interface CloudflaredState {
  version: 2;
  tunnels: Record<string, CloudflaredTunnelRecord>;
  /**
   * A hostname the operator typed in the interactive Cloudflare flow that
   * hasn't been routed yet (hub#567). Persisted as soon as it validates so a
   * mid-chain failure (cloudflared missing, login, tunnel/DNS error) doesn't
   * discard it — the next interactive run pre-fills the hostname prompt with
   * it. Cleared once routing succeeds (the tunnel record then carries the live
   * hostname). Optional + free-floating from the per-tunnel records.
   */
  pendingHostname?: string;
}

export class CloudflaredStateError extends Error {
  override name = "CloudflaredStateError";
}

function requireString(r: Record<string, unknown>, key: string, path: string): string {
  const v = r[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new CloudflaredStateError(`${path}: ${key} must be a non-empty string`);
  }
  return v;
}

function requirePositiveInt(r: Record<string, unknown>, key: string, path: string): number {
  const v = r[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new CloudflaredStateError(`${path}: ${key} must be a positive integer`);
  }
  return v;
}

function validateRecord(raw: unknown, path: string): CloudflaredTunnelRecord {
  if (!raw || typeof raw !== "object") {
    throw new CloudflaredStateError(`${path}: tunnel record must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const record: CloudflaredTunnelRecord = {
    pid: requirePositiveInt(r, "pid", path),
    tunnelUuid: requireString(r, "tunnelUuid", path),
    tunnelName: requireString(r, "tunnelName", path),
    hostname: requireString(r, "hostname", path),
    startedAt: requireString(r, "startedAt", path),
    configPath: requireString(r, "configPath", path),
  };
  // Optional — present from 0.6.2 onward. A non-boolean (or absent) value
  // reads as unmanaged so legacy state files keep validating.
  if (r.serviceManaged === true) record.serviceManaged = true;
  return record;
}

function validate(raw: unknown, path: string): CloudflaredState {
  if (!raw || typeof raw !== "object") {
    throw new CloudflaredStateError(`${path}: root must be an object`);
  }
  const r = raw as Record<string, unknown>;
  // hub#567: an optional top-level `pendingHostname` (a typed-but-not-yet-routed
  // hostname). Non-string / empty values read as absent so older state files
  // keep validating.
  const pendingHostname =
    typeof r.pendingHostname === "string" && r.pendingHostname.length > 0
      ? r.pendingHostname
      : undefined;
  const withPending = (state: CloudflaredState): CloudflaredState =>
    pendingHostname ? { ...state, pendingHostname } : state;

  if (r.version === 1) {
    // v1 — single record at top level. Migrate by wrapping it under its
    // tunnelName. Disk isn't rewritten until the next write.
    const record = validateRecord(r, path);
    return withPending({ version: 2, tunnels: { [record.tunnelName]: record } });
  }
  if (r.version !== 2) {
    throw new CloudflaredStateError(`${path}: unsupported version ${String(r.version)}`);
  }
  if (!r.tunnels || typeof r.tunnels !== "object") {
    throw new CloudflaredStateError(`${path}: tunnels must be an object`);
  }
  const tunnels: Record<string, CloudflaredTunnelRecord> = {};
  for (const [key, val] of Object.entries(r.tunnels as Record<string, unknown>)) {
    const record = validateRecord(val, `${path}.tunnels.${key}`);
    if (record.tunnelName !== key) {
      throw new CloudflaredStateError(
        `${path}: tunnels.${key}.tunnelName must equal its key (got "${record.tunnelName}")`,
      );
    }
    tunnels[key] = record;
  }
  return withPending({ version: 2, tunnels });
}

export function readCloudflaredState(
  path: string = CLOUDFLARED_STATE_PATH,
): CloudflaredState | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new CloudflaredStateError(
      `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validate(raw, path);
}

export function writeCloudflaredState(
  state: CloudflaredState,
  path: string = CLOUDFLARED_STATE_PATH,
): void {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

export function clearCloudflaredState(path: string = CLOUDFLARED_STATE_PATH): void {
  if (existsSync(path)) unlinkSync(path);
}

/** Look up a tunnel record by name. */
export function findTunnelRecord(
  state: CloudflaredState | undefined,
  tunnelName: string,
): CloudflaredTunnelRecord | undefined {
  return state?.tunnels[tunnelName];
}

/** Pure: insert/replace the record in state under its tunnelName. */
export function withTunnelRecord(
  state: CloudflaredState | undefined,
  record: CloudflaredTunnelRecord,
): CloudflaredState {
  const tunnels = { ...(state?.tunnels ?? {}), [record.tunnelName]: record };
  // Preserve any pending hostname (hub#567); the caller clears it explicitly
  // via `clearPendingHostname` once routing fully succeeds.
  return state?.pendingHostname
    ? { version: 2, tunnels, pendingHostname: state.pendingHostname }
    : { version: 2, tunnels };
}

/**
 * Pure: set the pending (typed-but-not-routed) hostname on the state (hub#567).
 * Seeds an empty v2 state when none exists yet.
 */
export function withPendingHostname(
  state: CloudflaredState | undefined,
  hostname: string,
): CloudflaredState {
  return { version: 2, tunnels: state?.tunnels ?? {}, pendingHostname: hostname };
}

/**
 * Pure: drop the pending hostname (hub#567). Returns undefined when the result
 * would carry no tunnels either, so the caller can `clearCloudflaredState`
 * rather than write an empty file.
 */
export function withoutPendingHostname(
  state: CloudflaredState | undefined,
): CloudflaredState | undefined {
  if (!state) return undefined;
  if (Object.keys(state.tunnels).length === 0) return undefined;
  return { version: 2, tunnels: state.tunnels };
}

/**
 * Read the pending hostname from the on-disk state (hub#567). Returns undefined
 * when there's no state file or no pending hostname. Swallows read/parse errors
 * (a corrupt state file must not abort the prompt — we just don't pre-fill).
 */
export function readPendingHostname(path: string = CLOUDFLARED_STATE_PATH): string | undefined {
  try {
    return readCloudflaredState(path)?.pendingHostname;
  } catch {
    return undefined;
  }
}

/**
 * Persist a typed-but-not-yet-routed hostname (hub#567), preserving existing
 * tunnel records. Best-effort: a write failure must not abort the expose flow.
 */
export function writePendingHostname(
  hostname: string,
  path: string = CLOUDFLARED_STATE_PATH,
): void {
  try {
    const state = readCloudflaredState(path);
    writeCloudflaredState(withPendingHostname(state, hostname), path);
  } catch {
    // Non-fatal — persistence is a convenience, not a correctness requirement.
  }
}

/**
 * Clear the pending hostname once routing succeeds (hub#567). If no tunnel
 * records remain, removes the state file entirely. Best-effort.
 */
export function clearPendingHostname(path: string = CLOUDFLARED_STATE_PATH): void {
  try {
    const state = readCloudflaredState(path);
    if (!state?.pendingHostname) return;
    const next = withoutPendingHostname(state);
    if (next) writeCloudflaredState(next, path);
    else clearCloudflaredState(path);
  } catch {
    // Non-fatal.
  }
}

/**
 * Pure: drop the named tunnel from state. Returns undefined when the result
 * would be empty so callers can `clearCloudflaredState` instead of writing
 * an empty file.
 */
export function withoutTunnelRecord(
  state: CloudflaredState | undefined,
  tunnelName: string,
): CloudflaredState | undefined {
  if (!state) return undefined;
  const { [tunnelName]: _dropped, ...rest } = state.tunnels;
  if (Object.keys(rest).length === 0) return undefined;
  return { version: 2, tunnels: rest };
}

/** All tunnel records, in name-sorted order so output is deterministic. */
export function listTunnelRecords(state: CloudflaredState | undefined): CloudflaredTunnelRecord[] {
  if (!state) return [];
  return Object.keys(state.tunnels)
    .sort()
    .map((k) => state.tunnels[k]) as CloudflaredTunnelRecord[];
}
