import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetBootstrapTokenForTests, getBootstrapToken } from "../bootstrap-token.ts";
import {
  formatBootstrapTokenBanner,
  formatListeningBanner,
  resolveStartupIssuer,
  seedInitialAdminIfNeeded,
} from "../commands/serve.ts";
import { openHubDb } from "../hub-db.ts";
import { getUserByUsername, userCount } from "../users.ts";

describe("seedInitialAdminIfNeeded", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parachute-serve-"));
    dbPath = join(dir, "hub.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns 'needs-setup' on fresh state with no env vars", async () => {
    const db = openHubDb(dbPath);
    const result = await seedInitialAdminIfNeeded(db, {}, () => {});
    expect(result).toBe("needs-setup");
    expect(userCount(db)).toBe(0);
  });

  test("seeds an admin from PARACHUTE_INITIAL_ADMIN_* on fresh state", async () => {
    const db = openHubDb(dbPath);
    const log = mock<(line: string) => void>(() => {});
    const result = await seedInitialAdminIfNeeded(
      db,
      {
        PARACHUTE_INITIAL_ADMIN_USERNAME: "ops",
        PARACHUTE_INITIAL_ADMIN_PASSWORD: "correct horse battery staple",
      },
      log,
    );
    expect(result).toBe("seeded");
    expect(userCount(db)).toBe(1);
    // The log line carries the username so operators can grep container
    // logs to verify the seed fired.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0] ?? "").toContain("seeded initial admin");
    expect(log.mock.calls[0]?.[0] ?? "").toContain("ops");
    // Multi-user Phase 1 (design 2026-05-20-multi-user-phase-1.md §wizard
    // interaction): env-seeded admin chose their password via env vars, so
    // skip the force-change-password redirect. `assignedVaults` stays []
    // — admin posture (multi-user Phase 2 PR 2 lifted single → array).
    const seeded = getUserByUsername(db, "ops");
    expect(seeded?.passwordChanged).toBe(true);
    expect(seeded?.assignedVaults).toEqual([]);
  });

  test("returns 'exists' when an admin already exists, even with env vars set", async () => {
    // Seed once.
    const db = openHubDb(dbPath);
    await seedInitialAdminIfNeeded(
      db,
      {
        PARACHUTE_INITIAL_ADMIN_USERNAME: "ops",
        PARACHUTE_INITIAL_ADMIN_PASSWORD: "first-pw",
      },
      () => {},
    );

    // Same env on a second boot must NOT clobber the existing admin —
    // the seed is first-boot only. (Container restart with the env still
    // set from the Render dashboard is the canonical second-boot.)
    const result = await seedInitialAdminIfNeeded(
      db,
      {
        PARACHUTE_INITIAL_ADMIN_USERNAME: "ops",
        PARACHUTE_INITIAL_ADMIN_PASSWORD: "different-pw",
      },
      () => {},
    );
    expect(result).toBe("exists");
    expect(userCount(db)).toBe(1);
  });

  test("treats whitespace-only username as missing (needs-setup)", async () => {
    const db = openHubDb(dbPath);
    const result = await seedInitialAdminIfNeeded(
      db,
      {
        PARACHUTE_INITIAL_ADMIN_USERNAME: "   ",
        PARACHUTE_INITIAL_ADMIN_PASSWORD: "pw",
      },
      () => {},
    );
    expect(result).toBe("needs-setup");
    expect(userCount(db)).toBe(0);
  });

  test("requires both username and password — half-set env is needs-setup", async () => {
    const db = openHubDb(dbPath);
    const result = await seedInitialAdminIfNeeded(
      db,
      { PARACHUTE_INITIAL_ADMIN_USERNAME: "ops" },
      () => {},
    );
    expect(result).toBe("needs-setup");
    expect(userCount(db)).toBe(0);
  });
});

