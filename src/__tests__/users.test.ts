import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { recordTokenMint, signAccessToken } from "../jwt-sign.ts";
import { createSession, findSession } from "../sessions.ts";
import {
  PASSWORD_MIN_LEN,
  SingleUserModeError,
  USERNAME_RESERVED,
  UserNotFoundError,
  UsernameTakenError,
  createUser,
  deleteUser,
  getFirstAdminId,
  getUserById,
  getUserByUsername,
  getUserByUsernameCI,
  isFirstAdmin,
  listUsers,
  resetUserPassword,
  setPassword,
  setUserVaults,
  userCount,
  validateEmail,
  validatePassword,
  validateUsername,
  vaultVerbsForRole,
  vaultVerbsForUserVault,
  verifyPassword,
} from "../users.ts";

function makeDb() {
  const configDir = mkdtempSync(join(tmpdir(), "phub-users-"));
  const db = openHubDb(hubDbPath(configDir));
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

describe("createUser", () => {
  // Note: createUser doesn't call validatePassword directly (PR 2 wires
  // it at the endpoint layer). These short passwords ("hunter2", "pw1",
  // etc.) are deliberate for testing the argon2id round-trip + the
  // INSERT shape in isolation; PR 2's endpoint tests will use full-
  // length (12+ char) passwords against the validator-gated path.
  test("creates a user and stores an argon2id hash", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "hunter2");
      expect(u.username).toBe("owner");
      expect(u.id.length).toBeGreaterThan(0);
      // Argon2id encoded form starts with $argon2id$.
      expect(u.passwordHash.startsWith("$argon2id$")).toBe(true);
      expect(u.createdAt).toBe(u.updatedAt);
      expect(userCount(db)).toBe(1);
      // Default multi-user-Phase-1 shape: unchanged password, no vault pin.
      expect(u.passwordChanged).toBe(false);
      expect(u.assignedVaults).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("passwordChanged opt-in lands the bit set (wizard / env-seed path)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "hunter2", { passwordChanged: true });
      expect(u.passwordChanged).toBe(true);
      // Round-trip through getUserById so we know it's persisted, not
      // just returned by the in-memory createUser result.
      const fresh = getUserById(db, u.id);
      expect(fresh?.passwordChanged).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("assignedVaults opt-in persists each vault (admin-creates-user path)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "pw1", {
        allowMulti: true,
        assignedVaults: ["alice"],
      });
      expect(u.assignedVaults).toEqual(["alice"]);
      const fresh = getUserById(db, u.id);
      expect(fresh?.assignedVaults).toEqual(["alice"]);
    } finally {
      cleanup();
    }
  });

  test("assignedVaults with multiple entries — all persist (multi-vault Phase 2)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "pw1", {
        allowMulti: true,
        assignedVaults: ["personal", "family"],
      });
      expect(u.assignedVaults).toEqual(["personal", "family"]);
      const fresh = getUserById(db, u.id);
      // Loaded via the user_vaults JOIN — order matches insertion order
      // because rows share the same `created_at` timestamp and tie-break
      // on `vault_name` ASC. `family` precedes `personal` alphabetically.
      expect(fresh?.assignedVaults.length).toBe(2);
      expect(new Set(fresh?.assignedVaults)).toEqual(new Set(["personal", "family"]));
    } finally {
      cleanup();
    }
  });

  test("assignedVaults omitted defaults to empty array (admin posture)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "admin1", "pw1");
      expect(u.assignedVaults).toEqual([]);
      const fresh = getUserById(db, u.id);
      expect(fresh?.assignedVaults).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("assignedVaults de-duplicates repeated names", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "pw1", {
        allowMulti: true,
        assignedVaults: ["personal", "personal", "family"],
      });
      // De-dupe is silent; user gets one row per distinct name.
      expect(u.assignedVaults).toEqual(["personal", "family"]);
      const fresh = getUserById(db, u.id);
      expect(fresh?.assignedVaults.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("refuses a second user without --allow-multi (single-user mode)", async () => {
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "owner", "pw1");
      await expect(createUser(db, "second", "pw2")).rejects.toThrow(SingleUserModeError);
      expect(userCount(db)).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("allows a second user when allowMulti is true", async () => {
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "owner", "pw1");
      const second = await createUser(db, "second", "pw2", { allowMulti: true });
      expect(second.username).toBe("second");
      expect(userCount(db)).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("refuses a duplicate username with UsernameTakenError", async () => {
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "owner", "pw1");
      await expect(createUser(db, "owner", "pw2", { allowMulti: true })).rejects.toThrow(
        UsernameTakenError,
      );
    } finally {
      cleanup();
    }
  });
});

