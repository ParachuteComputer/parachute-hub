/**
 * `/account/*` — the Bearer-gated account-door REST facade (Phase 2, H2).
 *
 * This is the self-host door's slice of the normalized `/account/*` contract
 * both doors mount (the hosted cloud door mounts the twin). It is deliberately
 * a THIN FACADE over machinery the hub already ships — it does NOT reimplement
 * vault provisioning, deletion, per-vault token minting, or caps. Each handler
 * wraps the existing core:
 *
 *   POST   /account/vaults              → `provisionVault` (admin-vaults.ts)
 *   GET    /account/vaults              → services.json vault enumeration + caps
 *   DELETE /account/vaults/<name>       → `handleDeleteVault` (wired in hub-server)
 *   POST   /account/vaults/<name>/token → `signAccessToken` (the same mint the
 *                                          friend-facing /account/vault-token
 *                                          surface uses, bearer-gated instead of
 *                                          cookie-gated)
 *   GET    /account/vaults/<name>/caps  → `getVaultCap` (vault-caps.ts)
 *   PUT    /account/vaults/<name>/caps  → `setVaultCap` (vault-caps.ts)
 *   GET    /account                     → account bootstrap (id/email/door)
 *   GET    /.well-known/parachute-account → the public capabilities descriptor
 *
 * Auth posture: `Authorization: Bearer` + scope, adopting the hub's admin shape
 * (NOT the console session-cookie + CSRF + HTML-form shape). Mutations accept
 * `account:self:admin` OR `parachute:host:admin`; reads additionally accept
 * `account:self:read`. Per PLAN-DECISION SCOPE-b the hub's account token is a
 * SUPERSET that carries both the `account:self:*` string AND the host scopes,
 * so the wrapped cores (which still gate on `parachute:host:admin`) accept it
 * unchanged and this facade works whether or not the H1 scope-registry PR has
 * landed — a plain host-admin token is always sufficient.
 *
 * On self-host the account IS the box (operator ≡ account ≡ box): the account
 * id is the sentinel `self`, and the operator owns every vault, so the
 * ownership gate the cloud twin runs per-vault is trivially satisfied here.
 */
import type { Database } from "bun:sqlite";
import { ACCOUNT_VAULT_TOKEN_TTL_SECONDS } from "./account-home-ui.ts";
import {
  type AdminAuthContext,
  AdminAuthError,
  adminAuthErrorResponse,
  extractBearerToken,
} from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE, provisionVault } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { inferAudience } from "./jwt-audience.ts";
import { recordTokenMint, signAccessToken, validateAccessToken } from "./jwt-sign.ts";
import { ACCOUNT_SELF_ADMIN_SCOPE, ACCOUNT_SELF_READ_SCOPE } from "./scope-explanations.ts";
import { readManifestLenient } from "./services-manifest.ts";
import { getUserById } from "./users.ts";
import { getVaultCap, setVaultCap } from "./vault-caps.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";
import { isVaultEntry, vaultInstanceNameFor } from "./well-known.ts";

// The `account:self:{admin,read}` scope strings are defined once in
// scope-explanations.ts (H1, #746) — the same registry that makes them
// non-OAuth-requestable — and imported here so the two never drift.
/** client_id stamped on per-vault tokens this surface mints + their registry rows. */
const ACCOUNT_API_CLIENT_ID = "parachute-account";

/**
 * Scopes that satisfy a `/account/*` MUTATION. The account superset token
 * carries `account:self:admin`; a plain operator/host-admin token carries
 * `parachute:host:admin`. Either is accepted so H2 works independent of H1's
 * merge order (SCOPE-b).
 */
const ADMIN_SCOPES: readonly string[] = [ACCOUNT_SELF_ADMIN_SCOPE, HOST_ADMIN_SCOPE];
/** Scopes that satisfy a `/account/*` READ. `admin ⊇ read`, spelled explicitly
 * because the hub's `requireScope` does an exact-string membership check (no
 * inheritance expansion at validate time). */
const READ_SCOPES: readonly string[] = [
  ACCOUNT_SELF_READ_SCOPE,
  ACCOUNT_SELF_ADMIN_SCOPE,
  HOST_ADMIN_SCOPE,
];

