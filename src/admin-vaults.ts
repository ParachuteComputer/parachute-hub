/**
 * `POST /vaults` — provision a new vault on the host.
 * `DELETE /vaults/<name>` — destroy a vault WITH the identity cascade
 * (B1, 2026-06-09 hub-module-boundary migration — see `handleDeleteVault`).
 *
 * The hub's first authenticated, mutating endpoint. Until now the hub has
 * been a pure issuer; Phase 1 of the vault-config-and-scopes design (D1)
 * lifts vault provisioning into a hub UI surface so parachute-agent / hub-admin
 * pages can mint a vault without shelling out to a terminal.
 *
 * Wire shape:
 *   POST /vaults
 *   Authorization: Bearer <jwt with parachute:host:admin>
 *   Content-Type: application/json
 *   { "name": "<vault-name>" }
 *
 *   201 → { name, url, version, token?, token_guidance?, paths? }
 *           // vault freshly created. `token` is a hub-issued ACCESS token
 *           // (a JWT scoped `vault:<name>:admin`) captured from the
 *           // `parachute-vault create --json` branch — NOT a `pvt_*` vault
 *           // token (those were dropped). Post-DROP `token` may be the
 *           // empty string `""` when the bootstrap mint was unavailable
 *           // (e.g. a loopback origin the hub can't mint against); in that
 *           // case `token_guidance` carries the vault's human-readable
 *           // reason, forwarded verbatim so the SPA can explain the gap.
 *           // `paths` is the new vault's filesystem layout. The
 *           // first-vault-on-host bootstrap (`parachute install vault`)
 *           // doesn't emit JSON yet, so a fresh-box response carries
 *           // name/url/version only.
 *   200 → { name, url, version }
 *           // idempotent re-POST: existing vault. Never includes `token` —
 *           // the create-time access token isn't retrievable later. The
 *           // caller branches on HTTP status (201 vs 200), not on `token`
 *           // truthiness, so an empty-token 201 isn't confused with a 200.
 *   400 → { error: "invalid_request", error_description: ... }
 *   401/403 → bearer-auth failure
 *   500 → orchestration failure
 *
 * Orchestration:
 *   - If `parachute-vault` is NOT yet registered in services.json: shell
 *     out to `parachute install vault` (covers the bootstrap case for a
 *     fresh host; runs `parachute-vault init` which creates the default
 *     vault).
 *   - If `parachute-vault` IS already registered: shell out to
 *     `parachute-vault create --json <name>` (subsequent vaults). Stdout
 *     is parsed for the bootstrap creds (name, token, paths).
 *
 * The CLI is the single source of truth for "how do you create a vault";
 * we don't reimplement DB+yaml+token writes here. Mirrors D1 in the design
 * doc: hub orchestrates the CLI, doesn't replace it.
 *
 * Idempotency: name validation matches `parachute-vault create`'s rules
 * (regex + "list" reserved), with `new` and `assets` also reserved at
 * the hub edge for SPA-route shadowing. When a vault with the requested
 * name already exists,
 * we return 200 with the existing entry rather than re-running the CLI —
 * the CLI itself rejects an existing name with exit 1, but a re-POST is
 * usually a UI retry, not an error to the caller.
 */
import type { Database } from "bun:sqlite";
import { type AdminAuthError, adminAuthErrorResponse, requireScope } from "./admin-auth.ts";
import { type ConnectionsDeps, teardownConnection } from "./admin-connections.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { readConnections } from "./connections-store.ts";
import { rewriteGrantsRemovingVault } from "./grants.ts";
import { revokeInvitesForVault } from "./invites.ts";
import { revokeTokensNamingVault, signAccessToken } from "./jwt-sign.ts";
import { findService, type readManifest, readManifestLenient } from "./services-manifest.ts";
import { enrichedPath } from "./spawn-path.ts";
import { removeVaultAssignments } from "./users.ts";
import { RESERVED_VAULT_NAMES, VAULT_NAME_CHARSET_RE } from "./vault-name.ts";
import { type WellKnownVaultEntry, isVaultEntry, vaultInstanceNameFor } from "./well-known.ts";

