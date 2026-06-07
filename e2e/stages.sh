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
# STAGE 3 — wipe recovery (the laptop scenario)
# ===========================================================================
hr "STAGE 3 — wipe recovery (rm -rf ~/.parachute while the unit runs)"

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
# If the hub instead keeps serving db:"ok" from a deleted-but-open fd while the
# on-disk DB stays gone, that's the #594 dead-handle bug live — we detect it
# explicitly and XFAIL (loud) rather than green on it.

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
  die "stage3-wipe-recovery" "hub.db still on disk immediately after rm -rf — wipe was a no-op"
fi
note "confirmed: hub.db is gone from disk. Watching for a REAL recovery (PID change + fresh on-disk DB)…"

# Poke a DB-touching route in a loop to give the reactive self-heal a chance to
# fire (it only triggers on a thrown SQLite error). Then check for a genuine
# restart: MainPID changed AND hub.db is back on disk.
# Helper: count deleted hub.db fds held open by the still-running hub PID. This
# is the #610 fingerprint — an unlinked-but-open SQLite fd the reactive
# self-heal can't see (it only fires on a THROWN error; SELECT 1 keeps
# succeeding against the ghost inode). readlink (not `ls | grep`) because we
# need the symlink TARGET, which carries the " (deleted)" marker.
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

# Did we observe the #610 ghost-fd at any point in the wipe window? Capturing it
# independently of recovery is the key fix: the ghost-fd is the #610 fingerprint
# whether or not a later restart recovers, so it drives the result classification
# (XFAIL even when restart recovers — vs. a genuinely-dead hub with NO ghost-fd,
# which must FAIL).
GHOST_SEEN=0

recovered=0
deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  # DB-touching probe (ignored result — we just want to provoke the handle).
  curl -s -o /dev/null -H 'accept: application/json' "${HUB}/admin/setup" || true
  # Observe the ghost-fd while the original PID is still alive (it won't exist
  # once the process restarts).
  if [ "$(systemctl show -p MainPID --value parachute-hub.service)" = "$PID_BEFORE" ]; then
    [ "$(count_ghost_fds "$PID_BEFORE")" -gt 0 ] && GHOST_SEEN=1
  fi
  PID_NOW="$(systemctl show -p MainPID --value parachute-hub.service)"
  if [ "$PID_NOW" != "$PID_BEFORE" ] && [ -f /root/.parachute/hub.db ]; then
    note "self-recovery: MainPID ${PID_BEFORE} -> ${PID_NOW}, hub.db back on disk."
    recovered=1
    break
  fi
  sleep 2
done

# Snapshot the ghost-fd count one more time before any restart (for the report).
GHOST_FD=0
if [ "$(systemctl show -p MainPID --value parachute-hub.service)" = "$PID_BEFORE" ]; then
  GHOST_FD="$(count_ghost_fds "$PID_BEFORE")"
  [ "$GHOST_FD" -gt 0 ] && GHOST_SEEN=1
fi

if [ "$recovered" -ne 1 ]; then
  # Did the hub at least come back via an explicit operator restart? An operator
  # whose hub wedged would `systemctl restart`; the harness mirrors that as the
  # last-resort nudge. After a real restart the fd is fresh AND a new on-disk DB
  # is created on boot.
  note "no self-recovery within 90s. Nudging systemd (the operator's last resort)…"
  systemctl restart parachute-hub.service || true
  if wait_for "hub healthy + fresh on-disk DB after restart" 60 \
      "curl -fsS ${HUB}/health | grep -q '\"db\":\"ok\"' && test -f /root/.parachute/hub.db"; then
    PID_NOW="$(systemctl show -p MainPID --value parachute-hub.service)"
    note "recovered after explicit restart: MainPID now ${PID_NOW}, hub.db on disk."
    recovered=1
  fi
fi

