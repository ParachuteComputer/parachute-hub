/**
 * `.parachute/module.json` — the contract that makes a package a Parachute
 * module. Author-controlled, shipped in the published artifact, read by the
 * CLI on `parachute install <package>`.
 *
 * The shape mirrors `parachute-patterns/patterns/module-json-extensibility.md`.
 * Third-party modules are first-class: no `@openparachute/` scope or
 * `parachute-*` prefix required — `module.json` is what makes a package a
 * module. First-party modules will eventually ship their own `module.json`
 * and the vendored fallbacks in `service-spec.ts` go away one by one.
 *
 * Design note — what's NOT in this manifest:
 *   - `version`: that's the package's own `package.json` version, not a
 *     module-protocol versioning lever. If we ever break the manifest shape
 *     we'll add `manifestVersion: 1` (deferred until v2 is real).
 *   - imperative behaviors like `init` argv, post-install footers, dynamic
 *     startCmd that needs per-install entry data: those live in the
 *     first-party fallback's `extras` block in `service-spec.ts` because
 *     they don't fit a static schema.
 *   - runtime metadata: `displayName`, `tagline`, capabilities etc. that the
 *     hub renders are at `/.parachute/info` (runtime, can change without
 *     reinstall). The boundary: install-time → here; runtime → there.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export type ModuleKind = "api" | "frontend" | "tool";

export interface ModuleScopeBlock {
  /** OAuth scopes this module owns. Namespaced by `name` per oauth-scopes.md. */
  readonly defines?: readonly string[];
}

export interface ModuleDependency {
  /** True = absent dependency is fine; false = install fails without it. */
  readonly optional?: boolean;
  /** Scopes this module wants on the dependency, for auto-wired tokens. */
  readonly scopes?: readonly string[];
}

/**
 * Subset of JSON Schema understood by the hub config portal (#46). Author-
 * controlled: each module declares the keys an operator can edit and the
 * type/constraints on each. The portal renders a form from this declaration,
 * validates+coerces submits against it, and writes the result to
 * `<configDir>/<name>/config.json`.
 *
 * Intentionally narrow at v1 — flat string/number/integer/boolean keys, with
 * optional `enum` and `default`. Nested objects, arrays, oneOf, allOf, $ref
 * are deferred until a concrete module asks for them.
 */
export type ConfigPropertyType = "string" | "number" | "integer" | "boolean";

export interface ConfigSchemaProperty {
  readonly type: ConfigPropertyType;
  /** Operator-facing label rendered next to the input. */
  readonly description?: string;
  /** Pre-fill value when no config.json exists yet. */
  readonly default?: string | number | boolean;
  /** Restrict to a fixed set; rendered as a `<select>`. Only meaningful for string/number/integer. */
  readonly enum?: readonly (string | number)[];
}

export interface ConfigSchema {
  readonly type: "object";
  readonly properties: Record<string, ConfigSchemaProperty>;
  readonly required?: readonly string[];
}

