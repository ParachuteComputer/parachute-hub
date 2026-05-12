import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClient, registerClient } from "../clients.ts";
import { CSRF_COOKIE_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { findTokenRowByJti, validateAccessToken } from "../jwt-sign.ts";
import {
  authorizationServerMetadata,
  buildServicesCatalog,
  handleApproveClientPost,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleRevoke,
  handleToken,
} from "../oauth-handlers.ts";
import type { ServicesManifest } from "../services-manifest.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.example";
const TEST_CSRF = "csrf-test-token";
const CSRF_COOKIE = `${CSRF_COOKIE_NAME}=${TEST_CSRF}`;

async function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-oauth-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

function makePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizeUrl(params: Record<string, string>): string {
  const u = new URL("/oauth/authorize", ISSUER);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

const FIXTURE_MANIFEST: ServicesManifest = {
  services: [
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/health",
      version: "0.3.0",
    },
    {
      name: "parachute-scribe",
      port: 1943,
      paths: ["/scribe"],
      health: "/health",
      version: "0.3.0-rc.1",
    },
    {
      name: "parachute-notes",
      port: 1942,
      paths: ["/notes"],
      health: "/notes/health",
      version: "0.3.0",
    },
  ],
};

function fixtureLoadServicesManifest(): ServicesManifest {
  return FIXTURE_MANIFEST;
}

describe("authorizationServerMetadata", () => {
  test("emits RFC 8414 fields rooted at the issuer", async () => {
    const res = authorizationServerMetadata({ issuer: ISSUER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(body.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toContain("authorization_code");
    expect(body.grant_types_supported).toContain("refresh_token");
    // closes #68 — scopes_supported populated from FIRST_PARTY_SCOPES
    const scopesSupported = body.scopes_supported as string[];
    expect(scopesSupported).toContain("vault:read");
    expect(scopesSupported).toContain("vault:admin");
    expect(scopesSupported).toContain("scribe:transcribe");
    expect(scopesSupported).toContain("hub:admin");
  });

  test("does NOT advertise non-requestable operator-only scopes", async () => {
    // #96: parachute:host:admin is operator-only. RFC 8414 §2 frames
    // scopes_supported as scopes a client *can* request — advertising what
    // we always reject would mislead clients.
    const res = authorizationServerMetadata({ issuer: ISSUER });
    const body = (await res.json()) as Record<string, unknown>;
    const scopesSupported = body.scopes_supported as string[];
    expect(scopesSupported).not.toContain("parachute:host:admin");
  });

  test("advertises third-party module scopes from loadDeclaredScopes", async () => {
    // #91: scopes_supported pulls from `loadDeclaredScopes()` (FIRST_PARTY ∪
    // each registered module's `scopes.defines`) so standards-following
    // clients discover third-party scopes the same way they discover
    // first-party ones. The token-issuance path already uses
    // loadDeclaredScopes (#90); the AS metadata had to follow or its public
    // advertisement would be a strict subset of what it'll actually sign.
    const declared = new Set<string>([
      "vault:read",
      "vault:admin",
      "hub:admin",
      "parachute:host:admin", // declared but operator-only — must still be filtered
      "agent:read",
      "agent:write",
      "mymodule:do-thing",
    ]);
    const res = authorizationServerMetadata({
      issuer: ISSUER,
      loadDeclaredScopes: () => declared,
    });
    const body = (await res.json()) as Record<string, unknown>;
    const scopesSupported = body.scopes_supported as string[];
    // Third-party scopes show up
    expect(scopesSupported).toContain("agent:read");
    expect(scopesSupported).toContain("agent:write");
    expect(scopesSupported).toContain("mymodule:do-thing");
    // First-party still advertised — no regression
    expect(scopesSupported).toContain("vault:read");
    expect(scopesSupported).toContain("vault:admin");
    expect(scopesSupported).toContain("hub:admin");
    // NON_REQUESTABLE filter still applies even when the scope is declared
    expect(scopesSupported).not.toContain("parachute:host:admin");
  });
});

describe("handleAuthorizeGet", () => {
  test("renders login form when no session cookie is present", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:read",
          state: "xyz",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sign in");
      expect(html).toContain('name="__action" value="login"');
      // State + redirect_uri must be echoed via hidden inputs.
      expect(html).toContain('name="state" value="xyz"');
      expect(html).toContain('name="redirect_uri" value="https://app.example/cb"');
    } finally {
      cleanup();
    }
  });

  test("renders consent screen when session is valid", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "MyApp",
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:read",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Authorize");
      expect(html).toContain("MyApp");
      expect(html).toContain("vault:read");
      expect(html).toContain('name="__action" value="consent"');
    } finally {
      cleanup();
    }
  });

  test("rejects unknown client_id with 400", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: "no-such-client",
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("rejects redirect_uri not registered for this client", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://evil.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("rejects parachute:host:admin scope with invalid_scope redirect (#96)", async () => {
    // Operator-only scopes — third-party apps cannot mint them via the
    // public flow. Per RFC 6749 §4.1.2.1, scope failures redirect to the
    // registered redirect_uri with error=invalid_scope, not an HTML error.
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:read parachute:host:admin",
          state: "abc",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("error")).toBe("invalid_scope");
      expect(loc.searchParams.get("error_description")).toContain("parachute:host:admin");
      expect(loc.searchParams.get("state")).toBe("abc");
    } finally {
      cleanup();
    }
  });

  test("rejects code_challenge_method=plain (PKCE S256 mandatory)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: "challenge",
          code_challenge_method: "plain",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = res.headers.get("location");
      expect(loc).toContain("error=invalid_request");
    } finally {
      cleanup();
    }
  });
});

// Q1 of 2026-04-28-vault-config-and-scopes.md: an unnamed `vault:<verb>` is
// ambiguous, so the consent screen forces the operator to pick a vault before
// the JWT is minted. Picked vault rewrites the scope to `vault:<picked>:<verb>`
// and stamps `aud=vault.<picked>` so vault's strict per-resource enforcement
// (Phase 1) can match the audience against the URL-derived vault name.
describe("handleAuthorizeGet — vault picker", () => {
  test("renders the picker when scope is unnamed vault:<verb>", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:read",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Pick a vault");
      // The fixture manifest's `parachute-vault` has paths `["/vault/default"]`
      // — that's the one available vault in the picker.
      expect(html).toContain('name="vault_pick" value="default"');
    } finally {
      cleanup();
    }
  });

  test("picker is omitted when scope is already named vault:<name>:<verb>", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:work:read",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("Pick a vault");
      expect(html).not.toContain('name="vault_pick"');
    } finally {
      cleanup();
    }
  });

  test("picker shows a help message and disables Approve when no vaults exist", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:read",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: () => ({ services: [] }),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Pick a vault");
      expect(html).toContain("no vaults exist");
      expect(html).toContain('name="approve" value="yes" class="btn btn-primary" disabled');
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizePost — vault picker", () => {
  test("approve with vault_pick narrows vault:read → vault:<picked>:read in the issued JWT", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        vault_pick: "default",
      });
      const consentReq = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
        },
      });
      const consentRes = await handleAuthorizePost(db, consentReq, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(consentRes.status).toBe(302);
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      expect(code).toBeTruthy();

      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const tokenRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as { access_token: string; scope: string };
      expect(body.scope).toBe("vault:default:read");

      const { payload } = await validateAccessToken(db, body.access_token, ISSUER);
      expect(payload.aud).toBe("vault.default");
      expect(payload.scope).toBe("vault:default:read");
    } finally {
      cleanup();
    }
  });

  test("approve without vault_pick on unnamed vault scope fails 400", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const res = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Pick a vault");
    } finally {
      cleanup();
    }
  });

  test("approve with vault_pick that names an unknown vault fails 400", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        vault_pick: "evil-vault",
      });
      const res = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Unknown vault");
    } finally {
      cleanup();
    }
  });

  test("multiple unnamed verbs are all narrowed to the picked vault", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read vault:write",
        code_challenge: challenge,
        code_challenge_method: "S256",
        vault_pick: "default",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code ?? "",
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
          }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(tokenRes.status).toBe(200);
      const body = (await tokenRes.json()) as { scope: string };
      expect(body.scope).toBe("vault:default:read vault:default:write");
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizePost — login submit", () => {
  test("sets session cookie and redirects to GET on valid credentials", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "owner", "hunter2");
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "login",
        __csrf: TEST_CSRF,
        username: "owner",
        password: "hunter2",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: CSRF_COOKIE,
        },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/oauth/authorize?");
      const cookie = res.headers.get("set-cookie");
      expect(cookie).toContain("parachute_hub_session=");
      expect(cookie).toContain("HttpOnly");
    } finally {
      cleanup();
    }
  });

  test("rejects bad password with 401, no cookie", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "owner", "hunter2");
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "login",
        __csrf: TEST_CSRF,
        username: "owner",
        password: "wrong",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: CSRF_COOKIE,
        },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizePost — CSRF protection", () => {
  test("rejects POST when CSRF cookie is absent", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "owner", "hunter2");
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "login",
        __csrf: TEST_CSRF,
        username: "owner",
        password: "hunter2",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Invalid form submission");
    } finally {
      cleanup();
    }
  });

  test("rejects POST when CSRF form field is absent", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "owner", "hunter2");
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "login",
        username: "owner",
        password: "hunter2",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: CSRF_COOKIE,
        },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("rejects POST when CSRF cookie and form field do not match", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "owner", "hunter2");
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "login",
        __csrf: "different-token",
        username: "owner",
        password: "hunter2",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: CSRF_COOKIE,
        },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("GET /oauth/authorize sets CSRF cookie when none is present", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const url = authorizeUrl({
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const res = handleAuthorizeGet(db, new Request(url), { issuer: ISSUER });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain(`${CSRF_COOKIE_NAME}=`);
      expect(setCookie).toContain("HttpOnly");
      // The rendered form must echo the same token as a hidden input.
      const html = await res.text();
      expect(html).toContain('name="__csrf"');
    } finally {
      cleanup();
    }
  });

  test("GET /oauth/authorize reuses an existing CSRF cookie", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const url = authorizeUrl({
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const res = handleAuthorizeGet(db, new Request(url, { headers: { cookie: CSRF_COOKIE } }), {
        issuer: ISSUER,
      });
      expect(res.status).toBe(200);
      // No new cookie minted when one already exists.
      expect(res.headers.get("set-cookie")).toBeNull();
      const html = await res.text();
      expect(html).toContain(`value="${TEST_CSRF}"`);
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizePost — consent submit", () => {
  test("approve issues an auth code and redirects to redirect_uri", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:default:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc123",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
        },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("code")?.length).toBeGreaterThan(20);
      expect(loc.searchParams.get("state")).toBe("abc123");
    } finally {
      cleanup();
    }
  });

  test("rejects parachute:host:admin in form scope (defense-in-depth, #96)", async () => {
    // GET-time gate already rejects, but a hand-crafted POST could carry
    // an operator-only scope. Consent submit must independently reject.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "parachute:host:admin",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
        },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.searchParams.get("error")).toBe("invalid_scope");
      expect(loc.searchParams.get("error_description")).toContain("parachute:host:admin");
    } finally {
      cleanup();
    }
  });

  test("deny returns access_denied with state echoed", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "no",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc",
      });
      const req = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
        },
      });
      const res = await handleAuthorizePost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.searchParams.get("error")).toBe("access_denied");
      expect(loc.searchParams.get("state")).toBe("abc");
    } finally {
      cleanup();
    }
  });
});

