/**
 * Tests for the GENERIC per-module config-UI session→bearer mint endpoint
 * (`GET /admin/module-token/<short>`, 2026-06-09 modular-UI architecture P3).
 * Mirrors `admin-channel-token.test.ts` shape (single bare audience per
 * module). Covers:
 *   - 401 when no admin session cookie is present.
 *   - 401 when the cookie names a deleted session.
 *   - 405 on POST.
 *   - 200 + JWT carrying `aud: "<short>"` and `<short>:admin` for known modules
 *     (scribe / runner / surface).
 *   - 400 for `vault` (per-instance — points at /admin/vault-admin-token/<name>).
 *   - 404 for an unknown short.
 *   - First-admin gate: 403 for a signed-in non-first-admin (friend).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODULE_TOKEN_TTL_SECONDS, handleModuleToken } from "../admin-module-token.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "phub-module-token-"));
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

async function withAdminAndFriend(): Promise<{ friendCookie: string }> {
  const admin = await createUser(harness.db, "admin", "admin-passphrase");
  const friend = await createUser(harness.db, "alice", "alice-passphrase", { allowMulti: true });
  createSession(harness.db, { userId: admin.id });
  const friendSession = createSession(harness.db, { userId: friend.id });
  return {
    friendCookie: buildSessionCookie(friendSession.id, Math.floor(SESSION_TTL_MS / 1000)),
  };
}

function urlFor(short: string): string {
  return `${ISSUER}/admin/module-token/${short}`;
}

describe("handleModuleToken", () => {
  test("401 when no session cookie is present", async () => {
    const req = new Request(urlFor("scribe"));
    const res = await handleModuleToken(req, "scribe", { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("401 when the cookie names a deleted session", async () => {
    const { cookie } = await withSession();
    const sid = cookie.match(/parachute_hub_session=([^;]+)/)?.[1] ?? "";
    deleteSession(harness.db, sid);
    const req = new Request(urlFor("scribe"), { headers: { cookie } });
    const res = await handleModuleToken(req, "scribe", { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
  });

  test("405 on POST", async () => {
    const { cookie } = await withSession();
    const req = new Request(urlFor("scribe"), { method: "POST", headers: { cookie } });
    const res = await handleModuleToken(req, "scribe", { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });

  // The known single-audience modules the generic mint serves. Each gets
  // `<short>:admin` with `aud: <short>`.
  for (const short of ["scribe", "runner", "surface", "channel"]) {
    test(`200 mints a JWT carrying aud:${short} + ${short}:admin`, async () => {
      const { cookie, userId } = await withSession();
      rotateSigningKey(harness.db);
      const req = new Request(urlFor(short), { headers: { cookie } });
      const res = await handleModuleToken(req, short, { db: harness.db, issuer: ISSUER });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");

      const body = (await res.json()) as { token: string; expires_at: string; scopes: string[] };
      expect(body.scopes).toEqual([`${short}:admin`]);
      expect(body.token.length).toBeGreaterThan(20);

      const expMs = new Date(body.expires_at).getTime();
      const skew = expMs - Date.now();
      expect(skew).toBeGreaterThan((MODULE_TOKEN_TTL_SECONDS - 30) * 1000);
      expect(skew).toBeLessThan((MODULE_TOKEN_TTL_SECONDS + 30) * 1000);

      const validated = await validateAccessToken(harness.db, body.token, ISSUER);
      expect(validated.payload.sub).toBe(userId);
      expect(validated.payload.iss).toBe(ISSUER);
      // Bare service audience — modules validate `aud === <short>`.
      expect(validated.payload.aud).toBe(short);
      const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
      expect(scopeClaim.split(/\s+/)).toContain(`${short}:admin`);
    });
  }

  test("400 use_vault_admin_token for vault (per-instance)", async () => {
    const { cookie } = await withSession();
    const req = new Request(urlFor("vault"), { headers: { cookie } });
    const res = await handleModuleToken(req, "vault", { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("use_vault_admin_token");
  });

  test("404 for an unknown short", async () => {
    const { cookie } = await withSession();
    const req = new Request(urlFor("totally-made-up"), { headers: { cookie } });
    const res = await handleModuleToken(req, "totally-made-up", {
      db: harness.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("400 for an invalid identifier", async () => {
    const { cookie } = await withSession();
    const req = new Request(`${ISSUER}/admin/module-token/Not%20Valid`, { headers: { cookie } });
    const res = await handleModuleToken(req, "Not Valid", { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("403 not_admin when a signed-in non-first-admin (friend) hits the endpoint", async () => {
    const { friendCookie } = await withAdminAndFriend();
    rotateSigningKey(harness.db);
    const req = new Request(urlFor("scribe"), { headers: { cookie: friendCookie } });
    const res = await handleModuleToken(req, "scribe", { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_admin");
  });
});
