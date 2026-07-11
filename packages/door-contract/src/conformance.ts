/**
 * The unified conformance corpus — the X1 twin-suite content, as ONE shared
 * body both doors' conformance suites import (the D11 follow-on).
 *
 * Today the hosted door has a 1048-line `conformance.test.ts` with the expected
 * wire values inlined as `expect()` literals, and the self-host door asserts the
 * same behaviors scattered across its own suites. Neither shares the VECTORS.
 * This module is those vectors: runtime-agnostic data + assertion helpers a door
 * calls against its own live `fetch(app)`. Extend it with every contract
 * endpoint; a door's suite that drives it inherits the drift protection.
 */

import { ACCOUNT_ROUTES, type AccountRoute } from "./account-contract.js";
import {
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata,
  expectedAuthorizationServerMetadata,
  expectedProtectedResourceMetadata,
} from "./discovery.js";
import { ACCESS_TOKEN_TTL_SECONDS, TOKEN_TYPE } from "./tokens.js";

/** A named discrepancy between a door's live output and the contract. */
export interface ConformanceIssue {
  vector: string;
  detail: string;
}

/**
 * Assert a door's authorization-server metadata equals the contract for its
 * `issuer` + advertised `scopesSupported`. Returns the list of discrepancies
 * (empty = conformant) so a suite can assert `toEqual([])` with readable output.
 */
export function checkAuthorizationServerMetadata(
  actual: Partial<AuthorizationServerMetadata>,
  issuer: string,
  scopesSupported: readonly string[],
): ConformanceIssue[] {
  const expected = expectedAuthorizationServerMetadata(issuer, scopesSupported);
  return diffFields("oauth-authorization-server", expected, actual);
}

/** Assert a door's protected-resource metadata equals the contract. */
export function checkProtectedResourceMetadata(
  actual: Partial<ProtectedResourceMetadata>,
  issuer: string,
): ConformanceIssue[] {
  const expected = expectedProtectedResourceMetadata(issuer);
  return diffFields("oauth-protected-resource", expected, actual);
}

/**
 * Invariants a `POST /oauth/token` success body must satisfy, independent of the
 * runtime that produced it. `scope` is caller-supplied (the granted scope).
 */
export function checkTokenResponseInvariants(
  actual: Record<string, unknown>,
  grantedScope: string,
): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const push = (detail: string) => issues.push({ vector: "token-response", detail });
  if (actual.token_type !== TOKEN_TYPE)
    push(`token_type must be "${TOKEN_TYPE}", got ${JSON.stringify(actual.token_type)}`);
  if (actual.expires_in !== ACCESS_TOKEN_TTL_SECONDS)
    push(
      `expires_in must be ${ACCESS_TOKEN_TTL_SECONDS}, got ${JSON.stringify(actual.expires_in)}`,
    );
  if (actual.scope !== grantedScope)
    push(
      `scope must echo the granted scope ${JSON.stringify(grantedScope)}, got ${JSON.stringify(actual.scope)}`,
    );
  if (typeof actual.access_token !== "string" || actual.access_token.length === 0)
    push("access_token must be a non-empty string");
  return issues;
}

const AUTH_METHODS = new Set(["magic_link", "password"]);

/**
 * Validate a door's `GET /.well-known/parachute-account` descriptor. Door-specific
 * values (`signup_path`, `app_client_id`, `auth`, `plans`) are the door's own; this
 * pins the SHAPE + the cross-field invariants BOTH doors must hold: `issuer`/`door`
 * match the caller's expected pair, `account_endpoint` is derived
 * (`${issuer}/account`), `capabilities` carries the three booleans, and `plans` is
 * an array. `signup_path`, `app_client_id`, `auth`, and `vault_url_template` are all
 * OPTIONAL fields (0.4.0) — each is validated only WHEN PRESENT, so a door that
 * omits one (hub with no active public invite, a door with no reserved native
 * client) still conforms.
 */
