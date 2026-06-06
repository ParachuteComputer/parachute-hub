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
 *   - its command line mentions `parachute` (any parachute-managed process —
 *     the `~/.parachute/...` install path and the `@openparachute/<mod>`
 *     package name both carry this marker, so it catches every genuine
 *     parachute-managed module);
 *   - its command line mentions the module's start command (when a hint is
 *     supplied — currently always unset at the call sites, the seam is kept for
 *     a future services.json-derived start command).
 *
 * An unreadable command line (probe returned undefined) + a non-matching pid is
 * NOT attributable — we refuse to kill it.
 *
 * NOTE: the bare module short-name needle (`vault`/`runner`/`scribe`/`notes`)
 * is deliberately NOT used — on a process KILL a bare short-name is too loose
 * (a `runner` substring matches an unrelated CI runner squatting the port). The
 * `parachute` marker already attributes every genuine parachute-managed
 * process, so the short-name arm only widened the false-positive surface.
 */
export function orphanAttributable(args: {
  orphan: number;
  recordedPid: number | undefined;
  short: string;
  startCmdHint: string | undefined;
  ownerOfPid: OwnerProbeFn;
}): { attributable: boolean; cmdline: string | undefined } {
  const { orphan, recordedPid, startCmdHint, ownerOfPid } = args;
  if (recordedPid !== undefined && orphan === recordedPid) {
    return { attributable: true, cmdline: undefined };
  }
  const cmdline = ownerOfPid(orphan);
  if (cmdline === undefined) return { attributable: false, cmdline: undefined };
  const haystack = cmdline.toLowerCase();
  const needles = ["parachute", ...(startCmdHint ? [startCmdHint.toLowerCase()] : [])].filter(
    (n) => n.length > 0,
  );
  const attributable = needles.some((n) => haystack.includes(n));
  return { attributable, cmdline };
}
