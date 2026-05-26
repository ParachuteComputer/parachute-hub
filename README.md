# Parachute Hub

`@openparachute/hub` — the local hub for the [Parachute](https://parachute.computer) ecosystem. The `parachute` binary is one of its surfaces.

The hub coordinates the modules running on your machine: it installs them, runs them as background processes, exposes them over Tailscale, serves the discovery document at `/.well-known/parachute.json`, and (soon) issues OAuth tokens. Each module (vault, app, scribe, …) stays a standalone package; the hub stitches them together.

> Previously published as `@openparachute/cli`. Renamed 2026-04-26 to better reflect the role — see [parachute-patterns/hub-as-issuer](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/hub-as-issuer.md). The `parachute` binary name is unchanged.

## Install

### Local (Bun)

```sh
bun add -g @openparachute/hub
```

Prereqs: [Bun](https://bun.sh) 1.3.0 or later. `parachute expose` also requires [Tailscale](https://tailscale.com/download) **1.82 or newer** (installed + `tailscale up` run once); the `expose` path is under active polish for launch, so expect rough edges.

### Hosted self-deploy

Hub runs as a single container with one persistent disk. Two equally-supported platforms; pick the one you prefer.

#### Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ParachuteComputer/parachute-hub)

One-click Render deploy via the `render.yaml` Blueprint in this repo. Provisions a $7/mo Starter service + 1 GiB persistent disk + auto-deploys from `main`. GUI-first ops; click-and-go for operators who don't want to install a CLI.

After deploy completes:

1. Open Render Logs → search for `parachute-bootstrap-` to find your one-time admin setup token.
2. Visit your Render service URL's `/admin/setup` → paste the token → create your admin account.
3. Set custom domain (optional) → set `PARACHUTE_HUB_ORIGIN` env to match.
4. Install modules via the admin SPA at `/admin/modules`.

Render's docs on Blueprints: <https://render.com/docs/blueprint-spec>

#### Fly.io

```sh
gh repo fork ParachuteComputer/parachute-hub --clone && cd parachute-hub
./scripts/deploy-to-fly.sh
```

The script installs `flyctl` if missing, runs `fly launch --copy-config`, and prints the URL. Provisions a shared-cpu-1x 512MB machine in `iad` (override with `--region` if your operators are elsewhere) + 1 GiB persistent volume at `/parachute`. Cost: ~$3.34/mo all-in.

After deploy:

1. `fly logs --app <your-app> | grep parachute-bootstrap-` to find your one-time admin token.
2. Visit `https://<your-app>.fly.dev/admin/setup` → paste the token → create your admin account.
3. Custom domain: `fly certs add <your-domain> --app <your-app>` then `fly secrets set PARACHUTE_HUB_ORIGIN=https://<your-domain>`.
4. Install modules via the admin SPA at `/admin/modules`.

Config in `fly.toml`. CLI-first ops; bring your own `flyctl`.

#### Both platforms

Pre-configured with `PARACHUTE_INSTALL_CHANNEL=latest` so modules you install via the admin SPA (vault, app, scribe, runner) pull stable releases by default. Flip to `rc` in your platform's env vars for the pre-release cascade.

Operators who want env-var-driven seeding (CI, scripted deploys) can still set `PARACHUTE_INITIAL_ADMIN_USERNAME` + `PARACHUTE_INITIAL_ADMIN_PASSWORD` manually — hub honors them on both platforms.

## First 5 minutes

```sh
# 1. Install the hub (one line — installs the `parachute` binary)
bun add -g @openparachute/hub

# 2. Install a service (runs `bun add -g @openparachute/vault` + `parachute-vault init`)
parachute install vault

# 3. Start the service in the background (PID + logs tracked under ~/.parachute/vault/)
parachute start vault

# 4. Check it landed — reads ~/.parachute/services.json, shows process state + probes health
parachute status
# SERVICE          PORT  VERSION  PROCESS  PID    UPTIME  HEALTH  LATENCY
# parachute-vault  1940  0.2.4    running  12345  12s     ok      2ms

# 5. Use it. Vault is up on 127.0.0.1:1940; Claude Code picked up the MCP
#    on your next session. Point any other local MCP client (Codex, Goose,
#    OpenCode, Cursor, Zed, Cline, your own agent) at:
#      http://127.0.0.1:1940/vault/default/mcp

# 6. Expose across your tailnet — HTTPS, MagicDNS, only your devices.
#    The supported exposure shape today; public-internet exposure is
#    exploratory (see "Public exposure" below).
parachute expose tailnet
```

Tear down with `parachute expose tailnet off`. The public layer (`expose public off`) tears down independently — `off` only affects the layer you name.

## Service lifecycle

`parachute start`, `stop`, `restart`, and `logs` manage services as background processes — no launchd, no manual `bun serve`, no hunting for PIDs.

```sh
parachute start               # start every installed service
parachute start vault         # just one
parachute stop                # SIGTERM, then SIGKILL after 10s if stuck
parachute restart vault       # stop + start
parachute logs vault          # last 200 lines
parachute logs vault -f       # tail (like `tail -f`)
```

State lives under `~/.parachute/<service>/`:

- `run/<service>.pid` — child PID; `parachute status` uses this to report running/stopped + uptime
- `logs/<service>.log` — stdout + stderr (appended)

`parachute start` is idempotent: if the service is already running, it's a no-op. Stale PID files (process died without cleanup) are cleared on the next start. Services whose PID file is absent are treated as *unknown* — status still probes their port, so externally-managed services (e.g. you ran `parachute-vault serve` directly) aren't misreported as stopped.

### Migrating from launchd (pre-launch beta)

If you previously ran vault under launchd, switch to `parachute start`:

```sh
launchctl unload ~/Library/LaunchAgents/computer.parachute.vault.plist
rm ~/Library/LaunchAgents/computer.parachute.vault.plist
parachute start vault
```

An at-login auto-start mode (`parachute start --boot`) is on the post-launch roadmap.

### Migrating from pre-CLI installs

If you've been running Parachute services by hand for a while, `~/.parachute/` may contain files from before the per-service restructure — top-level `daily.db`, `server.yaml`, a stray `logs/` directory, and so on. `parachute install` will print a one-line notice when it sees anything like that; run `parachute migrate` to sweep them:

```sh
parachute migrate --dry-run       # see the plan
parachute migrate                 # interactive (prompts before moving)
parachute migrate --yes           # unattended
```

Anything swept goes to `~/.parachute/.archive-<YYYY-MM-DD>/` with its original name — nothing is deleted. Recognized entries (per-service dirs, `services.json`, `expose-state.json`, `well-known/`) are left in place, and so is anything starting with a dot (so `.env` and prior `.archive-*` dirs are safe).

## Two supported layers (plus an exploratory third)

Each additive; each can be turned off without affecting the layer below.

- **Local** — services on loopback. Zero config. Browsers treat `localhost` as a secure context, so OAuth, PKCE, and Web Crypto all just work out of the box.
- **Tailnet** — `parachute expose tailnet` wraps `tailscale serve` for every registered service. HTTPS via Tailscale's MagicDNS cert. Only machines on your tailnet can reach the URL. **This is the documented shape for the hub today.** Tailnet is already authenticated at the network layer, every user's tailnet is their own, and the OAuth + module access work happening in the hub is being designed against this shape first.

### Public exposure (exploratory)

`parachute expose public` exists for early testers. It routes each handler through `tailscale funnel` (or, with `--cloudflare`, a named Cloudflare tunnel) so the same URLs become reachable from the public internet. The code path is live and the flag still works, but the public-internet posture (DNS, cross-internet OAuth, Funnel quirks) hasn't been hardened the way tailnet has — expect rough edges.

When the hub's OAuth issuer + per-module scope enforcement land, public will re-enter the documented narrative as "now safe." Until then, prefer tailnet.

Under the hood, tailnet mode uses `tailscale serve` and public mode uses `tailscale funnel`; both write into the same node-level serve config. The CLI records which layer is live so that `expose <other-layer> off` is a no-op rather than a surprise teardown of the active layer.

## Path-routing (and why)

Every service mounts under a path on a single canonical hostname. The root `/` is a hub page that auto-discovers everything installed on this node:

```
https://parachute.<tailnet>.ts.net/                              → hub (service directory)
https://parachute.<tailnet>.ts.net/vault/default                 → parachute-vault API
https://parachute.<tailnet>.ts.net/lens                          → parachute-lens
https://parachute.<tailnet>.ts.net/scribe                        → parachute-scribe
https://parachute.<tailnet>.ts.net/.well-known/parachute.json    ← discovery
```

The hub page fetches the discovery doc at load, then each service's `/.parachute/info` endpoint for display name, tagline, and icon. Adding a new service is zero CLI code — drop in its manifest entry and the hub picks it up.

Under the hood, `/` and `/.well-known/parachute.json` are proxied by a tiny internal HTTP server (`parachute-hub`) that `parachute expose` spawns on the loopback interface. Tailscale's file-serve mode is sandbox-restricted on macOS, so a localhost proxy is the portable shape. The hub process is stopped automatically when the last exposure layer is torn down; `parachute status` lists it under `(internal)`.

The `/.well-known/parachute.json` document is an always-present descriptor — flat `services[]` array that the hub iterates, plus top-level keys for legacy clients:

```json
{
  "vaults": [
    { "name": "default", "url": "https://parachute.taildf9ce2.ts.net/vault/default", "version": "0.2.4" }
  ],
  "services": [
    {
      "name": "parachute-vault",
      "url":  "https://parachute.taildf9ce2.ts.net/vault/default",
      "path": "/vault/default",
      "version": "0.2.4",
      "infoUrl": "https://parachute.taildf9ce2.ts.net/vault/default/.parachute/info"
    },
    {
      "name": "parachute-lens",
      "url":  "https://parachute.taildf9ce2.ts.net/lens",
      "path": "/lens",
      "version": "0.0.1",
      "infoUrl": "https://parachute.taildf9ce2.ts.net/lens/.parachute/info"
    }
  ],
  "lens": { "url": "https://parachute.taildf9ce2.ts.net/lens", "version": "0.0.1" }
}
```

Why path-routing and not subdomain-per-service? Two reasons:

1. **Tailscale Funnel HTTPS is capped at three ports per node** (443, 8443, 10000). Pinning every service to 443 behind a path means you can install any number of services without ever hitting that cap. (Funnel is the public-exposure backend; the cap shapes the tailnet-mode design too, since both modes share one serve config.)
2. **Subdomain-per-service requires the Tailscale Services feature** (virtual-IP advertisement per service), which is more than a MagicDNS wildcard — it needs admin-side setup that's out of scope for a one-command install. When it's a launch-grade path, we'll add `parachute expose tailnet --mode subdomain`.

## Ports

Parachute services reserve a block of loopback ports in the canonical range **1939–1949**. One range, one firewall rule, no surprises.

| Port | Service            |
| ---- | ------------------ |
| 1939 | parachute-hub (internal proxy + static) |
| 1940 | parachute-vault    |
| 1941 | parachute-channel  |
| 1942 | parachute-notes *(deprecating — see [notes#154](https://github.com/ParachuteComputer/parachute-notes/issues/154); folds into parachute-app at 1946)* |
| 1943 | parachute-scribe   |
| 1944 | *parachute-agent (retired 2026-05-20; slot held — see [`parachute-agent/DEPRECATED.md`](https://github.com/ParachuteComputer/parachute-agent/blob/main/DEPRECATED.md))* |
| 1945 | parachute-runner *(shipped; exploration-tier, not committed-core)* |
| 1946 | parachute-app *(committed core; UI host, ships Notes as canonical first app)* |
| 1947–1949 | *unassigned (CLI fallback range)* |

The hub pins 1939 — no fallback. If something else is on 1939 when you run `parachute expose`, the command fails with a pointer to `lsof -iTCP:1939` rather than walking up into another service's slot.

**The CLI is the port authority.** `parachute install <svc>` picks the port at install time and writes `PORT=<port>` into `~/.parachute/<svc>/.env`; lifecycle.start merges that .env into the spawn env so the next daemon boot binds the port the CLI assigned. The algorithm:

1. Prefer the canonical slot (e.g. vault → 1940).
2. On collision, walk the unassigned range (1947–1949).
3. Range exhausted: assign past 1949 with a warning.

Idempotent: an existing `PORT=` in `~/.parachute/<svc>/.env` wins, so re-installs and operator-edited ports survive across upgrades. Services keep their compiled-in fallbacks (vault → 1940 etc.) so a stand-alone `bun run` still works without a CLI-managed .env.

`parachute expose` probes every service's port at bringup. A service that isn't responding still gets exposed, but you get a `⚠ parachute-<svc> (port …) is not responding` line so proxied requests never silently 502 without explanation.

## How services register

Each Parachute service writes a manifest entry to `~/.parachute/services.json` on install. The CLI reads that manifest to drive `parachute status`, `parachute expose tailnet`, and `parachute expose public`.

```json
{
  "services": [
    {
      "name":    "parachute-vault",
      "port":    1940,
      "paths":   ["/vault/default"],
      "health":  "/vault/default/health",
      "version": "0.2.4"
    }
  ]
}
```

Optional `displayName` and `tagline` may be added to personalize the hub-page card; if absent, the hub falls back to the short name and the service's own `/.parachute/info` response.

The schema is a bit-for-bit contract shared between the CLI and every service. Services own their write side; the CLI owns the read + exposure side.

### Claiming `/` — legacy manifests

Pre-hub services wrote `paths: ["/"]` (when there was only one service at `/`). On `parachute expose`, any such entry is remapped in-memory to `/<shortname>` with a one-line warning; re-running `parachute install <svc>` updates the on-disk manifest permanently. The hub always owns `/`.

If you want the CLI (and every service you install) to use a config directory other than `~/.parachute`, set `PARACHUTE_HOME`:

```sh
export PARACHUTE_HOME=/some/other/path
```

## Already have parachute-vault installed?

Install the hub and `parachute vault ...` forwards to your existing `parachute-vault` binary:

```sh
bun add -g @openparachute/hub
parachute vault init     # dispatches to parachute-vault init
parachute vault --help   # dispatches to parachute-vault --help
```

Nothing about your existing vault moves or needs reconfiguring.

## Smoke walkthrough (post-install)

Copy-paste to verify the whole chain. Everything here is idempotent.

```sh
# Install
bun add -g @openparachute/hub

# Verify CLI
parachute --version
parachute --help

# Install a service
parachute install vault

# Manifest should now exist
cat ~/.parachute/services.json

# Start it in the background
parachute start vault

# Status should show vault as running + healthy
parachute status

# Peek at the service's logs
parachute logs vault

# Expose across your tailnet (requires tailscale + `tailscale up`)
parachute expose tailnet

# Open the URL printed above in a browser on any tailnet peer.
# Also confirm the discovery document:
curl -s https://parachute.<tailnet>.ts.net/.well-known/parachute.json | jq .

# Tear down
parachute expose tailnet off
```

Public-internet exposure (`parachute expose public`) is exploratory — see "Public exposure" above. The flag still works for early testers; the supported smoke is tailnet.

## Subcommand reference

Run `parachute --help` for the top-level list, and `parachute <subcommand> --help` for details on any individual command.

```
parachute install <service>       install and register a service
parachute status                  show installed services, process state, health
parachute start   [service]       start services in the background
parachute stop    [service]       stop services (SIGTERM → 10s → SIGKILL)
parachute restart [service]       stop + start
parachute logs <service> [-f]     print/tail service logs
parachute expose tailnet [off]    HTTPS across your tailnet (supported)
parachute expose public  [off]    HTTPS on the public internet (exploratory)
parachute migrate [--dry-run]     archive legacy files at ecosystem root
parachute vault <args...>         dispatch to parachute-vault
```

## Status

Pre-alpha. API surface is stabilizing but not frozen.

## License

AGPL-3.0 — same as the rest of the Parachute ecosystem.