export function checkAccountDescriptor(
  actual: Record<string, unknown>,
  expected: { issuer: string; door: "hub" | "cloud" },
): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const push = (detail: string) => issues.push({ vector: "parachute-account", detail });
  if (actual.issuer !== expected.issuer)
    push(`issuer must be ${JSON.stringify(expected.issuer)}, got ${JSON.stringify(actual.issuer)}`);
  if (actual.door !== expected.door)
    push(`door must be ${JSON.stringify(expected.door)}, got ${JSON.stringify(actual.door)}`);
  const wantEndpoint = `${expected.issuer}/account`;
  if (actual.account_endpoint !== wantEndpoint)
    push(
      `account_endpoint must be ${JSON.stringify(wantEndpoint)}, got ${JSON.stringify(actual.account_endpoint)}`,
    );
  // Optional: signup_path is present only while the door currently offers
  // self-serve signup (Q2). When present, must be an absolute path.
  if (actual.signup_path !== undefined) {
    if (typeof actual.signup_path !== "string" || !actual.signup_path.startsWith("/"))
      push(
        `signup_path, when present, must be an absolute path, got ${JSON.stringify(actual.signup_path)}`,
      );
  }
  // Optional: app_client_id is present only when the door has a reserved
  // first-party native-client id to advertise.
  if (actual.app_client_id !== undefined) {
    if (typeof actual.app_client_id !== "string" || actual.app_client_id.length === 0)
      push("app_client_id, when present, must be a non-empty string");
  }
  // Optional (0.4.0 — required from 0.5.0 once both doors serve it): the
  // sign-in-method block that drives the app's front-door branch.
  if (actual.auth !== undefined) {
    const auth = actual.auth;
    if (typeof auth !== "object" || auth === null) {
      push("auth, when present, must be an object");
    } else {
      const a = auth as Record<string, unknown>;
      if (!Array.isArray(a.methods) || a.methods.length === 0) {
        push("auth.methods, when present, must be a non-empty array");
      } else if (!a.methods.every((m) => typeof m === "string" && AUTH_METHODS.has(m))) {
        push('auth.methods entries must each be "magic_link" or "password"');
      }
      if (typeof a.signin_path !== "string" || !a.signin_path.startsWith("/"))
        push(`auth.signin_path must be an absolute path, got ${JSON.stringify(a.signin_path)}`);
    }
  }
  const caps = actual.capabilities;
  if (typeof caps !== "object" || caps === null) {
    push("capabilities must be an object");
  } else {
    for (const k of ["vault_create", "vault_rename", "vault_delete"] as const) {
      if (typeof (caps as Record<string, unknown>)[k] !== "boolean")
        push(`capabilities.${k} must be a boolean`);
    }
  }
  if (!Array.isArray(actual.plans)) push("plans must be an array");
  // Optional: a door MAY omit `vault_url_template`, but when present it must be a
  // string carrying the literal `{name}` placeholder (it's a template, not a URL).
  if (actual.vault_url_template !== undefined) {
    if (
      typeof actual.vault_url_template !== "string" ||
      !actual.vault_url_template.includes("{name}")
    )
      push('vault_url_template, when present, must be a string containing "{name}"');
  }
  return issues;
}

/** `true` when `value` is a string `Date.parse` can turn into a real instant. */
function isParseableTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Validate a door's `GET /account/session` body against
 * {@link AccountSessionResponse} — the same-origin boot oracle both doors serve.
 * Pins: `signed_in` matches `expected.signedIn`; `csrf` is a non-empty string on
 * BOTH branches (the G2 anonymous-CSRF invariant — a client must be able to grab
 * a CSRF token before it has ever signed in); when signed OUT, none of
 * `email`/`username`/`account_created_at` are present (a stale/spoofed identity
 * leak); when signed IN, at least one of `email`/`username` is present, and
 * `account_created_at`, when present, is ISO-8601-parseable.
 */
