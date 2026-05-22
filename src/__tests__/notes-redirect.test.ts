/**
 * Tests for the `/notes/*` → `/app/notes/*` redirect helper (Notes-as-app
 * migration Phase 2, parachute-app design doc §16).
 *
 * Covers the path-match predicate, the target-URL builder, the DB-aware
 * opt-out branching, and the throttled logger.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { setNotesRedirectDisabled } from "../hub-settings.ts";
import {
  buildNotesRedirectTarget,
  clearNotesRedirectLogState,
  isLegacyNotesPath,
  logNotesRedirect,
  maybeRedirectNotes,
} from "../notes-redirect.ts";

describe("notes-redirect — isLegacyNotesPath", () => {
  test("matches the bare /notes path", () => {
    expect(isLegacyNotesPath("/notes")).toBe(true);
  });

  test("matches the trailing-slash form /notes/", () => {
    expect(isLegacyNotesPath("/notes/")).toBe(true);
  });

  test("matches a sub-path /notes/sw.js", () => {
    expect(isLegacyNotesPath("/notes/sw.js")).toBe(true);
  });

  test("matches a deep sub-path /notes/foo/bar/baz", () => {
    expect(isLegacyNotesPath("/notes/foo/bar/baz")).toBe(true);
  });

  test("does NOT match unrelated prefix /notesy (no boundary)", () => {
    expect(isLegacyNotesPath("/notesy")).toBe(false);
  });

  test("does NOT match a same-letters-different-mount /notes-archive", () => {
    expect(isLegacyNotesPath("/notes-archive")).toBe(false);
  });

  test("does NOT match an unrelated path like /vault/default/notes", () => {
    // Per-vault content lives under /vault/<name>/* and shouldn't be
    // captured by this matcher even though "notes" appears in the path.
    expect(isLegacyNotesPath("/vault/default/notes")).toBe(false);
  });
});

describe("notes-redirect — buildNotesRedirectTarget", () => {
  test("rewrites the bare path /notes → /app/notes", () => {
    expect(buildNotesRedirectTarget("/notes", "")).toBe("/app/notes");
  });

  test("rewrites the trailing-slash form /notes/ → /app/notes/", () => {
    expect(buildNotesRedirectTarget("/notes/", "")).toBe("/app/notes/");
  });

  test("rewrites a sub-path /notes/sw.js → /app/notes/sw.js", () => {
    expect(buildNotesRedirectTarget("/notes/sw.js", "")).toBe("/app/notes/sw.js");
  });

  test("preserves a single-param query string", () => {
    expect(buildNotesRedirectTarget("/notes/foo", "?q=1")).toBe("/app/notes/foo?q=1");
  });

  test("preserves a multi-param query string verbatim (no re-encoding)", () => {
    expect(buildNotesRedirectTarget("/notes/foo", "?a=1&b=hello%20world")).toBe(
      "/app/notes/foo?a=1&b=hello%20world",
    );
  });

  test("preserves the bare /notes + query (no trailing slash on rewrite)", () => {
    expect(buildNotesRedirectTarget("/notes", "?next=foo")).toBe("/app/notes?next=foo");
  });
});

describe("notes-redirect — maybeRedirectNotes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notes-redirect-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("returns the target URL when the path matches and no DB is configured", () => {
    // Absent DB defaults to redirect-on — the migration-default direction.
    // Operators flipping the opt-out flag have a hub-with-DB; the default
    // doesn't depend on DB readiness.
    expect(maybeRedirectNotes("/notes/foo", "?q=1", undefined)).toBe("/app/notes/foo?q=1");
  });

  test("returns the target URL when the path matches and the flag is absent (default)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      expect(maybeRedirectNotes("/notes/foo", "", db)).toBe("/app/notes/foo");
    } finally {
      db.close();
    }
  });

  test("returns the target URL when the flag is explicitly false (setNotesRedirectDisabled(false))", () => {
    // Writing `false` clears the row, so the result should equal the
    // absent-row case — redirect on.
    const db = openHubDb(hubDbPath(dir));
    try {
      setNotesRedirectDisabled(db, true);
      setNotesRedirectDisabled(db, false);
      expect(maybeRedirectNotes("/notes/foo", "", db)).toBe("/app/notes/foo");
    } finally {
      db.close();
    }
  });

  test("returns undefined when the flag is true (operator opt-out)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      setNotesRedirectDisabled(db, true);
      expect(maybeRedirectNotes("/notes/foo", "", db)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("returns undefined when the path does not match (unrelated prefix)", () => {
    const db = openHubDb(hubDbPath(dir));
    try {
      expect(maybeRedirectNotes("/notesy", "", db)).toBeUndefined();
      expect(maybeRedirectNotes("/admin/vaults", "", db)).toBeUndefined();
      expect(maybeRedirectNotes("/vault/default", "", db)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("notes-redirect — logNotesRedirect (throttled)", () => {
  beforeEach(() => {
    clearNotesRedirectLogState();
  });

  test("logs once on the first hit", () => {
    const lines: string[] = [];
    logNotesRedirect("/notes/foo", "/app/notes/foo", {
      now: () => 1_000_000,
      log: (m) => lines.push(m),
    });
    expect(lines).toEqual(["[notes-migration] redirect /notes/foo → /app/notes/foo"]);
  });

  test("throttles repeated hits to the same path within the window", () => {
    const lines: string[] = [];
    // Five hits within a 10-second span — well inside the 60-second window.
    for (let i = 0; i < 5; i++) {
      logNotesRedirect("/notes/foo", "/app/notes/foo", {
        now: () => 1_000_000 + i * 2_000,
        log: (m) => lines.push(m),
      });
    }
    expect(lines).toHaveLength(1);
  });

  test("re-logs the same path after the window expires", () => {
    const lines: string[] = [];
    logNotesRedirect("/notes/foo", "/app/notes/foo", {
      now: () => 1_000_000,
      log: (m) => lines.push(m),
    });
    // 60_001 ms later → window has rolled, log fires again.
    logNotesRedirect("/notes/foo", "/app/notes/foo", {
      now: () => 1_000_000 + 60_001,
      log: (m) => lines.push(m),
    });
    expect(lines).toHaveLength(2);
  });

  test("logs distinct paths independently (per-path bucket)", () => {
    const lines: string[] = [];
    logNotesRedirect("/notes/foo", "/app/notes/foo", {
      now: () => 1_000_000,
      log: (m) => lines.push(m),
    });
    logNotesRedirect("/notes/bar", "/app/notes/bar", {
      now: () => 1_000_000,
      log: (m) => lines.push(m),
    });
    // Two distinct paths → two log lines despite identical timestamps.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("/notes/foo");
    expect(lines[1]).toContain("/notes/bar");
  });
});
