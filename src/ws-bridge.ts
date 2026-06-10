/**
 * Bun-native WebSocket upgrade bridge (H1, surface-runtime design §"Hub work
 * items").
 *
 * The hub's HTTP proxy is fetch-based, and WebSocket upgrades don't traverse
 * fetch — so until now the route table simply couldn't forward them (the
 * hub-server docstring acknowledged it). This module is the transport half of
 * the fix: when `hub-server.ts` accepts an upgrade for a service mount whose
 * module DECLARES the capability (`websocket: true` on its services.json row
 * or module.json — deny-by-default), it calls `server.upgrade(req, { data })`
 * with a {@link WsBridgeData} payload, and these handlers pipe frames
 * bidirectionally between the client socket and a Bun WebSocket client
 * connected to the upstream daemon (same path, loopback).
 *
 * Scope discipline: this is TRANSPORT, not features —
 *
 *   - The upstream connect carries the substrate trust headers (H2:
 *     X-Parachute-Layer / X-Parachute-Client-IP) plus the client's own
 *     headers (cookie, authorization) so the module authenticates the
 *     connection itself; the hub adds no WS-level auth of its own beyond the
 *     route gates that ran BEFORE the upgrade (publicExposure cloak,
 *     audience gate).
 *   - Subprotocol negotiation (`Sec-WebSocket-Protocol`) is NOT forwarded in
 *     v1 — none of the in-design consumers (y-websocket / Hocuspocus manual
 *     pumping) require it; forwarding it correctly needs a negotiation
 *     round-trip the first real consumer can motivate.
 *   - Backpressure is a blunt cap, not flow control: when either side's
 *     buffered amount exceeds {@link DEFAULT_MAX_BUFFERED_BYTES}, the bridge
 *     closes BOTH sides (1011). A slow consumer should reconnect rather than
 *     let the hub buffer unboundedly.
 *
 * Lifecycle: either side closing tears down the other (close code + reason
 * propagated where the RFC 6455 rules allow), and an upstream connect failure
 * closes the client with 1011. The bridge holds no per-connection state
 * outside `ws.data`, so a dropped socket leaks nothing.
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";

/**
 * Default cap on either side's buffered (un-flushed) bytes before the bridge
 * gives up and closes both sockets. 8 MiB comfortably covers CRDT sync bursts
 * (a full Yjs document state vector is typically KBs) while bounding what a
 * slow or stalled consumer can pin in hub memory per connection.
 */
export const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/**
 * Per-connection payload attached at `server.upgrade(req, { data })` time by
 * the hub's dispatch (which already ran the route gates). Everything the
 * bridge needs to dial the upstream — it never re-derives routing or trust.
 */
export interface WsBridgeData {
  /** Absolute ws:// URL of the upstream daemon (same path + query, loopback). */
  upstreamUrl: string;
  /**
   * Headers presented on the upstream connect: the client's own headers
   * (minus hop-by-hop + WS handshake headers, which the Bun client re-mints)
   * plus the H2 substrate trust stamps.
   */
  upstreamHeaders: Record<string, string>;
  /** Internal bridge state — attached by `open()`, owned by this module. */
  _bridge?: BridgeState;
}

interface BridgeState {
  upstream: WebSocket;
  /** Client frames received while the upstream is still CONNECTING. */
  pending: (string | Uint8Array)[];
  pendingBytes: number;
  /** Set once either side initiated teardown — makes close idempotent. */
  closed: boolean;
}

export interface WsBridgeOptions {
  /** Override the buffered-bytes cap (tests use a tiny value). */
  maxBufferedBytes?: number;
  /** Test seam for the upstream WebSocket constructor. */
  connectUpstream?: (url: string, headers: Record<string, string>) => WebSocket;
  logger?: Pick<Console, "warn">;
}

/**
 * RFC 6455: only codes 1000–4999 may be sent on the wire, and 1004/1005/1006/
 * 1015 are reserved (never sent). A close event surfacing one of those (e.g.
 * 1006 abnormal closure) is re-mapped to a no-code close, which the peer
 * observes as 1005.
 */
function sendableCloseCode(code: number | undefined): number | undefined {
  if (code === undefined) return undefined;
  if (code < 1000 || code > 4999) return undefined;
  if (code === 1004 || code === 1005 || code === 1006 || code === 1015) return undefined;
  return code;
}

/** Close reasons are capped at 123 bytes on the wire (RFC 6455 §5.5.1). */
function trimReason(reason: string | undefined): string {
  if (!reason) return "";
  // Trim by UTF-8 byte length, not string length.
  let out = reason;
  while (Buffer.byteLength(out, "utf8") > 123) out = out.slice(0, -1);
  return out;
}

