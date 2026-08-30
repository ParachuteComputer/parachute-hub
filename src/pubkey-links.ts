/**
 * Nostr-pubkey ↔ hub-user linkage store, and the read side of verifiable
 * write attribution (hub#833 phase 1; team-vault design "2026-08-22
 * Multi-user Parachute — draft for reaction" §3 phase 1a/1b).
 *
 * Persistence + policy only — the cryptography lives in `nostr-event.ts` and
 * the HTTP wire layer in `api-account-pubkeys.ts`. This module never sees a
 * Request and never verifies a signature; its caller does that first and then
 * asks this module to commit the result.
 *
 * ## The linkage model
 *
 * A hub user may hold **zero or more** linked keys; a key names **at most one**
 * user hub-wide (`user_pubkeys.pubkey` is the PRIMARY KEY — see migration v17
 * for why that is a security property rather than a convenience).
 * Successful ceremonies are also copied into `attribution_proofs`, keyed by
 * `(subject, pubkey)` without a user foreign key. That durable audit row is
 * intentionally not deleted with the live link or account: registry snapshots
 * naming the subject and key must remain independently verifiable.
 *
 * No new principal entity is introduced. `users.id` is already what every
 * minted token's `sub` claim carries, so linkage hangs off the row that
 * already exists and `sub` semantics are untouched.
 *
 * ## What a linked key does and does not grant
 *
 * On the **cookie + password** path a linked key still grants nothing — it is
 * an attribution label (phase 1). On the **NIP-98 HTTP auth** path
 * (`nostr-http-auth.ts`, hub#833 (c)) the same table is the principal map:
 * a request signed by `pubkey` authenticates as `user_id`. Unlink drops
 * future NIP-98 logins for that key; it does not erase `attribution_proofs`.
 *
 * ## Replay protection
 *
 * The ceremony is challenge-response. `issuePubkeyChallenge` mints 32 bytes
 * of CSPRNG entropy, stores only its sha256 (the `invites` v12 precedent — a
 * DB read must not be enough to complete a ceremony), binds it to the issuing
 * user, and gives it a short TTL. `linkPubkey` consumes it *inside the same
 * transaction* as the link write, so two concurrent verifies of one challenge
 * cannot both land, and a replayed event cannot re-link.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

/**
 * Challenge lifetime. Long enough for a human to approve a signature in a
 * browser extension or a signing device; short enough that a challenge
 * captured from a log or a screen is dead by the time it's useful. Single-use
 * consumption is the primary defense — this is the belt.
 */
export const PUBKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Ceiling on linked keys per user. Not a security boundary (the caller is
 * already authenticated as themselves) — a storage bound, so a scripted
 * session can't accumulate unbounded rows. Well above the "laptop + phone +
 * signing device" shape.
 */
export const MAX_PUBKEYS_PER_USER = 10;

/** 32-byte x-only secp256k1 key, lowercase hex. Reject mixed case — don't normalize. */
export const PUBKEY_HEX_RE = /^[0-9a-f]{64}$/;

export function isPubkeyHex(value: string): boolean {
  return PUBKEY_HEX_RE.test(value);
}

/** A verified pubkey→user link. `proofEvent` is fetched separately (it's bulky). */
export interface LinkedPubkey {
  pubkey: string;
  userId: string;
  label: string | null;
  /** Id of the NIP-01 event that proved possession most recently. */
  proofEventId: string;
  /** First successful link. Never rewritten by a re-verify. */
  linkedAt: string;
  /** Most recent successful proof. */
  lastVerifiedAt: string;
}

/** A subject→pubkey possession proof retained independently of the live link. */
export interface AttributionProof extends LinkedPubkey {
  /** Verbatim signed NIP-01 event; callers can re-verify it independently. */
  proofEvent: string;
}

interface LinkRow {
  pubkey: string;
  user_id: string;
  label: string | null;
  proof_event_id: string;
  linked_at: string;
  last_verified_at: string;
}

