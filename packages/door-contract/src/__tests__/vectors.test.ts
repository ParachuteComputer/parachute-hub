import { describe, expect, test } from "bun:test";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  ACCOUNT_ERROR_CODES,
  ACCOUNT_ROUTES,
  ACCOUNT_SELF_ADMIN_SCOPE,
  ACCOUNT_SELF_READ_SCOPE,
  ACCOUNT_VAULTS_UNNARROWED,
  ACCOUNT_VAULTS_VERB,
  COMPOSED_MODULE_SEGMENT,
  COMPOSED_VAULTS_SEGMENT,
  COMPOSED_VAULTS_WILDCARD,
  COMPOSED_VAULT_CREATE_VERB,
  COMPOSED_VERB_RANK,
  REFRESH_GRACE_MS,
  REFRESH_TOKEN_TTL_MS,
  TOKEN_TYPE,
  accountScope,
  accountVaultsGrant,
  accountVaultsScope,
  checkAccountDescriptor,
  checkAccountSessionResponse,
  checkAccountTokenMintResponse,
  checkAuthorizationServerMetadata,
  checkProtectedResourceMetadata,
  checkTokenResponseInvariants,
  checkVaultTokenMintResponse,
  composedAccountGrant,
  composedModuleScope,
  composedVaultCreateScope,
  composedVaultScope,
  composedVerbSatisfies,
  composedWildcardVaultsScope,
  expectedAuthorizationServerMetadata,
  expectedProtectedResourceMetadata,
  hasAccountScope,
  isComposedVaultVerb,
  isRequestableAccountScope,
  parseAccountScope,
  parseAccountVaultsScope,
  parseComposedAccountScope,
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

