import { describe, expect, test } from "bun:test";
import {
  FIRST_PARTY_SCOPES,
  NON_REQUESTABLE_SCOPES,
  SCOPE_EXPLANATIONS,
  explainScope,
  isRequestableScope,
  scopeIsAdmin,
} from "../scope-explanations.ts";

describe("SCOPE_EXPLANATIONS", () => {
  test("covers every canonical first-party scope from oauth-scopes.md", () => {
    // Source of truth: parachute-patterns/patterns/oauth-scopes.md.
    const expected = [
      "vault:read",
      "vault:write",
      "vault:admin",
      "scribe:transcribe",
      "scribe:admin",
      "channel:send",
      "hub:admin",
      "parachute:host:admin",
    ];
    for (const s of expected) {
      expect(SCOPE_EXPLANATIONS[s]).toBeDefined();
      expect(SCOPE_EXPLANATIONS[s]?.label.length).toBeGreaterThan(10);
    }
  });

  test("FIRST_PARTY_SCOPES is sorted and matches the keys of SCOPE_EXPLANATIONS", () => {
    expect(FIRST_PARTY_SCOPES).toEqual([...FIRST_PARTY_SCOPES].sort());
    expect(new Set(FIRST_PARTY_SCOPES)).toEqual(new Set(Object.keys(SCOPE_EXPLANATIONS)));
  });
});

describe("explainScope", () => {
  test("returns the entry for a known scope", () => {
    expect(explainScope("vault:read")?.level).toBe("read");
  });

  test("returns null for an unknown scope", () => {
    expect(explainScope("notes:weird-thing")).toBeNull();
  });

  // Approval-UX rc.19: the consent screen renders the *resolved* scope
  // shape (`vault:<name>:read`) rather than the raw OAuth request
  // (`vault:read`) so the operator sees the form the token will carry.
  // explainScope falls back to the unnamed verb's entry for both the
  // narrowed (`vault:work:read`) and wildcard-display (`vault:*:read`)
  // forms so the consent UI keeps the same label + level styling.
  test("named vault scopes (vault:<name>:<verb>) reuse the unnamed-verb explanation", () => {
    expect(explainScope("vault:work:read")?.label).toBe(SCOPE_EXPLANATIONS["vault:read"]?.label);
    expect(explainScope("vault:work:read")?.level).toBe("read");
    expect(explainScope("vault:my-techne_2:write")?.level).toBe("write");
  });

  test("wildcard vault display form (vault:*:<verb>) explains via the unnamed verb", () => {
    expect(explainScope("vault:*:read")?.level).toBe("read");
    expect(explainScope("vault:*:write")?.level).toBe("write");
  });

  test("doesn't promote a per-vault admin (vault:<name>:admin) into an explained scope", () => {
    // vault:<name>:admin is NON_REQUESTABLE — never appears on the consent
    // screen. Explicitly not in the verb-pattern, so explainScope returns null.
    expect(explainScope("vault:default:admin")).toBeNull();
  });
});

describe("scopeIsAdmin", () => {
  test("true for admin scopes", () => {
    expect(scopeIsAdmin("vault:admin")).toBe(true);
    expect(scopeIsAdmin("hub:admin")).toBe(true);
    expect(scopeIsAdmin("parachute:host:admin")).toBe(true);
  });

  test("false for non-admin and unknown scopes", () => {
    expect(scopeIsAdmin("vault:read")).toBe(false);
    expect(scopeIsAdmin("channel:send")).toBe(false);
    expect(scopeIsAdmin("unknown:anything")).toBe(false);
  });
});

describe("NON_REQUESTABLE_SCOPES (#96)", () => {
  test("contains parachute:host:admin", () => {
    expect(NON_REQUESTABLE_SCOPES.has("parachute:host:admin")).toBe(true);
  });

  test("does NOT contain hub:admin (intentional asymmetry)", () => {
    // hub:admin is service management an operator may legitimately delegate
    // to a tooling app. parachute:host:admin is cross-vault data sovereignty
    // and stays operator-only-mintable.
    expect(NON_REQUESTABLE_SCOPES.has("hub:admin")).toBe(false);
  });

  test("every non-requestable scope is a known first-party scope", () => {
    for (const s of NON_REQUESTABLE_SCOPES) {
      expect(FIRST_PARTY_SCOPES).toContain(s);
    }
  });
});

describe("isRequestableScope", () => {
  test("false for parachute:host:admin", () => {
    expect(isRequestableScope("parachute:host:admin")).toBe(false);
  });

  test("true for hub:admin and other first-party scopes", () => {
    expect(isRequestableScope("hub:admin")).toBe(true);
    expect(isRequestableScope("vault:read")).toBe(true);
    expect(isRequestableScope("vault:admin")).toBe(true);
    expect(isRequestableScope("channel:send")).toBe(true);
  });

  test("true for unknown scopes (third-party module scopes pass through)", () => {
    expect(isRequestableScope("notes:something-new")).toBe(true);
  });

  // Per-vault admin scopes are pattern-matched as non-requestable so the
  // public OAuth flow can never mint vault:<name>:admin — only the local
  // session-cookie endpoint at /admin/vault-admin-token/<name> can.
  test("false for any vault:<name>:admin scope", () => {
    expect(isRequestableScope("vault:default:admin")).toBe(false);
    expect(isRequestableScope("vault:work:admin")).toBe(false);
    expect(isRequestableScope("vault:my-techne_2:admin")).toBe(false);
  });

  test("vault:<name>:read|write stays requestable (only :admin is locked down)", () => {
    expect(isRequestableScope("vault:default:read")).toBe(true);
    expect(isRequestableScope("vault:work:write")).toBe(true);
  });
});
