/**
 * `parachute auth` — ecosystem-level identity commands.
 *
 * Hub-local subcommands (write to `~/.parachute/hub.db`):
 *   - `rotate-key` — rotate the JWT signing keypair.
 *   - `set-password` — create or update the hub user's password. *NEW in
 *     0.3.1-rc.2*: this used to forward to `parachute-vault set-password`.
 *     The hub now owns identity, so set-password writes to `users` in
 *     hub.db. The OAuth endpoints still proxy to vault until PR (c) cuts
 *     them over — until then, your vault password is what the OAuth flow
 *     sees, while `set-password` seeds the hub-side user that PR (c) will
 *     start validating against.
 *   - `list-users` — show accounts in `users`.
 *
 * Vault-forwarded subcommands (still implemented in `parachute-vault`):
 *   - `2fa` — TOTP enroll/disable/backup-codes.
 */

import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { approveClient, getClient, listClientsByStatus } from "../clients.ts";
import { CONFIG_DIR } from "../config.ts";
import { readExposeState } from "../expose-state.ts";
import { listGrantsForUser, revokeGrant } from "../grants.ts";
import { HUB_DEFAULT_PORT, readHubPort } from "../hub-control.ts";
import { openHubDb } from "../hub-db.ts";
import { deriveHubOrigin } from "../hub-origin.ts";
import { inferAudience } from "../jwt-audience.ts";
import {
  findTokenRowByJti,
  recordTokenMint,
  revokeTokenByJti,
  signAccessToken,
  tokenRowIdentity,
} from "../jwt-sign.ts";
import {
  OPERATOR_TOKEN_CLIENT_ID,
  OPERATOR_TOKEN_SCOPE_SET_NAMES,
  type OperatorScopeSet,
  OperatorTokenExpiredError,
  isOperatorScopeSet,
  issueOperatorToken,
  useOperatorTokenWithAutoRotate,
} from "../operator-token.ts";
import { isNonRequestableScope } from "../scope-explanations.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import {
  SingleUserModeError,
  UsernameTakenError,
  createUser,
  getUserByUsername,
  listUsers,
  setPassword,
  userCount,
} from "../users.ts";

export interface Runner {
  run(cmd: readonly string[]): Promise<number>;
}

export const defaultRunner: Runner = {
  async run(cmd) {
    const proc = Bun.spawn([...cmd], { stdio: ["inherit", "inherit", "inherit"] });
    return await proc.exited;
  },
};

const VAULT_FORWARDED_SUBCOMMANDS = new Set(["2fa"]);
const HUB_LOCAL_SUBCOMMANDS = new Set([
  "rotate-key",
  "set-password",
  "list-users",
  "rotate-operator",
  "mint-token",
  "revoke-token",
  "pending-clients",
  "approve-client",
  "list-grants",
  "revoke-grant",
]);

