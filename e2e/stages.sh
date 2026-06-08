#!/usr/bin/env bash
#
# In-container staged E2E. Runs as root inside the systemd Ubuntu container,
# matching the real fresh-VPS transcripts (operators run `parachute init` as
# root on a brand-new box).
#
# Each stage is logged + asserted; results append to /root/e2e-results as
# `name|PASS|FAIL|SKIP|XFAIL|detail` lines so the host driver renders a summary
# even when a stage aborts. The script exits non-zero on the first hard failure.
#
# Env (set by run.sh):
#   HUB_INSTALL_SPEC           "rc" / "latest" / "0.6.5-rc.4" → install
#                              @openparachute/hub@<spec>; or "local" → install
#                              the /root/hub.tgz tarball.
#   PARACHUTE_INSTALL_CHANNEL  rc|latest — vault module install channel.
#
# Hardening note: we run under `set -euo pipefail` so an *unguarded* command
# failure aborts the run rather than silently continuing past a broken probe
# (the false-pass class — a stage greening without really testing). Every place
# we genuinely don't care about a non-zero exit is annotated with an explicit
# `|| true` + a comment. Assertions use `if ! cmd` / `cmd || die`, both of which
# are `-e`-safe. The `cmd | other` pipelines that we assert on rely on
# `pipefail` so a failing producer doesn't get masked by a succeeding consumer.
set -euo pipefail

