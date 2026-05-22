/**
 * Notes-as-app migration Phase 2 (parachute-app design doc §16).
 *
 * When parachute-app ships and Notes installs as `parachute-app add
 * @openparachute/notes-ui --name notes --path /app/notes`, operators with
 * existing `/notes/*` bookmarks need a transparent bridge. The hub serves a
 * 301 redirect from `/notes/*` → `/app/notes/*` so:
 *
 *   - cached operator URLs (notes PWA install banners, browser history,
 *     in-vault links) keep working
 *   - the apps-hosted Notes inherits the traffic without per-operator
 *     coordination
 *   - Phase 3 retires the redirect entirely once parachute-notes (the
 *     module form) is fully decommissioned
 *
 * The redirect is default-on. Operators still running notes-as-module
 * without parachute-app installed can opt out via the `hub_settings`
 * row `notes_redirect_disabled = "true"` (see hub-settings.ts) — without
 * the escape hatch they'd hit a redirect → 404 loop the moment apps isn't
 * present. The opt-out is the legacy-mode crutch, not the default.
 *
 * Placement in hub-server's dispatch matters: this fires BEFORE the
 * generic services.json proxy (which is where `/notes/*` would otherwise
 * route to the notes-daemon). When the opt-out flag is set, the redirect
 * is skipped and dispatch falls through to the existing proxy path.
 */

import type { Database } from "bun:sqlite";
import { isNotesRedirectDisabled } from "./hub-settings.ts";

/**
 * Matches the legacy notes mount: the bare `/notes`, the trailing-slash
 * form `/notes/`, and any sub-path `/notes/<rest>`. Doesn't match unrelated
 * prefixes like `/notesy` or `/notes-archive` — the boundary check rejects
 * those.
 */
export function isLegacyNotesPath(pathname: string): boolean {
  if (pathname === "/notes" || pathname === "/notes/") return true;
  return pathname.startsWith("/notes/");
}

/**
 * Compute the redirect target from a legacy `/notes/*` pathname + raw query
 * string. The query is preserved verbatim; the fragment isn't visible
 * server-side (clients reassemble it after following the redirect).
 *
 * The transform is purely path-rewrite — `/notes` → `/app/notes`, `/notes/`
 * → `/app/notes/`, `/notes/foo/bar` → `/app/notes/foo/bar`.
 */
export function buildNotesRedirectTarget(pathname: string, search: string): string {
  // Slice off the leading "/notes" — what remains is either "" (bare /notes),
  // "/" (trailing slash), or "/<rest>" (sub-path).
  const tail = pathname.slice("/notes".length);
  return `/app/notes${tail}${search}`;
}

/**
 * Decide whether a request should be redirected. Returns the new target URL
 * when yes, `undefined` when no (path doesn't match, or opt-out flag is set,
 * or no DB is configured so the flag can't be checked — in that last case
 * we still redirect, since the migration default is on).
 *
 * `db` is optional: when absent (test seam or pre-DB-config hub startup),
 * we redirect anyway — the absent-DB case mirrors absent-row, both meaning
 * "no operator opt-out exists." The intent is that operators flipping the
 * opt-out flag have a hub-with-DB; the redirect-on default doesn't depend
 * on DB readiness.
 */
export function maybeRedirectNotes(
  pathname: string,
  search: string,
  db: Database | undefined,
): string | undefined {
  if (!isLegacyNotesPath(pathname)) return undefined;
  if (db !== undefined && isNotesRedirectDisabled(db)) return undefined;
  return buildNotesRedirectTarget(pathname, search);
}

/**
 * Throttled "we redirected an operator" log line, so a misbehaving client
 * (a stuck PWA, a curl loop) doesn't flood stdout. Each distinct legacy
 * pathname gets one log line per `RATE_LIMIT_WINDOW_MS` window; the
 * window resets per-path so a healthy mix of bookmarks still surfaces
 * operator-visible migration activity.
 *
 * Module-level state is fine here — the hub is a single process and the
 * tracker is bounded in size by the number of distinct legacy paths
 * operators have bookmarked (small). The `clearNotesRedirectLogState` test
 * helper resets it between test runs.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const lastLogAt = new Map<string, number>();

export interface LogNotesRedirectOpts {
  /** Test seam — production uses `Date.now()`. */
  now?: () => number;
  /** Test seam — production uses `console.log`. */
  log?: (msg: string) => void;
}

export function logNotesRedirect(
  pathname: string,
  target: string,
  opts: LogNotesRedirectOpts = {},
): void {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const t = now();
  const last = lastLogAt.get(pathname);
  if (last !== undefined && t - last < RATE_LIMIT_WINDOW_MS) return;
  lastLogAt.set(pathname, t);
  log(`[notes-migration] redirect ${pathname} → ${target}`);
}

/**
 * Test-only: clear the throttle bucket. Bun's module-level state survives
 * across tests in the same process, so this gives tests a clean slate.
 */
export function clearNotesRedirectLogState(): void {
  lastLogAt.clear();
}
