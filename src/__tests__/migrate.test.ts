import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrateNotice, planArchive, safelistEntries } from "../commands/migrate.ts";

interface Harness {
  configDir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-migrate-"));
  return { configDir: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function touch(path: string, content = ""): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const APRIL_19 = new Date("2026-04-19T12:00:00Z");
const APRIL_20 = new Date("2026-04-20T09:00:00Z");

function seedSafelist(configDir: string): void {
  // Realistic safelist items so we can assert they stay put across every test.
  mkdirSync(join(configDir, "vault"), { recursive: true });
  touch(join(configDir, "vault", "config.json"), "{}");
  mkdirSync(join(configDir, "hub", "run"), { recursive: true });
  mkdirSync(join(configDir, "well-known"), { recursive: true });
  touch(join(configDir, "services.json"), '{"services":[]}');
  touch(join(configDir, "expose-state.json"), "{}");
  // hub.db + SQLite WAL companions — the steady-state shape on any
  // running hub. Catching the "clean install flagged hub.db" regression
  // means seeding them as safelist items in every test fixture.
  touch(join(configDir, "hub.db"), "");
  touch(join(configDir, "hub.db-wal"), "");
  touch(join(configDir, "hub.db-shm"), "");
}

describe("safelistEntries", () => {
  test("covers service dirs, hub, state files, and well-known", () => {
    const s = safelistEntries();
    // Service dirs from SERVICE_SPECS
    expect(s.has("vault")).toBe(true);
    expect(s.has("notes")).toBe(true);
    expect(s.has("scribe")).toBe(true);
    expect(s.has("channel")).toBe(true);
    // Legacy — kept across the Notes→Lens→Notes rename round-trip
    // (Apr 19 → Apr 22) so existing ~/.parachute/lens/ dirs from the
    // brief Lens window don't get archived on upgrade.
    expect(s.has("lens")).toBe(true);
    // Internal
    expect(s.has("hub")).toBe(true);
    // CLI state
    expect(s.has("services.json")).toBe(true);
    expect(s.has("expose-state.json")).toBe(true);
    expect(s.has("well-known")).toBe(true);
    // Hub DB + SQLite WAL companions. Caught on a fresh EC2 install
    // 2026-05-27 where the only thing at ~/.parachute/ was hub.db
    // (hub started but no modules installed) and migrate flagged it.
    expect(s.has("hub.db")).toBe(true);
    expect(s.has("hub.db-wal")).toBe(true);
    expect(s.has("hub.db-shm")).toBe(true);
  });
});

describe("planArchive", () => {
  test("clean ecosystem root produces an empty plan", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      const plan = planArchive(h.configDir, APRIL_19);
      expect(plan.items).toEqual([]);
      expect(plan.totalBytes).toBe(0);
      expect(plan.archiveDirName).toBe(".archive-2026-04-19");
    } finally {
      h.cleanup();
    }
  });

  test("pre-restructure cruft is identified and sized", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X".repeat(100));
      touch(join(h.configDir, "daily.db-shm"), "S");
      touch(join(h.configDir, "server.yaml"), "port: 1940\n");
      mkdirSync(join(h.configDir, "logs"), { recursive: true });
      touch(join(h.configDir, "logs", "old.log"), "old-entry\n");
      touch(join(h.configDir, "random-note.txt"), "mystery content");

      const plan = planArchive(h.configDir, APRIL_19);
      const names = plan.items.map((i) => i.name).sort();
      expect(names).toEqual(["daily.db", "daily.db-shm", "logs", "random-note.txt", "server.yaml"]);
      expect(plan.totalBytes).toBeGreaterThan(100);
      // known-cruft annotation is attached
      expect(plan.items.find((i) => i.name === "daily.db")?.annotation).toMatch(/daily/i);
      expect(plan.items.find((i) => i.name === "logs")?.annotation).toMatch(/logs/i);
      // unknown files get no annotation
      expect(plan.items.find((i) => i.name === "random-note.txt")?.annotation).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("dotfiles at root are left alone", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, ".env"), "SECRET=x");
      touch(join(h.configDir, ".DS_Store"), "");
      mkdirSync(join(h.configDir, ".archive-2026-04-01"), { recursive: true });
      touch(join(h.configDir, ".archive-2026-04-01", "daily.db"), "Y");

      const plan = planArchive(h.configDir, APRIL_19);
      expect(plan.items).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("directory sizes are summed recursively", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      const nested = join(h.configDir, "old-tree", "a", "b");
      mkdirSync(nested, { recursive: true });
      touch(join(nested, "inner.dat"), "Z".repeat(500));
      touch(join(h.configDir, "old-tree", "top.dat"), "Q".repeat(300));

      const plan = planArchive(h.configDir, APRIL_19);
      const oldTree = plan.items.find((i) => i.name === "old-tree");
      expect(oldTree).toBeDefined();
      expect(oldTree?.kind).toBe("dir");
      expect(oldTree?.bytes).toBe(800);
    } finally {
      h.cleanup();
    }
  });

  test("symlinks at root are not followed when sizing", () => {
    // Regression guard: Dirent.isDirectory() returns true for a symlink to a
    // directory on macOS/Linux, so the pre-fix planner would descend sizeOf()
    // into the link's target. A user pointing ~/.parachute/external-backup
    // at a multi-GB external volume would see absurd byte totals and pay
    // the cost of walking that tree.
    const targetHarness = makeHarness();
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // Populate the target with a much-bigger-than-plausible file so if the
      // planner does descend, the assertion on bytes=0 would obviously fail.
      touch(join(targetHarness.configDir, "huge.bin"), "X".repeat(10_000));
      touch(join(targetHarness.configDir, "more.bin"), "Y".repeat(5_000));
      const linkPath = join(h.configDir, "external-backup");
      symlinkSync(targetHarness.configDir, linkPath);

      const plan = planArchive(h.configDir, APRIL_19);
      const item = plan.items.find((i) => i.name === "external-backup");
      expect(item).toBeDefined();
      expect(item?.bytes).toBe(0);
      expect(item?.kind).toBe("file");
      expect(plan.totalBytes).toBe(0);
    } finally {
      h.cleanup();
      targetHarness.cleanup();
    }
  });
});

