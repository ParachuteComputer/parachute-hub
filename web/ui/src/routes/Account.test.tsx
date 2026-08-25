/**
 * Account route tests (hub#85): My account page — password change + 2FA
 * status / enroll flow / disable. The `lib/api.ts` HTTP helpers are mocked;
 * these assert the page renders status, drives the enroll flow, and gates
 * disable on a password.
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
});

function renderRoute() {
  return render(
    <MemoryRouter>
      <Account />
    </MemoryRouter>,
  );
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
    // Off → the "Set up two-factor" CTA shows.
    expect(screen.getByTestId("account-2fa-enroll")).toBeInTheDocument();
    // The password form is present.
    expect(screen.getByTestId("account-current-password")).toBeInTheDocument();
  });

  it("renders 2FA status Enabled + disable form when enrolled", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(true));
    renderRoute();
    await waitFor(() =>
      expect(screen.getByTestId("account-2fa-status")).toHaveTextContent(/enabled/i),
    );
    expect(screen.getByTestId("account-2fa-disable")).toBeInTheDocument();
    expect(screen.getByTestId("account-2fa-disable-password")).toBeInTheDocument();
  });
});

describe("Account — password change", () => {
  it("POSTs current + new on submit and shows a notice", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.changeAccountPassword).mockResolvedValue();
    renderRoute();
    await screen.findByTestId("account-current-password");

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
    await screen.findByTestId("account-current-password");

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
    await screen.findByTestId("account-current-password");

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
    await screen.findByTestId("account-2fa-enroll");

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
    await screen.findByTestId("account-2fa-enroll");
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
    await screen.findByTestId("account-2fa-disable-password");

    fireEvent.change(screen.getByTestId("account-2fa-disable-password"), {
      target: { value: "my-password-123" },
    });
    fireEvent.click(screen.getByTestId("account-2fa-disable"));

    await waitFor(() =>
      expect(api.disableTwoFactor).toHaveBeenCalledWith("csrf-abc", "my-password-123"),
    );
    // Refetch flips the status to Off + brings back the enroll CTA.
    await waitFor(() => expect(screen.getByTestId("account-2fa-status")).toHaveTextContent(/off/i));
  });

  it("requires a password before disabling (no POST when blank)", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(true));
    renderRoute();
    await screen.findByTestId("account-2fa-disable");

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
    expect(await screen.findByTestId("account-tokens-empty")).toBeInTheDocument();
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
    await screen.findByTestId("account-token-mint-toggle");
    fireEvent.click(screen.getByTestId("account-token-mint-toggle"));
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

describe("Account — Nostr keys", () => {
  it("renders empty state and starts the challenge flow", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue({
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
    });
    renderRoute();
    expect(await screen.findByTestId("account-pubkeys-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("account-pubkey-link"));
    await waitFor(() => expect(api.startPubkeyChallenge).toHaveBeenCalledWith("csrf-abc"));
    expect(await screen.findByTestId("account-pubkey-statement")).toHaveTextContent(
      /link this key/i,
    );
    expect(screen.getByTestId("account-pubkey-password")).toBeInTheDocument();
  });

  it("posts the pasted event + first-link password", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue({
      challenge: "bb".repeat(32),
      expires_at: "2026-08-25T12:05:00.000Z",
      event_template: {
        kind: 27235,
        content: "statement",
        tags: [["u", "https://hub.example/api/account/pubkeys/verify"]],
      },
    });
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
    await screen.findByTestId("account-pubkey-link");
    fireEvent.click(screen.getByTestId("account-pubkey-link"));
    await screen.findByTestId("account-pubkey-event");
    const event = {
      id: "dd".repeat(32),
      pubkey: "aa".repeat(32),
      created_at: 1,
      kind: 27235,
      tags: [] as string[][],
      content: "statement",
      sig: "ee".repeat(32),
    };
    fireEvent.change(screen.getByTestId("account-pubkey-event"), {
      target: { value: JSON.stringify(event) },
    });
    fireEvent.change(screen.getByTestId("account-pubkey-label"), { target: { value: "phone" } });
    fireEvent.change(screen.getByTestId("account-pubkey-password"), {
      target: { value: "correct-horse-battery" },
    });
    fireEvent.click(screen.getByTestId("account-pubkey-verify"));
    await waitFor(() =>
      expect(api.verifyPubkeyLink).toHaveBeenCalledWith("csrf-abc", {
        event,
        label: "phone",
        password: "correct-horse-battery",
      }),
    );
    expect(await screen.findByTestId(`account-pubkey-row-${"aa".repeat(32)}`)).toBeInTheDocument();
  });

  it("rejects non-JSON event client-side (no POST)", async () => {
    vi.mocked(api.getMe).mockResolvedValue(meSignedIn(false));
    vi.mocked(api.startPubkeyChallenge).mockResolvedValue({
      challenge: "bb".repeat(32),
      expires_at: "2026-08-25T12:05:00.000Z",
      event_template: { kind: 27235, content: "statement", tags: [] },
    });
    renderRoute();
    await screen.findByTestId("account-pubkey-link");
    fireEvent.click(screen.getByTestId("account-pubkey-link"));
    await screen.findByTestId("account-pubkey-event");
    fireEvent.change(screen.getByTestId("account-pubkey-event"), { target: { value: "not-json" } });
    fireEvent.click(screen.getByTestId("account-pubkey-verify"));
    await waitFor(() =>
      expect(screen.getByTestId("account-pubkeys-form-error")).toHaveTextContent(/not valid json/i),
    );
    expect(api.verifyPubkeyLink).not.toHaveBeenCalled();
  });
});
