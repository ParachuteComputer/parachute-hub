import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
/**
 * User accounts for the hub. Single-user-mode by default — `createUser`
 * refuses to create a second account unless `allowMulti` is set, so the
 * launch posture is "one account per hub" without baking that assumption
 * into the schema. Multi-user grows by setting the flag at the call site,
 * not by altering the table.
 *
 * Password hashing: argon2id via `@node-rs/argon2`. Pure-Rust prebuilts,
 * Bun-friendly (no node-gyp). Defaults are RFC 9106 second-recommended
 * parameters (m=19MiB, t=2, p=1) — fine for an interactive single-user
 * login.
 *
 * IDs are `crypto.randomUUID()` — UUIDv4. The brief called for ULIDs but
 * for the hub's access pattern (≤handful of accounts, no time-ordered
 * scan) UUIDv4's extra ~5 bytes of metadata are not load-bearing. Easy
 * to swap if a downstream integration needs the ULID prefix.
 */
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Whether the user has changed their password since account creation.
   * `false` means the user signed up with an admin-typed default password
   * and the force-change-password flow at sign-in time should redirect
   * them to `/account/change-password`. The wizard's first admin and env-
   * seeded admins land as `true` (they chose their own password). Stored
   * as `users.password_changed INTEGER 0|1` (added in migration v8).
   */
  passwordChanged: boolean;
  /**
   * The vault instance names this user has access to (multi-user Phase 2
   * PR 2 — many-to-many via the `user_vaults` table; design
   * 2026-05-20-multi-user-phase-1.md §Phase 2). Empty `[]` means "no per-
   * vault restriction" for admin accounts (where `isFirstAdmin` is true
   * and the OAuth issuer mints tokens for any requested vault). Empty
   * `[]` for a non-admin means "no access" — distinct semantics that the
   * consent picker enforces. A non-empty array lists every vault the
   * user is assigned to; the OAuth issuer narrows tokens to
   * `vault:<name>:<verb>` for any name in the list. No FK; vault names
   * resolve through `services.json` at mint time. Replaces the v8 single
   * `assigned_vault` column (dropped in migration v10). Sorted in
   * `created_at ASC` insert-order for deterministic iteration.
   */
  assignedVaults: string[];
}

export class SingleUserModeError extends Error {
  constructor() {
    super(
      "a user already exists; pass --allow-multi to create additional accounts (forward-compat for multi-user mode)",
    );
    this.name = "SingleUserModeError";
  }
}

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`username "${username}" is already in use`);
    this.name = "UsernameTakenError";
  }
}

export class UserNotFoundError extends Error {
  constructor(ref: string) {
    super(`user "${ref}" not found`);
    this.name = "UserNotFoundError";
  }
}

interface Row {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
  password_changed: number;
}

/**
 * Read every (user_id → vault_name list) tuple in one shot. Cheaper than
 * issuing one SELECT per row when callers (listUsers, etc.) hydrate
 * several rows. Returns a Map keyed by user_id with the vault names
 * sorted by `created_at ASC` for stable iteration. Users with no
 * `user_vaults` rows are absent from the map; rowToUser substitutes
 * an empty array.
 */
function loadVaultMap(db: Database, userIds?: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let rows: { user_id: string; vault_name: string }[];
  if (userIds && userIds.length > 0) {
    const placeholders = userIds.map(() => "?").join(",");
    rows = db
      .query<{ user_id: string; vault_name: string }, string[]>(
        `SELECT user_id, vault_name FROM user_vaults
         WHERE user_id IN (${placeholders})
         ORDER BY user_id ASC, created_at ASC, vault_name ASC`,
      )
      .all(...userIds);
  } else {
    rows = db
      .query<{ user_id: string; vault_name: string }, []>(
        "SELECT user_id, vault_name FROM user_vaults ORDER BY user_id ASC, created_at ASC, vault_name ASC",
      )
      .all();
  }
  for (const r of rows) {
    const list = map.get(r.user_id);
    if (list) list.push(r.vault_name);
    else map.set(r.user_id, [r.vault_name]);
  }
  return map;
}

