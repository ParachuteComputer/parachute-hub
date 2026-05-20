import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_MODULES_OPS_REQUIRED_SCOPE,
  _resetOperationsRegistryForTests,
  handleInstall,
  handleOperationGet,
  handleRestart,
  handleUninstall,
  handleUpgrade,
  parseModulesPath,
} from "../api-modules-ops.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { setModuleInstallChannel } from "../hub-settings.ts";
import { recordTokenMint, signAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { type SpawnRequest, type SupervisedProc, Supervisor } from "../supervisor.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  dir: string;
  manifestPath: string;
  db: ReturnType<typeof openHubDb>;
  userId: string;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-modules-ops-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const user = await createUser(db, "owner", "pw");
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    db,
    userId: user.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function mintBearer(h: Harness, scopes: string[]): Promise<string> {
  const signed = await signAccessToken(h.db, {
    sub: h.userId,
    scopes,
    audience: "parachute-hub",
    clientId: "parachute-hub",
    issuer: ISSUER,
    ttlSeconds: 3600,
  });
  recordTokenMint(h.db, {
    jti: signed.jti,
    createdVia: "operator_mint",
    subject: h.userId,
    clientId: "parachute-hub",
    scopes,
    expiresAt: signed.expiresAt,
  });
  return signed.token;
}

function postReq(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, { method: "POST", headers });
}

function getReq(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, { method: "GET", headers });
}

function makeIdleSupervisor(): {
  supervisor: Supervisor;
  spawns: SpawnRequest[];
} {
  const spawns: SpawnRequest[] = [];
  const spawnFn = (req: SpawnRequest): SupervisedProc => {
    spawns.push(req);
    // The fake's `exited` resolves when kill() is called, mirroring a
    // well-behaved child that exits on SIGTERM. Without this, the
    // supervisor's `restart()` awaits forever after the stop signal.
    let resolveExit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    return {
      pid: 7777,
      exited,
      stdout: null,
      stderr: null,
      kill: () => resolveExit(0),
    };
  };
  return { supervisor: new Supervisor({ spawnFn }), spawns };
}

function writeManifest(path: string, services: unknown[]): void {
  writeFileSync(path, JSON.stringify({ services }));
}

/** Run a no-op shell — production calls `bun add`/`bun remove`; tests don't. */
function alwaysOkRun(): {
  run: (cmd: readonly string[]) => Promise<number>;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd) => {
      calls.push([...cmd]);
      return 0;
    },
  };
}

describe("parseModulesPath", () => {
  test("recognizes curated short + action", () => {
    expect(parseModulesPath("/api/modules/vault/install")).toEqual({
      short: "vault",
      rest: "install",
    });
    expect(parseModulesPath("/api/modules/scribe/upgrade")).toEqual({
      short: "scribe",
      rest: "upgrade",
    });
  });

  test("rejects non-curated shorts (no marketplace yet)", () => {
    // Channel exists in FIRST_PARTY_FALLBACKS but is exploration, not
    // in CURATED_MODULES — the v0.6 surface refuses to drive it via
    // /api/modules.
    expect(parseModulesPath("/api/modules/channel/install")).toBeUndefined();
    expect(parseModulesPath("/api/modules/random/install")).toBeUndefined();
  });

  test("rejects malformed paths", () => {
    expect(parseModulesPath("/api/modules/")).toBeUndefined();
    expect(parseModulesPath("/api/modules/vault")).toBeUndefined();
    expect(parseModulesPath("/something/else")).toBeUndefined();
  });
});

