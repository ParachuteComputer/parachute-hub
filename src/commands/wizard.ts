/**
 * `parachute setup-wizard` — the in-terminal mirror of `/admin/setup`
 * (hub#168 Cut 3 of the wizard-parity work; Aaron's 2026-05-28 directive:
 * "we should be able to move through a setup wizard on the command line").
 *
 * The CLI wizard is a thin terminal-prompt frontend over the SAME backend
 * the browser wizard hits. There is exactly one source of truth for what
 * "set up an admin account" / "create or import a vault" / "pick an
 * expose mode" mean — `src/setup-wizard.ts`'s handlers — and both surfaces
 * drive it.
 *
 * Why no parallel logic on the CLI side: the failure modes the wizard
 * surfaces (username taken, weak password, vault-name validation, mirror
 * import errors) are already exercised through the HTTP path with rich
 * messages and state derivation. Re-implementing them on the CLI side
 * would let the two surfaces drift; threading the CLI through the same
 * endpoints means the next bug fix on the browser flow lands for both
 * automatically.
 *
 * The CLI POSTs `application/json` bodies; the browser POSTs
 * `application/x-www-form-urlencoded`. The wizard handlers accept both
 * shapes after this PR (see setup-wizard.ts: when content-type is
 * `application/json`, the body is parsed as JSON and projected into the
 * same field-string shape `req.formData()` produces — keeps every
 * branch downstream of body parsing identical).
 *
 * Cookie jar: setup-wizard's handlers mint a session cookie on the
 * `/admin/setup/account` 303 redirect, plus a CSRF cookie on the GETs.
 * The CLI uses a tiny in-memory jar to carry both forward across
 * subsequent POSTs. The CSRF token is also embedded in the JSON body of
 * each POST (matching the form-field name `_csrf`), since the
 * verifyCsrfToken helper checks the body shape rather than a header.
 *
 * Run-from-flag escape: every prompt accepts a paired CLI flag so a
 * fully non-interactive `parachute setup-wizard --account-username X
 * --account-password Y --vault-name Z` works for CI / scripted setup.
 * Mirrors the env-var seeding path that already exists for
 * `PARACHUTE_INITIAL_ADMIN_*`.
 */

import { createInterface } from "node:readline/promises";
import { configDir } from "../config.ts";
import { CSRF_COOKIE_NAME, CSRF_FIELD_NAME } from "../csrf.ts";
import { SESSION_COOKIE_NAME } from "../sessions.ts";
import { type WizardCommandRunner, walkTranscriptionStep } from "./wizard-transcription.ts";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — generous enough for a slow `bun add` over a flaky connection.
const VALID_VAULT_MODES = ["create", "import", "skip"] as const;
export type VaultMode = (typeof VALID_VAULT_MODES)[number];

export interface RunCliWizardOpts {
  /**
   * Base URL of the hub — e.g. `http://127.0.0.1:1939`. No trailing slash.
   * Init passes this in; callers can supply an exposed URL too.
   */
  hubUrl: string;
  /** Log shim — production prints to stdout; tests capture into an array. */
  log: (line: string) => void;
  /**
   * Test seam: replace the readline prompt. Production uses
   * `node:readline/promises`. Tests inject a scripted queue.
   */
  prompt?: (question: string) => Promise<string>;
  /**
   * Test seam: replace `globalThis.fetch`. Production uses Bun's built-in
   * fetch; tests inject a request-router that fake-responds to each
   * `/admin/setup/*` path without standing up a real hub. Loose signature
   * (rather than `typeof fetch`) so callers don't have to match Bun's
   * extended fetch shape (the `preconnect` method etc.) — every internal
   * caller uses fetch as a function-of-(url, init), nothing more.
   */
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /**
   * Test seam: replace `setTimeout` used by op-polling so tests don't
   * actually wait 2 seconds per tick.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Non-interactive escape hatch: pre-supply the account-step answers.
   * Username defaults to `owner` when unset (aligned with
   * `parachute auth set-password` + the operator.token convention); password
   * is required (no default, no prompt → exit-with-error). Mirrors the
   * `PARACHUTE_INITIAL_ADMIN_*` env-seed shape.
   */
  accountUsername?: string;
  accountPassword?: string;
  /**
   * Bootstrap token (when the hub is in serve-mode and minted one on
   * boot). Optional — the on-box CLI surface typically runs the hub via
   * `bun src/hub-server.ts` which doesn't mint a token, so the wizard's
   * `requireBootstrapToken` flag stays false and we never prompt for it.
   * When the hub IS in container/serve mode and the token field is
   * required, pass `--bootstrap-token <value>` or set
   * `PARACHUTE_BOOTSTRAP_TOKEN` in the environment.
   */
  bootstrapToken?: string;
  /**
   * Vault step pre-answers. `vaultMode` is one of `create | import | skip`;
   * `vaultName` is required for `create` and `import`; the import-specific
   * fields apply only when `vaultMode === "import"`.
   */
  vaultMode?: VaultMode;
  vaultName?: string;
  vaultImportRemoteUrl?: string;
  vaultImportPat?: string;
  vaultImportReplace?: boolean;
  /**
   * Pre-supply the expose-mode answer. One of `localhost | tailnet |
   * public`. The on-box CLI surface defaults to `localhost` because
   * that's what an operator running `parachute init` typically wants;
   * the public/tailnet paths are the `parachute expose` chain's job, not
   * the wizard's.
   */
  exposeMode?: "localhost" | "tailnet" | "public";
  /**
   * `~/.parachute` (or the PARACHUTE_HOME override) — where scribe's config
   * lives. Required for the transcription step to write the chosen provider +
   * key. Init passes its resolved configDir; when absent the transcription
   * step is skipped (the wizard can still walk account / vault / expose).
   */
  configDir?: string;
  /**
   * Pre-supply the transcription answer (non-interactive escape, mirrors the
   * browser wizard's `scribe_provider`). `none` | `local` | `groq` | `openai`.
   */
  transcribeMode?: "none" | "local" | "groq" | "openai";
  /** Pre-supplied cloud transcription API key (groq / openai). */
  transcribeApiKey?: string;
  /**
   * Test seam: replace the transcription step's subprocess runner so tests
   * never install scribe / shell out. Threaded into `walkTranscriptionStep`.
   */
  transcribeRunCommand?: WizardCommandRunner;
  /** Test seam: platform override for the transcription step. */
  platform?: NodeJS.Platform;
  /** Test seam: available-RAM override (MiB) for the transcription step's gate. */
  availableRamMib?: number | null;
}

