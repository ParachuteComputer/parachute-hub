/**
 * auth.ts unit tests — token cache + 401 redirect.
 *
 * The module holds module-scoped state (cached token, in-flight
 * promise). Each test does a dynamic import after `vi.resetModules()`
 * so the cache starts empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getHostAdminToken", () => {
  it("fetches the mint endpoint and caches the result", async () => {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        token: "jwt-1",
        expires_at: expiresAt,
        scopes: ["parachute:host:admin"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth.ts");
    expect(await auth.getHostAdminToken()).toBe("jwt-1");
    // Second call hits the cache, not the wire.
    expect(await auth.getHostAdminToken()).toBe("jwt-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/host-admin-token",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("on 401 calls window.location.replace with /admin/login?next=…", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    const replace = vi.fn();
    vi.stubGlobal("window", {
      location: { pathname: "/vaults/new", search: "?x=1", replace },
    } as unknown as Window & typeof globalThis);

    const auth = await import("./auth.ts");
    // The promise hangs by design — we only need to assert the redirect
    // fired. Race the promise against a microtask flush so the test
    // doesn't hang on the never-resolving Promise.
    void auth.getHostAdminToken();
    await new Promise((r) => setTimeout(r, 0));

    expect(replace).toHaveBeenCalledWith(
      `/admin/login?next=${encodeURIComponent("/vaults/new?x=1")}`,
    );
  });

  it("dedupes concurrent in-flight mint requests", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth.ts");
    const a = auth.getHostAdminToken();
    const b = auth.getHostAdminToken();
    resolveFetch(
      jsonResponse(200, {
        token: "jwt-shared",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        scopes: ["parachute:host:admin"],
      }),
    );
    expect(await a).toBe("jwt-shared");
    expect(await b).toBe("jwt-shared");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches when the cached token is within the refresh buffer of expiry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          token: "jwt-near-expiry",
          // 10s out — well inside the 30s refresh buffer.
          expires_at: new Date(Date.now() + 10_000).toISOString(),
          scopes: ["parachute:host:admin"],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          token: "jwt-fresh",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          scopes: ["parachute:host:admin"],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("./auth.ts");
    expect(await auth.getHostAdminToken()).toBe("jwt-near-expiry");
    expect(await auth.getHostAdminToken()).toBe("jwt-fresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
