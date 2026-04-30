import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exposePublic, exposeTailnet } from "../commands/expose.ts";
import { readExposeState, writeExposeState } from "../expose-state.ts";
import type { EnsureHubOpts, HubSpawner, StopHubOpts } from "../hub-control.ts";
import { writePid } from "../process-state.ts";
import { upsertService } from "../services-manifest.ts";
import type { Runner } from "../tailscale/run.ts";

interface Harness {
  dir: string;
  manifestPath: string;
  statePath: string;
  wellKnownPath: string;
  hubPath: string;
  wellKnownDir: string;
  configDir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-expose-"));
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    statePath: join(dir, "expose-state.json"),
    wellKnownPath: join(dir, "well-known", "parachute.json"),
    hubPath: join(dir, "well-known", "hub.html"),
    wellKnownDir: join(dir, "well-known"),
    configDir: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeRunner(): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (cmd) => {
    calls.push([...cmd]);
    if (cmd[0] === "tailscale" && cmd[1] === "version") {
      return { code: 0, stdout: "1.96.4\n", stderr: "" };
    }
    if (cmd[0] === "tailscale" && cmd[1] === "status" && cmd[2] === "--json") {
      return {
        code: 0,
        stdout: JSON.stringify({ Self: { DNSName: "parachute.taildf9ce2.ts.net." } }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

function makeHubSpawner(pid: number): { spawner: HubSpawner; calls: string[][] } {
  const calls: string[][] = [];
  const spawner: HubSpawner = {
    spawn(cmd) {
      calls.push([...cmd]);
      return pid;
    },
  };
  return { spawner, calls };
}

/** Default hub overrides for expose tests — no real subprocess, no sleep. */
function hubEnsureOpts(
  spawner: HubSpawner,
): Omit<EnsureHubOpts, "configDir" | "wellKnownDir" | "log"> {
  return {
    spawner,
    alive: () => true,
    probe: async () => true,
    readyWaitMs: 0,
  };
}

function hubStopOpts(): Omit<StopHubOpts, "configDir" | "log"> {
  return {
    kill: () => {},
    alive: () => false,
    sleep: async () => {},
    now: () => 0,
  };
}

function seedServices(path: string): void {
  upsertService(
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version: "0.2.4",
    },
    path,
  );
  upsertService(
    {
      name: "parachute-notes",
      port: 5173,
      paths: ["/notes"],
      health: "/notes/health",
      version: "0.0.1",
    },
    path,
  );
}

/** Default probe for tests: every service is up (nobody wants dead-service warnings polluting unrelated assertions). */
const allServicesUp = async () => true;

describe("expose tailnet up", () => {
  test("mounts hub proxy at /, one proxy per service, plus well-known proxy", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);

      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      // 4 baseline (hub + wk + vault + notes) + 4 OAuth proxies (vault present).
      expect(serveCalls).toHaveLength(8);
      // Tailnet mode never uses funnel — neither the old flag nor the new subcommand.
      expect(serveCalls.every((c) => !c.includes("--funnel"))).toBe(true);
      expect(calls.every((c) => c[1] !== "funnel")).toBe(true);

      const mounts = serveCalls.map((c) => c.find((a) => a.startsWith("--set-path="))).sort();
      // Vault paths consolidate to a single `/vault/` mount → hub (#144);
      // the hub then picks the specific vault instance per request from
      // services.json. Notes (and other non-vault services) keep their
      // direct mount.
      expect(mounts).toEqual([
        "--set-path=/",
        "--set-path=/.well-known/oauth-authorization-server",
        "--set-path=/.well-known/parachute.json",
        "--set-path=/notes",
        "--set-path=/oauth/authorize",
        "--set-path=/oauth/register",
        "--set-path=/oauth/token",
        "--set-path=/vault/",
      ]);

      // Hub + well-known now point at localhost HTTP, not a file path.
      // Target path mirrors mount exactly so tailscale's strip-then-forward
      // is a no-op; otherwise SPAs at /<mount>/ redirect-loop.
      const hubCall = serveCalls.find((c) => c.includes("--set-path=/"));
      expect(hubCall?.[hubCall.length - 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

      const wkCall = serveCalls.find((c) => c.includes("--set-path=/.well-known/parachute.json"));
      expect(wkCall?.[wkCall.length - 1]).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/\.well-known\/parachute\.json$/,
      );

      // Non-vault service targets include the mount path so tailscale's
      // strip-then-forward is a no-op against base-aware backends.
      const notesCall = serveCalls.find((c) => c.includes("--set-path=/notes"));
      expect(notesCall?.[notesCall.length - 1]).toBe("http://127.0.0.1:5173/notes");
      // Vault mount targets the hub's loopback port (the hub re-proxies to
      // the right vault backend on each request) — port is dynamic per test.
      const vaultCall = serveCalls.find((c) => c.includes("--set-path=/vault/"));
      expect(vaultCall?.[vaultCall.length - 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vault\/$/);

      expect(existsSync(h.wellKnownPath)).toBe(true);
      expect(existsSync(h.hubPath)).toBe(true);
      const wk = JSON.parse(await Bun.file(h.wellKnownPath).text());
      expect(wk.vaults).toHaveLength(1);

      const state = readExposeState(h.statePath);
      expect(state?.layer).toBe("tailnet");
      expect(state?.mode).toBe("path");
      expect(state?.entries).toHaveLength(8);
      // All entries are proxy now — no file-backed tailscale serve.
      expect(state?.entries.every((e) => e.kind === "proxy")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("spawns hub server with --port + --well-known-dir", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner } = makeRunner();
      const { spawner, calls: hubCalls } = makeHubSpawner(7777);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(hubCalls).toHaveLength(1);
      const cmd = hubCalls[0] ?? [];
      expect(cmd[0]).toBe("bun");
      expect(cmd).toContain("--port");
      expect(cmd).toContain("--well-known-dir");
      expect(cmd).toContain(h.wellKnownDir);
    } finally {
      h.cleanup();
    }
  });

  test("trailing-slash mount preserves trailing slash in target URL", async () => {
    // Aaron hit ERR_TOO_MANY_REDIRECTS on /notes/ because tailscale strips
    // the prefix, Vite (base=/notes) redirects back to /notes/, tailscale
    // strips again, loop. Pinning target = mount byte-for-byte breaks that.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-notes",
          port: 5173,
          paths: ["/notes/"],
          health: "/notes/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      const notesCall = serveCalls.find((c) => c.includes("--set-path=/notes/"));
      expect(notesCall).toBeDefined();
      expect(notesCall?.[notesCall.length - 1]).toBe("http://127.0.0.1:5173/notes/");
    } finally {
      h.cleanup();
    }
  });

  test("legacy paths:[/] entry is remapped to /<shortname> with warning", async () => {
    const h = makeHarness();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.2.4" },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);

      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      const mounts = serveCalls.map((c) => c.find((a) => a.startsWith("--set-path="))).sort();
      // Even with the legacy `/` remap, the vault rolls into the consolidated
      // `/vault/` mount → hub. The remap warning still fires; the mount shape
      // just doesn't reflect the original `/<shortname>` since #144.
      expect(mounts).toContain("--set-path=/vault/");
      expect(mounts).toContain("--set-path=/");
      expect(mounts.filter((m) => m === "--set-path=/")).toHaveLength(1);

      expect(logs.join("\n")).toMatch(/parachute-vault claims "\/"; hub page lives there/);
    } finally {
      h.cleanup();
    }
  });

  test("empty manifest exits 1 with hint", async () => {
    const h = makeHarness();
    try {
      const { runner } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/No services installed/);
    } finally {
      h.cleanup();
    }
  });

  test("missing tailscale exits 1 with install hint", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const runner: Runner = async () => {
        throw new Error("spawn tailscale ENOENT");
      };
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/tailscale is not installed/);
    } finally {
      h.cleanup();
    }
  });

  test("idempotent re-run: tears down prior state first", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/old-service",
              target: "http://127.0.0.1:9999",
              service: "parachute-old",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      const offs = calls.filter((c) => c[c.length - 1] === "off");
      expect(offs).toHaveLength(1);
      expect(offs[0]).toContain("--set-path=/old-service");
    } finally {
      h.cleanup();
    }
  });

  test("warns (but still exposes) when a service port isn't responding", async () => {
    // Aaron hit this: vault was quietly stopped, `parachute expose tailnet`
    // happily proxied /vault/default to a dead port, every request 502'd.
    // Now we probe and warn — but don't fail, so users can stand up layers
    // before starting services if they want.
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        // vault is up; notes is down.
        servicePortProbe: async (port) => port === 1940,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toMatch(/parachute-notes \(port 5173\) is not responding/);
      expect(joined).toMatch(/parachute start notes/);
      expect(joined).not.toMatch(/parachute-vault.*not responding/);
      // Bringup still happened — 4 service entries + 4 OAuth proxies got staged.
      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      expect(serveCalls).toHaveLength(8);
    } finally {
      h.cleanup();
    }
  });

  test("bringup failure propagates exit code", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const runner: Runner = async (cmd) => {
        if (cmd[1] === "version") return { code: 0, stdout: "", stderr: "" };
        if (cmd[1] === "status") {
          return {
            code: 0,
            stdout: JSON.stringify({ Self: { DNSName: "parachute.taildf9ce2.ts.net." } }),
            stderr: "",
          };
        }
        if (cmd[1] === "serve" && cmd.includes("--bg")) {
          return { code: 2, stdout: "", stderr: "port 443 already in use" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(2);
      expect(logs.join("\n")).toMatch(/Bringup failed/);
    } finally {
      h.cleanup();
    }
  });

  test("emits 4 OAuth proxies targeting the hub origin (hub IS the IdP)", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);

      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      const oauthTargets = new Map<string, string>();
      for (const c of serveCalls) {
        const mount = c.find((a) => a.startsWith("--set-path="))?.slice("--set-path=".length);
        if (
          mount &&
          (mount.startsWith("/oauth/") || mount === "/.well-known/oauth-authorization-server")
        ) {
          oauthTargets.set(mount, c[c.length - 1] ?? "");
        }
      }
      expect(oauthTargets.get("/.well-known/oauth-authorization-server")).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-authorization-server$/,
      );
      expect(oauthTargets.get("/oauth/authorize")).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize$/,
      );
      expect(oauthTargets.get("/oauth/token")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/token$/);
      expect(oauthTargets.get("/oauth/register")).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/oauth\/register$/,
      );

      const state = readExposeState(h.statePath);
      expect(state?.hubOrigin).toBe("https://parachute.taildf9ce2.ts.net");
    } finally {
      h.cleanup();
    }
  });

  test("emits OAuth proxies even when no vault is installed (hub IS the IdP)", async () => {
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-notes",
          port: 5173,
          paths: ["/notes"],
          health: "/notes/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);

      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      // Hub + well-known + notes + 4 OAuth proxies = 7. The hub serves OAuth
      // regardless of which services are installed.
      expect(serveCalls).toHaveLength(7);
      const oauthMounts = serveCalls
        .map((c) => c.find((a) => a.startsWith("--set-path=")))
        .filter(
          (m): m is string => !!m && (m.includes("/oauth/") || m.endsWith("authorization-server")),
        );
      expect(oauthMounts).toHaveLength(4);
    } finally {
      h.cleanup();
    }
  });

  test("--hub-origin override wins over derived origin and lands in state", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        hubOrigin: "https://hub.example.com/",
        log: () => {},
      });
      expect(code).toBe(0);
      const state = readExposeState(h.statePath);
      // Trailing slash stripped by deriveHubOrigin.
      expect(state?.hubOrigin).toBe("https://hub.example.com");
    } finally {
      h.cleanup();
    }
  });
});

