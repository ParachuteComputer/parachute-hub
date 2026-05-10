import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRevocationList } from "../api-revocation-list.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { recordTokenMint, revokeTokenByJti, signRefreshToken } from "../jwt-sign.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

interface Harness {
  dir: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-revocation-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("GET /.well-known/parachute-revocation.json (hub#212 Phase 1)", () => {
  test("empty list when nothing revoked", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const req = new Request("http://localhost/.well-known/parachute-revocation.json");
        const resp = handleRevocationList(req, { db });
        expect(resp.status).toBe(200);
        expect(resp.headers.get("content-type")).toBe("application/json");
        expect(resp.headers.get("cache-control")).toBe("public, max-age=60");
        const body = (await resp.json()) as { generated_at: string; jtis: string[] };
        expect(body.jtis).toEqual([]);
        expect(typeof body.generated_at).toBe("string");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("returns revoked jti after revokeTokenByJti", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const futureExpiry = new Date(Date.now() + 86400_000).toISOString();
        recordTokenMint(db, {
          jti: "jti-revoked-1",
          createdVia: "cli_mint",
          subject: "operator",
          clientId: "parachute-hub",
          scopes: ["scribe:transcribe"],
          expiresAt: futureExpiry,
        });
        recordTokenMint(db, {
          jti: "jti-active-1",
          createdVia: "cli_mint",
          subject: "operator",
          clientId: "parachute-hub",
          scopes: ["vault:read"],
          expiresAt: futureExpiry,
        });
        revokeTokenByJti(db, "jti-revoked-1", new Date());

        const req = new Request("http://localhost/.well-known/parachute-revocation.json");
        const resp = handleRevocationList(req, { db });
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { jtis: string[] };
        expect(body.jtis).toEqual(["jti-revoked-1"]);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("filters out already-expired revoked jtis", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const past = new Date(Date.now() - 86400_000).toISOString();
        const future = new Date(Date.now() + 86400_000).toISOString();
        // Revoked but expired — should NOT appear in the list (consumers'
        // own exp check would reject it anyway; listing it is noise).
        recordTokenMint(db, {
          jti: "jti-expired-revoked",
          createdVia: "cli_mint",
          subject: "operator",
          clientId: "parachute-hub",
          scopes: ["vault:read"],
          expiresAt: past,
        });
        recordTokenMint(db, {
          jti: "jti-active-revoked",
          createdVia: "cli_mint",
          subject: "operator",
          clientId: "parachute-hub",
          scopes: ["vault:read"],
          expiresAt: future,
        });
        revokeTokenByJti(db, "jti-expired-revoked", new Date());
        revokeTokenByJti(db, "jti-active-revoked", new Date());

        const req = new Request("http://localhost/.well-known/parachute-revocation.json");
        const resp = handleRevocationList(req, { db });
        const body = (await resp.json()) as { jtis: string[] };
        expect(body.jtis).toEqual(["jti-active-revoked"]);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("OAuth-refresh rows participate in the same revocation surface", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const u = await createUser(db, "owner", "pw");
        // signRefreshToken writes a row with created_via='oauth_refresh';
        // revoking by jti must surface it the same way as cli_mint rows.
        const refresh = signRefreshToken(db, {
          jti: "jti-oauth-refresh-1",
          userId: u.id,
          clientId: "parachute-hub",
          scopes: ["vault:read"],
        });
        expect(refresh.familyId).toBeDefined();
        revokeTokenByJti(db, "jti-oauth-refresh-1", new Date());

        const req = new Request("http://localhost/.well-known/parachute-revocation.json");
        const resp = handleRevocationList(req, { db });
        const body = (await resp.json()) as { jtis: string[] };
        expect(body.jtis).toContain("jti-oauth-refresh-1");
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("rejects non-GET methods with 405", async () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const req = new Request("http://localhost/.well-known/parachute-revocation.json", {
          method: "POST",
        });
        const resp = handleRevocationList(req, { db });
        expect(resp.status).toBe(405);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });

  test("revokeTokenByJti is idempotent — second call returns false", () => {
    const h = makeHarness();
    try {
      const db = openHubDb(hubDbPath(h.dir));
      try {
        rotateSigningKey(db);
        const future = new Date(Date.now() + 86400_000).toISOString();
        recordTokenMint(db, {
          jti: "jti-once",
          createdVia: "cli_mint",
          subject: "operator",
          clientId: "parachute-hub",
          scopes: ["vault:read"],
          expiresAt: future,
        });
        const now = new Date();
        expect(revokeTokenByJti(db, "jti-once", now)).toBe(true);
        expect(revokeTokenByJti(db, "jti-once", now)).toBe(false);
        expect(revokeTokenByJti(db, "jti-does-not-exist", now)).toBe(false);
      } finally {
        db.close();
      }
    } finally {
      h.cleanup();
    }
  });
});
