import { CANONICAL_PORT_MAX, CANONICAL_PORT_MIN, PORT_RESERVATIONS } from "./service-spec.ts";

/**
 * The hub is the port authority for Parachute services. At install time it
 * picks a port for each service and reflects the chosen port in
 * `services.json`. That manifest is the single source of truth at boot
 * (parachute-scribe#41 / parachute-agent#146 / parachute-agent#148): each
 * service reads `services.json` first and only falls through to lower-tier
 * sources (its own config, the bare `PORT` env, the compiled-in canonical
 * default) when the manifest doesn't pin a port. So writing PORT into the
 * service's `.env` is no longer load-bearing — services.json wins.
 *
 * Pre-hub#206, install also wrote `PORT=<port>` into `~/.parachute/<svc>/.env`
 * and preserved any pre-existing value across re-installs ("operator-edited
 * port survives upgrade"). Post-#206 (option A from the design discussion):
 * we stop writing PORT to `.env` entirely. The duplicate state was at best
 * dead weight and at worst a source of drift — operators editing
 * `services.json` would get re-stamped by a stale `.env` PORT on the next
 * `parachute install`. Existing `.env` PORT lines stay where they are
 * (harmless — service-side resolvePort reads services.json first; the bare
 * PORT env tier is the lowest priority).
 *
 * Why up-front assignment instead of detect-on-collision-at-boot:
 *   - Two services racing to bind the same port produces an opaque "address in
 *     use" deep inside one of them. Assigning at install lets the hub keep
 *     a single coherent picture of who owns what.
 *   - The hub's reverse-proxy targets are computed from services.json. If a
 *     service silently falls back to a different port at runtime, the hub
 *     proxies to a dead port and the user sees a 502 with no explanation.
 */

export type AssignmentSource = "canonical" | "fallback-in-range" | "fallback-out-of-range";

export interface PortAssignment {
  readonly port: number;
  readonly source: AssignmentSource;
  /** Set when the canonical slot wasn't available — caller logs it. */
  readonly warning?: string;
}

/**
 * Pure: pick a port given the canonical default and the set of ports we
 * already know to be taken.
 *
 *   1. Prefer canonical (the slot the service expects, e.g. vault → 1940).
 *   2. On collision, walk the unassigned canonical reservations (1944..1949
 *      today) — keeps the install inside the Parachute range so other
 *      software doesn't accidentally land on the same port.
 *   3. Range exhausted: walk past CANONICAL_PORT_MAX. The warning lets the
 *      caller surface it; the install still proceeds.
 *
 * Third-party services (no canonical slot) skip step 1 and start at step 2.
 */
export function assignPort(
  canonical: number | undefined,
  occupied: Iterable<number>,
): PortAssignment {
  const taken = new Set(occupied);

  if (canonical !== undefined && !taken.has(canonical)) {
    return { port: canonical, source: "canonical" };
  }

  for (const reservation of PORT_RESERVATIONS) {
    if (reservation.status !== "reserved") continue;
    if (taken.has(reservation.port)) continue;
    const warning =
      canonical !== undefined
        ? `canonical port ${canonical} is in use; assigned ${reservation.port} from the unassigned Parachute range.`
        : `assigned port ${reservation.port} from the unassigned Parachute range (no canonical slot for this service).`;
    return { port: reservation.port, source: "fallback-in-range", warning };
  }

  let p = CANONICAL_PORT_MAX + 1;
  while (taken.has(p) && p < 65536) p++;
  return {
    port: p,
    source: "fallback-out-of-range",
    warning: `Parachute canonical range (${CANONICAL_PORT_MIN}–${CANONICAL_PORT_MAX}) is full; assigned ${p} outside the range — may conflict with other software.`,
  };
}

export interface AssignServicePortOpts {
  /** Canonical default for this service, or undefined for third-party. */
  readonly canonical?: number;
  /** Ports we already know to be taken. */
  readonly occupied: Iterable<number>;
}

export interface AssignServicePortResult {
  readonly port: number;
  readonly source: AssignmentSource;
  /** Warning to surface to the user, if any. */
  readonly warning?: string;
}

/**
 * Assign a port for a service at install time.
 *
 * As of hub#206 this is a thin wrapper over `assignPort`: services.json is
 * the source of truth for service ports (parachute-scribe#41 /
 * parachute-agent#146 / parachute-agent#148 / parachute-patterns#45), so the
 * install path no longer touches the service's `.env`. The wrapper still
 * exists to give the install path a stable seam — `collectOccupiedPorts`
 * feeds into the same shape regardless of how the underlying picker
 * evolves — and to keep the warning return path centralized.
 */
export function assignServicePort(opts: AssignServicePortOpts): AssignServicePortResult {
  const assignment = assignPort(opts.canonical, opts.occupied);
  const result: AssignServicePortResult = {
    port: assignment.port,
    source: assignment.source,
  };
  if (assignment.warning) {
    return { ...result, warning: assignment.warning };
  }
  return result;
}
