/**
 * Core invite-primitive tests (`src/invites.ts`). Mirrors the auth-codes
 * test shape: issue, lookup-by-raw, status derivation, redeemable assertion
 * (not-found / expired / used / revoked), single-use consume, revoke.
 *
 * Security invariants asserted here: 256-bit raw token, sha256 at rest (the
 * raw token never appears in the row), single-use via used_at, expiry
 * enforced at redeem, revocable.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  DEFAULT_INVITE_TTL_SECONDS,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  InviteUsedError,
  assertInviteRedeemable,
  consumeInvite,
  findInviteByRawToken,
  hashInviteToken,
  inviteStatus,
  issueInvite,
  listInvites,
  revokeInvite,
  revokeInvitesForVault,
} from "../invites.ts";
import { createUser } from "../users.ts";

async function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), "phub-invites-"));
  const db = openHubDb(hubDbPath(dir));
  const admin = await createUser(db, "operator", "operator-password-1");
  return {
    db,
    adminId: admin.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("issueInvite", () => {
  test("returns a 256-bit raw token and stores ONLY its sha256", async () => {
    const { db, adminId, cleanup } = await makeDb();
    try {
      const { rawToken, invite } = issueInvite(db, { createdBy: adminId, vaultName: "maya" });
      // base64url of 32 bytes ≈ 43 chars — comfortably high entropy.
      expect(rawToken.length).toBeGreaterThan(40);
      expect(invite.tokenHash).toBe(hashInviteToken(rawToken));
      expect(invite.tokenHash).not.toBe(rawToken);
      // The row stores the hash, never the raw token.
      const row = db
        .query<{ token: string }, [string]>("SELECT token FROM invites WHERE token = ?")
        .get(createHash("sha256").update(rawToken).digest("hex"));
      expect(row?.token).toBe(invite.tokenHash);
      const rawRow = db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM invites WHERE token = ?")
        .get(rawToken);
      expect(rawRow?.n).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("defaults: role=write, provision_vault=1, 7-day expiry", async () => {
    const { db, adminId, cleanup } = await makeDb();
    try {
      const now = new Date("2026-06-04T00:00:00Z");
      const { invite } = issueInvite(db, { createdBy: adminId, now: () => now });
      expect(invite.role).toBe("write");
      expect(invite.provisionVault).toBe(true);
      expect(invite.vaultName).toBeNull();
      const expiry = new Date(invite.expiresAt).getTime() - now.getTime();
      expect(Math.round(expiry / 1000)).toBe(DEFAULT_INVITE_TTL_SECONDS);
    } finally {
      cleanup();
    }
  });
});

describe("findInviteByRawToken", () => {
  test("hashes then finds; unknown/tampered token → null", async () => {
    const { db, adminId, cleanup } = await makeDb();
    try {
      const { rawToken } = issueInvite(db, { createdBy: adminId });
      expect(findInviteByRawToken(db, rawToken)).not.toBeNull();
      expect(findInviteByRawToken(db, `${rawToken}x`)).toBeNull();
      expect(findInviteByRawToken(db, "totally-unknown")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("assertInviteRedeemable", () => {
  test("unknown token → InviteNotFoundError", async () => {
    const { db, cleanup } = await makeDb();
    try {
      expect(() => assertInviteRedeemable(db, "nope")).toThrow(InviteNotFoundError);
    } finally {
      cleanup();
    }
  });

  test("expired token → InviteExpiredError", async () => {
    const { db, adminId, cleanup } = await makeDb();
    try {
      const now = new Date("2026-06-04T00:00:00Z");
      const { rawToken } = issueInvite(db, {
        createdBy: adminId,
        expiresInSeconds: 60,
        now: () => now,
      });
      const later = new Date(now.getTime() + 61_000);
      expect(() => assertInviteRedeemable(db, rawToken, later)).toThrow(InviteExpiredError);
    } finally {
      cleanup();
    }
  });

  test("used token → InviteUsedError", async () => {
    const { db, adminId, cleanup } = await makeDb();
    try {
      const { rawToken, invite } = issueInvite(db, { createdBy: adminId });
      consumeInvite(db, invite.tokenHash, adminId);
      expect(() => assertInviteRedeemable(db, rawToken)).toThrow(InviteUsedError);
    } finally {
      cleanup();
    }
  });

  test("revoked token → InviteRevokedError", async () => {
    const { db, adminId, cleanup } = await makeDb();
    try {
      const { rawToken, invite } = issueInvite(db, { createdBy: adminId });
      revokeInvite(db, invite.tokenHash);
      expect(() => assertInviteRedeemable(db, rawToken)).toThrow(InviteRevokedError);
    } finally {
      cleanup();
    }
  });
});

describe("consumeInvite — single-use", () => {
  test("first consume wins; second returns false (replay rejected)", async () => {
    const { db, adminId, cleanup } = await makeDb();
    try {
      const { invite } = issueInvite(db, { createdBy: adminId });
      expect(consumeInvite(db, invite.tokenHash, adminId)).toBe(true);
      expect(consumeInvite(db, invite.tokenHash, adminId)).toBe(false);
      const fresh = db
        .query<{ used_at: string | null; redeemed_user_id: string | null }, [string]>(
          "SELECT used_at, redeemed_user_id FROM invites WHERE token = ?",
        )
        .get(invite.tokenHash);
      expect(fresh?.used_at).not.toBeNull();
      expect(fresh?.redeemed_user_id).toBe(adminId);
    } finally {
      cleanup();
    }
  });
});

describe("revokeInvite", () => {
  test("revokes a pending invite; refuses one already used", async () => {
    const { db, adminId, cleanup } = await makeDb();
    try {
      const a = issueInvite(db, { createdBy: adminId });
      expect(revokeInvite(db, a.invite.tokenHash)).toBe(true);
      expect(revokeInvite(db, a.invite.tokenHash)).toBe(false); // already revoked

      const b = issueInvite(db, { createdBy: adminId });
      consumeInvite(db, b.invite.tokenHash, adminId);
      expect(revokeInvite(db, b.invite.tokenHash)).toBe(false); // already used
    } finally {
      cleanup();
    }
  });
});

describe("revokeInvitesForVault (B1 cascade step)", () => {
  test("a NULL-vault_name invite (redeemer-named flow) is NOT revoked by any vault's cascade", async () => {
    // The cascade invalidates invites PINNED to the deleted vault — an
    // unpinned invite (vault_name NULL: the redeemer names their own vault)
    // can't resurrect a specific name, so it must survive every vault's
    // delete. SQL `vault_name = ?` never matches NULL; pin that boundary.
    const { db, adminId, cleanup } = await makeDb();
    try {
      const unpinned = issueInvite(db, { createdBy: adminId }); // vault_name NULL
      const pinned = issueInvite(db, { createdBy: adminId, vaultName: "work" });

      expect(revokeInvitesForVault(db, "work")).toBe(1);
      // The pinned invite is revoked; the unpinned one rides on untouched.
      expect(findInviteByRawToken(db, pinned.rawToken)?.revokedAt).not.toBeNull();
      expect(findInviteByRawToken(db, unpinned.rawToken)?.revokedAt).toBeNull();

      // A second sweep (or another vault's sweep) finds nothing more.
      expect(revokeInvitesForVault(db, "work")).toBe(0);
      expect(revokeInvitesForVault(db, "other")).toBe(0);
      expect(findInviteByRawToken(db, unpinned.rawToken)?.revokedAt).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("inviteStatus / listInvites", () => {
  test("derives pending / redeemed / expired / revoked", async () => {
    const { db, adminId, cleanup } = await makeDb();
    try {
      const now = new Date("2026-06-04T00:00:00Z");
      const pending = issueInvite(db, { createdBy: adminId, now: () => now });
      const redeemed = issueInvite(db, { createdBy: adminId, now: () => now });
      consumeInvite(db, redeemed.invite.tokenHash, adminId, now);
      const revoked = issueInvite(db, { createdBy: adminId, now: () => now });
      revokeInvite(db, revoked.invite.tokenHash, now);
      const expired = issueInvite(db, {
        createdBy: adminId,
        expiresInSeconds: 10,
        now: () => now,
      });

      const later = new Date(now.getTime() + 60_000);
      // `consumeInvite`/`revokeInvite` mutate the DB row, not the in-memory
      // snapshot — re-read each to assert status off persisted state.
      const fresh = (raw: string) => findInviteByRawToken(db, raw);
      expect(inviteStatus(fresh(pending.rawToken)!, later)).toBe("pending");
      expect(inviteStatus(fresh(redeemed.rawToken)!, later)).toBe("redeemed");
      expect(inviteStatus(fresh(revoked.rawToken)!, later)).toBe("revoked");
      expect(inviteStatus(fresh(expired.rawToken)!, later)).toBe("expired");

      const list = listInvites(db, later);
      expect(list.length).toBe(4);
      // listInvites annotates status + newest-first ordering.
      const statuses = new Set(list.map((i) => i.status));
      expect(statuses).toEqual(new Set(["pending", "redeemed", "revoked", "expired"]));
    } finally {
      cleanup();
    }
  });
});
