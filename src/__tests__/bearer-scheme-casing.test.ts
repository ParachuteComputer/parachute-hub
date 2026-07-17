/**
 * H1.1 (contracts-brief H1) — Bearer scheme-casing unification.
 *
 * RFC 7235 §2.1: the auth-scheme token ("Bearer") is case-insensitive; the
 * credential (the token itself) is opaque and must be passed VERBATIM — never
 * case-folded, never trimmed beyond surrounding whitespace. This mirrors
 * parachute-vault's V1.4 (`BEARER_PREFIX`, case-insensitive) and
 * parachute-cloud's C1.3 (`workers/vault/src/auth.ts:130-143`) — the other two
 * door surfaces already converged on this shape; this file (plus the per-site
 * tests below) closes the hub's half.
 *
 * Every converted call site (`src/api-hub-upgrade.ts`, `src/api-tokens.ts`,
 * `src/api-revoke-token.ts`, `src/api-settings-root-redirect.ts`,
 * `src/api-modules.ts` ×2, `src/api-modules-ops.ts`, `src/api-mint-token.ts`,
 * `src/api-settings-hub-origin.ts`, `src/admin-surfaces.ts`,
 * `src/admin-connections.ts` ×2, `src/audience-gate.ts`) uses the SAME
 * two-step shape: a case-insensitive `/^Bearer\s+/i` scheme test, followed by
 * the PRE-EXISTING `header.slice("Bearer ".length).trim()` extraction
 * (unchanged — "Bearer ".length === "bearer ".length === 7, so the fixed-
 * offset slice is casing-agnostic and the token substring is untouched).
 * `src/admin-auth.ts`'s `extractBearerToken` (the documented shared helper,
 * used by `requireScope` + several `/admin/*` and `/api/*` routes already)
 * uses an equivalent `/^Bearer\s+(.+)$/i` regex. This file pins that shared
 * pattern directly, independent of any one handler's DB/deps scaffolding.
 *
 * Live end-to-end coverage (a lowercase/mixed-case Authorization header
 * reaching a real handler and authenticating) lives alongside each site's
 * existing tests, NOT here:
 *   - src/__tests__/api-hub-upgrade.test.ts
 *   - src/__tests__/api-tokens.test.ts
 *   - src/__tests__/api-revoke-token.test.ts
 *   - src/__tests__/api-settings-root-redirect.test.ts
 *   - src/__tests__/api-modules.test.ts (both handleApiModules + handleApiModulesChannel)
 *   - src/__tests__/api-modules-ops.test.ts
 *   - src/__tests__/api-mint-token.test.ts
 *   - src/__tests__/api-settings-hub-origin.test.ts
 *   - src/__tests__/admin-surfaces.test.ts
 *   - src/__tests__/admin-connections-credentials.test.ts (renew + claim)
 *   - src/__tests__/audience-gate.test.ts
 */
import { describe, expect, test } from "bun:test";
import { extractBearerToken } from "../admin-auth.ts";

/** The exact regex + slice shape used at all 12 converted call sites. */
function siteShapeExtract(header: string | null): string | null {
  if (!header || !/^Bearer\s+/i.test(header)) return null;
  return header.slice("Bearer ".length).trim();
}

// A JWT-shaped token: base64url alphabet includes uppercase letters, so any
// real access/operator token already exercises "verbatim, case preserved."
// Use one explicitly so the pin doesn't depend on a real signer.
const MIXED_CASE_TOKEN = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJBQkNkZWYxMjMifQ.SIGNATURE-Xyz";

describe("H1.1 — site-shape extraction (regex test + fixed-offset slice)", () => {
  test.each([
    ["Bearer", `Bearer ${MIXED_CASE_TOKEN}`],
    ["bearer", `bearer ${MIXED_CASE_TOKEN}`],
    ["BEARER", `BEARER ${MIXED_CASE_TOKEN}`],
    ["BeArEr", `BeArEr ${MIXED_CASE_TOKEN}`],
    ["bEARER", `bEARER ${MIXED_CASE_TOKEN}`],
  ])("scheme %s → token extracted verbatim, case preserved", (_label, header) => {
    expect(siteShapeExtract(header)).toBe(MIXED_CASE_TOKEN);
  });

  test("wrong scheme keyword (not Bearer) → rejected regardless of case", () => {
    expect(siteShapeExtract(`Basic ${MIXED_CASE_TOKEN}`)).toBeNull();
    expect(siteShapeExtract(`Digest ${MIXED_CASE_TOKEN}`)).toBeNull();
  });

  test("missing header → rejected", () => {
    expect(siteShapeExtract(null)).toBeNull();
  });

  test("scheme with no token → empty string (site's own 'empty bearer token' check catches this)", () => {
    expect(siteShapeExtract("Bearer ")).toBe("");
    expect(siteShapeExtract("bearer ")).toBe("");
  });

  test("extra internal whitespace after the scheme is tolerated (trim absorbs it), casing still ignored", () => {
    expect(siteShapeExtract(`bearer   ${MIXED_CASE_TOKEN}`)).toBe(MIXED_CASE_TOKEN);
    expect(siteShapeExtract(`Bearer\t${MIXED_CASE_TOKEN}`)).toBe(MIXED_CASE_TOKEN);
  });
});

describe("H1.1 — admin-auth.ts extractBearerToken (the documented shared helper)", () => {
  function reqWith(header: string | undefined): Request {
    return new Request("http://127.0.0.1/admin/probe", {
      headers: header !== undefined ? { authorization: header } : {},
    });
  }

  test.each([
    ["Bearer", `Bearer ${MIXED_CASE_TOKEN}`],
    ["bearer", `bearer ${MIXED_CASE_TOKEN}`],
    ["BeArEr", `BeArEr ${MIXED_CASE_TOKEN}`],
  ])("scheme %s → extractBearerToken returns the token verbatim", (_label, header) => {
    expect(extractBearerToken(reqWith(header))).toBe(MIXED_CASE_TOKEN);
  });

  test("missing Authorization header → AdminAuthError(401)", () => {
    expect(() => extractBearerToken(reqWith(undefined))).toThrow(/missing Authorization header/);
  });

  test("non-Bearer scheme → AdminAuthError(401)", () => {
    expect(() => extractBearerToken(reqWith(`Basic ${MIXED_CASE_TOKEN}`))).toThrow(
      /Authorization header must be 'Bearer <token>'/,
    );
  });
});
