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
 * (NOT the console session-cookie + CSRF + HTML-form shape). Create-vault and
 * set-caps accept `account:self:write` or its stronger `:admin` scope;
 * delete-vault and token-minting remain admin-only. Reads accept `:read` and
 * stronger account scopes. Every route also accepts `parachute:host:admin`.
 * Per PLAN-DECISION SCOPE-b the hub's account token is a SUPERSET that carries
 * both the `account:self:*` string AND the host scopes, so the wrapped cores
 * (which still gate on `parachute:host:admin`) accept it unchanged and this
 * facade works whether or not the H1 scope-registry PR has landed — a plain
 * host-admin token is always sufficient.
 *
 * On self-host the account IS the box (operator ≡ account ≡ box): the account
 * id is the sentinel `self`, and the operator owns every vault, so the
 * ownership gate the cloud twin runs per-vault is trivially satisfied here.
 */
import type { Database } from "bun:sqlite";
// NOTE: this is a VALUE import — hub can't run without
// `@openparachute/door-contract` resolving at runtime, so it's a real
// `^0.7.0` runtime `dependency` (package.json, mirroring `@openparachute/depcheck`)
// and NOT a `workspace:*` devDependency. The published hub tarball doesn't ship
// `packages/`, so the npm-installed hub resolves door-contract from the registry.
// See RELEASING.md → "Releasing door-contract".
import {
  type AccountBootstrap,
  type ParachuteAccountDescriptor,
  validateVaultScopes,
} from "@openparachute/door-contract";
import { ACCOUNT_VAULT_TOKEN_TTL_SECONDS } from "./account-home-ui.ts";
import {
  type AdminAuthContext,
  AdminAuthError,
  adminAuthErrorResponse,
  extractBearerToken,
} from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE, provisionVault } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { activePublicSignupPath } from "./invites.ts";
import { inferAudience } from "./jwt-audience.ts";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  recordTokenMint,
  signAccessToken,
  validateAccessToken,
} from "./jwt-sign.ts";
import {
  ACCOUNT_SELF_ADMIN_SCOPE,
  ACCOUNT_SELF_READ_SCOPE,
  ACCOUNT_SELF_WRITE_SCOPE,
} from "./scope-explanations.ts";
import { readManifestLenient } from "./services-manifest.ts";
import { getUserById } from "./users.ts";
import { getVaultCap, setVaultCap } from "./vault-caps.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";
import { isVaultEntry, vaultInstanceNameFor } from "./well-known.ts";

// The `account:self:{admin,write,read}` scope strings are defined once in
// scope-explanations.ts (H1, #746) and imported here so the two never drift.
/** client_id stamped on per-vault tokens this surface mints + their registry rows. */
const ACCOUNT_API_CLIENT_ID = "parachute-account";

/**
 * Lifetime of the create-time vault credential handed on `POST /account/vaults`
 * (the D2 handoff) for BOTH tiers. One access-token lifetime — NOT the 90-day
 * `ACCOUNT_VAULT_TOKEN_TTL_SECONDS` the admin-gated
 * `POST /account/vaults/<name>/token` route uses.
 *
 * The write tier's consent label promises the app "cannot ... mint access
 * tokens that outlive this app's access". A 90-day vault credential handed to
 * an app whose own bearer lasts 15 minutes breaks that promise: revoking the
 * grant tomorrow would leave a working vault credential behind for three
 * months. Bounding the handoff to one access-token lifetime keeps the
 * credential inside the window the user consented to, and matches cloud, whose
 * `ACCOUNT_VAULT_TOKEN_TTL_SECONDS` IS `ACCESS_TOKEN_TTL_SECONDS`
 * (`workers/identity/src/account-api.ts`). Admin-tier uses the same bound
 * because `account:self:admin` is now OAuth-requestable (hub#827); renewal
 * to the 90-day TTL stays on the admin-gated mint route, which is registered.
 *
 * Bounded residual: the handoff is minted fresh at create time, so it can
 * outlive the caller's *current* bearer by up to one full access-token
 * lifetime. It is registry-recorded against the caller's own `client_id`
 * (unlike the CLI bootstrap token, which never reaches the hub token
 * registry), so an operator can revoke it explicitly within that window.
 */
const WRITE_TIER_VAULT_HANDOFF_TTL_SECONDS = ACCESS_TOKEN_TTL_SECONDS;

