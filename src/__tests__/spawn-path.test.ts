import { describe, expect, test } from "bun:test";
import {
  type EnrichedPathDeps,
  enrichedPath,
  enrichedUnitPath,
  operatorToolDirs,
} from "../spawn-path.ts";

/**
 * Build EnrichedPathDeps with a fake fs (set of existing paths) + pinned
 * platform/arch/home so tests never touch the real disk or host.
 */
function fakeDeps(opts: {
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  existing?: string[];
}): EnrichedPathDeps {
  const existing = new Set(opts.existing ?? []);
  return {
    homeDir: () => opts.home ?? "/home/op",
    exists: (p) => existing.has(p),
    platform: opts.platform ?? "darwin",
    arch: opts.arch ?? "arm64",
  };
}

describe("enrichedPath — operator-tool PATH enrichment", () => {
  test("preserves the inherited PATH and keeps its order", () => {
    const deps = fakeDeps({ existing: [] });
    const result = enrichedPath({ PATH: "/usr/bin:/bin" }, deps);
    expect(result).toBe("/usr/bin:/bin");
  });

  test("appends operator-tool dirs only when they exist on disk", () => {
    // .local/bin + brew exist; .bun/bin does NOT → only the two existing append.
    const deps = fakeDeps({
      home: "/home/op",
      platform: "darwin",
      arch: "arm64",
      existing: ["/home/op/.local/bin", "/opt/homebrew/bin"],
    });
    const result = enrichedPath({ PATH: "/usr/bin" }, deps);
    expect(result).toBe("/usr/bin:/home/op/.local/bin:/opt/homebrew/bin");
    expect(result).not.toContain("/home/op/.bun/bin");
  });

  test("inherited PATH wins over appended defaults (append, not prepend)", () => {
    const deps = fakeDeps({ existing: ["/home/op/.local/bin"] });
    const result = enrichedPath({ PATH: "/first:/second" }, deps);
    const parts = result.split(":");
    expect(parts[0]).toBe("/first");
    expect(parts[1]).toBe("/second");
    expect(parts[2]).toBe("/home/op/.local/bin");
  });

  test("dedupes — an appended dir already in the inherited PATH is not duplicated", () => {
    const deps = fakeDeps({ existing: ["/home/op/.local/bin"] });
    const result = enrichedPath({ PATH: "/usr/bin:/home/op/.local/bin" }, deps);
    expect(result).toBe("/usr/bin:/home/op/.local/bin");
    expect(result.split(":").filter((p) => p === "/home/op/.local/bin")).toHaveLength(1);
  });

  test("PARACHUTE_EXTRA_PATH is PREPENDED so an operator can intentionally shadow", () => {
    const deps = fakeDeps({ existing: ["/home/op/.local/bin"] });
    const result = enrichedPath(
      { PATH: "/usr/bin", PARACHUTE_EXTRA_PATH: "/opt/custom/bin:/opt/more" },
      deps,
    );
    const parts = result.split(":");
    expect(parts[0]).toBe("/opt/custom/bin");
    expect(parts[1]).toBe("/opt/more");
    expect(parts[2]).toBe("/usr/bin");
    expect(parts[3]).toBe("/home/op/.local/bin");
  });

  test("PARACHUTE_EXTRA_PATH dedupes against inherited (extra-first wins position)", () => {
    const deps = fakeDeps({ existing: [] });
    const result = enrichedPath({ PATH: "/usr/bin:/dup", PARACHUTE_EXTRA_PATH: "/dup" }, deps);
    expect(result).toBe("/dup:/usr/bin");
  });

  test("empty inherited PATH yields just the existing appended dirs", () => {
    const deps = fakeDeps({
      home: "/home/op",
      platform: "darwin",
      arch: "arm64",
      existing: ["/home/op/.local/bin", "/opt/homebrew/bin", "/home/op/.bun/bin"],
    });
    const result = enrichedPath({ PATH: "" }, deps);
    expect(result).toBe("/home/op/.local/bin:/opt/homebrew/bin:/home/op/.bun/bin");
  });

  describe("platform / arch branches", () => {
    test("darwin arm64 → /opt/homebrew/bin", () => {
      const deps = fakeDeps({
        platform: "darwin",
        arch: "arm64",
        existing: ["/opt/homebrew/bin"],
      });
      expect(enrichedPath({ PATH: "/usr/bin" }, deps)).toBe("/usr/bin:/opt/homebrew/bin");
    });

    test("darwin x64 → /usr/local/bin (Intel brew)", () => {
      const deps = fakeDeps({
        platform: "darwin",
        arch: "x64",
        existing: ["/usr/local/bin"],
      });
      // /usr/local/bin is the brew bin on Intel macOS; here it's the only existing dir.
      expect(enrichedPath({ PATH: "/usr/bin" }, deps)).toBe("/usr/bin:/usr/local/bin");
    });

    test("linux → only $HOME/.local/bin + $HOME/.bun/bin, no brew bin", () => {
      const deps = fakeDeps({
        home: "/home/op",
        platform: "linux",
        arch: "x64",
        existing: ["/home/op/.local/bin", "/home/op/.bun/bin", "/opt/homebrew/bin"],
      });
      const result = enrichedPath({ PATH: "/usr/bin" }, deps);
      expect(result).toBe("/usr/bin:/home/op/.local/bin:/home/op/.bun/bin");
      // /opt/homebrew/bin exists in the fake fs but is NOT a Linux candidate dir.
      expect(result).not.toContain("/opt/homebrew/bin");
    });
  });
});

