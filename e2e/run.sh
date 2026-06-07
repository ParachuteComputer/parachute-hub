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

# Unique per-run names so concurrent runs (and the host's live install) never
# collide. PID + epoch keeps it unique even on a fast re-run.
RUN_ID="$$-$(date +%s)"
IMAGE="e2e-parachute-img-${RUN_ID}"
CONTAINER="e2e-parachute-${RUN_ID}"

log()  { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[e2e]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[e2e]\033[0m %s\n' "$*" >&2; }

TARBALL=""
cleanup() {
  local code=$?
  if [ -n "$TARBALL" ] && [ -f "$TARBALL" ]; then rm -f "$TARBALL" || true; fi
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
"$DOCKER" exec "$CONTAINER" chmod +x /root/stages.sh
if [ -n "$TARBALL" ]; then
  "$DOCKER" cp "$TARBALL" "$CONTAINER:/root/hub.tgz"
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
  "$CONTAINER" /root/stages.sh
STAGES_RC=$?
set -e

# ---------------------------------------------------------------------------
# 7. Per-stage summary table.
# ---------------------------------------------------------------------------
echo
log "================ STAGE SUMMARY ================"
RESULTS="$("$DOCKER" exec "$CONTAINER" cat /root/e2e-results 2>/dev/null || true)"
if [ -z "$RESULTS" ]; then
  err "No per-stage results recorded — stages.sh aborted before writing any."
else
  printf '%s\n' "$RESULTS" | while IFS='|' read -r name status detail; do
    [ -z "$name" ] && continue
    if [ "$status" = "PASS" ]; then
      printf '  \033[1;32mPASS\033[0m  %-28s %s\n' "$name" "$detail"
    elif [ "$status" = "SKIP" ]; then
      printf '  \033[1;33mSKIP\033[0m  %-28s %s\n' "$name" "$detail"
    else
      printf '  \033[1;31mFAIL\033[0m  %-28s %s\n' "$name" "$detail"
    fi
  done
fi
log "=============================================="

if [ "$STAGES_RC" -ne 0 ]; then
  err "E2E FAILED (stages exit $STAGES_RC). HUB_SOURCE=$HUB_SOURCE VAULT_CHANNEL=$VAULT_CHANNEL"
  exit "$STAGES_RC"
fi
log "E2E PASSED. HUB_SOURCE=$HUB_SOURCE VAULT_CHANNEL=$VAULT_CHANNEL"
