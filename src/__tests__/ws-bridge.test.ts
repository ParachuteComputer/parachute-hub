/**
 * Tests for the H1 WebSocket upgrade bridge (surface-runtime design):
 * routing + gating in `hub-server.ts` (`maybeUpgradeWebSocket` via the
 * fetch fn) and frame piping in `src/ws-bridge.ts`.
 *
 * Two tiers:
 *   - INTEGRATION: a real `Bun.serve` hub (hubFetch + createWsBridgeHandlers)
 *     in front of a real Bun WS echo upstream — proves the upgrade is
 *     forwarded, frames flow both ways, closes propagate in both directions,
 *     and the upstream connect carries the H2 substrate trust headers.
 *   - UNIT: direct fetch-fn calls with a spy `upgrade` for the refusal /
 *     gating paths (no declaration → 426; loopback cloak → 404 before any
 *     upgrade; module.json fallback declaration), and handler-level fakes
 *     for backpressure + close-code sanitization.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { hubFetch } from "../hub-server.ts";
import type { ModuleManifest } from "../module-manifest.ts";
import { type ServiceEntry, writeManifest } from "../services-manifest.ts";
import { type WsBridgeData, createWsBridgeHandlers } from "../ws-bridge.ts";

interface Harness {
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-ws-bridge-"));
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
    ...extra,
  };
}

function upgradeReq(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1${path}`, {
    headers: { upgrade: "websocket", connection: "Upgrade", ...headers },
  });
}

/** Bun WebSocket client with custom headers (Bun extension over WHATWG). */
function wsClient(url: string, headers?: Record<string, string>): WebSocket {
  return new WebSocket(url, { headers } as unknown as string[]);
}

function once<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ===========================================================================
// Integration — real hub Bun.serve + real upstream WS echo
// ===========================================================================

interface UpstreamRecorder {
  port: number;
  stop: () => void;
  /** Resolves with (code, reason) when the upstream-side socket closes. */
  closed: Promise<{ code: number; reason: string }>;
}

/**
 * A WS echo upstream. On open it sends a JSON snapshot of the connect-time
 * request (path + the substrate trust headers + a sampled client header), so
 * the test can assert what the bridge presented. Echoes text as `echo:<msg>`
 * and binary verbatim; the literal "close-me" makes the upstream close with
 * 4001.
 */
function startWsEchoUpstream(): UpstreamRecorder {
  const closeSignal = once<{ code: number; reason: string }>();
  type Data = { snapshot: Record<string, string | null> };
  const server = Bun.serve<Data>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const u = new URL(req.url);
      const snapshot = {
        path: u.pathname + u.search,
        layer: req.headers.get("x-parachute-layer"),
        clientIp: req.headers.get("x-parachute-client-ip"),
        cookie: req.headers.get("cookie"),
        secWebsocketKey: req.headers.get("sec-websocket-key"),
      };
      if (srv.upgrade(req, { data: { snapshot } })) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ kind: "hello", snapshot: ws.data.snapshot }));
      },
      message(ws, msg) {
        if (msg === "close-me") {
          ws.close(4001, "upstream says bye");
          return;
        }
        if (typeof msg === "string") ws.send(`echo:${msg}`);
        else ws.send(msg);
      },
      close(_ws, code, reason) {
        closeSignal.resolve({ code, reason });
      },
    },
  });
  return {
    port: server.port as number,
    stop: () => server.stop(true),
    closed: closeSignal.promise,
  };
}

function startHub(h: Harness): { port: number; stop: () => void } {
  const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
  const server = Bun.serve<WsBridgeData>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => fetcher(req, srv),
    websocket: createWsBridgeHandlers(),
  });
  return { port: server.port as number, stop: () => server.stop(true) };
}

