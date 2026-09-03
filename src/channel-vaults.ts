/**
 * Channel → vault bindings (`channel_vaults`, migration v23).
 *
 * A Buzz channel is attached to exactly one Parachute vault so that a later
 * reconciler can turn channel membership into ordinary `user_vaults` rows
 * (design "Channel-attached vaults — membership becomes access", §1). This
 * module is the read/write seam over that table and nothing more: PR 1 ships
 * the binding, PRs 4–5 ship the roster fetcher and the reconciler that fill
 * `relay_self_pubkey` / `synced_at`.
 *
 * Split of responsibility, on purpose:
 *   - THIS module owns the row. It validates nothing about the world — that a
 *     vault is installed, that the caller may attach — because both facts live
 *     at the HTTP edge (`api-channel-vaults.ts`), which is also where the
 *     `parachute:host:admin` gate is.
 *   - `mode` comes back as the RAW stored string. The interpretation is
 *     fail-closed at the point of use, the same posture `vaultVerbsForRole`
 *     takes on `user_vaults.role` and `isHubAdmin` takes on `users.hub_role`:
 *     a hand-edited value must not silently read as a permissive one. Use
 *     {@link isChannelVaultMode} at the reader.
 *
 * Keyed by `(relay_host, channel_id)`. `vault` is a vault INSTANCE NAME — the
 * same name space as `user_vaults.vault_name`, `invites.vault_name` and
 * services.json — with no FK, because the hub has no vaults table (names
 * resolve through services.json).
 */
import type { Database } from "bun:sqlite";

/**
 * The modes a binding can be in.
 *
 *   - `sync`   — the reconciler keeps `user_vaults` in step with the channel
 *                roster.
 *   - `frozen` — grants are held as-is and no longer synced. This is the
 *                answer to "relay unreachable: freeze or drop?" (design §Open
 *                questions, 4): a relay outage must not silently drop every
 *                member's access.
 */
export const CHANNEL_VAULT_MODES = ["sync", "frozen"] as const;
export type ChannelVaultMode = (typeof CHANNEL_VAULT_MODES)[number];

/** The mode a binding is created in when the caller names none. */
export const DEFAULT_CHANNEL_VAULT_MODE: ChannelVaultMode = "sync";

/** Fail-closed reader-side guard for the raw `mode` column. */
export function isChannelVaultMode(value: string): value is ChannelVaultMode {
  return (CHANNEL_VAULT_MODES as readonly string[]).includes(value);
}

export interface ChannelVault {
  /** Lower-cased, scheme-less relay host — see {@link normalizeRelayHost}. */
  relayHost: string;
  channelId: string;
  /** Vault instance name. */
  vault: string;
  /**
   * Raw stored mode. Normally one of {@link CHANNEL_VAULT_MODES}; guard with
   * {@link isChannelVaultMode} before acting on it.
   */
  mode: string;
  /**
   * The relay's NIP-11 `self` pubkey, pinned trust-on-first-use so PR 4 can
   * verify the kind 39002 roster's signature. `null` until a roster fetch
   * exists.
   */
  relaySelfPubkey: string | null;
  /** Last successful roster sync (PR 5). `null` means "never synced". */
  syncedAt: string | null;
  createdAt: string;
}

interface Row {
  relay_host: string;
  channel_id: string;
  vault: string;
  mode: string;
  relay_self_pubkey: string | null;
  synced_at: string | null;
  created_at: string;
}

function rowToBinding(r: Row): ChannelVault {
  return {
    relayHost: r.relay_host,
    channelId: r.channel_id,
    vault: r.vault,
    mode: r.mode,
    relaySelfPubkey: r.relay_self_pubkey,
    syncedAt: r.synced_at,
    createdAt: r.created_at,
  };
}

/**
 * Normalize a relay to the stored `relay_host` form: scheme stripped, trailing
 * slashes stripped, lower-cased.
 *
 * Mirrors `relayHostOf` in parachute-surface's parachute-mcp
 * (`packages/parachute-mcp/src/channel.ts`) — the two must agree, because the
 * surface derives a vault PATH (`Channels/<relay-host>/<channel-id>`) from the
 * same string. Hostnames are case-insensitive but paths are not, so a relay
 * that differs only in case would fork one channel into two bindings and two
 * notes.
 *
 * Returns `undefined` when the result is empty or is not a single path segment
 * — the surface's `assertSegment` refuses those rather than normalizing them,
 * and a binding key that could climb out of the `Channels/` namespace is worth
 * refusing on the hub side too.
 */
export function normalizeRelayHost(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const stripped = raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (stripped === "") return undefined;
  if (/[/\\]/.test(stripped) || stripped.includes("..") || /\s/.test(stripped)) return undefined;
  return stripped;
}

