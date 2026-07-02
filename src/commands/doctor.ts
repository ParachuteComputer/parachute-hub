/**
 * `parachute doctor` — health / diagnostics for a Parachute install.
 *
 * The one command that answers "is my Parachute healthy, and if not, what's
 * the one thing to fix?" Today operators piece that together from `parachute
 * status`, log tailing, and tribal knowledge; `doctor` is the single readout.
 *
 * ## The load-bearing constraint (#717)
 *
 * Doctor MUST NOT false-positive on a fresh or fully-current install. In the
 * past the migration checker suggested "things need migrating" on a clean box
 * purely because it hadn't been taught about newer features — an "anything I
 * don't recognize = broken" design. That class of bug is unacceptable here.
 *
 * Design rule, enforced check-by-check below: **positively detect a known-bad
 * condition; never treat "unfamiliar" or "not configured" as a failure.**
 *   - Distinguish *feature-not-configured* (→ PASS / benign info) from
 *     *configured-but-broken* (→ FAIL).
 *   - Migration checks reuse the existing ALLOWLIST detectors (`migrateNotice`
 *     / `hasPriorDetachedInstall`) which only flag explicitly-known cruft — a
 *     fresh root flags nothing.
 *   - Version drift (services.json cached vs live package.json, hub#243) is
 *     WARN at most, never FAIL, and labeled cosmetic.
 *   - Exposure checks only run when expose-state says the box is exposed;
 *     a loopback-only box reads "loopback only" as benign info (PASS), never
 *     a warning.
 *
 * The headline guarantee is the fresh-install fixture test: a sandboxed
 * PARACHUTE_HOME with a minimal-but-current services.json + a valid
 * operator.token → ALL GREEN, zero WARN/FAIL.
 *
 * ## Reuse, not reinvention
 *
 * Doctor stitches together primitives the rest of the hub already owns rather
 * than re-deriving them: `status.ts`'s liveness-probe shape (2xx OR 401 = live,
 * #700), `migrate.ts`'s allowlist detectors, `operator-token.ts`'s known-issuer
 * set, `services-manifest.ts`'s strict parse, `service-spec.ts`'s startCmd
 * resolution, and depcheck's `ensureExecutable` for the +x check (channel#41).
 *
 * Every external read (network probe, manager query, fs) is bounded + degrades
 * gracefully and is behind an injectable seam so tests drive it without a real
 * network/manager/db call — same discipline as `status.ts`.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  type MissingDependencyError,
  NonExecutableError,
  ensureExecutable,
} from "@openparachute/depcheck";
import { decodeJwt } from "jose";
import { CONFIG_DIR, SERVICES_MANIFEST_PATH } from "../config.ts";
import { type ExposeState, readExposeState } from "../expose-state.ts";
import { HUB_SVC, readHubPort } from "../hub-control.ts";
import {
  HIJACK_INCIDENT_REF,
  type HubInstanceRecord,
  type LoopbackProbe,
  probeLoopbackInstance,
  readHubInstanceFile,
} from "../hub-instance.ts";
import {
  HUB_UNIT_DEFAULT_PORT,
  type HubUnitDeps,
  type HubUnitStateResult,
  defaultHubUnitDeps,
  queryHubUnitState as queryHubUnitStateImpl,
} from "../hub-unit.ts";
import { hasPriorDetachedInstall } from "../migrate-offer.ts";
import { buildKnownIssuersForOperatorToken, operatorTokenPath } from "../operator-token.ts";
import {
  canonicalPortForManifest,
  getSpec,
  getSpecFromInstallDir,
  shortNameForManifest,
} from "../service-spec.ts";
import {
  type ServiceEntry,
  ServicesManifestError,
  readManifest,
  readManifestLenient,
  writeManifest,
} from "../services-manifest.ts";
import { migrateNotice } from "./migrate.ts";

// ---------------------------------------------------------------------------
// Check model
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  /** Stable identifier (e.g. "hub-reachable") — what `--json` consumers key on. */
  name: string;
  /** Human-readable check title for the grouped report. */
  title: string;
  status: CheckStatus;
  /** One-line detail explaining the verdict. */
  detail: string;
  /** A copy-pasteable fix-it command, when there is one. */
  fix?: string;
}

/** A logical group of checks in the human report. */
const GROUP_ORDER = ["Hub", "Modules", "Configuration", "Migration", "Exposure"] as const;
type Group = (typeof GROUP_ORDER)[number];

interface GroupedCheck extends CheckResult {
  group: Group;
}

// ---------------------------------------------------------------------------
// Injectable deps (test seam) — mirrors status.ts's `supervisor` block. Every
// real-world side effect (network probe, manager query, fs read of the token,
// PATH resolution) is injectable so the whole command runs deterministically
// in tests with no network / launchd / systemd / real ~/.parachute touched.
// ---------------------------------------------------------------------------

export interface DoctorDeps {
  /**
   * Probe the loopback hub `/health`. True on any answer that proves the hub is
   * serving. Production reuses the bounded 1.5s fetch shape from status.ts.
   */
  probeHubHealth?: (port: number) => Promise<boolean>;
  /**
   * Unauthenticated module-liveness probe (#700): `http://127.0.0.1:<port><health>`.
   * Treats 2xx AND 401 as live (auth-gated health = healthy, #423). Bounded;
   * never throws.
   */
  probeModuleHealth?: (port: number, health: string) => Promise<boolean>;
  /**
   * Probe a public origin's `/health` (Tier-2 exposure reachability). Bounded;
   * follows redirects off-box is NOT chased — we only care that the hub answers.
   * Returns false on any network error / non-live status.
   */
  probePublicHealth?: (origin: string) => Promise<boolean>;
  /** Query the platform manager for the hub unit's run-state. */
  queryHubUnitState?: (deps: HubUnitDeps) => HubUnitStateResult;
  /** Deps passed to `queryHubUnitState`. Default production. */
  hubUnitDeps?: HubUnitDeps;
  /**
   * PATH resolver for the module-bin exec-bit check (`ensureExecutable`).
   * Production is `Bun.which`; tests inject a stub so the check runs without
   * the real module binaries on the test host's PATH.
   */
  which?: (binary: string) => string | null;
  /**
   * #634 secondary probe for the exec-bit check: when `which` returns null,
   * find a present-but-non-executable file on PATH. Production lets depcheck's
   * real PATH walk run; tests inject to drive the non-executable branch.
   */
  findNonExecutable?: (binary: string) => string | null;
  /** Clock seam for date-stamped detectors (migrate). */
  now?: () => Date;
  /**
   * TTY check for `--fix`'s confirmation gate. Production reads
   * `process.stdin.isTTY && process.stdout.isTTY`; tests inject to drive both
   * the interactive (confirm) and non-interactive (bail without `--yes`) paths.
   */
  isInteractive?: () => boolean;
  /**
   * Read a line of input for the `--fix` confirmation prompt. Production wraps
   * readline; tests inject a canned answer.
   */
  readLine?: (prompt: string) => Promise<string>;
  /**
   * Loopback-hijack check (hub#737): read THIS hub's on-disk identity
   * (`hub-instance.json`, written by the running `serve`). Default
   * {@link readHubInstanceFile}; tests inject a fixture record (or null).
   */
  readInstanceRecord?: (configDir: string) => HubInstanceRecord | null;
  /**
   * Loopback-hijack check: probe `127.0.0.1:<port>/health` and read its
   * `instance`. Default {@link probeLoopbackInstance}; tests inject the
   * matched / mismatched / unreachable outcomes.
   */
  probeLoopbackInstance?: (port: number) => Promise<LoopbackProbe>;
  /**
   * Loopback-hijack check: count LISTEN sockets on the hub port (a second
   * listener is the OrbStack-shadow fingerprint). Default shells `lsof`;
   * returns `undefined` when it can't determine a count (lsof absent / errored)
   * so the check degrades to the instance comparison alone. Tests inject a count.
   */
  countHubListeners?: (port: number) => number | undefined;
}

