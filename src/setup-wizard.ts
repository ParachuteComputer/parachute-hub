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
import { CURATED_MODULES, type CuratedModuleShort } from "./api-modules.ts";
import {
  CSRF_FIELD_NAME,
  ensureCsrfToken,
  renderCsrfHiddenInput,
  verifyCsrfToken,
} from "./csrf.ts";
import {
  SETUP_EXPOSE_MODES,
  type SetupExposeMode,
  deleteSetting,
  getSetting,
  isSetupExposeMode,
  openFirstClientAutoApproveWindow,
  setSetting,
} from "./hub-settings.ts";
import { escapeHtml } from "./oauth-ui.ts";
import { mintOperatorToken } from "./operator-token.ts";
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
import { DEFAULT_VAULT_NAME, validateVaultName } from "./vault-name.ts";

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

/**
 * Wizard steps. `"account"` is a visual-only entry in the progress
 * header — it shares a screen with `"welcome"` (the combined welcome +
 * account form), and `deriveWizardState` never returns it: a welcome
 * POST creates the admin and advances directly to `"vault"`. Kept in
 * the union so the progress bar can render it as a distinct dot for
 * display continuity.
 */
export type WizardStep = "welcome" | "account" | "vault" | "expose" | "done";

export interface DerivedWizardState {
  /** Current step the wizard should render. */
  step: WizardStep;
  /** Whether at least one user row exists. */
  hasAdmin: boolean;
  /** Whether the first vault (curated) has been provisioned in services.json. */
  hasVault: boolean;
  /**
   * Whether the operator has answered the "how will this hub be reached?"
   * question (the expose step, hub#268 Item 2). When admin + vault both
   * exist but the operator hasn't picked an expose mode yet, the wizard
   * renders the expose step rather than the done screen.
   */
  hasExposeMode: boolean;
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
  // Expose-mode is the operator's "how will this hub be reached?" answer
  // (hub#268 Item 2). Stored as a hub_setting; the wizard's expose step
  // sets it; absence means we should still ask.
  const hasExposeMode = getSetting(deps.db, "setup_expose_mode") !== undefined;
  let step: WizardStep;
  // Note: `"account"` is a visual-only step in the progress header —
  // welcome's POST creates the admin and advances directly to `"vault"`,
  // so we never return `"account"` here.
  if (!hasAdmin) step = "welcome";
  else if (!hasVault) step = "vault";
  else if (!hasExposeMode) step = "expose";
  else step = "done";
  return { step, hasAdmin, hasVault, hasExposeMode };
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
  const stepOrder: WizardStep[] = ["welcome", "account", "vault", "expose", "done"];
  // Step 1 (welcome) + step 2 (account) collapse on the rendered page —
  // we show them as a single combined form. The progress bar still names
  // them separately so the operator sees the shape.
  const labels: Record<WizardStep, string> = {
    welcome: "Welcome",
    account: "Account",
    vault: "Vault",
    expose: "Expose",
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
  /** Pre-fill the vault name input after a validation failure. */
  vaultName?: string;
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
  const { csrfToken, errorMessage, operation, vaultName } = props;
  if (operation) return renderVaultOpStep({ operation });
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  // hub#267: the typed name now flows end-to-end via
  // `PARACHUTE_VAULT_NAME`. Vault#342 added the env var read on
  // first-boot — hub spawns vault with the env var set and vault's
  // `resolveFirstBootVaultName` picks it up. The wizard's job here is
  // to ask + validate + persist the choice; the supervised vault child
  // does the rest.
  //
  // Leaving the field blank falls back to `default` server-side —
  // matches the prior shape so no-input + Submit still works for the
  // "I don't care, just give me a vault" path.
  const nameAttr = vaultName !== undefined ? ` value="${escapeAttr(vaultName)}"` : "";
  const previewName = vaultName?.trim() ? escapeHtml(vaultName.trim()) : DEFAULT_VAULT_NAME;
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
          <code>/vault/&lt;name&gt;</code> and issues you an operator token —
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
          <span class="preview-val" id="preview-vault-name">${previewName}</span>
          <span class="preview-fine">— admin: you, MCP-ready for Claude Code</span>
        </div>
        <p class="preview-fine">
          The name shows up in the MCP URL (<code>/vault/&lt;name&gt;/mcp</code>)
          and on the admin UI. You can rename or add vaults later from
          <code>/admin/vaults</code>.
        </p>
      </section>
      ${error}
      <form method="POST" action="/admin/setup/vault" class="auth-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <label class="field">
          <span class="field-label">Vault name</span>
          <input type="text" name="vault_name"
            autofocus minlength="2" maxlength="32"
            pattern="[a-z0-9_-]+"
            title="lowercase letters, digits, hyphens, underscores (2–32 chars)"
            placeholder="${DEFAULT_VAULT_NAME}"${nameAttr} />
          <span class="field-hint">lowercase letters, digits, <code>-</code>, <code>_</code>;
            2–32 chars. Leave blank for <code>${DEFAULT_VAULT_NAME}</code>.</span>
        </label>
        <button type="submit" class="btn btn-primary">Create vault & finish</button>
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

// --- step 4: expose ------------------------------------------------------

export interface RenderExposeStepProps {
  csrfToken: string;
  errorMessage?: string;
  /** Pre-select a radio when re-rendering after a validation error. */
  selectedMode?: SetupExposeMode;
}

/**
 * The expose step asks the operator how this hub will be reached. The
 * wizard doesn't configure tailscale or DNS itself — the operator owns
 * the actual networking step; the wizard's role is to ask the question,
 * surface the right next-step instructions, and persist the choice so
 * the done page (and the admin SPA later) shows the right URL shape.
 *
 * Three modes (hub#268 Item 2):
 *   * localhost — just this machine. No further action; the loopback
 *     URL is the canonical entry.
 *   * tailnet   — Tailscale network. Show the `tailscale serve` command
 *     the operator runs themselves.
 *   * public    — custom domain / reverse proxy. Show a brief explainer
 *     + link to the deploy docs.
 */
export function renderExposeStep(props: RenderExposeStepProps): string {
  const { csrfToken, errorMessage, selectedMode } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  // The default selection (localhost) is the most common case + the
  // safest fallback — picking it changes nothing operational. Tailnet +
  // public require the operator to actually run something; surfacing
  // them as alternatives is the whole point of this step.
  const sel = (m: SetupExposeMode) => (selectedMode === m ? " checked" : "");
  const defaultChecked = selectedMode === undefined ? " checked" : "";
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("expose")}
        <h1>How will this hub be reached?</h1>
        <p class="subtitle">Pick the network shape that matches your setup.
          You can revisit this later from the admin UI — it just shapes the
          URLs we surface on the next screen.</p>
      </div>
      ${error}
      <form method="POST" action="/admin/setup/expose" class="auth-form expose-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <label class="expose-option">
          <input type="radio" name="expose_mode" value="localhost"${selectedMode ? sel("localhost") : defaultChecked} />
          <div class="expose-option-body">
            <span class="expose-option-title">Just this machine (localhost)</span>
            <span class="expose-option-desc">Reach the hub at
              <code>http://localhost:1939</code>. No further configuration
              needed. This is the right answer for "I'm just trying it out"
              and for "this machine is the only client."</span>
          </div>
        </label>
        <label class="expose-option">
          <input type="radio" name="expose_mode" value="tailnet"${sel("tailnet")} />
          <div class="expose-option-body">
            <span class="expose-option-title">My Tailscale network</span>
            <span class="expose-option-desc">Share with your own devices over
              a private tailnet. After finishing setup, run:</span>
            <pre class="expose-option-cmd">tailscale serve --bg --https=1939 http://localhost:1939</pre>
            <span class="expose-option-desc">The hub is then reachable at
              your tailnet hostname (e.g.
              <code>https://my-mac.tailnet-name.ts.net</code>) from any of
              your logged-in devices.</span>
          </div>
        </label>
        <label class="expose-option">
          <input type="radio" name="expose_mode" value="public"${sel("public")} />
          <div class="expose-option-body">
            <span class="expose-option-title">Public URL (custom domain)</span>
            <span class="expose-option-desc">Run the hub behind a reverse
              proxy on a domain you own. See the
              <a href="https://parachute.computer/docs/deploy" target="_blank" rel="noopener">deploy guide</a>
              for nginx / Caddy / Cloudflare Tunnel examples + the env
              vars (<code>PARACHUTE_HUB_ORIGIN</code>) the hub reads for
              its own canonical URL.</span>
          </div>
        </label>
        <button type="submit" class="btn btn-primary">Continue</button>
      </form>
    </div>`;
  return baseDocument("Set up your Parachute hub — expose", body);
}

// --- step 5: done --------------------------------------------------------

/**
 * Per-module install state surfaced on the done screen (hub#272 Item B).
 * The renderer reads this to choose tile shape:
 *   * `idle` — no op yet, show the Install button + form
 *   * `running` / `pending` — op-poll panel + auto-refresh
 *   * `succeeded` — green check + "View in admin" link
 *   * `failed` — red banner + log + retry button
 *
 * Same op-id flows through the admin SPA's operation poll, so an
 * operator can hop to `/admin/modules` mid-flight and watch from there
 * without losing the op.
 */
export interface ModuleInstallTileState {
  short: CuratedModuleShort;
  displayName: string;
  tagline: string;
  /** True when a services.json entry already exists for this module (already installed). */
  alreadyInstalled: boolean;
  /** Live op snapshot from the registry, if `?op_<short>=<id>` was set. */
  operation?: {
    id: string;
    status: "pending" | "running" | "succeeded" | "failed";
    log: readonly string[];
    error?: string;
  };
}

export interface RenderDoneStepProps {
  vaultName: string;
  /** Hub origin used in copy-pastable MCP install commands. */
  hubOrigin: string;
  /**
   * Operator's expose-mode choice from step 4. Shapes the "Your hub is
   * reachable at:" line + next-step instructions. Optional for back-compat
   * with callers that render the done step without going through expose
   * (e.g. tests of the wizard's older two-step flow).
   */
  exposeMode?: SetupExposeMode;
  /**
   * Auto-minted operator token surfaced once on the done screen
   * (hub#272 Item A). When present, the MCP install command renders
   * with `--header "Authorization: Bearer <token>"` pre-filled and a
   * one-click Copy button. Absent means the mint either failed or
   * the operator already consumed the single-use surface — the tile
   * falls back to the un-headered command + a "mint at /admin/tokens"
   * hint.
   */
  mintedToken?: string;
  /**
   * Optional per-module install tiles to render alongside the MCP
   * command (hub#272 Item B). When omitted, the done step renders
   * only the MCP tile + the admin-UI fallback link. Production wires
   * Notes + Scribe; tests can omit this to assert the back-compat
   * shape.
   */
  installTiles?: readonly ModuleInstallTileState[];
}

export function renderDoneStep(props: RenderDoneStepProps): string {
  const { vaultName, hubOrigin, exposeMode, mintedToken, installTiles } = props;
  const reachable = exposeMode ? renderReachableTile(exposeMode, hubOrigin) : "";
  const mcpTile = renderMcpTile(vaultName, hubOrigin, mintedToken);
  const tiles = installTiles && installTiles.length > 0 ? installTiles : [];
  const installSection = tiles.length > 0 ? renderInstallTiles(tiles) : "";
  // The done-grid hosts the MCP-connect tile + the admin-UI fallback.
  // The install tiles sit above it as a primary "what's next?" surface —
  // they're the highest-friction next-step for most operators (operator
  // just provisioned a vault, the obvious next action is installing the
  // PWA / transcription module on top of it). Reachable tile leads
  // everything because it answers "where's my hub?" before anything
  // else — the question every operator hits before MCP / module
  // installs even matter.
  const body = `
    <div class="card">
      <div class="card-header">
        ${header("done")}
        <h1>You're set up</h1>
        <p class="subtitle">Your hub is ready. Here's what to do next.</p>
      </div>
      ${reachable}
      ${installSection}
      <section class="done-grid">
        ${mcpTile}
        <div class="done-tile">
          <h2>Open the admin UI</h2>
          <p>Manage vaults, tokens, OAuth grants, and module updates.</p>
          <p><a class="btn btn-secondary" href="/admin/modules">Go to admin</a></p>
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
  // Auto-refresh while any install op is in flight so the operator sees
  // progress without manually reloading. Done step is the canonical
  // poll surface for both the MCP-connect tile (static) and the
  // module-install tiles (dynamic). Refresh interval matches the
  // vault-op-poll page's 2s cadence so the wizard's two long-running
  // surfaces (vault, post-vault notes/scribe) feel consistent.
  const anyOpInFlight = tiles.some(
    (t) => t.operation && (t.operation.status === "pending" || t.operation.status === "running"),
  );
  const refresh = anyOpInFlight ? 2 : undefined;
  return baseDocument("Parachute hub — setup complete", body, refresh);
}

/**
 * The MCP-connect tile. With a freshly-minted token the command renders
 * fully formed with a `--header "Authorization: Bearer <token>"` flag +
 * a Copy button. Without one, we fall back to the bare command + a
 * pointer to `/admin/tokens` (the canonical mint surface). The Copy
 * button is a tiny inline `<script>` — no SPA bundle, no module deps,
 * the wizard stays server-rendered.
 */
function renderMcpTile(
  vaultName: string,
  hubOrigin: string,
  mintedToken: string | undefined,
): string {
  const safeVault = escapeHtml(vaultName);
  const bareCmd = `claude mcp add --transport http parachute-${vaultName} ${hubOrigin}/vault/${vaultName}/mcp`;
  if (mintedToken) {
    // The token contents are surfaced once + then forgotten by the
    // server (single-use hub_setting). Two visible variants of the
    // command live in the DOM:
    //
    //   * `pre#mcp-cmd` — what the operator sees. The Bearer token is
    //     replaced with a fixed-width row of • so shoulder-surfers,
    //     screencasts, and over-the-shoulder photos don't capture
    //     credentials by default. This is the "discoverable but not
    //     shoulder-surf-able" framing Aaron asked for.
    //   * `script#mcp-cmd-real` (type=text/plain) — the real command
    //     with the live token, stashed in a non-rendering script tag.
    //     The Copy + Show handlers read from this so the operator's
    //     terminal paste still gets the real header without the page
    //     ever painting the token.
    //
    // The view-source threat model is unchanged from rc.9 — the token
    // is part of the response body either way. The improvement is
    // *visibly hidden by default*, which is what an over-the-shoulder
    // observer needs (and what existing screencasts of the wizard
    // currently leak).
    //
    // Show toggles textContent between masked + real and flips a
    // data-state attribute so a screencast / pair-programming session
    // can briefly reveal-and-rehide without the operator losing the
    // line of sight on which mode they're in. Auto-hide after 10s so
    // a forgotten reveal doesn't leak the token into a subsequent
    // recording.
    const fullCmd = `${bareCmd} --header "Authorization: Bearer ${mintedToken}"`;
    // Clamp the dot count to a 8–40 range so very-short or very-long
    // tokens don't render comically — token format is fixed-width
    // (JTI-derived), so this is purely visual.
    const maskedToken = "•".repeat(Math.max(8, Math.min(40, mintedToken.length)));
    const maskedCmd = `${bareCmd} --header "Authorization: Bearer ${maskedToken}"`;
    // The real command rides in a hidden <script type="application/json">
    // block as a JSON-encoded string. <script> element content is parsed
    // as raw text (no entity references), so HTML escaping would put
    // literal `&quot;` into the string — and Copy would paste that into
    // the operator's terminal. JSON encoding (with `</` escaped so the
    // sequence can't prematurely close the tag) round-trips safely:
    // textContent returns the JSON, JSON.parse decodes back to the
    // exact bytes of the original command. Caught while smoke-testing
    // the rc.11 reveal/copy UX — pre-fix, the copied command included
    // `&quot;` placeholders that broke shell parsing.
    const fullCmdJson = JSON.stringify(fullCmd).replace(/<\//g, "<\\/");
    return `<div class="done-tile">
      <h2>Connect Claude Code (MCP)</h2>
      <p>Wire <code>vault:${safeVault}</code> into Claude Code as an MCP server:</p>
      <div class="mcp-cmd-wrap" data-state="masked">
        <pre id="mcp-cmd">${escapeHtml(maskedCmd)}</pre>
        <script type="application/json" id="mcp-cmd-real">${fullCmdJson}</script>
        <div class="mcp-cmd-actions">
          <button type="button" class="btn btn-mcp-aux" id="mcp-cmd-show">Show token</button>
          <button type="button" class="btn btn-copy" id="mcp-cmd-copy">Copy</button>
        </div>
      </div>
      <p class="fine">We minted this token for your first MCP connection.
        It's masked above so it's safe to leave open on screen; Copy
        copies the real command. It's a full-scope operator token tied
        to your admin account; manage and revoke tokens at
        <a href="/admin/tokens"><code>/admin/tokens</code></a>.</p>
      <script>
        (function () {
          var wrap = document.querySelector('.mcp-cmd-wrap[data-state]');
          var pre = document.getElementById('mcp-cmd');
          var real = document.getElementById('mcp-cmd-real');
          var copyBtn = document.getElementById('mcp-cmd-copy');
          var showBtn = document.getElementById('mcp-cmd-show');
          if (!wrap || !pre || !real || !copyBtn || !showBtn) return;
          var realCmd;
          try { realCmd = JSON.parse(real.textContent || '""'); }
          catch (e) { realCmd = ''; }
          var maskedCmd = pre.textContent || '';
          var revealTimer = null;
          function setMasked() {
            pre.textContent = maskedCmd;
            wrap.setAttribute('data-state', 'masked');
            showBtn.textContent = 'Show token';
            if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
          }
          function setRevealed() {
            pre.textContent = realCmd;
            wrap.setAttribute('data-state', 'revealed');
            showBtn.textContent = 'Hide token';
            // Auto-hide after 10s so a stray reveal doesn't leak the
            // token into a screencast capture that started after the
            // click.
            if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
            revealTimer = setTimeout(setMasked, 10000);
          }
          showBtn.addEventListener('click', function () {
            if (wrap.getAttribute('data-state') === 'masked') setRevealed();
            else setMasked();
          });
          copyBtn.addEventListener('click', function () {
            // Copy ALWAYS pulls from the real command — the operator's
            // terminal needs the live token regardless of whether the
            // page is currently masked. This is the load-bearing path:
            // the visible mask is a UX nicety; the clipboard must
            // carry the real header.
            navigator.clipboard.writeText(realCmd).then(function () {
              copyBtn.textContent = 'Copied ✓';
              setTimeout(function () { copyBtn.textContent = 'Copy'; }, 2000);
            });
          });
        })();
      </script>
    </div>`;
  }
  return `<div class="done-tile">
    <h2>Connect Claude Code (MCP)</h2>
    <p>Wire <code>vault:${safeVault}</code> into Claude Code as an MCP server:</p>
    <pre>${escapeHtml(bareCmd)}</pre>
    <p class="fine">Mint an operator token at
      <a href="/admin/tokens"><code>/admin/tokens</code></a> and append
      <code>--header "Authorization: Bearer pvt_..."</code> on first use.</p>
  </div>`;
}

/**
 * The "What's next?" install-tiles row (hub#272 Item B). One tile per
 * curated module the operator might want next (Notes, Scribe). Each
 * tile is either an install form (POST → /admin/setup/install/<short>
 * → 303 to /admin/setup?op_<short>=<id>) or an op-poll panel mirroring
 * the vault-step's op-poll shape.
 */
function renderInstallTiles(tiles: readonly ModuleInstallTileState[]): string {
  const items = tiles.map((t) => renderInstallTile(t)).join("");
  return `<section class="install-tiles">
    <h2 class="install-tiles-heading">What's next?</h2>
    <p class="install-tiles-subtitle">Install another module — these run alongside your vault on the same hub.</p>
    <div class="install-grid">${items}</div>
  </section>`;
}

function renderInstallTile(tile: ModuleInstallTileState): string {
  const safeShort = escapeHtml(tile.short);
  const safeName = escapeHtml(tile.displayName);
  const safeTagline = escapeHtml(tile.tagline);
  if (tile.operation) {
    const op = tile.operation;
    const logLines = op.log.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
    const errBanner = op.error ? `<p class="error-banner">${escapeHtml(op.error)}</p>` : "";
    // Terminal state (succeeded / failed) gets either a confirmation
    // link or a retry form. Pending / running renders the live log
    // panel and relies on the parent `<meta http-equiv="refresh">` for
    // the next tick — no per-tile refresh needed (one full-page reload
    // catches every in-flight op at once).
    let actions = "";
    if (op.status === "succeeded") {
      actions = `<p><a class="btn btn-secondary" href="/admin/modules">Manage modules</a></p>`;
    } else if (op.status === "failed") {
      actions = `<form method="POST" action="/admin/setup/install/${safeShort}" class="install-retry">
        ${renderInstallTileCsrfPlaceholder()}
        <button type="submit" class="btn btn-secondary">Retry install</button>
      </form>`;
    }
    return `<div class="install-tile install-tile-${op.status}">
      <h3>${safeName}</h3>
      <p class="install-tile-tagline">${safeTagline}</p>
      ${errBanner}
      <section class="op-log install-tile-log">
        <p class="op-status op-${op.status}">status: ${op.status}</p>
        <ol class="log-lines">${logLines}</ol>
      </section>
      ${actions}
    </div>`;
  }
  if (tile.alreadyInstalled) {
    return `<div class="install-tile install-tile-installed">
      <h3>${safeName}</h3>
      <p class="install-tile-tagline">${safeTagline}</p>
      <p class="install-tile-status">Already installed.</p>
      <p><a class="btn btn-secondary" href="/admin/modules">Manage in admin</a></p>
    </div>`;
  }
  return `<div class="install-tile">
    <h3>${safeName}</h3>
    <p class="install-tile-tagline">${safeTagline}</p>
    <form method="POST" action="/admin/setup/install/${safeShort}" class="install-tile-form">
      ${renderInstallTileCsrfPlaceholder()}
      <button type="submit" class="btn btn-primary">Install ${safeName}</button>
    </form>
  </div>`;
}

/**
 * CSRF token placeholder for install-tile forms. The token comes from
 * the wizard's per-request CSRF cookie; rendered by the parent step's
 * `csrfToken` plumbing. Threaded through `renderDoneStep` props rather
 * than read here directly because the tile renderer is a pure function
 * the test surface can exercise without a request object.
 *
 * Currently rendered as a marker that the parent renderer rewrites
 * before serving — keeps the per-tile shape pure but avoids dragging
 * a CSRF token argument into every tile-shape function.
 */
function renderInstallTileCsrfPlaceholder(): string {
  return INSTALL_TILE_CSRF_PLACEHOLDER;
}

const INSTALL_TILE_CSRF_PLACEHOLDER = "__INSTALL_TILE_CSRF__";

/**
 * Render the "Your hub is reachable at" tile on the done step, shaped by
 * the operator's expose-mode choice. Always surfaces the loopback URL as
 * an anchor (the operator's own browser hits the wizard on it); the
 * tail-end instructions reframe based on what they picked.
 */
function renderReachableTile(mode: SetupExposeMode, hubOrigin: string): string {
  const safeOrigin = escapeHtml(hubOrigin);
  if (mode === "localhost") {
    return `<section class="reachable">
      <h2>Your hub is reachable at</h2>
      <p class="reachable-url"><code>${safeOrigin}</code></p>
      <p class="fine">Local to this machine only. Want to share it with your
        other devices? Re-visit setup later from the admin UI or run
        <code>tailscale serve --bg --https=1939 http://localhost:1939</code>
        from a terminal.</p>
    </section>`;
  }
  if (mode === "tailnet") {
    return `<section class="reachable">
      <h2>Your hub is reachable at</h2>
      <p class="reachable-url"><code>${safeOrigin}</code> (loopback, this machine)</p>
      <p class="reachable-url">Plus your tailnet URL once you run:</p>
      <pre>tailscale serve --bg --https=1939 http://localhost:1939</pre>
      <p class="fine">The Tailscale CLI prints the public hostname (e.g.
        <code>my-mac.tailnet-name.ts.net</code>); use that on your phone /
        other devices.</p>
    </section>`;
  }
  // public
  return `<section class="reachable">
      <h2>Your hub is reachable at</h2>
      <p class="reachable-url"><code>${safeOrigin}</code> (loopback, this machine)</p>
      <p class="fine">Wire a reverse proxy on your domain to
        <code>${safeOrigin}</code>, then set <code>PARACHUTE_HUB_ORIGIN</code>
        to your public URL and restart the hub. See the
        <a href="https://parachute.computer/docs/deploy">deploy guide</a>
        for nginx / Caddy / Cloudflare Tunnel examples.</p>
    </section>`;
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

  // Setup fully complete (including expose-mode choice) — redirect to
  // /login unless we're rendering the success page once. The success
  // page sets `?just_finished=1` and the session cookie is on the
  // request from step 2.
  if (state.hasAdmin && state.hasVault && state.hasExposeMode) {
    if (url.searchParams.get("just_finished") === "1") {
      // hub#274 security fold: session-gate this branch. The
      // `?just_finished=1` GET reads + consumes `setup_minted_token`
      // (full-scope operator JWT) below; without a session check, any
      // HTTP client that races the operator's browser between the
      // expose POST (which writes the row) and the done GET (which
      // reads it) walks off with admin-scope creds. The dispatcher
      // in `hub-server.ts`'s `shouldGateForSetup` lets `/admin/setup*`
      // through the pre-admin lockout, and that path stays open
      // post-setup — so this gate has to live here, not at the
      // dispatcher layer.
      //
      // A legitimate operator carrying the session cookie minted on
      // the account POST sails through. A drive-by GET without the
      // cookie 302s to /login: if it's a stale bookmark in the
      // operator's other tab, they sign in + the row is already
      // consumed by the legitimate done-GET (the single-use shape
      // guarantees they see the fallback shape, never the secret).
      // If it's an attacker, they can't pass /login without the
      // password.
      const session = findActiveSession(deps.db, req);
      if (!session) {
        // Preserve the CSRF set-cookie header on the 302 — same shape as
        // every other branch of this handler. Without it, a freshly
        // assigned CSRF token would be lost across the redirect, and
        // form posts from a sign-in-then-come-back flow would 400 on
        // their first attempt.
        const redirectHeaders: Record<string, string> = { location: "/login" };
        if (csrf.setCookie) redirectHeaders["set-cookie"] = csrf.setCookie;
        return new Response(null, {
          status: 302,
          headers: redirectHeaders,
        });
      }
      const stored = getSetting(deps.db, "setup_expose_mode");
      const exposeMode = isSetupExposeMode(stored) ? stored : undefined;
      // hub#272 Item A: read + consume the single-use minted-token row.
      // Render-and-forget keeps the secret from re-appearing on
      // refresh / back-button. The mint is non-fatal (see expose POST);
      // its absence renders the bare MCP command + a hint at
      // /admin/tokens.
      const mintedToken = getSetting(deps.db, "setup_minted_token");
      if (mintedToken) deleteSetting(deps.db, "setup_minted_token");
      // hub#267: the operator-typed vault name lives in hub_settings
      // (persisted by handleSetupVaultPost). Fall back to scanning
      // services.json — covers wizard runs from before this PR where
      // setup_vault_name wasn't written. The services.json read
      // returns the path-tail; vault's own first-boot write produces
      // the canonical name so the two should agree once the vault
      // boots authoritatively.
      const storedName = getSetting(deps.db, "setup_vault_name");
      const vaultName = storedName ?? firstVaultName(deps.manifestPath);
      // Module install tiles (hub#272 Item B). One per curated module
      // other than vault (which the wizard already provisioned).
      const installTiles = buildInstallTiles(url, deps);
      const doneProps: RenderDoneStepProps = {
        vaultName,
        hubOrigin: deps.issuer,
        installTiles,
      };
      if (exposeMode !== undefined) doneProps.exposeMode = exposeMode;
      if (mintedToken) doneProps.mintedToken = mintedToken;
      // Substitute CSRF placeholder for the install-tile forms with
      // the current CSRF token. Keeping the per-tile renderer pure
      // means the substitution lives here (one rewrite per render).
      const html = renderDoneStep(doneProps).replaceAll(
        INSTALL_TILE_CSRF_PLACEHOLDER,
        renderCsrfHiddenInput(csrf.token),
      );
      return new Response(html, {
        status: 200,
        headers: extraHeaders,
      });
    }
    return new Response(null, { status: 301, headers: { location: "/login" } });
  }

  // Expose step (hub#268 Item 2). Admin + vault exist, but the operator
  // hasn't picked an expose mode yet. The wizard form posts to
  // /admin/setup/expose. Gated on having an admin session (the session
  // cookie was minted on step 2); on a stale tab without it, the post
  // handler shows the no-session error.
  if (state.hasAdmin && state.hasVault && !state.hasExposeMode) {
    return new Response(renderExposeStep({ csrfToken: csrf.token }), {
      status: 200,
      headers: extraHeaders,
    });
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
    // Wizard-admin chose their password through this very form; skip the
    // multi-user-Phase-1 force-change-password redirect by landing
    // `password_changed=true`. `assignedVault` stays null — admin posture
    // (the wizard never asks the first admin to pin themselves to a
    // single vault; that's a non-admin user pattern).
    const user = await createUser(deps.db, username, password, { passwordChanged: true });
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

  // hub#267: the operator-typed vault name is now threaded all the way
  // through to vault's first-boot via `PARACHUTE_VAULT_NAME` (vault#342
  // shipped the env-var read in vault's `server.ts`). Empty input
  // falls back to the canonical `DEFAULT_VAULT_NAME` so the "just give
  // me a vault" path still works without typing anything.
  const csrfTokenStr = typeof formCsrf === "string" ? formCsrf : "";
  const rawName = String(form.get("vault_name") ?? "").trim();
  let vaultName: string;
  if (rawName === "") {
    vaultName = DEFAULT_VAULT_NAME;
  } else {
    const v = validateVaultName(rawName);
    if (!v.ok) {
      return htmlResponse(
        renderVaultStep({
          csrfToken: csrfTokenStr,
          vaultName: rawName,
          errorMessage: v.error,
        }),
        400,
      );
    }
    vaultName = v.name;
  }
  // Persist for the done-step renderer. Vault overwrites services.json
  // on its first authoritative boot, but until that completes the wizard
  // needs a stable source of truth for the typed name — both for the
  // op-poll page subtitle and the post-redirect done step.
  setSetting(deps.db, "setup_vault_name", vaultName);
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
    // hub#267: thread the typed name through `PARACHUTE_VAULT_NAME` so
    // vault's first-boot path (vault#342) names the created vault
    // accordingly. Skip the env override when the operator left the
    // field blank — vault's `resolveFirstBootVaultName` defaults to
    // `default` on absent env vars, so this preserves the prior
    // behaviour for the empty-input case.
    //
    // If the operator typed "default" explicitly, treat the same as
    // blank — vault's first-boot defaults to "default" anyway, so
    // skipping the env override is correct (the comparison below
    // catches both blank-trimmed-to-DEFAULT and typed-"default").
    const spawnEnv: Record<string, string> = {};
    if (vaultName !== DEFAULT_VAULT_NAME) {
      spawnEnv.PARACHUTE_VAULT_NAME = vaultName;
    }
    void runInstall(op.id, FIRST_VAULT_SHORT, vaultSpec, {
      db: deps.db,
      issuer: deps.issuer,
      manifestPath: deps.manifestPath,
      configDir: deps.configDir,
      supervisor: deps.supervisor,
      registry,
      ...(deps.run ? { run: deps.run } : {}),
      ...(Object.keys(spawnEnv).length > 0 ? { spawnEnv } : {}),
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

/**
 * POST `/admin/setup/expose`. Form-encoded.
 *
 * Persists the operator's "how will this hub be reached?" answer to
 * `hub_settings.setup_expose_mode` (hub#268 Item 2). Three valid values:
 * `localhost`, `tailnet`, `public`.
 *
 * This is also the transition where the wizard considers itself "done"
 * for the auto-approve-first-client feature (hub#268 Item 3): we open a
 * 60-minute window where the next OAuth client registration is
 * auto-approved. Reasoning lives in `hub-settings.ts`; the wizard just
 * fires it on the only event that means "operator just finished the
 * canonical onboarding."
 *
 * Gated on an admin session cookie like the vault POST is — same shape,
 * same reason.
 */
export async function handleSetupExposePost(
  req: Request,
  deps: SetupWizardDeps,
): Promise<Response> {
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
  // Already done — short-circuit to the success screen. Belt-and-braces:
  // the wizard's GET shape catches this case too, but a direct POST
  // (curl, tab race) shouldn't double-fire the auto-approve window.
  if (getSetting(deps.db, "setup_expose_mode") !== undefined) {
    return redirect("/admin/setup?just_finished=1");
  }
  const rawMode = form.get("expose_mode");
  if (!isSetupExposeMode(rawMode)) {
    return htmlResponse(
      renderExposeStep({
        csrfToken: typeof formCsrf === "string" ? formCsrf : "",
        errorMessage: `Pick one of: ${SETUP_EXPOSE_MODES.join(", ")}.`,
      }),
      400,
    );
  }
  setSetting(deps.db, "setup_expose_mode", rawMode);
  // hub#268 Item 3: open the 60-minute auto-approve window for the first
  // OAuth client registration. Logged so an operator chasing odd behavior
  // can see it fired.
  openFirstClientAutoApproveWindow(deps.db);
  console.log(
    `[setup-wizard] opened first-client auto-approve window (60min) after expose-mode=${rawMode}`,
  );
  // hub#272 Item A: auto-mint an operator token under the broad `admin`
  // scope-set + persist it once so the done-step renderer can pre-fill
  // the MCP install command with a Bearer header. The token is single-
  // use surface on the done page — the renderer deletes it from
  // hub_settings after one read so a stale tab refresh / back button
  // doesn't re-disclose the secret. The jti is still in the `tokens`
  // registry so revocation via the admin UI works as usual. Failures
  // are non-fatal: the done page falls back to the un-headered MCP
  // command + a "mint manually at /admin/tokens" hint.
  try {
    const minted = await mintOperatorToken(deps.db, session.userId, {
      issuer: deps.issuer,
      scopeSet: "admin",
    });
    setSetting(deps.db, "setup_minted_token", minted.token);
    console.log(
      `[setup-wizard] auto-minted operator token (jti=${minted.jti}, scope-set=admin) for done-screen MCP command`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[setup-wizard] failed to auto-mint operator token: ${msg}`);
  }
  return redirect("/admin/setup?just_finished=1");
}

// --- step 5 helpers: install tiles --------------------------------------

/**
 * Curated module short → display props rendered on the done-screen
 * install tiles. Order matters — list order is render order. Vault is
 * intentionally excluded (the wizard already provisioned it).
 *
 * `tagline` mirrors each module's `displayName + tagline` from
 * `FIRST_PARTY_FALLBACKS` (`src/service-spec.ts`); kept verbatim here
 * so the wizard isn't coupled to service-spec internals.
 */
const INSTALL_TILE_PROPS: ReadonlyArray<{
  short: CuratedModuleShort;
  displayName: string;
  tagline: string;
}> = [
  { short: "notes", displayName: "Notes", tagline: "Notes PWA backed by your vault." },
  {
    short: "scribe",
    displayName: "Scribe",
    tagline: "Local audio transcription for vault recordings.",
  },
];

/**
 * Construct the install-tile state array for the done step. Reads the
 * URL's `?op_<short>=<id>` query (per-module op-poll), the services.json
 * manifest (already-installed detection), and the operations registry
 * (op status snapshot). Pure-ish — only the registry call is impure.
 */
function buildInstallTiles(url: URL, deps: SetupWizardDeps): ModuleInstallTileState[] {
  const manifest = readManifest(deps.manifestPath);
  return INSTALL_TILE_PROPS.filter((p) =>
    (CURATED_MODULES as readonly string[]).includes(p.short),
  ).map((p) => {
    const spec = specFor(p.short);
    const alreadyInstalled = manifest.services.some((s) => s.name === spec.manifestName);
    const tile: ModuleInstallTileState = {
      short: p.short,
      displayName: p.displayName,
      tagline: p.tagline,
      alreadyInstalled,
    };
    const opId = url.searchParams.get(`op_${p.short}`);
    if (opId && deps.registry) {
      const op = deps.registry.get(opId);
      if (op) {
        tile.operation = {
          id: op.id,
          status: op.status,
          log: op.log,
          ...(op.error !== undefined ? { error: op.error } : {}),
        };
      }
    }
    return tile;
  });
}

/**
 * POST `/admin/setup/install/<short>`. Form-encoded, session-gated.
 *
 * Kicks off the same `runInstall` pipeline `/api/modules/<short>/install`
 * uses (hub#260) but from the wizard's session-cookie surface — no
 * separate bearer mint dance for the operator who just finished the
 * wizard.
 *
 * Returns 303 to `/admin/setup?just_finished=1&op_<short>=<opId>` so
 * the done-screen renderer picks up the op via `buildInstallTiles`.
 * Multiple in-flight installs are supported (query keeps `op_<short>`
 * per module); the auto-refresh meta keeps polling while any module
 * is pending/running.
 *
 * Rejects when:
 *   * `short` isn't a curated module short
 *   * `short === "vault"` — the wizard's vault step owns that
 *   * session cookie missing
 *   * CSRF token missing or wrong
 *   * supervisor isn't wired (CLI-mode hub)
 */
export async function handleSetupInstallPost(
  req: Request,
  short: string,
  deps: SetupWizardDeps,
): Promise<Response> {
  if (!deps.supervisor) {
    return badRequestPage(
      "Module supervisor unavailable",
      `Module installs from the wizard require container-mode \`parachute serve\`. On the on-box CLI surface, run \`parachute install ${short}\` directly.`,
    );
  }
  if (!(CURATED_MODULES as readonly string[]).includes(short) || short === "vault") {
    return badRequestPage(
      "Unknown module",
      `"${short}" is not an installable wizard module. Pick from the done-screen tiles.`,
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
      "Sign in to continue. The wizard's session cookie was set at step 2; clearing cookies between steps lands you here.",
    );
  }
  const moduleShort = short as CuratedModuleShort;
  const spec = specFor(moduleShort);
  const registry = deps.registry;
  // Idempotent short-circuit: if already supervised + running, return a
  // synthesized succeeded op rather than firing a second `bun add`.
  // Mirrors `handleSetupVaultPost` + `handleInstall`.
  const supervisorState = deps.supervisor.get(moduleShort);
  if (
    supervisorState?.status === "running" ||
    supervisorState?.status === "starting" ||
    supervisorState?.status === "restarting"
  ) {
    if (registry) {
      const op = registry.create("install", moduleShort);
      registry.update(
        op.id,
        { status: "succeeded" },
        `${moduleShort} already supervised (status=${supervisorState.status})`,
      );
      return redirect(
        `/admin/setup?just_finished=1&op_${moduleShort}=${encodeURIComponent(op.id)}`,
      );
    }
    return redirect("/admin/setup?just_finished=1");
  }
  const op = registry
    ? registry.create("install", moduleShort)
    : { id: cryptoRandomId(), status: "pending" as const, log: [] as string[] };
  if (registry) {
    void runInstall(op.id, moduleShort, spec, {
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
    console.warn(
      "[setup-wizard] handleSetupInstallPost called with no operations registry — install will NOT run. Wire deps.registry in the dispatcher.",
    );
  }
  return redirect(`/admin/setup?just_finished=1&op_${moduleShort}=${encodeURIComponent(op.id)}`);
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
  .btn-secondary {
    background: transparent;
    color: ${PALETTE.accent};
    border-color: ${PALETTE.accent};
  }
  .btn-secondary:hover {
    background: ${PALETTE.accentSoft};
  }
  /* Copy + Show buttons ride the right edge of the MCP command pre.
     Compact vertical sizing so they don't dwarf the snippet on narrow
     widths; full text wrap on the pre keeps the snippet readable
     behind them. The Show button toggles the visible mask on the
     auto-minted Bearer token (rc.11 — discoverable
     but not shoulder-surf-able). Both buttons share a small flex
     container so they stack predictably on the wrap; layout-wise we
     keep the right-edge padding on .mcp-cmd-wrap pre so the buttons
     never overlap the command text. */
  .mcp-cmd-wrap {
    position: relative;
    margin: 0.5rem 0;
  }
  .mcp-cmd-wrap pre {
    background: ${PALETTE.bg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.5rem 8.5rem 0.5rem 0.75rem;
    overflow-x: auto;
    font-size: 0.82rem;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .mcp-cmd-actions {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    display: flex;
    gap: 0.3rem;
  }
  .btn-copy, .btn-mcp-aux {
    padding: 0.25rem 0.6rem;
    font-size: 0.78rem;
    min-height: auto;
    background: ${PALETTE.cardBg};
    color: ${PALETTE.fg};
    border: 1px solid ${PALETTE.border};
    border-radius: 4px;
    cursor: pointer;
    font: inherit;
    font-size: 0.78rem;
  }
  .btn-copy:hover, .btn-mcp-aux:hover {
    border-color: ${PALETTE.accent};
    color: ${PALETTE.accent};
  }
  .mcp-cmd-wrap[data-state="revealed"] pre {
    /* Subtle visual cue that the token is currently visible — a warm
       border so the operator notices on a screencast even at low
       resolution. */
    border-color: #d4a017;
    background: rgba(212, 160, 23, 0.04);
  }
  .mcp-cmd-wrap[data-state="revealed"] .btn-mcp-aux {
    border-color: #d4a017;
    color: #6b4a00;
  }
  /* Install-tile section (hub#272 Item B). Lives above the .done-grid;
     primary "what's next?" surface. Tiles render in a responsive grid
     that collapses to one column on narrow viewports. */
  .install-tiles {
    margin: 1rem 0 1.25rem;
  }
  .install-tiles-heading {
    margin: 0 0 0.25rem;
    text-transform: none;
    letter-spacing: 0;
    font-size: 1.05rem;
    color: ${PALETTE.fg};
  }
  .install-tiles-subtitle {
    margin: 0 0 0.75rem;
    color: ${PALETTE.fgMuted};
    font-size: 0.9rem;
  }
  .install-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem;
  }
  @media (min-width: 30rem) {
    .install-grid { grid-template-columns: 1fr 1fr; }
  }
  .install-tile {
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.75rem 0.9rem;
    background: ${PALETTE.cardBg};
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .install-tile h3 {
    margin: 0;
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.1rem;
    color: ${PALETTE.fg};
  }
  .install-tile-tagline {
    margin: 0;
    color: ${PALETTE.fgMuted};
    font-size: 0.85rem;
  }
  .install-tile-form {
    margin: 0;
  }
  .install-tile-installed {
    background: ${PALETTE.accentSoft};
    border-color: ${PALETTE.accent};
  }
  .install-tile-status {
    margin: 0;
    color: ${PALETTE.success};
    font-weight: 500;
    font-size: 0.85rem;
  }
  .install-tile-running, .install-tile-pending {
    border-color: ${PALETTE.warn};
  }
  .install-tile-succeeded {
    background: ${PALETTE.accentSoft};
    border-color: ${PALETTE.accent};
  }
  .install-tile-failed {
    border-color: ${PALETTE.danger};
    background: ${PALETTE.dangerSoft};
  }
  .install-tile-log {
    margin: 0;
    font-size: 0.78rem;
  }
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

  /* expose step (hub#268 Item 2). Vertical stack of radio cards;
     each label is the full clickable hit target. */
  .expose-form { gap: 0.65rem; }
  .expose-option {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    padding: 0.85rem 1rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 8px;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
    background: ${PALETTE.cardBg};
  }
  .expose-option:hover { border-color: ${PALETTE.accent}; }
  .expose-option input[type=radio] {
    margin-top: 0.25rem;
    accent-color: ${PALETTE.accent};
    flex-shrink: 0;
  }
  .expose-option-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .expose-option-title {
    font-weight: 600;
    color: ${PALETTE.fg};
    font-size: 0.95rem;
  }
  .expose-option-desc {
    color: ${PALETTE.fgMuted};
    font-size: 0.88rem;
    line-height: 1.45;
  }
  .expose-option-cmd {
    background: ${PALETTE.bg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    margin: 0.25rem 0;
    overflow-x: auto;
  }

  /* reachable tile on the done step. Lives outside the .done-grid so it
     spans the full width — the URL itself is the headline. */
  .reachable {
    background: ${PALETTE.accentSoft};
    border-left: 3px solid ${PALETTE.accent};
    border-radius: 0 8px 8px 0;
    padding: 0.75rem 1rem;
    margin: 0 0 1rem;
  }
  .reachable h2 {
    margin: 0 0 0.4rem;
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.9rem;
    color: ${PALETTE.accent};
  }
  .reachable-url {
    margin: 0.2rem 0;
    font-size: 0.95rem;
  }
  .reachable-url code {
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.borderLight};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }
  .reachable pre {
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
    font-size: 0.82rem;
    margin: 0.4rem 0;
  }
  .reachable .fine { font-size: 0.85rem; color: ${PALETTE.fgMuted}; margin: 0.4rem 0 0; }

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
