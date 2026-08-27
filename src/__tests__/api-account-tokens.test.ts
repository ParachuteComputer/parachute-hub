/**
 * `/api/account/tokens*` — self-service list/mint/revoke (hub#833).
 *
 * Coverage:
 *   - cookie + CSRF posture (401 / 403), self-only
 *   - mint as session user_id; JWT sub is users.id
 *   - friend cannot mint parachute:host:*
 *   - friend with assigned vaults can mint vault:<assigned>:<verb>
 *   - revoke 404 for someone else's jti (no existence oracle)
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApiAccount } from "../api-account-2fa.ts";
import { CSRF_COOKIE_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { mintOperatorToken } from "../operator-token.ts";
import { __resetForTests as resetRateLimit } from "../rate-limit.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const TEST_CSRF = "csrf-account-tokens";
const CSRF_COOKIE = `${CSRF_COOKIE_NAME}=${TEST_CSRF}`;
const ORIGIN = "https://hub.example";
const ISSUER = "http://127.0.0.1:1939";
const PASSWORD = "correct-horse-battery";

let db: Database;
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "phub-api-acct-tokens-"));
  db = openHubDb(hubDbPath(configDir));
  rotateSigningKey(db);
  resetRateLimit();
});

afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
});

interface TestUser {
  userId: string;
  username: string;
  cookie: string;
}

async function userWithSession(
  username: string,
  extra: { assignedVaults?: string[]; allowMulti?: boolean } = {},
): Promise<TestUser> {
  const u = await createUser(db, username, PASSWORD, {
    allowMulti: extra.allowMulti ?? username !== "owner",
    passwordChanged: true,
    ...(extra.assignedVaults ? { assignedVaults: extra.assignedVaults } : {}),
  });
  const session = createSession(db, { userId: u.id });
  return {
    userId: u.id,
    username: u.username,
    cookie: `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`,
  };
}

function call(
  method: string,
  subpath: string,
  cookie: string | null,
  body?: Record<string, unknown>,
): Promise<Response> {
  const url = `${ORIGIN}/api/account/tokens${subpath}`;
  const req = new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return handleApiAccount(req, `/tokens${subpath.split("?")[0]}`, {
    db,
    issuer: ISSUER,
  });
}

describe("auth posture", () => {
  test("every route needs a session", async () => {
    for (const [method, path, body] of [
      ["GET", "", undefined],
      ["POST", "", { __csrf: TEST_CSRF, scope: "vault:work:read" }],
      ["POST", "/no-such/revoke", { __csrf: TEST_CSRF }],
    ] as const) {
      const res = await call(method, path, null, body as Record<string, unknown> | undefined);
      expect(res.status).toBe(401);
    }
  });

  test("every mutation needs a valid CSRF token", async () => {
    const owner = await userWithSession("owner");
    const mint = await call("POST", "", owner.cookie, { scope: "scribe:transcribe" });
    expect(mint.status).toBe(403);
    const revoke = await call("POST", "/abc/revoke", owner.cookie, {});
    expect(revoke.status).toBe(403);
  });
});

describe("GET /api/account/tokens", () => {
  test("lists only this user's tokens; unrevoked default", async () => {
    const owner = await userWithSession("owner");
    const friend = await userWithSession("friend", { assignedVaults: ["work"] });
    await mintOperatorToken(db, owner.userId, { issuer: ISSUER });
    const minted = await call("POST", "", friend.cookie, {
      __csrf: TEST_CSRF,
      scope: "vault:work:read",
    });
    expect(minted.status).toBe(200);

    const ownerList = await call("GET", "", owner.cookie);
    expect(ownerList.status).toBe(200);
    const ownerBody = (await ownerList.json()) as {
      tokens: { user_id: string; jti: string }[];
      next_cursor: string | null;
    };
    expect(ownerBody.tokens.every((t) => t.user_id === owner.userId)).toBe(true);
    expect(ownerBody.tokens.length).toBeGreaterThan(0);
    expect(ownerBody.next_cursor).toBeNull();

    const friendList = await call("GET", "", friend.cookie);
    const friendBody = (await friendList.json()) as {
      tokens: { user_id: string }[];
      next_cursor: string | null;
    };
    expect(friendBody.tokens.every((t) => t.user_id === friend.userId)).toBe(true);
    expect(friendBody.tokens.length).toBe(1);
    expect(friendBody.next_cursor).toBeNull();
  });

  test("pages at 50 and returns next_cursor when more rows exist", async () => {
    const { recordTokenMint } = await import("../jwt-sign.ts");
    const owner = await userWithSession("owner");
    const stamp = new Date("2026-08-25T12:00:00.000Z");
    const user = db
      .query<{ updated_at: string }, [string]>("SELECT updated_at FROM users WHERE id = ?")
      .get(owner.userId);
    if (!user) throw new Error("owner missing");
    for (let i = 0; i < 51; i++) {
      recordTokenMint(db, {
        jti: `acct-page-${String(i).padStart(3, "0")}`,
        createdVia: "cli_mint",
        subject: "page",
        userId: owner.userId,
        userUpdatedAt: user.updated_at,
        clientId: "parachute-account",
        scopes: ["scribe:transcribe"],
        expiresAt: "2030-01-01T00:00:00.000Z",
        now: () => new Date(stamp.getTime() + i * 1000),
      });
    }
    const first = await call("GET", "", owner.cookie);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      tokens: { jti: string }[];
      next_cursor: string | null;
    };
    expect(firstBody.tokens).toHaveLength(50);
    expect(firstBody.next_cursor).toBeTruthy();
    const second = await call(
      "GET",
      `?cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
      owner.cookie,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      tokens: { jti: string }[];
      next_cursor: string | null;
    };
    expect(secondBody.tokens.length).toBeGreaterThanOrEqual(1);
    expect(secondBody.next_cursor).toBeNull();
    const firstJtis = new Set(firstBody.tokens.map((t) => t.jti));
    expect(secondBody.tokens.some((t) => firstJtis.has(t.jti))).toBe(false);
  });
});

describe("POST /api/account/tokens", () => {
  test("mints as the session user_id; JWT sub is users.id", async () => {
    const owner = await userWithSession("owner");
    const res = await call("POST", "", owner.cookie, {
      __csrf: TEST_CSRF,
      scope: "scribe:transcribe",
      label: "laptop",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jti: string; token: string; scope: string };
    expect(body.scope).toBe("scribe:transcribe");
    const validated = await validateAccessToken(db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(owner.userId);
    const row = db
      .query<{ user_id: string; subject: string }, [string]>(
        "SELECT user_id, subject FROM tokens WHERE jti = ?",
      )
      .get(body.jti);
    expect(row?.user_id).toBe(owner.userId);
    expect(row?.subject).toBe("laptop");
  });

  test("friend cannot mint parachute:host:*", async () => {
    await userWithSession("owner");
    const friend = await userWithSession("friend", { assignedVaults: ["work"] });
    const res = await call("POST", "", friend.cookie, {
      __csrf: TEST_CSRF,
      scope: "parachute:host:admin",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_scope");
    expect(body.error_description).toContain("parachute:host:admin");
  });

  test("friend with assigned vaults can mint vault:<assigned>:<verb>", async () => {
    await userWithSession("owner");
    const friend = await userWithSession("friend", { assignedVaults: ["work"] });
    const res = await call("POST", "", friend.cookie, {
      __csrf: TEST_CSRF,
      scope: "vault:work:read",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const validated = await validateAccessToken(db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(friend.userId);
    expect(validated.payload.scope).toBe("vault:work:read");
  });

  test("friend cannot mint a vault they are not assigned", async () => {
    await userWithSession("owner");
    const friend = await userWithSession("friend", { assignedVaults: ["work"] });
    const res = await call("POST", "", friend.cookie, {
      __csrf: TEST_CSRF,
      scope: "vault:other:read",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_scope");
  });
});

describe("POST /api/account/tokens/:jti/revoke", () => {
  test("404 for someone else's jti (no existence oracle)", async () => {
    const owner = await userWithSession("owner");
    const friend = await userWithSession("friend", { assignedVaults: ["work"] });
    const minted = await call("POST", "", owner.cookie, {
      __csrf: TEST_CSRF,
      scope: "scribe:transcribe",
    });
    expect(minted.status).toBe(200);
    const { jti } = (await minted.json()) as { jti: string };

    const asFriend = await call("POST", `/${jti}/revoke`, friend.cookie, { __csrf: TEST_CSRF });
    expect(asFriend.status).toBe(404);
    const missing = await call("POST", "/no-such-jti/revoke", friend.cookie, { __csrf: TEST_CSRF });
    expect(missing.status).toBe(404);
    expect(await asFriend.text()).toBe(await missing.clone().text());
  });

  test("owner can revoke their own jti", async () => {
    const owner = await userWithSession("owner");
    const minted = await call("POST", "", owner.cookie, {
      __csrf: TEST_CSRF,
      scope: "scribe:transcribe",
    });
    const { jti } = (await minted.json()) as { jti: string };
    const res = await call("POST", `/${jti}/revoke`, owner.cookie, { __csrf: TEST_CSRF });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revoked: boolean; jti: string };
    expect(body.revoked).toBe(true);
    expect(body.jti).toBe(jti);
  });
});