HUB_PORT=1939
HUB="http://127.0.0.1:${HUB_PORT}"
VAULT_NAME="e2e"
ADMIN_USER="owner"
ADMIN_PASS="e2e-passw0rd-correct-horse"
RESULTS=/root/e2e-results
: > "$RESULTS"

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
hr()   { printf '\n========== %s ==========\n' "$*"; }
note() { printf '  -> %s\n' "$*"; }
record() { printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$RESULTS"; }

# Hard-fail: record FAIL + abort the whole run (non-zero exit propagates).
# NOTE on the matrix: a `die` aborts immediately, so any LATER stage is skipped
# (its result never recorded). This is intentional — stages have real ordering
# dependencies (2/3/4 all need Stage 1's install; the wipe needs a live hub) and
# a genuine hard failure should stop loudly rather than soldier on against a
# broken box. `xfail` (known bugs) continues; only a true FAIL aborts. The
# expose stage (3) running before the destructive wipe (4) means a green Stage 3
# is the gate for Stage 4 running — which is exactly why we keep Stage 3 robust.
die() {
  local stage="$1"; shift
  printf '\n!! STAGE FAILED: %s — %s\n' "$stage" "$*" >&2
  record "$stage" "FAIL" "$*"
  exit 1
}

# Expected-fail: a KNOWN live bug the harness deliberately surfaces. Records an
# XFAIL (loud in the summary) but does NOT abort the run — so the suite stays
# usable as a gate while screaming the finding. Use ONLY for a tracked,
# reported-in-the-PR bug; a new/unexpected failure must `die`.
# Retained as a primitive for the next found-bug even when no stage currently
# XFAILs (#610 + vault#464 both flipped to hard asserts once fixed).
# shellcheck disable=SC2329  # invoked situationally when a live bug is being tracked
xfail() {
  local stage="$1"; shift
  printf '\n!! XFAIL (known live bug): %s — %s\n' "$stage" "$*" >&2
  record "$stage" "XFAIL" "$*"
}

# Poll an assertion until it passes or times out. $1=desc (logged for trace),
# $2=timeout_s, $3..=command (run via bash -c) whose exit 0 means "satisfied".
wait_for() {
  local desc="$1" timeout="$2"; shift 2
  local deadline=$(( $(date +%s) + timeout ))
  until bash -c "$*" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      note "wait_for '${desc}' timed out after ${timeout}s"
      return 1
    fi
    sleep 1
  done
  return 0
}

# ===========================================================================
# STAGE 1 — fresh install happy path
# ===========================================================================
hr "STAGE 1 — fresh install happy path"

# --- install bun ---
note "Installing bun (curl bun.sh/install)…"
export BUN_INSTALL=/root/.bun
export PATH="$BUN_INSTALL/bin:$PATH"
if ! curl -fsSL https://bun.sh/install | bash >/tmp/bun-install.log 2>&1; then
  cat /tmp/bun-install.log >&2
  die "stage1-install-bun" "bun install script failed"
fi
hash -r
command -v bun >/dev/null 2>&1 || die "stage1-install-bun" "bun not on PATH after install"
note "bun $(bun --version) installed"

# --- install @openparachute/hub ---
# Regression pin hub#568: a "Blocked N postinstall" line means bun refused to
# run a package's postinstall and the install is silently broken.
ADD_LOG=/tmp/hub-add.log
if [ "${HUB_INSTALL_SPEC}" = "local" ]; then
  note "Installing hub from local tarball /root/hub.tgz…"
  bun add -g "/root/hub.tgz" >"$ADD_LOG" 2>&1 || { cat "$ADD_LOG" >&2; die "stage1-install-hub" "bun add -g (local tarball) failed"; }
else
  note "Installing @openparachute/hub@${HUB_INSTALL_SPEC} from npm…"
  bun add -g "@openparachute/hub@${HUB_INSTALL_SPEC}" >"$ADD_LOG" 2>&1 || { cat "$ADD_LOG" >&2; die "stage1-install-hub" "bun add -g @openparachute/hub@${HUB_INSTALL_SPEC} failed"; }
fi
cat "$ADD_LOG"
# hub#568 regression assertion.
if grep -qi "Blocked .*postinstall" "$ADD_LOG"; then
  die "stage1-install-hub" "hub#568 regression: 'Blocked postinstall' in bun add output"
fi
hash -r
command -v parachute >/dev/null 2>&1 || die "stage1-install-hub" "parachute binary not on PATH after install"
HUB_VERSION="$(parachute --version 2>/dev/null | head -n1 || true)"
note "parachute installed (version line: ${HUB_VERSION:-unknown})"
record "stage1-install" "PASS" "bun + hub installed (${HUB_VERSION:-?})"

# --- parachute init (non-interactive, loopback only) ---
# --expose none           → no Cloudflare/tailnet (PR-1 is loopback core)
# --no-expose-prompt      → never block on the interactive expose question
# --no-browser            → don't try to xdg-open; print URL + exit 0
note "Running 'parachute init --expose none --no-expose-prompt --no-browser'…"
INIT_LOG=/tmp/parachute-init.log
if ! parachute init --expose none --no-expose-prompt --no-browser >"$INIT_LOG" 2>&1; then
  cat "$INIT_LOG" >&2
  die "stage1-init" "parachute init exited non-zero"
fi
cat "$INIT_LOG"

# systemd unit active?
if ! systemctl is-active --quiet parachute-hub.service; then
  systemctl --no-pager status parachute-hub.service 2>&1 | head -30 >&2 || true
  die "stage1-init" "parachute-hub.service is not active after init"
fi
note "parachute-hub.service is active (systemd-managed)"

# /health 200 with db:"ok" (#594)
if ! wait_for "hub /health db:ok" 30 "curl -fsS ${HUB}/health | grep -q '\"db\":\"ok\"'"; then
  curl -s "${HUB}/health" >&2 || true
  die "stage1-init" "hub /health never reported db:\"ok\" within 30s (#594)"
fi
note "hub /health reports db:\"ok\" (#594 field present + healthy)"

# vault module installed? (PARACHUTE_INSTALL_CHANNEL honored — init installs the
# module; the wizard provisions the instance.)
if ! grep -q "parachute-vault" "$INIT_LOG" 2>/dev/null && ! parachute status 2>/dev/null | grep -qi "vault"; then
  parachute status 2>&1 | head -20 >&2 || true
  note "WARNING: vault module not yet visible in status (wizard will provision the instance next)"
fi
record "stage1-init" "PASS" "systemd unit active, /health db:ok, channel=${PARACHUTE_INSTALL_CHANNEL}"

# --- wizard over HTTP (loopback) ---
# Loopback requests skip the bootstrap-token gate / are handed the token
# transparently (#576). `parachute setup-wizard` drives the SAME endpoints the
# browser wizard hits (Account → Vault → Expose), fully non-interactive.
#
# hub#607 + hub#608 (fixed): `parachute init` pre-seeds the vault MODULE into
# services.json (a `default` placeholder, version 0.0.0-linked) under hub#168
# Cut 1. Pre-fix, `deriveWizardState.hasVault` matched that placeholder, so the
# wizard SILENTLY SKIPPED its vault step on an init'd box — the operator
# finished setup with no vault, and the harness had to work around it with an
# explicit `parachute vault create` + a manual start/restart. With hub#607,
# `hasVault` discriminates the SEED_VERSION placeholder from a real instance,
# so the wizard PRESENTS its create/import/skip step and creates the named
# vault itself (`--vault-mode create --vault-name`). With hub#608, the create
# path drives the supervisor to START the new vault, so it is ACTIVE
# immediately — no `parachute vault create`, no manual start, no hub restart.
# This stage now asserts that fixed end-to-end behavior directly.
note "Driving the setup wizard over loopback (account → create vault '${VAULT_NAME}' → expose)…"
WIZ_LOG=/tmp/parachute-wizard.log
if ! parachute setup-wizard \
      --hub-url "${HUB}" \
      --account-username "${ADMIN_USER}" \
      --account-password "${ADMIN_PASS}" \
      --vault-mode create \
      --vault-name "${VAULT_NAME}" \
      --expose-mode localhost >"$WIZ_LOG" 2>&1; then
  cat "$WIZ_LOG" >&2
  die "stage1-wizard" "setup-wizard exited non-zero"
fi
cat "$WIZ_LOG"
grep -qi "Setup complete" "$WIZ_LOG" || die "stage1-wizard" "wizard did not report 'Setup complete'"
grep -qi "admin account created" "$WIZ_LOG" || die "stage1-wizard" "wizard did not create the admin account"
# hub#607: the wizard must actually walk its vault step (not skip it). The CLI
# wizard logs "Vault ready" once the create op succeeds; a skipped step never
# would. This guards against a regression back to the silent-skip behavior.
grep -qi "Vault ready" "$WIZ_LOG" || die "stage1-wizard" \
  "wizard did not run its vault step (hub#607 regression — vault step silently skipped on the init'd box)"
note "wizard created admin '${ADMIN_USER}' + created vault '${VAULT_NAME}' + set expose mode"
record "stage1-wizard" "PASS" "admin + vault '${VAULT_NAME}' created via wizard (hub#607); expose=localhost"

# --- vault is live immediately after the wizard (hub#608) ---
# No `parachute vault create`, no `parachute start vault`, no hub restart: the
# wizard's create path drove the supervisor to start the vault child, so it is
# already serving. Assert it WITHOUT any manual nudge.
note "Asserting vault '${VAULT_NAME}' is active right after the wizard (hub#608 — no manual start)…"
# vault running + auth-gated (401 = healthy per hub#423 semantics)
if ! wait_for "vault ${VAULT_NAME} health 401" 60 "test \"\$(curl -s -o /dev/null -w '%{http_code}' ${HUB}/vault/${VAULT_NAME}/health)\" = 401"; then
  code="$(curl -s -o /dev/null -w '%{http_code}' "${HUB}/vault/${VAULT_NAME}/health" || true)"
  note "vault health returned HTTP ${code} (expected 401)"
  # A 200 (public health) is also acceptable as "vault is up"; only a 5xx/000 is a failure.
  case "$code" in
    401|200) : ;;
    *) die "stage1-vault" "vault ${VAULT_NAME} not reachable (HTTP ${code})" ;;
  esac
fi
note "vault '${VAULT_NAME}' is up (auth-gated health, hub#423 semantics)"
# hub#608: `parachute status` must show the vault as active (the issue's
# operator-visible symptom was a freshly-created vault stuck `inactive` until a
# restart). The supervisor child is named by the short `vault`; assert the
# status table reports it active without any manual start having been issued.
STATUS_LOG=/tmp/parachute-status.log
parachute status >"$STATUS_LOG" 2>&1 || true
head -30 "$STATUS_LOG"
if ! grep -qiE 'vault.*(active|running)' "$STATUS_LOG"; then
  die "stage1-vault" \
    "parachute status does not show vault active right after the wizard (hub#608 regression — vault inactive until restart)"
fi
note "parachute status reports vault active (hub#608 — live without a manual start)"
record "stage1-vault" "PASS" "vault '${VAULT_NAME}' created by wizard + active + served (401 health); hub#607/#608"

# --- MCP handshake — full OAuth dance + round-trip ---
note "Running the full OAuth dance + MCP round-trip (mcp-probe.ts)…"
if ! bun /root/mcp-probe.ts \
      --hub "${HUB}" \
      --vault "${VAULT_NAME}" \
      --user "${ADMIN_USER}" \
      --pass "${ADMIN_PASS}"; then
  die "stage1-mcp" "MCP OAuth-dance / round-trip failed (see mcp-probe output above)"
