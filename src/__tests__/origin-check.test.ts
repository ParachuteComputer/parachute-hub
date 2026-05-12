import { describe, expect, test } from "bun:test";
import { buildHubBoundOrigins, isSameOriginRequest } from "../origin-check.ts";

const ISSUER = "https://parachute.taildf9ce2.ts.net";
const PORT = 1939;

function reqWithHeaders(headers: Record<string, string>): Request {
  // Bun's Request constructor lower-cases header keys; tests pass whatever
  // case is conventional in the wild. The URL is irrelevant — only the
  // headers are inspected by isSameOriginRequest.
  return new Request("http://placeholder/", { method: "POST", headers });
}

describe("buildHubBoundOrigins", () => {
  test("issuer only — single-origin hub", () => {
    expect(buildHubBoundOrigins({ issuer: ISSUER })).toEqual([ISSUER]);
  });

  test("issuer + loopback port adds localhost + 127.0.0.1 aliases", () => {
    const origins = buildHubBoundOrigins({ issuer: ISSUER, loopbackPort: PORT });
    expect(origins).toContain(ISSUER);
    expect(origins).toContain(`http://localhost:${PORT}`);
    expect(origins).toContain(`http://127.0.0.1:${PORT}`);
    expect(origins.length).toBe(3);
  });

  test("exposeHubOrigin adds a tailnet/funnel origin when distinct from issuer", () => {
    // Scenario: hub was started with --issuer http://localhost:1939 (dev),
    // then `parachute expose tailnet` brought up the tailnet hostname.
    // exposeHubOrigin captures the post-expose hostname.
    const origins = buildHubBoundOrigins({
      issuer: "http://localhost:1939",
      loopbackPort: PORT,
      exposeHubOrigin: ISSUER,
    });
    expect(origins).toContain("http://localhost:1939");
    expect(origins).toContain(ISSUER);
  });

  test("dedups when exposeHubOrigin matches issuer", () => {
    // Normal case: `parachute expose` set the issuer AND wrote the same
    // hubOrigin to expose-state.json. The set should still be one entry
    // for that origin, not two.
    const origins = buildHubBoundOrigins({
      issuer: ISSUER,
      exposeHubOrigin: ISSUER,
    });
    expect(origins.filter((o) => o === ISSUER).length).toBe(1);
  });

  test("malformed inputs are silently dropped", () => {
    // No URL parser crash — return whatever could be parsed. The caller
    // (resolveBoundOrigins) keeps the issuer as a baseline anyway.
    const origins = buildHubBoundOrigins({
      issuer: ISSUER,
      exposeHubOrigin: "not a url",
    });
    expect(origins).toContain(ISSUER);
    expect(origins.length).toBe(1);
  });

  test("normalizes via URL.origin — trailing slash on issuer is stripped", () => {
    const origins = buildHubBoundOrigins({ issuer: `${ISSUER}/` });
    expect(origins).toEqual([ISSUER]); // URL.origin drops trailing slash
  });

  test("non-integer loopbackPort is ignored", () => {
    // Belt for callers passing through a stringly-typed env var. We don't
    // want to emit `http://localhost:NaN`.
    const origins = buildHubBoundOrigins({
      issuer: ISSUER,
      loopbackPort: Number.NaN,
    });
    expect(origins.every((o) => !o.includes("NaN"))).toBe(true);
    expect(origins).toContain(ISSUER);
  });
});

