/**
 * Branded HTML templates for the OAuth login + consent + error screens.
 *
 * Pulled out of `oauth-handlers.ts` so the handlers stay focused on protocol
 * logic and the templates stay focused on presentation. Pure functions —
 * no DB access, no side channels.
 *
 * Design choices:
 *   - **No external font CDN.** OAuth screens see who's logging in and what
 *     they're authorizing; loading fonts from Google would leak that to a
 *     third party. We use system-font fallbacks that approximate the
 *     parachute.computer brand (Instrument Serif → Georgia for headings,
 *     DM Sans → -apple-system for body, ui-monospace for `<code>`).
 *   - **Inline CSS in `<style>`.** Single-file delivery; no extra round-trip
 *     for a stylesheet, no caching headaches when the hub is bound to a
 *     loopback origin.
 *   - **Scope explanations come from `scope-explanations.ts`.** First-party
 *     scopes get a one-sentence operator-facing label; admin scopes get a
 *     red border so the operator looks twice. Unknown scopes (third-party
 *     module scopes that the hub doesn't know about) render verbatim.
 *   - **No JavaScript.** Entirely form-based. Submit is the only interaction.
 */
import { renderCsrfHiddenInput } from "./csrf.ts";
import { type ScopeExplanation, explainScope } from "./scope-explanations.ts";

/** Brand palette — kept in sync with parachute.computer/style.css. */
const PALETTE = {
  bg: "#faf8f4",
  bgSoft: "#f3f0ea",
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
} as const;

const FONT_SERIF = `Georgia, "Times New Roman", serif`;
const FONT_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const FONT_MONO = `ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface AuthorizeFormParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string | null;
}

export interface LoginViewProps {
  params: AuthorizeFormParams;
  errorMessage?: string;
  csrfToken: string;
}

export interface ConsentViewProps {
  params: AuthorizeFormParams;
  clientName: string;
  clientId: string;
  scopes: string[];
  csrfToken: string;
  /**
   * Set when the request includes one or more unnamed `vault:<verb>` scopes.
   * The consent screen renders a vault selector; on submit, the picked vault
   * narrows every unnamed scope to `vault:<picked>:<verb>` (Q1 of the
   * vault-config-and-scopes design — force the picker, don't default).
   */
  vaultPicker?: VaultPicker;
}

export interface VaultPicker {
  /** Verbs (`read`, `write`, `admin`) requested in unnamed shape. */
  unnamedVerbs: string[];
  /** Vault names registered on this host. Empty → caller can't approve. */
  availableVaults: string[];
}

export interface ErrorViewProps {
  title: string;
  message: string;
  status: number;
}

/**
 * Props for the "App not yet approved" view rendered when an unapproved
 * client lands on `/oauth/authorize`. When `session` is true the operator is
 * authenticated to this hub from the browser making the request, so we render
 * an inline approve form (closes #208). When false we fall back to the
 * pre-#208 CLI-only message.
 */
export interface ApprovePendingViewProps {
  /** Display name to show — falls back to client_id when no name was supplied at DCR. */
  clientName: string;
  clientId: string;
  redirectUris: string[];
  /** Scopes parsed from the original `/oauth/authorize?scope=` query param. */
  requestedScopes: string[];
  /**
   * Vault hint from the original `/oauth/authorize?vault=<name>` query param,
   * passed by Notes' VaultPopover (notes#115) when kicking the OAuth flow for
   * a specific vault. Rendered alongside scopes so the operator can tell
   * which vault they're approving access for on a multi-vault hub (closes
   * #244). Single-vault hubs leave this absent and the section omits.
   */
  requestedVault?: string;
  /**
   * When set, render the inline approve form. The form posts to
   * `/oauth/authorize/approve` with the CSRF token + a `return_to` URL the
   * server will redirect to after the approve commits — the original
   * `/oauth/authorize?...` URL so the OAuth flow re-enters with the now-
   * approved client and lands on the consent screen.
   */
  approveForm?: {
    csrfToken: string;
    returnTo: string;
  };
}

export function renderLogin(props: LoginViewProps): string {
  const { params, errorMessage, csrfToken } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
        </div>
        <h1>Sign in</h1>
        <p class="subtitle">to continue to your hub</p>
      </div>
      ${error}
      <form method="POST" action="/oauth/authorize" class="auth-form">
        <input type="hidden" name="__action" value="login" />
        ${renderCsrfHiddenInput(csrfToken)}
        ${renderHiddenInputs(params)}
        <label class="field">
          <span class="field-label">Username</span>
          <input type="text" name="username" autocomplete="username" autofocus required />
        </label>
        <label class="field">
          <span class="field-label">Password</span>
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button type="submit" class="btn btn-primary">Sign in</button>
      </form>
    </div>`;
  return baseDocument("Sign in to Parachute Hub", body);
}

