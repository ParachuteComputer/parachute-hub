/**
 * Account route tests (hub#85, restructured for hub#880).
 *
 * The page is now four collapsed disclosure cards, so most tests open the card
 * they exercise via its `*-toggle` button first — `expand()` is the helper.
 * The card headers carry a one-line summary that is readable *without*
 * expanding (2FA status pill, token count, key count); those are asserted
 * against `*-summary` directly.
 *
 * The `lib/api.ts` HTTP helpers are mocked throughout. The wire shapes are
 * unchanged from hub#85 — only the UI around them moved.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Account } from "./Account.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    getMe: vi.fn(),
    changeAccountPassword: vi.fn(),
    startTwoFactor: vi.fn(),
    confirmTwoFactor: vi.fn(),
    disableTwoFactor: vi.fn(),
    listAccountTokens: vi.fn(),
    mintAccountToken: vi.fn(),
    revokeAccountToken: vi.fn(),
    listAccountPubkeys: vi.fn(),
    startPubkeyChallenge: vi.fn(),
    verifyPubkeyLink: vi.fn(),
    unlinkAccountPubkey: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listAccountTokens).mockResolvedValue({ tokens: [], next_cursor: null });
  vi.mocked(api.listAccountPubkeys).mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  // `hasNip07()` treats undefined as "no extension", so clearing is enough.
  (window as unknown as { nostr?: unknown }).nostr = undefined;
});

function renderRoute(initialPath = "/account") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Account />
    </MemoryRouter>,
  );
}

/** Open one of the four disclosure cards by its section test-id. */
async function expand(section: string) {
  const toggle = await screen.findByTestId(`${section}-toggle`);
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return toggle;
}

function meSignedIn(twoFactorEnabled: boolean) {
  return {
    hasSession: true as const,
    user: { id: "u1", displayName: "aaron" },
    csrf: "csrf-abc",
    two_factor_enabled: twoFactorEnabled,
  };
}

describe("Account — render + status", () => {
  it("shows loading on first paint", () => {
    vi.mocked(api.getMe).mockImplementation(() => new Promise(() => {}));
    renderRoute();
    expect(screen.getByText(/loading account/i)).toBeInTheDocument();
  });

  it("renders a sign-in prompt when no session", async () => {
    vi.mocked(api.getMe).mockResolvedValue({ hasSession: false });
    renderRoute();
    await waitFor(() => expect(screen.getByText(/you're not signed in/i)).toBeInTheDocument());
  });

  it("renders 2FA status Off when not enrolled", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("account-2fa-status")).toHaveTextContent(/off/i));
    // Off → the "Set up two-factor" CTA shows once the card is expanded.
    await expand("account-2fa");
    expect(screen.getByTestId("account-2fa-enroll")).toBeInTheDocument();
    // The password form is present.
    await expand("account-password");
    expect(screen.getByTestId("account-current-password")).toBeInTheDocument();
  });

  it("renders 2FA status Enabled + disable form when enrolled", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(true));
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("account-2fa-status")).toHaveTextContent(/enabled/i),
    );
    await expand("account-2fa");
    expect(screen.getByTestId("account-2fa-disable")).toBeInTheDocument();
    expect(screen.getByTestId("account-2fa-disable-password")).toBeInTheDocument();
  });
});

