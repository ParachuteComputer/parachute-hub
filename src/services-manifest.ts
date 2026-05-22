import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SERVICES_MANIFEST_PATH } from "./config.ts";

/**
 * Whether the service is safe to mount on public-facing expose layers.
 *
 *   "allowed"       mount on every layer (tailnet + public). Use when the
 *                   service gates its own endpoints with auth.
 *   "loopback"      never mount on tailnet/funnel — only reachable at
 *                   http://127.0.0.1:<port>. For internal services that
 *                   shouldn't leave the box.
 *   "auth-required" the service wants auth but isn't guaranteed to have it
 *                   configured (e.g., scribe without SCRIBE_AUTH_TOKEN set).
 *                   At launch this is treated the same as "loopback"; future
 *                   work can flip to "allowed" once the service reports its
 *                   auth state over `/.parachute/info`.
 *
 * Absent field: the CLI derives a safe default from the service's ServiceSpec
 * (known api/tool services without declared auth → "auth-required"; everything
 * else → "allowed"). Unknown services default to "allowed" for back-compat.
 */
export type PublicExposure = "allowed" | "loopback" | "auth-required";

/**
 * Visible-to-discovery state of a UI sub-unit. Mirrors parachute-app's
 * `RegisteredUi.status` so hub renders the same label the app's admin SPA
 * shows. Absent → hub treats the sub-unit as "active" (the discovery
 * default).
 *
 *   "active"        — UI is installed, OAuth client is approved, ready to serve.
 *   "pending-oauth" — UI is installed but its OAuth client hasn't been approved
 *                     yet (operator still needs to click through `/admin/oauth-clients`
 *                     or the app's admin SPA gate). Discovery should render the
 *                     row but signal "not yet usable."
 *   "disabled"      — Operator-disabled. Renders greyed-out; no link.
 */
export type UiSubUnitStatus = "active" | "pending-oauth" | "disabled";

/**
 * A sub-unit beneath a module — used today by parachute-app to surface each
 * hosted UI as its own discoverable row under the App module, and the shape
 * vault is expected to adopt in a follow-up so per-vault display metadata
 * (icon, tagline) can ride alongside the mount path.
 *
 * Per parachute-app design doc §12, the canonical shape for parachute-app's
 * services.json row mirrors vault's multi-instance pattern but carries
 * display metadata per instance. Today vault encodes instances as flat
 * `paths: ["/vault/default", "/vault/work"]`; the discovery surface only
 * sees the path. With `uis`, each sub-unit can ride its own displayName,
 * tagline, iconUrl, and OAuth client id without the parent module forging
 * a fake services.json row per UI.
 *
 * `oauthClientId` is the load-bearing field for app's "install-once,
 * multi-vault" pattern (design doc §6 ¶219): each UI gets its own OAuth
 * client at install time, the operator sees that id verbatim on the
 * approval surface, and revoking the client retires the UI's access in
 * one shot without touching its siblings.
 *
 * Backwards-compat: this is purely additive. Modules that don't use `uis`
 * (vault, scribe, notes, runner today) continue to render as flat rows;
 * the field is optional throughout the read + write paths.
 */
