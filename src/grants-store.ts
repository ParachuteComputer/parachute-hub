/**
 * `agent-grants.json` — the persisted registry of approval-gated **agent
 * connector grants** (Phase 4b-1, agent-connectors design 2026-06-17).
 *
 * NOT to be confused with `grants.ts` (the OAuth consent skip-list, one row per
 * `(user_id, client_id)` in the SQLite `grants` table). THIS store is the
 * agent-connector subsystem: an agent (a `#agent/definition` note in the agent
 * module) declares connections it WANTS beyond its own def-vault; the agent
 * module registers each as a PENDING grant here; the operator approves
 * per-connection in hub admin; the hub mints/stores the secret; the agent
 * module fetches the material at spawn and injects it.
 *
 * The one invariant (from the design): **a vault note can only REQUEST; it can
 * never GRANT.** A grant created by the module sits `pending` and grants nothing
 * until the operator approves in the hub. The minted/pasted secret (`material`)
 * is the only sensitive field — it lives here on disk (0600), is NEVER logged,
 * and is NEVER returned by the list endpoint (only by the approved-only
 * `/material` endpoint).
 *
 * One file, a flat array. Cardinality is "a handful of grants per agent", not a
 * hot path — small + synchronous Bun file I/O, mirroring `connections-store.ts`.
 * Unlike `connections.json`, this file IS written 0600 because it holds the
 * granted secrets.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Verb for a vault grant. Service/mcp grants carry no access verb. */
export type GrantAccess = "read" | "write";

/** Where the agent side injects a resolved grant. */
export type GrantInject = "env" | "mcp";

/**
 * A **connection spec** — what the agent WANTS. The wire shape the agent module
 * sends to `PUT /admin/grants` and the shape echoed back by the list endpoint.
 *
 *   - `vault`   — a LOCAL vault other than the def-vault. `target` is the vault
 *     name; `access` the verb; optional `tags` narrow the grant to a tag set
 *     (rides the vault's `scoped_tags` tokens). Grant = a hub-minted
 *     `vault:<target>:<access>` token.
 *   - `service` — an external service credential (`github`, `cloudflare`).
 *     `target` is the service key; `inject` hints how the agent side wires it
 *     (`env` → an env var, `mcp` → the service's MCP server, or both). Grant =
 *     an operator-pasted API token.
 *   - `mcp`     — a remote MCP / remote vault. `target` is the MCP URL. Grant =
 *     an OAuth token — NOT implemented in 4b-1 (slice 2). Modeled here; the
 *     grant stays `pending` with a clear reason.
 */
export interface ConnectionSpec {
  readonly kind: "vault" | "service" | "mcp";
  /** Vault name / service key / MCP URL, per `kind`. */
  readonly target: string;
  /** Vault grants only — `read` (default) or `write`. */
  readonly access?: GrantAccess;
  /** Vault grants only — tag-scope (`scoped_tags`); empty/absent = vault-wide. */
  readonly tags?: readonly string[];
  /** Service grants only — injection hints carried for the agent side. */
  readonly inject?: readonly GrantInject[];
}

export type GrantStatus = "pending" | "approved" | "revoked";

/**
 * The granted secret material, kept on disk ONLY. Discriminated by `kind` to
 * mirror the spec. NEVER returned by the list endpoint; only the approved-only
 * `/material` endpoint reads it.
 */
export type GrantMaterial =
  | {
      readonly kind: "vault";
      /** The minted `vault:<target>:<access>` JWT. */
      readonly token: string;
      /** jti of the minted token — registered so revoke can drop it. */
      readonly jti: string;
      /** ISO expiry of the minted token. */
      readonly expiresAt: string;
    }
  | {
      readonly kind: "service";
      /** The operator-pasted API token. */
      readonly token: string;
    };

export interface GrantRecord {
  readonly id: string;
  /** Agent name (the `#agent/definition` note's agent identity). */
  readonly agent: string;
  /** The declared connection spec. */
  readonly connection: ConnectionSpec;
  readonly status: GrantStatus;
  /** Why a grant is pending/blocked (e.g. mcp "oauth not yet supported"). */
  readonly reason?: string;
  /** The secret — present only when `status === "approved"`. Never logged/listed. */
  readonly material?: GrantMaterial;
  readonly createdAt: string;
  readonly approvedAt?: string;
}

