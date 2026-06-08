/**
 * `GET /admin/channel-token` — exchange a valid admin session cookie for a
 * short-lived JWT carrying `channel:read channel:send`.
 *
 * Why this exists: the Channel chat UI (served behind hub's proxy to a
 * logged-in portal operator) needs a Bearer to talk to channel's API the
 * same way the vault-management and scribe-config SPAs do — receive replies
 * over SSE (`channel:read`) and post a message (`channel:send`). This local
 * session-cookie mint path is the UI's way to acquire that Bearer without
 * running the public `/oauth/authorize` flow.
 *
 * Scope choice — `channel:read channel:send`, deliberately NOT `channel:write`:
 *   - `channel:read`  — receive replies over SSE.
 *   - `channel:send`  — post a message into the channel.
 *   - `channel:write` is the *session-reply* scope (a connected Claude Code
 *     session replying on a channel). A UI token must not be able to
 *     impersonate a session, so we never mint `channel:write` here.
 *
 * Audience: `channel` (the bare service prefix). Channel validates the JWT's
 * `aud` claim against the literal string `"channel"` (parachute-channel
 * `src/hub-jwt.ts` `CHANNEL_AUDIENCE`), the same shape `inferAudience` in
 * oauth-handlers.ts stamps for the public OAuth flow — so hub-minted and
 * OAuth-minted channel tokens are indistinguishable to channel. Unlike the
 * per-vault admin token (`vault.<name>`), channel has a single bare audience.
 *
 * Multi-user Phase 1 gate: the session must belong to the first admin (the
 * single hub admin under the Phase 1 model — see `users.ts:isFirstAdmin`),
 * mirroring host-admin-token and vault-admin-token. Friends pinned to a vault
 * use the OAuth flow for their assigned scopes; they don't get a channel
 * Bearer via this endpoint.
 *
 * Tokens minted here are short-lived (10 min — matches host/vault admin
 * tokens); the UI re-fetches on near-expiry.
 */
import type { Database } from "bun:sqlite";
import { signAccessToken } from "./jwt-sign.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";

/** Short TTL — matches host/vault admin-token. UI re-fetches on near-expiry. */
export const CHANNEL_TOKEN_TTL_SECONDS = 10 * 60;
const CHANNEL_AUDIENCE = "channel";
const CHANNEL_CLIENT_ID = "parachute-hub-spa";
/**
 * `channel:read` (SSE replies) + `channel:send` (post a message). Deliberately
 * NOT `channel:write` — that's the session-reply scope, and a UI token must
 * not be able to impersonate a connected session.
 */
export const CHANNEL_TOKEN_SCOPES = ["channel:read", "channel:send"] as const;

export interface MintChannelTokenDeps {
  db: Database;
  /** Hub origin — written into JWT `iss`. */
  issuer: string;
}

export async function handleChannelToken(
  req: Request,
  deps: MintChannelTokenDeps,
): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  if (!session) {
    return jsonError(401, "unauthenticated", "no admin session — sign in at /login first");
  }
  // First-admin gate (mirrors host/vault-admin-token). A friend account
  // (non-first-admin user created via `/api/users`) holds a valid session but
  // must not mint a channel Bearer. Without this check, any signed-in friend
  // hitting `GET /admin/channel-token` would walk away with a token carrying
  // `channel:read channel:send`.
  if (!isFirstAdmin(deps.db, session.userId)) {
    return jsonError(
      403,
      "not_admin",
      "channel token mint is restricted to the hub admin — your account home is at /account/",
    );
  }
  const minted = await signAccessToken(deps.db, {
    sub: session.userId,
    scopes: [...CHANNEL_TOKEN_SCOPES],
    audience: CHANNEL_AUDIENCE,
    clientId: CHANNEL_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: CHANNEL_TOKEN_TTL_SECONDS,
    // Channel tokens carry no per-user vault pin — the UI Bearer talks to a
    // channel-scoped endpoint, not to a single vault. Empty `vault_scope` is
    // the "no per-user restriction" sentinel matching host-admin tokens.
    vaultScope: [],
  });
  return new Response(
    JSON.stringify({
      token: minted.token,
      expires_at: minted.expiresAt,
      scopes: CHANNEL_TOKEN_SCOPES,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        // No browser cache — token rotates per-fetch, and a stale 200 from a
        // back/forward navigation could hand the UI a long-expired JWT.
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
