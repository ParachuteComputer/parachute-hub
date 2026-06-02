/**
 * Detect + disable STALE per-module autostart units during the
 * detached→supervised cutover + teardown (hub#522, design
 * `parachute.computer/design/2026-06-01-hub-as-supervisor-unification.md` §7.2).
 *
 * THE BUG (validated hands-on on friends.parachute.computer): after a box
 * migrates to the supervised model, a leftover STANDALONE per-module autostart
 * unit from the pre-supervisor era — a systemd user unit `parachute-vault.service`
 * with `Restart=always`, or a launchd `computer.parachute.vault` LaunchAgent with
 * `KeepAlive` — keeps RESPAWNING an unsupervised vault that binds port 1940. The
 * supervised hub's own vault child then can't bind → EADDRINUSE crash-loop →
 * `crashed`, giving up. Killing the squatting PROCESS is whack-a-mole: the unit's
 * KeepAlive / Restart=always resurrects it within seconds, serving OLD code.
 *
 * THE FIX (the load-bearing half of #522): the cutover must DISABLE THE UNIT, not
 * just kill the process. Disabling deregisters the keep-alive intent so the
 * module stays down and the supervised hub owns the port. The complementary half
 * — the supervisor reclaiming its own port on EADDRINUSE at every start — is a
 * separate follow-on; THIS module is the unit-disable that stops the respawn at
 * the source.
 *
 * SCOPE + OWNERSHIP SAFETY (the hard constraint): we ONLY ever disable a unit
 * whose name EXACTLY matches `parachute-<short>.service` (systemd) or
 * `computer.parachute.<short>` (launchd) for a KNOWN module short
 * (`knownServices()` — vault / scribe / runner / surface / notes / channel). We
 * NEVER disable an arbitrary or unrecognized unit — an unknown unit is invisible
 * to this sweep by construction (we look up exact names, never enumerate-and-
 * match-loosely). On top of that we EXPLICITLY exclude the units the supervised
 * model legitimately owns:
 *   - the hub unit (`computer.parachute.hub` / `parachute-hub.service`), and
 *   - the cloudflared connector (`computer.parachute.cloudflared.*` /
 *     `parachute-cloudflared-*`, owned by `expose off --cloudflare`).
 * The skip-list reuses the canonical name constants (HUB_* + the cloudflared
 * prefixes) so it can't drift.
 *
 * BEHAVIOR per platform (reuses the `ManagedUnitDeps` seam — `which` / `run`):
 *   - systemd (Linux): for each known short, query the USER unit
 *     `systemctl --user is-enabled parachute-<short>.service`. If it reads
 *     enabled (`enabled` / `enabled-runtime` / `static` / `alias`/`indirect`-ish)
 *     → `systemctl --user disable --now parachute-<short>.service`. A SYSTEM-level
 *     unit of the same name (detected via `systemctl is-enabled` without --user)
 *     is NOT touched (migrate has no sudo) — we WARN with the exact manual
 *     `sudo systemctl disable --now …` command instead.
 *   - launchd (Mac): for each known short, `launchctl print
 *     gui/<uid>/computer.parachute.<short>`; if the label is loaded → `launchctl
 *     bootout gui/<uid>/computer.parachute.<short>`.
 *
 * IDEMPOTENT: a unit that's already disabled / not-enabled / absent is a clean
 * no-op (we never report disabling it). NON-FATAL: a disable that fails (perms,
 * launchctl quirk) WARNS + continues — it never aborts the cutover. EVERYTHING
 * behind the injectable `ManagedUnitDeps` seam so tests never touch real
 * systemctl/launchctl.
 */

import {
  CLOUDFLARED_LAUNCHD_LABEL_PREFIX,
  CLOUDFLARED_SYSTEMD_UNIT_PREFIX,
} from "./cloudflare/connector-service.ts";
import {
  HUB_LAUNCHD_LABEL,
  HUB_SYSTEMD_UNIT_NAME,
  type ManagedUnitDeps,
  defaultManagedUnitDeps,
} from "./managed-unit.ts";
import { knownServices } from "./service-spec.ts";

