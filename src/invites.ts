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
 * Two invite shapes carry that authorization (plus the account-only shape):
 *   - provision_vault=1 — redemption provisions a NEW vault (optionally
 *     pre-named via `vault_name`) and assigns the redeemer at `role`
 *     (always 'write': the sole user of a fresh vault must hold write).
 *   - provision_vault=0 + vault_name — a SHARED-VAULT invite: redemption
 *     assigns the redeemer to the admin's EXISTING vault at `role`
 *     ('read' or 'write'). Issuing is host:admin-gated — the same
 *     authority that can already assign any user to any vault via
 *     `POST /api/users` / `PATCH /api/users/:id/vaults` — so the invite
 *     is a delivery mechanism for an admin-authorized assignment, not an
 *     escalation. The read-only role is enforced end-to-end: every mint
 *     path caps to `vaultVerbsForRole` (users.ts) and the vault's
 *     scope-guard refuses writes for a `vault:<name>:read` token.
 *
 * An invite may also pre-name the redeemer's USERNAME (`username` column,
 * v13): the redemption form shows it read-only and the redeem handler
 * enforces it. NULL = redeemer picks their own.
 *
 * MULTI-USE (migration v15, DEMO-PREP-2026-06-25 Workstream B): an invite
 * carries `max_uses` (how many accounts ONE link may create) + `used_count`
 * (how many it has). A redeem is refused once `used_count >= max_uses`. A
 * LEGACY single-use invite is exactly `max_uses = 1` (the column default), so
 * pre-v15 invites and default-shaped new ones behave identically to before.
 * `used_at` is RETAINED — stamped on the FIRST redeem — so the admin list's
 * "redeemed" status and any single-use lookups keep reading the same signal.
 * Exhaustion is enforced atomically in `recordInviteRedemption` (the
 * `used_count < max_uses` guard in the UPDATE), so two concurrent redeems of
 * the last remaining seat can't both succeed.
 *
 * Revocation is a separate `revoked_at` stamp the admin sets before
 * redemption (terminal regardless of remaining uses). Expiry is enforced at
 * redeem-time. A public-signup link also captures the redeemer's `email`
 * (B2 — the contactable identity, also stored per-account on `users.email`)
 * and may carry a `vault_cap_bytes` to stamp onto each provisioned vault (B4
 * — persisted to `vault_caps` for the Phase-2 enforcement PR to read).
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { deleteSetting, getSetting } from "./hub-settings.ts";

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
  /**
   * Pre-named username the redeemer's account gets (ENFORCED at redeem),
   * or null when the redeemer picks their own. v13.
   */
  username: string | null;
  /** `user_vaults.role` granted on redemption (`'write'` = owner). */
  role: string;
  /** Whether redemption provisions a NEW vault for the redeemer. */
  provisionVault: boolean;
  /** `'internal' | 'off'` mirror knob for the provisioned vault, or null. */
  defaultMirror: string | null;
  /**
   * How many accounts this link may create (v15). 1 = legacy single-use
   * (the column default); >1 = a multi-use public-signup link.
   */
  maxUses: number;
  /** How many accounts this link HAS created (v15). Redeem refused once == maxUses. */
  usedCount: number;
  /**
   * Most-recent redeemer's email (v15, B2), or null. For a multi-use link
   * the canonical per-account email lives on `users.email`; this column
   * holds the latest redeemer's for the admin's at-a-glance audit.
   */
  email: string | null;
  /**
   * Per-vault storage cap (bytes) to stamp onto each provisioned vault
   * (v15, B4), or null to provision uncapped (legacy behavior).
   */
  vaultCapBytes: number | null;
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

/**
 * A multi-use link whose seats are all taken (`used_count >= max_uses`). For
 * a single-use (max_uses=1) link this is the same condition the legacy
 * `InviteUsedError` named, but the redeem path throws `InviteUsedError` for a
 * single-use link (familiar "already used" copy) and `InviteExhaustedError`
 * for a multi-use one ("all signups taken") so the message can differ.
 */