fi
record "stage1-mcp" "PASS" "DCR→PKCE→token→MCP create+query note round-trip"

# --- mint-token path → REST API ---
# The wizard's account step wrote ~/.parachute/operator.token, so mint-token
# can issue a scoped JWT. GET the REST notes API with it → 200.
note "Minting a read-scoped token + hitting the REST API…"
MINT_TOKEN="$(parachute auth mint-token --scope "vault:${VAULT_NAME}:read" 2>/tmp/mint-err | tail -n1)"
if [ -z "$MINT_TOKEN" ]; then
  cat /tmp/mint-err >&2
  die "stage1-mint" "parachute auth mint-token produced no token"
fi
REST_CODE="$(curl -s -o /tmp/rest-notes.json -w '%{http_code}' \
  -H "Authorization: Bearer ${MINT_TOKEN}" \
  "${HUB}/vault/${VAULT_NAME}/api/notes" || true)"
if [ "$REST_CODE" != "200" ]; then
  cat /tmp/rest-notes.json >&2 || true
  die "stage1-mint" "REST GET /vault/${VAULT_NAME}/api/notes returned ${REST_CODE} (expected 200)"
fi
note "REST GET /vault/${VAULT_NAME}/api/notes → 200 with mint-token Bearer"
record "stage1-mint" "PASS" "mint-token --scope vault:${VAULT_NAME}:read → REST 200"

# ===========================================================================
# STAGE 2 — idempotent re-run
# ===========================================================================
hr "STAGE 2 — idempotent re-run"
note "Re-running 'parachute init' (same flags)…"
INIT2_LOG=/tmp/parachute-init-2.log
if ! parachute init --expose none --no-expose-prompt --no-browser >"$INIT2_LOG" 2>&1; then
  cat "$INIT2_LOG" >&2
  die "stage2-idempotent" "second parachute init exited non-zero"
fi
cat "$INIT2_LOG"

# hub still healthy
curl -fsS "${HUB}/health" | grep -q '"db":"ok"' || die "stage2-idempotent" "hub /health not db:ok after re-init"

# exactly one parachute-hub unit (no duplicates)
UNIT_COUNT="$(systemctl list-units --all --no-legend 'parachute-hub*' 2>/dev/null | grep -c 'parachute-hub' || true)"
if [ "${UNIT_COUNT}" != "1" ]; then
  systemctl list-units --all 'parachute-hub*' >&2 || true
  die "stage2-idempotent" "expected exactly 1 parachute-hub unit, found ${UNIT_COUNT}"
fi
note "exactly 1 parachute-hub unit (no duplication)"

# wizard state preserved — admin still exists → setup probe must NOT be at
# the bootstrap/welcome step (no fresh-gate). Loopback JSON probe.
#
# MUST-FIX (reviewer): never let an empty SETUP_STEP fall through to a PASS. If
# curl/bun errors (hub unreachable, bun crash) the probe returns nothing — that
# is a HARD failure, not "treat as preserved". We capture the probe WITHOUT a
# `|| true` swallow and explicitly guard the empty case before the case-match.
# `set -e` would abort on a failed pipeline here, so we tolerate the command's
# own non-zero (the producer may legitimately 301) but REQUIRE a non-empty,
# recognized token.
SETUP_STEP="$(curl -s -H 'accept: application/json' "${HUB}/admin/setup" \
  | bun -e 'const c=await Bun.stdin.text(); try{const j=JSON.parse(c); console.log(j.hasAdmin?"has-admin":"no-admin")}catch{console.log(c.length?"redirect-or-done":"")}')" || true
if [ -z "$SETUP_STEP" ]; then
  die "stage2-idempotent" "setup probe returned nothing — hub unreachable or bun failed (cannot confirm admin preserved)"
fi
case "$SETUP_STEP" in
  has-admin)
    note "wizard state preserved (admin still present)" ;;
  redirect-or-done)
    # A 301→/login (non-JSON body) is the canonical post-setup shape and also
    # implies an admin exists — accept it, but only because it's a recognized
    # token, not an empty fall-through.
    note "setup probe returned a post-setup redirect/done shape (admin implied present)" ;;
  no-admin)
    die "stage2-idempotent" "re-init wiped the admin — wizard back at welcome/bootstrap" ;;
  *)
    die "stage2-idempotent" "setup probe returned an unrecognized token '${SETUP_STEP}'" ;;
esac
record "stage2-idempotent" "PASS" "re-init clean, 1 unit, admin preserved"


# ===========================================================================
# STAGE 3 — public Cloudflare expose (the real tunnel path)
# ===========================================================================
hr "STAGE 3 — public expose (real Cloudflare tunnel)"

# GATING: the real stage runs ONLY when a cloudflared origin cert is wired in
# (CLOUDFLARED_CERT_PEM, threaded from run.sh into the container as the literal
# PEM text). Without it — the default for contributors with no test-zone creds —
# we KEEP the SKIP so the loopback-only run (stages 1, 2 + 4) stays green and
# useful. This expose stage is intentionally STAGE 3 — before the destructive
# wipe (Stage 4) — so its MCP-over-public has the live admin + vault Stage 1
# created (a post-wipe public origin correctly 503s `setup_required`).
if [ -z "${CLOUDFLARED_CERT_PEM:-}" ] || [ -z "${E2E_FQDN:-}" ]; then
  note "SKIPPED — no Cloudflare cert wired (CLOUDFLARED_CERT_PEM unset)."
  note "Set CLOUDFLARED_CERT_PEM (cert path or inline PEM) + E2E_TEST_ZONE and"
  note "re-run to exercise the real expose → public FQDN → MCP-over-public path."
  record "stage3-expose" "SKIP" "no CLOUDFLARED_CERT_PEM (loopback-only run)"
