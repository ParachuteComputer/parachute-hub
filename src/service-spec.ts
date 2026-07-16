import { fileURLToPath } from "node:url";
import { type ModuleFocus, type ModuleManifest, readModuleManifest } from "./module-manifest.ts";
import type { ServiceEntry } from "./services-manifest.ts";

/**
 * Canonical Parachute port range. Every ecosystem service reserves a slot in
 * 1939–1949; third-party integrators are expected to avoid it.
 *
 *   1939  parachute-hub      internal static + proxy, CLI-managed
 *   1940  parachute-vault    committed core
 *   1941  unassigned
 *   1942  parachute-notes    committed core (PWA bundle)
 *   1943  parachute-scribe   committed core
 *   1944  parachute-app      the super-surface front door (PWA bundle,
 *                            hub-parity P5) — see the PORT_RESERVATIONS
 *                            comment below for why this is a DIFFERENT
 *                            module from the pre-2026-05-27 `app`
 *   1945  unassigned
 *   1946  parachute-surface  UI host (renamed from `app` 2026-05-27)
 *   1947–1949  unassigned
 *
 * Hub pins 1939: `parachute expose` composes hub targets as
 * `http://127.0.0.1:1939/` and that URL has to be stable across machines for
 * tailscale serve to proxy it correctly. The hub-port fallback range is 1
 * (see hub-control.ts) — if something else is on 1939 we fail loudly rather
 * than walking up into a service's slot.
 *
 * **Hub is the port authority.** `parachute install <svc>` picks the port
 * at install time and reflects it in `services.json`. Algorithm (see
 * port-assign.ts):
 *
 *   1. Prefer the canonical slot (`spec.seedEntry().port`).
 *   2. On collision, walk the unassigned range (1944–1949 today).
 *   3. Range exhausted: assign past 1949 with a warning.
 *
 * `services.json` is the single source of truth at boot: each service
 * follows a 4-tier resolvePort ladder (services.json → service config →
 * bare PORT env → compiled-in canonical default), per parachute-scribe#41,
 * parachute-agent#146, parachute-agent#148, and parachute-patterns#45.
 * Pre-hub#206 the install path also wrote `PORT=<port>` into the service's
 * `~/.parachute/<svc>/.env`; post-#206 it doesn't — services.json wins,
 * the duplicate `.env` PORT was at best dead weight and at worst a source
 * of drift on re-install (a stale `.env` PORT would re-stamp services.json
 * even after an operator had fixed it).
 *
 * Operator override is now "edit services.json" (or `parachute config`
 * once that lands), not "edit `.env`". Pre-#206 stale `.env` PORT lines on
 * existing operator machines stay where they are — harmless to the module's
 * own resolvePort ladder, which reads services.json before falling through to
 * the bare PORT env tier — and future installs no longer touch them. (Caveat,
 * hub#537: the supervisor's spawn-env builder used to echo a stale `.env` PORT
 * into the injected `PORT`, and its readiness probe trusted that — so a `.env`
 * PORT disagreeing with services.json yielded a false `started_but_unbound`.
 * Fixed by making `entry.port` authoritative: `buildModuleSpawnRequest` drops a
 * `.env` PORT.)
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
  { port: 1941, name: "unassigned", status: "reserved" },
  { port: 1942, name: "parachute-notes", status: "assigned" },
  { port: 1943, name: "parachute-scribe", status: "assigned" },
  // hub-parity P5 (2026-07-11): parachute-app's canonical slot — the NEW
  // super-surface front door (@openparachute/parachute-app), landing as a
  // FIRST_PARTY_FALLBACKS entry (short "app") with its own hub-side static-
  // serve shim (notes-serve.ts --package). This is a DIFFERENT, unrelated
  // module from the pre-2026-05-27 `app` package described in the 1946
  // comment below — the two just happen to share the name across a rename.
  // Status `assigned` keeps the fallback-port walker (`assignPort` in
  // port-assign.ts) from handing this port to a colliding third-party
  // module.
  { port: 1944, name: "parachute-app", status: "assigned" },
  { port: 1945, name: "unassigned", status: "reserved" },
  // hub#323 (historical): this WAS `parachute-app`'s canonical slot back
  // when "app" meant the UI-host module. That module renamed to
  // `parachute-surface` 2026-05-27 (patterns#102); port 1944 above is the
  // different, new parachute-app (super-surface) from hub-parity P5. Status
  // `assigned` keeps the fallback-port walker from handing 1946 to a
  // colliding third-party module. The matching KNOWN_MODULES row carries
  // the canonicalPort + paths for status/expose surfaces.
  { port: 1946, name: "parachute-surface", status: "assigned" },
  { port: 1947, name: "unassigned", status: "reserved" },
  { port: 1948, name: "unassigned", status: "reserved" },
  { port: 1949, name: "unassigned", status: "reserved" },
];

export function isCanonicalPort(port: number): boolean {
  return port >= CANONICAL_PORT_MIN && port <= CANONICAL_PORT_MAX;
}

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
   * vault/agent; conservatively false for scribe until its auth-gate ships.
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
 * file — see the `// FALLBACK: Delete when ...` marker below for the
 * specific upstream reference.
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
/**
 * Version string stamped on a CLI-seeded services.json entry — the
 * "module installed, but its own daemon hasn't booted and registered a real
 * row yet" placeholder. A real service boot overwrites this with the package's
 * actual version (see "Services own their write side of services.json" in
 * CLAUDE.md). Exported so consumers (e.g. well-known generation, hub#577) can
 * tell a placeholder entry apart from a live one.
 */
