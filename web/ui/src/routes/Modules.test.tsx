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
    uis: [],
    management_url: null,
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

  it("shows 'active' badge + installed version for an installed+running row", async () => {
    // Post-workstream-F: the module-row status badge collapses the
    // supervisor's `running` lifecycle onto the unified `active` state
    // (design-system.md §6). Pre-F the badge text was the raw supervisor
    // status (`running`); the new vocab is shared with the CLI's
    // `parachute status` and the well-known doc.
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
    const badge = screen.getByTestId("module-status-vault");
    expect(badge).toHaveTextContent("active");
    expect(badge).toHaveClass("status-active");
    expect(screen.getByText("v0.4.5")).toBeInTheDocument();
  });

  it("maps supervisor lifecycle states onto the unified four-state vocab (workstream F)", async () => {
    // Pins design-system.md §6 mapping at the SPA boundary:
    //   running                → active
    //   starting / restarting  → pending (transient)
    //   crashed                → failing
    //   stopped                → inactive
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", { installed: true, supervisor_status: "running" }),
        moduleRow("notes", { installed: true, supervisor_status: "starting" }),
        moduleRow("scribe", { installed: true, supervisor_status: "crashed" }),
        moduleRow("app", { installed: true, supervisor_status: "stopped" }),
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("module-status-vault")).toBeInTheDocument());
    expect(screen.getByTestId("module-status-vault")).toHaveClass("status-active");
    expect(screen.getByTestId("module-status-notes")).toHaveClass("status-pending");
    expect(screen.getByTestId("module-status-scribe")).toHaveClass("status-failing");
    expect(screen.getByTestId("module-status-app")).toHaveClass("status-inactive");
  });
});

