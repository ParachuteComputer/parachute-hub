/**
 * `GET /admin/channel-token` — exchange a valid admin session cookie for a
 * short-lived JWT carrying `channel:read channel:send channel:admin`.
 *
 * Why this exists: two channel-owned UIs, both served behind hub's proxy to a
 * logged-in portal operator, need a Bearer to talk to channel's API the same
 * way the vault-management and scribe-config SPAs do, without running the
 * public `/oauth/authorize` flow:
 *   - The **chat UI** (`/channel/ui`) receives replies over SSE
 *     (`channel:read`) and posts a message (`channel:send`).
 *   - The **config/admin UI** (`/channel/admin`, the 2026-06-09 modular-UI
 *     architecture P3/P4 config surface) lists + edits configured channels via
 *     `channel:admin`-gated endpoints (`requireScope(SCOPE_ADMIN)` in channel's
 *     daemon).
 *
 * Both UIs fetch this single endpoint (`fetchToken()` against
 * `/admin/channel-token`), so the minted token carries the union of the scopes
 * either UI needs. The chat UI simply ignores the extra `channel:admin` scope;
 * `requireScope` checks for the *presence* of a specific scope, so extra
 * scopes never break a read/send call. This is what makes the channel config
 * UI work without re-touching the channel repo — the hub endpoint the config
 * UI already calls now mints the admin scope it needs (2026-06-09 modular-UI
 * architecture, P3).
 *
 * Scope choice — `channel:read channel:send channel:admin`, deliberately NOT
 * `channel:write`:
 *   - `channel:read`  — receive replies over SSE.
 *   - `channel:send`  — post a message into the channel.
 *   - `channel:admin` — list + edit channel config (the config UI).
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
 * `channel:read` (SSE replies) + `channel:send` (post a message) +
 * `channel:admin` (list + edit channel config — the config UI). Deliberately
 * NOT `channel:write` — that's the session-reply scope, and a UI token must
 * not be able to impersonate a connected session. The chat UI ignores the
 * extra `channel:admin`; the config UI needs it (2026-06-09 modular-UI
 * architecture, P3 — the hub endpoint the channel config UI already calls
 * mints the admin scope so the channel repo doesn't have to change).
 */
export const CHANNEL_TOKEN_SCOPES = ["channel:read", "channel:send", "channel:admin"] as const;

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
