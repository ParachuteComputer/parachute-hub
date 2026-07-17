import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_ERROR_CODES, checkAccountSessionResponse } from "@openparachute/door-contract";
import { handleAccountSession } from "../account-session.ts";
import { CSRF_COOKIE_NAME, buildCsrfCookie, generateCsrfToken, parseCsrfCookie } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  SESSION_COOKIE_NAME,
  SESSION_SLIDE_THRESHOLD_MS,
  SESSION_TTL_MS,
  buildSessionCookie,
  createSession,
  findSession,
} from "../sessions.ts";
import { createUser } from "../users.ts";

/**
 * Tests for `GET /account/session` — the same-origin boot oracle (hub-parity
 * P1, the twin of cloud's `account-session.ts`). Covers:
 *   - both branches' body shape (signed-out / signed-in).
 *   - CSRF minted when absent, reused (no re-Set-Cookie) when present — on
 *     BOTH branches (the G2 anonymous-CSRF invariant).
 *   - a deleted-user session row falls back to signed-out.
 *   - the bounded slide: an old-but-live session rolls + re-issues the
 *     cookie; a fresh session does neither.
 *   - 405 on non-GET, `cache-control: no-store`, no CORS headers.
 *   - drift: `checkAccountSessionResponse` reports zero issues against the
 *     live handler on both branches.
 */
const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-account-session-"));
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

