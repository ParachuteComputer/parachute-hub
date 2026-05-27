import pkg from "../package.json" with { type: "json" };
import { knownServices } from "./service-spec.ts";

export function topLevelHelp(): string {
  const services = knownServices().join(" | ");
  return `parachute ${pkg.version} — top-level CLI for the Parachute ecosystem

Usage:
  parachute setup                   interactive walk-through: install services + configure
  parachute install <service>       install and register a service
                                    services: ${services}
  parachute status                  show installed services, process state, health
  parachute start   [service]       start all services (or one) in the background
  parachute stop    [service]       stop all services (or one) — SIGTERM then SIGKILL
  parachute restart [service]       stop + start
  parachute upgrade [service]       pull / re-install + restart (skips if no changes)
  parachute logs <service> [-f]     print service logs; -f to tail
  parachute expose tailnet [off]    HTTPS across your tailnet (supported)
  parachute expose public  [off]    HTTPS on the public internet (exploratory)
  parachute serve                   run hub HTTP server foregrounded (for containers)
  parachute migrate [--dry-run]     archive legacy files at ecosystem root
  parachute auth <cmd>              identity (set password, manage 2FA)
  parachute vault <args...>         vault-specific ops (tokens, 2fa, config, init,
                                    etc.) — forwards to parachute-vault.
                                    For lifecycle, use \`parachute start|stop|restart|logs vault\`.

Flags:
  --help, -h                        show this help (also per-subcommand: \`parachute <cmd> --help\`)
  --version, -v                     print version
`;
}

export function installHelp(): string {
  return `parachute install — install and register a Parachute service

Usage:
  parachute install <service> [--channel rc|latest] [--tag <name>] [--no-start]
  parachute install all       [--channel rc|latest] [--tag <name>] [--no-start]
  parachute install scribe    [--scribe-provider <name>] [--scribe-key <key>]

Services:
  ${knownServices().join(", ")}
  all                               install every known service in turn

What it does:
  1. bun add -g @openparachute/<service>[@<tag>]
  2. run any service-specific init (e.g. \`parachute-vault init\`)
  3. assign a canonical port (1939–1949) and reflect it in
     \`~/.parachute/services.json\` — the single source of truth at boot
     (services follow a 4-tier resolvePort ladder; services.json wins).
  4. verify the service registered itself in ~/.parachute/services.json
  5. for scribe in a TTY: prompt for transcription provider + API key
     (or take \`--scribe-provider\` / \`--scribe-key\`)
  6. start the service in the background (idempotent — no-op if already up)

Flags:
  --channel rc|latest       npm dist-tag channel for the install. Defaults to
                            \`latest\` unless \`PARACHUTE_INSTALL_CHANNEL\` is set
                            (see Environment below). Loses to \`--tag\` (which
                            pins an exact version / tag). Garbage env values
                            fall back to \`latest\` with a warning.
  --tag <name>              npm dist-tag or exact version to install
                            (e.g. \`--tag rc\` → \`bun add -g @openparachute/vault@rc\`).
                            Wins over \`--channel\` and the env var.
                            Skipped if the package is already \`bun link\`-ed locally.
  --no-start                skip the post-install daemon start. For piped / CI
                            installs that own their own process model.
  --scribe-provider <name>  set scribe's transcription provider non-interactively.
                            Known: parakeet-mlx (default), onnx-asr, whisper, groq, openai.
                            Skips the interactive picker.
  --scribe-key <key>        set the API key for the chosen provider non-interactively.
                            Stored in ~/.parachute/scribe/.env. Only meaningful for
                            cloud providers (groq → GROQ_API_KEY, openai → OPENAI_API_KEY).

Environment:
  PARACHUTE_INSTALL_CHANNEL=rc|latest
                            cluster-wide default channel. Lets a Render deploy
                            running the hub at \`@rc\` cascade rc to vault / app /
                            scribe / runner installed via the admin SPA — without
                            an explicit \`--channel\` per call. Loses to \`--channel\`
                            and \`--tag\`. Defaults to \`latest\` when unset.

Examples:
  parachute install vault                                   # installs, runs init, starts vault
  parachute install surface                                 # installs surface (auto-bootstraps Notes)
  parachute install notes                                   # back-compat: legacy notes-daemon (Phase 2 deprecating)
  parachute install scribe                                  # installs, prompts for provider, starts scribe
  parachute install scribe --scribe-provider groq --scribe-key gsk_…
                                                            # non-interactive scribe setup
  parachute install vault --channel rc                      # pin to rc dist-tag
  PARACHUTE_INSTALL_CHANNEL=rc parachute install vault      # same, env-driven
  parachute install vault --tag 0.3.0-rc.1                  # pin to an exact version (wins over --channel)
  parachute install all --channel rc                        # bootstrap whole ecosystem to rc
  parachute install vault --no-start                        # install without auto-starting (CI)

Aliases:
  lens → notes                      # accepted for one release cycle after
                                    # the brief Lens rebrand was reverted on
                                    # 2026-04-22; prints a rename notice.
`;
}