export class InviteExhaustedError extends Error {
  constructor() {
    super("invite has reached its maximum number of signups");
    this.name = "InviteExhaustedError";
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
  username: string | null;
  role: string;
  provision_vault: number;
  default_mirror: string | null;
  max_uses: number;
  used_count: number;
  email: string | null;
  vault_cap_bytes: number | null;
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
    username: r.username,
    role: r.role,
    provisionVault: r.provision_vault === 1,
    defaultMirror: r.default_mirror,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    email: r.email,
    vaultCapBytes: r.vault_cap_bytes,
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

/**
 * Derive an invite's status from its stamps + the current time.
 *
 * Multi-use (v15): an invite is "redeemed" only once every seat is taken
 * (`usedCount >= maxUses`). A partially-used multi-use link (some seats left,
 * not expired/revoked) is still "pending" — it can take more signups. A
 * legacy single-use link (maxUses=1) flips to "redeemed" on its first
 * redeem, exactly as before, because 1 >= 1. Expired wins over a not-yet-
 * exhausted link; revoked + exhausted are checked first (terminal).
 */
export function inviteStatus(invite: Invite, now: Date = new Date()): InviteStatus {
  if (invite.revokedAt) return "revoked";
  if (invite.usedCount >= invite.maxUses) return "redeemed";
  if (now.getTime() > new Date(invite.expiresAt).getTime()) return "expired";
  return "pending";
}

export interface IssueInviteOpts {
  /** Admin user id issuing the invite (audit). */
  createdBy: string;
  /** Pinned vault name; omit/null to let the redeemer name their own. */
  vaultName?: string | null;
  /**
   * Pre-named username (ENFORCED at redeem); omit/null to let the redeemer
   * pick their own. Caller validates the vocabulary + uniqueness.
   */
  username?: string | null;
  /** `user_vaults` role granted on redemption. Default `'write'` (owner). */
  role?: string;
  /** Provision a new vault on redemption. Default `true` (the primary flow). */
  provisionVault?: boolean;
  /** `'internal' | 'off'` mirror knob for the provisioned vault. */
  defaultMirror?: string | null;
  /**
   * How many accounts this link may create (v15). Default 1 (single-use,
   * the legacy shape). Caller validates the upper bound.
   */
  maxUses?: number;
  /**
   * Per-vault storage cap (bytes) to stamp onto each provisioned vault
   * (v15, B4). Omit/null = provision uncapped (legacy behavior).
   */
  vaultCapBytes?: number | null;
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
  const username = opts.username ?? null;
  const provisionVault = opts.provisionVault ?? true;
  const defaultMirror = opts.defaultMirror ?? null;
  const maxUses = opts.maxUses ?? 1;
  const vaultCapBytes = opts.vaultCapBytes ?? null;

  db.prepare(
    `INSERT INTO invites
       (token, created_by, vault_name, username, role, provision_vault, default_mirror,
        max_uses, used_count, email, vault_cap_bytes,
        expires_at, used_at, redeemed_user_id, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, NULL, NULL, NULL, ?)`,
  ).run(
    tokenHash,
    opts.createdBy,
    vaultName,
    username,
    role,
    provisionVault ? 1 : 0,
    defaultMirror,
    maxUses,
    vaultCapBytes,
    expiresAt,
    createdAt,
  );

  return {
    rawToken,
    invite: {
      tokenHash,
      createdBy: opts.createdBy,
      vaultName,
      username,
      role,
      provisionVault,
      defaultMirror,
      maxUses,
      usedCount: 0,
      email: null,
      vaultCapBytes,
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

/**
 * Is `username` already reserved by a PENDING pre-named invite (unredeemed,
 * unrevoked, not yet expired)? Two pending invites pre-naming the same
 * username would make the second one un-redeemable (the redeem path's
 * uniqueness check fails permanently for an enforced name), so mint-time
 * rejects the collision.
 *
 * Exact `=` comparison, deliberately NOT `COLLATE NOCASE` — an asymmetry
 * with `getUserByUsernameCI` worth naming. The users-table CI lookup is
 * defense in depth against legacy/hand-edited `users` rows that might carry
 * mixed case from before the validator pinned lowercase. `invites.username`
 * has no such legacy: the column is only ever written through the
 * `validateUsername`-gated mint path (api-invites.ts), so every stored value
 * is already lowercase, and the value compared against it went through the
 * same validator. A hand-edited mixed-case invites row wouldn't reserve —
 * but it also can't redeem: the redeem path re-runs `validateUsername` on
 * the pre-named value and rejects it (the hand-edited-row backstop in
 * account-setup.ts).
 */
export function usernameReservedByPendingInvite(
  db: Database,
  username: string,
  now: Date = new Date(),
): boolean {
  const row = db
    .query<{ token: string }, [string, string]>(
      `SELECT token FROM invites
       WHERE username = ? AND used_count < max_uses AND revoked_at IS NULL AND expires_at > ?
       LIMIT 1`,
    )
    .get(username, now.toISOString());
  return row !== null;
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
 * Validate an invite for redemption WITHOUT recording one. Throws on every
 * not-redeemable branch (not-found / expired / exhausted / revoked). Returns
 * the invite when it's redeemable. The redemption handler calls this FIRST (so
 * a bad token is rejected before any account/vault work), then does createUser,
 * then `recordInviteRedemption` INSIDE the user-row transaction (the atomic
 * seat-lock — the `< max_uses` UPDATE guard is what actually prevents an
 * over-seat under concurrency; this early check is the fast-path rejection).
 */
export function assertInviteRedeemable(
  db: Database,
  rawToken: string,
  now: Date = new Date(),
): Invite {
  const invite = findInviteByRawToken(db, rawToken);
  if (!invite) throw new InviteNotFoundError();
  // Revoked + exhausted are terminal regardless of clock; check them before
  // expiry so a revoked-then-expired invite reports the more specific reason.
  if (invite.revokedAt) throw new InviteRevokedError();
  // Exhaustion (v15): seats all taken. A single-use link (maxUses=1) throws
  // the familiar InviteUsedError ("already used"); a multi-use one throws
  // InviteExhaustedError ("all signups taken") so the copy can differ.
  if (invite.usedCount >= invite.maxUses) {
    throw invite.maxUses > 1 ? new InviteExhaustedError() : new InviteUsedError();
  }
  if (now.getTime() > new Date(invite.expiresAt).getTime()) {
    throw new InviteExpiredError();
  }
  return invite;
}

/**
 * Record ONE redemption against an invite — the multi-use-aware consume
 * (v15). Atomically:
 *   - increments `used_count` by 1,
 *   - stamps `used_at` on the FIRST redeem only (COALESCE keeps the original),
 *   - records the redeemer's `email` (B2) + `redeemed_user_id` as the
 *     MOST-RECENT redeemer (the canonical per-account email lives on
 *     `users.email`; this is the admin's at-a-glance latest).
 *
 * Exhaustion + revocation are enforced by the `used_count < max_uses AND
 * revoked_at IS NULL` guard in the UPDATE: a racing redeem that would take a
 * seat past the cap — or one racing a revoke — updates zero rows, and the
 * caller treats that as exhausted/revoked. Race-safe because sqlite
 * serializes writes (a legacy single-use link is just the max_uses=1 case:
 * the second concurrent redeem sees `used_count`=1, fails the `< max_uses`
 * guard, and changes zero rows — exactly the old single-use behavior).
 *
 * Returns `true` if THIS call recorded a redemption, `false` otherwise.
 */
export function recordInviteRedemption(
  db: Database,
  tokenHash: string,
  redeemedUserId: string,
  email: string | null = null,
  now: Date = new Date(),
): boolean {
  const stamp = now.toISOString();
  const res = db
    .prepare(
      `UPDATE invites
       SET used_count = used_count + 1,
           used_at = COALESCE(used_at, ?),
           redeemed_user_id = ?,
           email = ?
       WHERE token = ? AND used_count < max_uses AND revoked_at IS NULL`,
    )
    .run(stamp, redeemedUserId, email, tokenHash);
  return res.changes > 0;
}

/**
 * Legacy single-use consume — thin wrapper over {@link recordInviteRedemption}
 * for callers that don't capture email. Retained for backwards compatibility;
 * the redeem path uses `recordInviteRedemption` directly so it can record the
 * email. Race-safe + exhaustion-aware via the underlying function.
 *
 * Returns `true` if THIS call recorded a redemption, `false` otherwise.
 */
export function consumeInvite(
  db: Database,
  tokenHash: string,
  redeemedUserId: string,
  now: Date = new Date(),
): boolean {
  return recordInviteRedemption(db, tokenHash, redeemedUserId, null, now);
}

/**
 * Revoke a pending invite (admin DELETE). Stamps `revoked_at` only when the
 * invite still has seats left (`used_count < max_uses`) and isn't already
 * revoked. A multi-use link can be revoked mid-life to cut off its remaining
 * seats; a fully-exhausted link is terminal and revoke is a no-op. (For a
 * legacy single-use link `used_count < max_uses` is equivalent to the old
 * `used_at IS NULL` guard.) Returns `true` if this call revoked it, `false`
 * if it was already exhausted/revoked or not found.
 */
export function revokeInvite(db: Database, tokenHash: string, now: Date = new Date()): boolean {
  const res = db
    .prepare(
      "UPDATE invites SET revoked_at = ? WHERE token = ? AND used_count < max_uses AND revoked_at IS NULL",
    )
    .run(now.toISOString(), tokenHash);
  return res.changes > 0;
}

/**
 * Vault-delete cascade step (B1, 2026-06-09 hub-module-boundary): invalidate
 * every UNREDEEMED invite pinned to the deleted vault. An un-revoked pending
 * invite carrying `vault_name = <deleted>` would re-provision (resurrect)
 * the name on redemption — the cascade must close that door. Used/already-
 * revoked invites are untouched (terminal states). `vault_name` is an exact
 * `=` comparison — no pattern matching. Returns the number of invites
 * newly revoked.
 */
export function revokeInvitesForVault(
  db: Database,
  vaultName: string,
  now: Date = new Date(),
): number {
  const res = db
    .prepare(
      "UPDATE invites SET revoked_at = ? WHERE vault_name = ? AND used_count < max_uses AND revoked_at IS NULL",
    )
    .run(now.toISOString(), vaultName);
  return Number(res.changes);
}

/**
 * Q2 (hub-parity P2) — the account descriptor's conditional `signup_path`.
 * The hub cannot derive a redemption URL from the `invites` table (only
 * `sha256(token)` is stored, never the raw value — see the module doc), so
 * this reads back the ONE raw token persisted at mint time for a
 * deliberately PUBLIC (multi-use) invite (`api-invites.ts`'s
 * `handleCreateInvite`, which writes `hub_settings.public_signup_token`
 * after `issueInvite` when `maxUses > 1`) and re-validates it's still live.
 *
 * Returns `/account/setup/<token>` when the persisted invite is still
 * `"pending"` AND still multi-use (`maxUses > 1`); `null` on ANY miss
 * (never set, redeemed, revoked, exhausted, or expired) — and lazily clears
 * the stale setting in that case. No separate revoke/exhaust/expire hook is
 * needed: `inviteStatus` already derives all four terminal states from the
 * invite's own columns, so every miss flows through this one status check.
 *
 * A single-use invite (`maxUses === 1`) never reaches here in a way that
 * would matter — `handleCreateInvite` only ever writes the setting for
 * `maxUses > 1` — but the `maxUses > 1` re-check is kept anyway as
 * defense-in-depth against a hand-edited settings row.
 */
export function activePublicSignupPath(db: Database, now: Date = new Date()): string | null {
  const raw = getSetting(db, "public_signup_token");
  if (!raw) return null;
  const invite = findInviteByRawToken(db, raw);
  if (!invite || inviteStatus(invite, now) !== "pending" || invite.maxUses <= 1) {
    deleteSetting(db, "public_signup_token");
    return null;
  }
  return `/account/setup/${encodeURIComponent(raw)}`;
}
