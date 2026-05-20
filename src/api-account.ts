/**
 * `/account/*` — signed-in user self-service surfaces.
 *
 * Multi-user Phase 1, PR 3 of 5 (force-change-password flow). Design:
 * [`parachute.computer/design/2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/).
 * Tracker: hub#252. Builds on PR 2 (hub#280) which shipped the admin
 * `/api/users` surface for creating accounts that land with
 * `password_changed: false`.
 *
 * This file handles the *user* side of the change-password flow:
 *
 *   GET  /account/change-password    — server-rendered HTML form
 *   POST /account/change-password    — verify current + set new + flip flag
 *
 * Auth posture: any user with a valid session cookie can reach both
 * endpoints. The `/login` POST handler (separately) does the
 * force-redirect when `password_changed === false` — that's the *only*
 * surface that branches on the flag. The page itself is a regular
 * signed-in surface (per design §sign-in flow change "Direct
 * navigation"): a user with `password_changed: true` can still
 * navigate here to rotate their password, and the POST works for any
 * signed-in user against their own account.
 *
 * Force-change is **session-level, not token-level** (design
 * §security/force-change-password as session-level). Tokens minted
 * before the change stay valid until revoked; the redirect is the
 * interactive sign-in boundary. PR 4's OAuth issuer doesn't read the
 * flag at mint time.
 *
 * Wire shape: GET returns HTML (server-rendered). POST accepts
 * `application/x-www-form-urlencoded` (matches the form submission;
 * no fetch/JSON layer — keeps the page operational without JS, same
 * posture as `/login` and `/admin/setup/account`). On success the
 * POST returns 302 → `next` (or `/admin/vaults` if absent). On error
 * the POST re-renders the form with an inline error banner — same
 * pattern as `handleAdminLoginPost`.
 *
 * Other-session invalidation: skipped for Phase 1. Sessions are a
 * single `id` column with a `user_id` FK; a one-liner
 * `DELETE FROM sessions WHERE user_id = ? AND id != ?` would force
 * re-auth on other devices, but it also breaks tabs open elsewhere
 * without explicit user intent. Phase 2's self-service profile page
 * adds a deliberate "sign out everywhere" action (design §2 "Phase
 * 2"). Until then the user's existing other-device sessions stay
 * valid through to natural 24h expiry — matches the design doc's
 * trade-off discussion in §security/force-change-password.
 */
import type { Database } from "bun:sqlite";
import { hash as argonHash } from "@node-rs/argon2";
import { type ChangePasswordMode, renderChangePassword } from "./account-change-password-ui.ts";
import { renderAdminError } from "./admin-login-ui.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import { findActiveSession } from "./sessions.ts";
import {
  PASSWORD_MAX_LEN,
  UserNotFoundError,
  getUserById,
  validatePassword,
  verifyPassword,
} from "./users.ts";

export interface ApiAccountDeps {
  db: Database;
  /** Test seam — defaults to real clock. */
  now?: () => Date;
}

/**
 * Where to land after a successful password change when no `next` param
 * is present. Matches `POST_LOGIN_DEFAULT` in `admin-handlers.ts` — the
 * admin SPA's vault list. Kept as a local const (not imported) so this
 * file doesn't accidentally couple to admin-handlers' internals; if the
 * default ever diverges the two should reconcile via a shared config.
 */
const POST_CHANGE_DEFAULT = "/admin/vaults";

function safeNext(raw: string | null | undefined): string {
  if (!raw) return POST_CHANGE_DEFAULT;
  // Only allow same-origin paths — never honor an absolute URL or scheme.
  // Same shape as `safeNext` in admin-handlers.ts. The
  // change-password GET should never redirect *back* to /login for a
  // signed-in user, but if a malicious form somehow shipped an
  // absolute URL we'd want it ignored here too.
  if (!raw.startsWith("/") || raw.startsWith("//")) return POST_CHANGE_DEFAULT;
  return raw;
}

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
 * Compute the change-password mode from the user's `passwordChanged`
 * flag. Pure — both handlers below read the user, branch on this, and
 * render. Keeping it a free function keeps the GET / POST handlers
 * symmetric: the GET picks the mode for the initial render, the POST
 * picks the same mode if it has to re-render with an error.
 */
