/**
 * First-boot setup wizard at `/admin/setup` (hub#259).
 *
 * Server-rendered, three-step form that walks a fresh operator through:
 *
 *   1. Welcome — what they're about to set up (admin account + first vault).
 *   2. Account — username + password → POST `/admin/setup/account`.
 *      Creates the admin row via `createUser`, sets a `parachute_hub_session`
 *      cookie + a `parachute_hub_csrf` cookie, redirects back to
 *      `/admin/setup`.
 *   3. Vault — pick a name (default `default`) → POST `/admin/setup/vault`.
 *      Gated by the just-minted admin session cookie. Drives the same
 *      `runInstall` path the `/api/modules/:short/install` API uses, just
 *      without re-fabricating an HTTP request + bearer. Returns + redirects
 *      to `/admin/setup?op=<id>` so the same wizard page polls the
 *      operation registry.
 *   4. Done — links to the admin SPA, MCP install hints, "what's next."
 *
 * The wizard is server-rendered (no SPA bundle, no JS). Step 3's progress
 * poll is a `<meta http-equiv="refresh" content="2">` — works without JS
 * and is fine for a 30-second one-shot install on first boot.
 *
 * Idempotency: the rendered step is derived from DB + services.json on
 * every GET. If a user already exists but no vault, the wizard resumes
 * at step 3. If both exist, it resumes at step 4. Once both exist + a
 * full minute has elapsed since the user was created, subsequent GETs
 * 301 to `/login` (the canonical post-setup entry).
 *
 * No email collection (the brief). Magic-link recovery is a later phase.
 * No 2FA in this wizard either — adds it later; the launch posture is
 * "username + password is fine for a fresh hub."
 *
 * History: replaces the static placeholder `renderSetupPlaceholder` from
 * the hub#258 setup-gate scaffold. The env-var seed path
 * (`PARACHUTE_INITIAL_ADMIN_USERNAME` + `PARACHUTE_INITIAL_ADMIN_PASSWORD`)
 * still works for container operators who prefer to bake the admin into
 * the boot path; documented as an alternative on the welcome screen.
 */

import type { Database } from "bun:sqlite";
import { type OperationsRegistry, runInstall, specFor } from "./api-modules-ops.ts";
import type { CuratedModuleShort } from "./api-modules.ts";
import {
  CSRF_FIELD_NAME,
  ensureCsrfToken,
  renderCsrfHiddenInput,
  verifyCsrfToken,
} from "./csrf.ts";
import { escapeHtml } from "./oauth-ui.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import { findService, readManifest } from "./services-manifest.ts";
import {
  SESSION_TTL_MS,
  buildSessionCookie,
  createSession,
  findActiveSession,
} from "./sessions.ts";
import type { Supervisor } from "./supervisor.ts";
import { createUser, userCount } from "./users.ts";

// --- shared chrome --------------------------------------------------------

const PALETTE = {
  bg: "#faf8f4",
  fg: "#2c2a26",
  fgMuted: "#6b6860",
  fgDim: "#9a9690",
  accent: "#4a7c59",
  accentHover: "#3d6849",
  accentSoft: "rgba(74, 124, 89, 0.08)",
  border: "#e4e0d8",
  borderLight: "#ece9e2",
  cardBg: "#ffffff",
  danger: "#a3392b",
  dangerSoft: "rgba(163, 57, 43, 0.08)",
  success: "#3d6849",
  warn: "#d4a017",
  warnSoft: "#fff8e1",
} as const;

const FONT_SERIF = `Georgia, "Times New Roman", serif`;
const FONT_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const FONT_MONO = `ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace`;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// --- state derivation ----------------------------------------------------

export type WizardStep = "welcome" | "account" | "vault" | "done";

export interface DerivedWizardState {
  /** Current step the wizard should render. */
  step: WizardStep;
  /** Whether at least one user row exists. */
  hasAdmin: boolean;
  /** Whether the first vault (curated) has been provisioned in services.json. */
  hasVault: boolean;
}

/**
 * Vault is the canonical first-vault target for the wizard. The brief
 * specifies "first vault — pick a name (default: `default`)" and the
 * curated module list is what install / supervisor speak.
 */
export const FIRST_VAULT_SHORT: CuratedModuleShort = "vault";

/**
 * Read DB + services.json to decide which step the wizard should render.
 * Pure, idempotent — re-running the wizard after partial setup picks up
 * where it left off.
 */
