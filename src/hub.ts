import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/**
 * Hub page served at `/` when the node is exposed.
 *
 * The page is a *module directory*: one tile per module type (vault, scribe,
 * notes, claw), not one row per service instance. Aaron's original shape
 * iterated `services[]` and rendered a card per entry — fine at one vault,
 * but at three vaults plus scribe + notes + claw the page reads as a flat
 * list of instances rather than the modules themselves (#168). The new shape
 * aggregates: "Vault — 3 registered — Manage →" links to the per-vault SPA at
 * `/vault`; "Scribe — 1 registered" links to the running scribe instance;
 * etc. Zero-count types are hidden entirely.
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
  .grid {
    display: grid;
    gap: 1.25rem;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.75rem;
    text-decoration: none;
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
    opacity: 0;
    animation: fadeUp 0.4s ease forwards;
  }
  .card:nth-child(1) { animation-delay: 0.02s; }
  .card:nth-child(2) { animation-delay: 0.06s; }
  .card:nth-child(3) { animation-delay: 0.1s; }
  .card:nth-child(4) { animation-delay: 0.14s; }
  .card:nth-child(5) { animation-delay: 0.18s; }
  .card:nth-child(n+6) { animation-delay: 0.22s; }
  .card:hover {
    border-color: var(--accent-light);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
    transform: translateY(-2px);
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .icon {
    width: 2.25rem;
    height: 2.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    border-radius: 8px;
    color: var(--accent);
    font-size: 1.25rem;
    flex-shrink: 0;
    overflow: hidden;
  }
  .icon img, .icon svg {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .card-title {
    font-family: var(--serif);
    font-size: 1.5rem;
    font-weight: 400;
    margin: 0;
    line-height: 1.1;
  }
  .card-count {
    color: var(--fg-muted);
    font-size: 0.95rem;
    margin: 0;
    flex-grow: 1;
  }
  .card-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.25rem;
    font-size: 0.8rem;
    color: var(--fg-dim);
  }
  .path {
    font-family: ui-monospace, 'SF Mono', Monaco, monospace;
    color: var(--fg-muted);
  }
  .manage {
    color: var(--accent);
    font-weight: 500;
  }
  .empty, .error {
    text-align: center;
    color: var(--fg-muted);
    padding: 3rem 1rem;
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
    .card { padding: 1.5rem; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Parachute</h1>
    <p class="tagline">Your personal-computing modules.</p>
  </header>
  <section id="modules" class="grid" aria-live="polite">
    <div class="empty" id="loading">Loading modules\u2026</div>
  </section>
  <footer>
    <a href="/.well-known/parachute.json">discovery</a>
  </footer>
</main>
<script>
(async () => {
  const root = document.getElementById('modules');
  const fallbackIcon = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/></svg>\`;

  // Display order for known module types. Unknown short-names append after,
  // so a third-party module mounted at /foo still gets a tile.
  const MODULE_ORDER = ['vault', 'scribe', 'notes', 'claw'];
  const MODULE_LABELS = {
    vault: 'Vault',
    scribe: 'Scribe',
    notes: 'Notes',
    claw: 'Claw',
  };

  function isVaultName(name) {
    return name === 'parachute-vault' || name.startsWith('parachute-vault-');
  }

  function shortName(manifestName) {
    return manifestName.replace(/^parachute-/, '');
  }

  function labelFor(type) {
    if (MODULE_LABELS[type]) return MODULE_LABELS[type];
    return type.charAt(0).toUpperCase() + type.slice(1);
  }

  // Aggregate services + vaults into one entry per module type. Vault is
  // special-cased because its count comes from doc.vaults[] (one entry per
  // vault instance / mount path) and its manage link goes to the hub's
  // per-vault SPA at /vault — not to any single vault backend.
  function aggregate(services, vaults) {
    const groups = new Map();
    if (vaults.length > 0) {
      groups.set('vault', {
        type: 'vault',
        label: 'Vault',
        count: vaults.length,
        manageUrl: '/vault',
      });
    }
    for (const svc of services) {
      if (isVaultName(svc.name)) continue;
      const t = shortName(svc.name);
      const existing = groups.get(t);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(t, {
          type: t,
          label: labelFor(t),
          count: 1,
          manageUrl: svc.path,
        });
      }
    }
    return groups;
  }

  function tilesInOrder(groups) {
    const out = [];
    for (const t of MODULE_ORDER) {
      const g = groups.get(t);
      if (g) out.push(g);
    }
    const known = new Set(MODULE_ORDER);
    const extras = [...groups.values()]
      .filter((g) => !known.has(g.type))
      .sort((a, b) => a.type.localeCompare(b.type));
    return out.concat(extras);
  }

  function renderTile(group) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = group.manageUrl;

    const head = document.createElement('div');
    head.className = 'card-head';

    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.innerHTML = fallbackIcon;

    const title = document.createElement('h2');
    title.className = 'card-title';
    title.textContent = group.label;

    head.appendChild(icon);
    head.appendChild(title);
    a.appendChild(head);

    const count = document.createElement('p');
    count.className = 'card-count';
    count.textContent = group.count === 1 ? '1 registered' : group.count + ' registered';
    a.appendChild(count);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = group.manageUrl;
    const manage = document.createElement('span');
    manage.className = 'manage';
    manage.textContent = 'Manage \u2192';
    meta.appendChild(path);
    meta.appendChild(manage);
    a.appendChild(meta);

    return a;
  }

  try {
    const wk = await fetch('/.well-known/parachute.json', { credentials: 'omit' });
    if (!wk.ok) throw new Error('well-known fetch failed: ' + wk.status);
    const doc = await wk.json();
    const services = Array.isArray(doc.services) ? doc.services : [];
    const vaults = Array.isArray(doc.vaults) ? doc.vaults : [];

    const groups = aggregate(services, vaults);
    const tiles = tilesInOrder(groups);

    if (tiles.length === 0) {
      root.innerHTML = '<div class="empty">No modules installed yet. Try <code>parachute install vault</code>.</div>';
      return;
    }
    root.innerHTML = '';
    for (const g of tiles) root.appendChild(renderTile(g));
  } catch (err) {
    root.innerHTML = '<div class="error">Could not load modules: ' + (err && err.message ? err.message : String(err)) + '</div>';
  }
})();
</script>
</body>
</html>
`;
