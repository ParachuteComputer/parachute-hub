import { fileURLToPath } from "node:url";
import { type ModuleManifest, readModuleManifest } from "./module-manifest.ts";
import type { ServiceEntry } from "./services-manifest.ts";

/**
 * Canonical Parachute port range. Every ecosystem service reserves a slot in
 * 1939–1949; third-party integrators are expected to avoid it.
 *
 *   1939  parachute-hub      internal static + proxy, CLI-managed
 *   1940  parachute-vault    committed core
 *   1941  parachute-channel  exploration (may retire)
 *   1942  parachute-notes    committed core (PWA bundle)
 *   1943  parachute-scribe   committed core
 *   1944–1949  unassigned
 *
 * Hub pins 1939: `parachute expose` composes hub targets as
 * `http://127.0.0.1:1939/` and that URL has to be stable across machines for
 * tailscale serve to proxy it correctly. The hub-port fallback range is 1
 * (see hub-control.ts) — if something else is on 1939 we fail loudly rather
 * than walking up into a service's slot.
 *
 * **CLI is the port authority.** `parachute install <svc>` picks the port at
 * install time and writes `PORT=<port>` into `~/.parachute/<svc>/.env`.
 * lifecycle.start merges that .env into the spawn env, so the next daemon
 * boot binds the port the CLI assigned. Algorithm (see port-assign.ts):
 *
 *   1. Prefer the canonical slot (`spec.seedEntry().port`).
 *   2. On collision, walk the unassigned range (1944–1949 today).
 *   3. Range exhausted: assign past 1949 with a warning.
 *
 * Idempotent: an existing `PORT=` in .env wins, so re-installs and
 * operator-edited ports survive across upgrades. Services keep their
 * compiled-in fallbacks (vault → 1940 etc.) so a stand-alone `bun run`
 * still works without a CLI-managed .env, but the CLI's PORT wins on any
 * install it manages.
 *
 * **No speculative reservations.** Future first-party modules claim a slot
 * the moment they ship, not before — pre-reservation for unbuilt things has
 * proven a hold-place we kept reshaping.
 */
export const CANONICAL_PORT_MIN = 1939;
export const CANONICAL_PORT_MAX = 1949;

export interface PortReservation {
  readonly port: number;
  readonly name: string;
  readonly status: "assigned" | "reserved";
}

export const PORT_RESERVATIONS: readonly PortReservation[] = [
  { port: 1939, name: "parachute-hub", status: "assigned" },
  { port: 1940, name: "parachute-vault", status: "assigned" },
  { port: 1941, name: "parachute-channel", status: "assigned" },
  { port: 1942, name: "parachute-notes", status: "assigned" },
  { port: 1943, name: "parachute-scribe", status: "assigned" },
  { port: 1944, name: "unassigned", status: "reserved" },
  { port: 1945, name: "unassigned", status: "reserved" },
  { port: 1946, name: "unassigned", status: "reserved" },
  { port: 1947, name: "unassigned", status: "reserved" },
  { port: 1948, name: "unassigned", status: "reserved" },
  { port: 1949, name: "unassigned", status: "reserved" },
];

export function isCanonicalPort(port: number): boolean {
  return port >= CANONICAL_PORT_MIN && port <= CANONICAL_PORT_MAX;
}

/**
 * Broad shape of a service. Matches the hub's card-kind taxonomy.
 *   "frontend"  a user-facing UI (notes). Safe to expose by default.
 *   "api"       a programmatic surface (vault, channel, scribe). Whether
 *               it's safe to expose depends on `hasAuth`.
 *   "tool"      like "api" but specifically MCP-shaped / agent-callable.
 *               Treated the same as "api" for exposure defaults.
 */
export type ServiceKind = "api" | "tool" | "frontend";

/**
 * Imperative behaviors that don't fit the static `module.json` schema.
 *
 * First-party only. Each first-party fallback declares its own extras
 * alongside its embedded manifest; when the upstream module ships its own
 * `.parachute/module.json`, the corresponding fallback entry — extras and
 * manifest both — gets deleted in one PR per module.
 *
 * Third-party modules don't get extras: anything they need at install time
 * has to fit the manifest contract (or live as a runtime concern at
 * `/.parachute/info`). The boundary is intentional — extras is the seam
 * for transitional behavior, not a permanent escape hatch.
 */
