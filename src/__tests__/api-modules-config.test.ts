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

  test("matches vault and notes (curated modules)", () => {
    expect(parseModulesConfigPath("/api/modules/vault/config")?.short).toBe("vault");
    expect(parseModulesConfigPath("/api/modules/notes/config/schema")?.short).toBe("notes");
  });

  test("rejects unknown short (non-curated)", () => {
    expect(parseModulesConfigPath("/api/modules/unknown/config")).toBeUndefined();
    expect(parseModulesConfigPath("/api/modules/channel/config")).toBeUndefined();
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

describe("handleApiModulesConfig — proxy + mint", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    // Scribe at port 1943 with `/scribe` mount + stripPrefix true (matches
    // FIRST_PARTY_FALLBACKS — verified upstream paths must be the bare
    // `/.parachute/config/schema` shape).
    writeManifest(h.manifestPath, [
      {
        name: "parachute-scribe",
        port: 1943,
        paths: ["/scribe"],
        health: "/health",
        version: "0.4.0",
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
      { short: "notes", suffix: "schema" },
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
