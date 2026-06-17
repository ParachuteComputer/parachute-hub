/**
 * Tests for the agent UI session→bearer mint endpoint. Mirrors
 * `admin-host-admin-token.test.ts` shape (agent has a single bare audience,
 * no per-vault name). Covers:
 *   - 401 when no admin session cookie is present.
 *   - 401 when the cookie names a deleted session.
 *   - 405 on POST.
 *   - 200 + JWT carrying `aud: "agent"` and `agent:read agent:send agent:admin`.
 *   - First-admin gate: 403 for a signed-in non-first-admin (friend); the
 *     admin's happy path still mints when a friend exists alongside.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TOKEN_TTL_SECONDS, handleAgentToken } from "../admin-agent-token.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession, deleteSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-agent-token-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

async function withSession(): Promise<{ cookie: string; userId: string }> {
  const user = await createUser(harness.db, "operator", "hunter2");
  const session = createSession(harness.db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  return { cookie, userId: user.id };
}

/**
 * Seed an admin (first-created user) + a second non-admin "friend" account,
 * return cookies + ids for both. Used by the first-admin-gate tests.
 */
async function withAdminAndFriend(): Promise<{
  adminCookie: string;
  adminId: string;
  friendCookie: string;
  friendId: string;
}> {
  const admin = await createUser(harness.db, "admin", "admin-passphrase");
  const friend = await createUser(harness.db, "alice", "alice-passphrase", {
    allowMulti: true,
  });
  const adminSession = createSession(harness.db, { userId: admin.id });
  const friendSession = createSession(harness.db, { userId: friend.id });
  return {
    adminCookie: buildSessionCookie(adminSession.id, Math.floor(SESSION_TTL_MS / 1000)),
    adminId: admin.id,
    friendCookie: buildSessionCookie(friendSession.id, Math.floor(SESSION_TTL_MS / 1000)),
    friendId: friend.id,
  };
}

describe("handleAgentToken", () => {
  test("401 when no session cookie is present", async () => {
    const req = new Request(`${ISSUER}/admin/agent-token`);
    const res = await handleAgentToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("401 when the cookie names a deleted session", async () => {
    const { cookie } = await withSession();
    const sid = cookie.match(/parachute_hub_session=([^;]+)/)?.[1] ?? "";
    deleteSession(harness.db, sid);
    const req = new Request(`${ISSUER}/admin/agent-token`, { headers: { cookie } });
    const res = await handleAgentToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
  });

  test("405 on POST", async () => {
    const { cookie } = await withSession();
    const req = new Request(`${ISSUER}/admin/agent-token`, {
      method: "POST",
      headers: { cookie },
    });
    const res = await handleAgentToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });

  test("200 mints a JWT carrying aud:agent + agent:read agent:send agent:admin", async () => {
    const { cookie, userId } = await withSession();
    rotateSigningKey(harness.db);
    const req = new Request(`${ISSUER}/admin/agent-token`, { headers: { cookie } });
    const res = await handleAgentToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as { token: string; expires_at: string; scopes: string[] };
    // `agent:send` (post) + `agent:read` (SSE replies) + `agent:admin`
    // (config UI list/edit — 2026-06-09 modular-UI architecture P3). Deliberately
    // NOT `agent:write` — that's the session-reply scope a UI token must not hold.
    expect(body.scopes).toEqual(["agent:read", "agent:send", "agent:admin"]);
    expect(body.scopes).not.toContain("agent:write");
    expect(body.token.length).toBeGreaterThan(20);

    const expMs = new Date(body.expires_at).getTime();
    const skew = expMs - Date.now();
    expect(skew).toBeGreaterThan((AGENT_TOKEN_TTL_SECONDS - 30) * 1000);
    expect(skew).toBeLessThan((AGENT_TOKEN_TTL_SECONDS + 30) * 1000);

    const validated = await validateAccessToken(harness.db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(userId);
    expect(validated.payload.iss).toBe(ISSUER);
    // Bare service audience — agent validates `aud === "agent"`
    // (parachute-agent src/hub-jwt.ts).
    expect(validated.payload.aud).toBe("agent");
    const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
    const scopes = scopeClaim.split(/\s+/);
    expect(scopes).toContain("agent:read");
    expect(scopes).toContain("agent:send");
    expect(scopes).toContain("agent:admin");
    expect(scopes).not.toContain("agent:write");
  });

  test("403 not_admin when a signed-in non-first-admin (friend) hits the endpoint", async () => {
    // Privesc closure (mirrors host/vault-admin-token). The friend's session
    // is valid; the endpoint must refuse because session.userId isn't the
    // first-admin row.
    const { friendCookie } = await withAdminAndFriend();
    rotateSigningKey(harness.db);
    const req = new Request(`${ISSUER}/admin/agent-token`, {
      headers: { cookie: friendCookie },
    });
    const res = await handleAgentToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("not_admin");
    expect(body.error_description).toContain("/account/");
  });

  test("first-admin path still succeeds when a friend exists alongside", async () => {
    const { adminCookie, adminId } = await withAdminAndFriend();
    rotateSigningKey(harness.db);
    const req = new Request(`${ISSUER}/admin/agent-token`, {
      headers: { cookie: adminCookie },
    });
    const res = await handleAgentToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const validated = await validateAccessToken(harness.db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(adminId);
  });
});