describe("Account — disclosure cards (hub#880)", () => {
  it("collapses every section by default and toggles one open", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    renderRoute();
    const toggle = await screen.findByTestId("account-password-toggle");

    for (const id of ["account-password", "account-2fa", "account-tokens", "account-pubkeys"]) {
      expect(screen.getByTestId(`${id}-toggle`)).toHaveAttribute("aria-expanded", "false");
    }
    expect(screen.queryByTestId("account-current-password")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("account-current-password")).toBeInTheDocument();

    // ...and closing it again puts the body away.
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("account-current-password")).toBeNull();
  });

  it("each toggle is a real button wired to its panel", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    renderRoute();
    const toggle = await screen.findByTestId("account-pubkeys-toggle");
    expect(toggle.tagName).toBe("BUTTON");
    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBe("keys-panel");
    expect(document.getElementById(panelId as string)).not.toBeNull();
  });

  it("summarizes counts in the collapsed headers", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(true));
    vi.mocked(api.listAccountTokens).mockResolvedValue({
      tokens: [
        {
          jti: "jti-a",
          user_id: "u1",
          subject: null,
          client_id: "parachute-account",
          scopes: ["vault:work:read"],
          expires_at: "2030-01-01T00:00:00.000Z",
          revoked_at: null,
          created_at: "2026-08-25T12:00:00.000Z",
          created_via: "cli_mint",
          subject_pubkey: null,
        },
      ],
      next_cursor: null,
    });
    vi.mocked(api.listAccountPubkeys).mockResolvedValue([
      {
        pubkey: "aa".repeat(32),
        label: "phone",
        proof_event_id: "cc".repeat(32),
        linked_at: "2026-08-25T12:00:00.000Z",
        last_verified_at: "2026-08-25T12:00:00.000Z",
      },
    ]);
    renderRoute();

    await waitFor(() =>
      expect(screen.getByTestId("account-tokens-summary")).toHaveTextContent("1 API token"),
    );
    expect(screen.getByTestId("account-pubkeys-summary")).toHaveTextContent("1 linked key");
    expect(screen.getByTestId("account-2fa-summary")).toHaveTextContent(/enabled/i);
    // Counts are readable with every card still collapsed.
    expect(screen.getByTestId("account-tokens-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("pluralizes and reports empties in the headers", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("account-tokens-summary")).toHaveTextContent("No API tokens"),
    );
    expect(screen.getByTestId("account-pubkeys-summary")).toHaveTextContent("No linked keys");
  });

  it("opens the card named by location.hash", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    renderRoute("/account#keys");
    await waitFor(() =>
      expect(screen.getByTestId("account-pubkeys-toggle")).toHaveAttribute("aria-expanded", "true"),
    );
    expect(screen.getByTestId("account-pubkey-link")).toBeInTheDocument();
    // Siblings stay closed.
    expect(screen.getByTestId("account-tokens-toggle")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Account — password change", () => {
  it("POSTs current + new on submit and shows a notice", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.changeAccountPassword).mockResolvedValue();
    renderRoute();
    await expand("account-password");

    fireEvent.change(screen.getByTestId("account-current-password"), {
      target: { value: "old-password-123" },
    });
    fireEvent.change(screen.getByTestId("account-new-password"), {
      target: { value: "brand-new-passphrase" },
    });
    fireEvent.change(screen.getByTestId("account-confirm-password"), {
      target: { value: "brand-new-passphrase" },
    });
    fireEvent.click(screen.getByTestId("account-change-password"));

    await waitFor(() =>
      expect(api.changeAccountPassword).toHaveBeenCalledWith(
        "csrf-abc",
        "old-password-123",
        "brand-new-passphrase",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-password-notice")).toHaveTextContent(/password changed/i),
    );
  });

  it("blocks a too-short new password client-side (no POST)", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    renderRoute();
    await expand("account-password");

    fireEvent.change(screen.getByTestId("account-current-password"), {
      target: { value: "old-password-123" },
    });
    fireEvent.change(screen.getByTestId("account-new-password"), { target: { value: "short" } });
    fireEvent.change(screen.getByTestId("account-confirm-password"), {
      target: { value: "short" },
    });
    fireEvent.click(screen.getByTestId("account-change-password"));

    await waitFor(() =>
      expect(screen.getByTestId("account-password-error")).toHaveTextContent(/at least 12/i),
    );
    expect(api.changeAccountPassword).not.toHaveBeenCalled();
  });

  it("surfaces the server's wrong-current-password error", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.changeAccountPassword).mockRejectedValue(
      new api.HttpError(401, "Current password is incorrect."),
    );
    renderRoute();
    await expand("account-password");

    fireEvent.change(screen.getByTestId("account-current-password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.change(screen.getByTestId("account-new-password"), {
      target: { value: "brand-new-passphrase" },
    });
    fireEvent.change(screen.getByTestId("account-confirm-password"), {
      target: { value: "brand-new-passphrase" },
    });
    fireEvent.click(screen.getByTestId("account-change-password"));

    await waitFor(() =>
      expect(screen.getByTestId("account-password-error")).toHaveTextContent(/incorrect/i),
    );
  });
});

