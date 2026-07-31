import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRIBE_AUTH_ENV_KEY, SCRIBE_URL_ENV_KEY, selfHealScribeAuth } from "../auto-wire.ts";
import { writePid } from "../process-state.ts";

function makeHarness(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pcli-autowire-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const DEFAULT_SCRIBE_URL = "http://127.0.0.1:1943";

// Item H — serve-boot self-heal of scribe's auth token from vault's .env.
describe("selfHealScribeAuth", () => {
  function seedVaultToken(dir: string, token: string): void {
    mkdirSync(join(dir, "vault"), { recursive: true });
    writeFileSync(join(dir, "vault", ".env"), `${SCRIBE_AUTH_ENV_KEY}=${token}\n`);
  }
  function seedScribeConfig(dir: string, config: Record<string, unknown>): void {
    mkdirSync(join(dir, "scribe"), { recursive: true });
    writeFileSync(join(dir, "scribe", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  function readScribeConfig(dir: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(dir, "scribe", "config.json"), "utf8"));
  }

  test("vault .env has token + scribe config missing auth → self-heal writes it", () => {
    const h = makeHarness();
    try {
      seedVaultToken(h.dir, "shared-secret-xyz");
      seedScribeConfig(h.dir, { provider: "openai", model: "whisper-1" });
      const logs: string[] = [];
      const result = selfHealScribeAuth({ configDir: h.dir, log: (l) => logs.push(l) });
      expect(result.healed).toBe(true);
      const cfg = readScribeConfig(h.dir);
      expect((cfg.auth as Record<string, unknown>).required_token).toBe("shared-secret-xyz");
      // Other config keys preserved (merge-don't-clobber).
      expect(cfg.provider).toBe("openai");
      expect(cfg.model).toBe("whisper-1");
      expect(logs.join("\n")).toMatch(/Self-healed scribe auth/);
    } finally {
      h.cleanup();
    }
  });

  test("scribe config wholly absent → self-heal creates it with the token", () => {
    const h = makeHarness();
    try {
      seedVaultToken(h.dir, "shared-secret-xyz");
      // No scribe/config.json at all.
      const result = selfHealScribeAuth({ configDir: h.dir });
      expect(result.healed).toBe(true);
      expect((readScribeConfig(h.dir).auth as Record<string, unknown>).required_token).toBe(
        "shared-secret-xyz",
      );
    } finally {
      h.cleanup();
    }
  });

  test("scribe token mismatches vault → re-synced to vault's value", () => {
    const h = makeHarness();
    try {
      seedVaultToken(h.dir, "vault-token-NEW");
      seedScribeConfig(h.dir, { auth: { required_token: "stale-token-OLD" }, model: "x" });
      const result = selfHealScribeAuth({ configDir: h.dir });
      expect(result.healed).toBe(true);
      const cfg = readScribeConfig(h.dir);
      expect((cfg.auth as Record<string, unknown>).required_token).toBe("vault-token-NEW");
      expect(cfg.model).toBe("x");
    } finally {
      h.cleanup();
    }
  });

  test("already in sync → no-op (idempotent), config untouched", () => {
    const h = makeHarness();
    try {
      seedVaultToken(h.dir, "same-token");
      seedScribeConfig(h.dir, { auth: { required_token: "same-token" }, extra: "keep" });
      const before = readFileSync(join(h.dir, "scribe", "config.json"), "utf8");
      const result = selfHealScribeAuth({ configDir: h.dir });
      expect(result.healed).toBe(false);
      expect(result.reason).toBe("already-synced");
      // Byte-identical — no rewrite.
      expect(readFileSync(join(h.dir, "scribe", "config.json"), "utf8")).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  test("vault has no SCRIBE_AUTH_TOKEN → no-op (nothing to sync)", () => {
    const h = makeHarness();
    try {
      mkdirSync(join(h.dir, "vault"), { recursive: true });
      writeFileSync(join(h.dir, "vault", ".env"), "FOO=bar\n");
      const result = selfHealScribeAuth({ configDir: h.dir });
      expect(result.healed).toBe(false);
      expect(result.reason).toBe("no-token");
      // Scribe config not created.
      expect(existsSync(join(h.dir, "scribe", "config.json"))).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
