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
  },
  {
    method: "PUT",
    path: "/account/vaults/<name>/caps",
    scope: "admin",
    summary: "Set a vault's storage caps.",
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
  /** Where a brand-new user begins sign-up (cloud `"/signup"`, hub `"/account/setup"`). */
  signup_path: string;
  /** The reserved first-party `client_id` a native app should use (cloud `"parachute-app"`). */
  app_client_id: string;
  /** Which account-lifecycle operations this door supports. */
  capabilities: AccountCapabilities;
  /** The plan/tier ladder this door offers (empty for self-host). */
  plans: AccountPlanSummary[];
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
