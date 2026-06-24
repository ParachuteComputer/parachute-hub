/**
 * `agent-oauth-flows.json` — the persisted registry of **in-flight agent-grant
 * OAuth consent flows** (Phase 4b-2, agent-connectors design 2026-06-18).
 *
 * When the operator approves a `kind:mcp` grant that speaks OAuth, the hub (as
 * the OAuth CLIENT) starts a consent flow: it mints a PKCE verifier + a random
 * `state`, persists a record HERE keyed by `state`, and returns an authorize URL
 * the operator's browser follows. The remote issuer redirects back to
 * `GET /oauth/agent-grant/callback?code=&state=`; that handler looks the record
 * up by `state` (single-use, delete-on-use), exchanges the code, and stores the
 * grant material.
 *
 * Why ON-DISK (not in-memory): the 10-minute consent window can span a hub
 * restart (the supervisor may restart the hub mid-consent). An in-memory map
 * would orphan the `state` on restart — the callback would then fail to find the
 * flow and the operator would have to re-approve.
 *
 * The `verifier` is a PKCE SECRET — this file is written 0600 (same discipline
 * as `agent-grants.json`), and the verifier is NEVER logged, NEVER returned.
 *
 * One file, a flat array. Cardinality is "a handful of concurrent consents", and
 * stale records self-prune on every read/write (10-min TTL).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** TTL for a pending consent flow — 10 minutes (spans a possible hub restart). */
export const FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * An in-flight OAuth consent flow, bound to a single-use `state`. Persisted so a
 * mid-consent hub restart doesn't orphan the `state`.
 */
export interface PendingFlow {
  /** Single-use CSRF token — the lookup key + the callback's only gate. */
  readonly state: string;
  /** The grant this consent will populate on success. */
  readonly grantId: string;
  /** Discovered issuer (for the authorize/token endpoints). */
  readonly issuer: string;
  /** DCR client_id (or a reused one for the same issuer). */
  readonly clientId: string;
  /** Discovered token endpoint — where the callback exchanges the code. */
  readonly tokenEndpoint: string;
  /** Discovered revocation endpoint (cached for the eventual revoke). */
  readonly revocationEndpoint?: string;
  /** PKCE verifier — a SECRET. 0600 at rest; never logged, never returned. */
  readonly verifier: string;
  /** The remote MCP URL the grant connects to (stored into material on success). */
  readonly mcpUrl: string;
  /** Requested scope (space-joined), or absent to let the issuer default. */
  readonly scope?: string;
  /** The hub's callback URL registered for this flow. */
  readonly redirectUri: string;
  /**
   * OPTIONAL same-origin (hub-relative) page the operator should be sent back
   * to after a SUCCESSFUL consent — the agent ops surface / admin grants page
   * they started from. Validated with `isSafeHubReturnTo` at stash time and
   * (defensively) again at redirect time. Absent for flows started without one
   * (and for all pre-existing on-disk flows — additive + back-compat).
   */
  readonly returnTo?: string;
  readonly createdAt: string;
}

interface FlowsFile {
  flows: PendingFlow[];
}

function isPendingFlow(v: unknown): v is PendingFlow {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  // `returnTo` is OPTIONAL + additive — absent on every pre-existing on-disk
  // flow. Accept undefined; if present it must be a string (validated for
  // open-redirect safety at the call sites, not here).
  if (f.returnTo !== undefined && typeof f.returnTo !== "string") return false;
  return (
    typeof f.state === "string" &&
    typeof f.grantId === "string" &&
    typeof f.issuer === "string" &&
    typeof f.clientId === "string" &&
    typeof f.tokenEndpoint === "string" &&
    typeof f.verifier === "string" &&
    typeof f.mcpUrl === "string" &&
    typeof f.redirectUri === "string" &&
    typeof f.createdAt === "string"
  );
}

/** Read the store. A missing/garbage file reads as empty (mirrors grants-store). */
function readAll(storePath: string): PendingFlow[] {
  let buf: string;
  try {
    buf = readFileSync(storePath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const arr = (parsed as { flows?: unknown }).flows;
  if (!Array.isArray(arr)) return [];
  return arr.filter(isPendingFlow);
}

function writeAll(storePath: string, flows: PendingFlow[]): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const file: FlowsFile = { flows };
  // 0600 — this file holds PKCE verifiers (secrets). `writeFileSync`'s `mode`
  // applies at CREATE time, so a fresh file is never world-readable even for an
  // instant; the chmodSync is belt-and-suspenders for the re-write case.
  writeFileSync(storePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(storePath, 0o600);
  } catch {
    // Best-effort on platforms without POSIX perms.
  }
}

/** Drop flows older than `ttlMs` relative to `now`. Returns the survivors. */
function prune(flows: PendingFlow[], now: number, ttlMs: number): PendingFlow[] {
  return flows.filter((f) => {
    const created = new Date(f.createdAt).getTime();
    if (!Number.isFinite(created)) return false;
    return now - created < ttlMs;
  });
}

/**
 * Opportunistically prune expired flows + persist if anything was dropped.
 * Called inside put/get so stale records never accumulate.
 */
export function pruneExpiredFlows(
  storePath: string,
  now = Date.now(),
  ttlMs = FLOW_TTL_MS,
): PendingFlow[] {
  const all = readAll(storePath);
  const live = prune(all, now, ttlMs);
  if (live.length !== all.length) writeAll(storePath, live);
  return live;
}

/** Persist a new pending flow (pruning expired ones first). Upsert by `state`. */
export function putFlow(storePath: string, flow: PendingFlow, now = Date.now()): void {
  const live = prune(readAll(storePath), now, FLOW_TTL_MS);
  const idx = live.findIndex((f) => f.state === flow.state);
  if (idx >= 0) live[idx] = flow;
  else live.push(flow);
  writeAll(storePath, live);
}

/** Look up a flow by `state` (pruning expired ones first). Returns null if absent/expired. */
export function getFlowByState(
  storePath: string,
  state: string,
  now = Date.now(),
): PendingFlow | null {
  const live = pruneExpiredFlows(storePath, now);
  return live.find((f) => f.state === state) ?? null;
}

/** Delete a flow by `state` (single-use). Returns the removed flow, or null. */
export function deleteFlow(storePath: string, state: string): PendingFlow | null {
  const all = readAll(storePath);
  const idx = all.findIndex((f) => f.state === state);
  if (idx < 0) return null;
  const [removed] = all.splice(idx, 1);
  writeAll(storePath, all);
  return removed ?? null;
}
