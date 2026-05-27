import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getClient, registerClient } from "../clients.ts";
import { CSRF_COOKIE_NAME } from "../csrf.ts";
import { findGrant, recordGrant } from "../grants.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS,
  getSetting,
  openFirstClientAutoApproveWindow,
  setSetting,
} from "../hub-settings.ts";
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
  protectedResourceMetadata,
  vaultScopeForUser,
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

describe("protectedResourceMetadata (RFC 9728, closes hub#393)", () => {
  test("emits the required RFC 9728 fields rooted at the issuer", async () => {
    const res = protectedResourceMetadata({ issuer: ISSUER });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBe(ISSUER);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    expect(Array.isArray(body.scopes_supported)).toBe(true);
    expect(body.resource_documentation).toMatch(/parachute\.computer/);
  });

  test("scopes_supported mirrors authorizationServerMetadata after the same operator-only filter", async () => {
    // Same declared-scope set as the authorizationServerMetadata test; the
    // resource-server view should advertise the same shape.
    const declared = new Set<string>([
      "vault:read",
      "vault:admin",
      "hub:admin",
      "parachute:host:admin",
      "agent:read",
    ]);
    const res = protectedResourceMetadata({
      issuer: ISSUER,
      loadDeclaredScopes: () => declared,
    });
    const body = (await res.json()) as Record<string, unknown>;
    const scopes = body.scopes_supported as string[];
    expect(scopes).toContain("vault:read");
    expect(scopes).toContain("agent:read");
    expect(scopes).not.toContain("parachute:host:admin");
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
      // Page h1: "Approve <client>?" per design-system.md §5 verb canon
      // (Workstream I, 2026-05-25 — was "Authorize <client>?").
      expect(html).toContain("Approve");
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
      const body = await res.text();
      expect(body).toContain("Unknown application");
      // Cross-origin redirect_uri → no recovery affordance. The page must
      // not include the inline JS reset block; we can't safely interact
      // with a third-party SPA's storage from this page.
      expect(body).not.toContain("unknown-client-reset");
      expect(body).not.toContain("lens:dcr:");
    } finally {
      cleanup();
    }
  });

  test("unknown client_id with self-origin redirect_uri renders recovery affordance (hub#fresh-machine-connect)", async () => {
    // The canonical fresh-machine-stale-localStorage repro: notes' SPA
    // is mounted at the hub's own origin, holds a cached client_id from
    // a previous hub.db, and lands on /oauth/authorize with the dangling
    // id. Hub recognizes the redirect_uri as one of its bound origins and
    // surfaces a one-click recovery: the inline JS clears the SPA's DCR
    // localStorage cache (any `lens:dcr:*` key) and navigates to the
    // redirect_uri's pathname for a fresh DCR pass.
    const { db, cleanup } = await makeDb();
    try {
      const { challenge } = makePkce();
      const selfRedirect = `${ISSUER}/notes/oauth/callback`;
      const req = new Request(
        authorizeUrl({
          client_id: "stale-dangling-id",
          redirect_uri: selfRedirect,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        hubBoundOrigins: () => [ISSUER],
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Unknown application");
      expect(body).toContain("stale-dangling-id");
      // Recovery affordance is present.
      expect(body).toContain("unknown-client-reset");
      // The reset target is the redirect_uri's pathname only (not the
      // full URL — we never surface a cross-origin redirect even when
      // redirect_uri claims to be ours).
      expect(body).toContain('data-target="/notes/oauth/callback"');
      // The inline JS clears the SPA's known DCR cache prefix.
      expect(body).toContain("lens:dcr:");
    } finally {
      cleanup();
    }
  });

  test("unknown client_id with redirect_uri on unbound origin falls back to static error", async () => {
    // hubBoundOrigins lists only the canonical hub origin; a redirect_uri
    // pointing somewhere else (third-party SPA, attacker probe) MUST NOT
    // surface the recovery JS — that JS only makes sense for SPAs we
    // ourselves host.
    const { db, cleanup } = await makeDb();
    try {
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: "stale-id",
          redirect_uri: "https://attacker.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        hubBoundOrigins: () => [ISSUER],
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Unknown application");
      expect(body).not.toContain("unknown-client-reset");
      expect(body).not.toContain("lens:dcr:");
      expect(body).not.toContain("attacker.example");
    } finally {
      cleanup();
    }
  });

  test("unknown client_id with malformed redirect_uri falls back to static error", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: "stale-id",
          // Validated as non-empty by parseAuthorizeFormParams but not
          // URL-parsed there; the unknown-client renderer must handle
          // its own parsing safely.
          redirect_uri: "not-a-valid-url",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        hubBoundOrigins: () => [ISSUER],
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Unknown application");
      expect(body).not.toContain("unknown-client-reset");
    } finally {
      cleanup();
    }
  });

  test("unknown client_id falls back to static error when hubBoundOrigins is unset", async () => {
    // Pre-#245 callers don't thread hubBoundOrigins; the gate falls back
    // to `[issuer]` so a single-origin hub still surfaces the recovery
    // affordance for its own redirect_uris. Verify that path.
    const { db, cleanup } = await makeDb();
    try {
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: "stale-id",
          redirect_uri: `${ISSUER}/notes/oauth/callback`,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
      );
      // No hubBoundOrigins → falls back to [issuer], which still matches.
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("unknown-client-reset");
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

  test("race-condition branch (client un-approved between GET and POST) — error points at web approval path, no CLI mention", async () => {
    // Defensive branch in handleConsentSubmit: consent only renders for
    // approved clients, but a row can flip back to pending between GET and
    // POST (operator revoke / hand-crafted POST). Pre-rc.19 follow-up the
    // error said "Run `parachute auth approve-client <id>` from a terminal";
    // rc.19 retired every browser-visible CLI mention, so this branch now
    // surfaces the same /admin/approve-client/<id> path the unauth GET-on-
    // pending page advertises.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
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
        state: "race",
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
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("App not yet approved");
      // Web path advertised, with the client_id rendered inline.
      expect(html).toContain(`/admin/approve-client/${reg.client.clientId}`);
      expect(html).toContain("Sign in as admin");
      // CLI mention retired from every browser-visible surface in rc.19.
      expect(html).not.toContain("parachute auth approve-client");
      expect(html).not.toContain("from a terminal");
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

  test("consent POST with unknown client_id + self-origin redirect_uri renders recovery affordance", async () => {
    // Symmetry with the GET-path coverage of the same hub#277 recovery
    // affordance. handleAuthorizePost's consent submit routes the
    // `getClient = null` branch through the same `unknownClientResponse`
    // helper as the GET path; pin it explicitly so a future refactor
    // can't silently drop the recovery path here. Reaching this branch
    // on the consent POST means the client_id was deleted between
    // render and submit (vanishingly rare in practice — exercised here
    // by registering nothing for the carried `client_id`).
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const { challenge } = makePkce();
      const form = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: "stale-dangling-id",
        redirect_uri: `${ISSUER}/notes/oauth/callback`,
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
      const res = await handleAuthorizePost(db, req, {
        issuer: ISSUER,
        hubBoundOrigins: () => [ISSUER],
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain("Unknown application");
      expect(body).toContain("stale-dangling-id");
      // Recovery affordance — same shape as the GET-path tests above.
      expect(body).toContain("unknown-client-reset");
      expect(body).toContain('data-target="/notes/oauth/callback"');
      expect(body).toContain("lens:dcr:");
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
      // /admin/approve-client/<id> deep link is the canonical recovery now
      // (the pre-rc.19 CLI message was retired in favor of the web path).
      expect(html).toContain(`/admin/approve-client/${encodeURIComponent(reg.client.clientId)}`);
      // No vault hint → no vault row in approve-meta. Single-vault hubs +
      // pre-vault-popover clients leave the section omitted (#244).
      expect(html).not.toContain('approve-meta-label">vault');
    } finally {
      cleanup();
    }
  });

  // closes #244 — vault hint surfaced in approve-pending UI. Notes#115
  // passes `vault=<name>` on `/oauth/authorize` for per-vault grants; hub's
  // approve page now displays it alongside the other client metadata so a
  // multi-vault operator can tell which vault they're approving for.
  test("authorize: pending client with vault hint → approve UI renders 'vault: <name>'", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
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
          vault: "boulder",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("App not yet approved");
      // The vault hint surfaces as a labeled row in the approve-meta block.
      expect(html).toContain('approve-meta-label">vault');
      expect(html).toContain("boulder");
    } finally {
      cleanup();
    }
  });

  test("authorize: pending client with empty vault param → no vault row", async () => {
    // Defensive: `vault=` with empty value normalizes to undefined so the
    // UI doesn't render a blank vault label. Easy to hit if a client builds
    // the URL via URLSearchParams.set("vault", someMaybeEmptyVar).
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
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
          vault: "",
        }),
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("App not yet approved");
      expect(html).not.toContain('approve-meta-label">vault');
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
  // hub#236 — pin the full silent-approve flow end-to-end in one test.
  // The per-branch tests below this one cover individual branches (subset,
  // superset, revoke, unnamed-vault, re-registered-client); this test
  // walks the operator-visible state machine in a single body so a
  // regression at any step surfaces immediately, and the JSDoc on
  // handleAuthorizeGet's silent-approve flow (1-5) has a single load-
  // bearing test to point at.
  test("first-use consent → silent-approve → novel-scope re-prompts (full silent-approve flow, #236)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const sessionCookie = buildSessionCookie(session.id, 86400);

      // Step 1: first use — no grant exists; consent screen renders.
      const firstReq = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "step1",
        }),
        { headers: { cookie: sessionCookie } },
      );
      const firstRes = handleAuthorizeGet(db, firstReq, { issuer: ISSUER });
      expect(firstRes.status).toBe(200);
      expect(firstRes.headers.get("content-type")).toContain("text/html");

      // Step 1b: user approves via the consent form — grant gets recorded.
      const consentRes = await handleAuthorizePost(
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
            cookie: `${CSRF_COOKIE}; ${sessionCookie}`,
          },
        }),
        { issuer: ISSUER },
      );
      expect(consentRes.status).toBe(302);

      // Step 2: subsequent use, same scopes — silent-approve fires.
      // Authoritative assertion: 302 redirect with auth code, NOT a 200
      // HTML consent screen. This is the operator-visible payoff.
      const secondReq = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "step2",
        }),
        { headers: { cookie: sessionCookie } },
      );
      const secondRes = handleAuthorizeGet(db, secondReq, { issuer: ISSUER });
      expect(secondRes.status).toBe(302);
      const secondLoc = new URL(secondRes.headers.get("location") ?? "");
      expect(secondLoc.origin + secondLoc.pathname).toBe("https://app.example/cb");
      expect(secondLoc.searchParams.get("code")?.length).toBeGreaterThan(20);
      expect(secondLoc.searchParams.get("state")).toBe("step2");

      // Step 3: subsequent use, novel scope NOT in the grant — gate must
      // NOT fire; consent re-renders with the new scope explicit. This is
      // the load-bearing security property: silent-approve must not
      // silently approve scopes the user never consented to.
      const novelReq = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          // Adds scribe:transcribe to the original vault:default:read.
          scope: "vault:default:read scribe:transcribe",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "step3",
        }),
        { headers: { cookie: sessionCookie } },
      );
      const novelRes = handleAuthorizeGet(db, novelReq, { issuer: ISSUER });
      expect(novelRes.status).toBe(200);
      expect(novelRes.headers.get("content-type")).toContain("text/html");
      const novelBody = await novelRes.text();
      // The new scope appears on the consent page — the user must approve
      // it explicitly.
      expect(novelBody).toContain("scribe:transcribe");
    } finally {
      cleanup();
    }
  });

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

  test("session absent → Sign-in CTA preserves the authorize URL through login + shareable deep link", async () => {
    // Approval-UX rc.19: the unauthenticated viewer sees no CLI hint —
    // the web approval path (#277) is the canonical recovery now. The
    // primary Sign-in CTA wires `/login?next=<authorize URL>` so post-
    // login the operator lands BACK on the same `/oauth/authorize?...`
    // request — now authenticated, they see the inline approve form, one
    // click resumes the OAuth flow through consent → redirect_uri. The
    // shareable secondary deep link still points at the SPA approve page
    // (it's for sharing with another admin, not for the in-flight flow).
    //
    // Pre-fix the Sign-in CTA also pointed at the SPA approve page —
    // approving the client but discarding the authorize URL params, so
    // the calling app (e.g. Claude.ai MCP) was never told and the user
    // looped on retry. Caught by Aaron on the Render deploy.
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        clientName: "MyApp",
        status: "pending",
      });
      const authorizePath = pendingAuthorizeUrl(reg.client.clientId);
      const req = new Request(authorizePath);
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain("App not yet approved");
      // Primary CTA: Sign-in link wired to round-trip the operator back
      // to the original /oauth/authorize?... URL after login (resumes the
      // OAuth flow rather than dead-ending at the SPA approve page).
      expect(html).toContain("Sign in as admin to approve");
      const requestUrl = new URL(authorizePath);
      const returnTo = `${requestUrl.pathname}${requestUrl.search}`;
      const expectedLoginHref = `/login?next=${encodeURIComponent(returnTo)}`;
      expect(html).toContain(`href="${expectedLoginHref}"`);
      // Sanity: the next= target carries the authorize path + the
      // client_id + state so the flow can resume verbatim post-login.
      expect(returnTo).toContain("/oauth/authorize");
      expect(returnTo).toContain(encodeURIComponent(reg.client.clientId));
      expect(returnTo).toContain("state=rt-208");
      // The legacy SPA approve path is NOT what the Sign-in CTA points
      // at any more (regression guard for the fix).
      const legacyHref = `/login?next=${encodeURIComponent(
        `/admin/approve-client/${encodeURIComponent(reg.client.clientId)}`,
      )}`;
      expect(html).not.toContain(`href="${legacyHref}"`);
      // Secondary CTA: shareable, fully-qualified deep link + Copy button
      // — still points at the SPA approve page (no OAuth flow context to
      // preserve for the share-with-another-admin case).
      expect(html).toContain(
        `${ISSUER}/admin/approve-client/${encodeURIComponent(reg.client.clientId)}`,
      );
      expect(html).toContain('id="approve-share-copy"');
      expect(html).toContain("navigator.clipboard");
      // Retired CLI hint must not appear anywhere in the body.
      expect(html).not.toContain("parachute auth approve-client");
      expect(html).not.toContain("from a terminal");
      // No form element pointing at the approve endpoint (un-authed branch).
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
      // Authed branch shows only the one-click Approve form — the unauth
      // Sign-in CTA and shareable-link block do NOT render here.
      expect(html).not.toContain("Sign in as admin to approve");
      expect(html).not.toContain("Or send this link to your hub admin");
      // CLI hint also gone in this branch (approval-UX rc.19).
      expect(html).not.toContain("parachute auth approve-client");
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
      // Page h1: "Approve <client>?" per design-system.md §5 (was "Authorize").
      expect(consentHtml).toContain('name="__action" value="consent"');
      expect(consentHtml).toContain("Approve");
      expect(consentHtml).toContain("RoundTrip");
    } finally {
      cleanup();
    }
  });

  // Deny path tests (hub#390). The shared describe block above pins the
  // approve path's security model; these tests pin that the deny path
  // honors the same guards AND constructs a spec-shaped error redirect.

  test("deny POST happy path: valid redirect_uri + state → 302 to client with access_denied", async () => {
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
        decision: "deny",
        redirect_uri: "https://app.example/cb",
        state: "deny-state-abc",
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
      const loc = res.headers.get("location") ?? "";
      const target = new URL(loc);
      expect(target.origin).toBe("https://app.example");
      expect(target.pathname).toBe("/cb");
      expect(target.searchParams.get("error")).toBe("access_denied");
      expect(target.searchParams.get("state")).toBe("deny-state-abc");
      // Client row stays pending — deny does not mutate.
      expect(getClient(db, reg.client.clientId)?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("deny POST: no state in form → redirect omits state param (spec-compliant)", async () => {
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
        decision: "deny",
        redirect_uri: "https://app.example/cb",
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
      const target = new URL(res.headers.get("location") ?? "");
      expect(target.searchParams.get("error")).toBe("access_denied");
      expect(target.searchParams.has("state")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("deny POST: redirect_uri not in client's registered URIs → 400 (open-redirect defense)", async () => {
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
        decision: "deny",
        // attacker-controlled redirect_uri
        redirect_uri: "https://attacker.example/grab",
        state: "x",
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
      // No mutation, no redirect to attacker.
      expect(res.headers.get("location")).toBeNull();
      expect(getClient(db, reg.client.clientId)?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("deny POST: CSRF + session + same-origin guards apply to deny path too", async () => {
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
        decision: "deny",
        redirect_uri: "https://app.example/cb",
        state: "x",
      });
      // Cross-origin Origin header — same defense as approve path.
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
    } finally {
      cleanup();
    }
  });

  test("approve POST: explicit decision=approve still works (no regression)", async () => {
    // Back-compat: forms that explicitly carry decision=approve should
    // continue to flip the client to approved + redirect to return_to.
    // Pre-deny PR the field didn't exist; the new form sends it explicitly.
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
        decision: "approve",
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
      expect(getClient(db, reg.client.clientId)?.status).toBe("approved");
    } finally {
      cleanup();
    }
  });
});

// DCR first-client auto-approve window (hub#268 Item 3). The wizard's
// expose-step POST opens a 60-minute window where the very next
// `/oauth/register` registration is auto-approved + the window cleared.
// Single-use: client #2 within the same window falls through to the
// standard pending-approval flow.
describe("DCR first-client auto-approve window (hub#268 Item 3)", () => {
  function registerRequest(): Request {
    return new Request(`${ISSUER}/oauth/register`, {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: ["https://app.example/cb"],
        client_name: "first-client",
      }),
      headers: { "content-type": "application/json" },
    });
  }

  test("client registered within the open window → status approved + window cleared", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-05-19T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => t0);
      const res = await handleRegister(db, registerRequest(), {
        issuer: ISSUER,
        now: () => t0,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("approved");
      // Persisted, not just response-shaped.
      const row = getClient(db, body.client_id as string);
      expect(row?.status).toBe("approved");
      // Window cleared on consume (single-use).
      expect(getSetting(db, "pending_first_client_auto_approve_until")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("client registered AFTER the window has expired → status pending", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-05-19T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => t0);
      const past = new Date(t0.getTime() + FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS + 1);
      const res = await handleRegister(db, registerRequest(), {
        issuer: ISSUER,
        now: () => past,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("second client within window after first auto-approved → status pending (single-use)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-05-19T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => t0);
      // Client #1: approved.
      const res1 = await handleRegister(db, registerRequest(), {
        issuer: ISSUER,
        now: () => t0,
      });
      const body1 = (await res1.json()) as Record<string, unknown>;
      expect(body1.status).toBe("approved");
      // Client #2 within the (still-not-expired) window: pending.
      const stillWithinWindow = new Date(t0.getTime() + 30 * 60 * 1000);
      const res2 = await handleRegister(db, registerRequest(), {
        issuer: ISSUER,
        now: () => stillWithinWindow,
      });
      const body2 = (await res2.json()) as Record<string, unknown>;
      expect(body2.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("no window set → status pending (default public-DCR flow)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const res = await handleRegister(db, registerRequest(), { issuer: ISSUER });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
      // Settings row untouched.
      expect(getSetting(db, "pending_first_client_auto_approve_until")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("operator-bearer auto-approve still takes precedence over the window (no double-consume)", async () => {
    // Bearer-authenticated registration approves directly; the
    // auto-approve window should NOT be consumed in that case — it's
    // still available for the first un-authenticated client.
    const { db, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-05-19T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => t0);
      // We can't easily mint an operator bearer in this test layer, so
      // simulate by using the session-cookie path (issuer-trusted) which
      // also auto-approves before falling through to the window check.
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
        headers: {
          "content-type": "application/json",
          cookie: buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)),
          origin: ISSUER,
        },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER, now: () => t0 });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("approved");
      // Window NOT consumed — still set, still open. The session-cookie
      // path approved first, never reaching the window-consume code.
      expect(getSetting(db, "pending_first_client_auto_approve_until")).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("malformed timestamp in the setting → treated as no-window, status pending", async () => {
    const { db, cleanup } = await makeDb();
    try {
      setSetting(db, "pending_first_client_auto_approve_until", "not-a-real-iso-string");
      const res = await handleRegister(db, registerRequest(), { issuer: ISSUER });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("pending");
    } finally {
      cleanup();
    }
  });
});

// Multi-user Phase 1, PR 4 (design 2026-05-20-multi-user-phase-1.md, hub#252):
// non-admin users (with `assigned_vault` non-null) see the consent picker
// locked, and the OAuth issuer mints tokens carrying `vault_scope: [<assigned>]`.
// Server-side defense refuses any mint whose picked vault disagrees.
describe("vaultScopeForUser (multi-user Phase 2 PR 2 — many-to-many)", () => {
  test("first admin returns [] regardless of any user_vaults rows", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      expect(vaultScopeForUser(db, admin.id)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("non-admin with zero vault assignments returns []", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "admin-aaron", "pw");
      const bob = await createUser(db, "bob", "pw", { allowMulti: true });
      expect(vaultScopeForUser(db, bob.id)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("non-admin with one assigned vault returns [name]", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "admin-aaron", "pw");
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      expect(vaultScopeForUser(db, bob.id)).toEqual(["default"]);
    } finally {
      cleanup();
    }
  });

  test("non-admin with multiple assigned vaults returns each name", async () => {
    const { db, cleanup } = await makeDb();
    try {
      await createUser(db, "admin-aaron", "pw");
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["personal", "family"],
      });
      expect(new Set(vaultScopeForUser(db, bob.id))).toEqual(new Set(["personal", "family"]));
    } finally {
      cleanup();
    }
  });

  test("unknown user id returns [] defensively", async () => {
    const { db, cleanup } = await makeDb();
    try {
      expect(vaultScopeForUser(db, "no-such-id")).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizeGet — multi-user assigned vault picker lock (PR 4)", () => {
  test("admin user (assigned_vault null) sees the free dropdown", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      const session = createSession(db, { userId: admin.id });
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
      // Free dropdown for admin: radio inputs present, no "Assigned vault" lock.
      expect(html).toContain('name="vault_pick" value="default"');
      expect(html).not.toContain("Assigned vault");
      expect(html).not.toContain("admin-managed");
    } finally {
      cleanup();
    }
  });

  test("non-admin user with 2+ assigned vaults sees a free dropdown filtered to those (Phase 2 PR 2)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        // Only "default" is in the fixture manifest; non-admins with a
        // mix of valid + invalid vaults effectively get the intersection.
        assignedVaults: ["default", "personal"],
      });
      // Add a second vault to the manifest so the dropdown has two
      // valid choices to filter to.
      const multiVaultManifest: ServicesManifest = {
        services: [
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default", "/vault/personal", "/vault/family"],
            health: "/health",
            version: "0.3.0",
          },
        ],
      };
      const session = createSession(db, { userId: bob.id });
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
        loadServicesManifest: () => multiVaultManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // NOT the locked picker section — two vaults is a dropdown.
      expect(html).not.toContain('class="vault-picker vault-picker-locked"');
      // No locked-vault hidden input.
      expect(html).not.toContain('<input type="hidden" name="vault_pick"');
      // Two radios — for the two assigned vaults, in order.
      expect(html).toContain('name="vault_pick" value="default"');
      expect(html).toContain('name="vault_pick" value="personal"');
      // NOT the third hub-wide vault (`family`) — filtered out.
      expect(html).not.toContain('name="vault_pick" value="family"');
    } finally {
      cleanup();
    }
  });

  test("non-admin requesting a named vault outside their list → 400 vault_scope_mismatch (Phase 2 PR 2)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["personal", "family"],
      });
      const multiVaultManifest: ServicesManifest = {
        services: [
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/personal", "/vault/family", "/vault/work"],
            health: "/health",
            version: "0.3.0",
          },
        ],
      };
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        // Asking for "work" which exists on the hub but is NOT in
        // bob's assigned list.
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
        { issuer: ISSUER, loadServicesManifest: () => multiVaultManifest },
      );
      expect(consentRes.status).toBe(400);
      const body = await consentRes.text();
      expect(body).toContain("vault_scope_mismatch");
    } finally {
      cleanup();
    }
  });

  test("non-admin user (assigned_vault set) sees the locked picker with admin-managed note", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      void admin;
      const session = createSession(db, { userId: bob.id });
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
      expect(html).toContain("vault-picker-locked");
      expect(html).toContain("Assigned vault");
      expect(html).toContain("admin-managed");
      // Hidden input carries the assigned vault as the picker value.
      expect(html).toContain('<input type="hidden" name="vault_pick" value="default"');
      // No free-choice radio inputs.
      expect(html).not.toContain('type="radio" name="vault_pick"');
    } finally {
      cleanup();
    }
  });
});

