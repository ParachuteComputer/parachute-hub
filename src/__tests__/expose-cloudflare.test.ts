import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CloudflaredTunnelRecord,
  findTunnelRecord,
  readCloudflaredState,
  withTunnelRecord,
  writeCloudflaredState,
} from "../cloudflare/state.ts";
import {
  type CloudflaredSpawner,
  exposeCloudflareOff,
  exposeCloudflareUp,
} from "../commands/expose-cloudflare.ts";
import type { CommandResult, Runner } from "../tailscale/run.ts";

interface TestEnv {
  configDir: string;
  manifestPath: string;
  statePath: string;
  configPath: string;
  logPath: string;
  cloudflaredHome: string;
  cleanup: () => void;
}

function makeEnv(opts: { includeVault?: boolean; loggedIn?: boolean } = {}): TestEnv {
  const includeVault = opts.includeVault ?? true;
  const loggedIn = opts.loggedIn ?? true;

  const dir = mkdtempSync(join(tmpdir(), "pcli-cf-cmd-"));
  const configDir = join(dir, "parachute");
  const cloudflaredHome = join(dir, "cloudflared");
  const manifestPath = join(configDir, "services.json");
  const statePath = join(configDir, "cloudflared-state.json");
  const configPath = join(configDir, "cloudflared", "parachute", "config.yml");
  const logPath = join(configDir, "cloudflared", "parachute", "cloudflared.log");

  require("node:fs").mkdirSync(configDir, { recursive: true });
  require("node:fs").mkdirSync(cloudflaredHome, { recursive: true });

  if (loggedIn) {
    writeFileSync(join(cloudflaredHome, "cert.pem"), "---");
  }

  const services = includeVault
    ? [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.3.0",
        },
      ]
    : [];
  writeFileSync(manifestPath, JSON.stringify({ services }, null, 2));

  return {
    configDir,
    manifestPath,
    statePath,
    configPath,
    logPath,
    cloudflaredHome,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

interface RunnerCall {
  cmd: string[];
}

function queueRunner(results: CommandResult[]): { runner: Runner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  let i = 0;
  const runner: Runner = async (cmd) => {
    calls.push({ cmd: [...cmd] });
    const out = results[i++];
    if (!out) throw new Error(`runner called more than the ${results.length} queued results`);
    return out;
  };
  return { runner, calls };
}

function fakeSpawner(pid: number): { spawner: CloudflaredSpawner; seen: string[][] } {
  const seen: string[][] = [];
  const spawner: CloudflaredSpawner = {
    spawn(cmd, logFile) {
      seen.push([...cmd]);
      // Touch the log file so tests that probe existsSync(logPath) can assert it.
      require("node:fs").mkdirSync(require("node:path").dirname(logFile), { recursive: true });
      writeFileSync(logFile, "");
      return pid;
    },
  };
  return { spawner, seen };
}

describe("exposeCloudflareUp", () => {
  test("happy path: creates tunnel, routes DNS, writes config + state, spawns cloudflared", async () => {
    const env = makeEnv();
    try {
      const uuid = "2c1a7c7e-1234-5678-9abc-def012345678";
      const { runner, calls } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" }, // --version preflight
        { code: 0, stdout: "[]", stderr: "" }, // tunnel list (none yet)
        {
          code: 0,
          stdout: `Tunnel credentials written to ${env.cloudflaredHome}/${uuid}.json.\nCreated tunnel parachute with id ${uuid}\n`,
          stderr: "",
        }, // tunnel create
        { code: 0, stdout: "", stderr: "" }, // route dns
      ]);
      const { spawner, seen } = fakeSpawner(42000);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        alive: () => false,
        kill: () => {},
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        now: () => new Date("2026-04-22T12:00:00Z"),
      });

      expect(code).toBe(0);
      expect(calls.map((c) => c.cmd[0])).toEqual([
        "cloudflared",
        "cloudflared",
        "cloudflared",
        "cloudflared",
      ]);
      expect(calls[0]!.cmd).toEqual(["cloudflared", "--version"]);
      expect(calls[1]!.cmd).toEqual(["cloudflared", "tunnel", "list", "--output", "json"]);
      expect(calls[2]!.cmd).toEqual(["cloudflared", "tunnel", "create", "parachute"]);
      expect(calls[3]!.cmd).toEqual([
        "cloudflared",
        "tunnel",
        "route",
        "dns",
        "--overwrite-dns",
        "parachute",
        "vault.example.com",
      ]);
      expect(seen[0]).toEqual(["cloudflared", "tunnel", "--config", env.configPath, "run"]);

      const state = readCloudflaredState(env.statePath);
      expect(state).toEqual({
        version: 2,
        tunnels: {
          parachute: {
            pid: 42000,
            tunnelUuid: uuid,
            tunnelName: "parachute",
            hostname: "vault.example.com",
            startedAt: "2026-04-22T12:00:00.000Z",
            configPath: env.configPath,
          },
        },
      });

      const yaml = readFileSync(env.configPath, "utf8");
      expect(yaml).toContain(`tunnel: ${uuid}`);
      expect(yaml).toContain("- hostname: vault.example.com");
      expect(yaml).toContain("service: http://localhost:1940");

      // Security copy surfaces both paths plus a pointer to the auth doc.
      const joined = logs.join("\n");
      expect(joined).toContain("parachute auth set-password");
      expect(joined).toContain("parachute vault tokens create");
      expect(joined).toContain("auth-model.md");
    } finally {
      env.cleanup();
    }
  });

  test("reuses existing tunnel when name already present", async () => {
    const env = makeEnv();
    try {
      const uuid = "bbbbbbbb-0000-0000-0000-000000000002";
      const { runner, calls } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        {
          code: 0,
          stdout: JSON.stringify([{ id: uuid, name: "parachute" }]),
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" }, // route dns
      ]);
      const { spawner } = fakeSpawner(42001);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        alive: () => false,
        kill: () => {},
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
      });
      expect(code).toBe(0);
      // No `tunnel create` — only list + route.
      const cmds = calls.map((c) => c.cmd.join(" "));
      expect(cmds.some((c) => c.startsWith("cloudflared tunnel create"))).toBe(false);
      expect(logs.some((l) => l.includes("Reusing existing tunnel"))).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("rejects invalid hostnames up front (no cloudflared calls)", async () => {
    const env = makeEnv();
    try {
      const { runner, calls } = queueRunner([]);
      const { spawner } = fakeSpawner(0);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("not-a-hostname", {
        runner,
        spawner,
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
      });

      expect(code).toBe(1);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toContain("--domain must be a valid hostname");
    } finally {
      env.cleanup();
    }
  });

  test("rejects invalid tunnel names up front", async () => {
    const env = makeEnv();
    try {
      const { runner, calls } = queueRunner([]);
      const { spawner } = fakeSpawner(0);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        tunnelName: "bad name with spaces",
      });

      expect(code).toBe(1);
      expect(calls).toHaveLength(0);
      expect(logs.join("\n")).toContain("--tunnel-name must be alphanumeric");
    } finally {
      env.cleanup();
    }
  });

  test("prints install hint when cloudflared is missing", async () => {
    const env = makeEnv();
    try {
      const { runner, calls } = queueRunner([
        { code: 127, stdout: "", stderr: "command not found" },
      ]);
      const { spawner } = fakeSpawner(0);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
      });

      expect(code).toBe(1);
      expect(calls).toHaveLength(1);
      expect(logs.join("\n")).toContain("cloudflared is not installed");
    } finally {
      env.cleanup();
    }
  });

  test("prints login hint when cert.pem is absent", async () => {
    const env = makeEnv({ loggedIn: false });
    try {
      const { runner } = queueRunner([{ code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" }]);
      const { spawner } = fakeSpawner(0);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
      });

      expect(code).toBe(1);
      expect(logs.join("\n")).toContain("cloudflared tunnel login");
    } finally {
      env.cleanup();
    }
  });

  test("errors out when vault isn't installed", async () => {
    const env = makeEnv({ includeVault: false });
    try {
      const { runner } = queueRunner([{ code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" }]);
      const { spawner } = fakeSpawner(0);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
      });

      expect(code).toBe(1);
      expect(logs.join("\n")).toContain("parachute install vault");
    } finally {
      env.cleanup();
    }
  });

  test("route-dns failure surfaces a dashboard-pointing hint", async () => {
    const env = makeEnv();
    try {
      const uuid = "2c1a7c7e-1234-5678-9abc-def012345678";
      const { runner } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: JSON.stringify([{ id: uuid, name: "parachute" }]), stderr: "" },
        {
          code: 1,
          stdout: "",
          stderr: "Failed to add route: code: 1000, reason: Invalid DNS zone",
        },
      ]);
      const { spawner } = fakeSpawner(0);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
      });

      expect(code).toBe(1);
      const joined = logs.join("\n");
      expect(joined).toContain("dash.cloudflare.com");
      expect(joined).toContain("Invalid DNS zone");
    } finally {
      env.cleanup();
    }
  });

  test("stops a prior cloudflared process before spawning a new one", async () => {
    const env = makeEnv();
    try {
      const priorRecord: CloudflaredTunnelRecord = {
        pid: 99999,
        tunnelUuid: "old-tunnel-uuid",
        tunnelName: "parachute",
        hostname: "vault.example.com",
        startedAt: "2026-04-21T00:00:00.000Z",
        configPath: env.configPath,
      };
      writeCloudflaredState({ version: 2, tunnels: { parachute: priorRecord } }, env.statePath);

      const { runner } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        {
          code: 0,
          stdout: JSON.stringify([
            { id: "cccccccc-0000-0000-0000-000000000003", name: "parachute" },
          ]),
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" }, // route dns
      ]);
      const { spawner } = fakeSpawner(42010);
      const killed: Array<{ pid: number; sig: NodeJS.Signals | number }> = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        alive: (pid) => pid === 99999,
        kill: (pid, sig) => killed.push({ pid, sig }),
        log: () => {},
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
      });

      expect(code).toBe(0);
      expect(killed).toEqual([{ pid: 99999, sig: "SIGTERM" }]);
      const state = readCloudflaredState(env.statePath);
      expect(findTunnelRecord(state, "parachute")?.pid).toBe(42010);
    } finally {
      env.cleanup();
    }
  });

  test("two tunnels with different --tunnel-name coexist in state", async () => {
    const env = makeEnv();
    try {
      const uuidA = "aaaa1111-aaaa-1111-aaaa-111111111111";
      const uuidB = "bbbb2222-bbbb-2222-bbbb-222222222222";
      // Up #1 — default name "parachute"
      const r1 = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: "[]", stderr: "" },
        {
          code: 0,
          stdout: `Created tunnel parachute with id ${uuidA}\n`,
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" },
      ]);
      const s1 = fakeSpawner(50001);
      const code1 = await exposeCloudflareUp("alpha.example.com", {
        runner: r1.runner,
        spawner: s1.spawner,
        alive: () => false,
        kill: () => {},
        log: () => {},
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        cloudflaredHome: env.cloudflaredHome,
        // Use defaults for configPath/logPath so they're per-tunnel-derived.
      });
      expect(code1).toBe(0);

      // Up #2 — explicit --tunnel-name "second"
      const r2 = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: "[]", stderr: "" },
        {
          code: 0,
          stdout: `Created tunnel second with id ${uuidB}\n`,
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" },
      ]);
      const s2 = fakeSpawner(50002);
      const code2 = await exposeCloudflareUp("beta.example.com", {
        runner: r2.runner,
        spawner: s2.spawner,
        alive: () => false,
        kill: () => {},
        log: () => {},
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        cloudflaredHome: env.cloudflaredHome,
        tunnelName: "second",
      });
      expect(code2).toBe(0);

      // Both tunnels should be present in state, keyed by tunnel name.
      const state = readCloudflaredState(env.statePath);
      expect(Object.keys(state?.tunnels ?? {}).sort()).toEqual(["parachute", "second"]);
      expect(findTunnelRecord(state, "parachute")?.hostname).toBe("alpha.example.com");
      expect(findTunnelRecord(state, "second")?.hostname).toBe("beta.example.com");
      expect(findTunnelRecord(state, "second")?.pid).toBe(50002);

      // Each tunnel should have written its own config file at the per-tunnel
      // path under `~/.parachute/cloudflared/<tunnelName>/config.yml`.
      const cfgA = findTunnelRecord(state, "parachute")?.configPath ?? "";
      const cfgB = findTunnelRecord(state, "second")?.configPath ?? "";
      expect(cfgA).not.toBe(cfgB);
      expect(cfgA.endsWith("/parachute/config.yml")).toBe(true);
      expect(cfgB.endsWith("/second/config.yml")).toBe(true);
      expect(existsSync(cfgA)).toBe(true);
      expect(existsSync(cfgB)).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});

