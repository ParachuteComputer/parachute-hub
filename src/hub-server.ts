#!/usr/bin/env bun

/**
 * Localhost HTTP backing for the hub page.
 *
 * macOS `tailscaled` runs sandboxed and cannot read files under arbitrary
 * user paths — `tailscale serve … --set-path=/ <file>` returns "an error
 * occurred reading the file or directory". The reliable shape is HTTP proxy:
 * `tailscale serve … --set-path=/ http://127.0.0.1:<port>`. This shim is
 * that localhost backing.
 *
 * Routes (all bound to 127.0.0.1):
 *   /                                         → hub.html
 *   /hub.html                                 → hub.html
 *   /.well-known/parachute.json               → built dynamically from services.json
 *   /.well-known/jwks.json                    → JWKS from hub.db
 *   /.well-known/oauth-authorization-server   → RFC 8414 metadata (issuer, endpoints)
 *   /oauth/authorize  (GET + POST)            → login → consent → auth code
 *   /oauth/token      (POST)                  → authorization_code + refresh_token grants
 *   /oauth/register   (POST)                  → RFC 7591 dynamic client registration
 *   anything else                             → 404
 *
 * Invoked as:
 *   bun <this-file> --port <n> --well-known-dir <path> [--db <path>] [--issuer <url>]
 *
 * `--well-known-dir` is the directory containing `hub.html` (written by
 * `parachute expose`). The well-known doc is no longer served from this
 * directory — it's built on every GET from `services.json` so changes to
 * the installed-services list (e.g. `parachute vault create`) are visible
 * immediately without a re-expose.
 *
 * `--db` is the path to `hub.db`. JWKS is served live from the DB so key
 * rotation takes effect on the next request without re-running
 * `parachute expose`. Defaults to `~/.parachute/hub.db` (overridable via
 * `$PARACHUTE_HOME`).
 */

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  handleAdminConfigGet,
  handleAdminConfigPost,
  handleAdminLoginGet,
  handleAdminLoginPost,
  handleAdminLogoutPost,
} from "./admin-handlers.ts";
import { handleCreateVault } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { hubDbPath, openHubDb } from "./hub-db.ts";
import { pemToJwk } from "./jwks.ts";
import {
  authorizationServerMetadata,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleRevoke,
  handleToken,
} from "./oauth-handlers.ts";
import { readManifest } from "./services-manifest.ts";
import { getAllPublicKeys } from "./signing-keys.ts";
import { buildWellKnown } from "./well-known.ts";

interface Args {
  port: number;
  wellKnownDir: string;
  dbPath: string;
  issuer: string | undefined;
}

function parseArgs(argv: string[]): Args {
  let port: number | undefined;
  let wellKnownDir: string | undefined;
  let dbPath: string | undefined;
  let issuer: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") {
      const v = argv[++i];
      if (!v) throw new Error("--port requires a value");
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new Error(`--port must be 1..65535, got "${v}"`);
      }
      port = n;
    } else if (a === "--well-known-dir") {
      const v = argv[++i];
      if (!v) throw new Error("--well-known-dir requires a value");
      wellKnownDir = resolve(v);
    } else if (a === "--db") {
      const v = argv[++i];
      if (!v) throw new Error("--db requires a value");
      dbPath = resolve(v);
    } else if (a === "--issuer") {
      const v = argv[++i];
      if (!v) throw new Error("--issuer requires a value");
      issuer = v.replace(/\/+$/, "");
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (port === undefined) throw new Error("--port is required");
  if (wellKnownDir === undefined) throw new Error("--well-known-dir is required");
  return { port, wellKnownDir, dbPath: dbPath ?? hubDbPath(), issuer };
}

export interface HubFetchDeps {
  /**
   * Lazily opens (or returns a cached handle to) the hub DB. Optional so
   * tests can exercise routes that don't touch the DB (the well-known doc,
   * static assets) without standing up a fixture; runtime returns 503 for
   * DB-dependent routes when this is absent.
   */
  getDb?: () => Database;
  /**
   * Hub origin used as the OAuth `iss` claim and to build the authorization-
   * server metadata document. When omitted, OAuth endpoints fall back to the
   * request's own origin — fine for local dev, surprising under a reverse
   * proxy where the request origin is the loopback.
   */
  issuer?: string;
  /**
   * Path to the services manifest read on each `/.well-known/parachute.json`
   * GET. Tests point this at a tmpdir; production uses the default ecosystem
   * path. Read-on-each-request (cheap — single ~KB JSON parse) is what makes
   * the doc reflect `parachute vault create` etc. without re-running expose.
   */
  manifestPath?: string;
}