export interface FirstPartyExtras {
  /** Init command spawned post-install (e.g., `["parachute-vault", "init"]`). */
  readonly init?: readonly string[];
  /**
   * Override startCmd to take the per-install services.json entry. Used by
   * notes (which needs `--port` + `--mount` derived from the entry); plain
   * static-argv `manifest.startCmd` covers everything else.
   */
  readonly startCmd?: (entry: ServiceEntry) => readonly string[] | undefined;
  /** Lines printed at the end of `parachute install <svc>`. */
  readonly postInstallFooter?: () => readonly string[];
  /**
   * Does the service gate its endpoints behind auth today? Drives
   * `effectivePublicExposure`'s default for api/tool services. True for
   * vault/channel; conservatively false for scribe until its auth-gate ships.
   */
  readonly hasAuth?: boolean;
  /**
   * Override the canonical reachable URL for `parachute status`. Most
   * services use `port + paths[0]`; vault appends `/mcp`, scribe is at root.
   */
  readonly urlForEntry?: (entry: ServiceEntry) => string | undefined;
}

/**
 * Vendored fallback for a first-party module.
 *
 * The CLI prefers the installed module's own `.parachute/module.json` when
 * present and falls back to this embedded manifest otherwise. The plan is
 * to delete each fallback as its upstream module starts shipping the real
 * file — see the `// FALLBACK: Delete when ...` markers below for the
 * specific upstream reference per entry.
 *
 * Third-party modules never have a fallback; they ship `module.json` or
 * the install hard-errors.
 */
export interface FirstPartyFallback {
  /** npm package name for `bun add -g`. */
  readonly package: string;
  /** Embedded module.json — used when the install dir has no `.parachute/module.json`. */
  readonly manifest: ModuleManifest;
  /** Imperative behaviors not expressible in module.json. Optional. */
  readonly extras?: FirstPartyExtras;
}

/**
 * Façade combining a module's manifest with its install-time extras. All
 * consumers (install, lifecycle, status, expose) read this — they don't
 * care whether it came from a vendored fallback or a real
 * `.parachute/module.json`. Non-readonly nothing — every field is read-only
 * from the consumer's perspective.
 */
export interface ServiceSpec {
  readonly package: string;
  readonly manifestName: string;
  readonly init?: readonly string[];
  /**
   * Command to spawn for `parachute start <svc>`. Receives the services.json
   * entry so commands that need per-install data (e.g., the notes static-serve
   * shim needs the configured port) can pull it from there. Returns
   * `undefined` to declare "lifecycle not supported for this service."
   */
  readonly startCmd?: (entry: ServiceEntry) => readonly string[] | undefined;
  /**
   * Canonical initial services.json entry used when the service hasn't
   * written its own. Fires post-install only if `findService` returns
   * undefined — normal npm installs hit this almost never (the service's
   * init or first boot writes the authoritative entry first). Main use case:
   * `bun link` local-dev installs where the service hasn't run yet but
   * `parachute expose` / `parachute start` need an entry to plan against.
   * First service boot overwrites the seed with its own authoritative version.
   */
  readonly seedEntry?: () => ServiceEntry;
  readonly kind: ServiceKind;
  readonly hasAuth?: boolean;
  readonly urlForEntry?: (entry: ServiceEntry) => string | undefined;
  readonly postInstallFooter?: () => readonly string[];
}

const NOTES_SERVE_PATH = fileURLToPath(new URL("./notes-serve.ts", import.meta.url));

/**
 * Seed entries land in services.json as placeholder rows when a freshly
 * installed service hasn't written its own. Version `"0.0.0-linked"`
 * telegraphs the state: the row is a stopgap, and the service's first boot
 * will overwrite with its own authoritative write.
 */
const SEED_VERSION = "0.0.0-linked";

function pathBasedUrl(entry: ServiceEntry): string {
  const first = entry.paths[0] ?? "";
  // Strip a trailing slash so concatenation never doubles up.
  const path = first.replace(/\/+$/, "");
  return `http://127.0.0.1:${entry.port}${path}`;
}