/**
 * Scopes that satisfy an admin-only `/account/*` mutation (delete / mint). The
 * account superset token carries `account:self:admin`; a plain
 * operator/host-admin token carries `parachute:host:admin`. Either is accepted
 * so H2 works independent of H1's merge order (SCOPE-b).
 *
 * ORDER IS LOAD-BEARING: `requireAnyScope` puts `[0]` in the RFC 6750 `scope`
 * challenge, so the narrowest scope an account-door client should request must
 * come first.
 */
const ADMIN_SCOPES: readonly string[] = [ACCOUNT_SELF_ADMIN_SCOPE, HOST_ADMIN_SCOPE];
/** Scopes that satisfy a `/account/*` WRITE mutation (create, set-caps) — the
 * middle rung: provision/configure without delete or credential-minting
 * authority. ORDER IS LOAD-BEARING (see ADMIN_SCOPES doc) — narrowest first.
 *
 * `parachute:host:admin` is the self-host operator bypass and is hub-only:
 * cloud is multi-tenant and has no "host" authority, so its account mutations
 * can only be authorized by the tenant's own `account:<id>:*` scopes. It rides
 * along here for the same reason it rides along in ADMIN_SCOPES/READ_SCOPES
 * (SCOPE-b) — not a new grant of authority. */
const WRITE_SCOPES: readonly string[] = [
  ACCOUNT_SELF_WRITE_SCOPE,
  ACCOUNT_SELF_ADMIN_SCOPE,
  HOST_ADMIN_SCOPE,
];
/** Scopes that satisfy a `/account/*` READ. `admin ⊇ write ⊇ read`, spelled explicitly
 * because the hub's `requireScope` does an exact-string membership check (no
 * inheritance expansion at validate time). Narrowest-first, per ADMIN_SCOPES.
 *
 * `ACCOUNT_SELF_WRITE_SCOPE` is listed because the ladder is a LATTICE, not
 * three disjoint sets: door-contract's `hasAccountScope(["account:self:write"],
 * "self", "read")` is `true`, and `docs/contracts/oauth-scopes.md` publishes
 * that inheritance. Omitting it here contradicted both — and because
 * `requireAnyScope` tests exact membership rather than expanding inheritance,
 * the contradiction was live: a write-tier app 403'd on `GET /account`, the
 * bootstrap call that is the FIRST request in the account-door flow. The
 * door-contract parity test did not catch it because it exercises the shared
 * checker (`hasAccountScope`) and never these constants. Any future rung must
 * be added to every set it is a superset of. */
const READ_SCOPES: readonly string[] = [
  ACCOUNT_SELF_READ_SCOPE,
  ACCOUNT_SELF_WRITE_SCOPE,
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

function json(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
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
 *
 * The 403 carries `acceptable[0]` as `AdminAuthError.requiredScope`, so the
 * challenge names a scope the caller can actually request. FIRST, not the whole
 * set: RFC 6750 §3 permits a space-delimited `scope` list, but a list here
 * would read as "you need all of these" when any ONE suffices — and the other
 * entries are host scopes an account-door client should never ask for. Both
 * sets below are ordered narrowest-account-scope-first for exactly this reason;
 * keep them that way.
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
    throw new AdminAuthError(
      403,
      `token missing one of required scopes: ${acceptable.join(", ")}`,
      acceptable[0],
    );
  }
  const clientIdRaw = (validated.payload as { client_id?: unknown }).client_id;
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw : undefined;
  const aud = typeof validated.payload.aud === "string" ? validated.payload.aud : undefined;
  return { sub, scopes, clientId, audience: aud };
}

/** Scope set for admin-only `/account/*` mutations (delete / mint). */
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
 * The self-host door descriptor — the canonical `ParachuteAccountDescriptor`
 * (door-contract 0.4.0) both doors serve, so a client (the app) branches its
 * front door without hardcoding per-door shapes. Public, no auth, wildcard
 * CORS (the app pulls it cross-origin).
 *
 * `features`/`caps_writable` are hub EXTRAS beyond the shared contract — the
 * shared conformance checker (`checkAccountDescriptor`) walks expected keys
 * only, so these ride along without breaking cross-door conformance.
 * `billing:false` + `plans:[]` (Q7, parked) mean the app shows no
 * billing/upgrade UI on self-host; `caps_writable:true` means the operator
 * can PUT caps freely (the cloud twin is plan-derived → false).
 *
 * `signup_path` is conditional (Q2): present only while an active multi-use
 * public invite exists (`activePublicSignupPath`, invites.ts) — an operator-
 * shared link is otherwise the only way in, so the app must not render a
 * "create account" affordance when there is nowhere for it to go.
 */
