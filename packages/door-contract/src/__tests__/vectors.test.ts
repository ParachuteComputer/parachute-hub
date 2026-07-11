import { describe, expect, test } from "bun:test";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ACCOUNT_ERROR_CODES,
  ACCOUNT_ROUTES,
  ACCOUNT_SELF_ADMIN_SCOPE,
  ACCOUNT_SELF_READ_SCOPE,
  REFRESH_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  TOKEN_TYPE,
  accountScope,
  checkAccountDescriptor,
  checkAccountSessionResponse,
  checkAccountTokenMintResponse,
  checkAuthorizationServerMetadata,
  checkProtectedResourceMetadata,
  checkTokenResponseInvariants,
  checkVaultTokenMintResponse,
  expectedAuthorizationServerMetadata,
  expectedProtectedResourceMetadata,
  hasAccountScope,
  parseAccountScope,
  validateVaultScopes,
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

  test("vault_url_template is OPTIONAL but must carry {name} when present", () => {
    // Omitted → still conformant (the CONFORMANT_DESCRIPTOR has none).
    expect(checkAccountDescriptor(CONFORMANT_DESCRIPTOR, expected)).toEqual([]);
    // Present + valid → conformant.
    expect(
      checkAccountDescriptor(
        {
          ...CONFORMANT_DESCRIPTOR,
          vault_url_template: "https://u.parachute.computer/vault/{name}",
        },
        expected,
      ),
    ).toEqual([]);
    // Present without the {name} placeholder → one issue.
    const bad = checkAccountDescriptor(
      { ...CONFORMANT_DESCRIPTOR, vault_url_template: "https://u.parachute.computer/vault/" },
      expected,
    );
    expect(bad.length).toBe(1);
    expect(bad[0]?.detail).toContain("vault_url_template");
  });

  test("signup_path / app_client_id are OPTIONAL (P0) — absent is still conformant", () => {
    const { signup_path, app_client_id, ...withoutOptionalFields } = CONFORMANT_DESCRIPTOR;
    expect(checkAccountDescriptor(withoutOptionalFields, expected)).toEqual([]);
  });

  test("signup_path, when present, must still be an absolute path", () => {
    const issues = checkAccountDescriptor(
      { ...CONFORMANT_DESCRIPTOR, signup_path: "signup" },
      expected,
    );
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("signup_path");
  });

  test("app_client_id, when present, must still be non-empty", () => {
    const issues = checkAccountDescriptor(
      { ...CONFORMANT_DESCRIPTOR, app_client_id: "" },
      expected,
    );
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("app_client_id");
  });

  test("auth is OPTIONAL (P0) — absent is conformant, present + valid is conformant", () => {
    const { signup_path, app_client_id, ...base } = CONFORMANT_DESCRIPTOR;
    expect(checkAccountDescriptor(base, expected)).toEqual([]);
    expect(
      checkAccountDescriptor(
        { ...base, auth: { methods: ["magic_link"], signin_path: "/login" } },
        expected,
      ),
    ).toEqual([]);
  });

  test("auth, when present, pins methods + signin_path", () => {
    const { signup_path, app_client_id, ...base } = CONFORMANT_DESCRIPTOR;
    expect(
      checkAccountDescriptor({ ...base, auth: { methods: [], signin_path: "/login" } }, expected)
        .length,
    ).toBe(1); // empty methods
    expect(
      checkAccountDescriptor(
        { ...base, auth: { methods: ["carrier_pigeon"], signin_path: "/login" } },
        expected,
      ).length,
    ).toBe(1); // unknown method
    expect(
      checkAccountDescriptor(
        { ...base, auth: { methods: ["password"], signin_path: "login" } },
        expected,
      ).length,
    ).toBe(1); // not absolute
    expect(checkAccountDescriptor({ ...base, auth: "nope" }, expected).length).toBe(1); // not an object
  });
});

