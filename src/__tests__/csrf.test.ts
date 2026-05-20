import { describe, expect, test } from "bun:test";
import {
  CSRF_COOKIE_NAME,
  CSRF_FIELD_NAME,
  buildCsrfCookie,
  ensureCsrfToken,
  generateCsrfToken,
  parseCsrfCookie,
  renderCsrfHiddenInput,
  verifyCsrfToken,
} from "../csrf.ts";

function reqWith(cookie: string | null, formToken?: string | null): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set("cookie", cookie);
  return new Request("https://hub.example/oauth/authorize", { headers });
}

describe("generateCsrfToken", () => {
  test("returns a base64url string with > 32 chars of entropy", () => {
    const token = generateCsrfToken();
    expect(token.length).toBeGreaterThan(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("two calls produce distinct tokens", () => {
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });
});

describe("buildCsrfCookie", () => {
  test("emits the expected attributes (default secure)", () => {
    const v = buildCsrfCookie("abc");
    expect(v).toContain(`${CSRF_COOKIE_NAME}=abc`);
    expect(v).toContain("HttpOnly");
    expect(v).toContain("Secure");
    expect(v).toContain("SameSite=Lax");
    expect(v).toContain("Path=/");
    expect(v).toContain("Max-Age=");
  });

  test("omits Secure when secure: false (HTTP localhost)", () => {
    const v = buildCsrfCookie("abc", { secure: false });
    expect(v).toContain(`${CSRF_COOKIE_NAME}=abc`);
    expect(v).toContain("HttpOnly");
    expect(v).not.toContain("Secure");
    expect(v).toContain("SameSite=Lax");
  });

  test("keeps Secure when secure: true (explicit)", () => {
    const v = buildCsrfCookie("abc", { secure: true });
    expect(v).toContain("Secure");
  });
});

describe("parseCsrfCookie", () => {
  test("extracts the token from a cookie header", () => {
    expect(parseCsrfCookie(`${CSRF_COOKIE_NAME}=xyz`)).toBe("xyz");
    expect(parseCsrfCookie(`other=foo; ${CSRF_COOKIE_NAME}=xyz; bar=baz`)).toBe("xyz");
  });

  test("returns null when absent or empty", () => {
    expect(parseCsrfCookie(null)).toBeNull();
    expect(parseCsrfCookie("")).toBeNull();
    expect(parseCsrfCookie("other=foo")).toBeNull();
  });
});

describe("ensureCsrfToken", () => {
  test("mints a fresh cookie when none is present", () => {
    const result = ensureCsrfToken(reqWith(null));
    expect(result.token.length).toBeGreaterThan(32);
    expect(result.setCookie).toContain(`${CSRF_COOKIE_NAME}=${result.token}`);
  });

  test("reuses the existing cookie token without re-setting", () => {
    const result = ensureCsrfToken(reqWith(`${CSRF_COOKIE_NAME}=existing-token`));
    expect(result.token).toBe("existing-token");
    expect(result.setCookie).toBeUndefined();
  });

  test("mints fresh when the cookie is empty", () => {
    const result = ensureCsrfToken(reqWith(`${CSRF_COOKIE_NAME}=`));
    expect(result.token.length).toBeGreaterThan(0);
    expect(result.setCookie).toBeDefined();
  });

  // Bug 1 (rc.5 → rc.6) regression: cookies minted over plain HTTP must
  // NOT carry the Secure attribute or browsers silently drop them on
  // http://localhost:1939, breaking the very next double-submit POST.
  test("sets Secure when the request URL is https://", () => {
    const req = new Request("https://hub.example/admin/setup");
    const result = ensureCsrfToken(req);
    expect(result.setCookie).toContain("Secure");
  });

  test("omits Secure when the request URL is http://localhost", () => {
    const req = new Request("http://localhost:1939/admin/setup");
    const result = ensureCsrfToken(req);
    expect(result.setCookie).not.toContain("Secure");
    // The rest of the cookie shape stays intact — only Secure flips.
    expect(result.setCookie).toContain("HttpOnly");
    expect(result.setCookie).toContain("SameSite=Lax");
  });

  test("sets Secure when http:// request carries X-Forwarded-Proto: https", () => {
    const req = new Request("http://hub.internal/admin/setup", {
      headers: { "x-forwarded-proto": "https" },
    });
    const result = ensureCsrfToken(req);
    expect(result.setCookie).toContain("Secure");
  });
});

describe("verifyCsrfToken", () => {
  test("returns true when cookie and form match", () => {
    const token = "match-me";
    const req = reqWith(`${CSRF_COOKIE_NAME}=${token}`);
    expect(verifyCsrfToken(req, token)).toBe(true);
  });

  test("returns false when the form token differs", () => {
    const req = reqWith(`${CSRF_COOKIE_NAME}=cookie-token`);
    expect(verifyCsrfToken(req, "form-token")).toBe(false);
  });

  test("returns false when cookie token is missing", () => {
    expect(verifyCsrfToken(reqWith(null), "form-token")).toBe(false);
  });

  test("returns false when form token is missing", () => {
    const req = reqWith(`${CSRF_COOKIE_NAME}=cookie-token`);
    expect(verifyCsrfToken(req, null)).toBe(false);
  });

  test("returns false when lengths differ (avoids timingSafeEqual throw)", () => {
    const req = reqWith(`${CSRF_COOKIE_NAME}=abcd`);
    expect(verifyCsrfToken(req, "abcdef")).toBe(false);
  });
});

describe("renderCsrfHiddenInput", () => {
  test("renders an HTML hidden input with the field name", () => {
    const html = renderCsrfHiddenInput("token-123");
    expect(html).toContain(`name="${CSRF_FIELD_NAME}"`);
    expect(html).toContain('value="token-123"');
    expect(html).toContain('type="hidden"');
  });

  test("escapes hostile token content into the value attribute", () => {
    const html = renderCsrfHiddenInput(`"><script>alert(1)</script>`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;");
    expect(html).toContain("&lt;script");
  });
});