export interface UiSubUnit {
  /** Human-readable name for the discovery row (e.g. "Gitcoin Brain"). */
  displayName: string;
  /** One-line subtitle, same shape as `ServiceEntry.tagline`. */
  tagline?: string;
  /**
   * Path under the hub origin where this sub-unit is mounted (e.g.
   * `/app/gitcoin-brain`). Must start with `/` — same shape rule as
   * `ServiceEntry.paths[]`.
   */
  path: string;
  /**
   * Absolute URL or path to an icon (svg / png). Discovery renders this as
   * the sub-unit's tile glyph; absent → hub falls back to a generic
   * placeholder. Path-relative URLs are resolved against the hub origin
   * the same way `uiUrl` is in `well-known.ts`.
   */
  iconUrl?: string;
  /**
   * Optional version stamp. Each UI iterates independently of its parent
   * module — Gitcoin Brain at 0.3.1 + Unforced Brain at 0.2.0 ride on the
   * same parachute-app process. Surfaced on the admin SPA row so operators
   * can spot a drift.
   */
  version?: string;
  /**
   * OAuth client id minted at UI install time. Hub doesn't validate this
   * shape (the OAuth server already does); it round-trips verbatim so the
   * admin SPA can render the per-UI approval status without re-resolving
   * from `/api/oauth/clients/<id>`.
   */
  oauthClientId?: string;
  /** UI sub-unit lifecycle state. Absent → discovery treats as "active". */
  status?: UiSubUnitStatus;
}

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
  /** Human-readable name for the hub page. Falls back to the short manifest name. */
  displayName?: string;
  /** One-line subtitle for the hub page card. */
  tagline?: string;
  /** Opt-in or opt-out of public-facing expose layers. See PublicExposure. */
  publicExposure?: PublicExposure;
  /**
   * Absolute path to the installed package directory. Set at install time
   * for both npm-installed (`bunGlobalPrefixes()/<package>`) and local-path
   * installs (`<absPath>`); first-party fallbacks may leave it absent.
   *
   * Lifecycle (`parachute start`) reads `<installDir>/.parachute/module.json`
   * to recover startCmd for third-party modules whose spec isn't in
   * FIRST_PARTY_FALLBACKS, and spawns with `cwd: installDir` so manifests
   * can use clean relative paths in their `startCmd`.
   */
  installDir?: string;
  /**
   * When `true`, the hub's `/<svc>/*` proxy strips the matched mount prefix
   * before forwarding so the backend sees a bare path (e.g. `/health` rather
   * than `/scribe/health`). Default `false` keeps the prefix intact, which
   * matches what notes / agent / vault expect today.
   *
   * Per-module rather than uniform because conventions differ:
   *   - notes-serve.ts strips internally via `--mount`; expects the prefix.
   *   - parachute-agent reads PARACHUTE_AGENT_WEB_MOUNT and strips itself.
   *   - parachute-vault routes by `/vault/<name>/...` and expects the prefix.
   *   - parachute-scribe serves bare paths (`/health`, `/v1/...`); the proxy
   *     must strip. Eventually scribe should accept its own `--mount` flag
   *     and join the always-prefixed convention; until then this opt-in
   *     bridges the gap. Tracked in parachute-scribe (separate issue).
   */
  stripPrefix?: boolean;
  /**
   * Sub-units hosted under this module — parachute-app's bag of UIs, and
   * the shape vault is expected to adopt for per-instance metadata in a
   * follow-up. Empty or absent → flat row, the legacy shape. See
   * `UiSubUnit` above + parachute-app design doc §12 for the canonical
   * usage. Keys are short slugs (`gitcoin-brain`, `default`); the slug
   * carries no semantic meaning beyond being a stable identity for the
   * row across renders.
   *
   * Discovery surfaces (`/.well-known/parachute.json`, admin SPA Modules
   * view) render each entry as a discoverable sub-row under the parent
   * module — same UX shape as vault's per-instance paths today, only
   * with display metadata attached.
   */
  uis?: Record<string, UiSubUnit>;
}

export interface ServicesManifest {
  services: ServiceEntry[];
}

export class ServicesManifestError extends Error {
  override name = "ServicesManifestError";
}

const EMPTY: ServicesManifest = { services: [] };

