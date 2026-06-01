/**
 * Phase 4 expose-path dual-dispatch seams (design
 * `parachute.computer/design/2026-06-01-hub-as-supervisor-unification.md` §4.3).
 *
 * Under the hub-as-supervisor unification, `expose` / `expose off` decouple
 * from the hub's lifecycle:
 *   - When a hub UNIT is installed (launchd/systemd/container), "ensure the hub"
 *     means "ensure the hub UNIT is up" (`ensureHubUnit`), and the post-expose
 *     hub-dependent service restart goes through the RUNNING hub's in-process
 *     Supervisor over the loopback module-ops API (`driveModuleOp(short,
 *     "restart")`), NOT `lifecycle.restart` / a detached spawn.
 *   - When NO unit is installed (a legacy detached box, until Phase 5 retires
 *     the detached spawners), the existing behavior is preserved UNCHANGED:
 *     `ensureHubRunning` (the detached spawn) + `lifecycle.restart`.
 *
 * This module is the shared seam BOTH `expose.ts` (Tailscale) and
 * `expose-cloudflare.ts` (cloudflared) use so the two paths can't drift, and so
 * the unit-arm is a clean, separately-deletable branch when Phase 5 collapses
 * to the supervisor-only path.
 *
 * THE SAFETY PRINCIPLE (same dual-dispatch bridge as Phase 3b): unit installed →
 * drive the manager/supervisor (new path); no unit → keep the EXACT current
 * detached behavior. The discriminant is `isHubUnitInstalled`, structured as a
 * top-level branch in the callers.
 */

import { readHubPort } from "../hub-control.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  type EnsureHubUnitOpts,
  type EnsureHubUnitResult,
  HUB_UNIT_DEFAULT_PORT,
  type HubUnitDeps,
  defaultHubUnitDeps,
  ensureHubUnit as ensureHubUnitImpl,
  isHubUnitInstalled,
} from "../hub-unit.ts";
import {
  type DriveModuleOpDeps,
  type ModuleOp,
  ModuleOpHttpError,
  type ModuleOpResult,
  NoOperatorTokenError,
  OperatorTokenExpiredError,
  driveModuleOp as driveModuleOpImpl,
} from "../module-ops-client.ts";
import {
  type OperatorIssuerHealStatus,
  selfHealOperatorTokenIssuer as selfHealOperatorTokenIssuerImpl,
} from "../operator-token.ts";
import { persistVaultHubOrigin, selfHealVaultHubOrigin } from "../vault-hub-origin-env.ts";

/**
 * Injectable Phase 4 supervisor-path seams shared by the Tailscale + cloudflared
 * expose paths. Mirrors `LifecycleOpts.supervisor` (Phase 3b): everything is
 * injectable so tests can (a) force the unit-installed branch without a real
 * launchd/systemd, and (b) assert the `ensureHubUnit` / `driveModuleOp` /
 * operator-token-self-heal calls without a live hub. Production wires the real
 * impls against an opened hub.db + the resolved hub origin.
 *
 * When the caller OMITS this block entirely, the discriminant defaults to
 * `false` (detached arm) — deterministic regardless of whether the test host
 * happens to have a real hub unit installed. The production CLI dispatch passes
 * `supervisor: {}` so the real `isHubUnitInstalled` probe decides the arm.
 */
export interface ExposeSupervisorOpts {
  /**
   * Is a hub unit installed (the dual-dispatch discriminant)? Production uses
   * `isHubUnitInstalled(hubUnitDeps)`. Tests set this `true`/`false` directly to
   * pick the branch deterministically. When set, it wins over the
   * `hubUnitDeps`-derived detection.
   */
  unitInstalled?: boolean;
  /** Deps for the real `isHubUnitInstalled` probe + the ensure-hub-unit call. */
  hubUnitDeps?: HubUnitDeps;
  /** Ensure the hub unit is up before / during expose (§3.2 / §4.3a). */
  ensureHubUnit?: (opts: EnsureHubUnitOpts) => Promise<EnsureHubUnitResult>;
  /** Drive a per-module op against the running hub (reads operator.token). */
  driveModuleOp?: (short: string, op: ModuleOp, deps: DriveModuleOpDeps) => Promise<ModuleOpResult>;
  /**
   * Open the hub DB used to validate/auto-rotate the operator token in
   * `driveModuleOp` + to self-heal its issuer. Production opens
   * `<configDir>/hub.db`; tests inject an in-memory/seeded db. Returns a handle
   * the caller closes.
   */
  openDb?: (configDir: string) => import("bun:sqlite").Database;
  /**
   * Self-heal the operator token's stale `iss` toward the new public origin
   * BEFORE the supervised restart (§4.3c). After `expose up` the running hub
   * re-resolves its issuer to the public origin, so a loopback-minted operator
   * token must be re-minted under that origin or the CLI's own `driveModuleOp`
   * would fail iss-validation. Mirrors lifecycle's `selfHealOperatorTokenOnStart`.
   * Production delegates to `selfHealOperatorTokenIssuer`; tests inject a stub.
   */
  selfHealOperatorTokenIssuer?: (
    db: import("bun:sqlite").Database,
    opts: { issuer: string; configDir: string; log: (line: string) => void },
  ) => Promise<OperatorIssuerHealStatus>;
  /** Loopback hub base URL override (default derives from the hub port). */
  baseUrl?: string;
}

