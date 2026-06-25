/**
 * VaultsList tests — the B5 feature-detect gate (forward to /vault/admin/
 * on a new-manifest vault, legacy list otherwise) plus the legacy list:
 * loading → ok / empty / error, the managementUrl-driven Manage button
 * (mint + redirect, mint failure surfacing, "CLI only" stub), and the
 * post-NewVault create affordances (wizard deep-link empty state, CLI
 * hint when vaults already exist).
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
    listModules: vi.fn(),
    listVaults: vi.fn(),
    mintVaultAdminToken: vi.fn(),
  };
});

/** Full ModuleListing for the feature-detect catalog; override per-test. */
function makeModule(short: string, overrides: Partial<api.ModuleListing> = {}): api.ModuleListing {
  return {
    short,
    package: `@openparachute/${short}`,
    display_name: short.charAt(0).toUpperCase() + short.slice(1),
    tagline: `the ${short} module`,
    focus: "core",
    available: true,
    available_to_install: true,
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

function makeCatalog(modules: api.ModuleListing[]): api.ModulesCatalog {
  return { modules, supervisor_available: true, module_install_channel: "latest" };
}

let assignSpy: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
let replaceSpy: ReturnType<typeof vi.fn<(url: string | URL) => void>>;
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  // Default detect outcome: vault module installed but OLD manifest (no
  // config_ui_url) → the legacy list renders. The redirect tests override.
  vi.mocked(api.listModules).mockResolvedValue(makeCatalog([makeModule("vault")]));
  assignSpy = vi.fn<(url: string | URL) => void>();
  replaceSpy = vi.fn<(url: string | URL) => void>();
  // jsdom locks individual Location members non-configurable, so we swap
  // the whole `window.location` slot — that property *is* configurable.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, assign: assignSpy, replace: replaceSpy },
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

// ---------------------------------------------------------------------------
// B5 feature-detect: /vaults is a compatibility route now
// ---------------------------------------------------------------------------

describe("VaultsList — feature-detected forward to /vault/admin/", () => {
  it("full-document-replaces to /vault/admin/ when vault's config_ui_url is exactly /vault/admin/", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { config_ui_url: "/vault/admin/" })]),
    );
    renderList();
    await waitFor(() => expect(replaceSpy).toHaveBeenCalledWith("/vault/admin/"));
    // The legacy list never loads — no well-known fetch, no list render.
    expect(api.listVaults).not.toHaveBeenCalled();
    expect(screen.getByTestId("vaults-detecting")).toHaveTextContent(/opening the vault admin/i);
  });

  it("renders the legacy list (no redirect) when config_ui_url is null — old vault manifest", async () => {
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { config_ui_url: null })]),
    );
    vi.mocked(api.listVaults).mockResolvedValue({ vaults: [], moduleInstalled: true });
    renderList();
    await waitFor(() => expect(screen.getByText(/no vaults yet/i)).toBeInTheDocument());
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("does NOT redirect on a per-instance config_ui_url (exact-match guard)", async () => {
    // Anything that isn't the daemon-level home — e.g. a mount-joined
    // per-instance path — keeps the legacy list.
    vi.mocked(api.listModules).mockResolvedValue(
      makeCatalog([makeModule("vault", { config_ui_url: "/vault/default/admin/" })]),
    );
    vi.mocked(api.listVaults).mockResolvedValue({ vaults: [], moduleInstalled: true });
    renderList();
    await waitFor(() => expect(screen.getByText(/no vaults yet/i)).toBeInTheDocument());
    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it("degrades to the legacy list when the module catalog can't be read", async () => {
    vi.mocked(api.listModules).mockRejectedValue(new api.HttpError(500, "catalog down"));
    vi.mocked(api.listVaults).mockResolvedValue({ vaults: [], moduleInstalled: true });
    renderList();
    await waitFor(() => expect(screen.getByText(/no vaults yet/i)).toBeInTheDocument());
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

describe("VaultsList", () => {
  it("empty state's 'Create a vault' deep-links the re-enterable wizard vault step", async () => {
    // The hub-side NewVault form left with B5 — the bootstrap affordance is
    // the server-rendered /admin/setup?step=vault (full-document anchor).
    vi.mocked(api.listVaults).mockResolvedValue({ vaults: [], moduleInstalled: true });
    renderList();
    await waitFor(() => expect(screen.getByText(/no vaults yet/i)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /create a vault/i })).toHaveAttribute(
      "href",
      "/admin/setup?step=vault",
    );
  });

  it("renders 'install vault module' empty state when no vault module is installed (hub#297)", async () => {
    vi.mocked(api.listVaults).mockResolvedValue({ vaults: [], moduleInstalled: false });
    renderList();
    await waitFor(() => expect(screen.getByText(/no vault module installed/i)).toBeInTheDocument());
    // Empty-state CTA points to /modules (under the /admin basename →
    // /admin/modules in production).
    expect(screen.getByRole("link", { name: /install vault module →/i })).toHaveAttribute(
      "href",
      "/modules",
    );
    // Header CTA is "Install vault module" — creating a vault on a
    // vault-less hub has nothing to provision against.
    expect(screen.getByRole("link", { name: /install vault module$/i })).toHaveAttribute(
      "href",
      "/modules",
    );
    // No "New vault" CTA anywhere (the hub-side create form left with B5).
    expect(screen.queryByRole("button", { name: /^new vault$/i })).toBeNull();
  });

  it("renders one row per vault with name + version + URL", async () => {
    vi.mocked(api.listVaults).mockResolvedValue({
      moduleInstalled: true,
      vaults: [
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
      ],
    });
    renderList();
    await waitFor(() => expect(screen.getByText(/Vaults \(2\)/)).toBeInTheDocument());
    expect(screen.getByText("work")).toBeInTheDocument();
    expect(screen.getByText("scratch")).toBeInTheDocument();
    expect(screen.getAllByText(/v0\.5\.1/)).toHaveLength(2);
    // The header "New vault" button is gone (B5); in its place, the legacy
    // list points at CLI-or-upgrade for additional instances.
    expect(screen.queryByRole("button", { name: /^new vault$/i })).toBeNull();
    expect(screen.getByTestId("vaults-legacy-create-hint")).toHaveTextContent(
      /parachute vault create/i,
    );
  });

  it("renders the error banner + retry button on failure", async () => {
    vi.mocked(api.listVaults).mockRejectedValue(new Error("network down"));
    renderList();
    await waitFor(() => expect(screen.getByText(/couldn't load vaults/i)).toBeInTheDocument());
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders a 'CLI only' marker when the vault has no managementUrl", async () => {
    vi.mocked(api.listVaults).mockResolvedValue({
      moduleInstalled: true,
      vaults: [
        {
          name: "legacy",
          url: "http://hub.local/vault/legacy/",
          version: "0.4.0",
          path: "/vault/legacy",
        },
      ],
    });
    renderList();
    await waitFor(() => expect(screen.getByText("legacy")).toBeInTheDocument());
    expect(screen.getByText(/cli only/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage vault legacy/i })).toBeNull();
  });

  it("renders a Manage button when managementUrl is present and mints + redirects on click", async () => {
    vi.mocked(api.listVaults).mockResolvedValue({
      moduleInstalled: true,
      vaults: [
        {
          name: "work",
          url: "http://hub.local/vault/work/",
          version: "0.5.1",
          path: "/vault/work",
          managementUrl: "/admin",
        },
      ],
    });
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
    vi.mocked(api.listVaults).mockResolvedValue({
      moduleInstalled: true,
      vaults: [
        {
          name: "work",
          url: "http://hub.local/vault/work/",
          version: "0.5.1",
          path: "/vault/work",
          managementUrl: "https://elsewhere.example/manage",
        },
      ],
    });
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

  it("toggles a per-row MCP connect card showing the /vault/<name>/mcp endpoint + command", async () => {
    vi.mocked(api.listVaults).mockResolvedValue({
      moduleInstalled: true,
      vaults: [
        {
          name: "work",
          url: "https://hub.example.ts.net/vault/work",
          version: "0.5.1",
          path: "/vault/work",
          managementUrl: "/admin",
        },
      ],
    });
    renderList();
    const connectBtn = await screen.findByRole("button", {
      name: /connect an mcp client to vault work/i,
    });
    // Card is collapsed until the operator clicks Connect.
    expect(screen.queryByTestId("mcp-endpoint")).toBeNull();
    fireEvent.click(connectBtn);

    expect(screen.getByTestId("mcp-endpoint")).toHaveTextContent(
      "https://hub.example.ts.net/vault/work/mcp",
    );
    expect(screen.getByTestId("mcp-add-command")).toHaveTextContent(
      "claude mcp add --transport http parachute-work https://hub.example.ts.net/vault/work/mcp",
    );

    // Clicking again collapses it.
    fireEvent.click(screen.getByRole("button", { name: /connect an mcp client to vault work/i }));
    expect(screen.queryByTestId("mcp-endpoint")).toBeNull();
  });

  it("surfaces a per-row error banner when the mint fails (no redirect)", async () => {
    vi.mocked(api.listVaults).mockResolvedValue({
      moduleInstalled: true,
      vaults: [
        {
          name: "work",
          url: "http://hub.local/vault/work/",
          version: "0.5.1",
          path: "/vault/work",
          managementUrl: "/admin",
        },
      ],
    });
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
