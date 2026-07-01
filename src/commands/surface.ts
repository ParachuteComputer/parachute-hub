/**
 * `parachute surface` — operator management for the Surface Git Transport.
 *
 * Phase 3a ships the DEPLOY TOKEN sub-surface: `parachute surface token
 * mint|list|revoke`. A deploy token is the PAT-equivalent — a scoped, revocable,
 * long-lived `surface:<name>:<read|write>` credential the operator mints on the
 * box and hands to an EXTERNAL/remote git client (a `claude -p` agent, or any
 * machine) so it can `git push`/`git clone` a surface's hub-hosted repo with
 * nothing but a static secret. No browser, no device flow (those are the human
 * paths, later phases) — "a GitHub PAT, but for a parachute surface, git-native."
 *
 * The token mechanics live in the pure `surface-token.ts` library (mint / list /
 * revoke against an open hub DB, reusing the same `signAccessToken` +
 * registered-mint discipline as agent grants). This command layer owns:
 *   - operator-auth (the on-disk `operator.token` must carry `parachute:host:auth`,
 *     mirroring `auth mint-token` / `auth revoke-token` — minting/revoking a
 *     credential is privileged); and
 *   - argument parsing + the "just works" copy-paste git config guidance.
 *
 * Operator-managed governance: the operator minting on their own box IS the
 * authority (the same way `auth mint-token` mints a scope directly). List + revoke
 * give GitHub-PAT-style management — kill a leaked token.
 */
import { CONFIG_DIR } from "../config.ts";
import { surfaceGitRemoteUrl } from "../git-registry.ts";
import { surfaceHelp } from "../help.ts";
import { openHubDb } from "../hub-db.ts";
import { resolveHubIssuer } from "../hub-issuer.ts";
import { OperatorTokenExpiredError, useOperatorTokenWithAutoRotate } from "../operator-token.ts";
import {
  SURFACE_TOKEN_TTL_DEFAULT_SECONDS,
  SURFACE_TOKEN_TTL_MAX_SECONDS,
  type SurfaceAccess,
  listSurfaceTokens,
  mintSurfaceToken,
  revokeSurfaceToken,
} from "../surface-token.ts";

/** Injectable deps for tests — otherwise defaults to the real hub DB + config dir. */
export interface SurfaceDeps {
  /** Override the hub-db path. Tests point at a tmp dir. */
  dbPath?: string;
  /** Override the config dir where `operator.token` / `expose-state.json` live. */
  configDir?: string;
  /** Override the hub origin used as the minted token's `iss`. */
  hubOrigin?: string;
  /** Test seam for the clock. */
  now?: () => Date;
}

/**
 * Entry point for `parachute surface …`. Only the `token` sub-surface exists in
 * Phase 3a; unknown subcommands fall through to help with exit 1.
 */
export async function surface(args: readonly string[], deps: SurfaceDeps = {}): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(surfaceHelp());
    return sub === undefined ? 1 : 0;
  }
  if (sub === "token") {
    return await runToken(args.slice(1), deps);
  }
  console.error(`parachute surface: unknown subcommand "${sub}"`);
  console.error("run `parachute surface --help` for usage");
  return 1;
}

async function runToken(args: readonly string[], deps: SurfaceDeps): Promise<number> {
  const verb = args[0];
  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    console.log(surfaceHelp());
    return verb === undefined ? 1 : 0;
  }
  switch (verb) {
    case "mint":
      return await runTokenMint(args.slice(1), deps);
    case "list":
      return await runTokenList(args.slice(1), deps);
    case "revoke":
      return await runTokenRevoke(args.slice(1), deps);
    default:
      console.error(`parachute surface token: unknown action "${verb}"`);
      console.error("usage: parachute surface token <mint|list|revoke> …");
      return 1;
  }
}

// ===========================================================================
// Operator-auth gate — the on-disk operator.token must carry parachute:host:auth
// ===========================================================================

/**
 * Load + validate the on-disk operator token and require `parachute:host:auth`
 * (the `auth` or `admin` scope-set). Mirrors the gate in `auth mint-token` /
 * `auth revoke-token` — minting / revoking a credential is privileged, and a
 * narrowly-scoped JWT stashed at operator.token must not be able to do it. On
 * success returns the operator's `userId` (registry attribution) + the resolved
 * issuer; on any failure prints an actionable error and returns the exit code.
 */
