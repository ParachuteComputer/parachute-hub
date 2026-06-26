import { describe, expect, test } from "bun:test";
import {
  FIRST_PARTY_SCOPES,
  NON_REQUESTABLE_SCOPES,
  SCOPE_EXPLANATIONS,
  explainScope,
  isNonRequestableScope,
  isRequestableScope,
  isWellFormedOrNonVaultScope,
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
      "agent:send",
      "hub:admin",
      "parachute:host:admin",
    ];
    for (const s of expected) {
      expect(SCOPE_EXPLANATIONS[s]).toBeDefined();
      expect(SCOPE_EXPLANATIONS[s]?.label.length).toBeGreaterThan(10);
    }
  });

  // hub#689 Leg 1: the vault:admin consent copy must enumerate what
  // admin actually grants (config/settings, triggers/automation, GitHub
  // backup, token minting) on top of read/write — so the consent screen
  // is honest about the admin blast radius, not a vague "configuration
  // changes" hand-wave.
  test("vault:admin label enumerates the concrete admin grants (hub#689 Leg 1)", () => {
    const label = SCOPE_EXPLANATIONS["vault:admin"]?.label ?? "";
    const lower = label.toLowerCase();
    expect(SCOPE_EXPLANATIONS["vault:admin"]?.level).toBe("admin");
    // Read + write are still part of what admin grants.
    expect(lower).toContain("read");
    expect(lower).toContain("write");
    // The four enumerated admin powers.
    expect(lower).toContain("config");
    expect(lower).toContain("trigger");
    expect(lower).toContain("github");
    expect(lower).toContain("token");
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

  // Single-consent change (2026-05-29): vault:<name>:admin is now REQUESTABLE
  // and reaches the consent screen, so explainScope MUST resolve it to the
  // vault:admin explanation (level "admin"). This is load-bearing: it makes
  // scopeIsAdmin("vault:<name>:admin") return true, which the same-hub and
  // trust-by-name auto-mint gates rely on to keep admin consent-gated.
  test("resolves a per-vault admin (vault:<name>:admin) to the vault:admin explanation", () => {
    expect(explainScope("vault:default:admin")?.label).toBe(
      SCOPE_EXPLANATIONS["vault:admin"]?.label,
    );
    expect(explainScope("vault:default:admin")?.level).toBe("admin");
    expect(explainScope("vault:my-techne_2:admin")?.level).toBe("admin");
    expect(explainScope("vault:*:admin")?.level).toBe("admin");
  });
});

