/**
 * Operator token — long-lived hub-issued JWT that local CLI tools use to
 * authenticate against on-box services (vault / scribe / channel) without
 * running an interactive OAuth dance every time.
 *
 * Why this exists: modules require auth on every request — there is no
 * "loopback is trusted" bypass, because browser extensions and compromised
 * postinstalls can hit 127.0.0.1 too. The operator token is the on-box
 * caller's bearer credential; it lives in `~/.parachute/operator.token`
 * with mode 0600 so a different unix user can't read it.
 *
 * Browser apps follow the OAuth flow and never touch this file. Service
 * accounts (cron jobs, oncall scripts) read it; that's the whole point.
 *
 * Lifetime: 90 days by default (was 365d through 0.5.7). The opportunistic
 * auto-rotation helper `useOperatorTokenWithAutoRotate` re-mints any
 * within-7d-of-expiry token in-place, so an operator who runs the CLI at
 * least weekly never sees an expiry surprise. Fully expired tokens fail
 * with an explicit re-auth message — auto-rotating from a dead token would
 * defeat the lifetime cap (security: forces a manual re-auth touch).
 *
 * Operator-token jtis are tracked in the hub `tokens` registry as of
 * hub#212 Phase 1 (created_via='operator_mint'); per-jti revocation is
 * enforced via validateAccessToken's row.revokedAt check. A leaked file
 * still stays valid until either its TTL elapses or the operator
 * explicitly revokes the jti — treat operator.token like an SSH private
 * key.
 */
import type { Database } from "bun:sqlite";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.ts";
import { recordTokenMint, signAccessToken, validateAccessToken } from "./jwt-sign.ts";

export const OPERATOR_TOKEN_FILENAME = "operator.token";
/** Default operator-token lifetime — 90 days, was 365d through 0.5.7 (#213). */
export const OPERATOR_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;
/**
 * Auto-rotation threshold. When a CLI flow validates an operator token whose
 * remaining lifetime is less than this, it silently re-mints with the same
 * scope-set + a fresh full TTL. 7 days picked so a once-a-week operator
 * never sees expiry; longer would let stale tokens accumulate, shorter
 * would re-mint too often.
 */
export const OPERATOR_TOKEN_AUTO_ROTATE_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;
export const OPERATOR_TOKEN_AUDIENCE = "operator";
export const OPERATOR_TOKEN_CLIENT_ID = "parachute-hub";

/**
 * Named scope-sets a `parachute auth rotate-operator` invocation can choose
 * via `--scope-set`. Each set encodes the minimum scopes required for that
 * operator-flow's API surface; `admin` is the back-compat superset and
 * stays the default.
 *
 * Phase 1 (hub#213): the vocabulary + flag exist; CLI commands do NOT yet
 * gate on the narrower scopes. Operators can mint a `--scope-set=start`
 * token and use it as their operator.token, but commands like `install`
 * still accept it (they only check `hub:admin` today). Phase 2 (separate
 * follow-up) wires per-command enforcement so a `start` token can only
 * lifecycle-manage, not install. Until then, `--scope-set` is a tool the
 * cautious operator can opt into without breaking anyone.
 *
 * The fine-grained `parachute:host:install/start/expose/auth/vault` scopes
 * are operator-only (non-requestable via public OAuth), like
 * `parachute:host:admin` — registered in `scope-explanations.ts`.
 */
export type OperatorScopeSet = "install" | "start" | "expose" | "auth" | "vault" | "admin";

export const OPERATOR_TOKEN_SCOPE_SET_NAMES: readonly OperatorScopeSet[] = [
  "install",
  "start",
  "expose",
  "auth",
  "vault",
  "admin",
];

/**
 * Scopes embedded for each named set. `admin` preserves the pre-#213
 * `OPERATOR_TOKEN_SCOPES` set verbatim plus the new fine-grained host
 * scopes (which `admin` is a superset of by definition).
 */