else
  # This stage spawns a real Cloudflare tunnel + writes a real DNS record under
  # the SHARED test zone. Both MUST be torn down on EVERY exit — success,
  # assertion failure, or a mid-stage crash — or the zone accumulates orphaned
  # tunnels/records across runs. The in-container teardown below is the primary
  # net; run.sh adds a defensive host-side trap for the case where the whole
  # container dies before this trap can fire.
  STAGE3_TUNNEL_NAME=""   # set once `parachute expose` derives/creates it
  # shellcheck disable=SC2329  # invoked indirectly via `trap … EXIT` below.
  stage3_teardown() {
    local tc=$?
    printf '\n========== STAGE 3 TEARDOWN (always runs) ==========\n' >&2
    # 1. Stop the connector + clear local expose state (best-effort).
    parachute expose public off --cloudflare >/tmp/stage3-off.log 2>&1 || true
    cat /tmp/stage3-off.log >&2 || true
    # 2. Delete the account-side tunnel by name so the test account doesn't
    #    accumulate defined-but-idle tunnels. `parachute expose … off` only
    #    stops the LOCAL connector (the tunnel stays "defined in Cloudflare"),
    #    so we delete it explicitly. Resolve the name we used; fall back to the
    #    derived name from the FQDN if the var wasn't set yet.
    local tname="${STAGE3_TUNNEL_NAME:-}"
    if [ -z "$tname" ]; then
      # Mirror deriveTunnelName(): lowercase, dots→hyphens, strip non [a-z0-9_-],
      # prefix parachute-. (Length-truncation is irrelevant for our short FQDNs.)
      tname="parachute-$(printf '%s' "$E2E_FQDN" | tr '[:upper:]' '[:lower:]' | tr '.' '-' | tr -cd 'a-z0-9_-')"
    fi
    if command -v cloudflared >/dev/null 2>&1; then
      if cloudflared tunnel delete -f "$tname" >/tmp/stage3-tunnel-delete.log 2>&1; then
        note "torn down tunnel '$tname'"
      else
        note "tunnel delete '$tname' (may already be gone):"
        cat /tmp/stage3-tunnel-delete.log >&2 || true
      fi
    fi
    # 3. Delete the per-run DNS record via the CF API (cloudflared has no
    #    unroute command). cf-dns-cleanup.ts authenticates with the cert's
    #    embedded `cfut_` API token via `Authorization: Bearer` (the token that
    #    CREATED the record can delete it — self-contained, no second secret),
    #    and self-verifies the record is gone from the zone (authoritative
    #    re-list) before exiting 0. A non-zero exit = a genuine leak — surfaced
    #    LOUDLY here; the host-side net in run.sh then retries.
    if [ -f /root/.cloudflared/cert.pem ]; then
      if bun /root/cf-dns-cleanup.ts --cert /root/.cloudflared/cert.pem --fqdn "$E2E_FQDN" \
          >/tmp/stage3-dns-cleanup.log 2>&1; then
        cat /tmp/stage3-dns-cleanup.log >&2 || true
      else
        printf '\n!! DNS CLEANUP FAILED — POSSIBLE ORPHAN. Host-side trap will retry.\n' >&2
        cat /tmp/stage3-dns-cleanup.log >&2 || true
      fi
    fi
    # 4. Independent post-teardown NXDOMAIN check at Cloudflare's resolver — the
    #    "zero orphans" assertion the operator asked for. Authoritative-side
    #    deletion is immediate (cf-dns-cleanup verified the zone re-list); the
    #    public resolver clears shortly after. We give it a brief window, then
    #    report. This is a diagnostic (the authoritative re-list in
    #    cf-dns-cleanup is the real gate) — but it makes a leak unmissable.
    local left
    left="$(dig +short +time=3 +tries=1 @1.1.1.1 "${E2E_FQDN}" A 2>/dev/null \
      | grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
    if [ -n "$left" ]; then
      printf '!! %s still resolves (%s) at 1.1.1.1 immediately post-teardown — edge cache may lag; the zone-side delete was verified by cf-dns-cleanup.\n' "$E2E_FQDN" "$left" >&2
    else
      note "post-teardown: ${E2E_FQDN} no longer resolves at 1.1.1.1 (no orphan)."
    fi
    printf '====================================================\n\n' >&2
    return "$tc"
  }
  # Scope the teardown to the rest of the script. EXIT fires on normal end AND
  # on `die`'s `exit 1`, so the tunnel/DNS always get cleaned even on a hard
  # assertion failure inside this stage.
  trap stage3_teardown EXIT

  # --- place the cert where cloudflared expects it (root's ~/.cloudflared) ---
  # CLOUDFLARED_CERT_PEM is path-or-inline (mirrors run.sh): if it names an
  # existing file, copy it; if it contains a -----BEGIN block, write it inline.
  note "Placing cloudflared origin cert at /root/.cloudflared/cert.pem…"
  mkdir -p /root/.cloudflared
  if [ -f "${CLOUDFLARED_CERT_PEM}" ]; then
    cp "${CLOUDFLARED_CERT_PEM}" /root/.cloudflared/cert.pem
  else
    case "${CLOUDFLARED_CERT_PEM}" in
      *-----BEGIN*) printf '%s' "${CLOUDFLARED_CERT_PEM}" > /root/.cloudflared/cert.pem ;;
      *) die "stage3-expose" "CLOUDFLARED_CERT_PEM is neither an existing file nor inline PEM (no -----BEGIN)" ;;
    esac
  fi
  chmod 600 /root/.cloudflared/cert.pem
  if ! grep -q "BEGIN" /root/.cloudflared/cert.pem; then
    die "stage3-expose" "cert.pem has no BEGIN block at /root/.cloudflared/cert.pem"
  fi

  # --- install cloudflared the documented static-binary way ---
  # Matches what `parachute expose --cloudflare` tells the operator to do on
  # Linux: grab the static binary from Cloudflare's GitHub releases (distro
  # packages are unreliable — see src/cloudflare/detect.ts). Arch-mapped.
  if ! command -v cloudflared >/dev/null 2>&1; then
    note "Installing cloudflared (static binary from GitHub releases)…"
    CF_ARCH="$(uname -m)"
    case "$CF_ARCH" in
      x86_64|amd64) CF_SUFFIX="amd64" ;;
      aarch64|arm64) CF_SUFFIX="arm64" ;;
      armv7l|armhf) CF_SUFFIX="arm" ;;
      *) die "stage3-expose" "unsupported arch for cloudflared install: ${CF_ARCH}" ;;
    esac
    if ! curl -fsSL -o /usr/local/bin/cloudflared \
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_SUFFIX}" \
        >/tmp/cloudflared-dl.log 2>&1; then
      cat /tmp/cloudflared-dl.log >&2
      die "stage3-expose" "cloudflared static-binary download failed"
    fi
    chmod +x /usr/local/bin/cloudflared
    hash -r
  fi
  command -v cloudflared >/dev/null 2>&1 || die "stage3-expose" "cloudflared not on PATH after install"
  note "cloudflared $(cloudflared --version 2>/dev/null | head -n1)"

  # --- run the REAL expose (non-interactive: --cloudflare + --domain) ---
  note "Exposing publicly: parachute expose public --cloudflare --domain ${E2E_FQDN}"
  STAGE3_TUNNEL_NAME="parachute-$(printf '%s' "$E2E_FQDN" | tr '[:upper:]' '[:lower:]' | tr '.' '-' | tr -cd 'a-z0-9_-')"
  EXPOSE_LOG=/tmp/parachute-expose.log
  if ! parachute expose public --cloudflare --domain "${E2E_FQDN}" >"$EXPOSE_LOG" 2>&1; then
    cat "$EXPOSE_LOG" >&2
    die "stage3-expose" "parachute expose public --cloudflare exited non-zero (connector never connected? 1033?)"
  fi
  cat "$EXPOSE_LOG"
  # The expose itself asserts connector-connection before printing success
  # (#593). Belt-and-suspenders: require the success line.
  grep -qi "Cloudflare tunnel up" "$EXPOSE_LOG" || die "stage3-expose" "expose did not report 'Cloudflare tunnel up'"
  grep -qi "Connector connected" "$EXPOSE_LOG" || note "WARNING: '✓ Connector connected.' line absent — older expose? proceeding to live probe."
  PUBLIC="https://${E2E_FQDN}"

  # --- assert the PUBLIC URL actually serves the hub through the tunnel ---
  # Two PHASES, deliberately separated so a slow-to-propagate DNS record (the
  # common, benign case) isn't conflated with a down connector (the #593 /
  # error-1033 bug). The prior single-curl-loop FALSE-FAILED: the container's
  # stub resolver had negatively-cached the pre-creation NXDOMAIN, so `curl`
  # got "Could not resolve host" for the whole window even though the connector
  # was confirmed up — and the FAIL message blamed 1033, hiding that.
  #
  # PHASE A — DNS resolution. Query Cloudflare's resolver DIRECTLY
  # (`dig @1.1.1.1`), which dodges the container's stub-resolver negative-cache
  # entirely (we never ask the cached resolver). Bounded long (180s): a proxied
  # record is usually fast, but a fresh record + negative-cache needs margin.
  note "Phase A — waiting for ${E2E_FQDN} to resolve (dig @1.1.1.1, bounded 180s)…"
  RESOLVED_IP=""
  dns_deadline=$(( $(date +%s) + 180 ))
  while [ "$(date +%s)" -lt "$dns_deadline" ]; do
    # +short prints just the answer addresses (CNAME chain resolved to A/AAAA).
    # Grab the first IPv4 the chain lands on. Query 1.1.1.1 explicitly so we
    # never consult the container's cached stub resolver.
    RESOLVED_IP="$(dig +short +time=3 +tries=1 @1.1.1.1 "${E2E_FQDN}" A 2>/dev/null \
      | grep -Eo '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
    [ -n "$RESOLVED_IP" ] && break
    sleep 3
  done
  if [ -z "$RESOLVED_IP" ]; then
    note "DNS NEVER RESOLVED for ${E2E_FQDN} within 180s (querying 1.1.1.1 directly)."
    note "  This is a DNS-propagation / zone issue, NOT a connector failure:"
    dig @1.1.1.1 "${E2E_FQDN}" 2>&1 | sed -n '1,25p' >&2 || true
    note "  Connector status for context (count below; >0 means the tunnel side is fine):"
    cloudflared tunnel info "${STAGE3_TUNNEL_NAME}" >&2 2>&1 || true
    die "stage3-expose" "FAILURE MODE = DNS-never-resolves: ${E2E_FQDN} did not resolve at 1.1.1.1 within 180s (propagation/zone), connector side may be fine"
  fi
  note "✓ ${E2E_FQDN} resolves to ${RESOLVED_IP} (Cloudflare edge)."

  # PHASE B — health through the edge. Pin curl to the resolved IP with
  # `--resolve` so it does NOT re-consult the container's (still possibly
  # stale-negative) stub resolver — we already know the address. Poll for 200
  # db:ok, bounded.
  note "Phase B — probing https://${E2E_FQDN}/health via edge ${RESOLVED_IP} (bounded 60s)…"
  if ! wait_for "public /health db:ok" 60 \
      "curl -fsS --max-time 8 --resolve ${E2E_FQDN}:443:${RESOLVED_IP} ${PUBLIC}/health | grep -q '\"db\":\"ok\"'"; then
    # Distinguish resolves-but-1033 (connector down) from resolves-and-up-but-5xx
    # (real product bug) using the connector count + the actual HTTP response.
    note "Phase B failed — classifying (DNS resolved, so it's connector-1033 OR a product 5xx)…"
    CONN_COUNT="$(cloudflared tunnel info --output json "${STAGE3_TUNNEL_NAME}" 2>/dev/null \
      | bun -e 'try{const j=JSON.parse(await Bun.stdin.text());console.log((j.conns??j.connections??[]).length||0)}catch{console.log(0)}' 2>/dev/null || echo 0)"
    HTTP_BODY="$(curl -sS -i --max-time 8 --resolve "${E2E_FQDN}:443:${RESOLVED_IP}" "${PUBLIC}/health" 2>&1 | head -30 || true)"
    printf '%s\n' "$HTTP_BODY" >&2
    cloudflared tunnel info "${STAGE3_TUNNEL_NAME}" >&2 2>&1 || true
    if printf '%s' "$HTTP_BODY" | grep -q "1033" || [ "${CONN_COUNT:-0}" -eq 0 ]; then
      die "stage3-expose" "FAILURE MODE = resolves-but-1033: ${E2E_FQDN} resolves (${RESOLVED_IP}) but no live connector (count=${CONN_COUNT}) — error 1033 (this is the #593 connector-down path)"
    fi
    die "stage3-expose" "FAILURE MODE = resolves-and-connector-up-but-unhealthy: ${E2E_FQDN} resolves + ${CONN_COUNT} connector(s) live, but /health is not 200 db:ok — a REAL product bug (see body above)"
  fi
  note "✓ https://${E2E_FQDN}/health serves db:ok through the real Cloudflare tunnel."
  record "stage3-public-health" "PASS" "${E2E_FQDN}/health 200 db:ok via tunnel (DNS+edge verified)"

  # Resolver-cache bypass for the MCP phase. mcp-probe.ts resolves via Bun's
  # `fetch()`, which goes through the container's STUB resolver — the same one
  # that negatively-cached the pre-creation NXDOMAIN. Phase A proved the record
  # is live at Cloudflare's resolver, so point the container straight at 1.1.1.1
  # for the rest of the stage; fetch() then resolves fresh (no stale negative).
  # Best-effort: if resolv.conf is read-only (rare), the curl --resolve health
  # probe already passed, and worst case the MCP probe retries against a now-
  # warm cache. We append rather than clobber so existing entries still work.
  if [ -w /etc/resolv.conf ]; then
    note "Pointing the container resolver at 1.1.1.1 (bypass the stub negative-cache for fetch())…"
    printf 'nameserver 1.1.1.1\nnameserver 1.0.0.1\n' > /etc/resolv.conf 2>/dev/null || true
  fi

  # --- MCP-over-public: full OAuth dance + round-trip against the PUBLIC origin ---
  # Reuses the same probe as Stage 1 but points it at the public https origin,
  # proving DCR→PKCE→token→MCP create+query works end-to-end THROUGH Cloudflare
  # (the connector/OAuth path that 403'd in some field cases).
  #
  # vault#464 (FIXED in vault 0.5.3-rc.3): vault now fetches the hub's JWKS from
  # the LOCAL hub (loopback) by default instead of via the public FQDN, so the
  # MCP-over-public JWT verification no longer hairpins through the tunnel. This
  # is therefore a HARD assertion: the full DCR→PKCE→token→MCP round-trip over
  # the public Cloudflare origin must succeed. A `hub JWT verification failed:
  # request timed out` here would be a vault#464 REGRESSION (the loopback-JWKS
  # fix stopped working) → a real FAIL, not an expected XFAIL.
  note "Running the full OAuth dance + MCP round-trip over the PUBLIC origin…"
  MCP_PUB_LOG=/tmp/stage3-mcp-public.log
  if bun /root/mcp-probe.ts \
        --hub "${PUBLIC}" \
        --vault "${VAULT_NAME}" \
        --user "${ADMIN_USER}" \
        --pass "${ADMIN_PASS}" >"$MCP_PUB_LOG" 2>&1; then
    cat "$MCP_PUB_LOG"
    note "✓ MCP round-trip succeeded over the public tunnel."
    record "stage3-mcp-public" "PASS" "DCR→PKCE→token→MCP over https://${E2E_FQDN}"
  else
    cat "$MCP_PUB_LOG"
    # A JWKS-fetch timeout here means the vault#464 loopback-JWKS fix regressed;
    # any other failure is also real. Either way → hard FAIL.
    if grep -qiE "hub JWT verification failed: request timed out|jwks.*time(d)? ?out|verification failed.*time(d)? ?out|fetch.*jwks.*time(d)? ?out" "$MCP_PUB_LOG"; then
      die "stage3-mcp-public" "MCP-over-public failed with a JWKS-fetch timeout — vault#464 REGRESSION: vault is hairpinning JWKS through the public tunnel again instead of fetching from loopback (see mcp-probe output above)"
    else
      die "stage3-mcp-public" "MCP OAuth-dance / round-trip over the public Cloudflare origin FAILED (see mcp-probe output above)"
    fi
  fi

  # --- origin-pinned-credential self-heal (#503/#481 class) — bonus asserts ---
  # After a public expose, the expose path persists the public origin into
  # vault's `.env` (PARACHUTE_HUB_ORIGIN) so vault's OAuth `iss` check matches
  # the public host. Assert it reflects the public origin (not loopback).
  VAULT_ENV=/root/.parachute/vault/.env
  if [ -f "$VAULT_ENV" ]; then
    if grep -q "PARACHUTE_HUB_ORIGIN=${PUBLIC}" "$VAULT_ENV"; then
      note "✓ vault .env PARACHUTE_HUB_ORIGIN self-healed to ${PUBLIC} (#481)."
      # Restart vault and confirm it still serves (self-heal-on-start path).
      systemctl restart parachute-hub.service || true
      if wait_for "vault still serves after restart" 60 "test \"\$(curl -s -o /dev/null -w '%{http_code}' ${HUB}/vault/${VAULT_NAME}/health)\" = 401 -o \"\$(curl -s -o /dev/null -w '%{http_code}' ${HUB}/vault/${VAULT_NAME}/health)\" = 200"; then
        note "✓ vault still serves after restart with the public origin pinned."
        record "stage3-selfheal" "PASS" "vault .env=public origin, survives restart (#481/#503)"
      else
        note "WARNING: vault did not re-serve cleanly after restart (bonus assert)."
        record "stage3-selfheal" "PASS" "vault .env=public origin (restart re-serve unverified — bonus)"
      fi
    else
      note "NOTE: vault .env present but PARACHUTE_HUB_ORIGIN != ${PUBLIC} (bonus self-heal assert):"
      grep "PARACHUTE_HUB_ORIGIN" "$VAULT_ENV" >&2 || note "  (no PARACHUTE_HUB_ORIGIN line)"
      record "stage3-selfheal" "PASS" "expose+MCP green; .env origin assert soft (bonus)"
    fi
  else
    note "NOTE: vault .env absent (${VAULT_ENV}) — skipping bonus self-heal assert."
    record "stage3-selfheal" "PASS" "expose+MCP green; .env not present (bonus skipped)"
  fi

  # --- teardown the expose + assert the origin is CLEARED (#503) ---
  # The teardown trap runs the tunnel/DNS delete on EXIT regardless; here we
  # also exercise the `off` path explicitly so we can assert vault's `.env`
  # origin is cleared (the inverse of the self-heal — #503).
  note "Tearing the expose down (parachute expose public off --cloudflare)…"
  parachute expose public off --cloudflare >/tmp/stage3-off-explicit.log 2>&1 || true
  cat /tmp/stage3-off-explicit.log
  if [ -f "$VAULT_ENV" ] && grep -q "PARACHUTE_HUB_ORIGIN=${PUBLIC}" "$VAULT_ENV"; then
    note "NOTE: vault .env still carries the public origin after off (#503 — soft assert, bonus)."
  else
    note "✓ vault .env public origin cleared after expose off (#503)."
  fi
  # Headline result for the stage. public-health + MCP-over-public are both hard
  # PASSes by the time we reach here (each die's on its own failure above).
  record "stage3-expose" "PASS" "real CF tunnel: public /health + MCP-over-public + teardown"