function rowToUser(r: Row, assignedVaults: string[]): User {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    passwordChanged: r.password_changed === 1,
    assignedVaults,
  };
}

/**
 * Hydrate a single user's `assignedVaults` list directly. Single
 * SELECT against `user_vaults` ordered by insertion time. Used by the
 * single-row helpers (`getUserById`, `getUserByUsername`, etc.).
 */
function readVaultsForUser(db: Database, userId: string): string[] {
  return db
    .query<{ vault_name: string }, [string]>(
      "SELECT vault_name FROM user_vaults WHERE user_id = ? ORDER BY created_at ASC, vault_name ASC",
    )
    .all(userId)
    .map((r) => r.vault_name);
}

export interface CreateUserOpts {
  /** Allow creating an additional user when one already exists. Off by default. */
  allowMulti?: boolean;
  now?: () => Date;
  /**
   * Whether the new user has already chosen their password. Default `false`
   * — the admin-creates-user path (PR 2) lands new accounts with the bit
   * unset so the user is force-redirected to change it on first sign-in
   * (PR 3). The wizard's first-admin path and env-seeded admin path pass
   * `true` (they chose their own password through the wizard form / env
   * vars; no force-change needed).
   */
  passwordChanged?: boolean;
  /**
   * Vault instance names this user should be granted access to (multi-
   * user Phase 2 PR 2 — many-to-many via `user_vaults`). Default `[]`
   * (no entries) means "no restriction" for admins / "no access" for
   * non-admins. Each name is inserted into `user_vaults` within the same
   * transaction as the `users` row so creation is atomic. No validation
   * here: the API endpoint (`api-users.ts`) is responsible for checking
   * each name against `services.json` before passing through.
   */
  assignedVaults?: string[];
}

export async function createUser(
  db: Database,
  username: string,
  password: string,
  opts: CreateUserOpts = {},
): Promise<User> {
  const count = (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get() ?? { n: 0 })
    .n;
  if (count > 0 && !opts.allowMulti) throw new SingleUserModeError();

  const id = randomUUID();
  const passwordHash = await argonHash(password);
  const stamp = (opts.now?.() ?? new Date()).toISOString();
  const passwordChanged = opts.passwordChanged === true ? 1 : 0;
  // De-dupe + preserve insert order so the returned array matches what
  // `getUserById` would load right after (which sorts by created_at +
  // vault_name). Empty array is "no vaults" — admin posture or a non-
  // admin who'll have vaults added later via `setUserVaults`.
  const assignedVaults: string[] = [];
  const seen = new Set<string>();
  for (const v of opts.assignedVaults ?? []) {
    if (!seen.has(v)) {
      seen.add(v);
      assignedVaults.push(v);
    }
  }
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO users
           (id, username, password_hash, created_at, updated_at, password_changed)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, username, passwordHash, stamp, stamp, passwordChanged);
      if (assignedVaults.length > 0) {
        const insertVault = db.prepare(
          `INSERT INTO user_vaults (user_id, vault_name, role, created_at)
           VALUES (?, ?, 'write', ?)`,
        );
        for (const vaultName of assignedVaults) {
          insertVault.run(id, vaultName, stamp);
        }
      }
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") && msg.includes("users.username")) {
      throw new UsernameTakenError(username);
    }
    throw err;
  }
  return {
    id,
    username,
    passwordHash,
    createdAt: stamp,
    updatedAt: stamp,
    passwordChanged: passwordChanged === 1,
    assignedVaults,
  };
}

export function getUserByUsername(db: Database, username: string): User | null {
  const row = db.query<Row, [string]>("SELECT * FROM users WHERE username = ?").get(username);
  return row ? rowToUser(row, readVaultsForUser(db, row.id)) : null;
}

/**
 * Case-insensitive username lookup. Username validation already pins
 * the canonical form to lowercase (`[a-z0-9_-]`), so the only way a
 * mixed-case lookup ever fires is a defense-in-depth check at the
 * admin-create-user boundary — a future loosening of the validator
 * (or a hand-edited row) wouldn't accidentally allow `Bob` to land
 * alongside an existing `bob`. SQLite's `COLLATE NOCASE` does the work
 * with no schema change.
 */