// Approval-UX rc.19 (Issue 2 in Aaron's bundle): the consent screen now
// renders the *resolved* scope shape — `vault:<name>:<verb>` — instead of
// the raw OAuth request `vault:<verb>`. The raw form was confusing because
// it implied vault-wide unrestricted access, when hub actually narrows to
// a specific vault at token-mint via the picker (or the user's
// assigned_vault for multi-user setups).
describe("handleAuthorizeGet — resolved scope display (approval-UX rc.19)", () => {
  test("non-admin user (assigned_vault set) sees vault:<assigned>:read on consent, not raw vault:read", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
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
      // Resolved form rendered in the scope-row code block.
      expect(html).toContain('<code class="scope-name">vault:default:read</code>');
      // Raw unnamed form must NOT appear inside a scope row (it still
      // appears in the hidden form-roundtrip inputs as `name="scope" value="vault:read"`).
      expect(html).not.toContain('<code class="scope-name">vault:read</code>');
    } finally {
      cleanup();
    }
  });

  test("admin user with picker — single-vault hub pre-checks and consent shows that vault", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      const session = createSession(db, { userId: admin.id });
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
      // The fixture services manifest has a single vault named "default" — the
      // picker pre-checks it and the consent screen renders the resolved form.
      expect(html).toContain('<code class="scope-name">vault:default:read</code>');
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizePost — multi-user assigned vault defense (PR 4)", () => {
  test("non-admin happy path: token carries vault_scope=[assigned] and narrowed scope", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
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
      expect(consentRes.status).toBe(302);
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
      const body = (await tokenRes.json()) as { access_token: string; scope: string };
      expect(body.scope).toBe("vault:default:read");
      const { payload } = await validateAccessToken(db, body.access_token, ISSUER);
      expect(payload.scope).toBe("vault:default:read");
      expect(payload.vault_scope).toEqual(["default"]);
    } finally {
      cleanup();
    }
  });

  test("admin user (assigned_vault null) mints with vault_scope=[]", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      const session = createSession(db, { userId: admin.id });
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
      const body = (await tokenRes.json()) as { access_token: string };
      const { payload } = await validateAccessToken(db, body.access_token, ISSUER);
      expect(payload.vault_scope).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("non-admin with disagreeing vault_pick → 400 vault_scope_mismatch", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      // The fixture also has a vault "default"; build a manifest that has
      // two valid vault names so the mismatch isn't conflated with
      // "unknown vault."
      const twoVaultManifest: ServicesManifest = {
        services: [
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/default", "/vault/other"],
            health: "/health",
            version: "0.3.0",
          },
        ],
      };
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
        vault_pick: "other",
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
        { issuer: ISSUER, loadServicesManifest: () => twoVaultManifest },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("vault_scope_mismatch");
      // Echo back the picked-but-rejected vault (HTML-escaped), but DON'T
      // leak the assigned one (post-N1 nit-fold). "your vault assignment"
      // is the soft phrase replacing the prior `your assigned vault "..."`.
      expect(html).toContain("&quot;other&quot;");
      expect(html).toContain("your vault assignment");
      expect(html).not.toContain("&quot;default&quot;");
    } finally {
      cleanup();
    }
  });

  test("non-admin requesting named scope for the wrong vault → 400 vault_scope_mismatch", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        // Explicit named scope targeting a vault other than bob's assigned one.
        scope: "vault:other:read",
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
      expect(html).toContain("vault_scope_mismatch");
      expect(html).toContain("vault:other:read");
    } finally {
      cleanup();
    }
  });

  test("non-admin requesting named scope for the assigned vault → happy path", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        // Named scope matching bob's assigned vault — should pass.
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
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, 86400)}`,
          },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      expect(consentRes.status).toBe(302);
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
      const body = (await tokenRes.json()) as { access_token: string };
      const { payload } = await validateAccessToken(db, body.access_token, ISSUER);
      expect(payload.scope).toBe("vault:default:read");
      expect(payload.vault_scope).toEqual(["default"]);
    } finally {
      cleanup();
    }
  });

  test("refresh flow re-derives vault_scope from current assigned_vault", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();

      // Step 1: complete the OAuth dance to obtain a refresh token.
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
      const tokenBody = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
      };
      const firstValidated = await validateAccessToken(db, tokenBody.access_token, ISSUER);
      expect(firstValidated.payload.vault_scope).toEqual(["default"]);

      // Step 2: refresh the token; vault_scope should still be ["default"].
      const refreshRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: tokenBody.refresh_token,
            client_id: reg.client.clientId,
          }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadServicesManifest: fixtureLoadServicesManifest },
      );
      const refreshBody = (await refreshRes.json()) as { access_token: string };
      const refreshedValidated = await validateAccessToken(db, refreshBody.access_token, ISSUER);
      expect(refreshedValidated.payload.vault_scope).toEqual(["default"]);
    } finally {
      cleanup();
    }
  });

  // Reviewer nit N3 (PR #283): the previous test only verified that
  // `vault_scope` SURVIVES refresh — it didn't prove the claim is re-derived
  // mid-session if an admin changes the user's `assigned_vault`. This test
  // pins the actual "re-derived at refresh time" invariant by mutating the
  // assignment between mint and refresh, then asserting the new token
  // carries the post-mutation value. The `scope` claim itself stays
  // narrowed to the original vault (it was set at consent time and stored
  // on the refresh-token row); only the informational `vault_scope` claim
  // tracks the live row.
  test("refresh flow picks up a mid-session assigned_vault change", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["vault-a"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { verifier, challenge } = makePkce();

      // Manifest fixture: both vault-a (initial assignment) and vault-b
      // (post-admin-update assignment) are registered. PR 4 doesn't ship
      // a PATCH endpoint, so we use the same direct UPDATE the design
      // anticipates an admin path would call.
      const twoVaultManifest: ServicesManifest = {
        services: [
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/vault-a", "/vault/vault-b"],
            health: "/health",
            version: "0.3.0",
          },
        ],
      };

      // Step 1: initial OAuth dance + token mint. Asserts vault_scope=["vault-a"].
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
        vault_pick: "vault-a",
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
        { issuer: ISSUER, loadServicesManifest: () => twoVaultManifest },
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
        { issuer: ISSUER, loadServicesManifest: () => twoVaultManifest },
      );
      const tokenBody = (await tokenRes.json()) as {
        access_token: string;
        refresh_token: string;
      };
      const initial = await validateAccessToken(db, tokenBody.access_token, ISSUER);
      expect(initial.payload.vault_scope).toEqual(["vault-a"]);
      expect(initial.payload.scope).toBe("vault:vault-a:read");

      // Step 2: admin updates bob's vault assignments to ["vault-b"].
      // Direct DB writes against user_vaults — same effect as the PATCH
      // /api/users/:id/vaults endpoint. The refresh path reads the live
      // row at mint time (`vaultScopeForUser`), so the next refresh
      // should pick up the new value.
      db.prepare("DELETE FROM user_vaults WHERE user_id = ?").run(bob.id);
      db.prepare(
        "INSERT INTO user_vaults (user_id, vault_name, role, created_at) VALUES (?, ?, 'write', ?)",
      ).run(bob.id, "vault-b", new Date().toISOString());

      // Step 3: refresh the token. vault_scope should be ["vault-b"] (the
      // new live value); the `scope` claim stays narrowed to the original
      // vault (auth-code grant snapshotted it onto the refresh-token row).
      const refreshRes = await handleToken(
        db,
        new Request(`${ISSUER}/oauth/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: tokenBody.refresh_token,
            client_id: reg.client.clientId,
          }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        { issuer: ISSUER, loadServicesManifest: () => twoVaultManifest },
      );
      expect(refreshRes.status).toBe(200);
      const refreshBody = (await refreshRes.json()) as { access_token: string };
      const refreshed = await validateAccessToken(db, refreshBody.access_token, ISSUER);
      expect(refreshed.payload.vault_scope).toEqual(["vault-b"]);
      // The `scope` claim is still bound to the original consent — the
      // refresh-token row carries `vault:vault-a:read` and the rotation
      // preserves it. PR 5 will be the side that enforces "your access
      // tokens for the old vault stop working when the assignment moves";
      // PR 4 just emits the informational claim correctly.
      expect(refreshed.payload.scope).toBe("vault:vault-a:read");
    } finally {
      cleanup();
    }
  });
});