export interface DoctorOpts {
  configDir?: string;
  manifestPath?: string;
  print?: (line: string) => void;
  /** Emit a single JSON object instead of the human report. */
  json?: boolean;
  /**
   * Repair canonical-port drift in services.json (and ONLY that — every other
   * check stays report-only). Shows the diff, confirms in a TTY (or `--yes`),
   * bails in a non-TTY without `--yes`. Idempotent: a clean file is a no-op.
   */
  fix?: boolean;
  /** Skip the `--fix` confirmation prompt (required in a non-TTY). */
  yes?: boolean;
  deps?: DoctorDeps;
}

// ---------------------------------------------------------------------------
// Default real-world deps
// ---------------------------------------------------------------------------

/** Bounded loopback `/health` probe — 2xx is live. Mirrors hub-unit's default. */
async function defaultProbeHubHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Bounded module `/health` probe — 2xx OR 401 is live (#700 / #423). */
async function defaultProbeModuleHealth(port: number, health: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${health}`, {
      signal: AbortSignal.timeout(1500),
      redirect: "manual",
    });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

/** Bounded public-origin `/health` probe — 2xx OR 401 is live (auth-gated hub). */
async function defaultProbePublicHealth(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(4000),
    });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

/**
 * Count LISTEN sockets on `port` via `lsof`. A hijack shows TWO (this hub's
 * wildcard bind + the shadowing process's specific loopback bind). Bounded +
 * best-effort: returns `undefined` on any failure (lsof absent, non-zero exit,
 * unparseable) so the check degrades to the instance-comparison signal alone
 * rather than false-flagging. Counts DISTINCT pids across the LISTEN rows.
 */
function defaultCountHubListeners(port: number): number | undefined {
  try {
    const proc = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpP"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    // lsof exits non-zero when there are zero matches — that's a real "0", not
    // an error. Only treat a missing binary (spawn failure) as indeterminate.
    if (proc.exitCode !== 0 && (proc.stdout?.length ?? 0) === 0) return 0;
    const text = new TextDecoder().decode(proc.stdout ?? new Uint8Array());
    const pids = new Set<string>();
    for (const line of text.split("\n")) {
      if (line.startsWith("p")) pids.add(line.slice(1));
    }
    return pids.size;
  } catch {
    return undefined;
  }
}

/** Both ends of the pipe must be a TTY for an interactive confirm to make sense. */
function defaultIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Readline-backed line reader for the `--fix` confirmation prompt. */
async function defaultReadLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

interface ResolvedDeps {
  probeHubHealth: (port: number) => Promise<boolean>;
  probeModuleHealth: (port: number, health: string) => Promise<boolean>;
  probePublicHealth: (origin: string) => Promise<boolean>;
  queryHubUnitState: (deps: HubUnitDeps) => HubUnitStateResult;
  hubUnitDeps: HubUnitDeps;
  which: (binary: string) => string | null;
  findNonExecutable: ((binary: string) => string | null) | undefined;
  now: () => Date;
  isInteractive: () => boolean;
  readLine: (prompt: string) => Promise<string>;
  readInstanceRecord: (configDir: string) => HubInstanceRecord | null;
  probeLoopbackInstance: (port: number) => Promise<LoopbackProbe>;
  countHubListeners: (port: number) => number | undefined;
}

function resolveDeps(d: DoctorDeps | undefined): ResolvedDeps {
  return {
    probeHubHealth: d?.probeHubHealth ?? defaultProbeHubHealth,
    probeModuleHealth: d?.probeModuleHealth ?? defaultProbeModuleHealth,
    probePublicHealth: d?.probePublicHealth ?? defaultProbePublicHealth,
    queryHubUnitState: d?.queryHubUnitState ?? queryHubUnitStateImpl,
    hubUnitDeps: d?.hubUnitDeps ?? defaultHubUnitDeps,
    which: d?.which ?? Bun.which,
    findNonExecutable: d?.findNonExecutable,
    now: d?.now ?? (() => new Date()),
    isInteractive: d?.isInteractive ?? defaultIsInteractive,
    readLine: d?.readLine ?? defaultReadLine,
    readInstanceRecord: d?.readInstanceRecord ?? readHubInstanceFile,
    probeLoopbackInstance: d?.probeLoopbackInstance ?? probeLoopbackInstance,
    countHubListeners: d?.countHubListeners ?? defaultCountHubListeners,
  };
}

// ---------------------------------------------------------------------------
// Tier 1 checks
// ---------------------------------------------------------------------------

/**
 * Hub supervisor reachable on :1939. The hub is the substrate every module
 * runs under, so a down hub is the single most actionable failure. We compose
 * the platform-manager view (`queryHubUnitState`) with the `/health` probe the
 * same way `status.ts` does, but render a doctor verdict:
 *   - `/health` answers → PASS (it's serving; manager nuance is informational).
 *   - manager says `failed` → FAIL (surface the exit code).
 *   - manager says `active`/`activating` but no `/health` → FAIL (wedged/starting).
 *   - no manager (container) + no `/health` → FAIL.
 *   - manager `inactive`/`no-unit` + no `/health` → FAIL ("hub is not running").
 * Never throws — a manager-query failure degrades to the `/health` verdict.
 */
async function checkHubReachable(configDir: string, deps: ResolvedDeps): Promise<CheckResult> {
  const port = readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT;
  let healthy = false;
  try {
    healthy = await deps.probeHubHealth(port);
  } catch {
    healthy = false;
  }

  if (healthy) {
    return {
      name: "hub-reachable",
      title: `Hub supervisor reachable on :${port}`,
      status: "pass",
      detail: `hub answered /health on http://127.0.0.1:${port}`,
    };
  }

  // Not answering /health — consult the manager for a more specific verdict.
  let managerState: HubUnitStateResult["state"] = "unknown";
  let lastExitCode: number | undefined;
  try {
    const q = deps.queryHubUnitState(deps.hubUnitDeps);
    managerState = q.state;
    lastExitCode = q.lastExitCode;
  } catch {
    managerState = "unknown";
  }

  const fix = "parachute start hub";
  if (managerState === "failed") {
    return {
      name: "hub-reachable",
      title: `Hub supervisor reachable on :${port}`,
      status: "fail",
      detail:
        lastExitCode !== undefined
          ? `service manager reports the hub unit failed (last exit code ${lastExitCode})`
          : "service manager reports the hub unit failed",
      fix,
    };
  }
  if (managerState === "active" || managerState === "activating") {
    return {
      name: "hub-reachable",
      title: `Hub supervisor reachable on :${port}`,
      status: "fail",
      detail:
        "service manager reports the hub unit up, but /health isn't answering (starting or wedged)",
      fix: "parachute restart hub",
    };
  }
  return {
    name: "hub-reachable",
    title: `Hub supervisor reachable on :${port}`,
    status: "fail",
    detail: `hub is not running — nothing answered /health on http://127.0.0.1:${port}`,
    fix,
  };
}