describe("migrate", () => {
  test("no-op on a clean root with exit 0", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/nothing to archive/i);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("dry-run prints plan, makes no changes, no prompt", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X");
      touch(join(h.configDir, "random"), "Y");

      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        dryRun: true,
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/dry-run/i);
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(true);
      expect(existsSync(join(h.configDir, "random"))).toBe(true);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("--yes archives without prompting, safelist untouched", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X".repeat(50));
      touch(join(h.configDir, "server.yaml"), "port: 1\n");
      mkdirSync(join(h.configDir, "logs"), { recursive: true });
      touch(join(h.configDir, "logs", "a.log"), "a");

      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        yes: true,
      });
      expect(code).toBe(0);
      const archive = join(h.configDir, ".archive-2026-04-19");
      expect(existsSync(archive)).toBe(true);
      expect(existsSync(join(archive, "daily.db"))).toBe(true);
      expect(existsSync(join(archive, "server.yaml"))).toBe(true);
      expect(existsSync(join(archive, "logs", "a.log"))).toBe(true);
      // safelist still in place
      expect(existsSync(join(h.configDir, "vault", "config.json"))).toBe(true);
      expect(existsSync(join(h.configDir, "services.json"))).toBe(true);
      expect(existsSync(join(h.configDir, "well-known"))).toBe(true);
      expect(existsSync(join(h.configDir, "hub"))).toBe(true);
      // originals gone
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(false);
      expect(existsSync(join(h.configDir, "server.yaml"))).toBe(false);
      expect(existsSync(join(h.configDir, "logs"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("--yes archives a symlink by moving the link, not the target", async () => {
    const targetHarness = makeHarness();
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(targetHarness.configDir, "huge.bin"), "X".repeat(10_000));
      const linkPath = join(h.configDir, "external-backup");
      symlinkSync(targetHarness.configDir, linkPath);

      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        yes: true,
      });
      expect(code).toBe(0);
      const archivedLink = join(h.configDir, ".archive-2026-04-19", "external-backup");
      expect(lstatSync(archivedLink).isSymbolicLink()).toBe(true);
      // Target tree untouched
      expect(existsSync(join(targetHarness.configDir, "huge.bin"))).toBe(true);
      // Original link site is empty
      expect(existsSync(linkPath)).toBe(false);
    } finally {
      h.cleanup();
      targetHarness.cleanup();
    }
  });

  test("prompt 'n' aborts with exit 1, no changes", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X");
      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => "n",
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/aborted/i);
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(true);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("prompt 'y' (and 'yes') proceeds", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "cruft.txt"), "Z");
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        prompt: async () => "y",
      });
      expect(code).toBe(0);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19", "cruft.txt"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("re-run same day reuses the same .archive-<date>/", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "first.txt"), "1");
      await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        yes: true,
      });
      // Add more cruft and sweep again the same day
      touch(join(h.configDir, "second.txt"), "2");
      await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        yes: true,
      });
      const archive = join(h.configDir, ".archive-2026-04-19");
      expect(existsSync(join(archive, "first.txt"))).toBe(true);
      expect(existsSync(join(archive, "second.txt"))).toBe(true);
      // Only one archive dir at root
      const archiveDirs = readdirSync(h.configDir).filter((n) => n.startsWith(".archive-"));
      expect(archiveDirs).toEqual([".archive-2026-04-19"]);
    } finally {
      h.cleanup();
    }
  });

  test("different day creates a second archive dir; prior one is left alone", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "day1.txt"), "1");
      await migrate({ configDir: h.configDir, now: () => APRIL_19, log: () => {}, yes: true });
      touch(join(h.configDir, "day2.txt"), "2");
      await migrate({ configDir: h.configDir, now: () => APRIL_20, log: () => {}, yes: true });
      expect(existsSync(join(h.configDir, ".archive-2026-04-19", "day1.txt"))).toBe(true);
      expect(existsSync(join(h.configDir, ".archive-2026-04-20", "day2.txt"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("conflicting name in today's archive gets a .dup suffix", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // Pre-existing archive with a same-name entry.
      mkdirSync(join(h.configDir, ".archive-2026-04-19"), { recursive: true });
      touch(join(h.configDir, ".archive-2026-04-19", "notes.md"), "old");
      // New cruft with the same name.
      touch(join(h.configDir, "notes.md"), "new");
      await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        yes: true,
      });
      const archive = join(h.configDir, ".archive-2026-04-19");
      const contents = readdirSync(archive);
      expect(contents).toContain("notes.md");
      expect(contents.some((n) => n.startsWith("notes.md.dup-"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe("migrateNotice", () => {
  test("undefined when nothing to archive", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      expect(migrateNotice(h.configDir, APRIL_19)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("returns a single line with the count when cruft exists", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "x");
      touch(join(h.configDir, "stray"), "y");
      const notice = migrateNotice(h.configDir, APRIL_19);
      expect(notice).toBeDefined();
      expect(notice).toMatch(/parachute migrate/);
      expect(notice).toMatch(/2 unrecognized/);
    } finally {
      h.cleanup();
    }
  });
});
