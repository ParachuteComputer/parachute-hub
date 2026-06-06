/**
 * CLI wizard (`parachute setup-wizard`, hub#168 Cut 3). Exercises
 * `runCliWizard` against a stub fetch + scripted prompts; no real hub
 * required.
 *
 * The wizard's contract:
 *   1. GET /admin/setup (Accept: application/json) → state envelope.
 *   2. POST /admin/setup/account (application/json) → set-cookie + 200
 *      OK envelope.
 *   3. POST /admin/setup/vault (application/json) → 200 OK envelope
 *      with `op_id`.
 *   4. GET /api/modules/operations/<id> until terminal status.
 *   5. POST /admin/setup/expose (application/json) → 200 OK.
 *
 * The stub fetch in this file is a mini-router that mimics the
 * setup-wizard handlers' JSON-shape behavior — same fields, same
 * cookies. It's not testing the wizard handler itself (setup-wizard.test
 * does that); it's testing the CLI walks the right calls in the right
 * order with the right payloads.
 */

import { describe, expect, test } from "bun:test";
import { type VaultMode, parseWizardArgs, runCliWizard } from "../commands/wizard.ts";
import { CSRF_COOKIE_NAME, CSRF_FIELD_NAME } from "../csrf.ts";
import { SESSION_COOKIE_NAME } from "../sessions.ts";

interface FakeHubState {
  hasAdmin: boolean;
  hasVault: boolean;
  hasExposeMode: boolean;
  vaultMode?: string;
  importParams?: { remoteUrl: string; pat?: string; mode: string };
  exposeMode?: string;
  posted: Array<{ path: string; body: unknown }>;
  /** hub#576: when set, the fake GET /admin/setup reports requireBootstrapToken=true. */
  requireBootstrapToken?: boolean;
  /** hub#576: when set, the fake GET also returns it (loopback-probe behavior). */
  bootstrapToken?: string;
  /** hub#576: when true, the account POST 401s unless the right token is supplied. */
  enforceBootstrapToken?: boolean;
}

