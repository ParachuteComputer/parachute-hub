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

/**
 * Discovery tier (2026-06-09 modular-UI architecture). `core` modules are the
 * product surface (vault / scribe / hub / surface); `experimental` modules
 * (channel / runner / others) render in a de-emphasized group on the Modules
 * screen. **Show all; never hide** — `focus` only sorts + labels.
 *
 * Absent in a `module.json` ⇒ the hub falls back to its default map (see
 * `service-spec.focusForShort`), which defaults unlisted modules to
 * `experimental`.
 */
export type ModuleFocus = "core" | "experimental";

/**
 * An event a module EMITS — the left-hand side of a Connection (2026-06-09
 * modular-UI architecture, P5). Declared in `module.json`; the hub's
 * Connections surface lists these so an operator can wire
 * "when [event] in [module] → do [action] in [module]". `filterSchema` is an
 * optional JSON-Schema describing the per-event filter an operator can set
 * (e.g. a tag filter on `vault.note.created`). Minimal at P1 — the hub only
 * needs to round-trip the declaration; richer typing lands with P5.
 */
export interface ModuleEvent {
  /** Event identifier within the module, e.g. `note.created`. */
  readonly key: string;
  /** Operator-facing label. */
  readonly title: string;
  /** Optional JSON-Schema for the per-event filter an operator may set. */
  readonly filterSchema?: unknown;
}

/**
 * An action a module ACCEPTS — the right-hand side of a Connection (2026-06-09
 * modular-UI architecture, P5). `inputSchema` is an optional JSON-Schema for
 * the action's input; `provision` is an opaque (at P1) descriptor of how the
 * hub wires the action when a Connection is created (e.g. register a vault
 * trigger). Both are passed through untyped here — the hub only round-trips
 * the declaration at P1; P5 gives them structure.
 */
export interface ModuleAction {
  /** Action identifier within the module, e.g. `message.send`. */
  readonly key: string;
  /** Operator-facing label. */
  readonly title: string;
  /** Optional JSON-Schema for the action's input. */
  readonly inputSchema?: unknown;
  /**
   * The module-relative HTTP endpoint the hub's Connections engine calls when
   * this action fires (P5). For a `vault-trigger` provision, this becomes the
   * vault trigger's `action.webhook`, hub-proxied under the module's mount:
   * `<hub-origin>/<mount><endpoint>`. Declaring it here — rather than
   * hardcoding a per-module path in the hub — is what makes the engine general.
   * Channel ships `"/api/vault/inbound"`.
   */
  readonly endpoint?: string;
  /**
   * The OAuth scope the hub mints into the action webhook's `Authorization:
   * Bearer` (P5). For a `vault-trigger`, this is persisted as the trigger's
   * long-lived `action.auth.bearer` scope — the credential the sink module
   * validates on every callback. Sourced from the action declaration so the
   * hub never hardcodes a per-module scope. Channel ships `"channel:send"`.
   */
  readonly scope?: string;
  /** Opaque (P1) descriptor of how the hub provisions this action. */
  readonly provision?: unknown;
}

/**
 * One declared parameter of a {@link ConnectionTemplate} — the operator-chosen
 * blank in the template (e.g. WHICH vault, the channel name).
 */
export interface ConnectionTemplateParameter {
  /** Parameter identifier within the template, e.g. `vault`, `channel`. */
  readonly key: string;
  /**
   * Where the chosen value lands on the connection body, e.g. `source.vault`
   * or `sink.params.channel`. Opaque to the hub at P1 — builder UIs interpret
   * the two shapes above; anything else rides through for future targets.
   */
  readonly target: string;
  /** Operator-facing label. */
  readonly title?: string;
  readonly description?: string;
  /** Optional pre-fill example a builder UI may show for this parameter. */
  readonly example?: string;
}

