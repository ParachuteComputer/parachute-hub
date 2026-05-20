import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import { CSRF_FIELD_NAME } from "./csrf.ts";

/**
 * Hub page served at `/` when the node is exposed.
 *
 * The page is split into two sections, organized by **ownership**:
 *
 *   - **Services** — surfaces provided by the modules running on this
 *     hub. Browse notes (the Notes PWA); transcribe audio (Scribe); run
 *     agents (Agent). Each entry points at the service's own UI; the
 *     service owns what's behind the link (use, config, admin —
 *     whatever it chooses to surface). Entries are dynamic, derived
 *     from `/.well-known/parachute.json`; only installed services show
 *     up. Vault deliberately doesn't have its own Services entry — its
 *     content is browsed via Notes, so a separate "Vault" tile would
 *     just send the operator to the admin SPA, which is exactly the
 *     friction Aaron flagged ("clicked Vault, took me to hub management").
 *
 *   - **Admin** — hub-owned admin surfaces for cross-cutting host
 *     concerns. Always visible: even with zero vaults installed, an
 *     operator may want to provision the first one. Three entries:
 *     Vaults (provisioning), Permissions (OAuth consent grants), Tokens
 *     (registry mint/list/revoke).
 *
 * The Services-vs-Admin axis is ownership, not function: services-owned
 * UIs vs hub-owned UIs. The first cut framed it as "Use vs Admin" but
 * that broke down once you noticed real services have UIs that mix use,
 * config, and admin together — the cleaner cut is who's hosting the UI.
 *
 * The file stays self-contained (inline CSS + JS, no external assets) so
 * `tailscale serve` can mount it directly from disk with `--set-path=/`.
 */

export const HUB_PATH = join(CONFIG_DIR, "well-known", "hub.html");
export const HUB_MOUNT = "/";

export interface RenderHubSession {
  /** displayName from /api/me semantics — username today, profile field later. */
  displayName: string;
  /** Per-session CSRF token; embedded in the inline sign-out form. */
  csrfToken: string;
}

export interface RenderHubOpts {
  /**
   * When set, renders "Signed in as <displayName>" + an inline sign-out
   * form. When omitted (or null), renders a "Sign in" link. Pass through
   * from `findActiveSession` + `ensureCsrfToken` in the hub-server `/`
   * handler — the static-disk write path (`writeHubFile`) emits the
   * signed-out shape, since that file gets served only when the
   * dynamic path can't (`!getDb`).
   */
  session?: RenderHubSession | null;
}

export function renderHub(opts: RenderHubOpts = {}): string {
  return buildHtml(opts);
}

/**
 * Write the static signed-out HTML to disk. Used by `parachute expose` so
 * `tailscale serve --set-path=/` has a file to back. The dynamic
 * session-aware path runs through `hub-server.ts`'s `/` handler whenever
 * a DB is configured; this disk file is the fallback when it isn't.
 */
export function writeHubFile(path: string = HUB_PATH): string {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const html = renderHub();
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, html);
  renameSync(tmp, path);
  return path;
}

function buildHtml({ session }: RenderHubOpts): string {
  const authBlock = session
    ? renderSignedIn(session.displayName, session.csrfToken)
    : renderSignedOut();
  return HTML_TEMPLATE.replace("<!--AUTH-INDICATOR-->", authBlock);
}

function renderSignedIn(displayName: string, csrfToken: string): string {
  // Inline POST form so sign-out works without JS. Submit button is
  // styled as a text link via `.auth-signout` so the visual weight
  // matches the surrounding "Signed in as <name>" text.
  return `<div class="auth-indicator">
      <span class="muted">Signed in as <strong>${escapeHtml(displayName)}</strong></span>
      <form method="POST" action="/logout" class="auth-signout-form">
        <input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeAttr(csrfToken)}" />
        <button type="submit" class="auth-signout">Sign out</button>
      </form>
    </div>`;
}

