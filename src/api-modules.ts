/**
 * `GET /api/modules` — admin SPA's module-management surface.
 *
 * Combines three sources into a single per-module row:
 *
 *   - **Curated availability** — vault, notes, scribe, runner (the v0.6
 *     release bar). The Phase-2 marketplace will broaden this; for now
 *     it's hardcoded so the admin UI has a stable "what can I install?"
 *     list even on a fresh container where services.json is empty.
 *   - **Installed state** — services.json reads (version, installDir).
 *   - **Supervisor state** — per-module run status (`running` / `stopped`
 *     / `crashed` / `starting` / `restarting`) + pid. Absent when the
 *     hub is in CLI mode (no supervisor injected through HubFetchDeps).
 *
 * Bearer-gated on `parachute:host:auth` to match the rest of `/api/auth/*`
 * and `/api/grants` — the admin SPA mints this scope via
 * `/admin/host-admin-token` and threads it as `Authorization: Bearer`.
 *
 * The `latest_version` field is opportunistic: an npm registry probe with
 * a short timeout. On failure it's null and the UI just shows "check
 * later" — we don't fail the whole request because one network blip
 * shouldn't keep the page from rendering installed modules.
 */

import type { Database } from "bun:sqlite";
import {
  type ModuleInstallChannel,
  getModuleInstallChannel,
  isModuleInstallChannel,
  setModuleInstallChannel,
} from "./hub-settings.ts";
import { validateAccessToken } from "./jwt-sign.ts";
import {
  type ModuleManifest,
  readModuleManifest as defaultReadModuleManifest,
} from "./module-manifest.ts";
import { FIRST_PARTY_FALLBACKS, KNOWN_MODULES } from "./service-spec.ts";
// `FIRST_PARTY_FALLBACKS` and `KNOWN_MODULES` are both consulted by
// `lookupModule` below — the former for notes/channel (vendored manifests
// still required) and the latter for vault/scribe/runner (post-FALLBACK
// retirement, hub#310). The local helper hides the split from the rest of
// this file.
import { type UiSubUnit, type UiSubUnitStatus, readManifest, readManifestLenient } from "./services-manifest.ts";
import type { ModuleState, Supervisor } from "./supervisor.ts";

/**
 * Resolve a curated module to the display + install bootstrap data the
 * admin SPA renders. Reads from FIRST_PARTY_FALLBACKS (notes / channel)
 * first, KNOWN_MODULES (vault / scribe / runner) second.
 *
 * Returns `undefined` if the short isn't curated — `CURATED_MODULES` is a
 * const tuple intersected with both tables, so undefined here is a programmer
 * error (caught by the type system in practice).
 */
function lookupModule(
  short: string,
): { package: string; manifestName: string; displayName: string; tagline: string } | undefined {
  const fb = FIRST_PARTY_FALLBACKS[short];
  if (fb) {
    return {
      package: fb.package,
      manifestName: fb.manifest.manifestName,
      displayName: fb.manifest.displayName ?? fb.manifest.name,
      tagline: fb.manifest.tagline ?? "",
    };
  }
  const km = KNOWN_MODULES[short];
  if (km) {
    return {
      package: km.package,
      manifestName: km.manifestName,
      displayName: km.displayName,
      tagline: km.tagline,
    };
  }
  return undefined;
}

/** Scope required on the bearer token to call this endpoint. */
export const API_MODULES_REQUIRED_SCOPE = "parachute:host:auth";

/**
 * Curated module short-names for v0.6 Render self-host. Marketplace is
 * Phase 2 — until then, the admin UI offers exactly these. Order is the
 * recommended install order (vault → app → notes → scribe → runner;
 * app auto-bootstraps notes-ui on first boot — `notes` here is the
 * notes-daemon back-compat install path retained for operators still on
 * the pre-app architecture; scribe + runner come last because they
 * depend on a working vault + app to be useful).
 */
export const CURATED_MODULES = ["vault", "app", "notes", "scribe", "runner"] as const;
export type CuratedModuleShort = (typeof CURATED_MODULES)[number];

