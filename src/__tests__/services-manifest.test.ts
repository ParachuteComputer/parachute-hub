import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ServiceEntry,
  ServicesManifestError,
  findService,
  readManifest,
  removeService,
  upsertService,
  writeManifest,
} from "../services-manifest.ts";

function makeTempPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-"));
  const path = join(dir, "services.json");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const vault: ServiceEntry = {
  name: "parachute-vault",
  port: 1940,
  paths: ["/"],
  health: "/health",
  version: "0.2.4",
};

const notes: ServiceEntry = {
  name: "parachute-notes",
  port: 5173,
  paths: ["/notes"],
  health: "/notes/health",
  version: "0.0.1",
};

describe("services-manifest", () => {
  test("readManifest returns empty when file missing", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(readManifest(path)).toEqual({ services: [] });
    } finally {
      cleanup();
    }
  });

  test("writeManifest + readManifest round-trip", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeManifest({ services: [vault] }, path);
      expect(readManifest(path)).toEqual({ services: [vault] });
    } finally {
      cleanup();
    }
  });

  test("upsertService adds a new entry", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const m = upsertService(vault, path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]).toEqual(vault);
      expect(readManifest(path)).toEqual(m);
    } finally {
      cleanup();
    }
  });

  test("upsertService updates by name, never duplicates", () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(vault, path);
      upsertService({ ...vault, version: "0.3.0", port: 1941 }, path);
      const m = readManifest(path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]?.version).toBe("0.3.0");
      expect(m.services[0]?.port).toBe(1941);
    } finally {
      cleanup();
    }
  });

  test("upsertService preserves other services", () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(vault, path);
      upsertService(notes, path);
      const m = readManifest(path);
      expect(m.services).toHaveLength(2);
      expect(m.services.map((s) => s.name).sort()).toEqual(["parachute-notes", "parachute-vault"]);
    } finally {
      cleanup();
    }
  });

  test("removeService drops entry by name", () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(vault, path);
      upsertService(notes, path);
      removeService("parachute-vault", path);
      const m = readManifest(path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]?.name).toBe("parachute-notes");
    } finally {
      cleanup();
    }
  });

  test("findService returns entry or undefined", () => {
    const { path, cleanup } = makeTempPath();
    try {
      upsertService(vault, path);
      expect(findService("parachute-vault", path)).toEqual(vault);
      expect(findService("parachute-none", path)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("readManifest throws on invalid JSON", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, "{ not json");
      expect(() => readManifest(path)).toThrow(ServicesManifestError);
    } finally {
      cleanup();
    }
  });

  test("readManifest throws on malformed entry", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, JSON.stringify({ services: [{ name: "x" }] }));
      expect(() => readManifest(path)).toThrow(/port/);
    } finally {
      cleanup();
    }
  });

  test("upsertService validates entry", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(() => upsertService({ ...vault, port: 99999 } as ServiceEntry, path)).toThrow(
        ServicesManifestError,
      );
    } finally {
      cleanup();
    }
  });

  test("round-trips optional displayName and tagline", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const full: ServiceEntry = {
        ...vault,
        displayName: "Vault",
        tagline: "Your notes, sovereign",
      };
      upsertService(full, path);
      expect(readManifest(path).services[0]).toEqual(full);
    } finally {
      cleanup();
    }
  });

  test("rejects non-string displayName", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(() => upsertService({ ...vault, displayName: 42 as unknown as string }, path)).toThrow(
        /displayName/,
      );
    } finally {
      cleanup();
    }
  });

  test("round-trips optional installDir", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const full: ServiceEntry = { ...vault, installDir: "/abs/path/to/pkg" };
      upsertService(full, path);
      expect(readManifest(path).services[0]).toEqual(full);
    } finally {
      cleanup();
    }
  });

  test("rejects non-string installDir", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(() => upsertService({ ...vault, installDir: 42 as unknown as string }, path)).toThrow(
        /installDir/,
      );
    } finally {
      cleanup();
    }
  });

  test("round-trips optional stripPrefix (true and false)", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const stripping: ServiceEntry = { ...vault, stripPrefix: true };
      upsertService(stripping, path);
      expect(readManifest(path).services[0]).toEqual(stripping);

      const explicitFalse: ServiceEntry = { ...vault, stripPrefix: false };
      upsertService(explicitFalse, path);
      expect(readManifest(path).services[0]).toEqual(explicitFalse);
    } finally {
      cleanup();
    }
  });

  test("rejects non-boolean stripPrefix", () => {
    const { path, cleanup } = makeTempPath();
    try {
      expect(() =>
        upsertService({ ...vault, stripPrefix: "yes" as unknown as boolean }, path),
      ).toThrow(/stripPrefix/);
    } finally {
      cleanup();
    }
  });
});

