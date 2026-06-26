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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hub, hubSetOrigin, rewriteCaddyfileHost } from "../commands/hub.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { getHubOrigin } from "../hub-settings.ts";
import type { CommandResult } from "../tailscale/run.ts";

describe("parachute hub set-origin", () => {
  let dir: string;
  let log: string[];
  const collect = (line: string) => log.push(line);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-set-origin-"));
    log = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Hermetic seams for the non-DB side effects: point the Caddyfile at a
   * non-existent path (→ "no managed Caddyfile" branch), and mock the reload
   * Runner + module restart so NOTHING real reloads Caddy or drives the live
   * supervisor. The DB write is the only real side effect (scoped to the temp
   * configDir). Tests that exercise Caddy specifically override these.
   */
  function safeSeams(): {
    configDir: string;
    log: (line: string) => void;
    caddyfilePath: string;
    run: (cmd: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
    restartModules: () => Promise<number>;
  } {
    return {
      configDir: dir,
      log: collect,
      caddyfilePath: join(dir, "no-caddyfile-here"),
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      restartModules: async () => 0,
    };
  }

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
    const code = await hubSetOrigin(["https://box.sslip.io"], safeSeams());
    expect(code).toBe(0);
    expect(persisted()).toBe("https://box.sslip.io");
  });

  test("strips a trailing slash (canonical bare-origin form)", async () => {
    const code = await hubSetOrigin(["https://box.example.com/"], safeSeams());
    expect(code).toBe(0);
    expect(persisted()).toBe("https://box.example.com");
  });

  test("rejects a non-http(s) scheme without writing", async () => {
    const code = await hubSetOrigin(["ftp://box.example.com"], safeSeams());
    expect(code).toBe(1);
    expect(persisted()).toBeNull();
  });

  test("rejects a URL with a path without writing", async () => {
    const code = await hubSetOrigin(["https://box.example.com/admin"], safeSeams());
    expect(code).toBe(1);
    expect(persisted()).toBeNull();
  });

  test("rejects a bare hostname (no scheme) without writing", async () => {
    const code = await hubSetOrigin(["box.example.com"], safeSeams());
    expect(code).toBe(1);
    expect(persisted()).toBeNull();
  });

  test("missing the URL argument is a usage error, no write", async () => {
    const code = await hubSetOrigin([], safeSeams());
    expect(code).toBe(1);
    expect(persisted()).toBeNull();
  });

  test("warns but ALLOWS a loopback origin (dev/test escape hatch)", async () => {
    const code = await hubSetOrigin(["http://127.0.0.1:1939"], safeSeams());
    expect(code).toBe(0);
    expect(persisted()).toBe("http://127.0.0.1:1939");
    expect(log.some((l) => l.toLowerCase().includes("loopback"))).toBe(true);
  });

  test("prints a restart instruction when no managed Caddyfile is present", async () => {
    let restartCalls = 0;
    await hubSetOrigin(["https://box.sslip.io"], {
      ...safeSeams(),
      restartModules: async () => {
        restartCalls++;
        return 1; // simulate restart not landing → prints the manual hint
      },
    });
    const joined = log.join("\n");
    expect(restartCalls).toBe(1);
    expect(joined).toContain("parachute restart");
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
        ...safeSeams(),
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

// --- rewriteCaddyfileHost (pure) -----------------------------------------

const MANAGED_CADDYFILE = `# Managed by Parachute install (install/digitalocean.sh). Re-run to refresh.
old.example.com {
    reverse_proxy 127.0.0.1:1939 {
        # Strip client-supplied layer-spoofing trust signals — only a real
        # Cloudflare / Tailscale edge may set these; this Caddy is the edge.
        header_up -Cf-Ray
        header_up -Cf-Connecting-Ip
        header_up -Tailscale-Funnel-Request
        header_up -Tailscale-User-Login
    }
}
`;

describe("rewriteCaddyfileHost", () => {
  test("rewrites ONLY the site-address line, body + header strips intact", () => {
    const r = rewriteCaddyfileHost(MANAGED_CADDYFILE, "new.example.com");
    expect(r.kind).toBe("rewritten");
    if (r.kind !== "rewritten") throw new Error("unreachable");
    expect(r.content).toContain("new.example.com {");
    expect(r.content).not.toContain("old.example.com");
    // The reverse_proxy body + the security-load-bearing header strips survive.
    expect(r.content).toContain("reverse_proxy 127.0.0.1:1939 {");
    expect(r.content).toContain("header_up -Cf-Ray");
    expect(r.content).toContain("header_up -Cf-Connecting-Ip");
    expect(r.content).toContain("header_up -Tailscale-Funnel-Request");
    expect(r.content).toContain("header_up -Tailscale-User-Login");
    // Only one line changed (host line); everything else byte-identical.
    const before = MANAGED_CADDYFILE.split("\n");
    const after = r.content.split("\n");
    const diff = before.filter((l, i) => l !== after[i]);
    expect(diff).toEqual(["old.example.com {"]);
  });

  test("idempotent — host already matches → unchanged (no reload needed)", () => {
    expect(rewriteCaddyfileHost(MANAGED_CADDYFILE, "old.example.com").kind).toBe("unchanged");
  });

  test("an unmanaged Caddyfile (no marker) → not-managed", () => {
    const unmanaged = "example.com {\n    reverse_proxy 127.0.0.1:1939\n}\n";
    expect(rewriteCaddyfileHost(unmanaged, "new.example.com").kind).toBe("not-managed");
  });

  test("marker present but no site-opener line (hand-edited) → customized", () => {
    const odd = "# Managed by Parachute install (foo)\nreverse_proxy 127.0.0.1:1939\n";
    expect(rewriteCaddyfileHost(odd, "new.example.com").kind).toBe("customized");
  });

  test("injection-shaped host can't break the rewrite (host comes from validated URL)", () => {
    // The caller only ever passes `new URL(origin).host` from an already-validated
    // origin, so a host with spaces / braces never reaches here — but even a weird
    // token is written verbatim as the bare site address (no shell, plain file edit).
    const r = rewriteCaddyfileHost(MANAGED_CADDYFILE, "weird.host:8443");
    expect(r.kind).toBe("rewritten");
    if (r.kind !== "rewritten") throw new Error("unreachable");
    expect(r.content).toContain("weird.host:8443 {");
    // The body is still intact — the regex only touched the site opener.
    expect(r.content).toContain("header_up -Cf-Ray");
  });
});

// --- set-origin Caddy rewrite + reload + restart -------------------------

const okResult = (): CommandResult => ({ code: 0, stdout: "", stderr: "" });

describe("parachute hub set-origin — Caddy automation", () => {
  let dir: string;
  let log: string[];
  const collect = (line: string) => log.push(line);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-set-origin-caddy-"));
    log = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function caddyFixture(): string {
    const p = join(dir, "Caddyfile");
    writeFileSync(p, MANAGED_CADDYFILE);
    return p;
  }

  test("managed Caddyfile → host line rewritten, reload + restart invoked (mocked)", async () => {
    const caddyfilePath = caddyFixture();
    const runCalls: ReadonlyArray<string>[] = [];
    let restartCalls = 0;
    const code = await hubSetOrigin(["https://new.example.com"], {
      configDir: dir,
      log: collect,
      caddyfilePath,
      getuid: () => 0, // simulate root so the rewrite path runs
      run: async (cmd) => {
        runCalls.push(cmd);
        return okResult();
      },
      restartModules: async () => {
        restartCalls++;
        return 0;
      },
    });
    expect(code).toBe(0);
    // DB origin persisted.
    const db = openHubDb(hubDbPath(dir));
    try {
      expect(getHubOrigin(db)).toBe("https://new.example.com");
    } finally {
      db.close();
    }
    // Host line rewritten on disk; body + header strips preserved.
    const written = readFileSync(caddyfilePath, "utf8");
    expect(written).toContain("new.example.com {");
    expect(written).not.toContain("old.example.com");
    expect(written).toContain("header_up -Cf-Connecting-Ip");
    // Reload + restart both invoked.
    expect(runCalls).toContainEqual(["systemctl", "reload", "caddy"]);
    expect(restartCalls).toBe(1);
  });

  test("NO managed Caddyfile → origin persisted, manual steps printed, reload/restart NOT invoked", async () => {
    const runCalls: ReadonlyArray<string>[] = [];
    let restartCalls = 0;
    const code = await hubSetOrigin(["https://new.example.com"], {
      configDir: dir,
      log: collect,
      caddyfilePath: join(dir, "does-not-exist"),
      getuid: () => 0,
      run: async (cmd) => {
        runCalls.push(cmd);
        return okResult();
      },
      restartModules: async () => {
        restartCalls++;
        return 0;
      },
    });
    expect(code).toBe(0);
    const db = openHubDb(hubDbPath(dir));
    try {
      expect(getHubOrigin(db)).toBe("https://new.example.com");
    } finally {
      db.close();
    }
    // No managed Caddyfile → reload never runs. (restart still runs by design;
    // it's the module-propagation step, independent of Caddy.)
    expect(runCalls).toEqual([]);
    expect(restartCalls).toBe(1);
    expect(log.join("\n")).toContain("No Parachute-managed Caddyfile");
  });

  test("--no-caddy → Caddy untouched (no read/write/reload), restart still runs", async () => {
    const caddyfilePath = caddyFixture();
    const runCalls: ReadonlyArray<string>[] = [];
    let restartCalls = 0;
    const code = await hubSetOrigin(["https://new.example.com", "--no-caddy"], {
      configDir: dir,
      log: collect,
      caddyfilePath,
      getuid: () => 0,
      run: async (cmd) => {
        runCalls.push(cmd);
        return okResult();
      },
      restartModules: async () => {
        restartCalls++;
        return 0;
      },
    });
    expect(code).toBe(0);
    // Caddyfile left byte-identical (not rewritten).
    expect(readFileSync(caddyfilePath, "utf8")).toBe(MANAGED_CADDYFILE);
    expect(runCalls).toEqual([]);
    expect(restartCalls).toBe(1);
    expect(log.join("\n")).toContain("--no-caddy");
  });

  test("--no-restart → modules not restarted", async () => {
    const caddyfilePath = caddyFixture();
    let restartCalls = 0;
    const code = await hubSetOrigin(["https://new.example.com", "--no-restart"], {
      configDir: dir,
      log: collect,
      caddyfilePath,
      getuid: () => 0,
      run: async () => okResult(),
      restartModules: async () => {
        restartCalls++;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(restartCalls).toBe(0);
    expect(log.join("\n")).toContain("--no-restart");
  });

  test("non-root with a managed Caddyfile → graceful, non-fatal, NOT rewritten/reloaded", async () => {
    const caddyfilePath = caddyFixture();
    const runCalls: ReadonlyArray<string>[] = [];
    const code = await hubSetOrigin(["https://new.example.com"], {
      configDir: dir,
      log: collect,
      caddyfilePath,
      getuid: () => 1000, // non-root
      run: async (cmd) => {
        runCalls.push(cmd);
        return okResult();
      },
      restartModules: async () => 0,
    });
    expect(code).toBe(0); // non-fatal: origin still persisted
    // File untouched, reload never attempted.
    expect(readFileSync(caddyfilePath, "utf8")).toBe(MANAGED_CADDYFILE);
    expect(runCalls).toEqual([]);
    expect(log.join("\n").toLowerCase()).toContain("not running as root");
  });

  test("reload fails → graceful, non-fatal, file still rewritten, manual reload hinted", async () => {
    const caddyfilePath = caddyFixture();
    const code = await hubSetOrigin(["https://new.example.com"], {
      configDir: dir,
      log: collect,
      caddyfilePath,
      getuid: () => 0,
      run: async () => ({ code: 1, stdout: "", stderr: "caddy: config error" }),
      restartModules: async () => 0,
    });
    expect(code).toBe(0); // non-fatal
    expect(readFileSync(caddyfilePath, "utf8")).toContain("new.example.com {");
    const joined = log.join("\n");
    expect(joined).toContain("reload");
    expect(joined).toContain("caddy: config error");
  });

  test("restart fails → graceful, non-fatal, prints the manual restart hint", async () => {
    const caddyfilePath = caddyFixture();
    const code = await hubSetOrigin(["https://new.example.com"], {
      configDir: dir,
      log: collect,
      caddyfilePath,
      getuid: () => 0,
      run: async () => okResult(),
      restartModules: async () => 1, // restart reports failure
    });
    expect(code).toBe(0); // non-fatal — origin persisted, Caddy reloaded
    expect(log.join("\n")).toContain("parachute restart");
  });

  test("a managed Caddyfile already on the new host → unchanged, reload skipped", async () => {
    const caddyfilePath = caddyFixture();
    const runCalls: ReadonlyArray<string>[] = [];
    // Set origin to the host already in the fixture (old.example.com).
    const code = await hubSetOrigin(["https://old.example.com"], {
      configDir: dir,
      log: collect,
      caddyfilePath,
      getuid: () => 0,
      run: async (cmd) => {
        runCalls.push(cmd);
        return okResult();
      },
      restartModules: async () => 0,
    });
    expect(code).toBe(0);
    // Host already matched → no reload.
    expect(runCalls).toEqual([]);
    expect(log.join("\n")).toContain("already points at old.example.com");
  });
});
