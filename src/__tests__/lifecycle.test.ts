import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultAlive,
  defaultKill,
  defaultSpawner,
  logs,
  restart,
  start,
  stop,
} from "../commands/lifecycle.ts";
import { writeHubPort } from "../hub-control.ts";
import { ensureLogPath, logPath, readPid, writePid } from "../process-state.ts";
import { upsertService } from "../services-manifest.ts";

interface Harness {
  configDir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-life-"));
  return {
    configDir: dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedVault(manifestPath: string): void {
  upsertService(
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version: "0.2.4",
    },
    manifestPath,
  );
}

function seedNotes(manifestPath: string): void {
  upsertService(
    {
      name: "parachute-notes",
      port: 5173,
      paths: ["/notes"],
      health: "/notes/health",
      version: "0.0.1",
    },
    manifestPath,
  );
}

interface ThirdPartySeed {
  installDir: string;
  manifestName?: string;
  startCmd?: readonly string[];
  port?: number;
}

/**
 * Seed a third-party services.json row + write a `.parachute/module.json` at
 * `installDir`. Mirrors what `parachute install /tmp/foo` produces in
 * production: row carries `installDir`, lifecycle resolves spec from the
 * filesystem.
 */
function seedThirdParty(
  manifestPath: string,
  configDirRoot: string,
  name: string,
  opts: ThirdPartySeed,
): string {
  const installDir = opts.installDir;
  mkdirSync(join(installDir, ".parachute"), { recursive: true });
  const manifest = {
    name,
    manifestName: opts.manifestName ?? name,
    kind: "api" as const,
    port: opts.port ?? 1944,
    paths: [`/${name}`],
    health: `/${name}/health`,
    ...(opts.startCmd ? { startCmd: opts.startCmd } : {}),
  };
  writeFileSync(join(installDir, ".parachute", "module.json"), JSON.stringify(manifest));
  upsertService(
    {
      name: opts.manifestName ?? name,
      port: opts.port ?? 1944,
      paths: [`/${name}`],
      health: `/${name}/health`,
      version: "0.0.1",
      installDir,
    },
    manifestPath,
  );
  return configDirRoot;
}

interface SpawnerStub {
  spawn: (
    cmd: readonly string[],
    logFile: string,
    opts?: { env?: Record<string, string>; cwd?: string },
  ) => number;
  calls: Array<{
    cmd: readonly string[];
    logFile: string;
    env?: Record<string, string>;
    cwd?: string;
  }>;
}

function makeSpawner(pidSequence: number[]): SpawnerStub {
  const calls: Array<{
    cmd: readonly string[];
    logFile: string;
    env?: Record<string, string>;
    cwd?: string;
  }> = [];
  let i = 0;
  return {
    calls,
    spawn(cmd, logFile, opts) {
      calls.push({ cmd: [...cmd], logFile, env: opts?.env, cwd: opts?.cwd });
      return pidSequence[i++] ?? 99999;
    },
  };
}

describe("parachute start", () => {
  test("errors cleanly when no services installed", async () => {
    const h = makeHarness();
    try {
      const logs: string[] = [];
      const code = await start(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/No services installed/);
    } finally {
      h.cleanup();
    }
  });

  test("errors cleanly when targeting an uninstalled service", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const logs: string[] = [];
      const code = await start("notes", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/notes isn't installed/);
    } finally {
      h.cleanup();
    }
  });

  test("spawns vault with parachute-vault serve, writes PID", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const spawner = makeSpawner([4242]);
      const logs: string[] = [];
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(1);
      expect(spawner.calls[0]?.cmd).toEqual(["parachute-vault", "serve"]);
      expect(spawner.calls[0]?.logFile).toBe(logPath("vault", h.configDir));
      expect(readPid("vault", h.configDir)).toBe(4242);
      expect(logs.join("\n")).toMatch(/vault started \(pid 4242\)/);
    } finally {
      h.cleanup();
    }
  });

  test("notes start command includes configured port and notes-serve shim path", async () => {
    const h = makeHarness();
    try {
      seedNotes(h.manifestPath);
      const spawner = makeSpawner([5151]);
      const code = await start("notes", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      const cmd = spawner.calls[0]?.cmd ?? [];
      expect(cmd[0]).toBe("bun");
      expect(cmd.some((a) => a.endsWith("notes-serve.ts"))).toBe(true);
      const portIdx = cmd.indexOf("--port");
      expect(portIdx).toBeGreaterThan(-1);
      expect(cmd[portIdx + 1]).toBe("5173");
      const mountIdx = cmd.indexOf("--mount");
      expect(mountIdx).toBeGreaterThan(-1);
      expect(cmd[mountIdx + 1]).toBe("/notes");
    } finally {
      h.cleanup();
    }
  });

  test("no-op when already running", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const spawner = makeSpawner([9999]);
      const logs: string[] = [];
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        alive: () => true,
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/already running \(pid 4242\)/);
      expect(readPid("vault", h.configDir)).toBe(4242);
    } finally {
      h.cleanup();
    }
  });

  test("clears stale PID file before spawning fresh", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const spawner = makeSpawner([7777]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        // Stale 4242 is dead; the freshly spawned 7777 is alive — the
        // post-spawn settle (hub#194) calls alive(pid) on the new pid,
        // so we differentiate per-pid rather than blanket-false.
        alive: (pid) => pid === 7777,
        sleep: async () => {},
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(1);
      expect(readPid("vault", h.configDir)).toBe(7777);
    } finally {
      h.cleanup();
    }
  });

  test("start (no svc) targets every installed + known service", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      seedNotes(h.manifestPath);
      const spawner = makeSpawner([4242, 5151]);
      const code = await start(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(2);
      expect(readPid("vault", h.configDir)).toBe(4242);
      expect(readPid("notes", h.configDir)).toBe(5151);
    } finally {
      h.cleanup();
    }
  });

  test("legacy parachute-lens manifest entry still starts under the notes spec", async () => {
    // Users who installed during the brief Notes→Lens window (Apr 19–22)
    // will still have `parachute-lens` in services.json until their notes
    // package next boots and rewrites the row. Without the manifest alias,
    // shortNameForManifest returns undefined, resolveTargets skips the
    // entry, and they get "No manageable services" with no hint.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-lens",
          port: 5173,
          paths: ["/lens"],
          health: "/lens/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      const spawner = makeSpawner([5151]);
      const code = await start(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(1);
      expect(spawner.calls[0]?.cmd.some((a) => a.endsWith("notes-serve.ts"))).toBe(true);
      expect(readPid("notes", h.configDir)).toBe(5151);
    } finally {
      h.cleanup();
    }
  });

  test("passes PARACHUTE_HUB_ORIGIN from expose-state when set", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeFileSync(
        join(h.configDir, "expose-state.json"),
        JSON.stringify({
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [],
          hubOrigin: "https://parachute.taildf9ce2.ts.net",
        }),
      );
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        PARACHUTE_HUB_ORIGIN: "https://parachute.taildf9ce2.ts.net",
      });
    } finally {
      h.cleanup();
    }
  });

  test("falls back to loopback origin from hub.port when not exposed", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeHubPort(1939, h.configDir);
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        PARACHUTE_HUB_ORIGIN: "http://127.0.0.1:1939",
      });
    } finally {
      h.cleanup();
    }
  });

  test("--hub-origin override wins over expose-state", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writeFileSync(
        join(h.configDir, "expose-state.json"),
        JSON.stringify({
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "parachute.taildf9ce2.ts.net",
          port: 443,
          funnel: false,
          entries: [],
          hubOrigin: "https://parachute.taildf9ce2.ts.net",
        }),
      );
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        hubOrigin: "https://override.example.com/",
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        PARACHUTE_HUB_ORIGIN: "https://override.example.com",
      });
    } finally {
      h.cleanup();
    }
  });

  test("omits env when no override, no exposure, no hub port", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("merges <configDir>/<svc>/.env into the spawn env", async () => {
    // Scribe's API key prompt writes GROQ_API_KEY into ~/.parachute/scribe/.env.
    // Scribe itself doesn't auto-load .env, so `parachute start scribe` has to
    // forward the values into the child env or the API key won't take effect.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.1.0",
        },
        h.manifestPath,
      );
      ensureLogPath("scribe", h.configDir);
      writeFileSync(
        join(h.configDir, "scribe", ".env"),
        'GROQ_API_KEY=gsk_real_value\nQUOTED="quoted_val"\n',
      );
      const spawner = makeSpawner([7777]);
      const code = await start("scribe", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        GROQ_API_KEY: "gsk_real_value",
        QUOTED: "quoted_val",
      });
    } finally {
      h.cleanup();
    }
  });

  test("hub-origin override wins over conflicting key in service .env", async () => {
    // Defense: `start --hub-origin <url>` is the authoritative source for
    // PARACHUTE_HUB_ORIGIN. If a service .env happens to have the same key
    // (e.g. an old hand-edit), the live override should still apply.
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      ensureLogPath("vault", h.configDir);
      writeFileSync(
        join(h.configDir, "vault", ".env"),
        "SCRIBE_AUTH_TOKEN=secret\nPARACHUTE_HUB_ORIGIN=http://stale.local\n",
      );
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        hubOrigin: "https://live.example.com",
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls[0]?.env).toEqual({
        SCRIBE_AUTH_TOKEN: "secret",
        PARACHUTE_HUB_ORIGIN: "https://live.example.com",
      });
    } finally {
      h.cleanup();
    }
  });

  test("third-party module starts via installDir module.json with cwd", async () => {
    // hub#83: services.json rows that carry installDir resolve their spec
    // from `<installDir>/.parachute/module.json` at lifecycle time. Spawn
    // gets cwd=installDir so manifest-declared relative paths work.
    const h = makeHarness();
    try {
      const installDir = join(h.configDir, "_pkg-agent");
      seedThirdParty(h.manifestPath, h.configDir, "agent", {
        installDir,
        startCmd: ["bun", "web/server/src/server.ts"],
        port: 1944,
      });
      const spawner = makeSpawner([8080]);
      const code = await start("agent", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(1);
      expect(spawner.calls[0]?.cmd).toEqual(["bun", "web/server/src/server.ts"]);
      expect(spawner.calls[0]?.cwd).toBe(installDir);
      expect(readPid("agent", h.configDir)).toBe(8080);
    } finally {
      h.cleanup();
    }
  });

  test("start: installDir-less third-party row surfaces an actionable error", async () => {
    // A services.json row whose name isn't first-party AND has no installDir
    // can't yield a startCmd. Pre-fix this hit the generic "unknown service"
    // path (misleading — the row exists, just with stale shape). Post-fix
    // resolveTargets returns the entry with spec=undefined and start prints
    // an actionable message that points at the real fix (re-install or
    // upgrade-the-module).
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "mystery",
          port: 1944,
          paths: ["/mystery"],
          health: "/mystery/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      const lines: string[] = [];
      const code = await start("mystery", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      const out = lines.join("\n");
      expect(out).toMatch(/services\.json entry has no installDir/);
      expect(out).toMatch(/parachute install <path-to-mystery>/);
      expect(out).not.toMatch(/unknown service/);
    } finally {
      h.cleanup();
    }
  });

  test("start: name absent from services.json still errors as unknown service", async () => {
    // The genuinely-unknown path: no first-party fallback, no row in
    // services.json. Distinguish from the above (row exists but lacks
    // installDir) so the error message is right-shaped for each.
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const lines: string[] = [];
      const code = await start("ghost", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toMatch(/unknown service "ghost"/);
    } finally {
      h.cleanup();
    }
  });

  test("start (no svc) sweeps both first-party and third-party rows", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const installDir = join(h.configDir, "_pkg-agent");
      seedThirdParty(h.manifestPath, h.configDir, "agent", {
        installDir,
        startCmd: ["bun", "server.ts"],
        port: 1944,
      });
      const spawner = makeSpawner([4242, 8080]);
      const code = await start(undefined, {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(spawner.calls).toHaveLength(2);
      const cmds = spawner.calls.map((c) => c.cmd);
      expect(cmds).toContainEqual(["parachute-vault", "serve"]);
      expect(cmds).toContainEqual(["bun", "server.ts"]);
    } finally {
      h.cleanup();
    }
  });

  test("third-party with malformed module.json fails clearly", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.configDir, "_pkg-broken");
      mkdirSync(join(installDir, ".parachute"), { recursive: true });
      writeFileSync(join(installDir, ".parachute", "module.json"), "{ not valid json");
      upsertService(
        {
          name: "broken",
          port: 1944,
          paths: ["/broken"],
          health: "/broken/health",
          version: "0.0.1",
          installDir,
        },
        h.manifestPath,
      );
      const lines: string[] = [];
      const code = await start("broken", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toMatch(/broken: invalid module\.json/);
    } finally {
      h.cleanup();
    }
  });

  test("hub#194: reports failure when child dies before the settle window", async () => {
    // The bug: `parachute start notes` reported `✓ notes started (pid X)`
    // but notes-serve crashed milliseconds later on a Bun.resolveSync
    // failure, leaving tailnet `/notes/` 502'ing. Fix: after spawn, sleep
    // ~250ms then re-check alive(pid). If dead, clear pidfile, log
    // failure, return non-zero. This regression test pins the post-fix
    // shape with a stub alive that always reports dead and a fast settle.
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const spawner = makeSpawner([4242]);
      const lines: string[] = [];
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        alive: () => false, // child dies immediately after spawn
        sleep: async () => {}, // skip the real wait in tests
        startSettleMs: 1, // any non-zero value engages the check
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(spawner.calls).toHaveLength(1);
      // pidfile is cleared so a follow-up `start` doesn't report
      // already-running against a corpse.
      expect(readPid("vault", h.configDir)).toBeUndefined();
      const out = lines.join("\n");
      expect(out).toMatch(/✗ vault failed to start/);
      expect(out).toMatch(/exited within 1ms/);
      expect(out).toMatch(/Tail the log/);
      expect(out).not.toMatch(/✓ vault started/);
    } finally {
      h.cleanup();
    }
  });

  test("hub#194: settle path passes when child stays alive past the window", async () => {
    // Companion to the above — verifies the success-path shape doesn't
    // regress. Stub alive returns true so the post-spawn check passes,
    // and we still see the `✓ ... started` line.
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const spawner = makeSpawner([4242]);
      const lines: string[] = [];
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        alive: () => true,
        sleep: async () => {},
        startSettleMs: 1,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(readPid("vault", h.configDir)).toBe(4242);
      expect(lines.join("\n")).toMatch(/✓ vault started \(pid 4242\)/);
    } finally {
      h.cleanup();
    }
  });

  test("hub#194: settle skipped when startSettleMs is 0", async () => {
    // Defense — don't regress the test-default policy. With a stub
    // spawner and no `alive` override, the resolved settle is 0 (see
    // resolve() in lifecycle.ts), so the post-spawn check is bypassed
    // entirely and even an `alive: () => false` doesn't matter.
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const spawner = makeSpawner([4242]);
      const code = await start("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        startSettleMs: 0,
        // intentionally omit alive — defaultAlive against a fake pid
        // would normally report dead, but startSettleMs: 0 skips the
        // call entirely.
        log: () => {},
      });
      expect(code).toBe(0);
      expect(readPid("vault", h.configDir)).toBe(4242);
    } finally {
      h.cleanup();
    }
  });

  test("third-party with no startCmd in module.json reports lifecycle-unsupported", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.configDir, "_pkg-noop");
      seedThirdParty(h.manifestPath, h.configDir, "noop", {
        installDir,
        port: 1945,
      });
      const lines: string[] = [];
      const code = await start("noop", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toMatch(/lifecycle not yet supported/);
    } finally {
      h.cleanup();
    }
  });
});

