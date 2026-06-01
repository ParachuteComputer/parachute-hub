/**
 * CLI client for the module-ops HTTP API (`POST /api/modules/:short/<op>`).
 *
 * This is the credential + transport seam that Phase 3 of the
 * hub-as-supervisor unification (design 2026-06-01 §3.1) will repoint
 * `parachute start/stop/restart <svc>` onto: instead of touching pidfiles
 * directly (`commands/lifecycle.ts`), those verbs become authenticated calls
 * to the running hub's in-process Supervisor over loopback.
 *
 * **Phase 1 is additive.** This file ADDS the client + its tests; it does NOT
 * repoint any existing CLI command. `parachute start/stop/restart/install/
 * upgrade` stay on the detached `lifecycle.ts` path until the Phase 3 cutover.
 *
 * ## The credential (§3.1)
 *
 * The on-box caller's proof of operator authority is `~/.parachute/operator.token`
 * — a hub-issued JWT carrying `parachute:host:admin` under the default `admin`
 * scope-set, which is exactly the scope `api-modules-ops.ts` gates on. We READ
 * it via `useOperatorTokenWithAutoRotate` (which validates against the hub DB +
 * issuer and opportunistically re-mints a within-7d-of-expiry token in place);
 * we never mint a parallel token, so there is no second SQLite writer racing
 * the running hub. The token is presented as `Authorization: Bearer` to the
 * loopback hub.
 *
 * No operator token on disk → an actionable error ("no operator token — run
 * `parachute auth rotate-operator`"), never a raw 401.
 *
 * ## Sync vs async ops
 *
 * `start` / `stop` / `restart` / `uninstall` are synchronous: the handler does
 * the work inline and returns the new state in the body. `install` / `upgrade`
 * return `202 { operation_id }` and the client polls
 * `GET /api/modules/operations/:id` to a terminal state. This client handles
 * both: a 202-with-operation_id response is polled to completion; any other
 * 2xx body is returned as-is.
 */

import type { Database } from "bun:sqlite";
import { OperatorTokenExpiredError, useOperatorTokenWithAutoRotate } from "./operator-token.ts";

/** Loopback hub base URL when none is injected. The hub pins 1939 (canonical-ports). */
export const DEFAULT_HUB_BASE_URL = "http://127.0.0.1:1939";

/** Default poll interval + ceiling for async operations. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

/** Module-op verbs the client can drive against `POST /api/modules/:short/<op>`. */
export type ModuleOp = "start" | "stop" | "restart" | "install" | "upgrade" | "uninstall";

/**
 * Thrown when no `operator.token` exists on disk. The CLI surfaces
 * `.message` directly — it's already actionable. Distinct error class so a
 * caller can branch on "needs bootstrap" vs "hub said no."
 */
export class NoOperatorTokenError extends Error {
  override name = "NoOperatorTokenError";
  constructor() {
    super(
      "no operator token — run `parachute auth rotate-operator` to mint one (looked for ~/.parachute/operator.token)",
    );
  }
}

/**
 * Thrown when the hub answers a module-op with a non-2xx status. Carries the
 * HTTP status + the parsed `{ error, error_description }` body so the CLI can
 * render the hub's own message (e.g. `not_installed`, `insufficient_scope`).
 */
export class ModuleOpHttpError extends Error {
  override name = "ModuleOpHttpError";
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, description: string) {
    super(`${code}: ${description}`);
    this.status = status;
    this.code = code;
  }
}

/** Thrown when an async operation reaches `failed`, or polling times out. */
export class ModuleOpFailedError extends Error {
  override name = "ModuleOpFailedError";
}

/** Terminal shape returned to the caller — the hub's response body. */
export interface ModuleOpResult {
  /** HTTP status of the initiating POST (200 sync, 202 async). */
  readonly status: number;
  /** Parsed JSON body. For async ops, the terminal operation record. */
  readonly body: unknown;
  /** Operation id when the op was async (202); undefined for sync ops. */
  readonly operationId?: string;
}

