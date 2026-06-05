import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPendingHostname, writePendingHostname } from "../cloudflare/state.ts";
import { exposePublicInteractive } from "../commands/expose-interactive.ts";
import { readLastProvider, writeLastProvider } from "../expose-last-provider.ts";
import type { CommandResult, Runner } from "../tailscale/run.ts";

// Every test in this file uses injected seams for tailscale/cloudflared; the
// auth preflight is a separate module with its own test file, so stub it out
// here to keep these tests focused on the picker logic. Tests that want to
// assert preflight behavior override this.
const noopPreflight = async () => {};

interface TestEnv {
  cloudflaredHome: string;
  lastProviderPath: string;
  statePath: string;
  cleanup: () => void;
}

function makeEnv(opts: { cloudflaredLoggedIn?: boolean } = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pcli-expose-interactive-"));
  const cloudflaredHome = join(dir, "cloudflared");
  require("node:fs").mkdirSync(cloudflaredHome, { recursive: true });
  if (opts.cloudflaredLoggedIn) {
    writeFileSync(join(cloudflaredHome, "cert.pem"), "---");
  }
  return {
    cloudflaredHome,
    lastProviderPath: join(dir, "expose-last-provider.json"),
    statePath: join(dir, "cloudflared-state.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface FixedRunnerOpts {
  tailscaleInstalled?: boolean;
  tailscaleLoggedIn?: boolean;
  tailscaleFunnelCap?: boolean;
  cloudflaredInstalled?: boolean;
}

/**
 * Returns a runner that answers the detection calls deterministically:
 *  - `tailscale version` → exit 0 iff tailscaleInstalled
 *  - `tailscale status --json` → JSON with Self.DNSName (if logged in) and
 *    Self.CapMap[funnel] (if funnel cap granted)
 *  - `cloudflared --version` → exit 0 iff cloudflaredInstalled
 *
 * Every call is appended to the returned `calls` array.
 */
function fixedRunner(opts: FixedRunnerOpts): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (cmd) => {
    calls.push([...cmd]);
    const head = cmd.slice(0, 2).join(" ");
    if (head === "tailscale version") {
      return opts.tailscaleInstalled
        ? ({ code: 0, stdout: "1.82.0\n", stderr: "" } as CommandResult)
        : ({ code: 127, stdout: "", stderr: "not found" } as CommandResult);
    }
    if (head === "tailscale status") {
      const self: Record<string, unknown> = {};
      if (opts.tailscaleLoggedIn) self.DNSName = "parachute.example.ts.net.";
      if (opts.tailscaleFunnelCap) self.CapMap = { "https://tailscale.com/cap/funnel": ["*"] };
      return { code: 0, stdout: JSON.stringify({ Self: self }), stderr: "" } as CommandResult;
    }
    if (head === "cloudflared --version") {
      return opts.cloudflaredInstalled
        ? ({ code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" } as CommandResult)
        : ({ code: 127, stdout: "", stderr: "not found" } as CommandResult);
    }
    throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
  };
  return { runner, calls };
}

function queuePrompt(answers: string[]): {
  prompt: (q: string) => Promise<string>;
  asked: string[];
} {
  const asked: string[] = [];
  let i = 0;
  return {
    prompt: async (q) => {
      asked.push(q);
      const a = answers[i++];
      if (a === undefined) throw new Error(`prompt exhausted at question: ${q}`);
      return a;
    },
    asked,
  };
}

describe("exposePublicInteractive — both ready", () => {
  test("picks Tailscale by default when nothing remembered", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      const { prompt } = queuePrompt([""]); // accept default
      let tailscaleCalled = false;
      let cloudflareCalled = false;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => {
          tailscaleCalled = true;
          return 0;
        },
        exposeCloudflareUpImpl: async () => {
          cloudflareCalled = true;
          return 0;
        },
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(tailscaleCalled).toBe(true);
      expect(cloudflareCalled).toBe(false);
      expect(readLastProvider(env.lastProviderPath)?.provider).toBe("tailscale");
    } finally {
      env.cleanup();
    }
  });

  test("remembers and defaults to the last-used provider", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    writeLastProvider("cloudflare", { path: env.lastProviderPath });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      // Accept default (blank) at provider prompt, then supply hostname.
      const { prompt } = queuePrompt(["", "vault.example.com"]);
      let cloudflareHostname: string | undefined;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async (h) => {
          cloudflareHostname = h;
          return 0;
        },
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(cloudflareHostname).toBe("vault.example.com");
    } finally {
      env.cleanup();
    }
  });

  test("explicit '2' selects Cloudflare; hostname prompted and validated", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      const { prompt } = queuePrompt(["2", "not a host", "vault.example.com"]);
      let cloudflareHostname: string | undefined;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async (h) => {
          cloudflareHostname = h;
          return 0;
        },
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(cloudflareHostname).toBe("vault.example.com");
      expect(readLastProvider(env.lastProviderPath)?.provider).toBe("cloudflare");
    } finally {
      env.cleanup();
    }
  });

  test("hub#567: persists the typed hostname as soon as it validates", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      const { prompt } = queuePrompt(["2", "vault.example.com"]);
      // exposeCloudflareUpImpl FAILS — so the hostname must survive for a retry.
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        statePath: env.statePath,
        log: () => {},
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => 1,
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(1);
      // Stashed despite the downstream failure.
      expect(readPendingHostname(env.statePath)).toBe("vault.example.com");
    } finally {
      env.cleanup();
    }
  });

  test("hub#567: pre-fills the hostname prompt from a stashed value; Enter accepts it", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      writePendingHostname("techne.parachute.computer", env.statePath);
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      // Pick cloudflare, then press Enter (blank) at the hostname prompt.
      const { prompt, asked } = queuePrompt(["2", ""]);
      let cloudflareHostname: string | undefined;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        statePath: env.statePath,
        log: () => {},
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async (h) => {
          cloudflareHostname = h;
          return 0;
        },
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      // Enter accepted the stashed hostname.
      expect(cloudflareHostname).toBe("techne.parachute.computer");
      // The prompt surfaced the default in brackets.
      expect(asked.some((q) => q.includes("[techne.parachute.computer]"))).toBe(true);
      // Cleared once routing succeeded.
      expect(readPendingHostname(env.statePath)).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  test("'q' aborts cleanly with exit 0 and no downstream calls", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      const { prompt } = queuePrompt(["q"]);
      let anyCalled = false;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => {
          anyCalled = true;
          return 0;
        },
        exposeCloudflareUpImpl: async () => {
          anyCalled = true;
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(anyCalled).toBe(false);
      expect(readLastProvider(env.lastProviderPath)).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  test("blank hostname at the Cloudflare prompt exits 0 without handoff", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      const { prompt } = queuePrompt(["2", ""]);
      let cloudflareCalled = false;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => {
          cloudflareCalled = true;
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(cloudflareCalled).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

describe("exposePublicInteractive — only one ready", () => {
  test("tailscale-ready, cloudflare-missing: announces and runs tailscale without prompting", async () => {
    const env = makeEnv();
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: false,
      });
      let prompts = 0;
      const logs: string[] = [];
      const code = await exposePublicInteractive({
        runner,
        prompt: async () => {
          prompts++;
          return "";
        },
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: (l) => logs.push(l),
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => 0,
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(prompts).toBe(0);
      expect(logs.join("\n")).toContain("Using Tailscale Funnel");
      expect(readLastProvider(env.lastProviderPath)?.provider).toBe("tailscale");
    } finally {
      env.cleanup();
    }
  });

  test("cloudflare-ready, tailscale-missing: announces and prompts hostname", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: false,
        cloudflaredInstalled: true,
      });
      const { prompt } = queuePrompt(["vault.example.com"]);
      const logs: string[] = [];
      let cloudflareHostname: string | undefined;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: (l) => logs.push(l),
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async (h) => {
          cloudflareHostname = h;
          return 0;
        },
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(cloudflareHostname).toBe("vault.example.com");
      expect(logs.join("\n")).toContain("Using Cloudflare Tunnel");
    } finally {
      env.cleanup();
    }
  });
});

