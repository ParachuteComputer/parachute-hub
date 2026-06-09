import { describe, expect, test } from "bun:test";
import {
  FIRST_PARTY_FALLBACKS,
  KNOWN_MODULES,
  discoverableShorts,
  findServiceByShort,
  focusForShort,
  isKnownModuleShort,
} from "../service-spec.ts";

// 2026-06-09 modular-UI architecture (P2): discovery is driven by the union of
// the bootstrap registries + self-registration, NOT a CURATED_MODULES
// whitelist. These helpers are the seam.

describe("discoverableShorts", () => {
  test("is the deduped union of FIRST_PARTY_FALLBACKS ∪ KNOWN_MODULES", () => {
    const shorts = discoverableShorts();
    const expected = new Set([
      ...Object.keys(FIRST_PARTY_FALLBACKS),
      ...Object.keys(KNOWN_MODULES),
    ]);
    expect(new Set(shorts)).toEqual(expected);
    // No duplicates.
    expect(shorts.length).toBe(new Set(shorts).size);
  });

  test("includes channel (the module the whitelist used to hide) + the core set", () => {
    const shorts = discoverableShorts();
    for (const s of ["vault", "scribe", "surface", "runner", "channel", "notes"]) {
      expect(shorts).toContain(s);
    }
  });

  test("FIRST_PARTY_FALLBACKS shorts lead KNOWN_MODULES shorts (registry order)", () => {
    const shorts = discoverableShorts();
    // channel (FALLBACK) appears before vault (KNOWN_MODULES) in the union.
    expect(shorts.indexOf("channel")).toBeLessThan(shorts.indexOf("vault"));
  });
});

describe("focusForShort", () => {
  test("declared focus wins over the default map", () => {
    // channel defaults experimental, but a manifest-declared core wins.
    expect(focusForShort("channel", "core")).toBe("core");
    // vault defaults core, but a declared experimental wins.
    expect(focusForShort("vault", "experimental")).toBe("experimental");
  });

  test("falls back to the default tier map when undeclared", () => {
    expect(focusForShort("vault")).toBe("core");
    expect(focusForShort("scribe")).toBe("core");
    expect(focusForShort("surface")).toBe("core");
    expect(focusForShort("channel")).toBe("experimental");
    expect(focusForShort("runner")).toBe("experimental");
    expect(focusForShort("notes")).toBe("experimental");
  });

  test("unlisted shorts default to experimental", () => {
    expect(focusForShort("some-third-party-module")).toBe("experimental");
  });
});

describe("isKnownModuleShort", () => {
  test("true for every known module (the install/config gate)", () => {
    for (const s of ["vault", "scribe", "surface", "runner", "channel", "notes"]) {
      expect(isKnownModuleShort(s)).toBe(true);
    }
  });

  test("false for the hub itself + genuinely third-party shorts", () => {
    expect(isKnownModuleShort("hub")).toBe(false);
    expect(isKnownModuleShort("random")).toBe(false);
  });
});

// Regression: services.json rows carry the MANIFEST name (`parachute-channel`),
// not the bare short (`channel`). The connection/channels wiring used to do
// `services.find((s) => s.name === "channel")`, which never matched the on-disk
// row → channelOrigin null → a spurious "channel module is not installed" when
// linking a vault-backed channel. findServiceByShort resolves through the
// short↔manifest map so the lookup hits the real row.
describe("findServiceByShort", () => {
  const services = [
    { name: "parachute-vault-default", port: 1940 },
    { name: "parachute-channel", port: 1941 },
    { name: "parachute-scribe", port: 1943 },
  ];

  test("matches a row by its manifest name via the short↔manifest map", () => {
    const found = findServiceByShort(services, "channel");
    expect(found?.name).toBe("parachute-channel");
    expect(found?.port).toBe(1941);
  });

  test("the naive `name === short` comparison would have missed it (the bug)", () => {
    // The exact pre-fix predicate: a bare short never matches a manifest-named row.
    expect(services.find((s) => s.name === "channel")).toBeUndefined();
    // The fix finds it.
    expect(findServiceByShort(services, "channel")).toBeDefined();
  });

  test("resolves scribe too, and returns undefined for an absent module", () => {
    expect(findServiceByShort(services, "scribe")?.port).toBe(1943);
    expect(findServiceByShort(services, "runner")).toBeUndefined();
  });
});
