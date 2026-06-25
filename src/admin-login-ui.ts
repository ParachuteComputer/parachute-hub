/**
 * Branded HTML for the hub's pre-auth surfaces: the `/login` form and the
 * generic admin error page surfaced when CSRF or rate-limit gates fire on
 * `/login` and `/logout`. Same privacy posture as `oauth-ui.ts` (no third-
 * party fonts, inline CSS, no JS) — these pages are pre-auth and have to
 * stand alone without the SPA shell.
 *
 * History: this file was `admin-config-ui.ts` and held the server-rendered
 * `/admin/config` module-config portal (hub#46). #240 retired the portal
 * post-SPA-rework; the file shed everything except the two renderers below.
 * Renamed to `admin-login-ui.ts` in #241 so the filename matches the content.
 *
 * Pure functions — DB, sessions live in `admin-handlers.ts`.
 */
import { WORDMARK_TEXT, brandMarkSvg } from "./brand.ts";
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
          <span class="brand-mark" aria-hidden="true">${brandMarkSvg(20, "admin-login")}</span>
          <span class="brand-name">${WORDMARK_TEXT}</span>
          <span class="brand-tag">sign in</span>
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
        <h1>Sign in to your Parachute account</h1>
        <p class="subtitle">Hub operators and invited members sign in here.</p>
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
  return baseDocument("Sign in — Parachute", body);
}

// --- /login/2fa (second-factor step) --------------------------------------

export interface TotpChallengeProps {
  /** Continuation path after a successful second factor — hidden field. */
  next: string;
  csrfToken: string;
  errorMessage?: string;
}

/**
 * Server-rendered "enter your code" page shown after a correct password when
 * the user has 2FA enrolled (hub#473). Posts to `/login/2fa` along with the
 * pending-login cookie minted by the password step. Accepts either a 6-digit
 * TOTP code or a backup code in the same field — the handler tries TOTP first,
 * then backup codes.
 *
 * No JS, stands alone like `/login`. `inputmode`/`autocomplete` hint mobile
 * keyboards toward a numeric pad + the platform's one-time-code autofill.
 */
export function renderTotpChallenge(props: TotpChallengeProps): string {
  const { next, csrfToken, errorMessage } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  const body = `
    <div class="card">
      <div class="card-header">
        ${header()}
        <h1>Two-factor authentication</h1>
        <p class="subtitle">Enter the 6-digit code from your authenticator app, or a backup code.</p>
      </div>
      ${error}
      <form method="POST" action="/login/2fa" class="auth-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <input type="hidden" name="next" value="${escapeAttr(next)}" />
        <label class="field">
          <span class="field-label">Authentication code</span>
          <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code"
                 autofocus required placeholder="123456" />
        </label>
        <button type="submit" class="btn btn-primary">Verify</button>
      </form>
    </div>`;
  return baseDocument("Two-factor authentication — Parachute", body);
}

// --- invite redemption ( /account/setup/<token> ) --------------------------

export interface InviteSetupProps {
  /** The raw token from the URL — POSTs back to the same path. */
  token: string;
  csrfToken: string;
  /**
   * When the invite pins a vault name the redeemer can't choose one — we show
   * it read-only. When null the redeemer names their own vault (a text field).
   * With `provisionVault: false` a pinned name is a SHARED-VAULT invite: the
   * redeemer is being given `role` access to the operator's existing vault.
   */
  pinnedVaultName: string | null;
  /**
   * When the invite pre-names the account, the username is shown read-only
   * and ENFORCED server-side (the redeem handler ignores the form field).
   * Null = the redeemer picks their own.
   */
  pinnedUsername: string | null;
  /** The `user_vaults` role redemption grants ('read' | 'write') — shown on the shared-vault row. */
  role: string;
  /** Whether redemption provisions a vault at all (shows the vault row iff true). */
  provisionVault: boolean;
  /**
   * Whether to collect the redeemer's email (B2). True for public-signup
   * (multi-use) links — the operator must be able to reach the stranger who
   * signed up; false for legacy single-use admin/friends invites. Default
   * false (omitted) preserves the friends flow's no-email form.
   */
  collectEmail?: boolean;
  username?: string;
  /** Echoed email value on a re-render so the redeemer doesn't retype it. */
  email?: string;
  vaultName?: string;
  errorMessage?: string;
}

/**
 * Server-rendered "claim your invite" form for `/account/setup/<token>`.
 * Stands alone without the SPA (same posture as `/login` + the setup wizard):
 * a brand-new invitee hits this with no session and no JS. Posts back to the
 * same `/account/setup/<token>` path. Reuses the shared login chrome.
 */
