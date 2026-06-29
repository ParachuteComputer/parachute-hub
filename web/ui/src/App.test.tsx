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
    // useAdminLock hits getAdminLockStatus when signed in. Default = no PIN
    // configured (feature off), so the lock screen never appears in the
    // existing route tests. The dedicated lock tests override per-case.
    getAdminLockStatus: vi.fn().mockResolvedValue({
      configured: false,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 0,
    }),
    // The real /heartbeat response carries idle_seconds (see api-admin-lock.ts);
    // the client re-anchors its idle timer from it. (A prior mock that included
    // idle_seconds masked the bug where the server omitted it — keep this
    // matching the real wire shape.)
    adminLockHeartbeat: vi.fn().mockResolvedValue({
      configured: false,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 0,
    }),
    lockAdminNow: vi.fn().mockResolvedValue(undefined),
    unlockAdmin: vi.fn().mockResolvedValue({
      configured: true,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 900,
    }),
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

  it("/vaults/new renders 'vaults' (redirects to /vaults — NewVault retired in B5)", () => {
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

  it("origin root (/) renders 'home' (the admin-shell overview)", () => {
    renderAt("/");
    expect(screen.getByText(/home/i, { selector: ".sub" })).toBeInTheDocument();
  });
});

describe("App — nav structure", () => {
  it("renders all hub-native nav links in order: brand, Home, Connections, Modules, Users, Tokens, Permissions, Settings, My account, Discovery (signed-out)", async () => {
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
      "Sign in", // AuthIndicator slot, sits between brand and Home
      // Hub-native sections — all reachable in one click, every section
      // exposed (admin-shell IA, R1). Home first, then cross-cutting admin.
      // "Vaults" left this group in B5 — vault lifecycle UX is module-owned
      // at /vault/admin/ (reachable via the Home module card + Services
      // dropdown), so the hub-native group no longer carries it.
      "Home",
      "Connections",
      "Grants",
      "Modules",
      "Users",
      "Tokens",
      "Permissions",
      "Settings",
      "My account",
      // Past the divider: the off-shell Discovery escape hatch.
      "Discovery",
    ]);
  });

  it("renders one visual divider marking the hub-native ↔ module-owned boundary", () => {
    // The divider separates the in-shell hub-native `<Link>` sections from the
    // module-owned affordances (Surfaces dropdown + the cross-mount Discovery
    // `<a href>` that leaves the SPA basename).
    const { container } = renderAt("/vaults");
    const dividers = container.querySelectorAll(".nav-divider");
    expect(dividers).toHaveLength(1);
    for (const d of dividers) {
      expect(d.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("exposes every hub-native section in the nav (one click from anywhere)", async () => {
    renderAt("/tokens");
    const nav = screen.getByRole("navigation");
    for (const label of [
      "Home",
      "Modules",
      "Connections",
      "Grants",
      "Users",
      "Tokens",
      "Permissions",
      "Settings",
      "My account",
    ]) {
      expect(
        within(nav).getByRole("link", { name: new RegExp(`^${label}$`, "i") }),
      ).toBeInTheDocument();
    }
  });

  it("Discovery link points at /hub.html (the explicit discovery page; / now redirects to the shell)", () => {
    renderAt("/vaults");
    const nav = screen.getByRole("navigation");
    const discovery = within(nav).getByRole("link", { name: /^discovery$/i });
    expect(discovery).toHaveAttribute("href", "/hub.html");
  });

  it("brand links to Home (/), not Vaults", () => {
    renderAt("/vaults");
    const brand = screen.getByRole("link", { name: /parachute/i });
    expect(brand).toHaveAttribute("href", "/");
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

  it("lights up Home on the index route (/) — and ONLY Home (exact match)", () => {
    const { container } = renderAt("/");
    const home = within(screen.getByRole("navigation")).getByRole("link", {
      name: /^home$/i,
    });
    expect(home).toHaveClass("nav-link-active");
    expect(home).toHaveAttribute("aria-current", "page");
    // Home is exact-match only — a prefix match on `/` would light it on
    // every route, and would also light it alongside other sections here.
    expect(container.querySelectorAll(".nav .nav-link-active")).toHaveLength(1);
  });

  it("does NOT light up Home on a non-index route (exact-match guard)", () => {
    renderAt("/tokens");
    const home = within(screen.getByRole("navigation")).getByRole("link", {
      name: /^home$/i,
    });
    expect(home).not.toHaveClass("nav-link-active");
  });

  it("renders NO hub-native Vaults nav link (B5 — vault lifecycle is module-owned)", () => {
    renderAt("/vaults");
    const nav = screen.getByRole("navigation");
    expect(within(nav).queryByRole("link", { name: /^vaults$/i })).toBeNull();
  });
});

describe("App — document title", () => {
  it("sets a per-route document.title", async () => {
    renderAt("/tokens");
    await waitFor(() => expect(document.title).toBe("Tokens · Parachute"));
  });

  it("title-cases multi-word sections", async () => {
    // `/approve-client/:id` → subtitle "approve app" → title-cased "Approve App".
    // (The old `/modules/:short/config` "Module Config" route was retired in the
    // 2026-06-09 modular-UI architecture P3 — config is module-owned now.)
    renderAt("/approve-client/some-client");
    await waitFor(() => expect(document.title).toBe("Approve App · Parachute"));
  });

  it("titles the index route Home", async () => {
    renderAt("/");
    await waitFor(() => expect(document.title).toBe("Home · Parachute"));
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
      two_factor_enabled: false,
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
      two_factor_enabled: false,
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
      two_factor_enabled: false,
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
      two_factor_enabled: false,
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
      two_factor_enabled: false,
    });
    vi.mocked(api.listModules).mockResolvedValue({
      modules: [
        {
          short: "vault",
          package: "@openparachute/vault",
          display_name: "Vault",
          tagline: "",
          focus: "core",
          available: true,
          available_to_install: true,
          installed: true,
          installed_version: "0.4.5",
          latest_version: "0.4.5",
          upgrade_available: false,
          supervisor_status: "running",
          pid: 1,
          install_dir: null,
          uis: [],
          management_url: "/vault/default/admin",
          config_ui_url: null,
        },
        {
          short: "scribe",
          package: "@openparachute/scribe",
          display_name: "Scribe",
          tagline: "",
          focus: "core",
          available: true,
          available_to_install: true,
          installed: true,
          installed_version: "0.1.0",
          latest_version: "0.1.0",
          upgrade_available: false,
          supervisor_status: "running",
          pid: 2,
          install_dir: null,
          uis: [],
          management_url: null,
          config_ui_url: null,
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

  it("/vaults/new redirects to /vaults (the NewVault form left with B5)", async () => {
    renderAt("/vaults/new");
    // The route is a <Navigate replace> onto the feature-detected /vaults —
    // we land on the Vaults surface, and no create form exists anymore.
    expect(await screen.findByRole("heading", { name: /^vaults/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/vault name/i)).toBeNull();
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

  it("origin root (/) renders the Home overview (heading 'Hub')", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { name: /^hub$/i })).toBeInTheDocument();
  });

  it("/channels redirects to Connections (retired pre-P5 view)", async () => {
    renderAt("/channels");
    // The Channels view is retired — its route is a redirect to Connections,
    // so we land on the Connections heading, not a dead Channels page.
    expect(await screen.findByRole("heading", { name: /^connections$/i })).toBeInTheDocument();
  });

  it("unknown path renders 404 with link back to Home", () => {
    renderAt("/this-does-not-exist");
    const empty = screen.getByText(/404/).closest(".empty");
    expect(empty).not.toBeNull();
    const backLink = within(empty as HTMLElement).getByRole("link", { name: /home/i });
    expect(backLink).toHaveAttribute("href", "/");
  });
});

describe("App — admin screen lock", () => {
  it("renders the lock screen (not the admin shell) when the session is locked", async () => {
    vi.mocked(api.getMe).mockResolvedValue({
      hasSession: true,
      user: { id: "u1", displayName: "Op" },
      csrf: "csrf-1",
      two_factor_enabled: false,
    });
    vi.mocked(api.getAdminLockStatus).mockResolvedValue({
      configured: true,
      locked: true,
      idle_seconds: 900,
      unlock_seconds_remaining: 0,
    });
    renderAt("/");
    // The lock screen is shown; the nav (admin shell) is hidden.
    expect(await screen.findByTestId("admin-lock-screen")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("shows the admin shell + a 'Lock now' button when configured but unlocked", async () => {
    vi.mocked(api.getMe).mockResolvedValue({
      hasSession: true,
      user: { id: "u1", displayName: "Op" },
      csrf: "csrf-1",
      two_factor_enabled: false,
    });
    vi.mocked(api.getAdminLockStatus).mockResolvedValue({
      configured: true,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 900,
    });
    renderAt("/");
    expect(await screen.findByTestId("admin-lock-now")).toBeInTheDocument();
    // No lock screen — the shell is usable.
    expect(screen.queryByTestId("admin-lock-screen")).not.toBeInTheDocument();
  });

  it("does NOT show 'Lock now' when no PIN is configured (feature off)", async () => {
    vi.mocked(api.getMe).mockResolvedValue({
      hasSession: true,
      user: { id: "u1", displayName: "Op" },
      csrf: "csrf-1",
      two_factor_enabled: false,
    });
    vi.mocked(api.getAdminLockStatus).mockResolvedValue({
      configured: false,
      locked: false,
      idle_seconds: 900,
      unlock_seconds_remaining: 0,
    });
    renderAt("/");
    await screen.findByRole("heading", { name: /^hub$/i });
    expect(screen.queryByTestId("admin-lock-now")).not.toBeInTheDocument();
  });

  it("unlocking from the lock screen reveals the admin shell", async () => {
    vi.mocked(api.getMe).mockResolvedValue({
      hasSession: true,
      user: { id: "u1", displayName: "Op" },
      csrf: "csrf-1",
      two_factor_enabled: false,
    });
    // First call: locked. After unlock, refresh() re-reads → unlocked.
    vi.mocked(api.getAdminLockStatus)
      .mockResolvedValueOnce({
        configured: true,
        locked: true,
        idle_seconds: 900,
        unlock_seconds_remaining: 0,
      })
      .mockResolvedValue({
        configured: true,
        locked: false,
        idle_seconds: 900,
        unlock_seconds_remaining: 900,
      });
    renderAt("/");
    const input = await screen.findByTestId("admin-lock-pin-input");
    fireEvent.change(input, { target: { value: "4827" } });
    fireEvent.click(screen.getByTestId("admin-lock-unlock"));
    await waitFor(() => expect(api.unlockAdmin).toHaveBeenCalledWith("csrf-1", "4827"));
    // The shell returns (nav present, lock screen gone).
    await waitFor(() => expect(screen.queryByTestId("admin-lock-screen")).not.toBeInTheDocument());
  });
});
