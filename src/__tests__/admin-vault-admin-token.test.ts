/**
 * Tests for the per-vault session→bearer mint endpoint. Mirrors
 * `admin-host-admin-token.test.ts` shape; differences:
 *   - Per-vault scope (`vault:<name>:admin`).
 *   - Vault name validated against the caller-supplied known-names set.
 *   - 404 on unknown name; 400 on syntactically invalid name.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VAULT_ADMIN_TOKEN_TTL_SECONDS,
  handleVaultAdminToken,
} from "../admin-vault-admin-token.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { validateAccessToken } from "../jwt-sign.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession, deleteSession } from "../sessions.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-vault-admin-token-"));
  const db = openHubDb(hubDbPath(dir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

async function withSession(): Promise<{ cookie: string; userId: string }> {
  const user = await createUser(harness.db, "operator", "hunter2");
  const session = createSession(harness.db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  return { cookie, userId: user.id };
}

const known = (...names: string[]): ReadonlySet<string> => new Set(names);

describe("handleVaultAdminToken", () => {
  test("401 when no session cookie is present", async () => {
    const req = new Request(`${ISSUER}/admin/vault-admin-token/default`);
    const res = await handleVaultAdminToken(req, "default", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: known("default"),
    });
    expect(res.status).toBe(401);
  });

  test("401 when the cookie names a deleted session", async () => {
    const { cookie } = await withSession();
    const sid = cookie.match(/parachute_hub_session=([^;]+)/)?.[1] ?? "";
    deleteSession(harness.db, sid);
    const req = new Request(`${ISSUER}/admin/vault-admin-token/default`, { headers: { cookie } });
    const res = await handleVaultAdminToken(req, "default", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: known("default"),
    });
    expect(res.status).toBe(401);
  });

  test("405 on POST", async () => {
    const { cookie } = await withSession();
    const req = new Request(`${ISSUER}/admin/vault-admin-token/default`, {
      method: "POST",
      headers: { cookie },
    });
    const res = await handleVaultAdminToken(req, "default", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: known("default"),
    });
    expect(res.status).toBe(405);
  });

  test("404 when the vault name isn't installed on this hub", async () => {
    const { cookie } = await withSession();
    const req = new Request(`${ISSUER}/admin/vault-admin-token/ghost`, { headers: { cookie } });
    const res = await handleVaultAdminToken(req, "ghost", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: known("default"),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("400 when the vault name is syntactically invalid", async () => {
    const { cookie } = await withSession();
    // The router slice can hand us anything; reject names that can't be a real
    // services.json key (slashes, dots, empty) before doing any DB work.
    const req = new Request(`${ISSUER}/admin/vault-admin-token/has..dots`, {
      headers: { cookie },
    });
    const res = await handleVaultAdminToken(req, "has..dots", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: known("has..dots"),
    });
    expect(res.status).toBe(400);
  });

  // Item I — uppercase names are rejected at the hub edge (lowercase-only,
  // matching vault's init). Rejected on shape (400) before the known-vault check.
  test("400 when the vault name contains uppercase letters (item I)", async () => {
    const { cookie } = await withSession();
    for (const name of ["Work", "WORK", "myVault"]) {
      const req = new Request(`${ISSUER}/admin/vault-admin-token/${name}`, {
        headers: { cookie },
      });
      const res = await handleVaultAdminToken(req, name, {
        db: harness.db,
        issuer: ISSUER,
        knownVaultNames: known(name, "work"),
      });
      expect(res.status).toBe(400);
    }
  });

  test("200 mints a JWT carrying vault:<name>:admin", async () => {
    const { cookie, userId } = await withSession();
    const req = new Request(`${ISSUER}/admin/vault-admin-token/work`, { headers: { cookie } });
    const res = await handleVaultAdminToken(req, "work", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: known("work", "default"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as { token: string; expires_at: string; scopes: string[] };
    expect(body.scopes).toEqual(["vault:work:admin"]);
    expect(body.token.length).toBeGreaterThan(20);

    const expMs = new Date(body.expires_at).getTime();
    const skew = expMs - Date.now();
    expect(skew).toBeGreaterThan((VAULT_ADMIN_TOKEN_TTL_SECONDS - 30) * 1000);
    expect(skew).toBeLessThan((VAULT_ADMIN_TOKEN_TTL_SECONDS + 30) * 1000);

    const validated = await validateAccessToken(harness.db, body.token, ISSUER);
    expect(validated.payload.sub).toBe(userId);
    expect(validated.payload.iss).toBe(ISSUER);
    // Per-vault audience: vault validates `aud === "vault.<name>"` against
    // its own URL-bound config (parachute-vault src/auth.ts ~line 167).
    // A constant `aud: "hub"` here would be rejected by every vault.
    expect(validated.payload.aud).toBe("vault.work");
    const scopeClaim = (validated.payload as { scope?: string }).scope ?? "";
    expect(scopeClaim.split(/\s+/)).toContain("vault:work:admin");
  });

  test("403 not_admin when the session belongs to a non-first-admin user", async () => {
    // Multi-user Phase 1 privesc gate (mirrors host-admin-token). The first-
    // created user is the hub admin; subsequent users are friends pinned to
    // a single vault and must NOT be able to mint vault:<name>:admin via
    // this endpoint. The session check alone would let them — that's the
    // whole reason this gate exists.
    await createUser(harness.db, "operator", "hunter2-admin");
    const friend = await createUser(harness.db, "friend", "hunter2-friend", {
      assignedVaults: ["work"],
      allowMulti: true,
    });
    const session = createSession(harness.db, { userId: friend.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
    const req = new Request(`${ISSUER}/admin/vault-admin-token/work`, { headers: { cookie } });
    const res = await handleVaultAdminToken(req, "work", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: known("work", "default"),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("not_admin");
    expect(body.error_description).toContain("/account/");
  });

  test("first admin still mints when other users exist", async () => {
    // Regression: the first-admin gate must not regress the operator's
    // happy path when there are friends in the DB.
    const admin = await createUser(harness.db, "operator", "hunter2-admin");
    await createUser(harness.db, "friend", "hunter2-friend", {
      assignedVaults: ["work"],
      allowMulti: true,
    });
    const session = createSession(harness.db, { userId: admin.id });
    const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
    const req = new Request(`${ISSUER}/admin/vault-admin-token/work`, { headers: { cookie } });
    const res = await handleVaultAdminToken(req, "work", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: known("work"),
    });
    expect(res.status).toBe(200);
  });

  test("audience is per-vault — different vaults get different aud claims", async () => {
    // Regression for PR #173 follow-up: a single shared audience constant
    // meant a token minted for vault `boulder` carried `aud: "hub"` and
    // got rejected by vault's strict-equality check against
    // `vault.boulder`. Mint twice and confirm each token is bound to its
    // own vault.
    const { cookie } = await withSession();
    const namesSet = known("default", "boulder");

    const reqDefault = new Request(`${ISSUER}/admin/vault-admin-token/default`, {
      headers: { cookie },
    });
    const resDefault = await handleVaultAdminToken(reqDefault, "default", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: namesSet,
    });
    expect(resDefault.status).toBe(200);
    const bodyDefault = (await resDefault.json()) as { token: string };
    const validatedDefault = await validateAccessToken(harness.db, bodyDefault.token, ISSUER);
    expect(validatedDefault.payload.aud).toBe("vault.default");

    const reqBoulder = new Request(`${ISSUER}/admin/vault-admin-token/boulder`, {
      headers: { cookie },
    });
    const resBoulder = await handleVaultAdminToken(reqBoulder, "boulder", {
      db: harness.db,
      issuer: ISSUER,
      knownVaultNames: namesSet,
    });
    expect(resBoulder.status).toBe(200);
    const bodyBoulder = (await resBoulder.json()) as { token: string };
    const validatedBoulder = await validateAccessToken(harness.db, bodyBoulder.token, ISSUER);
    expect(validatedBoulder.payload.aud).toBe("vault.boulder");
  });
});
