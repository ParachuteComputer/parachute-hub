/**
 * Test-isolation boundary guard for destructive service-manager verbs (hub#535).
 *
 * THE OUTAGE (2026-06-03): a hub test running on a LIVE operator machine reached
 * the production default Runner — `Bun.spawnSync(["launchctl", "bootout", …])` —
 * with the real hub label, and `launchctl bootout computer.parachute.hub`'d the
 * running `computer.parachute.hub` launchd daemon, taking hub + vault + scribe
 * down under the operator's feet. Every daemon-op helper (`removeManagedUnit`,
 * `installManagedUnit`, `stopHubUnit`/`restartHubUnit`, `disableStaleModuleUnits`,
 * `teardownHubUnit`) shells launchctl through an injectable `deps.run([...])`
 * whose PRODUCTION DEFAULT is a real spawn. A test that forgets to inject a fake
 * `run` (or whose fake gets removed in a refactor) silently falls back to that
 * real spawn → it drives the operator's actual service manager.
 *
 * THE GUARD: when running under a test runner (`NODE_ENV === "test"`, which Bun
 * sets automatically for `bun test`), the production default Runner REFUSES the
 * destructive launchd verbs — `bootout`, `bootstrap`, `load`, `kickstart` (and
 * their systemd analogues `enable`/`disable`/`start`/`stop`/`restart` against a
 * real systemctl) — and THROWS loudly instead of spawning. A test is thereby
 * FORCED to inject a fake `run`; it can never reach the operator's live daemon by
 * omission. Read-only verbs (`launchctl print`, `systemctl is-active`/
 * `is-enabled`, `journalctl`, `loginctl`, `which`-style probes) are left alone —
 * they're harmless and some tests intentionally exercise the default deps for
 * them.
 *
 * PRODUCTION BEHAVIOR IS IDENTICAL: outside a test runner (`NODE_ENV !== "test"`)
 * the guard is a no-op and the spawn proceeds exactly as before. There is also an
 * explicit escape hatch — `PARACHUTE_ALLOW_REAL_LAUNCHCTL=1` — for the rare
 * deliberate integration test that genuinely wants to drive a real (sandboxed)
 * manager; it must opt IN, loudly, rather than reaching the daemon by accident.
 *
 * This is layer (a) of the hub#535 fix (the durable boundary guard). Layer (b) is
 * the targeted fake-injection in the offending tests; layer (c) is the regression
 * test that asserts the default deps throw here rather than spawn.
 */

/** Destructive launchd subcommands that mutate / tear down a loaded unit. */
const DESTRUCTIVE_LAUNCHCTL_VERBS = new Set([
  "bootout",
  "bootstrap",
  "load",
  "unload",
  "kickstart",
]);

/**
 * Destructive systemd subcommands that mutate a unit's run/enable state. `enable`
 * / `disable` may carry `--now` (which also starts/stops); `start`/`stop`/
 * `restart` mutate run-state directly. Read-only `is-active` / `is-enabled` /
 * `show` / `status` / `cat` are NOT here — tests use the default deps for those.
 */
const DESTRUCTIVE_SYSTEMCTL_VERBS = new Set([
  "start",
  "stop",
  "restart",
  "reload",
  "enable",
  "disable",
  "daemon-reload",
  "mask",
  "unmask",
]);

/** True when we're executing under a test runner. Bun sets NODE_ENV=test for `bun test`. */
function underTestRunner(): boolean {
  return process.env.NODE_ENV === "test";
}

/** True when an operator has explicitly opted in to real service-manager calls under test. */
function realCallsExplicitlyAllowed(): boolean {
  const v = process.env.PARACHUTE_ALLOW_REAL_LAUNCHCTL;
  return v === "1" || v === "true";
}

/**
 * Find the first meaningful subcommand token after the tool name, skipping
 * scope/option flags (`--user`, `-k`, `--now`, etc.) so we classify the VERB,
 * not a flag. Returns undefined when there's nothing past the flags.
 */
function firstSubcommand(rest: readonly string[]): string | undefined {
  for (const tok of rest) {
    if (tok.startsWith("-")) continue;
    return tok;
  }
  return undefined;
}

/**
 * Decide whether a command (as the argv the default Runner is about to spawn) is
 * a DESTRUCTIVE service-manager mutation that must be blocked under a test runner.
 *
 *   - `launchctl <verb> …` where verb ∈ {bootout, bootstrap, load, unload, kickstart}
 *   - `systemctl [--user] <verb> …` where verb ∈ {start, stop, restart, reload,
 *     enable, disable, daemon-reload, mask, unmask}
 *
 * The tool name is matched on the basename so an absolute path (`/bin/launchctl`)
 * is classified too — though in this codebase every invocation is bare (the PATH
 * shim's safety relies on that), this keeps the guard correct regardless.
 */
export function isDestructiveServiceManagerCommand(cmd: readonly string[]): boolean {
  if (cmd.length === 0) return false;
  const tool = (cmd[0] ?? "").split("/").pop() ?? "";
  const rest = cmd.slice(1);
  const verb = firstSubcommand(rest);
  if (verb === undefined) return false;
  if (tool === "launchctl") return DESTRUCTIVE_LAUNCHCTL_VERBS.has(verb);
  if (tool === "systemctl") return DESTRUCTIVE_SYSTEMCTL_VERBS.has(verb);
  return false;
}

/**
 * The boundary guard the production default Runner calls before spawning. When
 * running under a test runner and NOT explicitly opted in, a destructive
 * service-manager command THROWS — forcing the test to inject a fake `run`
 * instead of driving the operator's live daemon. A no-op everywhere else
 * (production, or a non-destructive/read-only command, or explicit opt-in).
 *
 * The thrown error names the exact command and tells the author how to fix it,
 * so a regressed test fails with an actionable message rather than a silent
 * daemon teardown.
 */
export function guardServiceManagerCommand(cmd: readonly string[]): void {
  if (!underTestRunner()) return; // production — spawn proceeds unchanged.
  if (realCallsExplicitlyAllowed()) return; // deliberate integration test opted in.
  if (!isDestructiveServiceManagerCommand(cmd)) return; // read-only / unrelated — fine.
  throw new Error(
    `[launchctl-guard] Refusing to run a destructive service-manager command under a test runner: \`${cmd.join(
      " ",
    )}\`. The default (production) Runner shells out to the REAL launchctl/systemctl — on a live machine this would tear down the operator's running daemon (this is the hub#535 outage class). Inject a fake \`run\` into this code path's deps so the test never touches the real service manager. (If you GENUINELY need a real, sandboxed manager call in this test, set PARACHUTE_ALLOW_REAL_LAUNCHCTL=1 to opt in.)`,
  );
}
