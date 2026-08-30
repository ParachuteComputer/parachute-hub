/**
 * Account-MCP hop JWT reuse (hub#918).
 *
 * Default is today's per-call 60s mint. Reuse is env-gated and stays
 * strictly under the registered-mint threshold so hops remain unregistered.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintVaultMcpToken } from "../account-mcp-backend.ts";
import {
  ACCOUNT_MCP_HOP_TTL_CAP_SECONDS,
  ACCOUNT_MCP_HOP_TTL_ENV,
  _resetAccountMcpHopCacheForTests,
  hopCacheKey,
  lookupHopToken,
  parseAccountMcpHopTtl,
  storeHopToken,
} from "../account-mcp-hop.ts";
import type { AccountToolContext } from "../account-mcp.ts";
import { FANOUT_TOKEN_TTL_SECONDS } from "../account-mcp.ts";
import { REGISTERED_MINT_TTL_THRESHOLD_SECONDS } from "../admin-connections.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import type { SignAccessTokenOpts } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";

afterEach(() => {
  _resetAccountMcpHopCacheForTests();
});

describe("parseAccountMcpHopTtl", () => {
  test("unset / empty / junk fail closed to today's 60s per-call mint", () => {
    expect(parseAccountMcpHopTtl({})).toEqual({
      reuse: false,
      ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "" })).toEqual({
      reuse: false,
      ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "   " })).toEqual({
      reuse: false,
      ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "banana" })).toEqual({
      reuse: false,
      ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "300.5" })).toEqual({
      reuse: false,
      ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "0300" })).toEqual({
      reuse: false,
      ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "0" })).toEqual({
      reuse: false,
      ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "-1" })).toEqual({
      reuse: false,
      ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    });
  });

  test("well-formed integer enables reuse and caps at 599", () => {
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "300" })).toEqual({
      reuse: true,
      ttlSeconds: 300,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "1" })).toEqual({
      reuse: true,
      ttlSeconds: 1,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "599" })).toEqual({
      reuse: true,
      ttlSeconds: 599,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "600" })).toEqual({
      reuse: true,
      ttlSeconds: ACCOUNT_MCP_HOP_TTL_CAP_SECONDS,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: "1000" })).toEqual({
      reuse: true,
      ttlSeconds: ACCOUNT_MCP_HOP_TTL_CAP_SECONDS,
    });
    expect(parseAccountMcpHopTtl({ [ACCOUNT_MCP_HOP_TTL_ENV]: " 300 " })).toEqual({
      reuse: true,
      ttlSeconds: 300,
    });
  });

  test("cap sits strictly under the registered-mint threshold", () => {
    expect(ACCOUNT_MCP_HOP_TTL_CAP_SECONDS).toBeLessThan(REGISTERED_MINT_TTL_THRESHOLD_SECONDS);
    expect(FANOUT_TOKEN_TTL_SECONDS).toBeLessThan(REGISTERED_MINT_TTL_THRESHOLD_SECONDS);
  });
});

describe("hop cache", () => {
  test("lookup misses, hits, then expires at the 5s reuse floor", () => {
    const key = hopCacheKey("u", "uni", "read", "http://127.0.0.1:1939");
    const t0 = 1_000_000;
    expect(lookupHopToken(key, t0)).toBeNull();
    storeHopToken(key, "tok", t0 + 300_000);
    expect(lookupHopToken(key, t0)).toBe("tok");
    expect(lookupHopToken(key, t0 + 294_999)).toBe("tok");
    expect(lookupHopToken(key, t0 + 295_000)).toBeNull();
    expect(lookupHopToken(key, t0 + 295_000)).toBeNull();
  });

  test("store sweeps expired entries", () => {
    const a = hopCacheKey("u", "a", "read", "iss");
    const b = hopCacheKey("u", "b", "read", "iss");
    const t0 = 1_000_000;
    storeHopToken(a, "old", t0 + 1_000);
    storeHopToken(b, "fresh", t0 + 300_000, t0 + 10_000);
    expect(lookupHopToken(a, t0 + 10_000)).toBeNull();
    expect(lookupHopToken(b, t0 + 10_000)).toBe("fresh");
  });
});

describe("mintVaultMcpToken hop reuse", () => {
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "phub-hop-"));
    const db = openHubDb(hubDbPath(dir));
    rotateSigningKey(db);
    const calls: SignAccessTokenOpts[] = [];
    let n = 0;
    const signToken = async (_db: unknown, opts: SignAccessTokenOpts) => {
      n += 1;
      calls.push(opts);
      return { token: `hop.${n}.${opts.ttlSeconds}` };
    };
    let nowMs = 1_700_000_000_000;
    const ctx: AccountToolContext = {
      db,
      issuer: "http://127.0.0.1:1939",
      manifestPath: join(dir, "services.json"),
      principal: {
        userId: "user-1",
        scopes: ["account:self:vaults"],
        authKind: "bearer",
        clientId: "parachute-account",
        isHubAdmin: true,
        grant: null,
      },
      now: () => new Date(nowMs),
      signToken: signToken as AccountToolContext["signToken"],
    };
    const vault = { name: "uni", url: "http://127.0.0.1:1940/vault/uni", version: "0.7.8" };
    return {
      ctx,
      vault,
      calls,
      minted: () => n,
      setNow: (ms: number) => {
        nowMs = ms;
      },
      now: () => nowMs,
      cleanup: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("default env: every call mints a fresh 60s token", async () => {
    const h = harness();
    try {
      const a = await mintVaultMcpToken(h.ctx, h.vault, "read", {});
      const b = await mintVaultMcpToken(h.ctx, h.vault, "read", {});
      expect(h.minted()).toBe(2);
      expect(a).not.toBe(b);
      expect(h.calls[0]?.ttlSeconds).toBe(FANOUT_TOKEN_TTL_SECONDS);
      expect(h.calls[1]?.ttlSeconds).toBe(FANOUT_TOKEN_TTL_SECONDS);
    } finally {
      h.cleanup();
    }
  });

  test("TTL=300: second call reuses; third after floor remints", async () => {
    const h = harness();
    const env = { [ACCOUNT_MCP_HOP_TTL_ENV]: "300" };
    try {
      const t0 = h.now();
      const a = await mintVaultMcpToken(h.ctx, h.vault, "read", env);
      const b = await mintVaultMcpToken(h.ctx, h.vault, "read", env);
      expect(a).toBe(b);
      expect(h.minted()).toBe(1);
      expect(h.calls[0]?.ttlSeconds).toBe(300);
      expect(h.calls[0]?.scopes).toEqual(["vault:uni:read"]);
      expect(h.calls[0]?.audience).toBe("vault.uni");

      h.setNow(t0 + 294_999);
      const still = await mintVaultMcpToken(h.ctx, h.vault, "read", env);
      expect(still).toBe(a);
      expect(h.minted()).toBe(1);

      h.setNow(t0 + 295_000);
      const c = await mintVaultMcpToken(h.ctx, h.vault, "read", env);
      expect(c).not.toBe(a);
      expect(h.minted()).toBe(2);
      expect(h.calls[1]?.ttlSeconds).toBe(300);
    } finally {
      h.cleanup();
    }
  });

  test("different user / vault / verb / issuer do not share", async () => {
    const h = harness();
    const env = { [ACCOUNT_MCP_HOP_TTL_ENV]: "300" };
    try {
      await mintVaultMcpToken(h.ctx, h.vault, "read", env);
      await mintVaultMcpToken(h.ctx, { ...h.vault, name: "other" }, "read", env);
      await mintVaultMcpToken(h.ctx, h.vault, "write", env);
      const otherUser: AccountToolContext = {
        ...h.ctx,
        principal: { ...h.ctx.principal, userId: "user-2" },
      };
      await mintVaultMcpToken(otherUser, h.vault, "read", env);
      const otherIss: AccountToolContext = { ...h.ctx, issuer: "http://127.0.0.1:1940" };
      await mintVaultMcpToken(otherIss, h.vault, "read", env);
      expect(h.minted()).toBe(5);
    } finally {
      h.cleanup();
    }
  });

  test("TTL=1 enables reuse flag but the 5s floor means no reuse", async () => {
    const h = harness();
    const env = { [ACCOUNT_MCP_HOP_TTL_ENV]: "1" };
    try {
      const a = await mintVaultMcpToken(h.ctx, h.vault, "read", env);
      const b = await mintVaultMcpToken(h.ctx, h.vault, "read", env);
      expect(a).not.toBe(b);
      expect(h.minted()).toBe(2);
      expect(h.calls[0]?.ttlSeconds).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("junk env does not enable reuse (no silent wire flip)", async () => {
    const h = harness();
    try {
      await mintVaultMcpToken(h.ctx, h.vault, "read", { [ACCOUNT_MCP_HOP_TTL_ENV]: "nope" });
      await mintVaultMcpToken(h.ctx, h.vault, "read", { [ACCOUNT_MCP_HOP_TTL_ENV]: "nope" });
      expect(h.minted()).toBe(2);
      expect(h.calls[0]?.ttlSeconds).toBe(FANOUT_TOKEN_TTL_SECONDS);
    } finally {
      h.cleanup();
    }
  });
});