interface AttributionProofRow {
  subject: string;
  pubkey: string;
  label: string | null;
  proof_event: string;
  proof_event_id: string;
  linked_at: string;
  last_verified_at: string;
}

function rowToLink(r: LinkRow): LinkedPubkey {
  return {
    pubkey: r.pubkey,
    userId: r.user_id,
    label: r.label,
    proofEventId: r.proof_event_id,
    linkedAt: r.linked_at,
    lastVerifiedAt: r.last_verified_at,
  };
}

function rowToAttributionProof(r: AttributionProofRow): AttributionProof {
  return {
    pubkey: r.pubkey,
    userId: r.subject,
    label: r.label,
    proofEvent: r.proof_event,
    proofEventId: r.proof_event_id,
    linkedAt: r.linked_at,
    lastVerifiedAt: r.last_verified_at,
  };
}

function retainAttributionProof(
  db: Database,
  proof: {
    subject: string;
    pubkey: string;
    label: string | null;
    proofEvent: string;
    proofEventId: string;
    linkedAt: string;
    lastVerifiedAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO attribution_proofs
       (subject, pubkey, label, proof_event, proof_event_id, linked_at, last_verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject, pubkey) DO UPDATE SET
       label = excluded.label,
       proof_event = excluded.proof_event,
       proof_event_id = excluded.proof_event_id,
       last_verified_at = excluded.last_verified_at`,
  ).run(
    proof.subject,
    proof.pubkey,
    proof.label,
    proof.proofEvent,
    proof.proofEventId,
    proof.linkedAt,
    proof.lastVerifiedAt,
  );
}

/**
 * Hash a challenge for storage / lookup. sha256 over the ASCII hex spelling.
 * The challenge is already full-entropy random, so a plain digest is correct
 * here — there is no low-entropy dictionary for a work factor to defend
 * against (unlike a password, which is why those use argon2id).
 */
function hashChallenge(challenge: string): string {
  return createHash("sha256").update(challenge, "utf8").digest("hex");
}

export interface IssuedChallenge {
  /** The raw value to hand the client. NOT recoverable from the DB. */
  challenge: string;
  expiresAt: string;
}

/**
 * Mint a single-use, user-bound, TTL-bounded challenge and persist its hash.
 * The caller is responsible for having established `userId` from a session —
 * this module never accepts a client-supplied identity.
 */
export function issuePubkeyChallenge(
  db: Database,
  userId: string,
  now: Date = new Date(),
): IssuedChallenge {
  const challenge = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + PUBKEY_CHALLENGE_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO pubkey_challenges (challenge_hash, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(hashChallenge(challenge), userId, expiresAt, now.toISOString());
  return { challenge, expiresAt };
}

/**
 * Drop consumed/expired challenge rows. Housekeeping only — an expired row is
 * already unusable (`linkPubkey` re-checks `expires_at` and `consumed_at`), so
 * this exists to stop the table growing, not to enforce anything. Called
 * opportunistically from the challenge-issuing path.
 */
export function purgeExpiredChallenges(db: Database, now: Date = new Date()): number {
  const res = db
    .prepare("DELETE FROM pubkey_challenges WHERE expires_at <= ?")
    .run(now.toISOString());
  return Number(res.changes);
}

export interface LinkPubkeyOpts {
  /** Established from the session by the caller. Never client-supplied. */
  userId: string;
  /** Lowercase-hex x-only key. The caller has ALREADY verified possession. */
  pubkey: string;
  /** The raw challenge the signed event carried. */
  challenge: string;
  /** The verbatim signed NIP-01 event, for later independent re-verification. */
  proofEvent: string;
  /** Id of that event (`nostrEventId`). */
  proofEventId?: string;
  /**
   * Three-valued, and the distinction is load-bearing on a re-verify (hub#862):
   *
   *   - `undefined` — "leave whatever is stored alone". A re-verify that
   *     carries no label keeps the label the user set on an earlier link.
   *   - `null` — "clear it". An explicit erase.
   *   - a string — set it.
   *
   * On a FIRST link there is nothing to preserve, so `undefined` and `null`
   * both land as a null label.
   */
  label?: string | null;
  now?: Date;
}

export type LinkPubkeyResult =
  | { ok: true; link: LinkedPubkey; relinked: boolean }
  | { ok: false; reason: "challenge_invalid" | "pubkey_taken" | "too_many_pubkeys" };

/**
 * Commit a verified link. **Every step runs in one transaction** so the
 * challenge consumption and the link write are atomic:
 *
 *   1. Consume the challenge with a conditional UPDATE — it must exist, belong
 *      to THIS user, be unconsumed, and be unexpired. `changes === 0` collapses
 *      all four failures into one indistinguishable `challenge_invalid`, on
 *      purpose: distinguishing "no such challenge" from "that's someone else's
 *      challenge" would be a cross-account oracle. Nothing else in the
 *      transaction has run yet, so a rejected challenge writes nothing.
 *   2. Refuse a key already held by a DIFFERENT user (`pubkey_taken`).
 *   3. Refuse a NEW key past the per-user cap. A re-verify of an existing key
 *      is exempt (it adds no row).
 *   4. Insert, or update-in-place when the same user re-verifies the same key.
 *      A re-verify refreshes `last_verified_at` and the stored proof;
 *      `linked_at` is preserved as the original link time, and so is `label`
 *      unless the caller supplied one (hub#862 — see `LinkPubkeyOpts.label`).
 *      The label is the user's own annotation, not something the proof
 *      establishes, so a ceremony that says nothing about it must not erase it.
 *
 * **A challenge that validated in step 1 stays consumed even when steps 2–3
 * refuse.** That is deliberate: the signed event has been presented, so it is
 * spent, and no outcome of this call can leave a replayable pair on the table.
 * The cost is that a refused attempt needs a fresh challenge; that is the
 * right trade for an auth surface.
 *
 * The caller MUST have verified the NIP-01 signature over `challenge` for
 * `pubkey` before calling. This function performs no cryptography.
 */
export function linkPubkey(db: Database, opts: LinkPubkeyOpts): LinkPubkeyResult {
  const now = opts.now ?? new Date();
  const stamp = now.toISOString();
  // `undefined` means "unspecified" here, NOT "null" — the re-verify branch
  // below reads it back to decide between keeping and overwriting the stored
  // label. `?? null` is only correct on the insert branch, where there is no
  // prior label to keep.
  const label = opts.label;
  const proofEventId = opts.proofEventId ?? "";

  const run = db.transaction((): LinkPubkeyResult => {
    const consumed = db
      .prepare(
        `UPDATE pubkey_challenges SET consumed_at = ?
         WHERE challenge_hash = ? AND user_id = ? AND consumed_at IS NULL AND expires_at > ?`,
      )
      .run(stamp, hashChallenge(opts.challenge), opts.userId, stamp);
    if (Number(consumed.changes) === 0) return { ok: false, reason: "challenge_invalid" };

    const existing = db
      .query<LinkRow, [string]>("SELECT * FROM user_pubkeys WHERE pubkey = ?")
      .get(opts.pubkey);
    if (existing && existing.user_id !== opts.userId) {
      return { ok: false, reason: "pubkey_taken" };
    }

    if (!existing) {
      const count = (
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM user_pubkeys WHERE user_id = ?",
          )
          .get(opts.userId) ?? { n: 0 }
      ).n;
      if (count >= MAX_PUBKEYS_PER_USER) return { ok: false, reason: "too_many_pubkeys" };
      const newLabel = label ?? null;
      db.prepare(
        `INSERT INTO user_pubkeys
           (pubkey, user_id, label, proof_event, proof_event_id, linked_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(opts.pubkey, opts.userId, newLabel, opts.proofEvent, proofEventId, stamp, stamp);
      retainAttributionProof(db, {
        subject: opts.userId,
        pubkey: opts.pubkey,
        label: newLabel,
        proofEvent: opts.proofEvent,
        proofEventId,
        linkedAt: stamp,
        lastVerifiedAt: stamp,
      });
      return {
        ok: true,
        relinked: false,
        link: {
          pubkey: opts.pubkey,
          userId: opts.userId,
          label: newLabel,
          proofEventId,
          linkedAt: stamp,
          lastVerifiedAt: stamp,
        },
      };
    }

    // hub#862: an unspecified label leaves the stored one standing. The row
    // already exists, so "no label in this request" is the ceremony being
    // silent about the label, not the user asking for it to be blank.
    const nextLabel = label === undefined ? existing.label : label;
    db.prepare(
      `UPDATE user_pubkeys
         SET label = ?, proof_event = ?, proof_event_id = ?, last_verified_at = ?
       WHERE pubkey = ? AND user_id = ?`,
    ).run(nextLabel, opts.proofEvent, proofEventId, stamp, opts.pubkey, opts.userId);
    retainAttributionProof(db, {
      subject: opts.userId,
      pubkey: opts.pubkey,
      label: nextLabel,
      proofEvent: opts.proofEvent,
      proofEventId,
      linkedAt: existing.linked_at,
      lastVerifiedAt: stamp,
    });
    return {
      ok: true,
      relinked: true,
      link: {
        pubkey: opts.pubkey,
        userId: opts.userId,
        label: nextLabel,
        proofEventId,
        linkedAt: existing.linked_at,
        lastVerifiedAt: stamp,
      },
    };
  });
  return run();
}

