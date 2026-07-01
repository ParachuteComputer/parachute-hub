import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { recordTokenMint, signAccessToken, validateAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import {
  SURFACE_TOKEN_CREATED_VIA,
  SURFACE_TOKEN_TTL_DEFAULT_SECONDS,
  listSurfaceTokens,
  mintSurfaceToken,
  revokeSurfaceToken,
  surfaceScope,
} from "../surface-token.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  db: ReturnType<typeof openHubDb>;
  userId: string;
  cleanup: () => void;
}

async function makeHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-surftok-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const u = await createUser(db, "owner", "pw");
  return {
    db,
    userId: u.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("surfaceScope", () => {
  test("builds the canonical scope", () => {
    expect(surfaceScope("gitcoin-brain", "write")).toBe("surface:gitcoin-brain:write");
    expect(surfaceScope("gitcoin-brain", "read")).toBe("surface:gitcoin-brain:read");
  });
});

describe("mintSurfaceToken", () => {
  test("mints a validatable, registered surface:<name>:write token", async () => {
    const h = await makeHarness();
    try {
      const minted = await mintSurfaceToken(h.db, {
        name: "gitcoin-brain",
        access: "write",
        issuer: ISSUER,
        userId: h.userId,
      });
      expect(minted.scope).toBe("surface:gitcoin-brain:write");
      expect(minted.token.split(".").length).toBe(3);

      // It validates through the SAME path the git endpoint uses.
      const validated = await validateAccessToken(h.db, minted.token, [ISSUER]);
      expect(validated.payload.scope).toBe("surface:gitcoin-brain:write");
      expect(validated.payload.aud).toBe("surface.gitcoin-brain");
      expect(validated.payload.jti).toBe(minted.jti);

      // A registry row exists, tagged as a deploy token (so list/revoke find it).
      const listed = listSurfaceTokens(h.db);
      expect(listed.map((r) => r.jti)).toContain(minted.jti);
    } finally {
      h.cleanup();
    }
  });

  test("read access mints surface:<name>:read", async () => {
    const h = await makeHarness();
    try {
      const minted = await mintSurfaceToken(h.db, {
        name: "docs",
        access: "read",
        issuer: ISSUER,
      });
      expect(minted.scope).toBe("surface:docs:read");
      const validated = await validateAccessToken(h.db, minted.token, [ISSUER]);
      expect(validated.payload.scope).toBe("surface:docs:read");
    } finally {
      h.cleanup();
    }
  });

  test("defaults to a 90-day TTL; honors an explicit ttlSeconds", async () => {
    const h = await makeHarness();
    try {
      const now = () => new Date("2026-06-30T00:00:00Z");
      const dflt = await mintSurfaceToken(h.db, {
        name: "foo",
        access: "write",
        issuer: ISSUER,
        now,
      });
      const expectedDefault = new Date(
        Date.parse("2026-06-30T00:00:00Z") + SURFACE_TOKEN_TTL_DEFAULT_SECONDS * 1000,
      ).toISOString();
      expect(dflt.expiresAt).toBe(expectedDefault);

      const custom = await mintSurfaceToken(h.db, {
        name: "bar",
        access: "write",
        issuer: ISSUER,
        ttlSeconds: 3600,
        now,
      });
      expect(custom.expiresAt).toBe(
        new Date(Date.parse("2026-06-30T00:00:00Z") + 3600 * 1000).toISOString(),
      );
    } finally {
      h.cleanup();
    }
  });

  test("rejects an invalid surface name (path-traversal safety)", async () => {
    const h = await makeHarness();
    try {
      await expect(
        mintSurfaceToken(h.db, { name: "../evil", access: "write", issuer: ISSUER }),
      ).rejects.toThrow(/invalid surface name/);
      await expect(
        mintSurfaceToken(h.db, { name: "a/b", access: "write", issuer: ISSUER }),
      ).rejects.toThrow(/invalid surface name/);
    } finally {
      h.cleanup();
    }
  });
});

describe("listSurfaceTokens", () => {
  test("lists only deploy tokens, narrows by surface, ignores other mints", async () => {
    const h = await makeHarness();
    try {
      const a = await mintSurfaceToken(h.db, { name: "alpha", access: "write", issuer: ISSUER });
      const b = await mintSurfaceToken(h.db, { name: "beta", access: "read", issuer: ISSUER });

      // A generic cli_mint token that ALSO names a surface scope must NOT appear
      // (deploy tokens are a distinct class, keyed by created_via).
      const other = await signAccessToken(h.db, {
        sub: h.userId,
        scopes: ["surface:alpha:write"],
        audience: "surface",
        clientId: "test",
        issuer: ISSUER,
      });
      recordTokenMint(h.db, {
        jti: other.jti,
        createdVia: "cli_mint",
        subject: "someone",
        clientId: "test",
        scopes: ["surface:alpha:write"],
        expiresAt: other.expiresAt,
      });

      const all = listSurfaceTokens(h.db);
      const jtis = all.map((r) => r.jti);
      expect(jtis).toContain(a.jti);
      expect(jtis).toContain(b.jti);
      expect(jtis).not.toContain(other.jti);

      const alphaOnly = listSurfaceTokens(h.db, "alpha");
      expect(alphaOnly.map((r) => r.jti)).toEqual([a.jti]);
      expect(alphaOnly[0]?.access).toBe("write");
      expect(alphaOnly[0]?.name).toBe("alpha");
      expect(alphaOnly[0]?.revokedAt).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("empty when none minted", async () => {
    const h = await makeHarness();
    try {
      expect(listSurfaceTokens(h.db)).toEqual([]);
      expect(listSurfaceTokens(h.db, "nope")).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe("revokeSurfaceToken", () => {
  test("revokes a deploy token; the endpoint path then rejects it", async () => {
    const h = await makeHarness();
    try {
      const minted = await mintSurfaceToken(h.db, {
        name: "foo",
        access: "write",
        issuer: ISSUER,
      });
      // Valid before revoke.
      await validateAccessToken(h.db, minted.token, [ISSUER]);

      const res = revokeSurfaceToken(h.db, minted.jti, new Date());
      expect(res.status).toBe("revoked");

      // Revocation is enforced at validation (the git endpoint's path).
      await expect(validateAccessToken(h.db, minted.token, [ISSUER])).rejects.toThrow(/revoked/);

      // list reflects the revoked state.
      const row = listSurfaceTokens(h.db, "foo")[0];
      expect(row?.revokedAt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("re-revoke is idempotent (already-revoked)", async () => {
    const h = await makeHarness();
    try {
      const minted = await mintSurfaceToken(h.db, {
        name: "foo",
        access: "write",
        issuer: ISSUER,
      });
      const first = revokeSurfaceToken(h.db, minted.jti, new Date());
      expect(first.status).toBe("revoked");
      const second = revokeSurfaceToken(h.db, minted.jti, new Date());
      expect(second.status).toBe("already-revoked");
      if (second.status === "already-revoked") {
        expect(second.revokedAt).toBeTruthy();
      }
    } finally {
      h.cleanup();
    }
  });

  test("unknown jti → not-found", async () => {
    const h = await makeHarness();
    try {
      expect(revokeSurfaceToken(h.db, "no-such-jti", new Date()).status).toBe("not-found");
    } finally {
      h.cleanup();
    }
  });

  test("refuses to revoke a non-deploy-token jti (fails closed)", async () => {
    const h = await makeHarness();
    try {
      const other = await signAccessToken(h.db, {
        sub: h.userId,
        scopes: ["vault:default:read"],
        audience: "vault.default",
        clientId: "test",
        issuer: ISSUER,
      });
      recordTokenMint(h.db, {
        jti: other.jti,
        createdVia: "cli_mint",
        subject: "someone",
        clientId: "test",
        scopes: ["vault:default:read"],
        expiresAt: other.expiresAt,
      });
      const res = revokeSurfaceToken(h.db, other.jti, new Date());
      expect(res.status).toBe("not-surface-token");
      if (res.status === "not-surface-token") {
        expect(res.createdVia).toBe("cli_mint");
      }
      // Confirm it was NOT revoked.
      await validateAccessToken(h.db, other.token, [ISSUER]);
    } finally {
      h.cleanup();
    }
  });

  test("SURFACE_TOKEN_CREATED_VIA is the stable tag", () => {
    expect(SURFACE_TOKEN_CREATED_VIA).toBe("surface_token");
  });
});
