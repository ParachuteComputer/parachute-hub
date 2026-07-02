/**
 * Hub instance identity + loopback-hijack detection (hub#737).
 *
 * ## The incident this defends against (2026-07-02 P0)
 *
 * The hub binds `*:1939` (INADDR_ANY / `0.0.0.0`). An OrbStack Linux machine
 * auto-forwarded ITS port 1939 onto the host as a SPECIFIC bind on
 * `127.0.0.1:1939` — and a specific loopback bind WINS over a wildcard bind for
 * all loopback traffic. Every module's JWKS/API call to `127.0.0.1:1939`
 * silently reached the WRONG hub (a fresh container DB → empty JWKS, no admin),
 * so every hub-JWT validation failed `no applicable key found in the JWKS` and
 * the ecosystem 401-looped for hours. `lsof -nP -i :1939` showed two LISTENs;
 * the tell was `/health` reporting the container's version, not the checkout's.
 *
 * ## The primitive: a per-process instance nonce
 *
 * Each `parachute serve` process generates a random nonce at boot, (a) exposes
 * it as `instance` in `/health`, and (b) writes it to
 * `~/.parachute/hub-instance.json` (0644). That file is the linchpin: an
 * EXTERNAL process (`parachute status`, `parachute doctor`) can learn THIS
 * hub's true identity from disk WITHOUT traversing the (possibly hijacked)
 * loopback — then compare it to what a loopback `GET /health` actually returns.
 * A mismatch means another process owns `127.0.0.1:<port>`.
 *
 * The in-process self-probe (armed by `serve`) compares its own in-memory nonce
 * to the loopback `/health` it fetches, logs loudly on mismatch, and records the
 * verdict back into the same file's `selfProbe` field so external tools surface
 * the serve process's own authoritative reading without re-probing.
 *
 * Every side effect (fs, network probe) is behind an injectable seam so the
 * whole module runs deterministically in tests with no real network / disk.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/** The public incident reference operators grep for. */
export const HIJACK_INCIDENT_REF = "hub#737 / team-vault Log/2026-07-02-port-exhaustion-incident";

/** Self-probe verdicts. `ok` = loopback reaches us; `hijacked` = someone else owns loopback. */
export type SelfProbeStatus = "ok" | "hijacked" | "unreachable";

/**
 * The serve process's own most-recent loopback self-probe reading, persisted
 * into the instance file so external readers (`status`) see the authoritative
 * verdict without re-probing the (possibly hijacked) loopback themselves.
 */
export interface SelfProbeState {
  status: SelfProbeStatus;
  /** ISO timestamp of the reading. */
  checkedAt: string;
  /** The `instance` the loopback `/health` actually returned (present on a `hijacked` reading). */
  observedInstance?: string;
  /** One-line human detail (loud message on a hijack; the probe error class on unreachable). */
  detail?: string;
}

/** The `~/.parachute/hub-instance.json` record. */
export interface HubInstanceRecord {
  /** Per-process random nonce (`crypto.randomUUID`) minted at serve boot. */
  instance: string;
  /** The serve process PID (informational — helps an operator map the file to a process). */
  pid: number;
  /** The port this serve bound. */
  port: number;
  /** ISO timestamp of serve boot. */
  startedAt: string;
  /** Last self-probe reading, patched in by the running serve process. */
  selfProbe?: SelfProbeState;
}

/** Mint a fresh per-process nonce. */
export function generateInstanceNonce(): string {
  return randomUUID();
}

/** Path to the instance file under a config dir (default `~/.parachute`). */
export function hubInstancePath(configDir: string = CONFIG_DIR): string {
  return join(configDir, "hub-instance.json");
}

/**
 * Atomically write the instance record (tmp + rename, 0644). Best-effort: a
 * write failure must NEVER take the hub down — the file is a diagnostic aid, not
 * a load-bearing runtime dependency. Returns true on success.
 */
export function writeHubInstanceFile(
  record: HubInstanceRecord,
  opts: { configDir?: string; log?: (line: string) => void } = {},
): boolean {
  const path = hubInstancePath(opts.configDir);
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
    renameSync(tmp, path);
    return true;
  } catch (err) {
    opts.log?.(
      `parachute serve: could not write ${path} (${err instanceof Error ? err.message : String(err)}); loopback-hijack detection for external tools is degraded, hub start continues.`,
    );
    return false;
  }
}

/**
 * Read + validate the instance file. Returns null on absence / unreadable /
 * malformed — a missing file is the benign "no nonce-aware serve wrote one yet"
 * state, never an error.
 */