export interface DriveModuleOpDeps {
  /** Open hub DB handle — used to validate / auto-rotate the operator token. */
  readonly db: Database;
  /** Hub issuer (origin) the operator token's `iss` is validated against. */
  readonly issuer: string;
  /** Loopback hub base URL. Defaults to {@link DEFAULT_HUB_BASE_URL}. */
  readonly baseUrl?: string;
  /** configDir override (where operator.token lives). Defaults to `configDir()`. */
  readonly configDir?: string;
  /** Optional JSON body for the POST (e.g. `{ channel }` on install/upgrade). */
  readonly body?: unknown;
  /**
   * fetch seam. Production passes the global `fetch`; tests inject a fake that
   * asserts the Authorization header + returns canned responses without a
   * real socket.
   */
  readonly fetch?: typeof fetch;
  /** Clock seam for the operator-token rotation check. */
  readonly now?: () => Date;
  /** Sleep seam for the async-op poll loop. Tests stub to advance instantly. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Poll interval for async ops, ms. Default 1000. */
  readonly pollIntervalMs?: number;
  /** Poll ceiling for async ops, ms. Default 120000. */
  readonly pollTimeoutMs?: number;
}

/**
 * Read the operator token (auto-rotating if near expiry) and return the bearer
 * to present onward. Throws {@link NoOperatorTokenError} when none is on disk,
 * and re-throws {@link OperatorTokenExpiredError} unchanged (its message is
 * already the actionable "run rotate-operator" shape).
 */
