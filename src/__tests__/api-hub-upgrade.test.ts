/**
 * Tests for the SPA-driven hub self-upgrade (design 2026-06-01 §5.3 / D4):
 *   - `POST /api/hub/upgrade` endpoint: auth gate, channel validation, 202
 *     shape, the handler-spawns-the-helper-and-does-NOT-rewrite-inline
 *     invariant, redeploy-required short-circuit, status pollability.
 *   - The detached one-shot helper's rewrite-then-restart sequence (unit-
 *     managed + container graceful-exit), via injected seams.
 *   - The in-place-vs-redeploy mode detection (§5.3 heuristic).
 *
 * No real `bun add -g`, no real systemctl/launchctl, no real process signal —
 * every side effect is a seam.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type SpawnHelperArgs,
  handleHubUpgrade,
  handleHubUpgradeStatus,
} from "../api-hub-upgrade.ts";
import type { UpgradeOpts } from "../commands/upgrade.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import type { HubUnitDeps, HubUnitManagerOpResult } from "../hub-unit.ts";
import { runHubUpgradeHelper } from "../hub-upgrade-helper.ts";
import { detectHubUpgradeMode } from "../hub-upgrade-mode.ts";
import {
  type HubUpgradeStatus,
  appendHubUpgradeStatus,
  readHubUpgradeStatus,
  writeHubUpgradeStatus,
} from "../hub-upgrade-status.ts";
import { recordTokenMint, signAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  dir: string;
  db: ReturnType<typeof openHubDb>;
  userId: string;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-hub-upgrade-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const user = await createUser(db, "owner", "pw");
  return {
    dir,
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

function postReq(headers: Record<string, string>, body?: unknown): Request {
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    init.headers = { ...headers, "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("http://localhost/api/hub/upgrade", init);
}

function getStatusReq(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/hub/upgrade/status", { method: "GET", headers });
}

/** Base deps that never spawn a real process / touch npm. */
function baseDeps(h: Harness, overrides: Partial<Parameters<typeof handleHubUpgrade>[1]> = {}) {
  const spawned: SpawnHelperArgs[] = [];
  const deps = {
    db: h.db,
    issuer: ISSUER,
    configDir: h.dir,
    spawnHelper: (args: SpawnHelperArgs) => spawned.push(args),
    resolveTargetVersion: async () => "0.6.3-rc.2",
    currentVersion: () => "0.6.3-rc.1",
    // Default: non-container, npm install → in-place. Tests that need
    // redeploy-required override env + hubSrcDir.
    env: { PARACHUTE_HOME: "/home/op/.parachute" } as Record<string, string | undefined>,
    ...overrides,
  };
  return { deps, spawned };
}