export const OPERATOR_TOKEN_SCOPE_SETS: Readonly<Record<OperatorScopeSet, readonly string[]>> = {
  install: ["parachute:host:install", "vault:read"],
  start: ["parachute:host:start"],
  expose: ["parachute:host:expose"],
  auth: ["parachute:host:auth"],
  vault: ["parachute:host:vault"],
  admin: [
    "hub:admin",
    "parachute:host:admin",
    "parachute:host:install",
    "parachute:host:start",
    "parachute:host:expose",
    "parachute:host:auth",
    "parachute:host:vault",
    "vault:admin",
    "scribe:admin",
    "channel:send",
  ],
};

/**
 * Pre-#213 export: the broad "admin" scope-set as a flat array. Kept for
 * back-compat with callers (e.g. existing tests) that imported the constant
 * directly. New callers should use `OPERATOR_TOKEN_SCOPE_SETS.admin`.
 */
export const OPERATOR_TOKEN_SCOPES = OPERATOR_TOKEN_SCOPE_SETS.admin;

/** Custom JWT claim that records which scope-set this operator token was minted under. */
export const OPERATOR_TOKEN_SCOPE_SET_CLAIM = "pa_scope_set";

/** Default scope-set when none is specified. Preserves pre-#213 behavior. */
export const OPERATOR_TOKEN_DEFAULT_SCOPE_SET: OperatorScopeSet = "admin";

export function isOperatorScopeSet(value: unknown): value is OperatorScopeSet {
  return (
    typeof value === "string" &&
    (OPERATOR_TOKEN_SCOPE_SET_NAMES as readonly string[]).includes(value)
  );
}

export function operatorTokenPath(dir: string = configDir()): string {
  return join(dir, OPERATOR_TOKEN_FILENAME);
}

export interface MintOperatorTokenOpts {
  /**
   * Hub origin — written into the JWT's `iss` claim. On-box services
   * (vault, scribe, channel) reject tokens whose `iss` doesn't match the
   * `PARACHUTE_HUB_ORIGIN` they were started with. Callers derive this via
   * `deriveHubOrigin()`.
   */
  issuer: string;
  /** Override the JWT-sign clock — tests pin time. */
  now?: () => Date;
  /** Override the random jti — tests pin it. */
  jti?: string;
  /** Override the audience claim. Defaults to "operator". */
  audience?: string;
  /** Which named scope-set to mint under. Defaults to "admin" (pre-#213 behavior). */
  scopeSet?: OperatorScopeSet;
  /** Override the lifetime. Tests pin this; production uses the default. */
  ttlSeconds?: number;
}

