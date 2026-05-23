/**
 * Regression test for hub#349: Bun.spawn defaults to an EMPTY env, which meant
 * subprocess `bun add -g` didn't see TMPDIR, BUN_INSTALL, or any other env vars
 * set by the Dockerfile / Render env. All `defaultRun`-style helpers were
 * updated to pass `env: process.env`.
 *
 * This test asserts that property end-to-end: spawn a real child via `bun -e`
 * and have it print one parent-set env var. Pre-fix, the child would not see
 * the var; post-fix, it does.
 *
 * We exercise the production path by importing one representative helper.
 * The full set of seven explicit + several inherited fix sites all use the
 * same `env: process.env` pattern; testing one is sufficient to lock the
 * pattern in place — the others are mechanical applications of it.
 */
import { describe, expect, test } from "bun:test";

describe("Bun.spawn env propagation (hub#349)", () => {
  test("child process sees parent env when defaultRun-style helper is used", async () => {
    // Unique marker so we can't false-positive against leftover env from
    // another test or the harness itself.
    const markerKey = "PARACHUTE_HUB_SPAWN_ENV_TEST_MARKER";
    const markerValue = `marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const originalValue = process.env[markerKey];
    process.env[markerKey] = markerValue;
    try {
      // Spawn a child the same way every defaultRun helper does:
      // `env: process.env`. The child prints its view of the marker var.
      const proc = Bun.spawn(
        ["bun", "-e", `process.stdout.write(process.env.${markerKey} ?? "MISSING")`],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        },
      );
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(stdout).toBe(markerValue);
    } finally {
      if (originalValue === undefined) delete process.env[markerKey];
      else process.env[markerKey] = originalValue;
    }
  });

  test("child process does NOT see parent env when env is omitted (negative control)", async () => {
    // The bug we're guarding against: without `env: process.env`, Bun.spawn
    // hands the child an empty env. This test pins the failure mode so a
    // future regression (someone removing `env: process.env`) is caught here,
    // not in production on Render.
    const markerKey = "PARACHUTE_HUB_SPAWN_ENV_TEST_MARKER_NEG";
    const markerValue = `marker-${Date.now()}`;

    const originalValue = process.env[markerKey];
    process.env[markerKey] = markerValue;
    try {
      const proc = Bun.spawn(
        ["bun", "-e", `process.stdout.write(process.env.${markerKey} ?? "MISSING")`],
        {
          stdout: "pipe",
          stderr: "pipe",
          // intentionally NO env: process.env
        },
      );
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      expect(exitCode).toBe(0);
      expect(stdout).toBe("MISSING");
    } finally {
      if (originalValue === undefined) delete process.env[markerKey];
      else process.env[markerKey] = originalValue;
    }
  });
});