/** Resolved Phase 4 expose supervisor-path seams (see {@link ExposeSupervisorOpts}). */
export interface ResolvedExposeSupervisor {
  /** Whether a hub unit is installed — the dual-dispatch discriminant. */
  unitInstalled: boolean;
  hubUnitDeps: HubUnitDeps;
  ensureHubUnit: (opts: EnsureHubUnitOpts) => Promise<EnsureHubUnitResult>;
  driveModuleOp: (short: string, op: ModuleOp, deps: DriveModuleOpDeps) => Promise<ModuleOpResult>;
  openDb: (configDir: string) => import("bun:sqlite").Database;
  selfHealOperatorTokenIssuer: (
    db: import("bun:sqlite").Database,
    opts: { issuer: string; configDir: string; log: (line: string) => void },
  ) => Promise<OperatorIssuerHealStatus>;
  baseUrl: string | undefined;
}

/**
 * Resolve the Phase 4 expose supervisor seams. Same discriminant shape as
 * lifecycle's `resolveSupervisor`: a `supervisor` block (even `{}`) opts into
 * the real `isHubUnitInstalled` probe; omitting it entirely is the detached arm
 * deterministically.
 */
export function resolveExposeSupervisor(
  opts: ExposeSupervisorOpts | undefined,
): ResolvedExposeSupervisor {
  const hubUnitDeps = opts?.hubUnitDeps ?? defaultHubUnitDeps;
  const unitInstalled =
    opts === undefined ? false : (opts.unitInstalled ?? isHubUnitInstalled(hubUnitDeps));
  return {
    unitInstalled,
    hubUnitDeps,
    ensureHubUnit: opts?.ensureHubUnit ?? ensureHubUnitImpl,
    driveModuleOp: opts?.driveModuleOp ?? driveModuleOpImpl,
    openDb: opts?.openDb ?? ((configDir) => openHubDb(hubDbPath(configDir))),
    selfHealOperatorTokenIssuer:
      opts?.selfHealOperatorTokenIssuer ?? selfHealOperatorTokenIssuerImpl,
    baseUrl: opts?.baseUrl,
  };
}

/**
 * Resolve the issuer the operator token's `iss` is validated against on the
 * loopback module-ops call. Mirrors lifecycle's `resolveOperatorTokenIssuer`:
 * the operator token ALWAYS carries an `iss`, so this falls back to the
 * canonical loopback origin (`http://127.0.0.1:<hubPort>`) when no public
 * origin is known. The CLI hits the hub on loopback, and the hub validates the
 * bearer against its per-request issuer — which for a loopback request is the
 * loopback origin — so the operator token must remain validatable there.
 */