export interface ModuleManifest {
  /** Stable ecosystem identifier — `[a-z][a-z0-9-]*`, also the services.json key. */
  readonly name: string;
  /** User-facing manifest name (often === name). */
  readonly manifestName: string;
  /** Human label rendered on the hub card. */
  readonly displayName?: string;
  /** One-line subtitle rendered under displayName. */
  readonly tagline?: string;
  /** Drives card vs. iframe vs. launcher in the hub. */
  readonly kind: ModuleKind;
  /** Default loopback port. CLI warns on conflict, doesn't block. */
  readonly port: number;
  /** URL paths the module serves under the hub origin. */
  readonly paths: readonly string[];
  /** Path for liveness probes — must start with `/`. */
  readonly health: string;
  /** Argv the CLI invokes for `parachute start <name>`. Resolved relative to
   *  the installed package; static (not entry-aware). */
  readonly startCmd?: readonly string[];
  /** OAuth scopes block — see oauth-scopes.md. */
  readonly scopes?: ModuleScopeBlock;
  /** Auto-wire targets — see service-to-service-auth.md. */
  readonly dependencies?: Record<string, ModuleDependency>;
  /**
   * Operator-editable config keys — see hub#46 + this file's `ConfigSchema`.
   * When present, the hub config portal renders a form for these keys and
   * writes the submitted values to `<configDir>/<name>/config.json` (JSON-only
   * at v1 — modules using `.env`/YAML/TOML are deferred). When absent, the
   * portal skips the module rather than rendering an empty form.
   */
  readonly configSchema?: ConfigSchema;
  /**
   * Where the module's admin UI lives. Hub renders a "Manage" link when set
   * (see `parachute-patterns/patterns/module-json-extensibility.md`).
   *
   * Two shapes:
   *   - A relative path (e.g. `"/admin"`) — hub resolves against the module's
   *     mounted URL: `<module-url><managementUrl>`. Most first-party modules
   *     take this path so the admin UI rides the same Tailscale Funnel cap.
   *   - A full absolute URL — hub uses verbatim. Escape hatch for modules
   *     whose admin UI is hosted off-origin.
   *
   * Absent = no link rendered (CLI-only management). Same back-compat rule
   * as `hasAuth` / `init` / `urlForEntry`.
   */
  readonly managementUrl?: string;
  /**
   * When `true`, the hub's `/<svc>/*` proxy strips the matched mount prefix
   * before forwarding (so the backend sees `/health` rather than
   * `/<name>/health`). Default `false` matches the prefix-aware convention
   * notes / agent / vault already follow. Carried into services.json via
   * `seedEntryFromManifest`. See `ServiceEntry.stripPrefix` for the full
   * per-module rationale.
   */
  readonly stripPrefix?: boolean;
}

export class ModuleManifestError extends Error {
  override name = "ModuleManifestError";
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

function asString(v: unknown, where: string, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new ModuleManifestError(`${where}: "${field}" must be a non-empty string`);
  }
  return v;
}

function asOptionalString(v: unknown, where: string, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new ModuleManifestError(`${where}: "${field}" must be a string if present`);
  }
  return v;
}

function asKind(v: unknown, where: string): ModuleKind {
  if (v !== "api" && v !== "frontend" && v !== "tool") {
    throw new ModuleManifestError(`${where}: "kind" must be "api" | "frontend" | "tool"`);
  }
  return v;
}

function asPort(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > 65535) {
    throw new ModuleManifestError(`${where}: "port" must be an integer 1..65535`);
  }
  return v;
}

function asStringArray(v: unknown, where: string, field: string): readonly string[] {
  if (!Array.isArray(v) || v.some((p) => typeof p !== "string")) {
    throw new ModuleManifestError(`${where}: "${field}" must be an array of strings`);
  }
  return v as readonly string[];
}

function asHealthPath(v: unknown, where: string): string {
  const s = asString(v, where, "health");
  if (!s.startsWith("/")) {
    throw new ModuleManifestError(`${where}: "health" must start with "/"`);
  }
  return s;
}

function asScopes(v: unknown, where: string): ModuleScopeBlock | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object") {
    throw new ModuleManifestError(`${where}: "scopes" must be an object if present`);
  }
  const defines = (v as Record<string, unknown>).defines;
  if (defines === undefined) return {};
  return { defines: asStringArray(defines, where, "scopes.defines") };
}

const CONFIG_PROPERTY_TYPES = new Set<ConfigPropertyType>([
  "string",
  "number",
  "integer",
  "boolean",
]);

