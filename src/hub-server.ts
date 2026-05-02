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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleListGrants, handleRevokeGrant } from "./admin-grants.ts";
import {
  handleAdminConfigGet,
  handleAdminConfigPost,
  handleAdminLoginGet,
  handleAdminLoginPost,
  handleAdminLogoutPost,
} from "./admin-handlers.ts";
import { handleHostAdminToken } from "./admin-host-admin-token.ts";
import { handleVaultAdminToken } from "./admin-vault-admin-token.ts";
import { handleCreateVault } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { HUB_SVC, clearHubPort, writeHubPort } from "./hub-control.ts";
import { hubDbPath, openHubDb } from "./hub-db.ts";
import { pemToJwk } from "./jwks.ts";
import {
  type ModuleManifest,
  readModuleManifest as defaultReadModuleManifest,
} from "./module-manifest.ts";
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
import { buildWellKnown, isVaultEntry, vaultInstanceNameFor } from "./well-known.ts";

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
  /**
   * Directory containing the built SPA bundle (`index.html` + `assets/`). When
   * absent, the hub auto-resolves to `<repo>/web/ui/dist/` — handy for the
   * default bun-linked checkout. Tests point this at a fixture (or omit it +
   * disable the mount). When the dir doesn't exist on disk, `/hub/*` routes
   * 503 with a "run `bun run build` in web/ui" hint.
   */
  spaDistDir?: string;
  /**
   * Override the per-module `.parachute/module.json` reader. Production reads
   * from disk via `module-manifest.readModuleManifest`; tests inject a fake
   * to drive `managementUrl` into the well-known doc without standing up
   * fixture installDirs.
   */
  readModuleManifest?: (installDir: string) => Promise<ModuleManifest | null>;
}

/**
 * For each vault `ServiceEntry` with a known `installDir`, read its
 * `.parachute/module.json` and surface the optional `managementUrl`. Returns
 * a `name → managementUrl` map keyed by services.json entry name.
 *
 * Quiet on per-entry errors: a malformed module.json on one vault shouldn't
 * 500 the entire well-known doc — its row just renders without a "Manage"
 * link. The validator already throws structured errors from
 * `readModuleManifest`; logging them once here is the right floor.
 */
async function loadManagementUrls(
  services: readonly ServiceEntry[],
  read: (installDir: string) => Promise<ModuleManifest | null>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    services.map(async (s) => {
      if (!isVaultEntry(s) || !s.installDir) return;
      try {
        const m = await read(s.installDir);
        if (m?.managementUrl) out.set(s.name, m.managementUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`well-known: skipping managementUrl for ${s.name}: ${msg}`);
      }
    }),
  );
  return out;
}

/**
 * Resolve the SPA bundle dir. We anchor to this file's location so a
 * `bun src/hub-server.ts` from any cwd still finds `<repo>/web/ui/dist/`.
 * Tests / production override via `HubFetchDeps.spaDistDir`.
 */
function defaultSpaDistDir(): string {
  // import.meta.dir is the dir holding *this* file (`src/`); the SPA bundle
  // sits at `<repo>/web/ui/dist/`, two hops up + over.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "web", "ui", "dist");
}

const SPA_MOUNT = "/hub";

/**
 * Pick a content type for static assets the SPA build produces. Vite's
 * standard fingerprinted output is the realistic surface — js / css / svg /
 * png / woff2 / ico. We don't reach for a full mime db; mismatches show up
 * loud (a `.js` served as `text/html` is unmistakable) and the list is
 * trivially extensible if a future feature adds an asset type.
 */