describe("account route table — optional flag (P0)", () => {
  test("GET /account and the caps routes are marked optional (hub-only)", () => {
    const byKey = (m: string, p: string) =>
      ACCOUNT_ROUTES.find((r) => r.method === m && r.path === p);
    expect(byKey("GET", "/account")?.optional).toBe(true);
    expect(byKey("GET", "/account/vaults/<name>/caps")?.optional).toBe(true);
    expect(byKey("PUT", "/account/vaults/<name>/caps")?.optional).toBe(true);
  });

  test("the core vault-lifecycle routes are NOT optional — every door mounts them", () => {
    const byKey = (m: string, p: string) =>
      ACCOUNT_ROUTES.find((r) => r.method === m && r.path === p);
    expect(byKey("GET", "/account/vaults")?.optional).toBeUndefined();
    expect(byKey("POST", "/account/vaults")?.optional).toBeUndefined();
    expect(byKey("DELETE", "/account/vaults/<name>")?.optional).toBeUndefined();
    expect(byKey("POST", "/account/vaults/<name>/token")?.optional).toBeUndefined();
  });
});

describe("ACCOUNT_ERROR_CODES", () => {
  test("pins the shared /account/* error vocabulary", () => {
    expect(ACCOUNT_ERROR_CODES).toEqual([
      "invalid_request",
      "invalid_name",
      "reserved",
      "vault_taken",
      "not_owner",
      "vault_not_found",
      "vault_limit_reached",
      "invalid_scope",
      "not_implemented",
      "insufficient_scope",
      "invalid_token",
      "unauthenticated",
      "csrf_failed",
      "foreign_origin",
      "force_change_password",
      "account_suspended",
      "method_not_allowed",
      "not_found",
      "server_error",
    ]);
  });

  test("carries the codes each door actually emits (the union, not a subset)", () => {
    // Regression against the born-incomplete pin the P0 review caught.
    for (const code of [
      "account_suspended", // cloud
      "method_not_allowed", // hub
      "not_found", // cloud
      "server_error", // hub
    ] as const) {
      expect(ACCOUNT_ERROR_CODES).toContain(code);
    }
  });
});

describe("checkAccountSessionResponse (P0)", () => {
  test("signed-out: a conformant body reports zero issues", () => {
    expect(
      checkAccountSessionResponse({ signed_in: false, csrf: "tok" }, { signedIn: false }),
    ).toEqual([]);
  });

  test("signed-out: csrf must still be present (the G2 anonymous-CSRF invariant)", () => {
    const issues = checkAccountSessionResponse({ signed_in: false, csrf: "" }, { signedIn: false });
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("csrf");
  });

  test("signed-out: an identity field leaking through is an issue", () => {
    const issues = checkAccountSessionResponse(
      { signed_in: false, csrf: "tok", username: "leaked" },
      { signedIn: false },
    );
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("username");
  });

  test("signed-in: a conformant body (username, no email) reports zero issues", () => {
    expect(
      checkAccountSessionResponse(
        {
          signed_in: true,
          csrf: "tok",
          username: "aaron",
          account_created_at: "2026-01-01T00:00:00Z",
        },
        { signedIn: true },
      ),
    ).toEqual([]);
  });

  test("signed-in: a conformant body (email, no username) also reports zero issues", () => {
    expect(
      checkAccountSessionResponse(
        { signed_in: true, csrf: "tok", email: "a@example.com" },
        { signedIn: true },
      ),
    ).toEqual([]);
  });

  test("signed-in: neither email nor username present is an issue", () => {
    const issues = checkAccountSessionResponse(
      { signed_in: true, csrf: "tok" },
      { signedIn: true },
    );
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("email/username");
  });

  test("signed-in: a non-string email (present but not a string) is an issue", () => {
    const issues = checkAccountSessionResponse(
      { signed_in: true, csrf: "tok", email: 42 },
      { signedIn: true },
    );
    expect(issues.some((i) => i.detail.includes("email"))).toBe(true);
  });

  test("signed-in: a null username (present but not a string) is an issue", () => {
    const issues = checkAccountSessionResponse(
      { signed_in: true, csrf: "tok", username: null },
      { signedIn: true },
    );
    // null is present (!== undefined) but not a string → the non-string check flags it.
    expect(issues.some((i) => i.detail.includes("username"))).toBe(true);
  });

  test("signed-in: a non-ISO account_created_at is an issue", () => {
    const issues = checkAccountSessionResponse(
      { signed_in: true, csrf: "tok", username: "aaron", account_created_at: "not-a-date" },
      { signedIn: true },
    );
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("account_created_at");
  });

  test("signed-in: a Date.parse-able but non-ISO account_created_at is an issue (strict ISO-8601)", () => {
    // "January 1, 2026" is Date.parse-able but not ISO-8601 — the tightened
    // checker must reject it, where the old bare-Date.parse checker passed it.
    const issues = checkAccountSessionResponse(
      { signed_in: true, csrf: "tok", username: "aaron", account_created_at: "January 1, 2026" },
      { signedIn: true },
    );
    expect(issues.length).toBe(1);
    expect(issues[0]?.detail).toContain("account_created_at");
  });

  test("signed_in mismatched against the expected branch is an issue", () => {
    const issues = checkAccountSessionResponse(
      { signed_in: true, csrf: "tok", username: "aaron" },
      { signedIn: false },
    );
    expect(issues.some((i) => i.detail.includes("signed_in"))).toBe(true);
  });
});