export async function resolveOperatorBearer(deps: DriveModuleOpDeps): Promise<string> {
  const used = await useOperatorTokenWithAutoRotate(deps.db, {
    issuer: deps.issuer,
    ...(deps.configDir !== undefined ? { configDir: deps.configDir } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (!used) throw new NoOperatorTokenError();
  return used.token;
}

/**
 * Drive a module-op end-to-end: read the operator token, POST it as Bearer to
 * the loopback hub, and (for async ops that return 202 + operation_id) poll
 * `GET /api/modules/operations/:id` to a terminal state.
 *
 * Throws:
 *   - {@link NoOperatorTokenError} — no operator.token on disk.
 *   - {@link OperatorTokenExpiredError} — token fully expired (actionable msg).
 *   - {@link ModuleOpHttpError} — hub answered non-2xx (carries status + code).
 *   - {@link ModuleOpFailedError} — async op reached `failed`, or poll timed out.
 */
export async function driveModuleOp(
  short: string,
  op: ModuleOp,
  deps: DriveModuleOpDeps,
): Promise<ModuleOpResult> {
  const doFetch = deps.fetch ?? fetch;
  const baseUrl = (deps.baseUrl ?? DEFAULT_HUB_BASE_URL).replace(/\/+$/, "");

  const bearer = await resolveOperatorBearer(deps);

  const headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
  const init: RequestInit = { method: "POST", headers };
  if (deps.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(deps.body);
  }

  const res = await doFetch(`${baseUrl}/api/modules/${short}/${op}`, init);
  const body = await parseJsonSafe(res);

  if (res.status < 200 || res.status >= 300) {
    const { error, error_description } = asErrorBody(body);
    throw new ModuleOpHttpError(res.status, error, error_description);
  }

  // Async op (install / upgrade): 202 + { operation_id } → poll to terminal.
  if (res.status === 202) {
    const operationId = extractOperationId(body);
    if (!operationId) {
      // 202 means "accepted, poll for completion" — but with no operation_id
      // there's nothing to poll. Silently returning the 202 would strand the
      // caller on an incomplete op; surface it as a hard failure instead.
      throw new ModuleOpFailedError("hub returned 202 but no operation_id in body");
    }
    const terminal = await pollOperation(operationId, bearer, baseUrl, doFetch, deps);
    return { status: res.status, body: terminal, operationId };
  }

  // Sync op (start / stop / restart / uninstall) — body is the final state.
  return { status: res.status, body };
}

/**
 * Poll `GET /api/modules/operations/:id` until `succeeded` / `failed` or the
 * timeout elapses. Returns the terminal operation record on success; throws
 * {@link ModuleOpFailedError} on `failed` or timeout, {@link ModuleOpHttpError}
 * on a non-2xx poll response.
 */
async function pollOperation(
  operationId: string,
  bearer: string,
  baseUrl: string,
  doFetch: typeof fetch,
  deps: DriveModuleOpDeps,
): Promise<unknown> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());
  const deadline = now().getTime() + timeoutMs;
  const url = `${baseUrl}/api/modules/operations/${operationId}`;

  while (true) {
    const res = await doFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${bearer}` },
    });
    const body = await parseJsonSafe(res);
    if (res.status < 200 || res.status >= 300) {
      const { error, error_description } = asErrorBody(body);
      throw new ModuleOpHttpError(res.status, error, error_description);
    }
    const status = extractOpStatus(body);
    if (status === "succeeded") return body;
    if (status === "failed") {
      const errMsg = extractOpError(body) ?? "operation failed";
      throw new ModuleOpFailedError(errMsg);
    }
    if (now().getTime() >= deadline) {
      throw new ModuleOpFailedError(
        `operation ${operationId} did not complete within ${timeoutMs}ms (last status: ${status ?? "unknown"})`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Terminal shape returned by {@link fetchModuleLogs}. */
export interface ModuleLogsResult {
  /** The short name the logs belong to. */
  readonly short: string;
  /** Buffered lines, oldest-first (each includes its trailing newline). */
  readonly lines: string[];
  /** The same lines joined — the tail-blob shape `parachute logs` will print. */
  readonly text: string;
}

/**
 * Read a supervised module's recent output from the hub's per-module ring
 * buffer (`GET /api/modules/:short/logs`, §6.5). Additive — this does NOT wire
 * into the `parachute logs` CLI command (that cutover is Phase 3); it's the
 * transport+credential seam Phase 3 will call.
 *
 * Reuses the same operator.token→Bearer path as {@link driveModuleOp} (read,
 * never mint). The buffer replay includes the boot/crash lines that preceded
 * the call — the must-have that a connect-time stream would miss.
 *
 * Throws:
 *   - {@link NoOperatorTokenError} — no operator.token on disk.
 *   - {@link OperatorTokenExpiredError} — token fully expired (actionable msg).
 *   - {@link ModuleOpHttpError} — hub answered non-2xx (e.g. `not_supervised`).
 */
export async function fetchModuleLogs(
  short: string,
  deps: DriveModuleOpDeps,
): Promise<ModuleLogsResult> {
  const doFetch = deps.fetch ?? fetch;
  const baseUrl = (deps.baseUrl ?? DEFAULT_HUB_BASE_URL).replace(/\/+$/, "");
  const bearer = await resolveOperatorBearer(deps);

  const res = await doFetch(`${baseUrl}/api/modules/${short}/logs`, {
    method: "GET",
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = await parseJsonSafe(res);
  if (res.status < 200 || res.status >= 300) {
    const { error, error_description } = asErrorBody(body);
    throw new ModuleOpHttpError(res.status, error, error_description);
  }
  const b = (body ?? {}) as { lines?: unknown; text?: unknown };
  const lines = Array.isArray(b.lines)
    ? b.lines.filter((l): l is string => typeof l === "string")
    : [];
  const text = typeof b.text === "string" ? b.text : lines.join("");
  return { short, lines, text };
}

/**
 * One module's run-state as read from `GET /api/modules` — the subset
 * `parachute status` needs to render a module row from the RUNNING supervisor
 * (design §6.4 module rows). Snake-case mirrors the wire shape (`api-modules.ts`
 * `ModuleWireShape`); we keep only the supervisor-derived fields here.
 */
export interface ModuleStateSnapshot {
  readonly short: string;
  readonly installed: boolean;
  readonly installed_version: string | null;
  /**
   * Supervisor run-status (`running` / `stopped` / `crashed` / `starting` /
   * `restarting`), or null when the module isn't tracked by the supervisor
   * (e.g. never booted, skipped at boot, or no supervisor on this hub).
   */
  readonly supervisor_status: string | null;
  readonly pid: number | null;
  /**
   * Structured start-error the supervisor recorded (missing-dependency /
   * started-but-unbound). Passed through verbatim so `status` can render the
   * SAME friendly missing-dependency note the detached path shows (#188).
   */
  readonly supervisor_start_error: unknown | null;
}

/** Terminal shape returned by {@link fetchModuleStates}. */
export interface ModuleStatesResult {
  /** Whether the running hub has a supervisor wired in (`supervisor_available`). */
  readonly supervisorAvailable: boolean;
  /** Per-module supervisor snapshots, keyed by short name in array order. */
  readonly modules: ModuleStateSnapshot[];
}

/**
 * Read the RUNNING hub's per-module supervisor states via `GET /api/modules`
 * (design §6.4 module rows). The operator token's `admin` scope-set carries
 * `parachute:host:auth` (the scope `/api/modules` gates on), so the same
 * read-never-mint operator-token→Bearer path {@link driveModuleOp} uses
 * authenticates this read.
 *
 * Used by `parachute status` on a UNIT-MANAGED box to source module rows from
 * the live supervisor instead of pidfiles. It is read-only and bounded; the
 * CALLER is responsible for degrading gracefully (hub down → don't call this;
 * no token → catch {@link NoOperatorTokenError}) so `status` never hangs/crashes.
 *
 * Throws:
 *   - {@link NoOperatorTokenError} — no operator.token on disk.
 *   - {@link OperatorTokenExpiredError} — token fully expired (actionable msg).
 *   - {@link ModuleOpHttpError} — hub answered non-2xx.
 */
export async function fetchModuleStates(deps: DriveModuleOpDeps): Promise<ModuleStatesResult> {
  const doFetch = deps.fetch ?? fetch;
  const baseUrl = (deps.baseUrl ?? DEFAULT_HUB_BASE_URL).replace(/\/+$/, "");
  const bearer = await resolveOperatorBearer(deps);

  const res = await doFetch(`${baseUrl}/api/modules`, {
    method: "GET",
    // `/api/modules` parses the scheme-cased `Bearer ` prefix; match it exactly.
    headers: { authorization: `Bearer ${bearer}` },
  });
  const body = await parseJsonSafe(res);
  if (res.status < 200 || res.status >= 300) {
    const { error, error_description } = asErrorBody(body);
    throw new ModuleOpHttpError(res.status, error, error_description);
  }
  const b = (body ?? {}) as { modules?: unknown; supervisor_available?: unknown };
  const supervisorAvailable = b.supervisor_available === true;
  const modules: ModuleStateSnapshot[] = Array.isArray(b.modules)
    ? b.modules
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
        .map((m) => ({
          short: typeof m.short === "string" ? m.short : "",
          installed: m.installed === true,
          installed_version: typeof m.installed_version === "string" ? m.installed_version : null,
          supervisor_status: typeof m.supervisor_status === "string" ? m.supervisor_status : null,
          pid: typeof m.pid === "number" ? m.pid : null,
          supervisor_start_error:
            m.supervisor_start_error !== undefined ? (m.supervisor_start_error ?? null) : null,
        }))
    : [];
  return { supervisorAvailable, modules };
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function asErrorBody(body: unknown): { error: string; error_description: string } {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const error = typeof b.error === "string" ? b.error : "error";
    const error_description =
      typeof b.error_description === "string" ? b.error_description : "request failed";
    return { error, error_description };
  }
  return { error: "error", error_description: "request failed" };
}

function extractOperationId(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const id = (body as Record<string, unknown>).operation_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

function extractOpStatus(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const s = (body as Record<string, unknown>).status;
    if (typeof s === "string") return s;
  }
  return undefined;
}

function extractOpError(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === "string" && e.length > 0) return e;
  }
  return undefined;
}

// Re-export so CLI callers can catch the expired-token case without a second
// import from operator-token.ts.
export { OperatorTokenExpiredError };
