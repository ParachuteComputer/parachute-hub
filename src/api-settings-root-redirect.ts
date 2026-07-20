/**
 * `GET|PUT /api/settings/root-redirect` — operator-settable behavior for the
 * hub's origin root: the `root_mode` (redirect vs. serve the app) and the
 * bare-`/` 302 target.
 *
 * The hub's root (`/`) redirects to `/admin` by default. This endpoint lets an
 * operator point it at a surface instead (e.g. a custom-domain hub fronting a
 * team reading-room surface), OR flip `root_mode` to `serve-app` so the hub
 * serves the installed Parachute app AT the origin root (the hosted-door
 * experience), all without redeploying. The stored values resolve tier-1 in
 * `resolveRootRedirect` / `resolveRootMode` (hub-settings.ts):
 *
 *   root_redirect:  hub_settings.root_redirect → PARACHUTE_HUB_ROOT_REDIRECT env → `/admin`
 *   root_mode:      hub_settings.root_mode     → PARACHUTE_HUB_ROOT_MODE env     → `redirect`
 *
 * The endpoint surfaces both the stored values *and* the resolved values +
 * sources so the SPA can render "current: /surface/x (from env)" while the
 * input shows the empty stored row — same separation rationale as
 * `/api/settings/hub-origin`. PUT accepts `root_redirect` and/or `root_mode`
 * (at least one); a body with only `root_redirect` (the pre-serve-app shape)
 * works unchanged.
 *
 * OPEN-REDIRECT SAFETY is the highest-stakes part: the resolved value lands in a
 * `Location:` header, so an off-origin value would be a textbook open redirect.
 * PUT validation (and the read-time resolver) require a SAME-ORIGIN relative
 * path via `isSafeRedirectPath` — must start with a single `/`, never `//` /
 * `/\` / a scheme, no control chars / whitespace, and must not resolve back to
 * `/` (redirect loop). Anything else is rejected (PUT 400 / resolver fallback to
 * `/admin`).
 *
 * Bearer-gated on `parachute:host:admin`, mirroring `handleApiSettingsHubOrigin`
 * — same Bearer parsing, scope-check posture, and error vocabulary.
 */

import type { Database } from "bun:sqlite";
import {
  ROOT_MODES,
  type RootMode,
  type RootModeSource,
  type RootRedirectSource,
  getRootMode,
  getRootRedirect,
  isRootMode,
  isSafeRedirectPath,
  resolveRootModeDetailed,
  resolveRootRedirectDetailed,
  setRootMode,
  setRootRedirect,
} from "./hub-settings.ts";
import { validateAccessToken } from "./jwt-sign.ts";

/** Scope required on the bearer token to call either endpoint. */
export const API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE = "parachute:host:admin";

export interface ApiSettingsRootRedirectDeps {
  db: Database;
  /** Issuer the bearer token must validate against (the hub's resolved issuer). */
  issuer: string;
  /**
   * SET of origins the hub answers on (loopback ∪ expose-state ∪ platform ∪
   * per-request `issuer`), built via `buildHubBoundOrigins`. The bearer's
   * `iss` is validated against THIS set rather than the single `issuer`, so a
   * credential minted under a still-valid prior origin keeps working across an
   * origin switch (hub#516 parity). Absent → falls back to `[issuer]` (the
   * prior strict per-request behavior; tests/non-HTTP callers unaffected).
   */
  knownIssuers?: readonly string[];
  /**
   * Env seam for the resolver's env layer. Defaults to `process.env`. Threaded
   * so the dispatcher (and tests) can resolve `PARACHUTE_HUB_ROOT_REDIRECT`
   * deterministically.
   */
  env?: NodeJS.ProcessEnv;
}

interface GetResponseBody {
  /** Raw stored value from hub_settings.root_redirect, or null. */
  root_redirect: string | null;
  /** Resolved target applied to the bare-`/` 302 (precedence-aware, guarded). */
  resolved: string;
  /** Which precedence layer the resolved value came from. */
  source: RootRedirectSource;
  /** Raw stored value from hub_settings.root_mode, or null. */
  root_mode: RootMode | null;
  /** Resolved root mode (precedence-aware): "redirect" (302) or "serve-app". */
  resolved_mode: RootMode;
  /** Which precedence layer the resolved mode came from. */
  mode_source: RootModeSource;
}

interface PutResponseBody {
  /** Echo of the now-stored redirect (null if cleared / not part of this PUT). */
  root_redirect: string | null;
  /** Echo of the now-stored mode (null if cleared / default). */
  root_mode: RootMode | null;
}

/**
 * Validation outcome. The "normalized" branch is what gets passed to
 * setRootRedirect — string (a safe path) or null (clear the row).
 */
type ValidateOutcome = { ok: true; normalized: string | null } | { ok: false; description: string };

/**
 * Validate the body's `root_redirect` field. Accepts:
 *   - `null` (or empty string) → clear the stored value, revert to env/default.
 *   - A safe SAME-ORIGIN relative path per `isSafeRedirectPath`.
 * Everything else → 400 with an operator-friendly description.
 */
