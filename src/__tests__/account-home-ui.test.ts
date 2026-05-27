/**
 * Renderer tests for the friend-facing `/account/` home (multi-user
 * Phase 1 follow-up). The page is a pure function over its opts — these
 * tests pin the load-bearing shape:
 *
 *   - Assigned-vault branch: Notes CTA href encodes the hub+vault URL,
 *     vault name shows in the body, hub origin appears as inline code
 *     in the custom-client disclosure.
 *   - Admin (no assigned vault) branch: link to /admin/ visible.
 *   - Defensive third branch (non-admin + no vault): "ask the operator"
 *     copy renders.
 *   - Common scaffolding: username in welcome, sign-out POST form,
 *     change-password link.
 */
import { describe, expect, test } from "bun:test";
import { renderAccountHome } from "../account-home-ui.ts";

const HUB_ORIGIN = "https://hub.example";
const CSRF = "test-csrf-token";

describe("renderAccountHome", () => {
  test("assigned-vault branch — Notes CTA carries the encoded hub+vault URL", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVault: "alice",
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
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
    // Hub origin renders as inline <code> in the custom-client disclosure.
    expect(html).toContain(`<code>${HUB_ORIGIN}</code>`);
    expect(html).toContain("Use a custom client");
  });

  test("assigned-vault branch — trailing slash on hubOrigin is normalized", () => {
    // The handler resolves origin per-request via `resolveIssuer`; some
    // operators set a hub_origin setting with a trailing slash. The
    // renderer must produce a clean `/vault/<name>` join either way.
    const html = renderAccountHome({
      username: "alice",
      assignedVault: "alice",
      passwordChanged: true,
      hubOrigin: `${HUB_ORIGIN}/`,
      isFirstAdmin: false,
      csrfToken: CSRF,
    });
    const cleanEncoded = encodeURIComponent(`${HUB_ORIGIN}/vault/alice`);
    expect(html).toContain(`https://notes.parachute.computer/add?url=${cleanEncoded}`);
    // The inline-code display also drops the trailing slash.
    expect(html).toContain(`<code>${HUB_ORIGIN}</code>`);
    expect(html).not.toContain(`<code>${HUB_ORIGIN}/</code>`);
  });

  test("admin branch — null assignedVault + isFirstAdmin renders an /admin/ link", () => {
    const html = renderAccountHome({
      username: "admin",
      assignedVault: null,
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: true,
      csrfToken: CSRF,
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
      assignedVault: null,
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
    });
    expect(html).toContain("Welcome, ghost");
    expect(html).toContain("Ask the hub operator");
    // No /admin/ link in this branch — they have no admin role.
    expect(html).not.toContain('href="/admin/"');
    // No Notes CTA.
    expect(html).not.toContain("notes.parachute.computer/add");
  });

  test("account card — change-password link and sign-out form are present", () => {
    const html = renderAccountHome({
      username: "alice",
      assignedVault: "alice",
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
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

  test("escapes hostile content in username and vault name", () => {
    // Defense-in-depth: usernames pass validateUsername (lowercase alnum
    // + `_-`), so HTML metacharacters won't normally make it through. But
    // the renderer is a pure function over arbitrary string input and the
    // escape is load-bearing if the validator ever loosens.
    const html = renderAccountHome({
      username: "<script>",
      assignedVault: "<vault>",
      passwordChanged: true,
      hubOrigin: HUB_ORIGIN,
      isFirstAdmin: false,
      csrfToken: CSRF,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;vault&gt;");
  });
});
