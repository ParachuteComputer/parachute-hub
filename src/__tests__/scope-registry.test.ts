import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findUnknownScopes,
  isKnownScope,
  loadDeclaredScopes,
  parseScopeString,
} from "../scope-registry.ts";

describe("parseScopeString", () => {
  test("splits on whitespace per RFC 6749", () => {
    expect(parseScopeString("vault:read scribe:transcribe")).toEqual([
      "vault:read",
      "scribe:transcribe",
    ]);
  });

  test("accepts tabs + newlines + multi-space runs", () => {
    expect(parseScopeString("vault:read\tscribe:transcribe\n  channel:send")).toEqual([
      "vault:read",
      "scribe:transcribe",
      "channel:send",
    ]);
  });

  test("empty string yields empty array", () => {
    expect(parseScopeString("")).toEqual([]);
    expect(parseScopeString("   ")).toEqual([]);
  });
});

describe("isKnownScope", () => {
  const declared = new Set(["vault:read", "vault:write", "scribe:transcribe", "hub:admin"]);

  test("exact match passes", () => {
    expect(isKnownScope("vault:read", declared)).toBe(true);
    expect(isKnownScope("scribe:transcribe", declared)).toBe(true);
  });

  test("unknown scopes fail", () => {
    expect(isKnownScope("frobnicate:everything", declared)).toBe(false);
    expect(isKnownScope("vault:exfiltrate", declared)).toBe(false);
  });

  test("per-resource narrowing collapses to <svc>:<verb>", () => {
    expect(isKnownScope("vault:work:read", declared)).toBe(true);
    expect(isKnownScope("vault:default:write", declared)).toBe(true);
    expect(isKnownScope("scribe:groq:transcribe", declared)).toBe(true);
  });

  test("narrowing only collapses if collapsed form is declared", () => {
    expect(isKnownScope("vault:work:exfiltrate", declared)).toBe(false);
  });

  test("admin scope does NOT inherit read/write at the issuer", () => {
    // Inheritance is the resource server's call (vault enforces admin ⊇ write
    // ⊇ read at request time). The issuer only mints what was declared.
    const adminOnly = new Set(["vault:admin"]);
    expect(isKnownScope("vault:read", adminOnly)).toBe(false);
  });

  test("malformed scopes (no colon, single segment) fail", () => {
    expect(isKnownScope("vaultread", declared)).toBe(false);
    expect(isKnownScope("vault:", declared)).toBe(false);
  });
});

describe("findUnknownScopes", () => {
  const declared = new Set(["vault:read", "vault:write", "scribe:transcribe"]);

  test("returns only the unknown ones", () => {
    expect(
      findUnknownScopes(["vault:read", "frobnicate:everything", "scribe:transcribe"], declared),
    ).toEqual(["frobnicate:everything"]);
  });

  test("returns [] when all declared", () => {
    expect(findUnknownScopes(["vault:read", "scribe:transcribe"], declared)).toEqual([]);
  });

  test("returns [] for empty input", () => {
    expect(findUnknownScopes([], declared)).toEqual([]);
  });
});

describe("loadDeclaredScopes", () => {
  function tmp(): { dir: string; manifestPath: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "phub-scope-reg-"));
    return {
      dir,
      manifestPath: join(dir, "services.json"),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  test("returns FIRST_PARTY_SCOPES baseline when services.json is absent", () => {
    const { manifestPath, cleanup } = tmp();
    try {
      const declared = loadDeclaredScopes({ manifestPath });
      expect(declared.has("vault:read")).toBe(true);
      expect(declared.has("scribe:transcribe")).toBe(true);
      expect(declared.has("hub:admin")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("unions module.json scopes.defines on top of FIRST_PARTY_SCOPES", () => {
    const { manifestPath, cleanup } = tmp();
    try {
      writeFileSync(
        manifestPath,
        JSON.stringify({
          services: [
            {
              name: "@acme/widget",
              port: 1950,
              paths: ["/widget"],
              health: "/healthz",
              version: "0.0.0-linked",
            },
          ],
        }),
      );
      const declared = loadDeclaredScopes({
        manifestPath,
        readModuleScopes: (pkg) =>
          pkg === "@acme/widget" ? ["widget:read", "widget:write"] : null,
      });
      expect(declared.has("vault:read")).toBe(true); // baseline
      expect(declared.has("widget:read")).toBe(true);
      expect(declared.has("widget:write")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("readModuleScopes receives installDir from services.json (closes #85 follow-up)", () => {
    // Regression: scope-registry was looking up by services.json `name` in
    // bun-globals. For third-party modules where name (canonical short like
    // "someapp") differs from the npm package name on disk ("nanoapp" for
    // forks), that lookup fails and the module's scopes are never declared.
    // installDir from hub#84 is the correct path source.
    const { manifestPath, cleanup } = tmp();
    try {
      writeFileSync(
        manifestPath,
        JSON.stringify({
          services: [
            {
              name: "someapp",
              port: 1944,
              paths: ["/someapp"],
              health: "/api/health",
              version: "0.0.0-linked",
              installDir: "/Users/test/ParachuteComputer/parachute-someapp",
            },
          ],
        }),
      );
      const calls: { pkg: string; installDir: string | undefined }[] = [];
      const declared = loadDeclaredScopes({
        manifestPath,
        readModuleScopes: (pkg, installDir) => {
          calls.push({ pkg, installDir });
          return pkg === "someapp" ? ["someapp:read", "someapp:write", "someapp:admin"] : null;
        },
      });
      expect(calls).toEqual([
        { pkg: "someapp", installDir: "/Users/test/ParachuteComputer/parachute-someapp" },
      ]);
      expect(declared.has("someapp:read")).toBe(true);
      expect(declared.has("someapp:write")).toBe(true);
      expect(declared.has("someapp:admin")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("services with no module.json don't crash the registry", () => {
    const { manifestPath, cleanup } = tmp();
    try {
      writeFileSync(
        manifestPath,
        JSON.stringify({
          services: [
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault"],
              health: "/healthz",
              version: "0.0.0-linked",
            },
          ],
        }),
      );
      const declared = loadDeclaredScopes({
        manifestPath,
        readModuleScopes: () => null,
      });
      expect(declared.has("vault:read")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("malformed services.json falls back to baseline", () => {
    const { manifestPath, cleanup } = tmp();
    try {
      writeFileSync(manifestPath, "{not json");
      const declared = loadDeclaredScopes({ manifestPath });
      expect(declared.has("vault:read")).toBe(true);
      expect(declared.size).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