describe("expose tailnet off", () => {
  test("no-op when no prior state", async () => {
    const h = makeHarness();
    try {
      const { runner, calls } = makeRunner();
      const logs: string[] = [];
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/Nothing to tear down/);
    } finally {
      h.cleanup();
    }
  });

  test("tears down every tracked entry, stops hub, and clears state", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1939",
              service: "hub",
            },
            {
              kind: "proxy",
              mount: "/.well-known/parachute.json",
              target: "http://127.0.0.1:1939/.well-known/parachute.json",
              service: "well-known",
            },
          ],
        },
        h.statePath,
      );
      await Bun.write(h.wellKnownPath, "{}\n");
      await Bun.write(h.hubPath, "<html/>\n");
      writePid("hub", 4242, h.configDir);
      const { runner, calls } = makeRunner();
      const signals: NodeJS.Signals[] = [];
      let aliveNow = true;
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: {
          kill: (_pid, sig) => {
            signals.push(sig as NodeJS.Signals);
            aliveNow = false;
          },
          alive: () => aliveNow,
          sleep: async () => {},
          now: () => 0,
        },
        log: () => {},
      });
      expect(code).toBe(0);
      expect(calls.every((c) => c[c.length - 1] === "off")).toBe(true);
      expect(calls).toHaveLength(2);
      expect(existsSync(h.statePath)).toBe(false);
      expect(existsSync(h.wellKnownPath)).toBe(false);
      expect(existsSync(h.hubPath)).toBe(false);
      // Hub was running and got stopped.
      expect(signals).toContain("SIGTERM");
    } finally {
      h.cleanup();
    }
  });

  test("leaves state in place on teardown failure", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1940",
              service: "parachute-vault",
            },
          ],
        },
        h.statePath,
      );
      const runner: Runner = async () => ({ code: 5, stdout: "", stderr: "tailscale blew up" });
      const logs: string[] = [];
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(5);
      expect(existsSync(h.statePath)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("tailnet off does not tear down public exposure or stop the hub", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "public",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: true,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1939",
              service: "hub",
            },
          ],
        },
        h.statePath,
      );
      writePid("hub", 4242, h.configDir);
      const { runner, calls } = makeRunner();
      let killCalled = false;
      const logs: string[] = [];
      const code = await exposeTailnet("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: {
          kill: () => {
            killCalled = true;
          },
          alive: () => false,
          sleep: async () => {},
          now: () => 0,
        },
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(existsSync(h.statePath)).toBe(true);
      expect(killCalled).toBe(false);
      expect(logs.join("\n")).toMatch(/Current exposure is Public/);
    } finally {
      h.cleanup();
    }
  });
});