describe("verifyPassword", () => {
  test("true for the original password, false for anything else", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "correct horse");
      expect(await verifyPassword(u, "correct horse")).toBe(true);
      expect(await verifyPassword(u, "wrong")).toBe(false);
      expect(await verifyPassword(u, "")).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("setPassword", () => {
  test("rotates the hash and updates updated_at", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "owner", "old-pw");
      const oldHash = u.passwordHash;
      const oldUpdated = u.updatedAt;
      // Bump the clock so the timestamp visibly changes.
      const later = new Date(new Date(oldUpdated).getTime() + 1000);
      await setPassword(db, u.id, "new-pw", () => later);
      const fresh = getUserById(db, u.id);
      expect(fresh).not.toBeNull();
      expect(fresh?.passwordHash).not.toBe(oldHash);
      expect(fresh?.updatedAt).not.toBe(oldUpdated);
      expect(await verifyPassword(fresh!, "new-pw")).toBe(true);
      expect(await verifyPassword(fresh!, "old-pw")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("throws UserNotFoundError for an unknown id", async () => {
    const { db, cleanup } = makeDb();
    try {
      await expect(setPassword(db, "no-such-user", "pw")).rejects.toThrow(UserNotFoundError);
    } finally {
      cleanup();
    }
  });
});

describe("listUsers / getUserByUsername", () => {
  test("listUsers returns rows in created_at order", async () => {
    const { db, cleanup } = makeDb();
    try {
      const a = await createUser(db, "a", "pw", { now: () => new Date(1000) });
      const b = await createUser(db, "b", "pw", {
        allowMulti: true,
        now: () => new Date(2000),
      });
      const list = listUsers(db);
      expect(list.map((u) => u.username)).toEqual([a.username, b.username]);
    } finally {
      cleanup();
    }
  });

  test("getUserByUsername returns null when missing", async () => {
    const { db, cleanup } = makeDb();
    try {
      expect(getUserByUsername(db, "nobody")).toBeNull();
      await createUser(db, "owner", "pw");
      expect(getUserByUsername(db, "owner")?.username).toBe("owner");
    } finally {
      cleanup();
    }
  });
});

describe("getUserByUsernameCI", () => {
  test("matches exact lowercase username", async () => {
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "alice", "alice-strong-passphrase");
      expect(getUserByUsernameCI(db, "alice")?.username).toBe("alice");
    } finally {
      cleanup();
    }
  });

  test("matches case-insensitively (defense in depth for legacy mixed-case rows)", async () => {
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "alice", "alice-strong-passphrase");
      expect(getUserByUsernameCI(db, "Alice")?.username).toBe("alice");
      expect(getUserByUsernameCI(db, "ALICE")?.username).toBe("alice");
    } finally {
      cleanup();
    }
  });

  test("returns null when no row matches", async () => {
    const { db, cleanup } = makeDb();
    try {
      expect(getUserByUsernameCI(db, "ghost")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("deleteUser", () => {
  test("returns false when user does not exist", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(deleteUser(db, "no-such-id")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("returns true and drops the row", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "alice-strong-passphrase");
      expect(deleteUser(db, u.id)).toBe(true);
      expect(getUserById(db, u.id)).toBeNull();
      expect(userCount(db)).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("deletes a user holding an auth_codes row (hub#559 — OAuth-authorize FK regression)", async () => {
    // A user who completed an OAuth authorize has an `auth_codes` row whose
    // NOT-NULL, non-cascading FK to users(id) outlives its 60s TTL. Before the
    // fix, that pinned the FK and `DELETE FROM users` threw
    // SQLITE_CONSTRAINT_FOREIGNKEY → a 500 on the admin "delete user" action.
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "ag", "ag-strong-passphrase");
      // auth_codes.client_id FKs to clients — seed a minimal client first.
      db.prepare(
        "INSERT INTO clients (client_id, redirect_uris, scopes, registered_at) VALUES (?, ?, ?, ?)",
      ).run("client-x", "https://app.example/cb", "vault:default:read", "2026-06-04T00:00:00.000Z");
      db.prepare(
        `INSERT INTO auth_codes
           (code, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, used_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "dead-code",
        "client-x",
        u.id,
        "https://app.example/cb",
        "vault:default:read",
        "challenge",
        "S256",
        "2026-06-04T00:00:00.000Z", // long-expired
        "2026-06-04T00:00:00.000Z", // already used
        "2026-06-04T00:00:00.000Z",
      );
      expect(deleteUser(db, u.id)).toBe(true);
      expect(getUserById(db, u.id)).toBeNull();
      // The dead auth_code is gone too (hard-deleted with the user).
      expect(db.query("SELECT COUNT(*) c FROM auth_codes WHERE user_id = ?").get(u.id)).toEqual({
        c: 0,
      });
    } finally {
      cleanup();
    }
  });
});

describe("validateUsername", () => {
  test("happy path — typical names", () => {
    for (const name of ["alice", "bob_42", "user-1", "ab", "a-b-c", "x_y_z"]) {
      const r = validateUsername(name);
      expect(r.valid).toBe(true);
      if (r.valid) expect(r.name).toBe(name);
    }
  });

  test("length boundaries — 2 and 32 OK, 1 and 33 rejected", () => {
    expect(validateUsername("ab").valid).toBe(true);
    expect(validateUsername("a".repeat(32)).valid).toBe(true);
    const tooShort = validateUsername("a");
    expect(tooShort.valid).toBe(false);
    if (!tooShort.valid) expect(tooShort.reason).toBe("length");
    const tooLong = validateUsername("a".repeat(33));
    expect(tooLong.valid).toBe(false);
    if (!tooLong.valid) expect(tooLong.reason).toBe("length");
    // Empty string is a length failure (not a format failure).
    const empty = validateUsername("");
    expect(empty.valid).toBe(false);
    if (!empty.valid) expect(empty.reason).toBe("length");
  });

  test("format failures — uppercase, spaces, symbols rejected", () => {
    for (const name of ["Alice", "bob smith", "user@domain", "name!", "user.name", "naïve"]) {
      const r = validateUsername(name);
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.reason).toBe("format");
    }
  });

  test("reserved words rejected — case-insensitive", () => {
    for (const reserved of USERNAME_RESERVED) {
      const r = validateUsername(reserved);
      expect(r.valid).toBe(false);
      if (!r.valid) expect(r.reason).toBe("reserved");
    }
    // Case variants — the regex pins lowercase so uppercase fails as
    // "format" first; the case-insensitive reserved check is defense in
    // depth. But within the lowercase-allowed set, mixed-case-spelled
    // reserved words are blocked by the format gate (e.g. "Admin"
    // fails format, not reserved). The regex catches case variants
    // before reserved-check ever runs — that's correct order.
    const mixed = validateUsername("Admin");
    expect(mixed.valid).toBe(false);
    if (!mixed.valid) expect(mixed.reason).toBe("format");
  });

  test("hyphens and underscores allowed; numbers allowed", () => {
    expect(validateUsername("user_1").valid).toBe(true);
    expect(validateUsername("user-2").valid).toBe(true);
    expect(validateUsername("123").valid).toBe(true);
    expect(validateUsername("_-_").valid).toBe(true);
  });
});

describe("validatePassword", () => {
  test("happy path — 12+ chars accepted", () => {
    expect(validatePassword("twelvechars1").valid).toBe(true);
    expect(validatePassword("a much longer passphrase here").valid).toBe(true);
  });

  test("boundary — exactly 12 chars accepted, 11 rejected", () => {
    expect(PASSWORD_MIN_LEN).toBe(12);
    expect(validatePassword("a".repeat(12)).valid).toBe(true);
    const r = validatePassword("a".repeat(11));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("too_short");
  });

  test("empty string rejected as too_short", () => {
    const r = validatePassword("");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("too_short");
  });

  test("no complexity rules — long but all-same-char accepted", () => {
    // Phase 1 takes NIST 800-63B's lead: length over forced classes.
    // Aaron settled on 12-min, no complexity. If we later want to nudge
    // toward passphrases we'll layer it as a separate signal, not a
    // hard gate.
    expect(validatePassword("aaaaaaaaaaaa").valid).toBe(true);
  });
});

describe("validateEmail (v15, B2)", () => {
  test("accepts ordinary addresses, canonicalizing to lowercase/trimmed", () => {
    const r = validateEmail("  Alice@Example.com ");
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.email).toBe("alice@example.com");
    expect(validateEmail("a.b+tag@sub.domain.co.uk").valid).toBe(true);
    expect(validateEmail("user_name@x.io").valid).toBe(true);
  });

  test("rejects malformed shapes", () => {
    for (const bad of [
      "",
      "not-an-email",
      "@example.com",
      "alice@",
      "alice@example",
      "alice example@x.io",
      "two@@x.io",
      "alice@x.c",
    ]) {
      expect(validateEmail(bad).valid).toBe(false);
    }
  });

  test("rejects over-length addresses (>254)", () => {
    const long = `${"a".repeat(250)}@x.io`;
    const r = validateEmail(long);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe("length");
  });
});

describe("resetUserPassword", () => {
  test("returns false when user does not exist", async () => {
    const { db, cleanup } = makeDb();
    try {
      expect(await resetUserPassword(db, "no-such-id", "twelvechars1")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("returns false when user vanishes between pre-check and tx body", async () => {
    // Reviewer-flagged race path (hub#427). The argon2 hash is computed
    // outside the transaction (async), giving a window where a concurrent
    // delete can land between the existence pre-check and the UPDATE tx.
    // The helper must return false in that case so the caller can 404
    // instead of cosmetically claiming success.
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "alice", "alice-strong-passphrase", {
        passwordChanged: true,
      });
      // Simulate the race: delete the row, then invoke the reset. The
      // pre-check runs in `resetUserPassword` against the now-empty table.
      // (We can't intercept between pre-check and tx without forking the
      // helper; deleting before the call is the equivalent post-condition
      // — if the row is gone the tx body will UPDATE 0 rows.)
      db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
      expect(await resetUserPassword(db, user.id, "new-temp-passphrase")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("rotates hash, flips password_changed back to 0, bumps updated_at", async () => {
    const { db, cleanup } = makeDb();
    try {
      // Seed user as "already changed their password" (true) to prove the
      // reset flips it back to false for the force-redirect rail.
      const initial = await createUser(db, "alice", "alice-strong-passphrase", {
        passwordChanged: true,
        now: () => new Date(1000),
      });
      const oldHash = initial.passwordHash;
      const oldUpdated = initial.updatedAt;
      const later = new Date(2000);
      expect(await resetUserPassword(db, initial.id, "new-temp-passphrase", () => later)).toBe(
        true,
      );
      const fresh = getUserById(db, initial.id);
      expect(fresh).not.toBeNull();
      expect(fresh?.passwordHash).not.toBe(oldHash);
      expect(fresh?.passwordChanged).toBe(false);
      expect(fresh?.updatedAt).not.toBe(oldUpdated);
      // Round-trip verify: old password no longer works, new one does.
      expect(await verifyPassword(fresh!, "alice-strong-passphrase")).toBe(false);
      expect(await verifyPassword(fresh!, "new-temp-passphrase")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("revokes still-active tokens belonging to the user", async () => {
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "alice", "alice-strong-passphrase", {
        passwordChanged: true,
      });
      const minted = await signAccessToken(db, {
        sub: user.id,
        scopes: ["vault:home:read"],
        audience: "vault",
        clientId: "notes-client",
        issuer: "https://hub.test",
        ttlSeconds: 600,
      });
      recordTokenMint(db, {
        jti: minted.jti,
        createdVia: "operator_mint",
        subject: user.username,
        userId: user.id,
        clientId: "notes-client",
        scopes: ["vault:home:read"],
        expiresAt: minted.expiresAt,
      });
      // Pre-state: token row not yet revoked.
      const before = db
        .query<{ revoked_at: string | null }, [string]>(
          "SELECT revoked_at FROM tokens WHERE jti = ?",
        )
        .get(minted.jti);
      expect(before?.revoked_at).toBeNull();

      expect(await resetUserPassword(db, user.id, "new-temp-passphrase")).toBe(true);

      // Post-state: token row has revoked_at set, user_id retained (the
      // user row sticks around, audit trail re-anchors naturally).
      const after = db
        .query<{ revoked_at: string | null; user_id: string | null }, [string]>(
          "SELECT revoked_at, user_id FROM tokens WHERE jti = ?",
        )
        .get(minted.jti);
      expect(after?.revoked_at).not.toBeNull();
      expect(after?.user_id).toBe(user.id);
    } finally {
      cleanup();
    }
  });

  // Item G — a reset also kills active sessions (not just tokens), so the
  // attacker/holder of a live session cookie must re-authenticate.
  test("deletes the user's active sessions (item G)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const alice = await createUser(db, "alice", "alice-strong-passphrase", {
        passwordChanged: true,
      });
      const bob = await createUser(db, "bob", "bob-strong-passphrase", {
        passwordChanged: true,
        allowMulti: true,
      });
      const aliceSession = createSession(db, { userId: alice.id });
      const bobSession = createSession(db, { userId: bob.id });
      expect(findSession(db, aliceSession.id)).not.toBeNull();

      expect(await resetUserPassword(db, alice.id, "new-temp-passphrase")).toBe(true);

      // Alice's session is gone; Bob's (a different user) is untouched.
      expect(findSession(db, aliceSession.id)).toBeNull();
      expect(findSession(db, bobSession.id)).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("does not re-revoke an already-revoked token", async () => {
    // Defense-in-depth: a previously-revoked token shouldn't have its
    // revoked_at timestamp overwritten by a fresh reset. The UPDATE's
    // WHERE clause filters on `revoked_at IS NULL` so this is naturally
    // enforced; pinning it here so a future refactor that drops the
    // filter trips the test.
    const { db, cleanup } = makeDb();
    try {
      const user = await createUser(db, "alice", "alice-strong-passphrase", {
        passwordChanged: true,
      });
      const minted = await signAccessToken(db, {
        sub: user.id,
        scopes: ["vault:home:read"],
        audience: "vault",
        clientId: "notes-client",
        issuer: "https://hub.test",
        ttlSeconds: 600,
      });
      const earlierStamp = "2026-01-01T00:00:00.000Z";
      recordTokenMint(db, {
        jti: minted.jti,
        createdVia: "operator_mint",
        subject: user.username,
        userId: user.id,
        clientId: "notes-client",
        scopes: ["vault:home:read"],
        expiresAt: minted.expiresAt,
      });
      db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ?").run(earlierStamp, minted.jti);

      expect(await resetUserPassword(db, user.id, "new-temp-passphrase")).toBe(true);

      const row = db
        .query<{ revoked_at: string | null }, [string]>(
          "SELECT revoked_at FROM tokens WHERE jti = ?",
        )
        .get(minted.jti);
      expect(row?.revoked_at).toBe(earlierStamp);
    } finally {
      cleanup();
    }
  });

  test("leaves tokens for other users untouched", async () => {
    const { db, cleanup } = makeDb();
    try {
      const alice = await createUser(db, "alice", "alice-strong-passphrase", {
        passwordChanged: true,
      });
      const bob = await createUser(db, "bob", "bob-strong-passphrase", {
        allowMulti: true,
        passwordChanged: true,
      });
      const bobToken = await signAccessToken(db, {
        sub: bob.id,
        scopes: ["vault:home:read"],
        audience: "vault",
        clientId: "notes-client",
        issuer: "https://hub.test",
        ttlSeconds: 600,
      });
      recordTokenMint(db, {
        jti: bobToken.jti,
        createdVia: "operator_mint",
        subject: bob.username,
        userId: bob.id,
        clientId: "notes-client",
        scopes: ["vault:home:read"],
        expiresAt: bobToken.expiresAt,
      });

      await resetUserPassword(db, alice.id, "new-temp-passphrase");

      const bobRow = db
        .query<{ revoked_at: string | null }, [string]>(
          "SELECT revoked_at FROM tokens WHERE jti = ?",
        )
        .get(bobToken.jti);
      expect(bobRow?.revoked_at).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("setUserVaults (multi-user Phase 2 PR 2)", () => {
  test("returns false when user does not exist", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(setUserVaults(db, "no-such-id", ["a"])).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("replaces a user's vault list atomically", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "alice-strong-passphrase", {
        assignedVaults: ["personal"],
      });
      expect(setUserVaults(db, u.id, ["family", "work"])).toBe(true);
      const fresh = getUserById(db, u.id);
      // Old vault dropped; new ones present.
      expect(new Set(fresh?.assignedVaults)).toEqual(new Set(["family", "work"]));
      expect(fresh?.assignedVaults).not.toContain("personal");
    } finally {
      cleanup();
    }
  });

  test("empty array clears every existing assignment (non-admin = no access)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "alice-strong-passphrase", {
        assignedVaults: ["a", "b", "c"],
      });
      expect(setUserVaults(db, u.id, [])).toBe(true);
      const fresh = getUserById(db, u.id);
      expect(fresh?.assignedVaults).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("de-duplicates repeated names without throwing", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "alice-strong-passphrase");
      expect(setUserVaults(db, u.id, ["a", "a", "b"])).toBe(true);
      const fresh = getUserById(db, u.id);
      expect(new Set(fresh?.assignedVaults)).toEqual(new Set(["a", "b"]));
      expect(fresh?.assignedVaults.length).toBe(2);
    } finally {
      cleanup();
    }
  });

  test("bumps updated_at so the SPA row reflects the change", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "alice-strong-passphrase", {
        now: () => new Date(1000),
      });
      const before = getUserById(db, u.id);
      expect(setUserVaults(db, u.id, ["a"], () => new Date(2000))).toBe(true);
      const after = getUserById(db, u.id);
      expect(after?.updatedAt).not.toBe(before?.updatedAt);
    } finally {
      cleanup();
    }
  });

  test("vault assignments cascade-delete with the user row", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "alice-strong-passphrase", {
        assignedVaults: ["a", "b"],
      });
      // Sanity: rows exist in user_vaults.
      const before = db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?")
        .get(u.id);
      expect(before?.n).toBe(2);
      deleteUser(db, u.id);
      const after = db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM user_vaults WHERE user_id = ?")
        .get(u.id);
      expect(after?.n).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("getFirstAdminId / isFirstAdmin", () => {
  test("getFirstAdminId returns null on an empty users table", () => {
    const { db, cleanup } = makeDb();
    try {
      expect(getFirstAdminId(db)).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("getFirstAdminId returns the earliest-created user id", async () => {
    const { db, cleanup } = makeDb();
    try {
      const admin = await createUser(db, "admin", "pw1", { now: () => new Date(1000) });
      await createUser(db, "alice", "pw2", {
        allowMulti: true,
        now: () => new Date(2000),
      });
      await createUser(db, "bob", "pw3", {
        allowMulti: true,
        now: () => new Date(3000),
      });
      expect(getFirstAdminId(db)).toBe(admin.id);
    } finally {
      cleanup();
    }
  });

  test("isFirstAdmin matches earliest user, false for everyone else", async () => {
    const { db, cleanup } = makeDb();
    try {
      const admin = await createUser(db, "admin", "pw1", { now: () => new Date(1000) });
      const friend = await createUser(db, "alice", "pw2", {
        allowMulti: true,
        now: () => new Date(2000),
      });
      expect(isFirstAdmin(db, admin.id)).toBe(true);
      expect(isFirstAdmin(db, friend.id)).toBe(false);
      expect(isFirstAdmin(db, "no-such-id")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("isFirstAdmin tracks the admin even after a later user is deleted", async () => {
    // Deleting a non-first user doesn't promote anyone — the original
    // admin still holds the "first" slot.
    const { db, cleanup } = makeDb();
    try {
      const admin = await createUser(db, "admin", "pw1", { now: () => new Date(1000) });
      const friend = await createUser(db, "alice", "pw2", {
        allowMulti: true,
        now: () => new Date(2000),
      });
      deleteUser(db, friend.id);
      expect(getFirstAdminId(db)).toBe(admin.id);
      expect(isFirstAdmin(db, admin.id)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("vaultVerbsForRole / vaultVerbsForUserVault (friend token-mint cap)", () => {
  test("vaultVerbsForRole maps roles to verbs, fails closed on unknown", () => {
    // Assigned users (role=write, today's default) hold FULL vault authority
    // incl. admin (2026-05-30 policy: any assigned user gets admin). A
    // deliberate read-only assignment stays read-only. Unknown role strings
    // (including the literal "admin") map to [] — only the recognised roles
    // grant verbs; never silently default to write.
    expect(vaultVerbsForRole("write")).toEqual(["read", "write", "admin"]);
    expect(vaultVerbsForRole("read")).toEqual(["read"]);
    expect(vaultVerbsForRole("admin")).toEqual([]);
    expect(vaultVerbsForRole("owner")).toEqual([]);
    expect(vaultVerbsForRole("")).toEqual([]);
  });

  test("vaultVerbsForUserVault returns the role's verbs for an assigned vault", async () => {
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "admin", "pw1");
      const friend = await createUser(db, "alice", "pw2", {
        allowMulti: true,
        assignedVaults: ["work"],
      });
      // createUser/setUserVaults insert role='write' today → read+write+admin
      // (assigned users hold full vault authority, 2026-05-30 policy).
      expect(vaultVerbsForUserVault(db, friend.id, "work")).toEqual(["read", "write", "admin"]);
    } finally {
      cleanup();
    }
  });

  test("vaultVerbsForUserVault returns null for a vault NOT in the assignment", async () => {
    // This null is the authorization spine of the friend mint path: a vault
    // the user isn't assigned to → null → the handler 403s. No cross-vault.
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "admin", "pw1");
      const friend = await createUser(db, "alice", "pw2", {
        allowMulti: true,
        assignedVaults: ["work"],
      });
      expect(vaultVerbsForUserVault(db, friend.id, "other")).toBeNull();
      // The unrestricted admin has no user_vaults rows → null for everything.
      const admin = getUserById(db, getFirstAdminId(db) ?? "");
      expect(vaultVerbsForUserVault(db, admin?.id ?? "", "work")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("vaultVerbsForUserVault honors a hand-set read-only role (fail-closed forward-compat)", async () => {
    // The schema reserves `role` for future granularity; if a row ever holds
    // role='read', the cap must drop write. Simulate by direct UPDATE.
    const { db, cleanup } = makeDb();
    try {
      await createUser(db, "admin", "pw1");
      const friend = await createUser(db, "alice", "pw2", {
        allowMulti: true,
        assignedVaults: ["work"],
      });
      db.prepare("UPDATE user_vaults SET role = 'read' WHERE user_id = ? AND vault_name = ?").run(
        friend.id,
        "work",
      );
      expect(vaultVerbsForUserVault(db, friend.id, "work")).toEqual(["read"]);
    } finally {
      cleanup();
    }
  });
});
