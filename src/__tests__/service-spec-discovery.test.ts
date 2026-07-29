import { describe, expect, test } from "bun:test";
import {
  FIRST_PARTY_FALLBACKS,
  KNOWN_MODULES,
  PORT_RESERVATIONS,
  RETIRED_MODULES,
  discoverableShorts,
  findServiceByShort,
  focusForShort,
  isInstallableShort,
  isKnownModuleShort,
  isRetiredShort,
  retirementNote,
  shortNameForManifest,
  getSpec,
} from "../service-spec.ts";

// 2026-06-09 modular-UI architecture (P2): discovery is driven by the union of
// the bootstrap registries + self-registration, NOT a CURATED_MODULES
// whitelist. These helpers are the seam.

describe("discoverableShorts", () => {
  test("is the deduped union of FIRST_PARTY_FALLBACKS ∪ KNOWN_MODULES, minus retired", () => {
    const shorts = discoverableShorts();
    const expected = new Set(
      [...Object.keys(FIRST_PARTY_FALLBACKS), ...Object.keys(KNOWN_MODULES)].filter(
        (s) => !isRetiredShort(s),
      ),
    );
    expect(new Set(shorts)).toEqual(expected);
    // No duplicates.
    expect(shorts.length).toBe(new Set(shorts).size);
  });

  test("includes the supported set; excludes removed Agent and retired notes", () => {
    const shorts = discoverableShorts();
    for (const s of ["vault", "scribe", "surface", "app"]) {
      expect(shorts).toContain(s);
    }
    expect(shorts).not.toContain("agent");
    // hub#788 — notes is retired. It resolves, but it is not discovered.
    expect(shorts).not.toContain("notes");
  });

  test("FIRST_PARTY_FALLBACKS shorts lead KNOWN_MODULES shorts (registry order)", () => {
    const shorts = discoverableShorts();
    // app (a FALLBACK) appears before vault (KNOWN_MODULES) in the union.
    expect(shorts.indexOf("app")).toBeLessThan(shorts.indexOf("vault"));
  });
});

describe("focusForShort", () => {
  test("declared focus wins over the default map", () => {
    // agent defaults experimental, but a manifest-declared core wins.
    expect(focusForShort("agent", "core")).toBe("core");
    // vault defaults core, but a declared experimental wins.
    expect(focusForShort("vault", "experimental")).toBe("experimental");
  });

  test("falls back to the default tier map when undeclared", () => {
    expect(focusForShort("vault")).toBe("core");
    expect(focusForShort("surface")).toBe("core");
    expect(focusForShort("app")).toBe("core");
    // agent stays a legit experimental preview — still offered on a fresh install.
    expect(focusForShort("agent")).toBe("experimental");
  });

  test("unlisted shorts default to experimental", () => {
    expect(focusForShort("some-third-party-module")).toBe("experimental");
  });

  test("a declared deprecated focus is honored over the default map", () => {
    // A module can self-declare `deprecated` in its module.json.
    expect(focusForShort("agent", "deprecated")).toBe("deprecated");
  });

});

// hub#788 — notes + scribe retirement. Graceful by design: an operator who
// already runs them keeps running them; nobody new is offered them.
//
// The distinction that carries the whole thing is `isKnownModuleShort`
// (RESOLVE — still true, so lifecycle/status/expose work on an existing row)
// vs `isInstallableShort` (INSTALL — now false). Collapsing those two would
// either break existing installs or keep handing out retired modules.
describe("retired modules (hub#788)", () => {
  for (const short of ["notes"]) {
    test(`${short} still RESOLVES so an existing services.json row keeps working`, () => {
      expect(isKnownModuleShort(short)).toBe(true);
      expect(isRetiredShort(short)).toBe(true);
      // A spec is still composable — that's what lifecycle needs.
      expect(getSpec(short)?.manifestName).toBe(`parachute-${short}`);
    });

    test(`${short} is NOT discoverable and NOT installable`, () => {
      expect(discoverableShorts()).not.toContain(short);
      expect(isInstallableShort(short)).toBe(false);
    });

    test(`${short} carries an operator-facing retirement note`, () => {
      const note = retirementNote(short);
      expect(note).toBeTruthy();
      expect(note).toMatch(/retired/i);
    });
  }

  test("live modules stay installable", () => {
    for (const short of ["vault", "scribe", "surface", "app"]) {
      expect(isInstallableShort(short)).toBe(true);
      expect(isRetiredShort(short)).toBe(false);
    }
  });
});

// Runner registry removal (decision: Aaron 2026-07-01 — the module set of
// record is vault / hub / agent / scribe / surface). Runner is fully out of
// the bootstrap registries: not discoverable, not a known short, and its
// manifest name no longer resolves. It is NOT in RETIRED_MODULES (that would
// GC a legacy operator's services.json row on load) — an existing install is
// handled as an unknown/third-party row instead (see serve-boot tests).
describe("runner registry removal (2026-07-01)", () => {
  test("runner is no longer a known/discoverable short", () => {
    expect(isKnownModuleShort("runner")).toBe(false);
    expect(discoverableShorts()).not.toContain("runner");
    expect("runner" in KNOWN_MODULES).toBe(false);
    expect("runner" in FIRST_PARTY_FALLBACKS).toBe(false);
  });

  test("parachute-runner no longer resolves to a short — legacy rows are third-party-shaped", () => {
    // Consumers (status / serve-boot / api-modules) fall back to the row's
    // own name when this returns undefined, which is what keeps an existing
    // runner install rendering + booting instead of crashing.
    expect(shortNameForManifest("parachute-runner")).toBeUndefined();
  });

  test("an unlisted runner short defaults to the experimental tier, like any third-party", () => {
    expect(focusForShort("runner")).toBe("experimental");
  });
});

describe("Agent module retirement (2026-07-15)", () => {
  test("is no longer known, discoverable, or resolvable", () => {
    expect(isKnownModuleShort("agent")).toBe(false);
    expect(discoverableShorts()).not.toContain("agent");
    expect("agent" in KNOWN_MODULES).toBe(false);
    expect(shortNameForManifest("parachute-agent")).toBeUndefined();
    expect(shortNameForManifest("parachute-channel")).toBeUndefined();
  });

  test("retires every historical row name and releases port 1941", () => {
    expect(RETIRED_MODULES.agent).toBeDefined();
    expect(RETIRED_MODULES["parachute-agent"]).toBeDefined();
    expect(RETIRED_MODULES["parachute-channel"]).toBeDefined();
    expect(PORT_RESERVATIONS.find((entry) => entry.port === 1941)).toEqual({
      port: 1941,
      name: "unassigned",
      status: "reserved",
    });
  });
});

describe("isKnownModuleShort", () => {
  test("true for every known module (the install/config gate)", () => {
    for (const s of ["vault", "scribe", "surface", "app", "notes"]) {
      expect(isKnownModuleShort(s)).toBe(true);
    }
  });

  test("false for the hub itself + genuinely third-party shorts", () => {
    expect(isKnownModuleShort("hub")).toBe(false);
    expect(isKnownModuleShort("random")).toBe(false);
  });
});

describe("findServiceByShort", () => {
  const services = [
    { name: "parachute-vault-default", port: 1940 },
    { name: "parachute-agent", port: 1941 },
    { name: "parachute-scribe", port: 1943 },
  ];

  test("resolves supported modules and not retired Agent rows", () => {
    expect(findServiceByShort(services, "scribe")?.port).toBe(1943);
    expect(findServiceByShort(services, "agent")).toBeUndefined();
    expect(findServiceByShort(services, "runner")).toBeUndefined();
  });
});