export function deriveWizardState(deps: {
  db: Database;
  manifestPath: string;
}): DerivedWizardState {
  const hasAdmin = userCount(deps.db) > 0;
  // The wizard's first-vault provisioning uses the curated `vault` short,
  // which maps to `parachute-vault` in services.json.
  const vaultSpec = specFor(FIRST_VAULT_SHORT);
  const vaultEntry = findService(vaultSpec.manifestName, deps.manifestPath);
  const hasVault = vaultEntry !== undefined;
  let step: WizardStep;
  if (!hasAdmin) step = "welcome";
  else if (!hasVault) step = "vault";
  else step = "done";
  return { step, hasAdmin, hasVault };
}

// --- handler types -------------------------------------------------------

export interface SetupWizardDeps {
  db: Database;
  manifestPath: string;
  configDir: string;
  /**
   * Optional supervisor. Present under `parachute serve` (container
   * mode); absent under the on-box CLI surface. The wizard refuses
   * step-3 POSTs when absent — the operator is expected to use the CLI
   * (`parachute install vault`) in that posture, not the web wizard.
   */
  supervisor?: Supervisor;
  /**
   * Hub origin string for the JWT `iss` claim plumbed through to install
   * ops. Defaults to the hub's own loopback issuer when unset (consistent
   * with the rest of hub-server.ts when no PARACHUTE_HUB_ORIGIN is
   * configured).
   */
  issuer: string;
  /**
   * Test seam: inject an operations registry so the wizard's tests can
   * observe its install op without colliding with the default
   * process-singleton. Production omits this; both the API surface and
   * the wizard then share the same default registry, which is correct —
   * an `/api/modules/operations/:id` poll from the SPA can pick up an
   * op created by the wizard if for some reason a stale tab is open.
   */
  registry?: OperationsRegistry;
  /** Test seam: stub `bun add` / `bun remove` runner. */
  run?: (cmd: readonly string[]) => Promise<number>;
}

// --- rendering -----------------------------------------------------------

function baseDocument(title: string, body: string, autoRefresh?: number): string {
  const refresh = autoRefresh ? `<meta http-equiv="refresh" content="${autoRefresh}" />` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  ${refresh}
  <style>${STYLES}</style>
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>`;
}

function header(currentStep: WizardStep): string {
  const stepOrder: WizardStep[] = ["welcome", "account", "vault", "done"];
  // Step 1 (welcome) + step 2 (account) collapse on the rendered page —
  // we show them as a single combined form. The progress bar still names
  // them separately so the operator sees the shape.
  const labels: Record<WizardStep, string> = {
    welcome: "Welcome",
    account: "Account",
    vault: "Vault",
    done: "Done",
  };
  const items = stepOrder
    .map((s) => {
      const current = s === currentStep;
      const past = stepOrder.indexOf(s) < stepOrder.indexOf(currentStep);
      const cls = current ? "step current" : past ? "step past" : "step";
      const marker = past ? "✓" : `${stepOrder.indexOf(s) + 1}`;
      return `<li class="${cls}"><span class="step-marker">${marker}</span><span class="step-label">${escapeHtml(labels[s])}</span></li>`;
    })
    .join("");
  return `
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
          <span class="brand-tag">first-boot setup</span>
        </div>
        <ol class="steps">${items}</ol>`;
}

// --- step 1 + 2: welcome + account ---------------------------------------

export interface RenderAccountStepProps {
  csrfToken: string;
  errorMessage?: string;
  /** Pre-fill the username field after a validation failure. */
  username?: string;
}

export function renderAccountStep(props: RenderAccountStepProps): string {
  const { csrfToken, errorMessage, username } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  const usernameAttr = username ? ` value="${escapeAttr(username)}"` : "";
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("welcome")}
        <h1>Welcome to your Parachute hub</h1>
        <p class="subtitle">Two quick steps and you'll have a working stack —
          an admin account and your first vault. No email, no signup; this
          all stays on your machine (or your container).</p>
      </div>
      <section class="explainer">
        <h2>Why this step</h2>
        <p>A Parachute hub needs one admin operator before anything else can
          run — OAuth issuance, vault provisioning, the admin UI all need
          an identity behind them.</p>
        <h2>What's next</h2>
        <p>After this you'll name your first vault. The hub will install it
          and issue a token your Claude Code MCP client can use.</p>
      </section>
      ${error}
      <form method="POST" action="/admin/setup/account" class="auth-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <label class="field">
          <span class="field-label">Username</span>
          <input type="text" name="username" autocomplete="username"
            autofocus required minlength="2" maxlength="64"
            pattern="[A-Za-z0-9_.-]+" title="letters, digits, _ . - (2–64 chars)"
            ${usernameAttr} />
          <span class="field-hint">letters, digits, <code>_</code>, <code>.</code>, <code>-</code></span>
        </label>
        <label class="field">
          <span class="field-label">Password</span>
          <input type="password" name="password" autocomplete="new-password"
            required minlength="8" />
          <span class="field-hint">at least 8 characters</span>
        </label>
        <label class="field">
          <span class="field-label">Confirm password</span>
          <input type="password" name="password_confirm" autocomplete="new-password"
            required minlength="8" />
        </label>
        <button type="submit" class="btn btn-primary">Create admin & continue</button>
      </form>
      <details class="alt-path">
        <summary>Prefer to seed via env vars?</summary>
        <p>Set <code>PARACHUTE_INITIAL_ADMIN_USERNAME</code> and
          <code>PARACHUTE_INITIAL_ADMIN_PASSWORD</code> on the container and
          restart. The hub will create the admin row on next boot and skip this
          wizard.</p>
      </details>
    </div>`;
  return baseDocument("Set up your Parachute hub — account", body);
}

