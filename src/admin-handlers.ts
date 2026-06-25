/**
 * HTTP handlers for the hub admin surface — login + logout. Sessions ride
 * the same `parachute_hub_session` cookie that the OAuth login mints, since
 * PR #112 widened the cookie path from `/oauth/` to `/`.
 *
 * `/login` (was `/admin/login` pre-#231-followup) is the canonical entry
 * for ALL parachute auth — admin operators, OAuth user flows, etc. The
 * `/admin/login` and `/admin/logout` paths 301-redirect for back-compat.
 *
 * Every state-changing POST is double-submit-CSRF protected
 * (`parachute_hub_csrf` cookie + `__csrf` form field, constant-time compare).
 */
import type { Database } from "bun:sqlite";
import { renderAdminError, renderAdminLogin, renderTotpChallenge } from "./admin-login-ui.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import {
  buildPendingLoginClearCookie,
  buildPendingLoginCookie,
  consumePendingLogin,
  createPendingLogin,
  getPendingLogin,
  parsePendingLoginCookie,
} from "./pending-login.ts";
import {
  authIpCeilingRateLimiter,
  clientIpFromRequest,
  compositeKey,
  loginRateLimiter,
  totpRateLimiter,
} from "./rate-limit.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import {
  SESSION_TTL_MS,
  buildSessionClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  parseSessionCookie,
} from "./sessions.ts";
import { isTotpEnrolled, verifySecondFactor } from "./two-factor-store.ts";
import {
  PASSWORD_MAX_LEN,
  type User,
  getUserById,
  getUserByUsername,
  isFirstAdmin,
  verifyPassword,
} from "./users.ts";

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });
}

function redirect(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...extra } });
}

/**
 * Post-login default landing. The admin SPA mounts at `/admin/*` and treats
 * `/admin/vaults` as its home (vault list, the default tab). Anywhere else
 * would either bounce the operator out of the SPA shell or land on a
 * legacy server-rendered page — `/admin/vaults` is the canonical entry.
 *
 * Exported because `api-account.ts` consumes the same constant for its
 * change-password landing. Single source of truth so a future "default
 * landing changed to /admin/dashboard" PR doesn't drift across two files.
 */
export const POST_LOGIN_DEFAULT = "/admin/vaults";

/**
 * Force-change-password landing. Multi-user Phase 1 PR 3: when a user
 * signs in with `password_changed === false` (admin-created account
 * with the admin's default password), the login POST 302s here instead
 * of `next`. The original `next` rides along as a query param so the
 * change-password POST can land them at their intended destination
 * after they pick a new password.
 *
 * Session-level redirect, not token-level — the cookie is minted as
 * normal; only the redirect target changes. The user IS signed in,
 * they're just expected to change their password before doing anything
 * else (the `/account/change-password` page is reachable, the SPA
 * isn't gated). Design §sign-in flow change.
 */
const FORCE_CHANGE_PASSWORD_PATH = "/account/change-password";

function safeNext(raw: string | null): string {
  if (!raw) return POST_LOGIN_DEFAULT;
  // Only allow same-origin paths — never honor an absolute URL or scheme.
  if (!raw.startsWith("/") || raw.startsWith("//")) return POST_LOGIN_DEFAULT;
  return raw;
}

/**
 * Pick the post-login redirect target for a freshly-authenticated user.
 *
 * **The only place `password_changed` gates a flow.** Per design §sign-
 * in flow change, force-change is a session-level redirect at the login
 * boundary — once changed, no per-request scope check is needed and
 * no token claim carries the bit forward.
 *
 * Three precedence rules, in order:
 *
 *   1. `password_changed === false` → `/account/change-password`
 *      (preserves `next` as a query param so the change-password POST
 *      finishes the trip).
 *   2. Non-admin user (friend) whose `next` targets `/admin/*` → rewrite
 *      to `/account/`. Friends have no business on admin SPA URLs —
 *      `/admin/host-admin-token` would 403 (first-admin gate) and the
 *      SPA would bounce them to `/account/` anyway. Doing the rewrite
 *      at the login boundary avoids the bouncing-around UX. Other `next`
 *      paths (`/`, `/oauth/authorize/...`, `/vault/...`) are legitimate
 *      destinations for non-admin users and pass through unchanged.
 *   3. Otherwise return `next` (the today's-default behavior).
 *
 * `db` is required for the non-admin check (it consults `getFirstAdminId`).
 * Wizard-only test fixtures that pre-existed the `db` plumbing pass the
 * harness DB through; the parameter is non-optional to make the
 * "did you remember the gate?" review check explicit.
 */
