/**
 * Unit tests for the `/account/` per-vault backup (mirror) status fetch +
 * formatting (`account-mirror.ts`). The fetch mints an admin-scoped token + hits
 * the vault's loopback `/.parachute/mirror` endpoint; it must be fault-tolerant
 * (any failure → null) and shape-strict (a malformed body → null, not a render
 * of `undefined`). Mirrors `account-usage.test.ts`'s posture.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type VaultMirrorStat,
  fetchVaultMirrorStatus,
  formatMirrorLine,
} from "../account-mirror.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-account-mirror-"));
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

describe("fetchVaultMirrorStatus", () => {
  test("returns enabled+not-pushing on a backed-up, local-only config", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          config: { enabled: true, location: "internal", auto_push: false },
          status: { enabled: true, last_commit_sha: "abc", last_error: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toEqual({ enabled: true, backedUpToRemote: false });
  });

  test("flags pushing when auto_push is configured", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ config: { enabled: true, location: "internal", auto_push: true } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toEqual({ enabled: true, backedUpToRemote: true });
  });

  test("returns enabled:false when backup is off", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ config: { enabled: false, auto_push: false } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toEqual({ enabled: false, backedUpToRemote: false });
  });

  test("mints an ADMIN-scoped Bearer + hits the vault's loopback mirror endpoint", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenScope: string[] = [];
    const captureSign = (async (_db: unknown, opts: { scopes: string[] }) => {
      seenScope = opts.scopes;
      return { token: "stub.jwt.token", jti: "j", expiresAt: new Date().toISOString() };
    }) as never;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>)?.authorization ?? "";
      return new Response(JSON.stringify({ config: { enabled: true, auto_push: false } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    await fetchVaultMirrorStatus("work", { ...baseDeps(fetchImpl), signToken: captureSign });
    expect(seenUrl).toBe("http://127.0.0.1:1940/vault/work/.parachute/mirror");
    expect(seenAuth).toBe("Bearer stub.jwt.token");
    expect(seenScope).toEqual(["vault:work:admin"]);
  });

  test("returns null on a non-2xx response (vault down / 403 / 404)", async () => {
    for (const status of [403, 404, 500]) {
      const fetchImpl = (async () => new Response("nope", { status })) as unknown as typeof fetch;
      const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
      expect(stat).toBeNull();
    }
  });

  test("returns null when the body is malformed (missing config.enabled)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ config: {} }), { status: 200 })) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toBeNull();
  });

  test("returns null when fetch throws (network error)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const stat = await fetchVaultMirrorStatus("work", baseDeps(fetchImpl));
    expect(stat).toBeNull();
  });
});

describe("formatMirrorLine", () => {
  test("warm plain-language line; GitHub variant when pushing", () => {
    expect(formatMirrorLine({ enabled: true, backedUpToRemote: false } as VaultMirrorStat)).toBe(
      "Backed up — full version history",
    );
    expect(formatMirrorLine({ enabled: true, backedUpToRemote: true } as VaultMirrorStat)).toBe(
      "Backed up — version history + GitHub",
    );
  });

  test("returns null when backup is off (the tile omits the line, never nags)", () => {
    expect(
      formatMirrorLine({ enabled: false, backedUpToRemote: false } as VaultMirrorStat),
    ).toBeNull();
  });
});