// --- step 3: vault -------------------------------------------------------

export interface RenderVaultStepProps {
  csrfToken: string;
  errorMessage?: string;
  /**
   * When an install op is in progress, render the polling shape: no
   * form, just the op log + auto-refresh.
   */
  operation?: {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed";
    log: readonly string[];
    error?: string;
  };
}

export function renderVaultStep(props: RenderVaultStepProps): string {
  const { csrfToken, errorMessage, operation } = props;
  if (operation) return renderVaultOpStep({ operation });
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  // hub#259 / hub#267: the first vault is hard-named "default" for now.
  // The CLI threads `--vault-name` through `parachute-vault init`, which
  // the wizard's container-mode `runInstall` doesn't run. Wiring the
  // operator's typed name end-to-end requires either a new `init` step
  // in `runInstall` or upstream changes in @openparachute/vault so it
  // reads `PARACHUTE_VAULT_NAME` (or services.json paths) on first
  // boot. Both are bigger than fits in this PR — tracked in hub#267.
  // For now: show what's actually being created, no form field, no
  // UX lie. The operator renames via the admin UI once the wizard
  // hands them off.
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("vault")}
        <h1>Create your first vault</h1>
        <p class="subtitle">A vault is the per-workspace SQLite store + MCP
          surface Claude reads and writes through. You can have many vaults
          on one hub; this is just the first.</p>
      </div>
      <section class="explainer">
        <h2>Why this step</h2>
        <p>The wizard provisions a vault module at the path
          <code>/vault/default</code> and issues you an operator token —
          the same shape <code>parachute install vault</code> produces from
          the CLI. We're doing both in one click.</p>
        <h2>What's next</h2>
        <p>You'll land on a success screen with copy-paste MCP install
          instructions for Claude Code and a link to the admin UI, where
          you can rename or add additional vaults.</p>
      </section>
      <section class="preview">
        <p class="preview-label">About to create</p>
        <div class="preview-card">
          <span class="preview-key">vault:</span>
          <span class="preview-val" id="preview-vault-name">default</span>
          <span class="preview-fine">— admin: you, MCP-ready for Claude Code</span>
        </div>
        <p class="preview-fine">
          The vault is named <code>default</code> on first boot. Custom
          names on the wizard are tracked in
          <a href="https://github.com/ParachuteComputer/parachute-hub/issues/267">hub#267</a> —
          for now, rename or add vaults from the admin UI after setup.
        </p>
      </section>
      ${error}
      <form method="POST" action="/admin/setup/vault" class="auth-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <button type="submit" class="btn btn-primary" autofocus>Create vault & finish</button>
      </form>
    </div>`;
  return baseDocument("Set up your Parachute hub — vault", body);
}

function renderVaultOpStep(props: {
  operation: NonNullable<RenderVaultStepProps["operation"]>;
}): string {
  const { operation } = props;
  const terminal = operation.status === "succeeded" || operation.status === "failed";
  const logLines = operation.log.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  const errBanner = operation.error
    ? `<p class="error-banner">${escapeHtml(operation.error)}</p>`
    : "";
  // Auto-refresh every 2s until terminal. When succeeded we redirect via
  // a tiny refresh-to-/admin/setup?just_finished=1 so the wizard
  // re-renders the success screen one more time (with the MCP install
  // command + vault name) before subsequent bare GETs 301 to /login.
  // Without the `?just_finished=1` query, the success state derives as
  // "complete" + GET 301s, and the operator never sees the done page.
  // When failed we leave the operator on this screen so they can read
  // the log.
  const refresh = terminal ? undefined : 2;
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("vault")}
        <h1>${operation.status === "succeeded" ? "Vault ready" : "Provisioning your vault…"}</h1>
        <p class="subtitle">${
          operation.status === "failed"
            ? "Something went wrong — see the log below."
            : operation.status === "succeeded"
              ? "All set. Continuing to the success screen…"
              : "This usually takes 10–60 seconds. The page refreshes itself."
        }</p>
      </div>
      ${errBanner}
      <section class="op-log">
        <p class="op-status op-${operation.status}">status: ${operation.status}</p>
        <ol class="log-lines">${logLines}</ol>
      </section>
      ${
        operation.status === "succeeded"
          ? '<meta http-equiv="refresh" content="1; url=/admin/setup?just_finished=1" />'
          : ""
      }
    </div>`;
  return baseDocument("Set up your Parachute hub — vault", body, refresh);
}

