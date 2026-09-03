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
   * Contactable email captured at signup (migration v15, B2). The username
   * is the login + URL identity ([a-z0-9_-]); email is the SEPARATE contact
   * field the operator sees + uses to reach a signup. `null` for every
   * account created before email capture (wizard admin, env-seeded admin,
   * pre-named friend invites that didn't collect one). Not unique at the
   * schema level — see migration v15.
   */
  email: string | null;
  /**
   * The vault instance names this user has access to (multi-user Phase 2
   * PR 2 — many-to-many via the `user_vaults` table; design
   * 2026-05-20-multi-user-phase-1.md §Phase 2). Empty `[]` means "no per-
   * vault restriction" for admin accounts (where `isHubAdmin` is true
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
  /**
   * Hub-wide role (migration v20, hub#881). `'admin'` = hub administrator
   * (unrestricted vault posture, may mint the host-admin bearer, may reach
   * `/admin/*`); `'user'` = friend account. Before v20 "admin" was the
   * earliest `users` row (`getFirstAdminId`) — a position, not a property,
   * so there could only ever be one. The column stores it, so a second
   * admin can be promoted (`POST /api/users/:id/promote-hub-admin`).
   *
   * Read through `isHubAdmin`, never by comparing this string at a call
   * site: that helper fails closed on unrecognised values. `getFirstAdminId`
   * survives for the genuinely first-admin-only rails (undeletable, seed
   * `admin` username waiver) — see `isHubAdmin`.
   */
  hubRole: string;
}

export type HubRole = "admin" | "user";

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

