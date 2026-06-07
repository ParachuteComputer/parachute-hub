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
| `Dockerfile.systemd` | Ubuntu 24.04 + systemd PID 1. Bakes only OS deps a real box has (curl, unzip, ca-certs, git, python3) — **not** bun or parachute (installing those is the test). Masks container-hostile units. |
| `run.sh` | Host-side driver (runs on macOS / ubuntu runners). Builds the image, boots the container with the systemd flags, waits for `systemctl is-system-running`, copies + execs the staged script, **always** tears down (trap), prints a per-stage summary table. |
| `stages.sh` | Runs **inside** the container as root (matching real fresh-VPS transcripts). The staged assertions. |
| `mcp-probe.ts` | The full OAuth dance + MCP round-trip, run with `bun` inside the container. DCR → login → PKCE authorize/consent → token → MCP `initialize`/`tools/list`/`create-note`/`query-notes`. |
| `e2e.yml` (in `.github/workflows/`) | `workflow_dispatch` + `push: tags v*`. |

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

## What each stage covers + which incident it pins

| Stage | Asserts | Field incident pinned |
|---|---|---|
| **1 — fresh install happy path** | bun installs; `bun add -g @openparachute/hub` shows **no** "Blocked postinstall"; `parachute init` brings up an **active** `parachute-hub.service`; `/health` is 200 with `db:"ok"`; vault module installs honoring `PARACHUTE_INSTALL_CHANNEL`; the setup wizard (driven over loopback, bootstrap-token-free per #576) creates the admin + sets expose; a named vault is created + served (401 auth-gated health); the **full OAuth dance + MCP note round-trip** succeeds; `mint-token` → REST `/api/notes` 200. | **#568** (blocked-postinstall regression), **#576** (loopback wizard token-free), **#594** (`/health` `db` field), **#423** (401 = healthy vault). |
| **2 — idempotent re-run** | a second `parachute init` exits 0; hub still `db:"ok"`; **exactly one** `parachute-hub` unit (no duplicate); admin preserved — the setup probe is asserted to return a **recognized non-empty** token (an empty probe result is a HARD fail, never a silent pass). | the "re-running init duplicated/zombied a unit" class. |
| **3 — wipe recovery (the laptop scenario)** | `rm -rf ~/.parachute` while the unit runs. **Proves a REAL recovery, not a stale-handle lie:** captures the unit MainPID + confirms `hub.db` is actually gone from disk, watches for the ghost-fd fingerprint, then classifies three-way (clean PASS / known-#610 XFAIL / genuine FAIL — see below). On the happy path it requires recovery to (a) **change the MainPID** (fresh process == fresh DB handle) AND (b) put `hub.db` **back on disk**, before re-running `parachute init` (must not wedge, #590) + asserting the wizard is coherent. | **#594** (dead-DB-handle: green `/health` on a ghost DB), **hub#610** (the ghost-fd self-heal gap), **#590** (stale-zombie version adoption). |
| **4 — expose** | prints SKIPPED (stable stage numbering). | — (PR 2). |

### Why Stage 3 is built this way (false-pass avoidance)

A naive Stage 3 — `rm -rf ~/.parachute` then `wait_for db:"ok"` — **passes exactly when #594 regresses.** A hub serving from a deleted-but-still-open SQLite fd reports `db:"ok"` immediately (its `SELECT 1` succeeds against the ghost inode), so the probe greens without any real recovery. The hardened stage instead asserts a *process restart* (MainPID change) + a *fresh on-disk `hub.db`* + a coherent re-init, which a stale handle cannot fake.

It records the **ghost-fd fingerprint** (`/proc/<pid>/fd/* -> …/hub.db (deleted)`) *independently of recovery*, then classifies three ways:

1. **Clean PASS** — recovered (self- or restart-) with a fresh on-disk DB AND **no** ghost-fd was ever observed.
2. **`XFAIL` (known hub#610)** — a ghost-fd **was** observed during the wipe window. This is the shipped bug, tracked as **hub#610**, so it's XFAIL even when an operator restart later recovers — greening on it would be the false-confidence we're guarding against. Loud banner, exit 0.
3. **`FAIL` (genuine)** — the hub did **not** recover AND **no** ghost-fd explains it (startup crash, bad binary, perms). A truly-dead hub hard-fails the run with a non-zero exit — it is *not* the #610 gap and must not be excused as one.

**Live finding (rc 0.6.5-rc.4, surfaced by this stage → filed as hub#610):** the hub does **not** auto-self-heal from a wiped state-dir on Linux. The #594 self-heal is *reactive* — it only fires on a thrown SQLite error — but an unlinked-but-open fd keeps reads/writes succeeding, so the handle is never reopened and `/health` stays green on a ghost DB indefinitely. An **operator `systemctl restart` fully recovers** it with a fresh on-disk DB. So on rc, Stage 3 **XFAILs (exit 0)**: the ghost-fd is the hub#610 fingerprint, restart recovers, and the transcript logs the whole sequence loudly. A periodic on-disk liveness check (stat the db path / forced WAL checkpoint) would close hub#610.

### Result statuses

`PASS` / `FAIL` / `SKIP` as usual, plus **`XFAIL`** — a *known, tracked, reported-in-the-PR* live bug the harness deliberately surfaces (here: hub#610). An XFAIL is loud in the summary but does **not** fail the suite (so the harness stays usable as a gate while screaming the finding). A new/unexpected failure — including a genuinely-dead hub with no ghost-fd explanation — always `FAIL`s and aborts with a non-zero exit. `run.sh` exits 0 with a warning banner when only XFAILs are present, non-zero on any FAIL.

## PR 1 vs PR 2

**This PR (PR 1) is the loopback core.** No Cloudflare expose — Stage 4 is a
SKIPPED stub so the stage numbering stays stable when PR 2 lands.

**PR 2 — public expose** (blocked on test-domain creds Aaron must provide):

- **Aaron action item:** a Cloudflare **test domain** + an `origin cert.pem`
  secret (stored as a GH Actions secret, e.g. `E2E_CF_TEST_DOMAIN` +
  `E2E_CF_CERT_PEM` / `E2E_CF_API_TOKEN`). Until those exist, Stage 4 can't run.
- PR 2 will: provision a **unique-per-run hostname** under the test domain
  (so concurrent / repeated runs don't collide), run `parachute expose public
  --cloudflare`, assert the public FQDN actually serves the hub (`/health`
  through the tunnel), exercise the origin-pinned-credential self-heal
  (init-at-loopback → expose-public → `start` re-mints `iss` / vault `.env`
  hub-origin), and **tear the hostname + tunnel down** on exit (trap).
- It replaces the Stage 4 stub in place — the numbering is already reserved.

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
