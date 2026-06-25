/**
 * Users route smoke tests — loading, list with sample data,
 * empty state, create-form happy path + client-side validation,
 * delete confirm flow, first-admin Delete + Reset disabled with
 * tooltips, admin password reset happy path + cancel + client/server
 * validation, load error.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Users } from "./Users.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listUsers: vi.fn(),
    listUserVaults: vi.fn(),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    resetUserPassword: vi.fn(),
    updateUserVaults: vi.fn(),
    getHubOriginSetting: vi.fn(),
    listVaultCaps: vi.fn(),
    setVaultCap: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  // The Users load effect fetches the hub origin (for the sign-in
  // handoff URL on the create / reset banners) alongside listUsers +
  // listUserVaults. Default to a representative resolved issuer so every
  // existing test loads cleanly; tests that assert the URL override the
  // resolved_issuer value explicitly.
  vi.mocked(api.getHubOriginSetting).mockResolvedValue({
    hub_origin: "https://hub.example.com",
    resolved_issuer: "https://hub.example.com",
    source: "settings",
  });
  // The VaultCapsSection (rendered below the users table once the list
  // resolves) fetches caps on mount. Default to empty so existing tests
  // load cleanly; the cap-specific tests override it.
  vi.mocked(api.listVaultCaps).mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderRoute() {
  return render(
    <MemoryRouter>
      <Users />
    </MemoryRouter>,
  );
}

function user(username: string, overrides: Partial<api.UserListing> = {}): api.UserListing {
  return {
    id: `id-${username}`,
    username,
    password_changed: true,
    email: null,
    assigned_vaults: [],
    created_at: "2026-05-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("Users — list rendering", () => {
  it("shows a loading state on first paint", () => {
    vi.mocked(api.listUsers).mockImplementation(() => new Promise(() => {}));
    vi.mocked(api.listUserVaults).mockImplementation(() => new Promise(() => {}));
    renderRoute();
    expect(screen.getByText(/loading users/i)).toBeInTheDocument();
  });

  it("renders the empty state when no users exist", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    await waitFor(() => expect(screen.getByText(/no users yet/i)).toBeInTheDocument());
  });

  it("renders one row per user with assigned vault + password status", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([
      user("operator", { password_changed: true, assigned_vaults: [] }),
      user("alice", { password_changed: false, assigned_vaults: ["home"] }),
    ]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home"]);
    renderRoute();
    await waitFor(() => expect(screen.getByText("operator")).toBeInTheDocument());
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("home")).toBeInTheDocument();
    // First admin badge on the earliest row. (The sr-only describedby
    // span also contains "first admin" text — scope to the visible
    // badge specifically by its short label rather than matching any
    // "first admin" occurrence anywhere in the DOM.)
    expect(screen.getByText("first admin")).toBeInTheDocument();
    // Em-dash placeholders appear in several cells now (empty assigned-vaults,
    // null email). Assert at least one is present rather than uniqueness.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    // password_changed: false renders the "pending first login" label.
    expect(screen.getByText(/pending first login/i)).toBeInTheDocument();
  });

  it("renders the error banner + retry on listUsers failure", async () => {
    vi.mocked(api.listUsers).mockRejectedValue(new Error("network down"));
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    await waitFor(() => expect(screen.getByText(/couldn't load users/i)).toBeInTheDocument());
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

describe("Users — first-admin protection", () => {
  it("disables the Delete button for the first admin and surfaces a tooltip", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    const operatorBtn = await screen.findByRole("button", { name: /delete operator/i });
    expect(operatorBtn).toBeDisabled();
    expect(operatorBtn).toHaveAttribute("title", expect.stringMatching(/first admin/i));
    // a11y: aria-describedby points at a visually-hidden span carrying
    // the explanation. `title` on a disabled button is unreliable for
    // assistive tech, so the describedby is the load-bearing surface.
    const describedById = operatorBtn.getAttribute("aria-describedby");
    expect(describedById).toMatch(/^first-admin-tooltip-/);
    const tooltipSpan = describedById ? document.getElementById(describedById) : null;
    expect(tooltipSpan).not.toBeNull();
    expect(tooltipSpan?.className).toContain("sr-only");
    expect(tooltipSpan?.textContent).toMatch(/first admin can't be deleted/i);
    // Non-first user Delete is enabled and carries no describedby.
    const aliceBtn = screen.getByRole("button", { name: /delete alice/i });
    expect(aliceBtn).not.toBeDisabled();
    expect(aliceBtn).not.toHaveAttribute("aria-describedby");
  });

  it("disables the Reset password button for the first admin with a /account/change-password tooltip", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    const operatorReset = await screen.findByRole("button", {
      name: /reset password for operator/i,
    });
    expect(operatorReset).toBeDisabled();
    expect(operatorReset).toHaveAttribute("title", expect.stringMatching(/change-password/i));
    const describedById = operatorReset.getAttribute("aria-describedby");
    expect(describedById).toMatch(/^first-admin-reset-tooltip-/);
    const tooltipSpan = describedById ? document.getElementById(describedById) : null;
    expect(tooltipSpan?.className).toContain("sr-only");
    expect(tooltipSpan?.textContent).toMatch(/change-password directly/i);
    // Non-first user Reset password is enabled.
    const aliceReset = screen.getByRole("button", { name: /reset password for alice/i });
    expect(aliceReset).not.toBeDisabled();
    expect(aliceReset).not.toHaveAttribute("aria-describedby");
  });
});

describe("Users — delete confirm flow", () => {
  it("clicking Delete opens a confirm dialog; cancel returns to list without DELETE", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /delete alice/i }));
    expect(screen.getByRole("dialog", { name: /confirm delete alice/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /confirm delete alice/i })).toBeNull(),
    );
    expect(api.deleteUser).not.toHaveBeenCalled();
  });

  it("confirm Delete calls deleteUser, refreshes the list, and shows the revocation-lag banner", async () => {
    const listMock = vi.mocked(api.listUsers);
    listMock.mockResolvedValueOnce([user("operator"), user("alice")]);
    listMock.mockResolvedValueOnce([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.deleteUser).mockResolvedValue({ revocationLagSeconds: 60 });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /delete alice/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm delete alice/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(api.deleteUser).toHaveBeenCalledWith("id-alice"));
    // alice's row is gone after refresh (her Delete button no longer exists).
    // We assert on the row affordance, not bare text — the success banner
    // legitimately echoes the deleted username.
    await waitFor(() => expect(screen.queryByRole("button", { name: /delete alice/i })).toBeNull());
    // Revocation-lag warning banner appears (consistency with reset-password).
    const banner = await screen.findByTestId("delete-done-banner");
    expect(banner).toHaveTextContent(/tokens are revoked/i);
    expect(banner).toHaveTextContent(/up to 60 seconds/i);
  });

  it("surfaces a per-row error banner when delete fails", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.deleteUser).mockRejectedValue(new api.HttpError(500, "boom"));
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /delete alice/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm delete alice/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    await waitFor(() =>
      expect(screen.getByText(/delete failed \(500\): boom/i)).toBeInTheDocument(),
    );
  });
});

describe("Users — admin password reset (Phase 2 PR 1)", () => {
  it("clicking Reset password reveals an inline form scoped to that row", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /reset password for alice/i }));
    expect(await screen.findByLabelText(/new temporary password for alice/i)).toBeInTheDocument();
    // Submit button label is the canonical action.
    expect(screen.getByRole("button", { name: /set new password/i })).toBeInTheDocument();
  });

  it("happy path — POSTs new password, shows success banner, refreshes the list", async () => {
    const listMock = vi.mocked(api.listUsers);
    listMock.mockResolvedValueOnce([user("operator"), user("alice")]);
    // After the reset the row flips back to password_changed=false (the
    // server flips it and the SPA re-reads). Round-trip through the mock.
    listMock.mockResolvedValueOnce([user("operator"), user("alice", { password_changed: false })]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.resetUserPassword).mockResolvedValue({ revocationLagSeconds: 60 });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /reset password for alice/i }));
    fireEvent.change(screen.getByLabelText(/new temporary password for alice/i), {
      target: { value: "new-temp-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));
    await waitFor(() =>
      expect(api.resetUserPassword).toHaveBeenCalledWith("id-alice", "new-temp-passphrase"),
    );
    // Success banner copy mirrors the design's "hand them the password +
    // change on first sign-in" wording. The banner-scoped query is
    // intentional — the page-level header copy also includes "change
    // it on first sign-in" prose, so we scope to the success-banner
    // element to avoid duplicate matches.
    await waitFor(() => expect(screen.getByText(/password reset for/i)).toBeInTheDocument());
    const banner = screen.getByText(/password reset for/i).closest("output");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toMatch(/prompted to change it on first sign-in/i);
    // List refresh fired so the password-set badge can flip.
    await waitFor(() => expect(api.listUsers).toHaveBeenCalledTimes(2));
  });

  it("client-side rejects a too-short password before calling the API", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /reset password for alice/i }));
    fireEvent.change(screen.getByLabelText(/new temporary password for alice/i), {
      target: { value: "tooshortpw1" }, // 11 chars
    });
    fireEvent.submit(screen.getByRole("form", { name: /reset password for alice/i }));
    await waitFor(() => expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument());
    expect(api.resetUserPassword).not.toHaveBeenCalled();
  });

  it("surfaces server error_description from a 403 cannot_reset_first_admin", async () => {
    // Defense in depth: the SPA disables the button for the first admin,
    // but if the server's 403 surfaces anyway (e.g. the operator hits a
    // race or someone POSTs from curl), the error banner should render
    // verbatim in the row.
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.resetUserPassword).mockRejectedValue(
      new api.HttpError(403, "the first admin must use /account/change-password directly"),
    );
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /reset password for alice/i }));
    fireEvent.change(screen.getByLabelText(/new temporary password for alice/i), {
      target: { value: "new-temp-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));
    await waitFor(() => expect(screen.getByText(/reset failed \(403\)/i)).toBeInTheDocument());
  });

  it("Cancel closes the inline form without posting", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /reset password for alice/i }));
    expect(screen.getByLabelText(/new temporary password for alice/i)).toBeInTheDocument();
    // There are two Cancel buttons possible (delete confirm + reset form);
    // scope by the form's accessible name to grab the reset one.
    const form = screen.getByRole("form", { name: /reset password for alice/i });
    fireEvent.click(within(form).getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByLabelText(/new temporary password for alice/i)).toBeNull(),
    );
    expect(api.resetUserPassword).not.toHaveBeenCalled();
  });
});

describe("Users — create form", () => {
  it("hides the form behind a Create User button by default", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home"]);
    renderRoute();
    expect(await screen.findByRole("button", { name: /create user/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password/i)).toBeNull();
  });

  it("clicking Create User reveals the form with multi-select vault listing", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home", "work"]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /create user/i }));
    expect(
      await screen.findByLabelText(/username/i, { selector: "#new-user-username" }),
    ).toBeInTheDocument();
    const select = screen.getByLabelText(/assigned vaults/i) as HTMLSelectElement;
    expect(select.multiple).toBe(true);
    const optionTexts = Array.from(select.options).map((o) => o.text);
    // Multi-select: no synthetic "No restriction" option — empty selection
    // implicitly means no narrowing.
    expect(optionTexts).toEqual(["home", "work"]);
  });

  it("submits createUser with the assigned vaults and refreshes the list on success", async () => {
    const listMock = vi.mocked(api.listUsers);
    listMock.mockResolvedValueOnce([user("operator")]);
    listMock.mockResolvedValueOnce([
      user("operator"),
      user("alice", { password_changed: false, assigned_vaults: ["home"] }),
    ]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home"]);
    vi.mocked(api.createUser).mockResolvedValue(
      user("alice", { password_changed: false, assigned_vaults: ["home"] }),
    );
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /create user/i }));
    fireEvent.change(screen.getByLabelText(/username/i, { selector: "#new-user-username" }), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "alice-strong-passphrase" },
    });
    // Multi-select: pick "home" via selectedOptions handling.
    const vaultsSelect = screen.getByLabelText(/assigned vaults/i) as HTMLSelectElement;
    const homeOption = Array.from(vaultsSelect.options).find((o) => o.value === "home");
    if (homeOption) homeOption.selected = true;
    fireEvent.change(vaultsSelect);
    fireEvent.click(screen.getByRole("button", { name: /^create user$/i }));
    await waitFor(() =>
      expect(api.createUser).toHaveBeenCalledWith({
        username: "alice",
        password: "alice-strong-passphrase",
        assignedVaults: ["home"],
      }),
    );
    // Success banner copy matches the design's "force-change on first login" wording.
    await waitFor(() =>
      expect(screen.getByText(/prompted to change their password/i)).toBeInTheDocument(),
    );
    // List refreshed — alice now visible in the table.
    await waitFor(() => expect(api.listUsers).toHaveBeenCalledTimes(2));
    // Two `alice` text matches: one in the table row, one in the success
    // banner — both are signals that the create flow completed.
    expect(screen.getAllByText("alice").length).toBeGreaterThanOrEqual(1);
  });

  it("client-side rejects password shorter than 12 chars before calling the API", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /create user/i }));
    fireEvent.change(screen.getByLabelText(/username/i, { selector: "#new-user-username" }), {
      target: { value: "alice" },
    });
    // 11 chars — under the floor.
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: "tooshortpw1" } });
    // Submit via form submit handler (the input minLength HTML attribute
    // would also block; we exercise the JS-level validator by querying
    // the form noValidate fallback path).
    const form = screen.getByRole("form", { name: /create user/i });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument());
    expect(api.createUser).not.toHaveBeenCalled();
  });

  it("surfaces server error_description from a 409 conflict", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home"]);
    vi.mocked(api.createUser).mockRejectedValue(
      new api.HttpError(409, 'username "alice" is already in use'),
    );
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /create user/i }));
    fireEvent.change(screen.getByLabelText(/username/i, { selector: "#new-user-username" }), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "alice-strong-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create user$/i }));
    await waitFor(() => expect(screen.getByText(/create failed \(409\)/i)).toBeInTheDocument());
  });
});

describe("Users — multi-vault membership (Phase 2 PR 2)", () => {
  it("renders multiple assigned vaults as separate code chips in the row", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([
      user("operator"),
      user("alice", { assigned_vaults: ["personal", "family"] }),
    ]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["personal", "family"]);
    renderRoute();
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    // Both vault names appear as <code> chips in the alice row.
    const aliceRow = screen.getByText("alice").closest("tr");
    expect(aliceRow).not.toBeNull();
    expect(within(aliceRow!).getByText("personal")).toBeInTheDocument();
    expect(within(aliceRow!).getByText("family")).toBeInTheDocument();
  });

  it("disables Edit vaults for the first admin with a /design/ tooltip", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home"]);
    renderRoute();
    const operatorBtn = await screen.findByRole("button", { name: /edit vaults for operator/i });
    expect(operatorBtn).toBeDisabled();
    expect(operatorBtn).toHaveAttribute("title", expect.stringMatching(/unrestricted by design/i));
    const aliceBtn = screen.getByRole("button", { name: /edit vaults for alice/i });
    expect(aliceBtn).not.toBeDisabled();
  });

  it("clicking Edit vaults reveals an inline multi-select pre-populated with current vaults", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([
      user("operator"),
      user("alice", { assigned_vaults: ["home"] }),
    ]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home", "work"]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /edit vaults for alice/i }));
    const select = (await screen.findByLabelText(
      /vault assignments for alice/i,
    )) as HTMLSelectElement;
    expect(select.multiple).toBe(true);
    const selected = Array.from(select.selectedOptions).map((o) => o.value);
    expect(selected).toEqual(["home"]);
    // Available options match the listUserVaults set.
    const optionTexts = Array.from(select.options).map((o) => o.value);
    expect(optionTexts).toEqual(["home", "work"]);
  });

  it("happy path — PATCHes new vault list, shows success banner, refreshes the list", async () => {
    const listMock = vi.mocked(api.listUsers);
    listMock.mockResolvedValueOnce([
      user("operator"),
      user("alice", { assigned_vaults: ["home"] }),
    ]);
    listMock.mockResolvedValueOnce([
      user("operator"),
      user("alice", { assigned_vaults: ["home", "work"] }),
    ]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home", "work"]);
    vi.mocked(api.updateUserVaults).mockResolvedValue();
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /edit vaults for alice/i }));
    const select = (await screen.findByLabelText(
      /vault assignments for alice/i,
    )) as HTMLSelectElement;
    // Add "work" — keep "home" selected.
    const workOption = Array.from(select.options).find((o) => o.value === "work");
    if (workOption) workOption.selected = true;
    fireEvent.change(select);
    fireEvent.click(screen.getByRole("button", { name: /save vault assignments/i }));
    await waitFor(() =>
      expect(api.updateUserVaults).toHaveBeenCalledWith(
        "id-alice",
        expect.arrayContaining(["home", "work"]),
      ),
    );
    // Success banner copy.
    await waitFor(() => expect(screen.getByText(/vault assignments updated/i)).toBeInTheDocument());
    await waitFor(() => expect(api.listUsers).toHaveBeenCalledTimes(2));
  });

  it("surfaces server error_description from a 400 assigned_vault_not_found", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([
      user("operator"),
      user("alice", { assigned_vaults: ["home"] }),
    ]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home", "work"]);
    vi.mocked(api.updateUserVaults).mockRejectedValue(
      new api.HttpError(400, 'vault "ghost" not registered'),
    );
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /edit vaults for alice/i }));
    await screen.findByLabelText(/vault assignments for alice/i);
    fireEvent.click(screen.getByRole("button", { name: /save vault assignments/i }));
    await waitFor(() =>
      expect(screen.getByText(/edit vaults failed \(400\)/i)).toBeInTheDocument(),
    );
  });

  it("Cancel closes the inline edit form without posting", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator"), user("alice")]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home"]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /edit vaults for alice/i }));
    expect(await screen.findByLabelText(/vault assignments for alice/i)).toBeInTheDocument();
    const form = screen.getByRole("form", { name: /edit vaults for alice/i });
    fireEvent.click(within(form).getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByLabelText(/vault assignments for alice/i)).toBeNull());
    expect(api.updateUserVaults).not.toHaveBeenCalled();
  });
});

describe("Users — sign-in handoff URL (onboarding discoverability)", () => {
  it("create-user success banner surfaces <hub-origin>/login with the username", async () => {
    const listMock = vi.mocked(api.listUsers);
    listMock.mockResolvedValueOnce([user("operator")]);
    listMock.mockResolvedValueOnce([
      user("operator"),
      user("alice", { password_changed: false, assigned_vaults: ["home"] }),
    ]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home"]);
    vi.mocked(api.getHubOriginSetting).mockResolvedValue({
      hub_origin: "https://hub.example.com",
      resolved_issuer: "https://hub.example.com",
      source: "settings",
    });
    vi.mocked(api.createUser).mockResolvedValue(
      user("alice", { password_changed: false, assigned_vaults: ["home"] }),
    );
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /create user/i }));
    fireEvent.change(screen.getByLabelText(/username/i, { selector: "#new-user-username" }), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "alice-strong-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create user$/i }));
    // Scope to the success banner (<output>) so the assertion doesn't
    // accidentally match the page-level intro prose, which also mentions
    // the sign-in URL.
    await waitFor(() =>
      expect(screen.getByText(/prompted to change their password/i)).toBeInTheDocument(),
    );
    const banner = screen.getByText(/prompted to change their password/i).closest("output");
    expect(banner).not.toBeNull();
    // The concrete <hub-origin>/login URL + the username are both in the banner.
    expect(within(banner!).getByText("https://hub.example.com/login")).toBeInTheDocument();
    expect(banner?.textContent).toMatch(/send them to/i);
    expect(banner?.textContent).toContain("alice");
  });

  it("reset-password success banner surfaces <hub-origin>/login with the username", async () => {
    const listMock = vi.mocked(api.listUsers);
    listMock.mockResolvedValueOnce([user("operator"), user("alice")]);
    listMock.mockResolvedValueOnce([user("operator"), user("alice", { password_changed: false })]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.getHubOriginSetting).mockResolvedValue({
      hub_origin: null,
      resolved_issuer: "https://my-hub.tailnet.ts.net",
      source: "request",
    });
    vi.mocked(api.resetUserPassword).mockResolvedValue({ revocationLagSeconds: 60 });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /reset password for alice/i }));
    fireEvent.change(screen.getByLabelText(/new temporary password for alice/i), {
      target: { value: "new-temp-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set new password/i }));
    await waitFor(() => expect(screen.getByText(/password reset for/i)).toBeInTheDocument());
    const banner = screen.getByText(/password reset for/i).closest("output");
    expect(banner).not.toBeNull();
    // resolved_issuer (request-origin precedence) drives the URL when no
    // operator-set hub_origin is stored.
    expect(within(banner!).getByText("https://my-hub.tailnet.ts.net/login")).toBeInTheDocument();
    expect(banner?.textContent).toMatch(/send them to/i);
    expect(banner?.textContent).toContain("alice");
  });

  it("trims a trailing slash from resolved_issuer before building the login URL", async () => {
    const listMock = vi.mocked(api.listUsers);
    listMock.mockResolvedValueOnce([user("operator")]);
    listMock.mockResolvedValueOnce([user("operator"), user("alice", { password_changed: false })]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.getHubOriginSetting).mockResolvedValue({
      hub_origin: "https://hub.example.com/",
      resolved_issuer: "https://hub.example.com/",
      source: "settings",
    });
    vi.mocked(api.createUser).mockResolvedValue(user("alice", { password_changed: false }));
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /create user/i }));
    fireEvent.change(screen.getByLabelText(/username/i, { selector: "#new-user-username" }), {
      target: { value: "alice" },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "alice-strong-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create user$/i }));
    await waitFor(() =>
      expect(screen.getByText(/prompted to change their password/i)).toBeInTheDocument(),
    );
    const banner = screen.getByText(/prompted to change their password/i).closest("output");
    // No double slash — the loader trims the trailing slash.
    expect(within(banner!).getByText("https://hub.example.com/login")).toBeInTheDocument();
  });
});

describe("Users — email + role columns (B5)", () => {
  it("renders the captured email as a mailto link and admin/member roles", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([
      user("operator", { email: null }),
      user("alice", { email: "alice@example.com" }),
    ]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    renderRoute();
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    // Email surfaced as a mailto link.
    const mail = screen.getByText("alice@example.com");
    expect(mail).toHaveAttribute("href", "mailto:alice@example.com");
    // First admin → "admin" badge; the second user → "member".
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByText("member")).toBeInTheDocument();
  });
});

describe("Users — vault caps section (B5)", () => {
  it("lists vaults with human-readable caps + uncapped placeholder", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.listVaultCaps).mockResolvedValue([
      {
        vault_name: "beta",
        cap_bytes: 1024 * 1024 * 1024,
        created_at: "2026-06-20T00:00:00.000Z",
        updated_at: "2026-06-21T00:00:00.000Z",
      },
      { vault_name: "personal", cap_bytes: null, created_at: null, updated_at: null },
    ]);
    renderRoute();
    // Wait for the cap row itself (the section renders in a loading state
    // first, then resolves its own listVaultCaps fetch).
    const betaCell = await screen.findByTestId("vault-cap-beta");
    // 1 GiB renders as "1.0 GB" via formatBytes.
    expect(within(betaCell).getByText("1.0 GB")).toBeInTheDocument();
    // No cap → "uncapped".
    expect(
      within(screen.getByTestId("vault-cap-personal")).getByText("uncapped"),
    ).toBeInTheDocument();
  });

  it("edits a cap → PUTs bytes and reloads", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.listVaultCaps).mockResolvedValue([
      { vault_name: "beta", cap_bytes: null, created_at: null, updated_at: null },
    ]);
    vi.mocked(api.setVaultCap).mockResolvedValue({
      vault_name: "beta",
      cap_bytes: 2 * 1024 * 1024 * 1024,
      created_at: "2026-06-25T00:00:00.000Z",
      updated_at: "2026-06-25T00:00:00.000Z",
    });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /edit cap for beta/i }));
    fireEvent.change(screen.getByLabelText(/cap for/i, { selector: "#cap-input-beta" }), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save cap/i }));
    await waitFor(() =>
      expect(api.setVaultCap).toHaveBeenCalledWith("beta", 2 * 1024 * 1024 * 1024),
    );
  });

  it("rejects a non-positive cap client-side without calling the API", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.listVaultCaps).mockResolvedValue([
      { vault_name: "beta", cap_bytes: null, created_at: null, updated_at: null },
    ]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /edit cap for beta/i }));
    fireEvent.change(screen.getByLabelText(/cap for/i, { selector: "#cap-input-beta" }), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save cap/i }));
    await waitFor(() =>
      expect(screen.getByText(/cap must be a positive number/i)).toBeInTheDocument(),
    );
    expect(api.setVaultCap).not.toHaveBeenCalled();
  });
});
