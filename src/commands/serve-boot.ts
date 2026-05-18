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
import { type ServiceEntry, readManifest } from "../services-manifest.ts";
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
  const manifest = readManifest(opts.manifestPath);
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

    // Per-module .env layers under HUB_ORIGIN (hub-origin wins on
    // collision — it's the canonical issuer source, and a stale .env
    // shouldn't override the live `parachute serve` env).
    const fileEnv = readEnvFileValues(join(opts.configDir, short, ".env"));
    const env: Record<string, string> = { ...fileEnv };
    if (opts.hubOrigin) env[HUB_ORIGIN_ENV] = opts.hubOrigin;

    const req: {
      short: string;
      cmd: readonly string[];
      cwd?: string;
      env?: Record<string, string>;
    } = {
      short,
      cmd,
    };
    // Third-party modules ship clean relative startCmds — cwd:
    // installDir makes them resolve. First-party fallbacks use
    // absolute / PATH binaries so cwd is a no-op there.
    if (entry.installDir) req.cwd = entry.installDir;
    if (Object.keys(env).length > 0) req.env = env;

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