describe("exposePublicInteractive — neither ready", () => {
  test("user picks tailscale: prints setup guidance and exits 1", async () => {
    const env = makeEnv();
    try {
      const { runner } = fixedRunner({});
      const { prompt } = queuePrompt(["1"]);
      const logs: string[] = [];
      let tailscaleCalled = false;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        platform: "darwin",
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: (l) => logs.push(l),
        exposePublicImpl: async () => {
          tailscaleCalled = true;
          return 0;
        },
        exposeCloudflareUpImpl: async () => 0,
      });
      expect(code).toBe(1);
      expect(tailscaleCalled).toBe(false);
      const joined = logs.join("\n");
      expect(joined).toContain("brew install tailscale");
      expect(joined).toContain("tailscale up");
      expect(joined).toContain("login.tailscale.com/admin/acls");
    } finally {
      env.cleanup();
    }
  });

  test("user picks tailscale on linux: install hint links to tailscale.com", async () => {
    const env = makeEnv();
    try {
      const { runner } = fixedRunner({});
      const { prompt } = queuePrompt(["1"]);
      const logs: string[] = [];
      const code = await exposePublicInteractive({
        runner,
        prompt,
        platform: "linux",
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: (l) => logs.push(l),
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => 0,
      });
      expect(code).toBe(1);
      const joined = logs.join("\n");
      expect(joined).toContain("tailscale.com/download");
    } finally {
      env.cleanup();
    }
  });

  test("user picks cloudflare on macos: brew install confirmed, login runs, hostname then handoff", async () => {
    const env = makeEnv();
    try {
      let cloudflaredInstalled = false;
      const calls: string[][] = [];
      const runner: Runner = async (cmd) => {
        calls.push([...cmd]);
        const head = cmd.slice(0, 2).join(" ");
        if (head === "tailscale version") return { code: 127, stdout: "", stderr: "not found" };
        if (head === "tailscale status") return { code: 0, stdout: "{}", stderr: "" };
        if (head === "cloudflared --version") {
          return cloudflaredInstalled
            ? { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" }
            : { code: 127, stdout: "", stderr: "not found" };
        }
        throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
      };
      const interactiveCmds: string[][] = [];
      const interactiveRunner = async (cmd: readonly string[]) => {
        interactiveCmds.push([...cmd]);
        if (cmd[0] === "brew") {
          cloudflaredInstalled = true;
          return 0;
        }
        if (cmd[0] === "cloudflared") {
          // Simulate successful login by dropping cert.pem.
          writeFileSync(join(env.cloudflaredHome, "cert.pem"), "---");
          return 0;
        }
        throw new Error(`unexpected interactive cmd: ${cmd.join(" ")}`);
      };
      const { prompt } = queuePrompt(["2", "y", "y", "vault.example.com"]);
      const logs: string[] = [];
      let cloudflareHostname: string | undefined;
      const code = await exposePublicInteractive({
        runner,
        interactiveRunner,
        prompt,
        platform: "darwin",
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: (l) => logs.push(l),
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async (h) => {
          cloudflareHostname = h;
          return 0;
        },
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(interactiveCmds[0]).toEqual(["brew", "install", "cloudflared"]);
      expect(interactiveCmds[1]).toEqual(["cloudflared", "tunnel", "login"]);
      expect(cloudflareHostname).toBe("vault.example.com");
      expect(readLastProvider(env.lastProviderPath)?.provider).toBe("cloudflare");
    } finally {
      env.cleanup();
    }
  });

  test("hub#566: cloudflare on linux, user DECLINES auto-install: prints manual + --cloudflare hint, exits 1", async () => {
    const env = makeEnv();
    try {
      const { runner } = fixedRunner({});
      // "2" → cloudflare; "n" → decline the auto-install offer.
      const { prompt } = queuePrompt(["2", "n"]);
      const logs: string[] = [];
      let interactiveCalled = false;
      let cloudflareCalled = false;
      const code = await exposePublicInteractive({
        runner,
        interactiveRunner: async () => {
          interactiveCalled = true;
          return 0;
        },
        prompt,
        platform: "linux",
        arch: "x64",
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        statePath: env.statePath,
        log: (l) => logs.push(l),
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => {
          cloudflareCalled = true;
          return 0;
        },
      });
      expect(code).toBe(1);
      // Declining means no curl/chmod ran and we never reached the expose.
      expect(interactiveCalled).toBe(false);
      expect(cloudflareCalled).toBe(false);
      const joined = logs.join("\n");
      expect(joined).toContain("Skipped auto-install");
      expect(joined).toContain("github.com/cloudflare/cloudflared/releases/latest");
      expect(joined).toContain("curl -L -o /usr/local/bin/cloudflared");
      // hub#566: re-run hint carries the --cloudflare flag (bare `expose
      // public` defaults to Tailscale).
      expect(joined).toContain("parachute expose public --cloudflare");
      expect(joined).not.toContain("developers.cloudflare.com");
      expect(joined).not.toContain("pkg.cloudflare.com");
      expect(joined).not.toContain("sudo dnf install cloudflared");
    } finally {
      env.cleanup();
    }
  });

  test("hub#566: cloudflare on linux as ROOT, accepts auto-install: runs bare curl+chmod (no sudo), then exposes", async () => {
    const env = makeEnv();
    try {
      // cloudflared starts absent (so the install offer fires), then present
      // after the install runs (so the verify probe + flow continue).
      let cloudflaredPresent = false;
      const runner: Runner = async (cmd) => {
        if (cmd.slice(0, 2).join(" ") === "cloudflared --version") {
          return cloudflaredPresent
            ? { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" }
            : { code: 127, stdout: "", stderr: "not found" };
        }
        if (cmd[0] === "tailscale") {
          // Detection: tailscale absent (forces the cloudflare-only path).
          return { code: 127, stdout: "", stderr: "not found" };
        }
        throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
      };
      // "2" cloudflare → "Y" install → "Y" login → hostname. The login prompt
      // fires because detection reported cloudflared absent (so loggedIn=false)
      // even though cert.pem appears once login "runs".
      const { prompt } = queuePrompt(["2", "y", "y", "vault.example.com"]);
      const interactiveCmds: string[][] = [];
      const logs: string[] = [];
      let cloudflareHostname = "";
      const code = await exposePublicInteractive({
        runner,
        interactiveRunner: async (cmd) => {
          interactiveCmds.push([...cmd]);
          // Install "succeeds": flip cloudflared to present. Login "succeeds":
          // drop the cert so `isCloudflaredLoggedIn` reads true afterward.
          if (cmd.includes("login")) writeFileSync(join(env.cloudflaredHome, "cert.pem"), "---");
          else cloudflaredPresent = true;
          return 0;
        },
        prompt,
        platform: "linux",
        arch: "x64",
        getuid: () => 0, // root
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        statePath: env.statePath,
        log: (l) => logs.push(l),
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async (hostname) => {
          cloudflareHostname = hostname;
          return 0;
        },
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(cloudflareHostname).toBe("vault.example.com");
      // Root runs curl + chmod WITHOUT a sudo prefix.
      expect(interactiveCmds[0]?.[0]).toBe("curl");
      expect(interactiveCmds[0]).toContain("/usr/local/bin/cloudflared");
      expect(interactiveCmds[1]?.[0]).toBe("chmod");
      expect(interactiveCmds.some((c) => c[0] === "sudo")).toBe(false);
      expect(logs.join("\n")).toContain("✓ cloudflared installed.");
    } finally {
      env.cleanup();
    }
  });

  test("hub#566: cloudflare on linux NON-root, accepts auto-install: wraps curl+chmod in sudo", async () => {
    const env = makeEnv();
    try {
      let cloudflaredPresent = false;
      const runner: Runner = async (cmd) => {
        if (cmd.slice(0, 2).join(" ") === "cloudflared --version") {
          return cloudflaredPresent
            ? { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" }
            : { code: 127, stdout: "", stderr: "not found" };
        }
        if (cmd[0] === "tailscale") return { code: 127, stdout: "", stderr: "not found" };
        throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
      };
      const { prompt } = queuePrompt(["2", "y", "y", "vault.example.com"]);
      const interactiveCmds: string[][] = [];
      const code = await exposePublicInteractive({
        runner,
        interactiveRunner: async (cmd) => {
          interactiveCmds.push([...cmd]);
          if (cmd.includes("login")) writeFileSync(join(env.cloudflaredHome, "cert.pem"), "---");
          else cloudflaredPresent = true;
          return 0;
        },
        prompt,
        platform: "linux",
        arch: "arm64",
        getuid: () => 1000, // non-root
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        statePath: env.statePath,
        log: () => {},
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => 0,
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      // Non-root prefixes both privileged steps with sudo.
      expect(interactiveCmds[0]?.[0]).toBe("sudo");
      expect(interactiveCmds[0]).toContain("curl");
      expect(interactiveCmds[1]?.[0]).toBe("sudo");
      expect(interactiveCmds[1]).toContain("chmod");
    } finally {
      env.cleanup();
    }
  });

  test("hub#566: cloudflare on linux, sudo curl FAILS: prints manual + --cloudflare hint, exits 1", async () => {
    const env = makeEnv();
    try {
      const runner: Runner = async (cmd) => {
        if (cmd.slice(0, 2).join(" ") === "cloudflared --version") {
          return { code: 127, stdout: "", stderr: "not found" };
        }
        if (cmd[0] === "tailscale") return { code: 127, stdout: "", stderr: "not found" };
        throw new Error(`unexpected runner call: ${cmd.join(" ")}`);
      };
      const { prompt } = queuePrompt(["2", "y"]);
      const logs: string[] = [];
      let cloudflareCalled = false;
      const code = await exposePublicInteractive({
        runner,
        // Simulate sudo failing (no cached creds, no tty).
        interactiveRunner: async () => 1,
        prompt,
        platform: "linux",
        arch: "x64",
        getuid: () => 1000,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        statePath: env.statePath,
        log: (l) => logs.push(l),
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => {
          cloudflareCalled = true;
          return 0;
        },
      });
      expect(code).toBe(1);
      expect(cloudflareCalled).toBe(false);
      const joined = logs.join("\n");
      expect(joined).toContain("Download failed");
      expect(joined).toContain("parachute expose public --cloudflare");
    } finally {
      env.cleanup();
    }
  });

  test("user picks cloudflare on macos but declines brew: exits 1, no install attempted", async () => {
    const env = makeEnv();
    try {
      const { runner } = fixedRunner({});
      const interactiveCmds: string[][] = [];
      const { prompt } = queuePrompt(["2", "n"]);
      const code = await exposePublicInteractive({
        runner,
        interactiveRunner: async (cmd) => {
          interactiveCmds.push([...cmd]);
          return 0;
        },
        prompt,
        platform: "darwin",
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => 0,
      });
      expect(code).toBe(1);
      expect(interactiveCmds).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });

  test("user picks cloudflare on macos, installed but login declined: exits 1", async () => {
    const env = makeEnv(); // no cert.pem
    try {
      const { runner } = fixedRunner({ cloudflaredInstalled: true });
      const interactiveCmds: string[][] = [];
      const { prompt } = queuePrompt(["2", "n"]);
      const code = await exposePublicInteractive({
        runner,
        interactiveRunner: async (cmd) => {
          interactiveCmds.push([...cmd]);
          return 0;
        },
        prompt,
        platform: "darwin",
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => 0,
      });
      expect(code).toBe(1);
      // No brew install was needed; no login was performed.
      expect(interactiveCmds).toHaveLength(0);
    } finally {
      env.cleanup();
    }
  });

  test("quit at neither-ready picker exits 0 with no handoff", async () => {
    const env = makeEnv();
    try {
      const { runner } = fixedRunner({});
      const { prompt } = queuePrompt(["q"]);
      let anyCalled = false;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => {
          anyCalled = true;
          return 0;
        },
        exposeCloudflareUpImpl: async () => {
          anyCalled = true;
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(anyCalled).toBe(false);
    } finally {
      env.cleanup();
    }
  });
});

describe("exposePublicInteractive — edge cases", () => {
  test("tailscale installed+logged-in but Funnel cap missing counts as not ready", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: false,
        cloudflaredInstalled: true,
      });
      // Since tailscale isn't "ready", only cloudflare counts as ready → one-ready path.
      const { prompt } = queuePrompt(["vault.example.com"]);
      let cloudflareCalled = false;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => 0,
        exposeCloudflareUpImpl: async () => {
          cloudflareCalled = true;
          return 0;
        },
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(cloudflareCalled).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("passthrough opts flow to the downstream entry points", async () => {
    const env = makeEnv();
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
      });
      let receivedExposeOpts: unknown;
      const code = await exposePublicInteractive({
        runner,
        prompt: async () => "",
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposeOpts: { hubOrigin: "https://custom.example" },
        exposePublicImpl: async (_action, opts) => {
          receivedExposeOpts = opts;
          return 0;
        },
        exposeCloudflareUpImpl: async () => 0,
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(receivedExposeOpts).toEqual({ hubOrigin: "https://custom.example" });
    } finally {
      env.cleanup();
    }
  });

  test("preselect=cloudflare skips picker and prompts only for hostname", async () => {
    // Simulates `parachute expose public --cloudflare` in a TTY without
    // --domain: we know the user wants Cloudflare, so no provider picker,
    // straight to the hostname prompt.
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      const { prompt, asked } = queuePrompt(["vault.example.com"]);
      let cloudflareHostname: string | undefined;
      let tailscaleCalled = false;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        preselect: "cloudflare",
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => {
          tailscaleCalled = true;
          return 0;
        },
        exposeCloudflareUpImpl: async (h) => {
          cloudflareHostname = h;
          return 0;
        },
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(tailscaleCalled).toBe(false);
      expect(cloudflareHostname).toBe("vault.example.com");
      // Only one prompt was asked — the hostname. No provider picker shown.
      expect(asked).toHaveLength(1);
      expect(asked[0]?.toLowerCase()).toContain("hostname");
      expect(readLastProvider(env.lastProviderPath)?.provider).toBe("cloudflare");
    } finally {
      env.cleanup();
    }
  });

  test("invalid provider input reprompts rather than crashing", async () => {
    const env = makeEnv({ cloudflaredLoggedIn: true });
    try {
      const { runner } = fixedRunner({
        tailscaleInstalled: true,
        tailscaleLoggedIn: true,
        tailscaleFunnelCap: true,
        cloudflaredInstalled: true,
      });
      const { prompt, asked } = queuePrompt(["huh", "7", "1"]);
      let tailscaleCalled = false;
      const code = await exposePublicInteractive({
        runner,
        prompt,
        cloudflaredHome: env.cloudflaredHome,
        lastProviderPath: env.lastProviderPath,
        log: () => {},
        exposePublicImpl: async () => {
          tailscaleCalled = true;
          return 0;
        },
        exposeCloudflareUpImpl: async () => 0,
        runAuthPreflightImpl: noopPreflight,
      });
      expect(code).toBe(0);
      expect(tailscaleCalled).toBe(true);
      expect(asked.length).toBeGreaterThanOrEqual(3);
    } finally {
      env.cleanup();
    }
  });
});