function validateEntry(raw: unknown, where: string): ServiceEntry {
  if (!raw || typeof raw !== "object") {
    throw new ServicesManifestError(`${where}: expected object, got ${typeof raw}`);
  }
  const e = raw as Record<string, unknown>;
  const name = e.name;
  const port = e.port;
  const paths = e.paths;
  const health = e.health;
  const version = e.version;
  if (typeof name !== "string" || name.length === 0) {
    throw new ServicesManifestError(`${where}: "name" must be a non-empty string`);
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ServicesManifestError(`${where}: "port" must be an integer 1..65535`);
  }
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
    throw new ServicesManifestError(`${where}: "paths" must be an array of strings`);
  }
  if (typeof health !== "string" || !health.startsWith("/")) {
    throw new ServicesManifestError(`${where}: "health" must be a path starting with "/"`);
  }
  if (typeof version !== "string") {
    throw new ServicesManifestError(`${where}: "version" must be a string`);
  }
  const displayName = e.displayName;
  const tagline = e.tagline;
  const publicExposure = e.publicExposure;
  const installDir = e.installDir;
  if (displayName !== undefined && typeof displayName !== "string") {
    throw new ServicesManifestError(`${where}: "displayName" must be a string if present`);
  }
  if (tagline !== undefined && typeof tagline !== "string") {
    throw new ServicesManifestError(`${where}: "tagline" must be a string if present`);
  }
  if (
    publicExposure !== undefined &&
    publicExposure !== "allowed" &&
    publicExposure !== "loopback" &&
    publicExposure !== "auth-required"
  ) {
    throw new ServicesManifestError(
      `${where}: "publicExposure" must be "allowed" | "loopback" | "auth-required" if present`,
    );
  }
  if (installDir !== undefined && (typeof installDir !== "string" || installDir.length === 0)) {
    throw new ServicesManifestError(`${where}: "installDir" must be a non-empty string if present`);
  }
  const stripPrefix = e.stripPrefix;
  if (stripPrefix !== undefined && typeof stripPrefix !== "boolean") {
    throw new ServicesManifestError(`${where}: "stripPrefix" must be a boolean if present`);
  }
  const uis = e.uis;
  const validatedUis = validateUis(uis, where);
  const entry: ServiceEntry = { name, port, paths: paths as string[], health, version };
  if (displayName !== undefined) entry.displayName = displayName;
  if (tagline !== undefined) entry.tagline = tagline;
  if (publicExposure !== undefined) entry.publicExposure = publicExposure as PublicExposure;
  if (installDir !== undefined) entry.installDir = installDir;
  if (stripPrefix !== undefined) entry.stripPrefix = stripPrefix;
  if (validatedUis !== undefined) entry.uis = validatedUis;
  return entry;
}

/**
 * Validate the optional `uis` map on a ServiceEntry. `undefined` round-trips
 * unchanged (the field is optional); a present map must be a plain object
 * keyed by string with each value satisfying `UiSubUnit`.
 *
 * Each sub-unit is validated against the same shape `UiSubUnit` declares:
 * `displayName` + `path` required, everything else optional with type-narrow
 * checks. Errors carry the parent entry's `where` context plus the offending
 * sub-unit key so an operator scanning logs knows exactly which row to
 * reconcile.
 */
function validateUis(raw: unknown, where: string): Record<string, UiSubUnit> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ServicesManifestError(`${where}: "uis" must be an object map if present`);
  }
  const out: Record<string, UiSubUnit> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) {
      throw new ServicesManifestError(`${where}: "uis" keys must be non-empty strings`);
    }
    out[key] = validateUiSubUnit(value, `${where} uis[${JSON.stringify(key)}]`);
  }
  return out;
}

