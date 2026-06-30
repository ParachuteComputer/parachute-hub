import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdminAuthError,
  adminAuthErrorResponse,
  extractBearerToken,
  requireScope,
} from "../admin-auth.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";

const ISSUER = "http://127.0.0.1:1939";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-admin-auth-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function mintToken(
  db: ReturnType<typeof openHubDb>,
  scopes: string[],
  opts: { audience?: string; issuer?: string } = {},
): Promise<string> {
  const { token } = await signAccessToken(db, {
    sub: "user-test",
    scopes,
    audience: opts.audience ?? "operator",
    clientId: "test-client",
    issuer: opts.issuer ?? ISSUER,
  });
  return token;
}

function reqWithAuth(authHeader: string | null): Request {
  const headers = new Headers();
  if (authHeader !== null) headers.set("authorization", authHeader);
  return new Request("http://127.0.0.1:1939/test", { method: "POST", headers });
}

describe("extractBearerToken", () => {
  test("returns the token from a well-formed header", () => {
    const r = reqWithAuth("Bearer abc.def.ghi");
    expect(extractBearerToken(r)).toBe("abc.def.ghi");
  });

  test("accepts lowercase scheme", () => {
    const r = reqWithAuth("bearer abc.def.ghi");
    expect(extractBearerToken(r)).toBe("abc.def.ghi");
  });

  test("throws 401 when header missing", () => {
    const r = reqWithAuth(null);
    expect(() => extractBearerToken(r)).toThrow(AdminAuthError);
    try {
      extractBearerToken(r);
    } catch (err) {
      expect((err as AdminAuthError).status).toBe(401);
    }
  });

  test("throws 401 when scheme is not Bearer", () => {
    const r = reqWithAuth("Basic dXNlcjpwYXNz");
    expect(() => extractBearerToken(r)).toThrow(AdminAuthError);
  });
});

describe("requireScope", () => {
  test("returns context for a token with the required scope", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const token = await mintToken(db, ["parachute:host:admin", "vault:admin"]);
        const ctx = await requireScope(
          db,
          reqWithAuth(`Bearer ${token}`),
          "parachute:host:admin",
          ISSUER,
        );
        expect(ctx.sub).toBe("user-test");
        expect(ctx.scopes).toContain("parachute:host:admin");
        expect(ctx.clientId).toBe("test-client");
        expect(ctx.audience).toBe("operator");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("rejects 403 when token lacks the required scope", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const token = await mintToken(db, ["vault:read"]);
        let caught: AdminAuthError | null = null;
        try {
          await requireScope(db, reqWithAuth(`Bearer ${token}`), "parachute:host:admin", ISSUER);
        } catch (err) {
          caught = err as AdminAuthError;
        }
        expect(caught).not.toBeNull();
        expect(caught?.status).toBe(403);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("rejects 401 when issuer mismatches", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const token = await mintToken(db, ["parachute:host:admin"], {
          issuer: "http://127.0.0.1:9999",
        });
        let caught: AdminAuthError | null = null;
        try {
          await requireScope(db, reqWithAuth(`Bearer ${token}`), "parachute:host:admin", ISSUER);
        } catch (err) {
          caught = err as AdminAuthError;
        }
        expect(caught?.status).toBe(401);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("rejects 401 when token is unverifiable garbage", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        let caught: AdminAuthError | null = null;
        try {
          await requireScope(
            db,
            reqWithAuth("Bearer not-a-real-jwt"),
            "parachute:host:admin",
            ISSUER,
          );
        } catch (err) {
          caught = err as AdminAuthError;
        }
        expect(caught?.status).toBe(401);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("requireScope multi-origin issuer set (hub#516 parity)", () => {
  // The hub answers on several legitimate origins after `parachute hub
  // set-origin` / `expose` (loopback ∪ tunnel ∪ public). A credential minted
  // under a still-valid prior origin must keep validating at admin-auth even
  // when the per-request canonical issuer is now a different member of the set.
  const LOOPBACK = "http://127.0.0.1:1939";
  const TUNNEL = "https://brain.gitcoin.co";
  const FOREIGN = "https://evil.example.com";

  test("accepts a token whose iss is in the set but ≠ the per-request canonical", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // Token minted under the TUNNEL origin (e.g. before `set-origin`)…
        const token = await mintToken(db, ["parachute:host:admin"], { issuer: TUNNEL });
        // …presented to admin-auth where the canonical per-request issuer is now
        // LOOPBACK, but the bound-origin set still includes TUNNEL.
        const ctx = await requireScope(db, reqWithAuth(`Bearer ${token}`), "parachute:host:admin", [
          LOOPBACK,
          TUNNEL,
        ]);
        expect(ctx.sub).toBe("user-test");
        expect(ctx.scopes).toContain("parachute:host:admin");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("rejects 401 when iss is OUTSIDE the set", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const token = await mintToken(db, ["parachute:host:admin"], { issuer: FOREIGN });
        let caught: AdminAuthError | null = null;
        try {
          await requireScope(db, reqWithAuth(`Bearer ${token}`), "parachute:host:admin", [
            LOOPBACK,
            TUNNEL,
          ]);
        } catch (err) {
          caught = err as AdminAuthError;
        }
        expect(caught?.status).toBe(401);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("rejects 401 on signature failure regardless of the set (signature-first)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        // A hub-signed token, then rotate keys + retire so the original kid no
        // longer verifies — the JWKS signature gate must fire before any iss
        // membership check, so an in-set iss can't rescue an unverifiable token.
        let caught: AdminAuthError | null = null;
        try {
          await requireScope(db, reqWithAuth("Bearer not-a-real-jwt"), "parachute:host:admin", [
            LOOPBACK,
            TUNNEL,
          ]);
        } catch (err) {
          caught = err as AdminAuthError;
        }
        expect(caught?.status).toBe(401);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("single-string back-compat: in-set iss as a lone string still validates", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const token = await mintToken(db, ["parachute:host:admin"], { issuer: ISSUER });
        // A single-element set behaves exactly like the prior single-string form.
        const ctx = await requireScope(db, reqWithAuth(`Bearer ${token}`), "parachute:host:admin", [
          ISSUER,
        ]);
        expect(ctx.sub).toBe("user-test");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("single-element set rejects a non-matching iss (no accidental widening)", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const token = await mintToken(db, ["parachute:host:admin"], { issuer: TUNNEL });
        let caught: AdminAuthError | null = null;
        try {
          await requireScope(db, reqWithAuth(`Bearer ${token}`), "parachute:host:admin", [ISSUER]);
        } catch (err) {
          caught = err as AdminAuthError;
        }
        expect(caught?.status).toBe(401);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});

describe("adminAuthErrorResponse", () => {
  test("403 → insufficient_scope with WWW-Authenticate", async () => {
    const res = adminAuthErrorResponse(new AdminAuthError(403, "needs admin"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("insufficient_scope");
    expect(res.headers.get("www-authenticate") ?? "").toContain("insufficient_scope");
  });

  test("401 → invalid_token", async () => {
    const res = adminAuthErrorResponse(new AdminAuthError(401, "bad sig"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_token");
  });

  test("non-AdminAuthError → 500 server_error", async () => {
    const res = adminAuthErrorResponse(new Error("boom"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_error");
  });
});