// closes hub#312 — DCR clients registered by the hub's own operator (bearer
// hub:admin OR session-cookie + same-origin) land same_hub=true and bypass
// the consent screen at /oauth/authorize for non-admin scopes. Foundational
// for the parachute-app friend-deploy story (zero consent screens per UI
// the app installs).
describe("DCR same-hub auto-trust (hub#312)", () => {
  const SESSION_COOKIE_TTL_S = Math.floor(SESSION_TTL_MS / 1000);

  test("register: no auth → same_hub=false (response + DB)", async () => {
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
      expect(body.same_hub).toBe(false);
      const row = getClient(db, body.client_id as string);
      expect(row?.sameHub).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("register: operator-bearer (hub:admin) → same_hub=true", async () => {
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
      expect(body.same_hub).toBe(true);
      const row = getClient(db, body.client_id as string);
      expect(row?.sameHub).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("register: session cookie + same-origin → same_hub=true", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
        headers: {
          "content-type": "application/json",
          cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
          origin: ISSUER,
        },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.same_hub).toBe(true);
      const row = getClient(db, body.client_id as string);
      expect(row?.sameHub).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("register: session cookie + cross-origin → same_hub=false (CSRF defense)", async () => {
    // Same-origin gate must reject — a cross-site forgery can't ride the
    // cookie into a same_hub=true claim. Matches the #199 status pending
    // path on the same gate.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
        headers: {
          "content-type": "application/json",
          cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S),
          origin: "https://attacker.example",
        },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.same_hub).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("register: wizard-window auto-approve → same_hub=false (approval ≠ ownership)", async () => {
    // The first-client wizard window (#268) is auto-APPROVE but external —
    // the operator deliberately ran the wizard but the registrant (the
    // app being installed) is not operator-authenticated. Approval and
    // ownership are different things; the test pins that they stay
    // separate.
    const { db, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-05-22T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => t0);
      const req = new Request(`${ISSUER}/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
        headers: { "content-type": "application/json" },
      });
      const res = await handleRegister(db, req, { issuer: ISSUER, now: () => t0 });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      // Approved by the wizard window, but NOT same_hub — the registrant
      // is external.
      expect(body.status).toBe("approved");
      expect(body.same_hub).toBe(false);
      const row = getClient(db, body.client_id as string);
      expect(row?.sameHub).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("authorize: same_hub=true + non-admin scope → silent-approve (302 with code)", async () => {
    // The payoff. A parachute-app-registered client requesting `vault:default:read`
    // gets the auth code immediately — no consent HTML screen rendered.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: true,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "same-hub-1",
        }),
        { headers: { cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S) } },
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("code")?.length).toBeGreaterThan(20);
      expect(loc.searchParams.get("state")).toBe("same-hub-1");
    } finally {
      cleanup();
    }
  });

  test("authorize: same_hub=true + non-admin scope → grant recorded for follow-up flows", async () => {
    // Subsequent flows (same scopes, even if the same-hub gate ever moves)
    // should hit the standard #75 skip-consent gate uniformly. We pin that
    // by checking grants directly — the next flow doesn't need to re-trip
    // the same-hub gate to stay silent.
    const { db, cleanup } = await makeDb();
    try {
      const { isCoveredByGrant } = await import("../grants.ts");
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: true,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read scribe:transcribe",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S) } },
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);
      // Grant landed for the consented scopes.
      expect(
        isCoveredByGrant(db, user.id, reg.client.clientId, [
          "vault:default:read",
          "scribe:transcribe",
        ]),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("authorize: same_hub=true + admin scope → consent screen (high-power sanity gate)", async () => {
    // hub:admin is requestable via DCR (only `parachute:host:admin` and
    // per-vault `vault:*:admin` are non-requestable). For same-hub
    // clients we DO still show consent on admin scopes — the operator
    // who registered the client may not want to grant their own session
    // hub-wide admin access without an explicit click.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: true,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "hub:admin",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S) } },
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      // Consent rendered, not silent-approve.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("hub:admin");
    } finally {
      cleanup();
    }
  });

  test("authorize: same_hub=true + mixed admin+non-admin → consent screen (any admin scope shows consent)", async () => {
    // Defensive: a request asking for `vault:default:read hub:admin` must
    // NOT silent-approve on the strength of the non-admin scope. Any
    // admin scope present forces consent.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: true,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read hub:admin",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S) } },
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    } finally {
      cleanup();
    }
  });

  test("authorize: same_hub=true + unnamed vault verb → consent screen (picker needed)", async () => {
    // Unnamed `vault:read` needs the picker to narrow to
    // `vault:<name>:read` before mint. The same-hub gate must not
    // skip past this — it would mint a token with an unscoped
    // `vault:read` claim that downstream resource servers couldn't
    // pin to a specific vault.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: true,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S) } },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    } finally {
      cleanup();
    }
  });

  test("authorize: same_hub=false → consent screen (current behavior, any scope)", async () => {
    // The default for externally-registered clients (DCR without auth, or
    // wizard-window-approved). Pinning that nothing about the new gate
    // affects the external-DCR consent shape.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: false,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S) } },
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
    } finally {
      cleanup();
    }
  });

  test("authorize: same-hub silent-approve emits audit log line", async () => {
    const { db, cleanup } = await makeDb();
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: true,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          scope: "vault:default:read",
          code_challenge: challenge,
          code_challenge_method: "S256",
        }),
        { headers: { cookie: buildSessionCookie(session.id, SESSION_COOKIE_TTL_S) } },
      );
      const res = handleAuthorizeGet(db, req, { issuer: ISSUER });
      expect(res.status).toBe(302);

      const auto = lines.find((l) => l.startsWith("[oauth] auto-approved same-hub client"));
      expect(auto).toBeDefined();
      expect(auto).toContain(`client_id=${reg.client.clientId}`);
      expect(auto).toContain(`user_id=${user.id}`);
      expect(auto).toContain("scopes=vault:default:read");
      expect(auto).toContain("hub#312");
    } finally {
      console.log = originalLog;
      cleanup();
    }
  });

  test("migration backfill: existing rows (pre-migration) get same_hub=false", async () => {
    // The migration v9 backfills every pre-existing client to same_hub=0.
    // We can't easily simulate "registered before migration" without a v8-
    // only DB, so the indirect test is: insert a row via INSERT bypassing
    // RegisterClientOpts.sameHub (defaults to false from the helper), and
    // confirm the row reads back same_hub=false. The migration's UPDATE
    // shape (SET same_hub = 0) is the same as the column's NOT NULL DEFAULT
    // 0 — a v8→v9 upgrade and a v9 fresh-DB land identical defaults.
    const { db, cleanup } = await makeDb();
    try {
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        // No sameHub: omitted → defaults false.
      });
      expect(reg.client.sameHub).toBe(false);
      const row = getClient(db, reg.client.clientId);
      expect(row?.sameHub).toBe(false);
    } finally {
      cleanup();
    }
  });
});

// closes hub#284 — multi-user Phase 2 polish. A user has an `assigned_vault`
// pinned on their row but the admin later removes the matching vault from
// services.json. Pre-rc.11 the user landed on the consent screen with the
// locked picker rendering the missing name, submitted the form, and hit a
// generic "Unknown vault" 400 that gave no path forward. These tests cover
// the new shape:
//
//   - GET handler renders a "Your assigned vault was removed" banner + an
//     admin-managed remediation hint + a no-vaults picker section + disabled
//     Approve (when the requested scope depends on a vault).
//   - POST handler surfaces the same admin-managed remediation hint in the
//     400 body when a hand-crafted form bypasses the disabled-Approve UI
//     and posts the stale name, AND when a named `vault:<stale>:<verb>`
//     scope was requested directly.
//   - Banner is informational only when the requested scope doesn't depend
//     on a vault — the user can still consent to e.g. `scribe:transcribe`
//     while their assignment is stale.
describe("handleAuthorizeGet — stale assigned_vault surfaces banner (hub#284)", () => {
  // Manifest with only `other` — the user's assigned `default` is missing
  // (admin removed it without reassigning).
  const otherOnlyManifest: ServicesManifest = {
    services: [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/other"],
        health: "/health",
        version: "0.3.0",
      },
    ],
  };
  // Empty manifest — every vault has been removed.
  const emptyVaultManifest: ServicesManifest = {
    services: [
      {
        name: "parachute-scribe",
        port: 1943,
        paths: ["/scribe"],
        health: "/health",
        version: "0.3.0-rc.1",
      },
    ],
  };

  test("unnamed vault scope + stale assignment → banner + no-vaults picker + disabled Approve", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
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
        loadServicesManifest: () => otherOnlyManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // Banner present with the stale vault name + admin remediation hint.
      expect(html).toContain('class="stale-assignment-banner"');
      expect(html).toContain("Your assigned vault was removed");
      expect(html).toContain("<code>default</code>");
      expect(html).toContain("/admin/users");
      // Picker pivoted to no-vaults-available — NO locked-picker hidden
      // input carrying the stale name, NO radio choices for `other`.
      expect(html).not.toContain('<input type="hidden" name="vault_pick" value="default"');
      expect(html).not.toContain('type="radio" name="vault_pick"');
      // Approve button is disabled.
      expect(html).toMatch(/<button[^>]*name="approve"[^>]*value="yes"[^>]*disabled/);
    } finally {
      cleanup();
    }
  });

  test("named vault scope targeting stale assignment → banner + disabled Approve", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          // Client knew the vault name + asked directly for the named verb.
          scope: "vault:default:read",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: () => otherOnlyManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('class="stale-assignment-banner"');
      expect(html).toContain("Your assigned vault was removed");
      // Approve disabled — the token would point at a vault that doesn't
      // exist, so don't let the user mint it.
      expect(html).toMatch(/<button[^>]*name="approve"[^>]*value="yes"[^>]*disabled/);
    } finally {
      cleanup();
    }
  });

  test("non-vault scope + stale assignment → informational banner + Approve stays enabled", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          // Non-vault scope only — user CAN still consent to scribe access
          // despite the stale assignment.
          scope: "scribe:transcribe",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: () => emptyVaultManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // Banner shown for visibility even though scope is vault-free.
      expect(html).toContain('class="stale-assignment-banner"');
      expect(html).toContain("Your assigned vault was removed");
      // Approve NOT disabled — user can still consent to scribe-only access.
      expect(html).not.toMatch(/<button[^>]*name="approve"[^>]*value="yes"[^>]*disabled/);
    } finally {
      cleanup();
    }
  });

  test("admin user (assigned_vault null) → no stale-assignment banner ever", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      const session = createSession(db, { userId: admin.id });
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
      // Even with zero vaults registered, admin sees the existing
      // empty-vault picker, not the stale-assignment banner — the banner
      // is for `assigned_vault !== null` only.
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: () => emptyVaultManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('class="stale-assignment-banner"');
      expect(html).not.toContain("Your assigned vault was removed");
    } finally {
      cleanup();
    }
  });

  test("user with intact assignment → no banner (pre-#284 happy path stays clean)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
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
      // Fixture manifest has `default`, matching bob's assignment.
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('class="stale-assignment-banner"');
      expect(html).not.toContain("Your assigned vault was removed");
      // Locked-picker still rendered as before.
      expect(html).toContain('<input type="hidden" name="vault_pick" value="default"');
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizePost — stale assigned_vault clean 400 (hub#284)", () => {
  const otherOnlyManifest: ServicesManifest = {
    services: [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/other"],
        health: "/health",
        version: "0.3.0",
      },
    ],
  };

  test("hand-crafted POST with stale vault_pick → 'Assigned vault was removed' 400 (not generic Unknown vault)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
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
        // Hand-crafted POST submitting bob's stale assignment — simulates a
        // bypass of the GET handler's disabled Approve.
        vault_pick: "default",
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
        { issuer: ISSUER, loadServicesManifest: () => otherOnlyManifest },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      // New copy: title + body name the actual condition + remediation.
      expect(html).toContain("Assigned vault was removed");
      expect(html).toContain("/admin/users");
      expect(html).toContain("&quot;default&quot;");
      // Old generic copy must NOT be the title in this case.
      expect(html).not.toMatch(/<h1[^>]*>Unknown vault<\/h1>/);
    } finally {
      cleanup();
    }
  });

  test("hand-crafted POST with vault_pick naming a never-existed vault → still hits generic Unknown vault 400", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
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
        // A name that's not bob's assignment AND not in the manifest. The
        // mismatch check should fire first (since it's not bob's assigned
        // vault). Pin the existing shape against accidental capture by the
        // hub#284 special-case.
        vault_pick: "ghost-vault",
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
        { issuer: ISSUER, loadServicesManifest: () => otherOnlyManifest },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      // The mismatch check fires BEFORE the validNames check at the picker
      // site (validNames-fail-then-special-case is a per-site narrowing) —
      // but the named-scope mismatch check fires at the second site. Either
      // way the response should NOT be the new stale-assignment copy.
      expect(html).not.toContain("Assigned vault was removed");
      expect(html).not.toContain("/admin/users");
    } finally {
      cleanup();
    }
  });

  test("named scope vault:<stale>:read → POST refuses with 'Assigned vault was removed' 400", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { challenge } = makePkce();
      const consentForm = new URLSearchParams({
        __action: "consent",
        __csrf: TEST_CSRF,
        approve: "yes",
        client_id: reg.client.clientId,
        redirect_uri: "https://app.example/cb",
        response_type: "code",
        // Named scope shape: client asked for `vault:default:read` directly
        // (knew the user's assignment). No picker involved.
        scope: "vault:default:read",
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
        { issuer: ISSUER, loadServicesManifest: () => otherOnlyManifest },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Assigned vault was removed");
      expect(html).toContain("&quot;default&quot;");
      expect(html).toContain("/admin/users");
    } finally {
      cleanup();
    }
  });
});

// closes hub#284 reviewer fold — `hasStaleAssignment` predicate gates BOTH
// the #75 skip-consent fast-path AND the hub#312 same-hub auto-trust gate,
// not just the consent-render path. Pre-fold, a user with a prior
// `vault:default:read` grant on a now-removed vault landed at the skip-
// consent gate and silently minted a token for a vault the resource server
// couldn't find — the consent screen (with its banner) never rendered. The
// same-hub variant had the matching gap: a same-hub client requesting
// `vault:default:read` on a stale assignment would auto-approve before the
// stale-detection code at consent render ever ran. These tests pin both
// gates to fall through to the consent render when assignment is stale.
describe("handleAuthorizeGet — stale assignment gates both fast-paths (hub#284 reviewer)", () => {
  // Manifest with only `other` — the user's assigned `default` is missing.
  const otherOnlyManifest: ServicesManifest = {
    services: [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/other"],
        health: "/health",
        version: "0.3.0",
      },
    ],
  };

  test("stale + prior grant covers scope → skip-consent gate SKIPPED, banner rendered (not silent mint)", async () => {
    // Critical reviewer case. The variant most likely to bite real users:
    // they previously consented to `vault:default:read` (grant recorded),
    // then admin removed `default`. Pre-fold the next /authorize hit the
    // skip-consent gate and silently issued a token for the missing vault.
    // Post-fold the gate skips, the consent screen renders, banner shows.
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { recordGrant } = await import("../grants.ts");
      // Prior grant: covers the request below exactly.
      recordGrant(db, bob.id, reg.client.clientId, ["vault:default:read"]);
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:default:read",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: () => otherOnlyManifest,
      });
      // Consent screen rendered, NOT a 302 silent mint.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('class="stale-assignment-banner"');
      expect(html).toContain("Your assigned vault was removed");
      expect(html).toContain("<code>default</code>");
      // Approve gated because the named scope targets the stale vault.
      expect(html).toMatch(/<button[^>]*name="approve"[^>]*value="yes"[^>]*disabled/);
    } finally {
      cleanup();
    }
  });

  test("stale + same-hub client → auto-trust gate SKIPPED, banner rendered (not silent mint)", async () => {
    // The second variant: a same-hub client (parachute-app installed by
    // the operator) requests `vault:default:read`, the operator's
    // assigned vault is stale. Pre-fold the hub#312 gate auto-approved
    // before stale-detection ever ran. Post-fold the gate skips, the
    // consent screen renders.
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: true,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:default:read",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: () => otherOnlyManifest,
      });
      // Consent screen rendered, NOT a 302 silent mint.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain('class="stale-assignment-banner"');
      expect(html).toContain("Your assigned vault was removed");
      expect(html).toMatch(/<button[^>]*name="approve"[^>]*value="yes"[^>]*disabled/);
    } finally {
      cleanup();
    }
  });

  test("stale + non-vault scope + same-hub client → banner informational, Approve enabled", async () => {
    // A same-hub client requesting a non-vault scope (`scribe:transcribe`)
    // hits the auto-trust gate. With a stale assignment we still skip the
    // auto-trust gate per the fold (assignment is stale = always fall
    // through), but the scope doesn't depend on a vault so Approve stays
    // enabled — the user can still consent to scribe access.
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: true,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "scribe:transcribe",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: () => otherOnlyManifest,
      });
      // Consent rendered (auto-trust skipped because assignment is stale).
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('class="stale-assignment-banner"');
      // Approve NOT disabled — non-vault scope is consentable even when
      // the vault assignment is broken.
      expect(html).not.toMatch(/<button[^>]*name="approve"[^>]*value="yes"[^>]*disabled/);
    } finally {
      cleanup();
    }
  });

  test("not-stale + prior grant covers scope → skip-consent fast-path preserved (no regression)", async () => {
    // The happy path: user's assigned vault still exists, prior grant
    // covers the request, /authorize redirects with the auth code. Pin
    // the fast-path so the fold doesn't break the existing UX.
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
      const { recordGrant } = await import("../grants.ts");
      recordGrant(db, bob.id, reg.client.clientId, ["vault:default:read"]);
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:default:read",
          state: "fast-path",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
          },
        },
      );
      // Fixture manifest has `default`, matching bob's assignment.
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("code")?.length).toBeGreaterThan(20);
      expect(loc.searchParams.get("state")).toBe("fast-path");
    } finally {
      cleanup();
    }
  });

  test("not-stale + same-hub client → auto-trust fast-path preserved (no regression)", async () => {
    // The happy path for the hub#312 gate: same-hub client requests a
    // non-admin vault scope, user's assignment is intact, gate fires.
    const { db, cleanup } = await makeDb();
    try {
      const admin = await createUser(db, "admin-aaron", "pw");
      void admin;
      const bob = await createUser(db, "bob", "pw", {
        allowMulti: true,
        assignedVaults: ["default"],
      });
      const session = createSession(db, { userId: bob.id });
      const reg = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        sameHub: true,
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: reg.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:default:read",
          state: "same-hub-fast",
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
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("code")?.length).toBeGreaterThan(20);
      expect(loc.searchParams.get("state")).toBe("same-hub-fast");
    } finally {
      cleanup();
    }
  });
});

describe("handleAuthorizeGet — trust-by-client_name auto-approve (hub#409)", () => {
  test("happy path: session + same-origin + prior grant for client_name → 302 to redirect_uri with code", async () => {
    // The exact scenario hub#409 closes: operator approved "claude-code"
    // last session; this session, Claude re-DCRs a fresh client_id with
    // the same client_name; operator should NOT see the approve-pending
    // screen — the flow goes straight to the authorize-code redirect.
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      // 1. Prior client + grant (the "previously approved" state)
      const prior = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        clientName: "claude-code",
      });
      recordGrant(db, user.id, prior.client.clientId, ["vault:default:read"]);
      // 2. Fresh DCR — same client_name, fresh client_id, status=pending
      const fresh = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
        clientName: "claude-code",
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: fresh.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:default:read",
          state: "trust-by-name",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
            origin: ISSUER,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      // 302 to redirect_uri with code — NOT a 403 with approve-pending HTML.
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.origin + loc.pathname).toBe("https://app.example/cb");
      expect(loc.searchParams.get("code")?.length).toBeGreaterThan(20);
      expect(loc.searchParams.get("state")).toBe("trust-by-name");
      // The fresh client_id is now approved
      const after = getClient(db, fresh.client.clientId);
      expect(after?.status).toBe("approved");
      // A grant was recorded for the new client_id
      expect(findGrant(db, user.id, fresh.client.clientId)).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("falls through to approve-pending when requested scope is NOT covered by prior grant (superset)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const prior = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        clientName: "claude-code",
      });
      // Prior grant covers READ only
      recordGrant(db, user.id, prior.client.clientId, ["vault:default:read"]);
      const fresh = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
        clientName: "claude-code",
      });
      const { challenge } = makePkce();
      // Asking for WRITE — not in prior grant
      const req = new Request(
        authorizeUrl({
          client_id: fresh.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:default:write",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
            origin: ISSUER,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      // Approve-pending render — 403 — because the new scope wasn't trusted
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("App not yet approved");
      // The fresh client_id stays pending
      expect(getClient(db, fresh.client.clientId)?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("falls through when no session (unauthenticated client re-DCR can't ride a session's trust)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const prior = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        clientName: "claude-code",
      });
      recordGrant(db, user.id, prior.client.clientId, ["vault:default:read"]);
      const fresh = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
        clientName: "claude-code",
      });
      const { challenge } = makePkce();
      // No session cookie
      const req = new Request(
        authorizeUrl({
          client_id: fresh.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:default:read",
        }),
        { headers: { origin: ISSUER } },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("App not yet approved");
      expect(getClient(db, fresh.client.clientId)?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });

  test("falls through when client_name is missing/empty (can't match a prior grant)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      const user = await createUser(db, "owner", "pw");
      const session = createSession(db, { userId: user.id });
      const prior = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "approved",
        clientName: "claude-code",
      });
      recordGrant(db, user.id, prior.client.clientId, ["vault:default:read"]);
      // Fresh DCR omits client_name
      const fresh = registerClient(db, {
        redirectUris: ["https://app.example/cb"],
        status: "pending",
      });
      const { challenge } = makePkce();
      const req = new Request(
        authorizeUrl({
          client_id: fresh.client.clientId,
          redirect_uri: "https://app.example/cb",
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "vault:default:read",
        }),
        {
          headers: {
            cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
            origin: ISSUER,
          },
        },
      );
      const res = handleAuthorizeGet(db, req, {
        issuer: ISSUER,
        loadServicesManifest: fixtureLoadServicesManifest,
      });
      expect(res.status).toBe(403);
      expect(getClient(db, fresh.client.clientId)?.status).toBe("pending");
    } finally {
      cleanup();
    }
  });
});
