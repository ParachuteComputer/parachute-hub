/**
 * Branded HTML for the hub admin pages — login + config portal (#46). Same
 * privacy posture as `oauth-ui.ts` (no third-party fonts, inline CSS, no JS),
 * but laid out wider and quieter — admin pages aren't an authorization
 * decision, they're a config form. Sharing the brand mark + palette but not
 * the per-page chrome keeps the visual context distinct ("you're configuring
 * a module" vs. "you're authorizing an app").
 *
 * Pure functions — DB, filesystem, lifecycle live in `admin-handlers.ts`.
 */
import { renderCsrfHiddenInput } from "./csrf.ts";
import type { ConfigSchemaProperty } from "./module-manifest.ts";
import { escapeHtml } from "./oauth-ui.ts";

import type { ConfigurableModule } from "./admin-config.ts";

// --- shared chrome ---------------------------------------------------------

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
  success: "#3d6849",
  successSoft: "rgba(61, 104, 73, 0.08)",
} as const;

const FONT_SERIF = `Georgia, "Times New Roman", serif`;
const FONT_SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const FONT_MONO = `ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace`;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function baseDocument(title: string, body: string, layout: "narrow" | "wide" = "narrow"): string {
  const cls = layout === "wide" ? "main-wide" : "";
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
  <main class="${cls}">
${body}
  </main>
</body>
</html>`;
}

// --- /login ---------------------------------------------------------------

export interface AdminLoginProps {
  /** Continuation path after successful login — submitted as a hidden field. */
  next: string;
  csrfToken: string;
  errorMessage?: string;
}

export function renderAdminLogin(props: AdminLoginProps): string {
  const { next, csrfToken, errorMessage } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  const body = `
    <div class="card">
      <div class="card-header">
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
          <span class="brand-tag">admin</span>
        </div>
        <h1>Sign in</h1>
        <p class="subtitle">to administer this hub</p>
      </div>
      ${error}
      <form method="POST" action="/login" class="auth-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <input type="hidden" name="next" value="${escapeAttr(next)}" />
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
  return baseDocument("Sign in to Parachute Hub admin", body);
}

// --- /admin/config ---------------------------------------------------------

export interface ModuleStatus {
  /** Top-level error (e.g. config write failed). */
  errorMessage?: string;
  /** Per-field errors keyed by property name. */
  fieldErrors?: Record<string, string>;
  /** "Saved" / "Saved and restarted" banner. */
  successMessage?: string;
  /** Pending values to re-render on validation failure. */
  pending?: Record<string, string | boolean | undefined>;
}

export interface AdminConfigModuleView {
  module: ConfigurableModule;
  /** Current on-disk values; `validateAndCoerce`-ready (strings/numbers/booleans). */
  current: Record<string, unknown>;
  /** Set when config.json existed but couldn't be parsed. */
  parseError?: string;
  status?: ModuleStatus;
}

export interface AdminConfigPageProps {
  modules: AdminConfigModuleView[];
  csrfToken: string;
}

export function renderAdminConfigPage(props: AdminConfigPageProps): string {
  const { modules, csrfToken } = props;
  if (modules.length === 0) {
    const body = `
    <div class="card admin-empty">
      ${header()}
      <h1>Module config</h1>
      <p class="subtitle">No installed module declares a <code>configSchema</code> in its <code>.parachute/module.json</code>.</p>
      <p class="empty-hint">
        Once a module ships an editable config schema, this page will let you tune its values and restart it
        without leaving the hub. Until then there's nothing to configure here.
      </p>
    </div>`;
    return baseDocument("Module config — Parachute Hub", body);
  }
  const sections = modules.map((m) => renderModuleSection(m, csrfToken)).join("\n");
  const body = `
    <div class="page-header">
      ${header()}
      <h1>Module config</h1>
      <p class="subtitle">Edit a module's configuration and restart it without leaving the hub.</p>
    </div>
    ${sections}`;
  return baseDocument("Module config — Parachute Hub", body, "wide");
}

function header(): string {
  return `
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
          <span class="brand-tag">admin</span>
        </div>`;
}

