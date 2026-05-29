/**
 * Read-only probe of operator auth state, for the post-exposure preflight
 * nudge. We don't want to lock anything or mutate state — this is a one-
 * shot "should we warn the user their vault is wide open on the public
 * internet?" check.
 *
 * Three sources, checked in this order:
 *
 *   1. ~/.parachute/hub.db  →  users table (authoritative since multi-user
 *      Phase 1, hub#252 / PRs 279–281 / 425). Hub-issued OAuth + browser
 *      sign-in both verify against `users.password_hash`. If any user row
 *      exists with a non-empty password_hash, the operator has an account —
 *      "owner password set." The earliest-created user row is the canonical
 *      operator (cf. `getFirstAdminId` in src/users.ts).
 *   2. ~/.parachute/vault/config.yaml  →  owner_password_hash + totp_secret
 *      (pre-multi-user Phase 1 location). Fallback for super-old installs
 *      whose hub.db is absent or empty.
 *   3. ~/.parachute/vault/data/<name>/vault.db (SQLite) → tokens table
 *      count, summed across every vault instance.
 *
 * The hub.db schema doesn't yet carry a TOTP column (2FA lands in a later
 * phase per the multi-user design doc); we always report `hasTotp: false`
 * when the hub.db path is the source of truth. That matches what's
 * actually shipped — pretending otherwise would whisper "you're covered"
 * when no second factor exists.
 *
 * The YAML fallback path uses line-anchored regex parsing that matches
 * vault's own `readGlobalConfig()` semantics (parachute-vault src/config.ts):
 * keys are optional, quoted scalars, and empty-string / missing-key both
 * mean "not configured." We mirror that rather than bringing in a YAML
 * dependency.
 *
 * The vault-token SQLite path is best-effort: if the DB is missing,
 * locked (vault is writing), or the schema has drifted, `tokenCount`
 * comes back as `null` and the caller surfaces "token status unknown"
 * rather than lying with a false zero. The exposure flow has already
 * succeeded by the time this runs — a probe failure must never block
 * the user's happy path.
 *
 * Schema coupling note: we read the `tokens` table in each vault.db by
 * name with a bare COUNT(*). If vault ever renames that table, that's a
 * breaking change on vault's side and this probe is the least of the
 * fallout. Post-launch, a public `/api/auth/status` endpoint on vault
 * (tracked separately) would let us drop this coupling entirely.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../config.ts";

export interface VaultAuthStatus {
  hasOwnerPassword: boolean;
  hasTotp: boolean;
  /**
   * `null` means we couldn't read the SQLite DB — distinct from "0 tokens
   * exist." Post the pvt_* DROP (hub#466) the expose preflight no longer
   * branches on this — `classify()` in expose-auth-preflight.ts gates on
   * `hasOwnerPassword`, since access now flows through the owner password +
   * on-demand hub JWT mint, not standing vault tokens. `tokenCount` is kept
   * as a best-effort diagnostic only (these rows are vestigial); `null`
   * still cleanly distinguishes "unreadable DB" from "0 rows."
   */
  tokenCount: number | null;
  /** Vault instance names discovered under data/. Empty when vault has
   *  never been initialized (or the data dir is absent). */
  vaultNames: string[];
}

export interface AuthStatusOpts {
  /** Override `~/.parachute/vault` for tests. */
  vaultHome?: string;
  /** Override `~/.parachute/hub.db` for tests. */
  hubDbPath?: string;
  /** Read a YAML file; defaults to `readFileSync(path, "utf8")`. Missing
   *  file should return `undefined` (not throw) so callers can distinguish
   *  "no password configured" from "IO error." */
  readText?: (path: string) => string | undefined;
  /** List vault instance names. Defaults to `readdirSync(dataDir)` filtered
   *  to entries that look like vaults (contain `vault.yaml`). */
  listVaultNames?: (dataDir: string) => string[];
  /** Open the given DB path and return `SELECT COUNT(*) FROM tokens`. Any
   *  thrown error (missing, locked, schema drift) is caught by the caller
   *  and mapped to `tokenCount: null`. */
  countTokens?: (dbPath: string) => number;
  /**
   * Probe hub.db for "does at least one user row with a non-empty
   * `password_hash` exist?" — the canonical "owner password is set"
   * signal post-multi-user-Phase-1. Returning:
   *   - `true`  → at least one user has a password_hash; hub.db is
   *               the source of truth, YAML fallback is skipped.
   *   - `false` → hub.db opened cleanly but users is empty (fresh
   *               install pre-wizard); fall back to YAML.
   *   - `undefined` → hub.db missing / unreadable / migration not yet
   *               applied; fall back to YAML (legacy install path).
   * The split between `false` and `undefined` matters: an empty hub.db
   * on a fresh wizard run should NOT be allowed to mask an owner_password_hash
   * that the operator set via vault's pre-multi-user flow. Callers that
   * want true "I can sign in" semantics get the OR of hub.db∪YAML.
   */
  probeHubDbHasUserPassword?: (dbPath: string) => boolean | undefined;
}