describe("checkAccountTokenMintResponse (P0)", () => {
  const GREEN = {
    token: "t.o.k",
    expires_at: "2026-01-01T00:15:00Z",
    scopes: ["account:self:admin"],
    aud: "account",
  };

  test("a conformant body reports zero issues", () => {
    expect(checkAccountTokenMintResponse(GREEN)).toEqual([]);
  });

  test("empty token is an issue", () => {
    expect(checkAccountTokenMintResponse({ ...GREEN, token: "" }).length).toBe(1);
  });

  test("non-ISO expires_at is an issue (future-ness is NOT pinned — clock-free)", () => {
    expect(checkAccountTokenMintResponse({ ...GREEN, expires_at: "whenever" }).length).toBe(1);
    // A timestamp in the PAST still passes — only parseability is pinned.
    expect(checkAccountTokenMintResponse({ ...GREEN, expires_at: "2000-01-01T00:00:00Z" })).toEqual(
      [],
    );
  });

  test("empty scopes array is an issue", () => {
    expect(checkAccountTokenMintResponse({ ...GREEN, scopes: [] }).length).toBe(1);
  });

  test("wrong aud is an issue", () => {
    expect(checkAccountTokenMintResponse({ ...GREEN, aud: "vault.default" }).length).toBe(1);
  });
});

describe("checkVaultTokenMintResponse (P0)", () => {
  const GREEN = {
    vault_token: "v.t.k",
    expires_at: "2026-01-01T00:15:00Z",
    services: { "vault:moss": { url: "https://example.com/vault/moss" } },
  };

  test("a conformant body reports zero issues", () => {
    expect(checkVaultTokenMintResponse(GREEN, "moss")).toEqual([]);
  });

  test("empty vault_token is an issue", () => {
    expect(checkVaultTokenMintResponse({ ...GREEN, vault_token: "" }, "moss").length).toBe(1);
  });

  test("non-ISO expires_at is an issue", () => {
    expect(checkVaultTokenMintResponse({ ...GREEN, expires_at: "whenever" }, "moss").length).toBe(
      1,
    );
  });

  test("services missing the vault:<name> key is an issue", () => {
    expect(
      checkVaultTokenMintResponse({ ...GREEN, services: { "vault:other": { url: "x" } } }, "moss")
        .length,
    ).toBe(1);
  });

  test("the vault:<name> entry present but without a string url is an issue", () => {
    // {} conforms to the key-presence check but violates the type's `url: string`.
    expect(
      checkVaultTokenMintResponse({ ...GREEN, services: { "vault:moss": {} } }, "moss").length,
    ).toBe(1);
    expect(
      checkVaultTokenMintResponse({ ...GREEN, services: { "vault:moss": { url: 42 } } }, "moss")
        .length,
    ).toBe(1);
  });
});

