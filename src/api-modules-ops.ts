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
 * Bearer-gated on `parachute:host:auth` like the rest of the
 * /api/modules surface.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { CURATED_MODULES, type CuratedModuleShort } from "./api-modules.ts";
import { validateAccessToken } from "./jwt-sign.ts";
import { FIRST_PARTY_FALLBACKS, type ServiceSpec, composeServiceSpec } from "./service-spec.ts";
import { findService, readManifest, removeService } from "./services-manifest.ts";
import type { ModuleState, SpawnRequest, Supervisor } from "./supervisor.ts";

/** Scope required for every POST + operation-poll endpoint here. */
export const API_MODULES_OPS_REQUIRED_SCOPE = "parachute:host:auth";

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

interface OperationsRegistry {
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

function specFor(short: CuratedModuleShort): ServiceSpec {
  const fb = FIRST_PARTY_FALLBACKS[short];
  // Curated set is a const; every entry has a fallback. The non-null
  // assertion is safe because CURATED_MODULES is a tuple-literal
  // intersected with the FIRST_PARTY_FALLBACKS key set.
  if (!fb) throw new Error(`internal: no fallback for curated ${short}`);
  return composeServiceSpec({
    packageName: fb.package,
    manifest: fb.manifest,
    extras: fb.extras,
  });
}

function defaultRun(cmd: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...cmd], { stdio: ["ignore", "inherit", "inherit"] });
  return proc.exited;
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
  void runInstall(op.id, short, spec, deps).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    registry.update(op.id, { status: "failed", error: msg }, `install failed: ${msg}`);
  });

  return acceptedOp(op.id);
}

async function runInstall(
  opId: string,
  short: CuratedModuleShort,
  spec: ServiceSpec,
  deps: ApiModulesOpsDeps,
): Promise<void> {
  const registry = deps.registry ?? defaultRegistry;
  const run = deps.run ?? defaultRun;
  registry.update(opId, { status: "running" }, `running bun add -g ${spec.package}@latest`);
  const code = await run(["bun", "add", "-g", `${spec.package}@latest`]);
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
        `bun add -g ${spec.package}@latest failed (exit ${code})`,
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

  // Spawn the child via the supervisor. Boot-spawn semantics apply.
  const state = await spawnSupervised(short, spec, deps);
  if (!state) {
    registry.update(
      opId,
      { status: "failed", error: "module installed but spawn failed (no startCmd resolved)" },
      `${short}: install succeeded but no startCmd resolvable from services.json`,
    );
    return;
  }
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
  registry.update(opId, { status: "running" }, `running bun add -g ${spec.package}@latest`);
  const code = await run(["bun", "add", "-g", `${spec.package}@latest`]);
  if (code !== 0) {
    const findGlobalInstall = deps.findGlobalInstall;
    const probed = findGlobalInstall?.(spec.package) ?? null;
    if (!probed) {
      registry.update(
        opId,
        { status: "failed", error: `bun add -g exited ${code}` },
        `bun add -g ${spec.package}@latest failed (exit ${code})`,
      );
      return;
    }
    registry.update(opId, {}, `bun add reported exit ${code} but package landed at ${probed}`);
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

// Suppress unused-import warning — kept around for the future
// install-dir surface where we'll need to existsSync the bun globals
// prefix before reporting "installed."
void existsSync;
