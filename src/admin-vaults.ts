/**
 * `POST /vaults` — provision a new vault on the host.
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
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { findService, type readManifest, readManifestLenient } from "./services-manifest.ts";
import { type WellKnownVaultEntry, isVaultEntry, vaultInstanceNameFor } from "./well-known.ts";

/** Scope required to call POST /vaults. */
export const HOST_ADMIN_SCOPE = "parachute:host:admin";

/**
 * Mirror parachute-vault's `cmdCreate` validation rules, plus hub-only
 * reservations for SPA-route shadowing. `list` matches the CLI; `new` and
 * `assets` would collide with `/vault/new` (the SPA's create-vault route)
 * and `/vault/assets/*` (the SPA's static asset bundle) respectively, so
 * the hub rejects them at the API edge before a vault under those names
 * can register and capture the proxy path.
 */
const VAULT_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const RESERVED_VAULT_NAMES = new Set(["list", "new", "assets"]);

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
      message: "vault name must contain only letters, numbers, hyphens, and underscores",
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
  const proc = Bun.spawn([...cmd], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
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
): Promise<OrchestrateOk | OrchestrateError> {
  const vaultRegistered = findService("parachute-vault", manifestPath) !== undefined;
  const cmd = vaultRegistered
    ? ["parachute-vault", "create", name, "--json"]
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

  // Idempotency: if the vault already exists, return 200 + existing entry.
  // Skip the CLI shell-out — re-POST is usually a UI retry.
  const existing = findExistingVault(manifestPath, name);
  if (existing) {
    return new Response(
      JSON.stringify(buildEntry(name, existing.path, existing.version, deps.issuer)),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  const result = await orchestrate(manifestPath, name, runCommand);
  if (!result.ok) {
    return jsonError(result.status, "server_error", result.message);
  }

  // Re-read services.json: the CLI just wrote it.
  const created = findExistingVault(manifestPath, name);
  if (!created) {
    return jsonError(
      500,
      "server_error",
      `vault "${name}" was provisioned but is not in services.json — manual recovery required`,
    );
  }

  const entry = buildEntry(name, created.path, created.version, deps.issuer);
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
