import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  API_MODULES_CHANNEL_REQUIRED_SCOPE,
  API_MODULES_REQUIRED_SCOPE,
  _clearLatestVersionCacheForTests,
  handleApiModules,
  handleApiModulesChannel,
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
    // yet. UI must render "install vault / scribe" cards even though
    // nothing's installed. Trimmed 2026-05-27 (Aaron-directed launch
    // focus): notes (notes-daemon), surface (host module), and runner
    // (experimental) are no longer curated — notes.parachute.computer
    // is the hosted PWA, surface-client is the library for custom UI
    // builders, and runner isn't in the launch focus set.
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
    // Curated order is preserved: vault → scribe (vault first per the
    // recommended install order — the wizard's vault step already runs
    // before this catalog surfaces).
    expect(body.modules.map((m) => m.short)).toEqual(["vault", "scribe"]);
    expect(body.modules.every((m) => m.available)).toBe(true);
    expect(body.modules.every((m) => !m.installed)).toBe(true);
    expect(body.modules.every((m) => m.latest_version === "0.9.9")).toBe(true);
    // Supervisor wasn't injected → flag reflects that.
    expect(body.supervisor_available).toBe(false);
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

  test("uncurated modules (notes / runner / surface) are NOT returned by GET /api/modules", async () => {
    // CURATED_MODULES was trimmed 2026-05-27 to [vault, scribe]. The
    // KNOWN_MODULES + FIRST_PARTY_FALLBACKS registries still carry
    // entries for notes / runner (install-bootstrap path), but
    // /api/modules only returns CURATED rows. Pins the boundary so a
    // future re-curation has to be intentional, not a stale registry
    // leak.
    const bearer = await mintBearer(h, [API_MODULES_REQUIRED_SCOPE]);
    const res = await handleApiModules(getReq({ authorization: `Bearer ${bearer}` }), {
      db: h.db,
      issuer: ISSUER,
      manifestPath: h.manifestPath,
      fetchLatestVersion: async () => null,
    });
    const body = (await res.json()) as { modules: Array<{ short: string }> };
    const shorts = body.modules.map((m) => m.short);
    // Positive shape assertion — stronger than `not.toContain` because
    // it also catches "we accidentally added a new uncurated entry"
    // and "we accidentally removed an existing curated entry." Update
    // this assertion intentionally when CURATED_MODULES changes.
    expect(shorts).toEqual(["vault", "scribe"]);
    // Belt + suspenders: explicit negatives for the modules dropped
    // 2026-05-27, so a developer regressing the curated list sees both
    // the shape failure AND the named-module failure messages.
    expect(shorts).not.toContain("notes");
    expect(shorts).not.toContain("runner");
    expect(shorts).not.toContain("surface");
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

  test("populates management_url from a relative managementUrl + module mount (hub#342)", async () => {
    // Vault declares `managementUrl: "/admin"` in its module.json — hub
    // resolves that against the entry's mount path (`/vault/default`)
    // to produce the absolute admin URL the SPA's "Open" button targets.
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
    expect(vault?.management_url).toBe("/vault/default/admin");
  });

  test("management_url does not double-prepend mount when managementUrl is already mount-prefixed (hub#380)", async () => {
    // Audit caught 2026-05-25: surface declared `managementUrl: "/surface/admin/"`
    // (full hub-origin path) and `paths: ["/surface", "/.parachute"]`. The
    // SPA's Services dropdown was navigating to `/surface/surface/admin/`
    // (404) because api-modules unconditionally prepended the mount onto
    // the candidate. Fix: detect already-mount-prefixed paths and pass
    // through.
    //
    // Single-instance modules conventionally declare the full path; only
    // multi-instance modules (vault) use the per-instance relative form.
    // Post 2026-05-27 CURATED trim the canonical single-instance example
    // is scribe (when scribe ships a managementUrl — scribe#53). For now
    // we exercise the same code path with vault declaring an
    // already-mount-prefixed managementUrl: any module whose declared
    // URL starts with its mount must pass through unchanged.
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
            // Already-mount-prefixed managementUrl — must NOT have the
            // mount prepended again.
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

  test("management_url prefix-ish names don't collide (hub#380 — /app vs /app-foo)", async () => {
    // The detection uses `tail.startsWith(\`${mount}/\`)` with the trailing
    // slash specifically to avoid a false positive when a candidate
    // path looks like a sibling name (e.g. `/app-foo/admin` shouldn't be
    // treated as "already prefixed by /app"). Without the slash gate,
    // a future module named `app-foo` would silently inherit the
    // pass-through behavior and `/app` mount would skip its prepend.
    // Tests the trailing-slash discriminator stays load-bearing.
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
            // candidate looks like a sibling-name prefix but is NOT a
            // mount-prefix of /app — should still get prepended.
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
    // /surface + /app-foo/admin → /surface/app-foo/admin (prepend fires; not
    // treated as already-mount-prefixed because /app-foo/ doesn't start with /surface/).
    expect(vault?.management_url).toBe("/surface/app-foo/admin");
  });

  test("management_url equality edge: tail equals mount exactly (hub#380)", async () => {
    // mount=/foo, candidate=/foo → tail === mount → pass through unchanged.
    // Not a "real" config but pins the equality branch of the detection.
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
    const probe = async (
      _pkg: string,
      _channel: "latest" | "rc",
    ): Promise<string | null> => {
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