describe("operatorToolDirs — candidate dir list", () => {
  test("darwin arm64: .local/bin, /opt/homebrew/bin, .bun/bin (in order)", () => {
    expect(operatorToolDirs("/home/op", "darwin", "arm64")).toEqual([
      "/home/op/.local/bin",
      "/opt/homebrew/bin",
      "/home/op/.bun/bin",
    ]);
  });

  test("darwin x64: brew is /usr/local/bin", () => {
    expect(operatorToolDirs("/home/op", "darwin", "x64")).toEqual([
      "/home/op/.local/bin",
      "/usr/local/bin",
      "/home/op/.bun/bin",
    ]);
  });

  test("linux: no brew dir", () => {
    expect(operatorToolDirs("/home/op", "linux", "x64")).toEqual([
      "/home/op/.local/bin",
      "/home/op/.bun/bin",
    ]);
  });
});

describe("enrichedUnitPath — launchd/systemd unit PATH", () => {
  test("bun bin first, then system dirs, then operator-tool dirs (darwin arm64)", () => {
    const result = enrichedUnitPath("/home/op/.bun", "/home/op", "darwin", "arm64", undefined);
    expect(result).toBe(
      "/home/op/.bun/bin:/usr/local/bin:/usr/bin:/bin:/home/op/.local/bin:/opt/homebrew/bin",
    );
  });

  test("dedupes — Intel brew /usr/local/bin already present in the base is not duplicated", () => {
    // darwin x64 brew dir == /usr/local/bin, which the base already carries.
    const result = enrichedUnitPath("/home/op/.bun", "/home/op", "darwin", "x64", undefined);
    expect(result.split(":").filter((p) => p === "/usr/local/bin")).toHaveLength(1);
    expect(result).toBe("/home/op/.bun/bin:/usr/local/bin:/usr/bin:/bin:/home/op/.local/bin");
  });

  test("linux: appends $HOME/.local/bin (no brew dir)", () => {
    const result = enrichedUnitPath("/home/op/.bun", "/home/op", "linux", "x64", undefined);
    expect(result).toBe("/home/op/.bun/bin:/usr/local/bin:/usr/bin:/bin:/home/op/.local/bin");
  });

  test("includes operator-tool dirs unconditionally (no existence check)", () => {
    // No fs seam here — the unit-side dirs are baked in even if absent on disk.
    const result = enrichedUnitPath("/home/op/.bun", "/home/op", "darwin", "arm64", undefined);
    expect(result).toContain("/home/op/.local/bin");
    expect(result).toContain("/opt/homebrew/bin");
  });

  test("PARACHUTE_EXTRA_PATH is prepended", () => {
    const result = enrichedUnitPath(
      "/home/op/.bun",
      "/home/op",
      "darwin",
      "arm64",
      "/opt/custom/bin",
    );
    expect(result.split(":")[0]).toBe("/opt/custom/bin");
  });
});