describe("WS bridge integration — declaring module, real sockets (H1)", () => {
  test("upgrade forwarded; H2 headers stamped on upstream connect; bidirectional frames; client-close propagates", async () => {
    const h = makeHarness();
    const upstream = startWsEchoUpstream();
    let hub: { port: number; stop: () => void } | undefined;
    try {
      writeManifest({ services: [wsEntry(upstream.port, { websocket: true })] }, h.manifestPath);
      hub = startHub(h);

      const messages: (string | ArrayBuffer)[] = [];
      const opened = once<void>();
      const gotHello = once<string>();
      const gotEcho = once<string>();
      const gotBinary = once<Uint8Array>();
      // The client tries to inject the substrate headers — the bridge must
      // strip + re-stamp them (the peer is loopback, so the truthful stamp
      // is "loopback", not the forged "tailnet"). A cookie rides through so
      // the daemon can authenticate the connection.
      const client = wsClient(`ws://127.0.0.1:${hub.port}/wsmod/ws?room=7`, {
        "x-parachute-layer": "tailnet",
        "x-parachute-client-ip": "203.0.113.99",
        cookie: "parachute_session=abc",
      });
      client.binaryType = "arraybuffer";
      client.addEventListener("open", () => opened.resolve());
      client.addEventListener("message", (ev) => {
        messages.push(ev.data as string | ArrayBuffer);
        if (typeof ev.data === "string" && ev.data.includes('"hello"')) {
          gotHello.resolve(ev.data);
        } else if (typeof ev.data === "string" && ev.data.startsWith("echo:")) {
          gotEcho.resolve(ev.data);
        } else if (ev.data instanceof ArrayBuffer) {
          gotBinary.resolve(new Uint8Array(ev.data));
        }
      });

      await opened.promise;
      const hello = JSON.parse(await gotHello.promise) as {
        snapshot: Record<string, string | null>;
      };
      // Path + query forwarded verbatim (no stripPrefix declared).
      expect(hello.snapshot.path).toBe("/wsmod/ws?room=7");
      // H2 stamps: truthful layer (loopback peer), not the client's forgery.
      expect(hello.snapshot.layer).toBe("loopback");
      expect(hello.snapshot.clientIp).toBe("127.0.0.1");
      // The client's own credential headers ride through.
      expect(hello.snapshot.cookie).toBe("parachute_session=abc");
      // The Bun client re-mints the handshake; a key is present and is NOT
      // the hub-side client's key (we can only assert presence here).
      expect(hello.snapshot.secWebsocketKey).toBeTruthy();

      // Client → upstream → client text round trip.
      client.send("ping");
      expect(await gotEcho.promise).toBe("echo:ping");

      // Binary round trip.
      client.send(new Uint8Array([1, 2, 3, 250]));
      expect([...(await gotBinary.promise)]).toEqual([1, 2, 3, 250]);

      // Client-initiated close propagates the CODE to the upstream. The
      // reason string is not propagated in this direction: Bun's server-side
      // websocket close callback delivers an empty reason (verified on Bun
      // 1.3.13), so the bridge never receives it. Upstream→client reason
      // propagation works (next test).
      client.close(4002, "client done");
      const upstreamClose = await upstream.closed;
      expect(upstreamClose.code).toBe(4002);
      expect(upstreamClose.reason).toBe("");
    } finally {
      hub?.stop();
      upstream.stop();
      h.cleanup();
    }
  });

  test("upstream-initiated close propagates code + reason to the client", async () => {
    const h = makeHarness();
    const upstream = startWsEchoUpstream();
    let hub: { port: number; stop: () => void } | undefined;
    try {
      writeManifest({ services: [wsEntry(upstream.port, { websocket: true })] }, h.manifestPath);
      hub = startHub(h);

      const closed = once<{ code: number; reason: string }>();
      const opened = once<void>();
      const client = wsClient(`ws://127.0.0.1:${hub.port}/wsmod/ws`);
      client.addEventListener("open", () => opened.resolve());
      client.addEventListener("close", (ev) =>
        closed.resolve({ code: ev.code, reason: ev.reason }),
      );
      await opened.promise;
      client.send("close-me");
      const ev = await closed.promise;
      expect(ev.code).toBe(4001);
      expect(ev.reason).toBe("upstream says bye");
    } finally {
      hub?.stop();
      upstream.stop();
      h.cleanup();
    }
  });

  test("unreachable upstream → client closed 1011 (no hang)", async () => {
    const h = makeHarness();
    // Bind a port + release it so the upstream connect gets ECONNREFUSED.
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const deadPort = probe.port as number;
    probe.stop(true);
    let hub: { port: number; stop: () => void } | undefined;
    try {
      writeManifest({ services: [wsEntry(deadPort, { websocket: true })] }, h.manifestPath);
      hub = startHub(h);
      const closed = once<{ code: number }>();
      const client = wsClient(`ws://127.0.0.1:${hub.port}/wsmod/ws`);
      client.addEventListener("close", (ev) => closed.resolve({ code: ev.code }));
      const ev = await closed.promise;
      expect(ev.code).toBe(1011);
    } finally {
      hub?.stop();
      h.cleanup();
    }
  });
});

