import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  RefreshTokenInsertError,
  findRefreshToken,
  findTokenRowByJti,
  listActiveRevocations,
  recordTokenMint,
  revokeTokenByJti,
  signAccessToken,
  signRefreshToken,
  tokenRowIdentity,
  validateAccessToken,
} from "../jwt-sign.ts";
import { getActiveSigningKey, rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-jwt-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

describe("signAccessToken", () => {
  test("issues an RS256 JWT keyed by the active signing key", async () => {
    const { db, cleanup } = makeDb();
    try {
      const active = getActiveSigningKey(db);
      const { token, jti, expiresAt } = await signAccessToken(db, {
        sub: "user-1",
        scopes: ["vault.read", "vault.write"],
        audience: "vault",
        clientId: "notes-pwa",
        issuer: "https://hub.example",
      });
      const header = decodeProtectedHeader(token);
      expect(header.alg).toBe("RS256");
      expect(header.kid).toBe(active.kid);
      const payload = decodeJwt(token);
      expect(payload.sub).toBe("user-1");
      expect(payload.aud).toBe("vault");
      expect(payload.scope).toBe("vault.read vault.write");
      expect(payload.client_id).toBe("notes-pwa");
      expect(payload.jti).toBe(jti);
      expect(typeof payload.exp).toBe("number");
      expect(typeof payload.iat).toBe("number");
      expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(ACCESS_TOKEN_TTL_SECONDS);
      // expiresAt round-trips to the JWT exp.
      expect(new Date(expiresAt).getTime() / 1000).toBeCloseTo(payload.exp ?? 0, -1);
    } finally {
      cleanup();
    }
  });

  test("does NOT write to the tokens table (pure)", async () => {
    const { db, cleanup } = makeDb();
    try {
      await signAccessToken(db, {
        sub: "user-1",
        scopes: ["vault.read"],
        audience: "vault",
        clientId: "c",
        issuer: "https://hub.example",
      });
      const count = (
        db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get() ?? {
          n: -1,
        }
      ).n;
      expect(count).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("sets `iss` claim from opts.issuer (closes #77)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const issuer = "http://127.0.0.1:1939";
      const { token } = await signAccessToken(db, {
        sub: "user-1",
        scopes: ["vault.read"],
        audience: "vault",
        clientId: "c",
        issuer,
      });
      const payload = decodeJwt(token);
      expect(payload.iss).toBe(issuer);
      // Validation accepts the matching issuer.
      const { payload: validated } = await validateAccessToken(db, token, issuer);
      expect(validated.iss).toBe(issuer);
    } finally {
      cleanup();
    }
  });

  test("validateAccessToken rejects a token with a mismatched iss (defense in depth)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const { token } = await signAccessToken(db, {
        sub: "user-1",
        scopes: [],
        audience: "vault",
        clientId: "c",
        issuer: "http://127.0.0.1:1939",
      });
      await expect(validateAccessToken(db, token, "https://other.example")).rejects.toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("signRefreshToken", () => {
  test("inserts a tokens row with the hash, returns the plaintext", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "pw");
      const { token, refreshTokenHash, expiresAt } = signRefreshToken(db, {
        jti: "jti-1",
        userId: u.id,
        clientId: "notes",
        scopes: ["vault.read"],
      });
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
      const row = db
        .query<
          {
            jti: string;
            user_id: string;
            client_id: string;
            scopes: string;
            refresh_token_hash: string;
            expires_at: string;
          },
          [string]
        >("SELECT * FROM tokens WHERE jti = ?")
        .get("jti-1");
      expect(row).not.toBeNull();
      expect(row?.user_id).toBe(u.id);
      expect(row?.client_id).toBe("notes");
      expect(row?.scopes).toBe("vault.read");
      expect(row?.refresh_token_hash).toBe(refreshTokenHash);
      expect(row?.expires_at).toBe(expiresAt);
    } finally {
      cleanup();
    }
  });

  test("expiresAt is 30 days from now (sliding TTL initial value)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "pw");
      const fixed = new Date("2026-04-26T00:00:00.000Z");
      const { expiresAt } = signRefreshToken(db, {
        jti: "j",
        userId: u.id,
        clientId: "c",
        scopes: [],
        now: () => fixed,
      });
      expect(new Date(expiresAt).getTime() - fixed.getTime()).toBe(REFRESH_TOKEN_TTL_MS);
    } finally {
      cleanup();
    }
  });

  test("throws RefreshTokenInsertError on UNIQUE jti collision (#108)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "pw");
      signRefreshToken(db, {
        jti: "duplicate-jti",
        userId: u.id,
        clientId: "c",
        scopes: [],
      });
      let caught: unknown;
      try {
        signRefreshToken(db, {
          jti: "duplicate-jti",
          userId: u.id,
          clientId: "c",
          scopes: [],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RefreshTokenInsertError);
      expect((caught as RefreshTokenInsertError).cause).toBeDefined();
    } finally {
      cleanup();
    }
  });

  test("when wrapped in db.transaction() the UPDATE rolls back on INSERT failure (#107)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "pw");
      // Seed the row that simulates the pre-rotation refresh token.
      signRefreshToken(db, {
        jti: "old-jti",
        userId: u.id,
        clientId: "c",
        scopes: [],
      });
      // Pre-insert a row at the new jti so the rotation INSERT will collide.
      signRefreshToken(db, {
        jti: "new-jti",
        userId: u.id,
        clientId: "c",
        scopes: [],
      });

      // Mirror the rotation: revoke old + insert new, atomically.
      let caught: unknown;
      try {
        db.transaction(() => {
          db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ?").run(
            new Date().toISOString(),
            "old-jti",
          );
          signRefreshToken(db, {
            jti: "new-jti",
            userId: u.id,
            clientId: "c",
            scopes: [],
          });
        })();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RefreshTokenInsertError);

      // The UPDATE on "old-jti" must have been rolled back: the row
      // is still active, so the legitimate client can retry the refresh.
      const row = db
        .query<{ revoked_at: string | null }, [string]>(
          "SELECT revoked_at FROM tokens WHERE jti = ?",
        )
        .get("old-jti");
      expect(row?.revoked_at).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("findRefreshToken", () => {
  test("finds the row by hashing the plaintext", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "pw");
      const { token } = signRefreshToken(db, {
        jti: "jti-1",
        userId: u.id,
        clientId: "c",
        scopes: ["a", "b"],
      });
      const row = findRefreshToken(db, token);
      expect(row?.jti).toBe("jti-1");
      expect(row?.userId).toBe(u.id);
      expect(row?.scopes).toEqual(["a", "b"]);
      expect(row?.revokedAt).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("returns null for an unknown token", async () => {
    const { db, cleanup } = makeDb();
    try {
      expect(findRefreshToken(db, "not-a-real-token")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("validateAccessToken", () => {
  test("verifies a freshly-signed token", async () => {
    const { db, cleanup } = makeDb();
    try {
      const { token } = await signAccessToken(db, {
        sub: "u",
        scopes: ["s"],
        audience: "vault",
        clientId: "c",
        issuer: "https://hub.example",
      });
      const { payload, kid } = await validateAccessToken(db, token);
      expect(payload.sub).toBe("u");
      expect(kid.length).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });

  test("verifies a token signed by a recently-retired key (rotation tolerance)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const { token } = await signAccessToken(db, {
        sub: "u",
        scopes: [],
        audience: "vault",
        clientId: "c",
        issuer: "https://hub.example",
      });
      // Rotate — old key becomes retired but stays in JWKS for 24h.
      rotateSigningKey(db);
      const { payload } = await validateAccessToken(db, token);
      expect(payload.sub).toBe("u");
    } finally {
      cleanup();
    }
  });

  test("rejects a token whose kid no longer appears in JWKS", async () => {
    const { db, cleanup } = makeDb();
    try {
      const { token } = await signAccessToken(db, {
        sub: "u",
        scopes: [],
        audience: "vault",
        clientId: "c",
        issuer: "https://hub.example",
      });
      // Force the prior active key past 24h retention.
      const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      db.exec(`UPDATE signing_keys SET retired_at = '${past}' WHERE retired_at IS NULL`);
      // And rotate so there's a fresh active key, leaving the original
      // beyond JWKS retention.
      rotateSigningKey(db);
      await expect(validateAccessToken(db, token)).rejects.toThrow(/unknown or expired kid/);
    } finally {
      cleanup();
    }
  });

  test("rejects a token with no kid header", async () => {
    const { db, cleanup } = makeDb();
    try {
      // Hand-rolled JWT with no kid.
      const header = { alg: "RS256" };
      const payload = { sub: "u", iat: 1, exp: 9_999_999_999 };
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const fake = `${enc(header)}.${enc(payload)}.sig`;
      await expect(validateAccessToken(db, fake)).rejects.toThrow(/missing kid/);
    } finally {
      cleanup();
    }
  });
});

// closes #212 Phase 1 — unified token registry helpers (recordTokenMint,
// revokeTokenByJti, listActiveRevocations) and the v6 schema shape.
describe("token registry (hub#212 Phase 1)", () => {
  test("v6 schema: tokens has user_id NULLABLE + permissions/created_via/subject", () => {
    const { db, cleanup } = makeDb();
    try {
      // SQLite PRAGMA table_info reports column nullability + defaults; the
      // bun:sqlite driver maps the row shape onto our type. The columns are
      // (cid, name, type, notnull, dflt_value, pk) per SQLite docs.
      type ColInfo = {
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      };
      const cols = db.query<ColInfo, []>("PRAGMA table_info(tokens)").all();
      const byName = new Map(cols.map((c) => [c.name, c]));
      // Pre-v6: user_id NOT NULL. Post-v6: user_id NULLABLE.
      expect(byName.get("user_id")?.notnull).toBe(0);
      // New columns.
      expect(byName.has("permissions")).toBe(true);
      expect(byName.has("created_via")).toBe(true);
      expect(byName.has("subject")).toBe(true);
      // created_via has the back-compat default for pre-v6 rows.
      expect(byName.get("created_via")?.dflt_value).toMatch(/oauth_refresh/);
    } finally {
      cleanup();
    }
  });

  test("recordTokenMint inserts a registry row matching the inputs", () => {
    const { db, cleanup } = makeDb();
    try {
      const expiresAt = new Date(Date.now() + 86400_000).toISOString();
      recordTokenMint(db, {
        jti: "jti-cli-1",
        createdVia: "cli_mint",
        subject: "operator",
        clientId: "parachute-hub",
        scopes: ["vault:read", "scribe:transcribe"],
        expiresAt,
        permissions: '{"vault":{"default":{"read_tags":["public"]}}}',
      });
      const row = findTokenRowByJti(db, "jti-cli-1");
      expect(row).not.toBeNull();
      expect(row?.userId).toBeNull();
      expect(row?.subject).toBe("operator");
      expect(row?.createdVia).toBe("cli_mint");
      expect(row?.scopes).toEqual(["vault:read", "scribe:transcribe"]);
      expect(row?.expiresAt).toBe(expiresAt);
      expect(row?.permissions).toBe('{"vault":{"default":{"read_tags":["public"]}}}');
      expect(row?.revokedAt).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("recordTokenMint with a duplicate jti throws RefreshTokenInsertError", () => {
    const { db, cleanup } = makeDb();
    try {
      const expiresAt = new Date(Date.now() + 86400_000).toISOString();
      recordTokenMint(db, {
        jti: "jti-dup",
        createdVia: "operator_mint",
        subject: "operator",
        clientId: "parachute-hub",
        scopes: ["hub:admin"],
        expiresAt,
      });
      expect(() =>
        recordTokenMint(db, {
          jti: "jti-dup",
          createdVia: "cli_mint",
          subject: "operator",
          clientId: "parachute-hub",
          scopes: ["vault:read"],
          expiresAt,
        }),
      ).toThrow(RefreshTokenInsertError);
    } finally {
      cleanup();
    }
  });

  test("revokeTokenByJti flips revoked_at; second call returns false (idempotent)", () => {
    const { db, cleanup } = makeDb();
    try {
      const expiresAt = new Date(Date.now() + 86400_000).toISOString();
      recordTokenMint(db, {
        jti: "jti-rev",
        createdVia: "cli_mint",
        subject: "operator",
        clientId: "parachute-hub",
        scopes: ["vault:read"],
        expiresAt,
      });
      const now = new Date();
      expect(revokeTokenByJti(db, "jti-rev", now)).toBe(true);
      expect(revokeTokenByJti(db, "jti-rev", now)).toBe(false);
      const row = findTokenRowByJti(db, "jti-rev");
      expect(row?.revokedAt).toBe(now.toISOString());
    } finally {
      cleanup();
    }
  });

  test("listActiveRevocations filters by revoked_at AND expires_at>now", () => {
    const { db, cleanup } = makeDb();
    try {
      const past = new Date(Date.now() - 86400_000).toISOString();
      const future = new Date(Date.now() + 86400_000).toISOString();
      // Two revoked rows: one expired, one active.
      recordTokenMint(db, {
        jti: "jti-revoked-expired",
        createdVia: "cli_mint",
        subject: "operator",
        clientId: "parachute-hub",
        scopes: ["vault:read"],
        expiresAt: past,
      });
      recordTokenMint(db, {
        jti: "jti-revoked-active",
        createdVia: "cli_mint",
        subject: "operator",
        clientId: "parachute-hub",
        scopes: ["vault:read"],
        expiresAt: future,
      });
      // One non-revoked active row (control — must NOT appear).
      recordTokenMint(db, {
        jti: "jti-not-revoked",
        createdVia: "cli_mint",
        subject: "operator",
        clientId: "parachute-hub",
        scopes: ["vault:read"],
        expiresAt: future,
      });
      const now = new Date();
      revokeTokenByJti(db, "jti-revoked-expired", now);
      revokeTokenByJti(db, "jti-revoked-active", now);
      const list = listActiveRevocations(db, now);
      expect(list).toEqual(["jti-revoked-active"]);
    } finally {
      cleanup();
    }
  });

  test("tokenRowIdentity returns userId when present, else subject", async () => {
    const { db, cleanup } = makeDb();
    try {
      rotateSigningKey(db);
      const u = await createUser(db, "owner", "pw");
      // OAuth refresh row: userId set, subject NULL.
      const refresh = signRefreshToken(db, {
        jti: "jti-oauth",
        userId: u.id,
        clientId: "parachute-hub",
        scopes: ["vault:read"],
      });
      expect(refresh.familyId).toBeDefined();
      const oauthRow = findTokenRowByJti(db, "jti-oauth")!;
      expect(tokenRowIdentity(oauthRow)).toBe(u.id);

      // CLI mint row: userId NULL, subject set.
      recordTokenMint(db, {
        jti: "jti-cli",
        createdVia: "cli_mint",
        subject: "operator",
        clientId: "parachute-hub",
        scopes: ["vault:read"],
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      });
      const cliRow = findTokenRowByJti(db, "jti-cli")!;
      expect(tokenRowIdentity(cliRow)).toBe("operator");
    } finally {
      cleanup();
    }
  });

  test("signRefreshToken explicitly stamps created_via='oauth_refresh'", async () => {
    const { db, cleanup } = makeDb();
    try {
      rotateSigningKey(db);
      const u = await createUser(db, "owner", "pw");
      signRefreshToken(db, {
        jti: "jti-oauth-stamped",
        userId: u.id,
        clientId: "parachute-hub",
        scopes: ["vault:read"],
      });
      const row = findTokenRowByJti(db, "jti-oauth-stamped");
      expect(row?.createdVia).toBe("oauth_refresh");
    } finally {
      cleanup();
    }
  });
});