export async function mintOperatorToken(
  db: Database,
  userId: string,
  opts: MintOperatorTokenOpts,
): Promise<{ token: string; jti: string; expiresAt: string; scopeSet: OperatorScopeSet }> {
  const scopeSet = opts.scopeSet ?? OPERATOR_TOKEN_DEFAULT_SCOPE_SET;
  const scopes = [...OPERATOR_TOKEN_SCOPE_SETS[scopeSet]];
  const minted = await signAccessToken(db, {
    sub: userId,
    scopes,
    audience: opts.audience ?? OPERATOR_TOKEN_AUDIENCE,
    clientId: OPERATOR_TOKEN_CLIENT_ID,
    issuer: opts.issuer,
    ttlSeconds: opts.ttlSeconds ?? OPERATOR_TOKEN_TTL_SECONDS,
    extraClaims: { [OPERATOR_TOKEN_SCOPE_SET_CLAIM]: scopeSet },
    ...(opts.jti !== undefined ? { jti: opts.jti } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  // Register every operator-mint with the unified token registry (hub#212
  // Phase 1). Per design: operator-mint rows have user_id NULL; the
  // subject column carries the canonical "operator" identity string.
  // (Storing user_id here would require an FK-valid users row, which the
  // operator-mint path doesn't always have access to in test fixtures —
  // and conceptually the operator is a role, not a hub user.) Powers the
  // revocation list endpoint.
  recordTokenMint(db, {
    jti: minted.jti,
    createdVia: "operator_mint",
    subject: "operator",
    clientId: OPERATOR_TOKEN_CLIENT_ID,
    scopes,
    expiresAt: minted.expiresAt,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { ...minted, scopeSet };
}

/**
 * Atomically writes the token to `<dir>/operator.token` with mode 0600.
 * Atomic = write to `<path>.tmp` then rename, so a half-written file never
 * exists at the canonical path.
 */
export async function writeOperatorTokenFile(
  token: string,
  dir: string = configDir(),
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const path = operatorTokenPath(dir);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, `${token}\n`, { mode: 0o600 });
  // Defense-in-depth: if the file already existed with looser permissions,
  // some platforms (Linux, macOS) preserve the prior inode's mode rather
  // than honoring the create-mode hint on rename. Force 0600 explicitly.
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, path);
  return path;
}

/**
 * Reads the operator token file, trims trailing whitespace. Returns null
 * if the file doesn't exist (caller decides whether that's an error). Any
 * other read error propagates.
 *
 * On read, checks file permissions. If the file is group- or world-readable
 * (mode bits 0o077 set), logs a warning but does NOT fail the read — a
 * read-only failure here would lock operators out of every CLI command,
 * with no in-CLI way to recover. The warning + remediation hint
 * (`chmod 0600 <path>`) lets the operator self-correct without losing
 * access. New writes via `writeOperatorTokenFile` are always 0600.
 */
export async function readOperatorTokenFile(dir: string = configDir()): Promise<string | null> {
  const path = operatorTokenPath(dir);
  try {
    const buf = await fs.readFile(path, "utf8");
    await warnIfWorldReadable(path);
    const trimmed = buf.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function warnIfWorldReadable(path: string): Promise<void> {
  try {
    const stat = await fs.stat(path);
    const looseBits = stat.mode & 0o077;
    if (looseBits !== 0) {
      const mode = (stat.mode & 0o777).toString(8).padStart(4, "0");
      console.error(
        `parachute: operator token file at ${path} has mode ${mode} (group/other can read it). Run \`chmod 0600 ${path}\` to lock it down.`,
      );
    }
  } catch {
    // If stat fails (file vanished between read and stat, or platform
    // doesn't expose mode bits), skip the warning — the read already
    // succeeded, and this is defense-in-depth, not a hard gate.
  }
}

export interface IssueOperatorTokenResult {
  token: string;
  jti: string;
  expiresAt: string;
  path: string;
  scopeSet: OperatorScopeSet;
}

/**
 * Mint + write in one call. Used by `parachute auth set-password` (after
 * password set), `parachute auth rotate-operator`, and the auto-rotation
 * path inside `useOperatorTokenWithAutoRotate`.
 */
export async function issueOperatorToken(
  db: Database,
  userId: string,
  opts: MintOperatorTokenOpts & { dir?: string },
): Promise<IssueOperatorTokenResult> {
  const minted = await mintOperatorToken(db, userId, opts);
  const path = await writeOperatorTokenFile(minted.token, opts.dir);
  return { ...minted, path };
}

export class OperatorTokenExpiredError extends Error {
  override name = "OperatorTokenExpiredError";
}

export interface UseOperatorTokenOpts {
  /** Hub origin used as `iss` validator. Required. */
  issuer: string;
  /** configDir override (where operator.token lives). Defaults to `configDir()`. */
  configDir?: string;
  /**
   * Override the rotation clock. Tests pin this; production uses
   * `() => new Date()`.
   */
  now?: () => Date;
}

export interface UsedOperatorToken {
  /** The operator token plaintext to present as bearer. After auto-rotation, this is the freshly-minted token. */
  token: string;
  /** Validated payload of `token` (post-rotation if a rotation occurred). */
  payload: Awaited<ReturnType<typeof validateAccessToken>>["payload"];
  /** Set when this call rotated the on-disk token. The new path on disk. */
  rotated?: { path: string; scopeSet: OperatorScopeSet; expiresAt: string };
  /** True if the on-disk token was within the auto-rotation threshold (informational). */
  refreshed: boolean;
}

/**
 * The canonical "use the operator token in a CLI flow" helper. Reads
 * `~/.parachute/operator.token`, validates against `db` + `issuer`, and:
 *
 *   - If the token has fully expired: throws `OperatorTokenExpiredError`
 *     with an actionable message. Does NOT auto-rotate from a dead token —
 *     auto-rotating an expired token would defeat the lifetime cap.
 *   - If the remaining lifetime is below the auto-rotate threshold (7d):
 *     re-mints under the same scope-set, writes back to disk, and returns
 *     the new token. Operator never sees an expiry surprise as long as
 *     they exercise the CLI at least weekly.
 *   - Otherwise: returns the original token + payload.
 *
 * Callers receive the (possibly fresh) token to present onward. The
 * scope-set is preserved across rotations via the `pa_scope_set` claim;
 * tokens minted before #213 don't carry the claim and are treated as
 * `admin` (back-compat).
 */
export async function useOperatorTokenWithAutoRotate(
  db: Database,
  opts: UseOperatorTokenOpts,
): Promise<UsedOperatorToken | null> {
  const dir = opts.configDir ?? configDir();
  const token = await readOperatorTokenFile(dir);
  if (!token) return null;
  const now = opts.now ?? (() => new Date());

  // Validation failures (signature mismatch, wrong issuer, missing kid,
  // expired-by-jose) bubble out for the caller to render the right message.
  const validated = await validateAccessToken(db, token, opts.issuer);
  const { payload } = validated;

  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const nowSec = Math.floor(now().getTime() / 1000);
  const remaining = exp - nowSec;

  // jose's verify will reject expired tokens before we get here, so this
  // branch is defensive; callers that catch validateAccessToken errors and
  // re-call this with a hand-rolled payload would land here.
  if (remaining <= 0) {
    throw new OperatorTokenExpiredError(
      "your operator token has expired; run `parachute auth rotate-operator` to re-mint",
    );
  }

  if (remaining > OPERATOR_TOKEN_AUTO_ROTATE_THRESHOLD_SECONDS) {
    return { token, payload, refreshed: false };
  }

  // Within rotation window — but only auto-rotate if this is genuinely an
  // operator token. The audience check is the privilege-escalation guard:
  // an arbitrary scope-narrow JWT (aud: "scribe", "vault", …) hand-stashed
  // at ~/.parachute/operator.token must NOT be silently upgraded to a full
  // operator token by the hub. Legitimate operator-tokens minted via
  // `set-password` / `rotate-operator` carry `aud: "operator"`.
  if (payload.aud !== OPERATOR_TOKEN_AUDIENCE) {
    return { token, payload, refreshed: false };
  }

  // Re-mint preserving scope-set.
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) {
    // No sub claim — can't safely auto-rotate (don't know who the token
    // belongs to). Return as-is; the caller will likely surface this as an
    // invalid-token error downstream.
    return { token, payload, refreshed: false };
  }
  const claimedSet = payload[OPERATOR_TOKEN_SCOPE_SET_CLAIM];
  const scopeSet: OperatorScopeSet = isOperatorScopeSet(claimedSet)
    ? claimedSet
    : OPERATOR_TOKEN_DEFAULT_SCOPE_SET;
  const issued = await issueOperatorToken(db, sub, {
    dir,
    issuer: opts.issuer,
    scopeSet,
    now: opts.now,
  });
  const reValidated = await validateAccessToken(db, issued.token, opts.issuer);
  return {
    token: issued.token,
    payload: reValidated.payload,
    rotated: { path: issued.path, scopeSet: issued.scopeSet, expiresAt: issued.expiresAt },
    refreshed: true,
  };
}