export function getUserByUsernameCI(db: Database, username: string): User | null {
  const row = db
    .query<Row, [string]>("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
    .get(username);
  return row ? rowToUser(row, readVaultsForUser(db, row.id)) : null;
}

export function getUserById(db: Database, id: string): User | null {
  const row = db.query<Row, [string]>("SELECT * FROM users WHERE id = ?").get(id);
  return row ? rowToUser(row, readVaultsForUser(db, row.id)) : null;
}

export function listUsers(db: Database): User[] {
  const rows = db.query<Row, []>("SELECT * FROM users ORDER BY created_at ASC").all();
  if (rows.length === 0) return [];
  // One JOIN-ish read for everyone — single SELECT against user_vaults
  // beats N+1 single-user reads.
  const vaultMap = loadVaultMap(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => rowToUser(r, vaultMap.get(r.id) ?? []));
}

export function userCount(db: Database): number {
  return (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get() ?? { n: 0 }).n;
}

/**
 * Single source of truth for "who is *the* admin in Phase 1." The
 * earliest-created user row is the wizard or env-seeded admin by
 * construction — Phase 1 has no role model, so the first row is the
 * hub administrator. Used by:
 *
 *   - `api-users.ts` for the first-admin-undeletable rail (the only
 *     user who can't be deleted, since deleting them would self-lock
 *     the hub).
 *   - `admin-host-admin-token.ts` to gate the SPA-bearer mint endpoint
 *     to the admin only — any signed-in non-admin friend hitting it
 *     would otherwise get a JWT carrying `parachute:host:admin` +
 *     `parachute:host:auth`, a full-admin privesc (multi-user Phase 1
 *     friend-account follow-up).
 *   - `admin-handlers.ts` for the login-redirect default — non-admin
 *     users targeting `/admin/*` get redirected to `/account/` instead
 *     of a 403 wall.
 *
 * Returns `null` only when the users table is empty (pre-wizard state).
 */
export function getFirstAdminId(db: Database): string | null {
  const row = db
    .query<{ id: string }, []>("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
    .get();
  return row?.id ?? null;
}

/**
 * Convenience predicate over `getFirstAdminId`. Caller sites read
 * cleaner as `isFirstAdmin(db, userId)` than `getFirstAdminId(db) === userId`.
 */
export function isFirstAdmin(db: Database, userId: string): boolean {
  return getFirstAdminId(db) === userId;
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return argonVerify(user.passwordHash, password);
}

/**
 * Replace a user's vault assignments atomically (multi-user Phase 2 PR 2).
 *
 * Two writes inside one transaction:
 *   1. DELETE every existing `user_vaults` row for `userId`.
 *   2. INSERT one row per name in `vaultNames`.
 *
 * Returns `false` when the user doesn't exist (idempotent — the API layer
 * translates that to 404); `true` when the assignments were updated.
 * Passing an empty array clears every existing assignment (non-admin
 * non-empty array = "no vault access"). Duplicates are silently
 * collapsed (de-duped at the array level before INSERT). No vault-name
 * validation here — `api-users.ts` is responsible for checking each
 * name against `services.json`. No FK on `vault_name` (matches the
 * pre-existing schema contract — vault names resolve through
 * `services.json`, not a DB row).
 *
 * Caller responsibilities:
 *   - First-admin protection — admin "membership" is unrestricted by
 *     design (see `isFirstAdmin`); `api-users.ts` refuses to call this
 *     for the first admin's row.
 *   - Vault-name validation against the live services manifest.
 */
export function setUserVaults(
  db: Database,
  userId: string,
  vaultNames: readonly string[],
  now: () => Date = () => new Date(),
): boolean {
  const exists = db
    .query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?")
    .get(userId);
  if (!exists) return false;
  // De-dupe before INSERT — duplicate names from a misbehaving client
  // would trip the (user_id, vault_name) PRIMARY KEY constraint and
  // abort the whole transaction. Silently collapse the dupes; the
  // operator's intent is "this user has access to these vaults"
  // regardless of how many times the same name appears.
  const seen = new Set<string>();
  const uniques: string[] = [];
  for (const v of vaultNames) {
    if (!seen.has(v)) {
      seen.add(v);
      uniques.push(v);
    }
  }
  const stamp = now().toISOString();
  db.transaction(() => {
    db.prepare("DELETE FROM user_vaults WHERE user_id = ?").run(userId);
    if (uniques.length > 0) {
      const insertVault = db.prepare(
        `INSERT INTO user_vaults (user_id, vault_name, role, created_at)
         VALUES (?, ?, 'write', ?)`,
      );
      for (const vaultName of uniques) {
        insertVault.run(userId, vaultName, stamp);
      }
    }
    // Bump the user's updated_at so downstream observers (SPA row,
    // /account/) reflect the change without us having to bake a
    // separate "vault assignments changed" timestamp.
    db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(stamp, userId);
  })();
  return true;
}

/**
 * Updates the password for an existing user. Throws `UserNotFoundError` if
 * the id has no row. Single-user-mode flows look up by username first and
 * pass the resolved id here.
 */
export async function setPassword(
  db: Database,
  userId: string,
  newPassword: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const passwordHash = await argonHash(newPassword);
  const stamp = now().toISOString();
  const result = db
    .prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
    .run(passwordHash, stamp, userId);
  if (result.changes === 0) throw new UserNotFoundError(userId);
}

/**
 * Reset a user's password to an admin-chosen value (multi-user Phase 2
 * PR 1, hub#252 follow-up). Used by the `POST /api/users/:id/reset-password`
 * admin endpoint when a friend forgets their password — the operator's
 * only Phase-1 recovery was delete+recreate, which is destructive-feeling
 * even though it's safe (vaults are independent of accounts).
 *
 * Three writes inside one transaction:
 *
 *   1. Rotate `password_hash` to the new argon2id hash and flip
 *      `password_changed` back to 0 so the user is force-redirected
 *      through `/account/change-password` on next sign-in (same posture
 *      as the admin-created-user default — the operator hands the temp
 *      password out-of-band, the user picks their own immediately).
 *   2. Revoke every still-active token row owned by the user
 *      (`tokens.revoked_at = now WHERE user_id = ? AND revoked_at IS NULL`).
 *      The reset is a "the old password leaked" recovery shape — leaving
 *      pre-reset tokens valid for an attacker who knew the old password
 *      would defeat the purpose. We keep the rows (don't NULL `user_id`
 *      like `deleteUser` does) because the audit trail naturally re-
 *      anchors to the still-existing user row.
 *   3. Bump `updated_at` so the SPA's row reflects the rotation.
 *
 * Hash OUTSIDE the transaction — argon2id is async and `db.transaction()`
 * on bun:sqlite is sync; doing it inside silently breaks atomicity (same
 * constraint api-account.ts:399 documents for the change-password POST).
 *
 * **Revocation propagation lag (smoke 2026-05-27, finding 3)**: this
 * function marks tokens revoked in hub's DB immediately. Hub's
 * `/.well-known/parachute-revocation.json` reflects the new revocation
 * on the next fetch. BUT resource servers (vault, scribe, etc.) consult
 * the revocation list via scope-guard's `REVOCATION_CACHE_TTL_MS = 60_000`
 * cache — so they may continue accepting the revoked token for up to
 * 60 seconds after this call returns. For the "friend forgot pw"
 * recovery path this is fine (no adversary). For the "stolen device,
 * kill the friend's tokens NOW" path it's a meaningful exposure
 * window — operators in that scenario should also restart the
 * affected resource servers to flush their cache. See
 * `REVOCATION_LAG_SECONDS` for the value surfaced to API callers.
 *
 * Caller responsibilities (not enforced here):
 *   - Validate `newPassword` first (`validatePassword`) — this helper
 *     trusts the input and runs argon2id over whatever it gets.
 *   - First-admin protection — admin password reset is restricted to
 *     non-first-admin users per design §7. The first admin uses the
 *     normal `/account/change-password` flow for themselves.
 *
 * Returns true on success, false if the user doesn't exist (idempotent —
 * the API layer translates that to 404).
 */
export async function resetUserPassword(
  db: Database,
  userId: string,
  newPassword: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  // Existence pre-check OUTSIDE the tx. The argon2id hash below is the
  // expensive step; hashing for a non-existent user is wasted CPU and
  // also leaks "was this id valid" timing. Cheap SELECT first.
  const exists = db
    .query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?")
    .get(userId);
  if (!exists) return false;
  // Hash outside the tx — see note above.
  const passwordHash = await argonHash(newPassword);
  const stamp = now().toISOString();
  // Track whether the tx actually applied the update — `result.changes === 0`
  // means the row vanished between the pre-check and the tx body (concurrent
  // delete race). The outer caller needs to know so its 200/{ok,user} response
  // isn't a lie when the user is gone. Reviewer fold on hub#427.
  let updated = false;
  db.transaction(() => {
    const result = db
      .prepare(
        "UPDATE users SET password_hash = ?, password_changed = 0, updated_at = ? WHERE id = ?",
      )
      .run(passwordHash, stamp, userId);
    if (result.changes === 0) return;
    updated = true;
    // Revoke still-active tokens. Audit trail stays on the user row —
    // we don't null `user_id` because the parent users row sticks
    // around (unlike `deleteUser` where the parent vanishes).
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
      stamp,
      userId,
    );
  })();
  return updated;
}

/**
 * Hard-delete a user row and clean up FK-dependent rows.
 *
 * Schema reality at v10:
 *   - `tokens.user_id` is nullable (made nullable in migration v6). The
 *     plan from the design doc is "tokens stay with `revoked_at` set so
 *     the audit trail of 'this user existed and held these tokens'
 *     survives." But the FK is RESTRICT-on-delete, so we need to null
 *     out `tokens.user_id` after revoking to actually delete the
 *     parent users row. The audit trail survives via the `subject`
 *     column we backfill from the username plus the existing
 *     `created_at`, `scopes`, `client_id`, `revoked_at` fields.
 *   - `sessions.user_id` and `grants.user_id` are NOT NULL with a
 *     non-cascading FK. Both are deleted before the users row drops.
 *   - `user_vaults.user_id` has `ON DELETE CASCADE` (migration v10), so
 *     vault assignments are dropped automatically when the parent row
 *     goes. No explicit cleanup needed.
 *
 * Returns false when no user matches the id (idempotent — the API
 * layer translates that to 404). Returns true on a successful delete.
 *
 * Caller is responsible for the first-admin-undeletable check; this
 * helper enforces no policy beyond the schema hygiene.
 */
export function deleteUser(db: Database, userId: string): boolean {
  const row = db.query<Row, [string]>("SELECT * FROM users WHERE id = ?").get(userId);
  if (!row) return false;
  const now = new Date().toISOString();
  db.transaction(() => {
    // 1. Revoke + retain tokens for audit. Mark every un-revoked token
    //    revoked, then null out user_id on every token (revoked or
    //    not) so the FK doesn't block the users delete. Backfill
    //    `subject` with the username so the audit trail isn't anchored
    //    to a primary key that just vanished.
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
      now,
      userId,
    );
    db.prepare(
      "UPDATE tokens SET subject = COALESCE(subject, ?), user_id = NULL WHERE user_id = ?",
    ).run(row.username, userId);
    // 2. Drop sessions + grants. Both have non-cascading FKs on user_id;
    //    leaving rows behind would RESTRICT the users delete below.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(userId);
    // 3. Drop the user row itself.
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  })();
  return true;
}