function modeFor(passwordChanged: boolean): ChangePasswordMode {
  return passwordChanged ? "rotate" : "first-time";
}

/**
 * GET /account/change-password — render the form.
 *
 * Auth: requires an active session. Without one, 302 to /login with
 * `?next=/account/change-password` so the user lands back here after
 * signing in. **Critically, this redirect fires regardless of the
 * `password_changed` flag** — a session-less user has no flag to
 * branch on, and they can't reach the change-password page until
 * they've signed in once.
 *
 * The page renders for *any* signed-in user — including users whose
 * `password_changed` is already `true`. That's the direct-navigation
 * path: a user manually visits to rotate their password (design §sign-
 * in flow change "Direct navigation").
 */
export function handleAccountChangePasswordGet(req: Request, deps: ApiAccountDeps): Response {
  const session = findActiveSession(deps.db, req);
  if (!session) {
    // Echo `next` so post-login lands back here. Same safe-next discipline
    // as `/login` — strip any unsafe path before re-emitting.
    const url = new URL(req.url);
    const requestedNext = url.searchParams.get("next");
    const safeNextValue = safeNext(requestedNext);
    const querySuffix =
      safeNextValue !== POST_CHANGE_DEFAULT ? `?next=${encodeURIComponent(safeNextValue)}` : "";
    const nextParam = encodeURIComponent(`/account/change-password${querySuffix}`);
    return redirect(`/login?next=${nextParam}`);
  }
  const user = getUserById(deps.db, session.userId);
  if (!user) {
    // Session points at a deleted user — clear posture is "log them out."
    // Hand back to /login; the stale session row will time out on its own.
    return redirect("/login");
  }
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  return htmlResponse(
    renderChangePassword({
      mode: modeFor(user.passwordChanged),
      csrfToken: csrf.token,
      username: user.username,
      next,
    }),
    200,
    extra,
  );
}

/**
 * POST /account/change-password — verify current + apply new.
 *
 * Order of checks (matches the design doc's §sign-in flow change /
 * §scope-section ordering):
 *   1. Session (else 401 — no body to validate without an identity).
 *   2. CSRF (else 400 — same wire shape as `/login` POST CSRF failure).
 *   3. Required-field presence (else 400).
 *   4. `current_password.length > PASSWORD_MAX_LEN` → 413 BEFORE argon2id
 *      verify touches it. Session-gated, so the CPU-DoS surface is
 *      narrower than the unauthenticated `/login` POST, but the cap is
 *      cheap insurance against a megabyte-current-password submission
 *      (PR-3 fold N1).
 *   5. `new_password.length > PASSWORD_MAX_LEN` → 413 BEFORE argon2id
 *      hash touches it.
 *   6. `validatePassword(new_password)` → 400 `invalid_password`
 *      (12-char floor; same validator the create-user path uses).
 *   7. `new_password !== confirm` → 400 `password_mismatch`.
 *   8. `verifyPassword(user, current_password)` → 401 `invalid_credentials`.
 *      Runs argon2id so order matters — 7 happens first to avoid burning
 *      a hash on an obviously-broken input.
 *   9. `new_password === current_password` → 400 `password_unchanged`.
 *  10. Hash new + atomic UPDATE (password_hash + password_changed=1 +
 *      updated_at) in one transaction (PR-3 fold N2) → 302 → next.
 *
 * Re-render shape on validation failure: the page comes back with an
 * inline error banner (matching `/login`'s POST failure shape), HTTP
 * status reflects the class (400 / 401 / 413). On success: 302 to
 * `next` — the session cookie is unchanged (the user is still signed
 * in; only the password hash and the flag moved).
 */
