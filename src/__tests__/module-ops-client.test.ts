import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  DEFAULT_HUB_BASE_URL,
  ModuleOpFailedError,
  ModuleOpHttpError,
  NoOperatorTokenError,
  driveModuleOp,
  fetchModuleLogs,
  fetchModuleStates,
  resolveOperatorBearer,
} from "../module-ops-client.ts";
import { issueOperatorToken } from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";
/** 30d TTL so `useOperatorTokenWithAutoRotate` returns the token as-is (no rotation noise). */
const LONG_TTL_S = 30 * 24 * 60 * 60;

interface Harness {
  dir: string;
  db: ReturnType<typeof openHubDb>;
  userId: string;
  cleanup: () => void;
}

/** Harness WITH an operator.token already on disk. */
async function makeHarnessWithToken(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-module-ops-client-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const user = await createUser(db, "owner", "pw");
  await issueOperatorToken(db, user.id, { dir, issuer: ISSUER, ttlSeconds: LONG_TTL_S });
  return {
    dir,
    db,
    userId: user.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Harness WITHOUT any operator.token on disk. */
async function makeHarnessNoToken(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-module-ops-client-notok-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const user = await createUser(db, "owner", "pw");
  return {
    dir,
    db,
    userId: user.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Build a fake `fetch` that records every call and returns canned responses
 * in sequence (one per call). The recorded calls let tests assert the bearer
 * header + URL without a real socket.
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

describe("resolveOperatorBearer", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  test("reads operator.token from disk and returns it as the bearer", async () => {
    h = await makeHarnessWithToken();
    const bearer = await resolveOperatorBearer({ db: h.db, issuer: ISSUER, configDir: h.dir });
    expect(typeof bearer).toBe("string");
    expect(bearer.length).toBeGreaterThan(0);
    // It's a JWT (three dot-separated segments).
    expect(bearer.split(".")).toHaveLength(3);
  });

  test("no operator.token on disk → actionable NoOperatorTokenError", async () => {
    h = await makeHarnessNoToken();
    let err: unknown;
    try {
      await resolveOperatorBearer({ db: h.db, issuer: ISSUER, configDir: h.dir });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoOperatorTokenError);
    expect((err as Error).message).toContain("no operator token");
    expect((err as Error).message).toContain("parachute auth rotate-operator");
  });
});

describe("driveModuleOp — auth + transport", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  test("presents the operator token as Authorization: Bearer to the module-op endpoint", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f, calls } = fakeFetch([
      { status: 200, body: { short: "vault", state: { status: "running" } } },
    ]);
    const res = await driveModuleOp("vault", "start", {
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${DEFAULT_HUB_BASE_URL}/api/modules/vault/start`);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.authorization).toMatch(/^Bearer \S+\.\S+\.\S+$/);
  });

  test("honors an injected baseUrl", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f, calls } = fakeFetch([{ status: 200, body: { stopped: true } }]);
    await driveModuleOp("scribe", "stop", {
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      baseUrl: "http://127.0.0.1:1955/",
      fetch: f,
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:1955/api/modules/scribe/stop");
  });

  test("no operator token → NoOperatorTokenError before any fetch", async () => {
    h = await makeHarnessNoToken();
    const { fetch: f, calls } = fakeFetch([{ status: 200, body: {} }]);
    let err: unknown;
    try {
      await driveModuleOp("vault", "start", {
        db: h.db,
        issuer: ISSUER,
        configDir: h.dir,
        fetch: f,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoOperatorTokenError);
    // Never hit the network — the token gate fails first.
    expect(calls).toHaveLength(0);
  });

  test("non-2xx hub response → ModuleOpHttpError carrying status + code", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f } = fakeFetch([
      {
        status: 400,
        body: { error: "not_installed", error_description: "vault is not installed" },
      },
    ]);
    let err: unknown;
    try {
      await driveModuleOp("vault", "start", {
        db: h.db,
        issuer: ISSUER,
        configDir: h.dir,
        fetch: f,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModuleOpHttpError);
    expect((err as ModuleOpHttpError).status).toBe(400);
    expect((err as ModuleOpHttpError).code).toBe("not_installed");
  });

  test("sync op (start) returns the hub body as-is — no operation poll", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f, calls } = fakeFetch([
      { status: 200, body: { short: "vault", state: { status: "running" } } },
    ]);
    const res = await driveModuleOp("vault", "start", {
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
    });
    expect(res.operationId).toBeUndefined();
    expect(res.body).toEqual({ short: "vault", state: { status: "running" } });
    // Exactly one HTTP call — the POST; no follow-up GET poll.
    expect(calls).toHaveLength(1);
  });
});

describe("driveModuleOp — async operation polling", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  test("202 + operation_id → polls GET /operations/:id to a succeeded terminal", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f, calls } = fakeFetch([
      { status: 202, body: { operation_id: "op-123" } },
      { status: 200, body: { id: "op-123", status: "running" } },
      { status: 200, body: { id: "op-123", status: "succeeded" } },
    ]);
    const res = await driveModuleOp("vault", "install", {
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
      sleep: async () => {},
    });
    expect(res.operationId).toBe("op-123");
    expect((res.body as { status: string }).status).toBe("succeeded");
    // POST + two polls.
    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toBe(`${DEFAULT_HUB_BASE_URL}/api/modules/operations/op-123`);
    expect(calls[1]?.method).toBe("GET");
    // Polls also present the bearer.
    expect(calls[1]?.headers.authorization).toMatch(/^Bearer /);
  });

  test("operation reaches failed → ModuleOpFailedError carrying the op error", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f } = fakeFetch([
      { status: 202, body: { operation_id: "op-x" } },
      { status: 200, body: { id: "op-x", status: "failed", error: "bun add -g exited 1" } },
    ]);
    let err: unknown;
    try {
      await driveModuleOp("vault", "install", {
        db: h.db,
        issuer: ISSUER,
        configDir: h.dir,
        fetch: f,
        sleep: async () => {},
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModuleOpFailedError);
    expect((err as Error).message).toBe("bun add -g exited 1");
  });

  test("poll timeout: a never-succeeding op rejects with ModuleOpFailedError (no silent 2min hang)", async () => {
    h = await makeHarnessWithToken();
    // POST returns 202 + operation_id; every GET poll returns an in-progress
    // op that never reaches `succeeded`. fakeFetch clamps the index to the
    // last response, so all polls past the first see "running".
    const { fetch: f } = fakeFetch([
      { status: 202, body: { operation_id: "op-x" } },
      { status: 200, body: { id: "op-x", status: "running" } },
    ]);
    // Clock seam: each call jumps 1s. With a 50ms timeout the deadline is
    // (first-now + 50), and the second `now()` (the in-loop deadline check)
    // is already 1s past it — so the loop bails before sleeping again.
    let t = 0;
    const now = () => {
      const d = new Date(t);
      t += 1_000;
      return d;
    };
    let err: unknown;
    try {
      await driveModuleOp("vault", "install", {
        db: h.db,
        issuer: ISSUER,
        configDir: h.dir,
        fetch: f,
        sleep: async () => {},
        now,
        pollTimeoutMs: 50,
        pollIntervalMs: 10,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModuleOpFailedError);
    expect((err as Error).message).toContain("did not complete within");
    expect((err as Error).message).toContain("op-x");
  });

  test("passes an optional JSON body through on the POST", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f, calls } = fakeFetch([
      { status: 202, body: { operation_id: "op-1" } },
      { status: 200, body: { id: "op-1", status: "succeeded" } },
    ]);
    await driveModuleOp("vault", "install", {
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
      sleep: async () => {},
      body: { channel: "rc" },
    });
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ channel: "rc" });
  });
});

describe("fetchModuleLogs", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  test("GETs the /logs endpoint with the operator bearer and returns lines + text", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f, calls } = fakeFetch([
      {
        status: 200,
        body: {
          short: "vault",
          lines: ["[vault] booting\n", "[vault] ready\n"],
          text: "[vault] booting\n[vault] ready\n",
        },
      },
    ]);
    const result = await fetchModuleLogs("vault", {
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
    });

    // Hit the right URL with a GET + Bearer.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${DEFAULT_HUB_BASE_URL}/api/modules/vault/logs`);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.authorization).toMatch(/^Bearer /);

    expect(result.short).toBe("vault");
    expect(result.lines).toEqual(["[vault] booting\n", "[vault] ready\n"]);
    expect(result.text).toBe("[vault] booting\n[vault] ready\n");
  });

  test("no operator token → NoOperatorTokenError before any fetch", async () => {
    h = await makeHarnessNoToken();
    const { fetch: f, calls } = fakeFetch([{ status: 200, body: { lines: [] } }]);
    let err: unknown;
    try {
      await fetchModuleLogs("vault", { db: h.db, issuer: ISSUER, configDir: h.dir, fetch: f });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoOperatorTokenError);
    expect(calls).toHaveLength(0);
  });

  test("non-2xx (not_supervised) → ModuleOpHttpError carrying status + code", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f } = fakeFetch([
      {
        status: 404,
        body: { error: "not_supervised", error_description: "vault is not currently supervised" },
      },
    ]);
    let err: unknown;
    try {
      await fetchModuleLogs("vault", { db: h.db, issuer: ISSUER, configDir: h.dir, fetch: f });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModuleOpHttpError);
    expect((err as ModuleOpHttpError).status).toBe(404);
    expect((err as ModuleOpHttpError).code).toBe("not_supervised");
  });

  test("falls back to joining lines when the body omits text", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f } = fakeFetch([
      { status: 200, body: { short: "scribe", lines: ["a\n", "b\n"] } },
    ]);
    const result = await fetchModuleLogs("scribe", {
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
    });
    expect(result.text).toBe("a\nb\n");
  });
});

