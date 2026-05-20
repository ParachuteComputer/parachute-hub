import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  SESSION_COOKIE_NAME,
  buildSessionClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  findSession,
  parseSessionCookie,
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
