import { describe, expect, test } from "bun:test";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ACCOUNT_ROUTES,
  ACCOUNT_SELF_ADMIN_SCOPE,
  ACCOUNT_SELF_READ_SCOPE,
  REFRESH_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  TOKEN_TYPE,
  accountScope,
  checkAccountDescriptor,
  checkAuthorizationServerMetadata,
  checkProtectedResourceMetadata,
  checkTokenResponseInvariants,
  expectedAuthorizationServerMetadata,
  expectedProtectedResourceMetadata,
  hasAccountScope,
  parseAccountScope,
} from "../index.js";

const CONFORMANT_DESCRIPTOR = {
  issuer: "https://cloud.parachute.computer",
  door: "cloud" as const,
  account_endpoint: "https://cloud.parachute.computer/account",
  signup_path: "/signup",
  app_client_id: "parachute-app",
  capabilities: { vault_create: true, vault_rename: false, vault_delete: false },
  plans: [{ id: "entry", name: "Entry", vaults: 1, price_month: 1 }],
};

// The corpus is pinned as the single source of truth. These values are what
// each door currently duplicates; if a real contract change is intended, it
// changes HERE and each door's parity test then forces the door to follow.
describe("token constants", () => {
  test("pin the wire values both doors mint against", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(REFRESH_TOKEN_TTL_MS).toBe(2_592_000_000);
    expect(REFRESH_GRACE_MS).toBe(30_000);
    expect(TOKEN_TYPE).toBe("Bearer");
  });
});

describe("account scope grammar", () => {
  test("canonical self scopes match the builder", () => {
    expect(ACCOUNT_SELF_ADMIN_SCOPE).toBe(accountScope("self", "admin"));
    expect(ACCOUNT_SELF_READ_SCOPE).toBe(accountScope("self", "read"));
  });

  test("parse rejects non-account and malformed scopes", () => {
    expect(parseAccountScope("account:self:admin")).toEqual({ id: "self", verb: "admin" });
    expect(parseAccountScope("account:u_123:read")).toEqual({ id: "u_123", verb: "read" });
    expect(parseAccountScope("account:admin")).toBeNull(); // 2-part
    expect(parseAccountScope("vault:work:read")).toBeNull(); // wrong resource
    expect(parseAccountScope("account:self:write")).toBeNull(); // no write rung
    expect(parseAccountScope("account::read")).toBeNull(); // empty id
  });

  test("admin ⊇ read, and a different id never matches", () => {
    expect(hasAccountScope(["account:self:admin"], "self", "read")).toBe(true);
    expect(hasAccountScope(["account:self:admin"], "self", "admin")).toBe(true);
    expect(hasAccountScope(["account:self:read"], "self", "admin")).toBe(false);
    expect(hasAccountScope(["account:u_1:admin"], "u_2", "read")).toBe(false);
    expect(hasAccountScope(["vault:x:admin"], "self", "read")).toBe(false);
  });
});