describe("Account — 2FA enroll flow", () => {
  it("start → shows QR + secret, confirm → shows backup codes once", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startTwoFactor).mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      otpauth_url: "otpauth://totp/aaron?secret=JBSWY3DPEHPK3PXP",
      qr_data_url: "data:image/png;base64,AAAA",
    });
    vi.mocked(api.confirmTwoFactor).mockResolvedValue({
      enrolled: true,
      enrolled_at: "2026-06-27T00:00:00.000Z",
      backup_codes: ["abcde-fghij", "klmno-pqrst"],
    });
    renderRoute();
    await expand("account-2fa");

    fireEvent.click(screen.getByTestId("account-2fa-enroll"));
    await waitFor(() => expect(api.startTwoFactor).toHaveBeenCalledWith("csrf-abc"));

    // QR + manual secret render.
    expect(await screen.findByTestId("account-2fa-qr")).toHaveAttribute(
      "src",
      "data:image/png;base64,AAAA",
    );
    expect(screen.getByTestId("account-2fa-secret")).toHaveTextContent("JBSWY3DPEHPK3PXP");

    // Enter a code + confirm.
    fireEvent.change(screen.getByTestId("account-2fa-code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("account-2fa-confirm"));

    await waitFor(() =>
      expect(api.confirmTwoFactor).toHaveBeenCalledWith("csrf-abc", "JBSWY3DPEHPK3PXP", "123456"),
    );
    // Backup codes shown once.
    await waitFor(() => expect(screen.getByTestId("account-2fa-backup-codes")).toBeInTheDocument());
    expect(screen.getByText("abcde-fghij")).toBeInTheDocument();
    expect(screen.getByText("klmno-pqrst")).toBeInTheDocument();
  });

  it("blocks a non-6-digit code client-side (no confirm POST)", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startTwoFactor).mockResolvedValue({
      secret: "JBSWY3DPEHPK3PXP",
      otpauth_url: "otpauth://totp/aaron?secret=JBSWY3DPEHPK3PXP",
      qr_data_url: "data:image/png;base64,AAAA",
    });
    renderRoute();
    await expand("account-2fa");
    fireEvent.click(screen.getByTestId("account-2fa-enroll"));
    await screen.findByTestId("account-2fa-code");

    fireEvent.change(screen.getByTestId("account-2fa-code"), { target: { value: "12" } });
    fireEvent.click(screen.getByTestId("account-2fa-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("account-2fa-error")).toHaveTextContent(/6-digit/i),
    );
    expect(api.confirmTwoFactor).not.toHaveBeenCalled();
  });
});

describe("Account — 2FA disable", () => {
  it("POSTs the password and refreshes status", async () => {
    // First /api/me → enrolled; after disable → refetch returns not-enrolled.
    vi.mocked(api.getMe)
      .mockResolvedValueOnce(meSignedIn(true))
      .mockResolvedValueOnce(meSignedIn(false));
    vi.mocked(api.disableTwoFactor).mockResolvedValue();
    renderRoute();
    await expand("account-2fa");

    fireEvent.change(screen.getByTestId("account-2fa-disable-password"), {
      target: { value: "my-password-123" },
    });
    fireEvent.click(screen.getByTestId("account-2fa-disable"));

    await waitFor(() =>
      expect(api.disableTwoFactor).toHaveBeenCalledWith("csrf-abc", "my-password-123"),
    );
    // Refetch flips the header status to Off + brings back the enroll CTA.
    await waitFor(() => expect(screen.getByTestId("account-2fa-status")).toHaveTextContent(/off/i));
    expect(screen.getByTestId("account-2fa-enroll")).toBeInTheDocument();
  });

  it("requires a password before disabling (no POST when blank)", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(true));
    renderRoute();
    await expand("account-2fa");

    fireEvent.click(screen.getByTestId("account-2fa-disable"));
    await waitFor(() =>
      expect(screen.getByTestId("account-2fa-error")).toHaveTextContent(/current password/i),
    );
    expect(api.disableTwoFactor).not.toHaveBeenCalled();
  });
});