export const SEED_VERSION = "0.0.0-linked";

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
// First-party fallbacks — vendored manifests for modules that don't yet
// ship their own `.parachute/module.json` reliably at install time.
//
// As of 2026-05-21 (hub#310), vault / scribe / runner have all retired their
// FALLBACK entries: each ships `module.json` AND self-registers its
// services.json row at boot (vault#356, scribe#50, runner#3). Agent
// (renamed from channel 2026-06-17) followed in the 2026-06-09 hub-module-
// boundary migration (D3) — it ships `.parachute/module.json` and
// self-registers (channel#34 era, pre-rename), so its
// vendored manifest retired to a KNOWN_MODULES row. Hub reads the
// canonical fields from services.json (operator-authoritative) and falls
// through to `<installDir>/.parachute/module.json` when a lifecycle command
// needs a static manifest. The `KNOWN_MODULES` registry below carries just
// the minimum hub needs PRE-self-register: npm package name + display props
// for the admin SPA install catalog + a few imperative bits (vault's init,
// scribe's post-install footer, …) that don't fit module.json's static
// schema.
//
// What remains in FIRST_PARTY_FALLBACKS:
//   - notes: still a frontend with a hub-side static-serve shim (`notes-serve.ts`)
//     — its startCmd is composed from the services.json entry's port + mount,
//     which is hub-side logic, not something notes itself runs. (The archive
//     isn't done — notes-daemon Phase 3 retirement hasn't landed.)
//   - app: the NEW super-surface front door (@openparachute/parachute-app,
//     hub-parity P5, 2026-07-11) — same shape as notes: a frontend bundle
//     with no server of its own, served by the SAME hub-side shim
//     (`notes-serve.ts --package @openparachute/parachute-app`). Unrelated
//     to the pre-2026-05-27 `app` package that renamed to `surface` (see
//     the KNOWN_MODULES.surface tagline + the RETIRED_MODULES note below).
//
// Each entry keeps its "FALLBACK: Delete when …" marker so the next cleanup
// pass is a one-grep operation.
// ---------------------------------------------------------------------------

