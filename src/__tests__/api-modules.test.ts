import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_MODULES_CHANNEL_REQUIRED_SCOPE,
  API_MODULES_REQUIRED_SCOPE,
  _clearLatestVersionCacheForTests,
  defaultReadInstalledVersion,
  handleApiModules,
  handleApiModulesChannel,
  isUpgradeAvailable,
} from "../api-modules.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { getSetting, setModuleInstallChannel } from "../hub-settings.ts";
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

/** The hub's public origin after `expose` — what the operator token's `iss` becomes (hub#516). */
const PUBLIC_ORIGIN = "https://parachute.taildf9ce2.ts.net";
/** A foreign origin the hub never answers on (hub#516). */
const FOREIGN_ORIGIN = "https://evil.example.com";

/** Mint a host-admin (operator-shaped) bearer at a chosen `iss` (hub#516). */
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

  // hub#516: `parachute status` reads /api/modules on loopback presenting the
  // operator token, whose `iss` is the PUBLIC origin after `expose`. The
  // host-admin bearer's iss is validated against `knownIssuers` (loopback ∪
  // expose-state public ∪ env), not the single per-request loopback issuer.
  test("live repro: public-iss operator token on a loopback request → 200 (hub#516)", async () => {
    const bearer = await mintBearerAtIssuer(h, [API_MODULES_REQUIRED_SCOPE], PUBLIC_ORIGIN);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER, // loopback per-request issuer
      knownIssuers: [ISSUER, "http://localhost:1939", PUBLIC_ORIGIN],
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    expect(res.status).toBe(200);
  });

  test("FOREIGN-iss operator token → 401 (no widening) (hub#516)", async () => {
    const bearer = await mintBearerAtIssuer(h, [API_MODULES_REQUIRED_SCOPE], FOREIGN_ORIGIN);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      knownIssuers: [ISSUER, "http://localhost:1939", PUBLIC_ORIGIN],
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error_description: string };
    expect(body.error_description).toMatch(/unexpected "iss" claim value/);
  });

  test("knownIssuers absent → strict per-request issuer fallback rejects public-iss (hub#516)", async () => {
    const bearer = await mintBearerAtIssuer(h, [API_MODULES_REQUIRED_SCOPE], PUBLIC_ORIGIN);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER, // no knownIssuers → falls back to [issuer]
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    expect(res.status).toBe(401);
  });

  test("200 + full self-registration catalog on fresh container (empty services.json)", async () => {
    // The v0.6 hot path: brand-new Render container, no services.json
    // yet. Post-2026-06-09 (modular-UI architecture, P2) discovery is driven
    // by the UNION of the bootstrap registries (KNOWN_MODULES ∪
    // FIRST_PARTY_FALLBACKS), NOT a curated whitelist. Every known module
    // surfaces — core (vault/scribe/surface) in the headline tier, agent as
    // `experimental`, and notes as `deprecated` (2026-06-25, still
    // resolvable but not offered for fresh installs) — so the agent-not-installed
    // class (running but invisible) can't recur while deprecated modules stop
    // being pushed on a fresh box. runner left the registries entirely on
    // 2026-07-01 and must NOT surface on a fresh catalog.
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
        focus: "core" | "experimental" | "deprecated";
        available: boolean;
        available_to_install: boolean;
        installed: boolean;
        latest_version: string | null;
      }>;
      supervisor_available: boolean;
    };
    const shorts = body.modules.map((m) => m.short);
    // The core tier leads, in the recommended install order (vault → scribe),
    // ahead of every experimental module, which lead the deprecated ones.
    expect(shorts.indexOf("vault")).toBeLessThan(shorts.indexOf("scribe"));
    expect(shorts.indexOf("scribe")).toBeLessThan(shorts.indexOf("agent"));
    // agent (experimental) sorts ahead of notes (deprecated).
    expect(shorts.indexOf("agent")).toBeLessThan(shorts.indexOf("notes"));
    // Every known module is discoverable — vault/scribe/surface (core),
    // agent (experimental), notes (deprecated). runner is gone (2026-07-01
    // registry removal) — a fresh box never sees it.
    for (const s of ["vault", "scribe", "surface", "agent", "notes"]) {
      expect(shorts).toContain(s);
    }
    expect(shorts).not.toContain("runner");
    expect(shorts).not.toContain("parachute-runner");
    // Focus tier resolves from the default map.
    const byShort = new Map(body.modules.map((m) => [m.short, m]));
    expect(byShort.get("vault")?.focus).toBe("core");
    expect(byShort.get("scribe")?.focus).toBe("core");
    expect(byShort.get("surface")?.focus).toBe("core");
    expect(byShort.get("agent")?.focus).toBe("experimental");
    expect(byShort.get("notes")?.focus).toBe("deprecated");
    // `available` stays true for every known module (re-installable), but the
    // fresh-install OFFER (`available_to_install`) drops the deprecated tier —
    // notes isn't pushed on a fresh box; agent (experimental) still is.
    expect(body.modules.every((m) => m.available)).toBe(true);
    expect(byShort.get("vault")?.available_to_install).toBe(true);
    expect(byShort.get("scribe")?.available_to_install).toBe(true);
    expect(byShort.get("surface")?.available_to_install).toBe(true);
    expect(byShort.get("agent")?.available_to_install).toBe(true);
    expect(byShort.get("notes")?.available_to_install).toBe(false);
    expect(body.modules.every((m) => !m.installed)).toBe(true);
    expect(body.modules.every((m) => m.latest_version === "0.9.9")).toBe(true);
    // Supervisor wasn't injected → flag reflects that.
    expect(body.supervisor_available).toBe(false);
  });

  test("an installed LEGACY runner row still surfaces as a third-party row post-registry-removal (2026-07-01)", async () => {
    // A legacy operator with runner on disk: post-removal the row no longer
    // resolves to a known short, so it surfaces under its own manifest name
    // (`parachute-runner`) exactly like a third-party module — visible
    // (installed: true), never offered (`available` false: no install package
    // known to the hub), and NEVER crashes the catalog. This is the graceful
    // existing-install posture the removal preserves.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-runner",
        port: 1945,
        paths: ["/runner", "/.parachute"],
        health: "/runner/healthz",
        version: "0.2.0",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    const body = (await res.json()) as {
      modules: Array<{
        short: string;
        focus: "core" | "experimental" | "deprecated";
        installed: boolean;
        installed_version: string | null;
        available: boolean;
        available_to_install: boolean;
      }>;
    };
    // No known short resolves anymore — the row surfaces under its own
    // manifest name, the third-party fallback convention.
    expect(body.modules.find((m) => m.short === "runner")).toBeUndefined();
    const runner = body.modules.find((m) => m.short === "parachute-runner");
    expect(runner).toBeDefined();
    expect(runner?.installed).toBe(true);
    expect(runner?.installed_version).toBe("0.2.0");
    // Unlisted shorts default to the experimental tier (no special-casing
    // survives the removal).
    expect(runner?.focus).toBe("experimental");
    // No install package known to the hub → not installable, never offered.
    expect(runner?.available).toBe(false);
    expect(runner?.available_to_install).toBe(false);
  });

  test("scribe row carries package + display props from KNOWN_MODULES", async () => {
    // Spot-check the wire shape resolves scribe-specific fields
    // (package, displayName, tagline) from KNOWN_MODULES rather than a
    // stale default. Vault is exercised via the install-state test below;
    // this pins the other curated row's KNOWN_MODULES round-trip.
    //
    // Pre-2026-05-27 this test pinned the `surface` row (added by
    // hub#323), and a sibling pinned the `runner` FIRST_PARTY_FALLBACKS
    // row (hub#305). Both modules retired from CURATED_MODULES — the
    // FIRST_PARTY_FALLBACKS / KNOWN_MODULES entries persist for the
    // install-bootstrap path but `/api/modules` doesn't return them.
    // The "uncurated modules don't surface here" test below pins that
    // boundary.
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => "0.4.4",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{
        short: string;
        package: string;
        display_name: string;
        tagline: string;
        available: boolean;
      }>;
    };
    const scribe = body.modules.find((m) => m.short === "scribe");
    expect(scribe).toBeDefined();
    expect(scribe?.package).toBe("@openparachute/scribe");
    expect(scribe?.display_name).toBe("Scribe");
    expect(scribe?.tagline).toContain("transcription");
    expect(scribe?.available).toBe(true);
  });

  test("agent (running + self-registered) appears as installed + experimental — regression for the channel-not-installed bug", async () => {
    // THE bug this PR fixes (2026-06-09 modular-UI architecture, P2): agent (renamed from channel 2026-06-17)
    // was running, proxied, supervised, and self-registered in services.json
    // yet invisible on the Modules screen — because the old CURATED_MODULES =
    // ["vault","scribe"] whitelist gated discovery. Now discovery is driven by
    // self-registration ∪ the known registries, so a self-registered agent
    // row surfaces as installed, in the experimental tier, with its run-state.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-agent",
        port: 1941,
        paths: ["/agent"],
        health: "/agent/health",
        version: "0.3.1",
      },
    ]);
    const { supervisor } = makeIdleSupervisor();
    await supervisor.start({ short: "agent", cmd: ["parachute-agent"] });

    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      supervisor,
      fetchLatestVersion: async () => null,
    });
    const body = (await res.json()) as {
      modules: Array<{
        short: string;
        focus: "core" | "experimental";
        installed: boolean;
        installed_version: string | null;
        supervisor_status: string | null;
      }>;
    };
    const agent = body.modules.find((m) => m.short === "agent");
    expect(agent).toBeDefined();
    expect(agent?.installed).toBe(true);
    expect(agent?.installed_version).toBe("0.3.1");
    expect(agent?.focus).toBe("experimental");
    expect(agent?.supervisor_status).toBe("running");
  });

  test("every self-registered + known module appears in `modules` — no running-but-invisible class", async () => {
    // The two-registry-disagreement (services.json says installed, the curated
    // whitelist says invisible) is gone: a self-registered surface row + a    // supervised agent both surface in `modules` (2026-06-09 modular-UI
    // architecture). `supervised` still mirrors the run-state for every
    // tracked module (hub#539) — consumers dedupe by short.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
      },
      {
        name: "parachute-surface",
        port: 1946,
        paths: ["/surface"],
        health: "/surface/healthz",
        version: "0.2.0",
      },
    ]);
    const { supervisor } = makeIdleSupervisor();
    await supervisor.start({ short: "vault", cmd: ["parachute-vault", "serve"] });
    await supervisor.start({ short: "surface", cmd: ["parachute-surface", "serve"] });

    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      supervisor,
      fetchLatestVersion: async () => null,
    });
    const body = (await res.json()) as {
      modules: Array<{ short: string; installed: boolean }>;
      supervised: Array<{ short: string; supervisor_status: string | null; pid: number | null }>;
    };
    // surface is now IN the catalog (it was excluded under the whitelist), and
    // reflects installed:true from its services.json row.
    const surf = body.modules.find((m) => m.short === "surface");
    expect(surf?.installed).toBe(true);
    // …and its run-state is still in `supervised`, marked running with a pid.
    const surfSup = body.supervised.find((m) => m.short === "surface");
    expect(surfSup?.supervisor_status).toBe("running");
    expect(typeof surfSup?.pid).toBe("number");
    // Curated modules appear in `supervised` too (consumers dedupe by short).
    expect(body.supervised.find((m) => m.short === "vault")?.supervisor_status).toBe("running");
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
    // The other curated row stays installed:false — the test installed
    // only vault, so scribe still renders as available-but-not-installed.
    const scribe = body.modules.find((m) => m.short === "scribe");
    expect(scribe?.installed).toBe(false);
    expect(scribe?.installed_version).toBeNull();
  });

  // ── hub#243: upgrade-offer must be semver-aware + installed-version must be live ──

  type UpgradeWire = {
    short: string;
    installed_version: string | null;
    latest_version: string | null;
    upgrade_available: boolean;
  };

  async function modulesWith(opts: {
    installedVersion: string;
    latest: string | null;
    readInstalledVersion?: (installDir: string) => string | null;
  }): Promise<UpgradeWire[]> {
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: opts.installedVersion,
        installDir: "/install/dir/vault",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => opts.latest,
      // Default: no live read (synthetic install dir has no package.json), so
      // the services.json cache is used — matching the prior behavior.
      readInstalledVersion: opts.readInstalledVersion ?? (() => null),
    });
    const body = (await res.json()) as { modules: UpgradeWire[] };
    return body.modules;
  }

  test("does NOT offer an upgrade when the channel target is OLDER than installed (the live downgrade bug)", async () => {
    // The exact live shape: rc operator installed 0.6.4-rc.15; channel resolved
    // latest_version to the OLDER @latest 0.6.3. Strings differ, but it's a
    // downgrade — upgrade_available MUST be false.
    const mods = await modulesWith({ installedVersion: "0.6.4-rc.15", latest: "0.6.3" });
    const vault = mods.find((m) => m.short === "vault");
    expect(vault?.installed_version).toBe("0.6.4-rc.15");
    expect(vault?.latest_version).toBe("0.6.3");
    expect(vault?.upgrade_available).toBe(false);
  });

  test("offers an upgrade for a real rc → newer-rc move", async () => {
    const mods = await modulesWith({ installedVersion: "0.6.4-rc.15", latest: "0.6.4-rc.16" });
    const vault = mods.find((m) => m.short === "vault");
    expect(vault?.upgrade_available).toBe(true);
  });

  test("offers an upgrade for rc → its own stable (stable > its rc per semver)", async () => {
    const mods = await modulesWith({ installedVersion: "0.6.4-rc.15", latest: "0.6.4" });
    const vault = mods.find((m) => m.short === "vault");
    expect(vault?.upgrade_available).toBe(true);
  });

  test("offers an upgrade for a plain stable → newer stable", async () => {
    const mods = await modulesWith({ installedVersion: "0.4.5", latest: "0.5.0" });
    const vault = mods.find((m) => m.short === "vault");
    expect(vault?.upgrade_available).toBe(true);
  });

  test("no upgrade when installed === latest", async () => {
    const mods = await modulesWith({ installedVersion: "0.5.0", latest: "0.5.0" });
    const vault = mods.find((m) => m.short === "vault");
    expect(vault?.upgrade_available).toBe(false);
  });

  test("no upgrade when the npm probe failed (latest_version null)", async () => {
    const mods = await modulesWith({ installedVersion: "0.5.0", latest: null });
    const vault = mods.find((m) => m.short === "vault");
    expect(vault?.latest_version).toBeNull();
    expect(vault?.upgrade_available).toBe(false);
  });

  test("installed_version reflects the LIVE on-disk version, not a stale services.json cache (hub#243)", async () => {
    // services.json cache lags the bun-linked checkout: cache says 0.5.4-rc.15
    // (the live symptom) while package.json on disk is already 0.6.4-rc.15.
    // The admin view must show what's actually installed.
    const mods = await modulesWith({
      installedVersion: "0.5.4-rc.15",
      latest: "0.6.3",
      readInstalledVersion: (dir) => (dir === "/install/dir/vault" ? "0.6.4-rc.15" : null),
    });
    const vault = mods.find((m) => m.short === "vault");
    expect(vault?.installed_version).toBe("0.6.4-rc.15");
    // And with the corrected current, @latest 0.6.3 is still a downgrade → no offer.
    expect(vault?.upgrade_available).toBe(false);
  });

  test("falls back to the services.json version when the live read returns null", async () => {
    const mods = await modulesWith({
      installedVersion: "0.6.4-rc.15",
      latest: "0.6.4-rc.16",
      readInstalledVersion: () => null,
    });
    const vault = mods.find((m) => m.short === "vault");
    expect(vault?.installed_version).toBe("0.6.4-rc.15");
    expect(vault?.upgrade_available).toBe(true);
  });

  test("isUpgradeAvailable: semver-aware, fail-closed on unparseable + nulls", () => {
    // strictly-newer → true
    expect(isUpgradeAvailable("0.4.5", "0.5.0")).toBe(true);
    expect(isUpgradeAvailable("0.6.4-rc.15", "0.6.4-rc.16")).toBe(true);
    expect(isUpgradeAvailable("0.6.4-rc.15", "0.6.4")).toBe(true); // stable > its rc
    // same / older → false
    expect(isUpgradeAvailable("0.5.0", "0.5.0")).toBe(false);
    expect(isUpgradeAvailable("0.6.4-rc.15", "0.6.3")).toBe(false); // the live downgrade
    expect(isUpgradeAvailable("0.6.4", "0.6.4-rc.15")).toBe(false); // stable → its rc
    // nulls → false (not installed / probe failed)
    expect(isUpgradeAvailable(null, "0.5.0")).toBe(false);
    expect(isUpgradeAvailable("0.5.0", null)).toBe(false);
    // unparseable → false (fail-closed: never offer a move we can't verify)
    expect(isUpgradeAvailable("not-a-version", "0.5.0")).toBe(false);
    expect(isUpgradeAvailable("0.5.0", "garbage")).toBe(false);
  });

  test("defaultReadInstalledVersion reads package.json version + tolerates missing/bad files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "phub-live-ver-"));
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ version: "0.6.4-rc.15" }));
      expect(defaultReadInstalledVersion(tmp)).toBe("0.6.4-rc.15");
      // Missing dir / no package.json → null.
      expect(defaultReadInstalledVersion(join(tmp, "does-not-exist"))).toBeNull();
      // Malformed JSON → null (no throw).
      writeFileSync(join(tmp, "package.json"), "{ not json");
      expect(defaultReadInstalledVersion(tmp)).toBeNull();
      // No version field → null.
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "x" }));
      expect(defaultReadInstalledVersion(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
    const scribe = body.modules.find((m) => m.short === "scribe");
    expect(scribe?.supervisor_status).toBeNull();
    expect(scribe?.pid).toBeNull();
    expect(body.supervisor_available).toBe(true);
  });

  test("projects the supervisor's structured startError onto supervisor_start_error (§6.4/#188)", async () => {
    // The Phase 3c `parachute status` supervisor arm reads this field to show
    // the SAME friendly missing-dependency note the detached path persists. A
    // fake supervisor whose list() returns a `crashed` state carrying a
    // structured `startError` exercises the projection.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
      },
    ]);
    const fakeSupervisor = {
      list: () => [
        {
          short: "vault",
          status: "crashed" as const,
          restartsInWindow: 1,
          startError: {
            error_type: "missing_dependency",
            error_description: "parachute-vault is required",
            binary: "parachute-vault",
            at: "2026-06-01T00:00:00Z",
          },
        },
      ],
    } as unknown as Supervisor;

    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      supervisor: fakeSupervisor,
      fetchLatestVersion: async () => null,
    });
    const body = (await res.json()) as {
      modules: Array<{
        short: string;
        supervisor_status: string | null;
        supervisor_start_error: { binary?: string; error_type?: string } | null;
      }>;
    };
    const vault = body.modules.find((m) => m.short === "vault");
    expect(vault?.supervisor_status).toBe("crashed");
    expect(vault?.supervisor_start_error?.binary).toBe("parachute-vault");
    expect(vault?.supervisor_start_error?.error_type).toBe("missing_dependency");
    // A module with no supervisor entry surfaces null (uniform wire shape).
    const scribe = body.modules.find((m) => m.short === "scribe");
    expect(scribe?.supervisor_start_error).toBeNull();
  });

  test("populates management_url from a RELATIVE managementUrl + module mount (B4 per-instance form)", async () => {
    // Vault's new manifest declares `managementUrl: "admin/"` — relative, no
    // leading slash: the per-instance form under the B4 unified semantics
    // (2026-06-09 hub-module-boundary). Hub joins it under the entry's mount
    // path (`/vault/default`) to produce the absolute admin URL the SPA's
    // "Open" button targets.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
        installDir: "/install/dir/vault",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
      readModuleManifest: async (installDir) => {
        // Return a minimal module.json with managementUrl set. Cast the
        // shape via `as unknown as ...` because the test only exercises
        // the consumer-side resolver, not the validator (which lives in
        // module-manifest.ts and has its own test suite).
        if (installDir === "/install/dir/vault") {
          return {
            name: "parachute-vault",
            manifestName: "parachute-vault",
            displayName: "Vault",
            tagline: "",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            managementUrl: "admin/",
          } as unknown as Awaited<
            ReturnType<typeof import("../module-manifest.ts").readModuleManifest>
          >;
        }
        return null;
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{ short: string; management_url: string | null }>;
    };
    const vault = body.modules.find((m) => m.short === "vault");
    expect(vault?.management_url).toBe("/vault/default/admin/");
  });

  test('COMPAT SHIM: the literal legacy "/admin" on a VAULT entry still mount-joins (one release)', async () => {
    // Deployed vaults still declare `managementUrl: "/admin"` — the OLD
    // per-instance relative form. Under the new semantics a leading-"/" is
    // origin-absolute (which would point at the daemon-level /vault/admin
    // mount, not the instance), so the literal "/admin"/"/admin/" on a vault
    // entry keeps the old mount-join behavior for one release, with a
    // deprecation log. Remove the shim once vault's new manifest is @latest.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
        installDir: "/install/dir/vault",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
      readModuleManifest: async (installDir) => {
        if (installDir === "/install/dir/vault") {
          return {
            name: "parachute-vault",
            manifestName: "parachute-vault",
            displayName: "Vault",
            tagline: "",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            managementUrl: "/admin",
          } as unknown as Awaited<
            ReturnType<typeof import("../module-manifest.ts").readModuleManifest>
          >;
        }
        return null;
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{ short: string; management_url: string | null }>;
    };
    const vault = body.modules.find((m) => m.short === "vault");
    // Mount-joined (legacy behavior preserved), NOT origin-absolute "/admin".
    expect(vault?.management_url).toBe("/vault/default/admin");
  });

  test("populates config_ui_url from a module's configUiUrl (2026-06-09 modular-UI P3)", async () => {
    // Agent declares `configUiUrl: "/agent/admin"` (a single-instance,
    // origin-absolute path) + `uiUrl: "/agent/ui"`. The hub surfaces
    // both: `config_ui_url` drives the Modules page Configure action,
    // `management_url` drives Open. configUiUrl resolves identically to
    // managementUrl (same B4 unified semantics).
    writeManifest(h.manifestPath, [
      {
        name: "agent",
        port: 1941,
        paths: ["/agent"],
        health: "/health",
        version: "0.1.0",
        installDir: "/install/dir/agent",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
      readModuleManifest: async (installDir) => {
        if (installDir === "/install/dir/agent") {
          return {
            name: "agent",
            manifestName: "parachute-agent",
            displayName: "Agent",
            tagline: "",
            port: 1941,
            paths: ["/agent"],
            health: "/health",
            uiUrl: "/agent/ui",
            configUiUrl: "/agent/admin",
          } as unknown as Awaited<
            ReturnType<typeof import("../module-manifest.ts").readModuleManifest>
          >;
        }
        return null;
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{
        short: string;
        config_ui_url: string | null;
        management_url: string | null;
      }>;
    };
    const agent = body.modules.find((m) => m.short === "agent");
    // Origin-absolute — verbatim, never double-prepends `/agent`.
    expect(agent?.config_ui_url).toBe("/agent/admin");
    // uiUrl (no managementUrl) drives the Open action's management_url.
    expect(agent?.management_url).toBe("/agent/ui");
  });

  test("config_ui_url is null when the module declares no configUiUrl", async () => {
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
        installDir: "/install/dir/vault",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
      readModuleManifest: async (installDir) => {
        if (installDir === "/install/dir/vault") {
          return {
            name: "parachute-vault",
            manifestName: "parachute-vault",
            displayName: "Vault",
            tagline: "",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
            managementUrl: "/admin",
          } as unknown as Awaited<
            ReturnType<typeof import("../module-manifest.ts").readModuleManifest>
          >;
        }
        return null;
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{ short: string; config_ui_url: string | null }>;
    };
    const vault = body.modules.find((m) => m.short === "vault");
    expect(vault?.config_ui_url).toBeNull();
  });

  test("management_url passes a leading-slash path through verbatim (origin-absolute, B4)", async () => {
    // Historical context (hub#380): surface declared `managementUrl:
    // "/surface/admin/"` (full hub-origin path) and the resolver
    // double-prepended the mount (`/surface/surface/admin/` → 404), patched
    // then by an already-mount-prefixed heuristic. Under the B4 unified
    // semantics the heuristic is gone: ANY leading-"/" path is
    // ORIGIN-ABSOLUTE and passes through verbatim (except the vault "/admin"
    // compat shim) — same result here, simpler rule.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.4.5",
        installDir: "/install/dir/vault",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
      readModuleManifest: async (installDir) => {
        if (installDir === "/install/dir/vault") {
          return {
            name: "parachute-vault",
            manifestName: "parachute-vault",
            displayName: "Vault",
            tagline: "",
            port: 1940,
            paths: ["/vault/default"],
            health: "/vault/default/health",
            // Origin-absolute managementUrl — passes through verbatim,
            // never gets the mount prepended.
            managementUrl: "/vault/default/admin/",
          } as unknown as Awaited<
            ReturnType<typeof import("../module-manifest.ts").readModuleManifest>
          >;
        }
        return null;
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{ short: string; management_url: string | null }>;
    };
    const vault = body.modules.find((m) => m.short === "vault");
    // Single `/vault/default/`, not `/vault/default/vault/default/`.
    expect(vault?.management_url).toBe("/vault/default/admin/");
  });

  test("management_url: a leading-slash path NOT under the mount is still origin-absolute (B4 inverts hub#380)", async () => {
    // INVERTED PIN (B4). Pre-B4 the resolver prepended the mount onto any
    // leading-"/" candidate that didn't look already-mount-prefixed:
    // mount=/surface + "/app-foo/admin" → "/surface/app-foo/admin". Under
    // the unified semantics a leading-"/" is ORIGIN-ABSOLUTE, verbatim —
    // the module says exactly where its surface lives on the origin.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/surface"], // mount is /app (using vault as a stand-in installable)
        health: "/surface/health",
        version: "0.4.5",
        installDir: "/install/dir/contrived",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
      readModuleManifest: async (installDir) => {
        if (installDir === "/install/dir/contrived") {
          return {
            name: "parachute-vault",
            manifestName: "parachute-vault",
            displayName: "Vault",
            tagline: "",
            port: 1940,
            paths: ["/surface"],
            health: "/surface/health",
            // Origin-absolute path outside this module's own mount —
            // verbatim under B4 (pre-B4 this was mount-prepended).
            managementUrl: "/app-foo/admin",
          } as unknown as Awaited<
            ReturnType<typeof import("../module-manifest.ts").readModuleManifest>
          >;
        }
        return null;
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{ short: string; management_url: string | null }>;
    };
    const vault = body.modules.find((m) => m.short === "vault");
    // Origin-absolute, verbatim — NOT /surface/app-foo/admin.
    expect(vault?.management_url).toBe("/app-foo/admin");
  });

  test("management_url equality edge: candidate equals mount exactly", async () => {
    // mount=/foo, candidate=/foo → origin-absolute, verbatim — same output
    // as the pre-B4 equality branch, simpler rule.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-vault",
        port: 1940,
        paths: ["/foo"],
        health: "/foo/health",
        version: "0.4.5",
        installDir: "/install/dir/equality",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
      readModuleManifest: async (installDir) => {
        if (installDir === "/install/dir/equality") {
          return {
            name: "parachute-vault",
            manifestName: "parachute-vault",
            displayName: "Vault",
            tagline: "",
            port: 1940,
            paths: ["/foo"],
            health: "/foo/health",
            managementUrl: "/foo",
          } as unknown as Awaited<
            ReturnType<typeof import("../module-manifest.ts").readModuleManifest>
          >;
        }
        return null;
      },
    });
    const body = (await res.json()) as {
      modules: Array<{ short: string; management_url: string | null }>;
    };
    const vault = body.modules.find((m) => m.short === "vault");
    expect(vault?.management_url).toBe("/foo");
  });

  test("management_url is null when the module declares neither managementUrl nor uiUrl (hub#342)", async () => {
    // Scribe + runner today: no managementUrl declared yet. The SPA's
    // "Open" button renders disabled with a follow-up tooltip in that
    // case — null on the wire is the canonical signal.
    writeManifest(h.manifestPath, [
      {
        name: "parachute-scribe",
        port: 1942,
        paths: ["/scribe"],
        health: "/scribe/health",
        version: "0.1.0",
        installDir: "/install/dir/scribe",
      },
    ]);
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
      readModuleManifest: async () =>
        ({
          name: "parachute-scribe",
          manifestName: "parachute-scribe",
          displayName: "Scribe",
          tagline: "",
          port: 1942,
          paths: ["/scribe"],
          health: "/health",
        }) as unknown as Awaited<
          ReturnType<typeof import("../module-manifest.ts").readModuleManifest>
        >,
    });
    const body = (await res.json()) as {
      modules: Array<{ short: string; management_url: string | null }>;
    };
    const scribe = body.modules.find((m) => m.short === "scribe");
    expect(scribe?.management_url).toBeNull();
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
    const probe = async (_pkg: string, _channel: "latest" | "rc"): Promise<string | null> => {
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

  test("fetchLatestVersion receives the configured install channel (hub#377 dist-tag fix)", async () => {
    // The audit caught the bug 2026-05-25 on Aaron's deploy: operators
    // on the `rc` channel saw the @latest dist-tag value as their upgrade
    // target (e.g. app showed "rc.4 available" while the rc channel was
    // actually at rc.13). The fix threads the configured channel into
    // fetchLatestVersion so the probe targets the right dist-tag.
    setModuleInstallChannel(h.db, "rc");
    const callsByChannel: string[] = [];
    const probe = async (_pkg: string, channel: "latest" | "rc"): Promise<string | null> => {
      callsByChannel.push(channel);
      return channel === "rc" ? "0.5.0-rc.13" : "0.5.0-rc.4";
    };
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: probe,
      cacheTtlMs: 0, // disable cache for this test
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modules: Array<{ short: string; latest_version: string | null }>;
    };
    // Every probe call received the configured channel.
    expect(callsByChannel.every((c) => c === "rc")).toBe(true);
    expect(callsByChannel.length).toBeGreaterThan(0);
    // The latest_version reflects the rc dist-tag.
    for (const m of body.modules) {
      expect(m.latest_version).toBe("0.5.0-rc.13");
    }
  });

  test("cache key includes channel — toggling channel returns fresh value, not stale (hub#377)", async () => {
    // The cache key includes channel so a runtime toggle between latest
    // and rc surfaces the right version immediately, not after TTL expiry.
    let callCount = 0;
    const probe = async (_pkg: string, channel: "latest" | "rc"): Promise<string | null> => {
      callCount++;
      return channel === "rc" ? "1.0.0-rc.5" : "1.0.0";
    };
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const deps = {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: probe,
      cacheTtlMs: 60_000,
    };
    setModuleInstallChannel(h.db, "latest");
    const r1 = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), deps);
    const b1 = (await r1.json()) as { modules: Array<{ latest_version: string | null }> };
    expect(b1.modules[0]?.latest_version).toBe("1.0.0");
    const callsAfterLatest = callCount;
    setModuleInstallChannel(h.db, "rc");
    const r2 = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), deps);
    const b2 = (await r2.json()) as { modules: Array<{ latest_version: string | null }> };
    expect(b2.modules[0]?.latest_version).toBe("1.0.0-rc.5");
    // Per-channel cache miss → fresh probe calls fired for the rc lookup.
    expect(callCount).toBeGreaterThan(callsAfterLatest);
  });

  test("surfaces module_install_channel in the response (hub#275)", async () => {
    // Default — first read seeds with `latest`.
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { module_install_channel: string };
    expect(body.module_install_channel).toBe("latest");
  });

  test("module_install_channel reflects toggled value on next GET", async () => {
    setModuleInstallChannel(h.db, "rc");
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    const body = (await res.json()) as { module_install_channel: string };
    expect(body.module_install_channel).toBe("rc");
  });

  // Hierarchical sub-units on the wire (hub#313). Each module row carries
  // a `uis: []` array — empty for vault / scribe / notes / runner, populated
  // for parachute-app once apps starts writing them. Snake-case keys
  // throughout to match the rest of the response.
  describe("uis hierarchical sub-units (hub#313)", () => {
    test("uis defaults to empty array on every row when none declare it", async () => {
      // The post-#313 wire shape must include `uis` unconditionally so
      // the SPA can `.map` without a presence check. Modules with no
      // `uis` declaration → empty array.
      const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
      const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        fetchLatestVersion: async () => null,
      });
      const body = (await res.json()) as {
        modules: Array<{ short: string; uis: unknown[] }>;
      };
      for (const m of body.modules) {
        expect(Array.isArray(m.uis)).toBe(true);
        expect(m.uis).toHaveLength(0);
      }
    });

    test("vault row carries uis sub-units when services.json declares them", async () => {
      // Synthetic: vault doesn't actually use `uis` yet, but the curated
      // join is by manifestName so any short can carry a `uis` map.
      // Once vault migrates (separate PR), this test pins the wire shape.
      writeManifest(h.manifestPath, [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.4.5",
          uis: {
            default: {
              displayName: "Default Vault",
              path: "/vault/default",
              oauthClientId: "client_v1",
              status: "active",
            },
            techne: {
              displayName: "Techne",
              path: "/vault/techne",
              status: "pending",
            },
          },
        },
      ]);
      const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
      const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        fetchLatestVersion: async () => null,
      });
      const body = (await res.json()) as {
        modules: Array<{
          short: string;
          uis: Array<{
            name: string;
            display_name: string;
            path: string;
            tagline: string | null;
            icon_url: string | null;
            version: string | null;
            oauth_client_id: string | null;
            status: string | null;
          }>;
        }>;
      };
      const vault = body.modules.find((m) => m.short === "vault");
      expect(vault?.uis).toEqual([
        {
          name: "default",
          display_name: "Default Vault",
          path: "/vault/default",
          tagline: null,
          icon_url: null,
          version: null,
          oauth_client_id: "client_v1",
          status: "active",
        },
        {
          name: "techne",
          display_name: "Techne",
          path: "/vault/techne",
          tagline: null,
          icon_url: null,
          version: null,
          oauth_client_id: null,
          status: "pending",
        },
      ]);
      // Other curated rows stay empty — uis is per-row, not global.
      const scribe = body.modules.find((m) => m.short === "scribe");
      expect(scribe?.uis).toEqual([]);
    });

    test("optional fields ride through verbatim, missing fields become null on the wire", async () => {
      writeManifest(h.manifestPath, [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.4.5",
          uis: {
            "full-fields": {
              displayName: "Full",
              tagline: "All set",
              path: "/vault/full",
              iconUrl: "/vault/full/icon.svg",
              version: "0.3.1",
              oauthClientId: "c1",
              status: "inactive",
            },
          },
        },
      ]);
      const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
      const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        fetchLatestVersion: async () => null,
      });
      const body = (await res.json()) as {
        modules: Array<{
          short: string;
          uis: Array<{
            name: string;
            display_name: string;
            path: string;
            tagline: string | null;
            icon_url: string | null;
            version: string | null;
            oauth_client_id: string | null;
            status: string | null;
          }>;
        }>;
      };
      const vault = body.modules.find((m) => m.short === "vault");
      expect(vault?.uis[0]).toEqual({
        name: "full-fields",
        display_name: "Full",
        path: "/vault/full",
        tagline: "All set",
        icon_url: "/vault/full/icon.svg",
        version: "0.3.1",
        oauth_client_id: "c1",
        status: "inactive",
      });
    });

    test("legacy `pending-oauth` / `disabled` status values normalize to canonical vocab on the wire (workstream F back-compat)", async () => {
      // Workstream F unifies the SPA / CLI / well-known state vocab onto
      // `active | pending | inactive | failing`. Old modules / SDKs may
      // still write the pre-F values to services.json (`pending-oauth`,
      // `disabled`). `services-manifest.ts` normalizes on read so every
      // downstream emit (this API, well-known doc) sees the canonical
      // form. Pins that boundary normalization end-to-end here.
      writeManifest(h.manifestPath, [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.4.5",
          uis: {
            legacy_pending: {
              displayName: "Legacy Pending",
              path: "/vault/legacy-pending",
              // biome-ignore lint/suspicious/noExplicitAny: deliberately
              // writing the pre-F legacy alias to pin the normalization
              // boundary; the schema accepts it on read.
              status: "pending-oauth" as any,
            },
            legacy_disabled: {
              displayName: "Legacy Disabled",
              path: "/vault/legacy-disabled",
              // biome-ignore lint/suspicious/noExplicitAny: same as above.
              status: "disabled" as any,
            },
          },
        },
      ]);
      const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
      const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
        db: h.db,
        issuer: ISSUER,
        manifestPath: h.manifestPath,
        fetchLatestVersion: async () => null,
      });
      const body = (await res.json()) as {
        modules: Array<{
          short: string;
          uis: Array<{ name: string; status: string | null }>;
        }>;
      };
      const vault = body.modules.find((m) => m.short === "vault");
      const pending = vault?.uis.find((u) => u.name === "legacy_pending");
      const inactive = vault?.uis.find((u) => u.name === "legacy_disabled");
      expect(pending?.status).toBe("pending");
      expect(inactive?.status).toBe("inactive");
    });
  });
});