export class InvalidUsernameError extends Error {
  readonly reason: "format" | "length" | "reserved";
  constructor(username: string, reason: "format" | "length" | "reserved") {
    super(`username "${username}" is invalid (${reason})`);
    this.name = "InvalidUsernameError";
    this.reason = reason;
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
  email: string | null;
  hub_role: string;
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
    email: r.email ?? null,
    assignedVaults,
    // Pre-v20 rows read back through a test DB built without the column
    // would be `undefined`; normalise to the fail-closed 'user' default.
    hubRole: r.hub_role ?? "user",
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

/**
 * The per-vault verbs a `user_vaults.role` grants. The schema's `role`
 * column is `TEXT NOT NULL DEFAULT 'write'`; today every assignment is created
 * with `role = 'write'`. This is the single place the verb-cap lives, so the
 * OAuth mint cap (`capScopesToUserAuthority`) and the `/account` mint UI both
 * read authority from here.
 *
 * **Assigned users hold FULL vault authority (read + write + admin)** as of
 * 2026-05-30 (Aaron's call: "any assigned user gets admin"). The point of the
 * multi-user flow is that someone given a vault — owned or shared — can connect
 * their own client (e.g. Claude MCP) to it and grant everything they'd want,
 * including `vault:<name>:admin` (token creation + config). Owner-vs-shared is
 * NOT distinguished today; a shared user gets admin too (explicit trade-off).
 *
 * Mapping:
 *   - `write` (today's default)     → `["read", "write", "admin"]`
 *   - `member`                      → `["read", "write"]` — full data
 *     authority, NO admin. This is the role for a principal that should USE a
 *     vault but must not be able to hand it to anyone else: `admin` is what
 *     `callerCanAdminVault` reads, so a `member` row cannot grant, revoke, or
 *     list access (the tools are hidden from it, not merely refused). Added
 *     because `write` silently means "and may re-grant to anybody". Named for
 *     membership, not for agent-ness: the channel-attached-vaults flow writes
 *     this same role for every principal synced from a Buzz channel, human or
 *     agent alike.
 *   - `read` (forward-compat)       → `["read"]` — a *deliberate* read-only
 *     assignment stays read-only even under the any-assigned-user-gets-admin
 *     policy. `grant-access` on `/account/mcp` can create these rows.
 *   - anything else (unknown role)  → `[]` — fail closed. An unrecognised
 *     role grants no minting authority rather than silently defaulting to
 *     write. (Defense-in-depth: a hand-edited / future row with a role this
 *     code doesn't understand should not be treated as broad.)
 *
 * Scope of the widening: this only affects `vault:<name>:<verb>` for vaults
 * the user is assigned. Hub-level admin (`hub:admin`) + host operator scopes
 * (`parachute:host:*`) are NOT vault scopes and remain ungrantable by
 * non-admins — the cap's named-vault branch is the only thing this touches.
 */
export type VaultVerb = "read" | "write" | "admin";

/**
 * How a `user_vaults` row was written (migration v21). Attribution, not
 * authority — nothing reads this to decide what a row may do.
 *
 *   - `mcp` — the `/account/mcp` `grant-access` tool (the only writer today).
 *   - `cli` — a local `parachute` invocation against `hub.db`.
 *   - `api` — a REST admin path (`/api/users`, invite redeem).
 *
 * NULL on every row that pre-dates the migration, and on any writer that
 * hasn't been taught to record it. NULL means "unknown", never "none".
 */
export const GRANT_VIA_VALUES = ["mcp", "cli", "api"] as const;
export type GrantVia = (typeof GRANT_VIA_VALUES)[number];

/**
 * Who made a `user_vaults` grant, recorded alongside it (migration v21).
 *
 * Both identifiers are carried because neither alone is enough: several
 * agents with their own Nostr keys routinely link to ONE hub user, so
 * `grantedByUserId` cannot tell them apart, while a Bearer/CLI/API caller has
 * no key at all and leaves `grantedByPubkey` NULL. Recording the empty one as
 * a placeholder would fabricate attribution, so it stays NULL.
 */
export interface VaultGrantAttribution {
  grantedByUserId?: string | null;
  grantedByPubkey?: string | null;
  grantedVia?: GrantVia | null;
}

export function vaultVerbsForRole(role: string): VaultVerb[] {
  if (role === "write") return ["read", "write", "admin"];
  if (role === "member") return ["read", "write"];
  if (role === "read") return ["read"];
  return [];
}

/**
 * Read the verbs a user may mint for one of their assigned vaults.
 *
 * Returns `null` when the user has NO `user_vaults` row for `vaultName` —
 * i.e. the vault is not in their assignment. The caller treats `null` as a
 * hard 403 (no minting for an unassigned vault). When a row exists, returns
 * the verb list `vaultVerbsForRole` maps the stored role to (today always
 * `["read", "write"]` since every assignment is `role = 'write'`).
 *
 * This reads the role column directly rather than going through
 * `getUserById().assignedVaults` because that array is verb-blind — it
 * names the vaults but not the role granted. The friend-mint authorization
 * cap needs the role.
 */
export function vaultVerbsForUserVault(
  db: Database,
  userId: string,
  vaultName: string,
): VaultVerb[] | null {
  const row = db
    .query<{ role: string }, [string, string]>(
      "SELECT role FROM user_vaults WHERE user_id = ? AND vault_name = ?",
    )
    .get(userId, vaultName);
  if (!row) return null;
  return vaultVerbsForRole(row.role);
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
  /**
   * Contactable email to store on the new account (migration v15, B2).
   * Default `null` — the wizard/env-seeded admin paths and pre-named
   * friend invites that don't collect email omit it. The public-signup
   * redeem path passes the validated email so the operator can reach the
   * signup. Validation (format) is the caller's responsibility
   * (`validateEmail`); this just persists what it's given.
   */
  email?: string | null;
  /**
   * The `user_vaults.role` to write for every entry in `assignedVaults`.
   * Default `'write'` (= owner; `vaultVerbsForRole('write')` grants the
   * full read/write/admin triple). The invite-redeem path passes the
   * invite's baked-in role so a future shared-into-existing-vault invite
   * can land a narrower `'read'` role without a second migration. All
   * existing call sites omit it and keep the historical `'write'` default.
   */
  role?: string;
  /**
   * Optional hook run INSIDE the same transaction as the user + user_vaults
   * inserts, after them, with the new user's id. Throwing from it rolls the
   * whole insert back (no orphan user row). The invite-redeem path uses this
   * to atomically re-check + consume a single-use invite together with the
   * account creation — so two concurrent redeems of one invite can't both
   * create an account (the loser throws here and its user insert rolls back),
   * while a failure still leaves the invite re-usable (nothing committed).
   * Must be synchronous — bun:sqlite transactions can't await.
   */
  withinTx?: (userId: string) => void;
  /**
   * Hub-wide role for the new account (migration v20, hub#881).
   *
   * Default: `'admin'` when this is the FIRST account on the hub (the
   * users table is empty), `'user'` otherwise. That default is exactly
   * the pre-v20 definition of "the admin" — `getFirstAdminId` returned
   * the earliest row, and the earliest row is whichever account a
   * bootstrap path created into an empty table. Deriving it here rather
   * than at each bootstrap call site is deliberate: there are SIX first-
   * user paths (setup wizard, `serve`'s env-seeded admin, `auth
   * set-password`, and the NIP-98 auto-provision pairs in
   * `grant-access.ts` / `nostr-http-auth.ts`), and a path that forgot to
   * pass the flag would silently create a hub whose only account is not
   * an admin. The seed paths still pass `'admin'` explicitly for
   * legibility; it agrees with the default.
   *
   * Non-first accounts must NOT pass `'admin'` — promotion is the
   * `POST /api/users/:id/promote-hub-admin` endpoint, which enforces
   * the zero-`user_vaults`-rows invariant that admin posture requires.
   */
  hubRole?: HubRole;
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

  // Chokepoint (hub#864): every users.username write is gated here so the
  // wizard / env-seed / `auth set-password` paths cannot land a name the
  // linkage ceremony will refuse. Existing rows are not rewritten.
  const check = validateUsername(username);
  if (!check.valid && !isSeedAdminUsername(username, count)) {
    throw new InvalidUsernameError(username, check.reason);
  }

  const id = randomUUID();
  const passwordHash = await argonHash(password);
  const stamp = (opts.now?.() ?? new Date()).toISOString();
  const passwordChanged = opts.passwordChanged === true ? 1 : 0;
  const email = opts.email ?? null;
  // First account on the hub is the hub admin — see `CreateUserOpts.hubRole`.
  const hubRole: HubRole = opts.hubRole ?? (count === 0 ? "admin" : "user");
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
           (id, username, password_hash, created_at, updated_at, password_changed, email, hub_role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, username, passwordHash, stamp, stamp, passwordChanged, email, hubRole);
      if (assignedVaults.length > 0) {
        const role = opts.role ?? "write";
        const insertVault = db.prepare(
          `INSERT INTO user_vaults (user_id, vault_name, role, created_at)
           VALUES (?, ?, ?, ?)`,
        );
        for (const vaultName of assignedVaults) {
          insertVault.run(id, vaultName, role, stamp);
        }
      }
      // In-transaction hook (e.g. consume a single-use invite). Throwing here
      // rolls back the user + user_vaults inserts above — no orphan row.
      opts.withinTx?.(id);
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
    email,
    assignedVaults,
    hubRole,
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

/**
 * Resolve a hub user by id, else username (case-insensitive). Used by the
 * mint `--user` / body `user` flags (hub#833) so operators can name an
 * account either way.
 */
export function resolveUser(db: Database, ident: string): User | null {
  if (ident.length === 0) return null;
  return getUserById(db, ident) ?? getUserByUsernameCI(db, ident);
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
 * The earliest-created user row — the account the setup wizard, the
 * env seed, or `auth set-password` created into an empty hub.
 *
 * **This is no longer "who is an admin."** Since migration v20 (hub#881)
 * that question is `isHubAdmin`, which reads the stored `users.hub_role`
 * and is true for any number of accounts. `getFirstAdminId` narrowed to
 * the two rails that are genuinely about the FIRST account, not about
 * administrator privilege:
 *
 *   - `api-users.ts` first-admin-undeletable. Deleting the original
 *     account would self-lock the hub; keeping exactly one account
 *     permanently undeletable is what guarantees ≥1 admin survives any
 *     sequence of deletes. Promoted admins ARE deletable.
 *   - `users.ts:isSeedAdminUsername` — the reserved-word waiver that
 *     lets the very first account be named `admin`.
 *
 * Two bootstrap sentinels also still read it, as `=== null` ("this hub
 * has no accounts at all yet"): `grant-access.ts` and `nostr-http-auth.ts`
 * refuse to auto-provision the hub owner. See `isHubAdmin` for why that
 * spelling was kept.
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
 * Only for the first-account rails listed there — for "may this user do
 * admin things", use `isHubAdmin`.
 */
export function isFirstAdmin(db: Database, userId: string): boolean {
  return getFirstAdminId(db) === userId;
}

/**
 * Single source of truth for "is this user a hub administrator"
 * (migration v20, hub#881).
 *
 * Reads the stored `users.hub_role`, so a hub can have more than one
 * admin. Replaces `isFirstAdmin` at every site that meant *privilege*
 * rather than *position*: the host-admin / vault-admin / module-token
 * mints, `/admin/*` routing, the OAuth vault-scope decision, the NIP-98
 * principal, and the account-MCP admin tools.
 *
 * **Fails closed.** True only for the exact string `'admin'`; a missing
 * row, an unknown role, or a NULL all return false. Same defense
 * `vaultVerbsForRole` applies to `user_vaults.role` — a hand-edited or
 * future-valued row grants nothing rather than defaulting to broad.
 *
 * ## The invariant admins carry
 *
 * `vaultScopeForUser` (oauth-handlers.ts) short-circuits an admin to
 * `[]` = "no vault narrowing". For a NON-admin the identical `[]` means
 * "no vault access at all". So an admin's `user_vaults` rows are dead
 * weight that silently become live the moment the role is removed, and
 * an admin with assignments reads as unrestricted regardless of what
 * those rows say. **Admins must hold zero `user_vaults` rows.** The
 * promote endpoint refuses a target that has any (`has_vault_assignments`),
 * and `api-users.ts` refuses to write assignments onto any admin.
 */
export function isHubAdmin(db: Database, userId: string): boolean {
  const row = db
    .query<{ hub_role: string }, [string]>("SELECT hub_role FROM users WHERE id = ?")
    .get(userId);
  return row?.hub_role === "admin";
}

/**
 * Promote a user to hub admin (`hub_role = 'admin'`). Returns `false`
 * when no such row exists (idempotent — the API layer maps that to 404).
 *
 * Deliberately does NOT check the zero-`user_vaults` invariant itself:
 * the caller (`api-users.ts:handlePromoteHubAdmin`) checks it so it can
 * return a specific `has_vault_assignments` refusal naming what to
 * revoke. There is no demote counterpart by design (hub#881) — removing
 * the last admin, or an admin removing a peer, are both hub-lockout
 * shapes that want a deliberate design pass rather than a symmetric
 * button.
 */
export function setHubRoleAdmin(db: Database, userId: string, now?: () => Date): boolean {
  const stamp = (now?.() ?? new Date()).toISOString();
  const res = db
    .prepare("UPDATE users SET hub_role = 'admin', updated_at = ? WHERE id = ?")
    .run(stamp, userId);
  return res.changes > 0;
}

/**
 * Count the hub's administrators. Used by tests and by any future
 * demote/delete rail that needs "would this leave the hub with zero
 * admins". Not consulted by the delete path today — the first admin is
 * unconditionally undeletable, which already guarantees ≥1.
 */
export function countHubAdmins(db: Database): number {
  return (
    db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE hub_role = 'admin'")
      .get() ?? { n: 0 }
  ).n;
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
 *     design (see `isHubAdmin`); `api-users.ts` refuses to call this
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
 * Upsert one `user_vaults` row. Does not touch the user's other vaults —
 * unlike `setUserVaults`, which is replace-all. Grant-by-pubkey uses this
 * so adding access to vault B cannot wipe vault A.
 *
 * ON CONFLICT updates `role` and preserves the original `created_at`.
 * Returns `false` when the user id does not exist.
 *
 * `attribution` (migration v21) records WHO granted, and over which door.
 * A re-grant overwrites it — the row names the most recent grantor, which is
 * the one whose decision the current role reflects. Omitted attribution
 * writes NULLs rather than inventing a grantor.
 */
export function upsertUserVault(
  db: Database,
  userId: string,
  vaultName: string,
  role: string,
  now: () => Date = () => new Date(),
  attribution: VaultGrantAttribution = {},
): boolean {
  const exists = db
    .query<{ id: string }, [string]>("SELECT id FROM users WHERE id = ?")
    .get(userId);
  if (!exists) return false;
  const stamp = now().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO user_vaults
         (user_id, vault_name, role, created_at,
          granted_by_user_id, granted_by_pubkey, granted_via)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, vault_name) DO UPDATE SET
         role = excluded.role,
         granted_by_user_id = excluded.granted_by_user_id,
         granted_by_pubkey = excluded.granted_by_pubkey,
         granted_via = excluded.granted_via`,
    ).run(
      userId,
      vaultName,
      role,
      stamp,
      attribution.grantedByUserId ?? null,
      attribution.grantedByPubkey ?? null,
      attribution.grantedVia ?? null,
    );
    db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(stamp, userId);
  })();
  return true;
}

/**
 * Drop one `user_vaults` row. Leaves the user (and any other vaults) in place.
 * Returns `true` when a row was deleted.
 */
export function removeUserVault(
  db: Database,
  userId: string,
  vaultName: string,
  now: () => Date = () => new Date(),
): boolean {
  const stamp = now().toISOString();
  let removed = false;
  db.transaction(() => {
    const res = db
      .prepare("DELETE FROM user_vaults WHERE user_id = ? AND vault_name = ?")
      .run(userId, vaultName);
    removed = Number(res.changes) > 0;
    if (removed) {
      db.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(stamp, userId);
    }
  })();
  return removed;
}

/**
 * Vault-delete cascade step (B1, 2026-06-09 hub-module-boundary): drop every
 * `user_vaults` assignment row for the deleted vault, across all users.
 * Exact `=` comparison on `vault_name` — no pattern matching. Returns the
 * number of rows deleted.
 */
export function removeVaultAssignments(db: Database, vaultName: string): number {
  const res = db.prepare("DELETE FROM user_vaults WHERE vault_name = ?").run(vaultName);
  return Number(res.changes);
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
 * Four writes inside one transaction:
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
 *   3. Delete every active SESSION for the user (item G). Revoking tokens
 *      alone left a live session cookie valid — an attacker who already had
 *      a session (the very "old password / stolen device" shape this reset
 *      recovers from) kept browsing post-reset until the session aged out.
 *      Killing sessions in the same transaction makes the reset a true cut:
 *      the user (and any attacker) must re-authenticate with the new
 *      password. Sessions carry no audit value (unlike tokens), so we hard-
 *      delete — same shape as `deleteUser`'s `DELETE FROM sessions`.
 *   4. Bump `updated_at` so the SPA's row reflects the rotation.
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
    // Item G — also kill active sessions in the same transaction. A token
    // revoke alone left a live session cookie valid; an admin reset must
    // force re-auth with the new password (the "old password leaked / stolen
    // device" recovery shape). Sessions carry no audit value, so hard-delete
    // (same shape as deleteUser).
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
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
 *   - `sessions.user_id`, `grants.user_id`, and `auth_codes.user_id` are
 *     NOT NULL with a non-cascading (RESTRICT) FK. All three are deleted
 *     before the users row drops — auth_codes are ephemeral OAuth codes
 *     (60s TTL, no audit value), so a hard-delete is correct (hub#559).
 *   - `user_vaults.user_id` has `ON DELETE CASCADE` (migration v10), so
 *     vault assignments are dropped automatically when the parent row
 *     goes. No explicit cleanup needed.
 *   - `attribution_proofs` deliberately has no user FK (migration v18), so a
 *     deleted subject's signed key-possession proof remains available for
 *     historical registry rows whose `subject` and `subject_pubkey` survive.
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
    // 2. Drop sessions + grants + auth_codes. All have NOT-NULL, non-cascading
    //    (RESTRICT) FKs on user_id; leaving rows behind blocks the users delete
    //    below with SQLITE_CONSTRAINT_FOREIGNKEY. auth_codes are short-lived
    //    (60s TTL) OAuth authorization codes with no audit value — hard-delete,
    //    same as sessions. (Omitting this 500'd a real delete of a user who had
    //    completed an OAuth authorize: the code row outlived its TTL but still
    //    pinned the FK. hub#559.)
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM grants WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM auth_codes WHERE user_id = ?").run(userId);
    // 3. Drop the user row itself. The no-FK attribution proof archive remains.
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
export const USERNAME_MIN_LEN = 2;
export const USERNAME_MAX_LEN = 32;

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
 * First-user seed paths (`PARACHUTE_INITIAL_ADMIN_USERNAME`, the wizard's
 * first admin, `parachute auth set-password` with no existing user) may
 * use the reserved word `admin` — it IS the admin. Charset + length still
 * apply via `validateUsername` (this helper only waives the reserved-word
 * reason, and only for the exact lowercase spelling). Other reserved
 * words, and `admin` on any subsequent create, stay rejected.
 */
export function isSeedAdminUsername(name: string, existingUserCount: number): boolean {
  return existingUserCount === 0 && name === "admin";
}

export function describeUsernameReason(reason: "format" | "length" | "reserved"): string {
  switch (reason) {
    case "length":
      return "username must be 2-32 characters long";
    case "format":
      return "username must contain only lowercase letters, digits, hyphens, and underscores ([a-z0-9_-])";
    case "reserved":
      return "username is reserved (admin, root, system, setup, parachute, hub)";
  }
}

/**
 * Existing rows whose username `validateUsername` rejects — including a
 * seeded `admin`. They stay in the DB (grandfathered) but cannot run the
 * pubkey-linkage ceremony until renamed. Callers (serve boot) surface
 * this as an operator warning.
 */
export function listUnlinkableUsernames(
  db: Database,
): Array<{ username: string; reason: "format" | "length" | "reserved" }> {
  const out: Array<{ username: string; reason: "format" | "length" | "reserved" }> = [];
  for (const u of listUsers(db)) {
    const r = validateUsername(u.username);
    if (!r.valid) out.push({ username: u.username, reason: r.reason });
  }
  return out;
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

/**
 * Email validation (migration v15, B2 — public-signup email capture).
 *
 * Deliberately PERMISSIVE: a single `local@domain.tld` shape check, not a
 * full RFC 5322 parser. The goal is "the operator can plausibly reach this
 * person," not RFC compliance — over-strict regexes reject valid real-world
 * addresses (plus-tags, subdomains, long TLDs) and add no security. We require:
 *   * exactly one `@`,
 *   * a non-empty local part with no whitespace,
 *   * a domain with at least one `.` and a 2+ char final label,
 *   * no whitespace anywhere, and an overall length ceiling (254, the SMTP
 *     practical max) so a megabyte string can't be stored.
 *
 * The address is lowercased + trimmed before the check and returned in that
 * canonical form. Same discriminated-union shape as the other validators so
 * the API/redeem edge can surface the reason.
 */
export const EMAIL_MAX_LEN = 254;

// One @, no whitespace, a dotted domain ending in a 2+ char label.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;

export type ValidateEmailResult =
  | { valid: true; email: string }
  | { valid: false; reason: "format" | "length" };

export function validateEmail(raw: string): ValidateEmailResult {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LEN) {
    return { valid: false, reason: "length" };
  }
  if (!EMAIL_REGEX.test(email)) {
    return { valid: false, reason: "format" };
  }
  return { valid: true, email };
}
