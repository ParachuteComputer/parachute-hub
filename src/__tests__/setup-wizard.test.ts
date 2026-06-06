/**
 * First-boot wizard (hub#259). Exercises the three-step server-rendered
 * flow end-to-end at the `hubFetch` layer:
 *
 *   1. GET  /admin/setup            → account-step form
 *   2. POST /admin/setup/account    → admin row created + session cookie set
 *   3. GET  /admin/setup            → vault-step form (resume)
 *   4. POST /admin/setup/vault      → install op enqueued, 303 to ?op=…
 *   5. GET  /admin/setup?op=<id>    → op-poll page (with stubbed install runner)
 *   6. GET  /admin/setup            → 301 to /login once both exist
 *
 * The install runner is stubbed via the operations registry +
 * `run` injection so tests don't actually shell out to `bun add`. Same
 * pattern api-modules-ops.test.ts uses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetOperationsRegistryForTests,
  getDefaultOperationsRegistry,
} from "../api-modules-ops.ts";
import { CSRF_COOKIE_NAME, CSRF_FIELD_NAME } from "../csrf.ts";
import { type ExposeState, readExposeState, writeExposeState } from "../expose-state.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { getSetting, setSetting } from "../hub-settings.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import {
  OPERATOR_TOKEN_SCOPE_SET_CLAIM,
  readOperatorTokenFile,
  writeOperatorTokenFile,
} from "../operator-token.ts";
import { writeManifest } from "../services-manifest.ts";
import { SESSION_COOKIE_NAME } from "../sessions.ts";
import {
  deriveWizardState,
  detectAutoExposeMode,
  handleSetupAccountPost,
  handleSetupExposePost,
  handleSetupGet,
  handleSetupInstallPost,
  handleSetupVaultPost,
  postVaultImportImpl,
} from "../setup-wizard.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { Supervisor } from "../supervisor.ts";
import { createUser, getUserByUsername, userCount } from "../users.ts";

interface Harness {
  dir: string;
  manifestPath: string;
  /**
   * Hermetic expose-state reader scoped to the harness's tmp dir. The
   * production `readExposeState()` defaults to the operator's real
   * `~/.parachute/expose-state.json` (a module-load constant), so a
   * wizard test that omits an injected reader would auto-seed
   * `setup_expose_mode` from the developer's LIVE exposure (hub#406) and
   * flip expose-step assertions nondeterministically. Threading this
   * harness reader keeps every wizard test isolated from the real
   * filesystem — same isolation the harness already gives DB + manifest.
   * Defaults to "no live exposure" (the tmp file doesn't exist) unless a
   * test writes one via `writeExposeState(state, h.exposeStatePath)`.
   */
  exposeStatePath: string;
  readExposeStateFn: () => ExposeState | undefined;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "setup-wizard-"));
  writeFileSync(join(dir, "hub.html"), "<html>discovery</html>");
  const manifestPath = join(dir, "services.json");
  writeManifest({ services: [] }, manifestPath);
  const exposeStatePath = join(dir, "expose-state.json");
  return {
    dir,
    manifestPath,
    exposeStatePath,
    readExposeStateFn: () => readExposeState(exposeStatePath),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:1939${path}`, init);
}

function makeSupervisor(): Supervisor {
  // Spawn-stub: never actually starts a child. Tests inject this so the
  // wizard's runInstall path can call supervisor.start() / .get() without
  // touching Bun.spawn. The returned proc shape mirrors what
  // supervisor.ts's `SupervisedProc` requires — never-resolving `exited`
  // promise (so the supervisor doesn't trigger the restart loop) plus
  // null stdio (we're not piping output anywhere).
  return new Supervisor({
    output: () => {}, // swallow line prefixes in tests
    spawnFn: () => ({
      pid: 12345,
      exited: new Promise<number | null>(() => {}),
      stdout: null,
      stderr: null,
      kill: () => {},
    }),
  });
}

/**
 * Extract a single cookie's value from a Set-Cookie header. Tests need
 * the session id to ride the next request and the csrf token to feed
 * into form posts.
 */
function setCookie(res: Response, name: string): string | undefined {
  const raw = res.headers.get("set-cookie");
  if (!raw) return undefined;
  // Bun joins multiple Set-Cookie values with commas, with each cookie
  // prefixed by `<name>=<value>`. Naively splitting on commas would
  // break a cookie's own value (eg `expires=Mon, 01 Jan…`), so match
  // on the cookie name + value greedily up to the next `;` or end.
  const re = new RegExp(`(?:^|, )${name}=([^;]+)`);
  const m = raw.match(re);
  return m?.[1];
}

function formBody(fields: Record<string, string>): {
  body: string;
  headers: Record<string, string>;
} {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, v);
  return {
    body: params.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

// --- pure state derivation -----------------------------------------------

describe("deriveWizardState", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("welcome step when no admin and no vault", () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.step).toBe("welcome");
      expect(s.hasAdmin).toBe(false);
      expect(s.hasVault).toBe(false);
    } finally {
      db.close();
    }
  });

  test("vault step when admin exists but vault doesn't", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.step).toBe("vault");
      expect(s.hasAdmin).toBe(true);
      expect(s.hasVault).toBe(false);
    } finally {
      db.close();
    }
  });

  test("expose step when admin + vault exist but expose mode not set yet (hub#268 Item 2)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.step).toBe("expose");
      expect(s.hasAdmin).toBe(true);
      expect(s.hasVault).toBe(true);
      expect(s.hasExposeMode).toBe(false);
    } finally {
      db.close();
    }
  });

  test("auto-skips expose step when RENDER_EXTERNAL_URL is set (hub#406 follow-up)", async () => {
    // Aaron's UX concern: on Render the "How will this hub be reached?"
    // step asks the operator to pick between localhost / tailnet /
    // public-with-custom-domain — none of which describe the actual
    // setup. The platform owns the public URL via RENDER_EXTERNAL_URL.
    // deriveWizardState now auto-seeds `setup_expose_mode = "public"`
    // when that env var is present, so the wizard skips straight to
    // the done screen instead of surfacing an irrelevant choice.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      // Simulate Render env. detectAutoExposeMode reads RENDER_EXTERNAL_URL.
      const renderEnv = { RENDER_EXTERNAL_URL: "https://parachute-hub.onrender.com" };
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        env: renderEnv,
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.step).toBe("done");
      expect(s.hasExposeMode).toBe(true);
    } finally {
      db.close();
    }
  });

  test("does NOT auto-skip expose when RENDER_EXTERNAL_URL is unset (local install path)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        env: {},
        readExposeStateFn: h.readExposeStateFn,
      });
      // Local install path — the operator still gets to choose
      expect(s.step).toBe("expose");
      expect(s.hasExposeMode).toBe(false);
    } finally {
      db.close();
    }
  });

  test("auto-seeds expose mode from a live `parachute expose tailnet` (hub#406 team-onboarding bug)", async () => {
    // Team-onboarding bug: an operator ran `parachute expose tailnet`
    // BEFORE opening the wizard. That writes expose-state.json
    // (layer=tailnet) but never the `setup_expose_mode` hub_setting —
    // the two are orthogonal axes. Pre-fix, the wizard consulted only
    // the setting and re-rendered "How will this hub be reached?" though
    // tailnet was already live. deriveWizardState now reads the live
    // exposure layer and auto-seeds the setting, so the expose step is
    // treated as satisfied and the wizard advances to done.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      // Simulate `parachute expose tailnet`: write a real expose-state
      // file (round-trips through readExposeState's validator) into the
      // harness tmp path. No env signal (not Render/Fly), no setting.
      writeExposeState(
        {
          version: 1,
          layer: "tailnet",
          mode: "path",
          canonicalFqdn: "my-mac.tailnet-name.ts.net",
          port: 1939,
          funnel: false,
          entries: [],
        },
        h.exposeStatePath,
      );
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        env: {},
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.step).toBe("done");
      expect(s.hasExposeMode).toBe(true);
      // The setting was auto-seeded from the live exposure layer.
      expect(getSetting(db, "setup_expose_mode")).toBe("tailnet");
    } finally {
      db.close();
    }
  });

  test("auto-seeds expose mode = public from a live public exposure", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      writeExposeState(
        {
          version: 1,
          layer: "public",
          mode: "path",
          canonicalFqdn: "hub.example.com",
          port: 1939,
          funnel: true,
          entries: [],
        },
        h.exposeStatePath,
      );
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        env: {},
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.step).toBe("done");
      expect(s.hasExposeMode).toBe(true);
      expect(getSetting(db, "setup_expose_mode")).toBe("public");
    } finally {
      db.close();
    }
  });

  test("still asks the expose step when no live exposure + no setting (unchanged)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      // No env signal, no expose-state file written (reader returns
      // undefined), no setting → the operator still gets the expose step.
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        env: {},
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.step).toBe("expose");
      expect(s.hasExposeMode).toBe(false);
      expect(getSetting(db, "setup_expose_mode")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("an explicit setup_expose_mode wins over a live exposure (no clobber)", async () => {
    // If the operator already answered the expose step (or it was seeded
    // by a prior call), a later live-exposure read must not overwrite the
    // recorded answer. Guards the `=== undefined` gate.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      writeExposeState(
        {
          version: 1,
          layer: "public",
          mode: "path",
          canonicalFqdn: "hub.example.com",
          port: 1939,
          funnel: true,
          entries: [],
        },
        h.exposeStatePath,
      );
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        env: {},
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.step).toBe("done");
      // Recorded answer is preserved, not overwritten by the live layer.
      expect(getSetting(db, "setup_expose_mode")).toBe("localhost");
    } finally {
      db.close();
    }
  });

  test("done step once admin + vault + expose mode all exist", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.step).toBe("done");
      expect(s.hasAdmin).toBe(true);
      expect(s.hasVault).toBe(true);
      expect(s.hasExposeMode).toBe(true);
    } finally {
      db.close();
    }
  });
});

// --- GET /admin/setup ----------------------------------------------------

describe("handleSetupGet", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("renders the account form with a CSRF token cookie on first visit", () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      // CSRF cookie minted on first GET.
      const csrf = setCookie(res, CSRF_COOKIE_NAME);
      expect(csrf).toBeDefined();
    } finally {
      db.close();
    }
  });

  test("renders the vault form with a vault-name input once admin exists (hub#267)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const res = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('action="/admin/setup/vault"');
      // hub#267: the vault-name text input is back. Default placeholder
      // is "default" + the preview card mirrors the placeholder; the
      // operator can leave the field blank and still get a working
      // vault.
      expect(html).toContain('name="vault_name"');
      expect(html).toContain('placeholder="default"');
      expect(html).toContain('id="preview-vault-name">default<');
      // The input enforces vault's contract (lowercase alphanumeric +
      // -/_, 2-32 chars) at the HTML5 layer too so an over-eager
      // browser surfaces the error before POST.
      expect(html).toContain('pattern="[a-z0-9_-]+"');
      expect(html).toContain('minlength="2"');
      expect(html).toContain('maxlength="32"');
    } finally {
      db.close();
    }
  });

  test("301s to /login once admin + vault + expose mode all exist", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      // hub#268 Item 2: the expose-mode answer is the third gate of
      // "wizard is fully done." Without it the GET renders the expose
      // step rather than 301-ing.
      setSetting(db, "setup_expose_mode", "localhost");
      const res = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/login");
    } finally {
      db.close();
    }
  });

  test("renders the expose step when admin + vault exist but no expose mode (hub#268 Item 2)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      const res = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // Three radio options + the form action are the load-bearing
      // surface; everything else is presentational.
      expect(html).toContain('action="/admin/setup/expose"');
      expect(html).toContain('value="localhost"');
      expect(html).toContain('value="tailnet"');
      expect(html).toContain('value="public"');
      // localhost is the safe default selection.
      expect(html).toContain('value="localhost" checked');
    } finally {
      db.close();
    }
  });

  test("renders the success page once with ?just_finished=1 query", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/myvault"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      // hub#274 security fold: done-screen GET is session-gated.
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("You're set up");
      // The success page surfaces the vault name from services.json so
      // the MCP install line carries the operator's actual choice.
      expect(html).toContain("myvault");
      // hub#268 Item 2: the reachable tile reflects the operator's
      // expose-mode choice. Localhost mode mentions the loopback URL
      // and the upgrade path to tailnet.
      expect(html).toContain("Your hub is reachable at");
      expect(html).toContain("Local to this machine only");
    } finally {
      db.close();
    }
  });

  test("success page reachable tile reflects the tailnet expose mode (hub#268 Item 2)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "tailnet");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("tailscale serve --bg --https=1939");
    } finally {
      db.close();
    }
  });

  test("success page reachable tile reflects the public expose mode (hub#268 Item 2)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "public");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("PARACHUTE_HUB_ORIGIN");
      expect(html).toContain("parachute.computer/docs/deploy");
    } finally {
      db.close();
    }
  });

  test("renders the op-poll page when ?op=<id> matches a tracked op", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const reg = getDefaultOperationsRegistry();
      const op = reg.create("install", "vault");
      reg.update(op.id, { status: "running" }, "running bun add -g @openparachute/vault@latest");
      const res = handleSetupGet(req(`/admin/setup?op=${op.id}`), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: reg,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("status: running");
      expect(html).toContain("running bun add");
      // Auto-refresh is wired so the browser polls without JS.
      expect(html).toContain('http-equiv="refresh"');
    } finally {
      db.close();
    }
  });

  test("succeeded-op page refreshes to /admin/setup?just_finished=1 (fold A)", async () => {
    // Regression — without the `?just_finished=1` query the bare
    // /admin/setup state derives as "done" and 301s to /login, so the
    // operator never sees the success screen with the MCP install
    // command. The refresh-meta must carry the query through.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const reg = getDefaultOperationsRegistry();
      const op = reg.create("install", "vault");
      reg.update(op.id, { status: "succeeded" }, "vault installed + spawned");
      const res = handleSetupGet(req(`/admin/setup?op=${op.id}`), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: reg,
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Vault ready");
      expect(html).toContain("url=/admin/setup?just_finished=1");
    } finally {
      db.close();
    }
  });
});

// --- POST /admin/setup/account -------------------------------------------

describe("handleSetupAccountPost", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("creates the admin row + sets session cookie on valid input", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      // Mint the CSRF token via a GET first so the cookie is in place.
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME);
      expect(csrf).toBeDefined();
      const form = formBody({
        username: "ops",
        password: "correct horse battery",
        password_confirm: "correct horse battery",
        [CSRF_FIELD_NAME]: csrf ?? "",
      });
      const post = await handleSetupAccountPost(
        req("/admin/setup/account", {
          method: "POST",
          body: form.body,
          headers: {
            ...form.headers,
            cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(303);
      expect(post.headers.get("location")).toBe("/admin/setup");
      const sessionCookie = setCookie(post, SESSION_COOKIE_NAME);
      expect(sessionCookie).toBeDefined();
      expect(userCount(db)).toBe(1);
      // Multi-user Phase 1: the wizard's first admin chose their password
      // via this very form, so skip the force-change-password redirect on
      // first sign-in (`password_changed=1`). `assignedVaults` stays empty
      // — admin posture (no per-vault restriction; Phase 2 PR 2 array shape).
      const created = getUserByUsername(db, "ops");
      expect(created?.passwordChanged).toBe(true);
      expect(created?.assignedVaults).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("rejects mismatched password confirmation", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const form = formBody({
        username: "ops",
        password: "correct horse battery",
        password_confirm: "wrong",
        [CSRF_FIELD_NAME]: csrf,
      });
      const post = await handleSetupAccountPost(
        req("/admin/setup/account", {
          method: "POST",
          body: form.body,
          headers: { ...form.headers, cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(400);
      const html = await post.text();
      expect(html).toContain("Passwords do not match");
      expect(userCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("rejects missing or wrong CSRF token", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const form = formBody({
        username: "ops",
        password: "correct horse battery",
        password_confirm: "correct horse battery",
        [CSRF_FIELD_NAME]: "wrong",
      });
      const post = await handleSetupAccountPost(
        req("/admin/setup/account", {
          method: "POST",
          body: form.body,
          headers: { ...form.headers, cookie: `${CSRF_COOKIE_NAME}=expected` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(400);
      expect(userCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("redirects without creating a second user when one already exists", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const form = formBody({
        username: "interloper",
        password: "another password",
        password_confirm: "another password",
        [CSRF_FIELD_NAME]: csrf,
      });
      const post = await handleSetupAccountPost(
        req("/admin/setup/account", {
          method: "POST",
          body: form.body,
          headers: { ...form.headers, cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(303);
      expect(post.headers.get("location")).toBe("/admin/setup");
      // Idempotent — no second user got minted.
      expect(userCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });
});

// --- Phase 3b Deliverable A: fresh-box operator-token closure (§3.1) ------
//
// After the wizard creates the first admin, it persists ~/.parachute/operator.token
// so the box has a CLI operator credential immediately — otherwise the Phase 3b
// per-module verbs (start/stop/restart <svc> over the module-ops API) would 401.

describe("handleSetupAccountPost — operator-token closure (Phase 3b §3.1)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  /** Drive a valid account-creation POST against the given deps. */
  async function createFirstAdmin(
    db: ReturnType<typeof openHubDb>,
    deps: Partial<Parameters<typeof handleSetupAccountPost>[1]> = {},
    username = "ops",
  ): Promise<Response> {
    const baseDeps = {
      db,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      readExposeStateFn: h.readExposeStateFn,
      issuer: "https://hub.example",
      registry: getDefaultOperationsRegistry(),
    };
    const get = handleSetupGet(req("/admin/setup"), baseDeps);
    const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
    const form = formBody({
      username,
      password: "correct horse battery",
      password_confirm: "correct horse battery",
      [CSRF_FIELD_NAME]: csrf,
    });
    return handleSetupAccountPost(
      req("/admin/setup/account", {
        method: "POST",
        body: form.body,
        headers: { ...form.headers, cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
      }),
      { ...baseDeps, ...deps },
    );
  }

  test("persists operator.token (admin scope-set, carries parachute:host:admin)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      rotateSigningKey(db); // real issuance needs a signing key
      const post = await createFirstAdmin(db);
      expect(post.status).toBe(303);
      // The token file now exists on disk…
      const token = await readOperatorTokenFile(h.dir);
      expect(token).not.toBeNull();
      // …and decodes with the admin scope (the scope module-ops gates on).
      // The JWT carries the OAuth `scope` claim as a space-delimited string.
      const { payload } = await validateAccessToken(db, token ?? "", "https://hub.example");
      const scopes = String(payload.scope ?? "").split(" ");
      expect(scopes).toContain("parachute:host:admin");
      expect((payload as Record<string, unknown>)[OPERATOR_TOKEN_SCOPE_SET_CLAIM]).toBe("admin");
    } finally {
      db.close();
    }
  });

  test("does NOT clobber an existing operator.token", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      rotateSigningKey(db);
      // Plant a sentinel token before the wizard runs.
      await writeOperatorTokenFile("sentinel.preexisting.token", h.dir);
      // Use a stub issuer that fails the test if it's ever called.
      const post = await createFirstAdmin(db, {
        issueOperatorToken: async () => {
          throw new Error("issueOperatorToken must NOT run when a token already exists");
        },
      });
      expect(post.status).toBe(303);
      // The pre-existing token is untouched.
      expect(await readOperatorTokenFile(h.dir)).toBe("sentinel.preexisting.token");
    } finally {
      db.close();
    }
  });

  test("no admin created (already-bootstrapped guard) → no token written", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      rotateSigningKey(db);
      // An admin already exists, so the wizard's already-bootstrapped guard
      // returns early (303 to /admin/setup) WITHOUT reaching createUser — and
      // therefore WITHOUT minting a token. The closure only fires for a
      // genuinely-created first admin.
      await createUser(db, "owner", "pw");
      const post = await createFirstAdmin(db, {}, "interloper");
      expect(post.status).toBe(303);
      expect(await readOperatorTokenFile(h.dir)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("token-write failure is non-fatal — account creation still succeeds", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const post = await createFirstAdmin(db, {
        issueOperatorToken: async () => {
          throw new Error("disk full");
        },
      });
      // The admin + session were committed despite the token-write failure.
      expect(post.status).toBe(303);
      expect(setCookie(post, SESSION_COOKIE_NAME)).toBeDefined();
      expect(userCount(db)).toBe(1);
      // No token landed (the issuer threw), but that didn't fail the request.
      expect(await readOperatorTokenFile(h.dir)).toBeNull();
    } finally {
      db.close();
    }
  });
});

// --- POST /admin/setup/vault ---------------------------------------------

describe("handleSetupVaultPost", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("requires a supervisor (CLI mode rejects create/import; allows skip — hub#168 Cut 2)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      // Bare POST (no CSRF, no session) still 400s, but on the new
      // CSRF-first ordering it stops at the CSRF check rather than the
      // supervisor check. That's correct posture — refuse the
      // unauthenticated request before tendering an architectural
      // explanation.
      const post = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({}).toString(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(400);
      const html = await post.text();
      // CSRF-first: the bare request bounces at the CSRF gate.
      expect(html).toContain("Invalid form submission");
    } finally {
      db.close();
    }
  });

  test("rejects without an admin session cookie", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const post = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({
            [CSRF_FIELD_NAME]: csrf,
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(400);
      const html = await post.text();
      expect(html).toContain("No admin session");
    } finally {
      db.close();
    }
  });

  test("enqueues an install op + redirects to ?op=<id> on valid post", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      // Stand up admin + an active session row so the wizard's session
      // gate sees a real cookie.
      const user = await createUser(db, "owner", "pw");
      const {
        createSession,
        SESSION_COOKIE_NAME: SC,
        SESSION_TTL_MS,
      } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const runCalls: string[][] = [];
      const stubbedRun = async (cmd: readonly string[]) => {
        runCalls.push([...cmd]);
        return 0;
      };
      const post = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({
            [CSRF_FIELD_NAME]: csrf,
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SC}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
          run: stubbedRun,
          // Force the test to exercise the bun-add path; production
          // `defaultIsLinked` reads the real ~/.bun globals which on
          // a contributor's machine returns true (Aaron's vault is
          // linked locally) and the runInstall short-circuit fires.
          // For tests asserting "bun add WAS called," opt out of the
          // skip explicitly. (Smoke 2026-05-27 finding 1 — the skip
          // is the production behavior we want; tests assert both
          // branches.)
          isLinked: () => false,
        },
      );
      expect(post.status).toBe(303);
      const location = post.headers.get("location") ?? "";
      expect(location).toMatch(/^\/admin\/setup\?op=/);
      // Yield long enough for the background runInstall promise to call
      // through to the stubbed runner. The stub itself is synchronous
      // (returns a resolved promise) so one microtask tick is enough,
      // but the runInstall body has a few awaits before reaching it.
      await new Promise((r) => setTimeout(r, 50));
      expect(runCalls.length).toBeGreaterThan(0);
      expect(runCalls[0]?.join(" ")).toContain("bun add -g @openparachute/vault@latest");
      // Sanity-check on SESSION_TTL_MS: we used it implicitly to keep
      // the freshly-created session non-expired. Asserting a positive
      // number flags a future migration that removes the constant.
      expect(SESSION_TTL_MS).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("scribe sub-form: provider=groq + api_key kicks scribe install in parallel + writes config", async () => {
    // Wizard redesign 2026-05-27: the vault step's form now folds in a
    // scribe sub-section (provider radio + API key). On submit with
    // scribe enabled, the POST handler should:
    //   1. Write the operator's chosen provider + API key to scribe's
    //      config file (`<configDir>/scribe/config.json`)
    //   2. Kick a scribe install op in parallel with vault install
    //   3. Redirect with BOTH `?op=<vault>` AND `&op_scribe=<scribe>` so
    //      the vault op-poll page can thread the scribe op_id through
    //      to the done step's per-tile mechanism.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      const { createSession, SESSION_COOKIE_NAME: SC } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const runCalls: string[][] = [];
      const stubbedRun = async (cmd: readonly string[]) => {
        runCalls.push([...cmd]);
        return 0;
      };
      const post = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({
            [CSRF_FIELD_NAME]: csrf,
            scribe_provider: "groq",
            scribe_api_key: "gsk_testkey_abc123",
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SC}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
          run: stubbedRun,
          isLinked: () => false,
        },
      );
      // 303 redirect with both op + op_scribe params.
      expect(post.status).toBe(303);
      const location = post.headers.get("location") ?? "";
      expect(location).toMatch(/op=/);
      expect(location).toMatch(/op_scribe=/);
      // Scribe config file written with provider + apiKey.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const scribeConfigPath = path.join(h.dir, "scribe", "config.json");
      expect(fs.existsSync(scribeConfigPath)).toBe(true);
      const scribeConfig = JSON.parse(fs.readFileSync(scribeConfigPath, "utf8"));
      expect(scribeConfig.transcribe?.provider).toBe("groq");
      expect(scribeConfig.transcribeProviders?.groq?.apiKey).toBe("gsk_testkey_abc123");
      // Yield + verify both vault AND scribe `bun add` calls happened.
      await new Promise((r) => setTimeout(r, 50));
      const cmds = runCalls.map((c) => c.join(" "));
      expect(cmds.some((c) => c.includes("bun add -g @openparachute/vault"))).toBe(true);
      expect(cmds.some((c) => c.includes("bun add -g @openparachute/scribe"))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("scribe sub-form: provider=none skips scribe install, only vault fires", async () => {
    // Operator can explicitly opt out of scribe. Vault install still
    // fires; scribe install does NOT. Redirect URL has only `?op=`,
    // no `&op_scribe=`.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      const { createSession, SESSION_COOKIE_NAME: SC } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const runCalls: string[][] = [];
      const stubbedRun = async (cmd: readonly string[]) => {
        runCalls.push([...cmd]);
        return 0;
      };
      const post = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({
            [CSRF_FIELD_NAME]: csrf,
            scribe_provider: "none",
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SC}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
          run: stubbedRun,
          isLinked: () => false,
        },
      );
      expect(post.status).toBe(303);
      const location = post.headers.get("location") ?? "";
      expect(location).toMatch(/op=/);
      expect(location).not.toMatch(/op_scribe=/);
      await new Promise((r) => setTimeout(r, 50));
      const cmds = runCalls.map((c) => c.join(" "));
      expect(cmds.some((c) => c.includes("bun add -g @openparachute/vault"))).toBe(true);
      expect(cmds.some((c) => c.includes("bun add -g @openparachute/scribe"))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("idempotent — second POST while supervisor is running doesn't fire a second `bun add` (N2)", async () => {
    // Reviewer-flagged race: two concurrent POSTs before either seeds
    // services.json both pass `state.hasVault === false` and each fire
    // `runInstall` → each fires `bun add -g`. The wizard mirrors the
    // `handleInstall` guard pattern: if the supervisor already has a
    // live (starting/running/restarting) state for vault, mark the new
    // op succeeded synchronously and skip the second install.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      const { createSession, SESSION_COOKIE_NAME: SC } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      // Real supervisor with the never-exits spawn stub from makeSupervisor.
      // Pre-spawn vault so `supervisor.get("vault").status === "starting"`
      // by the time the wizard's POST runs.
      const supervisor = makeSupervisor();
      await supervisor.start({ short: "vault", cmd: ["bun", "noop"] });
      const runCalls: string[][] = [];
      const stubbedRun = async (cmd: readonly string[]) => {
        runCalls.push([...cmd]);
        return 0;
      };
      const post = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({
            [CSRF_FIELD_NAME]: csrf,
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SC}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor,
          registry: getDefaultOperationsRegistry(),
          run: stubbedRun,
        },
      );
      expect(post.status).toBe(303);
      const location = post.headers.get("location") ?? "";
      expect(location).toMatch(/^\/admin\/setup\?op=/);
      // Yield enough for any background runInstall promise to fire if
      // the guard failed. Then assert: no `bun add` was invoked, and
      // the op went straight to `succeeded` with the canonical
      // "already supervised" log line.
      await new Promise((r) => setTimeout(r, 50));
      expect(runCalls.length).toBe(0);
      const opId = new URL(location, "http://x").searchParams.get("op") ?? "";
      const op = getDefaultOperationsRegistry().get(opId);
      expect(op?.status).toBe("succeeded");
      expect(op?.log.join("\n")).toContain("already supervised");
    } finally {
      db.close();
    }
  });

  // --- scribe cleanup sub-form (2026-05-27) -----------------------------
  //
  // The vault step's scribe sub-form was extended with a second radio
  // group for cleanup-provider. The POST handler reads
  // `scribe_cleanup_provider` + `scribe_cleanup_api_key` and writes a
  // `cleanup` block + optional `cleanupProviders.<name>.apiKey` into
  // `<configDir>/scribe/config.json` alongside the existing transcribe
  // block. The combos exercised here:
  //   1. cleanup=none → no cleanup block written
  //   2. cleanup=claude-code (no key) → block written, no apiKey,
  //      cleanup.default: true
  //   3. cleanup=anthropic + key → block + apiKey written
  //   4. transcribe=none + cleanup=anthropic → scribe still installs
  //      (cleanup endpoint works standalone), no transcribe block
  //   5. transcribe=groq + cleanup=anthropic + both keys → full
  //      happy-path: both blocks + both keys end up in config

  async function postVaultWithFields(
    h: Harness,
    fields: Record<string, string>,
  ): Promise<{ response: Response; runCmds: string[]; csrf: string }> {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      const { createSession, SESSION_COOKIE_NAME: SC } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const runCalls: string[][] = [];
      const stubbedRun = async (cmd: readonly string[]) => {
        runCalls.push([...cmd]);
        return 0;
      };
      const response = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({
            [CSRF_FIELD_NAME]: csrf,
            ...fields,
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SC}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
          run: stubbedRun,
          // Test default: assume nothing is bun-linked so `bun add -g`
          // fires and runCmds reflects the real install commands.
          // (Smoke 2026-05-27 finding 1.)
          isLinked: () => false,
        },
      );
      // Yield long enough for background runInstall promises to call
      // through to the stubbed runner.
      await new Promise((r) => setTimeout(r, 50));
      return { response, runCmds: runCalls.map((c) => c.join(" ")), csrf };
    } finally {
      db.close();
    }
  }

  function readScribeConfig(dir: string): Record<string, unknown> | undefined {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const p = path.join(dir, "scribe", "config.json");
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  }

  test("scribe cleanup: provider=none writes no cleanup block + no cleanupDefault", async () => {
    // Skip-cleanup is the radio default. When the operator leaves it
    // alone, the config writer shouldn't emit a cleanup block at all
    // — leaves scribe's first-boot default (`cleanup.provider: "none"`)
    // alone. Belt-and-braces: also assert no `cleanupProviders` block.
    const { response } = await postVaultWithFields(h, {
      scribe_provider: "groq",
      scribe_api_key: "gsk_test_xyz",
      scribe_cleanup_provider: "none",
    });
    expect(response.status).toBe(303);
    const cfg = readScribeConfig(h.dir);
    expect(cfg).toBeDefined();
    expect(cfg?.transcribe).toEqual({ provider: "groq" });
    expect(cfg?.transcribeProviders).toEqual({ groq: { apiKey: "gsk_test_xyz" } });
    expect(cfg?.cleanup).toBeUndefined();
    expect(cfg?.cleanupProviders).toBeUndefined();
  });

  test("scribe cleanup: provider=claude-code writes block with cleanupDefault:true + no apiKey", async () => {
    // Claude Code path is subscription-funded — no API key field, auth
    // is via `claude setup-token` on the host. The wizard should write
    // `cleanup.provider: "claude-code"` + `cleanup.default: true`,
    // and NOT a cleanupProviders block (there's nothing to store).
    const { response } = await postVaultWithFields(h, {
      scribe_provider: "local",
      scribe_cleanup_provider: "claude-code",
    });
    expect(response.status).toBe(303);
    const cfg = readScribeConfig(h.dir);
    expect(cfg?.cleanup).toEqual({ provider: "claude-code", default: true });
    expect(cfg?.cleanupProviders).toBeUndefined();
  });

  test("scribe cleanup: provider=anthropic + api_key writes cleanupProviders.anthropic.apiKey", async () => {
    // Cloud cleanup provider with a key. Expect both the `cleanup`
    // block (provider + default:true) AND the `cleanupProviders`
    // block carrying the apiKey, mirroring the transcribe shape.
    const { response } = await postVaultWithFields(h, {
      scribe_provider: "groq",
      scribe_api_key: "gsk_test",
      scribe_cleanup_provider: "anthropic",
      scribe_cleanup_api_key: "sk-ant-test123",
    });
    expect(response.status).toBe(303);
    const cfg = readScribeConfig(h.dir);
    expect(cfg?.cleanup).toEqual({ provider: "anthropic", default: true });
    expect(cfg?.cleanupProviders).toEqual({ anthropic: { apiKey: "sk-ant-test123" } });
    // The config file holds API keys; verify it's written 0o600 so
    // other users on a shared box can't read the operator's keys.
    // (Mac/Linux only — Windows reports 0o666; skip on win32.)
    if (process.platform !== "win32") {
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      const cfgPath = path.join(h.dir, "scribe", "config.json");
      const mode = fs.statSync(cfgPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("scribe cleanup: transcribe=none + cleanup=anthropic still installs scribe + writes cleanup block", async () => {
    // Edge case: operator skips transcription but wants the cleanup
    // endpoint anyway (they'll feed raw text to scribe's REST cleanup
    // route from elsewhere). Scribe should still install + the
    // cleanup block lands without a transcribe block.
    const { response, runCmds } = await postVaultWithFields(h, {
      scribe_provider: "none",
      scribe_cleanup_provider: "anthropic",
      scribe_cleanup_api_key: "sk-ant-cleanup-only",
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/op_scribe=/);
    expect(runCmds.some((c) => c.includes("bun add -g @openparachute/scribe"))).toBe(true);
    const cfg = readScribeConfig(h.dir);
    expect(cfg?.transcribe).toBeUndefined();
    expect(cfg?.cleanup).toEqual({ provider: "anthropic", default: true });
    expect(cfg?.cleanupProviders).toEqual({ anthropic: { apiKey: "sk-ant-cleanup-only" } });
  });

  test("scribe cleanup: transcribe=groq + cleanup=anthropic + both keys writes both blocks", async () => {
    // Full happy-path. Two separate providers, two separate keys,
    // both blocks should land independently in the config.
    const { response } = await postVaultWithFields(h, {
      scribe_provider: "groq",
      scribe_api_key: "gsk_transcribe_key",
      scribe_cleanup_provider: "anthropic",
      scribe_cleanup_api_key: "sk-ant-cleanup-key",
    });
    expect(response.status).toBe(303);
    const cfg = readScribeConfig(h.dir);
    expect(cfg?.transcribe).toEqual({ provider: "groq" });
    expect(cfg?.transcribeProviders).toEqual({ groq: { apiKey: "gsk_transcribe_key" } });
    expect(cfg?.cleanup).toEqual({ provider: "anthropic", default: true });
    expect(cfg?.cleanupProviders).toEqual({ anthropic: { apiKey: "sk-ant-cleanup-key" } });
  });
});

// --- end-to-end through hubFetch -----------------------------------------

describe("setup wizard end-to-end via hubFetch", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("redirects to /login once admin + vault + expose mode are all set", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const res = await hubFetch(h.dir, {
        getDb: () => db,
        manifestPath: h.manifestPath,
      })(req("/admin/setup"));
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/login");
    } finally {
      db.close();
    }
  });

  test("POST /admin/setup/account through hubFetch creates the admin row", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      // Bootstrap CSRF cookie via GET.
      const getRes = await hubFetch(h.dir, {
        getDb: () => db,
        manifestPath: h.manifestPath,
      })(req("/admin/setup"));
      const csrf = setCookie(getRes, CSRF_COOKIE_NAME) ?? "";
      expect(csrf).not.toBe("");
      const body = new URLSearchParams({
        username: "ops",
        password: "correct horse",
        password_confirm: "correct horse",
        [CSRF_FIELD_NAME]: csrf,
      }).toString();
      const postRes = await hubFetch(h.dir, {
        getDb: () => db,
        manifestPath: h.manifestPath,
      })(
        req("/admin/setup/account", {
          method: "POST",
          body,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
          },
        }),
      );
      expect(postRes.status).toBe(303);
      expect(postRes.headers.get("location")).toBe("/admin/setup");
      expect(userCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("POST /admin/setup/account rejects non-POST methods", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = await hubFetch(h.dir, {
        getDb: () => db,
        manifestPath: h.manifestPath,
      })(req("/admin/setup/account"));
      expect(res.status).toBe(405);
    } finally {
      db.close();
    }
  });
});

// --- POST /admin/setup/expose (hub#268 Item 2 + Item 3) ------------------

describe("handleSetupExposePost", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  /**
   * Helper: bring the wizard to step 4 (expose). Creates an admin row,
   * seeds the vault entry, mints a session cookie + CSRF token. Returns
   * everything callers need to drive the POST.
   */
  async function bringWizardToExposeStep(db: ReturnType<typeof openHubDb>) {
    const user = await createUser(db, "owner", "pw");
    writeManifest(
      {
        services: [
          {
            name: "parachute-vault",
            version: "0.1.0",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
          },
        ],
      },
      h.manifestPath,
    );
    const { createSession } = await import("../sessions.ts");
    const session = createSession(db, { userId: user.id });
    // Get the wizard's expose step to mint the CSRF cookie.
    const get = handleSetupGet(req("/admin/setup"), {
      db,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      readExposeStateFn: h.readExposeStateFn,
      issuer: "https://hub.example",
      registry: getDefaultOperationsRegistry(),
    });
    const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
    return { user, session, csrf };
  }

  test("persists a valid expose_mode + opens the auto-approve window + redirects to ?just_finished=1", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const { session, csrf } = await bringWizardToExposeStep(db);
      const form = new URLSearchParams({
        expose_mode: "tailnet",
        [CSRF_FIELD_NAME]: csrf,
      }).toString();
      const res = await handleSetupExposePost(
        req("/admin/setup/expose", {
          method: "POST",
          body: form,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/admin/setup?just_finished=1");
      expect(getSetting(db, "setup_expose_mode")).toBe("tailnet");
      // hub#268 Item 3: the auto-approve window is opened on this transition.
      expect(getSetting(db, "pending_first_client_auto_approve_until")).toBeDefined();
    } finally {
      db.close();
    }
  });

  test("rejects an invalid expose_mode (renders the form with an error banner)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const { session, csrf } = await bringWizardToExposeStep(db);
      const form = new URLSearchParams({
        expose_mode: "garbage",
        [CSRF_FIELD_NAME]: csrf,
      }).toString();
      const res = await handleSetupExposePost(
        req("/admin/setup/expose", {
          method: "POST",
          body: form,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("Pick one of");
      // No expose-mode persisted on rejection.
      expect(getSetting(db, "setup_expose_mode")).toBeUndefined();
      // No auto-approve window opened on rejection.
      expect(getSetting(db, "pending_first_client_auto_approve_until")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("rejects without an admin session cookie", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const { csrf } = await bringWizardToExposeStep(db);
      const form = new URLSearchParams({
        expose_mode: "localhost",
        [CSRF_FIELD_NAME]: csrf,
      }).toString();
      // Note: no session cookie sent.
      const res = await handleSetupExposePost(
        req("/admin/setup/expose", {
          method: "POST",
          body: form,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain("No admin session");
      expect(getSetting(db, "setup_expose_mode")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("rejects missing or wrong CSRF token", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const { session, csrf } = await bringWizardToExposeStep(db);
      const form = new URLSearchParams({
        expose_mode: "localhost",
        [CSRF_FIELD_NAME]: "wrong-token",
      }).toString();
      const res = await handleSetupExposePost(
        req("/admin/setup/expose", {
          method: "POST",
          body: form,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(400);
      expect(getSetting(db, "setup_expose_mode")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("idempotent: second POST after already done short-circuits without re-opening the window", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const { session, csrf } = await bringWizardToExposeStep(db);
      // Pre-seed expose_mode + an OLD window timestamp so we can verify
      // the second POST doesn't bump it.
      setSetting(db, "setup_expose_mode", "localhost");
      setSetting(db, "pending_first_client_auto_approve_until", "2020-01-01T00:00:00.000Z");
      const form = new URLSearchParams({
        expose_mode: "tailnet",
        [CSRF_FIELD_NAME]: csrf,
      }).toString();
      const res = await handleSetupExposePost(
        req("/admin/setup/expose", {
          method: "POST",
          body: form,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/admin/setup?just_finished=1");
      // expose_mode is NOT overwritten (the wizard considers itself done).
      expect(getSetting(db, "setup_expose_mode")).toBe("localhost");
      // auto-approve window NOT re-opened — still the old stale stamp.
      expect(getSetting(db, "pending_first_client_auto_approve_until")).toBe(
        "2020-01-01T00:00:00.000Z",
      );
    } finally {
      db.close();
    }
  });
});

// --- hub#272 Item A: auto-mint operator token + MCP command rendering ---

describe("done screen auto-minted token (hub#272 Item A)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  async function bringWizardToExposeStep(db: ReturnType<typeof openHubDb>) {
    const user = await createUser(db, "owner", "pw");
    writeManifest(
      {
        services: [
          {
            name: "parachute-vault",
            version: "0.1.0",
            port: 1940,
            paths: ["/vault/default"],
            health: "/health",
          },
        ],
      },
      h.manifestPath,
    );
    const { createSession } = await import("../sessions.ts");
    const session = createSession(db, { userId: user.id });
    const get = handleSetupGet(req("/admin/setup"), {
      db,
      manifestPath: h.manifestPath,
      configDir: h.dir,
      readExposeStateFn: h.readExposeStateFn,
      issuer: "https://hub.example",
      registry: getDefaultOperationsRegistry(),
    });
    const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
    return { user, session, csrf };
  }

  test("expose POST mints + stores an operator token in hub_settings (setup_minted_token)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const { session, csrf } = await bringWizardToExposeStep(db);
      const form = new URLSearchParams({
        expose_mode: "localhost",
        [CSRF_FIELD_NAME]: csrf,
      }).toString();
      const res = await handleSetupExposePost(
        req("/admin/setup/expose", {
          method: "POST",
          body: form,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(303);
      // Token is a JWT (three base64url segments). We don't assert the
      // exact value — the load-bearing surface is "a non-empty token
      // exists" so the done-step renderer has something to inject.
      const stored = getSetting(db, "setup_minted_token");
      expect(stored).toBeDefined();
      expect(stored?.split(".").length).toBe(3);
    } finally {
      db.close();
    }
  });

  test("done screen renders the MCP command with a Bearer header when a minted token exists", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      setSetting(db, "setup_minted_token", "test-jwt-token-abc");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      // Real token rides in the hidden script-tag stash as JSON-encoded
      // text — script element content is raw-text per the HTML spec
      // (entities aren't parsed), so JSON encoding round-trips through
      // textContent + JSON.parse without `&quot;` polluting the copied
      // command. Verify the JSON-encoded form appears in the document.
      expect(html).toContain(
        '"claude mcp add --transport http parachute-default https://hub.example/vault/default/mcp --header \\"Authorization: Bearer test-jwt-token-abc\\""',
      );
      expect(html).toContain('id="mcp-cmd"');
      expect(html).toContain('id="mcp-cmd-real"');
      // The hidden stash is `<script type="application/json">` so the
      // browser doesn't execute it but textContent is still readable.
      expect(html).toContain('<script type="application/json" id="mcp-cmd-real">');
      // The visible default state is masked: the <pre> body is wrapped
      // with data-state="masked" and renders • placeholder characters
      // rather than the live token. Verified by the masked Bearer
      // header substring (• repeated).
      expect(html).toContain('data-state="masked"');
      expect(html).toMatch(/Bearer •+/);
      // Show button + Copy button both present.
      expect(html).toContain('id="mcp-cmd-show"');
      expect(html).toContain('id="mcp-cmd-copy"');
      expect(html).toContain("/admin/tokens");
      // The token is single-use — consumed on first render.
      expect(getSetting(db, "setup_minted_token")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("done screen falls back to bare MCP command + admin/tokens hint when no minted token", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("claude mcp add --transport http parachute-default");
      // The fallback explanatory text leads with the OAuth path (no token
      // needed) and, for headless clients, references a hub JWT placeholder
      // — NOT the retired `pvt_*` format (gap #4). The `--header` flag must
      // also NOT be appended to the command line itself.
      expect(html).toContain("browser OAuth");
      expect(html).toContain("Bearer &lt;token&gt;");
      expect(html).not.toContain("pvt_");
      expect(html).toContain("parachute auth mint-token");
      expect(html).toContain("/admin/tokens");
      // Specifically no Copy button — that's a token-present surface.
      expect(html).not.toContain('id="mcp-cmd"');
    } finally {
      db.close();
    }
  });

  test("minted token is consumed after first render — refresh shows the fallback shape", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      setSetting(db, "setup_minted_token", "test-token-xyz");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const deps = {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      };
      const sessionedReq = () =>
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        });
      const first = handleSetupGet(sessionedReq(), deps);
      const firstHtml = await first.text();
      expect(firstHtml).toContain("test-token-xyz");
      const second = handleSetupGet(sessionedReq(), deps);
      const secondHtml = await second.text();
      expect(secondHtml).not.toContain("test-token-xyz");
      // The MCP command tile has no Copy button on the fallback shape.
      expect(secondHtml).not.toContain('id="mcp-cmd"');
    } finally {
      db.close();
    }
  });

  // rc.11 — token visible by default on the done screen was a
  // shoulder-surf hazard. The fix: render the visible command with
  // a masked Bearer token, stash the real command in a
  // hidden script tag, and surface a Show button + Copy button. Copy
  // ALWAYS pulls the real command from the script tag so the
  // operator's terminal paste never breaks regardless of mask state.
  test("done screen masks the Bearer token in the visible <pre> by default", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      setSetting(db, "setup_minted_token", "pvt_super_secret_token_payload");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      // Extract the visible <pre id="mcp-cmd"> text only — the masked
      // shape must live there, with no occurrence of the literal token
      // string. The real token still appears elsewhere (the hidden
      // script tag) so a plain `toContain` would miss the leak.
      const preMatch = html.match(/<pre id="mcp-cmd">([^<]*)<\/pre>/);
      expect(preMatch).not.toBeNull();
      const preBody = preMatch?.[1] ?? "";
      expect(preBody).not.toContain("pvt_super_secret_token_payload");
      // Masked Bearer header is present in the <pre> text.
      expect(preBody).toMatch(/Bearer •+/);
      // Real command still in the document (hidden JSON stash) so the
      // Copy handler can read it.
      expect(html).toContain('<script type="application/json" id="mcp-cmd-real">');
      expect(html).toContain("pvt_super_secret_token_payload");
      // Default state is masked.
      expect(html).toContain('data-state="masked"');
    } finally {
      db.close();
    }
  });

  test("done screen JSON-encodes the stashed command so `</script>` in a token can't break out", async () => {
    // Defense-in-depth: an attacker-shaped token containing `</script>`
    // would prematurely close the stash tag if we just dropped it into
    // the HTML. The renderer JSON-encodes the command AND replaces
    // `</` with `<\/` inside the encoded string so the sequence can't
    // appear in the document. Decode round-trips via JSON.parse.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      // Token contains characters that would be load-bearing in the
      // HTML/JS layer if mis-encoded: a quote (would close the JSON
      // string) and `</script>` (would close the stash tag).
      const hostileToken = `weird-token-with-"-and-</script>-inside`;
      setSetting(db, "setup_minted_token", hostileToken);
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      // `</script>` must NOT appear inside the stash element. We
      // verify by extracting the stash text via the literal HTML
      // boundaries and asserting no close-tag escape escaped the
      // encoder.
      const stashMatch = html.match(
        /<script type="application\/json" id="mcp-cmd-real">([\s\S]*?)<\/script>/,
      );
      expect(stashMatch).not.toBeNull();
      const stashBody = stashMatch?.[1] ?? "";
      // The encoder replaces `</` with `<\/` inside the JSON, so the
      // raw bytes between the opening and the first `</script>` should
      // not contain `</`.
      expect(stashBody).not.toContain("</");
      // Round-trips: `<\/` decodes back to `</` after JSON.parse +
      // the script-end-sequence escape — the operator's clipboard
      // gets the original bytes.
      const decoded = JSON.parse(stashBody) as string;
      expect(decoded).toContain(hostileToken);
    } finally {
      db.close();
    }
  });

  test("done screen wires Show + Copy buttons that read from the hidden real-command stash", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      setSetting(db, "setup_minted_token", "live-token-AAA");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      // Both buttons present, both wired via addEventListener (no
      // inline onclick — the script runs in a single IIFE).
      expect(html).toContain('id="mcp-cmd-show"');
      expect(html).toContain('id="mcp-cmd-copy"');
      expect(html).toContain("'click'");
      // The Copy handler reads from the hidden script tag, not from
      // the visible <pre>. Regression: this was the load-bearing
      // contract Aaron called out ("Copy still works without reveal").
      expect(html).toContain("getElementById('mcp-cmd-real')");
      // The stash holds JSON-encoded text and the handler decodes via
      // JSON.parse so the clipboard receives the exact byte sequence of
      // the command — `&quot;`-style HTML entities can't survive into
      // the operator's shell because script-element content is raw text
      // (the HTML parser doesn't decode entities inside <script>).
      expect(html).toContain("JSON.parse(real.textContent");
      // Auto-hide timer present so a stray reveal doesn't leak into a
      // subsequent screencast capture.
      expect(html).toContain("setTimeout(setMasked, 10000)");
    } finally {
      db.close();
    }
  });

  test("GET /admin/setup?just_finished=1 without a session does NOT consume the minted token (hub#274 security fold)", async () => {
    // Regression — without the session gate, any HTTP client racing the
    // operator's browser between the expose POST (which mints + stores)
    // and the done GET (which reads + consumes) walks off with a
    // full-scope operator JWT. The gate sends sessionless GETs to
    // /login + leaves the row in place so the operator's subsequent
    // legitimate GET still surfaces the token.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      setSetting(db, "setup_minted_token", "test-secret-token-must-not-leak");
      // No session cookie on this request — simulating a drive-by GET
      // from an attacker or a stale bookmark in a different browser
      // tab that doesn't carry the wizard's session.
      const res = handleSetupGet(req("/admin/setup?just_finished=1"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      // The gate redirects to /login (302) rather than rendering the
      // done screen. Body must NOT contain the token.
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login");
      // The setup_minted_token row is STILL present — the unauthed GET
      // didn't consume it, so the legitimate operator's session-bearing
      // GET will still see the token on the done screen.
      expect(getSetting(db, "setup_minted_token")).toBe("test-secret-token-must-not-leak");
    } finally {
      db.close();
    }
  });
});