/**
 * Loopback-hijack detection (hub#737) — the 2026-07-02 P0's root trigger. This
 * hub binds `*:<port>` (wildcard); a foreign process that grabs a SPECIFIC
 * `127.0.0.1:<port>` bind (classically an OrbStack VM auto-forwarding the port)
 * WINS all loopback traffic, so every module's JWKS/API call silently reaches
 * the wrong hub. Detection compares THIS hub's on-disk identity nonce
 * (`hub-instance.json`, written by `serve`) to what a loopback `/health`
 * actually returns:
 *   - no instance file → the running hub predates nonce detection, or isn't
 *     running under `serve` (the Hub check owns "down") → PASS (benign info,
 *     never a false FAIL per #717).
 *   - loopback not answering → defer to the Hub check → PASS (info).
 *   - loopback nonce === ours → loopback reaches THIS hub. A second LISTEN on
 *     the port (lsof) is a latent shadow → WARN; a single listener → PASS.
 *   - loopback nonce ≠ ours (or missing) → ACTIVE HIJACK → FAIL with the exact
 *     lsof/orb remediation + the incident reference. Detect-only (no `--fix`).
 * Never throws — every read is bounded + degrades to a benign verdict.
 */
async function checkLoopbackHijack(configDir: string, deps: ResolvedDeps): Promise<CheckResult> {
  const port = readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT;
  const title = `No loopback hijack on :${port}`;

  let record: HubInstanceRecord | null = null;
  try {
    record = deps.readInstanceRecord(configDir);
  } catch {
    record = null;
  }
  if (!record) {
    return {
      name: "loopback-hijack",
      title,
      status: "pass",
      detail:
        "no hub-instance.json — the running hub predates loopback-nonce detection or isn't running under `parachute serve` (see the Hub check)",
    };
  }

  let probe: LoopbackProbe;
  try {
    probe = await deps.probeLoopbackInstance(port);
  } catch {
    probe = { reachable: false };
  }
  if (!probe.reachable) {
    return {
      name: "loopback-hijack",
      title,
      status: "pass",
      detail: `loopback /health on 127.0.0.1:${port} didn't answer — nothing to compare (the Hub check covers a down hub)`,
    };
  }

  // Reachable but a DIFFERENT identity answers → active hijack.
  if (probe.instance !== record.instance) {
    let listeners: number | undefined;
    try {
      listeners = deps.countHubListeners(port);
    } catch {
      listeners = undefined;
    }
    const who = probe.instance
      ? `a different hub (instance ${probe.instance})`
      : "a foreign process (its /health carries no hub instance nonce)";
    const listenerNote =
      listeners !== undefined && listeners > 1
        ? ` lsof shows ${listeners} listeners on the port.`
        : "";
    return {
      name: "loopback-hijack",
      title,
      status: "fail",
      detail: `loopback 127.0.0.1:${port} is answered by ${who}, NOT this hub (instance ${record.instance}) — module JWKS/API calls are reaching the wrong hub.${listenerNote} Incident: ${HIJACK_INCIDENT_REF}`,
      fix: `lsof -nP -iTCP:${port} -sTCP:LISTEN  # find the shadow; then \`orb list\` and stop any VM auto-forwarding ${port}`,
    };
  }

  // Loopback reaches us. A second listener is a latent shadow that could win the
  // next reboot — WARN so the operator clears it before it flips to a FAIL.
  let listeners: number | undefined;
  try {
    listeners = deps.countHubListeners(port);
  } catch {
    listeners = undefined;
  }
  if (listeners !== undefined && listeners > 1) {
    return {
      name: "loopback-hijack",
      title,
      status: "warn",
      detail: `loopback reaches this hub, but lsof shows ${listeners} listeners on :${port} — a second bind is a latent shadow that could win loopback after a restart`,
      fix: `lsof -nP -iTCP:${port} -sTCP:LISTEN  # identify + stop the extra listener (e.g. \`orb list\`)`,
    };
  }
  return {
    name: "loopback-hijack",
    title,
    status: "pass",
    detail: `loopback 127.0.0.1:${port}/health returns this hub's instance nonce${
      listeners === 1 ? " (single listener)" : ""
    }`,
  };
}

/**
 * Each CONFIGURED module alive via its own loopback `/health` (2xx OR 401).
 * Only modules present in services.json are checked — an absent module is
 * "feature-not-configured," never a failure. When the hub itself is down every
 * child is down with it, so we surface a single WARN pointing at the hub fix
 * rather than N module FAILs that are all really the one hub problem.
 *
 * A configured-but-not-answering module on a healthy hub is a real FAIL.
 */
