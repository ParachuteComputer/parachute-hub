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
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { hubFetch } from "../hub-server.ts";
import { getSetting, setSetting } from "../hub-settings.ts";
import { writeManifest } from "../services-manifest.ts";
import { SESSION_COOKIE_NAME } from "../sessions.ts";
import {
  deriveWizardState,
  handleSetupAccountPost,
  handleSetupExposePost,
  handleSetupGet,
  handleSetupInstallPost,
  handleSetupVaultPost,
} from "../setup-wizard.ts";
import { Supervisor } from "../supervisor.ts";
import { createUser, getUserByUsername, userCount } from "../users.ts";

interface Harness {
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "setup-wizard-"));
  writeFileSync(join(dir, "hub.html"), "<html>discovery</html>");
  const manifestPath = join(dir, "services.json");
  writeManifest({ services: [] }, manifestPath);
  return {
    dir,
    manifestPath,
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
      const s = deriveWizardState({ db, manifestPath: h.manifestPath });
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
      const s = deriveWizardState({ db, manifestPath: h.manifestPath });
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
      const s = deriveWizardState({ db, manifestPath: h.manifestPath });
      expect(s.step).toBe("expose");
      expect(s.hasAdmin).toBe(true);
      expect(s.hasVault).toBe(true);
      expect(s.hasExposeMode).toBe(false);
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
      const s = deriveWizardState({ db, manifestPath: h.manifestPath });
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
      // first sign-in (`password_changed=1`). `assigned_vault` stays NULL
      // — admin posture (no per-vault restriction).
      const created = getUserByUsername(db, "ops");
      expect(created?.passwordChanged).toBe(true);
      expect(created?.assignedVault).toBeNull();
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

// --- POST /admin/setup/vault ---------------------------------------------

describe("handleSetupVaultPost", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
    _resetOperationsRegistryForTests();
  });
  afterEach(() => h.cleanup());

  test("requires a supervisor (CLI mode rejects)", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
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

  test("rejects without an admin session cookie", async () => {
    const db = openHubDb(hubDbPath(h.dir));
    try {
      await createUser(db, "owner", "pw");
      const get = handleSetupGet(req("/admin/setup"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
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
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
          run: stubbedRun,
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
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("claude mcp add --transport http parachute-default");
      // The fallback explanatory text mentions `pvt_...` as a placeholder
      // but the actual `--header` flag must NOT be appended to the
      // command line itself.
      expect(html).toContain("Bearer pvt_");
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

  test("done screen renders Install Notes + Install Scribe tiles when neither is installed", async () => {
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
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("What's next?");
      expect(html).toContain("Install Notes");
      expect(html).toContain("Install Scribe");
      expect(html).toContain('action="/admin/setup/install/notes"');
      expect(html).toContain('action="/admin/setup/install/scribe"');
    } finally {
      db.close();
    }
  });

  test("tile shows 'Already installed' when a curated module is in services.json", async () => {
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
              name: "parachute-notes",
              version: "0.1.0",
              port: 1942,
              paths: ["/notes"],
              health: "/notes/health",
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
          issuer: "https://hub.example",
          registry: getDefaultOperationsRegistry(),
        },
      );
      const html = await res.text();
      expect(html).toContain("Already installed");
      expect(html).toContain('action="/admin/setup/install/scribe"');
    } finally {
      db.close();
    }
  });

  test("done screen renders op-poll panel when ?op_notes=<id> matches a registry op", async () => {
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
      const op = reg.create("install", "notes");
      reg.update(op.id, { status: "running" }, "running bun add -g @openparachute/notes@latest");
      const { createSession } = await import("../sessions.ts");
      const session = createSession(db, { userId: user.id });
      const res = handleSetupGet(
        req(`/admin/setup?just_finished=1&op_notes=${op.id}`, {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${session.id}` },
        }),
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
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
        req("/admin/setup/install/notes", {
          method: "POST",
          body: new URLSearchParams({ [CSRF_FIELD_NAME]: csrf }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}; ${SESSION_COOKIE_NAME}=${session.id}`,
          },
        }),
        "notes",
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
          issuer: "https://hub.example",
          supervisor: makeSupervisor(),
          registry: getDefaultOperationsRegistry(),
          run: stubbedRun,
        },
      );
      expect(post.status).toBe(303);
      const location = post.headers.get("location") ?? "";
      expect(location).toMatch(/^\/admin\/setup\?just_finished=1&op_notes=/);
      await new Promise((r) => setTimeout(r, 50));
      expect(runCalls.length).toBeGreaterThan(0);
      expect(runCalls[0]?.join(" ")).toContain("bun add -g @openparachute/notes@latest");
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
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      const csrf = setCookie(get, CSRF_COOKIE_NAME) ?? "";
      const post = await handleSetupInstallPost(
        req("/admin/setup/install/notes", {
          method: "POST",
          body: new URLSearchParams({ [CSRF_FIELD_NAME]: csrf }).toString(),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
          },
        }),
        "notes",
        {
          db,
          manifestPath: h.manifestPath,
          configDir: h.dir,
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
      // No env override on the default-name path (vault's
      // resolveFirstBootVaultName already defaults to "default" when the
      // env var is absent, so the override would be redundant).
      expect(vaultSpawn?.env).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("done screen surfaces the typed name in the MCP command", async () => {
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
});