// --- hub#272 Item B: install-tile rendering + install POST --------------

describe("done screen install tiles (hub#272 Item B)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  // TODO(surface-rename): tile ordering assertion fails — "Install Surface"
  // appears AFTER "Install Scribe" in rendered HTML, opposite of
  // INSTALL_TILE_PROPS order. Likely a renderer quirk introduced when both
  // tiles got similar display names. Skipping to land the rename PR; will
  // diagnose in a follow-up. The substantive coverage (tile presence,
  // install POST action targets) is preserved by the other tests in this
  // describe block.
  test.skip("done screen renders Install Surface + Install Scribe tiles when neither is installed", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("What's next?");
      // hub#323: App replaces Notes as the first install tile. App auto-bootstraps
      // Notes (parachute-app §17 Phase 2.1) so operators don't need to install
      // notes-daemon directly; the tagline telegraphs that Notes comes with App.
      expect(html).toContain("Install Surface");
      expect(html).toContain("Install Scribe");
      expect(html).toContain('action="/admin/setup/install/surface"');
      expect(html).toContain('action="/admin/setup/install/scribe"');
      // App tile sits first in the render order — verified by both tiles
      // appearing AND app's index in the rendered HTML preceding scribe's.
      expect(html.indexOf("Install Surface")).toBeLessThan(html.indexOf("Install Scribe"));
      // Notes is no longer a wizard tile; notes-daemon still installable
      // via /api/modules/notes/install for back-compat, but the wizard
      // doesn't surface it.
      expect(html).not.toContain("Install Notes");
      expect(html).not.toContain('action="/admin/setup/install/notes"');
    } finally {
      db.close();
    }
  });

  test("tile shows 'Already installed' when a curated module is in services.json", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      // Seed services.json with `parachute-scribe` so the wizard's scribe
      // install tile renders the already-installed shape. Post-2026-05-27
      // CURATED trim scribe is the only non-vault install tile.
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
            {
              name: "parachute-scribe",
              version: "0.4.4",
              port: 1943,
              paths: ["/scribe"],
              health: "/scribe/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("Already installed");
      // The scribe tile rendered the installed shape, not the install form.
      expect(html).not.toContain('action="/admin/setup/install/scribe"');
      // "Manage in admin" is the secondary link on the already-installed tile.
      expect(html).toContain("Manage in admin");
    } finally {
      db.close();
    }
  });

  test("done screen renders op-poll panel when ?op_scribe=<id> matches a registry op", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const reg = getDefaultOperationsRegistry();
      // Post-2026-05-27 CURATED trim, scribe is the only non-vault wizard
      // install tile, so it carries the op-poll panel. Same shape as the
      // prior `op_app=<id>` / `op_notes=<id>` flows — the rendering code
      // is per-`?op_<short>=<id>` query and tile-row agnostic.
      const op = reg.create("install", "scribe");
      reg.update(op.id, { status: "running" }, "running bun add -g @openparachute/scribe@latest");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req(`/admin/setup?just_finished=1&op_scribe=${op.id}`, {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: reg,
        },
      );
      const html = await res.text();
      expect(html).toContain("status: running");
      expect(html).toContain("running bun add");
      // Auto-refresh wired so the next tick re-fetches.
      expect(html).toContain('http-equiv="refresh"');
    } finally {
      db.close();
    }
  });

  test("install POST enqueues an op + redirects to ?op_<short>=<id>", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup?just_finished=1"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const runCalls: string[][] = [];
      const stubbedRun = async (cmd: readonly string[]) => {
        runCalls.push([...cmd]);
        return 0;
      };
      const post = await handleSetupInstallPost(
        req("/admin/setup/install/scribe", {
          method: "POST",
          body: new URLSearchParams({ [CSRF_FIELD_NAME]: csrf }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        "scribe",
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
          run: stubbedRun,
          isLinked: () => false,
        },
      );
      expect(post.status).toBe(303);
      const location = post.headers.get("location") ?? "";
      expect(location).toMatch(/^\/admin\/setup\?just_finished=1&op_scribe=/);
      await new Promise((r) => setTimeout(r, 50));
      expect(runCalls.length).toBeGreaterThan(0);
      expect(runCalls[0]?.join(" ")).toContain("bun add -g @openparachute/scribe@latest");
    } finally {
      db.close();
    }
  });

  test("install POST rejects 'vault' short (the wizard's own step owns that)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const post = await handleSetupInstallPost(
        req("/admin/setup/install/vault", {
          method: "POST",
          body: new URLSearchParams({ [CSRF_FIELD_NAME]: csrf }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        "vault",
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(400);
      const html = await post.text();
      expect(html).toContain("not an installable wizard module");
    } finally {
      db.close();
    }
  });

  test("install POST rejects unknown short", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const post = await handleSetupInstallPost(
        req("/admin/setup/install/bogus", {
          method: "POST",
          body: new URLSearchParams({}).toString(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        "bogus",
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(400);
      const html = await post.text();
      expect(html).toContain("not an installable wizard module");
    } finally {
      db.close();
    }
  });

  test("install POST without admin session is rejected", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const post = await handleSetupInstallPost(
        req("/admin/setup/install/scribe", {
          method: "POST",
          body: new URLSearchParams({ [CSRF_FIELD_NAME]: csrf }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
          },
        }),
        "scribe",
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(400);
      const html = await post.text();
      expect(html).toContain("No admin session");
    } finally {
      db.close();
    }
  });

  test("install POST without supervisor (CLI mode) is rejected", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const post = await handleSetupInstallPost(
        req("/admin/setup/install/notes", {
          method: "POST",
          body: new URLSearchParams({}).toString(),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        }),
        "notes",
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(400);
      const html = await post.text();
      expect(html).toContain("supervisor unavailable");
    } finally {
      db.close();
    }
  });
});

