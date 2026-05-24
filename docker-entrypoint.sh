#!/bin/sh
set -e

# Recursive chown of bun-written paths on every start. Earlier deploys
# may have created files under /parachute/modules/install/ owned by root
# (pre-gosu Dockerfiles) or with bun's zero-perms-lockfile bug
# (oven-sh/bun#4314) — both surface as "error: An internal error occurred
# (AccessDenied)" on the next install. A top-level `stat /parachute`
# check is insufficient because the wrong-owner files live several
# levels down. Recursive chown of the bun-write paths is cheap (small
# disk) and idempotent.
mkdir -p /parachute/tmp /parachute/modules/bin
chown -R bun:bun /parachute/tmp /parachute/modules

# Drop privileges + run hub. gosu does this safely (forwards signals,
# preserves process tree under tini).
exec gosu bun "$@"