function validateUiSubUnit(raw: unknown, where: string): UiSubUnit {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ServicesManifestError(`${where}: expected object, got ${typeof raw}`);
  }
  const u = raw as Record<string, unknown>;
  const displayName = u.displayName;
  const path = u.path;
  if (typeof displayName !== "string" || displayName.length === 0) {
    throw new ServicesManifestError(`${where}: "displayName" must be a non-empty string`);
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new ServicesManifestError(`${where}: "path" must be a path starting with "/"`);
  }
  const tagline = u.tagline;
  const iconUrl = u.iconUrl;
  const version = u.version;
  const oauthClientId = u.oauthClientId;
  const status = u.status;
  if (tagline !== undefined && typeof tagline !== "string") {
    throw new ServicesManifestError(`${where}: "tagline" must be a string if present`);
  }
  if (iconUrl !== undefined && typeof iconUrl !== "string") {
    throw new ServicesManifestError(`${where}: "iconUrl" must be a string if present`);
  }
  if (version !== undefined && typeof version !== "string") {
    throw new ServicesManifestError(`${where}: "version" must be a string if present`);
  }
  if (oauthClientId !== undefined && typeof oauthClientId !== "string") {
    throw new ServicesManifestError(`${where}: "oauthClientId" must be a string if present`);
  }
  if (
    status !== undefined &&
    status !== "active" &&
    status !== "pending-oauth" &&
    status !== "disabled"
  ) {
    throw new ServicesManifestError(
      `${where}: "status" must be "active" | "pending-oauth" | "disabled" if present`,
    );
  }
  const out: UiSubUnit = { displayName, path };
  if (tagline !== undefined) out.tagline = tagline;
  if (iconUrl !== undefined) out.iconUrl = iconUrl;
  if (version !== undefined) out.version = version;
  if (oauthClientId !== undefined) out.oauthClientId = oauthClientId;
  if (status !== undefined) out.status = status as UiSubUnitStatus;
  return out;
}

/**
 * Vault is a multi-instance service: one parachute-vault process serves
 * every vault on a single port at distinct mount paths (`/vault/default`,
 * `/vault/techne`, …). Every multi-vault row carries a `parachute-vault*`
 * name. Sharing a port between vault rows is intentional and not a
 * collision; sharing a port between two non-vault services (or between a
 * vault and a non-vault) is.
 *
 * Inlined rather than imported from `well-known.ts` to keep the parser
 * self-contained — well-known.ts already imports from this file.
 */
function isVaultName(name: string): boolean {
  return name === "parachute-vault" || name.startsWith("parachute-vault-");
}

/**
 * Reject manifests where two distinct services share a port. Without this
 * gate, both services land in services.json, the OS lets only one bind,
 * and the hub reverse-proxy quietly routes everyone to whichever service
 * won the race. That's exactly how parachute-hub#195 (scribe + agent both
 * at 1944) produced a silent /agent → scribe miswire. The underlying
 * overwrite bugs are fixed in parachute-scribe#41 + parachute-agent#146;
 * this is the hub-side gate so the same class can't recur silently.
 *
 * Multi-vault is the deliberate exception: one parachute-vault process
 * serves N vault instances on a single port at distinct mount paths, so
 * multiple `parachute-vault*` rows sharing a port is intentional, not a
 * collision. The check fires only when the conflicting names aren't
 * both vault rows.
 *
 * Pulled out of `validateManifest` so the write side (`upsertService`) can
 * apply the same gate after merging without re-validating every entry's
 * shape — the merged manifest's entries are already typed `ServiceEntry`,
 * but a duplicate-port collision is a property of the merged set, not of
 * any individual entry. Read-side path runs this after `validateEntry`
 * across the array; write-side path runs this on the post-merge entries.
 * Both surface the same `ServicesManifestError` shape.
 */
function assertNoDuplicatePorts(entries: ServiceEntry[], where: string): void {
  const portsSeen = new Map<number, string>();
  for (const entry of entries) {
    const prev = portsSeen.get(entry.port);
    if (prev !== undefined && !(isVaultName(prev) && isVaultName(entry.name))) {
      throw new ServicesManifestError(
        `${where}: duplicate port ${entry.port} — claimed by both "${prev}" and "${entry.name}". Edit services.json to give each service a unique port.`,
      );
    }
    if (prev === undefined) portsSeen.set(entry.port, entry.name);
  }
}

