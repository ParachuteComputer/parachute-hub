/**
 * Nostr principal attribution on the vault hop token (hub#936).
 *
 * The problem: several agents, each holding their own Nostr key, routinely
 * link to ONE hub user. The account-MCP → vault hop token's `sub` is that
 * shared user, so a vault stamping `created_by` from `sub` cannot tell two
 * agents apart. Observed 2026-09-02 — one agent's append to a note recorded a
 * `lastUpdatedBy` byte-identical to another agent's.
 *
 * The fix, pinned here:
 *   1. A NIP-98-authenticated connection mints the hop token with
 *      `permissions.principal_pubkey = <64 lowercase hex>`.
 *   2. Bearer / password / OAuth connections NEVER carry the claim.
 *   3. The hop-reuse cache is keyed on the pubkey, so one agent's cached
 *      token is never handed to another agent on the same hub user.
 *
 * The vault half (turning the claim into `created_via` / `last_updated_via` =
 * `nostr:<pubkey>`) lives in parachute-vault; the wire contract is
 * `parachute-vault/docs/contracts/nostr-principal-attribution.md`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { mintVaultMcpToken, principalAttributionClaims } from "../account-mcp-backend.ts";
import {
  ACCOUNT_MCP_HOP_TTL_ENV,
  _resetAccountMcpHopCacheForTests,
  hopCacheKey,
} from "../account-mcp-hop.ts";
import type { AccountMcpPrincipal, AccountToolContext } from "../account-mcp.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import type { SignAccessTokenOpts } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = `e6619493${"b".repeat(56)}`;

afterEach(() => {
  _resetAccountMcpHopCacheForTests();
});

function nostrPrincipal(userId: string, pubkey: string): AccountMcpPrincipal {
  return {
    userId,
    scopes: ["vault:uni:write"],
    authKind: "nostr",
    clientId: `nostr:${pubkey}`,
    pubkey,
    isHubAdmin: false,
    grant: null,
  };
}

function bearerPrincipal(userId: string): AccountMcpPrincipal {
  return {
    userId,
    scopes: ["account:self:vaults"],
    authKind: "bearer",
    clientId: "parachute-account",
    isHubAdmin: true,
    grant: null,
  };
}

describe("principalAttributionClaims — who gets a pubkey claim", () => {
  test("a NIP-98 principal yields permissions.principal_pubkey", () => {
    expect(principalAttributionClaims(nostrPrincipal("user-1", PUBKEY_A))).toEqual({
      permissions: { principal_pubkey: PUBKEY_A },
    });
  });

  test("a Bearer / OAuth / password principal yields NOTHING", () => {
    // There is no signing key on these connections; stamping one would
    // fabricate attribution. This is the load-bearing negative.
    expect(principalAttributionClaims(bearerPrincipal("user-1"))).toBeNull();
    // Even if a pubkey somehow rode along on a non-nostr principal, authKind
    // is the gate — the claim asserts "this key SIGNED the request".
    expect(
      principalAttributionClaims({ ...bearerPrincipal("user-1"), pubkey: PUBKEY_A }),
    ).toBeNull();
  });

  test("a malformed pubkey is dropped, not shipped", () => {
    const bad = [
      undefined,
      "",
      "A".repeat(64), // uppercase hex is not NIP-01 canonical form
      "ab".repeat(20), // too short
      "z".repeat(64), // not hex
      `${PUBKEY_A}0`, // too long
      "npub1qqqqqq", // bech32, not hex
    ];
    for (const pubkey of bad) {
      const principal = { ...nostrPrincipal("user-1", PUBKEY_A), pubkey } as AccountMcpPrincipal;
      expect(principalAttributionClaims(principal)).toBeNull();
    }
  });
});

describe("hopCacheKey — the signer separates otherwise-identical keys", () => {
  test("two agents on the SAME hub user get different cache keys", () => {
    const a = hopCacheKey("shared-user", "uni", "write", "http://127.0.0.1:1939", PUBKEY_A);
    const b = hopCacheKey("shared-user", "uni", "write", "http://127.0.0.1:1939", PUBKEY_B);
    expect(a).not.toBe(b);
  });

  test("omitting the pubkey reproduces the pre-hub#936 key byte-for-byte", () => {
    const legacy = hopCacheKey("u", "uni", "read", "http://127.0.0.1:1939");
    expect(legacy).toBe(hopCacheKey("u", "uni", "read", "http://127.0.0.1:1939", null));
    expect(legacy).toBe("u\0uni\0read\0http://127.0.0.1:1939");
  });
});

describe("mintVaultMcpToken — the claim on the wire", () => {
  function harness(principal: AccountMcpPrincipal) {
    const dir = mkdtempSync(join(tmpdir(), "phub-attrib-"));
    const db = openHubDb(hubDbPath(dir));
    rotateSigningKey(db);
    const calls: SignAccessTokenOpts[] = [];
    let n = 0;
    const signToken = async (_db: unknown, opts: SignAccessTokenOpts) => {
      n += 1;
      calls.push(opts);
      return { token: `hop.${n}` };
    };
    const ctx: AccountToolContext = {
      db,
      issuer: "http://127.0.0.1:1939",
      manifestPath: join(dir, "services.json"),
      principal,
      now: () => new Date(1_700_000_000_000),
      signToken: signToken as AccountToolContext["signToken"],
    };
    const vault = { name: "uni", url: "http://127.0.0.1:1940/vault/uni", version: "0.7.8" };
    return {
      db,
      ctx,
      vault,
      calls,
      minted: () => n,
      cleanup: () => {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  test("NIP-98 connection: extraClaims carry permissions.principal_pubkey", async () => {
    const h = harness(nostrPrincipal("e6619493-hub-user", PUBKEY_A));
    try {
      await mintVaultMcpToken(h.ctx, h.vault, "write", {});
      expect(h.calls[0]?.extraClaims).toEqual({
        permissions: { principal_pubkey: PUBKEY_A },
      });
      // `sub` is untouched — it stays the hub user, which is what the vault
      // records as `created_by`.
      expect(h.calls[0]?.sub).toBe("e6619493-hub-user");
    } finally {
      h.cleanup();
    }
  });

  test("Bearer connection: no extraClaims at all", async () => {
    const h = harness(bearerPrincipal("user-1"));
    try {
      await mintVaultMcpToken(h.ctx, h.vault, "read", {});
      expect(h.calls[0]?.extraClaims).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("the claim survives real signing and is readable off the JWT payload", async () => {
    // The seam above pins what we ASK for; this pins what actually lands on
    // the wire — `signAccessToken` owns a reserved-claim list, and `permissions`
    // must not be one of them.
    const h = harness(nostrPrincipal("hub-user", PUBKEY_B));
    try {
      // No `signToken` seam → the real `signAccessToken` runs.
      const { signToken: _seam, ...realCtx } = h.ctx;
      const token = await mintVaultMcpToken(realCtx, h.vault, "write", {});
      const payload = decodeJwt(token) as Record<string, unknown>;
      expect(payload.permissions).toEqual({ principal_pubkey: PUBKEY_B });
      expect(payload.sub).toBe("hub-user");
      expect(payload.aud).toBe("vault.uni");
      expect(payload.scope).toBe("vault:uni:write");
      // The hop token is still identified as the account-MCP client; the
      // pubkey is attribution, not a client identity swap.
      expect(payload.client_id).toBe("parachute-account");
    } finally {
      h.cleanup();
    }
  });

  test("a real Bearer mint carries NO permissions claim on the wire", async () => {
    const h = harness(bearerPrincipal("user-1"));
    try {
      const { signToken: _seam, ...realCtx } = h.ctx;
      const token = await mintVaultMcpToken(realCtx, h.vault, "read", {});
      const payload = decodeJwt(token) as Record<string, unknown>;
      expect(payload.permissions).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("THE REPORTED BUG under hop reuse: two agents on one hub user never share a token", async () => {
    // Without the pubkey in the cache key, agent B's call would hit agent A's
    // cached entry — same (userId, vault, verb, issuer) — and B's writes would
    // land stamped with A's pubkey. Silently, since the token is valid.
    const env = { [ACCOUNT_MCP_HOP_TTL_ENV]: "300" };
    const h = harness(nostrPrincipal("e6619493-shared-hub-user", PUBKEY_A));
    try {
      const a1 = await mintVaultMcpToken(h.ctx, h.vault, "write", env);
      const a2 = await mintVaultMcpToken(h.ctx, h.vault, "write", env);
      expect(a2).toBe(a1); // same agent still reuses

      const ctxB: AccountToolContext = {
        ...h.ctx,
        principal: nostrPrincipal("e6619493-shared-hub-user", PUBKEY_B),
      };
      const b1 = await mintVaultMcpToken(ctxB, h.vault, "write", env);
      expect(b1).not.toBe(a1);
      expect(h.minted()).toBe(2);
      expect(h.calls[1]?.extraClaims).toEqual({
        permissions: { principal_pubkey: PUBKEY_B },
      });
    } finally {
      h.cleanup();
    }
  });
});
