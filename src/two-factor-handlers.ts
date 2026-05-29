/**
 * `/account/2fa` — user self-service TOTP 2FA enroll / disenroll (hub#473).
 *
 *   GET  /account/2fa   — render current state (enrolled → status+disenroll;
 *                         not enrolled → "set up" CTA).
 *   POST /account/2fa   — dispatch on the `action` field:
 *                           start   → generate a secret + render QR/confirm
 *                           confirm → verify code vs the in-flight secret,
 *                                     persist enrollment, show backup codes
 *                           disable → verify current password, clear 2FA
 *
 * Auth posture: every endpoint requires an active session (the signed-in user
 * acts on their OWN account). Same session-or-302-to-/login shape as
 * `/account/change-password`.
 *
 * Enrollment is browser-first (right for headless servers): the secret is
 * generated server-side, shown as a QR + manual base32 key, and only PERSISTED
 * after the user confirms a live code (proving the authenticator was set up).
 * The in-flight secret rides a hidden form field between `start` and `confirm`
 * — it isn't stored until confirmation, so an abandoned setup leaves no state.
 *
 * No JSON layer — server-rendered HTML forms, same as the rest of `/account/*`,
 * so 2FA setup works without JS.
 */
import type { Database } from "bun:sqlite";
import QRCode from "qrcode";
import { renderAdminError } from "./admin-login-ui.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import { findActiveSession } from "./sessions.ts";
import { generateTotpSecret, otpauthUrlFor, verifyTotpCode } from "./totp.ts";
import {
  backupCodesRemaining,
  clearEnrollment,
  getTotpState,
  isTotpEnrolled,
  persistEnrollment,
} from "./two-factor-store.ts";
import {
  renderTwoFactorBackupCodes,
  renderTwoFactorEnrolled,
  renderTwoFactorEnrolling,
  renderTwoFactorNotEnrolled,
} from "./two-factor-ui.ts";
import { PASSWORD_MAX_LEN, type User, getUserById, verifyPassword } from "./users.ts";

export interface TwoFactorDeps {
  db: Database;
  /** Test seam — defaults to real clock. */
  now?: () => Date;
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

/** Resolve the signed-in user, or a Response to return (302 / 401). */
function requireUser(deps: TwoFactorDeps, req: Request): { user: User } | { response: Response } {
  const session = findActiveSession(deps.db, req);
  if (!session) {
    return { response: redirect(`/login?next=${encodeURIComponent("/account/2fa")}`) };
  }
  const user = getUserById(deps.db, session.userId);
  if (!user) {
    return { response: redirect("/login") };
  }
  return { user };
}

/** Render the QR SVG for a secret + the enrolling page. */
async function renderEnrolling(
  csrfToken: string,
  secret: string,
  label: string,
  errorMessage?: string,
): Promise<Response> {
  const otpauthUrl = otpauthUrlFor(secret, label);
  // Inline SVG — self-contained, no external fetch (privacy posture).
  const qrSvg = await QRCode.toString(otpauthUrl, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
  });
  return htmlResponse(
    renderTwoFactorEnrolling({
      csrfToken,
      qrSvg,
      secret,
      ...(errorMessage ? { errorMessage } : {}),
    }),
  );
}

/**
 * GET /account/2fa — render the current 2FA state for the signed-in user.
 */
export function handleTwoFactorGet(req: Request, deps: TwoFactorDeps): Response {
  const got = requireUser(deps, req);
  if ("response" in got) return got.response;
  const user = got.user;

  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};

  if (isTotpEnrolled(deps.db, user.id)) {
    const state = getTotpState(deps.db, user.id);
    return htmlResponse(
      renderTwoFactorEnrolled({
        csrfToken: csrf.token,
        enrolledAt: state.enrolledAt,
        backupCodesRemaining: state.backupCodes.length,
      }),
      200,
      extra,
    );
  }
  // `?disabled=1` — the disenroll POST 302s here so a refresh doesn't re-POST;
  // surface a one-line confirmation on the not-enrolled page.
  const disabled = new URL(req.url).searchParams.get("disabled") === "1";
  return htmlResponse(
    renderTwoFactorNotEnrolled({
      csrfToken: csrf.token,
      ...(disabled ? { notice: "Two-factor authentication has been turned off." } : {}),
    }),
    200,
    extra,
  );
}

/**
 * POST /account/2fa — dispatch on `action`.
 */