describe("handleToken — full OAuth dance", () => {
  test("authorize → token → validate JWT", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();

      // Approve consent → auth code lands in redirect_uri.
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:default:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentReq = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
        },
      });
      const consentRes = await handleAuthorizePost(db, consentReq, { issuer: ISSUER });
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      expect(code).toBeTruthy();

      // Redeem.
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const tokenReq = new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: tokenForm,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const tokenRes = await handleToken(db, tokenReq, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
        token_type: string;
        expires_in: number;
        scope: string;
        services: Record<string, { url: string; version: string }>;
      };
      expect(tokenBody.token_type).toBe("Bearer");
      expect(tokenBody.scope).toBe("vault:default:read");
      expect(tokenBody.refresh_token.length).toBeGreaterThan(20);

      // JWT must verify against the hub's signing keys, with the right sub +
      // aud (named `vault:default:read` → "vault.default" — RFC 8707-style
      // resource binding from the vault-config-and-scopes Phase 1+2 design)
      // and iss matching the configured issuer (closes #77 — vault rejects
      // tokens with a missing or mismatched iss).
      const { payload } = await validateAccessToken(db, tokenBody.access_token, ISSUER);
      expect(payload.sub).toBe(user.id);
      expect(payload.aud).toBe("vault.default");
      expect(payload.iss).toBe(ISSUER);
      expect(payload.scope).toBe("vault:default:read");
      expect(payload.client_id).toBe(reg.client.clientId);

      // closes #81 — services catalog tells the client where vault lives so
      // notes doesn't have to re-probe /.well-known/parachute.json. A
      // `vault:default:read` token sees both the collapsed `vault` key
      // (backwards compat) AND the per-vault `vault:default` key (closes
      // #247 — pre-#247 only the collapsed key was emitted; consumers on
      // multi-vault hubs were forced to assume `/vault/default` and
      // collided).
      expect(tokenBody.services).toEqual({
        vault: { url: `${ISSUER}/vault/default`, version: "0.3.0" },
        "vault:default": { url: `${ISSUER}/vault/default`, version: "0.3.0" },
      });

      // closes #215 reviewer F2 — Phase 1 code-grant access-token registry
      // exemption pinning. The access token and refresh token share `jti`
      // by design (signRefreshToken({ jti: access.jti, ... }) at the mint
      // site), so the `tokens` row keyed by the access-token jti IS the
      // shared row — refresh_token_hash is non-null, created_via is
      // 'oauth_refresh'. We deliberately don't write a separate per-jti
      // access-token row; revocation acts on the shared jti / family,
      // bounded by the 15-min access TTL.
      expect(payload.jti).toBeTruthy();
      const row = findTokenRowByJti(db, payload.jti as string);
      expect(row).not.toBeNull();
      expect(row?.createdVia).toBe("oauth_refresh");
      expect(row?.familyId).toBeTruthy();
      // Verify the registry has exactly one row for this code-grant
      // (not two — no separate access-token row).
      const rowCount = (
        db
          .query<{ n: number }, [string]>("SELECT COUNT(*) as n FROM tokens WHERE jti = ?")
          .get(payload.jti as string) ?? { n: 0 }
      ).n;
      expect(rowCount).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("auth code is single-use (replay returns invalid_grant)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentReq = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
        },
      });
      const consentRes = await handleAuthorizePost(db, consentReq, { issuer: ISSUER });
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");

      const exchange = () => {
        const form = new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          code_verifier: verifier,
        });
        const req = new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: form,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        });
        return handleToken(db, req, { issuer: ISSUER });
      };

      const first = await exchange();
      expect(first.status).toBe(200);
      const second = await exchange();
      expect(second.status).toBe(400);
      const err = (await second.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_grant");
    } finally {
      cleanup();
    }
  });

  test("refresh_token grant rotates the pair and revokes the old refresh", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:default:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentReq = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
        },
      });
      const consentRes = await handleAuthorizePost(db, consentReq, { issuer: ISSUER });
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const tokenRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      const initial = (await tokenRes.json()) as { refresh_token: string };

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
      });
      const refreshRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: refreshForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(refreshRes.status).toBe(200);
      const rotated = (await refreshRes.json()) as { refresh_token: string };
      expect(rotated.refresh_token).not.toBe(initial.refresh_token);

      // Old refresh token should now fail (revoked).
      const replayRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: refreshForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(replayRes.status).toBe(400);
      const err = (await replayRes.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_grant");
    } finally {
      cleanup();
    }
  });

  test("client_credentials returns unsupported_grant_type", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const form = new URLSearchParams({ grant_type: "client_credentials" });
      const req = new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        body: form,
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      const res = await handleToken(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("unsupported_grant_type");
    } finally {
      cleanup();
    }
  });

  test("PKCE verifier mismatch returns invalid_grant", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: "wrong-verifier",
      });
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_grant");
    } finally {
      cleanup();
    }
  });

  // cli#71 — scope-validation gate at /oauth/token. The hub must not sign a
  // JWT carrying scopes the issuer never declared.
  test("unknown scope at /oauth/token returns invalid_scope (400)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:default:read frobnicate:everything",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_scope");
      expect(err.error_description).toMatch(/frobnicate:everything/);
      expect(err.invalid_scopes).toEqual(["frobnicate:everything"]);
    } finally {
      cleanup();
    }
  });

  test("third-party scope from injected declared set is accepted", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "widget:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const declared = new Set(["widget:read"]);
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadDeclaredScopes: () => declared },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scope: string };
      expect(body.scope).toBe("widget:read");
    } finally {
      cleanup();
    }
  });

  test("per-resource narrowing (vault:work:read against declared vault:read)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:work:read",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scope: string };
      expect(body.scope).toBe("vault:work:read");
    } finally {
      cleanup();
    }
  });

  // closes #81 — services-catalog filtering + multi-service shape.
  test("services catalog omits services the token has no scope for", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "scribe:transcribe",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentRes = await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER },
      );
      const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: tokenForm,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        services: Record<string, { url: string; version: string }>;
      };
      expect(body.services).toEqual({
        scribe: { url: `${ISSUER}/scribe`, version: "0.3.0-rc.1" },
      });
      expect(body.services.vault).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("services catalog includes every service the token has a scope for", async () => {
    // buildServicesCatalog is a pure helper — exercise the multi-scope shape
    // here without re-running the full PKCE dance.
    const catalog = buildServicesCatalog(FIXTURE_MANIFEST, ISSUER, [
      "vault:read",
      "scribe:transcribe",
    ]);
    expect(catalog).toEqual({
      vault: { url: `${ISSUER}/vault/default`, version: "0.3.0" },
      scribe: { url: `${ISSUER}/scribe`, version: "0.3.0-rc.1" },
    });
  });

  test("services catalog is empty when the token has no resource-prefixed scopes", () => {
    expect(buildServicesCatalog(FIXTURE_MANIFEST, ISSUER, [])).toEqual({});
    // hub-only scopes don't reference any installed module catalog entry.
    expect(buildServicesCatalog(FIXTURE_MANIFEST, ISSUER, ["hub:admin"])).toEqual({});
  });

  // closes #81 — vault URL must follow paths[0] from services.json, NOT a
  // hardcoded `/vault/default`. Users who installed with `--vault-name work`
  // have `paths: ["/vault/work"]` and the catalog must reflect that.
  test("services catalog reads paths[0] verbatim — handles custom vault names", () => {
    const customManifest: ServicesManifest = {
      services: [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/work"],
          health: "/health",
          version: "0.3.0",
        },
      ],
    };
    expect(buildServicesCatalog(customManifest, ISSUER, ["vault:read"])).toEqual({
      vault: { url: `${ISSUER}/vault/work`, version: "0.3.0" },
    });
  });

  // closes #247 — multi-vault correctness. Pre-#247 every vault collapsed
  // under the single `vault` key, so Notes' OAuthCallback always wrote
  // VaultRecord URL = paths[0] of the first vault row regardless of which
  // vault the token actually granted. Per-vault `vault:<name>` keys let
  // consumers route each grant to the correct vault URL.
  describe("services catalog — multi-vault per-vault keys (#247)", () => {
    // Real shape from a multi-vault hub: one `parachute-vault` row with N
    // paths, each path naming an instance. Aaron's setup verbatim (4
    // vaults: default, boulder, gitcoin, techne).
    const multiVaultManifest: ServicesManifest = {
      services: [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default", "/vault/boulder", "/vault/gitcoin", "/vault/techne"],
          health: "/health",
          version: "0.4.4",
        },
      ],
    };

    test("single-vault hub with broad scope: only collapsed `vault` key (unchanged)", () => {
      // Per-vault keys are noise on single-vault hubs — no disambiguation
      // is needed. Backwards compat for pre-popover clients matters here.
      expect(buildServicesCatalog(FIXTURE_MANIFEST, ISSUER, ["vault:read"])).toEqual({
        vault: { url: `${ISSUER}/vault/default`, version: "0.3.0" },
      });
    });

    test("single-vault hub with per-vault-narrowed scope: emits per-vault key too", () => {
      // A `vault:default:read` token is an explicit consumer signal that
      // the per-vault key matters — emit it even on a single-vault hub so
      // the consumer's `services["vault:default"]` lookup works uniformly
      // regardless of how many vaults the hub has.
      expect(buildServicesCatalog(FIXTURE_MANIFEST, ISSUER, ["vault:default:read"])).toEqual({
        vault: { url: `${ISSUER}/vault/default`, version: "0.3.0" },
        "vault:default": { url: `${ISSUER}/vault/default`, version: "0.3.0" },
      });
    });

    test("multi-vault hub with broad scope: emits every per-vault key + collapsed `vault`", () => {
      // Broad `vault:read` admits every vault on the hub. Per-#247
      // guidance: emit per-vault keys for all admitted vaults so the
      // consumer (Notes popover) can pick its target by name without
      // re-probing /.well-known/parachute.json.
      expect(buildServicesCatalog(multiVaultManifest, ISSUER, ["vault:read"])).toEqual({
        // Collapsed key still emitted (first admitted path); backwards compat.
        vault: { url: `${ISSUER}/vault/default`, version: "0.4.4" },
        "vault:default": { url: `${ISSUER}/vault/default`, version: "0.4.4" },
        "vault:boulder": { url: `${ISSUER}/vault/boulder`, version: "0.4.4" },
        "vault:gitcoin": { url: `${ISSUER}/vault/gitcoin`, version: "0.4.4" },
        "vault:techne": { url: `${ISSUER}/vault/techne`, version: "0.4.4" },
      });
    });

    test("multi-vault hub with per-vault scope: only that vault's per-vault key", () => {
      // Aaron's "Connect boulder" flow: token has `vault:boulder:write`,
      // scope admits only boulder. Pre-#247 the catalog said `vault.url =
      // /vault/default` (WRONG), so Notes stored a /vault/default record
      // with scope `vault:boulder:write` — collision city as more vaults
      // got connected. Post-#247 the consumer reads
      // `services["vault:boulder"].url` which correctly says /vault/boulder.
      expect(buildServicesCatalog(multiVaultManifest, ISSUER, ["vault:boulder:write"])).toEqual({
        // Collapsed `vault` points at boulder too — the only admitted
        // vault — so legacy consumers happen to land on the right URL even
        // though they have no per-vault awareness.
        vault: { url: `${ISSUER}/vault/boulder`, version: "0.4.4" },
        "vault:boulder": { url: `${ISSUER}/vault/boulder`, version: "0.4.4" },
      });
    });

    test("multi-vault hub with mixed scopes: per-vault keys for each narrowed vault", () => {
      // A token granting both `vault:boulder:read` and `vault:gitcoin:write`
      // admits exactly those two vaults; default and techne aren't reachable.
      expect(
        buildServicesCatalog(multiVaultManifest, ISSUER, [
          "vault:boulder:read",
          "vault:gitcoin:write",
        ]),
      ).toEqual({
        vault: { url: `${ISSUER}/vault/boulder`, version: "0.4.4" },
        "vault:boulder": { url: `${ISSUER}/vault/boulder`, version: "0.4.4" },
        "vault:gitcoin": { url: `${ISSUER}/vault/gitcoin`, version: "0.4.4" },
      });
    });

    test("multi-vault hub: broad + per-vault scopes coexist; broad opens all vaults", () => {
      // A token that carries BOTH `vault:read` (broad) AND
      // `vault:boulder:write` (narrow) should land in the broad bucket
      // because the broad scope is more permissive — narrowing one verb
      // can't take away access the unnamed scope already granted.
      expect(
        buildServicesCatalog(multiVaultManifest, ISSUER, ["vault:read", "vault:boulder:write"]),
      ).toEqual({
        vault: { url: `${ISSUER}/vault/default`, version: "0.4.4" },
        "vault:default": { url: `${ISSUER}/vault/default`, version: "0.4.4" },
        "vault:boulder": { url: `${ISSUER}/vault/boulder`, version: "0.4.4" },
        "vault:gitcoin": { url: `${ISSUER}/vault/gitcoin`, version: "0.4.4" },
        "vault:techne": { url: `${ISSUER}/vault/techne`, version: "0.4.4" },
      });
    });

    test("legacy per-vault rows (parachute-vault-<name>) also produce per-vault keys", () => {
      // Older multi-vault layout — one row per vault — should produce the
      // same catalog shape as the single-row-multi-path layout. The
      // `vaultInstanceNameFor` helper handles both via its
      // manifest-suffix fallback.
      const legacyManifest: ServicesManifest = {
        services: [
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            version: "0.4.4",
          },
          {
            name: "parachute-vault-work",
            port: 1941,
            paths: ["/vault/work"],
            health: "/health",
            version: "0.4.4",
          },
        ],
      };
      expect(buildServicesCatalog(legacyManifest, ISSUER, ["vault:read"])).toEqual({
        vault: { url: `${ISSUER}/vault/default`, version: "0.4.4" },
        "vault:default": { url: `${ISSUER}/vault/default`, version: "0.4.4" },
        "vault:work": { url: `${ISSUER}/vault/work`, version: "0.4.4" },
      });
    });

    test("non-vault services unaffected — only one key per service, no per-instance variant", () => {
      // The per-vault-key expansion is vault-specific. scribe / notes /
      // third-party rows still emit one key per service.
      expect(
        buildServicesCatalog(FIXTURE_MANIFEST, ISSUER, [
          "vault:default:read",
          "scribe:transcribe",
          "notes:read",
        ]),
      ).toEqual({
        vault: { url: `${ISSUER}/vault/default`, version: "0.3.0" },
        "vault:default": { url: `${ISSUER}/vault/default`, version: "0.3.0" },
        scribe: { url: `${ISSUER}/scribe`, version: "0.3.0-rc.1" },
        notes: { url: `${ISSUER}/notes`, version: "0.3.0" },
      });
    });
  });
});

