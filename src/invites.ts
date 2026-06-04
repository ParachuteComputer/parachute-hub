/**
 * One-time, expiring invite links (design
 * 2026-06-04-individual-users-and-vault-operations.md §7). An admin issues
 * a link; the recipient opens `/account/setup/<token>`, picks a username +
 * password, and gets their OWN freshly-provisioned vault as owner.
 *
 * Token model — mirrors `auth-codes.ts` (single-use + expiring + sha256-at-
 * rest), with the key difference that invites are LONGER-LIVED (default 7
 * days vs the 60s auth-code TTL), so the row stores **sha256(token)**, never
 * the raw value. The raw token is returned exactly ONCE from `issueInvite`
 * and never persisted — a DB read alone can't replay the link (the same
 * posture as the bootstrap token). Lookup hashes the URL token and selects
 * by the hash.
 *
 * What an invite pre-authorizes: creating exactly ONE account + the one
 * named/created vault at the baked-in role — NEVER host:admin, NEVER another
 * vault. The redeemed user inherits only the `user_vaults` row's authority.
 * The redemption flow (`/account/setup/<token>` in hub-server.ts) enforces
 * the createUser-then-stamp ordering so a createUser failure leaves the
 * invite re-usable.
 *
 * Single-use is enforced by stamping `used_at` on redemption — a replay
 * attempt sees the row with `used_at` set and `redeemInvite` throws
 * `InviteUsedError`. Revocation is a separate `revoked_at` stamp the admin
 * sets before redemption. Expiry is enforced at redeem-time.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

/** Default invite lifetime — long enough to deliver out-of-band (no email), short enough to bound a leaked link. */
export const DEFAULT_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Token entropy in bytes — 256 bits, matching the bootstrap / auth-code token. */
const INVITE_TOKEN_BYTES = 32;

export type InviteStatus = "pending" | "redeemed" | "expired" | "revoked";