/**
 * Build a services.json seed row from a module manifest. Pure: doesn't
 * read the filesystem. The `version` is intentionally `0.0.0-linked` to
 * telegraph "stopgap" — the service's own boot overwrites this entry.
 */
export function seedEntryFromManifest(manifest: ModuleManifest): ServiceEntry {
  const entry: ServiceEntry = {
    name: manifest.manifestName,
    port: manifest.port,
    paths: [...manifest.paths],
    health: manifest.health,
    version: SEED_VERSION,
  };
  if (manifest.displayName !== undefined) entry.displayName = manifest.displayName;
  if (manifest.tagline !== undefined) entry.tagline = manifest.tagline;
  if (manifest.stripPrefix !== undefined) entry.stripPrefix = manifest.stripPrefix;
  return entry;
}

/**
 * Build the runtime ServiceSpec façade from a manifest + optional extras.
 * Used by both the first-party-fallback path and the
 * read-installed-`module.json` path so both produce identical specs.
 */
export function composeServiceSpec(opts: {
  packageName: string;
  manifest: ModuleManifest;
  extras?: FirstPartyExtras;
}): ServiceSpec {
  const { packageName, manifest, extras } = opts;
  const startCmd = extras?.startCmd ?? (manifest.startCmd ? () => manifest.startCmd : undefined);
  const spec: ServiceSpec = {
    package: packageName,
    manifestName: manifest.manifestName,
    seedEntry: () => seedEntryFromManifest(manifest),
    kind: manifest.kind,
  };
  if (extras?.init !== undefined) (spec as { init?: readonly string[] }).init = extras.init;
  if (startCmd !== undefined) {
    (spec as { startCmd?: (e: ServiceEntry) => readonly string[] | undefined }).startCmd = startCmd;
  }
  if (extras?.hasAuth !== undefined) (spec as { hasAuth?: boolean }).hasAuth = extras.hasAuth;
  if (extras?.urlForEntry !== undefined) {
    (
      spec as {
        urlForEntry?: (e: ServiceEntry) => string | undefined;
      }
    ).urlForEntry = extras.urlForEntry;
  }
  if (extras?.postInstallFooter !== undefined) {
    (spec as { postInstallFooter?: () => readonly string[] }).postInstallFooter =
      extras.postInstallFooter;
  }
  return spec;
}

// ---------------------------------------------------------------------------
// First-party fallbacks
//
// Each entry below is a "delete-when-X-ships" marker — when the upstream
// module starts publishing its own `.parachute/module.json`, the matching
// FALLBACK comment names the issue that retires the vendored manifest +
// extras. One cleanup PR per module; the markers make those PRs a one-grep
// operation (`rg "FALLBACK: Delete when"`).
// ---------------------------------------------------------------------------

// FALLBACK: Delete when @openparachute/vault ships .parachute/module.json
// (parachute-vault repo: file follow-up after parachute-hub#56 lands).
const VAULT_FALLBACK: FirstPartyFallback = {
  package: "@openparachute/vault",
  manifest: {
    name: "vault",
    manifestName: "parachute-vault",
    displayName: "Vault",
    tagline: "Your owner-authenticated MCP knowledge store.",
    kind: "api",
    port: 1940,
    paths: ["/vault/default"],
    health: "/vault/default/health",
  },
  extras: {
    init: ["parachute-vault", "init"],
    startCmd: () => ["parachute-vault", "serve"],
    hasAuth: true,
    // Vault's MCP endpoint lives one segment past the mount path. The bare
    // `/vault/<name>` URL is the discovery shape; clients (claude.ai et al.)
    // need `/vault/<name>/mcp` to actually open the stream.
    urlForEntry: (entry) => `${pathBasedUrl(entry)}/mcp`,
  },
};

