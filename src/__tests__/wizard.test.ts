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
 *   4. GET /admin/setup?op=<id> until the `operation` envelope field
 *      reaches a terminal status (hub#616 — session-authed poll surface,
 *      NOT the Bearer-gated /api/modules/operations/:id the SPA uses).
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
  /** hub#616: path+query of every op-poll GET, to assert the wizard polls the session surface. */
  polled: string[];
  /**
   * hub#616: number of poll ticks the vault op reports `"running"` before
   * flipping to `"succeeded"`. 0 (default) = succeeds immediately on the first
   * poll. >0 exercises the multi-tick poll loop (the import-mode long-running
   * provisioning path).
   */
  vaultProvisionTicks?: number;
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
    polled: [],
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
  // hub#616: per-op countdown of remaining `"running"` poll ticks before the
  // op flips to `"succeeded"` (see FakeHubState.vaultProvisionTicks).
  const opTicksRemaining = new Map<string, number>();

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

    // GET /admin/setup (incl. the `?op=<id>` poll surface — hub#616)
    if (url.pathname === "/admin/setup" && method === "GET") {
      let step: "welcome" | "vault" | "expose" | "done" = "welcome";
      if (state.hasAdmin && state.hasVault && state.hasExposeMode) step = "done";
      else if (state.hasAdmin && state.hasVault) step = "expose";
      else if (state.hasAdmin) step = "vault";
      // hub#616: the CLI wizard polls vault provisioning via this session-authed
      // GET with `?op=<id>`; the op snapshot rides in the `operation` field.
      const opId = url.searchParams.get("op");
      if (opId) state.polled.push(path);
      const op = opId ? ops.get(opId) : undefined;
      // hub#616: drive a multi-tick op (running → succeeded) so the poll loop
      // is exercised across more than one fetch when configured.
      if (op && op.status === "running") {
        const remaining = opTicksRemaining.get(op.id) ?? 0;
        if (remaining <= 0) {
          op.status = "succeeded";
          state.hasVault = true;
        } else {
          opTicksRemaining.set(op.id, remaining - 1);
        }
      }
      const respBody = JSON.stringify({
        step,
        hasAdmin: state.hasAdmin,
        hasVault: state.hasVault,
        hasExposeMode: state.hasExposeMode,
        requireBootstrapToken: state.requireBootstrapToken ?? false,
        csrfToken: csrf,
        // hub#576: a loopback probe carries the actual token value.
        ...(state.bootstrapToken ? { bootstrapToken: state.bootstrapToken } : {}),
        ...(op ? { operation: op } : {}),
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
      // Create an op. By default it succeeds immediately on the first poll;
      // when `vaultProvisionTicks` is set it reports `"running"` for that many
      // poll ticks first (hub#616 — exercises the multi-tick poll loop).
      const opId = `op-test-${++opCount}`;
      const ticks = state.vaultProvisionTicks ?? 0;
      if (ticks > 0) {
        ops.set(opId, { id: opId, status: "running", log: ["bun add -g"] });
        opTicksRemaining.set(opId, ticks);
      } else {
        ops.set(opId, { id: opId, status: "succeeded", log: ["bun add -g", "spawned"] });
        state.hasVault = true;
      }
      return new Response(JSON.stringify({ op_id: opId, step: "vault", mode: b.mode }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // GET /api/modules/operations/<id> — the Bearer-gated SPA/install-CLI poll
    // surface. hub#616: the CLI wizard must NOT use it (it holds only a session
    // cookie, not a host-admin Bearer). Mirror the real 401 so any regression
    // back to this path fails the wizard poll loudly instead of silently.
    if (url.pathname.startsWith("/api/modules/operations/") && method === "GET") {
      return new Response(
        JSON.stringify({
          error: "unauthenticated",
          error_description: "Authorization: Bearer required",
        }),
        { status: 401, headers: { "content-type": "application/json; charset=utf-8" } },
      );
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

  test("parses --transcribe-mode + --transcribe-key + --config-dir", () => {
    const r = parseWizardArgs([
      "--hub-url",
      "http://x",
      "--transcribe-mode",
      "groq",
      "--transcribe-key",
      "gsk_test",
      "--config-dir",
      "/tmp/ph",
    ]);
    expect("error" in r).toBe(false);
    if ("error" in r) throw new Error(r.error);
    expect(r.opts.transcribeMode).toBe("groq");
    expect(r.opts.transcribeApiKey).toBe("gsk_test");
    expect(r.opts.configDir).toBe("/tmp/ph");
  });

  test("rejects invalid --transcribe-mode", () => {
    const r = parseWizardArgs(["--hub-url", "http://x", "--transcribe-mode", "garbage"]);
    expect("error" in r).toBe(true);
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
    // hub#616: the vault-provisioning op is polled over the session-authed
    // wizard surface, NOT the Bearer-gated /api/modules/operations/:id (which
    // the fake 401s, mirroring the real gate). At least one poll must land on
    // /admin/setup?op=, and every poll must use that path.
    expect(state.polled.length).toBeGreaterThan(0);
    for (const p of state.polled) expect(p.startsWith("/admin/setup?op=")).toBe(true);
  });

  test("multi-tick vault op (running → succeeded) polls the session surface across ticks — hub#616", async () => {
    // Models the import-mode long-running provisioning path: the op reports
    // `running` for two poll ticks before flipping to `succeeded`.
    const { state, fetchImpl } = makeFakeHub({ vaultProvisionTicks: 2 });
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
    // The loop ran more than once (2 running ticks + the terminal succeeded
    // poll), and every tick used the session-authed surface — never the
    // Bearer-gated /api/modules/operations/:id.
    expect(state.polled.length).toBeGreaterThanOrEqual(3);
    for (const p of state.polled) expect(p.startsWith("/admin/setup?op=")).toBe(true);
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

  test("password validator floor is 12 (matches the server) — an 11-char password is rejected", async () => {
    const { fetchImpl } = makeFakeHub();
    const logs: string[] = [];
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: (l) => logs.push(l),
      fetchImpl,
      sleep: async () => {},
      accountUsername: "admin",
      accountPassword: "elevenchar.", // 11 chars
      vaultMode: "skip",
      exposeMode: "localhost",
    });
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("at least 12 characters");
  });

  test("exactly 12 chars passes the validator (no early bounce)", async () => {
    const { state, fetchImpl } = makeFakeHub();
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      accountUsername: "admin",
      accountPassword: "twelvecharss", // 12 chars
      vaultMode: "skip",
      exposeMode: "localhost",
    });
    expect(code).toBe(0);
    expect(state.posted.some((p) => p.path === "/admin/setup/account")).toBe(true);
  });

  test("transcription step runs between vault and expose when configDir is set", async () => {
    const { state, fetchImpl } = makeFakeHub();
    const transcribeCmds: string[][] = [];
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      accountUsername: "admin",
      accountPassword: "longpassword",
      vaultMode: "skip",
      exposeMode: "localhost",
      configDir: "/tmp/never-written-none-mode",
      transcribeMode: "none", // none writes nothing + spawns nothing
      transcribeRunCommand: async (cmd) => {
        transcribeCmds.push([...cmd]);
        return 0;
      },
    });
    expect(code).toBe(0);
    // The vault + expose POSTs still happened in order.
    expect(state.posted.map((p) => p.path)).toEqual([
      "/admin/setup/account",
      "/admin/setup/vault",
      "/admin/setup/expose",
    ]);
    // mode=none → no transcription subprocess.
    expect(transcribeCmds).toEqual([]);
  });

  test("transcription step (cloud) drives the install one-shot via the injected runner", async () => {
    const { fetchImpl } = makeFakeHub();
    const transcribeCmds: string[][] = [];
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      accountUsername: "admin",
      accountPassword: "longpassword",
      vaultMode: "skip",
      exposeMode: "localhost",
      configDir: "/tmp/never-written-cloud-mode",
      transcribeMode: "groq",
      transcribeApiKey: "gsk_wired",
      platform: "linux",
      transcribeRunCommand: async (cmd) => {
        transcribeCmds.push([...cmd]);
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(transcribeCmds[0]).toEqual([
      "parachute",
      "install",
      "scribe",
      "--scribe-provider",
      "groq",
      "--scribe-key",
      "gsk_wired",
    ]);
  });

  test("transcription step is skipped when configDir is absent", async () => {
    const { state, fetchImpl } = makeFakeHub();
    let ran = false;
    const code = await runCliWizard({
      hubUrl: "http://127.0.0.1:1939",
      log: () => {},
      fetchImpl,
      sleep: async () => {},
      accountUsername: "admin",
      accountPassword: "longpassword",
      vaultMode: "skip",
      exposeMode: "localhost",
      // no configDir
      transcribeRunCommand: async () => {
        ran = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(state.posted.map((p) => p.path)).toEqual([
      "/admin/setup/account",
      "/admin/setup/vault",
      "/admin/setup/expose",
    ]);
  });

  test("non-interactive stdin fails fast (no hang) when a required answer is missing", async () => {
    // Headless-hardening: with stdin closed (cloud-init, `ssh host 'parachute
    // setup-wizard …'`, run.sh-exec'd stages.sh) an unanswered prompt would
    // busy-hang Bun's readline question() forever. defaultPrompt now throws a
    // clear, flag-naming error instead. We drive the real defaultPrompt (no
    // `prompt` seam) with the account username unsupplied, forcing the account
    // step to prompt — and force isTTY=false so the assertion is deterministic
    // regardless of how the test runner's stdin is wired.
    const { fetchImpl } = makeFakeHub();
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(
        runCliWizard({
          hubUrl: "http://127.0.0.1:1939",
          log: () => {},
          fetchImpl,
          sleep: async () => {},
          // no accountUsername → account step calls the real defaultPrompt.
          accountPassword: "longpassword",
          vaultMode: "skip",
          exposeMode: "localhost",
        }),
      ).rejects.toThrow(/stdin is not interactive/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });

  test("headless runCliWizard with NO --transcribe-mode completes (transcription defaults to none, not a throw)", async () => {
    // Regression guard for the review must-fix: `runCliWizard` used to forward
    // its (throwing) `defaultPrompt` into the transcription step, so a headless
    // run with account/vault/expose all supplied via flags but NO
    // `--transcribe-mode` would THROW at the transcription step ("cannot prompt
    // for: Pick [1]:") instead of defaulting to none. The wizard now forwards a
    // prompt to the transcription step ONLY when a real seam is injected, so
    // headless hits `resolveChoice`'s undefined-prompt non-TTY guard → none.
    const { state, fetchImpl } = makeFakeHub();
    const logs: string[] = [];
    let ran = false;
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const code = await runCliWizard({
        hubUrl: "http://127.0.0.1:1939",
        log: (l) => logs.push(l),
        fetchImpl,
        sleep: async () => {},
        accountUsername: "admin",
        accountPassword: "longpassword",
        vaultMode: "skip",
        exposeMode: "localhost",
        configDir: "/tmp/pcli-wizard-headless-none", // triggers the step; none writes nothing
        // NO transcribeMode, NO prompt seam → headless must default to none.
        transcribeRunCommand: async () => {
          ran = true;
          return 0;
        },
      });
      expect(code).toBe(0); // completed, did NOT throw
      expect(ran).toBe(false); // none → no scribe install
      expect(logs.join("\n")).toContain("Transcription off");
      // Full flow still walked account → vault → expose.
      expect(state.posted.map((p) => p.path)).toEqual([
        "/admin/setup/account",
        "/admin/setup/vault",
        "/admin/setup/expose",
      ]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });
});
