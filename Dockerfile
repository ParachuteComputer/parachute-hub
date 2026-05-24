# syntax=docker/dockerfile:1.7
#
# Parachute Hub container image.
#
# Stage 1 (`builder`) installs dependencies (including web/ui's React SPA
# devDeps via the workspace postinstall) and produces the built SPA in
# `web/ui/dist`. Stage 2 copies the source + the built SPA + production
# `node_modules` into a slim runtime layer.
#
# Bun reads `src/cli.ts` directly — no separate transpile step. The
# entrypoint runs the hub HTTP server on `${PORT}` (default 1939), with
# `PARACHUTE_HOME` pointed at the persistent disk (default `/parachute`).
#
# Operator-facing env vars:
#   PORT                              — bind port (Render injects this)
#   PARACHUTE_BIND_HOST               — bind hostname; container default
#                                       `0.0.0.0` (set below). Override only
#                                       if you're putting another reverse
#                                       proxy in front inside the container.
#   PARACHUTE_HOME                    — config root (mount the disk here)
#   PARACHUTE_HUB_ORIGIN              — canonical https://… origin for OAuth
#   PARACHUTE_INITIAL_ADMIN_USERNAME  — first-boot admin username (optional)
#   PARACHUTE_INITIAL_ADMIN_PASSWORD  — first-boot admin password (optional)
#   BUN_INSTALL                       — root for runtime-installed modules.
#                                       Pinned to `/parachute/modules` (under
#                                       the persistent disk) so vault/notes/
#                                       scribe installed via /admin/modules
#                                       survive container restarts. Without
#                                       this, `bun add @openparachute/<svc>`
#                                       would write to bun's per-user prefix
#                                       on the ephemeral image layer and
#                                       vanish on every redeploy.
#   PARACHUTE_INSTALL_CHANNEL         — cluster-wide channel cascade for
#                                       `parachute install` and the admin SPA
#                                       install API (hub#337). When set to
#                                       `rc`, every module installed via
#                                       /admin/modules resolves
#                                       `@openparachute/<pkg>@rc` rather than
#                                       `@latest`. Render's blueprint pins
#                                       this to `rc` so a hub-on-rc deploy
#                                       cascades the rc-ness across vault /
#                                       app / scribe / runner; flip to
#                                       `latest` once 1.0 lands. Per-call
#                                       `--channel rc|latest` and `--tag`
#                                       still override.

ARG BUN_VERSION=1.3
FROM oven/bun:${BUN_VERSION}-alpine AS builder

WORKDIR /app

# Copy manifests first so Docker layer-caches the install step across
# source-only changes. Includes the scope-guard workspace package and the
# web/ui frontend workspace.
COPY package.json bun.lock ./
COPY packages/scope-guard/package.json packages/scope-guard/
COPY web/ui/package.json web/ui/bun.lock web/ui/

# Install with the lockfile pinned. `--frozen-lockfile` matches CI; the
# top-level install's `postinstall` triggers `bun run build:spa` which
# needs the web/ui devDeps, so install everything (no --production).
RUN bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source. `.dockerignore` already prunes
# node_modules, .git, dist artifacts, etc.
COPY . .

# Build the SPA explicitly (postinstall was skipped above via
# --ignore-scripts to keep the install layer source-independent).
RUN bun run build:spa

# ---- Runtime stage --------------------------------------------------------

FROM oven/bun:${BUN_VERSION}-alpine AS runtime

WORKDIR /app

# tini reaps zombies + forwards signals so `docker stop` / Render redeploys
# shut the hub down cleanly instead of getting SIGKILLed after the grace
# period. gosu drops privileges from root → bun inside the entrypoint
# script (see docker-entrypoint.sh + hub#349) while preserving the
# process tree so tini's signal forwarding still works end-to-end.
RUN apk add --no-cache tini gosu

# Bring over installed deps + the built SPA + source. The image runs the
# hub from source via Bun (no separate build artifact for src/).
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/web/ui/dist ./web/ui/dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/LICENSE ./LICENSE
COPY --from=builder /app/README.md ./README.md

# Default PARACHUTE_HOME points at the persistent-disk mount. The boot
# script ensures the directory exists before the hub starts, so a fresh
# Render disk doesn't 500 on first request.
#
# BUN_INSTALL pins runtime-installed modules under the persistent disk
# (`/parachute/modules`) so vault / notes / scribe installed via
# /admin/modules survive container restarts. Bun's `bun add -g <pkg>`
# resolves to `$BUN_INSTALL/install/global/node_modules/<pkg>`; module
# discovery in src/install-source.ts already honors this env var, so
# the supervisor finds children at the new path without code changes.
#
# TMPDIR pinned to /parachute/tmp so bun's `bun add` package extraction
# happens ON the persistent disk. Without this, bun extracts to /tmp
# (overlay filesystem) and rename() across mount points fails with
# EXDEV — the same Render-disk-as-separate-block-device issue that
# makes operators see "Failed to link: EACCES" on `parachute install`.
# See hub#349 for the diagnosis trail.
ENV PARACHUTE_HOME=/parachute \
    PORT=1939 \
    PARACHUTE_BIND_HOST=0.0.0.0 \
    BUN_INSTALL=/parachute/modules \
    TMPDIR=/parachute/tmp \
    NODE_ENV=production

# Pre-create the persistent-disk mount point AND the BUN_INSTALL subdir,
# then hand both to the non-root `bun` user (uid 1000). The runtime
# entrypoint script chowns /parachute idempotently to handle disks that
# were created before this line existed (Render persistent disks
# preserve ownership across deploys — see hub#349).
RUN mkdir -p /parachute/modules && chown -R bun:bun /parachute

# Render mounts the persistent disk at $PARACHUTE_HOME; declare the volume
# so a `docker run` without a bind mount still gets an anonymous volume
# rather than writing under the image layer.
VOLUME ["/parachute"]

EXPOSE 1939

# Copy entrypoint that runs as root → chowns /parachute if needed → drops to bun.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# DO NOT set USER bun here — the entrypoint runs as root briefly to
# fix disk ownership, then `exec gosu bun "$@"` drops privileges before
# hub starts. Tini wraps the whole tree for clean signal forwarding.
#
# tini -g forwards signals to the process group, not just the immediate
# child. Works around a Render-specific EPERM where tini (PID 1, root)
# can't signal the bun child (uid 1000) on some kernel/seccomp configs
# (`[FATAL tini (1)] Unexpected error when forwarding signal: 'Operation
# not permitted'`). Group signal forwarding is a common container pattern.
ENTRYPOINT ["/sbin/tini", "-g", "--", "docker-entrypoint.sh"]
# `parachute serve` is the container-shape entrypoint: foreground hub, env-
# driven config, env-driven first-boot admin seed. The bare
# `bun src/hub-server.ts` path also works (and supports env via parseArgs)
# but skips the seedInitialAdminIfNeeded step, so the container would never
# auto-create the admin from PARACHUTE_INITIAL_ADMIN_*.
CMD ["bun", "src/cli.ts", "serve"]