fi

# ===========================================================================
# STAGE 4 — wipe recovery (the laptop scenario)
# ===========================================================================
hr "STAGE 4 — wipe recovery (rm -rf ~/.parachute while the unit runs)"

# ORDERING: this destructive stage runs LAST on purpose. Its `rm -rf
# ~/.parachute` destroys the admin + vault Stage 1 created — which the
# public-expose stage (Stage 3) needs for its MCP-over-public round-trip (a
# wiped box correctly returns `setup_required`, which would fail that probe).
# Stage 3's expose was already torn down (tunnel/DNS deleted) before we get
# here; the EXIT trap fires once more at script end as the final safety net.
#
# MUST-FIX (reviewer): the prior version just `wait_for db:ok` after the wipe —
# which GREENS precisely when #594 is present, because a hub serving from a
# STALE in-memory handle reports db:"ok" immediately. It can't tell "died +
# restarted with a fresh DB" from "never crashed, lying about a dead handle".
# We now PROVE a real recovery:
#   (a) capture the unit MainPID before the wipe; recovery must change it
#       (a fresh process == a fresh DB handle), AND
#   (b) the on-disk hub.db must exist again after recovery, AND
#   (c) a fresh CLI process (mint-token, which opens the DB by PATH) must work
#       — the ghost-fd handle is invisible to a process that opens by path.
#
# #610 FIXED (this PR): the hub now SELF-RECOVERS without an operator nudge. A
# bounded proactive DB-liveness watchdog (`startDbPathLivenessTimer` → the
# DbHolder's `probePath`) stat()s the configured db path on a low-frequency
# timer and compares its inode to the open handle's. When `rm -rf ~/.parachute`
# unlinks the DB under the running unit, the path stat returns ENOENT (or a
# different inode) — the genuine wipe signal the REACTIVE path (#594) can't see
# (the ghost inode keeps SELECT 1 succeeding, nothing throws). The watchdog then
# triggers the same reopen-or-exit machinery; the path is gone so reopen's verify
# fails → exit(1) → systemd restarts the unit with a fresh on-disk handle, in
# seconds. So Stage 4 now asserts AUTOMATIC self-recovery (MainPID changed +
# on-disk hub.db + /health db:ok) WITHIN the wait window, with NO `systemctl
# restart` nudge. If the hub does NOT self-recover, that's a #610 REGRESSION —
# a hard FAIL, not an XFAIL. The ghost-fd readlink machinery is kept purely as a
# diagnostic: a transiently-observed ghost fd that the watchdog then heals is
# expected (the timer fires a beat after the unlink); only a hub that STAYS on
# the ghost inode past the window (never self-recovers) fails.

