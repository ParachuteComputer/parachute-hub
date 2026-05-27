import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallOpts } from "../commands/install.ts";
import { parseServicePicks, setup } from "../commands/setup.ts";
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

describe("setup", () => {
  test("exits 0 with friendly note when every known service is installed", async () => {
    const h = makeHarness();
    try {
      // Pre-seed every first-party shortname so survey returns all-installed.
      // Distinct canonical ports per service — services-manifest.ts now
      // rejects duplicate ports between distinct services (hub#195).
      const seeds: Array<{ name: string; port: number }> = [
        { name: "parachute-vault", port: 1940 },
        { name: "parachute-notes", port: 1942 },
        { name: "parachute-scribe", port: 1943 },
        { name: "parachute-channel", port: 1941 },
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
        "notes", // single pick — no follow-up prompts
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
              name: "parachute-notes",
              version: "0.1.0",
              port: 1942,
              paths: ["/notes"],
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
        "vault, notes", // multi-select
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
              name: "parachute-notes",
              version: "0.1.0",
              port: 1942,
              paths: ["/notes"],
              health: "/health",
            },
            opts.manifestPath ?? h.manifestPath,
          );
          return 0;
        },
      });
      expect(code).toBe(7);
      expect(h.calls.map((c) => c.short)).toEqual(["vault", "notes"]);
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
        "notes", // single pick, no follow-up prompts
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
              name: "parachute-notes",
              version: "0.1.0",
              port: 1942,
              paths: ["/notes"],
              health: "/health",
            },
            opts.manifestPath ?? h.manifestPath,
          );
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(h.calls.map((c) => c.short)).toEqual(["notes"]);
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