function resolveExposeOperatorTokenIssuer(
  hubOrigin: string | undefined,
  configDir: string,
): string {
  if (hubOrigin) return hubOrigin;
  const port = readHubPort(configDir) ?? HUB_UNIT_DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * Ensure the hub UNIT is up for an expose, mapping `ensureHubUnit`'s structured
 * outcome to a simple ok/not-ok the caller turns into an exit code. Returns the
 * probed port so the caller can plan tailscale/cloudflared against it (§4.3a:
 * tailscale needs only the hub reachable on loopback, which the unit
 * guarantees). On a non-up outcome the messages are surfaced.
 */
export async function ensureHubUnitForExpose(
  sup: ResolvedExposeSupervisor,
  port: number,
  log: (line: string) => void,
): Promise<{ ok: boolean; port: number }> {
  const ensured = await sup.ensureHubUnit({ port, deps: sup.hubUnitDeps, log });
  if (ensured.outcome === "already-up" || ensured.outcome === "started") {
    return { ok: true, port: ensured.port };
  }
  for (const m of ensured.messages) log(m);
  return { ok: false, port: ensured.port };
}

/**
 * Restart a hub-dependent service (today: vault) via the running hub's
 * Supervisor after an expose changed the public origin (§4.3c). The supervised
 * restart re-injects the hub's current per-request-resolved origin into the
 * module's env; this helper ALSO fires the durable origin self-heals that the
 * detached `lifecycle.restart` path used to provide:
 *   - `selfHealOperatorTokenIssuer` — re-mint the operator token under the new
 *     public origin BEFORE the module-op, so the CLI's own `driveModuleOp`
 *     bearer validates (and a later supervised restart's iss is current).
 *   - `persistVaultHubOrigin` / `selfHealVaultHubOrigin` — write the public
 *     origin into vault's `.env` so a future out-of-band boot also validates.
 *
 * Returns the module-op exit code (0 on success). Errors are surfaced as
 * actionable lines (never a raw 401 / thrown HTTP error) and mapped to a
 * non-zero code so the caller can warn-and-continue exactly as the detached
 * restart path does.
 */
export async function restartHubDependentViaSupervisor(args: {
  short: string;
  hubOrigin: string;
  configDir: string;
  sup: ResolvedExposeSupervisor;
  log: (line: string) => void;
}): Promise<number> {
  const { short, hubOrigin, configDir, sup, log } = args;
  const issuer = resolveExposeOperatorTokenIssuer(hubOrigin, configDir);
  const db = sup.openDb(configDir);
  try {
    // Self-heal the operator token's iss toward the NEW public origin first, so
    // the bearer the CLI presents on the loopback module-op validates and a
    // subsequent supervised restart's injected iss is current. The loopback /
    // provenance guards live inside `selfHealOperatorTokenIssuer`, so passing
    // the resolved (possibly loopback) origin is safe — it no-ops on loopback.
    try {
      const status = await sup.selfHealOperatorTokenIssuer(db, {
        issuer: hubOrigin,
        configDir,
        log,
      });
      if (status.kind === "rotated") {
        log(`  refreshed operator.token issuer → ${hubOrigin} (was stale after exposure)`);
      }
    } catch (err) {
      // A self-heal failure must never block the restart — degrade to a note.
      log(
        `  note: operator.token issuer self-heal skipped (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
    // Durable .env persistence + vault-side self-heal (parity with the detached
    // `persistVaultHubOriginForStart`). Both are called for parity with that
    // detached path: `persistVaultHubOrigin` is the PRIMARY write — it stamps
    // the new public origin into vault's `.env` (skipping loopback / unchanged
    // values itself). `selfHealVaultHubOrigin` is a deliberate no-op in the
    // normal case here — persist just wrote the public origin, so selfHeal's
    // `current !== undefined && !isLoopbackOrigin(current)` guard short-circuits.
    // It only fires for OLD installs where `.env` was left stale-loopback (the
    // persist write can be skipped on edge cases), keeping the pair behaviorally
    // identical to the detached path.
    if (short === "vault") {
      persistVaultHubOrigin(configDir, hubOrigin, log);
      selfHealVaultHubOrigin(configDir, log, `${configDir}/expose-state.json`);
    }

    const deps: DriveModuleOpDeps = {
      db,
      issuer,
      configDir,
      ...(sup.baseUrl !== undefined ? { baseUrl: sup.baseUrl } : {}),
    };
    try {
      await sup.driveModuleOp(short, "restart", deps);
      return 0;
    } catch (err) {
      if (err instanceof NoOperatorTokenError || err instanceof OperatorTokenExpiredError) {
        log(`✗ ${short}: ${err.message}`);
        return 1;
      }
      if (err instanceof ModuleOpHttpError) {
        // A not-supervised module (404) after an expose just means it wasn't
        // running — the detached path's `processState !== running` guard simply
        // skips it. Treat 404 the same: nothing to restart, not a failure.
        if (err.status === 404 && err.code === "not_supervised") return 0;
        log(`✗ ${short}: ${err.message}`);
        return 1;
      }
      log(`✗ ${short}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  } finally {
    db.close();
  }
}