describe("POST /api/modules/:short/install", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("returns 401 on missing bearer", async () => {
    const { supervisor } = makeIdleSupervisor();
    const res = await handleInstall(postReq("/api/modules/vault/install", {}), "vault", {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      run: async () => 0,
    });
    expect(res.status).toBe(401);
  });

  test("returns 403 on bearer without parachute:host:admin scope", async () => {
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearer(h, ["scribe:transcribe"]);
    const res = await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run: async () => 0,
      },
    );
    expect(res.status).toBe(403);
  });

  test("returns 403 on bearer with only :host:auth (not :host:admin) — destructive ops elevated", async () => {
    // `:host:auth` is the read-only catalog scope (`GET /api/modules`).
    // Destructive POSTs are admin-only. Mint a token that carries
    // *only* `:auth` and confirm install is refused — the boundary
    // that keeps automation callers from uninstalling vault.
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearer(h, ["parachute:host:auth"]);
    const res = await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run: async () => 0,
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("insufficient_scope");
    expect(body.error_description).toContain("parachute:host:admin");
  });

  test("202 + operation_id, runs bun add + seeds services.json + spawns", async () => {
    const { supervisor, spawns } = makeIdleSupervisor();
    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { operation_id: string };
    expect(body.operation_id).toBeDefined();

    // Wait a microtask for the async install to settle. The
    // alwaysOkRun returns immediately, so the chain
    // bun-add → seed → spawn happens within one microtask
    // batch — give it two ticks to be safe.
    await new Promise((r) => setTimeout(r, 10));

    // `bun add` was called with the @latest spec.
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
    // services.json now has the vault row (the seed-on-missing path).
    const manifest = JSON.parse(readFileSync(h.manifestPath, "utf8")) as {
      services: Array<{ name: string }>;
    };
    expect(manifest.services.some((s) => s.name === "parachute-vault")).toBe(true);
    // Supervisor was handed the spawn.
    expect(spawns.find((s) => s.short === "vault")?.cmd).toEqual(["parachute-vault", "serve"]);
  });

  test("idempotent: already-installed + running returns succeeded immediately", async () => {
    // Pre-seed services.json + supervisor state.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
      },
    ]);
    const { supervisor } = makeIdleSupervisor();
    await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });

    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { operation_id: string };

    // bun add was NOT called — short-circuit hit.
    expect(calls).toEqual([]);

    // The operation record is already in succeeded state.
    const opRes = await handleOperationGet(
      getReq(`/api/modules/operations/${body.operation_id}`, {
        authorization: `Bearer ${bearer}`,
      }),
      body.operation_id,
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
      },
    );
    const op = (await opRes.json()) as { status: string };
    expect(op.status).toBe("succeeded");
  });

  test("uses the rc channel when hub_settings.module_install_channel = rc (hub#275)", async () => {
    // Operator's set the channel via the SPA toggle / env var bootstrap;
    // the next install must construct `<pkg>@rc` rather than `<pkg>@latest`.
    setModuleInstallChannel(h.db, "rc");
    const { supervisor } = makeIdleSupervisor();
    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
      },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
    expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
  });

  test("toggling channel back to latest takes effect on next install (no restart)", async () => {
    setModuleInstallChannel(h.db, "rc");
    setModuleInstallChannel(h.db, "latest");
    const { supervisor } = makeIdleSupervisor();
    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
    expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
  });

  test("failed bun-add surfaces failed status on the operation", async () => {
    const { supervisor } = makeIdleSupervisor();
    // Run returns 1 + findGlobalInstall returns null = real failure.
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      run: async () => 1,
      findGlobalInstall: () => null,
    };
    const res = await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      deps,
    );
    const body = (await res.json()) as { operation_id: string };
    await new Promise((r) => setTimeout(r, 10));
    const opRes = await handleOperationGet(
      getReq(`/api/modules/operations/${body.operation_id}`, {
        authorization: `Bearer ${bearer}`,
      }),
      body.operation_id,
      deps,
    );
    const op = (await opRes.json()) as { status: string; error?: string };
    expect(op.status).toBe("failed");
    expect(op.error).toMatch(/bun add -g exited 1/);
  });
});

