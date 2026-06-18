import { describe, expect, test } from "bun:test";
import { vaultRemove } from "../commands/vault-remove.ts";

const BEARER = "header.payload.signature";

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Fake `fetch` that records each call and returns canned responses in sequence.
 * Lets a test assert method / path / body / auth header without a real socket.
 */
function fakeFetch(responses: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  let i = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    const call: FakeCall = { url, method: init?.method ?? "GET", headers };
    if (typeof init?.body === "string") call.body = init.body;
    calls.push(call);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return new Response(JSON.stringify(r?.body ?? {}), {
      status: r?.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

/** Collect log + error output for assertions. */
function makeSinks() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    log: (l: string) => out.push(l),
    logError: (l: string) => err.push(l),
    text: () => out.join("\n"),
    errText: () => err.join("\n"),
  };
}

/**
 * Spy that fails the test if `Bun.spawn` is ever invoked. The 409 guardrail is
 * "never spawn `parachute-vault`" — this proves it at the runtime boundary, not
 * just by reading the fetch log.
 */
function withSpawnSpy<T>(fn: (spawned: { count: number }) => Promise<T>): Promise<T> {
  const original = Bun.spawn;
  const spawned = { count: 0 };
  // biome-ignore lint/suspicious/noExplicitAny: test-only monkeypatch of Bun.spawn.
  (Bun as any).spawn = (...a: unknown[]) => {
    spawned.count++;
    return (original as unknown as (...args: unknown[]) => unknown)(...a);
  };
  return fn(spawned).finally(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore the original.
    (Bun as any).spawn = original;
  });
}

const SUCCESS_BODY = {
  ok: true,
  name: "scratch",
  cascade: {
    tokens_revoked: 3,
    grants_rewritten: 1,
    grants_dropped: 2,
    user_vaults_removed: 4,
    invites_invalidated: 1,
    connections_torn_down: 1,
    orphaned_channels: [],
    vault_removed: true,
    module_restarted: true,
  },
};

describe("vaultRemove — request shape", () => {
  test("sends DELETE /vaults/<name> with the confirm body + operator bearer", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch"], {
      resolveBearer: async () => BEARER,
      fetch,
      baseUrl: "http://127.0.0.1:1939",
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe("DELETE");
    expect(call?.url).toBe("http://127.0.0.1:1939/vaults/scratch");
    expect(call?.headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ confirm: "scratch" });
  });

  test("URL-encodes the vault name in the path", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    await vaultRemove(["my vault"], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(calls[0]?.url).toContain("/vaults/my%20vault");
    // The confirm body carries the RAW name (matches the endpoint's check).
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ confirm: "my vault" });
  });

  test("--yes is accepted and does not change behaviour (no extra prompt)", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch", "--yes"], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ confirm: "scratch" });
  });
});

describe("vaultRemove — 200 success", () => {
  test("renders the cascade summary and returns 0", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch"], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).toBe(0);
    const text = sinks.text();
    expect(text).toContain("tokens revoked:");
    expect(text).toContain("3");
    expect(text).toContain("user_vaults removed:");
    expect(text).toContain("4");
    expect(text).toContain("vault removed:");
  });

  test("warns about orphaned_channels and prints warnings[]", async () => {
    const body = {
      ok: true,
      name: "scratch",
      cascade: {
        tokens_revoked: 0,
        grants_rewritten: 0,
        grants_dropped: 0,
        user_vaults_removed: 0,
        invites_invalidated: 0,
        connections_torn_down: 0,
        orphaned_channels: ["telegram-main", "sms-alerts"],
        vault_removed: true,
        module_restarted: false,
      },
      warnings: [{ step: "module_restart", detail: "no supervisor available" }],
    };
    const { fetch } = fakeFetch([{ status: 200, body }]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch"], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).toBe(0);
    const text = sinks.text();
    expect(text).toContain("telegram-main");
    expect(text).toContain("sms-alerts");
    expect(text).toContain("agent UI");
    expect(text).toContain("module_restart");
    expect(text).toContain("no supervisor available");
  });
});

