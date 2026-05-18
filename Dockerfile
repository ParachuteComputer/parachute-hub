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
# period.
RUN apk add --no-cache tini

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
ENV PARACHUTE_HOME=/parachute \
    PORT=1939 \
    PARACHUTE_BIND_HOST=0.0.0.0 \
    BUN_INSTALL=/parachute/modules \
    NODE_ENV=production

# Pre-create the persistent-disk mount point AND the BUN_INSTALL subdir,
# then hand both to the non-root `bun` user (uid 1000). Docker creates
# a VOLUME mount with root:root permissions inheriting the image layer's
# owner; without this chown the first `mkdirSync('/parachute/well-known')`
# from `parachute serve` (or `bun add` writing into
# `/parachute/modules/install/global/...`) fails with EACCES. Render's
# disks come up pre-owned per Render's docs but anonymous-volume
# `docker run` and bind-mount paths both need this seed directory to
# exist with the right uid.
RUN mkdir -p /parachute/modules && chown -R bun:bun /parachute

# Render mounts the persistent disk at $PARACHUTE_HOME; declare the volume
# so a `docker run` without a bind mount still gets an anonymous volume
# rather than writing under the image layer.
VOLUME ["/parachute"]

EXPOSE 1939

# Run as the non-root `bun` user that the base image already provides.
# The persistent disk needs to be readable+writable by uid/gid 1000; both
# Render disks and standard bind mounts default to a mode that works.
USER bun

ENTRYPOINT ["/sbin/tini", "--"]
# `parachute serve` is the container-shape entrypoint: foreground hub, env-
# driven config, env-driven first-boot admin seed. The bare
# `bun src/hub-server.ts` path also works (and supports env via parseArgs)
# but skips the seedInitialAdminIfNeeded step, so the container would never
# auto-create the admin from PARACHUTE_INITIAL_ADMIN_*.
CMD ["bun", "src/cli.ts", "serve"]
