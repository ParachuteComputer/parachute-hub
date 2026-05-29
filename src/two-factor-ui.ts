/**
 * Server-rendered HTML for `/account/2fa` — user self-service TOTP 2FA
 * enroll / disenroll (hub#473). Part of the `/account/*` surface family;
 * chrome cloned from `account-home-ui.ts` so the family stays cohesive.
 *
 * Three render states:
 *
 *   - `not-enrolled`: a "Set up two-factor authentication" card with a POST
 *     button that starts enrollment.
 *   - `enrolling`: the QR code (inline SVG, no external fetch) + the manual
 *     base32 key + a confirm-code form. Posting a valid code finalizes.
 *   - `enrolled`: status (enabled since …, N backup codes left) + a disenroll
 *     form (requires the current password).
 *
 * Plus `backup-codes`: a one-time display of the freshly-minted backup codes
 * after a successful enroll-confirm — shown ONCE, never retrievable.
 *
 * Pure renderer — no DB, no fs. The route handlers in `two-factor-handlers.ts`
 * resolve the user + state, then call in here.
 */
import { WORDMARK_TEXT, brandMarkSvg } from "./brand.ts";
import { renderCsrfHiddenInput } from "./csrf.ts";
import { escapeHtml } from "./oauth-ui.ts";

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
          <span class="brand-mark" aria-hidden="true">${brandMarkSvg(20, "account-2fa")}</span>
          <span class="brand-name">${WORDMARK_TEXT}</span>
          <span class="brand-tag">two-factor</span>
        </div>`;
}

function errorBanner(msg: string | undefined): string {
  return msg ? `<p class="error-banner">${escapeHtml(msg)}</p>` : "";
}

function noticeBanner(msg: string | undefined): string {
  return msg ? `<p class="notice-banner">${escapeHtml(msg)}</p>` : "";
}

function shell(title: string, inner: string): string {
  const body = `
    <div class="card">
      <div class="card-header">
        ${header()}
        <h1>Two-factor authentication</h1>
        <p class="subtitle">Protect your hub sign-in with a one-time code from an authenticator app.</p>
      </div>
      ${inner}
      <p class="footer-link"><a href="/account/">← Back to your account</a></p>
    </div>`;
  return baseDocument(title, body);
}

// --- not enrolled ---------------------------------------------------------

export interface NotEnrolledProps {
  csrfToken: string;
  errorMessage?: string;
  notice?: string;
}

export function renderTwoFactorNotEnrolled(props: NotEnrolledProps): string {
  const inner = `
      ${errorBanner(props.errorMessage)}
      ${noticeBanner(props.notice)}
      <section class="section">
        <p class="status status-off"><span class="dot dot-off"></span>Two-factor authentication is <strong>off</strong>.</p>
        <p>When enabled, signing in will require a 6-digit code from your authenticator
           app (Google Authenticator, 1Password, Authy, …) in addition to your password.</p>
        <form method="POST" action="/account/2fa" class="action-form">
          ${renderCsrfHiddenInput(props.csrfToken)}
          <input type="hidden" name="action" value="start" />
          <button type="submit" class="btn btn-primary">Set up two-factor authentication</button>
        </form>
      </section>`;
  return shell("Two-factor authentication — Parachute", inner);
}

// --- enrolling (show QR + confirm) ----------------------------------------

export interface EnrollingProps {
  csrfToken: string;
  /** Inline SVG markup for the otpauth QR code. */
  qrSvg: string;
  /** Base32 secret for manual authenticator entry. */
  secret: string;
  errorMessage?: string;
}

export function renderTwoFactorEnrolling(props: EnrollingProps): string {
  const inner = `
      ${errorBanner(props.errorMessage)}
      <section class="section">
        <p>1. Scan this QR code with your authenticator app:</p>
        <div class="qr" aria-label="TOTP QR code">${props.qrSvg}</div>
        <p>Can't scan? Enter this key manually:</p>
        <div class="copy-row">
          <code data-testid="totp-secret">${escapeHtml(props.secret)}</code>
        </div>
        <p>2. Enter the 6-digit code your app shows to confirm:</p>
        <form method="POST" action="/account/2fa" class="action-form">
          ${renderCsrfHiddenInput(props.csrfToken)}
          <input type="hidden" name="action" value="confirm" />
          <input type="hidden" name="secret" value="${escapeAttr(props.secret)}" />
          <label class="field">
            <span class="field-label">Authentication code</span>
            <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code"
                   autofocus required placeholder="123456" />
          </label>
          <button type="submit" class="btn btn-primary">Confirm and enable</button>
        </form>
      </section>`;
  return shell("Set up two-factor authentication — Parachute", inner);
}

// --- backup codes (one-time display) --------------------------------------

export interface BackupCodesProps {
  codes: string[];
}

export function renderTwoFactorBackupCodes(props: BackupCodesProps): string {
  const list = props.codes
    .map((c) => `<li><code>${escapeHtml(c)}</code></li>`)
    .join("\n          ");
  const inner = `
      <section class="section">
        <p class="status status-on"><span class="dot dot-on"></span>Two-factor authentication is now <strong>on</strong>.</p>
        <p class="warn-text"><strong>Save these backup codes now.</strong> Each can be used once to
           sign in if you lose access to your authenticator app. They are shown only once —
           store them somewhere safe.</p>
        <ul class="backup-codes" data-testid="backup-codes">
          ${list}
        </ul>
        <p class="footer-link"><a class="btn btn-secondary" href="/account/2fa">I've saved my codes</a></p>
      </section>`;
  return shell("Backup codes — Parachute", inner);
}

// --- enrolled (status + disenroll) ----------------------------------------

export interface EnrolledProps {
  csrfToken: string;
  /** ISO-8601 enrollment timestamp, or null. */
  enrolledAt: string | null;
  /** Count of unused backup codes. */
  backupCodesRemaining: number;
  errorMessage?: string;
  notice?: string;
}

export function renderTwoFactorEnrolled(props: EnrolledProps): string {
  const since = props.enrolledAt ? ` (since ${escapeHtml(props.enrolledAt.slice(0, 10))})` : "";
  const inner = `
      ${errorBanner(props.errorMessage)}
      ${noticeBanner(props.notice)}
      <section class="section">
        <p class="status status-on"><span class="dot dot-on"></span>Two-factor authentication is <strong>on</strong>${since}.</p>
        <p>You have <strong data-testid="backup-remaining">${props.backupCodesRemaining}</strong>
           backup code${props.backupCodesRemaining === 1 ? "" : "s"} remaining.</p>
      </section>
      <section class="section">
        <h2>Turn off two-factor authentication</h2>
        <p>Disabling 2FA removes the second-factor requirement from your sign-in.
           Enter your current password to confirm.</p>
        <form method="POST" action="/account/2fa" class="action-form">
          ${renderCsrfHiddenInput(props.csrfToken)}
          <input type="hidden" name="action" value="disable" />
          <label class="field">
            <span class="field-label">Current password</span>
            <input type="password" name="password" autocomplete="current-password" required />
          </label>
          <button type="submit" class="btn btn-danger">Turn off two-factor authentication</button>
        </form>
      </section>`;
  return shell("Two-factor authentication — Parachute", inner);
}

// --- styles ---------------------------------------------------------------

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
    align-items: flex-start;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem 1.5rem;
  }
  .card {
    width: 100%;
    max-width: 34rem;
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
    font-size: 1.6rem;
    line-height: 1.2;
    margin: 0 0 0.4rem;
    color: ${PALETTE.fg};
  }
  h2 {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1.15rem;
    line-height: 1.25;
    margin: 0 0 0.6rem;
    color: ${PALETTE.fg};
  }
  .subtitle { margin: 0; color: ${PALETTE.fgMuted}; font-size: 0.95rem; }

  .section {
    border-top: 1px solid ${PALETTE.borderLight};
    padding-top: 1.25rem;
    margin-top: 1.25rem;
  }
  .section p { margin: 0.5rem 0; }

  .status { font-weight: 500; display: flex; align-items: center; gap: 0.5rem; }
  .dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 999px; }
  .dot-on { background: ${PALETTE.success}; }
  .dot-off { background: ${PALETTE.fgDim}; }
  .status-on strong { color: ${PALETTE.success}; }

  .qr {
    width: 200px;
    height: 200px;
    margin: 0.75rem 0;
    padding: 0.6rem;
    background: #ffffff;
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
  }
  .qr svg { width: 100%; height: 100%; display: block; }

  .copy-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: ${PALETTE.bgSoft};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.5rem 0.6rem;
    margin: 0.4rem 0 0.75rem;
  }
  .copy-row code {
    flex: 1 1 auto;
    overflow-x: auto;
    white-space: nowrap;
    background: transparent;
    padding: 0;
    font-size: 0.95rem;
    letter-spacing: 0.08em;
  }

  .backup-codes {
    list-style: none;
    margin: 0.75rem 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.5rem;
  }
  .backup-codes code {
    font-size: 0.95rem;
    letter-spacing: 0.04em;
    display: block;
    text-align: center;
    padding: 0.4rem;
  }
  .warn-text {
    background: ${PALETTE.dangerSoft};
    border: 1px solid ${PALETTE.danger};
    border-radius: 6px;
    color: ${PALETTE.danger};
    padding: 0.6rem 0.8rem;
  }

  code {
    font-family: ${FONT_MONO};
    background: ${PALETTE.bgSoft};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.88em;
  }

  .action-form { display: flex; flex-direction: column; gap: 0.9rem; margin-top: 0.75rem; }
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
    padding: 0.6rem 1.1rem;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
    align-self: flex-start;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .btn-primary { background: ${PALETTE.accent}; color: ${PALETTE.cardBg}; }
  .btn-primary:hover { background: ${PALETTE.accentHover}; }
  .btn-secondary { background: transparent; color: ${PALETTE.fg}; border-color: ${PALETTE.border}; }
  .btn-secondary:hover { background: ${PALETTE.bgSoft}; border-color: ${PALETTE.accent}; }
  .btn-danger { background: ${PALETTE.danger}; color: ${PALETTE.cardBg}; }
  .btn-danger:hover { background: #8a3023; }

  .error-banner {
    background: ${PALETTE.dangerSoft};
    border: 1px solid ${PALETTE.danger};
    border-radius: 6px;
    color: ${PALETTE.danger};
    padding: 0.6rem 0.8rem;
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }
  .notice-banner {
    background: ${PALETTE.successSoft};
    border: 1px solid ${PALETTE.success};
    border-radius: 6px;
    color: ${PALETTE.success};
    padding: 0.6rem 0.8rem;
    margin: 0 0 1rem;
    font-size: 0.9rem;
  }

  .footer-link { margin-top: 1.25rem; }
  a { color: ${PALETTE.accent}; }
  a:hover { color: ${PALETTE.accentHover}; }

  @media (max-width: 480px) {
    main { padding: 1rem 0.75rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.4rem; }
    .backup-codes { grid-template-columns: 1fr; }
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1, h2 { color: #f0ece4; }
    .subtitle, .field-label { color: #a8a29a; }
    code { background: #1f1c18; color: #e8e4dc; }
    .copy-row { background: #1f1c18; border-color: #3a362f; }
    .copy-row code { background: transparent; }
    .section { border-top-color: #3a362f; }
    .brand-tag { border-color: #3a362f; color: #a8a29a; }
    input[type=text], input[type=password] {
      background: #1f1c18; border-color: #3a362f; color: #e8e4dc;
    }
    input[type=text]:focus, input[type=password]:focus { background: #25221d; }
    .btn-secondary { color: #e8e4dc; border-color: #3a362f; }
    .btn-secondary:hover { background: #1f1c18; border-color: ${PALETTE.accent}; }
  }
`;