describe("vaultRemove — 409 last_vault GUARDRAIL", () => {
  test("returns NON-ZERO and NEVER spawns parachute-vault", async () => {
    await withSpawnSpy(async (spawned) => {
      const { fetch, calls } = fakeFetch([
        {
          status: 409,
          body: {
            error: "last_vault",
            error_description:
              '"scratch" is the last vault on this hub. Create another vault first, or use the CLI.',
          },
        },
      ]);
      const sinks = makeSinks();
      const code = await vaultRemove(["scratch"], {
        resolveBearer: async () => BEARER,
        fetch,
        log: sinks.log,
        logError: sinks.logError,
      });
      // Non-zero exit.
      expect(code).not.toBe(0);
      // Exactly ONE fetch (the DELETE) — no fall-through retry path.
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("DELETE");
      // The load-bearing invariant: no `parachute-vault` spawn.
      expect(spawned.count).toBe(0);
      // Surfaces the endpoint message + the cascade-skip warning on the escape hatch.
      const errText = sinks.errText();
      expect(errText).toContain("last vault");
      expect(errText).toContain("SKIPS the identity cascade");
    });
  });
});

describe("vaultRemove — 404 not_found (idempotent)", () => {
  test("renders a clean 'already removed' message and returns 0", async () => {
    const { fetch } = fakeFetch([
      {
        status: 404,
        body: { error: "not_found", error_description: 'no vault named "ghost" on this hub' },
      },
    ]);
    const sinks = makeSinks();
    const code = await vaultRemove(["ghost"], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).toBe(0);
    const text = sinks.text();
    expect(text.toLowerCase()).toContain("already removed");
    // Not scary — no "error" framing in the error sink.
    expect(sinks.errText()).toBe("");
  });
});

describe("vaultRemove — 400 confirm_mismatch", () => {
  test("passes the hub message through and returns non-zero", async () => {
    const { fetch } = fakeFetch([
      {
        status: 400,
        body: {
          error: "confirm_mismatch",
          error_description: 'deleting a vault requires the body {"confirm": "scratch"}',
        },
      },
    ]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch"], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).not.toBe(0);
    expect(sinks.errText()).toContain('{"confirm": "scratch"}');
  });
});

describe("vaultRemove — arg validation", () => {
  test("missing name → error + non-zero, no fetch", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    const code = await vaultRemove([], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(sinks.errText().toLowerCase()).toContain("vault name is required");
  });

  test("unknown flag → error + non-zero, no fetch", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch", "--force"], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(sinks.errText()).toContain("unknown flag");
  });
});

describe("vaultRemove — missing operator token", () => {
  test("actionable error, no DELETE sent", async () => {
    const { NoOperatorTokenError } = await import("../commands/vault-remove.ts");
    const { fetch, calls } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch"], {
      resolveBearer: async () => {
        throw new NoOperatorTokenError();
      },
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(sinks.errText()).toContain("rotate-operator");
  });

  test("expired operator token → same actionable error, no DELETE sent", async () => {
    const { OperatorTokenExpiredError } = await import("../commands/vault-remove.ts");
    const { fetch, calls } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch"], {
      resolveBearer: async () => {
        // The real error carries its actionable message at the throw site; assert
        // the handler surfaces it verbatim (not a raw 401).
        throw new OperatorTokenExpiredError(
          "operator token expired — run `parachute auth rotate-operator`",
        );
      },
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(sinks.errText()).toContain("rotate-operator");
  });
});

describe("vaultRemove — --hub-origin override", () => {
  test("--hub-origin <url> targets the given hub base", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch", "--hub-origin", "http://127.0.0.1:19390"], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe("http://127.0.0.1:19390/vaults/scratch");
  });

  test("--hub-origin with no URL argument → error, no DELETE sent", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: SUCCESS_BODY }]);
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch", "--hub-origin"], {
      resolveBearer: async () => BEARER,
      fetch,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).not.toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("vaultRemove — hub not running", () => {
  test("ECONNREFUSED on loopback → actionable 'hub must be running', non-zero", async () => {
    const f = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1939");
    }) as unknown as typeof fetch;
    const sinks = makeSinks();
    const code = await vaultRemove(["scratch"], {
      resolveBearer: async () => BEARER,
      fetch: f,
      log: sinks.log,
      logError: sinks.logError,
    });
    expect(code).not.toBe(0);
    const errText = sinks.errText();
    expect(errText).toContain("hub must be running");
    expect(errText).toContain("parachute start");
  });
});
