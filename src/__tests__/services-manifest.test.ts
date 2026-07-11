import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RETIRED_MODULES } from "../service-spec.ts";
import {
  type ServiceEntry,
  ServicesManifestError,
  type UiSubUnit,
  clearStartError,
  findService,
  readManifest,
  readManifestLenient,
  recordStartError,
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

  // Hierarchical sub-units (hub#313). parachute-app registers as a single
  // module row with a `uis` map; each entry surfaces as a discoverable
  // sub-row under the App module in hub's discovery surfaces. Schema is
  // purely additive — pre-#313 flat entries (vault / scribe / notes /
  // runner) round-trip byte-identically.
  describe("ServiceEntry.uis hierarchical sub-units (hub#313)", () => {
    const app: ServiceEntry = {
      name: "parachute-surface",
      port: 1946,
      paths: ["/surface"],
      health: "/surface/healthz",
      version: "0.1.0",
    };

    test("round-trips a fully-populated uis map", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const full: ServiceEntry = {
          ...app,
          uis: {
            "gitcoin-brain": {
              displayName: "Gitcoin Brain",
              tagline: "Reading room for the Gitcoin team's vault.",
              path: "/app/gitcoin-brain",
              iconUrl: "/app/gitcoin-brain/icon.svg",
              version: "0.3.1",
              oauthClientId: "client_abc123",
              status: "active",
            },
            "unforced-brain": {
              displayName: "Unforced Brain",
              path: "/app/unforced-brain",
              oauthClientId: "client_def456",
              status: "pending",
            },
          },
        };
        upsertService(full, path);
        expect(readManifest(path).services[0]).toEqual(full);
      } finally {
        cleanup();
      }
    });

    test("absent uis round-trips as absent — backwards-compat for flat entries", () => {
      // Vault / scribe / notes / runner all ship without `uis` today.
      // The schema must round-trip them byte-identically so the post-#313
      // services.json shape is a strict superset of the pre-#313 shape.
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(vault, path);
        const got = readManifest(path).services[0];
        expect(got).toEqual(vault);
        expect(got).not.toHaveProperty("uis");
      } finally {
        cleanup();
      }
    });

    test("empty uis map round-trips as empty (not omitted)", () => {
      // An app with no UIs yet is a distinct state from "doesn't support
      // UIs" — preserve it so the SPA can render "no UIs installed yet"
      // distinctly from "this isn't a UI-host module."
      const { path, cleanup } = makeTempPath();
      try {
        const empty: ServiceEntry = { ...app, uis: {} };
        upsertService(empty, path);
        expect(readManifest(path).services[0]).toEqual(empty);
      } finally {
        cleanup();
      }
    });

    test("minimal sub-unit — displayName + path only — accepted", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const minimal: ServiceEntry = {
          ...app,
          uis: {
            slug: { displayName: "Slug", path: "/app/slug" },
          },
        };
        upsertService(minimal, path);
        expect(readManifest(path).services[0]).toEqual(minimal);
      } finally {
        cleanup();
      }
    });

    test("rejects uis that isn't an object", () => {
      const { path, cleanup } = makeTempPath();
      try {
        expect(() =>
          upsertService({ ...app, uis: [] as unknown as Record<string, never> }, path),
        ).toThrow(/"uis" must be an object map/);
      } finally {
        cleanup();
      }
    });

    test("rejects sub-unit missing displayName", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const bad: ServiceEntry = {
          ...app,
          uis: {
            slug: { path: "/app/slug" } as unknown as UiSubUnit,
          },
        };
        expect(() => upsertService(bad, path)).toThrow(/displayName/);
      } finally {
        cleanup();
      }
    });

    test("rejects sub-unit missing path", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const bad: ServiceEntry = {
          ...app,
          uis: {
            slug: { displayName: "Slug" } as unknown as UiSubUnit,
          },
        };
        expect(() => upsertService(bad, path)).toThrow(/"path"/);
      } finally {
        cleanup();
      }
    });

    test("rejects sub-unit path not starting with /", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const bad: ServiceEntry = {
          ...app,
          uis: { slug: { displayName: "S", path: "app/slug" } },
        };
        expect(() => upsertService(bad, path)).toThrow(/"path"/);
      } finally {
        cleanup();
      }
    });

    test("rejects invalid status value", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const bad: ServiceEntry = {
          ...app,
          uis: {
            slug: {
              displayName: "S",
              path: "/app/s",
              status: "weird" as unknown as "active",
            },
          },
        };
        expect(() => upsertService(bad, path)).toThrow(/status/);
      } finally {
        cleanup();
      }
    });

    test("normalizes legacy `pending-oauth` → `pending` on read (workstream F back-compat)", () => {
      // Pre-F services may still write the legacy alias. The schema
      // accepts it on read + normalizes to the canonical vocab so
      // downstream emit surfaces (well-known, /api/modules, SPA) always
      // see the canonical form. Retire after the next rc-chain alias
      // window per design-system.md §6.
      const { path, cleanup } = makeTempPath();
      try {
        const legacy: ServiceEntry = {
          ...app,
          uis: {
            slug: {
              displayName: "S",
              path: "/app/s",
              // biome-ignore lint/suspicious/noExplicitAny: deliberately
              // writing the pre-F legacy alias to pin the normalization
              // boundary; the schema accepts it on read.
              status: "pending-oauth" as any,
            },
          },
        };
        upsertService(legacy, path);
        const got = readManifest(path).services[0]?.uis?.slug;
        expect(got?.status).toBe("pending");
      } finally {
        cleanup();
      }
    });

    test("normalizes legacy `disabled` → `inactive` on read (workstream F back-compat)", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const legacy: ServiceEntry = {
          ...app,
          uis: {
            slug: {
              displayName: "S",
              path: "/app/s",
              // biome-ignore lint/suspicious/noExplicitAny: same as above.
              status: "disabled" as any,
            },
          },
        };
        upsertService(legacy, path);
        const got = readManifest(path).services[0]?.uis?.slug;
        expect(got?.status).toBe("inactive");
      } finally {
        cleanup();
      }
    });

    test("accepts new canonical states (`failing`, `inactive`)", () => {
      // `failing` is new in workstream F (no pre-F equivalent — pre-F
      // collapsed failing into `disabled`). `inactive` is the new
      // canonical name for `disabled`. Both must validate.
      const { path, cleanup } = makeTempPath();
      try {
        const entry: ServiceEntry = {
          ...app,
          uis: {
            f: { displayName: "F", path: "/app/f", status: "failing" },
            i: { displayName: "I", path: "/app/i", status: "inactive" },
          },
        };
        upsertService(entry, path);
        const got = readManifest(path).services[0]?.uis;
        expect(got?.f?.status).toBe("failing");
        expect(got?.i?.status).toBe("inactive");
      } finally {
        cleanup();
      }
    });

    test("rejects non-string oauthClientId", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const bad: ServiceEntry = {
          ...app,
          uis: {
            slug: {
              displayName: "S",
              path: "/app/s",
              oauthClientId: 42 as unknown as string,
            },
          },
        };
        expect(() => upsertService(bad, path)).toThrow(/oauthClientId/);
      } finally {
        cleanup();
      }
    });

    test("rejects empty-string key in uis map", () => {
      const { path, cleanup } = makeTempPath();
      try {
        writeFileSync(
          path,
          JSON.stringify({
            services: [
              {
                ...app,
                uis: {
                  "": { displayName: "S", path: "/app/s" },
                },
              },
            ],
          }),
        );
        expect(() => readManifest(path)).toThrow(/"uis" keys/);
      } finally {
        cleanup();
      }
    });

    test("error message names the offending sub-unit key", () => {
      // Multiple sub-units in the same entry — the error should pinpoint
      // which slug carries the bad shape so an operator with N rows can
      // jump straight to the offender.
      const { path, cleanup } = makeTempPath();
      try {
        writeFileSync(
          path,
          JSON.stringify({
            services: [
              {
                ...app,
                uis: {
                  good: { displayName: "Good", path: "/app/good" },
                  "bad-one": { displayName: "Bad", path: "no-leading-slash" },
                },
              },
            ],
          }),
        );
        expect(() => readManifest(path)).toThrow(/bad-one/);
      } finally {
        cleanup();
      }
    });
  });

  // Duplicate-port detection (hub#195). The original collision had
  // parachute-scribe and a third-party service both at 1944 in services.json
  // with no operator-visible warning. The OS lets only one service bind, the
  // hub reverse-proxy quietly routes everyone to whoever won the race, and
  // requests silently land on the wrong service. Reject at parse time so the
  // same shape can't recur silently. Underlying overwrite bugs were fixed in
  // parachute-scribe#41; this is the hub-side gate.
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
                name: "someapp",
                port: 1944,
                paths: ["/someapp"],
                health: "/someapp/health",
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
                name: "someapp",
                port: 1944,
                paths: ["/someapp"],
                health: "/someapp/health",
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
        expect(() => readManifest(path)).toThrow(/someapp/);
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
  // service boot calling `upsertService({ name: "someapp", port: 1944 })`
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
    const someapp: ServiceEntry = {
      name: "someapp",
      port: 1944,
      paths: ["/someapp"],
      health: "/someapp/health",
      version: "0.1.0",
    };

    test("succeeds when adding a service at a non-conflicting port", () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(scribe, path);
        const m = upsertService({ ...someapp, port: 1945 }, path);
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
        expect(() => upsertService(someapp, path)).toThrow(ServicesManifestError);
        // Error names the colliding port and both services so an operator
        // scanning logs knows which two rows to reconcile.
        expect(() => upsertService(someapp, path)).toThrow(/duplicate port 1944/);
        expect(() => upsertService(someapp, path)).toThrow(/parachute-scribe/);
        expect(() => upsertService(someapp, path)).toThrow(/someapp/);
        // Crucially: services.json was NOT corrupted on the failed write.
        // The pre-existing row stays, and the someapp row never lands.
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
        upsertService({ ...someapp, port: 1945 }, path); // port 1945
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
        upsertService({ ...someapp, port: 1945 }, path); // port 1945
        // Move scribe to 1945, where someapp already lives: must throw.
        expect(() => upsertService({ ...scribe, port: 1945 }, path)).toThrow(ServicesManifestError);
        expect(() => upsertService({ ...scribe, port: 1945 }, path)).toThrow(/duplicate port 1945/);
        // And the on-disk state stayed coherent — scribe at 1944, someapp at
        // 1945 — because the gate fires before writeManifest.
        const persisted = readManifest(path);
        expect(persisted.services.find((s) => s.name === "parachute-scribe")?.port).toBe(1944);
        expect(persisted.services.find((s) => s.name === "someapp")?.port).toBe(1945);
      } finally {
        cleanup();
      }
    });
  });
});

