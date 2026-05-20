/**
 * Tests for the shared `vault-names.ts` helper (multi-user Phase 1, PR 4).
 *
 * The shared helper lifted the two pre-PR-4 private copies (`oauth-handlers.ts`
 * + `api-users.ts`) into one place. These tests pin the canonical behavior so
 * both callers — the OAuth consent picker + the admin SPA's assigned-vault
 * dropdown + the server-side defense in `handleConsentSubmit` — see the same
 * name set.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServicesManifest } from "../services-manifest.ts";
import { listVaultNames, listVaultNamesFromPath } from "../vault-names.ts";

describe("listVaultNames", () => {
  test("returns empty list when no vault services are registered", () => {
    const manifest: ServicesManifest = {
      services: [
        { name: "parachute-notes", port: 1942, paths: ["/notes"], health: "/h", version: "0.1.0" },
        {
          name: "parachute-scribe",
          port: 1943,
          paths: ["/scribe"],
          health: "/h",
          version: "0.1.0",
        },
      ],
    };
    expect(listVaultNames(manifest)).toEqual([]);
  });

  test("single-entry-multi-path: emits one name per `/vault/<name>` path", () => {
    const manifest: ServicesManifest = {
      services: [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/work", "/vault/personal"],
          health: "/h",
          version: "0.1.0",
        },
      ],
    };
    expect(listVaultNames(manifest)).toEqual(["personal", "work"]);
  });

  test("per-vault entries: emits one name per `parachute-vault-<name>` entry", () => {
    const manifest: ServicesManifest = {
      services: [
        {
          name: "parachute-vault-work",
          port: 1940,
          paths: ["/vault/work"],
          health: "/h",
          version: "0.1.0",
        },
        {
          name: "parachute-vault-personal",
          port: 1941,
          paths: ["/vault/personal"],
          health: "/h",
          version: "0.1.0",
        },
      ],
    };
    expect(listVaultNames(manifest)).toEqual(["personal", "work"]);
  });

  test("entry with no paths falls back to the manifest-suffix name (hub#143)", () => {
    const manifest: ServicesManifest = {
      services: [
        {
          name: "parachute-vault-archived",
          port: 1940,
          paths: [],
          health: "/h",
          version: "0.1.0",
        },
      ],
    };
    expect(listVaultNames(manifest)).toEqual(["archived"]);
  });

  test("deduplicates collisions across single-entry + per-vault shapes", () => {
    const manifest: ServicesManifest = {
      services: [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/work"],
          health: "/h",
          version: "0.1.0",
        },
        {
          name: "parachute-vault-work",
          port: 1941,
          paths: ["/vault/work"],
          health: "/h",
          version: "0.1.0",
        },
      ],
    };
    expect(listVaultNames(manifest)).toEqual(["work"]);
  });

  test("output is sorted ascending — deterministic order for both callers", () => {
    const manifest: ServicesManifest = {
      services: [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/zeta", "/vault/alpha", "/vault/middle"],
          health: "/h",
          version: "0.1.0",
        },
      ],
    };
    expect(listVaultNames(manifest)).toEqual(["alpha", "middle", "zeta"]);
  });
});

describe("listVaultNamesFromPath", () => {
  test("reads from a services.json file and emits the same names", () => {
    const dir = mkdtempSync(join(tmpdir(), "phub-vault-names-"));
    const path = join(dir, "services.json");
    writeFileSync(
      path,
      JSON.stringify({
        services: [
          {
            name: "parachute-vault",
            port: 1940,
            paths: ["/vault/work"],
            health: "/h",
            version: "0.1.0",
          },
        ],
      }),
    );
    try {
      expect(listVaultNamesFromPath(path)).toEqual(["work"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("api-users.ts and oauth-handlers.ts read the same source through listVaultNamesFromPath / listVaultNames", () => {
    // Cross-caller parity: the helper is the single source. Both code paths
    // should see byte-identical output against the same services.json.
    const dir = mkdtempSync(join(tmpdir(), "phub-vault-names-parity-"));
    const path = join(dir, "services.json");
    const manifest: ServicesManifest = {
      services: [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/work", "/vault/personal"],
          health: "/h",
          version: "0.1.0",
        },
      ],
    };
    writeFileSync(path, JSON.stringify(manifest));
    try {
      expect(listVaultNamesFromPath(path)).toEqual(listVaultNames(manifest));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
