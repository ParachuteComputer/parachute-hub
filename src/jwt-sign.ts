/**
 * JWT issuance + verification for hub-issued access tokens, plus opaque
 * refresh-token minting that records hashes in the `tokens` table.
 *
 * Three pieces, deliberately separable:
 *   - `signAccessToken(db, opts)` — pure JWT signing. Looks up the active
 *     signing key from `signing_keys`, signs an RS256 JWT, returns the
 *     compact serialization plus jti + computed expiry. Does NOT write to
 *     `tokens` — the caller chooses whether to persist (PR (c) will).
 *   - `signRefreshToken(db, opts)` — generates an opaque hex token,
 *     SHA-256-hashes it, and inserts a `tokens` row. Returns the plaintext
 *     to hand to the client; the hash is what we'll compare on refresh.
 *   - `validateAccessToken(db, token)` — verifies the JWT signature against
 *     active + recently-retired keys (whatever's currently in JWKS), checks
 *     expiry. Read-only.
 *
 * Sliding refresh: PR (c) will rotate the row on a successful refresh; this
 * PR just sets up the storage shape. 30-day expiry is the *initial* TTL.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type JWTPayload,
  SignJWT,
  decodeProtectedHeader,
  importPKCS8,
  importSPKI,
  jwtVerify,
} from "jose";
import { getActiveSigningKey, getAllPublicKeys } from "./signing-keys.ts";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SIGNING_ALGORITHM = "RS256";

export interface SignAccessTokenOpts {
  /** Subject — the user id. */
  sub: string;
  scopes: string[];
  /** Module short name (vault, notes, …) or "hub" — sets `aud`. */
  audience: string;
  clientId: string;
  /**
   * Hub origin — sets the `iss` claim. Required: every consumer (vault,
   * scribe, channel) validates `iss` against `PARACHUTE_HUB_ORIGIN`, and a
   * missing claim is rejected. Callers derive this via `deriveHubOrigin()`
   * or thread it from `OAuthDeps.issuer`.
   */
  issuer: string;
  /** Override the jti (defaults to random base64url(16)). Used by tests. */
  jti?: string;
  /**
   * Override the default 15-minute access-token TTL. Long-lived tokens
   * (operator-token, ~90d) pass an explicit value here.
   */
  ttlSeconds?: number;
  now?: () => Date;
  /**
   * Extra JWT claims merged into the payload. Used by operator-token to embed
   * `pa_scope_set` (which scope-set the token was minted under) so an
   * auto-rotation can preserve the operator's chosen narrowing across mints.
   * Reserved claims (`scope`, `client_id`, `sub`, `iss`, `iat`, `exp`, `aud`,
   * `jti`) are owned by this function and overwritten if passed here.
   */
  extraClaims?: Record<string, unknown>;
}

export interface SignedAccessToken {
  token: string;
  jti: string;
  expiresAt: string;
}

export async function signAccessToken(
  db: Database,
  opts: SignAccessTokenOpts,
): Promise<SignedAccessToken> {
  const key = getActiveSigningKey(db);
  const priv = await importPKCS8(key.privateKeyPem, SIGNING_ALGORITHM);
  const jti = opts.jti ?? randomBytes(16).toString("base64url");
  const nowMs = (opts.now?.() ?? new Date()).getTime();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + (opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS);
  const token = await new SignJWT({
    ...(opts.extraClaims ?? {}),
    scope: opts.scopes.join(" "),
    client_id: opts.clientId,
  })
    .setProtectedHeader({ alg: SIGNING_ALGORITHM, kid: key.kid })
    .setSubject(opts.sub)
    .setIssuer(opts.issuer)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setAudience(opts.audience)
    .setJti(jti)
    .sign(priv);
  return { token, jti, expiresAt: new Date(exp * 1000).toISOString() };
}