describe("formatListeningBanner", () => {
  const base = {
    port: 1939,
    configDir: "/home/op/.parachute",
    dbPath: "/home/op/.parachute/hub.db",
    issuer: undefined,
    adminBootstrap: "exists",
  };

  test("hostname 0.0.0.0 → display localhost + bound note", () => {
    // Chrome refuses to navigate to `0.0.0.0`, and mixing it with
    // `localhost` trips cross-origin errors. Operators paste the URL
    // straight from the banner, so the printed URL must be navigable.
    const line = formatListeningBanner({ ...base, hostname: "0.0.0.0" });
    expect(line).toContain("listening on http://localhost:1939");
    expect(line).toContain("(bound on all interfaces: 0.0.0.0:1939)");
    // The bind disclosure should sit between the URL and the contextual
    // PARACHUTE_HOME / db / issuer block, so an operator scanning the
    // banner sees the URL first and the bind note second.
    const urlIdx = line.indexOf("http://localhost:1939");
    const boundIdx = line.indexOf("(bound on all interfaces");
    const homeIdx = line.indexOf("PARACHUTE_HOME=");
    expect(urlIdx).toBeLessThan(boundIdx);
    expect(boundIdx).toBeLessThan(homeIdx);
  });

  test("hostname 127.0.0.1 (operator-chosen loopback) → display verbatim, no bound note", () => {
    const line = formatListeningBanner({ ...base, hostname: "127.0.0.1" });
    expect(line).toContain("listening on http://127.0.0.1:1939");
    expect(line).not.toContain("bound on all interfaces");
  });

  test("hostname 192.168.x.x (operator-chosen LAN IP) → display verbatim, no bound note", () => {
    const line = formatListeningBanner({ ...base, hostname: "192.168.1.10" });
    expect(line).toContain("listening on http://192.168.1.10:1939");
    expect(line).not.toContain("bound on all interfaces");
  });

  test("contextual block carries PARACHUTE_HOME, db, issuer, admin state", () => {
    const line = formatListeningBanner({
      ...base,
      hostname: "0.0.0.0",
      issuer: "https://hub.example.com",
      adminBootstrap: "seeded",
    });
    expect(line).toContain("PARACHUTE_HOME=/home/op/.parachute");
    expect(line).toContain("db=/home/op/.parachute/hub.db");
    expect(line).toContain("issuer=https://hub.example.com");
    expect(line).toContain("admin=seeded");
  });

  test("issuer undefined renders as <request-origin> placeholder", () => {
    const line = formatListeningBanner({ ...base, hostname: "0.0.0.0" });
    expect(line).toContain("issuer=<request-origin>");
  });
});

// --- bootstrap-token banner (first-boot-path hardening, Issue 1) ---------

describe("formatBootstrapTokenBanner", () => {
  test("includes the token verbatim, the wizard URL, and an expiry note", () => {
    const banner = formatBootstrapTokenBanner("parachute-bootstrap-sample-token-abc-123");
    expect(banner).toContain("parachute-bootstrap-sample-token-abc-123");
    expect(banner).toContain("/admin/setup");
    expect(banner).toContain("admin is created OR when hub restarts");
  });

  test("each line carries the `[wizard]` prefix so a log scanner can isolate the block", () => {
    const banner = formatBootstrapTokenBanner("parachute-bootstrap-x");
    for (const line of banner.split("\n")) {
      expect(line.startsWith("[wizard]")).toBe(true);
    }
  });

  test("uses ═ delimiters and an ALL-CAPS heading so operators spot the block in log viewers", () => {
    const banner = formatBootstrapTokenBanner("parachute-bootstrap-visual-token");
    // The ═ box-drawing char is the visual cue an operator scrolling
    // Render's log tab keys off; this assertion locks the new shape so
    // a stylistic regression doesn't silently demote the banner.
    expect(banner).toContain("═");
    expect(banner).toContain("PARACHUTE BOOTSTRAP TOKEN");
  });
});

// --- bootstrap-token generation under needs-setup (Issue 1 wiring) -------
//
// `seedInitialAdminIfNeeded` returns `needs-setup` when no admin row and
// no env vars; the wizard-mode boot path then mints + logs the token.
// These tests pin the wiring: when `needs-setup` fires, the token slot
// gets populated; when the env-seed path fires, the token slot stays
// undefined.

describe("bootstrap-token wiring under needs-setup", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parachute-serve-bootstrap-"));
    dbPath = join(dir, "hub.db");
    _resetBootstrapTokenForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    _resetBootstrapTokenForTests();
  });

  test("needs-setup branch: seedInitialAdminIfNeeded itself does NOT mint a token", async () => {
    // The token mint is in serve() — the surrounding fetch loop — not
    // in `seedInitialAdminIfNeeded`. This pins the helper's contract:
    // pure state inspection, no side effects beyond the admin row.
    // (The mint happens in the caller; covered by integration via the
    // hub-side gate tests that exercise the wizard against a generated
    // token.)
    const db = openHubDb(dbPath);
    const result = await seedInitialAdminIfNeeded(db, {}, () => {});
    expect(result).toBe("needs-setup");
    expect(getBootstrapToken()).toBeUndefined();
  });

  test("env-seed branch: no token generated by the seed helper", async () => {
    const db = openHubDb(dbPath);
    const result = await seedInitialAdminIfNeeded(
      db,
      {
        PARACHUTE_INITIAL_ADMIN_USERNAME: "ops",
        PARACHUTE_INITIAL_ADMIN_PASSWORD: "correct horse battery staple",
      },
      () => {},
    );
    expect(result).toBe("seeded");
    expect(getBootstrapToken()).toBeUndefined();
  });
});