export function setupHelp(): string {
  return `parachute setup — interactive walk-through to install + configure services

Usage:
  parachute setup [--tag <name>] [--no-start]

What it does:
  1. surveys ~/.parachute/services.json — already-installed services are
     reported, then skipped from the picker
  2. shows a numbered multi-select for the remaining first-party services
     (vault, app, scribe; channel is exploratory and only offered by name)
  3. pre-collects all interactive answers up front so the installs can run
     without further prompting:
       - vault: vault name (default \`default\`)
       - scribe: transcription provider + API key for cloud providers
  4. iterates \`parachute install <svc>\` per pick, threading the collected
     answers and the shared --tag / --no-start flags
  5. prints a summary banner with the running URLs (hub, vault, app, scribe)
     and a hint for connecting Claude Code

Behavior:
  - Partial success is preserved: if one install fails, prior successful
    installs are NOT rolled back. The exit code reflects the FIRST failure
    (root cause), so subsequent fallout doesn't mask the original problem.
  - Non-TTY / piped invocations should use \`parachute install <svc>\` per
    service instead — \`setup\` assumes a terminal for the prompts.
  - Selection accepts numbers (\`1,3\`), names (\`vault, app\`), or \`all\`.

Flags:
  --tag <name>     npm dist-tag or exact version, applied to every install
                   in this walk-through (e.g. \`--tag rc\`)
  --no-start       skip the post-install daemon start for every service.
                   For CI / scripted bring-up.

Examples:
  parachute setup                   # interactive walk-through
  parachute setup --tag rc          # bootstrap to the rc dist-tag
  parachute setup --no-start        # install without auto-starting (CI)
`;
}

export function statusHelp(): string {
  return `parachute status — show installed services, run state, install source

Usage:
  parachute status

What it does:
  Reads ~/.parachute/services.json. For each registered service:
    - checks PID file at ~/.parachute/<svc>/run/<svc>.pid
    - probes http://localhost:<port><health> (skipped for known-stopped processes)
    - classifies the install source as bun-linked (local checkout) or npm

  The STATE column rolls process state + probe result into one of four
  canonical labels (per parachute-patterns/patterns/design-system.md §6):
    active    supervised, running, last probe ok
    pending   supervised, needs operator action (OAuth / config) —
              not reachable from \`parachute status\` today; surfaces in
              the admin SPA; kept here for completeness
    inactive  operator-stopped or never started (no probe attempted)
    failing   supervised but probe failed (down / non-2xx); a
              continuation line ("  ! probe: <detail>") prints the
              underlying probe failure for diagnosis

  Pre-workstream-F this column was two: PROCESS (running / stopped) and
  HEALTH (ok / down / http <code>). Workstream F collapsed them onto the
  single STATE column the SPA + well-known doc also speak.

  Stopped services render as STATE=inactive and don't count toward the
  exit code — they're an expected state after fresh install before
  \`parachute start\`. Running or externally-managed services that fail
  health checks render as STATE=failing and exit 1.

  A "STALE: services.json cached … live package.json …" continuation line
  appears under a row when a bun-linked service has been rebuilt but the
  manifest's cached version hasn't caught up — re-install (\`parachute
  install <pkg>\`) refreshes the row.

Exit codes:
  0   all probed services healthy (or none running)
  1   one or more probed services unhealthy

Example:
  $ parachute status
  SERVICE          PORT  VERSION  STATE   PID    UPTIME  LATENCY  SOURCE
  parachute-vault  1940  0.2.4    active  12345  2h 13m  2ms      bun-linked → parachute-vault @ 8aa167b
    → http://127.0.0.1:1940/vault/default/mcp
  parachute-app    1946  0.2.0    active  12346  2h 12m  3ms      npm (0.2.0-rc.4)
    → http://127.0.0.1:1946/surface/notes
`;
}

