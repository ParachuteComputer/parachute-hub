import { describe, expect, test } from "bun:test";
import {
  ACCESS_TOKEN_TTL_SECONDS as CONTRACT_ACCESS_TTL,
  ACCOUNT_SELF_ADMIN_SCOPE as CONTRACT_ACCOUNT_ADMIN,
  ACCOUNT_SELF_READ_SCOPE as CONTRACT_ACCOUNT_READ,
  REFRESH_GRACE_MS as CONTRACT_REFRESH_GRACE,
  REFRESH_TOKEN_TTL_MS as CONTRACT_REFRESH_TTL,
  hasAccountScope,
} from "@openparachute/door-contract";
import { ACCESS_TOKEN_TTL_SECONDS, REFRESH_GRACE_MS, REFRESH_TOKEN_TTL_MS } from "../jwt-sign.ts";
import { ACCOUNT_SELF_ADMIN_SCOPE, ACCOUNT_SELF_READ_SCOPE } from "../scope-explanations.ts";

/**
 * Drift detector for the shared door contract (Cloud+Hub shared-core campaign,
 * parachute-cloud#116, Phase A). The hub's issuer constants + account-scope
 * strings are duplicated in `@openparachute/door-contract` (the hosted cloud
 * door duplicates them too). These assertions bind the hub's LIVE runtime values
 * to the shared canon — no runtime code path is changed by this test, but any
 * future divergence between the hub's issuer and the shared contract fails here,
 * forcing the change through the shared package (and thus the cloud twin).
 *
 * When the hub adopts the contract at runtime (Phase B — `jwt-sign.ts` imports
 * these constants instead of re-declaring them), these become identity checks;
 * until then they are the guardrail.
 */
describe("door-contract parity — token constants", () => {
  test("the hub's issuer TTL/grace equal the shared contract", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(CONTRACT_ACCESS_TTL);
    expect(REFRESH_TOKEN_TTL_MS).toBe(CONTRACT_REFRESH_TTL);
    expect(REFRESH_GRACE_MS).toBe(CONTRACT_REFRESH_GRACE);
  });
});

describe("door-contract parity — account scopes", () => {
  test("the hub's account scope strings equal the shared contract", () => {
    expect(ACCOUNT_SELF_ADMIN_SCOPE).toBe(CONTRACT_ACCOUNT_ADMIN);
    expect(ACCOUNT_SELF_READ_SCOPE).toBe(CONTRACT_ACCOUNT_READ);
  });

  test("the shared checker agrees with the hub's admin⊇read intent", () => {
    // The hub's `/account/*` gate treats `account:self:admin` as satisfying a
    // read requirement (scope-explanations.ts). The shared checker must too.
    expect(hasAccountScope([ACCOUNT_SELF_ADMIN_SCOPE], "self", "read")).toBe(true);
    expect(hasAccountScope([ACCOUNT_SELF_READ_SCOPE], "self", "admin")).toBe(false);
  });
});
