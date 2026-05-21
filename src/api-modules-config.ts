/**
 * `/api/modules/:short/config[/schema]` — admin SPA's module-config surface.
 *
 * The admin SPA renders a generic per-module config form at
 * `/admin/modules/<short>/config`. It fetches three things off this hub-side
 * endpoint:
 *
 *   - `GET /api/modules/:short/config/schema` → the module's draft-07 JSON
 *     Schema (`{type:"object", properties:{...}, required:[...]}`).
 *   - `GET /api/modules/:short/config`         → the module's current
 *     resolved values (keys present in the schema; `writeOnly` keys omitted).
 *   - `PUT /api/modules/:short/config`         → write new values; module
 *     validates against its own schema and 4xx's on shape errors.
 *
 * Hub doesn't own the schema or the values — it just proxies to the module's
 * own runtime endpoints (`/.parachute/config/schema`, `/.parachute/config`).
 * Two reasons to wrap rather than expose the proxy directly:
 *
 *   1. **Scope translation (Option A).** Modules enforce per-module scopes
 *      on `/.parachute/config*` (e.g. scribe requires `scribe:admin`). The
 *      admin SPA's session-derived bearer carries `parachute:host:admin`,
 *      not `<short>:admin`. We mint a fresh short-lived `<short>:admin`
 *      JWT at proxy time so the upstream auth gate is satisfied without
 *      handing the operator a permanent module-scoped bearer.
 *   2. **Curated set + clean errors.** We restrict the surface to
 *      `CURATED_MODULES` (vault / notes / scribe) and surface a clean
 *      "module not installed" / "module has no config schema" empty state
 *      rather than the upstream's raw 404. The admin UI gets a consistent
 *      contract across modules even if individual modules drift on shape.
 *
 * Bearer-gated on `parachute:host:admin` (same scope as install / upgrade —
 * config writes are destructive operator-only state changes). A read-only
 * `parachute:host:auth` token gets 403 here. The SPA's host-admin mint at
 * `/admin/host-admin-token` carries both scopes so the SPA path works.
 *
 * Option A vs B trade-off (Aaron's hub#260 brief): hub mints a one-shot
 * `<short>:admin` JWT (audience = module short, ttl = 60s) and proxies
 * the request with that bearer. The alternative (modules accept
 * `parachute:host:admin` as a master scope) would centralize the override
 * in the wrong place — each module would need to know hub's scope vocabulary
 * and the master-scope concept would creep into module auth surfaces. The
 * mint-and-forward shape keeps every module ignorant of hub's session model
 * — they enforce their own scope as if a real `<short>:admin` token came
 * over the wire, which is exactly what hub gave them.
 */

import type { Database } from "bun:sqlite";
import { CURATED_MODULES, type CuratedModuleShort } from "./api-modules.ts";
import { signAccessToken, validateAccessToken } from "./jwt-sign.ts";
import { FIRST_PARTY_FALLBACKS } from "./service-spec.ts";
import { readManifest } from "./services-manifest.ts";

/** Scope required on the SPA's bearer to call any of these endpoints. */
export const API_MODULES_CONFIG_REQUIRED_SCOPE = "parachute:host:admin";

/** TTL on the minted module-scoped JWT we forward upstream. */
export const MODULE_CONFIG_PROXY_TOKEN_TTL_SECONDS = 60;

/** client_id stamped on the minted proxy token. Audit-friendly. */
export const MODULE_CONFIG_PROXY_CLIENT_ID = "parachute-hub-module-config-proxy";

export interface ApiModulesConfigDeps {
  db: Database;
  /** Hub origin — sets `iss` on the minted proxy token AND validates the SPA bearer. */
  issuer: string;
  /** services.json path. Module-mount + port come from here. */
  manifestPath: string;
  /**
   * Loopback fetch — production calls `fetch()`; tests inject a fake that
   * returns a canned Response without binding a port. Defaults to global
   * `fetch`.
   */
  upstreamFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Test seam over wall-clock — passed through to `signAccessToken`. */
  now?: () => Date;
}