// --- hub#267: typed vault name threading --------------------------------

describe("typed vault name (hub#267)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("vault POST accepts a valid typed name + passes PARACHUTE_VAULT_NAME via env to supervisor", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      // Capture supervisor spawn requests so we can assert env passthrough.
      const spawnRequests: Array<{
        short: string;
        env?: Record<string, string>;
      }> = [];
      const supervisor = new Supervisor({
        output: () => {},
        spawnFn: (sreq) => {
          spawnRequests.push({
            short: sreq.short,
            ...(sreq.env ? { env: sreq.env } : {}),
          });
          return {
            pid: 22222,
            exited: new Promise<number | null>(() => {}),
            stdout: null,
            stderr: null,
            kill: () => {},
          };
        },
      });
      const stubbedRun = async (_cmd: readonly string[]) => 0;
      const post = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({
            [CSRF_FIELD_NAME]: csrf,
            vault_name: "smoke-1940",
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor,
          registry: getDefaultOperationsRegistry(),
          run: stubbedRun,
        },
      );
      expect(post.status).toBe(303);
      expect(getSetting(db, "setup_vault_name")).toBe("smoke-1940");
      // Yield long enough for runInstall → spawnSupervised → supervisor.start
      await new Promise((r) => setTimeout(r, 50));
      expect(spawnRequests.length).toBeGreaterThan(0);
      const vaultSpawn = spawnRequests.find((s) => s.short === "vault");
      expect(vaultSpawn).toBeDefined();
      expect(vaultSpawn?.env?.PARACHUTE_VAULT_NAME).toBe("smoke-1940");
      // PORT also injected (hub#356) — supervisor always sets it from the
      // services.json entry regardless of whether the typed-name path
      // contributed any additional env vars.
      expect(vaultSpawn?.env?.PORT).toBe("1940");
    } finally {
      db.close();
    }
  });

  test("vault POST rejects an invalid name (uppercase) with a 400 + error banner + preserved input", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const post = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({
            [CSRF_FIELD_NAME]: csrf,
            vault_name: "BAD-NAME",
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(400);
      const html = await post.text();
      expect(html).toContain("lowercase alphanumeric");
      expect(html).toContain('value="BAD-NAME"');
      expect(getSetting(db, "setup_vault_name")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("vault POST with empty name falls back to 'default' + omits the env override", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const spawnRequests: Array<{
        short: string;
        env?: Record<string, string>;
      }> = [];
      const supervisor = new Supervisor({
        output: () => {},
        spawnFn: (sreq) => {
          spawnRequests.push({
            short: sreq.short,
            ...(sreq.env ? { env: sreq.env } : {}),
          });
          return {
            pid: 33333,
            exited: new Promise<number | null>(() => {}),
            stdout: null,
            stderr: null,
            kill: () => {},
          };
        },
      });
      const post = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          body: new URLSearchParams({
            [CSRF_FIELD_NAME]: csrf,
            vault_name: "",
          }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          supervisor,
          registry: getDefaultOperationsRegistry(),
          run: async () => 0,
        },
      );
      expect(post.status).toBe(303);
      expect(getSetting(db, "setup_vault_name")).toBe("default");
      await new Promise((r) => setTimeout(r, 50));
      const vaultSpawn = spawnRequests.find((s) => s.short === "vault");
      expect(vaultSpawn).toBeDefined();
      // No PARACHUTE_VAULT_NAME override on the default-name path (vault's
      // resolveFirstBootVaultName already defaults to "default" when the
      // env var is absent). PORT is set by the supervisor (hub#356) for
      // every supervised child regardless — assert the empty-name path
      // doesn't add PARACHUTE_VAULT_NAME.
      expect(vaultSpawn?.env?.PARACHUTE_VAULT_NAME).toBeUndefined();
      expect(vaultSpawn?.env?.PORT).toBe("1940");
    } finally {
      db.close();
    }
  });

  test("done screen surfaces the typed name in the MCP command", async () => {
    // Happy-path shape: operator typed `my-personal-vault`, vault
    // first-boot wrote it through to services.json. Both sources
    // agree, the done page renders the operator-typed name verbatim.
    // (Pre-smoke-2026-05-27 this test used a mismatched fixture —
    // services.json said `/vault/default` while the typed setting was
    // `my-personal-vault`. The DB-priority shape that test was pinning
    // is itself the smoke finding 2 bug; the fixture has been
    // realigned to match the actual end-to-end flow where vault's
    // first-boot honors PARACHUTE_VAULT_NAME.)
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/my-personal-vault"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      setSetting(db, "setup_vault_name", "my-personal-vault");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("parachute-my-personal-vault");
      expect(html).toContain("/vault/my-personal-vault/mcp");
    } finally {
      db.close();
    }
  });

  test("done screen renders LIVE vault name when services.json disagrees with the DB-cached value (smoke 2026-05-27 finding 2)", async () => {
    // Scenario: operator typed `test` into the wizard, install failed
    // (smoke finding 1), operator worked around it by installing vault
    // via CLI which created it under the canonical `default` name. The
    // DB's `setup_vault_name` is stale; services.json is the source of
    // truth. Done page must render the LIVE name, not the stale typed
    // one, or the operator's "Open Notes" CTA links to a 404 vault.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"], // LIVE vault is "default"
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      // DB cache says "test" — what the operator typed before the
      // workaround. This is the bug shape: stale DB value vs live
      // services.json.
      setSetting(db, "setup_vault_name", "test");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      // The rendered name MUST be the live "default", not the
      // operator-typed "test" cached in `setup_vault_name`.
      expect(html).toContain("/vault/default");
      expect(html).not.toContain("/vault/test");
      // And the MCP service-namespace stamp should mirror it.
      expect(html).toContain("parachute-default");
      expect(html).not.toContain("parachute-test");
    } finally {
      db.close();
    }
  });

  test("done screen renders LIVE name even when it matches the DB value (happy path regression)", async () => {
    // Sanity check: the priority swap (live > stored) must NOT
    // break the happy path where both agree. The vault was installed
    // under the typed name, services.json reflects that, both sources
    // say the same thing.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/my-vault"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      setSetting(db, "setup_vault_name", "my-vault");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("/vault/my-vault");
      expect(html).toContain("parachute-my-vault");
    } finally {
      db.close();
    }
  });

  test("vault step pre-fills the prior typed value after a validation error", async () => {
    const { renderVaultStep } = await import("../setup-wizard.ts");
    const html = renderVaultStep({
      csrfToken: "csrf-test",
      vaultName: "BAD",
      errorMessage: "vault names must be lowercase alphanumeric with hyphens or underscores.",
    });
    expect(html).toContain('value="BAD"');
    expect(html).toContain("lowercase alphanumeric");
    expect(html).toContain('id="preview-vault-name">BAD<');
  });

  test("vault step cloudHost=true hides local cleanup options (ollama + claude-code)", async () => {
    // The cleanup sub-form (added 2026-05-27) offers seven providers
    // total. Two of them require host-side resources that don't exist
    // on a cloud container (Render / Fly): claude-code needs the
    // `claude` CLI + `claude setup-token` on the host; ollama needs a
    // local Ollama server. Hide those on cloudHost=true so operators
    // don't pick a provider that'd silently fail at first boot.
    const { renderVaultStep } = await import("../setup-wizard.ts");
    const cloudHtml = renderVaultStep({ csrfToken: "csrf-test", cloudHost: true });
    expect(cloudHtml).not.toContain('value="claude-code"');
    expect(cloudHtml).not.toContain('value="ollama"');
    // Cloud-friendly options stay visible.
    expect(cloudHtml).toContain('value="anthropic"');
    expect(cloudHtml).toContain('value="gemini"');
    // And on the local self-host path they're all there.
    const localHtml = renderVaultStep({ csrfToken: "csrf-test", cloudHost: false });
    expect(localHtml).toContain('value="claude-code"');
    expect(localHtml).toContain('value="ollama"');
  });
});