export function handleAccountCapabilities(
  req: Request,
  deps: { db: Database; issuer: string; now?: () => Date },
): Response {
  if (req.method !== "GET") return methodNotAllowed("GET");
  const issuer = deps.issuer.replace(/\/$/, "");
  const now = deps.now ? deps.now() : new Date();
  const signupPath = activePublicSignupPath(deps.db, now);
  const descriptor: ParachuteAccountDescriptor & {
    features: {
      modules: boolean;
      expose: boolean;
      import: boolean;
      export: boolean;
      billing: boolean;
    };
    caps_writable: boolean;
  } = {
    issuer,
    door: "hub",
    account_endpoint: `${issuer}/account`,
    auth: { methods: ["password"], signin_path: "/login" },
    ...(signupPath ? { signup_path: signupPath } : {}),
    vault_url_template: `${issuer}/vault/{name}`,
    capabilities: { vault_create: true, vault_rename: false, vault_delete: true },
    plans: [],
    // Hub EXTRAS (kept — see the doc comment above).
    features: { modules: true, expose: true, import: true, export: true, billing: false },
    caps_writable: true,
  };
  return json(200, descriptor, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
  });
}

// ---------------------------------------------------------------------------
// GET /account — account bootstrap
// ---------------------------------------------------------------------------

/**
 * The contract's `AccountBootstrap` — `{ id, email?, door }`. On self-host the
 * account id is the sentinel `self`; `email` is present only when the
 * operator row has one (`users.email` is nullable-by-history, migration
 * v15 — the door-contract type models it as optional, not nullable).
 */
export async function handleAccountRoot(req: Request, deps: AccountApiDeps): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed("GET");
  let ctx: AdminAuthContext;
  try {
    ctx = await requireAnyScope(deps.db, req, READ_SCOPES, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err);
  }
  const user = getUserById(deps.db, ctx.sub);
  const body: AccountBootstrap = {
    id: "self",
    door: "hub",
    ...(user?.email ? { email: user.email } : {}),
  };
  return json(200, body);
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
 * create CLI still mints a `vault:<name>:admin` bootstrap token, but that
 * credential stays INTERNAL — it is never returned on this door (hub#827).
 * Both tiers receive a hub-signed, registry-recorded handoff capped at
 * `WRITE_TIER_VAULT_HANDOFF_TTL_SECONDS`, scoped to the granted tier:
 *   - admin: `vault:<name>:admin`
 *   - write: `vault:<name>:{read,write}`
 *
 * The CLI bootstrap is unbounded, hub-registry-invisible, and therefore
 * unrevocable. That was fine when account-admin was cookie-minted only;
 * `account:self:admin` is now OAuth-requestable, so a third-party admin-tier
 * app would walk away with exactly the credential class the write-tier
 * branch de-escalates. The handoff matches the granted verb, lives one
 * access-token lifetime, and is revocable because it has a registry row
 * against the REQUESTING client. Admin-tier renewal is
 * `POST /account/vaults/<name>/token` (90-day `ACCOUNT_VAULT_TOKEN_TTL_SECONDS`);
 * write-tier cannot renew (that route stays admin-gated).
 *
 * Post-`pvt_*`-DROP the CLI token can be `""` when no hub origin was
 * reachable. Admin-tier still mints a hub-signed handoff (signing does not
 * need the CLI). Write-tier still returns empty — there is nothing to
 * de-escalate, and that tier cannot re-mint.
 *
 * ---------------------------------------------------------------------------
 * HUB/CLOUD DRIFT #1 — create-vault authority and the returned credential.
 * Cloud twin: `handleAccountVaultCreate`, `workers/identity/src/account-api.ts`.
 *
 *   - Tier: cloud gates create on `requireAccount(..., "admin")` — it has no
 *     write rung yet. Hub accepts `account:self:write` (E1). Until cloud grows
 *     the middle rung, an `account:self:write` bearer opens create on the hub
 *     door and is refused on the cloud door. The door contract's
 *     `ACCOUNT_ROUTES` now says `write` for this route (door-contract 0.7.0),
 *     so cloud is the side that must catch up.
 *   - Credential: cloud ALWAYS mints `vault:<name>:{read,write}` and never
 *     returns an admin credential, because it has no host filesystem and no
 *     `parachute-vault create --json` CLI to bootstrap from. Hub's admin-tier
 *     branch mints `vault:<name>:admin` the same way (bounded, registered);
 *     the write-tier branch converges on cloud's read+write shape. Neither
 *     tier returns the CLI bootstrap token.
 *   - Lifetime: hub's `ACCOUNT_VAULT_TOKEN_TTL_SECONDS` is 90 days (the
 *     friend-mint default) where cloud's is `ACCESS_TOKEN_TTL_SECONDS`. The
 *     create-time handoff below uses the cloud value for BOTH tiers; the
 *     admin-gated `POST /account/vaults/<name>/token` route keeps hub's 90
 *     days. That older TTL drift is pre-existing and deliberately untouched
 *     here.
 */