export interface ApiModulesDeps {
  db: Database;
  issuer: string;
  manifestPath: string;
  supervisor?: Supervisor;
  /**
   * NPM dist-tag probe. Returns the version string at the given dist-tag,
   * or null on failure / timeout / unknown tag. Default is the real npm
   * registry; tests inject a fake so they don't hit the network. Channel
   * arg lets the probe respect the operator's configured install channel
   * (`rc` operators see the rc version as the upgrade target, not the
   * stable `latest`).
   */
  fetchLatestVersion?: (pkg: string, channel: ModuleInstallChannel) => Promise<string | null>;
  /**
   * Module-level cache TTL for `latest_version` probes, in ms. Default
   * 5 minutes — long enough that a tab refresh doesn't slam npm,
   * short enough that an `npm publish` shows up by the next minute the
   * operator clicks Upgrade. Test seam: pass 0 to disable caching.
   */
  cacheTtlMs?: number;
  /** Test seam over wall-clock. */
  now?: () => number;
  /**
   * Override the per-module `.parachute/module.json` reader. Production
   * reads from disk via `module-manifest.readModuleManifest`; tests
   * inject a fake. Used to surface `managementUrl` on the wire shape
   * (hub#342 — drives the admin SPA Modules page's "Open" button).
   */
  readModuleManifest?: (installDir: string) => Promise<ModuleManifest | null>;
}

/**
 * Wire shape for a sub-unit surfaced under a module row. Mirrors the
 * services.json `UiSubUnit` map value, with the map key promoted to `name`
 * — same shape `WellKnownUiSubUnit` uses. Snake-case keys to match the
 * surrounding response (`display_name`, `oauth_client_id`).
 *
 * Discovery + admin SPA both consume this without reaching back into
 * services.json — `display_name` / `path` / `icon_url` are sufficient to
 * render the sub-row; `oauth_client_id` lets future SPA work cross-link
 * to `/api/oauth/clients/<id>` for approval status without an extra
 * resolver. Per parachute-app design doc §12.
 */
interface UiSubUnitWireShape {
  name: string;
  display_name: string;
  path: string;
  tagline: string | null;
  icon_url: string | null;
  version: string | null;
  oauth_client_id: string | null;
  status: UiSubUnitStatus | null;
}

interface ModuleWireShape {
  short: string;
  package: string;
  display_name: string;
  tagline: string;
  available: boolean;
  installed: boolean;
  installed_version: string | null;
  latest_version: string | null;
  supervisor_status: ModuleState["status"] | null;
  pid: number | null;
  /**
   * The path on disk where the module is installed, if known. Surfaces
   * the BUN_INSTALL or bun-link install location for operator debug —
   * the UI can show "installed at /parachute/modules/node_modules/..."
   * so a vanished disk is obvious.
   */
  install_dir: string | null;
  /**
   * Hierarchical sub-units beneath this module (hub#313). Empty when the
   * module's services.json row doesn't declare `uis` (vault, scribe, notes,
   * runner today). Used by parachute-app to surface each hosted UI as its
   * own discoverable sub-row under the App module. Per parachute-app
   * design doc §12.
   */
  uis: UiSubUnitWireShape[];
  /**
   * Canonical user-facing URL for this module's own UI (hub#342). Drives
   * the admin SPA Modules page's "Open" button — clicking lands the
   * operator on the module's own surface (combining view + configure
   * per Aaron's framing: each module ships its own UI handling both).
   *
   * Resolution order:
   *   1. Module's `managementUrl` from `<installDir>/.parachute/module.json`,
   *      resolved against the module's mounted URL — matches the
   *      well-known doc's resolution for vault rows.
   *   2. Module's `uiUrl` from the same manifest, when it's the only
   *      declared surface — for modules where the user-facing UI IS
   *      the operator UI (App today).
   *   3. Null when the module hasn't declared either field — the SPA
   *      renders a disabled "Open" tooltip ("module hasn't shipped an
   *      admin UI yet"). Tracked as follow-up issues per module
   *      (scribe#53, runner#8 today).
   *
   * Always an absolute path on the hub origin (leading `/`) — the SPA
   * navigates same-origin, no need to worry about cross-origin
   * managementUrls (those are an escape hatch for off-origin admin
   * surfaces, unused by first-party modules today).
   */
  management_url: string | null;
}

interface ModulesResponse {
  modules: ModuleWireShape[];
  /**
   * Whether the supervisor is wired into this hub. `false` under
   * `parachute expose` / on-box CLI; the UI greys out install/start
   * actions because the supervisor's the only path that drives them
   * (the on-box `parachute start <svc>` flow lives outside hub).
   */
  supervisor_available: boolean;
  /**
   * Current module install channel (`latest` | `rc`). Surfaced here so
   * the SPA can render the toggle without a second roundtrip. Read on
   * each request — the hub-settings layer is the source of truth, and
   * a toggle change is visible to the next GET without a hub restart
   * (hub#275).
   */
  module_install_channel: ModuleInstallChannel;
}

