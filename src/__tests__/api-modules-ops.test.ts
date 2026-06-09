import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissingDependencyError, lookupDep } from "@openparachute/depcheck";
import {
  API_MODULES_OPS_REQUIRED_SCOPE,
  _resetOperationsRegistryForTests,
  handleInstall,
  handleLogs,
  handleOperationGet,
  handleRestart,
  handleStart,
  handleStop,
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

/**
 * Mint a host-admin bearer at a chosen `iss` (hub#516). The CLI presents the
 * operator token on loopback; after `expose` its `iss` is the public origin
 * while the loopback request resolves the loopback issuer.
 */
async function mintBearerAtIssuer(h: Harness, scopes: string[], iss: string): Promise<string> {
  const signed = await signAccessToken(h.db, {
    sub: h.userId,
    scopes,
    audience: "operator",
    clientId: "parachute-hub",
    issuer: iss,
    ttlSeconds: 3600,
  });
  recordTokenMint(h.db, {
    jti: signed.jti,
    createdVia: "operator_mint",
    subject: "operator",
    clientId: "parachute-hub",
    scopes,
    expiresAt: signed.expiresAt,
  });
  return signed.token;
}

/** The hub's public origin after `expose` — what the operator token's `iss` becomes. */
const PUBLIC_ORIGIN = "https://parachute.taildf9ce2.ts.net";
/** A foreign origin the hub never answers on. */
const FOREIGN_ORIGIN = "https://evil.example.com";

function postReq(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, { method: "POST", headers });
}

function postReqJson(path: string, headers: Record<string, string>, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getReq(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, { method: "GET", headers });
}