export async function handleAccountCreateVault(
  req: Request,
  deps: AccountApiDeps,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed("POST");
  let auth: AdminAuthContext;
  try {
    auth = await requireAnyScope(deps.db, req, WRITE_SCOPES, deps.knownIssuers ?? [deps.issuer]);
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
  // Q6 (hub-parity P2): this facade no longer answers 200-idempotent on an
  // existing name — it converges on cloud's exact 409 `vault_taken` shape.
  // `provisionVault` itself is UNCHANGED (still idempotent for its other
  // caller, the invite-redeem flow, which doesn't route through this
  // facade) — only this facade's wire answer changes.
  //
  // What a consumer that relied on 200-on-existing can do here depends on its
  // tier, and the two answers differ:
  //
  //   - admin tier: follow up with `POST /account/vaults/<name>/token` to mint
  //     a credential for the existing vault.
  //   - write tier: that route is NOT available. It gates on ADMIN_SCOPES
  //     (`handleAccountMintVaultToken`), so an `account:self:write` bearer —
  //     the tier this route now accepts — gets 403 there. The only path
  //     forward at write tier is to retry create with a name that is free.
  //
  // This asymmetry is deliberate, not an oversight. Minting a fresh credential
  // for an ALREADY-EXISTING vault is the "mint access tokens that outlive this
  // app's access" authority the write-tier consent label explicitly disclaims;
  // it is also unbounded renewal, which would defeat the 15-minute
  // WRITE_TIER_VAULT_HANDOFF_TTL_SECONDS bound the create path below is careful
  // to impose. A write-tier app gets one bounded handoff at the moment IT
  // creates a vault, and no way to re-arm. Renewal is an admin decision.
  if (!provisioned.created) {
    return json(409, {
      error: "vault_taken",
      message: "That vault name is already taken.",
    });
  }

  const entry = provisioned.entry;
  const meta: VaultMeta = { name: entry.name, url: entry.url, version: entry.version };
  const authorizedWithAdminScope = ADMIN_SCOPES.some((scope) => auth.scopes.includes(scope));
  // CLI bootstrap token stays INTERNAL. Never returned, never copied into the
  // error body — a mint-failure consolation that leaked it would undo hub#827.
  const cliToken = provisioned.createJson?.token ?? "";
  let vaultToken = "";
  // Admin-tier always mints (hub signing does not need the CLI). Write-tier
  // only de-escalates when the CLI actually produced a credential.
  const mintHandoff = authorizedWithAdminScope || cliToken.length > 0;
  if (mintHandoff) {
    const scopes = authorizedWithAdminScope
      ? [`vault:${entry.name}:admin`]
      : [`vault:${entry.name}:read`, `vault:${entry.name}:write`];
    // OAuth bearers carry their requesting client_id. Legacy self-issued
    // account bearers may omit it; retain the existing account-surface id only
    // for that fallback while preserving the caller's id whenever present.
    const clientId = auth.clientId ?? ACCOUNT_API_CLIENT_ID;
    // NOT ATOMIC WITH THE PROVISION ABOVE, deliberately surfaced rather than
    // hidden. `provisionVault` has already committed — the vault exists on disk
    // and in the services manifest — and there is no rollback seam to undo it
    // (deleting a just-created vault on a mint failure would be a second
    // destructive action taken on a guess). So a throw here MUST NOT surface as
    // a generic 500: the caller would read it as "create failed", retry, and
    // get a 409 `vault_taken` for a vault it does own but has no credential
    // for. Write tier cannot recover (`POST /account/vaults/<name>/token` is
    // admin-gated). Admin tier can, via that route. The distinguishable error
    // below tells caller and operator exactly what state the box is in: the
    // vault EXISTS, only the handoff failed.
    try {
      const minted = await signAccessToken(deps.db, {
        sub: auth.sub,
        scopes,
        audience: inferAudience(scopes),
        clientId,
        issuer: deps.issuer,
        ttlSeconds: WRITE_TIER_VAULT_HANDOFF_TTL_SECONDS,
        vaultScope: [entry.name],
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
      const subjectIsUser = getUserById(deps.db, auth.sub) !== null;
      recordTokenMint(deps.db, {
        jti: minted.jti,
        createdVia: "cli_mint",
        subject: auth.sub,
        ...(subjectIsUser ? { userId: auth.sub } : {}),
        clientId,
        scopes,
        expiresAt: minted.expiresAt,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
      vaultToken = minted.token;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[account-api] vault "${entry.name}" was created but the token handoff failed: ${detail}`,
      );
      return json(500, {
        error: "vault_created_token_mint_failed",
        vault: entry.name,
        message: `The vault "${entry.name}" WAS created, but minting its access token failed. The vault exists — do not retry create (it will report the name as taken). An operator must mint a token for it with \`POST /account/vaults/${entry.name}/token\` (requires ${ACCOUNT_SELF_ADMIN_SCOPE}) or delete the vault.`,
      });
    }
  }
  // Never forward the CLI's `token_guidance` — it describes the bootstrap
  // token this door no longer returns, and for write-tier it points at a
  // mint route that 403s. Each tier gets guidance matching the credential
  // it actually holds.
  const handoffMinutes = Math.round(WRITE_TIER_VAULT_HANDOFF_TTL_SECONDS / 60);
  const tokenGuidance = authorizedWithAdminScope
    ? `This token grants admin access to this vault only, expires in ${handoffMinutes} minutes, and is registered against this app so it can be revoked. Renew with POST /account/vaults/${entry.name}/token.`
    : vaultToken.length > 0
      ? `This token grants read+write access to this vault only, and expires in ${handoffMinutes} minutes. It is the one credential this vault hands you at creation — it cannot be renewed at this tier.`
      : "No access token could be issued for this vault. The vault WAS created, but your grant does not permit minting a credential for it after the fact. Ask an operator to mint one for you.";
  const body: {
    name: string;
    url: string;
    vault_token: string;
    token_guidance?: string;
    services: Record<string, { url: string; version: string }>;
  } = {
    name: entry.name,
    url: entry.url,
    vault_token: vaultToken,
    ...(tokenGuidance ? { token_guidance: tokenGuidance } : {}),
    services: servicesBlock(meta),
  };
  return json(201, body);
}

// ---------------------------------------------------------------------------
// POST /account/vaults/<name>/token — per-vault token mint
// ---------------------------------------------------------------------------

interface ScopesBody {
  ok: true;
  scopes: string[];
}

/**
 * Parse + validate the requested `scopes`. The JSON-parse tolerance (optional
 * body, optional content-type, swallow a malformed body) stays LOCAL — it's
 * HTTP plumbing the shared validator knows nothing about (it's pure, no
 * `Request`). The scope-SHAPE logic (array check, per-entry
 * `vault:<name>:<verb>` grammar, empty/absent → default read+write) is the
 * shared `validateVaultScopes` (door-contract 0.4.0) — the ONE implementation
 * cloud's twin also imports, replacing the two hand-synced copies. Its reason
 * taxonomy (`invalid_request` | `invalid_scope`) was built byte-exact with
 * this function's prior behavior (see vault-scopes.ts's doc comment), so this
 * swap is a behavioral no-op for the hub — verified by rerunning this file's
 * existing test cases unchanged (account-api.test.ts).
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

  const result = validateVaultScopes(requested, vaultName);
  if (!result.ok) {
    return result.reason === "invalid_request"
      ? {
          ok: false,
          status: 400,
          error: "invalid_request",
          message: '"scopes" must be an array of strings',
        }
      : {
          ok: false,
          status: 400,
          error: "invalid_scope",
          message: `every scope must be vault:${vaultName}:{read|write|admin}`,
        };
  }
  return { ok: true, scopes: result.scopes };
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
  let auth: AdminAuthContext;
  try {
    auth = await requireAnyScope(deps.db, req, WRITE_SCOPES, deps.knownIssuers ?? [deps.issuer]);
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
  // Audit line, matching the operator route's (`api-vault-caps.ts`) but naming
  // the CALLER too. This route is reachable at write tier by a third-party
  // OAuth client, and nothing scopes it to vaults that client created — so a
  // client granted `account:self:write` for its own vault can retune the quota
  // of ANY vault on the box. Whether that should be restricted to app-created
  // vaults is an open design question (Phase 2); until it is answered, the
  // change must at minimum leave a trace naming who made it.
  console.log(
    `vault cap set: vault=${vaultName} cap_bytes=${cap.capBytes} ` +
      `via=account-api subject=${auth.sub} client_id=${auth.clientId ?? "none"}`,
  );
  return json(200, {
    name: vaultName,
    caps: { cap_bytes: cap.capBytes, created_at: cap.createdAt, updated_at: cap.updatedAt },
    caps_writable: true,
  });
}
