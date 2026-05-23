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
    // `kind` is NOT validated as of hub#327 — see the "kind is no longer
    // validated" suite below for the full behavior surface.
    expect(() => validateModuleManifest({ ...VALID, port: -1 }, "x")).toThrow(/port/);
    expect(() => validateModuleManifest({ ...VALID, port: 99999 }, "x")).toThrow(/port/);
    expect(() => validateModuleManifest({ ...VALID, paths: "not-array" }, "x")).toThrow(/paths/);
    expect(() => validateModuleManifest({ ...VALID, health: "no-leading-slash" }, "x")).toThrow(
      /health/,
    );
  });

  // hub#327 (hub#301 Phase A fold): the validator no longer inspects `kind`.
  // Any value — present, absent, valid string, typo, wrong type — is
  // accepted. The single downstream read site
  // (`commands/upgrade.ts: target.spec?.kind === "frontend"`) handles the
  // absent / non-"frontend" case via falsy-fallthrough into the
  // backend-proxy default.
  describe("kind is no longer validated (hub#327)", () => {
    test("missing kind is accepted and produces an undefined kind", () => {
      const { kind: _ignored, ...withoutKind } = VALID;
      const m = validateModuleManifest(withoutKind, "x");
      expect(m.kind).toBeUndefined();
    });

    test("explicit kind: 'frontend' passes through unchanged", () => {
      const m = validateModuleManifest({ ...VALID, kind: "frontend" }, "x");
      expect(m.kind).toBe("frontend");
    });

    test("explicit kind: 'api' passes through unchanged", () => {
      const m = validateModuleManifest({ ...VALID, kind: "api" }, "x");
      expect(m.kind).toBe("api");
    });

    test("explicit kind: 'tool' passes through unchanged", () => {
      const m = validateModuleManifest({ ...VALID, kind: "tool" }, "x");
      expect(m.kind).toBe("tool");
    });

    test("invalid kind values are also accepted (validator no longer inspects)", () => {
      // Per Aaron's direction on #327: stop validating kind. Typos,
      // novel strings, wrong types — none of them error. The validator
      // simply doesn't look at the field. Downstream routing branches on
      // `kind === "frontend"` and falls through gracefully for anything
      // else (including these), so accepting them is safe.
      const m1 = validateModuleManifest({ ...VALID, kind: "static" }, "x");
      expect(m1.kind).toBeUndefined();
      const m2 = validateModuleManifest({ ...VALID, kind: "backend" }, "x");
      expect(m2.kind).toBeUndefined();
      const m3 = validateModuleManifest({ ...VALID, kind: null }, "x");
      expect(m3.kind).toBeUndefined();
      const m4 = validateModuleManifest({ ...VALID, kind: 42 }, "x");
      expect(m4.kind).toBeUndefined();
    });

    test("routing-relevant kind: 'frontend' still survives the validator (upgrade.ts branch intact)", () => {
      // Defensive sanity check: the one downstream branch that reads kind
      // (commands/upgrade.ts checks `target.spec?.kind === "frontend"` to
      // decide whether to run `bun run build`) keeps working — when a
      // module DOES declare `kind: "frontend"`, the value reaches that
      // branch untouched.
      const m = validateModuleManifest({ ...VALID, kind: "frontend" }, "x");
      expect(m.kind === "frontend").toBe(true);
    });
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