describe("PUT /api/modules/channel — hub#275 channel toggle", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.cleanup());

  function putReq(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/api/modules/channel", {
      method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  test("405 on non-PUT", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CHANNEL_REQUIRED_SCOPE]);
    const res = await handleApiModulesChannel(
      new Request("http://localhost/api/modules/channel", {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}` },
      }),
      { db: h.db, issuer: ISSUER },
    );
    expect(res.status).toBe(405);
  });

  test("401 on missing bearer", async () => {
    const res = await handleApiModulesChannel(putReq({ channel: "rc" }), {
      db: h.db,
      issuer: ISSUER,
    });
    expect(res.status).toBe(401);
  });

  test("403 on bearer without parachute:host:admin", async () => {
    // `:host:auth` reads the GET catalog — it must NOT be allowed to
    // flip the install channel. Boundary matches install/upgrade/uninstall.
    const bearer = await mintBearer(h, ["parachute:host:auth"]);
    const res = await handleApiModulesChannel(
      putReq({ channel: "rc" }, { authorization: `Bearer ${bearer}` }),
      { db: h.db, issuer: ISSUER },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("insufficient_scope");
    expect(body.error_description).toContain("parachute:host:admin");
  });

  test("400 on malformed body (not JSON)", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CHANNEL_REQUIRED_SCOPE]);
    const res = await handleApiModulesChannel(
      putReq("not-json", { authorization: `Bearer ${bearer}` }),
      { db: h.db, issuer: ISSUER },
    );
    expect(res.status).toBe(400);
  });

  test("400 on invalid channel value", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CHANNEL_REQUIRED_SCOPE]);
    const res = await handleApiModulesChannel(
      putReq({ channel: "stable" }, { authorization: `Bearer ${bearer}` }),
      { db: h.db, issuer: ISSUER },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_channel");
    expect(body.error_description).toMatch(/latest, rc/);
  });

  test("400 on missing channel field", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CHANNEL_REQUIRED_SCOPE]);
    const res = await handleApiModulesChannel(
      putReq({ foo: "bar" }, { authorization: `Bearer ${bearer}` }),
      { db: h.db, issuer: ISSUER },
    );
    expect(res.status).toBe(400);
  });

  test("200 + writes the new channel to hub_settings", async () => {
    const bearer = await mintBearer(h, [API_MODULES_CHANNEL_REQUIRED_SCOPE]);
    const res = await handleApiModulesChannel(
      putReq({ channel: "rc" }, { authorization: `Bearer ${bearer}` }),
      { db: h.db, issuer: ISSUER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: string };
    expect(body.channel).toBe("rc");
    expect(getSetting(h.db, "module_install_channel")).toBe("rc");
  });

  test("200 + can toggle back to latest", async () => {
    setModuleInstallChannel(h.db, "rc");
    const bearer = await mintBearer(h, [API_MODULES_CHANNEL_REQUIRED_SCOPE]);
    const res = await handleApiModulesChannel(
      putReq({ channel: "latest" }, { authorization: `Bearer ${bearer}` }),
      { db: h.db, issuer: ISSUER },
    );
    expect(res.status).toBe(200);
    expect(getSetting(h.db, "module_install_channel")).toBe("latest");
  });
});