describe("Account — API tokens", () => {
  const tokenRow = (
    jti: string,
    overrides: Partial<api.AccountTokenListing> = {},
  ): api.AccountTokenListing => ({
    jti,
    user_id: "u1",
    subject: "laptop",
    client_id: "parachute-account",
    scopes: ["vault:work:read"],
    expires_at: "2030-01-01T00:00:00.000Z",
    revoked_at: null,
    created_at: "2026-08-25T12:00:00.000Z",
    created_via: "cli_mint",
    subject_pubkey: null,
    ...overrides,
  });

  it("renders the empty state when this account has no live tokens", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    renderRoute();
    await expand("account-tokens");
    expect(await screen.findByTestId("account-tokens-empty")).toBeInTheDocument();
  });

  it("keeps the mint form behind a disclosure", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    renderRoute();
    await expand("account-tokens");
    const mintToggle = screen.getByTestId("account-token-mint-toggle");
    expect(mintToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("account-token-scope")).toBeNull();
    fireEvent.click(mintToggle);
    expect(mintToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("account-token-scope")).toBeInTheDocument();
  });

  it("lists a token row and mints, showing the JWT once", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.listAccountTokens)
      .mockResolvedValueOnce({ tokens: [], next_cursor: null })
      .mockResolvedValueOnce({
        tokens: [tokenRow("aaaaaaaaXXXXXXXbbbb")],
        next_cursor: null,
      });
    vi.mocked(api.mintAccountToken).mockResolvedValue({
      jti: "aaaaaaaaXXXXXXXbbbb",
      token: "eyJhbGciOi.test",
      expires_at: "2030-01-01T00:00:00.000Z",
      scope: "vault:work:read",
    });
    renderRoute();
    await expand("account-tokens");
    fireEvent.click(await screen.findByTestId("account-token-mint-toggle"));
    fireEvent.change(screen.getByTestId("account-token-scope"), {
      target: { value: "vault:work:read" },
    });
    fireEvent.change(screen.getByTestId("account-token-label"), { target: { value: "laptop" } });
    fireEvent.click(screen.getByTestId("account-token-mint"));

    await waitFor(() =>
      expect(api.mintAccountToken).toHaveBeenCalledWith("csrf-abc", {
        scope: "vault:work:read",
        label: "laptop",
      }),
    );
    expect(await screen.findByTestId("account-token-jwt")).toHaveTextContent("eyJhbGciOi.test");
    expect(screen.getByTestId("account-token-minted")).toHaveTextContent(/only time the JWT/i);
    // The form collapses again once the token is minted.
    expect(screen.getByTestId("account-token-mint-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("revokes a live token after confirm", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.listAccountTokens)
      .mockResolvedValueOnce({
        tokens: [tokenRow("jti-live-0001")],
        next_cursor: null,
      })
      .mockResolvedValueOnce({ tokens: [], next_cursor: null });
    vi.mocked(api.revokeAccountToken).mockResolvedValue();
    renderRoute();
    await expand("account-tokens");
    await screen.findByTestId("account-token-revoke-jti-live-0001");
    fireEvent.click(screen.getByTestId("account-token-revoke-jti-live-0001"));
    fireEvent.click(screen.getByTestId("account-token-revoke-confirm-jti-live-0001"));
    await waitFor(() =>
      expect(api.revokeAccountToken).toHaveBeenCalledWith("csrf-abc", "jti-live-0001"),
    );
    await waitFor(() => expect(screen.getByTestId("account-tokens-empty")).toBeInTheDocument());
  });

  it("Load more appends the next page and is disabled while in flight", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    const listMock = vi.mocked(api.listAccountTokens);
    listMock.mockResolvedValueOnce({
      tokens: [tokenRow("page-one-aaaaaa")],
      next_cursor: "cursor-2",
    });
    let resolveSecond: (page: api.AccountTokensPage) => void = () => {};
    listMock.mockReturnValueOnce(
      new Promise<api.AccountTokensPage>((resolve) => {
        resolveSecond = resolve;
      }),
    );
    renderRoute();
    await expand("account-tokens");
    const more = await screen.findByTestId("account-tokens-load-more");
    fireEvent.click(more);
    await waitFor(() => expect(screen.getByTestId("account-tokens-load-more")).toBeDisabled());
    fireEvent.click(screen.getByTestId("account-tokens-load-more"));
    expect(listMock.mock.calls.filter((c) => c[0]?.cursor === "cursor-2")).toHaveLength(1);
    resolveSecond({ tokens: [tokenRow("page-two-bbbbbb")], next_cursor: null });
    expect(await screen.findByTestId("account-token-row-page-two-bbbbbb")).toBeInTheDocument();
    expect(screen.getByTestId("account-token-row-page-one-aaaaaa")).toBeInTheDocument();
    expect(screen.queryByTestId("account-tokens-load-more")).toBeNull();
  });
});