describe("expose public up", () => {
  test("routes every bringup through `tailscale funnel` and records layer=public", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);

      // Modern tailscale (1.82+) rejects `serve --funnel`; public mode must use
      // the `funnel` subcommand instead.
      const funnelCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "funnel" && c.includes("--bg"),
      );
      // 4 baseline mounts + 4 OAuth proxies (vault seeded).
      expect(funnelCalls).toHaveLength(8);
      // Never emit the legacy `serve --funnel` shape.
      expect(calls.every((c) => !c.includes("--funnel"))).toBe(true);
      expect(calls.every((c) => !(c[1] === "serve" && c.includes("--bg")))).toBe(true);

      const state = readExposeState(h.statePath);
      expect(state?.layer).toBe("public");
      expect(state?.funnel).toBe(true);
      expect(state?.entries).toHaveLength(8);

      expect(logs.join("\n")).toMatch(/Public exposure active/);
    } finally {
      h.cleanup();
    }
  });

  test("switching from public to tailnet tears prior state down via `tailscale funnel … off`", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      writeExposeState(
        {
          version: 1,
          layer: "public",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: true,
          entries: [
            {
              kind: "proxy",
              mount: "/vault/default",
              target: "http://127.0.0.1:1940/vault/default",
              service: "parachute-vault",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      // Prior was public → teardown must use `tailscale funnel … off`,
      // not `tailscale serve … off` (which wouldn't drop the funnel entry on 1.82+).
      const offs = calls.filter((c) => c[c.length - 1] === "off");
      expect(offs).toHaveLength(1);
      expect(offs[0]?.[1]).toBe("funnel");
    } finally {
      h.cleanup();
    }
  });

  test("switching from tailnet to public tears down prior state first", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1940",
              service: "parachute-vault",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      const offs = calls.filter((c) => c[c.length - 1] === "off");
      expect(offs).toHaveLength(1);
      const state = readExposeState(h.statePath);
      expect(state?.layer).toBe("public");
    } finally {
      h.cleanup();
    }
  });
});

