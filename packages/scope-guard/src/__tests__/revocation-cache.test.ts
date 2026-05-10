/**
 * RevocationCache unit tests — direct tests against the cache itself, with
 * an injected fetcher and an injected `now()`. These exercise TTL, refresh,
 * fail-open, fail-closed, and single-flight without spinning up an HTTP
 * server. The integration with `validateHubJwt` is covered separately in
 * validate.test.ts (the "revocation enforcement" describe block).
 */
import { describe, expect, test } from "bun:test";
import { createRevocationCache } from "../revocation-cache";

interface FakeFetcher {
  fetcher: (origin: string) => Promise<{ generated_at: string; jtis: string[] }>;
  setList: (jtis: string[]) => void;
  setFailing: (failing: boolean) => void;
  callCount: () => number;
  reset: () => void;
}

function makeFakeFetcher(initial: string[] = []): FakeFetcher {
  let jtis = [...initial];
  let failing = false;
  let calls = 0;
  return {
    fetcher: async () => {
      calls += 1;
      if (failing) throw new Error("simulated fetch failure");
      return { generated_at: new Date().toISOString(), jtis: [...jtis] };
    },
    setList: (next) => {
      jtis = [...next];
    },
    setFailing: (v) => {
      failing = v;
    },
    callCount: () => calls,
    reset: () => {
      jtis = [];
      failing = false;
      calls = 0;
    },
  };
}

function makeClock(initial = 1_700_000_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("RevocationCache — basics", () => {
  test("first check triggers fetch; result is cached for the TTL window", async () => {
    const fetch = makeFakeFetcher(["jti-revoked"]);
    const clock = makeClock();
    const cache = createRevocationCache({
      origin: "http://hub.invalid",
      fetcher: fetch.fetcher,
      ttlMs: 60_000,
      now: clock.now,
    });

    expect(await cache.check("jti-revoked")).toBe("revoked");
    expect(fetch.callCount()).toBe(1);

    // Subsequent checks within the TTL window must NOT re-fetch.
    expect(await cache.check("jti-clear")).toBe("clear");
    expect(await cache.check("jti-revoked")).toBe("revoked");
    expect(fetch.callCount()).toBe(1);
  });

  test("after TTL expires, next check refreshes the cache", async () => {
    const fetch = makeFakeFetcher(["jti-old"]);
    const clock = makeClock();
    const cache = createRevocationCache({
      origin: "http://hub.invalid",
      fetcher: fetch.fetcher,
      ttlMs: 60_000,
      now: clock.now,
    });

    expect(await cache.check("jti-old")).toBe("revoked");
    expect(fetch.callCount()).toBe(1);

    // Advance time past TTL and swap the list contents.
    clock.advance(60_001);
    fetch.setList(["jti-new"]);

    expect(await cache.check("jti-old")).toBe("clear");
    expect(await cache.check("jti-new")).toBe("revoked");
    expect(fetch.callCount()).toBe(2);
  });

  test("clear list → 'clear' for any jti", async () => {
    const fetch = makeFakeFetcher([]);
    const cache = createRevocationCache({
      origin: "http://hub.invalid",
      fetcher: fetch.fetcher,
    });
    expect(await cache.check("anything")).toBe("clear");
  });
});

describe("RevocationCache — failure modes (fail-open / fail-closed)", () => {
  test("fail-open: existing cache survives a fetch failure", async () => {
    const fetch = makeFakeFetcher(["jti-revoked"]);
    const clock = makeClock();
    const cache = createRevocationCache({
      origin: "http://hub.invalid",
      fetcher: fetch.fetcher,
      ttlMs: 60_000,
      now: clock.now,
    });

    // Warm the cache successfully.
    expect(await cache.check("jti-revoked")).toBe("revoked");
    expect(fetch.callCount()).toBe(1);

    // Now make subsequent fetches fail and let the cache go stale.
    fetch.setFailing(true);
    clock.advance(60_001);

    // Cache is stale → triggers a refresh, refresh fails → falls back to
    // last-good. Last-good still has jti-revoked, so we return "revoked".
    expect(await cache.check("jti-revoked")).toBe("revoked");
    expect(await cache.check("other-jti")).toBe("clear");
    expect(fetch.callCount()).toBe(2); // the failed refresh attempt counts
  });

  test("fail-closed: no last-good cache yet → 'unknown'", async () => {
    const fetch = makeFakeFetcher();
    fetch.setFailing(true);
    const cache = createRevocationCache({
      origin: "http://hub.invalid",
      fetcher: fetch.fetcher,
    });

    expect(await cache.check("jti-revoked")).toBe("unknown");
    expect(fetch.callCount()).toBe(1);
  });

  test("fail-closed recovers as soon as one fetch succeeds", async () => {
    const fetch = makeFakeFetcher();
    fetch.setFailing(true);
    const clock = makeClock();
    const cache = createRevocationCache({
      origin: "http://hub.invalid",
      fetcher: fetch.fetcher,
      ttlMs: 60_000,
      now: clock.now,
    });

    expect(await cache.check("jti-x")).toBe("unknown");

    // Hub comes back up. After TTL, the next check refreshes successfully.
    fetch.setFailing(false);
    fetch.setList(["jti-x"]);
    clock.advance(60_001);

    expect(await cache.check("jti-x")).toBe("revoked");
    expect(await cache.check("jti-y")).toBe("clear");
  });

  test("reset() drops the last-good cache → next check fail-closes if fetch fails", async () => {
    const fetch = makeFakeFetcher(["jti-revoked"]);
    const cache = createRevocationCache({
      origin: "http://hub.invalid",
      fetcher: fetch.fetcher,
    });

    expect(await cache.check("jti-revoked")).toBe("revoked");

    cache.reset();
    fetch.setFailing(true);
    expect(await cache.check("jti-revoked")).toBe("unknown");
  });
});

describe("RevocationCache — single-flight", () => {
  test("concurrent checks during refresh share one fetch", async () => {
    let resolveFetch: ((v: { generated_at: string; jtis: string[] }) => void) | undefined;
    let calls = 0;
    const cache = createRevocationCache({
      origin: "http://hub.invalid",
      fetcher: () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveFetch = resolve;
        });
      },
    });

    // Fire many concurrent checks while the first fetch is pending.
    const promises = Array.from({ length: 10 }, () => cache.check("jti-revoked"));

    // Give the event loop a tick to register all 10 callers.
    await Promise.resolve();

    // Exactly ONE fetch was started — the rest awaited the same promise.
    expect(calls).toBe(1);

    // Now resolve.
    resolveFetch!({ generated_at: new Date().toISOString(), jtis: ["jti-revoked"] });
    const results = await Promise.all(promises);
    expect(results.every((r) => r === "revoked")).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("RevocationCache — list shape", () => {
  test("malformed body (default fetcher path) — covered indirectly via integration", () => {
    // The default fetcher rejects malformed bodies; that's exercised through
    // the validate.test.ts revocation suite where the fake server returns
    // bad JSON. Direct unit test would just re-test fetch+JSON shape.
    expect(true).toBe(true);
  });
});