/**
 * A channel id is a binding key AND (surface-side) a path segment, so the same
 * refusal applies: no slashes, no `..`, no whitespace. Returns `undefined` for
 * anything that fails.
 */
export function normalizeChannelId(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (/[/\\]/.test(trimmed) || trimmed.includes("..") || /\s/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * The default vault name for a channel: `ch-<first-8-of-uuid>` (design §1,
 * "Naming"). Lower-cased so the result satisfies `VAULT_NAME_CHARSET_RE`; at
 * 11 characters it also sits inside the 2–32 length rule. The caller still
 * validates it — this helper only proposes a name.
 */
export function defaultChannelVaultName(channelId: string): string {
  return `ch-${channelId.slice(0, 8).toLowerCase()}`;
}

export interface UpsertChannelVaultInput {
  relayHost: string;
  channelId: string;
  vault: string;
  mode?: ChannelVaultMode;
  relaySelfPubkey?: string | null;
}

/**
 * Insert or update one binding. ON CONFLICT updates `vault` / `mode` /
 * `relay_self_pubkey` and PRESERVES the original `created_at` and `synced_at`
 * — re-attaching must not look like a fresh sync.
 *
 * Idempotency is the caller's story, not this function's: re-attaching the
 * same channel to the same vault writes the same row and the HTTP edge reports
 * it as a no-op.
 */
export function upsertChannelVault(
  db: Database,
  input: UpsertChannelVaultInput,
  now: () => Date = () => new Date(),
): ChannelVault {
  const stamp = now().toISOString();
  db.prepare(
    `INSERT INTO channel_vaults
       (relay_host, channel_id, vault, mode, relay_self_pubkey, synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(relay_host, channel_id) DO UPDATE SET
       vault = excluded.vault,
       mode = excluded.mode,
       relay_self_pubkey = excluded.relay_self_pubkey`,
  ).run(
    input.relayHost,
    input.channelId,
    input.vault,
    input.mode ?? DEFAULT_CHANNEL_VAULT_MODE,
    input.relaySelfPubkey ?? null,
    stamp,
  );
  // Re-read so the returned `createdAt` reflects the preserved original on an
  // update (`excluded.created_at` is deliberately NOT written on conflict).
  const row = getChannelVault(db, input.relayHost, input.channelId);
  return (
    row ?? {
      relayHost: input.relayHost,
      channelId: input.channelId,
      vault: input.vault,
      mode: input.mode ?? DEFAULT_CHANNEL_VAULT_MODE,
      relaySelfPubkey: input.relaySelfPubkey ?? null,
      syncedAt: null,
      createdAt: stamp,
    }
  );
}

/** The binding for one channel, or `null` when the channel is unbound. */
export function getChannelVault(
  db: Database,
  relayHost: string,
  channelId: string,
): ChannelVault | null {
  const row = db
    .query<Row, [string, string]>(
      "SELECT * FROM channel_vaults WHERE relay_host = ? AND channel_id = ?",
    )
    .get(relayHost, channelId);
  return row ? rowToBinding(row) : null;
}

/**
 * Every binding, or only those backing `vault` when a name is given (the
 * inverse lookup the `channel_vaults_vault` index exists for). Ordered by
 * (relay_host, channel_id) so `parachute vault list-channels` renders
 * deterministically.
 */
export function listChannelVaults(db: Database, vault?: string): ChannelVault[] {
  const rows =
    vault === undefined
      ? db
          .query<Row, []>("SELECT * FROM channel_vaults ORDER BY relay_host ASC, channel_id ASC")
          .all()
      : db
          .query<Row, [string]>(
            "SELECT * FROM channel_vaults WHERE vault = ? ORDER BY relay_host ASC, channel_id ASC",
          )
          .all(vault);
  return (rows ?? []).map(rowToBinding);
}

/** Drop one binding. Returns `true` when a row was deleted. */
export function removeChannelVault(db: Database, relayHost: string, channelId: string): boolean {
  const res = db
    .prepare("DELETE FROM channel_vaults WHERE relay_host = ? AND channel_id = ?")
    .run(relayHost, channelId);
  return Number(res.changes) > 0;
}

/**
 * Vault-delete cascade hook, parity with `removeVaultAssignments` /
 * `removeVaultCap`: drop every binding that points at a deleted vault so a
 * re-created same-name vault doesn't silently inherit another channel's
 * members. Exact `=` match, no pattern. Returns rows deleted.
 */
export function removeChannelVaultsForVault(db: Database, vault: string): number {
  const res = db.prepare("DELETE FROM channel_vaults WHERE vault = ?").run(vault);
  return Number(res.changes);
}