describe("account-vaults scope grammar (Wave A)", () => {
  test("constants + builder", () => {
    expect(ACCOUNT_VAULTS_VERB).toBe("vaults");
    expect(ACCOUNT_VAULTS_UNNARROWED).toBe("account:vaults");
    expect(accountVaultsScope("self")).toBe("account:self:vaults");
    expect(accountVaultsScope("u_123")).toBe("account:u_123:vaults");
  });

  // The account wall stays closed to everything except the account-vaults
  // connection scope — the single deliberate exception (Wave A). This table is
  // the requestable/refused contract the door's consent gate enforces.
  test("isRequestableAccountScope — the requestable/refused vector table", () => {
    // Requestable: the un-narrowed PRM form + the consent-bound blanket form.
    for (const scope of ["account:vaults", "account:self:vaults", "account:u_123:vaults"]) {
      expect(isRequestableAccountScope(scope)).toBe(true);
    }
    // Refused: the account wall (admin/read, 2- and 3-part), the 4-part
    // consent-NARROWED form (consent narrows; a client can't pre-narrow itself),
    // casing variants (exact-lowercase, fail closed), and non-account scopes.
    for (const scope of [
      "account:self:admin",
      "account:self:read",
      "account:u_123:admin",
      "account:u_123:read",
      "account:admin",
      "account:read",
      "account:self:vaults:work", // 4-part narrowed — NOT requestable
      "account:self:vaults:work:extra", // over-long
      "account::vaults", // empty id
      "Account:self:vaults", // casing
      "account:self:Vaults", // casing
      "account:vaults:extra", // 3-part but not <id>:vaults
      "vault:work:read", // non-account
      "account", // bare
      "",
    ]) {
      expect(isRequestableAccountScope(scope)).toBe(false);
    }
  });

  test("parseAccountVaultsScope — blanket / narrowed / foreign / malformed", () => {
    // 3-part blanket.
    expect(parseAccountVaultsScope("account:self:vaults")).toEqual({ id: "self", vault: null });
    expect(parseAccountVaultsScope("account:u_1:vaults")).toEqual({ id: "u_1", vault: null });
    // 4-part narrowed.
    expect(parseAccountVaultsScope("account:self:vaults:work")).toEqual({
      id: "self",
      vault: "work",
    });
    expect(parseAccountVaultsScope("account:u_1:vaults:moss")).toEqual({
      id: "u_1",
      vault: "moss",
    });
    // Malformed / non-member → null.
    expect(parseAccountVaultsScope("account:self:admin")).toBeNull(); // wrong verb
    expect(parseAccountVaultsScope("account:self:read")).toBeNull(); // wrong verb
    expect(parseAccountVaultsScope("vault:work:read")).toBeNull(); // wrong resource
    expect(parseAccountVaultsScope("account::vaults")).toBeNull(); // empty id (3-part)
    expect(parseAccountVaultsScope("account::vaults:work")).toBeNull(); // empty id (4-part)
    expect(parseAccountVaultsScope("account:self:vaults:")).toBeNull(); // empty vault
    expect(parseAccountVaultsScope("account:vaults")).toBeNull(); // 2-part un-narrowed has no id
    expect(parseAccountVaultsScope("account:self:vaults:a:b")).toBeNull(); // over-long
  });

  test("accountVaultsGrant — blanket wins, narrowed set, foreign-id ignored, empty→null", () => {
    // Blanket present → { blanket: true } (covers every vault the account owns).
    expect(accountVaultsGrant(["account:self:vaults"], "self")).toEqual({ blanket: true });
    // Blanket wins even alongside narrowed scopes and regardless of order.
    expect(accountVaultsGrant(["account:self:vaults:work", "account:self:vaults"], "self")).toEqual(
      { blanket: true },
    );
    // Narrowed only → the de-duped set of vault names.
    expect(accountVaultsGrant(["account:self:vaults:work"], "self")).toEqual({ vaults: ["work"] });
    expect(
      accountVaultsGrant(
        ["account:self:vaults:work", "account:self:vaults:moss", "account:self:vaults:work"],
        "self",
      ),
    ).toEqual({ vaults: ["work", "moss"] });
    // Foreign-id scopes are ignored — a grant for account A never covers B.
    expect(accountVaultsGrant(["account:u_2:vaults"], "u_1")).toBeNull();
    expect(accountVaultsGrant(["account:u_2:vaults:work"], "u_1")).toBeNull();
    // A foreign blanket alongside this id's narrowed → only this id's set.
    expect(accountVaultsGrant(["account:u_2:vaults", "account:u_1:vaults:work"], "u_1")).toEqual({
      vaults: ["work"],
    });
    // No account-vaults scope at all → null.
    expect(accountVaultsGrant([], "self")).toBeNull();
    expect(accountVaultsGrant(["account:self:admin", "vault:work:read"], "self")).toBeNull();
  });
});

