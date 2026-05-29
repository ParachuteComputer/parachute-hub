/**
 * Server-rendered HTML for `/account/` — the friend-facing user home.
 *
 * Multi-user Phase 1 follow-up. Companion to the first-admin gate on
 * `/admin/host-admin-token` (see `admin-host-admin-token.ts`): without
 * this landing surface, a non-admin friend signing in would either
 * (a) hit a 403 wall when the SPA tries to mint a host-admin bearer,
 * or (b) — pre-gate — silently escalate to full admin. The gate plus
 * this page give the friend a coherent home: their assigned vault,
 * password rotation link, sign-out.
 *
 * Pure renderer — no DB, no Bun.serve, no fs. The `/account/` route
 * handler in `hub-server.ts` resolves the user + their vault + the
 * is-first-admin flag, then calls in here. Same posture as
 * `account-change-password-ui.ts` and `oauth-ui.ts`.
 *
 * Visual chrome: cloned from `account-change-password-ui.ts` so the
 * `/account/*` surface family stays cohesive. If/when an
 * `auth-ui-chrome.ts` lands, both should consolidate.
 */
import { WORDMARK_TEXT, brandMarkSvg } from "./brand.ts";
import { renderCsrfHiddenInput } from "./csrf.ts";
import { escapeHtml } from "./oauth-ui.ts";

