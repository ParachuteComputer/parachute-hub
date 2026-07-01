/**
 * `/admin/surfaces` — the surface → bare-repo registry endpoint (Surface Git
 * Transport Phase 1, design doc 2026-06-30-surface-git-transport.md §9/§10).
 *
 * This is the seam by which "vault declares" reaches the hub substrate. The
 * vault holds the `#surface` note; surface-host discovers it (it custodies a
 * vault read cred) and POSTs here to REGISTER the surface — which provisions its
 * bare repo and records the name→repo mapping (git-registry.ts). The
 * git-transport endpoint then serves/provisions ONLY registered names (§10 step
 * 1). The hub never reads the vault itself — surface-host is the reader; this
 * endpoint just records what it's told, gated on operator authority.
 *
 *   - `POST /admin/surfaces`  {name, mount?, mode?}  → register (idempotent)
 *   - `GET  /admin/surfaces`                          → list registered surfaces
 *
 * Auth: a Bearer carrying `parachute:host:admin` — the operator token
 * surface-host already reads for its DCR + redirect-self-heal calls. Same
 * validation shape as `api-modules-ops.ts` (`validateHostAdminToken` against the
 * multi-origin known-issuer set, then a scope check): the scope is
 * operator-only/non-requestable, so the iss relaxation can't reach an OAuth
 * token.
 */
import type { Database } from "bun:sqlite";
import { type SurfaceRegistryEntry, listSurfaces, registerSurface } from "./git-registry.ts";
import { validateHostAdminToken } from "./host-admin-token-validation.ts";

/** Scope required to register/list surfaces — the operator token carries it. */
export const ADMIN_SURFACES_REQUIRED_SCOPE = "parachute:host:admin";

export interface AdminSurfacesLog {
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

export interface AdminSurfacesDeps {
  db: Database;
  /** Bare-repo root (`<CONFIG_DIR>/hub/git`). */
  gitRoot: string;
  /** Per-request hub issuer (`oauthDeps(req).issuer`). */
  issuer: string;
  /**
   * The SET of origins the hub answers on (`oauthDeps(req).hubBoundOrigins()`),
   * so an operator token minted under a prior origin keeps validating across an
   * origin switch (hub#516 pattern).
   */
  knownIssuers?: readonly string[];
  log?: AdminSurfacesLog;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

/** Validate the operator bearer + require the surfaces scope. Mirrors api-modules-ops. */
async function authorize(req: Request, deps: AdminSurfacesDeps): Promise<Response | undefined> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) return jsonError(401, "unauthenticated", "empty bearer token");
  try {
    const validated = await validateHostAdminToken(
      deps.db,
      bearer,
      deps.knownIssuers ?? [deps.issuer],
    );
    if (typeof validated.payload.sub !== "string" || validated.payload.sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    const scopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
    if (!scopes.includes(ADMIN_SURFACES_REQUIRED_SCOPE)) {
      return jsonError(
        403,
        "insufficient_scope",
        `bearer token lacks ${ADMIN_SURFACES_REQUIRED_SCOPE}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }
  return undefined;
}

interface RegisterBody {
  name?: unknown;
  mount?: unknown;
  mode?: unknown;
}

/**
 * Route `/admin/surfaces`. Returns null when the path isn't ours (the caller
 * falls through). GET lists; POST registers; other methods 405.
 */
export async function routeAdminSurfaces(
  req: Request,
  deps: AdminSurfacesDeps,
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (pathname !== "/admin/surfaces") return null;
  const log = deps.log ?? console;

  if (req.method === "GET") {
    const authFail = await authorize(req, deps);
    if (authFail) return authFail;
    return json(200, { surfaces: listSurfaces(deps.gitRoot) });
  }

  if (req.method === "POST") {
    const authFail = await authorize(req, deps);
    if (authFail) return authFail;

    let body: RegisterBody;
    try {
      body = (await req.json()) as RegisterBody;
    } catch {
      return jsonError(400, "invalid_body", "request body must be JSON");
    }
    if (typeof body.name !== "string" || body.name.length === 0) {
      return jsonError(400, "invalid_name", "`name` is required (non-empty string)");
    }
    if (body.mount !== undefined && typeof body.mount !== "string") {
      return jsonError(400, "invalid_mount", "`mount`, when present, must be a string");
    }
    if (body.mode !== undefined && body.mode !== "dev" && body.mode !== "prod") {
      return jsonError(400, "invalid_mode", '`mode`, when present, must be "dev" or "prod"');
    }
    let entry: SurfaceRegistryEntry;
    try {
      entry = await registerSurface(deps.gitRoot, body.name, {
        ...(typeof body.mount === "string" ? { mount: body.mount } : {}),
        ...(body.mode === "dev" || body.mode === "prod" ? { mode: body.mode } : {}),
        log,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A bad name is the caller's fault (400); a provisioning failure is ours (500).
      if (/invalid surface name/.test(msg)) return jsonError(400, "invalid_name", msg);
      log.warn(`[admin-surfaces] register failed for "${String(body.name)}": ${msg}`);
      return jsonError(500, "register_failed", "could not provision the surface repo");
    }
    log.info(`[admin-surfaces] registered surface "${entry.name}"`);
    return json(200, { ok: true, surface: entry });
  }

  return jsonError(405, "method_not_allowed", "use GET or POST on /admin/surfaces");
}
