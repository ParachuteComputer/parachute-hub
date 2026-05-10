import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceEntry } from "../services-manifest.ts";
import {
  buildWellKnown,
  isVaultEntry,
  shortName,
  vaultInstanceName,
  writeWellKnownFile,
} from "../well-known.ts";

const vault: ServiceEntry = {
  name: "parachute-vault",
  port: 1940,
  paths: ["/vault/default"],
  health: "/vault/default/health",
  version: "0.2.4",
};

const notes: ServiceEntry = {
  name: "parachute-notes",
  port: 5173,
  paths: ["/notes"],
  health: "/notes/health",
  version: "0.0.1",
};

const scribe: ServiceEntry = {
  name: "parachute-scribe",
  port: 3200,
  paths: ["/scribe"],
  health: "/scribe/health",
  version: "0.1.0",
};

describe("shortName", () => {
  test("strips parachute- prefix", () => {
    expect(shortName("parachute-vault")).toBe("vault");
    expect(shortName("parachute-notes")).toBe("notes");
    expect(shortName("custom-service")).toBe("custom-service");
  });
});

describe("isVaultEntry", () => {
  test("matches bare parachute-vault", () => {
    expect(isVaultEntry(vault)).toBe(true);
  });

  test("matches prefixed vault instances", () => {
    expect(isVaultEntry({ ...vault, name: "parachute-vault-work" })).toBe(true);
    expect(isVaultEntry({ ...vault, name: "parachute-vault-personal" })).toBe(true);
  });

  test("rejects non-vault services", () => {
    expect(isVaultEntry(notes)).toBe(false);
    expect(isVaultEntry(scribe)).toBe(false);
  });

  test("does not match an unrelated name that merely starts with parachute-vaultish", () => {
    expect(isVaultEntry({ ...vault, name: "parachute-vaultkeeper" })).toBe(false);
  });
});

describe("vaultInstanceName", () => {
  test("prefers /vault/<name> path segment", () => {
    expect(vaultInstanceName({ ...vault, paths: ["/vault/work"] })).toBe("work");
    expect(vaultInstanceName({ ...vault, paths: ["/vault/default"] })).toBe("default");
  });

  test("falls back to manifest-name suffix when path is non-vault", () => {
    expect(vaultInstanceName({ ...vault, name: "parachute-vault-personal", paths: ["/"] })).toBe(
      "personal",
    );
  });

  test("defaults to 'default' when nothing else matches", () => {
    expect(vaultInstanceName({ ...vault, paths: ["/"] })).toBe("default");
    expect(vaultInstanceName({ ...vault, paths: [] })).toBe("default");
  });

  test("path wins over name suffix", () => {
    expect(
      vaultInstanceName({
        ...vault,
        name: "parachute-vault-work",
        paths: ["/vault/override"],
      }),
    ).toBe("override");
  });
});

