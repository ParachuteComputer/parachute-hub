/**
 * /admin — the Home / Overview landing for the admin shell (admin-shell IA, R1).
 *
 * Before R1, `/admin` dumped the operator straight onto VaultsList, and the
 * server-rendered discovery page at `/` was a SECOND, disconnected surface
 * (its Services tiles opened a module's own UI; its Admin tiles only reached
 * Vaults/Permissions/Tokens). Connections / Modules / Users / Settings weren't
 * reachable from home at all, and the hub-native-vs-module-owned boundary was
 * invisible — clicking "Vault" stranded you in vault's own app.
 *
 * This Home is the single orientation surface. It absorbs the old discovery
 * page's content into three clearly-separated groups:
 *
 *   1. **Administer (hub)** — in-shell links to every hub-native section
 *      (Connections, Modules, Users, Tokens, Permissions, Settings). These open
 *      WITHIN the admin shell (react-router `<Link>`), so the persistent nav
 *      stays put and you never lose your place. Vault management lives under
 *      the Vault module card below — not here — because the hub-rendered vault
 *      list IS the vault module's admin surface.
 *
 *   2. **Modules** — one card per installed module. Vault is special: it has no
 *      separate admin SPA of its own — the hub SPA is vault's admin — so its
 *      card opens `/vaults` in-shell (no `↗`). All other modules open their own
 *      admin/config UI off-shell (full-page `<a href>`, explicit `↗` mark +
 *      "opens <module>'s own admin" caption). Modules without any URL render
 *      disabled with a "no admin UI yet" note (never a dead 404 click).
 *
 *   3. **Your surfaces** — the user-facing module UIs (Notes etc.) sourced from
 *      each installed module's hosted-UI sub-units (`uis[]`). These are the
 *      `uiUrl` tiles that lived on the old discovery page; kept reachable here
 *      so an operator can jump straight into "browse my content" from the shell.
 *
 * The visual through-line: hub-native sections (including the Vault card) read
 * as in-shell cards (no external arrow); module-owned + user surfaces carry the
 * `↗` external mark. That contrast IS the clarity fix.
 *
 * Data: a single `/api/modules` round-trip drives both the Modules and Your
 * surfaces groups (it already carries `config_ui_url` / `management_url` and the
 * `uis[]` sub-units). The Administer group is static — those sections live in
 * the hub SPA, not in services.json. A modules-fetch failure degrades the two
 * module-driven groups to a small inline note; the Administer group always
 * renders so the operator can always reach the hub-native sections.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type ModuleListing, type ModuleUiSubUnit, listModules } from "../lib/api.ts";

/** A hub-native section reachable in-shell. Order = how an operator scans. */
interface HubSection {
  to: string;
  label: string;
  desc: string;
}

/**
 * The hub-native sections, in the order the old discovery page + operator
 * feedback prioritized: Connections first (the operator's "I clicked vault
 * admin just to get to Connections" complaint), then the rest of cross-cutting
 * host admin. These are hardcoded — they're SPA routes, not services.json data.
 */
const HUB_SECTIONS: readonly HubSection[] = [
  {
    to: "/connections",
    label: "Connections",
    desc: "Wire a module event to another module's action.",
  },
  { to: "/modules", label: "Modules", desc: "Install, upgrade, and manage modules." },
  { to: "/users", label: "Users", desc: "Manage operators and invite members." },
  { to: "/tokens", label: "Tokens", desc: "Mint and revoke access tokens." },
  { to: "/permissions", label: "Permissions", desc: "OAuth consent grants per app." },
  { to: "/settings", label: "Settings", desc: "Canonical URL, install channel, more." },
];

type ModulesState =
  | { kind: "loading" }
  | { kind: "ok"; modules: ModuleListing[] }
  | { kind: "error"; message: string };

/** A user-facing surface tile, flattened from a module's `uis[]` sub-units. */
interface SurfaceTile {
  key: string;
  label: string;
  tagline: string | null;
  href: string;
  ownerLabel: string;
}