describe("scopeIsAdmin", () => {
  test("true for admin scopes", () => {
    expect(scopeIsAdmin("vault:admin")).toBe(true);
    expect(scopeIsAdmin("hub:admin")).toBe(true);
    expect(scopeIsAdmin("parachute:host:admin")).toBe(true);
  });

  // Single-consent change (2026-05-29): the named per-vault admin form must
  // be recognized as admin. LOAD-BEARING — the same-hub auto-trust gate
  // (`!hasAdminScope`) and the trust-by-client_name gate
  // (`!requestedScopes.some(scopeIsAdmin)`) rely on this to keep a named admin
  // grant consent-gated instead of silently auto-minting it.
  test("true for named per-vault admin (vault:<name>:admin)", () => {
    expect(scopeIsAdmin("vault:work:admin")).toBe(true);
    expect(scopeIsAdmin("vault:default:admin")).toBe(true);
    expect(scopeIsAdmin("vault:my-techne_2:admin")).toBe(true);
  });

  test("false for non-admin and unknown scopes", () => {
    expect(scopeIsAdmin("vault:read")).toBe(false);
    expect(scopeIsAdmin("agent:send")).toBe(false);
    expect(scopeIsAdmin("unknown:anything")).toBe(false);
  });

  test("scopeIsAdmin('runner:admin') returns false — module-declared admin scopes don't participate (deliberate; see scope-explanations.ts comment)", () => {
    expect(scopeIsAdmin("runner:admin")).toBe(false);
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
    expect(isRequestableScope("agent:send")).toBe(true);
  });

  test("true for unknown scopes (third-party module scopes pass through)", () => {
    expect(isRequestableScope("notes:something-new")).toBe(true);
  });

  // Single-consent change (2026-05-29): per-vault admin scopes are now
  // requestable via the public OAuth flow. The anti-privesc cap at the mint
  // choke-point (`capScopesToUserAuthority`) keeps a non-owner from actually
  // being granted admin — but the scope is no longer rejected up front, so
  // Claude MCP (consenting as the owner) can mint a vault admin token.
  test("true for any vault:<name>:admin scope (single-consent change)", () => {
    expect(isRequestableScope("vault:default:admin")).toBe(true);
    expect(isRequestableScope("vault:work:admin")).toBe(true);
    expect(isRequestableScope("vault:my-techne_2:admin")).toBe(true);
  });

  test("host-level operator scopes stay non-requestable", () => {
    // The asymmetry the single-consent change preserved: per-vault admin is
    // now requestable (capped at mint), but host-wide operator authority is
    // still operator-only-mintable.
    expect(isRequestableScope("parachute:host:admin")).toBe(false);
    expect(isRequestableScope("parachute:host:auth")).toBe(false);
  });

  test("vault:<name>:read|write stays requestable", () => {
    expect(isRequestableScope("vault:default:read")).toBe(true);
    expect(isRequestableScope("vault:work:write")).toBe(true);
  });

  // Item C — case-insensitive guard. A casing variant of a host-level scope
  // must NOT slip past the exact-string membership check as "requestable."
  test("uppercase / mixed-case host scopes are non-requestable (item C)", () => {
    expect(isRequestableScope("PARACHUTE:HOST:AUTH")).toBe(false);
    expect(isRequestableScope("Parachute:Host:Admin")).toBe(false);
    expect(isRequestableScope("parachute:HOST:vault")).toBe(false);
    // And the direct predicate agrees.
    expect(isNonRequestableScope("PARACHUTE:HOST:AUTH")).toBe(true);
    expect(isNonRequestableScope("parachute:Host:Install")).toBe(true);
    // Canonical lowercase still works unchanged.
    expect(isNonRequestableScope("parachute:host:auth")).toBe(true);
    // A non-host scope (even uppercased) stays requestable.
    expect(isNonRequestableScope("HUB:ADMIN")).toBe(false);
  });
});

// Mint-time shape guard (defensive hygiene, audit 2026-05-28). Rejects only the
// *named* three-segment vault shape when malformed; leaves the unnamed two-
// segment forms and all non-vault scopes alone.
describe("isWellFormedOrNonVaultScope", () => {
  test("rejects the four audited malformed named-vault forms", () => {
    expect(isWellFormedOrNonVaultScope("vault:work:ADMIN")).toBe(false); // uppercase verb
    expect(isWellFormedOrNonVaultScope("vault::admin")).toBe(false); // empty name
    expect(isWellFormedOrNonVaultScope("vault:work:read:admin")).toBe(false); // extra segment
    expect(isWellFormedOrNonVaultScope("VAULT:work:admin")).toBe(false); // uppercase resource
  });

  test("admits well-formed named-vault scopes (all three verbs)", () => {
    expect(isWellFormedOrNonVaultScope("vault:work:read")).toBe(true);
    expect(isWellFormedOrNonVaultScope("vault:work:write")).toBe(true);
    expect(isWellFormedOrNonVaultScope("vault:work:admin")).toBe(true);
    expect(isWellFormedOrNonVaultScope("vault:my-techne_2:admin")).toBe(true);
  });

  test("admits the unnamed two-segment vault forms (out of remit)", () => {
    expect(isWellFormedOrNonVaultScope("vault:read")).toBe(true);
    expect(isWellFormedOrNonVaultScope("vault:write")).toBe(true);
    expect(isWellFormedOrNonVaultScope("vault:admin")).toBe(true);
    expect(isWellFormedOrNonVaultScope("vault")).toBe(true); // bare, no colon
  });

  test("admits all non-vault scopes unconditionally", () => {
    expect(isWellFormedOrNonVaultScope("scribe:transcribe")).toBe(true);
    expect(isWellFormedOrNonVaultScope("parachute:host:auth")).toBe(true);
    expect(isWellFormedOrNonVaultScope("parachute:host:admin")).toBe(true);
    expect(isWellFormedOrNonVaultScope("hub:admin")).toBe(true);
    // A three-segment non-vault scope is not constrained even if malformed-looking.
    expect(isWellFormedOrNonVaultScope("scribe:work:ADMIN")).toBe(true);
  });
});
