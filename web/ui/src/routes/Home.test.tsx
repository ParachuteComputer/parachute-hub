/**
 * Home route tests — Administer group (no /vaults card), Modules group
 * (every module card uniform off-shell via config_ui_url — vault included
 * since B5 of the 2026-06-09 hub-module-boundary migration — plus the
 * zero-instances bootstrap card), loading / error / empty states.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { Home } from "./Home.tsx";

vi.mock("../lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listModules: vi.fn(),
    listVaults: vi.fn(),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: one vault instance exists, so the vault card takes the normal
  // uniform module shape. The zero-instances tests override per-case.
  vi.mocked(api.listVaults).mockResolvedValue({
    moduleInstalled: true,
    vaults: [
      {
        name: "default",
        url: "http://hub.local/vault/default/",
        version: "0.5.0",
        path: "/vault/default",
      },
    ],
  });
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
    for (const path of [
      "/connections",
      "/modules",
      "/users",
      "/tokens",
      "/permissions",
      "/settings",
    ]) {
      expect(administer.querySelector(`[data-section='${path}']`)).not.toBeNull();
    }
    expect(administer.querySelector("[data-section='/vaults']")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Modules group — vault card (uniform module pattern since B5)
// ---------------------------------------------------------------------------

describe("Modules group — vault card", () => {
  it("renders the vault card EXACTLY like other modules: off-shell <a> to config_ui_url with ↗", async () => {
    // New-manifest vault: configUiUrl "/vault/admin/" resolved verbatim by
    // the catalog. The card is the same off-shell shape channel/scribe/
    // surface get — the hub#635 in-shell /vaults special-case is retired.
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { config_ui_url: "/vault/admin/" })]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-vault");
    expect(card.tagName).toBe("A");
    expect(card).toHaveAttribute("href", "/vault/admin/");
    expect(card.querySelector(".ext-mark")).not.toBeNull();
    expect(card.textContent).toContain("opens Vault's own admin");
    // No residue of the old in-shell card.
    expect(card.getAttribute("href")).not.toBe("/vaults");
    expect(card.textContent).not.toContain("opens here");
  });

  it("vault card falls back to management_url when config_ui_url is null (generic fallback)", async () => {
    // Old-manifest vault that still resolves a managementUrl (the B4 compat
    // shim mount-joins the legacy "/admin/" to the instance mount). Same
    // fallback every module gets — still off-shell.
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([
        makeModule("vault", { config_ui_url: null, management_url: "/vault/default/admin/" }),
      ]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-vault");
    expect(card.tagName).toBe("A");
    expect(card).toHaveAttribute("href", "/vault/default/admin/");
    expect(card.querySelector(".ext-mark")).not.toBeNull();
  });

  it("vault card renders DISABLED when neither URL resolves (no in-shell /vaults link anymore)", async () => {
    // Feature-detect by absence: a vault manifest that predates the vault
    // wave and resolves no URL gets the same disabled fallback as any other
    // module — never the retired in-shell special-case.
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { config_ui_url: null, management_url: null })]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-vault");
    expect(card.tagName).toBe("DIV");
    expect(card).toHaveAttribute("aria-disabled", "true");
    expect(card.textContent).toContain("no admin UI yet");
  });

  it("zero instances → bootstrap 'create your first vault' card deep-linking the wizard step", async () => {
    // Wizard-skip state (hub#607): vault module installed, no instances, no
    // daemon — /vault/admin/ has nothing to serve. The charter's bootstrap
    // exception: a hub-side card deep-linking the re-enterable
    // /admin/setup?step=vault (full-document anchor, hub treatment, no ↗).
    vi.mocked(api.listVaults).mockResolvedValue({ moduleInstalled: true, vaults: [] });
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { config_ui_url: "/vault/admin/" })]),
    );
    renderRoute();

    // waitFor: the card swaps to the bootstrap shape only once BOTH the
    // catalog and the well-known instance count have settled.
    await waitFor(() =>
      expect(screen.getByTestId("home-module-vault")).toHaveAttribute(
        "href",
        "/admin/setup?step=vault",
      ),
    );
    const card = screen.getByTestId("home-module-vault");
    expect(card.tagName).toBe("A");
    expect(card.querySelector(".ext-mark")).toBeNull();
    expect(card.textContent).toContain("create your first vault");
  });

  it("zero instances substitutes the bootstrap card even on an old-manifest vault", async () => {
    vi.mocked(api.listVaults).mockResolvedValue({ moduleInstalled: true, vaults: [] });
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { config_ui_url: null, management_url: null })]),
    );
    renderRoute();

    await waitFor(() =>
      expect(screen.getByTestId("home-module-vault")).toHaveAttribute(
        "href",
        "/admin/setup?step=vault",
      ),
    );
  });

  it("unknown instance count (well-known read failed) keeps the normal uniform card", async () => {
    // Only a CONFIRMED zero swaps in the bootstrap card — a flaky discovery
    // read must not hide a working /vault/admin/ link.
    vi.mocked(api.listVaults).mockRejectedValue(new Error("network down"));
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { config_ui_url: "/vault/admin/" })]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-vault");
    expect(card).toHaveAttribute("href", "/vault/admin/");
  });
});

// ---------------------------------------------------------------------------
// Modules group — non-vault module cards (off-shell)
// ---------------------------------------------------------------------------

describe("Modules group — non-vault module cards", () => {
  it("renders a non-vault module with a config_ui_url as an off-shell <a>", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("scribe", { config_ui_url: "http://hub.example.com/scribe/admin" })]),
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
        makeModule("agent", {
          config_ui_url: null,
          management_url: "http://hub.example.com/agent/manage",
        }),
      ]),
    );
    renderRoute();

    await screen.findByTestId("home-modules");
    const card = screen.getByTestId("home-module-agent");
    expect(card).toHaveAttribute("href", "http://hub.example.com/agent/manage");
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
