/**
 * `/surface/notes` → `/surface/parachute` conditional alias (W2-12).
 *
 * The app's surface identity renamed from `notes` to `parachute`
 * (parachute-app W2-12): a FUTURE install of the renamed surface package
 * mounts at `/surface/parachute`, while every EXISTING install keeps
 * serving notes-ui at `/surface/notes` — mounts are per-install on-disk
 * identities, so nothing moves until an operator re-installs.
 *
 * The failure this alias exists for: an in-place upgrade that re-adds the
 * renamed package over an existing `notes` instance flips the mount to
 * `/surface/parachute`, orphaning every `/surface/notes/*` bookmark, PWA
 * install, and in-vault link. This helper is the safety net — when (and
 * only when) the manifest shows the legacy mount GONE and the new mount
 * PRESENT, `/surface/notes/*` 301s to `/surface/parachute/*` with the
 * sub-path tail and query string preserved.
 *
 * Condition — decided on the `uis{}` sub-units' **mount paths**, not their
 * map keys:
 *
 *   - fire  ⇔ no `uis{}` sub-unit (across every services.json row) is
 *             mounted at or under `/surface/notes`, AND some sub-unit is
 *             mounted at exactly `/surface/parachute`.
 *
 * The W2-12 plan phrased this as "uis has no `notes` key and has a
 * `parachute` key". Keys and paths coincide in the default install shape
 * (surface-host keys `uis{}` by the surface's effective `meta.name` and
 * defaults the mount to `/surface/<name>` — see parachute-surface
 * admin-routes.ts `buildUisExtraField`), but they diverge exactly in the
 * scenario this alias protects: re-adding the renamed package with
 * `instance_name=notes` and no `mount_path` keeps the key `notes` while
 * the PATH flips to `/surface/parachute`. A key-based condition would sit
 * inert there and let the bookmarks 404; the path-based condition asks the
 * routing question directly (the same `ui.path` values `resolveUiMount`
 * matches on), so it fires precisely when `/surface/notes` stopped
 * resolving and `/surface/parachute` started. It also can never redirect
 * INTO a 404: the target mount's existence is part of the condition.
 *
 * INERT TODAY on every live install, on both branches of the condition:
 * an existing notes-ui install either carries a `uis{}` sub-unit mounted
 * at `/surface/notes` (legacy-mount-present → no redirect) or — as on
 * installs whose surface-host row predates `uis{}` self-registration —
 * carries no `/surface/parachute` mount (new-mount-absent → no redirect).
 * Nothing fires until a surface actually registers at `/surface/parachute`.
 *
 * Dispatch placement (hub-server.ts): immediately BEFORE the generic
 * services.json proxy — the same spot in the order where `resolveUiMount`
 * reads the manifest — so every hub-owned prefix has had its turn and a
 * live `/surface/notes` mount is never preempted (the condition already
 * guarantees that, but the ordering keeps the alias out of the hot path
 * for all non-`/surface/notes` traffic).
 *
 * Relationship to `notes-redirect.ts`: that module bridges the OLDER
 * `/notes/*` → `/surface/notes/*` rename (notes-as-app Phase 2) and is
 * untouched by W2-12 — its target keeps serving notes-ui on existing
 * installs. On a post-rename install the two compose: `/notes/x` → 301
 * `/surface/notes/x` → 301 `/surface/parachute/x`.
 */

import type { ServiceEntry } from "./services-manifest.ts";

/** The legacy mount — the app's pre-W2-12 surface identity (notes-ui). */
export const LEGACY_SURFACE_NOTES_MOUNT = "/surface/notes";

/** The app's surface mount — the post-W2-12 identity. */
export const APP_SURFACE_PARACHUTE_MOUNT = "/surface/parachute";

/**
 * Matches the legacy app-surface mount: bare `/surface/notes`, the
 * trailing-slash form, and any sub-path. Boundary-checked — `/surface/notesy`
 * and `/surface/notes-archive` do NOT match. Same shape as
 * `isLegacyNotesPath` in notes-redirect.ts.
 */
export function isSurfaceNotesPath(pathname: string): boolean {
  return (
    pathname === LEGACY_SURFACE_NOTES_MOUNT || pathname.startsWith(`${LEGACY_SURFACE_NOTES_MOUNT}/`)
  );
}

/**
 * Decide whether a `/surface/notes*` request should 301 to the
 * `/surface/parachute*` twin. Returns the target (path + preserved query)
 * when the condition holds, `undefined` otherwise.
 *
 * `services` is the lenient manifest read (`readManifestLenient(...).services`)
 * — the same source `resolveUiMount` consumes, re-read per request so the
 * alias tracks a surface-host re-registration without a hub restart.
 *
 * Normalization mirrors `resolveUiMount`: trailing slashes stripped before
 * comparison. The legacy-mount check treats a sub-unit mounted at OR UNDER
 * `/surface/notes` as "the legacy identity still resolves" (a deeper mount
 * like `/surface/notes/foo` would still serve real content under the
 * prefix — redirecting across it would hijack a live route). The target
 * check requires an EXACT `/surface/parachute` mount — a deeper-only mount
 * would leave the redirect landing on a 404, which this alias exists to
 * prevent, not cause.
 */
export function maybeRedirectSurfaceNotes(
  pathname: string,
  search: string,
  services: readonly ServiceEntry[],
): string | undefined {
  if (!isSurfaceNotesPath(pathname)) return undefined;

  let legacyMountResolves = false;
  let appMountPresent = false;
  for (const entry of services) {
    if (!entry.uis) continue;
    for (const ui of Object.values(entry.uis)) {
      const norm = ui.path.replace(/\/+$/, "") || "/";
      if (
        norm === LEGACY_SURFACE_NOTES_MOUNT ||
        norm.startsWith(`${LEGACY_SURFACE_NOTES_MOUNT}/`)
      ) {
        legacyMountResolves = true;
      }
      if (norm === APP_SURFACE_PARACHUTE_MOUNT) {
        appMountPresent = true;
      }
    }
  }
  if (legacyMountResolves || !appMountPresent) return undefined;

  const tail = pathname.slice(LEGACY_SURFACE_NOTES_MOUNT.length);
  return `${APP_SURFACE_PARACHUTE_MOUNT}${tail}${search}`;
}
