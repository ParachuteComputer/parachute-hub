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
import { HUB_SVC, clearHubPort, writeHubPort } from "./hub-control.ts";
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
import { clearPid, writePid } from "./process-state.ts";
import { type ServiceEntry, readManifest } from "./services-manifest.ts";
import { getAllPublicKeys } from "./signing-keys.ts";
import { buildWellKnown, isVaultEntry } from "./well-known.ts";

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

/**
 * Resolve which vault ServiceEntry should handle a given request pathname.
 *
 * Vault paths look like `/vault/<name>` or `/vault/<name>/<rest>`. A request
 * matches a vault entry if the pathname equals one of its mount paths exactly
 * or starts with `<mount>/`. When several mounts could match (one vault has
 * `/vault` and another has `/vault/foo` — pathological but representable),
 * the longer mount wins so the more specific install handles it.
 *
 * Returns `undefined` when no vault is mounted at this pathname; the caller
 * 404s. The lookup is per-request because services.json mutates whenever
 * `parachute vault create` runs and we don't want the user to re-expose just
 * to make a freshly-created vault routable on the tailnet (#144).
 */
export function findVaultUpstream(
  services: readonly ServiceEntry[],
  pathname: string,
): { port: number; mount: string; entry: ServiceEntry } | undefined {
  let best: { port: number; mount: string; entry: ServiceEntry } | undefined;
  for (const s of services) {
    if (!isVaultEntry(s)) continue;
    for (const path of s.paths) {
      if (pathname === path || pathname.startsWith(`${path}/`)) {
        if (!best || path.length > best.mount.length) {
          best = { port: s.port, mount: path, entry: s };
        }
      }
    }
  }
  return best;
}

/**
 * Reverse-proxy a `/vault/<name>/*` request onto the vault backend's loopback
 * port. The path is preserved end-to-end (vault since paraclaw#18 expects
 * requests at `/vault/<name>/...` not stripped to `/...`), so the upstream URL
 * mirrors the incoming pathname exactly.
 *
 * `manifestPath` is the services.json path from `HubFetchDeps`. Read on every
 * proxied request so a vault created seconds ago is reachable without a
 * re-expose — same dynamism as the well-known doc (#135).
 *
 * Returns `undefined` when no vault is currently mounted at this pathname so
 * the caller falls through to the catch-all 404. Returns a 502 response when
 * the upstream connection fails (vault crashed, port shifted) — the upstream
 * URL was valid; we just couldn't reach it.
 *
 * Hop-by-hop notes: WebSocket upgrades and HTTP/2 trailers don't traverse
 * fetch-based proxies cleanly. Vault uses neither today; if a future service
 * needs them, switch to a Node http.IncomingMessage / http.request pair.
 */
async function proxyToVault(req: Request, manifestPath: string): Promise<Response | undefined> {
  let services: readonly ServiceEntry[];
  try {
    services = readManifest(manifestPath).services;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `vault routing failed: ${msg}` }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const url = new URL(req.url);
  const match = findVaultUpstream(services, url.pathname);
  if (!match) return undefined;

  const upstream = `http://127.0.0.1:${match.port}${url.pathname}${url.search}`;
  const headers = new Headers(req.headers);
  // Host comes from the requester (tailnet FQDN); the loopback target wants
  // its own. Bun's fetch fills it in when omitted.
  headers.delete("host");

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }
  try {
    return await fetch(upstream, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `vault upstream unreachable: ${msg}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
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

  return async (req) => {
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

    // Dynamic vault routing — services.json is the source of truth, read per
    // request so a `parachute vault create` performed after `parachute expose`
    // is immediately reachable on the tailnet (#144). Tailscale serve mounts
    // a single `/vault/` → hub entry; this handler picks the specific vault
    // backend by longest-mount-prefix on every request.
    if (pathname.startsWith("/vault/")) {
      const proxied = await proxyToVault(req, manifestPath);
      if (proxied) return proxied;
      // Fall through to the catch-all 404 below — no vault claims this path.
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
  // Register PID + port from the running hub itself so any startup path
  // (spawn-via-`ensureHubRunning` or a direct `bun src/hub-server.ts` from
  // a developer or supervisor) lands the same lifecycle files at
  // ~/.parachute/hub/run/. Manual starts used to be invisible — `parachute
  // expose` then spawned another hub that collided on 1939 (#148).
  writePid(HUB_SVC, process.pid);
  writeHubPort(port);
  const cleanup = () => {
    clearPid(HUB_SVC);
    clearHubPort();
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);
  console.log(
    `parachute-hub listening on http://127.0.0.1:${port} (dir=${wellKnownDir}, db=${dbPath}${
      issuer ? `, issuer=${issuer}` : ""
    })`,
  );
}