/** Every key linked to a user, oldest link first (`pubkey` breaks ties). */
export function listUserPubkeys(db: Database, userId: string): LinkedPubkey[] {
  return db
    .query<LinkRow, [string]>(
      "SELECT * FROM user_pubkeys WHERE user_id = ? ORDER BY linked_at ASC, pubkey ASC",
    )
    .all(userId)
    .map(rowToLink);
}

/** The link a key currently names, or null. */
export function findPubkeyLink(db: Database, pubkey: string): LinkedPubkey | null {
  const row = db
    .query<LinkRow, [string]>("SELECT * FROM user_pubkeys WHERE pubkey = ?")
    .get(pubkey);
  return row ? rowToLink(row) : null;
}

export type BindPubkeyFromHttpAuthResult =
  | { ok: true; link: LinkedPubkey; relinked: boolean }
  | { ok: false; reason: "pubkey_taken" | "too_many_pubkeys" };

/**
 * Operator-attested bind: the hub asserts this key belongs to this user.
 * No NIP-01 event is stored — `proof_event` is empty and nothing is written
 * to `attribution_proofs`. Possession proofs stay in the ceremony / NIP-98
 * paths. Same uniqueness + per-user cap as `bindPubkeyFromHttpAuth`.
 */
export function bindPubkeyOperatorAttested(
  db: Database,
  opts: {
    userId: string;
    pubkey: string;
    label?: string | null;
    now?: Date;
  },
): BindPubkeyFromHttpAuthResult {
  const now = opts.now ?? new Date();
  const stamp = now.toISOString();
  const label = opts.label ?? "operator";
  const run = db.transaction((): BindPubkeyFromHttpAuthResult => {
    const existing = db
      .query<LinkRow, [string]>("SELECT * FROM user_pubkeys WHERE pubkey = ?")
      .get(opts.pubkey);
    if (existing && existing.user_id !== opts.userId) {
      return { ok: false, reason: "pubkey_taken" };
    }
    if (!existing) {
      const count = (
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM user_pubkeys WHERE user_id = ?",
          )
          .get(opts.userId) ?? { n: 0 }
      ).n;
      if (count >= MAX_PUBKEYS_PER_USER) return { ok: false, reason: "too_many_pubkeys" };
      db.prepare(
        `INSERT INTO user_pubkeys
           (pubkey, user_id, label, proof_event, proof_event_id, linked_at, last_verified_at)
         VALUES (?, ?, ?, '', '', ?, ?)`,
      ).run(opts.pubkey, opts.userId, label, stamp, stamp);
      return {
        ok: true,
        relinked: false,
        link: {
          pubkey: opts.pubkey,
          userId: opts.userId,
          label,
          proofEventId: "",
          linkedAt: stamp,
          lastVerifiedAt: stamp,
        },
      };
    }
    db.prepare(
      `UPDATE user_pubkeys
         SET label = ?, last_verified_at = ?
       WHERE pubkey = ? AND user_id = ?`,
    ).run(label, stamp, opts.pubkey, opts.userId);
    return {
      ok: true,
      relinked: true,
      link: {
        pubkey: opts.pubkey,
        userId: opts.userId,
        label,
        proofEventId: existing.proof_event_id,
        linkedAt: existing.linked_at,
        lastVerifiedAt: stamp,
      },
    };
  });
  return run();
}