function asConfigSchemaProperty(v: unknown, where: string, field: string): ConfigSchemaProperty {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ModuleManifestError(`${where}: "${field}" must be an object`);
  }
  const p = v as Record<string, unknown>;
  if (typeof p.type !== "string" || !CONFIG_PROPERTY_TYPES.has(p.type as ConfigPropertyType)) {
    throw new ModuleManifestError(
      `${where}: "${field}.type" must be one of "string" | "number" | "integer" | "boolean"`,
    );
  }
  const type = p.type as ConfigPropertyType;
  const out: ConfigSchemaProperty = { type };
  if (p.description !== undefined) {
    if (typeof p.description !== "string") {
      throw new ModuleManifestError(`${where}: "${field}.description" must be a string if present`);
    }
    (out as { description?: string }).description = p.description;
  }
  if (p.default !== undefined) {
    const t = typeof p.default;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      throw new ModuleManifestError(
        `${where}: "${field}.default" must be string | number | boolean if present`,
      );
    }
    (out as { default?: string | number | boolean }).default = p.default as
      | string
      | number
      | boolean;
  }
  if (p.enum !== undefined) {
    if (!Array.isArray(p.enum) || p.enum.length === 0) {
      throw new ModuleManifestError(
        `${where}: "${field}.enum" must be a non-empty array if present`,
      );
    }
    if (type === "boolean") {
      throw new ModuleManifestError(`${where}: "${field}.enum" is not meaningful for boolean type`);
    }
    for (const v of p.enum) {
      const t = typeof v;
      if (type === "string" && t !== "string") {
        throw new ModuleManifestError(
          `${where}: "${field}.enum" entries must be strings when type is "string"`,
        );
      }
      if ((type === "number" || type === "integer") && t !== "number") {
        throw new ModuleManifestError(
          `${where}: "${field}.enum" entries must be numbers when type is "${type}"`,
        );
      }
      if (type === "integer" && !Number.isInteger(v)) {
        throw new ModuleManifestError(
          `${where}: "${field}.enum" entries must be integers when type is "integer"`,
        );
      }
    }
    (out as { enum?: readonly (string | number)[] }).enum = p.enum as readonly (string | number)[];
  }
  return out;
}

function asConfigSchema(v: unknown, where: string): ConfigSchema | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ModuleManifestError(`${where}: "configSchema" must be an object if present`);
  }
  const s = v as Record<string, unknown>;
  if (s.type !== "object") {
    throw new ModuleManifestError(`${where}: "configSchema.type" must be "object"`);
  }
  if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) {
    throw new ModuleManifestError(`${where}: "configSchema.properties" must be an object`);
  }
  const propsRaw = s.properties as Record<string, unknown>;
  const properties: Record<string, ConfigSchemaProperty> = {};
  for (const [k, raw] of Object.entries(propsRaw)) {
    properties[k] = asConfigSchemaProperty(raw, where, `configSchema.properties.${k}`);
  }
  let required: readonly string[] | undefined;
  if (s.required !== undefined) {
    required = asStringArray(s.required, where, "configSchema.required");
    for (const r of required) {
      if (!properties[r]) {
        throw new ModuleManifestError(
          `${where}: "configSchema.required" names "${r}" but it is not declared in "properties"`,
        );
      }
    }
  }
  const out: ConfigSchema = { type: "object", properties };
  if (required !== undefined) (out as { required?: readonly string[] }).required = required;
  return out;
}

function asDependencies(v: unknown, where: string): Record<string, ModuleDependency> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new ModuleManifestError(`${where}: "dependencies" must be an object if present`);
  }
  const out: Record<string, ModuleDependency> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") {
      throw new ModuleManifestError(`${where}: "dependencies.${k}" must be an object`);
    }
    const dep = raw as Record<string, unknown>;
    const entry: ModuleDependency = {};
    if (dep.optional !== undefined) {
      if (typeof dep.optional !== "boolean") {
        throw new ModuleManifestError(`${where}: "dependencies.${k}.optional" must be boolean`);
      }
      (entry as { optional?: boolean }).optional = dep.optional;
    }
    if (dep.scopes !== undefined) {
      (entry as { scopes?: readonly string[] }).scopes = asStringArray(
        dep.scopes,
        where,
        `dependencies.${k}.scopes`,
      );
    }
    out[k] = entry;
  }
  return out;
}

/**
 * Strict validator. Throws `ModuleManifestError` with the source path so
 * malformed third-party modules get a clear-enough error to fix. Required
 * fields are name, manifestName, kind, port, paths, health.
 */