export function readHubInstanceFile(configDir: string = CONFIG_DIR): HubInstanceRecord | null {
  const path = hubInstancePath(configDir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.instance !== "string" || r.instance.length === 0) return null;
  if (typeof r.port !== "number") return null;
  const rec: HubInstanceRecord = {
    instance: r.instance,
    pid: typeof r.pid === "number" ? r.pid : -1,
    port: r.port,
    startedAt: typeof r.startedAt === "string" ? r.startedAt : "",
  };
  const sp = r.selfProbe;
  if (sp && typeof sp === "object") {
    const s = sp as Record<string, unknown>;
    if (s.status === "ok" || s.status === "hijacked" || s.status === "unreachable") {
      const state: SelfProbeState = {
        status: s.status,
        checkedAt: typeof s.checkedAt === "string" ? s.checkedAt : "",
      };
      if (typeof s.observedInstance === "string") state.observedInstance = s.observedInstance;
      if (typeof s.detail === "string") state.detail = s.detail;
      rec.selfProbe = state;
    }
  }
  return rec;
}

/** The result of probing a loopback `/health`. */
export interface LoopbackProbe {
  /** The socket answered at all (any HTTP status). */
  reachable: boolean;
  /** HTTP status, when reachable. */
  status?: number;
  /** The `instance` field of the JSON body, when present + parseable. */
  instance?: string;
  /** True when the body self-identifies as a parachute hub (`service: "parachute-hub"`). */
  isHub?: boolean;
}

/**
 * Probe `http://127.0.0.1:<port>/health` and extract the instance identity.
 * Bounded (default 1.5s); never throws — a network error is `{ reachable: false }`.
 */
export async function probeLoopbackInstance(
  port: number,
  opts: { timeoutMs?: number; fetchFn?: typeof fetch } = {},
): Promise<LoopbackProbe> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    const out: LoopbackProbe = { reachable: true, status: res.status };
    try {
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.instance === "string") out.instance = body.instance;
      if (body.service === "parachute-hub") out.isHub = true;
    } catch {
      // A non-JSON / unparseable body still counts as "reachable" — a foreign
      // process answering the port with junk is exactly the hijack shape.
    }
    return out;
  } catch {
    return { reachable: false };
  }
}

/**
 * Classify a loopback probe against our TRUE nonce.
 *   - not reachable                → `unreachable` (we bound, but loopback refused/timed out — suspicious but soft).
 *   - reachable, instance === ours → `ok`.
 *   - reachable, instance !== ours → `hijacked` (a DIFFERENT process owns loopback: another hub, or a foreign
 *     server answering `/health` with no/other instance — the OrbStack-shadow class).
 */
export function classifyLoopback(ourNonce: string, probe: LoopbackProbe): SelfProbeStatus {
  if (!probe.reachable) return "unreachable";
  if (probe.instance === ourNonce) return "ok";
  return "hijacked";
}

/**
 * The LOUD, structured hijack alert. Names the class + the exact diagnosis
 * commands + the incident reference so an operator scanning logs can act
 * immediately. Repeated verbatim on every probe while mismatched (by design —
 * a single line scrolls away; a hijack is a standing emergency).
 */
export function hijackAlertMessage(port: number, observedInstance?: string): string {
  const observed = observedInstance
    ? `a DIFFERENT hub (instance=${observedInstance})`
    : "a foreign process (no hub instance nonce in its /health)";
  return [
    `parachute serve: LOOPBACK HIJACK on 127.0.0.1:${port} — this hub bound the port but loopback /health is answered by ${observed}.`,
    "  Loopback traffic (module JWKS/API calls, CLI probes) is NOT reaching this hub — every hub-JWT validation downstream will fail.",
    `  A specific 127.0.0.1:${port} bind (commonly an OrbStack/container port-forward) wins over this hub's wildcard bind.`,
    `  Diagnose:  lsof -nP -iTCP:${port} -sTCP:LISTEN   (expect ONE listener — this hub)`,
    `             orb list   (stop/delete any VM auto-forwarding ${port}, e.g. a leftover smoke-test machine)`,
    `  Incident:  ${HIJACK_INCIDENT_REF}`,
  ].join("\n");
}

/** The softer "we're listening but loopback didn't answer" note (logged once per state change). */
export function unreachableNote(port: number): string {
  return `parachute serve: loopback /health on 127.0.0.1:${port} did not answer, yet this hub is bound — transient, or another process is interfering with loopback. Watching (will re-probe).`;
}

// ---------------------------------------------------------------------------
// Self-probe timer (armed by `serve` after the listener is up)
// ---------------------------------------------------------------------------

