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
   * Per-vault verbs the user's assignment role permits. Maps `vaultName` → the
   * verbs (today `["read", "write", "admin"]` since every `user_vaults.role` is
   * `'write'`, which grants admin). Now used solely to GATE the per-tile
   * "Advanced vault settings ↗" deep-link (and the "Back up to GitHub ↗" action)
   * on the `admin` verb — the deep-link mints a `vault:<name>:admin` token, so
   * the button never offers authority the POST handler would 403. (The old
   * token-mint affordance this map also drove was dropped from `/account/`
   * 2026-06-04 — OAuth-first; minting header-auth tokens is an advanced concern
   * that lives in the vault config SPA.) Omitted (or empty) for the admin /
   * no-vault branches, where no vault tile is shown.
   */
  mintableVerbs?: Record<string, VaultVerb[]>;
  /**
   * Per-vault usage stat (`"X notes · Y MB"`) for each assigned vault tile.
   * Maps `vaultName` → the pre-formatted stat string. A vault absent from this
   * map renders no stat — the page tolerates a vault whose usage endpoint
   * failed / is unreachable / predates the feature (the `/account/` GET handler
   * builds this map by fetching `/.parachute/usage` per vault and omitting any
   * that don't resolve). Omitted entirely on the admin / no-vault branches.
   */
  usageStats?: Record<string, string>;
  /**
   * Per-vault backup (mirror) line for each assigned vault tile. Maps
   * `vaultName` → the warm, pre-formatted line ("Backed up — full version
   * history", or "… + GitHub" when a push remote is configured). A vault absent
   * from this map renders no backup line — the page tolerates a vault whose
   * mirror endpoint failed / is unreachable / is backup-off (the `/account/` GET
   * handler builds this map by fetching `/.parachute/mirror` per admin-held
   * vault and omitting any that don't resolve or read backup-off). Omitted
   * entirely on the admin / no-vault branches.
   */
  mirrorLines?: Record<string, string>;
  /**
   * Per-vault "is backup already pushing to a remote?" flag (the vault's
   * `config.auto_push`, threaded from `VaultMirrorStat.backedUpToRemote`). Maps
   * `vaultName` → `true` when an auto-push remote is configured. Drives whether
   * the tile suppresses the "Back up to GitHub ↗" action — gated on this proper
   * boolean, NOT re-derived from the `mirrorLines` display string. A vault absent
   * defaults to `false` (offer the action). Built alongside `mirrorLines` by the
   * GET handler; omitted on the admin / no-vault branches.
   */
  mirrorPushing?: Record<string, boolean>;
  /**
   * Set after a successful `POST /account/vault-token/<name>` to show the
   * freshly-minted token ONCE (the only time it's ever shown — the hub keeps
   * no plaintext copy). Drives the show-once banner at the top of the page.
   * Absent on the normal GET render.
   *
   * NOT vestigial after the 2026-06-04 token-mint-UI removal: the page no
   * longer renders the mint *form*, but the `POST /account/vault-token/<name>`
   * route still exists (a script/advanced path) and on success re-renders THIS
   * page with `mintedToken` set, so the show-once banner still fires for that
   * flow. The renderer keeps the prop + banner for it.
   */
  mintedToken?: MintedTokenView;
  /**
   * Set after a `POST /account/vault-token/<name>` that failed authorization
   * or validation, to surface an inline error banner on the re-rendered page
   * (e.g. unassigned vault, capped verb, rate-limited). Absent on success and
   * on the normal GET render. Same non-vestigial note as `mintedToken`: the
   * mint route still re-renders this page, so the error banner stays live.
   */
  mintError?: string;
  /**
   * Whether this user has already connected an AI to (any of) their assigned
   * vault(s) — true when a `grants` row touches one of their vaults (see
   * `userHasVaultGrant`). Drives the first-run onboarding checklist: when
   * `false`, the checklist leads with the hero "Connect your AI" step (inline
   * endpoint + both methods); when `true`, the checklist condenses to a quiet
   * "you're connected" line so it stops nagging returning users. The full vault
   * card below remains the working surface either way. Omitted (defaults to
   * `false`) on the admin / no-vault branches, where no checklist is shown.
   */
  connectedVault?: boolean;
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

  // First-run onboarding checklist — the lead surface for a friend with at
  // least one assigned vault. Walks them through the obvious path: account
  // ready → connect your AI (the hero step, inline endpoint + both methods) →
  // set up your vault. Once connected (a grant touches one of their vaults) it
  // condenses to a quiet "you're connected" line so it stops nagging. Shown
  // only on the assigned-vault branch — the admin + no-vault branches have no
  // single "your vault" to connect, so the checklist would be misleading there.
  // TODO(multi-vault): `connectedVault` is true if ANY of the user's vaults has
  // a grant (handler uses `.some(...)`), but the checklist shows the connect step
  // for the FIRST vault only. With multiple vaults, connecting vault B condenses
  // the checklist even though the displayed primary vault A isn't connected. Fine
  // today — single-vault is the live case; revisit if multi-vault ships.
  const checklist =
    assignedVaults.length > 0
      ? renderOnboardingChecklist({
          primaryVault: assignedVaults[0] as string,
          trimmedOrigin,
          connected: opts.connectedVault ?? false,
        })
      : "";

  const vaultCard = renderVaultCard({
    assignedVaults,
    trimmedOrigin,
    isFirstAdmin,
    csrfToken,
    mintableVerbs: opts.mintableVerbs ?? {},
    usageStats: opts.usageStats ?? {},
    mirrorLines: opts.mirrorLines ?? {},
    mirrorPushing: opts.mirrorPushing ?? {},
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
      ${checklist}
      ${vaultCard}
      ${startedCard}
      ${accountCard}
    </div>${COPY_SCRIPT}`;
  return baseDocument(`${username} — Parachute`, body);
}

interface OnboardingChecklistOpts {
  /**
   * The vault the checklist's "Connect your AI" step shows the endpoint for.
   * For the common single-vault case this is their only vault; for the rare
   * multi-vault case it's the first/primary one (the per-vault tiles below
   * still list every vault). Already validated/escaped at render time.
   */
  primaryVault: string;
  trimmedOrigin: string;
  /** Whether they've already connected an AI (a grant touches a vault). */
  connected: boolean;
}

/**
 * The first-run "Get set up" checklist — the lead surface on `/account/` for a
 * friend with an assigned vault. Three numbered steps give a non-technical
 * person an obvious path:
 *
 *   ① Your account is ready  — always done (they're signed in, password set).
 *   ② Connect your AI        — the hero. Inline endpoint (`/vault/<name>/mcp`)
 *                              with a copy button + the two short connect
 *                              methods (Claude.ai connector, Claude Code
 *                              `claude mcp add`). Marked done when `connected`.
 *   ③ Set up your vault      — links the vault-setup starter prompt.
 *
 * When `connected` is true the whole thing condenses to a quiet "✓ You're
 * connected" line so it doesn't nag returning users — the full vault card below
 * stays the working surface either way.
 *
 * Server-rendered, no-JS-required: the copy button is progressive enhancement
 * (the endpoint stays selectable text without it), matching the rest of the page.
 */
function renderOnboardingChecklist(opts: OnboardingChecklistOpts): string {
  const { primaryVault, trimmedOrigin, connected } = opts;
  const safeVault = escapeHtml(primaryVault);
  const endpoint = accountMcpEndpoint(trimmedOrigin, primaryVault);
  const addCmd = accountClaudeMcpAddCommand(trimmedOrigin, primaryVault);
  const safeEndpoint = escapeHtml(endpoint);
  const safeAddCmd = escapeHtml(addCmd);

  // The endpoint + both connect methods. Shared between the full checklist
  // (step 2) and the condensed "Connect another AI" expander (hub#583) so a
  // genuinely-connected user can still wire up a SECOND client without losing
  // the instructions.
  const connectMethods = `
            <div class="copy-row">
              <code data-testid="onboarding-mcp-endpoint">${safeEndpoint}</code>
              <button type="button" class="btn btn-copy" data-copy="${safeEndpoint}"
                      data-testid="copy-onboarding-endpoint">Copy</button>
            </div>
            <p class="onboarding-method"><strong>Claude.ai (web):</strong> open
               Settings → Connectors → Add custom connector, and paste the address above.</p>
            <p class="onboarding-method"><strong>Claude Code (terminal):</strong> run this command:</p>
            <div class="copy-row">
              <code data-testid="onboarding-mcp-add-command">${safeAddCmd}</code>
              <button type="button" class="btn btn-copy" data-copy="${safeAddCmd}"
                      data-testid="copy-onboarding-add-command">Copy</button>
            </div>`;

  // Condensed state — they've connected, so the checklist shrinks to a quiet
  // reassuring line. But keep a "Connect another AI" expander (hub#583): the
  // condensed line used to DELETE the endpoint + methods outright, leaving a
  // connected user no way to wire up a second client. A <details> expander
  // (server-rendered, no-JS-required — the copy buttons stay progressive
  // enhancement) re-reveals the full inline instructions on demand.
  if (connected) {
    return `
    <section class="section onboarding onboarding-done" data-testid="onboarding-checklist"
             data-connected="true">
      <p class="onboarding-done-line" data-testid="onboarding-done-line">
        <span class="onboarding-check" aria-hidden="true">✓</span>
        You're connected — here's your vault.</p>
      <details class="onboarding-connect-another" data-testid="onboarding-connect-another">
        <summary data-testid="onboarding-connect-another-summary">Connect another AI →</summary>
        <div class="onboarding-step-body">
          <p class="onboarding-step-sub">Point another AI client at your vault using this
             address — you'll sign in and approve the first time:</p>
          ${connectMethods}
        </div>
      </details>
    </section>`;
  }

  return `
    <section class="section onboarding" data-testid="onboarding-checklist"
             data-connected="false">
      <h2>Get set up</h2>
      <p class="onboarding-intro">Three quick steps to start using your vault with your AI.</p>
      <ol class="onboarding-steps">
        <li class="onboarding-step onboarding-step-done" data-testid="onboarding-step-1">
          <span class="onboarding-num onboarding-num-done" aria-hidden="true">✓</span>
          <div class="onboarding-step-body">
            <p class="onboarding-step-title">Your account is ready</p>
            <p class="onboarding-step-sub">You're signed in and your password is set. Nothing to
               do here.</p>
          </div>
        </li>

        <li class="onboarding-step onboarding-step-hero" data-testid="onboarding-step-2">
          <span class="onboarding-num" aria-hidden="true">2</span>
          <div class="onboarding-step-body">
            <p class="onboarding-step-title">Connect your AI</p>
            <p class="onboarding-step-sub">Point Claude (or another AI) at your vault using this
               address — no token to copy, you'll sign in and approve the first time:</p>
            ${connectMethods}
          </div>
        </li>

        <li class="onboarding-step" data-testid="onboarding-step-3">
          <span class="onboarding-num" aria-hidden="true">3</span>
          <div class="onboarding-step-body">
            <p class="onboarding-step-title">Set up your vault</p>
            <p class="onboarding-step-sub">Open a new Claude chat and paste the
               <a href="https://parachute.computer/onboarding/vault-setup/" target="_blank"
                  rel="noopener" data-testid="onboarding-vault-setup-link">vault-setup prompt</a> —
               your AI interviews you and structures your vault around how you think.</p>
          </div>
        </li>
      </ol>
      <p class="onboarding-foot" data-testid="onboarding-foot">Your vault is
         <code>${safeVault}</code>. Its size, backup state, Notes, and advanced settings are
         just below.</p>
    </section>`;
}

/**
 * The "Get started with your AI" card — the real first stop for a friend
 * landing on `/account/`. Mirrors the operator setup-wizard's
 * `renderStarterPromptsSection` (same two parachute.computer/onboarding/*
 * links + copy) so friends and operators get the same on-ramp. The prompts
 * live on parachute.computer rather than embedded here so they iterate
 * without a hub release; this card just links.
 *
 * Placed AFTER the connect/vault card (connect-before-prompts): the prompts are
 * only useful once the vault is connected, so the page leads with the connect
 * checklist + vault details, and these "what next" prompts sit below them.
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
  /** `vaultName` → pre-formatted usage stat ("X notes · Y MB"). */
  usageStats: Record<string, string>;
  /** `vaultName` → pre-formatted backup line ("Backed up — full version history"). */
  mirrorLines: Record<string, string>;
  /** `vaultName` → is backup already pushing to a remote (gates the GitHub action). */
  mirrorPushing: Record<string, boolean>;
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
  const { assignedVaults, trimmedOrigin, isFirstAdmin, csrfToken, mintableVerbs, usageStats } =
    opts;
  const { mirrorLines, mirrorPushing } = opts;

  if (assignedVaults.length > 0) {
    // One vault tile per assignment (multi-user Phase 2 PR 2). The tile is the
    // everyday "here's your vault" detail card — name, size, backup state, a
    // browser-UI on-ramp (Notes + "build your own"), and a single deep-link
    // into the advanced vault settings SPA. It deliberately does NOT repeat the
    // "Connect your AI" instructions: the onboarding checklist above owns that
    // step (collapsing to "✓ You're connected" once a grant lands), so the
    // page never shows the connect endpoint + both methods twice. Token minting
    // + raw mirror config are advanced concerns that live in the vault config
    // SPA, reached via "Advanced vault settings ↗" — not duplicated here.
    const heading = assignedVaults.length === 1 ? "<h2>Your vault</h2>" : "<h2>Your vaults</h2>";
    const tiles = assignedVaults
      .map((vaultName) => {
        const safeVault = escapeHtml(vaultName);
        const vaultUrlForAdd = encodeURIComponent(`${trimmedOrigin}/vault/${vaultName}`);
        const verbsForVault = mintableVerbs[vaultName] ?? [];
        const holdsAdmin = verbsForVault.includes("admin");
        // "Advanced vault settings ↗" — only for users whose assignment grants
        // `admin` (the verb the deep-link mints). Today every assigned user
        // holds admin, but gate on the verb so the button never offers
        // authority the POST handler would 403. The single advanced entry point:
        // schema, tokens, retention, raw mirror config all live in the SPA.
        const manageBlock = holdsAdmin ? renderVaultAdminLink(vaultName, csrfToken) : "";
        // Compact usage stat ("X notes · Y MB"), when the vault's usage endpoint
        // resolved. Omitted gracefully otherwise.
        const usageStat = usageStats[vaultName];
        const usageLine = usageStat
          ? `<p class="vault-usage" data-testid="vault-usage">${escapeHtml(usageStat)}</p>`
          : "";
        // Backup state line + a "Back up to GitHub ↗" deep-link when not already
        // pushing. Both gated on admin: the backup line is only fetched for
        // admin-held vaults (the mirror endpoint is admin-scoped), and the
        // GitHub action reuses the same `/account/vault-admin-token/<name>`
        // deep-link that opens the vault config SPA. Omitted silently when the
        // mirror fetch failed / backup is off (the renderer just gets no entry).
        const mirrorLine = mirrorLines[vaultName];
        const backupBlock = renderBackupBlock(
          vaultName,
          mirrorLine,
          mirrorPushing[vaultName] ?? false,
          holdsAdmin,
          csrfToken,
        );
        return `
        <div class="vault-tile" data-testid="vault-tile" data-vault-name="${safeVault}">
          <p class="vault-name"><strong>${safeVault}</strong></p>
          ${usageLine}
          ${backupBlock}
          <p class="vault-notes-cta">
            <a class="btn btn-primary" href="https://notes.parachute.computer/add?url=${vaultUrlForAdd}"
               target="_blank" rel="noopener" data-testid="open-notes-cta">Open Notes ↗</a>
            <a class="btn btn-secondary" href="https://notes.parachute.computer/import?url=${vaultUrlForAdd}"
               target="_blank" rel="noopener" data-testid="import-notes-cta">Import notes ↗</a>
            <span class="vault-notes-cta-sub">Prefer a browser UI? Open Notes to browse +
               capture in this vault — or jump straight to bulk-importing Markdown/Obsidian
               notes into it.</span>
          </p>
          <p class="vault-build-ui" data-testid="build-your-own-ui">Notes is just one way to see
             your vault — when you're ready, your AI can build you a custom UI for it in a few
             minutes. <a href="https://parachute.computer/onboarding/surface-build/"
             target="_blank" rel="noopener" data-testid="build-your-own-ui-link">Build your own ↗</a></p>
          ${manageBlock}
        </div>`;
      })
      .join("");
    return `
      <section class="section" data-testid="vault-card">
        ${heading}
        <p>Your vault${
          assignedVaults.length === 1 ? "" : "s"
        } at a glance — size, backup, and a browser UI. You connect your AI from the
          steps above; the deeper settings live one click away.</p>
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
 * The backup-state block on a vault tile: a warm, plain-language line telling
 * the owner their vault is backed up (local version history, optionally pushed
 * to GitHub), plus a "Back up to GitHub ↗" action when no push remote is set.
 *
 * `mirrorLine` is the pre-formatted backup line ("Backed up — full version
 * history" / "… + GitHub") the GET handler built from the vault's mirror status,
 * or `undefined` when the mirror fetch failed / backup is off / the user doesn't
 * hold admin. When absent, the whole block is omitted silently — the everyday
 * home never nags with a "not backed up" warning.
 *
 * The "Back up to GitHub ↗" action reuses the EXISTING
 * `/account/vault-admin-token/<name>` deep-link (the same POST `renderVaultAdminLink`
 * uses) — it mints a `vault:<name>:admin` token and opens the vault config SPA,
 * where the GitHub push is configured. We do NOT invent a new auth path. It's
 * shown only when the user holds admin AND `pushing` is false (not already
 * pushing to a remote) — `pushing` is a proper boolean threaded from the mirror
 * status (`VaultMirrorStat.backedUpToRemote`), never re-derived from the
 * display string.
 */
function renderBackupBlock(
  vaultName: string,
  mirrorLine: string | undefined,
  pushing: boolean,
  holdsAdmin: boolean,
  csrfToken: string,
): string {
  if (!mirrorLine) return "";
  // "Back up to GitHub ↗" — only when admin (the deep-link mints admin) and not
  // already pushing. Reuses the vault-admin-token deep-link to open the SPA's
  // backup page; no new auth path.
  const action = escapeHtml(`/account/vault-admin-token/${encodeURIComponent(vaultName)}`);
  const githubAction =
    holdsAdmin && !pushing
      ? `
            <form method="POST" action="${action}" class="vault-backup-github"
                  data-testid="backup-github-form">
              ${renderCsrfHiddenInput(csrfToken)}
              <button type="submit" class="btn btn-secondary" data-testid="backup-github-button">
                Back up to GitHub ↗
              </button>
            </form>`
      : "";
  return `
          <div class="vault-backup" data-testid="vault-backup">
            <p class="vault-backup-line" data-testid="backup-state-line">
              <span class="vault-backup-check" aria-hidden="true">✓</span>${escapeHtml(mirrorLine)}</p>${githubAction}
          </div>`;
}

/**
 * The "Advanced vault settings ↗" affordance on a vault tile — the single
 * advanced entry point. A small POST form to `/account/vault-admin-token/<name>`
 * that mints a `vault:<name>:admin` deep-link token and redirects into the
 * vault's own config SPA — where the assigned user can manage schema, rotate
 * access tokens, set retention, and edit raw mirror/backup config. Shown only
 * when the user's assignment grants `admin` (gated by the caller).
 *
 * No-JS posture: a same-origin form POST that 303-redirects on success, same
 * shape as the other `/account/*` forms. CSRF-gated via the hidden field.
 */
function renderVaultAdminLink(vaultName: string, csrfToken: string): string {
  // Path segment is URL-encoded; the action attribute is HTML-escaped on top.
  const action = escapeHtml(`/account/vault-admin-token/${encodeURIComponent(vaultName)}`);
  return `
          <form method="POST" action="${action}" class="vault-admin-link"
                data-testid="vault-admin-form">
            ${renderCsrfHiddenInput(csrfToken)}
            <button type="submit" class="btn btn-secondary" data-testid="vault-admin-button">
              Advanced vault settings ↗
            </button>
            <span class="vault-admin-sub">Open this vault's config — schema, access tokens,
               retention, and raw backup settings.</span>
          </form>`;
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
// .vault-name, .vault-backup, .vault-build-ui, .copy-row) describe the card +
// backup-state + onboarding-checklist shapes this page introduces.

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

  .onboarding-intro { color: ${PALETTE.fgMuted}; font-size: 0.95rem; margin: 0 0 0.4rem; }
  .onboarding-steps {
    list-style: none;
    margin: 0.75rem 0 0.4rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .onboarding-step {
    display: flex;
    align-items: flex-start;
    gap: 0.7rem;
  }
  .onboarding-num {
    flex: 0 0 auto;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
    background: ${PALETTE.accent};
    color: ${PALETTE.cardBg};
    font-size: 0.85rem;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-top: 0.1rem;
  }
  .onboarding-num-done {
    background: ${PALETTE.successSoft};
    color: ${PALETTE.success};
    border: 1px solid ${PALETTE.success};
  }
  .onboarding-step-body { flex: 1 1 auto; min-width: 0; }
  .onboarding-step-title {
    font-weight: 600;
    font-size: 0.95rem;
    color: ${PALETTE.fg};
    margin: 0 0 0.15rem;
  }
  .onboarding-step-sub {
    font-size: 0.85rem;
    color: ${PALETTE.fgMuted};
    margin: 0 0 0.4rem;
  }
  .onboarding-step-done .onboarding-step-title { color: ${PALETTE.fgMuted}; font-weight: 500; }
  .onboarding-method {
    font-size: 0.85rem;
    color: ${PALETTE.fgMuted};
    margin: 0.5rem 0 0.3rem;
  }
  .onboarding-method strong { color: ${PALETTE.fg}; }
  .onboarding-step .copy-row { margin: 0.35rem 0; }
  .onboarding-foot {
    font-size: 0.82rem;
    color: ${PALETTE.fgMuted};
    margin: 0.6rem 0 0;
  }
  .onboarding-done-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 1rem;
    font-weight: 500;
    color: ${PALETTE.fg};
    margin: 0;
  }
  .onboarding-check {
    flex: 0 0 auto;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 999px;
    background: ${PALETTE.successSoft};
    color: ${PALETTE.success};
    border: 1px solid ${PALETTE.success};
    font-size: 0.85rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .onboarding-connect-another { margin: 0.7rem 0 0; }
  .onboarding-connect-another > summary {
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
    color: ${PALETTE.accent};
    list-style: none;
    user-select: none;
  }
  .onboarding-connect-another > summary::-webkit-details-marker { display: none; }
  .onboarding-connect-another[open] > summary { margin-bottom: 0.4rem; }
  .onboarding-connect-another .copy-row { margin: 0.35rem 0; }

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
  .vault-usage {
    font-size: 0.8rem;
    color: ${PALETTE.fgMuted};
    margin: 0 0 0.5rem;
  }
  .vault-backup { margin: 0 0 0.5rem; }
  .vault-backup-line {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: ${PALETTE.success};
    margin: 0;
  }
  .vault-backup-check {
    flex: 0 0 auto;
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 999px;
    background: ${PALETTE.successSoft};
    color: ${PALETTE.success};
    border: 1px solid ${PALETTE.success};
    font-size: 0.7rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .vault-backup-github { margin: 0.4rem 0 0; }
  .vault-build-ui {
    font-size: 0.82rem;
    color: ${PALETTE.fgMuted};
    margin: 0.6rem 0 0;
    padding-top: 0.6rem;
    border-top: 1px solid ${PALETTE.borderLight};
  }
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

  .vault-admin-link {
    margin: 0.9rem 0 0;
    padding-top: 0.6rem;
    border-top: 1px solid ${PALETTE.borderLight};
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem 0.75rem;
  }
  .vault-admin-sub {
    font-size: 0.82rem;
    color: ${PALETTE.fgMuted};
    flex: 1 1 12rem;
  }

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
    .subtitle, .kv dt,
    .vault-notes-cta-sub, .vault-usage, .vault-build-ui,
    .onboarding-intro, .onboarding-step-sub, .onboarding-method,
    .onboarding-foot { color: #a8a29a; }
    .vault-name strong,
    .onboarding-step-title, .onboarding-method strong,
    .onboarding-done-line { color: #f0ece4; }
    .onboarding-step-done .onboarding-step-title { color: #a8a29a; }
    code { background: #1f1c18; color: #e8e4dc; }
    .copy-row code { background: transparent; }
    .section { border-top-color: #3a362f; }
    .vault-notes-cta, .vault-build-ui,
    .vault-admin-link, .account-security { border-top-color: #3a362f; }
    .vault-admin-sub { color: #a8a29a; }
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
    .minted-hint { color: #a8a29a; }
    .minted-title, .minted-warn { color: #f0ece4; }
  }
`;
