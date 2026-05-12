import { describe, expect, test } from "bun:test";
import {
  type DetectInstallSourceDeps,
  detectHubInstallSource,
  detectInstallSource,
  formatInstallSourceLabel,
  isStale,
} from "../install-source.ts";

/**
 * Stub helpers for the detect path. Production reads the operator's bun
 * globals + real package.jsons; here we wire everything from a virtual
 * filesystem so each kind (npm / bun-linked / unknown / stale) has a
 * deterministic shape.
 */
function makeDeps(opts: {
  prefixes?: readonly string[];
  packageVersions?: Record<string, string>;
  bunGlobalLinks?: Record<string, string>;
  gitHeads?: Record<string, string>;
}): DetectInstallSourceDeps {
  const prefixes = opts.prefixes ?? ["/home/test/.bun/install/global/node_modules"];
  return {
    bunGlobalPrefixes: () => prefixes,
    resolveBunGlobal: (pkg) => opts.bunGlobalLinks?.[pkg] ?? null,
    readJson: (path) => {
      // Path looks like `<pkgDir>/package.json` — strip suffix.
      const pkgDirRaw = path.replace(/\/package\.json$/, "");
      const v = opts.packageVersions?.[pkgDirRaw];
      if (v === undefined) throw new Error(`no package.json at ${pkgDirRaw}`);
      return { name: "@stub/pkg", version: v };
    },
    readGitHead: (path) => opts.gitHeads?.[path],
  };
}

describe("detectInstallSource", () => {
  test("classifies a bun-linked checkout (installDir outside bun globals)", () => {
    const deps = makeDeps({
      packageVersions: { "/Users/me/code/parachute-notes": "0.3.15-rc.1" },
      gitHeads: { "/Users/me/code/parachute-notes": "051c404" },
    });
    const source = detectInstallSource(
      { entryName: "parachute-notes", installDir: "/Users/me/code/parachute-notes" },
      deps,
    );
    expect(source.kind).toBe("bun-linked");
    expect(source.path).toBe("/Users/me/code/parachute-notes");
    expect(source.gitHead).toBe("051c404");
    expect(source.livePackageVersion).toBe("0.3.15-rc.1");
  });

  test("classifies an npm install (installDir under bun globals)", () => {
    const deps = makeDeps({
      prefixes: ["/home/test/.bun/install/global/node_modules"],
      packageVersions: {
        "/home/test/.bun/install/global/node_modules/@openparachute/scribe": "0.4.2-rc.1",
      },
    });
    const source = detectInstallSource(
      {
        entryName: "parachute-scribe",
        installDir: "/home/test/.bun/install/global/node_modules/@openparachute/scribe",
      },
      deps,
    );
    expect(source.kind).toBe("npm");
    expect(source.livePackageVersion).toBe("0.4.2-rc.1");
    expect(source.gitHead).toBeUndefined();
  });

  test("falls back to bun-global symlink lookup when installDir is absent", () => {
    const deps = makeDeps({
      bunGlobalLinks: { "@openparachute/vault": "/Users/me/code/parachute-vault" },
      packageVersions: { "/Users/me/code/parachute-vault": "0.4.4-rc.3" },
      gitHeads: { "/Users/me/code/parachute-vault": "8aa167b" },
    });
    const source = detectInstallSource({ entryName: "parachute-vault" }, deps);
    expect(source.kind).toBe("bun-linked");
    expect(source.path).toBe("/Users/me/code/parachute-vault");
    expect(source.gitHead).toBe("8aa167b");
  });

  test("returns unknown when nothing resolves (no installDir, no first-party mapping)", () => {
    const deps = makeDeps({});
    const source = detectInstallSource({ entryName: "agent" }, deps);
    expect(source.kind).toBe("unknown");
    expect(source.path).toBeUndefined();
    expect(source.gitHead).toBeUndefined();
  });

  test("omits gitHead when the bun-linked path isn't a git repo", () => {
    const deps = makeDeps({
      packageVersions: { "/tmp/no-git/pkg": "1.0.0" },
      // gitHeads intentionally missing → readGitHead returns undefined.
    });
    const source = detectInstallSource(
      { entryName: "third-party", installDir: "/tmp/no-git/pkg" },
      deps,
    );
    expect(source.kind).toBe("bun-linked");
    expect(source.gitHead).toBeUndefined();
    expect(source.livePackageVersion).toBe("1.0.0");
  });

  test("omits livePackageVersion when package.json is unreadable", () => {
    const deps = makeDeps({
      packageVersions: {}, // every read throws
    });
    const source = detectInstallSource(
      { entryName: "third-party", installDir: "/tmp/no-pkg" },
      deps,
    );
    expect(source.kind).toBe("bun-linked");
    expect(source.livePackageVersion).toBeUndefined();
  });

  test("trailing-slash prefix doesn't false-match a sibling directory", () => {
    // Subtle: `/home/test/.bun/install/global/node_modules-other` shouldn't
    // be classified as "under" `/home/test/.bun/install/global/node_modules`.
    // The prefix join in `isUnderBunGlobals` adds a trailing slash precisely
    // to avoid this — pin the behavior.
    const deps = makeDeps({
      prefixes: ["/home/test/.bun/install/global/node_modules"],
      packageVersions: {
        "/home/test/.bun/install/global/node_modules-other/pkg": "1.0.0",
      },
    });
    const source = detectInstallSource(
      {
        entryName: "third-party",
        installDir: "/home/test/.bun/install/global/node_modules-other/pkg",
      },
      deps,
    );
    expect(source.kind).toBe("bun-linked");
  });
});

