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
 * Routes (all bound to 127.0.0.1) — listed in dispatch order. Order is
 * load-bearing: 301 redirects fire before the proxies and SPA mount they
 * preempt; admin API endpoints fire before the /admin/* SPA catch-all.
 *
 *   # Pre-rename 301 back-compat (hub#231 — first so they preempt any
 *   # remaining handlers under /vault or /hub).
 *   /vault, /vault/, /vault/new                → 301 → /admin/vaults[/new]
 *   /hub/vaults*                               → 301 → /admin/vaults*
 *   /hub/permissions                           → 301 → /admin/permissions
 *   /hub/tokens                                → 301 → /admin/tokens
 *   /hub, /hub/                                → 301 → /admin/vaults
 *   /admin/login, /admin/logout                → 301 → /login, /logout
 *
 *   # Discovery + well-known.
 *   /, /hub.html                               → hub.html (the discovery page)
 *   /.well-known/parachute.json                → built dynamically from services.json
 *   /.well-known/parachute-revocation.json     → revoked-jti list (hub#212 Phase 1)
 *   /.well-known/jwks.json                     → JWKS from hub.db
 *   /.well-known/oauth-authorization-server    → RFC 8414 metadata (issuer, endpoints)
 *
 *   # OAuth issuer.
 *   /oauth/authorize  (GET + POST)             → login → consent → auth code
 *   /oauth/authorize/approve (POST)            → inline DCR approve form (#208)
 *   /oauth/token      (POST)                   → authorization_code + refresh_token grants
 *   /oauth/register   (POST)                   → RFC 7591 dynamic client registration
 *   /oauth/revoke     (POST)                   → RFC 7009 refresh-token revocation
 *
 *   # Admin API + bearer-mint surfaces (must precede /admin/* SPA mount).
 *   /vaults                       (POST)       → create vault
 *   /admin/host-admin-token       (GET)        → SPA bearer mint (cookie-gated)
 *   /admin/vault-admin-token/<n>  (GET)        → per-vault bearer mint (cookie-gated)
 *   /api/me                       (GET)        → who-am-I (session+CSRF or hasSession:false)
 *   /api/auth/mint-token          (POST)       → CLI/automation token mint (bearer)
 *   /api/auth/revoke-token        (POST)       → revoke registry-row token by jti
 *   /api/auth/tokens              (GET)        → paginated registry list
 *   /api/grants                   (GET)        → OAuth consent grants list
 *   /api/grants/<client_id>       (DELETE)     → revoke a single OAuth grant
 *   /api/oauth/clients/<id>       (GET)        → OAuth client details
 *   /api/oauth/clients/<id>/approve (POST)     → flip a pending client to approved
 *   /login                        (GET + POST) → operator password login
 *   /logout                       (POST)       → end admin session
 *   /admin/config*                             → 301 → /admin/vaults (legacy
 *                                                portal retired post-SPA-rework)
 *
 *   # Per-vault content proxy (user-facing vault data: Notes PWA, MCP, etc.).
 *   /vault/<name>/*                            → proxy to the vault backend
 *
 *   # Admin SPA mount (catch-all under /admin; runs after all admin API
 *   # handlers above, so /admin/<known> reaches the right handler and
 *   # /admin/<spa-route> serves the SPA shell).
 *   /admin, /admin/, /admin/*                  → SPA shell (vaults / new / permissions / tokens)
 *
 *   # Generic services.json-driven proxy (non-vault modules: notes, scribe, agent).
 *   /<service-mount>/*                         → proxy via services.json longest-prefix
 *
 *   anything else                              → 404
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
import { handleApproveClient, handleGetClient } from "./admin-clients.ts";
import { handleListGrants, handleRevokeGrant } from "./admin-grants.ts";
import {
  handleAdminLoginGet,
  handleAdminLoginPost,
  handleAdminLogoutPost,
} from "./admin-handlers.ts";
import { handleHostAdminToken } from "./admin-host-admin-token.ts";
import { handleVaultAdminToken } from "./admin-vault-admin-token.ts";
import { handleCreateVault } from "./admin-vaults.ts";
import { handleApiMe } from "./api-me.ts";
import { handleApiMintToken } from "./api-mint-token.ts";
import { REVOCATION_LIST_MOUNT, handleRevocationList } from "./api-revocation-list.ts";
import { handleApiRevokeToken } from "./api-revoke-token.ts";
import { handleApiTokens } from "./api-tokens.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { ensureCsrfToken } from "./csrf.ts";
import { readExposeState } from "./expose-state.ts";
import { HUB_SVC, clearHubPort, writeHubPort } from "./hub-control.ts";
import { hubDbPath, openHubDb } from "./hub-db.ts";
import { type RenderHubOpts, renderHub } from "./hub.ts";
import { pemToJwk } from "./jwks.ts";
import {
  type ModuleManifest,
  readModuleManifest as defaultReadModuleManifest,
} from "./module-manifest.ts";
import {
  authorizationServerMetadata,
  handleApproveClientPost,
  handleAuthorizeGet,
  handleAuthorizePost,
  handleRegister,
  handleRevoke,
  handleToken,
} from "./oauth-handlers.ts";
import { buildHubBoundOrigins } from "./origin-check.ts";
import { clearPid, writePid } from "./process-state.ts";
import {
  FIRST_PARTY_FALLBACKS,
  effectivePublicExposure,
  shortNameForManifest,
} from "./service-spec.ts";
import { type ServiceEntry, readManifest } from "./services-manifest.ts";
import { findActiveSession } from "./sessions.ts";
import { getAllPublicKeys } from "./signing-keys.ts";
import { getUserById } from "./users.ts";
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
      // Normalize trailing slashes before comparison (#197). A services.json
      // entry written with `paths: ["/vault/default/"]` would otherwise only
      // match the exact pathname `/vault/default/` and never any sub-path,
      // because `pathname.startsWith("/vault/default//")` is always false.
      // The "|| '/'" branch keeps a bare-root mount "/" stable rather than
      // collapsing it to an empty string.
      const norm = path.replace(/\/+$/, "") || "/";
      if (pathname === norm || pathname.startsWith(`${norm}/`)) {
        if (!best || norm.length > best.mount.length) {
          best = { port: s.port, mount: norm, entry: s };
        }
      }
    }
  }
  return best;
}

/**
 * The trust layer a request arrived through. Hub binds `127.0.0.1:1939`, so
 * every request reaches it via one of three trusted forwarders (or directly
 * over loopback). The forwarder injects characteristic headers that we use to
 * classify; nothing else can reach the listener, so spoofing isn't a concern.
 *
 *   "loopback" — direct localhost call (CLI, on-box service, dev shell).
 *   "tailnet"  — `tailscale serve` forwarding an authed tailnet user.
 *   "public"   — `tailscale funnel` (public-over-tailnet, unauthed) OR a
 *                cloudflared tunnel forwarding from the public internet.
 *
 * Used to gate `publicExposure: "loopback"` services on the generic
 * `/<svc>/*` dispatch (the hub's only layer-gate). Hub-owned paths (`/`,
 * `/admin/*`, `/api/*`, `/hub/*`, `/oauth/*`, `/.well-known/*`, `/vault/*`,
 * `/vaults`) reach all layers and rely on app-level auth (admin session
 * cookie + 2FA, OAuth, per-service tokens) — they are NOT layer-blocked.
 */
