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
    const vaults = await api.listVaults();

    expect(vaults).toEqual([
      {
        name: "work",
        url: "http://hub.local/vault/work/",
        version: "0.5.1",
        path: "/vault/work",
      },
    ]);
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
    const vaults = await api.listVaults();
    expect(vaults[0]?.path).toBe("/vault/scratch");
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

  it("returns [] when the doc has no vaults key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { services: [] })),
    );
    const api = await import("./api.ts");
    expect(await api.listVaults()).toEqual([]);
  });
});

describe("createVault", () => {
  it("sends Bearer + JSON body and returns the parsed result", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        name: "work",
        url: "http://hub.local/vault/work/",
        version: "0.5.1",
        token: "pvt_abc123",
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

    expect(result.token).toBe("pvt_abc123");
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

  it("on 200 idempotent re-POST returns the existing entry without a token", async () => {
    // Server short-circuits when the vault already exists: same name + url +
    // version, but no fresh `token` (we only emit once, on first create).
    // NewVault.tsx must handle the missing-token branch without claiming
    // success-with-banner.
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
    expect(result.token).toBeUndefined();
    expect(result.paths).toBeUndefined();
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