// --- step 4: done --------------------------------------------------------

export interface RenderDoneStepProps {
  vaultName: string;
  /** Hub origin used in copy-pastable MCP install commands. */
  hubOrigin: string;
}

export function renderDoneStep(props: RenderDoneStepProps): string {
  const { vaultName, hubOrigin } = props;
  const mcpCmd = `claude mcp add --transport http parachute-${vaultName} ${hubOrigin}/vault/${vaultName}/mcp`;
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("done")}
        <h1>You're set up</h1>
        <p class="subtitle">Your hub is ready. Here's what to do next.</p>
      </div>
      <section class="done-grid">
        <div class="done-tile">
          <h2>Open the admin UI</h2>
          <p>Manage vaults, tokens, OAuth grants, and module updates.</p>
          <p><a class="btn btn-primary" href="/admin/vaults">Go to admin</a></p>
        </div>
        <div class="done-tile">
          <h2>Connect Claude Code (MCP)</h2>
          <p>Wire <code>vault:${escapeHtml(vaultName)}</code> into Claude Code as an MCP server:</p>
          <pre>${escapeHtml(mcpCmd)}</pre>
          <p class="fine">You'll be prompted to mint an operator token from
            the admin UI on first use. See
            <code>/admin/tokens</code> for the canonical mint surface.</p>
        </div>
      </section>
      <section class="explainer">
        <h2>What just happened</h2>
        <ul>
          <li>An admin operator account was created on this hub.</li>
          <li>A vault named <code>${escapeHtml(vaultName)}</code> was installed and started.</li>
          <li>OAuth issuer + JWKS keys were minted (visible at
            <code>/.well-known/oauth-authorization-server</code>).</li>
        </ul>
        <p>This wizard won't come back — the next visitor to <code>/</code>
          sees the discovery page; visitors to <code>/admin</code> are routed
          to <code>/login</code>.</p>
      </section>
    </div>`;
  return baseDocument("Parachute hub — setup complete", body);
}

// --- handler entry points ------------------------------------------------

/**
 * GET `/admin/setup`. Derives state, renders the appropriate step.
 *
 * Once the wizard's work is done (admin + vault both exist), GET 301s
 * to `/login` so a stale bookmark lands somewhere useful — UNLESS the
 * caller's `?just_finished=1` query is set, in which case we render the
 * step-4 done screen one more time. The wizard's own success redirect
 * uses `?just_finished=1` so the operator sees step 4 even though state
 * is already "complete."
 */
export function handleSetupGet(req: Request, deps: SetupWizardDeps): Response {
  const url = new URL(req.url);
  const state = deriveWizardState(deps);
  const csrf = ensureCsrfToken(req);
  const extraHeaders: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
  };
  if (csrf.setCookie) extraHeaders["set-cookie"] = csrf.setCookie;

  // Setup fully complete — redirect to /login unless we're rendering the
  // success page once. The success page sets `?just_finished=1` and the
  // session cookie is on the request from step 2.
  if (state.hasAdmin && state.hasVault) {
    if (url.searchParams.get("just_finished") === "1") {
      return new Response(
        renderDoneStep({
          vaultName: firstVaultName(deps.manifestPath),
          hubOrigin: deps.issuer,
        }),
        { status: 200, headers: extraHeaders },
      );
    }
    return new Response(null, { status: 301, headers: { location: "/login" } });
  }

  // Step 3 (vault) with an op in flight — render the poll page.
  if (state.hasAdmin && !state.hasVault) {
    const opId = url.searchParams.get("op");
    if (opId) {
      const registry = deps.registry;
      const op = registry?.get(opId);
      if (op) {
        return new Response(
          renderVaultStep({
            csrfToken: csrf.token,
            operation: {
              id: op.id,
              status: op.status,
              log: op.log,
              ...(op.error !== undefined ? { error: op.error } : {}),
            },
          }),
          { status: 200, headers: extraHeaders },
        );
      }
    }
    return new Response(renderVaultStep({ csrfToken: csrf.token }), {
      status: 200,
      headers: extraHeaders,
    });
  }

  // Step 1+2 (no admin yet).
  return new Response(renderAccountStep({ csrfToken: csrf.token }), {
    status: 200,
    headers: extraHeaders,
  });
}

/**
 * POST `/admin/setup/account`. Form-encoded.
 *
 * Validates CSRF + form fields, creates the admin row, mints a session
 * cookie, redirects to `/admin/setup` (which then renders step 3).
 *
 * Rejects if a user already exists — re-arriving here after step 2 is
 * either a stale tab or a malicious double-submit; either way the right
 * answer is "you're done with this step, go to /admin/setup."
 */
export async function handleSetupAccountPost(
  req: Request,
  deps: SetupWizardDeps,
): Promise<Response> {
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return badRequestPage("Invalid form submission", "Reload and try again.");
  }
  // Already-bootstrapped: bounce. The wizard's GET state will resolve to
  // step 3 or step 4 on the next request.
  if (userCount(deps.db) > 0) {
    return redirect("/admin/setup");
  }
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("password_confirm") ?? "");
  const csrfToken = typeof formCsrf === "string" ? formCsrf : "";
  const fieldErr = validateAccountFields({ username, password, confirm });
  if (fieldErr) {
    return htmlResponse(renderAccountStep({ csrfToken, username, errorMessage: fieldErr }), 400);
  }
  try {
    const user = await createUser(deps.db, username, password);
    const session = createSession(deps.db, { userId: user.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000), {
      secure: isHttpsRequest(req),
    });
    return redirect("/admin/setup", { "set-cookie": cookie });
  } catch (err) {
    // Log the raw error server-side for the operator's debugging, but
    // surface a fixed string to the browser — raw SQLite / argon2
    // messages leak schema details and aren't actionable for the
    // person filling out the form. The likely cause for a sane input
    // is the username-taken UNIQUE collision (createUser raises
    // UsernameTakenError); other paths (filesystem, argon2 native)
    // are rare and the same generic message lands the operator at the
    // right place: retry, or `parachute auth set-password` from the
    // shell.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[setup-wizard] createUser failed for "${username}": ${msg}`);
    return htmlResponse(
      renderAccountStep({
        csrfToken,
        username,
        errorMessage: "Failed to create account. The username may already be taken.",
      }),
      400,
    );
  }
}

