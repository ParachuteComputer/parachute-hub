/**
 * Unit tests for the `/account/` per-vault usage fetch + formatting
 * (`account-usage.ts`). The fetch mints a read token + hits the vault's loopback
 * `/.parachute/usage` endpoint; it must be fault-tolerant (any failure → null)
 * and shape-strict (a malformed body → null, not a render of `undefined`).
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type VaultUsageStat,
  fetchVaultUsage,
  formatBytes,
  formatUsageStat,
} from "../account-usage.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-account-usage-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

/** A stub signer — no real key needed; the fetch only carries the token string. */
const stubSign = async () => ({
  token: "stub.jwt.token",
  jti: "jti-1",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
});

function baseDeps(fetchImpl: typeof fetch) {
  return {
    db: harness.db,
    hubOrigin: "https://hub.test",
    vaultPort: 1940,
    userId: "user-1",
    fetchImpl,
    signToken: stubSign as never,
  };
}

describe("fetchVaultUsage", () => {
  test("returns the stat on a well-formed usage report", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          counts: { notes: 42, attachments: 3, links: 5, tags: 2 },
          bytes: { content: 1000, db: 2048, assets: 4096, total: 6144 },
          computedAt: new Date().toISOString(),
          cached: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const stat = await fetchVaultUsage("work", baseDeps(fetchImpl));
    expect(stat).toEqual({ notes: 42, totalBytes: 6144 });
  });

  test("calls the vault's loopback usage endpoint with a Bearer", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>)?.authorization ?? "";
      return new Response(JSON.stringify({ counts: { notes: 1 }, bytes: { total: 10 } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await fetchVaultUsage("work", baseDeps(fetchImpl));
    expect(seenUrl).toBe("http://127.0.0.1:1940/vault/work/.parachute/usage");
    expect(seenAuth).toBe("Bearer stub.jwt.token");
  });

  test("returns null on a non-2xx response (vault down / 403 / 404)", async () => {
    for (const status of [403, 404, 500]) {
      const fetchImpl = (async () => new Response("nope", { status })) as unknown as typeof fetch;
      const stat = await fetchVaultUsage("work", baseDeps(fetchImpl));
      expect(stat).toBeNull();
    }
  });

  test("returns null when the body is malformed (missing counts/bytes)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ counts: {}, bytes: {} }), {
        status: 200,
      })) as unknown as typeof fetch;
    const stat = await fetchVaultUsage("work", baseDeps(fetchImpl));
    expect(stat).toBeNull();
  });

  test("returns null when fetch throws (network error)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const stat = await fetchVaultUsage("work", baseDeps(fetchImpl));
    expect(stat).toBeNull();
  });
});

describe("formatUsageStat / formatBytes", () => {
  test("pluralizes notes + renders the byte size", () => {
    expect(formatUsageStat({ notes: 1, totalBytes: 1024 } as VaultUsageStat)).toBe("1 note · 1 KB");
    expect(formatUsageStat({ notes: 42, totalBytes: 6 * 1024 * 1024 } as VaultUsageStat)).toBe(
      "42 notes · 6.0 MB",
    );
    expect(formatUsageStat({ notes: 0, totalBytes: 0 } as VaultUsageStat)).toBe("0 notes · 0 B");
  });

  test("formatBytes picks the largest sensible unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
    expect(formatBytes(-5)).toBe("0 B");
  });
});