export interface SignRefreshTokenOpts {
  /** Shared with the access token's jti — keys the `tokens` row. */
  jti: string;
  userId: string;
  clientId: string;
  scopes: string[];
  /**
   * Shared identifier across a chain of rotated refresh tokens. Initial
   * issuance (auth-code grant) omits this — a fresh family is minted.
   * Rotation (refresh_token grant) passes the prior row's family_id so
   * replay detection can revoke every descendant in one query (#73).
   */
  familyId?: string;
  now?: () => Date;
}

/**
 * Provenance of a `tokens` row — which mint path wrote it. Drives the
 * unified token registry semantics introduced in v6 (hub#212 Phase 1):
 * one table for refresh tokens, one for CLI-minted access tokens, one
 * for operator tokens. Different mint paths = different rows; revocation
 * lookup + revocation list are uniform across all of them.
 */
export type TokenCreatedVia = "oauth_refresh" | "cli_mint" | "operator_mint";

export interface SignedRefreshToken {
  /** Opaque token to return to the client. NOT recoverable from the DB. */
  token: string;
  /** SHA-256 hex digest of `token`, stored in `tokens.refresh_token_hash`. */
  refreshTokenHash: string;
  /** Family identifier (new UUID for initial issuance, inherited on rotation). */
  familyId: string;
  expiresAt: string;
}

/**
 * Thrown when the `tokens` row INSERT fails — most plausibly a UNIQUE jti
 * collision caused by a concurrent rotation racing on the same prior refresh
 * token. Callers in the OAuth grant path catch this and surface a clean
 * `invalid_grant` 400 instead of letting the SQLite error bubble as a 500
 * (#108).
 */
