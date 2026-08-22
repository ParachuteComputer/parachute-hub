/**
 * NIP-01 event shape validation + signature verification. Pure: no DB, no
 * HTTP, no network, no relay. This is the whole cryptographic surface of the
 * hub#833 phase-1a pubkey-linkage ceremony, deliberately isolated so it can
 * be reviewed and fuzzed on its own.
 *
 * ## What NIP-01 actually specifies
 *
 * An event is `{id, pubkey, created_at, kind, tags, content, sig}` where:
 *
 *   - `pubkey` is a **32-byte x-only** secp256k1 public key, lowercase hex
 *     (64 chars). Note this is NOT a 33-byte compressed SEC1 key — nostr
 *     drops the parity byte (BIP-340).
 *   - `id` is `sha256(utf8(JSON.stringify([0, pubkey, created_at, kind,
 *     tags, content])))`, lowercase hex. The array form is exact and
 *     whitespace-free; `JSON.stringify` produces precisely the escaping
 *     NIP-01 mandates (`\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, and `\uXXXX`
 *     for other control characters; non-ASCII passes through literally).
 *   - `sig` is a **BIP-340 Schnorr** signature over the 32 raw bytes of `id`
 *     (not over the hex string), 64 bytes / 128 hex chars.
 *
 * So verification is two independent checks and BOTH must hold: the id must
 * be a faithful hash of the payload (otherwise a signed id could be paired
 * with arbitrary content) and the signature must verify against the claimed
 * x-only pubkey (otherwise anyone could claim anyone's key).
 *
 * ## Why the bounds
 *
 * Everything here runs on an unauthenticated-by-crypto input — the caller has
 * a session, but the event body is attacker-shaped. `nostrEventId` hashes the
 * re-serialized payload, so an unbounded `content` or an unbounded tag array
 * is a CPU + memory amplifier. `parseNostrEvent` therefore refuses anything
 * outside the constants below BEFORE any hashing or curve arithmetic happens.
 * The limits are far above what a real linkage event needs (empty content,
 * three short tags).
 *
 * ## Scope boundary
 *
 * This module verifies that *whoever produced this event holds the private
 * key for `pubkey`*. It says nothing about freshness, replay, or which hub
 * the event was meant for — those are the caller's job (`api-account-pubkeys.ts`
 * binds a server-issued single-use challenge plus the `u` / `method` tags).
 */
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

/**
 * Event kind for the linkage ceremony. 27235 is NIP-98's "HTTP Auth" kind
 * (the decimal of HTTP status-ish `0x6a73`... in practice just the number the
 * NIP assigns), which is the closest standard shape to "prove key possession
 * against one specific HTTP endpoint". We reuse the kind + its `u` / `method`
 * tags rather than inventing a hub-private kind, so a generic NIP-98 signer
 * can produce our event with one extra tag.
 *
 * We do NOT implement NIP-98 as a request-authentication scheme: NIP-98's own
 * replay defense is a ±60s `created_at` window, which is weak. The hub issues
 * a single-use challenge instead and requires it in a `challenge` tag.
 */
export const NOSTR_AUTH_KIND = 27235;

/** Max `content` length. A linkage event carries none; 1 KiB is generous. */
export const MAX_EVENT_CONTENT_LEN = 1024;
/** Max number of tags on an accepted event. A linkage event needs three. */
export const MAX_EVENT_TAGS = 20;
/** Max elements within one tag. */
export const MAX_TAG_ELEMENTS = 8;
/** Max length of a single tag element. Bounds the `u` tag (a URL) comfortably. */
export const MAX_TAG_ELEMENT_LEN = 512;

/** A NIP-01 event that has passed shape validation. Fields are NOT yet verified. */
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** The id-bearing subset — everything the NIP-01 id serialization covers. */
export type UnsignedNostrEvent = Omit<NostrEvent, "id" | "sig">;

/**
 * Which field-shape rule an input violated. Deliberately coarse (one reason
 * per field, not per rule) — the HTTP layer collapses all of these into a
 * single generic client error anyway; the granularity exists for tests and
 * for a future debug log, not for the wire.
 */
export type NostrEventRejection =
  | "not_an_object"
  | "pubkey"
  | "id"
  | "sig"
  | "kind"
  | "created_at"
  | "content"
  | "tags";

