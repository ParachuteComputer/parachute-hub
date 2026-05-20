/**
 * HTTP client for the hub SPA. Two surfaces:
 *
 *   - `/.well-known/parachute.json` — public discovery doc (no auth).
 *   - `/vaults` — admin endpoint (POST creates, requires
 *     `parachute:host:admin` Bearer).
 *
 * The Bearer comes from `lib/auth.ts:getHostAdminToken()`, which trades
 * the `parachute_hub_session` cookie for a short-lived JWT. On 401 from
 * the admin endpoint after a fresh mint, the auth helper navigates the
 * browser to /admin/login — we don't try to recover.
 */
import { clearCachedToken, getHostAdminToken, redirectToLoginAndHang } from "./auth.ts";

export interface VaultListing {
  name: string;
  url: string;
  version: string;
  /** Path under the hub origin where the vault is mounted (e.g. /vault/work). */
  path: string;
  /**
   * Vault-declared admin entry point from `/.parachute/module.json`. Either an
   * absolute URL or a path relative to the vault's mounted URL. Absent when
   * the vault has no admin SPA wired (CLI-only management).
   */
  managementUrl?: string;
}

export interface MintedVaultAdminToken {
  token: string;
  /** ISO 8601 expiry — vault SPA recomputes its refresh window from this. */
  expiresAt: string;
  scopes: string[];
}

export interface CreateVaultInput {
  name: string;
}

export interface CreateVaultResult {
  name: string;
  url: string;
  version: string;
  /** Single-emit `pvt_*` token from `parachute-vault create --json`. Only on first creation. */
  token?: string;
  paths?: {
    vault_dir: string;
    vault_db: string;
    vault_config: string;
  };
}

/** Status code carried alongside the message so callers can branch numerically. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Fetch the well-known discovery doc. Anonymous — no Bearer needed. The hub
 * serves this at the origin root with `Access-Control-Allow-Origin: *` so a
 * cross-origin SPA could read it too, but ours is same-origin.
 */