export type RequestLayer = "loopback" | "tailnet" | "public";

/**
 * Classify the trust layer for an incoming request by inspecting proxy
 * headers. Order matters: cloudflared headers come first because cloudflared
 * could in principle be deployed alongside tailscale on the same node.
 *
 * Header reference (verified against tailscale serve.go on 2026-05-08):
 *   - `Tailscale-User-Login` is set ONLY by `tailscale serve` for an authed
 *     tailnet user. Tagged-source nodes don't get it. Funnel never sets it.
 *   - `Tailscale-Funnel-Request: ?1` is set ONLY by Tailscale Funnel.
 *     Mutually exclusive with `Tailscale-User-Login` (the serve.go path
 *     returns early when funneled).
 *   - `CF-Ray` and `CF-Connecting-IP` are set by Cloudflare's edge for
 *     anything proxied through a cloudflared tunnel.
 *
 * Spoofing isn't a concern: hub binds `127.0.0.1:1939`, so external requests
 * can't reach the listener except via these trusted forwarders. Tailscale
 * specifically strips the same headers from incoming requests before
 * re-injecting them, so even a malicious tailnet peer can't impersonate a
 * different user. We could mirror that strip-on-arrival defense, but it's
 * belt-and-braces given the bind shape.
 *
 * Default to "loopback" when no proxy headers are present — that's the
 * direct-localhost case. Funnel without `Tailscale-Funnel-Request` would
 * also fall here, but Tailscale always sets the header on funneled
 * requests, so this branch only fires for true loopback callers.
 */