// FALLBACK: Delete when @openparachute/notes ships .parachute/module.json AND
// self-registers its services.json row at boot (notes#105). Notes is a
// frontend bundle served by hub's `notes-serve.ts` shim, so its startCmd is
// hub-side logic (port + mount derived from the entry); when notes ships its
// own server it can self-register and this fallback retires alongside the
// shim.
const NOTES_FALLBACK: FirstPartyFallback = {
  package: "@openparachute/notes",
  manifest: {
    // Frontend product name is "Notes". Vault's internal `/api/notes` endpoint
    // is unrelated — different concept (vault data primitive vs. PWA brand).
    name: "notes",
    manifestName: "parachute-notes",
    displayName: "Notes",
    tagline: "Notes PWA — daemon deprecated 2026-05-22; install `surface` for the current path.",
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

// FALLBACK: Delete when @openparachute/parachute-app ships
// .parachute/module.json AND self-registers its services.json row at boot.
// As of hub-parity P5 the app repo doesn't carry the real module.json yet —
// only a stale `dist/.parachute/info` artifact (name: "parachute-notes")
// left over from seeding the app off notes-ui, which is a DIFFERENT file
// (module-manifest.ts's runtime `/.parachute/info`, not the static
// `.parachute/module.json` contract this fallback stands in for) and
// doesn't block this fallback path. parachute-app is a frontend bundle (the
// super-surface front door) with no server of its own, so — same as notes —
// its startCmd is hub-side logic composed from the services.json entry
// (port + mount), running through the SAME `notes-serve.ts` shim
// generalized in hub-parity P5 via `--package`.
const APP_FALLBACK: FirstPartyFallback = {
  package: "@openparachute/parachute-app",
  manifest: {
    name: "app",
    manifestName: "parachute-app",
    displayName: "Parachute",
    tagline: "The Parachute app — your parachute's front door.",
    port: 1944,
    paths: ["/app"],
    health: "/app/health",
  },
  extras: {
    startCmd: (entry) => {
      const first = entry.paths[0] ?? "/app";
      const mount = first === "/" ? "" : first.replace(/\/+$/, "");
      return [
        "bun",
        NOTES_SERVE_PATH,
        "--port",
        String(entry.port),
        "--mount",
        mount,
        "--package",
        "@openparachute/parachute-app",
      ];
    },
    postInstallFooter: () => [
      "",
      "Open your Parachute at <origin>/app — it signs in with your hub account.",
      "The hub's front page (`/`) now opens the app too, unless you've already",
      "set a custom root redirect (`parachute hub set-root-redirect` or the admin SPA).",
    ],
  },
};

/**
 * Vendored manifests + extras for first-party modules that still need them.
 * Indexed by short name (the `parachute install <X>` token).
 *
 * notes + app remain — see the block comment above for the rationale
 * (vault/scribe/agent now self-register and ship their own
 * module.json). Other code paths consult both this table AND `KNOWN_MODULES`
 * (which carries the post-self-register-retirement entries) via the helpers
 * in this file (`shortNameForManifest`, `knownServices`, …).
 */
export const FIRST_PARTY_FALLBACKS: Record<string, FirstPartyFallback> = {
  notes: NOTES_FALLBACK,
  app: APP_FALLBACK,
};

/**
 * Minimal install-time registry for first-party modules whose FALLBACK has
 * retired (vault / scribe / runner as of hub#310; agent as of the
 * 2026-06-09 hub-module-boundary migration, D3). Hub uses this for:
 *
 *   1. **Install bootstrap**: mapping `parachute install <short>` to the npm
 *      package to `bun add -g`. Pre-install there's no module.json on disk
 *      to read.
 *   2. **Admin SPA install catalog**: surfacing display props (name, tagline)
 *      on a fresh container before any module has been installed.
 *   3. **`shortName ↔ manifestName` round-trip** for status/expose/lifecycle
 *      lookups that need to find a row in services.json without first reading
 *      module.json.
 *   4. **Imperative install-time behaviors** that don't fit module.json's
 *      static schema — vault's `parachute-vault init` post-install,
 *      scribe's post-install footer, vault's `/mcp` URL suffix, etc. These
 *      live in `extras` and apply only to the `parachute install` CLI path
 *      (the API install path reads module.json's static `startCmd` after
 *      `bun add -g` lands and doesn't need extras).
 *
 * Once a module is installed and self-registers, services.json carries the
 * canonical manifest data (port, paths, health, version, stripPrefix,
 * displayName, tagline, installDir) and hub reads from there. Where lifecycle
 * needs a static manifest mid-flight (e.g. composing startCmd before spawn),
 * `getSpecFromInstallDir` reads `<installDir>/.parachute/module.json` —
 * the module is authoritative.
 *
 * The non-installed path is now "module not installed" — admin SPA prompts
 * the operator to install rather than rendering vendored data that lies
 * about an absent module.
 */
export interface KnownModule {
  readonly short: string;
  readonly package: string;
  /** services.json key — survives self-register's first write. */
  readonly manifestName: string;
  /** Canonical port for drift-warning surfaces (status). */
  readonly canonicalPort: number;
  /** Pre-install catalog surfaces use these. After install, services.json wins. */
  readonly displayName: string;
  readonly tagline: string;
  /** Canonical mount paths — used to synthesize a minimal manifest when
   *  module.json is unreadable (legacy install paths, test fixtures). The
   *  module's own `module.json` overrides these once it's installed. */
  readonly canonicalPaths: readonly string[];
  /** Canonical health probe path — same fallback semantics as `canonicalPaths`. */
  readonly canonicalHealth: string;
  /** Canonical stripPrefix declaration — same fallback semantics as above. */
  readonly canonicalStripPrefix?: boolean;
  /** CLI install-time imperatives (init, postInstallFooter, urlForEntry quirk). */
  readonly extras?: FirstPartyExtras;
}

export const KNOWN_MODULES: Record<string, KnownModule> = {
  vault: {
    short: "vault",
    package: "@openparachute/vault",
    manifestName: "parachute-vault",
    canonicalPort: 1940,
    displayName: "Vault",
    tagline: "Your owner-authenticated MCP knowledge store.",
    canonicalPaths: ["/vault/default"],
    canonicalHealth: "/vault/default/health",
    extras: {
      init: ["parachute-vault", "init"],
      startCmd: () => ["parachute-vault", "serve"],
      hasAuth: true,
      // Vault's MCP endpoint lives one segment past the mount path. The bare
      // `/vault/<name>` URL is the discovery shape; clients (claude.ai et al.)
      // need `/vault/<name>/mcp` to actually open the stream.
      urlForEntry: (entry) => `${pathBasedUrl(entry)}/mcp`,
    },
  },
  scribe: {
    short: "scribe",
    package: "@openparachute/scribe",
    manifestName: "parachute-scribe",
    canonicalPort: 1943,
    displayName: "Scribe",
    tagline: "Local audio transcription for vault recordings.",
    canonicalPaths: ["/scribe"],
    canonicalHealth: "/scribe/health",
    canonicalStripPrefix: true,
    extras: {
      // Backward-compat startCmd for rows without installDir (legacy
      // services.json from pre-installDir-stamping, or test fixtures).
      // Once the module has self-registered with installDir, lifecycle reads
      // the same startCmd out of module.json instead.
      startCmd: () => ["parachute-scribe", "serve"],
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
  },
  // NOTE (2026-07-01): `runner` was REMOVED from this registry (decision:
  // Aaron 2026-07-01 — the module set of record is vault / hub / scribe /
  // surface). Runner is no longer offered, installable, or
  // lifecycle-addressable by short name from the hub's bootstrap registries.
  // Existing installs stay GRACEFUL: a legacy `parachute-runner` services.json
  // row is handled exactly like any unknown/third-party row — `parachute
  // status` renders it (short falls back to the row name), `parachute serve`
  // boots it via `<installDir>/.parachute/module.json` when installDir is
  // stamped and logs-and-skips otherwise. Deliberately NOT added to
  // RETIRED_MODULES: that registry GC-drops rows on load, which would break
  // routing for operators still running the runner daemon.

  surface: {
    short: "surface",
    package: "@openparachute/surface",
    manifestName: "parachute-surface",
    canonicalPort: 1946,
    displayName: "Surface",
    // Tagline telegraphs the auto-bootstrap so wizard + admin-SPA copy explain
    // the architecture: installing `surface` brings Notes (and other UIs)
    // along via the Phase 2.1 bootstrap-default-apps step. The notes-daemon
    // path still exists as a back-compat install (CURATED_MODULES still
    // lists `notes`) but `surface` is the recommended first install
    // post-vault. Renamed from `app` 2026-05-27 per patterns#102.
    tagline: "Host module for Parachute surfaces — auto-installs Notes on first boot.",
    canonicalPaths: ["/surface", "/.parachute"],
    canonicalHealth: "/surface/healthz",
    canonicalStripPrefix: false,
    extras: {
      // Backward-compat startCmd — same rationale as scribe / vault
      // above. Post-self-register, lifecycle reads module.json's startCmd via
      // `composeKnownModuleSpec` and that path wins.
      startCmd: () => ["parachute-surface", "serve"],
      // Surface's admin + per-UI surfaces gate behind hub-issued JWTs (design
      // doc §6 same-hub auto-trust + scope `surface:admin`). Surfaces in
      // `parachute status` as auth-required by default, same posture as
      // vault.
      hasAuth: true,
    },
  },
};

/**
 * Modules that were once first-party (committed-core or FIRST_PARTY_FALLBACKS)
 * but have since been retired. Services.json rows under these names are
 * GC'd on load with a stderr warning.
 *
 * Adding a name here is a deliberate retirement signal — operators who
 * still have the module's daemon running will see the warning + a hint
 * to stop the daemon. The row reappears if they restart the daemon
 * (which still self-registers under its old name), but the GC ensures
 * routing isn't blocked by a stale row.
 *
 * Curation rules:
 *   - Only add an entry when the module is *explicitly* retired (see
 *     `parachute-patterns/migrations/` + per-module DEPRECATED.md). Don't
 *     speculate on Phase-2-deprecating modules — they're still serving
 *     back-compat traffic and adding them here would prematurely break
 *     legacy operators. `notes` (the daemon) is the canonical
 *     "deprecating-but-not-retired" case as of 2026-05-22: do not add
 *     until its Phase 3 retirement lands.
 *   - Entries stay forever — UNLESS the retired name is later reclaimed by a
 *     genuinely new, unrelated module that needs to self-register under it
 *     for real (see the `app` / `parachute-app` un-retirement note below).
 *     That's the one case where removal is correct: keeping a retirement
 *     entry alongside a live FIRST_PARTY_FALLBACKS/KNOWN_MODULES entry of
 *     the SAME name would make `dropRetiredModuleRows` GC the live module's
 *     own services.json row on every read — an outright regression, not a
 *     conservative default. Ordinary "this module is genuinely gone"
 *     entries (no successor reusing the name) still stay forever.
 */
export const RETIRED_MODULES: Record<string, { retiredAt: string; replacement?: string }> = {
  agent: { retiredAt: "2026-07-15", replacement: "Vault and Surface" },
  channel: { retiredAt: "2026-07-15", replacement: "Vault and Surface" },
  "parachute-agent": { retiredAt: "2026-07-15", replacement: "Vault and Surface" },
  "parachute-channel": { retiredAt: "2026-07-15", replacement: "Vault and Surface" },
  // Agent was removed from Hub on 2026-07-15. All historical service-row
  // identities are retired so normal manifest reads stop routing or supervising
  // the deprecated daemon. Generic AI-agent authorization grants/tokens are a
  // separate Hub capability and remain supported.
  // NOTE (2026-07-11, hub-parity P5 — `app` / `parachute-app` UN-RETIRED):
  // this table carried `app` + `parachute-app` (retired 2026-05-27, the
  // app → surface rename, patterns#102) from hub#219 through hub-parity P4.
  // They are REMOVED as of this note: a NEW, unrelated module — the real
  // `@openparachute/parachute-app` super-surface front door (see
  // FIRST_PARTY_FALLBACKS.app + PORT_RESERVATIONS' port-1944 comment) —
  // claims the `parachute-app` manifestName (and the bare `app` short) for
  // real. Keeping these entries would make `dropRetiredModuleRows`
  // unconditionally GC the new module's services.json row on every read,
  // breaking it outright — see the curation-rule exception above. An
  // operator with a genuinely stale PRE-2026-05-27 `app`/`parachute-app` row
  // (from the old, now-defunct @openparachute/app package) is handled the
  // same as any other unrecognized row once un-retired: `parachute status`
  // renders it, and `parachute serve` boots it via installDir's
  // module.json if present and logs-and-skips otherwise — the same
  // graceful fallback the `runner` registry removal (2026-07-01, see
  // KNOWN_MODULES below) relies on. In practice the real parachute-app
  // module's own first boot overwrites any stale row sharing its name.
};

/**
 * Synthesize a minimal `ModuleManifest` from a KNOWN_MODULES entry. Used as
 * a fallback when `<installDir>/.parachute/module.json` can't be read
 * (legacy installs from pre-module.json era, or test fixtures that mock the
 * disk path without writing a real manifest). When module.json is present,
 * **the module is authoritative** — this synthesized version is never used.
 *
 * The canonical fields mirror what each module ships in its real module.json
 * — keep them in sync if the module's canonical port / paths / health
 * declaration changes. The "module ships its own module.json" path is now
 * the production hot path post hub#310; this synthesis is a graceful-degrade
 * safety net.
 */
export function synthesizeManifestForKnownModule(km: KnownModule): ModuleManifest {
  const m: ModuleManifest = {
    name: km.short,
    manifestName: km.manifestName,
    displayName: km.displayName,
    tagline: km.tagline,
    port: km.canonicalPort,
    paths: km.canonicalPaths,
    health: km.canonicalHealth,
  };
  if (km.canonicalStripPrefix !== undefined) {
    (m as { stripPrefix?: boolean }).stripPrefix = km.canonicalStripPrefix;
  }
  return m;
}

/**
 * Effective publicExposure for a service, given what's on its services.json
 * entry. Explicit wins. If absent, derive from the spec: services with
 * declared auth (extras.hasAuth === true, or no hasAuth set) default to
 * "allowed"; services with extras.hasAuth === false default to
 * "auth-required". Unknown third-party services default to "allowed".
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
  if (short === undefined) return "allowed";
  // Post hub#301 Phase C/D (`kind` field retired — hub#330), the
  // exposure-default heuristic collapses to the imperative `extras.hasAuth`
  // signal: an explicit `hasAuth: false` declaration ("no auth gate
  // implemented yet") → require auth before exposing; anything else →
  // allowed. Scribe is the canonical `hasAuth: false` case today.
  const fb = FIRST_PARTY_FALLBACKS[short];
  if (fb) {
    return fb.extras?.hasAuth === false ? "auth-required" : "allowed";
  }
  const km = KNOWN_MODULES[short];
  if (km && km.extras?.hasAuth === false) return "auth-required";
  return "allowed";
}

export function knownServices(): string[] {
  return [...Object.keys(FIRST_PARTY_FALLBACKS), ...Object.keys(KNOWN_MODULES)];
}

/**
 * Default discovery tier per short name (2026-06-09 modular-UI architecture;
 * `deprecated` tier added 2026-06-25). The hub PREFERS a module's
 * manifest-declared `focus`; this map is the fallback when `module.json` omits
 * it (and the bootstrap value before a module is installed).
 *
 *   - `core` — vault / scribe / hub / surface / app (the product surface;
 *     `app` joined 2026-07-11, hub-parity P5 — the super-surface front door).
 *   - `experimental` — any unlisted third-party short.
 *   - `deprecated` — notes (notes-daemon deprecated 2026-05-22; notes-ui moved
 *     into parachute-surface). Still RESOLVABLE (discoverableShorts unchanged)
 *     and SHOWN-IF-INSTALLED so an existing operator can manage/uninstall, but
 *     NOT OFFERED on a fresh setup. `runner` used to sit here too (deprecated
 *     2026-06-25) until its full registry removal on 2026-07-01 — see the note
 *     in KNOWN_MODULES.
 *
 * **Show all installed; never hide** — `focus` groups + labels; the one
 * behavioral lever is the fresh-install OFFER, which drops `deprecated` shorts.
 */
const FOCUS_DEFAULTS: Record<string, ModuleFocus> = {
  vault: "core",
  scribe: "core",
  hub: "core",
  surface: "core",
  app: "core",

  notes: "deprecated",
};

/**
 * Resolve a short name's discovery tier. When `declared` (the module's
 * `module.json` `focus`) is present it wins; otherwise fall back to
 * `FOCUS_DEFAULTS`, defaulting any unlisted short to `experimental`. Never
 * returns undefined — the Modules screen always has a tier to group by.
 *
 * Tier semantics: `core`/`experimental` are both OFFERED on a fresh install;
 * `deprecated` (notes) is NOT offered on a fresh setup but stays
 * resolvable + shown-if-installed (the `isKnownModuleShort` /
 * `discoverableShorts` resolution surface is unchanged). The fresh-install
 * filters in `setup.ts` + `api-modules.ts` consult this tier to drop
 * `deprecated` shorts from the "available to install" set.
 */
export function focusForShort(short: string, declared?: ModuleFocus): ModuleFocus {
  if (declared !== undefined) return declared;
  return FOCUS_DEFAULTS[short] ?? "experimental";
}

/**
 * The set of short names the hub knows how to discover, display, and install
 * from its bootstrap registries — `KNOWN_MODULES` ∪ `FIRST_PARTY_FALLBACKS`.
 * This is the SELF-REGISTRATION-driven discovery surface that replaces the old
 * `CURATED_MODULES` whitelist (2026-06-09 modular-UI architecture, P2): every
 * module the hub can resolve a package/manifest for is discoverable + installable,
 * regardless of `focus` tier. Deduped, with FIRST_PARTY_FALLBACKS shorts first
 * (notes) then KNOWN_MODULES (vault / scribe / agent / surface).
 *
 * `notes` is intentionally included — still resolvable (vendored fallback)
 * for legacy installs; it surfaces as `deprecated` (2026-06-25) and isn't
 * OFFERED on a fresh install. The fresh-install OFFER (setup wizard + admin
 * SPA) filters by tier (`focus !== "deprecated"`); `discoverableShorts`
 * itself stays the full resolution surface so existing installs keep working.
 * `runner` is NOT here anymore (registry removal 2026-07-01 — see the
 * KNOWN_MODULES note); a legacy runner install is handled as an
 * unknown/third-party row.
 */
export function discoverableShorts(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const short of [...Object.keys(FIRST_PARTY_FALLBACKS), ...Object.keys(KNOWN_MODULES)]) {
    if (seen.has(short)) continue;
    seen.add(short);
    out.push(short);
  }
  return out;
}

/** True iff `short` is a module the hub can resolve a package/manifest for
 *  (the install-path gate, replacing the `CURATED_MODULES` whitelist). */
export function isKnownModuleShort(short: string): boolean {
  return short in FIRST_PARTY_FALLBACKS || short in KNOWN_MODULES;
}

/**
 * Canonical port assignment for a known short name, or `undefined` for
 * third-party services we don't have a fallback for. Drives the
 * canonical-port drift warning in `parachute status` (hub#195) — when an
 * entry's actual port doesn't match the canonical, we surface it without
 * blocking. Operators may have intentionally moved a service off canonical
 * (e.g. to dodge a third-party clash), so the drift is a warning, not an
 * error.
 *
 * Known gap (intentional, tracked separately): multi-vault instance rows
 * (`parachute-vault-default`, `parachute-vault-techne`, etc.) don't match
 * any `manifestName` in `FIRST_PARTY_FALLBACKS` — only the canonical
 * `parachute-vault` does — so `shortNameForManifest` returns undefined and
 * drift warnings never fire for them. That's tolerable: multi-vault is the
 * deliberate exception in the duplicate-port gate (one process, N mounts,
 * one port), and no operator-actionable drift signal is well-defined when
 * N rows share a port. Documented here so the gap doesn't read as an
 * oversight; revisit if a clean drift shape for multi-vault emerges.
 */
export function canonicalPortForManifest(manifestName: string): number | undefined {
  const short = shortNameForManifest(manifestName);
  if (short === undefined) return undefined;
  const fb = FIRST_PARTY_FALLBACKS[short];
  if (fb) return fb.manifest.port;
  const km = KNOWN_MODULES[short];
  return km?.canonicalPort;
}

/**
 * Resolve the runtime spec for a known short name.
 *
 * FIRST_PARTY_FALLBACKS shorts (notes / app) return a fully-composed
 * spec with embedded manifest + extras — the vendored manifest is the
 * source of truth pre-install and the install path preserves it through.
 *
 * KNOWN_MODULES shorts (vault / scribe / agent / surface — post
 * FALLBACK retirement) return a **minimal** spec carrying `package`, `manifestName`,
 * and the imperative `extras` fields
 * (`init`, `hasAuth`, `urlForEntry`, `postInstallFooter`). They do NOT carry
 * `startCmd` or `seedEntry` — those come from `<installDir>/.parachute/module.json`
 * at lifecycle time via {@link getSpecFromInstallDir}, since the module
 * itself is authoritative for the spawnable spec.
 *
 * Returns undefined for unknown shorts.
 */
export function getSpec(short: string): ServiceSpec | undefined {
  const fb = FIRST_PARTY_FALLBACKS[short];
  if (fb) {
    return composeServiceSpec({
      packageName: fb.package,
      manifest: fb.manifest,
      extras: fb.extras,
    });
  }
  const km = KNOWN_MODULES[short];
  if (!km) return undefined;
  // Use the synthesized manifest from KNOWN_MODULES' canonical fields so
  // downstream consumers (seedEntry, port assignment) see a coherent spec.
  // Module.json wins at lifecycle time (`composeKnownModuleSpec`); this
  // synth is the bootstrap shape.
  const synthManifest = synthesizeManifestForKnownModule(km);
  const spec: ServiceSpec = {
    package: km.package,
    manifestName: km.manifestName,
    seedEntry: () => seedEntryFromManifest(synthManifest),
  };
  if (km.extras?.hasAuth !== undefined) {
    (spec as { hasAuth?: boolean }).hasAuth = km.extras.hasAuth;
  }
  if (km.extras?.init !== undefined) (spec as { init?: readonly string[] }).init = km.extras.init;
  if (km.extras?.postInstallFooter !== undefined) {
    (spec as { postInstallFooter?: () => readonly string[] }).postInstallFooter =
      km.extras.postInstallFooter;
  }
  const urlForEntry = km.extras?.urlForEntry;
  if (urlForEntry !== undefined) {
    (spec as { urlForEntry?: typeof urlForEntry }).urlForEntry = urlForEntry;
  }
  // Imperative `extras.startCmd` is a backward-compat fallback for rows that
  // don't carry `installDir` (legacy services.json from before installDir
  // stamping landed, or test fixtures). Once the module has self-registered
  // and stamped installDir, lifecycle reads module.json's startCmd via
  // `composeKnownModuleSpec` and that path wins. The vendored startCmd here
  // is the same string the module's module.json declares — kept in
  // KNOWN_MODULES so legacy rows keep spawning.
  const startCmd = km.extras?.startCmd;
  if (startCmd !== undefined) {
    (spec as { startCmd?: typeof startCmd }).startCmd = startCmd;
  }
  return spec;
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
 *
 * `parachute-channel` → `agent` (2026-06-17): the channel module was renamed
 * to agent (parachute-channel → parachute-agent). Operators with an
 * un-upgraded `services.json` carry a `name: "parachute-channel"` row; this
 * alias keeps `shortNameForManifest("parachute-channel") === "agent"` so the
 * legacy row still resolves to the live agent module for routing + lifecycle
 * until the daemon re-registers under `parachute-agent`. Remove after one
 * release cycle, alongside the `channel → agent` install alias.
 */
const LEGACY_MANIFEST_ALIASES: Record<string, string> = {
  "parachute-lens": "notes",
};

/** Short name for a given manifest name, e.g. `parachute-vault` → `vault`.
 *  Consults both FIRST_PARTY_FALLBACKS (notes / app) and KNOWN_MODULES
 *  (vault / scribe / agent / surface — post-FALLBACK-retirement).
 *  Returns undefined for unknown manifests. */
export function shortNameForManifest(manifestName: string): string | undefined {
  for (const [short, fb] of Object.entries(FIRST_PARTY_FALLBACKS)) {
    if (fb.manifest.manifestName === manifestName) return short;
  }
  for (const [short, km] of Object.entries(KNOWN_MODULES)) {
    if (km.manifestName === manifestName) return short;
  }
  return LEGACY_MANIFEST_ALIASES[manifestName];
}

/**
 * Find a services.json row by its SHORT name (e.g. `"agent"`), resolving each
 * row's manifest name (`parachute-agent`) back through `shortNameForManifest`.
 *
 * services.json rows carry the MANIFEST name, not the bare short — so a direct
 * `s.name === short` comparison silently misses every first-party module. That
 * exact mismatch (`s.name === "agent"` vs a `parachute-agent` row) is what
 * surfaced a spurious "agent module is not installed" when wiring the agent
 * connection sink. Resolve through the short↔manifest map instead. Returns the
 * first match, or undefined when no installed row maps to `short`.
 *
 * NOTE: multi-instance vault rows (`parachute-vault-<name>`) are NOT resolvable
 * here — `shortNameForManifest` only knows the canonical `parachute-vault`, so
 * `findServiceByShort(services, "vault")` returns undefined even when a vault is
 * installed. Vault rows are resolved by mount path via `findVaultUpstream`; this
 * helper is for single-instance modules (agent / scribe / surface).
 */
export function findServiceByShort<T extends { name: string }>(
  services: readonly T[],
  short: string,
): T | undefined {
  return services.find((s) => shortNameForManifest(s.name) === short);
}

/**
 * Compose a `ServiceSpec` from a `KNOWN_MODULES` entry plus the static
 * manifest data the caller has on hand (typically read from
 * `<installDir>/.parachute/module.json`).
 *
 * Used at install-time and lifecycle-time for vault / scribe / surface —
 * where hub no longer vendors the manifest (services.json + module.json
 * are authoritative) but still needs the imperative `extras` bits
 * (`init`, `postInstallFooter`, `urlForEntry`, `hasAuth`) the CLI install
 * flow + status command consume.
 */
export function composeKnownModuleSpec(km: KnownModule, manifest: ModuleManifest): ServiceSpec {
  return composeServiceSpec({
    packageName: km.package,
    manifest,
    extras: km.extras,
  });
}