export function validateModuleManifest(raw: unknown, where: string): ModuleManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModuleManifestError(`${where}: root must be an object`);
  }
  const m = raw as Record<string, unknown>;

  const name = asString(m.name, where, "name");
  if (!NAME_RE.test(name)) {
    throw new ModuleManifestError(
      `${where}: "name" must match ${NAME_RE} (lowercase letters, digits, hyphens; lead with a letter)`,
    );
  }
  const manifestName = asString(m.manifestName, where, "manifestName");
  const kind = asKind(m.kind, where);
  const port = asPort(m.port, where);
  const paths = asStringArray(m.paths, where, "paths");
  const health = asHealthPath(m.health, where);
  const displayName = asOptionalString(m.displayName, where, "displayName");
  const tagline = asOptionalString(m.tagline, where, "tagline");

  let startCmd: readonly string[] | undefined;
  if (m.startCmd !== undefined) {
    startCmd = asStringArray(m.startCmd, where, "startCmd");
    if (startCmd.length === 0) {
      throw new ModuleManifestError(`${where}: "startCmd" must be non-empty if present`);
    }
  }

  const scopes = asScopes(m.scopes, where);
  // Scope-namespace rule: `name:foo` scopes must match the module's name. This
  // prevents a third party from declaring `vault:read` and squatting on a
  // namespace the user already trusts for a different module.
  if (scopes?.defines) {
    for (const s of scopes.defines) {
      const colon = s.indexOf(":");
      if (colon <= 0) {
        throw new ModuleManifestError(
          `${where}: scope "${s}" must be namespaced as "<name>:<verb>"`,
        );
      }
      const ns = s.slice(0, colon);
      if (ns !== name) {
        throw new ModuleManifestError(
          `${where}: scope "${s}" namespace "${ns}" does not match module name "${name}"`,
        );
      }
    }
  }

  const dependencies = asDependencies(m.dependencies, where);
  const configSchema = asConfigSchema(m.configSchema, where);
  const managementUrl = asManagementUrl(m.managementUrl, where);
  let stripPrefix: boolean | undefined;
  if (m.stripPrefix !== undefined) {
    if (typeof m.stripPrefix !== "boolean") {
      throw new ModuleManifestError(`${where}: "stripPrefix" must be a boolean if present`);
    }
    stripPrefix = m.stripPrefix;
  }

  const out: ModuleManifest = { name, manifestName, kind, port, paths, health };
  if (displayName !== undefined) (out as { displayName?: string }).displayName = displayName;
  if (tagline !== undefined) (out as { tagline?: string }).tagline = tagline;
  if (startCmd !== undefined) (out as { startCmd?: readonly string[] }).startCmd = startCmd;
  if (scopes !== undefined) (out as { scopes?: ModuleScopeBlock }).scopes = scopes;
  if (dependencies !== undefined) {
    (out as { dependencies?: Record<string, ModuleDependency> }).dependencies = dependencies;
  }
  if (configSchema !== undefined) {
    (out as { configSchema?: ConfigSchema }).configSchema = configSchema;
  }
  if (managementUrl !== undefined) {
    (out as { managementUrl?: string }).managementUrl = managementUrl;
  }
  if (stripPrefix !== undefined) {
    (out as { stripPrefix?: boolean }).stripPrefix = stripPrefix;
  }
  return out;
}

function asManagementUrl(v: unknown, where: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new ModuleManifestError(
      `${where}: "managementUrl" must be a non-empty string if present`,
    );
  }
  // Two valid shapes: a path starting with "/" or a full http(s) URL.
  if (v.startsWith("/")) return v;
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new ModuleManifestError(
        `${where}: "managementUrl" absolute form must use http: or https:`,
      );
    }
    return v;
  } catch (err) {
    if (err instanceof ModuleManifestError) throw err;
    throw new ModuleManifestError(
      `${where}: "managementUrl" must be a path starting with "/" or a full http(s) URL`,
    );
  }
}

/**
 * Read `<packageDir>/.parachute/module.json`. Returns null if the file is
 * absent (caller decides whether that's an error — first-party modules fall
 * back to the vendored manifest; third-party hard-errors). Throws
 * `ModuleManifestError` on parse / validation failure.
 */
export async function readModuleManifest(packageDir: string): Promise<ModuleManifest | null> {
  const path = join(packageDir, ".parachute", "module.json");
  let buf: string;
  try {
    buf = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf);
  } catch (err) {
    throw new ModuleManifestError(
      `${path}: failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateModuleManifest(parsed, path);
}
