import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, resolveAdminUrl } from "../commands/init.ts";
import type { ExposeState } from "../expose-state.ts";
import { writeHubPort } from "../hub-control.ts";
import { writePid } from "../process-state.ts";

interface Harness {
  configDir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-init-"));
  const manifestPath = join(dir, "services.json");
  writeFileSync(manifestPath, JSON.stringify({ services: [] }));
  return {
    configDir: dir,
    manifestPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedVault(manifestPath: string): void {
  writeFileSync(
    manifestPath,
    JSON.stringify({
      services: [
        {
          name: "parachute-vault",
          version: "0.5.0",
          port: 1940,
          paths: ["/vault/default"],
          health: "/health",
          icon: "/icon.svg",
          auth: { type: "none" },
          mcp: {},
        },
      ],
    }),
  );
}

describe("resolveAdminUrl", () => {
  test("prefers expose-state FQDN when present", () => {
    const state: ExposeState = {
      version: 1,
      layer: "tailnet",
      mode: "path",
      canonicalFqdn: "box-1.tailnet.ts.net",
      port: 443,
      funnel: false,
      entries: [],
      hubOrigin: "https://box-1.tailnet.ts.net",
    };
    expect(resolveAdminUrl(state, 1939)).toBe("https://box-1.tailnet.ts.net/admin/");
  });

  test("falls back to loopback + hub port when no exposure", () => {
    expect(resolveAdminUrl(undefined, 1939)).toBe("http://127.0.0.1:1939/admin/");
  });

  test("undefined when neither expose-state nor a hub port is known", () => {
    expect(resolveAdminUrl(undefined, undefined)).toBeUndefined();
  });
});

describe("init", () => {
  test("starts the hub when not running and prints the loopback admin URL", async () => {
    const h = makeHarness();
    try {
      const calls: string[] = [];
      const logs: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
        alive: () => false,
        ensureHub: async () => {
          calls.push("ensureHub");
          // Seed the port file as a real ensureHubRunning would.
          writeHubPort(1939, h.configDir);
          return { pid: 5555, port: 1939, started: true };
        },
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
      });
      expect(code).toBe(0);
      expect(calls).toEqual(["ensureHub"]);
      const joined = logs.join("\n");
      expect(joined).toContain("Hub not running — starting it now");
      expect(joined).toContain("Hub started (pid 5555, port 1939)");
      expect(joined).toContain("http://127.0.0.1:1939/admin/");
      expect(joined).toContain("finish setup in the admin wizard");
    } finally {
      h.cleanup();
    }
  });

  test("idempotent: skips ensureHub and confirms 'looks good' when hub up + vault configured", async () => {
    const h = makeHarness();
    try {
      // Seed: hub running + vault row exists.
      mkdirSync(join(h.configDir, "hub", "run"), { recursive: true });
      writePid("hub", 1234, h.configDir);
      writeHubPort(1939, h.configDir);
      seedVault(h.manifestPath);

      const calls: string[] = [];
      const logs: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
        alive: () => true,
        ensureHub: async () => {
          calls.push("ensureHub");
          return { pid: 1234, port: 1939, started: false };
        },
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
      });
      expect(code).toBe(0);
      // Hub was already running — ensureHub should not have been called.
      expect(calls).toEqual([]);
      const joined = logs.join("\n");
      expect(joined).toContain("Hub already running (pid 1234, port 1939)");
      expect(joined).toContain("Looks good");
      expect(joined).toContain("http://127.0.0.1:1939/admin/");
    } finally {
      h.cleanup();
    }
  });

  test("prefers the exposed FQDN over loopback", async () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.configDir, "hub", "run"), { recursive: true });
      writePid("hub", 4321, h.configDir);
      writeHubPort(1939, h.configDir);

      const state: ExposeState = {
        version: 1,
        layer: "public",
        mode: "path",
        canonicalFqdn: "gitcoin.parachute.computer",
        port: 443,
        funnel: false,
        entries: [],
        hubOrigin: "https://gitcoin.parachute.computer",
      };

      const logs: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
        alive: () => true,
        ensureHub: async () => ({ pid: 4321, port: 1939, started: false }),
        readExposeStateFn: () => state,
        isTty: false,
        platform: "linux",
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("https://gitcoin.parachute.computer/admin/");
      // Not the loopback fallback.
      expect(logs.join("\n")).not.toContain("http://127.0.0.1");
    } finally {
      h.cleanup();
    }
  });

  test("offers to open the browser in a TTY; 'y' invokes openBrowser", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const opened: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "darwin",
        prompt: async () => "y",
        openBrowser: (url) => {
          opened.push(url);
          return true;
        },
      });
      expect(code).toBe(0);
      expect(opened).toEqual(["http://127.0.0.1:1939/admin/"]);
    } finally {
      h.cleanup();
    }
  });

  test("offers to open the browser in a TTY; 'n' skips openBrowser", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const opened: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "darwin",
        prompt: async () => "n",
        openBrowser: (url) => {
          opened.push(url);
          return true;
        },
      });
      expect(code).toBe(0);
      expect(opened).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("--no-browser skips the prompt and openBrowser entirely", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const opened: string[] = [];
      let prompted = false;
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "darwin",
        prompt: async () => {
          prompted = true;
          return "y";
        },
        openBrowser: (url) => {
          opened.push(url);
          return true;
        },
        noBrowser: true,
      });
      expect(code).toBe(0);
      expect(prompted).toBe(false);
      expect(opened).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("non-TTY prints the URL and exits without prompting", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      let prompted = false;
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "darwin",
        prompt: async () => {
          prompted = true;
          return "y";
        },
        openBrowser: () => true,
      });
      expect(code).toBe(0);
      expect(prompted).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("Windows / unsupported platform: skip browser launch, just print", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const opened: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "win32",
        prompt: async () => "y",
        openBrowser: (url) => {
          opened.push(url);
          return true;
        },
      });
      expect(code).toBe(0);
      // No prompt offered on Windows — just URL printed.
      expect(opened).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("ensureHub failure exits 1 with an actionable hint", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
        alive: () => false,
        ensureHub: async () => {
          throw new Error("port 1939 is in use");
        },
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
      });
      expect(code).toBe(1);
      const joined = logs.join("\n");
      expect(joined).toContain("Hub failed to start: port 1939 is in use");
      expect(joined).toContain("parachute logs hub");
    } finally {
      h.cleanup();
    }
  });
});
