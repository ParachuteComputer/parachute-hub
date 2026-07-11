import pkg from "../package.json" with { type: "json" };
import { knownServices } from "./service-spec.ts";

export function topLevelHelp(): string {
  const services = knownServices().join(" | ");
  return `parachute ${pkg.version} — top-level CLI for the Parachute ecosystem

Fresh install? Start here — works the same on a laptop or a remote server:
  parachute init                    one quick step → admin wizard in your browser
                                    (offers optional exposure on remote boxes)

Usage:
  parachute init                    bring hub up, offer exposure, open admin wizard
                                    (also lets you walk the wizard in the CLI; --cli-wizard)
  parachute setup-wizard --hub-url <url>  walk /admin/setup in the terminal
  parachute setup                   interactive walk-through: install services + configure
  parachute install <service>       install and register a service
                                    services: ${services}
  parachute status                  show installed services, run state, health
  parachute doctor                  run health checks + tell you the one thing to fix
  parachute start   [service]       start a module via the supervisor (or ensure the hub is up)
  parachute stop    [service]       stop a module via the supervisor (or stop the hub unit)
  parachute restart [service]       restart a module via the supervisor (or restart the hub unit)
  parachute upgrade [service]       pull / re-install + restart (skips if no changes)
  parachute logs <service> [-f]     print service logs; -f to tail
  parachute expose tailnet [off]    HTTPS across your tailnet (supported)
  parachute expose public  [off]    HTTPS on the public internet (exploratory)
  parachute serve                   run the hub + supervisor foregrounded (the runtime)
  parachute migrate --to-supervised move a legacy detached install to the managed hub
  parachute migrate [--dry-run]     archive legacy files at ecosystem root
  parachute auth <cmd>              identity (set password, manage 2FA)
  parachute surface token <cmd>     mint/list/revoke surface deploy tokens
                                    (a git-native PAT for pushing to a surface)
  parachute hub set-origin <url>    set the canonical public hub origin (OAuth issuer)
                                    — for reverse-proxy / Caddy-direct boxes
  parachute vault <args...>         vault-specific ops (tokens, 2fa, config, init,
                                    etc.) — forwards to parachute-vault.
                                    For lifecycle, use \`parachute start|stop|restart|logs vault\`.
                                    \`vault remove <name>\` is routed through the hub's
                                    identity cascade (revokes the vault's tokens/grants),
                                    not the raw mechanics-only delete.

Flags:
  --help, -h                        show this help (also per-subcommand: \`parachute <cmd> --help\`)
  --version, -v                     print version
`;
}

