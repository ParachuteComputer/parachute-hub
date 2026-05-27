/**
 * Tests for `/api/modules/:short/config[/schema]` — admin-SPA module-config
 * surface (hub#260).
 *
 * Coverage:
 *   - path parser: shape + curated-only
 *   - auth: 401 / 403 / 405 boundary
 *   - module-not-installed → 404 with "module_not_installed" code
 *   - module without config schema (upstream 404) → "no_config_schema"
 *   - mint-and-forward (Option A): SPA bearer dropped, `<short>:admin`
 *     proxy bearer carried upstream; verified by decoding the JWT the
 *     fake upstream receives
 *   - GET schema / GET values / PUT values pass through verbatim
 *   - upstream unreachable → 502
 *   - stripPrefix true (scribe-shape) vs false (notes-shape) → correct
 *     upstream path
 *   - 4xx upstream body forwarded verbatim so SPA can render module's
 *     validation message inline
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import type { CuratedModuleShort } from "../api-modules.ts";
import {
  API_MODULES_CONFIG_REQUIRED_SCOPE,
  MODULE_CONFIG_PROXY_CLIENT_ID,
  handleApiModulesConfig,
  parseModulesConfigPath,
} from "../api-modules-config.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { recordTokenMint, signAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  dir: string;
  manifestPath: string;
  db: ReturnType<typeof openHubDb>;
  userId: string;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-modules-config-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const user = await createUser(db, "owner", "pw");
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    db,
    userId: user.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function mintBearer(h: Harness, scopes: string[]): Promise<string> {
  const signed = await signAccessToken(h.db, {
    sub: h.userId,
    scopes,
    audience: "parachute-hub",
    clientId: "parachute-hub",
    issuer: ISSUER,
    ttlSeconds: 3600,
  });
  recordTokenMint(h.db, {
    jti: signed.jti,
    createdVia: "operator_mint",
    subject: h.userId,
    clientId: "parachute-hub",
    scopes,
    expiresAt: signed.expiresAt,
  });
  return signed.token;
}

function writeManifest(path: string, services: unknown[]): void {
  writeFileSync(path, JSON.stringify({ services }));
}

function makeReq(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  return new Request(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
  });
}

/**
 * Fake upstream fetch: records every call (so tests can assert on the
 * URL, method, and Authorization header forwarded) and returns a
 * canned Response.
 */
function makeFakeUpstream(responder: (url: string, init: RequestInit) => Response): {
  fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  calls: Array<{ url: string; method: string; authorization: string | null; body: string | null }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body: string | null;
  }> = [];
  return {
    fetchFn: async (url, init) => {
      const headers = new Headers(init.headers);
      let body: string | null = null;
      if (init.body && typeof init.body === "string") body = init.body;
      else if (init.body) {
        try {
          // ReadableStream from forwarded req.body — drain via Response
          // for inspectability in tests.
          body = await new Response(init.body as ReadableStream<Uint8Array> | null).text();
        } catch {
          body = null;
        }
      }
      calls.push({
        url,
        method: init.method ?? "GET",
        authorization: headers.get("authorization"),
        body,
      });
      return responder(url, init);
    },
    calls,
  };
}

describe("parseModulesConfigPath", () => {
  test("matches /api/modules/<short>/config", () => {
    expect(parseModulesConfigPath("/api/modules/scribe/config")).toEqual({
      short: "scribe",
      suffix: "",
    });
  });

  test("matches /api/modules/<short>/config/schema", () => {
    expect(parseModulesConfigPath("/api/modules/scribe/config/schema")).toEqual({
      short: "scribe",
      suffix: "schema",
    });
  });

  test("matches vault and scribe (curated modules)", () => {
    expect(parseModulesConfigPath("/api/modules/vault/config")?.short).toBe("vault");
    expect(parseModulesConfigPath("/api/modules/scribe/config/schema")?.short).toBe("scribe");
  });

  test("rejects unknown short (non-curated)", () => {
    expect(parseModulesConfigPath("/api/modules/unknown/config")).toBeUndefined();
    expect(parseModulesConfigPath("/api/modules/channel/config")).toBeUndefined();
    // Curated list trimmed 2026-05-27: notes / runner / surface are no
    // longer curated and reject at the parse boundary.
    expect(parseModulesConfigPath("/api/modules/notes/config")).toBeUndefined();
    expect(parseModulesConfigPath("/api/modules/runner/config")).toBeUndefined();
    expect(parseModulesConfigPath("/api/modules/surface/config")).toBeUndefined();
  });

  test("rejects non-config suffix shapes", () => {
    expect(parseModulesConfigPath("/api/modules/scribe/install")).toBeUndefined();
    expect(parseModulesConfigPath("/api/modules/scribe/config/extra")).toBeUndefined();
    expect(parseModulesConfigPath("/api/modules/scribe")).toBeUndefined();
    expect(parseModulesConfigPath("/api/modules/scribe/")).toBeUndefined();
  });

  test("rejects non-/api/modules prefixes", () => {
    expect(parseModulesConfigPath("/api/auth/tokens")).toBeUndefined();
    expect(parseModulesConfigPath("/admin/modules/scribe/config")).toBeUndefined();
  });
});