export function exposeHelp(): string {
  return `parachute expose — route your services behind HTTPS on a network layer

Usage:
  parachute expose tailnet [off]
  parachute expose public  [off]
  parachute expose public  --tailnet
  parachute expose public  --cloudflare --domain <hostname>
  parachute expose public  off --cloudflare

Status:
  tailnet is the supported exposure shape. The hub's OAuth + per-module
  scope work is being designed against tailnet first (already auth'd at
  the network layer, every user's tailnet is their own).
  public is exploratory — the flag still works for early testers, but
  the public-internet posture (DNS, cross-internet OAuth, Funnel quirks)
  hasn't been hardened. Prefer tailnet until public re-enters the
  documented narrative post-OAuth.

Provider auto-detect (\`expose public\`):
  - In a terminal with no provider flag, walks an interactive picker
    (Tailscale Funnel vs. Cloudflare Tunnel), offers to install missing
    dependencies on macOS, and prompts for the Cloudflare hostname when
    needed.
  - In a non-TTY (CI / piped), detects which provider is set up:
      * exactly one configured → uses it.
      * both configured        → fails with a hint at --tailnet/--cloudflare.
      * neither configured     → fails with install pointers for both.
    \`--skip-provider-check\` bypasses detection and falls through to
    today's Tailscale-Funnel default (CI escape hatch).

Layers:
  tailnet    HTTPS across your tailnet (tailscale serve) — supported
  public     HTTPS on the public internet — exploratory
             - default: Tailscale Funnel (no domain needed, *.ts.net URL)
             - --cloudflare + --domain: named Cloudflare tunnel on your own
               domain (stable URL, free, no bandwidth caps)

Tailscale and Cloudflare modes share no state. Either can be up without the
other. Inside each mode, switching on/off is idempotent.

Flags:
  --hub-origin <url>      override the OAuth issuer URL advertised to clients
                          (default: https://<fqdn> when exposed, else http://127.0.0.1:<hub-port>)
  --tailnet               pin \`expose public\` to Tailscale Funnel,
                          bypassing the picker / auto-detect
  --cloudflare            pin \`expose public\` to a named Cloudflare tunnel
                          (requires --domain)
  --domain <hostname>     fully-qualified hostname to route through the tunnel
                          (e.g. vault.example.com). The apex must be a zone on
                          your Cloudflare account.
  --tunnel-name <name>    Cloudflare tunnel name (default: \`parachute\`).
                          Use to coexist multiple named tunnels on one box.
  --skip-provider-check   bypass non-TTY auto-detect, default to Tailscale
                          Funnel as before. Intended for CI / scripts whose
                          environment is already pre-flighted.

Examples:
  parachute expose tailnet                                 # tailnet HTTPS
  parachute expose public                                  # auto-pick / picker
  parachute expose public --tailnet                        # force Tailscale Funnel
  parachute expose public off                              # stop the Funnel
  parachute expose public --cloudflare --domain vault.example.com
                                                           # stable URL via cloudflared
  parachute expose public off --cloudflare                 # stop the cloudflared tunnel

Tailscale Funnel constraints:
  - HTTPS only on ports 443 / 8443 / 10000 per node. We pin to 443 and
    path-route (vault at /vault/…, notes at /notes, …) so this cap never
    becomes a constraint no matter how many services you install.
  - Bandwidth caps on Tailscale's free tier — see https://tailscale.com/kb/1223/funnel.
  - Subdomain-per-service needs the Tailscale Services feature (not yet).

Cloudflare tunnel requirements (--cloudflare):
  - \`cloudflared\` installed (macOS: \`brew install cloudflared\`).
  - \`cloudflared tunnel login\` run once (browser flow) — drops a cert at
    ~/.cloudflared/cert.pem.
  - Apex of --domain is a Cloudflare zone on that account. Add at
    https://dash.cloudflare.com → Add site (any registrar works).
  - Only vault is currently routed. Multi-service ingress via Cloudflare is
    deferred; use Funnel if you need hub + vault + notes on one exposure.
`;
}

