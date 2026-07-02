import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckResult, type DoctorDeps, doctor } from "../commands/doctor.ts";
import { writePid } from "../process-state.ts";

/**
 * Doctor tests. The headline is the fresh-install-green guard (#717): a
 * sandboxed PARACHUTE_HOME with a minimal-but-current services.json + a valid
 * operator.token → ALL GREEN, zero WARN/FAIL. Every other test drives ONE
 * failure mode and asserts that check fails while the others stay green.
 *
 * Every external side effect is stubbed through the `deps` seam — no real
 * network probe, no real launchd/systemd query, no touching `~/.parachute`. The
 * only real fs is the sandboxed PARACHUTE_HOME (services.json / operator.token /
 * pidfiles) so the on-disk readers exercise genuine state.
 */

interface Harness {
  configDir: string;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "parachute-doctor-test-"));
  return {
    configDir: dir,
    manifestPath: join(dir, "services.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A minimal-but-current services.json with the canonical vault row. */
function seedCurrentManifest(manifestPath: string): void {
  const services = [
    {
      name: "parachute-vault",
      port: 1940,
      paths: ["/vault/default"],
      health: "/health",
      version: "0.7.4",
    },
  ];
  writeFileSync(manifestPath, JSON.stringify({ services }, null, 2));
}

/** A hand-rolled (unsigned) JWT — doctor DECODES `iss`, never verifies it. */
function fakeOperatorToken(iss: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return [
    b64({ alg: "none", typ: "JWT" }),
    b64({ iss, aud: "operator", sub: "u1", pa_scope_set: "admin" }),
    "sig",
  ].join(".");
}

function seedOperatorToken(configDir: string, iss = "http://127.0.0.1:1939"): void {
  writeFileSync(join(configDir, "operator.token"), `${fakeOperatorToken(iss)}\n`, { mode: 0o600 });
}

/**
 * Deps for a HEALTHY box: hub answers /health, the vault module answers /health,
 * the manager reports active, every bin resolves on PATH, nothing exposed.
 * Individual tests override one field to drive a specific failure.
 */
function healthyDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    probeHubHealth: async () => true,
    probeModuleHealth: async () => true,
    probePublicHealth: async () => true,
    queryHubUnitState: () => ({ state: "active" }),
    // A `which` that resolves everything — so the bin exec-bit check passes
    // without the real module binaries being on the test host's PATH.
    which: (binary) => `/usr/local/bin/${binary}`,
    now: () => new Date("2026-06-27T00:00:00Z"),
    ...over,
  };
}

async function runDoctor(
  h: Harness,
  deps: DoctorDeps,
): Promise<{ code: number; checks: CheckResult[] }> {
  const lines: string[] = [];
  const code = await doctor({
    configDir: h.configDir,
    manifestPath: h.manifestPath,
    print: (l) => lines.push(l),
    json: true,
    deps,
  });
  const payload = JSON.parse(lines.join("\n")) as { checks: CheckResult[] };
  return { code, checks: payload.checks };
}

function byName(checks: CheckResult[], name: string): CheckResult | undefined {
  return checks.find((c) => c.name === name);
}

function expectNoUnexpectedNonPass(checks: CheckResult[], allowedFailing: string[]): void {
  const offenders = checks.filter((c) => c.status !== "pass" && !allowedFailing.includes(c.name));
  if (offenders.length > 0) {
    throw new Error(
      `unexpected non-pass checks: ${offenders.map((c) => `${c.name}=${c.status}`).join(", ")}`,
    );
  }
}

