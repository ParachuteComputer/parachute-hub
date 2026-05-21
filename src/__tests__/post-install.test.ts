import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeModuleInstall, refreshWellKnown, stampInstallDirOnRow } from "../post-install.ts";
import { findService, upsertService } from "../services-manifest.ts";

/**
 * Tail-end helpers shared between CLI install (`commands/install.ts`) and
 * API install (`api-modules-ops.ts`). Cover the two responsibilities
 * independently + the paired `finalizeModuleInstall` entry point so a
 * future drift in either call site (the failure mode hub#292 / hub#298
 * traced) surfaces here.
 */

function makeHarness(): {
  dir: string;
  servicesJsonPath: string;
  wellKnownPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "pcli-post-install-"));
  return {
    dir,
    servicesJsonPath: join(dir, "services.json"),
    wellKnownPath: join(dir, "well-known.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("stampInstallDirOnRow", () => {
  test("stamps installDir on an existing row + returns true", () => {
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        h.servicesJsonPath,
      );
      const wrote = stampInstallDirOnRow({
        manifestName: "parachute-vault",
        installDir: "/fake/install/vault",
        servicesJsonPath: h.servicesJsonPath,
      });
      expect(wrote).toBe(true);
      const row = findService("parachute-vault", h.servicesJsonPath);
      expect(row?.installDir).toBe("/fake/install/vault");
    } finally {
      h.cleanup();
    }
  });

  test("no-ops when the row already carries the same installDir", () => {
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
          installDir: "/fake/install/vault",
        },
        h.servicesJsonPath,
      );
      const wrote = stampInstallDirOnRow({
        manifestName: "parachute-vault",
        installDir: "/fake/install/vault",
        servicesJsonPath: h.servicesJsonPath,
      });
      expect(wrote).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("no-ops + returns false when the row doesn't exist", () => {
    const h = makeHarness();
    try {
      const wrote = stampInstallDirOnRow({
        manifestName: "parachute-vault",
        installDir: "/fake/install/vault",
        servicesJsonPath: h.servicesJsonPath,
      });
      expect(wrote).toBe(false);
      expect(findService("parachute-vault", h.servicesJsonPath)).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });
});

