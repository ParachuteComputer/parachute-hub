/**
 * `GET /admin/host-admin-token` — exchange a valid admin session cookie for a
 * short-lived JWT carrying both `parachute:host:admin` and
 * `parachute:host:auth` (the same superset an `--scope-set admin` operator
 * token holds).
 *
 * Why this exists: the hub's admin SPA (served under `/hub/`) needs a Bearer
 * to call:
 *   - `parachute:host:admin` surfaces — `POST /vaults` (vault provisioning),
 *     `/api/grants` (OAuth consent grant management).
 *   - `parachute:host:auth` surfaces — `GET /api/auth/tokens`,
 *     `POST /api/auth/mint-token`, `POST /api/auth/revoke-token` (the token
 *     registry endpoints from hub#212 Phase 2).
 *
 * Both scopes are in `NON_REQUESTABLE_SCOPES` — the public `/oauth/authorize`
 * endpoint refuses to mint either, so third-party apps can't acquire these
 * capabilities via consent. This local mint path is the SPA's only way in.
 *
 * The local mint path now has two surfaces:
 *   1. `parachute auth ...` — operator-token file (90d, on-disk, mode 0600).
 *   2. THIS endpoint — short-lived JWT (10 min) handed to the SPA in memory.
 *
 * Both paths require already-proved local-operator identity:
 *   - operator-token mint runs as the operator's unix user.
 *   - this endpoint requires a valid `parachute_hub_session` cookie, which
 *     was set by `/login` after a password check.
 *
 * Tokens minted here are deliberately NOT persisted in the `tokens` table
 * (no refresh, no revocation tracking). They expire on their own; the SPA
 * re-fetches when the JWT is about to lapse.
 *
 * Background on the dual-scope shape: prior to hub#212 Phase 2 this endpoint
 * minted `parachute:host:admin` only. The Phase 2 admin endpoints
 * (`/api/auth/*`) gate on `parachute:host:auth`, which the SPA's bearer
 * lacked — `/hub/tokens` failed with `bearer token lacks parachute:host:auth`
 * on first end-to-end load. Adding `:host:auth` here brings the SPA bearer
 * in line with the admin scope-set semantics from hub#214 / #222.
 */
import type { Database } from "bun:sqlite";
import { signAccessToken } from "./jwt-sign.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";

/** Short TTL — page-snapshot threats can't carry the token forever. */
export const HOST_ADMIN_TOKEN_TTL_SECONDS = 10 * 60;
const HOST_ADMIN_AUDIENCE = "hub";
const HOST_ADMIN_CLIENT_ID = "parachute-hub-spa";
export const HOST_ADMIN_SCOPES = ["parachute:host:admin", "parachute:host:auth"] as const;

export interface MintHostAdminTokenDeps {
  db: Database;
  /** Hub origin — written into JWT `iss`. */
  issuer: string;
}

export async function handleHostAdminToken(
  req: Request,
  deps: MintHostAdminTokenDeps,
): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  if (!session) {
    return jsonError(401, "unauthenticated", "no admin session — sign in at /login first");
  }
  const minted = await signAccessToken(deps.db, {
    sub: session.userId,
    scopes: [...HOST_ADMIN_SCOPES],
    audience: HOST_ADMIN_AUDIENCE,
    clientId: HOST_ADMIN_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: HOST_ADMIN_TOKEN_TTL_SECONDS,
  });
  return new Response(
    JSON.stringify({
      token: minted.token,
      expires_at: minted.expiresAt,
      scopes: HOST_ADMIN_SCOPES,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        // No browser cache — token rotates per-fetch, and a stale 200 from a
        // back/forward navigation could hand the SPA a long-expired JWT.
        "cache-control": "no-store",
      },
    },
  );
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