/**
 * A connection PRESET a module declares in `module.json` (boundary D2).
 *
 * Two shapes ship today, discriminated by presence of `source` + `sink`:
 *   - **event→action preset** (channel's `link-to-vault`): `source` (a module
 *     event + optional filter) + `sink` (a module action). The hub's
 *     Connections builder offers these as one-click pre-fills.
 *   - **config link** (scribe's `link-to-vault`, `kind: "config"`): no
 *     `source`/`sink` — a module-owned config flow described by other fields
 *     (`provider`/`target`, which ride through `extra`-style and are NOT
 *     interpreted by the hub). These are consumed by the module's own UI,
 *     not the hub builder.
 *
 * Declaration-driven so the hub SPA never hardcodes a per-module preset (the
 * charter's per-module-view test); the hub only round-trips these through
 * `/api/connections/catalog` (event→action presets only).
 */
export interface ConnectionTemplate {
  /** Template identifier within the module, e.g. `link-to-vault`. */
  readonly key: string;
  /** Operator-facing label. */
  readonly title: string;
  readonly description?: string;
  /** Provenance label for connections created from this template. */
  readonly requestedBy?: string;
  /** Optional discriminator — scribe ships `"config"`. Absent = event→action. */
  readonly kind?: string;
  /** The source event the template pre-fills (+ optional filter, opaque). */
  readonly source?: {
    readonly module: string;
    readonly event: string;
    readonly filter?: unknown;
  };
  /** The sink action the template pre-fills. */
  readonly sink?: { readonly module: string; readonly action: string };
  /** Operator-chosen blanks. */
  readonly parameters?: readonly ConnectionTemplateParameter[];
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
   * Three shapes (unified URL-resolution semantics — B4 of the 2026-06-09
   * hub-module-boundary migration):
   *   - A full http(s) URL — used verbatim. Escape hatch for modules whose
   *     admin UI is hosted off-origin.
   *   - A leading-`/` path (e.g. `"/scribe/admin"`) — ORIGIN-ABSOLUTE, used
   *     verbatim against the hub origin.
   *   - A relative path (e.g. `"admin/"`) — the PER-INSTANCE form; hub joins
   *     it under the module's mounted URL: `<module-url>/<managementUrl>`.
   *
   * COMPAT SHIM (one release): the literal legacy `"/admin"`/`"/admin/"` on a
   * vault entry is treated as the old per-instance relative form (mount-join)
   * — deployed vaults still declare it until the vault wave ships.
   *
   * Absent = no link rendered (CLI-only management). Same back-compat rule
   * as `hasAuth` / `init` / `urlForEntry`.
   */
  readonly managementUrl?: string;
  /**
   * Where the module's primary user-facing UI lives. Hub renders a tile on
   * the discovery page (`/`) Services section when set (see
   * `parachute-patterns/patterns/module-json-extensibility.md` and the
   * `loadUiUrls` resolver in `hub-server.ts`).
   *
   * Two shapes — same rules as `managementUrl`:
   *   - A relative path (e.g. `"/notes"`, `"/agent"`) — hub resolves
   *     against the canonical hub origin.
   *   - A full absolute URL — hub uses verbatim.
   *
   * Absent = no Services tile rendered (the module is API-only or surfaces
   * its UI via a sibling module — e.g. vault content browses through Notes,
   * so vault has no `uiUrl`).
   *
   * Read at every discovery render via `installDir/.parachute/module.json`
   * (mirrors how `managementUrl` is sourced for vaults). Not persisted in
   * services.json — that file's "services own the write side" semantics
   * would clobber any install-time copy on the next service boot.
   */
  readonly uiUrl?: string;
  /**
   * When `true`, the hub's `/<svc>/*` proxy strips the matched mount prefix
   * before forwarding (so the backend sees `/health` rather than
   * `/<name>/health`). Default `false` matches the prefix-aware convention
   * notes / agent / vault already follow. Carried into services.json via
   * `seedEntryFromManifest`. See `ServiceEntry.stripPrefix` for the full
   * per-module rationale.
   */
  readonly stripPrefix?: boolean;
  /**
   * When `true`, the module's daemon accepts WebSocket upgrades and the hub's
   * Bun-native upgrade bridge (H1, surface-runtime design) forwards
   * `Upgrade: websocket` requests on the module's mounts. DENY BY DEFAULT:
   * absent/false refuses upgrades (426) before they reach the daemon. The
   * canonical capability declaration; modules also carry it onto their
   * self-registered services.json row (`ServiceEntry.websocket`), and the hub
   * honors either source.
   */
  readonly websocket?: boolean;
  /**
   * Discovery tier (2026-06-09 modular-UI architecture). When a module
   * declares `focus`, the hub's Modules screen uses it verbatim; otherwise it
   * falls back to `service-spec.focusForShort` (vault/scribe/hub/surface →
   * `core`, everything else → `experimental`). **Show all; never hide** —
   * `focus` only groups + de-emphasizes. Additive + back-compatible.
   */
  readonly focus?: ModuleFocus;
  /**
   * Where the module's OWN config/admin surface lives — the module renders it,
   * the hub frames/links it (2026-06-09 modular-UI architecture, P3). Same
   * path-or-absolute-URL shape as `managementUrl` (distinct field: `managementUrl`
   * predates this; `configUiUrl` is the canonical config-surface declaration the
   * config shell consumes). Optional + back-compatible.
   */
  readonly configUiUrl?: string;
  /**
   * Free-form capability hints for the config shell, e.g. `["config",
   * "credentials", "logs"]`. Metadata only at P1 — the hub round-trips it.
   */
  readonly adminCapabilities?: readonly string[];
  /** Events this module EMITS — Connections left-hand side (P5). */
  readonly events?: readonly ModuleEvent[];
  /** Actions this module ACCEPTS — Connections right-hand side (P5). */
  readonly actions?: readonly ModuleAction[];
  /** Connection presets this module declares — see {@link ConnectionTemplate}. */
  readonly connectionTemplates?: readonly ConnectionTemplate[];
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
 * fields are name, manifestName, port, paths, health. The historical `kind`
 * field is fully retired as of hub#301 Phase C/D (#330) — any value (or none)
 * is silently ignored; modules and third parties may continue to ship it in
 * `module.json` without error but hub no longer reads it.
 *
 * The optional `logger` parameter is retained for forward-compatibility
 * with future validator soft-warnings, even though the kind soft-warning
 * it was originally added for has been removed.
 */
export function validateModuleManifest(
  raw: unknown,
  where: string,
  _logger: Pick<Console, "warn"> = console,
): ModuleManifest {
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
  const uiUrl = asUiUrl(m.uiUrl, where);
  const focus = asFocus(m.focus, where);
  const configUiUrl = asPathOrUrl(m.configUiUrl, where, "configUiUrl");
  const adminCapabilities =
    m.adminCapabilities === undefined
      ? undefined
      : asStringArray(m.adminCapabilities, where, "adminCapabilities");
  const events = asEvents(m.events, where);
  const actions = asActions(m.actions, where, name);
  const connectionTemplates = asConnectionTemplates(m.connectionTemplates, where);
  let stripPrefix: boolean | undefined;
  if (m.stripPrefix !== undefined) {
    if (typeof m.stripPrefix !== "boolean") {
      throw new ModuleManifestError(`${where}: "stripPrefix" must be a boolean if present`);
    }
    stripPrefix = m.stripPrefix;
  }
  let websocket: boolean | undefined;
  if (m.websocket !== undefined) {
    if (typeof m.websocket !== "boolean") {
      throw new ModuleManifestError(`${where}: "websocket" must be a boolean if present`);
    }
    websocket = m.websocket;
  }

  const out: ModuleManifest = { name, manifestName, port, paths, health };
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
  if (uiUrl !== undefined) {
    (out as { uiUrl?: string }).uiUrl = uiUrl;
  }
  if (stripPrefix !== undefined) {
    (out as { stripPrefix?: boolean }).stripPrefix = stripPrefix;
  }
  if (websocket !== undefined) {
    (out as { websocket?: boolean }).websocket = websocket;
  }
  if (focus !== undefined) (out as { focus?: ModuleFocus }).focus = focus;
  if (configUiUrl !== undefined) (out as { configUiUrl?: string }).configUiUrl = configUiUrl;
  if (adminCapabilities !== undefined) {
    (out as { adminCapabilities?: readonly string[] }).adminCapabilities = adminCapabilities;
  }
  if (events !== undefined) (out as { events?: readonly ModuleEvent[] }).events = events;
  if (actions !== undefined) (out as { actions?: readonly ModuleAction[] }).actions = actions;
  if (connectionTemplates !== undefined) {
    (out as { connectionTemplates?: readonly ConnectionTemplate[] }).connectionTemplates =
      connectionTemplates;
  }
  return out;
}

const MODULE_FOCUS_VALUES = new Set<ModuleFocus>(["core", "experimental"]);

function asFocus(v: unknown, where: string): ModuleFocus | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !MODULE_FOCUS_VALUES.has(v as ModuleFocus)) {
    throw new ModuleManifestError(`${where}: "focus" must be "core" | "experimental" if present`);
  }
  return v as ModuleFocus;
}

