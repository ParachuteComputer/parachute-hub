import { describe, expect, test } from "bun:test";
import { defaultHubUnitDeps } from "../hub-unit.ts";
import {
  guardServiceManagerCommand,
  isDestructiveServiceManagerCommand,
} from "../launchctl-guard.ts";
import { defaultManagedUnitDeps } from "../managed-unit.ts";

// ===========================================================================
// hub#535 — test-isolation boundary guard for destructive service-manager verbs.
//
// THE OUTAGE: a hub test on a LIVE machine reached the PRODUCTION default Runner
// (`Bun.spawnSync(["launchctl","bootout","computer.parachute.hub"])`) — a daemon-
// op helper was called with the default `deps`, not an injected fake — and
// `launchctl bootout`'d the real running hub daemon, taking the whole ecosystem
// down. The guard makes that impossible: under a test runner the default Runner
// REFUSES destructive launchd/systemd verbs and THROWS, so a test that forgets to
// inject a fake `run` fails loudly instead of nuking the operator's daemon.
//
// These tests run under `bun test` ⇒ NODE_ENV === "test" ⇒ the guard is ACTIVE.
// ===========================================================================

describe("isDestructiveServiceManagerCommand — classification", () => {
  test("launchd destructive verbs are flagged", () => {
    for (const verb of ["bootout", "bootstrap", "load", "unload", "kickstart"]) {
      expect(
        isDestructiveServiceManagerCommand(["launchctl", verb, "gui/501/computer.parachute.hub"]),
      ).toBe(true);
    }
  });

  test("launchd read-only verbs are NOT flagged", () => {
    // `print` (state descriptor) and `list` are diagnostics — tests legitimately
    // exercise these through the default deps, so the guard must leave them alone.
    expect(
      isDestructiveServiceManagerCommand(["launchctl", "print", "gui/501/computer.parachute.hub"]),
    ).toBe(false);
    expect(isDestructiveServiceManagerCommand(["launchctl", "list"])).toBe(false);
  });

  test("systemd destructive verbs are flagged (incl. --user / --now flags skipped)", () => {
    expect(
      isDestructiveServiceManagerCommand([
        "systemctl",
        "--user",
        "enable",
        "--now",
        "parachute-hub.service",
      ]),
    ).toBe(true);
    expect(
      isDestructiveServiceManagerCommand([
        "systemctl",
        "disable",
        "--now",
        "parachute-vault.service",
      ]),
    ).toBe(true);
    for (const verb of ["start", "stop", "restart", "daemon-reload", "mask"]) {
      expect(
        isDestructiveServiceManagerCommand(["systemctl", "--user", verb, "parachute-hub.service"]),
      ).toBe(true);
    }
  });

  test("systemd read-only verbs are NOT flagged", () => {
    expect(
      isDestructiveServiceManagerCommand([
        "systemctl",
        "--user",
        "is-active",
        "parachute-hub.service",
      ]),
    ).toBe(false);
    expect(
      isDestructiveServiceManagerCommand(["systemctl", "is-enabled", "parachute-vault.service"]),
    ).toBe(false);
  });

  test("unrelated tools / loginctl / journalctl are NOT flagged", () => {
    expect(isDestructiveServiceManagerCommand(["loginctl", "enable-linger", "op"])).toBe(false);
    expect(
      isDestructiveServiceManagerCommand(["journalctl", "--user", "-u", "parachute-hub.service"]),
    ).toBe(false);
    expect(isDestructiveServiceManagerCommand(["ps", "-o", "command=", "-p", "123"])).toBe(false);
    expect(isDestructiveServiceManagerCommand([])).toBe(false);
  });

  test("absolute-path tool is still classified (basename match)", () => {
    // Defense in depth: in this repo every invocation is bare, but if one ever
    // used an absolute path the guard must still recognize it.
    expect(
      isDestructiveServiceManagerCommand([
        "/bin/launchctl",
        "bootout",
        "gui/0/computer.parachute.hub",
      ]),
    ).toBe(true);
  });
});

