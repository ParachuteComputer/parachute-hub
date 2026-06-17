/**
 * HTTP client for the hub SPA. Two surfaces:
 *
 *   - `/.well-known/parachute.json` — public discovery doc (no auth).
 *   - `/api/*` + `/admin/*` JSON endpoints — require the
 *     `parachute:host:admin` Bearer (or the session cookie directly).
 *
 * The Bearer comes from `lib/auth.ts:getHostAdminToken()`, which trades
 * the `parachute_hub_session` cookie for a short-lived JWT. On 401 from
 * the admin endpoint after a fresh mint, the auth helper navigates the
 * browser to /admin/login — we don't try to recover.
 *
 * The `createVault` helper (POST /vaults) left with B5 (2026-06-09
 * hub-module-boundary migration): vault-creation UX is module-owned at
 * `/vault/admin/`. The hub endpoint survives as the transaction vault's
 * own surface drives; this SPA just no longer calls it.
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
 * Result shape from `listVaults`. Surfaces both the vault listings AND a
 * "did we even find a vault MODULE in services?" signal so the empty
 * state on `/admin/vaults` can distinguish:
 *
 *   - vault module installed, zero vaults yet → "Create your first vault" CTA
 *   - vault module not installed at all       → "Install vault first" CTA
 *     pointing at /admin/modules
 *
 * Pre-fix, both states rendered the same empty page and the operator
 * could spin trying to "Create" a vault when the underlying module wasn't
 * installed. Aaron hit this on the Render deploy walkthrough.
 */
export interface VaultsListResult {
  vaults: VaultListing[];
  /**
   * True when at least one services-array entry is a vault backend
   * (`parachute-vault` or `parachute-vault-<name>`). False on a hub
   * where the vault module has never been installed via the wizard
   * or `/admin/modules`.
   */
  moduleInstalled: boolean;
}

/**
 * Fetch the well-known discovery doc. Anonymous — no Bearer needed. The hub
 * serves this at the origin root with `Access-Control-Allow-Origin: *` so a
 * cross-origin SPA could read it too, but ours is same-origin.
 */