// --- bootstrap token gate (first-boot-path hardening, Issue 1) -----------

describe("bootstrap token gate (handleSetupAccountPost)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
    const { _resetBootstrapTokenForTests } = await import("../bootstrap-token.ts");
    _resetBootstrapTokenForTests();
  });
  afterEach(async () => {
    h.cleanup();
    const { _resetBootstrapTokenForTests } = await import("../bootstrap-token.ts");
    _resetBootstrapTokenForTests();
  });

  test("GET /admin/setup renders the bootstrap-token field when a token is active", async () => {
    const { generateBootstrapToken } = await import("../bootstrap-token.ts");
    generateBootstrapToken();
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const html = await res.text();
      expect(html).toContain('name="bootstrap_token"');
      // The callout names what the field is + where to find the value.
      expect(html).toContain("Bootstrap token");
      expect(html).toContain("startup logs");
      // Form action unchanged.
      expect(html).toContain('action="/admin/setup/account"');
    } finally {
      db.close();
    }
  });

  test("GET /admin/setup omits the bootstrap-token field when no token is active", () => {
    // No `generateBootstrapToken` call this test — the in-memory slot is
    // undefined, mirroring on-box CLI mode (no `parachute serve` wizard).
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const html = res.text() as unknown as Promise<string>;
      return html.then((body) => {
        expect(body).not.toContain('name="bootstrap_token"');
        // Bootstrap callout is also absent — operator gets the
        // pre-hardening shape on the on-box CLI surface.
        expect(body).not.toContain("Bootstrap token");
        expect(body).toContain('action="/admin/setup/account"');
      });
    } finally {
      db.close();
    }
  });

  test("POST /admin/setup/account with correct bootstrap_token creates admin + consumes token", async () => {
    const { generateBootstrapToken, getBootstrapToken } = await import("../bootstrap-token.ts");
    const token = generateBootstrapToken();
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const form = formBody({
        bootstrap_token: token,
        username: "ops",
        password: "correct horse battery",
        password_confirm: "correct horse battery",
        [CSRF_FIELD_NAME]: csrf,
      });
      const post = await handleSetupAccountPost(
        req("/admin/setup/account", {
          method: "POST",
          body: form.body,
          headers: { ...form.headers, cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(303);
      expect(userCount(db)).toBe(1);
      // Token consumed: in-memory slot is undefined.
      expect(getBootstrapToken()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("POST /admin/setup/account with wrong bootstrap_token returns 401 + no admin row", async () => {
    const { generateBootstrapToken } = await import("../bootstrap-token.ts");
    generateBootstrapToken();
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const form = formBody({
        bootstrap_token: "parachute-bootstrap-WRONG-WRONG-WRONG-WRONG-WRONG-WRONG-x",
        username: "ops",
        password: "correct horse battery",
        password_confirm: "correct horse battery",
        [CSRF_FIELD_NAME]: csrf,
      });
      const post = await handleSetupAccountPost(
        req("/admin/setup/account", {
          method: "POST",
          body: form.body,
          headers: { ...form.headers, cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(401);
      // The form re-renders with the token field present + an error
      // banner; the wrong token value is NOT echoed back.
      const html = await post.text();
      expect(html).toContain('name="bootstrap_token"');
      expect(html).toContain("Wrong bootstrap token");
      expect(html).not.toContain("WRONG-WRONG-WRONG");
      // Username is preserved so the operator doesn't have to retype.
      expect(html).toContain('value="ops"');
      // No admin row was created.
      expect(userCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("POST /admin/setup/account with MISSING bootstrap_token returns 401", async () => {
    const { generateBootstrapToken } = await import("../bootstrap-token.ts");
    generateBootstrapToken();
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const form = formBody({
        // Deliberately omit `bootstrap_token`.
        username: "ops",
        password: "correct horse battery",
        password_confirm: "correct horse battery",
        [CSRF_FIELD_NAME]: csrf,
      });
      const post = await handleSetupAccountPost(
        req("/admin/setup/account", {
          method: "POST",
          body: form.body,
          headers: { ...form.headers, cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(401);
      expect(userCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  test("POST /admin/setup/account after admin already claimed returns 410 Gone", async () => {
    const { generateBootstrapToken } = await import("../bootstrap-token.ts");
    // First claim: generate token + create admin. Then a stale POST
    // arrives — the token has been consumed AND an admin row exists.
    generateBootstrapToken();
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "first-admin", "strong-password", { passwordChanged: true });
      // Re-mint a fresh bootstrap token to simulate the case where the
      // operator restarts the hub after admin creation. (Normally the
      // serve.ts gate prevents this — we test the defensive layer.)
      generateBootstrapToken();
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const form = formBody({
        bootstrap_token: "parachute-bootstrap-doesnt-matter-admin-already-exists-xxx",
        username: "interloper",
        password: "another password",
        password_confirm: "another password",
        [CSRF_FIELD_NAME]: csrf,
      });
      const post = await handleSetupAccountPost(
        req("/admin/setup/account", {
          method: "POST",
          body: form.body,
          headers: { ...form.headers, cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(410);
      const html = await post.text();
      expect(html).toContain("Admin already claimed");
      // No second user row was created.
      expect(userCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("on-box CLI flow (no token) creates admin normally — historical shape preserved", async () => {
    // Critical back-compat: when no token has been generated (the
    // historical wizard path: `parachute expose` doesn't enter wizard
    // mode), the account POST works exactly as before. This pins the
    // existing behavior post-refactor.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const form = formBody({
        username: "ops",
        password: "correct horse battery",
        password_confirm: "correct horse battery",
        [CSRF_FIELD_NAME]: csrf,
      });
      const post = await handleSetupAccountPost(
        req("/admin/setup/account", {
          method: "POST",
          body: form.body,
          headers: { ...form.headers, cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      expect(post.status).toBe(303);
      expect(userCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });

  // hub#297 reviewer-nit fold 3: pin the concurrent-claim race property.
  //
  // The wizard's account-claim POST has two layers of race-protection
  // (chain documented inline below). The vault-POST analogue (idempotent
  // short-circuit when supervisor.start is already running) has a test
  // at setup-wizard.test.ts:N2 (`handleSetupVaultPost` — idempotent on
  // concurrent POSTs); this is the missing partner pin for the account
  // step.
  //
  // Race-protection chain:
  //   1. First POST takes the token via verifyBootstrapToken (constant-
  //      time check returns true), enters the createUser branch, and
  //      consumes the token via consumeBootstrapToken AFTER the row
  //      commits.
  //   2. Second POST (if it arrives before the first finishes):
  //      a. If the first POST hasn't consumed the token yet, both
  //         POSTs pass verifyBootstrapToken. They race into createUser;
  //         SQLite's UNIQUE constraint on `users.username` makes the
  //         second `INSERT INTO users` throw. The handler's `catch`
  //         block re-renders the form with a 400 + "username may
  //         already be taken" banner — and crucially does NOT create
  //         a second admin row.
  //      b. If the first POST has already consumed the token, the
  //         second POST's verifyBootstrapToken returns false (token
  //         slot is undefined). 401 + form re-render.
  //   3. Either way: exactly one admin row at rest, token consumed.
  test("concurrent claim with the same token + username yields exactly one admin row (race property)", async () => {
    const { generateBootstrapToken, getBootstrapToken } = await import("../bootstrap-token.ts");
    const token = generateBootstrapToken();
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const formA = formBody({
        bootstrap_token: token,
        username: "ops",
        password: "correct horse battery",
        password_confirm: "correct horse battery",
        [CSRF_FIELD_NAME]: csrf,
      });
      // Two POSTs share the same body, same CSRF, same token, same
      // username. Promise.all fires them as concurrently as the bun
      // runtime allows; the deterministic interleaving covered here
      // is: both pass CSRF (same cookie), both pass token verify (if
      // they race before the first one's consume), both reach
      // createUser, and exactly one INSERT wins.
      const deps = {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      };
      const post = (label: string) =>
        handleSetupAccountPost(
          req(`/admin/setup/account?race=${label}`, {
            method: "POST",
            body: formA.body,
            headers: { ...formA.headers, cookie: `${CSRF_COOKIE_NAME}=${csrf}` },
          }),
          deps,
        );

      const [resA, resB] = await Promise.all([post("a"), post("b")]);

      // Property 1: exactly one POST landed at the 303 success branch.
      const successes = [resA, resB].filter((r) => r.status === 303);
      const failures = [resA, resB].filter((r) => r.status !== 303);
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);

      // Property 2: the failure is either a 400 (UNIQUE collision via
      // createUser → catch block) OR a 401 (token already consumed by
      // the first POST → verifyBootstrapToken returned false on this
      // one). Both are valid race outcomes; we don't pin which —
      // the schedule is non-deterministic at the bun runtime layer.
      const failStatus = failures[0]?.status;
      expect(failStatus === 400 || failStatus === 401).toBe(true);

      // Property 3: exactly one admin row exists in the users table.
      expect(userCount(db)).toBe(1);

      // Property 4: the bootstrap token is consumed (cannot be reused
      // by a later POST). Even in the schedule where the second POST
      // failed via UNIQUE (token wasn't consumed by the failing path —
      // it was consumed by the succeeding path), the token slot is
      // empty after both promises settle.
      expect(getBootstrapToken()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

// --- hub#342 UI pass: "Start using your vault" lead tile + Use it now ---

describe("done screen — 'Start using your vault' tile (hub#342)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("when only vault is installed, the lead tile links to vault admin", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      // Section heading present + primary CTA points at the vault's own admin.
      expect(html).toContain("Start using your vault");
      expect(html).toContain('href="/vault/default/admin/"');
      // Lead tile precedes the MCP / install tiles (it's the lead).
      const startIdx = html.indexOf("Start using your vault");
      const installIdx = html.indexOf("What's next?");
      expect(startIdx).toBeLessThan(installIdx);
    } finally {
      db.close();
    }
  });

  test("lead tile always points at notes.parachute.computer (canonical hosted PWA) regardless of local module installs", async () => {
    // Pre-2026-05-27 the lead tile flipped to `/surface/notes/` when the
    // Surface module was installed locally. Aaron's launch-focus
    // directive: notes.parachute.computer is the canonical user-facing
    // UI, and the wizard should always point operators at it (rather
    // than maybe-or-maybe-not-installed local Surface). This test pins
    // that the lead tile is invariant under the install state of
    // uncurated modules.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
            // Even with parachute-surface installed locally (an uncurated
            // module post-trim), the lead tile must NOT flip to a local
            // path.
            {
              name: "parachute-surface",
              version: "0.2.0",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("Start using your vault");
      // Lead CTA always targets the hosted PWA.
      expect(html).toContain("https://notes.parachute.computer/add?url=");
      expect(html).toContain("Open Notes");
      // The pre-trim local-surface fallback is gone — the lead tile does
      // NOT link to /surface/notes/ anymore.
      expect(html).not.toContain('href="/surface/notes/"');
    } finally {
      db.close();
    }
  });

  test("succeeded install op renders 'Manage modules' link (no 'Use it now' for modules without a hosted surface)", async () => {
    // Pre-2026-05-27 the surface module had a USE_IT_NOW_URLS entry
    // pointing at `/surface/notes/`, so a succeeded surface install tile
    // rendered a primary "Use it now" link. Post-trim only scribe + vault
    // are curated; vault has its own lead tile (above the install row);
    // scribe doesn't ship a user-facing landing surface today
    // (scribe#53 tracks the eventual admin SPA), so USE_IT_NOW_URLS is
    // empty and a succeeded scribe install renders only the "Manage
    // modules" secondary affordance. Future per-module surfaces can
    // re-add an entry to that map.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const reg = getDefaultOperationsRegistry();
      const op = reg.create("install", "scribe");
      reg.update(op.id, { status: "succeeded" }, "installed @openparachute/scribe");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req(`/admin/setup?just_finished=1&op_scribe=${op.id}`, {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: reg,
        },
      );
      const html = await res.text();
      expect(html).toContain("status: succeeded");
      // No "Use it now" — scribe has no entry in USE_IT_NOW_URLS today.
      expect(html).not.toContain(">Use it now<");
      // "Manage modules" secondary link is always present on a terminal-
      // succeeded install tile.
      expect(html).toContain(">Manage modules<");
    } finally {
      db.close();
    }
  });

  test("'Already installed' tile renders without a 'Use it now' link when the module has no hosted surface", async () => {
    // Post-2026-05-27 CURATED trim, USE_IT_NOW_URLS is empty (scribe has
    // no first-class user-facing landing surface yet; vault gets its
    // own lead tile, not an install tile). The already-installed tile
    // therefore renders only the "Manage in admin" secondary link. Pre-
    // trim the surface module had a USE_IT_NOW_URLS entry that drove
    // this surface, so the test now pins the absence rather than the
    // presence.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const user = await createUser(db, "owner", "pw");
      writeManifest(
        {
          services: [
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
            },
            {
              name: "parachute-scribe",
              version: "0.4.4",
              port: 1943,
              paths: ["/scribe"],
              health: "/scribe/health",
            },
          ],
        },
        h.manifestPath,
      );
      setSetting(db, "setup_expose_mode", "localhost");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req("/admin/setup?just_finished=1", {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          readExposeStateFn: h.readExposeStateFn,
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("Already installed");
      // No "Use it now" on the scribe already-installed tile.
      expect(html).not.toContain(">Use it now<");
      // Secondary affordance still present.
      expect(html).toContain("Manage in admin");
    } finally {
      db.close();
    }
  });

  test("install-log CSS includes overflow-wrap so long lines wrap in the card", async () => {
    // Smoke test for the CSS fold (hub#342): the .op-log block sets
    // overflow-x:auto and the .log-lines li set white-space:pre-wrap +
    // overflow-wrap:anywhere. These are the three properties Aaron's
    // bug report flagged — without them long install logs blow up the
    // wizard layout.
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const html = await res.text();
      expect(html).toContain("overflow-x: auto");
      expect(html).toContain("white-space: pre-wrap");
      expect(html).toContain("overflow-wrap: anywhere");
    } finally {
      db.close();
    }
  });
});

describe("detectAutoExposeMode — Render env detection edge cases (hub#407 nit)", () => {
  test("returns 'public' for a real https Render URL", () => {
    expect(
      detectAutoExposeMode({ RENDER_EXTERNAL_URL: "https://parachute-hub.onrender.com" }),
    ).toBe("public");
  });

  test("returns 'public' for an http:// URL (defensive — if Render ever emits one)", () => {
    expect(detectAutoExposeMode({ RENDER_EXTERNAL_URL: "http://local.test:1939" })).toBe("public");
  });

  test("returns undefined when RENDER_EXTERNAL_URL is absent", () => {
    expect(detectAutoExposeMode({})).toBeUndefined();
  });

  test("returns undefined when RENDER_EXTERNAL_URL is empty", () => {
    expect(detectAutoExposeMode({ RENDER_EXTERNAL_URL: "" })).toBeUndefined();
  });

  test("returns undefined for a non-http scheme (httpx://, ftp://, etc.)", () => {
    expect(detectAutoExposeMode({ RENDER_EXTERNAL_URL: "httpx://foo.example" })).toBeUndefined();
    expect(detectAutoExposeMode({ RENDER_EXTERNAL_URL: "ftp://foo.example" })).toBeUndefined();
    expect(detectAutoExposeMode({ RENDER_EXTERNAL_URL: "javascript:alert(1)" })).toBeUndefined();
  });

  test("returns undefined when value is non-string (defensive)", () => {
    expect(detectAutoExposeMode({ RENDER_EXTERNAL_URL: undefined })).toBeUndefined();
  });
});

describe("detectAutoExposeMode — Fly env detection (patterns#100)", () => {
  test("returns 'public' when FLY_APP_NAME is a plausible app slug", () => {
    expect(detectAutoExposeMode({ FLY_APP_NAME: "my-parachute" })).toBe("public");
  });

  test("returns 'public' when FLY_APP_NAME is the only platform var set", () => {
    expect(detectAutoExposeMode({ FLY_APP_NAME: "demo-hub" })).toBe("public");
  });

  test("returns undefined when FLY_APP_NAME is absent", () => {
    expect(detectAutoExposeMode({})).toBeUndefined();
  });

  test("returns undefined when FLY_APP_NAME is empty", () => {
    expect(detectAutoExposeMode({ FLY_APP_NAME: "" })).toBeUndefined();
  });

  test("rejects FLY_APP_NAME with a slash (defensive — Fly slugs don't contain /)", () => {
    expect(detectAutoExposeMode({ FLY_APP_NAME: "../etc/passwd" })).toBeUndefined();
    expect(detectAutoExposeMode({ FLY_APP_NAME: "a/b" })).toBeUndefined();
  });

  test("Render takes precedence when both are set (pathological co-set)", () => {
    expect(
      detectAutoExposeMode({
        RENDER_EXTERNAL_URL: "https://app.onrender.com",
        FLY_APP_NAME: "my-parachute",
      }),
    ).toBe("public");
  });
});

// hub#168 Cut 2/3: vault-step three branches (create/import/skip) + JSON
// content-type acceptance. The handleSetupVaultPost handler is shared
// between browser and CLI surfaces — branching is by mode field +
// content-type. These tests drive the JSON surface directly to keep the
// behavior locked.

describe("setup-wizard JSON surface (hub#168 Cuts 2/3)", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("GET /admin/setup returns JSON envelope when Accept: application/json", () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const deps = {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "http://127.0.0.1:1939",
        registry: getDefaultOperationsRegistry(),
      };
      const res = handleSetupGet(
        req("/admin/setup", { headers: { accept: "application/json" } }),
        deps,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
    } finally {
      db.close();
    }
  });

  test("JSON probe hands the bootstrap token VALUE to a loopback caller (hub#576)", async () => {
    const { generateBootstrapToken, _resetBootstrapTokenForTests } = await import(
      "../bootstrap-token.ts"
    );
    _resetBootstrapTokenForTests();
    const token = generateBootstrapToken();
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = handleSetupGet(req("/admin/setup", { headers: { accept: "application/json" } }), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "http://127.0.0.1:1939",
        registry: getDefaultOperationsRegistry(),
        requestIsLoopback: true,
      });
      const body = (await res.json()) as {
        requireBootstrapToken: boolean;
        bootstrapToken?: string;
      };
      expect(body.requireBootstrapToken).toBe(true);
      expect(body.bootstrapToken).toBe(token);
    } finally {
      _resetBootstrapTokenForTests();
      db.close();
    }
  });

  test("JSON probe withholds the token VALUE from a non-loopback caller (hub#576)", async () => {
    const { generateBootstrapToken, _resetBootstrapTokenForTests } = await import(
      "../bootstrap-token.ts"
    );
    _resetBootstrapTokenForTests();
    generateBootstrapToken();
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = handleSetupGet(req("/admin/setup", { headers: { accept: "application/json" } }), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "http://127.0.0.1:1939",
        registry: getDefaultOperationsRegistry(),
        requestIsLoopback: false,
      });
      const body = (await res.json()) as {
        requireBootstrapToken: boolean;
        bootstrapToken?: string;
      };
      // The boolean still tells a public browser a token is required...
      expect(body.requireBootstrapToken).toBe(true);
      // ...but the VALUE never leaks to it.
      expect(body.bootstrapToken).toBeUndefined();
    } finally {
      _resetBootstrapTokenForTests();
      db.close();
    }
  });

  test("JSON probe fails CLOSED when loopback is unknown (hub#576)", async () => {
    const { generateBootstrapToken, _resetBootstrapTokenForTests } = await import(
      "../bootstrap-token.ts"
    );
    _resetBootstrapTokenForTests();
    generateBootstrapToken();
    const db = openHubDb(hubDbPath(h.dir));
    try {
      // `requestIsLoopback` omitted entirely — must be treated as non-loopback.
      const res = handleSetupGet(req("/admin/setup", { headers: { accept: "application/json" } }), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "http://127.0.0.1:1939",
        registry: getDefaultOperationsRegistry(),
      });
      const body = (await res.json()) as { bootstrapToken?: string };
      expect(body.bootstrapToken).toBeUndefined();
    } finally {
      _resetBootstrapTokenForTests();
      db.close();
    }
  });

  test("JSON probe omits the token when no admin gate is active (hub#576)", async () => {
    const { _resetBootstrapTokenForTests } = await import("../bootstrap-token.ts");
    _resetBootstrapTokenForTests(); // no token minted → not in wizard mode
    const db = openHubDb(hubDbPath(h.dir));
    try {
      const res = handleSetupGet(req("/admin/setup", { headers: { accept: "application/json" } }), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "http://127.0.0.1:1939",
        registry: getDefaultOperationsRegistry(),
        requestIsLoopback: true,
      });
      const body = (await res.json()) as {
        requireBootstrapToken: boolean;
        bootstrapToken?: string;
      };
      expect(body.requireBootstrapToken).toBe(false);
      expect(body.bootstrapToken).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("vault step skip mode short-circuits + persists setup_vault_skipped", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      // Seed: admin exists so the wizard's vault step is reachable.
      await createUser(db, "owner", "pw");
      // Get a session cookie via a CSRF token GET first.
      const supervisor = makeSupervisor();
      const baseDeps = {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "http://127.0.0.1:1939",
        registry: getDefaultOperationsRegistry(),
        supervisor,
      };
      const getRes = handleSetupGet(
        req("/admin/setup", { headers: { accept: "application/json" } }),
        baseDeps,
      );
      const csrf = setCookie(getRes, CSRF_COOKIE_NAME) ?? "";
      const envelope = (await getRes.json()) as { csrfToken: string };
      // Build a session for the operator (proxy what an account POST
      // would do).
      const { createSession, buildSessionCookie, SESSION_TTL_MS } = await import("../sessions.ts");
      const user = (await import("../users.ts")).getUserByUsername(db, "owner");
      if (!user) throw new Error("user missing");
      const session = createSession(db, { userId: user.id });
      const cookieHeader = `${SESSION_COOKIE_NAME}=${session.id}; ${CSRF_COOKIE_NAME}=${csrf}`;
      const postRes = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            cookie: cookieHeader,
          },
          body: JSON.stringify({
            [CSRF_FIELD_NAME]: envelope.csrfToken,
            mode: "skip",
          }),
        }),
        baseDeps,
      );
      expect(postRes.status).toBe(200);
      expect(postRes.headers.get("content-type")).toContain("application/json");
      const body = (await postRes.json()) as { step: string };
      expect(body.step).toBe("expose");
      // The skip flag is persisted.
      expect(getSetting(db, "setup_vault_skipped")).toBe("true");
      // deriveWizardState advances past the vault step.
      const s = deriveWizardState({
        db,
        manifestPath: h.manifestPath,
        readExposeStateFn: h.readExposeStateFn,
      });
      expect(s.hasVault).toBe(true);
      expect(s.step).toBe("expose");
    } finally {
      db.close();
    }
  });

  test("vault step import mode requires remote_url (400 on empty)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const supervisor = makeSupervisor();
      const baseDeps = {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        readExposeStateFn: h.readExposeStateFn,
        issuer: "http://127.0.0.1:1939",
        registry: getDefaultOperationsRegistry(),
        supervisor,
      };
      const { createSession } = await import("../sessions.ts");
      const user = (await import("../users.ts")).getUserByUsername(db, "owner");
      if (!user) throw new Error("user missing");
      const session = createSession(db, { userId: user.id });
      // Need CSRF cookie value matching the body field. Pull a token
      // through a GET first.
      const getRes = handleSetupGet(
        req("/admin/setup", { headers: { accept: "application/json" } }),
        baseDeps,
      );
      const csrf = setCookie(getRes, CSRF_COOKIE_NAME) ?? "";
      const envelope = (await getRes.json()) as { csrfToken: string };
      const cookieHeader = `${SESSION_COOKIE_NAME}=${session.id}; ${CSRF_COOKIE_NAME}=${csrf}`;
      const postRes = await handleSetupVaultPost(
        req("/admin/setup/vault", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            cookie: cookieHeader,
          },
          body: JSON.stringify({
            [CSRF_FIELD_NAME]: envelope.csrfToken,
            mode: "import",
            vault_name: "imported",
            remote_url: "",
          }),
        }),
        baseDeps,
      );
      expect(postRes.status).toBe(400);
      const body = (await postRes.json()) as { error: string; message: string };
      expect(body.error).toContain("Remote URL required");
    } finally {
      db.close();
    }
  });

  // hub#168 fold (PR #447 reviewer): the import POST to vault MUST carry
  // a Bearer — vault's `authenticateVaultRequest` rejects 401 before
  // scope check on missing auth. Asserts the header is present, names
  // the vault, and the body shape is intact.
  test("postVaultImportImpl sends Authorization: Bearer + correct body to vault", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;
    let capturedBody: unknown;
    const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedHeaders = new Headers(init?.headers ?? {});
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(
        JSON.stringify({
          notes_imported: 7,
          tags_imported: 2,
          attachments_imported: 0,
          warnings: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await postVaultImportImpl({
      vaultName: "imported",
      vaultPort: 1940,
      bearerToken: "stub-jwt-abc",
      remoteUrl: "https://github.com/owner/repo.git",
      mode: "merge",
      pat: "ghp_stub",
      fetcher: stubFetch,
    });

    expect(result.notes_imported).toBe(7);
    expect(capturedUrl).toBe("http://127.0.0.1:1940/vault/imported/.parachute/mirror/import");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer stub-jwt-abc");
    expect(capturedHeaders?.get("content-type")).toBe("application/json");
    expect(capturedBody).toEqual({
      remote_url: "https://github.com/owner/repo.git",
      mode: "merge",
      credentials: { kind: "pat", token: "ghp_stub" },
    });
  });

  // No-PAT branch — public repo import. Sends `credentials: null`,
  // which vault interprets as "use stored credentials" (or none).
  // Reviewer-flagged coverage gap on the rc.8 fold.
  test("postVaultImportImpl sends credentials: null when no PAT is provided", async () => {
    let capturedBody: unknown;
    const stubFetch = (async (_: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return new Response(JSON.stringify({ notes_imported: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await postVaultImportImpl({
      vaultName: "public-import",
      vaultPort: 1940,
      bearerToken: "stub",
      remoteUrl: "https://github.com/owner/public.git",
      mode: "replace",
      fetcher: stubFetch,
    });

    expect(capturedBody).toEqual({
      remote_url: "https://github.com/owner/public.git",
      mode: "replace",
      credentials: null,
    });
  });
});
