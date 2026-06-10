/**
 * Per-UI audience gate (H3, surface-runtime design §12 — fixes
 * parachute-surface#88: the `public` flag existed but nothing enforced it).
 *
 * A module's services.json row may carry a `uis{}` map of hosted UI
 * sub-units; each sub-unit now declares an `audience`
 * (`public | hub-users | operator`, default `hub-users`). The HUB PROXY
 * enforces it BEFORE forwarding — surface-host serves whatever the proxy
 * lets through, exactly like the publicExposure cloak.
 *
 * Scope discipline: the gate covers the SURFACE UI MOUNTS specifically (the
 * uis sub-unit paths), not every module path — a module's own APIs keep
 * their own auth (vault validates Bearers, scribe validates its token, …).
 * The gate also runs before WebSocket upgrades on a gated mount (threaded
 * into `maybeUpgradeWebSocket`).
 *
 * The three audiences:
 *
 *   public    — pass (and the chrome strip is disabled — H5: public readers
 *               aren't hub users).
 *   hub-users — a valid hub session cookie OR a valid hub-issued Bearer
 *               whose scopes satisfy the sub-unit's `scopes_required`. The
 *               OR keeps installed PWAs working: a standalone PWA holds
 *               OAuth tokens, not a hub session. Bearer validation reuses
 *               the hub#516 seam (signature/expiry/revocation via the JWKS,
 *               `iss` ∈ the hub's bound-origin set — a PWA token carries the
 *               public origin while the proxied request may resolve the
 *               loopback issuer).
 *   operator  — the first-admin session only. A Bearer never satisfies this
 *               tier (operator surfaces are interactive; the session is the
 *               operator's presence).
 *
 * Deny shape: document requests (GET + Accept: text/html, no session) get a
 * 302 to `/login?next=<path>`; everything else gets 401/403 JSON. A
 * signed-in-but-insufficient caller (non-admin on an operator surface, or a
 * Bearer missing the required scopes) gets 403, not a login redirect.
 *
 * Fail-closed posture: malformed `audience` metadata never reaches this
 * module — `services-manifest.ts` validation rejects the row and the lenient
 * read drops it (the mount 404s). An absent DB (hub booted stateless) denies
 * every non-public audience.
 */

import type { Database } from "bun:sqlite";
import { validateHostAdminToken } from "./host-admin-token-validation.ts";
import type { ServiceEntry, UiAudience, UiSubUnit } from "./services-manifest.ts";
import { findActiveSession } from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";

/** A pathname resolved to the UI sub-unit that hosts it. */
export interface UiMountMatch {
  readonly entry: ServiceEntry;
  readonly uiKey: string;
  readonly ui: UiSubUnit;
  /** The normalized mount path (no trailing slash) the match keyed on. */
  readonly mount: string;
  /** The effective audience (default applied). */
  readonly audience: UiAudience;
}

/** The effective audience for a sub-unit — absent means `hub-users`. */
export function effectiveUiAudience(ui: UiSubUnit): UiAudience {
  return ui.audience ?? "hub-users";
}

/**
 * Resolve which UI sub-unit (across every service's `uis{}` map) a pathname
 * falls under. Longest-prefix match, same comparison shape as
 * `findServiceUpstream` (trailing slashes normalized; `pathname === mount`
 * or `pathname.startsWith(mount + "/")`). Returns undefined when the path is
 * not under any declared UI — module API paths, undeclared mounts, and
 * legacy flat rows are NOT gated here.
 */
export function resolveUiMount(
  services: readonly ServiceEntry[],
  pathname: string,
): UiMountMatch | undefined {
  let best: UiMountMatch | undefined;
  for (const entry of services) {
    if (!entry.uis) continue;
    for (const [uiKey, ui] of Object.entries(entry.uis)) {
      const norm = ui.path.replace(/\/+$/, "") || "/";
      if (pathname === norm || pathname.startsWith(`${norm}/`)) {
        if (!best || norm.length > best.mount.length) {
          best = { entry, uiKey, ui, mount: norm, audience: effectiveUiAudience(ui) };
        }
      }
    }
  }
  return best;
}

