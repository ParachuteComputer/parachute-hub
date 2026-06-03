/**
 * Container-mode module boot helpers, separated from `serve.ts` so
 * tests can drive the supervisor wiring without standing up
 * `Bun.serve`.
 *
 * `bootSupervisedModules` reads services.json, resolves each
 * first-party module's `startCmd` from `SERVICE_SPECS`, and calls
 * `Supervisor.start` for each. Third-party modules with `installDir`
 * but no first-party fallback are also picked up via the same
 * `getSpecFromInstallDir` path that `commands/lifecycle.ts` uses, so
 * a hub-installed `@third-party/foo` boots the same way `vault` does.
 *
 * Idempotent: re-calling boot when modules are already running is a
 * no-op (supervisor's own idempotent `start`). Missing-startCmd rows
 * are logged + skipped, not fatal — the operator may have installed a
 * module that doesn't expose a daemon (e.g. CLI-only).
 */

import { join } from "node:path";
import { readEnvFileValues } from "../env-file.ts";
import { HUB_ORIGIN_ENV } from "../hub-origin.ts";
import { ModuleManifestError } from "../module-manifest.ts";
import {
  type ServiceSpec,
  getSpec,
  getSpecFromInstallDir,
  shortNameForManifest,
} from "../service-spec.ts";
import { type ServiceEntry, readManifestLenient } from "../services-manifest.ts";
import { enrichedPath } from "../spawn-path.ts";
import type { Supervisor } from "../supervisor.ts";

export interface BootOpts {
  /** Path to services.json. */
  readonly manifestPath: string;
  /** Config dir ($PARACHUTE_HOME). Used to read per-module .env. */
  readonly configDir: string;
  /** Canonical OAuth issuer / hub origin. Forwarded to child env as PARACHUTE_HUB_ORIGIN. */
  readonly hubOrigin?: string;
  /** Logger seam. */
  readonly log?: (line: string) => void;
}

export interface BootedModule {
  readonly short: string;
  readonly entryName: string;
  readonly status: "started" | "skipped";
  readonly reason?: string;
}

