import { describe, expect, test } from "bun:test";
import { orphanAttributable } from "../orphan-attribution.ts";

describe("orphanAttributable — two attribution modes (#601 review)", () => {
  const ownerOfPid = (cmdlines: Record<number, string | undefined>) => (pid: number) =>
    cmdlines[pid];

  test("recorded-pid match → attributable in BOTH modes (cmdline not even read)", () => {
    // No cmdline available, but the orphan IS the recorded pid → trivially ours.
    const probe = ownerOfPid({});
    const broad = orphanAttributable({
      orphan: 100,
      recordedPid: 100,
      short: "vault",
      startCmdHint: undefined,
      ownerOfPid: probe,
    });
    const perModule = orphanAttributable({
      orphan: 100,
      recordedPid: 100,
      short: "vault",
      startCmdHint: undefined,
      ownerOfPid: probe,
      moduleMarker: "parachute-vault",
    });
    expect(broad.attributable).toBe(true);
    expect(perModule.attributable).toBe(true);
  });

  test("broad mode (no moduleMarker): any `parachute` cmdline is attributable", () => {
    const res = orphanAttributable({
      orphan: 200,
      recordedPid: undefined,
      short: "vault",
      startCmdHint: undefined,
      ownerOfPid: ownerOfPid({ 200: "parachute-scribe serve" }),
    });
    // Migrate-sweep width: a sibling parachute process still counts.
    expect(res.attributable).toBe(true);
    expect(res.cmdline).toBe("parachute-scribe serve");
  });

  test("per-module mode: own marker matches → attributable", () => {
    const res = orphanAttributable({
      orphan: 300,
      recordedPid: undefined,
      short: "vault",
      startCmdHint: undefined,
      ownerOfPid: ownerOfPid({ 300: "parachute-vault serve" }),
      moduleMarker: "parachute-vault",
    });
    expect(res.attributable).toBe(true);
  });

  test("per-module mode: a SIBLING parachute module is NOT attributable (cross-module-kill guard)", () => {
    const res = orphanAttributable({
      orphan: 400,
      recordedPid: undefined,
      short: "vault",
      startCmdHint: undefined,
      // A real parachute process (carries `parachute`) — but it's SCRIBE, not
      // vault. The broad mode would attribute it; per-module must not.
      ownerOfPid: ownerOfPid({ 400: "parachute-scribe serve" }),
      moduleMarker: "parachute-vault",
    });
    expect(res.attributable).toBe(false);
    // The cmdline is still returned so the caller can surface it in the message.
    expect(res.cmdline).toBe("parachute-scribe serve");
  });

  test("either mode: unreadable cmdline + non-matching pid → NOT attributable", () => {
    for (const moduleMarker of [undefined, "parachute-vault"]) {
      const res = orphanAttributable({
        orphan: 500,
        recordedPid: 999, // different from orphan
        short: "vault",
        startCmdHint: undefined,
        ownerOfPid: ownerOfPid({}), // returns undefined
        moduleMarker,
      });
      expect(res.attributable).toBe(false);
      expect(res.cmdline).toBeUndefined();
    }
  });

  test("startCmdHint is an additional needle in per-module mode", () => {
    const res = orphanAttributable({
      orphan: 600,
      recordedPid: undefined,
      short: "vault",
      startCmdHint: "my-custom-server.ts",
      // cmdline lacks the module binary but carries the explicit hint.
      ownerOfPid: ownerOfPid({ 600: "node /opt/my-custom-server.ts" }),
      moduleMarker: "parachute-vault",
    });
    expect(res.attributable).toBe(true);
  });
});