note "Capturing baseline: unit MainPID + /health…"
PID_BEFORE="$(systemctl show -p MainPID --value parachute-hub.service)"
note "MainPID before wipe: ${PID_BEFORE}"
# `head -c` closes the pipe early (SIGPIPE → curl non-zero); guard so it doesn't
# trip `set -e`/`pipefail`. This is a diagnostic print, not an assertion.
{ curl -fsS "${HUB}/health" | head -c 300; echo; } || true

# Wipe the config root while the systemd unit keeps running.
rm -rf /root/.parachute
note "config root removed (hub.db unlinked under the running unit)."

# Sanity: the on-disk hub.db is actually gone right now. (If this is already
# back, the rm didn't take — abort rather than test a no-op.)
if [ -f /root/.parachute/hub.db ]; then
  die "stage4-wipe-recovery" "hub.db still on disk immediately after rm -rf — wipe was a no-op"
fi
note "confirmed: hub.db is gone from disk. Watching for a REAL recovery (PID change + fresh on-disk DB)…"

# Watch for the AUTOMATIC self-recovery the #610 proactive watchdog now drives:
# MainPID changed AND hub.db is back on disk — no operator nudge. We still poke a
# DB-touching route each tick (harmless; also gives the reactive path a chance on
# the off chance a write throws first) and observe the ghost-fd window purely as a
# diagnostic. The proactive timer self-heals (exit → systemd restart) within its
# cadence, so the on-disk DB + a fresh PID appear here on their own.
# Helper: count deleted hub.db fds held open by the still-running hub PID. This
# is the #610 fingerprint — an unlinked-but-open SQLite fd the REACTIVE self-heal
# can't see (it only fires on a THROWN error; SELECT 1 keeps succeeding against
# the ghost inode). The PROACTIVE watchdog is what clears it. A transient sighting
# (before the timer fires) is expected; it's only a problem if it never heals.
# readlink (not `ls | grep`) because we need the symlink TARGET, which carries the
# " (deleted)" marker.
count_ghost_fds() {
  local pid="$1" n=0 fd target
  for fd in "/proc/${pid}/fd/"*; do
    [ -e "$fd" ] || [ -L "$fd" ] || continue
    target="$(readlink "$fd" 2>/dev/null || true)"
    case "$target" in
      *hub.db*"(deleted)") n=$(( n + 1 )) ;;
    esac
  done
  printf '%s' "$n"
}

