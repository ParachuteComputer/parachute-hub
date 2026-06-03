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
import type { VaultVerb } from "./users.ts";

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
  /**
   * Whether the signed-in user has TOTP 2FA enrolled (hub#473). Drives the
   * Account card's 2FA status line + enroll/manage link. The link points at
   * `/account/2fa` either way — "Set up" when off, "Manage" when on.
   */
  twoFactorEnabled: boolean;
  /**
   * Per-vault mintable verbs for the "mint an access token" affordance on
   * each vault tile (friend headless-client path). Maps `vaultName` → the
   * verbs the user's assignment role permits (today always
   * `["read", "write"]` since every `user_vaults.role` is `'write'`). A
   * vault absent from this map (or mapped to an empty list) renders no mint
   * affordance — the UI never offers a verb the server would reject. The
   * `/account/` GET handler builds this from `vaultVerbsForUserVault` for
   * each assigned vault. Omitted (or empty) for the admin / no-vault
   * branches, where no token-mint tile is shown.
   */
  mintableVerbs?: Record<string, VaultVerb[]>;
  /**
   * Set after a successful `POST /account/vault-token/<name>` to show the
   * freshly-minted token ONCE (the only time it's ever shown — the hub keeps
   * no plaintext copy). Drives the show-once banner at the top of the page.
   * Absent on the normal GET render.
   */
  mintedToken?: MintedTokenView;
  /**
   * Set after a `POST /account/vault-token/<name>` that failed authorization
   * or validation, to surface an inline error banner on the re-rendered page
   * (e.g. unassigned vault, capped verb, rate-limited). Absent on success and
   * on the normal GET render.
   */
  mintError?: string;
}

/**
 * The one-time view of a freshly-minted friend vault token. The hub stores
 * only a hash-keyed registry row (no plaintext), so this is the single moment
 * the token string is shown — the UI copy makes that explicit.
 */
export interface MintedTokenView {
  vaultName: string;
  verb: VaultVerb;
  token: string;
  /** Whole-day TTL for the "expires in N days" copy. */
  expiresInDays: number;
}

/** Friend-mint token default lifetime: 90 days (matches the CLI/api-mint default). */
export const ACCOUNT_VAULT_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

export function renderAccountHome(opts: RenderAccountHomeOpts): string {
  const { username, assignedVaults, hubOrigin, isFirstAdmin, csrfToken } = opts;
  const safeUsername = escapeHtml(username);
  // Origin is already canonicalized by the handler (trailing slash stripped),
  // but defensively re-trim so a stray slash here doesn't break the CTA href.
  const trimmedOrigin = hubOrigin.replace(/\/+$/, "");

  const mintedBanner = opts.mintedToken ? renderMintedTokenBanner(opts.mintedToken) : "";
  const mintErrorBanner = opts.mintError
    ? `<div class="mint-error-banner" data-testid="mint-error-banner" role="alert">${escapeHtml(
        opts.mintError,
      )}</div>`
    : "";

  // Suppress the "Get started with your AI" card on the no-vault branch:
  // that branch tells the user "You don't have a vault yet" + "ask the operator
  // to assign you one," so a do-the-thing card alongside reads as contradictory
  // (do-this vs you-lack-the-prerequisite). The admin (isFirstAdmin) and
  // assigned-vault branches both have a vault to act against, so the card
  // belongs there.
  const hasNoVault = !isFirstAdmin && assignedVaults.length === 0;
  const startedCard = hasNoVault ? "" : renderGetStartedCard();

  const vaultCard = renderVaultCard({
    assignedVaults,
    trimmedOrigin,
    isFirstAdmin,
    csrfToken,
    mintableVerbs: opts.mintableVerbs ?? {},
  });

  const accountCard = renderAccountCard({
    username: safeUsername,
    csrfToken,
    twoFactorEnabled: opts.twoFactorEnabled,
  });

  const body = `
    <div class="card">
      <div class="card-header">
        ${header()}
        <h1>Welcome, ${safeUsername}</h1>
        <p class="subtitle">Your Parachute account home.</p>
      </div>
      ${mintedBanner}
      ${mintErrorBanner}
      ${startedCard}
      ${vaultCard}
      ${accountCard}
    </div>${COPY_SCRIPT}`;
  return baseDocument(`${username} — Parachute`, body);
}