export async function listVaults(): Promise<VaultsListResult> {
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
  // The vault module is "installed" iff at least one service entry's
  // name matches the canonical `parachute-vault[-<instance>]` shape.
  // Mirrors `isVaultEntry` server-side (src/well-known.ts).
  const moduleInstalled = services.some(
    (s) => s.name === "parachute-vault" || s.name.startsWith("parachute-vault-"),
  );
  return {
    moduleInstalled,
    vaults: vaults.map((v) => {
      const listing: VaultListing = {
        name: v.name,
        url: v.url,
        version: v.version,
        path: pathFor(v.name, v.url, services),
      };
      if (v.managementUrl) listing.managementUrl = v.managementUrl;
      return listing;
    }),
  };
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
 * Per-vault usage stat surfaced in the VaultsList row. Subset of the vault's
 * `GET /vault/<name>/.parachute/usage` report (vault#437) — the full report
 * carries more (links, tags, db/assets/mirror byte breakdown), but the row only
 * needs note count + physical footprint.
 */
export interface VaultUsage {
  notes: number;
  /** Physical footprint bytes (`bytes.total` from the vault report). */
  totalBytes: number;
}

/**
 * Fetch one vault's usage report through the hub's `/vault/<name>/*` proxy.
 *
 * The endpoint is read-scoped; `parachute:host:admin` is NOT a vault scope and
 * vault would 403 it, so we mint a `vault:<name>:admin` bearer (admin ⊇ read)
 * via the existing session-cookie path — the same token the "Manage" button
 * uses. The VaultsList fans this out per row (N small requests) and tolerates
 * per-vault failure by rendering "—", so this throws on failure and the caller
 * swallows it; it deliberately does NOT redirect-on-401 (that's the Manage
 * button's job — a usage cell shouldn't hijack the page).
 */
export async function getVaultUsage(name: string): Promise<VaultUsage> {
  const minted = await mintVaultAdminToken(name);
  const res = await fetch(`/vault/${encodeURIComponent(name)}/.parachute/usage`, {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${minted.token}` },
  });
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  const body = (await res.json()) as {
    counts?: { notes?: unknown };
    bytes?: { total?: unknown };
  };
  const notes = body.counts?.notes;
  const totalBytes = body.bytes?.total;
  if (typeof notes !== "number" || typeof totalBytes !== "number") {
    throw new HttpError(500, "/.parachute/usage returned malformed body");
  }
  return { notes, totalBytes };
}

/** Human-readable byte size — B / KB / MB / GB, one decimal for MB+. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
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
 * Same Bearer pattern as the other admin helpers: a 401/403 dumps the cached token so
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

/** One-time deprecation log for the legacy `"/admin/"` managementUrl (B4 compat shim). */
let warnedLegacyManagementUrl = false;

/**
 * Resolve a vault's `managementUrl` against the vault's mounted URL.
 * Unified URL-resolution semantics (B4 of the 2026-06-09 hub-module-boundary
 * migration) — mirrors `resolveManagementUrl` in the hub's
 * `src/account-vault-admin-token.ts` so SPA and hub-server deep-links agree:
 *
 *   - Absolute http(s) URL → verbatim.
 *   - Leading-`/` path → ORIGIN-ABSOLUTE: resolved against the vault URL's
 *     origin (not joined under the vault mount).
 *   - Relative path (no leading slash, e.g. `"admin/"`) → the PER-INSTANCE
 *     form: joined onto `vaultUrl` after stripping the trailing slash.
 *
 * COMPAT SHIM (one release — remove once vault's new manifest reaches
 * @latest): the literal legacy `"/admin"`/`"/admin/"` is the OLD per-instance
 * relative declaration deployed vaults still ship; it joins under the vault
 * URL (the pre-B4 behavior) with a one-time deprecation log.
 *
 * Exported for direct testing; `VaultsList` calls it before redirecting.
 */
export function resolveManagementUrl(vaultUrl: string, managementUrl: string): string {
  if (/^https?:\/\//i.test(managementUrl)) return managementUrl;
  const base = vaultUrl.replace(/\/+$/, "");
  if (managementUrl === "/admin" || managementUrl === "/admin/") {
    if (!warnedLegacyManagementUrl) {
      warnedLegacyManagementUrl = true;
      console.warn(
        `resolveManagementUrl: vault declares the legacy per-instance managementUrl ${JSON.stringify(managementUrl)}; joining under the vault URL for one release. New semantics: relative ("admin/") = per-instance join, leading-"/" = origin-absolute.`,
      );
    }
    return `${base}${managementUrl}`;
  }
  if (managementUrl.startsWith("/")) {
    return new URL(managementUrl, `${base}/`).toString();
  }
  return `${base}/${managementUrl}`;
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
 * pattern as `listGrants`.
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
  /**
   * Hub-relative `/oauth/authorize?...` URL the caller passed as
   * `return_to`, echoed back when it passes the server's same-origin gate
   * (`isSafeAuthorizeReturnTo` in oauth-handlers.ts). Workstream D — lets
   * the SPA approve page resume a parked OAuth flow rather than dead-end
   * on the "return to the app" success state. Absent for the share-link
   * case (no `return_to` passed, or off-origin value dropped server-side).
   */
  redirect_to?: string;
}

/**
 * POST /api/oauth/clients/<client_id>/approve — flip a pending client to
 * approved. Idempotent: a second call after the row is already approved
 * returns `already_approved: true` with no audit-log line.
 *
 * Optional `returnTo` (workstream D): when present and same-origin-safe
 * (a hub-relative `/oauth/authorize?...` URL), the server echoes it back
 * as `redirect_to` and the SPA navigates the browser there to resume the
 * parked OAuth flow. The SPA validates same-origin before passing the
 * value through; the server runs the same gate again before echoing.
 * Off-origin or non-authorize values silently drop off the response —
 * the bad value doesn't fail the approve, the SPA falls back to its
 * dead-end success state.
 */
export async function approveOauthClient(
  clientId: string,
  returnTo?: string,
): Promise<ApproveClientResult> {
  const bearer = await getHostAdminToken();
  const init: RequestInit = {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
  };
  // Send a JSON body iff the caller supplied `returnTo`. Pre-D callers
  // (and the share-link case) pass no body; the server treats absent /
  // empty bodies identically to "no return_to" and returns the dead-end-
  // compatible shape.
  if (returnTo !== undefined) {
    init.headers = {
      ...init.headers,
      "content-type": "application/json",
    };
    init.body = JSON.stringify({ return_to: returnTo });
  }
  const res = await fetch(`/api/oauth/clients/${encodeURIComponent(clientId)}/approve`, init);
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
 * Status of a hosted UI sub-unit, mirrors `UiSubUnitStatus` server-side.
 * Workstream F (design-system.md §6) aligned this with the unified
 * four-state vocabulary; pre-F values (`pending-oauth`, `disabled`) are
 * still accepted on the wire for one release window and the SPA normalizes
 * them via `lib/state.ts:unifiedStateForUi` at render time.
 *
 * Absent (null) → discovery treats as "active".
 */
export type UiSubUnitStatus =
  | "active"
  | "pending"
  | "inactive"
  | "failing"
  // Back-compat aliases — accepted on the wire during the F-landing
  // release window so rows from a not-yet-restarted older module still
  // render. Retire after the next rc chain.
  | "pending-oauth"
  | "disabled";

/**
 * One sub-unit beneath a module — surfaced on `ModuleListing.uis` when the
 * underlying services.json row declares a `uis` map. Snake-case to mirror
 * the wire shape from `src/api-modules.ts:UiSubUnitWireShape`. See
 * parachute-app design doc §12 for the canonical use case (per-UI rows
 * under the App module).
 */
export interface ModuleUiSubUnit {
  name: string;
  display_name: string;
  path: string;
  tagline: string | null;
  icon_url: string | null;
  version: string | null;
  oauth_client_id: string | null;
  status: UiSubUnitStatus | null;
}

/**
 * One row from `GET /api/modules`. Mirrors the snake_case wire shape
 * from `src/api-modules.ts`.
 */
/** Discovery tier — `core` (headline group) or `experimental` (de-emphasized). */
export type ModuleFocus = "core" | "experimental";

export interface ModuleListing {
  short: string;
  package: string;
  display_name: string;
  tagline: string;
  /**
   * Discovery tier (2026-06-09 modular-UI architecture). `core` modules render
   * in the headline group; `experimental` modules render de-emphasized in a
   * separate group — never hidden. Resolved server-side from the module's
   * `module.json` `focus` (when declared) else hub's default tier map.
   */
  focus: ModuleFocus;
  available: boolean;
  installed: boolean;
  installed_version: string | null;
  latest_version: string | null;
  supervisor_status: "starting" | "running" | "stopped" | "crashed" | "restarting" | null;
  pid: number | null;
  install_dir: string | null;
  /**
   * Hierarchical sub-units (hub#313). Empty when the row doesn't declare
   * `uis` — most modules today. parachute-app's App module is the first
   * consumer; the SPA renders each entry as an expandable sub-row.
   */
  uis: ModuleUiSubUnit[];
  /**
   * Canonical user-facing URL for this module's own UI (hub#342). Drives
   * the Modules page's "Open" button. Resolved server-side from the
   * module's `.parachute/module.json` (`managementUrl` ?? `uiUrl`)
   * joined against its mount path. Null when the module hasn't declared
   * either field — SPA renders a disabled-with-tooltip "Open" button
   * pointing at the per-module follow-up issue.
   *
   * The collapse of Open + Configure into a single button is the
   * architectural through-line: each module ships its own UI handling
   * both viewing AND configuring; hub becomes a dispatcher to that UI.
   */
  management_url: string | null;
  /**
   * The module's OWN config/admin surface (2026-06-09 modular-UI architecture,
   * P3). Resolved server-side from `module.json`'s `configUiUrl`, joined
   * against the module's mount. Drives the consistent **Configure** action on
   * the Modules page — clicking opens the module-owned config UI (e.g.
   * `/channel/admin`), which mints its admin Bearer from the hub's cookie-gated
   * `/admin/module-token/<short>` (or `/admin/channel-token`). Null when the
   * module hasn't declared `configUiUrl` — the SPA omits the Configure action.
   *
   * Distinct from `management_url`: a module may declare one, both, or neither.
   * No more hub-hosted generic config form — config is module-owned + hub-framed.
   */
  config_ui_url: string | null;
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

/**
 * Structured missing-dependency error wire (matches the hub's
 * `@openparachute/depcheck` `MissingDependencyWire` + `proxy-error-ui.ts`
 * envelope). When an install/op fails because a required external binary
 * (`bun` / `git` / …) isn't on PATH, the operation carries this so the SPA
 * renders a dedicated install card instead of a raw error string.
 */
export interface MissingDependencyWire {
  error: "missing_dependency";
  error_type: "missing_dependency";
  error_description: string;
  binary: string;
  why: string | null;
  docs_url: string | null;
  install: { darwin?: string; linux?: string; generic?: string };
  sysadmin_hint: string;
}

export interface ModuleOperation {
  id: string;
  kind: ModuleOperationKind;
  short: string;
  status: ModuleOperationStatus;
  log: string[];
  error?: string;
  /** Structured error detail for typed failures (today: missing_dependency). */
  error_detail?: MissingDependencyWire;
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
 * Where the resolved hub issuer came from — drives the source label
 * on /admin/settings. Mirrors `IssuerSource` in src/hub-server.ts.
 */
export type IssuerSource = "settings" | "env" | "expose" | "request";

/**
 * Response shape from `GET /api/settings/hub-origin` (hub#298). Carries
 * three pieces:
 *
 *   - `hub_origin` — the value stored in hub_settings (or null when
 *     unset). Drives the input field's pre-fill.
 *   - `resolved_issuer` — the issuer URL hub will stamp on JWTs minted
 *     by this request (precedence-aware). Drives the "current value"
 *     readout.
 *   - `source` — which precedence layer the resolved value came from.
 *     Drives the source label so operators can tell apart settings vs
 *     env vs request origin.
 */
export interface HubOriginSetting {
  hub_origin: string | null;
  resolved_issuer: string;
  source: IssuerSource;
}

/**
 * GET /api/settings/hub-origin — read the operator-set canonical hub
 * URL + the currently-resolved issuer for the request.
 */
export async function getHubOriginSetting(): Promise<HubOriginSetting> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/settings/hub-origin", {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as HubOriginSetting;
}

/**
 * PUT /api/settings/hub-origin — set or clear the operator-set
 * canonical hub URL. Passing `null` clears the stored value and
 * reverts to env / request-origin precedence on subsequent requests.
 * Server-side validation runs the same shape as `validateHubOrigin`
 * in src/api-settings-hub-origin.ts (https?: scheme, hostname, no
 * trailing slash / path / query / fragment) — the SPA shows the
 * server's 400 error_description verbatim rather than duplicating
 * validation here.
 */
export async function setHubOriginSetting(hubOrigin: string | null): Promise<string | null> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/settings/hub-origin", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ hub_origin: hubOrigin }),
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { hub_origin: string | null };
  return body.hub_origin;
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
 * Wire shape from `GET /api/users` — multi-user Phase 2 PR 2.
 *
 * `password_hash` is intentionally absent — the hub never returns it
 * over the wire. `password_changed: false` means the user was created
 * via the admin path and hasn't yet completed the force-change-password
 * flow on first sign-in. `assigned_vaults` lists every vault this user
 * has access to (empty array = "no narrowing" for admin posture, or
 * "no access" for non-admins). Replaces the Phase 1 single-vault
 * `assigned_vault: string | null` shape.
 */
export interface UserListing {
  id: string;
  username: string;
  password_changed: boolean;
  assigned_vaults: string[];
  created_at: string;
}

/** Body shape for `POST /api/users`. */
export interface CreateUserInput {
  username: string;
  password: string;
  /** Vault names to grant the user access to. Empty array = no narrowing. */
  assignedVaults: string[];
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
 *
 * Returns `{ revocationLagSeconds }` — same shape + rationale as
 * `resetUserPassword`. A successful delete revokes the user's tokens, but
 * resource servers cache the revocation list for ~60s; surface the lag so
 * the SPA can warn the admin (consistency with the reset-password banner).
 * The server's race-tolerant "row already gone" path returns a bodyless
 * 204; we default to 60 when there's no body to parse.
 */
export async function deleteUser(id: string): Promise<{ revocationLagSeconds: number }> {
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
  // 200 carries `{ ok, revocation_lag_seconds }`; the race-path 204 has no
  // body. Default to 60 (the server constant) when missing — same posture
  // as `resetUserPassword`.
  const body = (await res.json().catch(() => ({}))) as { revocation_lag_seconds?: number };
  const lag = typeof body.revocation_lag_seconds === "number" ? body.revocation_lag_seconds : 60;
  return { revocationLagSeconds: lag };
}

/**
 * POST /api/users/:id/reset-password — admin sets a new temp password
 * for a non-admin user (multi-user Phase 2 PR 1). The server flips
 * `password_changed` back to false so the user is force-redirected
 * through `/account/change-password` on their next sign-in. The first
 * admin can't be reset this way (server returns 403
 * `cannot_reset_first_admin` — admin self-service uses
 * `/account/change-password` directly).
 *
 * Same `host:admin` Bearer pattern as the other /api/users surfaces.
 * 403 here is NOT always an auth failure (the cannot_reset_first_admin
 * rail also surfaces as 403); we don't clear the cached bearer in
 * that case — same posture as `deleteUser` for the
 * first_admin_undeletable rail.
 */
export async function resetUserPassword(
  userId: string,
  newPassword: string,
): Promise<{ revocationLagSeconds: number }> {
  const bearer = await getHostAdminToken();
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/reset-password`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ new_password: newPassword }),
  });
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  // The server returns `revocation_lag_seconds: 60` reflecting the
  // scope-guard cache TTL on resource servers. Surface it to the caller
  // so the UI banner stays in sync with the server's constant — one
  // source of truth, not a third hardcoded copy in the SPA.
  // Default to 60 if the field is missing (older server or unparseable
  // response — better than failing the whole reset flow).
  const body = (await res.json().catch(() => ({}))) as { revocation_lag_seconds?: number };
  const lag = typeof body.revocation_lag_seconds === "number" ? body.revocation_lag_seconds : 60;
  return { revocationLagSeconds: lag };
}

