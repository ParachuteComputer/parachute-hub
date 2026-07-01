/**
 * Surface DEPLOY tokens — the PAT-equivalent for the Surface Git Transport
 * (Phase 3a, design doc 2026-06-30-surface-git-transport.md §6b).
 *
 * Phases 0a–2 gave the hub an authenticated `git http-backend` endpoint
 * (`/git/<name>`) that validates `surface:<name>:read|write`, plus an in-framework
 * grant flow that injects a per-turn token into an internal agent's `GIT_ASKPASS`.
 * This module serves the OTHER actor: an EXTERNAL/remote git client — a
 * `claude -p` agent (or any box) on a different machine — that just needs to hold
 * a static secret and `git push`.
 *
 * The answer is a scoped, REGISTERED, REVOCABLE, LISTABLE token the operator
 * mints and hands over: "a GitHub PAT, but for a parachute surface, git-native."
 * It reuses the exact same mint (`signAccessToken`) + registered-mint discipline
 * (`recordTokenMint` → the git endpoint's `validateAccessToken` accepts it, the
 * revocation list kills it) as the agent-grant path ({@link mintSurfaceGrant} in
 * admin-agent-grants.ts) — minus the approval flow, because the operator minting
 * it on their own box IS the governance.
 *
 * Security posture (design §7): the token is scoped to ONE surface + one verb
 * (read xor write), registered so the operator can list + revoke it (kill a
 * leaked one, like GitHub PAT management), and fixed-TTL (default 90d — re-mint
 * to renew). Blast radius is a deploy-key, not a master key: even a push builds
 * in surface-host's sandbox (Phase 0c). The secret lives in the token the
 * operator hands over — never persisted here beyond the registry row (which holds
 * the jti + scope + expiry for revocation, NOT the token bytes).
 *
 * This is a pure library — no CLI I/O, no operator-token loading. The command
 * (`commands/surface.ts`) does the operator-auth gate + argument parsing +
 * output; these functions do the token mechanics against an open hub DB.
 */
import type { Database } from "bun:sqlite";
import { SURFACE_NAME_RE } from "./git-registry.ts";
import {
  findTokenRowByJti,
  listTokens,
  recordTokenMint,
  revokeTokenByJti,
  signAccessToken,
} from "./jwt-sign.ts";

/** A deploy token's authority — read (clone/fetch) xor write (push). Write ⊇ read
 *  at the git endpoint (a writer can always fetch), matching GitHub's model. */
export type SurfaceAccess = "read" | "write";

/**
 * `created_via` tag stamped on deploy-token registry rows. The narrowing key for
 * `listSurfaceTokens` / `revokeSurfaceToken` — so deploy tokens are managed as a
 * distinct class from agent grants (`agent_grant`) and generic CLI mints
 * (`cli_mint`), even though all three can carry a `surface:<name>:<verb>` scope.
 */
export const SURFACE_TOKEN_CREATED_VIA = "surface_token" as const;

/** `sub` + registry `subject` for a deploy token — no hub user is tied to it (it's
 *  handed to an external client). Surfaces as `REMOTE_USER` in the git endpoint. */
export const SURFACE_TOKEN_SUBJECT = "surface-deploy";

/** `client_id` on a deploy token — distinguishes it in the registry / admin UI. */
export const SURFACE_TOKEN_CLIENT_ID = "parachute-surface-token";

/**
 * Default deploy-token lifetime — 90 days, matching the surface/vault GRANT
 * posture (long-lived-but-revocable; a headless client holds it, re-mint to
 * renew). Long-lived is a convenience/exposure tradeoff — kept bounded + easily
 * revocable rather than never-expiring (design §7 "consider a sane default TTL").
 */
export const SURFACE_TOKEN_TTL_DEFAULT_SECONDS = 90 * 24 * 60 * 60;

/** Hard cap on `--ttl`/`--expires-in` — 365 days, matching `auth mint-token`. */
export const SURFACE_TOKEN_TTL_MAX_SECONDS = 365 * 24 * 60 * 60;

/**
 * A `surface:<name>:<verb>` scope, verb ∈ {read, write}. The name group MUST
 * stay in sync with `SURFACE_NAME_RE` (git-registry.ts) — it is the same
 * kebab/alnum charset, inlined here (rather than composed from `.source`) to
 * keep this a plain anchored literal. If `SURFACE_NAME_RE`'s charset ever
 * widens (e.g. dots), widen this too or `listSurfaceTokens` will silently drop
 * tokens whose name uses the new character.
 */
const SURFACE_SCOPE_RE = /^surface:([a-zA-Z0-9][a-zA-Z0-9_-]{0,63}):(read|write)$/;

/** Build the canonical deploy-token scope string. */
export function surfaceScope(name: string, access: SurfaceAccess): string {
  return `surface:${name}:${access}`;
}

export interface MintSurfaceTokenOpts {
  /** Surface name — a `SURFACE_NAME_RE` slug (validated here; throws otherwise). */
  name: string;
  /** read (clone/fetch) or write (push). */
  access: SurfaceAccess;
  /** Hub origin → the token's `iss` (resolved by the caller via `resolveHubIssuer`). */
  issuer: string;
  /** Lifetime; defaults to {@link SURFACE_TOKEN_TTL_DEFAULT_SECONDS}. */
  ttlSeconds?: number;
  /**
   * Optional hub user_id to tie the registry row to (the minting operator's
   * user). The `sub`/`subject` stay {@link SURFACE_TOKEN_SUBJECT} regardless —
   * the token is for an external client, not a hub user session.
   */
  userId?: string;
  /** Test seam — defaults to the real `signAccessToken`. */
  signToken?: typeof signAccessToken;
  now?: () => Date;
}

