# Parachute Hub

`@openparachute/hub` — the local hub for the Parachute ecosystem. The `parachute` binary is one of its surfaces; the long-running daemon (discovery on `:1939`, soon OAuth issuance) is another. Coordinator, not a service: each Parachute package (`vault`, `notes`, `scribe`, `channel`) stays standalone; the hub stitches them together.

Renamed from `@openparachute/cli` / `parachute-cli` on 2026-04-26 — same binary name (`parachute`), same code, broader role. The "CLI" framing was always partial.

User-facing README is the right intro for operators. This file is for agents and humans working *on* the hub itself.

## Architecture

```
parachute install <svc>   →  bun add -g + init + services.json seed   (src/commands/install.ts)
parachute start/stop/...  →  spawn detached bun, pidfile + logs       (src/commands/lifecycle.ts)
parachute status          →  read services.json + probe health        (src/commands/status.ts)
parachute expose <layer>  →  tailscale serve/funnel + hub proxy       (src/commands/expose.ts)
parachute migrate         →  sweep legacy ~/.parachute/ layout         (src/commands/migrate.ts)
parachute vault <args>    →  exec parachute-vault (transparent)        (src/commands/vault.ts)
```

The flat shape matters: each command is a self-contained module in `src/commands/`, wired through `src/cli.ts`'s argv parser. No framework, no plugin system, no global state beyond a handful of pure module constants.

### Architecture surfaces

The hub serves six distinct kinds of operator-facing HTTP surface. Each is the shape it is because of its audience's constraints (JS availability, auth posture, cross-origin behavior). Content-routing surfaces (per-vault + generic services-proxy paths) sit outside the table; they're listed below it. The full route table is the header docstring in [`src/hub-server.ts`](./src/hub-server.ts); this is the layered summary.

| Layer | Shape | Audience | Why this shape |
|---|---|---|---|
| Discovery (`/`, `/hub.html`) | server-rendered HTML | unauthenticated visitors | Pre-auth entry; session-aware "Signed in as X" hydrates from cookie. Must work without JS so a brand-new operator can hit the box and see the discovery page. |
| `/login`, `/logout` | server-rendered HTML | pre-auth | The form on `/login` posts to itself, redirects on success. SPA-rendering would force a JS load just to show two text inputs, and gate first-visit auth on bundle delivery. |
| `/admin/*` | SPA (`web/ui`) | post-auth admin | Vaults, permissions, tokens, approve-client. Mounted at `/admin` so the SPA's react-router basename + service worker boundary are clean. Per-route Bearer minted from the session cookie at `/admin/host-admin-token`. |
| `/oauth/*` | server-rendered HTML + JSON | third-party OAuth clients | `/oauth/authorize` is a cross-origin redirect target — must stand alone without the SPA shell. `/oauth/token`, `/oauth/register`, `/oauth/revoke` are spec-shaped JSON per RFCs 6749 / 7591 / 7009. |
| `/api/*` | JSON, Bearer-gated (except `/api/me`) | SPA + cross-cutting consumers | Internal API for the admin SPA. Snake-case wire shape mirrors DB columns; host-admin Bearer comes from `/admin/host-admin-token`, mint-and-cache pattern in `web/ui/src/lib/auth.ts`. |
| `/.well-known/*` | JSON + wildcard CORS | public discovery | RFC 8414 metadata, JWKS, services catalog, revocation list. Wildcard CORS because cross-origin browser fetches (Notes, future SPAs, resource servers polling revocation) need to read them. |

Three surface types sit outside the operator-facing table:
- 301 back-compat redirects from legacy admin URLs (`/hub/*`, `/vault`, `/admin/login`, `/admin/config`) to the canonical `/admin/*` or `/login` surfaces. Listed at the top of `hub-server.ts`'s dispatch order so they preempt anything below.
- Per-vault content proxy (`/vault/<name>/*`) — routes to the vault backend on its services.json port. User-facing vault data (Notes PWA, MCP endpoints, etc.), not admin-scoped; vaults own their own user surfaces, the hub just stitches the path prefix.
- Generic services.json-driven proxy (`/<service-mount>/*`) — the last fallthrough, longest-prefix match against services.json. Used for non-vault modules like notes / scribe / agent.

### Shared surfaces

