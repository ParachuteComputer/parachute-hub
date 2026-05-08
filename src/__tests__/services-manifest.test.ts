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

  // Duplicate-port detection (hub#195). The original collision had
  // parachute-scribe and agent both at 1944 in services.json with no
  // operator-visible warning. The OS lets only one service bind, the
  // hub reverse-proxy quietly routes everyone to whoever won the race,
  // and `/agent` requests silently land on scribe. Reject at parse time
  // so the same shape can't recur silently. Underlying overwrite bugs
  // were fixed in parachute-scribe#41 + parachute-agent#146; this is
  // the hub-side gate.
  describe("duplicate port rejection", () => {
    test("rejects manifest where two entries share a port", () => {
      const { path, cleanup } = makeTempPath();
      try {
        writeFileSync(
          path,
          JSON.stringify({
            services: [
              {
                name: "parachute-scribe",
                port: 1944,
                paths: ["/scribe"],
                health: "/scribe/health",
                version: "0.4.0",
              },
              {
                name: "agent",
                port: 1944,
                paths: ["/agent"],
                health: "/agent/health",
                version: "0.1.0",
              },
            ],
          }),
        );
        expect(() => readManifest(path)).toThrow(ServicesManifestError);
      } finally {
        cleanup();
      }
    });

    test("error message names both conflicting services and the colliding port", () => {
      const { path, cleanup } = makeTempPath();
      try {
        writeFileSync(
          path,
          JSON.stringify({
            services: [
              {
                name: "parachute-scribe",
                port: 1944,
                paths: ["/scribe"],
                health: "/scribe/health",
                version: "0.4.0",
              },
              {
                name: "agent",
                port: 1944,
                paths: ["/agent"],
                health: "/agent/health",
                version: "0.1.0",
              },
            ],
          }),
        );
        // The error names the conflicting port (so an operator scanning
        // services.json knows where to look) and both service names (so
        // they know which two rows to reconcile).
        expect(() => readManifest(path)).toThrow(/duplicate port 1944/);
        expect(() => readManifest(path)).toThrow(/parachute-scribe/);
        expect(() => readManifest(path)).toThrow(/agent/);
      } finally {
        cleanup();
      }
    });

    test("accepts manifest with all unique ports", () => {
      const { path, cleanup } = makeTempPath();
      try {
        writeFileSync(
          path,
          JSON.stringify({
            services: [
              {
                name: "parachute-vault",
                port: 1940,
                paths: ["/"],
                health: "/health",
                version: "0.2.4",
              },
              {
                name: "parachute-scribe",
                port: 1943,
                paths: ["/scribe"],
                health: "/scribe/health",
                version: "0.4.0",
              },
            ],
          }),
        );
        const m = readManifest(path);
        expect(m.services).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    test("allows multi-vault: parachute-vault-default + parachute-vault-techne on the same port", () => {
      // Multi-vault is the deliberate exception. One parachute-vault process
      // serves N vault instances on a single port at distinct mount paths.
      // The duplicate-port gate must not break that shape.
      const { path, cleanup } = makeTempPath();
      try {
        writeFileSync(
          path,
          JSON.stringify({
            services: [
              {
                name: "parachute-vault-default",
                port: 1940,
                paths: ["/vault/default"],
                health: "/vault/default/health",
                version: "0.4.0",
              },
              {
                name: "parachute-vault-techne",
                port: 1940,
                paths: ["/vault/techne"],
                health: "/vault/techne/health",
                version: "0.4.0",
              },
            ],
          }),
        );
        const m = readManifest(path);
        expect(m.services).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    test("rejects vault sharing a port with a non-vault service", () => {
      // The vault exception is narrow: same-port is allowed only between
      // multi-vault rows. A vault sharing a port with anything else is the
      // same silent-miswire shape we're guarding against.
      const { path, cleanup } = makeTempPath();
      try {
        writeFileSync(
          path,
          JSON.stringify({
            services: [
              {
                name: "parachute-vault-default",
                port: 1940,
                paths: ["/vault/default"],
                health: "/vault/default/health",
                version: "0.4.0",
              },
              {
                name: "parachute-scribe",
                port: 1940,
                paths: ["/scribe"],
                health: "/scribe/health",
                version: "0.4.0",
              },
            ],
          }),
        );
        expect(() => readManifest(path)).toThrow(/duplicate port 1940/);
      } finally {
        cleanup();
      }
    });

    test("three-way collision still surfaces (first pair caught)", () => {
      const { path, cleanup } = makeTempPath();
      try {
        writeFileSync(
          path,
          JSON.stringify({
            services: [
              {
                name: "a",
                port: 9000,
                paths: ["/a"],
                health: "/a/health",
                version: "0.1.0",
              },
              {
                name: "b",
                port: 9000,
                paths: ["/b"],
                health: "/b/health",
                version: "0.1.0",
              },
              {
                name: "c",
                port: 9000,
                paths: ["/c"],
                health: "/c/health",
                version: "0.1.0",
              },
            ],
          }),
        );
        expect(() => readManifest(path)).toThrow(/duplicate port 9000/);
      } finally {
        cleanup();
      }
    });
  });

  // Write-time port collision rejection (hub#205). The read-time gate above
  // catches duplicate ports on the next `readManifest`, but without a
  // matching write-side check `upsertService` happily writes a corrupt
  // manifest to disk and only the next read surfaces the fault. A buggy
  // service boot calling `upsertService({ name: "agent", port: 1944 })`
  // while scribe is already at 1944 must fail before `writeManifest` runs.
  // Same multi-vault carve-out applies.
  describe("upsertService duplicate-port rejection (hub#205)", () => {
    const scribe: ServiceEntry = {
      name: "parachute-scribe",
      port: 1944,
      paths: ["/scribe"],
      health: "/scribe/health",
      version: "0.4.0",
    };
    const agent: ServiceEntry = {
      name: "agent",
      port: 1944,
      paths: ["/agent"],
      health: "/agent/health",
      version: "0.1.0",
    };

    test("succeeds when adding a service at a non-conflicting port", () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(scribe, path);
        const m = upsertService({ ...agent, port: 1945 }, path);
        expect(m.services).toHaveLength(2);
        expect(m.services.map((s) => s.port).sort()).toEqual([1944, 1945]);
        // And it actually wrote: a fresh read sees both rows.
        expect(readManifest(path).services).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    test("throws ServicesManifestError when adding a service at a port already claimed by a non-vault service", () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(scribe, path);
        expect(() => upsertService(agent, path)).toThrow(ServicesManifestError);
        // Error names the colliding port and both services so an operator
        // scanning logs knows which two rows to reconcile.
        expect(() => upsertService(agent, path)).toThrow(/duplicate port 1944/);
        expect(() => upsertService(agent, path)).toThrow(/parachute-scribe/);
        expect(() => upsertService(agent, path)).toThrow(/agent/);
        // Crucially: services.json was NOT corrupted on the failed write.
        // The pre-existing row stays, and the agent row never lands.
        const m = readManifest(path);
        expect(m.services).toHaveLength(1);
        expect(m.services[0]?.name).toBe("parachute-scribe");
      } finally {
        cleanup();
      }
    });

    test("succeeds when adding a vault row at a port already used by another vault row (multi-vault carve-out)", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const vaultDefault: ServiceEntry = {
          name: "parachute-vault-default",
          port: 1940,
          paths: ["/vault/default"],
          health: "/vault/default/health",
          version: "0.4.0",
        };
        const vaultTechne: ServiceEntry = {
          name: "parachute-vault-techne",
          port: 1940,
          paths: ["/vault/techne"],
          health: "/vault/techne/health",
          version: "0.4.0",
        };
        upsertService(vaultDefault, path);
        const m = upsertService(vaultTechne, path);
        expect(m.services).toHaveLength(2);
        expect(m.services.map((s) => s.port)).toEqual([1940, 1940]);
        // And persisted: a fresh read sees both vault rows on the same port,
        // confirming readManifest's multi-vault carve-out matches the write
        // side's.
        expect(readManifest(path).services).toHaveLength(2);
      } finally {
        cleanup();
      }
    });

    test("succeeds when UPDATING an existing entry's port to a non-conflicting port", () => {
      // The update path (idx >= 0 in upsertService) replaces the row in-place
      // before the duplicate-port check. Updating an entry's port to a value
      // that collides with a DIFFERENT row must still throw, but moving an
      // entry to a free port must succeed — including off canonical, which is
      // a legitimate operator move (e.g., to dodge a third-party clash).
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(scribe, path); // port 1944
        upsertService({ ...agent, port: 1945 }, path); // port 1945
        // Move scribe from 1944 to 1948 (free): succeeds.
        const m = upsertService({ ...scribe, port: 1948 }, path);
        expect(m.services).toHaveLength(2);
        const scribeRow = m.services.find((s) => s.name === "parachute-scribe");
        expect(scribeRow?.port).toBe(1948);
        // Fresh read: persisted state matches.
        const persisted = readManifest(path);
        expect(persisted.services.find((s) => s.name === "parachute-scribe")?.port).toBe(1948);
      } finally {
        cleanup();
      }
    });

    test("throws when UPDATING an existing entry's port to one that collides with another row", () => {
      // Companion to the above: the update path must NOT bypass the gate
      // when the moved row's new port now collides with a different row.
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(scribe, path); // port 1944
        upsertService({ ...agent, port: 1945 }, path); // port 1945
        // Move scribe to 1945, where agent already lives: must throw.
        expect(() => upsertService({ ...scribe, port: 1945 }, path)).toThrow(ServicesManifestError);
        expect(() => upsertService({ ...scribe, port: 1945 }, path)).toThrow(/duplicate port 1945/);
        // And the on-disk state stayed coherent — scribe at 1944, agent at
        // 1945 — because the gate fires before writeManifest.
        const persisted = readManifest(path);
        expect(persisted.services.find((s) => s.name === "parachute-scribe")?.port).toBe(1944);
        expect(persisted.services.find((s) => s.name === "agent")?.port).toBe(1945);
      } finally {
        cleanup();
      }
    });
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