/**
 * Username validation (multi-user Phase 1, design 2026-05-20-multi-user-phase-1.md §4).
 *
 * Rules — settled with Aaron pre-PR-1:
 *   * Charset: `[a-z0-9_-]` (lowercase letters, digits, underscore, hyphen).
 *     Lowercase-only sidesteps "Bob vs bob" case-folding bugs across every
 *     downstream surface (URLs, log lines, the admin SPA's row keys).
 *   * Length: 2-32 chars inclusive. Hard floor on 1-char names (no `a`,
 *     `b`, …) because those are too easy to typo into someone else's
 *     account; hard ceiling on 32 because URL paths and log lines stay
 *     scannable. (Same shape vault-side scope verbs use.)
 *   * Reserved list (case-insensitive): admin, root, system, setup,
 *     parachute, hub. Keeps URL-shaped surfaces safe (Phase 2 may add
 *     `/users/<username>` paths; reserving the namespace now is cheap).
 *     Regex already pins lowercase, but the case-folded check is defense
 *     in depth: if a future loosening lets capitals through, the reserved
 *     check still triggers on `Admin`, `ROOT`, etc.
 *
 * Discriminated-union return: callers branch on `valid` rather than
 * throwing. PR 2's `POST /api/users` returns a 400 with the `reason`
 * surfaced in the response body.
 */