let harness: Harness;
beforeEach(async () => {
  harness = await makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

describe("POST /api/hub/upgrade — auth gate", () => {
  test("401 without a bearer", async () => {
    const { deps } = baseDeps(harness, {
      // Force in-place so we'd otherwise spawn — but auth must reject first.
      hubSrcDir: "/nonexistent",
    });
    const res = await handleHubUpgrade(postReq({}), deps);
    expect(res.status).toBe(401);
  });

  test("403 with a host:auth-only token (lacks host:admin)", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:auth"]);
    const { deps, spawned } = baseDeps(harness);
    const res = await handleHubUpgrade(postReq({ authorization: `Bearer ${bearer}` }), deps);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("insufficient_scope");
    // The handler must NOT have spawned the helper on an auth failure.
    expect(spawned.length).toBe(0);
  });

  test("405 on non-POST", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const req = new Request("http://localhost/api/hub/upgrade", {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}` },
    });
    const { deps } = baseDeps(harness);
    const res = await handleHubUpgrade(req, deps);
    expect(res.status).toBe(405);
  });
});

describe("POST /api/hub/upgrade — channel validation (closed enum)", () => {
  test("rejects a non-enum channel with 400", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps, spawned } = baseDeps(harness);
    const res = await handleHubUpgrade(
      postReq({ authorization: `Bearer ${bearer}` }, { channel: "evil; rm -rf /" }),
      deps,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_channel");
    expect(spawned.length).toBe(0);
  });

  test("accepts channel: rc", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps, spawned } = baseDeps(harness);
    const res = await handleHubUpgrade(
      postReq({ authorization: `Bearer ${bearer}` }, { channel: "rc" }),
      deps,
    );
    expect(res.status).toBe(202);
    expect(spawned[0]?.channel).toBe("rc");
  });

  test("accepts channel: latest", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps, spawned } = baseDeps(harness);
    const res = await handleHubUpgrade(
      postReq({ authorization: `Bearer ${bearer}` }, { channel: "latest" }),
      deps,
    );
    expect(res.status).toBe(202);
    expect(spawned[0]?.channel).toBe("latest");
  });

  test("auto-detects channel from current version when none given (rc → rc)", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps, spawned } = baseDeps(harness, { currentVersion: () => "0.6.3-rc.1" });
    const res = await handleHubUpgrade(postReq({ authorization: `Bearer ${bearer}` }), deps);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { channel: string };
    expect(body.channel).toBe("rc");
    expect(spawned[0]?.channel).toBe("rc");
  });

  test("auto-detects channel from current version (stable → latest)", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps } = baseDeps(harness, { currentVersion: () => "0.6.2" });
    const res = await handleHubUpgrade(postReq({ authorization: `Bearer ${bearer}` }), deps);
    const body = (await res.json()) as { channel: string };
    expect(body.channel).toBe("latest");
  });
});

describe("POST /api/hub/upgrade — 202 + spawn-not-inline (in-place)", () => {
  test("202 with operation_id/target_version/channel/mode", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps } = baseDeps(harness);
    const res = await handleHubUpgrade(
      postReq({ authorization: `Bearer ${bearer}` }, { channel: "rc" }),
      deps,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      operation_id: string;
      target_version: string;
      channel: string;
      mode: string;
    };
    expect(typeof body.operation_id).toBe("string");
    expect(body.operation_id.length).toBeGreaterThan(0);
    expect(body.target_version).toBe("0.6.3-rc.2");
    expect(body.channel).toBe("rc");
    expect(body.mode).toBe("in-place");
  });

  test("spawns the detached helper (does NOT rewrite inline)", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps, spawned } = baseDeps(harness);
    const res = await handleHubUpgrade(
      postReq({ authorization: `Bearer ${bearer}` }, { channel: "rc" }),
      deps,
    );
    const body = (await res.json()) as { operation_id: string };
    // Exactly one helper spawn; its op id matches the 202; no inline rewrite
    // (the handler has no UpgradeRunner — the only way to rewrite is the
    // helper, which we recorded rather than executed).
    expect(spawned.length).toBe(1);
    expect(spawned[0]?.operationId).toBe(body.operation_id);
    expect(spawned[0]?.configDir).toBe(harness.dir);
  });

  test("status file is seeded + pollable via GET /status", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps } = baseDeps(harness);
    const post = await handleHubUpgrade(
      postReq({ authorization: `Bearer ${bearer}` }, { channel: "rc" }),
      deps,
    );
    const { operation_id } = (await post.json()) as { operation_id: string };

    const statusRes = await handleHubUpgradeStatus(
      getStatusReq({ authorization: `Bearer ${bearer}` }),
      deps,
    );
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      operation_id: string;
      phase: string;
      mode: string;
    };
    expect(status.operation_id).toBe(operation_id);
    expect(status.phase).toBe("pending");
    expect(status.mode).toBe("in-place");
  });

  test("container in-place passes the hub pid to the helper (graceful-exit path)", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    // Inject a container/in-place mode result (the real source-detection would
    // classify this test's checkout as bun-linked; we want the container arm).
    const { deps, spawned } = baseDeps(harness, {
      detectMode: () => ({
        mode: "in-place",
        source: "container",
        reason: "container with $BUN_INSTALL on the persistent disk",
      }),
    });
    const res = await handleHubUpgrade(
      postReq({ authorization: `Bearer ${bearer}` }, { channel: "rc" }),
      deps,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("in-place");
    // Container source → the handler hands the helper a hub pid to signal.
    expect(spawned[0]?.hubPid).toBe(process.pid);
  });
});

describe("POST /api/hub/upgrade — redeploy-required short-circuit (§5.3)", () => {
  test("image-pinned container → 202 mode redeploy-required, NO helper spawned", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    // Inject the image-pinned (redeploy-required) detection result. (The mode
    // heuristic itself is unit-tested separately in `detectHubUpgradeMode`;
    // here we assert the endpoint's short-circuit behavior on that result.)
    const { deps, spawned } = baseDeps(harness, {
      detectMode: () => ({
        mode: "redeploy-required",
        source: "container",
        reason: "container image-pinned ($BUN_INSTALL not on the persistent disk)",
      }),
    });
    const res = await handleHubUpgrade(
      postReq({ authorization: `Bearer ${bearer}` }, { channel: "rc" }),
      deps,
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { mode: string };
    expect(body.mode).toBe("redeploy-required");
    // The honest path: NO helper, NO misleading no-op rewrite.
    expect(spawned.length).toBe(0);
    // Status file reflects redeploy-required (terminal) so the SPA renders the
    // dashboard hint, not a spinner.
    const status = readHubUpgradeStatus(harness.dir);
    expect(status?.phase).toBe("redeploy-required");
    expect(status?.mode).toBe("redeploy-required");
  });
});

describe("POST /api/hub/upgrade — 409 in-flight guard (concurrent-upgrade)", () => {
  /** Seed the status file with a prior op in the given phase. */
  function seedStatus(dir: string, phase: HubUpgradeStatus["phase"], opId = "prior-op"): void {
    writeHubUpgradeStatus(dir, {
      operation_id: opId,
      phase,
      mode: "in-place",
      current_version: "0.6.3-rc.1",
      target_version: "0.6.3-rc.2",
      channel: "rc",
      log: [],
      started_at: new Date().toISOString(),
    });
  }

  for (const phase of ["pending", "running", "restarting"] as const) {
    test(`rejects a second POST while phase=${phase} with 409, no second helper spawned`, async () => {
      const bearer = await mintBearer(harness, ["parachute:host:admin"]);
      seedStatus(harness.dir, phase);
      const { deps, spawned } = baseDeps(harness);
      const res = await handleHubUpgrade(
        postReq({ authorization: `Bearer ${bearer}` }, { channel: "rc" }),
        deps,
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("upgrade_in_flight");
      // No second helper spawned; the prior op's status is untouched.
      expect(spawned.length).toBe(0);
      const status = readHubUpgradeStatus(harness.dir);
      expect(status?.operation_id).toBe("prior-op");
      expect(status?.phase).toBe(phase);
    });
  }

  for (const phase of ["failed", "redeploy-required", "succeeded"] as const) {
    test(`allows a new POST when the prior op is terminal (phase=${phase})`, async () => {
      const bearer = await mintBearer(harness, ["parachute:host:admin"]);
      seedStatus(harness.dir, phase);
      const { deps, spawned } = baseDeps(harness);
      const res = await handleHubUpgrade(
        postReq({ authorization: `Bearer ${bearer}` }, { channel: "rc" }),
        deps,
      );
      expect(res.status).toBe(202);
      // A fresh operation took the slot + spawned its helper.
      expect(spawned.length).toBe(1);
      const status = readHubUpgradeStatus(harness.dir);
      expect(status?.operation_id).not.toBe("prior-op");
      expect(spawned[0]?.operationId).toBe(status?.operation_id);
    });
  }

  test("no prior status file → POST proceeds normally", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps, spawned } = baseDeps(harness);
    const res = await handleHubUpgrade(
      postReq({ authorization: `Bearer ${bearer}` }, { channel: "rc" }),
      deps,
    );
    expect(res.status).toBe(202);
    expect(spawned.length).toBe(1);
  });
});

describe("appendHubUpgradeStatus — operation_id guard (stale-helper isolation)", () => {
  test("a mismatched operationId is a NO-OP (cannot overwrite a newer op's status)", () => {
    const dir = mkdtempSync(join(tmpdir(), "phub-append-guard-"));
    try {
      // The slot is owned by the NEWER operation "op-2".
      writeHubUpgradeStatus(dir, {
        operation_id: "op-2",
        phase: "pending",
        mode: "in-place",
        current_version: "0.6.3-rc.2",
        target_version: "0.6.3-rc.3",
        channel: "rc",
        log: ["op-2 accepted"],
        started_at: new Date().toISOString(),
      });
      // A STALE helper from the superseded "op-1" tries to write — must no-op.
      appendHubUpgradeStatus(dir, "op-1", { phase: "failed", error: "stale" }, "stale helper line");
      const after = readHubUpgradeStatus(dir);
      expect(after?.operation_id).toBe("op-2");
      expect(after?.phase).toBe("pending"); // NOT "failed"
      expect(after?.error).toBeUndefined();
      expect(after?.log).toEqual(["op-2 accepted"]); // stale line NOT appended
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a matching operationId writes (phase advances + log appends)", () => {
    const dir = mkdtempSync(join(tmpdir(), "phub-append-match-"));
    try {
      writeHubUpgradeStatus(dir, {
        operation_id: "op-1",
        phase: "pending",
        mode: "in-place",
        current_version: "0.6.3-rc.1",
        target_version: "0.6.3-rc.2",
        channel: "rc",
        log: ["accepted"],
        started_at: new Date().toISOString(),
      });
      appendHubUpgradeStatus(dir, "op-1", { phase: "running" }, "helper started");
      const after = readHubUpgradeStatus(dir);
      expect(after?.operation_id).toBe("op-1");
      expect(after?.phase).toBe("running");
      expect(after?.log).toEqual(["accepted", "helper started"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/hub/upgrade/status", () => {
  test("404 when no upgrade has been started", async () => {
    const bearer = await mintBearer(harness, ["parachute:host:admin"]);
    const { deps } = baseDeps(harness);
    const res = await handleHubUpgradeStatus(
      getStatusReq({ authorization: `Bearer ${bearer}` }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  test("401 without bearer", async () => {
    const { deps } = baseDeps(harness);
    const res = await handleHubUpgradeStatus(getStatusReq({}), deps);
    expect(res.status).toBe(401);
  });
});

describe("detectHubUpgradeMode — §5.3 heuristic", () => {
  test("bun-linked → in-place", () => {
    const r = detectHubUpgradeMode({
      env: { PARACHUTE_HOME: "/home/op/.parachute" },
      source: { kind: "bun-linked", path: "/home/op/parachute-hub" },
    });
    expect(r.mode).toBe("in-place");
    expect(r.source).toBe("bun-linked");
  });

  test("npm on a VM (non-container) → in-place", () => {
    const r = detectHubUpgradeMode({
      env: { PARACHUTE_HOME: "/home/op/.parachute" },
      source: { kind: "npm", path: "/home/op/.bun/install/global/node_modules/@openparachute/hub" },
    });
    expect(r.mode).toBe("in-place");
    expect(r.source).toBe("npm");
  });

  test("container + BUN_INSTALL on persistent disk → in-place", () => {
    const r = detectHubUpgradeMode({
      env: { PARACHUTE_HOME: "/parachute", BUN_INSTALL: "/parachute/.bun" },
      source: { kind: "npm", path: "/parachute/.bun/install/global/node_modules" },
    });
    expect(r.mode).toBe("in-place");
    expect(r.source).toBe("container");
  });

  test("container image-pinned (BUN_INSTALL off-mount) → redeploy-required", () => {
    const r = detectHubUpgradeMode({
      env: { PARACHUTE_HOME: "/parachute", BUN_INSTALL: "/root/.bun" },
      source: { kind: "npm", path: "/app/src" },
    });
    expect(r.mode).toBe("redeploy-required");
    expect(r.source).toBe("container");
  });

  test("container with BUN_INSTALL unset → redeploy-required (conservative)", () => {
    const r = detectHubUpgradeMode({
      env: { PARACHUTE_HOME: "/parachute" },
      source: { kind: "bun-linked", path: "/app" },
    });
    // bun-linked wins even in a container (git pull persists on disk).
    expect(r.mode).toBe("in-place");
  });

  test("unknown source (non-container) → redeploy-required (honest fallback)", () => {
    const r = detectHubUpgradeMode({
      env: { PARACHUTE_HOME: "/home/op/.parachute" },
      source: { kind: "unknown" },
    });
    expect(r.mode).toBe("redeploy-required");
    expect(r.source).toBe("unknown");
  });

  test("descendant-of guard: a stray /parachute path component is NOT on-mount", () => {
    const r = detectHubUpgradeMode({
      env: { PARACHUTE_HOME: "/parachute", BUN_INSTALL: "/parachute-other/.bun" },
      source: { kind: "npm", path: "/app/src" },
    });
    // /parachute-other is NOT under /parachute/ → image-pinned.
    expect(r.mode).toBe("redeploy-required");
  });
});

describe("hub-upgrade helper — rewrite-then-restart sequence", () => {
  function helperHarness() {
    const dir = mkdtempSync(join(tmpdir(), "phub-helper-"));
    writeHubUpgradeStatus(dir, {
      operation_id: "op-test",
      phase: "pending",
      mode: "in-place",
      current_version: "0.6.3-rc.1",
      target_version: "0.6.3-rc.2",
      channel: "rc",
      log: [],
      started_at: new Date().toISOString(),
    });
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("unit-managed: rewrite (no upgrade-side restart) then restartHubUnit", async () => {
    const { dir, cleanup } = helperHarness();
    try {
      const upgradeCalls: { svc: string; opts: UpgradeOpts }[] = [];
      let restartUnitCalled = 0;
      const code = await runHubUpgradeHelper(
        { operationId: "op-test", channel: "rc", configDir: dir },
        {
          upgrade: async (svc, opts) => {
            upgradeCalls.push({ svc, opts });
            opts.log?.("fake bun add -g done");
            return 0;
          },
          isHubUnitInstalled: () => true,
          restartHubUnit: (): HubUnitManagerOpResult => {
            restartUnitCalled++;
            return { outcome: "ok", messages: ["restarted hub unit"] };
          },
        },
      );
      expect(code).toBe(0);
      // upgrade was called for "hub" with a no-op restartFn (rewrite-only) and
      // NO supervisor block (helper owns the restart, not upgrade's dual-dispatch).
      expect(upgradeCalls.length).toBe(1);
      expect(upgradeCalls[0]?.svc).toBe("hub");
      expect(upgradeCalls[0]?.opts.channel).toBe("rc");
      expect(upgradeCalls[0]?.opts.supervisor).toBeUndefined();
      expect(typeof upgradeCalls[0]?.opts.restartFn).toBe("function");
      // restartHubUnit was the restart authority.
      expect(restartUnitCalled).toBe(1);
      const status = readHubUpgradeStatus(dir);
      expect(status?.phase).toBe("restarting");
    } finally {
      cleanup();
    }
  });

  test("container (no unit): rewrite then SIGTERM the hub pid", async () => {
    const { dir, cleanup } = helperHarness();
    try {
      const signals: [number, string][] = [];
      const code = await runHubUpgradeHelper(
        { operationId: "op-test", channel: "rc", configDir: dir, hubPid: 4242 },
        {
          upgrade: async () => 0,
          isHubUnitInstalled: () => false,
          signalHub: (pid, sig) => signals.push([pid, sig]),
        },
      );
      expect(code).toBe(0);
      expect(signals).toEqual([[4242, "SIGTERM"]]);
      const status = readHubUpgradeStatus(dir);
      expect(status?.phase).toBe("restarting");
    } finally {
      cleanup();
    }
  });

  test("rewrite failure → phase failed, NO restart fired", async () => {
    const { dir, cleanup } = helperHarness();
    try {
      let restartUnitCalled = 0;
      const signals: unknown[] = [];
      const code = await runHubUpgradeHelper(
        { operationId: "op-test", channel: "rc", configDir: dir, hubPid: 1 },
        {
          upgrade: async () => 1, // rewrite failed
          isHubUnitInstalled: () => false,
          restartHubUnit: () => {
            restartUnitCalled++;
            return { outcome: "ok", messages: [] };
          },
          signalHub: (pid, sig) => signals.push([pid, sig]),
        },
      );
      expect(code).toBe(1);
      expect(restartUnitCalled).toBe(0);
      expect(signals.length).toBe(0);
      const status = readHubUpgradeStatus(dir);
      expect(status?.phase).toBe("failed");
    } finally {
      cleanup();
    }
  });

  test("unit restart failure → phase failed", async () => {
    const { dir, cleanup } = helperHarness();
    try {
      const code = await runHubUpgradeHelper(
        { operationId: "op-test", channel: "rc", configDir: dir },
        {
          upgrade: async () => 0,
          isHubUnitInstalled: () => true,
          restartHubUnit: (): HubUnitManagerOpResult => ({
            outcome: "failed",
            messages: ["systemctl restart failed"],
          }),
        },
      );
      expect(code).toBe(1);
      const status = readHubUpgradeStatus(dir);
      expect(status?.phase).toBe("failed");
    } finally {
      cleanup();
    }
  });

  test("container with no hub pid → still succeeds (relies on runtime restart)", async () => {
    const { dir, cleanup } = helperHarness();
    try {
      const signals: unknown[] = [];
      const code = await runHubUpgradeHelper(
        { operationId: "op-test", channel: "rc", configDir: dir },
        {
          upgrade: async () => 0,
          isHubUnitInstalled: () => false,
          signalHub: (pid, sig) => signals.push([pid, sig]),
        },
      );
      expect(code).toBe(0);
      expect(signals.length).toBe(0);
      const status = readHubUpgradeStatus(dir);
      expect(status?.phase).toBe("restarting");
    } finally {
      cleanup();
    }
  });

  test("status-file progress writes accumulate in order", async () => {
    const { dir, cleanup } = helperHarness();
    try {
      await runHubUpgradeHelper(
        { operationId: "op-test", channel: "rc", configDir: dir, hubPid: 99 },
        {
          upgrade: async (_svc, opts) => {
            opts.log?.("running bun add -g @openparachute/hub@rc");
            return 0;
          },
          isHubUnitInstalled: () => false,
          signalHub: () => {},
        },
      );
      const status = readHubUpgradeStatus(dir);
      expect(status?.log[0]).toContain("helper started");
      expect(status?.log.some((l) => l.includes("bun add -g"))).toBe(true);
      expect(status?.log.some((l) => l.includes("signalling the hub"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
