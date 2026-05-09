import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignPort, assignServicePort } from "../port-assign.ts";
import { CANONICAL_PORT_MAX, CANONICAL_PORT_MIN } from "../service-spec.ts";

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-port-assign-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("assignPort (pure)", () => {
  test("returns the canonical slot when free", () => {
    const result = assignPort(1940, []);
    expect(result.port).toBe(1940);
    expect(result.source).toBe("canonical");
    expect(result.warning).toBeUndefined();
  });

  test("returns canonical even when other unrelated ports are taken", () => {
    const result = assignPort(1940, [1939, 1942, 1943, 5173]);
    expect(result.port).toBe(1940);
    expect(result.source).toBe("canonical");
  });

  test("walks the unassigned reservation range when canonical is occupied", () => {
    // 1940 is taken; canonical reserved range starts at 1944 → first hit.
    const result = assignPort(1940, [1940]);
    expect(result.port).toBe(1944);
    expect(result.source).toBe("fallback-in-range");
    expect(result.warning).toMatch(/canonical port 1940 is in use/);
    expect(result.warning).toMatch(/1944/);
  });

  test("skips reservations that are also occupied", () => {
    // Canonical 1940 + the first three reserved slots are all in use.
    const result = assignPort(1940, [1940, 1944, 1945, 1946]);
    expect(result.port).toBe(1947);
    expect(result.source).toBe("fallback-in-range");
  });

  test("falls outside the range with a warning when reservations are exhausted", () => {
    const occupied = [];
    for (let p = CANONICAL_PORT_MIN; p <= CANONICAL_PORT_MAX; p++) occupied.push(p);
    const result = assignPort(1940, occupied);
    expect(result.port).toBe(CANONICAL_PORT_MAX + 1);
    expect(result.source).toBe("fallback-out-of-range");
    expect(result.warning).toMatch(/canonical range/);
    expect(result.warning).toMatch(/1950/);
    expect(result.warning).toMatch(/may conflict/);
  });

  test("walks past out-of-range collisions too", () => {
    const occupied = [];
    for (let p = CANONICAL_PORT_MIN; p <= CANONICAL_PORT_MAX + 2; p++) occupied.push(p);
    const result = assignPort(1940, occupied);
    expect(result.port).toBe(CANONICAL_PORT_MAX + 3);
    expect(result.source).toBe("fallback-out-of-range");
  });

  test("third-party (no canonical slot) jumps straight to the reservation range", () => {
    const result = assignPort(undefined, []);
    expect(result.port).toBe(1944);
    expect(result.source).toBe("fallback-in-range");
    expect(result.warning).toMatch(/no canonical slot/);
    expect(result.warning).toMatch(/1944/);
  });

  test("third-party with reservations occupied walks further in the range", () => {
    const result = assignPort(undefined, [1944, 1945]);
    expect(result.port).toBe(1946);
    expect(result.source).toBe("fallback-in-range");
  });
});

describe("assignServicePort (hub#206 — services.json is authoritative)", () => {
  // Post-hub#206 assignServicePort is a thin wrapper over assignPort: the
  // install path no longer touches the service's .env, since services.json
  // is the single source of truth and the duplicate state caused drift on
  // re-install. These tests pin the new contract:
  //   1. The function returns the assigned port + source/warning.
  //   2. It does not write to .env. Pre-existing .env files are untouched
  //      (no PORT line added, no PORT line removed, no other lines mutated).
  //   3. There's no "preserved" source — a stale .env PORT does NOT survive
  //      a re-install (operators edit services.json now).

  test("returns canonical when free, does not touch .env", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const envPath = join(dir, "subdir", ".env");
      const result = assignServicePort({
        canonical: 1940,
        occupied: [],
      });
      expect(result.port).toBe(1940);
      expect(result.source).toBe("canonical");
      expect(result.warning).toBeUndefined();
      // No .env file gets created — subdir doesn't even exist.
      expect(existsSync(envPath)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("does NOT preserve a pre-existing PORT in .env (services.json is authoritative)", () => {
    // Pre-hub#206 a stale `.env` PORT survived a re-install — operators
    // editing services.json would get re-stamped by the .env. Post-#206
    // services.json wins; the .env PORT is ignored at install time and
    // also at boot (per the 4-tier ladder in scribe/agent).
    const { dir, cleanup } = makeTempDir();
    try {
      const envPath = join(dir, ".env");
      const before = "PORT=1944\nOTHER=keepme\n";
      writeFileSync(envPath, before);
      const result = assignServicePort({
        canonical: 1940,
        occupied: [],
      });
      // We assigned the canonical port, NOT the stale 1944 from .env.
      expect(result.port).toBe(1940);
      expect(result.source).toBe("canonical");
      // The .env file is bit-for-bit untouched — PORT line and other lines
      // both stay. (No new PORT line written, no existing PORT rewritten.)
      const after = readFileSync(envPath, "utf8");
      expect(after).toBe(before);
    } finally {
      cleanup();
    }
  });

  test("returns fallback port and warning when canonical is occupied; .env untouched", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const envPath = join(dir, ".env");
      // Pre-existing .env with non-PORT content.
      const before = "FOO=bar\n";
      writeFileSync(envPath, before);
      const result = assignServicePort({
        canonical: 1940,
        occupied: [1940],
      });
      expect(result.port).toBe(1944);
      expect(result.source).toBe("fallback-in-range");
      expect(result.warning).toMatch(/canonical port 1940 is in use/);
      // .env stays bit-for-bit identical.
      expect(readFileSync(envPath, "utf8")).toBe(before);
    } finally {
      cleanup();
    }
  });

  test("third-party (no canonical) gets first reservation slot; no .env created", () => {
    const { dir, cleanup } = makeTempDir();
    try {
      const envPath = join(dir, ".env");
      const result = assignServicePort({
        occupied: [],
      });
      expect(result.port).toBe(1944);
      expect(result.source).toBe("fallback-in-range");
      expect(existsSync(envPath)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