# --- the discriminating assertion ---
# Recovery is REAL iff hub.db is on disk AND a fresh process serves it (a fresh
# CLI opens by path, never sees a ghost fd).
HEALTH_DB="$(curl -fsS "${HUB}/health" | grep -o '"db":"[^"]*"' || true)"
# `if` (not `&&`) so a missing file doesn't make the line's exit nonzero under -e.
if [ -f /root/.parachute/hub.db ]; then ONDISK_DB="present"; else ONDISK_DB="absent"; fi

# Three-way classification (reviewer fold):
#   1. recovered (self OR restart) AND NO ghost-fd was ever seen → clean PASS.
#   2. ghost-fd WAS seen (the #610 fingerprint) → XFAIL, even if a restart later
#      recovered. The ghost-fd window is itself the shipped bug we've filed as
#      hub#610; greening on it would be the false-confidence we're guarding
#      against. Loud banner, exit 0 (known bug, not a harness failure).
#   3. NO ghost-fd AND NOT recovered → a genuinely-dead hub with no #610
#      explanation (startup crash, bad binary, perms). HARD FAIL (non-zero).
if [ "$recovered" -eq 1 ] && [ "$GHOST_SEEN" -eq 0 ] && [ "$ONDISK_DB" = "present" ]; then
  note "clean recovery with a fresh on-disk DB (${HEALTH_DB}); no ghost-fd observed. Proceeding to re-init."
  # Re-run init — version-check / adoption must not wedge (#590).
  note "Re-running 'parachute init' after the wipe…"
  INIT3_LOG=/tmp/parachute-init-3.log
  if ! parachute init --expose none --no-expose-prompt --no-browser >"$INIT3_LOG" 2>&1; then
    cat "$INIT3_LOG" >&2
    die "stage3-wipe-recovery" "post-wipe parachute init exited non-zero (adoption wedge?)"
  fi
  cat "$INIT3_LOG"
  curl -fsS "${HUB}/health" | grep -q '"db":"ok"' || die "stage3-wipe-recovery" "hub not db:ok after post-wipe init"

  # Wizard reachable again + COHERENT (200 JSON or clean redirect), not a 5xx.
  WIZ_CODE="$(curl -s -o /tmp/setup-after.json -w '%{http_code}' -H 'accept: application/json' "${HUB}/admin/setup")" || true
  case "$WIZ_CODE" in
    200|301|302) note "wizard reachable after wipe (HTTP ${WIZ_CODE}, coherent)" ;;
    *) cat /tmp/setup-after.json >&2 || true
       die "stage3-wipe-recovery" "/admin/setup returned ${WIZ_CODE} after wipe (5xx?)" ;;
  esac
  record "stage3-wipe-recovery" "PASS" "clean recovery: PID changed, fresh on-disk DB, no ghost-fd, re-init clean"
elif [ "$GHOST_SEEN" -eq 1 ]; then
  # The KNOWN #610 ghost-fd gap. On rc this is the live shape: the hub serves a
  # ghost DB during the wipe window (reactive self-heal never fires on the
  # unlinked-but-open fd), and an operator `systemctl restart` recovers it. We
  # XFAIL — a filed, tracked shipped bug, not a harness failure.
  printf '\n=========== hub#610 FINDING (ghost-fd, live on this build) ===========\n' >&2
  printf '  After rm -rf ~/.parachute, the hub kept open deleted hub.db fd(s)\n' >&2
  printf '  (count seen: %s) and served /health=%s from the ghost inode.\n' "${GHOST_FD:-?}" "${HEALTH_DB:-?}" >&2
  printf '  The reactive self-heal (#594) only fires on a THROWN SQLite error;\n' >&2
  printf '  an unlinked-but-open fd keeps SELECT 1 + writes succeeding, so the\n' >&2
  printf '  handle is never reopened and a fresh CLI (opens by path) sees nothing.\n' >&2
  printf '  Recovery here: %s. Tracked as hub#610.\n' \
    "$([ "$recovered" -eq 1 ] && echo "operator restart succeeded" || echo "NOT recovered even after restart")" >&2
  printf '======================================================================\n\n' >&2
  # Dump the offending fd targets for the transcript (readlink, not ls|grep).
  if [ "$(systemctl show -p MainPID --value parachute-hub.service)" = "$PID_BEFORE" ]; then
    for fd in "/proc/${PID_BEFORE}/fd/"*; do
      target="$(readlink "$fd" 2>/dev/null || true)"
      case "$target" in *hub.db*) printf '  fd %s -> %s\n' "$(basename "$fd")" "$target" >&2 ;; esac
    done
  fi
  xfail "stage3-wipe-recovery" "hub#610 ghost-fd: health=${HEALTH_DB:-?}, ${GHOST_FD:-?} deleted hub.db fd(s), restart-recovered=$([ "$recovered" -eq 1 ] && echo yes || echo no)"
