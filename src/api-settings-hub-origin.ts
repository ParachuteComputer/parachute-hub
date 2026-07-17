/**
 * `GET|PUT /api/settings/hub-origin` — operator-settable canonical hub
 * URL (hub#298).
 *
 * The stored value is the OAuth issuer claim hub stamps into every JWT.
 * Precedence chain (per `resolveIssuer` in hub-server.ts):
 *
 *   1. hub_settings.hub_origin (this endpoint writes here)
 *   2. PARACHUTE_HUB_ORIGIN env / --issuer flag
 *   3. request origin (local-dev fallback)
 *
 * The endpoint surfaces both the stored value *and* the resolved value
 * + source so the SPA can render "current: https://… (from env)" while
 * the input shows the empty stored row. That separation matters: an
 * operator looking at the SPA needs to tell "this hub already has a
 * canonical URL configured via env" apart from "no canonical URL —
 * tokens carry the request origin."
 *
 * Bearer-gated on `parachute:host:admin` (same scope as
 * `/api/modules/channel`): flipping the issuer claim invalidates any
 * tokens already in circulation against the prior issuer, so it's a
 * destructive-ish operator-only action.
 *
 * URL validation on PUT:
 *   - Must parse via `new URL()`.
 *   - Scheme must be `http:` or `https:` (no `file:`, no protocol-
 *     relative). Bare hostnames don't parse without a scheme and are
 *     rejected upstream by URL.
 *   - Must have a hostname (rejects `https:///path`).
 *   - No trailing slash (the stored value is concatenated into JWT iss
 *     claims + well-known URLs — a trailing slash would produce
 *     `https://host//.well-known/…`).
 *   - No path / query / fragment (only origin shape allowed).
 *
 * The shape mirrors `handleApiModulesChannel` for consistency — same
 * Bearer parsing, same scope-check posture, same error vocabulary.
 */

import type { Database } from "bun:sqlite";
import type { IssuerSource } from "./hub-server.ts";
import { getHubOrigin, setHubOrigin } from "./hub-settings.ts";
import { validateAccessToken } from "./jwt-sign.ts";

/** Scope required on the bearer token to call either endpoint. */
export const API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE = "parachute:host:admin";

export interface ApiSettingsHubOriginDeps {
  db: Database;
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
   * The currently-resolved issuer + its source layer. Computed by the
   * dispatcher (which has the request + `configuredIssuer` already in
   * hand) and threaded through so this handler doesn't have to re-do
   * the precedence walk. Returned on GET.
   */
  resolvedIssuer: string;
  resolvedSource: IssuerSource;
}

interface GetResponseBody {
  /** Stored value from hub_settings.hub_origin, or null. */
  hub_origin: string | null;
  /** Resolved issuer applied to this request (precedence-aware). */
  resolved_issuer: string;
  /** Which precedence layer the resolved value came from. */
  source: IssuerSource;
}

interface PutResponseBody {
  /** Echo of the now-stored value (null if cleared). */
  hub_origin: string | null;
}

/**
 * Validation outcome. The "normalized" branch is what gets passed to
 * setHubOrigin — string or null. Errors carry the field name + a short
 * description that flows into the 400 error_description for an
 * operator-friendly message.
 */
type ValidateOutcome = { ok: true; normalized: string | null } | { ok: false; description: string };

/**
 * Validate the body's `hub_origin` field. Accepts:
 *   - `null` → clear the stored value, revert to env/request precedence.
 *   - A `http:` or `https:` URL string with a hostname, no trailing slash,
 *     no path/query/fragment.
 * Everything else → 400.
 */
export function validateHubOrigin(value: unknown): ValidateOutcome {
  if (value === null) return { ok: true, normalized: null };
  if (typeof value !== "string") {
    return {
      ok: false,
      description: `hub_origin must be a string or null (got ${typeof value})`,
    };
  }
  if (value.length === 0) {
    // Empty string is a footgun shape — store as null instead. We don't
    // want a row that resolveIssuer would skip as falsy while
    // resolveIssuerSource claims "from settings."
    return { ok: true, normalized: null };
  }
  if (value.endsWith("/")) {
    return {
      ok: false,
      description: "hub_origin must not have a trailing slash",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      ok: false,
      description: "hub_origin must be a valid URL",
    };
  }
  // Reject embedded credentials explicitly. The normalization step below
  // re-stringifies as `protocol + "//" + host`, which would silently strip
  // any user:pass component — an operator who typos credentials in
  // wouldn't notice the strip. Surface it as a hard error instead.
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      description: "hub_origin must not include credentials",
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      description: `hub_origin scheme must be http: or https: (got ${parsed.protocol})`,
    };
  }
  if (!parsed.hostname) {
    return {
      ok: false,
      description: "hub_origin must have a hostname",
    };
  }
  // Disallow path/query/fragment — the stored value is concatenated
  // into iss claims and well-known URLs. `new URL("https://host")`
  // returns `pathname === "/"` so accept that as the canonical empty.
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    return {
      ok: false,
      description: "hub_origin must not include a path",
    };
  }
  if (parsed.search) {
    return {
      ok: false,
      description: "hub_origin must not include a query string",
    };
  }
  if (parsed.hash) {
    return {
      ok: false,
      description: "hub_origin must not include a fragment",
    };
  }
  // Normalize: URL stringifies host-only inputs with a trailing slash
  // (`new URL("https://host").toString() === "https://host/"`). The
  // stored shape is the bare origin — strip it back out.
  const normalized = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, normalized };
}

export async function handleApiSettingsHubOrigin(
  req: Request,
  deps: ApiSettingsHubOriginDeps,
): Promise<Response> {
  if (req.method !== "GET" && req.method !== "PUT") {
    return jsonError(405, "method_not_allowed", "use GET or PUT");
  }

  // Bearer presence + parsing — identical shape to api-modules
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
    if (!scopes.includes(API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE)) {
      return jsonError(
        403,
        "insufficient_scope",
        `bearer token lacks ${API_SETTINGS_HUB_ORIGIN_REQUIRED_SCOPE}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }

  if (req.method === "GET") {
    const body: GetResponseBody = {
      hub_origin: getHubOrigin(deps.db),
      resolved_issuer: deps.resolvedIssuer,
      source: deps.resolvedSource,
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
  if (!("hub_origin" in parsed)) {
    return jsonError(400, "invalid_request", "request body must include a `hub_origin` field");
  }
  const result = validateHubOrigin((parsed as { hub_origin: unknown }).hub_origin);
  if (!result.ok) {
    return jsonError(400, "invalid_hub_origin", result.description);
  }

  setHubOrigin(deps.db, result.normalized);

  const body: PutResponseBody = { hub_origin: result.normalized };
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
