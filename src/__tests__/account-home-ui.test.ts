/**
 * Renderer tests for the friend-facing `/account/` home (multi-user
 * Phase 1 follow-up). The page is a pure function over its opts — these
 * tests pin the load-bearing shape:
 *
 *   - Assigned-vault branch: Notes CTA href encodes the hub+vault URL,
 *     vault name shows in the body, the backup-state line surfaces, and a
 *     "build your own UI" hint links the surface-build starter. The connect
 *     instructions live ONCE in the onboarding checklist (not duplicated in
 *     the vault card); token-minting is gone from /account (OAuth-first);
 *     a single "Advanced vault settings ↗" deep-link covers advanced needs.
 *   - Admin (no assigned vault) branch: link to /admin/ visible.
 *   - Defensive third branch (non-admin + no vault): "ask the operator"
 *     copy renders.
 *   - Common scaffolding: username in welcome, sign-out POST form,
 *     change-password link.
 */
import { describe, expect, test } from "bun:test";
import {
  accountClaudeMcpAddCommand,
  accountMcpEndpoint,
  renderAccountHome,
} from "../account-home-ui.ts";

const HUB_ORIGIN = "https://hub.example";
const CSRF = "test-csrf-token";

describe("renderAccountHome", () => {
  test("assigned-vault branch — Notes CTA carries the encoded hub+vault URL", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    // Welcome header includes the username.
    expect(html).toContain("Welcome, alice");
    // Vault name renders as inline content in the vault card.
    expect(html).toContain("<strong>alice</strong>");
    // Notes "Open" CTA — same shape as setup-wizard's renderStartUsingTile.
    // The href encodes `${hubOrigin}/vault/<name>` via encodeURIComponent.
    const encodedVaultUrl = encodeURIComponent(`${HUB_ORIGIN}/vault/alice`);
    expect(html).toContain(`https://notes.parachute.computer/add?url=${encodedVaultUrl}`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    // Copy-button progressive-enhancement script is present.
    expect(html).toContain("navigator.clipboard");
    // Notes CTA present, framed as the browser-UI option.
    expect(html).toContain('data-testid="open-notes-cta"');
    // Import-notes CTA deep-links to the Notes-UI /import route for the same
    // vault, mirroring the Open-Notes target-resolution (same hosted origin,
    // same `?url=${hubOrigin}/vault/<name>` vault-targeting param).
    expect(html).toContain(`https://notes.parachute.computer/import?url=${encodedVaultUrl}`);
    expect(html).toContain('data-testid="import-notes-cta"');
  });

  test("dedup — the full connect block lives ONCE (in the checklist), NOT in the vault card", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      connectedVault: false,
    });
    // The checklist owns "Connect your AI" — the endpoint + the `claude mcp add`
    // command (OAuth, no token) appear there.
    expect(html).toContain('data-testid="onboarding-mcp-endpoint"');
    expect(html).toContain('data-testid="onboarding-mcp-add-command"');
    expect(html).toContain(`${HUB_ORIGIN}/vault/alice/mcp`);
    // The vault card must NOT repeat the connect instructions. None of the
    // old mcp-connect block markers may appear — no duplicated connect surface.
    expect(html).not.toContain('data-testid="mcp-connect"');
    expect(html).not.toContain('data-testid="connect-ai-heading"');
    expect(html).not.toContain('data-testid="connect-method-claude-code"');
    expect(html).not.toContain('data-testid="connect-method-claude-ai"');
    expect(html).not.toContain('data-testid="connect-any-client-hint"');
    // The connect instructions live only in the checklist, never duplicated in
    // the vault card: split the page at the vault card and assert the endpoint
    // doesn't reappear in that slice.
    const cardIdx = html.indexOf('data-testid="vault-card"');
    expect(cardIdx).toBeGreaterThan(-1);
    const vaultCardSlice = html.slice(cardIdx);
    expect(vaultCardSlice).not.toContain(`${HUB_ORIGIN}/vault/alice/mcp`);
    expect(vaultCardSlice).not.toContain("claude mcp add");
  });

  test("token-mint — the mint affordance is gone from /account (OAuth-first)", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { alice: ["read", "write", "admin"] },
    });
    // No token-mint <details> block, no mint form, no verb radios — minting a
    // header-auth token is a script/advanced concern that lives in the SPA.
    expect(html).not.toContain('data-testid="token-mint"');
    expect(html).not.toContain('data-testid="mint-form"');
    expect(html).not.toContain('data-testid="mint-verb-read"');
    expect(html).not.toContain('data-testid="mint-verb-admin"');
    expect(html).not.toContain("Mint an access token");
    // The single advanced entry point covers the advanced needs.
    expect(html).toContain('data-testid="vault-admin-button"');
    expect(html).toContain("Advanced vault settings");
  });

  test("build-your-own-UI — Notes is one way; the hint links the surface-build starter", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(html).toContain('data-testid="build-your-own-ui"');
    expect(html).toContain('data-testid="build-your-own-ui-link"');
    expect(html).toContain("https://parachute.computer/onboarding/surface-build/");
    expect(html).toContain("build you a custom UI");
  });

  test("assigned-vault branch — import-notes CTA gated alongside open-notes (no dead link)", () => {
    // Both CTAs render together for an assigned vault and are absent together
    // in the no-vault branches — so we never surface an Import link that points
    // at a vault the user can't reach.
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(html).toContain('data-testid="open-notes-cta"');
    expect(html).toContain('data-testid="import-notes-cta"');

    const adminHtml = renderAccountHome({
      username: "admin",
      assignedVaults: [],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: true,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(adminHtml).not.toContain('data-testid="import-notes-cta"');
    expect(adminHtml).not.toContain("notes.parachute.computer/import");
  });

  test("assigned-vault branch — trailing slash on hubOrigin is normalized", () => {
    // The handler resolves origin per-request via `resolveIssuer`; some
    // operators set a hub_origin setting with a trailing slash. The
    // renderer must produce a clean `/vault/<name>` join either way.
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: `${HUB_ORIGIN}/`,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    const cleanEncoded = encodeURIComponent(`${HUB_ORIGIN}/vault/alice`);
    expect(html).toContain(`https://notes.parachute.computer/add?url=${cleanEncoded}`);
    // The MCP endpoint + connect command also drop the trailing slash — no
    // `//vault` double-slash sneaks in.
    expect(html).toContain(`${HUB_ORIGIN}/vault/alice/mcp`);
    expect(html).not.toContain(`${HUB_ORIGIN}//vault`);
  });

  test("admin branch — null assignedVault + isFirstAdmin renders an /admin/ link", () => {
    const html = renderAccountHome({
      username: "admin",
      assignedVaults: [],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: true,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(html).toContain("Welcome, admin");
    expect(html).toContain("hub administrator");
    expect(html).toContain('href="/admin/"');
    // Should NOT carry the Notes CTA (no vault).
    expect(html).not.toContain("notes.parachute.computer/add");
  });

  test("defensive branch — non-admin with null assignedVault renders an 'ask operator' message", () => {
    // Shouldn't normally occur in Phase 1 (PR 2's /api/users always
    // assigns a vault on create), but the renderer carries a clear
    // explanation rather than a blank card if a row gets into that
    // state via hand-edit or migration race.
    const html = renderAccountHome({
      username: "ghost",
      assignedVaults: [],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(html).toContain("Welcome, ghost");
    // The message explains WHY there's nothing to connect (no vault yet) and
    // gives a clear next step — not just a bare "ask your admin".
    expect(html).toContain("Ask the hub operator to assign you a vault");
    expect(html).toContain("don't have a vault yet");
    // No /admin/ link in this branch — they have no admin role.
    expect(html).not.toContain('href="/admin/"');
    // No Notes CTA.
    expect(html).not.toContain("notes.parachute.computer/add");
    // No connect block — you can't connect a vault you don't have.
    expect(html).not.toContain('data-testid="mcp-connect"');
  });

  test("get-started card — links to the two onboarding prompts, placed AFTER the vault card", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    // The card renders with both onboarding-prompt links (mirrors the
    // operator setup-wizard's starter-prompts section).
    expect(html).toContain('data-testid="get-started-card"');
    expect(html).toContain("Get started with your AI");
    expect(html).toContain("https://parachute.computer/onboarding/vault-setup/");
    expect(html).toContain("https://parachute.computer/onboarding/surface-build/");
    expect(html).toContain('data-testid="starter-vault-setup"');
    expect(html).toContain('data-testid="starter-surface-build"');
    // External links open safely.
    expect(html).toContain('rel="noopener"');
    // Connect-before-prompts: the prompts are only useful once connected, so
    // they now sit AFTER the vault card in document order (and after the
    // onboarding checklist, which leads the page).
    expect(html.indexOf('data-testid="get-started-card"')).toBeGreaterThan(
      html.indexOf('data-testid="vault-card"'),
    );
  });

  test("get-started card — present on the admin branch, hidden on the no-vault branch", () => {
    // The on-ramp belongs on branches that have a vault to act against (admin +
    // assigned-vault). It's suppressed on the no-vault branch, where the page
    // says "You don't have a vault yet" — a do-the-thing card there would
    // contradict the you-lack-the-prerequisite message.
    const admin = renderAccountHome({
      username: "admin",
      assignedVaults: [],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: true,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(admin).toContain('data-testid="get-started-card"');

    const noVault = renderAccountHome({
      username: "ghost",
      assignedVaults: [],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    // No-vault branch: card suppressed, and the no-vault message stands alone.
    expect(noVault).not.toContain('data-testid="get-started-card"');
    expect(noVault).toContain('data-testid="no-vault-card"');
  });

  test("backup state — renders the backup line + omits when no mirror entry", () => {
    const backedUp = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { alice: ["read", "write", "admin"] },
      mirrorLines: { alice: "Backed up — full version history" },
    });
    // The warm, plain-language backup line surfaces on the tile.
    expect(backedUp).toContain('data-testid="backup-state-line"');
    expect(backedUp).toContain("Backed up — full version history");
    // Not pushing yet → a "Back up to GitHub ↗" action (reuses the
    // vault-admin-token deep-link, gated on admin).
    expect(backedUp).toContain('data-testid="backup-github-button"');
    expect(backedUp).toContain("Back up to GitHub");
    expect(backedUp).toContain("/account/vault-admin-token/alice");

    // GitHub variant: when pushing, the line says so and the action is dropped.
    // Suppression is gated on the `mirrorPushing` boolean (NOT the line string).
    const pushing = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { alice: ["read", "write", "admin"] },
      mirrorLines: { alice: "Backed up — version history + GitHub" },
      mirrorPushing: { alice: true },
    });
    expect(pushing).toContain("version history + GitHub");
    expect(pushing).not.toContain('data-testid="backup-github-button"');

    // Omitted silently when the mirror fetch returned nothing (no entry).
    const noMirror = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { alice: ["read", "write", "admin"] },
    });
    expect(noMirror).not.toContain('data-testid="backup-state-line"');
    expect(noMirror).not.toContain('data-testid="vault-backup"');
  });

  test("backup action — gated on the mirrorPushing boolean, not the line string", () => {
    // Regression guard: the "Back up to GitHub ↗" suppression must follow the
    // proper `mirrorPushing` boolean, NOT substring-match the display line.
    // (a) line mentions "GitHub" but mirrorPushing is false → action STILL shows.
    const lineLies = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { alice: ["read", "write", "admin"] },
      mirrorLines: { alice: "Backed up — full version history (GitHub disabled)" },
      mirrorPushing: { alice: false },
    });
    expect(lineLies).toContain('data-testid="backup-github-button"');
    // (b) mirrorPushing true but the line lacks "GitHub" → action suppressed.
    const boolWins = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { alice: ["read", "write", "admin"] },
      mirrorLines: { alice: "Backed up — full version history" },
      mirrorPushing: { alice: true },
    });
    expect(boolWins).not.toContain('data-testid="backup-github-button"');
  });

  test("account card — security actions collapse into a secondary <details>", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    // Username + sign-out stay prominent; change-password + 2FA tuck into a
    // collapsed "Security & password" details so the card reads calmer.
    expect(html).toContain('data-testid="account-security"');
    expect(html).toContain("Security &amp; password");
    // The security actions live inside the details block (after its summary).
    const securityIdx = html.indexOf('data-testid="account-security"');
    expect(securityIdx).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="change-password-link"')).toBeGreaterThan(securityIdx);
    // Sign-out form comes BEFORE the security details — it stays prominent.
    expect(html.indexOf('data-testid="signout-form"')).toBeLessThan(securityIdx);
  });

  test("account card — change-password link and sign-out form are present", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    // Change-password link points at the existing /account/change-password
    // route (server-rendered HTML, separate handler).
    expect(html).toContain('href="/account/change-password"');
    // Sign-out form POSTs to /logout (existing handler), CSRF token
    // round-trips via the renderCsrfHiddenInput helper.
    expect(html).toContain('action="/logout"');
    expect(html).toContain('method="POST"');
    expect(html).toContain(CSRF);
    // Username renders inside the account card too.
    expect(html).toContain("<code>alice</code>");
  });

  test("account card — 2FA status reflects twoFactorEnabled (hub#473)", () => {
    const off = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(off).toContain('data-testid="2fa-status"');
    expect(off).toContain(">Off<");
    // Off → "Set up two-factor" affordance.
    expect(off).toContain('data-testid="setup-2fa-link"');
    expect(off).toContain('href="/account/2fa"');

    const on = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: true,
    });
    expect(on).toContain(">On<");
    // On → "Manage two-factor" affordance.
    expect(on).toContain('data-testid="manage-2fa-link"');
    expect(on).toContain('href="/account/2fa"');
  });

  test("multi-vault branch — renders one tile per assigned vault (Phase 2 PR 2)", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["personal", "family"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    // Plural heading.
    expect(html).toContain("Your vaults");
    // Each vault name appears.
    expect(html).toContain("<strong>personal</strong>");
    expect(html).toContain("<strong>family</strong>");
    // One CTA per vault with the right encoded URL.
    const personalEncoded = encodeURIComponent(`${HUB_ORIGIN}/vault/personal`);
    const familyEncoded = encodeURIComponent(`${HUB_ORIGIN}/vault/family`);
    expect(html).toContain(`https://notes.parachute.computer/add?url=${personalEncoded}`);
    expect(html).toContain(`https://notes.parachute.computer/add?url=${familyEncoded}`);
    // Two tiles → two Open-Notes CTAs.
    expect(html.split('data-testid="open-notes-cta"').length - 1).toBe(2);
    // The vault card does NOT repeat the connect block — that lives in the
    // checklist (which uses the first/primary vault only).
    expect(html).not.toContain('data-testid="mcp-connect"');
    expect(html).not.toContain(`${HUB_ORIGIN}/vault/family/mcp`);
    // The copy script is emitted once at the page level, not per-tile.
    expect(html.split("<script>").length - 1).toBe(1);
  });

  test("accountMcpEndpoint / accountClaudeMcpAddCommand build the canonical shapes", () => {
    expect(accountMcpEndpoint("https://hub.example", "work")).toBe(
      "https://hub.example/vault/work/mcp",
    );
    expect(accountClaudeMcpAddCommand("https://hub.example", "work")).toBe(
      "claude mcp add --transport http parachute-work https://hub.example/vault/work/mcp",
    );
  });

  test("escapes hostile content in username and vault name", () => {
    // Defense-in-depth: usernames pass validateUsername (lowercase alnum
    // + `_-`), so HTML metacharacters won't normally make it through. But
    // the renderer is a pure function over arbitrary string input and the
    // escape is load-bearing if the validator ever loosens.
    const html = renderAccountHome({
      username: "<script>alert(1)</script>",
      assignedVaults: ["<vault>"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    // The injected username/vault metacharacters are escaped — the only
    // `<script>` tag in the output is the page's own copy-button helper, so
    // we assert on the injected payload specifically rather than a blanket
    // "no <script>" (the connect block legitimately emits one).
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;vault&gt;");
    // The escaped vault name also flows into the connect command + endpoint.
    expect(html).toContain("parachute-&lt;vault&gt;");
  });

  // --- single advanced entry point (gated on the admin verb) ---------------

  test("advanced settings link — present + gated on the admin verb", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["work"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { work: ["read", "write", "admin"] },
    });
    // One clearly-labelled "Advanced vault settings ↗" link → the SPA deep-link.
    expect(html).toContain('data-testid="vault-admin-form"');
    expect(html).toContain('data-testid="vault-admin-button"');
    expect(html).toContain("Advanced vault settings");
    expect(html).toContain('action="/account/vault-admin-token/work"');
    expect(html).toContain('method="POST"');
    expect(html).toContain(CSRF);
    // The old dual-purpose "Configure / back up this vault" label is gone.
    expect(html).not.toContain("Configure / back up this vault");
  });

  test("advanced settings link — absent when the user lacks the admin verb", () => {
    // A read/write-only assignment must not surface the admin deep-link (the
    // POST handler would 403 the admin token mint).
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["work"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { work: ["read", "write"] },
    });
    expect(html).not.toContain('data-testid="vault-admin-button"');
    // Admin branch: no tiles at all, so no advanced link.
    const admin = renderAccountHome({
      username: "admin",
      assignedVaults: [],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: true,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(admin).not.toContain('data-testid="vault-admin-button"');
  });

  test("minted-token banner — shows the token once with a save-it warning, no revoke claim", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["work"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { work: ["read", "write"] },
      mintedToken: {
        vaultName: "work",
        verb: "read",
        token: "eyJhbGciOi.FAKE.TOKEN",
        expiresInDays: 90,
      },
    });
    expect(html).toContain('data-testid="minted-token-banner"');
    expect(html).toContain("eyJhbGciOi.FAKE.TOKEN");
    expect(html).toContain('data-testid="copy-minted-token"');
    // Explicit "won't be shown again" + the scope + the TTL.
    expect(html).toContain("won't be shown again");
    expect(html).toContain("vault:work:read");
    expect(html).toContain("90 days");
    // No false revoke-yourself promise (no friend-facing revoke today).
    expect(html).toContain("ask the hub operator");
  });

  test("mint error banner — surfaces an inline authorization error", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["work"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { work: ["read", "write"] },
      mintError: 'You\'re not assigned to a vault named "other".',
    });
    expect(html).toContain('data-testid="mint-error-banner"');
    expect(html).toContain("not assigned");
    // Error render must NOT also show a token.
    expect(html).not.toContain('data-testid="minted-token-banner"');
  });

  // --- first-run onboarding checklist --------------------------------------

  test("onboarding checklist — renders 3 steps with the correct /mcp endpoint (not connected)", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      connectedVault: false,
    });
    expect(html).toContain('data-testid="onboarding-checklist"');
    expect(html).toContain('data-connected="false"');
    // All three numbered steps render.
    expect(html).toContain('data-testid="onboarding-step-1"');
    expect(html).toContain('data-testid="onboarding-step-2"');
    expect(html).toContain('data-testid="onboarding-step-3"');
    expect(html).toContain("Your account is ready");
    expect(html).toContain("Connect your AI");
    expect(html).toContain("Set up your vault");
    // Step ② shows the canonical /vault/<name>/mcp endpoint inline — the /mcp
    // suffix is load-bearing (only it returns the WWW-Authenticate header).
    expect(html).toContain(`${HUB_ORIGIN}/vault/alice/mcp`);
    expect(html).toMatch(/data-testid="onboarding-mcp-endpoint">[^<]*\/vault\/alice\/mcp</);
    // Both connect methods are inline in step ②.
    expect(html).toContain('data-testid="onboarding-mcp-add-command"');
    expect(html).toContain("Add custom connector");
    expect(html).toContain("claude mcp add");
    // Step ③ links the vault-setup starter prompt.
    expect(html).toContain('data-testid="onboarding-vault-setup-link"');
    expect(html).toContain("https://parachute.computer/onboarding/vault-setup/");
  });

  test("onboarding checklist — condenses to 'you're connected' when a grant exists", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      connectedVault: true,
    });
    // Still the same section, but in its condensed done-state.
    expect(html).toContain('data-testid="onboarding-checklist"');
    expect(html).toContain('data-connected="true"');
    expect(html).toContain('data-testid="onboarding-done-line"');
    expect(html).toContain("You're connected");
    // The full 3-step list is gone (no nagging) — but the vault card below
    // remains the working surface.
    expect(html).not.toContain('data-testid="onboarding-step-2"');
    expect(html).toContain('data-testid="vault-card"');
  });

  test("onboarding condensed state keeps a 'Connect another AI' expander with the full instructions (hub#583)", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      connectedVault: true,
    });
    // The expander itself...
    expect(html).toContain('data-testid="onboarding-connect-another"');
    expect(html).toContain('data-testid="onboarding-connect-another-summary"');
    expect(html).toContain("Connect another AI");
    // ...re-reveals the endpoint + BOTH connect methods that the condensed
    // line used to delete entirely (the hub#583 defect).
    expect(html).toContain('data-testid="onboarding-mcp-endpoint"');
    expect(html).toContain('data-testid="onboarding-mcp-add-command"');
    expect(html).toContain("Claude.ai (web)");
    expect(html).toContain("Claude Code (terminal)");
  });

  test("onboarding NON-condensed (not connected) state has no 'Connect another AI' expander (hub#583)", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      connectedVault: false,
    });
    // Full checklist already shows the inline instructions in step 2, so the
    // expander is condensed-state-only.
    expect(html).not.toContain('data-testid="onboarding-connect-another"');
    expect(html).toContain('data-testid="onboarding-step-2"');
    expect(html).toContain('data-testid="onboarding-mcp-endpoint"');
  });

  test("onboarding checklist — leads the page: BEFORE the vault card and the starter prompts", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["alice"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      connectedVault: false,
    });
    const checklistIdx = html.indexOf('data-testid="onboarding-checklist"');
    const vaultIdx = html.indexOf('data-testid="vault-card"');
    const promptsIdx = html.indexOf('data-testid="get-started-card"');
    // Net first-run order: checklist (connect) → vault details → prompts.
    expect(checklistIdx).toBeGreaterThanOrEqual(0);
    expect(checklistIdx).toBeLessThan(vaultIdx);
    expect(vaultIdx).toBeLessThan(promptsIdx);
  });

  test("onboarding checklist — absent on the admin and no-vault branches", () => {
    const admin = renderAccountHome({
      username: "admin",
      assignedVaults: [],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: true,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(admin).not.toContain('data-testid="onboarding-checklist"');

    const noVault = renderAccountHome({
      username: "ghost",
      assignedVaults: [],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(noVault).not.toContain('data-testid="onboarding-checklist"');
  });

  test("onboarding checklist — multi-vault uses the first vault for the connect step", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["personal", "family"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      connectedVault: false,
    });
    // The checklist's connect step references the first/primary vault; the
    // per-vault tiles below still list every vault (by name + Notes CTA), but
    // no longer repeat the connect endpoint (dedup — connect lives only here).
    expect(html).toMatch(/data-testid="onboarding-mcp-endpoint">[^<]*\/vault\/personal\/mcp</);
    expect(html).toContain("<strong>family</strong>"); // second vault still has a tile
    expect(html).not.toContain(`${HUB_ORIGIN}/vault/family/mcp`); // no duplicated connect
  });
});
