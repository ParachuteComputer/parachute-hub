import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { status } from "../commands/status.ts";
import type { HubUnitDeps, HubUnitStateResult } from "../hub-unit.ts";
import type { ModuleStatesResult } from "../module-ops-client.ts";
import { upsertService } from "../services-manifest.ts";

/**
 * Phase 5b: `status` reads the hub row from the platform manager + `/health` and
 * the module rows from the running supervisor (`GET /api/modules`). The detached
 * pidfile/HTTP-probe arm was retired, so these tests — the table-rendering /
 * per-module URL deep-link / persisted-start-error / state-rollup coverage that
 * used to live on the detached arm — drive the supervised arm instead. The
 * detached-specific cases that no longer exist (HTTP probe success/failure, the
 * http-401-healthy carve-out, known-stopped-skips-probe) are not re-asserted: a
 * module's run-state comes from the supervisor now, not an HTTP probe.
 *
 * The hub-row state machine + module-state degradation paths are covered in
 * `status-supervisor.test.ts`; this file focuses on the manifest-derived
 * rendering (URLs, version, persisted start-error) that `manifestRowBase`
 * produces for each module row.
 */

function makeTempPath(): { path: string; cleanup: () => void; configDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-status-"));
  return {
    path: join(dir, "services.json"),
    configDir: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Install-source deps that never touch the real filesystem. */
const STUB_INSTALL_SOURCE = {
  bunGlobalPrefixes: () => [] as string[],
  resolveBunGlobal: () => null,
  readJson: () => ({ version: "0.6.2" }),
  readGitHead: () => undefined,
};

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

function fakeOpenDb(): { close: () => void } {
  return { close: () => {} };
}

interface ArmOpts {
  managerState?: HubUnitStateResult;
  hubHealthy?: boolean;
  moduleStates?: ModuleStatesResult;
}

/**
 * Drive `status` through the supervised arm with a healthy hub + the given module
 * states. Defaults: manager `active`, hub `/health` OK, no module rows.
 */
function supervisorOpts(configDir: string, path: string, o: ArmOpts = {}) {
  return {
    manifestPath: path,
    configDir,
    installSourceDeps: STUB_INSTALL_SOURCE,
    hubSrcDir: "/nonexistent/hub/src",
    supervisor: {
      hubUnitDeps: FAKE_HUB_UNIT_DEPS,
      queryHubUnitState: () => o.managerState ?? { state: "active" as const },
      probeHubHealth: async () => o.hubHealthy ?? true,
      fetchModuleStates: async () => o.moduleStates ?? { supervisorAvailable: true, modules: [] },
      openDb: fakeOpenDb as unknown as (configDir: string) => import("bun:sqlite").Database,
    },
  };
}

/** A `running` supervisor snapshot for a short name (the happy-path module row). */
function runningModule(short: string, version = "0.6.2") {
  return {
    short,
    installed: true,
    installed_version: version,
    supervisor_status: "running" as const,
    pid: 5151,
    supervisor_start_error: null,
  };
}

describe("status — table + hub row", () => {
  test("empty manifest still renders the hub row (a unit-managed hub runs with zero modules)", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      // The hub row is meaningful even with no modules installed.
      expect(lines.some((l) => l.includes("parachute-hub (internal)"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("all-running modules return 0 and render the table with versions + state", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.6.2",
        },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          moduleStates: { supervisorAvailable: true, modules: [runningModule("vault")] },
        }),
        print: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      const vaultLine = lines.find((l) => l.includes("parachute-vault"));
      expect(vaultLine).toMatch(/\bactive\b/);
      expect(vaultLine).toMatch(/0\.6\.2/);
    } finally {
      cleanup();
    }
  });

  test("persisted lastStartError surfaces on a continuation line", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.6.2",
          lastStartError: {
            error_type: "missing_dependency",
            error_description: "parachute-vault not installed",
            binary: "parachute-vault",
          },
        },
        path,
      );
      const lines: string[] = [];
      const code = await status({
        ...supervisorOpts(configDir, path, {
          // No live supervisor start-error → falls back to the persisted manifest note.
          moduleStates: {
            supervisorAvailable: true,
            modules: [
              {
                short: "vault",
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
      // crashed → failing → exit 1; the persisted missing-dependency note shows.
      expect(code).toBe(1);
      expect(lines.join("\n")).toMatch(/failed to start: parachute-vault not installed/);
    } finally {
      cleanup();
    }
  });
});

describe("status — per-module URL deep-links (manifestRowBase / urlForEntry)", () => {
  async function urlFor(name: string, port: number, paths: string[]): Promise<string> {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      const short = name.replace(/^parachute-/, "");
      upsertService({ name, port, paths, health: `${paths[0]}/health`, version: "0.6.2" }, path);
      const lines: string[] = [];
      await status({
        ...supervisorOpts(configDir, path, {
          moduleStates: { supervisorAvailable: true, modules: [runningModule(short)] },
        }),
        print: (l) => lines.push(l),
      });
      return lines.join("\n");
    } finally {
      cleanup();
    }
  }

  test("vault row prints the MCP URL (path + /mcp suffix)", async () => {
    const out = await urlFor("parachute-vault", 1940, ["/vault/default"]);
    expect(out).toMatch(/\/vault\/default\/mcp/);
  });

  test("scribe row prints the root URL (API is at /, ignore path prefix)", async () => {
    const out = await urlFor("parachute-scribe", 3200, ["/scribe"]);
    expect(out).toMatch(/127\.0\.0\.1:3200|localhost:3200/);
  });

  test("notes row prints the UI URL (port + /notes mount)", async () => {
    const out = await urlFor("parachute-notes", 5173, ["/notes"]);
    expect(out).toMatch(/:5173\/notes/);
  });

  test("channel row prints port + /channel mount", async () => {
    const out = await urlFor("parachute-channel", 1943, ["/channel"]);
    expect(out).toMatch(/:1943\/channel/);
  });

  test("unknown third-party service falls back to bare host:port + paths[0]", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "acme-widget",
          port: 4321,
          paths: ["/widget"],
          health: "/widget/health",
          version: "1.0.0",
          installDir: "/tmp/acme",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        ...supervisorOpts(configDir, path, {
          moduleStates: { supervisorAvailable: true, modules: [runningModule("acme-widget")] },
        }),
        print: (l) => lines.push(l),
      });
      expect(lines.join("\n")).toMatch(/:4321\/widget/);
    } finally {
      cleanup();
    }
  });

  test("non-curated supervised module reads `active` via the `supervised` fallback — hub#539", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      // surface is supervised but absent from the curated `modules` catalog
      // (which only carries vault/scribe). Before hub#539 it mapped to
      // `inactive` despite running; now `status` falls back to `supervised`.
      upsertService(
        {
          name: "parachute-surface",
          port: 1946,
          paths: ["/surface"],
          health: "/surface/healthz",
          version: "0.2.2",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        ...supervisorOpts(configDir, path, {
          // `modules` empty (curated catalog omits surface); run-state ONLY in
          // `supervised` — exactly the wire shape the live hub now returns.
          moduleStates: {
            supervisorAvailable: true,
            modules: [],
            supervised: [runningModule("surface")],
          },
        }),
        print: (l) => lines.push(l),
      });
      const surfaceLine = lines.find((l) => l.includes("parachute-surface")) ?? "";
      expect(surfaceLine).toMatch(/\bactive\b/);
      expect(surfaceLine).not.toMatch(/\binactive\b/);
    } finally {
      cleanup();
    }
  });

  test("module absent from BOTH modules and supervised stays `inactive` — hub#539 boundary", async () => {
    const { path, configDir, cleanup } = makeTempPath();
    try {
      upsertService(
        {
          name: "parachute-surface",
          port: 1946,
          paths: ["/surface"],
          health: "/surface/healthz",
          version: "0.2.2",
        },
        path,
      );
      const lines: string[] = [];
      await status({
        ...supervisorOpts(configDir, path, {
          moduleStates: { supervisorAvailable: true, modules: [], supervised: [] },
        }),
        print: (l) => lines.push(l),
      });
      const surfaceLine = lines.find((l) => l.includes("parachute-surface")) ?? "";
      expect(surfaceLine).toMatch(/\binactive\b/);
    } finally {
      cleanup();
    }
  });
});
