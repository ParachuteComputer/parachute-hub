# Tier-1 E2E — systemd-in-container fresh-install harness

This directory holds the **Tier 1** end-to-end harness for the hub: a
systemd-in-container test that runs the **real fresh-Linux install flow** an
operator runs on a VPS — `curl bun.sh/install` → `bun add -g
@openparachute/hub` → `parachute init` → setup wizard → MCP — and replays the
field-failure scenarios from recent weeks as staged assertions.

It is the load-bearing answer to "the rcs are unit-tested but never live-
validated." It exercises the **real shipped artifact** (from npm, or from a
`bun pm pack` of the local checkout) on a real systemd box, not mocks.

## Why systemd-in-container

The install bugs that bite operators live in the **systemd-unit lifecycle** —
zombie units surviving a config wipe, dead SQLite handles behind a green
`/health`, version-mismatch adoption of a stale running hub. The existing
`container-smoke.yml` runs `parachute serve` in the *foreground* (the
container runtime is the supervisor), which **cannot** reach that code: there
is no systemd unit to zombie, adopt, or restart.

So this image runs **Ubuntu with systemd as PID 1** (a privileged container).
`parachute init` then installs and manages a **real `parachute-hub.service`
systemd unit** — exactly like an operator's Hetzner / DigitalOcean / EC2 box.
The harness drives the actual unit-install → start → readiness → adoption →
restart paths.

## Two-tier strategy

- **Tier 1 (this harness)** — deterministic, scripted, assertion-based. Fast
  to reason about, runs in CI, pins specific field incidents. The contents of
  this directory.
- **Tier 2 (separate, later)** — an LLM-driven runbook that explores the
  install the way a confused human would (wrong flags, half-finished wizard,
  "why won't it connect"), surfacing UX gaps a fixed script can't. Tier 1 is
  the regression net; Tier 2 is the fuzzer. Not in this PR.

## Files

| File | Role |
|---|---|
| `Dockerfile.systemd` | Ubuntu 24.04 + systemd PID 1. Bakes only OS deps a real box has (curl, unzip, ca-certs, git, python3, `dnsutils` for `dig`) — **not** bun or parachute (installing those is the test). Masks container-hostile units. |
| `run.sh` | Host-side driver (runs on macOS / ubuntu runners). Builds the image, boots the container with the systemd flags, waits for `systemctl is-system-running`, copies + execs the staged script, **always** tears down (trap), prints a per-stage summary table. |
| `stages.sh` | Runs **inside** the container as root (matching real fresh-VPS transcripts). The staged assertions. |
| `mcp-probe.ts` | The full OAuth dance + MCP round-trip, run with `bun` inside the container. DCR → login → PKCE authorize/consent → token → MCP `initialize`/`tools/list`/`create-note`/`query-notes`. Takes `--hub <origin>`, so Stage 3 re-runs it against the **public** tunnel origin. |
| `cf-dns-cleanup.ts` | Stage-3 DNS-record teardown. `cloudflared` can create a CNAME (`tunnel route dns`) but has no delete; this parses the `cfut_…` API token embedded in the cloudflared cert.pem, authenticates with `Authorization: Bearer` (the token that **created** the record can **delete** it — self-contained, no second secret), deletes the per-run record via the CF API, and **self-verifies** the zone re-list is empty before exiting 0. So the shared test zone never accumulates orphaned records. |
| `e2e.yml` (in `.github/workflows/`) | `workflow_dispatch` + `push: tags v*`. Passes `secrets.CLOUDFLARED_CERT_PEM` + `vars.E2E_TEST_ZONE` so Stage 3 runs in CI. |

## Running it locally