// closes #72 — RFC 6749 §3.2.1 + §2.3.1: confidential clients must
// authenticate at /oauth/token via Authorization: Basic header (preferred)
// or form-body client_secret. Public clients (PKCE-only) are unaffected
// because PKCE replaces the secret for them.
describe("handleToken — confidential client authentication (#72)", () => {
  // Helper: drive the consent screen for `clientId` to a fresh auth code.
  // Returns the code + the verifier so the caller can hit /oauth/token.
  async function consentAndGetCode(
    db: Awaited<ReturnType<typeof makeDb>>["db"],
    clientId: string,
    sessionId: string,
  ): Promise<{ code: string; verifier: string }> {
    const { verifier, challenge } = makePkce();
    const consentForm = new URLSearchParams({
      __action: "consent",
      __csrf: TEST_CSRF,
      approve: "yes",
      client_id: clientId,
      redirect_uri: "https://app.example/cb",
      response_type: "code",
      scope: "vault:default:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const consentRes = await handleAuthorizePost(
      db,
      new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(sessionId, 86400)}`,
        },
      }),
      { issuer: ISSUER },
    );
    const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
    return { code: code ?? "", verifier };
  }

  function tokenRequest(form: URLSearchParams, headers: Record<string, string> = {}): Request {
    return new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    });
  }

  test("authorization_code: confidential client + correct secret in form body → 200", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      expect(reg.clientSecret).not.toBeNull();
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
        client_secret: reg.clientSecret ?? "",
      });
      const res = await handleToken(db, tokenRequest(tokenForm), {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("authorization_code: confidential client + correct secret in Authorization: Basic header → 200", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
        // No client_secret in the body — the header carries it.
      });
      // RFC 6749 §2.3.1 requires form-encoding the credentials before base64.
      const basic = btoa(
        `${encodeURIComponent(reg.client.clientId)}:${encodeURIComponent(reg.clientSecret ?? "")}`,
      );
      const res = await handleToken(
        db,
        tokenRequest(tokenForm, { authorization: `Basic ${basic}` }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("authorization_code: confidential client + wrong secret → 401 + WWW-Authenticate Basic", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
        client_secret: "definitely-not-the-real-secret",
      });
      const res = await handleToken(db, tokenRequest(tokenForm), { issuer: ISSUER });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic\b/i);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
    } finally {
      cleanup();
    }
  });

  test("authorization_code: confidential client + missing secret → 401 + WWW-Authenticate Basic", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      // No client_secret in form, no Authorization header.
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const res = await handleToken(db, tokenRequest(tokenForm), { issuer: ISSUER });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic\b/i);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
      expect(err.error_description).toMatch(/required/);
    } finally {
      cleanup();
    }
  });

  test("authorization_code: Basic header client_id mismatch with body → 401", async () => {
    // Defensive: a header authenticating as one client while the body claims
    // another is a confused or hostile request — refuse rather than guess.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const basic = btoa(
        `${encodeURIComponent("some-other-client")}:${encodeURIComponent(reg.clientSecret ?? "")}`,
      );
      const res = await handleToken(
        db,
        tokenRequest(tokenForm, { authorization: `Basic ${basic}` }),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(401);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
      expect(err.error_description).toMatch(/header client_id/);
    } finally {
      cleanup();
    }
  });

  test("authorization_code: public client unaffected (no secret required) → 200", async () => {
    // Regression: PKCE-only clients must keep working with no client_secret.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      expect(reg.clientSecret).toBeNull();
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const tokenForm = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: verifier,
      });
      const res = await handleToken(db, tokenRequest(tokenForm), {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("refresh_token: confidential client + correct secret rotates the pair", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      // Mint an initial refresh token (one full dance with the secret).
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const initialTokenRes = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
            client_secret: reg.clientSecret ?? "",
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const initial = (await initialTokenRes.json()) as { refresh_token: string };

      // Refresh with secret → 200.
      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
        client_secret: reg.clientSecret ?? "",
      });
      const refreshRes = await handleToken(db, tokenRequest(refreshForm), {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(refreshRes.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("refresh_token: confidential client + missing secret → 401", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const initialTokenRes = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
            client_secret: reg.clientSecret ?? "",
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const initial = (await initialTokenRes.json()) as { refresh_token: string };

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
        // No client_secret.
      });
      const res = await handleToken(db, tokenRequest(refreshForm), { issuer: ISSUER });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic\b/i);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
    } finally {
      cleanup();
    }
  });

  test("refresh_token: confidential client + wrong secret → 401", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const initialTokenRes = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
            client_secret: reg.clientSecret ?? "",
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const initial = (await initialTokenRes.json()) as { refresh_token: string };

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
        client_secret: "wrong-secret",
      });
      const res = await handleToken(db, tokenRequest(refreshForm), { issuer: ISSUER });
      expect(res.status).toBe(401);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
    } finally {
      cleanup();
    }
  });

  test("refresh_token: public client unaffected (no secret required) → 200", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { code, verifier } = await consentAndGetCode(db, reg.client.clientId, session.id);
      const initialTokenRes = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            code_verifier: verifier,
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const initial = (await initialTokenRes.json()) as { refresh_token: string };

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
      });
      const res = await handleToken(db, tokenRequest(refreshForm), {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });
});

describe("handleRegister — RFC 7591 DCR", () => {
  test("registers a public client and returns 201 with client_id (no secret)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["https://app.example/cb"],
          scope: "vault:read",
          client_name: "MyApp",
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.client_id).toBe("string");
      expect(body.client_secret).toBeUndefined();
      expect(body.token_endpoint_auth_method).toBe("none");
      expect(body.redirect_uris).toEqual(["https://app.example/cb"]);
      expect(body.client_name).toBe("MyApp");
      // #74 — unauthenticated DCR lands as pending until an operator approves.
      expect(body.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("registers a confidential client and returns plaintext client_secret", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({
          redirect_uris: ["https://app.example/cb"],
          token_endpoint_auth_method: "client_secret_post",
        }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.client_secret).toBe("string");
      expect(body.token_endpoint_auth_method).toBe("client_secret_post");
    } finally {
      cleanup();
    }
  });

  test("rejects empty redirect_uris with invalid_redirect_uri", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: [] }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_redirect_uri");
    } finally {
      cleanup();
    }
  });

  test("rejects javascript: redirect_uri", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_redirect_uri");
    } finally {
      cleanup();
    }
  });

  test("rejects non-JSON body", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: "not json",
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });
});

// closes #74 — DCR is now operator-gated. Self-served registrations land as
// pending and cannot OAuth; operator-bearer (hub:admin) registrations land
// as approved and can OAuth immediately. This block covers all four exposed
// gates plus the bearer paths in /oauth/register.
describe("DCR approval gate (#74)", () => {
  async function buildAuthorizeRequest(
    db: Awaited<ReturnType<typeof makeDb>>["db"],
    clientId: string,
  ) {
    const { challenge } = makePkce();
    return new Request(
      authorizeUrl({
        client_id: clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "vault:read",
      }),
    );
  }

  test("authorize: pending client → 403 HTML 'App not yet approved'", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const res = handleAuthorizeGet(db, await buildAuthorizeRequest(db, reg.client.clientId), {
        issuer: ISSUER,
      });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("App not yet approved");
      expect(html).toContain("approve-client");
    } finally {
      cleanup();
    }
  });

  test("authorize: approved client passes the gate (renders login)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
      });
      const res = handleAuthorizeGet(db, await buildAuthorizeRequest(db, reg.client.clientId), {
        issuer: ISSUER,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Sign in");
    } finally {
      cleanup();
    }
  });

  test("token: pending client → 401 invalid_client", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: "any",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        code_verifier: "any",
      });
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: form,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_client");
      expect(body.error_description).toContain("not been approved");
      // Surface the inline-approval affordances so consumers (Notes, future
      // cross-origin SPAs) can deep-link the operator to a browser-based
      // approve flow without dropping to a terminal.
      expect(body.approve_url).toBe(
        `${ISSUER}/admin/approve-client/${encodeURIComponent(reg.client.clientId)}`,
      );
      expect(body.cli_alternative).toBe(`parachute auth approve-client ${reg.client.clientId}`);
    } finally {
      cleanup();
    }
  });

  test("token (refresh): pending client → 401 invalid_client", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "any",
        client_id: reg.client.clientId,
      });
      const res = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: form,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_client");
      // Same pending-affordance shape on the refresh path: a long-lived
      // OAuth client whose row was unapproved between issuance and refresh
      // hits this branch and surfaces the same approve_url + cli_alternative.
      expect(body.approve_url).toBe(
        `${ISSUER}/admin/approve-client/${encodeURIComponent(reg.client.clientId)}`,
      );
      expect(body.cli_alternative).toBe(`parachute auth approve-client ${reg.client.clientId}`);
    } finally {
      cleanup();
    }
  });

  test("register: no Authorization header → status pending (public DCR path)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("register: operator-bearer with hub:admin → status approved", async () => {
    // First-party install path. Modules running `parachute install <name>`
    // present the hub's operator.token; the bearer carries hub:admin so the
    // self-registration lands as approved without a human follow-up.
    const { db, cleanup } = await makeDb();
    try {
      const { rotateSigningKey } = await import("../signing-keys.ts");
      const { mintOperatorToken } = await import("../operator-token.ts");
      rotateSigningKey(db);
      const user = await createUser(db, "owner", "pw");
      const operator = await mintOperatorToken(db, user.id, { issuer: ISSUER });

      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${operator.token}`,
        },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("approved");
      // Sanity: the freshly-approved client passes the authorize gate.
      const aRes = handleAuthorizeGet(
        db,
        await buildAuthorizeRequest(db, body.client_id as string),
        { issuer: ISSUER },
      );
      expect(aRes.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("register: bearer without hub:admin → 403 insufficient_scope", async () => {
    // A consumer access token (vault:read) is not an operator credential.
    // The endpoint must reject rather than silently downgrading to pending.
    const { db, cleanup } = await makeDb();
    try {
      const { rotateSigningKey } = await import("../signing-keys.ts");
      const { signAccessToken } = await import("../jwt-sign.ts");
      rotateSigningKey(db);
      const user = await createUser(db, "owner", "pw");
      const consumer = await signAccessToken(db, {
        sub: user.id,
        scopes: ["vault:read"],
        audience: "vault",
        clientId: "some-client",
        issuer: ISSUER,
      });

      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${consumer.token}`,
        },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("insufficient_scope");
    } finally {
      cleanup();
    }
  });

  test("register: malformed bearer → 401 invalid_token", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not-a-jwt",
        },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("invalid_token");
    } finally {
      cleanup();
    }
  });
});

// closes #199 — DCR auto-approve for the operator's own browser. A valid
// `parachute_hub_session` cookie indicates the operator is authenticated as
// themselves; combined with a same-origin Origin/Referer (the CSRF gate)
// that's enough to skip the manual `parachute auth approve-client` step.
describe("DCR auto-approve via session cookie (#199)", () => {
  const SESSION_COOKIE_TTL_S = Math.floor(SESSION_TTL_MS / 1000);

  function registerRequest(
    headers: Record<string, string>,
    bodyExtra: Record<string, unknown> = {},
  ): Request {
    return new Request(`${ISSUER}/oauth/register`, {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["https://app.example/cb"],
        ...bodyExtra,
      }),
      headers: { "content-type": "application/json", ...headers },
    });
  }

  test("valid session cookie + matching Origin → status approved (response + DB)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const req = registerRequest({
        cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
        origin: ISSUER,
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("approved");
      // Persisted, not just response-shaped.
      const row = getClient(db, body.client_id as string);
      expect(row?.status).toBe("approved");
    } finally {
      cleanup();
    }
  });

  test("valid session cookie + cross-origin Origin → status pending (CSRF defense)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const req = registerRequest({
        cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
        origin: "https://attacker.example",
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("valid session cookie + Origin: 'null' (opaque/sandbox iframe) → pending", async () => {
    // Sandbox iframes (`<iframe sandbox>` without `allow-same-origin`),
    // `data:`/`file:` documents, and some privacy contexts send the literal
    // string `Origin: null` rather than omitting the header. `new URL("null")`
    // throws → isSameOriginRequest's try/catch returns false → DCR stays
    // pending. This test pins that invariant: an opaque-origin caller does
    // NOT ride the cookie path even with a valid session, because we can't
    // prove the request came from the issuer's own origin.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const req = registerRequest({
        cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
        origin: "null",
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
      // Persisted, not just response-shaped.
      const row = getClient(db, body.client_id as string);
      expect(row?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("valid session cookie + Origin matching exact origin (port included) → approved", async () => {
    // URL.origin includes scheme + host + port, so a port-mismatched Origin
    // must NOT match. https://hub.example:8443 ≠ https://hub.example.
    const { db, cleanup } = await makeDb();
    try {
      const issuer = "https://hub.example:8443";
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });

      // Exact match (scheme + host + port) → approved.
      const okReq = registerRequest({
        cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
        origin: "https://hub.example:8443",
      });
      const okRes = await handleRegister(db, okReq, { issuer });
      expect(((await okRes.json()) as Record<string, unknown>).status).toBe("approved");

      // Port-mismatched Origin (default 443 vs 8443) → pending.
      const badReq = registerRequest({
        cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
        origin: "https://hub.example",
      });
      const badRes = await handleRegister(db, badReq, { issuer });
      expect(((await badRes.json()) as Record<string, unknown>).status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("valid session cookie + matching Referer (no Origin) → approved (Referer fallback)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const req = registerRequest({
        cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
        referer: `${ISSUER}/notes/`,
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("approved");
    } finally {
      cleanup();
    }
  });

  test("valid session cookie + no Origin AND no Referer → pending (deny without proof of origin)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const req = registerRequest({
        cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("expired session cookie + matching Origin → pending (expiry check)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      // Session created in the "now()" frame, but handleRegister sees a much
      // later clock — findSession (via findActiveSession) treats it as expired.
      const session = createSession(db, { userId: user.id });
      const future = new Date(Date.now() + SESSION_TTL_MS + 60_000);
      const req = registerRequest({
        cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
        origin: ISSUER,
      });
      const res = await handleRegister(db, req, { issuer: ISSUER, now: () => future });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("invalid session cookie (id not in DB) + matching Origin → pending", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = registerRequest({
        cookie: buildSessionCookie("not-a-real-session-id", SESSION_COOKIE_TTL_S),
        origin: ISSUER,
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("no cookie at all → pending (current public-DCR behavior)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const req = registerRequest({ origin: ISSUER });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("operator-bearer header (existing path) still → approved (regression)", async () => {
    // The new cookie-based path must not regress the bearer-based path that
    // first-party install (#74) depends on. Same setup as the #74 test, no
    // cookie supplied — bearer alone must continue to land approved.
    const { db, cleanup } = await makeDb();
    try {
      const { rotateSigningKey } = await import("../signing-keys.ts");
      const { mintOperatorToken } = await import("../operator-token.ts");
      rotateSigningKey(db);
      const user = await createUser(db, "owner", "pw");
      const operator = await mintOperatorToken(db, user.id, { issuer: ISSUER });

      const req = registerRequest({ authorization: `Bearer ${operator.token}` });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("approved");
    } finally {
      cleanup();
    }
  });
});

// closes #73 — RFC 6749 §6 refresh-token rotation, RFC 6819 §5.2.2.3 replay
// detection (family-wide revocation), RFC 7009 token revocation.
describe("refresh-token rotation + /oauth/revoke (#73)", () => {
  async function consentAndGetCode(
    db: Awaited<ReturnType<typeof makeDb>>["db"],
    clientId: string,
    sessionId: string,
    scope = "vault:default:read",
  ): Promise<{ code: string; verifier: string }> {
    const { verifier, challenge } = makePkce();
    const consentForm = new URLSearchParams({
      __action: "consent",
      __csrf: TEST_CSRF,
      approve: "yes",
      client_id: clientId,
      redirect_uri: "https://app.example/cb",
      response_type: "code",
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const consentRes = await handleAuthorizePost(
      db,
      new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(sessionId, 86400)}`,
        },
      }),
      { issuer: ISSUER },
    );
    const code = new URL(consentRes.headers.get("location") ?? "").searchParams.get("code");
    return { code: code ?? "", verifier };
  }

  function tokenRequest(form: URLSearchParams): Request {
    return new Request(`${ISSUER}/oauth/token`, {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  function revokeRequest(form: URLSearchParams): Request {
    return new Request(`${ISSUER}/oauth/revoke`, {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
  }

  async function mintInitialPair(
    db: Awaited<ReturnType<typeof makeDb>>["db"],
    clientId: string,
    userId: string,
    sessionId: string,
    extra: Record<string, string> = {},
  ): Promise<{ access_token: string; refresh_token: string }> {
    const { code, verifier } = await consentAndGetCode(db, clientId, sessionId);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: "https://app.example/cb",
      code_verifier: verifier,
      ...extra,
    });
    const res = await handleToken(db, tokenRequest(form), {
      issuer: ISSUER,
      loadServicesManifest: fixtureLoadServicesManifest,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { access_token: string; refresh_token: string };
  }

  function familyIdFor(
    db: Awaited<ReturnType<typeof makeDb>>["db"],
    refreshTokenPlaintext: string,
  ): string {
    const hash = createHash("sha256").update(refreshTokenPlaintext).digest("hex");
    const row = db
      .query<{ family_id: string }, [string]>(
        "SELECT family_id FROM tokens WHERE refresh_token_hash = ?",
      )
      .get(hash);
    if (!row) throw new Error("no row for refresh token");
    return row.family_id;
  }

  test("initial auth-code issuance assigns a fresh family_id", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const initial = await mintInitialPair(db, reg.client.clientId, user.id, session.id);
      const family = familyIdFor(db, initial.refresh_token);
      // Fresh UUID, not jti — backfill case is for legacy rows only.
      expect(family).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    } finally {
      cleanup();
    }
  });

  test("rotation preserves family_id across the chain", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const initial = await mintInitialPair(db, reg.client.clientId, user.id, session.id);
      const family = familyIdFor(db, initial.refresh_token);

      const refreshForm = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initial.refresh_token,
        client_id: reg.client.clientId,
      });
      const refreshRes = await handleToken(db, tokenRequest(refreshForm), {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(refreshRes.status).toBe(200);
      const rotated = (await refreshRes.json()) as { refresh_token: string };
      expect(rotated.refresh_token).not.toBe(initial.refresh_token);

      const rotatedFamily = familyIdFor(db, rotated.refresh_token);
      expect(rotatedFamily).toBe(family);
    } finally {
      cleanup();
    }
  });

  test("replay of revoked refresh token revokes the entire family", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const initial = await mintInitialPair(db, reg.client.clientId, user.id, session.id);
      const family = familyIdFor(db, initial.refresh_token);

      // First rotation (legitimate client).
      const r1 = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: initial.refresh_token,
            client_id: reg.client.clientId,
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const rotated1 = (await r1.json()) as { refresh_token: string };

      // Second rotation off the rotated token (still legitimate).
      const r2 = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: rotated1.refresh_token,
            client_id: reg.client.clientId,
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const rotated2 = (await r2.json()) as { refresh_token: string };

      // Replay the ORIGINAL (already revoked at step 1). Should walk the
      // family and revoke every descendant — including rotated2, which was
      // still valid up to this point.
      const replay = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: initial.refresh_token,
            client_id: reg.client.clientId,
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(replay.status).toBe(400);

      // Every row in the family is revoked.
      const live = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM tokens WHERE family_id = ? AND revoked_at IS NULL",
        )
        .get(family);
      expect(live?.n).toBe(0);

      // The currently-live rotated2 token can no longer mint a new pair —
      // its row is now revoked, so the next refresh attempt is a replay too.
      const afterReplay = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: rotated2.refresh_token,
            client_id: reg.client.clientId,
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(afterReplay.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  test("/oauth/revoke refresh_token: revokes the row, second use rejected", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const initial = await mintInitialPair(db, reg.client.clientId, user.id, session.id);

      const revRes = await handleRevoke(
        db,
        revokeRequest(
          new URLSearchParams({
            token: initial.refresh_token,
            token_type_hint: "refresh_token",
            client_id: reg.client.clientId,
          }),
        ),
        { issuer: ISSUER },
      );
      expect(revRes.status).toBe(200);

      // Idempotent — second revoke also 200.
      const revRes2 = await handleRevoke(
        db,
        revokeRequest(
          new URLSearchParams({
            token: initial.refresh_token,
            client_id: reg.client.clientId,
          }),
        ),
        { issuer: ISSUER },
      );
      expect(revRes2.status).toBe(200);

      // The revoked refresh token cannot mint a new access token.
      const refreshAttempt = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: initial.refresh_token,
            client_id: reg.client.clientId,
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(refreshAttempt.status).toBe(400);
      const err = (await refreshAttempt.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_grant");
    } finally {
      cleanup();
    }
  });

  test("/oauth/revoke access_token: validateAccessToken rejects after revoke", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const initial = await mintInitialPair(db, reg.client.clientId, user.id, session.id);

      // Pre-revoke: token validates.
      const preCheck = await validateAccessToken(db, initial.access_token, ISSUER);
      expect(preCheck.payload.sub).toBe(user.id);

      const revRes = await handleRevoke(
        db,
        revokeRequest(
          new URLSearchParams({
            token: initial.access_token,
            token_type_hint: "access_token",
            client_id: reg.client.clientId,
          }),
        ),
        { issuer: ISSUER },
      );
      expect(revRes.status).toBe(200);

      // Post-revoke: token is rejected — signature still verifies, but the
      // jti's tokens row is marked revoked.
      await expect(validateAccessToken(db, initial.access_token, ISSUER)).rejects.toThrow(
        /revoked/,
      );
    } finally {
      cleanup();
    }
  });

  test("/oauth/revoke unknown token returns 200 (no existence disclosure)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const res = await handleRevoke(
        db,
        revokeRequest(
          new URLSearchParams({
            token: "totally-not-a-real-token",
            client_id: reg.client.clientId,
          }),
        ),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("/oauth/revoke missing token returns 400", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const res = await handleRevoke(
        db,
        revokeRequest(new URLSearchParams({ client_id: reg.client.clientId })),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_request");
    } finally {
      cleanup();
    }
  });

  test("/oauth/revoke missing client_id returns 400", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const res = await handleRevoke(
        db,
        revokeRequest(new URLSearchParams({ token: "anything" })),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(400);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_request");
    } finally {
      cleanup();
    }
  });

  test("/oauth/revoke confidential client without secret → 401", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const initial = await mintInitialPair(db, reg.client.clientId, user.id, session.id, {
        client_secret: reg.clientSecret ?? "",
      });

      const res = await handleRevoke(
        db,
        revokeRequest(
          new URLSearchParams({
            token: initial.refresh_token,
            client_id: reg.client.clientId,
            // no client_secret
          }),
        ),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(401);
      const err = (await res.json()) as Record<string, unknown>;
      expect(err.error).toBe("invalid_client");
    } finally {
      cleanup();
    }
  });

  test("/oauth/revoke confidential client with correct secret → 200", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        confidential: true,
      });
      const initial = await mintInitialPair(db, reg.client.clientId, user.id, session.id, {
        client_secret: reg.clientSecret ?? "",
      });

      const res = await handleRevoke(
        db,
        revokeRequest(
          new URLSearchParams({
            token: initial.refresh_token,
            client_id: reg.client.clientId,
            client_secret: reg.clientSecret ?? "",
          }),
        ),
        { issuer: ISSUER },
      );
      expect(res.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("/oauth/revoke from a different client: 200 but row stays live", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const issuingClient = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const otherClient = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const initial = await mintInitialPair(db, issuingClient.client.clientId, user.id, session.id);

      const res = await handleRevoke(
        db,
        revokeRequest(
          new URLSearchParams({
            token: initial.refresh_token,
            client_id: otherClient.client.clientId,
          }),
        ),
        { issuer: ISSUER },
      );
      // Spec-compliant 200, but the row should still be unrevoked.
      expect(res.status).toBe(200);

      const hash = createHash("sha256").update(initial.refresh_token).digest("hex");
      const row = db
        .query<{ revoked_at: string | null }, [string]>(
          "SELECT revoked_at FROM tokens WHERE refresh_token_hash = ?",
        )
        .get(hash);
      expect(row?.revoked_at).toBeNull();

      // The original client can still rotate it.
      const refreshRes = await handleToken(
        db,
        tokenRequest(
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: initial.refresh_token,
            client_id: issuingClient.client.clientId,
          }),
        ),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(refreshRes.status).toBe(200);
    } finally {
      cleanup();
    }
  });

  test("authorizationServerMetadata advertises revocation_endpoint", async () => {
    const res = authorizationServerMetadata({ issuer: ISSUER });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
  });
});