export function authHelp(): string {
  return `parachute auth — ecosystem identity commands (password + two-factor authentication)

Usage:
  parachute auth set-password [--username <name>] [--password <pw>] [--allow-multi]
                                       Create or update the hub user's password
  parachute auth list-users            Show registered hub accounts
  parachute auth 2fa status            Show 2FA state
  parachute auth 2fa enroll            Enable TOTP 2FA (QR + backup codes)
  parachute auth 2fa disable           Disable 2FA (requires password)
  parachute auth 2fa backup-codes      Regenerate backup codes
  parachute auth rotate-key            Rotate the hub's JWT signing key
  parachute auth rotate-operator [--scope-set <set>]
                                       Mint a fresh ~/.parachute/operator.token
                                       (set = install|start|expose|auth|vault|admin,
                                       default admin)
  parachute auth mint-token --scope <scope> [--aud <aud>] [--expires-in <seconds>]
                                            [--sub <sub>] [--permissions <json>]
                                       Mint a scope-narrow JWT against the
                                       operator's identity (stdout = JWT).
                                       --ttl <duration> is the deprecated
                                       alias (use --expires-in seconds).
  parachute auth revoke-token <jti>    Mark a registry-row token revoked
                                       by jti. Idempotent: a re-revoke
                                       prints the existing revoked_at and
                                       exits 0.
  parachute auth pending-clients       List OAuth clients awaiting approval
  parachute auth approve-client <id>   Approve a pending OAuth client
  parachute auth list-grants [--username <name>]
                                       Show OAuth scope grants on record
  parachute auth revoke-grant <client_id> [--username <name>]
                                       Forget a granted scope-set so the next
                                       OAuth flow re-prompts for consent

set-password and list-users are hub-local — they read/write
~/.parachute/hub.db. set-password is interactive by default (prompts for
the password twice with hidden input). For scripted use, pass
\`--password <pw>\` and (for first-run setup) \`--username <name>\`.

The default username on first run is "owner" — override with --username.
Single-user mode is the default; pass --allow-multi to add additional
accounts beyond the first.

2fa forwards to \`parachute-vault\` which still implements TOTP storage. If
you see "not found on PATH", install vault first:

  parachute install vault

rotate-key generates a fresh RSA-2048 keypair and retires the previous
one. The retired key keeps appearing in /.well-known/jwks.json for 24
hours so cached client copies keep validating until their TTL expires.

rotate-operator mints a fresh long-lived operator token at
~/.parachute/operator.token (mode 0600). Local CLI tools read this file
as their bearer when calling on-box services. set-password also writes
the file on first-run / password reset. Default lifetime is 90d (was
365d through 0.5.7); CLI flows that read the token within 7d of expiry
auto-rotate it in place, so weekly users never see an expiry surprise.

--scope-set chooses how broad the new token is:
  install  — install/upgrade modules (vault:read for new-vault discovery)
  start    — lifecycle modules (start/stop/restart/status)
  expose   — bring tailnet / public exposure layers up and down
  auth     — mint hub-issued tokens, manage user accounts
  vault    — administer vaults (create / configure / delete)
  admin    — superset of all above; pre-#213 default and current default

Phase 1 of #213 ships the vocabulary + flag; Phase 2 (separate follow-up)
wires per-command enforcement so an \`install\`-only token can't, say, run
\`parachute expose public\`. Until then, --scope-set is a tool the cautious
operator can opt into without breaking anyone.

mint-token issues a single scope-narrow JWT against the operator's
identity, signed with the same key as OAuth-issued tokens. Pipeable:
\`parachute auth mint-token --scope scribe:transcribe | pbcopy\`. The
audience defaults via the same inference rule the OAuth flow uses
(named \`vault:<name>:<verb>\` → \`vault.<name>\`, otherwise the first
colon-prefixed scope's namespace, fallback \`hub\`). Lifetime defaults
to 90d, caps at 365d.

--scope accepts space-separated multi-scope (e.g.
\`--scope "vault:default:read agent:wovenboulder:invoke"\`).

--expires-in is the canonical lifetime flag — integer seconds (e.g.
\`--expires-in 86400\` for 1 day). The legacy \`--ttl\` flag accepts a
duration suffix (\`90d\` / \`24h\` / \`30m\` / \`60s\`) and is supported as
a deprecated alias; passing it emits a one-line stderr deprecation
notice. \`--ttl\` will be removed in 0.6.0.

--permissions accepts a JSON object encoding fine-grained constraints
beyond OAuth scope (e.g.
\`--permissions '{"vault":{"default":{"write_tags":["health"]}}}'\`).
Carried in the JWT as the \`permissions\` claim per the convergence
section of the auth-architecture research doc.

Every mint writes a row to the hub's token registry (one source of
truth for revocation, admin UI introspection). Requires a valid
~/.parachute/operator.token (run \`parachute auth set-password\` or
\`rotate-operator\` first).

revoke-token flips \`revoked_at\` on a registry row by jti. The
revocation list endpoint
(\`/.well-known/parachute-revocation.json\`) picks the change up on
its next 60s poll; resource servers (vault / scribe / agent) on
scope-guard 0.2.0+ then reject the JWT. Idempotent: re-revoking an
already-revoked jti prints the existing revoked_at and exits 0.
Requires \`parachute:host:auth\` on the operator token (the \`auth\`
or \`admin\` scope-set).

pending-clients + approve-client gate /oauth/register against operator
approval (closes #74). Self-served DCR registrations land as 'pending'
and cannot OAuth until you run \`parachute auth approve-client <id>\`.
First-party install flows that present \`Authorization: Bearer
<operator-token>\` with \`hub:admin\` scope land as 'approved' immediately.

list-grants + revoke-grant manage the OAuth consent skip-list (closes
#75). When you approve a scope-set on the consent screen, the hub
records it so re-running the same flow goes straight to the auth-code
redirect — no second consent prompt for scopes you've already approved.
revoke-grant deletes the row so the next flow shows consent again.
Existing access tokens are NOT touched by revoke-grant; use
\`/oauth/revoke\` (or wait for them to expire) to terminate live sessions.
`;
}

export interface AuthDeps {
  runner?: Runner;
  rotateKey?: () => { kid: string; createdAt: string };
  /** Read a hidden password from the terminal. Tests inject a fixed answer. */
  readPassword?: (prompt: string) => Promise<string>;
  /** Read a non-hidden line — username, confirmations, etc. */
  readLine?: (prompt: string) => Promise<string>;
  /** Whether stdin+stdout are a TTY. Tests force false. */
  isInteractive?: () => boolean;
  /** Override the hub-db path. Tests point at a tmp dir. */
  dbPath?: string;
  /**
   * Override the directory where `operator.token` is written. Defaults to
   * `configDir()` (i.e. `~/.parachute/`). Tests point at a tmp dir.
   */
  configDir?: string;
  /**
   * Override the hub origin written into the operator token's `iss` claim.
   * When unset, derived from `expose-state.json` → hub.port → canonical
   * `http://127.0.0.1:1939`, mirroring the resolution `parachute start` uses
   * for `PARACHUTE_HUB_ORIGIN` so the token's iss matches what services see.
   */
  hubOrigin?: string;
}

/**
 * Resolve the hub origin used as `iss` for operator tokens. Mirrors
 * lifecycle.resolveHubOrigin's order, but falls back to the canonical
 * loopback (`http://127.0.0.1:1939`) instead of `undefined` — operator
 * tokens MUST carry an issuer, and on first-run before any expose has
 * happened the canonical loopback is what services will validate against.
 */
function resolveHubIssuer(override: string | undefined, configDir: string): string {
  if (override) {
    const fromOverride = deriveHubOrigin({ override });
    if (fromOverride) return fromOverride;
  }
  const state = readExposeState(join(configDir, "expose-state.json"));
  if (state?.hubOrigin) return state.hubOrigin;
  const exposeFqdn = state?.canonicalFqdn;
  return (
    deriveHubOrigin({ exposeFqdn, hubPort: readHubPort(configDir) }) ??
    `http://127.0.0.1:${HUB_DEFAULT_PORT}`
  );
}

