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

  test("includes agent (the module the whitelist used to hide) + the core set", () => {
    const shorts = discoverableShorts();
    for (const s of ["vault", "scribe", "surface", "runner", "agent", "notes"]) {
      expect(shorts).toContain(s);
    }
  });

  test("FIRST_PARTY_FALLBACKS shorts lead KNOWN_MODULES shorts (registry order)", () => {
    const shorts = discoverableShorts();
    // notes (the remaining FALLBACK — agent moved to KNOWN_MODULES in
    // boundary D3) appears before vault (KNOWN_MODULES) in the union.
    expect(shorts.indexOf("notes")).toBeLessThan(shorts.indexOf("vault"));
    // agent rides in KNOWN_MODULES now but is still discoverable.
    expect(shorts).toContain("agent");
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
    expect(focusForShort("scribe")).toBe("core");
    expect(focusForShort("surface")).toBe("core");
    expect(focusForShort("agent")).toBe("experimental");
    expect(focusForShort("runner")).toBe("experimental");
    expect(focusForShort("notes")).toBe("experimental");
  });

  test("unlisted shorts default to experimental", () => {
    expect(focusForShort("some-third-party-module")).toBe("experimental");
  });
});

describe("isKnownModuleShort", () => {
  test("true for every known module (the install/config gate)", () => {
    for (const s of ["vault", "scribe", "surface", "runner", "agent", "notes"]) {
      expect(isKnownModuleShort(s)).toBe(true);
    }
  });

  test("false for the hub itself + genuinely third-party shorts", () => {
    expect(isKnownModuleShort("hub")).toBe(false);
    expect(isKnownModuleShort("random")).toBe(false);
  });
});

// Regression: services.json rows carry the MANIFEST name (`parachute-agent`),
// not the bare short (`agent`). The connection/channels wiring used to do
// `services.find((s) => s.name === "agent")`, which never matched the on-disk
// row → agentOrigin null → a spurious "agent module is not installed" when
// linking a vault-backed channel. findServiceByShort resolves through the
// short↔manifest map so the lookup hits the real row.
describe("findServiceByShort", () => {
  const services = [
    { name: "parachute-vault-default", port: 1940 },
    { name: "parachute-agent", port: 1941 },
    { name: "parachute-scribe", port: 1943 },
  ];

  test("matches a row by its manifest name via the short↔manifest map", () => {
    const found = findServiceByShort(services, "agent");
    expect(found?.name).toBe("parachute-agent");
    expect(found?.port).toBe(1941);
  });

  test("the naive `name === short` comparison would have missed it (the bug)", () => {
    // The exact pre-fix predicate: a bare short never matches a manifest-named row.
    expect(services.find((s) => s.name === "agent")).toBeUndefined();
    // The fix finds it.
    expect(findServiceByShort(services, "agent")).toBeDefined();
  });

  test("resolves a legacy parachute-channel row to short `agent` (rename back-compat)", () => {
    // Un-upgraded operators carry a `parachute-channel` row; the
    // LEGACY_MANIFEST_ALIASES fallback keeps it routing to the agent module
    // until the daemon re-registers under `parachute-agent`.
    const legacy = [{ name: "parachute-channel", port: 1941 }];
    expect(findServiceByShort(legacy, "agent")?.port).toBe(1941);
  });

  test("resolves scribe too, and returns undefined for an absent module", () => {
    expect(findServiceByShort(services, "scribe")?.port).toBe(1943);
    expect(findServiceByShort(services, "runner")).toBeUndefined();
  });
});
