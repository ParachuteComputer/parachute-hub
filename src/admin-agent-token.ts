/**
 * `GET /admin/agent-token` — exchange a valid admin session cookie for a
 * short-lived JWT carrying `agent:read agent:send agent:admin`.
 *
 * Renamed from `/admin/channel-token` 2026-06-17 (parachute-channel →
 * parachute-agent). The old path keeps working via a 301 redirect in
 * hub-server.ts for one release cycle.
 *
 * Why this exists: two agent-owned UIs, both served behind hub's proxy to a
 * logged-in portal operator, need a Bearer to talk to agent's API the same
 * way the vault-management and scribe-config SPAs do, without running the
 * public `/oauth/authorize` flow:
 *   - The **chat UI** (`/agent/ui`) receives replies over SSE
 *     (`agent:read`) and posts a message (`agent:send`).
 *   - The **config/admin UI** (`/agent/admin`, the 2026-06-09 modular-UI
 *     architecture P3/P4 config surface) lists + edits configured channels via
 *     `agent:admin`-gated endpoints (`requireScope(SCOPE_ADMIN)` in agent's
 *     daemon).
 *
 * Both UIs fetch this single endpoint (`fetchToken()` against
 * `/admin/agent-token`), so the minted token carries the union of the scopes
 * either UI needs. The chat UI simply ignores the extra `agent:admin` scope;
 * `requireScope` checks for the *presence* of a specific scope, so extra
 * scopes never break a read/send call. This is what makes the agent config
 * UI work without re-touching the agent repo — the hub endpoint the config
 * UI already calls now mints the admin scope it needs (2026-06-09 modular-UI
 * architecture, P3).
 *
 * Scope choice — `agent:read agent:send agent:admin`, deliberately NOT
 * `agent:write`:
 *   - `agent:read`  — receive replies over SSE.
 *   - `agent:send`  — post a message into the channel.
 *   - `agent:admin` — list + edit channel config (the config UI).
 *   - `agent:write` is the *session-reply* scope (a connected Claude Code
 *     session replying on a channel). A UI token must not be able to
 *     impersonate a session, so we never mint `agent:write` here.
 *
 * Audience: `agent` (the bare service prefix). Agent validates the JWT's
 * `aud` claim against the literal string `"agent"` (parachute-agent
 * `src/hub-jwt.ts`), the same shape `inferAudience` in oauth-handlers.ts
 * stamps for the public OAuth flow — so hub-minted and OAuth-minted agent
 * tokens are indistinguishable to agent. Unlike the per-vault admin token
 * (`vault.<name>`), agent has a single bare audience. (During the rename
 * transition window the agent daemon dual-accepts both `aud: "channel"` and
 * `aud: "agent"`, so pre-rename tokens keep validating until re-minted — see
 * the channel→agent migration doc; that back-compat lives in the daemon, not
 * here.)
 *
 * Multi-user Phase 1 gate: the session must belong to the first admin (the
 * single hub admin under the Phase 1 model — see `users.ts:isFirstAdmin`),
 * mirroring host-admin-token and vault-admin-token. Friends pinned to a vault
 * use the OAuth flow for their assigned scopes; they don't get an agent
 * Bearer via this endpoint.
 *
 * Tokens minted here are short-lived (10 min — matches host/vault admin
 * tokens); the UI re-fetches on near-expiry.
 */
import type { Database } from "bun:sqlite";
import { lockedResponse, requireUnlocked } from "./admin-lock.ts";
import { signAccessToken } from "./jwt-sign.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";

/** Short TTL — matches host/vault admin-token. UI re-fetches on near-expiry. */
export const AGENT_TOKEN_TTL_SECONDS = 10 * 60;
const AGENT_AUDIENCE = "agent";
const AGENT_CLIENT_ID = "parachute-hub-spa";
/**
 * `agent:read` (SSE replies) + `agent:send` (post a message) +
 * `agent:admin` (list + edit channel config — the config UI). Deliberately
 * NOT `agent:write` — that's the session-reply scope, and a UI token must
 * not be able to impersonate a connected session. The chat UI ignores the
 * extra `agent:admin`; the config UI needs it (2026-06-09 modular-UI
 * architecture, P3 — the hub endpoint the agent config UI already calls
 * mints the admin scope so the agent repo doesn't have to change).
 */
export const AGENT_TOKEN_SCOPES = ["agent:read", "agent:send", "agent:admin"] as const;

export interface MintAgentTokenDeps {
  db: Database;
  /** Hub origin — written into JWT `iss`. */
  issuer: string;
}

export async function handleAgentToken(req: Request, deps: MintAgentTokenDeps): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  if (!session || !sid) {
    return jsonError(401, "unauthenticated", "no admin session — sign in at /login first");
  }
  // First-admin gate (mirrors host/vault-admin-token). A friend account
  // (non-first-admin user created via `/api/users`) holds a valid session but
  // must not mint an agent Bearer. Without this check, any signed-in friend
  // hitting `GET /admin/agent-token` would walk away with a token carrying
  // `agent:read agent:send`.
  if (!isFirstAdmin(deps.db, session.userId)) {
    return jsonError(
      403,
      "not_admin",
      "agent token mint is restricted to the hub admin — your account home is at /account/",
    );
  }
  // Admin screen-lock gate (see admin-host-admin-token.ts). A locked admin
  // session can't mint an agent Bearer, so agent's config + chat UIs show
  // the lock screen / fail closed until the operator unlocks. Off by default.
  if (!requireUnlocked(deps.db, sid).ok) {
    return lockedResponse();
  }
  const minted = await signAccessToken(deps.db, {
    sub: session.userId,
    scopes: [...AGENT_TOKEN_SCOPES],
    audience: AGENT_AUDIENCE,
    clientId: AGENT_CLIENT_ID,
    issuer: deps.issuer,
    ttlSeconds: AGENT_TOKEN_TTL_SECONDS,
    // Agent tokens carry no per-user vault pin — the UI Bearer talks to an
    // agent-scoped endpoint, not to a single vault. Empty `vault_scope` is
    // the "no per-user restriction" sentinel matching host-admin tokens.
    vaultScope: [],
  });
  return new Response(
    JSON.stringify({
      token: minted.token,
      expires_at: minted.expiresAt,
      scopes: AGENT_TOKEN_SCOPES,
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
