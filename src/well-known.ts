import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import { type ModuleManifest, readModuleManifest } from "./module-manifest.ts";
import { type ServiceEntry, readManifest } from "./services-manifest.ts";

export interface WellKnownServiceEntry {
  url: string;
  version: string;
}

export interface WellKnownVaultEntry {
  name: string;
  url: string;
  version: string;
  /**
   * Where the vault's admin SPA lives. Path-or-URL per
   * `parachute-patterns/patterns/module-json-extensibility.md`. Hub renders
   * a "Manage" link when present. Sourced from the vault module's
   * `.parachute/module.json:managementUrl`.
   */
  managementUrl?: string;
}

/**
 * Flat service descriptor — one per installed service, used by the hub page
 * to iterate without having to know every service's shortName ahead of time.
 * `infoUrl` points at the service's `/.parachute/info` endpoint (relative to
 * its mount path) which the hub fetches client-side for displayName/tagline.
 *
 * `displayName` and `uiUrl` are both optional — the discovery page renders
 * a Services tile when `uiUrl` is present, falling back to the manifest
 * short name when `displayName` is absent. Both are sourced via hub-server's
 * `loadUiUrls`/`loadManagementUrls`-style readers from the module's
 * `installDir/.parachute/module.json`, NOT from services.json (which gets
 * overwritten on service boot per the "services own the write side"
 * contract — see hub#238 commit message for the C-not-B trace).
 */
export interface WellKnownServicesEntry {
  name: string;
  url: string;
  path: string;
  version: string;
  infoUrl: string;
  /**
   * Human-readable label for the discovery page. Sourced from
   * `module.json:displayName` when available; falls back to
   * `services.json:displayName` written at install time.
   */
  displayName?: string;
  /** Where the service's primary user-facing UI lives, sourced from `module.json:uiUrl`. */
  uiUrl?: string;
  /** One-line subtitle for the discovery tile, sourced from `services.json:tagline`. */
  tagline?: string;
}

/**
 * Canonical `/.well-known/parachute.json` shape.
 *
 * Two parts:
 *   - `vaults: []`, `notes: []`, `agent: []`, … — every kind is a plural
 *     array, so consumers always read `notes[0]` if they want "the one" and
 *     the multi-install case is visible at every call site (closes #92).
 *   - `services: []` — flat list the hub page iterates. Scales to N frontends
 *     without the consumer needing to know every shortName.
 */
export type WellKnownDocument = {
  vaults: WellKnownVaultEntry[];
  services: WellKnownServicesEntry[];
} & {
  [shortName: string]: WellKnownVaultEntry[] | WellKnownServicesEntry[] | WellKnownServiceEntry[];
};

export const WELL_KNOWN_DIR = join(CONFIG_DIR, "well-known");
export const WELL_KNOWN_PATH = join(WELL_KNOWN_DIR, "parachute.json");
export const WELL_KNOWN_MOUNT = "/.well-known/parachute.json";

const VAULT_MANIFEST_PREFIX = "parachute-vault";

/** Strip the conventional `parachute-` prefix for the well-known document's keys. */
export function shortName(manifestName: string): string {
  return manifestName.replace(/^parachute-/, "");
}

/**
 * True when this manifest entry is a vault instance. Any name that starts
 * with `parachute-vault` counts, so post-multi-tenancy names like
 * `parachute-vault-work` also route to the vaults array.
 */
export function isVaultEntry(entry: ServiceEntry): boolean {
  return entry.name === VAULT_MANIFEST_PREFIX || entry.name.startsWith(`${VAULT_MANIFEST_PREFIX}-`);
}

/**
 * Derive a vault instance name from a single mount path + manifest name.
 * Prefer a `/vault/<name>` path segment; fall back to the manifest-name
 * suffix (`parachute-vault-work` → `work`); last resort is "default".
 */
export function vaultInstanceNameFor(name: string, path: string | undefined): string {
  if (path) {
    const match = path.match(/^\/vault\/([^/]+)/);
    if (match?.[1]) return match[1];
  }
  if (name.startsWith(`${VAULT_MANIFEST_PREFIX}-`)) {
    return name.slice(VAULT_MANIFEST_PREFIX.length + 1);
  }
  return "default";
}