describe("handleApiModulesConfig — auth", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("405 on POST", async () => {
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config", { method: "POST" }),
      { short: "scribe", suffix: "" },
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath },
    );
    expect(res.status).toBe(405);
  });

  test("405 on PUT to /schema", async () => {
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config/schema", { method: "PUT" }),
      { short: "scribe", suffix: "schema" },
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath },
    );
    expect(res.status).toBe(405);
  });

  test("401 with no Authorization header", async () => {
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config"),
      { short: "scribe", suffix: "" },
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("403 when bearer lacks parachute:host:admin", async () => {
    const bearer = await mintBearer(h, ["parachute:host:auth"]);
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config", { headers: { authorization: `Bearer ${bearer}` } }),
      { short: "scribe", suffix: "" },
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("insufficient_scope");
    expect(body.error_description).toContain(API_MODULES_CONFIG_REQUIRED_SCOPE);
  });
});

describe("handleApiModulesConfig — module-not-installed", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    // No manifest file written → readManifest returns empty services list.
  });
  afterEach(() => h.cleanup());

  test("404 module_not_installed when scribe absent from services.json", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "scribe", suffix: "schema" },
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("module_not_installed");
  });
});

/**
 * Regression suite for hub#310 — vault / scribe / runner retired their
 * FIRST_PARTY_FALLBACKS entries because each module now self-registers its
 * services.json row at boot (vault#356, scribe#50, runner#3). The contract:
 *
 *   - **services.json has a row** → operations work using its fields
 *     (operator-authoritative).
 *   - **services.json has no row** → `module_not_installed` 404. Hub no
 *     longer falls back to vendored manifest data — pretending a module is
 *     installed when it isn't was the anti-pattern we're retiring.
 *
 * These tests pin both halves of that contract per FALLBACK-retired short
 * (vault / scribe / runner) so a future re-introduction of vendored data
 * would have to explicitly delete them.
 */
describe("handleApiModulesConfig — FALLBACK retirement (hub#310)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("vault not in services.json → 404 module_not_installed (no vendored fallback)", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/vault/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "vault", suffix: "schema" },
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("module_not_installed");
  });

  test("scribe not in services.json → 404 module_not_installed (no vendored fallback)", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "scribe", suffix: "schema" },
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("module_not_installed");
  });

  test("runner not in services.json → 404 module_not_installed (no vendored fallback)", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/runner/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "runner" as CuratedModuleShort, suffix: "schema" },
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("module_not_installed");
  });

  test("vault in services.json with self-registered fields → upstream URL composed from entry", async () => {
    // Self-registered vault row (mirrors what vault#356's `selfRegister` writes):
    // installDir + canonical paths + version + stripPrefix omitted (vault doesn't
    // strip). The config proxy must build `/vault/default/.parachute/config/schema`
    // — vault's per-mount routing requires the prefix.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.8-rc.4",
        installDir: "/parachute/modules/node_modules/@openparachute/vault",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => Response.json({ type: "object", properties: {} }));
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/vault/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "vault", suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(res.status).toBe(200);
    expect(upstream.calls[0]?.url).toBe(
      "http://127.0.0.1:1940/vault/default/.parachute/config/schema",
    );
  });

  test("runner in services.json with self-registered fields → routes to bare /.parachute path", async () => {
    // Self-registered runner row (mirrors what runner#3's `selfRegister` writes):
    // multi-path declaration with `/.parachute` second → hub#307 routes the
    // config proxy to the bare URL regardless of stripPrefix.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-runner",
        port: 1945,
        paths: ["/runner", "/.parachute"],
        health: "/runner/healthz",
        version: "0.1.0-rc.4",
        stripPrefix: false,
        installDir: "/parachute/modules/node_modules/@openparachute/runner",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => Response.json({ type: "object" }));
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/runner/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "runner" as CuratedModuleShort, suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(res.status).toBe(200);
    // Bare path — runner hosts /.parachute at root regardless of stripPrefix.
    expect(upstream.calls[0]?.url).toBe("http://127.0.0.1:1945/.parachute/config/schema");
  });
});

