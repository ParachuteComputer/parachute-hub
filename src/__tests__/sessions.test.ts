import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  SESSION_COOKIE_NAME,
  SESSION_SLIDE_THRESHOLD_MS,
  SESSION_TTL_MS,
  buildSessionClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  findSession,
  parseSessionCookie,
  shouldSlideSession,
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
      // Past TTL (90 days).
      const later = new Date(epoch.getTime() + SESSION_TTL_MS + 3600 * 1000);
      expect(findSession(db, s.id, () => later)).toBeNull();
      // Still valid one second before expiry.
      const justBefore = new Date(epoch.getTime() + SESSION_TTL_MS - 1000);
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
      // Original expiry: t0 + 90d.
      expect(new Date(s.expiresAt).getTime()).toBe(t0.getTime() + SESSION_TTL_MS);
      // Touch 1h later → expiry becomes (t0 + 1h) + 90d.
      const t1 = new Date(t0.getTime() + HOUR);
      touchSession(db, s.id, () => t1);
      const found = findSession(db, s.id, () => t1);
      expect(new Date(found?.expiresAt ?? 0).getTime()).toBe(t1.getTime() + SESSION_TTL_MS);
    } finally {
      cleanup();
    }
  });

  test("a touched session outlives the ORIGINAL 90d expiry", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      // Activity at +45d slides expiry to +135d.
      touchSession(db, s.id, () => new Date(t0.getTime() + 45 * DAY));
      // At +100d — PAST the original +90d — the session is still alive.
      const at100d = new Date(t0.getTime() + 100 * DAY);
      expect(findSession(db, s.id, () => at100d)?.id).toBe(s.id);
    } finally {
      cleanup();
    }
  });

  test("an UNtouched session still expires at the original 90d", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      // No touch — one day past the 90d TTL it's gone (idle / closed tabs
      // that stop re-minting still lapse at the full TTL).
      const past = new Date(t0.getTime() + SESSION_TTL_MS + DAY);
      expect(findSession(db, s.id, () => past)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("NO ceiling (Q4) — an actively-touched session rolls forward indefinitely", async () => {
    // The old SESSION_MAX_LIFETIME_MS (30d) absolute cap is gone: repeatedly
    // touching a session keeps sliding its expiry to now + 90d with no upper
    // bound, matching cloud's rolling posture (an idle session still lapses
    // at the TTL; an active one never does).
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      // Touch well past where the old 30-day ceiling would have pinned it.
      const farOut = new Date(t0.getTime() + 200 * DAY);
      touchSession(db, s.id, () => farOut);
      const found = findSession(db, s.id, () => farOut);
      expect(new Date(found?.expiresAt ?? 0).getTime()).toBe(farOut.getTime() + SESSION_TTL_MS);
      // Still alive nearly 90 more days out, right up to the fresh slide's TTL.
      const stillAlive = new Date(farOut.getTime() + SESSION_TTL_MS - DAY);
      expect(findSession(db, s.id, () => stillAlive)?.id).toBe(s.id);
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

describe("shouldSlideSession (bounded slide, G3 twin)", () => {
  test("false for a freshly-created session (full TTL remaining)", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      expect(shouldSlideSession(s, () => t0)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("false just before crossing the slide threshold", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      // Elapsed just UNDER the threshold (30d) → remaining life still above
      // (TTL - threshold) → not yet due to slide.
      const justBefore = new Date(t0.getTime() + SESSION_SLIDE_THRESHOLD_MS - 1000);
      expect(shouldSlideSession(s, () => justBefore)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("true once remaining life drops below the slide threshold", async () => {
    const { db, userId, cleanup } = await makeDb();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      const s = createSession(db, { userId, now: () => t0 });
      // Elapsed just OVER the threshold (30d) → remaining life below
      // (TTL - threshold) → due to slide.
      const justAfter = new Date(t0.getTime() + SESSION_SLIDE_THRESHOLD_MS + 1000);
      expect(shouldSlideSession(s, () => justAfter)).toBe(true);
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