/**
 * Back-compat wrapper that resolves a vault instance name from the entry's
 * first mount path. Prefer `vaultInstanceNameFor(name, path)` when iterating
 * a multi-path entry.
 */
export function vaultInstanceName(entry: ServiceEntry): string {
  return vaultInstanceNameFor(entry.name, entry.paths[0]);
}

export interface BuildWellKnownOpts {
  services: readonly ServiceEntry[];
  canonicalOrigin: string;
  /**
   * Optional resolver mapping a `ServiceEntry` to its `module.json:managementUrl`,
   * if any. Synchronous so the well-known build stays a pure transform; the
   * caller (hub-server.ts) loads manifests once per request and passes them
   * in. Returning `undefined` means "no admin SPA" and hub renders no link.
   */
  managementUrlFor?: (entry: ServiceEntry) => string | undefined;
  /**
   * Optional resolver mapping a `ServiceEntry` to its `module.json:uiUrl`,
   * if any. Same shape as `managementUrlFor`. Returning `undefined` means
   * "no user-facing UI" and discovery omits the Services tile (e.g. vault
   * has no `uiUrl` — its content browses through Notes).
   */
  uiUrlFor?: (entry: ServiceEntry) => string | undefined;
  /**
   * Optional resolver mapping a `ServiceEntry` to its `module.json:displayName`.
   * Hub-server reads this at request time; falls back to the entry's own
   * `displayName` (from services.json) when absent.
   */
  displayNameFor?: (entry: ServiceEntry) => string | undefined;
}

/** Join a base origin and a path without double slashes — "/" stays "/". */
function joinInfoPath(path: string): string {
  const trimmed = path.replace(/\/$/, "");
  return `${trimmed}/.parachute/info`;
}

export function buildWellKnown(opts: BuildWellKnownOpts): WellKnownDocument {
  const base = opts.canonicalOrigin.replace(/\/$/, "");
  const doc: WellKnownDocument = { vaults: [], services: [] };
  for (const s of opts.services) {
    // Vault services are mounted at one path per vault instance — a single
    // ServiceEntry with `paths: ["/vault/default", "/vault/techne"]` represents
    // two distinct vault instances behind the same backend. Iterate each path
    // so consumers (parachute-agent vault picker, hub page) see every instance
    // (closes #141). Non-vault services keep the legacy paths[0] semantic;
    // multi-path on those is treated as aliases rather than separate
    // installs.
    const isVault = isVaultEntry(s);
    const pathsToEmit = isVault && s.paths.length > 0 ? s.paths : [s.paths[0] ?? "/"];
    for (const path of pathsToEmit) {
      const url = new URL(path, `${base}/`).toString();
      const infoUrl = new URL(joinInfoPath(path), `${base}/`).toString();
      const entry: WellKnownServicesEntry = {
        name: s.name,
        url,
        path,
        version: s.version,
        infoUrl,
      };
      const displayName = opts.displayNameFor?.(s) ?? s.displayName;
      if (displayName !== undefined) entry.displayName = displayName;
      // Tagline rides on services.json (set by service-spec at install or
      // by the service's own boot-time upsert). Read directly from the
      // entry — no installDir round-trip needed since it's already
      // persisted server-side and reasonably stable across reboots.
      if (s.tagline !== undefined) entry.tagline = s.tagline;
      // Resolve uiUrl: relative path → absolute URL against `base`; full
      // http(s) URL → verbatim. Same rule managementUrl uses.
      const uiUrlRaw = opts.uiUrlFor?.(s);
      if (uiUrlRaw !== undefined) {
        entry.uiUrl = /^https?:\/\//i.test(uiUrlRaw)
          ? uiUrlRaw
          : new URL(uiUrlRaw, `${base}/`).toString();
      }
      doc.services.push(entry);
      if (isVault) {
        const managementUrl = opts.managementUrlFor?.(s);
        const entry: WellKnownVaultEntry = {
          name: vaultInstanceNameFor(s.name, path),
          url,
          version: s.version,
        };
        if (managementUrl !== undefined) entry.managementUrl = managementUrl;
        doc.vaults.push(entry);
      } else {
        const key = shortName(s.name);
        const bucket = (doc[key] as WellKnownServiceEntry[] | undefined) ?? [];
        bucket.push({ url, version: s.version });
        doc[key] = bucket;
      }
    }
  }
  return doc;
}