export interface AccountApiDeps {
  db: Database;
  /** Hub origin — JWT `iss` validation, response URLs, and minted-token `iss`. */
  issuer: string;
  /**
   * SET of origins the hub answers on (loopback ∪ expose-state ∪ platform ∪
   * per-request `issuer`), built via `buildHubBoundOrigins`. The bearer's `iss`
   * is validated against THIS set rather than the single `issuer` so a
   * credential minted under a still-valid prior origin keeps working across an
   * origin switch (hub#516 parity). Absent → falls back to `[issuer]`.
   */
  knownIssuers?: readonly string[];
  /** Override services.json path. Defaults to `~/.parachute/services.json`. */
  manifestPath?: string;
  /** Test seam for the clock (mint + registry row). */
  now?: () => Date;
  /** Test seam threaded into `provisionVault` so create can be exercised
   * without spawning the real `parachute-vault create` binary. */
  runCommand?: (cmd: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed", message: `use ${allow}` }), {
    status: 405,
    headers: { "content-type": "application/json", allow },
  });
}

/**
 * Validate a presented bearer token and assert it carries ANY of `acceptable`.
 * Mirrors `requireScope` (admin-auth.ts) exactly — same signature-first
 * validation, same `iss`-∈-set relaxation, same claim surfacing — but matches
 * a SET of scopes rather than a single required one, so `/account/*` can accept
 * `account:self:*` OR `parachute:host:admin`. Throws `AdminAuthError` (401/403);
 * callers translate via `adminAuthErrorResponse`.
 */
export async function requireAnyScope(
  db: Database,
  req: Request,
  acceptable: readonly string[],
  expectedIssuer: string | readonly string[],
): Promise<AdminAuthContext> {
  const token = extractBearerToken(req);
  let validated: Awaited<ReturnType<typeof validateAccessToken>>;
  try {
    validated = await validateAccessToken(db, token, expectedIssuer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminAuthError(401, `invalid token: ${msg}`);
  }
  const sub = typeof validated.payload.sub === "string" ? validated.payload.sub : null;
  if (!sub) throw new AdminAuthError(401, "token missing required `sub` claim");
  const scopeClaim = (validated.payload as { scope?: unknown }).scope;
  const scopes =
    typeof scopeClaim === "string" ? scopeClaim.split(/\s+/).filter((s) => s.length > 0) : [];
  if (!acceptable.some((s) => scopes.includes(s))) {
    throw new AdminAuthError(403, `token missing one of required scopes: ${acceptable.join(", ")}`);
  }
  const clientIdRaw = (validated.payload as { client_id?: unknown }).client_id;
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw : undefined;
  const aud = typeof validated.payload.aud === "string" ? validated.payload.aud : undefined;
  return { sub, scopes, clientId, audience: aud };
}

/** Scope set for a `/account/*` mutation (create / delete / mint / set-caps). */
export const ACCOUNT_MUTATION_SCOPES = ADMIN_SCOPES;
/** Scope set for a `/account/*` read (list / get-caps / bootstrap). */
export const ACCOUNT_READ_SCOPES = READ_SCOPES;

interface VaultMeta {
  name: string;
  url: string;
  version: string;
}

/**
 * Enumerate every servable vault from services.json with its canonical URL +
 * version. Mirrors `findExistingVault`'s enumeration in admin-vaults.ts (same
 * `isVaultEntry` filter, same empty-paths skip #478, same `vaultInstanceNameFor`
 * name derivation, same `new URL(path, base)` URL build as `buildEntry`) so the
 * account list agrees with the well-known vaults[] fan-out and the create path.
 */
function listVaultsWithMeta(manifestPath: string, issuer: string): VaultMeta[] {
  const base = issuer.replace(/\/$/, "");
  const out: VaultMeta[] = [];
  let manifest: ReturnType<typeof readManifestLenient>;
  try {
    manifest = readManifestLenient(manifestPath);
  } catch {
    return out;
  }
  for (const svc of manifest.services) {
    if (!isVaultEntry(svc)) continue;
    if (svc.paths.length === 0) continue; // #478: installed-but-no-instance
    for (const path of svc.paths) {
      const name = vaultInstanceNameFor(svc.name, path);
      const url = new URL(path, `${base}/`).toString();
      out.push({ name, url, version: svc.version });
    }
  }
  return out;
}

function servicesBlock(meta: VaultMeta): Record<string, { url: string; version: string }> {
  return { [`vault:${meta.name}`]: { url: meta.url, version: meta.version } };
}

// ---------------------------------------------------------------------------
// GET /.well-known/parachute-account — public capabilities descriptor
// ---------------------------------------------------------------------------

/**
 * The self-host door descriptor. Public, no auth — it is what lets the app
 * render honestly per door (D2): `billing:false` + `plans:[]` means the app
 * shows no billing/upgrade UI on self-host; `caps_writable:true` means the
 * operator can PUT caps freely (the cloud twin is plan-derived → false).
 *
 * `import`/`export` describe the self-host DOOR's portability capability
 * (which it has). The `/account/vaults/<name>/export` + `/account/vaults/import`
 * REST endpoints are a follow-on to this PR (H2 ships the vault-lifecycle +
 * caps core); the flags stay true because the door supports portability.
 */
export function handleAccountCapabilities(req: Request, deps: { issuer: string }): Response {
  if (req.method !== "GET") return methodNotAllowed("GET");
  const descriptor = {
    door: "self-host",
    issuer: deps.issuer.replace(/\/$/, ""),
    account_token: { endpoint: "/account/token", method: "POST", scheme: "cookie" },
    features: {
      vault_create: true,
      vault_delete: true,
      import: true,
      export: true,
      billing: false,
      plans: [] as string[],
      modules: true,
      expose: true,
    },
    caps_writable: true,
    limits: { vaults_max: null as number | null },
  };
  return json(200, descriptor);
}

// ---------------------------------------------------------------------------
// GET /account — account bootstrap
// ---------------------------------------------------------------------------

/** `{ account_id, email, door }`. On self-host the account id is `self`. */
export async function handleAccountRoot(req: Request, deps: AccountApiDeps): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed("GET");
  let ctx: AdminAuthContext;
  try {
    ctx = await requireAnyScope(deps.db, req, READ_SCOPES, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err);
  }
  const user = getUserById(deps.db, ctx.sub);
  return json(200, {
    account_id: "self",
    email: user?.email ?? null,
    door: "self-host",
  });
}