export async function handleAccountChangePasswordPost(
  req: Request,
  deps: ApiAccountDeps,
): Promise<Response> {
  const session = findActiveSession(deps.db, req);
  if (!session) {
    // No session means no identity — there's no useful re-render here.
    // Same shape as the admin-API endpoints: 401 with a brief HTML
    // response, the operator's flow recovers by signing in again.
    return htmlResponse(
      renderAdminError({
        title: "Not signed in",
        message: "Please sign in before changing your password.",
      }),
      401,
    );
  }
  const user = getUserById(deps.db, session.userId);
  if (!user) {
    return htmlResponse(
      renderAdminError({
        title: "Account not found",
        message: "The signed-in account no longer exists. Please sign in again.",
      }),
      401,
    );
  }

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
  const csrfToken = typeof formCsrf === "string" ? formCsrf : "";

  const currentPassword = String(form.get("current_password") ?? "");
  const newPassword = String(form.get("new_password") ?? "");
  const confirmPassword = String(form.get("new_password_confirm") ?? "");
  const next = safeNext(String(form.get("next") ?? ""));
  const mode = modeFor(user.passwordChanged);

  // Required-field check before any expensive work.
  if (!currentPassword || !newPassword || !confirmPassword) {
    return htmlResponse(
      renderChangePassword({
        mode,
        csrfToken,
        username: user.username,
        next,
        errorMessage: "All three fields are required.",
      }),
      400,
    );
  }

  // Cap `currentPassword` length BEFORE argon2id verify touches it. The
  // session-authenticated caller would otherwise be able to submit a
  // megabyte body and force a full argon2id hash on arbitrary input
  // (CPU-DoS shape — same flavor as the unauthenticated /api/users POST
  // mitigates with the new-password cap below, but session-gated here
  // since change-password sits behind /login). Same 413 + shape as the
  // new-password cap; same `PASSWORD_MAX_LEN` constant.
  if (currentPassword.length > PASSWORD_MAX_LEN) {
    return htmlResponse(
      renderChangePassword({
        mode,
        csrfToken,
        username: user.username,
        next,
        errorMessage: `Current password must be ≤ ${PASSWORD_MAX_LEN} characters.`,
      }),
      413,
    );
  }

  // Cap new-password length BEFORE argon2id touches it. 413 fires before
  // any validator or hash call so a megabyte body burns ~0ms server CPU.
  // Same pattern as PR 2's `/api/users` POST.
  if (newPassword.length > PASSWORD_MAX_LEN) {
    return htmlResponse(
      renderChangePassword({
        mode,
        csrfToken,
        username: user.username,
        next,
        errorMessage: `New password must be ≤ ${PASSWORD_MAX_LEN} characters.`,
      }),
      413,
    );
  }

  // 12-char minimum (PR 1 validator). Floors only; no complexity rules.
  const validity = validatePassword(newPassword);
  if (!validity.valid) {
    return htmlResponse(
      renderChangePassword({
        mode,
        csrfToken,
        username: user.username,
        next,
        errorMessage: "New password must be at least 12 characters (a passphrase is fine).",
      }),
      400,
    );
  }

  // Confirm-matches check before the argon2id verify — fast feedback for
  // a transposed-character mistake, and avoids one hash call on the
  // common typo path.
  if (newPassword !== confirmPassword) {
    return htmlResponse(
      renderChangePassword({
        mode,
        csrfToken,
        username: user.username,
        next,
        errorMessage: "New password and confirmation do not match.",
      }),
      400,
    );
  }

  // Verify current password. Argon2id verify is the expensive op; we
  // gated above so it only fires once per legitimate-shape submission.
  const currentOk = await verifyPassword(user, currentPassword);
  if (!currentOk) {
    return htmlResponse(
      renderChangePassword({
        mode,
        csrfToken,
        username: user.username,
        next,
        errorMessage: "Current password is incorrect.",
      }),
      401,
    );
  }

  // Refuse same-as-current. We check after verify so a 401 ("wrong
  // current password") takes precedence over "your current password
  // happens to equal your new attempt but isn't even your real current
  // password" — a 400 here when current is wrong would leak that the
  // typed `new_password` matches *some* attempted prior. With verify-
  // first, this branch only fires when current is correct AND new
  // equals current — the real "didn't actually change anything" case.
  if (newPassword === currentPassword) {
    return htmlResponse(
      renderChangePassword({
        mode,
        csrfToken,
        username: user.username,
        next,
        errorMessage: "New password must differ from your current password.",
      }),
      400,
    );
  }

  // Persist new hash + flip the changed flag, atomically.
  //
  // Hash OUTSIDE the transaction. `db.transaction()` on bun:sqlite is
  // sync — argon2id's async hash promise inside the closure would
  // silently break atomicity (same constraint the OAuth token-rotate
  // path documents in oauth-handlers.ts). Hash first, then run both
  // UPDATEs inside the tx so a mid-write process crash can't land us
  // with a fresh hash but a stale flag (benign in this direction — one
  // extra force-redirect on next login — but trivially avoidable).
  const now = deps.now ?? (() => new Date());
  const passwordHash = await argonHash(newPassword);
  const stamp = now().toISOString();
  try {
    deps.db.transaction(() => {
      const result = deps.db
        .prepare(
          "UPDATE users SET password_hash = ?, password_changed = 1, updated_at = ? WHERE id = ?",
        )
        .run(passwordHash, stamp, user.id);
      if (result.changes === 0) throw new UserNotFoundError(user.id);
    })();
  } catch (err) {
    // The user row vanished between the session-resolve check above and
    // the UPDATE. Surface as 401 + "account not found" — same shape as
    // the stale-session-id branch at the top of this handler.
    if (err instanceof UserNotFoundError) {
      return htmlResponse(
        renderAdminError({
          title: "Account not found",
          message: "The signed-in account no longer exists. Please sign in again.",
        }),
        401,
      );
    }
    throw err;
  }

  // Ops-visibility headers (no downstream consumer): surface password-
  // change events to hub log grep / monitoring without changing the
  // response body. Safe to remove if not in use. `x-parachute-password-
  // changed: 1` is the event marker; `x-secure-context` records whether
  // the request arrived over HTTPS (matches the cookie's `Secure`
  // attribute decision so a log line at the same path tells the
  // operator the transport posture without re-checking the cookie).
  // No new session cookie set — the existing one stays valid. The user
  // remains signed in, just with a fresh hash. (Other devices' sessions
  // also stay valid; Phase 2 adds "sign out everywhere" per the
  // design's session-invalidation discussion.)
  return redirect(next, {
    "x-parachute-password-changed": "1",
    "cache-control": "no-store",
    "x-secure-context": isHttpsRequest(req) ? "https" : "http",
  });
}