describe("Account — Nostr key link stepper", () => {
  const challenge = {
    challenge: "aa".repeat(32),
    expires_at: "2026-08-25T12:05:00.000Z",
    event_template: {
      kind: 27235,
      content: 'Link this key to account "aaron" on this hub.',
      tags: [
        ["u", "https://hub.example/api/account/pubkeys/verify"],
        ["method", "POST"],
        ["challenge", "aa".repeat(32)],
      ],
    },
  };

  const signedEvent = {
    id: "dd".repeat(32),
    pubkey: "aa".repeat(32),
    created_at: 1,
    kind: 27235,
    tags: [] as string[][],
    content: "statement",
    sig: "ee".repeat(32),
  };

  it("explains why before starting, then walks step 1 → 2 → 3", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue(challenge);
    renderRoute();
    await expand("account-pubkeys");

    // Step 0 — the "why", and no protocol jargon in sight.
    expect(await screen.findByTestId("account-pubkeys-empty")).toBeInTheDocument();
    expect(screen.getByTestId("account-pubkeys")).toHaveTextContent(/attribution label/i);
    expect(screen.getByTestId("account-pubkeys")).toHaveTextContent(/does not log you in/i);
    expect(screen.queryByTestId("account-pubkey-steps")).toBeNull();

    // Step 1 — the statement.
    fireEvent.click(screen.getByTestId("account-pubkey-link"));
    await waitFor(() => expect(api.startPubkeyChallenge).toHaveBeenCalledWith("csrf-abc"));
    expect(await screen.findByTestId("account-pubkey-step-statement")).toBeInTheDocument();
    expect(screen.getByTestId("account-pubkey-statement")).toHaveTextContent(/link this key/i);
    expect(screen.getByTestId("account-pubkey-steps")).toBeInTheDocument();
    expect(
      screen.getByTestId("account-pubkey-steps").querySelector('[aria-current="step"]'),
    ).toHaveTextContent(/get the statement/i);
    // Step 3 fields are not on screen yet.
    expect(screen.queryByTestId("account-pubkey-password")).toBeNull();

    // Step 2 — sign. No extension in jsdom → the paste path is primary.
    fireEvent.click(screen.getByTestId("account-pubkey-statement-continue"));
    expect(await screen.findByTestId("account-pubkey-step-sign")).toBeInTheDocument();
    expect(screen.getByTestId("account-pubkey-no-extension")).toHaveTextContent(
      /no signing extension detected/i,
    );
    expect(screen.getByTestId("account-pubkey-event")).toBeInTheDocument();
    expect(
      screen.getByTestId("account-pubkey-steps").querySelector('[aria-current="step"]'),
    ).toHaveTextContent(/sign it/i);

    // Step 3 — confirm.
    fireEvent.change(screen.getByTestId("account-pubkey-event"), {
      target: { value: JSON.stringify(signedEvent) },
    });
    fireEvent.click(screen.getByTestId("account-pubkey-paste-continue"));
    expect(await screen.findByTestId("account-pubkey-step-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("account-pubkey-signer")).toHaveTextContent("aaaaaaaa");
    expect(
      screen.getByTestId("account-pubkey-steps").querySelector('[aria-current="step"]'),
    ).toHaveTextContent(/confirm/i);
  });

  it("posts the pasted event + first-link password with its explanation", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue(challenge);
    vi.mocked(api.verifyPubkeyLink).mockResolvedValue({
      linked: true,
      relinked: false,
      pubkey: "aa".repeat(32),
      label: "phone",
      proof_event_id: "cc".repeat(32),
      linked_at: "2026-08-25T12:00:00.000Z",
      last_verified_at: "2026-08-25T12:00:00.000Z",
    });
    vi.mocked(api.listAccountPubkeys)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          pubkey: "aa".repeat(32),
          label: "phone",
          proof_event_id: "cc".repeat(32),
          linked_at: "2026-08-25T12:00:00.000Z",
          last_verified_at: "2026-08-25T12:00:00.000Z",
        },
      ]);
    renderRoute();
    await expand("account-pubkeys");
    fireEvent.click(await screen.findByTestId("account-pubkey-link"));
    fireEvent.click(await screen.findByTestId("account-pubkey-statement-continue"));
    fireEvent.change(await screen.findByTestId("account-pubkey-event"), {
      target: { value: JSON.stringify(signedEvent) },
    });
    fireEvent.click(screen.getByTestId("account-pubkey-paste-continue"));

    await screen.findByTestId("account-pubkey-label");
    expect(screen.getByTestId("account-pubkey-password-why")).toHaveTextContent(
      /stolen browser session/i,
    );
    fireEvent.change(screen.getByTestId("account-pubkey-label"), { target: { value: "phone" } });
    fireEvent.change(screen.getByTestId("account-pubkey-password"), {
      target: { value: "correct-horse-battery" },
    });
    fireEvent.click(screen.getByTestId("account-pubkey-verify"));

    await waitFor(() =>
      expect(api.verifyPubkeyLink).toHaveBeenCalledWith("csrf-abc", {
        event: signedEvent,
        label: "phone",
        password: "correct-horse-battery",
      }),
    );
    expect(await screen.findByTestId(`account-pubkey-row-${"aa".repeat(32)}`)).toBeInTheDocument();
    expect(screen.getByTestId("account-pubkeys-notice")).toHaveTextContent(/grants nothing/i);
    // Flow reset to idle.
    expect(screen.getByTestId("account-pubkey-link")).toBeInTheDocument();
    expect(screen.queryByTestId("account-pubkey-steps")).toBeNull();
  });

  it("omits the password field when the account already holds a key", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue(challenge);
    vi.mocked(api.listAccountPubkeys).mockResolvedValue([
      {
        pubkey: "bb".repeat(32),
        label: null,
        proof_event_id: "cc".repeat(32),
        linked_at: "2026-08-25T12:00:00.000Z",
        last_verified_at: "2026-08-25T12:00:00.000Z",
      },
    ]);
    renderRoute();
    await expand("account-pubkeys");
    fireEvent.click(await screen.findByTestId("account-pubkey-link"));
    fireEvent.click(await screen.findByTestId("account-pubkey-statement-continue"));
    fireEvent.change(await screen.findByTestId("account-pubkey-event"), {
      target: { value: JSON.stringify(signedEvent) },
    });
    fireEvent.click(screen.getByTestId("account-pubkey-paste-continue"));

    await screen.findByTestId("account-pubkey-step-confirm");
    expect(screen.queryByTestId("account-pubkey-password")).toBeNull();
    expect(screen.queryByTestId("account-pubkey-password-why")).toBeNull();
  });

  it("rejects non-JSON at the sign step (no POST, stays on step 2)", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue(challenge);
    renderRoute();
    await expand("account-pubkeys");
    fireEvent.click(await screen.findByTestId("account-pubkey-link"));
    fireEvent.click(await screen.findByTestId("account-pubkey-statement-continue"));
    fireEvent.change(await screen.findByTestId("account-pubkey-event"), {
      target: { value: "not-json" },
    });
    fireEvent.click(screen.getByTestId("account-pubkey-paste-continue"));

    await waitFor(() =>
      expect(screen.getByTestId("account-pubkeys-form-error")).toHaveTextContent(/not valid json/i),
    );
    expect(screen.getByTestId("account-pubkey-step-sign")).toBeInTheDocument();
    expect(api.verifyPubkeyLink).not.toHaveBeenCalled();
  });

  it("Cancel from any step returns to idle with fields cleared", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue(challenge);
    renderRoute();
    await expand("account-pubkeys");
    fireEvent.click(await screen.findByTestId("account-pubkey-link"));
    fireEvent.click(await screen.findByTestId("account-pubkey-statement-continue"));
    fireEvent.change(await screen.findByTestId("account-pubkey-event"), {
      target: { value: JSON.stringify(signedEvent) },
    });
    fireEvent.click(screen.getByTestId("account-pubkey-cancel"));

    await waitFor(() => expect(screen.queryByTestId("account-pubkey-flow")).toBeNull());
    // Restarting gives a blank textarea, not the abandoned paste.
    fireEvent.click(screen.getByTestId("account-pubkey-link"));
    fireEvent.click(await screen.findByTestId("account-pubkey-statement-continue"));
    expect(await screen.findByTestId("account-pubkey-event")).toHaveValue("");
  });

  it("Back walks the stepper in reverse", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue(challenge);
    renderRoute();
    await expand("account-pubkeys");
    fireEvent.click(await screen.findByTestId("account-pubkey-link"));
    fireEvent.click(await screen.findByTestId("account-pubkey-statement-continue"));
    fireEvent.change(await screen.findByTestId("account-pubkey-event"), {
      target: { value: JSON.stringify(signedEvent) },
    });
    fireEvent.click(screen.getByTestId("account-pubkey-paste-continue"));
    await screen.findByTestId("account-pubkey-step-confirm");

    fireEvent.click(screen.getByTestId("account-pubkey-back-sign"));
    expect(await screen.findByTestId("account-pubkey-step-sign")).toBeInTheDocument();
    // The pasted event survived the round trip.
    expect(screen.getByTestId("account-pubkey-event")).toHaveValue(JSON.stringify(signedEvent));

    fireEvent.click(screen.getByTestId("account-pubkey-back-statement"));
    expect(await screen.findByTestId("account-pubkey-step-statement")).toBeInTheDocument();
    // Only one challenge was ever minted.
    expect(api.startPubkeyChallenge).toHaveBeenCalledTimes(1);
  });

  it("with a NIP-07 extension: signing jumps to confirm, paste stays available", async () => {
    const signEvent = vi.fn().mockResolvedValue(signedEvent);
    (window as unknown as { nostr?: unknown }).nostr = { signEvent };
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue(challenge);
    renderRoute();
    await expand("account-pubkeys");
    fireEvent.click(await screen.findByTestId("account-pubkey-link"));
    fireEvent.click(await screen.findByTestId("account-pubkey-statement-continue"));
    await screen.findByTestId("account-pubkey-step-sign");

    // Extension present → no "no extension" copy, paste tucked behind a toggle.
    expect(screen.queryByTestId("account-pubkey-no-extension")).toBeNull();
    expect(screen.queryByTestId("account-pubkey-event")).toBeNull();
    const pasteToggle = screen.getByTestId("account-pubkey-paste-toggle");
    expect(pasteToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(pasteToggle);
    expect(screen.getByTestId("account-pubkey-event")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("account-pubkey-nip07"));
    await waitFor(() => expect(signEvent).toHaveBeenCalledTimes(1));
    expect(signEvent.mock.calls[0]?.[0]).toMatchObject({
      kind: 27235,
      content: challenge.event_template.content,
      tags: challenge.event_template.tags,
    });
    expect(await screen.findByTestId("account-pubkey-step-confirm")).toBeInTheDocument();
    expect(screen.getByTestId("account-pubkey-signer")).toHaveTextContent("aaaaaaaa");
  });

  it("unlink asks for confirmation and keeps the tokens-not-revoked truth", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.listAccountPubkeys)
      .mockResolvedValueOnce([
        {
          pubkey: "bb".repeat(32),
          label: "old laptop",
          proof_event_id: "cc".repeat(32),
          linked_at: "2026-08-25T12:00:00.000Z",
          last_verified_at: "2026-08-25T12:00:00.000Z",
        },
      ])
      .mockResolvedValueOnce([]);
    vi.mocked(api.unlinkAccountPubkey).mockResolvedValue(true);
    renderRoute();
    await expand("account-pubkeys");
    const row = `account-pubkey-unlink-${"bb".repeat(32)}`;
    fireEvent.click(await screen.findByTestId(row));
    expect(screen.getByTestId("account-pubkeys-list")).toHaveTextContent(/tokens are not revoked/i);
    fireEvent.click(screen.getByTestId(`account-pubkey-unlink-confirm-${"bb".repeat(32)}`));
    await waitFor(() =>
      expect(api.unlinkAccountPubkey).toHaveBeenCalledWith("csrf-abc", "bb".repeat(32)),
    );
    await waitFor(() => expect(screen.getByTestId("account-pubkeys-empty")).toBeInTheDocument());
  });
});
