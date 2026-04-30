import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerClient } from "../clients.ts";
import {
  findGrant,
  isCoveredByGrant,
  listGrantsForUser,
  recordGrant,
  revokeGrant,
} from "../grants.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { createUser } from "../users.ts";

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "phub-grants-"));
  const db = openHubDb(hubDbPath(dir));
  const user = await createUser(db, "owner", "pw");
  const reg = registerClient(db, { redirectUris: ["https://app.example/cb"] });
  return {
    db,
    userId: user.id,
    clientId: reg.client.clientId,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("grants module (#75)", () => {
  test("findGrant returns null when no row exists", async () => {
    const h = await harness();
    try {
      expect(findGrant(h.db, h.userId, h.clientId)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("recordGrant inserts a row with sorted scopes", async () => {
    const h = await harness();
    try {
      const grant = recordGrant(h.db, h.userId, h.clientId, ["b", "a", "c"]);
      // Sorted to keep on-disk order deterministic; test pins the contract.
      expect(grant.scopes).toEqual(["a", "b", "c"]);
      const fromDb = findGrant(h.db, h.userId, h.clientId);
      expect(fromDb?.scopes).toEqual(["a", "b", "c"]);
    } finally {
      h.cleanup();
    }
  });

  test("recordGrant unions new scopes into existing grant", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["a", "b", "c"]);
      recordGrant(h.db, h.userId, h.clientId, ["a", "d"]);
      const grant = findGrant(h.db, h.userId, h.clientId);
      expect(new Set(grant?.scopes)).toEqual(new Set(["a", "b", "c", "d"]));
    } finally {
      h.cleanup();
    }
  });

  test("recordGrant skips empty strings inside the scope list", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["", "a", ""]);
      const grant = findGrant(h.db, h.userId, h.clientId);
      expect(grant?.scopes).toEqual(["a"]);
    } finally {
      h.cleanup();
    }
  });

  test("isCoveredByGrant: false when no grant exists", async () => {
    const h = await harness();
    try {
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a"])).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("isCoveredByGrant: true for exact match and subset, false for superset", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["a", "b", "c"]);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a", "b", "c"])).toBe(true);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a"])).toBe(true);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a", "b"])).toBe(true);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["a", "d"])).toBe(false);
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, ["d"])).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("isCoveredByGrant: empty request returns false (no auto-approve for empty)", async () => {
    const h = await harness();
    try {
      recordGrant(h.db, h.userId, h.clientId, ["a"]);
      // Empty scope flow is suspicious — surface it through consent rather
      // than silently auto-approving.
      expect(isCoveredByGrant(h.db, h.userId, h.clientId, [])).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("revokeGrant returns true when a row was removed, false when none existed", async () => {
    const h = await harness();
    try {
      expect(revokeGrant(h.db, h.userId, h.clientId)).toBe(false);
      recordGrant(h.db, h.userId, h.clientId, ["a"]);
      expect(revokeGrant(h.db, h.userId, h.clientId)).toBe(true);
      expect(findGrant(h.db, h.userId, h.clientId)).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("recordGrant: concurrent calls produce one row with the union of scopes (#119)", async () => {
    const h = await harness();
    try {
      // Fire two recordGrant calls "concurrently" via Promise.all. The
      // transaction wrapper means the read-merge-write is atomic, so the
      // second writer always sees the first writer's scopes — neither set
      // gets dropped.
      await Promise.all([
        Promise.resolve().then(() => recordGrant(h.db, h.userId, h.clientId, ["a", "b"])),
        Promise.resolve().then(() => recordGrant(h.db, h.userId, h.clientId, ["c", "d"])),
      ]);
      const rowCount = (
        h.db
          .prepare("SELECT COUNT(*) AS n FROM grants WHERE user_id = ? AND client_id = ?")
          .get(h.userId, h.clientId) as { n: number }
      ).n;
      expect(rowCount).toBe(1);
      const grant = findGrant(h.db, h.userId, h.clientId);
      expect(new Set(grant?.scopes)).toEqual(new Set(["a", "b", "c", "d"]));
    } finally {
      h.cleanup();
    }
  });

  test("listGrantsForUser orders most-recent first", async () => {
    const h = await harness();
    try {
      const reg2 = registerClient(h.db, { redirectUris: ["https://other.example/cb"] });
      // Older grant first.
      recordGrant(h.db, h.userId, h.clientId, ["a"], new Date("2026-04-01T00:00:00Z"));
      recordGrant(h.db, h.userId, reg2.client.clientId, ["b"], new Date("2026-04-15T00:00:00Z"));
      const grants = listGrantsForUser(h.db, h.userId);
      expect(grants).toHaveLength(2);
      expect(grants[0]?.clientId).toBe(reg2.client.clientId);
      expect(grants[1]?.clientId).toBe(h.clientId);
    } finally {
      h.cleanup();
    }
  });
});
