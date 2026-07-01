/**
 * Surface → bare-repo registry for the Surface Git Transport (Phase 1, design
 * doc 2026-06-30-surface-git-transport.md §9 + §10, "Decisions locked" #3).
 *
 * This is the hub-side half of "vault declares, hub authenticates, surface-host
 * serves." The vault holds the `#surface` declaration; surface-host discovers it
 * (it custodies a vault read cred) and REGISTERS the surface with the hub over
 * `POST /admin/surfaces` (operator-authed). This module owns the resulting
 * mapping:
 *
 *   - the persisted `name → bare-repo` registry (`<gitRoot>/registry.json`), and
 *   - the async bare-repo provisioning (`ensureSurfaceRepo`).
 *
 * The registry is what TIES provisioning to a declared surface (§10 step 1): the
 * git-transport endpoint only serves — and only ever provisions a repo for — a
 * name that is REGISTERED (`isSurfaceRegistered`), a scoping improvement over
 * Phase 0a's provision-on-first-push-of-any-name. The scope gate
 * (`surface:<name>:write`, operator-granted) still runs first; this is a second,
 * declaration-level gate.
 *
 * Grandfathering: a name whose bare repo already exists on disk (a Phase 0a
 * auto-provisioned repo) counts as registered even without a registry.json
 * entry, so the tightening never orphans an already-provisioned surface.
 *
 * Substrate discipline (§4): this module NEVER reads the vault and NEVER builds
 * or executes a pushed tree. It only records names + creates empty bare repos.
 * The vault read + the sandboxed build live in surface-host.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Logger seam — defaults to `console`. */