function renderModuleSection(view: AdminConfigModuleView, csrfToken: string): string {
  const { module, current, parseError, status } = view;
  const action = `/admin/config/${encodeURIComponent(module.name)}`;
  const banner = renderStatusBanner(status, parseError);
  const tagline = module.tagline
    ? `<p class="module-tagline">${escapeHtml(module.tagline)}</p>`
    : "";
  const fields = Object.entries(module.schema.properties)
    .map(([key, prop]) => {
      const required = (module.schema.required ?? []).includes(key);
      const error = status?.fieldErrors?.[key];
      const pending = status?.pending?.[key];
      const value = pending !== undefined ? pending : current[key];
      return renderField(key, prop, value, required, error);
    })
    .join("\n        ");
  return `
    <section class="card module-card" id="module-${escapeAttr(module.name)}">
      <header class="module-header">
        <h2 class="module-name">${escapeHtml(module.displayName)}</h2>
        <code class="module-id">${escapeHtml(module.name)}</code>
        ${tagline}
      </header>
      ${banner}
      <form method="POST" action="${escapeAttr(action)}" class="config-form">
        ${renderCsrfHiddenInput(csrfToken)}
        ${fields}
        <div class="button-row">
          <button type="submit" class="btn btn-primary">Save &amp; restart ${escapeHtml(module.displayName)}</button>
        </div>
      </form>
    </section>`;
}

function renderStatusBanner(
  status: ModuleStatus | undefined,
  parseError: string | undefined,
): string {
  if (status?.successMessage) {
    return `<p class="banner banner-success">${escapeHtml(status.successMessage)}</p>`;
  }
  if (status?.errorMessage) {
    return `<p class="banner banner-error">${escapeHtml(status.errorMessage)}</p>`;
  }
  if (parseError) {
    return `<p class="banner banner-warn">Existing <code>config.json</code> couldn't be parsed (${escapeHtml(parseError)}). Submitting will overwrite it with the values below.</p>`;
  }
  return "";
}

function renderField(
  key: string,
  prop: ConfigSchemaProperty,
  current: unknown,
  required: boolean,
  error: string | undefined,
): string {
  const description = prop.description
    ? `<span class="field-description">${escapeHtml(prop.description)}</span>`
    : "";
  const errorEl = error ? `<span class="field-error">${escapeHtml(error)}</span>` : "";
  const requiredMark = required ? `<span class="field-required" aria-hidden="true">*</span>` : "";
  const labelText = `${escapeHtml(key)}${requiredMark}`;
  const inputHtml = renderInput(key, prop, current);
  return `<label class="field${error ? " field-has-error" : ""}">
          <span class="field-label">${labelText}</span>
          ${description}
          ${inputHtml}
          ${errorEl}
        </label>`;
}

function renderInput(key: string, prop: ConfigSchemaProperty, current: unknown): string {
  const name = escapeAttr(key);
  if (prop.type === "boolean") {
    const checked = coerceBooleanCurrent(current, prop) ? " checked" : "";
    return `<span class="checkbox-row">
            <input type="checkbox" name="${name}" value="true"${checked} />
            <span class="checkbox-hint">${escapeHtml(prop.description ?? "Enabled when checked.")}</span>
          </span>`;
  }
  if (prop.enum) {
    const fallback = prop.default ?? prop.enum[0];
    const selected = current ?? fallback;
    const options = prop.enum
      .map((opt) => {
        const v = String(opt);
        const isSelected = String(selected) === v ? " selected" : "";
        return `<option value="${escapeAttr(v)}"${isSelected}>${escapeHtml(v)}</option>`;
      })
      .join("");
    return `<select name="${name}">${options}</select>`;
  }
  const inputType = prop.type === "string" ? "text" : "number";
  const step = prop.type === "integer" ? ' step="1"' : prop.type === "number" ? ' step="any"' : "";
  const fallback = prop.default;
  const value = current !== undefined && current !== null ? current : fallback;
  const valueAttr =
    value !== undefined && value !== null ? ` value="${escapeAttr(String(value))}"` : "";
  const placeholder =
    prop.default !== undefined ? ` placeholder="${escapeAttr(`default: ${prop.default}`)}"` : "";
  return `<input type="${inputType}" name="${name}"${step}${valueAttr}${placeholder} />`;
}

function coerceBooleanCurrent(current: unknown, prop: ConfigSchemaProperty): boolean {
  if (typeof current === "boolean") return current;
  if (current === undefined || current === null) {
    return prop.default === true;
  }
  if (typeof current === "string") return current === "true";
  return false;
}

// --- error page ------------------------------------------------------------

export function renderAdminError(props: { title: string; message: string }): string {
  const body = `
    <div class="card">
      ${header()}
      <h1 class="error-title">${escapeHtml(props.title)}</h1>
      <p class="subtitle">${escapeHtml(props.message)}</p>
    </div>`;
  return baseDocument(props.title, body);
}

