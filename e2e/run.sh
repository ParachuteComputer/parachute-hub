#!/usr/bin/env bash
#
# Tier-1 E2E host driver. Runs on the operator's machine (macOS / Docker
# Desktop) AND on ubuntu-latest GH runners. Builds the systemd-in-container
# image, boots it, waits for systemd, execs the staged test script inside,
# streams output, and ALWAYS tears the container down (trap).
#
# Usage:
#   ./e2e/run.sh
#
# Env vars:
#   HUB_SOURCE     npm:<spec>  install @openparachute/hub@<spec> from the
#                              registry (default: npm:rc).
#                  local       `bun pm pack` the local checkout, copy the
#                              tarball in, install THAT — exercises
#                              uncommitted/unpublished code through the
#                              published-artifact path (prepack runs, the
#                              `files` allowlist applies).
#   VAULT_CHANNEL  rc|latest   install channel for the vault module
#                              (default: rc). Threaded to the container as
#                              PARACHUTE_INSTALL_CHANNEL.
#   E2E_KEEP       1           skip teardown (leave the container for
#                              post-mortem `docker exec` debugging).
#   E2E_DOCKER     <bin>       docker binary (default: docker).
#
# Exit non-zero if any stage fails. Prints a per-stage summary table at the end.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

HUB_SOURCE="${HUB_SOURCE:-npm:rc}"
VAULT_CHANNEL="${VAULT_CHANNEL:-rc}"
DOCKER="${E2E_DOCKER:-docker}"

# Stage-4 (public Cloudflare expose) creds. OPTIONAL — when absent, Stage 4
# SKIPs (stages 1-3 still run, so contributors without a test zone keep a
# useful run). When present:
#   CLOUDFLARED_CERT_PEM  the cloudflared origin cert for the test zone, as
#                         EITHER a file path OR the literal PEM text (we detect
#                         `-----BEGIN`). The cert authorizes `cloudflared tunnel
#                         route dns` AND (via its embedded token) the CF-API DNS
#                         cleanup. In CI it's `secrets.CLOUDFLARED_CERT_PEM`.
#   E2E_TEST_ZONE         the Cloudflare zone to provision the per-run hostname
#                         under (default: parachute.place). `vars.E2E_TEST_ZONE`
#                         in CI.
# `:-` covers unset; the `[ -z ]` also covers an empty-string value (CI passes
# `vars.E2E_TEST_ZONE` which is "" when the variable isn't configured).
E2E_TEST_ZONE="${E2E_TEST_ZONE:-parachute.place}"
[ -z "$E2E_TEST_ZONE" ] && E2E_TEST_ZONE="parachute.place"

# Unique per-run names so concurrent runs (and the host's live install) never
# collide. PID + epoch keeps it unique even on a fast re-run.
RUN_ID="$$-$(date +%s)"
IMAGE="e2e-parachute-img-${RUN_ID}"
CONTAINER="e2e-parachute-${RUN_ID}"

# Per-run public hostname under the test zone. The short random suffix is
# derived from the host RUN_ID (epoch+pid) so two concurrent/repeat runs never
# collide on a hostname — and a crashed run never poisons the next (each run's
# tunnel + DNS record is uniquely named, torn down independently). Lowercased,
# dots-as-hyphens already (RUN_ID is digits + one hyphen).
E2E_SUFFIX="$(printf '%s' "$RUN_ID" | tr -cd 'a-z0-9-')"
E2E_FQDN="e2e-${E2E_SUFFIX}.${E2E_TEST_ZONE}"

# Resolve CLOUDFLARED_CERT_PEM to the literal PEM text (supporting a path OR
# inline content). Empty when unset → Stage 4 SKIPs.
CERT_PEM_TEXT=""
if [ -n "${CLOUDFLARED_CERT_PEM:-}" ]; then
  case "$CLOUDFLARED_CERT_PEM" in
    *-----BEGIN*)
      # Inline PEM content passed directly.
      CERT_PEM_TEXT="$CLOUDFLARED_CERT_PEM"
      ;;
    *)
      # Treat as a file path.
      if [ -f "$CLOUDFLARED_CERT_PEM" ]; then
        CERT_PEM_TEXT="$(cat "$CLOUDFLARED_CERT_PEM")"
      else
        err "CLOUDFLARED_CERT_PEM is set but is neither inline PEM (no -----BEGIN) nor an existing file path: '$CLOUDFLARED_CERT_PEM'"
        exit 1
      fi
      ;;
  esac