interface GrantsFile {
  grants: GrantRecord[];
}

/**
 * Stable connection key — the idempotency key for `(agent, connection)` upsert.
 * A spec's identity is its `kind` + `target` + (for vault) the access verb +
 * the sorted tag set. `inject` is NOT part of the key — it's an agent-side
 * hint, so re-declaring the same service with different inject modes updates
 * the existing grant rather than forking a second one. The grant `id` derives
 * from `agent` + this key.
 */
export function connectionKey(spec: ConnectionSpec): string {
  const target = spec.target.trim().toLowerCase();
  if (spec.kind === "vault") {
    const access = spec.access ?? "read";
    const tags = [...(spec.tags ?? [])].map((t) => t.trim()).sort();
    return tags.length > 0
      ? `vault:${target}:${access}#${tags.join(",")}`
      : `vault:${target}:${access}`;
  }
  if (spec.kind === "service") {
    return `service:${target}`;
  }
  // mcp — keyed on the URL only (its target).
  return `mcp:${target}`;
}

const GRANT_ID_CHARSET = /[^a-z0-9]+/g;

/**
 * Derive the grant id from `(agent, connectionKey)`. A conservative slug — it
 * lands in a URL path segment (`/admin/grants/<id>/...`). Deterministic so the
 * same `(agent, connection)` always upserts the same row.
 */
export function grantId(agent: string, spec: ConnectionSpec): string {
  const raw = `${agent.trim().toLowerCase()}--${connectionKey(spec)}`;
  return raw.replace(GRANT_ID_CHARSET, "-").replace(/^-+|-+$/g, "");
}

function emptyFile(): GrantsFile {
  return { grants: [] };
}

function isConnectionSpec(v: unknown): v is ConnectionSpec {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    (s.kind === "vault" || s.kind === "service" || s.kind === "mcp") && typeof s.target === "string"
  );
}

/** Read the store. A missing/garbage file reads as empty (fresh hub). */
export function readGrants(storePath: string): GrantRecord[] {
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
  const arr = (parsed as { grants?: unknown }).grants;
  if (!Array.isArray(arr)) return [];
  // Lenient: drop a malformed row rather than failing the whole read (mirrors
  // the connections-store / services.json lenient-read posture).
  return arr.filter((r): r is GrantRecord => {
    if (!r || typeof r !== "object") return false;
    const rec = r as Record<string, unknown>;
    return (
      typeof rec.id === "string" &&
      typeof rec.agent === "string" &&
      isConnectionSpec(rec.connection) &&
      (rec.status === "pending" || rec.status === "approved" || rec.status === "revoked")
    );
  });
}

function writeAll(storePath: string, records: GrantRecord[]): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const file: GrantsFile = { grants: records };
  // 0600 — UNLIKE connections.json, this file holds the granted secrets
  // (minted vault tokens + pasted service creds in `material`). Write the file
  // first, then chmod, so a fresh-create never has a window at the default
  // umask. chmod is idempotent on re-write.
  writeFileSync(storePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(storePath, 0o600);
  } catch {
    // Best-effort on platforms without POSIX perms (the secret is still only
    // reachable through the approved-only, auth-gated /material endpoint).
  }
}

/** Upsert by id (replace an existing record with the same id, else append). */
export function putGrant(storePath: string, record: GrantRecord): void {
  const records = readGrants(storePath);
  const idx = records.findIndex((r) => r.id === record.id);
  if (idx >= 0) records[idx] = record;
  else records.push(record);
  writeAll(storePath, records);
}

export function getGrant(storePath: string, id: string): GrantRecord | null {
  return readGrants(storePath).find((r) => r.id === id) ?? null;
}

/** All grants for an agent, in stored order. */
export function listGrantsForAgent(storePath: string, agent: string): GrantRecord[] {
  const want = agent.trim().toLowerCase();
  return readGrants(storePath).filter((r) => r.agent.trim().toLowerCase() === want);
}

/** Remove a grant by id. Returns the removed record, or null if absent. */
export function removeGrant(storePath: string, id: string): GrantRecord | null {
  const records = readGrants(storePath);
  const idx = records.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const [removed] = records.splice(idx, 1);
  writeAll(storePath, records);
  return removed ?? null;
}

/** Re-export for the unused-import linter when only the type is consumed. */
export const _emptyGrantsFile = emptyFile;
