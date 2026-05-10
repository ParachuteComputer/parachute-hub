import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModuleManifestError,
  readModuleManifest,
  validateModuleManifest,
} from "../module-manifest.ts";

const VALID = {
  name: "demo",
  manifestName: "@example/demo",
  kind: "api",
  port: 1950,
  paths: ["/demo"],
  health: "/healthz",
} as const;

describe("validateModuleManifest", () => {
  test("accepts a minimal valid manifest", () => {
    const m = validateModuleManifest(VALID, "test");
    expect(m.name).toBe("demo");
    expect(m.kind).toBe("api");
    expect(m.port).toBe(1950);
    expect(m.paths).toEqual(["/demo"]);
    expect(m.health).toBe("/healthz");
  });

  test("rejects non-object root", () => {
    expect(() => validateModuleManifest("nope", "where")).toThrow(ModuleManifestError);
    expect(() => validateModuleManifest([1, 2], "where")).toThrow(/root must be an object/);
  });

  test("rejects missing required fields", () => {
    expect(() => validateModuleManifest({ ...VALID, name: undefined }, "x")).toThrow(/name/);
    expect(() => validateModuleManifest({ ...VALID, kind: "weird" }, "x")).toThrow(/kind/);
    expect(() => validateModuleManifest({ ...VALID, port: -1 }, "x")).toThrow(/port/);
    expect(() => validateModuleManifest({ ...VALID, port: 99999 }, "x")).toThrow(/port/);
    expect(() => validateModuleManifest({ ...VALID, paths: "not-array" }, "x")).toThrow(/paths/);
    expect(() => validateModuleManifest({ ...VALID, health: "no-leading-slash" }, "x")).toThrow(
      /health/,
    );
  });

  test("rejects invalid name shape", () => {
    expect(() => validateModuleManifest({ ...VALID, name: "Demo" }, "x")).toThrow(/name/);
    expect(() => validateModuleManifest({ ...VALID, name: "1demo" }, "x")).toThrow(/name/);
    expect(() => validateModuleManifest({ ...VALID, name: "a_b" }, "x")).toThrow(/name/);
  });

  test("scope namespace must match module name", () => {
    expect(() =>
      validateModuleManifest({ ...VALID, scopes: { defines: ["vault:read"] } }, "x"),
    ).toThrow(/namespace.*does not match/);
    const ok = validateModuleManifest(
      { ...VALID, scopes: { defines: ["demo:read", "demo:write"] } },
      "x",
    );
    expect(ok.scopes?.defines).toEqual(["demo:read", "demo:write"]);
  });

  test("scope without colon is rejected", () => {
    expect(() => validateModuleManifest({ ...VALID, scopes: { defines: ["demo"] } }, "x")).toThrow(
      /namespaced/,
    );
  });

  test("dependencies block accepts optional + scopes", () => {
    const m = validateModuleManifest(
      {
        ...VALID,
        dependencies: {
          "parachute-vault": { optional: false, scopes: ["vault:read"] },
          "parachute-scribe": { optional: true },
        },
      },
      "x",
    );
    expect(m.dependencies?.["parachute-vault"]?.optional).toBe(false);
    expect(m.dependencies?.["parachute-vault"]?.scopes).toEqual(["vault:read"]);
    expect(m.dependencies?.["parachute-scribe"]?.optional).toBe(true);
  });

  test("startCmd must be non-empty if present", () => {
    expect(() => validateModuleManifest({ ...VALID, startCmd: [] }, "x")).toThrow(/startCmd/);
    const m = validateModuleManifest({ ...VALID, startCmd: ["bin", "--flag"] }, "x");
    expect(m.startCmd).toEqual(["bin", "--flag"]);
  });

  test("optional displayName + tagline pass through", () => {
    const m = validateModuleManifest(
      { ...VALID, displayName: "Demo", tagline: "a demo module" },
      "x",
    );
    expect(m.displayName).toBe("Demo");
    expect(m.tagline).toBe("a demo module");
  });

  test("managementUrl accepts a leading-slash path", () => {
    const m = validateModuleManifest({ ...VALID, managementUrl: "/admin" }, "x");
    expect(m.managementUrl).toBe("/admin");
  });

  test("managementUrl accepts an absolute https URL", () => {
    const m = validateModuleManifest(
      { ...VALID, managementUrl: "https://admin.example.com/" },
      "x",
    );
    expect(m.managementUrl).toBe("https://admin.example.com/");
  });

  test("managementUrl rejects empty / non-string / non-url-or-path", () => {
    expect(() => validateModuleManifest({ ...VALID, managementUrl: "" }, "x")).toThrow(
      /managementUrl/,
    );
    expect(() => validateModuleManifest({ ...VALID, managementUrl: 7 }, "x")).toThrow(
      /managementUrl/,
    );
    expect(() =>
      validateModuleManifest({ ...VALID, managementUrl: "no-leading-slash" }, "x"),
    ).toThrow(/path starting with "\/" or a full http\(s\) URL/);
    expect(() =>
      validateModuleManifest({ ...VALID, managementUrl: "ftp://example.com" }, "x"),
    ).toThrow(/http:.*https:/);
  });

  test("uiUrl accepts a leading-slash path (Phase D)", () => {
    const m = validateModuleManifest({ ...VALID, uiUrl: "/notes" }, "x");
    expect(m.uiUrl).toBe("/notes");
  });

  test("uiUrl accepts an absolute https URL", () => {
    const m = validateModuleManifest({ ...VALID, uiUrl: "https://app.example.com/" }, "x");
    expect(m.uiUrl).toBe("https://app.example.com/");
  });

  test("uiUrl rejects empty / non-string / non-url-or-path (mirrors managementUrl)", () => {
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "" }, "x")).toThrow(/uiUrl/);
    expect(() => validateModuleManifest({ ...VALID, uiUrl: 7 }, "x")).toThrow(/uiUrl/);
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "no-slash" }, "x")).toThrow(
      /path starting with "\/" or a full http\(s\) URL/,
    );
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "ftp://example.com" }, "x")).toThrow(
      /http:.*https:/,
    );
  });

  test("uiUrl absent stays absent", () => {
    const m = validateModuleManifest(VALID, "x");
    expect(m.uiUrl).toBeUndefined();
  });

  // Open-redirect regression: protocol-relative paths like "//evil.com" pass
  // a naive `startsWith("/")` check but `new URL("//evil.com", base)` resolves
  // to the foreign origin. A malicious third-party module could plant such a
  // value in module.json:uiUrl and turn a discovery tile into an off-origin
  // redirect. Both uiUrl and managementUrl are validated by the shared
  // asPathOrUrl helper, so cover both.
  test("uiUrl rejects protocol-relative paths (open-redirect regression)", () => {
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "//evil.com" }, "x")).toThrow(/uiUrl/);
    expect(() => validateModuleManifest({ ...VALID, uiUrl: "//evil.com/path" }, "x")).toThrow(
      /uiUrl/,
    );
  });

  test("managementUrl rejects protocol-relative paths (open-redirect regression)", () => {
    expect(() => validateModuleManifest({ ...VALID, managementUrl: "//evil.com" }, "x")).toThrow(
      /managementUrl/,
    );
    expect(() =>
      validateModuleManifest({ ...VALID, managementUrl: "//evil.com/admin" }, "x"),
    ).toThrow(/managementUrl/);
  });

  test("managementUrl absent stays absent", () => {
    const m = validateModuleManifest(VALID, "x");
    expect(m.managementUrl).toBeUndefined();
  });

  test("stripPrefix accepts boolean true and false; rejects non-boolean", () => {
    expect(validateModuleManifest({ ...VALID, stripPrefix: true }, "x").stripPrefix).toBe(true);
    expect(validateModuleManifest({ ...VALID, stripPrefix: false }, "x").stripPrefix).toBe(false);
    expect(() => validateModuleManifest({ ...VALID, stripPrefix: "yes" }, "x")).toThrow(
      /stripPrefix/,
    );
  });

  test("stripPrefix absent stays absent", () => {
    const m = validateModuleManifest(VALID, "x");
    expect(m.stripPrefix).toBeUndefined();
  });
});

describe("readModuleManifest", () => {
  function tmp(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "pcli-manifest-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  test("returns null when .parachute/module.json is absent", async () => {
    const { dir, cleanup } = tmp();
    try {
      expect(await readModuleManifest(dir)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("reads + validates a real on-disk manifest", async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, ".parachute"));
      writeFileSync(join(dir, ".parachute", "module.json"), JSON.stringify(VALID));
      const m = await readModuleManifest(dir);
      expect(m?.name).toBe("demo");
    } finally {
      cleanup();
    }
  });

  test("throws ModuleManifestError on malformed JSON", async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, ".parachute"));
      writeFileSync(join(dir, ".parachute", "module.json"), "{not json");
      await expect(readModuleManifest(dir)).rejects.toThrow(ModuleManifestError);
    } finally {
      cleanup();
    }
  });

  test("throws ModuleManifestError on validation failure", async () => {
    const { dir, cleanup } = tmp();
    try {
      mkdirSync(join(dir, ".parachute"));
      writeFileSync(join(dir, ".parachute", "module.json"), JSON.stringify({ name: "x" }));
      await expect(readModuleManifest(dir)).rejects.toThrow(ModuleManifestError);
    } finally {
      cleanup();
    }
  });
});