/**
 * PATCH /api/users/:id/vaults — replace a user's vault assignments
 * (multi-user Phase 2 PR 2). Empty array clears every grant. Server
 * validates each name against services.json and refuses for the first
 * admin (403 `cannot_edit_first_admin_vaults`). Same Bearer pattern as
 * `resetUserPassword`.
 */
export async function updateUserVaults(userId: string, assignedVaults: string[]): Promise<void> {
  const bearer = await getHostAdminToken();
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/vaults`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ assigned_vaults: assignedVaults }),
  });
  if (res.status === 401 || res.status === 403) {
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

// ---------------------------------------------------------------------------
// Invite links (design §7). host:admin-gated; same Bearer pattern as users.
// ---------------------------------------------------------------------------

export type InviteStatus = "pending" | "redeemed" | "expired" | "revoked";

/** Wire shape from `GET /api/invites`. `id` is the sha256 hash, NOT the raw token. */
export interface InviteListing {
  id: string;
  status: InviteStatus;
  vault_name: string | null;
  /** Pre-named username the redeemer's account gets (enforced), or null. */
  username: string | null;
  role: string;
  provision_vault: boolean;
  default_mirror: string | null;
  expires_at: string;
  used_at: string | null;
  redeemed_user_id: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** Body for `POST /api/invites`. Every field is optional (server defaults apply). */
export interface CreateInviteInput {
  vault_name?: string | null;
  /** Pre-name the redeemer's username (enforced at redemption). */
  username?: string | null;
  /** `'write'` (owner) | `'read'` (read-only; shared-vault invites only). */
  role?: string;
  provision_vault?: boolean;
  default_mirror?: "internal" | "off" | null;
  expires_in?: number;
}

/** `POST /api/invites` response — the raw token + URL are emitted ONCE here. */
export interface CreatedInvite {
  invite: InviteListing;
  token: string;
  url: string;
}

/** GET /api/invites — list invites, newest first, status-annotated. */
export async function listInvites(): Promise<InviteListing[]> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/invites", {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { invites: InviteListing[] };
  return body.invites ?? [];
}

/**
 * POST /api/invites — create an invite. The response carries the raw token +
 * full redemption URL, which the hub never stores and never returns again —
 * the caller must surface them once.
 */
export async function createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/invites", {
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
  return (await res.json()) as CreatedInvite;
}

/** DELETE /api/invites/:id — revoke a pending invite by its sha256 id. */
export async function revokeInvite(id: string): Promise<void> {
  const bearer = await getHostAdminToken();
  const res = await fetch(`/api/invites/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
}

