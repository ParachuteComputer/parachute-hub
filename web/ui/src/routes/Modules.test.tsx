/**
 * Modules route smoke tests — catalog rendering, status badges,
 * install kick-off + op polling → terminal, restart/uninstall sync
 * paths, supervisor-unavailable disabled state.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Modules } from "./Modules.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listModules: vi.fn(),
    installModule: vi.fn(),
    restartModule: vi.fn(),
    upgradeModule: vi.fn(),
    uninstallModule: vi.fn(),
    getModuleOperation: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderRoute() {
  return render(
    <MemoryRouter>
      <Modules />
    </MemoryRouter>,
  );
}

function moduleRow(short: string, overrides: Partial<api.ModuleListing> = {}): api.ModuleListing {
  return {
    short,
    package: `@openparachute/${short}`,
    display_name: short.charAt(0).toUpperCase() + short.slice(1),
    tagline: `the ${short} module`,
    available: true,
    installed: false,
    installed_version: null,
    latest_version: "1.0.0",
    supervisor_status: null,
    pid: null,
    install_dir: null,
    ...overrides,
  };
}

describe("Modules — catalog rendering", () => {
  it("shows a loading state on first paint", () => {
    vi.mocked(api.listModules).mockImplementation(() => new Promise(() => {}));
    renderRoute();
    expect(screen.getByText(/loading modules/i)).toBeInTheDocument();
  });

  it("renders one row per module with display name + tagline", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [moduleRow("vault"), moduleRow("notes"), moduleRow("scribe")],
      supervisor_available: true,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getByText("Scribe")).toBeInTheDocument();
    // Tagline copy from the listing flows through to the row.
    expect(screen.getByText("the vault module")).toBeInTheDocument();
  });

  it("badges 'not installed' for available-but-uninstalled rows", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [moduleRow("vault")],
      supervisor_available: true,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    expect(screen.getByText(/not installed/i)).toBeInTheDocument();
  });

  it("shows 'Running' badge + installed version for an installed+running row", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          supervisor_status: "running",
          pid: 9876,
        }),
      ],
      supervisor_available: true,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    expect(screen.getByText("v0.4.5")).toBeInTheDocument();
  });
});

describe("Modules — supervisor unavailable", () => {
  it("disables actions + shows the CLI-mode banner", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          supervisor_status: null,
        }),
      ],
      supervisor_available: false,
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    // CLI-mode banner copy.
    expect(screen.getByText(/parachute serve/)).toBeInTheDocument();
    // Restart button present but disabled.
    const restartBtn = screen.getByRole("button", { name: /restart/i });
    expect(restartBtn).toBeDisabled();
  });
});

describe("Modules — install flow", () => {
  it("kicks off install and starts polling the operation", async () => {
    // Real timers — we just want to observe the kick-off and the poll
    // wiring. End-to-end poll → terminal → refresh is covered by the
    // server-side api-modules-ops tests; here we verify the SPA wires
    // installModule + getModuleOperation correctly.
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [moduleRow("vault")],
      supervisor_available: true,
    });
    vi.mocked(api.installModule).mockResolvedValue("op-abc");
    vi.mocked(api.getModuleOperation).mockResolvedValue({
      id: "op-abc",
      kind: "install",
      short: "vault",
      status: "running",
      log: ["running bun add"],
      startedAt: "2026-05-18T00:00:00Z",
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /install/i }));

    await waitFor(() => expect(api.installModule).toHaveBeenCalledWith("vault"));
    // Poll fires within ~1s — give waitFor 2s to be safe.
    await waitFor(() => expect(api.getModuleOperation).toHaveBeenCalledWith("op-abc"), {
      timeout: 2000,
    });
  });
});

describe("Modules — restart sync flow", () => {
  it("calls restartModule then refreshes catalog", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          supervisor_status: "running",
        }),
      ],
      supervisor_available: true,
    });
    vi.mocked(api.restartModule).mockResolvedValue({ short: "vault" });

    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /restart/i }));
    await waitFor(() => expect(api.restartModule).toHaveBeenCalledWith("vault"));
    await waitFor(() => expect(api.listModules).toHaveBeenCalledTimes(2));
  });

  it("surfaces an inline error on restart failure", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          supervisor_status: "running",
        }),
      ],
      supervisor_available: true,
    });
    vi.mocked(api.restartModule).mockRejectedValue(
      new api.HttpError(503, "supervisor_unavailable"),
    );

    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /restart/i }));
    await waitFor(() => expect(screen.getByText(/supervisor_unavailable/)).toBeInTheDocument());
  });
});

describe("Modules — uninstall sync flow", () => {
  it("confirms then calls uninstallModule", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          supervisor_status: "running",
        }),
      ],
      supervisor_available: true,
    });
    vi.mocked(api.uninstallModule).mockResolvedValue({ short: "vault" });
    // Auto-confirm the window.confirm dialog so the uninstall fires.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /uninstall/i }));
    await waitFor(() => expect(api.uninstallModule).toHaveBeenCalledWith("vault"));
    confirmSpy.mockRestore();
  });

  it("does not call uninstallModule when the operator cancels confirm", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          supervisor_status: "running",
        }),
      ],
      supervisor_available: true,
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /uninstall/i }));
    // Give the click handler a tick.
    await Promise.resolve();
    expect(api.uninstallModule).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
