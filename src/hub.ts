import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

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

export function renderHub(): string {
  return HTML;
}

export function writeHubFile(path: string = HUB_PATH): string {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, HTML);
  renameSync(tmp, path);
  return path;
}

const HTML = `<!doctype html>
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
  }
</style>
</head>
<body>
<main>
  <header>
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

  // Services entries: each service's primary surface. Hardcoded short→label
  // map; path is derived from services.json so custom mounts still work.
  // Vault deliberately omitted — its content is browsed via Notes (which
  // is its own entry below). Operators provision/admin vaults from the
  // /admin/vaults card in the Admin section.
  const SERVICE_LABELS = {
    notes:  { title: 'Notes', desc: 'Browse your vault content.' },
    scribe: { title: 'Scribe', desc: 'Transcribe audio.' },
    agent:  { title: 'Agent', desc: 'Run agents on this hub.' },
  };
  const SERVICE_ORDER = ['notes', 'scribe', 'agent'];

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

  function isVaultName(name) {
    return name === 'parachute-vault' || name.startsWith('parachute-vault-');
  }

  function renderTile({ title, desc, href }) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = href;

    const t = document.createElement('h3');
    t.className = 'card-title';
    t.textContent = title;
    a.appendChild(t);

    const d = document.createElement('p');
    d.className = 'card-desc';
    d.textContent = desc;
    a.appendChild(d);

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
    // Group services by short type. Multiple instances of the same type
    // (e.g. two scribes) collapse into one entry pointing at the first
    // — operators with that posture will know which one they meant.
    // Vault entries are skipped per the comment above.
    const byType = new Map();
    for (const svc of services) {
      if (isVaultName(svc.name)) continue;
      const t = shortName(svc.name);
      if (!byType.has(t)) byType.set(t, svc.path);
    }

    const tiles = [];
    for (const t of SERVICE_ORDER) {
      const path = byType.get(t);
      if (!path) continue;
      const labels = SERVICE_LABELS[t];
      tiles.push({ title: labels.title, desc: labels.desc, href: path });
    }

    servicesGrid.innerHTML = '';
    if (tiles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = 'No services installed yet. Try <code>parachute install vault</code>.';
      servicesGrid.appendChild(empty);
      return;
    }
    for (const tile of tiles) servicesGrid.appendChild(renderTile(tile));
  }

  // Admin section is static — render synchronously so the operator sees it
  // even if the well-known fetch is slow or fails.
  renderAdmin();

  try {
    const wk = await fetch('/.well-known/parachute.json', { credentials: 'omit' });
    if (!wk.ok) throw new Error('well-known fetch failed: ' + wk.status);
    const doc = await wk.json();
    const services = Array.isArray(doc.services) ? doc.services : [];
    renderServices(services);
  } catch (err) {
    servicesGrid.innerHTML = '<div class="error">Could not load services: ' +
      (err && err.message ? err.message : String(err)) + '</div>';
  }
})();
</script>
</body>
</html>
`;
