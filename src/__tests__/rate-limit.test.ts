import { afterEach, describe, expect, test } from "bun:test";
import {
  AUTH_IP_CEILING_MAX_ATTEMPTS,
  CHANGE_PASSWORD_MAX_ATTEMPTS,
  CHANGE_PASSWORD_WINDOW_MS,
  MAX_ATTEMPTS,
  RateLimiter,
  UNKNOWN_IP_SENTINEL,
  WINDOW_MS,
  __resetForTests,
  authIpCeilingRateLimiter,
  changePasswordRateLimiter,
  checkAndRecord,
  clientIpFromRequest,
  compositeKey,
  loginRateLimiter,
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

  test("Retry-After natural value is always >= 1 in the deny branch (1ms-remaining case)", () => {
    // The `Math.max(1, ...)` clamp at rate-limit.ts:90 is defense-in-depth:
    // the deny branch requires `pruned.length >= MAX_ATTEMPTS`, which means
    // every retained timestamp is strictly inside the window, so
    // `resetAtMs - now > 0` strictly, so `Math.ceil(positive / 1000) >= 1`.
    // This test pins that invariant: at `WINDOW_MS - 1ms` after the cohort,
    // 1ms remains until the oldest falls off → unclamped value is
    // `Math.ceil(1 / 1000) = 1`, the minimum natural value.
    const t0 = new Date("2026-05-08T12:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      checkAndRecord("ip-a", t0);
    }
    const denied = checkAndRecord("ip-a", new Date(t0.getTime() + WINDOW_MS - 1));
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(1);
  });

  test("Retry-After is >= 1 across every denied step from t0 to the boundary", () => {
    // Belt-and-suspenders sweep: walk `now` from t0 up to (but not including)
    // the boundary in 100ms steps and assert every denied response has
    // `retryAfterSeconds >= 1`. Locks in the "natural value never drops to
    // zero in the deny branch" invariant the clamp guards.
    const t0 = new Date("2026-05-08T12:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      checkAndRecord("ip-a", t0);
    }
    for (let dt = 0; dt < WINDOW_MS; dt += 100) {
      const r = checkAndRecord("ip-a", new Date(t0.getTime() + dt));
      expect(r.allowed).toBe(false);
      expect(r.retryAfterSeconds).toBeDefined();
      expect(r.retryAfterSeconds as number).toBeGreaterThanOrEqual(1);
    }
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

// hub#282 — `RateLimiter` is a class so each auth surface can pick its
// own capacity / window. Pin the per-instance shape (independent buckets,
// independent reset, configurable thresholds) so a future call site that
// instantiates a third limiter inherits a known-good contract.
describe("RateLimiter — class with per-instance capacity and window", () => {
  test("respects the constructor's maxAttempts (cap=3)", () => {
    const rl = new RateLimiter(3, 60_000);
    const now = new Date("2026-05-22T12:00:00Z");
    for (let i = 0; i < 3; i++) {
      expect(rl.checkAndRecord("user-a", now).allowed).toBe(true);
    }
    const denied = rl.checkAndRecord("user-a", now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(60);
  });

  test("respects the constructor's windowMs (5min)", () => {
    const windowMs = 5 * 60 * 1000;
    const rl = new RateLimiter(3, windowMs);
    const t0 = new Date("2026-05-22T12:00:00Z");
    for (let i = 0; i < 3; i++) rl.checkAndRecord("user-a", t0);
    const denied = rl.checkAndRecord("user-a", t0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(windowMs / 1000);
    // Past the window, bucket drains.
    expect(rl.checkAndRecord("user-a", new Date(t0.getTime() + windowMs + 1000)).allowed).toBe(
      true,
    );
  });

  test("two instances have independent bucket maps", () => {
    const rlA = new RateLimiter(2, 60_000);
    const rlB = new RateLimiter(2, 60_000);
    const now = new Date("2026-05-22T12:00:00Z");
    // Fill rlA's bucket for key "x".
    expect(rlA.checkAndRecord("x", now).allowed).toBe(true);
    expect(rlA.checkAndRecord("x", now).allowed).toBe(true);
    expect(rlA.checkAndRecord("x", now).allowed).toBe(false);
    // rlB's "x" key is untouched.
    expect(rlB.checkAndRecord("x", now).allowed).toBe(true);
    expect(rlB.checkAndRecord("x", now).allowed).toBe(true);
  });

  test("reset() clears just this instance's buckets", () => {
    const rlA = new RateLimiter(1, 60_000);
    const rlB = new RateLimiter(1, 60_000);
    const now = new Date("2026-05-22T12:00:00Z");
    rlA.checkAndRecord("x", now);
    rlB.checkAndRecord("x", now);
    expect(rlA.checkAndRecord("x", now).allowed).toBe(false);
    expect(rlB.checkAndRecord("x", now).allowed).toBe(false);
    rlA.reset();
    // rlA's "x" is allowed again; rlB's "x" is still denied.
    expect(rlA.checkAndRecord("x", now).allowed).toBe(true);
    expect(rlB.checkAndRecord("x", now).allowed).toBe(false);
  });
});

// hub#282 — the `changePasswordRateLimiter` singleton. Pin its
// configured thresholds (3 attempts / 5 min) so a refactor that
// accidentally widens them surfaces here.
describe("changePasswordRateLimiter — tighter floor for /account/change-password", () => {
  // Reset the singleton between tests so the assertions on which
  // attempts succeed / fail aren't sensitive to prior-test leakage.
  // The shared `__resetForTests` at the top of the file already covers
  // this (it resets both singletons), but make the local intent
  // explicit.
  afterEach(() => {
    changePasswordRateLimiter.reset();
  });

  test("admits CHANGE_PASSWORD_MAX_ATTEMPTS, then denies", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    for (let i = 0; i < CHANGE_PASSWORD_MAX_ATTEMPTS; i++) {
      expect(changePasswordRateLimiter.checkAndRecord("user-a", now).allowed).toBe(true);
    }
    const denied = changePasswordRateLimiter.checkAndRecord("user-a", now);
    expect(denied.allowed).toBe(false);
    // Same instant → reset is exactly one window away.
    expect(denied.retryAfterSeconds).toBe(CHANGE_PASSWORD_WINDOW_MS / 1000);
  });

  test("keyed independently by user-id (one user's exhausted bucket doesn't affect another)", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    for (let i = 0; i < CHANGE_PASSWORD_MAX_ATTEMPTS; i++) {
      changePasswordRateLimiter.checkAndRecord("user-a", now);
    }
    expect(changePasswordRateLimiter.checkAndRecord("user-a", now).allowed).toBe(false);
    expect(changePasswordRateLimiter.checkAndRecord("user-b", now).allowed).toBe(true);
  });

  test("CHANGE_PASSWORD limits are tighter than /login limits", () => {
    // Sanity check that the constants stay in their intended relationship.
    // If a future PR loosens change-password to match /login, this test
    // surfaces the change and forces a design-doc update.
    expect(CHANGE_PASSWORD_MAX_ATTEMPTS).toBeLessThan(MAX_ATTEMPTS);
    expect(CHANGE_PASSWORD_WINDOW_MS).toBeLessThan(WINDOW_MS);
  });

  test("`__resetForTests` clears the change-password singleton too", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    for (let i = 0; i < CHANGE_PASSWORD_MAX_ATTEMPTS; i++) {
      changePasswordRateLimiter.checkAndRecord("user-a", now);
    }
    expect(changePasswordRateLimiter.checkAndRecord("user-a", now).allowed).toBe(false);
    __resetForTests();
    expect(changePasswordRateLimiter.checkAndRecord("user-a", now).allowed).toBe(true);
  });
});

// The shared-egress-IP fix: the per-account FLOOR is now keyed by
// `compositeKey(ip, identity)` so a room of users behind ONE NAT'd /
// Cloudflare egress IP doesn't pool into one 5-slot bucket. A coarse per-IP
// CEILING (60/15min) backstops username-rotation across the floors.
describe("compositeKey + shared-egress-IP login floor", () => {
  test("normalizes identity: trims + lowercases so casing/whitespace share a bucket", () => {
    expect(compositeKey("1.2.3.4", "Alice")).toBe("1.2.3.4|alice");
    expect(compositeKey("1.2.3.4", "  ALICE  ")).toBe("1.2.3.4|alice");
    // Case-flip evasion is closed: 'Alice' and 'alice' resolve to one key.
    expect(compositeKey("1.2.3.4", "Alice")).toBe(compositeKey("1.2.3.4", "alice"));
  });

  // (a) REGRESSION: two distinct usernames from the SAME ip each get a full
  // independent 5/15min floor (the shared-wifi bug). Before the fix both would
  // have pooled into one per-IP bucket and the second user's 1st attempt would
  // have been the 6th overall → 429.
  test("(a) two usernames from the same IP each get an independent 5/15min floor", () => {
    const ip = "203.0.113.7";
    const now = new Date("2026-06-25T12:00:00Z");
    // Alice exhausts her floor.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(loginRateLimiter.checkAndRecord(compositeKey(ip, "alice"), now).allowed).toBe(true);
    }
    expect(loginRateLimiter.checkAndRecord(compositeKey(ip, "alice"), now).allowed).toBe(false);
    // Bob (same IP, different username) still has a fresh full floor.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(loginRateLimiter.checkAndRecord(compositeKey(ip, "bob"), now).allowed).toBe(true);
    }
    expect(loginRateLimiter.checkAndRecord(compositeKey(ip, "bob"), now).allowed).toBe(false);
  });

  // (b) a single (ip,username) still denies on the 6th attempt.
  test("(b) a single (ip,username) still denies on the 6th attempt", () => {
    const ip = "203.0.113.7";
    const now = new Date("2026-06-25T12:00:00Z");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      expect(loginRateLimiter.checkAndRecord(compositeKey(ip, "alice"), now).allowed).toBe(true);
    }
    const denied = loginRateLimiter.checkAndRecord(compositeKey(ip, "alice"), now);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(WINDOW_MS / 1000);
  });

  // (c) the per-IP ceiling denies on the 61st attempt from one IP even across
  // rotated usernames (each username's own floor never trips because each only
  // sees one attempt, but the coarse ceiling caps total per-IP volume).
  test("(c) per-IP ceiling denies the 61st attempt across rotated usernames", () => {
    const ip = "203.0.113.7";
    const now = new Date("2026-06-25T12:00:00Z");
    for (let i = 0; i < AUTH_IP_CEILING_MAX_ATTEMPTS; i++) {
      // Rotate a fresh username every attempt so no per-account floor ever fills.
      expect(loginRateLimiter.checkAndRecord(compositeKey(ip, `u${i}`), now).allowed).toBe(true);
      expect(authIpCeilingRateLimiter.checkAndRecord(ip, now).allowed).toBe(true);
    }
    // 61st attempt: a brand-new username (floor is fresh) but the ceiling is full.
    expect(loginRateLimiter.checkAndRecord(compositeKey(ip, "u60"), now).allowed).toBe(true);
    const ceilingDenied = authIpCeilingRateLimiter.checkAndRecord(ip, now);
    expect(ceilingDenied.allowed).toBe(false);
    expect(ceilingDenied.retryAfterSeconds).toBe(WINDOW_MS / 1000);
  });

  test("the ceiling is per-IP: a different IP is unaffected by another's full ceiling", () => {
    const now = new Date("2026-06-25T12:00:00Z");
    for (let i = 0; i < AUTH_IP_CEILING_MAX_ATTEMPTS; i++) {
      authIpCeilingRateLimiter.checkAndRecord("203.0.113.7", now);
    }
    expect(authIpCeilingRateLimiter.checkAndRecord("203.0.113.7", now).allowed).toBe(false);
    expect(authIpCeilingRateLimiter.checkAndRecord("198.51.100.99", now).allowed).toBe(true);
  });

  test("ceiling matches the signup precedent (60) and `__resetForTests` clears it", () => {
    expect(AUTH_IP_CEILING_MAX_ATTEMPTS).toBe(60);
    const now = new Date("2026-06-25T12:00:00Z");
    for (let i = 0; i < AUTH_IP_CEILING_MAX_ATTEMPTS; i++) {
      authIpCeilingRateLimiter.checkAndRecord("203.0.113.7", now);
    }
    expect(authIpCeilingRateLimiter.checkAndRecord("203.0.113.7", now).allowed).toBe(false);
    __resetForTests();
    expect(authIpCeilingRateLimiter.checkAndRecord("203.0.113.7", now).allowed).toBe(true);
  });
});