export function installHelp(): string {
  return `parachute install — install and register a Parachute service

Usage:
  parachute install <service> [--channel rc|latest] [--tag <name>] [--no-start] [--interactive]
  parachute install all       [--channel rc|latest] [--tag <name>] [--no-start]
  parachute install scribe    [--scribe-provider <name>] [--scribe-key <key>]

Services:
  ${knownServices().join(", ")}
  all                               install every known service in turn

What it does:
  1. bun add -g @openparachute/<service>[@<tag>]
  2. register + start the module under the hub supervisor (LIGHT by default —
     no interactive interview; for vault: no vault-name / MCP / token prompts
     and no competing standalone daemon). Pass \`--interactive\` to run the
     service's own full setup (e.g. \`parachute-vault init\`) instead.
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
  --interactive             run the module's full interactive setup instead of
                            the light default. For vault: the vault-name /
                            "install MCP in Claude Code?" / "mint a token?"
                            interview + its own standalone daemon registration.
                            On a supervised hub that standalone daemon can RACE
                            the supervisor for the module's port (EADDRINUSE
                            crash-loop, #580) — prefer the light default + manage
                            from the admin UI unless you specifically want the
                            old interview.
  --scribe-provider <name>  set scribe's transcription provider non-interactively.
                            Known: parakeet-mlx (default), onnx-asr, whisper, groq, openai.
                            Skips the interactive picker.
  --scribe-key <key>        set the API key for the chosen provider non-interactively.
                            Stored in ~/.parachute/scribe/.env. Only meaningful for
                            cloud providers (groq → GROQ_API_KEY, openai → OPENAI_API_KEY).

Environment:
  PARACHUTE_INSTALL_CHANNEL=rc|latest
                            cluster-wide default channel. Lets a Render deploy
                            running the hub at \`@rc\` cascade rc to vault / surface /
                            scribe installed via the admin SPA — without
                            an explicit \`--channel\` per call. Loses to \`--channel\`
                            and \`--tag\`. Defaults to \`latest\` when unset.

Examples:
  parachute install vault                                   # light: installs + starts vault, points you at the admin UI
  parachute install vault --interactive                     # full interactive vault init (name / MCP / token prompts)
  parachute install surface                                 # installs surface (auto-bootstraps Notes)
  parachute install notes                                   # legacy notes-daemon — deprecated; use \`parachute install surface\` instead
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

export function initHelp(): string {
  return `parachute init — get the admin wizard open in one step

Usage:
  parachute init [--no-browser] [--no-expose-prompt]
                 [--expose none|tailnet|cloudflare]
                 [--channel rc|latest]
                 [--hub-origin <url>]
                 [--vault-name <name>]
                 [--cli-wizard | --browser-wizard]

What it does:
  Fresh-install front door, one command for both laptops AND remote
  servers (EC2, DigitalOcean, Hetzner, any VPS). The admin SPA already
  walks operators through the rest (install vault, set up the admin
  user, install scribe / surface); this command's only job is to
  get you to that wizard.

  Idempotent — every re-run is safe:
    1. Install + start the hub as a managed unit (launchd on a Mac,
       systemd on a Linux VM) so it survives reboots; no-op if it's
       already up.
    2. If the hub isn't already exposed, in a terminal, offer to set up
       exposure (Tailscale Funnel, Cloudflare Tunnel, or stay loopback).
       The default highlights "no thanks" on laptops and Cloudflare on
       servers (SSH session detected). Skip with --no-expose-prompt or
       pin non-interactively with --expose.
    3. Print the canonical admin URL (loopback when not exposed, the
       tailnet / cloudflare FQDN when exposure is active).
    4. In a terminal, offer to open the URL in your browser
       (macOS \`open\`, Linux \`xdg-open\`). Skip with --no-browser or
       run from a non-TTY shell.

  If your hub is up + exposure is already set up + a vault is already
  configured, init just confirms "looks good — here's your URL" and
  exits 0.

Flags:
  --no-browser              just print the URL; don't offer to launch a browser
  --no-expose-prompt        skip the exposure question; fall through to localhost URL
  --expose <choice>         non-interactive exposure override:
                              none       — stay loopback-only
                              tailnet    — set up Tailscale serve (private to your tailnet)
                              cloudflare — set up Cloudflare Tunnel (your own domain)
  --channel <rc|latest>     npm dist-tag for the vault module install (default: latest).
                            Use \`rc\` on an rc-channel box so init doesn't downgrade
                            vault below the hub. Also honors PARACHUTE_CHANNEL /
                            PARACHUTE_INSTALL_CHANNEL env when the flag is absent.
  --hub-origin <url>        set the canonical public origin (OAuth issuer) BEFORE
                            the hub + modules start, so vault/scribe come up
                            accepting it in one pass. For reverse-proxy /
                            Caddy-direct boxes that bind loopback but are reached
                            over a public HTTPS URL (e.g. https://<ip>.sslip.io).
  --vault-name <name>       create the first vault in one shot (#478 Part 2).
                            Runs \`parachute-vault create <name>\` after the hub
                            is up. Non-fatal on re-run — \`create\` exits
                            non-zero if the vault already exists, and that's
                            tolerated. Must be a valid vault name: lowercase
                            alphanumeric + hyphens/underscores, 2–32 chars.
                            Without this flag, the wizard owns vault creation
                            (the default experience is unchanged).
  --cli-wizard              skip the "browser or CLI?" prompt and walk the wizard
                            in this terminal (hub#168 Cut 4)
  --browser-wizard          skip the prompt and open the browser wizard directly

Examples:
  parachute init                              # laptop: prompts, defaults to "no expose"
  parachute init                              # ssh'd server: prompts, defaults to Cloudflare
  parachute init --no-expose-prompt           # skip the question; just print localhost URL
  parachute init --expose cloudflare          # CI/scripted: chain straight into Cloudflare
  parachute init --expose tailnet             # CI/scripted: chain straight into Tailscale
  parachute init --no-browser                 # don't shell out to open / xdg-open
  parachute init --cli-wizard                 # walk the wizard in this terminal (hub#168)
  parachute init --channel rc                 # rc box: install the vault module from @rc
  parachute init --vault-name default --no-browser
                                              # CI/scripted: hub + first vault in one pass
`;
}

export function setupWizardHelp(): string {
  return `parachute setup-wizard — terminal mirror of /admin/setup (hub#168)

Usage:
  parachute setup-wizard --hub-url <url>
                         [--account-username <name>] [--account-password <pw>]
                         [--bootstrap-token <token>]
                         [--vault-mode create|import|skip] [--vault-name <name>]
                         [--vault-import-url <url>] [--vault-import-pat <pat>] [--vault-import-replace]
                         [--expose-mode localhost|tailnet|public]

What it does:
  Walks the same three-step setup flow the browser wizard does, in your
  terminal. Hits the same backend handlers (POST /admin/setup/account,
  /admin/setup/vault, /admin/setup/expose) — so any wizard bug fix lands
  in both surfaces.

  Step 1: admin account (username + password).
  Step 2: vault (create / import from git / skip).
  Step 3: expose mode (localhost / tailnet / public).

  Idempotent: re-running picks up at the next undone step. Already-done
  steps are skipped without prompts. Same as the browser wizard.

  Run-from-flag: every prompt accepts a paired CLI flag so an entirely
  scripted setup works (CI, ansible, etc.). Mirrors the existing
  PARACHUTE_INITIAL_ADMIN_* env-seed path.

Flags:
  --hub-url <url>                base URL of the hub (required; e.g.
                                 http://127.0.0.1:1939). \`parachute init\`
                                 passes this in when chaining; standalone
                                 callers supply it explicitly.
  --account-username <name>      pre-supply the admin username (default: owner)
  --account-password <pw>        pre-supply the admin password (required when
                                 non-interactive)
  --bootstrap-token <token>      one-time bootstrap token when the hub is in
                                 container/serve mode. Reads PARACHUTE_BOOTSTRAP_TOKEN
                                 from the env if not passed.
  --vault-mode create|import|skip   pre-pick the vault step's branch
  --vault-name <name>            pre-supply the vault name (create / import)
  --vault-import-url <url>       remote URL for import mode (HTTPS or SSH git URL)
  --vault-import-pat <pat>       PAT for private repo import (optional)
  --vault-import-replace         use replace mode (default is merge)
  --skip-vault                   shorthand for --vault-mode skip
  --expose-mode <mode>           pre-pick the expose-mode answer

Examples:
  parachute setup-wizard --hub-url http://127.0.0.1:1939
      # walks all three steps interactively

  parachute setup-wizard --hub-url http://127.0.0.1:1939 \\
    --account-username admin --account-password 'long-pw-here' \\
    --vault-mode create --vault-name default \\
    --expose-mode localhost
      # fully non-interactive (CI-friendly)

  parachute setup-wizard --hub-url http://127.0.0.1:1939 \\
    --vault-import-url https://github.com/me/my-vault.git \\
    --vault-import-pat ghp_xxx
      # imports an existing vault export from GitHub
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
  Reads ~/.parachute/services.json. For each registered module:
    - reads its run state from the running hub's supervisor (supervisor.list())
    - probes http://localhost:<port><health> (skipped for known-stopped modules)
    - classifies the install source as bun-linked (local checkout) or npm

  The hub gets its own row, derived from the platform process manager
  (launchd \`launchctl print\` / systemd \`systemctl is-active\`, or
  "container runtime (managed)" on Render / Fly) — the supervisor runs the
  modules, but the manager runs the hub. The hub row appears even with zero
  modules installed.

  The STATE column rolls process state + probe result into one of four
  canonical labels (per parachute-hub/docs/contracts/design-system.md §6):
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

  Stopped modules render as STATE=inactive and don't count toward the
  exit code — they're an expected state after fresh install before
  \`parachute start\`. Supervised modules that fail health checks render
  as STATE=failing and exit 1.

  A "STALE: services.json cached … live package.json …" continuation line
  appears under a row when a bun-linked service has been rebuilt but the
  manifest's cached version hasn't caught up — re-install (\`parachute
  install <pkg>\`) refreshes the row.

Exit codes:
  0   all probed services healthy (or none running)
  1   one or more probed services unhealthy

Example:
  $ parachute status
  SERVICE            PORT  VERSION  STATE   PID    UPTIME  LATENCY  SOURCE
  parachute-vault    1940  0.2.4    active  12345  2h 13m  2ms      bun-linked → parachute-vault @ 8aa167b
    → http://127.0.0.1:1940/vault/default/mcp
  parachute-surface  1946  0.2.0    active  12346  2h 12m  3ms      npm (0.2.0-rc.4)
    → http://127.0.0.1:1946/surface
`;
}

export function doctorHelp(): string {
  return `parachute doctor — health / diagnostics for your Parachute install

Usage:
  parachute doctor [--json]
  parachute doctor --fix [--yes]

What it does:
  Runs a set of independent health checks and prints a grouped report
  (✓ pass / ⚠ warn / ✗ fail), each with a one-line detail and — where there
  is one — a copy-pasteable fix-it command. The single command that answers
  "is my Parachute healthy, and if not, what's the one thing to fix?"

  Checks (each PASSES on a fresh / fully-current install — doctor positively
  detects a known-bad condition and never treats "not configured" as broken):
    - Hub supervisor reachable on :1939 (/health).
    - Each CONFIGURED module alive via its loopback /health (2xx or 401 = live).
    - services.json parses + required fields valid (a missing file is the
      fresh pre-install state, not a failure).
    - Services on canonical ports — flags any KNOWN module whose port has
      drifted off its canonical slot, or two services sharing one port
      (legacy services.json written before the validation gate). A
      third-party service with no canonical port is never flagged.
    - operator.token exists, parses, and its issuer matches the hub (the
      recurring "not signed in to the hub" / issuer-mismatch class).
    - Each first-party module bin is executable (catches the lost-+x-bit
      start-failure class).
    - Migration: legacy detached install? known cruft at the ecosystem root?
      (allowlist detectors only — a fresh root flags nothing).
    - Exposure: if exposed, is the public origin reachable? If not exposed,
      "loopback only" is reported as benign info, never a warning.
    - Version freshness (cosmetic) — drift is WARN at most, never a failure.

Flags:
  --json     emit a single JSON object instead of the human report
  --fix      repair canonical-port drift in services.json — and ONLY that.
             It is NOT a "fix everything" flag; every other check stays
             report-only. Shows the old→new diff first, then confirms before
             writing (a TTY prompts; --yes skips the prompt; a non-TTY without
             --yes bails without writing). Idempotent: a clean file is a no-op.
             Duplicate-port collisions are reported, not auto-resolved.
  --yes      skip the --fix confirmation prompt (required to apply in a
             non-interactive shell)

Exit codes:
  0   no failures (warnings are advisory and still exit 0); --fix: applied or
      nothing-to-fix
  1   one or more checks failed; or --fix bailed (non-TTY without --yes /
      aborted at the prompt / unreadable services.json)
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
  parachute expose cloudflare --domain <hostname>           # alias for the above

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
  --tunnel-name <name>    Cloudflare tunnel name. Defaults to a per-hostname
                          name (e.g. vault.example.com → parachute-vault-example-com)
                          so each machine gets its OWN dedicated tunnel —
                          Cloudflare tunnels are account-wide, and sharing one
                          across machines collides their connectors. You don't
                          need to create the tunnel yourself; expose does it.
                          Override only to pin a specific name.
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
  parachute expose cloudflare --domain vault.example.com   # alias for the line above
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
  return `parachute start — start a module via the running hub's supervisor

Usage:
  parachute start                   ensure the hub is up (boots every module)
  parachute start <service>         start just that one module
  parachute start hub               ensure the hub unit is up

What it does:
  \`parachute serve\` is the one runtime — the hub foreground with an
  in-process supervisor that runs each module as an attached child. These
  verbs are clients of that running hub:

  - \`parachute start <service>\` ensures the hub unit is up, then asks its
    supervisor to start that one module (over the loopback module-ops API,
    authenticated with your operator token). No per-module daemon is
    spawned — the supervisor owns the module process.
  - \`parachute start\` (no service) ensures the hub unit is up. The hub
    boots every installed module on start, so this brings the whole stack
    up. On a box with no hub unit yet, it offers to run
    \`parachute migrate --to-supervised\` (which installs + starts the unit).
  - \`parachute start hub\` is the same "ensure the hub unit is up."

  Idempotent: starting an already-running module is a no-op.

Flags:
  --hub-origin <url>    override the hub origin used as the operator token's
                        \`iss\` validator on the loopback module-ops call
                        (default: current expose-state hub origin, else loopback).

Examples:
  parachute start                   bring everything up
  parachute start vault             just vault, via the supervisor
  parachute logs vault              watch what just started

Module start commands (run by the supervisor under \`serve\`):
  vault     parachute-vault serve
  scribe    parachute-scribe serve
  surface   parachute-surface serve
  agent     parachute-agent
  app       bun <cli>/notes-serve.ts --port <configured> --mount <paths[0]> --package @openparachute/parachute-app
  notes     bun <cli>/notes-serve.ts --port <configured> --mount <paths[0]>   # back-compat: legacy notes-daemon
`;
}

export function stopHelp(): string {
  return `parachute stop — stop a module (or the hub) cleanly

Usage:
  parachute stop                    stop the hub unit (modules stop with it)
  parachute stop <service>          stop just that one module
  parachute stop hub                stop the hub unit

What it does:
  - \`parachute stop <service>\` asks the running hub's supervisor to stop
    that one module (SIGTERM to the module's process group, then SIGKILL if
    it doesn't exit). No-op if it wasn't running.
  - \`parachute stop\` (no service) and \`parachute stop hub\` stop the hub
    UNIT through the platform process manager (\`launchctl bootout\` /
    \`systemctl stop\`) — never a raw PID signal, which launchd's KeepAlive
    would just undo. Modules are attached children and stop with the hub.

Examples:
  parachute stop vault              just vault, via the supervisor
  parachute stop                    stop the whole stack (the hub unit)
`;
}

export function restartHelp(): string {
  return `parachute restart — restart a module (or the hub)

Usage:
  parachute restart                 restart the hub unit (re-boots every module)
  parachute restart <service>       restart just that one module
  parachute restart hub             restart the hub unit

What it does:
  - \`parachute restart <service>\` asks the running hub's supervisor to
    restart that one module. If the module isn't currently supervised
    (e.g. it crashed out of its restart budget), this falls through to a
    fresh \`start\` so the verb is total over module state.
  - \`parachute restart\` (no service) and \`parachute restart hub\` restart
    the hub UNIT via the platform manager (\`launchctl kickstart -k\` /
    \`systemctl restart\`), which re-boots every module — it is NOT a
    fan-out of per-module restarts.
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

  The "restart" step matches the supervised model: upgrading a MODULE
  restarts it via the running hub's supervisor; \`parachute upgrade hub\`
  rewrites the binary on disk, then restarts the hub UNIT through the
  platform manager (\`launchctl kickstart -k\` / \`systemctl restart\`), which
  re-boots every module onto the new code. From the admin SPA (the no-CLI
  Render / Fly path) the same hub-upgrade runs via POST /api/hub/upgrade.

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
  parachute logs hub                the full hub log (every module interleaved)

Where logs live:
  Supervised modules (the normal shape — hub-as-supervisor) write through
  the hub: the supervisor multiplexes each child's output into
  ~/.parachute/hub/logs/hub.log with a \`[<service>]\` line prefix.
  \`parachute logs <service>\` reads that stream filtered to the service's
  lines, prefix stripped (-n caps the MATCHING lines, not raw hub-log
  lines; \`logs hub\` is unfiltered). A legacy per-service file
  (~/.parachute/<service>/logs/<service>.log) is read instead when it is
  fresher than the hub log — the pre-supervised install shape.

If no log lines exist yet, prints a hint to \`parachute start <service>\`.
`;
}

export function serveHelp(): string {
  return `parachute serve — run the hub + supervisor foregrounded (the runtime)

Usage:
  parachute serve

This is the one runtime everywhere. The hub IS the foreground process: it
runs the HTTP server on port 1939 AND an in-process supervisor that spawns
every installed module as an attached child, multiplexes their logs into
its own stdout, and crash-restarts them on a budget. It runs until it gets
a signal, then SIGTERMs its children and exits.

You don't normally invoke \`serve\` by hand — \`parachute init\` (or
\`parachute migrate --to-supervised\`) installs it as a managed unit so your
platform's process manager keeps it alive across crashes and reboots:
launchd on a Mac, systemd on a Linux VM, the container runtime's CMD on
Render / Fly. Run it directly only for a foregrounded local debug, or on an
init-less host that can't host a unit.

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
  return `parachute migrate — archive legacy root files, or cut over to the supervised model

Usage:
  parachute migrate [--list] [--dry-run] [--yes]
  parachute migrate --to-supervised
  parachute migrate --teardown

What it does (the default archive sweep):
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

Archive-sweep safety:
  - Refuses to sweep while any service is running — stop them first
    (\`parachute stop\`) or preview with \`--list\`. A hub running under a
    process-manager unit (the supervised model) is detected as running
    via the platform manager too, not just its pidfile.
  - SQLite-shape files (\`*.db\`, \`*.db-wal\`, \`*.db-shm\`) get a
    \`[live-db]\` label and pull an extra confirmation; wal/shm
    consistency depends on all three moving together.
  - Plan annotates each entry: \`[safe]\` / \`[live-db]\` /
    \`[unknown — skipping]\`, with skipped items printed last.
  - In a non-TTY shell (CI / piped), refuses without \`--yes\`.

--to-supervised (detached → supervised cutover):
  Migrate a legacy detached install (independent \`parachute start\`-spawned
  daemons) to the supervised model: the hub runs as \`parachute serve\`
  under your platform's process manager (launchd on macOS, systemd on
  Linux), survives reboots, and supervises modules as children. The
  cutover is idempotent + re-runnable, and ordered so it never races the
  canonical hub port: it writes the unit file WITHOUT starting it, stops
  the detached hub + modules, sweeps any process still bound to a declared
  port, verifies the ports are free, THEN starts the unit and verifies the
  hub is healthy. If anything fails partway it leaves the box recoverable
  (unit written but not started) and you can simply re-run it. A box with
  no service manager (a container / init-less host) can't host a unit —
  run \`parachute serve\` in the foreground there instead.

--teardown (cutover rollback):
  Remove the hub process-manager unit. Idempotent + best-effort. Use it to
  roll back a cutover: the unit is removed and you fall back to running the
  hub with \`parachute serve\` (or re-run \`--to-supervised\` to reinstall it).
  Run this BEFORE \`bun remove -g @openparachute/hub\` so a removed package
  doesn't leave a unit pointing at a deleted binary.

Flags:
  --list           print the plan; make no changes (friendly preview)
  --dry-run        synonym for --list (kept for back-compat)
  --yes, -y        skip the confirmation prompt; required in non-TTY shells
  --to-supervised  cut over a detached install to the supervised model
  --teardown       remove the hub unit (cutover rollback)

Examples:
  parachute migrate --list            see what would move, without touching anything
  parachute migrate                   interactive sweep (prompts before acting)
  parachute migrate --yes             sweep without prompting
  parachute migrate --to-supervised   move to the supervised (serve-under-manager) model
  parachute migrate --teardown        remove the hub unit (roll back the cutover)
`;
}

export function surfaceHelp(): string {
  return `parachute surface — manage Parachute surfaces (Surface Git Transport)

Usage:
  parachute surface token mint <name> [--read|--write] [--ttl <dur> | --expires-in <s>] [--json]
  parachute surface token list [<name>] [--json]
  parachute surface token revoke <jti>

Deploy tokens — a GitHub-PAT-equivalent, git-native:
  A surface lives as a git repo the hub authenticates (\`/git/<name>\`). A deploy
  token lets an EXTERNAL/remote git client — a \`claude -p\` agent, or any machine
  — push/pull that repo with nothing but a static secret. No browser, no device
  flow. Mint one, hand it over, and \`git push\` just works.

  The token is scoped to ONE surface + one verb (read xor write), registered, and
  revocable — so you can list your deploy tokens and kill a leaked one, exactly
  like managing GitHub PATs. Default lifetime is 90 days (re-mint to renew).

token mint <name>          mint a deploy token for surface <name>.
  --write                  push access — \`surface:<name>:write\` (DEFAULT; a
                           deploy token's job is to push). write also allows fetch.
  --read                   clone/fetch only — \`surface:<name>:read\`.
  --ttl <dur>              lifetime as a duration (90d / 24h / 30m / 60s).
                           Default 90d; capped at 365d.
  --expires-in <seconds>   lifetime in integer seconds (alternative to --ttl).
  --json                   emit a JSON blob (token + jti + scope + remoteUrl +
                           the git credential-helper one-liner) for scripted /
                           agent config. Otherwise the token is printed to stdout
                           (pipe-safe) and setup guidance to stderr.

token list [<name>]        list deploy tokens (newest first), optionally narrowed
                           to one surface. Shows jti, surface, access, status
                           (active / revoked / expired), and expiry. --json for
                           machine output. Never prints the token bytes.

token revoke <jti>         revoke a deploy token by jti (find it via \`token list\`).
                           Effective immediately — the git endpoint rejects it on
                           the next push (per-request revocation check). Idempotent.
                           Refuses non-deploy-token jtis — use
                           \`parachute auth revoke-token\` for those.

The remote-client setup (git-native, no \`gh\`, no parachute install needed):

  # on the remote machine:
  export PARACHUTE_SURFACE_TOKEN=<the-token>
  git config --global credential.helper \\
    '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$PARACHUTE_SURFACE_TOKEN"; }; f'
  git clone https://<hub-origin>/git/<name> && cd <name>   # edit, then:
  git push

  \`parachute surface token mint\` prints this with your hub origin filled in.
  A reusable \`git-credential-parachute\` helper script ships in the hub repo's
  scripts/ for boxes that prefer a named helper on PATH.

Auth:
  mint / list / revoke require the on-disk operator token to carry
  \`parachute:host:auth\` (the \`auth\` or \`admin\` scope-set) — the same gate as
  \`parachute auth mint-token\`. Run \`parachute auth set-password\` (first run) or
  \`parachute auth rotate-operator\` if you don't have one.
`;
}