describe("exposeCloudflareOff", () => {
  test("no-op when no state exists", async () => {
    const env = makeEnv();
    try {
      const logs: string[] = [];
      const code = await exposeCloudflareOff({
        statePath: env.statePath,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("Nothing to tear down");
    } finally {
      env.cleanup();
    }
  });

  test("SIGTERMs the process and clears state", async () => {
    const env = makeEnv();
    try {
      writeCloudflaredState(
        {
          version: 2,
          tunnels: {
            parachute: {
              pid: 55555,
              tunnelUuid: "dddddddd-0000-0000-0000-000000000004",
              tunnelName: "parachute",
              hostname: "vault.example.com",
              startedAt: "2026-04-22T12:00:00.000Z",
              configPath: env.configPath,
            },
          },
        },
        env.statePath,
      );
      const killed: number[] = [];
      const logs: string[] = [];
      const code = await exposeCloudflareOff({
        statePath: env.statePath,
        alive: () => true,
        kill: (pid) => killed.push(pid),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(killed).toEqual([55555]);
      expect(existsSync(env.statePath)).toBe(false);
      // Reassures the user that the tunnel definition isn't lost.
      expect(logs.join("\n")).toContain("remains defined in Cloudflare");
    } finally {
      env.cleanup();
    }
  });

  test("clears stale state when the process is already gone", async () => {
    const env = makeEnv();
    try {
      writeCloudflaredState(
        {
          version: 2,
          tunnels: {
            parachute: {
              pid: 55556,
              tunnelUuid: "eeeeeeee-0000-0000-0000-000000000005",
              tunnelName: "parachute",
              hostname: "vault.example.com",
              startedAt: "2026-04-22T12:00:00.000Z",
              configPath: env.configPath,
            },
          },
        },
        env.statePath,
      );
      const killed: number[] = [];
      const code = await exposeCloudflareOff({
        statePath: env.statePath,
        alive: () => false,
        kill: (pid) => killed.push(pid),
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed).toEqual([]);
      expect(existsSync(env.statePath)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  test("targets the named tunnel and leaves siblings intact", async () => {
    const env = makeEnv();
    try {
      const recordA: CloudflaredTunnelRecord = {
        pid: 60001,
        tunnelUuid: "aaaa-uuid",
        tunnelName: "alpha",
        hostname: "alpha.example.com",
        startedAt: "2026-04-23T10:00:00.000Z",
        configPath: "/tmp/alpha/config.yml",
      };
      const recordB: CloudflaredTunnelRecord = {
        pid: 60002,
        tunnelUuid: "bbbb-uuid",
        tunnelName: "beta",
        hostname: "beta.example.com",
        startedAt: "2026-04-23T11:00:00.000Z",
        configPath: "/tmp/beta/config.yml",
      };
      writeCloudflaredState(
        withTunnelRecord(withTunnelRecord(undefined, recordA), recordB),
        env.statePath,
      );

      const killed: number[] = [];
      const code = await exposeCloudflareOff({
        statePath: env.statePath,
        alive: () => true,
        kill: (pid) => killed.push(pid),
        log: () => {},
        tunnelName: "alpha",
      });
      expect(code).toBe(0);
      // Only alpha's pid is killed.
      expect(killed).toEqual([60001]);

      // beta is still recorded; alpha is gone.
      const state = readCloudflaredState(env.statePath);
      expect(findTunnelRecord(state, "alpha")).toBeUndefined();
      expect(findTunnelRecord(state, "beta")).toEqual(recordB);
    } finally {
      env.cleanup();
    }
  });

  test("reports tunnel-name mismatch and lists known tunnels", async () => {
    const env = makeEnv();
    try {
      const recordA: CloudflaredTunnelRecord = {
        pid: 60001,
        tunnelUuid: "aaaa-uuid",
        tunnelName: "alpha",
        hostname: "alpha.example.com",
        startedAt: "2026-04-23T10:00:00.000Z",
        configPath: "/tmp/alpha/config.yml",
      };
      writeCloudflaredState({ version: 2, tunnels: { alpha: recordA } }, env.statePath);

      const logs: string[] = [];
      const code = await exposeCloudflareOff({
        statePath: env.statePath,
        alive: () => true,
        kill: () => {},
        log: (l) => logs.push(l),
        tunnelName: "ghost",
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain('No Cloudflare exposure recorded for tunnel "ghost"');
      expect(logs.join("\n")).toContain("alpha");
      // alpha is untouched.
      const state = readCloudflaredState(env.statePath);
      expect(findTunnelRecord(state, "alpha")).toEqual(recordA);
    } finally {
      env.cleanup();
    }
  });
});
