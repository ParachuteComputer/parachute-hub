/**
 * Grant / revoke / list vault access by Nostr pubkey.
 *
 * This is the hub-shaped "this key, this vault, this role" loop. It writes
 * one `user_vaults` row at a time (never replace-all) and creates a key-only
 * hub user when the pubkey is unknown. Auto-provision stays off: grant-first
 * is how an unlinked key becomes a user.
 *
 * Grant is an admin verb on the vault. NIP-98 first-admin and Bearer
 * `parachute:host:admin` (wildcard `admin`) can grant any installed vault.
 * A Bearer connection still has to cover the vault: a named subset cannot
 * grant outside it, and a named composed verb must satisfy `admin`. Legacy
 * `account:vaults` / `account:self:vaults` are coverage wildcards (verb
 * `read`) — they do not cap the verb; first-admin or a write assignee does.
 * Anyone else needs `vaultVerbsForUserVault` to include `admin` (today:
 * `user_vaults.role = 'write'`). A read-only assignee cannot grant.
 *
 * First-admin is unrestricted by empty `user_vaults`, not by rows. Granting
 * to the owner's pubkey is a no-op success (`unrestricted: true`); we never
 * insert a row that would collapse that sentinel. Revoking the owner is
 * refused.
 *
 * Cloud's account-MCP twin is identity-worker shaped and does not grow these
 * tools. Hub-only on purpose.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { composedVerbSatisfies, isComposedVaultVerb } from "@openparachute/door-contract";
import { decodeNpub } from "./nip19.ts";
import { bindPubkeyOperatorAttested, findPubkeyLink, isPubkeyHex } from "./pubkey-links.ts";
import {
  UsernameTakenError,
  createUser,
  deleteUser,
  getFirstAdminId,
  isHubAdmin,
  removeUserVault,
  upsertUserVault,
  vaultVerbsForUserVault,
} from "./users.ts";

export const GRANTABLE_ROLES = ["read", "write"] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export class GrantError extends Error {
  constructor(
    public readonly errorType: string,
    message: string,
  ) {
    super(message);
    this.name = "GrantError";
  }
}

export interface GrantCaller {
  userId: string;
  isHubAdmin: boolean;
  authKind: "bearer" | "nostr";
  grant: {
    wildcard: string | null;
    vaults: { has(name: string): boolean; get(name: string): string | undefined };
  } | null;
}

export interface GrantResult {
  pubkey: string;
  vault: string;
  role: GrantableRole;
  user_id: string;
  username: string;
  created_user: boolean;
  unrestricted: boolean;
}

export interface RevokeResult {
  pubkey: string;
  vault: string;
  revoked: boolean;
}

export interface AccessRow {
  pubkey: string;
  vault: string;
  role: string;
  user_id: string;
  username: string;
}

function usernameForPubkey(pubkey: string): string {
  return `n${pubkey.slice(0, 31)}`;
}

/**
 * Accept either wire form of an x-only key and return the hex one.
 *
 * Hex is what every table and every NIP-01 event carries; `npub1…` (NIP-19
 * bech32) is what every human-facing nostr surface actually displays, so an
 * admin or agent pasting a key has only the npub to paste. Decoding it here —
 * at the operator-facing edge, once — keeps hex the single internal spelling.
 *
 * Uppercase hex stays rejected rather than normalized, per `pubkey-links.ts`.
 * An npub is an encoding, not a proof: this changes what the caller may
 * *type*, never what they may *do*.
 */
export function parseGrantPubkey(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new GrantError("invalid_pubkey", "pubkey is required.");
  }
  if (raw.startsWith("npub1")) {
    const decoded = decodeNpub(raw);
    if (decoded === null) {
      throw new GrantError(
        "invalid_pubkey",
        "pubkey looks like an npub but is not a valid NIP-19 npub (bech32 checksum or length).",
      );
    }
    return decoded;
  }
  if (!isPubkeyHex(raw)) {
    throw new GrantError(
      "invalid_pubkey",
      "pubkey must be a 64-character lowercase-hex x-only public key, or an npub1… (NIP-19) key.",
    );
  }
  return raw;
}

export function parseGrantRole(raw: unknown): GrantableRole {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new GrantError("invalid_role", "role is required (read or write).");
  }
  if ((GRANTABLE_ROLES as readonly string[]).includes(raw)) return raw as GrantableRole;
  throw new GrantError("invalid_role", 'role must be "read" or "write".');
}