/** Scope required to call POST /vaults. */
export const HOST_ADMIN_SCOPE = "parachute:host:admin";

// Lowercase-only (item I) — single source of truth in vault-name.ts. Vault's
// init enforces `[a-z0-9_-]`; a hub-side `[a-zA-Z0-9_-]` superset let an
// uppercased name through that vault would then lowercase or reject, drifting
// the hub's idea of the vault from vault's. The reserved set is the ONE
// consolidated `RESERVED_VAULT_NAMES` from vault-name.ts (B2h) — this file
// used to carry its own `{list, new, assets}` copy that drifted from the
// `{list}`-only set gating the wizard + invite redemption.
const VAULT_NAME_PATTERN = VAULT_NAME_CHARSET_RE;

export interface CreateVaultRequest {
  name: string;
}

/** Output shape of `parachute-vault create --json` (vault PR #184). */
export interface VaultCreateJson {
  name: string;
  /**
   * Hub-issued access token (a JWT scoped `vault:<name>:admin`) the vault
   * minted at create time. Post the pvt_* DROP this is the empty string
   * `""` when no hub origin was reachable to mint against (e.g. a loopback
   * create) — the field is always present but may be empty.
   */
  token: string;
  /**
   * Vault-supplied human-readable reason no token was minted, present only
   * when `token` is empty (e.g. "no hub origin reachable to mint against").
   * Optional — older vaults that always minted don't emit it. Forwarded
   * verbatim to the caller so the SPA can explain the empty-token state.
   */
  token_guidance?: string;
  paths: {
    vault_dir: string;
    vault_db: string;
    vault_config: string;
  };
  set_as_default: boolean;
}

/** Result of a single shell-out: exit code + captured stdout/stderr. */
export interface RunResult {
  exitCode: number;
  stdout: string;
  /**
   * Captured stderr. Always drained alongside stdout so a long-running
   * child can't deadlock on a full pipe buffer (#97). Surfaced in error
   * messages when exitCode != 0 so non-zero failures are diagnosable.
   */
  stderr: string;
}

export interface CreateVaultDeps {
  db: Database;
  /** Hub origin used to validate JWT `iss` and to build the response `url`. */
  issuer: string;
  /** Override the services.json path. Defaults to `~/.parachute/services.json`. */
  manifestPath?: string;
  /**
   * Test seam: run the orchestration command. Production spawns the real
   * `parachute install` / `parachute-vault create` binaries; tests stub it
   * to avoid touching the filesystem outside the temp dir. Stdout is
   * captured so the create branch can parse `parachute-vault create --json`.
   */
  runCommand?: (cmd: readonly string[]) => Promise<RunResult>;
}

interface ParseResult {
  ok: true;
  body: CreateVaultRequest;
}
interface ParseError {
  ok: false;
  status: number;
  message: string;
}