/**
 * The "Get started with your AI" card — the real first stop for a friend
 * landing on `/account/`. Mirrors the operator setup-wizard's
 * `renderStarterPromptsSection` (same two parachute.computer/onboarding/*
 * links + copy) so friends and operators get the same on-ramp. The prompts
 * live on parachute.computer rather than embedded here so they iterate
 * without a hub release; this card just links.
 *
 * Placed near the top of the page (after any banners, before the vault card)
 * because "what do I actually do with this?" is the friend's first question —
 * the connect details below answer "how", this answers "what next".
 */
function renderGetStartedCard(): string {
  return `
    <section class="section get-started" data-testid="get-started-card">
      <h2>Get started with your AI</h2>
      <p>Two ready-made prompts to paste into Claude (or another AI assistant)
        once your vault is connected — they walk you through it, no setup
        knowledge needed.</p>
      <div class="starter-grid">
        <a class="starter-tile" href="https://parachute.computer/onboarding/vault-setup/"
           target="_blank" rel="noopener" data-testid="starter-vault-setup">
          <h3>Set up your vault</h3>
          <p>Your AI interviews you about where your notes live now and suggests
            a structure that fits how you think.</p>
          <span class="starter-cta">Open prompt ↗</span>
        </a>
        <a class="starter-tile" href="https://parachute.computer/onboarding/surface-build/"
           target="_blank" rel="noopener" data-testid="starter-surface-build">
          <h3>Build a custom UI</h3>
          <p>Your AI builds you a little web app for your vault — your own way to
            see and add to it.</p>
          <span class="starter-cta">Open prompt ↗</span>
        </a>
      </div>
    </section>`;
}

interface VaultCardOpts {
  assignedVaults: string[];
  trimmedOrigin: string;
  isFirstAdmin: boolean;
  csrfToken: string;
  mintableVerbs: Record<string, VaultVerb[]>;
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
  const { assignedVaults, trimmedOrigin, isFirstAdmin, csrfToken, mintableVerbs } = opts;