export function validateRootRedirect(value: unknown): ValidateOutcome {
  if (value === null) return { ok: true, normalized: null };
  if (typeof value !== "string") {
    return {
      ok: false,
      description: `root_redirect must be a string or null (got ${typeof value})`,
    };
  }
  // Empty string is the canonical "clear" shape — store as null (mirrors
  // setHubOrigin's footgun guard; an empty Location would be meaningless).
  if (value.length === 0) return { ok: true, normalized: null };
  if (!isSafeRedirectPath(value)) {
    return {
      ok: false,
      description:
        "root_redirect must be a same-origin relative path (start with a single `/`, no `//`/`/\\`/scheme, no whitespace, and not `/` itself)",
    };
  }
  return { ok: true, normalized: value };
}

/** Validation outcome for `root_mode` — string (a valid mode) or null (clear). */
type ValidateModeOutcome =
  | { ok: true; normalized: RootMode | null }
  | { ok: false; description: string };

/**
 * Validate the body's `root_mode` field. Accepts:
 *   - `null` (or empty string) → clear the stored value, revert to env/default
 *     (the `redirect` default).
 *   - `"redirect"` | `"serve-app"` — a valid {@link RootMode}.
 * Everything else → 400 with an operator-friendly description.
 */
export function validateRootMode(value: unknown): ValidateModeOutcome {
  if (value === null) return { ok: true, normalized: null };
  if (typeof value !== "string") {
    return { ok: false, description: `root_mode must be a string or null (got ${typeof value})` };
  }
  if (value.length === 0) return { ok: true, normalized: null };
  if (!isRootMode(value)) {
    return { ok: false, description: `root_mode must be one of ${ROOT_MODES.join(", ")}` };
  }
  return { ok: true, normalized: value };
}

export async function handleApiSettingsRootRedirect(
  req: Request,
  deps: ApiSettingsRootRedirectDeps,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "PUT") {
    return jsonError(405, "method_not_allowed", "use GET or PUT");
  }

  // Bearer presence + parsing — identical shape to api-settings-hub-origin
  // for consistency across hub-internal admin endpoints.
  const auth = req.headers.get("authorization");
  // Bearer scheme is case-insensitive per RFC 7235; token passed verbatim (V1.4/C1.3 parity).
  if (!auth || !/^Bearer\s+/i.test(auth)) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) {
    return jsonError(401, "unauthenticated", "empty bearer token");
  }

  // Bearer validation + scope check.
  try {
    const validated = await validateAccessToken(
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
    if (!scopes.includes(API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE)) {
      return jsonError(
        403,
        "insufficient_scope",
        `bearer token lacks ${API_SETTINGS_ROOT_REDIRECT_REQUIRED_SCOPE}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }

  if (req.method === "GET") {
    const resolved = resolveRootRedirectDetailed(deps.db, { env: deps.env });
    const resolvedMode = resolveRootModeDetailed(deps.db, { env: deps.env });
    const body: GetResponseBody = {
      root_redirect: getRootRedirect(deps.db),
      resolved: resolved.value,
      source: resolved.source,
      root_mode: getRootMode(deps.db),
      resolved_mode: resolvedMode.value,
      mode_source: resolvedMode.source,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // PUT — parse + validate body. Either `root_redirect` OR `root_mode` (or
  // both) may be present; at least one is required. Each is validated +
  // applied independently, so an operator can flip just the mode, just the
  // redirect target, or both in one call. Back-compat: a body with only
  // `root_redirect` (the pre-serve-app shape the admin SPA / CLI already send)
  // works unchanged.
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return jsonError(400, "invalid_request", "request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return jsonError(400, "invalid_request", "request body must be a JSON object");
  }
  const hasRedirect = "root_redirect" in parsed;
  const hasMode = "root_mode" in parsed;
  if (!hasRedirect && !hasMode) {
    return jsonError(
      400,
      "invalid_request",
      "request body must include a `root_redirect` and/or `root_mode` field",
    );
  }

  // Validate BOTH before applying EITHER — a partial write (redirect stored,
  // mode rejected) would leave the operator's config half-applied.
  let redirectNormalized: string | null | undefined;
  if (hasRedirect) {
    const result = validateRootRedirect((parsed as { root_redirect: unknown }).root_redirect);
    if (!result.ok) return jsonError(400, "invalid_root_redirect", result.description);
    redirectNormalized = result.normalized;
  }
  let modeNormalized: RootMode | null | undefined;
  if (hasMode) {
    const result = validateRootMode((parsed as { root_mode: unknown }).root_mode);
    if (!result.ok) return jsonError(400, "invalid_root_mode", result.description);
    modeNormalized = result.normalized;
  }

  if (redirectNormalized !== undefined) setRootRedirect(deps.db, redirectNormalized);
  if (modeNormalized !== undefined) setRootMode(deps.db, modeNormalized);

  // Echo the now-current stored values (re-read so an untouched field reflects
  // what's actually in the row, not `undefined`).
  const body: PutResponseBody = {
    root_redirect: getRootRedirect(deps.db),
    root_mode: getRootMode(deps.db),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, code: string, description: string): Response {
  return new Response(JSON.stringify({ error: code, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
