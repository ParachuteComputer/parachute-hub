/**
 * Nostr pubkey ↔ hub-user linkage store (hub#833 phase 1a) + the mint-time
 * attribution snapshot on `tokens` rows (phase 1b).
 *
 * Coverage:
 *   - migration v17 lands `user_pubkeys`, `pubkey_challenges`, and the
 *     additive `tokens.subject_pubkey` column
 *   - challenges: issued hashed (raw value is NOT recoverable from the DB),
 *     single-use, TTL-bounded, user-bound
 *   - link: happy path; replay of a consumed challenge; expired challenge;
 *     another user's challenge; per-user cap; cross-user pubkey collision;
 *     same-user re-link is idempotent
 *   - unlink: self-only, idempotent
 *   - resolution: `pubkeysForUser`, `primaryPubkeyForUser` deterministic order
 *   - `recordTokenMint` / `signRefreshToken` snapshot the primary key, and an
 *     unlink does NOT rewrite already-written registry rows
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { findTokenRowByJti, recordTokenMint, signRefreshToken } from "../jwt-sign.ts";
import {
  MAX_PUBKEYS_PER_USER,
  PUBKEY_CHALLENGE_TTL_MS,
  attributionPubkey,
  issuePubkeyChallenge,
  linkPubkey,
  listUserPubkeys,
  primaryPubkeyForUser,
  proofEventFor,
  pubkeysForUser,
  purgeExpiredChallenges,
  unlinkPubkey,
} from "../pubkey-links.ts";
import { createUser } from "../users.ts";

let db: Database;
let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "phub-pubkey-links-"));
  db = openHubDb(hubDbPath(configDir));
});

afterEach(() => {
  db.close();
  rmSync(configDir, { recursive: true, force: true });
});

const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);

function proof(pubkey: string, challenge: string): string {
  return JSON.stringify({
    id: "0".repeat(64),
    pubkey,
    kind: 27235,
    tags: [["challenge", challenge]],
  });
}

async function user(name: string): Promise<string> {
  const u = await createUser(db, name, "correct-horse-battery", {
    allowMulti: true,
    passwordChanged: true,
  });
  return u.id;
}

describe("migration v17", () => {
  test("creates the linkage tables and the additive tokens column", () => {
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    expect(tables).toContain("user_pubkeys");
    expect(tables).toContain("pubkey_challenges");

    const cols = db.query<{ name: string; notnull: number }, []>("PRAGMA table_info(tokens)").all();
    const subjectPubkey = cols.find((c) => c.name === "subject_pubkey");
    expect(subjectPubkey).toBeDefined();
    // Additive means nullable — every pre-v17 row keeps NULL.
    expect(subjectPubkey?.notnull).toBe(0);
  });

  test("pubkey is globally unique — one key can name at most one user", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const now = new Date();
    const cA = issuePubkeyChallenge(db, alice, now);
    expect(
      linkPubkey(db, {
        userId: alice,
        pubkey: PK_A,
        challenge: cA.challenge,
        proofEvent: proof(PK_A, cA.challenge),
        now,
      }).ok,
    ).toBe(true);
    const cB = issuePubkeyChallenge(db, bob, now);
    expect(
      linkPubkey(db, {
        userId: bob,
        pubkey: PK_A,
        challenge: cB.challenge,
        proofEvent: proof(PK_A, cB.challenge),
        now,
      }),
    ).toEqual({ ok: false, reason: "pubkey_taken" });
  });
});

describe("issuePubkeyChallenge", () => {
  test("returns a high-entropy challenge and stores only its hash", async () => {
    const alice = await user("alice");
    const { challenge, expiresAt } = issuePubkeyChallenge(db, alice, new Date(1_700_000_000_000));
    expect(challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBe(new Date(1_700_000_000_000 + PUBKEY_CHALLENGE_TTL_MS).toISOString());
    const rows = db.query<{ challenge_hash: string }, []>("SELECT * FROM pubkey_challenges").all();
    expect(rows).toHaveLength(1);
    // The raw challenge must not be recoverable from the row.
    expect(rows[0]!.challenge_hash).not.toBe(challenge);
    const dump = JSON.stringify(rows);
    expect(dump.includes(challenge)).toBe(false);
  });

  test("issues distinct challenges", async () => {
    const alice = await user("alice");
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add(issuePubkeyChallenge(db, alice, new Date()).challenge);
    expect(seen.size).toBe(5);
  });
});

describe("linkPubkey", () => {
  test("links on a fresh challenge and records the proof", async () => {
    const alice = await user("alice");
    const now = new Date(1_700_000_000_000);
    const { challenge } = issuePubkeyChallenge(db, alice, now);
    const res = linkPubkey(db, {
      userId: alice,
      pubkey: PK_A,
      challenge,
      proofEvent: proof(PK_A, challenge),
      label: "laptop",
      now,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.link.pubkey).toBe(PK_A);
    expect(res.link.label).toBe("laptop");
    expect(res.link.linkedAt).toBe(now.toISOString());
    expect(proofEventFor(db, PK_A)).toBe(proof(PK_A, challenge));
  });

  test("a challenge is single-use — replay is refused", async () => {
    const alice = await user("alice");
    const now = new Date();
    const { challenge } = issuePubkeyChallenge(db, alice, now);
    expect(
      linkPubkey(db, {
        userId: alice,
        pubkey: PK_A,
        challenge,
        proofEvent: proof(PK_A, challenge),
        now,
      }).ok,
    ).toBe(true);
    expect(
      linkPubkey(db, {
        userId: alice,
        pubkey: PK_B,
        challenge,
        proofEvent: proof(PK_B, challenge),
        now,
      }),
    ).toEqual({ ok: false, reason: "challenge_invalid" });
  });

  test("a challenge that validated stays consumed even when the link is then refused", async () => {
    // The documented trade in `linkPubkey`: once a signed event has been
    // PRESENTED, its challenge is spent, whatever happens next. Otherwise a
    // refused attempt would leave a live (challenge, signed event) pair on the
    // table — exactly the replayable artifact this design exists to prevent.
    // The cost is that a refused attempt needs a fresh challenge; for an auth
    // surface that is the right side to err on.
    const alice = await user("alice");
    const bob = await user("bob");
    const now = new Date();
    const cA = issuePubkeyChallenge(db, alice, now);
    expect(
      linkPubkey(db, {
        userId: alice,
        pubkey: PK_A,
        challenge: cA.challenge,
        proofEvent: proof(PK_A, cA.challenge),
        now,
      }).ok,
    ).toBe(true);

    // Bob's own challenge, spent on a key alice already holds → pubkey_taken.
    const cB = issuePubkeyChallenge(db, bob, now);
    expect(
      linkPubkey(db, {
        userId: bob,
        pubkey: PK_A,
        challenge: cB.challenge,
        proofEvent: proof(PK_A, cB.challenge),
        now,
      }),
    ).toEqual({ ok: false, reason: "pubkey_taken" });

    // That challenge is now spent — bob cannot reuse it, not even for a key
    // that WOULD be acceptable.
    expect(
      linkPubkey(db, {
        userId: bob,
        pubkey: PK_B,
        challenge: cB.challenge,
        proofEvent: proof(PK_B, cB.challenge),
        now,
      }),
    ).toEqual({ ok: false, reason: "challenge_invalid" });
    expect(listUserPubkeys(db, bob)).toHaveLength(0);
  });

  test("an expired challenge is refused", async () => {
    const alice = await user("alice");
    const issued = new Date(1_700_000_000_000);
    const { challenge } = issuePubkeyChallenge(db, alice, issued);
    const later = new Date(issued.getTime() + PUBKEY_CHALLENGE_TTL_MS + 1);
    expect(
      linkPubkey(db, {
        userId: alice,
        pubkey: PK_A,
        challenge,
        proofEvent: proof(PK_A, challenge),
        now: later,
      }),
    ).toEqual({ ok: false, reason: "challenge_invalid" });
  });

  test("another user's challenge is refused", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const now = new Date();
    const { challenge } = issuePubkeyChallenge(db, alice, now);
    expect(
      linkPubkey(db, {
        userId: bob,
        pubkey: PK_A,
        challenge,
        proofEvent: proof(PK_A, challenge),
        now,
      }),
    ).toEqual({ ok: false, reason: "challenge_invalid" });
    // …and alice's challenge is still usable (the failed attempt didn't burn it).
    expect(
      linkPubkey(db, {
        userId: alice,
        pubkey: PK_A,
        challenge,
        proofEvent: proof(PK_A, challenge),
        now,
      }).ok,
    ).toBe(true);
  });

  test("an unknown challenge is refused", async () => {
    const alice = await user("alice");
    expect(
      linkPubkey(db, {
        userId: alice,
        pubkey: PK_A,
        challenge: "f".repeat(64),
        proofEvent: proof(PK_A, "f".repeat(64)),
        now: new Date(),
      }),
    ).toEqual({ ok: false, reason: "challenge_invalid" });
  });

  test("re-linking the same key for the same user is idempotent and refreshes the proof", async () => {
    const alice = await user("alice");
    const first = new Date(1_700_000_000_000);
    const c1 = issuePubkeyChallenge(db, alice, first);
    linkPubkey(db, {
      userId: alice,
      pubkey: PK_A,
      challenge: c1.challenge,
      proofEvent: proof(PK_A, c1.challenge),
      label: "old",
      now: first,
    });
    const second = new Date(1_700_000_500_000);
    const c2 = issuePubkeyChallenge(db, alice, second);
    const res = linkPubkey(db, {
      userId: alice,
      pubkey: PK_A,
      challenge: c2.challenge,
      proofEvent: proof(PK_A, c2.challenge),
      label: "new",
      now: second,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // linked_at is the ORIGINAL link time; last_verified_at moves.
    expect(res.link.linkedAt).toBe(first.toISOString());
    expect(res.link.lastVerifiedAt).toBe(second.toISOString());
    expect(res.link.label).toBe("new");
    expect(listUserPubkeys(db, alice)).toHaveLength(1);
  });

  test("enforces the per-user cap", async () => {
    const alice = await user("alice");
    const now = new Date();
    for (let i = 0; i < MAX_PUBKEYS_PER_USER; i++) {
      const pk = i.toString(16).padStart(64, "0");
      const { challenge } = issuePubkeyChallenge(db, alice, now);
      expect(
        linkPubkey(db, {
          userId: alice,
          pubkey: pk,
          challenge,
          proofEvent: proof(pk, challenge),
          now,
        }).ok,
      ).toBe(true);
    }
    const { challenge } = issuePubkeyChallenge(db, alice, now);
    expect(
      linkPubkey(db, {
        userId: alice,
        pubkey: PK_B,
        challenge,
        proofEvent: proof(PK_B, challenge),
        now,
      }),
    ).toEqual({ ok: false, reason: "too_many_pubkeys" });
  });
});

describe("unlinkPubkey", () => {
  test("removes only the caller's own link and is idempotent", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const now = new Date();
    const cA = issuePubkeyChallenge(db, alice, now);
    linkPubkey(db, {
      userId: alice,
      pubkey: PK_A,
      challenge: cA.challenge,
      proofEvent: proof(PK_A, cA.challenge),
      now,
    });

    // Bob cannot unlink Alice's key.
    expect(unlinkPubkey(db, bob, PK_A)).toBe(false);
    expect(listUserPubkeys(db, alice)).toHaveLength(1);

    expect(unlinkPubkey(db, alice, PK_A)).toBe(true);
    expect(listUserPubkeys(db, alice)).toHaveLength(0);
    // Idempotent.
    expect(unlinkPubkey(db, alice, PK_A)).toBe(false);
  });
});

describe("resolution", () => {
  test("orders by link time then pubkey, and picks the earliest as primary", async () => {
    const alice = await user("alice");
    const t1 = new Date(1_700_000_000_000);
    const t2 = new Date(1_700_000_100_000);
    const c1 = issuePubkeyChallenge(db, alice, t1);
    linkPubkey(db, {
      userId: alice,
      pubkey: PK_B,
      challenge: c1.challenge,
      proofEvent: proof(PK_B, c1.challenge),
      now: t1,
    });
    const c2 = issuePubkeyChallenge(db, alice, t2);
    linkPubkey(db, {
      userId: alice,
      pubkey: PK_A,
      challenge: c2.challenge,
      proofEvent: proof(PK_A, c2.challenge),
      now: t2,
    });

    expect(pubkeysForUser(db, alice)).toEqual([PK_B, PK_A]);
    expect(primaryPubkeyForUser(db, alice)).toBe(PK_B);
  });

  test("returns nothing for an unknown or unlinked subject", async () => {
    const alice = await user("alice");
    expect(pubkeysForUser(db, alice)).toEqual([]);
    expect(primaryPubkeyForUser(db, "no-such-user")).toBeNull();
    expect(attributionPubkey(db, { subject: "operator" })).toBeNull();
  });
});

describe("purgeExpiredChallenges", () => {
  test("drops rows past their TTL and leaves live ones", async () => {
    const alice = await user("alice");
    const t0 = new Date(1_700_000_000_000);
    issuePubkeyChallenge(db, alice, t0);
    const live = issuePubkeyChallenge(db, alice, new Date(t0.getTime() + PUBKEY_CHALLENGE_TTL_MS));
    const purged = purgeExpiredChallenges(db, new Date(t0.getTime() + PUBKEY_CHALLENGE_TTL_MS + 1));
    expect(purged).toBe(1);
    expect(
      linkPubkey(db, {
        userId: alice,
        pubkey: PK_A,
        challenge: live.challenge,
        proofEvent: proof(PK_A, live.challenge),
        now: new Date(t0.getTime() + PUBKEY_CHALLENGE_TTL_MS + 1),
      }).ok,
    ).toBe(true);
  });
});

describe("mint-time attribution snapshot", () => {
  test("recordTokenMint stamps the subject's primary pubkey", async () => {
    const alice = await user("alice");
    const now = new Date();
    const { challenge } = issuePubkeyChallenge(db, alice, now);
    linkPubkey(db, {
      userId: alice,
      pubkey: PK_A,
      challenge,
      proofEvent: proof(PK_A, challenge),
      now,
    });

    recordTokenMint(db, {
      jti: "jti-linked",
      createdVia: "cli_mint",
      subject: alice,
      clientId: "parachute-hub",
      scopes: ["vault:work:read"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(findTokenRowByJti(db, "jti-linked")?.subjectPubkey).toBe(PK_A);
  });

  test("stays NULL for a subject with no linked key", async () => {
    const alice = await user("alice");
    recordTokenMint(db, {
      jti: "jti-unlinked",
      createdVia: "cli_mint",
      subject: alice,
      clientId: "parachute-hub",
      scopes: ["vault:work:read"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(findTokenRowByJti(db, "jti-unlinked")?.subjectPubkey).toBeNull();
  });

  test("signRefreshToken stamps the user's primary pubkey", async () => {
    const alice = await user("alice");
    const now = new Date();
    const { challenge } = issuePubkeyChallenge(db, alice, now);
    linkPubkey(db, {
      userId: alice,
      pubkey: PK_A,
      challenge,
      proofEvent: proof(PK_A, challenge),
      now,
    });
    signRefreshToken(db, {
      jti: "jti-refresh",
      userId: alice,
      clientId: "client",
      scopes: ["vault:read"],
    });
    expect(findTokenRowByJti(db, "jti-refresh")?.subjectPubkey).toBe(PK_A);
  });

  test("unlinking does NOT rewrite already-attributed registry rows", async () => {
    const alice = await user("alice");
    const now = new Date();
    const { challenge } = issuePubkeyChallenge(db, alice, now);
    linkPubkey(db, {
      userId: alice,
      pubkey: PK_A,
      challenge,
      proofEvent: proof(PK_A, challenge),
      now,
    });
    recordTokenMint(db, {
      jti: "jti-history",
      createdVia: "cli_mint",
      subject: alice,
      userId: alice,
      clientId: "parachute-hub",
      scopes: ["vault:work:read"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(unlinkPubkey(db, alice, PK_A)).toBe(true);
    // The audit row records what was true at mint time.
    expect(findTokenRowByJti(db, "jti-history")?.subjectPubkey).toBe(PK_A);
    // …but live resolution no longer names the key.
    expect(pubkeysForUser(db, alice)).toEqual([]);
  });

  test("an explicit subjectPubkey: null opts a mint out of the snapshot", async () => {
    const alice = await user("alice");
    const now = new Date();
    const { challenge } = issuePubkeyChallenge(db, alice, now);
    linkPubkey(db, {
      userId: alice,
      pubkey: PK_A,
      challenge,
      proofEvent: proof(PK_A, challenge),
      now,
    });
    recordTokenMint(db, {
      jti: "jti-optout",
      createdVia: "cli_mint",
      subject: alice,
      clientId: "parachute-hub",
      scopes: ["vault:work:read"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      subjectPubkey: null,
    });
    expect(findTokenRowByJti(db, "jti-optout")?.subjectPubkey).toBeNull();
  });
});
