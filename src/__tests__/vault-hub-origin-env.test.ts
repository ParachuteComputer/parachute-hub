/**
 * Tests for the durable half of the OAuth issuer-mismatch fix: persisting the
 * hub's PUBLIC origin into `<configDir>/vault/.env` so the launchd / systemd
 * daemon — which boots vault out-of-band and never sees the `parachute start`
 * spawn env — validates hub-minted JWTs' `iss` against the public origin
 * instead of vault's loopback default. See `vault-hub-origin-env.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEnvFileValues } from "../env-file.ts";
import {
  clearVaultHubOrigin,
  isLoopbackOrigin,
  persistVaultHubOrigin,
} from "../vault-hub-origin-env.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pcli-vhoe-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function vaultEnv(): string {
  return join(dir, "vault", ".env");
}

describe("isLoopbackOrigin", () => {
  test("flags 127.0.0.1 / localhost / [::1]", () => {
    expect(isLoopbackOrigin("http://127.0.0.1:1939")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:1939")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:1939")).toBe(true);
  });

  test("does not flag a public FQDN", () => {
    expect(isLoopbackOrigin("https://parachute-aaron.tailc75afc.ts.net")).toBe(false);
    expect(isLoopbackOrigin("https://hub.example.com")).toBe(false);
  });

  test("non-URL strings are treated as non-loopback (don't block persistence)", () => {
    expect(isLoopbackOrigin("not a url")).toBe(false);
  });
});

describe("persistVaultHubOrigin", () => {
  test("writes a non-loopback public origin into vault/.env", () => {
    const wrote = persistVaultHubOrigin(dir, "https://parachute-aaron.tailc75afc.ts.net", () => {});
    expect(wrote).toBe(true);
    expect(readEnvFileValues(vaultEnv()).PARACHUTE_HUB_ORIGIN).toBe(
      "https://parachute-aaron.tailc75afc.ts.net",
    );
  });

  test("refuses to persist a loopback origin (would shadow a later exposure)", () => {
    const wrote = persistVaultHubOrigin(dir, "http://127.0.0.1:1939", () => {});
    expect(wrote).toBe(false);
    expect(existsSync(vaultEnv())).toBe(false);
  });

  test("is idempotent — no rewrite when the value is already current", () => {
    const log: string[] = [];
    expect(persistVaultHubOrigin(dir, "https://hub.example.com", (l) => log.push(l))).toBe(true);
    expect(persistVaultHubOrigin(dir, "https://hub.example.com", (l) => log.push(l))).toBe(false);
    // Only the first call logged.
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/persisted PARACHUTE_HUB_ORIGIN=https:\/\/hub\.example\.com/);
  });

  test("updates a stale origin in-place and preserves sibling keys", () => {
    writeFileSync(
      mkVaultDir(),
      "SCRIBE_AUTH_TOKEN=secret\nPARACHUTE_HUB_ORIGIN=https://old.example.com\nSCRIBE_URL=http://127.0.0.1:1943\n",
    );
    const wrote = persistVaultHubOrigin(dir, "https://new.example.com", () => {});
    expect(wrote).toBe(true);
    const values = readEnvFileValues(vaultEnv());
    expect(values.PARACHUTE_HUB_ORIGIN).toBe("https://new.example.com");
    // Sibling keys untouched.
    expect(values.SCRIBE_AUTH_TOKEN).toBe("secret");
    expect(values.SCRIBE_URL).toBe("http://127.0.0.1:1943");
  });
});

describe("clearVaultHubOrigin", () => {
  test("removes a persisted origin and leaves sibling keys", () => {
    writeFileSync(
      mkVaultDir(),
      "SCRIBE_AUTH_TOKEN=secret\nPARACHUTE_HUB_ORIGIN=https://hub.example.com\n",
    );
    const wrote = clearVaultHubOrigin(dir, () => {});
    expect(wrote).toBe(true);
    const values = readEnvFileValues(vaultEnv());
    expect(values.PARACHUTE_HUB_ORIGIN).toBeUndefined();
    expect(values.SCRIBE_AUTH_TOKEN).toBe("secret");
  });

  test("no-op when no origin is present", () => {
    writeFileSync(mkVaultDir(), "SCRIBE_AUTH_TOKEN=secret\n");
    expect(clearVaultHubOrigin(dir, () => {})).toBe(false);
  });

  test("no-op when vault/.env doesn't exist", () => {
    expect(clearVaultHubOrigin(dir, () => {})).toBe(false);
  });
});

/** Create `<dir>/vault/` and return the `.env` path so writeFileSync lands. */
function mkVaultDir(): string {
  mkdirSync(join(dir, "vault"), { recursive: true });
  return vaultEnv();
}
