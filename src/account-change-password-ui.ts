/**
 * Server-rendered HTML for `/account/change-password` — the user's
 * self-service password rotation surface, and the landing page for the
 * force-change-password redirect from `/login` (multi-user Phase 1 PR 3,
 * design 2026-05-20-multi-user-phase-1.md §sign-in flow change).
 *
 * Two modes share the page:
 *
 *  - **first-time login** (`mode: "first-time"`): the just-logged-in user
 *    has `password_changed: false`. Heading reads "First-time login: please
 *    choose a new password" and the page explains why the redirect fired
 *    (the admin typed the default; you should pick your own).
 *  - **rotate** (`mode: "rotate"`): a signed-in user navigated here on
 *    their own to change their password. Heading reads "Change your
 *    password" — no force-redirect framing.
 *
 * The handler decides which mode to render at request time by reading
 * the user's `passwordChanged` flag; this file is the pure renderer.
 *
 * Same chrome family as `admin-login-ui.ts` (`/login`) — inline CSS,
 * no third-party fonts, no SPA bundle. The page works without JS;
 * client-side validation is a fast-feedback layer on top of the server-
 * side `validatePassword` + match-confirm + current-≠-new checks.
 */
import { renderCsrfHiddenInput } from "./csrf.ts";
import { escapeHtml } from "./oauth-ui.ts";
import { PASSWORD_MIN_LEN } from "./users.ts";