/** systemd unit name for a module short, e.g. `vault` → `parachute-vault.service`. */
export function moduleSystemdUnitName(short: string): string {
  return `parachute-${short}.service`;
}

/** launchd label for a module short, e.g. `vault` → `computer.parachute.vault`. */
export function moduleLaunchdLabel(short: string): string {
  return `computer.parachute.${short}`;
}

/**
 * Is this systemd unit name one the supervised model legitimately owns (and the
 * sweep must therefore NEVER disable)? The hub unit + any cloudflared connector
 * unit. Reuses the canonical name constants so the skip can't drift.
 */
function isProtectedSystemdUnit(unitName: string): boolean {
  return unitName === HUB_SYSTEMD_UNIT_NAME || unitName.startsWith(CLOUDFLARED_SYSTEMD_UNIT_PREFIX);
}

/**
 * Is this launchd label one the supervised model legitimately owns? The hub
 * label + any cloudflared connector label (`computer.parachute.cloudflared.*`).
 */
function isProtectedLaunchdLabel(label: string): boolean {
  return (
    label === HUB_LAUNCHD_LABEL ||
    label === CLOUDFLARED_LAUNCHD_LABEL_PREFIX ||
    label.startsWith(`${CLOUDFLARED_LAUNCHD_LABEL_PREFIX}.`)
  );
}

/**
 * The module shorts whose stale standalone autostart units the sweep targets.
 * Derived from `knownServices()` (the canonical FIRST_PARTY_FALLBACKS +
 * KNOWN_MODULES list — vault / scribe / runner / surface / notes / channel), so
 * a future module is covered automatically. `hub` is deliberately NOT in that
 * list — the hub unit is the supervised model itself; we never disable it. As a
 * defensive double-check we also drop any short whose derived unit name lands in
 * the protected skip-list (so the sweep can never disable the hub / cloudflared
 * even if a future short collided).
 */
export function targetModuleShorts(): string[] {
  return knownServices().filter(
    (short) =>
      !isProtectedSystemdUnit(moduleSystemdUnitName(short)) &&
      !isProtectedLaunchdLabel(moduleLaunchdLabel(short)),
  );
}

/**
 * systemd `is-enabled` tokens that mean "this unit will autostart" — i.e. the
 * stale-unit problem we're disabling. `disabled` / `masked` / `not-found` (and a
 * nonzero exit with empty stdout) mean it won't, so they're a no-op.
 *
 * `static` and `indirect` units have no [Install] section / are pulled in by
 * another unit; a standalone leftover `parachute-vault.service` written by the
 * old per-module autostall path always carried `[Install] WantedBy=…` so reads
 * `enabled` — but we treat `static`/`indirect` as "present + active intent" too
 * so an oddly-written leftover still gets cleaned. `linked`/`generated` likewise.
 */
const SYSTEMD_ENABLED_TOKENS = new Set([
  "enabled",
  "enabled-runtime",
  "static",
  "indirect",
  "linked",
  "linked-runtime",
  "generated",
  "alias",
]);

/** Outcome of one unit's detect-and-disable attempt. */
export interface StaleUnitAction {
  /** The module short the unit belongs to. */
  short: string;
  /** "launchd" | "systemd-user" | "systemd-system". */
  kind: "launchd" | "systemd-user" | "systemd-system";
  /** The unit/label name acted on. */
  unit: string;
  /**
   * "disabled"     → we disabled it (report it; the operator sees what changed).
   * "warn-system"  → a system-level systemd unit we can't disable without sudo;
   *                  we warn with the manual command. Non-fatal.
   * "failed"       → the disable command failed (perms/quirk); we warn + continue.
   */
  result: "disabled" | "warn-system" | "failed";
  /** The exact line(s) the caller should surface (report / warning). */
  messages: string[];
}

