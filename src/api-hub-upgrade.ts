/**
 * `POST /api/hub/upgrade` + `GET /api/hub/upgrade/status` — the SPA-driven
 * hub self-upgrade (design 2026-06-01 §5 item 3 / §5.3 / D4).
 *
 * ── WHY A DEDICATED ENDPOINT (not /api/modules/hub/*) ──────────────────────
 *
 * The hub is NOT a supervised module — `CURATED_MODULES` rejects `hub`, so
 * `parseModulesPath("/api/modules/hub/upgrade")` returns undefined and the
 * module-ops switch never reaches a hub case. The hub needs its OWN endpoint
 * because the constraint is unique: the hub can't restart itself synchronously
 * (the request dies with the old process before it can report success). So:
 *
 *   1. Validate strictly + respond **202** immediately with
 *      `{ operation_id, target_version, channel, mode }`.
 *   2. Spawn a **detached one-shot helper** (`detached:true`+`unref()`) that
 *      OUTLIVES the hub: it rewrites the binary then drives the platform
 *      restart. The request handler does NOT do the rewrite/restart inline.
 *   3. The SPA polls `GET /api/hub/upgrade/status` + `/health` + `/api/hub`
 *      version until the new binary answers.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────
 *
 * - **Strict host-admin gate** — reuses the EXACT `authorize` path module-ops
 *   uses (`parachute:host:admin`, validated against the hub DB + issuer). A
 *   `:auth`-only token gets 403.
 * - **Closed-enum channel** — the optional `channel` is `"rc" | "latest"` ONLY
 *   (default: auto-detected from the current version). This value flows toward
 *   `bun add -g @openparachute/hub@<channel>`, so it MUST be a closed enum,
 *   never free input. There is no shell-string interpolation: the rewrite goes
 *   through `upgrade.ts`'s `UpgradeRunner` (argv arrays), so even the enum is
 *   defense-in-depth, not the only barrier.
 *
 * ── REDEPLOY-REQUIRED SHORT-CIRCUIT (§5.3) ─────────────────────────────────
 *
 * When the in-place-vs-redeploy detection (`hub-upgrade-mode.ts`) returns
 * `redeploy-required` (image-pinned container), we DO NOT spawn a helper and
 * DO NOT do a misleading no-op rewrite that's lost on the next container
 * restart. We respond 202 with `mode: "redeploy-required"` + seed a status
 * file in the `redeploy-required` phase; the SPA renders "redeploy from your
 * platform dashboard" instead of a false "upgraded."
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultRunner, detectChannel } from "./commands/upgrade.ts";
import { HUB_PACKAGE } from "./hub-control.ts";
import { type HubUpgradeMode, detectHubUpgradeMode } from "./hub-upgrade-mode.ts";
import {
  type HubUpgradeStatus,
  readHubUpgradeStatus,
  writeHubUpgradeStatus,
} from "./hub-upgrade-status.ts";
import { detectHubInstallSource } from "./install-source.ts";
import { validateAccessToken } from "./jwt-sign.ts";

/** Same scope module-ops gates on — destructive host-admin action. */
export const HUB_UPGRADE_REQUIRED_SCOPE = "parachute:host:admin";

/**
 * Non-terminal phases — an upgrade in any of these is still in flight, so a
 * second `POST /api/hub/upgrade` is rejected 409. The terminal phases
 * (`failed`, `redeploy-required`, and the SPA-inferred `succeeded`) are NOT
 * here, so a new upgrade may start once the prior op reached one of them.
 */
const IN_FLIGHT_PHASES = new Set<HubUpgradeStatus["phase"]>(["pending", "running", "restarting"]);

export interface SpawnHelperArgs {
  operationId: string;
  channel: "rc" | "latest";
  configDir: string;
  /** Hub PID for the container graceful-exit path (undefined on unit-managed). */
  hubPid?: number;
}

