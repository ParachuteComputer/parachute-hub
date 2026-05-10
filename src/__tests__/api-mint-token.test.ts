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
        expect(body.error_description).toContain("not requestable");
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

  test("400 invalid_scope when minting vault:<name>:admin (regex non-requestable)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiMintToken(
          jsonRequest({ scope: "vault:work:admin" }, { authorization: `Bearer ${op.token}` }),
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
