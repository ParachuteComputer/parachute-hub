/**
 * The normalized `/account/*` door contract — the route table both doors mount
 * (self-host hub H2 `src/account-api.ts`, hosted cloud C3
 * `workers/identity/src/account-api.ts`). Today the contract lives only in prose
 * in each file; this is the machine-readable spec both twins can assert against.
 *
 * Auth posture: `Authorization: Bearer <account token>`; every route gates on an
 * account scope (`read` for GETs, `admin` for mutations) via the grammar in
 * `scopes.ts`. The account id comes from the TOKEN, never a request body — a
 * token for account A can only ever act on account A's vaults.
 */

import type { AccountVerb } from "./scopes.js";

/** One row of the `/account/*` contract. `path` is a template (`<name>` slot). */
export interface AccountRoute {
  method: "GET" | "POST" | "DELETE" | "PUT";
  path: string;
  /** The minimum account verb the route requires. */
  scope: AccountVerb;
  summary: string;
  /**
   * When `true`, this route is not mounted by every door — a door may omit it
   * without breaking the contract (e.g. it's superseded, or the door's
   * equivalent lives elsewhere). Absent/`false` = every door mounts this route.
   */
  optional?: boolean;
}

/**
 * The `/account/*` route table. Both doors wrap their own machinery behind these
 * routes; the shape here is the contract, not an implementation.
 */
export const ACCOUNT_ROUTES: readonly AccountRoute[] = [
  {
    method: "GET",
    path: "/account",
    scope: "read",
    summary: "Account bootstrap (id, email, door).",
    // Optional: hub-only. Cloud routes a browser GET /account to the SPA
    // shell (the app's Account screen), not a worker JSON handler (#146) — the
    // app bootstraps via GET /account/session + GET /account/summary instead.
    optional: true,
  },
  {
    method: "GET",
    path: "/account/vaults",
    scope: "read",
    summary: "List the account's vaults + usage.",
  },
  {
    method: "POST",
    path: "/account/vaults",
    scope: "admin",
    summary: "Create a vault (plan vault-count capped).",
  },
  {
    method: "DELETE",
    path: "/account/vaults/<name>",
    scope: "admin",
    summary: "Delete a vault the account owns.",
  },
  {
    method: "POST",
    path: "/account/vaults/<name>/token",
    scope: "admin",
    summary: "Mint a per-vault access token for an owned vault.",
  },
  {
    method: "GET",
    path: "/account/vaults/<name>/caps",
    scope: "read",
    summary: "Read a vault's storage caps.",
    // Optional: hub-only. Cloud's caps are plan-derived (no per-vault storage
    // cap knob to read back) — there is nothing for cloud to mount here.
    optional: true,
  },
  {
    method: "PUT",
    path: "/account/vaults/<name>/caps",
    scope: "admin",
    summary: "Set a vault's storage caps.",
    // Optional: hub-only, same reason as the GET above.
    optional: true,
  },
] as const;

/** One plan/tier the door advertises (cloud's `PLAN_SPECS`; empty for self-host). */
export interface AccountPlanSummary {
  /** Stable plan id (e.g. `"entry"`). */
  id: string;
  /** Human label (e.g. `"Entry"`). */
  name: string;
  /** Max vaults this plan allows. */
  vaults: number;
  /** Monthly price in whole USD; `0`/omitted = free or self-host. */
  price_month?: number;
}

/** Which account-lifecycle operations the door's `/account/*` API supports. */
export interface AccountCapabilities {
  /** `POST /account/vaults` creates a vault. */
  vault_create: boolean;
  /**
   * A vault's canonical name can change after creation. Cloud: `false` — the
   * vault `name` is the immutable global slug / DO address / URL (a future
   * rename would set a separate mutable display name, never the slug).
   */
  vault_rename: boolean;
  /** `DELETE /account/vaults/<name>` tears a vault down (cloud v1: `false`). */
  vault_delete: boolean;
}

/**
 * How a person signs IN at this door — drives the app's front-door branch
 * (magic-link email form vs a ceremony-hop card to the door's own sign-in page).
 */
export interface AccountAuthDescriptor {
  /** Sign-in methods, most-preferred first. */
  methods: ("magic_link" | "password")[];
  /** Absolute path of the door's sign-in ceremony; honors `?next=<path>`. */
  signin_path: string;
}

/**
 * The public descriptor served at `GET /.well-known/parachute-account` — the
 * door's self-description a client fetches to learn where to sign up, where the
 * account API lives, which first-party client to use, and what the door can do.
 * Both doors serve their own instance (cloud advertises `signup_path:"/signup"`,
 * the self-host hub `"/account/setup"`); clients read `signup_path` etc. rather
 * than hardcoding. Public + wildcard-CORS, no auth.
 */