function getReq(cookie?: string, method = "GET"): Request {
  return new Request(`${ISSUER}/account/session`, {
    method,
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

function sessionCookiePair(sid: string): string {
  return buildSessionCookie(sid, Math.floor(SESSION_TTL_MS / 1000));
}

describe("handleAccountSession — signed-out branch", () => {
  test("no cookie at all → {signed_in:false, csrf} + CSRF Set-Cookie minted", async () => {
    const res = handleAccountSession(getReq(), { db: harness.db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signed_in: boolean; csrf: string };
    expect(body.signed_in).toBe(false);
    expect(typeof body.csrf).toBe("string");
    expect(body.csrf.length).toBeGreaterThan(0);

    const setCookie = res.headers.getSetCookie();
    const csrfSet = setCookie.find((c) => c.includes(CSRF_COOKIE_NAME));
    expect(csrfSet).toBeDefined();
    expect(parseCsrfCookie(csrfSet ?? null)).toBe(body.csrf);
  });

  test("reuses an existing CSRF cookie without re-minting (no Set-Cookie)", async () => {
    const existing = generateCsrfToken();
    const cookie = buildCsrfCookie(existing).split(";")[0] ?? "";
    const res = handleAccountSession(getReq(cookie), { db: harness.db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signed_in: boolean; csrf: string };
    expect(body.signed_in).toBe(false);
    expect(body.csrf).toBe(existing);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a session cookie naming a deleted user → signed-out", async () => {
    // The on-disk FK normally guards against a session outliving its user, so
    // forge the orphaned row directly with `PRAGMA foreign_keys=OFF` (the
    // `api-account.test.ts` precedent) — simulating a delete-user-via-SQL-shell
    // race, not something reachable through the app's own APIs.
    const sessionId = "test-orphaned-session-id-base64url";
    harness.db.exec("PRAGMA foreign_keys = OFF");
    try {
      harness.db
        .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .run(
          sessionId,
          "nonexistent-user-uuid",
          new Date(Date.now() + SESSION_TTL_MS).toISOString(),
          new Date().toISOString(),
        );
    } finally {
      harness.db.exec("PRAGMA foreign_keys = ON");
    }
    const cookie = sessionCookiePair(sessionId);
    const res = handleAccountSession(getReq(cookie), { db: harness.db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signed_in: boolean };
    expect(body.signed_in).toBe(false);
  });

  test("drift: checkAccountSessionResponse reports zero issues (signed-out)", async () => {
    const res = handleAccountSession(getReq(), { db: harness.db });
    const body = (await res.json()) as Record<string, unknown>;
    expect(checkAccountSessionResponse(body, { signedIn: false })).toEqual([]);
  });
});

describe("handleAccountSession — signed-in branch", () => {
  test("username always present; no email when the user row has none", async () => {
    const user = await createUser(harness.db, "operator", "pw", { passwordChanged: true });
    const session = createSession(harness.db, { userId: user.id });
    const res = handleAccountSession(getReq(sessionCookiePair(session.id)), { db: harness.db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.signed_in).toBe(true);
    expect(body.username).toBe("operator");
    expect(body.email).toBeUndefined();
    expect(body.account_created_at).toBe(user.createdAt);
    expect(body.password_change_required).toBeUndefined();
  });

  test("email present when the user row has one", async () => {
    const user = await createUser(harness.db, "withmail", "pw", {
      passwordChanged: true,
      email: "friend@example.com",
    });
    const session = createSession(harness.db, { userId: user.id });
    const res = handleAccountSession(getReq(sessionCookiePair(session.id)), { db: harness.db });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.email).toBe("friend@example.com");
    expect(body.username).toBe("withmail");
  });

  test("password_change_required:true for a not-yet-rotated (passwordChanged:false) user", async () => {
    // createUser defaults passwordChanged to false — the admin-created-user
    // posture (force-redirect on first sign-in).
    const user = await createUser(harness.db, "temp", "pw");
    const session = createSession(harness.db, { userId: user.id });
    const res = handleAccountSession(getReq(sessionCookiePair(session.id)), { db: harness.db });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.signed_in).toBe(true);
    expect(body.password_change_required).toBe(true);
  });

  test("mints CSRF when absent even on the signed-in branch", async () => {
    const user = await createUser(harness.db, "operator2", "pw", { passwordChanged: true });
    const session = createSession(harness.db, { userId: user.id });
    const res = handleAccountSession(getReq(sessionCookiePair(session.id)), { db: harness.db });
    const body = (await res.json()) as { csrf: string };
    expect(typeof body.csrf).toBe("string");
    expect(body.csrf.length).toBeGreaterThan(0);
    const setCookie = res.headers.getSetCookie();
    expect(setCookie.some((c) => c.includes(CSRF_COOKIE_NAME))).toBe(true);
  });

  test("drift: checkAccountSessionResponse reports zero issues (signed-in)", async () => {
    const user = await createUser(harness.db, "driftcheck", "pw", { passwordChanged: true });
    const session = createSession(harness.db, { userId: user.id });
    const res = handleAccountSession(getReq(sessionCookiePair(session.id)), { db: harness.db });
    const body = (await res.json()) as Record<string, unknown>;
    expect(checkAccountSessionResponse(body, { signedIn: true })).toEqual([]);
  });
});

describe("handleAccountSession — bounded slide", () => {
  test("an old-but-live session (within the slide threshold of expiry) rolls + re-issues the cookie", async () => {
    const user = await createUser(harness.db, "slider", "pw", { passwordChanged: true });
    const t0 = new Date();
    // Created far enough in the past that remaining life < TTL - threshold.
    const createdAt = new Date(
      t0.getTime() - (SESSION_TTL_MS - SESSION_SLIDE_THRESHOLD_MS + 60_000),
    );
    const session = createSession(harness.db, { userId: user.id, now: () => createdAt });
    const originalExpiry = new Date(session.expiresAt).getTime();

    const res = handleAccountSession(getReq(sessionCookiePair(session.id)), { db: harness.db });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie();
    const sessionSet = setCookie.find((c) => c.includes(SESSION_COOKIE_NAME));
    expect(sessionSet).toBeDefined();
    expect(sessionSet).toContain("HttpOnly");
    expect(sessionSet).toContain("SameSite=Lax");

    const found = findSession(harness.db, session.id);
    expect(new Date(found?.expiresAt ?? 0).getTime()).toBeGreaterThan(originalExpiry);
  });

  test("a fresh session does NOT slide — no session Set-Cookie, no DB write", async () => {
    const user = await createUser(harness.db, "fresh", "pw", { passwordChanged: true });
    const session = createSession(harness.db, { userId: user.id });
    const originalExpiry = session.expiresAt;

    const res = handleAccountSession(getReq(sessionCookiePair(session.id)), { db: harness.db });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie();
    expect(setCookie.some((c) => c.includes(SESSION_COOKIE_NAME))).toBe(false);

    const found = findSession(harness.db, session.id);
    expect(found?.expiresAt).toBe(originalExpiry);
  });
});

describe("handleAccountSession — method + headers", () => {
  test("405 on POST", async () => {
    const res = handleAccountSession(getReq(undefined, "POST"), { db: harness.db });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
    // H1.3 — pin the CURRENT shape: resource-level failures on /account/*
    // emit {error, message} (door-contract account-contract.ts:244-246). This
    // is account-session.ts's own `methodNotAllowed`, distinct from
    // account-token.ts's {error, error_description} 405 (see H1.1/H1.3 PR
    // notes — a decisions-needed inconsistency, not fixed here).
    const body = (await res.json()) as { error: string; message: string };
    expect(body).toEqual({ error: "method_not_allowed", message: "use GET" });
    expect(ACCOUNT_ERROR_CODES as readonly string[]).toContain(body.error);
  });

  test("cache-control: no-store on the 200 path", async () => {
    const res = handleAccountSession(getReq(), { db: harness.db });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("no access-control-allow-origin (same-origin only, no CORS)", async () => {
    const req = new Request(`${ISSUER}/account/session`, {
      headers: { origin: "https://evil.example" },
    });
    const res = handleAccountSession(req, { db: harness.db });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
