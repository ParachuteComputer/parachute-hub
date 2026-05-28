/**
 * `GET /api/ready` — hub-side boot-readiness probe (hub#444).
 *
 * Public (no bearer required) — used by:
 *
 *   1. The transient-state HTML page rendered by the upstream-error
 *      flow (see `proxy-error-ui.ts`). Its inline poll script hits this
 *      endpoint every 2s up to 5 times so a wizard mid-boot can refresh
 *      itself without an HTML reload.
 *   2. Any third-party tool (smoke test, dashboard) that wants to know
 *      whether the hub's modules are all up.
 *
 * Shape:
 *
 *     {
 *       "ready": boolean,
 *       "ready_modules": string[],         // shorts that are up
 *       "transient_modules": string[],     // shorts currently booting
 *       "persistent_modules": string[]     // shorts crashed / stopped
 *     }
 *
 * `ready: true` iff every supervised module is in the "running" state
 * past its boot window AND no module is in transient/persistent
 * failure. The hub itself is implicit — if you reached this endpoint,
 * hub is up.
 *
 * Why public: the page that polls this is itself served pre-auth (a
 * 503 from a proxied request before the operator has even reached
 * /login). Bearer-gating would make the poll fail and the page sit
 * forever on "still loading."
 */

import { DEFAULT_BOOT_WINDOW_MS } from "./proxy-state.ts";
import type { Supervisor } from "./supervisor.ts";

export interface ApiReadyDeps {
  /** Container-mode supervisor handle. When absent the hub is in CLI
   *  mode and we report ready=true (we have no visibility into other
   *  processes' boot state). */
  supervisor?: Supervisor;
  /** Test seam over Date.now. */
  now?: () => number;
  /** Test seam over the boot window. */
  bootWindowMs?: number;
}

export function handleApiReady(req: Request, deps: ApiReadyDeps = {}): Response {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const now = (deps.now ?? Date.now)();
  const bootWindow = deps.bootWindowMs ?? DEFAULT_BOOT_WINDOW_MS;

  const ready: string[] = [];
  const transient: string[] = [];
  const persistent: string[] = [];

  if (deps.supervisor) {
    for (const m of deps.supervisor.list()) {
      switch (m.status) {
        case "starting":
        case "restarting":
          transient.push(m.short);
          break;
        case "crashed":
        case "stopped":
          persistent.push(m.short);
          break;
        case "running": {
          // Inside the boot window we report transient even though the
          // process is "running" — the listener may not have bound yet.
          // After the window we report ready (process is up + presumed
          // listening; if it's not, the proxy classifier still catches
          // it via the same window check and surfaces persistent state).
          let startedMs = 0;
          if (m.startedAt) {
            const parsed = Date.parse(m.startedAt);
            if (Number.isFinite(parsed)) startedMs = parsed;
          }
          if (startedMs > 0 && now - startedMs < bootWindow) {
            transient.push(m.short);
          } else {
            ready.push(m.short);
          }
          break;
        }
      }
    }
  }

  const isReady = transient.length === 0 && persistent.length === 0;
  const body = JSON.stringify({
    ready: isReady,
    ready_modules: ready,
    transient_modules: transient,
    persistent_modules: persistent,
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