export interface DisableStaleModuleUnitsOpts {
  /** Injectable platform deps (defaults to production). */
  deps?: ManagedUnitDeps;
  /** Sink for human-readable report / warning lines. */
  log?: (line: string) => void;
}

export interface DisableStaleModuleUnitsResult {
  /** Every unit we acted on (disabled / warned / failed). Empty = clean no-op. */
  actions: StaleUnitAction[];
}

/**
 * Detect + disable any STALE per-module autostart unit on this platform (#522).
 * Idempotent + non-fatal: already-disabled/absent units are silent no-ops, and a
 * failed disable warns + continues. Returns the list of actions taken; the caller
 * surfaces the messages (the cutover threads them through its own `log`).
 *
 * Dispatch mirrors `managed-unit.ts`: darwin → launchctl, linux → systemctl.
 * Other platforms (no per-module unit possible) → empty no-op.
 */
export function disableStaleModuleUnits(
  opts: DisableStaleModuleUnitsOpts = {},
): DisableStaleModuleUnitsResult {
  const deps = opts.deps ?? defaultManagedUnitDeps;
  const log = opts.log ?? (() => {});
  const actions: StaleUnitAction[] = [];

  const record = (action: StaleUnitAction): void => {
    actions.push(action);
    for (const m of action.messages) log(m);
  };

  if (deps.platform === "darwin") {
    if (deps.which("launchctl") === null) return { actions };
    const uid = deps.getuid() ?? 0;
    for (const short of targetModuleShorts()) {
      const label = moduleLaunchdLabel(short);
      // Belt-and-suspenders: never touch a protected (hub / cloudflared) label.
      if (isProtectedLaunchdLabel(label)) continue;
      const action = disableStaleLaunchdUnit(short, label, uid, deps);
      if (action) record(action);
    }
    return { actions };
  }

  if (deps.platform === "linux") {
    if (deps.which("systemctl") === null) return { actions };
    for (const short of targetModuleShorts()) {
      const unit = moduleSystemdUnitName(short);
      if (isProtectedSystemdUnit(unit)) continue;
      const action = disableStaleSystemdUnit(short, unit, deps);
      if (action) record(action);
    }
    return { actions };
  }

  // No per-platform manager (container / init-less / Windows) → nothing to do.
  return { actions };
}

/**
 * launchd arm: probe `launchctl print gui/<uid>/<label>`. The label is LOADED
 * (a stale KeepAlive LaunchAgent) when the print succeeds with non-empty output;
 * we then `launchctl bootout` it (unload + stop → KeepAlive can't resurrect it).
 * An unloaded/absent label prints empty/nonzero → clean no-op (returns undefined).
 */
function disableStaleLaunchdUnit(
  short: string,
  label: string,
  uid: number,
  deps: ManagedUnitDeps,
): StaleUnitAction | undefined {
  let printed: { code: number; stdout: string; stderr: string };
  try {
    printed = deps.run(["launchctl", "print", `gui/${uid}/${label}`]);
  } catch {
    // launchctl threw (ENOENT between which() and run, or a quirk) — non-fatal.
    return undefined;
  }
  // Not loaded → nothing to disable. `launchctl print` is nonzero + empty when
  // the label isn't bootstrapped.
  if (printed.stdout.trim().length === 0) return undefined;

  let booted: { code: number; stdout: string; stderr: string };
  try {
    booted = deps.run(["launchctl", "bootout", `gui/${uid}/${label}`]);
  } catch (err) {
    return {
      short,
      kind: "launchd",
      unit: label,
      result: "failed",
      messages: [
        `  ⚠ Could not disable the stale LaunchAgent ${label} (${err instanceof Error ? err.message : String(err)}).`,
        `    Run it yourself: launchctl bootout gui/${uid}/${label}`,
      ],
    };
  }
  if (booted.code !== 0) {
    const detail = booted.stderr.trim() || booted.stdout.trim() || "unknown error";
    return {
      short,
      kind: "launchd",
      unit: label,
      result: "failed",
      messages: [
        `  ⚠ Could not disable the stale LaunchAgent ${label} (${detail}).`,
        `    Run it yourself: launchctl bootout gui/${uid}/${label}`,
      ],
    };
  }
  return {
    short,
    kind: "launchd",
    unit: label,
    result: "disabled",
    messages: [
      `  ✓ Disabled stale ${label} (it was fighting the supervised hub for ${short}'s port).`,
    ],
  };
}

