/**
 * `MissingDependencyError` + the ENOENT spawn-error helpers.
 *
 * This is the behavior layer over the data registry: it turns "the binary
 * isn't on PATH" — detected either by a pre-spawn `Bun.which` check or by a
 * post-spawn ENOENT catch — into a single typed error carrying the spec, so
 * every call site renders the same message and the same wire shape.
 *
 * Generalizes vault's `git-preflight.ts` (`ensureGitAvailable` +
 * `isGitNotFoundSpawnError`) and hub's `cloudflare/detect.ts`
 * (`isBinaryNotFoundError`) into one place.
 */

import {
  type FormatOpts,
  type MissingDependencyWire,
  formatMissingDependency,
  toMissingDependencyWire,
} from "./format.js";
import { type DepSpec, lookupDep } from "./registry.js";

/**
 * Thrown when a required binary isn't resolvable on PATH. Carries the binary
 * name + (looked-up) spec so any catch site can render the operator message
 * (`.message` is already the formatted block) or the wire shape (`.toWire()`).
 *
 * `errorType` is a literal discriminant so a consumer can branch on it
 * structurally (matches the wire's `error_type`).
 */
export class MissingDependencyError extends Error {
  readonly errorType = "missing_dependency" as const;
  readonly binary: string;
  readonly spec: DepSpec | undefined;
  private readonly formatOpts: FormatOpts;

  constructor(
    binary: string,
    spec?: DepSpec,
    opts?: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture; interactive?: boolean },
  ) {
    const formatOpts: FormatOpts = {};
    if (opts?.platform !== undefined) formatOpts.platform = opts.platform;
    if (opts?.arch !== undefined) formatOpts.arch = opts.arch;
    if (opts?.interactive !== undefined) formatOpts.interactive = opts.interactive;
    super(formatMissingDependency(binary, spec, formatOpts));
    this.name = "MissingDependencyError";
    this.binary = binary;
    this.spec = spec;
    this.formatOpts = formatOpts;
  }

  /** Structured wire shape for an API/SPA consumer. Uses the same
   * platform/arch the error was constructed with. */
  toWire(): MissingDependencyWire {
    return toMissingDependencyWire(this.binary, this.spec, this.formatOpts);
  }
}

/**
 * Throw `MissingDependencyError` if `binary` isn't resolvable on PATH.
 *
 * `which` is a TEST SEAM (default `Bun.which`) so tests can force the
 * missing branch without uninstalling the binary from the host. The spec is
 * looked up from the registry — an unregistered binary still throws (the
 * error renders the generic "ask your sysadmin" message), never silently
 * passes.
 */
export function ensureExecutable(
  binary: string,
  opts?: {
    which?: (cmd: string) => string | null;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
  },
): void {
  const which = opts?.which ?? Bun.which;
  if (which(binary) === null) {
    const errOpts: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture } = {};
    if (opts?.platform !== undefined) errOpts.platform = opts.platform;
    if (opts?.arch !== undefined) errOpts.arch = opts.arch;
    throw new MissingDependencyError(binary, lookupDep(binary), errOpts);
  }
}

/**
 * Heuristic: does this error look like the "executable not found on PATH"
 * failure a spawn throws when it can't resolve the binary?
 *
 * Matches `code === "ENOENT"` OR a message mentioning `Executable not found`
 * / `not found` / `No such file` (Bun's spawn-error message shape varies
 * across versions; Node uses ENOENT). When `binary` is supplied, a
 * message-only match additionally requires the message to mention the binary
 * — so a `not found` message about some OTHER file doesn't get mis-attributed.
 *
 * CRITICAL: this matches ONLY not-found. EACCES (non-executable file),
 * corrupt binaries, and every other error must propagate — we never want to
 * report "not installed" when something more specific is wrong. (Mirrors the
 * swallow-only-ENOENT contract in vault's git-preflight + hub's detect.ts.)
 */
export function isBinaryNotFoundError(err: unknown, binary?: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  // `code === "ENOENT"` is the unambiguous, structured not-found signal — a
  // spawn that couldn't resolve the executable. We accept it regardless of
  // the message (the errno IS the signal; the message is often generic like
  // "spawn failed"). Binary attribution applies only to the looser
  // message-string match below, where "not found" could be about anything.
  if (e.code === "ENOENT") return true;
  if (typeof e.message === "string") {
    const msg = e.message;
    // `ENOENT` in the message is also a not-found signal — some runtimes only
    // surface the errno in the message string, not a `.code` field. (Matches
    // the prior hub detect.ts matcher, which included ENOENT in this regex.)
    const looksNotFound = /Executable not found|not found|No such file|ENOENT/i.test(msg);
    if (!looksNotFound) return false;
    if (binary) return msg.includes(binary);
    return true;
  }
  return false;
}

/**
 * If `err` is a binary-not-found spawn error for `binary`, throw a
 * `MissingDependencyError` (carrying the registry spec). Otherwise return —
 * the caller's surrounding catch re-handles non-not-found errors.
 *
 * The belt-and-suspenders companion to `ensureExecutable`: a spawn that
 * slips past the pre-flight (race where the binary is removed between check
 * and spawn, or a path that didn't pre-flight) still surfaces the friendly
 * error instead of the raw `Executable not found in $PATH` string.
 */
export function rethrowIfMissing(
  err: unknown,
  binary: string,
  opts?: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture },
): void {
  if (isBinaryNotFoundError(err, binary)) {
    const errOpts: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture } = {};
    if (opts?.platform !== undefined) errOpts.platform = opts.platform;
    if (opts?.arch !== undefined) errOpts.arch = opts.arch;
    throw new MissingDependencyError(binary, lookupDep(binary), errOpts);
  }
}