interface CachedVersion {
  value: string | null;
  fetchedAt: number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const latestVersionCache = new Map<string, CachedVersion>();

/**
 * Default `fetchLatestVersion`. Hits the npm registry's package
 * metadata endpoint with a 3s AbortController timeout. Returns null on
 * any failure (timeout, network, parse, missing dist-tag) — the UI
 * tolerates a missing latest_version, so we keep the response shape
 * stable even when the registry is flaky.
 */
export async function defaultFetchLatestVersion(
  pkg: string,
  channel: ModuleInstallChannel,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    // npm exposes per-package dist-tags at /-/package/<pkg>/dist-tags as a
    // simple map (e.g. `{"latest": "0.2.0-rc.4", "rc": "0.2.0-rc.13"}`).
    // Look up the configured channel; fall back to `latest` if the channel
    // is missing (e.g. a package that hasn't been published with @rc yet).
    // Previously hit `/${pkg}/latest` directly — that endpoint always
    // returns the `latest` dist-tag's package doc regardless of channel,
    // so an operator on @rc saw the @latest version as the "available"
    // upgrade target (audit caught on Aaron's deploy 2026-05-25: app
    // showed "rc.4 available" while @rc was actually rc.13).
    // encodeURIComponent handles scoped packages: @openparachute/vault →
    // %40openparachute%2Fvault. npm resolves the encoded form correctly.
    const url = `https://registry.npmjs.org/-/package/${encodeURIComponent(pkg)}/dist-tags`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const tags = (await res.json()) as Record<string, unknown>;
    const fromChannel = tags[channel];
    if (typeof fromChannel === "string") return fromChannel;
    const fromLatest = tags.latest;
    return typeof fromLatest === "string" ? fromLatest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function handleApiModules(req: Request, deps: ApiModulesDeps): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }

  // Bearer presence + parsing.
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) {
    return jsonError(401, "unauthenticated", "empty bearer token");
  }

  // Bearer validation.
  let bearerScopes: string[];
  try {
    const validated = await validateAccessToken(deps.db, bearer, deps.issuer);
    if (typeof validated.payload.sub !== "string" || validated.payload.sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    bearerScopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }

  if (!bearerScopes.includes(API_MODULES_REQUIRED_SCOPE)) {
    return jsonError(403, "insufficient_scope", `bearer token lacks ${API_MODULES_REQUIRED_SCOPE}`);
  }

  // Load installed state from services.json. Missing file = empty manifest
  // (fresh container), which is the v0.6 hot path — readManifest already
  // returns { services: [] } for a missing file, so no extra branching.
  // Lenient read so a single bad row written by a buggy module install
  // (e.g. app@0.2.0-rc.4) doesn't take down /api/modules — see hub#406.
  const manifest = readManifestLenient(deps.manifestPath);
  const installedByShort = new Map<
    string,
    {
      version: string;
      installDir?: string;
      uis?: Record<string, UiSubUnit>;
      mountPath?: string;
    }
  >();
  for (const entry of manifest.services) {
    // Join services.json rows to CURATED_MODULES by manifestName. The
    // mapping table lives in lookupModule (which consults both
    // FIRST_PARTY_FALLBACKS and KNOWN_MODULES) — so a row written by a
    // self-registered vault / scribe / runner matches even though those
    // shorts no longer have FALLBACK entries (hub#310).
    for (const short of CURATED_MODULES) {
      const m = lookupModule(short);
      if (m?.manifestName === entry.name) {
        const value: {
          version: string;
          installDir?: string;
          uis?: Record<string, UiSubUnit>;
          mountPath?: string;
        } = { version: entry.version };
        if (entry.installDir !== undefined) value.installDir = entry.installDir;
        if (entry.uis !== undefined) value.uis = entry.uis;
        // First non-`.parachute` path is the module's user-facing mount
        // (`/app`, `/scribe`, `/vault/<name>`). Used below to resolve
        // a relative `managementUrl` to a full hub-origin path. Skips
        // `.parachute` entries because those are protocol mounts, not
        // user surfaces — every module declares one.
        const userPath = (entry.paths ?? []).find(
          (p) => p !== "/.parachute" && !p.startsWith("/.parachute/"),
        );
        if (userPath !== undefined) value.mountPath = userPath;
        installedByShort.set(short, value);
      }
    }
  }

  // Read each installed module's `.parachute/module.json` so we can
  // surface `managementUrl` on the wire shape (hub#342). Quiet on
  // per-entry errors: a malformed manifest on one module shouldn't 500
  // the whole catalog response — its row just renders with a null
  // management_url and the SPA shows the disabled "Open" tooltip.
  const readModuleManifestFn = deps.readModuleManifest ?? defaultReadModuleManifest;
  const managementUrlByShort = new Map<string, string>();
  await Promise.all(
    Array.from(installedByShort.entries()).map(async ([short, value]) => {
      if (!value.installDir) return;
      try {
        const m = await readModuleManifestFn(value.installDir);
        if (!m) return;
        // Resolution per the module-ui-declaration.md hierarchy:
        // managementUrl > uiUrl. Both are EITHER an absolute
        // http(s) URL OR a relative path. Relative paths are joined
        // against the module's mount path (entry.paths[0]) since both
        // surfaces conventionally live under it (vault's `/admin`,
        // app's `/admin`). Absolute URLs pass through verbatim.
        const candidate = m.managementUrl ?? m.uiUrl;
        if (candidate === undefined) return;
        if (/^https?:\/\//i.test(candidate)) {
          managementUrlByShort.set(short, candidate);
          return;
        }
        const mount = value.mountPath;
        if (mount === undefined) {
          // No user-facing mount declared — we can't resolve a relative
          // path. Skip rather than guess. Vault rows hit this when
          // services.json was hand-edited to remove the mount; the
          // disabled-tooltip state in the SPA is the right surface.
          return;
        }
        // Resolution rule (per module-ui-declaration.md):
        //   - Multi-instance modules (vault) declare a per-instance
        //     relative path (e.g. `/admin/`); hub prepends the mount
        //     (e.g. `/vault/default` + `/admin/` → `/vault/default/admin/`).
        //   - Single-instance modules (app, scribe, runner) declare a
        //     full hub-origin path that ALREADY includes the mount
        //     (e.g. `/app/admin/`, `/scribe/admin`); the mount must NOT
        //     be prepended again or the result is `/app/app/admin/`
        //     (the audit bug caught 2026-05-25 on the SPA's Services
        //     dropdown).
        // Detect by checking if candidate is already mount-prefixed.
        const tail = candidate.startsWith("/") ? candidate : `/${candidate}`;
        const alreadyMountPrefixed = tail === mount || tail.startsWith(`${mount}/`);
        managementUrlByShort.set(short, alreadyMountPrefixed ? tail : `${mount}${tail}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`api-modules: skipping managementUrl for ${short}: ${msg}`);
      }
    }),
  );

  // Supervisor state — per-module run status snapshot.
  const supervisor = deps.supervisor;
  const stateByShort = new Map<string, ModuleState>();
  if (supervisor) {
    for (const state of supervisor.list()) {
      stateByShort.set(state.short, state);
    }
  }

  // Resolve npm dist-tag in parallel — short timeout per request, cache
  // shared across requests so a fast UI poll doesn't slam the registry.
  // Channel-aware: an operator on @rc sees the rc-tagged version as the
  // upgrade target (not the stable @latest which may be older). Cache key
  // includes channel so a channel-toggle doesn't return a stale value.
  const fetchLatest = deps.fetchLatestVersion ?? defaultFetchLatestVersion;
  const cacheTtl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  const channel = getModuleInstallChannel(deps.db);

  const latestByShort = new Map<string, string | null>();
  await Promise.all(
    CURATED_MODULES.map(async (short) => {
      const m = lookupModule(short);
      if (!m) {
        latestByShort.set(short, null);
        return;
      }
      const pkg = m.package;
      const cacheKey = `${pkg}@${channel}`;
      const cached = latestVersionCache.get(cacheKey);
      if (cached && cacheTtl > 0 && now() - cached.fetchedAt < cacheTtl) {
        latestByShort.set(short, cached.value);
        return;
      }
      const value = await fetchLatest(pkg, channel);
      latestVersionCache.set(cacheKey, { value, fetchedAt: now() });
      latestByShort.set(short, value);
    }),
  );

  // Compose the wire shape. Curated order is the recommended install order;
  // installed modules outside the curated list (uncommon — only third-party)
  // are appended at the end with `available: false`.
  const modules: ModuleWireShape[] = [];
  for (const short of CURATED_MODULES) {
    const m = lookupModule(short);
    if (!m) continue;
    const installed = installedByShort.get(short);
    const state = stateByShort.get(short);
    modules.push({
      short,
      package: m.package,
      display_name: m.displayName,
      tagline: m.tagline,
      available: true,
      installed: installed !== undefined,
      installed_version: installed?.version ?? null,
      latest_version: latestByShort.get(short) ?? null,
      supervisor_status: state?.status ?? null,
      pid: state?.pid ?? null,
      install_dir: installed?.installDir ?? null,
      uis: toUisWireShape(installed?.uis),
      management_url: managementUrlByShort.get(short) ?? null,
    });
  }

  const body: ModulesResponse = {
    modules,
    supervisor_available: supervisor !== undefined,
    module_install_channel: getModuleInstallChannel(deps.db),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * `PUT /api/modules/channel` — operator-settable module install channel.
 *
 * Bearer-gated on `parachute:host:admin` (same scope as install/upgrade
 * — destructive-ish operator-only). Body: `{ "channel": "latest" | "rc" }`.
 * Writes through to `hub_settings.module_install_channel`; the next
 * runInstall / runUpgrade reads the new value (no hub restart needed).
 *
 * Why `:host:admin` rather than `:host:auth` (the GET scope): changing
 * the channel is an upstream-state change that affects every subsequent
 * module install + upgrade. Same boundary as a `bun add -g` itself.
 */
export const API_MODULES_CHANNEL_REQUIRED_SCOPE = "parachute:host:admin";

export interface ApiModulesChannelDeps {
  db: Database;
  issuer: string;
}

export async function handleApiModulesChannel(
  req: Request,
  deps: ApiModulesChannelDeps,
): Promise<Response> {
  if (req.method !== "PUT") {
    return jsonError(405, "method_not_allowed", "use PUT");
  }

  // Bearer presence + parsing.
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) {
    return jsonError(401, "unauthenticated", "empty bearer token");
  }

  // Bearer validation + scope check.
  try {
    const validated = await validateAccessToken(deps.db, bearer, deps.issuer);
    if (typeof validated.payload.sub !== "string" || validated.payload.sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    const scopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
    if (!scopes.includes(API_MODULES_CHANNEL_REQUIRED_SCOPE)) {
      return jsonError(
        403,
        "insufficient_scope",
        `bearer token lacks ${API_MODULES_CHANNEL_REQUIRED_SCOPE}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }

  // Parse + validate body.
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return jsonError(400, "invalid_request", "request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return jsonError(400, "invalid_request", "request body must be a JSON object");
  }
  const channel = (parsed as { channel?: unknown }).channel;
  if (!isModuleInstallChannel(channel)) {
    return jsonError(
      400,
      "invalid_channel",
      `channel must be one of: latest, rc (got ${JSON.stringify(channel)})`,
    );
  }

  setModuleInstallChannel(deps.db, channel);

  return new Response(JSON.stringify({ channel }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, code: string, description: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Map a services.json `uis` record to the snake-case wire shape the SPA
 * consumes. Each missing optional field on the source becomes an explicit
 * `null` on the wire so the consumer's shape is uniform — same convention
 * `install_dir` / `latest_version` follow on `ModuleWireShape`.
 *
 * Returns `[]` when the source is absent, so the response shape is uniform
 * across modules with and without `uis` (the SPA can `.map` unconditionally).
 */
function toUisWireShape(uis: Record<string, UiSubUnit> | undefined): UiSubUnitWireShape[] {
  if (!uis) return [];
  return Object.entries(uis).map(([name, u]) => ({
    name,
    display_name: u.displayName,
    path: u.path,
    tagline: u.tagline ?? null,
    icon_url: u.iconUrl ?? null,
    version: u.version ?? null,
    oauth_client_id: u.oauthClientId ?? null,
    status: u.status ?? null,
  }));
}

/**
 * Reset the in-memory `latest_version` cache. Tests call this between
 * runs to prevent state leakage across test cases; production never
 * needs it (the cache is per-process and short-TTL anyway).
 */
export function _clearLatestVersionCacheForTests(): void {
  latestVersionCache.clear();
}