```sh
# default: install @openparachute/hub@rc from npm, vault module @rc
./e2e/run.sh

# pin a specific published version
HUB_SOURCE=npm:0.6.5-rc.4 ./e2e/run.sh

# test UNPUBLISHED local code through the published-artifact path:
# `bun pm pack` runs prepack (build:spa) + applies the `files` allowlist —
# closest to what `npm publish` ships. This is the pre-push check for big changes.
HUB_SOURCE=local ./e2e/run.sh

# install the vault module from @latest instead of @rc
VAULT_CHANNEL=latest ./e2e/run.sh

# keep the container up after the run for post-mortem poking
E2E_KEEP=1 ./e2e/run.sh
# then: docker exec -it <container> bash
```

Requires Docker (Desktop on macOS, or the daemon on Linux). The container is
the sandbox — the harness **never** touches the host's launchd / live hub /
`~/.parachute`. Everything is scoped to a uniquely-named
`e2e-parachute-<pid>-<epoch>` container + image, and torn down on every exit.

### Env vars

| Var | Default | Meaning |
|---|---|---|
| `HUB_SOURCE` | `npm:rc` | `npm:<spec>` installs `@openparachute/hub@<spec>`; `local` packs + installs the checkout. |
| `VAULT_CHANNEL` | `rc` | vault module install channel (`PARACHUTE_INSTALL_CHANNEL`). |
| `E2E_KEEP` | — | `1` skips teardown. |
| `E2E_DOCKER` | `docker` | docker binary override. |
| `CLOUDFLARED_CERT_PEM` | — | Stage 3 arm. The cloudflared origin cert for the test zone, as **either a file path or the literal PEM text** (auto-detected via `-----BEGIN`). Absent → Stage 3 SKIPs. Never committed; copied into the container as a file, not an `-e` env arg. |
| `E2E_TEST_ZONE` | `parachute.place` | Cloudflare zone the per-run hostname (`e2e-<runid>.<zone>`) is provisioned under. |

## What each stage covers + which incident it pins