async function parseBody(req: Request): Promise<ParseResult | ParseError> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return { ok: false, status: 400, message: "Content-Type must be application/json" };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 400, message: `invalid JSON body: ${msg}` };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, status: 400, message: "request body must be a JSON object" };
  }
  const name = (raw as Record<string, unknown>).name;
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, status: 400, message: '"name" must be a non-empty string' };
  }
  if (!VAULT_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      status: 400,
      message: "vault name must contain only lowercase letters, numbers, hyphens, and underscores",
    };
  }
  if (RESERVED_VAULT_NAMES.has(name)) {
    return { ok: false, status: 400, message: `"${name}" is a reserved vault name` };
  }
  return { ok: true, body: { name } };
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Find an existing vault by name in services.json. Vaults live under one
 * `parachute-vault` service entry, which may carry a multi-path array (per
 * Q5 of the design — single entry, multi-path) or a per-vault `parachute-
 * vault-<name>` entry. Delegates name resolution to `vaultInstanceNameFor`
 * so well-known.ts, oauth-handlers.ts, and this lookup all agree (#143).
 */
function findExistingVault(
  manifestPath: string,
  name: string,
): { url: string; version: string; path: string } | null {
  let manifest: ReturnType<typeof readManifest>;
  try {
    // Lenient read — see hub#406.
    manifest = readManifestLenient(manifestPath);
  } catch {
    return null;
  }
  const target = `/vault/${name}`;
  for (const svc of manifest.services) {
    if (!isVaultEntry(svc)) continue;
    if (svc.paths.length === 0) {
      if (vaultInstanceNameFor(svc.name, undefined) === name) {
        return { url: target, version: svc.version, path: target };
      }
      continue;
    }
    for (const path of svc.paths) {
      if (vaultInstanceNameFor(svc.name, path) === name) {
        return { url: path, version: svc.version, path };
      }
    }
  }
  return null;
}

function buildEntry(
  name: string,
  path: string,
  version: string,
  issuer: string,
): WellKnownVaultEntry {
  const base = issuer.replace(/\/$/, "");
  const url = new URL(path, `${base}/`).toString();
  return { name, url, version };
}

async function defaultRunCommand(cmd: readonly string[]): Promise<RunResult> {
  // Inherit env so the child sees PATH, HOME, BUN_INSTALL, etc. Bun.spawn
  // defaults to empty env — see api-modules-ops.ts:defaultRun for the rationale.
  // PATH enrichment (hub launchd-PATH regression): a launchd-managed hub bakes
  // a minimal PATH, so this shell-out (vault ops) inherits that thin PATH too;
  // enrich it with operator-tool dirs (`$HOME/.local/bin`, brew bin). See
  // `spawn-path.ts`.
  const proc = Bun.spawn([...cmd], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: enrichedPath() },
  });
  // Drain both pipes in parallel — leaving stderr unread can deadlock long
  // installs once the OS pipe buffer fills (#97). Captured stderr is folded
  // into the orchestration error message on non-zero exit.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

interface OrchestrateOk {
  ok: true;
  /** Present only when create-with-json branch ran and parsed cleanly. */
  createJson: VaultCreateJson | null;
}
interface OrchestrateError {
  ok: false;
  status: number;
  message: string;
}

/**
 * Run the orchestration step. Picks `parachute install` (bootstrap) vs
 * `parachute-vault create --json` (subsequent) based on whether vault is
 * already registered in services.json. The create branch parses stdout for
 * the just-minted hub access token (a `vault:<name>:admin` JWT, possibly
 * empty post-DROP), the optional `token_guidance`, and filesystem paths so
 * the caller can talk to the new vault — the access token is single-emit.
 */
async function orchestrate(
  manifestPath: string,
  name: string,
  runCommand: (cmd: readonly string[]) => Promise<RunResult>,
  opts: { noMirror?: boolean } = {},
): Promise<OrchestrateOk | OrchestrateError> {
  const vaultRegistered = findService("parachute-vault", manifestPath) !== undefined;
  // `--no-mirror` opts this create out of the default internal live mirror
  // (§3 default_mirror knob). Only meaningful on the `create` branch — the
  // bootstrap `install` path provisions the default vault and follows the
  // server-wide knob.
  const cmd = vaultRegistered
    ? opts.noMirror
      ? ["parachute-vault", "create", name, "--json", "--no-mirror"]
      : ["parachute-vault", "create", name, "--json"]
    : ["parachute", "install", "vault"];
  let result: RunResult;
  try {
    result = await runCommand(cmd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, message: `orchestration failed: ${msg}` };
  }
  if (result.exitCode !== 0) {
    // Tail stderr (capped) so the error message names the actual failure
    // mode — "exited 1" alone is useless when the CLI prints why it failed
    // to stderr.
    const stderrTail = result.stderr.trim();
    const tailSuffix = stderrTail ? `: ${stderrTail.slice(-500)}` : "";
    return {
      ok: false,
      status: 500,
      message: `${cmd.join(" ")} exited with code ${result.exitCode}${tailSuffix}`,
    };
  }
  if (!vaultRegistered) {
    return { ok: true, createJson: null };
  }
  let createJson: VaultCreateJson;
  try {
    createJson = JSON.parse(result.stdout.trim()) as VaultCreateJson;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 500,
      message: `parachute-vault create --json returned unparseable stdout: ${msg}`,
    };
  }
  if (
    typeof createJson.name !== "string" ||
    typeof createJson.token !== "string" ||
    !createJson.paths
  ) {
    return {
      ok: false,
      status: 500,
      message: "parachute-vault create --json output missing required fields (name/token/paths)",
    };
  }
  return { ok: true, createJson };
}

