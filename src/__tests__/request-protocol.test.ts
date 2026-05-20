/**
 * `isHttpsRequest` is the single signal cookie-mint helpers use to
 * decide whether to set the `Secure` attribute. Wrong answer here
 * causes browsers to silently drop cookies on HTTP localhost (Bug 1
 * from the rc.5 fresh-machine test) OR mint Secure-less cookies behind
 * a TLS-terminating reverse proxy (the opposite failure mode).
 *
 * Three signals tested, in priority order: direct URL scheme,
 * X-Forwarded-Proto header, plain HTTP default.
 */
import { describe, expect, test } from "bun:test";
import { isHttpsRequest } from "../request-protocol.ts";

describe("isHttpsRequest", () => {
  test("returns true for https:// request URL", () => {
    expect(isHttpsRequest(new Request("https://hub.example/x"))).toBe(true);
  });

  test("returns false for http:// request URL", () => {
    expect(isHttpsRequest(new Request("http://localhost:1939/x"))).toBe(false);
  });

  test("returns true when X-Forwarded-Proto: https on an http:// request", () => {
    const req = new Request("http://hub.internal/x", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(isHttpsRequest(req)).toBe(true);
  });

  test("returns false when X-Forwarded-Proto: http", () => {
    const req = new Request("http://hub.internal/x", {
      headers: { "x-forwarded-proto": "http" },
    });
    expect(isHttpsRequest(req)).toBe(false);
  });

  test("tolerates uppercase / whitespace / list shape in X-Forwarded-Proto", () => {
    // Some proxies emit `https,http` (chain of two hops) or " HTTPS "
    // with whitespace. The first token is what we honor.
    expect(
      isHttpsRequest(new Request("http://hub/x", { headers: { "x-forwarded-proto": " HTTPS " } })),
    ).toBe(true);
    expect(
      isHttpsRequest(
        new Request("http://hub/x", { headers: { "x-forwarded-proto": "https,http" } }),
      ),
    ).toBe(true);
    expect(
      isHttpsRequest(
        new Request("http://hub/x", { headers: { "x-forwarded-proto": "http,https" } }),
      ),
    ).toBe(false);
  });
});
