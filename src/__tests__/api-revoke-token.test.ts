import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApiRevokeToken } from "../api-revoke-token.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { findTokenRowByJti, recordTokenMint, signAccessToken } from "../jwt-sign.ts";
import { mintOperatorToken } from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-revoke-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const ISSUER = "http://127.0.0.1:1939";

async function bootstrap(
  dir: string,
): Promise<{ db: ReturnType<typeof openHubDb>; userId: string }> {
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const u = await createUser(db, "owner", "pw");
  return { db, userId: u.id };
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/revoke-token", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Seed a tokens row by minting + recording, mirroring the CLI mint path. */
async function seedToken(
  db: ReturnType<typeof openHubDb>,
  userId: string,
  scopes = ["scribe:transcribe"],
): Promise<string> {
  const signed = await signAccessToken(db, {
    sub: userId,
    scopes,
    audience: "scribe",
    clientId: "parachute-hub",
    issuer: ISSUER,
    ttlSeconds: 3600,
  });
  recordTokenMint(db, {
    jti: signed.jti,
    createdVia: "cli_mint",
    subject: userId,
    clientId: "parachute-hub",
    scopes,
    expiresAt: signed.expiresAt,
  });
  return signed.jti;
}

describe("POST /api/auth/revoke-token (closes hub#220)", () => {
  test("405 on non-POST", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const req = new Request("http://localhost/api/auth/revoke-token", { method: "GET" });
        const resp = await handleApiRevokeToken(req, { db, issuer: ISSUER });
        expect(resp.status).toBe(405);
        expect(((await resp.json()) as { error: string }).error).toBe("method_not_allowed");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("401 when no Authorization header", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const resp = await handleApiRevokeToken(jsonRequest({ jti: "x" }), { db, issuer: ISSUER });
        expect(resp.status).toBe(401);
        expect(((await resp.json()) as { error: string }).error).toBe("unauthenticated");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("401 when bearer fails signature/issuer validation", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti: "x" }, { authorization: "Bearer not-a-real-jwt" }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(401);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("403 when bearer scope lacks parachute:host:auth", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const narrow = await signAccessToken(db, {
          sub: userId,
          scopes: ["hub:admin"],
          audience: "hub",
          clientId: "parachute-hub",
          issuer: ISSUER,
          ttlSeconds: 3600,
        });
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti: "x" }, { authorization: `Bearer ${narrow.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(403);
        expect(((await resp.json()) as { error: string }).error).toBe("insufficient_scope");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when body missing jti", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiRevokeToken(
          jsonRequest({}, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error: string; error_description: string };
        expect(body.error).toBe("invalid_request");
        expect(body.error_description).toContain("jti");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when jti is not a non-empty string", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        for (const badJti of [null, 42, "", true, []]) {
          const resp = await handleApiRevokeToken(
            jsonRequest({ jti: badJti }, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(400);
        }
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when body is not valid JSON", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const req = new Request("http://localhost/api/auth/revoke-token", {
          method: "POST",
          body: "not json {[",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${op.token}`,
          },
        });
        const resp = await handleApiRevokeToken(req, { db, issuer: ISSUER });
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error: string };
        expect(body.error).toBe("invalid_request");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("404 when jti has no registry row", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti: "this-jti-does-not-exist" }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(404);
        const body = (await resp.json()) as { error: string; error_description: string };
        expect(body.error).toBe("not_found");
        expect(body.error_description).toContain("this-jti-does-not-exist");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("happy path: revokes a fresh token; row's revoked_at is set", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const jti = await seedToken(db, userId);
        const before = findTokenRowByJti(db, jti);
        expect(before?.revokedAt).toBeNull();

        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { jti: string; revoked_at: string };
        expect(body.jti).toBe(jti);
        expect(typeof body.revoked_at).toBe("string");
        expect(body.revoked_at.length).toBeGreaterThan(0);

        const after = findTokenRowByJti(db, jti);
        expect(after?.revokedAt).toBe(body.revoked_at);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("idempotent: re-revoking returns 200 with the original revoked_at", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const jti = await seedToken(db, userId);

        const first = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(first.status).toBe(200);
        const firstBody = (await first.json()) as { revoked_at: string };
        const firstAt = firstBody.revoked_at;

        // Sleep 1ms so a clock-skew bug would make `now` != `first.revoked_at`.
        await Bun.sleep(2);

        const second = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as { revoked_at: string };
        // Idempotent: returns the original timestamp, not a fresh one.
        expect(secondBody.revoked_at).toBe(firstAt);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("happy path: --scope-set=auth narrow operator token passes the gate", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER, scopeSet: "auth" });
        const jti = await seedToken(db, userId);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Capability attenuation — symmetric to mint-token (hub#452). A bearer that
// is NOT host:auth may revoke a jti iff every one of the jti's recorded scopes
// is one the bearer could have minted (`canGrant`): you may revoke what you
// could mint. This is the security-critical half of the auth arc.
// ---------------------------------------------------------------------------
describe("POST /api/auth/revoke-token — capability attenuation (symmetric to hub#452)", () => {
  /**
   * Hand-mint a `vault:<vault>:admin` bearer the way the SPA / mcp-install
   * path obtains one (scope `vault:<vault>:admin`, aud `vault.<vault>`,
   * vaultScope `[vault]`). Mirrors `mintVaultAdminBearer` in
   * api-mint-token.test.ts.
   */
  async function mintVaultAdminBearer(
    db: ReturnType<typeof openHubDb>,
    userId: string,
    vault: string,
  ): Promise<string> {
    const signed = await signAccessToken(db, {
      sub: userId,
      scopes: [`vault:${vault}:admin`],
      audience: `vault.${vault}`,
      clientId: "parachute-hub",
      issuer: ISSUER,
      ttlSeconds: 3600,
      vaultScope: [vault],
    });
    return signed.token;
  }

  test("host:auth bearer revokes ANY jti (preserved) — incl. a host-scoped target", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        // Seed a target whose own scopes a vault-admin could never mint.
        const jti = await seedToken(db, userId, ["parachute:host:auth"]);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        expect(findTokenRowByJti(db, jti)?.revokedAt).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("vault:work:admin revokes a vault:work:write jti → 200 (could have minted it)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const bearer = await mintVaultAdminBearer(db, userId, "work");
        const jti = await seedToken(db, userId, ["vault:work:write"]);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${bearer}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        expect(findTokenRowByJti(db, jti)?.revokedAt).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("vault:work:admin revokes a vault:work:admin jti → 200", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const bearer = await mintVaultAdminBearer(db, userId, "work");
        const jti = await seedToken(db, userId, ["vault:work:admin"]);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${bearer}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        expect(findTokenRowByJti(db, jti)?.revokedAt).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("CROSS-VAULT BLOCKED: vault:work:admin revokes vault:other:write jti → 403, NOT revoked", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const bearer = await mintVaultAdminBearer(db, userId, "work");
        const jti = await seedToken(db, userId, ["vault:other:write"]);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${bearer}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(403);
        expect(((await resp.json()) as { error: string }).error).toBe("insufficient_scope");
        // SECURITY: the cross-vault token must NOT have been revoked.
        expect(findTokenRowByJti(db, jti)?.revokedAt).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("HOST-ESCALATION BLOCKED: vault:work:admin revokes parachute:host:auth jti → 403, NOT revoked", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const bearer = await mintVaultAdminBearer(db, userId, "work");
        const jti = await seedToken(db, userId, ["parachute:host:auth"]);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${bearer}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(403);
        expect(findTokenRowByJti(db, jti)?.revokedAt).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("NO LEAK: vault:work:admin revokes an UNKNOWN jti → 404 (same as host:auth, no leak)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const bearer = await mintVaultAdminBearer(db, userId, "work");
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti: "no-such-jti-ever-minted" }, { authorization: `Bearer ${bearer}` }),
          { db, issuer: ISSUER },
        );
        // Identical to today's unknown-jti behavior for a host:auth bearer:
        // the attenuated caller cannot distinguish "doesn't exist" here.
        expect(resp.status).toBe(404);
        expect(((await resp.json()) as { error: string }).error).toBe("not_found");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("ENTRY GATE: vault:work:read bearer (no admin, no host) → 403, NOT revoked", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const readOnly = await signAccessToken(db, {
          sub: userId,
          scopes: ["vault:work:read"],
          audience: "vault.work",
          clientId: "parachute-hub",
          issuer: ISSUER,
          ttlSeconds: 3600,
          vaultScope: ["work"],
        });
        // Seed a target the read bearer could never mint anyway.
        const jti = await seedToken(db, userId, ["vault:work:write"]);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${readOnly.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(403);
        expect(((await resp.json()) as { error: string }).error).toBe("insufficient_scope");
        // Entry-gated before any lookup — the target stays intact.
        expect(findTokenRowByJti(db, jti)?.revokedAt).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("MULTI-SCOPE: vault:work:admin revokes vault:work:read+write jti → 200 (all in authority)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const bearer = await mintVaultAdminBearer(db, userId, "work");
        const jti = await seedToken(db, userId, ["vault:work:read", "vault:work:write"]);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${bearer}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        expect(findTokenRowByJti(db, jti)?.revokedAt).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("MULTI-SCOPE BLOCKED: one out-of-authority scope blocks the whole revoke → 403, NOT revoked", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const bearer = await mintVaultAdminBearer(db, userId, "work");
        // In-authority scope + one cross-vault scope: must block entirely.
        const jti = await seedToken(db, userId, ["vault:work:write", "vault:other:read"]);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${bearer}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(403);
        expect(findTokenRowByJti(db, jti)?.revokedAt).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("host:admin bearer revokes a vault:<name>:admin jti → 200 (rule 2 symmetry)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const hostAdmin = await signAccessToken(db, {
          sub: userId,
          scopes: ["parachute:host:admin"],
          audience: "hub",
          clientId: "parachute-hub",
          issuer: ISSUER,
          ttlSeconds: 3600,
        });
        const jti = await seedToken(db, userId, ["vault:work:admin"]);
        const resp = await handleApiRevokeToken(
          jsonRequest({ jti }, { authorization: `Bearer ${hostAdmin.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        expect(findTokenRowByJti(db, jti)?.revokedAt).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