fi

log()  { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[e2e]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[e2e]\033[0m %s\n' "$*" >&2; }

TARBALL=""
PACK_DIR=""
CERT_FILE=""

# Defensive HOST-SIDE teardown of the Stage-4 tunnel + DNS record. The
# in-container trap (stages.sh `stage4_teardown`) is the PRIMARY cleanup; this
# is the net for when the whole CONTAINER dies before that trap can run (a
# kernel OOM, a `docker rm -f` race, a privileged-container wedge). A leaked
# tunnel/DNS record per run is unacceptable on a SHARED test zone, so we always
# try — best-effort, idempotent (deleting an already-gone record is a no-op).
# Runs only when Stage 4 was actually armed (cert present).
host_side_cf_teardown() {
  [ -z "$CERT_PEM_TEXT" ] && return 0
  log "Host-side Cloudflare teardown net (tunnel + DNS for ${E2E_FQDN})…"
  # Derive the tunnel name exactly as deriveTunnelName() does.
  local tname
  tname="parachute-$(printf '%s' "$E2E_FQDN" | tr '[:upper:]' '[:lower:]' | tr '.' '-' | tr -cd 'a-z0-9_-')"
  # Best-effort, only if cloudflared + the cert are available on the host.
  if command -v cloudflared >/dev/null 2>&1 && [ -n "$CERT_FILE" ] && [ -f "$CERT_FILE" ]; then
    TUNNEL_ORIGIN_CERT="$CERT_FILE" cloudflared tunnel delete -f "$tname" >/dev/null 2>&1 \
      && log "  host-side: deleted tunnel '$tname'." || true
  fi
  # DNS record cleanup via the CF API (reuses the cert's embedded token). bun is
  # installed on the host for HUB_SOURCE=local; if absent, the in-container trap
  # already handled it on the happy path.
  if [ -n "$CERT_FILE" ] && [ -f "$CERT_FILE" ] && command -v bun >/dev/null 2>&1; then
    bun "$HERE/cf-dns-cleanup.ts" --cert "$CERT_FILE" --fqdn "$E2E_FQDN" >/dev/null 2>&1 \
      && log "  host-side: DNS record for ${E2E_FQDN} cleaned." || true
  fi
}

cleanup() {
  local code=$?
  # Stage-4 tunnel/DNS net BEFORE we nuke the container (so the in-container
  # trap got first crack; this catches the container-died case).
  host_side_cf_teardown
  # Remove the packed tarball AND its mktemp dir (the dir was previously leaked).
  if [ -n "$TARBALL" ] && [ -f "$TARBALL" ]; then rm -f "$TARBALL" || true; fi
  if [ -n "$PACK_DIR" ] && [ -d "$PACK_DIR" ]; then rm -rf "$PACK_DIR" || true; fi
  # The host-side cert temp file (never committed; lives only for this run).
  if [ -n "$CERT_FILE" ] && [ -f "$CERT_FILE" ]; then rm -f "$CERT_FILE" || true; fi
  if [ "${E2E_KEEP:-}" = "1" ]; then
    warn "E2E_KEEP=1 — leaving container '$CONTAINER' up for debugging."
    warn "  docker exec -it $CONTAINER bash    # poke around"
    warn "  docker rm -f $CONTAINER            # when done"
    return
  fi
  log "Tearing down container + image…"
  "$DOCKER" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  "$DOCKER" rmi -f "$IMAGE"     >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT INT TERM

# Materialize the resolved cert PEM to a host temp file (used to copy INTO the
# container as a file — never as a `-e` env arg, so it stays off the process
# arg list / `docker inspect`). Empty CERT_PEM_TEXT → no file, Stage 4 SKIPs.
if [ -n "$CERT_PEM_TEXT" ]; then
  CERT_FILE="$(mktemp)"
  printf '%s' "$CERT_PEM_TEXT" > "$CERT_FILE"
  chmod 600 "$CERT_FILE"
fi

# ---------------------------------------------------------------------------
# 1. Build the image.
# ---------------------------------------------------------------------------
log "Building systemd image '$IMAGE'…"
"$DOCKER" build -f "$HERE/Dockerfile.systemd" -t "$IMAGE" "$HERE"

# ---------------------------------------------------------------------------
# 2. For HUB_SOURCE=local, pack the local checkout (published-artifact path).
#    `bun pm pack` runs `prepack` (build:spa) and honors the `files` allowlist
#    — closest to what `npm publish` produces, so we test the real shipped
#    shape, not the dev tree.
# ---------------------------------------------------------------------------
# Resolve HUB_SOURCE into the bun-add spec the container installs.
#   npm:<spec>  → install @openparachute/hub@<spec> (strip the npm: prefix)
#   local       → pack the checkout, install the tarball
case "$HUB_SOURCE" in
  npm:*) HUB_INSTALL_SPEC="${HUB_SOURCE#npm:}" ;;  # e.g. "rc", "latest", "0.6.5-rc.4"
  local) HUB_INSTALL_SPEC="local" ;;
  *)
    err "HUB_SOURCE must be 'npm:<spec>' or 'local' (got '$HUB_SOURCE')"; exit 1
    ;;