/**
 * Does one bearer scope satisfy one required-scope pattern?
 *
 * Patterns are colon-segmented with `*` as a single-segment wildcard —
 * `vault:*:read` matches `vault:default:read`. One asymmetry is deliberate:
 * the broad UNNAMED form (`vault:read`) satisfies `vault:*:<verb>` — a token
 * carrying any-vault read authority is strictly wider than one pinned vault,
 * so refusing it would deny a caller that holds MORE than required.
 */
export function scopeMatchesPattern(pattern: string, scope: string): boolean {
  const p = pattern.split(":");
  const s = scope.split(":");
  if (p.length === s.length) {
    return p.every((seg, i) => seg === "*" || seg === s[i]);
  }
  // Broad unnamed form: vault:<verb> ⊇ vault:*:<verb>.
  if (p.length === 3 && s.length === 2 && p[1] === "*") {
    return p[0] === s[0] && p[2] === s[1];
  }
  return false;
}

/**
 * Do the bearer's scopes satisfy the sub-unit's requirement? EVERY pattern
 * in `scopes_required` must be matched by at least one bearer scope ("a
 * Bearer whose scopes include the surface's scopes"). An empty/absent
 * requirement means any valid hub-issued Bearer passes — the surface
 * declared no scope shape, so hub identity alone is the bar.
 */
export function scopesSatisfyRequirement(
  required: readonly string[] | undefined,
  bearerScopes: readonly string[],
): boolean {
  if (!required || required.length === 0) return true;
  return required.every((pattern) => bearerScopes.some((s) => scopeMatchesPattern(pattern, s)));
}

export interface AudienceGateDeps {
  /** Hub DB — absent (stateless boot) denies every non-public audience. */
  db: Database | undefined;
  /**
   * The hub's bound-origin set for Bearer `iss` validation (the hub#516
   * seam — PWA tokens carry the public origin while the request may resolve
   * loopback). Lazy: only consulted on the Bearer branch.
   */
  knownIssuers: () => readonly string[];
}

function wantsDocument(req: Request): boolean {
  return req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
}

function loginRedirect(req: Request): Response {
  const url = new URL(req.url);
  const next = encodeURIComponent(url.pathname + url.search);
  return new Response(null, {
    status: 302,
    headers: { location: `/login?next=${next}`, "cache-control": "no-store" },
  });
}

function denyJson(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Enforce a sub-unit's audience for a request. Returns `null` when the
 * request may proceed to the proxy, or the deny Response (302 login for
 * anonymous document requests; 401/403 JSON otherwise).
 */
export async function gateUiAudience(
  req: Request,
  audience: UiAudience,
  ui: UiSubUnit,
  deps: AudienceGateDeps,
): Promise<Response | null> {
  if (audience === "public") return null;

  // Fail closed without a DB: no identity store, no way to admit anyone to
  // a non-public surface.
  if (!deps.db) {
    return wantsDocument(req)
      ? loginRedirect(req)
      : denyJson(401, "unauthenticated", "this surface requires a hub identity");
  }
  const db = deps.db;

  const session = findActiveSession(db, req);

  if (audience === "operator") {
    if (session && isFirstAdmin(db, session.userId)) return null;
    if (session) {
      return denyJson(
        403,
        "not_admin",
        "this surface is restricted to the hub operator — your account home is at /account/",
      );
    }
    return wantsDocument(req)
      ? loginRedirect(req)
      : denyJson(401, "unauthenticated", "this surface requires the hub operator's session");
  }

  // audience === "hub-users"
  if (session) return null;

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    try {
      const validated = await validateHostAdminToken(db, token, [...deps.knownIssuers()]);
      const bearerScopes =
        typeof validated.payload.scope === "string"
          ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
          : [];
      if (scopesSatisfyRequirement(ui.scopes_required, bearerScopes)) return null;
      return denyJson(
        403,
        "insufficient_scope",
        `this surface requires scopes: ${(ui.scopes_required ?? []).join(", ")}`,
      );
    } catch (err) {
      return denyJson(
        401,
        "unauthenticated",
        `bearer token invalid — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return wantsDocument(req)
    ? loginRedirect(req)
    : denyJson(
        401,
        "unauthenticated",
        "this surface requires a hub session or a hub-issued bearer token",
      );
}