export function startHelp(): string {
  return `parachute start — spawn services in the background

Usage:
  parachute start                   start every installed service
  parachute start <service>         start just that one
  parachute start hub               start the internal hub (port 1939)

What it does:
  For each target service, spawns its start command detached, redirects
  stdout+stderr to ~/.parachute/<service>/logs/<service>.log, and records
  the child PID at ~/.parachute/<service>/run/<service>.pid.

  Idempotent: if the service is already running, no-op.
  If a stale PID file exists (process died without cleanup), it's cleared
  and the service starts fresh.

  \`parachute start hub\` brings up the internal hub directly (normally
  spawned implicitly by \`parachute expose\`). Useful when restarting a
  hub that crashed without an active expose layer.

Flags:
  --hub-origin <url>    override PARACHUTE_HUB_ORIGIN passed to services
                        (default: current expose-state hub origin, else loopback).
                        For \`start hub\`, also doubles as the hub's --issuer.

Examples:
  parachute start                   bring everything up
  parachute start vault             just vault
  parachute start hub               just the internal hub
  parachute logs vault              watch what just started

Start commands by service:
  hub       bun <cli>/hub-server.ts --port <picked> ...
  vault     parachute-vault serve
  scribe    parachute-scribe serve
  app       parachute-app serve
  channel   parachute-channel daemon
  notes     bun <cli>/notes-serve.ts --port <configured> --mount <paths[0]>   # back-compat: legacy notes-daemon
`;
}

export function stopHelp(): string {
  return `parachute stop — stop running services cleanly

Usage:
  parachute stop                    stop every installed service
  parachute stop <service>          stop just that one
  parachute stop hub                stop the internal hub

What it does:
  Sends SIGTERM, waits up to 10s for a clean exit, then escalates to
  SIGKILL if the process is still alive. Removes the PID file on success.

  No-op if the service wasn't running.

  Bare \`parachute stop\` (no service) does NOT stop the hub — that's
  managed by the active expose layer (or \`parachute stop hub\` directly).

Examples:
  parachute stop                    stop everything before sleep
  parachute stop vault              just vault
  parachute stop hub                just the internal hub
`;
}

export function restartHelp(): string {
  return `parachute restart — stop then start

Usage:
  parachute restart                 restart every installed service
  parachute restart <service>       restart just that one
  parachute restart hub             restart the internal hub

What it does:
  Equivalent to \`parachute stop <svc> && parachute start <svc>\`.
`;
}

export function upgradeHelp(): string {
  return `parachute upgrade — pull / re-install + restart in one step

Usage:
  parachute upgrade                 upgrade every installed service
  parachute upgrade <service>       upgrade just that one
  parachute upgrade [svc] --channel rc|latest
                                    pin the dist-tag channel explicitly. Default:
                                    auto-detect from the installed version (a
                                    \`-rc\` suffix → rc; otherwise latest).
  parachute upgrade [svc] --allow-downgrade
                                    bypass the "refuses to downgrade" guard.
  parachute upgrade [svc] --tag <name>
                                    npm-installed services only — pin to an
                                    explicit dist-tag or exact version. Overrides
                                    --channel auto-detection. Ignored when
                                    bun-linked.

What it does:
  Detects whether the target service is bun-linked from a local checkout
  (the dev-mode shape) or npm-installed from a published artifact:

    bun-linked  git pull --ff-only in the checkout, bun install if
                package.json/bun.lock changed, bun run build for frontend
                modules with a build script, then \`parachute restart\`.
                Refuses on a dirty working tree — commit or stash first.

    npm         bun add -g <pkg>@<channel>, then \`parachute restart\` if the
                installed version actually moved. Refuses silent downgrades:
                if the resolved channel version is lower than what's installed,
                aborts with an actionable message.

  Idempotent: if the source didn't change (HEAD unchanged after pull, or
  package.json version unchanged after bun add -g), the restart is skipped.
  Re-running on an up-to-date install is a fast no-op.

Channel detection (hub#332):
  Pre-1.0 governance ships two channels — \`@rc\` (the development chain) and
  \`@latest\` (explicitly-promoted stable). \`parachute upgrade\` reads the
  installed package.json \`version\` and keeps you on the same channel: a
  \`-rc\` suffix (e.g. \`0.5.13-rc.13\`) means you're on rc and the upgrade
  pulls \`@rc\`; otherwise it pulls \`@latest\`. Override with \`--channel\`.

Examples:
  parachute upgrade                 sweep hub + every installed service
  parachute upgrade vault           just vault
  parachute upgrade hub             upgrade the dispatcher itself (closes #251)
  parachute upgrade hub --channel rc        pin the rc channel
  parachute upgrade hub --channel latest    pin the stable channel
  parachute upgrade vault --tag 0.4.1       pin to an exact version
`;
}