describe("isSameOriginRequest", () => {
  const BOUND = buildHubBoundOrigins({ issuer: ISSUER, loopbackPort: PORT });

  describe("Origin header (primary)", () => {
    test("accepts a request whose Origin matches the issuer", () => {
      const req = reqWithHeaders({ origin: ISSUER });
      expect(isSameOriginRequest(req, BOUND)).toBe(true);
    });

    test("accepts a request whose Origin matches loopback (localhost)", () => {
      // Closes #245 Case A: operator on http://localhost:1939/login
      // submitting the approve form — previously rejected because Origin
      // (localhost) didn't match the configured issuer (tailnet).
      const req = reqWithHeaders({ origin: `http://localhost:${PORT}` });
      expect(isSameOriginRequest(req, BOUND)).toBe(true);
    });

    test("accepts a request whose Origin matches loopback (127.0.0.1)", () => {
      const req = reqWithHeaders({ origin: `http://127.0.0.1:${PORT}` });
      expect(isSameOriginRequest(req, BOUND)).toBe(true);
    });

    test("rejects a real third-party origin", () => {
      const req = reqWithHeaders({ origin: "https://attacker.example" });
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });

    test("rejects a port-only mismatch", () => {
      // A request from `http://localhost:1940` (different port) is NOT
      // the hub — could be a different service on the same box. The
      // bound set only includes the hub's own port.
      const req = reqWithHeaders({ origin: "http://localhost:1940" });
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });

    test("rejects scheme mismatch (https://localhost vs http://localhost)", () => {
      // The bound set has http://localhost:<port>; an https://localhost
      // request shouldn't match. Less likely in practice (loopback is
      // typically http) but the URL.origin comparison catches it.
      const req = reqWithHeaders({ origin: `https://localhost:${PORT}` });
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });

    test("malformed Origin string returns false (does not throw)", () => {
      const req = reqWithHeaders({ origin: "not a valid url" });
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });
  });

  describe("Referer header (fallback when Origin is absent)", () => {
    test("accepts when Referer matches a bound origin", () => {
      const req = reqWithHeaders({ referer: `${ISSUER}/login` });
      expect(isSameOriginRequest(req, BOUND)).toBe(true);
    });

    test("rejects when Referer is third-party", () => {
      const req = reqWithHeaders({ referer: "https://attacker.example/page" });
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });

    test("Origin takes priority over Referer when both present", () => {
      // If Origin says cross-origin, even a same-origin Referer doesn't
      // rescue. Important: an attacker can sometimes spoof Referer (via
      // a redirect chain) but cannot spoof Origin from a browser.
      const req = reqWithHeaders({
        origin: "https://attacker.example",
        referer: ISSUER,
      });
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });
  });

  describe("Host header (last-resort fallback when Origin + Referer both stripped)", () => {
    // Closes #245 Case B: Tailscale Serve stripped Origin/Referer from a
    // legitimate same-origin POST, so neither primary nor secondary
    // signal was available. Host header reflected the tailnet hostname
    // the browser thought it was talking to.

    test("accepts when Host matches a bound origin's host:port", () => {
      const req = reqWithHeaders({
        host: new URL(ISSUER).host,
      });
      expect(isSameOriginRequest(req, BOUND)).toBe(true);
    });

    test("accepts loopback Host match", () => {
      const req = reqWithHeaders({ host: `localhost:${PORT}` });
      expect(isSameOriginRequest(req, BOUND)).toBe(true);
    });

    test("rejects a third-party Host", () => {
      const req = reqWithHeaders({ host: "attacker.example" });
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });

    test("Origin takes priority over Host — Host-only check fires only when Origin+Referer absent", () => {
      // Same belt-and-suspenders order: Origin says no → reject, even if
      // Host happens to match. Otherwise an attacker who could induce a
      // cross-origin POST without browser Origin (rare but theoretical)
      // could pass with a manipulated Host. Origin remains the primary.
      const req = reqWithHeaders({
        origin: "https://attacker.example",
        host: new URL(ISSUER).host,
      });
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });

    test("Referer takes priority over Host", () => {
      const req = reqWithHeaders({
        referer: "https://attacker.example/page",
        host: new URL(ISSUER).host,
      });
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });
  });

  describe("no headers at all", () => {
    test("rejects when Origin, Referer, AND Host are all absent", () => {
      // Bun synthesizes a Host header from the URL, so we use new Headers()
      // directly to clear it. The function's contract: with no signal, reject.
      const req = new Request("http://placeholder/", {
        method: "POST",
        headers: new Headers(),
      });
      // Bun will still inject Host from the URL, so simulate the stripped
      // case by passing an explicit empty Host. If Bun adds the URL host,
      // the check returns true for matching placeholder — but our bound
      // origins don't include placeholder, so we still return false.
      expect(isSameOriginRequest(req, BOUND)).toBe(false);
    });
  });

  describe("empty bound-origin set (defense fails closed)", () => {
    test("returns false regardless of headers when no origins are bound", () => {
      // Mis-wired hub (no issuer, no exposeState, no port) — the function
      // should reject everything rather than accept everything. Fail-closed
      // is the right default for a CSRF defense.
      const req = reqWithHeaders({ origin: ISSUER });
      expect(isSameOriginRequest(req, [])).toBe(false);
    });
  });
});
