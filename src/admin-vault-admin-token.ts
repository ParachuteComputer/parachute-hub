/**
 * `GET /admin/vault-admin-token/<name>` — exchange a valid admin session
 * cookie for a short-lived JWT carrying `vault:<name>:admin`.
 *
 * Why this exists: the per-vault admin SPA (vault#216 / vault PR #219) needs
 * a Bearer to call vault-internal admin endpoints (token mint/revoke,
 * config edits). `vault:<name>:admin` is non-requestable from the public
 * `/oauth/authorize` flow (`scope-explanations.ts:isNonRequestableScope`)
 * — only the local session-cookie path can mint it.
 *
 * The minted JWT is handed to the vault SPA via a URL fragment on redirect
 * (`<vault-url><managementUrl>#token=<jwt>`). Vault's admin SPA bootstraps
 * by reading `location.hash`, stashing the token in module-scoped state,
 * and replaceState-ing the fragment off the URL.
 *
 * Validation: `<name>` must match a vault instance currently in services.json.
 * That keeps a forged URL from minting `vault:does-not-exist:admin` and
 * masking a typo as a real (but unusable) credential. Resolved via the
 * already-built well-known doc — same source of truth the SPA's vault list
 * reads.
 */
import type { Database } from "bun:sqlite";
import { signAccessToken } from "./jwt-sign.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";

/** Short TTL — matches host-admin-token. SPA re-fetches on near-expiry. */
export const VAULT_ADMIN_TOKEN_TTL_SECONDS = 10 * 60;
const VAULT_ADMIN_CLIENT_ID = "parachute-hub-spa";

/** Same shape as the manifest name validator — keeps URL-injection out. */
const VAULT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export interface MintVaultAdminTokenDeps {
  db: Database;
  /** Hub origin — written into JWT `iss`. */
  issuer: string;
  /** Names of currently-installed vault instances; the request name must be in this set. */
  knownVaultNames: ReadonlySet<string>;
}

export async function handleVaultAdminToken(
  req: Request,
  vaultName: string,
  deps: MintVaultAdminTokenDeps,
): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  if (!VAULT_NAME_RE.test(vaultName)) {
    return jsonError(400, "invalid_request", `vault name "${vaultName}" is not a valid identifier`);
  }
  if (!deps.knownVaultNames.has(vaultName)) {
    return jsonError(404, "not_found", `no vault named "${vaultName}" in this hub`);
  }
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  if (!session) {
    return jsonError(401, "unauthenticated", "no admin session — sign in at /login first");
  }
  const scope = `vault:${vaultName}:admin`;
  // Per-vault audience: vault validates the JWT's `aud` claim against
  // `vault.<name>` derived from its own URL-bound config (vault src/auth.ts
  // line ~167 — `expectedAudience: vault.${vaultConfig.name}`). Same shape
  // as `inferAudience` in oauth-handlers.ts for the public OAuth flow, so
  // hub-minted and OAuth-minted tokens are indistinguishable to vault. A
  // single `audience: "hub"` constant here was wrong end-to-end and broke
  // every Manage-button click against the vault SPA (PR #173 follow-up).
  const audience = `vault.${vaultName}`;
  const minted = await signAccessToken(deps.db, {
    sub: session.userId,
    scopes: [scope],
    audience,
    clientId: VAULT_ADMIN_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: VAULT_ADMIN_TOKEN_TTL_SECONDS,
  });
  return new Response(
    JSON.stringify({
      token: minted.token,
      expires_at: minted.expiresAt,
      scopes: [scope],
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
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