// ---------------------------------------------------------------------------
// GET /account/vaults — list
// ---------------------------------------------------------------------------

export async function handleAccountListVaults(
  req: Request,
  deps: AccountApiDeps,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed("GET");
  try {
    await requireAnyScope(deps.db, req, READ_SCOPES, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err);
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const vaults = listVaultsWithMeta(manifestPath, deps.issuer).map((v) => {
    const cap = getVaultCap(deps.db, v.name);
    return {
      name: v.name,
      url: v.url,
      version: v.version,
      caps: { cap_bytes: cap?.capBytes ?? null },
    };
  });
  return json(200, { vaults });
}

// ---------------------------------------------------------------------------
// POST /account/vaults — create (returns a ready-to-use vault token)
// ---------------------------------------------------------------------------

interface NameBody {
  ok: true;
  name: string;
}
interface BodyErr {
  ok: false;
  status: number;
  error: string;
  message: string;
}

async function parseNameBody(req: Request): Promise<NameBody | BodyErr> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      message: "Content-Type must be application/json",
    };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      message: `invalid JSON body: ${msg}`,
    };
  }
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      message: "request body must be a JSON object",
    };
  }
  const name = (raw as Record<string, unknown>).name;
  if (typeof name !== "string" || name.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_name",
      message: '"name" must be a non-empty string',
    };
  }
  return { ok: true, name };
}

/**
 * Create a vault and return a ready-to-use vault token (the hinge, D2): the app
 * lands the user IN the vault with zero extra round-trips. Wraps the auth-free
 * `provisionVault` core (this facade already ran the scope gate). The hub's
 * create already mints a `vault:<name>:admin` token; post-`pvt_*`-DROP that
 * token can be `""` when no hub origin was reachable — the response forwards
 * whatever the vault minted (+ `token_guidance`), and the app falls back to
 * `POST /account/vaults/<name>/token` on an empty `vault_token` (risk #5).
 */