function makeFakeHub(initialState?: Partial<FakeHubState>): {
  state: FakeHubState;
  // Loose return type — Bun's `typeof fetch` includes a `preconnect`
  // method on its function-object signature that no fetch-mock needs,
  // and our wizard only calls fetch as a function.
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
} {
  const state: FakeHubState = {
    hasAdmin: false,
    hasVault: false,
    hasExposeMode: false,
    posted: [],
    ...initialState,
  };
  // Synthesize a stable CSRF token + session token for the stub. The
  // real handlers re-derive these each request; the CLI just reads
  // them back from Set-Cookie. Stub flows.
  const csrf = "csrf-stub-token";
  const session = "session-stub-id";
  let opCount = 0;
  const ops = new Map<
    string,
    {
      id: string;
      status: "pending" | "running" | "succeeded" | "failed";
      log: string[];
      error?: string;
    }
  >();

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? new URL(input) : (input as URL);
    const path = url.pathname + url.search;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers ?? {});
    const body = init?.body;
    const bodyJson: unknown = body ? JSON.parse(String(body)) : null;

    // GET /admin/setup
    if (path === "/admin/setup" && method === "GET") {
      let step: "welcome" | "vault" | "expose" | "done" = "welcome";
      if (state.hasAdmin && state.hasVault && state.hasExposeMode) step = "done";
      else if (state.hasAdmin && state.hasVault) step = "expose";
      else if (state.hasAdmin) step = "vault";
      const respBody = JSON.stringify({
        step,
        hasAdmin: state.hasAdmin,
        hasVault: state.hasVault,
        hasExposeMode: state.hasExposeMode,
        requireBootstrapToken: state.requireBootstrapToken ?? false,
        csrfToken: csrf,
        // hub#576: a loopback probe carries the actual token value.
        ...(state.bootstrapToken ? { bootstrapToken: state.bootstrapToken } : {}),
      });
      return new Response(respBody, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `${CSRF_COOKIE_NAME}=${csrf}`,
        },
      });
    }

    // POST /admin/setup/account
    if (path === "/admin/setup/account" && method === "POST") {
      state.posted.push({ path, body: bodyJson });
      // hub#576: reject when the gate is enforced and the supplied token is
      // wrong / missing — proves the CLI wizard actually sends it.
      if (state.enforceBootstrapToken) {
        const supplied = (bodyJson as { bootstrap_token?: string })?.bootstrap_token;
        if (supplied !== state.bootstrapToken) {
          return new Response(JSON.stringify({ error: "bad bootstrap token" }), {
            status: 401,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
      }
      state.hasAdmin = true;
      return new Response(JSON.stringify({ step: "vault", message: "admin created" }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": `${SESSION_COOKIE_NAME}=${session}`,
        },
      });
    }

    // POST /admin/setup/vault
    if (path === "/admin/setup/vault" && method === "POST") {
      state.posted.push({ path, body: bodyJson });
      const b = bodyJson as {
        mode?: string;
        vault_name?: string;
        remote_url?: string;
        pat?: string;
        import_mode?: string;
      };
      state.vaultMode = b.mode;
      if (b.mode === "skip") {
        state.hasVault = true;
        return new Response(JSON.stringify({ step: "expose", message: "vault step skipped" }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      if (b.mode === "import") {
        state.importParams = {
          remoteUrl: b.remote_url ?? "",
          mode: b.import_mode ?? "merge",
          ...(b.pat ? { pat: b.pat } : {}),
        };
      }
      // Create an op + drive it to succeeded immediately for the test.
      const opId = `op-test-${++opCount}`;
      ops.set(opId, { id: opId, status: "succeeded", log: ["bun add -g", "spawned"] });
      state.hasVault = true;
      return new Response(JSON.stringify({ op_id: opId, step: "vault", mode: b.mode }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // GET /api/modules/operations/<id>
    if (path.startsWith("/api/modules/operations/") && method === "GET") {
      const id = path.slice("/api/modules/operations/".length);
      const op = ops.get(id);
      if (!op) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      return new Response(JSON.stringify(op), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // POST /admin/setup/expose
    if (path === "/admin/setup/expose" && method === "POST") {
      state.posted.push({ path, body: bodyJson });
      const b = bodyJson as { expose_mode?: string };
      state.hasExposeMode = true;
      state.exposeMode = b.expose_mode;
      return new Response(JSON.stringify({ step: "done", message: "expose mode set" }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return new Response(`unhandled: ${method} ${path}`, { status: 500 });
  };

  return { state, fetchImpl };
}

describe("parseWizardArgs", () => {
  test("requires --hub-url", () => {
    const r = parseWizardArgs([]);
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("--hub-url");
  });

  test("parses canonical happy-path argv", () => {
    const r = parseWizardArgs([
      "--hub-url",
      "http://127.0.0.1:1939",
      "--account-username",
      "admin",
      "--account-password",
      "longpassword",
      "--vault-mode",
      "create",
      "--vault-name",
      "default",
      "--expose-mode",
      "localhost",
    ]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error(r.error);
    expect(r.opts.hubUrl).toBe("http://127.0.0.1:1939");
    expect(r.opts.accountUsername).toBe("admin");
    expect(r.opts.accountPassword).toBe("longpassword");
    expect(r.opts.vaultMode).toBe("create");
    expect(r.opts.vaultName).toBe("default");
    expect(r.opts.exposeMode).toBe("localhost");
  });

  test("rejects invalid vault-mode", () => {
    const r = parseWizardArgs(["--hub-url", "http://x", "--vault-mode", "garbage"]);
    expect("error" in r).toBe(true);
  });

  test("--skip-vault sets vaultMode=skip", () => {
    const r = parseWizardArgs(["--hub-url", "http://x", "--skip-vault"]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error(r.error);
    expect(r.opts.vaultMode).toBe("skip");
  });

  test("--vault-import-url infers vaultMode=import when not explicit", () => {
    const r = parseWizardArgs([
      "--hub-url",
      "http://x",
      "--vault-import-url",
      "https://github.com/me/v.git",
    ]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error(r.error);
    expect(r.opts.vaultMode).toBe("import");
    expect(r.opts.vaultImportRemoteUrl).toBe("https://github.com/me/v.git");
  });
});

describe("runCliWizard", () => {
  test("walks account → vault(create) → expose end-to-end and exits 0", async () => {
    const { state, fetchImpl } = makeFakeHub();
    const logs: string[] = [];
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: (l) => logs.push(l),
      fetchImpl,
      sleep: async () => {},
      accountUsername: "admin",
      accountPassword: "longpassword",
      vaultMode: "create",
      vaultName: "default",
      exposeMode: "localhost",
    });
    expect(code).toBe(0);
    // Three POSTs in the right order: account, vault, expose.
    expect(state.posted.map((p) => p.path)).toEqual([
      "/admin/setup/account",
      "/admin/setup/vault",
      "/admin/setup/expose",
    ]);
    const accountBody = state.posted[0]?.body as Record<string, string>;
    expect(accountBody.username).toBe("admin");
    expect(accountBody.password).toBe("longpassword");
    expect(accountBody[CSRF_FIELD_NAME]).toBe("csrf-stub-token");
    const vaultBody = state.posted[1]?.body as Record<string, string>;
    expect(vaultBody.mode).toBe("create");
    expect(vaultBody.vault_name).toBe("default");
    expect(state.exposeMode).toBe("localhost");
  });

  test("loopback-probe bootstrap token is sent transparently (no prompt) — hub#576", async () => {
    const { state, fetchImpl } = makeFakeHub({
      requireBootstrapToken: true,
      bootstrapToken: "parachute-bootstrap-LOOPBACK",
      enforceBootstrapToken: true,
    });
    let prompted = false;
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      // No --bootstrap-token flag, no env: the value must come from the probe.
      prompt: async () => {
        prompted = true;
        return "";
      },
      accountUsername: "admin",
      accountPassword: "longpassword",
      vaultMode: "skip",
      exposeMode: "localhost",
    });
    expect(code).toBe(0);
    // The account POST carried the probe-supplied token...
    const accountBody = state.posted[0]?.body as Record<string, string>;
    expect(accountBody.bootstrap_token).toBe("parachute-bootstrap-LOOPBACK");
    // ...and the operator was never asked for it.
    expect(prompted).toBe(false);
  });

  test("explicit --bootstrap-token flag still wins over the probe value — hub#576", async () => {
    const { state, fetchImpl } = makeFakeHub({
      requireBootstrapToken: true,
      bootstrapToken: "parachute-bootstrap-PROBE",
      enforceBootstrapToken: false,
    });
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      bootstrapToken: "parachute-bootstrap-EXPLICIT",
      accountUsername: "admin",
      accountPassword: "longpassword",
      vaultMode: "skip",
      exposeMode: "localhost",
    });
    expect(code).toBe(0);
    const accountBody = state.posted[0]?.body as Record<string, string>;
    expect(accountBody.bootstrap_token).toBe("parachute-bootstrap-EXPLICIT");
  });

  test("vault import mode threads remote_url + pat + import_mode", async () => {
    const { state, fetchImpl } = makeFakeHub();
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      accountUsername: "admin",
      accountPassword: "longpassword",
      vaultMode: "import",
      vaultName: "imported",
      vaultImportRemoteUrl: "https://github.com/me/v.git",
      vaultImportPat: "ghp_fake",
      vaultImportReplace: true,
      exposeMode: "localhost",
    });
    expect(code).toBe(0);
    expect(state.importParams).toEqual({
      remoteUrl: "https://github.com/me/v.git",
      pat: "ghp_fake",
      mode: "replace",
    });
  });

  test("vault skip mode sends mode=skip + no name fields", async () => {
    const { state, fetchImpl } = makeFakeHub();
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      accountUsername: "admin",
      accountPassword: "longpassword",
      vaultMode: "skip",
      exposeMode: "localhost",
    });
    expect(code).toBe(0);
    const vaultBody = state.posted[1]?.body as Record<string, string>;
    expect(vaultBody.mode).toBe("skip");
    expect(vaultBody.vault_name).toBeUndefined();
  });

  test("idempotent re-run picks up at the next undone step", async () => {
    // Pre-seed: admin already exists. Wizard should skip account step
    // and POST only vault + expose.
    const { state, fetchImpl } = makeFakeHub({ hasAdmin: true });
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      vaultMode: "create",
      vaultName: "default",
      exposeMode: "localhost",
    });
    expect(code).toBe(0);
    expect(state.posted.map((p) => p.path)).toEqual(["/admin/setup/vault", "/admin/setup/expose"]);
  });

  test("password mismatch when prompted exits non-zero", async () => {
    const { fetchImpl } = makeFakeHub();
    const prompts: string[] = [];
    const answers = ["admin", "secretpassword", "different"];
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      prompt: async (q) => {
        prompts.push(q);
        return answers.shift() ?? "";
      },
    });
    expect(code).toBe(1);
  });

  test("vault mode 'import' without remote_url errors via 400-equivalent flow", async () => {
    const { fetchImpl } = makeFakeHub();
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      accountUsername: "admin",
      accountPassword: "longpassword",
      vaultMode: "import",
      // No vaultImportRemoteUrl set + no prompt seam → the wizard will
      // try to prompt for it. With no prompt seam configured, the
      // default readline shim would block — but we never reach the
      // prompt because the (test) fake handler accepts whatever
      // arrives. So this test exercises the prompt-default path; we
      // configure a prompt that returns "" (the user pressing Enter
      // on the remote-URL question) → wizard sees empty, exits 1.
      prompt: async () => "",
      vaultName: "imported",
      exposeMode: "localhost",
    });
    expect(code).toBe(1);
  });
});
