/**
 * Shared port-orphan ATTRIBUTION — the safety crux behind every adopt-kill in
 * the hub.
 *
 * Two lifecycle sites reclaim a module's port from a process the supervisor
 * doesn't directly own:
 *   - the `parachute migrate --to-supervised` orphan sweep
 *     (`commands/migrate-cutover.ts:sweepOrphanOnPort`), and
 *   - the supervisor's crash-restart path
 *     (`supervisor.ts:handleExit` → `adoptKillOrphanOnPort`).
 *
 * Both must answer the SAME question before sending a signal: is the process
 * holding the module's port plausibly THIS parachute module (a leftover
 * instance / orphan we may adopt-kill), or an UNRELATED process the operator is
 * running on the same port (which we must never touch)? Sharing one
 * implementation keeps the two sites from drifting — a loosened needle in one
 * place can't widen the kill surface in the other without the other noticing.
 *
 * The function is intentionally CONSERVATIVE: when in any doubt (unreadable
 * command line + a non-matching pid) it returns `attributable: false`, and the
 * caller refuses to kill. False-negatives cost a surfaced `port_squatter`
 * error (the operator resolves it); a false-positive costs killing someone
 * else's process — a far worse failure, so we bias hard toward not-attributable.
 */

/**
 * Best-effort command line of a pid. Returns the process's argv (one line) or
 * undefined when it can't be read (pid gone, permission, no `ps`). Both
 * supervisor + migrate wire a `ps -o command= -p <pid>` shell-out; the seam is
 * injectable so tests drive attribution without shelling out.
 */
export type OwnerProbeFn = (pid: number) => string | undefined;

/**
 * Decide whether an orphan pid bound to a MODULE port is plausibly attributable
 * to that parachute module — the guard against blind-killing an operator's
 * unrelated process that merely squats a declared port. Attributable when ANY
 * of:
 *   - the orphan pid equals the module's RECORDED pid (services.json/pidfile,
 *     or a supervisor entry's recorded pid);
 *   - (the cmdline arm) it matches the configured needle set — see `moduleMarker`.
 *
 * An unreadable command line (probe returned undefined) + a non-matching pid is
 * NOT attributable — we refuse to kill it.
 *
 * TWO ATTRIBUTION MODES (the `moduleMarker` knob):
 *
 *   - **Broad ("parachute") — the migrate orphan-sweep.** `moduleMarker`
 *     OMITTED: the cmdline needle is the bare `parachute` marker (the
 *     `~/.parachute/...` install path + the `@openparachute/<mod>` package name
 *     both carry it). The sweep runs ecosystem-wide during a cutover, so
 *     "is it ANY parachute-managed process?" is the right, field-tested width.
 *
 *   - **Per-module — the supervisor's crash-restart adopt-kill.** `moduleMarker`
 *     PROVIDED (the module's own start binary / installDir, e.g.
 *     `parachute-vault` or `~/.parachute/vault/`): the cmdline must contain THAT
 *     marker. The supervisor is always restarting ONE specific module and knows
 *     its identity, so a bare `parachute` match is too loose — it would let
 *     vault's restart adopt-KILL a sibling `scribe`/`runner` orphan that happens
 *     to hold vault's port (a cross-module kill). Requiring the module-specific
 *     marker means the supervisor can only ever reclaim a prior instance of the
 *     SAME module; a sibling's process is "not attributable" → surfaced, never
 *     killed.
 *
 * The bare module short-NAME (`vault`/`scribe`/…) is deliberately NOT a needle
 * in either mode — on a process KILL a bare short-name is too loose (a `runner`
 * substring matches an unrelated CI runner). The per-module marker is the
 * fully-qualified binary/path, not the short name.
 *
 * `startCmdHint` is an additional optional cmdline needle (currently unset at
 * both call sites; a seam for a future services.json-derived start command).
 */
export function orphanAttributable(args: {
  orphan: number;
  recordedPid: number | undefined;
  short: string;
  startCmdHint: string | undefined;
  ownerOfPid: OwnerProbeFn;
  /**
   * When provided, the cmdline arm requires THIS module-specific marker (start
   * binary / installDir) instead of the broad `parachute` marker — see the
   * "two attribution modes" note above. Omitted → broad `parachute` (migrate).
   */
  moduleMarker?: string;
}): { attributable: boolean; cmdline: string | undefined } {
  const { orphan, recordedPid, startCmdHint, ownerOfPid, moduleMarker } = args;
  if (recordedPid !== undefined && orphan === recordedPid) {
    return { attributable: true, cmdline: undefined };
  }
  const cmdline = ownerOfPid(orphan);
  if (cmdline === undefined) return { attributable: false, cmdline: undefined };
  const haystack = cmdline.toLowerCase();
  // Per-module mode (moduleMarker set) uses the module-specific marker as the
  // base needle; broad mode (migrate sweep) uses "parachute". `startCmdHint` is
  // an extra needle in either mode.
  const baseNeedle = moduleMarker ? moduleMarker.toLowerCase() : "parachute";
  const needles = [baseNeedle, ...(startCmdHint ? [startCmdHint.toLowerCase()] : [])].filter(
    (n) => n.length > 0,
  );
  const attributable = needles.some((n) => haystack.includes(n));
  return { attributable, cmdline };
}
