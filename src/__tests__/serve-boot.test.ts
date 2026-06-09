import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootSupervisedModules,
  buildModuleSpawnRequest,
  reconcilePortToCanonical,
} from "../commands/serve-boot.ts";
import { type ServiceEntry, readManifestLenient, writeManifest } from "../services-manifest.ts";
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

  test("sets PORT in child env from services.json entry (hub#357)", async () => {
    // Container deploys (Render etc.) set PORT in hub's process.env via
    // Dockerfile / platform injection. The supervisor's defaultSpawnFn
    // passes `env: process.env` so children inherit hub's PORT and try
    // to bind hub's own port → EADDRINUSE crashloop. This boot path
    // (called on hub startup to re-spawn supervised modules from
    // services.json) was missed by hub#356 which only fixed the
    // install-time + lifecycle paths. Third spawn site, same fix shape.
    writeManifest({ services: [VAULT_ENTRY] }, h.manifestPath);
    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });

    await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
    });

    // VAULT_ENTRY's port = 1940 (vault's canonical).
    expect(recorder.calls[0]?.env?.PORT).toBe("1940");
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

  test("services.json entry.port wins over a stale .env PORT (hub#537)", async () => {
    // Pre-hub#206 installs wrote `PORT=` into the per-service .env. A leftover
    // PORT there that disagrees with services.json (e.g. scribe's stale 1944 vs
    // canonical 1943) must NOT shadow entry.port — otherwise the supervisor
    // injects + probes the wrong port and records a false `started_but_unbound`.
    writeManifest({ services: [VAULT_ENTRY] }, h.manifestPath);
    mkdirSync(join(h.dir, "vault"), { recursive: true });
    writeFileSync(join(h.dir, "vault", ".env"), "PORT=1944\nSCRIBE_AUTH_TOKEN=secret-token\n");

    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });

    await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
    });

    // entry.port (1940) wins; the stale .env PORT is dropped. Other .env
    // values still merge.
    expect(recorder.calls[0]?.env?.PORT).toBe("1940");
    expect(recorder.calls[0]?.env?.SCRIBE_AUTH_TOKEN).toBe("secret-token");
  });

  test("extraEnv PORT still wins over entry.port (layer 4 — test seam / first-boot)", () => {
    // Dropping a stale .env PORT must not affect the documented layer-4 override:
    // an explicit `opts.extraEnv.PORT` (programmatic, not a stale on-disk file)
    // still wins last.
    const req = buildModuleSpawnRequest("vault", VAULT_ENTRY, ["parachute-vault", "serve"], {
      configDir: h.dir,
      extraEnv: { PORT: "9999" },
    });
    expect(req.env?.PORT).toBe("9999");
  });

  test("injects an enriched PATH carrying the inherited process PATH (hub launchd-PATH fix)", () => {
    // The hub unit bakes a minimal PATH and Bun.spawn defaults to empty env, so
    // without this injection the child can't find operator tools (scribe's
    // parakeet-mlx / ffmpeg). The req must carry a PATH, and it must preserve
    // whatever the hub process inherited.
    const req = buildModuleSpawnRequest("vault", VAULT_ENTRY, ["parachute-vault", "serve"], {
      configDir: h.dir,
    });
    expect(req.env?.PATH).toBeDefined();
    expect(req.env?.PATH?.length).toBeGreaterThan(0);
    // Every entry the hub inherited is still present (enrichment appends, never
    // drops). process.env.PATH is always set in the test runner.
    for (const entry of (process.env.PATH ?? "").split(":").filter((e) => e.length > 0)) {
      expect(req.env?.PATH?.split(":")).toContain(entry);
    }
  });

  test("a per-service .env PATH wins over the injected enrichment (operator intent)", () => {
    mkdirSync(join(h.dir, "vault"), { recursive: true });
    writeFileSync(join(h.dir, "vault", ".env"), "PATH=/operator/pinned/bin\n");
    const req = buildModuleSpawnRequest("vault", VAULT_ENTRY, ["parachute-vault", "serve"], {
      configDir: h.dir,
    });
    expect(req.env?.PATH).toBe("/operator/pinned/bin");
  });

  test("the API-start path (buildModuleSpawnRequest reuse) also carries the enriched PATH", () => {
    // handleStart() in api-modules-ops.ts routes through buildModuleSpawnRequest,
    // so the /api/modules/:short/start path inherits the same PATH fix. Assert
    // the shared builder is the single source — extraEnv (the start handler's
    // spawnEnv seam) does NOT clobber PATH unless it explicitly sets one.
    const req = buildModuleSpawnRequest("vault", VAULT_ENTRY, ["parachute-vault", "serve"], {
      configDir: h.dir,
      extraEnv: { SOME_FLAG: "1" },
    });
    expect(req.env?.PATH).toBeDefined();
    expect(req.env?.SOME_FLAG).toBe("1");
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

// channel#41 — a transiently-wrong (drifted) services.json port for a
// fixed-port first-party module self-perpetuates: the supervisor injects PORT /
// probes / proxies from that row, so the wrong port strands the module forever.
// The boot path snaps it back to canonical before spawn AND persists the fix so
// the reverse-proxy (which reads services.json) routes correctly.
describe("reconcilePortToCanonical (channel#41)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.cleanup());

  // The live-observed signature: channel's row carried 19415 instead of its
  // canonical 1941.
  const DRIFTED_CHANNEL: ServiceEntry = {
    name: "parachute-channel",
    port: 19415,
    paths: ["/channel"],
    health: "/health",
    version: "0.1.0",
  };

  test("snaps a drifted fixed-port row back to canonical + persists it", () => {
    writeManifest({ services: [DRIFTED_CHANNEL] }, h.manifestPath);
    const logs: string[] = [];

    const reconciled = reconcilePortToCanonical(DRIFTED_CHANNEL, h.manifestPath, (l) =>
      logs.push(l),
    );

    // Returned entry carries canonical (channel → 1941).
    expect(reconciled.port).toBe(1941);
    // And it's PERSISTED — the proxy reads services.json, so the row itself must
    // now point at 1941 or `/channel/*` keeps routing to the dead 19415.
    const onDisk = readManifestLenient(h.manifestPath).services.find(
      (s) => s.name === "parachute-channel",
    );
    expect(onDisk?.port).toBe(1941);
    expect(
      logs.some((l) => l.includes("reconciled") && l.includes("19415") && l.includes("1941")),
    ).toBe(true);
  });

  test("no-op when the row already sits on its canonical port (vault/scribe/surface common path)", () => {
    writeManifest({ services: [VAULT_ENTRY] }, h.manifestPath);
    const out = reconcilePortToCanonical(VAULT_ENTRY, h.manifestPath);
    expect(out).toBe(VAULT_ENTRY); // identity — untouched
    expect(out.port).toBe(1940);
  });

  test("third-party module (no canonical) is never touched", () => {
    const thirdParty: ServiceEntry = {
      name: "third-party-thing",
      port: 7777,
      paths: ["/thing"],
      health: "/thing/health",
      version: "1.0.0",
    };
    writeManifest({ services: [thirdParty] }, h.manifestPath);
    const out = reconcilePortToCanonical(thirdParty, h.manifestPath);
    expect(out).toBe(thirdParty);
    expect(out.port).toBe(7777);
  });

  test("does NOT steal the canonical port when another row already holds it", () => {
    // Another row legitimately occupies 1941 — reconciling would trip the
    // write-side duplicate-port guard and isn't channel's to take. Leave the
    // drift; the supervisor's squatter detection surfaces it.
    const squatter: ServiceEntry = {
      name: "parachute-vault",
      port: 1941, // unusual, but it owns this slot right now
      paths: ["/vault/default"],
      health: "/vault/default/health",
      version: "0.4.5",
    };
    writeManifest({ services: [squatter, DRIFTED_CHANNEL] }, h.manifestPath);
    const logs: string[] = [];

    const out = reconcilePortToCanonical(DRIFTED_CHANNEL, h.manifestPath, (l) => logs.push(l));

    expect(out.port).toBe(19415); // unchanged
    const onDisk = readManifestLenient(h.manifestPath).services.find(
      (s) => s.name === "parachute-channel",
    );
    expect(onDisk?.port).toBe(19415); // not rewritten
    expect(logs.some((l) => l.includes("held by another row"))).toBe(true);
  });

  test("boot path injects PORT=canonical + persists the fix for a drifted channel row", async () => {
    writeManifest({ services: [DRIFTED_CHANNEL] }, h.manifestPath);
    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });

    await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
    });

    // The supervisor child gets PORT=1941 (so it binds + the readiness probe
    // checks the right port), not the drifted 19415.
    expect(recorder.calls[0]?.short).toBe("channel");
    expect(recorder.calls[0]?.env?.PORT).toBe("1941");
    // services.json row is reconciled → proxy routes /channel/* to 1941.
    const onDisk = readManifestLenient(h.manifestPath).services.find(
      (s) => s.name === "parachute-channel",
    );
    expect(onDisk?.port).toBe(1941);
  });

  test("boot path leaves a non-drifted vault row's port untouched", async () => {
    writeManifest({ services: [VAULT_ENTRY] }, h.manifestPath);
    const recorder = makeRecorder();
    const sup = new Supervisor({ spawnFn: recorder.spawn });

    await bootSupervisedModules(sup, {
      manifestPath: h.manifestPath,
      configDir: h.dir,
    });

    expect(recorder.calls[0]?.env?.PORT).toBe("1940");
    const onDisk = readManifestLenient(h.manifestPath).services.find(
      (s) => s.name === "parachute-vault",
    );
    expect(onDisk?.port).toBe(1940);
  });
});
