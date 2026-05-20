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
import { writeManifest } from "../services-manifest.ts";
import { SESSION_COOKIE_NAME } from "../sessions.ts";
import {
  deriveWizardState,
  handleSetupAccountPost,
  handleSetupGet,
  handleSetupVaultPost,
} from "../setup-wizard.ts";
import { Supervisor } from "../supervisor.ts";
import { createUser, userCount } from "../users.ts";

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

  test("done step when both admin and vault exist", async () => {
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
      expect(s.step).toBe("done");
      expect(s.hasAdmin).toBe(true);
      expect(s.hasVault).toBe(true);
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

  test("renders the vault form once admin exists (fold B: shows 'default' as static)", async () => {
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
      // The vault name is hard-bound to "default" pending hub#267 — the
      // form has no name input, just a submit button + a preview card
      // showing the canonical name + the follow-up issue link.
      expect(html).toContain('id="preview-vault-name">default<');
      expect(html).not.toContain('name="vault_name"');
      expect(html).toContain("hub#267");
    } finally {
      db.close();
    }
  });

  test("301s to /login once both admin and vault exist", async () => {
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
      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("/login");
    } finally {
      db.close();
    }
  });

  test("renders the success page once with ?just_finished=1 query", async () => {
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
              paths: ["/vault/myvault"],
              health: "/health",
            },
          ],
        },
        h.manifestPath,
      );
      const res = handleSetupGet(req("/admin/setup?just_finished=1"), {
        db,
        manifestPath: h.manifestPath,
        configDir: h.dir,
        issuer: "https://hub.example",
        registry: getDefaultOperationsRegistry(),
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("You're set up");
      // The success page surfaces the vault name from services.json so
      // the MCP install line carries the operator's actual choice.
      expect(html).toContain("myvault");
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

  test("redirects to /login once admin + vault are both present", async () => {
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
