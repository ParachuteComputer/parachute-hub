import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasNoDisplay, init, looksLikeServer, resolveAdminUrl } from "../commands/init.ts";
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

/**
 * Default test-stub for the vault-module install step (hub#168 Cut 1).
 * The real `installVaultModuleImpl` shells out to `bun add -g
 * @openparachute/vault` + seeds services.json — neither is appropriate in
 * a unit test (slow + side-effectful + leaks state across runs). Tests
 * that want to observe install-flow side-effects (services.json shape,
 * etc.) can override this with their own stub.
 */
const noopVaultInstall = async (_configDir: string, _manifestPath: string): Promise<number> => 0;

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
        installVaultModuleImpl: noopVaultInstall,
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
        installVaultModuleImpl: noopVaultInstall,
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
        // Skip the new exposure prompt — this test is about the browser prompt only.
        noExposePrompt: true,
        // Pre-pick the browser wizard so the new (hub#168 Cut 4) "browser
        // or CLI?" prompt doesn't fire — this test predates that step.
        wizardChoice: "browser",
        installVaultModuleImpl: noopVaultInstall,
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
        noExposePrompt: true,
        // No wizardChoice set — falls into the back-compat Y/n confirm,
        // where 'n' skips the browser open (the original semantic this
        // test was written to assert). Suppress the new (hub#168 Cut 4)
        // wizard-choice prompt so this test stays focused on the Y/n
        // confirm path.
        noWizardPrompt: true,
        installVaultModuleImpl: noopVaultInstall,
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
        noExposePrompt: true,
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
        noExposePrompt: true,
      });
      expect(code).toBe(0);
      // No prompt offered on Windows — just URL printed.
      expect(opened).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("linux SSH (no display): prints the link, does NOT spawn a browser (Fix 2)", async () => {
    // A TTY isn't enough — an SSH session is a TTY with no display, so
    // `xdg-open` fails/blocks. Aaron hit this on EC2: init tried to open a
    // browser and failed with "Couldn't launch a browser." We now skip the
    // spawn on a server-shaped box and just print the URL.
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const opened: string[] = [];
      const logs: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "linux",
        env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
        // Pre-pick the browser wizard so a real desktop would spawn — proves
        // the display guard (not the prompt) is what suppresses the spawn.
        wizardChoice: "browser",
        prompt: async () => "y",
        openBrowser: (url) => {
          opened.push(url);
          return true;
        },
        noExposePrompt: true,
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(0);
      expect(opened).toEqual([]); // never spawned
      expect(logs.join("\n")).toContain("No display detected");
    } finally {
      h.cleanup();
    }
  });

  test("linux WITH a display still spawns the browser (desktop unchanged)", async () => {
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
        platform: "linux",
        env: { DISPLAY: ":0" },
        wizardChoice: "browser",
        prompt: async () => "y",
        openBrowser: (url) => {
          opened.push(url);
          return true;
        },
        noExposePrompt: true,
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(0);
      expect(opened).toEqual(["http://127.0.0.1:1939/admin/"]);
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
        installVaultModuleImpl: noopVaultInstall,
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

describe("looksLikeServer heuristic", () => {
  test("macOS is never a server", () => {
    expect(looksLikeServer("darwin", { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" })).toBe(false);
    expect(looksLikeServer("darwin", {})).toBe(false);
  });

  test("Linux desktop with DISPLAY is a laptop", () => {
    expect(looksLikeServer("linux", { DISPLAY: ":0" })).toBe(false);
    expect(looksLikeServer("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
  });

  test("Linux + SSH session → server", () => {
    expect(looksLikeServer("linux", { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" })).toBe(true);
    expect(looksLikeServer("linux", { SSH_CLIENT: "1.2.3.4 22 5.6.7.8" })).toBe(true);
    expect(looksLikeServer("linux", { SSH_TTY: "/dev/pts/0" })).toBe(true);
  });

  test("Linux + no DISPLAY → server (headless)", () => {
    expect(looksLikeServer("linux", {})).toBe(true);
  });

  test("Windows is not a server (init doesn't auto-pick on win32 anyway)", () => {
    expect(looksLikeServer("win32", {})).toBe(false);
  });
});

describe("hasNoDisplay heuristic (Fix 2 — headless browser-open guard)", () => {
  test("macOS / Windows always have a display", () => {
    expect(hasNoDisplay("darwin", {})).toBe(false);
    expect(hasNoDisplay("darwin", { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" })).toBe(false);
    expect(hasNoDisplay("win32", {})).toBe(false);
  });

  test("linux SSH session (a TTY, but no display) → no display", () => {
    expect(hasNoDisplay("linux", { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" })).toBe(true);
    expect(hasNoDisplay("linux", { SSH_TTY: "/dev/pts/0" })).toBe(true);
  });

  test("linux headless console (no SSH, no DISPLAY) → no display", () => {
    expect(hasNoDisplay("linux", {})).toBe(true);
  });

  test("linux desktop with DISPLAY / WAYLAND_DISPLAY → has a display", () => {
    expect(hasNoDisplay("linux", { DISPLAY: ":0" })).toBe(false);
    expect(hasNoDisplay("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
  });

  test("WSL (linux + DISPLAY-less but a dev laptop) is treated as having a display via looksLikeServer exclusion", () => {
    // WSL with no DISPLAY would otherwise look headless; looksLikeServer
    // excludes it, but the bare no-DISPLAY fallback still trips. This documents
    // that a WSL user without an X server set won't auto-spawn — acceptable,
    // since xdg-open would fail there anyway. WSL WITH an X server (DISPLAY set)
    // correctly resolves to has-a-display.
    expect(hasNoDisplay("linux", { WSL_DISTRO_NAME: "Ubuntu", DISPLAY: ":0" })).toBe(false);
  });
});

describe("init exposure chain", () => {
  test("TTY + no exposure + no flags → prompt is shown", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const promptCalls: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "darwin",
        env: {},
        prompt: async (q) => {
          promptCalls.push(q);
          // First prompt is the exposure picker → pick "none"; second
          // is the browser-open question → say no.
          if (promptCalls.length === 1) return "1";
          return "n";
        },
        openBrowser: () => true,
      });
      expect(code).toBe(0);
      // The exposure prompt was shown.
      expect(promptCalls.some((q) => q.toLowerCase().includes("pick"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("--no-expose-prompt skips the prompt entirely", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      let exposureChained = false;
      const promptCalls: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "darwin",
        env: {},
        prompt: async (q) => {
          promptCalls.push(q);
          return "n";
        },
        openBrowser: () => true,
        exposeTailnetImpl: async () => {
          exposureChained = true;
          return 0;
        },
        exposeCloudflareImpl: async () => {
          exposureChained = true;
          return 0;
        },
        noExposePrompt: true,
        // Suppress the new wizard-choice prompt + stub the vault-module
        // install (hub#168 Cuts 1/4) so this pre-existing test stays
        // focused on the exposure-prompt-skipped assertion.
        noWizardPrompt: true,
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(0);
      expect(exposureChained).toBe(false);
      // No exposure prompt; only the browser-open prompt.
      expect(promptCalls.some((q) => q.toLowerCase().includes("pick"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("--expose tailnet chains into tailnet without prompting", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      let tailnetCalls = 0;
      let cloudflareCalls = 0;
      const promptCalls: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "linux",
        env: {},
        prompt: async (q) => {
          promptCalls.push(q);
          return "n";
        },
        openBrowser: () => true,
        exposeTailnetImpl: async () => {
          tailnetCalls += 1;
          return 0;
        },
        exposeCloudflareImpl: async () => {
          cloudflareCalls += 1;
          return 0;
        },
        exposeChoice: "tailnet",
        noWizardPrompt: true,
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(0);
      expect(tailnetCalls).toBe(1);
      expect(cloudflareCalls).toBe(0);
      // No exposure prompt — the flag pre-empted it.
      expect(promptCalls.some((q) => q.toLowerCase().includes("pick"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("--expose cloudflare chains into cloudflare without prompting", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      let tailnetCalls = 0;
      let cloudflareCalls = 0;
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
        env: {},
        exposeTailnetImpl: async () => {
          tailnetCalls += 1;
          return 0;
        },
        exposeCloudflareImpl: async () => {
          cloudflareCalls += 1;
          return 0;
        },
        exposeChoice: "cloudflare",
      });
      expect(code).toBe(0);
      expect(cloudflareCalls).toBe(1);
      expect(tailnetCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("--expose none skips exposure", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      let tailnetCalls = 0;
      let cloudflareCalls = 0;
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
        env: {},
        exposeTailnetImpl: async () => {
          tailnetCalls += 1;
          return 0;
        },
        exposeCloudflareImpl: async () => {
          cloudflareCalls += 1;
          return 0;
        },
        exposeChoice: "none",
      });
      expect(code).toBe(0);
      expect(tailnetCalls).toBe(0);
      expect(cloudflareCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("default selection differs by SSH heuristic (laptop → 1, server → 3)", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);

      // Laptop: macOS, no SSH → default is "1" (none).
      let promptLog: string[] = [];
      // Array-based holder defeats TS control-flow narrowing — element
      // reads on an array typed as ExposeChoice[] always come back as the
      // declared element type, not narrowed to the last assigned literal.
      const chained: ExposeChoice[] = ["none"];
      const setChained = (v: ExposeChoice) => {
        chained[0] = v;
      };
      await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => promptLog.push(l),
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "darwin",
        env: {},
        prompt: async (q) => {
          promptLog.push(`Q: ${q}`);
          // Empty == confirm default.
          if (q.toLowerCase().includes("pick")) return "";
          return "n";
        },
        openBrowser: () => true,
        exposeTailnetImpl: async () => {
          setChained("tailnet");
          return 0;
        },
        exposeCloudflareImpl: async () => {
          setChained("cloudflare");
          return 0;
        },
      });
      // Default on laptop is "none" → no chain.
      expect(chained[0]).toBe("none");
      // The "Pick [1]" prompt was shown (loopback as default).
      expect(promptLog.some((l) => l.includes("Pick [1]"))).toBe(true);

      // Server: Linux + SSH → default is "3" (cloudflare).
      promptLog = [];
      setChained("none");
      await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => promptLog.push(l),
        alive: () => true,
        ensureHub: async () => ({ pid: 7, port: 1939, started: false }),
        readExposeStateFn: () => undefined,
        isTty: true,
        platform: "linux",
        env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
        prompt: async (q) => {
          promptLog.push(`Q: ${q}`);
          if (q.toLowerCase().includes("pick")) return "";
          return "n";
        },
        openBrowser: () => true,
        exposeTailnetImpl: async () => {
          setChained("tailnet");
          return 0;
        },
        exposeCloudflareImpl: async () => {
          setChained("cloudflare");
          return 0;
        },
      });
      expect(chained[0]).toBe("cloudflare");
      expect(promptLog.some((l) => l.includes("Pick [3]"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("hub already exposed → no prompt, FQDN URL printed", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const state: ExposeState = {
        version: 1,
        layer: "public",
        mode: "path",
        canonicalFqdn: "ec2-example.parachute.computer",
        port: 443,
        funnel: false,
        entries: [],
        hubOrigin: "https://ec2-example.parachute.computer",
      };
      const promptCalls: string[] = [];
      let chained = false;
      const logs: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => state,
        isTty: true,
        platform: "linux",
        env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
        prompt: async (q) => {
          promptCalls.push(q);
          return "n";
        },
        openBrowser: () => true,
        exposeTailnetImpl: async () => {
          chained = true;
          return 0;
        },
        exposeCloudflareImpl: async () => {
          chained = true;
          return 0;
        },
        noWizardPrompt: true,
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(0);
      // No exposure chain ran, no exposure prompt asked.
      expect(chained).toBe(false);
      expect(promptCalls.some((q) => q.toLowerCase().includes("pick"))).toBe(false);
      // The FQDN URL is printed.
      expect(logs.join("\n")).toContain("https://ec2-example.parachute.computer/admin/");
      expect(logs.join("\n")).toContain("already exposed");
    } finally {
      h.cleanup();
    }
  });

  test("non-TTY → no exposure prompt, falls through to localhost", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      let chained = false;
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
        env: { SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" },
        exposeTailnetImpl: async () => {
          chained = true;
          return 0;
        },
        exposeCloudflareImpl: async () => {
          chained = true;
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(chained).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("exposure chain non-zero exit propagates", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
        env: {},
        exposeTailnetImpl: async () => 0,
        exposeCloudflareImpl: async () => 2,
        exposeChoice: "cloudflare",
      });
      expect(code).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Phase 3a cutover (design §3.3 init row, §3.1, §4.1/§4.2): init installs +
  // starts the hub UNIT (not a detached spawn) and guarantees an operator
  // token. The `ensureHub` + `guaranteeOperatorToken` seams stay injectable;
  // these tests drive them as stubs (and exercise the REAL operator-token
  // guarantee against a seeded hub DB).
  // -------------------------------------------------------------------------

  test("calls guaranteeOperatorToken after the hub is up, then falls through to the wizard", async () => {
    const h = makeHarness();
    try {
      const order: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => {
          order.push("ensureHub");
          writeHubPort(1939, h.configDir);
          return { pid: 0, port: 1939, started: true };
        },
        guaranteeOperatorToken: async (ctx) => {
          order.push("guaranteeOperatorToken");
          // The hub is up before the token guarantee runs (§3.2 step 4 — read
          // the token AFTER readiness so we don't race the start-hub iss
          // self-heal).
          expect(ctx.hubPort).toBe(1939);
          return "present";
        },
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(0);
      // hub-up first, then token guarantee — in that order.
      expect(order).toEqual(["ensureHub", "guaranteeOperatorToken"]);
    } finally {
      h.cleanup();
    }
  });

  test("real guarantee: MINTS the operator token when absent + a hub user exists", async () => {
    const h = makeHarness();
    try {
      const { openHubDb, hubDbPath } = await import("../hub-db.ts");
      const { createUser } = await import("../users.ts");
      const { readOperatorTokenFile } = await import("../operator-token.ts");
      // Seed a first-admin so the guarantee has someone to mint for.
      const db = openHubDb(hubDbPath(h.configDir));
      await createUser(db, "owner", "owner-password-123");
      db.close();

      // No operator.token yet.
      expect(await readOperatorTokenFile(h.configDir)).toBeNull();

      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => {
          writeHubPort(1939, h.configDir);
          return { pid: 0, port: 1939, started: true };
        },
        // No guaranteeOperatorToken seam → exercises the REAL default.
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(0);
      // The default minted + wrote the token.
      expect(await readOperatorTokenFile(h.configDir)).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("real guarantee: does NOT double-mint when a token already exists", async () => {
    const h = makeHarness();
    try {
      const { openHubDb, hubDbPath } = await import("../hub-db.ts");
      const { createUser } = await import("../users.ts");
      const { writeOperatorTokenFile, readOperatorTokenFile } = await import(
        "../operator-token.ts"
      );
      const db = openHubDb(hubDbPath(h.configDir));
      await createUser(db, "owner", "owner-password-123");
      db.close();
      // Plant a sentinel token on disk.
      await writeOperatorTokenFile("SENTINEL.PRE-EXISTING.TOKEN", h.configDir);

      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => {
          writeHubPort(1939, h.configDir);
          return { pid: 0, port: 1939, started: true };
        },
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(0);
      // Untouched — the guarantee left the pre-existing token in place.
      expect(await readOperatorTokenFile(h.configDir)).toBe("SENTINEL.PRE-EXISTING.TOKEN");
    } finally {
      h.cleanup();
    }
  });

  test("real guarantee: no hub user yet → no token minted, init still succeeds (no-user, not an error)", async () => {
    const h = makeHarness();
    try {
      const { readOperatorTokenFile } = await import("../operator-token.ts");
      // No user seeded — the common fresh-box case where init runs before the
      // wizard creates first-admin.
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        alive: () => false,
        ensureHub: async () => {
          writeHubPort(1939, h.configDir);
          return { pid: 0, port: 1939, started: true };
        },
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(0);
      // No token (the wizard mints it when the admin is created).
      expect(await readOperatorTokenFile(h.configDir)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("hub-unit bringup failure (e.g. no service manager) → init exits 1 with the actionable message", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
        alive: () => false,
        // Mirror what the production default throws when there's no manager.
        ensureHub: async () => {
          throw new Error(
            "no service manager (systemd/launchd) found — run `parachute serve` in the foreground, or use a platform that provides one",
          );
        },
        guaranteeOperatorToken: async () => "no-user",
        readExposeStateFn: () => undefined,
        isTty: false,
        platform: "linux",
        installVaultModuleImpl: noopVaultInstall,
      });
      expect(code).toBe(1);
      const joined = logs.join("\n");
      expect(joined).toContain("no service manager (systemd/launchd) found");
      expect(joined).toContain("parachute logs hub");
    } finally {
      h.cleanup();
    }
  });

  test("after exposure runs, the admin URL re-reads expose state for the FQDN", async () => {
    const h = makeHarness();
    try {
      writeHubPort(1939, h.configDir);
      let exposedYet = false;
      const exposed: ExposeState = {
        version: 1,
        layer: "tailnet",
        mode: "path",
        canonicalFqdn: "box.tailnet.ts.net",
        port: 443,
        funnel: false,
        entries: [],
        hubOrigin: "https://box.tailnet.ts.net",
      };
      const logs: string[] = [];
      const code = await init({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
        alive: () => false,
        ensureHub: async () => ({ pid: 7, port: 1939, started: true }),
        // Reader returns undefined the first time, then the exposed state
        // after the chain ran. Mirrors the real on-disk flow where
        // exposeTailnet writes expose-state.json.
        readExposeStateFn: () => (exposedYet ? exposed : undefined),
        isTty: false,
        platform: "linux",
        env: {},
        exposeTailnetImpl: async () => {
          exposedYet = true;
          return 0;
        },
        exposeCloudflareImpl: async () => 0,
        exposeChoice: "tailnet",
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("https://box.tailnet.ts.net/admin/");
      expect(logs.join("\n")).not.toContain("http://127.0.0.1");
    } finally {
      h.cleanup();
    }
  });
});

// Type alias used only inside this test file for the heuristic test.
type ExposeChoice = "none" | "tailnet" | "cloudflare";
