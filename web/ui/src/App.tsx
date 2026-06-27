/**
 * Parachute Admin SPA.
 *
 * Hub-served browser UI for cross-cutting host concerns:
 *
 *   - **`/admin/permissions`** — OAuth consent grant management.
 *   - **`/admin/tokens`** — token registry: mint, list, revoke.
 *
 * Vault instance-lifecycle UX is MODULE-OWNED as of B5 (2026-06-09
 * hub-module-boundary migration): vault's own surface at `/vault/admin/`
 * holds the list/create/delete experience. `/admin/vaults` survives only
 * as a feature-detected compatibility route — it forwards to
 * `/vault/admin/` when the installed vault declares the new manifest, and
 * renders the legacy list for vaults that predate the vault wave. Per-vault
 * content (the Notes PWA, etc.) lives at `/vault/<name>/*` and was never
 * part of this SPA — vaults own their own user-facing surfaces.
 *
 * Single mount at `/admin/*` (as of hub#231). The prior dual mounts
 * (`/vault` for the vault SPA, `/hub/*` for permissions+tokens) are
 * 301-redirected in `hub-server.ts` so cached URLs keep working.
 *
 * Cross-surface navigation off the SPA (e.g. to `/` or `/vault/<name>/`)
 * uses plain `<a href>` since react-router's `<Link>` resolves against
 * the SPA basename.
 *
 * The discovery page at `/` (see `src/hub.ts`) is the operator's
 * entry point — its Use section links to per-service surfaces; its
 * Admin section links here.
 */