export function hubFetch(
  wellKnownDir: string,
  deps?: HubFetchDeps,
): (req: Request) => Response | Promise<Response> {
  const hubHtmlPath = join(wellKnownDir, "hub.html");
  const getDb = deps?.getDb;
  const configuredIssuer = deps?.issuer;
  const manifestPath = deps?.manifestPath ?? SERVICES_MANIFEST_PATH;

  const oauthDeps = (req: Request) => ({
    issuer: configuredIssuer ?? new URL(req.url).origin,
  });

  return (req) => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/hub.html") {
      if (!existsSync(hubHtmlPath)) {
        return new Response("hub.html not found", { status: 404 });
      }
      return new Response(Bun.file(hubHtmlPath), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (pathname === "/.well-known/parachute.json") {
      // The well-known doc is a public service-discovery manifest (no
      // secrets, no PII), and Notes / future browser clients fetch it
      // cross-origin from their own loopback port. Wildcard CORS is the
      // shape it needs. Browsers send an OPTIONS preflight when the request
      // adds non-simple headers; answer it with 204 + the same allow-list.
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      // Built dynamically from services.json on every request — that's what
      // makes `parachute vault create` show up here without re-running
      // expose. canonicalOrigin reuses the OAuth issuer fallback: prefer the
      // configured public origin (set by `--issuer https://<fqdn>`), else
      // the request's own origin (fine for direct loopback hits).
      try {
        const manifest = readManifest(manifestPath);
        const canonicalOrigin = configuredIssuer ?? new URL(req.url).origin;
        const doc = buildWellKnown({
          services: manifest.services,
          canonicalOrigin,
        });
        return new Response(JSON.stringify(doc), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        // ServicesManifestError lands here too — corrupt JSON or schema
        // violation in services.json shouldn't crash the hub for everyone.
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: `well-known build failed: ${msg}` }), {
          status: 500,
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
    }

    if (pathname === "/.well-known/jwks.json") {
      // JWKS is also a cross-origin fetch target (browser-side OAuth
      // libraries pull this to verify access tokens). Same wildcard CORS
      // shape as parachute.json — JWKS is public-by-design (only public
      // keys leave the server).
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      if (!getDb) {
        return new Response('{"error":"jwks unavailable: db not configured"}', {
          status: 503,
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
      try {
        const db = getDb();
        const keys = getAllPublicKeys(db).map((k) => pemToJwk(k.publicKeyPem, k.kid));
        return new Response(JSON.stringify({ keys }), {
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: `jwks failed: ${msg}` }), {
          status: 500,
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
    }

    if (pathname === "/.well-known/oauth-authorization-server") {
      // Public discovery doc — clients pull this cross-origin to find the
      // authorize/token endpoints. Same wildcard CORS shape as the JWKS
      // and the parachute manifest.
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      const res = authorizationServerMetadata(oauthDeps(req));
      // Fold CORS into the existing JSON response.
      const merged = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders)) merged.set(k, v);
      return new Response(res.body, { status: res.status, headers: merged });
    }

    if (pathname === "/oauth/authorize") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      if (req.method === "GET") return handleAuthorizeGet(getDb(), req, oauthDeps(req));
      if (req.method === "POST") return handleAuthorizePost(getDb(), req, oauthDeps(req));
      return new Response("method not allowed", { status: 405 });
    }

    if (pathname === "/oauth/token") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleToken(getDb(), req, oauthDeps(req));
    }

    if (pathname === "/oauth/register") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleRegister(getDb(), req, oauthDeps(req));
    }

    if (pathname === "/oauth/revoke") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleRevoke(getDb(), req, oauthDeps(req));
    }

    if (pathname === "/vaults") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      return handleCreateVault(req, {
        db: getDb(),
        issuer: oauthDeps(req).issuer,
      });
    }

    if (pathname === "/admin/login") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method === "GET") return handleAdminLoginGet(getDb(), req);
      if (req.method === "POST") return handleAdminLoginPost(getDb(), req);
      return new Response("method not allowed", { status: 405 });
    }

    if (pathname === "/admin/logout") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleAdminLogoutPost(getDb(), req);
    }

    if (pathname === "/admin/config") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return handleAdminConfigGet(getDb(), req);
    }

    if (pathname.startsWith("/admin/config/")) {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const name = decodeURIComponent(pathname.slice("/admin/config/".length));
      if (!name || name.includes("/")) {
        return new Response("not found", { status: 404 });
      }
      return handleAdminConfigPost(getDb(), req, name);
    }

    return new Response("not found", { status: 404 });
  };
}

if (import.meta.main) {
  const { port, wellKnownDir, dbPath, issuer } = parseArgs(process.argv.slice(2));
  let cachedDb: Database | undefined;
  const getDb = () => {
    if (!cachedDb) cachedDb = openHubDb(dbPath);
    return cachedDb;
  };
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: hubFetch(wellKnownDir, { getDb, issuer }),
  });
  console.log(
    `parachute-hub listening on http://127.0.0.1:${port} (dir=${wellKnownDir}, db=${dbPath}${
      issuer ? `, issuer=${issuer}` : ""
    })`,
  );
}