export interface ApiHubUpgradeDeps {
  db: Database;
  /** Hub origin — validates the bearer's `iss`. */
  issuer: string;
  /** PARACHUTE_HOME — where the status file is read/written. */
  configDir: string;
  /**
   * Spawn the detached one-shot helper. Production wires
   * `spawnDetachedHubUpgradeHelper`; tests inject a recorder so no real process
   * is forked and the handler-does-not-rewrite-inline invariant is asserted.
   */
  spawnHelper?: (args: SpawnHelperArgs) => void;
  /**
   * Resolve `<pkg>@<channel>` → concrete version for the 202 `target_version`
   * (best-effort; null on a registry miss). Production uses `npm view` via the
   * upgrade runner; tests stub it.
   */
  resolveTargetVersion?: (channel: "rc" | "latest") => Promise<string | null>;
  /** Read the hub's current version. Production reads the nearest package.json. */
  currentVersion?: () => string;
  /** Override the install-source dir + env for mode detection (test seam). */
  hubSrcDir?: string;
  env?: Record<string, string | undefined>;
  /**
   * Override the in-place-vs-redeploy detection (test seam). Production runs
   * `detectHubUpgradeMode` against the real install source + env; tests inject
   * a fixed result so the redeploy-required short-circuit can be exercised
   * without faking a Render image's on-disk layout.
   */
  detectMode?: typeof detectHubUpgradeMode;
  /** Override "now" (test seam). */
  now?: () => Date;
  /**
   * Read the current on-disk status (for the 409 in-flight guard). Defaults to
   * `readHubUpgradeStatus`; injectable so a test can drive the guard without
   * seeding a real file.
   */
  readStatus?: (configDir: string) => HubUpgradeStatus | null;
}

interface ParsedBody {
  channel?: "rc" | "latest";
}