/**
 * systemd arm: a stale standalone module unit can live at USER scope (the common
 * pre-supervisor leftover, no sudo to write) or SYSTEM scope (rarer). We probe
 * both:
 *   - USER (`systemctl --user is-enabled <unit>`): if enabled → `--user disable
 *     --now`. This is the path migrate can actually fix.
 *   - SYSTEM (`systemctl is-enabled <unit>`): if enabled but USER wasn't → migrate
 *     has no sudo, so WARN with the exact `sudo systemctl disable --now …` command
 *     (never attempt sudo).
 * An absent/disabled unit at both scopes → clean no-op (returns undefined).
 */
function disableStaleSystemdUnit(
  short: string,
  unit: string,
  deps: ManagedUnitDeps,
): StaleUnitAction | undefined {
  // --- USER scope first (what migrate can actually disable). ---
  if (systemdUnitEnabled(unit, ["--user"], deps)) {
    let res: { code: number; stdout: string; stderr: string };
    try {
      res = deps.run(["systemctl", "--user", "disable", "--now", unit]);
    } catch (err) {
      return {
        short,
        kind: "systemd-user",
        unit,
        result: "failed",
        messages: [
          `  ⚠ Could not disable the stale user unit ${unit} (${err instanceof Error ? err.message : String(err)}).`,
          `    Run it yourself: systemctl --user disable --now ${unit}`,
        ],
      };
    }
    if (res.code !== 0) {
      const detail = res.stderr.trim() || res.stdout.trim() || "unknown error";
      return {
        short,
        kind: "systemd-user",
        unit,
        result: "failed",
        messages: [
          `  ⚠ Could not disable the stale user unit ${unit} (${detail}).`,
          `    Run it yourself: systemctl --user disable --now ${unit}`,
        ],
      };
    }
    return {
      short,
      kind: "systemd-user",
      unit,
      result: "disabled",
      messages: [
        `  ✓ Disabled stale ${unit} (it was fighting the supervised hub for ${short}'s port).`,
      ],
    };
  }

  // --- SYSTEM scope: detect-only + warn (no sudo in migrate). ---
  if (systemdUnitEnabled(unit, [], deps)) {
    return {
      short,
      kind: "systemd-system",
      unit,
      result: "warn-system",
      messages: [
        `  ⚠ A SYSTEM-level ${unit} is enabled and may fight the supervised hub for ${short}'s port.`,
        "    Migrate can't disable a system unit (it needs root). Disable it yourself:",
        `      sudo systemctl disable --now ${unit}`,
      ],
    };
  }

  return undefined;
}

/**
 * `systemctl [--user] is-enabled <unit>` → true iff the printed token means the
 * unit will autostart (see `SYSTEMD_ENABLED_TOKENS`). `is-enabled` exits nonzero
 * for non-enabled states and prints the token to stdout regardless of exit, so
 * we classify from the stdout token. A throw (ENOENT/quirk) → treated as
 * not-enabled (non-fatal; the sweep continues).
 */
function systemdUnitEnabled(unit: string, scope: string[], deps: ManagedUnitDeps): boolean {
  let res: { code: number; stdout: string; stderr: string };
  try {
    res = deps.run(["systemctl", ...scope, "is-enabled", unit]);
  } catch {
    return false;
  }
  const token = res.stdout.trim() || res.stderr.trim();
  if (token.length === 0) return false;
  // `is-enabled` can print the token then a hint on a second line; read line 1.
  const first = token.split("\n")[0]?.trim() ?? "";
  return SYSTEMD_ENABLED_TOKENS.has(first);
}