export function logsHelp(): string {
  return `parachute logs — print service logs

Usage:
  parachute logs <service>          print the last 200 lines
  parachute logs <service> -f       tail the log (like \`tail -f\`)
  parachute logs hub                logs for the internal hub

Log file:
  ~/.parachute/<service>/logs/<service>.log

If no log file exists yet, prints a hint to \`parachute start <service>\`.
`;
}

export function serveHelp(): string {
  return `parachute serve — run the hub HTTP server foregrounded

Usage:
  parachute serve

The container shape. The on-box CLI flow (\`parachute expose\`) spawns the
hub-server detached and tracks it via pidfile; \`parachute serve\` is the
inverse — the hub IS the foreground process, lives as long as its
supervisor wants it to, and exits on signal. Built for Docker / Render /
systemd, but works fine for a foregrounded local debug too.

Environment:
  PORT                              bind port (default 1939). Render injects
                                    this; honor it so the platform's HTTP
                                    forwarder lands on the right socket.
  PARACHUTE_HOME                    config root (default ~/.parachute).
                                    Point at a persistent disk in containers.
  PARACHUTE_HUB_ORIGIN              canonical https://… origin baked into
                                    OAuth issuer + token aud claims. Set to
                                    the public hostname Render / Cloudflare
                                    serves.
  PARACHUTE_INITIAL_ADMIN_USERNAME  on first boot when no admin row exists,
  PARACHUTE_INITIAL_ADMIN_PASSWORD  seed an admin from these. Boot-time
                                    idempotent — ignored once an admin
                                    exists, so leaving them set across
                                    restarts is safe.

If no admin exists and the seed env vars aren't set, the hub still comes
up — visit \`/admin/setup\` to bootstrap via the first-boot web wizard
(admin account + first vault, all from the browser).

Examples:
  parachute serve                          # foreground, defaults
  PORT=8080 PARACHUTE_HOME=/parachute parachute serve
  docker run -e PARACHUTE_INITIAL_ADMIN_USERNAME=ops \\
             -e PARACHUTE_INITIAL_ADMIN_PASSWORD=… \\
             -v parachute-data:/parachute \\
             parachute-hub:0.5.10 serve
`;
}

export function migrateHelp(): string {
  return `parachute migrate — archive known-legacy files at the ecosystem root

Usage:
  parachute migrate [--list] [--dry-run] [--yes]

What it does:
  Scans ~/.parachute/ for files and directories that match the
  known-legacy allowlist (daily.db*, server.yaml, channel.log/err,
  channel.start.sh, top-level logs/, tokens.db*, and the legacy lens/
  directory). Matching entries are moved under
  ~/.parachute/.archive-<YYYY-MM-DD>/ — never deleted.

  Anything *not* on the allowlist is left in place with an "[unknown —
  skipping]" note. The hub doesn't presume to know what every module
  (or your own setup) puts at the root, so the default is conservative:
  if it isn't a known-legacy pattern, migrate leaves it alone. Remove
  unknowns manually if you're sure.

  Dotfiles at the root (.env, .DS_Store, prior .archive-* dirs) are
  never touched.

Safety:
  - Refuses to sweep while any service is running — stop them first
    (\`parachute stop\`) or preview with \`--list\`.
  - SQLite-shape files (\`*.db\`, \`*.db-wal\`, \`*.db-shm\`) get a
    \`[live-db]\` label and pull an extra confirmation; wal/shm
    consistency depends on all three moving together.
  - Plan annotates each entry: \`[safe]\` / \`[live-db]\` /
    \`[unknown — skipping]\`, with skipped items printed last.
  - In a non-TTY shell (CI / piped), refuses without \`--yes\`.

Flags:
  --list        print the plan; make no changes (friendly preview)
  --dry-run     synonym for --list (kept for back-compat)
  --yes, -y     skip the confirmation prompt; required in non-TTY shells

Examples:
  parachute migrate --list          see what would move, without touching anything
  parachute migrate                 interactive sweep (prompts before acting)
  parachute migrate --yes           sweep without prompting
`;
}