interface PathMatch {
  short: CuratedModuleShort;
  /** `""` for `/api/modules/<short>/config`, `"schema"` for `.../schema`. */
  suffix: "" | "schema";
}

/**
 * Parse `/api/modules/<short>/config` or `/api/modules/<short>/config/schema`.
 * Returns undefined for any other shape so the caller can fall through to
 * other `/api/modules/...` handlers (install / upgrade / etc.).
 */
export function parseModulesConfigPath(pathname: string): PathMatch | undefined {
  const prefix = "/api/modules/";
  if (!pathname.startsWith(prefix)) return undefined;
  const tail = pathname.slice(prefix.length);
  // Accept exactly `<short>/config` or `<short>/config/schema`.
  const m = tail.match(/^([a-z][a-z0-9-]*)\/config(\/schema)?$/);
  if (!m) return undefined;
  const short = m[1];
  if (!CURATED_MODULES.includes(short as CuratedModuleShort)) return undefined;
  return {
    short: short as CuratedModuleShort,
    suffix: m[2] ? "schema" : "",
  };
}

/**
 * Look up a module's upstream `http://127.0.0.1:<port>/<mount>` base URL.
 * Returns `{installed: false}` when the module isn't in services.json —
 * the SPA renders an empty state pointing the operator at /admin/modules
 * to install it first.
 *
 * `hostsBareParachute` is true when the module declares `/.parachute` in
 * its `paths[]`, meaning it serves the universal module-protocol endpoints
 * at the bare URL (no module-name prefix) — runner is the first example.
 * This is independent of `stripPrefix`: runner ships
 * `paths: ["/runner", "/.parachute"]` with `stripPrefix: false` because its
 * `/runner/jobs` admin endpoints want the literal `/runner` prefix, but
 * `/.parachute/config` is hosted bare. See `buildUpstreamPath`.
 */
function resolveUpstream(
  short: CuratedModuleShort,
  manifestPath: string,
):
  | {
      installed: true;
      port: number;
      mount: string;
      stripPrefix: boolean;
      hostsBareParachute: boolean;
    }
  | { installed: false } {
  const fb = FIRST_PARTY_FALLBACKS[short];
  if (!fb) return { installed: false };
  const manifest = readManifest(manifestPath);
  const entry = manifest.services.find((s) => s.name === fb.manifest.manifestName);
  if (!entry) return { installed: false };
  // Mount = the first path the service registers (canonical convention
  // matches `findServiceUpstream` in hub-server.ts). Strip prefix mirrors
  // the proxy's `stripPrefixFor` — explicit on-entry wins, fallback supplies
  // the default. We compute it here rather than threading the proxy helper
  // because we're constructing the upstream URL ourselves, not piggy-backing
  // on `proxyRequest`.
  const mount = entry.paths[0] ?? fb.manifest.paths[0] ?? "/";
  const stripPrefix =
    entry.stripPrefix !== undefined ? entry.stripPrefix : (fb.manifest.stripPrefix ?? false);
  // Check both the live services.json entry (operator-authoritative) and the
  // vendored fallback (so a `bun link` install without a written entry still
  // routes correctly). Match a trailing slash too — `["/.parachute/"]` is the
  // same intent as `["/.parachute"]`.
  const isBareParachute = (p: string): boolean =>
    p === "/.parachute" || p === "/.parachute/" || p.startsWith("/.parachute/");
  const hostsBareParachute =
    entry.paths.some(isBareParachute) || fb.manifest.paths.some(isBareParachute);
  return { installed: true, port: entry.port, mount, stripPrefix, hostsBareParachute };
}