export async function listVaults(): Promise<VaultListing[]> {
  const res = await fetch("/.well-known/parachute.json", {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new HttpError(res.status, `well-known fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    vaults?: Array<{ name: string; url: string; version: string; managementUrl?: string }>;
    services?: Array<{ name: string; path: string }>;
  };
  const vaults = body.vaults ?? [];
  const services = body.services ?? [];
  return vaults.map((v) => {
    const listing: VaultListing = {
      name: v.name,
      url: v.url,
      version: v.version,
      path: pathFor(v.name, v.url, services),
    };
    if (v.managementUrl) listing.managementUrl = v.managementUrl;
    return listing;
  });
}

function pathFor(
  name: string,
  url: string,
  services: Array<{ name: string; path: string }>,
): string {
  // Prefer the well-known `services` entry's path — it's the canonical mount
  // the hub itself uses for routing. Fall back to deriving from the URL's
  // pathname when the entry is missing (older hubs / odd shapes).
  const match = services.find(
    (s) => s.name === `parachute-vault-${name}` || s.path === `/vault/${name}`,
  );
  if (match) return match.path;
  try {
    return new URL(url).pathname;
  } catch {
    return `/vault/${name}`;
  }
}

/** POST /vaults — create a new vault. Requires `parachute:host:admin`. */
export async function createVault(input: CreateVaultInput): Promise<CreateVaultResult> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/vaults", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(input),
  });
  if (res.status === 401 || res.status === 403) {
    // Token didn't carry the scope (shouldn't happen — mint ensures it) OR
    // the cached JWT lapsed mid-flight. Drop the cache; the auth helper
    // navigates to /admin/login on the next mint attempt if the cookie has
    // also expired. Surface the 401 so the form can re-issue cleanly.
    //
    // Deliberate: we don't auto-mint-and-retry transparently. A failed
    // POST gets surfaced to the operator and a re-click drives the next
    // attempt — which mints fresh after `clearCachedToken`. Manual retry
    // keeps a stale-token mid-submit visible (vs. silently swallowing
    // a state mismatch) and avoids retrying a request the user might
    // not actually want repeated.
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as CreateVaultResult;
}

/**
 * Mint a per-vault admin JWT (`vault:<name>:admin`) by trading the
 * `parachute_hub_session` cookie. Used by the "Manage" button to bootstrap
 * the vault's own admin SPA via a `#token=...` URL fragment.
 *
 * Same session-cookie origin as `getHostAdminToken()`, so we don't reuse
 * the host-admin Bearer here — the endpoint reads the cookie directly.
 * On 401 the operator's session is gone; we redirect to /admin/login and
 * hang the promise — same shape as `getHostAdminToken()` so the operator
 * never sees a "no admin session" message they can't act on.
 */
export async function mintVaultAdminToken(name: string): Promise<MintedVaultAdminToken> {
  const res = await fetch(`/admin/vault-admin-token/${encodeURIComponent(name)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (res.status === 401) {
    return redirectToLoginAndHang<MintedVaultAdminToken>();
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  const body = (await res.json()) as { token: string; expires_at: string; scopes: string[] };
  if (!body.token || !body.expires_at) {
    throw new HttpError(500, "/admin/vault-admin-token returned malformed body");
  }
  return { token: body.token, expiresAt: body.expires_at, scopes: body.scopes ?? [] };
}

/**
 * Operator-visible OAuth grant from `GET /api/grants`. The hub returns a
 * snake_case row to keep the wire format aligned with the underlying
 * sqlite schema; the SPA reads it directly.
 */
export interface AdminGrantListing {
  user_id: string;
  client_id: string;
  /** Display name from the OAuth client registration. Null when the client never set one. */
  client_name: string | null;
  scopes: string[];
  granted_at: string;
}

/**
 * GET /api/grants — list the operator's OAuth-grant skip-list. Optional
 * `vault` filter narrows to grants whose scope set touches `vault:<name>:*`.
 * Same Bearer pattern as `createVault`: a 401/403 dumps the cached token so
 * the next call re-mints from the session cookie (or hands off to login).
 */
export async function listGrants(opts: { vault?: string } = {}): Promise<AdminGrantListing[]> {
  const bearer = await getHostAdminToken();
  const query = opts.vault ? `?vault=${encodeURIComponent(opts.vault)}` : "";
  const res = await fetch(`/api/grants${query}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  const body = (await res.json()) as { grants: AdminGrantListing[] };
  return body.grants ?? [];
}

/**
 * DELETE /api/grants/<client_id> — revoke a single grant. Returns void on
 * 204; throws HttpError on 4xx. Note: revoking a grant only forces the
 * next OAuth flow for this client to show the consent screen again — it
 * does NOT revoke active access tokens. That's a separate `/oauth/revoke`
 * call (out of scope for the admin UI).
 */
export async function revokeGrant(clientId: string): Promise<void> {
  const bearer = await getHostAdminToken();
  const res = await fetch(`/api/grants/${encodeURIComponent(clientId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
}

/**
 * `/api/me` wire shape. Matches `src/api-me.ts` verbatim — snake-case-free
 * because the field names are short and the JS consumers benefit more from
 * camelCase here than from a literal mirror.
 */
export interface MeSignedIn {
  hasSession: true;
  user: { id: string; displayName: string };
  /** Per-session CSRF token; submit as `__csrf` against /logout etc. */
  csrf: string;
}
export interface MeSignedOut {
  hasSession: false;
}
export type MeResponse = MeSignedIn | MeSignedOut;

/**
 * GET /api/me — public who-am-I. No Bearer needed (session-cookie aware
 * directly on the hub). Returns minimal `{ hasSession: false }` when no
 * session, full `{ hasSession: true, user, csrf }` when signed in.
 *
 * Used by App.tsx on mount to render the "Signed in as <name> · Sign out"
 * affordance in the nav, and by the sign-out flow to source the CSRF
 * token for the POST to /logout.
 */
export async function getMe(): Promise<MeResponse> {
  const res = await fetch("/api/me", {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as MeResponse;
}

/**
 * POST /logout — sign out the current session. Submits the CSRF token
 * as form-encoded `__csrf` (matches the existing logout handler's
 * `req.formData()` parser; sending JSON would require a handler change).
 *
 * On success, the browser is left without a session cookie; callers
 * typically navigate to / (discovery) to land on the signed-out
 * affordance immediately.
 */
export async function signOut(csrfToken: string): Promise<void> {
  const body = new URLSearchParams({ __csrf: csrfToken });
  const res = await fetch("/logout", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Don't follow the 302 the handler returns — the SPA navigates
      // itself after success so the post-logout target is in our hands,
      // not the server's.
      accept: "text/html, application/json",
    },
    credentials: "same-origin",
    body,
    redirect: "manual",
  });
  // The handler returns 302 → /login on success. `redirect: "manual"`
  // surfaces that as a network-level "opaqueredirect" with status 0;
  // any 2xx or 302 is a success signal here. 4xx is a real error.
  if (res.status === 0 || res.ok || res.status === 302) return;
  throw new HttpError(res.status, await readError(res));
}

/**
 * Resolve a vault's `managementUrl` against the vault's mounted URL.
 * Absolute URL → returned verbatim. Path → joined onto `vaultUrl` after
 * stripping the trailing slash so we don't double-slash.
 *
 * Exported for direct testing; `VaultsList` calls it before redirecting.
 */
export function resolveManagementUrl(vaultUrl: string, managementUrl: string): string {
  if (/^https?:\/\//i.test(managementUrl)) return managementUrl;
  const base = vaultUrl.replace(/\/+$/, "");
  const tail = managementUrl.startsWith("/") ? managementUrl : `/${managementUrl}`;
  return `${base}${tail}`;
}

/**
 * One row from `GET /api/auth/tokens`. Matches the wire shape from
 * `src/api-tokens.ts` exactly — snake_case fields, parsed `permissions`
 * (object, not raw JSON string — hub layer parses).
 */
export interface AdminTokenListing {
  jti: string;
  user_id: string | null;
  subject: string | null;
  client_id: string;
  scopes: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  created_via: string;
  permissions: Record<string, unknown> | null;
}

/** One page of tokens. `next_cursor` is null when we've walked to the end. */
export interface AdminTokensPage {
  tokens: AdminTokenListing[];
  next_cursor: string | null;
}

/** Mint-provenance values surfaced by the registry. Mirrors `TokenCreatedVia` server-side. */
export type AdminTokenCreatedVia = "oauth_refresh" | "operator_mint" | "cli_mint";

/** Filter knobs for `listTokens`. */
export interface ListTokensOpts {
  /** "true" → only revoked; "false" → only un-revoked; "all" or omit → both. */
  revoked?: "true" | "false" | "all";
  /** Exact match against either `user_id` (OAuth rows) or `subject` (mint rows). */
  subject?: string;
  /** Narrow by mint provenance (oauth_refresh / operator_mint / cli_mint). */
  createdVia?: AdminTokenCreatedVia;
  /** Cursor from a previous page's `next_cursor`. */
  cursor?: string;
}

/**
 * GET /api/auth/tokens — paginated list of registry rows. Same Bearer
 * pattern as `createVault` / `listGrants`.
 */
export async function listTokens(opts: ListTokensOpts = {}): Promise<AdminTokensPage> {
  const params = new URLSearchParams();
  if (opts.revoked) params.set("revoked", opts.revoked);
  if (opts.subject) params.set("subject", opts.subject);
  if (opts.createdVia) params.set("created_via", opts.createdVia);
  if (opts.cursor) params.set("cursor", opts.cursor);
  const query = params.toString();
  const url = query ? `/api/auth/tokens?${query}` : "/api/auth/tokens";

  const bearer = await getHostAdminToken();
  const res = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as AdminTokensPage;
}

/** Body shape for `POST /api/auth/mint-token`. Matches the hub-side handler. */
export interface MintTokenInput {
  scope: string;
  audience?: string;
  expires_in?: number;
  subject?: string;
  permissions?: Record<string, unknown>;
}

/** Successful mint response. The `token` is shown ONCE in the UI; never persisted. */
export interface MintedToken {
  jti: string;
  token: string;
  expires_at: string;
  scope: string;
  permissions?: Record<string, unknown>;
}

/**
 * POST /api/auth/mint-token — mint a scope-narrow access token. Same
 * Bearer pattern; the minted JWT comes back in the response body and
 * is the operator's only chance to copy it (no DB-side recovery).
 */
export async function mintToken(input: MintTokenInput): Promise<MintedToken> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/auth/mint-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(input),
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as MintedToken;
}

/**
 * POST /api/auth/revoke-token — flip `revoked_at` on the registry row
 * keyed by jti. Idempotent: re-revoking returns the original
 * `revoked_at`. UI surfaces this as a confirm-then-POST flow per row.
 */
export async function revokeToken(jti: string): Promise<{ jti: string; revoked_at: string }> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/auth/revoke-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jti }),
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as { jti: string; revoked_at: string };
}

/**
 * `GET /api/oauth/clients/<id>` response. Snake-case to mirror the
 * wire shape (and the underlying `clients` table columns). The SPA's
 * approve-client page renders these fields directly.
 */
export interface AdminClientView {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
  scopes: string[];
  status: "pending" | "approved";
  registered_at: string;
}

/**
 * GET /api/oauth/clients/<client_id> — fetch details for the
 * approve-client deep link. Bearer pattern matches other admin endpoints
 * (mint cached host-admin JWT, drop on 401/403). 404 surfaces verbatim so
 * the page can render "unknown client" instead of looping.
 */
export async function getOauthClient(clientId: string): Promise<AdminClientView> {
  const bearer = await getHostAdminToken();
  const res = await fetch(`/api/oauth/clients/${encodeURIComponent(clientId)}`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as AdminClientView;
}

/** Response shape from `POST /api/oauth/clients/<id>/approve`. */
export interface ApproveClientResult {
  client_id: string;
  status: "approved";
  /** True when the row was already approved before this call. Idempotent re-approve. */
  already_approved: boolean;
}

/**
 * POST /api/oauth/clients/<client_id>/approve — flip a pending client to
 * approved. Idempotent: a second call after the row is already approved
 * returns `already_approved: true` with no audit-log line.
 */
export async function approveOauthClient(clientId: string): Promise<ApproveClientResult> {
  const bearer = await getHostAdminToken();
  const res = await fetch(`/api/oauth/clients/${encodeURIComponent(clientId)}/approve`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  return (await res.json()) as ApproveClientResult;
}

/**
 * One row from `GET /api/modules`. Mirrors the snake_case wire shape
 * from `src/api-modules.ts`.
 */
export interface ModuleListing {
  short: string;
  package: string;
  display_name: string;
  tagline: string;
  available: boolean;
  installed: boolean;
  installed_version: string | null;
  latest_version: string | null;
  supervisor_status: "starting" | "running" | "stopped" | "crashed" | "restarting" | null;
  pid: number | null;
  install_dir: string | null;
}

/** Module install channel — `latest` (stable) or `rc` (release candidates). */
export type ModuleInstallChannel = "latest" | "rc";

/** Top-level shape from `GET /api/modules`. */
export interface ModulesCatalog {
  modules: ModuleListing[];
  /**
   * When false, install/restart/upgrade/uninstall actions are disabled
   * — the hub is in CLI mode (no supervisor wired) and the operator
   * should use `parachute install/upgrade/restart` from a shell.
   */
  supervisor_available: boolean;
  /**
   * Current module install channel (`latest` | `rc`). Drives the channel
   * toggle at the top of the page (hub#275). The SPA PUTs back to
   * `PUT /api/modules/channel` to change it.
   */
  module_install_channel: ModuleInstallChannel;
}

/**
 * GET /api/modules — read-side module catalog. Combines availability +
 * installed-version + supervisor state + npm @latest. Same Bearer
 * pattern as `listGrants` / `listTokens`.
 */
export async function listModules(): Promise<ModulesCatalog> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/modules", {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as ModulesCatalog;
}

/** Operation kinds returned by `POST /api/modules/:short/*`. */
export type ModuleOperationKind = "install" | "upgrade" | "restart" | "uninstall";
export type ModuleOperationStatus = "pending" | "running" | "succeeded" | "failed";

export interface ModuleOperation {
  id: string;
  kind: ModuleOperationKind;
  short: string;
  status: ModuleOperationStatus;
  log: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/** Sync action response shape (restart, uninstall). */
export interface ModuleActionResult {
  short: string;
  state?: { status: string; pid?: number };
  log?: string[];
}

async function postModuleAction(short: string, action: ModuleOperationKind): Promise<Response> {
  const bearer = await getHostAdminToken();
  return await fetch(`/api/modules/${encodeURIComponent(short)}/${action}`, {
    method: "POST",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
}

/**
 * POST /api/modules/:short/install — async. Returns the operation_id;
 * caller polls `getModuleOperation` until status is terminal.
 */
export async function installModule(short: string): Promise<string> {
  const res = await postModuleAction(short, "install");
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { operation_id: string };
  return body.operation_id;
}

/** POST /api/modules/:short/upgrade — async. Same shape as install. */
export async function upgradeModule(short: string): Promise<string> {
  const res = await postModuleAction(short, "upgrade");
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { operation_id: string };
  return body.operation_id;
}

/** POST /api/modules/:short/restart — synchronous. */
export async function restartModule(short: string): Promise<ModuleActionResult> {
  const res = await postModuleAction(short, "restart");
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as ModuleActionResult;
}

/** POST /api/modules/:short/uninstall — synchronous. */
export async function uninstallModule(short: string): Promise<ModuleActionResult> {
  const res = await postModuleAction(short, "uninstall");
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as ModuleActionResult;
}

/**
 * PUT /api/modules/channel — flip the operator-settable module install
 * channel (hub#275). Same Bearer + admin-scope pattern as the per-module
 * actions; returns the new channel verbatim.
 */
export async function setModuleChannel(
  channel: ModuleInstallChannel,
): Promise<ModuleInstallChannel> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/modules/channel", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ channel }),
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { channel: ModuleInstallChannel };
  return body.channel;
}

/**
 * GET /api/modules/operations/:id — poll for a long-running operation
 * kicked off by install or upgrade. Returns 404 (HttpError) when the
 * id is unknown / expired.
 */
export async function getModuleOperation(opId: string): Promise<ModuleOperation> {
  const bearer = await getHostAdminToken();
  const res = await fetch(`/api/modules/operations/${encodeURIComponent(opId)}`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as ModuleOperation;
}

/**
 * Wire shape from `GET /api/users` — multi-user Phase 1.
 *
 * `password_hash` is intentionally absent — the hub never returns it
 * over the wire. `password_changed: false` means the user was created
 * via the admin path and hasn't yet completed the force-change-password
 * flow on first sign-in (PR 3 of the multi-user chain).
 * `assigned_vault: null` means "no per-vault restriction" — the admin
 * posture; non-null pins the user to that vault.
 */
export interface UserListing {
  id: string;
  username: string;
  password_changed: boolean;
  assigned_vault: string | null;
  created_at: string;
}

/** Body shape for `POST /api/users`. */
export interface CreateUserInput {
  username: string;
  password: string;
  /** Vault to pin the user to. `null` = no restriction (admin-level). */
  assignedVault: string | null;
}

/**
 * GET /api/users — list every user account on the hub. `host:admin`
 * Bearer gate; same pattern as `listGrants` / `listTokens`. Sorted by
 * `created_at` ASC so the wizard-admin / env-seeded first admin lands
 * first — the SPA pins that row's "Delete" button disabled.
 */
export async function listUsers(): Promise<UserListing[]> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/users", {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { users: UserListing[] };
  return body.users ?? [];
}

/**
 * POST /api/users — admin creates a user with a default password +
 * optional vault assignment. Server runs the password through
 * argon2id; the plaintext lives only in this request body (TLS-
 * protected on the wire, never persisted). New users land with
 * `password_changed: false` and the force-change-password redirect at
 * `/login` (PR 3) re-routes them on first sign-in.
 */
export async function createUser(input: CreateUserInput): Promise<UserListing> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/users", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(input),
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { user: UserListing };
  return body.user;
}

/**
 * DELETE /api/users/:id — hard-delete + token revocation. Refuses to
 * delete the first-created admin (403 `first_admin_undeletable`) so the
 * hub can't be self-locked. The SPA also disables the row-level button
 * for that user as a UX hint, but the server check is authoritative.
 */
export async function deleteUser(id: string): Promise<void> {
  const bearer = await getHostAdminToken();
  const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401 || res.status === 403) {
    // 403 from this endpoint is *not* always an auth failure — it also
    // surfaces the first-admin-undeletable rail. Don't clear the cached
    // bearer in that case (a fresh mint won't help). The handler-level
    // 401/403 cache-clear stays only for the auth shapes.
    if (res.status === 401) clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
}

/**
 * GET /api/users/vaults — vault-name list for the assigned-vault
 * dropdown. Same `host:admin` gate. Sorted server-side; the SPA renders
 * options in that order plus a synthetic "No restriction" entry.
 */
export async function listUserVaults(): Promise<string[]> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/users/vaults", {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { vaults: string[] };
  return body.vaults ?? [];
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: string; error_description?: string };
    if (parsed.error_description) return parsed.error_description;
    if (parsed.error) return parsed.error;
    if (text) return text;
  } catch {
    // not JSON
  }
  return `${res.status} ${res.statusText}`;
}