describe("fetchModuleStates", () => {
  let h: Harness;
  afterEach(() => h.cleanup());

  test("GETs /api/modules with the operator bearer and parses the supervisor fields", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f, calls } = fakeFetch([
      {
        status: 200,
        body: {
          supervisor_available: true,
          modules: [
            {
              short: "vault",
              installed: true,
              installed_version: "0.6.2",
              supervisor_status: "running",
              pid: 4242,
              supervisor_start_error: null,
            },
            {
              short: "scribe",
              installed: false,
              installed_version: null,
              supervisor_status: null,
              pid: null,
              supervisor_start_error: {
                error_type: "missing_dependency",
                binary: "scribe",
              },
            },
          ],
        },
      },
    ]);
    const result = await fetchModuleStates({
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
    });

    // Hits GET /api/modules with a Bearer.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${DEFAULT_HUB_BASE_URL}/api/modules`);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.authorization).toMatch(/^Bearer /);

    expect(result.supervisorAvailable).toBe(true);
    expect(result.modules).toHaveLength(2);
    const vault = result.modules.find((m) => m.short === "vault");
    expect(vault?.supervisor_status).toBe("running");
    expect(vault?.pid).toBe(4242);
    const scribe = result.modules.find((m) => m.short === "scribe");
    expect(scribe?.supervisor_status).toBeNull();
    expect((scribe?.supervisor_start_error as { binary?: string } | null)?.binary).toBe("scribe");
  });

  test("parses the `supervised` array — non-curated modules' run-state (hub#539)", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f } = fakeFetch([
      {
        status: 200,
        body: {
          supervisor_available: true,
          modules: [], // curated catalog can omit a running module (e.g. surface)…
          supervised: [
            {
              short: "surface",
              installed: true,
              installed_version: null,
              supervisor_status: "running",
              pid: 8739,
              supervisor_start_error: null,
            },
          ],
        },
      },
    ]);
    const result = await fetchModuleStates({
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
    });
    expect(result.supervised).toHaveLength(1);
    const surf = result.supervised?.find((m) => m.short === "surface");
    expect(surf?.supervisor_status).toBe("running");
    expect(surf?.pid).toBe(8739);
  });

  test("omitted `supervised` (older hub) parses to [] — hub#539 forward-compat", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f } = fakeFetch([
      { status: 200, body: { supervisor_available: true, modules: [] } },
    ]);
    const result = await fetchModuleStates({
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
    });
    expect(result.supervised).toEqual([]);
  });

  test("no operator token → NoOperatorTokenError before any fetch", async () => {
    h = await makeHarnessNoToken();
    const { fetch: f, calls } = fakeFetch([{ status: 200, body: { modules: [] } }]);
    let err: unknown;
    try {
      await fetchModuleStates({ db: h.db, issuer: ISSUER, configDir: h.dir, fetch: f });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NoOperatorTokenError);
    expect(calls).toHaveLength(0);
  });

  test("non-2xx → ModuleOpHttpError (so the status caller can degrade)", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f } = fakeFetch([
      { status: 403, body: { error: "insufficient_scope", error_description: "lacks scope" } },
    ]);
    let err: unknown;
    try {
      await fetchModuleStates({ db: h.db, issuer: ISSUER, configDir: h.dir, fetch: f });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ModuleOpHttpError);
    expect((err as ModuleOpHttpError).status).toBe(403);
  });

  test("malformed body (no modules array) → empty modules, not a throw", async () => {
    h = await makeHarnessWithToken();
    const { fetch: f } = fakeFetch([{ status: 200, body: { supervisor_available: false } }]);
    const result = await fetchModuleStates({
      db: h.db,
      issuer: ISSUER,
      configDir: h.dir,
      fetch: f,
    });
    expect(result.supervisorAvailable).toBe(false);
    expect(result.modules).toEqual([]);
  });

  test("wedged hub (fetch never resolves) → bounded timeout degrades, no hang", async () => {
    h = await makeHarnessWithToken();
    // A hub that accepts the connection but never answers: the fetch settles ONLY
    // when its AbortSignal fires. With a short injected ceiling, fetchModuleStates
    // must reject within the bound (degrade) rather than hang forever.
    let signalRef: AbortSignal | undefined;
    const neverResolving = ((_input: string | URL | Request, init?: RequestInit) => {
      signalRef = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        // Honor the abort signal the bounded fetch wires in — that's what frees us.
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    let err: unknown;
    try {
      await fetchModuleStates({
        db: h.db,
        issuer: ISSUER,
        configDir: h.dir,
        fetch: neverResolving,
        statesFetchTimeoutMs: 25, // short injected ceiling — no real wall-clock wait
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;

    // The bounded fetch passed an AbortSignal through to our stub.
    expect(signalRef).toBeInstanceOf(AbortSignal);
    // Resolved within the bound (generous slack for runner jitter), did not hang.
    expect(elapsed).toBeLessThan(2_000);
    // Degrades through the SAME ModuleOpHttpError path the status caller already
    // catches → "couldn't read live module state (…)" note + exit 0, never a hang.
    expect(err).toBeInstanceOf(ModuleOpHttpError);
    expect((err as ModuleOpHttpError).code).toBe("request_timeout");
    expect((err as Error).message).toContain("timed out");
  });
});