esac
if [ "$HUB_SOURCE" = "local" ]; then
  log "HUB_SOURCE=local — packing the local checkout via 'bun pm pack'…"
  PACK_DIR="$(mktemp -d)"
  ( cd "$REPO_ROOT" && bun pm pack --destination "$PACK_DIR" >/dev/null )
  TARBALL="$(find "$PACK_DIR" -maxdepth 1 -name '*.tgz' | head -n1)"
  if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
    err "bun pm pack produced no tarball in $PACK_DIR"; exit 1
  fi
  log "  packed: $(basename "$TARBALL")"
  HUB_INSTALL_SPEC="local"
fi

# ---------------------------------------------------------------------------
# 3. Start the container with the flags that make systemd happy as PID 1
#    under Docker Desktop (macOS) AND on ubuntu GH runners.
#
#    --privileged              systemd needs broad caps to manage cgroups/units
#    --cgroupns=host           share the host cgroup namespace (cgroup v2)
#    -v /sys/fs/cgroup:…:rw     systemd writes to the cgroup fs
#    --tmpfs /run /run/lock     systemd's runtime dirs (writable tmpfs)
#    These are the canonical systemd-in-Docker flags; verified locally on
#    Docker Desktop for macOS and they match the documented ubuntu-runner shape.
# ---------------------------------------------------------------------------
log "Starting container '$CONTAINER' (systemd PID 1)…"
"$DOCKER" run -d \
  --name "$CONTAINER" \
  --privileged \
  --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run \
  --tmpfs /run/lock \
  -e "HUB_INSTALL_SPEC=${HUB_INSTALL_SPEC}" \
  -e "PARACHUTE_INSTALL_CHANNEL=${VAULT_CHANNEL}" \
  -e "E2E_FQDN=${E2E_FQDN}" \
  -e "E2E_TEST_ZONE=${E2E_TEST_ZONE}" \
  "$IMAGE" >/dev/null

# ---------------------------------------------------------------------------
# 4. Wait for systemd readiness. `is-system-running` returns `running` (all
#    units up) or `degraded` (some masked/failed units — fine for us). We poll
#    until it settles or we time out. `initializing`/`starting` mean "keep
#    waiting".
# ---------------------------------------------------------------------------
log "Waiting for systemd to reach running/degraded…"
deadline=$(( $(date +%s) + 60 ))
while true; do
  state="$("$DOCKER" exec "$CONTAINER" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in
    running|degraded)
      log "  systemd is '$state'."
      break
      ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    err "systemd did not settle within 60s (last state: '${state:-unknown}')."
    "$DOCKER" exec "$CONTAINER" systemctl --no-pager status 2>&1 | head -30 || true
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------------------
# 5. Copy the staged test scripts (+ the local tarball, if any) into the
#    container, then exec the runner as root — matching the real fresh-VPS
#    transcripts (operators run `parachute init` as root).
# ---------------------------------------------------------------------------
log "Copying test assets into the container…"
"$DOCKER" cp "$HERE/stages.sh"   "$CONTAINER:/root/stages.sh"
"$DOCKER" cp "$HERE/mcp-probe.ts" "$CONTAINER:/root/mcp-probe.ts"
"$DOCKER" cp "$HERE/cf-dns-cleanup.ts" "$CONTAINER:/root/cf-dns-cleanup.ts"
"$DOCKER" exec "$CONTAINER" chmod +x /root/stages.sh
if [ -n "$TARBALL" ]; then
  "$DOCKER" cp "$TARBALL" "$CONTAINER:/root/hub.tgz"