export function renderConsent(props: ConsentViewProps): string {
  const { params, clientName, clientId, scopes, vaultPicker, csrfToken } = props;
  const scopeRows =
    scopes.length === 0
      ? `<li class="scope scope-empty">No scopes requested — the app gets a session token only.</li>`
      : scopes.map(renderScopeRow).join("\n");
  const pickerSection = vaultPicker ? renderVaultPicker(vaultPicker) : "";
  const approveDisabled =
    vaultPicker && vaultPicker.availableVaults.length === 0 ? " disabled" : "";
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
        </div>
        <h1>Authorize <span class="client-name">${escapeHtml(clientName)}</span>?</h1>
        <p class="subtitle">
          This app is requesting access to your Parachute account.
        </p>
        <p class="client-meta">
          <span class="client-meta-label">client_id</span>
          <code>${escapeHtml(clientId)}</code>
        </p>
      </div>
      <section class="scopes">
        <h2 class="scopes-title">Permissions requested</h2>
        <ul class="scope-list">${scopeRows}</ul>
      </section>
      <form method="POST" action="/oauth/authorize" class="auth-form consent-form">
        <input type="hidden" name="__action" value="consent" />
        ${renderCsrfHiddenInput(csrfToken)}
        ${renderHiddenInputs(params)}
        ${pickerSection}
        <div class="button-row">
          <button type="submit" name="approve" value="yes" class="btn btn-primary"${approveDisabled}>Approve</button>
          <button type="submit" name="approve" value="no" class="btn btn-secondary">Deny</button>
        </div>
      </form>
    </div>`;
  return baseDocument(`Authorize ${clientName}`, body);
}

function renderVaultPicker(picker: VaultPicker): string {
  const verbList = picker.unnamedVerbs.map((v) => `<code>vault:${escapeHtml(v)}</code>`).join(", ");
  if (picker.availableVaults.length === 0) {
    return `
        <section class="vault-picker vault-picker-empty">
          <h2 class="scopes-title">Pick a vault</h2>
          <p class="picker-help">
            ${verbList} need to be bound to a specific vault, but no vaults exist on this host yet.
            Create one with <code>parachute-vault create &lt;name&gt;</code> and try again.
          </p>
        </section>`;
  }
  const options = picker.availableVaults
    .map(
      (name, i) => `
            <label class="vault-option">
              <input type="radio" name="vault_pick" value="${escapeHtml(name)}"${i === 0 ? " checked" : ""} required />
              <span class="vault-option-name"><code>${escapeHtml(name)}</code></span>
            </label>`,
    )
    .join("");
  return `
        <section class="vault-picker">
          <h2 class="scopes-title">Pick a vault</h2>
          <p class="picker-help">
            ${verbList} apply to the vault you select below.
          </p>
          <div class="vault-options">${options}
          </div>
        </section>`;
}

/**
 * "App not yet approved" page (#74). When the request carries a valid
 * operator session (#208), render the inline approve form so one click lands
 * the client as `approved` and re-enters the OAuth flow at consent. Without
 * a session, fall back to the original CLI-only message — anyone hitting
 * /oauth/authorize unauthenticated to the hub itself can't be trusted to
 * approve a DCR client from the browser, so they need to drop to a terminal
 * and run `parachute auth approve-client <id>`.
 *
 * The CLI fallback hint is shown in BOTH branches: a button-equipped operator
 * may still want the CLI invocation handy (different machine, scriptable
 * context). The button is the easy path; the CLI is always-available.
 */
export function renderApprovePending(props: ApprovePendingViewProps): string {
  const { clientName, clientId, redirectUris, requestedScopes, requestedVault, approveForm } =
    props;
  const redirectList = redirectUris.map((u) => `<li><code>${escapeHtml(u)}</code></li>`).join("");
  const scopeRows =
    requestedScopes.length === 0
      ? `<li class="scope scope-empty">No scopes requested — the app gets a session token only.</li>`
      : requestedScopes.map(renderScopeRow).join("\n");
  // Vault hint (closes #244): Notes' VaultPopover (notes#115) passes
  // `vault=<name>` on `/oauth/authorize` for per-vault grants. Surface it
  // alongside scopes so a multi-vault operator can tell which vault they're
  // approving for. Missing on single-vault hubs / pre-vault-popover clients —
  // section omits when absent.
  const vaultRow = requestedVault
    ? `
        <p class="approve-meta-row">
          <span class="approve-meta-label">vault</span>
          <code class="approve-meta-value">${escapeHtml(requestedVault)}</code>
        </p>`
    : "";
  const formSection = approveForm
    ? `
      <form method="POST" action="/oauth/authorize/approve" class="auth-form approve-form">
        ${renderCsrfHiddenInput(approveForm.csrfToken)}
        <input type="hidden" name="client_id" value="${escapeHtml(clientId)}" />
        <input type="hidden" name="return_to" value="${escapeHtml(approveForm.returnTo)}" />
        <button type="submit" class="btn btn-primary">Approve and continue</button>
      </form>
      <p class="approve-cli-hint">
        Or run <code>parachute auth approve-client ${escapeHtml(clientId)}</code> from a terminal.
      </p>`
    : `
      <p class="approve-cli-hint">
        Ask the operator to run <code>parachute auth approve-client ${escapeHtml(clientId)}</code>
        from a terminal, then try again.
      </p>`;
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
        </div>
        <h1>App not yet approved</h1>
        <p class="subtitle">
          ${escapeHtml(clientName)} is registered with this hub but hasn't been approved yet.
          Review the details below before approving.
        </p>
      </div>
      <section class="approve-meta">
        <h2 class="scopes-title">Application</h2>
        <p class="approve-meta-row">
          <span class="approve-meta-label">name</span>
          <code class="approve-meta-value">${escapeHtml(clientName)}</code>
        </p>
        <p class="approve-meta-row">
          <span class="approve-meta-label">client_id</span>
          <code class="approve-meta-value">${escapeHtml(clientId)}</code>
        </p>${vaultRow}
        <div class="approve-meta-row approve-meta-row-block">
          <span class="approve-meta-label">redirect_uris</span>
          <ul class="approve-redirect-list">${redirectList}</ul>
        </div>
      </section>
      <section class="scopes">
        <h2 class="scopes-title">Permissions requested</h2>
        <ul class="scope-list">${scopeRows}</ul>
      </section>
      ${formSection}
    </div>`;
  return baseDocument("App not yet approved", body);
}

