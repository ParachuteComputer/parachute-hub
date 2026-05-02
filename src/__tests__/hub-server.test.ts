import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_SVC, hubPortPath } from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { findVaultUpstream, hubFetch } from "../hub-server.ts";
import { pidPath } from "../process-state.ts";
import { type ServiceEntry, writeManifest } from "../services-manifest.ts";
import { rotateSigningKey } from "../signing-keys.ts";

interface Harness {
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-hub-server-"));
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1/${path.replace(/^\//, "")}`, init);
}

function mkdirIfMissing(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function vaultEntry(name: string): ServiceEntry {
  return {
    name: `parachute-vault-${name}`,
    port: 1940,
    paths: [`/vault/${name}`],
    health: "/health",
    version: "0.4.0",
  };
}

describe("hubFetch routing", () => {
  test("/ serves hub.html with text/html content-type", async () => {
    const h = makeHarness();
    try {
      writeFileSync(join(h.dir, "hub.html"), "<html><body>hi</body></html>");
      const res = await hubFetch(h.dir)(req("/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("<html>");
    } finally {
      h.cleanup();
    }
  });

  test("/hub.html serves the same file as /", async () => {
    const h = makeHarness();
    try {
      writeFileSync(join(h.dir, "hub.html"), "<html>x</html>");
      const res = await hubFetch(h.dir)(req("/hub.html"));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<html>x</html>");
    } finally {
      h.cleanup();
    }
  });

  test("/.well-known/parachute.json builds the doc dynamically from services.json", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [vaultEntry("default")] }, h.manifestPath);
      const res = await hubFetch(h.dir, { manifestPath: h.manifestPath })(
        req("/.well-known/parachute.json"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      const body = (await res.json()) as { vaults: Array<{ name: string; url: string }> };
      expect(body.vaults).toHaveLength(1);
      expect(body.vaults[0]?.name).toBe("default");
    } finally {
      h.cleanup();
    }
  });

  // CORS on the well-known doc: browsers running the Notes UI on
  // http://localhost:1942 fetch this manifest cross-origin to auto-discover
  // the user's vault. Without these headers the browser blocks the response
  // body and the auto-discover flow silently falls back to manual paste.
  // The doc itself is public (no secrets, no PII), so wildcard origin is OK.
  test("/.well-known/parachute.json includes wildcard CORS headers on GET", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const res = await hubFetch(h.dir, { manifestPath: h.manifestPath })(
        req("/.well-known/parachute.json"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /.well-known/parachute.json returns 204 + CORS", async () => {
    const h = makeHarness();
    try {
      // Note: no services.json on disk — preflight must not depend on it.
      const res = await hubFetch(h.dir, { manifestPath: h.manifestPath })(
        req("/.well-known/parachute.json", { method: "OPTIONS" }),
      );
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    } finally {
      h.cleanup();
    }
  });

  // The dispatch from team-lead specifically: a fresh hub install has no
  // expose run yet, but `parachute vault create` writes services.json. The
  // well-known doc must reflect that vault on the *next* GET — no expose,
  // no parachute.json on disk.
  test("/.well-known/parachute.json works on a fresh hub (services.json only, no expose run)", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [vaultEntry("default")] }, h.manifestPath);
      const res = await hubFetch(h.dir, { manifestPath: h.manifestPath })(
        req("/.well-known/parachute.json"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        vaults: Array<{ name: string }>;
        services: Array<{ name: string }>;
      };
      expect(body.vaults.map((v) => v.name)).toEqual(["default"]);
      expect(body.services.map((s) => s.name)).toEqual(["parachute-vault-default"]);
    } finally {
      h.cleanup();
    }
  });

  // The bug this PR fixes: `parachute vault create techne` updates
  // services.json but the old code only re-derived parachute.json on
  // `parachute expose`. With the dynamic build, the second GET reflects
  // the new vault without any other action.
  test("services.json change is reflected on the next GET (no restart, no expose)", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [vaultEntry("default")] }, h.manifestPath);
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });

      const before = (await (await fetcher(req("/.well-known/parachute.json"))).json()) as {
        vaults: Array<{ name: string }>;
      };
      expect(before.vaults.map((v) => v.name)).toEqual(["default"]);

      writeManifest({ services: [vaultEntry("default"), vaultEntry("techne")] }, h.manifestPath);

      const after = (await (await fetcher(req("/.well-known/parachute.json"))).json()) as {
        vaults: Array<{ name: string }>;
      };
      expect(after.vaults.map((v) => v.name)).toEqual(["default", "techne"]);
    } finally {
      h.cleanup();
    }
  });

  test("missing services.json yields an empty doc with CORS, not a 404", async () => {
    // No expose, no `parachute vault create` yet — readManifest returns
    // {services: []}, so the doc is well-formed-but-empty rather than a
    // network-error-looking 404.
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir, { manifestPath: h.manifestPath })(
        req("/.well-known/parachute.json"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(await res.json()).toEqual({ vaults: [], services: [] });
    } finally {
      h.cleanup();
    }
  });

  test("canonicalOrigin uses configured issuer when present", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [vaultEntry("default")] }, h.manifestPath);
      const res = await hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        issuer: "https://hub.example",
      })(req("/.well-known/parachute.json"));
      const body = (await res.json()) as { vaults: Array<{ url: string }> };
      expect(body.vaults[0]?.url).toBe("https://hub.example/vault/default");
    } finally {
      h.cleanup();
    }
  });

  // Same fallback shape as the OAuth handlers: when the hub isn't started
  // with `--issuer` (local dev, direct loopback hit), use the request's own
  // origin so the doc is still self-consistent.
  test("canonicalOrigin falls back to the request origin when no issuer is configured", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [vaultEntry("default")] }, h.manifestPath);
      const res = await hubFetch(h.dir, { manifestPath: h.manifestPath })(
        new Request("http://127.0.0.1:1939/.well-known/parachute.json"),
      );
      const body = (await res.json()) as { vaults: Array<{ url: string }> };
      expect(body.vaults[0]?.url).toBe("http://127.0.0.1:1939/vault/default");
    } finally {
      h.cleanup();
    }
  });

  test("malformed services.json returns 500 + CORS, not a crash", async () => {
    const h = makeHarness();
    try {
      writeFileSync(h.manifestPath, "{ not json");
      const res = await hubFetch(h.dir, { manifestPath: h.manifestPath })(
        req("/.well-known/parachute.json"),
      );
      expect(res.status).toBe(500);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("well-known build failed");
    } finally {
      h.cleanup();
    }
  });

  test("unknown paths return 404", async () => {
    const h = makeHarness();
    try {
      writeFileSync(join(h.dir, "hub.html"), "<html/>");
      const res = await hubFetch(h.dir)(req("/nope"));
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  test("missing hub.html returns 404 rather than crashing", async () => {
    const h = makeHarness();
    try {
      // dir exists but no files in it
      const res = await hubFetch(h.dir)(req("/"));
      expect(res.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  test("/.well-known/jwks.json returns the JWKS from the live db", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const k = rotateSigningKey(db);
        const res = await hubFetch(h.dir, { getDb: () => db })(req("/.well-known/jwks.json"));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("application/json");
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        const body = (await res.json()) as { keys: Array<{ kid: string; alg: string; n: string }> };
        expect(body.keys.length).toBe(1);
        expect(body.keys[0]?.kid).toBe(k.kid);
        expect(body.keys[0]?.alg).toBe("RS256");
        expect(body.keys[0]?.n.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight on /.well-known/jwks.json returns 204 + CORS without touching the db", async () => {
    const h = makeHarness();
    try {
      // Pass a getDb that throws — preflight must not invoke it.
      const res = await hubFetch(h.dir, {
        getDb: () => {
          throw new Error("getDb should not be called for OPTIONS");
        },
      })(req("/.well-known/jwks.json", { method: "OPTIONS" }));
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    } finally {
      h.cleanup();
    }
  });

  test("/.well-known/jwks.json returns 503 + CORS when db is not configured", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/.well-known/jwks.json"));
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      h.cleanup();
    }
  });

  test("/.well-known/jwks.json on an empty db returns {keys: []}", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db })(req("/.well-known/jwks.json"));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ keys: [] });
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("/.well-known/oauth-authorization-server returns RFC 8414 metadata + CORS", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, {
          getDb: () => db,
          issuer: "https://hub.example",
        })(req("/.well-known/oauth-authorization-server"));
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        const body = (await res.json()) as Record<string, unknown>;
        expect(body.issuer).toBe("https://hub.example");
        expect(body.authorization_endpoint).toBe("https://hub.example/oauth/authorize");
        expect(body.code_challenge_methods_supported).toEqual(["S256"]);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("/hub/ serves index.html when the SPA bundle exists", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      writeFileSync(join(h.dir, "hub.html"), "<html>hub</html>");
      mkdirIfMissing(dist);
      writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
      const fetch = hubFetch(h.dir, { spaDistDir: dist });
      const res = await fetch(req("/hub/"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("<div id=root>");
    } finally {
      h.cleanup();
    }
  });

  test("/hub/vaults (client-side route) falls back to index.html", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      mkdirIfMissing(dist);
      writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
      const res = await hubFetch(h.dir, { spaDistDir: dist })(req("/hub/vaults"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("<div id=root>");
    } finally {
      h.cleanup();
    }
  });

  test("/hub/assets/*.js is served with the matching content-type", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      const assets = join(dist, "assets");
      mkdirIfMissing(dist);
      mkdirIfMissing(assets);
      writeFileSync(join(dist, "index.html"), "<!doctype html>");
      writeFileSync(join(assets, "main.js"), "console.log('hi');");
      const res = await hubFetch(h.dir, { spaDistDir: dist })(req("/hub/assets/main.js"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
      expect(await res.text()).toContain("console.log");
    } finally {
      h.cleanup();
    }
  });

  test("/hub/* returns 503 with build hint when dist is missing", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir, { spaDistDir: join(h.dir, "missing") })(req("/hub/"));
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("bun run build");
    } finally {
      h.cleanup();
    }
  });

  test("/hub rejects non-GET methods with 405", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      mkdirIfMissing(dist);
      writeFileSync(join(dist, "index.html"), "<!doctype html>");
      const res = await hubFetch(h.dir, { spaDistDir: dist })(req("/hub/", { method: "POST" }));
      expect(res.status).toBe(405);
    } finally {
      h.cleanup();
    }
  });

  test("/oauth/authorize without configured db returns 503", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/oauth/authorize?client_id=x"));
      expect(res.status).toBe(503);
    } finally {
      h.cleanup();
    }
  });

  test("every DB-dependent route returns 503 when getDb is absent (closes #139)", async () => {
    const h = makeHarness();
    try {
      const fetch = hubFetch(h.dir);
      const cases: Array<[string, RequestInit]> = [
        ["/oauth/token", { method: "POST" }],
        ["/oauth/register", { method: "POST" }],
        ["/oauth/revoke", { method: "POST" }],
        ["/vaults", { method: "POST" }],
        ["/admin/login", { method: "POST" }],
        ["/admin/logout", { method: "POST" }],
        ["/admin/config", { method: "GET" }],
        ["/admin/config/example", { method: "POST" }],
        ["/admin/host-admin-token", { method: "GET" }],
      ];
      for (const [path, init] of cases) {
        const res = await fetch(req(path, init));
        expect(res.status).toBe(503);
      }
    } finally {
      h.cleanup();
    }
  });

  test("/oauth/token rejects non-POST with 405", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, { getDb: () => db })(
          req("/oauth/token", { method: "GET" }),
        );
        expect(res.status).toBe(405);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("/oauth/register accepts POST with JSON body", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        const res = await hubFetch(h.dir, {
          getDb: () => db,
          issuer: "https://hub.example",
        })(
          req("/oauth/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ redirect_uris: ["https://app.example/cb"] }),
          }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as Record<string, unknown>;
        expect(typeof body.client_id).toBe("string");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("live Bun.serve round-trip: / and /.well-known resolve", async () => {
    const h = makeHarness();
    try {
      writeFileSync(join(h.dir, "hub.html"), "<html>live</html>");
      writeManifest({ services: [] }, h.manifestPath);
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: hubFetch(h.dir, { manifestPath: h.manifestPath }),
      });
      try {
        const base = `http://127.0.0.1:${server.port}`;
        const r1 = await fetch(`${base}/`);
        expect(r1.status).toBe(200);
        expect(await r1.text()).toBe("<html>live</html>");
        const r2 = await fetch(`${base}/.well-known/parachute.json`);
        expect(r2.headers.get("content-type")).toBe("application/json");
        expect(await r2.json()).toEqual({ vaults: [], services: [] });
      } finally {
        server.stop(true);
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("findVaultUpstream (#144)", () => {
  test("matches a single-path vault on its exact mount", () => {
    const services: ServiceEntry[] = [vaultEntry("default")];
    const m = findVaultUpstream(services, "/vault/default");
    expect(m?.mount).toBe("/vault/default");
    expect(m?.port).toBe(1940);
  });

  test("matches a vault on any descendant pathname", () => {
    const services: ServiceEntry[] = [vaultEntry("default")];
    expect(findVaultUpstream(services, "/vault/default/health")?.mount).toBe("/vault/default");
    expect(findVaultUpstream(services, "/vault/default/notes/abc")?.mount).toBe("/vault/default");
  });

  test("returns undefined when no vault claims the path", () => {
    const services: ServiceEntry[] = [vaultEntry("default")];
    expect(findVaultUpstream(services, "/vault/missing")).toBeUndefined();
    expect(findVaultUpstream(services, "/vault/missing/health")).toBeUndefined();
    expect(findVaultUpstream(services, "/notes/foo")).toBeUndefined();
  });

  test("non-vault services are ignored even when their path begins with /vault/", () => {
    const odd: ServiceEntry = {
      name: "parachute-vaultkeeper", // not a vault — see isVaultEntry
      port: 9999,
      paths: ["/vault/keeper"],
      health: "/health",
      version: "0.0.1",
    };
    expect(findVaultUpstream([odd], "/vault/keeper")).toBeUndefined();
  });

  test("multi-path single ServiceEntry — both paths route to the same backend", () => {
    // Post-#179/vault#208: one parachute-vault backend hosts every instance,
    // expressed as a single ServiceEntry with multiple paths. The lookup must
    // pick the matching path for each request.
    const multi: ServiceEntry = {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default", "/vault/techne"],
      health: "/vault/default/health",
      version: "0.4.0",
    };
    expect(findVaultUpstream([multi], "/vault/default/notes")?.mount).toBe("/vault/default");
    expect(findVaultUpstream([multi], "/vault/techne/notes")?.mount).toBe("/vault/techne");
    expect(findVaultUpstream([multi], "/vault/other")).toBeUndefined();
  });

  test("longest mount wins on overlapping prefixes", () => {
    // Pathological but representable: a vault claims `/vault` AND another
    // claims `/vault/inner`. Request for `/vault/inner/x` should pick the
    // more specific mount.
    const a: ServiceEntry = {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault"],
      health: "/health",
      version: "0.4.0",
    };
    const b: ServiceEntry = {
      name: "parachute-vault-inner",
      port: 1941,
      paths: ["/vault/inner"],
      health: "/health",
      version: "0.4.0",
    };
    const m = findVaultUpstream([a, b], "/vault/inner/x");
    expect(m?.mount).toBe("/vault/inner");
    expect(m?.port).toBe(1941);
  });
});

describe("hubFetch /vault/<name>/* dynamic proxy (#144)", () => {
  // The bug: tailscale serve config is built once at expose-time, so a vault
  // created later was unreachable on the tailnet (404 from the `/` fallback)
  // until the user re-ran `parachute expose`. The fix puts a single `/vault/`
  // tailscale mount → hub, and hub picks the specific vault per request.
  // These tests verify the hub-side picker works with a real upstream.

  function startUpstream(replyTag: string): { port: number; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const u = new URL(req.url);
        // Echo enough metadata for tests to verify path + method + body
        // arrive intact end-to-end.
        const body = req.body ? await req.text() : "";
        return new Response(
          JSON.stringify({
            tag: replyTag,
            method: req.method,
            pathname: u.pathname,
            search: u.search,
            body,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    // server.port is `number | undefined` in Bun's types, but `Bun.serve()`
    // returns synchronously with the bound port — non-null assertion is safe.
    return { port: server.port as number, stop: () => server.stop(true) };
  }

  test("proxies a /vault/<name>/* request to the matching upstream", async () => {
    const h = makeHarness();
    const upstream = startUpstream("default-vault");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              port: upstream.port,
              paths: ["/vault/default"],
              health: "/vault/default/health",
              version: "0.4.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/vault/default/health?ok=1"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string; pathname: string; search: string };
      expect(body.tag).toBe("default-vault");
      // Path is preserved end-to-end — vault since paraclaw#18 expects requests
      // at `/vault/<name>/...` rather than stripped.
      expect(body.pathname).toBe("/vault/default/health");
      expect(body.search).toBe("?ok=1");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("a freshly-added vault is routable on the very next request, no restart", async () => {
    // The whole reason hub#144 exists: `parachute vault create techne` writes
    // services.json but the user shouldn't need to re-expose to reach the new
    // vault. Read-on-each-request makes this work.
    const h = makeHarness();
    const u1 = startUpstream("default-vault");
    const u2 = startUpstream("techne-vault");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              port: u1.port,
              paths: ["/vault/default"],
              health: "/vault/default/health",
              version: "0.4.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });

      // Before: /vault/techne 404s — no entry yet.
      const before = await fetcher(req("/vault/techne/health"));
      expect(before.status).toBe(404);

      // Simulate `parachute vault create techne` — multi-path single
      // ServiceEntry shape is what vault writes today.
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              port: u2.port,
              paths: ["/vault/default", "/vault/techne"],
              health: "/vault/default/health",
              version: "0.4.0",
            },
          ],
        },
        h.manifestPath,
      );

      // After: same hubFetch instance, no restart, /vault/techne is reachable.
      const after = await fetcher(req("/vault/techne/health"));
      expect(after.status).toBe(200);
      const body = (await after.json()) as { tag: string; pathname: string };
      expect(body.tag).toBe("techne-vault");
      expect(body.pathname).toBe("/vault/techne/health");
    } finally {
      u1.stop();
      u2.stop();
      h.cleanup();
    }
  });

  test("a removed vault returns 404 from the hub on the next request", async () => {
    const h = makeHarness();
    const upstream = startUpstream("default-vault");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              port: upstream.port,
              paths: ["/vault/default"],
              health: "/vault/default/health",
              version: "0.4.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      expect((await fetcher(req("/vault/default/health"))).status).toBe(200);

      // Vault detached — services.json no longer mentions it.
      writeManifest({ services: [] }, h.manifestPath);
      const after = await fetcher(req("/vault/default/health"));
      expect(after.status).toBe(404);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("preserves method + body for POSTs", async () => {
    const h = makeHarness();
    const upstream = startUpstream("default-vault");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              port: upstream.port,
              paths: ["/vault/default"],
              health: "/vault/default/health",
              version: "0.4.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(
        req("/vault/default/notes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "hello" }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { method: string; body: string };
      expect(body.method).toBe("POST");
      expect(JSON.parse(body.body)).toEqual({ content: "hello" });
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("returns 502 when the matching vault upstream is unreachable", async () => {
    // Vault is in services.json but the port has nothing listening — vault
    // crashed, port shifted, or the user is mid-restart. We owe the caller a
    // useful error instead of a hang or a silent 404.
    const h = makeHarness();
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              // Bind a port + immediately release it so the proxy gets ECONNREFUSED.
              port: await pickClosedPort(),
              paths: ["/vault/default"],
              health: "/vault/default/health",
              version: "0.4.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/vault/default/health"));
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("vault upstream unreachable");
    } finally {
      h.cleanup();
    }
  });

  test("non-vault path inside /vault/ namespace falls through to 404", async () => {
    // `/vault/keeper` belongs to no installed service — no longest-prefix
    // match, no proxy attempt, hub answers with the generic 404.
    const h = makeHarness();
    const upstream = startUpstream("default-vault");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              port: upstream.port,
              paths: ["/vault/default"],
              health: "/vault/default/health",
              version: "0.4.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/vault/keeper/health"));
      expect(res.status).toBe(404);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });
});

/** Find a port that no one is listening on by binding briefly and releasing. */
async function pickClosedPort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

const HUB_SERVER_PATH = fileURLToPath(new URL("../hub-server.ts", import.meta.url));

async function pollUntil(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("hub-server.ts startup PID/port registration (#148)", () => {
  test("manual `bun src/hub-server.ts` writes hub.pid and hub.port; SIGTERM clears them", async () => {
    const port = await pickClosedPort();
    const configDir = mkdtempSync(join(tmpdir(), "pcli-hub-startup-"));
    const wellKnownDir = join(configDir, "well-known");
    const dbPath = join(configDir, "hub.db");

    const proc = Bun.spawn(
      [
        process.execPath,
        HUB_SERVER_PATH,
        "--port",
        String(port),
        "--well-known-dir",
        wellKnownDir,
        "--db",
        dbPath,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PARACHUTE_HOME: configDir },
      },
    );
    const pidFile = pidPath(HUB_SVC, configDir);
    const portFile = hubPortPath(configDir);
    try {
      const ready = await pollUntil(() => existsSync(pidFile) && existsSync(portFile));
      expect(ready).toBe(true);
      expect(Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10)).toBe(proc.pid);
      expect(Number.parseInt(readFileSync(portFile, "utf8").trim(), 10)).toBe(port);
      proc.kill("SIGTERM");
      await proc.exited;
      // After SIGTERM the cleanup handler should have rm'd both files —
      // proves manual starts also play nice with `parachute expose` teardown.
      expect(existsSync(pidFile)).toBe(false);
      expect(existsSync(portFile)).toBe(false);
    } finally {
      if (!proc.killed) proc.kill("SIGKILL");
      rmSync(configDir, { recursive: true, force: true });
    }
  }, 10_000);
});
