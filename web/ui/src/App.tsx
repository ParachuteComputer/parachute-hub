/**
 * Parachute Admin SPA.
 *
 * Hub-served browser UI for cross-cutting host concerns:
 *
 *   - **`/admin/vaults`** — vault provisioning. List + create. Per-vault
 *     content (the Notes PWA, etc.) lives at `/vault/<name>/*` and is NOT
 *     part of this SPA — vaults own their own user-facing surfaces.
 *   - **`/admin/permissions`** — OAuth consent grant management.
 *   - **`/admin/tokens`** — token registry: mint, list, revoke.
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
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { type MeResponse, getMe, signOut } from "./lib/api.ts";
import { ApproveClient } from "./routes/ApproveClient.tsx";
import { Modules } from "./routes/Modules.tsx";
import { NewVault } from "./routes/NewVault.tsx";
import { Permissions } from "./routes/Permissions.tsx";
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
  if (pathname.startsWith("/approve-client/")) {
    return "approve app";
  }
  return "vaults";
}

export function App() {
  const { pathname } = useLocation();
  const subtitle = subtitleFor(pathname);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [signingOut, setSigningOut] = useState(false);

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

  return (
    <div className="page">
      <nav className="nav">
        <Link to="/vaults" className="brand">
          Parachute Admin <span className="sub">{subtitle}</span>
        </Link>
        <AuthIndicator me={me} signingOut={signingOut} onSignOut={onSignOut} />
        <Link to="/vaults">Vaults</Link>
        <Link to="/modules">Modules</Link>
        <Link to="/users">Users</Link>
        <Link to="/permissions">Permissions</Link>
        <Link to="/tokens">Tokens</Link>
        <span className="nav-divider" aria-hidden="true" />
        <a href="/" title="Hub discovery page (top-level)">
          Discovery
        </a>
      </nav>

      <Routes>
        <Route path="/" element={<VaultsList />} />
        <Route path="/vaults" element={<VaultsList />} />
        <Route path="/vaults/new" element={<NewVault />} />
        <Route path="/modules" element={<Modules />} />
        <Route path="/users" element={<Users />} />
        <Route path="/permissions" element={<Permissions />} />
        <Route path="/tokens" element={<Tokens />} />
        <Route path="/approve-client/:clientId" element={<ApproveClient />} />
        <Route
          path="*"
          element={
            <div className="empty">
              404 — back to <Link to="/vaults">vaults</Link>.
            </div>
          }
        />
      </Routes>
    </div>
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