async function checkModulesAlive(
  manifest: { services: ServiceEntry[] },
  hubHealthy: boolean,
  deps: ResolvedDeps,
): Promise<CheckResult[]> {
  const modules = manifest.services;
  if (modules.length === 0) {
    return [
      {
        name: "modules-alive",
        title: "Configured modules alive",
        status: "pass",
        detail: "no modules installed yet — nothing to check",
      },
    ];
  }

  if (!hubHealthy) {
    // The hub is down → every supervised child is down WITH it. Don't pile N
    // module FAILs on top of the one real problem (the hub check already FAILed).
    return [
      {
        name: "modules-alive",
        title: "Configured modules alive",
        status: "warn",
        detail: "skipped — the hub is down, so its modules are stopped too (fix the hub first)",
        fix: "parachute start hub",
      },
    ];
  }

  const results = await Promise.all(
    modules.map(async (entry): Promise<CheckResult> => {
      let alive = false;
      try {
        alive = await deps.probeModuleHealth(entry.port, entry.health);
      } catch {
        alive = false;
      }
      const short = shortNameForManifest(entry.name) ?? entry.name;
      if (alive) {
        return {
          name: `module-alive:${short}`,
          title: `Module ${short} alive`,
          status: "pass",
          detail: `answered ${entry.health} on http://127.0.0.1:${entry.port}`,
        };
      }
      return {
        name: `module-alive:${short}`,
        title: `Module ${short} alive`,
        status: "fail",
        detail: `${short} is configured (services.json) but didn't answer ${entry.health} on :${entry.port}`,
        fix: `parachute restart ${short}`,
      };
    }),
  );
  return results;
}

/**
 * services.json parses + required fields valid. A MISSING manifest is the fresh
 * pre-install state, not a failure → PASS with benign info. A PRESENT but
 * malformed manifest is configured-but-broken → FAIL with the parser's own
 * diagnostic (we read strictly here precisely to surface the error; the rest of
 * doctor reads leniently so one bad row doesn't sink every other check).
 */
function checkServicesManifest(manifestPath: string): CheckResult {
  // Probe presence FIRST so we can tell apart absent (→ fresh-install PASS)
  // from present-but-malformed (→ FAIL below). Without this split a missing
  // services.json would reach readManifest's throw and be reported as
  // "malformed" — a false positive on the fresh install we must never flag.
  try {
    readFileSync(manifestPath, "utf8");
  } catch {
    // ENOENT (or unreadable) — treat absence as the fresh, pre-install state.
    return {
      name: "services-manifest",
      title: "services.json parses + valid",
      status: "pass",
      detail: "no services.json yet — fresh install (nothing configured)",
    };
  }
  try {
    const manifest = readManifest(manifestPath);
    return {
      name: "services-manifest",
      title: "services.json parses + valid",
      status: "pass",
      detail: `parsed ${manifest.services.length} service${manifest.services.length === 1 ? "" : "s"}, all required fields valid`,
    };
  } catch (err) {
    const message =
      err instanceof ServicesManifestError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      name: "services-manifest",
      title: "services.json parses + valid",
      status: "fail",
      detail: `services.json is malformed: ${message}`,
      fix: `edit ${manifestPath} to fix the offending entry`,
    };
  }
}

// ---------------------------------------------------------------------------
// Canonical-port-drift detection (read) + repair (`--fix`).
//
// Two drift shapes, both produced by legacy services.json files written before
// the duplicate-port validation gate (or hand-edits):
//   1. A KNOWN module whose row port ≠ its canonical port (SERVICE_SPECS).
//   2. Two services sharing one port (the silent-miswire class, hub#195) —
//      with the multi-vault carve-out (one vault process, N mounts, one port).
//
// THE #717 RULE applies hard here: canonical ports are DERIVED from the
// service registry (`canonicalPortForManifest`, which reads SERVICE_SPECS /
// KNOWN_MODULES + FIRST_PARTY_FALLBACKS), never a hardcoded map — so adding a
// future service can't make this check false-positive on a fresh box. A
// third-party / unknown service with NO canonical port is benign info, never
// a drift WARN: we don't flag what has no canonical to drift from.
//
// IMPORTANT — why this reads RAW rows, not `readManifest` / `readManifestLenient`:
// the exact drift this command exists to repair (a duplicate-port pair in a
// legacy services.json) is precisely what those readers HEAL away before we'd
// ever see it — the strict reader THROWS on a duplicate port, the lenient
// reader DROPS one of the colliding rows. To detect (and let `--fix` repair)
// that pre-gate state, drift logic operates on the raw JSON rows, validating
// only the minimal `{name, port}` shape each row needs. The shape-level
// `services-manifest` check still surfaces a genuinely malformed file.
// ---------------------------------------------------------------------------

/** Minimal row shape drift logic needs — satisfied by both `ServiceEntry`
 *  and a raw parsed JSON row. */
interface PortRow {
  name: string;
  port: number;
}

/** One service whose row port doesn't match its registry-canonical port. */
export interface PortDrift {
  /** services.json row name (manifestName, e.g. `parachute-vault`). */
  name: string;
  /** Short name for display, when resolvable. */
  short?: string;
  /** The current (drifted) port in services.json. */
  current: number;
  /** The registry-canonical port this service should be on. */
  canonical: number;
}

export interface PortDriftReport {
  /** Services on a non-canonical port (KNOWN modules only — unknowns skipped). */
  drifted: PortDrift[];
  /**
   * Ports claimed by ≥2 distinct (non-vault) services — a hard collision. Each
   * entry lists the conflicting row names. Multi-vault rows sharing 1940 are
   * NOT a collision and are excluded (the same carve-out the manifest gate uses).
   */
  duplicates: { port: number; names: string[] }[];
}

function isVaultRowName(name: string): boolean {
  return name === "parachute-vault" || name.startsWith("parachute-vault-");
}

/**
 * Read services.json as raw `{name, port}` rows WITHOUT the manifest readers'
 * duplicate-port heal (strict throws, lenient drops). Returns [] when the file
 * is absent (fresh install) or can't be parsed into rows — drift logic then
 * reports "no drift", and the shape-level `services-manifest` check owns the
 * malformed-file FAIL. Only rows with a string name + integer port are
 * returned; anything else isn't part of the drift bug class.
 */
function readRawPortRows(manifestPath: string): PortRow[] {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  const services = (raw as Record<string, unknown>).services;
  if (!Array.isArray(services)) return [];
  const rows: PortRow[] = [];
  for (const row of services) {
    if (!row || typeof row !== "object") continue;
    const name = (row as Record<string, unknown>).name;
    const port = (row as Record<string, unknown>).port;
    if (typeof name !== "string" || typeof port !== "number" || !Number.isInteger(port)) continue;
    rows.push({ name, port });
  }
  return rows;
}

