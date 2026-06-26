/**
 * `parachute hub set-origin <url>` (onboarding-streamline 2026-06-25,
 * Caddy-direct zero-SSH path).
 *
 * The verb persists the operator's canonical public origin to
 * `hub_settings.hub_origin` from the CLI — closing the "set the issuer without
 * an admin browser session" gap on a headless reverse-proxy box. These tests
 * pin: it writes the row, it validates + canonicalizes the URL (reusing the
 * SPA's `validateHubOrigin`), and it warns-but-allows loopback.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hub, hubSetOrigin } from "../commands/hub.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { getHubOrigin } from "../hub-settings.ts";

describe("parachute hub set-origin", () => {
  let dir: string;
  let log: string[];
  const collect = (line: string) => log.push(line);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-set-origin-"));
    log = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Open the configDir's hub.db and read the persisted origin. */
  function persisted(): string | null {
    const db = openHubDb(hubDbPath(dir));
    try {
      return getHubOrigin(db);
    } finally {
      db.close();
    }
  }

  test("persists a valid public origin to hub_settings.hub_origin", async () => {
    const code = await hubSetOrigin(["https://box.sslip.io"], { configDir: dir, log: collect });
    expect(code).toBe(0);
    expect(persisted()).toBe("https://box.sslip.io");
  });

  test("strips a trailing slash (canonical bare-origin form)", async () => {
    const code = await hubSetOrigin(["https://box.example.com/"], { configDir: dir, log: collect });
    expect(code).toBe(0);
    expect(persisted()).toBe("https://box.example.com");
  });

  test("rejects a non-http(s) scheme without writing", async () => {
    const code = await hubSetOrigin(["ftp://box.example.com"], { configDir: dir, log: collect });
    expect(code).toBe(1);
    expect(persisted()).toBeNull();
  });

  test("rejects a URL with a path without writing", async () => {
    const code = await hubSetOrigin(["https://box.example.com/admin"], {
      configDir: dir,
      log: collect,
    });
    expect(code).toBe(1);
    expect(persisted()).toBeNull();
  });

  test("rejects a bare hostname (no scheme) without writing", async () => {
    const code = await hubSetOrigin(["box.example.com"], { configDir: dir, log: collect });
    expect(code).toBe(1);
    expect(persisted()).toBeNull();
  });

  test("missing the URL argument is a usage error, no write", async () => {
    const code = await hubSetOrigin([], { configDir: dir, log: collect });
    expect(code).toBe(1);
    expect(persisted()).toBeNull();
  });

  test("warns but ALLOWS a loopback origin (dev/test escape hatch)", async () => {
    const code = await hubSetOrigin(["http://127.0.0.1:1939"], { configDir: dir, log: collect });
    expect(code).toBe(0);
    expect(persisted()).toBe("http://127.0.0.1:1939");
    expect(log.some((l) => l.toLowerCase().includes("loopback"))).toBe(true);
  });

  test("prints the restart note so the operator knows running modules need a restart", async () => {
    await hubSetOrigin(["https://box.sslip.io"], { configDir: dir, log: collect });
    const joined = log.join("\n");
    expect(joined).toContain("parachute restart vault");
  });

  test("openDb seam is honored (no touch of the live ~/.parachute)", async () => {
    // Point the seam at a SEPARATE on-disk DB so we can assert (a) the seam was
    // consulted, and (b) the write landed in the seam's DB — never the
    // configDir's default path. (A real Database can't be Proxy-wrapped: Bun's
    // prepared-statement private fields break under a Proxy.)
    const altDir = mkdtempSync(join(tmpdir(), "hub-set-origin-alt-"));
    try {
      let opened = 0;
      const code = await hubSetOrigin(["https://box.sslip.io"], {
        configDir: dir,
        log: collect,
        openDb: () => {
          opened++;
          return openHubDb(hubDbPath(altDir));
        },
      });
      expect(code).toBe(0);
      expect(opened).toBe(1);
      // The write landed in the seam's DB, NOT the configDir's default DB.
      const alt = openHubDb(hubDbPath(altDir));
      try {
        expect(getHubOrigin(alt)).toBe("https://box.sslip.io");
      } finally {
        alt.close();
      }
    } finally {
      rmSync(altDir, { recursive: true, force: true });
    }
  });
});

describe("parachute hub dispatcher", () => {
  test("no subcommand prints help, exits 0", async () => {
    const code = await hub([]);
    expect(code).toBe(0);
  });

  test("--help exits 0", async () => {
    expect(await hub(["--help"])).toBe(0);
  });

  test("unknown subcommand exits 1", async () => {
    expect(await hub(["frobnicate"])).toBe(1);
  });
});
