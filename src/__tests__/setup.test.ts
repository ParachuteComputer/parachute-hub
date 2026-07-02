import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallOpts } from "../commands/install.ts";
import { isOfferable, parseServicePicks, setup } from "../commands/setup.ts";
import { upsertService } from "../services-manifest.ts";

interface InstallCall {
  short: string;
  opts: InstallOpts;
}

interface Harness {
  manifestPath: string;
  configDir: string;
  logs: string[];
  calls: InstallCall[];
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pcli-setup-"));
  const logs: string[] = [];
  const calls: InstallCall[] = [];
  return {
    manifestPath: join(dir, "services.json"),
    configDir: dir,
    logs,
    calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function scriptedAvailability(answers: string[]) {
  const queue = [...answers];
  return {
    kind: "available" as const,
    prompt: async (_q: string) => {
      const next = queue.shift();
      if (next === undefined) throw new Error("scripted prompt exhausted");
      return next;
    },
    remaining: () => queue.length,
  };
}

const offered = [
  // The exact ServiceChoice shape used internally; we only need the surface
  // parseServicePicks reads — the export accepts the live structure.
  {
    short: "vault",
    installed: false,
    manifestName: "parachute-vault",
    spec: { manifestName: "parachute-vault" } as never,
  },
  {
    short: "notes",
    installed: false,
    manifestName: "parachute-notes",
    spec: { manifestName: "parachute-notes" } as never,
  },
  {
    short: "scribe",
    installed: false,
    manifestName: "parachute-scribe",
    spec: { manifestName: "parachute-scribe" } as never,
  },
];

describe("parseServicePicks", () => {
  test("empty input picks every offered service", () => {
    const result = parseServicePicks("", offered);
    if ("error" in result) throw new Error(result.error);
    expect(result.picks.map((p) => p.short)).toEqual(["vault", "notes", "scribe"]);
  });

  test("'all' picks every offered service", () => {
    const result = parseServicePicks("all", offered);
    if ("error" in result) throw new Error(result.error);
    expect(result.picks.map((p) => p.short)).toEqual(["vault", "notes", "scribe"]);
  });

  test("numeric indices", () => {
    const result = parseServicePicks("1, 3", offered);
    if ("error" in result) throw new Error(result.error);
    expect(result.picks.map((p) => p.short)).toEqual(["vault", "scribe"]);
  });

  test("shortnames", () => {
    const result = parseServicePicks("vault scribe", offered);
    if ("error" in result) throw new Error(result.error);
    expect(result.picks.map((p) => p.short)).toEqual(["vault", "scribe"]);
  });

  test("dedupes repeated picks", () => {
    const result = parseServicePicks("1, vault, 1", offered);
    if ("error" in result) throw new Error(result.error);
    expect(result.picks.map((p) => p.short)).toEqual(["vault"]);
  });

  test("out-of-range index errors", () => {
    const result = parseServicePicks("9", offered);
    expect("error" in result && result.error).toMatch(/out-of-range/);
  });

  test("unknown name errors", () => {
    const result = parseServicePicks("nope", offered);
    expect("error" in result && result.error).toMatch(/unknown service/);
  });
});

describe("isOfferable (fresh-install OFFER, 2026-06-25)", () => {
  test("offers an uninstalled core/experimental module", () => {
    expect(isOfferable({ short: "vault", installed: false })).toBe(true);
    expect(isOfferable({ short: "scribe", installed: false })).toBe(true);
    expect(isOfferable({ short: "surface", installed: false })).toBe(true);
    // agent stays a legit experimental preview — still offered.
    expect(isOfferable({ short: "agent", installed: false })).toBe(true);
  });

  test("does NOT offer a deprecated module (notes) on a fresh install", () => {
    expect(isOfferable({ short: "notes", installed: false })).toBe(false);
    // runner is stronger than deprecated now: it left the registries entirely
    // (2026-07-01), so it never reaches the survey → isOfferable never sees
    // it. (The bare predicate would say true for an unknown short — the OFFER
    // gate for runner is `knownServices()` no longer containing it.)
  });

  test("never offers an already-installed module regardless of tier", () => {
    expect(isOfferable({ short: "vault", installed: true })).toBe(false);
    expect(isOfferable({ short: "notes", installed: true })).toBe(false);
  });
});

describe("setup", () => {
  test("exits 0 with friendly note when every known service is installed", async () => {
    const h = makeHarness();
    try {
      // Pre-seed every first-party shortname so survey returns all-installed.
      // Distinct canonical ports per service — services-manifest.ts now
      // rejects duplicate ports between distinct services (hub#195).
      // parachute-runner rides along as a LEGACY row (runner left the
      // registries 2026-07-01): it must neither block the all-installed exit
      // nor crash the survey.
      const seeds: Array<{ name: string; port: number }> = [
        { name: "parachute-vault", port: 1940 },
        { name: "parachute-notes", port: 1942 },
        { name: "parachute-scribe", port: 1943 },
        { name: "parachute-agent", port: 1941 },
        { name: "parachute-runner", port: 1945 },
        { name: "parachute-surface", port: 1946 },
      ];
      for (const s of seeds) {
        upsertService(
          {
            name: s.name,
            version: "0.0.0",
            port: s.port,
            paths: [`/${s.name.replace(/^parachute-/, "")}`],
            health: "/health",
          },
          h.manifestPath,
        );
      }
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability: { kind: "not-tty" },
        installFn: async (short, opts) => {
          h.calls.push({ short, opts });
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(h.calls).toHaveLength(0);
      expect(h.logs.join("\n")).toMatch(/All known services are already installed/);
    } finally {
      h.cleanup();
    }
  });

  test("fresh box: the offered 'Available to install' list excludes deprecated notes + removed runner", async () => {
    const h = makeHarness();
    try {
      // 'all' picks every OFFERED service. With a clean services.json the survey
      // sees every known short; the offered filter must drop notes (deprecated,
      // 2026-06-25) while runner never even reaches the survey (registry
      // removal, 2026-07-01) — keeping vault/scribe/surface/agent. Only vault +
      // scribe have pre-install follow-up prompts (vault name, scribe provider);
      // surface + agent have none — so the scripted answers below are complete.
      const availability = scriptedAvailability([
        "all", // pick everything offered
        "default", // vault name (vault is in the offered set)
        "1", // scribe provider
      ]);
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability,
        installFn: async (short, opts) => {
          h.calls.push({ short, opts });
          return 0;
        },
      });
      expect(code).toBe(0);
      // The "Available to install" banner must NOT list notes / runner.
      const joined = h.logs.join("\n");
      const availableBlock = joined.slice(joined.indexOf("Available to install:"));
      expect(availableBlock).not.toMatch(/\bnotes\b/);
      expect(availableBlock).not.toMatch(/\brunner\b/);
      // …and `install()` is never invoked for the deprecated shorts.
      const installedShorts = h.calls.map((c) => c.short);
      expect(installedShorts).not.toContain("notes");
      expect(installedShorts).not.toContain("runner");
      // The non-deprecated set is still offered + installed.
      expect(installedShorts).toContain("vault");
      expect(installedShorts).toContain("scribe");
      expect(installedShorts).toContain("surface");
      expect(installedShorts).toContain("agent");
    } finally {
      h.cleanup();
    }
  });

  test("an already-installed deprecated module still shows in 'Already installed' + isn't re-offered (back-compat)", async () => {
    const h = makeHarness();
    try {
      // Legacy operator with notes-daemon (deprecated) on disk. It must surface
      // in the "Already installed" banner (so they know it's there + can manage
      // it via `parachute <verb> notes`), and must NOT reappear in the
      // fresh-install OFFER list.
      upsertService(
        {
          name: "parachute-notes",
          version: "0.3.15",
          port: 1942,
          paths: ["/notes"],
          health: "/notes/health",
        },
        h.manifestPath,
      );
      const availability = scriptedAvailability([
        "surface", // pick a still-offered module
      ]);
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability,
        installFn: async (short, opts) => {
          h.calls.push({ short, opts });
          return 0;
        },
      });
      expect(code).toBe(0);
      const joined = h.logs.join("\n");
      // Banner lists notes as already installed…
      const installedBlock = joined.slice(
        joined.indexOf("Already installed:"),
        joined.indexOf("Available to install:"),
      );
      expect(installedBlock).toMatch(/\bnotes\b/);
      // …but notes is NOT in the fresh-install offer.
      const availableBlock = joined.slice(joined.indexOf("Available to install:"));
      expect(availableBlock).not.toMatch(/\bnotes\b/);
      expect(h.calls.map((c) => c.short)).not.toContain("notes");
    } finally {
      h.cleanup();
    }
  });