// FALLBACK: Delete when @openparachute/notes ships .parachute/module.json
// (parachute-notes repo: file follow-up after parachute-hub#56 lands).
const NOTES_FALLBACK: FirstPartyFallback = {
  package: "@openparachute/notes",
  manifest: {
    // Frontend product name is "Notes". Vault's internal `/api/notes` endpoint
    // is unrelated — different concept (vault data primitive vs. PWA brand).
    name: "notes",
    manifestName: "parachute-notes",
    displayName: "Notes",
    tagline: "Notes PWA backed by your vault.",
    kind: "frontend",
    port: 1942,
    paths: ["/notes"],
    health: "/notes/health",
  },
  extras: {
    startCmd: (entry) => {
      const first = entry.paths[0] ?? "/notes";
      const mount = first === "/" ? "" : first.replace(/\/+$/, "");
      return ["bun", NOTES_SERVE_PATH, "--port", String(entry.port), "--mount", mount];
    },
    postInstallFooter: () => [
      "",
      "Open your Notes UI at http://localhost:1942/notes — paste the vault URL",
      "  http://127.0.0.1:1940/vault/default",
      "and the API token from your vault install.",
    ],
  },
};

// FALLBACK: Delete when @openparachute/scribe ships .parachute/module.json
// (parachute-scribe repo: file follow-up after parachute-hub#56 lands).
const SCRIBE_FALLBACK: FirstPartyFallback = {
  package: "@openparachute/scribe",
  manifest: {
    name: "scribe",
    manifestName: "parachute-scribe",
    displayName: "Scribe",
    tagline: "Local audio transcription for vault recordings.",
    kind: "api",
    port: 1943,
    paths: ["/scribe"],
    health: "/scribe/health",
    startCmd: ["parachute-scribe", "serve"],
    // Scribe's HTTP routes are bare (`/health`, `/v1/...`), unlike notes /
    // agent which strip the mount themselves. Until scribe ships a `--mount`
    // flag (tracked upstream in parachute-scribe), the hub strips the
    // `/scribe` prefix before forwarding so a request to
    // `hub:1939/scribe/v1/audio/transcriptions` reaches scribe as
    // `/v1/audio/transcriptions`.
    stripPrefix: true,
  },
  extras: {
    // No auth gate today. Scribe's launch PR adds optional SCRIBE_AUTH_TOKEN;
    // once it lands and scribe writes `publicExposure: "allowed"` when a
    // token is configured, that explicit declaration overrides this default.
    hasAuth: false,
    // Scribe's API is at the root, not under `/scribe`. The path prefix only
    // shows up in the health endpoint; clients hit the bare port.
    urlForEntry: (entry) => `http://127.0.0.1:${entry.port}`,
    postInstallFooter: () => [
      "",
      "Scribe is listening on http://127.0.0.1:1943.",
      "Vault will auto-call this for transcription (SCRIBE_URL has been wired to the vault env).",
      "Provider config lives at ~/.parachute/scribe/config.json (key: transcribe.provider);",
      "API keys live at ~/.parachute/scribe/.env. Available: parakeet-mlx (default), onnx-asr,",
      "whisper, groq, openai.",
    ],
  },
};

// FALLBACK: Delete when @openparachute/channel ships .parachute/module.json
// (parachute-channel repo: file follow-up after parachute-hub#56 lands;
// channel is exploration tier — may be retired before module.json ships).
const CHANNEL_FALLBACK: FirstPartyFallback = {
  package: "@openparachute/channel",
  manifest: {
    name: "channel",
    manifestName: "parachute-channel",
    displayName: "Channel",
    tagline: "Notification fan-out across modules.",
    kind: "api",
    port: 1941,
    paths: ["/channel"],
    health: "/channel/health",
    startCmd: ["parachute-channel", "daemon"],
  },
  extras: {
    hasAuth: true,
  },
};

/**
 * Vendored manifests + extras for first-party modules. Indexed by short name
 * (the `parachute install <X>` token). Each entry retires when its upstream
 * module starts shipping `.parachute/module.json` — see the per-entry
 * `FALLBACK:` markers above.
 */
export const FIRST_PARTY_FALLBACKS: Record<string, FirstPartyFallback> = {
  vault: VAULT_FALLBACK,
  notes: NOTES_FALLBACK,
  scribe: SCRIBE_FALLBACK,
  channel: CHANNEL_FALLBACK,
};