# Diagnostic only (post-#610): did we transiently observe the ghost-fd before the
# proactive watchdog healed it? A brief sighting (the timer fires a beat after the
# unlink) is EXPECTED and benign now — it no longer drives the result. What drives
# the result is whether the hub SELF-RECOVERS (it must).
GHOST_SEEN=0

# #610 now self-recovers WITHOUT an operator nudge. Give the bounded proactive
# watchdog (default 15s cadence) a couple of cycles to detect the wiped path,
# exit, and let systemd restart with a fresh on-disk handle. 90s is comfortably
# several timer cycles + the systemd restart.
recovered=0
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  # DB-touching probe (ignored result). Harmless; the proactive timer is what
  # drives recovery now, but a provoked write can't hurt.
  curl -s -o /dev/null -H 'accept: application/json' "${HUB}/admin/setup" || true
  # Observe the (transient) ghost-fd while the original PID is still alive.
  if [ "$(systemctl show -p MainPID --value parachute-hub.service)" = "$PID_BEFORE" ]; then
    [ "$(count_ghost_fds "$PID_BEFORE")" -gt 0 ] && GHOST_SEEN=1
  fi
  PID_NOW="$(systemctl show -p MainPID --value parachute-hub.service)"
  if [ "$PID_NOW" != "$PID_BEFORE" ] && [ -f /root/.parachute/hub.db ]; then
    note "SELF-RECOVERY (no nudge): MainPID ${PID_BEFORE} -> ${PID_NOW}, hub.db back on disk."
    recovered=1
    break
  fi
  sleep 2
done

# Snapshot the ghost-fd count one more time (for the report).
GHOST_FD=0
if [ "$(systemctl show -p MainPID --value parachute-hub.service)" = "$PID_BEFORE" ]; then
  GHOST_FD="$(count_ghost_fds "$PID_BEFORE")"
  [ "$GHOST_FD" -gt 0 ] && GHOST_SEEN=1
