/**
 * Loopback TCP-port readiness probe — the tiny "is something listening on
 * 127.0.0.1:<port>?" primitive shared by the detached `commands/lifecycle.ts`
 * start path and the in-process `supervisor.ts` (design 2026-06-01 §6.5).
 *
 * Factored out of `lifecycle.ts` so the supervisor can reach the probe without
 * importing all of lifecycle's heavy graph (hub-db, operator-token,
 * services-manifest, …) into a module that hub-server / proxy-state / the
 * module-ops API all depend on. `lifecycle.ts` re-exports `defaultPortListening`
 * + `PortListeningFn` so its public API is unchanged; both files share THIS
 * one implementation, so they can't drift.
 *
 * `node:net` rather than `Bun.connect` because the latter has no clean
 * "connection refused → false" without a custom socket handler, and the net
 * Socket's `error`/`connect` events map directly onto the boolean we want.
 */

import { Socket } from "node:net";

/**
 * "Is something listening on this TCP port on loopback?" seam. Pairs with the
 * spawn-then-die settle to catch the alive-but-never-bound failure shape
 * (hub#487): a service that lives long enough to clear a liveness check but
 * never binds its port (port already held by an orphan / a bun-linked
 * resolution failure that lingers). Tests inject a deterministic stub;
 * production uses {@link defaultPortListening}.
 */
export type PortListeningFn = (port: number) => Promise<boolean>;

/**
 * Connect-probe: open a TCP socket to 127.0.0.1:<port> and see if it's
 * accepted. A successful connect means *something* is listening; we close
 * immediately. Connection refused / timeout means nothing is bound yet.
 */
export const defaultPortListening: PortListeningFn = (port) =>
  new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