describe("claw → agent migration", () => {
  // Paraclaw was renamed to parachute-agent across the ecosystem (npm
  // package, mount path, short name). Operators who upgraded hub but
  // still have the old paraclaw row in services.json otherwise see a
  // tile labelled "Claw" and a hub route at `/claw` while their newly
  // upgraded daemon listens on `/agent`. The migration runs on
  // readManifest, rewrites the row in-place, and writes back.
  const claw: ServiceEntry = {
    name: "claw",
    port: 1944,
    paths: ["/claw"],
    health: "/claw/health",
    version: "0.1.0",
  };
  const agent: ServiceEntry = {
    name: "agent",
    port: 1944,
    paths: ["/agent"],
    health: "/agent/health",
    version: "0.1.0",
  };

  test("rewrites name + paths + health when both name=claw and paths[0]=/claw", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, `${JSON.stringify({ services: [claw] }, null, 2)}\n`);
      const got = readManifest(path);
      expect(got.services).toEqual([agent]);
      // Persisted: a second read sees the migrated shape directly, no
      // re-migration required.
      const reread = JSON.parse(readFileSync(path, "utf8")) as {
        services: ServiceEntry[];
      };
      expect(reread.services[0]?.name).toBe("agent");
      expect(reread.services[0]?.paths).toEqual(["/agent"]);
      expect(reread.services[0]?.health).toBe("/agent/health");
    } finally {
      cleanup();
    }
  });

  test("idempotent: an already-agent entry is not rewritten and not rewritten on re-read", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, `${JSON.stringify({ services: [agent] }, null, 2)}\n`);
      const beforeMtime = statSync(path).mtimeMs;
      const got = readManifest(path);
      expect(got.services).toEqual([agent]);
      // No write back when nothing changed: mtime stays put.
      const afterMtime = statSync(path).mtimeMs;
      expect(afterMtime).toBe(beforeMtime);
    } finally {
      cleanup();
    }
  });

  test("mixed manifest: vault and scribe are untouched, only claw migrates", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const scribe: ServiceEntry = {
        name: "parachute-scribe",
        port: 1943,
        paths: ["/scribe"],
        health: "/scribe/health",
        version: "0.1.0",
      };
      writeFileSync(path, `${JSON.stringify({ services: [vault, claw, scribe] }, null, 2)}\n`);
      const got = readManifest(path);
      expect(got.services).toHaveLength(3);
      expect(got.services[0]).toEqual(vault);
      expect(got.services[1]).toEqual(agent);
      expect(got.services[2]).toEqual(scribe);
    } finally {
      cleanup();
    }
  });

  test("preserves nested /claw paths when present (e.g. /claw/api)", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const clawNested: ServiceEntry = {
        name: "claw",
        port: 1944,
        paths: ["/claw", "/claw/api"],
        health: "/claw/api/health",
        version: "0.1.0",
      };
      writeFileSync(path, `${JSON.stringify({ services: [clawNested] }, null, 2)}\n`);
      const got = readManifest(path);
      expect(got.services[0]?.paths).toEqual(["/agent", "/agent/api"]);
      expect(got.services[0]?.health).toBe("/agent/api/health");
    } finally {
      cleanup();
    }
  });

  test("leaves a row alone if name is claw but mount is something else (deliberate third-party reuse)", () => {
    const { path, cleanup } = makeTempPath();
    try {
      const oddClaw: ServiceEntry = {
        name: "claw",
        port: 9000,
        paths: ["/something-else"],
        health: "/something-else/health",
        version: "0.1.0",
      };
      writeFileSync(path, `${JSON.stringify({ services: [oddClaw] }, null, 2)}\n`);
      expect(readManifest(path).services).toEqual([oddClaw]);
    } finally {
      cleanup();
    }
  });
});
