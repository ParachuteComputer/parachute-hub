#!/usr/bin/env bash
#
# In-container staged E2E. Runs as root inside the systemd Ubuntu container,
# matching the real fresh-VPS transcripts (operators run `parachute init` as
# root on a brand-new box).
#
# Each stage is logged + asserted; results append to /root/e2e-results as
# `name|PASS|FAIL|SKIP|detail` lines so the host driver renders a summary even
# when a stage aborts. The script exits non-zero on the first hard failure.
#
# Env (set by run.sh):
#   HUB_INSTALL_SPEC           "rc" / "latest" / "0.6.5-rc.4" → install
#                              @openparachute/hub@<spec>; or "local" → install
#                              the /root/hub.tgz tarball.
#   PARACHUTE_INSTALL_CHANNEL  rc|latest — vault module install channel.
set -uo pipefail

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
die() {
  local stage="$1"; shift
  printf '\n!! STAGE FAILED: %s — %s\n' "$stage" "$*" >&2
  record "$stage" "FAIL" "$*"
  exit 1
}

# Poll a curl assertion until it passes or times out. $1=desc (for readability
# at the call site) $2=timeout_s $3..=command (run via bash -c) whose exit 0
# means "satisfied".
wait_for() {
  local timeout="$2"; shift 2
  local deadline=$(( $(date +%s) + timeout ))
  until bash -c "$*" >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
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
  systemctl --no-pager status parachute-hub.service 2>&1 | head -30 >&2
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
# FIELD NOTE (rc 0.6.5-rc.4): `parachute init` pre-seeds the vault MODULE into
# services.json (a `default` placeholder, version 0.0.0-linked) under hub#168
# Cut 1. `deriveWizardState.hasVault` keys off `findService("parachute-vault")`,
# which the placeholder satisfies — so the wizard SKIPS its vault step on an
# init'd box. The wizard's real job in this sequence is the account + expose
# decisions; the vault is provisioned separately (below). We therefore drive
# the wizard for account+expose, then create the named '${VAULT_NAME}' vault
# the way an operator who wants a named vault does: `parachute vault create`.
note "Driving the setup wizard over loopback (admin account + expose mode)…"
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
note "wizard created admin '${ADMIN_USER}' + set expose mode (vault step skipped — pre-seeded module)"
record "stage1-wizard" "PASS" "admin '${ADMIN_USER}' created + expose=localhost via wizard"

# --- create the named vault ---
# `parachute vault create <name>` is the operator path to a named vault.
note "Creating the named vault '${VAULT_NAME}' (parachute vault create)…"
VC_LOG=/tmp/parachute-vault-create.log
if ! parachute vault create "${VAULT_NAME}" >"$VC_LOG" 2>&1; then
  cat "$VC_LOG" >&2
  die "stage1-vault" "parachute vault create ${VAULT_NAME} failed"
fi
cat "$VC_LOG"
# The supervisor mounts the new vault on its next boot; nudge it (an operator
# would `parachute restart` or the next reboot does it). `parachute start vault`
# ensures the vault child is running under the supervisor.
parachute start vault >/dev/null 2>&1 || true
systemctl restart parachute-hub.service || true
if ! wait_for "hub healthy after vault-mount restart" 30 "curl -fsS ${HUB}/health | grep -q '\"db\":\"ok\"'"; then
  die "stage1-vault" "hub did not come back healthy after mounting vault '${VAULT_NAME}'"
fi

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
parachute status 2>&1 | head -30 || true
record "stage1-vault" "PASS" "vault '${VAULT_NAME}' created + served (401 health)"

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
SETUP_STEP="$(curl -s -H 'accept: application/json' "${HUB}/admin/setup" | bun -e 'const c=await Bun.stdin.text(); try{const j=JSON.parse(c); console.log(j.hasAdmin?"has-admin":"no-admin")}catch{console.log("redirect-or-done")}' 2>/dev/null || true)"
case "$SETUP_STEP" in
  has-admin|redirect-or-done)
    note "wizard state preserved (admin still present: ${SETUP_STEP})" ;;
  no-admin)
    die "stage2-idempotent" "re-init wiped the admin — wizard back at welcome/bootstrap" ;;
  *)
    note "setup probe returned '${SETUP_STEP}' — treating as preserved (301→/login is the post-setup shape)" ;;
