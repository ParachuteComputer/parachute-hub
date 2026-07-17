/**
 * `GET|PUT /api/settings/root-redirect` — operator-settable target for the
 * bare-`/` 302.
 *
 * The hub's root (`/`) redirects to `/admin` by default. This endpoint lets an
 * operator point it at a surface instead (e.g. a custom-domain hub fronting a
 * team reading-room surface) without redeploying. The stored value resolves
 * tier-1 in `resolveRootRedirect` (hub-settings.ts):
 *
 *   1. hub_settings.root_redirect (this endpoint writes here)
 *   2. PARACHUTE_HUB_ROOT_REDIRECT env
 *   3. `/admin` default (unchanged behavior)
 *
 * The endpoint surfaces both the stored value *and* the resolved value + source
 * so the SPA can render "current: /surface/x (from env)" while the input shows
 * the empty stored row — same separation rationale as `/api/settings/hub-origin`.
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
  type RootRedirectSource,
  getRootRedirect,
  isSafeRedirectPath,
  resolveRootRedirectDetailed,
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
}

interface PutResponseBody {
  /** Echo of the now-stored value (null if cleared). */
  root_redirect: string | null;
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
    const body: GetResponseBody = {
      root_redirect: getRootRedirect(deps.db),
      resolved: resolved.value,
      source: resolved.source,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  // PUT — parse + validate body.
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return jsonError(400, "invalid_request", "request body must be JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return jsonError(400, "invalid_request", "request body must be a JSON object");
  }
  if (!("root_redirect" in parsed)) {
    return jsonError(400, "invalid_request", "request body must include a `root_redirect` field");
  }
  const result = validateRootRedirect((parsed as { root_redirect: unknown }).root_redirect);
  if (!result.ok) {
    return jsonError(400, "invalid_root_redirect", result.description);
  }

  setRootRedirect(deps.db, result.normalized);

  const body: PutResponseBody = { root_redirect: result.normalized };
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