export interface Invite {
  /** sha256(raw token), hex. The raw token is never stored. */
  tokenHash: string;
  createdBy: string | null;
  /** Pinned vault name, or null when the redeemer names their own vault. */
  vaultName: string | null;
  /** `user_vaults.role` granted on redemption (`'write'` = owner). */
  role: string;
  /** Whether redemption provisions a NEW vault for the redeemer. */
  provisionVault: boolean;
  /** `'internal' | 'off'` mirror knob for the provisioned vault, or null. */
  defaultMirror: string | null;
  expiresAt: string;
  usedAt: string | null;
  redeemedUserId: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export class InviteNotFoundError extends Error {
  constructor() {
    super("invite not found");
    this.name = "InviteNotFoundError";
  }
}

export class InviteExpiredError extends Error {
  constructor() {
    super("invite has expired");
    this.name = "InviteExpiredError";
  }
}

export class InviteUsedError extends Error {
  constructor() {
    super("invite has already been redeemed");
    this.name = "InviteUsedError";
  }
}

export class InviteRevokedError extends Error {
  constructor() {
    super("invite has been revoked");
    this.name = "InviteRevokedError";
  }
}

interface Row {
  token: string;
  created_by: string | null;
  vault_name: string | null;
  role: string;
  provision_vault: number;
  default_mirror: string | null;
  expires_at: string;
  used_at: string | null;
  redeemed_user_id: string | null;
  revoked_at: string | null;
  created_at: string;
}

function rowToInvite(r: Row): Invite {
  return {
    tokenHash: r.token,
    createdBy: r.created_by,
    vaultName: r.vault_name,
    role: r.role,
    provisionVault: r.provision_vault === 1,
    defaultMirror: r.default_mirror,
    expiresAt: r.expires_at,
    usedAt: r.used_at,
    redeemedUserId: r.redeemed_user_id,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  };
}

/** sha256 of the raw token, hex — the at-rest representation + PK. */
export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Derive an invite's status from its stamps + the current time. */
export function inviteStatus(invite: Invite, now: Date = new Date()): InviteStatus {
  if (invite.revokedAt) return "revoked";
  if (invite.usedAt) return "redeemed";
  if (now.getTime() > new Date(invite.expiresAt).getTime()) return "expired";
  return "pending";
}

export interface IssueInviteOpts {
  /** Admin user id issuing the invite (audit). */
  createdBy: string;
  /** Pinned vault name; omit/null to let the redeemer name their own. */
  vaultName?: string | null;
  /** `user_vaults` role granted on redemption. Default `'write'` (owner). */
  role?: string;
  /** Provision a new vault on redemption. Default `true` (the primary flow). */
  provisionVault?: boolean;
  /** `'internal' | 'off'` mirror knob for the provisioned vault. */
  defaultMirror?: string | null;
  /** Lifetime in seconds. Default {@link DEFAULT_INVITE_TTL_SECONDS} (7 days). */
  expiresInSeconds?: number;
  now?: () => Date;
}

export interface IssuedInvite {
  /**
   * The raw token — returned EXACTLY ONCE here and never persisted. The
   * caller builds the redemption URL from it (`/account/setup/<rawToken>`)
   * and shows it once; the hub keeps only `sha256(rawToken)`.
   */
  rawToken: string;
  invite: Invite;
}

/**
 * Mint an invite: generate a 256-bit raw token, store its sha256, return the
 * raw token once. The row's PK is the hash, so a DB compromise can't replay
 * the link.
 */
export function issueInvite(db: Database, opts: IssueInviteOpts): IssuedInvite {
  const rawToken = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
  const tokenHash = hashInviteToken(rawToken);
  const now = opts.now?.() ?? new Date();
  const createdAt = now.toISOString();
  const ttl = opts.expiresInSeconds ?? DEFAULT_INVITE_TTL_SECONDS;
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
  const role = opts.role ?? "write";
  const vaultName = opts.vaultName ?? null;
  const provisionVault = opts.provisionVault ?? true;
  const defaultMirror = opts.defaultMirror ?? null;

  db.prepare(
    `INSERT INTO invites
       (token, created_by, vault_name, role, provision_vault, default_mirror,
        expires_at, used_at, redeemed_user_id, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    tokenHash,
    opts.createdBy,
    vaultName,
    role,
    provisionVault ? 1 : 0,
    defaultMirror,
    expiresAt,
    createdAt,
  );

  return {
    rawToken,
    invite: {
      tokenHash,
      createdBy: opts.createdBy,
      vaultName,
      role,
      provisionVault,
      defaultMirror,
      expiresAt,
      usedAt: null,
      redeemedUserId: null,
      revokedAt: null,
      createdAt,
    },
  };
}

/** Look up an invite by its raw (URL) token. Hashes then selects. */
export function findInviteByRawToken(db: Database, rawToken: string): Invite | null {
  const hash = hashInviteToken(rawToken);
  const row = db.query<Row, [string]>("SELECT * FROM invites WHERE token = ?").get(hash);
  return row ? rowToInvite(row) : null;
}

/** Look up an invite by its sha256 hash (admin DELETE/revoke by id). */
export function findInviteByHash(db: Database, tokenHash: string): Invite | null {
  const row = db.query<Row, [string]>("SELECT * FROM invites WHERE token = ?").get(tokenHash);
  return row ? rowToInvite(row) : null;
}

/** List every invite, newest first, with derived status. */
export function listInvites(
  db: Database,
  now: Date = new Date(),
): (Invite & { status: InviteStatus })[] {
  const rows = db.query<Row, []>("SELECT * FROM invites ORDER BY created_at DESC").all();
  return rows.map((r) => {
    const invite = rowToInvite(r);
    return { ...invite, status: inviteStatus(invite, now) };
  });
}

/**
 * Validate an invite for redemption WITHOUT consuming it. Throws on every
 * not-redeemable branch (not-found / expired / used / revoked). Returns the
 * invite when it's redeemable. The redemption handler calls this FIRST (so a
 * bad token is rejected before any account/vault work), then does
 * createUser, then `consumeInvite` AFTER the user row commits.
 */
export function assertInviteRedeemable(
  db: Database,
  rawToken: string,
  now: Date = new Date(),
): Invite {
  const invite = findInviteByRawToken(db, rawToken);
  if (!invite) throw new InviteNotFoundError();
  // Revoked + used are terminal regardless of clock; check them before expiry
  // so a revoked-then-expired invite reports the more specific reason.
  if (invite.revokedAt) throw new InviteRevokedError();
  if (invite.usedAt) throw new InviteUsedError();
  if (now.getTime() > new Date(invite.expiresAt).getTime()) {
    throw new InviteExpiredError();
  }
  return invite;
}

/**
 * Mark an invite consumed — stamp `used_at` + `redeemed_user_id`. Called
 * ONLY after the redeemed user row has committed (so a createUser exception
 * leaves the invite re-usable). Single-use is enforced by the
 * `used_at IS NULL` guard in the UPDATE: a racing second redeem updates zero
 * rows and the caller treats that as already-consumed.
 *
 * Returns `true` if THIS call consumed the invite, `false` if it was already
 * consumed (used_at already set) — race-safe because sqlite serializes
 * writes.
 */
export function consumeInvite(
  db: Database,
  tokenHash: string,
  redeemedUserId: string,
  now: Date = new Date(),
): boolean {
  const res = db
    .prepare(
      "UPDATE invites SET used_at = ?, redeemed_user_id = ? WHERE token = ? AND used_at IS NULL",
    )
    .run(now.toISOString(), redeemedUserId, tokenHash);
  return res.changes > 0;
}

/**
 * Revoke a pending invite (admin DELETE). Stamps `revoked_at` only when the
 * invite isn't already used or revoked. Returns `true` if this call revoked
 * it, `false` if it was already consumed/revoked or not found.
 */
export function revokeInvite(db: Database, tokenHash: string, now: Date = new Date()): boolean {
  const res = db
    .prepare(
      "UPDATE invites SET revoked_at = ? WHERE token = ? AND used_at IS NULL AND revoked_at IS NULL",
    )
    .run(now.toISOString(), tokenHash);
  return res.changes > 0;
}
