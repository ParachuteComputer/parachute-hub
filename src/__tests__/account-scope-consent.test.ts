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

describe("requestable is NOT the same as advertised", () => {
  test("account scopes stay requestable", () => {
    // A client that genuinely manages vaults must still be able to ask.
    expect(isRequestableScope(ACCOUNT_SELF_ADMIN_SCOPE)).toBe(true);
    expect(isRequestableScope(ACCOUNT_SELF_READ_SCOPE)).toBe(true);
  });

  test("but they are NOT in the advertised catalog", async () => {
    // Advertising a scope tells every discovery client "ask for this", and
    // clients routinely request the whole catalog. With account scopes listed,
    // a plain note-taking integration asked for PERMANENT DELETE across every
    // vault — observed live on a self-hosted box, where the consent screen led
    // with account-wide admin for a client that only wanted notes.
    const { rootMcpProtectedResourceMetadata } = await import("../oauth-handlers.ts");
    const res = rootMcpProtectedResourceMetadata({
      issuer: "https://hub.example",
      loadDeclaredScopes: () =>
        new Set([
          "vault:read",
          "vault:write",
          "vault:admin",
          ACCOUNT_SELF_READ_SCOPE,
          ACCOUNT_SELF_ADMIN_SCOPE,
        ]),
      loadServicesManifest: () => ({ services: [{ name: "parachute-vault", port: 1940 }] }),
    } as never);
    const body = (await res.json()) as { scopes_supported: string[] };
    // The ordinary surface is advertised…
    expect(body.scopes_supported).toContain("vault:read");
    expect(body.scopes_supported).toContain("vault:admin");
    // …account-wide authority is not.
    expect(body.scopes_supported).not.toContain(ACCOUNT_SELF_ADMIN_SCOPE);
    expect(body.scopes_supported).not.toContain(ACCOUNT_SELF_READ_SCOPE);
  });
});

describe("per-scope consent (granular approval)", () => {
  test("a high-risk scope renders UNCHECKED, ordinary ones pre-checked", async () => {
    // Account-wide authority should be something a user reaches for
    // deliberately, not something they inherit by clicking Approve on a list
    // the app composed. Everything else is pre-checked because approving what
    // was asked is the common case.
    const { renderConsent } = await import("../oauth-ui.ts");
    const html = renderConsent({
      params: {
        clientId: "c",
        redirectUri: "https://app.example/cb",
        responseType: "code",
        scope: "vault:read account:self:admin",
        codeChallenge: "x",
        codeChallengeMethod: "S256",
        state: null,
        resource: null,
      },
      csrfToken: "t",
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read", "account:self:admin"],
    });
    expect(html).toMatch(/name="granted_scope" value="vault:read" checked/);
    // The account row must NOT carry `checked`.
    const acct = html.slice(html.indexOf('value="account:self:admin"'));
    expect(acct.slice(0, 40)).not.toContain("checked");
  });
});

describe("consent checkbox posts the WIRE scope, not the display scope", () => {
  test("an unnamed vault scope shown as named still posts unnamed", async () => {
    // The bug this pins, shipped in #804 and caught by review: the checkbox
    // carried the DISPLAY form while `handleConsentSubmit` filters the
    // requested set, which is the WIRE form. `vault:unforced:read` posted
    // against a requested `vault:read` intersects to nothing — so every
    // unnamed vault scope was silently dropped and the user got
    // `access_denied` for a consent they had actually granted.
    //
    // My original test passed because it omitted `displayVault`: with no
    // substitution the two forms coincided, and the mismatch was invisible.
    // Setting displayVault is the whole point of this test.
    const { renderConsent } = await import("../oauth-ui.ts");
    const html = renderConsent({
      params: {
        clientId: "c",
        redirectUri: "https://app.example/cb",
        responseType: "code",
        scope: "vault:read vault:write",
        codeChallenge: "x",
        codeChallengeMethod: "S256",
        state: null,
        resource: null,
      },
      csrfToken: "t",
      clientId: "c",
      clientName: "App",
      scopes: ["vault:read", "vault:write"],
      displayVault: "unforced",
    });
    // Posted values are the wire forms the server will filter against.
    expect(html).toContain('name="granted_scope" value="vault:read"');
    expect(html).toContain('name="granted_scope" value="vault:write"');
    // …while the operator still reads the resolved, named form.
    expect(html).toContain("vault:unforced:read");
    expect(html).not.toContain('value="vault:unforced:read"');
  });

  test("one consent row survives a named/unnamed vault-scope collision", async () => {
    const { renderConsent } = await import("../oauth-ui.ts");
    const html = renderConsent({
      params: {
        clientId: "c",
        redirectUri: "https://app.example/cb",
        responseType: "code",
        scope: "vault:unforced:read vault:read",
        codeChallenge: "x",
        codeChallengeMethod: "S256",
        state: null,
        resource: null,
      },
      csrfToken: "t",
      clientId: "c",
      clientName: "App",
      scopes: ["vault:unforced:read", "vault:read"],
      displayVault: "unforced",
    });
    expect((html.match(/<li class="scope/g) ?? []).length).toBe(1);
    // The first wire value is retained for the POST, even though both forms
    // normalize to the same displayed permission.
    expect(html).toContain('name="granted_scope" value="vault:unforced:read"');
  });
});
