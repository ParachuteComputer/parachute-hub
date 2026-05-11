import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleAdminLoginGet,
  handleAdminLoginPost,
  handleAdminLogoutPost,
} from "../admin-handlers.ts";
import { CSRF_COOKIE_NAME, CSRF_FIELD_NAME } from "../csrf.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { __resetForTests as resetRateLimit } from "../rate-limit.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession, findSession } from "../sessions.ts";
import { createUser } from "../users.ts";

const TEST_CSRF = "csrf-handlers-test-token";
const CSRF_COOKIE = `${CSRF_COOKIE_NAME}=${TEST_CSRF}`;

interface Harness {
  db: Database;
  configDir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const configDir = mkdtempSync(join(tmpdir(), "phub-admin-handlers-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    configDir,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

async function cookieForUser(db: Database, username: string, password: string): Promise<string> {
  const user = await createUser(db, username, password);
  const session = createSession(db, { userId: user.id });
  return `${CSRF_COOKIE}; ${buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000))}`;
}

function formBody(values: Record<string, string>): {
  body: string;
  headers: Record<string, string>;
} {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) params.append(k, v);
  return {
    body: params.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
  // Per-test rate-limit state — login tests share the UNKNOWN_IP sentinel
  // bucket since they don't set CF-Connecting-IP, so without a reset the
  // 6th test in this file would 429 spuriously.
  resetRateLimit();
});
afterEach(() => {
  harness.cleanup();
});

describe("handleAdminLoginGet", () => {
  test("renders login form and mints a CSRF cookie when none is present", () => {
    const req = new Request("http://hub.test/admin/login");
    const res = handleAdminLoginGet(harness.db, req);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain(CSRF_COOKIE_NAME);
  });

  test("echoes the next= query param into the form", async () => {
    const req = new Request("http://hub.test/admin/login?next=/admin/permissions");
    const res = handleAdminLoginGet(harness.db, req);
    const html = await res.text();
    expect(html).toContain('value="/admin/permissions"');
  });

  test("rewrites unsafe next= to /admin/vaults", async () => {
    const req = new Request("http://hub.test/admin/login?next=https%3A%2F%2Fevil.example%2Fpwn");
    const res = handleAdminLoginGet(harness.db, req);
    const html = await res.text();
    expect(html).toContain('value="/admin/vaults"');
    expect(html).not.toContain("evil.example");
  });

  test("missing next= falls back to /admin/vaults (SPA home)", async () => {
    // Post-SPA-rework default: the legacy `/admin/config` portal was retired,
    // so the login form's hidden `next` defaults to the SPA's vault list.
    const req = new Request("http://hub.test/admin/login");
    const res = handleAdminLoginGet(harness.db, req);
    const html = await res.text();
    expect(html).toContain('value="/admin/vaults"');
  });

  test("hidden __csrf input value matches the freshly-minted cookie value (#113)", async () => {
    const req = new Request("http://hub.test/admin/login");
    const res = handleAdminLoginGet(harness.db, req);
    const setCookie = res.headers.get("set-cookie") ?? "";
    const cookieMatch = setCookie.match(new RegExp(`${CSRF_COOKIE_NAME}=([A-Za-z0-9_-]+)`));
    expect(cookieMatch).not.toBeNull();
    const cookieToken = cookieMatch?.[1] ?? "";
    expect(cookieToken.length).toBeGreaterThan(0);
    const html = await res.text();
    const formMatch = html.match(new RegExp(`name="${CSRF_FIELD_NAME}" value="([^"]+)"`));
    expect(formMatch).not.toBeNull();
    expect(formMatch?.[1]).toBe(cookieToken);
  });
});

describe("handleAdminLoginPost", () => {
  test("rejects when CSRF token doesn't match the cookie", async () => {
    await createUser(harness.db, "admin", "pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: "wrong",
      username: "admin",
      password: "pw",
      next: "/admin/vaults",
    });
    const req = new Request("http://hub.test/admin/login", {
      method: "POST",
      headers: { ...headers, cookie: CSRF_COOKIE },
      body,
    });
    const res = await handleAdminLoginPost(harness.db, req);
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("rejects bad credentials with 401 and re-renders login", async () => {
    await createUser(harness.db, "admin", "correct-pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      username: "admin",
      password: "wrong",
      next: "/admin/vaults",
    });
    const req = new Request("http://hub.test/admin/login", {
      method: "POST",
      headers: { ...headers, cookie: CSRF_COOKIE },
      body,
    });
    const res = await handleAdminLoginPost(harness.db, req);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Invalid credentials");
  });

  test("redirects to next= and sets session cookie on success", async () => {
    await createUser(harness.db, "admin", "pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      username: "admin",
      password: "pw",
      next: "/admin/permissions",
    });
    const req = new Request("http://hub.test/admin/login", {
      method: "POST",
      headers: { ...headers, cookie: CSRF_COOKIE },
      body,
    });
    const res = await handleAdminLoginPost(harness.db, req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/permissions");
    expect(res.headers.get("set-cookie") ?? "").toContain("parachute_hub_session=");
  });

  test("ignores an absolute-URL next= from the form", async () => {
    await createUser(harness.db, "admin", "pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      username: "admin",
      password: "pw",
      next: "https://evil.example/pwn",
    });
    const req = new Request("http://hub.test/admin/login", {
      method: "POST",
      headers: { ...headers, cookie: CSRF_COOKIE },
      body,
    });
    const res = await handleAdminLoginPost(harness.db, req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/vaults");
  });

  test("ignores a protocol-relative next= from the form (open-redirect defense)", async () => {
    // Scheme-relative `//host/path` URLs would otherwise resolve to a
    // different origin when followed by the browser. `safeNext` rejects them
    // alongside scheme-absolute URLs; this test pins the POST path
    // explicitly so future refactors of the redirect builder don't quietly
    // re-open the open-redirect.
    await createUser(harness.db, "admin", "pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      username: "admin",
      password: "pw",
      next: "//evil.example/pwn",
    });
    const req = new Request("http://hub.test/admin/login", {
      method: "POST",
      headers: { ...headers, cookie: CSRF_COOKIE },
      body,
    });
    const res = await handleAdminLoginPost(harness.db, req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/vaults");
  });

  test("missing next= lands the operator on /admin/vaults (SPA home)", async () => {
    // Post-SPA-rework default: when the form omits `next`, login lands on
    // the SPA's vault list. Previously the legacy `/admin/config` portal
    // was the default; that page is retired and 301s to /admin/vaults.
    await createUser(harness.db, "admin", "pw");
    const { body, headers } = formBody({
      [CSRF_FIELD_NAME]: TEST_CSRF,
      username: "admin",
      password: "pw",
    });
    const req = new Request("http://hub.test/admin/login", {
      method: "POST",
      headers: { ...headers, cookie: CSRF_COOKIE },
      body,
    });
    const res = await handleAdminLoginPost(harness.db, req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin/vaults");
  });

  // hub#185 — per-IP rate-limit (5 attempts / 15 min) on POST /admin/login.
  test("6 rapid POSTs from same IP get 200/401×4/429 and the 429 carries Retry-After", async () => {
    await createUser(harness.db, "admin", "correct-pw");
    const buildReq = (password: string) => {
      const { body, headers } = formBody({
        [CSRF_FIELD_NAME]: TEST_CSRF,
        username: "admin",
        password,
        next: "/admin/vaults",
      });
      return new Request("http://hub.test/admin/login", {
        method: "POST",
        headers: { ...headers, cookie: CSRF_COOKIE, "cf-connecting-ip": "203.0.113.42" },
        body,
      });
    };
    // First attempt: correct password → 302. Counts as attempt #1.
    const first = await handleAdminLoginPost(harness.db, buildReq("correct-pw"));
    expect(first.status).toBe(302);
    // Attempts 2–5: wrong password → 401 each.
    for (let i = 2; i <= 5; i++) {
      const r = await handleAdminLoginPost(harness.db, buildReq("wrong"));
      expect(r.status).toBe(401);
    }
    // Attempt 6: rate-limit fires before credential check → 429 + Retry-After.
    const denied = await handleAdminLoginPost(harness.db, buildReq("wrong"));
    expect(denied.status).toBe(429);
    const retryAfter = denied.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    const seconds = Number(retryAfter);
    expect(seconds).toBeGreaterThan(0);
    // Window is 15 min = 900s, so retry-after sits in (0, 900].
    expect(seconds).toBeLessThanOrEqual(900);
  });

  test("rate-limit is per-IP: a different IP can still log in after another's bucket fills", async () => {
    await createUser(harness.db, "admin", "pw");
    const buildReq = (ip: string, password: string) => {
      const { body, headers } = formBody({
        [CSRF_FIELD_NAME]: TEST_CSRF,
        username: "admin",
        password,
        next: "/admin/vaults",
      });
      return new Request("http://hub.test/admin/login", {
        method: "POST",
        headers: { ...headers, cookie: CSRF_COOKIE, "cf-connecting-ip": ip },
        body,
      });
    };
    // Exhaust ip-a's bucket with 5 wrong-password attempts, then confirm 429.
    for (let i = 0; i < 5; i++) {
      await handleAdminLoginPost(harness.db, buildReq("203.0.113.7", "wrong"));
    }
    const aDenied = await handleAdminLoginPost(harness.db, buildReq("203.0.113.7", "wrong"));
    expect(aDenied.status).toBe(429);
    // Different IP: fresh bucket, correct credentials → 302.
    const bOk = await handleAdminLoginPost(harness.db, buildReq("198.51.100.99", "pw"));
    expect(bOk.status).toBe(302);
  });

  test("rate-limit fires before credential check (denied request never touches DB)", async () => {
    // No user exists in the harness DB. First 5 attempts should be 401
    // ("Invalid credentials" — no such user). 6th should be 429 with the
    // rate-limit body, NOT a credential-failure body.
    const buildReq = () => {
      const { body, headers } = formBody({
        [CSRF_FIELD_NAME]: TEST_CSRF,
        username: "ghost",
        password: "x",
        next: "/admin/vaults",
      });
      return new Request("http://hub.test/admin/login", {
        method: "POST",
        headers: { ...headers, cookie: CSRF_COOKIE, "cf-connecting-ip": "203.0.113.99" },
        body,
      });
    };
    for (let i = 0; i < 5; i++) {
      const r = await handleAdminLoginPost(harness.db, buildReq());
      expect(r.status).toBe(401);
    }
    const denied = await handleAdminLoginPost(harness.db, buildReq());
    expect(denied.status).toBe(429);
    expect(await denied.text()).toContain("Too many login attempts");
  });
});

describe("handleAdminLogoutPost (#113)", () => {
  test("rejects when CSRF token doesn't match the cookie", async () => {
    const cookie = await cookieForUser(harness.db, "admin", "pw");
    const { body, headers } = formBody({ [CSRF_FIELD_NAME]: "wrong" });
    const req = new Request("http://hub.test/admin/logout", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAdminLogoutPost(harness.db, req);
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("clears session cookie, deletes session row, and redirects to /login", async () => {
    const user = await createUser(harness.db, "admin", "pw");
    const session = createSession(harness.db, { userId: user.id });
    const cookie = `${CSRF_COOKIE}; ${buildSessionCookie(
      session.id,
      Math.floor(SESSION_TTL_MS / 1000),
    )}`;
    const { body, headers } = formBody({ [CSRF_FIELD_NAME]: TEST_CSRF });
    const req = new Request("http://hub.test/logout", {
      method: "POST",
      headers: { ...headers, cookie },
      body,
    });
    const res = await handleAdminLogoutPost(harness.db, req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("parachute_hub_session=;");
    expect(setCookie).toContain("Max-Age=0");
    expect(findSession(harness.db, session.id)).toBeNull();
  });

  test("idempotent — clears cookie even with no active session", async () => {
    const { body, headers } = formBody({ [CSRF_FIELD_NAME]: TEST_CSRF });
    const req = new Request("http://hub.test/logout", {
      method: "POST",
      headers: { ...headers, cookie: CSRF_COOKIE },
      body,
    });
    const res = await handleAdminLogoutPost(harness.db, req);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.headers.get("set-cookie") ?? "").toContain("parachute_hub_session=;");
  });
});