export function renderInviteSetup(props: InviteSetupProps): string {
  const {
    token,
    csrfToken,
    pinnedVaultName,
    pinnedUsername,
    role,
    provisionVault,
    collectEmail,
    username,
    email,
    vaultName,
    errorMessage,
  } = props;
  const error = errorMessage ? `<p class="error-banner">${escapeHtml(errorMessage)}</p>` : "";
  const usernameAttr = username ? ` value="${escapeAttr(username)}"` : "";
  const emailAttr = email ? ` value="${escapeAttr(email)}"` : "";

  // Email row (B2): shown ONLY for public-signup (multi-use) links so the
  // operator can reach the stranger who signed up. `type=email` gets the
  // browser's built-in client-side format check (the server re-validates).
  const emailRow = collectEmail
    ? `
        <label class="field">
          <span class="field-label">Email</span>
          <input type="email" name="email" autocomplete="email" required
            spellcheck="false" autocapitalize="off"${emailAttr} />
          <span class="field-hint">So your hub operator can reach you.</span>
        </label>`
    : "";

  // Username row: pre-named → read-only display (the server ENFORCES the
  // invite's username; the disabled input never submits and the handler
  // ignores the field anyway). Unpinned → the normal pick-a-name field.
  const usernameRow =
    pinnedUsername !== null
      ? `
        <label class="field">
          <span class="field-label">Username</span>
          <input type="text" value="${escapeAttr(pinnedUsername)}" readonly disabled />
          <span class="field-hint">Your hub operator chose this username for you.</span>
        </label>`
      : `
        <label class="field">
          <span class="field-label">Username</span>
          <input type="text" name="username" id="username" autocomplete="username" autofocus
            required minlength="2" maxlength="32"
            pattern="[a-z0-9_-]+" title="lowercase letters, digits, _ - (2–32 chars)"
            spellcheck="false" autocapitalize="off"${usernameAttr} />
          <span class="field-hint">lowercase letters, digits, <code>_</code>, <code>-</code></span>
        </label>`;

  // Vault row. Provisioning invites show the new vault's name (pinned →
  // read-only; unpinned → a text field the redeemer fills). A shared-vault
  // invite (no provisioning + a pinned name) shows what the redeemer is
  // being given access to, including the role.
  let vaultRow = "";
  if (!provisionVault && pinnedVaultName !== null) {
    const roleLabel = role === "read" ? "read-only" : "read &amp; write";
    vaultRow = `
        <label class="field">
          <span class="field-label">Shared vault</span>
          <input type="text" value="${escapeAttr(pinnedVaultName)}" readonly disabled />
          <span class="field-hint">You're being given ${roleLabel} access to this existing vault.</span>
        </label>`;
  }
  if (provisionVault) {
    if (pinnedVaultName !== null) {
      vaultRow = `
        <label class="field">
          <span class="field-label">Your vault</span>
          <input type="text" value="${escapeAttr(pinnedVaultName)}" readonly disabled />
          <span class="field-hint">Your hub operator named this vault for you.</span>
        </label>`;
    } else {
      const vaultAttr = vaultName ? ` value="${escapeAttr(vaultName)}"` : "";
      // OPTIONAL (not `required`): a blank submission defaults the vault name
      // to the chosen username, resolved server-side (this form is no-JS, so
      // the server is the source of truth). The inline script below is a
      // progressive-enhancement pre-fill only.
      vaultRow = `
        <label class="field">
          <span class="field-label">Name your vault</span>
          <input type="text" name="vault_name" id="vault_name" autocomplete="off"
            minlength="2" maxlength="32"
            pattern="[a-z0-9_-]+" title="lowercase letters, digits, _ - (2–32 chars)"
            spellcheck="false" autocapitalize="off"
            placeholder="defaults to your username"${vaultAttr} />
          <span class="field-hint">lowercase letters, digits, <code>_</code>, <code>-</code> (2–32 chars). Leave blank to use your username.</span>
        </label>`;
    }
  }

  // Progressive enhancement ONLY: mirror the username into the (empty) vault
  // field as the user types, so they see the default before submitting. The
  // server applies the same default with no JS (the field is optional), so
  // this is purely cosmetic — it stops mirroring the moment the user edits the
  // vault field directly. Shown only for the unpinned-provision case.
  const vaultPrefillScript =
    provisionVault && pinnedVaultName === null
      ? `
    <script>
      (function () {
        var u = document.getElementById("username");
        var v = document.getElementById("vault_name");
        if (!u || !v) return;
        var dirty = v.value !== "";
        v.addEventListener("input", function () { dirty = true; });
        u.addEventListener("input", function () {
          if (!dirty) v.value = u.value;
        });
      })();
    </script>`
      : "";

  const body = `
    <div class="card">
      <div class="card-header">
        ${header()}
        <h1>Claim your invite</h1>
        <p class="subtitle">${
          pinnedUsername !== null ? "Pick a password" : "Pick a username and password"
        } to create your Parachute account${
          provisionVault
            ? " and your own vault"
            : pinnedVaultName !== null
              ? " with access to a shared vault"
              : ""
        }.</p>
      </div>
      ${error}
      <form method="POST" action="/account/setup/${escapeAttr(token)}" class="auth-form">
        ${renderCsrfHiddenInput(csrfToken)}
        ${usernameRow}
        ${emailRow}
        <label class="field">
          <span class="field-label">Password</span>
          <input type="password" name="password" autocomplete="new-password"
            required minlength="12" />
          <span class="field-hint">at least 12 characters</span>
        </label>
        <label class="field">
          <span class="field-label">Confirm password</span>
          <input type="password" name="password_confirm" autocomplete="new-password"
            required minlength="12" />
        </label>
        ${vaultRow}
        <button type="submit" class="btn btn-primary">Create my account</button>
      </form>
    </div>${vaultPrefillScript}`;
  return baseDocument("Claim your invite — Parachute", body);
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
  .brand-mark { display: inline-flex; line-height: 0; }
  .brand-mark svg { width: 20px; height: 20px; }
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
  input[type=text], input[type=password], input[type=email] {
    font: inherit;
    width: 100%;
    padding: 0.6rem 0.75rem;
    border: 1px solid ${PALETTE.border};
    border-radius: 6px;
    background: ${PALETTE.bg};
    color: ${PALETTE.fg};
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  input[type=text]:focus, input[type=password]:focus, input[type=email]:focus {
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
    input[type=text], input[type=password], input[type=email] {
      background: #1f1c18; border-color: #3a362f; color: #e8e4dc;
    }
    input[type=text]:focus, input[type=password]:focus, input[type=email]:focus {
      background: #25221d;
    }
    .brand-tag { border-color: #3a362f; color: #a8a29a; }
  }
`;
