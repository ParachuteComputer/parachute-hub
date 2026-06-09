/**
 * `GET /api/modules` — admin SPA's module-management surface.
 *
 * Discovery is driven by SELF-REGISTRATION, not a whitelist (2026-06-09
 * modular-UI architecture, P2). The catalog is the UNION of three sources,
 * deduped by short name, each row carrying a `focus` tier:
 *
 *   - **Known/discoverable registry** — `discoverableShorts()` (KNOWN_MODULES ∪
 *     FIRST_PARTY_FALLBACKS): every module the hub can resolve a package +
 *     manifest for, so a fresh container shows the full "what can I install?"
 *     catalog even with an empty services.json.
 *   - **Installed state** — services.json reads (version, installDir). Any
 *     self-registered row surfaces here even if it isn't in the known registry.
 *   - **Supervisor state** — per-module run status (`running` / `stopped`
 *     / `crashed` / `starting` / `restarting`) + pid. Absent when the
 *     hub is in CLI mode (no supervisor injected through HubFetchDeps).
 *
 * `focus` ("core" | "experimental") comes from each module's `module.json`
 * when declared, else `focusForShort`'s default map. The SPA groups core first
 * + de-emphasizes experimental — it NEVER hides a module. This is what makes a
 * running, self-registered module (channel) visible + installable; the old
 * `CURATED_MODULES = ["vault","scribe"]` whitelist made it invisible.
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
import { validateHostAdminToken } from "./host-admin-token-validation.ts";
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
import type { ModuleFocus } from "./module-manifest.ts";
import {
  FIRST_PARTY_FALLBACKS,
  KNOWN_MODULES,
  discoverableShorts,
  focusForShort,
  shortNameForManifest,
} from "./service-spec.ts";
// `FIRST_PARTY_FALLBACKS` and `KNOWN_MODULES` are both consulted by
// `lookupModule` below — the former for notes/channel (vendored manifests
// still required) and the latter for vault/scribe/runner (post-FALLBACK
// retirement, hub#310). The local helper hides the split from the rest of
// this file. `discoverableShorts` enumerates their UNION — the
// self-registration-driven discovery surface that replaced the old
// `CURATED_MODULES` whitelist (2026-06-09 modular-UI architecture, P2).
import {
  type UiSubUnit,
  type UiSubUnitStatus,
  readManifest,
  readManifestLenient,
} from "./services-manifest.ts";
import type { ModuleStartError, ModuleState, Supervisor } from "./supervisor.ts";

/**
 * Resolve a known module to the display + install bootstrap data the admin SPA
 * renders. Reads from FIRST_PARTY_FALLBACKS (notes / channel) first,
 * KNOWN_MODULES (vault / scribe / runner / surface) second.
 *
 * Returns `undefined` if the short is in neither table — a genuinely
 * third-party module discovered only via services.json / the supervisor. The
 * discovery handler synthesizes a minimal row for those rather than dropping
 * them (2026-06-09 modular-UI architecture — show all self-registered modules).
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
 * Recommended fresh-install ORDER for the `core`-tier modules. NO LONGER a
 * discovery/install whitelist (2026-06-09 modular-UI architecture, P2 —
 * retired the gating role). Discovery now enumerates the UNION of
 * `services.json` ∪ `discoverableShorts()` (KNOWN_MODULES ∪
 * FIRST_PARTY_FALLBACKS) ∪ supervisor, so every self-registered/known
 * module appears — the channel-not-installed bug (running but invisible)
 * is gone.
 *
 * This constant survives only as a sort hint: shorts listed here float to the
 * top of the `core` group in the given order (vault first, scribe second).
 * Any `core`-tier module not named here still appears, sorted after these.
 * The install-path gate (`parseModulesPath`) now accepts any known short via
 * `isKnownModuleShort`, NOT membership in this tuple.
 *
 * `CuratedModuleShort` is retained as a loose typed-string key for the
 * lookup helpers (`getSpec`, `lookupModule`) that consume a short name — it
 * is no longer a closed enum of the only installable modules.
 */
