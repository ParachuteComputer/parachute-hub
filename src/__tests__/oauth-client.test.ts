/**
 * Tests for the hub-as-OAuth-CLIENT engine (`oauth-client.ts`, 4b-2).
 *
 * Fully offline — every network call goes through an injected `fetchFn`. No real
 * fetch is ever made. Covers: discovery (9728→8414 + 8414-only fallback), DCR,
 * authorize-URL building (S256 + state + challenge), code exchange + refresh
 * (form body + expiresAt computation), best-effort revoke, and the
 * fetchWithTimeout abort.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  OAuthClientError,
  buildAuthorizeUrl,
  deriveVaultScopeFromMcpUrl,
  discover,
  exchangeCode,
  fetchWithTimeout,
  generateCodeChallenge,
  generateCodeVerifier,
  refreshToken,
  registerClient,
  revokeRemote,
} from "../oauth-client.ts";

type FetchFn = typeof fetch;

/** A tiny router-style fake fetch. Maps URL → a handler returning a Response. */
function fakeFetch(routes: Record<string, (req: { url: string; init?: RequestInit }) => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    // Match by pathname (ignore query) OR full url.
    const path = new URL(url).pathname;
    const handler = routes[url] ?? routes[path];
    if (!handler) return new Response("not found", { status: 404 });
    return handler({ url, init });
  }) as unknown as FetchFn;
  return { fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// === PKCE ===================================================================

describe("PKCE", () => {
  test("verifier is base64url, challenge is its S256", () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    const c = generateCodeChallenge(v);
    expect(c).toBe(createHash("sha256").update(v).digest("base64url"));
  });

  test("verifiers are distinct (random)", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

// === Discovery ==============================================================

describe("discover", () => {
  test("RFC 9728 → 8414 (resource advertises authorization_servers)", async () => {
    const { fn } = fakeFetch({
      "https://remote.test/.well-known/oauth-protected-resource": () =>
        json({
          resource: "https://remote.test",
          authorization_servers: ["https://issuer.test"],
          scopes_supported: ["vault:eng:read", "vault:eng:write"],
        }),
      "https://issuer.test/.well-known/oauth-authorization-server": () =>
        json({
          issuer: "https://issuer.test",
          authorization_endpoint: "https://issuer.test/oauth/authorize",
          token_endpoint: "https://issuer.test/oauth/token",
          registration_endpoint: "https://issuer.test/oauth/register",
          revocation_endpoint: "https://issuer.test/oauth/revoke",
        }),
    });
    const d = await discover("https://remote.test/vault/eng/mcp", fn);
    expect(d.issuer).toBe("https://issuer.test");
    expect(d.authorizationEndpoint).toBe("https://issuer.test/oauth/authorize");
    expect(d.tokenEndpoint).toBe("https://issuer.test/oauth/token");
    expect(d.registrationEndpoint).toBe("https://issuer.test/oauth/register");
    expect(d.revocationEndpoint).toBe("https://issuer.test/oauth/revoke");
    // 9728 scopes win
    expect(d.scopesSupported).toEqual(["vault:eng:read", "vault:eng:write"]);
  });

  test("8414-only fallback (no 9728 doc → MCP origin is the issuer)", async () => {
    const { fn, calls } = fakeFetch({
      "https://solo.test/.well-known/oauth-protected-resource": () =>
        new Response("nope", { status: 404 }),
      "https://solo.test/.well-known/oauth-authorization-server": () =>
        json({
          issuer: "https://solo.test",
          authorization_endpoint: "https://solo.test/authorize",
          token_endpoint: "https://solo.test/token",
          scopes_supported: ["mcp:read"],
        }),
    });
    const d = await discover("https://solo.test/mcp", fn);
    expect(d.issuer).toBe("https://solo.test");
    expect(d.authorizationEndpoint).toBe("https://solo.test/authorize");
    // scopes from 8414 (no 9728)
    expect(d.scopesSupported).toEqual(["mcp:read"]);
    // it DID try the 9728 doc first
    expect(calls.some((c) => c.url.includes("oauth-protected-resource"))).toBe(true);
  });

  test("throws OAuthClientError when the 8414 doc lacks endpoints", async () => {
    const { fn } = fakeFetch({
      "https://bad.test/.well-known/oauth-protected-resource": () =>
        json({ authorization_servers: ["https://bad.test"] }),
      "https://bad.test/.well-known/oauth-authorization-server": () => json({ issuer: "x" }),
    });
    await expect(discover("https://bad.test/mcp", fn)).rejects.toBeInstanceOf(OAuthClientError);
  });

  test("throws on an invalid mcp url", async () => {
    const { fn } = fakeFetch({});
    await expect(discover("not-a-url", fn)).rejects.toBeInstanceOf(OAuthClientError);
  });

  test("RFC 9728 path-inserted PRM + auth server on a SEPARATE host (the Read.ai shape)", async () => {
    // The PRM lives ONLY at the path-inserted location (host root 404s) and
    // points at an auth server on a DIFFERENT host. The pre-fix discover()
    // probed only the host-root PRM, fell back to mcp-origin-as-issuer, and
    // 404'd on the (nonexistent) authorization-server doc — this is the
    // regression that blocked connecting Read.ai.
    const { fn, calls } = fakeFetch({
      "https://api.example.ai/.well-known/oauth-protected-resource/mcp": () =>
        json({
          resource: "https://api.example.ai/mcp",
          authorization_servers: ["https://authn.example.ai/"],
          scopes_supported: ["mcp:execute", "meeting:read"],
        }),
      "https://authn.example.ai/.well-known/oauth-authorization-server": () =>
        json({
          issuer: "https://authn.example.ai/",
          authorization_endpoint: "https://authn.example.ai/oauth2/auth",
          token_endpoint: "https://authn.example.ai/oauth2/token",
          registration_endpoint: "https://api.example.ai/oauth/register",
        }),
    });
    const d = await discover("https://api.example.ai/mcp/", fn);
    expect(d.issuer).toBe("https://authn.example.ai/");
    expect(d.authorizationEndpoint).toBe("https://authn.example.ai/oauth2/auth");
    expect(d.tokenEndpoint).toBe("https://authn.example.ai/oauth2/token");
    expect(d.registrationEndpoint).toBe("https://api.example.ai/oauth/register");
    // 9728 scopes win
    expect(d.scopesSupported).toEqual(["mcp:execute", "meeting:read"]);
    // proves the path-inserted PRM probe was used (host-root PRM isn't defined)
    expect(
      calls.some((c) => c.url === "https://api.example.ai/.well-known/oauth-protected-resource/mcp"),
    ).toBe(true);
  });

  test("AS discovery falls back to openid-configuration when oauth-authorization-server is absent", async () => {
    const { fn } = fakeFetch({
      "https://api.example.ai/.well-known/oauth-protected-resource/mcp": () =>
        json({ authorization_servers: ["https://authn.example.ai/"] }),
      // No RFC 8414 doc — only OIDC discovery.
      "https://authn.example.ai/.well-known/openid-configuration": () =>
        json({
          issuer: "https://authn.example.ai/",
          authorization_endpoint: "https://authn.example.ai/oauth2/auth",
          token_endpoint: "https://authn.example.ai/oauth2/token",
        }),
    });
    const d = await discover("https://api.example.ai/mcp", fn);
    expect(d.tokenEndpoint).toBe("https://authn.example.ai/oauth2/token");
  });

  test("malformed authorization_servers issuer throws OAuthClientError (not a raw TypeError)", async () => {
    const { fn } = fakeFetch({
      "https://api.example.ai/.well-known/oauth-protected-resource/mcp": () =>
        json({ authorization_servers: ["not-a-url"] }),
    });
    await expect(discover("https://api.example.ai/mcp", fn)).rejects.toBeInstanceOf(OAuthClientError);
  });

  test("AS discovery uses the OIDC-append form for a path-ful issuer", async () => {
    const { fn } = fakeFetch({
      "https://api.example.ai/.well-known/oauth-protected-resource/mcp": () =>
        json({ authorization_servers: ["https://idp.example.ai/tenant1"] }),
      // ONLY the OIDC-append URL exists (issuer-path + /.well-known/openid-configuration),
      // not the RFC 8414 insert form — proves the append candidate is generated.
      "https://idp.example.ai/tenant1/.well-known/openid-configuration": () =>
        json({
          issuer: "https://idp.example.ai/tenant1",
          authorization_endpoint: "https://idp.example.ai/tenant1/auth",
          token_endpoint: "https://idp.example.ai/tenant1/token",
        }),
    });
    const d = await discover("https://api.example.ai/mcp", fn);
    expect(d.tokenEndpoint).toBe("https://idp.example.ai/tenant1/token");
  });
});

// === DCR ====================================================================

describe("registerClient", () => {
  test("posts RFC 7591 body, returns client_id", async () => {
    const { fn, calls } = fakeFetch({
      "https://issuer.test/oauth/register": () => json({ client_id: "dcr-abc123" }, 201),
    });
    const r = await registerClient(
      "https://issuer.test/oauth/register",
      "https://hub.test/oauth/agent-grant/callback",
      fn,
    );
    expect(r.clientId).toBe("dcr-abc123");
    const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
    expect(body.redirect_uris).toEqual(["https://hub.test/oauth/agent-grant/callback"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
  });

  test("throws when the response lacks client_id", async () => {
    const { fn } = fakeFetch({
      "https://issuer.test/oauth/register": () => json({ nope: true }),
    });
    await expect(
      registerClient("https://issuer.test/oauth/register", "https://hub.test/cb", fn),
    ).rejects.toBeInstanceOf(OAuthClientError);
  });

  test("throws on a non-2xx", async () => {
    const { fn } = fakeFetch({
      "https://issuer.test/oauth/register": () => new Response("forbidden", { status: 403 }),
    });
    await expect(
      registerClient("https://issuer.test/oauth/register", "https://hub.test/cb", fn),
    ).rejects.toBeInstanceOf(OAuthClientError);
  });
});

// === buildAuthorizeUrl ======================================================

describe("buildAuthorizeUrl", () => {
  test("includes S256, state, challenge, and scope", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: "https://issuer.test/oauth/authorize",
        clientId: "cid",
        redirectUri: "https://hub.test/oauth/agent-grant/callback",
        scope: "vault:eng:read vault:eng:write",
        state: "st-123",
        codeChallenge: "chal-xyz",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://issuer.test/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://hub.test/oauth/agent-grant/callback",
    );
    expect(url.searchParams.get("scope")).toBe("vault:eng:read vault:eng:write");
    expect(url.searchParams.get("state")).toBe("st-123");
    expect(url.searchParams.get("code_challenge")).toBe("chal-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("omits scope when not provided", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: "https://issuer.test/oauth/authorize",
        clientId: "cid",
        redirectUri: "https://hub.test/cb",
        state: "st",
        codeChallenge: "ch",
      }),
    );
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

// === exchangeCode + refreshToken ============================================

describe("exchangeCode", () => {
  test("posts the form, computes expiresAt from expires_in", async () => {
    const fixedNow = new Date("2026-06-18T12:00:00.000Z");
    const { fn, calls } = fakeFetch({
      "https://issuer.test/oauth/token": () =>
        json({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "vault:eng:read",
        }),
    });
    const res = await exchangeCode(
      {
        tokenEndpoint: "https://issuer.test/oauth/token",
        code: "code-1",
        redirectUri: "https://hub.test/cb",
        codeVerifier: "verifier-1",
        clientId: "cid",
        now: () => fixedNow,
      },
      fn,
    );
    expect(res.access_token).toBe("at-1");
    expect(res.refresh_token).toBe("rt-1");
    expect(res.expiresAt).toBe(new Date(fixedNow.getTime() + 3600 * 1000).toISOString());
    expect(res.scope).toBe("vault:eng:read");

    // form body assertions
    const body = new URLSearchParams((calls[0]?.init?.body as string) ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code-1");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("redirect_uri")).toBe("https://hub.test/cb");
    expect(body.get("client_id")).toBe("cid");
    expect((calls[0]?.init?.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  test("throws OAuthClientError on an error response", async () => {
    const { fn } = fakeFetch({
      "https://issuer.test/oauth/token": () =>
        json({ error: "invalid_grant", error_description: "code expired" }, 400),
    });
    await expect(
      exchangeCode(
        {
          tokenEndpoint: "https://issuer.test/oauth/token",
          code: "x",
          redirectUri: "https://hub.test/cb",
          codeVerifier: "v",
          clientId: "cid",
        },
        fn,
      ),
    ).rejects.toBeInstanceOf(OAuthClientError);
  });

  test("throws when access_token is missing", async () => {
    const { fn } = fakeFetch({
      "https://issuer.test/oauth/token": () => json({ token_type: "Bearer" }),
    });
    await expect(
      exchangeCode(
        {
          tokenEndpoint: "https://issuer.test/oauth/token",
          code: "x",
          redirectUri: "https://hub.test/cb",
          codeVerifier: "v",
          clientId: "cid",
        },
        fn,
      ),
    ).rejects.toBeInstanceOf(OAuthClientError);
  });
});

describe("refreshToken", () => {
  test("posts grant_type=refresh_token, returns new tokens", async () => {
    const fixedNow = new Date("2026-06-18T12:00:00.000Z");
    const { fn, calls } = fakeFetch({
      "https://issuer.test/oauth/token": () =>
        json({ access_token: "at-2", refresh_token: "rt-2", expires_in: 1800 }),
    });
    const res = await refreshToken(
      {
        tokenEndpoint: "https://issuer.test/oauth/token",
        refreshToken: "rt-1",
        clientId: "cid",
        now: () => fixedNow,
      },
      fn,
    );
    expect(res.access_token).toBe("at-2");
    expect(res.refresh_token).toBe("rt-2");
    expect(res.expiresAt).toBe(new Date(fixedNow.getTime() + 1800 * 1000).toISOString());
    const body = new URLSearchParams((calls[0]?.init?.body as string) ?? "");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("client_id")).toBe("cid");
  });

  test("rejects on a revoked/expired refresh token", async () => {
    const { fn } = fakeFetch({
      "https://issuer.test/oauth/token": () => json({ error: "invalid_grant" }, 400),
    });
    await expect(
      refreshToken(
        { tokenEndpoint: "https://issuer.test/oauth/token", refreshToken: "dead", clientId: "c" },
        fn,
      ),
    ).rejects.toBeInstanceOf(OAuthClientError);
  });
});

// === revokeRemote (best-effort) =============================================

describe("revokeRemote", () => {
  test("posts the revocation form", async () => {
    const { fn, calls } = fakeFetch({
      "https://issuer.test/oauth/revoke": () => new Response(null, { status: 200 }),
    });
    await revokeRemote(
      {
        revocationEndpoint: "https://issuer.test/oauth/revoke",
        refreshToken: "rt-1",
        clientId: "cid",
      },
      fn,
    );
    const body = new URLSearchParams((calls[0]?.init?.body as string) ?? "");
    expect(body.get("token")).toBe("rt-1");
    expect(body.get("token_type_hint")).toBe("refresh_token");
  });

  test("swallows errors (network failure must not throw)", async () => {
    const fn = (async () => {
      throw new Error("network down");
    }) as unknown as FetchFn;
    // Must resolve, not reject.
    await expect(
      revokeRemote(
        {
          revocationEndpoint: "https://issuer.test/oauth/revoke",
          refreshToken: "x",
          clientId: "c",
        },
        fn,
      ),
    ).resolves.toBeUndefined();
  });

  test("swallows a non-2xx response", async () => {
    const { fn } = fakeFetch({
      "https://issuer.test/oauth/revoke": () => new Response("nope", { status: 500 }),
    });
    await expect(
      revokeRemote(
        {
          revocationEndpoint: "https://issuer.test/oauth/revoke",
          refreshToken: "x",
          clientId: "c",
        },
        fn,
      ),
    ).resolves.toBeUndefined();
  });
});

// === fetchWithTimeout =======================================================

describe("fetchWithTimeout", () => {
  test("aborts a hung request after the timeout", async () => {
    // A fetch that never resolves until aborted.
    const fn = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as FetchFn;
    await expect(fetchWithTimeout("https://slow.test", { timeout: 10 }, fn)).rejects.toBeTruthy();
  });

  test("passes through a fast response", async () => {
    const fn = (async () => new Response("ok", { status: 200 })) as unknown as FetchFn;
    const res = await fetchWithTimeout("https://fast.test", { timeout: 1000 }, fn);
    expect(res.status).toBe(200);
  });
});

// === deriveVaultScopeFromMcpUrl (#671) ======================================

describe("deriveVaultScopeFromMcpUrl", () => {
  test("a Parachute vault MCP URL → least-privilege vault:<name>:read", () => {
    expect(deriveVaultScopeFromMcpUrl("https://hub.test/vault/research/mcp")).toBe(
      "vault:research:read",
    );
  });

  test("a trailing slash after /mcp still matches", () => {
    expect(deriveVaultScopeFromMcpUrl("https://hub.test/vault/research/mcp/")).toBe(
      "vault:research:read",
    );
  });

  test("a vault name with dot/dash/underscore is captured", () => {
    expect(deriveVaultScopeFromMcpUrl("https://hub.test/vault/my-team_v2.0/mcp")).toBe(
      "vault:my-team_v2.0:read",
    );
  });

  test("a query string / fragment does not break the match", () => {
    expect(deriveVaultScopeFromMcpUrl("https://hub.test/vault/research/mcp?x=1#frag")).toBe(
      "vault:research:read",
    );
  });

  test("a non-vault MCP URL → null (caller falls back to scopes_supported)", () => {
    expect(deriveVaultScopeFromMcpUrl("https://remote.test/mcp")).toBeNull();
    expect(deriveVaultScopeFromMcpUrl("https://remote.test/some/other/mcp")).toBeNull();
  });

  test("a deeper path after /mcp is NOT a vault MCP (anchored) → null", () => {
    expect(deriveVaultScopeFromMcpUrl("https://hub.test/vault/research/mcp/extra")).toBeNull();
  });

  test("a /vault/ path with no name segment → null", () => {
    expect(deriveVaultScopeFromMcpUrl("https://hub.test/vault//mcp")).toBeNull();
  });

  test("an unparseable URL → null", () => {
    expect(deriveVaultScopeFromMcpUrl("not a url")).toBeNull();
  });
});
