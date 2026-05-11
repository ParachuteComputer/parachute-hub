/**
 * Branded HTML for the hub admin login + generic error pages. Same privacy
 * posture as `oauth-ui.ts` (no third-party fonts, inline CSS, no JS). The
 * legacy server-rendered `/admin/config` portal lived here too; it was
 * retired post-SPA-rework (hub#231) — the admin SPA is the operator surface
 * now, and module config is a follow-up driven by per-module SPAs.
 *
 * Pure functions — DB, sessions live in `admin-handlers.ts`.
 */
import { renderCsrfHiddenInput } from "./csrf.ts";
import { escapeHtml } from "./oauth-ui.ts";

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

function header(): string {
  return `
        <div class="brand">
          <span class="brand-mark">⌬</span>
          <span class="brand-name">Parachute</span>
          <span class="brand-tag">admin</span>
        </div>`;
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
        ${header()}
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

  .auth-form { display: flex; flex-direction: column; gap: 0.9rem; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; }
  .field-label {
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.fgMuted};
    letter-spacing: 0.01em;
    font-family: ${FONT_MONO};
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

  @media (max-width: 480px) {
    main { padding: 0.75rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.5rem; }
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1 { color: #f0ece4; }
    .subtitle, .field-label { color: #a8a29a; }
    input[type=text], input[type=password] {
      background: #1f1c18; border-color: #3a362f; color: #e8e4dc;
    }
    input[type=text]:focus, input[type=password]:focus {
      background: #25221d;
    }
    .brand-tag { border-color: #3a362f; color: #a8a29a; }
  }
`;