  test("a LEGACY parachute-runner row doesn't break setup and is never offered (registry removal 2026-07-01)", async () => {
    const h = makeHarness();
    try {
      // runner left the registries entirely — the survey no longer knows the
      // short, so the row is simply invisible to setup (not in "Already
      // installed", not in the offer). The load-bearing assertions: setup
      // still runs to completion and never tries to install runner.
      upsertService(
        {
          name: "parachute-runner",
          version: "0.2.0",
          port: 1945,
          paths: ["/runner"],
          health: "/runner/healthz",
        },
        h.manifestPath,
      );
      const availability = scriptedAvailability([
        "surface", // pick a still-offered module
      ]);
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability,
        installFn: async (short, opts) => {
          h.calls.push({ short, opts });
          return 0;
        },
      });
      expect(code).toBe(0);
      const joined = h.logs.join("\n");
      const availableBlock = joined.slice(joined.indexOf("Available to install:"));
      expect(availableBlock).not.toMatch(/\brunner\b/);
      expect(h.calls.map((c) => c.short)).not.toContain("runner");
      expect(h.calls.map((c) => c.short)).toContain("surface");
    } finally {
      h.cleanup();
    }
  });

  test("rejects non-TTY when there's work to offer", async () => {
    const h = makeHarness();
    try {
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability: { kind: "not-tty" },
        installFn: async () => 0,
      });
      expect(code).toBe(1);
      expect(h.logs.join("\n")).toMatch(/needs a TTY/);
    } finally {
      h.cleanup();
    }
  });

  test("happy path: pick vault + scribe; threads vaultName + scribe answers to install()", async () => {
    const h = makeHarness();
    try {
      const availability = scriptedAvailability([
        "vault, scribe", // multi-select
        "myvault", // vault name
        "1", // scribe provider (parakeet-mlx)
      ]);
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability,
        installFn: async (short, opts) => {
          h.calls.push({ short, opts });
          // Simulate install registering the service so the summary banner finds it.
          const manifestName =
            short === "vault"
              ? "parachute-vault"
              : short === "scribe"
                ? "parachute-scribe"
                : `parachute-${short}`;
          const port = short === "vault" ? 1940 : 1941;
          upsertService(
            { name: manifestName, version: "0.1.0", port, paths: [`/${short}`], health: "/health" },
            opts.manifestPath ?? h.manifestPath,
          );
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(h.calls.map((c) => c.short)).toEqual(["vault", "scribe"]);
      const vaultCall = h.calls.find((c) => c.short === "vault");
      const scribeCall = h.calls.find((c) => c.short === "scribe");
      expect(vaultCall?.opts.vaultName).toBe("myvault");
      expect(scribeCall?.opts.scribeProvider).toBe("parakeet-mlx");
      expect(scribeCall?.opts.scribeKey).toBeUndefined();
      expect(availability.remaining()).toBe(0);
      expect(h.logs.join("\n")).toMatch(/Setup complete/);
    } finally {
      h.cleanup();
    }
  });

  test("threads --tag and --no-start to every install()", async () => {
    const h = makeHarness();
    try {
      const availability = scriptedAvailability([
        // surface — a non-deprecated module with no follow-up prompts. (notes,
        // the prior pick, is now `deprecated` → not in the offered set.)
        "surface",
      ]);
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability,
        installFn: async (short, opts) => {
          h.calls.push({ short, opts });
          upsertService(
            {
              name: "parachute-surface",
              version: "0.1.0",
              port: 1946,
              paths: ["/surface"],
              health: "/health",
            },
            opts.manifestPath ?? h.manifestPath,
          );
          return 0;
        },
        tag: "rc",
        noStart: true,
      });
      expect(code).toBe(0);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.opts.tag).toBe("rc");
      expect(h.calls[0]?.opts.noStart).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("partial failure: later picks still run; exit code reflects first failure", async () => {
    const h = makeHarness();
    try {
      const availability = scriptedAvailability([
        // surface replaces the prior `notes` pick (now deprecated → not offered).
        "vault, surface", // multi-select
        "default", // vault name
      ]);
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability,
        installFn: async (short, opts) => {
          h.calls.push({ short, opts });
          if (short === "vault") return 7; // fail vault
          upsertService(
            {
              name: "parachute-surface",
              version: "0.1.0",
              port: 1946,
              paths: ["/surface"],
              health: "/health",
            },
            opts.manifestPath ?? h.manifestPath,
          );
          return 0;
        },
      });
      expect(code).toBe(7);
      expect(h.calls.map((c) => c.short)).toEqual(["vault", "surface"]);
      expect(h.logs.join("\n")).toMatch(/non-zero exit code/);
    } finally {
      h.cleanup();
    }
  });

  test("retries pick prompt on invalid token then accepts a valid one (#111)", async () => {
    const h = makeHarness();
    try {
      const availability = scriptedAvailability([
        "9", // out-of-range index — loop re-prompts
        "nope", // unknown name — loop re-prompts again
        // surface — a non-deprecated single pick with no follow-up prompts.
        "surface",
      ]);
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability,
        installFn: async (short, opts) => {
          h.calls.push({ short, opts });
          upsertService(
            {
              name: "parachute-surface",
              version: "0.1.0",
              port: 1946,
              paths: ["/surface"],
              health: "/health",
            },
            opts.manifestPath ?? h.manifestPath,
          );
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(h.calls.map((c) => c.short)).toEqual(["surface"]);
      expect(availability.remaining()).toBe(0);
      const joined = h.logs.join("\n");
      expect(joined).toMatch(/out-of-range/);
      expect(joined).toMatch(/unknown service/);
    } finally {
      h.cleanup();
    }
  });

  test("retries on invalid vault name then accepts a valid one", async () => {
    const h = makeHarness();
    try {
      const availability = scriptedAvailability([
        "vault",
        "Bad Name!", // rejected
        "good-vault", // accepted
      ]);
      const code = await setup({
        manifestPath: h.manifestPath,
        configDir: h.configDir,
        log: (l) => h.logs.push(l),
        availability,
        installFn: async (short, opts) => {
          h.calls.push({ short, opts });
          upsertService(
            {
              name: "parachute-vault",
              version: "0.1.0",
              port: 1940,
              paths: ["/vault"],
              health: "/health",
            },
            opts.manifestPath ?? h.manifestPath,
          );
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(h.calls[0]?.opts.vaultName).toBe("good-vault");
      expect(h.logs.join("\n")).toMatch(/invalid name "Bad Name!"/);
    } finally {
      h.cleanup();
    }
  });
});
