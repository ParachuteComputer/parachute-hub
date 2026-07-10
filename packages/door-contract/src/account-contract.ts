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

/** The public capabilities descriptor served at `/.well-known/parachute-account`. */
export interface ParachuteAccountDescriptor {
  /** The account door's issuer origin. */
  issuer: string;
  /** Which door this is. */
  door: "hub" | "cloud";
  /** The `/account/*` routes this door mounts. */
  account_endpoint: string;
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