export function layerOf(req: Request): RequestLayer {
  const h = req.headers;
  if (h.get("cf-ray") !== null || h.get("cf-connecting-ip") !== null) return "public";
  // Match the structured-header value (`?1`) rather than mere presence:
  // serve.go only ever emits `?1`, so insisting on the canonical value keeps
  // the classifier's intent obvious to a future reader (don't loosen this to
  // `!== null` — Tailscale's contract is the value, not the header name).
  // CF-Ray / CF-Connecting-IP are open-string identifiers with no canonical
  // value to compare against, hence the presence-check above.
  if (h.get("tailscale-funnel-request") === "?1") return "public";
  if (h.get("tailscale-user-login") !== null) return "tailnet";
  return "loopback";
}

/**
 * Forward a request to a loopback service on `127.0.0.1:<port>`. By default
 * the incoming pathname + query are preserved verbatim; pass `targetPath` to
 * rewrite the path (e.g. when the caller has stripped a mount prefix because
 * the backend serves bare routes). Query string is always preserved from the
 * incoming URL.
 *
 * Note: this is **not** equivalent to the tailscale convention. `tailscale
 * serve <mount>=<target>` strips the mount before forwarding, so
 * `serviceProxyTarget` in `commands/expose.ts` works by making mount and
 * target byte-equal. The hub's fetch-based proxy does no stripping unless the
 * caller asks; per-service preferences vary (scribe wants bare paths, notes
 * / agent / vault want the prefix), so the decision lives one layer up in
 * `proxyToService` / `proxyToVault`.
 *
 * Returns 502 when the loopback fetch fails — port valid, target unreachable
 * (service crashed, port shifted, mid-restart). `serviceLabel` is folded into
 * the error message so 502 bodies say `vault upstream unreachable` /
 * `scribe upstream unreachable` etc.
 *
 * Hop-by-hop notes: WebSocket upgrades and HTTP/2 trailers don't traverse
 * fetch-based proxies cleanly. No on-box service uses either today; if one
 * eventually needs them, switch to a Node http.IncomingMessage / http.request
 * pair.
 */