/**
 * POST `/admin/setup/vault`. Form-encoded.
 *
 * Gated by the admin session cookie set at step 2 — a stale tab without
 * the cookie won't accidentally try to provision a vault. The session is
 * also valid evidence that the operator who created the admin is the
 * same one driving step 3 (they're necessarily the only user in
 * single-user mode).
 *
 * Drives `runInstall` directly (not the bearer-gated `handleInstall`).
 * The bearer check exists to keep narrow `:auth`-scope automation
 * tokens from hitting destructive endpoints; the wizard is already
 * gated on session + on "no vault exists yet," so a separate
 * bearer-mint dance would be pure ceremony.
 *
 * Returns a 303-redirect to `/admin/setup?op=<id>` so the wizard's
 * polling GET shape kicks in. The actual `bun add` runs in the
 * background; failures surface in the op log.
 */
export async function handleSetupVaultPost(req: Request, deps: SetupWizardDeps): Promise<Response> {
  if (!deps.supervisor) {
    return badRequestPage(
      "Module supervisor unavailable",
      "The first-boot wizard needs container-mode `parachute serve` to install modules. " +
        "On the on-box CLI surface, run `parachute install vault` directly.",
    );
  }
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return badRequestPage("Invalid form submission", "Reload and try again.");
  }
  const session = findActiveSession(deps.db, req);
  if (!session) {
    return badRequestPage(
      "No admin session",
      "Sign in to continue setup. (The wizard sets a session cookie on step 2; clearing cookies between steps will land you here.)",
    );
  }
  // Already done — short-circuit to the done step.
  const state = deriveWizardState(deps);
  if (state.hasVault) return redirect("/admin/setup?just_finished=1");

  // The first vault is hard-named "default" for now (hub#267). The CLI
  // threads `--vault-name` through `parachute-vault init`; the wizard's
  // container-mode `runInstall` doesn't run `init` (just `bun add` +
  // seed services.json + supervisor.start), and the upstream vault
  // module's `server.ts` auto-creates a "default" vault on first boot
  // regardless of the seeded services.json paths. Wiring an
  // operator-typed name end-to-end requires either a new init step or
  // upstream changes in @openparachute/vault — both bigger than fit
  // here. Form has no name field now; the operator renames via the
  // admin UI post-setup.
  const registry = deps.registry;
  const vaultSpec = specFor(FIRST_VAULT_SHORT);

  // Idempotent short-circuit: if the supervisor is already running (or
  // mid-spawn) for vault — i.e. a previous POST already kicked off
  // `runInstall` and beat us to spawning — return a synthesized
  // succeeded op instead of firing a second `bun add -g`. Mirrors the
  // pattern in `handleInstall` (api-modules-ops.ts). Without this,
  // two concurrent POSTs both pass `state.hasVault === false` (the
  // services.json seed is the only signal that step exits, and it's
  // written by `runInstall` *after* `bun add` returns), and each
  // fires its own install — wasted work and a possible race on the
  // seed/spawn writes. Low risk on first-boot in practice, but the
  // fix is cheap and matches the API surface's posture.
  const supervisorState = deps.supervisor.get(FIRST_VAULT_SHORT);
  if (
    supervisorState?.status === "running" ||
    supervisorState?.status === "starting" ||
    supervisorState?.status === "restarting"
  ) {
    if (registry) {
      const op = registry.create("install", FIRST_VAULT_SHORT);
      registry.update(
        op.id,
        { status: "succeeded" },
        `${FIRST_VAULT_SHORT} already supervised (status=${supervisorState.status})`,
      );
      return redirect(`/admin/setup?op=${encodeURIComponent(op.id)}`);
    }
    return redirect("/admin/setup");
  }

  const op = registry
    ? registry.create("install", FIRST_VAULT_SHORT)
    : { id: cryptoRandomId(), status: "pending" as const, log: [] as string[] };
  if (registry) {
    void runInstall(op.id, FIRST_VAULT_SHORT, vaultSpec, {
      db: deps.db,
      issuer: deps.issuer,
      manifestPath: deps.manifestPath,
      configDir: deps.configDir,
      supervisor: deps.supervisor,
      registry,
      ...(deps.run ? { run: deps.run } : {}),
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      registry.update(op.id, { status: "failed", error: msg }, `install failed: ${msg}`);
    });
  } else {
    // No registry wired (test-only path; production always passes one).
    // Log a visible warning so future mis-wirings are debuggable —
    // silent swallow here would make the wizard appear to hang.
    console.warn(
      "[setup-wizard] handleSetupVaultPost called with no operations registry — install will NOT run. Wire deps.registry in the dispatcher.",
    );
  }
  return redirect(`/admin/setup?op=${encodeURIComponent(op.id)}`);
}