/**
 * Result of {@link provisionVault} — the programmatic vault-provisioning
 * core shared by the authed HTTP handler and the invite-redeem path.
 *
 *   - `created: true`  — a fresh vault was provisioned this call. `entry`
 *     describes it; `createJson` (when present) carries the single-emit
 *     bootstrap creds.
 *   - `created: false` — the vault already existed (idempotent). `entry`
 *     describes the existing vault; no `createJson`.
 */
export type ProvisionVaultResult =
  | {
      ok: true;
      created: boolean;
      entry: WellKnownVaultEntry;
      createJson: VaultCreateJson | null;
    }
  | { ok: false; status: number; message: string };

/**
 * Provision (or no-op if it exists) a vault by name — the auth-free core
 * lifted out of {@link handleCreateVault} so the invite-redeem flow can
 * provision a vault for a freshly-created account WITHOUT a host:admin
 * bearer (the redeemer holds no admin authority; the invite IS the
 * authorization). The HTTP handler keeps the host:admin gate in front of
 * this; the invite path calls it directly after validating the invite.
 *
 * Idempotent-safe: if the vault already exists this returns
 * `created:false` with the existing entry rather than re-running the CLI —
 * a redeem retry (or a name collision) lands the user on the existing
 * vault instead of erroring.
 *
 * Name validation matches `parachute-vault create`'s rules. Callers that
 * accept an untrusted name (the invite redeemer naming their own vault)
 * MUST pass it through here so the same regex + reserved-name gate the
 * `/vaults` API edge enforces applies.
 */
export async function provisionVault(
  name: string,
  deps: {
    issuer: string;
    manifestPath?: string;
    runCommand?: CreateVaultDeps["runCommand"];
    /** `'off'` appends `--no-mirror`; anything else follows the server knob. */
    defaultMirror?: string;
  },
): Promise<ProvisionVaultResult> {
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const runCommand = deps.runCommand ?? defaultRunCommand;

  if (!VAULT_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      status: 400,
      message: "vault name must contain only lowercase letters, numbers, hyphens, and underscores",
    };
  }
  if (RESERVED_VAULT_NAMES.has(name)) {
    return { ok: false, status: 400, message: `"${name}" is a reserved vault name` };
  }

  // Idempotency: if the vault already exists, return the existing entry.
  const existing = findExistingVault(manifestPath, name);
  if (existing) {
    return {
      ok: true,
      created: false,
      entry: buildEntry(name, existing.path, existing.version, deps.issuer),
      createJson: null,
    };
  }

  const result = await orchestrate(manifestPath, name, runCommand, {
    noMirror: deps.defaultMirror === "off",
  });
  if (!result.ok) {
    return { ok: false, status: result.status, message: result.message };
  }

  // Re-read services.json: the CLI just wrote it.
  const created = findExistingVault(manifestPath, name);
  if (!created) {
    return {
      ok: false,
      status: 500,
      message: `vault "${name}" was provisioned but is not in services.json — manual recovery required`,
    };
  }
  return {
    ok: true,
    created: true,
    entry: buildEntry(name, created.path, created.version, deps.issuer),
    createJson: result.createJson,
  };
}

