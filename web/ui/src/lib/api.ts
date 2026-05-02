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
import { clearCachedToken, getHostAdminToken } from "./auth.ts";

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
 * On 401 the operator's session is gone; we surface the error so the
 * caller can hand off to /admin/login.
 */
export async function mintVaultAdminToken(name: string): Promise<MintedVaultAdminToken> {
  const res = await fetch(`/admin/vault-admin-token/${encodeURIComponent(name)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
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