function makeIdleSupervisor(): {
  supervisor: Supervisor;
  spawns: SpawnRequest[];
} {
  const spawns: SpawnRequest[] = [];
  // Track each spawned proc by pid so the injected group-aware `killFn` can
  // forward the signal to the right fake (post-hub#88, `stop()` signals via
  // `killFn`, not `proc.kill` — so without this seam the fake's `exited` never
  // resolves and `stop`/`restart` time out).
  const byPid = new Map<number, SupervisedProc & { kill: () => void }>();
  const spawnFn = (req: SpawnRequest): SupervisedProc => {
    spawns.push(req);
    // The fake's `exited` resolves when kill() is called, mirroring a
    // well-behaved child that exits on SIGTERM. Without this, the
    // supervisor's `restart()` awaits forever after the stop signal.
    let resolveExit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    const proc: SupervisedProc & { kill: () => void } = {
      pid: 7777,
      exited,
      stdout: null,
      stderr: null,
      kill: () => resolveExit(0),
    };
    byPid.set(proc.pid, proc);
    return proc;
  };
  // Mirrors production's group-aware kill: the supervisor passes the leader
  // pid, we forward to the matching fake's `kill` (which resolves `exited`).
  const killFn = (pid: number): void => {
    byPid.get(Math.abs(pid))?.kill();
  };
  return { supervisor: new Supervisor({ spawnFn, killFn }), spawns };
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

/**
 * Test default for `isLinked`: assume the package is NOT bun-linked so
 * `runInstall` exercises the `bun add -g` path (which the stubbed runner
 * captures into `calls`). The production default at
 * `src/bun-link.ts` reads the contributor's real `~/.bun/install/global/`
 * symlinks; on Aaron's machine vault/scribe/notes/hub are all linked
 * (the canonical local-dev shape — smoke 2026-05-27 finding 1 caps the
 * fix). Tests asserting "bun add WAS called" must opt out of that leakage
 * by passing this stub. Tests specifically exercising the skip path use
 * an inline `isLinked: () => true` or a per-pkg discriminator.
 */
const TEST_DEFAULT_NOT_LINKED = (_pkg: string): boolean => false;

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

  test("recognizes the Phase 1 start / stop verbs", () => {
    expect(parseModulesPath("/api/modules/vault/start")).toEqual({
      short: "vault",
      rest: "start",
    });
    expect(parseModulesPath("/api/modules/scribe/stop")).toEqual({
      short: "scribe",
      rest: "stop",
    });
  });

  test("accepts any KNOWN module short — channel install now resolves (was the bug)", () => {
    // Post-2026-06-09 (modular-UI architecture, P2) the install-path gate is
    // `isKnownModuleShort` (KNOWN_MODULES ∪ FIRST_PARTY_FALLBACKS), NOT the old
    // CURATED_MODULES whitelist. channel is in FIRST_PARTY_FALLBACKS, so its
    // install path now resolves — fixing the running-but-uninstallable bug.
    expect(parseModulesPath("/api/modules/channel/install")).toEqual({
      short: "channel",
      rest: "install",
    });
    // Other known modules (runner / surface) resolve too.
    expect(parseModulesPath("/api/modules/runner/install")).toEqual({
      short: "runner",
      rest: "install",
    });
  });

  test("rejects unknown shorts (the hub itself + genuinely third-party rows)", () => {
    // `hub` isn't a supervised module (no registry entry) and a random short
    // has no install package — both still fall through to undefined so the
    // module-ops switch never acts on them.
    expect(parseModulesPath("/api/modules/hub/install")).toBeUndefined();
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
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
    // The install-time spawn path (spawnSupervised) injects the enriched PATH
    // so a module installed via /admin/modules can find operator tools (scribe's
    // parakeet-mlx / ffmpeg) — same fix as the serve-boot path, second spawn
    // site (hub launchd-PATH regression). It must carry the inherited PATH.
    const vaultEnv = spawns.find((s) => s.short === "vault")?.env;
    expect(vaultEnv?.PATH).toBeDefined();
    expect(vaultEnv?.PATH?.length).toBeGreaterThan(0);
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
    expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
  });

  // hub#337 — per-request channel in body + PARACHUTE_INSTALL_CHANNEL env var.
  // Precedence: body.channel > PARACHUTE_INSTALL_CHANNEL env > hub_settings row > "latest".

  test("body { channel: 'rc' } overrides the hub_settings row (hub#337)", async () => {
    // SPA-driven "install X at rc" affordance: per-call override that
    // doesn't flip the cluster-wide toggle.
    setModuleInstallChannel(h.db, "latest");
    const { supervisor } = makeIdleSupervisor();
    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleInstall(
      postReqJson(
        "/api/modules/vault/install",
        { authorization: `Bearer ${bearer}` },
        { channel: "rc" },
      ),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
        isLinked: TEST_DEFAULT_NOT_LINKED,
      },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
    expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
  });

  test("body { channel: 'latest' } overrides hub_settings.module_install_channel = rc (hub#337)", async () => {
    setModuleInstallChannel(h.db, "rc");
    const { supervisor } = makeIdleSupervisor();
    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    await handleInstall(
      postReqJson(
        "/api/modules/vault/install",
        { authorization: `Bearer ${bearer}` },
        { channel: "latest" },
      ),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
        isLinked: TEST_DEFAULT_NOT_LINKED,
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
    expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
  });

  test("body { channel: 'banana' } returns 400 invalid_channel (hub#337)", async () => {
    // Operator-typed garbage in the SPA → don't silently fall through to
    // the default; surface the typo immediately.
    const { supervisor } = makeIdleSupervisor();
    const { run } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleInstall(
      postReqJson(
        "/api/modules/vault/install",
        { authorization: `Bearer ${bearer}` },
        { channel: "banana" },
      ),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run,
        isLinked: TEST_DEFAULT_NOT_LINKED,
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_channel");
    expect(body.error_description).toMatch(/banana/);
  });

  test("missing body / empty body falls through to hub_settings channel (back-compat)", async () => {
    // Pre-hub#337 callers don't send a JSON body. The existing SPA paths
    // (and the first-boot wizard) keep working unchanged.
    setModuleInstallChannel(h.db, "rc");
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
  });

  test("PARACHUTE_INSTALL_CHANNEL env overrides hub_settings.module_install_channel (hub#337)", async () => {
    // The Render-deploy cascade shape: the platform sets the env var to
    // `rc`, hub's API path picks it up over the DB-stored default. Lets
    // an operator-toggle override that the platform-team hasn't pinned
    // still work via the SPA toggle below it — but with the env in
    // play, the env wins.
    setModuleInstallChannel(h.db, "latest");
    const prior = process.env.PARACHUTE_INSTALL_CHANNEL;
    process.env.PARACHUTE_INSTALL_CHANNEL = "rc";
    try {
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
          isLinked: TEST_DEFAULT_NOT_LINKED,
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
      expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
    } finally {
      // Bun's process.env supports the `[key]: undefined` shape
      // (biome's noDelete rule preferred this over `delete`).
      if (prior === undefined) process.env.PARACHUTE_INSTALL_CHANNEL = undefined;
      else process.env.PARACHUTE_INSTALL_CHANNEL = prior;
    }
  });

  test("body channel wins over PARACHUTE_INSTALL_CHANNEL env (hub#337)", async () => {
    // Per-request override beats the platform default — the SPA's
    // "install this one at latest even though the cluster's on rc" path.
    setModuleInstallChannel(h.db, "latest");
    const prior = process.env.PARACHUTE_INSTALL_CHANNEL;
    process.env.PARACHUTE_INSTALL_CHANNEL = "rc";
    try {
      const { supervisor } = makeIdleSupervisor();
      const { run, calls } = alwaysOkRun();
      const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
      await handleInstall(
        postReqJson(
          "/api/modules/vault/install",
          { authorization: `Bearer ${bearer}` },
          { channel: "latest" },
        ),
        "vault",
        {
          db: h.db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          supervisor,
          run,
          isLinked: TEST_DEFAULT_NOT_LINKED,
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
      expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
    } finally {
      // Bun's process.env supports the `[key]: undefined` shape
      // (biome's noDelete rule preferred this over `delete`).
      if (prior === undefined) process.env.PARACHUTE_INSTALL_CHANNEL = undefined;
      else process.env.PARACHUTE_INSTALL_CHANNEL = prior;
    }
  });

  test("garbage PARACHUTE_INSTALL_CHANNEL env falls back to hub_settings (no crash)", async () => {
    // Operator typo at the platform layer shouldn't crash installs.
    // Warns + falls through to the DB-stored channel.
    setModuleInstallChannel(h.db, "rc");
    const prior = process.env.PARACHUTE_INSTALL_CHANNEL;
    process.env.PARACHUTE_INSTALL_CHANNEL = "banana";
    try {
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
          isLinked: TEST_DEFAULT_NOT_LINKED,
        },
      );
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 10));
      // Falls back to the DB-stored rc, not "@latest".
      expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
    } finally {
      // Bun's process.env supports the `[key]: undefined` shape
      // (biome's noDelete rule preferred this over `delete`).
      if (prior === undefined) process.env.PARACHUTE_INSTALL_CHANNEL = undefined;
      else process.env.PARACHUTE_INSTALL_CHANNEL = prior;
    }
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
      isLinked: TEST_DEFAULT_NOT_LINKED,
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

  test("a MissingDependencyError during install attaches the structured error_detail wire", async () => {
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      // Simulate `bun` not being on PATH: the install runner's shell-out
      // throws the typed missing-dependency error.
      run: async () => {
        throw new MissingDependencyError("bun", lookupDep("bun"), {
          platform: "linux",
          arch: "x64",
        });
      },
      findGlobalInstall: () => null,
      isLinked: TEST_DEFAULT_NOT_LINKED,
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
    const op = (await opRes.json()) as {
      status: string;
      error?: string;
      error_detail?: { error_type: string; binary: string };
    };
    expect(op.status).toBe("failed");
    expect(op.error_detail?.error_type).toBe("missing_dependency");
    expect(op.error_detail?.binary).toBe("bun");
  });

  test("skips bun add -g when package is already bun-linked (smoke 2026-05-27 finding 1)", async () => {
    // Smoke finding 1: the wizard's parallel install path was unconditionally
    // invoking `bun add -g <pkg>` even when the package was already linked
    // via `bun link <abspath>` (the standard local-dev shape). At best a
    // wasted ~3s npm round-trip per install; at worst the global bun.lock
    // had unrelated noise and the install failed outright, taking the
    // wizard's vault step with it. Fix: mirror the CLI install path's
    // `isLinked` short-circuit. Regression guard.
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
        // The bug shape: package IS linked locally. Without the
        // short-circuit, runInstall would still call bun add -g.
        isLinked: (pkg) => pkg === "@openparachute/vault",
      },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));

    // The fix: bun add -g was NOT invoked for the linked package.
    expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
    // Downstream of the skip, the seed + spawn still happen — the install
    // op completes successfully against the locally-linked checkout.
    const manifest = JSON.parse(readFileSync(h.manifestPath, "utf8")) as {
      services: Array<{ name: string }>;
    };
    expect(manifest.services.some((s) => s.name === "parachute-vault")).toBe(true);
    expect(spawns.find((s) => s.short === "vault")?.cmd).toEqual(["parachute-vault", "serve"]);
  });

  test("still runs bun add -g when package is NOT bun-linked", async () => {
    // Companion to the above — confirms the short-circuit doesn't
    // unconditionally skip. On a friend's fresh machine (no bun link),
    // bun add -g IS what installs the package from npm. `isLinked: () => false`
    // is the production default behavior for a non-linked package.
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
        isLinked: () => false,
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
  });
});

