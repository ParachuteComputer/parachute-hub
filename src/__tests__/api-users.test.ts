/**
 * Tests for `/api/users*` (multi-user Phase 1, PR 2). Covers:
 *
 *   - Auth boundary: every endpoint requires a bearer carrying
 *     `parachute:host:admin`.
 *   - GET happy path (list, no hash leakage).
 *   - POST happy path + every validator branch (bad username
 *     format/length/reserved, password too short, password > 256 chars
 *     returns 413 BEFORE argon2id touches it, conflict 409 case-
 *     insensitive, assigned_vault missing-from-services.json returns
 *     400 `assigned_vault_not_found`).
 *   - DELETE happy path with token revocation; first-admin-undeletable
 *     returns 403; 404 on unknown id.
 *   - GET /api/users/vaults returns the same name set the OAuth issuer
 *     would resolve against.
 *   - 405 on wrong methods.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleCreateUser,
  handleDeleteUser,
  handleListUsers,
  handleListVaults,
} from "../api-users.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { findTokenRowByJti, recordTokenMint, signAccessToken } from "../jwt-sign.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";
const HOST_ADMIN_SCOPE = "parachute:host:admin";

interface Harness {
  db: Database;
  manifestPath: string;
  cleanup: () => void;
}

function makeHarness(servicesJson?: string): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-users-"));
  const db = openHubDb(hubDbPath(dir));
  const manifestPath = join(dir, "services.json");
  // Default manifest — empty services list; tests that want a vault can
  // override by passing servicesJson.
  writeFileSync(manifestPath, servicesJson ?? JSON.stringify({ services: [] }));
  return {
    db,
    manifestPath,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function manifestWithVaults(...names: string[]): string {
  // Single-entry shape: one `parachute-vault` service with N paths.
  const paths = names.map((n) => `/vault/${n}`);
  return JSON.stringify({
    services: [
      {
        name: "parachute-vault",
        port: 4101,
        paths,
        health: "/health",
        version: "0.0.0-test",
      },
    ],
  });
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

interface MintedBearer {
  bearer: string;
  jti: string;
  userId: string;
}

async function makeAdminBearer(
  scopes = [HOST_ADMIN_SCOPE],
  username = "operator",
): Promise<MintedBearer> {
  const user = await createUser(harness.db, username, "any-password", {
    allowMulti: true,
    passwordChanged: true,
  });
  const minted = await signAccessToken(harness.db, {
    sub: user.id,
    scopes,
    audience: "hub",
    clientId: "parachute-hub-spa",
    issuer: ISSUER,
    ttlSeconds: 600,
  });
  return { bearer: minted.token, jti: minted.jti, userId: user.id };
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${ISSUER}${path}`, init);
}

function withBearer(path: string, bearer: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${bearer}`);
  return new Request(`${ISSUER}${path}`, { ...init, headers });
}

function deps(): {
  db: Database;
  issuer: string;
  manifestPath: string;
} {
  return { db: harness.db, issuer: ISSUER, manifestPath: harness.manifestPath };
}

// ---------------------------------------------------------------------------
// GET /api/users — list users
// ---------------------------------------------------------------------------

describe("handleListUsers", () => {
  test("401 with no Authorization header", async () => {
    const res = await handleListUsers(req("/api/users"), deps());
    expect(res.status).toBe(401);
  });

  test("403 when bearer lacks parachute:host:admin", async () => {
    const { bearer } = await makeAdminBearer(["other:scope"]);
    const res = await handleListUsers(withBearer("/api/users", bearer), deps());
    expect(res.status).toBe(403);
  });

  test("405 on POST", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await handleListUsers(withBearer("/api/users", bearer, { method: "POST" }), deps());
    // The handler itself is GET-only; the hub-server dispatcher routes
    // POSTs to handleCreateUser. We assert the handler's own contract.
    expect(res.status).toBe(405);
  });

  test("lists users in created_at ASC order, omitting password_hash", async () => {
    const { bearer } = await makeAdminBearer();
    await createUser(harness.db, "alice", "alice-strong-password", {
      allowMulti: true,
    });
    const res = await handleListUsers(withBearer("/api/users", bearer), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      users: Array<Record<string, unknown>>;
    };
    expect(body.users.length).toBe(2);
    // First admin (operator) created first → first row.
    expect(body.users[0]?.username).toBe("operator");
    expect(body.users[1]?.username).toBe("alice");
    // Hash never leaks.
    for (const u of body.users) {
      expect(u).not.toHaveProperty("password_hash");
      expect(u).not.toHaveProperty("passwordHash");
      // Snake-case wire shape.
      expect(u).toHaveProperty("id");
      expect(u).toHaveProperty("username");
      expect(u).toHaveProperty("password_changed");
      expect(u).toHaveProperty("assigned_vault");
      expect(u).toHaveProperty("created_at");
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/users — create user
// ---------------------------------------------------------------------------

describe("handleCreateUser", () => {
  async function post(
    bearer: string,
    body: Record<string, unknown> | string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    };
    return await handleCreateUser(req("/api/users", init), deps());
  }

  test("401 with no Authorization header", async () => {
    const res = await handleCreateUser(req("/api/users", { method: "POST", body: "{}" }), deps());
    expect(res.status).toBe(401);
  });

  test("403 when bearer lacks parachute:host:admin", async () => {
    const { bearer } = await makeAdminBearer(["other:scope"]);
    const res = await post(bearer, { username: "x", password: "y" });
    expect(res.status).toBe(403);
  });

  test("happy path returns 201 + user with password_changed=false, no hash", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, {
      username: "alice",
      password: "alice-strong-passphrase",
      assignedVault: null,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user.username).toBe("alice");
    expect(body.user.password_changed).toBe(false);
    expect(body.user.assigned_vault).toBeNull();
    expect(body.user).not.toHaveProperty("password_hash");
  });

  test("rejects non-JSON content-type", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, "not-json", { "content-type": "text/plain" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  test("rejects malformed JSON body", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, "{not valid");
    expect(res.status).toBe(400);
  });

  test("400 invalid_username when username too short (length reason)", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, {
      username: "a",
      password: "strong-passphrase-123",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_username");
    expect(body.error_description).toMatch(/2-32/);
  });

  test("400 invalid_username when username has bad characters (format reason)", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, {
      username: "Alice",
      password: "strong-passphrase-123",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_username");
    expect(body.error_description).toMatch(/lowercase/);
  });

  test("400 invalid_username when username is reserved", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, {
      username: "admin",
      password: "strong-passphrase-123",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_username");
  });

  test("400 invalid_password when password is too short (< 12 chars)", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, {
      username: "alice",
      password: "short",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_password");
  });

  test("413 password_too_long when password > 256 chars (before argon2id touches it)", async () => {
    const { bearer } = await makeAdminBearer();
    const huge = "a".repeat(300);
    const t0 = Date.now();
    const res = await post(bearer, { username: "alice", password: huge });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("password_too_long");
    // Sanity check the cap fires before argon2id — a 300-char argon2id
    // hash is well into the hundreds of ms; the cap-and-reject path
    // should complete in <50ms on any sane runner. Floor of 200ms here
    // keeps the check noise-tolerant.
    expect(elapsed).toBeLessThan(200);
  });

  test("409 username_taken on exact-duplicate POST", async () => {
    const { bearer } = await makeAdminBearer();
    await post(bearer, {
      username: "alice",
      password: "alice-strong-passphrase",
    });
    const res = await post(bearer, {
      username: "alice",
      password: "alice-strong-passphrase",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("username_taken");
  });

  test("409 username_taken shadows a hand-inserted mixed-case legacy row (CI path)", async () => {
    // Insert a mixed-case row directly — bypasses the validator's
    // lowercase-only gate so we can prove the CI shadowing check
    // (`getUserByUsernameCI` / `COLLATE NOCASE`) actually fires. The
    // exact-duplicate test above can't exercise this path because the
    // validator rejects "Alice" with `invalid_username` (format) long
    // before the CI lookup runs.
    const stamp = "2026-05-20T00:00:00.000Z";
    harness.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, created_at, updated_at, password_changed, assigned_vault) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-id", "Alice", "$argon2id$fake", stamp, stamp, 1, null);
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, {
      username: "alice",
      password: "alice-strong-passphrase",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("username_taken");
  });

  test("400 assigned_vault_not_found when vault is not in services.json", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, {
      username: "alice",
      password: "alice-strong-passphrase",
      assignedVault: "ghost-vault",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("assigned_vault_not_found");
  });

  test("happy path with assigned_vault that exists in services.json", async () => {
    harness.cleanup();
    harness = makeHarness(manifestWithVaults("home"));
    const { bearer } = await makeAdminBearer();
    const res = await post(bearer, {
      username: "alice",
      password: "alice-strong-passphrase",
      assignedVault: "home",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: Record<string, unknown> };
    expect(body.user.assigned_vault).toBe("home");
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/users/:id — hard-delete user
// ---------------------------------------------------------------------------

describe("handleDeleteUser", () => {
  test("401 with no Authorization header", async () => {
    const res = await handleDeleteUser(
      req("/api/users/some-id", { method: "DELETE" }),
      "some-id",
      deps(),
    );
    expect(res.status).toBe(401);
  });

  test("403 when bearer lacks parachute:host:admin", async () => {
    const { bearer } = await makeAdminBearer(["other:scope"]);
    const res = await handleDeleteUser(
      withBearer("/api/users/some-id", bearer, { method: "DELETE" }),
      "some-id",
      deps(),
    );
    expect(res.status).toBe(403);
  });

  test("405 on GET", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await handleDeleteUser(
      withBearer("/api/users/some-id", bearer, { method: "GET" }),
      "some-id",
      deps(),
    );
    expect(res.status).toBe(405);
  });

  test("404 when user does not exist", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await handleDeleteUser(
      withBearer("/api/users/no-such-id", bearer, { method: "DELETE" }),
      "no-such-id",
      deps(),
    );
    expect(res.status).toBe(404);
  });

  test("403 first_admin_undeletable when deleting the earliest user", async () => {
    const { bearer, userId } = await makeAdminBearer();
    const res = await handleDeleteUser(
      withBearer(`/api/users/${userId}`, bearer, { method: "DELETE" }),
      userId,
      deps(),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("first_admin_undeletable");
    // The user row still exists (delete refused).
    const stillThere = await handleListUsers(withBearer("/api/users", bearer), deps());
    const list = (await stillThere.json()) as { users: Array<{ id: string }> };
    expect(list.users.map((u) => u.id)).toContain(userId);
  });

  test("204 deletes a non-first user and revokes their tokens", async () => {
    const { bearer } = await makeAdminBearer();
    // Create a second user (non-first) + mint a token on their behalf.
    const second = await createUser(harness.db, "alice", "alice-strong-passphrase", {
      allowMulti: true,
      passwordChanged: true,
    });
    const minted = await signAccessToken(harness.db, {
      sub: second.id,
      scopes: ["vault:home:read"],
      audience: "vault",
      clientId: "notes-client",
      issuer: ISSUER,
      ttlSeconds: 600,
    });
    // `signAccessToken` mints the JWT but doesn't write a `tokens` row.
    // Production paths that mint a registry-row token call
    // `recordTokenMint` immediately afterwards; mirror that here so the
    // delete-user revocation has something to flip + null.
    recordTokenMint(harness.db, {
      jti: minted.jti,
      createdVia: "operator_mint",
      subject: second.username,
      userId: second.id,
      clientId: "notes-client",
      scopes: ["vault:home:read"],
      expiresAt: minted.expiresAt,
    });
    expect(findTokenRowByJti(harness.db, minted.jti)?.revokedAt).toBeNull();

    const res = await handleDeleteUser(
      withBearer(`/api/users/${second.id}`, bearer, { method: "DELETE" }),
      second.id,
      deps(),
    );
    expect(res.status).toBe(204);

    // User row is gone.
    const listRes = await handleListUsers(withBearer("/api/users", bearer), deps());
    const list = (await listRes.json()) as { users: Array<{ id: string }> };
    expect(list.users.map((u) => u.id)).not.toContain(second.id);

    // Token row stays for audit but is now revoked + user_id NULLed +
    // subject backfilled with the username.
    const row = findTokenRowByJti(harness.db, minted.jti);
    expect(row).not.toBeNull();
    expect(row?.revokedAt).not.toBeNull();
    expect(row?.userId).toBeNull();
    expect(row?.subject).toBe("alice");
  });
});

// ---------------------------------------------------------------------------
// GET /api/users/vaults — vault-name list for the assigned-vault dropdown
// ---------------------------------------------------------------------------

describe("handleListVaults", () => {
  test("401 with no Authorization header", async () => {
    const res = await handleListVaults(req("/api/users/vaults"), deps());
    expect(res.status).toBe(401);
  });

  test("403 when bearer lacks parachute:host:admin", async () => {
    const { bearer } = await makeAdminBearer(["other:scope"]);
    const res = await handleListVaults(withBearer("/api/users/vaults", bearer), deps());
    expect(res.status).toBe(403);
  });

  test("405 on POST", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await handleListVaults(
      withBearer("/api/users/vaults", bearer, { method: "POST" }),
      deps(),
    );
    expect(res.status).toBe(405);
  });

  test("returns empty list when no vaults are registered", async () => {
    const { bearer } = await makeAdminBearer();
    const res = await handleListVaults(withBearer("/api/users/vaults", bearer), deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vaults: string[] };
    expect(body.vaults).toEqual([]);
  });

  test("returns sorted vault names from services.json", async () => {
    harness.cleanup();
    harness = makeHarness(manifestWithVaults("home", "work", "scratch"));
    const { bearer } = await makeAdminBearer();
    const res = await handleListVaults(withBearer("/api/users/vaults", bearer), deps());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vaults: string[] };
    expect(body.vaults).toEqual(["home", "scratch", "work"]);
  });
});
