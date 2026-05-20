/**
 * CSRF protection for state-changing admin POSTs (login, consent, and any
 * future admin form mounted off `/`).
 *
 * Pattern: double-submit cookie. On every GET that renders a form, we ensure
 * a `parachute_hub_csrf` cookie exists (lazily generated, then reused for the
 * cookie's lifetime) and embed the same value as a hidden `__csrf` input in
 * the form. On POST, we compare the form-submitted token to the cookie value
 * via constant-time compare; mismatch = 400 Bad Request. We pick 400 over 403
 * because the failure mode is a malformed/stale form (the operator's tab sat
 * past cookie expiry, two tabs raced, or the form was hand-rolled), not an
 * authorization failure — they're already authenticated; the *form* is what
 * the server can't accept. All callers (admin login, admin config, OAuth
 * authorize) agree on 400.
 *
 * Why this and not session-bound tokens? Login forms are submitted *before*
 * a session exists, so a session-bound CSRF would need a separate "pre-login"
 * track anyway. Double-submit is uniform across both — same helper handles
 * pre-login and post-login forms, and it works no matter how many tabs the
 * operator has open.
 *
 * The cookie is HttpOnly: consumers receive the token value via either the
 * server-rendered HTML form (cookie + embedded value, classic double-submit)
 * or via the JSON body of `/api/me` (cookie alongside body — same pattern,
 * just JSON instead of HTML). Neither path needs JS to read the cookie
 * directly. SameSite=Lax (matches the session cookie), Secure conditional
 * on the request protocol (see below), and Path=/ (covers every admin
 * form, OAuth flow, and `/api/me` consumer).
 *
 * `Secure` is set when the request arrived over HTTPS (direct or behind a
 * reverse proxy that set `X-Forwarded-Proto: https`) — `isHttpsRequest` in
 * `request-protocol.ts` is the single source of truth. On
 * `http://localhost:1939` the attribute is omitted so the browser actually
 * keeps the cookie; setting `Secure` unconditionally silently drops it on
 * HTTP and breaks the double-submit handshake on the very next POST
 * ("Invalid form submission" page on the wizard, etc.).
 *
 * Token entropy: 32 random bytes, base64url-encoded — same shape as session
 * IDs. No HMAC needed: the value is opaque to the client and only ever
 * compared to itself across the cookie/form boundary.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isHttpsRequest } from "./request-protocol.ts";

export const CSRF_COOKIE_NAME = "parachute_hub_csrf";
export const CSRF_FIELD_NAME = "__csrf";
/** 30 days. Cookie outlives the 24h session by design — closing the OAuth
 * tab and reopening it later shouldn't force a re-mint of the CSRF token. */
export const CSRF_TTL_SECONDS = 30 * 24 * 60 * 60;

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Build a Set-Cookie header value for a CSRF token. `secure` defaults to
 * true (the production posture behind a TLS terminator); callers that
 * mint the cookie for a known-HTTP request — `ensureCsrfToken` does
 * this via `isHttpsRequest` — pass `secure: false` to omit the
 * attribute so the browser keeps the cookie on plain HTTP.
 */
export function buildCsrfCookie(token: string, opts: { secure?: boolean } = {}): string {
  const parts = [`${CSRF_COOKIE_NAME}=${token}`, "HttpOnly"];
  if (opts.secure !== false) parts.push("Secure");
  parts.push("SameSite=Lax", "Path=/", `Max-Age=${CSRF_TTL_SECONDS}`);
  return parts.join("; ");
}

export function parseCsrfCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CSRF_COOKIE_NAME) return rest.join("=");
  }
  return null;
}

export interface EnsuredCsrf {
  token: string;
  /** Set when the caller must include this Set-Cookie on the response. */
  setCookie?: string;
}

/**
 * Ensure the request carries a CSRF token cookie; mint and return one if not.
 * Callers embed `result.token` in the rendered form and attach
 * `result.setCookie` (if defined) to the response.
 *
 * Protocol-aware: when the request is plain HTTP (`http://localhost:1939`
 * during local dev / on-box CLI), the minted cookie omits the `Secure`
 * attribute so the browser keeps it. When the request is HTTPS (or
 * forwarded via `X-Forwarded-Proto: https`), `Secure` is set.
 */
export function ensureCsrfToken(req: Request): EnsuredCsrf {
  const existing = parseCsrfCookie(req.headers.get("cookie"));
  if (existing && existing.length > 0) return { token: existing };
  const token = generateCsrfToken();
  return { token, setCookie: buildCsrfCookie(token, { secure: isHttpsRequest(req) }) };
}

/**
 * Verify that a form-submitted CSRF token matches the cookie token via
 * constant-time compare. Both must be present and equal.
 */
export function verifyCsrfToken(req: Request, formToken: string | null): boolean {
  const cookieToken = parseCsrfCookie(req.headers.get("cookie"));
  if (!cookieToken || !formToken) return false;
  if (cookieToken.length !== formToken.length) return false;
  try {
    return timingSafeEqual(Buffer.from(cookieToken), Buffer.from(formToken));
  } catch {
    return false;
  }
}

export function renderCsrfHiddenInput(token: string): string {
  return `<input type="hidden" name="${CSRF_FIELD_NAME}" value="${escapeAttr(token)}" />`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