/** Cookie jar — tiny, in-memory, no persistence across runs. */
interface CookieJar {
  session?: string;
  csrf?: string;
}

interface FetchSetupResult {
  status: number;
  bodyText: string;
  setCookies: string[];
  location?: string;
  // Parsed JSON body when the response advertised application/json. Otherwise null.
  json?: unknown;
}

/**
 * Default readline prompt. Lives at module scope so tests can inject a
 * deterministic alternative through `opts.prompt`.
 */
async function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract a Set-Cookie's value by name. Mirrors the helper in
 * setup-wizard.test.ts — same regex, same caveats (Bun joins multiple
 * Set-Cookie values with `, ` between cookies, so we anchor on
 * `(?:^|, )<name>=…` rather than splitting on commas naively, which would
 * break `expires=Mon, 01 Jan …` values).
 */
function extractCookie(setCookies: string[], name: string): string | undefined {
  // Most hub Set-Cookie writes are one header per cookie. Walk each
  // header value first; fall back to the joined-line shape on the off
  // chance a Bun version returns the combined form.
  for (const raw of setCookies) {
    const re = new RegExp(`(?:^|;\\s*|,\\s*)${name}=([^;,]+)`);
    const m = raw.match(re);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/**
 * One-stop HTTP helper. Builds a request against `hubUrl`, threads the
 * cookie jar, optionally posts a JSON body, parses the response and
 * extracts cookies. The `Set-Cookie` collection differs slightly across
 * runtimes — Bun exposes each header as a separate entry via
 * `headers.getAll`, which is what we use; the fallback to
 * `headers.get("set-cookie")` covers test-injected `Response` instances.
 */
async function setupFetch(
  hubUrl: string,
  path: string,
  jar: CookieJar,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  init: { method?: string; jsonBody?: unknown } = {},
): Promise<FetchSetupResult> {
  const url = `${hubUrl.replace(/\/+$/, "")}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const cookies: string[] = [];
  if (jar.session) cookies.push(`${SESSION_COOKIE_NAME}=${jar.session}`);
  if (jar.csrf) cookies.push(`${CSRF_COOKIE_NAME}=${jar.csrf}`);
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  let body: string | undefined;
  if (init.jsonBody !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.jsonBody);
  }
  const res = await fetchImpl(url, {
    method: init.method ?? "GET",
    headers,
    body,
    // Don't auto-follow — the wizard returns 303 to /admin/setup, and
    // we want to inspect the Location header rather than chase it.
    redirect: "manual",
  });
  const bodyText = await res.text();
  // Collect Set-Cookie. Try `getAll` first (Bun + node18+ supported it
  // patchily), then `getSetCookie` (web-standard since 2023), then fall
  // back to splitting the joined header by cookie boundaries.
  let setCookies: string[];
  // Bun's headers expose `getSetCookie()` per WHATWG; defensively check.
  const headersWithGetSetCookie = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithGetSetCookie.getSetCookie === "function") {
    setCookies = headersWithGetSetCookie.getSetCookie();
  } else {
    const raw = res.headers.get("set-cookie") ?? "";
    // Bun-pre-1.2 joins with ", " between cookies; split conservatively
    // on cookie-name boundaries (e.g. `, sessionId=` / `, csrf=`). The
    // names we care about are known up front.
    setCookies = raw ? raw.split(/, (?=[A-Za-z_][A-Za-z0-9_-]*=)/) : [];
  }
  // Update the jar from this response so the next request rides the
  // freshly-minted cookies.
  const sessionId = extractCookie(setCookies, SESSION_COOKIE_NAME);
  if (sessionId !== undefined) jar.session = sessionId;
  const csrf = extractCookie(setCookies, CSRF_COOKIE_NAME);
  if (csrf !== undefined) jar.csrf = csrf;
  const result: FetchSetupResult = {
    status: res.status,
    bodyText,
    setCookies,
  };
  const location = res.headers.get("location");
  if (location !== null) result.location = location;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      result.json = JSON.parse(bodyText);
    } catch {
      // Malformed JSON — leave json undefined; caller surfaces bodyText
      // instead. Shouldn't happen on production responses but defends
      // against transient proxy errors.
    }
  }
  return result;
}

/**
 * Read the wizard's current state via GET /admin/setup with `accept:
 * application/json`. The setup-wizard's GET handler returns a JSON
 * envelope with `step`, `hasAdmin`, `hasVault`, `hasExposeMode`, the
 * current CSRF token, and a `requireBootstrapToken` flag when the
 * account step needs a token.
 */
interface WizardStateSnapshot {
  step: "welcome" | "account" | "vault" | "expose" | "done";
  hasAdmin: boolean;
  hasVault: boolean;
  hasExposeMode: boolean;
  requireBootstrapToken: boolean;
  /**
   * The actual bootstrap token, present ONLY when the wizard-state probe ran
   * over loopback (the on-box operator's own shell — hub#576). The hub returns
   * it so the CLI wizard can satisfy the first-claim gate transparently without
   * the operator copy-pasting it from the startup logs. Absent on any
   * public/tailnet probe.
   */
  bootstrapToken?: string;
  csrfToken: string;
  /** Optional URL to redirect to (when state is fully done — 301 to /login). */
  redirectTo?: string;
}

async function fetchWizardState(
  hubUrl: string,
  jar: CookieJar,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<WizardStateSnapshot> {
  const res = await setupFetch(hubUrl, "/admin/setup", jar, fetchImpl);
  // The HTTP layer responds with a 301 → /login when setup is already
  // complete. Surface that as a done state.
  if (res.status === 301 || res.status === 302) {
    return {
      step: "done",
      hasAdmin: true,
      hasVault: true,
      hasExposeMode: true,
      requireBootstrapToken: false,
      csrfToken: jar.csrf ?? "",
      ...(res.location !== undefined ? { redirectTo: res.location } : {}),
    };
  }
  if (res.status !== 200) {
    throw new Error(
      `Unexpected status ${res.status} from GET /admin/setup. Body: ${res.bodyText.slice(0, 200)}`,
    );
  }
  if (
    typeof res.json !== "object" ||
    res.json === null ||
    typeof (res.json as { step?: unknown }).step !== "string"
  ) {
    throw new Error(
      `Expected JSON envelope from GET /admin/setup (CLI wizard), got: ${res.bodyText.slice(0, 200)}`,
    );
  }
  const body = res.json as Partial<WizardStateSnapshot> & { csrfToken?: string };
  const snapshot: WizardStateSnapshot = {
    step: body.step ?? "welcome",
    hasAdmin: Boolean(body.hasAdmin),
    hasVault: Boolean(body.hasVault),
    hasExposeMode: Boolean(body.hasExposeMode),
    requireBootstrapToken: Boolean(body.requireBootstrapToken),
    csrfToken: typeof body.csrfToken === "string" ? body.csrfToken : (jar.csrf ?? ""),
  };
  // hub#576: the loopback probe carries the actual token. Thread it through so
  // the account step can submit it without prompting the operator.
  if (typeof body.bootstrapToken === "string" && body.bootstrapToken.length > 0) {
    snapshot.bootstrapToken = body.bootstrapToken;
  }
  return snapshot;
}

/**
 * Op-poll. The wizard's vault step returns `{ op_id }` on success and
 * the install proceeds asynchronously. We tick once per
 * `POLL_INTERVAL_MS` until the op reaches a terminal state or we hit
 * `POLL_TIMEOUT_MS`.
 *
 * Each tick logs a single-line status: `[op-<short>] running (last:
 * <last log line>)`. On success we log a `succeeded` line; on failure we
 * surface the error message and return non-zero.
 */
interface OperationSnapshot {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  log: readonly string[];
  error?: string;
}

async function pollOperation(
  hubUrl: string,
  opId: string,
  shortLabel: string,
  jar: CookieJar,
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  sleep: (ms: number) => Promise<void>,
  log: (l: string) => void,
): Promise<OperationSnapshot> {
  const start = Date.now();
  let lastLogIndex = 0;
  for (;;) {
    // hub#616: poll over the session-authed wizard surface (`/admin/setup?op=`),
    // mirroring the browser wizard's re-GET — NOT the Bearer-gated
    // `/api/modules/operations/:id` the SPA + install CLI use. Mid-setup the
    // wizard holds only a session cookie; the op endpoint demands a host-admin
    // Bearer it doesn't have, so a direct poll 401s and the vault step dies.
    // The op snapshot rides back in the envelope's `operation` field.
    const res = await setupFetch(
      hubUrl,
      `/admin/setup?op=${encodeURIComponent(opId)}`,
      jar,
      fetchImpl,
    );
    if (res.status !== 200) {
      throw new Error(
        `op-poll failed (${res.status}) for ${shortLabel} op ${opId}: ${res.bodyText.slice(0, 200)}`,
      );
    }
    const envelope = res.json as { operation?: Partial<OperationSnapshot> } | undefined;
    const body = envelope?.operation;
    if (!body || typeof body !== "object" || typeof body.id !== "string") {
      throw new Error(
        `op-poll returned no operation snapshot for ${shortLabel} op ${opId}: ${res.bodyText.slice(0, 200)}`,
      );
    }
    // Print any new log lines since the last tick so the operator sees
    // progress in real time rather than a silent spinner.
    const opLog = body.log ?? [];
    for (let i = lastLogIndex; i < opLog.length; i++) {
      log(`  [${shortLabel}] ${opLog[i]}`);
    }
    lastLogIndex = opLog.length;
    if (body.status === "succeeded" || body.status === "failed") {
      return {
        id: body.id,
        status: body.status,
        log: opLog,
        ...(body.error !== undefined ? { error: body.error } : {}),
      };
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error(
        `op-poll for ${shortLabel} op ${opId} timed out after ${POLL_TIMEOUT_MS / 1000}s`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Validate password length up front so we don't bounce off a 400 the operator
 * can't see. Floor is 12 to match the server (`PASSWORD_MIN_LEN`) AND this
 * wizard's own "min 12 chars" copy at the password prompt — the validator was
 * stuck at 8, contradicting both (onboarding-streamline hub PR1).
 */
function validatePassword(pw: string): string | undefined {
  if (pw.length < 12) return "Password must be at least 12 characters.";
  return undefined;
}

/**
 * Account step. Walks the username + password prompts (unless pre-supplied
 * via flags), POSTs `/admin/setup/account`, threads the resulting session
 * cookie into the jar. Returns 0 on success, non-zero on validation
 * failure / unrecoverable POST error.
 */
async function walkAccountStep(
  hubUrl: string,
  jar: CookieJar,
  state: WizardStateSnapshot,
  opts: RunCliWizardOpts & {
    prompt: (q: string) => Promise<string>;
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  },
): Promise<number> {
  const log = opts.log;
  log("");
  log("Step 1/3 — Admin account");
  log("  Set up the operator account that owns this hub.");
  let username = opts.accountUsername;
  if (username === undefined) {
    // Default to "owner" — aligns with `parachute auth set-password` and the
    // operator.token convention (the earliest-created user is the operator).
    // The web wizard lets the operator name it freely; so does this prompt.
    const raw = (await opts.prompt("  username [owner]: ")).trim();
    username = raw === "" ? "owner" : raw;
  }
  let password = opts.accountPassword;
  if (password === undefined) {
    log("  password — min 12 chars; will be hashed with argon2.");
    password = await opts.prompt("  password: ");
    const confirm = await opts.prompt("  confirm: ");
    if (password !== confirm) {
      log("  ✗ passwords don't match.");
      return 1;
    }
  }
  const pwErr = validatePassword(password);
  if (pwErr) {
    log(`  ✗ ${pwErr}`);
    return 1;
  }
  // Token resolution order (hub#576):
  //   1. Explicit `--bootstrap-token` flag / `opts.bootstrapToken` (init passes
  //      this when it fetched the token from the loopback probe).
  //   2. `PARACHUTE_BOOTSTRAP_TOKEN` env.
  //   3. The token carried on the loopback wizard-state probe itself — the
  //      common on-box `parachute init` path: the hub handed us the value
  //      because we reached it over loopback, so we satisfy the gate
  //      transparently with no operator action.
  //   4. Prompt — the fallback when none of the above apply (e.g. a remote
  //      `parachute init --cli-wizard` against a public hub, where the probe
  //      didn't carry the token). The operator reads it from the startup logs.
  // Treat an empty / whitespace value at any level as "absent" so a falsy
  // `PARACHUTE_BOOTSTRAP_TOKEN=` (exported-but-empty) doesn't suppress the
  // loopback-probe token and silently submit a blank token.
  const firstNonEmpty = (...vals: Array<string | undefined>): string | undefined =>
    vals.find((v) => typeof v === "string" && v.trim().length > 0);
  let bootstrap = firstNonEmpty(
    opts.bootstrapToken,
    process.env.PARACHUTE_BOOTSTRAP_TOKEN,
    state.bootstrapToken,
  );
  if (state.requireBootstrapToken && !bootstrap) {
    log("");
    log("  This hub is in container/serve mode and minted a one-time");
    log("  bootstrap token at boot. Find the `parachute-bootstrap-…` line");
    log("  in the hub's startup logs.");
    bootstrap = (await opts.prompt("  bootstrap token: ")).trim();
  }
  const jsonBody: Record<string, string> = {
    [CSRF_FIELD_NAME]: state.csrfToken,
    username,
    password,
    password_confirm: password,
  };
  if (bootstrap) jsonBody.bootstrap_token = bootstrap;
  const res = await setupFetch(hubUrl, "/admin/setup/account", jar, opts.fetchImpl, {
    method: "POST",
    jsonBody,
  });
  // The handler issues a 303 redirect on the browser path + a 200 JSON
  // envelope on the CLI path (Content-Type: application/json branch);
  // on 400/401 we surface a structured error. With the JSON request
  // path we expect 200; the 303 branch is kept for robustness in case
  // a future handler tweak short-circuits to the browser shape.
  if (res.status === 200 || res.status === 303 || res.status === 302) {
    log("  ✓ admin account created.");
    return 0;
  }
  if (res.status === 401) {
    log("  ✗ bootstrap token rejected. Double-check the value in the hub's startup logs.");
    return 1;
  }
  if (res.status === 400 || res.status === 410) {
    const message =
      (res.json as { message?: string } | undefined)?.message ?? res.bodyText.slice(0, 200);
    log(`  ✗ account creation failed: ${message}`);
    return 1;
  }
  log(`  ✗ unexpected response ${res.status}: ${res.bodyText.slice(0, 200)}`);
  return 1;
}

/**
 * Vault step. Three modes:
 *   * create — name input → POST /admin/setup/vault with mode=create
 *   * import — name + remote_url + (optional) pat + mode (merge/replace)
 *   * skip   — no instance created (just module installed earlier)
 *
 * On create / import the handler returns `{ op_id }` for the in-flight
 * install / import. We poll it and surface per-tick log lines.
 */
async function walkVaultStep(
  hubUrl: string,
  jar: CookieJar,
  state: WizardStateSnapshot,
  opts: RunCliWizardOpts & {
    prompt: (q: string) => Promise<string>;
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<number> {
  const log = opts.log;
  log("");
  log("Step 2/3 — Vault");
  log("  A vault is the per-workspace SQLite + MCP store. You can also");
  log("  import one from a git repo, or skip and create one later from");
  log("  the admin UI.");
  let mode: VaultMode | undefined = opts.vaultMode;
  if (mode === undefined) {
    log("");
    log("  1) Create a new vault (default)");
    log("  2) Import from a git repo");
    log("  3) Skip — don't create a vault now");
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = (await opts.prompt("  Pick [1]: ")).trim().toLowerCase();
      if (raw === "" || raw === "1" || raw === "create" || raw === "c") {
        mode = "create";
        break;
      }
      if (raw === "2" || raw === "import" || raw === "i") {
        mode = "import";
        break;
      }
      if (raw === "3" || raw === "skip" || raw === "s") {
        mode = "skip";
        break;
      }
      log(`  Sorry — expected 1, 2, or 3 (got "${raw}"). Try again.`);
    }
    if (mode === undefined) {
      log("  ✗ Too many invalid entries; aborting vault step.");
      return 1;
    }
  }
  const jsonBody: Record<string, unknown> = {
    [CSRF_FIELD_NAME]: state.csrfToken,
    mode,
  };
  if (mode === "create" || mode === "import") {
    let vaultName = opts.vaultName;
    if (vaultName === undefined) {
      const raw = (await opts.prompt("  vault name [default]: ")).trim();
      vaultName = raw === "" ? "default" : raw;
    }
    jsonBody.vault_name = vaultName;
  }
  if (mode === "import") {
    let remoteUrl = opts.vaultImportRemoteUrl;
    if (remoteUrl === undefined) {
      remoteUrl = (await opts.prompt("  remote URL (https://… or git@…): ")).trim();
    }
    if (!remoteUrl) {
      log("  ✗ Remote URL required for import.");
      return 1;
    }
    jsonBody.remote_url = remoteUrl;
    let pat = opts.vaultImportPat;
    if (pat === undefined) {
      pat = (await opts.prompt("  PAT (or Enter to skip — public repos work without): ")).trim();
    }
    if (pat) jsonBody.pat = pat;
    if (opts.vaultImportReplace !== undefined) {
      jsonBody.import_mode = opts.vaultImportReplace ? "replace" : "merge";
    } else {
      const raw = (await opts.prompt("  Replace existing notes? [y/N]: ")).trim().toLowerCase();
      jsonBody.import_mode = raw === "y" || raw === "yes" ? "replace" : "merge";
    }
  }
  const res = await setupFetch(hubUrl, "/admin/setup/vault", jar, opts.fetchImpl, {
    method: "POST",
    jsonBody,
  });
  if (mode === "skip") {
    if (res.status === 303 || res.status === 302 || res.status === 200) {
      log("  ✓ Vault step skipped (you can create or import a vault later from /admin).");
      return 0;
    }
    log(`  ✗ Skip-step POST failed (${res.status}): ${res.bodyText.slice(0, 200)}`);
    return 1;
  }
  if (res.status !== 303 && res.status !== 302 && res.status !== 200) {
    log(`  ✗ Vault POST failed (${res.status}): ${res.bodyText.slice(0, 200)}`);
    return 1;
  }
  // Successful POSTs surface an op_id either in the redirect query
  // (`Location: /admin/setup?op=<id>`) or in the JSON envelope. Prefer
  // the JSON shape (it's unambiguous and survives proxies that munge
  // location headers); fall back to the Location query.
  let opId: string | undefined;
  const bodyOpId =
    (res.json as { op_id?: string; opId?: string } | undefined)?.op_id ??
    (res.json as { op_id?: string; opId?: string } | undefined)?.opId;
  if (typeof bodyOpId === "string" && bodyOpId.length > 0) {
    opId = bodyOpId;
  } else if (res.location) {
    try {
      const u = new URL(res.location, hubUrl);
      const fromQuery = u.searchParams.get("op");
      if (fromQuery) opId = fromQuery;
    } catch {
      // ignore malformed location
    }
  }
  if (!opId) {
    log(
      "  ✓ Vault step POSTed; no op_id surfaced (the wizard may have short-circuited an idempotent run).",
    );
    return 0;
  }
  log("");
  log(`  Provisioning vault (op ${opId}) — this usually takes 10–60 seconds…`);
  const finalState = await pollOperation(
    hubUrl,
    opId,
    "vault",
    jar,
    opts.fetchImpl,
    opts.sleep,
    log,
  );
  if (finalState.status === "succeeded") {
    log(mode === "import" ? "  ✓ Vault imported." : "  ✓ Vault ready.");
    return 0;
  }
  log(`  ✗ Vault ${mode} failed: ${finalState.error ?? "(no detail)"}.`);
  return 1;
}

/**
 * Expose step. The browser wizard's expose step also auto-mints the
 * single-use operator token surfaced on the done screen; the CLI mirror
 * here just POSTs the mode and trusts the handler to do that work.
 */
async function walkExposeStep(
  hubUrl: string,
  jar: CookieJar,
  state: WizardStateSnapshot,
  opts: RunCliWizardOpts & {
    prompt: (q: string) => Promise<string>;
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  },
): Promise<number> {
  const log = opts.log;
  log("");
  log("Step 3/3 — Expose mode");
  log("  Where is this hub reachable from?");
  let mode = opts.exposeMode;
  if (mode === undefined) {
    log("  1) localhost — just this machine (default)");
    log("  2) tailnet  — Tailscale network");
    log("  3) public   — custom domain / reverse proxy");
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = (await opts.prompt("  Pick [1]: ")).trim().toLowerCase();
      if (raw === "" || raw === "1" || raw === "localhost" || raw === "l") {
        mode = "localhost";
        break;
      }
      if (raw === "2" || raw === "tailnet" || raw === "t") {
        mode = "tailnet";
        break;
      }
      if (raw === "3" || raw === "public" || raw === "p") {
        mode = "public";
        break;
      }
      log(`  Sorry — expected 1, 2, or 3 (got "${raw}").`);
    }
    if (mode === undefined) {
      log("  ✗ Too many invalid entries; aborting expose step.");
      return 1;
    }
  }
  const res = await setupFetch(hubUrl, "/admin/setup/expose", jar, opts.fetchImpl, {
    method: "POST",
    jsonBody: {
      [CSRF_FIELD_NAME]: state.csrfToken,
      expose_mode: mode,
    },
  });
  if (res.status === 303 || res.status === 302 || res.status === 200) {
    log(`  ✓ Expose mode set to ${mode}.`);
    return 0;
  }
  log(`  ✗ Expose POST failed (${res.status}): ${res.bodyText.slice(0, 200)}`);
  return 1;
}

/**
 * The CLI wizard entry point. Walks Account → Vault → Expose in order,
 * skipping any step that's already complete (idempotent re-runs land on
 * the next undone step, just like the browser wizard).
 */
export async function runCliWizard(opts: RunCliWizardOpts): Promise<number> {
  const prompt = opts.prompt ?? defaultPrompt;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log;
  const hubUrl = opts.hubUrl.replace(/\/+$/, "");
  const ctx = { ...opts, prompt, fetchImpl, sleep };
  const jar: CookieJar = {};

  log("");
  log("Parachute setup wizard (CLI).");
  log(`  Hub: ${hubUrl}`);
  // Initial state probe to find where to resume. Walks every step in
  // sequence; each step's pre-condition reads from the freshly-fetched
  // state so an idempotent re-run picks up at the right place.
  let state = await fetchWizardState(hubUrl, jar, fetchImpl);
  if (state.step === "welcome" || state.step === "account") {
    const code = await walkAccountStep(hubUrl, jar, state, ctx);
    if (code !== 0) return code;
    // Refresh state — the account POST set the session cookie + advanced
    // the wizard. The next GET picks up the new step.
    state = await fetchWizardState(hubUrl, jar, fetchImpl);
  }
  if (state.step === "vault") {
    const code = await walkVaultStep(hubUrl, jar, state, ctx);
    if (code !== 0) return code;
    state = await fetchWizardState(hubUrl, jar, fetchImpl);
  }
  // Transcription step (onboarding-streamline hub PR1) — the CLI's parity with
  // the browser wizard's folded scribe sub-form. The hub's setup-state machine
  // has no "transcription" step (scribe is a module install, not a wizard gate),
  // so this runs unconditionally between vault and expose rather than off
  // `state.step`. Skipped without a configDir (nowhere to write scribe config).
  // Non-fatal: a transcription that couldn't be set up never blocks setup.
  if (opts.configDir !== undefined) {
    await walkTranscriptionStep({
      configDir: opts.configDir,
      log,
      prompt,
      ...(opts.transcribeMode !== undefined ? { transcribeMode: opts.transcribeMode } : {}),
      ...(opts.transcribeApiKey !== undefined ? { transcribeApiKey: opts.transcribeApiKey } : {}),
      ...(opts.transcribeRunCommand !== undefined ? { runCommand: opts.transcribeRunCommand } : {}),
      ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
      ...(opts.availableRamMib !== undefined ? { availableRamMib: opts.availableRamMib } : {}),
    });
  }
  if (state.step === "expose") {
    const code = await walkExposeStep(hubUrl, jar, state, ctx);
    if (code !== 0) return code;
    state = await fetchWizardState(hubUrl, jar, fetchImpl);
  }
  // Done screen — fetch + show a brief summary. The browser wizard's
  // done screen surfaces the bare OAuth `claude mcp add` command (no
  // token, no header — vault is OAuth-default per parachute-vault #491);
  // the CLI path never minted a token, so we just point the operator at
  // the admin SPA + /admin/tokens for the headless-client case.
  log("");
  log("✓ Setup complete.");
  log(`  Visit ${hubUrl}/admin/ to open the admin SPA.`);
  log(`  Mint MCP / operator tokens at ${hubUrl}/admin/tokens.`);
  return 0;
}

/**
 * Argv parser for `parachute setup-wizard`. Accepts the same shape the
 * browser wizard supports plus the run-from-flag escape hatch.
 *
 * Exported so tests (and the cli.ts dispatcher) can drive it directly.
 * Returns either a parsed-options object or an error string.
 */
export interface ParsedWizardArgs {
  noBrowser: boolean;
  hubUrl?: string;
  opts: Omit<RunCliWizardOpts, "log">;
}

export function parseWizardArgs(args: readonly string[]): ParsedWizardArgs | { error: string } {
  const out: ParsedWizardArgs = {
    noBrowser: false,
    opts: { hubUrl: "" },
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--no-browser") {
      out.noBrowser = true;
      continue;
    }
    const eq = a.indexOf("=");
    let key: string;
    let value: string | undefined;
    if (eq > 0) {
      key = a.slice(0, eq);
      value = a.slice(eq + 1);
    } else {
      key = a;
      value = args[i + 1];
    }
    const consumeValue = (): boolean => {
      if (value === undefined || value === "") return false;
      if (eq <= 0) i++;
      return true;
    };
    switch (key) {
      case "--hub-url":
      case "--hub":
        if (!consumeValue()) return { error: `${key} requires a URL` };
        out.hubUrl = value;
        out.opts.hubUrl = value as string;
        break;
      case "--account-username":
        if (!consumeValue()) return { error: `${key} requires a value` };
        out.opts.accountUsername = value;
        break;
      case "--account-password":
        if (!consumeValue()) return { error: `${key} requires a value` };
        out.opts.accountPassword = value;
        break;
      case "--bootstrap-token":
        if (!consumeValue()) return { error: `${key} requires a value` };
        out.opts.bootstrapToken = value;
        break;
      case "--vault-mode":
        if (!consumeValue()) return { error: `${key} requires a value` };
        if (!VALID_VAULT_MODES.includes(value as VaultMode)) {
          return { error: `${key} must be one of ${VALID_VAULT_MODES.join(", ")}` };
        }
        out.opts.vaultMode = value as VaultMode;
        break;
      case "--vault-name":
        if (!consumeValue()) return { error: `${key} requires a value` };
        out.opts.vaultName = value;
        break;
      case "--vault-import-url":
        if (!consumeValue()) return { error: `${key} requires a URL` };
        out.opts.vaultImportRemoteUrl = value;
        // Implied vault-mode unless the caller already chose another:
        if (out.opts.vaultMode === undefined) out.opts.vaultMode = "import";
        break;
      case "--vault-import-pat":
        if (!consumeValue()) return { error: `${key} requires a value` };
        out.opts.vaultImportPat = value;
        break;
      case "--vault-import-replace":
        out.opts.vaultImportReplace = true;
        break;
      case "--skip-vault":
        out.opts.vaultMode = "skip";
        break;
      case "--expose-mode":
        if (!consumeValue()) return { error: `${key} requires a value` };
        if (value !== "localhost" && value !== "tailnet" && value !== "public") {
          return { error: `${key} must be one of localhost, tailnet, public` };
        }
        out.opts.exposeMode = value;
        break;
      case "--transcribe-mode":
        if (!consumeValue()) return { error: `${key} requires a value` };
        if (value !== "none" && value !== "local" && value !== "groq" && value !== "openai") {
          return { error: `${key} must be one of none, local, groq, openai` };
        }
        out.opts.transcribeMode = value;
        break;
      case "--transcribe-key":
        if (!consumeValue()) return { error: `${key} requires a value` };
        out.opts.transcribeApiKey = value;
        break;
      case "--config-dir":
        if (!consumeValue()) return { error: `${key} requires a path` };
        out.opts.configDir = value;
        break;
      default:
        if (a.startsWith("--")) return { error: `unknown argument "${a}"` };
        return { error: `unexpected positional argument "${a}"` };
    }
  }
  if (!out.opts.hubUrl) {
    return { error: "--hub-url is required (e.g. http://127.0.0.1:1939)" };
  }
  return out;
}

/**
 * Top-level entry point invoked by cli.ts for `parachute setup-wizard`.
 * Parses argv, runs the wizard, returns the exit code.
 */
export async function runSetupWizardCommand(args: readonly string[]): Promise<number> {
  const parsed = parseWizardArgs(args);
  if ("error" in parsed) {
    console.error(`parachute setup-wizard: ${parsed.error}`);
    console.error(
      "usage: parachute setup-wizard --hub-url <url>\n" +
        "                              [--account-username <name>] [--account-password <pw>]\n" +
        "                              [--bootstrap-token <token>]\n" +
        "                              [--vault-mode create|import|skip] [--vault-name <name>]\n" +
        "                              [--vault-import-url <url>] [--vault-import-pat <pat>] [--vault-import-replace]\n" +
        "                              [--transcribe-mode none|local|groq|openai] [--transcribe-key <key>]\n" +
        "                              [--config-dir <path>]\n" +
        "                              [--expose-mode localhost|tailnet|public]",
    );
    return 1;
  }
  // Default configDir from PARACHUTE_HOME (matching the rest of the CLI) so the
  // standalone `parachute setup-wizard` invocation can run the transcription
  // step. An explicit `--config-dir` wins.
  const wizardOpts = { ...parsed.opts };
  if (wizardOpts.configDir === undefined) wizardOpts.configDir = configDir();
  return await runCliWizard({
    ...wizardOpts,
    log: (line) => console.log(line),
  });
}