export async function handleTwoFactorPost(req: Request, deps: TwoFactorDeps): Promise<Response> {
  const got = requireUser(deps, req);
  if ("response" in got) {
    // For a POST without a session, a 302 to /login is fine (browser will
    // follow with the form lost, which is acceptable — re-auth, then retry).
    return got.response;
  }
  const user = got.user;

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

  const action = String(form.get("action") ?? "");

  // --- start: generate a secret, render QR + confirm form ---------------
  if (action === "start") {
    // Refuse to start a fresh enrollment if already enrolled — disenroll
    // first. Prevents accidentally clobbering a working setup.
    if (isTotpEnrolled(deps.db, user.id)) {
      return htmlResponse(
        renderTwoFactorEnrolled({
          csrfToken,
          enrolledAt: getTotpState(deps.db, user.id).enrolledAt,
          backupCodesRemaining: backupCodesRemaining(deps.db, user.id),
          errorMessage: "Two-factor is already enabled. Turn it off first to re-enroll.",
        }),
        409,
      );
    }
    const { secret } = generateTotpSecret(user.username);
    return renderEnrolling(csrfToken, secret, user.username);
  }

  // --- confirm: verify code vs the in-flight secret, persist ------------
  if (action === "confirm") {
    const secret = String(form.get("secret") ?? "");
    const code = String(form.get("code") ?? "");
    // Validate the in-flight secret format before it reaches verifyTotpCode /
    // persistEnrollment (N1 — cheap defense in depth). The secret is a
    // server-minted base32 string round-tripped through a hidden form field;
    // it's session-gated + CSRF'd, but a malformed value (truncated paste,
    // hand-crafted POST) should be rejected explicitly rather than stored.
    // base32 alphabet (A–Z, 2–7) + optional `=` padding, ≥16 chars (our secret
    // is 20 bytes → 32 base32 chars; 16 is a conservative floor).
    if (!secret || !/^[A-Z2-7]+=*$/i.test(secret) || secret.length < 16) {
      // Lost / malformed in-flight secret (stale form, bad paste) — restart.
      return htmlResponse(
        renderTwoFactorNotEnrolled({
          csrfToken,
          errorMessage: "Setup expired. Please start again.",
        }),
        400,
      );
    }
    // Defensive: someone POSTing confirm for an already-enrolled account.
    if (isTotpEnrolled(deps.db, user.id)) {
      return htmlResponse(
        renderTwoFactorEnrolled({
          csrfToken,
          enrolledAt: getTotpState(deps.db, user.id).enrolledAt,
          backupCodesRemaining: backupCodesRemaining(deps.db, user.id),
          errorMessage: "Two-factor is already enabled.",
        }),
        409,
      );
    }
    if (!verifyTotpCode(secret, code)) {
      return renderEnrolling(
        csrfToken,
        secret,
        user.username,
        "That code didn't match. Make sure your device clock is correct and try the current code.",
      );
    }
    const result = await persistEnrollment(
      deps.db,
      user.id,
      secret,
      deps.now ?? (() => new Date()),
    );
    // Show the backup codes ONCE. Setting no-store so the browser doesn't
    // cache the page with the plaintext codes in it.
    return htmlResponse(renderTwoFactorBackupCodes({ codes: result.backupCodes }), 200, {
      "cache-control": "no-store",
    });
  }

  // --- disable: verify current password, clear 2FA ----------------------
  if (action === "disable") {
    if (!isTotpEnrolled(deps.db, user.id)) {
      // Already off — render the not-enrolled page (idempotent).
      return htmlResponse(
        renderTwoFactorNotEnrolled({
          csrfToken,
          notice: "Two-factor authentication is already off.",
        }),
      );
    }
    const password = String(form.get("password") ?? "");
    const state = getTotpState(deps.db, user.id);
    const renderEnrolledError = (msg: string, status: number): Response =>
      htmlResponse(
        renderTwoFactorEnrolled({
          csrfToken,
          enrolledAt: state.enrolledAt,
          backupCodesRemaining: state.backupCodes.length,
          errorMessage: msg,
        }),
        status,
      );
    if (!password) {
      return renderEnrolledError("Enter your current password to turn off two-factor.", 400);
    }
    // Cap before argon2id verify (CPU-DoS guard — same posture as /login).
    if (password.length > PASSWORD_MAX_LEN) {
      return renderEnrolledError(`Password must be ≤ ${PASSWORD_MAX_LEN} characters.`, 413);
    }
    const ok = await verifyPassword(user, password);
    if (!ok) {
      return renderEnrolledError("That password is incorrect.", 401);
    }
    clearEnrollment(deps.db, user.id, deps.now ?? (() => new Date()));
    // Redirect to the GET so a refresh doesn't re-POST. The not-enrolled
    // page renders the success notice via a query flag.
    return redirect("/account/2fa?disabled=1", {
      "cache-control": "no-store",
      "x-secure-context": isHttpsRequest(req) ? "https" : "http",
    });
  }

  return htmlResponse(
    renderAdminError({
      title: "Unknown action",
      message: "That two-factor action isn't recognized. Reload the page and try again.",
    }),
    400,
  );
}
