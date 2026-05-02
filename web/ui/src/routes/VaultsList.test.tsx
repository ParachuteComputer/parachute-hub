/**
 * VaultsList smoke tests — loading → ok / empty / error, plus the
 * managementUrl-driven Manage button behaviour (mint + redirect, mint
 * failure surfacing, "CLI only" stub when the vault doesn't declare
 * a management URL).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { VaultsList } from "./VaultsList.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listVaults: vi.fn(),
    mintVaultAdminToken: vi.fn(),
  };
});

let assignSpy: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  assignSpy = vi.fn<(url: string | URL) => void>();
  // jsdom locks individual Location members non-configurable, so we swap
  // the whole `window.location` slot — that property *is* configurable.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, assign: assignSpy },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
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

  it("renders a 'CLI only' marker when the vault has no managementUrl", async () => {
    vi.mocked(api.listVaults).mockResolvedValue([
      {
        name: "legacy",
        url: "http://hub.local/vault/legacy/",
        version: "0.4.0",
        path: "/vault/legacy",
      },
    ]);
    renderList();
    await waitFor(() => expect(screen.getByText("legacy")).toBeInTheDocument());
    expect(screen.getByText(/cli only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage vault legacy/i })).toBeNull();
  });

  it("renders a Manage button when managementUrl is present and mints + redirects on click", async () => {
    vi.mocked(api.listVaults).mockResolvedValue([
      {
        name: "work",
        url: "http://hub.local/vault/work/",
        version: "0.5.1",
        path: "/vault/work",
        managementUrl: "/admin",
      },
    ]);
    vi.mocked(api.mintVaultAdminToken).mockResolvedValue({
      token: "jwt-abc",
      expiresAt: "2026-01-01T00:00:00.000Z",
      scopes: ["vault:work:admin"],
    });
    renderList();
    const btn = await screen.findByRole("button", { name: /manage vault work/i });
    fireEvent.click(btn);
    await waitFor(() => expect(api.mintVaultAdminToken).toHaveBeenCalledWith("work"));
    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith("http://hub.local/vault/work/admin#token=jwt-abc"),
    );
  });

  it("absolute managementUrl is used verbatim (not joined onto the vault URL)", async () => {
    vi.mocked(api.listVaults).mockResolvedValue([
      {
        name: "work",
        url: "http://hub.local/vault/work/",
        version: "0.5.1",
        path: "/vault/work",
        managementUrl: "https://elsewhere.example/manage",
      },
    ]);
    vi.mocked(api.mintVaultAdminToken).mockResolvedValue({
      token: "jwt-xyz",
      expiresAt: "2026-01-01T00:00:00.000Z",
      scopes: ["vault:work:admin"],
    });
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: /manage vault work/i }));
    await waitFor(() =>
      expect(assignSpy).toHaveBeenCalledWith("https://elsewhere.example/manage#token=jwt-xyz"),
    );
  });

  it("surfaces a per-row error banner when the mint fails (no redirect)", async () => {
    vi.mocked(api.listVaults).mockResolvedValue([
      {
        name: "work",
        url: "http://hub.local/vault/work/",
        version: "0.5.1",
        path: "/vault/work",
        managementUrl: "/admin",
      },
    ]);
    vi.mocked(api.mintVaultAdminToken).mockRejectedValue(
      new api.HttpError(401, "no admin session"),
    );
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: /manage vault work/i }));
    await waitFor(() =>
      expect(screen.getByText(/mint failed \(401\): no admin session/i)).toBeInTheDocument(),
    );
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
