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
    if (operationId) {
      const terminal = await pollOperation(operationId, bearer, baseUrl, doFetch, deps);
      return { status: res.status, body: terminal, operationId };
    }
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
