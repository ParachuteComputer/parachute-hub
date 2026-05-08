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
  const entry: ServiceEntry = { name, port, paths: paths as string[], health, version };
  if (displayName !== undefined) entry.displayName = displayName;
  if (tagline !== undefined) entry.tagline = tagline;
  if (publicExposure !== undefined) entry.publicExposure = publicExposure as PublicExposure;
  if (installDir !== undefined) entry.installDir = installDir;
  if (stripPrefix !== undefined) entry.stripPrefix = stripPrefix;
  return entry;
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