describe("doctor — the fresh-install-green headline guard (#717)", () => {
  test("a minimal-but-current install with a valid operator.token → ALL GREEN, exit 0", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(h, healthyDeps());

      // The load-bearing assertion: not a single WARN or FAIL anywhere.
      const nonPass = checks.filter((c) => c.status !== "pass");
      expect(nonPass.map((c) => `${c.name}=${c.status}`)).toEqual([]);
      expect(checks.every((c) => c.status === "pass")).toBe(true);
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("a brand-new box (no services.json, no operator.token) → ALL GREEN, exit 0", async () => {
    const h = makeHarness();
    try {
      // Nothing seeded at all — the truly-fresh case before `parachute init`.
      const { code, checks } = await runDoctor(h, healthyDeps());
      const nonPass = checks.filter((c) => c.status !== "pass");
      expect(nonPass.map((c) => `${c.name}=${c.status}`)).toEqual([]);
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("an EXPOSED + reachable box stays GREEN", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir, "https://vault.example.com");
      writeFileSync(
        join(h.configDir, "expose-state.json"),
        JSON.stringify({
          version: 1,
          layer: "public",
          mode: "path",
          canonicalFqdn: "vault.example.com",
          port: 1939,
          funnel: true,
          entries: [],
          hubOrigin: "https://vault.example.com",
        }),
      );
      const { code, checks } = await runDoctor(
        h,
        healthyDeps({ probePublicHealth: async () => true }),
      );
      const nonPass = checks.filter((c) => c.status !== "pass");
      expect(nonPass.map((c) => `${c.name}=${c.status}`)).toEqual([]);
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("doctor — failure modes (each detected in isolation; others stay green)", () => {
  test("hub down → hub-reachable FAILs, exit 1, modules check WARNs (not N fails)", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(
        h,
        healthyDeps({
          probeHubHealth: async () => false,
          queryHubUnitState: () => ({ state: "inactive" }),
        }),
      );
      expect(byName(checks, "hub-reachable")?.status).toBe("fail");
      // A down hub → don't pile N module FAILs; surface one WARN pointing at the hub.
      expect(byName(checks, "modules-alive")?.status).toBe("warn");
      expect(code).toBe(1);
      // Everything else stays green.
      expectNoUnexpectedNonPass(checks, ["hub-reachable", "modules-alive"]);
    } finally {
      h.cleanup();
    }
  });

  test("a configured module that doesn't answer /health on a healthy hub → that module FAILs", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(
        h,
        healthyDeps({ probeModuleHealth: async () => false }),
      );
      const mod = byName(checks, "module-alive:vault");
      expect(mod?.status).toBe("fail");
      expect(mod?.fix).toContain("parachute restart vault");
      expect(code).toBe(1);
      expectNoUnexpectedNonPass(checks, ["module-alive:vault"]);
    } finally {
      h.cleanup();
    }
  });

  test("missing operator token → operator-token PASSES (feature-not-configured, NOT a failure)", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      // No operator.token seeded.
      const { code, checks } = await runDoctor(h, healthyDeps());
      expect(byName(checks, "operator-token")?.status).toBe("pass");
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("corrupt operator token (not a JWT) → operator-token FAILs, exit 1", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      writeFileSync(join(h.configDir, "operator.token"), "not-a-jwt\n", { mode: 0o600 });
      const { code, checks } = await runDoctor(h, healthyDeps());
      expect(byName(checks, "operator-token")?.status).toBe("fail");
      expect(byName(checks, "operator-token")?.detail).toContain("decodable");
      expect(code).toBe(1);
      expectNoUnexpectedNonPass(checks, ["operator-token"]);
    } finally {
      h.cleanup();
    }
  });

  test("issuer mismatch (foreign iss) → operator-token FAILs with the 'not signed in' detail", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      // An `iss` that is neither loopback nor any exposed/env origin.
      seedOperatorToken(h.configDir, "https://stale.example.com");
      const { code, checks } = await runDoctor(h, healthyDeps());
      const op = byName(checks, "operator-token");
      expect(op?.status).toBe("fail");
      expect(op?.detail).toContain("not signed in");
      expect(op?.fix).toContain("start hub");
      expect(code).toBe(1);
      expectNoUnexpectedNonPass(checks, ["operator-token"]);
    } finally {
      h.cleanup();
    }
  });

  test("module bin missing the exec bit (100644) → module-bin FAILs with a chmod +x fix", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      // `which` returns null (Bun.which requires X_OK → null on a 100644 bin),
      // and the secondary probe finds the present-but-non-executable file.
      const { code, checks } = await runDoctor(
        h,
        healthyDeps({
          which: () => null,
          findNonExecutable: (binary) => `/usr/local/bin/${binary}`,
        }),
      );
      const bin = byName(checks, "module-bin:vault");
      expect(bin?.status).toBe("fail");
      expect(bin?.detail).toContain("NOT executable");
      expect(bin?.fix).toContain("chmod +x");
      expect(code).toBe(1);
      expectNoUnexpectedNonPass(checks, ["module-bin:vault"]);
    } finally {
      h.cleanup();
    }
  });

  test("module bin genuinely not on PATH → module-bin FAILs with a reinstall fix", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(
        h,
        healthyDeps({ which: () => null, findNonExecutable: () => null }),
      );
      const bin = byName(checks, "module-bin:vault");
      expect(bin?.status).toBe("fail");
      expect(bin?.fix).toContain("parachute install vault");
      expect(code).toBe(1);
      expectNoUnexpectedNonPass(checks, ["module-bin:vault"]);
    } finally {
      h.cleanup();
    }
  });

  test("malformed services.json → services-manifest FAILs, exit 1", async () => {
    const h = makeHarness();
    try {
      // A row missing the required `port` field → strict readManifest throws.
      writeFileSync(
        h.manifestPath,
        JSON.stringify({
          services: [{ name: "parachute-vault", paths: ["/v"], health: "/health", version: "1" }],
        }),
      );
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(h, healthyDeps());
      expect(byName(checks, "services-manifest")?.status).toBe("fail");
      expect(code).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("legacy detached install (hub pidfile present) → migration WARNs, exit STAYS 0", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      // The detached-era fingerprint: a hub pidfile.
      mkdirSync(join(h.configDir, "hub", "run"), { recursive: true });
      writePid("hub", 12345, h.configDir);
      const { code, checks } = await runDoctor(h, healthyDeps());
      expect(byName(checks, "migration-detached")?.status).toBe("warn");
      expect(byName(checks, "migration-detached")?.fix).toContain("--to-supervised");
      // Title must describe the DETECTED condition, not its absence — a warn
      // titled "No legacy detached install" is the title-vs-status bug.
      const detachedTitle = byName(checks, "migration-detached")?.title ?? "";
      expect(detachedTitle.toLowerCase()).toContain("detached");
      expect(detachedTitle).not.toMatch(/^no /i);
      // A WARN is advisory — exit code stays 0.
      expect(code).toBe(0);
      expectNoUnexpectedNonPass(checks, ["migration-detached"]);
    } finally {
      h.cleanup();
    }
  });

  test("known cruft at the ecosystem root → migration WARNs, exit STAYS 0", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      // `server.yaml` is an explicit KNOWN_CRUFT rule (legacy server config).
      writeFileSync(join(h.configDir, "server.yaml"), "legacy: true\n");
      const { code, checks } = await runDoctor(h, healthyDeps());
      expect(byName(checks, "migration-cruft")?.status).toBe("warn");
      expect(byName(checks, "migration-cruft")?.fix).toBe("parachute migrate");
      // Title must describe the DETECTED condition, not its absence.
      const cruftTitle = byName(checks, "migration-cruft")?.title ?? "";
      expect(cruftTitle.toLowerCase()).toContain("cruft");
      expect(cruftTitle).not.toMatch(/^no /i);
      expect(code).toBe(0);
      expectNoUnexpectedNonPass(checks, ["migration-cruft"]);
    } finally {
      h.cleanup();
    }
  });

  test("an UNKNOWN file at the root does NOT trip migration (allowlist, not blocklist)", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      // A file doctor has never heard of — the exact thing #717 forbids flagging.
      writeFileSync(join(h.configDir, "my-own-thing.json"), "{}\n");
      const { code, checks } = await runDoctor(h, healthyDeps());
      // Migration stays a single PASS — no false WARN on the unfamiliar file.
      expect(byName(checks, "migration")?.status).toBe("pass");
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("doctor — Tier 2 exposure (guarded hard)", () => {
  test("not exposed → 'loopback only' is benign info (PASS), not a warning", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      // No expose-state.json — the loopback-only box.
      const { code, checks } = await runDoctor(h, healthyDeps());
      const ex = byName(checks, "exposure");
      expect(ex?.status).toBe("pass");
      expect(ex?.detail).toContain("loopback only");
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("exposed but the public origin doesn't answer → WARN (never FAIL), exit STAYS 0", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir, "https://vault.example.com");
      writeFileSync(
        join(h.configDir, "expose-state.json"),
        JSON.stringify({
          version: 1,
          layer: "public",
          mode: "path",
          canonicalFqdn: "vault.example.com",
          port: 1939,
          funnel: true,
          entries: [],
          hubOrigin: "https://vault.example.com",
        }),
      );
      const { code, checks } = await runDoctor(
        h,
        healthyDeps({ probePublicHealth: async () => false }),
      );
      expect(byName(checks, "exposure")?.status).toBe("warn");
      expect(code).toBe(0);
      expectNoUnexpectedNonPass(checks, ["exposure"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("doctor — version drift (cosmetic; never FAIL)", () => {
  test("a 0.0.0-linked stopgap version → WARN labeled cosmetic, exit STAYS 0", async () => {
    const h = makeHarness();
    try {
      writeFileSync(
        h.manifestPath,
        JSON.stringify({
          services: [
            {
              name: "parachute-vault",
              port: 1940,
              paths: ["/vault/default"],
              health: "/health",
              version: "0.0.0-linked",
            },
          ],
        }),
      );
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(h, healthyDeps());
      const vd = byName(checks, "version-drift");
      expect(vd?.status).toBe("warn");
      expect(vd?.detail).toContain("cosmetic");
      expect(code).toBe(0);
      expectNoUnexpectedNonPass(checks, ["version-drift"]);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical-port-drift detection + `doctor --fix` repair (#267 doctor sub-item)
// ---------------------------------------------------------------------------

/** Write a services.json with the given rows (verbatim — for drift fixtures). */
function writeManifestRows(manifestPath: string, services: unknown[]): void {
  writeFileSync(manifestPath, JSON.stringify({ services }, null, 2));
}

/** Read services.json back as parsed rows for post-fix assertions. */
function readRows(manifestPath: string): Record<string, unknown>[] {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    services: Record<string, unknown>[];
  };
  return parsed.services;
}

/** Run `doctor --fix`, capturing printed lines + exit code. */
async function runFix(
  h: Harness,
  over: Partial<DoctorDeps> = {},
  flags: { yes?: boolean } = {},
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await doctor({
    configDir: h.configDir,
    manifestPath: h.manifestPath,
    print: (l) => lines.push(l),
    fix: true,
    yes: flags.yes ?? false,
    deps: healthyDeps(over),
  });
  return { code, lines };
}

describe("doctor — canonical-port-drift detection (read-only)", () => {
  test("a non-canonical port + a duplicate-port pair → port-drift WARNs naming the services", async () => {
    const h = makeHarness();
    try {
      // scribe drifted off 1943 onto 1944; agent also squats 1944 (a collision).
      writeManifestRows(h.manifestPath, [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/h",
          version: "1",
        },
        { name: "parachute-scribe", port: 1944, paths: ["/scribe"], health: "/h", version: "1" },
        { name: "parachute-agent", port: 1944, paths: ["/agent"], health: "/h", version: "1" },
      ]);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(h, healthyDeps());
      const pd = byName(checks, "port-drift");
      expect(pd?.status).toBe("warn");
      // Names the drifted service AND the colliding pair.
      expect(pd?.detail).toContain("scribe");
      expect(pd?.detail).toContain("1944");
      expect(pd?.detail).toContain("parachute-scribe + parachute-agent");
      expect(pd?.fix).toBe("parachute doctor --fix");
      // Drift is advisory — exit stays 0 (a WARN, not a FAIL). The duplicate
      // rows also trip modules-alive (both can't bind 1944) but that's expected
      // for this fixture; we only assert on port-drift here.
      expect([0, 1]).toContain(code);
    } finally {
      h.cleanup();
    }
  });

  test("a clean file → port-drift PASSES with no drift", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(h, healthyDeps());
      const pd = byName(checks, "port-drift");
      expect(pd?.status).toBe("pass");
      expect(pd?.detail).toContain("canonical");
      expect(code).toBe(0);
      expectNoUnexpectedNonPass(checks, []);
    } finally {
      h.cleanup();
    }
  });

  test("a third-party service with NO canonical port is not flagged", async () => {
    const h = makeHarness();
    try {
      // An unknown module on a non-1939–1949 port — no canonical to drift from.
      writeManifestRows(h.manifestPath, [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/h",
          version: "1",
        },
        { name: "acme-thing", port: 5000, paths: ["/acme"], health: "/h", version: "1" },
      ]);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(h, healthyDeps());
      const pd = byName(checks, "port-drift");
      expect(pd?.status).toBe("pass");
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("a named multi-vault row sharing 1940 is NOT flagged (drift or duplicate)", async () => {
    const h = makeHarness();
    try {
      // A legit multi-vault setup: the canonical vault row plus a second named
      // vault instance, both on 1940 (the documented carve-out). Neither should
      // be flagged as drifted (named vault rows have no canonical port) nor as a
      // duplicate-port collision (all-vault-on-1940 is by design).
      writeManifestRows(h.manifestPath, [
        {
          name: "parachute-vault",
          port: 1940,
          paths: ["/vault/default"],
          health: "/h",
          version: "1",
        },
        {
          name: "parachute-vault-work",
          port: 1940,
          paths: ["/vault/work"],
          health: "/h",
          version: "1",
        },
      ]);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(h, healthyDeps());
      const pd = byName(checks, "port-drift");
      // PASS (clean) — neither flagged as drifted nor as a duplicate collision.
      expect(pd?.status).toBe("pass");
      expect(pd?.detail).toContain("canonical");
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("doctor --fix — canonical-port repair (confirm-gated, idempotent, non-tty-safe)", () => {
  test("--fix on a clean file → 'no drift', exit 0, file unchanged (idempotent)", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      const before = readFileSync(h.manifestPath, "utf8");
      const { code, lines } = await runFix(h, { isInteractive: () => true }, { yes: true });
      expect(code).toBe(0);
      expect(lines.join("\n").toLowerCase()).toContain("nothing to fix");
      expect(readFileSync(h.manifestPath, "utf8")).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  test("--fix on an absent services.json (fresh install) → 'nothing to fix', exit 0", async () => {
    const h = makeHarness();
    try {
      // No services.json at all — the truly-fresh case. --fix must NOT report a
      // corrupt-file error; it's the idempotent no-op path.
      const { code, lines } = await runFix(h, { isInteractive: () => false }, { yes: false });
      expect(code).toBe(0);
      expect(lines.join("\n").toLowerCase()).toContain("nothing to fix");
      expect(lines.join("\n").toLowerCase()).not.toContain("can't read");
    } finally {
      h.cleanup();
    }
  });

  test("--fix --yes rewrites the drifted port to canonical + preserves other fields", async () => {
    const h = makeHarness();
    try {
      // scribe drifted onto 1944; carries an optional displayName/tagline that
      // must survive the rewrite.
      writeManifestRows(h.manifestPath, [
        {
          name: "parachute-scribe",
          port: 1944,
          paths: ["/scribe"],
          health: "/scribe/health",
          version: "0.7.4",
          displayName: "Scribe",
          tagline: "Local audio transcription.",
          stripPrefix: true,
        },
      ]);
      const { code, lines } = await runFix(h, {}, { yes: true });
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain("→ :1943");
      const rows = readRows(h.manifestPath);
      const scribe = rows.find((r) => r.name === "parachute-scribe");
      expect(scribe?.port).toBe(1943);
      // Optional + unknown fields preserved verbatim.
      expect(scribe?.displayName).toBe("Scribe");
      expect(scribe?.tagline).toBe("Local audio transcription.");
      expect(scribe?.stripPrefix).toBe(true);

      // Re-run → idempotent: now clean, exit 0, nothing to fix.
      const again = await runFix(h, {}, { yes: true });
      expect(again.code).toBe(0);
      expect(again.lines.join("\n").toLowerCase()).toContain("nothing to fix");
    } finally {
      h.cleanup();
    }
  });

  test("--fix in a TTY without --yes prompts; 'y' applies the rewrite", async () => {
    const h = makeHarness();
    try {
      writeManifestRows(h.manifestPath, [
        { name: "parachute-scribe", port: 1944, paths: ["/scribe"], health: "/h", version: "1" },
      ]);
      const { code } = await runFix(
        h,
        { isInteractive: () => true, readLine: async () => "y" },
        { yes: false },
      );
      expect(code).toBe(0);
      expect(readRows(h.manifestPath).find((r) => r.name === "parachute-scribe")?.port).toBe(1943);
    } finally {
      h.cleanup();
    }
  });

  test("--fix in a TTY answered 'n' → aborts, exit non-zero, file UNCHANGED", async () => {
    const h = makeHarness();
    try {
      writeManifestRows(h.manifestPath, [
        { name: "parachute-scribe", port: 1944, paths: ["/scribe"], health: "/h", version: "1" },
      ]);
      const before = readFileSync(h.manifestPath, "utf8");
      const { code, lines } = await runFix(
        h,
        { isInteractive: () => true, readLine: async () => "n" },
        { yes: false },
      );
      expect(code).not.toBe(0);
      expect(lines.join("\n").toLowerCase()).toContain("unchanged");
      expect(readFileSync(h.manifestPath, "utf8")).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  test("--fix in a NON-TTY without --yes → bails, exit non-zero, file UNCHANGED", async () => {
    const h = makeHarness();
    try {
      writeManifestRows(h.manifestPath, [
        { name: "parachute-scribe", port: 1944, paths: ["/scribe"], health: "/h", version: "1" },
      ]);
      const before = readFileSync(h.manifestPath, "utf8");
      const { code, lines } = await runFix(h, { isInteractive: () => false }, { yes: false });
      expect(code).not.toBe(0);
      expect(lines.join("\n")).toContain("--yes");
      // The load-bearing guarantee: no write happened.
      expect(readFileSync(h.manifestPath, "utf8")).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  test("--fix reports a duplicate-port collision but does not auto-resolve it", async () => {
    const h = makeHarness();
    try {
      // Two services collide on 1944; neither is on its canonical slot. The
      // diff fixes the canonical drift; the collision is reported, not guessed.
      writeManifestRows(h.manifestPath, [
        { name: "parachute-scribe", port: 1944, paths: ["/scribe"], health: "/h", version: "1" },
        { name: "parachute-agent", port: 1944, paths: ["/agent"], health: "/h", version: "1" },
      ]);
      const { code, lines } = await runFix(h, {}, { yes: true });
      const text = lines.join("\n");
      expect(text.toLowerCase()).toContain("shared by");
      expect(text).toContain("parachute-scribe + parachute-agent");
      // scribe → 1943 and agent → 1941 are both off 1944, so after the rewrite
      // they no longer collide; fix applied, exit 0.
      expect(code).toBe(0);
      const rows = readRows(h.manifestPath);
      expect(rows.find((r) => r.name === "parachute-scribe")?.port).toBe(1943);
      expect(rows.find((r) => r.name === "parachute-agent")?.port).toBe(1941);
    } finally {
      h.cleanup();
    }
  });
});

describe("doctor — loopback-hijack check (hub#737)", () => {
  test("no hub-instance.json → PASS (benign; the Hub check owns 'down') — #717", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      // No instance file seeded, no seams overridden — defaults read the empty
      // sandbox and short-circuit before any real network/lsof.
      const { code, checks } = await runDoctor(h, healthyDeps());
      expect(byName(checks, "loopback-hijack")?.status).toBe("pass");
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("loopback nonce matches ours + single listener → PASS", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(
        h,
        healthyDeps({
          readInstanceRecord: () => ({ instance: "n1", pid: 1, port: 1939, startedAt: "" }),
          probeLoopbackInstance: async () => ({ reachable: true, status: 200, instance: "n1" }),
          countHubListeners: () => 1,
        }),
      );
      const c = byName(checks, "loopback-hijack");
      expect(c?.status).toBe("pass");
      expect(c?.detail).toContain("instance nonce");
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("loopback nonce MISMATCH → FAIL with lsof/orb remediation + incident ref", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(
        h,
        healthyDeps({
          readInstanceRecord: () => ({ instance: "ours", pid: 1, port: 1939, startedAt: "" }),
          probeLoopbackInstance: async () => ({
            reachable: true,
            status: 200,
            instance: "rogue-hub",
          }),
          countHubListeners: () => 2,
        }),
      );
      const c = byName(checks, "loopback-hijack");
      expect(c?.status).toBe("fail");
      expect(c?.detail).toContain("rogue-hub");
      expect(c?.detail).toContain("2 listeners");
      expect(c?.detail).toContain("hub#737");
      expect(c?.fix).toContain("lsof -nP -iTCP:1939 -sTCP:LISTEN");
      expect(c?.fix).toContain("orb list");
      expect(code).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("foreign process answering with NO nonce → FAIL (the OrbStack container-hub shape)", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { checks } = await runDoctor(
        h,
        healthyDeps({
          readInstanceRecord: () => ({ instance: "ours", pid: 1, port: 1939, startedAt: "" }),
          probeLoopbackInstance: async () => ({ reachable: true, status: 200 }),
          countHubListeners: () => undefined, // lsof indeterminate — still FAILs on the nonce alone
        }),
      );
      const c = byName(checks, "loopback-hijack");
      expect(c?.status).toBe("fail");
      expect(c?.detail).toContain("foreign process");
    } finally {
      h.cleanup();
    }
  });

  test("nonce matches but a SECOND listener exists → WARN (latent shadow, not FAIL)", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { code, checks } = await runDoctor(
        h,
        healthyDeps({
          readInstanceRecord: () => ({ instance: "n1", pid: 1, port: 1939, startedAt: "" }),
          probeLoopbackInstance: async () => ({ reachable: true, status: 200, instance: "n1" }),
          countHubListeners: () => 2,
        }),
      );
      const c = byName(checks, "loopback-hijack");
      expect(c?.status).toBe("warn");
      expect(c?.detail).toContain("2 listeners");
      // WARN never fails the exit code.
      expect(code).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("record present but loopback unreachable → PASS (defers to the Hub check)", async () => {
    const h = makeHarness();
    try {
      seedCurrentManifest(h.manifestPath);
      seedOperatorToken(h.configDir);
      const { checks } = await runDoctor(
        h,
        healthyDeps({
          readInstanceRecord: () => ({ instance: "n1", pid: 1, port: 1939, startedAt: "" }),
          probeLoopbackInstance: async () => ({ reachable: false }),
        }),
      );
      expect(byName(checks, "loopback-hijack")?.status).toBe("pass");
    } finally {
      h.cleanup();
    }
  });
});