export class RefreshTokenInsertError extends Error {
  override name = "RefreshTokenInsertError";
  override cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

export function signRefreshToken(db: Database, opts: SignRefreshTokenOpts): SignedRefreshToken {
  const token = randomBytes(32).toString("base64url");
  const refreshTokenHash = createHash("sha256").update(token).digest("hex");
  const now = opts.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString();
  const familyId = opts.familyId ?? randomUUID();
  try {
    db.prepare(
      `INSERT INTO tokens (jti, user_id, client_id, scopes, refresh_token_hash, family_id, expires_at, created_at, created_via)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'oauth_refresh')`,
    ).run(
      opts.jti,
      opts.userId,
      opts.clientId,
      opts.scopes.join(" "),
      refreshTokenHash,
      familyId,
      expiresAt,
      now.toISOString(),
    );
  } catch (err) {
    throw new RefreshTokenInsertError(
      `failed to insert refresh token row: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  return { token, refreshTokenHash, familyId, expiresAt };
}

export interface RecordTokenMintOpts {
  /** Same as the issued JWT's jti — keys the row. */
  jti: string;
  /** Provenance tag — drives admin UI grouping and the registry semantics. */
  createdVia: Exclude<TokenCreatedVia, "oauth_refresh">;
  /** Subject identity for non-user mints. Operator-mint rows pass "operator"; service-mint rows pass the service short name. */
  subject: string;
  /** Optional user_id when the mint was performed against a hub user (the mint-token CLI flow defaults to the operator's user). NULL for purely service-tied mints. */
  userId?: string;
  clientId: string;
  scopes: string[];
  /** ISO-8601 expiry. Same value as the JWT's `exp`. */
  expiresAt: string;
  /** Optional JSON-encoded permissions claim (per auth-architecture-shape.md §11.3). */
  permissions?: string;
  now?: () => Date;
}

/**
 * Write a `tokens` row for a non-OAuth-refresh mint. The OAuth refresh
 * path goes through `signRefreshToken` (which already inserts); this path
 * is for CLI mint-token, the new POST /api/auth/mint-token endpoint, and
 * operator-token mints (rotate-operator + the auto-rotation helper from
 * #213).
 *
 * Every issued JWT must have a row in this table going forward — that's
 * the contract the revocation list endpoint depends on. Pre-Phase-1
 * tokens (already issued before this migration) are unregistered but
 * harmless: they expire on their own (15-min access tokens drained
 * within the hour; 365d operator tokens cap at their original expiry,
 * with the new 90d auto-rotation taking over once an operator runs the
 * CLI again).
 */
export function recordTokenMint(db: Database, opts: RecordTokenMintOpts): void {
  const now = opts.now?.() ?? new Date();
  try {
    db.prepare(
      `INSERT INTO tokens (
        jti, user_id, client_id, scopes, expires_at, created_at,
        permissions, created_via, subject
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.jti,
      opts.userId ?? null,
      opts.clientId,
      opts.scopes.join(" "),
      opts.expiresAt,
      now.toISOString(),
      opts.permissions ?? null,
      opts.createdVia,
      opts.subject,
    );
  } catch (err) {
    throw new RefreshTokenInsertError(
      `failed to insert token registry row (jti=${opts.jti}, created_via=${opts.createdVia}): ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

/**
 * Mark a `tokens` row revoked by jti. Idempotent: a row already revoked
 * keeps its existing `revoked_at`. Returns true when a row was updated
 * (was un-revoked before), false when no row matches or the row was
 * already revoked. Used by the new admin revoke path, the operator-mint
 * rotation cleanup, and any future explicit-revoke surface.
 */
export function revokeTokenByJti(db: Database, jti: string, now: Date): boolean {
  const res = db
    .prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL")
    .run(now.toISOString(), jti);
  return Number(res.changes) > 0;
}

/**
 * Snapshot of currently-revoked-and-not-yet-expired jtis. Powers the
 * `/.well-known/parachute-revocation.json` endpoint. Already-expired jtis
 * are filtered out (no need to advertise the obvious — every consumer
 * checks `exp` itself; the revocation list exists for *unexpired*
 * tokens whose validity got cut short).
 */
export function listActiveRevocations(db: Database, now: Date): string[] {
  const rows = db
    .query<{ jti: string }, [string]>(
      "SELECT jti FROM tokens WHERE revoked_at IS NOT NULL AND expires_at > ? ORDER BY jti",
    )
    .all(now.toISOString());
  return rows.map((r) => r.jti);
}

export interface ValidatedAccessToken {
  payload: JWTPayload;
  kid: string;
}

/**
 * Verifies a JWT against the kid declared in its protected header, looking
 * up the matching key from `signing_keys`. Active + recently-retired keys
 * (whatever's in JWKS) are accepted; older retired keys throw. Expiry is
 * checked by `jose` automatically.
 *
 * Pass `expectedIssuer` to enforce that the JWT's `iss` claim matches what
 * this hub advertises — the same check vault performs against its own
 * `PARACHUTE_HUB_ORIGIN`. Defense in depth: tokens forged or replayed from
 * a different issuer get rejected at validation as well as issuance.
 */
export async function validateAccessToken(
  db: Database,
  token: string,
  expectedIssuer?: string,
): Promise<ValidatedAccessToken> {
  const header = decodeProtectedHeader(token);
  const kid = header.kid;
  if (!kid) throw new Error("validateAccessToken: token missing kid header");
  const match = getAllPublicKeys(db).find((k) => k.kid === kid);
  if (!match) throw new Error(`validateAccessToken: unknown or expired kid ${kid}`);
  const pub = await importSPKI(match.publicKeyPem, SIGNING_ALGORITHM);
  const { payload } = await jwtVerify(
    token,
    pub,
    expectedIssuer ? { issuer: expectedIssuer } : undefined,
  );
  // RFC 7009 revocation enforcement (#73). OAuth-issued tokens carry a
  // tokens row keyed by jti; if that row is marked revoked, the JWT is
  // dead even though its signature + expiry are still valid. Tokens that
  // never had a row (operator tokens, ad-hoc internal mints) bypass this
  // check — they're not part of the OAuth grant lifecycle.
  if (typeof payload.jti === "string") {
    const row = findTokenRowByJti(db, payload.jti);
    if (row?.revokedAt) throw new Error("validateAccessToken: token has been revoked");
  }
  return { payload, kid };
}

/**
 * Convenience for the `tokens` row matching a presented refresh token. Hash
 * the plaintext, look up by hash, return the row if it exists. The caller
 * decides what to do with `revokedAt` — the rotation path treats a revoked
 * row as theft (RFC 6819 §5.2.2.3).
 */
/**
 * Generic shape of a `tokens` row, post-v6. Covers OAuth refresh tokens
 * (`createdVia === "oauth_refresh"`, `userId` set, `subject` null) and
 * the new non-OAuth mint paths (`createdVia === "cli_mint" |
 * "operator_mint"`, may have `userId` set if minted against a hub user,
 * `subject` always set to the operator/service name).
 *
 * `identity` is the canonical "who is this token for" — `userId ??
 * subject`. Use it when you don't care about the OAuth-vs-non distinction.
 */
export interface RefreshTokenRow {
  jti: string;
  /**
   * Hub user id when the row was OAuth-issued or minted against a hub
   * user. Null for service-tied mints (where `subject` carries the
   * service name).
   */
  userId: string | null;
  /**
   * Non-user subject: operator name, service short name, agent id. Null
   * for OAuth refresh-token rows (those use `userId` directly).
   */
  subject: string | null;
  clientId: string;
  scopes: string[];
  /** Family identifier — shared across rotated descendants (#73). */
  familyId: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  /** Provenance tag — drives admin UI grouping. v6 onward this is set on every row. */
  createdVia: TokenCreatedVia;
  /** JSON-encoded fine-grained constraints (auth-architecture-shape.md §11.3). */
  permissions: string | null;
}

/**
 * Convenience: returns the canonical identity string for a tokens row,
 * collapsing the OAuth-vs-non-OAuth distinction. OAuth rows return
 * `userId`; CLI/operator-minted rows return `subject`. At least one is
 * always set post-v6.
 */
export function tokenRowIdentity(row: RefreshTokenRow): string {
  return row.userId ?? row.subject ?? "";
}

interface TokenRowDb {
  jti: string;
  user_id: string | null;
  client_id: string;
  scopes: string;
  family_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  permissions: string | null;
  created_via: string;
  subject: string | null;
}

function rowToRefreshToken(row: TokenRowDb): RefreshTokenRow {
  return {
    jti: row.jti,
    userId: row.user_id,
    subject: row.subject,
    clientId: row.client_id,
    scopes: row.scopes.split(" ").filter((s) => s.length > 0),
    familyId: row.family_id ?? row.jti,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    createdVia: (row.created_via as TokenCreatedVia) ?? "oauth_refresh",
    permissions: row.permissions,
  };
}

export function findRefreshToken(db: Database, plaintext: string): RefreshTokenRow | null {
  const refreshTokenHash = createHash("sha256").update(plaintext).digest("hex");
  const row = db
    .query<TokenRowDb, [string]>("SELECT * FROM tokens WHERE refresh_token_hash = ? LIMIT 1")
    .get(refreshTokenHash);
  return row ? rowToRefreshToken(row) : null;
}

/** Look up a tokens row by jti. Used by the revocation endpoint to find an
 * access-token row from its JWT jti claim, and by validateAccessToken to
 * honor revoked_at. */
export function findTokenRowByJti(db: Database, jti: string): RefreshTokenRow | null {
  const row = db.query<TokenRowDb, [string]>("SELECT * FROM tokens WHERE jti = ? LIMIT 1").get(jti);
  return row ? rowToRefreshToken(row) : null;
}

/**
 * Revoke every row in a refresh-token family. Called by the refresh handler
 * when an already-revoked refresh token is presented again — the spec-defined
 * theft signal (RFC 6819 §5.2.2.3). Idempotent: rows already revoked keep
 * their existing revoked_at.
 */
export function revokeFamily(db: Database, familyId: string, now: Date): number {
  const res = db
    .prepare("UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
    .run(now.toISOString(), familyId);
  return Number(res.changes);
}