describe("refreshWellKnown", () => {
  test("writes the on-disk doc + logs the regenerated path", async () => {
    const h = makeHarness();
    try {
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        h.servicesJsonPath,
      );
      const logs: string[] = [];
      await refreshWellKnown({
        servicesJsonPath: h.servicesJsonPath,
        canonicalOrigin: "https://hub.example.com",
        wellKnownPath: h.wellKnownPath,
        log: (msg) => logs.push(msg),
      });
      expect(existsSync(h.wellKnownPath)).toBe(true);
      expect(logs).toEqual([`regenerated ${h.wellKnownPath}`]);
      const doc = JSON.parse(readFileSync(h.wellKnownPath, "utf8")) as {
        services: Array<{ name: string }>;
        vaults: Array<{ name: string }>;
      };
      expect(doc.services.some((s) => s.name === "parachute-vault")).toBe(true);
      expect(doc.vaults.some((v) => v.name === "default")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("logs failure + does not throw when the well-known write itself errors", async () => {
    const h = makeHarness();
    try {
      // Point wellKnownPath at a directory rather than a file — writeFileSync
      // → renameSync surfaces as EISDIR (or platform-equivalent), which the
      // helper must catch and report rather than letting it propagate up
      // and abort an otherwise-successful install op.
      const logs: string[] = [];
      await refreshWellKnown({
        servicesJsonPath: h.servicesJsonPath,
        canonicalOrigin: "https://hub.example.com",
        wellKnownPath: h.dir, // tempdir itself, not a file inside it
        log: (msg) => logs.push(msg),
      });
      expect(logs.some((l) => l.startsWith("well-known regen failed:"))).toBe(true);
      expect(logs.some((l) => l.startsWith("regenerated"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("threads readModuleManifest through to the regen so uiUrl lands", async () => {
    const h = makeHarness();
    try {
      const installDir = "/fake/install/notes";
      upsertService(
        {
          name: "parachute-notes",
          port: 5173,
          paths: ["/notes"],
          health: "/notes/health",
          version: "0.1.0",
          installDir,
        },
        h.servicesJsonPath,
      );
      await refreshWellKnown({
        servicesJsonPath: h.servicesJsonPath,
        canonicalOrigin: "https://hub.example.com",
        wellKnownPath: h.wellKnownPath,
        log: () => {},
        readModuleManifest: async (dir) =>
          dir === installDir
            ? {
                name: "notes",
                manifestName: "parachute-notes",
                kind: "frontend",
                port: 5173,
                paths: ["/notes"],
                health: "/notes/health",
                uiUrl: "/notes",
                displayName: "Notes",
              }
            : null,
      });
      const doc = JSON.parse(readFileSync(h.wellKnownPath, "utf8")) as {
        services: Array<{ name: string; uiUrl?: string; displayName?: string }>;
      };
      const row = doc.services.find((s) => s.name === "parachute-notes");
      expect(row?.uiUrl).toBe("https://hub.example.com/notes");
      expect(row?.displayName).toBe("Notes");
    } finally {
      h.cleanup();
    }
  });
});

describe("finalizeModuleInstall", () => {
  test("stamps installDir AND regenerates well-known in one call", async () => {
    const h = makeHarness();
    try {
      const installDir = "/fake/install/vault";
      upsertService(
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.2.4",
        },
        h.servicesJsonPath,
      );
      const logs: string[] = [];
      await finalizeModuleInstall({
        manifestName: "parachute-vault",
        installDir,
        servicesJsonPath: h.servicesJsonPath,
        canonicalOrigin: "https://hub.example.com",
        wellKnownPath: h.wellKnownPath,
        log: (msg) => logs.push(msg),
      });
      // Stamp landed.
      const row = findService("parachute-vault", h.servicesJsonPath);
      expect(row?.installDir).toBe(installDir);
      // Well-known reflects the stamped row.
      expect(existsSync(h.wellKnownPath)).toBe(true);
      const doc = JSON.parse(readFileSync(h.wellKnownPath, "utf8")) as {
        services: Array<{ name: string; version: string }>;
      };
      expect(doc.services.some((s) => s.name === "parachute-vault")).toBe(true);
      // The regen-success log fired exactly once — no double-regen from
      // the helper.
      expect(logs.filter((l) => l.startsWith("regenerated"))).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  test("CLI- and API-path inputs produce byte-identical well-known docs", async () => {
    // The PR's pure-refactor invariant (hub#293): both paths funnel
    // through this helper, so given the same row state + same origin +
    // same module manifest, the on-disk doc must be identical regardless
    // of which call site drove it. Regression canary against the helper
    // silently growing per-caller branching.
    const cli = makeHarness();
    const api = makeHarness();
    try {
      const installDir = "/fake/install/vault";
      const row = {
        name: "parachute-vault",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        version: "0.2.4",
      };
      upsertService(row, cli.servicesJsonPath);
      upsertService(row, api.servicesJsonPath);
      const manifest = {
        name: "vault",
        manifestName: "parachute-vault",
        kind: "api" as const,
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
        managementUrl: "/vault/default/admin",
      };
      const opts = {
        manifestName: "parachute-vault",
        installDir,
        canonicalOrigin: "https://hub.example.com",
        log: () => {},
        readModuleManifest: async (dir: string) => (dir === installDir ? manifest : null),
      };
      await finalizeModuleInstall({
        ...opts,
        servicesJsonPath: cli.servicesJsonPath,
        wellKnownPath: cli.wellKnownPath,
      });
      await finalizeModuleInstall({
        ...opts,
        servicesJsonPath: api.servicesJsonPath,
        wellKnownPath: api.wellKnownPath,
      });
      const cliDoc = readFileSync(cli.wellKnownPath, "utf8");
      const apiDoc = readFileSync(api.wellKnownPath, "utf8");
      expect(cliDoc).toEqual(apiDoc);
    } finally {
      cli.cleanup();
      api.cleanup();
    }
  });
});
