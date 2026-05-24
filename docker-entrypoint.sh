#!/bin/sh
set -e

# Idempotent chown — only runs if /parachute is NOT already bun-owned.
# Handles both fresh disks (already correct) and stale-ownership disks
# from operators whose deploys predate the chown-at-build Dockerfile line.
#
# The `stat -c '%u'` check returns the numeric uid. The `bun` user in
# the oven/bun-alpine image is uid 1000.
if [ "$(stat -c '%u' /parachute 2>/dev/null)" != "1000" ]; then
  echo "[parachute] chowning /parachute to bun:bun (was owned by uid $(stat -c '%u' /parachute 2>/dev/null || echo unknown))" >&2
  chown -R bun:bun /parachute
fi

# Ensure /parachute/tmp exists and is bun-owned. Bun uses TMPDIR for
# package extraction during `bun add`; if TMPDIR is on a different
# filesystem than $BUN_INSTALL (e.g. Render's /tmp on overlay vs.
# /parachute on a separate ext4 block device), rename() across mounts
# fails with EXDEV and the install errors with "Failed to link: EACCES".
# Putting TMPDIR on the same filesystem as BUN_INSTALL fixes it.
mkdir -p /parachute/tmp
chown bun:bun /parachute/tmp

# Ensure /parachute/modules/bin exists and is bun-owned. Bun creates
# binary symlinks here during `bun add -g`; without this, the first
# install fails to mkdir and EACCES surfaces. See hub#349.
mkdir -p /parachute/modules/bin
chown bun:bun /parachute/modules/bin

# Drop privileges + run hub. gosu does this safely (forwards signals,
# preserves process tree under tini).
exec gosu bun "$@"
