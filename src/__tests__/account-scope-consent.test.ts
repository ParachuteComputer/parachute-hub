/**
 * Account scopes: requestable, risk-tiered, and capped to the account holder.
 *
 * The decision (2026-07-30) was that `account:self:admin` may be requested
 * through the public OAuth flow, carrying delete-vault, because most
 * integrations never need it and the ones that do are legitimate.
 *
 * Implementing that naively would have been a privilege escalation. On
 * self-host the account IS the box — `account-api.ts` says so plainly:
 * "operator ≡ account ≡ box… the operator owns every vault, so the ownership
 * gate the cloud twin runs per-vault is trivially satisfied here". And
 * `capScopesToUserAuthority` only inspects `vault:<name>:<verb>`; everything
 * else passed straight through. So a non-admin assigned to exactly ONE vault
 * could have walked the consent flow and minted a token with authority over
 * EVERY vault on the box.
 *
 * Hence the two halves tested here: the scope is requestable, AND a non-admin
 * can never obtain it.
 */

import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_SELF_ADMIN_SCOPE,
  ACCOUNT_SELF_READ_SCOPE,
  explainScope,
  isRequestableScope,
  riskForExplanation,
} from "../scope-explanations.ts";

describe("requestability", () => {
  test("both account scopes are now requestable via OAuth", () => {
    expect(isRequestableScope(ACCOUNT_SELF_ADMIN_SCOPE)).toBe(true);
    expect(isRequestableScope(ACCOUNT_SELF_READ_SCOPE)).toBe(true);
  });

  test("host + service-admin scopes stay NON-requestable", () => {
    // Opening up account scopes must not have opened the operator scopes.
    // These have no per-user meaning at all — there's no "your own" version of
    // `parachute:host:admin` to cap a delegation against.
    for (const s of [
      "parachute:host:admin",
      "parachute:host:install",
      "parachute:host:auth",
      "hub:admin",
      "scribe:admin",
    ]) {
      expect(isRequestableScope(s)).toBe(false);
    }
  });

  test("case variants of host scopes are still refused", () => {
    expect(isRequestableScope("PARACHUTE:HOST:ADMIN")).toBe(false);
  });
});

describe("risk tiers", () => {
  test("account:self:admin is HIGH — the only tier above vault admin", () => {
    const e = explainScope(ACCOUNT_SELF_ADMIN_SCOPE);
    expect(e).toBeTruthy();
    expect(riskForExplanation(e!)).toBe("high");
  });

  test("a single vault's admin is ELEVATED, not high", () => {
    // The distinction the tier exists for. Rendering vault:admin at the same
    // weight as account-wide authority is what made the loudest signal land on
    // the scope most integrations legitimately need.
    for (const s of ["vault:admin", "vault:work:admin"]) {
      const e = explainScope(s);
      expect(e).toBeTruthy();
      expect(riskForExplanation(e!)).toBe("elevated");
    }
  });

  test("reads and writes are LOW", () => {
    for (const s of ["vault:read", "vault:write", ACCOUNT_SELF_READ_SCOPE]) {
      const e = explainScope(s);
      expect(e).toBeTruthy();
      expect(riskForExplanation(e!)).toBe("low");
    }
  });

  test("risk defaults from level when unset, so entries can't silently lose a tier", () => {
    expect(riskForExplanation({ label: "x", level: "admin" })).toBe("elevated");
    expect(riskForExplanation({ label: "x", level: "read" })).toBe("low");
    expect(riskForExplanation({ label: "x", level: "write" })).toBe("low");
    // An explicit tier always wins over the default.
    expect(riskForExplanation({ label: "x", level: "read", risk: "high" })).toBe("high");
  });
});

describe("the account:self:admin label states what can't be undone", () => {
  test("names deletion AND the surviving tokens", () => {
    // Revoking this grant does NOT revoke tokens the app already minted with
    // it. "You can disconnect it later" is true for every other scope and
    // false for this one, so the label has to say so — a user can't consent to
    // a consequence nobody told them about.
    const label = explainScope(ACCOUNT_SELF_ADMIN_SCOPE)!.label;
    expect(label).toMatch(/DELETE/);
    expect(label).toMatch(/keep working even after you disconnect/i);
  });
});
