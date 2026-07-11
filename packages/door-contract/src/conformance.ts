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

/**
 * Validate a door's `GET /.well-known/parachute-account` descriptor. Door-specific
 * values (`signup_path`, `app_client_id`, `plans`) are the door's own; this pins
 * the SHAPE + the cross-field invariants BOTH doors must hold: `issuer`/`door`
 * match the caller's expected pair, `account_endpoint` is derived (`${issuer}/account`),
 * `signup_path` is an absolute path, `app_client_id` is present, `capabilities`
 * carries the three booleans, and `plans` is an array.
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
  if (typeof actual.signup_path !== "string" || !actual.signup_path.startsWith("/"))
    push(`signup_path must be an absolute path, got ${JSON.stringify(actual.signup_path)}`);
  if (typeof actual.app_client_id !== "string" || actual.app_client_id.length === 0)
    push("app_client_id must be a non-empty string");
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
    if (typeof actual.vault_url_template !== "string" || !actual.vault_url_template.includes("{name}"))
      push('vault_url_template, when present, must be a string containing "{name}"');
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