export function parseGrantVault(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new GrantError("invalid_vault", "vault is required.");
  }
  return raw.trim().toLowerCase();
}

function bearerCoversVaultForGrant(
  grant: NonNullable<GrantCaller["grant"]>,
  vaultName: string,
): boolean {
  // host:admin synthesizes wildcard admin — unrestricted.
  if (grant.wildcard === "admin") return true;
  if (grant.wildcard !== null) {
    // Legacy/composed coverage wildcard (`account:vaults`, `account:self:vaults`,
    // `account:self:vaults:*:<verb>`). This is coverage, not a per-vault verb
    // cap — assignment (or first-admin) still has to allow the grant.
    return true;
  }
  const named = grant.vaults.get(vaultName);
  if (named === undefined) return false;
  return isComposedVaultVerb(named) && composedVerbSatisfies(named, "admin");
}

/**
 * True when the caller may grant/revoke/list this vault.
 *
 * NIP-98 hub admins are unrestricted across installed vaults. Bearer
 * `parachute:host:admin` (wildcard `admin`) is too. A Bearer that names a
 * vault subset cannot grant outside it; a named composed verb must satisfy
 * `admin`. Everyone else needs the `admin` verb on the vault
 * (`role = 'write'` today).
 */
export function callerCanAdminVault(db: Database, caller: GrantCaller, vaultName: string): boolean {
  if (caller.authKind === "bearer") {
    const grant = caller.grant;
    if (!grant) return false;
    if (!bearerCoversVaultForGrant(grant, vaultName)) return false;
    if (grant.wildcard === "admin") return true;
    if (isHubAdmin(db, caller.userId)) return true;
    const verbs = vaultVerbsForUserVault(db, caller.userId, vaultName);
    return verbs?.includes("admin") === true;
  }
  if (caller.isHubAdmin || isHubAdmin(db, caller.userId)) return true;
  const verbs = vaultVerbsForUserVault(db, caller.userId, vaultName);
  return verbs?.includes("admin") === true;
}

async function ensureUserForPubkey(
  db: Database,
  pubkey: string,
  now: () => Date,
): Promise<{ userId: string; username: string; created: boolean }> {
  const existing = findPubkeyLink(db, pubkey);
  if (existing) {
    return {
      userId: existing.userId,
      username: lookupUsername(db, existing.userId),
      created: false,
    };
  }

  // Bootstrap sentinel, NOT an admin check: `getFirstAdminId(db) === null`
  // is true exactly when the users table is empty. Auto-provisioning a
  // pubkey into an empty hub would make an anonymous NIP-98 caller the
  // hub's first account, so refuse until an owner exists.
  //
  // Deliberately left as "no accounts at all" rather than the arguably
  // truer `countHubAdmins(db) === 0` (hub#881). The two differ only for a
  // hub whose accounts all have `hub_role = 'user'` — unreachable today,
  // since `createUser` stamps 'admin' on the first account and migration
  // v20 backfills the earliest row. Behavior is therefore identical; the
  // narrower spelling avoids changing a bootstrap gate in a PR that isn't
  // about bootstrap. Revisit if a demote path ever lands.
  if (getFirstAdminId(db) === null) {
    throw new GrantError(
      "no_hub_owner",
      "Grant-first cannot create the hub owner. Create an owner first.",
    );
  }

  const password = randomBytes(32).toString("base64url");
  let username = usernameForPubkey(pubkey);
  let user: Awaited<ReturnType<typeof createUser>>;
  try {
    user = await createUser(db, username, password, {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: [],
      now,
    });
  } catch (err) {
    if (err instanceof UsernameTakenError) {
      username = `n${pubkey.slice(1, 32)}`;
      try {
        user = await createUser(db, username, password, {
          allowMulti: true,
          passwordChanged: true,
          assignedVaults: [],
          now,
        });
      } catch (err2) {
        if (err2 instanceof UsernameTakenError) {
          const raced = findPubkeyLink(db, pubkey);
          if (raced) {
            return {
              userId: raced.userId,
              username: lookupUsername(db, raced.userId),
              created: false,
            };
          }
          throw new GrantError(
            "username_taken",
            "Could not allocate a hub username for that pubkey.",
          );
        }
        throw err2;
      }
    } else {
      throw err;
    }
  }

  const bound = bindPubkeyOperatorAttested(db, {
    userId: user.id,
    pubkey,
    label: "grant",
    now: now(),
  });
  if (!bound.ok) {
    const raced = findPubkeyLink(db, pubkey);
    deleteUser(db, user.id);
    if (raced) {
      return { userId: raced.userId, username: lookupUsername(db, raced.userId), created: false };
    }
    throw new GrantError("pubkey_taken", "That pubkey is already bound to another user.");
  }
  return { userId: user.id, username: user.username, created: true };
}