/**
 * Wire shape returned by `GET /api/hub`. Mirrors the snake_case payload
 * defined in `src/api-hub.ts:HubStatusResponse`. Drives the admin SPA's
 * version badge.
 */
export type HubStatusSource = "bun-linked" | "npm" | "container" | "unknown";

export interface HubStatus {
  version: string;
  started_at: string;
  uptime_ms: number;
  source: HubStatusSource;
  bun_linked_path?: string;
  git_head?: string;
  container_build_time?: string;
  /** Render-set runtime env vars surfaced when running on Render. */
  render_commit?: string;
  render_branch?: string;
}

/**
 * GET /api/hub — read hub runtime info for the admin SPA's version badge.
 * Same `parachute:host:admin` Bearer pattern as the other read endpoints.
 *
 * On 401/403 the badge collapses to a non-rendered state — see
 * `HubVersionBadge` for the swallow-and-render-empty contract. We surface
 * a typed null here so callers don't have to catch.
 */
export async function getHubStatus(): Promise<HubStatus> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/hub", {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as HubStatus;
}

/**
 * SPA-driven hub self-upgrade (design 2026-06-01 §5.3 / D4). The hub is NOT a
 * supervised module, so it has a dedicated endpoint pair:
 *   - POST /api/hub/upgrade        → 202 { operation_id, target_version, channel, mode }
 *   - GET  /api/hub/upgrade/status → poll the on-disk status the detached helper writes
 *
 * `mode` is the §5.3 in-place-vs-redeploy detection: `in-place` means the hub
 * was rewritten + (about to be) restarted; `redeploy-required` means the hub is
 * image-pinned (Render/Fly) and the operator must redeploy from their dashboard
 * — the SPA shows that instead of a false "upgraded."
 */