export function checkAccountSessionResponse(
  actual: Record<string, unknown>,
  expected: { signedIn: boolean },
): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const push = (detail: string) => issues.push({ vector: "account-session", detail });
  if (actual.signed_in !== expected.signedIn)
    push(
      `signed_in must be ${JSON.stringify(expected.signedIn)}, got ${JSON.stringify(actual.signed_in)}`,
    );
  if (typeof actual.csrf !== "string" || actual.csrf.length === 0)
    push("csrf must be a non-empty string on both the signed-in and signed-out branches");
  if (!expected.signedIn) {
    for (const k of ["email", "username", "account_created_at"] as const) {
      if (actual[k] !== undefined)
        push(`${k} must be absent when signed out, got ${JSON.stringify(actual[k])}`);
    }
  } else {
    if (actual.email === undefined && actual.username === undefined)
      push("at least one of email/username must be present when signed in");
    if (actual.account_created_at !== undefined && !isParseableTimestamp(actual.account_created_at))
      push(
        `account_created_at, when present, must be ISO-8601-parseable, got ${JSON.stringify(actual.account_created_at)}`,
      );
  }
  return issues;
}

/**
 * Validate a door's `POST /account/token` success body against
 * {@link AccountTokenMintResponse}. `expires_at` is checked for ISO-parseability
 * only — NOT "in the future" (clock-free vectors: a fixture built with a fixed
 * `now` shouldn't flake against wall-clock time).
 */
export function checkAccountTokenMintResponse(actual: Record<string, unknown>): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const push = (detail: string) => issues.push({ vector: "account-token-mint", detail });
  if (typeof actual.token !== "string" || actual.token.length === 0)
    push("token must be a non-empty string");
  if (!isParseableTimestamp(actual.expires_at))
    push(`expires_at must be ISO-8601-parseable, got ${JSON.stringify(actual.expires_at)}`);
  if (
    !Array.isArray(actual.scopes) ||
    actual.scopes.length === 0 ||
    !actual.scopes.every((s) => typeof s === "string")
  )
    push("scopes must be a non-empty array of strings");
  if (actual.aud !== "account") push(`aud must be "account", got ${JSON.stringify(actual.aud)}`);
  return issues;
}

/**
 * Validate a door's `POST /account/vaults/<name>/token` success body against
 * {@link VaultTokenMintResponse}. `services` must carry the `vault:<vaultName>`
 * key (both doors key their services catalog this way).
 */
export function checkVaultTokenMintResponse(
  actual: Record<string, unknown>,
  vaultName: string,
): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const push = (detail: string) => issues.push({ vector: "vault-token-mint", detail });
  if (typeof actual.vault_token !== "string" || actual.vault_token.length === 0)
    push("vault_token must be a non-empty string");
  if (!isParseableTimestamp(actual.expires_at))
    push(`expires_at must be ISO-8601-parseable, got ${JSON.stringify(actual.expires_at)}`);
  const services = actual.services;
  const key = `vault:${vaultName}`;
  if (typeof services !== "object" || services === null || !(key in services)) {
    push(`services must be an object carrying the key ${JSON.stringify(key)}`);
  }
  return issues;
}

/** The `/account/*` route vectors — the contract every door mounts. */
export const ACCOUNT_ROUTE_VECTORS: readonly AccountRoute[] = ACCOUNT_ROUTES;

function diffFields<T extends object>(
  vector: string,
  expected: T,
  actual: Partial<T>,
): ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  const expectedRec = expected as Record<string, unknown>;
  const actualRec = actual as Record<string, unknown>;
  for (const key of Object.keys(expectedRec)) {
    const e = JSON.stringify(expectedRec[key]);
    const a = JSON.stringify(actualRec[key]);
    if (e !== a) issues.push({ vector, detail: `${key}: expected ${e}, got ${a}` });
  }
  return issues;
}
