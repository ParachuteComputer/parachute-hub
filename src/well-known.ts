import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import { type ModuleManifest, readModuleManifest } from "./module-manifest.ts";
import {
  type ServiceEntry,
  type UiSubUnit,
  type UiSubUnitStatus,
  readManifestLenient,
} from "./services-manifest.ts";

export interface WellKnownServiceEntry {
  url: string;
  version: string;
}

/**
 * Sub-unit entry surfaced in `/.well-known/parachute.json` under a parent
 * module. Mirrors the shape `UiSubUnit` carries on disk, plus:
 *
 *   - `name` — the map key promoted to a field so consumers iterating an
 *     array don't have to round-trip through the parent map. Same shape
 *     `WellKnownVaultEntry` uses.
 *   - `url` — `path` joined onto `canonicalOrigin`, so a consumer can deep
 *     link to the sub-unit without re-resolving the hub origin.
 *
 * `iconUrl` is resolved through the same path-or-absolute-URL rule the
 * services-level `uiUrl` uses (absolute http(s) → verbatim; path → joined
 * onto `canonicalOrigin`).
 */
export interface WellKnownUiSubUnit {
  name: string;
  displayName: string;
  path: string;
  url: string;
  tagline?: string;
  iconUrl?: string;
  version?: string;
  oauthClientId?: string;
  status?: UiSubUnitStatus;
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
  /**
   * Sub-units hosted under this module, surfaced as an array (the on-disk
   * shape is a map; the well-known shape is an array so consumers iterate
   * cleanly). Each entry promotes the map key into `name`. Absent on
   * modules that don't declare `uis` (vault, scribe, notes, runner today).
   * See `UiSubUnit` in services-manifest.ts + parachute-app design doc §12.
   */
  uis?: WellKnownUiSubUnit[];
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
   * "no user-facing UI" and discovery omits the Services tile. For vault
   * entries, the declared `uiUrl` is the per-instance path (e.g. "/admin/")
   * — `buildWellKnown` prefixes it with the per-instance mount path on
   * emission, yielding one tile per vault instance pointing at
   * `<origin>/vault/<name>/admin/`. See patterns#96
   * `module-ui-declaration.md` §"Multi-instance services (vault)".
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

/**
 * Resolve a UI sub-unit map to the well-known array shape. Per hub#313 /
 * parachute-app design doc §12: each map entry expands into a
 * `WellKnownUiSubUnit` record with the map key promoted to `name` and
 * `path` joined onto `canonicalOrigin` for a deep-linkable `url`. Empty
 * map → empty array (the caller decides whether to omit the field).
 *
 * `iconUrl` follows the same shape `uiUrl` does on the services row:
 * absolute http(s) → verbatim; relative path → joined onto `base`.
 *
 * Pulled out of `buildWellKnown` so the per-sub-unit shape stays a pure
 * transform — tests can call it directly; consumers can re-use it for
 * their own well-known builders (rare, but the surface stays small).
 */
function buildUisArray(uis: Record<string, UiSubUnit>, base: string): WellKnownUiSubUnit[] {
  return Object.entries(uis).map(([name, u]) => {
    const url = new URL(u.path, `${base}/`).toString();
    const out: WellKnownUiSubUnit = {
      name,
      displayName: u.displayName,
      path: u.path,
      url,
    };
    if (u.tagline !== undefined) out.tagline = u.tagline;
    if (u.iconUrl !== undefined) {
      out.iconUrl = /^https?:\/\//i.test(u.iconUrl)
        ? u.iconUrl
        : new URL(u.iconUrl, `${base}/`).toString();
    }
    if (u.version !== undefined) out.version = u.version;
    if (u.oauthClientId !== undefined) out.oauthClientId = u.oauthClientId;
    if (u.status !== undefined) out.status = u.status;
    return out;
  });
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
      // Resolve uiUrl. Three forms (per patterns#96
      // `module-ui-declaration.md` §"Shape"):
      //   - Absolute http(s) URL → verbatim.
      //   - Path on a non-vault entry → joined onto `base` directly.
      //   - Path on a vault entry → joined onto `base` AFTER prefixing
      //     with the per-instance mount path. Vault is the only
      //     multi-instance service today; its declared `uiUrl: "/admin/"`
      //     resolves to `<base>/vault/<name>/admin/` (one tile per
      //     instance). The mount path is whichever `path` we're iterating
      //     this loop turn (vault's `pathsToEmit` is its `paths[]`,
      //     fanning one row per instance).
      //
      // Path concatenation: `path` is the canonical per-instance mount
      // ("/vault/default", no trailing slash from services.json). `uiUrlRaw`
      // starts with "/" per pattern rule. Direct concatenation yields the
      // correct join ("/vault/default" + "/admin/" → "/vault/default/admin/").
      const uiUrlRaw = opts.uiUrlFor?.(s);
      if (uiUrlRaw !== undefined) {
        if (/^https?:\/\//i.test(uiUrlRaw)) {
          entry.uiUrl = uiUrlRaw;
        } else if (isVault) {
          // Defensive guard: vault uiUrl MUST start with "/" per the
          // multi-instance pattern (see module-ui-declaration.md). A bare
          // "admin/" (no leading slash) would concatenate into
          // "/vault/defaultadmin/" — a silent malformed URL that 404s.
          // Warn loudly instead of emitting garbage; the entry just
          // omits its uiUrl rather than poisoning the well-known doc.
          if (!uiUrlRaw.startsWith("/")) {
            console.warn(
              `[well-known] vault entry "${s.name}" declares uiUrl=${JSON.stringify(uiUrlRaw)} without a leading slash; skipping uiUrl emission. Per module-ui-declaration.md, multi-instance uiUrl must be a path-form starting with "/".`,
            );
          } else {
            const mount = path.replace(/\/$/, "");
            entry.uiUrl = new URL(`${mount}${uiUrlRaw}`, `${base}/`).toString();
          }
        } else {
          entry.uiUrl = new URL(uiUrlRaw, `${base}/`).toString();
        }
      }
      // Hierarchical sub-units (hub#313 / parachute-app design doc §12). The
      // on-disk shape is a map keyed by short slug; the well-known shape is
      // an array of records so JS consumers iterate cleanly without a second
      // Object.entries round-trip. `name` promotes the map key into a field
      // — same convention as `WellKnownVaultEntry`. Absent on the parent
      // when the entry doesn't declare `uis`, so vault / notes / scribe /
      // runner rows stay byte-identical to their pre-#313 shape.
      //
      // Emitted on every path of a multi-path entry — today only vault has
      // multi-path entries, and vault doesn't declare `uis` yet, so the
      // duplication is theoretical. Once vault adopts the hierarchical
      // shape (separate migration), each path-loop iteration will still see
      // the same `uis` map and emit the same array; consumers de-duplicate
      // by parent `services[].name` if they care.
      if (s.uis) {
        const arr = buildUisArray(s.uis, base);
        if (arr.length > 0) entry.uis = arr;
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
  // Lenient: one malformed row shouldn't block well-known regen for everyone
  // else (downstream consumers — Notes, Scribe, MCP — poll this; if it 500s
  // they lose discovery). The function below already tolerates per-entry
  // manifest errors via console.warn, so partial valid set is the right shape.
  const services = readManifestLenient(opts.manifestPath).services;
  // Build the resolver maps the same way hub-server does — read each
  // module's `.parachute/module.json` from `installDir` and harvest
  // managementUrl (vault rows), uiUrl + displayName (all rows). Vaults
  // declare uiUrl per workstream C / patterns#96 (multi-instance form
  // — `buildWellKnown` applies the per-instance mount-path prefix on
  // emission). Per-entry errors land in console.warn so one malformed
  // manifest doesn't block the regen for everyone else.
  const managementUrls = new Map<string, string>();
  const uiUrls = new Map<string, string>();
  const displayNames = new Map<string, string>();
  await Promise.all(
    services.map(async (s) => {
      if (!s.installDir) return;
      try {
        const m = await read(s.installDir);
        if (!m) return;
        if (isVaultEntry(s) && m.managementUrl) {
          managementUrls.set(s.name, m.managementUrl);
        }
        if (m.uiUrl) uiUrls.set(s.name, m.uiUrl);
        if (m.displayName) displayNames.set(s.name, m.displayName);
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