export interface MintedSurfaceToken {
  /** The JWT to hand the external client. NOT recoverable from the DB afterward. */
  token: string;
  jti: string;
  expiresAt: string;
  scope: string;
}

/**
 * Mint a surface deploy token: a REGISTERED (`created_via: "surface_token"`)
 * `surface:<name>:<verb>` JWT the git-transport endpoint validates (signature →
 * hub keys, `iss` ∈ the multi-origin hub-bound set, revocation, then
 * `scopes.includes("surface:<name>:<verb>")`). Mirrors {@link mintSurfaceGrant}
 * — same registered-mint discipline so `revokeSurfaceToken` (and the revocation
 * list) can kill it — minus the vault-only bits (no `vaultScope`, no
 * `scoped_tags`). Audience is `surface.<name>` for symmetry with `vault.<name>`;
 * the git endpoint doesn't check `aud` (it keys purely off the URL path + the
 * scope), so it's cosmetic but honest.
 *
 * The scope is signed VERBATIM — the operator minting on their own box (holding
 * `parachute:host:auth`, gated upstream in the command) IS the authority, the
 * same way `auth mint-token` mints a scope directly.
 */
export async function mintSurfaceToken(
  db: Database,
  opts: MintSurfaceTokenOpts,
): Promise<MintedSurfaceToken> {
  if (!SURFACE_NAME_RE.test(opts.name)) {
    throw new Error(
      `invalid surface name "${opts.name}" — must match ${SURFACE_NAME_RE} (kebab/alnum, no slashes or dots)`,
    );
  }
  const scope = surfaceScope(opts.name, opts.access);
  const ttlSeconds = opts.ttlSeconds ?? SURFACE_TOKEN_TTL_DEFAULT_SECONDS;
  const sign = opts.signToken ?? signAccessToken;
  const signed = await sign(db, {
    sub: SURFACE_TOKEN_SUBJECT,
    scopes: [scope],
    audience: `surface.${opts.name}`,
    clientId: SURFACE_TOKEN_CLIENT_ID,
    issuer: opts.issuer,
    ttlSeconds,
    vaultScope: [], // not a per-user vault credential
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  // Register the long-lived mint so revoke can drop it (registered-mint rule —
  // an unregistered long-lived token is unrevocable).
  recordTokenMint(db, {
    jti: signed.jti,
    createdVia: SURFACE_TOKEN_CREATED_VIA,
    subject: SURFACE_TOKEN_SUBJECT,
    ...(opts.userId ? { userId: opts.userId } : {}),
    clientId: SURFACE_TOKEN_CLIENT_ID,
    scopes: [scope],
    expiresAt: signed.expiresAt,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { token: signed.token, jti: signed.jti, expiresAt: signed.expiresAt, scope };
}

/** A deploy token's listing row (metadata only — never the token bytes). */
export interface SurfaceTokenListing {
  jti: string;
  /** Surface name parsed from the scope. */
  name: string;
  access: SurfaceAccess;
  scope: string;
  createdAt: string;
  expiresAt: string;
  /** ISO timestamp when revoked, or null if live. */
  revokedAt: string | null;
}

/**
 * List surface deploy tokens, newest-first, optionally narrowed to one surface.
 * Pages through the whole `surface_token` class (the registry filter) and keeps
 * only rows whose scope is a well-formed `surface:<name>:<verb>` — a deploy token
 * always carries exactly that one scope. Metadata only; the token bytes are never
 * stored, so they never appear here.
 */
export function listSurfaceTokens(db: Database, name?: string): SurfaceTokenListing[] {
  const out: SurfaceTokenListing[] = [];
  let cursor: string | null = null;
  do {
    const page = listTokens(db, {
      filter: { createdVia: SURFACE_TOKEN_CREATED_VIA },
      cursor,
    });
    for (const row of page.rows) {
      const scope = row.scopes.find((s) => SURFACE_SCOPE_RE.test(s));
      if (!scope) continue;
      const m = SURFACE_SCOPE_RE.exec(scope);
      if (!m) continue;
      const parsedName = m[1] ?? "";
      const access = (m[2] ?? "read") as SurfaceAccess;
      if (name !== undefined && parsedName !== name) continue;
      out.push({
        jti: row.jti,
        name: parsedName,
        access,
        scope,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** Outcome of a revoke attempt. */
export type RevokeSurfaceTokenResult =
  | { status: "revoked"; jti: string }
  | { status: "already-revoked"; jti: string; revokedAt: string }
  | { status: "not-found"; jti: string }
  | { status: "not-surface-token"; jti: string; createdVia: string };

/**
 * Revoke a surface deploy token by jti. Fails closed on a jti that is NOT a
 * deploy token (`not-surface-token`) so this command can't be turned into a
 * general token-revoker — the operator uses `auth revoke-token` for other kinds.
 * Idempotent: re-revoking an already-revoked deploy token reports its existing
 * `revokedAt` (the caller exits 0).
 */
export function revokeSurfaceToken(db: Database, jti: string, now: Date): RevokeSurfaceTokenResult {
  const row = findTokenRowByJti(db, jti);
  if (!row) return { status: "not-found", jti };
  if (row.createdVia !== SURFACE_TOKEN_CREATED_VIA) {
    return { status: "not-surface-token", jti, createdVia: row.createdVia };
  }
  if (row.revokedAt) return { status: "already-revoked", jti, revokedAt: row.revokedAt };
  const ok = revokeTokenByJti(db, jti, now);
  // Race: the row existed then vanished/was-revoked between our lookups. Report
  // not-found rather than silently succeeding (mirrors `auth revoke-token`).
  if (!ok) return { status: "not-found", jti };
  return { status: "revoked", jti };
}