export interface GitRegistryLog {
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

/**
 * Surface-name charset — the single source of truth shared with the
 * git-transport URL parser (imported there). Kebab/alnum only, NO slashes or
 * dots, so a parsed name can never escape `gitRoot` via path traversal. Bounded
 * length keeps a hostile name from ballooning a path.
 */
export const SURFACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** One registered surface's metadata (the declaration pointer, not the artifact). */
export interface SurfaceRegistryEntry {
  /** Canonical surface name (== the `/git/<name>` + `/surface/<name>` segment). */
  name: string;
  /** Declared mount path (from the `#surface` note), informational. */
  mount?: string;
  /** Declared mode (from the `#surface` note), informational. */
  mode?: "dev" | "prod";
  /** ISO timestamp the surface was first registered. Preserved across re-registers. */
  registeredAt: string;
  /** ISO timestamp the bare repo was (first) provisioned. */
  provisionedAt: string;
}

/** The persisted registry shape (`<gitRoot>/registry.json`). */
export interface SurfaceRegistry {
  version: 1;
  surfaces: Record<string, SurfaceRegistryEntry>;
}

const EMPTY_REGISTRY: SurfaceRegistry = { version: 1, surfaces: {} };

/** `<gitRoot>/registry.json`. */
export function registryPath(gitRoot: string): string {
  return join(gitRoot, "registry.json");
}

/** `<gitRoot>/<name>.git`. */
export function repoDirFor(gitRoot: string, name: string): string {
  return join(gitRoot, `${name}.git`);
}

/**
 * Read + parse the registry. A missing or corrupt file yields an empty registry
 * (the transport still fails closed on unregistered names — see
 * `isSurfaceRegistered`), never a throw: a torn registry.json must not take the
 * git endpoint down.
 */
export function loadRegistry(gitRoot: string): SurfaceRegistry {
  const file = registryPath(gitRoot);
  if (!existsSync(file)) return { version: 1, surfaces: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { ...EMPTY_REGISTRY };
    const surfaces = (parsed as { surfaces?: unknown }).surfaces;
    if (!surfaces || typeof surfaces !== "object" || Array.isArray(surfaces)) {
      return { ...EMPTY_REGISTRY };
    }
    return { version: 1, surfaces: surfaces as Record<string, SurfaceRegistryEntry> };
  } catch {
    return { ...EMPTY_REGISTRY };
  }
}

/**
 * Persist the registry ATOMICALLY (stage 0600 → rename), so a crash mid-write
 * leaves the prior registry intact and no reader observes a partial file.
 */
export function saveRegistry(gitRoot: string, reg: SurfaceRegistry): void {
  mkdirSync(gitRoot, { recursive: true });
  const file = registryPath(gitRoot);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Is `name` a registered surface? True when it has a registry.json entry OR its
 * bare repo already exists on disk (grandfathering a Phase 0a auto-provisioned
 * repo). This is the declaration gate the git-transport endpoint consults after
 * the scope check passes.
 */
export function isSurfaceRegistered(gitRoot: string, name: string): boolean {
  if (!SURFACE_NAME_RE.test(name)) return false;
  if (loadRegistry(gitRoot).surfaces[name]) return true;
  return existsSync(repoDirFor(gitRoot, name));
}

/** Every registered surface, sorted by name (for `GET /admin/surfaces`). */
export function listSurfaces(gitRoot: string): SurfaceRegistryEntry[] {
  const reg = loadRegistry(gitRoot);
  return Object.values(reg.surfaces).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ensure `<gitRoot>/<name>.git` exists as an exportable bare repo, provisioning
 * it if absent. ASYNC (Phase 1 nit): uses `Bun.spawn` + `await`, never the
 * event-loop-blocking `spawnSync` — a slow disk on `git init` no longer stalls
 * the whole hub. Idempotent: an existing repo is returned untouched.
 *
 * `http.receivepack = true` is REQUIRED for push: `git http-backend` enables
 * upload-pack from `GIT_HTTP_EXPORT_ALL` alone but refuses receive-pack unless
 * the repo opts in explicitly.
 */
export async function ensureSurfaceRepo(
  gitRoot: string,
  name: string,
  log: GitRegistryLog = console,
): Promise<string> {
  if (!SURFACE_NAME_RE.test(name)) {
    throw new Error(`refusing to provision repo for invalid surface name "${name}"`);
  }
  const repoDir = repoDirFor(gitRoot, name);
  if (existsSync(repoDir)) return repoDir;
  mkdirSync(gitRoot, { recursive: true });

  const init = await runGit(["init", "--bare", repoDir]);
  if (init.code !== 0) {
    throw new Error(`git init --bare failed: ${init.stderr || "unknown"}`);
  }
  const cfg = await runGit(["-C", repoDir, "config", "http.receivepack", "true"]);
  if (cfg.code !== 0) {
    throw new Error(`git config http.receivepack failed: ${cfg.stderr || "unknown"}`);
  }
  writePostReceiveHook(repoDir, name);
  log.info(`[git-registry] provisioned bare repo for surface "${name}" at ${repoDir}`);
  return repoDir;
}

/**
 * Register (or re-register) a declared surface: validate the name, ensure its
 * bare repo, and upsert the registry entry (preserving the original
 * `registeredAt` on a re-register). Idempotent — surface-host calls this on
 * every discovery pass.
 */
export async function registerSurface(
  gitRoot: string,
  name: string,
  opts: { mount?: string; mode?: "dev" | "prod"; now?: () => Date; log?: GitRegistryLog } = {},
): Promise<SurfaceRegistryEntry> {
  const now = opts.now ?? (() => new Date());
  if (!SURFACE_NAME_RE.test(name)) {
    throw new Error(`invalid surface name "${name}" (must match ${SURFACE_NAME_RE})`);
  }
  await ensureSurfaceRepo(gitRoot, name, opts.log ?? console);

  const reg = loadRegistry(gitRoot);
  const prior = reg.surfaces[name];
  const nowIso = now().toISOString();
  const entry: SurfaceRegistryEntry = {
    name,
    ...(opts.mount !== undefined ? { mount: opts.mount } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    registeredAt: prior?.registeredAt ?? nowIso,
    provisionedAt: prior?.provisionedAt ?? nowIso,
  };
  reg.surfaces[name] = entry;
  saveRegistry(gitRoot, reg);
  return entry;
}

/**
 * Phase-0a placeholder post-receive hook: logs the received refs (to stdout,
 * relayed to the pusher as `remote:` lines, and appended to `post-receive.log`
 * in the repo dir for verification). The real deploy hand-off is the hub's
 * `onPushed` → HTTP + hub-JWT notify to surface-host (git-notify.ts) — this hook
 * NEVER builds the pushed tree (that exec authority belongs to the module's
 * sandbox, not the substrate — §5/§7).
 */
function writePostReceiveHook(repoDir: string, name: string): void {
  const hook = `#!/bin/sh
# Parachute Surface Git Transport — post-receive placeholder.
# Logs received refs only. The deploy hand-off is the hub's onPushed → HTTP +
# hub-JWT notify to surface-host; the pushed tree is NEVER built in this process
# (that exec authority belongs to the module's sandbox, not the substrate).
while read -r oldrev newrev refname; do
  printf '[parachute] surface %s received %s (%s..%s)\\n' "${name}" "$refname" "$oldrev" "$newrev"
  printf '%s %s %s\\n' "$oldrev" "$newrev" "$refname" >> post-receive.log
done
`;
  const hookPath = join(repoDir, "hooks", "post-receive");
  writeFileSync(hookPath, hook, { mode: 0o755 });
}

async function runGit(args: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  return { code, stderr: stderr.trim() };
}