describe("claw → agent migration", () => {
  // Paraclaw was renamed to parachute-agent across the ecosystem (npm
  // package, mount path, short name). The migration was a transitional
  // read-time rewrite that aliased legacy `name: "claw"` rows to
  // `name: "agent"` so operators on the old shape kept routing.
  //
  // History: parachute-agent (the Claude-in-containers module) was retired
  // 2026-05-20 (hub#334 added `agent` to RETIRED_MODULES), which briefly made
  // this a one-step retirement path (claw → agent → GC'd). The 2026-06-17
  // channel→agent rename RE-ASSIGNED `agent`/`parachute-agent` to the renamed
  // channel module, so those names left RETIRED_MODULES — `agent` is a live
  // module again. The claw → agent rewrite still runs; the migrated row now
  // PERSISTS (it routes to the live agent module). The tests below assert the
  // rewrite + the persistence.
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
      // Migration ran in this read (claw → agent on raw entries), then
      // the row was rewritten to disk. Post the 2026-06-17 channel→agent
      // rename, `agent` is once again a LIVE module (the renamed channel
      // module), so it is NO LONGER GC'd by RETIRED_MODULES — the migrated
      // row persists and routes to the live agent module's mount.
      expect(got.services).toEqual([agent]);
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

  test("the migrated agent row PERSISTS on the next read (agent is live again post-rename)", () => {
    // Pre-rename this was a one-step retirement path (claw → agent → GC'd).
    // After the channel→agent rename (2026-06-17) `agent`/`parachute-agent`
    // are re-assigned to the live module, so the row is NOT dropped — a
    // stale paraclaw row now ends up pointing at the live agent module
    // (harmless / arguably correct, since paraclaw was the original "agent").
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, `${JSON.stringify({ services: [claw] }, null, 2)}\n`);
      const first = readManifest(path);
      expect(first.services).toEqual([agent]);
      const second = readManifest(path);
      expect(second.services).toEqual([agent]);
    } finally {
      cleanup();
    }
  });

  test("an already-agent entry round-trips unchanged (agent live again post-rename)", () => {
    // Pre-hub#334 this verified the migration was idempotent; hub#334 made it
    // GC the agent row (agent was retired). After the channel→agent rename
    // (2026-06-17) agent is live again, so the row round-trips unchanged —
    // back to the original idempotent behavior.
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, `${JSON.stringify({ services: [agent] }, null, 2)}\n`);
      const got = readManifest(path);
      expect(got.services).toEqual([agent]);
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
      // First read: claw migrates to agent (retired GC didn't see `claw`
      // on the way in). Vault + scribe round-trip unchanged.
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

// Legacy short-name row cleanup (the parachute-app#13 + parachute-runner#4
// self-register fixup, surfaced 2026-05-22 when Aaron's services.json
// carried both `parachute-app` (hub-stamped) and `app` (legacy
// self-register) at port 1946 and the duplicate-port read gate refused to
// boot the file). Hub auto-heals on read: drops the legacy short-name row
// when a same-port `parachute-<short>` row is present, then rewrites the
// file so the next read is clean.
describe("legacy short-name row de-dupe (parachute-app#13 / runner#4)", () => {
  test("drops the short-name row when a same-port manifestName row exists", () => {
    // Fixture uses `surface` (the ACTUAL short-name twin of `parachute-surface`
    // per the structural rule: b.name === `parachute-${a.name}`) rather than
    // `app`. Pre-hub-parity-P5 this test used `app` here, but that only
    // passed because `app` was ALSO in RETIRED_MODULES at the time — the
    // unconditional retired-module GC (not this structural short-name rule)
    // was doing the dropping. Now that `app`/`parachute-app` are un-retired
    // (hub-parity P5, a new unrelated module claims them), this fixture is
    // corrected to actually exercise `dropLegacyShortNameRows`.
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: "parachute-surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0",
            },
            {
              name: "surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0",
            },
          ],
        }),
      );
      const m = readManifest(path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]?.name).toBe("parachute-surface");
    } finally {
      cleanup();
    }
  });

  test("rewrites services.json on disk after de-dupe so the next read is clean", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: "parachute-runner",
              port: 1945,
              paths: ["/runner"],
              health: "/runner/healthz",
              version: "0.1.5",
            },
            {
              name: "runner",
              port: 1945,
              paths: ["/runner"],
              health: "/runner/healthz",
              version: "0.1.5",
            },
          ],
        }),
      );
      readManifest(path);
      // The on-disk file no longer contains the duplicate — a fresh
      // reader (one that didn't go through the de-dupe path) sees the
      // clean shape.
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk.services).toHaveLength(1);
      expect(onDisk.services[0].name).toBe("parachute-runner");
    } finally {
      cleanup();
    }
  });

  test("leaves a lone short-name row alone (no same-port manifestName twin)", () => {
    // Operators on an old self-register that never got the manifestName
    // write keep working — the row is non-duplicated, hub just renders
    // them under the legacy name. Auto-rewriting standalone short-name
    // rows would surprise operators who hand-edit services.json on
    // purpose; we only intervene when the duplicate breaks reads.
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: "widget",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0",
            },
          ],
        }),
      );
      const m = readManifest(path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]?.name).toBe("widget");
    } finally {
      cleanup();
    }
  });

  test("leaves a deliberate third-party short-name row alone (different port from any parachute-X)", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: "parachute-surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0",
            },
            {
              name: "widget",
              port: 9999,
              paths: ["/widget"],
              health: "/widget/health",
              version: "1.0.0",
            },
          ],
        }),
      );
      const m = readManifest(path);
      expect(m.services).toHaveLength(2);
      expect(m.services.map((s) => s.name).sort()).toEqual(["parachute-surface", "widget"]);
    } finally {
      cleanup();
    }
  });

  test("does not drop parachute-X when paired with a non-matching, non-retired short-name", () => {
    // The legacy-short-name heuristic is narrow: only drop short-name
    // rows whose name is exactly the suffix of a same-port
    // `parachute-<short>` row. A collision between e.g. `parachute-app`
    // and an unrelated third-party `unknownmod` doesn't match the
    // shape — it's a separate problem with its own duplicate-port error.
    // (Aaron's ambient `parachute-app` + `agent` case is now handled
    // upstream by `dropRetiredModuleRows`; see the retired-module
    // suite below.)
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: "parachute-surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0",
            },
            {
              name: "unknownmod",
              port: 1946,
              paths: ["/unknownmod"],
              health: "/unknownmod/health",
              version: "0.1.4",
            },
          ],
        }),
      );
      // Both rows pass through the de-dupe; validation then catches the
      // duplicate-port collision and throws. Operators on this shape
      // resolve it by removing the colliding row manually.
      expect(() => readManifest(path)).toThrow(/duplicate port 1946/);
    } finally {
      cleanup();
    }
  });

  test("idempotent — second read leaves the cleaned file alone", () => {
    // See the fixture note on the first test in this describe block — `app`
    // is renamed to `surface` here for the same reason (un-retired 2026-07-11,
    // hub-parity P5).
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: "parachute-surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0",
            },
            {
              name: "surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0",
            },
          ],
        }),
      );
      readManifest(path);
      const mtimeAfterFirstRead = statSync(path).mtimeMs;
      // Brief no-op gate: a second read should not rewrite the file. We
      // assert on the post-mtime equality after a synchronous re-read.
      readManifest(path);
      expect(statSync(path).mtimeMs).toBe(mtimeAfterFirstRead);
    } finally {
      cleanup();
    }
  });
});