/**
 * Effective publicExposure for a service, given what's on its services.json
 * entry. Explicit wins. If absent, derive from the spec: known api/tool
 * services without declared auth fall back to "auth-required"; everything
 * else defaults to "allowed" — so vault, notes, channel and unknown
 * third-party services continue to be exposed without needing to opt in.
 *
 * Layer behavior (post-#187 layer-aware proxy):
 *   "allowed"        — reaches all layers (loopback / tailnet / public);
 *                      service self-gates if it has any auth.
 *   "loopback"       — hub layer-gates; tailnet/public requests 404 at
 *                      proxyToService / proxyToVault before reaching the
 *                      service.
 *   "auth-required"  — reaches all layers; service self-gates. Same gate
 *                      behavior as "allowed" today; the field documents
 *                      operator/UI intent ("requires auth before exposing")
 *                      separately from the loopback hard-block.
 */
export function effectivePublicExposure(
  entry: ServiceEntry,
): "allowed" | "loopback" | "auth-required" {
  if (entry.publicExposure !== undefined) return entry.publicExposure;
  const short = shortNameForManifest(entry.name);
  const fb = short !== undefined ? FIRST_PARTY_FALLBACKS[short] : undefined;
  if (
    fb &&
    (fb.manifest.kind === "api" || fb.manifest.kind === "tool") &&
    fb.extras?.hasAuth === false
  ) {
    return "auth-required";
  }
  return "allowed";
}

export function knownServices(): string[] {
  return Object.keys(FIRST_PARTY_FALLBACKS);
}

/**
 * Resolve the runtime spec for a known short name. Returns undefined for
 * unknown names; third-party modules installed via `module.json` resolve
 * via {@link getSpecFromInstallDir} instead, since their spec isn't
 * compiled in.
 */
export function getSpec(short: string): ServiceSpec | undefined {
  const fb = FIRST_PARTY_FALLBACKS[short];
  if (!fb) return undefined;
  return composeServiceSpec({
    packageName: fb.package,
    manifest: fb.manifest,
    extras: fb.extras,
  });
}

/**
 * Resolve a third-party module's runtime spec by reading its
 * `<installDir>/.parachute/module.json` fresh. Re-reading at lifecycle time
 * (rather than baking the spec into services.json at install) means the
 * module can ship `startCmd` updates without a re-install.
 *
 * Returns null when the manifest is missing — caller falls back to the
 * "lifecycle not yet supported" message (same shape as a first-party spec
 * with no startCmd). Throws ModuleManifestError on a malformed manifest;
 * lifecycle catches and surfaces it as a per-service failure rather than
 * crashing the whole sweep.
 *
 * `packageName` is informational only — the spec carries it forward for
 * diagnostics. Lifecycle doesn't care; install passes it through from the
 * services.json row's name.
 */
export async function getSpecFromInstallDir(
  installDir: string,
  packageName: string,
): Promise<ServiceSpec | null> {
  const manifest = await readModuleManifest(installDir);
  if (!manifest) return null;
  return composeServiceSpec({ packageName, manifest });
}

/**
 * Legacy manifest names kept so `parachute start` / `stop` / `logs` keep
 * working on an already-installed services.json that still carries the
 * old name.
 *
 * `parachute-notes` was the original; it became `parachute-lens` for ~3
 * days during the Lens rebrand window (2026-04-19 → 2026-04-22), then
 * reverted. Users who installed during that window have `parachute-lens`
 * in their services.json and need lifecycle commands to keep finding
 * their install — without this alias, `parachute start/stop/logs/status`
 * silently skip those rows. Remove after launch, alongside the `lens →
 * notes` install alias.
 */
const LEGACY_MANIFEST_ALIASES: Record<string, string> = {
  "parachute-lens": "notes",
};

/** Short name (the key into FIRST_PARTY_FALLBACKS) for a given manifest name,
 *  e.g. `parachute-vault` → `vault`. Returns undefined for unknown manifests. */
export function shortNameForManifest(manifestName: string): string | undefined {
  for (const [short, fb] of Object.entries(FIRST_PARTY_FALLBACKS)) {
    if (fb.manifest.manifestName === manifestName) return short;
  }
  return LEGACY_MANIFEST_ALIASES[manifestName];
}
