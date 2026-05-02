/**
 * Auth helper for the hub SPA. Unlike paraclaw's hub-as-issuer OAuth flow,
 * this SPA is served BY the hub itself — so it leans on the existing
 * password-gated `/admin/login` session cookie instead of running its own
 * OAuth dance.
 *
 * Flow:
 *   1. SPA bootstrap calls `getHostAdminToken()`.
 *   2. That hits `GET /admin/host-admin-token`. The endpoint:
 *      - reads `parachute_hub_session` cookie (set by /admin/login)
 *      - mints a short-lived (~10 min) JWT carrying `parachute:host:admin`
 *        and returns it as JSON.
 *   3. Token is held in module-scoped state — NOT localStorage. Page
 *      snapshots can't carry it past a refresh, and XSS surface is the
 *      narrowest possible.
 *   4. On 401, redirect the browser to `/admin/login?next=<current path>`.
 *      The hub's standard login form then cookie-signs the operator and
 *      bounces back here.
 *
 * The narrow `parachute:host:admin` scope is in `NON_REQUESTABLE_SCOPES`
 * server-side, so the public `/oauth/authorize` flow refuses to mint it.
 * Only this session-cookie path can — see hub#scope-explanations.ts.
 */

interface MintedToken {
  token: string;
  expiresAt: number; // epoch ms
}

let cached: MintedToken | null = null;
let inFlight: Promise<string> | null = null;

/** Minimum slack we keep on the cached token before refetching. */
const REFRESH_BUFFER_MS = 30_000;

function tokenEndpoint(): string {
  // Mount-aware: BASE_URL is `/hub/` in production builds, `/` in dev. The
  // mint endpoint sits at the origin root (`/admin/host-admin-token`) — same
  // origin in both modes, so we never prefix with BASE_URL here.
  return "/admin/host-admin-token";
}

function loginRedirectUrl(): string {
  // Round-trip the *current* SPA URL — origin + pathname + search — so the
  // post-login redirect drops the operator back where they started. Hash is
  // intentionally dropped: the /admin/login `next=` param is server-rendered
  // and doesn't survive a fragment round-trip cleanly.
  const next = `${window.location.pathname}${window.location.search}`;
  return `/admin/login?next=${encodeURIComponent(next)}`;
}

/**
 * Returns the cached host-admin JWT, refreshing it if it's about to expire
 * (or if we don't have one yet). Concurrent callers share the in-flight
 * fetch — we don't want a burst of API calls to mint a token each.
 *
 * On 401 (no admin session), navigates the browser to /admin/login and
 * returns a never-resolving Promise so callers don't try to use a missing
 * token. Caller code does not need to check for null.
 */
export async function getHostAdminToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - now > REFRESH_BUFFER_MS) {
    return cached.token;
  }
  if (inFlight) return inFlight;
  inFlight = fetchToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function fetchToken(): Promise<string> {
  const res = await fetch(tokenEndpoint(), {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "same-origin",
  });
  if (res.status === 401) {
    cached = null;
    window.location.replace(loginRedirectUrl());
    // Hang — the navigation will tear down this page. Returning a rejected
    // promise would surface "session expired" errors the operator can't act
    // on; the right UX is "you've already left."
    return new Promise<string>(() => {});
  }
  if (!res.ok) {
    throw new Error(`/admin/host-admin-token failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  if (!body.token || !body.expires_at) {
    throw new Error("/admin/host-admin-token returned malformed body");
  }
  cached = { token: body.token, expiresAt: new Date(body.expires_at).getTime() };
  return body.token;
}

/** Drop the cached token. Useful after sign-out or an explicit invalidation. */
export function clearCachedToken(): void {
  cached = null;
}

/** Test seam: replace the cached token directly. */
export function _setCachedTokenForTest(token: string, expiresAt: number): void {
  cached = { token, expiresAt };
}
