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
   * The vault instance name this user is pinned to (Phase 1 multi-user is
   * single-vault-per-user). `null` means "no per-vault restriction" — the
   * default for admin accounts, where the OAuth issuer mints tokens for
   * any requested vault. Non-null pins the issuer to narrow scopes to
   * `vault:<assigned_vault>:<verb>`. No FK; vault names resolve through
   * `services.json` at mint time. Stored as `users.assigned_vault TEXT`
   * (added in migration v8).
   */
  assignedVault: string | null;
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
  assigned_vault: string | null;
}

function rowToUser(r: Row): User {
  return {
    id: r.id,
    username: r.username,
    passwordHash: r.password_hash,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    passwordChanged: r.password_changed === 1,
    assignedVault: r.assigned_vault,
  };
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
   * Vault instance name to pin the user to (Phase 1 single-vault). `null`
   * (default) means "no restriction" — admin posture. The OAuth issuer
   * (PR 4) reads this at mint time to narrow scopes. No validation here:
   * the API endpoint (PR 2) is responsible for checking against
   * `services.json` before passing through.
   */
  assignedVault?: string | null;
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
  const assignedVault = opts.assignedVault ?? null;
  try {
    db.prepare(
      `INSERT INTO users
         (id, username, password_hash, created_at, updated_at, password_changed, assigned_vault)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, username, passwordHash, stamp, stamp, passwordChanged, assignedVault);
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
    assignedVault,
  };
}

export function getUserByUsername(db: Database, username: string): User | null {
  const row = db.query<Row, [string]>("SELECT * FROM users WHERE username = ?").get(username);
  return row ? rowToUser(row) : null;
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
  return row ? rowToUser(row) : null;
}

export function getUserById(db: Database, id: string): User | null {
  const row = db.query<Row, [string]>("SELECT * FROM users WHERE id = ?").get(id);
  return row ? rowToUser(row) : null;
}

export function listUsers(db: Database): User[] {
  const rows = db.query<Row, []>("SELECT * FROM users ORDER BY created_at ASC").all();
  return rows.map(rowToUser);
}

export function userCount(db: Database): number {
  return (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get() ?? { n: 0 }).n;
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return argonVerify(user.passwordHash, password);
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
 * Hard-delete a user row and clean up FK-dependent rows.
 *
 * Schema reality at v8:
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