function defaultRotateKey(): { kid: string; createdAt: string } {
  const db = openHubDb();
  try {
    const k = rotateSigningKey(db);
    return { kid: k.kid, createdAt: k.createdAt };
  } finally {
    db.close();
  }
}

/**
 * Hidden-input password read using stdin raw mode. Hand-rolled rather than
 * pulling in a prompt library — the surface is small (Enter/Backspace/Ctrl-C)
 * and adding a transitive dep just to hide echo is overkill.
 */
async function defaultReadPassword(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    let buf = "";
    const teardown = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };
    const onData = (chunk: Buffer) => {
      const ch = chunk.toString("utf8");
      for (const c of ch) {
        if (c === "\n" || c === "\r" || c === "\u0004") {
          teardown();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          teardown();
          process.stdout.write("\n");
          reject(new Error("interrupted"));
          return;
        }
        if (c === "\u007f" || c === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function defaultReadLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function defaultIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

interface ParsedFlags {
  username?: string;
  password?: string;
  allowMulti: boolean;
  error?: string;
}

function parseSetPasswordFlags(args: readonly string[]): ParsedFlags {
  let username: string | undefined;
  let password: string | undefined;
  let allowMulti = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--username") {
      const v = args[++i];
      if (!v) return { allowMulti, error: "--username requires a value" };
      username = v;
    } else if (a?.startsWith("--username=")) {
      username = a.slice("--username=".length);
      if (!username) return { allowMulti, error: "--username requires a value" };
    } else if (a === "--password") {
      const v = args[++i];
      if (!v) return { allowMulti, error: "--password requires a value" };
      password = v;
    } else if (a?.startsWith("--password=")) {
      password = a.slice("--password=".length);
      if (!password) return { allowMulti, error: "--password requires a value" };
    } else if (a === "--allow-multi") {
      allowMulti = true;
    } else {
      return { allowMulti, error: `unknown flag "${a}"` };
    }
  }
  return { username, password, allowMulti };
}

async function runSetPassword(args: readonly string[], deps: AuthDeps): Promise<number> {
  const flags = parseSetPasswordFlags(args);
  if (flags.error) {
    console.error(`parachute auth set-password: ${flags.error}`);
    return 1;
  }
  const isInteractive = (deps.isInteractive ?? defaultIsInteractive)();
  const readPassword = deps.readPassword ?? defaultReadPassword;
  const readLine = deps.readLine ?? defaultReadLine;

  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const existing = listUsers(db);
    const existingUser = existing[0];
    const targetUsername = flags.username ?? existingUser?.username ?? "owner";

    let password = flags.password;
    if (!password) {
      if (!isInteractive) {
        console.error(
          "parachute auth set-password: --password is required when stdin is not a TTY",
        );
        return 1;
      }
      const p1 = await readPassword(`Password for "${targetUsername}": `);
      if (p1.length === 0) {
        console.error("password cannot be empty");
        return 1;
      }
      const p2 = await readPassword("Confirm password: ");
      if (p1 !== p2) {
        console.error("passwords did not match");
        return 1;
      }
      password = p1;
    }

    if (existingUser) {
      // Update path. If --username supplied AND it doesn't match, that's
      // ambiguous: are they renaming or addressing a new user? In single-user
      // mode we refuse rather than guessing.
      if (flags.username && flags.username !== existingUser.username && !flags.allowMulti) {
        console.error(
          `a user named "${existingUser.username}" already exists. To create another, pass --allow-multi.`,
        );
        return 1;
      }
      const target =
        flags.username && flags.username !== existingUser.username && flags.allowMulti
          ? null
          : existingUser;
      if (target) {
        await setPassword(db, target.id, password);
        console.log(`Updated password for "${target.username}".`);
        const issued = await issueOperatorToken(db, target.id, {
          dir: deps.configDir,
          issuer: resolveHubIssuer(deps.hubOrigin, deps.configDir ?? CONFIG_DIR),
        });
        console.log(`Refreshed operator token at ${issued.path}.`);
        return 0;
      }
    }

    // Create path (no user exists yet, or --allow-multi for an additional one).
    if (existing.length > 0 && !flags.allowMulti) {
      // Should be unreachable given the existingUser branch above, but keep
      // the explicit guard so a future refactor can't quietly drop it.
      console.error("a user already exists; pass --allow-multi to create another");
      return 1;
    }

    // For first-run interactive without an explicit --username, confirm.
    if (existing.length === 0 && !flags.username && isInteractive) {
      const answer = (await readLine(`Create the first hub user named "owner"? [Y/n] `)).trim();
      if (answer.length > 0 && !/^y(es)?$/i.test(answer)) {
        console.error("aborted; pass --username <name> to choose a different name");
        return 1;
      }
    }

    try {
      const u = await createUser(db, targetUsername, password, { allowMulti: flags.allowMulti });
      console.log(`Created hub user "${u.username}" (id=${u.id}).`);
      const issued = await issueOperatorToken(db, u.id, {
        dir: deps.configDir,
        issuer: resolveHubIssuer(deps.hubOrigin, deps.configDir ?? CONFIG_DIR),
      });
      console.log(`Wrote operator token to ${issued.path} (mode 0600).`);
      return 0;
    } catch (err) {
      if (err instanceof SingleUserModeError) {
        console.error(err.message);
        return 1;
      }
      if (err instanceof UsernameTakenError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

interface RotateOperatorFlags {
  scopeSet?: OperatorScopeSet;
  error?: string;
}

function parseRotateOperatorFlags(args: readonly string[]): RotateOperatorFlags {
  let scopeSet: OperatorScopeSet | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--scope-set") {
      const v = args[++i];
      if (!v) return { error: "--scope-set requires a value" };
      if (!isOperatorScopeSet(v)) {
        return {
          error: `--scope-set must be one of ${OPERATOR_TOKEN_SCOPE_SET_NAMES.join("|")}, got "${v}"`,
        };
      }
      scopeSet = v;
    } else if (a?.startsWith("--scope-set=")) {
      const v = a.slice("--scope-set=".length);
      if (!v) return { error: "--scope-set requires a value" };
      if (!isOperatorScopeSet(v)) {
        return {
          error: `--scope-set must be one of ${OPERATOR_TOKEN_SCOPE_SET_NAMES.join("|")}, got "${v}"`,
        };
      }
      scopeSet = v;
    } else {
      return { error: `unknown flag "${a}"` };
    }
  }
  return scopeSet !== undefined ? { scopeSet } : {};
}

async function runRotateOperator(args: readonly string[], deps: AuthDeps): Promise<number> {
  const flags = parseRotateOperatorFlags(args);
  if (flags.error) {
    console.error(`parachute auth rotate-operator: ${flags.error}`);
    return 1;
  }
  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const users = listUsers(db);
    const owner = users[0];
    if (!owner) {
      console.error(
        "no hub users yet — run `parachute auth set-password` to create the first one before issuing an operator token",
      );
      return 1;
    }
    const issued = await issueOperatorToken(db, owner.id, {
      dir: deps.configDir,
      issuer: resolveHubIssuer(deps.hubOrigin, deps.configDir ?? CONFIG_DIR),
      ...(flags.scopeSet !== undefined ? { scopeSet: flags.scopeSet } : {}),
    });
    console.log("Rotated operator token.");
    console.log(`  user:       ${owner.username}`);
    console.log(`  scope_set:  ${issued.scopeSet}`);
    console.log(`  path:       ${issued.path}`);
    console.log(`  expires_at: ${issued.expiresAt}`);
    console.log(
      "Previous tokens stay valid until they expire — the hub does not revoke them. Treat operator.token like an SSH key.",
    );
    return 0;
  } finally {
    db.close();
  }
}

function runPendingClients(deps: AuthDeps): number {
  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const pending = listClientsByStatus(db, "pending");
    if (pending.length === 0) {
      console.log("(no pending OAuth clients)");
      return 0;
    }
    console.log("CLIENT_ID                              NAME                 REGISTERED");
    for (const c of pending) {
      const id = c.clientId.padEnd(36).slice(0, 36);
      const name = (c.clientName ?? "").padEnd(20).slice(0, 20);
      console.log(`${id}  ${name} ${c.registeredAt}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

function runApproveClient(args: readonly string[], deps: AuthDeps): number {
  const clientId = args[0];
  if (!clientId) {
    console.error("parachute auth approve-client: missing client_id argument");
    console.error("usage: parachute auth approve-client <client_id>");
    return 1;
  }
  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const ok = approveClient(db, clientId);
    if (!ok) {
      console.error(`no OAuth client registered with client_id "${clientId}"`);
      return 1;
    }
    console.log(`Approved OAuth client "${clientId}".`);
    return 0;
  } finally {
    db.close();
  }
}

interface UsernameFlag {
  username?: string;
  rest: string[];
  error?: string;
}

function extractUsernameFlag(args: readonly string[]): UsernameFlag {
  let username: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--username") {
      const v = args[++i];
      if (!v) return { rest, error: "--username requires a value" };
      username = v;
    } else if (a?.startsWith("--username=")) {
      username = a.slice("--username=".length);
      if (!username) return { rest, error: "--username requires a value" };
    } else if (a !== undefined) {
      rest.push(a);
    }
  }
  return { username, rest };
}

/**
 * Resolve the user a grant subcommand operates on. Default is "the only hub
 * user" (single-user mode); --username is required when multiple users exist.
 */
function resolveTargetUser(
  db: ReturnType<typeof openHubDb>,
  flagUsername: string | undefined,
  cmd: string,
): { id: string; username: string } | { error: string } {
  if (flagUsername) {
    const u = getUserByUsername(db, flagUsername);
    if (!u) return { error: `no hub user named "${flagUsername}"` };
    return { id: u.id, username: u.username };
  }
  const users = listUsers(db);
  if (users.length === 0)
    return { error: "no hub users yet — run `parachute auth set-password` first" };
  if (users.length > 1) {
    return {
      error: `multiple hub users exist; pass --username <name> to ${cmd} a specific user's grant`,
    };
  }
  const only = users[0]!;
  return { id: only.id, username: only.username };
}

function runListGrants(args: readonly string[], deps: AuthDeps): number {
  const flag = extractUsernameFlag(args);
  if (flag.error) {
    console.error(`parachute auth list-grants: ${flag.error}`);
    return 1;
  }
  if (flag.rest.length > 0) {
    console.error(`parachute auth list-grants: unexpected argument "${flag.rest[0]}"`);
    console.error("usage: parachute auth list-grants [--username <name>]");
    return 1;
  }
  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const target = resolveTargetUser(db, flag.username, "list");
    if ("error" in target) {
      console.error(`parachute auth list-grants: ${target.error}`);
      return 1;
    }
    const grants = listGrantsForUser(db, target.id);
    if (grants.length === 0) {
      console.log(`(no OAuth grants on record for "${target.username}")`);
      return 0;
    }
    console.log(`OAuth grants for "${target.username}":`);
    console.log(
      "CLIENT_ID                              NAME                 GRANTED_AT                SCOPES",
    );
    for (const g of grants) {
      const client = getClient(db, g.clientId);
      const id = g.clientId.padEnd(36).slice(0, 36);
      const name = (client?.clientName ?? "").padEnd(20).slice(0, 20);
      const at = g.grantedAt.padEnd(24).slice(0, 24);
      console.log(`${id}  ${name} ${at}  ${g.scopes.join(" ")}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

function runRevokeGrant(args: readonly string[], deps: AuthDeps): number {
  const flag = extractUsernameFlag(args);
  if (flag.error) {
    console.error(`parachute auth revoke-grant: ${flag.error}`);
    return 1;
  }
  const clientId = flag.rest[0];
  if (!clientId) {
    console.error("parachute auth revoke-grant: missing client_id argument");
    console.error("usage: parachute auth revoke-grant <client_id> [--username <name>]");
    return 1;
  }
  if (flag.rest.length > 1) {
    console.error(`parachute auth revoke-grant: unexpected argument "${flag.rest[1]}"`);
    return 1;
  }
  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const target = resolveTargetUser(db, flag.username, "revoke");
    if ("error" in target) {
      console.error(`parachute auth revoke-grant: ${target.error}`);
      return 1;
    }
    const removed = revokeGrant(db, target.id, clientId);
    if (!removed) {
      console.error(`no grant on record for "${target.username}" → "${clientId}"`);
      return 1;
    }
    console.log(`Revoked OAuth grant: "${target.username}" → "${clientId}".`);
    console.log(
      "Existing access tokens are unaffected — they expire on their own. The next /oauth/authorize for this client will re-prompt for consent.",
    );
    return 0;
  } finally {
    db.close();
  }
}

interface MintTokenFlags {
  scope?: string;
  aud?: string;
  ttl?: string;
  expiresIn?: string;
  sub?: string;
  permissions?: string;
  /** True when --ttl was used (deprecated alias). Triggers a one-line stderr warning. */
  ttlDeprecationSeen?: boolean;
  error?: string;
}

function parseMintTokenFlags(args: readonly string[]): MintTokenFlags {
  let scope: string | undefined;
  let aud: string | undefined;
  let ttl: string | undefined;
  let expiresIn: string | undefined;
  let sub: string | undefined;
  let permissions: string | undefined;
  let ttlDeprecationSeen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--scope") {
      const v = args[++i];
      if (!v) return { error: "--scope requires a value" };
      scope = v;
    } else if (a?.startsWith("--scope=")) {
      scope = a.slice("--scope=".length);
      if (!scope) return { error: "--scope requires a value" };
    } else if (a === "--aud") {
      const v = args[++i];
      if (!v) return { error: "--aud requires a value" };
      aud = v;
    } else if (a?.startsWith("--aud=")) {
      aud = a.slice("--aud=".length);
      if (!aud) return { error: "--aud requires a value" };
    } else if (a === "--ttl") {
      const v = args[++i];
      if (!v) return { error: "--ttl requires a value" };
      ttl = v;
      ttlDeprecationSeen = true;
    } else if (a?.startsWith("--ttl=")) {
      ttl = a.slice("--ttl=".length);
      if (!ttl) return { error: "--ttl requires a value" };
      ttlDeprecationSeen = true;
    } else if (a === "--expires-in") {
      const v = args[++i];
      if (!v) return { error: "--expires-in requires a value" };
      expiresIn = v;
    } else if (a?.startsWith("--expires-in=")) {
      expiresIn = a.slice("--expires-in=".length);
      if (!expiresIn) return { error: "--expires-in requires a value" };
    } else if (a === "--sub") {
      const v = args[++i];
      if (!v) return { error: "--sub requires a value" };
      sub = v;
    } else if (a?.startsWith("--sub=")) {
      sub = a.slice("--sub=".length);
      if (!sub) return { error: "--sub requires a value" };
    } else if (a === "--permissions") {
      const v = args[++i];
      if (!v) return { error: "--permissions requires a value" };
      permissions = v;
    } else if (a?.startsWith("--permissions=")) {
      permissions = a.slice("--permissions=".length);
      if (!permissions) return { error: "--permissions requires a value" };
    } else {
      return { error: `unknown flag "${a}"` };
    }
  }
  if (ttl !== undefined && expiresIn !== undefined) {
    return { error: "pass --expires-in OR --ttl, not both (--ttl is the deprecated alias)" };
  }
  return { scope, aud, ttl, expiresIn, sub, permissions, ttlDeprecationSeen };
}

const MINT_TOKEN_TTL_DEFAULT_SECONDS = 90 * 24 * 60 * 60;
const MINT_TOKEN_TTL_MAX_SECONDS = 365 * 24 * 60 * 60;

/**
 * Parse a Go-ish duration string: integer + one of d/h/m/s. Caps at 365d.
 * `90d` → 7776000. Used by the deprecated --ttl alias. The canonical
 * --expires-in flag takes a raw integer seconds value (per OAuth's
 * `expires_in` claim semantics — see `parseExpiresIn`).
 */
function parseTtl(input: string): { seconds: number } | { error: string } {
  const m = /^(\d+)(d|h|m|s)$/.exec(input);
  if (!m) return { error: `invalid --ttl "${input}" — expected e.g. 90d, 24h, 30m, 60s` };
  const n = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) return { error: `invalid --ttl "${input}" — must be > 0` };
  const unit = m[2]!;
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  const seconds = n * mult;
  if (seconds > MINT_TOKEN_TTL_MAX_SECONDS) {
    return { error: `--ttl "${input}" exceeds 365d cap` };
  }
  return { seconds };
}

/**
 * Parse the canonical --expires-in flag value as an integer seconds count.
 * Matches OAuth's `expires_in` claim semantics — the JWT `exp` is
 * `iat + expires_in`. Caps at 365d like the deprecated --ttl path.
 */
function parseExpiresIn(input: string): { seconds: number } | { error: string } {
  if (!/^\d+$/.test(input)) {
    return {
      error: `invalid --expires-in "${input}" — expected an integer seconds count (e.g. 86400 = 1 day)`,
    };
  }
  const seconds = Number.parseInt(input, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { error: `invalid --expires-in "${input}" — must be > 0` };
  }
  if (seconds > MINT_TOKEN_TTL_MAX_SECONDS) {
    return {
      error: `--expires-in "${input}" exceeds 365d cap (${MINT_TOKEN_TTL_MAX_SECONDS} seconds)`,
    };
  }
  return { seconds };
}

async function runMintToken(args: readonly string[], deps: AuthDeps): Promise<number> {
  const flags = parseMintTokenFlags(args);
  if (flags.error) {
    console.error(`parachute auth mint-token: ${flags.error}`);
    return 1;
  }
  if (!flags.scope) {
    console.error("parachute auth mint-token: --scope is required");
    console.error(
      "usage: parachute auth mint-token --scope <scope> [--aud <aud>] [--expires-in <seconds>] [--sub <sub>] [--permissions <json>]",
    );
    return 1;
  }

  const scopes = flags.scope.split(/\s+/).filter((s) => s.length > 0);
  if (scopes.length === 0) {
    console.error("parachute auth mint-token: --scope must contain at least one scope");
    return 1;
  }

  // Privilege-diffusion guard: mint paths cannot themselves mint tokens
  // carrying non-requestable scopes (parachute:host:admin, the host:*
  // narrow scopes, vault:<name>:admin). Holder of `parachute:host:auth`
  // can mint vault/scribe/agent verb scopes for downstream services, but
  // cannot mint another `:auth` (or any other non-requestable) without
  // forced re-auth via the operator.token rotation path. Same set the
  // public OAuth flow already rejects.
  const blocked = scopes.filter((s) => isNonRequestableScope(s));
  if (blocked.length > 0) {
    console.error(
      `parachute auth mint-token: scope ${blocked.join(", ")} is not requestable via mint-token; use OAuth flow or operator rotation`,
    );
    return 1;
  }

  let permissions: string | undefined;
  if (flags.permissions !== undefined) {
    try {
      // Parse to validate well-formedness — round-trip through JSON.stringify
      // so we hand the JWT a canonicalized payload (no operator-introduced
      // whitespace, no comments, no trailing commas).
      const parsed = JSON.parse(flags.permissions) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        console.error(
          'parachute auth mint-token: --permissions must be a JSON object (e.g. \'{"vault":{"default":{"write_tags":["health"]}}}\')',
        );
        return 1;
      }
      permissions = JSON.stringify(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`parachute auth mint-token: --permissions is not valid JSON — ${msg}`);
      return 1;
    }
  }

  let ttlSeconds = MINT_TOKEN_TTL_DEFAULT_SECONDS;
  if (flags.expiresIn) {
    const parsed = parseExpiresIn(flags.expiresIn);
    if ("error" in parsed) {
      console.error(`parachute auth mint-token: ${parsed.error}`);
      return 1;
    }
    ttlSeconds = parsed.seconds;
  } else if (flags.ttl) {
    const parsed = parseTtl(flags.ttl);
    if ("error" in parsed) {
      console.error(`parachute auth mint-token: ${parsed.error}`);
      return 1;
    }
    ttlSeconds = parsed.seconds;
  }
  if (flags.ttlDeprecationSeen) {
    console.error(
      "parachute auth mint-token: --ttl is deprecated; use --expires-in <seconds> instead (will be removed in 0.6.0)",
    );
  }

  const configDir = deps.configDir ?? CONFIG_DIR;
  const issuer = resolveHubIssuer(deps.hubOrigin, configDir);

  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    let used: Awaited<ReturnType<typeof useOperatorTokenWithAutoRotate>>;
    try {
      used = await useOperatorTokenWithAutoRotate(db, { configDir, issuer });
    } catch (err) {
      if (err instanceof OperatorTokenExpiredError) {
        console.error(`parachute auth mint-token: ${err.message}`);
        return 1;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`parachute auth mint-token: operator token invalid — ${msg}`);
      console.error(
        "run `parachute auth rotate-operator` to mint a fresh one, or check that the hub origin matches",
      );
      return 1;
    }
    if (!used) {
      console.error(
        "parachute auth mint-token: no operator token found at ~/.parachute/operator.token",
      );
      console.error(
        "run `parachute auth set-password` (first run) or `parachute auth rotate-operator` to mint one",
      );
      return 1;
    }
    if (used.rotated) {
      console.error(
        `parachute auth mint-token: operator token within 7d of expiry — auto-rotated to ${used.rotated.expiresAt} (scope_set=${used.rotated.scopeSet})`,
      );
    }
    const operatorSub = used.payload.sub;
    if (typeof operatorSub !== "string" || operatorSub.length === 0) {
      console.error("parachute auth mint-token: operator token has no sub claim");
      return 1;
    }
    // Scope gate: a valid signature + non-expired JWT at this path is not
    // sufficient — the token must carry operator-equivalent scope. Without
    // this, a narrowly-scoped JWT stashed at ~/.parachute/operator.token
    // would be treated as operator-bearer and mint arbitrary tokens
    // (privilege escalation: narrow → arbitrary). Only set-password and
    // rotate-operator legitimately write to this path; the `admin` scope-set
    // is the only one that carries `hub:admin`, so this gate also enforces
    // that scope-set narrowed tokens (install/start/expose/auth/vault) cannot
    // mint arbitrary follow-on JWTs via this path.
    const tokenScope =
      typeof used.payload.scope === "string"
        ? used.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
    if (!tokenScope.includes("hub:admin")) {
      console.error("parachute auth mint-token: operator token lacks hub:admin scope");
      console.error(
        "narrowed scope-sets (install/start/expose/auth/vault) can't mint follow-on tokens — run `parachute auth rotate-operator` to mint a fresh admin-set token",
      );
      return 1;
    }

    const audience = flags.aud ?? inferAudience(scopes);
    const subjectForMint = flags.sub ?? operatorSub;
    const permissionsClaim = permissions !== undefined ? JSON.parse(permissions) : undefined;

    const minted = await signAccessToken(db, {
      sub: subjectForMint,
      scopes,
      audience,
      clientId: OPERATOR_TOKEN_CLIENT_ID,
      issuer,
      ttlSeconds,
      ...(permissionsClaim !== undefined ? { extraClaims: { permissions: permissionsClaim } } : {}),
    });

    // Write a registry row (hub#212 Phase 1). Powers the revocation list
    // endpoint and admin UI introspection. Per design: CLI-mint rows have
    // user_id NULL; the subject column carries the chosen mint subject
    // (--sub overrides operator-sub). The JWT is its own access token,
    // not a refresh token, so refresh_token_hash + family_id stay NULL.
    recordTokenMint(db, {
      jti: minted.jti,
      createdVia: "cli_mint",
      subject: subjectForMint,
      clientId: OPERATOR_TOKEN_CLIENT_ID,
      scopes,
      expiresAt: minted.expiresAt,
      ...(permissions !== undefined ? { permissions } : {}),
    });

    console.log(minted.token);
    return 0;
  } finally {
    db.close();
  }
}

async function runRevokeToken(args: readonly string[], deps: AuthDeps): Promise<number> {
  // Single positional: the jti. No flags. (If we grow flags later — say,
  // --reason for an audit string — they can join here without disrupting
  // the positional contract.)
  const positionals = args.filter((a) => !a.startsWith("--"));
  const flags = args.filter((a) => a.startsWith("--"));
  if (flags.length > 0) {
    console.error(
      `parachute auth revoke-token: unexpected flag "${flags[0]}" (this command takes a jti positional only)`,
    );
    return 1;
  }
  if (positionals.length === 0) {
    console.error("parachute auth revoke-token: missing jti argument");
    console.error("usage: parachute auth revoke-token <jti>");
    return 1;
  }
  if (positionals.length > 1) {
    console.error(
      `parachute auth revoke-token: unexpected argument "${positionals[1]}" (only one jti at a time)`,
    );
    return 1;
  }
  const jti = positionals[0]!;

  const configDir = deps.configDir ?? CONFIG_DIR;
  const issuer = resolveHubIssuer(deps.hubOrigin, configDir);

  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    let used: Awaited<ReturnType<typeof useOperatorTokenWithAutoRotate>>;
    try {
      used = await useOperatorTokenWithAutoRotate(db, { configDir, issuer });
    } catch (err) {
      if (err instanceof OperatorTokenExpiredError) {
        console.error(`parachute auth revoke-token: ${err.message}`);
        return 1;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`parachute auth revoke-token: operator token invalid — ${msg}`);
      console.error(
        "run `parachute auth rotate-operator` to mint a fresh one, or check that the hub origin matches",
      );
      return 1;
    }
    if (!used) {
      console.error(
        "parachute auth revoke-token: no operator token found at ~/.parachute/operator.token",
      );
      console.error(
        "run `parachute auth set-password` (first run) or `parachute auth rotate-operator` to mint one",
      );
      return 1;
    }
    if (used.rotated) {
      console.error(
        `parachute auth revoke-token: operator token within 7d of expiry — auto-rotated to ${used.rotated.expiresAt} (scope_set=${used.rotated.scopeSet})`,
      );
    }
    // Scope gate: same as the HTTP /api/auth/revoke-token endpoint will use
    // (and the same as /api/auth/mint-token uses today). Mirrors the
    // privilege-shape of mint — both surfaces hand the operator power that
    // a narrow non-auth scope-set token shouldn't carry. The `auth`
    // scope-set covers this; so does `admin` (superset).
    const tokenScope =
      typeof used.payload.scope === "string"
        ? used.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
    if (!tokenScope.includes("parachute:host:auth")) {
      console.error("parachute auth revoke-token: operator token lacks parachute:host:auth scope");
      console.error(
        "narrowed scope-sets without `auth` (install/start/expose/vault) can't revoke tokens — run `parachute auth rotate-operator --scope-set auth` (or `admin`) for a token that can",
      );
      return 1;
    }

    const row = findTokenRowByJti(db, jti);
    if (!row) {
      console.error(`parachute auth revoke-token: no token with jti ${jti} found in registry`);
      return 1;
    }
    if (row.revokedAt) {
      // Idempotent re-revoke. Surface the existing timestamp so an operator
      // who's not sure whether the previous attempt landed gets a clear
      // confirmation it did.
      console.log(`already revoked at ${row.revokedAt}: jti=${jti}`);
      return 0;
    }
    const ok = revokeTokenByJti(db, jti, new Date());
    if (!ok) {
      // Race: row existed, then disappeared or got revoked between our
      // lookups. Surface as not-found rather than silently succeeding —
      // the operator should know nothing changed under their hand.
      console.error(
        `parachute auth revoke-token: jti ${jti} could not be revoked (race or concurrent change)`,
      );
      return 1;
    }
    // Use the canonical `tokenRowIdentity` helper rather than reading
    // userId/subject inline. The label is `identity=` (not `subject=`)
    // because for OAuth-issued rows `userId` is the user UUID and the
    // `subject` column is NULL; calling that field "subject" in the
    // output would mislabel the UUID for any operator grepping on it.
    // `identity=` matches what the helper returns regardless of row type.
    console.log(
      `revoked: jti=${jti}, identity=${tokenRowIdentity(row)}, scope=${row.scopes.join(" ") || "(none)"}`,
    );
    return 0;
  } finally {
    db.close();
  }
}

function runListUsers(deps: AuthDeps): number {
  const db = deps.dbPath ? openHubDb(deps.dbPath) : openHubDb();
  try {
    const users = listUsers(db);
    if (users.length === 0) {
      console.log("(no hub users yet — run `parachute auth set-password` to create the first one)");
      return 0;
    }
    console.log("USERNAME           ID                                    CREATED");
    for (const u of users) {
      const username = u.username.padEnd(18).slice(0, 18);
      const id = u.id.padEnd(36).slice(0, 36);
      console.log(`${username} ${id}  ${u.createdAt}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function auth(args: readonly string[], deps: AuthDeps | Runner = {}): Promise<number> {
  // Back-compat shim: callers used to pass a Runner directly. Detect that
  // shape (a `run` method) and lift it into the new deps bag.
  const normalized: AuthDeps =
    typeof (deps as Runner).run === "function" ? { runner: deps as Runner } : (deps as AuthDeps);
  const runner = normalized.runner ?? defaultRunner;
  const rotateKey = normalized.rotateKey ?? defaultRotateKey;

  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(authHelp());
    return 0;
  }

  if (HUB_LOCAL_SUBCOMMANDS.has(sub)) {
    if (sub === "rotate-key") {
      try {
        const { kid, createdAt } = rotateKey();
        console.log("Rotated hub signing key.");
        console.log(`  kid:        ${kid}`);
        console.log(`  created_at: ${createdAt}`);
        console.log("Previous key keeps validating tokens for 24h via /.well-known/jwks.json.");
        return 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth rotate-key: ${msg}`);
        return 1;
      }
    }
    if (sub === "set-password") {
      try {
        return await runSetPassword(args.slice(1), normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth set-password: ${msg}`);
        return 1;
      }
    }
    if (sub === "list-users") {
      return runListUsers(normalized);
    }
    if (sub === "rotate-operator") {
      try {
        return await runRotateOperator(args.slice(1), normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth rotate-operator: ${msg}`);
        return 1;
      }
    }
    if (sub === "mint-token") {
      try {
        return await runMintToken(args.slice(1), normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth mint-token: ${msg}`);
        return 1;
      }
    }
    if (sub === "revoke-token") {
      try {
        return await runRevokeToken(args.slice(1), normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth revoke-token: ${msg}`);
        return 1;
      }
    }
    if (sub === "pending-clients") {
      try {
        return runPendingClients(normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth pending-clients: ${msg}`);
        return 1;
      }
    }
    if (sub === "approve-client") {
      try {
        return runApproveClient(args.slice(1), normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth approve-client: ${msg}`);
        return 1;
      }
    }
    if (sub === "list-grants") {
      try {
        return runListGrants(args.slice(1), normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth list-grants: ${msg}`);
        return 1;
      }
    }
    if (sub === "revoke-grant") {
      try {
        return runRevokeGrant(args.slice(1), normalized);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`parachute auth revoke-grant: ${msg}`);
        return 1;
      }
    }
  }

  if (!VAULT_FORWARDED_SUBCOMMANDS.has(sub)) {
    console.error(`parachute auth: unknown subcommand "${sub}"`);
    console.error("run `parachute auth --help` for usage");
    return 1;
  }
  try {
    return await runner.run(["parachute-vault", ...args]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("enoent") || msg.toLowerCase().includes("not found")) {
      console.error("parachute-vault not found on PATH.");
      console.error("Install it with: parachute install vault");
      return 127;
    }
    console.error(`failed to run parachute-vault: ${msg}`);
    return 1;
  }
}

// Re-exported so `users.ts` consumers can preserve the named-export.
export { getUserByUsername };