function asEvents(v: unknown, where: string): readonly ModuleEvent[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new ModuleManifestError(`${where}: "events" must be an array if present`);
  }
  return v.map((raw, i) => {
    const at = `events[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ModuleManifestError(`${where}: "${at}" must be an object`);
    }
    const e = raw as Record<string, unknown>;
    const out: ModuleEvent = {
      key: asString(e.key, where, `${at}.key`),
      title: asString(e.title, where, `${at}.title`),
    };
    if (e.filterSchema !== undefined) {
      (out as { filterSchema?: unknown }).filterSchema = e.filterSchema;
    }
    return out;
  });
}

function asActions(
  v: unknown,
  where: string,
  /** Declaring module's name — enforces the `action.scope` namespace rule. */
  name: string,
): readonly ModuleAction[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new ModuleManifestError(`${where}: "actions" must be an array if present`);
  }
  return v.map((raw, i) => {
    const at = `actions[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ModuleManifestError(`${where}: "${at}" must be an object`);
    }
    const a = raw as Record<string, unknown>;
    const out: ModuleAction = {
      key: asString(a.key, where, `${at}.key`),
      title: asString(a.title, where, `${at}.title`),
    };
    if (a.inputSchema !== undefined) (out as { inputSchema?: unknown }).inputSchema = a.inputSchema;
    if (a.endpoint !== undefined) {
      const ep = asString(a.endpoint, where, `${at}.endpoint`);
      if (!ep.startsWith("/")) {
        throw new ModuleManifestError(`${where}: "${at}.endpoint" must start with "/"`);
      }
      (out as { endpoint?: string }).endpoint = ep;
    }
    if (a.scope !== undefined) {
      const scope = asString(a.scope, where, `${at}.scope`);
      // Scope-namespace rule (mirrors `scopes.defines` above): an action's
      // `scope` is minted by the hub into a 90-day webhook bearer presented to
      // THIS module's own endpoint, which validates `aud:<name>` + a scope in
      // its own namespace. A legitimate `action.scope` is therefore always in
      // the declaring module's namespace (channel.message.deliver → channel:send).
      // Enforcing `<ns> === name` blocks a malicious module declaring e.g.
      // `vault:default:admin` and tricking the hub into minting a cross-module
      // privilege-escalating token when an operator wires a Connection to it.
      // Cross-module tokens a sink legitimately needs for OTHER purposes (e.g.
      // channel's reply path needs `vault:write`) are minted separately by the
      // engine, NOT declared here.
      const colon = scope.indexOf(":");
      if (colon <= 0) {
        throw new ModuleManifestError(
          `${where}: "${at}.scope" "${scope}" must be namespaced as "<name>:<verb>"`,
        );
      }
      const ns = scope.slice(0, colon);
      if (ns !== name) {
        throw new ModuleManifestError(
          `${where}: "${at}.scope" "${scope}" namespace "${ns}" does not match module name "${name}"`,
        );
      }
      (out as { scope?: string }).scope = scope;
    }
    if (a.provision !== undefined) (out as { provision?: unknown }).provision = a.provision;
    return out;
  });
}