/**
 * Pure drift computation over a manifest's rows. Derives every canonical port
 * from the service registry (`canonicalPortForManifest`) — no hardcoded port
 * map, so the source of truth can't drift from this check. Returns both
 * non-canonical-port rows (KNOWN modules only) and duplicate-port collisions
 * (with the multi-vault carve-out). Pure: no fs, no mutation.
 */
export function computePortDrift(services: readonly PortRow[]): PortDriftReport {
  const drifted: PortDrift[] = [];
  for (const entry of services) {
    const canonical = canonicalPortForManifest(entry.name);
    // No canonical port for this name → benign, skip. Covers unknown/third-party
    // services AND named multi-vault rows (`parachute-vault-<name>`), which
    // canonicalPortForManifest deliberately returns undefined for (documented
    // gap in service-spec.ts → shortNameForManifest). So a named vault is never
    // flagged as drifted; multi-vault-on-1940 is the carve-out handled below.
    if (canonical === undefined) continue;
    if (entry.port !== canonical) {
      const drift: PortDrift = { name: entry.name, current: entry.port, canonical };
      const short = shortNameForManifest(entry.name);
      if (short !== undefined) drift.short = short;
      drifted.push(drift);
    }
  }

  // Duplicate-port detection — group distinct service names by port, excluding
  // the deliberate multi-vault case (N vault rows on one port is by design).
  const byPort = new Map<number, string[]>();
  for (const entry of services) {
    const names = byPort.get(entry.port) ?? [];
    if (!names.includes(entry.name)) names.push(entry.name);
    byPort.set(entry.port, names);
  }
  const duplicates: { port: number; names: string[] }[] = [];
  for (const [port, names] of byPort) {
    if (names.length < 2) continue;
    // All-vault rows on one port is the multi-vault carve-out, not a collision.
    if (names.every(isVaultRowName)) continue;
    duplicates.push({ port, names });
  }

  return { drifted, duplicates };
}

/**
 * Canonical-port-drift check (read-only). WARN (advisory — the box may work,
 * the operator may have moved a service deliberately) when any KNOWN module
 * sits off its canonical port OR two services collide on one port. A clean
 * file → PASS. Unknown/third-party services with no canonical port are never
 * flagged (#717 — no canonical, no drift signal).
 */
function checkPortDrift(manifestPath: string): CheckResult {
  const { drifted, duplicates } = computePortDrift(readRawPortRows(manifestPath));
  if (drifted.length === 0 && duplicates.length === 0) {
    return {
      name: "port-drift",
      title: "Services on canonical ports",
      status: "pass",
      detail: "all services are on their canonical ports — no drift",
    };
  }
  const parts: string[] = [];
  for (const d of drifted) {
    parts.push(`${d.short ?? d.name} is on :${d.current} (canonical :${d.canonical})`);
  }
  for (const dup of duplicates) {
    parts.push(`port :${dup.port} is claimed by ${dup.names.join(" + ")}`);
  }
  return {
    name: "port-drift",
    title: "Services on canonical ports",
    status: "warn",
    detail: `canonical-port drift: ${parts.join("; ")}`,
    fix: "parachute doctor --fix",
  };
}

/**
 * operator.token exists, parses, and its `iss` matches a hub-legitimate issuer.
 *
 * Absent token → PASS/info (a box that hasn't created its first admin yet, or
 * one that never minted an operator token — feature-not-configured, NOT broken;
 * `parachute status` / `auth set-password` is the path, doctor doesn't force it).
 *
 * Present token:
 *   - undecodable / no `iss` claim → FAIL (corrupt credential).
 *   - `iss` matches the hub's known-issuer SET (loopback aliases ∪ expose-state
 *     public origin ∪ platform origin — the SAME set the live auth path uses,
 *     `buildKnownIssuersForOperatorToken`) → PASS.
 *   - `iss` is foreign to that set → FAIL: the recurring "not signed in to the
 *     hub" / issuer-mismatch class (hub#481). Fix is `start hub` (self-heals)
 *     or `auth rotate-operator`.
 *
 * Deliberately a DECODE-only `iss` check, not a full signature/JWKS validation:
 * doctor must run without a live hub or DB, and an unsigned-but-decodable token
 * still tells us the issuer-mismatch story. The known-issuer set is the same
 * one the real validation layers `iss` against on top of the signature check.
 */
function checkOperatorToken(configDir: string): CheckResult {
  const path = operatorTokenPath(configDir);
  let token: string;
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    return {
      name: "operator-token",
      title: "operator.token valid + issuer matches",
      status: "pass",
      detail:
        "no operator.token yet — fine for a box that hasn't created its first admin (run `parachute auth set-password` when ready)",
    };
  }
  if (token.length === 0) {
    return {
      name: "operator-token",
      title: "operator.token valid + issuer matches",
      status: "pass",
      detail: "operator.token is empty — treated as not configured",
    };
  }

  let iss: string | undefined;
  try {
    const payload = decodeJwt(token);
    iss = typeof payload.iss === "string" ? payload.iss : undefined;
  } catch {
    return {
      name: "operator-token",
      title: "operator.token valid + issuer matches",
      status: "fail",
      detail: `operator.token at ${path} is not a decodable JWT`,
      fix: "parachute auth rotate-operator",
    };
  }
  if (!iss) {
    return {
      name: "operator-token",
      title: "operator.token valid + issuer matches",
      status: "fail",
      detail: "operator.token has no `iss` claim",
      fix: "parachute auth rotate-operator",
    };
  }

  // Build the issuer set the live auth path validates against (loopback aliases
  // ∪ expose-state public origin ∪ platform origin). Seed with the resolved
  // loopback issuer so a never-exposed box still has its own loopback in the set.
  const seedIssuer = `http://127.0.0.1:${readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT}`;
  let knownIssuers: readonly string[] = [];
  try {
    knownIssuers = buildKnownIssuersForOperatorToken(configDir, seedIssuer);
  } catch {
    knownIssuers = [seedIssuer];
  }
  if (knownIssuers.includes(iss)) {
    return {
      name: "operator-token",
      title: "operator.token valid + issuer matches",
      status: "pass",
      detail: `operator.token issuer (${iss}) matches the hub`,
    };
  }
  return {
    name: "operator-token",
    title: "operator.token valid + issuer matches",
    status: "fail",
    detail: `operator.token issuer (${iss}) doesn't match any origin this hub answers on — the "not signed in to the hub" class. Expected one of: ${knownIssuers.join(", ")}`,
    fix: "parachute start hub  # self-heals the issuer; or `parachute auth rotate-operator`",
  };
}

