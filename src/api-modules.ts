/**
 * `GET /api/modules` — admin SPA's module-management surface.
 *
 * Combines three sources into a single per-module row:
 *
 *   - **Curated availability** — vault, notes, scribe (the v0.6 release
 *     bar). The Phase-2 marketplace will broaden this; for now it's
 *     hardcoded so the admin UI has a stable "what can I install?" list
 *     even on a fresh container where services.json is empty.
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
import { FIRST_PARTY_FALLBACKS } from "./service-spec.ts";
import { readManifest } from "./services-manifest.ts";
import type { ModuleState, Supervisor } from "./supervisor.ts";

/** Scope required on the bearer token to call this endpoint. */
export const API_MODULES_REQUIRED_SCOPE = "parachute:host:auth";

/**
 * Curated module short-names for v0.6 Render self-host. Marketplace is
 * Phase 2 — until then, the admin UI offers exactly these three. Order
 * is the recommended install order (vault before notes, scribe last).
 */
export const CURATED_MODULES = ["vault", "notes", "scribe"] as const;
export type CuratedModuleShort = (typeof CURATED_MODULES)[number];

export interface ApiModulesDeps {
  db: Database;
  issuer: string;
  manifestPath: string;
  supervisor?: Supervisor;
  /**
   * NPM @latest probe. Returns the version string or null on failure /
   * timeout. Default is the real npm registry; tests inject a fake so
   * they don't hit the network.
   */
  fetchLatestVersion?: (pkg: string) => Promise<string | null>;
  /**
   * Module-level cache TTL for `latest_version` probes, in ms. Default
   * 5 minutes — long enough that a tab refresh doesn't slam npm,
   * short enough that an `npm publish` shows up by the next minute the
   * operator clicks Upgrade. Test seam: pass 0 to disable caching.
   */
  cacheTtlMs?: number;
  /** Test seam over wall-clock. */
  now?: () => number;
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
export async function defaultFetchLatestVersion(pkg: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
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
  const manifest = readManifest(deps.manifestPath);
  const installedByShort = new Map<string, { version: string; installDir?: string }>();
  for (const entry of manifest.services) {
    // The installed-by-short map is keyed on `short` for join against
    // the curated list. shortNameForManifest reads from
    // FIRST_PARTY_FALLBACKS — we walk that table directly to derive the
    // mapping, since `entry.name` is the long manifestName and we want
    // the canonical short here without re-importing the helper.
    for (const short of CURATED_MODULES) {
      const fb = FIRST_PARTY_FALLBACKS[short];
      if (fb?.manifest.manifestName === entry.name) {
        const value: { version: string; installDir?: string } = { version: entry.version };
        if (entry.installDir !== undefined) value.installDir = entry.installDir;
        installedByShort.set(short, value);
      }
    }
  }

  // Supervisor state — per-module run status snapshot.
  const supervisor = deps.supervisor;
  const stateByShort = new Map<string, ModuleState>();
  if (supervisor) {
    for (const state of supervisor.list()) {
      stateByShort.set(state.short, state);
    }
  }

  // Resolve npm @latest in parallel — short timeout per request, cache
  // shared across requests so a fast UI poll doesn't slam the registry.
  const fetchLatest = deps.fetchLatestVersion ?? defaultFetchLatestVersion;
  const cacheTtl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;

  const latestByShort = new Map<string, string | null>();
  await Promise.all(
    CURATED_MODULES.map(async (short) => {
      const fb = FIRST_PARTY_FALLBACKS[short];
      if (!fb) {
        latestByShort.set(short, null);
        return;
      }
      const pkg = fb.package;
      const cached = latestVersionCache.get(pkg);
      if (cached && cacheTtl > 0 && now() - cached.fetchedAt < cacheTtl) {
        latestByShort.set(short, cached.value);
        return;
      }
      const value = await fetchLatest(pkg);
      latestVersionCache.set(pkg, { value, fetchedAt: now() });
      latestByShort.set(short, value);
    }),
  );

  // Compose the wire shape. Curated order is the recommended install order;
  // installed modules outside the curated list (uncommon — only third-party)
  // are appended at the end with `available: false`.
  const modules: ModuleWireShape[] = [];
  for (const short of CURATED_MODULES) {
    const fb = FIRST_PARTY_FALLBACKS[short];
    if (!fb) continue;
    const installed = installedByShort.get(short);
    const state = stateByShort.get(short);
    modules.push({
      short,
      package: fb.package,
      display_name: fb.manifest.displayName ?? fb.manifest.name,
      tagline: fb.manifest.tagline ?? "",
      available: true,
      installed: installed !== undefined,
      installed_version: installed?.version ?? null,
      latest_version: latestByShort.get(short) ?? null,
      supervisor_status: state?.status ?? null,
      pid: state?.pid ?? null,
      install_dir: installed?.installDir ?? null,
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
 * Reset the in-memory `latest_version` cache. Tests call this between
 * runs to prevent state leakage across test cases; production never
 * needs it (the cache is per-process and short-TTL anyway).
 */
export function _clearLatestVersionCacheForTests(): void {
  latestVersionCache.clear();
}