async function proxyRequest(
  req: Request,
  port: number,
  serviceLabel: string,
  targetPath?: string,
): Promise<Response> {
  const url = new URL(req.url);
  const path = targetPath ?? url.pathname;
  const upstream = `http://127.0.0.1:${port}${path}${url.search}`;
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
    return new Response(JSON.stringify({ error: `${serviceLabel} upstream unreachable: ${msg}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

/**
 * Reverse-proxy a `/vault/<name>/*` request onto the vault backend.
 * `manifestPath` is the services.json path from `HubFetchDeps`. Read on every
 * proxied request so a vault created seconds ago is reachable without a
 * re-expose — same dynamism as the well-known doc (#135).
 *
 * Returns `undefined` when no vault claims this pathname so the caller can
 * fall through to the SPA shell fallback for unknown vault names (the seam
 * #173 introduced).
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
  // Layer-gate on `publicExposure: "loopback"` — hide the entry from non-
  // loopback callers as if it doesn't exist. "allowed" / "auth-required"
  // pass through; the service does its own auth.
  if (effectivePublicExposure(match.entry) === "loopback" && layerOf(req) !== "loopback") {
    return new Response("not found", { status: 404 });
  }
  // Symmetry with proxyToService (#196): honor `stripPrefix` with FIRST_-
  // PARTY_FALLBACKS as a fallback source. No first-party vault fallback
  // declares stripPrefix today (vault expects the full `/vault/<name>/*`
  // path), so this is a no-op in practice — but reading the same shape in
  // both proxies keeps the dispatch surface consistent for future readers.
  const stripPrefix = stripPrefixFor(match.entry);
  const targetPath = stripPrefix ? url.pathname.slice(match.mount.length) || "/" : undefined;
  return proxyRequest(req, match.port, "vault", targetPath);
}

/**
 * Resolve which (non-vault) ServiceEntry should handle a given request.
 * Generic longest-prefix match across every service's `paths[]`. Vault
 * entries are filtered out — they're routed by `findVaultUpstream` /
 * `proxyToVault`, which encode the vault-specific SPA-fallback seam.
 *
 * Returns `undefined` when no service claims the pathname; the caller 404s.
 */
export function findServiceUpstream(
  services: readonly ServiceEntry[],
  pathname: string,
): { port: number; mount: string; entry: ServiceEntry } | undefined {
  let best: { port: number; mount: string; entry: ServiceEntry } | undefined;
  for (const s of services) {
    if (isVaultEntry(s)) continue;
    for (const path of s.paths) {
      // Normalize trailing slashes before comparison (#197). A services.json
      // entry written with `paths: ["/notes/"]` would otherwise only match
      // the exact pathname `/notes/` and never `/notes/assets/index.js` —
      // `pathname.startsWith("/notes//")` is always false because URLs
      // don't have double slashes. Result: SPA shell loads but every asset
      // 404s (notes blank-screen on Aaron's box, 2026-05-08).
      // The "|| '/'" branch keeps a bare-root mount "/" stable rather than
      // collapsing it to an empty string.
      const norm = path.replace(/\/+$/, "") || "/";
      if (pathname === norm || pathname.startsWith(`${norm}/`)) {
        if (!best || norm.length > best.mount.length) {
          best = { port: s.port, mount: norm, entry: s };
        }
      }
    }
  }
  return best;
}

/**
 * Reverse-proxy a request onto whichever non-vault service registers a
 * matching `paths[]` prefix in services.json. Wired after every specific
 * handler in `hubFetch` so the exclusion list (`/`, `/admin/*`, `/oauth/*`,
 * `/.well-known/*`, `/hub/*`, `/vault/*`, `/api/*`) is enforced by ordering:
 * those specific handlers run first and never reach this dispatch.
 *
 * Read services.json on every request so a `parachute install <svc>` made
 * seconds ago is reachable without a hub restart — same dynamism as the
 * well-known doc and `proxyToVault`.
 *
 * Honors `entry.stripPrefix`: when `true` the matched mount prefix is
 * removed from the forwarded path so the backend sees a bare route
 * (`/scribe/health` becomes `/health`). Default (`false` / absent) forwards
 * the full path — matches what notes / agent / vault expect.
 *
 * Returns `undefined` when no service claims the pathname; caller 404s.
 */
async function proxyToService(req: Request, manifestPath: string): Promise<Response | undefined> {
  let services: readonly ServiceEntry[];
  try {
    services = readManifest(manifestPath).services;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `service routing failed: ${msg}` }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const url = new URL(req.url);
  const match = findServiceUpstream(services, url.pathname);
  if (!match) return undefined;
  // Layer-gate on `publicExposure: "loopback"`. From the perspective of a
  // tailnet/public caller, a loopback-only service must be indistinguishable
  // from "not installed" — 404, not 403, so we don't leak the existence of
  // the route. "allowed" / "auth-required" pass through; the service does
  // its own auth.
  if (effectivePublicExposure(match.entry) === "loopback" && layerOf(req) !== "loopback") {
    return new Response("not found", { status: 404 });
  }
  // Consult FIRST_PARTY_FALLBACKS as a fallback for `stripPrefix` (#196).
  // Scribe v0.4.0 doesn't write `stripPrefix: true` to its services.json
  // entry — the declaration only lives in hub's SCRIBE_FALLBACK manifest.
  // Pre-#187 this didn't matter because the per-service tailscale serve
  // plan baked the path into the target URL; post-#187 routing went through
  // hub which wasn't consulting the fallback registry. Same shape as how
  // `effectivePublicExposure` already handles fallback derivation in
  // service-spec.ts. Explicit-on-entry still wins; absent → fallback →
  // false (preserving existing keep-prefix default for unknown services).
  const stripPrefix = stripPrefixFor(match.entry);
  const targetPath = stripPrefix ? url.pathname.slice(match.mount.length) || "/" : undefined;
  return proxyRequest(req, match.port, match.entry.name, targetPath);
}

/**
 * Resolve effective `stripPrefix` for a service entry. Explicit on-entry
 * wins; otherwise consult `FIRST_PARTY_FALLBACKS` keyed by short name (so
 * scribe's vendored fallback supplies `stripPrefix: true` even when scribe's
 * own boot doesn't write it). Defaults to `false` — keep the prefix —
 * matching the pre-#196 dispatch behavior for unknown / third-party services.
 */
function stripPrefixFor(entry: ServiceEntry): boolean {
  if (entry.stripPrefix !== undefined) return entry.stripPrefix;
  const short = shortNameForManifest(entry.name);
  const fb = short !== undefined ? FIRST_PARTY_FALLBACKS[short] : undefined;
  return fb?.manifest.stripPrefix ?? false;
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
  /**
   * Hub's listening port. Threaded into the OAuth `hubBoundOrigins` set so
   * the same-origin defense accepts loopback access (`http://localhost:<port>`,
   * `http://127.0.0.1:<port>`) alongside the configured issuer. Closes #245
   * Case A (operator on `localhost:1939` getting "Cross-origin request
   * rejected" because Origin ≠ tailnet issuer).
   */
  loopbackPort?: number;
  /**
   * Test seam for reading `expose-state.json`. Production reads the operator's
   * `~/.parachute/expose-state.json` via `readExposeState`; tests inject a
   * fake to drive tailnet/funnel origins into the bound set without standing
   * up real exposes. Returns `undefined` when no state file is present
   * (pre-`parachute expose` state — fine, the issuer + loopback still cover
   * legitimate access).
   */
  loadExposeHubOrigin?: () => string | undefined;
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
 * For each NON-vault `ServiceEntry` with a known `installDir`, read its
 * `.parachute/module.json` and surface the optional `uiUrl` and
 * `displayName`. Returns two `name → value` maps keyed by services.json
 * entry name. Mirrors `loadManagementUrls` (vault is the analog there;
 * non-vault services are the analog here — vaults are user-facing via
 * Notes, not their own UI).
 *
 * Why read at request time and not from services.json: services own the
 * write side of services.json (`upsertService` replaces the whole entry
 * on every boot), so any install-time copy of `uiUrl` / `displayName`
 * would be clobbered the first time the service writes its own entry.
 * Reading from `installDir/module.json` at request time avoids the gap
 * and matches the established `managementUrl` precedent.
 *
 * Quiet on per-entry errors: a malformed module.json on one service
 * shouldn't 500 the entire well-known doc — its row just renders without
 * a Services tile. The validator already throws structured errors from
 * `readModuleManifest`; logging them once here is the right floor.
 */
async function loadServiceUiMetadata(
  services: readonly ServiceEntry[],
  read: (installDir: string) => Promise<ModuleManifest | null>,
): Promise<{ uiUrls: Map<string, string>; displayNames: Map<string, string> }> {
  const uiUrls = new Map<string, string>();
  const displayNames = new Map<string, string>();
  await Promise.all(
    services.map(async (s) => {
      // Skip vaults — they have their own loadManagementUrls path and no
      // operator-facing user UI of their own (content browses via Notes).
      if (isVaultEntry(s) || !s.installDir) return;
      try {
        const m = await read(s.installDir);
        if (m?.uiUrl) uiUrls.set(s.name, m.uiUrl);
        if (m?.displayName) displayNames.set(s.name, m.displayName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`well-known: skipping uiUrl/displayName for ${s.name}: ${msg}`);
      }
    }),
  );
  return { uiUrls, displayNames };
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

/**
 * The admin SPA serves at a single mount: `/admin/*` (since hub#231).
 *
 * Routes:
 *   - `/admin/vaults`       → vault list (the SPA's home)
 *   - `/admin/vaults/new`   → vault create form
 *   - `/admin/permissions`  → OAuth consent grant management
 *   - `/admin/tokens`       → token registry: mint / list / revoke
 *
 * Asset URLs are origin-absolute (`/admin/assets/...`) per the Vite build
 * base. main.tsx pins react-router's basename to `/admin`.
 *
 * Pre-rename mounts (the old `/vault` for the vault SPA, `/hub/*` for
 * permissions+tokens) are 301-redirected further up the dispatch so cached
 * operator URLs keep working. `/vault/<name>/*` (per-vault content proxy)
 * stays — that's user-facing vault data, not part of this admin SPA.
 */
type SpaMount = "/admin";

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
 *
 * `mount` is the prefix being served (`/admin`); we strip it from
 * `pathname` to land on the file path inside `dist/`.
 */
async function serveSpa(spaDistDir: string, pathname: string, mount: SpaMount): Promise<Response> {
  if (!existsSync(spaDistDir)) {
    return new Response(
      "hub SPA bundle not found — run `bun run build` in web/ui/ to produce dist/",
      { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  // Strip the mount prefix; "/admin" → "", "/admin/" → "/", "/admin/x" → "/x".
  const sub = pathname === mount ? "" : pathname.slice(mount.length);
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
    // (e.g. `/vault/foo` with a typo'd extension shouldn't 404 the page.)
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
  const loopbackPort = deps?.loopbackPort;
  const loadExposeHubOrigin =
    deps?.loadExposeHubOrigin ??
    (() => {
      try {
        return readExposeState()?.hubOrigin;
      } catch {
        // Malformed expose-state.json shouldn't 500 hub on every same-origin
        // check — the issuer + loopback already cover legitimate access.
        return undefined;
      }
    });

  const oauthDeps = (req: Request) => {
    const issuer = configuredIssuer ?? new URL(req.url).origin;
    return {
      issuer,
      // Per-request resolution (closes #245): expose-state.json can change
      // mid-session (operator runs `parachute expose tailnet` while hub is
      // up), so we re-read the bound origins on each call rather than
      // capturing at hub start. Cheap — a single small JSON parse per OAuth
      // request, only on the cookie-POST paths that consult it.
      hubBoundOrigins: () =>
        buildHubBoundOrigins({
          issuer,
          loopbackPort,
          exposeHubOrigin: loadExposeHubOrigin(),
        }),
    };
  };

  return async (req) => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // 301 back-compat for the pre-hub#231 admin-SPA mounts:
    //
    //   `/vault`            → `/admin/vaults`
    //   `/vault/new`        → `/admin/vaults/new`
    //   `/hub/vaults*`      → `/admin/vaults*` (this redirect predates #231;
    //                        it now retargets at the new admin mount instead
    //                        of the interim `/vault` mount)
    //   `/hub/permissions`  → `/admin/permissions`
    //   `/hub/tokens`       → `/admin/tokens`
    //   `/hub` (bare)       → `/admin/vaults`
    //
    // Permanent redirect so cached operator URLs keep working without
    // leaving dangling SPA routes. Query string preserved; fragment is
    // client-side and survives the redirect at the browser. Method-agnostic
    // — even a misrouted POST gets the redirect; none of these paths host a
    // POST endpoint to protect.
    //
    // `/vault/<name>/*` is INTENTIONALLY excluded — that's the per-vault
    // content proxy (Notes PWA, etc.), not the admin SPA. Stays where it is.
    if (pathname === "/vault" || pathname === "/vault/" || pathname === "/vault/new") {
      const sub = pathname === "/vault/new" ? "/new" : "";
      return new Response("", {
        status: 301,
        headers: { location: `/admin/vaults${sub}${url.search}` },
      });
    }
    if (pathname === "/hub/vaults" || pathname.startsWith("/hub/vaults/")) {
      const newPath = `/admin/vaults${pathname.slice("/hub/vaults".length)}`;
      return new Response("", {
        status: 301,
        headers: { location: `${newPath}${url.search}` },
      });
    }
    if (pathname === "/hub/permissions") {
      return new Response("", {
        status: 301,
        headers: { location: `/admin/permissions${url.search}` },
      });
    }
    if (pathname === "/hub/tokens") {
      return new Response("", {
        status: 301,
        headers: { location: `/admin/tokens${url.search}` },
      });
    }
    if (pathname === "/hub" || pathname === "/hub/") {
      return new Response("", {
        status: 301,
        headers: { location: `/admin/vaults${url.search}` },
      });
    }

    // Login surface rename: `/admin/login` and `/admin/logout` 301 to the
    // canonical `/login` and `/logout`. The names were "admin" only by
    // historical accident — the handlers serve every parachute auth flow
    // (operator, OAuth user-redirect, future SPA sign-in). Renaming makes
    // the surface name match its actual scope.
    if (pathname === "/admin/login") {
      return new Response("", {
        status: 301,
        headers: { location: `/login${url.search}` },
      });
    }
    if (pathname === "/admin/logout") {
      return new Response("", {
        status: 301,
        headers: { location: `/logout${url.search}` },
      });
    }

    if (pathname === "/" || pathname === "/hub.html") {
      // When a DB is configured, render the discovery page dynamically so
      // the header carries a "Signed in as <name>" affordance for the
      // active session. Without a DB, fall back to the static disk file
      // (signed-out shape) — the disk file is what `parachute expose`
      // wrote out, used when the hub-server is running without state.
      if (getDb) {
        const db = getDb();
        const session = findActiveSession(db, req);
        let renderOpts: RenderHubOpts = {};
        const headers: Record<string, string> = {
          "content-type": "text/html; charset=utf-8",
        };
        if (session) {
          const user = getUserById(db, session.userId);
          if (user) {
            const csrf = ensureCsrfToken(req);
            renderOpts = {
              session: { displayName: user.username, csrfToken: csrf.token },
            };
            if (csrf.setCookie) headers["set-cookie"] = csrf.setCookie;
          }
        }
        return new Response(renderHub(renderOpts), { headers });
      }
      // No DB configured → fall back to static file (signed-out only).
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
        const readManifestFn = deps?.readModuleManifest ?? defaultReadModuleManifest;
        const [managementUrlByName, serviceUiMeta] = await Promise.all([
          loadManagementUrls(manifest.services, readManifestFn),
          loadServiceUiMetadata(manifest.services, readManifestFn),
        ]);
        const doc = buildWellKnown({
          services: manifest.services,
          canonicalOrigin,
          managementUrlFor: (entry) => managementUrlByName.get(entry.name),
          uiUrlFor: (entry) => serviceUiMeta.uiUrls.get(entry.name),
          displayNameFor: (entry) => serviceUiMeta.displayNames.get(entry.name),
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

    if (pathname === REVOCATION_LIST_MOUNT) {
      // Revocation list (hub#212 Phase 1). Public — same CORS posture as
      // jwks.json since resource servers (vault/scribe/agent) fetch it
      // cross-origin on the 60s polling cadence wired in Phase 4.
      const corsHeaders = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      };
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      if (!getDb) {
        return new Response('{"error":"revocation list unavailable: db not configured"}', {
          status: 503,
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
      const resp = handleRevocationList(req, { db: getDb() });
      // Layer the wildcard CORS over whatever cache-control the handler set.
      const merged = new Headers(resp.headers);
      for (const [k, v] of Object.entries(corsHeaders)) merged.set(k, v);
      return new Response(resp.body, { status: resp.status, headers: merged });
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

    // Inline approve form for the operator-driven pending-client flow (#208).
    // Receives `client_id` + `csrf_token` + `return_to` from the form rendered
    // by handleAuthorizeGet when the operator hits a pending client. Three
    // gates inside the handler: CSRF, active session, same-origin Origin.
    if (pathname === "/oauth/authorize/approve") {
      if (!getDb) {
        return new Response("hub db not configured", { status: 503 });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleApproveClientPost(getDb(), req, oauthDeps(req));
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

    // Note: the old `/hub/*` SPA mount has been retired. Known prefixes
    // (`/hub`, `/hub/vaults*`, `/hub/permissions`, `/hub/tokens`) are
    // 301-redirected at the top of dispatch. Any other `/hub/*` path falls
    // through to the catch-all 404 — there's no admin surface left there.

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

    if (pathname === "/api/me") {
      if (!getDb) {
        return Response.json(
          { error: "service_unavailable", error_description: "hub db not configured" },
          { status: 503 },
        );
      }
      return handleApiMe(req, { db: getDb() });
    }

    if (pathname === "/api/auth/mint-token") {
      if (!getDb) {
        return Response.json(
          { error: "service_unavailable", error_description: "hub db not configured" },
          { status: 503 },
        );
      }
      return handleApiMintToken(req, {
        db: getDb(),
        issuer: oauthDeps(req).issuer,
      });
    }

    if (pathname === "/api/auth/revoke-token") {
      if (!getDb) {
        return Response.json(
          { error: "service_unavailable", error_description: "hub db not configured" },
          { status: 503 },
        );
      }
      return handleApiRevokeToken(req, {
        db: getDb(),
        issuer: oauthDeps(req).issuer,
      });
    }

    if (pathname === "/api/auth/tokens") {
      if (!getDb) {
        return Response.json(
          { error: "service_unavailable", error_description: "hub db not configured" },
          { status: 503 },
        );
      }
      return handleApiTokens(req, {
        db: getDb(),
        issuer: oauthDeps(req).issuer,
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

    // OAuth client lookup + approval. Both bearer-gated under host:admin.
    // Two paths: `/api/oauth/clients/<id>` (GET, details) and
    // `/api/oauth/clients/<id>/approve` (POST, flip to approved). The
    // SPA approve-client deep link reads details from the first and
    // submits approval to the second — keeps the surface easy to test
    // and audit without overloading a single verb.
    if (pathname.startsWith("/api/oauth/clients/")) {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      const tail = pathname.slice("/api/oauth/clients/".length);
      if (!tail) return new Response("not found", { status: 404 });
      const approveSuffix = "/approve";
      if (tail.endsWith(approveSuffix)) {
        const clientId = decodeURIComponent(tail.slice(0, -approveSuffix.length));
        if (!clientId || clientId.includes("/")) {
          return new Response("not found", { status: 404 });
        }
        return handleApproveClient(req, clientId, {
          db: getDb(),
          issuer: oauthDeps(req).issuer,
        });
      }
      const clientId = decodeURIComponent(tail);
      if (!clientId || clientId.includes("/")) {
        return new Response("not found", { status: 404 });
      }
      return handleGetClient(req, clientId, {
        db: getDb(),
        issuer: oauthDeps(req).issuer,
      });
    }

    // Canonical login/logout. The handlers themselves are unchanged from
    // when they lived at /admin/login + /admin/logout; the rename surfaced
    // via #231-followup so the URL reflects the surface's actual scope
    // (entry point for ALL parachute auth — not admin-only). The
    // /admin/login and /admin/logout paths 301 to here, dispatched at the
    // top of this fn alongside the other back-compat redirects.
    if (pathname === "/login") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method === "GET") return handleAdminLoginGet(getDb(), req);
      if (req.method === "POST") return handleAdminLoginPost(getDb(), req);
      return new Response("method not allowed", { status: 405 });
    }

    if (pathname === "/logout") {
      if (!getDb) return new Response("hub db not configured", { status: 503 });
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return handleAdminLogoutPost(getDb(), req);
    }

    // Legacy `/admin/config` (server-rendered module-config portal, #46)
    // retired post-SPA-rework. 301 → the SPA home so any bookmark or stale
    // post-login redirect lands somewhere useful. The route stays here in
    // dispatch order (above the /admin/* SPA catch-all) so the redirect
    // wins over a SPA shell render.
    if (pathname === "/admin/config" || pathname.startsWith("/admin/config/")) {
      return new Response(null, {
        status: 301,
        headers: { location: "/admin/vaults" },
      });
    }

    // /vault/<name>/* — per-vault content proxy. Stays as user-facing
    // surface (the Notes PWA loads through here, etc.). The bare `/vault`
    // and `/vault/new` paths were SPA routes pre-#231; they 301-redirect at
    // the top of dispatch now. Multi-segment requests like
    // `/vault/<unknown>/health` are vault-API shapes targeting a
    // non-existent vault and 404 directly — there's no SPA-shell fallback
    // here anymore (the SPA moved to /admin), so we can't accidentally
    // mask a backend 404 with HTML.
    if (pathname.startsWith("/vault/")) {
      const proxied = await proxyToVault(req, manifestPath);
      if (proxied) return proxied;
      return new Response("not found", { status: 404 });
    }

    // /admin/* SPA mount. All non-SPA admin handlers (host-admin-token,
    // vault-admin-token, login, logout, config, api/auth/*, api/grants,
    // grants/*) ran above and either matched or returned. Anything that
    // makes it here under /admin/* is a SPA route or asset request; the
    // SPA's own router renders the page and handles 404 client-side for
    // unknown sub-paths.
    if (pathname === "/admin" || pathname === "/admin/") {
      // Unprefixed /admin → SPA shell pointed at the vault list (its home).
      // The SPA's basename is /admin, so the router will land on / and
      // render VaultsList.
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return serveSpa(spaDistDir, pathname, "/admin");
    }
    if (pathname.startsWith("/admin/")) {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return serveSpa(spaDistDir, pathname, "/admin");
    }

    // Generic services.json-driven dispatch for non-vault modules. Reaches
    // here only after every hub-owned prefix above has had its turn — so
    // `/`, `/admin/*`, `/oauth/*`, `/.well-known/*`, `/hub/*`, `/vault/*`,
    // `/api/*` are excluded by ordering, not by an explicit denylist (#182).
    const proxied = await proxyToService(req, manifestPath);
    if (proxied) return proxied;

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
    fetch: hubFetch(wellKnownDir, { getDb, issuer, loopbackPort: port }),
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
