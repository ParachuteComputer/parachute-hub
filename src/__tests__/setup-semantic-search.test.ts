/**
 * The setup wizard's semantic-search opt-in (hub#966) — the vault-facing half.
 *
 * `enableSemanticSearch` PUTs the vault's embeddings toggle and restarts vault
 * when the running process needs it. What these tests pin: it talks to the
 * vault's own admin endpoint with the minted Bearer, restarts only when the
 * vault says so, and NEVER throws — every failure is a message telling the
 * operator how to finish by hand, because semantic search must not fail setup.
 */

import { describe, expect, test } from "bun:test";
import { enableSemanticSearch, parseSemanticSearchField } from "../setup-semantic-search.ts";

function snapshot(over: Record<string, unknown> = {}): Response {
  return Response.json({
    enabled: true,
    env_override: null,
    env_forced: false,
    effective: true,
    active: false,
    restart_required: true,
    model_download_mb: 34,
    ...over,
  });
}

function harness(responder: () => Promise<Response> | Response, restartResult?: string) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let restarts = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return responder();
  }) as typeof fetch;
  return {
    calls,
    restarts: () => restarts,
    args: {
      vaultName: "default",
      vaultPort: 1940,
      bearerToken: "tok-admin",
      fetcher,
      retryDelayMs: 0,
      restartVault: async () => {
        restarts++;
        return restartResult;
      },
    },
  };
}

describe("enableSemanticSearch", () => {
  test("PUTs {enabled:true} to the vault's embeddings endpoint with the admin Bearer", async () => {
    const h = harness(() => snapshot());
    await enableSemanticSearch(h.args);
    expect(h.calls.length).toBe(1);
    const call = h.calls[0];
    expect(call?.url).toBe("http://127.0.0.1:1940/vault/default/.parachute/embeddings");
    expect(call?.init?.method).toBe("PUT");
    expect(JSON.parse(String(call?.init?.body))).toEqual({ enabled: true });
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok-admin");
  });

  test("restart_required → restarts vault once and reports on", async () => {
    const h = harness(() => snapshot({ restart_required: true }));
    const r = await enableSemanticSearch(h.args);
    expect(h.restarts()).toBe(1);
    expect(r).toMatchObject({ ok: true, restarted: true });
    expect(r.message).toMatch(/semantic search on/);
  });

  test("already active → no restart", async () => {
    const h = harness(() => snapshot({ active: true, restart_required: false }));
    const r = await enableSemanticSearch(h.args);
    expect(h.restarts()).toBe(0);
    expect(r).toMatchObject({ ok: true, restarted: false });
  });

  test("env var forcing it off → no pointless restart, says why", async () => {
    const h = harness(() =>
      snapshot({
        env_override: false,
        env_forced: true,
        effective: false,
        restart_required: false,
      }),
    );
    const r = await enableSemanticSearch(h.args);
    expect(h.restarts()).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("EMBEDDINGS_ENABLED");
  });

  test("a failed restart keeps the saved setting and says how to apply it", async () => {
    const h = harness(() => snapshot(), "vault is not currently supervised");
    const r = await enableSemanticSearch(h.args);
    expect(r).toMatchObject({ ok: false, restarted: false });
    expect(r.message).toContain("saved");
    expect(r.message).toContain("parachute restart vault");
  });

  test("a throwing restart is caught, not propagated", async () => {
    const h = harness(() => snapshot());
    const r = await enableSemanticSearch({
      ...h.args,
      restartVault: async () => {
        throw new Error("boom");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("boom");
  });

  test("403 from vault → no restart, manual hint", async () => {
    const h = harness(() =>
      Response.json({ error: "Forbidden", message: "needs vault:admin" }, { status: 403 }),
    );
    const r = await enableSemanticSearch(h.args);
    expect(h.restarts()).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("403");
    expect(r.message).toContain("Semantic search page");
  });

  test("404 (vault older than 0.7.3) names the version floor", async () => {
    const h = harness(() => new Response("not found", { status: 404 }));
    const r = await enableSemanticSearch(h.args);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("0.7.3");
  });

  test("connection refused retries (vault still booting), then gives up without throwing", async () => {
    const h = harness(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:1940");
    });
    const r = await enableSemanticSearch(h.args);
    expect(h.calls.length).toBe(5);
    expect(h.restarts()).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("couldn't reach the vault");
  });

  test("connection refused once, then up → succeeds", async () => {
    let n = 0;
    const h = harness(() => {
      n++;
      if (n === 1) throw new Error("ECONNREFUSED");
      return snapshot();
    });
    const r = await enableSemanticSearch(h.args);
    expect(h.calls.length).toBe(2);
    expect(r.ok).toBe(true);
  });
});

describe("parseSemanticSearchField", () => {
  test("browser checkbox value and CLI JSON boolean both read as on", () => {
    expect(parseSemanticSearchField("on")).toBe(true);
    expect(parseSemanticSearchField("true")).toBe(true);
  });
  test("absent / false / junk is off — the opt-in never turns itself on", () => {
    expect(parseSemanticSearchField(null)).toBe(false);
    expect(parseSemanticSearchField("")).toBe(false);
    expect(parseSemanticSearchField("false")).toBe(false);
    expect(parseSemanticSearchField("off")).toBe(false);
    expect(parseSemanticSearchField("maybe")).toBe(false);
  });
});