/**
 * Build the upstream URL for `.parachute/config[/schema]`.
 *
 * The `/.parachute/*` endpoints (info, config, config/schema, clear-credential)
 * are the **universal module protocol** — every module speaks them, and the
 * shape they take depends on how the module exposes its mount(s):
 *
 *   1. **Module declares `/.parachute` in its `paths[]`** (runner-shape):
 *      the module hosts the bare URL `/.parachute/config[/schema]` directly
 *      and the proxy forwards there with no prefix, regardless of
 *      `stripPrefix`. This is the explicit "I serve the universal endpoints
 *      at the bare URL" declaration.
 *   2. **`stripPrefix: true`** (scribe-shape): the proxy strips the module
 *      mount on every request, so the bare `/.parachute/config[/schema]`
 *      is what the module sees on the wire — same result as case 1.
 *   3. **`stripPrefix: false` and no `/.parachute` in paths** (vault/notes-
 *      shape): the proxy preserves the mount prefix
 *      (`/vault/default/.parachute/config`). Vault routes its
 *      `.parachute/config` per-vault, scoped under the `/vault/<name>` mount,
 *      so it explicitly NEEDS the prefix to know which vault the request
 *      targets.
 *
 * Case 1 was the gap that hub#307 fixed: runner ships
 * `paths: ["/runner", "/.parachute"]` with `stripPrefix: false`. Before this
 * fix, the proxy built `/runner/.parachute/config` because it only saw
 * `paths[0]` and the stripPrefix flag — runner's HTTP server matches
 * `/.parachute/config` literally and 404'd. Detecting the `/.parachute`
 * declaration in `paths[]` lets runner (and any future module with the same
 * shape) route correctly without affecting vault.
 */
function buildUpstreamPath(
  mount: string,
  stripPrefix: boolean,
  hostsBareParachute: boolean,
  suffix: "" | "schema",
): string {
  const inner = suffix === "schema" ? "/.parachute/config/schema" : "/.parachute/config";
  // Universal-protocol short-circuit: a module that declares `/.parachute`
  // in its paths[] hosts the bare URL — same upstream path whether
  // stripPrefix is true or false.
  if (hostsBareParachute) return inner;
  if (stripPrefix) return inner;
  // Normalize trailing slash (mirrors `findServiceUpstream`'s normalization
  // so a `paths: ["/scribe/"]` entry doesn't double-slash).
  const norm = mount.replace(/\/+$/, "") || "";
  return `${norm}${inner}`;
}

/**
 * Validate the SPA's bearer + extract its scopes. Returns either an error
 * response or the parsed sub.
 */
async function authorize(
  req: Request,
  deps: ApiModulesConfigDeps,
): Promise<Response | { sub: string }> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) return jsonError(401, "unauthenticated", "empty bearer token");
  try {
    const validated = await validateAccessToken(deps.db, bearer, deps.issuer);
    const sub = validated.payload.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    const scopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
    if (!scopes.includes(API_MODULES_CONFIG_REQUIRED_SCOPE)) {
      return jsonError(
        403,
        "insufficient_scope",
        `bearer token lacks ${API_MODULES_CONFIG_REQUIRED_SCOPE}`,
      );
    }
    return { sub };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }
}

/**
 * Mint a short-lived `<short>:admin` JWT to forward upstream. Re-uses the
 * existing `signAccessToken` plumbing (active signing key from the DB,
 * RS256, iss-stamped); audience = `short` so the module's audience check
 * passes. The token is NOT recorded in the tokens registry — it's a
 * one-shot proxy artifact, dies on its own in 60s, and we never hand it
 * to a caller.
 */
async function mintProxyToken(
  short: CuratedModuleShort,
  sub: string,
  deps: ApiModulesConfigDeps,
): Promise<string> {
  const opts: Parameters<typeof signAccessToken>[1] = {
    sub,
    scopes: [`${short}:admin`],
    audience: short,
    clientId: MODULE_CONFIG_PROXY_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: MODULE_CONFIG_PROXY_TOKEN_TTL_SECONDS,
  };
  if (deps.now) opts.now = deps.now;
  const signed = await signAccessToken(deps.db, opts);
  return signed.token;
}