describe("POST /api/modules/:short/start", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  /** Seed a minimal installed vault row (in services.json) for the start tests. */
  function seedVault(port = 1940): void {
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.0.0-linked",
      },
    ]);
  }

  test("401 on missing bearer", async () => {
    seedVault();
    const { supervisor } = makeIdleSupervisor();
    const res = await handleStart(postReq("/api/modules/vault/start", {}), "vault", {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
    });
    expect(res.status).toBe(401);
  });

  test("403 on bearer without parachute:host:admin (host-admin gated)", async () => {
    seedVault();
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearer(h, ["parachute:host:auth"]);
    const res = await handleStart(
      postReq("/api/modules/vault/start", { authorization: `Bearer ${bearer}` }),
      "vault",
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor },
    );
    expect(res.status).toBe(403);
  });

  test("supervisor.start throw → structured 500 module_op_failed, not a naked 500 (hub#536)", async () => {
    seedVault();
    // Models the hub#536 wedge: Bun.spawn throwing because the module's
    // installDir/cwd no longer exists (NOT a missing binary — the preflight
    // + rethrowIfMissing nets don't catch it, so it propagates out of
    // supervisor.start). Pre-fix this escaped the handler as a bodyless 500
    // and the CLI showed an opaque "request failed".
    const supervisor = new Supervisor({
      spawnFn: () => {
        throw new Error("simulated spawn failure: cwd /gone/parachute-app does not exist");
      },
    });
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleStart(
      postReq("/api/modules/vault/start", { authorization: `Bearer ${bearer}` }),
      "vault",
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("module_op_failed");
    expect(body.error_description).toContain("vault start failed");
    expect(body.error_description).toContain("cwd /gone/parachute-app does not exist");
  });

  test("pure supervisor.start of an installed module — NOT install (no bun add)", async () => {
    seedVault();
    const { supervisor, spawns } = makeIdleSupervisor();
    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleStart(
      postReq("/api/modules/vault/start", { authorization: `Bearer ${bearer}` }),
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
    const body = (await res.json()) as { short: string; state: { status: string } };
    expect(body.short).toBe("vault");
    expect(["starting", "running"]).toContain(body.state.status);
    // The supervisor was handed the boot-derived spawn request.
    expect(spawns.find((s) => s.short === "vault")?.cmd).toEqual(["parachute-vault", "serve"]);
    // Crucially: start is a PURE spawn — it must NOT run the install path.
    expect(calls).toEqual([]);
  });

  test("start carries boot-derived PORT + PARACHUTE_HUB_ORIGIN child env", async () => {
    seedVault(1940);
    const { supervisor, spawns } = makeIdleSupervisor();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    await handleStart(
      postReq("/api/modules/vault/start", { authorization: `Bearer ${bearer}` }),
      "vault",
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor },
    );
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.env?.PORT).toBe("1940");
    expect(spawns[0]?.env?.PARACHUTE_HUB_ORIGIN).toBe(ISSUER);
  });

  test("start layers the per-service .env into the supervisor spawn env", async () => {
    // The boot-derived spawn contract (buildModuleSpawnRequest) reads
    // `<configDir>/<short>/.env` and merges it into the child env. This is
    // the asymmetry the spawnSupervised doc comment calls out: install spawns
    // with install-env only; the operator-written `.env` is layered in on the
    // next `start` / boot. Prove a distinctive var written to vault's `.env`
    // reaches the recorded SpawnRequest.
    seedVault(1940);
    mkdirSync(join(h.dir, "vault"), { recursive: true });
    writeFileSync(join(h.dir, "vault", ".env"), "MY_CUSTOM_VAR=sentinel123\n");
    const { supervisor, spawns } = makeIdleSupervisor();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    await handleStart(
      postReq("/api/modules/vault/start", { authorization: `Bearer ${bearer}` }),
      "vault",
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor },
    );
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.env?.MY_CUSTOM_VAR).toBe("sentinel123");
  });

  test("#519 surface orphan: start surfaces the structured port_squatter error (not a bare failure)", async () => {
    // The #519 field signature: after a hub restart, a module (surface on the
    // box; vault here) is orphaned — listening on its port but NOT a supervised
    // child. The restart-surface API path (`parachute restart <svc>` → 404
    // fallthrough → start, and the boot reconcile) calls `supervisor.start()`,
    // whose #581 squatter detection must surface the structured `port_squatter`
    // error in the response body so the operator gets an actionable next step,
    // not an opaque "request failed". This pins that propagation.
    seedVault(1940);
    // A real Supervisor with the squatter seams injected: pid 95870 (the #519
    // orphan) holds :1940 and is NOT one of the supervisor's children.
    const supervisor = new Supervisor({
      spawnFn: () => {
        throw new Error("should not spawn — the port is squatted");
      },
      pidOnPort: (port) => (port === 1940 ? 95870 : undefined),
      ownerOfPid: (pid) => (pid === 95870 ? "bun /x/.parachute/surface/server.ts" : undefined),
    });
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleStart(
      postReq("/api/modules/vault/start", { authorization: `Bearer ${bearer}` }),
      "vault",
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor },
    );
    // 200 with the structured error riding in state.startError — the SPA/CLI
    // render the actionable squatter message instead of a 500 "request failed".
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      short: string;
      state: { status: string; startError?: { error_type: string; error_description: string } };
    };
    expect(body.state.status).toBe("crashed");
    expect(body.state.startError?.error_type).toBe("port_squatter");
    expect(body.state.startError?.error_description).toContain("port 1940 is held by pid 95870");
  });

  test("400 not_installed when the module isn't in services.json (no silent install)", async () => {
    // No seedVault — services.json has no vault row.
    const { supervisor, spawns } = makeIdleSupervisor();
    const { run, calls } = alwaysOkRun();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleStart(
      postReq("/api/modules/vault/start", { authorization: `Bearer ${bearer}` }),
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
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_installed");
    // Did NOT spawn + did NOT install.
    expect(spawns).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("POST /api/modules/:short/stop", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("401 on missing bearer", async () => {
    const { supervisor } = makeIdleSupervisor();
    const res = await handleStop(postReq("/api/modules/vault/stop", {}), "vault", {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
    });
    expect(res.status).toBe(401);
  });

  test("403 on bearer without parachute:host:admin (host-admin gated)", async () => {
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearer(h, ["parachute:host:auth"]);
    const res = await handleStop(
      postReq("/api/modules/vault/stop", { authorization: `Bearer ${bearer}` }),
      "vault",
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor },
    );
    expect(res.status).toBe(403);
  });

  test("calls supervisor.stop on a running module → stopped: true", async () => {
    const { supervisor } = makeIdleSupervisor();
    await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleStop(
      postReq("/api/modules/vault/stop", { authorization: `Bearer ${bearer}` }),
      "vault",
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      short: string;
      stopped: boolean;
      state: { status: string };
    };
    expect(body.short).toBe("vault");
    expect(body.stopped).toBe(true);
    expect(body.state.status).toBe("stopped");
    // Supervisor truly transitioned the module to stopped.
    expect(supervisor.get("vault")?.status).toBe("stopped");
  });

  test("idempotent: stopping a not-supervised module → stopped: false (no error)", async () => {
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleStop(
      postReq("/api/modules/vault/stop", { authorization: `Bearer ${bearer}` }),
      "vault",
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { short: string; stopped: boolean };
    expect(body.stopped).toBe(false);
  });
});

/**
 * hub#516 — the module-ops `authorize` accepts the operator token's `iss`
 * against the SET of origins the hub answers on (knownIssuers), not just the
 * single per-request issuer. Exercised through `handleStop` (the simplest sync
 * op that goes through `authorize`). The per-request `issuer` here is loopback
 * (mirroring a loopback CLI request); `knownIssuers` carries loopback + the
 * public expose-state origin.
 */
describe("operator-token iss validation against knownIssuers (hub#516)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  // The live repro: operator token's iss = PUBLIC origin, loopback request
  // (per-request issuer = loopback), knownIssuers includes the public origin
  // → ACCEPTED. Was rejected (`unexpected "iss" claim value`) pre-fix.
  test("live repro: public-iss operator token on a loopback request → ACCEPTED", async () => {
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearerAtIssuer(h, [API_MODULES_OPS_REQUIRED_SCOPE], PUBLIC_ORIGIN);
    const res = await handleStop(
      postReq("/api/modules/vault/stop", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER, // loopback per-request issuer
        knownIssuers: [ISSUER, "http://localhost:1939", PUBLIC_ORIGIN],
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
      },
    );
    // Not a 401 — authorize passed. (stopped:false because nothing's running.)
    expect(res.status).toBe(200);
  });

  test("loopback-iss operator token, loopback knownIssuers → accepted (unchanged)", async () => {
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearerAtIssuer(h, [API_MODULES_OPS_REQUIRED_SCOPE], ISSUER);
    const res = await handleStop(
      postReq("/api/modules/vault/stop", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        knownIssuers: [ISSUER, "http://localhost:1939"],
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
      },
    );
    expect(res.status).toBe(200);
  });

  test("FOREIGN-iss operator token → 401 (no widening to arbitrary issuers)", async () => {
    const { supervisor } = makeIdleSupervisor();
    const bearer = await mintBearerAtIssuer(h, [API_MODULES_OPS_REQUIRED_SCOPE], FOREIGN_ORIGIN);
    const res = await handleStop(
      postReq("/api/modules/vault/stop", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: ISSUER,
        knownIssuers: [ISSUER, "http://localhost:1939", PUBLIC_ORIGIN],
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
      },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error_description: string };
    expect(body.error_description).toMatch(/unexpected "iss" claim value/);
  });

  test("knownIssuers absent → falls back to strict per-request issuer (back-compat)", async () => {
    const { supervisor } = makeIdleSupervisor();
    // Public-iss token, loopback per-request issuer, NO knownIssuers wired →
    // the strict single-issuer fallback rejects (the pre-fix behavior the
    // non-HTTP install path relies on).
    const bearer = await mintBearerAtIssuer(h, [API_MODULES_OPS_REQUIRED_SCOPE], PUBLIC_ORIGIN);
    const res = await handleStop(
      postReq("/api/modules/vault/stop", { authorization: `Bearer ${bearer}` }),
      "vault",
      { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor },
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /api/modules/:short/restart", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  /** Seed a minimal installed vault row (in services.json). */
  function seedVault(port = 1940): void {
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.0.0-linked",
      },
    ]);
  }

  test("400 not_installed when the module isn't in services.json", async () => {
    // restart rebuilds the spawn req from services.json (hub#532), so a
    // missing row is a `not_installed` 400 (mirrors `start`) — before the
    // supervisor is even consulted.
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
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_installed");
  });

  test("404 not_supervised when installed but not currently running", async () => {
    seedVault();
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
    seedVault();
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

  test("re-injects the CURRENT hub origin on restart (hub#532)", async () => {
    // The core hub#532 fix: a module first started under one issuer, then
    // restarted after the canonical origin changed (e.g. post-expose), must
    // re-spawn with the NEW PARACHUTE_HUB_ORIGIN — not replay the stale
    // first-start snapshot. We drive the supervisor directly to control the
    // first-start env, then restart through the handler with a different
    // `deps.issuer` and assert the recorded spawn carries the new origin.
    seedVault(1940);
    const { supervisor, spawns } = makeIdleSupervisor();
    // First start with the OLD origin baked in (as boot would have).
    await supervisor.start({
      short: "vault",
      cmd: ["parachute-vault", "serve"],
      env: { PORT: "1940", PARACHUTE_HUB_ORIGIN: "https://old.example" },
    });
    const spawnsBefore = spawns.length;

    const NEW_ORIGIN = "https://new.example";
    // The bearer was minted at the prior (loopback) ISSUER; the canonical
    // origin has since moved to NEW_ORIGIN. `knownIssuers` accepts the older
    // bearer iss while `deps.issuer` is the current canonical origin — exactly
    // the post-expose scenario hub#532 describes.
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleRestart(
      postReq("/api/modules/vault/restart", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: NEW_ORIGIN,
        knownIssuers: [ISSUER, NEW_ORIGIN],
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run: async () => 0,
      },
    );
    expect(res.status).toBe(200);
    // A fresh spawn happened, and it carries the NEW origin (rebuilt from the
    // live deps.issuer), not the stale one from first start.
    const reSpawn = spawns[spawnsBefore];
    expect(reSpawn?.env?.PARACHUTE_HUB_ORIGIN).toBe(NEW_ORIGIN);
    expect(reSpawn?.env?.PORT).toBe("1940");
  });

  test("crash-restart after a restart reuses the REFRESHED req (hub#532)", async () => {
    // The refreshed SpawnRequest must become the supervisor entry's `req` so
    // a SUBSEQUENT crash-restart (handleExit → spawnAndWatch, which replays
    // `entry.req`) also carries the current env — not the original snapshot.
    seedVault(1940);
    // Controllable supervisor: spawns record env; each fake exposes a `crash()`
    // resolving `exited` with code 1 (a crash, not an operator stop). `kill()`
    // (driven by the injected group-aware `killFn`) resolves with 0 so the
    // handler's restart-stop completes promptly. Distinct codes let us crash a
    // specific child without tripping the stop path.
    const spawns: SpawnRequest[] = [];
    const procs: Array<{ pid: number; crash: () => void; kill: () => void }> = [];
    let nextPid = 8000;
    const spawnFn = (req: SpawnRequest): SupervisedProc => {
      spawns.push(req);
      const pid = nextPid++;
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => {
        resolveExit = r;
      });
      const proc = {
        pid,
        exited,
        stdout: null,
        stderr: null,
        kill: () => resolveExit(0),
      };
      procs.push({ pid, crash: () => resolveExit(1), kill: proc.kill });
      return proc;
    };
    const killFn = (pid: number): void => {
      procs.find((p) => p.pid === Math.abs(pid))?.kill();
    };
    const supervisor = new Supervisor({ spawnFn, killFn, restartDelayMs: 1, startReadyMs: 0 });

    // First start with the OLD origin.
    await supervisor.start({
      short: "vault",
      cmd: ["parachute-vault", "serve"],
      env: { PORT: "1940", PARACHUTE_HUB_ORIGIN: "https://old.example" },
    });

    const NEW_ORIGIN = "https://new.example";
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    await handleRestart(
      postReq("/api/modules/vault/restart", { authorization: `Bearer ${bearer}` }),
      "vault",
      {
        db: h.db,
        issuer: NEW_ORIGIN,
        knownIssuers: [ISSUER, NEW_ORIGIN],
        manifestPath: h.manifestPath,
        configDir: h.dir,
        supervisor,
        run: async () => 0,
      },
    );
    // The restart re-spawn is the most recent — confirm the NEW origin landed.
    const restartSpawnIdx = spawns.length - 1;
    expect(spawns[restartSpawnIdx]?.env?.PARACHUTE_HUB_ORIGIN).toBe(NEW_ORIGIN);

    // Crash the restart-spawned child → the supervisor's crash-restart replays
    // entry.req (which `start` stored from the refreshed req).
    procs[restartSpawnIdx]?.crash();
    // Wait for the crash watcher's restartDelay + respawn.
    await new Promise((r) => setTimeout(r, 40));
    expect(spawns.length).toBeGreaterThan(restartSpawnIdx + 1);
    const crashRespawn = spawns[spawns.length - 1];
    // The crash-restart inherited the REFRESHED req → still the new origin.
    expect(crashRespawn?.env?.PARACHUTE_HUB_ORIGIN).toBe(NEW_ORIGIN);
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
      },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
    expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
  });

  test("PARACHUTE_INSTALL_CHANNEL env cascades to upgrade too (hub#339 symmetry)", async () => {
    // The Render-deploy operator sets PARACHUTE_INSTALL_CHANNEL=rc cluster-
    // wide expecting BOTH install and upgrade through the admin SPA to
    // honor it. Asymmetry between the two paths would surprise them.
    setModuleInstallChannel(h.db, "latest"); // DB says latest
    const prior = process.env.PARACHUTE_INSTALL_CHANNEL;
    process.env.PARACHUTE_INSTALL_CHANNEL = "rc"; // env says rc — should win
    try {
      const { supervisor } = makeIdleSupervisor();
      await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });
      const { run, calls } = alwaysOkRun();
      const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
      await handleUpgrade(
        postReq("/api/modules/vault/upgrade", { authorization: `Bearer ${bearer}` }),
        "vault",
        {
          db: h.db,
          issuer: ISSUER,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          supervisor,
          run,
          isLinked: TEST_DEFAULT_NOT_LINKED,
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toContainEqual(["bun", "add", "-g", "@openparachute/vault@rc"]);
      expect(calls).not.toContainEqual(["bun", "add", "-g", "@openparachute/vault@latest"]);
    } finally {
      if (prior === undefined) process.env.PARACHUTE_INSTALL_CHANNEL = undefined;
      else process.env.PARACHUTE_INSTALL_CHANNEL = prior;
    }
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
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
        isLinked: TEST_DEFAULT_NOT_LINKED,
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

/**
 * Well-known regen + installDir stamping coverage. These exercise the
 * fix for the "newly installed module doesn't appear on discovery" bug:
 * the live HTTP build at `/.well-known/parachute.json` reads each
 * module's `installDir/.parachute/module.json` to find `uiUrl` (which
 * the discovery page needs to render a tile). Without an installDir
 * stamp post-install, the resolver skips the entry. We assert both
 * the disk regen lands and the row carries installDir afterwards.
 */
describe("well-known regen after module ops", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  /** Stub findGlobalInstall + readModuleManifest pair for in-memory installs. */
  function fakeInstall(
    pkg: string,
    manifest: {
      name: string;
      manifestName: string;
      port: number;
      paths: string[];
      health: string;
      uiUrl?: string;
      displayName?: string;
    },
  ): {
    findGlobalInstall: (p: string) => string | null;
    readModuleManifest: (dir: string) => Promise<typeof manifest | null>;
    installDir: string;
  } {
    const installDir = join(h.dir, "fake-install", ...pkg.split("/"));
    const pkgJson = join(installDir, "package.json");
    return {
      findGlobalInstall: (p) => (p === pkg ? pkgJson : null),
      readModuleManifest: async (dir) => (dir === installDir ? manifest : null),
      installDir,
    };
  }

  test("runInstall happy path: regenerates well-known + stamps installDir", async () => {
    const { supervisor } = makeIdleSupervisor();
    const { run } = alwaysOkRun();
    const wkPath = join(h.dir, "well-known.json");
    const install = fakeInstall("@openparachute/vault", {
      name: "vault",
      manifestName: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
    });
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      run,
      findGlobalInstall: install.findGlobalInstall,
      readModuleManifest: install.readModuleManifest,
      wellKnownPath: wkPath,
    };
    const res = await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      deps,
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));

    // installDir landed on the row (so the live well-known build's
    // `uiUrl` resolver can find the module's manifest).
    const manifest = JSON.parse(readFileSync(h.manifestPath, "utf8")) as {
      services: Array<{ name: string; installDir?: string }>;
    };
    const vaultRow = manifest.services.find((s) => s.name === "parachute-vault");
    expect(vaultRow?.installDir).toBe(install.installDir);

    // The on-disk well-known doc reflects the new module in `services`...
    const doc = JSON.parse(readFileSync(wkPath, "utf8")) as {
      services: Array<{ name: string; version: string }>;
      vaults: Array<{ name: string }>;
    };
    expect(doc.services.some((s) => s.name === "parachute-vault")).toBe(true);
    // ...but does NOT fabricate a phantom `default` vault row (hub#577). The
    // install seeds the entry at SEED_VERSION ("module installed, no instance
    // booted"); vault's own boot registers the real instance later. Until then
    // the vaults[] list is honestly empty so the management page reads "No
    // vaults yet" rather than showing a `default` that doesn't exist.
    expect(doc.vaults.some((v) => v.name === "default")).toBe(false);
    expect(doc.vaults).toEqual([]);
  });

  test("runInstall sets PORT in child env from services.json entry (hub#356)", async () => {
    // Container deploys (Render / etc.) set PORT in hub's env via the
    // Dockerfile / platform. Without explicit override at spawn time, every
    // supervised child inherits hub's PORT via `env: process.env` and tries
    // to bind hub's own port — EADDRINUSE → crashloop → supervisor gives up.
    // Regression guard: the spawn captures the child's services.json port.
    const { supervisor, spawns } = makeIdleSupervisor();
    const { run } = alwaysOkRun();
    const wkPath = join(h.dir, "well-known.json");
    const install = fakeInstall("@openparachute/vault", {
      name: "vault",
      manifestName: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
    });
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      run,
      findGlobalInstall: install.findGlobalInstall,
      readModuleManifest: install.readModuleManifest,
      wellKnownPath: wkPath,
    };
    await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      deps,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.env?.PORT).toBe("1940");
  });

  test("runInstall sets PARACHUTE_HUB_ORIGIN in child env from deps.issuer (hub#365)", async () => {
    // Supervised modules (vault, scribe, app) validate the `iss` claim
    // on hub-minted JWTs against PARACHUTE_HUB_ORIGIN. Without it, they
    // fall back to a loopback default and reject any token whose iss is
    // the public Render URL — surfaces as "hub JWT verification failed:
    // unexpected 'iss' claim value" on the first authed vault call.
    // Regression guard: install-path spawn carries the hub's resolved
    // issuer as PARACHUTE_HUB_ORIGIN.
    const { supervisor, spawns } = makeIdleSupervisor();
    const { run } = alwaysOkRun();
    const wkPath = join(h.dir, "well-known.json");
    const install = fakeInstall("@openparachute/vault", {
      name: "vault",
      manifestName: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
    });
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      // Use the test's canonical ISSUER (matches the bearer's iss claim
      // so handleInstall doesn't 401 — mintBearer always uses ISSUER).
      // The assertion below verifies whatever issuer is on `deps` lands
      // in the child's PARACHUTE_HUB_ORIGIN env.
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      run,
      findGlobalInstall: install.findGlobalInstall,
      readModuleManifest: install.readModuleManifest,
      wellKnownPath: wkPath,
    };
    await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      deps,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(spawns.length).toBe(1);
    expect(spawns[0]?.env?.PARACHUTE_HUB_ORIGIN).toBe(ISSUER);
  });

  test("runInstall failure: bun add fails -> no well-known regen (no partial state)", async () => {
    const { supervisor } = makeIdleSupervisor();
    const wkPath = join(h.dir, "well-known.json");
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      run: async () => 1,
      findGlobalInstall: () => null,
      isLinked: TEST_DEFAULT_NOT_LINKED,
      wellKnownPath: wkPath,
    };
    const res = await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      deps,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { operation_id: string };
    await new Promise((r) => setTimeout(r, 10));

    // Operation failed.
    const opRes = await handleOperationGet(
      getReq(`/api/modules/operations/${body.operation_id}`, {
        authorization: `Bearer ${bearer}`,
      }),
      body.operation_id,
      deps,
    );
    const op = (await opRes.json()) as { status: string; log: string[] };
    expect(op.status).toBe("failed");

    // No well-known doc was written — the regen step only runs after a
    // successful spawn, not on failure paths.
    expect(existsSync(wkPath)).toBe(false);
    // And the operation log carries no regen line (defensive — confirms
    // the early-return short-circuit, not just an absent file).
    expect(op.log.join(" ")).not.toMatch(/regenerated/);
  });

  test("runUpgrade regenerates well-known with the new version on the row", async () => {
    // Seed services.json with an existing vault row at the old version,
    // and make the supervisor's restart return a state (success path).
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

    const { run } = alwaysOkRun();
    const wkPath = join(h.dir, "well-known.json");
    const install = fakeInstall("@openparachute/vault", {
      name: "vault",
      manifestName: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
    });
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      run,
      findGlobalInstall: install.findGlobalInstall,
      readModuleManifest: install.readModuleManifest,
      wellKnownPath: wkPath,
    };
    const res = await handleUpgrade(
      postReq("/api/modules/vault/upgrade", { authorization: `Bearer ${bearer}` }),
      "vault",
      deps,
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));

    const doc = JSON.parse(readFileSync(wkPath, "utf8")) as {
      services: Array<{ name: string; version: string }>;
    };
    const row = doc.services.find((s) => s.name === "parachute-vault");
    expect(row?.version).toBe("0.4.5");
  });

  test("runUninstall regenerates well-known without the removed module", async () => {
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
      },
      {
        name: "parachute-notes",
        port: 1942,
        paths: ["/notes"],
        health: "/notes/health",
        version: "0.4.0",
      },
    ]);
    const { supervisor } = makeIdleSupervisor();
    const { run } = alwaysOkRun();
    const wkPath = join(h.dir, "well-known.json");
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
        wellKnownPath: wkPath,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { log: string[] };
    expect(body.log.join(" ")).toMatch(/regenerated/);

    const doc = JSON.parse(readFileSync(wkPath, "utf8")) as {
      services: Array<{ name: string }>;
      vaults: Array<{ name: string }>;
    };
    // Vault gone, notes still present.
    expect(doc.services.some((s) => s.name === "parachute-vault")).toBe(false);
    expect(doc.vaults.some((v) => v.name === "default")).toBe(false);
    expect(doc.services.some((s) => s.name === "parachute-notes")).toBe(true);
  });

  test("well-known regen is idempotent across two consecutive install ops", async () => {
    // Two installs in a row of the same module produce the same on-disk
    // doc — no drift from the regen path itself (e.g. extra entries,
    // duplicated rows, non-deterministic ordering).
    const { supervisor } = makeIdleSupervisor();
    const { run } = alwaysOkRun();
    const wkPath = join(h.dir, "well-known.json");
    const install = fakeInstall("@openparachute/vault", {
      name: "vault",
      manifestName: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/vault/default/health",
    });
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      supervisor,
      run,
      findGlobalInstall: install.findGlobalInstall,
      readModuleManifest: install.readModuleManifest,
      wellKnownPath: wkPath,
    };
    await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      deps,
    );
    await new Promise((r) => setTimeout(r, 10));
    const first = readFileSync(wkPath, "utf8");

    await handleInstall(
      postReq("/api/modules/vault/install", { authorization: `Bearer ${bearer}` }),
      "vault",
      deps,
    );
    await new Promise((r) => setTimeout(r, 10));
    const second = readFileSync(wkPath, "utf8");

    expect(second).toBe(first);
  });
});

