# Parachute Hub

`@openparachute/hub` — the local hub for the Parachute ecosystem. The `parachute` binary is one of its surfaces; the long-running `parachute serve` process (`:1939`) is another — it runs under the platform's process manager (launchd / systemd / container runtime) and supervises every installed module as an attached child. Coordinator, not a service: each Parachute module stays standalone; the hub stitches them together. A **shipped door** on the workspace's compatibility axis — standard care, migrations for operator-visible changes.

The README is the operator intro; this file is for agents and humans working *on* the hub.

## Architecture — orientation

- Each CLI command is a self-contained module in `src/commands/`, wired through `src/cli.ts`'s argv parser. No framework, no plugin system.
- **One runtime: supervised, no detached-daemon model.** `parachute serve` runs foreground with the in-process `Supervisor` (`src/supervisor.ts`), kept alive by the platform's process manager. The `start/stop/restart <svc>` verbs are *clients*: they ensure the hub unit is up (`src/hub-unit.ts`), then drive the supervisor over the loopback module-ops HTTP API (`src/api-modules-ops.ts`).
- The canonical route table is the header docstring in [`src/hub-server.ts`](./src/hub-server.ts) — listed in dispatch order, and order is load-bearing. `SERVICE_SPECS` in `src/service-spec.ts` is the service registry; adding a service = one entry there.

## Gotchas — hard-won, don't rediscover

- **Port 1939 is pinned with no fallback.** `tailscale serve` needs a stable localhost target; a walking fallback would silently break cross-machine URLs.
- **`src/notes-serve.ts` must strip its `--mount` prefix** before joining with `dist/`. Without the strip, `/notes/sw.js` and `/notes/manifest.webmanifest` get SPA-shelled as `text/html`, the browser never registers the service worker or manifest, and the PWA install prompt never fires.
- **Services own the write side of `~/.parachute/services.json`** (`src/services-manifest.ts`); the CLI only seeds a missing entry post-install at `SEED_VERSION` (`"0.0.0-linked"` — "stopgap, the service's own boot overwrites").
- **`install` checks bun's global node_modules for a bun-link symlink before `bun add -g`** — modules linked from source (not yet on npm) would otherwise 404.

## Bun-native + running

Bun everywhere — no Node runtime assumptions, no tsc for emit (types only). `bin` points at `src/cli.ts`; tests live in `src/__tests__/`.

```sh
bun src/cli.ts --help            # dogfood the CLI from source
bun test ./src                   # canonical test run (see trap below)
bunx biome check --write .       # format + lint
bun run typecheck                # tsc --noEmit
```

**Test-count trap:** `bun test src` (no `./`) picks up *both* `src/` and `packages/scope-guard/src/` in one inflated, cross-interfering run. Use `bun test ./src`; cite hub-only counts by default, and pair with a separate scope-guard count only when scope-guard is load-bearing in the PR.

For end-to-end against a real install, `bun link` this repo — the linked `parachute` binary follows the checked-out branch.

## Naming

- Bin name: `parachute` (package `@openparachute/hub`)
- Hub port: 1939
- Config root: `~/.parachute/` (override with `PARACHUTE_HOME`); per-service dirs `~/.parachute/<short>/`

## License

AGPL-3.0.