describe("POST /api/modules/:short/restart", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("404 not_supervised when module isn't running", async () => {
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleRestart(
      postReq("/api/modules/vault/restart", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run: async () => 0,
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_supervised");
  });

  test("returns new state on success", async () => {
    const { supervisor } = makeIdleSupervisor();
    await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });

    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleRestart(
      postReq("/api/modules/vault/restart", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run: async () => 0,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { short: string; state: { status: string } };
    expect(body.short).toBe("vault");
    // restart sets the state to either restarting or running depending
    // on timing — either is acceptable here as long as it's not crashed/stopped.
    expect(["restarting", "running", "starting"]).toContain(body.state.status);
  });
});

describe("POST /api/modules/:short/upgrade", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("202 + bun add @latest + restart on already-running module", async () => {
    const { supervisor } = makeIdleSupervisor();
    await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });

    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleUpgrade(
      postReq("/api/modules/vault/upgrade", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
      },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
  });

  test("uses the rc channel when hub_settings.module_install_channel = rc (hub#275)", async () => {
    setModuleInstallChannel(h.db, "rc");
    const { supervisor } = makeIdleSupervisor();
    await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });

    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleUpgrade(
      postReq("/api/modules/vault/upgrade", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
      },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
    expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
  });

  test("fails with 'try install first' when module is installed but never supervised", async () => {
    // Module has a services.json row (e.g. seeded by `parachute install`
    // pre-supervisor era) but the supervisor never spawned it.
    // `bun add -g` succeeds, then `supervisor.restart()` returns
    // undefined because there's no entry in the Map. The operation
    // should land in `failed` with the canonical "try install first"
    // message rather than silently succeed (hub#265).
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
      },
    ]);
    const { supervisor, spawns } = makeIdleSupervisor();
    // Intentionally do NOT call supervisor.start(...) — that's the
    // path under test.

    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      run,
    };
    const res = await handleUpgrade(
      postReq("/api/modules/vault/upgrade", { authorization: `Bearer ${bearer}` }),
      "vault",
      deps,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { operation_id: string };
    // Give the async runUpgrade chain a tick to settle.
    await new Promise((r) => setTimeout(r, 10));

    // bun add was still attempted (it's the first step).
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
    // No supervisor spawn ever happened — confirms the missing
    // supervisor entry is what we exercised, not some other branch.
    expect(spawns).toEqual([]);

    // Poll the operation: status `failed`, message points the
    // operator at the install path.
    const opRes = await handleOperationGet(
      getReq(`/api/modules/operations/${body.operation_id}`, {
        authorization: `Bearer ${bearer}`,
      }),
      body.operation_id,
      deps,
    );
    const op = (await opRes.json()) as {
      status: string;
      error?: string;
      log: string[];
    };
    expect(op.status).toBe("failed");
    expect(op.error).toMatch(/supervisor restart found no module/);
    expect(op.log.join(" ")).toMatch(/try install first/);
  });
});

describe("POST /api/modules/:short/uninstall", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("stops child + removes services.json row + runs bun remove", async () => {
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
      },
    ]);
    const { supervisor } = makeIdleSupervisor();
    await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });

    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleUninstall(
      postReq("/api/modules/vault/uninstall", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { short: string; log: string[] };
    expect(body.short).toBe("vault");
    // The log captures each step's outcome.
    expect(body.log.join(" ")).toMatch(/supervisor stopped/);
    expect(body.log.join(" ")).toMatch(/removed parachute-vault from services.json/);

    // services.json row is gone.
    const manifest = JSON.parse(readFileSync(h.manifestPath, "utf8")) as {
      services: Array<{ name: string }>;
    };
    expect(manifest.services.some((s) => s.name === "parachute-vault")).toBe(false);
    // bun remove was called.
    expect(calls).toContainEqual(["bun", "remove", "-g", "@openparachute/vault"]);
  });

  test("idempotent on never-installed module", async () => {
    const { supervisor } = makeIdleSupervisor();
    const { run } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleUninstall(
      postReq("/api/modules/vault/uninstall", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { log: string[] };
    expect(body.log.join(" ")).toMatch(/not supervised/);
    expect(body.log.join(" ")).toMatch(/not in services.json/);
  });
});

describe("GET /api/modules/operations/:id", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("404 on unknown id", async () => {
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleOperationGet(
      getReq("/api/modules/operations/no-such-id", { authorization: `Bearer ${bearer}` }),
      "no-such-id",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run: async () => 0,
      },
    );
    expect(res.status).toBe(404);
  });
});