async function requireOperatorHostAuth(
  db: ReturnType<typeof openHubDb>,
  deps: SurfaceDeps,
  label: string,
): Promise<{ userId: string; issuer: string } | number> {
  const configDir = deps.configDir ?? CONFIG_DIR;
  const issuer = resolveHubIssuer(deps.hubOrigin, configDir);

  let used: Awaited<ReturnType<typeof useOperatorTokenWithAutoRotate>>;
  try {
    used = await useOperatorTokenWithAutoRotate(db, { configDir, issuer });
  } catch (err) {
    if (err instanceof OperatorTokenExpiredError) {
      console.error(`${label}: ${err.message}`);
      return 1;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${label}: operator token invalid — ${msg}`);
    console.error(
      "run `parachute auth rotate-operator` to mint a fresh one, or check that the hub origin matches",
    );
    return 1;
  }
  if (!used) {
    console.error(`${label}: no operator token found at ~/.parachute/operator.token`);
    console.error(
      "run `parachute auth set-password` (first run) or `parachute auth rotate-operator` to mint one",
    );
    return 1;
  }
  if (used.rotated) {
    console.error(
      `${label}: operator token within 7d of expiry — auto-rotated to ${used.rotated.expiresAt} (scope_set=${used.rotated.scopeSet})`,
    );
  }
  const operatorSub = used.payload.sub;
  if (typeof operatorSub !== "string" || operatorSub.length === 0) {
    console.error(`${label}: operator token has no sub claim`);
    return 1;
  }
  const tokenScope =
    typeof used.payload.scope === "string"
      ? used.payload.scope.split(/\s+/).filter((s) => s.length > 0)
      : [];
  if (!tokenScope.includes("parachute:host:auth")) {
    console.error(`${label}: operator token lacks parachute:host:auth scope`);
    console.error(
      "narrowed scope-sets without `auth` (install/start/expose/vault) can't manage deploy tokens — run `parachute auth rotate-operator --scope-set auth` (or `admin`)",
    );
    return 1;
  }
  return { userId: operatorSub, issuer };
}

// ===========================================================================
// mint
// ===========================================================================

interface MintFlags {
  name?: string;
  access: SurfaceAccess;
  ttlSeconds: number;
  json: boolean;
  error?: string;
}

/**
 * Parse the mint args: a single surface-name positional + `--read|--write`
 * (default write — a deploy token's job is to push) + `--ttl <dur>` /
 * `--expires-in <s>` (default 90d, cap 365d) + `--json`.
 */
function parseMintFlags(args: readonly string[]): MintFlags {
  let name: string | undefined;
  let access: SurfaceAccess | undefined;
  let ttlSeconds = SURFACE_TOKEN_TTL_DEFAULT_SECONDS;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--read") {
      if (access === "write")
        return {
          access: "write",
          ttlSeconds,
          json,
          error: "--read and --write are mutually exclusive",
        };
      access = "read";
    } else if (a === "--write") {
      if (access === "read")
        return {
          access: "read",
          ttlSeconds,
          json,
          error: "--read and --write are mutually exclusive",
        };
      access = "write";
    } else if (a === "--json") {
      json = true;
    } else if (a === "--ttl" || a === "--expires-in") {
      const val = args[++i];
      if (val === undefined)
        return { access: access ?? "write", ttlSeconds, json, error: `${a} requires a value` };
      const parsed = a === "--ttl" ? parseDuration(val) : parseSeconds(val);
      if ("error" in parsed)
        return { access: access ?? "write", ttlSeconds, json, error: parsed.error };
      ttlSeconds = parsed.seconds;
    } else if (a.startsWith("--")) {
      return { access: access ?? "write", ttlSeconds, json, error: `unknown flag "${a}"` };
    } else if (name === undefined) {
      name = a;
    } else {
      return {
        access: access ?? "write",
        ttlSeconds,
        json,
        error: `unexpected argument "${a}" (only one surface name)`,
      };
    }
  }
  return { name, access: access ?? "write", ttlSeconds, json };
}

async function runTokenMint(args: readonly string[], deps: SurfaceDeps): Promise<number> {
  const label = "parachute surface token mint";
  const flags = parseMintFlags(args);
  if (flags.error) {
    console.error(`${label}: ${flags.error}`);
    return 1;
  }
  if (!flags.name) {
    console.error(`${label}: missing surface name`);
    console.error(
      "usage: parachute surface token mint <name> [--read|--write] [--ttl <dur>] [--json]",
    );
    return 1;
  }

  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const auth = await requireOperatorHostAuth(db, deps, label);
    if (typeof auth === "number") return auth;

    let minted: Awaited<ReturnType<typeof mintSurfaceToken>>;
    try {
      minted = await mintSurfaceToken(db, {
        name: flags.name,
        access: flags.access,
        issuer: auth.issuer,
        ttlSeconds: flags.ttlSeconds,
        userId: auth.userId,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${label}: ${msg}`);
      return 1;
    }

    const remoteUrl = surfaceGitRemoteUrl(auth.issuer, flags.name);
    const loopback = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:|\/|$)/.test(auth.issuer);

    if (flags.json) {
      // Machine-consumable: everything a remote client needs to configure git,
      // in one blob (easy to hand a `claude -p` agent as config).
      console.log(
        JSON.stringify(
          {
            token: minted.token,
            jti: minted.jti,
            scope: minted.scope,
            surface: flags.name,
            access: flags.access,
            expiresAt: minted.expiresAt,
            remoteUrl,
            credentialHelper: CREDENTIAL_HELPER_INLINE,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    // Human path: the token is the ONLY thing on stdout (pipe purity — e.g.
    // `parachute surface token mint x --write | pbcopy`); everything else is
    // guidance on stderr.
    console.log(minted.token);
    console.error("");
    console.error(`Surface deploy token minted for "${flags.name}" (${flags.access}).`);
    console.error(`  jti:      ${minted.jti}`);
    console.error(`  scope:    ${minted.scope}`);
    console.error(`  expires:  ${minted.expiresAt}`);
    console.error(`  remote:   ${remoteUrl}`);
    console.error(`  revoke:   parachute surface token revoke ${minted.jti}`);
    console.error("");
    console.error("The token was printed to stdout. Hand it to the remote client as a secret,");
    console.error("then, on that machine (any box with git — NO parachute install needed):");
    console.error("");
    console.error("  export PARACHUTE_SURFACE_TOKEN=<paste-the-token>");
    console.error(`  git config --global credential.helper '${CREDENTIAL_HELPER_INLINE}'`);
    console.error(`  git clone ${remoteUrl} my-surface   # then edit + git push`);
    console.error("");
    console.error("Keep the token in an env var / credential helper — never commit it or put it");
    console.error("in a remote URL (it would leak into .git/config).");
    if (loopback) {
      console.error("");
      console.error(
        `NOTE: the hub origin is loopback (${auth.issuer}) — a remote client can only reach`,
      );
      console.error(
        "this surface once the box is exposed (`parachute expose …`). Re-mint after exposing so",
      );
      console.error("the remote URL points at the public origin.");
    }
    return 0;
  } finally {
    db.close();
  }
}

// ===========================================================================
// list
// ===========================================================================

async function runTokenList(args: readonly string[], deps: SurfaceDeps): Promise<number> {
  const label = "parachute surface token list";
  let name: string | undefined;
  let json = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a.startsWith("--")) {
      console.error(`${label}: unknown flag "${a}"`);
      return 1;
    } else if (name === undefined) name = a;
    else {
      console.error(`${label}: unexpected argument "${a}" (only one surface name)`);
      return 1;
    }
  }

  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const auth = await requireOperatorHostAuth(db, deps, label);
    if (typeof auth === "number") return auth;

    const now = deps.now?.() ?? new Date();
    const rows = listSurfaceTokens(db, name).map((r) => ({
      ...r,
      status: statusOf(r.revokedAt, r.expiresAt, now),
    }));

    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      console.log(
        name
          ? `No surface deploy tokens for "${name}".`
          : "No surface deploy tokens. Mint one with `parachute surface token mint <name>`.",
      );
      return 0;
    }
    // Fixed-ish columns; jti + surface names are bounded, so a simple pad reads
    // cleanly without a table lib.
    console.log(
      `${pad("JTI", 24)}  ${pad("SURFACE", 20)}  ${pad("ACCESS", 6)}  ${pad("STATUS", 8)}  EXPIRES`,
    );
    for (const r of rows) {
      console.log(
        `${pad(r.jti, 24)}  ${pad(r.name, 20)}  ${pad(r.access, 6)}  ${pad(r.status, 8)}  ${r.expiresAt}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

// ===========================================================================
// revoke
// ===========================================================================

async function runTokenRevoke(args: readonly string[], deps: SurfaceDeps): Promise<number> {
  const label = "parachute surface token revoke";
  const positionals = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (flags.length > 0) {
    console.error(
      `${label}: unexpected flag "${flags[0]}" (this command takes a jti positional only)`,
    );
    return 1;
  }
  if (positionals.length === 0) {
    console.error(`${label}: missing jti argument`);
    console.error(
      "usage: parachute surface token revoke <jti>  (find it with `parachute surface token list`)",
    );
    return 1;
  }
  if (positionals.length > 1) {
    console.error(`${label}: unexpected argument "${positionals[1]}" (only one jti at a time)`);
    return 1;
  }
  const jti = positionals[0]!;

  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const auth = await requireOperatorHostAuth(db, deps, label);
    if (typeof auth === "number") return auth;

    const result = revokeSurfaceToken(db, jti, deps.now?.() ?? new Date());
    switch (result.status) {
      case "revoked":
        console.log(
          `Revoked surface deploy token ${jti}. The git endpoint rejects it within ~60s (revocation list poll).`,
        );
        return 0;
      case "already-revoked":
        console.log(`already revoked at ${result.revokedAt}: jti=${jti}`);
        return 0;
      case "not-found":
        console.error(`${label}: no surface deploy token with jti ${jti} in the registry`);
        return 1;
      case "not-surface-token":
        console.error(
          `${label}: jti ${jti} is not a surface deploy token (it is a ${result.createdVia} token)`,
        );
        console.error("use `parachute auth revoke-token` to revoke non-surface tokens");
        return 1;
    }
  } finally {
    db.close();
  }
}

// ===========================================================================
// Shared helpers
// ===========================================================================

/**
 * The zero-file git credential helper (inline `!`-command form) — the "just
 * works" mechanism. On `get`, emits `x-access-token:<token>` from
 * `$PARACHUTE_SURFACE_TOKEN`, which the hub git endpoint accepts as Basic
 * (`extractToken` in git-transport.ts). Works on ANY git version + any box with
 * `sh` — no parachute install, no extra file. The named `git-credential-parachute`
 * script (scripts/) is the equivalent for repeated use.
 */
const CREDENTIAL_HELPER_INLINE =
  '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$PARACHUTE_SURFACE_TOKEN"; }; f';

function statusOf(revokedAt: string | null, expiresAt: string, now: Date): string {
  if (revokedAt) return "revoked";
  if (Date.parse(expiresAt) <= now.getTime()) return "expired";
  return "active";
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function parseSeconds(input: string): { seconds: number } | { error: string } {
  const seconds = Number.parseInt(input, 10);
  if (!Number.isFinite(seconds) || String(seconds) !== input.trim() || seconds <= 0) {
    return {
      error: `invalid --expires-in "${input}" — must be a positive integer number of seconds`,
    };
  }
  if (seconds > SURFACE_TOKEN_TTL_MAX_SECONDS) {
    return {
      error: `--expires-in "${input}" exceeds the 365d cap (${SURFACE_TOKEN_TTL_MAX_SECONDS} seconds)`,
    };
  }
  return { seconds };
}

/** Parse a duration with a d/h/m/s suffix (e.g. `90d`, `24h`, `30m`, `60s`). */
function parseDuration(input: string): { seconds: number } | { error: string } {
  const m = /^(\d+)([dhms])$/.exec(input.trim());
  if (!m) {
    return { error: `invalid --ttl "${input}" — use a duration like 90d, 24h, 30m, or 60s` };
  }
  const n = Number.parseInt(m[1]!, 10);
  const unit = m[2]!;
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  const seconds = n * mult;
  if (seconds <= 0) return { error: `invalid --ttl "${input}" — must be > 0` };
  if (seconds > SURFACE_TOKEN_TTL_MAX_SECONDS) {
    return { error: `--ttl "${input}" exceeds the 365d cap` };
  }
  return { seconds };
}