describe("isStale", () => {
  test("flags drift between cached entry version and live package.json", () => {
    expect(
      isStale("0.3.11-rc.1", {
        kind: "bun-linked",
        path: "/Users/me/code/parachute-notes",
        livePackageVersion: "0.3.15-rc.1",
      }),
    ).toBe(true);
  });

  test("does not flag a matching version", () => {
    expect(
      isStale("0.3.15-rc.1", {
        kind: "bun-linked",
        path: "/Users/me/code/parachute-notes",
        livePackageVersion: "0.3.15-rc.1",
      }),
    ).toBe(false);
  });

  test("does not flag npm-installed services (cached version IS the source)", () => {
    expect(
      isStale("0.4.2-rc.1", {
        kind: "npm",
        path: "/path/to/global",
        livePackageVersion: "0.4.2-rc.1",
      }),
    ).toBe(false);
  });

  test("does not flag when live version is unavailable", () => {
    expect(
      isStale("0.3.11-rc.1", {
        kind: "bun-linked",
        path: "/Users/me/code/parachute-notes",
        // livePackageVersion absent — can't compute drift, don't false-flag.
      }),
    ).toBe(false);
  });

  test("does not flag unknown sources", () => {
    expect(isStale("1.0.0", { kind: "unknown" })).toBe(false);
  });
});

describe("formatInstallSourceLabel", () => {
  test("bun-linked → basename + short SHA", () => {
    expect(
      formatInstallSourceLabel({
        kind: "bun-linked",
        path: "/Users/me/code/parachute-notes",
        gitHead: "051c404",
      }),
    ).toBe("bun-linked → parachute-notes @ 051c404");
  });

  test("bun-linked without gitHead drops the @ <sha> suffix", () => {
    expect(
      formatInstallSourceLabel({
        kind: "bun-linked",
        path: "/Users/me/code/parachute-notes",
      }),
    ).toBe("bun-linked → parachute-notes");
  });

  test("npm with version", () => {
    expect(
      formatInstallSourceLabel({
        kind: "npm",
        path: "/some/global/dir",
        livePackageVersion: "0.4.2-rc.1",
      }),
    ).toBe("npm (0.4.2-rc.1)");
  });

  test("npm without version", () => {
    expect(formatInstallSourceLabel({ kind: "npm" })).toBe("npm");
  });

  test("unknown sources render as 'unknown'", () => {
    expect(formatInstallSourceLabel({ kind: "unknown" })).toBe("unknown");
  });
});

describe("detectHubInstallSource", () => {
  test("classifies the hub based on its source location", () => {
    // Exercise the happy path via the real hub's `src/` dir. The result
    // depends on the test environment (CI vs. bun-linked checkout), so we
    // only assert the kind is one of the known classifications — not the
    // exact value. `readGitHead` is stubbed so the test never forks a real
    // git process; the contract under test is "climb to package.json,
    // classify by location against bun globals" — git is incidental.
    const source = detectHubInstallSource(import.meta.dir, {
      readGitHead: () => "deadbeef",
    });
    expect(["bun-linked", "npm", "unknown"]).toContain(source.kind);
  });

  test("returns unknown when no package.json exists above srcDir", () => {
    // `/private` exists on macOS but has no package.json up the chain;
    // injected readJson always throws so the walk hits the climb-cap.
    const source = detectHubInstallSource("/private/var/empty", {
      readJson: () => {
        throw new Error("no package.json");
      },
    });
    expect(source.kind).toBe("unknown");
  });
});
