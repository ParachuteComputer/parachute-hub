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
import { readEnvFileValues } from "../env-file.ts";
import { readExposeState } from "../expose-state.ts";
import { writeHubPort } from "../hub-control.ts";
import type { CommandResult, Runner } from "../tailscale/run.ts";

// Default seeded hub port used by tests with `skipHub: true`. The cloudflared
// path reads `<configDir>/hub/run/hub.port` instead of spawning a real hub.
const TEST_HUB_PORT = 1939;

interface TestEnv {
  configDir: string;
  manifestPath: string;
  statePath: string;
  exposeStatePath: string;
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
  const exposeStatePath = join(configDir, "expose-state.json");
  const configPath = join(configDir, "cloudflared", "parachute", "config.yml");
  const logPath = join(configDir, "cloudflared", "parachute", "cloudflared.log");

  require("node:fs").mkdirSync(configDir, { recursive: true });
  require("node:fs").mkdirSync(cloudflaredHome, { recursive: true });

  // Seed the hub port so `skipHub: true` invocations can resolve a port
  // without spawning the actual hub process. Matches the seam pattern used
  // by expose.test.ts (which threads `hubEnsureOpts` for the same purpose).
  writeHubPort(TEST_HUB_PORT, configDir);

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
    exposeStatePath,
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
      // Default tunnel name is now per-hostname (#491): vault.example.com →
      // parachute-vault-example-com. Each machine gets its own dedicated tunnel
      // so account-wide tunnels don't collide across boxes.
      const derived = "parachute-vault-example-com";
      const { runner, calls } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" }, // --version preflight
        { code: 0, stdout: "[]", stderr: "" }, // tunnel list (none yet)
        {
          code: 0,
          stdout: `Tunnel credentials written to ${env.cloudflaredHome}/${uuid}.json.\nCreated tunnel ${derived} with id ${uuid}\n`,
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
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
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
      expect(calls[2]!.cmd).toEqual(["cloudflared", "tunnel", "create", derived]);
      expect(calls[3]!.cmd).toEqual([
        "cloudflared",
        "tunnel",
        "route",
        "dns",
        "--overwrite-dns",
        derived,
        "vault.example.com",
      ]);
      expect(seen[0]).toEqual(["cloudflared", "tunnel", "--config", env.configPath, "run"]);

      const state = readCloudflaredState(env.statePath);
      expect(state).toEqual({
        version: 2,
        tunnels: {
          [derived]: {
            pid: 42000,
            tunnelUuid: uuid,
            tunnelName: derived,
            hostname: "vault.example.com",
            startedAt: "2026-04-22T12:00:00.000Z",
            configPath: env.configPath,
          },
        },
      });

      const yaml = readFileSync(env.configPath, "utf8");
      expect(yaml).toContain(`tunnel: ${uuid}`);
      expect(yaml).toContain("- hostname: vault.example.com");
      // Routes through the hub (not directly at vault). The hub dispatches
      // discovery / admin / OAuth / per-vault proxy / generic /<svc>/* —
      // same shape Tailscale Funnel uses. Pre-2026-05-27 this was
      // http://localhost:1940 (vault's port), which served vault's own 404
      // page on every request that wasn't /vault/<name>/...
      expect(yaml).toContain(`service: http://localhost:${TEST_HUB_PORT}`);

      // Security copy surfaces both paths plus a pointer to the auth doc.
      const joined = logs.join("\n");
      expect(joined).toContain("parachute auth set-password");
      // Scripts/machines path points at the hub-JWT mint (vault#412 / hub#466
      // DROPped `vault tokens create`), not the removed pvt_* command.
      expect(joined).toContain("parachute auth mint-token --scope vault:");
      expect(joined).toContain("Bearer <hub-jwt>");
      expect(joined).not.toContain("vault tokens create");
      expect(joined).not.toContain("pvt_");
      expect(joined).toContain("auth-model.md");
    } finally {
      env.cleanup();
    }
  });

  test("persists expose-state.json with the canonicalFqdn + public hubOrigin (Fix 1)", async () => {
    // The OAuth-iss bug: pre-fix the cloudflare path never wrote
    // expose-state.json, so `readExposeState()` returned undefined and
    // downstream consumers (init's resolveAdminUrl, lifecycle's
    // resolveHubOrigin, the vault .env PARACHUTE_HUB_ORIGIN persistence)
    // fell back to loopback — wrong OAuth `iss` on Cloudflare deploys.
    const env = makeEnv();
    try {
      const uuid = "eeeeeeee-0000-0000-0000-000000000005";
      const { runner } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: "[]", stderr: "" },
        {
          code: 0,
          stdout: `Tunnel credentials written to ${env.cloudflaredHome}/${uuid}.json.\nCreated tunnel parachute with id ${uuid}\n`,
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" },
      ]);
      const { spawner } = fakeSpawner(42200);

      // Pre-condition: no expose-state.json yet.
      expect(readExposeState(env.exposeStatePath)).toBeUndefined();

      const code = await exposeCloudflareUp("gitcoin.parachute.computer", {
        runner,
        spawner,
        alive: () => false,
        kill: () => {},
        log: () => {},
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        // Pin the legacy shared name so this test's substance (expose-state
        // write) is isolated from the per-hostname-derivation change (#491);
        // the queued runner output names the "parachute" tunnel.
        tunnelName: "parachute",
      });

      expect(code).toBe(0);
      const exposeState = readExposeState(env.exposeStatePath);
      expect(exposeState).toBeDefined();
      expect(exposeState?.layer).toBe("public");
      expect(exposeState?.mode).toBe("subdomain");
      expect(exposeState?.canonicalFqdn).toBe("gitcoin.parachute.computer");
      expect(exposeState?.funnel).toBe(false);
      expect(exposeState?.port).toBe(TEST_HUB_PORT);
      // The public origin OAuth clients will see — the load-bearing field.
      expect(exposeState?.hubOrigin).toBe("https://gitcoin.parachute.computer");
      // Single hub-catchall proxy entry (matches the Tailscale path's shape).
      expect(exposeState?.entries).toEqual([
        {
          kind: "proxy",
          mount: "/",
          target: `http://localhost:${TEST_HUB_PORT}`,
          service: "hub",
        },
      ]);
    } finally {
      env.cleanup();
    }
  });

  test("persists the public hub origin to vault/.env + restarts vault (Cloudflare 401 fix)", async () => {
    // The Cloudflare 401 P0: the cloudflare path wrote expose-state.json but —
    // unlike the Tailscale path, which auto-restarts vault and so flows the
    // public origin into vault/.env via lifecycle's persistVaultHubOrigin —
    // never touched vault's .env or restarted it. The launchd/systemd daemon
    // kept booting vault with NO PARACHUTE_HUB_ORIGIN → vault fell back to
    // loopback as its expected issuer → every hub-minted token (iss=public)
    // failed the iss check → 401. This asserts the durable .env write + the
    // running-vault restart that mirrors the Tailscale path.
    const env = makeEnv();
    try {
      // Seed vault as "running" so the restart branch fires. PID lives at
      // <configDir>/vault/run/vault.pid (see process-state.ts:pidPath).
      const vaultRun = join(env.configDir, "vault", "run");
      require("node:fs").mkdirSync(vaultRun, { recursive: true });
      writeFileSync(join(vaultRun, "vault.pid"), "99001");

      const uuid = "ffffffff-0000-0000-0000-000000000006";
      const { runner } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: "[]", stderr: "" },
        {
          code: 0,
          stdout: `Tunnel credentials written to ${env.cloudflaredHome}/${uuid}.json.\nCreated tunnel parachute with id ${uuid}\n`,
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" },
      ]);
      const { spawner } = fakeSpawner(42300);
      const restarted: string[] = [];

      const code = await exposeCloudflareUp("gitcoin-parachute.unforced.dev", {
        runner,
        spawner,
        // `alive` reports the seeded vault pid as running so processState() ===
        // "running" and the restart branch executes.
        alive: (pid) => pid === 99001,
        kill: () => {},
        log: () => {},
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        restartService: async (short) => {
          restarted.push(short);
          return 0;
        },
      });

      expect(code).toBe(0);
      // Durable half: the public origin is written to vault/.env (NOT loopback,
      // NOT unset) so the daemon boot path validates iss against it.
      expect(readEnvFileValues(join(env.configDir, "vault", ".env")).PARACHUTE_HUB_ORIGIN).toBe(
        "https://gitcoin-parachute.unforced.dev",
      );
      // Live half: the running vault is restarted to re-read the new origin.
      expect(restarted).toEqual(["vault"]);
    } finally {
      env.cleanup();
    }
  });

  test("persists vault/.env but does NOT restart when vault isn't running", async () => {
    // No vault pidfile → processState() !== "running" → no restart, but the
    // durable .env write still happens so the next daemon boot is correct.
    const env = makeEnv();
    try {
      const uuid = "ffffffff-0000-0000-0000-000000000007";
      const { runner } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: "[]", stderr: "" },
        {
          code: 0,
          stdout: `Tunnel credentials written to ${env.cloudflaredHome}/${uuid}.json.\nCreated tunnel parachute with id ${uuid}\n`,
          stderr: "",
        },
        { code: 0, stdout: "", stderr: "" },
      ]);
      const { spawner } = fakeSpawner(42301);
      const restarted: string[] = [];

      const code = await exposeCloudflareUp("gitcoin-parachute.unforced.dev", {
        runner,
        spawner,
        alive: () => false,
        kill: () => {},
        log: () => {},
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        restartService: async (short) => {
          restarted.push(short);
          return 0;
        },
      });

      expect(code).toBe(0);
      expect(readEnvFileValues(join(env.configDir, "vault", ".env")).PARACHUTE_HUB_ORIGIN).toBe(
        "https://gitcoin-parachute.unforced.dev",
      );
      expect(restarted).toEqual([]);
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
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        // Pin the legacy name: the queued `tunnel list` reports a "parachute"
        // tunnel, so reuse only happens when we look it up by that name. The
        // per-hostname default (#491) is exercised in the happy-path test.
        tunnelName: "parachute",
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
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
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
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
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
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
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
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
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
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
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
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        // Pin the legacy name so reuse (queued "parachute" list) drives the
        // route-dns failure under test, not a tunnel-create from the
        // per-hostname default (#491).
        tunnelName: "parachute",
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
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        // Pin the legacy name so the prior record (keyed "parachute") matches
        // this invocation's tunnel — the orphan-sweep behavior under test is
        // independent of the per-hostname-derivation change (#491).
        tunnelName: "parachute",
      });

      expect(code).toBe(0);
      expect(killed).toEqual([{ pid: 99999, sig: "SIGTERM" }]);
      const state = readCloudflaredState(env.statePath);
      expect(findTunnelRecord(state, "parachute")?.pid).toBe(42010);
    } finally {
      env.cleanup();
    }
  });

  test("hub#487: kills orphan connectors found by pgrep before spawning, not just the state pid", async () => {
    // The orphan-accumulation bug: each re-expose spawned a fresh connector
    // without killing prior ones, and state only tracked the most-recent pid.
    // Orphans the state file lost track of (crashed mid-rewrite, started by
    // hand) must still be swept — `connectorPids` finds them by UUID/config
    // path. Here state knows pid 99999, but pgrep also surfaces 88888 + 77777
    // serving the same tunnel; all three get SIGTERM before the new spawn.
    const env = makeEnv();
    try {
      const uuid = "cccccccc-0000-0000-0000-000000000003";
      const priorRecord: CloudflaredTunnelRecord = {
        pid: 99999,
        tunnelUuid: uuid,
        tunnelName: "parachute",
        hostname: "vault.example.com",
        startedAt: "2026-04-21T00:00:00.000Z",
        configPath: env.configPath,
      };
      writeCloudflaredState({ version: 2, tunnels: { parachute: priorRecord } }, env.statePath);

      const { runner } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: JSON.stringify([{ id: uuid, name: "parachute" }]), stderr: "" },
        { code: 0, stdout: "", stderr: "" }, // route dns
      ]);
      const { spawner, seen } = fakeSpawner(42010);
      const killed: number[] = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        alive: () => true, // all candidate pids report alive
        kill: (pid) => killed.push(pid),
        // pgrep surfaces two orphans the state record didn't track.
        connectorPids: () => [88888, 77777],
        resolveHost: async () => ["104.16.0.1"], // Cloudflare — no DNS warning
        log: () => {},
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        // Pin the legacy name so the prior record (keyed "parachute") matches —
        // the orphan-sweep behavior under test is independent of #491.
        tunnelName: "parachute",
      });

      expect(code).toBe(0);
      // Every prior connector (state pid + both pgrep orphans) is stopped
      // before the new one spawns.
      expect(killed.sort()).toEqual([77777, 88888, 99999]);
      // Exactly one fresh connector spawned, and it's the one recorded.
      expect(seen).toHaveLength(1);
      expect(findTunnelRecord(readCloudflaredState(env.statePath), "parachute")?.pid).toBe(42010);
    } finally {
      env.cleanup();
    }
  });

  test("hub#487: warns when DNS doesn't resolve yet (pending zone)", async () => {
    // route dns succeeded but the hostname doesn't resolve — the "pending"
    // zone shape (NS not switched at the registrar). Non-fatal: still exit 0,
    // still print the URLs, but add the nameserver-switch nudge.
    const env = makeEnv();
    try {
      const uuid = "dddddddd-0000-0000-0000-000000000004";
      const { runner } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: JSON.stringify([{ id: uuid, name: "parachute" }]), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      ]);
      const { spawner } = fakeSpawner(42020);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("vault.newzone.com", {
        runner,
        spawner,
        alive: () => false,
        kill: () => {},
        connectorPids: () => [],
        resolveHost: async () => [], // NXDOMAIN / not live yet
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        // Pin the legacy name so reuse drives the DNS-diagnosis path under test
        // (queued "parachute" list), not a create from the #491 default.
        tunnelName: "parachute",
      });

      expect(code).toBe(0); // non-fatal — the expose still completes
      const joined = logs.join("\n");
      expect(joined).toContain("DNS isn't live yet for vault.newzone.com");
      expect(joined).toContain("dig +short newzone.com NS");
      expect(joined).toContain("ns.cloudflare.com");
      // The success URLs still print.
      expect(joined).toContain("https://vault.newzone.com/admin/");
    } finally {
      env.cleanup();
    }
  });

  test("hub#487: warns when hostname resolves but not to Cloudflare (shadowed)", async () => {
    // route dns succeeded but the hostname resolves to a non-Cloudflare IP —
    // a Pages project / grey-cloud A record shadowing the tunnel → edge 404.
    const env = makeEnv();
    try {
      const uuid = "eeeeeeee-0000-0000-0000-000000000006";
      const { runner } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: JSON.stringify([{ id: uuid, name: "parachute" }]), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      ]);
      const { spawner } = fakeSpawner(42021);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("docs.parachute.computer", {
        runner,
        spawner,
        alive: () => false,
        kill: () => {},
        connectorPids: () => [],
        resolveHost: async () => ["203.0.113.10"], // not a Cloudflare range
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        // Pin the legacy name so reuse drives the shadowed-DNS path under test
        // (queued "parachute" list), not a create from the #491 default.
        tunnelName: "parachute",
      });

      expect(code).toBe(0);
      const joined = logs.join("\n");
      expect(joined).toContain("not to Cloudflare's edge");
      expect(joined).toContain("shadowed");
      expect(joined).toContain("Pages project");
    } finally {
      env.cleanup();
    }
  });

  test("hub#487: no DNS warning when hostname resolves at Cloudflare's edge", async () => {
    const env = makeEnv();
    try {
      const uuid = "ffffffff-0000-0000-0000-000000000007";
      const { runner } = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: JSON.stringify([{ id: uuid, name: "parachute" }]), stderr: "" },
        { code: 0, stdout: "", stderr: "" },
      ]);
      const { spawner } = fakeSpawner(42022);
      const logs: string[] = [];

      const code = await exposeCloudflareUp("vault.example.com", {
        runner,
        spawner,
        alive: () => false,
        kill: () => {},
        connectorPids: () => [],
        resolveHost: async () => ["104.18.32.7"], // 104.16.0.0/13 — Cloudflare
        log: (l) => logs.push(l),
        manifestPath: env.manifestPath,
        statePath: env.statePath,
        exposeStatePath: env.exposeStatePath,
        configPath: env.configPath,
        logPath: env.logPath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        // Pin the legacy name so reuse drives the no-warning path under test
        // (queued "parachute" list), not a create from the #491 default.
        tunnelName: "parachute",
      });

      expect(code).toBe(0);
      const joined = logs.join("\n");
      expect(joined).not.toContain("DNS isn't live yet");
      expect(joined).not.toContain("not to Cloudflare's edge");
    } finally {
      env.cleanup();
    }
  });

  test("two tunnels with different --tunnel-name coexist in state", async () => {
    const env = makeEnv();
    try {
      const uuidA = "aaaa1111-aaaa-1111-aaaa-111111111111";
      const uuidB = "bbbb2222-bbbb-2222-bbbb-222222222222";
      // Up #1 — per-hostname default (#491): alpha.example.com →
      // parachute-alpha-example-com.
      const derivedA = "parachute-alpha-example-com";
      const r1 = queueRunner([
        { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
        { code: 0, stdout: "[]", stderr: "" },
        {
          code: 0,
          stdout: `Created tunnel ${derivedA} with id ${uuidA}\n`,
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
        exposeStatePath: env.exposeStatePath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        // Omit configPath/logPath AND tunnelName so the name is the per-hostname
        // derived default (#491) and the paths are per-tunnel-derived against
        // the tmp `configDir` above — so the generated config.yml lands under
        // tmp/cloudflared/parachute-alpha-example-com/, not the operator's real
        // ~/.parachute.
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
        exposeStatePath: env.exposeStatePath,
        cloudflaredHome: env.cloudflaredHome,
        configDir: env.configDir,
        skipHub: true,
        tunnelName: "second",
      });
      expect(code2).toBe(0);

      // Both tunnels should be present in state, keyed by tunnel name: the
      // per-hostname derived name for #1, the explicit override for #2.
      const state = readCloudflaredState(env.statePath);
      expect(Object.keys(state?.tunnels ?? {}).sort()).toEqual([derivedA, "second"]);
      expect(findTunnelRecord(state, derivedA)?.hostname).toBe("alpha.example.com");
      expect(findTunnelRecord(state, "second")?.hostname).toBe("beta.example.com");
      expect(findTunnelRecord(state, "second")?.pid).toBe(50002);

      // Each tunnel should have written its own config file at the per-tunnel
      // path under `~/.parachute/cloudflared/<tunnelName>/config.yml`.
      const cfgA = findTunnelRecord(state, derivedA)?.configPath ?? "";
      const cfgB = findTunnelRecord(state, "second")?.configPath ?? "";
      expect(cfgA).not.toBe(cfgB);
      expect(cfgA.endsWith(`/${derivedA}/config.yml`)).toBe(true);
      expect(cfgB.endsWith("/second/config.yml")).toBe(true);
      expect(existsSync(cfgA)).toBe(true);
      expect(existsSync(cfgB)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  describe("#491: per-hostname tunnel naming + legacy migration", () => {
    test("explicit --tunnel-name overrides the per-hostname default", async () => {
      const env = makeEnv();
      try {
        const uuid = "11112222-3333-4444-5555-666677778888";
        const { runner, calls } = queueRunner([
          { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
          { code: 0, stdout: "[]", stderr: "" },
          { code: 0, stdout: `Created tunnel custom-name with id ${uuid}\n`, stderr: "" },
          { code: 0, stdout: "", stderr: "" },
        ]);
        const { spawner } = fakeSpawner(43000);

        const code = await exposeCloudflareUp("our.parachute.computer", {
          runner,
          spawner,
          alive: () => false,
          kill: () => {},
          log: () => {},
          manifestPath: env.manifestPath,
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          configPath: env.configPath,
          logPath: env.logPath,
          cloudflaredHome: env.cloudflaredHome,
          configDir: env.configDir,
          skipHub: true,
          tunnelName: "custom-name",
        });

        expect(code).toBe(0);
        // The explicit name wins — NOT the derived parachute-our-parachute-computer.
        expect(calls[2]!.cmd).toEqual(["cloudflared", "tunnel", "create", "custom-name"]);
        const state = readCloudflaredState(env.statePath);
        expect(findTunnelRecord(state, "custom-name")?.hostname).toBe("our.parachute.computer");
        expect(findTunnelRecord(state, "parachute-our-parachute-computer")).toBeUndefined();
      } finally {
        env.cleanup();
      }
    });

    test("legacy-sweep: stops a live shared 'parachute' connector when migrating to a derived name", async () => {
      const env = makeEnv();
      try {
        // A box that was exposed under the old shared "parachute" tunnel.
        const legacy: CloudflaredTunnelRecord = {
          pid: 70001,
          tunnelUuid: "legacy-uuid",
          tunnelName: "parachute",
          hostname: "our.parachute.computer",
          startedAt: "2026-05-01T00:00:00.000Z",
          configPath: "/tmp/legacy/parachute/config.yml",
        };
        writeCloudflaredState({ version: 2, tunnels: { parachute: legacy } }, env.statePath);

        const uuid = "99990000-1111-2222-3333-444455556666";
        const { runner } = queueRunner([
          { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
          { code: 0, stdout: "[]", stderr: "" }, // new derived tunnel doesn't exist yet
          {
            code: 0,
            stdout: `Created tunnel parachute-our-parachute-computer with id ${uuid}\n`,
            stderr: "",
          },
          { code: 0, stdout: "", stderr: "" }, // route dns (--overwrite-dns repoints the CNAME)
        ]);
        const { spawner } = fakeSpawner(70100);
        const killed: number[] = [];
        const logs: string[] = [];

        const code = await exposeCloudflareUp("our.parachute.computer", {
          runner,
          spawner,
          // The legacy connector (70001) is alive; the new spawn is 70100.
          alive: (pid) => pid === 70001,
          kill: (pid) => killed.push(pid),
          connectorPids: () => [],
          resolveHost: async () => ["104.16.0.1"],
          log: (l) => logs.push(l),
          manifestPath: env.manifestPath,
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          configPath: env.configPath,
          logPath: env.logPath,
          cloudflaredHome: env.cloudflaredHome,
          configDir: env.configDir,
          skipHub: true,
        });

        expect(code).toBe(0);
        // The legacy shared connector got SIGTERM'd.
        expect(killed).toContain(70001);
        const joined = logs.join("\n");
        expect(joined).toContain("Stopped legacy shared-tunnel connector");
        expect(joined).toContain("migrated our.parachute.computer to dedicated tunnel");
        // The legacy "parachute" record is gone; only the new derived one remains.
        const state = readCloudflaredState(env.statePath);
        expect(findTunnelRecord(state, "parachute")).toBeUndefined();
        expect(findTunnelRecord(state, "parachute-our-parachute-computer")?.pid).toBe(70100);
      } finally {
        env.cleanup();
      }
    });

    test("legacy-sweep: does NOT fire when no legacy 'parachute' record exists", async () => {
      const env = makeEnv();
      try {
        const uuid = "aaaa9999-1111-2222-3333-444455556666";
        const { runner } = queueRunner([
          { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
          { code: 0, stdout: "[]", stderr: "" },
          {
            code: 0,
            stdout: `Created tunnel parachute-our-parachute-computer with id ${uuid}\n`,
            stderr: "",
          },
          { code: 0, stdout: "", stderr: "" },
        ]);
        const { spawner } = fakeSpawner(70200);
        const logs: string[] = [];

        const code = await exposeCloudflareUp("our.parachute.computer", {
          runner,
          spawner,
          alive: () => false,
          kill: () => {},
          connectorPids: () => [],
          resolveHost: async () => ["104.16.0.1"],
          log: (l) => logs.push(l),
          manifestPath: env.manifestPath,
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          configPath: env.configPath,
          logPath: env.logPath,
          cloudflaredHome: env.cloudflaredHome,
          configDir: env.configDir,
          skipHub: true,
        });

        expect(code).toBe(0);
        expect(logs.join("\n")).not.toContain("Stopped legacy shared-tunnel connector");
      } finally {
        env.cleanup();
      }
    });

    test("legacy-sweep: drops a DEAD legacy 'parachute' record without killing, when migrating", async () => {
      const env = makeEnv();
      try {
        // A leftover shared-tunnel record whose connector is no longer running.
        const deadLegacy: CloudflaredTunnelRecord = {
          pid: 72001,
          tunnelUuid: "dead-legacy-uuid",
          tunnelName: "parachute",
          hostname: "our.parachute.computer",
          startedAt: "2026-05-01T00:00:00.000Z",
          configPath: "/tmp/legacy/parachute/config.yml",
        };
        writeCloudflaredState({ version: 2, tunnels: { parachute: deadLegacy } }, env.statePath);

        const uuid = "cccc7777-1111-2222-3333-444455556666";
        const { runner } = queueRunner([
          { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
          { code: 0, stdout: "[]", stderr: "" },
          {
            code: 0,
            stdout: `Created tunnel parachute-our-parachute-computer with id ${uuid}\n`,
            stderr: "",
          },
          { code: 0, stdout: "", stderr: "" },
        ]);
        const { spawner } = fakeSpawner(72100);
        const killed: number[] = [];
        const logs: string[] = [];

        const code = await exposeCloudflareUp("our.parachute.computer", {
          runner,
          spawner,
          alive: () => false, // nothing alive — including the dead legacy pid
          kill: (pid) => killed.push(pid),
          connectorPids: () => [],
          resolveHost: async () => ["104.16.0.1"],
          log: (l) => logs.push(l),
          manifestPath: env.manifestPath,
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          configPath: env.configPath,
          logPath: env.logPath,
          cloudflaredHome: env.cloudflaredHome,
          configDir: env.configDir,
          skipHub: true,
        });

        expect(code).toBe(0);
        // Connector wasn't alive → nothing killed, no sweep log.
        expect(killed).not.toContain(72001);
        expect(logs.join("\n")).not.toContain("Stopped legacy shared-tunnel connector");
        // …but the stale dead record is cleared, leaving only the new derived one.
        const state = readCloudflaredState(env.statePath);
        expect(findTunnelRecord(state, "parachute")).toBeUndefined();
        expect(findTunnelRecord(state, "parachute-our-parachute-computer")?.pid).toBe(72100);
      } finally {
        env.cleanup();
      }
    });

    test("legacy-sweep: does NOT fire when the derived name IS 'parachute' (no migration)", async () => {
      // A live "parachute" record AND an invocation that resolves to the
      // "parachute" name (here via explicit --tunnel-name parachute) must not
      // self-sweep — the connector we'd kill is the very one we're about to
      // reuse. Reuse-flow: queued list reports the parachute tunnel.
      const env = makeEnv();
      try {
        const uuid = "bbbb8888-1111-2222-3333-444455556666";
        const legacy: CloudflaredTunnelRecord = {
          pid: 71001,
          tunnelUuid: uuid,
          tunnelName: "parachute",
          hostname: "our.parachute.computer",
          startedAt: "2026-05-01T00:00:00.000Z",
          configPath: env.configPath,
        };
        writeCloudflaredState({ version: 2, tunnels: { parachute: legacy } }, env.statePath);

        const { runner } = queueRunner([
          { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
          { code: 0, stdout: JSON.stringify([{ id: uuid, name: "parachute" }]), stderr: "" },
          { code: 0, stdout: "", stderr: "" }, // route dns
        ]);
        const { spawner } = fakeSpawner(71100);
        const logs: string[] = [];

        const code = await exposeCloudflareUp("our.parachute.computer", {
          runner,
          spawner,
          alive: () => true,
          kill: () => {},
          connectorPids: () => [],
          resolveHost: async () => ["104.16.0.1"],
          log: (l) => logs.push(l),
          manifestPath: env.manifestPath,
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          configPath: env.configPath,
          logPath: env.logPath,
          cloudflaredHome: env.cloudflaredHome,
          configDir: env.configDir,
          skipHub: true,
          tunnelName: "parachute",
        });

        expect(code).toBe(0);
        // No legacy-migration log line: we resolved TO "parachute", so there's
        // nothing to migrate away from.
        expect(logs.join("\n")).not.toContain("Stopped legacy shared-tunnel connector");
      } finally {
        env.cleanup();
      }
    });
  });

  // 2FA-enrollment warning (#186). The cloudflare path is always public —
  // every successful bringup makes /admin/login reachable on the open
  // internet, where 2FA is the primary defense beyond #188's rate-limit floor.
  describe("2FA-enrollment warning", () => {
    test("not enrolled → warning fires after the success block", async () => {
      const env = makeEnv();
      try {
        const uuid = "cccccccc-0000-0000-0000-000000000003";
        const { runner } = queueRunner([
          { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
          { code: 0, stdout: "[]", stderr: "" },
          {
            code: 0,
            stdout: `Tunnel credentials written to ${env.cloudflaredHome}/${uuid}.json.\nCreated tunnel parachute with id ${uuid}\n`,
            stderr: "",
          },
          { code: 0, stdout: "", stderr: "" },
        ]);
        const { spawner } = fakeSpawner(42100);
        const logs: string[] = [];

        const code = await exposeCloudflareUp("vault.example.com", {
          runner,
          spawner,
          alive: () => false,
          kill: () => {},
          log: (l) => logs.push(l),
          manifestPath: env.manifestPath,
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          configPath: env.configPath,
          logPath: env.logPath,
          cloudflaredHome: env.cloudflaredHome,
          configDir: env.configDir,
          skipHub: true,
          // No password, no 2FA — fully wide open. The warning should still
          // fire; password-recovery copy already lives in `printAuthGuidance`.
          vaultAuthStatus: {
            hasOwnerPassword: false,
            hasTotp: false,
            tokenCount: 0,
            vaultNames: [],
          },
        });

        expect(code).toBe(0);
        const joined = logs.join("\n");
        // hub#473: real hub-login 2FA — the warning now recommends the real
        // `parachute auth 2fa enroll` path.
        expect(joined).toContain("/login is now reachable on the public internet");
        expect(joined).toContain("https://vault.example.com/login");
        expect(joined).toContain("parachute auth 2fa enroll");
      } finally {
        env.cleanup();
      }
    });

    test("enrolled → warning suppressed (no public-/login warning line)", async () => {
      const env = makeEnv();
      try {
        const uuid = "dddddddd-0000-0000-0000-000000000004";
        const { runner } = queueRunner([
          { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
          { code: 0, stdout: "[]", stderr: "" },
          {
            code: 0,
            stdout: `Tunnel credentials written to ${env.cloudflaredHome}/${uuid}.json.\nCreated tunnel parachute with id ${uuid}\n`,
            stderr: "",
          },
          { code: 0, stdout: "", stderr: "" },
        ]);
        const { spawner } = fakeSpawner(42101);
        const logs: string[] = [];

        const code = await exposeCloudflareUp("vault.example.com", {
          runner,
          spawner,
          alive: () => false,
          kill: () => {},
          log: (l) => logs.push(l),
          manifestPath: env.manifestPath,
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          configPath: env.configPath,
          logPath: env.logPath,
          cloudflaredHome: env.cloudflaredHome,
          configDir: env.configDir,
          skipHub: true,
          vaultAuthStatus: {
            hasOwnerPassword: true,
            hasTotp: true,
            tokenCount: 1,
            vaultNames: ["default"],
          },
        });

        expect(code).toBe(0);
        const joined = logs.join("\n");
        expect(joined).not.toContain("/login is now reachable on the public internet");
        // The contextual 2FA warning is suppressed (2FA already enrolled); the
        // always-shown owner-password guidance from `printAuthGuidance` still
        // appears, and it now (hub#473) also surfaces the real `2fa enroll`
        // path in the humans section.
        expect(joined).toContain("parachute auth set-password");
        expect(joined).toContain("parachute auth 2fa enroll");
      } finally {
        env.cleanup();
      }
    });
  });

  describe("routes through hub, not vault", () => {
    test("config.yml targets the hub port; success log mentions Admin + OAuth URLs", async () => {
      // Regression guard for the 2026-05-27 cut. Aaron ran `parachute expose
      // public` on a fresh EC2 box, configured Cloudflare with a custom
      // domain, and hit it — and got vault's 404 page rather than the hub's
      // discovery / admin. The pre-fix cloudflared config routed straight at
      // vault's port; the fix routes at the hub, mirroring the Tailscale
      // Funnel shape (single mount → hub catchall; hub dispatches per-request).
      const env = makeEnv();
      try {
        // Re-seed hub port to a non-default value so the assertion is
        // unambiguous about *which* port got into the yaml.
        writeHubPort(1949, env.configDir);

        const uuid = "ffff0000-0000-0000-0000-00000000beef";
        const { runner } = queueRunner([
          { code: 0, stdout: "cloudflared 2024.1.0\n", stderr: "" },
          { code: 0, stdout: "[]", stderr: "" },
          {
            code: 0,
            stdout: `Created tunnel parachute with id ${uuid}\n`,
            stderr: "",
          },
          { code: 0, stdout: "", stderr: "" },
        ]);
        const { spawner } = fakeSpawner(60001);
        const logs: string[] = [];

        const code = await exposeCloudflareUp("gitcoin.parachute.computer", {
          runner,
          spawner,
          alive: () => false,
          kill: () => {},
          log: (l) => logs.push(l),
          manifestPath: env.manifestPath,
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          configPath: env.configPath,
          logPath: env.logPath,
          cloudflaredHome: env.cloudflaredHome,
          configDir: env.configDir,
          skipHub: true,
        });

        expect(code).toBe(0);
        const yaml = readFileSync(env.configPath, "utf8");
        // Routes through the hub on its loopback port.
        expect(yaml).toContain("service: http://localhost:1949");
        // Does NOT route directly at vault's port (1940 per makeEnv default).
        expect(yaml).not.toContain("service: http://localhost:1940");

        const joined = logs.join("\n");
        // Discoverable surfaces: open / admin / vault / OAuth all surfaced.
        expect(joined).toContain("https://gitcoin.parachute.computer/");
        expect(joined).toContain("Admin:   https://gitcoin.parachute.computer/admin/");
        expect(joined).toContain("Vault:   https://gitcoin.parachute.computer/vault/default");
        expect(joined).toContain("OAuth:   https://gitcoin.parachute.computer");
      } finally {
        env.cleanup();
      }
    });
  });
});

describe("exposeCloudflareOff", () => {
  test("no-op when no state exists", async () => {
    const env = makeEnv();
    try {
      const logs: string[] = [];
      const code = await exposeCloudflareOff({
        statePath: env.statePath,
        exposeStatePath: env.exposeStatePath,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toContain("Nothing to tear down");
    } finally {
      env.cleanup();
    }
  });

  test("SIGTERMs the process and clears state (incl. expose-state.json — Fix 1)", async () => {
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
      // Seed the shared expose-state.json the up-path would have written, so we
      // can assert teardown clears it (downstream consumers stop resolving the
      // now-dead public URL).
      writeFileSync(
        env.exposeStatePath,
        `${JSON.stringify({
          version: 1,
          layer: "public",
          mode: "subdomain",
          canonicalFqdn: "vault.example.com",
          port: TEST_HUB_PORT,
          funnel: false,
          entries: [
            {
              kind: "proxy",
              mount: "/",
              target: `http://localhost:${TEST_HUB_PORT}`,
              service: "hub",
            },
          ],
          hubOrigin: "https://vault.example.com",
        })}\n`,
      );
      expect(readExposeState(env.exposeStatePath)).toBeDefined();

      const killed: number[] = [];
      const logs: string[] = [];
      const code = await exposeCloudflareOff({
        statePath: env.statePath,
        exposeStatePath: env.exposeStatePath,
        alive: () => true,
        kill: (pid) => killed.push(pid),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(killed).toEqual([55555]);
      expect(existsSync(env.statePath)).toBe(false);
      // Fix 1: the shared expose-state.json is cleared on the last tunnel down.
      expect(existsSync(env.exposeStatePath)).toBe(false);
      expect(readExposeState(env.exposeStatePath)).toBeUndefined();
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
        exposeStatePath: env.exposeStatePath,
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

  test("hub#487: off sweeps orphan connectors the state record didn't track", async () => {
    const env = makeEnv();
    try {
      const uuid = "abababab-0000-0000-0000-000000000009";
      writeCloudflaredState(
        {
          version: 2,
          tunnels: {
            parachute: {
              pid: 55555,
              tunnelUuid: uuid,
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
        exposeStatePath: env.exposeStatePath,
        alive: () => true,
        kill: (pid) => killed.push(pid),
        // pgrep finds the tracked pid (skipped — already signalled) plus an
        // untracked orphan 66666 serving the same tunnel.
        connectorPids: () => [55555, 66666],
        log: () => {},
      });
      expect(code).toBe(0);
      // Tracked pid stopped once, orphan also stopped — no double-kill of 55555.
      expect(killed.sort()).toEqual([55555, 66666]);
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
        exposeStatePath: env.exposeStatePath,
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
        exposeStatePath: env.exposeStatePath,
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

  describe("#491: state-driven off (no --tunnel-name)", () => {
    test("0 tunnels → 'Nothing to tear down' (exit 0)", async () => {
      const env = makeEnv();
      try {
        const logs: string[] = [];
        const code = await exposeCloudflareOff({
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          log: (l) => logs.push(l),
        });
        expect(code).toBe(0);
        expect(logs.join("\n")).toContain("Nothing to tear down");
      } finally {
        env.cleanup();
      }
    });

    test("exactly 1 tunnel → tears it down by reading state (even a derived non-'parachute' name)", async () => {
      const env = makeEnv();
      try {
        const record: CloudflaredTunnelRecord = {
          pid: 80001,
          tunnelUuid: "derived-uuid",
          tunnelName: "parachute-our-parachute-computer",
          hostname: "our.parachute.computer",
          startedAt: "2026-05-20T10:00:00.000Z",
          configPath: "/tmp/derived/config.yml",
        };
        writeCloudflaredState(
          { version: 2, tunnels: { "parachute-our-parachute-computer": record } },
          env.statePath,
        );

        const killed: number[] = [];
        const code = await exposeCloudflareOff({
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          alive: () => true,
          kill: (pid) => killed.push(pid),
          log: () => {},
          // No tunnelName — resolved from state.
        });
        expect(code).toBe(0);
        expect(killed).toEqual([80001]);
        expect(existsSync(env.statePath)).toBe(false);
      } finally {
        env.cleanup();
      }
    });

    test("≥2 tunnels → tears down ALL of them and lists each", async () => {
      const env = makeEnv();
      try {
        const recordA: CloudflaredTunnelRecord = {
          pid: 81001,
          tunnelUuid: "aaaa-uuid",
          tunnelName: "parachute-alpha-example-com",
          hostname: "alpha.example.com",
          startedAt: "2026-05-20T10:00:00.000Z",
          configPath: "/tmp/alpha/config.yml",
        };
        const recordB: CloudflaredTunnelRecord = {
          pid: 81002,
          tunnelUuid: "bbbb-uuid",
          tunnelName: "parachute-beta-example-com",
          hostname: "beta.example.com",
          startedAt: "2026-05-20T11:00:00.000Z",
          configPath: "/tmp/beta/config.yml",
        };
        writeCloudflaredState(
          withTunnelRecord(withTunnelRecord(undefined, recordA), recordB),
          env.statePath,
        );

        const killed: number[] = [];
        const logs: string[] = [];
        const code = await exposeCloudflareOff({
          statePath: env.statePath,
          exposeStatePath: env.exposeStatePath,
          alive: () => true,
          kill: (pid) => killed.push(pid),
          log: (l) => logs.push(l),
          // No tunnelName — bare `off` means "stop all public Cloudflare exposure".
        });
        expect(code).toBe(0);
        // Both connectors stopped.
        expect(killed.sort()).toEqual([81001, 81002]);
        // State fully cleared (no tunnels remain).
        expect(existsSync(env.statePath)).toBe(false);
        const joined = logs.join("\n");
        expect(joined).toContain("Tearing down all 2 recorded Cloudflare tunnels");
        expect(joined).toContain("parachute-alpha-example-com");
        expect(joined).toContain("parachute-beta-example-com");
      } finally {
        env.cleanup();
      }
    });
  });
});
