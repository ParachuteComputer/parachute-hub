import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "../commands/status.ts";
import type { HubUnitDeps, HubUnitStateResult } from "../hub-unit.ts";
import {
  type ModuleStatesResult,
  NoOperatorTokenError,
  OperatorTokenExpiredError,
} from "../module-ops-client.ts";
import { upsertService } from "../services-manifest.ts";

/**
 * Phase 5b (design §6.4): `status` reads the hub row from the platform manager +
 * `/health` and the module rows from the running supervisor (`GET /api/modules`)
 * — the ONLY runtime now that the detached pidfile arm is retired. Everything
 * below is driven through the `supervisor` seams — no real launchd/systemd/
 * socket/HTTP/db call. The manifest-derived rendering (URLs, version, persisted
 * start-error) is covered in `status.test.ts` (also supervised-arm now).
 */

function makeTempPath(): { path: string; cleanup: () => void; configDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-status-sup-"));
  return {
    path: join(dir, "services.json"),
    configDir: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Install-source deps that never touch the real filesystem (so the hub row's +
 * module rows' source classification is deterministic in the test runner).
 */
const STUB_INSTALL_SOURCE = {
  bunGlobalPrefixes: () => [] as string[],
  resolveBunGlobal: () => null,
  readJson: () => ({ version: "0.6.2" }),
  readGitHead: () => undefined,
};

/**
 * A throwaway db handle exposing ONLY `{ close }`. This is intentionally minimal:
 * on the supervisor status path the db is never READ — module states come from
 * the API (`fetchModuleStates`, stubbed here), and `buildSupervisorRows` only
 * opens the handle to pass it through + `close()` it in `finally`. The
 * `as unknown as Database` cast at the call site widens this to the full type;
 * if a future change adds a real db read on this path, it will fail at RUNTIME
 * (missing method) rather than typecheck — so wire the needed method in here.
 */
function fakeOpenDb(): { close: () => void } {
  return { close: () => {} };
}

/**
 * Minimal `HubUnitDeps` — only the fields the seams that ARE wired through deps
 * touch. `queryHubUnitState` / `probeHubHealth` / `fetchModuleStates` are
 * injected directly as the `supervisor` seams, so the deps here only need to be
 * a well-typed placeholder.
 */
const FAKE_HUB_UNIT_DEPS = {
  platform: "linux",
  getuid: () => 1000,
  homeDir: () => "/home/op",
  userName: () => "op",
  which: () => "/usr/bin/systemctl",
  run: () => ({ code: 0, stdout: "", stderr: "" }),
  writeFile: () => {},
  removeFile: () => {},
  readFile: () => undefined,
  exists: () => false,
  probeHealth: async () => true,
  portListening: async () => true,
  sleep: async () => {},
} as unknown as HubUnitDeps;

interface SupervisorArmOpts {
  managerState: HubUnitStateResult;
  hubHealthy: boolean;
  moduleStates?: ModuleStatesResult;
  fetchModuleStatesImpl?: () => Promise<ModuleStatesResult>;
}

/** Drive `status` through the supervisor arm with fully stubbed seams. */
function supervisorOpts(configDir: string, path: string, o: SupervisorArmOpts) {
  return {
    manifestPath: path,
    configDir,
    installSourceDeps: STUB_INSTALL_SOURCE,
    hubSrcDir: "/nonexistent/hub/src",
    supervisor: {
      hubUnitDeps: FAKE_HUB_UNIT_DEPS,
      queryHubUnitState: () => o.managerState,
      probeHubHealth: async () => o.hubHealthy,
      fetchModuleStates:
        o.fetchModuleStatesImpl ??
        (async () => o.moduleStates ?? { supervisorAvailable: true, modules: [] }),
      openDb: fakeOpenDb as unknown as (configDir: string) => import("bun:sqlite").Database,
    },
  };
}

describe("status — Phase 3c supervisor arm: hub row", () => {
  test("manager active + /health OK → running (active) with port", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "active" },
          hubHealthy: true,
          moduleStates: { supervisorAvailable: true, modules: [] },
        }),
        print: (l) => lines.push(l),
      });
      // With no modules + the hub active, status exits 0.
      expect(code).toBe(0);
      const out = lines.join("\n");
      expect(out).toMatch(/parachute-hub \(internal\)/);
      // Hub row is `active` and shows the canonical port (no manifest entry).
      const hubLine = lines.find((l) => l.includes("parachute-hub (internal)"));
      expect(hubLine).toBeDefined();
      expect(hubLine).toMatch(/\bactive\b/);
      expect(hubLine).toMatch(/1939/);
    } finally {
      cleanup();
    }
  });

  test("manager failed → failing + surfaces last exit code", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "failed", lastExitCode: 7 },
          hubHealthy: false,
        }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      const out = lines.join("\n");
      expect(out).toMatch(/\bfailing\b/);
      expect(out).toMatch(/the hub unit failed/);
      expect(out).toMatch(/last exit code 7/);
    } finally {
      cleanup();
    }
  });

  test("manager active but /health down → failing with starting/unhealthy nuance", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "active" },
          hubHealthy: false,
        }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      const out = lines.join("\n");
      const hubLine = lines.find((l) => l.includes("parachute-hub (internal)"));
      expect(hubLine).toMatch(/\bfailing\b/);
      expect(out).toMatch(/\/health not answering yet \(starting or unhealthy\)/);
    } finally {
      cleanup();
    }
  });

  test("no on-box manager (container) → /health is liveness, 'container runtime (managed)' note", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "no-manager" },
          hubHealthy: true,
          moduleStates: { supervisorAvailable: true, modules: [] },
        }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      const out = lines.join("\n");
      const hubLine = lines.find((l) => l.includes("parachute-hub (internal)"));
      expect(hubLine).toMatch(/\bactive\b/);
      expect(out).toMatch(/container runtime \(managed\)/);
    } finally {
      cleanup();
    }
  });

  test("container with /health down → hub row failing", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "no-manager" },
          hubHealthy: false,
        }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      const hubLine = lines.find((l) => l.includes("parachute-hub (internal)"));
      expect(hubLine).toMatch(/\bfailing\b/);
    } finally {
      cleanup();
    }
  });

  test("a thrown manager query never crashes status — degrades to /health verdict", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "active" }, // overridden by the throwing stub below
          hubHealthy: true,
          moduleStates: { supervisorAvailable: true, modules: [] },
        }),
        // Replace the query with one that throws — status must not crash.
        supervisor: {
          hubUnitDeps: FAKE_HUB_UNIT_DEPS,
          queryHubUnitState: () => {
            throw new Error("systemctl exploded");
          },
          probeHubHealth: async () => true,
          fetchModuleStates: async () => ({ supervisorAvailable: true, modules: [] }),
          openDb: fakeOpenDb as unknown as (configDir: string) => import("bun:sqlite").Database,
        },
        print: (l) => lines.push(l),
      });
      // /health answered → unknown manager state falls back to active.
      expect(code).toBe(0);
      const hubLine = lines.find((l) => l.includes("parachute-hub (internal)"));
      expect(hubLine).toMatch(/\bactive\b/);
    } finally {
      cleanup();
    }
  });
});