export const CURATED_MODULES = ["vault", "scribe"] as const;
export type CuratedModuleShort = string;

export interface ApiModulesDeps {
  db: Database;
  issuer: string;
  /**
   * The SET of origins the hub legitimately answers on — loopback aliases ∪
   * expose-state public origin ∪ platform/env origin ∪ the per-request
   * `issuer`. The host-admin bearer's `iss` is validated against THIS set, not
   * the single per-request `issuer` (hub#516): `parachute status` reads this
   * endpoint on loopback presenting the operator token, whose `iss` is the
   * hub's public origin after `expose`. Built via `buildHubBoundOrigins` at the
   * call site. When absent, falls back to the single-element `[issuer]` set
   * (the prior strict per-request behavior) so non-HTTP callers / tests are
   * unaffected.
   */
  knownIssuers?: readonly string[];
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
  /**
   * Discovery tier (2026-06-09 modular-UI architecture). `core` modules render
   * in the headline group; `experimental` modules render in a de-emphasized
   * "Experimental" group below — never hidden. Resolved from the module's
   * `module.json` `focus` when declared, else `focusForShort`'s default map
   * (vault/scribe/hub/surface → core, channel/runner/others → experimental).
   */
  focus: ModuleFocus;
  available: boolean;
  installed: boolean;
  installed_version: string | null;
  latest_version: string | null;
  supervisor_status: ModuleState["status"] | null;
  pid: number | null;
  /**
   * Structured supervisor start-failure detail (§6.5 / §6.4), when the
   * supervisor recorded one for this module — a preflight `MissingDependencyError`
   * or the alive-but-never-bound shape (hub#487). Mirrors the services.json
   * `lastStartError` the detached path persists, so `parachute status` and the
   * SPA keep the SAME friendly missing-dependency surface (#188) whether a
   * module was started via the supervisor or the detached path. Null when the
   * module started cleanly (or the hub is in pidfile/CLI mode with no supervisor).
   */
  supervisor_start_error: ModuleStartError | null;
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
  /**
   * Where the module's OWN config/admin surface lives (2026-06-09 modular-UI
   * architecture, P3). Resolved server-side from the module's
   * `.parachute/module.json` `configUiUrl`, joined against its mount path the
   * same way `management_url` resolves `managementUrl`/`uiUrl`. Drives the
   * Modules page's consistent **Configure** action — clicking lands the
   * operator on the module's own config UI (channel `/channel/admin`, scribe
   * `/scribe/admin`, …), which mints its admin Bearer from the hub's
   * cookie-gated `/admin/module-token/<short>` (or `/admin/channel-token`).
   *
   * Null when the module hasn't declared `configUiUrl` — the SPA omits the
   * Configure action for that module rather than rendering a dead button.
   * Distinct from `management_url`: a module may declare one, both, or
   * neither. Channel declares `configUiUrl: "/channel/admin"` + `uiUrl`;
   * vault declares `managementUrl` (its admin SPA is the config surface).
   */
  config_ui_url: string | null;
}

/**
 * Per-module supervisor snapshot for the `supervised` array (hub#539). The
 * supervisor-derived subset of `ModuleWireShape` — enough for `status` to
 * render a run-state row for a module that isn't in the curated catalog.
 */
interface SupervisedSnapshotWire {
  short: string;
  installed: boolean;
  installed_version: string | null;
  supervisor_status: ModuleState["status"] | null;
  pid: number | null;
  supervisor_start_error: ModuleStartError | null;
}

