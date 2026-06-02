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
import {
  KNOWN_ARCHIVABLE_DIRS,
  listRunningServices,
  migrate,
  migrateNotice,
  planArchive,
  safelistEntries,
} from "../commands/migrate.ts";
import { writePid } from "../process-state.ts";

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
}

describe("safelistEntries", () => {
  test("covers service dirs, hub, state files, hub.db family, well-known, cloudflared", () => {
    const s = safelistEntries();
    // Service dirs from SERVICE_SPECS
    expect(s.has("vault")).toBe(true);
    expect(s.has("notes")).toBe(true);
    expect(s.has("scribe")).toBe(true);
    expect(s.has("channel")).toBe(true);
    // Internal
    expect(s.has("hub")).toBe(true);
    // CLI state
    expect(s.has("services.json")).toBe(true);
    expect(s.has("expose-state.json")).toBe(true);
    expect(s.has("cloudflared-state.json")).toBe(true);
    expect(s.has("well-known")).toBe(true);
    // hub.db family — the trigger for the 2026-05-27 redesign was hub.db
    // not being recognized; the allowlist now defaults to "leave unknown
    // alone," but hub.db is explicitly safelisted so it doesn't even show
    // up as "unknown" in the plan.
    expect(s.has("hub.db")).toBe(true);
    expect(s.has("hub.db-wal")).toBe(true);
    expect(s.has("hub.db-shm")).toBe(true);
    // cloudflared per-tunnel config dir
    expect(s.has("cloudflared")).toBe(true);
  });

  test("`lens` is in the archivable-dirs set (not safelist) — sweep, don't preserve", () => {
    // The Notes→Lens→Notes rename round-trip (Apr 19 → Apr 22) left some
    // installs with `~/.parachute/lens/`. Under the new allowlist model,
    // lens/ is explicitly archivable rather than safelisted — we want
    // operators upgrading to the post-rename world to actually clean it up.
    expect(KNOWN_ARCHIVABLE_DIRS.has("lens")).toBe(true);
    expect(safelistEntries().has("lens")).toBe(false);
  });
});