// --- shared chrome (mirrors account-change-password-ui.ts) ----------------

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
          <span class="brand-mark" aria-hidden="true">${brandMarkSvg(20, "account-home")}</span>
          <span class="brand-name">${WORDMARK_TEXT}</span>
          <span class="brand-tag">account</span>
        </div>`;
}

// --- /account/ ------------------------------------------------------------

export interface RenderAccountHomeOpts {
  username: string;
  /**
   * Vault instance names this user has access to (multi-user Phase 2
   * PR 2). Empty `[]` for admin posture (combined with `isFirstAdmin:
   * true` this is the hub administrator's account, whose vault access
   * is unrestricted). One or more entries for non-admin users — the
   * page renders one Notes-CTA tile per vault.
   */
  assignedVaults: string[];
  /** Force-change-password completion flag. Currently informational only. */
  passwordChanged: boolean;
  /**
   * Hub origin (no trailing slash) — the canonical URL operators connect
   * their MCP / Surface clients to. Used both in the Notes "Open" CTA
   * (encoded as `?url=...` on `notes.parachute.computer/add`) and as
   * inline-code text for the "custom client" disclosure.
   */
  hubOrigin: string;
  /**
   * Whether the signed-in user is the hub administrator (the
   * earliest-created users row). Drives the `assignedVault: null`
   * branch — admins see an "open admin" affordance; non-admins (a
   * Phase 1 shape that shouldn't normally occur — admins land with
   * `assignedVault: null`, friends always have one set) see a
   * defensive "ask the operator" message.
   */
  isFirstAdmin: boolean;
  /**
   * CSRF token for the sign-out form. Same pattern as
   * `account-change-password-ui.ts` — POSTs to `/logout` are CSRF-gated
   * to keep a cross-origin form from logging the user out.
   */
  csrfToken: string;
}

export function renderAccountHome(opts: RenderAccountHomeOpts): string {
  const { username, assignedVaults, hubOrigin, isFirstAdmin, csrfToken } = opts;
  const safeUsername = escapeHtml(username);
  // Origin is already canonicalized by the handler (trailing slash stripped),
  // but defensively re-trim so a stray slash here doesn't break the CTA href.
  const trimmedOrigin = hubOrigin.replace(/\/+$/, "");

  const vaultCard = renderVaultCard({
    assignedVaults,
    trimmedOrigin,
    isFirstAdmin,
  });

  const accountCard = renderAccountCard({
    username: safeUsername,
    csrfToken,
  });

  const body = `
    <div class="card">
      <div class="card-header">
        ${header()}
        <h1>Welcome, ${safeUsername}</h1>
        <p class="subtitle">Your Parachute account home.</p>
      </div>
      ${vaultCard}
      ${accountCard}
    </div>`;
  return baseDocument(`${username} — Parachute`, body);
}

interface VaultCardOpts {
  assignedVaults: string[];
  trimmedOrigin: string;
  isFirstAdmin: boolean;
}

/**
 * Build `<hub-origin>/vault/<name>/mcp` — the MCP endpoint a client connects
 * to. Mirrors the SPA's `mcpEndpointFor` (McpConnectCard.tsx) and the
 * wizard's `renderMcpTile`. The friend's `/account/` tile is server-rendered
 * (no SPA), so we compute it here from the hub origin + vault name rather
 * than the vault's well-known `url`.
 *
 * Exported for direct unit testing.
 */
export function accountMcpEndpoint(trimmedOrigin: string, vaultName: string): string {
  return `${trimmedOrigin}/vault/${vaultName}/mcp`;
}

/**
 * The OAuth-path `claude mcp add` command — no token, triggers browser OAuth
 * on first use. Same `parachute-<name>` server name as the SPA card and the
 * wizard tile, so a friend and the operator end up with identically-named
 * MCP servers. Exported for direct unit testing.
 */
export function accountClaudeMcpAddCommand(trimmedOrigin: string, vaultName: string): string {
  return `claude mcp add --transport http parachute-${vaultName} ${accountMcpEndpoint(
    trimmedOrigin,
    vaultName,
  )}`;
}

function renderVaultCard(opts: VaultCardOpts): string {
  const { assignedVaults, trimmedOrigin, isFirstAdmin } = opts;

  if (assignedVaults.length > 0) {
    // One vault tile per assignment (multi-user Phase 2 PR 2). Each tile
    // carries the Notes "Open" CTA AND a server-rendered MCP connect block
    // (endpoint + `claude mcp add` command, each with a copy button). The
    // connect command is the OAuth path — no token, so a non-admin friend
    // who can't run the SPA's host-admin mint still gets a working
    // connect affordance (the first `claude mcp add` use opens a browser,
    // signs them in, and approves the scope). This closes the multi-user
    // gap where the friend tile only offered the external Notes link + a
    // bare hub-origin string.
    const heading = assignedVaults.length === 1 ? "<h2>Your vault</h2>" : "<h2>Your vaults</h2>";
    const tiles = assignedVaults
      .map((vaultName) => {
        const safeVault = escapeHtml(vaultName);
        const vaultUrlForAdd = encodeURIComponent(`${trimmedOrigin}/vault/${vaultName}`);
        const endpoint = accountMcpEndpoint(trimmedOrigin, vaultName);
        const addCmd = accountClaudeMcpAddCommand(trimmedOrigin, vaultName);
        const safeEndpoint = escapeHtml(endpoint);
        const safeAddCmd = escapeHtml(addCmd);
        return `
        <div class="vault-tile" data-testid="vault-tile" data-vault-name="${safeVault}">
          <p class="vault-name"><strong>${safeVault}</strong></p>
          <p>
            <a class="btn btn-primary" href="https://notes.parachute.computer/add?url=${vaultUrlForAdd}"
               target="_blank" rel="noopener" data-testid="open-notes-cta">Open Notes ↗</a>
          </p>
          <div class="mcp-connect" data-testid="mcp-connect">
            <p class="mcp-connect-label">Connect an MCP client (Claude Code, Claude.ai)</p>
            <div class="mcp-field">
              <span class="mcp-field-label">Endpoint</span>
              <div class="copy-row">
                <code data-testid="mcp-endpoint">${safeEndpoint}</code>
                <button type="button" class="btn btn-copy" data-copy="${safeEndpoint}"
                        data-testid="copy-mcp-endpoint">Copy</button>
              </div>
            </div>
            <div class="mcp-field">
              <span class="mcp-field-label">Claude Code</span>
              <div class="copy-row">
                <code data-testid="mcp-add-command">${safeAddCmd}</code>
                <button type="button" class="btn btn-copy" data-copy="${safeAddCmd}"
                        data-testid="copy-mcp-add-command">Copy</button>
              </div>
            </div>
            <p class="mcp-connect-hint">No token needed — the command opens a browser to
               sign you in to this hub and approve access on first use.</p>
          </div>
        </div>`;
      })
      .join("");
    return `
      <section class="section" data-testid="vault-card">
        ${heading}
        <p>Open Notes — the canonical browser UI for your vault${
          assignedVaults.length === 1 ? "" : "s"
        } — or connect an MCP client
          (Claude Code, Claude.ai) with the command below. Either way you sign in to your
          hub over HTTPS and approve access on the first connection.</p>
        <div class="vault-tiles">${tiles}
        </div>
      </section>${COPY_SCRIPT}`;
  }
  if (isFirstAdmin) {
    return `
      <section class="section" data-testid="admin-card">
        <h2>Your vault</h2>
        <p>You're the hub administrator. Visit
          <a href="/admin/">the admin surface</a> to manage vaults, users, and clients.</p>
      </section>`;
  }
  // Defensive third branch — non-admin with no assigned vault. The
  // /api/users path doesn't require a vault on create (admins can leave
  // a new friend's vault list empty and fill it in later), so this
  // state is reachable through normal flows — surface a clear "ask
  // your admin" message.
  return `
    <section class="section" data-testid="no-vault-card">
      <h2>Your vault</h2>
      <p>Your account isn't assigned to a vault yet. Ask the hub operator
         to assign one.</p>
    </section>`;
}

interface AccountCardOpts {
  username: string;
  csrfToken: string;
}

function renderAccountCard(opts: AccountCardOpts): string {
  const { username, csrfToken } = opts;
  return `
    <section class="section" data-testid="account-card">
      <h2>Account</h2>
      <dl class="kv">
        <dt>Username</dt>
        <dd><code>${username}</code></dd>
      </dl>
      <p>
        <a class="account-action" href="/account/change-password" data-testid="change-password-link">Change password →</a>
      </p>
      <form method="POST" action="/logout" class="signout-form" data-testid="signout-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <button type="submit" class="btn btn-secondary">Sign out</button>
      </form>
    </section>`;
}

// --- copy-button script ---------------------------------------------------
//
// Tiny inline progressive-enhancement script for the per-tile copy buttons.
// Delegated click handler reads the command/endpoint from the button's
// `data-copy` attribute and writes it to the clipboard, flashing "Copied ✓"
// for 2s. No-ops gracefully when the Clipboard API is unavailable (insecure
// context, older browser) — the command text stays selectable in the
// codebox. Mirrors the SPA `CopyButton` posture (McpConnectCard.tsx) for a
// surface that has no React. Only emitted on the assigned-vault branch
// (where copy buttons exist).
const COPY_SCRIPT = `
  <script>
    (function () {
      document.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
        if (!btn) return;
        var value = btn.getAttribute('data-copy') || '';
        if (typeof navigator === 'undefined' || !navigator.clipboard) return;
        navigator.clipboard.writeText(value).then(function () {
          var original = btn.textContent;
          btn.textContent = 'Copied \\u2713';
          setTimeout(function () { btn.textContent = original; }, 2000);
        }).catch(function () { /* insecure context — leave selectable */ });
      });
    })();
  </script>`;

// --- styles ---------------------------------------------------------------
//
// Same brand palette + font stack as account-change-password-ui.ts so the
// `/account/*` family is visually cohesive. Extra rules (.section, .kv,
// .vault-name, .mcp-connect, .copy-row) describe the new card + MCP
// connect-block shapes this page introduces.

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
  .section p { margin: 0.4rem 0; }
  .vault-name {
    font-family: ${FONT_MONO};
    font-size: 1rem;
    margin: 0 0 0.6rem;
  }
  .vault-name strong { color: ${PALETTE.fg}; font-weight: 600; }
  .vault-tiles {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 0.75rem 0 0.4rem;
  }
  .vault-tile {
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.75rem 1rem;
    background: ${PALETTE.bgSoft};
  }
  .vault-tile p { margin: 0.2rem 0; }
  .vault-tile p:last-child { margin-top: 0.5rem; }

  .mcp-connect {
    margin-top: 0.75rem;
    padding-top: 0.6rem;
    border-top: 1px solid ${PALETTE.borderLight};
  }
  .mcp-connect-label {
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.fg};
    margin: 0 0 0.5rem;
  }
  .mcp-field { margin: 0.5rem 0; }
  .mcp-field-label {
    display: block;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${PALETTE.fgMuted};
    font-family: ${FONT_MONO};
    margin-bottom: 0.2rem;
  }
  .copy-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: ${PALETTE.cardBg};
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.4rem 0.5rem;
  }
  .copy-row code {
    flex: 1 1 auto;
    overflow-x: auto;
    white-space: nowrap;
    background: transparent;
    padding: 0;
    font-size: 0.82rem;
  }
  .btn-copy {
    flex: 0 0 auto;
    font-size: 0.8rem;
    padding: 0.3rem 0.7rem;
    background: transparent;
    color: ${PALETTE.fg};
    border-color: ${PALETTE.border};
  }
  .btn-copy:hover { background: ${PALETTE.bgSoft}; border-color: ${PALETTE.accent}; }
  .mcp-connect-hint {
    font-size: 0.82rem;
    color: ${PALETTE.fgMuted};
    margin: 0.4rem 0 0;
  }
  code {
    font-family: ${FONT_MONO};
    background: ${PALETTE.bgSoft};
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.88em;
  }

  .kv { margin: 0 0 0.6rem; padding: 0; }
  .kv dt {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${PALETTE.fgMuted};
    font-family: ${FONT_MONO};
    margin-top: 0.4rem;
  }
  .kv dd { margin: 0.15rem 0 0.4rem; }

  .btn {
    font: inherit;
    font-weight: 500;
    padding: 0.55rem 1rem;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .btn-primary {
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
  }
  .btn-primary:hover { background: ${PALETTE.accentHover}; }
  .btn-secondary {
    background: transparent;
    color: ${PALETTE.fg};
    border-color: ${PALETTE.border};
  }
  .btn-secondary:hover {
    background: ${PALETTE.bgSoft};
    border-color: ${PALETTE.accent};
  }

  .signout-form { margin: 0.8rem 0 0; }

  .account-action {
    color: ${PALETTE.accent};
    text-decoration: none;
    font-weight: 500;
    font-size: 0.95rem;
  }
  .account-action:hover { color: ${PALETTE.accentHover}; text-decoration: underline; }

  a { color: ${PALETTE.accent}; }
  a:hover { color: ${PALETTE.accentHover}; }

  @media (max-width: 480px) {
    main { padding: 1rem 0.75rem; }
    .card { padding: 1.5rem 1.25rem; border-radius: 10px; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.05rem; }
  }

  @media (prefers-color-scheme: dark) {
    body { background: #1a1815; color: #e8e4dc; }
    .card { background: #25221d; border-color: #3a362f; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3); }
    h1, h2 { color: #f0ece4; }
    .subtitle, .kv dt, .mcp-field-label, .mcp-connect-hint { color: #a8a29a; }
    .vault-name strong, .mcp-connect-label { color: #f0ece4; }
    code { background: #1f1c18; color: #e8e4dc; }
    .copy-row code { background: transparent; }
    .section, .mcp-connect { border-top-color: #3a362f; }
    .brand-tag { border-color: #3a362f; color: #a8a29a; }
    .copy-row { background: #1f1c18; border-color: #3a362f; }
    .btn-secondary, .btn-copy { color: #e8e4dc; border-color: #3a362f; }
    .btn-secondary:hover, .btn-copy:hover { background: #1f1c18; border-color: ${PALETTE.accent}; }
  }
`;