// closes #75 — once the user has approved a scope-set for a client, the next
// /oauth/authorize for the same client and a covered scope-set goes straight
// to the auth-code redirect. Strict superset (incremental scope) and
// revoked grants still show consent.
describe("handleAuthorizeGet — skip consent when scope already granted (#75)", () => {
  test("first approval records grant; second flow with same scopes skips consent", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();

      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:default:read scribe:transcribe",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const consentReq = new Request(`${ISSUER}/oauth/authorize`, {
        method: "POST",
        body: consentForm,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
        },
      });
      const consentRes = await handleAuthorizePost(db, consentReq, { issuer: ISSUER });
      expect(consentRes.status).toBe(302);

      // Second flow, same scopes — skip consent.
      const getReq = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read scribe:transcribe",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "second",
        }),
        { headers: { cookie: buildSessionCookie(session.id, 86400) } },
      );
      const getRes = handleAuthorizeGet(db, getReq, { issuer: ISSUER });
      expect(getRes.status).toBe(302);
      const loc = new URL(getRes.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("code")?.length).toBeGreaterThan(20);
      expect(loc.searchParams.get("state")).toBe("second");
    } finally {
      cleanup();
    }
  });

  test("skip-consent emits an audit log line with client_id, user_id, and scopes (#120)", async () => {
    const { db, cleanup } = await makeDb();
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const { recordGrant } = await import("../grants.ts");
      recordGrant(db, user.id, reg.client.clientId, ["vault:default:read", "scribe:transcribe"]);

      const getReq = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read scribe:transcribe",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "skip",
        }),
        { headers: { cookie: buildSessionCookie(session.id, 86400) } },
      );
      const getRes = handleAuthorizeGet(db, getReq, { issuer: ISSUER });
      expect(getRes.status).toBe(302);

      const skip = lines.find((l) => l.startsWith("consent skipped:"));
      expect(skip).toBeDefined();
      expect(skip).toContain(`client_id=${reg.client.clientId}`);
      expect(skip).toContain(`user_id=${user.id}`);
      expect(skip).toContain("scopes=vault:default:read scribe:transcribe");
    } finally {
      console.log = originalLog;
      cleanup();
    }
  });

  test("subset of granted scopes also skips consent", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();

      // Grant [a, b, c].
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        scope: "vault:default:read vault:default:write scribe:transcribe",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: consentForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER },
      );

      // Re-flow with strict subset [a, c] — must skip.
      const getReq = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read scribe:transcribe",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, 86400) } },
      );
      const getRes = handleAuthorizeGet(db, getReq, { issuer: ISSUER });
      expect(getRes.status).toBe(302);
      const loc = new URL(getRes.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("code")?.length).toBeGreaterThan(20);
    } finally {
      cleanup();
    }
  });

  test("strict superset shows consent (incremental scope grant)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();

      // Grant [vault:default:read].
      await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: new URLSearchParams({
            __action: "consent",
            __csrf: TEST_CSRF,
            approve: "yes",
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            response_type: "code",
            scope: "vault:default:read",
            code_challenge: challenge,
            code_challenge_method: "S256",
          }),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER },
      );

      // Re-flow asking for [vault:default:read, scribe:transcribe] — superset
      // → must render consent (200 HTML), not redirect with code.
      const getReq = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read scribe:transcribe",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, 86400) } },
      );
      const getRes = handleAuthorizeGet(db, getReq, { issuer: ISSUER });
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toContain("text/html");
      const body = await getRes.text();
      // Both scopes appear on the consent page so the user knows they're
      // approving the new addition explicitly.
      expect(body).toContain("scribe:transcribe");
    } finally {
      cleanup();
    }
  });

  test("revoke-grant brings consent back", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();

      // Grant + verify skip works.
      await handleAuthorizePost(
        db,
        new Request(`${ISSUER}/oauth/authorize`, {
          method: "POST",
          body: new URLSearchParams({
            __action: "consent",
            __csrf: TEST_CSRF,
            approve: "yes",
            client_id: reg.client.clientId,
            redirect_uri: "https://app.example/cb",
            response_type: "code",
            scope: "vault:default:read",
            code_challenge: challenge,
            code_challenge_method: "S256",
          }),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER },
      );

      // Revoke via the grants module directly (CLI runner is exercised in
      // auth.test.ts; here we just need the row gone).
      const { revokeGrant } = await import("../grants.ts");
      const removed = revokeGrant(db, user.id, reg.client.clientId);
      expect(removed).toBe(true);

      // Now the same flow should render consent, not redirect.
      const getReq = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, 86400) } },
      );
      const getRes = handleAuthorizeGet(db, getReq, { issuer: ISSUER });
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toContain("text/html");
    } finally {
      cleanup();
    }
  });

  test("unnamed vault scope always renders consent (picker required)", async () => {
    // Even if we somehow stored a grant matching an unnamed `vault:read`,
    // the picker is the only way to bind the scope to a specific vault.
    // The skip-consent path must defer to consent for unnamed vault verbs.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      // Pre-seed a grant with an unnamed scope — defensive, just in case.
      const { recordGrant } = await import("../grants.ts");
      recordGrant(db, user.id, reg.client.clientId, ["vault:read"]);

      const getReq = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, 86400) } },
      );
      const getRes = handleAuthorizeGet(db, getReq, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toContain("text/html");
    } finally {
      cleanup();
    }
  });

  test("re-registered client_id (different uuid) requires fresh consent", async () => {
    // Re-registration mints a new client_id; the grant row is keyed on
    // (user, client_id), so the new client has no prior grant. Consent
    // must show.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const oldReg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();

      // Grant for the old client.
      const { recordGrant } = await import("../grants.ts");
      recordGrant(db, user.id, oldReg.client.clientId, ["vault:default:read"]);

      // Re-register — fresh client_id.
      const newReg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      expect(newReg.client.clientId).not.toBe(oldReg.client.clientId);

      const getReq = new Request(
        authorizeUrl({
          client_id: newReg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, 86400) } },
      );
      const getRes = handleAuthorizeGet(db, getReq, { issuer: ISSUER });
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toContain("text/html");
    } finally {
      cleanup();
    }
  });

  test("consent submit unions new scopes into existing grant", async () => {
    // Direct check on the storage shape: grant [a, b], later approve [a, c],
    // the row should hold {a, b, c} so a future flow asking [b] still skips.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();

      const submit = (scope: string) =>
        handleAuthorizePost(
          db,
          new Request(`${ISSUER}/oauth/authorize`, {
            method: "POST",
            body: new URLSearchParams({
              __action: "consent",
              __csrf: TEST_CSRF,
              approve: "yes",
              client_id: reg.client.clientId,
              redirect_uri: "https://app.example/cb",
              response_type: "code",
              scope,
              code_challenge: challenge,
              code_challenge_method: "S256",
            }),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
            },
          }),
          { issuer: ISSUER },
        );

      await submit("vault:default:read vault:default:write");
      await submit("vault:default:read scribe:transcribe");

      const { findGrant } = await import("../grants.ts");
      const grant = findGrant(db, user.id, reg.client.clientId);
      expect(grant).not.toBeNull();
      expect(new Set(grant?.scopes)).toEqual(
        new Set(["vault:default:read", "vault:default:write", "scribe:transcribe"]),
      );
    } finally {
      cleanup();
    }
  });
});

