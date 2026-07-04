# Parachute Hub

`@openparachute/hub` — the local hub for the [Parachute](https://parachute.computer) ecosystem. The `parachute` binary is one of its surfaces.

The hub coordinates the modules running on your machine: it installs them, supervises them as child processes (the hub itself runs under your platform's process manager — launchd / systemd / the container runtime), exposes them over Tailscale, serves the discovery document at `/.well-known/parachute.json`, and (soon) issues OAuth tokens. Each module (vault, surface, scribe, …) stays a standalone package; the hub stitches them together.

> Previously published as `@openparachute/cli`. Renamed 2026-04-26 to better reflect the role — see [docs/contracts/hub-as-issuer.md](https://github.com/ParachuteComputer/parachute-hub/blob/main/docs/contracts/hub-as-issuer.md). The `parachute` binary name is unchanged.

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

Pre-configured with `PARACHUTE_INSTALL_CHANNEL=latest` so modules you install via the admin SPA (vault, surface, scribe, runner) pull stable releases by default. Flip to `rc` in your platform's env vars for the pre-release cascade.

Operators who want env-var-driven seeding (CI, scripted deploys) can still set `PARACHUTE_INITIAL_ADMIN_USERNAME` + `PARACHUTE_INITIAL_ADMIN_PASSWORD` manually — hub honors them on both platforms.

## First 5 minutes

One command gets you from a fresh install to the setup wizard:

```sh
# 1. Install the hub (one line — installs the `parachute` binary)
bun add -g @openparachute/hub

# 2. parachute init — the unified front door (laptop, EC2, any VPS).
#    It starts the hub, offers to expose it, always installs the vault
#    module, then drops you into the setup wizard.
parachute init
```

`parachute init` is idempotent — every re-run is safe. End to end it:

1. **Installs and starts the hub** as a managed unit (launchd on a Mac,
   systemd on a Linux VM) on port `1939`, so it survives reboots. Re-runs are
   no-ops if the unit is already up.
2. **Offers to expose it** so you can reach the wizard from other devices. In a
   terminal you pick: stay loopback-only, your **tailnet** (`tailscale serve` —
   private to your own Tailscale devices), or a **Cloudflare Tunnel** (public
   HTTPS on your own domain). The default highlights "no thanks — loopback" on a
   laptop and pre-selects Cloudflare on an SSH'd server. Skip with
   `--no-expose-prompt`, or pin non-interactively with
   `--expose none|tailnet|cloudflare`.
3. **Installs the vault module** — always — so the wizard can offer
   create / import / skip. No vault *instance* is created yet; that's the
   wizard's call.
4. **Drops you into the setup wizard.** Browser by default (opens
   `/admin/setup`); pick the in-terminal walk-through with `--cli-wizard`, or
   force the browser with `--browser-wizard`. It prints the canonical admin URL
   either way — loopback when you're not exposed, the tailnet / Cloudflare FQDN
   when you are.

The wizard walks the same three steps in the browser and the CLI:

- **Account** — create the admin operator for this hub (username + password).
- **Vault** — *create* a fresh vault (default name `default`), *import* one from
  a git repo (a previously-exported Parachute vault on any HTTPS / SSH remote;
  PAT optional for private repos), or *skip* and create one later. The vault
  module is installed regardless of which you pick.
- **Expose** — record how this hub is reached (localhost / tailnet / public) so
  the done screen surfaces the right URLs.

The done screen hands you a copy-pasteable `claude mcp add` command (with a
freshly-minted operator token), a link to start using your vault, and the admin
UI. Verify the stack any time:

```sh
parachute status
# SERVICE          PORT  VERSION  STATE   PID    UPTIME  LATENCY  SOURCE
# parachute-hub    1939  0.5.14   active  12344  20s     1ms      managed unit (launchd)
# parachute-vault  1940  0.4.5    active  12345  12s     2ms      npm (0.4.5)
```

Vault is up on `127.0.0.1:1940`; Claude Code picks up the MCP on your next
session. Point any other local MCP client (Codex, Goose, OpenCode, Cursor, Zed,
Cline, your own agent) at `http://127.0.0.1:1940/vault/<name>/mcp`.

### Want the wizard in the terminal instead of the browser?

```sh
parachute init --cli-wizard
```

…or drive the wizard directly against an already-running hub:

```sh
parachute setup-wizard --hub-url http://127.0.0.1:1939
```

`setup-wizard` is the in-terminal mirror of `/admin/setup` — same handlers, same
Account → Vault → Expose walk. Every prompt has a paired flag for scripted /
non-interactive setup (`--account-username`, `--account-password`,
`--vault-mode create|import|skip`, `--vault-name`, `--vault-import-url`,
`--expose-mode localhost|tailnet|public`, …); run `parachute setup-wizard --help`
for the full list.

### Prefer to drive installs by hand?

`parachute init` → wizard is the recommended path, but the per-module commands
still work and are additive:

```sh
parachute install vault   # install + register + create first vault + start one module
parachute setup           # older interactive multi-pick: survey + install vault/notes/scribe
parachute start vault     # start one module via the running hub's supervisor
```

### Expose across your tailnet

```sh
parachute expose tailnet  # HTTPS, MagicDNS, only your devices (the supported shape today)
```

Tear down with `parachute expose tailnet off`. The public layer (`expose public off`) tears down independently — `off` only affects the layer you name. Public-internet exposure is exploratory (see "Public exposure" below).

### Onboarding a team member

Want to give a friend or teammate their own account on your hub? The flow is
self-service end to end:

1. **Create the user.** In the admin UI, open **Users → Create User**: pick a
   username, set a temporary password, and (optionally) assign one or more
   vaults. The success banner echoes the exact sign-in URL.
2. **Hand them three things:** your hub's sign-in URL (`<hub-origin>/login`),
   their username, and the temporary password you set.
3. **They sign in and set their own password.** On first sign-in they're
   prompted to change it — they can't reach the rest of the hub until they do.
4. **Later changes are self-service.** A signed-in user changes their password
   anytime from their account home at `/account/` (reachable via the **Account**
   link in the top-right once signed in).
5. **You can reset it for them.** If they're locked out, the **Reset password**
   button on the Users row sets a new temporary password and re-arms the
   force-change-on-next-sign-in prompt.

The first admin (the wizard / env-seeded account) is unrestricted and can't be
deleted or reset from the Users page — it changes its own password at
`/account/change-password` directly.

## Service lifecycle

Parachute runs **one runtime everywhere**: `parachute serve` — the hub in the
foreground with an in-process supervisor that runs each module as an attached
child, multiplexes their logs, and restarts crashed ones. That `serve` process
runs under your platform's own process manager — **launchd** on a Mac,
**systemd** on a Linux VM, the **container runtime** on Render / Fly — so the
hub (and every module under it) survives reboots and crashes without you
SSHing back in.

`parachute init` installs and starts that managed hub unit for you; the
lifecycle verbs then drive the running supervisor:

```sh
parachute start               # ensure the hub unit is up (boots every module)
parachute start vault         # start one module via the running supervisor
parachute stop vault          # stop one module via the supervisor
parachute stop                # stop the hub unit (children stop with it)
parachute restart vault       # restart one module via the supervisor
parachute restart             # restart the hub unit (re-boots every module)
parachute logs vault          # last 200 lines
parachute logs vault -f       # tail (like `tail -f`)
```

How the verbs map to the model:

- **`start` / `stop` / `restart <svc>`** are clients of the running hub. They
  ensure the hub unit is up, then call its supervisor over a loopback
  module-ops API (authenticated with your operator token) to start / stop /
  restart that one module. There's no per-module daemon to track — the
  supervisor owns module processes.
- **`start` (no service)** ensures the hub unit is up; the hub boots every
  installed module on start, so this brings the whole stack up.
- **`stop` (no service)** stops the **hub unit** through the platform manager
  (`launchctl bootout` / `systemctl stop`); the modules are attached children
  and stop with it.
- **`restart` (no service)** restarts the **hub unit** (`launchctl kickstart
  -k` / `systemctl restart`), which re-boots every module — it is *not* a
  fan-out of per-module restarts.

`parachute status` shows a hub row even with zero modules installed — that row
is derived from the platform manager (`launchctl print` / `systemctl
is-active`, or "container runtime (managed)" on Render / Fly), since the
supervisor runs the modules but the manager runs the hub.

### No process manager installed yet?

If you've never run `parachute init` (or you're on a legacy install that used
the old detached-daemon model), the lifecycle verbs will prompt you to run
`parachute migrate --to-supervised`, which installs the hub unit and moves you
onto the supervised model. See **Migrating a legacy install** below.

On a host with no process manager at all (a bare container, an init-less
image), there's no unit to install — run `parachute serve` in the foreground
instead (this is exactly what the container `CMD` does).

### Migrating a legacy install

Earlier Parachute releases ran each service as an independent detached daemon
(its own pidfile + log file under `~/.parachute/<service>/`), with no
supervisor and no reboot survival. To move an existing box onto the supervised
model:

```sh
parachute migrate --to-supervised   # install + start the hub unit, cut over
```

The cutover is idempotent and re-runnable. It writes the platform unit, stops
the old detached processes, verifies the canonical ports are free, then starts
the hub unit and confirms the hub is healthy. To roll it back, `parachute
migrate --teardown` removes the unit (run that *before* `bun remove -g
@openparachute/hub` so a removed package doesn't leave a unit pointing at a
deleted binary).

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
Exposure is decoupled from the hub's own lifecycle: `expose` makes the
already-running hub reachable on a network layer, and `expose <layer> off`
tears down only that exposure — the hub keeps running as its managed unit
either way.

- **Local** — the hub on loopback. Zero config. Browsers treat `localhost` as a secure context, so OAuth, PKCE, and Web Crypto all just work out of the box.
- **Tailnet** — `parachute expose tailnet` wraps `tailscale serve` for every registered service. HTTPS via Tailscale's MagicDNS cert. Only machines on your tailnet can reach the URL. **This is the documented shape for the hub today.** Tailnet is already authenticated at the network layer, every user's tailnet is their own, and the OAuth + module access work happening in the hub is being designed against this shape first.

### Public exposure (exploratory)

`parachute expose public` exists for early testers. It routes each handler through `tailscale funnel` (or, with `--cloudflare`, a named Cloudflare tunnel) so the same URLs become reachable from the public internet. The code path is live and the flag still works, but the public-internet posture (DNS, cross-internet OAuth, Funnel quirks) hasn't been hardened the way tailnet has — expect rough edges.

When the hub's OAuth issuer + per-module scope enforcement land, public will re-enter the documented narrative as "now safe." Until then, prefer tailnet. (If you route a public layer through Cloudflare, note their bot-protection / Browser Integrity Check can interfere with OAuth and MCP clients — see the caveat on [parachute.computer](https://parachute.computer).)

Under the hood, tailnet mode uses `tailscale serve` and public mode uses `tailscale funnel`; both write into the same node-level serve config. The CLI records which layer is live so that `expose <other-layer> off` is a no-op rather than a surprise teardown of the active layer. `expose off` only ever tears down exposure — it never stops the hub (the platform manager owns the hub's lifecycle now).

## Path-routing (and why)

Every service mounts under a path on a single canonical hostname. The root `/` is a hub page that auto-discovers everything installed on this node:

```
https://parachute.<tailnet>.ts.net/                              → hub (service directory)
https://parachute.<tailnet>.ts.net/vault/default                 → parachute-vault API
https://parachute.<tailnet>.ts.net/surface                       → parachute-surface
https://parachute.<tailnet>.ts.net/scribe                        → parachute-scribe
https://parachute.<tailnet>.ts.net/.well-known/parachute.json    ← discovery
```

The hub page fetches the discovery doc at load, then each service's `/.parachute/info` endpoint for display name, tagline, and icon. Adding a new service is zero CLI code — drop in its manifest entry and the hub picks it up.

Under the hood, `/` and `/.well-known/parachute.json` are served by the hub
process on the loopback interface — the same `parachute serve` process the
platform manager keeps running. Tailscale's file-serve mode is sandbox-restricted on macOS, so a localhost proxy is the portable shape. The hub is a persistent managed unit: it runs whether or not any exposure layer is up, so `expose tailnet off` / `expose public off` tears down only the *exposure*, leaving the hub serving on loopback. `parachute status` lists the hub row (manager-derived) at the top.

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
      "name": "parachute-surface",
      "url":  "https://parachute.taildf9ce2.ts.net/surface",
      "path": "/surface",
      "version": "0.3.2",
      "infoUrl": "https://parachute.taildf9ce2.ts.net/surface/.parachute/info"
    }
  ]
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
| 1941 | parachute-agent *(renamed from parachute-channel 2026-06-17)* |
| 1942 | *parachute-notes (archived 2026-05-24 — notes-daemon retired; Notes now bundled in parachute-surface. Slot reclaimable; see [`parachute-notes/DEPRECATED.md`](https://github.com/ParachuteComputer/parachute-notes/blob/main/DEPRECATED.md))* |
| 1943 | parachute-scribe   |
| 1944 | *parachute-agent-legacy (the Claude-in-containers module retired 2026-05-20; slot held — NOT the 1941 agent module, which is the renamed channel)* |
| 1945 | parachute-runner *(shipped; exploration-tier, not committed-core)* |
| 1946 | parachute-surface *(committed core; UI host — bundles Notes, hosts custom surfaces)* |
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
parachute init                    fresh-install front door: install + start the
                                  managed hub, offer expose, install vault, wizard
parachute setup-wizard --hub-url <url>
                                  in-terminal mirror of /admin/setup (Account/Vault/Expose)
parachute setup                   older interactive multi-pick service installer
parachute install <service>       install and register a service
parachute status                  show installed services, run state, health
parachute start   [service]       start a module via the supervisor (or ensure the hub is up)
parachute stop    [service]       stop a module via the supervisor (or the hub unit)
parachute restart [service]       restart a module via the supervisor (or the hub unit)
parachute serve                   run the hub + supervisor foregrounded (the runtime)
parachute logs <service> [-f]     print/tail service logs
parachute expose tailnet [off]    HTTPS across your tailnet (supported)
parachute expose public  [off]    HTTPS on the public internet (exploratory)
parachute migrate --to-supervised move a legacy detached install to the managed hub
parachute migrate [--dry-run]     archive legacy files at ecosystem root
parachute vault <args...>         dispatch to parachute-vault
```

## Status

Pre-alpha. API surface is stabilizing but not frozen.

## License

AGPL-3.0 — same as the rest of the Parachute ecosystem.