export type HubUpgradeMode = "in-place" | "redeploy-required";
export type HubUpgradeChannel = "rc" | "latest";

export interface HubUpgradeAccepted {
  operation_id: string;
  target_version: string | null;
  channel: HubUpgradeChannel;
  mode: HubUpgradeMode;
}

export type HubUpgradePhase =
  | "pending"
  | "running"
  | "restarting"
  | "succeeded"
  | "failed"
  | "redeploy-required";

export interface HubUpgradeStatus {
  operation_id: string;
  phase: HubUpgradePhase;
  mode: HubUpgradeMode;
  current_version: string;
  target_version: string | null;
  channel: HubUpgradeChannel;
  log: string[];
  error?: string;
  started_at: string;
  finished_at?: string;
}

/**
 * POST /api/hub/upgrade — kick off the hub self-upgrade. Returns the 202 body.
 * The optional `channel` is the closed enum the backend validates (rc|latest);
 * omit it to let the hub auto-detect from its current version.
 */
export async function startHubUpgrade(channel?: HubUpgradeChannel): Promise<HubUpgradeAccepted> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/hub/upgrade", {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
      ...(channel ? { "content-type": "application/json" } : {}),
    },
    ...(channel ? { body: JSON.stringify({ channel }) } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as HubUpgradeAccepted;
}

