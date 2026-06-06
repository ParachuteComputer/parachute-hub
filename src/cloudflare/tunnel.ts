import { join } from "node:path";
import type { CommandResult, Runner } from "../tailscale/run.ts";

export class CloudflaredError extends Error {
  override name = "CloudflaredError";
  constructor(
    message: string,
    public readonly cmd: readonly string[],
    public readonly result: CommandResult,
  ) {
    super(message);
  }
}

export interface Tunnel {
  id: string;
  name: string;
  createdAt?: string;
}

function combineErrStreams(result: CommandResult): string {
  const e = result.stderr.trim();
  if (e.length > 0) return e;
  return result.stdout.trim();
}

/**
 * Parse `cloudflared tunnel list --output json`. The schema is stable: an
 * array of objects each with `id` (UUID) and `name`. We ignore extra fields.
 * Entries missing either id or name are skipped rather than thrown — keeps
 * us forward-compatible with cloudflared adding new tunnel shapes.
 */
export async function listTunnels(runner: Runner): Promise<Tunnel[]> {
  const cmd = ["cloudflared", "tunnel", "list", "--output", "json"];
  const result = await runner(cmd);
  if (result.code !== 0) {
    throw new CloudflaredError(
      `cloudflared tunnel list failed: ${combineErrStreams(result)}`,
      cmd,
      result,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new CloudflaredError(
      `failed to parse cloudflared tunnel list JSON: ${err instanceof Error ? err.message : String(err)}`,
      cmd,
      result,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CloudflaredError("cloudflared tunnel list did not return a JSON array", cmd, result);
  }
  const tunnels: Tunnel[] = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : undefined;
    const name = typeof r.name === "string" ? r.name : undefined;
    if (!id || !name) continue;
    const t: Tunnel = { id, name };
    if (typeof r.created_at === "string") t.createdAt = r.created_at;
    tunnels.push(t);
  }
  return tunnels;
}

export async function findTunnelByName(runner: Runner, name: string): Promise<Tunnel | undefined> {
  const tunnels = await listTunnels(runner);
  return tunnels.find((t) => t.name === name);
}

/**
 * `cloudflared tunnel create <name>` writes credentials to
 * `~/.cloudflared/<UUID>.json` and prints a line like
 *
 *   Created tunnel parachute with id 2c1a7c7e-…-b3ef7c1d9a2a
 *
 * We parse the UUID from stdout rather than requiring callers to walk the
 * credentials dir afterward — less filesystem coupling, and the UUID format
 * is stable (RFC 4122 lowercase hex).
 */
export async function createTunnel(runner: Runner, name: string): Promise<Tunnel> {
  const cmd = ["cloudflared", "tunnel", "create", name];
  const result = await runner(cmd);
  if (result.code !== 0) {
    throw new CloudflaredError(
      `cloudflared tunnel create failed: ${combineErrStreams(result)}`,
      cmd,
      result,
    );
  }
  const match = result.stdout.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (!match) {
    throw new CloudflaredError(
      `could not parse tunnel UUID from cloudflared output: ${result.stdout.trim()}`,
      cmd,
      result,
    );
  }
  return { id: match[1]!, name };
}

/**
 * `--overwrite-dns` turns the route command into an idempotent UPSERT: without
 * it, cloudflared exits non-zero when the CNAME already exists, which breaks
 * every rerun on the same hostname (and the error surface — "add the domain to
 * Cloudflare" — is actively wrong in that case). The destination is always the
 * caller's tunnel, so overwriting a pre-existing CNAME that points somewhere
 * else is the right move; the user explicitly asked for this hostname to
 * reach this tunnel.
 */
export async function routeDns(
  runner: Runner,
  tunnelName: string,
  hostname: string,
): Promise<void> {
  const cmd = ["cloudflared", "tunnel", "route", "dns", "--overwrite-dns", tunnelName, hostname];
  const result = await runner(cmd);
  if (result.code !== 0) {
    throw new CloudflaredError(
      `cloudflared tunnel route dns failed: ${combineErrStreams(result)}`,
      cmd,
      result,
    );
  }
}

export function credentialsPath(uuid: string, cloudflaredHome: string): string {
  return join(cloudflaredHome, `${uuid}.json`);
}

/**
 * `cloudflared tunnel delete <name>` removes the account-side tunnel. Used by
 * the reuse-path self-heal (#593): when an existing tunnel's local credentials
 * file is missing, the tunnel is unusable from this machine — we delete the
 * account-side tunnel and recreate it so `tunnel create` re-writes a fresh
 * `~/.cloudflared/<uuid>.json`.
 *
 * `--force` makes the delete non-interactive and tears down any lingering
 * connector record cloudflared still has registered for the tunnel — without
 * it, `tunnel delete` refuses ("tunnel has active connections") when a stale
 * connector is registered account-side, which is exactly the crash-loop state
 * #593 self-heals. Deleting a tunnel with no live local connector is safe: the
 * field repro showed `tunnel delete` + re-run worked cleanly.
 */
export async function deleteTunnel(runner: Runner, name: string): Promise<void> {
  const cmd = ["cloudflared", "tunnel", "delete", "--force", name];
  const result = await runner(cmd);
  if (result.code !== 0) {
    throw new CloudflaredError(
      `cloudflared tunnel delete failed: ${combineErrStreams(result)}`,
      cmd,
      result,
    );
  }
}

/**
 * Count the active connector connections cloudflared reports for a tunnel via
 * `cloudflared tunnel info --output json <name>`. Used by the post-start
 * connection verification (#593): a spawned connector pid existing ≠ the
 * connector actually registered an edge connection (the error-1033 field
 * repro — pid alive, connector crash-looping on a missing creds file, every
 * request 1033).
 *
 * The JSON shape is `{ conns: [ { ... }, … ] }` (or a top-level `connections`
 * array on some cloudflared versions). We count entries defensively across
 * both shapes and treat any parse/CLI failure as `0` (not-yet-connected) — the
 * caller polls, so a transient miss just costs one more poll. Returns the
 * connector count; `> 0` means at least one edge connection is live.
 */
export async function tunnelConnectionCount(runner: Runner, name: string): Promise<number> {
  const cmd = ["cloudflared", "tunnel", "info", "--output", "json", name];
  let result: CommandResult;
  try {
    result = await runner(cmd);
  } catch {
    return 0;
  }
  if (result.code !== 0) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object") return 0;
  const obj = parsed as Record<string, unknown>;
  // `cloudflared tunnel info --output json` reports per-connector entries under
  // `conns` on current versions; older shapes used a flat `connections` array.
  // Count whichever is present.
  const conns = obj.conns ?? obj.connections;
  if (Array.isArray(conns)) {
    // Each entry may itself carry a nested `conns` array (per-colo connector
    // detail). Count an entry as a live connection when it exists; that's the
    // signal we need ("the connector registered at least one edge connection").
    return conns.length;
  }
  return 0;
}