describe("composed account-scope grammar (unified /mcp — Phase 1)", () => {
  test("constants + builders round-trip to the wire strings", () => {
    expect(COMPOSED_VAULTS_WILDCARD).toBe("*");
    expect(COMPOSED_VAULTS_SEGMENT).toBe("vaults");
    expect(COMPOSED_VAULT_CREATE_VERB).toBe("vault-create");
    expect(COMPOSED_MODULE_SEGMENT).toBe("mod");
    expect(composedWildcardVaultsScope("self", "read")).toBe("account:self:vaults:*:read");
    expect(composedVaultScope("u_1", "work", "write")).toBe("account:u_1:vaults:work:write");
    expect(composedVaultCreateScope("u_1")).toBe("account:u_1:vault-create");
    expect(composedModuleScope("u_1", "scribe", "admin")).toBe("account:u_1:mod:scribe:admin");
  });

  test("the composed verb ladder is admin ⊇ write ⊇ read", () => {
    expect(COMPOSED_VERB_RANK).toEqual({ read: 0, write: 1, admin: 2 });
    for (const v of ["read", "write", "admin"]) expect(isComposedVaultVerb(v)).toBe(true);
    for (const v of ["", "READ", "vaults", "delete", "*"])
      expect(isComposedVaultVerb(v)).toBe(false);
    // admin satisfies everything; write satisfies write+read; read only read.
    expect(composedVerbSatisfies("admin", "read")).toBe(true);
    expect(composedVerbSatisfies("admin", "write")).toBe(true);
    expect(composedVerbSatisfies("admin", "admin")).toBe(true);
    expect(composedVerbSatisfies("write", "read")).toBe(true);
    expect(composedVerbSatisfies("write", "write")).toBe(true);
    expect(composedVerbSatisfies("write", "admin")).toBe(false);
    expect(composedVerbSatisfies("read", "read")).toBe(true);
    expect(composedVerbSatisfies("read", "write")).toBe(false);
    expect(composedVerbSatisfies("read", "admin")).toBe(false);
  });

  // The composed grammar is carried on the aud="account" token; NONE of its new
  // forms may ever be requested — consent is the sole author. The legacy Wave A
  // blanket stays requestable (unchanged); every new form is refused.
  test("isRequestableAccountScope refuses every NEW composed form (consent-only)", () => {
    for (const scope of [
      "account:self:vaults:*:read", // wildcard
      "account:self:vaults:*:write",
      "account:self:vaults:*:admin",
      "account:self:vaults:work:read", // per-vault 5-part
      "account:u_1:vaults:work:write",
      "account:self:vault-create", // create capability
      "account:self:mod:scribe:read", // module
      "account:u_1:mod:notes:admin",
    ]) {
      expect(isRequestableAccountScope(scope)).toBe(false);
    }
    // The one legacy requestable form is untouched.
    expect(isRequestableAccountScope("account:vaults")).toBe(true);
    expect(isRequestableAccountScope("account:self:vaults")).toBe(true);
  });

  test("parseComposedAccountScope — wildcard vault grant", () => {
    expect(parseComposedAccountScope("account:self:vaults:*:read")).toEqual({
      kind: "wildcard-vaults",
      id: "self",
      verb: "read",
    });
    expect(parseComposedAccountScope("account:u_1:vaults:*:admin")).toEqual({
      kind: "wildcard-vaults",
      id: "u_1",
      verb: "admin",
    });
  });

  test("parseComposedAccountScope — per-vault (5-part) grant", () => {
    expect(parseComposedAccountScope("account:self:vaults:work:write")).toEqual({
      kind: "vault",
      id: "self",
      vault: "work",
      verb: "write",
    });
    expect(parseComposedAccountScope("account:u_1:vaults:moss:read")).toEqual({
      kind: "vault",
      id: "u_1",
      vault: "moss",
      verb: "read",
    });
  });

  test("parseComposedAccountScope — vault-create capability", () => {
    expect(parseComposedAccountScope("account:self:vault-create")).toEqual({
      kind: "vault-create",
      id: "self",
    });
    expect(parseComposedAccountScope("account:u_1:vault-create")).toEqual({
      kind: "vault-create",
      id: "u_1",
    });
  });

  test("parseComposedAccountScope — module grant", () => {
    expect(parseComposedAccountScope("account:self:mod:scribe:admin")).toEqual({
      kind: "module",
      id: "self",
      module: "scribe",
      verb: "admin",
    });
    expect(parseComposedAccountScope("account:u_1:mod:notes:read")).toEqual({
      kind: "module",
      id: "u_1",
      module: "notes",
      verb: "read",
    });
  });

  test("parseComposedAccountScope — legacy Wave A forms parse identically", () => {
    // The recognizer is a SUPERSET so a single pass extracts <id> from legacy
    // grants too (existing tokens/refresh families must keep parsing).
    expect(parseComposedAccountScope("account:self:vaults")).toEqual({
      kind: "legacy-blanket",
      id: "self",
    });
    expect(parseComposedAccountScope("account:u_1:vaults:work")).toEqual({
      kind: "legacy-vault",
      id: "u_1",
      vault: "work",
    });
  });

  test("parseComposedAccountScope — builders round-trip through the parser", () => {
    expect(parseComposedAccountScope(composedWildcardVaultsScope("self", "admin"))).toEqual({
      kind: "wildcard-vaults",
      id: "self",
      verb: "admin",
    });
    expect(parseComposedAccountScope(composedVaultScope("u_9", "moss", "read"))).toEqual({
      kind: "vault",
      id: "u_9",
      vault: "moss",
      verb: "read",
    });
    expect(parseComposedAccountScope(composedVaultCreateScope("u_9"))).toEqual({
      kind: "vault-create",
      id: "u_9",
    });
    expect(parseComposedAccountScope(composedModuleScope("u_9", "scribe", "write"))).toEqual({
      kind: "module",
      id: "u_9",
      module: "scribe",
      verb: "write",
    });
  });

  // §1.4 guardrail: the mint gate id-checks only what the parser recognizes; a
  // form parsing to null would SKIP the cross-account check. Every new family
  // (and a FOREIGN-id instance of each) must yield an extractable `id` so the
  // later mint gate can reject a foreign-id composed scope.
  test("§1.4 — every new family exposes an extractable id (mint-gate coverage)", () => {
    const foreign = [
      "account:attacker:vaults:*:admin",
      "account:attacker:vaults:secret:write",
      "account:attacker:vault-create",
      "account:attacker:mod:scribe:admin",
      "account:attacker:vaults", // legacy blanket
      "account:attacker:vaults:secret", // legacy narrowed
    ];
    for (const scope of foreign) {
      const parsed = parseComposedAccountScope(scope);
      expect(parsed).not.toBeNull();
      expect(parsed?.id).toBe("attacker"); // extractable → gate can reject foreign id
    }
  });

  test("parseComposedAccountScope — `*` is ONLY the wildcard, never a vault name", () => {
    // 5-part `vaults:*:<verb>` → wildcard (above). A 4-part legacy narrowed form
    // with `*` in the vault slot is NOT a real vault → fail closed.
    expect(parseComposedAccountScope("account:self:vaults:*")).toBeNull();
    // And a `*` module name (empty-ish sentinel misuse) still parses as a literal
    // module string only in the 5-part mod family — `*` is not special there.
    expect(parseComposedAccountScope("account:self:mod:*:read")).toEqual({
      kind: "module",
      id: "self",
      module: "*",
      verb: "read",
    });
  });

  test("parseComposedAccountScope — the account-verb ladder is NOT a composed form", () => {
    // `account:<id>:{read,admin}` belong to parseAccountScope, not here.
    expect(parseComposedAccountScope("account:self:admin")).toBeNull();
    expect(parseComposedAccountScope("account:self:read")).toBeNull();
    // `write` is not even an account verb — still null.
    expect(parseComposedAccountScope("account:self:write")).toBeNull();
  });

  test("parseComposedAccountScope — garbage / casing / whitespace fail closed → null", () => {
    for (const scope of [
      "", // empty
      "account", // bare
      "account:", // trailing empty id
      "account::vaults:*:read", // empty id
      "account:self", // 2-part
      "vault:work:read", // non-account resource
      "Account:self:vaults:*:read", // resource casing
      "account:self:Vaults:*:read", // family casing
      "account:self:vaults:*:READ", // verb casing
      "account:self:vaults:*:delete", // unknown verb
      "account:self:vaults::read", // empty vault (5-part)
      "account:self:mod::read", // empty module
      "account:self:MOD:scribe:read", // module-family casing
      "account:self:widgets:x:read", // unknown 5-part family
      "account:self:vaults:*:read:extra", // over-long (6-part)
      "account:self:mod:scribe:read:extra", // over-long
      " account:self:vault-create", // leading whitespace
      "account:self:vault-create ", // trailing whitespace on the verb-slot
      "account:self:Vault-Create", // create casing
    ]) {
      expect(parseComposedAccountScope(scope)).toBeNull();
    }
  });

  test("composedAccountGrant — wildcard coverage keeps the highest verb", () => {
    expect(composedAccountGrant(["account:self:vaults:*:read"], "self")).toEqual({
      wildcard: "read",
      vaults: new Map(),
      create: false,
      modules: new Map(),
    });
    // read + admin wildcards → admin wins (highest rung), order-independent.
    expect(
      composedAccountGrant(["account:self:vaults:*:read", "account:self:vaults:*:admin"], "self")
        .wildcard,
    ).toBe("admin");
    expect(
      composedAccountGrant(["account:self:vaults:*:admin", "account:self:vaults:*:read"], "self")
        .wildcard,
    ).toBe("admin");
  });

  test("composedAccountGrant — explicit per-vault map (highest verb per name)", () => {
    const cov = composedAccountGrant(
      [
        "account:self:vaults:work:read",
        "account:self:vaults:work:admin", // raises work → admin
        "account:self:vaults:moss:write",
      ],
      "self",
    );
    expect(cov.wildcard).toBeNull();
    expect(cov.vaults).toEqual(
      new Map([
        ["work", "admin"],
        ["moss", "write"],
      ]),
    );
    expect(cov.create).toBe(false);
    expect(cov.modules.size).toBe(0);
  });

  test("composedAccountGrant — the create flag", () => {
    expect(composedAccountGrant(["account:self:vault-create"], "self").create).toBe(true);
    expect(composedAccountGrant(["account:self:vaults:work:read"], "self").create).toBe(false);
  });

  test("composedAccountGrant — module map (highest verb per module)", () => {
    const cov = composedAccountGrant(
      [
        "account:self:mod:scribe:read",
        "account:self:mod:scribe:write", // raises scribe → write
        "account:self:mod:notes:admin",
      ],
      "self",
    );
    expect(cov.modules).toEqual(
      new Map([
        ["scribe", "write"],
        ["notes", "admin"],
      ]),
    );
  });

  test("composedAccountGrant — a mixed composed set derives all four axes", () => {
    const cov = composedAccountGrant(
      [
        "account:self:vaults:*:read",
        "account:self:vaults:work:admin",
        "account:self:vault-create",
        "account:self:mod:scribe:write",
        // legacy verb-less forms are NOT folded into composed coverage.
        "account:self:vaults",
        "account:self:vaults:archive",
      ],
      "self",
    );
    expect(cov.wildcard).toBe("read");
    expect(cov.vaults).toEqual(new Map([["work", "admin"]])); // NOT "archive" (legacy)
    expect(cov.create).toBe(true);
    expect(cov.modules).toEqual(new Map([["scribe", "write"]]));
  });

  test("composedAccountGrant — foreign-id scopes are ignored (grant for A never covers B)", () => {
    const cov = composedAccountGrant(
      [
        "account:u_2:vaults:*:admin", // foreign wildcard
        "account:u_2:vaults:work:admin", // foreign vault
        "account:u_2:vault-create", // foreign create
        "account:u_2:mod:scribe:admin", // foreign module
        "account:u_1:vaults:mine:read", // this id
      ],
      "u_1",
    );
    expect(cov.wildcard).toBeNull();
    expect(cov.vaults).toEqual(new Map([["mine", "read"]]));
    expect(cov.create).toBe(false);
    expect(cov.modules.size).toBe(0);
  });

  test("composedAccountGrant — an empty / non-composed set yields empty coverage", () => {
    const empty = { wildcard: null, vaults: new Map(), create: false, modules: new Map() };
    expect(composedAccountGrant([], "self")).toEqual(empty);
    expect(composedAccountGrant(["account:self:admin", "vault:work:read"], "self")).toEqual(empty);
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