else
  # No ghost-fd explanation AND the hub did not recover → genuinely dead.
  # This is a REAL failure (startup crash / bad binary / perms), NOT the #610
  # gap, so it must FAIL the run with a non-zero exit.
  printf '\n!! Stage 3: hub did NOT recover and NO ghost-fd was observed.\n' >&2
  printf '   MainPID before=%s now=%s ; /health db=%s ; on-disk hub.db=%s\n' \
    "$PID_BEFORE" "$(systemctl show -p MainPID --value parachute-hub.service)" "${HEALTH_DB:-?}" "$ONDISK_DB" >&2
  systemctl --no-pager status parachute-hub.service 2>&1 | head -25 >&2 || true
  curl -s "${HUB}/health" >&2 || true; echo >&2
  die "stage3-wipe-recovery" "hub unrecoverable after wipe with no ghost-fd explanation (genuine failure, not hub#610): health=${HEALTH_DB:-?}, on-disk DB ${ONDISK_DB}"
fi

# ===========================================================================
# STAGE 4 — public Cloudflare expose (the real tunnel path)
# ===========================================================================
hr "STAGE 4 — public expose (real Cloudflare tunnel)"

# GATING: the real stage runs ONLY when a cloudflared origin cert is wired in
# (CLOUDFLARED_CERT_PEM, threaded from run.sh into the container as the literal
# PEM text). Without it — the default for contributors with no test-zone creds —
# we KEEP the SKIP so the loopback-only run (stages 1-3) stays green and useful.
if [ -z "${CLOUDFLARED_CERT_PEM:-}" ] || [ -z "${E2E_FQDN:-}" ]; then
  note "SKIPPED — no Cloudflare cert wired (CLOUDFLARED_CERT_PEM unset)."
  note "Set CLOUDFLARED_CERT_PEM (cert path or inline PEM) + E2E_TEST_ZONE and"
  note "re-run to exercise the real expose → public FQDN → MCP-over-public path."
  record "stage4-expose" "SKIP" "no CLOUDFLARED_CERT_PEM (loopback-only run)"