describe("GET /api/modules/:short/logs (§6.5 ring-buffer tap)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  /**
   * Supervisor whose child exposes a controllable stdout stream so the test
   * can push lines into the ring buffer, then tap them through the endpoint.
   */
  function makeEmittingSupervisor(): {
    supervisor: Supervisor;
    emit: (chunk: string) => void;
  } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const enc = new TextEncoder();
    const spawnFn = (): SupervisedProc => ({
      pid: 4321,
      exited: new Promise<number | null>(() => {}),
      stdout,
      stderr: null,
      kill: () => {},
    });
    return {
      supervisor: new Supervisor({ spawnFn, killFn: () => {} }),
      emit: (chunk) => controller.enqueue(enc.encode(chunk)),
    };
  }

  function logsDeps(supervisor: Supervisor) {
    return { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath, configDir: h.dir, supervisor };
  }

  test("401 on missing bearer", async () => {
    const { supervisor } = makeEmittingSupervisor();
    const res = await handleLogs(
      getReq("/api/modules/vault/logs", {}),
      "vault",
      logsDeps(supervisor),
    );
    expect(res.status).toBe(401);
  });

  test("403 on bearer without parachute:host:admin (host-admin gated)", async () => {
    const { supervisor } = makeEmittingSupervisor();
    const bearer = await mintBearer(h, ["parachute:host:auth"]);
    const res = await handleLogs(
      getReq("/api/modules/vault/logs", { authorization: `Bearer ${bearer}` }),
      "vault",
      logsDeps(supervisor),
    );
    expect(res.status).toBe(403);
  });

  test("405 on non-GET", async () => {
    const { supervisor } = makeEmittingSupervisor();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleLogs(
      postReq("/api/modules/vault/logs", { authorization: `Bearer ${bearer}` }),
      "vault",
      logsDeps(supervisor),
    );
    expect(res.status).toBe(405);
  });

  test("404 not_supervised for a module that isn't supervised", async () => {
    const { supervisor } = makeEmittingSupervisor();
    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleLogs(
      getReq("/api/modules/vault/logs", { authorization: `Bearer ${bearer}` }),
      "vault",
      logsDeps(supervisor),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_supervised");
  });

  test("replays the ring buffer (lines emitted before the tap) as lines + text", async () => {
    const { supervisor, emit } = makeEmittingSupervisor();
    await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });
    // Output happens BEFORE the operator opens the logs view.
    emit("booting\n");
    emit("FATAL: boom\n");
    await new Promise((r) => setTimeout(r, 20));

    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleLogs(
      getReq("/api/modules/vault/logs", { authorization: `Bearer ${bearer}` }),
      "vault",
      logsDeps(supervisor),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { short: string; lines: string[]; text: string };
    expect(body.short).toBe("vault");
    expect(body.lines).toEqual(["[vault] booting\n", "[vault] FATAL: boom\n"]);
    expect(body.text).toBe("[vault] booting\n[vault] FATAL: boom\n");
  });

  test("?follow=1 streams the buffered replay first (text/plain)", async () => {
    const { supervisor, emit } = makeEmittingSupervisor();
    await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });
    emit("pre-connect line\n");
    await new Promise((r) => setTimeout(r, 20));

    const bearer = await mintBearer(h, [API_MODULES_OPS_REQUIRED_SCOPE]);
    const res = await handleLogs(
      getReq("/api/modules/vault/logs?follow=1", { authorization: `Bearer ${bearer}` }),
      "vault",
      logsDeps(supervisor),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    // Read the first chunk — it must contain the replayed buffer line.
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("[vault] pre-connect line\n");
    await reader.cancel();
  });
});