describe("planArchive — allowlist behavior", () => {
  test("clean ecosystem root produces an empty plan", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      const plan = planArchive(h.configDir, APRIL_19);
      expect(plan.items).toEqual([]);
      expect(plan.totalBytes).toBe(0);
      expect(plan.archiveDirName).toBe(".archive-2026-04-19");
      expect(plan.hasLiveDb).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("known-cruft is archived, unknowns are recorded but not archived", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // Known cruft — archives.
      touch(join(h.configDir, "daily.db"), "X".repeat(100));
      touch(join(h.configDir, "daily.db-shm"), "S");
      touch(join(h.configDir, "server.yaml"), "port: 1940\n");
      mkdirSync(join(h.configDir, "logs"), { recursive: true });
      touch(join(h.configDir, "logs", "old.log"), "old-entry\n");
      // Unknown — left alone (under old shape this would have been swept).
      touch(join(h.configDir, "random-note.txt"), "mystery content");
      mkdirSync(join(h.configDir, "future-module"), { recursive: true });
      touch(join(h.configDir, "future-module", "state.json"), "{}");

      const plan = planArchive(h.configDir, APRIL_19);
      const archivable = plan.items.filter((i) => i.archive).map((i) => i.name);
      const skipped = plan.items.filter((i) => !i.archive).map((i) => i.name);

      expect(archivable.sort()).toEqual(["daily.db", "daily.db-shm", "logs", "server.yaml"]);
      expect(skipped.sort()).toEqual(["future-module", "random-note.txt"]);

      // Archivable totals reflect known-cruft only — unknowns contribute 0.
      expect(plan.totalBytes).toBeGreaterThan(100);

      // Known-cruft has a friendly annotation; unknowns have none.
      expect(plan.items.find((i) => i.name === "daily.db")?.annotation).toMatch(/daily/i);
      expect(plan.items.find((i) => i.name === "logs")?.annotation).toMatch(/logs/i);
      expect(plan.items.find((i) => i.name === "random-note.txt")?.annotation).toBeUndefined();
      expect(plan.items.find((i) => i.name === "future-module")?.annotation).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("`lens` directory is archivable per KNOWN_ARCHIVABLE_DIRS", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      mkdirSync(join(h.configDir, "lens"), { recursive: true });
      touch(join(h.configDir, "lens", "config.json"), "{}");

      const plan = planArchive(h.configDir, APRIL_19);
      const lens = plan.items.find((i) => i.name === "lens");
      expect(lens?.archive).toBe(true);
      expect(lens?.risk).toBe("safe");
      expect(lens?.annotation).toMatch(/legacy/i);
    } finally {
      h.cleanup();
    }
  });

  test("SQLite-shape files carry the live-db risk label", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X".repeat(50));
      touch(join(h.configDir, "daily.db-wal"), "W");
      touch(join(h.configDir, "daily.db-shm"), "S");
      touch(join(h.configDir, "server.yaml"), "p: 1\n");

      const plan = planArchive(h.configDir, APRIL_19);
      const db = plan.items.find((i) => i.name === "daily.db");
      const wal = plan.items.find((i) => i.name === "daily.db-wal");
      const shm = plan.items.find((i) => i.name === "daily.db-shm");
      const yaml = plan.items.find((i) => i.name === "server.yaml");
      expect(db?.risk).toBe("live-db");
      expect(wal?.risk).toBe("live-db");
      expect(shm?.risk).toBe("live-db");
      expect(yaml?.risk).toBe("safe");
      expect(plan.hasLiveDb).toBe(true);
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

  test("directory sizes for archivable entries are summed recursively", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // `logs` is known cruft — its size should be summed.
      const nested = join(h.configDir, "logs", "a", "b");
      mkdirSync(nested, { recursive: true });
      touch(join(nested, "inner.dat"), "Z".repeat(500));
      touch(join(h.configDir, "logs", "top.dat"), "Q".repeat(300));

      const plan = planArchive(h.configDir, APRIL_19);
      const logsItem = plan.items.find((i) => i.name === "logs");
      expect(logsItem?.archive).toBe(true);
      expect(logsItem?.kind).toBe("dir");
      expect(logsItem?.bytes).toBe(800);
    } finally {
      h.cleanup();
    }
  });

  test("unknown directories do not pay the recursive sizeOf cost", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      const deep = join(h.configDir, "future-module", "a", "b");
      mkdirSync(deep, { recursive: true });
      touch(join(deep, "inner.dat"), "Z".repeat(500));

      const plan = planArchive(h.configDir, APRIL_19);
      const item = plan.items.find((i) => i.name === "future-module");
      expect(item?.archive).toBe(false);
      // Unknowns get bytes=0 even when the directory tree is non-empty —
      // we don't walk something we're not going to touch.
      expect(item?.bytes).toBe(0);
      expect(plan.totalBytes).toBe(0);
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
      // It's an unknown name — left alone.
      expect(item?.archive).toBe(false);
      expect(item?.bytes).toBe(0);
      expect(item?.kind).toBe("file");
      expect(plan.totalBytes).toBe(0);
    } finally {
      h.cleanup();
      targetHarness.cleanup();
    }
  });

  test("plan sort order — archivable first, then skipped, alphabetical within each group", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // Mix known-cruft and unknowns; assert ordering.
      touch(join(h.configDir, "zzz-unknown"), "");
      touch(join(h.configDir, "aaa-unknown"), "");
      touch(join(h.configDir, "server.yaml"), "");
      touch(join(h.configDir, "daily.db"), "");

      const plan = planArchive(h.configDir, APRIL_19);
      const names = plan.items.map((i) => i.name);
      expect(names).toEqual(["daily.db", "server.yaml", "aaa-unknown", "zzz-unknown"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("migrate — interactive + flag behavior", () => {
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
        isTty: true,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/nothing to archive/i);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("--list prints plan, makes no changes, no prompt, no running-service check", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X");
      touch(join(h.configDir, "random"), "Y");
      // A running vault should NOT block a read-only --list.
      mkdirSync(join(h.configDir, "vault", "run"), { recursive: true });
      writePid("vault", process.pid, h.configDir);

      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        list: true,
        isTty: true,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/--list — no changes made/);
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(true);
      expect(existsSync(join(h.configDir, "random"))).toBe(true);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("--dry-run is a synonym for --list (back-compat)", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X");
      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        dryRun: true,
        isTty: true,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(0);
      expect(logs.join("\n")).toMatch(/dry-run/);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("--yes archives known cruft; unknowns are preserved", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // Known cruft (archives)
      touch(join(h.configDir, "daily.db"), "X".repeat(50));
      touch(join(h.configDir, "server.yaml"), "port: 1\n");
      mkdirSync(join(h.configDir, "logs"), { recursive: true });
      touch(join(h.configDir, "logs", "a.log"), "a");
      // Unknown (must NOT move)
      touch(join(h.configDir, "my-notes.txt"), "operator-owned content");
      mkdirSync(join(h.configDir, "future-module"), { recursive: true });

      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        yes: true,
        isTty: false,
        hubUnitState: () => ({ state: "inactive" }),
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
      // archivable originals gone
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(false);
      expect(existsSync(join(h.configDir, "server.yaml"))).toBe(false);
      expect(existsSync(join(h.configDir, "logs"))).toBe(false);
      // unknowns preserved!
      expect(existsSync(join(h.configDir, "my-notes.txt"))).toBe(true);
      expect(existsSync(join(h.configDir, "future-module"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("refuses while a service is running", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // Seed a running hub (use the current test process pid — guaranteed alive).
      mkdirSync(join(h.configDir, "hub", "run"), { recursive: true });
      writePid("hub", process.pid, h.configDir);
      touch(join(h.configDir, "daily.db"), "X");

      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        yes: true,
        isTty: true,
      });
      expect(code).toBe(1);
      const joined = logs.join("\n");
      expect(joined).toMatch(/services are currently running/i);
      expect(joined).toMatch(/- hub/);
      // No archive happened.
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("§7.3 refuses while a UNIT-MANAGED hub runs (no pidfile, detected via manager)", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // NO hub pidfile — this is a supervised/unit-managed hub. Before the §7.3
      // fix the refuse-while-running guard FAILED OPEN here and migrate would
      // archive ~/.parachute out from under the live hub.
      touch(join(h.configDir, "daily.db"), "X");

      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        yes: true,
        isTty: true,
        // No pidfile alive; the manager reports the hub unit active.
        alive: () => false,
        hubUnitState: () => ({ state: "active" }),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/services are currently running/i);
      // No archive happened — the guard held.
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("§7.3 archive PROCEEDS when the manager reports the hub inactive (no false-positive)", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X");

      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        yes: true,
        isTty: true,
        alive: () => false,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(0);
      // The sweep ran — daily.db is archived.
      expect(existsSync(join(h.configDir, ".archive-2026-04-19", "daily.db"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("refuses non-TTY without --yes (CI / pipe safety)", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X");

      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        isTty: false,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/refusing to sweep without a TTY/i);
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("live-db items pull an extra confirmation; declining aborts", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X");
      touch(join(h.configDir, "daily.db-wal"), "W");

      const answers = ["y", "n"]; // first y to proceed, then n on the live-db gate.
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        prompt: async () => answers.shift() ?? "n",
        isTty: true,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(1);
      // Aborted before any rename — daily.db still there.
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(true);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("live-db items pull an extra confirmation; accepting both proceeds", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "X");
      touch(join(h.configDir, "daily.db-wal"), "W");

      const answers = ["y", "y"];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        prompt: async () => answers.shift() ?? "y",
        isTty: true,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(0);
      const archive = join(h.configDir, ".archive-2026-04-19");
      expect(existsSync(join(archive, "daily.db"))).toBe(true);
      expect(existsSync(join(archive, "daily.db-wal"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("--yes archives a symlink (if known-archivable name) by moving the link, not the target", async () => {
    // Reorient the symlink regression test against the new shape: only
    // archivable names actually move. We synthesize a known-cruft symlink:
    // `logs` (directory cruft) pointed at an external target.
    const targetHarness = makeHarness();
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(targetHarness.configDir, "huge.bin"), "X".repeat(10_000));
      const linkPath = join(h.configDir, "logs");
      symlinkSync(targetHarness.configDir, linkPath);

      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        yes: true,
        isTty: false,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(0);
      const archivedLink = join(h.configDir, ".archive-2026-04-19", "logs");
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

  test("unknown symlink is preserved (under new allowlist)", async () => {
    const targetHarness = makeHarness();
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(targetHarness.configDir, "huge.bin"), "X".repeat(10_000));
      const linkPath = join(h.configDir, "external-backup");
      symlinkSync(targetHarness.configDir, linkPath);

      const logs: string[] = [];
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: (l) => logs.push(l),
        prompt: async () => {
          throw new Error("prompt must not be called");
        },
        yes: true,
        isTty: false,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(0);
      // The "nothing recognized" exit branch — no archive directory created.
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
      // The unknown symlink stays at the root.
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      // Plan was still printed.
      expect(logs.join("\n")).toMatch(/Leaving alone/);
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
        isTty: true,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(1);
      expect(logs.join("\n")).toMatch(/aborted/i);
      expect(existsSync(join(h.configDir, "daily.db"))).toBe(true);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("prompt 'y' proceeds for non-live-db items", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "server.yaml"), "Z"); // known cruft, not live-db
      const code = await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        prompt: async () => "y",
        isTty: true,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(code).toBe(0);
      expect(existsSync(join(h.configDir, ".archive-2026-04-19", "server.yaml"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("re-run same day reuses the same .archive-<date>/", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "server.yaml"), "1");
      await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        yes: true,
        isTty: false,
        hubUnitState: () => ({ state: "inactive" }),
      });
      // Add more cruft and sweep again the same day
      touch(join(h.configDir, "channel.log"), "2");
      await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        yes: true,
        isTty: false,
        hubUnitState: () => ({ state: "inactive" }),
      });
      const archive = join(h.configDir, ".archive-2026-04-19");
      expect(existsSync(join(archive, "server.yaml"))).toBe(true);
      expect(existsSync(join(archive, "channel.log"))).toBe(true);
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
      touch(join(h.configDir, "server.yaml"), "1");
      await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        yes: true,
        isTty: false,
        hubUnitState: () => ({ state: "inactive" }),
      });
      touch(join(h.configDir, "channel.log"), "2");
      await migrate({
        configDir: h.configDir,
        now: () => APRIL_20,
        log: () => {},
        yes: true,
        isTty: false,
        hubUnitState: () => ({ state: "inactive" }),
      });
      expect(existsSync(join(h.configDir, ".archive-2026-04-19", "server.yaml"))).toBe(true);
      expect(existsSync(join(h.configDir, ".archive-2026-04-20", "channel.log"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("conflicting name in today's archive gets a .dup suffix", async () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // Pre-existing archive with a same-name entry. server.yaml is known cruft.
      mkdirSync(join(h.configDir, ".archive-2026-04-19"), { recursive: true });
      touch(join(h.configDir, ".archive-2026-04-19", "server.yaml"), "old");
      touch(join(h.configDir, "server.yaml"), "new");
      await migrate({
        configDir: h.configDir,
        now: () => APRIL_19,
        log: () => {},
        yes: true,
        isTty: false,
        hubUnitState: () => ({ state: "inactive" }),
      });
      const archive = join(h.configDir, ".archive-2026-04-19");
      const contents = readdirSync(archive);
      expect(contents).toContain("server.yaml");
      expect(contents.some((n) => n.startsWith("server.yaml.dup-"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

describe("listRunningServices", () => {
  test("empty when no pidfiles exist", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      const running = listRunningServices(
        h.configDir,
        join(h.configDir, "services.json"),
        () => false,
        // Explicit no-unit stub so this stays deterministic even on a dev box
        // that happens to have a hub unit installed (the §7.3 manager check).
        () => ({ state: "no-unit" }),
      );
      expect(running).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("§7.3 archive-guard: a unit-managed hub (no pidfile) is detected RUNNING via the manager", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // NO hub pidfile (unit-managed hubs don't write one) → the pidfile check
      // (alive => false) reports the hub as not-running. Before the fix this
      // FAILED OPEN. The platform-manager check sees `active` and holds.
      const running = listRunningServices(
        h.configDir,
        join(h.configDir, "services.json"),
        () => false,
        () => ({ state: "active" }),
      );
      expect(running).toContain("hub");
    } finally {
      h.cleanup();
    }
  });

  test("§7.3 archive-guard: `activating` also reads as running", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      const running = listRunningServices(
        h.configDir,
        join(h.configDir, "services.json"),
        () => false,
        () => ({ state: "activating" }),
      );
      expect(running).toContain("hub");
    } finally {
      h.cleanup();
    }
  });

  test("§7.3 archive-guard: `failed` / `inactive` / `no-manager` are NOT running", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      for (const state of ["failed", "inactive", "no-manager", "no-unit", "unknown"] as const) {
        const running = listRunningServices(
          h.configDir,
          join(h.configDir, "services.json"),
          () => false,
          () => ({ state }),
        );
        expect(running).not.toContain("hub");
      }
    } finally {
      h.cleanup();
    }
  });

  test("§7.3 archive-guard: a manager-query that throws never crashes the guard (fails closed-ish)", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      const running = listRunningServices(
        h.configDir,
        join(h.configDir, "services.json"),
        () => false,
        () => {
          throw new Error("systemctl exploded");
        },
      );
      // The throw is swallowed; the pidfile check (no pid) governs → not running.
      // (The guard must not crash; it just gets no extra signal from the manager.)
      expect(running).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("reports hub when its PID is live", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      mkdirSync(join(h.configDir, "hub", "run"), { recursive: true });
      writePid("hub", 12345, h.configDir);
      const running = listRunningServices(
        h.configDir,
        join(h.configDir, "services.json"),
        () => true,
      );
      expect(running).toContain("hub");
    } finally {
      h.cleanup();
    }
  });

  test("reports services from services.json when pidfiles are live", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      writeFileSync(
        join(h.configDir, "services.json"),
        JSON.stringify({
          services: [
            {
              name: "parachute-vault",
              version: "0.5.0",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
              icon: "/icon.svg",
              auth: { type: "none" },
              mcp: {},
            },
          ],
        }),
      );
      mkdirSync(join(h.configDir, "vault", "run"), { recursive: true });
      writePid("vault", 23456, h.configDir);
      const running = listRunningServices(
        h.configDir,
        join(h.configDir, "services.json"),
        () => true,
      );
      expect(running).toContain("vault");
    } finally {
      h.cleanup();
    }
  });
});

describe("migrateNotice", () => {
  test("undefined when nothing archivable", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      // Even with unknowns at the root, no notice — unknowns aren't candidates.
      touch(join(h.configDir, "operator-owned.md"), "hi");
      expect(migrateNotice(h.configDir, APRIL_19)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("returns a single line with the count when archivable cruft exists", () => {
    const h = makeHarness();
    try {
      seedSafelist(h.configDir);
      touch(join(h.configDir, "daily.db"), "x");
      touch(join(h.configDir, "server.yaml"), "y");
      // An unknown — must NOT count.
      touch(join(h.configDir, "stray"), "z");
      const notice = migrateNotice(h.configDir, APRIL_19);
      expect(notice).toBeDefined();
      expect(notice).toMatch(/parachute migrate/);
      expect(notice).toMatch(/2 archivable/);
    } finally {
      h.cleanup();
    }
  });
});