describe("Modules — Open button (hub#342)", () => {
  it("renders an active <a> when management_url is set", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          supervisor_status: "running",
          management_url: "/vault/default/admin",
        }),
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    const open = screen.getByTestId("open-vault");
    expect(open.tagName).toBe("A");
    expect(open.getAttribute("href")).toBe("/vault/default/admin");
  });

  it("renders a disabled button with a follow-up tooltip when management_url is null", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("scribe", {
          installed: true,
          installed_version: "0.1.0",
          latest_version: "0.1.0",
          supervisor_status: "running",
          management_url: null,
        }),
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Scribe")).toBeInTheDocument());
    const open = screen.getByTestId("open-scribe");
    expect(open.tagName).toBe("BUTTON");
    expect(open).toBeDisabled();
    expect(open.getAttribute("title")).toContain("scribe#53");
  });

  it("does not render the Configure link anymore (it was collapsed into Open)", async () => {
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        moduleRow("vault", {
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          supervisor_status: "running",
          management_url: "/vault/default/admin",
        }),
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    // Pre-#342 had a "Configure" link under the actions row. Post-#342
    // has only "Open" (and Restart / Upgrade / Uninstall).
    expect(screen.queryByText(/^Configure$/)).toBeNull();
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

// Hierarchical sub-units (hub#313). Installed module rows render an
// expandable "Hosted UIs" section per sub-unit when `uis` is non-empty.
// Empty (the default for vault / notes / scribe / runner) suppresses the
// section entirely.
describe("Modules — hierarchical sub-units (hub#313)", () => {
  function makeUi(overrides: Partial<api.ModuleUiSubUnit>): api.ModuleUiSubUnit {
    return {
      name: "gitcoin-brain",
      display_name: "Gitcoin Brain",
      path: "/app/gitcoin-brain",
      tagline: null,
      icon_url: null,
      version: null,
      oauth_client_id: null,
      status: null,
      ...overrides,
    };
  }

  it("does not render the Hosted UIs section when uis is empty", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({
        modules: [
          moduleRow("vault", {
            installed: true,
            installed_version: "0.4.5",
            latest_version: "0.4.5",
            supervisor_status: "running",
            uis: [],
          }),
        ],
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByText("Vault")).toBeInTheDocument());
    expect(screen.queryByTestId("module-uis")).not.toBeInTheDocument();
  });

  it("renders the Hosted UIs section with one row per sub-unit", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({
        modules: [
          moduleRow("vault", {
            display_name: "App",
            installed: true,
            installed_version: "0.1.0",
            latest_version: "0.1.0",
            supervisor_status: "running",
            uis: [
              makeUi({
                name: "gitcoin-brain",
                display_name: "Gitcoin Brain",
                path: "/app/gitcoin-brain",
                tagline: "Reading room for the Gitcoin team",
                status: "active",
              }),
              makeUi({
                name: "unforced-brain",
                display_name: "Unforced Brain",
                path: "/app/unforced-brain",
                status: "pending-oauth",
              }),
            ],
          }),
        ],
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByText("App")).toBeInTheDocument());
    const section = screen.getByTestId("module-uis");
    expect(within(section).getByText("Gitcoin Brain")).toBeInTheDocument();
    expect(within(section).getByText("Unforced Brain")).toBeInTheDocument();
    // Tagline rides through verbatim.
    expect(within(section).getByText("Reading room for the Gitcoin team")).toBeInTheDocument();
    // Path is rendered as a same-origin anchor (the sub-unit lives outside
    // the SPA's basename — see UiSubUnitsList comment for the rationale).
    const link = within(section).getByText("Gitcoin Brain").closest("a");
    expect(link?.getAttribute("href")).toBe("/app/gitcoin-brain");
  });

  it("renders per-sub-unit status badges using the unified four-state vocab (workstream F)", async () => {
    // Post-F: sub-unit badges use the canonical
    // `active | pending | inactive | failing` classes shared with the
    // module-row supervisor badge and the CLI. Legacy `pending-oauth` /
    // `disabled` values served from a not-yet-restarted older module are
    // normalized at render time (the test below pins that path).
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({
        modules: [
          moduleRow("vault", {
            installed: true,
            installed_version: "0.1.0",
            latest_version: "0.1.0",
            supervisor_status: "running",
            uis: [
              makeUi({ name: "a", display_name: "A", status: "active" }),
              makeUi({ name: "b", display_name: "B", status: "pending" }),
              makeUi({ name: "c", display_name: "C", status: "inactive" }),
              makeUi({ name: "d", display_name: "D", status: null }),
              makeUi({ name: "e", display_name: "E", status: "failing" }),
            ],
          }),
        ],
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("module-uis")).toBeInTheDocument());
    expect(screen.getByTestId("ui-status-a")).toHaveClass("status-active");
    expect(screen.getByTestId("ui-status-b")).toHaveClass("status-pending");
    expect(screen.getByTestId("ui-status-c")).toHaveClass("status-inactive");
    // Null status falls back to "active" — same default as discovery.
    expect(screen.getByTestId("ui-status-d")).toHaveClass("status-active");
    expect(screen.getByTestId("ui-status-e")).toHaveClass("status-failing");
  });

  it("normalizes legacy `pending-oauth` / `disabled` sub-unit statuses at render time (workstream F back-compat)", async () => {
    // Pins the back-compat alias path. Storage normalizes on read but
    // the SPA can still receive legacy values from /api/modules if a
    // module wrote them and the row was cached before workstream F's
    // services-manifest fold landed. `unifiedStateForUi` covers that
    // gap so the badge palette stays consistent across the rollout.
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({
        modules: [
          moduleRow("vault", {
            installed: true,
            installed_version: "0.1.0",
            latest_version: "0.1.0",
            supervisor_status: "running",
            uis: [
              makeUi({ name: "legacy-p", display_name: "Legacy P", status: "pending-oauth" }),
              makeUi({ name: "legacy-d", display_name: "Legacy D", status: "disabled" }),
            ],
          }),
        ],
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("module-uis")).toBeInTheDocument());
    expect(screen.getByTestId("ui-status-legacy-p")).toHaveClass("status-pending");
    expect(screen.getByTestId("ui-status-legacy-d")).toHaveClass("status-inactive");
  });

  it("renders the icon when icon_url is present, skips it when absent", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({
        modules: [
          moduleRow("vault", {
            installed: true,
            installed_version: "0.1.0",
            latest_version: "0.1.0",
            supervisor_status: "running",
            uis: [
              makeUi({
                name: "with-icon",
                display_name: "With Icon",
                icon_url: "/app/with-icon/icon.svg",
              }),
              makeUi({ name: "no-icon", display_name: "No Icon", icon_url: null }),
            ],
          }),
        ],
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("module-uis")).toBeInTheDocument());
    const section = screen.getByTestId("module-uis");
    // The icon <img alt=""> is presentational (per a11y conventions for
    // decorative images), so getByRole("img") wouldn't match. Query via
    // the .ui-icon class instead — same class the component renders.
    const imgs = section.querySelectorAll("img.ui-icon");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]?.getAttribute("src")).toBe("/app/with-icon/icon.svg");
  });

  it("shows the sub-unit count in the section summary", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog({
        modules: [
          moduleRow("vault", {
            installed: true,
            installed_version: "0.1.0",
            latest_version: "0.1.0",
            supervisor_status: "running",
            uis: [
              makeUi({ name: "a", display_name: "A" }),
              makeUi({ name: "b", display_name: "B" }),
              makeUi({ name: "c", display_name: "C" }),
            ],
          }),
        ],
      }),
    );
    renderRoute();
    await waitFor(() => expect(screen.getByTestId("module-uis")).toBeInTheDocument());
    expect(screen.getByText(/\(3\)/)).toBeInTheDocument();
  });
});