describe("expose public off", () => {
  test("tears down public exposure via `tailscale funnel … off` and clears state", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "public",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: true,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1939",
              service: "hub",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const code = await exposePublic("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: () => {},
      });
      expect(code).toBe(0);
      // Public teardown must use the funnel subcommand, matching bringup.
      const offCalls = calls.filter((c) => c[c.length - 1] === "off");
      expect(offCalls.length).toBeGreaterThan(0);
      expect(offCalls.every((c) => c[1] === "funnel")).toBe(true);
      expect(existsSync(h.statePath)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("public off does not tear down tailnet exposure", async () => {
    const h = makeHarness();
    try {
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: "http://127.0.0.1:1940",
              service: "parachute-vault",
            },
          ],
        },
        h.statePath,
      );
      const { runner, calls } = makeRunner();
      const logs: string[] = [];
      const code = await exposePublic("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(existsSync(h.statePath)).toBe(true);
      expect(logs.join("\n")).toMatch(/Current exposure is Tailnet/);
    } finally {
      h.cleanup();
    }
  });
});

describe("expose publicExposure filter", () => {
  // Launch-blocker: services without auth should never be mounted on
  // tailnet/funnel. The filter reads `publicExposure` from each entry (or
  // derives a safe default from the service spec) and withholds non-"allowed"
  // services from the tailscale serve plan.
  test("explicit loopback keeps the service off the serve plan", async () => {
    const h = makeHarness();
    try {
      // Vault is mounted as usual; scribe declares loopback and is withheld.
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
          publicExposure: "allowed",
        },
        h.manifestPath,
      );
      upsertService(
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
          publicExposure: "loopback",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);

      const serveCalls = calls.filter(
        (c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"),
      );
      const mounts = serveCalls.map((c) => c.find((a) => a.startsWith("--set-path=")));
      // Vault rolls into the consolidated `/vault/` mount → hub (#144);
      // its 4 OAuth proxies, hub, and well-known are still individually
      // mounted. /scribe is loopback-only and absent.
      expect(mounts).toContain("--set-path=/vault/");
      expect(mounts).not.toContain("--set-path=/scribe");

      // Operator-visible notice explaining the withhold.
      expect(logs.join("\n")).toMatch(
        /parachute-scribe is loopback-only — loopback-only by service declaration/,
      );

      // State file reflects the reduced plan so teardown doesn't trip on
      // entries that were never brought up.
      const state = readExposeState(h.statePath);
      expect(state?.entries.some((e) => e.mount === "/scribe")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("explicit auth-required behaves like loopback at launch", async () => {
    // auth-required is the future-looking declaration for a service that
    // wants auth but hasn't confirmed it's configured. Today the CLI treats
    // it identically to loopback — still no funnel/tailnet exposure.
    const h = makeHarness();
    try {
      seedServices(h.manifestPath); // vault + notes, both allowed by default
      upsertService(
        {
          name: "parachute-channel",
          port: 1941,
          paths: ["/channel"],
          health: "/channel/health",
          version: "0.1.0",
          publicExposure: "auth-required",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      const mounts = calls
        .filter((c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"))
        .map((c) => c.find((a) => a.startsWith("--set-path=")));
      expect(mounts).not.toContain("--set-path=/channel");
      expect(logs.join("\n")).toMatch(/parachute-channel is loopback-only — auth-required/);
    } finally {
      h.cleanup();
    }
  });

  test("missing publicExposure + spec kind=api, hasAuth=false → loopback default (scribe)", async () => {
    // Scribe today has no auth gate; its ServiceSpec says so (kind: "api",
    // hasAuth: false). With publicExposure absent we should still withhold.
    // This is the safe-by-default case for services that haven't yet been
    // updated to declare their exposure.
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      upsertService(
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
          // publicExposure intentionally absent — exercises spec-derived default
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      const mounts = calls
        .filter((c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"))
        .map((c) => c.find((a) => a.startsWith("--set-path=")));
      expect(mounts).not.toContain("--set-path=/scribe");
      // Reason text points operators at the missing auth gate.
      expect(logs.join("\n")).toMatch(
        /parachute-scribe is loopback-only — auth-required: service has no auth gate/,
      );
    } finally {
      h.cleanup();
    }
  });

  test("missing publicExposure on a known auth'd api service (vault) still exposes", async () => {
    // vault's ServiceSpec has hasAuth: true, so the absence of publicExposure
    // should not hide it — the back-compat path for every vault entry written
    // before this field existed.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      const mounts = calls
        .filter((c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"))
        .map((c) => c.find((a) => a.startsWith("--set-path=")));
      // Vault → consolidated `/vault/` mount (#144).
      expect(mounts).toContain("--set-path=/vault/");
    } finally {
      h.cleanup();
    }
  });

  test("unknown third-party service without publicExposure defaults to allowed", async () => {
    // A service not in SERVICE_SPECS has no kind/hasAuth signal. We err on
    // the side of preserving current behavior (back-compat) so operators'
    // existing exposures don't silently stop working on upgrade. If the
    // third-party wants to opt out, they can write publicExposure: "loopback"
    // into their services.json entry.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-rando",
          port: 1947,
          paths: ["/rando"],
          health: "/rando/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      const mounts = calls
        .filter((c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"))
        .map((c) => c.find((a) => a.startsWith("--set-path=")));
      expect(mounts).toContain("--set-path=/rando");
    } finally {
      h.cleanup();
    }
  });
});

describe("expose auto-restart of hub-dependent services", () => {
  // Launch-day bug (2026-04-23): `expose public` updated hubOrigin in
  // expose-state.json, but a vault already running kept its stale
  // PARACHUTE_HUB_ORIGIN in memory, so the OAuth issuer didn't match what
  // clients saw and claude.ai MCP failed to reach the server. The CLI used
  // to print a "Restart vault to pick up…" hint that got lost in the wall
  // of expose output. Auto-restart the service instead.
  test("restarts vault when vault is running", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const { runner } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const restarted: string[] = [];
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        alive: () => true,
        restartService: async (short) => {
          restarted.push(short);
          return 0;
        },
        log: () => {},
      });
      expect(code).toBe(0);
      expect(restarted).toEqual(["vault"]);
    } finally {
      h.cleanup();
    }
  });

  test("skips restart when vault is not running", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      // No writePid → vault has no pidfile → processState returns "unknown".
      const { runner } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const restarted: string[] = [];
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        alive: () => true,
        restartService: async (short) => {
          restarted.push(short);
          return 0;
        },
        log: () => {},
      });
      expect(code).toBe(0);
      expect(restarted).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("skips restart when pidfile is stale (process dead)", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const { runner } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const restarted: string[] = [];
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        // Simulate pid-file-present-but-process-dead. processState returns
        // "stopped", not "running", so we should skip.
        alive: () => false,
        restartService: async (short) => {
          restarted.push(short);
          return 0;
        },
        log: () => {},
      });
      expect(code).toBe(0);
      expect(restarted).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("restart failure logs warning but expose still succeeds", async () => {
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const { runner } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const logs: string[] = [];
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        alive: () => true,
        restartService: async () => 1,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/vault restart failed/);
      expect(logs.join("\n")).toMatch(/parachute restart vault/);
    } finally {
      h.cleanup();
    }
  });
});

describe("expose teardown tolerance for already-gone entries", () => {
  // Launch-day bug (2026-04-23): Aaron ran `tailscale funnel reset` while
  // debugging, then re-ran `parachute expose public`. expose-state.json still
  // recorded 8 entries; the CLI tried to tear them down; tailscale returned
  // `error: failed to remove web serve: handler does not exist` for each; the
  // CLI aborted and never got to bringup. Tailscale's `off` is idempotent
  // from the user's perspective — if the handler is already gone, that's the
  // outcome we wanted.
  function makePublicPriorState(statePath: string, entryCount: number): void {
    const entries = Array.from({ length: entryCount }, (_, i) => ({
      kind: "proxy" as const,
      mount: `/svc${i}`,
      target: `http://127.0.0.1:${2000 + i}`,
      service: `parachute-svc${i}`,
    }));
    writeExposeState(
      {
        version: 1,
        layer: "public",
        mode: "path",
        canonicalFqdn: "parachute.taildf9ce2.ts.net",
        port: 443,
        funnel: true,
        entries,
      },
      statePath,
    );
  }

  test("exposeOff treats 'handler does not exist' as success and clears state", async () => {
    const h = makeHarness();
    try {
      makePublicPriorState(h.statePath, 3);
      const runner: Runner = async (cmd) => {
        if (cmd[cmd.length - 1] === "off") {
          return {
            code: 1,
            stdout: "",
            stderr: "error: failed to remove web serve: handler does not exist",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const logs: string[] = [];
      const code = await exposePublic("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(existsSync(h.statePath)).toBe(false);
      const joined = logs.join("\n");
      expect(joined).toMatch(/already gone/);
      expect(joined).toMatch(/✓ Public \(Funnel\) exposure removed/);
    } finally {
      h.cleanup();
    }
  });

  test("exposeOff handles a mix of clean and already-gone entries", async () => {
    const h = makeHarness();
    try {
      makePublicPriorState(h.statePath, 3);
      let i = 0;
      const runner: Runner = async (cmd) => {
        if (cmd[cmd.length - 1] === "off") {
          const idx = i++;
          if (idx === 1) {
            return {
              code: 1,
              stdout: "",
              stderr: "error: failed to remove web serve: listener does not exist",
            };
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const code = await exposePublic("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: () => {},
      });
      expect(code).toBe(0);
      expect(existsSync(h.statePath)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("exposeOff still aborts on a real (non-already-gone) error", async () => {
    const h = makeHarness();
    try {
      makePublicPriorState(h.statePath, 2);
      const runner: Runner = async (cmd) => {
        if (cmd[cmd.length - 1] === "off") {
          return {
            code: 1,
            stdout: "",
            stderr: "failed to connect to tailscaled: is it running?",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const logs: string[] = [];
      const code = await exposePublic("off", {
        runner,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubStopOpts: hubStopOpts(),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(existsSync(h.statePath)).toBe(true);
      expect(logs.join("\n")).toMatch(/Teardown failed/);
    } finally {
      h.cleanup();
    }
  });

  test("exposeUp tolerates already-gone prior entries and proceeds to bringup", async () => {
    // Aaron's exact repro: prior expose-state lingered after an external
    // `tailscale funnel reset`, re-running `parachute expose public` aborted
    // because every teardown said "handler does not exist".
    const h = makeHarness();
    try {
      seedServices(h.manifestPath);
      makePublicPriorState(h.statePath, 2);
      const { spawner } = makeHubSpawner(1111);
      const bringupCalls: string[][] = [];
      const runner: Runner = async (cmd) => {
        if (cmd[0] === "tailscale" && cmd[1] === "version") {
          return { code: 0, stdout: "1.96.5\n", stderr: "" };
        }
        if (cmd[0] === "tailscale" && cmd[1] === "status" && cmd[2] === "--json") {
          return {
            code: 0,
            stdout: JSON.stringify({ Self: { DNSName: "parachute.taildf9ce2.ts.net." } }),
            stderr: "",
          };
        }
        if (cmd[cmd.length - 1] === "off") {
          return {
            code: 1,
            stdout: "",
            stderr: "error: failed to remove web serve: handler does not exist",
          };
        }
        if (cmd.includes("--bg")) {
          bringupCalls.push([...cmd]);
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const code = await exposePublic("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(bringupCalls.length).toBeGreaterThan(0);
      const state = readExposeState(h.statePath);
      expect(state?.layer).toBe("public");
    } finally {
      h.cleanup();
    }
  });
});

describe("expose vault mount consolidation (#144)", () => {
  // Pre-#144: tailscale plan emitted one mount per vault path. New vault →
  // had to re-run `parachute expose` to get a tailnet route. Post-#144: a
  // single `/vault/` → hub mount, hub does the per-request lookup.

  test("single vault, single path → exactly one /vault/ mount, no per-instance entry", async () => {
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.4.0",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      const mounts = calls
        .filter((c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"))
        .map((c) => c.find((a) => a.startsWith("--set-path=")));
      expect(mounts).toContain("--set-path=/vault/");
      expect(mounts).not.toContain("--set-path=/vault/default");
    } finally {
      h.cleanup();
    }
  });

  test("multi-path single ServiceEntry still emits exactly one /vault/ mount", async () => {
    // The current vault manifest shape: one ServiceEntry whose `paths` lists
    // every instance. The plan must collapse them all to the hub-routed
    // `/vault/` instead of one mount per instance.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default", "/vault/techne"],
          health: "/vault/default/health",
          version: "0.4.0",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      const mounts = calls
        .filter((c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"))
        .map((c) => c.find((a) => a.startsWith("--set-path=")));
      const vaultMounts = mounts.filter((m) => m?.startsWith("--set-path=/vault"));
      expect(vaultMounts).toEqual(["--set-path=/vault/"]);
    } finally {
      h.cleanup();
    }
  });

  test("multiple separate vault ServiceEntries still emit exactly one /vault/ mount", async () => {
    // Pathological but representable: someone might install a second
    // parachute-vault-archive backend alongside the bare parachute-vault.
    // Both fold into the single `/vault/` mount; hub disambiguates per
    // request.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.4.0",
        },
        h.manifestPath,
      );
      upsertService(
        {
          name: "parachute-vault-archive",
          port: 1941,
          paths: ["/vault/archive"],
          health: "/vault/archive/health",
          version: "0.4.0",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      const mounts = calls
        .filter((c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"))
        .map((c) => c.find((a) => a.startsWith("--set-path=")));
      const vaultMounts = mounts.filter((m) => m?.startsWith("--set-path=/vault"));
      expect(vaultMounts).toEqual(["--set-path=/vault/"]);
    } finally {
      h.cleanup();
    }
  });

  test("no vault installed → no /vault/ mount in the plan", async () => {
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-notes",
          port: 5173,
          paths: ["/notes"],
          health: "/notes/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      const { runner, calls } = makeRunner();
      const { spawner } = makeHubSpawner(1111);
      const code = await exposeTailnet("up", {
        runner,
        manifestPath: h.manifestPath,
        statePath: h.statePath,
        wellKnownPath: h.wellKnownPath,
        hubPath: h.hubPath,
        wellKnownDir: h.wellKnownDir,
        configDir: h.configDir,
        hubEnsureOpts: hubEnsureOpts(spawner),
        servicePortProbe: allServicesUp,
        log: () => {},
      });
      expect(code).toBe(0);
      const mounts = calls
        .filter((c) => c[0] === "tailscale" && c[1] === "serve" && c.includes("--bg"))
        .map((c) => c.find((a) => a.startsWith("--set-path=")));
      expect(mounts).not.toContain("--set-path=/vault/");
      // /notes is still individually mounted — non-vault services keep
      // their direct route.
      expect(mounts).toContain("--set-path=/notes");
    } finally {
      h.cleanup();
    }
  });
});