fi

# NOTE: the operator-`systemctl restart` nudge is intentionally GONE. #610's fix
# means the hub must recover on its OWN. If `recovered` is still 0 here, that is a
# #610 REGRESSION (the proactive watchdog didn't fire / didn't exit) — a hard FAIL
# below, not a soft "operator can always restart" XFAIL.

# --- the discriminating assertion ---
# Recovery is REAL iff hub.db is on disk AND a fresh process serves it (a fresh
# CLI opens by path, never sees a ghost fd).
HEALTH_DB="$(curl -fsS "${HUB}/health" | grep -o '"db":"[^"]*"' || true)"
# `if` (not `&&`) so a missing file doesn't make the line's exit nonzero under -e.
if [ -f /root/.parachute/hub.db ]; then ONDISK_DB="present"; else ONDISK_DB="absent"; fi

# Post-#610 classification (this PR flipped XFAIL → PASS):
#   1. SELF-RECOVERED (no nudge) AND on-disk hub.db present AND /health db:ok →
#      PASS. This is the #610 fix working: the proactive watchdog detected the
#      wiped path, exited, and systemd restarted with a fresh handle on its own.
#      A transiently-seen ghost-fd is fine — the watchdog healed it (we note it
#      for the record but it no longer downgrades the result).
#   2. NOT self-recovered (recovered==0) → #610 REGRESSION. The proactive
#      watchdog didn't fire / didn't exit, or systemd didn't restart. HARD FAIL
#      (non-zero). We dump the still-open ghost-fd(s) + unit status as evidence.
#      (No operator-`systemctl restart` rescue — the whole point of #610 is that
#      recovery is automatic; rescuing here would re-hide a regression.)
if [ "$recovered" -eq 1 ] && [ "$ONDISK_DB" = "present" ] && \
   printf '%s' "${HEALTH_DB}" | grep -q '"db":"ok"'; then
  if [ "$GHOST_SEEN" -eq 1 ]; then
    note "self-recovery confirmed; a transient ghost-fd was observed before the proactive watchdog healed it (expected — the timer fires a beat after the unlink). ${GHOST_FD:-0} deleted hub.db fd(s) at last snapshot."
  fi
  note "clean SELF-recovery with a fresh on-disk DB (${HEALTH_DB}); no operator nudge needed. Proceeding to re-init."
  # Re-run init — version-check / adoption must not wedge (#590 / #609).
  note "Re-running 'parachute init' after the wipe…"
  INIT3_LOG=/tmp/parachute-init-3.log
  if ! parachute init --expose none --no-expose-prompt --no-browser >"$INIT3_LOG" 2>&1; then
    cat "$INIT3_LOG" >&2
    die "stage4-wipe-recovery" "post-wipe parachute init exited non-zero (adoption wedge?)"
  fi
  cat "$INIT3_LOG"
  # #609: the re-init's vault install must reclaim the canonical port (adopt-kill
  # the surviving vault child), NOT port-walk to a non-canonical fallback. A
  # "canonical port 1940 is in use; assigned 19XX" line here would mean #609
  # regressed. (Soft check — the surviving child may already have been reaped by
  # the supervisor restart in step 1; either way the canonical port must win.)
  if grep -qE 'canonical port 1940 is in use; assigned' "$INIT3_LOG"; then
    cat "$INIT3_LOG" >&2
    die "stage4-wipe-recovery" "#609 regression: post-wipe re-init port-walked vault off the canonical 1940 instead of adopt-killing the surviving child"
  fi
  curl -fsS "${HUB}/health" | grep -q '"db":"ok"' || die "stage4-wipe-recovery" "hub not db:ok after post-wipe init"

  # Wizard reachable again + COHERENT (200 JSON or clean redirect), not a 5xx.
  WIZ_CODE="$(curl -s -o /tmp/setup-after.json -w '%{http_code}' -H 'accept: application/json' "${HUB}/admin/setup")" || true
  case "$WIZ_CODE" in
    200|301|302) note "wizard reachable after wipe (HTTP ${WIZ_CODE}, coherent)" ;;
    *) cat /tmp/setup-after.json >&2 || true
       die "stage4-wipe-recovery" "/admin/setup returned ${WIZ_CODE} after wipe (5xx?)" ;;
  esac
  record "stage4-wipe-recovery" "PASS" "automatic self-recovery (#610): PID changed w/o nudge, fresh on-disk DB, db:ok; re-init reclaimed canonical port (#609)"
else
  # The hub did NOT self-recover within the window → #610 regression. On a build
  # with the fix this should not happen; the proactive watchdog detects the wiped
  # path and exits within a couple of timer cycles. Dump the ghost-fd evidence +
  # unit status and FAIL hard (non-zero).
  printf '\n!! Stage 4: hub did NOT self-recover after the wipe — #610 REGRESSION.\n' >&2
  printf '   The proactive DB-liveness watchdog should have detected the unlinked\n' >&2
  printf '   path and exit(1)'"'"'d so systemd restarts with a fresh on-disk handle.\n' >&2
  printf '   MainPID before=%s now=%s ; /health db=%s ; on-disk hub.db=%s ; ghost-fd seen=%s (count=%s)\n' \
    "$PID_BEFORE" "$(systemctl show -p MainPID --value parachute-hub.service)" \
    "${HEALTH_DB:-?}" "$ONDISK_DB" "$GHOST_SEEN" "${GHOST_FD:-?}" >&2
  # Dump the offending ghost fd targets for the transcript (readlink, not ls|grep).
  if [ "$(systemctl show -p MainPID --value parachute-hub.service)" = "$PID_BEFORE" ]; then
    for fd in "/proc/${PID_BEFORE}/fd/"*; do
      target="$(readlink "$fd" 2>/dev/null || true)"
      case "$target" in *hub.db*) printf '  fd %s -> %s\n' "$(basename "$fd")" "$target" >&2 ;; esac
    done
  fi
  systemctl --no-pager status parachute-hub.service 2>&1 | head -25 >&2 || true
  curl -s "${HUB}/health" >&2 || true; echo >&2
  die "stage4-wipe-recovery" "#610 regression: hub did not self-recover after wipe (health=${HEALTH_DB:-?}, on-disk DB ${ONDISK_DB}, ghost-fd seen=${GHOST_SEEN})"
fi

# ---------------------------------------------------------------------------
hr "ALL STAGES PASSED"
exit 0
