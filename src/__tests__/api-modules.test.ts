import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_MODULES_REQUIRED_SCOPE,
  _clearLatestVersionCacheForTests,
  handleApiModules,
} from "../api-modules.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "phub-api-modules-"));
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

function writeManifest(path: string, services: unknown[]): void {
  writeFileSync(path, JSON.stringify({ services }));
}

function getReq(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/modules", {
    method: "GET",
    headers,
  });
}

function postReq(): Request {
  return new Request("http://localhost/api/modules", {
    method: "POST",
  });
}

function makeIdleSupervisor(): {
  supervisor: Supervisor;
  spawnFn: (req: SpawnRequest) => SupervisedProc;
} {
  // Test fake: never resolves `exited` so the supervisor's crash-watch
  // loop stays quiet for the test's lifetime.
  const spawnFn: (req: SpawnRequest) => SupervisedProc = () => ({
    pid: 12345,
    exited: new Promise(() => {}),
    stdout: null,
    stderr: null,
    kill: () => {},
  });
  return { supervisor: new Supervisor({ spawnFn }), spawnFn };
}

describe("GET /api/modules", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    _clearLatestVersionCacheForTests();
  });
  afterEach(() => h.cleanup());

  test("405 on non-GET", async () => {
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(postReq(), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    expect(res.status).toBe(405);
    // Bearer's not even consulted on method-mismatch — that's fine,
    // 405 short-circuits before auth so we keep the surface defensive.
    expect(bearer).toBeDefined();
  });

  test("401 with no Authorization header", async () => {
    const res = await handleApiModules(getReq(), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  test("403 when bearer lacks parachute:host:auth", async () => {
    // A bearer with a narrow scope (`scribe:transcribe`) is valid per
    // signature but must not reach this surface. Insufficient_scope is
    // the spec-shaped error.
    const bearer = await mintBearer(h, ["scribe:transcribe"]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("insufficient_scope");
  });

  test("200 + curated list on fresh container (empty services.json)", async () => {
    // The v0.6 hot path: brand-new Render container, no services.json
    // yet. UI must render "install vault / notes / scribe" cards even
    // though nothing's installed.
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => "0.9.9",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{
        short: string;
        available: boolean;
        installed: boolean;
        latest_version: string | null;
      }>;
      supervisor_available: boolean;
    };
    // Curated order is preserved: vault → notes → scribe.
    expect(body.modules.map((m) => m.short)).toEqual(["vault", "notes", "scribe"]);
    expect(body.modules.every((m) => m.available)).toBe(true);
    expect(body.modules.every((m) => !m.installed)).toBe(true);
    expect(body.modules.every((m) => m.latest_version === "0.9.9")).toBe(true);
    // Supervisor wasn't injected → flag reflects that.
    expect(body.supervisor_available).toBe(false);
  });

  test("surfaces installed_version from services.json", async () => {
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
        installDir: "/parachute/modules/node_modules/@openparachute/vault",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => "0.5.0",
    });
    const body = (await res.json()) as {
      modules: Array<{
        short: string;
        installed: boolean;
        installed_version: string | null;
        latest_version: string | null;
        install_dir: string | null;
      }>;
    };
    const vault = body.modules.find((m) => m.short === "vault");
    expect(vault?.installed).toBe(true);
    expect(vault?.installed_version).toBe("0.4.5");
    expect(vault?.latest_version).toBe("0.5.0");
    expect(vault?.install_dir).toBe("/parachute/modules/node_modules/@openparachute/vault");
    // The other curated rows stay installed:false — the test installed
    // only vault, so notes + scribe still render as available-but-not-installed.
    const notes = body.modules.find((m) => m.short === "notes");
    expect(notes?.installed).toBe(false);
    expect(notes?.installed_version).toBeNull();
  });

  test("includes supervisor status + pid when a supervisor is injected", async () => {
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

    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      supervisor,
      fetchLatestVersion: async () => null,
    });
    const body = (await res.json()) as {
      modules: Array<{ short: string; supervisor_status: string | null; pid: number | null }>;
      supervisor_available: boolean;
    };
    const vault = body.modules.find((m) => m.short === "vault");
    expect(vault?.supervisor_status).toBe("running");
    expect(vault?.pid).toBe(12345);
    // Modules without a supervisor entry get null status — the UI
    // disables Restart/Stop for those since there's no live process.
    const notes = body.modules.find((m) => m.short === "notes");
    expect(notes?.supervisor_status).toBeNull();
    expect(notes?.pid).toBeNull();
    expect(body.supervisor_available).toBe(true);
  });

  test("npm probe failure → latest_version is null but response still 200", async () => {
    // The whole point of the probe-is-opportunistic posture: a flaky
    // npm registry must not break the page render. The UI handles
    // null gracefully.
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{ short: string; latest_version: string | null }>;
    };
    expect(body.modules.every((m) => m.latest_version === null)).toBe(true);
  });

  test("caches latest_version across requests within the TTL", async () => {
    // Second back-to-back request must not re-hit the registry. The
    // UI may poll this endpoint; we don't want it to slam npm.
    let calls = 0;
    const probe = async (_pkg: string): Promise<string | null> => {
      calls++;
      return "0.5.0";
    };
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: probe,
      cacheTtlMs: 60_000,
    };
    await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), deps);
    const callsAfterFirst = calls;
    await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), deps);
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(calls).toBe(callsAfterFirst);
  });
});
