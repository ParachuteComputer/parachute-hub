/**
 * Renderer tests for the friend-facing `/account/` home (multi-user
 * Phase 1 follow-up). The page is a pure function over its opts — these
 * tests pin the load-bearing shape:
 *
 *   - Assigned-vault branch: Notes CTA href encodes the hub+vault URL,
 *     vault name shows in the body, AND a per-tile MCP connect block
 *     surfaces the endpoint + `claude mcp add` command (OAuth, no token)
 *     with copy buttons — the multi-user friend-connect surface.
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
    // The friend-connect surface: MCP endpoint + `claude mcp add` command,
    // each with a copy button. OAuth path (no token in the command).
    expect(html).toContain(`${HUB_ORIGIN}/vault/alice/mcp`);
    expect(html).toContain(
      `claude mcp add --transport http parachute-alice ${HUB_ORIGIN}/vault/alice/mcp`,
    );
    expect(html).toContain('data-testid="copy-mcp-endpoint"');
    expect(html).toContain('data-testid="copy-mcp-add-command"');
    // The connect command must NOT embed a token — the OAuth path needs none.
    expect(html).not.toContain("--header");
    expect(html).not.toContain("Authorization: Bearer");
    // Copy-button progressive-enhancement script is present.
    expect(html).toContain("navigator.clipboard");
    // Friendlier framing: the block leads with "connect your AI assistant"
    // rather than MCP jargon up top.
    expect(html).toContain('data-testid="connect-ai-heading"');
    expect(html).toContain("Connect your AI");
    // BOTH connect methods render as distinct, labelled blocks.
    expect(html).toContain('data-testid="connect-method-claude-code"');
    expect(html).toContain("Claude Code");
    expect(html).toContain('data-testid="connect-method-claude-ai"');
    expect(html).toContain("Claude.ai");
    // The Claude.ai path mirrors the install.njk canonical phrasing
    // (Settings → Connectors → Add custom connector, paste the endpoint).
    expect(html).toContain("Connectors");
    expect(html).toContain("Add custom connector");
    // A brief "any other MCP client" line is present (no bloat — just one).
    expect(html).toContain('data-testid="connect-any-client-hint"');
    // Notes CTA still present, now framed as the browser-UI option.
    expect(html).toContain('data-testid="open-notes-cta"');
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
    // One per-vault MCP connect block per tile (endpoint + command).
    expect(html).toContain(`${HUB_ORIGIN}/vault/personal/mcp`);
    expect(html).toContain(`${HUB_ORIGIN}/vault/family/mcp`);
    expect(html).toContain(
      `claude mcp add --transport http parachute-personal ${HUB_ORIGIN}/vault/personal/mcp`,
    );
    expect(html).toContain(
      `claude mcp add --transport http parachute-family ${HUB_ORIGIN}/vault/family/mcp`,
    );
    // Two tiles → two copy-endpoint buttons.
    expect(html.split('data-testid="copy-mcp-endpoint"').length - 1).toBe(2);
    // The copy script is emitted once at the section level, not per-tile.
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

  // --- friend vault-token mint affordance (the new surface) ----------------

  test("mint affordance — read+write tile offers both verbs, POSTs to the right path", () => {
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
    // The collapsible mint block is present, framed as secondary (headless).
    expect(html).toContain('data-testid="token-mint"');
    expect(html).toContain("Mint an access token");
    expect(html).toContain("for scripts / headless clients");
    // Both verb radios render.
    expect(html).toContain('data-testid="mint-verb-read"');
    expect(html).toContain('data-testid="mint-verb-write"');
    // Form POSTs to the per-vault endpoint with the CSRF token embedded.
    expect(html).toContain('action="/account/vault-token/work"');
    expect(html).toContain('method="POST"');
    expect(html).toContain('data-testid="mint-form"');
    expect(html).toContain(CSRF);
    // Recommends the no-token path as default.
    expect(html).toContain("no-token");
  });

  test("mint affordance — a read-only role offers ONLY the read verb", () => {
    // Today every assignment is write-role, but the renderer is verb-blind to
    // the role: it shows exactly the verbs it's handed. A read-only cap must
    // never surface a write radio (the server would reject it anyway).
    const html = renderAccountHome({
      username: "alice",
      assignedVaults: ["work"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { work: ["read"] },
    });
    expect(html).toContain('data-testid="mint-verb-read"');
    expect(html).not.toContain('data-testid="mint-verb-write"');
  });

  test("mint affordance — offers the admin verb when the user holds it", () => {
    // 2026-05-30: assigned users hold read/write/admin on their vault, so the
    // mint form offers admin (the live `vaultVerbsForUserVault` returns it).
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
    expect(html).toContain('value="admin"');
    expect(html).toContain('data-testid="mint-verb-admin"');
  });

  test("mint affordance — absent when no mintable verbs (admin / no-vault / unmapped role)", () => {
    // Admin branch: no tiles at all, so no mint block.
    const admin = renderAccountHome({
      username: "admin",
      assignedVaults: [],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: true,
      csrfToken: CSRF,
      twoFactorEnabled: false,
    });
    expect(admin).not.toContain('data-testid="token-mint"');
    // Assigned vault but empty verb list (fail-closed unknown role) → no block.
    const empty = renderAccountHome({
      username: "alice",
      assignedVaults: ["work"],
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
      twoFactorEnabled: false,
      mintableVerbs: { work: [] },
    });
    expect(empty).not.toContain('data-testid="token-mint"');
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
});
