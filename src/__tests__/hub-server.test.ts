import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_SVC, hubPortPath } from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { findServiceUpstream, findVaultUpstream, hubFetch, layerOf } from "../hub-server.ts";
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

  // hub#158: each vault entry's module.json:managementUrl rides through to
  // the well-known doc. The SPA reads it to decide whether to render a
  // "Manage" link on the row.
  test("/.well-known/parachute.json surfaces managementUrl from the vault module manifest", async () => {
    const h = makeHarness();
    try {
      const entryWithInstallDir: ServiceEntry = { ...vaultEntry("default"), installDir: "/fake" };
      writeManifest({ services: [entryWithInstallDir] }, h.manifestPath);
      const res = await hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        // Stand in for module-manifest.readModuleManifest — production reads
        // <installDir>/.parachute/module.json off disk.
        readModuleManifest: async () => ({
          name: "vault",
          manifestName: "parachute-vault",
          kind: "api",
          port: 1940,
          paths: ["/vault/default"],
          health: "/health",
          managementUrl: "/admin",
        }),
      })(req("/.well-known/parachute.json"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        vaults: Array<{ name: string; managementUrl?: string }>;
      };
      expect(body.vaults).toHaveLength(1);
      expect(body.vaults[0]?.managementUrl).toBe("/admin");
    } finally {
      h.cleanup();
    }
  });

  test("/.well-known/parachute.json omits managementUrl when manifest has none", async () => {
    const h = makeHarness();
    try {
      const entryWithInstallDir: ServiceEntry = { ...vaultEntry("default"), installDir: "/fake" };
      writeManifest({ services: [entryWithInstallDir] }, h.manifestPath);
      const res = await hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        readModuleManifest: async () => null,
      })(req("/.well-known/parachute.json"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { vaults: Array<{ managementUrl?: string }> };
      expect(body.vaults[0]).not.toHaveProperty("managementUrl");
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

  // SPA mount after hub#231: single `/admin/*` mount serves vault
  // provisioning + permissions + tokens. Pre-rename `/vault` and `/hub/*`
  // SPA URLs are 301-redirected; the per-vault content proxy at
  // `/vault/<name>/*` stays where it is.

  test("/admin/vaults serves the SPA shell when the bundle exists", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      mkdirIfMissing(dist);
      writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
      writeManifest({ services: [] }, h.manifestPath);
      const res = await hubFetch(h.dir, { spaDistDir: dist, manifestPath: h.manifestPath })(
        req("/admin/vaults"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("<div id=root>");
    } finally {
      h.cleanup();
    }
  });

  test("/admin/vaults/new serves the SPA shell (client-side route)", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      mkdirIfMissing(dist);
      writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
      writeManifest({ services: [] }, h.manifestPath);
      const res = await hubFetch(h.dir, { spaDistDir: dist, manifestPath: h.manifestPath })(
        req("/admin/vaults/new"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain("<div id=root>");
    } finally {
      h.cleanup();
    }
  });

  test("/admin/permissions serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      mkdirIfMissing(dist);
      writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
      const res = await hubFetch(h.dir, { spaDistDir: dist })(req("/admin/permissions"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    } finally {
      h.cleanup();
    }
  });

  test("/admin/tokens serves the SPA shell", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      mkdirIfMissing(dist);
      writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
      const res = await hubFetch(h.dir, { spaDistDir: dist })(req("/admin/tokens"));
      expect(res.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("/admin/assets/*.js is served with the matching content-type", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      const assets = join(dist, "assets");
      mkdirIfMissing(dist);
      mkdirIfMissing(assets);
      writeFileSync(join(dist, "index.html"), "<!doctype html>");
      writeFileSync(join(assets, "main.js"), "console.log('hi');");
      writeManifest({ services: [] }, h.manifestPath);
      const res = await hubFetch(h.dir, { spaDistDir: dist, manifestPath: h.manifestPath })(
        req("/admin/assets/main.js"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
      expect(await res.text()).toContain("console.log");
    } finally {
      h.cleanup();
    }
  });

  test("/admin/* returns 503 with build hint when dist is missing", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const res = await hubFetch(h.dir, {
        spaDistDir: join(h.dir, "missing"),
        manifestPath: h.manifestPath,
      })(req("/admin/vaults"));
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("bun run build");
    } finally {
      h.cleanup();
    }
  });

  test("/admin/vaults rejects non-GET methods with 405", async () => {
    const h = makeHarness();
    try {
      const dist = join(h.dir, "dist");
      mkdirIfMissing(dist);
      writeFileSync(join(dist, "index.html"), "<!doctype html>");
      const res = await hubFetch(h.dir, { spaDistDir: dist })(
        req("/admin/vaults", { method: "POST" }),
      );
      expect(res.status).toBe(405);
    } finally {
      h.cleanup();
    }
  });

  // 301 back-compat redirects (closes hub#231): pre-rename SPA URLs
  // 301-redirect to the new /admin/* mount. Tests cover every entry in the
  // dispatch — operator bookmarks landing on any of these still work.

  test("301: /vault → /admin/vaults", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/vault"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/vaults");
    } finally {
      h.cleanup();
    }
  });

  test("301: /vault/new → /admin/vaults/new", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/vault/new"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/vaults/new");
    } finally {
      h.cleanup();
    }
  });

  test("301: /vault preserves query string", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/vault?next=foo"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/vaults?next=foo");
    } finally {
      h.cleanup();
    }
  });

  test("301: /hub/vaults → /admin/vaults (chain through the rename)", async () => {
    // The /hub/vaults redirect predates #231 — it used to land at /vault.
    // Now it lands at the final /admin/vaults so old bookmarks don't bounce
    // through two redirects.
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/hub/vaults"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/vaults");
    } finally {
      h.cleanup();
    }
  });

  test("301: /hub/vaults/new → /admin/vaults/new", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/hub/vaults/new"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/vaults/new");
    } finally {
      h.cleanup();
    }
  });

  test("301: /hub/vaults/* preserves the query string", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/hub/vaults/foo?bar=1&baz=2"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/vaults/foo?bar=1&baz=2");
    } finally {
      h.cleanup();
    }
  });

  test("301: /hub/permissions → /admin/permissions", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/hub/permissions"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/permissions");
    } finally {
      h.cleanup();
    }
  });

  test("301: /hub/tokens → /admin/tokens", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/hub/tokens"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/tokens");
    } finally {
      h.cleanup();
    }
  });

  test("301: /hub bare → /admin/vaults", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/hub"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/admin/vaults");
    } finally {
      h.cleanup();
    }
  });

  // Login surface rename redirects (auth-UX cleanup): /admin/login and
  // /admin/logout 301 to /login and /logout. Path-only test — the
  // handlers themselves are exercised through the existing
  // handleAdminLoginGet/Post + handleAdminLogoutPost test files.
  test("301: /admin/login → /login", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/admin/login"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/login");
    } finally {
      h.cleanup();
    }
  });

  test("301: /admin/login preserves the next= query param", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/admin/login?next=/admin/config"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/login?next=/admin/config");
    } finally {
      h.cleanup();
    }
  });

  test("301: /admin/logout → /logout", async () => {
    const h = makeHarness();
    try {
      const res = await hubFetch(h.dir)(req("/admin/logout"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/logout");
    } finally {
      h.cleanup();
    }
  });

  test("/hub/<unknown> (no SPA mount anymore) → 404", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const res = await hubFetch(h.dir, { manifestPath: h.manifestPath })(
        req("/hub/unknown-thing"),
      );
      expect(res.status).toBe(404);
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
        // /login + /logout — canonical names since the auth-UX rename;
        // /admin/login + /admin/logout 301-redirect to here (separate
        // tests pin the redirects themselves).
        ["/login", { method: "POST" }],
        ["/logout", { method: "POST" }],
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

  // #197: a services.json entry written with a trailing slash on the mount
  // path (e.g. `paths: ["/vault/default/"]`) used to only match the exact
  // pathname `/vault/default/` and silently drop every sub-path because
  // `pathname.startsWith("/vault/default//")` is always false. Normalize
  // trailing slashes before comparison so sub-paths route correctly.
  test("trailing-slash mount path matches sub-paths (#197)", () => {
    const trailing: ServiceEntry = {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default/"],
      health: "/vault/default/health",
      version: "0.4.0",
    };
    const exact = findVaultUpstream([trailing], "/vault/default");
    expect(exact?.port).toBe(1940);
    // mount is reported normalized (trailing slash stripped) so callers
    // computing `pathname.slice(match.mount.length)` get the same answer
    // regardless of how the entry was written on disk.
    expect(exact?.mount).toBe("/vault/default");

    const sub = findVaultUpstream([trailing], "/vault/default/notes/abc");
    expect(sub?.port).toBe(1940);
    expect(sub?.mount).toBe("/vault/default");
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

  test("single-segment /vault/<name> picks proxy when registered, 404 when not", async () => {
    // Two cases share one fixture so the contrast is explicit:
    //   - `/vault/default` is registered → proxy answers (200, JSON tag).
    //   - `/vault/nonexistent` has no match → 404 directly (no SPA-shell
    //     fallback under /vault since hub#231 moved the admin SPA to
    //     /admin/*; the /vault/<name>/* slot is now exclusively the
    //     per-vault content proxy).
    // This is the routing-order seam #173 introduced — proxy is consulted
    // before the 404; the SPA fallback that used to live here is gone.
    const h = makeHarness();
    const upstream = startUpstream("default-vault");
    try {
      const dist = join(h.dir, "dist");
      mkdirIfMissing(dist);
      writeFileSync(join(dist, "index.html"), "<!doctype html><div id=root></div>");
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
      const fetcher = hubFetch(h.dir, {
        spaDistDir: dist,
        manifestPath: h.manifestPath,
      });

      const proxied = await fetcher(req("/vault/default"));
      expect(proxied.status).toBe(200);
      expect(proxied.headers.get("content-type")).toContain("application/json");
      const body = (await proxied.json()) as { tag: string; pathname: string };
      expect(body.tag).toBe("default-vault");
      expect(body.pathname).toBe("/vault/default");

      const notFound = await fetcher(req("/vault/nonexistent"));
      expect(notFound.status).toBe(404);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });
});

describe("findServiceUpstream (#182)", () => {
  // Generic longest-prefix match across non-vault services.json entries. Vault
  // entries are filtered out — vault routing is the SPA-fallback-aware path
  // through findVaultUpstream / proxyToVault.

  test("matches a non-vault entry by exact path", () => {
    const services: ServiceEntry[] = [
      {
        name: "scribe",
        port: 1942,
        paths: ["/scribe"],
        health: "/scribe/health",
        version: "0.1.0",
      },
    ];
    const m = findServiceUpstream(services, "/scribe");
    expect(m?.port).toBe(1942);
    expect(m?.mount).toBe("/scribe");
    expect(m?.entry.name).toBe("scribe");
  });

  test("matches a deeper subpath via prefix", () => {
    const services: ServiceEntry[] = [
      {
        name: "agent",
        port: 1943,
        paths: ["/agent"],
        health: "/agent/api/health",
        version: "0.1.0",
      },
    ];
    expect(findServiceUpstream(services, "/agent/api/health")?.port).toBe(1943);
  });

  test("ignores vault entries — those route via findVaultUpstream", () => {
    const services: ServiceEntry[] = [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.0",
      },
    ];
    expect(findServiceUpstream(services, "/vault/default/health")).toBeUndefined();
  });

  test("returns undefined when no service claims the path", () => {
    const services: ServiceEntry[] = [
      {
        name: "scribe",
        port: 1942,
        paths: ["/scribe"],
        health: "/scribe/health",
        version: "0.1.0",
      },
    ];
    expect(findServiceUpstream(services, "/unknown/foo")).toBeUndefined();
  });

  test("longest-prefix wins when multiple paths could match", () => {
    // A service registering `/api` and another (older / catch-all) registering
    // `/` would conflict on every request — longest mount wins so the more
    // specific one takes precedence.
    const services: ServiceEntry[] = [
      { name: "wide", port: 1950, paths: ["/api"], health: "/api/health", version: "0.1.0" },
      {
        name: "deeper",
        port: 1951,
        paths: ["/api/v2"],
        health: "/api/v2/health",
        version: "0.1.0",
      },
    ];
    expect(findServiceUpstream(services, "/api/v2/things")?.port).toBe(1951);
    expect(findServiceUpstream(services, "/api/v1/things")?.port).toBe(1950);
  });

  test("does not match a sibling that shares a prefix without a slash boundary", () => {
    // `/scribe-admin` must NOT match a service mounted at `/scribe`. The
    // boundary check is `pathname === path || pathname.startsWith(path + '/')`.
    const services: ServiceEntry[] = [
      {
        name: "scribe",
        port: 1942,
        paths: ["/scribe"],
        health: "/scribe/health",
        version: "0.1.0",
      },
    ];
    expect(findServiceUpstream(services, "/scribe-admin")).toBeUndefined();
    expect(findServiceUpstream(services, "/scribe-admin/foo")).toBeUndefined();
  });

  // #197: a services.json entry written with a trailing slash on the mount
  // path (e.g. `paths: ["/notes/"]`) used to only match the exact pathname
  // `/notes/` and silently drop every sub-path because
  // `pathname.startsWith("/notes//")` is always false. Notes blank-screen
  // on Aaron's box (2026-05-08) was the operator-visible symptom: the SPA
  // shell loaded but every `/notes/assets/*.js` 404'd. Normalize trailing
  // slashes before comparison.
  test("trailing-slash mount path matches sub-paths (#197)", () => {
    const services: ServiceEntry[] = [
      {
        name: "parachute-notes",
        port: 1942,
        paths: ["/notes/"],
        health: "/notes/health",
        version: "0.1.0",
      },
    ];
    const exact = findServiceUpstream(services, "/notes");
    expect(exact?.port).toBe(1942);
    // mount is reported normalized (trailing slash stripped) so callers
    // computing `pathname.slice(match.mount.length)` (the stripPrefix path)
    // get the same answer regardless of how the entry was written on disk.
    expect(exact?.mount).toBe("/notes");

    const asset = findServiceUpstream(services, "/notes/assets/index-XXX.js");
    expect(asset?.port).toBe(1942);
    expect(asset?.mount).toBe("/notes");
    expect(asset?.entry.name).toBe("parachute-notes");
  });

  test('mount path "/" survives normalization without collapsing to empty string (#197)', () => {
    // Edge case: `"/".replace(/\/+$/, "")` yields the empty string; the
    // `|| "/"` branch keeps it stable so an exact-`/` request still matches.
    // Pre-fix this branch wasn't reachable (legacy `paths: ["/"]` entries
    // are already remapped to `/<shortname>` in-memory by services-manifest;
    // the test pins the lookup-level behavior so a future regression in the
    // remap layer doesn't silently 404 every catchall request).
    //
    // Sub-path matching for `/`-mounted entries is intentionally not asserted
    // here — that would change the existing "exact match only" behavior
    // captured in `pathname === path || pathname.startsWith(path + '/')`,
    // which never matched `/anything` when `path === "/"` (since `"//"` is
    // not a real URL prefix).
    const services: ServiceEntry[] = [
      {
        name: "catchall",
        port: 1950,
        paths: ["/"],
        health: "/health",
        version: "0.1.0",
      },
    ];
    expect(findServiceUpstream(services, "/")?.port).toBe(1950);
    expect(findServiceUpstream(services, "/")?.mount).toBe("/");
  });
});

describe("hubFetch /<svc>/* generic proxy dispatch (#182)", () => {
  // hub#182: services.json-driven dispatch for non-vault modules. Lets
  // `parachute install <svc>` reach the on-box hub at hub:1939/<svc>/* with
  // no per-service codepath. Vault keeps its own routing for the SPA seam.

  function startUpstream(replyTag: string): { port: number; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const u = new URL(req.url);
        const body = req.body ? await req.text() : "";
        return new Response(
          JSON.stringify({
            tag: replyTag,
            method: req.method,
            pathname: u.pathname,
            search: u.search,
            authorization: req.headers.get("authorization") ?? "",
            contentType: req.headers.get("content-type") ?? "",
            body,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    return { port: server.port as number, stop: () => server.stop(true) };
  }

  test("routes /scribe/health to the matching upstream, path preserved", async () => {
    const h = makeHarness();
    const upstream = startUpstream("scribe");
    try {
      writeManifest(
        {
          services: [
            {
              name: "scribe",
              port: upstream.port,
              paths: ["/scribe"],
              health: "/scribe/health",
              version: "0.1.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/scribe/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string; pathname: string };
      expect(body.tag).toBe("scribe");
      // Path-preservation convention: backend sees the full mount-prefixed
      // path, matching `serviceProxyTarget` in commands/expose.ts.
      expect(body.pathname).toBe("/scribe/health");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("routes /notes/sw.js to the matching upstream", async () => {
    // Notes is the canonical path-mount case — the PWA shell has to see the
    // full `/notes/...` path so its service worker registers correctly (the
    // motivator for the `--mount` strip in notes-serve.ts).
    const h = makeHarness();
    const upstream = startUpstream("notes");
    try {
      writeManifest(
        {
          services: [
            {
              name: "notes",
              port: upstream.port,
              paths: ["/notes"],
              health: "/notes/health",
              version: "0.1.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/notes/sw.js"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string; pathname: string };
      expect(body.tag).toBe("notes");
      expect(body.pathname).toBe("/notes/sw.js");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("routes a deep /agent/api/health to the matching upstream", async () => {
    // Agent registers `/agent`; deeper paths route by prefix.
    const h = makeHarness();
    const upstream = startUpstream("agent");
    try {
      writeManifest(
        {
          services: [
            {
              name: "agent",
              port: upstream.port,
              paths: ["/agent"],
              health: "/agent/api/health",
              version: "0.1.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/agent/api/health?probe=1"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string; pathname: string; search: string };
      expect(body.tag).toBe("agent");
      expect(body.pathname).toBe("/agent/api/health");
      expect(body.search).toBe("?probe=1");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("preserves method, multipart body, and Authorization on POSTs", async () => {
    // Scribe-shaped upload: multipart/form-data with a bearer token. Multipart
    // is what real scribe clients send; if the proxy strips the boundary or
    // drops Authorization, scribe rejects the request before transcribing.
    const h = makeHarness();
    const upstream = startUpstream("scribe");
    try {
      writeManifest(
        {
          services: [
            {
              name: "scribe",
              port: upstream.port,
              paths: ["/scribe"],
              health: "/scribe/health",
              version: "0.1.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const form = new FormData();
      form.append("model", "whisper-1");
      form.append("file", new Blob([new Uint8Array([1, 2, 3, 4])]), "audio.wav");
      const res = await fetcher(
        req("/scribe/v1/audio/transcriptions", {
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: form,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        method: string;
        authorization: string;
        contentType: string;
        body: string;
      };
      expect(body.method).toBe("POST");
      expect(body.authorization).toBe("Bearer test-token");
      // Bun's fetch sets the boundary; we just need to confirm the
      // multipart content-type survived.
      expect(body.contentType).toMatch(/^multipart\/form-data;\s*boundary=/);
      // And the body bytes — the boundary marker the upstream echoes back
      // should contain the form fields we sent.
      expect(body.body).toContain('name="model"');
      expect(body.body).toContain("whisper-1");
      expect(body.body).toContain('name="file"');
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("stripPrefix=true forwards the bare path (mount removed)", async () => {
    // The scribe-shaped case from real life: scribe's HTTP routes are
    // `/health`, `/v1/...` — no `/scribe` prefix. When the entry sets
    // stripPrefix:true the hub strips the mount before forwarding so the
    // backend sees `/health` rather than `/scribe/health`. Without this,
    // every proxied scribe request 404s at the backend.
    const h = makeHarness();
    const upstream = startUpstream("scribe");
    try {
      writeManifest(
        {
          services: [
            {
              name: "scribe",
              port: upstream.port,
              paths: ["/scribe"],
              health: "/scribe/health",
              version: "0.1.0",
              stripPrefix: true,
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/scribe/v1/audio/transcriptions?model=whisper-1"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string; pathname: string; search: string };
      expect(body.tag).toBe("scribe");
      // Backend sees the bare path — `/scribe` is stripped.
      expect(body.pathname).toBe("/v1/audio/transcriptions");
      // Query string is always preserved verbatim regardless of stripPrefix.
      expect(body.search).toBe("?model=whisper-1");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("stripPrefix=true: request to bare mount becomes `/`", async () => {
    // Edge case: pathname === mount. Slicing yields the empty string; the
    // proxy normalizes to `/` so the backend sees a valid path.
    const h = makeHarness();
    const upstream = startUpstream("scribe");
    try {
      writeManifest(
        {
          services: [
            {
              name: "scribe",
              port: upstream.port,
              paths: ["/scribe"],
              health: "/health",
              version: "0.1.0",
              stripPrefix: true,
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/scribe"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pathname: string };
      expect(body.pathname).toBe("/");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("stripPrefix absent (default false) preserves the prefix — no behavior change for existing entries", async () => {
    // Migration safety: a services.json entry written before stripPrefix
    // existed (e.g. notes / agent rows already on disk) must continue to
    // forward the full path. The /notes/sw.js test above already exercises
    // this in the happy case; this test makes the absence-of-flag → keep-
    // prefix contract explicit.
    const h = makeHarness();
    const upstream = startUpstream("notes");
    try {
      writeManifest(
        {
          services: [
            {
              name: "notes",
              port: upstream.port,
              paths: ["/notes"],
              health: "/notes/health",
              version: "0.1.0",
              // stripPrefix intentionally omitted — must default to false.
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/notes/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pathname: string };
      expect(body.pathname).toBe("/notes/health");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("stripPrefix=false explicitly preserves the prefix", async () => {
    // The opposite explicit-declaration of the previous test: an operator
    // who writes `stripPrefix: false` in services.json gets the same
    // keep-prefix behavior as omitting the field. Confirms validator round-
    // tripping doesn't lose the explicit-false (separate from the absent
    // case which is checked above).
    const h = makeHarness();
    const upstream = startUpstream("notes");
    try {
      writeManifest(
        {
          services: [
            {
              name: "notes",
              port: upstream.port,
              paths: ["/notes"],
              health: "/notes/health",
              version: "0.1.0",
              stripPrefix: false,
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/notes/sw.js"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pathname: string };
      expect(body.pathname).toBe("/notes/sw.js");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("unknown /<svc>/* path returns 404", async () => {
    const h = makeHarness();
    const upstream = startUpstream("scribe");
    try {
      writeManifest(
        {
          services: [
            {
              name: "scribe",
              port: upstream.port,
              paths: ["/scribe"],
              health: "/scribe/health",
              version: "0.1.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/notinstalled/foo"));
      expect(res.status).toBe(404);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("returns 502 when the matching upstream is unreachable", async () => {
    // Service is in services.json but the port has nothing listening — same
    // shape as the vault-unreachable test, label is the entry's `name`.
    const h = makeHarness();
    try {
      writeManifest(
        {
          services: [
            {
              name: "scribe",
              port: await pickClosedPort(),
              paths: ["/scribe"],
              health: "/scribe/health",
              version: "0.1.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/scribe/health"));
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("scribe upstream unreachable");
    } finally {
      h.cleanup();
    }
  });

  test("/oauth/authorize is hub-handled, never reaches service dispatch", async () => {
    // Even if a (misbehaving) service registers `/oauth`, the hub's own
    // /oauth/* handlers run first by virtue of dispatch ordering. We don't
    // need an explicit denylist — ordering enforces it.
    const h = makeHarness();
    const upstream = startUpstream("malicious");
    try {
      writeManifest(
        {
          services: [
            {
              name: "malicious",
              port: upstream.port,
              paths: ["/oauth"],
              health: "/oauth/health",
              version: "0.0.1",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/oauth/authorize"));
      // Hub's own /oauth/authorize handler responds (likely a redirect or
      // error page rendering) — we just need to verify the upstream was NOT
      // reached, i.e. `tag: "malicious"` is not in the body.
      const text = await res.text();
      expect(text).not.toContain('"tag":"malicious"');
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("/.well-known/parachute.json is hub-handled, never reaches service dispatch", async () => {
    const h = makeHarness();
    const upstream = startUpstream("malicious");
    try {
      writeManifest(
        {
          services: [
            {
              name: "malicious",
              port: upstream.port,
              paths: ["/.well-known"],
              health: "/.well-known/health",
              version: "0.0.1",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/.well-known/parachute.json"));
      expect(res.status).toBe(200);
      // Hub serves the well-known doc as JSON — its body has `vaults`,
      // `services`, etc., not the upstream's `tag` echo.
      const text = await res.text();
      expect(text).not.toContain('"tag":"malicious"');
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("vault entries are NOT routed via the generic dispatch (regression for #144)", async () => {
    // Reach hubFetch with a vault entry but a request shape that the vault
    // block won't match (e.g. no leading `/vault/`). The generic dispatch
    // must skip vault entries — confirming via findServiceUpstream-level
    // unit test isn't enough, we want the integration to stay coherent.
    const h = makeHarness();
    const upstream = startUpstream("vault-default");
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
      // /vault/default/health goes through the vault-specific block and
      // proxies (still works — that's the regression check).
      const vaultRes = await fetcher(req("/vault/default/health"));
      expect(vaultRes.status).toBe(200);
      // /vault/default by itself is the SPA single-segment seam — it does
      // proxy via proxyToVault per the existing behavior.
      // The point of this test is the generic dispatch CANNOT mistakenly
      // match a vault entry. Verify by writing a request that's not under
      // /vault/* and confirming no fallthrough to the vault upstream.
      const elsewhere = await fetcher(req("/totally/not/a/vault"));
      expect(elsewhere.status).toBe(404);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("trailing-slash entry routes sub-paths end-to-end (#197)", async () => {
    // Operator-symptom regression: notes blank-screen on Aaron's box
    // (2026-05-08). services.json had `paths: ["/notes/"]` (trailing slash),
    // which used to make the matcher return undefined for every sub-path
    // because `pathname.startsWith("/notes//")` is always false. Hub
    // returned 404 for `/notes/assets/*.js` even though the SPA shell
    // loaded fine, breaking the page silently.
    const h = makeHarness();
    const upstream = startUpstream("notes");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-notes",
              port: upstream.port,
              paths: ["/notes/"],
              health: "/notes/health",
              version: "0.1.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/notes/assets/index-XXX.js"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string; pathname: string };
      expect(body.tag).toBe("notes");
      // Path is forwarded verbatim — no stripPrefix on the notes entry, so
      // backend sees the full mount-prefixed path.
      expect(body.pathname).toBe("/notes/assets/index-XXX.js");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("FIRST_PARTY_FALLBACKS supplies stripPrefix when entry omits it (#196)", async () => {
    // Operator-symptom regression: scribe `/scribe/health` 404 on Aaron's
    // box (2026-05-08). Scribe v0.4.0 doesn't write `stripPrefix: true` to
    // its services.json entry; the declaration only lives in hub's
    // SCRIBE_FALLBACK manifest. Pre-#187 this didn't matter because the
    // per-service `tailscale serve` plan baked the path into the target
    // URL; post-#187 routing went through hub which wasn't consulting the
    // fallback registry. Result: hub forwarded `/scribe/health` verbatim
    // to scribe at :1943, scribe served bare paths and 404'd. Fix: hub-
    // side fallback merge in `stripPrefixFor`.
    //
    // Use a `parachute-scribe` manifestName so `shortNameForManifest`
    // resolves to "scribe" → SCRIBE_FALLBACK (which declares
    // `stripPrefix: true`). The entry itself omits stripPrefix to mirror
    // what scribe v0.4.0 actually writes today.
    const h = makeHarness();
    const upstream = startUpstream("scribe");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-scribe",
              port: upstream.port,
              paths: ["/scribe"],
              health: "/scribe/health",
              version: "0.4.0",
              // stripPrefix intentionally omitted — must be derived from
              // FIRST_PARTY_FALLBACKS.scribe.manifest.stripPrefix.
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/scribe/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string; pathname: string };
      expect(body.tag).toBe("scribe");
      // The mount prefix is stripped — backend sees the bare `/health`
      // route that scribe v0.4.0 actually serves.
      expect(body.pathname).toBe("/health");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("explicit stripPrefix:false on entry overrides FIRST_PARTY_FALLBACKS (#196)", async () => {
    // Explicit-on-entry must win, even when the fallback would default to
    // stripping. Documents the precedence ordering: explicit > fallback >
    // false. Without this, an operator who deliberately writes
    // `"stripPrefix": false` couldn't opt out of the fallback's strip.
    const h = makeHarness();
    const upstream = startUpstream("scribe");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-scribe",
              port: upstream.port,
              paths: ["/scribe"],
              health: "/scribe/health",
              version: "0.4.0",
              stripPrefix: false,
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/scribe/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pathname: string };
      // Explicit false wins — full path forwarded.
      expect(body.pathname).toBe("/scribe/health");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("third-party service without fallback does not strip (#196)", async () => {
    // Default behavior contract: a service whose manifestName isn't in
    // FIRST_PARTY_FALLBACKS and whose entry omits stripPrefix gets the
    // pre-#196 keep-prefix behavior. No accidental strip on third-party
    // installs.
    const h = makeHarness();
    const upstream = startUpstream("third-party");
    try {
      writeManifest(
        {
          services: [
            {
              name: "third-party-service",
              port: upstream.port,
              paths: ["/third"],
              health: "/third/health",
              version: "0.1.0",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/third/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { pathname: string };
      expect(body.pathname).toBe("/third/health");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });
});

describe("layerOf — classify trust layer from proxy headers", () => {
  // Hub binds 127.0.0.1:1939; only trusted forwarders (cloudflared,
  // tailscaled-serve, tailscaled-funnel) reach the listener. Spoofing isn't
  // a concern. layerOf inspects the headers each forwarder injects.

  test("no proxy headers → loopback (direct localhost call)", () => {
    expect(layerOf(req("/"))).toBe("loopback");
  });

  test("Tailscale-User-Login → tailnet (authed via tailscale serve)", () => {
    // Set verbatim per Tailscale docs / serve.go addTailscaleIdentityHeaders.
    const r = req("/", { headers: { "Tailscale-User-Login": "alice@example.com" } });
    expect(layerOf(r)).toBe("tailnet");
  });

  test("Tailscale-Funnel-Request: ?1 → public (Tailscale Funnel)", () => {
    // Tailscale Funnel sets this header on every funneled connection per
    // serve.go; mutually exclusive with Tailscale-User-Login.
    const r = req("/", { headers: { "Tailscale-Funnel-Request": "?1" } });
    expect(layerOf(r)).toBe("public");
  });

  test("CF-Ray → public (Cloudflare tunnel)", () => {
    const r = req("/", { headers: { "CF-Ray": "abc123-DEN" } });
    expect(layerOf(r)).toBe("public");
  });

  test("CF-Connecting-IP → public (Cloudflare tunnel — alt header shape)", () => {
    const r = req("/", { headers: { "CF-Connecting-IP": "203.0.113.42" } });
    expect(layerOf(r)).toBe("public");
  });

  test("Cloudflare wins over tailscale headers (cloudflared-then-serve hop, defensive)", () => {
    // If a node ran both forwarders chained, the outer-most public layer
    // wins. Defensive — not a recommended deployment shape.
    const r = req("/", {
      headers: { "CF-Ray": "abc", "Tailscale-User-Login": "alice@example.com" },
    });
    expect(layerOf(r)).toBe("public");
  });

  test("Tailscale-Funnel-Request wins over Tailscale-User-Login (defensive)", () => {
    // serve.go can't actually set both — funnel returns early. Defensive.
    const r = req("/", {
      headers: {
        "Tailscale-Funnel-Request": "?1",
        "Tailscale-User-Login": "alice@example.com",
      },
    });
    expect(layerOf(r)).toBe("public");
  });
});

describe("hubFetch publicExposure layer-gate (proxyToService)", () => {
  // The hub's only layer-gate. effectivePublicExposure(entry) === "loopback"
  // → 404 on tailnet/public; pass through on loopback. "allowed" /
  // "auth-required" reach all layers (service does its own auth gate).

  function startUpstream(replyTag: string): { port: number; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(JSON.stringify({ tag: replyTag }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    return { port: server.port as number, stop: () => server.stop(true) };
  }

  test("publicExposure: loopback + tailnet header → 404 (gate hides the route)", async () => {
    const h = makeHarness();
    const upstream = startUpstream("loopback-only");
    try {
      writeManifest(
        {
          services: [
            {
              name: "loopback-only",
              port: upstream.port,
              paths: ["/loopback-only"],
              health: "/loopback-only/health",
              version: "0.1.0",
              publicExposure: "loopback",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const r = req("/loopback-only/anything", {
        headers: { "Tailscale-User-Login": "alice@example.com" },
      });
      const res = await fetcher(r);
      expect(res.status).toBe(404);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("publicExposure: loopback + public header → 404 (gate hides the route)", async () => {
    const h = makeHarness();
    const upstream = startUpstream("loopback-only");
    try {
      writeManifest(
        {
          services: [
            {
              name: "loopback-only",
              port: upstream.port,
              paths: ["/loopback-only"],
              health: "/loopback-only/health",
              version: "0.1.0",
              publicExposure: "loopback",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const r = req("/loopback-only/anything", { headers: { "CF-Ray": "abc123" } });
      const res = await fetcher(r);
      expect(res.status).toBe(404);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("publicExposure: loopback + no headers → reaches upstream (loopback layer)", async () => {
    const h = makeHarness();
    const upstream = startUpstream("loopback-only");
    try {
      writeManifest(
        {
          services: [
            {
              name: "loopback-only",
              port: upstream.port,
              paths: ["/loopback-only"],
              health: "/loopback-only/health",
              version: "0.1.0",
              publicExposure: "loopback",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/loopback-only/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string };
      expect(body.tag).toBe("loopback-only");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("publicExposure: allowed + tailnet header → reaches upstream (no gate)", async () => {
    const h = makeHarness();
    const upstream = startUpstream("allowed");
    try {
      writeManifest(
        {
          services: [
            {
              name: "allowed",
              port: upstream.port,
              paths: ["/allowed"],
              health: "/allowed/health",
              version: "0.1.0",
              publicExposure: "allowed",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const r = req("/allowed/health", {
        headers: { "Tailscale-User-Login": "alice@example.com" },
      });
      const res = await fetcher(r);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string };
      expect(body.tag).toBe("allowed");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("publicExposure: auth-required + public header → reaches upstream (service self-gates)", async () => {
    // The service does its own auth check; the hub passes through.
    const h = makeHarness();
    const upstream = startUpstream("auth-required");
    try {
      writeManifest(
        {
          services: [
            {
              name: "auth-required",
              port: upstream.port,
              paths: ["/auth-required"],
              health: "/auth-required/health",
              version: "0.1.0",
              publicExposure: "auth-required",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const r = req("/auth-required/health", { headers: { "CF-Ray": "abc123" } });
      const res = await fetcher(r);
      expect(res.status).toBe(200);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("scribe (kind=api, hasAuth=false default) → loopback gate fires from public layer", async () => {
    // Spec-derived default for scribe is "auth-required" (NOT loopback —
    // see effectivePublicExposure in service-spec.ts). So the hub passes
    // through; this test confirms the spec-default isn't accidentally
    // loopback-gating well-known services.
    const h = makeHarness();
    const upstream = startUpstream("scribe");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-scribe",
              port: upstream.port,
              paths: ["/scribe"],
              health: "/scribe/health",
              version: "0.1.0",
              // publicExposure absent — exercises spec-derived default
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const r = req("/scribe/health", { headers: { "CF-Ray": "abc123" } });
      const res = await fetcher(r);
      // auth-required → pass through; service does its own gate.
      expect(res.status).toBe(200);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("unknown third-party service (no SERVICE_SPECS row, no publicExposure) → defaults to allowed, reaches public layer", async () => {
    // Third-party modules installed via `module.json` aren't in
    // FIRST_PARTY_FALLBACKS, so effectivePublicExposure has no spec to
    // derive from. The contract documented on effectivePublicExposure is
    // "default to 'allowed'", which means the gate must NOT fire from the
    // public layer for an unknown service that didn't opt into a stricter
    // exposure. Regression-guards anyone tightening the default to
    // "loopback" without realizing it would silently 404 every
    // third-party module on tailnet/public.
    const h = makeHarness();
    const upstream = startUpstream("unknown-thirdparty");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-unknown-thirdparty",
              port: upstream.port,
              paths: ["/parachute-unknown-thirdparty"],
              health: "/parachute-unknown-thirdparty/health",
              version: "0.1.0",
              // publicExposure absent — exercises the unknown-spec default path
              // kind absent — no SERVICE_SPECS / FIRST_PARTY_FALLBACKS row matches
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const r = req("/parachute-unknown-thirdparty/health", {
        headers: { "CF-Ray": "abc123" },
      });
      const res = await fetcher(r);
      // Default "allowed" → no gate. Forwarded to upstream.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string };
      expect(body.tag).toBe("unknown-thirdparty");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });
});

describe("hubFetch publicExposure layer-gate (proxyToVault)", () => {
  // Same gate, applied to /vault/<name>/* dispatch. A vault entry that
  // declares publicExposure: "loopback" is hidden from non-loopback callers.

  function startVaultUpstream(replyTag: string): { port: number; stop: () => void } {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(JSON.stringify({ tag: replyTag }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    return { port: server.port as number, stop: () => server.stop(true) };
  }

  test("vault publicExposure: loopback + tailnet header → 404", async () => {
    const h = makeHarness();
    const upstream = startVaultUpstream("vault-private");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault-private",
              port: upstream.port,
              paths: ["/vault/private"],
              health: "/vault/private/health",
              version: "0.4.0",
              publicExposure: "loopback",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const r = req("/vault/private/health", {
        headers: { "Tailscale-User-Login": "alice@example.com" },
      });
      const res = await fetcher(r);
      expect(res.status).toBe(404);
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("vault publicExposure: loopback + no headers → reaches vault backend", async () => {
    const h = makeHarness();
    const upstream = startVaultUpstream("vault-private");
    try {
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault-private",
              port: upstream.port,
              paths: ["/vault/private"],
              health: "/vault/private/health",
              version: "0.4.0",
              publicExposure: "loopback",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(req("/vault/private/health"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tag: string };
      expect(body.tag).toBe("vault-private");
    } finally {
      upstream.stop();
      h.cleanup();
    }
  });

  test("vault publicExposure: allowed + tailnet header → reaches backend", async () => {
    const h = makeHarness();
    const upstream = startVaultUpstream("vault-public");
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
              publicExposure: "allowed",
            },
          ],
        },
        h.manifestPath,
      );
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const r = req("/vault/default/health", {
        headers: { "Tailscale-User-Login": "alice@example.com" },
      });
      const res = await fetcher(r);
      expect(res.status).toBe(200);
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
