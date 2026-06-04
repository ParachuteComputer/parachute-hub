/**
 * Per-vault usage fetch for the friend-facing `/account/` home.
 *
 * Vault serves `GET /vault/<name>/.parachute/usage` (read-scoped) returning a
 * footprint report (vault#437):
 *   { counts: { notes, attachments, links, tags },
 *     bytes:  { content, db, assets, mirror?, total },
 *     computedAt, cached }
 *
 * The `/account/` GET handler renders one tile per assigned vault; this module
 * fetches each vault's usage so the tile can show a compact "X notes · Y MB"
 * stat. The READ scope means the assigned user's OWN authority suffices — we
 * mint a short-lived `vault:<name>:read` token (the same authority the OAuth
 * issuer would grant them) and call the vault over loopback.
 *
 * Tolerant by design: any failure (vault down, endpoint absent on an older
 * vault, mint failure, malformed JSON) resolves to `null` so the tile simply
 * omits the stat rather than breaking the page. Usage is a nice-to-have on a
 * friend's home, never load-bearing.
 *
 * Injectable seams (`fetchImpl`, `signToken`) keep it unit-testable without a
 * live vault or real signing key.
 */
import type { Database } from "bun:sqlite";
import { signAccessToken } from "./jwt-sign.ts";

/** The subset of vault's usage report the `/account/` tile renders. */
export interface VaultUsageStat {
  notes: number;
  /** Physical footprint bytes (`bytes.total` from the vault report). */
  totalBytes: number;
}

/** Short TTL for the read token — it's used immediately for one loopback call. */
const USAGE_READ_TOKEN_TTL_SECONDS = 60;

export interface FetchVaultUsageDeps {
  db: Database;
  /** Hub origin — `iss` of the minted read token. */
  hubOrigin: string;
  /** Loopback port the vault backend listens on (from services.json). */
  vaultPort: number;
  /** The user minting against their own read authority — `sub` of the token. */
  userId: string;
  /** Test seam — `globalThis.fetch` in production. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to the real `signAccessToken`. */
  signToken?: typeof signAccessToken;
  /** Test seam for the clock. */
  now?: () => Date;
}

/**
 * Fetch one vault's usage stat for the friend's tile, or `null` on any failure.
 *
 * Mints a `vault:<name>:read` bearer for `userId` (capped to that one vault via
 * `vaultScope`) and GETs the vault's loopback usage endpoint. Never throws —
 * the page renders without the stat on any error.
 */
export async function fetchVaultUsage(
  vaultName: string,
  deps: FetchVaultUsageDeps,
): Promise<VaultUsageStat | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sign = deps.signToken ?? signAccessToken;
  try {
    const scope = `vault:${vaultName}:read`;
    const minted = await sign(deps.db, {
      sub: deps.userId,
      scopes: [scope],
      audience: `vault.${vaultName}`,
      clientId: "parachute-account",
      issuer: deps.hubOrigin,
      ttlSeconds: USAGE_READ_TOKEN_TTL_SECONDS,
      vaultScope: [vaultName],
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    const url = `http://127.0.0.1:${deps.vaultPort}/vault/${vaultName}/.parachute/usage`;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${minted.token}`, accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      counts?: { notes?: unknown };
      bytes?: { total?: unknown };
    };
    const notes = body.counts?.notes;
    const totalBytes = body.bytes?.total;
    if (typeof notes !== "number" || typeof totalBytes !== "number") return null;
    return { notes, totalBytes };
  } catch {
    return null;
  }
}

/**
 * Format a usage stat as the compact "X notes · Y MB" string the tile shows.
 * Bytes render in the largest sensible unit (B / KB / MB / GB) with one
 * decimal for MB+ and whole numbers below. Notes are pluralized.
 *
 * Exported for direct unit testing + reuse by the renderer.
 */
export function formatUsageStat(stat: VaultUsageStat): string {
  const noteLabel = stat.notes === 1 ? "note" : "notes";
  return `${stat.notes} ${noteLabel} · ${formatBytes(stat.totalBytes)}`;
}

/** Human-readable byte size — B / KB / MB / GB, one decimal for MB+. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}
