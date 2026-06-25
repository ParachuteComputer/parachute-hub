/**
 * Hub-local SQLite database. Opens `~/.parachute/hub.db` (overridable via
 * `$PARACHUTE_HOME`). Holds everything the hub owns as the ecosystem's OAuth
 * issuer — signing keys (v1), users + opaque refresh tokens (v2), OAuth
 * clients + auth-codes + grants + browser sessions (v3), TOTP 2FA
 * enrollment on the users row (v11, hub#473), and one-time invite links
 * (v12, the `invites` table; v13 adds the pre-named `username` column;
 * v14 adds refresh-token rotation grace; v15 generalizes invites into
 * multi-use public-signup links + email-as-username + the `vault_caps`
 * per-vault storage-cap table).
 *
 * Each open() runs `migrate()` to bring the schema up to date. A
 * `schema_version` table records every applied migration so re-opens are
 * cheap and idempotent. Migrations are append-only — never edit a prior
 * entry; add a new one with a higher number.
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

export function hubDbPath(configDir: string = CONFIG_DIR): string {
  return join(configDir, "hub.db");
}

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE signing_keys (
        kid TEXT PRIMARY KEY,
        public_key_pem TEXT NOT NULL,
        private_key_pem TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT
      );
      CREATE INDEX signing_keys_active ON signing_keys (retired_at)
        WHERE retired_at IS NULL;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tokens (
        jti TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        refresh_token_hash TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX tokens_user ON tokens (user_id);
      CREATE INDEX tokens_active_refresh ON tokens (refresh_token_hash)
        WHERE refresh_token_hash IS NOT NULL AND revoked_at IS NULL;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE clients (
        client_id TEXT PRIMARY KEY,
        client_secret_hash TEXT,
        redirect_uris TEXT NOT NULL,
        scopes TEXT NOT NULL,
        client_name TEXT,
        registered_at TEXT NOT NULL
      );
      CREATE TABLE auth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(client_id),
        user_id TEXT NOT NULL REFERENCES users(id),
        redirect_uri TEXT NOT NULL,
        scopes TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE grants (
        user_id TEXT NOT NULL REFERENCES users(id),
        client_id TEXT NOT NULL REFERENCES clients(client_id),
        scopes TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        PRIMARY KEY (user_id, client_id)
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX sessions_user ON sessions (user_id);
    `,
  },
  {
    version: 4,
    sql: `
      -- DCR approval gate (closes #74). Public DCR was unauthenticated before
      -- this migration; pre-existing rows are grandfathered as 'approved' so
      -- already-trusted clients keep working. New rows default to 'pending'
      -- unless the registrant authenticates with an operator token carrying
      -- hub:admin scope.
      ALTER TABLE clients ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
      UPDATE clients SET status = 'approved';
      CREATE INDEX clients_status ON clients (status);
    `,
  },
  {
    version: 5,
    sql: `
      -- Refresh-token rotation + replay detection (closes #73). Each chain
      -- of rotated refresh tokens shares a family_id; replaying a revoked
      -- refresh token in a family signals theft and revokes every row in
      -- that family (RFC 6819 §5.2.2.3). Pre-existing rows are backfilled
      -- with their own jti as the family — grandfathered as singletons so
      -- in-flight tokens keep working without spurious family revocation.
      ALTER TABLE tokens ADD COLUMN family_id TEXT;
      UPDATE tokens SET family_id = jti WHERE family_id IS NULL;
      CREATE INDEX tokens_family ON tokens (family_id) WHERE family_id IS NOT NULL;
    `,
  },
  {
    version: 6,
    sql: `
      -- Token registry generalization (closes hub#212 Phase 1). Until v6 the
      -- tokens table only held OAuth refresh tokens; v6 generalizes it to a
      -- single registry across every issued JWT class (refresh, access,
      -- operator, mint-token). Three structural changes:
      --
      --   1. user_id becomes NULLABLE. OAuth-issued rows still set it to the
      --      caller's user (canonical identity field). CLI-minted /
      --      operator-minted rows leave user_id NULL and put the operator/
      --      service name in the new \`subject\` column.
      --   2. Three new columns: \`permissions\` (JSON, custom claim per
      --      auth-architecture-shape.md §11.3), \`created_via\` (provenance
      --      tag: oauth_refresh / cli_mint / operator_mint), \`subject\`
      --      (non-user identity for service / operator mints).
      --   3. Existing rows backfill \`created_via='oauth_refresh'\` because
      --      the table was OAuth-refresh-only before v6.
      --
      -- SQLite has no ALTER COLUMN to drop NOT NULL, so we use the
      -- recreate-and-rename pattern. Inside the migration transaction the
      -- whole swap is atomic; concurrent reads (there are none — hub is
      -- single-writer) wouldn't see a half-state. FKs from tokens → users
      -- stay enforced for non-NULL user_id values; nothing references
      -- tokens, so the drop is safe.
      CREATE TABLE tokens_new (
        jti TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL,
        refresh_token_hash TEXT,
        family_id TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        permissions TEXT,
        created_via TEXT NOT NULL DEFAULT 'oauth_refresh',
        subject TEXT
      );
      INSERT INTO tokens_new (
        jti, user_id, client_id, scopes, refresh_token_hash, family_id,
        expires_at, revoked_at, created_at,
        permissions, created_via, subject
      )
      SELECT
        jti, user_id, client_id, scopes, refresh_token_hash, family_id,
        expires_at, revoked_at, created_at,
        NULL, 'oauth_refresh', NULL
      FROM tokens;
      DROP TABLE tokens;
      ALTER TABLE tokens_new RENAME TO tokens;
      -- Recreate indexes (DROP TABLE took them with it).
      CREATE INDEX tokens_user ON tokens (user_id) WHERE user_id IS NOT NULL;
      CREATE INDEX tokens_active_refresh ON tokens (refresh_token_hash)
        WHERE refresh_token_hash IS NOT NULL AND revoked_at IS NULL;
      CREATE INDEX tokens_family ON tokens (family_id) WHERE family_id IS NOT NULL;
      -- New: revocation list endpoint queries on (revoked_at, expires_at).
      CREATE INDEX tokens_revoked ON tokens (revoked_at)
        WHERE revoked_at IS NOT NULL;
      -- Subject lookup for non-user mints (operator name, service name).
      CREATE INDEX tokens_subject ON tokens (subject) WHERE subject IS NOT NULL;
    `,
  },
  {
    version: 7,
    sql: `
      -- Hub-level key/value settings (hub#268). Used by:
      --   * setup_expose_mode — operator's "how will this hub be reached?"
      --     choice from the first-boot wizard expose step. Values:
      --     'localhost' | 'tailnet' | 'public'.
      --   * pending_first_client_auto_approve_until — ISO-8601 timestamp
      --     set when the wizard finishes; first OAuth client registration
      --     within the window is auto-approved + the row cleared (single
      --     use). Absent / past-due means the standard pending-approval
      --     flow applies.
      --
      -- Single-row-per-key schema. updated_at lets us age out stale
      -- entries if a future pattern needs it; nothing currently relies on
      -- it. Bare KV — no audit log, no history — these are hub-local
      -- operator preferences, not user-facing data.
      CREATE TABLE hub_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    sql: `
      -- Multi-user Phase 1 (hub#252, design 2026-05-20-multi-user-phase-1.md).
      -- Two columns on \`users\`:
      --
      --   * password_changed (INTEGER 0/1) — tracks whether a user has
      --     changed their password since account creation. The admin-creates-
      --     user flow (PR 2) lands new accounts with 0; the user's forced
      --     change-password flow (PR 3) flips it to 1. SQLite has no native
      --     BOOL, so 0/1 + a TS helper in users.ts handles the translation.
      --   * assigned_vault (TEXT, nullable) — the vault instance name the
      --     user is pinned to (Phase 1 is single-vault-per-user). NULL means
      --     "no per-vault restriction" — the wizard's first admin and any
      --     other admin-role user. The OAuth issuer (PR 4) reads this at
      --     mint time to narrow the token's vault scope. No FK: vault names
      --     resolve through services.json, not a DB row.
      --
      -- Backfill: every existing user pre-dates this migration. The only
      -- accounts that could exist are the wizard's first admin (chose their
      -- own password via the wizard form) or env-seeded admins (operator
      -- baked the password into PARACHUTE_INITIAL_ADMIN_PASSWORD). Both
      -- already-chosen-by-the-account-holder paths, so flip every existing
      -- row to password_changed=1 — no spurious force-change on first sign-
      -- in for already-bootstrapped hubs.
      ALTER TABLE users ADD COLUMN password_changed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN assigned_vault TEXT;
      UPDATE users SET password_changed = 1;
    `,
  },
  {
    version: 9,
    sql: `
      -- Same-hub DCR auto-trust (hub#312, design-doc parachute-app §6).
      -- One column on \`clients\`:
      --
      --   * same_hub (INTEGER 0/1) — true when the DCR caller authenticated
      --     as the operator (bearer hub:admin OR session-cookie+same-origin),
      --     so the resulting client is "owned by this hub". The /oauth/
      --     authorize consent gate skips the consent screen for same_hub
      --     clients requesting only non-admin scopes — the operator who
      --     registered the client IS the implicit consent, and a repeated
      --     click per UI install is friction without security value.
      --
      -- External DCR (no auth, or post-#268 wizard-window approve) lands
      -- same_hub=0 and requires explicit consent regardless of scope. The
      -- first-client wizard-window (hub#268) auto-APPROVES but is NOT same-
      -- hub: the operator deliberately ran the wizard, but the registrant
      -- (a third-party app from a friend's hub, browser, install script)
      -- is external. Approval ≠ ownership.
      --
      -- Backfill: every existing row pre-dates this migration. The safe
      -- default is same_hub=0 — pre-existing clients keep showing consent.
      -- Operators who want to upgrade an existing client to same-hub trust
      -- can do so via a future admin action (out of scope for this PR; the
      -- SPA's existing approve-client view doesn't currently surface
      -- same_hub).
      ALTER TABLE clients ADD COLUMN same_hub INTEGER NOT NULL DEFAULT 0;
      UPDATE clients SET same_hub = 0;
    `,
  },
  {
    version: 10,
    sql: `
      -- Multi-user Phase 2 PR 2 (hub#252 follow-up, design
      -- 2026-05-20-multi-user-phase-1.md §Phase 2). Lifts the single
      -- \`users.assigned_vault TEXT\` column into a many-to-many
      -- \`user_vaults\` table so one user can have access to multiple
      -- vaults (e.g. a personal vault + a family-shared vault).
      --
      -- Schema:
      --   * (user_id, vault_name) composite PK — one row per (user, vault).
      --     ON DELETE CASCADE on user_id so user deletion drops the
      --     assignments without us having to clean up manually.
      --   * \`role\` TEXT DEFAULT 'write' — reserved for forward-compat per-
      --     vault role granularity. Phase 1 had no role model; this column
      --     gives later PRs a column to land scope-narrowing in without a
      --     second migration. All backfilled rows default to 'write'.
      --   * index on \`vault_name\` for the inverse lookup ("who has access
      --     to vault X?") — useful when admin removes a vault and we want
      --     to warn about pinned users.
      --
      -- Backfill: every existing row in \`users\` with a non-null
      -- \`assigned_vault\` becomes a single (user_id, vault_name) row in
      -- \`user_vaults\`. Rows with NULL \`assigned_vault\` (admin posture)
      -- get no \`user_vaults\` entry — they remain "no narrowing" per
      -- vaultScopeForUser semantics. After backfill the \`assigned_vault\`
      -- column is dropped.
      CREATE TABLE user_vaults (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vault_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'write',
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, vault_name)
      );
      CREATE INDEX user_vaults_vault ON user_vaults (vault_name);
      INSERT INTO user_vaults (user_id, vault_name, role, created_at)
      SELECT id, assigned_vault, 'write', created_at
      FROM users
      WHERE assigned_vault IS NOT NULL;
      ALTER TABLE users DROP COLUMN assigned_vault;
    `,
  },
  {
    version: 11,
    sql: `
      -- Real TOTP 2FA at the hub login layer (hub#473). Three nullable
      -- columns on \`users\`:
      --
      --   * totp_secret (TEXT, nullable) — the base32-encoded RFC 6238 TOTP
      --     secret. NULL means "2FA not enrolled" — the canonical "is 2FA on
      --     for this user?" signal. Stored as the plaintext base32 string
      --     (not encrypted at rest): hub.db already holds the argon2id
      --     password hashes AND the OAuth signing private keys in plaintext
      --     PEM (signing_keys.private_key_pem), so the TOTP secret sits at
      --     the same operator-local trust boundary — encrypting one column
      --     while leaving the signing key in the clear would be security
      --     theatre. A future at-rest-encryption pass (hub#474 follow-up)
      --     would cover all three (password hashes are already one-way; the
      --     signing key + TOTP secret are the recoverable secrets).
      --   * totp_backup_codes (TEXT, nullable) — JSON array of argon2id-HASHED
      --     single-use recovery codes. Same hash family as passwords
      --     (@node-rs/argon2). Plaintext codes are shown to the user exactly
      --     once at enrollment and never stored. A code is removed from the
      --     array when consumed. NULL / "[]" means "no backup codes left."
      --   * totp_enrolled_at (TEXT, nullable) — ISO-8601 timestamp of the
      --     last successful enrollment. NULL until first enroll; informational
      --     (admin UI / account page "2FA enabled since …").
      --
      -- Backfill: every existing user pre-dates this migration and gets NULL
      -- for all three — i.e. "2FA not enrolled." Their /login flow stays
      -- password-only (the login handler only requires a TOTP step when
      -- totp_secret IS NOT NULL), so existing operators keep signing in
      -- exactly as before. No backfill UPDATE needed — the column default is
      -- NULL.
      ALTER TABLE users ADD COLUMN totp_secret TEXT;
      ALTER TABLE users ADD COLUMN totp_backup_codes TEXT;
      ALTER TABLE users ADD COLUMN totp_enrolled_at TEXT;
    `,
  },
  {
    version: 12,
    sql: `
      -- One-time, expiring invite links (design
      -- 2026-06-04-individual-users-and-vault-operations.md §7). An admin
      -- generates a link; the recipient opens it, picks a username +
      -- password, and gets their OWN freshly-provisioned vault as owner.
      --
      -- The row stores sha256(token), NOT the raw token. Invites are
      -- longer-lived than the 60s OAuth auth-codes (default 7-day expiry),
      -- so a DB read must not be enough to replay the link — the raw token
      -- is emitted exactly once at creation and never persisted, exactly
      -- like the bootstrap token. Lookup hashes the URL token and selects
      -- by the hash; the hash is the primary key.
      --
      -- Columns:
      --   * token (TEXT PK)        — sha256(raw token), hex. Never the raw value.
      --   * created_by (TEXT)      — admin user id that issued the invite
      --                              (FK users.id; ON DELETE SET NULL so
      --                              deleting the issuer doesn't orphan-block
      --                              the audit row).
      --   * vault_name (TEXT)      — nullable. When set, the invite pins the
      --                              vault name (redeemer can't squat names).
      --                              When NULL + provision_vault=1 the redeemer
      --                              names their own vault at redeem time.
      --   * role (TEXT DEFAULT 'write') — the user_vaults role the redeemed
      --                              user gets on their vault. 'write' = owner
      --                              (full vault admin per vaultVerbsForRole).
      --                              Carried so the shared-into-existing-vault
      --                              case is a later policy change, not a
      --                              migration.
      --   * provision_vault (INTEGER) — 1 = provision a NEW vault for the
      --                              redeemer (the primary flow); 0 = account
      --                              only / assign an existing vault.
      --   * default_mirror (TEXT)  — nullable; wires the §3 default-mirror knob
      --                              ('internal' | 'off') through to the
      --                              provisioned vault. NULL = vault's own
      --                              default.
      --   * expires_at (TEXT)      — ISO-8601; redeem rejects past this.
      --   * used_at (TEXT)         — ISO-8601 stamp set at redeem. Single-use:
      --                              a second redeem sees this set and is
      --                              rejected. Stamped only AFTER the user row
      --                              commits, so a createUser failure leaves
      --                              the invite re-usable.
      --   * redeemed_user_id (TEXT) — the user id the invite created (FK
      --                              users.id; ON DELETE SET NULL).
      --   * revoked_at (TEXT)      — ISO-8601 stamp when the admin revokes the
      --                              invite before redemption.
      --   * created_at (TEXT)      — ISO-8601.
      --
      -- No backfill — no invites pre-date this migration.
      CREATE TABLE invites (
        token TEXT PRIMARY KEY,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        vault_name TEXT,
        role TEXT NOT NULL DEFAULT 'write',
        provision_vault INTEGER NOT NULL DEFAULT 1,
        default_mirror TEXT,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        redeemed_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX invites_created_at ON invites (created_at);
    `,
  },
  {
    version: 13,
    sql: `
      -- Pre-named invites (Adam/Jonathan scenario). Adds an optional
      -- \`username\` column to \`invites\`: when set, the invite pre-names
      -- the account the redeemer gets — the redemption form shows the name
      -- read-only and the redeem handler ENFORCES it (the form's username
      -- field is ignored). NULL = the redeemer picks their own username
      -- (every pre-v13 invite, and the default for new ones).
      --
      -- Enforced (not just pre-filled) because a pre-named invite is a
      -- *named deliverable*: the admin mints "Jonathan's link" and hands it
      -- to Jonathan; if the redeemer could pick a different name, the
      -- link's identity binding would be decorative — the admin's audit
      -- expectation ("this link = jonathan") and any vault assignment
      -- story told against that name would silently break.
      --
      -- Stored as plain TEXT (already-validated lowercase [a-z0-9_-], the
      -- users.username vocabulary). Mint-time validation rejects names
      -- taken by an existing user or reserved by another pending invite;
      -- the redeem path re-checks authoritatively. No backfill — every
      -- existing invite predates pre-naming and keeps NULL.
      ALTER TABLE invites ADD COLUMN username TEXT;
    `,
  },
  {
    version: 14,
    sql: `
      -- Refresh-token rotation grace window (hub#685). Records the successor
      -- a refresh-token row rotated INTO, so the refresh handler can tell the
      -- *immediately-previous* token (the single benign concurrent/retried
      -- refresh a multi-tab / bfcache / network-retry client legitimately
      -- presents) apart from a genuine replay of an older ancestor (theft).
      --
      -- \`rotated_to\` is the jti of the row minted when this row rotated. NULL
      -- on every row that has not (yet) rotated: live tokens, revoked-by-
      -- /oauth/revoke tokens, revoked-by-family-sweep tokens, and every
      -- pre-v14 row (no backfill — pre-v14 rotations left no successor link,
      -- so they fall through to the zero-tolerance theft path exactly as
      -- before; the grace window only ever helps rows minted post-v14).
      --
      -- The successor link is the ONLY structural ordering signal we need:
      -- created_at alone can't distinguish the direct predecessor from an
      -- older ancestor under burst issuance (ties), and the grace decision is
      -- security-load-bearing, so it must be exact, not heuristic.
      ALTER TABLE tokens ADD COLUMN rotated_to TEXT;
    `,
  },
  {
    version: 15,
    sql: `
      -- Multi-use public signup links + email-as-username + per-vault caps
      -- (DEMO-PREP-2026-06-25 Workstream B: B1 multi-use invite, B2 email
      -- capture, B4 public signup page; the cap value is persisted now so
      -- B3's vault-side enforcement — a separate Phase-2 PR — can read it).
      --
      -- (1) FOUR columns on \`invites\` generalize the single-use link into a
      --     multi-use, capped one. Backwards compatible: every pre-v15 invite
      --     redeems exactly as before because the defaults reproduce the old
      --     single-use semantics.
      --
      --   * max_uses (INTEGER NOT NULL DEFAULT 1) — how many accounts ONE link
      --     may create. DEFAULT 1 = the historical single-use invite, so every
      --     pre-v15 row and every default-shaped new row stays single-use. A
      --     public signup link mints with a higher value (e.g. 25 demo seats).
      --   * used_count (INTEGER NOT NULL DEFAULT 0) — how many accounts the link
      --     HAS created. Redeem refuses once used_count >= max_uses. Replaces
      --     the boolean used_at as the exhaustion signal for multi-use links;
      --     used_at is RETAINED (stamped on the FIRST redeem) so legacy
      --     single-use lookups + the admin list's "redeemed" status keep
      --     working unchanged.
      --   * email (TEXT, nullable) — the redeemer's email captured at signup
      --     as the contactable identity (B2). NULL on every pre-v15 invite and
      --     on admin-issued links that don't collect email; set per-redemption
      --     for public-signup links. Stored so the operator can reach signups.
      --     (One link → many signups means one invite row can't hold every
      --     redeemer's email; this column holds the MOST-RECENT redeemer's
      --     email for a single-use link, and the per-account email lives on the
      --     users row — see (3). For multi-use the canonical per-user email is
      --     users.email.)
      --   * vault_cap_bytes (INTEGER, nullable) — the per-vault storage cap to
      --     STAMP onto each vault this link provisions (B4). NULL on every
      --     pre-v15 invite + admin-issued links that don't set a cap (those
      --     provision uncapped, the historical behavior); set to ~1 GB on a
      --     public-signup link so each provisioned vault gets a vault_caps row
      --     for the Phase-2 enforcement PR to read. The cap travels on the
      --     invite (not a server-wide default) so different links can carry
      --     different caps.
      --
      -- (2) ONE column on \`users\`: email-as-contactable-identity (B2). The
      --     username stays the login + URL identity ([a-z0-9_-]); email is the
      --     separate contact field the operator sees + uses to reach a signup.
      --     Nullable: every pre-v15 account (wizard admin, env-seeded admin,
      --     pre-named friend invites) predates email capture and keeps NULL.
      --     NOT UNIQUE — two people behind one shared mailbox, or an operator
      --     re-using their address across test accounts, shouldn't be blocked
      --     at the schema. Validation (format) happens at the API/redeem edge.
      --
      -- (3) NEW \`vault_caps\` table — the per-vault storage cap, persisted at
      --     provision time (B4: "persist a per-vault cap value at provision
      --     time EVEN THOUGH vault-side enforcement lands in a separate
      --     Phase-2 PR — at minimum store the cap so the later PR can read +
      --     enforce it"). Keyed by vault_name (the same instance-name space
      --     used across services.json / user_vaults / invites.vault_name; no
      --     FK — vault names resolve through services.json, not a DB row, the
      --     established pattern). cap_bytes is the byte ceiling (default
      --     ~1 GB stamped by the public-signup flow). No backfill — existing
      --     vaults have no cap row, which the Phase-2 enforcement reads as
      --     "uncapped" (only vaults provisioned through a capped signup get a
      --     row).
      ALTER TABLE invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE invites ADD COLUMN used_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE invites ADD COLUMN email TEXT;
      ALTER TABLE invites ADD COLUMN vault_cap_bytes INTEGER;
      ALTER TABLE users ADD COLUMN email TEXT;
      CREATE TABLE vault_caps (
        vault_name TEXT PRIMARY KEY,
        cap_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export function openHubDb(path: string = hubDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set<number>(
    (db.query("SELECT version FROM schema_version").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const insert = db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)");
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, new Date().toISOString());
    })();
  }
}