export interface HubSelfProbe {
  /** Stop the interval. */
  stop(): void;
  /** Run exactly one probe now (used for the immediate startup check + tests). */
  probeOnce(): Promise<SelfProbeStatus>;
  /** The most recent in-memory verdict (tests). */
  getState(): SelfProbeState | undefined;
}

export interface HubSelfProbeDeps<H = unknown> {
  /** Poll cadence in ms. Default 300_000 (5 min) — a safety net, not a hot path. */
  intervalMs?: number;
  /** Loopback probe (default {@link probeLoopbackInstance}). */
  probe?: (port: number) => Promise<LoopbackProbe>;
  /** Persist the verdict (default: patch the instance file's `selfProbe`). */
  writeState?: (state: SelfProbeState) => void;
  /** Loud log sink (default `console.error`). */
  log?: (line: string) => void;
  /** Clock seam (default `() => new Date()`). */
  now?: () => Date;
  /** Injectable scheduler (default `setInterval`). Tests drive ticks manually. */
  setIntervalFn?: (cb: () => void, ms: number) => H;
  /** Injectable clear (default `clearInterval`). */
  clearIntervalFn?: (handle: H) => void;
}

/**
 * Arm the loopback self-probe. On each tick (and on the immediate startup
 * `probeOnce`) it fetches loopback `/health`, compares the returned instance to
 * OUR nonce, logs per the incident-severity rules, and persists the verdict:
 *
 *   - `hijacked`   → LOUD structured alert EVERY tick (standing emergency), verdict persisted.
 *   - `unreachable`→ softer note, logged ONLY on a state change (avoid a spinning log on a flaky loopback).
 *   - `ok`         → recovery line logged once when clearing a prior non-ok verdict.
 *
 * The verdict is written to the instance file's `selfProbe` field so external
 * tools (`status`) read the authoritative reading without re-probing the
 * hijacked loopback. Overlapping ticks are guarded (a slow probe never stacks).
 * The interval is `unref`'d so it never keeps the event loop alive on its own.
 */
export function armHubSelfProbe<H = ReturnType<typeof setInterval>>(
  args: { port: number; nonce: string; record: HubInstanceRecord; configDir?: string },
  deps: HubSelfProbeDeps<H> = {},
): HubSelfProbe {
  const { port, nonce, record } = args;
  const intervalMs = deps.intervalMs ?? 300_000;
  const probe = deps.probe ?? probeLoopbackInstance;
  const log = deps.log ?? ((line: string) => console.error(line));
  const now = deps.now ?? (() => new Date());
  const writeState =
    deps.writeState ??
    ((state: SelfProbeState) =>
      writeHubInstanceFile(
        { ...record, selfProbe: state },
        { ...(args.configDir !== undefined ? { configDir: args.configDir } : {}), log },
      ));
  const setIntervalFn =
    deps.setIntervalFn ?? ((cb: () => void, ms: number) => setInterval(cb, ms) as unknown as H);
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((h: H) => clearInterval(h as unknown as ReturnType<typeof setInterval>));

  let last: SelfProbeState | undefined;
  let inFlight = false;

  async function probeOnce(): Promise<SelfProbeStatus> {
    if (inFlight) return last?.status ?? "ok";
    inFlight = true;
    try {
      const result = await probe(port);
      const status = classifyLoopback(nonce, result);
      const state: SelfProbeState = { status, checkedAt: now().toISOString() };
      if (status === "hijacked") {
        if (result.instance !== undefined) state.observedInstance = result.instance;
        state.detail = hijackAlertMessage(port, result.instance);
        // LOUD every tick — a hijack is a standing emergency, not a one-shot notice.
        log(state.detail);
      } else if (status === "unreachable") {
        state.detail = unreachableNote(port);
        if (last?.status !== "unreachable") log(state.detail);
      } else {
        // ok — announce recovery once when clearing a prior non-ok verdict.
        if (last && last.status !== "ok") {
          log(
            `parachute serve: loopback /health on 127.0.0.1:${port} is back to this hub (instance=${nonce}). Hijack cleared.`,
          );
        }
      }
      last = state;
      try {
        writeState(state);
      } catch {
        // Persisting the verdict is best-effort; the loud log already fired.
      }
      return status;
    } finally {
      inFlight = false;
    }
  }

  const handle = setIntervalFn(() => {
    void probeOnce();
  }, intervalMs);
  (handle as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearIntervalFn(handle);
    },
    probeOnce,
    getState() {
      return last;
    },
  };
}
