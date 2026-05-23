/**
 * `/api/modules/:short/*` POST endpoints + `/api/modules/operations/:id`
 * — module lifecycle operations driven from the admin SPA.
 *
 * Two operation classes:
 *
 *   - **Synchronous** (restart, uninstall): handler runs the work
 *     inline and returns the new state in the response body. Fast
 *     enough that the UI just shows a spinner for the request
 *     round-trip — no operation_id needed.
 *
 *   - **Asynchronous** (install, upgrade): handler kicks off work via
 *     `Bun.spawn` for `bun add` and returns 202 + `{operation_id}`
 *     immediately. The UI polls `GET /api/modules/operations/:id`
 *     every ~1s until the operation reaches a terminal state. This
 *     decouples the npm download (which can take 10-60s on a slow
 *     link) from the request timeout.
 *
 * Operation state lives in an in-memory registry — a singleton Map
 * keyed by uuid. State is transient by design: a hub restart drops
 * pending ops, which is the correct behavior because the underlying
 * `bun add` is no longer running and the supervisor's own state is
 * the source of truth post-restart. The UI re-polls /api/modules to
 * re-derive what's actually installed.
 *
 * Bearer-gated on `parachute:host:admin` (destructive ops). Diverges
 * from the read-only `/api/modules` GET which sits on the broader
 * `:host:auth` scope: reading the catalog is part of the auth
 * surface, mutating it is admin-only. A `:auth`-only automation token
 * gets 403 here; the SPA's host-admin mint
 * (`/admin/host-admin-token`) carries both scopes so the UI path is
 * unaffected.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { CURATED_MODULES, type CuratedModuleShort } from "./api-modules.ts";
import { PARACHUTE_INSTALL_CHANNEL_ENV } from "./commands/install.ts";
import { getModuleInstallChannel } from "./hub-settings.ts";
import { validateAccessToken } from "./jwt-sign.ts";
import { readModuleManifest } from "./module-manifest.ts";
import { refreshWellKnown, stampInstallDirOnRow } from "./post-install.ts";
import {
  KNOWN_MODULES,
  type ServiceSpec,
  composeKnownModuleSpec,
  getSpec,
  synthesizeManifestForKnownModule,
} from "./service-spec.ts";
import { findService, readManifest, removeService } from "./services-manifest.ts";
import type { ModuleState, SpawnRequest, Supervisor } from "./supervisor.ts";
import { WELL_KNOWN_PATH, type regenerateWellKnown } from "./well-known.ts";

/**
 * Scope required for every POST + operation-poll endpoint here.
 *
 * `:host:admin` (not `:host:auth`) because install / upgrade /
 * uninstall change the running set of system components — destructive
 * by definition. The SPA mints both scopes through
 * `/admin/host-admin-token` so its bearer carries this; an automation
 * caller minted with `--scope-set auth` gets 403 from these endpoints,
 * which is the intended security boundary.
 */
export const API_MODULES_OPS_REQUIRED_SCOPE = "parachute:host:admin";

export type OperationKind = "install" | "upgrade" | "restart" | "uninstall";
export type OperationStatus = "pending" | "running" | "succeeded" | "failed";

export interface Operation {
  id: string;
  kind: OperationKind;
  short: string;
  status: OperationStatus;
  /** Sparse log of progress events surfaced to the UI ("running bun add…", etc). */
  log: string[];
  /** Error message when status is `failed`. Mirrored from the underlying throw. */
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface OperationsRegistry {
  create(kind: OperationKind, short: string): Operation;
  get(id: string): Operation | undefined;
  /** Append a log line + (optionally) advance status. */
  update(id: string, patch: Partial<Pick<Operation, "status" | "error">>, logLine?: string): void;
}

/**
 * Process-local operations registry. One Map for the lifetime of
 * `parachute serve`. Tests opt into a fresh registry per case via
 * `_resetOperationsRegistryForTests`.
 */
class InMemoryOperationsRegistry implements OperationsRegistry {
  private readonly ops = new Map<string, Operation>();
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  create(kind: OperationKind, short: string): Operation {
    const op: Operation = {
      id: randomUUID(),
      kind,
      short,
      status: "pending",
      log: [],
      startedAt: this.clock().toISOString(),
    };
    this.ops.set(op.id, op);
    return op;
  }

