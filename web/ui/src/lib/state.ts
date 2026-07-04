/**
 * Unified state vocabulary per
 * [docs/contracts/design-system.md §6](../../../../docs/contracts/design-system.md)
 * (workstream F). Four canonical states — `active` / `pending` / `inactive`
 * / `failing` — shared across the CLI's `parachute status` rollup, the
 * admin SPA's module + UI sub-unit badges, and the well-known doc.
 *
 *   active   — supervised, running, healthy.
 *   pending  — supervised but needs operator action (OAuth approval,
 *              config) before it can run.
 *   inactive — operator-stopped or never started.
 *   failing  — supervised but unhealthy (crash, probe failure).
 */
export type UnifiedState = "active" | "pending" | "inactive" | "failing";

/** Supervisor lifecycle status as returned by `/api/modules`. */
export type SupervisorStatus = "starting" | "running" | "stopped" | "crashed" | "restarting" | null;

/**
 * Render-time mapping from the supervisor's internal lifecycle vocabulary
 * (`starting | running | stopped | crashed | restarting`) onto the four
 * user-facing states. Per the design-system mapping table:
 *
 *   - `running`              → `active`
 *   - `starting | restarting`→ `pending` (transient, operator typically
 *                              doesn't need to do anything — surfaces as
 *                              a "do nothing, wait" treatment)
 *   - `stopped`              → `inactive`
 *   - `crashed`              → `failing`
 *   - `null` (no supervisor) → `inactive` (no process, no state)
 *
 * The wire shape (`supervisor_status`) is intentionally left unchanged —
 * the SPA does the mapping at render time so the internal supervisor
 * pipeline stays decoupled from the user-facing vocabulary. When new
 * supervisor states get added, this helper is the one place to extend.
 */
export function unifiedStateForSupervisor(status: SupervisorStatus): UnifiedState {
  switch (status) {
    case "running":
      return "active";
    case "starting":
    case "restarting":
      return "pending";
    case "crashed":
      return "failing";
    case "stopped":
    case null:
    case undefined:
      return "inactive";
    default:
      return "inactive";
  }
}

/**
 * Render-time mapping for `UiSubUnitStatus`. As of workstream F the wire
 * shape uses the canonical vocabulary directly (`services-manifest.ts`
 * normalizes legacy `pending-oauth` / `disabled` values on read), so this
 * helper is mostly a passthrough — it exists so the SPA can still cope
 * gracefully if a wire value slips through with the old vocab (e.g. from
 * an older module that hasn't restarted since the upgrade).
 *
 * Absent / null → `active` (the discovery default the wire docs codify).
 */
export function unifiedStateForUi(status: string | null | undefined): UnifiedState {
  if (status == null) return "active";
  switch (status) {
    case "active":
    case "pending":
    case "inactive":
    case "failing":
      return status;
    // Back-compat aliases — accepted in case a module published a sub-unit
    // status pre-F and hasn't been restarted. Storage normalizes these on
    // read, but the wire shape can't enforce that for in-flight rows.
    case "pending-oauth":
      return "pending";
    case "disabled":
      return "inactive";
    default:
      return "active";
  }
}

/**
 * User-facing label for a unified state. Stable per design-system.md —
 * same string the badge renders, the CLI prints, and the well-known doc
 * carries.
 */
export function unifiedStateLabel(state: UnifiedState): string {
  return state;
}