export async function handleAccountCreateVault(
  req: Request,
  deps: AccountApiDeps,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed("POST");
  try {
    await requireAnyScope(deps.db, req, ADMIN_SCOPES, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err);
  }
  const parsed = await parseNameBody(req);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error, message: parsed.message });

  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const provisioned = await provisionVault(parsed.name, {
    issuer: deps.issuer,
    manifestPath,
    ...(deps.runCommand ? { runCommand: deps.runCommand } : {}),
  });
  if (!provisioned.ok) {
    const error = provisioned.status === 400 ? "invalid_name" : "server_error";
    return json(provisioned.status, { error, message: provisioned.message });
  }

  const entry = provisioned.entry;
  const meta: VaultMeta = { name: entry.name, url: entry.url, version: entry.version };
  const body: {
    name: string;
    url: string;
    vault_token: string;
    token_guidance?: string;
    services: Record<string, { url: string; version: string }>;
  } = {
    name: entry.name,
    url: entry.url,
    vault_token: provisioned.createJson?.token ?? "",
    ...(provisioned.createJson?.token_guidance
      ? { token_guidance: provisioned.createJson.token_guidance }
      : {}),
    services: servicesBlock(meta),
  };
  // 201 on a fresh create; 200 on an idempotent re-POST of an existing vault
  // (no fresh token — `vault_token` is "" and the app mints via /token).
  return json(provisioned.created ? 201 : 200, body);
}

// ---------------------------------------------------------------------------
// POST /account/vaults/<name>/token — per-vault token mint
// ---------------------------------------------------------------------------

const MINTABLE_VERBS = new Set(["read", "write", "admin"]);

interface ScopesBody {
  ok: true;
  scopes: string[];
}

/**
 * Parse + validate the requested `scopes`. Each must be `vault:<name>:<verb>`
 * for THIS vault with a mintable verb. Omitted / empty → default read+write.
 */
async function parseScopesBody(req: Request, vaultName: string): Promise<ScopesBody | BodyErr> {
  const defaultScopes = [`vault:${vaultName}:read`, `vault:${vaultName}:write`];
  const ctype = req.headers.get("content-type") ?? "";
  // A body is optional; a token mint with no body defaults to read+write.
  if (!ctype.toLowerCase().includes("application/json")) {
    return { ok: true, scopes: defaultScopes };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: true, scopes: defaultScopes };
  }
  if (!raw || typeof raw !== "object") return { ok: true, scopes: defaultScopes };
  const requested = (raw as Record<string, unknown>).scopes;
  if (requested === undefined || requested === null) return { ok: true, scopes: defaultScopes };
  if (!Array.isArray(requested) || requested.some((s) => typeof s !== "string")) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      message: '"scopes" must be an array of strings',
    };
  }
  const scopes = requested as string[];
  if (scopes.length === 0) return { ok: true, scopes: defaultScopes };
  for (const s of scopes) {
    const parts = s.split(":");
    if (
      parts.length !== 3 ||
      parts[0] !== "vault" ||
      parts[1] !== vaultName ||
      !MINTABLE_VERBS.has(parts[2] ?? "")
    ) {
      return {
        ok: false,
        status: 400,
        error: "invalid_scope",
        message: `scope "${s}" must be vault:${vaultName}:{read|write|admin}`,
      };
    }
  }
  return { ok: true, scopes };
}