/**
 * Validate the optional `connectionTemplates` declaration (boundary D2).
 * Light-touch like `events`/`actions` at P1 — the hub only round-trips these
 * to `/api/connections/catalog`; `filter` rides through opaque (it's the same
 * shape the connection body's `source.filter` takes).
 *
 * `source`/`sink` are OPTIONAL: scribe ships a `kind: "config"` template with
 * neither (a module-owned config flow, not an event→action preset) — a strict
 * requirement here would make every real-manifest read throw for scribe.
 * When present, their inner shapes are validated.
 */
function asConnectionTemplates(
  v: unknown,
  where: string,
): readonly ConnectionTemplate[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    throw new ModuleManifestError(`${where}: "connectionTemplates" must be an array if present`);
  }
  return v.map((raw, i) => {
    const at = `connectionTemplates[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ModuleManifestError(`${where}: "${at}" must be an object`);
    }
    const t = raw as Record<string, unknown>;
    let outSource: NonNullable<ConnectionTemplate["source"]> | undefined;
    if (t.source !== undefined) {
      const source = t.source;
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw new ModuleManifestError(`${where}: "${at}.source" must be an object if present`);
      }
      const src = source as Record<string, unknown>;
      outSource = {
        module: asString(src.module, where, `${at}.source.module`),
        event: asString(src.event, where, `${at}.source.event`),
        ...(src.filter !== undefined ? { filter: src.filter } : {}),
      };
    }
    let outSink: NonNullable<ConnectionTemplate["sink"]> | undefined;
    if (t.sink !== undefined) {
      const sink = t.sink;
      if (!sink || typeof sink !== "object" || Array.isArray(sink)) {
        throw new ModuleManifestError(`${where}: "${at}.sink" must be an object if present`);
      }
      const snk = sink as Record<string, unknown>;
      outSink = {
        module: asString(snk.module, where, `${at}.sink.module`),
        action: asString(snk.action, where, `${at}.sink.action`),
      };
    }
    const out: ConnectionTemplate = {
      key: asString(t.key, where, `${at}.key`),
      title: asString(t.title, where, `${at}.title`),
    };
    if (outSource !== undefined) {
      (out as { source?: ConnectionTemplate["source"] }).source = outSource;
    }
    if (outSink !== undefined) (out as { sink?: ConnectionTemplate["sink"] }).sink = outSink;
    const kind = asOptionalString(t.kind, where, `${at}.kind`);
    if (kind !== undefined) (out as { kind?: string }).kind = kind;
    const description = asOptionalString(t.description, where, `${at}.description`);
    if (description !== undefined) (out as { description?: string }).description = description;
    const requestedBy = asOptionalString(t.requestedBy, where, `${at}.requestedBy`);
    if (requestedBy !== undefined) (out as { requestedBy?: string }).requestedBy = requestedBy;
    if (t.parameters !== undefined) {
      if (!Array.isArray(t.parameters)) {
        throw new ModuleManifestError(`${where}: "${at}.parameters" must be an array if present`);
      }
      const parameters = t.parameters.map((p, j) => {
        const pat = `${at}.parameters[${j}]`;
        if (!p || typeof p !== "object" || Array.isArray(p)) {
          throw new ModuleManifestError(`${where}: "${pat}" must be an object`);
        }
        const pr = p as Record<string, unknown>;
        const param: ConnectionTemplateParameter = {
          key: asString(pr.key, where, `${pat}.key`),
          target: asString(pr.target, where, `${pat}.target`),
        };
        const title = asOptionalString(pr.title, where, `${pat}.title`);
        if (title !== undefined) (param as { title?: string }).title = title;
        const pdesc = asOptionalString(pr.description, where, `${pat}.description`);
        if (pdesc !== undefined) (param as { description?: string }).description = pdesc;
        const example = asOptionalString(pr.example, where, `${pat}.example`);
        if (example !== undefined) (param as { example?: string }).example = example;
        return param;
      });
      (out as { parameters?: readonly ConnectionTemplateParameter[] }).parameters = parameters;
    }
    return out;
  });
}

function asManagementUrl(v: unknown, where: string): string | undefined {
  return asPathOrUrl(v, where, "managementUrl");
}

function asUiUrl(v: unknown, where: string): string | undefined {
  return asPathOrUrl(v, where, "uiUrl");
}

/**
 * Validate a "path or http(s) URL" field. `managementUrl`, `uiUrl`, and
 * `configUiUrl` follow the same shape per the module-json-extensibility
 * pattern doc; factored so the next URL-shaped field doesn't have to
 * copy-paste.
 *
 * Three valid shapes (unified URL-resolution semantics, B4 of the 2026-06-09
 * hub-module-boundary migration):
 *   - a full http(s) URL — resolvers use it verbatim;
 *   - an origin-absolute path starting with a single "/" — resolvers use it
 *     verbatim against the hub origin;
 *   - a RELATIVE path (no leading slash, e.g. `"admin/"`) — the per-instance
 *     form; resolvers join it under the module's mount. Constrained so it can
 *     only deepen its mount: no `..` segments, no URL scheme.
 *
 * Rejected: protocol-relative forms like `"//evil.com"` — they start with "/"
 * but `new URL("//evil.com", base)` resolves to the foreign origin, which
 * would let a malicious module render an off-origin tile and turn the
 * discovery page into an open-redirect surface.
 */
function asPathOrUrl(v: unknown, where: string, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new ModuleManifestError(`${where}: "${field}" must be a non-empty string if present`);
  }
  if (v.startsWith("//")) {
    throw new ModuleManifestError(
      `${where}: "${field}" must not be protocol-relative ("//..." resolves off-origin)`,
    );
  }
  // Origin-absolute path — verbatim.
  if (v.startsWith("/")) return v;
  // Scheme-bearing string — must be a well-formed http(s) URL. Anything else
  // ("ftp://...", "javascript:...") is rejected rather than smuggled through
  // as a "relative path".
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    try {
      const u = new URL(v);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new ModuleManifestError(
          `${where}: "${field}" absolute form must use http: or https:`,
        );
      }
      return v;
    } catch (err) {
      if (err instanceof ModuleManifestError) throw err;
      throw new ModuleManifestError(
        `${where}: "${field}" must be a relative path, a path starting with "/", or a full http(s) URL`,
      );
    }
  }
  // Relative (per-instance, mount-joined) form. Forbid `..` traversal so a
  // declared value can only deepen the module's own mount, never escape it.
  if (v.split("/").some((segment) => segment === "..")) {
    throw new ModuleManifestError(
      `${where}: "${field}" relative form must not contain ".." segments`,
    );
  }
  // Forbid backslashes anywhere in the relative form — the simplest closure
  // of the backslash-traversal quirk: WHATWG URL parsing treats `\` as `/`
  // in special (http/https) schemes, so `a\..\b` joined under a mount would
  // normalize to `a/../b` and pop a segment, escaping the `..`-segment check
  // above. Percent-encoded forms (`..%2f`) need no equivalent guard:
  // `new URL()` does NOT decode percent-escapes during base-join, so a
  // `..%2f` stays a literal three-char segment and never traverses (pinned
  // in module-manifest.test.ts).
  if (v.includes("\\")) {
    throw new ModuleManifestError(
      `${where}: "${field}" relative form must not contain backslashes`,
    );
  }
  return v;
}

/**
 * Read `<packageDir>/.parachute/module.json`. Returns null if the file is
 * absent (caller decides whether that's an error — first-party modules fall
 * back to the vendored manifest; third-party hard-errors). Throws
 * `ModuleManifestError` on parse / validation failure.
 *
 * The optional `logger` parameter is retained for forward-compatibility
 * with future validator soft-warnings. Defaults to `console`.
 */
export async function readModuleManifest(
  packageDir: string,
  logger: Pick<Console, "warn"> = console,
): Promise<ModuleManifest | null> {
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
  return validateModuleManifest(parsed, path, logger);
}