import { type ReactNode, useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { BrandMark, WORDMARK_TEXT } from "./components/BrandMark.tsx";
import { HubVersionBadge } from "./components/HubVersionBadge.tsx";
import { LockScreen } from "./components/LockScreen.tsx";
import {
  type MeResponse,
  type ModuleListing,
  getMe,
  listModules,
  lockAdminNow,
  signOut,
} from "./lib/api.ts";
import { clearCachedToken } from "./lib/auth.ts";
import { useAdminLock } from "./lib/useAdminLock.ts";
import { Account } from "./routes/Account.tsx";
import { ApproveClient } from "./routes/ApproveClient.tsx";
import { Connections } from "./routes/Connections.tsx";
import { Grants } from "./routes/Grants.tsx";
import { Home } from "./routes/Home.tsx";
import { Modules } from "./routes/Modules.tsx";
import { Permissions } from "./routes/Permissions.tsx";
import { Settings } from "./routes/Settings.tsx";
import { Tokens } from "./routes/Tokens.tsx";
import { Users } from "./routes/Users.tsx";
import { VaultsList } from "./routes/VaultsList.tsx";

/**
 * Subtitle reflects the active route's section so a deep-link operator
 * knows where they are without reading the URL bar. Updates on
 * client-side navigation via the router's pathname.
 */
function subtitleFor(pathname: string): string {
  if (pathname === "/permissions" || pathname.startsWith("/permissions/")) {
    return "permissions";
  }
  if (pathname === "/tokens" || pathname.startsWith("/tokens/")) {
    return "tokens";
  }
  if (pathname === "/modules" || pathname.startsWith("/modules/")) {
    return "modules";
  }
  if (pathname === "/users" || pathname.startsWith("/users/")) {
    return "users";
  }
  if (pathname === "/connections" || pathname.startsWith("/connections/")) {
    return "connections";
  }
  if (pathname === "/vaults" || pathname.startsWith("/vaults/")) {
    return "vaults";
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "settings";
  }
  if (pathname === "/account" || pathname.startsWith("/account/")) {
    return "my account";
  }
  if (pathname.startsWith("/approve-client/")) {
    return "approve app";
  }
  // `/` (and `/channels`, which redirects to /connections) land on Home.
  return "home";
}

/**
 * Title-case the route subtitle for the browser tab. `subtitleFor` returns
 * lowercase section words ("vaults", "module config", "approve app"); the
 * `<title>` reads better capitalized ("Vaults · Parachute Hub").
 */
function documentTitleFor(pathname: string): string {
  const section = subtitleFor(pathname)
    .split(" ")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
  return `${section} · ${WORDMARK_TEXT}`;
}

export function App() {
  const { pathname } = useLocation();
  const subtitle = subtitleFor(pathname);
  const [me, setMe] = useState<MeResponse | null>(null);

  // Per-route document.title so a deep-link / multi-tab operator sees which
  // admin section a tab holds without focusing it. The static index.html
  // <title> only ever read "Parachute Hub"; this updates it on every
  // client-side navigation.
  useEffect(() => {
    document.title = documentTitleFor(pathname);
  }, [pathname]);
  const [signingOut, setSigningOut] = useState(false);
  // hub#342: surface a "Services" quick-access dropdown in the nav with
  // an entry per installed module that declares a `management_url`. One
  // round-trip per nav mount; failures collapse silently (the dropdown
  // just doesn't render).
  const [installedServices, setInstalledServices] = useState<ModuleListing[]>([]);

  // Optional admin screen-lock. Only meaningful once we have a session +
  // its CSRF token (lock APIs are session-cookie-gated, CSRF-belted).
  const csrf = me?.hasSession ? me.csrf : null;
  const lock = useAdminLock(csrf, Boolean(me?.hasSession));

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((res) => {
        if (cancelled) return;
        setMe(res);
      })
      .catch(() => {
        // Network failure — leave `me` null. Nav indicator stays in
        // the loading-collapsed state (renders nothing); the rest of
        // the SPA still works since the per-page admin Bearer mint
        // does its own redirect-to-login on 401.
        if (cancelled) return;
        setMe({ hasSession: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Don't fetch modules until we know we have a session — pre-auth
    // the listModules() call would fail with 401 and pollute the
    // console. The 401-clears-token shape in listModules cleans up
    // after itself either way; this is just noise reduction.
    if (!me || !me.hasSession) return;
    let cancelled = false;
    listModules()
      .then((catalog) => {
        if (cancelled) return;
        setInstalledServices(catalog.modules.filter((m) => m.installed));
      })
      .catch(() => {
        // Quiet failure — the dropdown just doesn't render. The Modules
        // page itself surfaces the underlying error on its own.
        if (cancelled) return;
        setInstalledServices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  // When the surface locks, drop the cached host-admin Bearer so the next
  // admin call re-mints from scratch (and gets a clean 423) rather than
  // riding a still-valid in-memory token from before the lock.
  useEffect(() => {
    if (lock.locked) clearCachedToken();
  }, [lock.locked]);

  async function onLockNow(): Promise<void> {
    if (!csrf) return;
    try {
      await lockAdminNow(csrf);
    } catch {
      // Even if the POST fails, refresh below pulls the real state.
    }
    clearCachedToken();
    lock.refresh();
  }

  async function onSignOut(csrf: string): Promise<void> {
    setSigningOut(true);
    try {
      await signOut(csrf);
      // Land on discovery so the operator immediately sees the
      // signed-out affordance (and the freshly-rebuilt session-less
      // header). Full navigation, not Link — we're leaving the SPA.
      window.location.href = "/";
    } catch {
      // Logout failed — stay put and clear the spinner; the operator
      // can retry. Realistically the only failure surface is CSRF
      // mismatch (cookie cleared in another tab) or the server being
      // down, both of which a reload will resolve.
      setSigningOut(false);
    }
  }

  // Locked → render ONLY the lock screen (one lock over the whole admin
  // surface, not per-action gating). The admin content + nav are hidden until
  // the operator unlocks. Requires the CSRF token to unlock; if somehow absent
  // we fall through to the normal shell (the server still fails admin calls
  // closed).
  if (lock.locked && csrf) {
    return <LockScreen csrf={csrf} onUnlocked={lock.refresh} />;
  }

  return (
    <div className="page">
      {/*
        Persistent admin-shell nav (admin-shell IA, R1). Always present, and
        every hub-native section is one click from anywhere. The brand links to
        Home (the orientation overview), then the hub-native sections, then —
        across a divider — the module-owned affordances (the "Surfaces" dropdown
        of user-facing module UIs + the Discovery escape hatch). The divider
        marks the hub-native ↔ module-owned boundary the same way the Home cards
        do.
      */}
      <nav className="nav">
        <Link to="/" className="brand">
          <BrandMark size={18} idSuffix="spa-nav" className="brand-mark-icon" />
          <span className="brand-wordmark">{WORDMARK_TEXT}</span>
          <span className="sub">{subtitle}</span>
        </Link>
        <AuthIndicator me={me} signingOut={signingOut} onSignOut={onSignOut} />
        {/* "Lock now" — only when an admin-lock PIN is configured. One click
            re-locks the whole admin surface (phone-style); the idle timer does
            the same automatically. Configure the PIN under Settings. */}
        {me?.hasSession && lock.configured ? (
          <button
            type="button"
            className="auth-spa-signout"
            data-testid="admin-lock-now"
            title="Lock the admin console now"
            onClick={() => void onLockNow()}
          >
            Lock now
          </button>
        ) : null}
        {/* Hub-native sections — open in-shell. Home first, then the cross-
            cutting host-admin surfaces. "Vaults" left this group in B5
            (2026-06-09 hub-module-boundary): vault lifecycle UX is module-
            owned at /vault/admin/, reachable like every other module — via
            its Home module card and the Services dropdown past the divider.
            A persistent hub-native link to a module-owned surface would
            blur the exact boundary the divider marks. */}
        <NavSection to="/" label="Home" exact />
        <NavSection to="/connections" label="Connections" />
        <NavSection to="/grants" label="Grants" />
        <NavSection to="/modules" label="Modules" />
        <NavSection to="/users" label="Users" />
        <NavSection to="/tokens" label="Tokens" />
        <NavSection to="/permissions" label="Permissions" />
        <NavSection to="/settings" label="Settings" />
        <NavSection to="/account" label="My account" />
        {/* Boundary: everything past here is module-owned / off-shell. */}
        <span className="nav-divider" aria-hidden="true" />
        <InstalledServicesDropdown services={installedServices} />
        <a href="/hub.html" title="Hub discovery page (top-level)">
          Discovery
        </a>
      </nav>

      <Routes>
        <Route path="/" element={<Home />} />
        {/* /vaults is a compatibility route (B5): VaultsList feature-detects
            a new-manifest vault and forwards to /vault/admin/; otherwise it
            renders the legacy list. /vaults/new (the retired NewVault form)
            folds into the same gate — create lives module-side now. */}
        <Route path="/vaults" element={<VaultsList />} />
        <Route path="/vaults/new" element={<Navigate to="/vaults" replace />} />
        <Route path="/modules" element={<Modules />} />
        <Route path="/users" element={<Users />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/grants" element={<Grants />} />
        {/* The pre-P5 Channels view was retired when P5 moved the feature into
            the general Connections engine. The back-compat route shouldn't
            linger as a dead end — redirect it to Connections. */}
        <Route path="/channels" element={<Navigate to="/connections" replace />} />
        <Route path="/channels/*" element={<Navigate to="/connections" replace />} />
        <Route path="/permissions" element={<Permissions />} />
        <Route path="/tokens" element={<Tokens />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/account" element={<Account />} />
        <Route path="/approve-client/:clientId" element={<ApproveClient />} />
        <Route
          path="*"
          element={
            <div className="empty">
              404 — back to <Link to="/">Home</Link>.
            </div>
          }
        />
      </Routes>

      {/* Hub version + uptime badge (hub#348). Persistent footer affordance
          so operators (especially Render auto-deployers) can confirm at a
          glance which hub version is running and when it last restarted.
          Hidden when /api/me reports no session — only signed-in operators
          ever see admin diagnostics, and /api/hub would 401 anyway. */}
      {me?.hasSession ? <HubVersionBadge /> : null}
    </div>
  );
}

/**
 * A top-level nav section link with an active-state class + `aria-current`.
 *
 * We compute the active state ourselves (prefix-match on the section path,
 * plus an optional `alsoActiveAt` exact-match alias) rather than leaning on
 * `NavLink`'s internal `aria-current`: NavLink only stamps `aria-current`
 * when ITS OWN path matches, so the index-route alias (the SPA renders
 * `<VaultsList>` at `/` as well as `/vaults`) wouldn't get the attribute.
 * A plain `<Link>` + manual flags gives full control over both the class
 * and `aria-current`, and still resolves against the router basename.
 *
 * `isPrefix` matches `/vaults` AND `/vaults/new`; the exact-segment check
 * (`pathname === to`) guards against `/tokens` lighting up for an unrelated
 * `/tokens-something` were such a route ever added.
 */
function NavSection({
  to,
  label,
  alsoActiveAt,
  exact,
}: {
  to: string;
  label: string;
  alsoActiveAt?: string;
  /**
   * Exact-match only. The Home link (`to="/"`) needs this: a prefix match on
   * `/` would light Home up on EVERY route. With `exact`, Home is active only
   * on the bare index path.
   */
  exact?: boolean;
}) {
  const { pathname } = useLocation();
  const isPrefix = exact ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);
  const aliasActive = alsoActiveAt !== undefined && pathname === alsoActiveAt;
  const active = isPrefix || aliasActive;
  return (
    <Link
      to={to}
      className={active ? "nav-link nav-link-active" : "nav-link"}
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );
}

/**
 * "Services" quick-access dropdown in the admin SPA nav (hub#342).
 *
 * Lists each installed module that declares a `management_url`, linking
 * to that URL (full-page navigation — the module owns its surface).
 * Modules that declare no `management_url` (runner today — its admin
 * surface is `configUiUrl`-only) appear as disabled items with a
 * tooltip so operators can see what's installed but-not-yet-open-able.
 *
 * Native `<details>` for the click-to-expand behavior — no client-side
 * focus management, no portal, no z-index dance. Matches the existing
 * `module-uis` `<details>` pattern in Modules.tsx.
 *
 * Renders nothing when no modules are installed yet (fresh hub) so the
 * nav doesn't show an empty "Services ▾" affordance.
 */
function InstalledServicesDropdown({ services }: { services: ModuleListing[] }) {
  if (services.length === 0) return null;
  return (
    <details className="nav-dropdown" data-testid="installed-services-dropdown">
      <summary className="nav-dropdown-summary">Services</summary>
      <div className="nav-dropdown-panel" role="menu">
        {services.map((mod) => {
          const url = mod.management_url;
          if (url) {
            return (
              <a
                key={mod.short}
                className="nav-dropdown-item"
                href={url}
                role="menuitem"
                data-testid={`nav-service-${mod.short}`}
              >
                {mod.display_name}
              </a>
            );
          }
          return (
            <span
              key={mod.short}
              className="nav-dropdown-item nav-dropdown-item-disabled"
              role="menuitem"
              aria-disabled="true"
              title="This module hasn't shipped an admin UI yet."
              data-testid={`nav-service-${mod.short}`}
            >
              {mod.display_name}
            </span>
          );
        })}
      </div>
    </details>
  );
}

interface AuthIndicatorProps {
  me: MeResponse | null;
  signingOut: boolean;
  onSignOut: (csrf: string) => Promise<void>;
}

/**
 * Nav-mounted "Signed in as <name> · Sign out" affordance. Renders nothing
 * until /api/me resolves (avoids flicker between an empty state and the
 * filled one). When signed out, renders a "Sign in" link.
 */
function AuthIndicator({ me, signingOut, onSignOut }: AuthIndicatorProps): ReactNode {
  if (me === null) return null; // first-paint, before /api/me resolves
  if (!me.hasSession) {
    return (
      <a href={`/login?next=${encodeURIComponent(window.location.pathname)}`} className="auth-spa">
        Sign in
      </a>
    );
  }
  return (
    <span className="auth-spa">
      <span className="muted">
        Signed in as <strong>{me.user.displayName}</strong>
      </span>{" "}
      ·{" "}
      <button
        type="button"
        className="auth-spa-signout"
        disabled={signingOut}
        onClick={() => {
          void onSignOut(me.csrf);
        }}
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </span>
  );
}