// --- helpers ------------------------------------------------------------

function validateAccountFields(input: {
  username: string;
  password: string;
  confirm: string;
}): string | undefined {
  if (input.username.length < 2 || input.username.length > 64) {
    return "Username must be 2–64 characters.";
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(input.username)) {
    return "Username may use letters, digits, underscore, period, hyphen.";
  }
  if (input.password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  if (input.password !== input.confirm) {
    return "Passwords do not match.";
  }
  return undefined;
}

/**
 * Read the first vault's display name from services.json for the
 * step-4 success page. Falls back to "default" if for any reason the
 * entry's metadata isn't present.
 */
function firstVaultName(manifestPath: string): string {
  const manifest = readManifest(manifestPath);
  // Match on the canonical vault manifestName from the curated spec.
  // (`CURATED_MODULES.includes("vault")` was a dead guard — vault is a
  // tuple-literal member, so the conjunct is always true.)
  const entry = manifest.services.find((s) => s.name === specFor("vault").manifestName);
  if (!entry) return "default";
  // services.json entries store the mount path (e.g. `/vault/default`).
  // Strip the canonical prefix to surface the display name.
  for (const p of entry.paths ?? []) {
    if (p.startsWith("/vault/")) {
      const tail = p.slice("/vault/".length).replace(/\/+$/, "");
      if (tail.length > 0) return tail;
    }
  }
  return "default";
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...extra } });
}