export function renderError(props: ErrorViewProps): string {
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
        </div>
        <h1 class="error-title">${escapeHtml(props.title)}</h1>
        <p class="subtitle">${escapeHtml(props.message)}</p>
      </div>
      <p class="error-help">
        If you reached this from a third-party app, the app's OAuth configuration
        may be wrong. You can safely close this window.
      </p>
    </div>`;
  return baseDocument(props.title, body);
}

function renderScopeRow(scope: string): string {
  const explanation = explainScope(scope);
  if (!explanation) {
    return `<li class="scope scope-unknown">
      <code class="scope-name">${escapeHtml(scope)}</code>
      <span class="scope-label scope-label-muted">Defined by the requesting app — no built-in description.</span>
    </li>`;
  }
  const cls = `scope scope-${explanation.level}`;
  const badge = badgeForLevel(explanation);
  return `<li class="${cls}">
      <div class="scope-head">
        <code class="scope-name">${escapeHtml(scope)}</code>
        ${badge}
      </div>
      <span class="scope-label">${escapeHtml(explanation.label)}</span>
    </li>`;
}

function badgeForLevel(explanation: ScopeExplanation): string {
  switch (explanation.level) {
    case "admin":
      return `<span class="badge badge-admin">admin</span>`;
    case "write":
      return `<span class="badge badge-write">write</span>`;
    case "send":
      return `<span class="badge badge-send">send</span>`;
    case "read":
      return `<span class="badge badge-read">read</span>`;
  }
}

export function renderHiddenInputs(p: AuthorizeFormParams): string {
  const fields: [string, string][] = [
    ["client_id", p.clientId],
    ["redirect_uri", p.redirectUri],
    ["response_type", p.responseType],
    ["scope", p.scope],
    ["code_challenge", p.codeChallenge],
    ["code_challenge_method", p.codeChallengeMethod],
  ];
  if (p.state) fields.push(["state", p.state]);
  return fields
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}" />`)
    .join("\n        ");
}

function baseDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <style>${STYLES}</style>
</head>
<body>
  <main>
${body}
  </main>
</body>
</html>`;
}

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
    max-width: 30rem;
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.border};
    border-radius: 12px;
    padding: 2rem 1.75rem;
    box-shadow: 0 1px 2px rgba(44, 42, 38, 0.04), 0 8px 24px rgba(44, 42, 38, 0.06);
  }
  .card-header { margin-bottom: 1.5rem; }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: ${PALETTE.accent};
    font-weight: 500;
    font-size: 0.95rem;
    margin-bottom: 1.25rem;
  }
  .brand-mark { font-size: 1.1rem; line-height: 1; }
  .brand-name { letter-spacing: 0.01em; }
  h1 {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.75rem;
    line-height: 1.2;
    margin: 0 0 0.4rem;
    color: ${PALETTE.fg};
  }
  h1 .client-name {
    font-style: italic;
    color: ${PALETTE.accent};
  }
  .subtitle {
    margin: 0;
    color: ${PALETTE.fgMuted};
    font-size: 0.95rem;
  }
  .client-meta {
    margin: 0.75rem 0 0;
    font-size: 0.8rem;
    color: ${PALETTE.fgDim};
    display: flex;
    gap: 0.4rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .client-meta-label { text-transform: uppercase; letter-spacing: 0.05em; }
  .client-meta code {
    font-family: ${FONT_MONO};
    font-size: 0.78rem;
    background: ${PALETTE.bgSoft};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: ${PALETTE.fgMuted};
    word-break: break-all;
  }

  .auth-form { display: flex; flex-direction: column; gap: 0.9rem; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field-label {
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
    letter-spacing: 0.01em;
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
  }
  .btn-primary {
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
    margin-top: 0.4rem;
  }
  .btn-primary:hover { background: ${PALETTE.accentHover}; }
  .btn-secondary {
    background: ${PALETTE.cardBg};
    color: ${PALETTE.fgMuted};
    border-color: ${PALETTE.border};
  }
  .btn-secondary:hover {
    color: ${PALETTE.fg};
    border-color: ${PALETTE.fgDim};
  }
  .button-row {
    display: flex;
    gap: 0.6rem;
    margin-top: 0.5rem;
  }
  .button-row .btn { flex: 1; }
  .consent-form { gap: 0; }

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
  .error-help {
    margin-top: 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid ${PALETTE.borderLight};
    color: ${PALETTE.fgMuted};
    font-size: 0.88rem;
  }

  .scopes { margin: 0 0 1.5rem; }
  .scopes-title {
    font-family: ${FONT_SANS};
    font-size: 0.78rem;
    font-weight: 600;
    color: ${PALETTE.fgMuted};
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 0.6rem;
  }
  .scope-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .scope {
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    background: ${PALETTE.bg};
  }
  .scope-empty {
    color: ${PALETTE.fgMuted};
    font-size: 0.9rem;
    background: ${PALETTE.bgSoft};
    border-style: dashed;
  }
  .scope-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.2rem;
    flex-wrap: wrap;
  }
  .scope-name {
    font-family: ${FONT_MONO};
    font-size: 0.85rem;
    color: ${PALETTE.fg};
  }
  .scope-label {
    font-size: 0.88rem;
    color: ${PALETTE.fgMuted};
    display: block;
  }
  .scope-label-muted { color: ${PALETTE.fgDim}; font-style: italic; }
  .scope-admin {
    border-color: ${PALETTE.danger};
    background: ${PALETTE.dangerSoft};
  }
  .scope-admin .scope-name { color: ${PALETTE.danger}; }

  .vault-picker {
    margin: 0 0 1.25rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    background: ${PALETTE.bgSoft};
  }
  .vault-picker .scopes-title { margin-bottom: 0.4rem; }
  .picker-help {
    margin: 0 0 0.6rem;
    font-size: 0.88rem;
    color: ${PALETTE.fgMuted};
  }
  .picker-help code {
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    background: ${PALETTE.cardBg};
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
    color: ${PALETTE.fg};
  }
  .vault-options {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .vault-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    background: ${PALETTE.cardBg};
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .vault-option:hover { border-color: ${PALETTE.accent}; }
  .vault-option input[type=radio]:focus { outline: 2px solid ${PALETTE.accent}; outline-offset: 2px; }
  .vault-option-name code {
    font-family: ${FONT_MONO};
    font-size: 0.88rem;
    color: ${PALETTE.fg};
  }
  .vault-picker-empty .picker-help { color: ${PALETTE.danger}; }
  .vault-picker-empty .picker-help code { color: ${PALETTE.fg}; }

  .approve-meta {
    margin: 0 0 1.25rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    background: ${PALETTE.bgSoft};
  }
  .approve-meta .scopes-title { margin-bottom: 0.5rem; }
  .approve-meta-row {
    margin: 0 0 0.4rem;
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .approve-meta-row:last-child { margin-bottom: 0; }
  .approve-meta-row-block { flex-direction: column; gap: 0.25rem; }
  .approve-meta-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.7rem;
    color: ${PALETTE.fgDim};
  }
  .approve-meta-value {
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    background: ${PALETTE.cardBg};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: ${PALETTE.fg};
    word-break: break-all;
  }
  .approve-redirect-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .approve-redirect-list li code {
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    background: ${PALETTE.cardBg};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: ${PALETTE.fg};
    word-break: break-all;
  }
  .approve-form { gap: 0; }
  .approve-cli-hint {
    margin-top: 1rem;
    padding-top: 0.85rem;
    border-top: 1px solid ${PALETTE.borderLight};
    color: ${PALETTE.fgMuted};
    font-size: 0.85rem;
  }
  .approve-cli-hint code {
    font-family: ${FONT_MONO};
    font-size: 0.8rem;
    background: ${PALETTE.bgSoft};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: ${PALETTE.fg};
    word-break: break-all;
  }

  .badge {
    display: inline-block;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    line-height: 1.4;
  }
  .badge-read { background: ${PALETTE.bgSoft}; color: ${PALETTE.fgMuted}; }
  .badge-write { background: ${PALETTE.accentSoft}; color: ${PALETTE.accent}; }
  .badge-send { background: ${PALETTE.accentSoft}; color: ${PALETTE.accent}; }
  .badge-admin { background: ${PALETTE.danger}; color: ${PALETTE.cardBg}; }

  @media (max-width: 480px) {
    main { padding: 0.75rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.5rem; }
    .button-row { flex-direction: column; }
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1 { color: #f0ece4; }
    .subtitle, .field-label { color: #a8a29a; }
    input[type=text], input[type=password] { background: #1f1c18; border-color: #3a362f; color: #e8e4dc; }
    input[type=text]:focus, input[type=password]:focus { background: #25221d; }
    .scope { background: #1f1c18; border-color: #3a362f; }
    .scope-name { color: #e8e4dc; }
    .client-meta code { background: #1f1c18; color: #a8a29a; }
    .btn-secondary { background: #25221d; border-color: #3a362f; color: #a8a29a; }
    .btn-secondary:hover { color: #e8e4dc; border-color: #6b6860; }
    .error-help { border-color: #3a362f; color: #a8a29a; }
    .scope-empty { background: #1a1815; }
  }
`;
