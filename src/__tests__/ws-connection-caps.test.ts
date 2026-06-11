/**
 * Tests for hub#649 — per-client-IP + total WebSocket connection caps at the
 * upgrade gate (`maybeUpgradeWebSocket` via the fetch fn), with release
 * riding the ws-bridge close path.
 *
 * Three tiers:
 *   - UNIT (fetch fn + spy upgrade): per-IP cap refusal (the HEADLINE test —
 *     it FAILED pre-fix with all 40 upgrades accepted), global cap refusal,
 *     generic 429 body, forwarded-header trust (spoofed XFF on an untrusted
 *     layer can't escape its bucket), release on a failed `server.upgrade`,
 *     env-configurable caps.
 *   - UNIT (pure): `wsCapBucketKey` derivation + `WsConnectionTracker`
 *     accounting (double-release latch, key eviction at zero).
 *   - INTEGRATION (real Bun.serve hub + real WS echo upstream): a churn of
 *     open/close cycles returns the counters to zero — including the
 *     unreachable-upstream teardown path, where the bridge (not the client)
 *     initiates the close.
 *
 * Every test injects its OWN tracker via `HubFetchDeps.wsConnectionTracker`
 * so nothing here consumes (or depends on) the process-wide default
 * tracker's counters.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WS_CAP_SHARED_BUCKET, hubFetch, wsCapBucketKey } from "../hub-server.ts";
import { type ServiceEntry, writeManifest } from "../services-manifest.ts";
import { type WsBridgeData, createWsBridgeHandlers } from "../ws-bridge.ts";
import {
  DEFAULT_WS_MAX_PER_IP,
  DEFAULT_WS_MAX_TOTAL,
  WsConnectionTracker,
  wsCapsFromEnv,
} from "../ws-connection-caps.ts";

interface Harness {
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-ws-caps-"));
  return {
    dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function wsEntry(port: number, extra: Partial<ServiceEntry> = {}): ServiceEntry {
  return {
    name: "wsmod",
    port,
    paths: ["/wsmod"],
    health: "/wsmod/health",
    version: "0.1.0",
    websocket: true,
    ...extra,
  };
}

function upgradeReq(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1${path}`, {
    headers: { upgrade: "websocket", connection: "Upgrade", ...headers },
  });
}

interface UpgradeSpy {
  requestIP: () => { address: string };
  upgrade: (req: Request, options: { data: WsBridgeData }) => boolean;
  calls: { data: WsBridgeData }[];
}

function upgradeSpy(address: string, accept = true): UpgradeSpy {
  const calls: { data: WsBridgeData }[] = [];
  return {
    requestIP: () => ({ address }),
    upgrade: (_req, options) => {
      calls.push(options);
      return accept;
    },
    calls,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(10);
  }
}

// ===========================================================================
// Unit — cap refusal at the upgrade gate
// ===========================================================================

describe("WS connection caps — upgrade-gate refusal (hub#649)", () => {
  test("HEADLINE: a same-IP upgrade flood is refused past the default per-IP cap (429), not accepted unboundedly", async () => {
    // Pre-fix evidence: run against the unmodified tree (with the default
    // tracker), this expressed-behavior test failed with accepted=40 — the
    // hub had NO connection bound at all.
    const h = makeHarness();
    try {
      writeManifest({ services: [wsEntry(12345)] }, h.manifestPath);
      const spy = upgradeSpy("127.0.0.1");
      const tracker = new WsConnectionTracker(); // built-in defaults: 32 / 512
      const fetcher = hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        wsConnectionTracker: tracker,
      });

      let accepted = 0;
      const refusals: Response[] = [];
      for (let i = 0; i < 40; i++) {
        // Loopback peer = trusted forwarder (tailscale serve / funnel
        // shape) — all 40 attempts attribute to ONE public client IP.
        const res = await fetcher(
          upgradeReq("/wsmod/ws", { "x-forwarded-for": "198.51.100.7" }),
          spy,
        );
        if (res === undefined) accepted++;
        else refusals.push(res);
      }

      expect(accepted).toBe(DEFAULT_WS_MAX_PER_IP); // 32
      expect(refusals.length).toBe(8);
      expect(spy.calls.length).toBe(DEFAULT_WS_MAX_PER_IP); // upgrade never attempted over-cap
      for (const res of refusals) expect(res.status).toBe(429);

      // The refusal is generic: no counts, no cap identity, no numbers.
      const body = (await refusals[0]!.json()) as { error: string; error_description: string };
      expect(body.error).toBe("too_many_connections");
      expect(JSON.stringify(body)).not.toMatch(/\d/);
    } finally {
      h.cleanup();
    }
  });

  test("global cap: distinct client IPs are refused once the total is saturated", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [wsEntry(12345)] }, h.manifestPath);
      const spy = upgradeSpy("127.0.0.1");
      const tracker = new WsConnectionTracker(10, 3); // per-IP generous, total=3
      const fetcher = hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        wsConnectionTracker: tracker,
      });

      for (let i = 0; i < 3; i++) {
        const res = await fetcher(
          upgradeReq("/wsmod/ws", { "x-forwarded-for": `198.51.100.${i}` }),
          spy,
        );
        expect(res).toBeUndefined(); // upgraded
      }
      const res = await fetcher(
        upgradeReq("/wsmod/ws", { "x-forwarded-for": "198.51.100.99" }),
        spy,
      );
      expect(res?.status).toBe(429);
      expect(spy.calls.length).toBe(3);
      expect(tracker.totalCount).toBe(3);
    } finally {
      h.cleanup();
    }
  });

  test("forwarded-header trust: spoofed XFF from a direct (non-loopback) peer does NOT escape the peer's bucket", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [wsEntry(12345)] }, h.manifestPath);
      // Direct public peer — its XFF is attacker-controlled and must be ignored.
      const spy = upgradeSpy("203.0.113.50");
      const tracker = new WsConnectionTracker(2, 100);
      const fetcher = hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        wsConnectionTracker: tracker,
      });

      const r1 = await fetcher(upgradeReq("/wsmod/ws", { "x-forwarded-for": "1.1.1.1" }), spy);
      const r2 = await fetcher(upgradeReq("/wsmod/ws", { "x-forwarded-for": "2.2.2.2" }), spy);
      const r3 = await fetcher(upgradeReq("/wsmod/ws", { "x-forwarded-for": "3.3.3.3" }), spy);
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
      expect(r3?.status).toBe(429); // rotating XFF minted no fresh buckets
      expect(tracker.countFor("203.0.113.50")).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  test("forwarded-header trust: XFF from a loopback (trusted forwarder) peer DOES key distinct buckets", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [wsEntry(12345)] }, h.manifestPath);
      const spy = upgradeSpy("127.0.0.1");
      const tracker = new WsConnectionTracker(2, 100);
      const fetcher = hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        wsConnectionTracker: tracker,
      });

      // Two different real clients behind the on-box forwarder: each gets
      // its own per-IP allotment.
      for (const ip of ["198.51.100.1", "198.51.100.1", "198.51.100.2", "198.51.100.2"]) {
        const res = await fetcher(upgradeReq("/wsmod/ws", { "x-forwarded-for": ip }), spy);
        expect(res).toBeUndefined();
      }
      expect(tracker.countFor("198.51.100.1")).toBe(2);
      expect(tracker.countFor("198.51.100.2")).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  test("a failed server.upgrade releases the slot (no leak without a socket)", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [wsEntry(12345)] }, h.manifestPath);
      const spy = upgradeSpy("127.0.0.1", false); // handshake malformed → upgrade() = false
      const tracker = new WsConnectionTracker(1, 1);
      const fetcher = hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        wsConnectionTracker: tracker,
      });

      const r1 = await fetcher(upgradeReq("/wsmod/ws"), spy);
      expect(r1?.status).toBe(400);
      expect(tracker.totalCount).toBe(0); // released inline
      // The (1,1)-capped tracker still admits the next attempt.
      const r2 = await fetcher(upgradeReq("/wsmod/ws"), spy);
      expect(r2?.status).toBe(400);
      expect(tracker.totalCount).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("caps are configurable: an env-built tracker enforces the overridden values", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [wsEntry(12345)] }, h.manifestPath);
      const caps = wsCapsFromEnv({
        PARACHUTE_WS_MAX_PER_IP: "2",
        PARACHUTE_WS_MAX_TOTAL: "50",
      } as NodeJS.ProcessEnv);
      const tracker = new WsConnectionTracker(caps.maxPerIp, caps.maxTotal);
      const spy = upgradeSpy("127.0.0.1");
      const fetcher = hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        wsConnectionTracker: tracker,
      });

      const headers = { "x-forwarded-for": "198.51.100.7" };
      expect(await fetcher(upgradeReq("/wsmod/ws", headers), spy)).toBeUndefined();
      expect(await fetcher(upgradeReq("/wsmod/ws", headers), spy)).toBeUndefined();
      const res = await fetcher(upgradeReq("/wsmod/ws", headers), spy);
      expect(res?.status).toBe(429);
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// Unit — env parsing, bucket-key derivation, tracker accounting
// ===========================================================================

describe("wsCapsFromEnv", () => {
  test("absent env → defaults", () => {
    expect(wsCapsFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      maxPerIp: DEFAULT_WS_MAX_PER_IP,
      maxTotal: DEFAULT_WS_MAX_TOTAL,
    });
  });

  test("valid positive integers are honored", () => {
    expect(
      wsCapsFromEnv({
        PARACHUTE_WS_MAX_PER_IP: "8",
        PARACHUTE_WS_MAX_TOTAL: "1024",
      } as NodeJS.ProcessEnv),
    ).toEqual({ maxPerIp: 8, maxTotal: 1024 });
  });

  test("malformed / non-positive values fall back to the defaults, never to unlimited", () => {
    for (const bad of ["", "abc", "0", "-3", "12.5", "1e3", "32x"]) {
      const caps = wsCapsFromEnv({
        PARACHUTE_WS_MAX_PER_IP: bad,
        PARACHUTE_WS_MAX_TOTAL: bad,
      } as NodeJS.ProcessEnv);
      expect(caps).toEqual({ maxPerIp: DEFAULT_WS_MAX_PER_IP, maxTotal: DEFAULT_WS_MAX_TOTAL });
    }
  });
});

describe("wsCapBucketKey — trust-model keying", () => {
  const req = (headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1/wsmod/ws", { headers });

  test("loopback peer: CF-Connecting-IP wins, then XFF first hop, then the peer itself", () => {
    expect(
      wsCapBucketKey(
        req({ "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "10.0.0.1" }),
        "127.0.0.1",
      ),
    ).toBe("198.51.100.9");
    expect(wsCapBucketKey(req({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }), "127.0.0.1")).toBe(
      "198.51.100.7",
    );
    expect(wsCapBucketKey(req(), "::1")).toBe("::1");
  });

  test("non-loopback peer: keyed by peer address, injected headers ignored", () => {
    expect(
      wsCapBucketKey(
        req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }),
        "203.0.113.50",
      ),
    ).toBe("203.0.113.50");
  });

  test("underivable (no peer) → the shared fail-closed bucket, headers still ignored", () => {
    expect(wsCapBucketKey(req({ "x-forwarded-for": "5.6.7.8" }), null)).toBe(WS_CAP_SHARED_BUCKET);
    expect(wsCapBucketKey(req(), "   ")).toBe(WS_CAP_SHARED_BUCKET);
  });
});

describe("WsConnectionTracker accounting", () => {
  test("release is latched: double-release decrements once, never below zero", () => {
    const tracker = new WsConnectionTracker(2, 2);
    const a = tracker.tryAcquire("k");
    const b = tracker.tryAcquire("k");
    if (!a.ok || !b.ok) throw new Error("expected both acquires to succeed");
    a.release();
    a.release(); // latched no-op
    expect(tracker.totalCount).toBe(1);
    expect(tracker.countFor("k")).toBe(1);
    b.release();
    b.release();
    expect(tracker.totalCount).toBe(0);
    expect(tracker.countFor("k")).toBe(0);
    expect(tracker.keyCount).toBe(0); // bucket evicted at zero — no map growth
  });

  test("refusals don't mutate counts", () => {
    const tracker = new WsConnectionTracker(1, 10);
    const a = tracker.tryAcquire("k");
    if (!a.ok) throw new Error("expected acquire to succeed");
    const refused = tracker.tryAcquire("k");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("per_ip_cap");
    expect(tracker.totalCount).toBe(1);
    a.release();
    expect(tracker.totalCount).toBe(0);
  });
});

// ===========================================================================
// Integration — real sockets: churn returns the counters to zero
// ===========================================================================

function startWsEchoUpstream(): { port: number; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      message(ws, msg) {
        ws.send(typeof msg === "string" ? `echo:${msg}` : msg);
      },
    },
  });
  return { port: server.port as number, stop: () => server.stop(true) };
}

function startHub(h: Harness, tracker: WsConnectionTracker): { port: number; stop: () => void } {
  const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath, wsConnectionTracker: tracker });
  const server = Bun.serve<WsBridgeData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => fetcher(req, srv),
    websocket: createWsBridgeHandlers(),
  });
  return { port: server.port as number, stop: () => server.stop(true) };
}

describe("WS connection caps — integration (real sockets, churn to zero)", () => {
  test("open/close churn returns per-IP + total counters to zero every cycle", async () => {
    const h = makeHarness();
    const upstream = startWsEchoUpstream();
    let hub: { port: number; stop: () => void } | undefined;
    try {
      writeManifest({ services: [wsEntry(upstream.port)] }, h.manifestPath);
      const tracker = new WsConnectionTracker(); // defaults — churn never nears them
      hub = startHub(h, tracker);

      for (let cycle = 0; cycle < 3; cycle++) {
        const clients: WebSocket[] = [];
        for (let i = 0; i < 3; i++) {
          const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/wsmod/ws`);
          const opened = new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve());
            ws.addEventListener("error", () => reject(new Error("client failed to connect")));
          });
          clients.push(ws);
          await opened;
        }
        // Slots held while the sockets live (all test clients are direct
        // loopback peers → one shared bucket).
        expect(tracker.totalCount).toBe(3);
        expect(tracker.countFor("127.0.0.1")).toBe(3);

        for (const ws of clients) ws.close(1000, "done");
        await waitFor(() => tracker.totalCount === 0);
        expect(tracker.keyCount).toBe(0); // bucket map fully drained — no leak
      }
    } finally {
      hub?.stop();
      upstream.stop();
      h.cleanup();
    }
  });

  test("bridge-initiated teardown (unreachable upstream) also releases the slot", async () => {
    const h = makeHarness();
    // Bind a port + release it so the upstream connect gets ECONNREFUSED.
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const deadPort = probe.port as number;
    probe.stop(true);
    let hub: { port: number; stop: () => void } | undefined;
    try {
      writeManifest({ services: [wsEntry(deadPort)] }, h.manifestPath);
      const tracker = new WsConnectionTracker();
      hub = startHub(h, tracker);

      const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/wsmod/ws`);
      const closed = new Promise<number>((resolve) => {
        ws.addEventListener("close", (ev) => resolve(ev.code));
      });
      expect(await closed).toBe(1011);
      await waitFor(() => tracker.totalCount === 0);
      expect(tracker.keyCount).toBe(0);
    } finally {
      hub?.stop();
      h.cleanup();
    }
  });
});