/**
 * Top-level dispatcher for `/api/modules/:short/config[/schema]`.
 *
 *   - `GET    /api/modules/:short/config/schema` → upstream `/.parachute/config/schema`
 *   - `GET    /api/modules/:short/config`        → upstream `/.parachute/config`
 *   - `PUT    /api/modules/:short/config`        → upstream `/.parachute/config` (PUT)
 *
 * Other verbs return 405.
 */
export async function handleApiModulesConfig(
  req: Request,
  match: PathMatch,
  deps: ApiModulesConfigDeps,
): Promise<Response> {
  // Method gate per route. PUT only valid on the bare `config` path.
  if (match.suffix === "schema") {
    if (req.method !== "GET") return jsonError(405, "method_not_allowed", "use GET");
  } else {
    if (req.method !== "GET" && req.method !== "PUT") {
      return jsonError(405, "method_not_allowed", "use GET or PUT");
    }
  }

  // Auth.
  const authOut = await authorize(req, deps);
  if (authOut instanceof Response) return authOut;
  const { sub } = authOut;

  // Resolve upstream from services.json. Not-installed = clean empty state
  // so the SPA can prompt the operator to install first.
  const upstream = resolveUpstream(match.short, deps.manifestPath);
  if (!upstream.installed) {
    return jsonError(
      404,
      "module_not_installed",
      `module "${match.short}" is not installed; visit /admin/modules to install it first`,
    );
  }

  // Mint the per-request `<short>:admin` proxy token (Option A).
  let proxyToken: string;
  try {
    proxyToken = await mintProxyToken(match.short, sub, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(500, "mint_failed", `failed to mint proxy token — ${msg}`);
  }

  // Build upstream URL.
  const path = buildUpstreamPath(
    upstream.mount,
    upstream.stripPrefix,
    upstream.hostsBareParachute,
    match.suffix,
  );
  const url = `http://127.0.0.1:${upstream.port}${path}`;

  // Forward. We carry method + body through. The SPA's Authorization
  // header is dropped (it's the host-admin scope, not what the module
  // wants); we substitute the freshly-minted module-scoped JWT.
  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers: {
      authorization: `Bearer ${proxyToken}`,
      // Preserve content-type on PUT — modules parse JSON bodies based on
      // it. Default to application/json so a SPA that forgot the header
      // doesn't accidentally hit a text/plain body path upstream.
      "content-type": req.headers.get("content-type") ?? "application/json",
      accept: req.headers.get("accept") ?? "application/json",
    },
    redirect: "manual",
  };
  if (req.method === "PUT") {
    init.body = req.body;
    init.duplex = "half";
  }

  let upstreamRes: Response;
  try {
    const fetchFn = deps.upstreamFetch ?? fetch;
    upstreamRes = await fetchFn(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(
      502,
      "upstream_unreachable",
      `module "${match.short}" upstream unreachable: ${msg}`,
    );
  }

  // Special case: a module GET-schema that returns 404 means the module
  // is up but doesn't expose `.parachute/config/schema`. Surface a
  // distinguishable error so the SPA can render "this module has no
  // operator-editable config" rather than a generic 404. Same for the
  // bare `/.parachute/config` GET (some module versions may ship one
  // without the other; we treat both upstream 404s as "no schema").
  if (upstreamRes.status === 404 && req.method === "GET") {
    return jsonError(
      404,
      "no_config_schema",
      `module "${match.short}" does not expose a config schema at /.parachute/config/schema`,
    );
  }

  // For all other responses, forward verbatim — body, status, and
  // content-type. Modules already shape their own error bodies (scribe
  // uses `{error, message, errors[]}` on a 400 validation fail); the
  // SPA renders the module's message inline.
  const body = await upstreamRes.text();
  const headers = new Headers();
  const ct = upstreamRes.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  else headers.set("content-type", "application/json");
  return new Response(body, { status: upstreamRes.status, headers });
}

function jsonError(status: number, code: string, description: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
