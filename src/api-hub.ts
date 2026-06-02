import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adminAuthErrorResponse, requireScope } from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { CONTAINER_HOME } from "./hub-control.ts";
import { detectHubInstallSource } from "./install-source.ts";

/**
 * `GET /api/hub` — hub runtime info for the admin SPA's version badge.
 *
 * Operators (especially Render deployers tracking auto-deploys from `main`)
 * need to tell at a glance: what version is this hub running, when did it
 * last restart, is this the version I expect? The CLI surface `parachute
 * status` already shows the same data; this endpoint mirrors it for the
 * browser SPA.
 *
 * Bearer-gated on `parachute:host:admin` (same as `/vaults` and `/api/grants`).
 * Operators-only: the version + uptime + install-source fingerprint isn't
 * sensitive per se, but it's adjacent to operator-only diagnostics so it
 * lives behind the same gate as the rest of the admin surface.
 *
 * Response shape (snake_case to match other `/api/*` endpoints):
 *
 *   {
 *     "version":              "0.5.13-rc.23",
 *     "started_at":           "2026-05-23T14:23:45.000Z",
 *     "uptime_ms":            8025000,
 *     "source":               "bun-linked" | "npm" | "container" | "unknown",
 *     "bun_linked_path":      "/Users/.../parachute-hub"        // optional
 *     "git_head":             "a53af21"                          // optional
 *     "container_build_time": "2026-05-23T14:21:00Z"             // optional
 *   }
 *
 * - `source` reuses `detectHubInstallSource` from install-source.ts (the
 *   same logic `parachute status` uses for the SOURCE column). The fourth
 *   value `"container"` is hub-specific: when `process.env.PARACHUTE_HOME
 *   === "/parachute"` (the Render Blueprint pin) we override `bun-linked`
 *   → `container` so the badge tells operators "you're on Render", not
 *   the misleading "bun-linked from /app".
 * - `started_at` is captured once at module load (see `HUB_PROCESS_STARTED_AT`).
 *   `uptime_ms` is computed server-side at request time so the client
 *   doesn't have to deal with clock skew.
 * - `container_build_time` reads `process.env.PARACHUTE_BUILD_TIME` —
 *   passed through by the Dockerfile when set as a build arg (operators
 *   can set this themselves in render.yaml or via `--build-arg` to surface
 *   the image build time). Not surfaced when unset.
 */

export interface ApiHubDeps {
  db: Database;
  /** Hub origin — used to validate the bearer's `iss`. */
  issuer: string;
  /**
   * Override the directory used to locate the hub's package.json and to
   * classify install source. Defaults to `dirname(import.meta.url)` —
   * which is `<repo>/src/` for normal layouts. Test seam.
   */
  hubSrcDir?: string;
  /** Override `process.env` lookups. Test seam. */
  env?: Record<string, string | undefined>;
  /** Override the started-at timestamp. Test seam — defaults to the module-level capture. */
  startedAt?: Date;
  /** Override "now" for uptime computation. Test seam. */
  now?: () => Date;
}

/**
 * The hub process's start time. Captured exactly once at module load and
 * re-exported so the request handler returns a stable value across calls
 * (and so the `parachute status` CLI surface in the same process can pull
 * it from one source).
 */
export const HUB_PROCESS_STARTED_AT: Date = new Date();

/** Wire shape returned by `GET /api/hub`. Snake-case to match other `/api/*` endpoints. */
export interface HubStatusResponse {
  version: string;
  started_at: string;
  uptime_ms: number;
  source: "bun-linked" | "npm" | "container" | "unknown";
  bun_linked_path?: string;
  git_head?: string;
  container_build_time?: string;
  /** Render-set runtime env vars surfaced when running on Render. Sourced from RENDER_GIT_COMMIT + RENDER_GIT_BRANCH. */
  render_commit?: string;
  render_branch?: string;
}

export async function handleApiHub(req: Request, deps: ApiHubDeps): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }

  // Bearer-gate on `parachute:host:admin`. Same shape as the other admin
  // endpoints — SPA mints via /admin/host-admin-token.
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err);
  }

  const env = deps.env ?? process.env;
  const startedAt = deps.startedAt ?? HUB_PROCESS_STARTED_AT;
  const now = (deps.now ?? (() => new Date()))();
  const hubSrcDir = deps.hubSrcDir ?? dirname(fileURLToPath(import.meta.url));

  // detectHubInstallSource climbs from src/ to the nearest package.json,
  // reads its version, classifies as bun-linked vs npm vs unknown.
  const source = detectHubInstallSource(hubSrcDir);

  // Read version from the nearest package.json (same logic the install-source
  // detector ran). We don't reuse `source.livePackageVersion` because the
  // unknown-source branch leaves it undefined — but the version field on the
  // response must always be present.
  const version = readHubVersion(hubSrcDir) ?? "unknown";

  // Container override: the Render Blueprint pins PARACHUTE_HOME=/parachute,
  // which is a reliable container-mode signal. The install-source detector
  // would label this `bun-linked` (the image runs from /app/src, not bun
  // globals), which is technically true but misleading for the operator —
  // "container" is what they actually want to see.
  const isContainer = env.PARACHUTE_HOME === CONTAINER_HOME;

  const body: HubStatusResponse = {
    version,
    started_at: startedAt.toISOString(),
    uptime_ms: Math.max(0, now.getTime() - startedAt.getTime()),
    source: isContainer ? "container" : source.kind,
  };

  if (!isContainer && source.kind === "bun-linked" && source.path) {
    body.bun_linked_path = source.path;
  }
  // `git_head` is meaningful only for bun-linked dev installs — the container
  // image strips `.git` at build time so source.gitHead is always undefined
  // there. Explicit !isContainer guard for symmetry with bun_linked_path.
  if (!isContainer && source.gitHead) {
    body.git_head = source.gitHead;
  }
  const buildTime = env.PARACHUTE_BUILD_TIME;
  if (typeof buildTime === "string" && buildTime.length > 0) {
    body.container_build_time = buildTime;
  }
  // Render exposes RENDER_GIT_COMMIT + RENDER_GIT_BRANCH at runtime when
  // the container is running on Render. Surface for operator diagnostics
  // (the commit SHA is a more rigorous identity than build-time wall-clock).
  // Container-mode only — local dev never has these set.
  if (isContainer) {
    const renderCommit = env.RENDER_GIT_COMMIT;
    if (typeof renderCommit === "string" && renderCommit.length > 0) {
      body.render_commit = renderCommit;
    }
    const renderBranch = env.RENDER_GIT_BRANCH;
    if (typeof renderBranch === "string" && renderBranch.length > 0) {
      body.render_branch = renderBranch;
    }
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/**
 * Read the hub's package.json `version` field. Climbs from `srcDir` to the
 * nearest package.json (same pattern as `findNearestPackageDir` in
 * install-source.ts). Returns undefined if the file's missing or malformed.
 */
function readHubVersion(srcDir: string): string | undefined {
  let current = resolve(srcDir);
  for (let i = 0; i < 16; i++) {
    try {
      const parsed = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as unknown;
      if (parsed && typeof parsed === "object") {
        const v = (parsed as Record<string, unknown>).version;
        if (typeof v === "string" && v.length > 0) return v;
      }
    } catch {
      // No package.json here — climb.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