  get(id: string): Operation | undefined {
    return this.ops.get(id);
  }

  update(id: string, patch: Partial<Pick<Operation, "status" | "error">>, logLine?: string): void {
    const op = this.ops.get(id);
    if (!op) return;
    if (patch.status) op.status = patch.status;
    if (patch.error !== undefined) op.error = patch.error;
    if (logLine) op.log.push(logLine);
    if (patch.status === "succeeded" || patch.status === "failed") {
      op.finishedAt = this.clock().toISOString();
    }
  }
}

const defaultRegistry = new InMemoryOperationsRegistry();

/**
 * Access the process-singleton operations registry. Non-API callers
 * (the first-boot wizard, hub#259) hand this to `runInstall` so the
 * resulting op is poll-able through the same
 * `/api/modules/operations/:id` surface the SPA uses — a stale tab
 * watching the wizard's poll-cookie URL can still hand off mid-flight
 * to the admin UI's module-management page after setup completes.
 */
export function getDefaultOperationsRegistry(): OperationsRegistry {
  return defaultRegistry;
}

/** Reset the singleton operations registry — tests call between cases. */
export function _resetOperationsRegistryForTests(): void {
  // The Map underneath is private; re-create the singleton by replacing
  // every entry. Cheaper than re-exporting a mutable reference.
  const r = defaultRegistry as unknown as { ops: Map<string, Operation> };
  r.ops.clear();
}

export interface RunOpts {
  /** stdio-inheriting Bun.spawn wrapper for `bun add` / `bun remove`. */
  run?: (cmd: readonly string[]) => Promise<number>;
}

export interface ApiModulesOpsDeps {
  db: Database;
  issuer: string;
  manifestPath: string;
  configDir: string;
  supervisor: Supervisor;
  /**
   * Override the operations registry (test seam). Production uses the
   * process-singleton; tests inject one with a deterministic clock so
   * `startedAt`/`finishedAt` are stable.
   */
  registry?: OperationsRegistry;
  /**
   * Override the shell runner (test seam). Production spawns `bun add`
   * / `bun remove` for real; tests stub to a fast in-memory function
   * that returns a chosen exit code without touching the filesystem.
   */
  run?: (cmd: readonly string[]) => Promise<number>;
  /** Override the cwd for the install dir lookup (BUN_INSTALL-aware). */
  bunInstallDir?: string;
  /**
   * Override `findGlobalInstall`. Production probes bun's globals
   * (BUN_INSTALL-aware via `${BUN_INSTALL}/install/global/...`); tests
   * inject a fake. Returns the path to the installed package.json or
   * null when not found.
   */
  findGlobalInstall?: (pkg: string) => string | null;
  /**
   * Extra env vars merged onto the supervised child at spawn time (hub#267).
   *
   * The first-boot wizard uses this to pass `PARACHUTE_VAULT_NAME=<typed>`
   * through to vault's first-boot path so the operator-typed name flows
   * end-to-end (vault's `server.ts` reads the env var on its first-boot
   * branch and creates the vault under that name instead of the hard-coded
   * `default`). Generic enough that future env-driven config (e.g.
   * `SCRIBE_MODEL`) can ride the same seam without growing a new field.
   *
   * Threaded to the supervisor's `SpawnRequest.env` — the merge happens
   * inside `Bun.spawn` at child spawn time; we don't mutate `process.env`.
   */
  spawnEnv?: Record<string, string>;
  /**
   * Override the on-disk path for the regenerated `/.well-known/parachute.json`
   * (test seam). Production writes to `WELL_KNOWN_PATH`; tests point at a
   * tmp file so assertions can read the resulting doc without touching the
   * operator's real config dir.
   */
  wellKnownPath?: string;
  /**
   * Reader for `<installDir>/.parachute/module.json` used by the well-known
   * regen. Production reads from disk; tests inject a fake. Mirrors the
   * hub-server `readModuleManifest` seam so the disk regen and the
   * per-request HTTP build stay aligned.
   */
  readModuleManifest?: Parameters<typeof regenerateWellKnown>[0]["readModuleManifest"];
}

interface PathMatch {
  short: CuratedModuleShort;
  rest: string;
}

/**
 * Parse `/api/modules/<short>/<rest>` into the canonical short name +
 * the action suffix. Rejects unknown shorts to keep arbitrary
 * services.json names from driving the install pathway (curated-only
 * for v0.6).
 */
export function parseModulesPath(pathname: string): PathMatch | undefined {
  const prefix = "/api/modules/";
  if (!pathname.startsWith(prefix)) return undefined;
  const tail = pathname.slice(prefix.length);
  const slash = tail.indexOf("/");
  if (slash <= 0) return undefined;
  const short = tail.slice(0, slash);
  const rest = tail.slice(slash + 1);
  if (!CURATED_MODULES.includes(short as CuratedModuleShort)) return undefined;
  return { short: short as CuratedModuleShort, rest };
}

async function authorize(req: Request, deps: ApiModulesOpsDeps): Promise<Response | undefined> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) return jsonError(401, "unauthenticated", "empty bearer token");
  try {
    const validated = await validateAccessToken(deps.db, bearer, deps.issuer);
    if (typeof validated.payload.sub !== "string" || validated.payload.sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    const scopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
    if (!scopes.includes(API_MODULES_OPS_REQUIRED_SCOPE)) {
      return jsonError(
        403,
        "insufficient_scope",
        `bearer token lacks ${API_MODULES_OPS_REQUIRED_SCOPE}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }
  return undefined;
}

/**
 * Resolve the canonical `ServiceSpec` for a curated module short — the
 * pair of (package, manifest) the supervisor + install runner act on.
 * Exported so non-API callers (the first-boot wizard, hub#259) can
 * reach the same spec the API handlers use without duplicating the
 * curated-table lookup.
 *
 * Two source paths (hub#310, post-FALLBACK-retirement for vault/scribe/runner):
 *
 *   - **FIRST_PARTY_FALLBACKS** (notes / channel): vendored manifest is
 *     authoritative pre-install — the embedded `manifest.startCmd` /
 *     `manifest.paths` / etc. drive the install + spawn flow.
 *   - **KNOWN_MODULES** (vault / scribe / runner): no vendored manifest.
 *     Pre-install we know only the npm package + manifestName + canonical
 *     port + imperative `extras` (init, postInstallFooter, urlForEntry,
 *     hasAuth). Post-install, `runInstall` reads `<installDir>/.parachute/module.json`
 *     to compose a full spawnable spec via `resolveSpawnSpec`.
 *
 * The returned spec carries `manifestName`, `package`, `seedEntry` (FALLBACK
 * only), and `startCmd` (FALLBACK only — KNOWN_MODULES gets it post-install).
 * Callers downstream of `bun add -g` consult `resolveSpawnSpec` to fill the
 * KNOWN_MODULES gap.
 */
export function specFor(short: CuratedModuleShort): ServiceSpec {
  const spec = getSpec(short);
  if (!spec) throw new Error(`internal: no curated entry for ${short}`);
  return spec;
}

/**
 * Compose the full spawnable spec for a KNOWN_MODULES short by reading
 * `<installDir>/.parachute/module.json`. Used post-`bun add -g` in
 * `runInstall` / `runUpgrade` to derive the startCmd hub needs to spawn the
 * supervised child.
 *
 * Returns `null` when the manifest is absent or unreadable — caller surfaces
 * a "module installed but no module.json on disk" error and the operation
 * fails with status `failed`. Throws `ModuleManifestError` on a malformed
 * manifest, same surface as `getSpecFromInstallDir`.
 */
async function resolveSpawnSpec(
  short: CuratedModuleShort,
  installDir: string,
): Promise<ServiceSpec | null> {
  const km = KNOWN_MODULES[short];
  if (!km) return null;
  // module.json is the canonical source — module is authoritative for its
  // own startCmd / paths. Synthesize a minimal manifest from KNOWN_MODULES
  // as a graceful-degrade fallback when the file isn't readable (legacy
  // installs, test fixtures); the imperative `extras.startCmd` in
  // KNOWN_MODULES still applies so the supervisor can spawn.
  const manifest = (await readModuleManifest(installDir)) ?? synthesizeManifestForKnownModule(km);
  return composeKnownModuleSpec(km, manifest);
}

function defaultRun(cmd: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...cmd], { stdio: ["ignore", "inherit", "inherit"] });
  return proc.exited;
}

/**
 * Resolve which `<pkg>@<channel>` the API install path should ship,
 * given the per-request override (POST body `channel`) and the
 * cascading defaults. See `runInstall` for the precedence chain.
 *
 * Exported (test-only) so the api-modules-ops tests can assert the
 * resolution without re-driving a full install through the registry.
 */
function resolveApiInstallChannel(
  channelOverride: string | undefined,
  deps: ApiModulesOpsDeps,
): string {
  // 1. Per-request override.
  if (channelOverride === "rc" || channelOverride === "latest") return channelOverride;
  // 2. `PARACHUTE_INSTALL_CHANNEL` env var — cluster-wide cascade.
  const fromEnv = process.env[PARACHUTE_INSTALL_CHANNEL_ENV];
  if (typeof fromEnv === "string") {
    if (fromEnv === "rc" || fromEnv === "latest") return fromEnv;
    if (fromEnv.length > 0) {
      // Garbage env value — log once per op so the operator notices, then
      // fall through to the DB-stored channel. Don't crash the install.
      console.warn(
        `[api-modules-ops] ${PARACHUTE_INSTALL_CHANNEL_ENV}="${fromEnv}" is not a valid channel — falling back to admin-toggle setting.`,
      );
    }
  }
  // 3. Admin-toggle setting (hub#275). Seeds from `PARACHUTE_MODULE_CHANNEL`
  // on first read; after that the row is source of truth.
  return getModuleInstallChannel(deps.db);
}

/**
 * Resolve the `installDir` for `spec` from `findGlobalInstall`. Null when
 * the dep isn't wired (tests without a stub) or the package can't be
 * located on disk. Same fallback semantics the previous inline
 * `stampInstallDir` had — callers fall through to a regen-only path.
 */
function resolveInstallDirForSpec(spec: ServiceSpec, deps: ApiModulesOpsDeps): string | null {
  const findGlobalInstall = deps.findGlobalInstall;
  if (!findGlobalInstall) return null;
  const pkgJson = findGlobalInstall(spec.package);
  return pkgJson ? dirname(pkgJson) : null;
}

/**
 * Build the op-log sink for `opId`. Threaded into `finalizeModuleInstall` /
 * `refreshWellKnown` so their `regenerated <path>` / `well-known regen
 * failed: …` lines land on the operation the UI is polling.
 */
function opLog(opId: string, registry: OperationsRegistry): (msg: string) => void {
  return (msg) => registry.update(opId, {}, msg);
}

/**
 * Spawn the supervised child for `short`, using the spec's startCmd
 * and the current services.json entry (so notes' port-derived
 * startCmd resolves correctly).
 */
async function spawnSupervised(
  short: CuratedModuleShort,
  spec: ServiceSpec,
  deps: ApiModulesOpsDeps,
): Promise<ModuleState | undefined> {
  const manifest = readManifest(deps.manifestPath);
  const entry = manifest.services.find((s) => s.name === spec.manifestName);
  if (!entry) return undefined;
  const cmd = spec.startCmd?.(entry);
  if (!cmd || cmd.length === 0) return undefined;
  const req: SpawnRequest = {
    short,
    cmd,
    ...(entry.installDir ? { cwd: entry.installDir } : {}),
    ...(deps.spawnEnv && Object.keys(deps.spawnEnv).length > 0 ? { env: deps.spawnEnv } : {}),
  };
  return deps.supervisor.start(req);
}

/**
 * POST /api/modules/:short/install — async.
 *
 * Schedules a `bun add @openparachute/<svc>@latest` followed by
 * services.json seed + supervisor spawn. Returns 202 + operation_id
 * immediately; the UI polls /api/modules/operations/:id.
 *
 * Idempotent: if the module is already installed AND its supervisor
 * state is running, the operation completes immediately with status
 * `succeeded` and a "already running" log line. The UI doesn't have
 * to special-case "this was a no-op."
 */
export async function handleInstall(
  req: Request,
  short: CuratedModuleShort,
  deps: ApiModulesOpsDeps,
): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  const authFail = await authorize(req, deps);
  if (authFail) return authFail;

  // Optional `{ channel: "rc" | "latest" }` in the body — per-call override
  // for the SPA's "install X at rc" affordance (hub#337). Missing body /
  // empty body / non-JSON body all fall through silently to the env →
  // DB-stored channel resolution chain. A malformed `channel` value (not
  // in the union) is rejected — operators shouldn't get a silent fallback
  // on a typo they explicitly typed.
  let bodyChannel: string | undefined;
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = (await req.json()) as { channel?: unknown };
      if (body && typeof body.channel === "string") {
        if (body.channel !== "rc" && body.channel !== "latest") {
          return jsonError(
            400,
            "invalid_channel",
            `channel must be "rc" or "latest" (got "${body.channel}")`,
          );
        }
        bodyChannel = body.channel;
      }
    } catch {
      // Empty body / unparseable JSON — silently ignore; the env/DB
      // resolution chain still applies.
    }
  }

  const registry = deps.registry ?? defaultRegistry;
  const op = registry.create("install", short);

  // Idempotent short-circuit: already installed + running → mark
  // succeeded synchronously so the UI's "operation finished"
  // pathway works the same as a fresh install.
  const spec = specFor(short);
  const existing = findService(spec.manifestName, deps.manifestPath);
  const state = deps.supervisor.get(short);
  if (existing && state?.status === "running") {
    registry.update(op.id, { status: "succeeded" }, `${short} already installed + running`);
    return acceptedOp(op.id);
  }

  // Kick off the async work. We DON'T await — the response goes back
  // immediately + the work runs in the background. Errors get logged
  // to the operation; nothing throws back to the request handler.
  void runInstall(op.id, short, spec, deps, bodyChannel).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    registry.update(op.id, { status: "failed", error: msg }, `install failed: ${msg}`);
  });

  return acceptedOp(op.id);
}

/**
 * Internal install runner. Exported so non-API callers (the first-boot
 * wizard at `/admin/setup`, hub#259) can drive the same install →
 * services.json-seed → supervisor-spawn sequence without re-fabricating
 * an HTTP request + bearer token just to hit `handleInstall`.
 *
 * The op-id + registry threading is identical to the API path; the
 * wizard creates its own op, awaits this function, and surfaces the
 * resulting state to the operator.
 */
export async function runInstall(
  opId: string,
  short: CuratedModuleShort,
  spec: ServiceSpec,
  deps: ApiModulesOpsDeps,
  channelOverride?: string,
): Promise<void> {
  const registry = deps.registry ?? defaultRegistry;
  const run = deps.run ?? defaultRun;
  // Channel resolution (hub#337) — precedence:
  //   1. per-request `channelOverride` (POST body `{channel}`)
  //   2. `PARACHUTE_INSTALL_CHANNEL` env var (platform-default cascade for
  //      Render-style deploys that ship hub on rc and want rc for every
  //      module installed via /admin/modules too)
  //   3. `hub_settings.module_install_channel` (admin SPA toggle, hub#275 —
  //      seeded from `PARACHUTE_MODULE_CHANNEL` on first read)
  //   4. "latest" fallback
  //
  // Read on every op so a toggle change applies to the next install
  // without a hub restart.
  const channel = resolveApiInstallChannel(channelOverride, deps);
  const spec_str = `${spec.package}@${channel}`;
  registry.update(opId, { status: "running" }, `running bun add -g ${spec_str}`);
  const code = await run(["bun", "add", "-g", spec_str]);
  if (code !== 0) {
    // Bun 1.2.x lockfile-recovery noise: probe the global prefix
    // before treating non-zero as fatal. Mirrors the same defense in
    // commands/install.ts.
    const findGlobalInstall = deps.findGlobalInstall;
    const probed = findGlobalInstall?.(spec.package) ?? null;
    if (!probed) {
      registry.update(
        opId,
        { status: "failed", error: `bun add -g exited ${code}` },
        `bun add -g ${spec_str} failed (exit ${code})`,
      );
      return;
    }
    registry.update(opId, {}, `bun add reported exit ${code} but package landed at ${probed}`);
  }

  // Seed services.json if absent (the install flow does this for the
  // CLI; we replicate the seed-only piece here so the supervisor's
  // boot path can spawn next time).
  if (spec.seedEntry) {
    const existing = findService(spec.manifestName, deps.manifestPath);
    if (!existing) {
      const entry = spec.seedEntry();
      const { upsertService } = await import("./services-manifest.ts");
      upsertService(entry, deps.manifestPath);
      registry.update(opId, {}, `seeded services.json entry for ${short}`);
    }
  }

  // Stamp `installDir` on the services.json row BEFORE the spawn so the
  // supervisor sees the updated row if it consults services.json
  // post-spawn. Mirrors `parachute install <svc>`. Without the stamp,
  // the discovery page's `loadServiceUiMetadata` resolver skips the
  // row (no installDir → no module.json → no uiUrl) and the new
  // module's tile never renders on `/`.
  const installDir = resolveInstallDirForSpec(spec, deps);
  if (installDir) {
    stampInstallDirOnRow({
      manifestName: spec.manifestName,
      installDir,
      servicesJsonPath: deps.manifestPath,
    });
  }

  // KNOWN_MODULES shorts (vault / scribe / runner — hub#310): module.json
  // is the canonical source for startCmd. Re-resolve the spec from
  // `<installDir>/.parachute/module.json` when installDir is stamped so the
  // module is authoritative for its own spawn cmd. Falls back to the
  // imperative `extras.startCmd` carried by `spec` (from `specFor`) when
  // installDir is absent or module.json is unreadable. FIRST_PARTY_FALLBACKS
  // shorts (notes / channel) don't take this path — they're already in
  // KNOWN_MODULES[short] === undefined so the short-circuit applies.
  let spawnSpec: ServiceSpec = spec;
  if (installDir && KNOWN_MODULES[short]) {
    const resolved = await resolveSpawnSpec(short, installDir);
    if (resolved) {
      spawnSpec = resolved;
    }
  }

  // Spawn the child via the supervisor. Boot-spawn semantics apply.
  const state = await spawnSupervised(short, spawnSpec, deps);
  if (!state) {
    registry.update(
      opId,
      {
        status: "failed",
        error: "module installed but spawn failed (no startCmd resolved from module.json)",
      },
      `${short}: install succeeded but no startCmd resolvable — confirm <installDir>/.parachute/module.json carries a startCmd`,
    );
    return;
  }

  // Regen the on-disk well-known doc. `~/.parachute/well-known/parachute.json`
  // is an inspection artifact, not the live discovery source (hub-server.ts
  // builds per-request from services.json), so it stays in lockstep with
  // the live HTTP path only when we explicitly refresh it after a
  // state-changing op. Paired with the pre-spawn stamp above so this op
  // closes the "newly installed module doesn't appear on discovery"
  // bug from hub#292 / hub#298.
  await refreshWellKnown({
    servicesJsonPath: deps.manifestPath,
    canonicalOrigin: deps.issuer,
    wellKnownPath: deps.wellKnownPath ?? WELL_KNOWN_PATH,
    log: opLog(opId, registry),
    ...(deps.readModuleManifest ? { readModuleManifest: deps.readModuleManifest } : {}),
  });

  registry.update(opId, { status: "succeeded" }, `${short} installed + spawned (pid ${state.pid})`);
}

/**
 * POST /api/modules/:short/restart — synchronous.
 *
 * Routes through `supervisor.restart(short)` which does stop → await
 * exit → start with the same SpawnRequest. Returns the new state in
 * the body — the UI's spinner can clear as soon as the response
 * arrives, no operation poll needed.
 */
export async function handleRestart(
  req: Request,
  short: CuratedModuleShort,
  deps: ApiModulesOpsDeps,
): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  const authFail = await authorize(req, deps);
  if (authFail) return authFail;

  const state = await deps.supervisor.restart(short);
  if (!state) {
    return jsonError(
      404,
      "not_supervised",
      `${short} is not currently supervised — install it first`,
    );
  }
  return jsonOk({ short, state });
}

/**
 * POST /api/modules/:short/upgrade — async.
 *
 * Runs `bun add -g @openparachute/<svc>@latest` then restarts the
 * supervised child. Same operation-poll pattern as install.
 */
export async function handleUpgrade(
  req: Request,
  short: CuratedModuleShort,
  deps: ApiModulesOpsDeps,
): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  const authFail = await authorize(req, deps);
  if (authFail) return authFail;

  const registry = deps.registry ?? defaultRegistry;
  const op = registry.create("upgrade", short);
  const spec = specFor(short);

  void runUpgrade(op.id, short, spec, deps).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    registry.update(op.id, { status: "failed", error: msg }, `upgrade failed: ${msg}`);
  });
  return acceptedOp(op.id);
}

async function runUpgrade(
  opId: string,
  short: CuratedModuleShort,
  spec: ServiceSpec,
  deps: ApiModulesOpsDeps,
): Promise<void> {
  const registry = deps.registry ?? defaultRegistry;
  const run = deps.run ?? defaultRun;
  // Mirror runInstall's precedence so PARACHUTE_INSTALL_CHANNEL=rc cascades
  // to admin-SPA-driven upgrades too. Without this, a Render deploy with
  // env=rc would install at @rc but upgrade through the SPA at whatever
  // the DB toggle says — asymmetric + surprising to the operator.
  // (Operators who want different install vs upgrade channels can still
  // do so via the DB toggle when no env is set.)
  const channel = resolveApiInstallChannel(undefined, deps);
  const spec_str = `${spec.package}@${channel}`;
  registry.update(opId, { status: "running" }, `running bun add -g ${spec_str}`);
  const code = await run(["bun", "add", "-g", spec_str]);
  if (code !== 0) {
    const findGlobalInstall = deps.findGlobalInstall;
    const probed = findGlobalInstall?.(spec.package) ?? null;
    if (!probed) {
      registry.update(
        opId,
        { status: "failed", error: `bun add -g exited ${code}` },
        `bun add -g ${spec_str} failed (exit ${code})`,
      );
      return;
    }
    registry.update(opId, {}, `bun add reported exit ${code} but package landed at ${probed}`);
  }

  // Re-stamp installDir after upgrade — a major-version bump may relocate
  // the package on disk (e.g. node_modules layout change). Idempotent
  // when the path is stable.
  const installDir = resolveInstallDirForSpec(spec, deps);
  if (installDir) {
    stampInstallDirOnRow({
      manifestName: spec.manifestName,
      installDir,
      servicesJsonPath: deps.manifestPath,
    });
  }

  const state = await deps.supervisor.restart(short);
  if (!state) {
    registry.update(
      opId,
      { status: "failed", error: "upgrade installed but supervisor restart found no module" },
      `${short}: upgraded but supervisor had no live entry — try install first`,
    );
    return;
  }

  // Refresh the on-disk well-known so the version field on the upgraded
  // module's row reflects the new install. The HTTP path rebuilds per
  // request, so the discovery page tracks the new version regardless;
  // this keeps the inspection artifact aligned.
  await refreshWellKnown({
    servicesJsonPath: deps.manifestPath,
    canonicalOrigin: deps.issuer,
    wellKnownPath: deps.wellKnownPath ?? WELL_KNOWN_PATH,
    log: opLog(opId, registry),
    ...(deps.readModuleManifest ? { readModuleManifest: deps.readModuleManifest } : {}),
  });

  registry.update(
    opId,
    { status: "succeeded" },
    `${short} upgraded + restarted (pid ${state.pid})`,
  );
}

/**
 * POST /api/modules/:short/uninstall — synchronous.
 *
 * Stops the supervised child, removes the services.json row, runs
 * `bun remove -g <pkg>`. Returns the final state for UI confirmation.
 * Idempotent: missing supervisor entry / missing services.json row /
 * missing global install are all handled gracefully (the operation
 * succeeds with a per-step "already gone" log).
 */
export async function handleUninstall(
  req: Request,
  short: CuratedModuleShort,
  deps: ApiModulesOpsDeps,
): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  const authFail = await authorize(req, deps);
  if (authFail) return authFail;

  const spec = specFor(short);
  const log: string[] = [];

  // 1. Stop the supervised child (idempotent — null on missing).
  const stopped = await deps.supervisor.stop(short);
  log.push(stopped ? `${short} supervisor stopped` : `${short} not supervised`);

  // 2. Drop the services.json row (idempotent — readManifest is empty if missing).
  const before = readManifest(deps.manifestPath);
  if (before.services.some((s) => s.name === spec.manifestName)) {
    removeService(spec.manifestName, deps.manifestPath);
    log.push(`removed ${spec.manifestName} from services.json`);
  } else {
    log.push(`${spec.manifestName} not in services.json`);
  }

  // 3. bun remove -g (idempotent on missing — bun returns 0).
  const run = deps.run ?? defaultRun;
  const code = await run(["bun", "remove", "-g", spec.package]);
  log.push(`bun remove -g ${spec.package} exited ${code}`);

  // 4. Refresh the on-disk well-known so the uninstalled module no
  // longer appears in the inspection artifact. The HTTP path rebuilds
  // per request, so live discovery drops the entry immediately; this
  // is the disk-side equivalent.
  await refreshWellKnown({
    servicesJsonPath: deps.manifestPath,
    canonicalOrigin: deps.issuer,
    wellKnownPath: deps.wellKnownPath ?? WELL_KNOWN_PATH,
    log: (msg) => log.push(msg),
    ...(deps.readModuleManifest ? { readModuleManifest: deps.readModuleManifest } : {}),
  });

  return jsonOk({ short, log });
}

/**
 * GET /api/modules/operations/:id — poll operation status.
 */
export async function handleOperationGet(
  req: Request,
  opId: string,
  deps: ApiModulesOpsDeps,
): Promise<Response> {
  if (req.method !== "GET") return jsonError(405, "method_not_allowed", "use GET");
  const authFail = await authorize(req, deps);
  if (authFail) return authFail;

  const registry = deps.registry ?? defaultRegistry;
  const op = registry.get(opId);
  if (!op) {
    return jsonError(404, "not_found", `no operation with id ${opId}`);
  }
  return jsonOk(op);
}

function jsonError(status: number, code: string, description: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function acceptedOp(opId: string): Response {
  return new Response(JSON.stringify({ operation_id: opId }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
}
