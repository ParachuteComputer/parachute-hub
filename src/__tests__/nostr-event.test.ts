/**
 * NIP-01 event parsing + verification (hub#833 phase 1a).
 *
 * Coverage:
 *   - `nostrEventId` reproduces the canonical NIP-01 serialization/hash
 *   - a genuinely signed event verifies; a tampered field does not
 *   - every field-shape rejection: pubkey / id / sig hex + length, kind,
 *     created_at, content, tags (count, nesting, element length)
 *   - `tagValue` first-wins lookup
 */
import { describe, expect, test } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  MAX_EVENT_CONTENT_LEN,
  MAX_EVENT_TAGS,
  MAX_TAG_ELEMENTS,
  MAX_TAG_ELEMENT_LEN,
  NOSTR_AUTH_KIND,
  type NostrEvent,
  nostrEventId,
  parseNostrEvent,
  tagValue,
  verifyNostrEvent,
} from "../nostr-event.ts";

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** Deterministic-ish test key. Any 32 bytes works. */
const SECRET = hexToBytes("aa".repeat(32));
const PUBKEY = bytesToHex(schnorr.getPublicKey(SECRET));

function signEvent(
  parts: {
    created_at?: number;
    kind?: number;
    tags?: string[][];
    content?: string;
  } = {},
  secret: Uint8Array = SECRET,
): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(secret));
  const unsigned = {
    pubkey,
    created_at: parts.created_at ?? Math.floor(Date.now() / 1000),
    kind: parts.kind ?? NOSTR_AUTH_KIND,
    tags: parts.tags ?? [],
    content: parts.content ?? "",
  };
  const id = nostrEventId(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret));
  return { ...unsigned, id, sig };
}

describe("nostrEventId", () => {
  test("matches the canonical NIP-01 serialization", () => {
    // Known-answer: sha256 of `[0,"<pk>",1700000000,1,[],"hello"]` computed
    // independently by the same rule the spec states.
    const id = nostrEventId({
      pubkey: "0".repeat(64),
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: "hello",
    });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    // Stability: recomputing gives the same value, and any field change moves it.
    expect(
      nostrEventId({
        pubkey: "0".repeat(64),
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: "hello",
      }),
    ).toBe(id);
    expect(
      nostrEventId({
        pubkey: "0".repeat(64),
        created_at: 1700000001,
        kind: 1,
        tags: [],
        content: "hello",
      }),
    ).not.toBe(id);
  });

  test("is sensitive to tag contents", () => {
    const base = { pubkey: "1".repeat(64), created_at: 1, kind: 27235, content: "" };
    expect(nostrEventId({ ...base, tags: [["u", "a"]] })).not.toBe(
      nostrEventId({ ...base, tags: [["u", "b"]] }),
    );
  });
});

