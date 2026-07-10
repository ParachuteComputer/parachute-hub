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