describe("parachute stop", () => {
  test("no-op when nothing is running", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      const killed: Array<[number, string | number]> = [];
      const logs: string[] = [];
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        kill: (pid, sig) => killed.push([pid, sig]),
        log: (l) => logs.push(l),
      });
      expect(code).toBe(0);
      expect(killed).toHaveLength(0);
      expect(logs.join("\n")).toMatch(/wasn't running/);
    } finally {
      h.cleanup();
    }
  });

  test("cleans stale PID file without sending any signal", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const killed: Array<[number, string | number]> = [];
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        kill: (pid, sig) => killed.push([pid, sig]),
        alive: () => false,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed).toHaveLength(0);
      expect(readPid("vault", h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("SIGTERM + clean exit within window clears PID", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const killed: Array<[number, string | number]> = [];
      let aliveCall = 0;
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        kill: (pid, sig) => killed.push([pid, sig]),
        alive: () => {
          aliveCall++;
          return aliveCall === 1;
        },
        sleep: async () => {},
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed).toEqual([[4242, "SIGTERM"]]);
      expect(readPid("vault", h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("escalates to SIGKILL when SIGTERM doesn't land", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const killed: Array<[number, string | number]> = [];
      let t = 0;
      const code = await stop("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        kill: (pid, sig) => killed.push([pid, sig]),
        alive: () => true,
        sleep: async () => {},
        now: () => {
          // Jump past the kill-wait window so the polling loop exits fast.
          t += 20_000;
          return t;
        },
        killWaitMs: 10_000,
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed[0]).toEqual([4242, "SIGTERM"]);
      expect(killed[killed.length - 1]).toEqual([4242, "SIGKILL"]);
      expect(readPid("vault", h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("third-party row without installDir: stops via pidfile", async () => {
    // Graceful-degradation path: an installed-but-stale third-party row
    // (no installDir field — pre-installDir-contract self-registration)
    // should still be stoppable. stop only needs the short name to find
    // the pidfile; spec resolution isn't on the critical path for stop.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "mystery",
          port: 1944,
          paths: ["/mystery"],
          health: "/mystery/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      writePid("mystery", 4242, h.configDir);
      const killed: Array<[number, string | number]> = [];
      let aliveCall = 0;
      const code = await stop("mystery", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        kill: (pid, sig) => killed.push([pid, sig]),
        alive: () => {
          aliveCall++;
          return aliveCall === 1;
        },
        sleep: async () => {},
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed).toEqual([[4242, "SIGTERM"]]);
      expect(readPid("mystery", h.configDir)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("parachute restart", () => {
  test("stops then starts in sequence", async () => {
    const h = makeHarness();
    try {
      seedVault(h.manifestPath);
      writePid("vault", 4242, h.configDir);
      const spawner = makeSpawner([7777]);
      const killed: Array<[number, string | number]> = [];
      const code = await restart("vault", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        spawner,
        kill: (pid, sig) => killed.push([pid, sig]),
        // Stale 4242 is dead (stop's stale-pid path skips the kill);
        // freshly spawned 7777 is alive past the post-spawn settle
        // (hub#194). Per-pid differentiation rather than blanket-false.
        alive: (pid) => pid === 7777,
        sleep: async () => {},
        log: () => {},
      });
      expect(code).toBe(0);
      expect(killed).toHaveLength(0); // stale pid → cleanup without kill
      expect(spawner.calls).toHaveLength(1);
      expect(readPid("vault", h.configDir)).toBe(7777);
    } finally {
      h.cleanup();
    }
  });
});

describe("parachute logs", () => {
  test("hint when no log file exists", async () => {
    const h = makeHarness();
    try {
      const lines: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.join("\n")).toMatch(/no logs yet/);
    } finally {
      h.cleanup();
    }
  });

  test("prints last N lines in one-shot mode", async () => {
    const h = makeHarness();
    try {
      const p = ensureLogPath("vault", h.configDir);
      const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
      writeFileSync(p, `${content}\n`);
      const lines: string[] = [];
      const code = await logs("vault", {
        configDir: h.configDir,
        lines: 3,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines).toEqual(["line 8", "line 9", "line 10"]);
    } finally {
      h.cleanup();
    }
  });

  test("unknown service errors cleanly", async () => {
    const h = makeHarness();
    try {
      const lines: string[] = [];
      const code = await logs("nope", {
        configDir: h.configDir,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      expect(lines.join("\n")).toMatch(/unknown service/);
    } finally {
      h.cleanup();
    }
  });

  test("third-party module name with installDir is recognised", async () => {
    const h = makeHarness();
    try {
      const installDir = join(h.configDir, "_pkg-agent");
      seedThirdParty(h.manifestPath, h.configDir, "agent", {
        installDir,
        startCmd: ["bun", "server.ts"],
      });
      const p = ensureLogPath("agent", h.configDir);
      writeFileSync(p, "agent line 1\nagent line 2\n");
      const lines: string[] = [];
      const code = await logs("agent", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines).toEqual(["agent line 1", "agent line 2"]);
    } finally {
      h.cleanup();
    }
  });

  test("third-party row without installDir: tails by short name", async () => {
    // Graceful-degradation path: log file is keyed by short name, written by
    // start. installDir is irrelevant for tailing — the entry just needs to
    // exist in services.json.
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "mystery",
          port: 1944,
          paths: ["/mystery"],
          health: "/mystery/health",
          version: "0.0.1",
        },
        h.manifestPath,
      );
      const p = ensureLogPath("mystery", h.configDir);
      writeFileSync(p, "mystery line 1\nmystery line 2\n");
      const lines: string[] = [];
      const code = await logs("mystery", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines).toEqual(["mystery line 1", "mystery line 2"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("process-group lifecycle (hub#88)", () => {
  // Spawn a wrapper that forks a long-running grandchild (sleep), wait for
  // both to come up, then check that the wrapper PID equals its PGID — the
  // post-fix invariant that makes group-kill safe. Without `detached: true`
  // the child inherits the test runner's PGID and group-kill would target
  // the wrong tree.
  test("defaultSpawner puts child in its own process group", async () => {
    const h = makeHarness();
    try {
      const logFile = ensureLogPath("test", h.configDir);
      const pid = defaultSpawner.spawn(["sh", "-c", "sleep 2 & wait"], logFile);
      try {
        // Resolve the child's PGID via ps; the kernel reports it as a
        // numeric column. PGID == PID means our setsid-equivalent worked.
        const ps = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]);
        const pgid = Number.parseInt(ps.stdout.toString().trim(), 10);
        expect(pgid).toBe(pid);
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
    } finally {
      h.cleanup();
    }
  });

  // The smoking-gun scenario from #88: a wrapper (sh) forks a grandchild
  // (sleep) that keeps a resource — here, just stays alive. SIGKILL on the
  // wrapper PID alone leaves the grandchild running. With detached spawn +
  // group-kill, both go down. We assert by checking the grandchild's PID
  // is no longer kill-able after `defaultKill`.
  test("defaultKill takes down the wrapper and its grandchildren together", async () => {
    const h = makeHarness();
    try {
      const logFile = ensureLogPath("test", h.configDir);
      // Wrapper sh forks `sleep 30 & echo $!` so we capture the grandchild
      // PID via the log file, then `wait` so the wrapper sticks around as
      // a parent (mirrors `pnpm exec tsx`'s shape).
      const wrapperPid = defaultSpawner.spawn(
        ["sh", "-c", "sleep 30 & echo $! >&2; wait"],
        logFile,
      );
      // Give the grandchild time to start and the log line to flush.
      await new Promise((r) => setTimeout(r, 200));
      const log = await Bun.file(logFile).text();
      const grandchildPid = Number.parseInt(log.trim().split("\n").pop() ?? "", 10);
      expect(grandchildPid).toBeGreaterThan(0);
      expect(grandchildPid).not.toBe(wrapperPid);
      // Both should be alive before kill.
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();

      defaultKill(wrapperPid, "SIGKILL");

      // Reap + wait for the grandchild to exit; on macOS the kernel may
      // take a tick to deliver the signal.
      await new Promise((r) => setTimeout(r, 200));
      let grandchildStillAlive = true;
      try {
        process.kill(grandchildPid, 0);
      } catch {
        grandchildStillAlive = false;
      }
      expect(grandchildStillAlive).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  // defaultAlive's post-fix semantics: returns true while any group member
  // is alive (the wrapper stays in the group as long as it's running),
  // false after the group drains.
  test("defaultAlive reports group liveness for detached children", async () => {
    const h = makeHarness();
    try {
      const logFile = ensureLogPath("test", h.configDir);
      const pid = defaultSpawner.spawn(["sh", "-c", "sleep 2"], logFile);
      try {
        expect(defaultAlive(pid)).toBe(true);
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
      // Wait for the kill to drain the group, then re-check.
      await new Promise((r) => setTimeout(r, 100));
      expect(defaultAlive(pid)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  // Legacy pidfile compatibility: a pre-detached pidfile holds a positive
  // PID whose pgid is the parent shell, not the pid itself. defaultAlive
  // must fall back to a bare-pid check so the next `stop` actually runs;
  // defaultKill must fall back to a bare-pid signal so it can be reaped.
  test("defaultAlive + defaultKill fall back to bare-pid for legacy (non-detached) processes", async () => {
    // Spawn a non-detached child to simulate a legacy pidfile (pre-fix
    // start). It shares the test runner's pgid, so kill(-pid, 0) will
    // ESRCH and we should fall back.
    const proc = Bun.spawn(["sh", "-c", "sleep 5"], { stdio: ["ignore", "ignore", "ignore"] });
    const pid = proc.pid;
    try {
      expect(defaultAlive(pid)).toBe(true);
      defaultKill(pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 100));
      expect(defaultAlive(pid)).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
});

/**
 * `parachute start|stop|restart hub` — the bug Aaron filed as hub#166. Hub
 * isn't a row in services.json, so the generic services-manifest path
 * surfaced "unknown service: hub". The fix dispatches `svc === "hub"`
 * straight to hub-control.ts. These tests inject `ensureRunning`/`stop`
 * stubs so we don't actually fork bun.
 */
describe("parachute start|stop|restart hub", () => {
  test("start hub: dispatches to ensureHubRunning, propagates configDir + issuer", async () => {
    const h = makeHarness();
    try {
      const log: string[] = [];
      const ensureCalls: Array<{ configDir?: string; issuer?: string }> = [];
      const code = await start("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        hubOrigin: "https://hub.example.com",
        hub: {
          ensureRunning: async (opts) => {
            ensureCalls.push({ configDir: opts.configDir, issuer: opts.issuer });
            return { pid: 4711, port: 1939, started: true };
          },
        },
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(ensureCalls).toHaveLength(1);
      expect(ensureCalls[0]).toEqual({
        configDir: h.configDir,
        issuer: "https://hub.example.com",
      });
    } finally {
      h.cleanup();
    }
  });

  test("start hub: reports already-running cleanly when ensureHubRunning returns started=false", async () => {
    const h = makeHarness();
    try {
      const log: string[] = [];
      const code = await start("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        hub: {
          ensureRunning: async () => ({ pid: 8888, port: 1939, started: false }),
        },
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log.join("\n")).toMatch(/hub already running \(pid 8888\) on port 1939/);
    } finally {
      h.cleanup();
    }
  });

  test("start hub: surfaces ensureHubRunning errors as exit 1", async () => {
    const h = makeHarness();
    try {
      const log: string[] = [];
      const code = await start("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        hub: {
          ensureRunning: async () => {
            throw new Error("hub: port 1939 unavailable");
          },
        },
        log: (l) => log.push(l),
      });
      expect(code).toBe(1);
      expect(log.join("\n")).toMatch(/hub failed to start.*port 1939 unavailable/);
    } finally {
      h.cleanup();
    }
  });

  test("stop hub: dispatches to stopHub, true → '✓ hub stopped'", async () => {
    const h = makeHarness();
    try {
      const log: string[] = [];
      const stopCalls: Array<{ configDir?: string }> = [];
      const code = await stop("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        hub: {
          stop: async (opts) => {
            stopCalls.push({ configDir: opts.configDir });
            return true;
          },
        },
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(stopCalls).toHaveLength(1);
      expect(stopCalls[0]?.configDir).toBe(h.configDir);
      expect(log.join("\n")).toMatch(/✓ hub stopped/);
    } finally {
      h.cleanup();
    }
  });

  test("stop hub: false → 'wasn't running' (still exit 0)", async () => {
    const h = makeHarness();
    try {
      const log: string[] = [];
      const code = await stop("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        hub: { stop: async () => false },
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log.join("\n")).toMatch(/hub wasn't running/);
    } finally {
      h.cleanup();
    }
  });

  test("restart hub: chains stop then start through the same hub seam", async () => {
    const h = makeHarness();
    try {
      const log: string[] = [];
      const order: string[] = [];
      const code = await restart("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        hub: {
          stop: async () => {
            order.push("stop");
            return true;
          },
          ensureRunning: async () => {
            order.push("start");
            return { pid: 5151, port: 1939, started: true };
          },
        },
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(order).toEqual(["stop", "start"]);
    } finally {
      h.cleanup();
    }
  });

  test("logs hub: doesn't reject 'hub' as an unknown service", async () => {
    const h = makeHarness();
    try {
      // No log file yet — exercise the "no logs yet" branch, which still
      // returns 0. Goal of this test is just the unknown-service guard.
      const log: string[] = [];
      const code = await logs("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log.join("\n")).toMatch(/no logs yet for hub/);
    } finally {
      h.cleanup();
    }
  });

  test("logs hub: prints the tail when a log file exists", async () => {
    const h = makeHarness();
    try {
      const path = ensureLogPath("hub", h.configDir);
      writeFileSync(path, "hub line one\nhub line two\n");
      const log: string[] = [];
      const code = await logs("hub", {
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
      });
      expect(code).toBe(0);
      expect(log).toEqual(["hub line one", "hub line two"]);
    } finally {
      h.cleanup();
    }
  });
});
