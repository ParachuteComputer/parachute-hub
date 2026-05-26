#!/usr/bin/env bash
#
# deploy-to-fly.sh — friendly first-time deploy of @openparachute/hub to Fly.io.
#
# What it does:
#   1. Checks for flyctl; offers to install via the official one-liner.
#   2. Runs `fly auth whoami` to confirm you're logged in (or prompts).
#   3. Runs `fly launch --copy-config --yes` to provision app + volume + deploy.
#   4. Prints the resulting URL + the next-step hint (find bootstrap token,
#      visit /admin/setup).
#
# Idempotent: re-running on an already-launched app re-deploys via fly deploy.
#
# Usage:
#   ./scripts/deploy-to-fly.sh                  # auto-pick app name from fly.toml
#   ./scripts/deploy-to-fly.sh my-custom-name   # override app name
#
# See parachute-patterns/migrations/2026-05-26-render-to-fly-self-host.md
# for the broader context (peer self-host option alongside Render).

set -euo pipefail

APP_NAME_OVERRIDE="${1:-}"

echo "==> Checking for flyctl"
if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found."
  echo
  echo "Install with the official one-liner:"
  echo "    curl -L https://fly.io/install.sh | sh"
  echo
  read -rp "Install now? [y/N] " choice
  case "$choice" in
    [yY]*)
      curl -L https://fly.io/install.sh | sh
      # The installer puts flyctl in ~/.fly/bin; add to PATH for the rest of this run.
      export PATH="${HOME}/.fly/bin:${PATH}"
      ;;
    *)
      echo "Skipping. Re-run this script after installing flyctl."
      exit 1
      ;;
  esac
fi

echo "==> Checking flyctl auth"
if ! flyctl auth whoami >/dev/null 2>&1; then
  echo "Not signed in to Fly.io. Running 'fly auth login' (this will open your browser)…"
  flyctl auth login
fi
WHOAMI=$(flyctl auth whoami)
echo "Signed in as: ${WHOAMI}"

echo
echo "==> Provisioning app"
if [ -n "${APP_NAME_OVERRIDE}" ]; then
  echo "Using custom app name: ${APP_NAME_OVERRIDE}"
  flyctl launch --copy-config --yes --name "${APP_NAME_OVERRIDE}"
else
  echo "Using app name from fly.toml (or generated if taken)."
  flyctl launch --copy-config --yes
fi

# Resolve the app's public URL. After `launch`, fly.toml's `app` field
# carries the canonical name (Fly may have suffixed it if the original was taken).
APP_NAME=$(awk -F'"' '/^app = / {print $2; exit}' fly.toml)
APP_URL="https://${APP_NAME}.fly.dev"

echo
echo "==> Deploy complete"
echo
echo "Your hub is at: ${APP_URL}"
echo
echo "Next steps:"
echo "  1. Find your one-time bootstrap token in the logs:"
echo "       fly logs --app ${APP_NAME} | grep parachute-bootstrap-"
echo "  2. Open the setup page:"
echo "       open ${APP_URL}/admin/setup"
echo "  3. Paste the bootstrap token, create your admin account."
echo "  4. From /admin/modules, install vault. Then notes, scribe, etc."
echo
echo "Custom domain? After setup:"
echo "    fly certs add <your-domain> --app ${APP_NAME}"
echo "    fly secrets set PARACHUTE_HUB_ORIGIN=https://<your-domain> --app ${APP_NAME}"
echo