export interface SpawnReqShape {
  short: string;
  cmd: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface BuildSpawnRequestOpts {
  /** Config dir ($PARACHUTE_HOME). Used to read the module's per-service `.env`. */
  readonly configDir: string;
  /** Canonical hub origin → child env `PARACHUTE_HUB_ORIGIN`. Skipped when absent. */
  readonly hubOrigin?: string;
  /**
   * Extra env merged on top of the derived env (PORT / .env / HUB_ORIGIN).
   * Wins over all of them. Used by the API `start` handler's test seam +
   * first-boot vault-name pass-through (`spawnEnv`). Empty/absent on the
   * boot path.
   */
  readonly extraEnv?: Record<string, string>;
}

/**
 * Build the `Supervisor.start` request for a single module, identically on
 * both the serve-boot path and the `POST /api/modules/:short/start` handler.
 *
 * Env layering (later wins):
 *   1. `PORT` from the services.json `entry.port` — overrides hub's own PORT
 *      so supervised children honor their canonical port assignment
 *      (hub#356/#357). This is authoritative and is NOT overridable by a
 *      `.env` `PORT` (see below) — services.json is the single source of truth
 *      for the port (scribe#41 4-tier ladder; hub#206).
 *   2. per-service `.env` at `<configDir>/<short>/.env` — operator-configured
 *      values (e.g. scribe provider keys) merge on top. A `PORT` key here is
 *      dropped: a stale pre-#206 `.env` `PORT` must not shadow `entry.port`
 *      (hub#537 — a leftover scribe `PORT=1944` ≠ services.json `1943` leaked
 *      into the injected PORT and broke the supervisor's readiness probe).
 *   3. `PARACHUTE_HUB_ORIGIN` = `opts.hubOrigin` — anchors the child's `iss`
 *      expectation to the value hub mints with (hub#365).
 *   4. `opts.extraEnv` — test seam / first-boot pass-through; wins last.
 *
 * `cwd` is set to `entry.installDir` when present (third-party modules ship
 * relative startCmds that need it; first-party fallbacks use absolute / PATH
 * binaries so cwd is a no-op there).
 */
export function buildModuleSpawnRequest(
  short: string,
  entry: ServiceEntry,
  cmd: readonly string[],
  opts: BuildSpawnRequestOpts,
): SpawnReqShape {
  const fileEnv = readEnvFileValues(join(opts.configDir, short, ".env"));
  // Drop a `PORT` from the per-service .env: services.json `entry.port` is the
  // canonical port and must win (scribe#41 ladder; hub#206). A stale pre-#206
  // `.env` PORT (e.g. scribe's `1944` vs services.json `1943`) would otherwise
  // leak into the injected PORT and the supervisor's readiness probe would
  // check the wrong port → false `started_but_unbound` (hub#537). The module's
  // own resolvePort ladder already prefers services.json, so this keeps the
  // injected PORT + probe in agreement with what the child actually binds.
  const { PORT: _staleEnvPort, ...fileEnvSansPort } = fileEnv;
  // PATH enrichment (hub launchd-PATH regression): the hub unit bakes a minimal
  // PATH and `Bun.spawn` defaults to empty env, so without this the child only
  // ever sees the unit's PATH — which omits `$HOME/.local/bin` (scribe's
  // `parakeet-mlx`) + the Homebrew bin (`ffmpeg`), killing transcription on
  // canonical installs. `enrichedPath` appends those dirs (when they exist) to
  // the inherited PATH; inherited entries keep their order. A per-service `.env`
  // PATH (operator intent) still wins via the spread below. See `spawn-path.ts`.
  // The API-start path builds its own env — see `api-modules-ops.ts`
  // `spawnSupervised`, which calls `enrichedPath()` too (keep the two in sync).
  const env: Record<string, string> = {
    PATH: enrichedPath(),
    PORT: String(entry.port),
    ...fileEnvSansPort,
  };
  if (opts.hubOrigin) env[HUB_ORIGIN_ENV] = opts.hubOrigin;
  if (opts.extraEnv) Object.assign(env, opts.extraEnv);

  const req: SpawnReqShape = { short, cmd };
  if (entry.installDir) req.cwd = entry.installDir;
  if (Object.keys(env).length > 0) req.env = env;
  return req;
}

/**
 * Walk services.json, spawn every manageable module via the
 * supervisor. Returns a per-module decision log so the caller can
 * surface a startup summary.
 */
export async function bootSupervisedModules(
  supervisor: Supervisor,
  opts: BootOpts,
): Promise<BootedModule[]> {
  const log = opts.log ?? (() => {});
  // Lenient: a single bad row shouldn't prevent the supervisor from booting
  // the rest of the services. The container deploy hot path depends on this —
  // we'd rather have N-1 modules up + one warning than zero modules up.
  const manifest = readManifestLenient(opts.manifestPath);
  const results: BootedModule[] = [];

  for (const entry of manifest.services) {
    const short = shortNameForManifest(entry.name) ?? entry.name;
    const spec = await resolveSpec(short, entry);
    if (!spec) {
      // Row exists but no first-party fallback and no installDir-derived
      // manifest. `parachute start` would print the same hint; the
      // container path just logs + carries on.
      log(`[supervisor] ${short}: no startCmd resolvable (services.json entry exists, no spec).`);
      results.push({
        short,
        entryName: entry.name,
        status: "skipped",
        reason: "no-spec",
      });
      continue;
    }

    const cmd = spec.startCmd?.(entry);
    if (!cmd || cmd.length === 0) {
      log(`[supervisor] ${short}: spec resolved but no startCmd — skipping (CLI-only module).`);
      results.push({
        short,
        entryName: entry.name,
        status: "skipped",
        reason: "no-start-cmd",
      });
      continue;
    }

    // PORT override (hub#357 — third spawn site missed by hub#356), per-service
    // .env merge, and PARACHUTE_HUB_ORIGIN propagation (hub#365) all live in the
    // shared `buildModuleSpawnRequest` so the `POST /api/modules/:short/start`
    // handler builds an identical request (design 2026-06-01 §3.3).
    const req = buildModuleSpawnRequest(short, entry, cmd, {
      configDir: opts.configDir,
      ...(opts.hubOrigin !== undefined ? { hubOrigin: opts.hubOrigin } : {}),
    });

    // Serial await, not Promise.all: `supervisor.start` now carries a bounded
    // post-spawn port-readiness gate (DEFAULT_START_READY_MS), so boot latency
    // is the SUM of each slow-binding module's gate wait before `Bun.serve`
    // comes up. Intentional — sequential boot keeps the start-error/install-card
    // surface ordered and avoids a thundering-herd of port probes. Don't switch
    // to `Promise.all` without accounting for the gate (it'd overlap the waits
    // but also fire N concurrent readiness probes mid-boot).
    await supervisor.start(req);
    log(`[supervisor] ${short}: started (cmd=${cmd.join(" ")}).`);
    results.push({ short, entryName: entry.name, status: "started" });
  }

  return results;
}

async function resolveSpec(short: string, entry: ServiceEntry): Promise<ServiceSpec | undefined> {
  const firstParty = getSpec(short);
  if (firstParty) return firstParty;
  if (!entry.installDir) return undefined;
  try {
    const spec = await getSpecFromInstallDir(entry.installDir, entry.name);
    return spec ?? undefined;
  } catch (err) {
    if (err instanceof ModuleManifestError) return undefined;
    throw err;
  }
}