// --- shared chrome --------------------------------------------------------
//
// Palette + font stack mirror `admin-login-ui.ts` so the change-password
// surface visually belongs to the same "Parachute pre-auth + thin-auth"
// surface family as /login. A small Phase-2 polish opportunity is to
// extract this into a shared `auth-ui-chrome.ts`; for now duplication is
// cheap and keeps the surfaces independently editable.

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
          <span class="brand-tag">account</span>
        </div>`;
}

// --- /account/change-password ---------------------------------------------

export type ChangePasswordMode = "first-time" | "rotate";

export interface RenderChangePasswordProps {
  mode: ChangePasswordMode;
  csrfToken: string;
  /** The signed-in user's display name (for the "signed in as <X>" line). */
  username: string;
  /** Where the POST handler should redirect on success (same-origin path). */
  next: string;
  /** Inline error to surface above the form after a failed POST. */
  errorMessage?: string;
  // NOTE: unused in Phase 1 (POST always redirects on success). Reserved
  // for Phase 2 self-service profile flow that may rotate-in-place and
  // re-render with a success banner.
  /** Render a success banner — used by the rotate flow when the user
   *  re-renders the form after a successful change (Phase 2; for now
   *  the POST success path always redirects so this never fires). */
  successMessage?: string;
}

export function renderChangePassword(props: RenderChangePasswordProps): string {
  const { mode, csrfToken, username, next, errorMessage, successMessage } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  const success = successMessage
    ? `<p class="success-banner">${escapeHtml(successMessage)}</p>`
    : "";

  const title =
    mode === "first-time" ? "First-time login: choose a new password" : "Change your password";
  const subtitle =
    mode === "first-time"
      ? "An admin set a default password for your account. Please pick your own before continuing — only you should know it."
      : "Pick a new password for your account.";

  const body = `
    <div class="card">
      <div class="card-header">
        ${header()}
        <h1>${escapeHtml(title)}</h1>
        <p class="subtitle">${escapeHtml(subtitle)}</p>
        <p class="signed-in">Signed in as <strong>${escapeHtml(username)}</strong>.</p>
      </div>
      ${success}
      ${error}
      <form method="POST" action="/account/change-password" class="auth-form" id="change-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <input type="hidden" name="next" value="${escapeAttr(next)}" />
        <label class="field">
          <span class="field-label">Current password</span>
          <input type="password" name="current_password" autocomplete="current-password"
            autofocus required />
        </label>
        <label class="field">
          <span class="field-label">New password</span>
          <input type="password" name="new_password" autocomplete="new-password"
            required minlength="${PASSWORD_MIN_LEN}" id="new-password" />
          <span class="field-hint">at least ${PASSWORD_MIN_LEN} characters — a passphrase is fine</span>
        </label>
        <label class="field">
          <span class="field-label">Confirm new password</span>
          <input type="password" name="new_password_confirm" autocomplete="new-password"
            required minlength="${PASSWORD_MIN_LEN}" id="new-password-confirm" />
          <span class="field-hint" id="confirm-hint"></span>
        </label>
        <button type="submit" class="btn btn-primary">Change password</button>
      </form>
    </div>
    <script>${CLIENT_VALIDATION_JS}</script>`;
  const pageTitle =
    mode === "first-time" ? "First-time login — Parachute" : "Change password — Parachute";
  return baseDocument(pageTitle, body);
}

// --- client-side validation -----------------------------------------------
//
// Fast-feedback only — the server-side handler is the authority. Mirrors
// the three server checks: minimum length, new === confirm, current ≠ new.
// Without JS the form posts normally and the server re-renders with an
// inline error message; with JS the user sees "passwords don't match" or
// "new password must differ from current" inline before submitting.

const CLIENT_VALIDATION_JS = `
(function () {
  var form = document.getElementById("change-form");
  if (!form) return;
  var newPw = document.getElementById("new-password");
  var confirm = document.getElementById("new-password-confirm");
  var current = form.querySelector('input[name="current_password"]');
  var hint = document.getElementById("confirm-hint");
  function check() {
    if (!hint) return;
    if (!confirm || !newPw || !current) return;
    if (confirm.value.length === 0) { hint.textContent = ""; return; }
    if (confirm.value !== newPw.value) {
      hint.textContent = "Passwords do not match";
      hint.style.color = "${PALETTE.danger}";
    } else if (current.value.length > 0 && current.value === newPw.value) {
      hint.textContent = "New password must differ from current";
      hint.style.color = "${PALETTE.danger}";
    } else {
      hint.textContent = "Passwords match";
      hint.style.color = "${PALETTE.success}";
    }
  }
  if (newPw) newPw.addEventListener("input", check);
  if (confirm) confirm.addEventListener("input", check);
  if (current) current.addEventListener("input", check);
  form.addEventListener("submit", function (e) {
    if (!newPw || !confirm || !current) return;
    if (newPw.value !== confirm.value) {
      e.preventDefault();
      if (hint) {
        hint.textContent = "Passwords do not match";
        hint.style.color = "${PALETTE.danger}";
      }
      return;
    }
    if (current.value === newPw.value) {
      e.preventDefault();
      if (hint) {
        hint.textContent = "New password must differ from current";
        hint.style.color = "${PALETTE.danger}";
      }
      return;
    }
  });
})();
`;

// --- styles ---------------------------------------------------------------
//
// Mirrors `admin-login-ui.ts` STYLES. If/when a shared `auth-ui-chrome.ts`
// lands these two should merge.

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
    font-size: 1.6rem;
    line-height: 1.2;
    margin: 0 0 0.4rem;
    color: ${PALETTE.fg};
  }
  .subtitle { margin: 0; color: ${PALETTE.fgMuted}; font-size: 0.95rem; }
  .signed-in {
    margin: 0.75rem 0 0;
    color: ${PALETTE.fgMuted};
    font-size: 0.85rem;
    font-family: ${FONT_MONO};
  }
  .signed-in strong { color: ${PALETTE.fg}; font-weight: 500; }

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
    color: ${PALETTE.fgMuted};
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
  .success-banner {
    background: ${PALETTE.successSoft};
    border: 1px solid ${PALETTE.success};
    border-radius: 6px;
    color: ${PALETTE.success};
    padding: 0.6rem 0.8rem;
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }

  @media (max-width: 480px) {
    main { padding: 0.75rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.4rem; }
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1 { color: #f0ece4; }
    .subtitle, .field-label, .field-hint, .signed-in { color: #a8a29a; }
    .signed-in strong { color: #f0ece4; }
    input[type=text], input[type=password] {
      background: #1f1c18; border-color: #3a362f; color: #e8e4dc;
    }
    input[type=text]:focus, input[type=password]:focus {
      background: #25221d;
    }
    .brand-tag { border-color: #3a362f; color: #a8a29a; }
  }
`;
