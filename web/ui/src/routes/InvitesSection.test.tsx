/**
 * InvitesSection smoke tests — the invite-create form (pre-named username,
 * provision-vs-share modes, role selector) + the single-emit URL banner and
 * the list's access labels.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { InvitesSection } from "./InvitesSection.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listInvites: vi.fn(),
    listUserVaults: vi.fn(),
    createInvite: vi.fn(),
    revokeInvite: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listInvites).mockResolvedValue([]);
  vi.mocked(api.listUserVaults).mockResolvedValue(["jonathan-vault", "work"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function invite(overrides: Partial<api.InviteListing> = {}): api.InviteListing {
  return {
    id: "hash-1",
    status: "pending",
    vault_name: null,
    username: null,
    role: "write",
    provision_vault: true,
    default_mirror: null,
    expires_at: "2026-06-20T00:00:00.000Z",
    used_at: null,
    redeemed_user_id: null,
    revoked_at: null,
    created_at: "2026-06-10T00:00:00.000Z",
    ...overrides,
  };
}

function renderSection() {
  return render(<InvitesSection hubOrigin="https://hub.example.com" />);
}

describe("InvitesSection — form modes", () => {
  it("defaults to provision mode: new-vault name field, no role selector", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText(/no invites yet/i)).toBeInTheDocument());
    expect(screen.getByText(/new vault name/i)).toBeInTheDocument();
    expect(screen.queryByText("Role")).not.toBeInTheDocument();
  });

  it("share mode reveals the existing-vault picker + role selector", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText(/no invites yet/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/vault access/i), { target: { value: "share" } });
    expect(screen.getByText("Role")).toBeInTheDocument();
    // The existing vaults populate the picker.
    expect(screen.getByRole("option", { name: "jonathan-vault" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "work" })).toBeInTheDocument();
    // New-vault name field is gone in share mode.
    expect(screen.queryByText(/new vault name/i)).not.toBeInTheDocument();
  });

  it("submits a pre-named read-only shared-vault invite (the Adam/Jonathan shape)", async () => {
    vi.mocked(api.createInvite).mockResolvedValue({
      invite: invite({
        username: "jonathan",
        vault_name: "jonathan-vault",
        role: "read",
        provision_vault: false,
      }),
      token: "raw-token",
      url: "https://hub.example.com/account/setup/raw-token",
    });
    renderSection();
    await waitFor(() => expect(screen.getByText(/no invites yet/i)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "jonathan" } });
    fireEvent.change(screen.getByLabelText(/vault access/i), { target: { value: "share" } });
    fireEvent.change(screen.getByLabelText("Vault"), { target: { value: "jonathan-vault" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "read" } });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));

    await waitFor(() => expect(api.createInvite).toHaveBeenCalledTimes(1));
    expect(api.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({
        username: "jonathan",
        vault_name: "jonathan-vault",
        provision_vault: false,
        role: "read",
      }),
    );
    // Single-emit URL banner.
    await waitFor(() =>
      expect(
        screen.getByText("https://hub.example.com/account/setup/raw-token"),
      ).toBeInTheDocument(),
    );
  });

  it("share mode without a picked vault shows an inline error, no API call", async () => {
    const { container } = renderSection();
    await waitFor(() => expect(screen.getByText(/no invites yet/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/vault access/i), { target: { value: "share" } });
    // Dispatch submit directly: the picker is `required`, so a real browser's
    // native validation already blocks the click path — this exercises the
    // belt-and-suspenders inline guard behind it.
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    await waitFor(() =>
      expect(
        screen.getByText(/pick which existing vault to share before creating/i),
      ).toBeInTheDocument(),
    );
    expect(api.createInvite).not.toHaveBeenCalled();
  });

  it("provision mode submits provision_vault=true with the optional pinned name", async () => {
    vi.mocked(api.createInvite).mockResolvedValue({
      invite: invite({ vault_name: "maya" }),
      token: "raw-token-2",
      url: "https://hub.example.com/account/setup/raw-token-2",
    });
    renderSection();
    await waitFor(() => expect(screen.getByText(/no invites yet/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/new vault name/i), { target: { value: "maya" } });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));
    await waitFor(() => expect(api.createInvite).toHaveBeenCalledTimes(1));
    expect(api.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({ vault_name: "maya", provision_vault: true }),
    );
    const call = vi.mocked(api.createInvite).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.role).toBeUndefined();
    expect(call.username).toBeUndefined();
  });

  it("surfaces a createInvite server error in the banner", async () => {
    vi.mocked(api.createInvite).mockRejectedValue(
      new Error('username "jonathan" is already in use'),
    );
    renderSection();
    await waitFor(() => expect(screen.getByText(/no invites yet/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "jonathan" } });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));
    await waitFor(() => expect(screen.getByText(/already in use/i)).toBeInTheDocument());
  });
});

describe("InvitesSection — prefiguration (what will this link do?)", () => {
  it("shows a live preview that follows the form state", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByText(/no invites yet/i)).toBeInTheDocument());
    // Default: new account + self-named new vault.
    expect(screen.getByTestId("invite-preview").textContent).toContain(
      "Creates an account (they pick the username) + their own new vault (they name it), as owner.",
    );
    // Pre-name the user + share an existing vault read-only.
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "jonathan" } });
    fireEvent.change(screen.getByLabelText(/vault access/i), { target: { value: "share" } });
    // Until a vault is picked the preview says what's missing.
    expect(screen.getByTestId("invite-preview").textContent).toContain(
      "Pick the existing vault to share",
    );
    fireEvent.change(screen.getByLabelText("Vault"), { target: { value: "jonathan-vault" } });
    expect(screen.getByTestId("invite-preview").textContent).toContain(
      'Creates an account for "jonathan" with read-only access to your existing vault "jonathan-vault".',
    );
  });

  it("created banner shows the minted link's prefiguration + Copy message composes a paste-ready note", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    vi.mocked(api.createInvite).mockResolvedValue({
      invite: invite({
        username: "jonathan",
        vault_name: "jonathan-vault",
        role: "read",
        provision_vault: false,
      }),
      token: "raw-token",
      url: "https://hub.example.com/account/setup/raw-token",
    });
    renderSection();
    await waitFor(() => expect(screen.getByText(/no invites yet/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "jonathan" } });
    fireEvent.change(screen.getByLabelText(/vault access/i), { target: { value: "share" } });
    fireEvent.change(screen.getByLabelText("Vault"), { target: { value: "jonathan-vault" } });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));

    // Banner restates the prefiguration so "how did I send this?" has an answer.
    await waitFor(() =>
      expect(
        screen.getByText(
          /Creates an account for "jonathan" with read-only access to your existing vault "jonathan-vault"\./,
        ),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /copy message/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const message = writeText.mock.calls[0]?.[0] as string;
    // Full-content snapshot of the composed message — pins the pre-named
    // username line, the access phrase, and the link in their exact shape.
    // The expiry date renders via the same toLocaleDateString the component
    // uses, so the assertion is locale-stable on any runner.
    const expires = new Date("2026-06-20T00:00:00.000Z").toLocaleDateString();
    expect(message).toBe(
      `You're invited to my Parachute. Open this link to set your password and claim your account. Your username will be "jonathan". You'll get read-only access to the vault "jonathan-vault". The link works once and expires ${expires}: https://hub.example.com/account/setup/raw-token`,
    );
  });
});

describe("InvitesSection — list rendering", () => {
  it("renders username + access labels per row", async () => {
    vi.mocked(api.listInvites).mockResolvedValue([
      invite({
        id: "h1",
        username: "jonathan",
        vault_name: "jonathan-vault",
        role: "read",
        provision_vault: false,
      }),
      invite({ id: "h2", username: null, vault_name: null, role: "write", provision_vault: true }),
    ]);
    renderSection();
    await waitFor(() => expect(screen.getByText("jonathan")).toBeInTheDocument());
    expect(screen.getByText("read-only (shared)")).toBeInTheDocument();
    expect(screen.getByText("owner (new vault)")).toBeInTheDocument();
    expect(screen.getByText("they choose")).toBeInTheDocument();
    expect(screen.getByText("redeemer chooses")).toBeInTheDocument();
  });
});
