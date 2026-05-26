#!/usr/bin/env bash
#
# deploy-to-fly.sh — friendly first-time deploy of @openparachute/hub to Fly.io.
#
# What it does:
#   1. Checks for flyctl; offers to install via the official one-liner.
#   2. Runs `fly auth whoami` to confirm you're logged in (or prompts).
#   3. On first run: `fly launch --copy-config --yes` (provisions app + volume + deploy).
#      On re-run (fly.toml has an `app =` line from a prior launch): `fly deploy`.
#   4. Prints the resulting URL + next-step hint.
#
# Usage:
#   ./scripts/deploy-to-fly.sh                  # auto-pick app name (or use existing)
#   ./scripts/deploy-to-fly.sh my-custom-name   # override app name (first launch only)
#
# See parachute-patterns/migrations/2026-05-26-render-to-fly-self-host.md
# for the broader context (peer self-host option alongside Render).

set -euo pipefail

APP_NAME_OVERRIDE="${1:-}"

echo "==> Checking for flyctl"
if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl not found."
  echo
  echo "Install with the official one-liner (this runs a script from fly.io —"
  echo "review https://fly.io/install.sh if you'd like to inspect it first):"
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

# Detect whether fly.toml already carries an `app = "..."` line. If so, this is
# a re-run against an already-launched app — use `fly deploy` instead of
# `fly launch` (which would prompt to overwrite or error on the name).
EXISTING_APP=$(awk -F'"' '/^app = / {print $2; exit}' fly.toml || true)

if [ -n "${EXISTING_APP}" ]; then
  echo
  echo "==> fly.toml has app = \"${EXISTING_APP}\" — re-deploying existing app"
  flyctl deploy --app "${EXISTING_APP}"
  APP_NAME="${EXISTING_APP}"
else
  echo
  echo "==> No existing app in fly.toml — running first-time launch"
  if [ -n "${APP_NAME_OVERRIDE}" ]; then
    echo "Using custom app name: ${APP_NAME_OVERRIDE}"
    flyctl launch --copy-config --yes --name "${APP_NAME_OVERRIDE}"
  else
    echo "Letting Fly generate an app name (or pick one Fly suggests)."
    flyctl launch --copy-config --yes
  fi
  # After launch, fly.toml has been rewritten with the actual provisioned name.
  APP_NAME=$(awk -F'"' '/^app = / {print $2; exit}' fly.toml)
  if [ -z "${APP_NAME}" ]; then
    echo "WARN: couldn't read app name from fly.toml after launch. Check 'fly apps list'."
    APP_NAME="<your-app>"
  fi
fi

APP_URL="https://${APP_NAME}.fly.dev"

echo
echo "==> Done"
echo
echo "Your hub is at: ${APP_URL}"
echo
echo "Next steps (first launch only):"
echo "  1. Find your one-time bootstrap token in the logs:"
echo "       fly logs --app ${APP_NAME} | grep parachute-bootstrap-"
echo "  2. Open the setup page:"
echo "       open ${APP_URL}/admin/setup"
echo "  3. Paste the bootstrap token, create your admin account."
echo "  4. From /admin/modules, install vault. Then notes, scribe, etc."
echo
echo "Custom domain (after setup):"
echo "    fly certs add <your-domain> --app ${APP_NAME}"
echo "    fly secrets set PARACHUTE_HUB_ORIGIN=https://<your-domain> --app ${APP_NAME}"
echo
