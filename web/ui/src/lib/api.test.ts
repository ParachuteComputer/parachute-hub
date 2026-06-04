/**
 * api.ts unit tests — list + create flows.
 *
 * `listVaults` is anonymous (no Bearer); `createVault` mints + sends one.
 * The mock surface is `fetch` for the wire, plus `./auth.ts` for the
 * mint helper. We don't exercise the real auth flow here — that's
 * covered separately — only that the Bearer makes it onto the request
 * and that 401/403 causes `clearCachedToken` to fire so the next
 * mint attempt redirects to /admin/login.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auth from "./auth.ts";

vi.mock("./auth.ts", () => ({
  getHostAdminToken: vi.fn(),
  clearCachedToken: vi.fn(),
  // Default to a hanging promise so 401 paths in api.ts behave like the
  // real helper (the page is mid-redirect, the continuation never runs).
  // Individual tests stub this differently when they need to assert the
  // redirect side-effect.
  redirectToLoginAndHang: vi.fn(() => new Promise(() => {})),
}));

beforeEach(() => {
  vi.resetModules();
  vi.mocked(auth.getHostAdminToken).mockResolvedValue("test-bearer");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("listVaults", () => {
  it("derives path from services entry when present", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        vaults: [{ name: "work", url: "http://hub.local/vault/work/", version: "0.5.1" }],
        services: [{ name: "parachute-vault-work", path: "/vault/work" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = await import("./api.ts");
    const result = await api.listVaults();

    expect(result.vaults).toEqual([
      {
        name: "work",
        url: "http://hub.local/vault/work/",
        version: "0.5.1",
        path: "/vault/work",
      },
    ]);
    // `parachute-vault-work` matches the canonical vault-entry shape, so
    // the SPA flags the vault module as installed.
    expect(result.moduleInstalled).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/.well-known/parachute.json",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("falls back to URL pathname when services entry is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          vaults: [{ name: "scratch", url: "http://hub.local/vault/scratch", version: "0.5.1" }],
        }),
      ),
    );
    const api = await import("./api.ts");
    const result = await api.listVaults();
    expect(result.vaults[0]?.path).toBe("/vault/scratch");
  });

  it("throws HttpError on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    const api = await import("./api.ts");
    await expect(api.listVaults()).rejects.toMatchObject({
      name: "HttpError",
      status: 503,
    });
  });

  it("returns moduleInstalled=false when no parachute-vault service entries exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { services: [] })),
    );
    const api = await import("./api.ts");
    const result = await api.listVaults();
    expect(result.vaults).toEqual([]);
    expect(result.moduleInstalled).toBe(false);
  });

  it("returns moduleInstalled=true when a parachute-vault entry exists even with zero vaults", async () => {
    // Edge case: vault module is registered but no vault instance has
    // been provisioned yet. The SPA shows the "Create your first vault"
    // CTA, not the "Install vault first" CTA.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          vaults: [],
          services: [{ name: "parachute-vault", path: "/vault" }],
        }),
      ),
    );
    const api = await import("./api.ts");
    const result = await api.listVaults();
    expect(result.vaults).toEqual([]);
    expect(result.moduleInstalled).toBe(true);
  });

  it("ignores non-vault services for moduleInstalled detection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          vaults: [],
          services: [
            { name: "parachute-notes", path: "/notes" },
            { name: "parachute-scribe", path: "/scribe" },
          ],
        }),
      ),
    );
    const api = await import("./api.ts");
    const result = await api.listVaults();
    expect(result.moduleInstalled).toBe(false);
  });

  it("passes managementUrl through when the vault entry declares one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          vaults: [
            {
              name: "work",
              url: "http://hub.local/vault/work/",
              version: "0.5.1",
              managementUrl: "/admin",
            },
          ],
        }),
      ),
    );
    const api = await import("./api.ts");
    const result = await api.listVaults();
    expect(result.vaults[0]?.managementUrl).toBe("/admin");
  });

  it("omits managementUrl when the vault entry doesn't declare one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          vaults: [{ name: "legacy", url: "http://hub.local/vault/legacy/", version: "0.4.0" }],
        }),
      ),
    );
    const api = await import("./api.ts");
    const result = await api.listVaults();
    expect(result.vaults[0]?.managementUrl).toBeUndefined();
  });
});

describe("createVault", () => {
  it("sends Bearer + JSON body and returns the parsed result", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        name: "work",
        url: "http://hub.local/vault/work/",
        version: "0.5.1",
        token: "hubjwt.abc123",
        paths: {
          vault_dir: "/home/u/.parachute/vault/work",
          vault_db: "/home/u/.parachute/vault/work/vault.db",
          vault_config: "/home/u/.parachute/vault/work/config.yaml",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = await import("./api.ts");
    const result = await api.createVault({ name: "work" });

    // 201 → `created: true` is the authoritative create signal.
    expect(result.created).toBe(true);
    expect(result.token).toBe("hubjwt.abc123");
    expect(result.paths?.vault_dir).toContain("/vault/work");
    expect(fetchMock).toHaveBeenCalledWith(
      "/vaults",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-bearer",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ name: "work" }),
      }),
    );
  });

  it("on 200 idempotent re-POST returns the existing entry without a token (created: false)", async () => {
    // Server short-circuits when the vault already exists: same name + url +
    // version, but no fresh `token` (the create-time access token isn't
    // retrievable later). `created: false` is the authoritative signal —
    // NewVault.tsx renders the "already existed" branch off it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          name: "work",
          url: "http://hub.local/vault/work/",
          version: "0.5.1",
        }),
      ),
    );
    const api = await import("./api.ts");
    const result = await api.createVault({ name: "work" });
    expect(result.name).toBe("work");
    expect(result.created).toBe(false);
    expect(result.token).toBeUndefined();
    expect(result.paths).toBeUndefined();
  });

  it("on 201 with an empty token reports created: true + forwards token_guidance", async () => {
    // Post the pvt_* DROP, the vault emits `token: ""` when the bootstrap
    // mint was unavailable (e.g. loopback origin). `created` must come from
    // the HTTP status (201), NOT token truthiness — and the empty token must
    // not survive as a falsy-but-present field. `token_guidance` is forwarded
    // so the UI can explain the gap.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(201, {
          name: "work",
          url: "http://hub.local/vault/work/",
          version: "0.5.1",
          token: "",
          token_guidance: "no hub origin reachable to mint against",
        }),
      ),
    );
    const api = await import("./api.ts");
    const result = await api.createVault({ name: "work" });
    expect(result.created).toBe(true);
    expect(result.token).toBeUndefined();
    expect(result.tokenGuidance).toBe("no hub origin reachable to mint against");
  });

  it("on 401 clears the cached token and throws HttpError(401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthenticated", error_description: "bad" })),
    );
    const api = await import("./api.ts");
    await expect(api.createVault({ name: "x" })).rejects.toMatchObject({
      name: "HttpError",
      status: 401,
    });
    expect(auth.clearCachedToken).toHaveBeenCalled();
  });

  it("surfaces error_description from the body when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(400, {
          error: "invalid_request",
          error_description: '"name" must be a non-empty string',
        }),
      ),
    );
    const api = await import("./api.ts");
    await expect(api.createVault({ name: "" })).rejects.toMatchObject({
      status: 400,
      message: '"name" must be a non-empty string',
    });
  });
});

describe("mintVaultAdminToken", () => {
  it("calls the per-vault mint endpoint with same-origin credentials", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        token: "jwt-abc",
        expires_at: "2026-01-01T00:00:00.000Z",
        scopes: ["vault:work:admin"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = await import("./api.ts");
    const minted = await api.mintVaultAdminToken("work");

    expect(minted).toEqual({
      token: "jwt-abc",
      expiresAt: "2026-01-01T00:00:00.000Z",
      scopes: ["vault:work:admin"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/vault-admin-token/work",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
        headers: expect.objectContaining({ accept: "application/json" }),
      }),
    );
  });

  it("URL-encodes the vault name (defense — server already validates)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        token: "t",
        expires_at: "2026-01-01T00:00:00.000Z",
        scopes: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./api.ts");
    await api.mintVaultAdminToken("with space");
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/vault-admin-token/with%20space",
      expect.anything(),
    );
  });

  it("on 401 calls redirectToLoginAndHang (no error surfaces)", async () => {
    // Same shape as auth.ts:fetchToken — a missing session means the page
    // is about to navigate to /admin/login. Surfacing an HttpError gave
    // operators the raw "no admin session" string with no recourse
    // (PR #173 follow-up bug).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthenticated" })),
    );
    const api = await import("./api.ts");
    const pending = api.mintVaultAdminToken("work");
    // Yield once so the fetch + status branch can run.
    await new Promise((r) => setTimeout(r, 0));
    expect(auth.redirectToLoginAndHang).toHaveBeenCalledTimes(1);
    // The promise never resolves — match the contract callers rely on. Race
    // against a microtask flush so the test doesn't hang.
    const winner = await Promise.race([
      pending.then(() => "resolved"),
      new Promise((r) => setTimeout(() => r("hung"), 10)),
    ]);
    expect(winner).toBe("hung");
  });

  it("throws HttpError on non-401 non-2xx (e.g. 500)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { error: "boom" })),
    );
    const api = await import("./api.ts");
    await expect(api.mintVaultAdminToken("work")).rejects.toMatchObject({
      name: "HttpError",
      status: 500,
    });
  });
});

describe("getVaultUsage", () => {
  // getVaultUsage mints a vault-admin token (admin ⊇ read) then GETs the vault's
  // proxied /.parachute/usage. The mock routes by URL: the mint endpoint returns
  // a token, the usage endpoint returns the footprint report.
  function routedFetch(usage: { status: number; body: unknown }) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/admin/vault-admin-token/")) {
        return jsonResponse(200, {
          token: "vadmin-jwt",
          expires_at: "2026-01-01T00:00:00.000Z",
          scopes: ["vault:work:admin"],
        });
      }
      // Usage request — assert it carried the minted Bearer.
      expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer vadmin-jwt");
      return jsonResponse(usage.status, usage.body);
    });
  }

  it("mints an admin token then parses {counts, bytes} from the proxied endpoint", async () => {
    const fetchMock = routedFetch({
      status: 200,
      body: {
        counts: { notes: 12, attachments: 0, links: 3, tags: 1 },
        bytes: { content: 100, db: 2048, assets: 0, total: 2048 },
        computedAt: "2026-01-01T00:00:00.000Z",
        cached: false,
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./api.ts");
    const usage = await api.getVaultUsage("work");
    expect(usage).toEqual({ notes: 12, totalBytes: 2048 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/vault/work/.parachute/usage",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("throws HttpError when the usage endpoint 403s (caller swallows → '—')", async () => {
    vi.stubGlobal("fetch", routedFetch({ status: 403, body: { error: "forbidden" } }));
    const api = await import("./api.ts");
    await expect(api.getVaultUsage("work")).rejects.toMatchObject({
      name: "HttpError",
      status: 403,
    });
  });

  it("throws HttpError on a malformed usage body", async () => {
    vi.stubGlobal("fetch", routedFetch({ status: 200, body: { counts: {}, bytes: {} } }));
    const api = await import("./api.ts");
    await expect(api.getVaultUsage("work")).rejects.toMatchObject({ name: "HttpError" });
  });
});

describe("formatBytes", () => {
  it("picks the largest sensible unit", async () => {
    const api = await import("./api.ts");
    expect(api.formatBytes(0)).toBe("0 B");
    expect(api.formatBytes(512)).toBe("512 B");
    expect(api.formatBytes(2048)).toBe("2 KB");
    expect(api.formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(api.formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
    expect(api.formatBytes(-1)).toBe("0 B");
  });
});

describe("listGrants", () => {
  it("sends Bearer + parses {grants: [...]} body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        grants: [
          {
            user_id: "u1",
            client_id: "c1",
            client_name: "App A",
            scopes: ["vault:work:read"],
            granted_at: "2026-04-01T12:00:00.000Z",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const api = await import("./api.ts");
    const grants = await api.listGrants();

    expect(grants).toHaveLength(1);
    expect(grants[0]?.client_name).toBe("App A");
    expect(grants[0]?.scopes).toEqual(["vault:work:read"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/grants",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          authorization: "Bearer test-bearer",
          accept: "application/json",
        }),
      }),
    );
  });

  it("appends ?vault=<name> when the option is provided", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { grants: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const api = await import("./api.ts");
    await api.listGrants({ vault: "work space" });

    expect(fetchMock).toHaveBeenCalledWith("/api/grants?vault=work%20space", expect.anything());
  });

  it("returns [] when the body has no grants key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, {})),
    );
    const api = await import("./api.ts");
    expect(await api.listGrants()).toEqual([]);
  });

  it("on 401 clears the cached token and throws HttpError(401)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthenticated" })),
    );
    const api = await import("./api.ts");
    await expect(api.listGrants()).rejects.toMatchObject({
      name: "HttpError",
      status: 401,
    });
    expect(auth.clearCachedToken).toHaveBeenCalled();
  });
});

describe("revokeGrant", () => {
  it("sends DELETE with Bearer and resolves on 204", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const api = await import("./api.ts");
    await api.revokeGrant("client-abc");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/grants/client-abc",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ authorization: "Bearer test-bearer" }),
      }),
    );
  });

  it("URL-encodes the client_id", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("./api.ts");
    await api.revokeGrant("with/slash");
    expect(fetchMock).toHaveBeenCalledWith("/api/grants/with%2Fslash", expect.anything());
  });

  it("throws HttpError on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { error: "not_found" })),
    );
    const api = await import("./api.ts");
    await expect(api.revokeGrant("nope")).rejects.toMatchObject({
      name: "HttpError",
      status: 404,
    });
  });

  it("on 401 clears the cached token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthenticated" })),
    );
    const api = await import("./api.ts");
    await expect(api.revokeGrant("c")).rejects.toMatchObject({ status: 401 });
    expect(auth.clearCachedToken).toHaveBeenCalled();
  });
});

describe("resolveManagementUrl", () => {
  // Note: the manifest validator (`asManagementUrl` in module-manifest.ts)
  // rejects paths that don't start with `/`, so the bare-relative branch
  // inside `resolveManagementUrl` is defensive-only — never exercised by a
  // valid managementUrl reaching the SPA. We don't test that branch here.

  it("joins a leading-slash path onto the vault URL after stripping trailing slash", async () => {
    const api = await import("./api.ts");
    expect(api.resolveManagementUrl("http://hub.local/vault/work/", "/admin")).toBe(
      "http://hub.local/vault/work/admin",
    );
  });

  it("returns absolute http(s) URLs verbatim", async () => {
    const api = await import("./api.ts");
    expect(
      api.resolveManagementUrl("http://hub.local/vault/work/", "https://elsewhere.example/manage"),
    ).toBe("https://elsewhere.example/manage");
  });
});
