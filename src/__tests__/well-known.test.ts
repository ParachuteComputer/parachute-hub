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

  test("SEED placeholder vault entry is NOT fabricated into a vault row (hub#577)", () => {
    // `parachute init` installs the vault MODULE without creating an instance,
    // seeding a services.json entry at version "0.0.0-linked" with the
    // canonical /vault/default mount. That must NOT surface as a phantom
    // `default` vault in the management page.
    const seed: ServiceEntry = { ...vault, version: "0.0.0-linked" };
    const doc = buildWellKnown({
      services: [seed],
      canonicalOrigin: "https://x.example",
    });
    // No phantom vault row...
    expect(doc.vaults).toEqual([]);
    // ...but the services entry stays so the SPA knows the module IS installed
    // (offers "New vault", not "Install module").
    expect(doc.services.map((s) => s.name)).toEqual(["parachute-vault"]);
  });

  test("a REAL (non-seed) vault entry still lands in vaults[] (hub#577 regression guard)", () => {
    const doc = buildWellKnown({
      services: [{ ...vault, version: "0.5.1", paths: ["/vault/techne"] }],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults.map((v) => v.name)).toEqual(["techne"]);
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

  test("uiUrl absent when the resolver returns undefined (API-only service)", () => {
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

  // B4 unified semantics (2026-06-09 hub-module-boundary): relative
  // (no leading slash) = the per-instance form, mount-joined per vault
  // instance; leading-"/" = origin-absolute pass-through. The literal legacy
  // `"/admin/"` on a vault entry rides the one-release COMPAT SHIM
  // (mount-join + deprecation log) because deployed vaults still declare it.
  test("vault RELATIVE uiUrl mount-joins per instance (B4 per-instance form)", () => {
    const doc = buildWellKnown({
      services: [vault],
      canonicalOrigin: "https://x.example",
      uiUrlFor: () => "admin/",
    });
    const svc = doc.services.find((s) => s.name === "parachute-vault");
    expect(svc?.uiUrl).toBe("https://x.example/vault/default/admin/");
  });

  test("vault RELATIVE uiUrl mount-joins per instance for multi-path vault entries", () => {
    const multi: ServiceEntry = { ...vault, paths: ["/vault/default", "/vault/techne"] };
    const doc = buildWellKnown({
      services: [multi],
      canonicalOrigin: "https://x.example",
      uiUrlFor: () => "admin/",
    });
    const rows = doc.services.filter((s) => s.name === "parachute-vault");
    expect(rows.length).toBe(2);
    const uiUrls = rows.map((r) => r.uiUrl).sort();
    expect(uiUrls[0]).toBe("https://x.example/vault/default/admin/");
    expect(uiUrls[1]).toBe("https://x.example/vault/techne/admin/");
  });

  test('COMPAT SHIM: vault legacy "/admin/" uiUrl still mount-joins per instance (one release)', () => {
    // Deployed vaults declare `uiUrl: "/admin/"` (the OLD per-instance form).
    // Origin-absolute resolution would point every tile at the daemon-level
    // /vault/admin mount — so the literal "/admin"/"/admin/" keeps the old
    // mount-join for one release, with a deprecation log. Remove the shim
    // once vault's new manifest ("admin/") reaches @latest.
    const multi: ServiceEntry = { ...vault, paths: ["/vault/default", "/vault/techne"] };
    const doc = buildWellKnown({
      services: [multi],
      canonicalOrigin: "https://x.example",
      uiUrlFor: () => "/admin/",
    });
    const rows = doc.services.filter((s) => s.name === "parachute-vault");
    const uiUrls = rows.map((r) => r.uiUrl).sort();
    expect(uiUrls[0]).toBe("https://x.example/vault/default/admin/");
    expect(uiUrls[1]).toBe("https://x.example/vault/techne/admin/");
  });

  test("vault LEADING-SLASH uiUrl (non-shim) is origin-absolute pass-through (B4)", () => {
    // The daemon-level surface form: `/vault/admin/` resolves against the
    // origin — NOT per-instance — so a multi-path vault emits the same
    // daemon-level URL on each row.
    const multi: ServiceEntry = { ...vault, paths: ["/vault/default", "/vault/techne"] };
    const doc = buildWellKnown({
      services: [multi],
      canonicalOrigin: "https://x.example",
      uiUrlFor: () => "/vault/admin/",
    });
    const rows = doc.services.filter((s) => s.name === "parachute-vault");
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.uiUrl).toBe("https://x.example/vault/admin/");
    }
  });

  test("vault uiUrl absolute URL still passes through verbatim (no prefix)", () => {
    const doc = buildWellKnown({
      services: [vault],
      canonicalOrigin: "https://x.example",
      uiUrlFor: () => "https://vault.example.com/admin",
    });
    const svc = doc.services.find((s) => s.name === "parachute-vault");
    expect(svc?.uiUrl).toBe("https://vault.example.com/admin");
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
      tagline: "Notes PWA — daemon deprecated 2026-05-22; install `app` for the current path.",
    };
    const doc = buildWellKnown({
      services: [notesWithTagline],
      canonicalOrigin: "https://x.example",
    });
    const svc = doc.services.find((s) => s.name === "parachute-notes");
    expect(svc?.tagline).toBe(
      "Notes PWA — daemon deprecated 2026-05-22; install `app` for the current path.",
    );
  });

  test("an empty-paths VAULT row is skipped entirely — no phantom default (#478)", () => {
    // A vault services row with `paths: []` means "module installed but no
    // servable vault instance" (vault's self-register emits this at zero
    // vaults). It must NOT fabricate a vault entry at root in either the
    // `vaults` array or the flat `services` catalog. Mirrors the empty-paths
    // skip in admin-vaults.ts / vault-names.ts / oauth-handlers.ts.
    const entry: ServiceEntry = { ...vault, paths: [] };
    const doc = buildWellKnown({
      services: [entry],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults).toEqual([]);
    // The row contributes nothing to the flat services list either — no
    // phantom `/` mount advertised.
    expect(doc.services).toEqual([]);
  });

  test("positive control: a vault row WITH a path still emits its vault + services entries (#478)", () => {
    const doc = buildWellKnown({
      services: [{ ...vault, paths: ["/vault/default"] }],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.vaults).toEqual([
      {
        name: "default",
        url: "https://x.example/vault/default",
        version: "0.2.4",
      },
    ]);
    expect(doc.services.map((s) => s.name)).toEqual(["parachute-vault"]);
  });

  test("a NON-vault row with empty paths still falls back to / (#478 scope guard)", () => {
    // The empty-paths skip is vault-only. A non-vault service legitimately
    // mounts at root when path-less — that behavior is unchanged.
    const entry: ServiceEntry = { ...notes, paths: [] };
    const doc = buildWellKnown({
      services: [entry],
      canonicalOrigin: "https://x.example",
    });
    expect(doc.services.map((s) => s.path)).toEqual(["/"]);
    expect(doc.notes).toEqual([{ url: "https://x.example/", version: "0.0.1" }]);
  });

  // Hierarchical sub-units (hub#313 — parachute-app design doc §12). Each
  // entry in `s.uis` becomes one record in the well-known shape's
  // `services[].uis` array, with map key promoted to `name` and `path`
  // joined onto the canonical origin into a deep-linkable `url`.
  describe("uis hierarchical sub-units (hub#313)", () => {
    const app: ServiceEntry = {
      name: "parachute-surface",
      port: 1946,
      paths: ["/surface"],
      health: "/surface/healthz",
      version: "0.1.0",
    };

    test("uis map surfaces as services[].uis array with names promoted", () => {
      const withUis: ServiceEntry = {
        ...app,
        uis: {
          "gitcoin-brain": {
            displayName: "Gitcoin Brain",
            path: "/app/gitcoin-brain",
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
      const doc = buildWellKnown({
        services: [withUis],
        canonicalOrigin: "https://x.example",
      });
      const appSvc = doc.services.find((s) => s.name === "parachute-surface");
      expect(appSvc?.uis).toEqual([
        {
          name: "gitcoin-brain",
          displayName: "Gitcoin Brain",
          path: "/app/gitcoin-brain",
          url: "https://x.example/app/gitcoin-brain",
          oauthClientId: "client_abc123",
          status: "active",
        },
        {
          name: "unforced-brain",
          displayName: "Unforced Brain",
          path: "/app/unforced-brain",
          url: "https://x.example/app/unforced-brain",
          oauthClientId: "client_def456",
          status: "pending",
        },
      ]);
    });

    test("absent uis → services entry has no uis field (backwards-compat)", () => {
      // The pre-#313 byte-identical shape for every existing module.
      // Adding the `uis` field to the well-known doc when the parent
      // didn't declare one would break consumers (and force a schema
      // bump on every existing module).
      const doc = buildWellKnown({
        services: [notes, scribe, vault],
        canonicalOrigin: "https://x.example",
      });
      for (const svc of doc.services) {
        expect(svc).not.toHaveProperty("uis");
      }
    });

    test("empty uis map → services entry has no uis field (avoid empty noise)", () => {
      // Per buildWellKnown: an empty map omits the field. The SPA's
      // `mod.uis.length > 0` predicate on the wire side already handles
      // this, but the well-known doc is a public contract so we keep
      // the shape tight.
      const empty: ServiceEntry = { ...app, uis: {} };
      const doc = buildWellKnown({
        services: [empty],
        canonicalOrigin: "https://x.example",
      });
      const svc = doc.services.find((s) => s.name === "parachute-surface");
      expect(svc).not.toHaveProperty("uis");
    });

    test("iconUrl resolves relative path to absolute against canonical origin", () => {
      const withIcon: ServiceEntry = {
        ...app,
        uis: {
          slug: {
            displayName: "Slug",
            path: "/app/slug",
            iconUrl: "/app/slug/icon.svg",
          },
        },
      };
      const doc = buildWellKnown({
        services: [withIcon],
        canonicalOrigin: "https://x.example",
      });
      const svc = doc.services.find((s) => s.name === "parachute-surface");
      expect(svc?.uis?.[0]?.iconUrl).toBe("https://x.example/app/slug/icon.svg");
    });

    test("iconUrl absolute URL passes through verbatim", () => {
      const withIcon: ServiceEntry = {
        ...app,
        uis: {
          slug: {
            displayName: "Slug",
            path: "/app/slug",
            iconUrl: "https://cdn.example.com/icon.svg",
          },
        },
      };
      const doc = buildWellKnown({
        services: [withIcon],
        canonicalOrigin: "https://x.example",
      });
      const svc = doc.services.find((s) => s.name === "parachute-surface");
      expect(svc?.uis?.[0]?.iconUrl).toBe("https://cdn.example.com/icon.svg");
    });

    test("optional fields ride through when present, absent when not", () => {
      const mixed: ServiceEntry = {
        ...app,
        uis: {
          full: {
            displayName: "Full",
            path: "/app/full",
            tagline: "Has it all",
            version: "0.3.1",
            iconUrl: "/i.svg",
            oauthClientId: "c1",
            status: "inactive",
          },
          minimal: { displayName: "Minimal", path: "/app/minimal" },
        },
      };
      const doc = buildWellKnown({
        services: [mixed],
        canonicalOrigin: "https://x.example",
      });
      const svc = doc.services.find((s) => s.name === "parachute-surface");
      const full = svc?.uis?.find((u) => u.name === "full");
      const minimal = svc?.uis?.find((u) => u.name === "minimal");
      expect(full?.tagline).toBe("Has it all");
      expect(full?.version).toBe("0.3.1");
      expect(full?.oauthClientId).toBe("c1");
      expect(full?.status).toBe("inactive");
      // Minimal carries only the required fields — no optional keys.
      expect(minimal).toEqual({
        name: "minimal",
        displayName: "Minimal",
        path: "/app/minimal",
        url: "https://x.example/app/minimal",
      });
    });

    test("multiple modules each carry their own uis", () => {
      const app1: ServiceEntry = {
        ...app,
        uis: { a: { displayName: "A", path: "/app/a" } },
      };
      const app2: ServiceEntry = {
        ...app,
        name: "parachute-app-2",
        port: 1947,
        uis: { b: { displayName: "B", path: "/app-2/b" } },
      };
      const doc = buildWellKnown({
        services: [app1, app2],
        canonicalOrigin: "https://x.example",
      });
      const svc1 = doc.services.find((s) => s.name === "parachute-surface");
      const svc2 = doc.services.find((s) => s.name === "parachute-app-2");
      expect(svc1?.uis?.map((u) => u.name)).toEqual(["a"]);
      expect(svc2?.uis?.map((u) => u.name)).toEqual(["b"]);
    });
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
