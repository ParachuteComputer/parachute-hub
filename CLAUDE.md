# Parachute Hub

`@openparachute/hub` — the local hub for the Parachute ecosystem. The `parachute` binary is one of its surfaces; the long-running `parachute serve` process (discovery on `:1939`, soon OAuth issuance) is another — it runs under the platform's process manager (launchd / systemd / container runtime) and supervises every installed module as an attached child. Coordinator, not a service: each Parachute package (`vault`, `notes`, `scribe`, `agent`) stays standalone; the hub stitches them together.

Renamed from `@openparachute/cli` / `parachute-cli` on 2026-04-26 — same binary name (`parachute`), same code, broader role. The "CLI" framing was always partial.

User-facing README is the right intro for operators. This file is for agents and humans working *on* the hub itself.

## Architecture

```
parachute serve           →  hub foreground + in-process Supervisor    (src/commands/serve.ts + src/supervisor.ts)
parachute install <svc>   →  bun add -g + init + services.json seed     (src/commands/install.ts)
parachute init            →  install + start the hub unit, then wizard  (src/commands/init.ts + src/hub-unit.ts)
parachute start/stop/...  →  ensure hub unit up, drive the supervisor   (src/commands/lifecycle.ts → module-ops API)
parachute status          →  platform manager (hub) + supervisor.list() (src/commands/status.ts)
parachute expose <layer>  →  tailscale serve/funnel (hub stays running) (src/commands/expose.ts)
parachute migrate         →  --to-supervised cutover / archive sweep    (src/commands/migrate.ts)
parachute vault <args>    →  exec parachute-vault (transparent)         (src/commands/vault.ts)
```

**One runtime: `parachute serve` under a process manager.** The hub runs foreground with an in-process `Supervisor` (`src/supervisor.ts`) that spawns each installed module as an attached child, multiplexes their logs, and crash-restarts them on a budget. That `serve` process is kept alive by the platform's own process manager — **launchd** on a Mac, **systemd** on a Linux VM (installed by `parachute init` / `parachute migrate --to-supervised`), the **container runtime** on Render / Fly. There is **no detached-daemon model** anymore: the per-module `start/stop/restart <svc>` verbs are *clients* of the running supervisor — they ensure the hub unit is up (via `src/hub-unit.ts`), then drive it over the loopback module-ops HTTP API (`src/api-modules-ops.ts`, authenticated with the on-disk operator token, `src/module-ops-client.ts`). Per-module pidfile spawning was retired in Phase 5b; `src/process-state.ts` keeps pidfile *readers* only, for the `migrate` legacy-install detector.

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
- **`src/hub-server.ts`** — the Bun server on port 1939, the thing `parachute serve` runs in the foreground. Serves `/` (discovery page) and `/.well-known/parachute.json`. It's a persistent managed unit (launchd / systemd / container runtime), running whether or not any exposure layer is up — `expose off` tears down only the exposure, not the hub. Tailscale serve can't directly serve files on macOS (sandboxed), so this loopback proxy is the portable shape.
- **`src/expose-state.ts`** — which layers (tailnet/public) are currently up, persisted to `~/.parachute/expose-state.json`. Lets `expose <layer> off` be precise rather than blowing away everything.
- **`src/tailscale/`** — thin wrappers around `tailscale serve` / `tailscale funnel`. Shape is pinned to 1.82+ (`funnel` as its own subcommand).
- **`src/notes-serve.ts`** — tiny Bun static-file server, originally for the @openparachute/notes PWA bundle, generalized in hub-parity P5 (2026-07-11) to serve any first-party frontend bundle of the same shape (a prebuilt SPA `dist/` with no server of its own) — @openparachute/parachute-app (mount `/app`, port 1944) is the second consumer. Invoked as `bun notes-serve.ts --port <n> [--dist <path>] [--mount <prefix>] [--package <npmName>]`. The `--mount` arg (default `/notes`, derived from `entry.paths[0]` in the service spec) is the path prefix the reverse proxy hands us; the shim strips it before joining with `dist/`. Without the strip, requests for `/notes/sw.js` and `/notes/manifest.webmanifest` get SPA-shelled with `text/html`, the browser never sees them as the SW + manifest, and the PWA install prompt never fires. Pass `--mount ""` (or `--mount /`) when serving at the origin root. `--package` (default `@openparachute/notes`, back-compat) names the npm package whose `dist/` gets resolved when `--dist` is omitted — the `app` FIRST_PARTY_FALLBACKS entry's `startCmd` passes `--package @openparachute/parachute-app`. `/health` (post-mount-strip) is answered explicitly rather than falling through to the SPA shell.

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

Three invocations produce three different numbers. Which to cite depends on what the PR actually touches.

| Command | What it runs | When to cite |
|---|---|---|
| `bun test ./src` | hub's own tests only (`src/__tests__/`) | PRs that touch only `src/` — most hub work. This is the `package.json` `"test"` script. |
| `bun test packages/scope-guard/src` | scope-guard package tests only | scope-guard-only PRs (rare standalone) |
| Both, cited as a pair | hub + scope-guard, separately | PRs whose substance lives in `packages/scope-guard/` and reaches into `src/` — cite "hub: <hub-count>, scope-guard: <sg-count>" |

What **not** to use:

- `bun test src/__tests__/` — same coverage as `bun test ./src` but with a non-canonical path. Use the script form.
- `bun test src` (no `./`) — Bun's path resolver picks up *both* `src/` and `packages/scope-guard/src/` in one run, producing a single inflated number that doesn't match what CI's per-package split runs. Two suites sharing a process can also exhibit cross-suite interference (errors that don't reproduce in either suite alone). Don't cite this number; if both suites are relevant, run them separately and report both.

The reviewer's run uses `bun run test` (= `bun test ./src`) plus a separate scope-guard invocation when relevant. Mirror that shape in commit messages so the numbers line up.

Pinned during hub#217 — reviewer cited a combined number; tentacle cited a hub-only number. Both were defensible under the prior wording. Resolution per hub#219: cite hub-only by default; cite as a pair when scope-guard is load-bearing in the PR.

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
- Active first-party short names: `vault`, `scribe`, and `surface`. `notes` remains a deprecated compatibility install. Historical `agent`, `channel`, `claw`, and `parachute-agent` identities are retired; old directories remain migration/archive inputs only. `lens` remains a transition alias for `notes` until the Notes compatibility path is removed.

## License

AGPL-3.0.