describe("handleApiModulesConfig — proxy + mint", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    // Scribe at port 1943 with `/scribe` mount + `stripPrefix: true`.
    // Post hub#310 (vault/scribe/runner FALLBACK retirement), services.json
    // is the authoritative source for `stripPrefix` — scribe#50 self-
    // registers the flag at boot, so the canonical post-self-register row
    // carries it. Verified upstream paths must be the bare
    // `/.parachute/config[/schema]` shape.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-scribe",
        port: 1943,
        paths: ["/scribe"],
        health: "/health",
        version: "0.4.4-rc.4",
        stripPrefix: true,
      },
    ]);
  });
  afterEach(() => h.cleanup());

  test("GET /schema mints <short>:admin bearer, drops SPA bearer, hits bare path", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() =>
      Response.json({ type: "object", properties: { transcribeProvider: { type: "string" } } }),
    );
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "scribe", suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("object");

    // Exactly one upstream call.
    expect(upstream.calls).toHaveLength(1);
    const call = upstream.calls[0];
    if (!call) throw new Error("upstream not called");

    // Correct URL: scribe is stripPrefix-true, so the upstream sees the
    // bare `/.parachute/config/schema` — no `/scribe` prefix.
    expect(call.url).toBe("http://127.0.0.1:1943/.parachute/config/schema");
    expect(call.method).toBe("GET");

    // Authorization is the minted proxy token, NOT the SPA bearer.
    expect(call.authorization).toBeString();
    expect(call.authorization).not.toBe(`Bearer ${bearer}`);
    const proxyJwt = call.authorization?.replace(/^Bearer /, "") ?? "";
    const claims = decodeJwt(proxyJwt);
    // Per-module scope (`scribe:admin`), per-module audience, correct issuer.
    expect(claims.scope).toBe("scribe:admin");
    expect(claims.aud).toBe("scribe");
    expect(claims.iss).toBe(ISSUER);
    expect(claims.client_id).toBe(MODULE_CONFIG_PROXY_CLIENT_ID);
    expect(claims.sub).toBe(h.userId);
    // Short TTL — exp should be ~60s out from iat. Tolerate small drift.
    if (typeof claims.iat === "number" && typeof claims.exp === "number") {
      expect(claims.exp - claims.iat).toBe(60);
    } else {
      throw new Error("proxy JWT missing iat/exp claims");
    }
  });

  test("GET values returns upstream body verbatim", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() =>
      Response.json({ transcribeProvider: "parakeet-mlx", cleanupProvider: "none" }),
    );
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "scribe", suffix: "" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transcribeProvider: string };
    expect(body.transcribeProvider).toBe("parakeet-mlx");
    // Bare `/.parachute/config` (no /schema).
    expect(upstream.calls[0]?.url).toBe("http://127.0.0.1:1943/.parachute/config");
  });

  test("PUT forwards body + uses PUT method", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() =>
      Response.json({ restart_required: ["transcribeProvider"] }),
    );
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ transcribeProvider: "groq" }),
      }),
      { short: "scribe", suffix: "" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restart_required: string[] };
    expect(body.restart_required).toEqual(["transcribeProvider"]);

    const call = upstream.calls[0];
    if (!call) throw new Error("upstream not called");
    expect(call.method).toBe("PUT");
    expect(call.body).toBe(JSON.stringify({ transcribeProvider: "groq" }));
  });

  test("4xx upstream body forwarded verbatim", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() =>
      Response.json(
        {
          error: "validation_failed",
          message: "transcribeProvider: must be one of [parakeet-mlx, ...]",
          errors: [{ path: "transcribeProvider", message: "invalid enum" }],
        },
        { status: 400 },
      ),
    );
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config", {
        method: "PUT",
        headers: { authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ transcribeProvider: "bogus" }),
      }),
      { short: "scribe", suffix: "" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: unknown[] };
    expect(body.error).toBe("validation_failed");
    expect(body.errors).toBeArrayOfSize(1);
  });

  test("upstream 404 surfaces as no_config_schema (graceful empty-state hint)", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => new Response("not found", { status: 404 }));
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "scribe", suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_config_schema");
  });

  test("upstream unreachable → 502", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => {
      throw new Error("ECONNREFUSED");
    });
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "scribe", suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: async () => {
          // Wrapper to allow capturing the throw cleanly.
          await upstream.fetchFn("http://127.0.0.1:1943/.parachute/config/schema", {});
          throw new Error("unreachable");
        },
      },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("upstream_unreachable");
  });
});

