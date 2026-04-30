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
  return {
    pid: requirePositiveInt(r, "pid", path),
    tunnelUuid: requireString(r, "tunnelUuid", path),
    tunnelName: requireString(r, "tunnelName", path),
    hostname: requireString(r, "hostname", path),
    startedAt: requireString(r, "startedAt", path),
    configPath: requireString(r, "configPath", path),
  };
}

function validate(raw: unknown, path: string): CloudflaredState {
  if (!raw || typeof raw !== "object") {
    throw new CloudflaredStateError(`${path}: root must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (r.version === 1) {
    // v1 — single record at top level. Migrate by wrapping it under its
    // tunnelName. Disk isn't rewritten until the next write.
    const record = validateRecord(r, path);
    return { version: 2, tunnels: { [record.tunnelName]: record } };
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
  return { version: 2, tunnels };
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
  return { version: 2, tunnels };
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