/**
 * Module bin resolvable via `Bun.which` (exec bit present) — the 100644
 * start-failure class (channel#41): a module whose `bin` lost its +x bit
 * resolves to null under `Bun.which` (which requires X_OK), so the supervisor
 * reports "<binary> not installed" despite an intact symlink + services.json.
 *
 * For each configured module we resolve its startCmd binary the SAME way the
 * supervisor does (spec.startCmd over the entry; module.json wins when
 * installDir is stamped) and run depcheck's `ensureExecutable`:
 *   - resolves cleanly → PASS.
 *   - `NonExecutableError` (present but no +x) → FAIL with the `chmod +x` fix —
 *     the exact bug this check exists for.
 *   - `MissingDependencyError` (genuinely not on PATH) → FAIL (reinstall).
 *
 * A module whose spec has no resolvable startCmd (CLI-only module, unreadable
 * module.json) is SKIPPED — there's no bin to check, and "no startCmd" is not a
 * broken-bin condition. Modules with no spec at all (third-party, no fallback)
 * are likewise skipped — we can't know their bin name, and absence of knowledge
 * is never a failure (the #717 rule).
 */
async function checkModuleBins(
  manifest: { services: ServiceEntry[] },
  deps: ResolvedDeps,
): Promise<CheckResult[]> {
  const checks = await Promise.all(
    manifest.services.map(async (entry): Promise<CheckResult | undefined> => {
      const short = shortNameForManifest(entry.name);
      if (!short) return undefined; // third-party / unknown — no bin to reason about.
      const binary = await resolveStartBinary(short, entry);
      if (!binary) return undefined; // CLI-only module / unreadable module.json — nothing to check.

      try {
        const ensureOpts: Parameters<typeof ensureExecutable>[1] = { which: deps.which };
        if (deps.findNonExecutable) ensureOpts.findNonExecutable = deps.findNonExecutable;
        ensureExecutable(binary, ensureOpts);
        return {
          name: `module-bin:${short}`,
          title: `Module ${short} bin executable`,
          status: "pass",
          detail: `${binary} resolves on PATH with the exec bit set`,
        };
      } catch (err) {
        if (err instanceof NonExecutableError) {
          return {
            name: `module-bin:${short}`,
            title: `Module ${short} bin executable`,
            status: "fail",
            detail: `${binary} is present at ${err.path} but is NOT executable (lost its +x bit) — the supervisor will report it "not installed"`,
            fix: `chmod +x ${err.path}`,
          };
        }
        // MissingDependencyError (or anything else) → the bin isn't resolvable.
        const missing = err as MissingDependencyError;
        const why =
          typeof missing?.message === "string"
            ? missing.message.split("\n")[0]
            : `${binary} not found on PATH`;
        return {
          name: `module-bin:${short}`,
          title: `Module ${short} bin executable`,
          status: "fail",
          detail: `${binary} for module ${short} isn't resolvable on PATH: ${why}`,
          fix: `parachute install ${short}  # reinstall the module`,
        };
      }
    }),
  );
  const present = checks.filter((c): c is CheckResult => c !== undefined);
  if (present.length === 0) {
    return [
      {
        name: "module-bins",
        title: "Module bins executable",
        status: "pass",
        detail: "no first-party module bins to check",
      },
    ];
  }
  return present;
}

/**
 * Resolve the startCmd binary (`cmd[0]`) for a configured module, mirroring the
 * supervisor's resolution: module.json wins when installDir is stamped, else the
 * imperative spec startCmd. Returns undefined when there's no spec or no
 * resolvable startCmd (CLI-only / unreadable manifest). Never throws.
 */
async function resolveStartBinary(short: string, entry: ServiceEntry): Promise<string | undefined> {
  let spec = getSpec(short);
  if (entry.installDir) {
    try {
      const resolved = await getSpecFromInstallDir(entry.installDir, entry.name);
      if (resolved) spec = resolved;
    } catch {
      // Unreadable / malformed module.json — fall back to the imperative spec.
    }
  }
  if (!spec?.startCmd) return undefined;
  let cmd: readonly string[] | undefined;
  try {
    cmd = spec.startCmd(entry);
  } catch {
    return undefined;
  }
  return cmd && cmd.length > 0 ? cmd[0] : undefined;
}

/**
 * Migration via the SAFE detectors only (never a "scan for unfamiliar files"
 * approach — that's the exact false-positive class #717 forbids):
 *   - `hasPriorDetachedInstall` — a pidfile (the detached-era fingerprint).
 *     A supervised/fresh box writes none → no warning. WARN (not FAIL): the
 *     box still works; doctor nudges toward the supervised cutover.
 *   - `migrateNotice` — the allowlist archive detector. Only flags entries
 *     matching an explicit KNOWN_CRUFT rule; a fresh root flags nothing. WARN.
 *
 * Both clean → a single PASS.
 */