export function writeWellKnownFile(doc: WellKnownDocument, path: string = WELL_KNOWN_PATH): string {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

export interface RegenerateWellKnownOpts {
  /** Path to services.json. Defaults to `SERVICES_MANIFEST_PATH`. */
  manifestPath: string;
  /**
   * Origin to embed in the doc's `url` fields. The hub HTTP path uses
   * `configuredIssuer ?? new URL(req.url).origin`; module-ops callers don't
   * have a request, so they pass `issuer` (the configured hub origin from
   * `ApiModulesOpsDeps`) — same canonical URL the per-request build would
   * emit.
   */
  canonicalOrigin: string;
  /** Override the on-disk well-known path (test seam). Defaults to `WELL_KNOWN_PATH`. */
  wellKnownPath?: string;
  /**
   * Reader for a module's `.parachute/module.json`. Production uses
   * `readModuleManifest`; tests inject a stub. Mirrors hub-server's
   * `readModuleManifest` seam so the disk regen and the per-request build
   * stay in lockstep.
   */
  readModuleManifest?: (installDir: string) => Promise<ModuleManifest | null>;
}

/**
 * Regenerate `/.well-known/parachute.json` on disk from current services.json.
 *
 * Mirrors the dynamic build inside `hub-server.ts`'s
 * `/.well-known/parachute.json` handler so the on-disk doc tracks the same
 * `uiUrl` / `displayName` / `managementUrl` shape the live discovery page
 * fetches. Returns the path written + the resulting doc so callers can log
 * and tests can assert without re-reading from disk.
 *
 * Used by `/api/modules/:short/{install,upgrade,uninstall}` post-mutation so
 * the on-disk doc stays current after lifecycle ops. The per-request build
 * in hub-server.ts remains the source of truth for live HTTP reads — this
 * disk write is the inspection / debug artifact (and a belt-and-suspenders
 * canary for anything that reads the file directly).
 */
export async function regenerateWellKnown(
  opts: RegenerateWellKnownOpts,
): Promise<{ path: string; doc: WellKnownDocument }> {
  const read = opts.readModuleManifest ?? readModuleManifest;
  const path = opts.wellKnownPath ?? WELL_KNOWN_PATH;
  const services = readManifest(opts.manifestPath).services;
  // Build the resolver maps the same way hub-server does — read each
  // module's `.parachute/module.json` from `installDir` and harvest
  // managementUrl (vault rows) + uiUrl + displayName (non-vault rows).
  // Per-entry errors land in console.warn so one malformed manifest doesn't
  // block the regen for everyone else.
  const managementUrls = new Map<string, string>();
  const uiUrls = new Map<string, string>();
  const displayNames = new Map<string, string>();
  await Promise.all(
    services.map(async (s) => {
      if (!s.installDir) return;
      try {
        const m = await read(s.installDir);
        if (!m) return;
        if (isVaultEntry(s)) {
          if (m.managementUrl) managementUrls.set(s.name, m.managementUrl);
        } else {
          if (m.uiUrl) uiUrls.set(s.name, m.uiUrl);
          if (m.displayName) displayNames.set(s.name, m.displayName);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`well-known regen: skipping module metadata for ${s.name}: ${msg}`);
      }
    }),
  );
  const doc = buildWellKnown({
    services,
    canonicalOrigin: opts.canonicalOrigin,
    managementUrlFor: (entry) => managementUrls.get(entry.name),
    uiUrlFor: (entry) => uiUrls.get(entry.name),
    displayNameFor: (entry) => displayNames.get(entry.name),
  });
  writeWellKnownFile(doc, path);
  return { path, doc };
}