export type ParseNostrEventResult =
  | { ok: true; event: NostrEvent }
  | { ok: false; reason: NostrEventRejection };

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/**
 * Lowercase-hex only — NOT case-insensitive. NIP-01 canonicalizes to
 * lowercase and the id serialization hashes the pubkey string verbatim, so an
 * uppercase pubkey would hash differently than the same key in canonical
 * form. Accepting both spellings would let one key present as two distinct
 * `user_pubkeys` primary keys. Reject, don't normalize.
 */
function isHex64(v: unknown): v is string {
  return typeof v === "string" && HEX64.test(v);
}

/**
 * Shape-validate an untrusted value as a NIP-01 event. Does NOT verify the id
 * or the signature — call `verifyNostrEvent` for that. Every field is checked
 * for both type and bound; nothing is coerced, normalized, or defaulted.
 */
export function parseNostrEvent(raw: unknown): ParseNostrEventResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "not_an_object" };
  }
  const o = raw as Record<string, unknown>;

  if (!isHex64(o.pubkey)) return { ok: false, reason: "pubkey" };
  if (!isHex64(o.id)) return { ok: false, reason: "id" };
  if (typeof o.sig !== "string" || !HEX128.test(o.sig)) return { ok: false, reason: "sig" };
  if (typeof o.kind !== "number" || !Number.isSafeInteger(o.kind) || o.kind < 0) {
    return { ok: false, reason: "kind" };
  }
  // `created_at` is a Unix second count. Negative values are nonsense and
  // non-integers would re-serialize differently than they arrived.
  if (typeof o.created_at !== "number" || !Number.isSafeInteger(o.created_at) || o.created_at < 0) {
    return { ok: false, reason: "created_at" };
  }
  if (typeof o.content !== "string" || o.content.length > MAX_EVENT_CONTENT_LEN) {
    return { ok: false, reason: "content" };
  }
  if (!Array.isArray(o.tags) || o.tags.length > MAX_EVENT_TAGS) {
    return { ok: false, reason: "tags" };
  }
  const tags: string[][] = [];
  for (const tag of o.tags) {
    if (!Array.isArray(tag) || tag.length > MAX_TAG_ELEMENTS) return { ok: false, reason: "tags" };
    for (const el of tag) {
      if (typeof el !== "string" || el.length > MAX_TAG_ELEMENT_LEN) {
        return { ok: false, reason: "tags" };
      }
    }
    tags.push(tag as string[]);
  }

  return {
    ok: true,
    event: {
      id: o.id,
      pubkey: o.pubkey,
      created_at: o.created_at,
      kind: o.kind,
      tags,
      content: o.content,
      sig: o.sig,
    },
  };
}

/**
 * The canonical NIP-01 event id: `sha256` over the whitespace-free JSON array
 * `[0, pubkey, created_at, kind, tags, content]`, lowercase hex.
 */
export function nostrEventId(event: UnsignedNostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export type VerifyNostrEventResult =
  | { ok: true }
  | { ok: false; reason: "id_mismatch" | "bad_signature" };

/**
 * Verify a shape-validated event. Order is load-bearing: the id is recomputed
 * FIRST (cheap sha256, no curve math) and only a faithful id reaches the
 * Schnorr verify. That way a payload/id mismatch is rejected without spending
 * an elliptic-curve operation, and — more importantly — a valid signature can
 * never be paired with content it doesn't cover.
 *
 * `schnorr.verify` throws on structurally invalid inputs (a pubkey that isn't
 * a valid x-coordinate, an out-of-range signature scalar) rather than
 * returning false, so the call is wrapped: an exception is a failed
 * verification, never a 500.
 */
export function verifyNostrEvent(event: NostrEvent): VerifyNostrEventResult {
  if (nostrEventId(event) !== event.id) return { ok: false, reason: "id_mismatch" };
  try {
    // Signature is over the 32 RAW bytes of the id, not its hex spelling.
    const ok = schnorr.verify(
      Uint8Array.from(Buffer.from(event.sig, "hex")),
      Uint8Array.from(Buffer.from(event.id, "hex")),
      Uint8Array.from(Buffer.from(event.pubkey, "hex")),
    );
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
}

/**
 * First-wins lookup of a tag's value (`tag[1]`) by name (`tag[0]`). Returns
 * null when no tag matches or the matching tag carries no value. First-wins
 * (not last-wins, not "reject duplicates") matches how nostr clients read
 * tags; because the whole tag array is covered by the id and therefore by the
 * signature, a duplicate tag can only have been placed there by the signer.
 */
export function tagValue(event: NostrEvent, name: string): string | null {
  for (const tag of event.tags) {
    if (tag[0] === name) return tag[1] ?? null;
  }
  return null;
}