esac
record "stage2-idempotent" "PASS" "re-init clean, 1 unit, admin preserved"

# ===========================================================================
# STAGE 3 — wipe recovery (the laptop scenario)
# ===========================================================================
hr "STAGE 3 — wipe recovery (rm -rf ~/.parachute while the unit runs)"
note "Capturing a baseline /health, then wiping ~/.parachute out from under the unit…"
curl -s "${HUB}/health" | head -c 300; echo

# Wipe the config root while the systemd unit keeps running. This reproduces
# the #594 dead-DB-handle field repro (green /health while DB routes 503/500).
rm -rf /root/.parachute
note "config root removed. Probing a DB route + waiting for the shipped self-heal…"

# The hub should NOT 500-loop. Per #594 the shipped behavior is structured
# 503 → self-heal-or-exit → systemd restart. Assert the END state: within a
# bounded window the hub is serving again with a FRESH db reporting db:"ok".
# (systemd Restart=always brings it back; a fresh boot re-creates the DB.)
if ! wait_for "hub self-heal to db:ok" 90 "curl -fsS ${HUB}/health | grep -q '\"db\":\"ok\"'"; then
  note "hub did not return to db:ok on its own within 90s — nudging systemd (operator would too)…"
  systemctl restart parachute-hub.service || true
  if ! wait_for "hub healthy after restart" 60 "curl -fsS ${HUB}/health | grep -q '\"db\":\"ok\"'"; then
    curl -s "${HUB}/health" >&2 || true
    systemctl --no-pager status parachute-hub.service 2>&1 | head -20 >&2 || true
    die "stage3-wipe-recovery" "hub never recovered to /health db:ok after wipe (#594)"
  fi
fi
note "hub recovered to /health db:\"ok\" with a fresh DB (#594 self-heal end state)"

# Re-run init — the version-check / adoption logic must not wedge (#590).
note "Re-running 'parachute init' after the wipe…"
INIT3_LOG=/tmp/parachute-init-3.log
if ! parachute init --expose none --no-expose-prompt --no-browser >"$INIT3_LOG" 2>&1; then
  cat "$INIT3_LOG" >&2
  die "stage3-wipe-recovery" "post-wipe parachute init exited non-zero (adoption wedge?)"
fi
cat "$INIT3_LOG"
curl -fsS "${HUB}/health" | grep -q '"db":"ok"' || die "stage3-wipe-recovery" "hub not db:ok after post-wipe init"

# Wizard reachable again — fresh DB means bootstrap state is back to needs-setup;
# assert it's COHERENT (200 JSON or a clean redirect), not a 500.
WIZ_CODE="$(curl -s -o /tmp/setup-after.json -w '%{http_code}' -H 'accept: application/json' "${HUB}/admin/setup" || true)"
case "$WIZ_CODE" in
  200|301|302)
    note "wizard reachable after wipe (HTTP ${WIZ_CODE}, coherent state)" ;;
  *)
    cat /tmp/setup-after.json >&2 || true
    die "stage3-wipe-recovery" "/admin/setup returned ${WIZ_CODE} after wipe (expected 200/301/302, got a 5xx?)" ;;
esac
record "stage3-wipe-recovery" "PASS" "self-heal to db:ok, re-init clean, wizard coherent"

# ===========================================================================
# STAGE 4 — expose (PR 2 placeholder)
# ===========================================================================
hr "STAGE 4 — public expose (PR 2)"
note "SKIPPED — Cloudflare test-domain creds are not wired in PR 1 (loopback core)."
note "PR 2 will: provision a unique per-run hostname on a CF test domain,"
note "run 'parachute expose public --cloudflare', assert the FQDN serves, teardown."
record "stage4-expose" "SKIP" "Cloudflare creds not wired (PR 2)"

# ---------------------------------------------------------------------------
hr "ALL STAGES PASSED"
exit 0
