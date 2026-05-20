/**
 * Users route smoke tests — loading, list with sample data,
 * empty state, create-form happy path + client-side validation,
 * delete confirm flow, first-admin Delete disabled with tooltip,
 * load error.
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
      <Users />
    </MemoryRouter>,
  );
}

function user(username: string, overrides: Partial<api.UserListing> = {}): api.UserListing {
  return {
    id: `id-${username}`,
    username,
    password_changed: true,
    assigned_vault: null,
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
      user("operator", { password_changed: true, assigned_vault: null }),
      user("alice", { password_changed: false, assigned_vault: "home" }),
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
    // assigned_vault: null renders as em-dash.
    expect(screen.getByText("—")).toBeInTheDocument();
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

  it("confirm Delete calls deleteUser and refreshes the list", async () => {
    const listMock = vi.mocked(api.listUsers);
    listMock.mockResolvedValueOnce([user("operator"), user("alice")]);
    listMock.mockResolvedValueOnce([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue([]);
    vi.mocked(api.deleteUser).mockResolvedValue();
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /delete alice/i }));
    const dialog = screen.getByRole("dialog", { name: /confirm delete alice/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(api.deleteUser).toHaveBeenCalledWith("id-alice"));
    // alice gone after refresh.
    await waitFor(() => expect(screen.queryByText("alice")).toBeNull());
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

describe("Users — create form", () => {
  it("hides the form behind a Create User button by default", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home"]);
    renderRoute();
    expect(await screen.findByRole("button", { name: /create user/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^password/i)).toBeNull();
  });

  it("clicking Create User reveals the form with vault dropdown + No restriction option", async () => {
    vi.mocked(api.listUsers).mockResolvedValue([user("operator")]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home", "work"]);
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /create user/i }));
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
    const select = screen.getByLabelText(/assigned vault/i) as HTMLSelectElement;
    const optionTexts = Array.from(select.options).map((o) => o.text);
    expect(optionTexts).toEqual(["No restriction (admin-level access)", "home", "work"]);
  });

  it("submits createUser with the assigned vault and refreshes the list on success", async () => {
    const listMock = vi.mocked(api.listUsers);
    listMock.mockResolvedValueOnce([user("operator")]);
    listMock.mockResolvedValueOnce([
      user("operator"),
      user("alice", { password_changed: false, assigned_vault: "home" }),
    ]);
    vi.mocked(api.listUserVaults).mockResolvedValue(["home"]);
    vi.mocked(api.createUser).mockResolvedValue(
      user("alice", { password_changed: false, assigned_vault: "home" }),
    );
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /create user/i }));
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "alice-strong-passphrase" },
    });
    fireEvent.change(screen.getByLabelText(/assigned vault/i), { target: { value: "home" } });
    fireEvent.click(screen.getByRole("button", { name: /^create user$/i }));
    await waitFor(() =>
      expect(api.createUser).toHaveBeenCalledWith({
        username: "alice",
        password: "alice-strong-passphrase",
        assignedVault: "home",
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
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alice" } });
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
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: "alice-strong-passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create user$/i }));
    await waitFor(() => expect(screen.getByText(/create failed \(409\)/i)).toBeInTheDocument());
  });
});
