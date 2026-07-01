import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSurfaceRepo,
  isSurfaceRegistered,
  listSurfaces,
  loadRegistry,
  registerSurface,
  registryPath,
  repoDirFor,
} from "../git-registry.ts";

function tmpGitRoot(): { gitRoot: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "phub-registry-"));
  const gitRoot = join(dir, "git");
  return { gitRoot, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loadRegistry", () => {
  test("missing file → empty registry", () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      expect(loadRegistry(gitRoot)).toEqual({ version: 1, surfaces: {} });
    } finally {
      cleanup();
    }
  });

  test("corrupt JSON → empty registry (never throws)", () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      mkdirSync(gitRoot, { recursive: true });
      writeFileSync(registryPath(gitRoot), "{ not json");
      expect(loadRegistry(gitRoot)).toEqual({ version: 1, surfaces: {} });
    } finally {
      cleanup();
    }
  });
});

describe("ensureSurfaceRepo", () => {
  test("provisions a bare repo with http.receivepack=true + post-receive hook", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      const repoDir = await ensureSurfaceRepo(gitRoot, "foo");
      expect(repoDir).toBe(repoDirFor(gitRoot, "foo"));
      expect(existsSync(repoDir)).toBe(true);
      expect(existsSync(join(repoDir, "hooks", "post-receive"))).toBe(true);
      const rp = spawnSync("git", ["-C", repoDir, "config", "http.receivepack"], {
        encoding: "utf8",
      });
      expect(rp.stdout.trim()).toBe("true");
    } finally {
      cleanup();
    }
  });

  test("idempotent — a second call is a no-op that returns the same path", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      const a = await ensureSurfaceRepo(gitRoot, "foo");
      const b = await ensureSurfaceRepo(gitRoot, "foo");
      expect(a).toBe(b);
    } finally {
      cleanup();
    }
  });

  test("rejects an invalid surface name", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      await expect(ensureSurfaceRepo(gitRoot, "../evil")).rejects.toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("registerSurface", () => {
  test("provisions the repo + records the entry", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      const entry = await registerSurface(gitRoot, "brain", {
        mount: "/surface/brain",
        mode: "prod",
      });
      expect(entry.name).toBe("brain");
      expect(entry.mount).toBe("/surface/brain");
      expect(entry.mode).toBe("prod");
      expect(existsSync(repoDirFor(gitRoot, "brain"))).toBe(true);
      expect(loadRegistry(gitRoot).surfaces.brain?.name).toBe("brain");
    } finally {
      cleanup();
    }
  });

  test("idempotent re-register preserves the original registeredAt", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      const first = await registerSurface(gitRoot, "brain", {
        now: () => new Date("2026-01-01T00:00:00Z"),
      });
      const second = await registerSurface(gitRoot, "brain", {
        mount: "/surface/brain",
        now: () => new Date("2026-02-02T00:00:00Z"),
      });
      expect(second.registeredAt).toBe(first.registeredAt);
      expect(second.registeredAt).toBe("2026-01-01T00:00:00.000Z");
      // Later metadata still applies.
      expect(second.mount).toBe("/surface/brain");
    } finally {
      cleanup();
    }
  });

  test("rejects an invalid name without provisioning", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      await expect(registerSurface(gitRoot, "a/b")).rejects.toThrow(/invalid surface name/);
      expect(existsSync(registryPath(gitRoot))).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("isSurfaceRegistered", () => {
  test("false for an unknown name, true after register", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      expect(isSurfaceRegistered(gitRoot, "foo")).toBe(false);
      await registerSurface(gitRoot, "foo");
      expect(isSurfaceRegistered(gitRoot, "foo")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("grandfathers a bare repo that exists on disk without a registry entry", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      await ensureSurfaceRepo(gitRoot, "legacy");
      // No registry.json entry, but the repo exists → still registered.
      expect(existsSync(registryPath(gitRoot))).toBe(false);
      expect(isSurfaceRegistered(gitRoot, "legacy")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("false for a name that fails the charset (never touches the filesystem)", () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      expect(isSurfaceRegistered(gitRoot, "../etc")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("listSurfaces", () => {
  test("returns entries sorted by name", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      await registerSurface(gitRoot, "zeta");
      await registerSurface(gitRoot, "alpha");
      await registerSurface(gitRoot, "mid");
      expect(listSurfaces(gitRoot).map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
    } finally {
      cleanup();
    }
  });
});

describe("saveRegistry atomicity", () => {
  test("registry.json is written pretty + reloadable", async () => {
    const { gitRoot, cleanup } = tmpGitRoot();
    try {
      await registerSurface(gitRoot, "foo");
      const raw = readFileSync(registryPath(gitRoot), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(JSON.parse(raw).surfaces.foo.name).toBe("foo");
    } finally {
      cleanup();
    }
  });
});