function validateManifest(raw: unknown, where: string): ServicesManifest {
  if (!raw || typeof raw !== "object") {
    throw new ServicesManifestError(`${where}: root must be an object`);
  }
  const services = (raw as Record<string, unknown>).services;
  if (!Array.isArray(services)) {
    throw new ServicesManifestError(`${where}: "services" must be an array`);
  }
  const entries = services.map((s, i) => validateEntry(s, `${where} services[${i}]`));
  assertNoDuplicatePorts(entries, where);
  return { services: entries };
}

export function readManifest(path: string = SERVICES_MANIFEST_PATH): ServicesManifest {
  if (!existsSync(path)) return { services: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ServicesManifestError(
      `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validated = validateManifest(raw, path);
  const migrated = migrateClawToAgent(validated);
  if (migrated.changed) writeManifest(migrated.manifest, path);
  return migrated.manifest;
}

/**
 * Migrate legacy `claw` entries to `agent` in-place. Paraclaw was renamed
 * to parachute-agent across the ecosystem (npm package, mount path, short
 * name); operators who upgraded hub but still have the old paraclaw row
 * in services.json would otherwise see a tile labelled "Claw" and a hub
 * route at `/claw` while their newly-upgraded daemon listens on `/agent`.
 *
 * Idempotent. Only rewrites when both `name === "claw"` AND the first path
 * is `/claw` — narrow enough that a deliberately-named third-party module
 * (e.g. `name: "claw"` on a different mount) is left alone. Health and any
 * `/claw`-rooted paths are rewritten in lockstep.
 */
function migrateClawToAgent(manifest: ServicesManifest): {
  manifest: ServicesManifest;
  changed: boolean;
} {
  let changed = false;
  const services = manifest.services.map((entry) => {
    if (entry.name !== "claw" || entry.paths[0] !== "/claw") return entry;
    changed = true;
    const next: ServiceEntry = {
      ...entry,
      name: "agent",
      paths: entry.paths.map((p) => rewriteClawPath(p)),
      health: rewriteClawPath(entry.health),
    };
    return next;
  });
  return { manifest: { services }, changed };
}

function rewriteClawPath(p: string): string {
  if (p === "/claw") return "/agent";
  if (p.startsWith("/claw/")) return `/agent${p.slice("/claw".length)}`;
  return p;
}

export function writeManifest(
  manifest: ServicesManifest,
  path: string = SERVICES_MANIFEST_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}

export function upsertService(
  entry: ServiceEntry,
  path: string = SERVICES_MANIFEST_PATH,
): ServicesManifest {
  validateEntry(entry, "entry");
  const current = existsSync(path) ? readManifest(path) : structuredClone(EMPTY);
  const idx = current.services.findIndex((s) => s.name === entry.name);
  if (idx >= 0) {
    current.services[idx] = entry;
  } else {
    current.services.push(entry);
  }
  // Symmetric port-collision gate (closes hub#205). Read-time validation
  // (`validateManifest` → `assertNoDuplicatePorts`) catches duplicates the
  // next time `services.json` is read, but without this write-side check the
  // bad state lives on disk for that window. A buggy service boot calling
  // `upsertService({ name: "agent", port: 1944 })` while scribe is already
  // at 1944 would otherwise succeed and corrupt the manifest. Same
  // multi-vault carve-out as the read path.
  assertNoDuplicatePorts(current.services, path);
  writeManifest(current, path);
  return current;
}

export function removeService(
  name: string,
  path: string = SERVICES_MANIFEST_PATH,
): ServicesManifest {
  if (!existsSync(path)) return structuredClone(EMPTY);
  const current = readManifest(path);
  const next: ServicesManifest = {
    services: current.services.filter((s) => s.name !== name),
  };
  writeManifest(next, path);
  return next;
}

export function findService(
  name: string,
  path: string = SERVICES_MANIFEST_PATH,
): ServiceEntry | undefined {
  if (!existsSync(path)) return undefined;
  return readManifest(path).services.find((s) => s.name === name);
}
