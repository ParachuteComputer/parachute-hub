import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootSupervisedModules } from "../commands/serve-boot.ts";
import { type ServiceEntry, writeManifest } from "../services-manifest.ts";
import { type SpawnRequest, type SupervisedProc, Supervisor } from "../supervisor.ts";

interface Harness {
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "serve-boot-"));
  const manifestPath = join(dir, "services.json");
  return {
    dir,
    manifestPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeFakeProc(pid: number): SupervisedProc & { resolveExit: (c: number | null) => void } {
  let resolveExit!: (c: number | null) => void;
  const exited = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  return {
    pid,
    exited,
    stdout: null,
    stderr: null,
    kill: () => {},
    resolveExit,
  };
}

function makeRecorder(): {
  spawn: (req: SpawnRequest) => SupervisedProc;
  calls: SpawnRequest[];
} {
  const calls: SpawnRequest[] = [];
  let nextPid = 1000;
  return {
    calls,
    spawn: (req) => {
      calls.push(req);
      nextPid++;
      return makeFakeProc(nextPid);
    },
  };
}

const VAULT_ENTRY: ServiceEntry = {
  name: "parachute-vault",
  port: 1940,
  paths: ["/vault/default"],
  health: "/vault/default/health",
  version: "0.4.5",
};

const NOTES_ENTRY: ServiceEntry = {
  name: "parachute-notes",
  port: 1941,
  paths: ["/notes"],
  health: "/notes/health",
  version: "0.3.15",
};

describe("bootSupervisedModules", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  test("spawns one supervisor child per first-party services.json row", async () => {
    writeManifest({ services: [VAULT_ENTRY, NOTES_ENTRY] }, h.manifestPath);
    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });

    const results = await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "started")).toBe(true);
    expect(recorder.calls).toHaveLength(2);
    const shorts = recorder.calls.map((c) => c.short).sort();
    expect(shorts).toEqual(["notes", "vault"]);
  });

  test("empty services.json is a no-op", async () => {
    writeManifest({ services: [] }, h.manifestPath);
    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });

    const results = await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
    });

    expect(results).toEqual([]);
    expect(recorder.calls).toEqual([]);
  });

  test("forwards PARACHUTE_HUB_ORIGIN to child env when set", async () => {
    writeManifest({ services: [VAULT_ENTRY] }, h.manifestPath);
    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });

    await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
      hubOrigin: "https://hub.example",
    });

    expect(recorder.calls[0]?.env?.PARACHUTE_HUB_ORIGIN).toBe("https://hub.example");
  });

  test("merges per-module .env file into child env", async () => {
    writeManifest({ services: [VAULT_ENTRY] }, h.manifestPath);
    // Write a per-module .env at <configDir>/<short>/.env — what the
    // on-box flow's install-time scribe-key prompt produces.
    mkdirSync(join(h.dir, "vault"), { recursive: true });
    writeFileSync(
      join(h.dir, "vault", ".env"),
      "SCRIBE_AUTH_TOKEN=secret-token\nSCRIBE_URL=http://127.0.0.1:3200\n",
    );

    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });

    await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
    });

    expect(recorder.calls[0]?.env?.SCRIBE_AUTH_TOKEN).toBe("secret-token");
    expect(recorder.calls[0]?.env?.SCRIBE_URL).toBe("http://127.0.0.1:3200");
  });

  test("hubOrigin wins over a stale .env entry on collision", async () => {
    writeManifest({ services: [VAULT_ENTRY] }, h.manifestPath);
    mkdirSync(join(h.dir, "vault"), { recursive: true });
    writeFileSync(join(h.dir, "vault", ".env"), "PARACHUTE_HUB_ORIGIN=http://stale.local\n");

    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });

    await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
      hubOrigin: "https://live.example",
    });

    // The live hub-origin from the runtime env beats the on-disk
    // stale value — that's the resolveHubOrigin precedence carried
    // over from lifecycle.ts.
    expect(recorder.calls[0]?.env?.PARACHUTE_HUB_ORIGIN).toBe("https://live.example");
  });

  test("rows with no resolvable startCmd are skipped with reason", async () => {
    // A third-party services.json entry that ALSO doesn't match a
    // first-party fallback AND has no installDir → no spec.
    const orphan: ServiceEntry = {
      name: "@third-party/unknown",
      port: 4000,
      paths: ["/unknown"],
      health: "/unknown/health",
      version: "0.1.0",
    };
    writeManifest({ services: [orphan] }, h.manifestPath);
    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });
    const logs: string[] = [];

    const results = await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
      log: (l) => logs.push(l),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.reason).toBe("no-spec");
    expect(recorder.calls).toEqual([]);
    expect(logs.some((l) => l.includes("no startCmd resolvable"))).toBe(true);
  });
});
