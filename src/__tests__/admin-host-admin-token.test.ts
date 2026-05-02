/**
 * Tests for the SPA's session→bearer mint endpoint. Covers:
 *   - 401 when no admin session cookie is present.
 *   - 401 when the cookie names a deleted/expired session.
 *   - 200 + JWT carrying parachute:host:admin when the session is valid.
 *   - Token validates against the hub's own keys and the configured issuer.
 *   - Method-not-allowed on POST.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ADMIN_TOKEN_TTL_SECONDS, handleHostAdminToken } from "../admin-host-admin-token.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession, deleteSession } from "../sessions.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-host-admin-token-"));
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

describe("handleHostAdminToken", () => {
  test("401 when no session cookie is present", async () => {
    const req = new Request(`${ISSUER}/admin/host-admin-token`);
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("401 when the cookie names a deleted session", async () => {
    const { cookie } = await withSession();
    // Pluck the session id back out of the cookie + delete its row.
    const sid = cookie.match(/parachute_hub_session=([^;]+)/)?.[1] ?? "";
    deleteSession(harness.db, sid);
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      headers: { cookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(401);
  });

  test("405 on POST", async () => {
    const { cookie } = await withSession();
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      method: "POST",
      headers: { cookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(405);
  });

  test("200 mints a JWT carrying parachute:host:admin and the configured issuer", async () => {
    const { cookie, userId } = await withSession();
    const req = new Request(`${ISSUER}/admin/host-admin-token`, {
      headers: { cookie },
    });
    const res = await handleHostAdminToken(req, { db: harness.db, issuer: ISSUER });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      token: string;
      expires_at: string;
      scopes: string[];
    };
    expect(body.scopes).toEqual(["parachute:host:admin"]);
    expect(body.token.length).toBeGreaterThan(20);

    // expires_at is roughly TTL_SECONDS in the future.
    const expMs = new Date(body.expires_at).getTime();
    const skew = expMs - Date.now();
    expect(skew).toBeGreaterThan((HOST_ADMIN_TOKEN_TTL_SECONDS - 30) * 1000);
    expect(skew).toBeLessThan((HOST_ADMIN_TOKEN_TTL_SECONDS + 30) * 1000);

    // JWT verifies against the hub's own signing key + issuer.
    const validated = await validateAccessToken(harness.db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(userId);
    expect(validated.payload.iss).toBe(ISSUER);
    const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
    expect(scopeClaim.split(/\s+/)).toContain("parachute:host:admin");
  });
});