interface ModulesResponse {
  modules: ModuleWireShape[];
  /**
   * Run-state for EVERY module the supervisor is currently tracking — not just
   * the curated `modules` (vault/scribe). Non-curated supervised modules (e.g.
   * the `surface` UI host) appear here so `parachute status` / the SPA can
   * reflect their real run-state instead of mislabelling them `inactive`
   * because they're absent from the curated catalog (hub#539). Curated modules
   * also appear here (harmless — consumers dedupe by `short`, preferring the
   * richer `modules` entry). Same supervisor-field shape as a `modules` entry.
   */
  supervised: SupervisedSnapshotWire[];
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

  // Bearer validation. Host-admin (operator / SPA) token: accept the `iss`
  // against the SET of origins the hub answers on, not the single per-request
  // issuer (hub#516) — `parachute status` reads this on loopback presenting the
  // operator token, whose `iss` is the hub's public origin after `expose`. This
  // surface gates on the non-requestable `parachute:host:auth` scope below, so
  // the relaxation only ever touches the hub's own self-issued host-admin
  // credentials and cannot reach an OAuth token's validation.
  let bearerScopes: string[];
  try {
    const validated = await validateHostAdminToken(
      deps.db,
      bearer,
      deps.knownIssuers ?? [deps.issuer],
    );
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
    // Join services.json rows to a short via `shortNameForManifest` — covers
    // every known module (FIRST_PARTY_FALLBACKS ∪ KNOWN_MODULES ∪ legacy
    // aliases), so a self-registered channel / runner / surface row matches
    // and becomes discoverable. Rows whose manifestName resolves to no known
    // short (genuinely third-party) fall back to the row's own name as the
    // short — they still surface as installed, de-emphasized (2026-06-09
    // modular-UI architecture, P2 — discovery from self-registration, not the
    // CURATED_MODULES whitelist).
    const short = shortNameForManifest(entry.name) ?? entry.name;
    const value: {
      version: string;
      installDir?: string;
      uis?: Record<string, UiSubUnit>;
      mountPath?: string;
    } = { version: entry.version };
    if (entry.installDir !== undefined) value.installDir = entry.installDir;
    if (entry.uis !== undefined) value.uis = entry.uis;
    // First non-`.parachute` path is the module's user-facing mount
    // (`/surface`, `/scribe`, `/vault/<name>`). Used below to resolve a
    // relative `managementUrl` to a full hub-origin path. Skips `.parachute`
    // entries because those are protocol mounts, not user surfaces — every
    // module declares one.
    const userPath = (entry.paths ?? []).find(
      (p) => p !== "/.parachute" && !p.startsWith("/.parachute/"),
    );
    if (userPath !== undefined) value.mountPath = userPath;
    installedByShort.set(short, value);
  }