export interface ParachuteAccountDescriptor {
  /** The account door's issuer origin (no trailing slash). */
  issuer: string;
  /** Which door this is. */
  door: "hub" | "cloud";
  /** The `/account/*` API base — always `${issuer}/account`. */
  account_endpoint: string;
  /**
   * The account-level MCP endpoint (Wave A) — the connection a client opens
   * against the `account:<id>:vaults` scope for list-vaults + create-vault +
   * query-across-vaults. Optional and unset today: no door advertises it yet
   * (`checkAccountDescriptor` does not require it). Present only once a door
   * mounts its account-MCP surface.
   */
  account_mcp_endpoint?: string;
  /**
   * How a person signs IN at this door. Optional in 0.4.0 so cloud@main keeps
   * typechecking while it lands its own twin (P3); P7 flips this required once
   * both doors serve it.
   */
  auth?: AccountAuthDescriptor;
  /**
   * Present only when the door currently offers self-serve signup (cloud:
   * always, `/signup`; hub: only while an active multi-use public invite
   * exists — Q2). Absent = no self-serve path right now (an operator-shared
   * link is the only way in).
   */
  signup_path?: string;
  /**
   * The reserved first-party `client_id` a native app should use (cloud
   * `"parachute-app"`). The hosted flow never OAuths its home door (C4-C5
   * §7.6); retained for cross-origin native clients that do. Optional because
   * a door with no such reserved client has nothing to advertise here.
   */
  app_client_id?: string;
  /** Which account-lifecycle operations this door supports. */
  capabilities: AccountCapabilities;
  /** The plan/tier ladder this door offers (empty for self-host). */
  plans: AccountPlanSummary[];
  /**
   * A vault-URL template with a literal `{name}` PLACEHOLDER the client
   * substitutes to preview a vault's address pre-creation ("it will live at …")
   * — door-agnostic, so a client never hardcodes cloud's path form vs a hub's.
   * NOT a base prefix: cloud serves both path (`…/vault/{name}`) and subdomain
   * (`{name}.<base>`) shapes, so only the door can render the right template.
   * Optional (a door that can't express one omits it).
   */
  vault_url_template?: string;
}

/** A vault as returned by `GET /account/vaults`. */
export interface AccountVaultSummary {
  name: string;
  url: string;
  /** Bytes used, when the door tracks usage (cloud's daily rollup); omitted otherwise. */
  used_bytes?: number;
  /** The vault's cap in bytes, when set. */
  cap_bytes?: number;
}

/** `POST /account/vaults` request body. */
export interface CreateVaultRequest {
  name: string;
}

/** `POST /account/vaults/<name>/token` request body — scope narrowed to the one vault. */
export interface MintVaultTokenRequest {
  /** Requested verb; the mint validates it against the account's ownership. */
  verb: "read" | "write" | "admin";
}

/** `GET /account` bootstrap body. */
export interface AccountBootstrap {
  id: string;
  email?: string;
  door: "hub" | "cloud";
}

/**
 * `GET /account/session` — the same-origin boot oracle (both doors). Public
 * per-request state check the app polls on first load (and while it waits for
 * a magic-link click); NOT gated on the account Bearer — it drives the cookie
 * session directly.
 */
export interface AccountSessionResponse {
  signed_in: boolean;
  /** Anonymous-capable CSRF (G2) — present on BOTH branches. */
  csrf: string;
  /**
   * Signed-in branch. Cloud always has email; hub email is nullable-by-history
   * (`users.email`, migration v15) so hub sends `username` and email-when-present.
   */
  email?: string;
  username?: string;
  account_created_at?: string;
}

/**
 * `POST /account/token` success (both doors; NOT RFC-6749 — deliberate: this is
 * the account-scoped credential a same-origin session mints, not an OAuth grant).
 */
export interface AccountTokenMintResponse {
  token: string;
  expires_at: string;
  scopes: string[];
  aud: "account";
}

/** `POST /account/vaults/<name>/token` success (both doors). */
export interface VaultTokenMintResponse {
  vault_token: string;
  expires_at: string;
  services: Record<string, { url: string; version?: string }>;
}

/**
 * The shared `/account/*` error vocabulary — the UNION of codes both doors
 * actually emit on the account surface (verified against hub `account-api.ts`
 * and cloud `workers/identity/src/account-api.ts`), not an aspirational subset.
 * Auth-gate failures use `{error, error_description}` (OAuth-style, matching the
 * token endpoint); resource-level failures use `{error, message}`. When a door
 * adds a new code, add it here in the same PR so this stays the real union.
 */
export const ACCOUNT_ERROR_CODES = [
  "invalid_request",
  "invalid_name",
  "reserved",
  "vault_taken",
  "not_owner",
  "vault_not_found",
  "vault_limit_reached",
  "invalid_scope",
  "not_implemented",
  "insufficient_scope",
  "invalid_token",
  "unauthenticated",
  "csrf_failed",
  "foreign_origin",
  "force_change_password",
  // Emitted today but missing from the original pin (found by the P0 review):
  "account_suspended", // cloud — suspended account hits any /account/* route
  "method_not_allowed", // hub — wrong verb on an account route
  "not_found", // cloud — unknown /account/vaults/<name> subroute
  "server_error", // hub — vault provisioning failed for a non-name reason
] as const;

/** One member of {@link ACCOUNT_ERROR_CODES}. */
export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];