export function Home() {
  const [state, setState] = useState<ModulesState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    listModules()
      .then((catalog) => {
        if (cancelled) return;
        setState({ kind: "ok", modules: catalog.modules.filter((m) => m.installed) });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const installedModules = state.kind === "ok" ? state.modules : [];
  // "Your surfaces" — flatten each installed module's hosted-UI sub-units into
  // user-facing tiles. These are the discovery page's old `uiUrl` tiles; the
  // sub-unit registry is how modules (Surface → Notes, etc.) declare them now.
  const surfaceTiles: SurfaceTile[] = installedModules.flatMap((m) =>
    m.uis.map((u: ModuleUiSubUnit) => ({
      key: `${m.short}:${u.name}`,
      label: u.display_name,
      tagline: u.tagline,
      href: u.path,
      ownerLabel: m.display_name,
    })),
  );

  return (
    <div data-route-content="true" className="admin-home">
      <div className="list-header">
        <h1>Hub</h1>
      </div>
      <p className="muted">
        Everything on this hub, in one place. Hub-native sections open here in the admin shell;
        module surfaces (marked <span className="ext-mark">↗</span>) open the module's own UI.
      </p>

      {/* 1. Administer (hub) — in-shell hub-native sections. */}
      <section className="home-group" data-testid="home-administer">
        <div className="home-group-head">
          <h2>Administer</h2>
          <span className="home-group-tag home-group-tag-hub">hub</span>
        </div>
        <p className="muted home-group-sub">
          Cross-cutting host admin. Opens here in the shell — the nav stays with you.
        </p>
        <div className="home-grid">
          {HUB_SECTIONS.map((s) => (
            <Link key={s.to} to={s.to} className="home-card home-card-hub" data-section={s.to}>
              <span className="home-card-title">{s.label}</span>
              <span className="home-card-desc">{s.desc}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* 2. Modules — each opens the MODULE's OWN admin/config UI (off-shell). */}
      <section className="home-group" data-testid="home-modules">
        <div className="home-group-head">
          <h2>Modules</h2>
          <span className="home-group-tag home-group-tag-module">module-owned</span>
        </div>
        <p className="muted home-group-sub">
          Installed modules. Vault opens here in the shell; other modules open their own admin
          surface outside the hub shell. Manage install / upgrade / restart from{" "}
          <Link to="/modules">Modules</Link>.
        </p>
        {state.kind === "loading" ? (
          <p className="muted" data-loading="true">
            Loading modules…
          </p>
        ) : state.kind === "error" ? (
          <p className="muted" data-testid="home-modules-error">
            Couldn't load modules ({state.message}). Open <Link to="/modules">Modules</Link>{" "}
            directly.
          </p>
        ) : installedModules.length === 0 ? (
          <p className="muted" data-testid="home-modules-empty">
            No modules installed yet. <Link to="/modules">Install one →</Link>
          </p>
        ) : (
          <div className="home-grid">
            {installedModules.map((m) => (
              <ModuleAdminCard key={m.short} module={m} />
            ))}
          </div>
        )}
      </section>

      {/* 3. Your surfaces — user-facing module UIs (Notes etc.), off-shell. */}
      {surfaceTiles.length > 0 ? (
        <section className="home-group" data-testid="home-surfaces">
          <div className="home-group-head">
            <h2>Your surfaces</h2>
            <span className="home-group-tag home-group-tag-module">module-owned</span>
          </div>
          <p className="muted home-group-sub">
            The user-facing apps these modules host. Opens the app — outside the hub shell.
          </p>
          <div className="home-grid">
            {surfaceTiles.map((t) => (
              <a
                key={t.key}
                href={t.href}
                className="home-card home-card-surface"
                data-testid={`home-surface-${t.key}`}
              >
                <span className="home-card-title">
                  {t.label} <span className="ext-mark">↗</span>
                </span>
                {t.tagline ? <span className="home-card-desc">{t.tagline}</span> : null}
                <span className="home-card-owner">opens {t.ownerLabel}'s surface</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * One installed-module card on the Home overview.
 *
 * **Vault is special**: the hub SPA *is* vault's admin — there is no separate
 * vault admin SPA. So vault's card opens `/vaults` in-shell via a react-router
 * `<Link>` (no `↗` mark, `home-card-hub` treatment). The "all vaults + click
 * through to each" experience lives there.
 *
 * **All other modules** link to the module's OWN admin/config UI
 * (`config_ui_url` first — the module's dedicated config surface — falling back
 * to `management_url`). Full-page `<a href>` (NOT a react-router `<Link>`)
 * because we're LEAVING the shell; the `↗` mark + owner caption make that
 * boundary explicit.
 *
 * A non-vault module that declares neither URL (scribe, runner today) renders
 * as a disabled card with a "no admin UI yet" note rather than a dead click —
 * the operator still sees it's installed.
 */
function ModuleAdminCard({ module: m }: { module: ModuleListing }) {
  // Vault: hub-native admin lives at /vaults — open in-shell, no external mark.
  if (m.short === "vault") {
    return (
      <Link
        to="/vaults"
        className="home-card home-card-hub"
        data-testid={`home-module-${m.short}`}
      >
        <span className="home-card-title">{m.display_name}</span>
        {m.tagline ? <span className="home-card-desc">{m.tagline}</span> : null}
        <span className="home-card-owner">manage all vaults — opens here</span>
      </Link>
    );
  }

  const adminUrl = m.config_ui_url ?? m.management_url;
  if (!adminUrl) {
    return (
      <div
        className="home-card home-card-module home-card-disabled"
        data-testid={`home-module-${m.short}`}
        aria-disabled="true"
      >
        <span className="home-card-title">{m.display_name}</span>
        {m.tagline ? <span className="home-card-desc">{m.tagline}</span> : null}
        <span className="home-card-owner home-card-owner-empty">no admin UI yet</span>
      </div>
    );
  }
  return (
    <a
      href={adminUrl}
      className="home-card home-card-module"
      data-testid={`home-module-${m.short}`}
    >
      <span className="home-card-title">
        {m.display_name} <span className="ext-mark">↗</span>
      </span>
      {m.tagline ? <span className="home-card-desc">{m.tagline}</span> : null}
      <span className="home-card-owner">opens {m.display_name}'s own admin</span>
    </a>
  );
}