describe("guardServiceManagerCommand — throws under a test runner", () => {
  test("throws on launchctl bootout (the exact outage command)", () => {
    expect(() =>
      guardServiceManagerCommand(["launchctl", "bootout", "gui/501/computer.parachute.hub"]),
    ).toThrow(/launchctl-guard.*Refusing to run a destructive service-manager command/s);
  });

  test("does NOT throw on a read-only command", () => {
    expect(() =>
      guardServiceManagerCommand(["launchctl", "print", "gui/501/computer.parachute.hub"]),
    ).not.toThrow();
  });

  test("opt-out env var (PARACHUTE_ALLOW_REAL_LAUNCHCTL) lets a deliberate call through", () => {
    const prev = process.env.PARACHUTE_ALLOW_REAL_LAUNCHCTL;
    process.env.PARACHUTE_ALLOW_REAL_LAUNCHCTL = "1";
    try {
      expect(() =>
        guardServiceManagerCommand(["launchctl", "bootout", "gui/501/computer.parachute.SAFE"]),
      ).not.toThrow();
    } finally {
      // Restore — `= undefined` to clear (the codebase convention; biome flags
      // `delete process.env.X` as a perf foot-gun. See hub-settings.test.ts).
      if (prev === undefined) process.env.PARACHUTE_ALLOW_REAL_LAUNCHCTL = undefined;
      else process.env.PARACHUTE_ALLOW_REAL_LAUNCHCTL = prev;
    }
  });
});

// ===========================================================================
// THE REGRESSION TEST (hub#535 layer c): the PRODUCTION default deps — the ones a
// daemon-op helper falls back to when a test forgets to inject a fake `run` — must
// REFUSE the real launchctl under a test runner. If the guard regresses (someone
// removes it from `defaultManagedUnitDeps.run`), these flip from "throws" to
// "spawns the real launchctl" and this test fails — BEFORE the change can reach a
// machine and bootout the live daemon.
//
// We assert via `defaultManagedUnitDeps.run` directly (the single chokepoint every
// bare-launchctl call in the codebase routes through) and via `defaultHubUnitDeps`
// (which spreads the same `run`), proving both seams are protected.
// ===========================================================================
describe("default Runner refuses real launchctl under test (regression — hub#535)", () => {
  test("defaultManagedUnitDeps.run THROWS on `launchctl bootout` instead of spawning", () => {
    expect(() =>
      defaultManagedUnitDeps.run(["launchctl", "bootout", "gui/501/computer.parachute.hub"]),
    ).toThrow(/launchctl-guard/);
  });

  test("defaultHubUnitDeps.run (inherits the guard via spread) THROWS on `launchctl kickstart`", () => {
    expect(() =>
      defaultHubUnitDeps.run(["launchctl", "kickstart", "-k", "gui/501/computer.parachute.hub"]),
    ).toThrow(/launchctl-guard/);
  });

  test("default deps THROW on `systemctl --user disable --now` too", () => {
    expect(() =>
      defaultManagedUnitDeps.run([
        "systemctl",
        "--user",
        "disable",
        "--now",
        "parachute-vault.service",
      ]),
    ).toThrow(/launchctl-guard/);
  });

  test("default deps still RUN a read-only `launchctl print` (guard is verb-scoped, not a blanket block)", () => {
    // The property under test: the GUARD does not block a read-only `print`
    // (verb-scoped, not a blanket launchctl block) — so it never throws the
    // `/launchctl-guard/` error for it. What happens AFTER the guard allows it
    // through is environment-dependent and NOT under test:
    //   - dev Mac under the test PATH shim → fake launchctl, exit 0, no throw
    //   - real Mac → `launchctl print` of a non-loaded label returns nonzero, no throw
    //   - Linux CI (no launchctl on PATH) → the spawn throws ENOENT
    //     ("Executable not found in $PATH") — which is NOT the guard, and still
    //     proves the guard let the command reach the spawn.
    // So: assert only that no error thrown here is a GUARD throw.
    try {
      defaultManagedUnitDeps.run(["launchctl", "print", "gui/501/computer.parachute.NONEXISTENT"]);
    } catch (err) {
      expect(String((err as { message?: unknown })?.message ?? err)).not.toMatch(/launchctl-guard/);
    }
  });
});
