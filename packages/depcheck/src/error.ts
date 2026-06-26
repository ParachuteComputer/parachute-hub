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

import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { delimiter as pathDelimiter, join as pathJoin } from "node:path";
import {
  type FormatOpts,
  type MissingDependencyWire,
  formatMissingDependency,
  formatNonExecutable,
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
 * #634: thrown when `binary` IS present on PATH but is NOT executable (a
 * 100644 file). Distinct from `MissingDependencyError` so a catch site can tell
 * "not installed" (reinstall) from "present but un-runnable" (`chmod +x`). The
 * `path` is where the non-executable file was found; `.message` is already the
 * formatted `chmod +x` block.
 *
 * `errorType` is a literal discriminant matching the wire's `error_type`.
 */
export class NonExecutableError extends Error {
  readonly errorType = "non_executable" as const;
  readonly binary: string;
  readonly path: string;

  constructor(binary: string, path: string, opts?: { interactive?: boolean }) {
    const formatOpts: FormatOpts = {};
    if (opts?.interactive !== undefined) formatOpts.interactive = opts.interactive;
    super(formatNonExecutable(binary, path, formatOpts));
    this.name = "NonExecutableError";
    this.binary = binary;
    this.path = path;
  }
}

/**
 * #634 secondary probe: when `Bun.which` (which requires X_OK) returns null,
 * walk `$PATH` looking for a file named `binary` that EXISTS but is NOT
 * executable — the case `which` collapses into "not found". Returns the first
 * such path, or null when no present-but-non-executable candidate is found
 * (genuinely not installed). Errors statting any candidate are swallowed (a
 * dangling symlink / EACCES on a dir entry must not mask the real not-found).
 *
 * Production default for `ensureExecutable`'s secondary probe. Gated to the
 * production path (see `ensureExecutable`) so the pure `which`-seam tests never
 * touch the real filesystem.
 */
export function findNonExecutableOnPath(
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(pathDelimiter)) {
    if (!dir) continue;
    const candidate = pathJoin(dir, binary);
    try {
      if (!statSync(candidate).isFile()) continue;
      // Present + a regular file. Is it NON-executable? accessSync(X_OK) throws
      // when it lacks the exec bit — that throw IS the "non-executable" signal.
      try {
        accessSync(candidate, fsConstants.X_OK);
        // Executable after all (race / odd PATH ordering) — not our case.
      } catch {
        return candidate;
      }
    } catch {
      // Not present at this dir, dangling symlink, or unreadable — keep walking.
    }
  }
  return null;
}

/**
 * Throw `MissingDependencyError` if `binary` isn't resolvable on PATH.
 *
 * `which` is a TEST SEAM (default `Bun.which`) so tests can force the
 * missing branch without uninstalling the binary from the host. The spec is
 * looked up from the registry — an unregistered binary still throws (the
 * error renders the generic "ask your sysadmin" message), never silently
 * passes.
 *
 * #634: `Bun.which` requires X_OK, so a present-but-non-executable binary
 * (100644 — a `bin` that lost its +x bit) returns null and would render the
 * misleading "not installed" message. When `which` returns null we run a
 * secondary probe (`findNonExecutable`) that walks PATH IGNORING X_OK; a hit
 * throws the distinct `NonExecutableError` ("found at <path> but is not
 * executable — run chmod +x") instead. The secondary probe runs only on the
 * PRODUCTION path (real `Bun.which`, or an explicitly-injected probe) — pure
 * `which`-seam tests that inject a stub `which` keep their pure not-found
 * behavior and never touch the real filesystem.
 */
export function ensureExecutable(
  binary: string,
  opts?: {
    which?: (cmd: string) => string | null;
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    /**
     * #634 secondary-probe seam. Defaults to the real PATH walk ONLY on the
     * production path (no injected `which`, or `which === Bun.which`); when a
     * test injects a stub `which`, this defaults to a no-op (returns null) so
     * the pure not-found seam is preserved. Tests covering the non-executable
     * branch inject this explicitly.
     */
    findNonExecutable?: (binary: string) => string | null;
  },
): void {
  const which = opts?.which ?? Bun.which;
  if (which(binary) !== null) return;

  // #634: present-but-non-executable detection. Use the explicit probe if
  // injected; else use the real walk only when `which` is the production
  // resolver (so a stubbed-`which` test stays pure / fs-free).
  const isProductionWhich = opts?.which === undefined || opts.which === Bun.which;
  const probe =
    opts?.findNonExecutable ?? (isProductionWhich ? findNonExecutableOnPath : () => null);
  const nonExecPath = probe(binary);
  if (nonExecPath !== null) {
    throw new NonExecutableError(binary, nonExecPath);
  }

  const errOpts: { platform?: NodeJS.Platform; arch?: NodeJS.Architecture } = {};
  if (opts?.platform !== undefined) errOpts.platform = opts.platform;
  if (opts?.arch !== undefined) errOpts.arch = opts.arch;
  throw new MissingDependencyError(binary, lookupDep(binary), errOpts);
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
