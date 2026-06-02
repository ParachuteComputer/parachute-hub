import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CutoverResult } from "../commands/migrate-cutover.ts";
import { hasPriorDetachedInstall, offerMigrateToSupervised } from "../migrate-offer.ts";
import { writePid } from "../process-state.ts";

/**
 * Sandboxed §7.5 auto-detect-and-offer tests. Every offer runs against a fresh
 * tmp `PARACHUTE_HOME` with stubbed unit-detection / cutover / prompt / TTY —
 * no real prompt, no real cutover, no touching `~/.parachute`. The only real fs
 * is seeding pidfiles + services.json (via `writePid`) so the DETECTOR reads
 * genuine on-disk detached-era state.
 */
interface Harness {
  configDir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-offer-"));
  return {
    configDir: dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function seedManifest(manifestPath: string, services: Array<{ name: string; port: number }>): void {
  const full = services.map((s) => ({
    name: s.name,
    port: s.port,
    paths: [`/${s.name}`],
    health: "/health",
    version: "1.0.0",
  }));
  writeFileSync(manifestPath, JSON.stringify({ services: full }));
}

function seedHubPidfile(configDir: string, pid = 12345): void {
  mkdirSync(join(configDir, "hub", "run"), { recursive: true });
  writePid("hub", pid, configDir);
}

const migratedResult: CutoverResult = { outcome: "migrated", port: 1939, messages: ["✓ migrated"] };

describe("hasPriorDetachedInstall (the §7.5 (b) detector)", () => {
  test("true when a hub pidfile exists", () => {
    const h = makeHarness();
    try {
      seedHubPidfile(h.configDir);
      expect(hasPriorDetachedInstall(h.configDir, h.manifestPath)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("true when a module pidfile exists", () => {
    const h = makeHarness();
    try {
      seedManifest(h.manifestPath, [{ name: "parachute-vault", port: 1940 }]);
      mkdirSync(join(h.configDir, "vault", "run"), { recursive: true });
      writePid("vault", 999, h.configDir);
      expect(hasPriorDetachedInstall(h.configDir, h.manifestPath)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("FALSE on a clean/supervised box — services.json alone is NOT enough", () => {
    const h = makeHarness();
    try {
      // A configured box with services.json but NO pidfiles (the supervised
      // shape — children tracked in-process). Must not false-positive.
      seedManifest(h.manifestPath, [{ name: "parachute-vault", port: 1940 }]);
      expect(hasPriorDetachedInstall(h.configDir, h.manifestPath)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("FALSE on a brand-new box (no services.json, no pidfiles)", () => {
    const h = makeHarness();
    try {
      expect(hasPriorDetachedInstall(h.configDir, h.manifestPath)).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

describe("offerMigrateToSupervised — when NOT to offer", () => {
  test("no offer when a hub unit IS installed (already supervised)", async () => {
    const h = makeHarness();
    try {
      seedHubPidfile(h.configDir);
      let cutoverCalled = false;
      const result = await offerMigrateToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        isHubUnitInstalled: () => true, // a unit exists
        hasPriorDetached: () => true,
        cutover: async () => {
          cutoverCalled = true;
          return migratedResult;
        },
        prompt: async () => "y",
        isTty: true,
      });
      expect(result.outcome).toBe("no-offer");
      expect(cutoverCalled).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("no offer when there is no prior-detached evidence (clean box)", async () => {
    const h = makeHarness();
    try {
      const result = await offerMigrateToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        isHubUnitInstalled: () => false,
        hasPriorDetached: () => false, // clean box
        prompt: async () => {
          throw new Error("prompt must not be called on a clean box");
        },
        isTty: true,
      });
      expect(result.outcome).toBe("no-offer");
    } finally {
      h.cleanup();
    }
  });
});

describe("offerMigrateToSupervised — interactive (TTY)", () => {
  test("accept → runs the cutover, reports migrated", async () => {
    const h = makeHarness();
    try {
      let cutoverCalled = false;
      const result = await offerMigrateToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        isHubUnitInstalled: () => false,
        hasPriorDetached: () => true,
        cutover: async () => {
          cutoverCalled = true;
          return migratedResult;
        },
        prompt: async () => "y",
        isTty: true,
      });
      expect(cutoverCalled).toBe(true);
      expect(result.outcome).toBe("migrated");
    } finally {
      h.cleanup();
    }
  });

  test("decline → does NOT run the cutover", async () => {
    const h = makeHarness();
    try {
      let cutoverCalled = false;
      const log: string[] = [];
      const result = await offerMigrateToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        isHubUnitInstalled: () => false,
        hasPriorDetached: () => true,
        cutover: async () => {
          cutoverCalled = true;
          return migratedResult;
        },
        prompt: async () => "n",
        isTty: true,
      });
      expect(cutoverCalled).toBe(false);
      expect(result.outcome).toBe("declined");
      expect(log.join("\n")).toContain("parachute migrate --to-supervised");
    } finally {
      h.cleanup();
    }
  });

  test("accept but cutover fails → migrate-failed (NOT migrated)", async () => {
    const h = makeHarness();
    try {
      const result = await offerMigrateToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: () => {},
        isHubUnitInstalled: () => false,
        hasPriorDetached: () => true,
        cutover: async () => ({ outcome: "port-stuck", port: 1939, messages: ["stuck"] }),
        prompt: async () => "yes",
        isTty: true,
      });
      expect(result.outcome).toBe("migrate-failed");
    } finally {
      h.cleanup();
    }
  });
});

describe("offerMigrateToSupervised — non-interactive (no TTY)", () => {
  test("PRINTS the exact command and NEVER runs the cutover", async () => {
    const h = makeHarness();
    try {
      let cutoverCalled = false;
      const log: string[] = [];
      const result = await offerMigrateToSupervised({
        configDir: h.configDir,
        manifestPath: h.manifestPath,
        log: (l) => log.push(l),
        isHubUnitInstalled: () => false,
        hasPriorDetached: () => true,
        cutover: async () => {
          cutoverCalled = true;
          return migratedResult;
        },
        prompt: async () => {
          throw new Error("prompt must not be called in a non-TTY context");
        },
        isTty: false,
      });
      expect(result.outcome).toBe("printed");
      expect(cutoverCalled).toBe(false);
      expect(log.join("\n")).toContain("parachute migrate --to-supervised");
    } finally {
      h.cleanup();
    }
  });
});
