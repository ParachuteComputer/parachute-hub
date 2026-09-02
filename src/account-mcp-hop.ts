/**
 * Optional session-reuse for account-MCP → vault hop JWTs (hub#918).
 *
 * Default (env unset / empty / unparseable): every `tools/call` mints a
 * fresh 60s token — today's hop. That is capability-shaped and stays
 * under the registered-mint threshold, but the vault's `manage-token`
 * ledger never sees the same principal twice.
 *
 * `PARACHUTE_ACCOUNT_MCP_HOP_TTL_SECONDS=N` (1..599): mint once per
 * `(user, vault, verb, issuer, nostr-pubkey)` and reuse until TTL. Capped strictly
 * below `REGISTERED_MINT_TTL_THRESHOLD_SECONDS` (600) so these hops stay
 * unregistered fire-and-forget. A longer hop needs a tokens-table row —
 * not this module.
 *
 * Invalid values (non-integer, zero, negative, junk) do not enable
 * reuse — fail closed to today's per-call mint. That is the safest
 * option; a typo must not silently change hop lifetime.
 *
 * Clock: 5s remaining is the reuse floor so a token cannot be handed to
 * a vault RPC already inside its expiry skew. A configured TTL of 1–5s
 * therefore never reuses (equivalent to unset for the reuse path).
 */
import { FANOUT_TOKEN_TTL_SECONDS } from "./account-mcp.ts";

/**
 * Must stay strictly below `REGISTERED_MINT_TTL_THRESHOLD_SECONDS` in
 * `admin-connections.ts` (600). Duplicated as a number so this module
 * does not import the connections engine on the MCP hop path. The
 * relationship is pinned in `account-mcp-hop.test.ts`.
 */
export const ACCOUNT_MCP_HOP_TTL_CAP_SECONDS = 599;

const REUSE_FLOOR_MS = 5_000;

export const ACCOUNT_MCP_HOP_TTL_ENV = "PARACHUTE_ACCOUNT_MCP_HOP_TTL_SECONDS";

export interface AccountMcpHopTtl {
  reuse: boolean;
  ttlSeconds: number;
}

interface HopEntry {
  token: string;
  expMs: number;
}

const hops = new Map<string, HopEntry>();

/**
 * Parse the hop-reuse env. Unset / empty / unparseable → reuse off,
 * 60s per-call mint. A well-formed integer ≥ 1 enables reuse, capped
 * at {@link ACCOUNT_MCP_HOP_TTL_CAP_SECONDS}.
 */
export function parseAccountMcpHopTtl(env: NodeJS.ProcessEnv = process.env): AccountMcpHopTtl {
  const raw = env[ACCOUNT_MCP_HOP_TTL_ENV];
  if (raw === undefined) {
    return { reuse: false, ttlSeconds: FANOUT_TOKEN_TTL_SECONDS };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { reuse: false, ttlSeconds: FANOUT_TOKEN_TTL_SECONDS };
  }
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    return { reuse: false, ttlSeconds: FANOUT_TOKEN_TTL_SECONDS };
  }
  const n = Number.parseInt(trimmed, 10);
  return { reuse: true, ttlSeconds: Math.min(n, ACCOUNT_MCP_HOP_TTL_CAP_SECONDS) };
}

export function accountMcpHopReuse(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseAccountMcpHopTtl(env).reuse;
}

export function accountMcpHopTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return parseAccountMcpHopTtl(env).ttlSeconds;
}

/**
 * Cache key for a reusable hop token.
 *
 * `principalPubkey` (hub#936) is load-bearing, not decorative: the vault hop
 * token now carries a `permissions.principal_pubkey` attribution claim, and
 * several agents holding DIFFERENT Nostr keys routinely link to the SAME hub
 * user. Those agents share `(userId, vaultName, verb, issuer)` exactly, so
 * without the pubkey in the key one agent would be handed a cached token
 * stamped with another agent's signer — a silent misattribution, since the
 * token is otherwise perfectly valid. `null` (every non-NIP-98 connection)
 * reproduces the pre-hub#936 key byte-for-byte.
 */
export function hopCacheKey(
  userId: string,
  vaultName: string,
  verb: string,
  issuer: string,
  principalPubkey: string | null = null,
): string {
  const base = `${userId}\0${vaultName}\0${verb}\0${issuer}`;
  return principalPubkey === null ? base : `${base}\0${principalPubkey}`;
}

function sweepExpired(nowMs: number): void {
  for (const [key, hit] of hops) {
    if (hit.expMs - nowMs <= REUSE_FLOOR_MS) hops.delete(key);
  }
}

export function lookupHopToken(key: string, nowMs: number): string | null {
  const hit = hops.get(key);
  if (!hit) return null;
  if (hit.expMs - nowMs <= REUSE_FLOOR_MS) {
    hops.delete(key);
    return null;
  }
  return hit.token;
}

export function storeHopToken(key: string, token: string, expMs: number, nowMs?: number): void {
  if (nowMs !== undefined) sweepExpired(nowMs);
  hops.set(key, { token, expMs });
}

/** Test seam. */
export function _resetAccountMcpHopCacheForTests(): void {
  hops.clear();
}