export function loginRedirectTarget(db: Database, user: User, next: string): string {
  if (!user.passwordChanged) {
    // Preserve the operator's intended destination; the change-password
    // POST will read this and 302 there after the change lands.
    // Only encode `next` if it isn't already the post-change default —
    // keeps the URL clean for the common case (no `next` param specified
    // at login time → no `?next=` on the change-password URL).
    if (next === POST_LOGIN_DEFAULT) return FORCE_CHANGE_PASSWORD_PATH;
    return `${FORCE_CHANGE_PASSWORD_PATH}?next=${encodeURIComponent(next)}`;
  }
  // Non-admin friend aiming at admin SPA: rewrite to /account/. We check
  // both the literal `/admin` and the `/admin/...` prefix; safeNext has
  // already normalized to a leading-`/` same-origin path, so a plain
  // string prefix check is sufficient (no `//admin.evil.com/` shape can
  // reach here).
  if (!isFirstAdmin(db, user.id) && (next === "/admin" || next.startsWith("/admin/"))) {
    return "/account/";
  }
  return next;
}

// --- /login ---------------------------------------------------------------
//
// Renamed from `/admin/login` so the surface name reflects what it is — the
// canonical entry for ALL parachute auth (operators, OAuth user flows,
// etc.), not an admin-only door. `/admin/login` and `/admin/logout` 301
// to here from `hub-server.ts` for back-compat.

export function handleAdminLoginGet(_db: Database, req: Request): Response {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  return htmlResponse(renderAdminLogin({ next, csrfToken: csrf.token }), 200, extra);
}

export async function handleAdminLoginPost(
  db: Database,
  req: Request,
  deps: AdminLoginDeps = {},
): Promise<Response> {
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return htmlResponse(
      renderAdminError({
        title: "Invalid form submission",
        message: "The form's CSRF token did not match. Reload the page and try again.",
      }),
      400,
    );
  }
  // Rate-limit gate fires *after* CSRF (so a junk cross-site POST doesn't
  // burn a bucket slot for the victim) but *before* credential check.
  // Every legitimate login attempt — wrong password, missing user, eventually
  // failed-2FA — counts toward the same bucket so an attacker can't partition
  // the cooldown across stages.
  //
  // Two tiers (the shared-egress-IP fix): a coarse per-IP CEILING (60/15min)
  // backstops username-rotation, then a per-(ip,username) FLOOR (5/15min) so
  // each account behind a shared NAT / Cloudflare egress IP gets its own
  // bucket instead of the whole room pooling into one 5-slot per-IP bucket.
  // `username` is hoisted above the gate because the floor keys on it. The same
  // `loginRateLimiter` + `compositeKey(ip, username)` scheme backs the
  // `/oauth/authorize` password door, so both doors share ONE per-account
  // bucket.
  const username = String(form.get("username") ?? "");
  const clientIp = clientIpFromRequest(req);
  const now = deps.now ? deps.now() : new Date();
  // Both checks always run (no short-circuit): a denied `checkAndRecord` does
  // NOT append a timestamp, so running the floor after a denied ceiling never
  // double-counts. We need both recorded so each independently tracks its own
  // bucket (the floor still gates per-account even when the ceiling is fine).
  const ceiling = authIpCeilingRateLimiter.checkAndRecord(clientIp, now);
  const floor = loginRateLimiter.checkAndRecord(compositeKey(clientIp, username), now);
  if (!ceiling.allowed || !floor.allowed) {
    const retryAfterSeconds = Math.max(
      ceiling.allowed ? 0 : (ceiling.retryAfterSeconds ?? 1),
      floor.allowed ? 0 : (floor.retryAfterSeconds ?? 1),
    );
    return htmlResponse(
      renderAdminError({
        title: "Too many login attempts",
        message: `Too many login attempts. Try again in ${retryAfterSeconds} seconds.`,
      }),
      429,
      { "retry-after": String(retryAfterSeconds) },
    );
  }
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  const csrfToken = typeof formCsrf === "string" ? formCsrf : "";
  if (!username || !password) {
    return htmlResponse(
      renderAdminLogin({ next, csrfToken, errorMessage: "Username and password are required." }),
      400,
    );
  }
  // Cap incoming password length BEFORE getUserByUsername / argon2id
  // verify touches it. An unauthenticated POST submitting a megabyte
  // password would otherwise force a full argon2id hash on arbitrary
  // input — CPU-DoS shape. 413 fires before any DB or hash work; same
  // `PASSWORD_MAX_LEN` constant `/api/users` and `/account/change-
  // password` use (PR-3 fold N1: applied uniformly across the auth
  // surface family).
  if (password.length > PASSWORD_MAX_LEN) {
    return htmlResponse(
      renderAdminError({
        title: "Password too long",
        message: `Password must be ≤ ${PASSWORD_MAX_LEN} characters.`,
      }),
      413,
    );
  }
  const user = getUserByUsername(db, username);
  if (!user) {
    return htmlResponse(
      renderAdminLogin({ next, csrfToken, errorMessage: "Invalid credentials." }),
      401,
    );
  }
  const ok = await verifyPassword(user, password);
  if (!ok) {
    return htmlResponse(
      renderAdminLogin({ next, csrfToken, errorMessage: "Invalid credentials." }),
      401,
    );
  }

  // 2FA gate (hub#473). If the user has TOTP enrolled, the password is only
  // the *first* factor — do NOT mint a session yet. Stash a short-lived
  // pending-login (server-side, keyed by an opaque cookie token) and render
  // the "enter your code" page. The session is minted in
  // `handleAdminLoginTotpPost` only after the second factor verifies.
  // Users WITHOUT 2FA fall through to the existing password-only path
  // unchanged — existing operators keep signing in exactly as before.
  if (isTotpEnrolled(db, user.id)) {
    const pendingToken = createPendingLogin(user.id, next);
    // Reuse the same CSRF token (cookie unchanged) for the challenge form.
    return htmlResponse(renderTotpChallenge({ next, csrfToken }), 200, {
      "set-cookie": buildPendingLoginCookie(pendingToken, req),
    });
  }

  return mintSessionAndRedirect(db, req, user, next);
}