function renderSignedOut(): string {
  return `<div class="auth-indicator">
      <a href="/login?next=/" class="auth-signin">Sign in</a>
    </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Parachute</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E\u{1FA82}%3C/text%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600&display=swap" />
<style>
  :root {
    --bg: #faf8f4;
    --bg-soft: #f3f0ea;
    --fg: #2c2a26;
    --fg-muted: #6b6860;
    --fg-dim: #9a9690;
    --accent: #4a7c59;
    --accent-soft: rgba(74, 124, 89, 0.08);
    --accent-hover: #3d6849;
    --accent-light: #6a9b77;
    --border: #e4e0d8;
    --card-bg: #ffffff;
    --serif: 'Instrument Serif', Georgia, serif;
    --sans: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1917;
      --bg-soft: #24221f;
      --fg: #e8e4dc;
      --fg-muted: #a8a49a;
      --fg-dim: #6b6860;
      --accent: #7ab08a;
      --accent-soft: rgba(122, 176, 138, 0.1);
      --accent-hover: #8fc49e;
      --accent-light: #8fc49e;
      --border: #3a3733;
      --card-bg: #24221f;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 4rem 1.5rem 6rem;
  }
  header {
    text-align: center;
    margin-bottom: 3.5rem;
    position: relative;
  }
  /* Auth indicator: small text + sign-in/out affordance, top-right of the
     header. Doesn't crowd the centered title; falls below the title on
     narrow viewports via the media query at the bottom of this stylesheet. */
  .auth-indicator {
    position: absolute;
    top: 0;
    right: 0;
    display: inline-flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--fg-muted);
  }
  .auth-indicator .muted {
    color: var(--fg-muted);
  }
  .auth-indicator strong {
    font-weight: 600;
    color: var(--fg);
  }
  .auth-signout-form {
    margin: 0;
    display: inline;
  }
  .auth-signout, .auth-signin {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  .auth-signout:hover, .auth-signin:hover {
    color: var(--accent-hover);
  }
  a.auth-signin {
    /* Anchor needs explicit reset since the a element has its own
       color/decoration. */
    border-bottom: none;
  }
  h1 {
    font-family: var(--serif);
    font-weight: 400;
    font-size: clamp(2.75rem, 6vw, 4rem);
    line-height: 1.05;
    margin: 0 0 0.75rem;
    letter-spacing: -0.01em;
  }
  .tagline {
    color: var(--fg-muted);
    font-size: 1.1rem;
    margin: 0;
  }
  .section {
    margin-bottom: 3rem;
  }
  .section h2 {
    font-family: var(--serif);
    font-weight: 400;
    font-size: 1.5rem;
    color: var(--fg);
    margin: 0 0 0.4rem;
    letter-spacing: -0.005em;
  }
  .section .section-sub {
    color: var(--fg-muted);
    font-size: 0.92rem;
    margin: 0 0 1.25rem;
  }
  .grid {
    display: grid;
    gap: 1.25rem;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    text-decoration: none;
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
    opacity: 0;
    animation: fadeUp 0.4s ease forwards;
  }
  .card:nth-child(1) { animation-delay: 0.02s; }
  .card:nth-child(2) { animation-delay: 0.06s; }
  .card:nth-child(3) { animation-delay: 0.1s; }
  .card:nth-child(4) { animation-delay: 0.14s; }
  .card:hover {
    border-color: var(--accent-light);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
    transform: translateY(-2px);
  }
  .card-title {
    font-family: var(--serif);
    font-size: 1.4rem;
    font-weight: 400;
    margin: 0;
    line-height: 1.1;
    color: var(--fg);
  }
  .card-desc {
    color: var(--fg-muted);
    font-size: 0.92rem;
    margin: 0;
    flex-grow: 1;
  }
  .card-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.5rem;
    font-size: 0.8rem;
    color: var(--fg-dim);
  }
  .path {
    font-family: ui-monospace, 'SF Mono', Monaco, monospace;
    color: var(--fg-muted);
  }
  .arrow {
    color: var(--accent);
    font-weight: 500;
  }
  .empty, .error {
    text-align: center;
    color: var(--fg-muted);
    padding: 1.5rem 1rem;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .empty code, .error code {
    font-family: ui-monospace, 'SF Mono', Monaco, monospace;
    background: var(--bg-soft);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: var(--accent);
  }
  footer {
    text-align: center;
    margin-top: 4rem;
    color: var(--fg-dim);
    font-size: 0.85rem;
  }
  footer a {
    color: var(--fg-muted);
    text-decoration: none;
    border-bottom: 1px solid var(--border);
  }
  footer a:hover {
    color: var(--accent);
    border-bottom-color: var(--accent-light);
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (max-width: 640px) {
    main { padding: 2.5rem 1rem 4rem; }
    .card { padding: 1.25rem; }
    /* Auth indicator drops below the title on narrow viewports so the
       header doesn't crowd. */
    header { padding-top: 1.75rem; }
    .auth-indicator { font-size: 0.8rem; }
  }
</style>
</head>
<body>
<main>
  <header>
    <!--AUTH-INDICATOR-->
    <h1>Parachute</h1>
    <p class="tagline">Your personal-computing modules.</p>
  </header>

  <section class="section" id="services-section">
    <h2>Services</h2>
    <p class="section-sub">Surfaces provided by services running on this hub.</p>
    <div class="grid" id="services-grid" aria-live="polite">
      <div class="empty" id="services-loading">Loading…</div>
    </div>
  </section>

  <section class="section" id="admin-section">
    <h2>Admin</h2>
    <p class="section-sub">Manage this hub — vaults, permissions, tokens.</p>
    <div class="grid" id="admin-grid"></div>
  </section>

  <footer>
    <a href="/.well-known/parachute.json">discovery</a>
  </footer>
</main>
<script>
(async () => {
  const servicesGrid = document.getElementById('services-grid');
  const adminGrid = document.getElementById('admin-grid');

  // Services entries are now data-driven from /.well-known/parachute.json.
  // Each services[] row carries (since hub#... — Phase D consumer side):
  //   - displayName: human label (sourced from module.json:displayName).
  //   - uiUrl: where the user-facing UI lives (sourced from module.json:uiUrl).
  //     A row WITHOUT uiUrl declines to render a tile — the module is
  //     either API-only (vault, scribe-without-UI) or surfaces its UI
  //     through a sibling (vault → Notes).
  // The previous SERVICE_LABELS / SERVICE_ORDER / isVaultName hardcoding
  // is retired: vault has no uiUrl, so the "skip vault" rule emerges
  // from data rather than a name check; ordering is alphabetical-by-
  // displayName per the module-json-extensibility pattern doc.

  // Admin entries: always visible. Even a fresh hub with zero vaults wants
  // the operator to find /admin/vaults. Hardcoded — they live in the
  // hub-served SPA, not in services.json.
  const ADMIN_ENTRIES = [
    { title: 'Vaults', desc: 'Create and manage vaults on this hub.', href: '/admin/vaults' },
    { title: 'Permissions', desc: 'OAuth consent grants per app.', href: '/admin/permissions' },
    { title: 'Tokens', desc: 'Mint and revoke access tokens.', href: '/admin/tokens' },
  ];

  function shortName(manifestName) {
    return manifestName.replace(/^parachute-/, '');
  }

  function renderTile({ title, desc, href }) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = href;

    const t = document.createElement('h3');
    t.className = 'card-title';
    t.textContent = title;
    a.appendChild(t);

    if (desc) {
      const d = document.createElement('p');
      d.className = 'card-desc';
      d.textContent = desc;
      a.appendChild(d);
    }

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = href;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '→';
    meta.appendChild(path);
    meta.appendChild(arrow);
    a.appendChild(meta);

    return a;
  }

  function renderAdmin() {
    adminGrid.innerHTML = '';
    for (const entry of ADMIN_ENTRIES) {
      adminGrid.appendChild(renderTile(entry));
    }
  }

  function renderServices(services) {
    // Render one tile per service that declares a uiUrl. Entries without
    // uiUrl are intentionally omitted — vault is the canonical example
    // (its content is browsed via Notes, which has its own uiUrl row).
    // Multiple entries with the same shortName collapse into one tile;
    // operators with two scribe instances pick the first arbitrarily,
    // and they'd know which they meant.
    const byShort = new Map();
    for (const svc of services) {
      if (!svc || !svc.uiUrl) continue;
      const key = shortName(svc.name);
      if (byShort.has(key)) continue;
      byShort.set(key, {
        title: svc.displayName || key,
        desc: svc.tagline || '',
        href: svc.uiUrl,
      });
    }

    // Alphabetical-by-displayName per the module-json-extensibility pattern.
    // Stable for shared-prefix labels (Notes, Notes-Lite would sort that way).
    const tiles = Array.from(byShort.values()).sort((a, b) =>
      a.title.localeCompare(b.title),
    );

    servicesGrid.innerHTML = '';
    if (tiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML =
        'No services with a UI declared yet. Modules surface their UIs by ' +
        'declaring <code>uiUrl</code> in <code>module.json</code> ' +
        '(see the module-json-extensibility pattern).';
      servicesGrid.appendChild(empty);
      return;
    }
    for (const tile of tiles) servicesGrid.appendChild(renderTile(tile));
  }

  // Admin section is static — render synchronously so the operator sees it
  // even if the well-known fetch is slow or fails.
  renderAdmin();

  // Fetch services and render. cache 'no-store' on the fetch matters
  // here: without it, the browser's HTTP cache returns the stale
  // services list the next time the operator clicks back to / after
  // installing a module via /admin/modules. Server-side also sets
  // cache-control no-store on the well-known doc; belt-and-suspenders
  // since older browsers (and some intermediaries) ignore one or the
  // other (hub#268 Item 1).
  async function loadServices() {
    try {
      const wk = await fetch('/.well-known/parachute.json', {
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!wk.ok) throw new Error('well-known fetch failed: ' + wk.status);
      const doc = await wk.json();
      const services = Array.isArray(doc.services) ? doc.services : [];
      renderServices(services);
    } catch (err) {
      servicesGrid.innerHTML = '<div class="error">Could not load services: ' +
        (err && err.message ? err.message : String(err)) + '</div>';
    }
  }

  // Re-fetch on pageshow (covers the bfcache-restore path: when an
  // operator clicks back from /admin/modules to / the browser may
  // restore the prior DOM without re-running the IIFE, leaving stale
  // tiles). The event's persisted flag is the bfcache discriminator —
  // true when the page was rehydrated from cache, false on a fresh
  // load. On fresh load the initial loadServices() below already ran,
  // so we only re-fetch when persisted is true.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) void loadServices();
  });

  void loadServices();
})();
</script>
</body>
</html>
`;
