/**
 * App-level smoke tests — brand subtitle reflects the active route; nav
 * has the right groups + dividers; routes render the expected components.
 *
 * Subtitle is now derived from the router's pathname (via `useLocation`),
 * so tests drive route changes via `MemoryRouter`'s `initialEntries` —
 * no `window.location` munging needed.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.tsx";
// Runtime import (not `import type`) because the auth-indicator tests
// call `vi.mocked(api.getMe).mockResolvedValue(...)` at runtime to drive
// per-test fixtures. The mock above replaces the live module's exports
// with vi.fn()s — `api.getMe` resolves to that vi.fn at call time.
import * as api from "./lib/api.ts";

// Stub all API helpers — App pulls in VaultsList / Permissions / Tokens
// at module-load time, and each of those calls into lib/api.ts on mount.
// Without stubs, jsdom would attempt real fetches and the route tests
// would race against unmounted state.
vi.mock("./lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listVaults: vi.fn().mockResolvedValue({ vaults: [], moduleInstalled: false }),
    listGrants: vi.fn().mockResolvedValue([]),
    listTokens: vi.fn().mockResolvedValue({ tokens: [], next_cursor: null }),
    listModules: vi.fn().mockResolvedValue({ modules: [], supervisor_available: false }),
    // App's useEffect hits getMe() on mount. Default mock = signed-out so
    // the AuthIndicator renders the deterministic "Sign in" link rather
    // than racing on a real fetch. Per-test overrides via mockResolvedValue.
    getMe: vi.fn().mockResolvedValue({ hasSession: false }),
    signOut: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <App />
    </MemoryRouter>,
  );
}

describe("App — brand subtitle (route-derived)", () => {
  it("/vaults renders 'vaults'", () => {
    renderAt("/vaults");
    expect(screen.getByText(/vaults/i, { selector: ".sub" })).toBeInTheDocument();
  });

  it("/vaults/new renders 'vaults' (sub-route still under vaults)", () => {
    renderAt("/vaults/new");
    expect(screen.getByText(/vaults/i, { selector: ".sub" })).toBeInTheDocument();
  });

  it("/permissions renders 'permissions'", () => {
    renderAt("/permissions");
    expect(screen.getByText(/permissions/i, { selector: ".sub" })).toBeInTheDocument();
  });

  it("/tokens renders 'tokens'", () => {
    renderAt("/tokens");
    expect(screen.getByText(/tokens/i, { selector: ".sub" })).toBeInTheDocument();
  });

  it("/modules renders 'modules'", () => {
    renderAt("/modules");
    expect(screen.getByText(/modules/i, { selector: ".sub" })).toBeInTheDocument();
  });

  it("origin root (/) falls back to 'vaults' (the SPA's home)", () => {
    renderAt("/");
    expect(screen.getByText(/vaults/i, { selector: ".sub" })).toBeInTheDocument();
  });
});

describe("App — nav structure", () => {
  it("renders all nav links in order: brand, Vaults, Modules, Users, Channels, Permissions, Tokens, Settings, Discovery (signed-out)", async () => {
    renderAt("/vaults");
    // Wait for /api/me to resolve so AuthIndicator's "Sign in" link
    // appears in the nav before we snapshot the link order.
    const nav = screen.getByRole("navigation");
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: /^sign in$/i })).toBeInTheDocument(),
    );
    const links = within(nav).getAllByRole("link");
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).toEqual([
      // Brand cluster: SVG mark + "Parachute" wordmark + subtitle (the
      // route's name, e.g. "vaults"). The mark renders as an svg child
      // with no text, so textContent is just wordmark + subtitle.
      expect.stringMatching(/parachute/i),
      "Sign in", // AuthIndicator slot, sits between brand and Vaults
      "Vaults",
      "Modules",
      "Users",
      "Channels",
      "Permissions",
      "Tokens",
      "Settings",
      "Discovery",
    ]);
  });

  it("renders one visual divider between SPA-internal links and Discovery", () => {
    // Single mount = single SPA section. The remaining divider separates
    // in-SPA `<Link>` nav from the cross-mount Discovery `<a href>` (which
    // leaves the SPA basename).
    const { container } = renderAt("/vaults");
    const dividers = container.querySelectorAll(".nav-divider");
    expect(dividers).toHaveLength(1);
    for (const d of dividers) {
      expect(d.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("brand cluster renders the canonical wordmark + route subtitle", () => {
    // Renamed from 'Parachute Hub' in #231 → 'Parachute Admin'. Then the
    // post-#401 polish split the cluster into a brand mark + wordmark
    // ("Parachute") + subtitle ("vaults" / "modules" / etc.). The
    // canonical wordmark text comes from `src/components/BrandMark.tsx`
    // → `WORDMARK_TEXT` so this assertion will follow the constant if
    // the wordmark ever changes.
    renderAt("/vaults");
    const brand = screen.getByRole("link", { name: /parachute/i });
    expect(brand).toBeInTheDocument();
    // Wordmark + subtitle live in distinct spans inside the brand link.
    expect(brand.querySelector(".brand-wordmark")?.textContent).toBe("Parachute");
    expect(brand.querySelector(".sub")?.textContent?.toLowerCase()).toMatch(/vaults/);
    // No stale "Parachute Hub" label from pre-#231.
    expect(screen.queryByText(/^parachute hub/i)).toBeNull();
  });
});

describe("App — active nav indicator", () => {
  it("marks the current section's NavLink active with aria-current + class", () => {
    const { container } = renderAt("/tokens");
    const tokens = within(screen.getByRole("navigation")).getByRole("link", {
      name: /^tokens$/i,
    });
    expect(tokens).toHaveClass("nav-link-active");
    expect(tokens).toHaveAttribute("aria-current", "page");
    // Exactly one section is active at a time.
    expect(container.querySelectorAll(".nav .nav-link-active")).toHaveLength(1);
  });

  it("lights up Vaults on the index route (/) via the alsoActiveAt alias", () => {
    renderAt("/");
    const vaults = within(screen.getByRole("navigation")).getByRole("link", {
      name: /^vaults$/i,
    });
    expect(vaults).toHaveClass("nav-link-active");
    expect(vaults).toHaveAttribute("aria-current", "page");
  });

  it("keeps Vaults active on the /vaults/new sub-route", () => {
    renderAt("/vaults/new");
    const vaults = within(screen.getByRole("navigation")).getByRole("link", {
      name: /^vaults$/i,
    });
    expect(vaults).toHaveClass("nav-link-active");
  });
});

describe("App — document title", () => {
  it("sets a per-route document.title", async () => {
    renderAt("/tokens");
    await waitFor(() => expect(document.title).toBe("Tokens · Parachute"));
  });

  it("title-cases multi-word sections", async () => {
    renderAt("/modules/scribe/config");
    await waitFor(() => expect(document.title).toBe("Module Config · Parachute"));
  });

  it("falls back to Vaults on the index route", async () => {
    renderAt("/");
    await waitFor(() => expect(document.title).toBe("Vaults · Parachute"));
  });
});

describe("App — auth indicator (rc.13)", () => {
  it("renders nothing on first paint, then 'Sign in' once /api/me resolves to signed-out", async () => {
    vi.mocked(api.getMe).mockResolvedValue({ hasSession: false });
    renderAt("/vaults");
    // First paint shouldn't have the link yet (`me === null` until effect resolves).
    // The `await waitFor` proves the link appears asynchronously.
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /^sign in$/i })).toBeInTheDocument(),
    );
  });

  it("Sign in link points at /login?next=<current path>", async () => {
    vi.mocked(api.getMe).mockResolvedValue({ hasSession: false });
    renderAt("/permissions");
    const link = await screen.findByRole("link", { name: /^sign in$/i });
    // jsdom's window.location.pathname is "/" by default since MemoryRouter
    // doesn't touch real window.location. So the next= encodes "/" not
    // /permissions. Pinning the actual encoded value here.
    expect(link.getAttribute("href")).toBe(`/login?next=${encodeURIComponent("/")}`);
  });

  it("renders 'Signed in as <displayName>' + Sign out button when /api/me has a session", async () => {
    vi.mocked(api.getMe).mockResolvedValue({
      hasSession: true,
      user: { id: "u1", displayName: "aaron" },
      csrf: "csrf-token-abc",
    });
    renderAt("/vaults");
    await waitFor(() => expect(screen.getByText(/signed in as/i)).toBeInTheDocument());
    expect(screen.getByText("aaron")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign out$/i })).toBeInTheDocument();
    // The "Sign in" link must NOT also appear when signed in.
    expect(screen.queryByRole("link", { name: /^sign in$/i })).toBeNull();
  });

  it("clicking Sign out POSTs the CSRF token via signOut() and navigates to /", async () => {
    vi.mocked(api.getMe).mockResolvedValue({
      hasSession: true,
      user: { id: "u1", displayName: "aaron" },
      csrf: "csrf-token-abc",
    });
    vi.mocked(api.signOut).mockResolvedValue();
    // Stub window.location so we can observe the navigation without
    // actually navigating jsdom away from the test page.
    const original = window.location;
    Object.defineProperty(window, "location", {
      value: { ...original, href: original.href },
      writable: true,
    });

    try {
      renderAt("/vaults");
      const signOutBtn = await screen.findByRole("button", { name: /^sign out$/i });
      fireEvent.click(signOutBtn);
      await waitFor(() => expect(api.signOut).toHaveBeenCalledWith("csrf-token-abc"));
      // Navigation target is `/` (discovery) so the operator sees the
      // signed-out affordance immediately on the freshly-rebuilt header.
      await waitFor(() => expect(window.location.href).toBe("/"));
    } finally {
      Object.defineProperty(window, "location", { value: original, writable: true });
    }
  });

  it("Sign out button shows 'Signing out…' and disables during the in-flight POST", async () => {
    vi.mocked(api.getMe).mockResolvedValue({
      hasSession: true,
      user: { id: "u1", displayName: "aaron" },
      csrf: "csrf-token-abc",
    });
    let resolveSignOut: () => void = () => {};
    vi.mocked(api.signOut).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSignOut = resolve;
      }),
    );
    renderAt("/vaults");
    const signOutBtn = await screen.findByRole("button", { name: /^sign out$/i });
    fireEvent.click(signOutBtn);
    // While the POST is pending, the button is disabled with "Signing out…".
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^signing out…$/i })).toBeDisabled(),
    );
    resolveSignOut();
  });
});

describe("App — installed-services dropdown (hub#342)", () => {
  it("renders nothing in the nav when no modules are installed", async () => {
    vi.mocked(api.getMe).mockResolvedValue({
      hasSession: true,
      user: { id: "u1", displayName: "aaron" },
      csrf: "csrf",
    });
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderAt("/vaults");
    await waitFor(() => expect(screen.getByText(/signed in as/i)).toBeInTheDocument());
    expect(screen.queryByTestId("installed-services-dropdown")).toBeNull();
  });

  it("renders an active <a> per installed module with a management_url", async () => {
    vi.mocked(api.getMe).mockResolvedValue({
      hasSession: true,
      user: { id: "u1", displayName: "aaron" },
      csrf: "csrf",
    });
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        {
          short: "vault",
          package: "@openparachute/vault",
          display_name: "Vault",
          tagline: "",
          available: true,
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          supervisor_status: "running",
          pid: 1,
          install_dir: null,
          uis: [],
          management_url: "/vault/default/admin",
        },
        {
          short: "scribe",
          package: "@openparachute/scribe",
          display_name: "Scribe",
          tagline: "",
          available: true,
          installed: true,
          installed_version: "0.1.0",
          latest_version: "0.1.0",
          supervisor_status: "running",
          pid: 2,
          install_dir: null,
          uis: [],
          management_url: null,
        },
      ],
      supervisor_available: true,
      module_install_channel: "latest",
    });
    renderAt("/vaults");
    await waitFor(() =>
      expect(screen.getByTestId("installed-services-dropdown")).toBeInTheDocument(),
    );
    const vaultItem = screen.getByTestId("nav-service-vault");
    expect(vaultItem.tagName).toBe("A");
    expect(vaultItem.getAttribute("href")).toBe("/vault/default/admin");
    const scribeItem = screen.getByTestId("nav-service-scribe");
    expect(scribeItem.tagName).toBe("SPAN");
    expect(scribeItem.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("App — route rendering", () => {
  it("/vaults renders VaultsList (heading 'Vaults')", async () => {
    renderAt("/vaults");
    expect(await screen.findByRole("heading", { name: /^vaults/i })).toBeInTheDocument();
  });

  it("/vaults/new renders NewVault (form input for vault name)", () => {
    renderAt("/vaults/new");
    // NewVault's form has a name input — surfaces immediately on mount.
    expect(screen.getByLabelText(/vault name/i)).toBeInTheDocument();
  });

  it("/permissions renders Permissions (heading 'Permissions')", () => {
    renderAt("/permissions");
    expect(screen.getByRole("heading", { name: /^permissions$/i })).toBeInTheDocument();
  });

  it("/tokens renders Tokens (heading 'Tokens')", () => {
    renderAt("/tokens");
    expect(screen.getByRole("heading", { name: /^tokens$/i })).toBeInTheDocument();
  });

  it("/modules renders Modules (heading 'Modules')", async () => {
    renderAt("/modules");
    expect(await screen.findByRole("heading", { name: /^modules$/i })).toBeInTheDocument();
  });

  it("origin root (/) renders VaultsList (the SPA's home)", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { name: /^vaults/i })).toBeInTheDocument();
  });

  it("unknown path renders 404 with link back to vaults", () => {
    renderAt("/this-does-not-exist");
    const empty = screen.getByText(/404/).closest(".empty");
    expect(empty).not.toBeNull();
    // Scope the link query to the 404 body — the brand link in the nav
    // also matches /vaults/i and would otherwise multi-match.
    const backLink = within(empty as HTMLElement).getByRole("link", { name: /vaults/i });
    expect(backLink).toHaveAttribute("href", "/vaults");
  });
});
