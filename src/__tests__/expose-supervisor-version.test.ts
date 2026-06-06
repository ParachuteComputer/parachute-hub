import { describe, expect, test } from "bun:test";
import { ensureHubUnitForExpose, resolveExposeSupervisor } from "../commands/expose-supervisor.ts";
import type { EnsureHubVersionMatchesResult } from "../hub-unit.ts";

/**
 * #590: `ensureHubUnitForExpose` must run the version-check-and-restart at the
 * expose adoption point, so an expose never wires a tunnel to a stale zombie
 * that merely answers /health on the canonical port. These tests drive the
 * version-check seam directly (no real launchctl / live hub).
 */
describe("ensureHubUnitForExpose — version-check at the expose adoption point (#590)", () => {
  function sup(
    ensureHubUnitOutcome: "already-up" | "started" | "no-unit",
    versionResult: EnsureHubVersionMatchesResult,
    versionSpy?: (port: number) => void,
  ) {
    return resolveExposeSupervisor({
      ensureHubUnit: async ({ port }) => ({
        outcome: ensureHubUnitOutcome,
        port: port ?? 1939,
        messages: ensureHubUnitOutcome === "no-unit" ? ["no hub unit installed"] : [],
      }),
      ensureHubVersion: async ({ port }) => {
        versionSpy?.(port);
        return versionResult;
      },
    });
  }

  test("hub up + version matches → ok, version check ran with the probed port", async () => {
    const logs: string[] = [];
    let checkedPort: number | undefined;
    const s = sup(
      "already-up",
      {
        outcome: "match",
        runningVersion: "0.6.4-rc.9",
        installedVersion: "0.6.4-rc.9",
        messages: [],
      },
      (p) => {
        checkedPort = p;
      },
    );
    const res = await ensureHubUnitForExpose(s, 1939, (l) => logs.push(l));
    expect(res.ok).toBe(true);
    expect(checkedPort).toBe(1939);
  });

  test("hub up but a stale zombie → restarted → ok (tunnel binds to NEW code)", async () => {
    const logs: string[] = [];
    const s = sup("already-up", {
      outcome: "restarted",
      runningVersion: "0.6.4-rc.9",
      installedVersion: "0.6.4-rc.9",
      messages: ["✓ hub unit restarted; now running 0.6.4-rc.9."],
    });
    const res = await ensureHubUnitForExpose(s, 1939, (l) => logs.push(l));
    expect(res.ok).toBe(true);
    expect(logs.join("\n")).toContain("now running 0.6.4-rc.9");
  });

  test("hub up but mismatch + NOT unit-managed → expose FAILS (don't tunnel to a zombie)", async () => {
    const logs: string[] = [];
    const s = sup("already-up", {
      outcome: "not-unit-managed",
      runningVersion: "0.5.14-rc.4",
      installedVersion: "0.6.4-rc.9",
      messages: ["⚠ the running hub is 0.5.14-rc.4 but 0.6.4-rc.9 is installed."],
    });
    const res = await ensureHubUnitForExpose(s, 1939, (l) => logs.push(l));
    expect(res.ok).toBe(false);
    expect(logs.join("\n")).toContain("0.5.14-rc.4");
  });

  test("still-mismatched after restart → expose CONTINUES (warn, don't block)", async () => {
    const logs: string[] = [];
    const s = sup("already-up", {
      outcome: "still-mismatched",
      runningVersion: "0.6.4-rc.8",
      installedVersion: "0.6.4-rc.9",
      messages: ["⚠ restarted the hub unit, but it is still not reporting 0.6.4-rc.9."],
    });
    const res = await ensureHubUnitForExpose(s, 1939, (l) => logs.push(l));
    expect(res.ok).toBe(true);
    expect(logs.join("\n")).toContain("still not reporting");
  });

  test("hub NOT up (no unit) → fails BEFORE the version check (no false adoption)", async () => {
    const logs: string[] = [];
    let versionRan = false;
    const s = sup(
      "no-unit",
      { outcome: "match", installedVersion: "0.6.4-rc.9", messages: [] },
      () => {
        versionRan = true;
      },
    );
    const res = await ensureHubUnitForExpose(s, 1939, (l) => logs.push(l));
    expect(res.ok).toBe(false);
    // The version check only runs once the hub is confirmed up.
    expect(versionRan).toBe(false);
  });
});
