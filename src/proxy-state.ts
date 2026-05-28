/**
 * Boot-readiness classifier for upstream proxy failures (hub#444).
 *
 * When `proxyRequest` in `hub-server.ts` gets a fetch error talking to a
 * module's loopback port, we want to differentiate two operator
 * experiences:
 *
 *   - **transient** — the module is *currently* booting and the loopback
 *     socket isn't bound yet (or is mid-restart). The right response is
 *     "wait a moment, refresh." A `parachute start hub` triggers this
 *     for the 5–15s window while modules are still coming up; without
 *     classification the wizard renders a hard `Bad gateway` JSON 502
 *     and operators panic.
 *
 *   - **persistent** — the module has been spawned long enough that it
 *     should be reachable, OR the supervisor declared it crashed, OR
 *     there's no live process at all. The right response is "something
 *     went wrong, check logs." Auto-retry would just spin the SPA.
 *
 * The classification consults the cheapest signals we already have:
 *
 *   1. Container-mode (`parachute serve`): the `Supervisor` knows
 *      lifecycle (`starting | running | stopped | crashed | restarting`)
 *      and `startedAt`. Walks the four-state vocabulary; restarting +
 *      starting are always transient, crashed/stopped are persistent,
 *      running is transient inside the boot window and persistent after.
 *
 *   2. On-box CLI mode (`parachute start <svc>`): no supervisor. We
 *      fall back to the pidfile state via `processState`. A live PID
 *      whose pidfile mtime is recent → transient. Live PID with an old
 *      pidfile → persistent (process is up but the listener went away).
 *      No pidfile / stale pidfile → persistent.
 *
 * The default boot window is 30s — long enough that vault's SQLite
 * pragma warmup + scribe's whisper-model load both finish inside it,
 * short enough that an operator who's been staring at a `Loading…`
 * spinner for 30+ seconds deserves the "something went wrong" page
 * rather than another "still booting" tease.
 */

import { CONFIG_DIR } from "./config.ts";
import { type ProcessState, processState } from "./process-state.ts";
import type { Supervisor } from "./supervisor.ts";

/** Classification result. */
export type UpstreamState = "transient" | "persistent";

/** Default boot window: a fetch failure within this many ms of the most
 * recent spawn timestamp counts as transient (still warming up). 30s
 * covers vault's SQLite pragma init + scribe's whisper model load with
 * margin. */
export const DEFAULT_BOOT_WINDOW_MS = 30_000;

export interface ClassifyOpts {
  /** Container-mode supervisor handle. Absent under on-box CLI mode. */
  supervisor?: Supervisor;
  /** Test seam over `Date.now()`. */
  now?: () => number;
  /** Test seam over `processState` (pidfile reader). */
  readProcessState?: (svc: string, configDir?: string) => ProcessState;
  /** Override config dir (test seam). Defaults to CONFIG_DIR. */
  configDir?: string;
  /** Override the boot window (test seam). Defaults to 30_000 ms. */
  bootWindowMs?: number;
}

/**
 * Classify why a loopback fetch to module `short` failed.
 *
 * `short` is the canonical short name (vault / scribe / notes / …) used as
 * the supervisor map key AND the per-service `~/.parachute/<short>/` config
 * directory key. Callers in `hub-server.ts` derive it from
 * `shortNameForManifest(entry.name)` and fall back to the entry's raw name
 * for unknown modules (third-party services with no canonical short — they
 * land in "persistent" by default since we have no boot-window signal).
 *
 * Returns "persistent" by default — when in doubt, don't auto-retry. The
 * worst outcome of a wrong "transient" classification is a JS poll that
 * never sees the module come up; the worst outcome of a wrong "persistent"
 * is an operator who has to refresh once. Persistent is the safer default.
 */
export function classifyUpstream(short: string, opts: ClassifyOpts = {}): UpstreamState {
  const now = (opts.now ?? Date.now)();
  const bootWindow = opts.bootWindowMs ?? DEFAULT_BOOT_WINDOW_MS;

  // 1. Supervisor (container mode) — authoritative when present.
  if (opts.supervisor) {
    const state = opts.supervisor.get(short);
    if (state) {
      switch (state.status) {
        case "starting":
        case "restarting":
          return "transient";
        case "crashed":
        case "stopped":
          return "persistent";
        case "running": {
          // Running but socket isn't answering. Inside the boot window
          // we assume the process hasn't bound its listener yet; after,
          // we assume the listener died.
          if (state.startedAt === undefined) return "persistent";
          const startedAt = Date.parse(state.startedAt);
          if (!Number.isFinite(startedAt)) return "persistent";
          return now - startedAt < bootWindow ? "transient" : "persistent";
        }
      }
    }
    // Module not tracked by supervisor — could be a third-party row or a
    // services.json entry that wasn't spawned at boot. Fall through to the
    // pidfile check (still useful if the operator launched it via `parachute
    // start` before this hub came up).
  }

  // 2. Pidfile (on-box CLI mode) — `~/.parachute/<short>/run/<short>.pid`.
  const readState = opts.readProcessState ?? processState;
  const configDir = opts.configDir ?? CONFIG_DIR;
  let ps: ProcessState;
  try {
    ps = readState(short, configDir);
  } catch {
    // pidfile read can race with cleanup; treat read errors as no signal.
    return "persistent";
  }
  if (ps.status === "running" && ps.startedAt) {
    const ageMs = now - ps.startedAt.getTime();
    return ageMs < bootWindow ? "transient" : "persistent";
  }
  // Stopped (stale pidfile), unknown (no pidfile) → persistent. No claim
  // of "currently booting" can be made without a fresh-mtime pidfile.
  return "persistent";
}