export async function handleAccountMintVaultToken(
  req: Request,
  vaultName: string,
  deps: AccountApiDeps,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed("POST");
  let ctx: AdminAuthContext;
  try {
    ctx = await requireAnyScope(deps.db, req, ADMIN_SCOPES, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err);
  }
  if (!VAULT_NAME_CHARSET_RE.test(vaultName)) {
    return json(400, {
      error: "invalid_name",
      message: `"${vaultName}" is not a valid vault name`,
    });
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const meta = listVaultsWithMeta(manifestPath, deps.issuer).find((v) => v.name === vaultName);
  if (!meta) {
    return json(404, { error: "vault_not_found", message: `no vault named "${vaultName}"` });
  }
  const parsed = await parseScopesBody(req, vaultName);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error, message: parsed.message });

  const scopes = parsed.scopes;
  const audience = inferAudience(scopes); // → vault.<name>
  const minted = await signAccessToken(deps.db, {
    sub: ctx.sub,
    scopes,
    audience,
    clientId: ACCOUNT_API_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: ACCOUNT_VAULT_TOKEN_TTL_SECONDS,
    vaultScope: [vaultName],
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // Registry row so the operator token registry + revocation list attribute it.
  // Anchor to the subject's user_id only when it names a real user row (an
  // operator token's `sub` may be the "operator" sentinel, which is not a
  // `users` row — pass it as `subject` but omit `user_id` to avoid a dangling FK).
  const subjectIsUser = getUserById(deps.db, ctx.sub) !== null;
  recordTokenMint(deps.db, {
    jti: minted.jti,
    createdVia: "cli_mint",
    subject: ctx.sub,
    ...(subjectIsUser ? { userId: ctx.sub } : {}),
    clientId: ACCOUNT_API_CLIENT_ID,
    scopes,
    expiresAt: minted.expiresAt,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  return json(200, {
    vault_token: minted.token,
    expires_at: minted.expiresAt,
    services: servicesBlock(meta),
  });
}

// ---------------------------------------------------------------------------
// GET / PUT /account/vaults/<name>/caps
// ---------------------------------------------------------------------------

export async function handleAccountGetVaultCaps(
  req: Request,
  vaultName: string,
  deps: AccountApiDeps,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed("GET");
  try {
    await requireAnyScope(deps.db, req, READ_SCOPES, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err);
  }
  if (!VAULT_NAME_CHARSET_RE.test(vaultName)) {
    return json(400, {
      error: "invalid_name",
      message: `"${vaultName}" is not a valid vault name`,
    });
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const meta = listVaultsWithMeta(manifestPath, deps.issuer).find((v) => v.name === vaultName);
  if (!meta) {
    return json(404, { error: "vault_not_found", message: `no vault named "${vaultName}"` });
  }
  const cap = getVaultCap(deps.db, vaultName);
  return json(200, {
    name: vaultName,
    caps: {
      cap_bytes: cap?.capBytes ?? null,
      created_at: cap?.createdAt ?? null,
      updated_at: cap?.updatedAt ?? null,
    },
    caps_writable: true,
  });
}

interface CapBody {
  ok: true;
  cap_bytes: number;
}

async function parseCapBody(req: Request): Promise<CapBody | BodyErr> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      message: "Content-Type must be application/json",
    };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      message: `invalid JSON body: ${msg}`,
    };
  }
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      message: "request body must be a JSON object",
    };
  }
  const capBytes = (raw as Record<string, unknown>).cap_bytes;
  if (typeof capBytes !== "number" || !Number.isInteger(capBytes) || capBytes <= 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      message: '"cap_bytes" must be a positive integer number of bytes',
    };
  }
  return { ok: true, cap_bytes: capBytes };
}

export async function handleAccountSetVaultCaps(
  req: Request,
  vaultName: string,
  deps: AccountApiDeps,
): Promise<Response> {
  if (req.method !== "PUT") return methodNotAllowed("PUT");
  try {
    await requireAnyScope(deps.db, req, ADMIN_SCOPES, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err);
  }
  if (!VAULT_NAME_CHARSET_RE.test(vaultName)) {
    return json(400, {
      error: "invalid_name",
      message: `"${vaultName}" is not a valid vault name`,
    });
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const meta = listVaultsWithMeta(manifestPath, deps.issuer).find((v) => v.name === vaultName);
  if (!meta) {
    return json(404, { error: "vault_not_found", message: `no vault named "${vaultName}"` });
  }
  const parsed = await parseCapBody(req);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error, message: parsed.message });

  const cap = setVaultCap(deps.db, vaultName, parsed.cap_bytes);
  return json(200, {
    name: vaultName,
    caps: { cap_bytes: cap.capBytes, created_at: cap.createdAt, updated_at: cap.updatedAt },
    caps_writable: true,
  });
}
