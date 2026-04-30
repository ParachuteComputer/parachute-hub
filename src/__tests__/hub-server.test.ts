import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
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