describe("resolveStartupIssuer — precedence chain (hub#365)", () => {
  test("explicit opts.issuer wins over everything", () => {
    const got = resolveStartupIssuer(
      { issuer: "https://override.example" },
      {
        PARACHUTE_HUB_ORIGIN: "https://env.example",
        RENDER_EXTERNAL_URL: "https://render.example.onrender.com",
      },
    );
    expect(got).toBe("https://override.example");
  });

  test("PARACHUTE_HUB_ORIGIN wins over RENDER_EXTERNAL_URL", () => {
    const got = resolveStartupIssuer(
      {},
      {
        PARACHUTE_HUB_ORIGIN: "https://custom-domain.example",
        RENDER_EXTERNAL_URL: "https://parachute-hub.onrender.com",
      },
    );
    expect(got).toBe("https://custom-domain.example");
  });

  test("RENDER_EXTERNAL_URL is used when PARACHUTE_HUB_ORIGIN unset", () => {
    // The load-bearing case: operator clicks Deploy to Render, container
    // boots without an explicit PARACHUTE_HUB_ORIGIN (it doesn't yet
    // appear in render.yaml as a default), Render injects RENDER_EXTERNAL_URL
    // → hub picks it up automatically → supervised modules get the right
    // PARACHUTE_HUB_ORIGIN → vault's iss check passes on the first
    // authenticated request.
    const got = resolveStartupIssuer(
      {},
      { RENDER_EXTERNAL_URL: "https://parachute-hub.onrender.com" },
    );
    expect(got).toBe("https://parachute-hub.onrender.com");
  });

  test("strips trailing slashes from any source for canonical form", () => {
    expect(resolveStartupIssuer({ issuer: "https://x.example/" }, {})).toBe("https://x.example");
    expect(resolveStartupIssuer({ issuer: "https://x.example//" }, {})).toBe("https://x.example");
    expect(resolveStartupIssuer({}, { PARACHUTE_HUB_ORIGIN: "https://x.example/" })).toBe(
      "https://x.example",
    );
    expect(resolveStartupIssuer({}, { RENDER_EXTERNAL_URL: "https://x.example/" })).toBe(
      "https://x.example",
    );
  });

  test("returns undefined when no source has a value", () => {
    expect(resolveStartupIssuer({}, {})).toBeUndefined();
    expect(resolveStartupIssuer({}, { RENDER_EXTERNAL_URL: "" })).toBeUndefined();
    expect(resolveStartupIssuer({}, { PARACHUTE_HUB_ORIGIN: "" })).toBeUndefined();
  });

  test("empty string after slash-strip collapses to undefined (defensive)", () => {
    // `/` alone strips to empty string → `||` evaluates false → undefined.
    // Guards against a misconfigured env where someone sets the var to "/"
    // expecting it to mean "root" (it doesn't — leaves hub without a usable
    // origin, which is the same as not setting it at all).
    expect(resolveStartupIssuer({}, { PARACHUTE_HUB_ORIGIN: "/" })).toBeUndefined();
  });

  // Fly.io self-host path (patterns#100). resolveStartupIssuer is the
  // function that injects PARACHUTE_HUB_ORIGIN into every supervised module's
  // env. Without a Fly branch here, vault/scribe/app on Fly without a custom
  // domain get undefined → OAuth iss-mismatch on every token hub mints.
  test("FLY_APP_NAME composes https://<app>.fly.dev as fallback issuer", () => {
    const got = resolveStartupIssuer({}, { FLY_APP_NAME: "my-parachute" });
    expect(got).toBe("https://my-parachute.fly.dev");
  });

  test("PARACHUTE_HUB_ORIGIN wins over FLY_APP_NAME (operator with custom domain)", () => {
    const got = resolveStartupIssuer(
      {},
      {
        PARACHUTE_HUB_ORIGIN: "https://hub.example",
        FLY_APP_NAME: "my-parachute",
      },
    );
    expect(got).toBe("https://hub.example");
  });

  test("RENDER_EXTERNAL_URL wins over FLY_APP_NAME (pathological co-set)", () => {
    const got = resolveStartupIssuer(
      {},
      {
        RENDER_EXTERNAL_URL: "https://app.onrender.com",
        FLY_APP_NAME: "my-parachute",
      },
    );
    expect(got).toBe("https://app.onrender.com");
  });

  test("FLY_APP_NAME with slash rejected (defensive — Fly slugs don't contain /)", () => {
    expect(resolveStartupIssuer({}, { FLY_APP_NAME: "a/b" })).toBeUndefined();
    expect(resolveStartupIssuer({}, { FLY_APP_NAME: "../etc/passwd" })).toBeUndefined();
  });

  test("FLY_APP_NAME empty string → no fallback", () => {
    expect(resolveStartupIssuer({}, { FLY_APP_NAME: "" })).toBeUndefined();
  });
});
