import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApiTokens } from "../api-tokens.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { recordTokenMint, revokeTokenByJti, signAccessToken } from "../jwt-sign.ts";
import { mintOperatorToken } from "../operator-token.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-tokens-"));
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

function getRequest(query = "", headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/auth/tokens${query}`, {
    method: "GET",
    headers,
  });
}

interface SeedOpts {
  scopes?: string[];
  subject?: string;
  /** Set to a non-null Date to mark the row revoked at that time. */
  revokedAt?: Date | null;
  /** Override created_at — drives ORDER BY. Tests use ascending real timestamps. */
  createdAt?: Date;
  /** Mint provenance for the registry row. Defaults to `cli_mint`. */
  createdVia?: "cli_mint" | "operator_mint";
}

async function seed(
  db: ReturnType<typeof openHubDb>,
  userId: string,
  opts: SeedOpts = {},
): Promise<string> {
  const scopes = opts.scopes ?? ["scribe:transcribe"];
  const subject = opts.subject ?? userId;
  const createdAt = opts.createdAt ?? new Date();
  const createdVia = opts.createdVia ?? "cli_mint";
  const signed = await signAccessToken(db, {
    sub: subject,
    scopes,
    audience: "scribe",
    clientId: "parachute-hub",
    issuer: ISSUER,
    ttlSeconds: 3600,
    now: () => createdAt,
  });
  recordTokenMint(db, {
    jti: signed.jti,
    createdVia,
    subject,
    clientId: "parachute-hub",
    scopes,
    expiresAt: signed.expiresAt,
    now: () => createdAt,
  });
  if (opts.revokedAt) {
    revokeTokenByJti(db, signed.jti, opts.revokedAt);
  }
  return signed.jti;
}

describe("GET /api/auth/tokens (admin token list — Phase 2 backend)", () => {
  test("405 on non-GET", async () => {
    const h = makeHarness();
    try {
      const { db } = await bootstrap(h.dir);
      try {
        const req = new Request("http://localhost/api/auth/tokens", { method: "POST" });
        const resp = await handleApiTokens(req, { db, issuer: ISSUER });
        expect(resp.status).toBe(405);
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
        const resp = await handleApiTokens(getRequest(), { db, issuer: ISSUER });
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
        const resp = await handleApiTokens(
          getRequest("", { authorization: `Bearer ${narrow.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(403);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // H1.1 — Bearer scheme is case-insensitive per RFC 7235 (V1.4/C1.3 parity).
  test("lowercase bearer scheme authenticates identically to canonical Bearer", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiTokens(
          getRequest("", { authorization: `bearer ${op.token}` }),
          {
            db,
            issuer: ISSUER,
          },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { tokens: unknown[] };
        expect(body.tokens).toHaveLength(1);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("mixed-case bearer scheme (BeArEr) authenticates identically to canonical Bearer", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiTokens(
          getRequest("", { authorization: `BeArEr ${op.token}` }),
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

  test("happy path: empty registry returns empty array", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiTokens(
          getRequest("", { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
          tokens: unknown[];
          next_cursor: string | null;
        };
        // mintOperatorToken seeds one row; no other seeds.
        expect(body.tokens).toHaveLength(1);
        expect(body.next_cursor).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("returns rows newest-first with full surface of fields", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        // Seed rows AFTER the operator-token row so they sort ahead under
        // newest-first. mintOperatorToken stamps real `Date.now()`, so we
        // need our seed timestamps to be strictly later than that.
        const baseTime = Date.now() + 60_000; // 1 min in the future
        const a = await seed(db, userId, {
          scopes: ["a:read"],
          createdAt: new Date(baseTime + 1000),
        });
        const b = await seed(db, userId, {
          scopes: ["b:write"],
          createdAt: new Date(baseTime + 2000),
        });
        const c = await seed(db, userId, {
          scopes: ["c:admin"],
          createdAt: new Date(baseTime + 3000),
        });

        const resp = await handleApiTokens(
          getRequest("", { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
          tokens: Array<{
            jti: string;
            user_id: string | null;
            subject: string | null;
            client_id: string;
            scopes: string[];
            expires_at: string;
            revoked_at: string | null;
            created_at: string;
            created_via: string;
            permissions: Record<string, unknown> | null;
          }>;
        };
        // Newest-first: c, b, a, then op (which was minted before via mintOperatorToken).
        const jtis = body.tokens.map((t) => t.jti);
        expect(jtis.slice(0, 3)).toEqual([c, b, a]);

        // Surface check on the most recent row.
        const newest = body.tokens[0]!;
        expect(newest.scopes).toEqual(["c:admin"]);
        expect(newest.created_via).toBe("cli_mint");
        expect(newest.subject).toBe(userId);
        expect(newest.revoked_at).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("?revoked=true filters to revoked rows only", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const live = await seed(db, userId, { scopes: ["live:r"] });
        const dead = await seed(db, userId, {
          scopes: ["dead:r"],
          revokedAt: new Date(),
        });

        const resp = await handleApiTokens(
          getRequest("?revoked=true", { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { tokens: Array<{ jti: string }> };
        const jtis = body.tokens.map((t) => t.jti);
        expect(jtis).toContain(dead);
        expect(jtis).not.toContain(live);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("?revoked=false filters to un-revoked rows only", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const live = await seed(db, userId, { scopes: ["live:r"] });
        const dead = await seed(db, userId, {
          scopes: ["dead:r"],
          revokedAt: new Date(),
        });

        const resp = await handleApiTokens(
          getRequest("?revoked=false", { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { tokens: Array<{ jti: string }> };
        const jtis = body.tokens.map((t) => t.jti);
        expect(jtis).toContain(live);
        expect(jtis).not.toContain(dead);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("?revoked=all returns both revoked and un-revoked rows (explicit, mirrors omit-default)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const live = await seed(db, userId, { scopes: ["live:r"] });
        const dead = await seed(db, userId, {
          scopes: ["dead:r"],
          revokedAt: new Date(),
        });

        const resp = await handleApiTokens(
          getRequest("?revoked=all", { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { tokens: Array<{ jti: string }> };
        const jtis = body.tokens.map((t) => t.jti);
        expect(jtis).toContain(live);
        expect(jtis).toContain(dead);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("permissions field is parsed to native object (not raw JSON string)", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        // Mint a row WITH a permissions claim. The CLI / api-mint-token
        // path stores it as JSON-string in the registry; the wire shape
        // surfaces it parsed so the UI doesn't need a JSON.parse step.
        const permissions = { vault: { default: { write_tags: ["health"] } } };
        const signed = await signAccessToken(db, {
          sub: userId,
          scopes: ["vault:default:write"],
          audience: "vault.default",
          clientId: "parachute-hub",
          issuer: ISSUER,
          ttlSeconds: 3600,
          extraClaims: { permissions },
        });
        recordTokenMint(db, {
          jti: signed.jti,
          createdVia: "cli_mint",
          subject: userId,
          clientId: "parachute-hub",
          scopes: ["vault:default:write"],
          expiresAt: signed.expiresAt,
          permissions: JSON.stringify(permissions),
        });

        const resp = await handleApiTokens(
          getRequest(`?subject=${encodeURIComponent(userId)}`, {
            authorization: `Bearer ${op.token}`,
          }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
          tokens: Array<{ jti: string; permissions: Record<string, unknown> | null }>;
        };
        const row = body.tokens.find((t) => t.jti === signed.jti);
        expect(row).toBeDefined();
        // Wire shape returns native object (deep equality), NOT a string.
        expect(row?.permissions).toEqual(permissions);
        expect(typeof row?.permissions).toBe("object");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("?revoked=invalid → 400", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiTokens(
          getRequest("?revoked=maybe", { authorization: `Bearer ${op.token}` }),
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

  test("?subject=<value> matches user_id OR subject column", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        // Seed two rows under two different "subject" values.
        const mine = await seed(db, userId, { subject: userId });
        const theirs = await seed(db, userId, { subject: "service-a" });

        const respMine = await handleApiTokens(
          getRequest(`?subject=${encodeURIComponent(userId)}`, {
            authorization: `Bearer ${op.token}`,
          }),
          { db, issuer: ISSUER },
        );
        const bodyMine = (await respMine.json()) as { tokens: Array<{ jti: string }> };
        const jtisMine = bodyMine.tokens.map((t) => t.jti);
        expect(jtisMine).toContain(mine);
        expect(jtisMine).not.toContain(theirs);

        const respTheirs = await handleApiTokens(
          getRequest("?subject=service-a", { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        const bodyTheirs = (await respTheirs.json()) as { tokens: Array<{ jti: string }> };
        const jtisTheirs = bodyTheirs.tokens.map((t) => t.jti);
        expect(jtisTheirs).toContain(theirs);
        expect(jtisTheirs).not.toContain(mine);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  // No dedicated `?created_via=oauth_refresh` filter test — the WHERE clause
  // is identical for all three created_via values (parameterized SQL), and
  // seeding an `oauth_refresh` row requires calling `signRefreshToken` (the
  // OAuth grant path) rather than the test helper's `cli_mint`/`operator_mint`
  // arms. The two value-specific tests below pin the filter logic;
  // `oauth_refresh` would add no new coverage.
  test("?created_via=cli_mint narrows to CLI-minted rows", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        // mintOperatorToken seeds an operator_mint row already.
        const cliJti = await seed(db, userId, { createdVia: "cli_mint" });
        const opJti = await seed(db, userId, { createdVia: "operator_mint" });

        const resp = await handleApiTokens(
          getRequest("?created_via=cli_mint", { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
          tokens: Array<{ jti: string; created_via: string }>;
        };
        const jtis = body.tokens.map((t) => t.jti);
        expect(jtis).toContain(cliJti);
        expect(jtis).not.toContain(opJti);
        // Every returned row reports created_via=cli_mint (sanity).
        expect(body.tokens.every((t) => t.created_via === "cli_mint")).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("?created_via=operator_mint narrows to operator-token rows", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const cliJti = await seed(db, userId, { createdVia: "cli_mint" });
        const opJti = await seed(db, userId, { createdVia: "operator_mint" });

        const resp = await handleApiTokens(
          getRequest("?created_via=operator_mint", { authorization: `Bearer ${op.token}` }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as {
          tokens: Array<{ jti: string; created_via: string }>;
        };
        const jtis = body.tokens.map((t) => t.jti);
        expect(jtis).toContain(opJti);
        expect(jtis).not.toContain(cliJti);
        expect(body.tokens.every((t) => t.created_via === "operator_mint")).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("?created_via composes with ?revoked", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const liveCli = await seed(db, userId, { createdVia: "cli_mint" });
        const deadCli = await seed(db, userId, {
          createdVia: "cli_mint",
          revokedAt: new Date(),
        });
        const liveOp = await seed(db, userId, { createdVia: "operator_mint" });

        const resp = await handleApiTokens(
          getRequest("?revoked=false&created_via=cli_mint", {
            authorization: `Bearer ${op.token}`,
          }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { tokens: Array<{ jti: string }> };
        const jtis = body.tokens.map((t) => t.jti);
        expect(jtis).toContain(liveCli);
        expect(jtis).not.toContain(deadCli); // wrong revoked status
        expect(jtis).not.toContain(liveOp); // wrong created_via
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("?created_via=invalid → 400", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        const resp = await handleApiTokens(
          getRequest("?created_via=bogus", { authorization: `Bearer ${op.token}` }),
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

  test("cursor pagination: round-trip walks all rows newest-first without dupes or gaps", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        // Seed 7 rows with monotonically-increasing created_at so order is
        // deterministic. The default page size is 50, so we hand-construct a
        // smaller page via direct listTokens — but for the API endpoint here
        // we exercise the cursor flow with the default size by creating
        // enough rows AND temporarily setting a small limit via a new query
        // string. The endpoint itself doesn't expose a `limit` param; it
        // uses the default. So we exercise pagination by seeding 51 rows
        // and walking the cursor.
        // Same future-relative trick as the prior test — operator-token
        // row stamps real Date.now() and would otherwise interleave.
        const baseTime = Date.now() + 60_000;
        const seededJtis: string[] = [];
        // 51 rows in addition to the operator token = 52 total. Page 1 = 50,
        // page 2 = 2.
        for (let i = 0; i < 51; i++) {
          const j = await seed(db, userId, {
            scopes: [`scope-${i}:r`],
            createdAt: new Date(baseTime + i * 1000),
          });
          seededJtis.push(j);
        }
        // Newest-first means seededJtis[50], [49], ..., [0], then op.
        const expectedOrder = [...seededJtis].reverse();

        const collected: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 5; page++) {
          const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
          const resp = await handleApiTokens(
            getRequest(q, { authorization: `Bearer ${op.token}` }),
            { db, issuer: ISSUER },
          );
          expect(resp.status).toBe(200);
          const body = (await resp.json()) as {
            tokens: Array<{ jti: string }>;
            next_cursor: string | null;
          };
          collected.push(...body.tokens.map((t) => t.jti));
          cursor = body.next_cursor;
          if (!cursor) break;
        }

        // First 51 = our seeded rows in newest-first order.
        expect(collected.slice(0, 51)).toEqual(expectedOrder);
        // 52nd row = the operator-mint row (it predates the seeded ones).
        expect(collected).toHaveLength(52);
        // No dupes.
        expect(new Set(collected).size).toBe(52);
        // Final cursor is null (we walked to the end).
        expect(cursor).toBeNull();
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("malformed cursor silently resets to page 1", async () => {
    const h = makeHarness();
    try {
      const { db, userId } = await bootstrap(h.dir);
      try {
        const op = await mintOperatorToken(db, userId, { issuer: ISSUER });
        await seed(db, userId);
        const resp = await handleApiTokens(
          getRequest("?cursor=this-is-not-base64-json", {
            authorization: `Bearer ${op.token}`,
          }),
          { db, issuer: ISSUER },
        );
        expect(resp.status).toBe(200);
        // Returned the full set (no implicit filter from a corrupt cursor).
        const body = (await resp.json()) as { tokens: unknown[] };
        expect(body.tokens.length).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