function lookupUsername(db: Database, userId: string): string {
  const row = db
    .query<{ username: string }, [string]>("SELECT username FROM users WHERE id = ?")
    .get(userId);
  return row?.username ?? userId;
}

export async function grantAccess(
  db: Database,
  caller: GrantCaller,
  args: Record<string, unknown>,
  installed: ReadonlySet<string>,
  now: () => Date = () => new Date(),
): Promise<GrantResult> {
  const pubkey = parseGrantPubkey(args.pubkey);
  const vault = parseGrantVault(args.vault);
  const role = parseGrantRole(args.role);
  if (!installed.has(vault)) {
    throw new GrantError("vault_not_installed", `Vault "${vault}" is not installed on this hub.`);
  }
  if (!callerCanAdminVault(db, caller, vault)) {
    throw new GrantError("grant_not_permitted", `You cannot grant access to vault "${vault}".`);
  }

  const target = await ensureUserForPubkey(db, pubkey, now);
  if (isHubAdmin(db, target.userId)) {
    return {
      pubkey,
      vault,
      role,
      user_id: target.userId,
      username: target.username,
      created_user: target.created,
      unrestricted: true,
    };
  }

  const ok = upsertUserVault(db, target.userId, vault, role, now);
  if (!ok) {
    throw new GrantError("server_error", "Failed to write the vault grant.");
  }
  return {
    pubkey,
    vault,
    role,
    user_id: target.userId,
    username: target.username,
    created_user: target.created,
    unrestricted: false,
  };
}

export function revokeAccess(
  db: Database,
  caller: GrantCaller,
  args: Record<string, unknown>,
  installed: ReadonlySet<string>,
): RevokeResult {
  const pubkey = parseGrantPubkey(args.pubkey);
  const vault = parseGrantVault(args.vault);
  if (!installed.has(vault)) {
    throw new GrantError("vault_not_installed", `Vault "${vault}" is not installed on this hub.`);
  }
  if (!callerCanAdminVault(db, caller, vault)) {
    throw new GrantError("grant_not_permitted", `You cannot revoke access to vault "${vault}".`);
  }
  const link = findPubkeyLink(db, pubkey);
  if (!link) {
    throw new GrantError("unknown_pubkey", "No hub user is linked to that pubkey.");
  }
  if (isHubAdmin(db, link.userId)) {
    throw new GrantError(
      "target_is_hub_admin",
      "A hub admin is unrestricted; vault grants on that account cannot be revoked this way.",
    );
  }
  const revoked = removeUserVault(db, link.userId, vault);
  return { pubkey, vault, revoked };
}

export function listAccess(
  db: Database,
  caller: GrantCaller,
  args: Record<string, unknown>,
  installed: ReadonlySet<string>,
): { access: AccessRow[] } {
  let vaultFilter: string | null = null;
  if (args.vault !== undefined && args.vault !== null && args.vault !== "") {
    vaultFilter = parseGrantVault(args.vault);
    if (!installed.has(vaultFilter)) {
      throw new GrantError(
        "vault_not_installed",
        `Vault "${vaultFilter}" is not installed on this hub.`,
      );
    }
    if (!callerCanAdminVault(db, caller, vaultFilter)) {
      throw new GrantError(
        "grant_not_permitted",
        `You cannot list access for vault "${vaultFilter}".`,
      );
    }
  }

  const rows = db
    .query<
      { pubkey: string; vault_name: string; role: string; user_id: string; username: string },
      []
    >(
      `SELECT up.pubkey, uv.vault_name, uv.role, u.id AS user_id, u.username
       FROM user_vaults uv
       JOIN users u ON u.id = uv.user_id
       JOIN user_pubkeys up ON up.user_id = uv.user_id
       ORDER BY uv.vault_name ASC, up.pubkey ASC`,
    )
    .all();

  const access: AccessRow[] = [];
  for (const r of rows) {
    if (!installed.has(r.vault_name)) continue;
    if (vaultFilter && r.vault_name !== vaultFilter) continue;
    if (!callerCanAdminVault(db, caller, r.vault_name)) continue;
    access.push({
      pubkey: r.pubkey,
      vault: r.vault_name,
      role: r.role,
      user_id: r.user_id,
      username: r.username,
    });
  }
  return { access };
}