describe("buildWellKnown", () => {
  test("every kind is a plural array; services[] includes all (#92)", () => {
    const doc = buildWellKnown({
      services: [vault, notes, scribe],
      canonicalOrigin: "https://parachute.taildf9ce2.ts.net",
    });
    expect(doc.vaults).toEqual([
      {
        name: "default",
        url: "https://parachute.taildf9ce2.ts.net/vault/default",
        version: "0.2.4",
      },
    ]);
    expect(doc.notes).toEqual([
      {
        url: "https://parachute.taildf9ce2.ts.net/notes",
        version: "0.0.1",
      },
    ]);
    expect(doc.scribe).toEqual([
      {
        url: "https://parachute.taildf9ce2.ts.net/scribe",
        version: "0.1.0",
      },
    ]);
    expect(doc.services.map((s) => s.name)).toEqual([
      "parachute-vault",
      "parachute-notes",
      "parachute-scribe",
    ]);
  });

  test("multiple installs of the same kind both land in the array (#92)", () => {
    const work: ServiceEntry = { ...notes, paths: ["/notes-work"], port: 5174 };
    const doc = buildWellKnown({
      services: [notes, work],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.notes).toEqual([
      { url: "https://x.example/notes", version: "0.0.1" },
      { url: "https://x.example/notes-work", version: "0.0.1" },
    ]);
  });

  test("services[] entries include infoUrl pointing at /.parachute/info", () => {
    const doc = buildWellKnown({
      services: [vault, notes],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.services).toEqual([
      {
        name: "parachute-vault",
        url: "https://x.example/vault/default",
        path: "/vault/default",
        version: "0.2.4",
        infoUrl: "https://x.example/vault/default/.parachute/info",
      },
      {
        name: "parachute-notes",
        url: "https://x.example/notes",
        path: "/notes",
        version: "0.0.1",
        infoUrl: "https://x.example/notes/.parachute/info",
      },
    ]);
  });

  test("infoUrl for root-mounted service has no double slash", () => {
    const rootSvc: ServiceEntry = { ...notes, paths: ["/"] };
    const doc = buildWellKnown({
      services: [rootSvc],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.services[0]?.infoUrl).toBe("https://x.example/.parachute/info");
  });

  test("vaults array is present even when no vault is installed", () => {
    const doc = buildWellKnown({
      services: [notes],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults).toEqual([]);
    expect(doc.services).toHaveLength(1);
    expect(doc.notes).toEqual([{ url: "https://x.example/notes", version: "0.0.1" }]);
  });

  test("multiple vault instances all land in the vaults array", () => {
    const work: ServiceEntry = {
      ...vault,
      name: "parachute-vault-work",
      paths: ["/vault/work"],
      port: 1941,
      version: "0.2.4",
    };
    const doc = buildWellKnown({
      services: [vault, work],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults).toHaveLength(2);
    expect(doc.vaults.map((v) => v.name).sort()).toEqual(["default", "work"]);
  });

  test("single vault ServiceEntry with multiple paths emits one entry per path (closes #141)", () => {
    // Reflects the post-#179/vault#208 manifest shape: one parachute-vault
    // backend hosts every vault instance, expressed as one ServiceEntry with
    // multiple paths.
    const multi: ServiceEntry = {
      ...vault,
      paths: ["/vault/default", "/vault/techne"],
    };
    const doc = buildWellKnown({
      services: [multi],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults).toEqual([
      { name: "default", url: "https://x.example/vault/default", version: "0.2.4" },
      { name: "techne", url: "https://x.example/vault/techne", version: "0.2.4" },
    ]);
    // services[] mirrors the per-path expansion so the hub page and any
    // generic consumer iterate every instance.
    expect(doc.services).toEqual([
      {
        name: "parachute-vault",
        url: "https://x.example/vault/default",
        path: "/vault/default",
        version: "0.2.4",
        infoUrl: "https://x.example/vault/default/.parachute/info",
      },
      {
        name: "parachute-vault",
        url: "https://x.example/vault/techne",
        path: "/vault/techne",
        version: "0.2.4",
        infoUrl: "https://x.example/vault/techne/.parachute/info",
      },
    ]);
  });

  test("multi-path vault entry is independent of multi-ServiceEntry shape (#141)", () => {
    // A user could plausibly mix shapes: one multi-path bare `parachute-vault`
    // plus a separately-installed `parachute-vault-archive`. All instances
    // should surface.
    const multi: ServiceEntry = {
      ...vault,
      paths: ["/vault/default", "/vault/techne"],
    };
    const archive: ServiceEntry = {
      ...vault,
      name: "parachute-vault-archive",
      paths: ["/vault/archive"],
      port: 1942,
    };
    const doc = buildWellKnown({
      services: [multi, archive],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults.map((v) => v.name).sort()).toEqual(["archive", "default", "techne"]);
  });

  test("handles canonicalOrigin with trailing slash", () => {
    const doc = buildWellKnown({
      services: [vault],
      canonicalOrigin: "https://parachute.taildf9ce2.ts.net/",
    });
    expect(doc.vaults[0]?.url).toBe("https://parachute.taildf9ce2.ts.net/vault/default");
  });

  test("managementUrl rides through when the resolver returns one", () => {
    const doc = buildWellKnown({
      services: [vault],
      canonicalOrigin: "https://x.example",
      managementUrlFor: () => "/admin",
    });
    expect(doc.vaults[0]?.managementUrl).toBe("/admin");
  });

  test("managementUrl absent when the resolver returns undefined", () => {
    const doc = buildWellKnown({
      services: [vault],
      canonicalOrigin: "https://x.example",
      managementUrlFor: () => undefined,
    });
    expect(doc.vaults[0]).not.toHaveProperty("managementUrl");
  });

  test("managementUrl is per-entry — multi-instance vaults can differ", () => {
    const work: ServiceEntry = {
      ...vault,
      name: "parachute-vault-work",
      paths: ["/vault/work"],
      port: 1941,
    };
    const doc = buildWellKnown({
      services: [vault, work],
      canonicalOrigin: "https://x.example",
      managementUrlFor: (e) => (e.name === "parachute-vault-work" ? "/admin" : undefined),
    });
    const byName = new Map(doc.vaults.map((v) => [v.name, v.managementUrl]));
    expect(byName.get("default")).toBeUndefined();
    expect(byName.get("work")).toBe("/admin");
  });

  test("managementUrl is not emitted on non-vault services", () => {
    const doc = buildWellKnown({
      services: [notes],
      canonicalOrigin: "https://x.example",
      managementUrlFor: () => "/admin",
    });
    expect(doc.notes).toEqual([{ url: "https://x.example/notes", version: "0.0.1" }]);
  });

  // Phase D consumer-side: services entries surface uiUrl + displayName +
  // tagline so the discovery page can render data-driven Service tiles.
  test("uiUrl resolver result rides into doc.services entry as absolute URL", () => {
    const doc = buildWellKnown({
      services: [notes],
      canonicalOrigin: "https://x.example",
      uiUrlFor: () => "/notes",
    });
    const svc = doc.services.find((s) => s.name === "parachute-notes");
    expect(svc?.uiUrl).toBe("https://x.example/notes");
  });

  test("uiUrl absolute URL passes through verbatim", () => {
    const doc = buildWellKnown({
      services: [notes],
      canonicalOrigin: "https://x.example",
      uiUrlFor: () => "https://notes.example.com/app",
    });
    const svc = doc.services.find((s) => s.name === "parachute-notes");
    expect(svc?.uiUrl).toBe("https://notes.example.com/app");
  });

  test("uiUrl absent when the resolver returns undefined (vault case)", () => {
    const doc = buildWellKnown({
      services: [vault, notes],
      canonicalOrigin: "https://x.example",
      uiUrlFor: (e) => (e.name === "parachute-notes" ? "/notes" : undefined),
    });
    const vaultSvc = doc.services.find((s) => s.name === "parachute-vault");
    const notesSvc = doc.services.find((s) => s.name === "parachute-notes");
    expect(vaultSvc).not.toHaveProperty("uiUrl");
    expect(notesSvc?.uiUrl).toBe("https://x.example/notes");
  });

  test("displayName resolver overrides services.json displayName", () => {
    const notesWithName: ServiceEntry = { ...notes, displayName: "FromServicesJson" };
    const doc = buildWellKnown({
      services: [notesWithName],
      canonicalOrigin: "https://x.example",
      displayNameFor: () => "FromModuleJson",
    });
    const svc = doc.services.find((s) => s.name === "parachute-notes");
    expect(svc?.displayName).toBe("FromModuleJson");
  });

  test("displayName falls back to services.json when resolver returns undefined", () => {
    const notesWithName: ServiceEntry = { ...notes, displayName: "FromServicesJson" };
    const doc = buildWellKnown({
      services: [notesWithName],
      canonicalOrigin: "https://x.example",
      displayNameFor: () => undefined,
    });
    const svc = doc.services.find((s) => s.name === "parachute-notes");
    expect(svc?.displayName).toBe("FromServicesJson");
  });

  test("tagline rides through from services.json (no resolver needed)", () => {
    const notesWithTagline: ServiceEntry = {
      ...notes,
      tagline: "Notes PWA backed by your vault.",
    };
    const doc = buildWellKnown({
      services: [notesWithTagline],
      canonicalOrigin: "https://x.example",
    });
    const svc = doc.services.find((s) => s.name === "parachute-notes");
    expect(svc?.tagline).toBe("Notes PWA backed by your vault.");
  });

  test("falls back to / for empty paths", () => {
    const entry: ServiceEntry = { ...vault, paths: [] };
    const doc = buildWellKnown({
      services: [entry],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults[0]?.url).toBe("https://x.example/");
  });
});

describe("writeWellKnownFile", () => {
  test("writes pretty JSON and creates nested directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcli-wk-"));
    try {
      const path = join(dir, "nested", "parachute.json");
      const doc = buildWellKnown({
        services: [vault],
        canonicalOrigin: "https://x.example",
      });
      writeWellKnownFile(doc, path);
      const round = JSON.parse(readFileSync(path, "utf8"));
      expect(round).toEqual(doc);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