/**
 * Bind `pubkey` to `userId` using a NIP-98 HTTP-auth event as the proof.
 * No challenge-response: the signed request *is* the possession proof.
 * The cookie ceremony (`linkPubkey`) stays challenge-gated.
 *
 * Caller MUST have verified the event (id + BIP-340 + `u`/`method` bind)
 * before calling. This function performs no cryptography.
 */
export function bindPubkeyFromHttpAuth(
  db: Database,
  opts: {
    userId: string;
    pubkey: string;
    proofEvent: string;
    proofEventId: string;
    label?: string | null;
    now?: Date;
  },
): BindPubkeyFromHttpAuthResult {
  const now = opts.now ?? new Date();
  const stamp = now.toISOString();
  const label = opts.label ?? null;
  const run = db.transaction((): BindPubkeyFromHttpAuthResult => {
    const existing = db
      .query<LinkRow, [string]>("SELECT * FROM user_pubkeys WHERE pubkey = ?")
      .get(opts.pubkey);
    if (existing && existing.user_id !== opts.userId) {
      return { ok: false, reason: "pubkey_taken" };
    }
    if (!existing) {
      const count = (
        db
          .query<{ n: number }, [string]>(
            "SELECT COUNT(*) AS n FROM user_pubkeys WHERE user_id = ?",
          )
          .get(opts.userId) ?? { n: 0 }
      ).n;
      if (count >= MAX_PUBKEYS_PER_USER) return { ok: false, reason: "too_many_pubkeys" };
      db.prepare(
        `INSERT INTO user_pubkeys
           (pubkey, user_id, label, proof_event, proof_event_id, linked_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(opts.pubkey, opts.userId, label, opts.proofEvent, opts.proofEventId, stamp, stamp);
      retainAttributionProof(db, {
        subject: opts.userId,
        pubkey: opts.pubkey,
        label,
        proofEvent: opts.proofEvent,
        proofEventId: opts.proofEventId,
        linkedAt: stamp,
        lastVerifiedAt: stamp,
      });
      return {
        ok: true,
        relinked: false,
        link: {
          pubkey: opts.pubkey,
          userId: opts.userId,
          label,
          proofEventId: opts.proofEventId,
          linkedAt: stamp,
          lastVerifiedAt: stamp,
        },
      };
    }
    db.prepare(
      `UPDATE user_pubkeys
         SET label = ?, proof_event = ?, proof_event_id = ?, last_verified_at = ?
       WHERE pubkey = ? AND user_id = ?`,
    ).run(label, opts.proofEvent, opts.proofEventId, stamp, opts.pubkey, opts.userId);
    retainAttributionProof(db, {
      subject: opts.userId,
      pubkey: opts.pubkey,
      label,
      proofEvent: opts.proofEvent,
      proofEventId: opts.proofEventId,
      linkedAt: existing.linked_at,
      lastVerifiedAt: stamp,
    });
    return {
      ok: true,
      relinked: true,
      link: {
        pubkey: opts.pubkey,
        userId: opts.userId,
        label,
        proofEventId: opts.proofEventId,
        linkedAt: existing.linked_at,
        lastVerifiedAt: stamp,
      },
    };
  });
  return run();
}

/**
 * The verbatim proof event for a linked key, so a reader can independently
 * re-verify possession (re-serialize → recompute the NIP-01 id → check the
 * BIP-340 signature) without trusting the hub's assertion.
 */
export function proofEventFor(db: Database, pubkey: string): string | null {
  const row = db
    .query<{ proof_event: string }, [string]>(
      "SELECT proof_event FROM user_pubkeys WHERE pubkey = ?",
    )
    .get(pubkey);
  return row?.proof_event ?? null;
}

/**
 * Every possession proof a subject has established, including proofs whose
 * live link was later removed. This durable archive is the audit counterpart
 * to `listUserPubkeys`, which answers only what the account holds now.
 */
export function attributionProofsForSubject(db: Database, subject: string): AttributionProof[] {
  return db
    .query<AttributionProofRow, [string]>(
      `SELECT subject, pubkey, label, proof_event, proof_event_id, linked_at, last_verified_at
       FROM attribution_proofs
       WHERE subject = ?
       ORDER BY linked_at ASC, pubkey ASC`,
    )
    .all(subject)
    .map(rowToAttributionProof);
}

/** Phase-1b resolution: a subject's linked keys, in deterministic order. */
export function pubkeysForUser(db: Database, userId: string): string[] {
  return listUserPubkeys(db, userId).map((l) => l.pubkey);
}

/**
 * The user's PRIMARY key — the earliest-linked one. Deterministic (ties break
 * on `pubkey`) so the mint-time snapshot is reproducible. Users with several
 * keys get one named on the registry row; `pubkeysForUser` remains the
 * authoritative full set.
 */
export function primaryPubkeyForUser(db: Database, userId: string): string | null {
  const row = db
    .query<{ pubkey: string }, [string]>(
      "SELECT pubkey FROM user_pubkeys WHERE user_id = ? ORDER BY linked_at ASC, pubkey ASC LIMIT 1",
    )
    .get(userId);
  return row?.pubkey ?? null;
}

/**
 * Remove a LIVE link. Self-only: the `user_id` predicate is not optional.
 * The independently stored attribution proof is deliberately retained.
 */
export function unlinkPubkey(db: Database, userId: string, pubkey: string): boolean {
  const res = db
    .prepare("DELETE FROM user_pubkeys WHERE pubkey = ? AND user_id = ?")
    .run(pubkey, userId);
  return Number(res.changes) > 0;
}

/**
 * Resolve the pubkey to snapshot onto a `tokens` registry row.
 *
 * A registry row identifies its principal two ways: `user_id` (set on OAuth
 * rows and on mints performed against a hub user) and `subject` (the JWT `sub`
 * — a user id on user-rooted mints, but also `"operator"`, a service short
 * name, or an agent id on service mints). We try `user_id` first because it is
 * unambiguous, then fall back to `subject`, which resolves only when it
 * happens to be a hub user id. A non-user subject simply finds no row and the
 * snapshot stays NULL — the "don't fabricate attribution" posture.
 *
 * Note the honest scope of the claim this produces: nobody authenticates the
 * request WITH a Nostr key in phase 1. The snapshot records "the principal
 * that minted this token had proved possession of this key" — the proof is
 * the stored NIP-01 event, not the mint request.
 */
export function attributionPubkey(
  db: Database,
  principal: { userId?: string | null; subject?: string | null },
): string | null {
  if (principal.userId) {
    const byUser = primaryPubkeyForUser(db, principal.userId);
    if (byUser) return byUser;
  }
  if (principal.subject) return primaryPubkeyForUser(db, principal.subject);
  return null;
}