/**
 * GET /api/hub/upgrade/status — poll the on-disk upgrade status. Returns null
 * when no upgrade has been started (404) — the SPA treats that as "idle." A
 * network error during the hub restart is expected (the hub is down); callers
 * should swallow it and keep polling `/health` + `/api/hub` for the new version.
 */
export async function getHubUpgradeStatus(): Promise<HubUpgradeStatus | null> {
  const bearer = await getHostAdminToken();
  const res = await fetch("/api/hub/upgrade/status", {
    method: "GET",
    headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
  });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    clearCachedToken();
    throw new HttpError(res.status, await readError(res));
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as HubUpgradeStatus;
}

// (The Channels api helpers — listChannels / provisionChannel / deleteChannel
// against the bespoke `/admin/channels` endpoint — were retired in boundary D1
// along with the endpoint; the Connections helpers below are the successor.)

// ---------------------------------------------------------------------------
// Admin screen-lock (optional idle PIN lock for the admin UI).
//
// These talk to `/api/admin-lock*` with the session cookie directly (NOT the
// host-admin Bearer) — the Bearer mint is exactly what the lock blocks, so the
// lock-management surface must not depend on it. The POSTs carry the CSRF token
// from `/api/me` and an Origin header (the browser adds it automatically) to
// pass the server's same-origin belt.
// ---------------------------------------------------------------------------

/** Status from `GET /api/admin-lock`. */
export interface AdminLockStatus {
  /** True when a PIN is set (feature ON). False = today's behavior, no lock. */
  configured: boolean;
  /** True when configured AND this session isn't within an unlock window. */
  locked: boolean;
  /** Idle window before re-lock, in seconds. */
  idle_seconds: number;
  /** Seconds left in the current unlock window (0 when locked). */
  unlock_seconds_remaining: number;
}

