/**
 * Modules route smoke tests — catalog rendering (two-section layout
 * for the hub#260 closeout: installed on top, available below), status
 * badges, install kick-off + op polling, restart/uninstall sync paths,
 * supervisor-unavailable disabled state, in-flight install hiding the
 * row until catalog refresh, install-channel toggle.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    setModuleChannel: vi.fn(),
  };
});

/** Build a catalog with the channel field defaulted; tests override. */
function makeCatalog(overrides: Partial<api.ModulesCatalog> = {}): api.ModulesCatalog {
  return {
    modules: [],
    supervisor_available: true,
    module_install_channel: "latest",
    ...overrides,
  };
}

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

  it("renders all modules under their respective section", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          supervisor_status: "running",
        }),
        moduleRow("notes"),
        moduleRow("scribe"),
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());

    const installed = screen.getByTestId("installed-section");
    const installable = screen.getByTestId("installable-section");
    // Vault sits under "Installed modules" because installed=true.
    expect(within(installed).getByText("Vault")).toBeInTheDocument();
    // Notes + Scribe sit under "Install a module" because installed=false.
    expect(within(installable).getByText("Notes")).toBeInTheDocument();
    expect(within(installable).getByText("Scribe")).toBeInTheDocument();
    // Cross-pollination check — taglines from the installable section
    // surface verbatim on the card.
    expect(within(installable).getByText("the notes module")).toBeInTheDocument();
  });

  it("renders the 'no modules installed' empty state when nothing is installed", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [moduleRow("vault"), moduleRow("notes"), moduleRow("scribe")],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    // Empty hint copy under "Installed modules".
    expect(screen.getByTestId("installed-empty")).toBeInTheDocument();
    // Three install cards under "Install a module".
    expect(within(screen.getByTestId("installable-section")).getAllByRole("button")).toHaveLength(
      3,
    );
  });

  it("renders the 'all installed' empty state when no installables remain", async () => {
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
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    // Empty hint copy under "Install a module".
    expect(screen.getByTestId("installable-empty")).toBeInTheDocument();
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
      module_install_channel: "latest",
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
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    // CLI-mode banner copy.
    expect(screen.getByText(/parachute serve/)).toBeInTheDocument();
    // Restart button present but disabled.
    const restartBtn = screen.getByRole("button", { name: /restart/i });
    expect(restartBtn).toBeDisabled();
  });

  it("disables the Install button on installable cards under CLI mode", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [moduleRow("vault")],
      supervisor_available: false,
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    // The install card's button is the only button rendered for an
    // uninstalled module — disabled because supervisor_available is false.
    const installBtn = within(screen.getByTestId("installable-section")).getByRole("button", {
      name: /install/i,
    });
    expect(installBtn).toBeDisabled();
  });
});

describe("Modules — install flow", () => {
  it("kicks off install from the Install a module section and starts polling", async () => {
    // Real timers — we just want to observe the kick-off and the poll
    // wiring. End-to-end poll → terminal → refresh is covered by the
    // server-side api-modules-ops tests; here we verify the SPA wires
    // installModule + getModuleOperation correctly.
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [moduleRow("vault")],
      supervisor_available: true,
      module_install_channel: "latest",
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

    // Click the Install button inside the install-card under the
    // "Install a module" section — not the generic by-role click,
    // which would also match buttons in other sections if they
    // ever grow an /install/i label.
    const installable = screen.getByTestId("installable-section");
    fireEvent.click(within(installable).getByRole("button", { name: /install/i }));

    await waitFor(() => expect(api.installModule).toHaveBeenCalledWith("vault"));
    // Poll fires within ~1s — give waitFor 2s to be safe.
    await waitFor(() => expect(api.getModuleOperation).toHaveBeenCalledWith("op-abc"), {
      timeout: 2000,
    });
  });

  it("hides the install card while the install op is pending (avoids duplicate spawn)", async () => {
    // Catalog still shows vault as not-installed (the install hasn't
    // completed + the catalog hasn't been re-fetched yet). The pending
    // op should suppress the install card to prevent a re-click that
    // would spawn a second op.
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [moduleRow("vault")],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    vi.mocked(api.installModule).mockResolvedValue("op-abc");
    // Keep the poll pending — we want to observe the in-flight state.
    vi.mocked(api.getModuleOperation).mockImplementation(() => new Promise(() => {}));

    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    const installable = screen.getByTestId("installable-section");
    fireEvent.click(within(installable).getByRole("button", { name: /install/i }));

    // After the click, the install card disappears (replaced by the
    // "Install in progress" empty hint) and the pending-ops banner
    // shows the in-flight op.
    await waitFor(() => expect(screen.getByTestId("installable-empty")).toBeInTheDocument());
    expect(screen.getByText(/install in progress/i)).toBeInTheDocument();
  });

  it("surfaces an inline error on the install card when installModule rejects", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [moduleRow("vault")],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    vi.mocked(api.installModule).mockRejectedValue(new api.HttpError(409, "module_busy"));

    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    fireEvent.click(
      within(screen.getByTestId("installable-section")).getByRole("button", { name: /install/i }),
    );
    await waitFor(() => expect(screen.getByText(/module_busy/)).toBeInTheDocument());
  });
});

