/**
 * Home route tests — Administer group (no /vaults card), Modules group
 * (vault card = in-shell Link to /vaults; non-vault module = off-shell <a>),
 * loading / error / empty states.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Home } from "./Home.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listModules: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

/** Build a full ModuleListing; tests override only what they need. */
function makeModule(short: string, overrides: Partial<api.ModuleListing> = {}): api.ModuleListing {
  return {
    short,
    package: `@openparachute/${short}`,
    display_name: short.charAt(0).toUpperCase() + short.slice(1),
    tagline: `the ${short} module`,
    focus: "core",
    available: true,
    installed: true,
    installed_version: "1.0.0",
    latest_version: "1.0.0",
    supervisor_status: "running",
    pid: 1234,
    install_dir: `/home/.parachute/${short}`,
    uis: [],
    management_url: null,
    config_ui_url: null,
    ...overrides,
  };
}

/** Build a catalog wrapping the given module list. */
function makeCatalog(modules: api.ModuleListing[]): api.ModulesCatalog {
  return {
    modules,
    supervisor_available: true,
    module_install_channel: "latest",
  };
}

function renderRoute() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Administer group
// ---------------------------------------------------------------------------

describe("Administer group", () => {
  it("renders without a /vaults card", async () => {
    vi.mocked(api.listModules).mockResolvedValue(makeCatalog([]));
    renderRoute();

    const administer = await screen.findByTestId("home-administer");
    // The Administer group must NOT contain a card linking to /vaults.
    const vaultsCard = administer.querySelector<HTMLElement>("[data-section='/vaults']");
    expect(vaultsCard).toBeNull();
  });

  it("renders the expected hub-native section cards", async () => {
    vi.mocked(api.listModules).mockResolvedValue(makeCatalog([]));
    renderRoute();

    const administer = await screen.findByTestId("home-administer");
    // These six sections should be present; /vaults should not.
    for (const path of ["/connections", "/modules", "/users", "/tokens", "/permissions", "/settings"]) {
      expect(administer.querySelector(`[data-section='${path}']`)).not.toBeNull();
    }
    expect(administer.querySelector("[data-section='/vaults']")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Modules group — vault card (in-shell)
// ---------------------------------------------------------------------------

describe("Modules group — vault card", () => {
  it("renders the vault module card as an in-shell <Link> to /vaults (not an <a>)", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { management_url: "http://vault.example.com/manage" })]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-vault");

    // Must be rendered as a <a> by react-router's Link (not a bare <a href>
    // pointing at an external URL). The Link renders as an <a> with an
    // href derived from the router basename — here "/vaults".
    expect(card.tagName).toBe("A");
    expect(card).toHaveAttribute("href", "/vaults");
  });

  it("vault card does NOT carry the external ↗ mark", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault")]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-vault");
    expect(card.querySelector(".ext-mark")).toBeNull();
  });

  it("vault card shows the in-shell caption", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault")]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-vault");
    expect(card.textContent).toContain("manage all vaults");
    expect(card.textContent).toContain("opens here");
  });

  it("vault card opens /vaults even when management_url is null", async () => {
    // Vault has no management_url but we still link in-shell.
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { management_url: null })]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-vault");
    expect(card).toHaveAttribute("href", "/vaults");
  });
});

// ---------------------------------------------------------------------------
// Modules group — non-vault module cards (off-shell)
// ---------------------------------------------------------------------------

describe("Modules group — non-vault module cards", () => {
  it("renders a non-vault module with a config_ui_url as an off-shell <a>", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([
        makeModule("scribe", { config_ui_url: "http://hub.example.com/scribe/admin" }),
      ]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-scribe");

    // Should be a plain <a> pointing at the external config URL.
    expect(card.tagName).toBe("A");
    expect(card).toHaveAttribute("href", "http://hub.example.com/scribe/admin");
  });

  it("non-vault card carries the ↗ external mark", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([
        makeModule("scribe", { management_url: "http://hub.example.com/scribe/manage" }),
      ]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-scribe");
    expect(card.querySelector(".ext-mark")).not.toBeNull();
  });

  it("non-vault module with no URL renders as disabled card (not a link)", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("runner", { management_url: null, config_ui_url: null })]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-runner");
    expect(card.tagName).toBe("DIV");
    expect(card).toHaveAttribute("aria-disabled", "true");
  });

  it("falls back to management_url when config_ui_url is null", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([
        makeModule("channel", {
          config_ui_url: null,
          management_url: "http://hub.example.com/channel/manage",
        }),
      ]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-channel");
    expect(card).toHaveAttribute("href", "http://hub.example.com/channel/manage");
  });
});

// ---------------------------------------------------------------------------
// Loading / error / empty states
// ---------------------------------------------------------------------------

describe("loading / error / empty states", () => {
  it("shows loading state before fetch resolves", () => {
    vi.mocked(api.listModules).mockImplementation(() => new Promise(() => {}));
    renderRoute();

    expect(screen.getByTestId("home-administer")).toBeDefined();
    expect(document.querySelector("[data-loading]")).not.toBeNull();
  });

  it("shows error state when listModules rejects", async () => {
    vi.mocked(api.listModules).mockRejectedValue(new Error("network error"));
    renderRoute();

    await screen.findByTestId("home-modules-error");
  });

  it("shows empty state when no modules are installed", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { installed: false })]),
    );
    renderRoute();

    // The Home component filters to installed only.
    await screen.findByTestId("home-modules-empty");
  });
});