export async function handleCreateVault(req: Request, deps: CreateVaultDeps): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const runCommand = deps.runCommand ?? defaultRunCommand;

  // Auth gate: parachute:host:admin scope. Maps an AdminAuthError straight
  // to an RFC 6750 401/403 — the route handler doesn't care which.
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }

  const parsed = await parseBody(req);
  if (!parsed.ok) {
    return jsonError(parsed.status, "invalid_request", parsed.message);
  }
  const { name } = parsed.body;

  const provisioned = await provisionVault(name, {
    issuer: deps.issuer,
    manifestPath,
    runCommand,
  });
  if (!provisioned.ok) {
    // parseBody already enforced the name regex/reserved gate, so a
    // provisionVault 400 here would be a redundant re-check; map any
    // non-ok to its status. invalid_request for 400, server_error otherwise.
    const error = provisioned.status === 400 ? "invalid_request" : "server_error";
    return jsonError(provisioned.status, error, provisioned.message);
  }

  // Idempotent re-POST: existing vault → 200, no single-emit creds.
  if (!provisioned.created) {
    return new Response(JSON.stringify(provisioned.entry), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const entry = provisioned.entry;
  const result = { createJson: provisioned.createJson };
  // Access token (a `vault:<name>:admin` JWT, possibly empty post-DROP) +
  // filesystem paths are single-emit at create time. We surface them here so
  // the caller can immediately bootstrap a connection to the new vault.
  // `token_guidance` (when the vault couldn't mint) is forwarded verbatim so
  // the SPA can explain the empty-token state rather than rendering a blank.
  // Idempotent re-POSTs intentionally never include any of these.
  const body: WellKnownVaultEntry & {
    token?: string;
    token_guidance?: string;
    paths?: VaultCreateJson["paths"];
  } = result.createJson
    ? {
        ...entry,
        token: result.createJson.token,
        ...(result.createJson.token_guidance
          ? { token_guidance: result.createJson.token_guidance }
          : {}),
        paths: result.createJson.paths,
      }
    : entry;

  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

// ===========================================================================
// DELETE /vaults/<name> — the identity cascade (B1, 2026-06-09
// hub-module-boundary migration: lifecycle symmetry)
// ===========================================================================
//
// "Every provision flow must have a deprovision flow that cascades the
// identity artifacts it created." Mechanics deletion without identity
// cascade is a security hole: before B1, vault deletion was CLI-only
// (`parachute-vault remove`) and left every hub-side identity artifact
// naming the vault alive — scoped tokens, grants, user assignments, pinned
// invites, connections. This handler enumerates the full artifact list and
// handles every entry.
//
// Documented bound: short-lived (≤10-min) unregistered interactive mints
// ride to expiry by design — the cascade revokes persisted registry rows
// and publishes the revocation list; it does not claim instant revocation
// of in-flight interactive JWTs.

/** Client id stamped on the short-lived channel-scan mint. */
const DELETE_VAULT_CLIENT_ID = "parachute-hub-spa";
/** TTL for the cascade's interactive provisioning mints (channel scan). */
const DELETE_VAULT_PROVISION_TTL_SECONDS = 60;

export interface DeleteVaultDeps {
  db: Database;
  /** Hub origin — JWT `iss` validation + cascade mint issuer. */
  issuer: string;
  /** Override the services.json path. Defaults to `~/.parachute/services.json`. */
  manifestPath?: string;
  /** Absolute path to `connections.json` in the hub state dir. */
  connectionsStorePath: string;
  /** Loopback origin for the channel daemon, or `null` when not installed. */
  channelOrigin: string | null;
  /** Resolve a vault's loopback origin from services.json (trigger teardown). */
  resolveVaultOrigin: (vaultName: string) => string | null;
  /** Test seam: run `parachute-vault remove` — same Runner seam as create. */
  runCommand?: CreateVaultDeps["runCommand"];
  /**
   * Supervisor-restart the vault module — the daemon-eviction cascade step.
   * The running daemon caches open store handles, so rmSync alone leaves the
   * deleted vault SERVING from the open fd; and vault's boot `selfRegister`
   * rebuilds services.json paths from `listVaults()`, dropping the deleted
   * path. Wired to the same supervisor machinery the lifecycle verbs use.
   * Absent (no supervisor — CLI-mode hub, tests) → recorded as a warning in
   * the response, not silently skipped. (The boundary-conformant per-daemon
   * store-eviction endpoint is tracked as E9.)
   */
  restartVaultModule?: () => Promise<void>;
  /** Test seam — `globalThis.fetch` in production. */
  fetchImpl?: typeof fetch;
  /** Test seam for the clock. */
  now?: () => Date;
}

interface DeleteVaultBody {
  confirm?: unknown;
}

/** Wire shape of the cascade summary in the 200/500 response. */
interface CascadeSummary {
  tokens_revoked: number;
  grants_rewritten: number;
  grants_dropped: number;
  user_vaults_removed: number;
  invites_invalidated: number;
  connections_torn_down: number;
  /**
   * Vault-backed channel-daemon entries still referencing the deleted vault
   * AFTER connection teardown (legacy pre-Connections wiring). Surfaced for
   * the operator — the hub does NOT silently delete channel's config; remove
   * them from channel's own UI.
   */
  orphaned_channels: string[];
  vault_removed: boolean;
  module_restarted: boolean;
}

function emptyCascadeSummary(): CascadeSummary {
  return {
    tokens_revoked: 0,
    grants_rewritten: 0,
    grants_dropped: 0,
    user_vaults_removed: 0,
    invites_invalidated: 0,
    connections_torn_down: 0,
    orphaned_channels: [],
    vault_removed: false,
    module_restarted: false,
  };
}

/** Every vault instance name currently registered in services.json. */
function listVaultInstanceNames(manifestPath: string): Set<string> {
  const names = new Set<string>();
  let manifest: ReturnType<typeof readManifest>;
  try {
    manifest = readManifestLenient(manifestPath);
  } catch {
    return names;
  }
  for (const svc of manifest.services) {
    if (!isVaultEntry(svc)) continue;
    if (svc.paths.length === 0) {
      names.add(vaultInstanceNameFor(svc.name, undefined));
      continue;
    }
    for (const path of svc.paths) names.add(vaultInstanceNameFor(svc.name, path));
  }
  return names;
}

/**
 * `DELETE /vaults/<name>` — destroy a vault with the full identity cascade.
 *
 * Gate: Bearer `parachute:host:admin` (same gate as create). Body MUST carry
 * `{"confirm": "<name>"}` — a deliberate retype-the-name guard against
 * fat-finger disasters (mismatch → 400).
 *
 * Refusals:
 *   - unknown vault → 404;
 *   - LAST remaining vault → 409. Vault's boot auto-creates `default` at
 *     zero vaults, so deleting the last one would silently resurrect a fresh
 *     `default` (with a fresh global API key) — refusing sidesteps the
 *     resurrection class entirely. The CLI (`parachute-vault remove`) is the
 *     escape hatch for an operator who really means it.
 *   - RESERVED names are deliberately ALLOWED (no reserved-name gate): a
 *     squatted `admin`/`new`/`assets` vault created before the B2h
 *     reservation must be removable through this endpoint.
 *
 * Cascade, in order (identity first, mechanics last — revocation is the safe
 * direction if a later step fails):
 *   1. tokens-registry sweep (exact scope-segment match — never SQL LIKE);
 *   2. grants rewrite (drop `vault:<name>:*` entries; drop the row only when
 *      it empties — a (user,client) grant can span multiple vaults);
 *   3. `user_vaults` rows;
 *   4. unredeemed invites pinned to the vault (redemption would resurrect
 *      the name);
 *   5. connections whose source/provisioned vault is the deleted vault
 *      (via `teardownConnection`, which post-B0 also revokes the registered
 *      long-lived mints) + a report-only scan of channel's `/api/channels`
 *      for legacy vault-backed entries (`orphaned_channels`);
 *   6. mechanics: shell to `parachute-vault remove <name> --yes` (the module
 *      CLI stays the single source of truth for vault destruction,
 *      mirroring create);
 *   7. daemon eviction: supervisor-restart the vault module (open
 *      store-handle eviction + `selfRegister` services.json path rebuild).
 *
 * Response: 200 with a structured per-step summary (counts +
 * `orphaned_channels` + warnings). A mechanics failure responds 500 with
 * the partial summary — the identity artifacts already revoked stay revoked.
 */
export async function handleDeleteVault(
  req: Request,
  rawName: string,
  deps: DeleteVaultDeps,
): Promise<Response> {
  if (req.method !== "DELETE") {
    return new Response("method not allowed", { status: 405 });
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const now = deps.now?.() ?? new Date();

  // Auth gate: parachute:host:admin — the same gate as POST /vaults.
  let adminSub: string;
  try {
    const auth = await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
    adminSub = auth.sub;
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }

  // Name shape guard. NOTE: no reserved-name check — see docstring.
  const name = rawName.trim();
  if (!VAULT_NAME_PATTERN.test(name)) {
    return jsonError(
      400,
      "invalid_request",
      "vault name must contain only lowercase letters, numbers, hyphens, and underscores",
    );
  }

  // Confirm body — the retype-the-name guard.
  let body: DeleteVaultBody;
  try {
    body = (await req.json()) as DeleteVaultBody;
  } catch {
    return jsonError(400, "confirm_mismatch", `body must be JSON: {"confirm": "${name}"}`);
  }
  if (!body || typeof body !== "object" || body.confirm !== name) {
    return jsonError(
      400,
      "confirm_mismatch",
      `deleting a vault requires the body {"confirm": "${name}"} (retype the vault name)`,
    );
  }

  // Existence.
  const existing = findExistingVault(manifestPath, name);
  if (!existing) {
    return jsonError(404, "not_found", `no vault named "${name}" on this hub`);
  }

  // Last-vault refusal (resurrection guard).
  const instanceNames = listVaultInstanceNames(manifestPath);
  instanceNames.delete(name);
  if (instanceNames.size === 0) {
    return jsonError(
      409,
      "last_vault",
      `"${name}" is the last vault on this hub. Vault's boot auto-creates "default" at zero vaults, so deleting the last one would silently resurrect it with fresh credentials. Create another vault first, or use the CLI (parachute-vault remove ${name} --yes) if you really mean to empty the hub.`,
    );
  }

  const summary = emptyCascadeSummary();
  const warnings: { step: string; detail: string }[] = [];

  // --- 1. Registry sweep: revoke every tokens row naming the vault. --------
  summary.tokens_revoked = revokeTokensNamingVault(deps.db, name, now);

  // NOTE on `auth_codes.scopes` — the one identity-artifact column from the
  // charter's enumeration deliberately NOT swept here. Authorization codes
  // are transient by construction: AUTH_CODE_TTL_SECONDS = 60 (auth-codes.ts)
  // and single-use. A code naming the deleted vault either (a) expires
  // unredeemed within the minute, or (b) redeems into tokens whose registry
  // rows the sweep above already governs — and whose requests the evicted
  // daemon no longer serves. Sweeping a 60-second-lived table adds a step
  // with no security delta; same class as the documented ≤10-min
  // unregistered interactive-mint bound.

  // --- 2. Grants rewrite (drop rows only when emptied). ---------------------
  const grants = rewriteGrantsRemovingVault(deps.db, name);
  summary.grants_rewritten = grants.rewritten;
  summary.grants_dropped = grants.dropped;

  // --- 3. user_vaults assignments. ------------------------------------------
  summary.user_vaults_removed = removeVaultAssignments(deps.db, name);

  // --- 4. Unredeemed invites pinned to the vault. ----------------------------
  summary.invites_invalidated = revokeInvitesForVault(deps.db, name, now);

  // --- 5. Connections teardown (+ legacy channel scan, report-only). --------
  // Runs BEFORE the CLI remove so the vault daemon is still alive to accept
  // the trigger-deregister calls.
  const connectionsDeps: ConnectionsDeps = {
    db: deps.db,
    hubOrigin: deps.issuer,
    modules: [], // teardown never consults the catalog
    resolveVaultOrigin: deps.resolveVaultOrigin,
    channelOrigin: deps.channelOrigin,
    storePath: deps.connectionsStorePath,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const records = readConnections(deps.connectionsStorePath).filter(
    (r) => r.source.vault === name || r.provisioned?.vault === name,
  );
  for (const record of records) {
    try {
      const res = await teardownConnection(record.id, adminSub, connectionsDeps);
      if (res.status === 200) {
        summary.connections_torn_down++;
      } else {
        // 207 partial — the record is removed + mints revoked; remote steps
        // failed. Surface as warnings, count as torn down (the identity side
        // is done; the operator can clean the remote residue).
        summary.connections_torn_down++;
        const out = (await res.json()) as { errors?: { step: string; detail: string }[] };
        for (const e of out.errors ?? []) {
          warnings.push({ step: `connection_${record.id}_${e.step}`, detail: e.detail });
        }
      }
    } catch (err) {
      warnings.push({
        step: `connection_${record.id}`,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Legacy channel scan — vault-backed channel entries still referencing the
  // vault after connection teardown (pre-Connections wiring). REPORT ONLY:
  // channel's config is the channel module's domain; the operator removes
  // them from channel's own UI.
  if (deps.channelOrigin !== null) {
    try {
      const fetchImpl = deps.fetchImpl ?? fetch;
      // Short-lived (60s) — stays below the registered-mint threshold by
      // design (the documented ≤10-min interactive bound; see B0's
      // REGISTERED_MINT_TTL_THRESHOLD_SECONDS in admin-connections.ts).
      const scanToken = (
        await signAccessToken(deps.db, {
          sub: adminSub,
          scopes: ["channel:admin"],
          audience: "channel",
          clientId: DELETE_VAULT_CLIENT_ID,
          issuer: deps.issuer,
          ttlSeconds: DELETE_VAULT_PROVISION_TTL_SECONDS,
          vaultScope: [],
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        })
      ).token;
      const res = await fetchImpl(`${deps.channelOrigin}/api/channels`, {
        headers: { authorization: `Bearer ${scanToken}`, accept: "application/json" },
      });
      if (res.ok) {
        const listed = (await res.json()) as { channels?: unknown };
        const rawList = Array.isArray(listed?.channels) ? listed.channels : [];
        for (const c of rawList) {
          const row = (c ?? {}) as Record<string, unknown>;
          if (row.transport === "vault" && row.vault === name && typeof row.name === "string") {
            summary.orphaned_channels.push(row.name);
          }
        }
      } else {
        warnings.push({ step: "channel_scan", detail: `channel list returned ${res.status}` });
      }
    } catch (err) {
      warnings.push({
        step: "channel_scan",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- 6. Mechanics: the module CLI is the source of truth for destruction. -
  try {
    const result = await runCommand(["parachute-vault", "remove", name, "--yes"]);
    if (result.exitCode !== 0) {
      const stderrTail = result.stderr.trim();
      const tailSuffix = stderrTail ? `: ${stderrTail.slice(-500)}` : "";
      return jsonError(
        500,
        "server_error",
        `parachute-vault remove ${name} --yes exited with code ${result.exitCode}${tailSuffix} — identity artifacts already revoked (summary: ${JSON.stringify(summary)})`,
      );
    }
    summary.vault_removed = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(
      500,
      "server_error",
      `orchestration failed: ${msg} — identity artifacts already revoked (summary: ${JSON.stringify(summary)})`,
    );
  }

  // --- 7. Daemon eviction: supervisor-restart the vault module. -------------
  if (deps.restartVaultModule) {
    try {
      await deps.restartVaultModule();
      summary.module_restarted = true;
    } catch (err) {
      warnings.push({
        step: "module_restart",
        detail: `vault module restart failed: ${err instanceof Error ? err.message : String(err)} — the running daemon may still serve the deleted vault from its open store handle until restarted (parachute restart vault)`,
      });
    }
  } else {
    warnings.push({
      step: "module_restart",
      detail:
        "no supervisor available — restart the vault module (parachute restart vault) to evict the deleted vault's open store handle and refresh services.json",
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      name,
      cascade: summary,
      ...(warnings.length > 0 ? { warnings } : {}),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