async function authorize(req: Request, deps: ApiHubUpgradeDeps): Promise<Response | undefined> {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return jsonError(401, "unauthenticated", "Authorization: Bearer <token> required");
  }
  const bearer = auth.slice("Bearer ".length).trim();
  if (!bearer) return jsonError(401, "unauthenticated", "empty bearer token");
  try {
    const validated = await validateAccessToken(deps.db, bearer, deps.issuer);
    if (typeof validated.payload.sub !== "string" || validated.payload.sub.length === 0) {
      return jsonError(401, "unauthenticated", "bearer token has no sub claim");
    }
    const scopes =
      typeof validated.payload.scope === "string"
        ? validated.payload.scope.split(/\s+/).filter((s) => s.length > 0)
        : [];
    if (!scopes.includes(HUB_UPGRADE_REQUIRED_SCOPE)) {
      return jsonError(
        403,
        "insufficient_scope",
        `bearer token lacks ${HUB_UPGRADE_REQUIRED_SCOPE}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(401, "unauthenticated", `bearer token invalid — ${msg}`);
  }
  return undefined;
}

/**
 * Parse + STRICTLY validate the optional `{ channel }` body. A present-but-
 * non-enum channel is a hard 400 (the operator typed something the rewrite
 * can't honor — don't silently fall back). Empty / non-JSON / absent body all
 * resolve to "auto-detect," signalled by `channel: undefined`.
 */
async function parseBody(req: Request): Promise<ParsedBody | Response> {
  if (!req.headers.get("content-type")?.includes("application/json")) return {};
  let body: { channel?: unknown };
  try {
    body = (await req.json()) as { channel?: unknown };
  } catch {
    return {}; // empty / unparseable — auto-detect
  }
  if (body && body.channel !== undefined) {
    if (body.channel !== "rc" && body.channel !== "latest") {
      return jsonError(
        400,
        "invalid_channel",
        `channel must be "rc" or "latest" (got ${JSON.stringify(body.channel)})`,
      );
    }
    return { channel: body.channel };
  }
  return {};
}

/**
 * Default current-version reader: climb from the running source dir to the
 * nearest package.json. Mirrors `api-hub.ts`'s `readHubVersion`.
 */
function defaultCurrentVersion(hubSrcDir: string): string {
  // Lazy import to avoid a hot dependency; reuse the install-source detector's
  // version read (it already climbs to the nearest package.json).
  const source = detectHubInstallSource(hubSrcDir);
  return source.livePackageVersion ?? "unknown";
}

/** Default target-version resolver via `npm view <pkg>@<channel> version`. */
async function defaultResolveTargetVersion(channel: "rc" | "latest"): Promise<string | null> {
  const { code, stdout } = await defaultRunner.capture([
    "npm",
    "view",
    `${HUB_PACKAGE}@${channel}`,
    "version",
  ]);
  if (code !== 0) return null;
  const lines = stdout.trim().split("\n").filter(Boolean);
  return lines[lines.length - 1] ?? null;
}

/**
 * POST /api/hub/upgrade — accept + dispatch the detached helper. Returns 202
 * with `{ operation_id, target_version, channel, mode }`. Never blocks on the
 * upgrade itself.
 */
export async function handleHubUpgrade(req: Request, deps: ApiHubUpgradeDeps): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  const authFail = await authorize(req, deps);
  if (authFail) return authFail;

  const parsed = await parseBody(req);
  if (parsed instanceof Response) return parsed;

  // ── 409 in-flight guard ────────────────────────────────────────────────────
  // The status file is single-slot (one hub, one upgrade). If a prior upgrade
  // is still in a non-terminal phase (pending/running/restarting), starting a
  // SECOND would overwrite its operation_id — and a still-running first helper
  // would then either clobber the new op's status or be silently superseded.
  // The SPA disables the button while upgrading, but the API must guard
  // server-side too (a second tab, a stale page, a scripted POST). Reject with
  // 409 unless the slot is free (no file) or the prior op reached a terminal
  // phase (failed / redeploy-required / succeeded).
  const readStatus = deps.readStatus ?? readHubUpgradeStatus;
  const existing = readStatus(deps.configDir);
  if (existing && IN_FLIGHT_PHASES.has(existing.phase)) {
    return jsonError(
      409,
      "upgrade_in_flight",
      `a hub upgrade is already ${existing.phase} (operation ${existing.operation_id}); poll GET /api/hub/upgrade/status or wait for it to finish before starting another`,
    );
  }

  const hubSrcDir = deps.hubSrcDir ?? dirname(fileURLToPath(import.meta.url));
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();

  const currentVersion = (deps.currentVersion ?? (() => defaultCurrentVersion(hubSrcDir)))();
  // Auto-detect the channel from the current version when not explicitly set —
  // an rc operator stays on rc (governance rule 2), a stable operator on latest.
  const channel: "rc" | "latest" =
    parsed.channel ?? (currentVersion !== "unknown" ? detectChannel(currentVersion) : "latest");

  // §5.3 detection — does an in-place rewrite persist, or is the hub image-pinned?
  const detectMode = deps.detectMode ?? detectHubUpgradeMode;
  const modeResult = detectMode({ env, hubSrcDir });
  const mode: HubUpgradeMode = modeResult.mode;

  const resolveTarget = deps.resolveTargetVersion ?? defaultResolveTargetVersion;
  const targetVersion = await resolveTarget(channel).catch(() => null);

  const operationId = randomUUID();

  // ── redeploy-required: do NOT spawn a helper / do NOT no-op-rewrite (§5.3) ──
  if (mode === "redeploy-required") {
    const status: HubUpgradeStatus = {
      operation_id: operationId,
      phase: "redeploy-required",
      mode,
      current_version: currentVersion,
      target_version: targetVersion,
      channel,
      log: [modeResult.reason],
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
    };
    writeHubUpgradeStatus(deps.configDir, status);
    return accepted({ operationId, targetVersion, channel, mode });
  }

  // ── in-place: seed the status file, then spawn the detached helper ─────────
  const status: HubUpgradeStatus = {
    operation_id: operationId,
    phase: "pending",
    mode,
    current_version: currentVersion,
    target_version: targetVersion,
    channel,
    log: [`accepted hub-upgrade (${mode}); ${modeResult.reason}`],
    started_at: now.toISOString(),
  };
  writeHubUpgradeStatus(deps.configDir, status);

  // On a container the helper must signal the (current) hub to exit so the
  // runtime re-runs CMD on the new binary — pass our own PID. On a unit-managed
  // box the manager owns the restart, so no pid is needed (the helper's
  // `upgrade` dual-dispatch calls `restartHubUnit`).
  const spawn = deps.spawnHelper ?? spawnDetachedHubUpgradeHelper;
  const spawnArgs: SpawnHelperArgs = { operationId, channel, configDir: deps.configDir };
  if (modeResult.source === "container") spawnArgs.hubPid = process.pid;
  // CRITICAL: spawn-and-return. The handler does NOT await a rewrite/restart —
  // that's the helper's job, and it must outlive this process.
  spawn(spawnArgs);

  return accepted({ operationId, targetVersion, channel, mode });
}

/**
 * GET /api/hub/upgrade/status — poll the on-disk status file. Matches the
 * module-ops operation-poll shape (status + log + timestamps) so the SPA's
 * polling code reads consistently. 404 when no upgrade has been started.
 */
export async function handleHubUpgradeStatus(
  req: Request,
  deps: ApiHubUpgradeDeps,
): Promise<Response> {
  if (req.method !== "GET") return jsonError(405, "method_not_allowed", "use GET");
  const authFail = await authorize(req, deps);
  if (authFail) return authFail;

  const status = readHubUpgradeStatus(deps.configDir);
  if (!status) {
    return jsonError(404, "not_found", "no hub upgrade has been started");
  }
  return new Response(JSON.stringify(status), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Production helper-spawn: `bun <abs hub-upgrade-helper.ts> --op … --channel …
 * --config-dir … [--hub-pid …]`, **detached + unref'd** so it OUTLIVES the hub
 * it's about to restart. This is the one legitimate detached process in the
 * unified model (§5.3) — everything else stays supervised.
 *
 * `detached: true` puts it in its own process group + session leader, so the
 * hub exiting does not deliver a death signal to it; `unref()` removes it from
 * the parent's event-loop ref-count so the hub can exit without waiting on it.
 */
export function spawnDetachedHubUpgradeHelper(args: SpawnHelperArgs): void {
  const helperPath = fileURLToPath(new URL("./hub-upgrade-helper.ts", import.meta.url));
  const cmd = [
    "bun",
    helperPath,
    "--op",
    args.operationId,
    "--channel",
    args.channel,
    "--config-dir",
    args.configDir,
  ];
  if (args.hubPid !== undefined) {
    cmd.push("--hub-pid", String(args.hubPid));
  }
  const proc = Bun.spawn(cmd, {
    // Own process group/session so the hub's exit doesn't SIGHUP/SIGTERM us —
    // we MUST outlive the hub to drive its restart.
    detached: true,
    // Inherit env so the helper's `bun add -g` / git sees PATH, BUN_INSTALL,
    // PARACHUTE_HOME, TMPDIR — same rationale as commands/upgrade.ts's runner.
    env: process.env,
    // Detach stdio so the helper isn't tied to the hub's pipes (which close on
    // hub exit). The helper records progress to the status FILE, not stdout.
    stdio: ["ignore", "ignore", "ignore"],
  });
  // Remove from the parent's ref-count so the hub can exit cleanly while the
  // helper keeps running.
  proc.unref();
}

function accepted(body: {
  operationId: string;
  targetVersion: string | null;
  channel: "rc" | "latest";
  mode: HubUpgradeMode;
}): Response {
  return new Response(
    JSON.stringify({
      operation_id: body.operationId,
      target_version: body.targetVersion,
      channel: body.channel,
      mode: body.mode,
    }),
    { status: 202, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