function badRequestPage(title: string, message: string): Response {
  return htmlResponse(renderBadRequestPage(title, message), 400);
}

function renderBadRequestPage(title: string, message: string): string {
  const body = `
    <div class="card">
      ${header("welcome")}
      <h1 class="error-title">${escapeHtml(title)}</h1>
      <p class="subtitle">${escapeHtml(message)}</p>
      <p><a class="btn btn-primary" href="/admin/setup">Restart setup</a></p>
    </div>`;
  return baseDocument(title, body);
}

/**
 * Fallback op id when no registry is wired — the wizard's UX still
 * needs *something* to redirect to so the page doesn't hang. The
 * redirect's `op` query then resolves to "no op found," which renders
 * the bare step-3 form again. Production callers always pass a
 * registry (the dispatcher in `hub-server.ts` plugs in
 * `getDefaultOperationsRegistry()`); this branch is exercised only by
 * tests that deliberately omit it. `handleSetupVaultPost` logs a
 * `console.warn` when it takes this branch so a real-world
 * mis-wiring surfaces in the operator's logs instead of silently
 * swallowing the install.
 */
function cryptoRandomId(): string {
  return `op-${Math.random().toString(36).slice(2, 10)}`;
}

// --- styles -------------------------------------------------------------

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ${FONT_SANS};
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    line-height: 1.55;
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  main {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1.5rem;
  }
  .card {
    width: 100%;
    max-width: 38rem;
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.border};
    border-radius: 12px;
    padding: 2rem 1.75rem;
    box-shadow: 0 1px 2px rgba(44, 42, 38, 0.04), 0 8px 24px rgba(44, 42, 38, 0.06);
  }
  .card-header { margin-bottom: 1.25rem; }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: ${PALETTE.accent};
    font-weight: 500;
    font-size: 0.95rem;
    margin-bottom: 0.5rem;
  }
  .brand-mark { font-size: 1.1rem; line-height: 1; }
  .brand-name { letter-spacing: 0.01em; }
  .brand-tag {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.7rem;
    color: ${PALETTE.fgMuted};
    border: 1px solid ${PALETTE.borderLight};
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
  }
  .steps {
    list-style: none;
    padding: 0;
    margin: 0 0 1rem;
    display: flex;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: ${PALETTE.fgDim};
    flex-wrap: wrap;
  }
  .step {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .step + .step::before {
    content: "→";
    color: ${PALETTE.fgDim};
    margin-right: 0.2rem;
  }
  .step-marker {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 999px;
    background: ${PALETTE.borderLight};
    color: ${PALETTE.fgMuted};
    font-size: 0.7rem;
    font-family: ${FONT_MONO};
  }
  .step.current .step-marker {
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
  }
  .step.past .step-marker {
    background: ${PALETTE.success};
    color: ${PALETTE.cardBg};
  }
  .step.current .step-label { color: ${PALETTE.fg}; font-weight: 500; }
  h1 {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.75rem;
    line-height: 1.2;
    margin: 0 0 0.4rem;
    color: ${PALETTE.fg};
  }
  h2 {
    font-family: ${FONT_SANS};
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${PALETTE.fgMuted};
    margin: 1.25rem 0 0.4rem;
  }
  .subtitle { margin: 0 0 0.5rem; color: ${PALETTE.fgMuted}; font-size: 0.95rem; }
  .explainer {
    background: ${PALETTE.accentSoft};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.5rem 1rem;
    margin: 1rem 0 1.25rem;
    font-size: 0.92rem;
  }
  .explainer h2 { margin-top: 0.75rem; }
  .explainer p { margin: 0 0 0.5rem; }
  .preview {
    margin: 1rem 0;
  }
  .preview-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${PALETTE.fgMuted};
    margin: 0 0 0.25rem;
  }
  .preview-card {
    background: ${PALETTE.warnSoft};
    border-left: 3px solid ${PALETTE.warn};
    padding: 0.6rem 0.9rem;
    border-radius: 0 6px 6px 0;
    font-family: ${FONT_MONO};
    font-size: 0.9rem;
  }
  .preview-key { color: ${PALETTE.fgMuted}; }
  .preview-val { font-weight: 600; color: ${PALETTE.fg}; }
  .preview-fine { color: ${PALETTE.fgMuted}; font-size: 0.85em; }

  .auth-form { display: flex; flex-direction: column; gap: 0.9rem; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field-label {
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
    letter-spacing: 0.01em;
    font-family: ${FONT_MONO};
  }
  .field-hint {
    font-size: 0.78rem;
    color: ${PALETTE.fgDim};
  }
  input[type=text], input[type=password] {
    font: inherit;
    width: 100%;
    padding: 0.6rem 0.75rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  input[type=text]:focus, input[type=password]:focus {
    outline: none;
    border-color: ${PALETTE.accent};
    background: ${PALETTE.cardBg};
    box-shadow: 0 0 0 3px ${PALETTE.accentSoft};
  }
  .btn {
    font: inherit;
    font-weight: 500;
    padding: 0.65rem 1.25rem;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    min-height: 2.5rem;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .btn-primary {
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
    margin-top: 0.4rem;
  }
  .btn-primary:hover { background: ${PALETTE.accentHover}; }
  .alt-path {
    margin-top: 1.25rem;
    border-top: 1px solid ${PALETTE.borderLight};
    padding-top: 0.75rem;
    font-size: 0.88rem;
    color: ${PALETTE.fgMuted};
  }
  .alt-path summary {
    cursor: pointer;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
  }
  .alt-path p { margin: 0.5rem 0 0; }

  .error-banner {
    background: ${PALETTE.dangerSoft};
    border: 1px solid ${PALETTE.danger};
    border-radius: 6px;
    color: ${PALETTE.danger};
    padding: 0.6rem 0.8rem;
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }
  .error-title { color: ${PALETTE.danger}; }

  .op-log {
    background: ${PALETTE.bg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.75rem 1rem;
    margin: 1rem 0;
    font-family: ${FONT_MONO};
    font-size: 0.85rem;
  }
  .op-status {
    margin: 0 0 0.5rem;
    font-weight: 600;
    color: ${PALETTE.fgMuted};
  }
  .op-succeeded { color: ${PALETTE.success}; }
  .op-failed { color: ${PALETTE.danger}; }
  .log-lines { margin: 0; padding-left: 1.25rem; color: ${PALETTE.fgMuted}; }
  .log-lines li { margin: 0.15rem 0; }

  .done-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    margin: 1rem 0;
  }
  @media (min-width: 36rem) {
    .done-grid { grid-template-columns: 1fr 1fr; }
  }
  .done-tile {
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.75rem 1rem;
  }
  .done-tile h2 {
    margin-top: 0;
    text-transform: none;
    letter-spacing: 0;
    font-size: 1.05rem;
    color: ${PALETTE.fg};
  }
  .done-tile pre {
    background: ${PALETTE.bg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
    font-size: 0.82rem;
    margin: 0.5rem 0;
  }
  .done-tile .fine { font-size: 0.85rem; color: ${PALETTE.fgMuted}; }

  code {
    background: ${PALETTE.borderLight};
    padding: 0.05rem 0.3rem;
    border-radius: 4px;
    font-family: ${FONT_MONO};
    font-size: 0.92em;
  }
  pre code {
    background: transparent;
    padding: 0;
  }

  @media (max-width: 480px) {
    main { padding: 0.75rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.5rem; }
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1 { color: #f0ece4; }
    .subtitle, .field-label, .field-hint, .step-label { color: #a8a29a; }
    input[type=text], input[type=password] {
      background: #1f1c18; border-color: #3a362f; color: #e8e4dc;
    }
    input[type=text]:focus, input[type=password]:focus {
      background: #25221d;
    }
    .brand-tag { border-color: #3a362f; color: #a8a29a; }
    .explainer { background: rgba(74, 124, 89, 0.12); border-color: #3a362f; }
    .preview-card { background: rgba(212, 160, 23, 0.15); }
    .done-tile { border-color: #3a362f; }
    .op-log { background: #1f1c18; border-color: #3a362f; }
  }
`;