function closeQuietly(close: () => void): void {
  try {
    close();
  } catch {
    // Already closed / closing — teardown is best-effort by design.
  }
}

/** Tear down both sides exactly once. */
function closeBoth(
  ws: ServerWebSocket<WsBridgeData>,
  state: BridgeState,
  code: number,
  reason: string,
): void {
  if (state.closed) return;
  state.closed = true;
  closeQuietly(() => state.upstream.close(sendableCloseCode(code), trimReason(reason)));
  closeQuietly(() => ws.close(sendableCloseCode(code), trimReason(reason)));
}

function frameBytes(frame: string | Uint8Array | ArrayBuffer): number {
  if (typeof frame === "string") return Buffer.byteLength(frame, "utf8");
  return frame instanceof ArrayBuffer ? frame.byteLength : frame.byteLength;
}

/**
 * Build the Bun.serve `websocket` handler set implementing the bridge. One
 * handler object serves every bridged connection; per-connection state lives
 * on `ws.data`.
 */
export function createWsBridgeHandlers(opts: WsBridgeOptions = {}): WebSocketHandler<WsBridgeData> {
  const cap = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const logger = opts.logger ?? console;
  const connect =
    opts.connectUpstream ??
    ((url: string, headers: Record<string, string>) =>
      // Bun's WebSocket client accepts custom headers (a Bun extension over
      // the WHATWG constructor) — this is what carries the H2 trust stamps +
      // the client's cookies/authorization to the upstream daemon.
      new WebSocket(url, { headers } as unknown as string[]));

  return {
    open(ws) {
      let upstream: WebSocket;
      try {
        upstream = connect(ws.data.upstreamUrl, ws.data.upstreamHeaders);
      } catch (err) {
        logger.warn(
          `[ws-bridge] upstream connect threw for ${ws.data.upstreamUrl}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        closeQuietly(() => ws.close(1011, "upstream connect failed"));
        return;
      }
      upstream.binaryType = "arraybuffer";
      const state: BridgeState = { upstream, pending: [], pendingBytes: 0, closed: false };
      ws.data._bridge = state;

      upstream.addEventListener("open", () => {
        if (state.closed) {
          closeQuietly(() => upstream.close(1000, ""));
          return;
        }
        for (const frame of state.pending) upstream.send(frame);
        state.pending = [];
        state.pendingBytes = 0;
      });

      upstream.addEventListener("message", (ev: MessageEvent) => {
        if (state.closed) return;
        const data = ev.data as string | ArrayBuffer;
        ws.send(typeof data === "string" ? data : new Uint8Array(data));
        // Backpressure: the client isn't draining what the upstream sends.
        if (ws.getBufferedAmount() > cap) {
          closeBoth(ws, state, 1011, "bridge backpressure cap exceeded");
        }
      });

      upstream.addEventListener("close", (ev: CloseEvent) => {
        if (state.closed) return;
        state.closed = true;
        closeQuietly(() => ws.close(sendableCloseCode(ev.code), trimReason(ev.reason)));
      });

      upstream.addEventListener("error", () => {
        // A connect refusal (upstream not listening) surfaces here before
        // any close event. Tear down the client; the close listener above is
        // a no-op afterwards thanks to the `closed` latch.
        closeBoth(ws, state, 1011, "upstream error");
      });
    },

    message(ws, message) {
      const state = ws.data._bridge;
      if (!state || state.closed) return;
      const frame: string | Uint8Array =
        typeof message === "string" ? message : new Uint8Array(message);
      const { upstream } = state;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(frame);
        // Backpressure: the upstream isn't draining what the client sends.
        if (upstream.bufferedAmount > cap) {
          closeBoth(ws, state, 1011, "bridge backpressure cap exceeded");
        }
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        state.pending.push(frame);
        state.pendingBytes += frameBytes(frame);
        if (state.pendingBytes > cap) {
          closeBoth(ws, state, 1011, "bridge backpressure cap exceeded");
        }
      }
      // CLOSING / CLOSED: drop the frame — teardown is already in flight.
    },

    close(ws, code, reason) {
      // Client → upstream close propagation. Note: Bun's server-side close
      // callback delivers the client's close CODE but an empty `reason`
      // (verified on Bun 1.3.13), so only the code propagates upstream in
      // this direction. Upstream → client propagation (the close listener in
      // open()) carries both.
      const state = ws.data._bridge;
      if (!state || state.closed) return;
      state.closed = true;
      closeQuietly(() => state.upstream.close(sendableCloseCode(code), trimReason(reason)));
    },
  };
}
