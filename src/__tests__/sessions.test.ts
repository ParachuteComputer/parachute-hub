import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_LIFETIME_MS,
  buildSessionClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  findSession,
  parseSessionCookie,
  touchSession,
} from "../sessions.ts";
import { createUser } from "../users.ts";

async function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-sessions-"));
  const db = openHubDb(hubDbPath(configDir));
  const user = await createUser(db, "owner", "pw");
  return {
    db,
    userId: user.id,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

describe("createSession + findSession", () => {
  test("round-trips a session", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const s = createSession(db, { userId });
      const found = findSession(db, s.id);
      expect(found?.userId).toBe(userId);
      expect(found?.id).toBe(s.id);
    } finally {
      cleanup();
    }
  });

  test("returns null for unknown id", async () => {
    const { db, cleanup } = await makeDb();
    try {
      expect(findSession(db, "no-such-session")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns null for expired session", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const epoch = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => epoch });
      // Past TTL (24h).
      const later = new Date(epoch.getTime() + 25 * 3600 * 1000);
      expect(findSession(db, s.id, () => later)).toBeNull();
      // Still valid one second before expiry.
      const justBefore = new Date(epoch.getTime() + 24 * 3600 * 1000 - 1000);
      expect(findSession(db, s.id, () => justBefore)?.id).toBe(s.id);
    } finally {
      cleanup();
    }
  });
});

describe("touchSession (sliding renewal)", () => {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;

  test("slides expires_at forward to now + TTL", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      // Original expiry: t0 + 24h.
      expect(new Date(s.expiresAt).getTime()).toBe(t0.getTime() + DAY);
      // Touch 1h later → expiry becomes (t0 + 1h) + 24h.
      const t1 = new Date(t0.getTime() + HOUR);
      touchSession(db, s.id, () => t1);
      const found = findSession(db, s.id, () => t1);
      expect(new Date(found?.expiresAt ?? 0).getTime()).toBe(t1.getTime() + DAY);
    } finally {
      cleanup();
    }
  });

  test("a touched session outlives the ORIGINAL 24h expiry", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      // Activity at +12h slides expiry to +36h.
      touchSession(db, s.id, () => new Date(t0.getTime() + 12 * HOUR));
      // At +30h — PAST the original +24h — the session is still alive.
      const at30h = new Date(t0.getTime() + 30 * HOUR);
      expect(findSession(db, s.id, () => at30h)?.id).toBe(s.id);
    } finally {
      cleanup();
    }
  });

  test("an UNtouched session still expires at the original 24h", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      // No touch — at +25h it's gone (today's absolute-TTL behavior preserved
      // for idle / closed tabs that stop re-minting).
      const at25h = new Date(t0.getTime() + 25 * HOUR);
      expect(findSession(db, s.id, () => at25h)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("caps at created_at + SESSION_MAX_LIFETIME_MS (sliding can't run forever)", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      const ceiling = t0.getTime() + SESSION_MAX_LIFETIME_MS;
      // A touch near the ceiling would slide to now + 24h, but the cap pins it.
      const nearCeiling = new Date(ceiling - HOUR); // raw slide would be ceiling + 23h
      touchSession(db, s.id, () => nearCeiling);
      const found = findSession(db, s.id, () => nearCeiling);
      expect(new Date(found?.expiresAt ?? 0).getTime()).toBe(ceiling);
      // Past the ceiling the session is dead even though it was just "active".
      expect(findSession(db, s.id, () => new Date(ceiling + 1000))).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("no-op on an unknown session id (does not throw)", async () => {
    const { db, cleanup } = await makeDb();
    try {
      expect(() => touchSession(db, "no-such-session")).not.toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("deleteSession", () => {
  test("removes the session row", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const s = createSession(db, { userId });
      deleteSession(db, s.id);
      expect(findSession(db, s.id)).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("buildSessionCookie", () => {
  test("emits the expected attributes (default secure)", () => {
    const v = buildSessionCookie("abc", 86400);
    expect(v).toContain(`${SESSION_COOKIE_NAME}=abc`);
    expect(v).toContain("HttpOnly");
    expect(v).toContain("Secure");
    expect(v).toContain("SameSite=Lax");
    expect(v).toContain("Path=/");
    expect(v).not.toContain("Path=/oauth");
    expect(v).toContain("Max-Age=86400");
  });

  // Bug 1 (rc.5 → rc.6) regression: session cookies minted over plain
  // HTTP must NOT carry Secure or browsers drop them, leaving the
  // operator un-signed-in on the very next request.
  test("omits Secure when secure: false (HTTP localhost)", () => {
    const v = buildSessionCookie("abc", 86400, { secure: false });
    expect(v).toContain(`${SESSION_COOKIE_NAME}=abc`);
    expect(v).toContain("HttpOnly");
    expect(v).not.toContain("Secure");
    expect(v).toContain("SameSite=Lax");
  });

  test("keeps Secure when secure: true (explicit)", () => {
    const v = buildSessionCookie("abc", 86400, { secure: true });
    expect(v).toContain("Secure");
  });
});

describe("buildSessionClearCookie", () => {
  test("emits Max-Age=0 (default secure)", () => {
    const v = buildSessionClearCookie();
    expect(v).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(v).toContain("Max-Age=0");
    expect(v).toContain("Secure");
    expect(v).toContain("Path=/");
    expect(v).not.toContain("Path=/oauth");
  });

  test("omits Secure when secure: false (HTTP localhost)", () => {
    const v = buildSessionClearCookie({ secure: false });
    expect(v).not.toContain("Secure");
    expect(v).toContain("Max-Age=0");
  });
});

describe("parseSessionCookie", () => {
  test("extracts the session id from a Cookie header", () => {
    expect(parseSessionCookie(`${SESSION_COOKIE_NAME}=xyz`)).toBe("xyz");
    expect(parseSessionCookie(`other=foo; ${SESSION_COOKIE_NAME}=xyz; bar=baz`)).toBe("xyz");
  });
  test("returns null when absent or empty", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie("")).toBeNull();
    expect(parseSessionCookie("other=foo")).toBeNull();
  });
});
