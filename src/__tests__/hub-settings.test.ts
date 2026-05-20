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
  DEFAULT_MODULE_INSTALL_CHANNEL,
  FIRST_CLIENT_AUTO_APPROVE_WINDOW_MS,
  MODULE_INSTALL_CHANNELS,
  PARACHUTE_MODULE_CHANNEL_ENV,
  SETUP_EXPOSE_MODES,
  consumeFirstClientAutoApproveWindow,
  deleteSetting,
  getModuleInstallChannel,
  getSetting,
  isFirstClientAutoApproveWindowOpen,
  isModuleInstallChannel,
  isSetupExposeMode,
  openFirstClientAutoApproveWindow,
  setModuleInstallChannel,
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

describe("hub-settings — isModuleInstallChannel", () => {
  test("accepts the two canonical values", () => {
    for (const c of MODULE_INSTALL_CHANNELS) {
      expect(isModuleInstallChannel(c)).toBe(true);
    }
    expect(isModuleInstallChannel("latest")).toBe(true);
    expect(isModuleInstallChannel("rc")).toBe(true);
  });

  test("rejects anything else (typos, empty, non-string, case-mismatch)", () => {
    expect(isModuleInstallChannel("LATEST")).toBe(false);
    expect(isModuleInstallChannel("Latest")).toBe(false);
    expect(isModuleInstallChannel("stable")).toBe(false);
    expect(isModuleInstallChannel("beta")).toBe(false);
    expect(isModuleInstallChannel("")).toBe(false);
    expect(isModuleInstallChannel(null)).toBe(false);
    expect(isModuleInstallChannel(undefined)).toBe(false);
    expect(isModuleInstallChannel(42)).toBe(false);
  });
});

describe("hub-settings — module install channel bootstrap", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-settings-channel-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("first read with no env + no row seeds + returns the default (latest)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      // Empty env — no PARACHUTE_MODULE_CHANNEL.
      const channel = getModuleInstallChannel(db, { env: {} });
      expect(channel).toBe(DEFAULT_MODULE_INSTALL_CHANNEL);
      expect(channel).toBe("latest");
      // The row is now seeded.
      expect(getSetting(db, "module_install_channel")).toBe("latest");
    } finally {
      db.close();
    }
  });

  test("first read with PARACHUTE_MODULE_CHANNEL=rc seeds with rc", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const channel = getModuleInstallChannel(db, {
        env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "rc" },
      });
      expect(channel).toBe("rc");
      expect(getSetting(db, "module_install_channel")).toBe("rc");
    } finally {
      db.close();
    }
  });

  test("first read with PARACHUTE_MODULE_CHANNEL=latest seeds with latest", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const channel = getModuleInstallChannel(db, {
        env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "latest" },
      });
      expect(channel).toBe("latest");
      expect(getSetting(db, "module_install_channel")).toBe("latest");
    } finally {
      db.close();
    }
  });

  test("invalid PARACHUTE_MODULE_CHANNEL warns + falls back to latest", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const warns: string[] = [];
      const channel = getModuleInstallChannel(db, {
        env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "stable" },
        warn: (msg) => warns.push(msg),
      });
      expect(channel).toBe("latest");
      expect(getSetting(db, "module_install_channel")).toBe("latest");
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatch(/PARACHUTE_MODULE_CHANNEL="stable"/);
      expect(warns[0]).toMatch(/not a valid channel/);
    } finally {
      db.close();
    }
  });

  test("empty PARACHUTE_MODULE_CHANNEL is treated as unset (no warn)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const warns: string[] = [];
      const channel = getModuleInstallChannel(db, {
        env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "" },
        warn: (msg) => warns.push(msg),
      });
      expect(channel).toBe("latest");
      expect(warns).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("once seeded, env var is ignored on subsequent reads", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      // First read seeds with rc.
      getModuleInstallChannel(db, { env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "rc" } });
      // Second read with a different env value still returns the seeded value.
      const channel = getModuleInstallChannel(db, {
        env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "latest" },
      });
      expect(channel).toBe("rc");
      // And with no env at all.
      expect(getModuleInstallChannel(db, { env: {} })).toBe("rc");
    } finally {
      db.close();
    }
  });

  test("setModuleInstallChannel persists the new value, subsequent reads return it", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      // Seed with rc via env.
      getModuleInstallChannel(db, { env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "rc" } });
      // Admin toggles to latest.
      setModuleInstallChannel(db, "latest");
      expect(getModuleInstallChannel(db, { env: {} })).toBe("latest");
      // And back to rc — no env needed.
      setModuleInstallChannel(db, "rc");
      expect(getModuleInstallChannel(db, { env: {} })).toBe("rc");
    } finally {
      db.close();
    }
  });

  test("corrupted row falls back to latest silently (no throw)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      // Simulate a manual sqlite edit / schema drift / external write.
      setSetting(db, "module_install_channel", "bogus");
      expect(getModuleInstallChannel(db, { env: {} })).toBe("latest");
    } finally {
      db.close();
    }
  });
});
