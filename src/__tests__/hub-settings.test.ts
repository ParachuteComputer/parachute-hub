/**
 * Tests for hub-local key/value settings (hub#268).
 *
 * Covers the bare KV API (get/set/delete) and the two domain helpers
 * the wizard + oauth handlers consume: setup_expose_mode validation and
 * the first-client auto-approve window (open + check + consume + clear).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS,
  SETUP_EXPOSE_MODES,
  consumeFirstClientAutoApproveWindow,
  deleteSetting,
  getSetting,
  isFirstClientAutoApproveWindowOpen,
  isSetupExposeMode,
  openFirstClientAutoApproveWindow,
  setSetting,
} from "../hub-settings.ts";

describe("hub-settings — bare KV", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-settings-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("getSetting returns undefined for an absent key", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      expect(getSetting(db, "setup_expose_mode")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("setSetting writes a value getSetting reads back", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      setSetting(db, "setup_expose_mode", "tailnet");
      expect(getSetting(db, "setup_expose_mode")).toBe("tailnet");
    } finally {
      db.close();
    }
  });

  test("setSetting overwrites an existing value (UPSERT)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      setSetting(db, "setup_expose_mode", "tailnet");
      setSetting(db, "setup_expose_mode", "public");
      expect(getSetting(db, "setup_expose_mode")).toBe("public");
    } finally {
      db.close();
    }
  });

  test("deleteSetting removes a row + idempotently no-ops on a missing key", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      setSetting(db, "setup_expose_mode", "localhost");
      deleteSetting(db, "setup_expose_mode");
      expect(getSetting(db, "setup_expose_mode")).toBeUndefined();
      // Second delete is a no-op.
      deleteSetting(db, "setup_expose_mode");
      expect(getSetting(db, "setup_expose_mode")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("setSetting updates the updated_at column on every write", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const t1 = new Date("2026-05-19T00:00:00.000Z");
      const t2 = new Date("2026-05-19T00:01:00.000Z");
      setSetting(db, "setup_expose_mode", "localhost", () => t1);
      setSetting(db, "setup_expose_mode", "localhost", () => t2);
      // Re-write with the same value still bumps updated_at — useful
      // for operational polling that wants to distinguish stale vs
      // fresh state.
      const row = db
        .query<{ updated_at: string }, []>(
          "SELECT updated_at FROM hub_settings WHERE key = 'setup_expose_mode'",
        )
        .get();
      expect(row?.updated_at).toBe(t2.toISOString());
    } finally {
      db.close();
    }
  });
});

describe("hub-settings — isSetupExposeMode", () => {
  test("accepts the three canonical values", () => {
    for (const m of SETUP_EXPOSE_MODES) {
      expect(isSetupExposeMode(m)).toBe(true);
    }
  });

  test("rejects anything else (typos, empty, non-string)", () => {
    expect(isSetupExposeMode("local")).toBe(false);
    expect(isSetupExposeMode("LOCALHOST")).toBe(false);
    expect(isSetupExposeMode("")).toBe(false);
    expect(isSetupExposeMode(null)).toBe(false);
    expect(isSetupExposeMode(undefined)).toBe(false);
    expect(isSetupExposeMode(42)).toBe(false);
  });
});

describe("hub-settings — first-client auto-approve window", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-settings-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("window is closed by default (no row)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      expect(isFirstClientAutoApproveWindowOpen(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("openFirstClientAutoApproveWindow opens a window 60 minutes long", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const now = new Date("2026-05-19T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => now);
      const stored = getSetting(db, "pending_first_client_auto_approve_until");
      expect(stored).toBeDefined();
      const parsed = new Date(stored ?? "");
      expect(parsed.getTime() - now.getTime()).toBe(FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS);
    } finally {
      db.close();
    }
  });

  test("isFirstClientAutoApproveWindowOpen → true within window, false after expiry", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const t0 = new Date("2026-05-19T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => t0);
      // 30 minutes in → still open.
      expect(
        isFirstClientAutoApproveWindowOpen(db, () => new Date(t0.getTime() + 30 * 60 * 1000)),
      ).toBe(true);
      // 60 minutes + 1 ms in → closed.
      expect(
        isFirstClientAutoApproveWindowOpen(
          db,
          () => new Date(t0.getTime() + FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS + 1),
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  test("consumeFirstClientAutoApproveWindow consumes the window once, then returns false", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const now = new Date("2026-05-19T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => now);
      // First call consumes.
      expect(consumeFirstClientAutoApproveWindow(db, () => now)).toBe(true);
      // Second call sees no window.
      expect(consumeFirstClientAutoApproveWindow(db, () => now)).toBe(false);
      // The row is cleared.
      expect(getSetting(db, "pending_first_client_auto_approve_until")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("consume returns false when the window has expired (and clears nothing)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const t0 = new Date("2026-05-19T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => t0);
      const past = new Date(t0.getTime() + FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS + 1);
      expect(consumeFirstClientAutoApproveWindow(db, () => past)).toBe(false);
      // Row is still there (no implicit cleanup on expiry — the setting
      // just stops being "open"). A future open() resets it.
      expect(getSetting(db, "pending_first_client_auto_approve_until")).toBeDefined();
    } finally {
      db.close();
    }
  });

  test("malformed timestamp string is treated as closed (not parseable → not open)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      setSetting(db, "pending_first_client_auto_approve_until", "not-a-date");
      expect(isFirstClientAutoApproveWindowOpen(db)).toBe(false);
      expect(consumeFirstClientAutoApproveWindow(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("reopening the window after consume restarts the 60-minute clock", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const t0 = new Date("2026-05-19T00:00:00.000Z");
      openFirstClientAutoApproveWindow(db, () => t0);
      consumeFirstClientAutoApproveWindow(db, () => t0);
      // Re-open at t0 + 90min.
      const t1 = new Date(t0.getTime() + 90 * 60 * 1000);
      openFirstClientAutoApproveWindow(db, () => t1);
      // The new window's expiry is t1 + 60min, not t0 + 60min.
      const stored = getSetting(db, "pending_first_client_auto_approve_until");
      const parsed = new Date(stored ?? "");
      expect(parsed.getTime()).toBe(t1.getTime() + FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS);
    } finally {
      db.close();
    }
  });
});
