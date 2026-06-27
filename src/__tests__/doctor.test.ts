import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