  if (assignedVaults.length > 0) {
    // One vault tile per assignment (multi-user Phase 2 PR 2). Each tile
    // leads with a friendly "connect your AI assistant to this vault" block
    // that covers BOTH connect paths a non-technical friend is likely to
    // use — Claude Code (the `claude mcp add` CLI command) and Claude.ai on
    // the web (Settings → Connectors → Add custom connector, pointed at the
    // endpoint). Both are the OAuth path — no token to paste, the first
    // connection opens a browser to sign in + approve. The Notes "Open" CTA
    // sits alongside as the browser-UI option. Phrasing mirrors
    // parachute.computer/install.njk's #connect-mcp-clients section so the
    // operator docs and the friend's account page stay consistent.
    //
    // This closes the multi-user gap where the friend tile read as MCP
    // jargon ("Connect an MCP client") rather than "here's how to connect
    // this to your AI" — and where the web (Claude.ai) path was entirely
    // missing, only the Claude Code CLI command was offered.
    const heading = assignedVaults.length === 1 ? "<h2>Your vault</h2>" : "<h2>Your vaults</h2>";
    const tiles = assignedVaults
      .map((vaultName) => {
        const safeVault = escapeHtml(vaultName);
        const vaultUrlForAdd = encodeURIComponent(`${trimmedOrigin}/vault/${vaultName}`);
        const endpoint = accountMcpEndpoint(trimmedOrigin, vaultName);
        const addCmd = accountClaudeMcpAddCommand(trimmedOrigin, vaultName);
        const safeEndpoint = escapeHtml(endpoint);
        const safeAddCmd = escapeHtml(addCmd);
        const tokenMintBlock = renderTokenMintBlock(
          vaultName,
          safeVault,
          mintableVerbs[vaultName] ?? [],
          csrfToken,
        );
        return `
        <div class="vault-tile" data-testid="vault-tile" data-vault-name="${safeVault}">
          <p class="vault-name"><strong>${safeVault}</strong></p>
          <div class="mcp-connect" data-testid="mcp-connect">
            <p class="mcp-connect-label" data-testid="connect-ai-heading">Connect your AI
               assistant to this vault</p>
            <p class="mcp-connect-intro">Two common ways. Both sign you in to this hub over
               HTTPS and ask you to approve access the first time — no token to copy.</p>

            <div class="mcp-method" data-testid="connect-method-claude-code">
              <p class="mcp-method-title">Claude Code (terminal)</p>
              <p class="mcp-method-sub">Run this in your terminal:</p>
              <div class="copy-row">
                <code data-testid="mcp-add-command">${safeAddCmd}</code>
                <button type="button" class="btn btn-copy" data-copy="${safeAddCmd}"
                        data-testid="copy-mcp-add-command">Copy</button>
              </div>
            </div>

            <div class="mcp-method" data-testid="connect-method-claude-ai">
              <p class="mcp-method-title">Claude.ai (web)</p>
              <p class="mcp-method-sub">In Claude.ai, open <strong>Settings → Connectors</strong>,
                 choose <strong>Add custom connector</strong>, and paste this endpoint:</p>
              <div class="copy-row">
                <code data-testid="mcp-endpoint">${safeEndpoint}</code>
                <button type="button" class="btn btn-copy" data-copy="${safeEndpoint}"
                        data-testid="copy-mcp-endpoint">Copy</button>
              </div>
              <p class="mcp-method-note">Claude.ai then redirects you here to sign in and
                 approve. (Your hub must be reachable from the web for this.)</p>
            </div>

            <p class="mcp-connect-hint" data-testid="connect-any-client-hint">Using something
               else? Point any MCP client at the same endpoint above. (ChatGPT and some other
               web UIs call these "connectors.")</p>
          </div>
          <p class="vault-notes-cta">
            <a class="btn btn-primary" href="https://notes.parachute.computer/add?url=${vaultUrlForAdd}"
               target="_blank" rel="noopener" data-testid="open-notes-cta">Open Notes ↗</a>
            <a class="btn btn-secondary" href="https://notes.parachute.computer/import?url=${vaultUrlForAdd}"
               target="_blank" rel="noopener" data-testid="import-notes-cta">Import notes ↗</a>
            <span class="vault-notes-cta-sub">Prefer a browser UI? Open Notes to browse +
               capture in this vault — or jump straight to bulk-importing Markdown/Obsidian
               notes into it.</span>
          </p>
          ${tokenMintBlock}
        </div>`;
      })
      .join("");
    return `
      <section class="section" data-testid="vault-card">
        ${heading}
        <p>Connect Claude (or any AI assistant) to your vault${
          assignedVaults.length === 1 ? "" : "s"
        } — pick Claude Code or
          Claude.ai below — or open Notes for a browser UI. The first connection signs you in
          to your hub over HTTPS and asks you to approve access.</p>
        <div class="vault-tiles">${tiles}
        </div>
      </section>`;
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
      <p>You don't have a vault yet, so there's nothing to connect to. A vault
         is your personal knowledge store on this hub — once the operator
         assigns you one, this page will show you how to connect Claude (or
         any AI assistant) to it.</p>
      <p><strong>Ask the hub operator to assign you a vault.</strong></p>
    </section>`;
}

/**
 * The "mint an access token (for scripts / headless clients)" affordance on a
 * vault tile. Sits BELOW the OAuth connect block + Notes CTA — the no-token
 * OAuth path stays the recommended default; this is the secondary, opt-in
 * path for clients that can't do an interactive browser sign-in (cron jobs,
 * headless agents, a `curl` script).
 *
 * Renders one radio per verb the user's assignment role permits (`verbs` —
 * today always `["read", "write"]`). The UI NEVER offers a verb the server
 * would reject: a read-only assignment shows only "Read". An empty `verbs`
 * list (unknown / unmappable role) renders nothing — fail-closed, matching
 * the server's `vaultVerbsForUserVault` returning `[]`.
 *
 * The form POSTs `application/x-www-form-urlencoded` to
 * `/account/vault-token/<name>` with the CSRF hidden field + a `verb` radio —
 * same no-JS-required posture as the change-password and sign-out forms. The
 * `<details>` keeps it collapsed by default so the tile leads with the
 * recommended OAuth path.
 */
function renderTokenMintBlock(
  vaultName: string,
  safeVault: string,
  verbs: VaultVerb[],
  csrfToken: string,
): string {
  if (verbs.length === 0) return "";
  // Path segment is URL-encoded; the action attribute is HTML-escaped on top.
  const action = escapeHtml(`/account/vault-token/${encodeURIComponent(vaultName)}`);
  const radios = verbs
    .map((verb, i) => {
      const checked = i === 0 ? " checked" : "";
      const label =
        verb === "read"
          ? "Read-only"
          : verb === "admin"
            ? "Full (read, write, rotate tokens + config)"
            : "Read + write";
      return `
              <label class="mint-verb-option">
                <input type="radio" name="verb" value="${verb}"${checked}
                       data-testid="mint-verb-${verb}" />
                <span><strong>${verb}</strong> — ${label} access to <code>${safeVault}</code></span>
              </label>`;
    })
    .join("");
  return `
          <details class="token-mint" data-testid="token-mint">
            <summary data-testid="token-mint-summary">Mint an access token
              <span class="token-mint-sub">for scripts / headless clients</span></summary>
            <div class="token-mint-body">
              <p class="token-mint-intro">Most clients should use the no-token
                connect options above — they sign you in over HTTPS and never
                ask you to paste a secret. Mint a token only for a script or
                headless client that can't open a browser to sign in. It's a
                bearer for <code>vault:${safeVault}:&lt;verb&gt;</code>, scoped to
                <strong>this vault only</strong>, and you'll see it once.</p>
              <form method="POST" action="${action}" class="mint-form"
                    data-testid="mint-form">
                ${renderCsrfHiddenInput(csrfToken)}
                <fieldset class="mint-verbs">
                  <legend>Access level</legend>${radios}
                </fieldset>
                <button type="submit" class="btn btn-secondary"
                        data-testid="mint-token-button">Mint token</button>
              </form>
            </div>
          </details>`;
}

/**
 * The show-once banner for a freshly-minted friend vault token. Rendered at
 * the top of `/account/` after a successful `POST /account/vault-token/<name>`.
 * The token string appears here and NOWHERE else — the hub stores only a
 * hash-keyed registry row. The copy is explicit about that ("save it now —
 * it won't be shown again"). No revoke link: there's no friend-facing revoke
 * surface today, so we don't claim one.
 */
function renderMintedTokenBanner(view: MintedTokenView): string {
  const safeVault = escapeHtml(view.vaultName);
  const scope = `vault:${view.vaultName}:${view.verb}`;
  const safeScope = escapeHtml(scope);
  // The token value goes in a data attribute for the copy button + as text.
  // It's a hub-signed JWT (no HTML-significant chars in base64url + dots), but
  // escape defensively all the same.
  const safeToken = escapeHtml(view.token);
  return `
    <div class="minted-banner" data-testid="minted-token-banner" role="status">
      <p class="minted-title">Your access token for <code>${safeVault}</code></p>
      <p class="minted-warn"><strong>Save it now — it won't be shown again.</strong>
        This is a bearer credential for <code>${safeScope}</code>. It expires in
        ${view.expiresInDays} days. Treat it like a password; anyone who has it
        can act on this vault at that access level.</p>
      <div class="copy-row">
        <code data-testid="minted-token-value">${safeToken}</code>
        <button type="button" class="btn btn-copy" data-copy="${safeToken}"
                data-testid="copy-minted-token">Copy</button>
      </div>
      <p class="minted-hint">Use it as <code>Authorization: Bearer &lt;token&gt;</code>
        when calling this vault's MCP endpoint. To revoke it, ask the hub operator.</p>
    </div>`;
}

interface AccountCardOpts {
  username: string;
  csrfToken: string;
  twoFactorEnabled: boolean;
}

function renderAccountCard(opts: AccountCardOpts): string {
  const { username, csrfToken, twoFactorEnabled } = opts;
  const twoFactorStatus = twoFactorEnabled
    ? `<dd><span class="badge badge-on" data-testid="2fa-status">On</span></dd>`
    : `<dd><span class="badge badge-off" data-testid="2fa-status">Off</span></dd>`;
  const twoFactorLink = twoFactorEnabled
    ? `<a class="account-action" href="/account/2fa" data-testid="manage-2fa-link">Manage two-factor →</a>`
    : `<a class="account-action" href="/account/2fa" data-testid="setup-2fa-link">Set up two-factor →</a>`;
  return `
    <section class="section" data-testid="account-card">
      <h2>Account</h2>
      <dl class="kv">
        <dt>Username</dt>
        <dd><code>${username}</code></dd>
      </dl>
      <form method="POST" action="/logout" class="signout-form" data-testid="signout-form">
        ${renderCsrfHiddenInput(csrfToken)}
        <button type="submit" class="btn btn-secondary">Sign out</button>
      </form>
      <details class="account-security" data-testid="account-security">
        <summary>Security &amp; password</summary>
        <dl class="kv">
          <dt>Two-factor authentication</dt>
          ${twoFactorStatus}
        </dl>
        <p>
          <a class="account-action" href="/account/change-password" data-testid="change-password-link">Change password →</a>
        </p>
        <p>
          ${twoFactorLink}
        </p>
      </details>
    </section>`;
}

// --- copy-button script ---------------------------------------------------
//
// Tiny inline progressive-enhancement script for the page's copy buttons
// (the per-tile MCP command/endpoint buttons AND the show-once minted-token
// banner's Copy button). Delegated click handler reads the value from the
// button's `data-copy` attribute and writes it to the clipboard, flashing
// "Copied ✓" for 2s. No-ops gracefully when the Clipboard API is unavailable
// (insecure context, older browser) — the value stays selectable in the
// codebox. Mirrors the SPA `CopyButton` posture (McpConnectCard.tsx) for a
// surface that has no React. Emitted once at the page body level so it covers
// both the vault tiles and the minted-token banner (which lives above the
// vault card).
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

  .get-started h3 {
    font-family: ${FONT_SERIF};
    font-weight: 400;
    font-size: 1rem;
    margin: 0 0 0.3rem;
    color: ${PALETTE.fg};
  }
  .starter-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin: 0.75rem 0 0.2rem;
  }
  .starter-tile {
    display: block;
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 8px;
    padding: 0.8rem 0.9rem;
    background: ${PALETTE.bgSoft};
    text-decoration: none;
    color: inherit;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .starter-tile:hover { border-color: ${PALETTE.accent}; background: ${PALETTE.accentSoft}; }
  .starter-tile p {
    font-size: 0.84rem;
    color: ${PALETTE.fgMuted};
    margin: 0 0 0.5rem;
  }
  .starter-cta {
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.accent};
  }
  @media (max-width: 480px) {
    .starter-grid { grid-template-columns: 1fr; }
  }

  .account-security {
    margin: 0.9rem 0 0;
    padding-top: 0.6rem;
    border-top: 1px solid ${PALETTE.borderLight};
  }
  .account-security > summary {
    cursor: pointer;
    font-size: 0.88rem;
    font-weight: 600;
    color: ${PALETTE.fgMuted};
    list-style: revert;
  }
  .account-security > summary:hover { color: ${PALETTE.fg}; }
  .account-security .kv { margin-top: 0.6rem; }

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
    margin-bottom: 0.75rem;
  }
  .mcp-connect-label {
    font-family: ${FONT_SERIF};
    font-size: 1.05rem;
    font-weight: 400;
    color: ${PALETTE.fg};
    margin: 0 0 0.3rem;
  }
  .mcp-connect-intro {
    font-size: 0.85rem;
    color: ${PALETTE.fgMuted};
    margin: 0 0 0.75rem;
  }
  .mcp-method {
    margin: 0.75rem 0;
    padding-top: 0.6rem;
    border-top: 1px solid ${PALETTE.borderLight};
  }
  .mcp-method-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: ${PALETTE.fg};
    margin: 0 0 0.15rem;
  }
  .mcp-method-sub {
    font-size: 0.82rem;
    color: ${PALETTE.fgMuted};
    margin: 0 0 0.4rem;
  }
  .mcp-method-note {
    font-size: 0.78rem;
    color: ${PALETTE.fgMuted};
    margin: 0.35rem 0 0;
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
  .vault-notes-cta {
    margin: 0.9rem 0 0;
    padding-top: 0.6rem;
    border-top: 1px solid ${PALETTE.borderLight};
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
  }
  .vault-notes-cta-sub {
    font-size: 0.82rem;
    color: ${PALETTE.fgMuted};
    flex: 1 1 12rem;
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

  .token-mint {
    margin: 0.9rem 0 0;
    padding-top: 0.6rem;
    border-top: 1px solid ${PALETTE.borderLight};
  }
  .token-mint > summary {
    cursor: pointer;
    font-size: 0.88rem;
    font-weight: 600;
    color: ${PALETTE.fg};
    list-style: revert;
  }
  .token-mint-sub {
    font-weight: 400;
    font-size: 0.8rem;
    color: ${PALETTE.fgMuted};
  }
  .token-mint-body { margin-top: 0.6rem; }
  .token-mint-intro {
    font-size: 0.8rem;
    color: ${PALETTE.fgMuted};
    margin: 0 0 0.6rem;
  }
  .mint-verbs {
    border: 1px solid ${PALETTE.borderLight};
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
    margin: 0 0 0.6rem;
  }
  .mint-verbs legend {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${PALETTE.fgMuted};
    font-family: ${FONT_MONO};
    padding: 0 0.3rem;
  }
  .mint-verb-option {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
    margin: 0.3rem 0;
  }
  .mint-verb-option input { margin: 0; }
  .mint-form .btn { margin-top: 0.2rem; }

  .minted-banner {
    border: 1px solid ${PALETTE.accent};
    background: ${PALETTE.accentSoft};
    border-radius: 8px;
    padding: 0.9rem 1rem;
    margin: 1.25rem 0 0;
  }
  .minted-title {
    font-family: ${FONT_SERIF};
    font-size: 1.05rem;
    margin: 0 0 0.3rem;
    color: ${PALETTE.fg};
  }
  .minted-warn { font-size: 0.85rem; margin: 0 0 0.6rem; color: ${PALETTE.fg}; }
  .minted-banner .copy-row { margin: 0.4rem 0; }
  .minted-banner .copy-row code { font-size: 0.72rem; }
  .minted-hint { font-size: 0.8rem; color: ${PALETTE.fgMuted}; margin: 0.4rem 0 0; }

  .mint-error-banner {
    border: 1px solid ${PALETTE.danger};
    background: ${PALETTE.dangerSoft};
    color: ${PALETTE.danger};
    border-radius: 8px;
    padding: 0.7rem 1rem;
    margin: 1.25rem 0 0;
    font-size: 0.88rem;
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

  .badge {
    display: inline-block;
    font-size: 0.78rem;
    font-weight: 500;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    border: 1px solid transparent;
  }
  .badge-on { background: ${PALETTE.successSoft}; color: ${PALETTE.success}; border-color: ${PALETTE.success}; }
  .badge-off { background: ${PALETTE.bgSoft}; color: ${PALETTE.fgMuted}; border-color: ${PALETTE.border}; }

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
    .subtitle, .kv dt, .mcp-field-label, .mcp-connect-hint,
    .mcp-connect-intro, .mcp-method-sub, .mcp-method-note,
    .vault-notes-cta-sub { color: #a8a29a; }
    .vault-name strong, .mcp-connect-label, .mcp-method-title { color: #f0ece4; }
    code { background: #1f1c18; color: #e8e4dc; }
    .copy-row code { background: transparent; }
    .section { border-top-color: #3a362f; }
    .mcp-method, .vault-notes-cta, .token-mint,
    .account-security { border-top-color: #3a362f; }
    .get-started h3 { color: #f0ece4; }
    .starter-tile { border-color: #3a362f; background: #1f1c18; }
    .starter-tile:hover { border-color: ${PALETTE.accent}; }
    .starter-tile p { color: #a8a29a; }
    .account-security > summary { color: #a8a29a; }
    .account-security > summary:hover { color: #f0ece4; }
    .brand-tag { border-color: #3a362f; color: #a8a29a; }
    .copy-row { background: #1f1c18; border-color: #3a362f; }
    .btn-secondary, .btn-copy { color: #e8e4dc; border-color: #3a362f; }
    .btn-secondary:hover, .btn-copy:hover { background: #1f1c18; border-color: ${PALETTE.accent}; }
    .token-mint > summary { color: #f0ece4; }
    .token-mint-sub, .token-mint-intro, .mint-verbs legend, .minted-hint { color: #a8a29a; }
    .mint-verbs { border-color: #3a362f; }
    .minted-title, .minted-warn { color: #f0ece4; }
  }
`;