function spaContentType(pathname: string): string {
  const ext = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
    case "mjs":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "ico":
      return "image/x-icon";
    case "woff2":
      return "font/woff2";
    case "woff":
      return "font/woff";
    case "json":
      return "application/json";
    case "map":
      return "application/json";
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Serve a single file under the SPA mount, falling back to `index.html`
 * for client-side-routed paths (anything that doesn't resolve to a real
 * file under `dist/`). Path-traversal is blocked twice: the asset-shape
 * filter rejects sub-paths containing "..", and the resolved absolute
 * path is checked to start with `dist/` before any read.
 */
async function serveSpa(spaDistDir: string, pathname: string): Promise<Response> {
  if (!existsSync(spaDistDir)) {
    return new Response(
      "hub SPA bundle not found — run `bun run build` in web/ui/ to produce dist/",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  // Strip the mount prefix; "/hub" → "", "/hub/" → "/", "/hub/x" → "/x".
  const sub = pathname === SPA_MOUNT ? "" : pathname.slice(SPA_MOUNT.length);
  const indexPath = join(spaDistDir, "index.html");

  // Empty / mount-root / any non-asset request → SPA shell. The router takes
  // it from there. First defense against traversal: bare paths and anything
  // containing ".." never enter the asset branch — they fall through to the
  // shell below.
  const looksLikeAsset = sub.length > 0 && /\.[a-z0-9]+$/i.test(sub) && !sub.includes("..");
  if (!looksLikeAsset) {
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  const filePath = resolve(spaDistDir, `.${sub}`);
  // Second defense: even if a future tweak loosens looksLikeAsset, refuse
  // any resolved path that escapes dist/. Belt-and-braces.
  if (!filePath.startsWith(`${spaDistDir}/`)) {
    return new Response("not found", { status: 404 });
  }
  if (!existsSync(filePath)) {
    // Asset request that doesn't resolve to a real file → SPA shell.
    // (e.g. `/hub/vaults` with a typo'd extension shouldn't 404 the page.)
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response(Bun.file(filePath), {
    headers: { "content-type": spaContentType(filePath) },
  });
}

export function hubFetch(
  wellKnownDir: string,
  deps?: HubFetchDeps,
): (req: Request) => Response | Promise<Response> {
  const hubHtmlPath = join(wellKnownDir, "hub.html");
  const getDb = deps?.getDb;
  const configuredIssuer = deps?.issuer;
  const manifestPath = deps?.manifestPath ?? SERVICES_MANIFEST_PATH;
  const spaDistDir = deps?.spaDistDir ?? defaultSpaDistDir();

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
        const managementUrlByName = await loadManagementUrls(
          manifest.services,
          deps?.readModuleManifest ?? defaultReadModuleManifest,
        );
        const doc = buildWellKnown({
          services: manifest.services,
          canonicalOrigin,
          managementUrlFor: (entry) => managementUrlByName.get(entry.name),
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

    // Hub vault-management SPA. Mount root + nested routes both land here;
    // serveSpa picks index.html vs. an asset by extension. Only GET — POSTs
    // for vault create go to /vaults, not the SPA mount. (HEAD is harmless
    // but we keep the contract narrow.)
    if (pathname === SPA_MOUNT || pathname.startsWith(`${SPA_MOUNT}/`)) {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return serveSpa(spaDistDir, pathname);
    }

    if (pathname === "/admin/host-admin-token") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      return handleHostAdminToken(req, {
        db: getDb(),
        issuer: oauthDeps(req).issuer,
      });
    }

    if (pathname.startsWith("/admin/vault-admin-token/")) {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      const vaultName = decodeURIComponent(pathname.slice("/admin/vault-admin-token/".length));
      // The vault name must correspond to an actual vault instance — same
      // shape the well-known doc derives. Source from services.json so a
      // freshly-created vault is mintable on the next request without a
      // restart.
      const manifest = readManifest(manifestPath);
      const knownVaultNames = new Set<string>();
      for (const s of manifest.services) {
        if (!isVaultEntry(s)) continue;
        for (const path of s.paths) knownVaultNames.add(vaultInstanceNameFor(s.name, path));
      }
      return handleVaultAdminToken(req, vaultName, {
        db: getDb(),
        issuer: oauthDeps(req).issuer,
        knownVaultNames,
      });
    }

    if (pathname === "/api/grants") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      return handleListGrants(req, {
        db: getDb(),
        issuer: oauthDeps(req).issuer,
      });
    }

    if (pathname.startsWith("/api/grants/")) {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      const clientId = decodeURIComponent(pathname.slice("/api/grants/".length));
      if (!clientId || clientId.includes("/")) {
        return new Response("not found", { status: 404 });
      }
      return handleRevokeGrant(req, clientId, {
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