| Stage | Asserts | Field incident pinned |
|---|---|---|
| **1 — fresh install happy path** | bun installs; `bun add -g @openparachute/hub` shows **no** "Blocked postinstall"; `parachute init` brings up an **active** `parachute-hub.service`; `/health` is 200 with `db:"ok"`; vault module installs honoring `PARACHUTE_INSTALL_CHANNEL`; the setup wizard (driven over loopback, bootstrap-token-free per #576) creates the admin + sets expose; a named vault is created + served (401 auth-gated health); the **full OAuth dance + MCP note round-trip** succeeds; `mint-token` → REST `/api/notes` 200. | **#568** (blocked-postinstall regression), **#576** (loopback wizard token-free), **#594** (`/health` `db` field), **#423** (401 = healthy vault). |
| **2 — idempotent re-run** | a second `parachute init` exits 0; hub still `db:"ok"`; **exactly one** `parachute-hub` unit (no duplicate); admin preserved — the setup probe is asserted to return a **recognized non-empty** token (an empty probe result is a HARD fail, never a silent pass). | the "re-running init duplicated/zombied a unit" class. |
| **3 — public Cloudflare expose** | installs `cloudflared` (static binary), places the origin cert, runs the **real** `parachute expose public --cloudflare --domain <per-run FQDN>`, then asserts the **public URL serves** in two phases — **Phase A** waits for DNS to resolve (`dig @1.1.1.1`, bypassing the container's stub-resolver negative-cache, bounded 180s); **Phase B** probes `https://<fqdn>/health` → 200 `db:ok` pinned to the resolved edge IP (`curl --resolve`). Three-way failure classification: DNS-never-resolves vs resolves-but-1033 (connector down) vs resolves-and-up-but-5xx (product bug). Then re-runs the **full OAuth dance + MCP round-trip over the public origin** (`mcp-probe.ts --hub https://<fqdn>`) — recorded **separately** as `stage3-mcp-public`, a **hard PASS** (since vault 0.5.3-rc.3 + scope-guard 0.4.1-rc.1, vault fetches JWKS from the **local hub on loopback** instead of via the public FQDN, so MCP-over-public no longer hairpins through the tunnel — **vault#464 fixed**; a JWKS-fetch-timeout here would be a regression → real FAIL). Checks the origin-pinned-credential self-heal (vault `.env` `PARACHUTE_HUB_ORIGIN` → public origin, survives a restart), and **always tears the tunnel + DNS record down + verifies zero orphans** (in-container trap + host-side net). **Runs BEFORE the wipe stage** (Stage 4) on purpose — its MCP-over-public step needs the admin + vault that Stage 1 created, which Stage 4's `rm -rf` destroys. **Gated:** with no `CLOUDFLARED_CERT_PEM` it SKIPs (stages 1, 2 + 4 still run green). | **#593** / error-**1033** (connector verified before "tunnel up"; failure-mode disambiguated from DNS-propagation), **#503/#481** (origin-pinned-credential self-heal on expose / clear on teardown), the Cloudflare connector OAuth-403 field cases. **vault#464 fixed** (loopback JWKS — no longer hairpins; `stage3-mcp-public` is now a hard PASS). |
| **4 — wipe recovery (the laptop scenario)** | `rm -rf ~/.parachute` while the unit runs — the **destructive stage, runs LAST** so it doesn't pull the admin/vault out from under Stage 3's MCP-over-public. **Proves a REAL, AUTOMATIC recovery, not a stale-handle lie:** captures the unit MainPID + confirms `hub.db` is actually gone from disk, then requires the hub to **SELF-recover with NO operator nudge** — (a) **change the MainPID** (fresh process == fresh DB handle), (b) put `hub.db` **back on disk**, and (c) serve `/health` `db:ok` — within the wait window, driven by the **#610 proactive watchdog** (stat the db path → detect ENOENT/inode-mismatch → `exit(1)` → systemd restart). Then re-runs `parachute init` (must not wedge, #590) and asserts the vault install **reclaims the canonical port** (adopt-kill the surviving child, **#609**) instead of port-walking off 1940. A hub that does **not** self-recover is a **#610 regression → hard FAIL** (there is deliberately no rescue restart). | **#610** (proactive self-recovery from a wiped state-dir), **#609** (re-init reclaims the canonical port from the surviving vault child), **#594** (reactive dead-DB-handle heal), **#590** (stale-zombie version adoption). |

### Why the wipe stage (Stage 4) is built this way (false-pass avoidance)

> **Ordering note:** the wipe-recovery stage runs **last (Stage 4)**, after the public-expose stage (Stage 3). It was originally Stage 3, but its `rm -rf ~/.parachute` destroys the admin + vault that Stage 1 creates — which Stage 3's MCP-over-public round-trip needs (a post-wipe public origin correctly returns `setup_required`, which would fail the MCP probe). Sequencing the destructive stage last lets every stateful stage run against the live admin/vault, then tears the world down at the end.

A naive wipe stage — `rm -rf ~/.parachute` then `wait_for db:"ok"` — **passes exactly when #594 regresses.** A hub serving from a deleted-but-still-open SQLite fd reports `db:"ok"` immediately (its `SELECT 1` succeeds against the ghost inode), so the probe greens without any real recovery. The hardened stage instead asserts a *process restart* (MainPID change) + a *fresh on-disk `hub.db`* + a coherent re-init, which a stale handle cannot fake.

**Post-#610 (this PR):** the hub now **self-recovers automatically** — a bounded proactive watchdog (`startDbPathLivenessTimer` → `DbHolder.probePath`) stat()s the db path on a low-frequency timer and compares its inode to the open handle's; on a wiped path (ENOENT / inode mismatch) it triggers reopen-or-exit, the path is gone so reopen's verify fails, and the unit `exit(1)`s → systemd restarts with a fresh on-disk handle in seconds. The stage records the **ghost-fd fingerprint** (`/proc/<pid>/fd/* -> …/hub.db (deleted)`) purely as a diagnostic now, and classifies **two ways**:

1. **PASS** — the hub **self-recovered with no operator nudge**: MainPID changed, `hub.db` back on disk, `/health` `db:ok`, and the re-init reclaimed the canonical port (#609). A *transient* ghost-fd sighting before the watchdog heals it is expected and benign (the timer fires a beat after the unlink) — it no longer downgrades the result.
2. **`FAIL` (#610 regression)** — the hub did **not** self-recover within the window. The proactive watchdog should have detected the wiped path and exited; if it didn't, that's a regression. The stage dumps the still-open ghost-fd(s) + unit status and hard-fails (non-zero). There is deliberately **no rescue `systemctl restart`** — the whole point of #610 is that recovery is automatic, so rescuing here would re-hide the regression.

**History (rc 0.6.5-rc.4, the run that filed hub#610 + hub#609):** before this PR the hub did **not** auto-self-heal from a wiped state-dir on Linux — the #594 self-heal is *reactive* (fires only on a thrown SQLite error), but an unlinked-but-open fd keeps reads/writes succeeding, so the handle was never reopened and `/health` stayed green on a ghost DB indefinitely; only an **operator `systemctl restart`** recovered it. That gap was tracked as hub#610 (and the post-wipe re-init port-walking vault off :1940 as hub#609). This PR closes both: the proactive watchdog (#610) + the install-time canonical-port adopt-kill (#609).

### Result statuses

`PASS` / `FAIL` / `SKIP` as usual, plus **`XFAIL`** — a *known, tracked, reported-in-the-PR* live bug the harness deliberately surfaces (loud in the summary, but does **not** fail the suite, so the harness stays usable as a gate while screaming the finding). **No stage XFAILs today** — the two that did (`stage4-wipe-recovery`→hub#610, `stage3-mcp-public`→vault#464) both flipped to **hard PASS** once their fixes landed:

> **`stage4-wipe-recovery` flipped XFAIL(#610) → PASS:** the proactive watchdog now self-recovers automatically, so the stage asserts recovery with no operator nudge; a hub that does *not* self-recover is a real `FAIL` (#610 regression).
>
> **`stage3-mcp-public` flipped XFAIL(vault#464) → PASS:** vault now fetches JWKS from the local hub (loopback) instead of hairpinning through the public tunnel, so MCP-over-public must succeed; a JWKS-fetch-timeout is a real `FAIL` (vault#464 regression).

The `xfail()` primitive is retained for the *next* found-bug. A new/unexpected failure always `FAIL`s and aborts with a non-zero exit. `run.sh` exits 0 (all PASS, or with a warning banner if any XFAIL is ever active), non-zero on any FAIL.

## Stage 3 — the real Cloudflare expose path

The loopback core (install/idempotent + wipe-recovery) landed in PR 1 (#606).
PR 2 adds the **real** public-expose path as **Stage 3** — the highest-value
stage, exercising `parachute expose --cloudflare` → real tunnel → public FQDN →
MCP-over-public, the exact path where field error-1033 and the origin-pinned-
credential staleness lived. It runs **before** the destructive wipe stage
(Stage 4) so its MCP-over-public round-trip has the live admin + vault Stage 1
created.

**Creds.** Stage 3 is gated on `CLOUDFLARED_CERT_PEM` (the cloudflared origin
cert for the test zone). In CI that's the `CLOUDFLARED_CERT_PEM` secret; for a
local run, export it (path or inline). Without it, Stage 3 SKIPs and the other
stages still run — contributors with no test-zone creds keep a useful run. The
zone is `E2E_TEST_ZONE` (default `parachute.place`).

**Per-run isolation.** Each run provisions a UNIQUE hostname
`e2e-<runid>.<zone>` (the suffix derives from the host RUN_ID = epoch+pid), so
concurrent/repeat runs never collide and a crashed run never poisons the next —
each run's tunnel + DNS record is uniquely named and torn down independently.

**What it asserts.** Install `cloudflared` (static binary, the path the product
drives) → place the cert at `~/.cloudflared/cert.pem` → run the real
`parachute expose public --cloudflare --domain <fqdn>` → verify the **public**
URL serves through the tunnel (two phases, below) → re-run the **full OAuth
dance + MCP round-trip over the public origin** → check the origin-pinned-
credential self-heal (vault `.env` `PARACHUTE_HUB_ORIGIN` reflects the public
origin and survives a restart; cleared on teardown — #503/#481).

**Public-serve probe — two phases, never conflated.** The naive "loop curl
until /health is green" false-FAILs: the container's stub resolver
negatively-caches the pre-creation NXDOMAIN, so `curl` gets "Could not resolve
host" for the whole window even when the connector is confirmed up — and the
FAIL blames 1033, hiding that DNS was the issue. Instead:
- **Phase A — DNS resolution.** Poll `dig @1.1.1.1 <fqdn>` (query Cloudflare's
  resolver *directly*, dodging the container's negative-cache), bounded 180s.
  If it never resolves → FAIL labelled **DNS-never-resolves** (propagation/zone),
  with the connector count printed for context (so a fine connector isn't
  blamed).
- **Phase B — health through the edge.** Pin `curl --resolve <fqdn>:443:<ip>`
  to the resolved edge IP (so it doesn't re-hit the stub resolver) and poll for
  200 `db:ok`. On failure, classify: **resolves-but-1033** (connector count 0 /
  a 1033 body — the #593 connector-down path) vs **resolves-and-up-but-5xx** (a
  real product bug). Before the MCP phase, the container resolver is repointed
  at 1.1.1.1 so `mcp-probe.ts`'s `fetch()` resolves fresh too.

**Teardown is non-negotiable — zero orphans guaranteed.** The tunnel AND the
per-run DNS record are deleted on EVERY exit — success, assertion failure, or
container death:
- In-container trap (`stage4_teardown`, fires on the stage's `EXIT`/`die`):
  `parachute expose … off` → `cloudflared tunnel delete -f <name>` →
  `cf-dns-cleanup.ts` deletes the CNAME via the CF API and **self-verifies the
  zone re-list is empty** before exiting 0. cloudflared has no unroute command,
  so the helper hits the CF API directly — authenticating with the `cfut_…`
  token embedded in the cert via `Authorization: Bearer` (**the token that
  created the record can delete it** — self-contained, no second secret). The
  trap then does an independent `dig @1.1.1.1` NXDOMAIN check.
- Host-side net in `run.sh`'s trap: re-runs the same `tunnel delete` +
  `cf-dns-cleanup.ts` for the case where the whole container dies before its
  trap can run, surfacing a leak LOUDLY. Best-effort, idempotent (deleting an
  already-gone record is a no-op). A leaked tunnel/DNS record per run is
  unacceptable on a shared zone.

> **Auth note (the orphan bug this fixes):** the cert token is a Cloudflare
> *API token* (`cfut_…`), not a legacy "service key". The first cut sent it via
> the legacy `X-Auth-User-Service-Key` header, which the generic `/dns_records`
> endpoint rejects with HTTP 400 — so teardown failed and leaked a CNAME.
> `cf-dns-cleanup.ts` now sends `Authorization: Bearer` first (verified live
> against the CF API), falling back to the legacy header only for genuinely-old
> `serviceKey`/`s` certs.

## When to run it

- **Pre-push, for big changes** — `HUB_SOURCE=local ./e2e/run.sh` before
  opening a PR that touches install / init / hub-unit / wizard / serve. This
  catches the live-only bugs unit tests can't (the whole reason the harness
  exists).
- **On rc tags** — the `push: tags v*` trigger runs it against the freshly-
  published `npm:rc` artifact, so every rc is live-validated, not just
  unit-tested.
- **Before a stable release** — dispatch it manually (`workflow_dispatch`)
  against the exact version about to be promoted.

## CI note

The workflow triggers on `workflow_dispatch` + `push: tags v*` — **not** on
`pull_request` (it's heavy and needs a privileged container, and the
load-bearing verification is the local pre-push run). That means it does **not**
run at PR-review time; dispatch it manually post-merge / it fires on the next
tag push. Privileged docker is available on `ubuntu-latest` runners.