/**
 * Mint a session for an authenticated user and 302 to the resolved target.
 * Shared by the password-only login path and the post-2FA path so both apply
 * the identical force-change-password / friend-rewrite redirect logic.
 *
 * `extraCookies` lets the 2FA path also clear the pending-login cookie in the
 * same response.
 */
function mintSessionAndRedirect(
  db: Database,
  req: Request,
  user: User,
  next: string,
  extraCookies: string[] = [],
): Response {
  const session = createSession(db, { userId: user.id });
  const sessionCookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000), {
    secure: isHttpsRequest(req),
  });
  // Multi-user Phase 1 PR 3 — `password_changed === false` (admin-created
  // user, hasn't picked their own password yet) lands at
  // `/account/change-password` instead of `next`. The session cookie is
  // minted as normal — the user IS authenticated, they're just expected
  // to change the admin-typed default before continuing. Their original
  // `next` rides along on the change-password URL so the post-change
  // POST can land them at their intended destination.
  const target = loginRedirectTarget(db, user, next);
  const headers = new Headers({ location: target });
  headers.append("set-cookie", sessionCookie);
  for (const c of extraCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

/**
 * POST `/login/2fa` — the second-factor step (hub#473).
 *
 * Reached only after a correct password POST for a 2FA-enrolled user handed
 * back a pending-login cookie. Order of checks:
 *   1. CSRF (else 400 — same shape as `/login`).
 *   2. Per-IP rate-limit (5 / 15 min) BEFORE the factor check, so backup-code
 *      / TOTP grinding by a password-holder is bounded.
 *   3. Pending-login cookie resolves to a live half-login (else 401 — the
 *      pending login expired or was never created; restart the password step).
 *   4. The user row still exists + still has 2FA enrolled (defensive).
 *   5. Verify the submitted code as TOTP (±1 window) OR a backup code (single-
 *      use, consumed on match). On success: consume the pending login, mint
 *      the session, 302 to the resolved target + clear the pending cookie.
 *      On failure: re-render the challenge with an error (the pending login
 *      stays valid so the user can retry without re-entering the password).
 */
export async function handleAdminLoginTotpPost(
  db: Database,
  req: Request,
  deps: AdminLoginDeps = {},
): Promise<Response> {
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  const csrfToken = typeof formCsrf === "string" ? formCsrf : "";
  if (!verifyCsrfToken(req, csrfToken || null)) {
    return htmlResponse(
      renderAdminError({
        title: "Invalid form submission",
        message: "The form's CSRF token did not match. Reload the page and try again.",
      }),
      400,
    );
  }

  const next = safeNext(String(form.get("next") ?? ""));
  const code = String(form.get("code") ?? "");

  // Rate-limit BEFORE verifying the factor. Resolve the pending login FIRST so
  // the per-account floor can key on the STABLE userId (NOT the pendingToken,
  // which a fresh /login success rotates and would reset the bucket). Resolving
  // here also lets a bad/expired pending token fall back to keying the floor by
  // IP alone — never by the rotating pendingToken.
  const clientIp = clientIpFromRequest(req);
  const now = deps.now ? deps.now() : new Date();
  const pendingToken = parsePendingLoginCookie(req.headers.get("cookie"));
  const pending = getPendingLogin(pendingToken, () => now);
  // Two tiers (the shared-egress-IP fix): coarse per-IP CEILING (60/15min) +
  // per-(ip,userId) FLOOR (5/15min). When userId can't be resolved (bad/expired
  // pending token), key the floor by IP alone — do NOT key by the pendingToken.
  const ceiling = authIpCeilingRateLimiter.checkAndRecord(clientIp, now);
  const floorKey = pending ? compositeKey(clientIp, pending.userId) : clientIp;
  const floor = totpRateLimiter.checkAndRecord(floorKey, now);
  if (!ceiling.allowed || !floor.allowed) {
    const retryAfterSeconds = Math.max(
      ceiling.allowed ? 0 : (ceiling.retryAfterSeconds ?? 1),
      floor.allowed ? 0 : (floor.retryAfterSeconds ?? 1),
    );
    return htmlResponse(
      renderAdminError({
        title: "Too many attempts",
        message: `Too many verification attempts. Try again in ${retryAfterSeconds} seconds.`,
      }),
      429,
      { "retry-after": String(retryAfterSeconds) },
    );
  }

  if (!pending) {
    // No live pending login — expired, missing, or tampered. Send the user
    // back to the start; clear any stale pending cookie.
    return htmlResponse(
      renderAdminError({
        title: "Session expired",
        message: "Your sign-in attempt expired. Please sign in again.",
      }),
      401,
      { "set-cookie": buildPendingLoginClearCookie(req) },
    );
  }

  const user = getUserById(db, pending.userId);
  if (!user || !isTotpEnrolled(db, user.id)) {
    consumePendingLogin(pendingToken);
    return htmlResponse(
      renderAdminError({
        title: "Sign-in unavailable",
        message: "Please sign in again.",
      }),
      401,
      { "set-cookie": buildPendingLoginClearCookie(req) },
    );
  }

  if (!code) {
    return htmlResponse(
      renderTotpChallenge({ next, csrfToken, errorMessage: "Enter your authentication code." }),
      400,
    );
  }

  const result = await verifySecondFactor(db, user.id, code);
  if (!result.ok) {
    return htmlResponse(
      renderTotpChallenge({
        next,
        csrfToken,
        errorMessage: "That code is incorrect or expired. Try again.",
      }),
      401,
    );
  }

  // Second factor good. Consume the pending login (single use), mint the
  // session, and clear the pending cookie in the same response. Use the
  // pending login's stored `next` if the form's was tampered to the default.
  consumePendingLogin(pendingToken);
  const target = pending.next && pending.next !== POST_LOGIN_DEFAULT ? pending.next : next;
  return mintSessionAndRedirect(db, req, user, target, [buildPendingLoginClearCookie(req)]);
}

/**
 * Test-injection seam for `handleAdminLoginPost`. Production callers omit
 * `deps`; tests pass a deterministic clock so the rate-limit assertions
 * don't race wall-clock time.
 */
export interface AdminLoginDeps {
  /** Test seam — defaults to real clock. */
  now?: () => Date;
}

// --- /logout --------------------------------------------------------------

/**
 * POST-only — logout is state-changing, so it rides the same double-submit
 * CSRF discipline as login. Without CSRF, a malicious cross-origin form
 * could log the operator out (annoyance, not catastrophe, but the safety
 * belt is already on the bus).
 *
 * Always idempotent: clearing the cookie succeeds even if there's no
 * matching session row. Returns 302 → /login so the operator lands back
 * on the form ready to re-authenticate.
 */
export async function handleAdminLogoutPost(db: Database, req: Request): Promise<Response> {
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return htmlResponse(
      renderAdminError({
        title: "Invalid form submission",
        message: "The form's CSRF token did not match. Reload the page and try again.",
      }),
      400,
    );
  }
  const sid = parseSessionCookie(req.headers.get("cookie"));
  if (sid) deleteSession(db, sid);
  return redirect("/login", {
    "set-cookie": buildSessionClearCookie({ secure: isHttpsRequest(req) }),
  });
}
