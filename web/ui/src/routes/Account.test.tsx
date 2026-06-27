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
  };
});

beforeEach(() => {
  vi.clearAllMocks();
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