describe("Modules — upgrade affordance", () => {
  it("shows 'Upgrade to vX' when installed_version < latest_version", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.5.0",
          supervisor_status: "running",
        }),
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    const upgradeBtn = screen.getByRole("button", { name: /upgrade to v0\.5\.0/i });
    expect(upgradeBtn).toBeInTheDocument();
    expect(upgradeBtn).not.toBeDisabled();
  });

  it("shows 'Up to date' (disabled) when installed_version == latest_version", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.5.0",
          latest_version: "0.5.0",
          supervisor_status: "running",
        }),
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    const upgradeBtn = screen.getByRole("button", { name: /up to date/i });
    expect(upgradeBtn).toBeInTheDocument();
    expect(upgradeBtn).toBeDisabled();
  });

  it("kicks off upgrade and starts polling the operation", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.5.0",
          supervisor_status: "running",
        }),
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    vi.mocked(api.upgradeModule).mockResolvedValue("op-up");
    vi.mocked(api.getModuleOperation).mockResolvedValue({
      id: "op-up",
      kind: "upgrade",
      short: "vault",
      status: "running",
      log: ["running bun add"],
      startedAt: "2026-05-18T00:00:00Z",
    });

    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /upgrade to v0\.5\.0/i }));

    await waitFor(() => expect(api.upgradeModule).toHaveBeenCalledWith("vault"));
    await waitFor(() => expect(api.getModuleOperation).toHaveBeenCalledWith("op-up"), {
      timeout: 2000,
    });
  });

  it("surfaces an inline error on upgrade when upgradeModule rejects", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.5.0",
          supervisor_status: "running",
        }),
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    vi.mocked(api.upgradeModule).mockRejectedValue(new api.HttpError(503, "registry_unreachable"));
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /upgrade to v0\.5\.0/i }));
    await waitFor(() => expect(screen.getByText(/registry_unreachable/)).toBeInTheDocument());
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
      module_install_channel: "latest",
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
      module_install_channel: "latest",
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
      module_install_channel: "latest",
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
      module_install_channel: "latest",
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

describe("Modules — install channel toggle (hub#275)", () => {
  it("renders 'Stable' selected when channel = latest", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({ modules: [moduleRow("vault")], module_install_channel: "latest" }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    const stable = screen.getByRole("radio", { name: /stable/i }) as HTMLInputElement;
    const rc = screen.getByRole("radio", { name: /release candidates/i }) as HTMLInputElement;
    expect(stable.checked).toBe(true);
    expect(rc.checked).toBe(false);
  });

  it("renders 'Release candidates' selected when channel = rc", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({ modules: [moduleRow("vault")], module_install_channel: "rc" }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    const stable = screen.getByRole("radio", { name: /stable/i }) as HTMLInputElement;
    const rc = screen.getByRole("radio", { name: /release candidates/i }) as HTMLInputElement;
    expect(stable.checked).toBe(false);
    expect(rc.checked).toBe(true);
  });

  it("posts to setModuleChannel and updates the UI on toggle to rc", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({ modules: [moduleRow("vault")], module_install_channel: "latest" }),
    );
    vi.mocked(api.setModuleChannel).mockResolvedValue("rc");

    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: /release candidates/i }));
    await waitFor(() => expect(api.setModuleChannel).toHaveBeenCalledWith("rc"));
    // After the round-trip, rc stays selected (server echoed rc).
    const rc = screen.getByRole("radio", { name: /release candidates/i }) as HTMLInputElement;
    await waitFor(() => expect(rc.checked).toBe(true));
  });

  it("rolls back to an error state when setModuleChannel fails", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({ modules: [moduleRow("vault")], module_install_channel: "latest" }),
    );
    vi.mocked(api.setModuleChannel).mockRejectedValue(
      new api.HttpError(500, "internal_server_error"),
    );

    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: /release candidates/i }));
    await waitFor(() => expect(screen.getByText(/Failed to update channel/i)).toBeInTheDocument());
  });

  it("does not POST when clicking the already-selected channel (no-op)", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({ modules: [moduleRow("vault")], module_install_channel: "latest" }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    // Click the already-selected Stable radio.
    fireEvent.click(screen.getByRole("radio", { name: /stable/i }));
    await Promise.resolve();
    expect(api.setModuleChannel).not.toHaveBeenCalled();
  });
});