export const USERNAME_RESERVED = ["admin", "root", "system", "setup", "parachute", "hub"] as const;

const USERNAME_REGEX = /^[a-z0-9_-]+$/;
const USERNAME_MIN_LEN = 2;
const USERNAME_MAX_LEN = 32;

export type ValidateUsernameResult =
  | { valid: true; name: string }
  | { valid: false; reason: "format" | "length" | "reserved" };

export function validateUsername(name: string): ValidateUsernameResult {
  // Length check first — a 0-char string fails the regex on emptiness but
  // "length" is the more honest diagnostic.
  if (name.length < USERNAME_MIN_LEN || name.length > USERNAME_MAX_LEN) {
    return { valid: false, reason: "length" };
  }
  // The regex deliberately allows leading/trailing `_` and `-` (so
  // `_-_`, `--alice`, `-foo`, `bar_` all pass the format gate). Stricter
  // rules can land later if real-world users hit confusion. Vault's
  // parallel username validator has the same shape — cross-repo parity
  // matters more than aesthetic edge-case rejection here.
  if (!USERNAME_REGEX.test(name)) {
    return { valid: false, reason: "format" };
  }
  // Reserved-words check is case-insensitive even though the regex already
  // pins lowercase — see comment above.
  const lower = name.toLowerCase();
  if (USERNAME_RESERVED.some((r) => r === lower)) {
    return { valid: false, reason: "reserved" };
  }
  return { valid: true, name };
}