fi
# Stage-4 cert: copy the resolved PEM in as a FILE (never an `-e` env arg, so
# the secret stays off the exec process arg list / `docker inspect`). stages.sh
# reads CLOUDFLARED_CERT_PEM as a path-or-inline value (it detects -----BEGIN),
# so pointing it at this in-container path arms Stage 4; absent → Stage 4 SKIPs.
CONTAINER_CERT_PATH=""
if [ -n "$CERT_FILE" ] && [ -f "$CERT_FILE" ]; then
  "$DOCKER" cp "$CERT_FILE" "$CONTAINER:/root/cf-cert-src.pem"
  "$DOCKER" exec "$CONTAINER" chmod 600 /root/cf-cert-src.pem
  CONTAINER_CERT_PATH="/root/cf-cert-src.pem"
fi

# ---------------------------------------------------------------------------
# 6. Run the stages. stages.sh streams its own output and writes a machine-
#    readable summary line per stage to /root/e2e-results so we can render a
#    table here regardless of the overall exit code.
# ---------------------------------------------------------------------------
log "Running staged tests inside the container…"
set +e
"$DOCKER" exec \
  -e "HUB_INSTALL_SPEC=${HUB_INSTALL_SPEC}" \
  -e "PARACHUTE_INSTALL_CHANNEL=${VAULT_CHANNEL}" \
  -e "E2E_FQDN=${E2E_FQDN}" \
  -e "E2E_TEST_ZONE=${E2E_TEST_ZONE}" \
  -e "CLOUDFLARED_CERT_PEM=${CONTAINER_CERT_PATH}" \
  "$CONTAINER" /root/stages.sh
STAGES_RC=$?
set -e

# ---------------------------------------------------------------------------
# 7. Per-stage summary table.
# ---------------------------------------------------------------------------
echo
log "================ STAGE SUMMARY ================"
RESULTS="$("$DOCKER" exec "$CONTAINER" cat /root/e2e-results 2>/dev/null || true)"
XFAIL_COUNT=0
if [ -z "$RESULTS" ]; then
  err "No per-stage results recorded — stages.sh aborted before writing any."
else
  # Render each line; tally XFAILs (known live bugs the harness surfaces).
  while IFS='|' read -r name status detail; do
    [ -z "$name" ] && continue
    case "$status" in
      PASS)  printf '  \033[1;32mPASS \033[0m %-28s %s\n' "$name" "$detail" ;;
      SKIP)  printf '  \033[1;33mSKIP \033[0m %-28s %s\n' "$name" "$detail" ;;
      XFAIL) printf '  \033[1;35mXFAIL\033[0m %-28s %s\n' "$name" "$detail" ;;
      *)     printf '  \033[1;31mFAIL \033[0m %-28s %s\n' "$name" "$detail" ;;
    esac
  done <<EOF_RESULTS
$RESULTS
EOF_RESULTS
  # Count XFAILs separately (the while-loop above runs in this shell, but the
  # here-string keeps it out of a subshell so we could increment — we re-grep
  # to be robust regardless of shell pipeline semantics).
  XFAIL_COUNT="$(printf '%s\n' "$RESULTS" | grep -c '|XFAIL|' || true)"
fi
log "=============================================="

if [ "$STAGES_RC" -ne 0 ]; then
  err "E2E FAILED (stages exit $STAGES_RC). HUB_SOURCE=$HUB_SOURCE VAULT_CHANNEL=$VAULT_CHANNEL"
  exit "$STAGES_RC"
fi
if [ "${XFAIL_COUNT:-0}" -gt 0 ]; then
  warn "E2E PASSED with ${XFAIL_COUNT} XFAIL(s) — known, tracked live bug(s) surfaced (see the FINDING block(s) above, e.g. hub#610)."
  warn "  HUB_SOURCE=$HUB_SOURCE VAULT_CHANNEL=$VAULT_CHANNEL"
  exit 0
fi
log "E2E PASSED. HUB_SOURCE=$HUB_SOURCE VAULT_CHANNEL=$VAULT_CHANNEL"