describe("handleApiModulesConfig — stripPrefix=false (notes-shape)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    // Notes is keep-prefix in FIRST_PARTY_FALLBACKS — the upstream URL
    // should preserve the `/notes` mount. (Hub's notes-serve stub doesn't
    // expose .parachute/config/schema today; this test only asserts the
    // proxy URL shape, not the upstream's behavior.)
    writeManifest(h.manifestPath, [
      {
        name: "parachute-notes",
        port: 1941,
        paths: ["/notes"],
        health: "/health",
        version: "0.5.0",
      },
    ]);
  });
  afterEach(() => h.cleanup());

  test("keep-prefix module → upstream path includes the mount", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => Response.json({ type: "object", properties: {} }));
    await handleApiModulesConfig(
      makeReq("/api/modules/notes/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "notes" as CuratedModuleShort, suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(upstream.calls[0]?.url).toBe("http://127.0.0.1:1941/notes/.parachute/config/schema");
  });
});

/**
 * hub#307: modules that declare `/.parachute` in their `paths[]` host the
 * universal protocol endpoints at the bare URL — runner is the first
 * example. Before this fix the proxy built `/runner/.parachute/config`
 * (mount-prefixed because stripPrefix is false) and runner returned 404.
 *
 * The fix detects the `/.parachute` declaration in `paths[]` and routes
 * to the bare URL regardless of `stripPrefix`. These tests pin that
 * behavior + verify vault (mount-routed per-vault) keeps its prefixed
 * path so the fix doesn't regress vault config.
 */