/**
 * Password validation (multi-user Phase 1, design §5).
 *
 * Single rule: minimum 12 characters. No complexity classes — modern
 * guidance (NIST 800-63B) prefers passphrase length over forced-symbol
 * mixes, and Aaron settled on 12 as the floor pre-PR-1. No max length
 * (argon2id absorbs whatever the user submits).
 *
 * Same discriminated-union shape as `validateUsername` — PR 2's create-
 * user / reset-password endpoints (and PR 3's `/account/change-password`
 * form) wire the `reason` into the response.
 */
export const PASSWORD_MIN_LEN = 12;

/**
 * Upper bound for incoming password bodies. Not enforced inside
 * `validatePassword` itself — the validator's contract is "length floor,
 * no complexity rules" and adding a ceiling would muddy it. Exposed as
 * a constant so PR 2's `POST /api/users` (and PR 3's change-password
 * form) can cap incoming bodies before argon2id touches them. Defense
 * against a CPU-DoS shape where an unauthenticated POST submits a
 * megabyte password and forces a long argon2id hash. 256 chars is
 * comfortably above any human-chosen passphrase (Diceware 8-word
 * passphrases run ~55 chars).
 */
export const PASSWORD_MAX_LEN = 256;

export type ValidatePasswordResult = { valid: true } | { valid: false; reason: "too_short" };

export function validatePassword(password: string): ValidatePasswordResult {
  if (password.length < PASSWORD_MIN_LEN) {
    return { valid: false, reason: "too_short" };
  }
  return { valid: true };
}