describe("validateVaultScopes (P0)", () => {
  test("absent (undefined) defaults to read+write", () => {
    expect(validateVaultScopes(undefined, "moss")).toEqual({
      ok: true,
      scopes: ["vault:moss:read", "vault:moss:write"],
    });
  });

  test("null defaults to read+write", () => {
    expect(validateVaultScopes(null, "moss")).toEqual({
      ok: true,
      scopes: ["vault:moss:read", "vault:moss:write"],
    });
  });

  test("empty array defaults to read+write", () => {
    expect(validateVaultScopes([], "moss")).toEqual({
      ok: true,
      scopes: ["vault:moss:read", "vault:moss:write"],
    });
  });

  test("a valid single-scope request round-trips", () => {
    expect(validateVaultScopes(["vault:moss:admin"], "moss")).toEqual({
      ok: true,
      scopes: ["vault:moss:admin"],
    });
  });

  test("duplicate entries are de-duplicated", () => {
    expect(validateVaultScopes(["vault:moss:read", "vault:moss:read"], "moss")).toEqual({
      ok: true,
      scopes: ["vault:moss:read"],
    });
  });

  // The rejection `reason` carries each door's wire error code — a well-formed
  // scope string that names the wrong resource/vault/verb is `invalid_scope`;
  // a structurally-broken value (non-array, or a non-string entry) is
  // `invalid_request`. This split preserves hub's `parseScopesBody` semantics.
  test("a foreign vault name rejects with invalid_scope", () => {
    expect(validateVaultScopes(["vault:other:read"], "moss")).toEqual({
      ok: false,
      reason: "invalid_scope",
    });
  });

  test("a non-vault resource (account:*) rejects with invalid_scope", () => {
    expect(validateVaultScopes(["account:self:admin"], "moss")).toEqual({
      ok: false,
      reason: "invalid_scope",
    });
  });

  test("an unknown verb rejects with invalid_scope", () => {
    expect(validateVaultScopes(["vault:moss:execute"], "moss")).toEqual({
      ok: false,
      reason: "invalid_scope",
    });
  });

  test("a malformed (wrong part-count) scope string rejects with invalid_scope", () => {
    expect(validateVaultScopes(["vault:moss"], "moss")).toEqual({
      ok: false,
      reason: "invalid_scope",
    });
  });

  test("a non-string entry rejects with invalid_request", () => {
    expect(validateVaultScopes([123], "moss")).toEqual({ ok: false, reason: "invalid_request" });
  });

  test("a non-array, non-nullish value rejects with invalid_request", () => {
    expect(validateVaultScopes("vault:moss:read", "moss")).toEqual({
      ok: false,
      reason: "invalid_request",
    });
  });

  test("a mixed array (a wrong scope BEFORE a non-string) is invalid_request, not invalid_scope", () => {
    // Byte-exact with hub's whole-array non-string pre-scan: a non-string entry
    // ANYWHERE makes the request invalid_request even if a bad-but-well-formed
    // scope string sits earlier. Guards P2/P3 adoption against an error-code flip.
    expect(validateVaultScopes(["vault:other:read", 123], "moss")).toEqual({
      ok: false,
      reason: "invalid_request",
    });
  });

  test("one bad entry among good ones rejects the WHOLE request (no partial grant)", () => {
    expect(validateVaultScopes(["vault:moss:read", "vault:other:read"], "moss")).toEqual({
      ok: false,
      reason: "invalid_scope",
    });
  });
});
