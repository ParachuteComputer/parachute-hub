/**
 * NewVault smoke tests — validation, submit, single-emit token banner.
 *
 * We mock `../lib/api.ts:createVault` so the form's submit path is
 * exercised without touching the wire. The token banner is the
 * single-emit surface — once it renders, the operator must dismiss
 * before the navigate fires.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { NewVault } from "./NewVault.tsx";

vi.mock("../lib/api.ts", async () => {
  const actual = await vi.importActual<typeof api>("../lib/api.ts");
  return {
    ...actual,
    createVault: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderForm() {
  return render(
    <MemoryRouter initialEntries={["/vaults/new"]}>
      <Routes>
        <Route path="/vaults/new" element={<NewVault />} />
        <Route path="/vaults/:name" element={<div>detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("NewVault", () => {
  it("disables submit until a valid name is entered", async () => {
    renderForm();
    const user = userEvent.setup();
    const input = screen.getByLabelText(/vault name/i);
    const submit = screen.getByRole("button", { name: /create vault/i });

    expect(submit).toBeDisabled();
    await user.type(input, "work!");
    expect(
      screen.getByText(/letters, numbers, hyphens, and underscores only/i),
    ).toBeInTheDocument();
    expect(submit).toBeDisabled();

    await user.clear(input);
    await user.type(input, "work");
    expect(submit).toBeEnabled();
  });

  it("rejects 'list' as a reserved name", async () => {
    renderForm();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/vault name/i), "list");
    expect(screen.getByText(/reserved name/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create vault/i })).toBeDisabled();
  });

  it("renders the single-emit token banner on a 201 with token", async () => {
    vi.mocked(api.createVault).mockResolvedValue({
      name: "work",
      url: "http://hub.local/vault/work/",
      version: "0.5.1",
      token: "pvt_abc123secret",
      paths: {
        vault_dir: "/home/u/.parachute/vault/work",
        vault_db: "/home/u/.parachute/vault/work/vault.db",
        vault_config: "/home/u/.parachute/vault/work/config.yaml",
      },
    });
    renderForm();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/vault name/i), "work");
    await user.click(screen.getByRole("button", { name: /create vault/i }));

    await waitFor(() =>
      expect(screen.getByText(/your vault token \(shown once\)/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("pvt_abc123secret")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /done/i })).toBeInTheDocument();
    expect(screen.getByText(/vault\.db/)).toBeInTheDocument();
  });

  it("renders the no-token branch on idempotent re-POST (200)", async () => {
    vi.mocked(api.createVault).mockResolvedValue({
      name: "work",
      url: "http://hub.local/vault/work/",
      version: "0.5.1",
    });
    renderForm();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/vault name/i), "work");
    await user.click(screen.getByRole("button", { name: /create vault/i }));

    await waitFor(() => expect(screen.getByText(/already existed/i)).toBeInTheDocument());
    expect(screen.queryByText(/shown once/i)).not.toBeInTheDocument();
  });

  it("surfaces the API error_description on failure", async () => {
    const { HttpError } = await import("../lib/api.ts");
    vi.mocked(api.createVault).mockRejectedValue(
      new HttpError(400, "vault name must contain only letters, numbers, hyphens"),
    );
    renderForm();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/vault name/i), "work");
    await user.click(screen.getByRole("button", { name: /create vault/i }));

    await waitFor(() => expect(screen.getByText(/couldn't create vault/i)).toBeInTheDocument());
    expect(screen.getByText(/400: vault name must contain/i)).toBeInTheDocument();
  });
});
