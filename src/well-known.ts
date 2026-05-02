import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import type { ServiceEntry } from "./services-manifest.ts";

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
 */
export interface WellKnownServicesEntry {
  name: string;
  url: string;
  path: string;
  version: string;
  infoUrl: string;
}

/**
 * Canonical `/.well-known/parachute.json` shape.
 *
 * Two parts:
 *   - `vaults: []`, `notes: []`, `claw: []`, … — every kind is a plural
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
    // so consumers (paraclaw vault picker, hub page) see every instance
    // (closes #141). Non-vault services keep the legacy paths[0] semantic;
    // multi-path on those is treated as aliases rather than separate
    // installs.
    const isVault = isVaultEntry(s);
    const pathsToEmit = isVault && s.paths.length > 0 ? s.paths : [s.paths[0] ?? "/"];
    for (const path of pathsToEmit) {
      const url = new URL(path, `${base}/`).toString();
      const infoUrl = new URL(joinInfoPath(path), `${base}/`).toString();
      doc.services.push({ name: s.name, url, path, version: s.version, infoUrl });
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
