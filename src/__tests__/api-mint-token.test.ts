import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApiMintToken } from "../api-mint-token.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken, validateAccessToken } from "../jwt-sign.ts";
import { mintOperatorToken } from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-mint-"));
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
  return new Request("http://localhost/api/auth/mint-token", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("POST /api/auth/mint-token (hub#212 Phase 1)", () => {
  test("401 when no Authorization header", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const resp = await handleApiMintToken(jsonRequest({ scope: "vault:read" }), {
          db,
          issuer: ISSUER,
        });
        expect(resp.status).toBe(401);
        const body = (await resp.json()) as { error: string };
        expect(body.error).toBe("unauthenticated");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("401 when Authorization is not Bearer", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "vault:read" }, { authorization: "Basic xyz" }),
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

  test("401 when bearer fails signature/issuer validation", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "vault:read" }, { authorization: "Bearer not-a-real-jwt" }),
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
        // Hand-mint a JWT with hub:admin only — covers the operator-bearer
        // happy path for OTHER routes but is intentionally insufficient for
        // /api/auth/mint-token (we want a narrow `parachute:host:auth` gate).
        const narrow = await signAccessToken(db, {
          sub: userId,
          scopes: ["hub:admin"],
          audience: "hub",
          clientId: "parachute-hub",
          issuer: ISSUER,
          ttlSeconds: 3600,
        });
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "vault:read" }, { authorization: `Bearer ${narrow.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(403);
        const body = (await resp.json()) as { error: string };
        expect(body.error).toBe("insufficient_scope");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("happy path: admin operator-token mints a scope-narrow JWT + writes registry row", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest(
            { scope: "scribe:transcribe", expires_in: 3600 },
            { authorization: `Bearer ${op.token}` },
          ),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
          jti: string;
          token: string;
          expires_at: string;
          scope: string;
        };
        expect(body.token.split(".")).toHaveLength(3);
        expect(body.scope).toBe("scribe:transcribe");
        expect(typeof body.jti).toBe("string");
        // Round-trip the minted JWT through hub validation.
        const validated = await validateAccessToken(db, body.token, ISSUER);
        expect(validated.payload.scope).toBe("scribe:transcribe");
        expect(validated.payload.aud).toBe("scribe");
        expect(validated.payload.jti).toBe(body.jti);
        // Registry row was written.
        const row = db
          .query<{ jti: string; created_via: string; subject: string }, [string]>(
            "SELECT jti, created_via, subject FROM tokens WHERE jti = ?",
          )
          .get(body.jti);
        expect(row).not.toBeNull();
        expect(row?.created_via).toBe("cli_mint");
        // Default subject = bearer's sub = the userId.
        expect(row?.subject).toBe(userId);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("happy path: --scope-set=auth narrow operator token also passes the scope gate", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, {
          issuer: ISSUER,
          scopeSet: "auth",
        });
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "vault:read" }, { authorization: `Bearer ${op.token}` }),
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

  test("permissions object round-trips into JWT + registry row", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const permissions = { vault: { default: { write_tags: ["health"] } } };
        const resp = await handleApiMintToken(
          jsonRequest(
            { scope: "vault:default:write", permissions },
            { authorization: `Bearer ${op.token}` },
          ),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { token: string; jti: string; permissions: unknown };
        expect(body.permissions).toEqual(permissions);
        const validated = await validateAccessToken(db, body.token, ISSUER);
        expect(validated.payload.permissions).toEqual(permissions);
        const row = db
          .query<{ permissions: string }, [string]>("SELECT permissions FROM tokens WHERE jti = ?")
          .get(body.jti);
        expect(JSON.parse(row!.permissions)).toEqual(permissions);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when scope is missing", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest({}, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error: string; error_description: string };
        expect(body.error).toBe("invalid_request");
        expect(body.error_description).toContain("scope");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when expires_in exceeds 365d cap", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest(
            { scope: "vault:read", expires_in: 366 * 86400 },
            { authorization: `Bearer ${op.token}` },
          ),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error_description: string };
        expect(body.error_description).toContain("365d cap");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 when permissions is not an object", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest(
            { scope: "vault:read", permissions: ["not", "an", "object"] },
            { authorization: `Bearer ${op.token}` },
          ),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(400);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // closes #215 reviewer F1 — privilege-diffusion guard.
  test("400 invalid_scope when minting parachute:host:auth (non-requestable)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "parachute:host:auth" }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error: string; error_description: string };
        expect(body.error).toBe("invalid_scope");
        expect(body.error_description).toContain("parachute:host:auth");
        expect(body.error_description).toContain("not grantable");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("400 invalid_scope when multi-scope includes a non-requestable", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest(
            { scope: "vault:default:write parachute:host:admin" },
            { authorization: `Bearer ${op.token}` },
          ),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error: string; error_description: string };
        expect(body.error).toBe("invalid_scope");
        expect(body.error_description).toContain("parachute:host:admin");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // De-escalation (PR-A): a `parachute:host:admin` bearer MAY mint a
  // vault-pinned admin token — host:admin already implies box-wide vault
  // administration, so narrowing it to one vault is a privilege reduction.
  // This is the canonical headless path replacing deprecated pvt_* (vault#282).
  test("200 when host:admin bearer mints vault:<name>:admin (de-escalation)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        // The default admin operator scope-set carries parachute:host:admin.
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "vault:work:admin" }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { jti: string; token: string; scope: string };
        expect(body.scope).toBe("vault:work:admin");
        const validated = await validateAccessToken(db, body.token, ISSUER);
        // Audience must be the per-vault resource so vault's strict-equality
        // audience check accepts it.
        expect(validated.payload.aud).toBe("vault.work");
        expect(validated.payload.scope).toBe("vault:work:admin");
        // vault_scope is pinned to the named vault (defense-in-depth — the
        // token can ONLY be used against `work`), matching the canonical
        // session-path mint in admin-vault-admin-token.ts.
        expect(validated.payload.vault_scope).toEqual(["work"]);
        // Registry row written → revocable like any operator mint.
        const row = db
          .query<{ jti: string }, [string]>("SELECT jti FROM tokens WHERE jti = ?")
          .get(body.jti);
        expect(row).not.toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // Single-consent change (2026-05-29) — INTENTIONAL canGrant widening. Once
  // `vault:<name>:admin` became requestable (`isNonRequestableScope` dropped
  // the per-vault-admin clause), canGrant rule 1 (`!isNonRequestableScope` +
  // bearer holds `parachute:host:auth`) now ADMITS it. A `parachute:host:auth`
  // bearer is an on-box operator credential, so minting a vault-pinned admin
  // from it is a de-escalation, not an escalation. Pinned here so the widening
  // is deliberate, not an accidental regression.
  test("200 when auth-only bearer mints vault:<name>:admin (intentional canGrant widening)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, {
          issuer: ISSUER,
          scopeSet: "auth",
        });
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "vault:work:admin" }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { scope: string; token: string };
        expect(body.scope).toBe("vault:work:admin");
        const validated = await validateAccessToken(db, body.token, ISSUER);
        expect(validated.payload.aud).toBe("vault.work");
        expect(validated.payload.scope).toBe("vault:work:admin");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // Item B / hub#451 — bare `vault:admin` (no vault name) is NOT mintable on
  // the headless path. The unnamed broad-admin form has no resource pin; the
  // mint endpoint refuses it with 400 `invalid_scope` (even for a full host:admin
  // operator). The legitimate path for a vault admin token is a resource-narrowed
  // `vault:<name>:admin`. The OAuth flow still accepts bare `vault:admin` and
  // narrows it via the picker — that path is unaffected (see oauth-handlers).
  test("bare vault:admin (no name) → 400 (non-requestable headlessly, item B / #451)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "vault:admin" }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(400);
        const body = (await resp.json()) as { error: string; error_description: string };
        expect(body.error).toBe("invalid_scope");
        expect(body.error_description).toContain("vault:admin");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // Item B does NOT touch unnamed vault:read / vault:write — those carry no
  // admin authority and remain mintable (regression guard for the narrow scope
  // of the bare-admin block).
  test("bare vault:read still mints headlessly (item B is admin-only)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "vault:read" }, { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { token: string };
        const validated = await validateAccessToken(db, body.token, ISSUER);
        expect(validated.payload.aud).toBe("vault");
        expect(validated.payload.vault_scope).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // ── Capability attenuation (hub PR — subsumes hub#449's PR-A carve-out) ──
  //
  // A `vault:<name>:admin` bearer may mint a token whose authority is a
  // SUBSET of its own: same-vault read/write/admin. It can NEVER mint a
  // cross-vault scope or any host-level authority. We hand-mint the bearer
  // via signAccessToken (scope `vault:work:admin`, aud `vault.work`,
  // vaultScope `["work"]`) — mirroring how the SPA / mcp-install obtain one.
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

  describe("capability attenuation — vault:<name>:admin bearer", () => {
    test("mints vault:work:write → 200, aud=vault.work, vault_scope=[work]", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:write" }, { authorization: `Bearer ${bearer}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { token: string };
          const validated = await validateAccessToken(db, body.token, ISSUER);
          expect(validated.payload.aud).toBe("vault.work");
          expect(validated.payload.scope).toBe("vault:work:write");
          expect(validated.payload.vault_scope).toEqual(["work"]);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("mints vault:work:read → 200", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:read" }, { authorization: `Bearer ${bearer}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { token: string };
          const validated = await validateAccessToken(db, body.token, ISSUER);
          expect(validated.payload.vault_scope).toEqual(["work"]);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("mints vault:work:admin → 200 (same-level allowed)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:admin" }, { authorization: `Bearer ${bearer}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { token: string };
          const validated = await validateAccessToken(db, body.token, ISSUER);
          expect(validated.payload.aud).toBe("vault.work");
          expect(validated.payload.scope).toBe("vault:work:admin");
          expect(validated.payload.vault_scope).toEqual(["work"]);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    // THE CRUX: cross-vault is the security boundary. A work-admin bearer
    // MUST NOT be able to mint authority over any other vault.
    test("mints vault:other:write → 400 (cross-vault BLOCKED)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:other:write" }, { authorization: `Bearer ${bearer}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(400);
          const body = (await resp.json()) as { error: string; error_description: string };
          expect(body.error).toBe("invalid_scope");
          expect(body.error_description).toContain("vault:other:write");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("mints vault:other:admin → 400 (cross-vault BLOCKED)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:other:admin" }, { authorization: `Bearer ${bearer}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(400);
          const body = (await resp.json()) as { error: string };
          expect(body.error).toBe("invalid_scope");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("mints parachute:host:auth → 400 (no escalation to host authority)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "parachute:host:auth" }, { authorization: `Bearer ${bearer}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(400);
          const body = (await resp.json()) as { error: string };
          expect(body.error).toBe("invalid_scope");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("mints parachute:host:admin → 400 (no escalation to host authority)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "parachute:host:admin" }, { authorization: `Bearer ${bearer}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(400);
          const body = (await resp.json()) as { error: string };
          expect(body.error).toBe("invalid_scope");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    // No host:auth, and scribe:transcribe is not a vault:work scope → blocked.
    test("mints scribe:transcribe → 400 (not a vault:work scope, no host:auth)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "scribe:transcribe" }, { authorization: `Bearer ${bearer}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(400);
          const body = (await resp.json()) as { error: string };
          expect(body.error).toBe("invalid_scope");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("multi-scope vault:work:read vault:work:write → 200, vault_scope=[work]", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest(
              { scope: "vault:work:read vault:work:write" },
              { authorization: `Bearer ${bearer}` },
            ),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { token: string };
          const validated = await validateAccessToken(db, body.token, ISSUER);
          expect(validated.payload.vault_scope).toEqual(["work"]);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    // Realistic headless-runner shape: a bearer holding admin over MULTIPLE
    // vaults composes rule 3 across them. Minting same-vault subsets of both
    // succeeds; vault_scope collects every authorized vault name (order-
    // insensitive). aud is first-wins (vault.work), which is fine — a
    // multi-vault token only authenticates against its single aud, the pin is
    // defense-in-depth.
    test("multi-vault-admin bearer mints vault:work:read vault:other:read → 200, vault_scope=[work,other]", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await signAccessToken(db, {
            sub: userId,
            scopes: ["vault:work:admin", "vault:other:admin"],
            audience: "vault.work",
            clientId: "parachute-hub",
            issuer: ISSUER,
            ttlSeconds: 3600,
            vaultScope: ["work", "other"],
          });
          const resp = await handleApiMintToken(
            jsonRequest(
              { scope: "vault:work:read vault:other:read" },
              { authorization: `Bearer ${bearer.token}` },
            ),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { token: string };
          const validated = await validateAccessToken(db, body.token, ISSUER);
          expect(validated.payload.aud).toBe("vault.work");
          const pin = validated.payload.vault_scope as string[];
          expect(pin).toContain("work");
          expect(pin).toContain("other");
          expect(pin).toHaveLength(2);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    // One blocked scope rejects the whole request (no partial mint).
    test("multi-scope vault:work:read vault:other:read → 400 (one blocked → all rejected)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest(
              { scope: "vault:work:read vault:other:read" },
              { authorization: `Bearer ${bearer}` },
            ),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(400);
          const body = (await resp.json()) as { error: string; error_description: string };
          expect(body.error).toBe("invalid_scope");
          expect(body.error_description).toContain("vault:other:read");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    // Item A (subject-pin) — audit-attribution forgery. A non-operator
    // (vault-admin-only) bearer may NOT override the minted token's `sub`:
    // forging a foreign subject would mis-attribute the registry + revocation
    // rows. It may still mint under its OWN sub (subject omitted / equal).
    test("subject override by non-operator bearer → 403 (forgery blocked)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest(
              { scope: "vault:work:read", subject: "someone-else" },
              { authorization: `Bearer ${bearer}` },
            ),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(403);
          const body = (await resp.json()) as { error: string; error_description: string };
          expect(body.error).toBe("insufficient_scope");
          expect(body.error_description).toContain("non-operator");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("subject equal to own sub by non-operator bearer → 200 (no forgery)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const bearer = await mintVaultAdminBearer(db, userId, "work");
          const resp = await handleApiMintToken(
            jsonRequest(
              { scope: "vault:work:read", subject: userId },
              { authorization: `Bearer ${bearer}` },
            ),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { jti: string };
          const row = db
            .query<{ subject: string }, [string]>("SELECT subject FROM tokens WHERE jti = ?")
            .get(body.jti);
          expect(row?.subject).toBe(userId);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });
  });

  // Item A (subject-pin) — the operator carve-out: a host operator
  // (parachute:host:auth / parachute:host:admin) MAY override `sub` to stamp a
  // service-account subject. This is the documented service-account override
  // that the non-operator pin above must NOT break.
  describe("subject override — operator carve-out (item A)", () => {
    test("host:auth operator overrides subject → 200, registry row carries override", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER, scopeSet: "auth" });
          const resp = await handleApiMintToken(
            jsonRequest(
              { scope: "vault:work:read", subject: "svc-account" },
              { authorization: `Bearer ${op.token}` },
            ),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { jti: string; token: string };
          const validated = await validateAccessToken(db, body.token, ISSUER);
          expect(validated.payload.sub).toBe("svc-account");
          const row = db
            .query<{ subject: string }, [string]>("SELECT subject FROM tokens WHERE jti = ?")
            .get(body.jti);
          expect(row?.subject).toBe("svc-account");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("host:admin operator overrides subject → 200", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
          const resp = await handleApiMintToken(
            jsonRequest(
              { scope: "vault:work:admin", subject: "svc-account" },
              { authorization: `Bearer ${op.token}` },
            ),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { token: string };
          const validated = await validateAccessToken(db, body.token, ISSUER);
          expect(validated.payload.sub).toBe("svc-account");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });
  });

  describe("capability attenuation — entry gate + regression", () => {
    test("host:auth-only bearer mints vault:work:read → 200 (rule 1, preserved)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER, scopeSet: "auth" });
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:read" }, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { token: string };
          const validated = await validateAccessToken(db, body.token, ISSUER);
          // Pure host:auth requestable mint → no vault pin.
          expect(validated.payload.vault_scope).toEqual([]);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("host:auth-only bearer mints vault:work:admin → 200 (single-consent: rule 1 now covers admin)", async () => {
      // Single-consent change (2026-05-29): vault:<name>:admin is requestable
      // now, so canGrant rule 1 admits it for a host:auth bearer. De-escalation
      // from an on-box operator credential — intentional widening.
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER, scopeSet: "auth" });
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:admin" }, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { scope: string };
          expect(body.scope).toBe("vault:work:admin");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("host:admin bearer mints vault:work:admin → 200 (rule 2, PR-A preserved)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:admin" }, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { token: string };
          const validated = await validateAccessToken(db, body.token, ISSUER);
          expect(validated.payload.aud).toBe("vault.work");
          expect(validated.payload.vault_scope).toEqual(["work"]);
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    // Entry gate: a bearer with no host:* and no vault-admin holds no minting
    // authority → 403 before any per-scope check.
    test("403 entry gate when bearer holds no minting authority", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const noAuthority = await signAccessToken(db, {
            sub: userId,
            scopes: ["hub:admin", "scribe:transcribe"],
            audience: "hub",
            clientId: "parachute-hub",
            issuer: ISSUER,
            ttlSeconds: 3600,
          });
          const resp = await handleApiMintToken(
            jsonRequest(
              { scope: "vault:work:read" },
              { authorization: `Bearer ${noAuthority.token}` },
            ),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(403);
          const body = (await resp.json()) as { error: string };
          expect(body.error).toBe("insufficient_scope");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    // A read-only token used AS A BEARER is not minting authority → 403.
    test("403 entry gate when bearer is a vault:work:read token (read is not minting authority)", async () => {
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
          const resp = await handleApiMintToken(
            jsonRequest(
              { scope: "vault:work:read" },
              { authorization: `Bearer ${readOnly.token}` },
            ),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(403);
          const body = (await resp.json()) as { error: string };
          expect(body.error).toBe("insufficient_scope");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });
  });

  // ── Malformed vault-shaped scope guard (defensive hygiene, audit 2026-05-28) ──
  //
  // A `parachute:host:auth` bearer can craft scope strings that LOOK like a
  // named per-vault scope but slip past `isNonRequestableScope`'s strict
  // regexes, so `canGrant` rule 1 would admit them as "requestable" and mint a
  // junk registry row. They grant zero access today (the vault consumer rejects
  // them), so this isn't exploitable now — the mint-time shape check is a
  // backstop against a future consumer-normalization regression + registry
  // hygiene. It's an input-shape check, orthogonal to authority.
  describe("malformed vault-shaped scope rejection", () => {
    const MALFORMED = [
      "vault:work:ADMIN", // uppercase verb
      "vault::admin", // empty name
      "vault:work:read:admin", // extra segment
      "VAULT:work:admin", // uppercase resource
    ];

    for (const scope of MALFORMED) {
      test(`host:auth bearer minting ${scope} → 400 invalid_scope (malformed)`, async () => {
        const h = makeHarness();
        try {
          const { db, userId } = await bootstrap(h.dir);
          try {
            const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
            const resp = await handleApiMintToken(
              jsonRequest({ scope }, { authorization: `Bearer ${op.token}` }),
              { db, issuer: ISSUER },
            );
            expect(resp.status).toBe(400);
            const body = (await resp.json()) as { error: string; error_description: string };
            expect(body.error).toBe("invalid_scope");
            expect(body.error_description).toContain("malformed vault scope");
            expect(body.error_description).toContain(scope);
            // No junk registry row written — the request was rejected before
            // mint. The only `cli_mint` provenance comes from this endpoint;
            // the operator bearer's own row is `operator` provenance, so a
            // count of zero proves the malformed mint never landed.
            const row = db
              .query<{ n: number }, []>(
                "SELECT COUNT(*) AS n FROM tokens WHERE created_via = 'cli_mint'",
              )
              .get();
            expect(row?.n ?? 0).toBe(0);
          } finally {
            db.close();
          }
        } finally {
          h.cleanup();
        }
      });
    }

    // Regression: well-formed named scopes still mint (host:auth → read/write
    // via rule 1; host:admin → admin via rule 2). The guard is shape-only.
    test("host:auth bearer minting vault:work:read → 200 (well-formed, regression)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER, scopeSet: "auth" });
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:read" }, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { scope: string };
          expect(body.scope).toBe("vault:work:read");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("host:auth bearer minting vault:work:write → 200 (well-formed, regression)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER, scopeSet: "auth" });
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:write" }, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { scope: string };
          expect(body.scope).toBe("vault:work:write");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    test("host:admin bearer minting vault:work:admin → 200 (well-formed, attenuation path)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:admin" }, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { scope: string };
          expect(body.scope).toBe("vault:work:admin");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    // Contrast with the malformed forms above: a WELL-FORMED `vault:work:admin`
    // clears the shape guard, and (single-consent change, 2026-05-29) now mints
    // 200 via canGrant rule 1 for a host:auth bearer. The malformed forms are
    // rejected by the shape guard BEFORE canGrant; this one passes the guard
    // and is admitted.
    test("host:auth-only bearer minting well-formed vault:work:admin → 200 (clears shape guard, mints)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER, scopeSet: "auth" });
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "vault:work:admin" }, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { scope: string };
          expect(body.scope).toBe("vault:work:admin");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });

    // Non-vault scopes are entirely unaffected by the shape guard.
    test("host:auth bearer minting scribe:transcribe → 200 (non-vault, unaffected)", async () => {
      const h = makeHarness();
      try {
        const { db, userId } = await bootstrap(h.dir);
        try {
          const op = await mintOperatorToken(db, userId, { issuer: ISSUER, scopeSet: "auth" });
          const resp = await handleApiMintToken(
            jsonRequest({ scope: "scribe:transcribe" }, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as { scope: string };
          expect(body.scope).toBe("scribe:transcribe");
        } finally {
          db.close();
        }
      } finally {
        h.cleanup();
      }
    });
  });

  test("405 on non-POST", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const req = new Request("http://localhost/api/auth/mint-token", { method: "GET" });
        const resp = await handleApiMintToken(req, { db, issuer: ISSUER });
        expect(resp.status).toBe(405);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
