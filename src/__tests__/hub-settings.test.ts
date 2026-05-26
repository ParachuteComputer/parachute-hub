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
  PARACHUTE_INSTALL_CHANNEL_ENV,
  PARACHUTE_MODULE_CHANNEL_ENV,
  SETUP_EXPOSE_MODES,
  consumeFirstClientAutoApproveWindow,
  deleteSetting,
  getHubOrigin,
  getModuleInstallChannel,
  getSetting,
  isFirstClientAutoApproveWindowOpen,
  isModuleInstallChannel,
  isNotesRedirectDisabled,
  isSetupExposeMode,
  openFirstClientAutoApproveWindow,
  setHubOrigin,
  setModuleInstallChannel,
  setNotesRedirectDisabled,
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

  test("env=rc returns rc (env shadows DB; no auto-write to DB per #137 redesign)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const channel = getModuleInstallChannel(db, {
        env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "rc" },
      });
      expect(channel).toBe("rc");
      // DB stays empty — env wins on read without persisting (so a later
      // SPA toggle can hold a different value as the "DB authoritative
      // when env is unset" fallback). Pre-#137 the env value was written
      // to DB; the new behavior preserves operator-write intent.
      expect(getSetting(db, "module_install_channel")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("env=latest returns latest (env shadows DB; no auto-write)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      const channel = getModuleInstallChannel(db, {
        env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "latest" },
      });
      expect(channel).toBe("latest");
      expect(getSetting(db, "module_install_channel")).toBeUndefined();
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
      // Invalid env value → warn fires, env contribution is discarded, falls
      // through to DB (none) → default. DB seeded with default since neither
      // env nor DB had a usable value.
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

  test("env wins on every read — DB no longer authoritative when env is set (bug #137)", () => {
    // Updated 2026-05-25: precedence flipped from "DB after first seed" to
    // "env always wins when set." Operator on a container platform expects
    // setting PARACHUTE_INSTALL_CHANNEL to take effect on the next request,
    // not require an admin SPA toggle to "reset" the DB. Aaron caught the
    // prior behavior on his Render deploy (set env=rc, container restarted,
    // UI still showed `latest` because DB had been seeded with the default
    // at first boot before he set the env var).
    const db = openHubDb(hubDbPath(dir));
    try {
      // First read with rc — DB seeds with rc.
      getModuleInstallChannel(db, { env: { [PARACHUTE_INSTALL_CHANNEL_ENV]: "rc" } });
      // Second read with a different env value returns the NEW env value
      // (env wins over the previously-seeded DB row).
      expect(
        getModuleInstallChannel(db, {
          env: { [PARACHUTE_INSTALL_CHANNEL_ENV]: "latest" },
        }),
      ).toBe("latest");
      // With env unset, DB falls through and returns whatever was last
      // written (latest from the previous call's idempotent sync).
      expect(getModuleInstallChannel(db, { env: {} })).toBe("latest");
    } finally {
      db.close();
    }
  });

  test("both env var names honored — PARACHUTE_INSTALL_CHANNEL preferred, PARACHUTE_MODULE_CHANNEL back-compat (bug #137)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      // PARACHUTE_INSTALL_CHANNEL — canonical name (matches install.ts).
      expect(
        getModuleInstallChannel(db, { env: { [PARACHUTE_INSTALL_CHANNEL_ENV]: "rc" } }),
      ).toBe("rc");
      // PARACHUTE_MODULE_CHANNEL — legacy alias, still recognized.
      const db2 = openHubDb(join(mkdtempSync(join(tmpdir(), "phub-hsalt-")), "hub.db"));
      try {
        expect(
          getModuleInstallChannel(db2, { env: { [PARACHUTE_MODULE_CHANNEL_ENV]: "rc" } }),
        ).toBe("rc");
      } finally {
        db2.close();
      }
      // When both are set, INSTALL_CHANNEL wins (operator-facing canonical).
      const db3 = openHubDb(join(mkdtempSync(join(tmpdir(), "phub-hsalt-")), "hub.db"));
      try {
        expect(
          getModuleInstallChannel(db3, {
            env: {
              [PARACHUTE_INSTALL_CHANNEL_ENV]: "rc",
              [PARACHUTE_MODULE_CHANNEL_ENV]: "latest",
            },
          }),
        ).toBe("rc");
      } finally {
        db3.close();
      }
    } finally {
      db.close();
    }
  });

  test("setModuleInstallChannel persists; reads return it when env unset", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      // No env: write via setModuleInstallChannel, read returns it.
      setModuleInstallChannel(db, "rc");
      expect(getModuleInstallChannel(db, { env: {} })).toBe("rc");
      setModuleInstallChannel(db, "latest");
      expect(getModuleInstallChannel(db, { env: {} })).toBe("latest");
    } finally {
      db.close();
    }
  });

  test("SPA toggle is shadowed when env is set (env-wins trade-off)", () => {
    // When the operator sets PARACHUTE_INSTALL_CHANNEL in their platform
    // env, the admin SPA's channel-toggle effectively no-ops on the read
    // path — writes still go through (so the DB stays in sync if env is
    // later unset), but the env-set value wins on read. This trade-off is
    // intentional: container env is the canonical source for operators on
    // platforms like Render. Operators who want SPA-driven channel should
    // unset the env.
    const db = openHubDb(hubDbPath(dir));
    try {
      // Env says rc.
      const env = { [PARACHUTE_INSTALL_CHANNEL_ENV]: "rc" };
      expect(getModuleInstallChannel(db, { env })).toBe("rc");
      // SPA "toggles" to latest. Write succeeds.
      setModuleInstallChannel(db, "latest");
      // Read still returns rc — env wins.
      expect(getModuleInstallChannel(db, { env })).toBe("rc");
      // If env is later unset, the DB value (latest) takes over.
      expect(getModuleInstallChannel(db, { env: {} })).toBe("latest");
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

describe("hub-settings — hub_origin (hub#298)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-settings-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("getHubOrigin returns null when no row is present", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      expect(getHubOrigin(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("setHubOrigin then getHubOrigin round-trips the value", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      setHubOrigin(db, "https://hub.example.com");
      expect(getHubOrigin(db)).toBe("https://hub.example.com");
    } finally {
      db.close();
    }
  });

  test("setHubOrigin overwrites an existing value", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      setHubOrigin(db, "https://hub.example.com");
      setHubOrigin(db, "https://hub.other.example");
      expect(getHubOrigin(db)).toBe("https://hub.other.example");
    } finally {
      db.close();
    }
  });

  test("setHubOrigin(null) clears the row → getHubOrigin returns null", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      setHubOrigin(db, "https://hub.example.com");
      setHubOrigin(db, null);
      expect(getHubOrigin(db)).toBeNull();
      // Idempotent — a second clear on an already-absent row is a no-op.
      setHubOrigin(db, null);
      expect(getHubOrigin(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  test('setHubOrigin("") is treated as null (no falsy-row footgun)', () => {
    // An empty string would be a useless issuer + would cause source
    // attribution to lie ("from settings" while no real value).
    // Normalize at the write layer.
    const db = openHubDb(hubDbPath(dir));
    try {
      setHubOrigin(db, "https://hub.example.com");
      setHubOrigin(db, "");
      expect(getHubOrigin(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("does not auto-seed from env (unlike module_install_channel)", () => {
    // The env var (PARACHUTE_HUB_ORIGIN) is a separate precedence layer
    // in resolveIssuer (env wins when no settings row). Auto-seeding
    // would collapse env → settings and lose the source attribution
    // the SPA exposes ("from env" vs "from settings"). Verify no row
    // appears just from reading.
    const prior = process.env.PARACHUTE_HUB_ORIGIN;
    process.env.PARACHUTE_HUB_ORIGIN = "https://hub.from-env.example";
    try {
      const db = openHubDb(hubDbPath(dir));
      try {
        expect(getHubOrigin(db)).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      if (prior === undefined) {
        // Bun's process.env supports the `[key]: undefined` shape
        // (biome's noDelete rule preferred this over `delete`).
        process.env.PARACHUTE_HUB_ORIGIN = undefined;
      } else {
        process.env.PARACHUTE_HUB_ORIGIN = prior;
      }
    }
  });
});

describe("hub-settings — notes_redirect_disabled (parachute-app §16)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-settings-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("isNotesRedirectDisabled defaults to false when no row is present", () => {
    // Migration-default direction: absent row = redirect on.
    const db = openHubDb(hubDbPath(dir));
    try {
      expect(isNotesRedirectDisabled(db)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("setNotesRedirectDisabled(true) flips the flag to true", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      setNotesRedirectDisabled(db, true);
      expect(isNotesRedirectDisabled(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("setNotesRedirectDisabled(false) clears the row → reads as false again", () => {
    // Passing false clears the row rather than writing "false" — the
    // absent-row state is the canonical redirect-on default.
    const db = openHubDb(hubDbPath(dir));
    try {
      setNotesRedirectDisabled(db, true);
      setNotesRedirectDisabled(db, false);
      expect(isNotesRedirectDisabled(db)).toBe(false);
      // The underlying row is actually gone, not stamped with "false".
      expect(getSetting(db, "notes_redirect_disabled")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("any non-'true' value parses as redirect-on (corruption-resistant)", () => {
    // The KV table is TEXT-typed, so a manual sqlite edit or a future
    // schema drift could land an unexpected value. Read-side strictness
    // means we only opt-out on the literal "true" — the migration-default
    // direction is sticky.
    const db = openHubDb(hubDbPath(dir));
    try {
      setSetting(db, "notes_redirect_disabled", "yes");
      expect(isNotesRedirectDisabled(db)).toBe(false);
      setSetting(db, "notes_redirect_disabled", "1");
      expect(isNotesRedirectDisabled(db)).toBe(false);
      setSetting(db, "notes_redirect_disabled", "false");
      expect(isNotesRedirectDisabled(db)).toBe(false);
      setSetting(db, "notes_redirect_disabled", "TRUE");
      expect(isNotesRedirectDisabled(db)).toBe(false);
    } finally {
      db.close();
    }
  });
});