interface Resolved {
  vaultHome: string;
  hubDbPath: string;
  readText: (path: string) => string | undefined;
  listVaultNames: (dataDir: string) => string[];
  countTokens: (dbPath: string) => number;
  probeHubDbHasUserPassword: (dbPath: string) => boolean | undefined;
}

function defaultVaultHome(): string {
  // Mirrors vault's own resolution: honors $PARACHUTE_HOME via configDir(),
  // then falls back to ~/.parachute. The `vault/` subdir is hard-coded on
  // vault's side too (src/config.ts `vaultHomePath()`), so we match literally.
  const root = configDir();
  return root.length > 0 ? join(root, "vault") : join(homedir(), ".parachute", "vault");
}

function defaultHubDbPath(): string {
  const root = configDir();
  return root.length > 0 ? join(root, "hub.db") : join(homedir(), ".parachute", "hub.db");
}

function defaultReadText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultListVaultNames(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  try {
    return readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => existsSync(join(dataDir, name, "vault.yaml")));
  } catch {
    return [];
  }
}

function defaultCountTokens(dbPath: string): number {
  // Imported lazily so the module stays loadable in environments that stub
  // `bun:sqlite` (our own tests inject a fake `countTokens` and never hit
  // this path). `readonly: true` keeps us out of any write lock contention
  // with a live vault process.
  const { Database } = require("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM tokens").get() as { n: number } | null;
    return row?.n ?? 0;
  } finally {
    db.close();
  }
}

/**
 * Open hub.db readonly and ask "does at least one user have a non-empty
 * password_hash?" Returns `undefined` on any failure (DB missing, locked,
 * schema drift, users table absent because migration v2 hasn't applied) —
 * indistinguishable from "no hub.db at all," which is what the caller
 * wants for the YAML-fallback branch.
 *
 * We deliberately do NOT open hub.db read-write here — `openHubDb()`
 * would run migrations as a side effect, and this is a read probe from
 * an unrelated command (`parachute expose`). `readonly: true` skips the
 * WAL handshake and won't contend with the live hub server.
 */
function defaultProbeHubDbHasUserPassword(dbPath: string): boolean | undefined {
  if (!existsSync(dbPath)) return undefined;
  const { Database } = require("bun:sqlite");
  let db: { prepare: (sql: string) => { get: () => unknown }; close: () => void } | undefined;
  try {
    db = new Database(dbPath, { readonly: true }) as typeof db;
    // COUNT(*) over users with non-empty password_hash. `length(...) > 0`
    // matches the "missing/empty hash" treatment from the YAML side.
    //
    // Why "any user with a hash" not "first admin specifically": friend
    // accounts can only be created by an already-authenticated admin
    // (per api-users.ts's host:admin gate), so any user-with-hash
    // implies the first admin has one too. Equivalent in practice and
    // simpler than a JOIN on earliest-created-at. A future env-seed
    // flow that creates friend accounts before the operator sets a
    // password would need to revisit this assumption.
    const row = db
      ?.prepare(
        "SELECT COUNT(*) AS n FROM users WHERE password_hash IS NOT NULL AND length(password_hash) > 0",
      )
      .get() as { n: number } | null;
    return (row?.n ?? 0) > 0;
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function resolve(opts: AuthStatusOpts): Resolved {
  return {
    vaultHome: opts.vaultHome ?? defaultVaultHome(),
    hubDbPath: opts.hubDbPath ?? defaultHubDbPath(),
    readText: opts.readText ?? defaultReadText,
    listVaultNames: opts.listVaultNames ?? defaultListVaultNames,
    countTokens: opts.countTokens ?? defaultCountTokens,
    probeHubDbHasUserPassword: opts.probeHubDbHasUserPassword ?? defaultProbeHubDbHasUserPassword,
  };
}

/**
 * Mirrors vault's `readGlobalConfig()` regex on a single key, returning the
 * captured quoted string when present and non-empty, otherwise `undefined`.
 */
function matchQuotedKey(yaml: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*"([^"]*)"`, "m");
  const m = yaml.match(re);
  if (!m) return undefined;
  const captured = m[1];
  if (captured === undefined || captured.length === 0) return undefined;
  return captured;
}