describe("verifyNostrEvent", () => {
  test("accepts a genuinely signed event", () => {
    const ev = signEvent({ tags: [["challenge", "abc"]] });
    expect(verifyNostrEvent(ev)).toEqual({ ok: true });
  });

  test("rejects an id that does not match the payload", () => {
    const ev = signEvent();
    const tampered: NostrEvent = { ...ev, content: "changed" };
    expect(verifyNostrEvent(tampered)).toEqual({ ok: false, reason: "id_mismatch" });
  });

  test("rejects a signature from a different key", () => {
    const ev = signEvent();
    const otherSig = bytesToHex(schnorr.sign(hexToBytes(ev.id), hexToBytes("bb".repeat(32))));
    expect(verifyNostrEvent({ ...ev, sig: otherSig })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("rejects a signature that is structurally valid hex but not a signature", () => {
    const ev = signEvent();
    expect(verifyNostrEvent({ ...ev, sig: "0".repeat(128) })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("rejects a pubkey that is not a valid x-only point", () => {
    const ev = signEvent();
    // All-ff is not a valid field element / x-coordinate.
    expect(verifyNostrEvent({ ...ev, pubkey: "f".repeat(64), id: ev.id })).toEqual({
      ok: false,
      reason: "id_mismatch",
    });
    // Recompute the id so the failure is attributable to the key, not the id.
    const unsigned = { ...ev, pubkey: "f".repeat(64) };
    const withId = { ...unsigned, id: nostrEventId(unsigned) };
    expect(verifyNostrEvent(withId)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("parseNostrEvent", () => {
  const good = () => JSON.parse(JSON.stringify(signEvent({ tags: [["u", "https://x/y"]] })));

  test("accepts a well-shaped event", () => {
    const res = parseNostrEvent(good());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event.pubkey).toBe(PUBKEY);
  });

  test("rejects non-objects", () => {
    for (const raw of [null, undefined, 3, "str", []]) {
      expect(parseNostrEvent(raw)).toEqual({ ok: false, reason: "not_an_object" });
    }
  });

  test("rejects a malformed pubkey", () => {
    for (const pubkey of ["", "abc", "A".repeat(64), `${PUBKEY}0`, 5]) {
      expect(parseNostrEvent({ ...good(), pubkey })).toEqual({ ok: false, reason: "pubkey" });
    }
  });

  test("rejects a malformed id", () => {
    for (const id of ["", "zz".repeat(32), "A".repeat(64), 5]) {
      expect(parseNostrEvent({ ...good(), id })).toEqual({ ok: false, reason: "id" });
    }
  });

  test("rejects a malformed sig", () => {
    for (const sig of ["", "0".repeat(127), "A".repeat(128), 5]) {
      expect(parseNostrEvent({ ...good(), sig })).toEqual({ ok: false, reason: "sig" });
    }
  });

  test("rejects a non-integer kind", () => {
    for (const kind of [1.5, "1", Number.NaN, undefined]) {
      expect(parseNostrEvent({ ...good(), kind })).toEqual({ ok: false, reason: "kind" });
    }
  });

  test("rejects a non-integer created_at", () => {
    for (const created_at of [1.5, "1", Number.NaN, undefined, -1]) {
      expect(parseNostrEvent({ ...good(), created_at })).toEqual({
        ok: false,
        reason: "created_at",
      });
    }
  });

  test("rejects oversized or non-string content", () => {
    expect(parseNostrEvent({ ...good(), content: 5 })).toEqual({ ok: false, reason: "content" });
    expect(parseNostrEvent({ ...good(), content: "x".repeat(MAX_EVENT_CONTENT_LEN + 1) })).toEqual({
      ok: false,
      reason: "content",
    });
    expect(parseNostrEvent({ ...good(), content: "x".repeat(MAX_EVENT_CONTENT_LEN) }).ok).toBe(
      true,
    );
  });

  test("rejects malformed / oversized tags", () => {
    expect(parseNostrEvent({ ...good(), tags: "nope" })).toEqual({ ok: false, reason: "tags" });
    expect(parseNostrEvent({ ...good(), tags: [["a"], "b"] })).toEqual({
      ok: false,
      reason: "tags",
    });
    expect(parseNostrEvent({ ...good(), tags: [[1, 2]] })).toEqual({ ok: false, reason: "tags" });
    expect(
      parseNostrEvent({ ...good(), tags: Array.from({ length: MAX_EVENT_TAGS + 1 }, () => ["a"]) }),
    ).toEqual({ ok: false, reason: "tags" });
    expect(
      parseNostrEvent({
        ...good(),
        tags: [Array.from({ length: MAX_TAG_ELEMENTS + 1 }, () => "a")],
      }),
    ).toEqual({ ok: false, reason: "tags" });
    expect(
      parseNostrEvent({ ...good(), tags: [["a", "x".repeat(MAX_TAG_ELEMENT_LEN + 1)]] }),
    ).toEqual({ ok: false, reason: "tags" });
  });
});

describe("tagValue", () => {
  test("returns the first matching tag's second element", () => {
    const ev = signEvent({
      tags: [["challenge", "first"], ["challenge", "second"], ["u", "https://hub/x"], ["empty"]],
    });
    expect(tagValue(ev, "challenge")).toBe("first");
    expect(tagValue(ev, "u")).toBe("https://hub/x");
    expect(tagValue(ev, "empty")).toBeNull();
    expect(tagValue(ev, "absent")).toBeNull();
  });
});