// Retired-module row cleanup (hub#334 — Aaron's actual reproducer on
// 2026-05-22). His services.json originally carried a stale `agent` row at
// 1946 colliding with `parachute-app`'s canonical slot. The legacy-short-name
// de-dupe doesn't help — a retired short isn't the short-name twin of the
// colliding row. The retired-module GC fires unconditionally on rows whose
// name appears in `RETIRED_MODULES`, regardless of port collision.
//
// NOTE (2026-07-11, hub-parity P5): the original fixtures used `agent` —
// which was a RETIRED_MODULES entry until the 2026-06-17 channel→agent
// rename re-assigned that name to the live (renamed-from-channel) module —
// and were later updated to use `app` (parachute-app, retired 2026-05-27).
// `app`/`parachute-app` are now THEMSELVES un-retired (a new, unrelated
// module — the real parachute-app super-surface — claims the name for
// real; see service-spec.ts's RETIRED_MODULES comment). So these tests now
// inject a throwaway synthetic retired entry via a describe-scoped
// beforeEach/afterEach rather than depending on production RETIRED_MODULES
// having a spare non-live name to spend on test fixtures — this mechanism
// has now been renamed out from under these tests twice.
describe("retired-module row de-dupe (hub#334)", () => {
  const RETIRED_FIXTURE_NAME = "legacy-test-retired-module";

  beforeEach(() => {
    RETIRED_MODULES[RETIRED_FIXTURE_NAME] = {
      retiredAt: "2020-01-01",
      replacement: "n/a — test-only fixture, not a real retirement",
    };
  });

  afterEach(() => {
    delete RETIRED_MODULES[RETIRED_FIXTURE_NAME];
  });

  test("drops a row whose name is in RETIRED_MODULES", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: RETIRED_FIXTURE_NAME,
              port: 1946,
              paths: ["/legacy"],
              health: "/legacy/health",
              version: "0.1.4",
            },
          ],
        }),
      );
      const m = readManifest(path);
      expect(m.services).toHaveLength(0);
      // The on-disk file is rewritten clean too.
      const onDisk = JSON.parse(readFileSync(path, "utf8"));
      expect(onDisk.services).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("retirement is unconditional — no other rows required", () => {
    // Verifies dropRetiredModuleRows doesn't depend on a collision
    // partner (unlike dropLegacyShortNameRows). A retired row sitting
    // alone is still stale.
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: RETIRED_FIXTURE_NAME,
              port: 9999,
              paths: ["/legacy"],
              health: "/legacy/health",
              version: "0.1.4",
            },
          ],
        }),
      );
      const m = readManifest(path);
      expect(m.services).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("no-op when services.json has no retired rows", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: "parachute-surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0",
            },
          ],
        }),
      );
      const mtimeBefore = statSync(path).mtimeMs;
      const m = readManifest(path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]?.name).toBe("parachute-surface");
      // No rewrite when there's nothing to clean.
      expect(statSync(path).mtimeMs).toBe(mtimeBefore);
    } finally {
      cleanup();
    }
  });

  test("Aaron's reproducer — retired row + parachute-surface at same port resolves cleanly", () => {
    // The motivating bug for hub#334. With dropRetiredModuleRows running
    // before validateManifest, the stale retired row is GC'd and the
    // duplicate-port gate doesn't trip downstream.
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: RETIRED_FIXTURE_NAME,
              port: 1946,
              paths: ["/legacy"],
              health: "/legacy/health",
              version: "0.1.4",
            },
            {
              name: "parachute-surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0",
            },
          ],
        }),
      );
      const m = readManifest(path);
      expect(m.services).toHaveLength(1);
      expect(m.services[0]?.name).toBe("parachute-surface");
    } finally {
      cleanup();
    }
  });

  test("interaction — retired row + legacy short-name pair both cleaned, correct order", () => {
    // Drop order matters: retired-module cleanup runs first, then
    // legacy-short-name cleanup. This test ensures both passes compose
    // correctly on a services.json that exercises both shapes
    // simultaneously. The retired-fixture row is unconditional retire; the
    // parachute-runner + runner pair triggers legacy-short-name dedup at
    // port 1945.
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: RETIRED_FIXTURE_NAME,
              port: 1946,
              paths: ["/legacy"],
              health: "/legacy/health",
              version: "0.1.4",
            },
            {
              name: "parachute-runner",
              port: 1945,
              paths: ["/runner"],
              health: "/runner/healthz",
              version: "0.1.5",
            },
            {
              name: "runner",
              port: 1945,
              paths: ["/runner"],
              health: "/runner/healthz",
              version: "0.1.5",
            },
          ],
        }),
      );
      const m = readManifest(path);
      const names = m.services.map((s) => s.name).sort();
      expect(names).toEqual(["parachute-runner"]);
    } finally {
      cleanup();
    }
  });
});