describe("handleApiModulesConfig — hostsBareParachute (hub#307)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  test("runner (stripPrefix:false + /.parachute in paths) → bare /.parachute/config", async () => {
    // Runner's FIRST_PARTY_FALLBACKS shape: paths includes `/.parachute`
    // explicitly because runner serves the universal protocol at the bare
    // URL. The services.json entry can carry either path first; we put
    // `/runner` first to mirror what `parachute install runner` writes
    // (matches the FIRST_PARTY_FALLBACKS manifest paths order).
    writeManifest(h.manifestPath, [
      {
        name: "parachute-runner",
        port: 1945,
        paths: ["/runner", "/.parachute"],
        health: "/runner/healthz",
        version: "0.1.0",
        stripPrefix: false,
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() =>
      Response.json({ type: "object", properties: { intervalSeconds: { type: "number" } } }),
    );
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/runner/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "runner" as CuratedModuleShort, suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(res.status).toBe(200);
    // No /runner prefix — bare /.parachute/config/schema. This is the
    // hub#307 fix: pre-fix the URL was http://127.0.0.1:1945/runner/.parachute/config/schema
    // and runner returned 404.
    expect(upstream.calls[0]?.url).toBe("http://127.0.0.1:1945/.parachute/config/schema");
  });

  test("runner GET /config (no schema) also routes bare", async () => {
    writeManifest(h.manifestPath, [
      {
        name: "parachute-runner",
        port: 1945,
        paths: ["/runner", "/.parachute"],
        health: "/runner/healthz",
        version: "0.1.0",
        stripPrefix: false,
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => Response.json({ intervalSeconds: 60 }));
    await handleApiModulesConfig(
      makeReq("/api/modules/runner/config", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "runner" as CuratedModuleShort, suffix: "" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(upstream.calls[0]?.url).toBe("http://127.0.0.1:1945/.parachute/config");
  });

  test("runner PUT /config also routes bare with body", async () => {
    writeManifest(h.manifestPath, [
      {
        name: "parachute-runner",
        port: 1945,
        paths: ["/runner", "/.parachute"],
        health: "/runner/healthz",
        version: "0.1.0",
        stripPrefix: false,
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => Response.json({ restart_required: [] }));
    await handleApiModulesConfig(
      makeReq("/api/modules/runner/config", {
        method: "PUT",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ intervalSeconds: 120 }),
      }),
      { short: "runner" as CuratedModuleShort, suffix: "" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    const call = upstream.calls[0];
    if (!call) throw new Error("upstream not called");
    expect(call.url).toBe("http://127.0.0.1:1945/.parachute/config");
    expect(call.method).toBe("PUT");
    expect(call.body).toBe(JSON.stringify({ intervalSeconds: 120 }));
  });

  test("runner fallback (no services.json entry) — picks up /.parachute from FIRST_PARTY_FALLBACKS paths", async () => {
    // bun-link / fresh-install case: the runner row isn't in services.json
    // yet but the fallback declares the shape. resolveUpstream returns
    // not-installed when neither the row nor the fallback can prove the
    // module is up — so this case actually 404s. Pinned as the expected
    // shape: hub#307 only changes the upstream-URL math, not the
    // installed-detection contract.
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const res = await handleApiModulesConfig(
      makeReq("/api/modules/runner/config", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "runner" as CuratedModuleShort, suffix: "" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("module_not_installed");
  });

  test("vault (stripPrefix:false, no /.parachute in paths) — keeps /vault/<name> prefix (unchanged)", async () => {
    // Vault's `.parachute/config` is per-vault, scoped under the
    // `/vault/<name>` mount. Routing it bare would lose the vault-name
    // context. This test pins that hub#307 doesn't regress vault.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.5.0",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => Response.json({ type: "object", properties: {} }));
    await handleApiModulesConfig(
      makeReq("/api/modules/vault/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "vault", suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    // Preserved mount — same as pre-hub#307.
    expect(upstream.calls[0]?.url).toBe(
      "http://127.0.0.1:1940/vault/default/.parachute/config/schema",
    );
  });

  test("scribe (stripPrefix:true) — bare URL preserved (unchanged)", async () => {
    // Pre-hub#307: stripPrefix:true produced /.parachute/config (via the
    // stripPrefix branch). Post-fix: same result via the hostsBareParachute
    // branch when /.parachute is in paths, or via the stripPrefix branch
    // when it isn't. Scribe ships `paths: ["/scribe"]` (no /.parachute),
    // so it takes the stripPrefix branch. Either way, the upstream URL is
    // identical to pre-fix behavior.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-scribe",
        port: 1943,
        paths: ["/scribe"],
        health: "/health",
        version: "0.4.0",
        stripPrefix: true,
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => Response.json({ type: "object", properties: {} }));
    await handleApiModulesConfig(
      makeReq("/api/modules/scribe/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "scribe", suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    // Unchanged from pre-hub#307.
    expect(upstream.calls[0]?.url).toBe("http://127.0.0.1:1943/.parachute/config/schema");
  });

  test("mixed: stripPrefix:false module with both /custom and /.parachute → bare for protocol, prefix for others", async () => {
    // The hostsBareParachute branch only governs the `/.parachute/config*`
    // proxy here. Other proxy code-paths (the generic services-proxy in
    // hub-server.ts) handle non-protocol requests; this surface only ever
    // forwards to `/.parachute/config[/schema]`, so verifying just that
    // route is the right scope.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-runner",
        port: 1945,
        // Order doesn't matter for hostsBareParachute detection.
        paths: ["/.parachute", "/runner"],
        health: "/runner/healthz",
        version: "0.1.0",
        stripPrefix: false,
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_CONFIG_REQUIRED_SCOPE]);
    const upstream = makeFakeUpstream(() => Response.json({ type: "object", properties: {} }));
    await handleApiModulesConfig(
      makeReq("/api/modules/runner/config/schema", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { short: "runner" as CuratedModuleShort, suffix: "schema" },
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        upstreamFetch: upstream.fetchFn,
      },
    );
    expect(upstream.calls[0]?.url).toBe("http://127.0.0.1:1945/.parachute/config/schema");
  });
});
