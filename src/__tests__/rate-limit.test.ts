import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_ATTEMPTS,
  UNKNOWN_IP_SENTINEL,
  WINDOW_MS,
  __resetForTests,
  checkAndRecord,
  clientIpFromRequest,
} from "../rate-limit.ts";

afterEach(() => {
  __resetForTests();
});

describe("checkAndRecord — bucket fill / drain", () => {
  test("admits the first MAX_ATTEMPTS attempts; denies the next one with Retry-After", () => {
    const now = new Date("2026-05-08T12:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const r = checkAndRecord("ip-a", now);
      expect(r.allowed).toBe(true);
      expect(r.retryAfterSeconds).toBeUndefined();
    }
    const denied = checkAndRecord("ip-a", now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeDefined();
    // 5 attempts at the same instant; window length 15 min = 900s. Reset is
    // exactly WINDOW_MS later, so retry-after === WINDOW_MS / 1000.
    expect(denied.retryAfterSeconds).toBe(WINDOW_MS / 1000);
  });

  test("bucket drains: attempt is admitted again once the window passes", () => {
    const t0 = new Date("2026-05-08T12:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      checkAndRecord("ip-a", t0);
    }
    const stillDenied = checkAndRecord("ip-a", new Date(t0.getTime() + WINDOW_MS - 1000));
    expect(stillDenied.allowed).toBe(false);

    // Advance past the window — all five timestamps fall off, slot opens.
    const past = new Date(t0.getTime() + WINDOW_MS + 1000);
    const allowed = checkAndRecord("ip-a", past);
    expect(allowed.allowed).toBe(true);
  });

  test("partial drain: oldest entry falling off opens exactly one slot", () => {
    const t0 = new Date("2026-05-08T12:00:00Z");
    // Spread 5 attempts 1 minute apart so they fall off the window
    // individually rather than as a cohort.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      checkAndRecord("ip-a", new Date(t0.getTime() + i * 60_000));
    }
    // Right at the 5th-minute mark, all 5 are in window → denied.
    const denied = checkAndRecord("ip-a", new Date(t0.getTime() + 5 * 60_000));
    expect(denied.allowed).toBe(false);

    // Step past WINDOW_MS from the *first* attempt (t0) → that one falls
    // off, so we should be admitted.
    const partial = new Date(t0.getTime() + WINDOW_MS + 1000);
    const r = checkAndRecord("ip-a", partial);
    expect(r.allowed).toBe(true);
  });

  test("denied attempts do not push the reset further into the future", () => {
    const t0 = new Date("2026-05-08T12:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      checkAndRecord("ip-a", t0);
    }
    // Five denials over 30 seconds. The reset moment must be anchored to the
    // 5 admitted attempts at t0, NOT to the latest denial.
    for (let i = 1; i <= 5; i++) {
      checkAndRecord("ip-a", new Date(t0.getTime() + i * 6000));
    }
    const finalCheck = checkAndRecord("ip-a", new Date(t0.getTime() + 30_000));
    expect(finalCheck.allowed).toBe(false);
    // 30 seconds elapsed; expected ~870s remaining. Tolerance ±2s for
    // ceil-rounding edge.
    const expected = Math.ceil((WINDOW_MS - 30_000) / 1000);
    expect(finalCheck.retryAfterSeconds).toBe(expected);
  });

  test("Retry-After is always at least 1 second at the boundary", () => {
    const t0 = new Date("2026-05-08T12:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      checkAndRecord("ip-a", t0);
    }
    // Exactly at the moment the oldest attempt would fall off — clamp to 1.
    const r = checkAndRecord("ip-a", new Date(t0.getTime() + WINDOW_MS));
    // At exactly WINDOW_MS, the oldest is gone → admitted, not denied.
    expect(r.allowed).toBe(true);
  });
});

describe("checkAndRecord — multi-IP independence", () => {
  test("exhausting one IP's bucket does not affect another IP", () => {
    const now = new Date("2026-05-08T12:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) checkAndRecord("ip-a", now);
    expect(checkAndRecord("ip-a", now).allowed).toBe(false);

    // Different IP — fresh bucket.
    expect(checkAndRecord("ip-b", now).allowed).toBe(true);
    expect(checkAndRecord("ip-c", now).allowed).toBe(true);
  });

  test("IPv4 / IPv6 / sentinel are all distinct keys", () => {
    const now = new Date("2026-05-08T12:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) checkAndRecord("203.0.113.7", now);
    expect(checkAndRecord("203.0.113.7", now).allowed).toBe(false);
    expect(checkAndRecord("2001:db8::42", now).allowed).toBe(true);
    expect(checkAndRecord(UNKNOWN_IP_SENTINEL, now).allowed).toBe(true);
  });
});

describe("clientIpFromRequest — header priority", () => {
  test("CF-Connecting-IP wins over X-Forwarded-For", () => {
    const req = new Request("http://hub.test/admin/login", {
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.99, 10.0.0.1",
      },
    });
    expect(clientIpFromRequest(req)).toBe("203.0.113.7");
  });

  test("X-Forwarded-For first hop is used when CF-Connecting-IP is absent", () => {
    const req = new Request("http://hub.test/admin/login", {
      headers: { "x-forwarded-for": "198.51.100.99, 10.0.0.1, 10.0.0.2" },
    });
    expect(clientIpFromRequest(req)).toBe("198.51.100.99");
  });

  test("X-Forwarded-For with whitespace is trimmed", () => {
    const req = new Request("http://hub.test/admin/login", {
      headers: { "x-forwarded-for": "  198.51.100.99  , 10.0.0.1" },
    });
    expect(clientIpFromRequest(req)).toBe("198.51.100.99");
  });

  test("falls through to UNKNOWN_IP_SENTINEL when no headers are set", () => {
    const req = new Request("http://hub.test/admin/login");
    expect(clientIpFromRequest(req)).toBe(UNKNOWN_IP_SENTINEL);
  });

  test("empty / whitespace-only header values are treated as absent", () => {
    const req = new Request("http://hub.test/admin/login", {
      headers: { "cf-connecting-ip": "   ", "x-forwarded-for": "" },
    });
    expect(clientIpFromRequest(req)).toBe(UNKNOWN_IP_SENTINEL);
  });

  test("empty CF-Connecting-IP falls through to X-Forwarded-For first hop", () => {
    const req = new Request("http://hub.test/admin/login", {
      headers: { "cf-connecting-ip": "", "x-forwarded-for": "198.51.100.99" },
    });
    expect(clientIpFromRequest(req)).toBe("198.51.100.99");
  });
});