  // Read each installed module's `.parachute/module.json` so we can
  // surface `managementUrl` on the wire shape (hub#342). Quiet on
  // per-entry errors: a malformed manifest on one module shouldn't 500
  // the whole catalog response — its row just renders with a null
  // management_url and the SPA shows the disabled "Open" tooltip.
  const readModuleManifestFn = deps.readModuleManifest ?? defaultReadModuleManifest;
  const managementUrlByShort = new Map<string, string>();
  // The module's OWN config surface (2026-06-09 modular-UI architecture, P3) —
  // resolved from `configUiUrl` the same way `managementUrl` is. Drives the
  // consistent Configure action.
  const configUiUrlByShort = new Map<string, string>();
  // Manifest-declared `focus` per installed short. Prefer this over the default
  // map when composing the wire shape (2026-06-09 modular-UI architecture).
  const declaredFocusByShort = new Map<string, ModuleFocus>();
  await Promise.all(
    Array.from(installedByShort.entries()).map(async ([short, value]) => {
      if (!value.installDir) return;
      try {
        const m = await readModuleManifestFn(value.installDir);
        if (!m) return;
        if (m.focus !== undefined) declaredFocusByShort.set(short, m.focus);
        // Resolution per the module-ui-declaration.md hierarchy:
        // managementUrl > uiUrl. Unified semantics (B4): http(s):// verbatim ·
        // leading-"/" = origin-absolute verbatim · relative = joined under the
        // module's mount path (entry.paths[0]) — the per-instance form.
        const resolvedManagement = resolveModuleUrl(
          m.managementUrl ?? m.uiUrl,
          value.mountPath,
          short,
        );
        if (resolvedManagement !== undefined) managementUrlByShort.set(short, resolvedManagement);
        // The config surface resolves with the SAME rule. A module may declare
        // `configUiUrl` independently of `managementUrl` — channel ships
        // `configUiUrl: "/channel/admin"` (single-instance, origin-absolute)
        // alongside a separate `uiUrl`.
        const resolvedConfig = resolveModuleUrl(m.configUiUrl, value.mountPath, short);
        if (resolvedConfig !== undefined) configUiUrlByShort.set(short, resolvedConfig);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`api-modules: skipping module URLs for ${short}: ${msg}`);
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

  // Discovery short list = UNION of the bootstrap registries (KNOWN_MODULES ∪
  // FIRST_PARTY_FALLBACKS via `discoverableShorts`), every services.json row's
  // short, and every supervised module's short — deduped, preserving registry
  // order first so the canonical modules lead (2026-06-09 modular-UI
  // architecture, P2). Every self-registered/known module appears; the
  // running-but-invisible class (channel) is gone.
  const discoverySet = new Set<string>(discoverableShorts());
  for (const short of installedByShort.keys()) discoverySet.add(short);
  for (const short of stateByShort.keys()) discoverySet.add(short);
  const discoveryShorts = Array.from(discoverySet);

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
    discoveryShorts.map(async (short) => {
      const m = lookupModule(short);
      if (!m) {
        // Third-party module known only from services.json / supervisor — no
        // npm package to probe.
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

  // Compose one wire row per discovered short. `focus` resolution: the
  // module's manifest-declared `focus` (when installed + declared) wins; else
  // the `focusForShort` default map. Sort: `core` group first (with the
  // CURATED_MODULES recommended-install order floated to the top of that
  // group), then `experimental` — the SPA renders the two groups; `focus`
  // never hides a module.
  const recommendedOrder = new Map<string, number>(
    (CURATED_MODULES as readonly string[]).map((s, i) => [s, i]),
  );
  const rows = discoveryShorts.map((short) => {
    const m = lookupModule(short);
    const installed = installedByShort.get(short);
    const state = stateByShort.get(short);
    const focus = focusForShort(short, declaredFocusByShort.get(short));
    const row: ModuleWireShape = {
      short,
      // Third-party (no known table entry) → fall back to the short as the
      // package label + the row's own display fields.
      package: m?.package ?? short,
      display_name: m?.displayName ?? short,
      tagline: m?.tagline ?? "",
      focus,
      // `available` historically meant "in the curated install catalog". Every
      // discovered short is now installable/managed, so it's always true for
      // known modules; a purely third-party services.json row (no install
      // package) is not hub-installable → false.
      available: m !== undefined,
      installed: installed !== undefined,
      installed_version: installed?.version ?? null,
      latest_version: latestByShort.get(short) ?? null,
      supervisor_status: state?.status ?? null,
      pid: state?.pid ?? null,
      supervisor_start_error: state?.startError ?? null,
      install_dir: installed?.installDir ?? null,
      uis: toUisWireShape(installed?.uis),
      management_url: managementUrlByShort.get(short) ?? null,
      config_ui_url: configUiUrlByShort.get(short) ?? null,
    };
    return row;
  });
  const focusRank = (f: ModuleFocus): number => (f === "core" ? 0 : 1);
  rows.sort((a, b) => {
    if (a.focus !== b.focus) return focusRank(a.focus) - focusRank(b.focus);
    const ai = recommendedOrder.get(a.short) ?? Number.POSITIVE_INFINITY;
    const bi = recommendedOrder.get(b.short) ?? Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    return a.short.localeCompare(b.short);
  });
  const modules: ModuleWireShape[] = rows;

  // Every supervised module's run-state — curated AND non-curated (hub#539).
  // Built from the same supervisor.list() snapshot already in `stateByShort`.
  const supervised: SupervisedSnapshotWire[] = Array.from(stateByShort.values()).map((s) => ({
    short: s.short,
    installed: installedByShort.has(s.short),
    installed_version: installedByShort.get(s.short)?.version ?? null,
    supervisor_status: s.status,
    pid: s.pid ?? null,
    supervisor_start_error: s.startError ?? null,
  }));

  const body: ModulesResponse = {
    modules,
    supervised,
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
 * The literal legacy per-instance candidates the COMPAT SHIM recognizes on a
 * vault entry (see `resolveModuleUrl`). One-release shim — remove once vault's
 * new manifest (`managementUrl: "admin/"`) reaches @latest.
 */
const LEGACY_VAULT_ADMIN_CANDIDATES = new Set(["/admin", "/admin/"]);
let warnedLegacyVaultAdminCandidate = false;

/**
 * Resolve a module-declared "path or http(s) URL" surface field (`managementUrl`,
 * `uiUrl`, `configUiUrl`) to a full hub-origin path the SPA can navigate to.
 *
 * Unified URL-resolution semantics (B4 of the 2026-06-09 hub-module-boundary
 * migration — same doctrine as `buildWellKnown`'s uiUrl branch and the
 * `resolveManagementUrl` pair):
 *
 *   - `undefined` candidate → `undefined` (the module didn't declare it).
 *   - Absolute http(s) URL → returned verbatim (off-origin escape hatch).
 *   - Leading-`/` path → ORIGIN-ABSOLUTE, returned verbatim. Single-instance
 *     modules (surface, scribe, runner, channel) declare their full hub-origin
 *     path this way (`/surface/admin/`, `/scribe/admin`, `/channel/admin`);
 *     vault's daemon-level surface is `/vault/admin/`.
 *   - Relative path (no leading slash) → MOUNT-JOINED: the per-instance form
 *     (`admin/` on a `/vault/default` mount → `/vault/default/admin/`). With
 *     no mount to join → `undefined` (can't resolve; the SPA renders the
 *     disabled/omitted state rather than guessing).
 *
 * COMPAT SHIM (one release): the literal legacy `"/admin"`/`"/admin/"` on a
 * VAULT entry is the OLD per-instance relative declaration — deployed vaults
 * still ship it until the vault wave's manifest lands — and mount-joins with
 * a one-time deprecation log instead of resolving origin-absolute (which
 * would point at the daemon-level `/vault/admin` mount, not the instance).
 *
 * Shared by `managementUrl`/`uiUrl` (the Open action) and `configUiUrl` (the
 * Configure action, 2026-06-09 modular-UI architecture P3) so the two resolve
 * identically.
 */
function resolveModuleUrl(
  candidate: string | undefined,
  mount: string | undefined,
  short: string,
): string | undefined {
  if (candidate === undefined) return undefined;
  if (/^https?:\/\//i.test(candidate)) return candidate;
  const mountBase = mount?.replace(/\/+$/, "");
  if (short === "vault" && LEGACY_VAULT_ADMIN_CANDIDATES.has(candidate)) {
    if (!warnedLegacyVaultAdminCandidate) {
      warnedLegacyVaultAdminCandidate = true;
      console.warn(
        `api-modules: vault declares the legacy per-instance form ${JSON.stringify(candidate)}; mount-joining for one release. New semantics: relative ("admin/") = per-instance mount-join, leading-"/" = origin-absolute. Upgrade the vault module to clear this.`,
      );
    }
    if (mountBase === undefined) return undefined;
    return `${mountBase}${candidate}`;
  }
  if (candidate.startsWith("/")) return candidate;
  if (mountBase === undefined) return undefined;
  return `${mountBase}/${candidate}`;
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