interface AuthSignals {
  hasOwnerPassword: boolean;
  hasTotp: boolean;
}

function readYamlAuth(r: Resolved): AuthSignals {
  const yaml = r.readText(join(r.vaultHome, "config.yaml"));
  if (yaml === undefined) return { hasOwnerPassword: false, hasTotp: false };
  return {
    hasOwnerPassword: matchQuotedKey(yaml, "owner_password_hash") !== undefined,
    hasTotp: matchQuotedKey(yaml, "totp_secret") !== undefined,
  };
}

/**
 * Combine the hub.db probe + the legacy YAML probe into a single auth-signals
 * read. Logic:
 *
 *   - hub.db says yes → operator has an account in the canonical store;
 *     report `hasOwnerPassword: true`. TOTP is reported per the YAML probe
 *     (so a legacy operator who set both YAML password + YAML totp_secret,
 *     then migrated to a hub.db user, still surfaces "TOTP is on" — we
 *     don't have a hub-side TOTP column yet, hub#252 Phase 3 lands it).
 *   - hub.db says no AND was reachable → users table is empty, no hub
 *     account exists yet. Fall back to YAML for both signals — a pre-
 *     multi-user install would have its password in YAML.
 *   - hub.db unreachable → can't tell, fall back to YAML entirely.
 *
 * Net effect: `hasOwnerPassword` is the OR of (hub.db has a user with a
 * password) ∪ (YAML has owner_password_hash). Either source counts.
 */
function readAuthSignals(r: Resolved): AuthSignals {
  const yaml = readYamlAuth(r);
  const hubDbHasUser = r.probeHubDbHasUserPassword(r.hubDbPath);
  const hasOwnerPassword = hubDbHasUser === true ? true : yaml.hasOwnerPassword;
  return {
    hasOwnerPassword,
    // No hub-side TOTP column shipped yet (multi-user Phase 3). Until it
    // lands, TOTP is YAML-only — matches what's actually true on disk.
    hasTotp: yaml.hasTotp,
  };
}

/**
 * Sum token counts across every vault instance found under data/. If any
 * probe throws (missing DB, locked, schema drift), the whole result
 * degrades to `null` — partial counts would mislead the caller more than
 * "unknown" does.
 */
function readTotalTokenCount(r: Resolved, vaultNames: string[]): number | null {
  if (vaultNames.length === 0) return 0;
  const dataDir = join(r.vaultHome, "data");
  let total = 0;
  for (const name of vaultNames) {
    const dbPath = join(dataDir, name, "vault.db");
    if (!existsSync(dbPath)) {
      // Vault initialized the yaml but hasn't created the DB yet (fresh
      // install). Count as zero for this vault; keep going.
      continue;
    }
    try {
      total += r.countTokens(dbPath);
    } catch {
      return null;
    }
  }
  return total;
}

export function readVaultAuthStatus(opts: AuthStatusOpts = {}): VaultAuthStatus {
  const r = resolve(opts);
  const { hasOwnerPassword, hasTotp } = readAuthSignals(r);
  const dataDir = join(r.vaultHome, "data");
  const vaultNames = r.listVaultNames(dataDir);
  const tokenCount = readTotalTokenCount(r, vaultNames);
  return { hasOwnerPassword, hasTotp, tokenCount, vaultNames };
}