describe("readManifestLenient — skips bad entries instead of throwing (hub#406)", () => {
  test("returns the healthy entries when one row has port=0 (the rc.4 app bug)", () => {
    // Reproduces what hub saw 2026-05-26: a fresh deploy installed
    // @openparachute/app@0.2.0-rc.4 which wrote a row with name="app"
    // (wrong) + port=0 (wrong). Strict readManifest threw on the bad
    // entry — every request to every service 500'd, not just app.
    // Lenient reader skips the bad row + keeps routing healthy ones.
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/default"],
              health: "/vault/default/health",
              version: "0.4.8-rc.10",
            },
            {
              name: "parachute-surface",
              port: 1946,
              paths: ["/surface"],
              health: "/surface/healthz",
              version: "0.2.0-rc.13",
            },
            {
              name: "widget",
              port: 0,
              paths: ["/widget"],
              health: "/widget/health",
              version: "0.0.1",
            },
          ],
        }),
      );
      const warnings: string[] = [];
      const log = { warn: (m: string) => warnings.push(m) };
      const m = readManifestLenient(path, log);
      const names = m.services.map((s) => s.name).sort();
      expect(names).toEqual(["parachute-surface", "parachute-vault"]);
      expect(warnings.some((w) => w.includes("port") && w.includes("integer"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("returns empty services when the file is malformed JSON, logs the parse error", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(path, "{not valid json");
      const warnings: string[] = [];
      const m = readManifestLenient(path, { warn: (msg) => warnings.push(msg) });
      expect(m.services).toEqual([]);
      expect(warnings.some((w) => w.includes("failed to parse"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("returns empty services when the file is missing", () => {
    const { path, cleanup } = makeTempPath();
    try {
      // path not yet written
      const m = readManifestLenient(path, { warn: () => {} });
      expect(m.services).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("drops duplicate-port entries with a warning instead of throwing", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            { name: "first", port: 1940, paths: ["/x"], health: "/x/health", version: "1.0.0" },
            { name: "second", port: 1940, paths: ["/y"], health: "/y/health", version: "1.0.0" },
          ],
        }),
      );
      const warnings: string[] = [];
      const m = readManifestLenient(path, { warn: (msg) => warnings.push(msg) });
      expect(m.services).toHaveLength(1);
      expect(m.services[0]?.name).toBe("first");
      expect(warnings.some((w) => w.includes("duplicate-port"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("strict readManifest still throws on the same bad entry (contract preserved)", () => {
    const { path, cleanup } = makeTempPath();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          services: [
            {
              name: "widget",
              port: 0,
              paths: ["/widget"],
              health: "/widget/health",
              version: "0.0.1",
            },
          ],
        }),
      );
      expect(() => readManifest(path)).toThrow(ServicesManifestError);
    } finally {
      cleanup();
    }
  });

  describe("lastStartError", () => {
    const wire = {
      error_type: "missing_dependency",
      error_description: "parachute-vault is required ...",
      binary: "parachute-vault",
      why: "run the Vault module Hub supervises",
      docs_url: "https://parachute.computer",
      install: { generic: "parachute install vault" },
      sysadmin_hint: "Or ask your system administrator to install it for you.",
    };

    test("recordStartError persists the wire + stamps `at`", () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(vault, path);
        recordStartError("parachute-vault", wire, path);
        const entry = readManifest(path).services.find((s) => s.name === "parachute-vault");
        expect(entry?.lastStartError?.error_type).toBe("missing_dependency");
        expect(entry?.lastStartError?.binary).toBe("parachute-vault");
        expect(entry?.lastStartError?.install?.generic).toBe("parachute install vault");
        expect(entry?.lastStartError?.at).toBeDefined();
      } finally {
        cleanup();
      }
    });

    test("recordStartError is a no-op when the row is absent", () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(vault, path);
        recordStartError("parachute-scribe", wire, path);
        const scribe = readManifest(path).services.find((s) => s.name === "parachute-scribe");
        expect(scribe).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    test("clearStartError removes a recorded error", () => {
      const { path, cleanup } = makeTempPath();
      try {
        upsertService(vault, path);
        recordStartError("parachute-vault", wire, path);
        clearStartError("parachute-vault", path);
        const entry = readManifest(path).services.find((s) => s.name === "parachute-vault");
        expect(entry?.lastStartError).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    test("lastStartError round-trips through validation", () => {
      const { path, cleanup } = makeTempPath();
      try {
        const withErr: ServiceEntry = {
          ...vault,
          lastStartError: { ...wire, at: "2026-05-29T00:00:00Z" },
        };
        upsertService(withErr, path);
        const entry = readManifest(path).services.find((s) => s.name === "parachute-vault");
        expect(entry?.lastStartError).toEqual({ ...wire, at: "2026-05-29T00:00:00Z" });
      } finally {
        cleanup();
      }
    });

    test("a malformed lastStartError is dropped, not thrown (diagnostic field)", () => {
      const { path, cleanup } = makeTempPath();
      try {
        writeFileSync(
          path,
          JSON.stringify({
            services: [
              {
                ...vault,
                // missing error_description → invalid shape → dropped
                lastStartError: { error_type: "missing_dependency" },
              },
            ],
          }),
        );
        const entry = readManifest(path).services.find((s) => s.name === "parachute-vault");
        expect(entry).toBeDefined();
        expect(entry?.lastStartError).toBeUndefined();
      } finally {
        cleanup();
      }
    });
  });
});
