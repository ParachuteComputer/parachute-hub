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
import { renderAdminError, renderAdminLogin } from "./admin-login-ui.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { checkAndRecord, clientIpFromRequest } from "./rate-limit.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import {
  SESSION_TTL_MS,
  buildSessionClearCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  parseSessionCookie,
} from "./sessions.ts";
import { PASSWORD_MAX_LEN, type User, getUserByUsername, verifyPassword } from "./users.ts";

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
 */
const POST_LOGIN_DEFAULT = "/admin/vaults";

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
 * When `password_changed === false`:
 *   - redirect to `/account/change-password`
 *   - preserve the user's intended `next` as a query param so the
 *     change-password POST can finish the trip
 *
 * When `password_changed === true`: return `next` (today's behavior).
 */
export function loginRedirectTarget(user: User, next: string): string {
  if (user.passwordChanged) return next;
  // Preserve the operator's intended destination; the change-password
  // POST will read this and 302 there after the change lands.
  // Only encode `next` if it isn't already the post-change default —
  // keeps the URL clean for the common case (no `next` param specified
  // at login time → no `?next=` on the change-password URL).
  if (next === POST_LOGIN_DEFAULT) return FORCE_CHANGE_PASSWORD_PATH;
  return `${FORCE_CHANGE_PASSWORD_PATH}?next=${encodeURIComponent(next)}`;
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
  // burn a bucket slot for the victim's IP) but *before* credential check.
  // Every legitimate login attempt — wrong password, missing user, eventually
  // failed-2FA (#186) — counts toward the same bucket so an attacker can't
  // partition the cooldown across stages.
  const clientIp = clientIpFromRequest(req);
  const now = deps.now ? deps.now() : new Date();
  const gate = checkAndRecord(clientIp, now);
  if (!gate.allowed) {
    return htmlResponse(
      renderAdminError({
        title: "Too many login attempts",
        message: `Too many login attempts from this IP. Try again in ${gate.retryAfterSeconds ?? 1} seconds.`,
      }),
      429,
      { "retry-after": String(gate.retryAfterSeconds ?? 1) },
    );
  }
  const username = String(form.get("username") ?? "");
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
  const session = createSession(db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000), {
    secure: isHttpsRequest(req),
  });
  // Multi-user Phase 1 PR 3 — `password_changed === false` (admin-created
  // user, hasn't picked their own password yet) lands at
  // `/account/change-password` instead of `next`. The session cookie is
  // minted as normal — the user IS authenticated, they're just expected
  // to change the admin-typed default before continuing. Their original
  // `next` rides along on the change-password URL so the post-change
  // POST can land them at their intended destination.
  const target = loginRedirectTarget(user, next);
  return redirect(target, { "set-cookie": cookie });
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