describe("discovery vectors", () => {
  const iss = "https://cloud.parachute.computer";
  const scopes = ["vault:read", "vault:write"];

  test("authorization-server metadata derives endpoints from the issuer", () => {
    const md = expectedAuthorizationServerMetadata(iss, scopes);
    expect(md.issuer).toBe(iss);
    expect(md.authorization_endpoint).toBe(`${iss}/oauth/authorize`);
    expect(md.token_endpoint).toBe(`${iss}/oauth/token`);
    expect(md.jwks_uri).toBe(`${iss}/.well-known/jwks.json`);
    expect(md.response_types_supported).toEqual(["code"]);
    expect(md.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(md.code_challenge_methods_supported).toEqual(["S256"]);
    expect(md.token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_post"]);
    expect(md.scopes_supported).toEqual(scopes);
  });

  test("checkAuthorizationServerMetadata reports zero issues for a conformant door", () => {
    const md = expectedAuthorizationServerMetadata(iss, scopes);
    expect(checkAuthorizationServerMetadata(md, iss, scopes)).toEqual([]);
  });

  test("checkAuthorizationServerMetadata catches drift", () => {
    const md = {
      ...expectedAuthorizationServerMetadata(iss, scopes),
      grant_types_supported: ["authorization_code"],
    };
    const issues = checkAuthorizationServerMetadata(md, iss, scopes);
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("grant_types_supported");
  });

  test("protected-resource metadata + its checker", () => {
    const md = expectedProtectedResourceMetadata(iss);
    expect(md.resource).toBe(iss);
    expect(md.authorization_servers).toEqual([iss]);
    expect(md.bearer_methods_supported).toEqual(["header"]);
    expect(checkProtectedResourceMetadata(md, iss)).toEqual([]);
  });
});

describe("token-response invariants", () => {
  test("a conformant body passes", () => {
    const body = {
      access_token: "x.y.z",
      token_type: "Bearer",
      expires_in: 900,
      scope: "vault:default:read",
    };
    expect(checkTokenResponseInvariants(body, "vault:default:read")).toEqual([]);
  });

  test("wrong ttl / type / scope / empty token each surface", () => {
    expect(
      checkTokenResponseInvariants(
        { access_token: "t", token_type: "bearer", expires_in: 900, scope: "s" },
        "s",
      ).length,
    ).toBe(1);
    expect(
      checkTokenResponseInvariants(
        { access_token: "t", token_type: "Bearer", expires_in: 3600, scope: "s" },
        "s",
      ).length,
    ).toBe(1);
    expect(
      checkTokenResponseInvariants(
        { access_token: "t", token_type: "Bearer", expires_in: 900, scope: "other" },
        "s",
      ).length,
    ).toBe(1);
    expect(
      checkTokenResponseInvariants(
        { access_token: "", token_type: "Bearer", expires_in: 900, scope: "s" },
        "s",
      ).length,
    ).toBe(1);
  });
});

describe("account route table", () => {
  test("every route is well-formed and scope-gated", () => {
    expect(ACCOUNT_ROUTES.length).toBeGreaterThan(0);
    for (const r of ACCOUNT_ROUTES) {
      expect(r.path.startsWith("/account")).toBe(true);
      expect(["read", "admin"]).toContain(r.scope);
      expect(["GET", "POST", "DELETE", "PUT"]).toContain(r.method);
    }
  });

  test("mutations require admin, reads require read", () => {
    const byKey = (m: string, p: string) =>
      ACCOUNT_ROUTES.find((r) => r.method === m && r.path === p);
    expect(byKey("POST", "/account/vaults")?.scope).toBe("admin");
    expect(byKey("DELETE", "/account/vaults/<name>")?.scope).toBe("admin");
    expect(byKey("GET", "/account/vaults")?.scope).toBe("read");
  });
});

describe("parachute-account descriptor (C4)", () => {
  const expected = { issuer: "https://cloud.parachute.computer", door: "cloud" as const };

  test("a conformant descriptor reports zero issues", () => {
    expect(checkAccountDescriptor(CONFORMANT_DESCRIPTOR, expected)).toEqual([]);
  });

  test("account_endpoint must derive from the issuer", () => {
    const bad = { ...CONFORMANT_DESCRIPTOR, account_endpoint: "https://elsewhere.example/account" };
    const issues = checkAccountDescriptor(bad, expected);
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("account_endpoint");
  });

  test("issuer / door / signup_path / app_client_id / capabilities / plans are all pinned", () => {
    expect(
      checkAccountDescriptor({ ...CONFORMANT_DESCRIPTOR, issuer: "https://evil.example" }, expected)
        .length,
    ).toBe(1); // issuer (account_endpoint is checked vs the EXPECTED issuer)
    expect(checkAccountDescriptor({ ...CONFORMANT_DESCRIPTOR, door: "hub" }, expected).length).toBe(
      1,
    );
    expect(
      checkAccountDescriptor({ ...CONFORMANT_DESCRIPTOR, signup_path: "signup" }, expected).length,
    ).toBe(1); // not absolute
    expect(
      checkAccountDescriptor({ ...CONFORMANT_DESCRIPTOR, app_client_id: "" }, expected).length,
    ).toBe(1);
    expect(
      checkAccountDescriptor(
        { ...CONFORMANT_DESCRIPTOR, capabilities: { vault_create: true, vault_delete: false } },
        expected,
      ).length,
    ).toBe(1); // missing vault_rename boolean
    expect(
      checkAccountDescriptor({ ...CONFORMANT_DESCRIPTOR, plans: "nope" }, expected).length,
    ).toBe(1);
  });
});
