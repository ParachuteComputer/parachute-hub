/**
 * Bearer-token auth for hub-native admin endpoints (POST /vaults, future
 * `/admin/*` routes). The hub validates its own JWTs against local signing
 * keys — no JWKS round-trip — and asserts the presented token carries the
 * required scope.
 *
 * Why this exists: until now the hub has been a *pure issuer* with no
 * authenticated endpoints of its own. Phase 1 of the vault-config-and-scopes
 * design adds POST /vaults, which mints+config-writes through privileged
 * code paths. That call needs an admin scope, and its first reader is
 * `parachute:host:admin` (the cross-vault provisioning capability).
 *
 * Errors are HTTP-shaped: `AdminAuthError(status, message)` so the route
 * handler can `throw` and the boundary translates straight to a Response.
 */
import type { Database } from "bun:sqlite";
import { validateAccessToken } from "./jwt-sign.ts";

export interface AdminAuthContext {
  /** JWT `sub` — the hub user id. */
  sub: string;
  /** Parsed `scope` claim. */
  scopes: string[];
  /** `client_id` claim, if present (operator token vs OAuth client). */
  clientId: string | undefined;
  /** `aud` claim, if present. Surfaced for logs / future cross-aud rules. */
  audience: string | undefined;
}

export class AdminAuthError extends Error {
  override name = "AdminAuthError";
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Pull a Bearer token from `Authorization: Bearer <token>`. Throws
 * `AdminAuthError(401)` when missing / malformed. Match is case-insensitive
 * on the scheme (some clients send "bearer" lowercase) but the token itself
 * is the raw JWT string.
 */
export function extractBearerToken(req: Request): string {
  const header = req.headers.get("authorization");
  if (!header) {
    throw new AdminAuthError(401, "missing Authorization header");
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    throw new AdminAuthError(401, "Authorization header must be 'Bearer <token>'");
  }
  return match[1].trim();
}

/**
 * Validate a presented bearer token against the hub's local signing keys
 * and check it carries `requiredScope`. Returns surfaced claims on success;
 * throws `AdminAuthError` (401 or 403) otherwise.
 *
 * `expectedIssuer` is the hub's own origin(s) — the same value(s) baked into
 * tokens we sign. Pass a single string for a single-origin hub, or the SET of
 * origins the hub legitimately answers on (`buildHubBoundOrigins`: loopback ∪
 * expose-state ∪ platform ∪ per-request issuer) so a credential minted under
 * a still-valid prior origin keeps validating across an origin switch — the
 * same multi-origin posture the OAuth path and `validateHostAdminToken`
 * already use. Defense in depth: even though we can only verify our own keys,
 * the `iss`-∈-set reject keeps cross-issuer confusion impossible. SECURITY:
 * the set is ONLY an additive `iss` membership relaxation — `validateAccessToken`
 * verifies the signature against the hub's own key FIRST, so only tokens this
 * hub minted ever reach the `iss` check; never pass a raw request Host, only a
 * `buildHubBoundOrigins`-derived set.
 */
export async function requireScope(
  db: Database,
  req: Request,
  requiredScope: string,
  expectedIssuer: string | readonly string[],
): Promise<AdminAuthContext> {
  const token = extractBearerToken(req);

  let validated: Awaited<ReturnType<typeof validateAccessToken>>;
  try {
    validated = await validateAccessToken(db, token, expectedIssuer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminAuthError(401, `invalid token: ${msg}`);
  }

  const sub = typeof validated.payload.sub === "string" ? validated.payload.sub : null;
  if (!sub) throw new AdminAuthError(401, "token missing required `sub` claim");

  const scopeClaim = (validated.payload as { scope?: unknown }).scope;
  const scopes =
    typeof scopeClaim === "string" ? scopeClaim.split(/\s+/).filter((s) => s.length > 0) : [];

  if (!scopes.includes(requiredScope)) {
    throw new AdminAuthError(403, `token missing required scope: ${requiredScope}`);
  }

  const clientIdRaw = (validated.payload as { client_id?: unknown }).client_id;
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw : undefined;
  const aud = typeof validated.payload.aud === "string" ? validated.payload.aud : undefined;

  return { sub, scopes, clientId, audience: aud };
}

/**
 * Translate an AdminAuthError to an RFC-6750-style JSON Response.
 * Convenience for route handlers that want to do
 * `try { ctx = await requireScope(...) } catch (err) { return adminAuthErrorResponse(err); }`.
 */
export function adminAuthErrorResponse(err: unknown): Response {
  if (err instanceof AdminAuthError) {
    return new Response(
      JSON.stringify({
        error: err.status === 403 ? "insufficient_scope" : "invalid_token",
        error_description: err.message,
      }),
      {
        status: err.status,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer error="${err.status === 403 ? "insufficient_scope" : "invalid_token"}", error_description="${err.message.replace(/"/g, "'")}"`,
        },
      },
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return new Response(JSON.stringify({ error: "server_error", error_description: msg }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}