function checkMigration(
  configDir: string,
  manifestPath: string,
  deps: ResolvedDeps,
): CheckResult[] {
  const out: CheckResult[] = [];

  let priorDetached = false;
  try {
    priorDetached = hasPriorDetachedInstall(configDir, manifestPath);
  } catch {
    priorDetached = false;
  }
  if (priorDetached) {
    out.push({
      name: "migration-detached",
      title: "Legacy detached install detected",
      status: "warn",
      detail:
        "this box has a prior detached-model install (pidfiles present) — the current hub runs supervised under a process manager",
      fix: "parachute migrate --to-supervised",
    });
  }

  let notice: string | undefined;
  try {
    notice = migrateNotice(configDir, deps.now());
  } catch {
    notice = undefined;
  }
  if (notice) {
    out.push({
      name: "migration-cruft",
      title: "Archivable cruft at ecosystem root",
      status: "warn",
      detail: notice.replace(/^parachute migrate: /, "").replace(/ — run.*$/, ""),
      fix: "parachute migrate",
    });
  }

  if (out.length === 0) {
    out.push({
      name: "migration",
      title: "Migration",
      status: "pass",
      detail: "no legacy detached install, no archivable cruft at the ecosystem root",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tier 2 checks (guarded hard — never FAIL on not-configured)
// ---------------------------------------------------------------------------

/**
 * Exposure reachability + issuer consistency — ONLY when expose-state says the
 * box is exposed. If NOT exposed → benign "loopback only" info (PASS, never
 * WARN): a box reachable only on loopback is a legitimate, common configuration.
 *
 * When exposed:
 *   - missing `hubOrigin` in expose-state → WARN (cosmetic — we can't verify
 *     reachability without it, but the box may well be fine).
 *   - public origin answers `/health` → PASS.
 *   - public origin doesn't answer → WARN (not FAIL): the tunnel may be mid-
 *     bring-up, or an upstream CDN/bot-protection may shape server-to-server
 *     probes (the known Cloudflare-bot-protection class) — doctor flags it for
 *     attention without declaring the install broken.
 */
async function checkExposure(configDir: string, deps: ResolvedDeps): Promise<CheckResult> {
  let state: ExposeState | undefined;
  try {
    state = readExposeState(`${configDir}/expose-state.json`);
  } catch {
    // A malformed expose-state.json must not crash doctor; treat as not-exposed
    // info (the malformed-file case is the operator's to clear, and the CLI's
    // own ExposeStateError surfaces it elsewhere).
    return {
      name: "exposure",
      title: "Exposure",
      status: "pass",
      detail: "expose-state.json is unreadable — treating as loopback only",
    };
  }

  if (!state) {
    return {
      name: "exposure",
      title: "Exposure",
      status: "pass",
      detail: "loopback only — not exposed to a tailnet or the public internet (this is fine)",
    };
  }

  const origin = state.hubOrigin;
  if (!origin) {
    return {
      name: "exposure",
      title: "Exposure reachable",
      status: "warn",
      detail: `exposed (${state.layer}) but expose-state has no hubOrigin to verify reachability`,
    };
  }

  let reachable = false;
  try {
    reachable = await deps.probePublicHealth(origin);
  } catch {
    reachable = false;
  }
  if (reachable) {
    return {
      name: "exposure",
      title: "Exposure reachable",
      status: "pass",
      detail: `public origin ${origin} answers /health`,
    };
  }
  return {
    name: "exposure",
    title: "Exposure reachable",
    status: "warn",
    detail: `exposed at ${origin} but it didn't answer /health — the tunnel may be starting, or upstream bot-protection may be shaping the probe`,
    fix: "parachute expose <layer>  # re-bring-up the exposure if it's down",
  };
}

/**
 * Version drift (hub#243) — WARN at most, never FAIL, and labeled cosmetic.
 * services.json caches each module's version string; on a bun-linked checkout
 * that can lag the live package.json after a rebuild. Purely cosmetic — the
 * running code is whatever the bundle is, not the cached string. We only flag
 * the obvious shape (cached `0.0.0-linked` stopgap) so the check stays
 * positive-detection: a cached real version we have no live value to compare
 * against is NOT flagged (we don't have status.ts's install-source machinery
 * wired here, and guessing would risk a false WARN — #717).
 */
function checkVersionDrift(manifest: { services: ServiceEntry[] }): CheckResult {
  const stopgaps = manifest.services.filter((s) => s.version === "0.0.0-linked");
  if (stopgaps.length === 0) {
    return {
      name: "version-drift",
      title: "Version freshness (cosmetic)",
      status: "pass",
      detail: "no obvious version-drift markers in services.json",
    };
  }
  const names = stopgaps.map((s) => shortNameForManifest(s.name) ?? s.name).join(", ");
  return {
    name: "version-drift",
    title: "Version freshness (cosmetic)",
    status: "warn",
    detail: `services.json still has the install-time stopgap version "0.0.0-linked" for: ${names} (cosmetic — the running code is the live bundle)`,
    fix: "parachute restart <module>  # lets the module re-stamp its real version",
  };
}

// ---------------------------------------------------------------------------
// Orchestration + rendering
// ---------------------------------------------------------------------------

/**
 * Run every check and return them grouped, in report order. Pure-ish: reads fs
 * + (stubbable) network, never mutates. The hub-reachability probe runs once
 * and gates the module-liveness check (a down hub means every child is down).
 */
async function runChecks(
  configDir: string,
  manifestPath: string,
  deps: ResolvedDeps,
): Promise<GroupedCheck[]> {
  // Lenient manifest read for the checks that iterate modules — a single bad
  // row must not sink hub/operator/migration checks. The STRICT parse is the
  // services-manifest check's own job (it WANTS to surface the parse error).
  const manifest = readManifestLenient(manifestPath);

  const hub = await checkHubReachable(configDir, deps);
  const hubHealthy = hub.status === "pass";

  const [hijack, modules, bins, exposure] = await Promise.all([
    checkLoopbackHijack(configDir, deps),
    checkModulesAlive(manifest, hubHealthy, deps),
    checkModuleBins(manifest, deps),
    checkExposure(configDir, deps),
  ]);
  const manifestCheck = checkServicesManifest(manifestPath);
  const portDrift = checkPortDrift(manifestPath);
  const operator = checkOperatorToken(configDir);
  const migration = checkMigration(configDir, manifestPath, deps);
  const versionDrift = checkVersionDrift(manifest);

  const grouped: GroupedCheck[] = [];
  const add = (group: Group, checks: CheckResult[]) => {
    for (const c of checks) grouped.push({ ...c, group });
  };
  add("Hub", [hub, hijack]);
  add("Modules", [...modules, ...bins]);
  add("Configuration", [manifestCheck, portDrift, operator]);
  add("Migration", migration);
  add("Exposure", [exposure, versionDrift]);
  return grouped;
}

const MARK: Record<CheckStatus, string> = { pass: "✓", warn: "⚠", fail: "✗" };

function renderHuman(checks: GroupedCheck[], print: (line: string) => void): void {
  print("parachute doctor — health check");
  print("");
  for (const group of GROUP_ORDER) {
    const inGroup = checks.filter((c) => c.group === group);
    if (inGroup.length === 0) continue;
    print(`${group}:`);
    for (const c of inGroup) {
      print(`  ${MARK[c.status]} ${c.title}`);
      print(`      ${c.detail}`);
      if (c.fix) print(`      fix: ${c.fix}`);
    }
    print("");
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const passes = checks.filter((c) => c.status === "pass").length;
  if (fails === 0 && warns === 0) {
    print(`All clear — ${passes} check${passes === 1 ? "" : "s"} passed.`);
  } else {
    const parts: string[] = [`${passes} ok`];
    if (warns > 0) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
    if (fails > 0) parts.push(`${fails} failure${fails === 1 ? "" : "s"}`);
    print(`Summary: ${parts.join(", ")}.`);
    if (fails === 0) print("No failures — warnings are advisory.");
  }
}

function renderJson(checks: GroupedCheck[], print: (line: string) => void): void {
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  const passes = checks.filter((c) => c.status === "pass").length;
  const payload = {
    ok: fails === 0,
    summary: { pass: passes, warn: warns, fail: fails },
    checks: checks.map((c) => ({
      name: c.name,
      group: c.group,
      title: c.title,
      status: c.status,
      detail: c.detail,
      ...(c.fix ? { fix: c.fix } : {}),
    })),
  };
  print(JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// `doctor --fix` — the ONLY writing path. Repairs canonical-port drift in
// services.json and nothing else (every other check stays report-only). The
// guards, all load-bearing:
//   - SHOW THE DIFF first (old→new per service) so the operator sees the exact
//     change before it lands.
//   - CONFIRMATION-GATED: a TTY prompts y/N; `--yes` skips the prompt; a
//     non-TTY WITHOUT `--yes` bails (exit non-zero) with a hint, never writing.
//   - IDEMPOTENT: a clean file is "no drift, nothing to fix", exit 0.
//   - PRESERVES every field + the writer's formatting: it parses the RAW rows
//     (so a duplicate-port legacy file — which `readManifest` would THROW on
//     and `readManifestLenient` would DROP a row from — is repairable), mutates
//     ONLY the `port` of drifted rows, and writes back through `writeManifest`
//     (atomic tmp+rename, trailing-newline formatting). Optional/unknown fields
//     (displayName, tagline, stripPrefix, …) round-trip untouched.
//   - Duplicate-port collisions are REPORTED (not separately auto-resolved):
//     fixing canonical drift often clears the collision on its own (both rows
//     move to distinct canonical slots); any residual collision is surfaced for
//     the operator rather than guessed at.
// ---------------------------------------------------------------------------

async function fixPortDrift(
  manifestPath: string,
  opts: { yes: boolean; print: (line: string) => void; deps: ResolvedDeps },
): Promise<number> {
  const { print, deps } = opts;

  // Read the RAW file — not through readManifest (throws on dup ports) or
  // readManifestLenient (drops a colliding row). We need the pre-gate shape to
  // repair it.
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    // Absent (ENOENT) / unreadable services.json is the fresh pre-install
    // state, not a corrupt file — there's no drift to fix. Idempotent no-op.
    print("No canonical-port drift — nothing to fix.");
    return 0;
  }
  // A genuinely unparseable / wrong-shape file → bail (the read-only
  // `services-manifest` check surfaces the parse error in the report).
  let parsed: { services: Record<string, unknown>[] };
  try {
    const raw = JSON.parse(text) as unknown;
    if (
      !raw ||
      typeof raw !== "object" ||
      !Array.isArray((raw as { services?: unknown }).services)
    ) {
      throw new Error('expected an object with a "services" array');
    }
    parsed = raw as { services: Record<string, unknown>[] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    print(`parachute doctor --fix: can't read services.json — ${message}`);
    print("Fix the file by hand first; --fix only rewrites canonical-port drift.");
    return 1;
  }

  // Compute drift from the SAME parsed object we'll mutate below (one read —
  // no read-it-twice window where the file could change between detection and
  // rewrite). Filter to the minimal {name, port} rows computePortDrift needs.
  const portRows: PortRow[] = [];
  for (const row of parsed.services) {
    const name = row.name;
    const port = row.port;
    if (typeof name === "string" && typeof port === "number" && Number.isInteger(port)) {
      portRows.push({ name, port });
    }
  }
  const { drifted, duplicates } = computePortDrift(portRows);

  // Report any duplicate-port collisions up front (not separately auto-fixed —
  // canonical-drift repair below usually clears them by moving each row to its
  // own canonical slot).
  for (const dup of duplicates) {
    print(
      `note: port :${dup.port} is shared by ${dup.names.join(" + ")} — fixing canonical drift below; verify each ends on a unique port.`,
    );
  }

  // Idempotent: clean (no off-canonical rows) → no-op, exit 0.
  if (drifted.length === 0) {
    print("No canonical-port drift — nothing to fix.");
    return 0;
  }

  // Show the diff BEFORE applying — the operator sees exactly what changes.
  print("Canonical-port drift to repair:");
  for (const d of drifted) {
    print(`  ${d.short ?? d.name}: :${d.current} → :${d.canonical}`);
  }
  print("");

  // Confirmation gate. `--yes` skips it; otherwise a TTY prompts and a non-TTY
  // bails (never write without the operator seeing the change).
  if (!opts.yes) {
    if (!deps.isInteractive()) {
      print("Refusing to rewrite services.json without confirmation in a non-interactive shell.");
      print("Re-run with --yes to apply, or run interactively to confirm.");
      return 1;
    }
    const answer = (await deps.readLine("Apply these port changes? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      print("Aborted — services.json unchanged.");
      return 1;
    }
  }

  // Apply: mutate ONLY the port of drifted rows on the raw parsed object;
  // every other field round-trips verbatim. Write through `writeManifest`, which
  // JSON.stringifies the object as-is (no field filtering) + does the atomic
  // tmp+rename + trailing-newline formatting — so unknown/optional fields are
  // preserved. The cast is to satisfy writeManifest's parameter type; we never
  // rely on the raw rows actually being well-formed ServiceEntry objects (a
  // malformed sibling row round-trips untouched, same as it was on disk).
  const canonicalByName = new Map(drifted.map((d) => [d.name, d.canonical]));
  const next = {
    services: parsed.services.map((row) => {
      const canonical = typeof row.name === "string" ? canonicalByName.get(row.name) : undefined;
      return canonical === undefined ? row : { ...row, port: canonical };
    }),
  };
  writeManifest(next as unknown as { services: ServiceEntry[] }, manifestPath);
  print(`Rewrote ${drifted.length} service port${drifted.length === 1 ? "" : "s"} to canonical.`);
  print("Run `parachute doctor` to see the full health report.");
  return 0;
}

/**
 * `parachute doctor`. Returns the process exit code: 0 when no check FAILs
 * (WARN is allowed), non-zero on any FAIL. Never throws — every check is
 * individually wrapped + degrades gracefully, so doctor is itself a reliable
 * diagnostic regardless of the box's state.
 *
 * `--fix` is the one writing mode: it repairs canonical-port drift in
 * services.json (and ONLY that) behind a show-diff + confirmation gate, then
 * returns its own exit code without running the full diagnostic report.
 */
export async function doctor(opts: DoctorOpts = {}): Promise<number> {
  const configDir = opts.configDir ?? CONFIG_DIR;
  const manifestPath = opts.manifestPath ?? SERVICES_MANIFEST_PATH;
  const print = opts.print ?? ((line) => console.log(line));
  const deps = resolveDeps(opts.deps);

  if (opts.fix) {
    return await fixPortDrift(manifestPath, { yes: opts.yes ?? false, print, deps });
  }

  const checks = await runChecks(configDir, manifestPath, deps);
  if (opts.json) {
    renderJson(checks, print);
  } else {
    renderHuman(checks, print);
  }
  const anyFail = checks.some((c) => c.status === "fail");
  return anyFail ? 1 : 0;
}
