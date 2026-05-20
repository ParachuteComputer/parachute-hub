import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  PASSWORD_MIN_LEN,
  SingleUserModeError,
  USERNAME_RESERVED,
  UserNotFoundError,
  UsernameTakenError,
  createUser,
  deleteUser,
  getUserById,
  getUserByUsername,
  getUserByUsernameCI,
  listUsers,
  setPassword,
  userCount,
  validatePassword,
  validateUsername,
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
      expect(u.assignedVault).toBeNull();
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

  test("assignedVault opt-in persists the column (admin-creates-user path)", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "alice", "pw1", {
        allowMulti: true,
        assignedVault: "alice",
      });
      expect(u.assignedVault).toBe("alice");
      const fresh = getUserById(db, u.id);
      expect(fresh?.assignedVault).toBe("alice");
    } finally {
      cleanup();
    }
  });

  test("assignedVault explicit null is treated the same as omitted", async () => {
    const { db, cleanup } = makeDb();
    try {
      const u = await createUser(db, "admin1", "pw1", { assignedVault: null });
      expect(u.assignedVault).toBeNull();
      const fresh = getUserById(db, u.id);
      expect(fresh?.assignedVault).toBeNull();
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