- **`src/service-spec.ts`** — `SERVICE_SPECS` is the registry: which npm package backs each short name, what to run on install/start, the canonical seed entry. Adding a new service = one entry here.
- **`src/services-manifest.ts`** — `~/.parachute/services.json` read/write. This file is the contract between the CLI and every service; services own the write side, the CLI owns read + exposure. Validation is strict on required fields; optional fields (`displayName`, `tagline`) pass through.
- **`src/hub-server.ts`** — internal Bun server on port 1939. Serves `/` (discovery page) and `/.well-known/parachute.json`. Spawned by `parachute expose`, stopped when the last layer goes away. Tailscale serve can't directly serve files on macOS (sandboxed), so this loopback proxy is the portable shape.
- **`src/expose-state.ts`** — which layers (tailnet/public) are currently up, persisted to `~/.parachute/expose-state.json`. Lets `expose <layer> off` be precise rather than blowing away everything.
- **`src/tailscale/`** — thin wrappers around `tailscale serve` / `tailscale funnel`. Shape is pinned to 1.82+ (`funnel` as its own subcommand).
- **`src/notes-serve.ts`** — tiny Bun static-file server for the @openparachute/notes PWA bundle. Invoked as `bun notes-serve.ts --port <n> [--dist <path>] [--mount <prefix>]`. The `--mount` arg (default `/notes`, derived from `entry.paths[0]` in the service spec) is the path prefix the reverse proxy hands us; the shim strips it before joining with `dist/`. Without the strip, requests for `/notes/sw.js` and `/notes/manifest.webmanifest` get SPA-shelled with `text/html`, the browser never sees them as the SW + manifest, and the PWA install prompt never fires. Pass `--mount ""` (or `--mount /`) when serving at the origin root.

## Key design decisions

- **Services own their write side of `services.json`.** The CLI only seeds an entry if none exists post-install (`seedEntry` in SERVICE_SPECS) — version `"0.0.0-linked"` telegraphs "stopgap, service's own boot will overwrite." Real service boots are authoritative.
- **Hub owns `/`.** Path-routing at a single canonical hostname so we never hit Tailscale Funnel's 3-port-per-node cap. Subdomain-per-service needs Tailscale Services (admin setup); out of scope for one-command install. Legacy `paths: ["/"]` entries are remapped in-memory to `/<shortname>`; `parachute install <svc>` rewrites them permanently.
- **Canonical port range 1939–1949.** Hub pins 1939 with no fallback — `tailscale serve` needs a stable localhost target, so a walking fallback would silently break cross-machine URLs. Third-party ports warn but aren't blocked.
- **`bun link` detection.** `install` checks bun's global node_modules for a symlink before `bun add -g`. Motivator: scribe isn't on npm yet; without this, `bun add -g @openparachute/scribe` 404s.
- **Runner injection seam.** Every command that shells out accepts an injectable `Runner` (`readonly string[] => Promise<number>`). Tests drive it without touching `Bun.spawn`.

## Bun-native

Bun everywhere. No Node.js runtime assumptions, no tsc for emit (types only).

- `Bun.spawn` for child processes; `stdio: ["inherit", "inherit", "inherit"]` for shell-forward commands.
- `Bun.serve` for the hub process.
- `bun test` for tests (no jest, no vitest). Tests live in `src/__tests__/`.
- `bun` reads `.ts` directly — `bin` in `package.json` points at `src/cli.ts`.

## Running

```sh
bun src/cli.ts --help            # dogfood the CLI from source
bun test ./src                   # run all tests (canonical — see "Test gate counts" below)
bun test src/__tests__/expose    # one suite
bunx biome check --write .       # format + lint
bun run typecheck                # tsc --noEmit (types only)
```

For end-to-end against a real install, `bun link` this repo; the linked `parachute` binary follows the checked-out branch (see post-merge hygiene below).

### Test gate counts in commit messages and PR descriptions

Test gate counts in commit messages and PR descriptions are produced by `bun test ./src` (the `package.json` `"test"` script), not `bun test src/__tests__/`. The latter pulls in `packages/scope-guard/` tests and produces an inflated count that's not what CI runs. When quoting numbers ("358 pass / 1 known flake"), use the literal output of `bun test ./src` — it's what the reviewer's run will produce.

## Post-merge hygiene

**After a PR merges, locally:**

```sh
git checkout main && git pull
```

Aaron's `parachute` binary is bun-linked to this checkout. Leaving the repo on a feature branch after merge means his next `parachute ...` runs stale feature-branch code, not the merged `main`. Caught 2026-04-21 after several stewards (including the old cli steward) left repos on feature branches after merge.

Every PR here is reviewer-gated — no direct-to-main, even for one-line fixes. `hotfix:` title prefix signals urgency; it doesn't skip review.

## Naming

- Domain: `parachute.computer`
- npm scope: `@openparachute/` (this package: `@openparachute/hub`; previously `@openparachute/cli` pre-2026-04-26)
- Bin name: `parachute`
- Config root: `~/.parachute/` (override with `PARACHUTE_HOME`)
- Per-service dirs: `~/.parachute/<short>/` (e.g. `~/.parachute/vault/`)
- Short names (map to `manifestName` via `SERVICE_SPECS`): `vault`, `notes`, `scribe`, `channel`. `lens` is a transition alias for `notes` on `parachute install` (one release cycle, residue from the brief Notes→Lens→Notes round-trip on 2026-04-19/22); removed post-launch.

## License

AGPL-3.0.