// ===========================================================================
// Unit — routing + gating verdicts via direct fetch-fn calls
// ===========================================================================

describe("WS upgrade routing + gating (H1, deny-by-default)", () => {
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

  test("non-declaring module → 426, upgrade never attempted, daemon never dialed", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [wsEntry(19999)] }, h.manifestPath); // no websocket flag
      const spy = upgradeSpy("127.0.0.1");
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(upgradeReq("/wsmod/ws"), spy);
      expect(res?.status).toBe(426);
      const body = (await res?.json()) as { error: string };
      expect(body.error).toBe("websocket_not_supported");
      expect(spy.calls.length).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("declared via services.json row → upgraded (fetch returns undefined, data carries upstream URL + stamped headers)", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [wsEntry(12345, { websocket: true })] }, h.manifestPath);
      const spy = upgradeSpy("127.0.0.1");
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(
        upgradeReq("/wsmod/collab?doc=a", {
          // Spoof attempt — must be stripped + re-stamped.
          "x-parachute-layer": "loopback",
          "x-parachute-client-ip": "10.9.9.9",
          cookie: "parachute_session=zzz",
          "sec-websocket-key": "AAAA",
          "sec-websocket-version": "13",
        }),
        spy,
      );
      expect(res).toBeUndefined(); // Bun contract: upgraded → undefined
      expect(spy.calls.length).toBe(1);
      const data = spy.calls[0]!.data;
      expect(data.upstreamUrl).toBe("ws://127.0.0.1:12345/wsmod/collab?doc=a");
      // H2 stamps (truthful loopback peer)…
      expect(data.upstreamHeaders["x-parachute-layer"]).toBe("loopback");
      expect(data.upstreamHeaders["x-parachute-client-ip"]).toBe("127.0.0.1");
      // …credentials ride through…
      expect(data.upstreamHeaders.cookie).toBe("parachute_session=zzz");
      // …and the WS handshake + hop-by-hop headers are NOT forwarded (the
      // Bun client re-mints its own handshake).
      expect(data.upstreamHeaders["sec-websocket-key"]).toBeUndefined();
      expect(data.upstreamHeaders["sec-websocket-version"]).toBeUndefined();
      expect(data.upstreamHeaders.upgrade).toBeUndefined();
      expect(data.upstreamHeaders.connection).toBeUndefined();
      expect(data.upstreamHeaders.host).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("declared via module.json fallback (row carries no flag) → upgraded", async () => {
    const h = makeHarness();
    try {
      writeManifest(
        { services: [wsEntry(12346, { installDir: "/fake/install/dir" })] },
        h.manifestPath,
      );
      const manifest: ModuleManifest = {
        name: "wsmod",
        manifestName: "wsmod",
        port: 12346,
        paths: ["/wsmod"],
        health: "/wsmod/health",
        websocket: true,
      };
      const spy = upgradeSpy("127.0.0.1");
      const fetcher = hubFetch(h.dir, {
        manifestPath: h.manifestPath,
        readModuleManifest: async () => manifest,
      });
      const res = await fetcher(upgradeReq("/wsmod/ws"), spy);
      expect(res).toBeUndefined();
      expect(spy.calls.length).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("publicExposure: loopback + public layer → 404 cloak BEFORE upgrade (gate precedes capability)", async () => {
    const h = makeHarness();
    try {
      writeManifest(
        {
          services: [wsEntry(12347, { websocket: true, publicExposure: "loopback" })],
        },
        h.manifestPath,
      );
      const spy = upgradeSpy("127.0.0.1");
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(upgradeReq("/wsmod/ws", { "cf-ray": "1" }), spy);
      expect(res?.status).toBe(404); // indistinguishable from not-installed
      expect(spy.calls.length).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("stripPrefix honored on the upstream URL", async () => {
    const h = makeHarness();
    try {
      writeManifest(
        { services: [wsEntry(12348, { websocket: true, stripPrefix: true })] },
        h.manifestPath,
      );
      const spy = upgradeSpy("127.0.0.1");
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(upgradeReq("/wsmod/ws"), spy);
      expect(res).toBeUndefined();
      expect(spy.calls[0]!.data.upstreamUrl).toBe("ws://127.0.0.1:12348/ws");
    } finally {
      h.cleanup();
    }
  });

  test("upgrade request matching NO service mount falls through to normal dispatch (404)", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [] }, h.manifestPath);
      const spy = upgradeSpy("127.0.0.1");
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(upgradeReq("/nothing-here"), spy);
      expect(res?.status).toBe(404);
      expect(spy.calls.length).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("no Server threaded (no upgrade capability) → 503, not a crash", async () => {
    const h = makeHarness();
    try {
      writeManifest({ services: [wsEntry(12349, { websocket: true })] }, h.manifestPath);
      const fetcher = hubFetch(h.dir, { manifestPath: h.manifestPath });
      const res = await fetcher(upgradeReq("/wsmod/ws"));
      expect(res?.status).toBe(503);
    } finally {
      h.cleanup();
    }
  });
});

// ===========================================================================
// Unit — bridge handler internals (backpressure, close-code sanitization)
// ===========================================================================

describe("createWsBridgeHandlers internals", () => {
  type Listener = (ev: unknown) => void;

  interface FakeUpstream {
    readyState: number;
    bufferedAmount: number;
    binaryType: string;
    sent: (string | Uint8Array)[];
    closes: { code: number | undefined; reason: string | undefined }[];
    listeners: Map<string, Listener[]>;
    send(frame: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
    addEventListener(name: string, fn: Listener): void;
    fire(name: string, ev: unknown): void;
  }

  function fakeUpstream(readyState: number): FakeUpstream {
    return {
      readyState,
      bufferedAmount: 0,
      binaryType: "arraybuffer",
      sent: [],
      closes: [],
      listeners: new Map(),
      send(frame) {
        this.sent.push(frame);
      },
      close(code, reason) {
        this.closes.push({ code, reason });
      },
      addEventListener(name, fn) {
        const arr = this.listeners.get(name) ?? [];
        arr.push(fn);
        this.listeners.set(name, arr);
      },
      fire(name, ev) {
        for (const fn of this.listeners.get(name) ?? []) fn(ev);
      },
    };
  }

  interface FakeServerWs {
    data: WsBridgeData;
    sent: (string | Uint8Array)[];
    closes: { code: number | undefined; reason: string | undefined }[];
    buffered: number;
    send(frame: string | Uint8Array): number;
    close(code?: number, reason?: string): void;
    getBufferedAmount(): number;
  }

  function fakeServerWs(): FakeServerWs {
    return {
      data: { upstreamUrl: "ws://127.0.0.1:1/x", upstreamHeaders: {} },
      sent: [],
      closes: [],
      buffered: 0,
      send(frame) {
        this.sent.push(frame);
        return typeof frame === "string" ? frame.length : frame.byteLength;
      },
      close(code, reason) {
        this.closes.push({ code, reason });
      },
      getBufferedAmount() {
        return this.buffered;
      },
    };
  }

  function openBridge(opts: { cap?: number; upstreamState?: number } = {}) {
    const upstream = fakeUpstream(opts.upstreamState ?? WebSocket.CONNECTING);
    const handlers = createWsBridgeHandlers({
      maxBufferedBytes: opts.cap ?? 64,
      connectUpstream: () => upstream as unknown as WebSocket,
      logger: { warn: () => {} },
    });
    const ws = fakeServerWs();
    handlers.open?.(ws as unknown as ServerWebSocket<WsBridgeData>);
    return { handlers, ws, upstream };
  }

  test("client frames buffered while upstream CONNECTING, flushed on open", () => {
    const { handlers, ws, upstream } = openBridge();
    handlers.message?.(ws as unknown as ServerWebSocket<WsBridgeData>, "early");
    expect(upstream.sent.length).toBe(0);
    upstream.readyState = WebSocket.OPEN;
    upstream.fire("open", {});
    expect(upstream.sent).toEqual(["early"]);
  });

  test("pending-buffer overflow while CONNECTING → closes both sides 1011", () => {
    const { handlers, ws, upstream } = openBridge({ cap: 8 });
    handlers.message?.(
      ws as unknown as ServerWebSocket<WsBridgeData>,
      "0123456789", // 10 bytes > 8-byte cap
    );
    expect(ws.closes).toEqual([{ code: 1011, reason: "bridge backpressure cap exceeded" }]);
    expect(upstream.closes.length).toBe(1);
  });

  test("upstream bufferedAmount over cap after a forward → closes both sides 1011", () => {
    const { handlers, ws, upstream } = openBridge({ cap: 8, upstreamState: WebSocket.OPEN });
    upstream.bufferedAmount = 100;
    handlers.message?.(ws as unknown as ServerWebSocket<WsBridgeData>, "x");
    expect(upstream.sent).toEqual(["x"]); // the frame was forwarded…
    expect(ws.closes[0]?.code).toBe(1011); // …then the cap tripped
  });

  test("client-side bufferedAmount over cap on upstream→client delivery → closes both sides 1011", () => {
    const { ws, upstream } = openBridge({ cap: 8, upstreamState: WebSocket.OPEN });
    ws.buffered = 100;
    upstream.fire("message", { data: "from-upstream" });
    expect(ws.sent).toEqual(["from-upstream"]);
    expect(ws.closes[0]?.code).toBe(1011);
    expect(upstream.closes.length).toBe(1);
  });

  test("reserved close codes (1006) are sanitized to a no-code close; reason trimmed to 123 bytes", () => {
    const { ws, upstream } = openBridge({ upstreamState: WebSocket.OPEN });
    upstream.fire("close", { code: 1006, reason: `R${"x".repeat(200)}` });
    expect(ws.closes.length).toBe(1);
    expect(ws.closes[0]?.code).toBeUndefined();
    expect(Buffer.byteLength(ws.closes[0]?.reason ?? "", "utf8")).toBeLessThanOrEqual(123);
  });

  test("client close propagates to upstream exactly once (idempotent latch)", () => {
    const { handlers, ws, upstream } = openBridge({ upstreamState: WebSocket.OPEN });
    handlers.close?.(ws as unknown as ServerWebSocket<WsBridgeData>, 4005, "done");
    handlers.close?.(ws as unknown as ServerWebSocket<WsBridgeData>, 4005, "done");
    expect(upstream.closes).toEqual([{ code: 4005, reason: "done" }]);
    // After the latch, an upstream close event must not bounce back.
    upstream.fire("close", { code: 1000, reason: "" });
    expect(ws.closes.length).toBe(0);
  });
});