describe("status — Phase 3c supervisor arm: module rows", () => {
  test("hub up → module states come from the stubbed GET /api/modules", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.6.2" },
        path,
      );
      upsertService(
        {
          name: "parachute-scribe",
          port: 3200,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.6.2",
        },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "active" },
          hubHealthy: true,
          moduleStates: {
            supervisorAvailable: true,
            modules: [
              {
                short: "vault",
                installed: true,
                installed_version: "0.6.2",
                supervisor_status: "running",
                pid: 5151,
                supervisor_start_error: null,
              },
              {
                short: "scribe",
                installed: true,
                installed_version: "0.6.2",
                supervisor_status: "crashed",
                pid: null,
                supervisor_start_error: null,
              },
            ],
          },
        }),
        print: (l) => lines.push(l),
      });
      // scribe crashed → failing → overall exit 1.
      expect(code).toBe(1);
      const vaultLine = lines.find((l) => l.includes("parachute-vault"));
      const scribeLine = lines.find((l) => l.includes("parachute-scribe"));
      expect(vaultLine).toMatch(/\bactive\b/);
      expect(vaultLine).toMatch(/5151/); // pid from the supervisor snapshot
      expect(scribeLine).toMatch(/\bfailing\b/);
      // The failing row surfaces the supervisor status on a continuation line.
      expect(lines.some((l) => l.includes("supervisor: crashed"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("module with a structured startError surfaces the missing-dependency note", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.6.2" },
        path,
      );
      const lines: string[] = [];
      await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "active" },
          hubHealthy: true,
          moduleStates: {
            supervisorAvailable: true,
            modules: [
              {
                short: "vault",
                installed: true,
                installed_version: "0.6.2",
                supervisor_status: "crashed",
                pid: null,
                supervisor_start_error: {
                  error_type: "missing_dependency",
                  error_description: "parachute-vault is required",
                  binary: "parachute-vault",
                  at: "2026-06-01T00:00:00Z",
                },
              },
            ],
          },
        }),
        print: (l) => lines.push(l),
      });
      const out = lines.join("\n");
      expect(out).toMatch(/failed to start: parachute-vault not installed/);
    } finally {
      cleanup();
    }
  });

  test("hub DOWN → modules degrade to inactive + 'hub is down' note, no hang/crash, exit 0", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.6.2" },
        path,
      );
      let fetched = false;
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "inactive" },
          hubHealthy: false,
          fetchModuleStatesImpl: async () => {
            fetched = true;
            return { supervisorAvailable: true, modules: [] };
          },
        }),
        print: (l) => lines.push(l),
      });
      // Hub down → modules are `inactive` (expected, not a failure) → exit 0.
      expect(code).toBe(0);
      // We must NOT call the module-states API when the hub is down (children
      // die with the hub; the call would just connection-refuse).
      expect(fetched).toBe(false);
      const vaultLine = lines.find((l) => l.includes("parachute-vault"));
      expect(vaultLine).toMatch(/\binactive\b/);
      expect(lines.some((l) => l.includes("hub is down — its modules are stopped"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("no operator token → graceful degrade (manifest rows + actionable hint), no 401 crash", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.6.2" },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "active" },
          hubHealthy: true,
          fetchModuleStatesImpl: async () => {
            throw new NoOperatorTokenError();
          },
        }),
        print: (l) => lines.push(l),
      });
      // We could not read run-state, but didn't crash. The module row falls back
      // to `inactive` (no supervisor snapshot) — a stopped row is exit 0.
      expect(code).toBe(0);
      const out = lines.join("\n");
      expect(out).toMatch(/parachute-vault/);
      expect(out).toMatch(/run `parachute auth rotate-operator`/);
    } finally {
      cleanup();
    }
  });

  test("expired operator token → graceful degrade, no crash", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.6.2" },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "active" },
          hubHealthy: true,
          fetchModuleStatesImpl: async () => {
            throw new OperatorTokenExpiredError(
              "token expired — run `parachute auth rotate-operator`",
            );
          },
        }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.some((l) => l.includes("rotate-operator"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("API error reading module states → degrade with the message, no crash", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.6.2" },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "active" },
          hubHealthy: true,
          fetchModuleStatesImpl: async () => {
            throw new Error("the api blew up");
          },
        }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.some((l) => l.includes("couldn't read live module state"))).toBe(true);
      expect(lines.some((l) => l.includes("the api blew up"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("starting/restarting supervisor status → pending, not a failure (exit 0)", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        { name: "parachute-vault", port: 1940, paths: ["/"], health: "/health", version: "0.6.2" },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          managerState: { state: "active" },
          hubHealthy: true,
          moduleStates: {
            supervisorAvailable: true,
            modules: [
              {
                short: "vault",
                installed: true,
                installed_version: "0.6.2",
                supervisor_status: "starting",
                pid: 9090,
                supervisor_start_error: null,
              },
            ],
          },
        }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      const vaultLine = lines.find((l) => l.includes("parachute-vault"));
      expect(vaultLine).toMatch(/\bpending\b/);
    } finally {
      cleanup();
    }
  });
});

// The "Phase 3c discriminant" block (no-supervisor / unitInstalled:false →
// detached pidfile-probe arm) was removed in Phase 5b: the detached arm is
// retired, so there is no discriminant — `status` always reads the platform
// manager + supervisor. The supervisor-path readout is exercised throughout the
// suites above; a box with no hub unit degrades gracefully (manager `no-unit` /
// `/health` down → inactive rows), which the hub-row + module-row suites cover.
