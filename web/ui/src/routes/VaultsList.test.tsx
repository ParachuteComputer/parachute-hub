/**
 * VaultsList smoke tests — loading → ok / empty / error.
 *
 * We mock `../lib/api.ts` to control the well-known fetch shape. The
 * router wrapper is MemoryRouter — react-router uses the same context
 * regardless of the basename, and we don't care about URLs here.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { VaultsList } from "./VaultsList.tsx";

vi.mock("../lib/api.ts", () => ({
  listVaults: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderList() {
  return render(
    <MemoryRouter>
      <VaultsList />
    </MemoryRouter>,
  );
}

describe("VaultsList", () => {
  it("renders empty state with a 'Create a vault' link when no vaults", async () => {
    vi.mocked(api.listVaults).mockResolvedValue([]);
    renderList();
    await waitFor(() => expect(screen.getByText(/no vaults yet/i)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /create a vault/i })).toHaveAttribute(
      "href",
      "/vaults/new",
    );
  });

  it("renders one row per vault with name + version + URL", async () => {
    vi.mocked(api.listVaults).mockResolvedValue([
      {
        name: "work",
        url: "http://hub.local/vault/work/",
        version: "0.5.1",
        path: "/vault/work",
      },
      {
        name: "scratch",
        url: "http://hub.local/vault/scratch/",
        version: "0.5.1",
        path: "/vault/scratch",
      },
    ]);
    renderList();
    await waitFor(() => expect(screen.getByText(/Vaults \(2\)/)).toBeInTheDocument());
    expect(screen.getByText("work")).toBeInTheDocument();
    expect(screen.getByText("scratch")).toBeInTheDocument();
    expect(screen.getAllByText(/v0\.5\.1/)).toHaveLength(2);
  });

  it("renders the error banner + retry button on failure", async () => {
    vi.mocked(api.listVaults).mockRejectedValue(new Error("network down"));
    renderList();
    await waitFor(() => expect(screen.getByText(/couldn't load vaults/i)).toBeInTheDocument());
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