// closes #208 — inline "Approve this app" form on the pending-client page
// (cross-origin SPA recovery). Same security model as #199/#200 DCR
// auto-approve: valid session + matching Origin = trusted operator. The
// CSRF token is the third belt — a cross-origin POST with a leaked session
// cookie still fails because the rendered token won't match.
describe("inline approve button on pending /oauth/authorize (#208)", () => {
  const SESSION_COOKIE_TTL_S = Math.floor(SESSION_TTL_MS / 1000);

  function pendingAuthorizeUrl(clientId: string): string {
    const { challenge } = makePkce();
    return authorizeUrl({
      client_id: clientId,
      redirect_uri: "https://app.example/cb",
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "vault:read",
      state: "rt-208",
    });
  }

  test("session absent → page renders WITHOUT approve form (CLI-only fallback)", async () => {
    // Regression: pre-#208 behavior preserved when no session cookie is
    // present. The CLI-fallback message must still be visible so an operator
    // who arrived from a fresh browser knows what to do.
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "MyApp",
        status: "pending",
      });
      const req = new Request(pendingAuthorizeUrl(reg.client.clientId));
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("App not yet approved");
      // CLI-fallback message present — the only way to recover without a session.
      expect(html).toContain("approve-client");
      // No form element pointing at the approve endpoint.
      expect(html).not.toContain('action="/oauth/authorize/approve"');
    } finally {
      cleanup();
    }
  });

  test("session valid + matching Origin → page renders WITH approve form + CSRF token", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "MyApp",
        status: "pending",
      });
      const req = new Request(pendingAuthorizeUrl(reg.client.clientId), {
        headers: {
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
          origin: ISSUER,
        },
      });
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("App not yet approved");
      // The form posts to the approve endpoint
      expect(html).toContain('action="/oauth/authorize/approve"');
      expect(html).toContain('name="client_id"');
      expect(html).toContain(`value="${reg.client.clientId}"`);
      // CSRF token present in the form
      expect(html).toContain(`value="${TEST_CSRF}"`);
      // return_to carries the original authorize URL so the post-approve
      // redirect lands the operator back on the same flow.
      expect(html).toContain('name="return_to"');
      expect(html).toContain("/oauth/authorize?");
      expect(html).toContain("rt-208"); // state echoed via return_to URL
      // Display fields present so operator can verify what they're approving.
      expect(html).toContain("MyApp");
      expect(html).toContain(reg.client.clientId);
      expect(html).toContain("https://app.example/cb");
      // CLI fallback still visible.
      expect(html).toContain("approve-client");
    } finally {
      cleanup();
    }
  });

  test("approve POST happy path: CSRF + session + matching Origin → DB flips approved + 302 to authorize URL", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const returnTo = `/oauth/authorize?client_id=${reg.client.clientId}&state=rt-208`;
      const form = new URLSearchParams({
        __csrf: TEST_CSRF,
        client_id: reg.client.clientId,
        return_to: returnTo,
      });
      const req = new Request(`${ISSUER}/oauth/authorize/approve`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
          origin: ISSUER,
        },
      });
      const res = await handleApproveClientPost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(returnTo);
      // DB row flipped, not just response-shaped.
      const row = getClient(db, reg.client.clientId);
      expect(row?.status).toBe("approved");
    } finally {
      cleanup();
    }
  });

  test("approve POST: invalid CSRF → 403", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const form = new URLSearchParams({
        __csrf: "wrong-token",
        client_id: reg.client.clientId,
        return_to: `/oauth/authorize?client_id=${reg.client.clientId}`,
      });
      const req = new Request(`${ISSUER}/oauth/authorize/approve`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
          origin: ISSUER,
        },
      });
      const res = await handleApproveClientPost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(403);
      // Row stays pending.
      const row = getClient(db, reg.client.clientId);
      expect(row?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("approve POST: no session cookie → 401", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const form = new URLSearchParams({
        __csrf: TEST_CSRF,
        client_id: reg.client.clientId,
        return_to: `/oauth/authorize?client_id=${reg.client.clientId}`,
      });
      const req = new Request(`${ISSUER}/oauth/authorize/approve`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: CSRF_COOKIE,
          origin: ISSUER,
        },
      });
      const res = await handleApproveClientPost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(401);
      // Row stays pending.
      const row = getClient(db, reg.client.clientId);
      expect(row?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("approve POST: cross-origin Origin → 403 (CSRF defense)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const form = new URLSearchParams({
        __csrf: TEST_CSRF,
        client_id: reg.client.clientId,
        return_to: `/oauth/authorize?client_id=${reg.client.clientId}`,
      });
      const req = new Request(`${ISSUER}/oauth/authorize/approve`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
          origin: "https://attacker.example",
        },
      });
      const res = await handleApproveClientPost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(403);
      // Row stays pending.
      const row = getClient(db, reg.client.clientId);
      expect(row?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("approve POST: Origin: 'null' (sandbox iframe / opaque origin) → 403", async () => {
    // Opaque-origin contexts (sandboxed iframes, some `data:` and `file:`
    // pages) send the literal string "null" as the Origin header. The DCR
    // /register path covers this; the inline-approve endpoint must reject it
    // too. isSameOriginRequest() handles this correctly because new URL("null")
    // throws → returns false; this test pins that contract.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const form = new URLSearchParams({
        __csrf: TEST_CSRF,
        client_id: reg.client.clientId,
        return_to: `/oauth/authorize?client_id=${reg.client.clientId}`,
      });
      const req = new Request(`${ISSUER}/oauth/authorize/approve`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
          origin: "null",
        },
      });
      const res = await handleApproveClientPost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(403);
      // Row stays pending.
      const row = getClient(db, reg.client.clientId);
      expect(row?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("approve POST: idempotent on already-approved client (double-click / refresh)", async () => {
    // approveClient() short-circuits if the row is already approved
    // (clients.ts:153). A double-click or page refresh should not error —
    // the second POST also succeeds with a 302 to return_to and the row
    // stays approved. This pins idempotency end-to-end.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const returnTo = `/oauth/authorize?client_id=${reg.client.clientId}&state=rt-208`;
      const buildReq = () => {
        const form = new URLSearchParams({
          __csrf: TEST_CSRF,
          client_id: reg.client.clientId,
          return_to: returnTo,
        });
        return new Request(`${ISSUER}/oauth/authorize/approve`, {
          method: "POST",
          body: form,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
            origin: ISSUER,
          },
        });
      };

      // First POST: pending → approved.
      const first = await handleApproveClientPost(db, buildReq(), { issuer: ISSUER });
      expect(first.status).toBe(302);
      expect(first.headers.get("location")).toBe(returnTo);
      expect(getClient(db, reg.client.clientId)?.status).toBe("approved");

      // Second POST (same client_id, same form): also succeeds, no error.
      const second = await handleApproveClientPost(db, buildReq(), { issuer: ISSUER });
      expect(second.status).toBe(302);
      expect(second.headers.get("location")).toBe(returnTo);
      expect(getClient(db, reg.client.clientId)?.status).toBe("approved");
    } finally {
      cleanup();
    }
  });

  test("approve POST: unknown client_id → 404", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const form = new URLSearchParams({
        __csrf: TEST_CSRF,
        client_id: "no-such-client-id",
        return_to: "/oauth/authorize?client_id=no-such-client-id",
      });
      const req = new Request(`${ISSUER}/oauth/authorize/approve`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
          origin: ISSUER,
        },
      });
      const res = await handleApproveClientPost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(404);
    } finally {
      cleanup();
    }
  });

  test("approve POST: malicious return_to (absolute URL) → 400 (open-redirect defense)", async () => {
    // The form must always supply a hub-relative /oauth/authorize?... URL.
    // Anything else is either an open-redirect attempt or a misuse — refuse
    // to follow it. return_to is validated BEFORE the DB mutation, so a bad
    // value also leaves the client row at status=pending.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const form = new URLSearchParams({
        __csrf: TEST_CSRF,
        client_id: reg.client.clientId,
        return_to: "https://evil.example/steal",
      });
      const req = new Request(`${ISSUER}/oauth/authorize/approve`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
          origin: ISSUER,
        },
      });
      const res = await handleApproveClientPost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      // No redirect to evil.example.
      expect(res.headers.get("location")).toBeNull();
      // DB row remains pending — validate-before-mutate ordering.
      const row = getClient(db, reg.client.clientId);
      expect(row?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("approve POST: scheme-relative return_to (//evil.example) → 400", async () => {
    // `//evil.example/foo` is a scheme-relative URL — browsers resolve it
    // against the current scheme to land at https://evil.example/foo.
    // Reject anything that doesn't start with a single `/`.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const form = new URLSearchParams({
        __csrf: TEST_CSRF,
        client_id: reg.client.clientId,
        return_to: "//evil.example/foo",
      });
      const req = new Request(`${ISSUER}/oauth/authorize/approve`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
          origin: ISSUER,
        },
      });
      const res = await handleApproveClientPost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      // DB row remains pending — validate-before-mutate ordering.
      const row = getClient(db, reg.client.clientId);
      expect(row?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("approve POST: return_to off /oauth/authorize path (e.g. /admin/config) → 400", async () => {
    // Even hub-relative paths must target the authorize endpoint. A
    // hand-crafted form trying to redirect to /admin/config or any other
    // hub surface is misuse — this endpoint exists to re-enter the OAuth
    // flow, nothing else.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const form = new URLSearchParams({
        __csrf: TEST_CSRF,
        client_id: reg.client.clientId,
        return_to: "/admin/config",
      });
      const req = new Request(`${ISSUER}/oauth/authorize/approve`, {
        method: "POST",
        body: form,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`,
          origin: ISSUER,
        },
      });
      const res = await handleApproveClientPost(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      // DB row remains pending — validate-before-mutate ordering.
      const row = getClient(db, reg.client.clientId);
      expect(row?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("end-to-end: GET (pending) → POST approve → GET (now approved) renders consent", async () => {
    // The full redirect chain. Sessions and CSRF carry across all three
    // requests in the same cookie. The final GET sees status=approved and
    // renders the consent screen.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "RoundTrip",
        status: "pending",
      });
      const cookie = `${CSRF_COOKIE}; ${buildSessionCookie(session.id, SESSION_COOKIE_TTL_S)}`;
      const authorizeHref = pendingAuthorizeUrl(reg.client.clientId);

      // Step 1: GET /oauth/authorize on a pending client renders the approve form.
      const getRes = handleAuthorizeGet(
        db,
        new Request(authorizeHref, { headers: { cookie, origin: ISSUER } }),
        { issuer: ISSUER },
      );
      expect(getRes.status).toBe(403);
      const getHtml = await getRes.text();
      expect(getHtml).toContain('action="/oauth/authorize/approve"');

      // Pull the return_to value the form would submit. It's the path+search
      // of the authorize URL.
      const authorizeUrlParsed = new URL(authorizeHref);
      const returnTo = `${authorizeUrlParsed.pathname}${authorizeUrlParsed.search}`;

      // Step 2: POST the approve form.
      const postForm = new URLSearchParams({
        __csrf: TEST_CSRF,
        client_id: reg.client.clientId,
        return_to: returnTo,
      });
      const postRes = await handleApproveClientPost(
        db,
        new Request(`${ISSUER}/oauth/authorize/approve`, {
          method: "POST",
          body: postForm,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie,
            origin: ISSUER,
          },
        }),
        { issuer: ISSUER },
      );
      expect(postRes.status).toBe(302);
      expect(postRes.headers.get("location")).toBe(returnTo);

      // Step 3: GET /oauth/authorize again — now the client is approved, so
      // the operator lands on the consent screen.
      const reentryRes = handleAuthorizeGet(
        db,
        new Request(authorizeHref, { headers: { cookie, origin: ISSUER } }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(reentryRes.status).toBe(200);
      const consentHtml = await reentryRes.text();
      // Consent screen markers (renderConsent uses these).
      expect(consentHtml).toContain('name="__action" value="consent"');
      expect(consentHtml).toContain("Authorize");
      expect(consentHtml).toContain("RoundTrip");
    } finally {
      cleanup();
    }
  });
});