/** GET /api/admin-lock — read lock state for this session. Session-cookie auth. */
export async function getAdminLockStatus(): Promise<AdminLockStatus> {
  const res = await fetch("/api/admin-lock", {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (res.status === 401) return redirectToLoginAndHang<AdminLockStatus>();
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as AdminLockStatus;
}

async function postAdminLock(
  subpath: string,
  csrf: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return await fetch(`/api/admin-lock${subpath}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ __csrf: csrf, ...body }),
  });
}

/** POST /api/admin-lock/unlock — verify the PIN, open an unlock window. */
export async function unlockAdmin(csrf: string, pin: string): Promise<AdminLockStatus> {
  const res = await postAdminLock("/unlock", csrf, { pin });
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  await res.json().catch(() => ({}));
  return getAdminLockStatus();
}

/** POST /api/admin-lock/lock — "Lock now". */
export async function lockAdminNow(csrf: string): Promise<void> {
  const res = await postAdminLock("/lock", csrf);
  if (!res.ok) throw new HttpError(res.status, await readError(res));
}

/** POST /api/admin-lock/heartbeat — slide the idle window forward on activity. */
export async function adminLockHeartbeat(csrf: string): Promise<AdminLockStatus> {
  const res = await postAdminLock("/heartbeat", csrf);
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  return (await res.json()) as AdminLockStatus;
}

/** POST /api/admin-lock/set — set the FIRST PIN (no PIN configured yet). */
export async function setAdminLockPin(
  csrf: string,
  pin: string,
  idleSeconds?: number,
): Promise<void> {
  const body: Record<string, unknown> = { pin };
  if (idleSeconds !== undefined) body.idle_seconds = idleSeconds;
  const res = await postAdminLock("/set", csrf, body);
  if (!res.ok) throw new HttpError(res.status, await readError(res));
}

/** POST /api/admin-lock/change — rotate the PIN (current PIN or unlocked session). */
export async function changeAdminLockPin(
  csrf: string,
  newPin: string,
  currentPin?: string,
  idleSeconds?: number,
): Promise<void> {
  const body: Record<string, unknown> = { new_pin: newPin };
  if (currentPin) body.current_pin = currentPin;
  if (idleSeconds !== undefined) body.idle_seconds = idleSeconds;
  const res = await postAdminLock("/change", csrf, body);
  if (!res.ok) throw new HttpError(res.status, await readError(res));
}

/** POST /api/admin-lock/remove — turn the feature OFF (current PIN or unlocked session). */
export async function removeAdminLockPin(csrf: string, currentPin?: string): Promise<void> {
  const body: Record<string, unknown> = {};
  if (currentPin) body.current_pin = currentPin;
  const res = await postAdminLock("/remove", csrf, body);
  if (!res.ok) throw new HttpError(res.status, await readError(res));
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

// ---------------------------------------------------------------------------
// Connections (the general module event→action engine, modular-UI P5).
// `/api/connections/catalog` lists available events/actions across installed
// modules; `/admin/connections` builds/lists/removes connections. All
// session-cookie-gated (first-admin), same posture as Channels above.
// ---------------------------------------------------------------------------

/** One event a module emits (catalog left-hand side). */
export interface CatalogEvent {
  module: string;
  key: string;
  title: string;
  /** Optional JSON Schema describing the per-event filter the operator may set. */
  filterSchema: unknown;
}

/** One action a module accepts (catalog right-hand side — the sink). */
export interface CatalogAction {
  module: string;
  key: string;
  title: string;
  inputSchema: unknown;
  /** Opaque provision descriptor, e.g. `{ type: "vault-trigger" }`. */
  provision: unknown;
}

/**
 * One declared parameter of a connection preset — the operator-chosen blank
 * (e.g. WHICH vault, the channel name).
 */
export interface CatalogTemplateParameter {
  key: string;
  /** Where the value lands: `source.vault` or `sink.params.<key>` today. */
  target: string;
  title: string | null;
  description: string | null;
  /** Optional pre-fill example for the builder. */
  example: string | null;
}

/**
 * A connection preset a module declares in its `module.json`
 * `connectionTemplates` (boundary D2). The builder renders one preset button
 * per template — declaration-driven; nothing module-specific lives in the SPA.
 */
export interface CatalogTemplate {
  /** Short of the declaring module. */
  module: string;
  key: string;
  title: string;
  description: string | null;
  requestedBy: string | null;
  source: { module: string; event: string; filter: unknown };
  sink: { module: string; action: string };
  parameters: CatalogTemplateParameter[];
}

export interface ConnectionsCatalog {
  events: CatalogEvent[];
  actions: CatalogAction[];
  /** Declared presets. Empty on hubs/modules predating connectionTemplates. */
  templates: CatalogTemplate[];
}

/** A provisioned connection (the list/wire shape from `/admin/connections`). */
export interface ConnectionListing {
  id: string;
  /** `"credential"` = a standing module credential (H4); absent = event→action. */
  kind?: string;
  /**
   * Approval state (surface#113 claim/reconcile). `"pending"` = a
   * module-initiated claim for a directly-delivered credential awaiting the
   * operator's one-click approve; absent = active.
   */
  status?: string;
  source: {
    module: string;
    vault?: string;
    event: string;
    filter?: Record<string, unknown>;
  };
  sink: {
    module: string;
    action: string;
    params?: Record<string, unknown>;
  };
  provisioned: { type: string; vault?: string; triggerName?: string; scope?: string };
  created_at: string;
  /**
   * Provenance — WHO requested this connection (modular-UI R2). `"custom"` for a
   * connection built by hand in this builder; a module short name (e.g.
   * `"channel"`) when a module-owned config UI created it on the operator's
   * behalf. Always present on the GET wire shape (the server defaults pre-R2
   * records to `"custom"`); optional here for resilience to older responses.
   */
  requested_by?: string;
}

/** Connect lines returned when the sink is a channel-deliver action. */
export interface ConnectionConnect {
  mcpAdd: string;
  launch: string;
}

/** `POST /admin/connections` success body. */
export interface CreatedConnection {
  connection: ConnectionListing;
  connect?: ConnectionConnect;
}

/** GET /api/connections/catalog — events + actions across installed modules. */
export async function getConnectionsCatalog(): Promise<ConnectionsCatalog> {
  const res = await fetch("/api/connections/catalog", {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (res.status === 401) return redirectToLoginAndHang<ConnectionsCatalog>();
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { events?: unknown; actions?: unknown; templates?: unknown };
  const events = Array.isArray(body.events) ? (body.events as CatalogEvent[]) : [];
  const actions = Array.isArray(body.actions) ? (body.actions as CatalogAction[]) : [];
  // Tolerant default — a hub predating connectionTemplates omits the field.
  const templates = Array.isArray(body.templates) ? (body.templates as CatalogTemplate[]) : [];
  return { events, actions, templates };
}

/** GET /admin/connections — list provisioned connections. */
export async function listConnections(): Promise<ConnectionListing[]> {
  const res = await fetch("/admin/connections", {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (res.status === 401) return redirectToLoginAndHang<ConnectionListing[]>();
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as { connections?: unknown };
  return Array.isArray(body.connections) ? (body.connections as ConnectionListing[]) : [];
}

/** POST /admin/connections — build a connection. */
export async function createConnection(input: {
  id?: string;
  source: { module: string; vault?: string; event: string; filter?: Record<string, unknown> };
  sink: { module: string; action: string; params?: Record<string, unknown> };
}): Promise<CreatedConnection> {
  const res = await fetch("/admin/connections", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  if (res.status === 401) return redirectToLoginAndHang<CreatedConnection>();
  if (!res.ok) throw new HttpError(res.status, await readError(res));
  const body = (await res.json()) as {
    connection?: ConnectionListing;
    connect?: ConnectionConnect;
  };
  if (!body.connection || typeof body.connection.id !== "string") {
    throw new HttpError(500, "/admin/connections returned a malformed connection body");
  }
  return { connection: body.connection, ...(body.connect ? { connect: body.connect } : {}) };
}

/**
 * POST /admin/connections/:id/approve — activate a pending credential claim
 * (surface#113). Mints and delivers nothing; the module already holds the
 * credential — approval only enables its renewal.
 */
export async function approveConnection(id: string): Promise<void> {
  const res = await fetch(`/admin/connections/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (res.status === 401) {
    await redirectToLoginAndHang<void>();
    return;
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
}

/** DELETE /admin/connections/:id — tear a connection down (best-effort). */
export async function deleteConnection(id: string): Promise<void> {
  const res = await fetch(`/admin/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (res.status === 401) {
    await redirectToLoginAndHang<void>();
    return;
  }
  // 207 = partial teardown; surface the residue so the operator knows.
  if (res.status === 207) {
    let detail = "connection teardown partially failed";
    try {
      const body = (await res.json()) as { errors?: Array<{ step?: string; detail?: string }> };
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        detail = body.errors.map((e) => `${e.step ?? "step"}: ${e.detail ?? "failed"}`).join("; ");
      }
    } catch {
      // keep the generic message
    }
    throw new HttpError(207, detail);
  }
  if (!res.ok) throw new HttpError(res.status, await readError(res));
}