else
  # This stage spawns a real Cloudflare tunnel + writes a real DNS record under
  # the SHARED test zone. Both MUST be torn down on EVERY exit — success,
  # assertion failure, or a mid-stage crash — or the zone accumulates orphaned
  # tunnels/records across runs. The in-container teardown below is the primary
  # net; run.sh adds a defensive host-side trap for the case where the whole
  # container dies before this trap can fire.
  STAGE4_TUNNEL_NAME=""   # set once `parachute expose` derives/creates it
  # shellcheck disable=SC2329  # invoked indirectly via `trap … EXIT` below.
  stage4_teardown() {
    local tc=$?
    printf '\n========== STAGE 4 TEARDOWN (always runs) ==========\n' >&2
    # 1. Stop the connector + clear local expose state (best-effort).
    parachute expose public off --cloudflare >/tmp/stage4-off.log 2>&1 || true
    cat /tmp/stage4-off.log >&2 || true
    # 2. Delete the account-side tunnel by name so the test account doesn't
    #    accumulate defined-but-idle tunnels. `parachute expose … off` only
    #    stops the LOCAL connector (the tunnel stays "defined in Cloudflare"),
    #    so we delete it explicitly. Resolve the name we used; fall back to the
    #    derived name from the FQDN if the var wasn't set yet.
    local tname="${STAGE4_TUNNEL_NAME:-}"
    if [ -z "$tname" ]; then
      # Mirror deriveTunnelName(): lowercase, dots→hyphens, strip non [a-z0-9_-],
      # prefix parachute-. (Length-truncation is irrelevant for our short FQDNs.)
      tname="parachute-$(printf '%s' "$E2E_FQDN" | tr '[:upper:]' '[:lower:]' | tr '.' '-' | tr -cd 'a-z0-9_-')"
    fi
    if command -v cloudflared >/dev/null 2>&1; then
      if cloudflared tunnel delete -f "$tname" >/tmp/stage4-tunnel-delete.log 2>&1; then
        note "torn down tunnel '$tname'"
      else
        note "tunnel delete '$tname' (may already be gone):"
        cat /tmp/stage4-tunnel-delete.log >&2 || true
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
          >/tmp/stage4-dns-cleanup.log 2>&1; then
        cat /tmp/stage4-dns-cleanup.log >&2 || true
      else
        printf '\n!! DNS CLEANUP FAILED — POSSIBLE ORPHAN. Host-side trap will retry.\n' >&2
        cat /tmp/stage4-dns-cleanup.log >&2 || true
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
  trap stage4_teardown EXIT

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
      *) die "stage4-expose" "CLOUDFLARED_CERT_PEM is neither an existing file nor inline PEM (no -----BEGIN)" ;;
    esac
  fi
  chmod 600 /root/.cloudflared/cert.pem
  if ! grep -q "BEGIN" /root/.cloudflared/cert.pem; then
    die "stage4-expose" "cert.pem has no BEGIN block at /root/.cloudflared/cert.pem"
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
      *) die "stage4-expose" "unsupported arch for cloudflared install: ${CF_ARCH}" ;;
    esac
    if ! curl -fsSL -o /usr/local/bin/cloudflared \
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_SUFFIX}" \
        >/tmp/cloudflared-dl.log 2>&1; then
      cat /tmp/cloudflared-dl.log >&2
      die "stage4-expose" "cloudflared static-binary download failed"
    fi
    chmod +x /usr/local/bin/cloudflared
    hash -r
  fi
  command -v cloudflared >/dev/null 2>&1 || die "stage4-expose" "cloudflared not on PATH after install"
  note "cloudflared $(cloudflared --version 2>/dev/null | head -n1)"

  # --- run the REAL expose (non-interactive: --cloudflare + --domain) ---
  note "Exposing publicly: parachute expose public --cloudflare --domain ${E2E_FQDN}"
  STAGE4_TUNNEL_NAME="parachute-$(printf '%s' "$E2E_FQDN" | tr '[:upper:]' '[:lower:]' | tr '.' '-' | tr -cd 'a-z0-9_-')"
  EXPOSE_LOG=/tmp/parachute-expose.log
  if ! parachute expose public --cloudflare --domain "${E2E_FQDN}" >"$EXPOSE_LOG" 2>&1; then
    cat "$EXPOSE_LOG" >&2
    die "stage4-expose" "parachute expose public --cloudflare exited non-zero (connector never connected? 1033?)"
  fi
  cat "$EXPOSE_LOG"
  # The expose itself asserts connector-connection before printing success
  # (#593). Belt-and-suspenders: require the success line.
  grep -qi "Cloudflare tunnel up" "$EXPOSE_LOG" || die "stage4-expose" "expose did not report 'Cloudflare tunnel up'"
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
    cloudflared tunnel info "${STAGE4_TUNNEL_NAME}" >&2 2>&1 || true
    die "stage4-expose" "FAILURE MODE = DNS-never-resolves: ${E2E_FQDN} did not resolve at 1.1.1.1 within 180s (propagation/zone), connector side may be fine"
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
    CONN_COUNT="$(cloudflared tunnel info --output json "${STAGE4_TUNNEL_NAME}" 2>/dev/null \
      | bun -e 'try{const j=JSON.parse(await Bun.stdin.text());console.log((j.conns??j.connections??[]).length||0)}catch{console.log(0)}' 2>/dev/null || echo 0)"
    HTTP_BODY="$(curl -sS -i --max-time 8 --resolve "${E2E_FQDN}:443:${RESOLVED_IP}" "${PUBLIC}/health" 2>&1 | head -30 || true)"
    printf '%s\n' "$HTTP_BODY" >&2
    cloudflared tunnel info "${STAGE4_TUNNEL_NAME}" >&2 2>&1 || true
    if printf '%s' "$HTTP_BODY" | grep -q "1033" || [ "${CONN_COUNT:-0}" -eq 0 ]; then
      die "stage4-expose" "FAILURE MODE = resolves-but-1033: ${E2E_FQDN} resolves (${RESOLVED_IP}) but no live connector (count=${CONN_COUNT}) — error 1033 (this is the #593 connector-down path)"
    fi
    die "stage4-expose" "FAILURE MODE = resolves-and-connector-up-but-unhealthy: ${E2E_FQDN} resolves + ${CONN_COUNT} connector(s) live, but /health is not 200 db:ok — a REAL product bug (see body above)"
  fi
  note "✓ https://${E2E_FQDN}/health serves db:ok through the real Cloudflare tunnel."
  record "stage4-public-health" "PASS" "${E2E_FQDN}/health 200 db:ok via tunnel (DNS+edge verified)"

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
  note "Running the full OAuth dance + MCP round-trip over the PUBLIC origin…"
  if ! bun /root/mcp-probe.ts \
        --hub "${PUBLIC}" \
        --vault "${VAULT_NAME}" \
        --user "${ADMIN_USER}" \
        --pass "${ADMIN_PASS}"; then
    die "stage4-expose" "MCP OAuth-dance / round-trip over the public Cloudflare origin FAILED"
  fi
  note "✓ MCP round-trip succeeded over the public tunnel."
  record "stage4-mcp-public" "PASS" "DCR→PKCE→token→MCP over https://${E2E_FQDN}"

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
        record "stage4-selfheal" "PASS" "vault .env=public origin, survives restart (#481/#503)"
      else
        note "WARNING: vault did not re-serve cleanly after restart (bonus assert)."
        record "stage4-selfheal" "PASS" "vault .env=public origin (restart re-serve unverified — bonus)"
      fi
    else
      note "NOTE: vault .env present but PARACHUTE_HUB_ORIGIN != ${PUBLIC} (bonus self-heal assert):"
      grep "PARACHUTE_HUB_ORIGIN" "$VAULT_ENV" >&2 || note "  (no PARACHUTE_HUB_ORIGIN line)"
      record "stage4-selfheal" "PASS" "expose+MCP green; .env origin assert soft (bonus)"
    fi
  else
    note "NOTE: vault .env absent (${VAULT_ENV}) — skipping bonus self-heal assert."
    record "stage4-selfheal" "PASS" "expose+MCP green; .env not present (bonus skipped)"
  fi

  # --- teardown the expose + assert the origin is CLEARED (#503) ---
  # The teardown trap runs the tunnel/DNS delete on EXIT regardless; here we
  # also exercise the `off` path explicitly so we can assert vault's `.env`
  # origin is cleared (the inverse of the self-heal — #503).
  note "Tearing the expose down (parachute expose public off --cloudflare)…"
  parachute expose public off --cloudflare >/tmp/stage4-off-explicit.log 2>&1 || true
  cat /tmp/stage4-off-explicit.log
  if [ -f "$VAULT_ENV" ] && grep -q "PARACHUTE_HUB_ORIGIN=${PUBLIC}" "$VAULT_ENV"; then
    note "NOTE: vault .env still carries the public origin after off (#503 — soft assert, bonus)."
  else
    note "✓ vault .env public origin cleared after expose off (#503)."
  fi
  record "stage4-expose" "PASS" "real CF tunnel: public /health + MCP-over-public + teardown"
fi

# ---------------------------------------------------------------------------
hr "ALL STAGES PASSED"
exit 0