/**
 * Flip `users.password_changed` from 0 to 1 for the given user.
 * Idempotent — running against an already-`true` row is a no-op.
 *
 * **Not used by the change-password POST itself** — that path inlines
 * the password_changed=1 flip into the same UPDATE that writes the new
 * hash, so the two writes commit atomically inside one transaction
 * (folds N2 of PR #281). This standalone helper is retained for two
 * call sites that don't co-occur with a hash rewrite:
 *
 *   1. Test scaffolding that flips the bit without rotating the hash.
 *   2. Phase 2's admin-reset path, where the operator-side rewrite of
 *      the hash flips `password_changed` back to 0 (so the user is
 *      forced through change-password on next login) — there's no
 *      `markPasswordChanged` call on that flow, but a future
 *      "skip-force-change for this re-issued password" flow would
 *      want it.
 *
 * Lives here (not in `users.ts`) because the only current call site is
 * the test scaffolding; lift into `users.ts` next to `setPassword` when
 * Phase 2 grows a production caller.
 */
export function markPasswordChanged(
  db: Database,
  userId: string,
  now: () => Date = () => new Date(),
): void {
  const stamp = now().toISOString();
  db.prepare("UPDATE users SET password_changed = 1, updated_at = ? WHERE id = ?").run(
    stamp,
    userId,
  );
}