// --- styles ----------------------------------------------------------------

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
  main.main-wide {
    align-items: flex-start;
    padding: 2.5rem 1.5rem;
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
  main.main-wide { flex-direction: column; align-items: center; gap: 1.25rem; }
  main.main-wide .card { max-width: 42rem; }
  .page-header {
    width: 100%;
    max-width: 42rem;
    margin-bottom: 0.25rem;
    padding: 0 0.25rem;
  }
  .page-header h1 { font-size: 2rem; }
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
  .brand-tag {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.7rem;
    color: ${PALETTE.fgMuted};
    border: 1px solid ${PALETTE.borderLight};
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
  }
  h1 {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.75rem;
    line-height: 1.2;
    margin: 0 0 0.4rem;
    color: ${PALETTE.fg};
  }
  .subtitle { margin: 0; color: ${PALETTE.fgMuted}; font-size: 0.95rem; }

  .auth-form, .config-form { display: flex; flex-direction: column; gap: 0.9rem; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field-label {
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
    letter-spacing: 0.01em;
    font-family: ${FONT_MONO};
  }
  .field-required { color: ${PALETTE.danger}; margin-left: 0.2rem; }
  .field-description {
    font-size: 0.85rem;
    color: ${PALETTE.fgMuted};
    line-height: 1.45;
  }
  .field-error {
    font-size: 0.82rem;
    color: ${PALETTE.danger};
    font-weight: 500;
  }
  .field-has-error input[type=text],
  .field-has-error input[type=number],
  .field-has-error select {
    border-color: ${PALETTE.danger};
  }
  input[type=text], input[type=password], input[type=number], select {
    font: inherit;
    width: 100%;
    padding: 0.6rem 0.75rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  input[type=text]:focus, input[type=password]:focus, input[type=number]:focus, select:focus {
    outline: none;
    border-color: ${PALETTE.accent};
    background: ${PALETTE.cardBg};
    box-shadow: 0 0 0 3px ${PALETTE.accentSoft};
  }
  .checkbox-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.45rem 0;
  }
  .checkbox-row input[type=checkbox] { margin-top: 0.2rem; }
  .checkbox-hint { font-size: 0.85rem; color: ${PALETTE.fgMuted}; }

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
  .button-row { display: flex; gap: 0.6rem; margin-top: 0.5rem; }

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

  .module-card { padding: 1.5rem 1.5rem 1.75rem; }
  .module-header { margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid ${PALETTE.borderLight}; }
  .module-name {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.4rem;
    margin: 0 0 0.25rem;
    color: ${PALETTE.fg};
  }
  .module-id {
    font-family: ${FONT_MONO};
    font-size: 0.78rem;
    color: ${PALETTE.fgMuted};
    background: ${PALETTE.bgSoft};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }
  .module-tagline {
    margin: 0.5rem 0 0;
    color: ${PALETTE.fgMuted};
    font-size: 0.9rem;
  }

  .banner {
    margin: 0 0 1rem;
    padding: 0.55rem 0.75rem;
    border-radius: 6px;
    font-size: 0.88rem;
  }
  .banner-success {
    background: ${PALETTE.successSoft};
    border: 1px solid ${PALETTE.success};
    color: ${PALETTE.success};
  }
  .banner-error {
    background: ${PALETTE.dangerSoft};
    border: 1px solid ${PALETTE.danger};
    color: ${PALETTE.danger};
  }
  .banner-warn {
    background: ${PALETTE.bgSoft};
    border: 1px dashed ${PALETTE.fgDim};
    color: ${PALETTE.fgMuted};
  }
  .banner code {
    font-family: ${FONT_MONO};
    background: ${PALETTE.cardBg};
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
  }

  .empty-hint {
    margin-top: 1rem;
    color: ${PALETTE.fgMuted};
    font-size: 0.9rem;
  }
  .empty-hint code {
    font-family: ${FONT_MONO};
    font-size: 0.82rem;
    background: ${PALETTE.bgSoft};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }

  @media (max-width: 480px) {
    main { padding: 0.75rem; }
    main.main-wide { padding: 1rem 0.75rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.5rem; }
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1 { color: #f0ece4; }
    .subtitle, .field-label, .field-description { color: #a8a29a; }
    input[type=text], input[type=password], input[type=number], select {
      background: #1f1c18; border-color: #3a362f; color: #e8e4dc;
    }
    input[type=text]:focus, input[type=password]:focus, input[type=number]:focus, select:focus {
      background: #25221d;
    }
    .module-id { background: #1f1c18; color: #a8a29a; }
    .module-header { border-color: #3a362f; }
    .empty-hint code { background: #1f1c18; }
    .banner-warn { background: #1f1c18; }
    .banner code { background: #1a1815; }
    .brand-tag { border-color: #3a362f; color: #a8a29a; }
  }
`;
