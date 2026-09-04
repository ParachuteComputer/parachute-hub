/**
 * NIP-01 event parsing + verification (hub#833 phase 1a).
 *
 * Coverage:
 *   - an INTEROP VECTOR: a real, third-party-signed event pulled off a public
 *     relay, whose id we recompute and whose signature we verify (see below —
 *     this is the only test here that could catch a wrong serialization)
 *   - a known-answer id matching nostr-tools@2 `getEventHash` (and an
 *     independent Python 3 `json.dumps` + sha256) on a well-formed event
 *   - lone UTF-16 surrogates in `content` or a tag value are rejected
 *     (hub#863) — NIP-01 serialization is UTF-8
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

/**
 * A REAL nostr event, published to the network by a third party and pulled
 * verbatim off `wss://relay.damus.io` on 2026-08-22. Its `id` and `sig` were
 * produced by someone else's NIP-01 implementation, so this is the one test in
 * this file that can fail if ours is wrong.
 *
 * Every other test here is self-consistent: they sign with `nostrEventId` and
 * verify with `nostrEventId`, so a wrong field ORDER, a stray space in the
 * serialization, or a mis-encoded escape would sail straight through all of
 * them — and the hub would then be storing linkage "proofs" that no other
 * nostr client on earth can check. That would defeat the entire point of
 * phase 1b (portable, independently verifiable attribution).
 *
 * This vector is deliberately gnarly, which is why it was kept: the content
 * carries non-ASCII that must pass through LITERALLY (em dash, `ç`, `õ`, `·`)
 * and embedded newlines that must be escaped as `\n`, and the tags include a
 * three-element tag alongside five two-element ones.
 */
const RELAY_VECTOR: NostrEvent = {
  content:
    "Brasil — Lula pede explicações sobre gastos militares e defende investimento nas Forças Armadas #Trump #EUA #Brasil #Leia #News\nhttps://news.netasgard.com/a/29b2e0645b66d163?s=nostr\nhttps://live.staticflickr.com/3902/15318846711_7ba23972d0_b.jpg\nPhoto : Defence Images · CC BY · Flickr",
  created_at: 1787426739,
  id: "e7ee0421a4d0dc4600da344044b5886f8a757dd4a12ebfefc31f1e4d8f2d9651",
  kind: 1,
  pubkey: "ea3611098bd33ee05b162966b275882afdd5509529efa31d1896a6bb07abf59b",
  sig: "0d853e0ff0e983f3cae2526c99475be344f515da9be1129537878659915d9f36d641727aac13e957f55c89afd8b12e2b67c917081e322057eb3b57aed6438461",
  tags: [
    ["t", "trump"],
    ["t", "eua"],
    ["t", "brasil"],
    ["t", "leia"],
    ["t", "news"],
    [
      "imeta",
      "url https://live.staticflickr.com/3902/15318846711_7ba23972d0_b.jpg",
      "m image/jpeg",
    ],
  ],
};

describe("interop with the real nostr network", () => {
  test("recomputes the id of a third-party-signed relay event", () => {
    // If our `[0, pubkey, created_at, kind, tags, content]` serialization
    // disagreed with NIP-01 in ANY way, this would not match.
    expect(nostrEventId(RELAY_VECTOR)).toBe(RELAY_VECTOR.id);
  });

  test("verifies the BIP-340 signature on that event", () => {
    expect(verifyNostrEvent(RELAY_VECTOR)).toEqual({ ok: true });
  });

  test("accepts it through the same bounds the ceremony applies", () => {
    // A real-world event is not a synthetic one: this pins that the bounds in
    // `parseNostrEvent` are not so tight that ordinary nostr events bounce.
    const parsed = parseNostrEvent(JSON.parse(JSON.stringify(RELAY_VECTOR)));
    expect(parsed.ok).toBe(true);
  });

  test("rejects it once a single non-ASCII character is changed", () => {
    // The control for the three tests above: they must be capable of failing.
    const tampered: NostrEvent = {
      ...RELAY_VECTOR,
      content: RELAY_VECTOR.content.replace("Brasil —", "Brasil -"),
    };
    expect(nostrEventId(tampered)).not.toBe(RELAY_VECTOR.id);
    expect(verifyNostrEvent(tampered)).toEqual({ ok: false, reason: "id_mismatch" });
  });
});

describe("nostrEventId", () => {
  test("known-answer: well-formed event id matches nostr-tools@2 getEventHash", () => {
    // Computed independently, 2026-09-04, against current `next` (`32d9e77`):
    //   nostr-tools@2 getEventHash → 5ab4a55d193743b8146e901fb026f531877318d7d9717eec645f3222a856e4df
    //   Python 3 json.dumps(separators=(',', ':'), ensure_ascii=False) + sha256
    //     → the same hex
    // This is the UTF-8-well-formed half of hub#863. The relay vector above
    // is a third-party signed event; this one is a frozen hash from two
    // reference implementations so a serialization drift cannot hide behind
    // "we signed what we hashed".
    expect(
      nostrEventId({
        pubkey: "0".repeat(64),
        created_at: 1700000000,
        kind: 1,
        tags: [],
        content: "hello",
      }),
    ).toBe("5ab4a55d193743b8146e901fb026f531877318d7d9717eec645f3222a856e4df");
  });

  test("matches the canonical NIP-01 serialization", () => {
    // Self-consistency only — the interop vector above is what pins the
    // serialization to the spec.
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

  test("rejects a lone UTF-16 surrogate in content (hub#863)", () => {
    // Confirmed still open on origin/next 32d9e77: parseNostrEvent accepted
    // these, and nostrEventId hashed JSON.stringify's `\ud800` escape to
    // 2144f4e9… while a UTF-8 replacement (U+FFFD) hashed to 0984f0d2….
    // NIP-01 is UTF-8; such content cannot be a valid signed event elsewhere.
    // Constructed at runtime: a `\uD800` source literal is well-formed to
    // U+FFFD by bun's test transpiler before the assertion runs.
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    expect(loneHigh.isWellFormed()).toBe(false);
    expect(parseNostrEvent({ ...good(), content: loneHigh })).toEqual({
      ok: false,
      reason: "content",
    });
    expect(parseNostrEvent({ ...good(), content: loneLow })).toEqual({
      ok: false,
      reason: "content",
    });
    expect(parseNostrEvent({ ...good(), content: `ok${loneHigh}` })).toEqual({
      ok: false,
      reason: "content",
    });
  });

  test("rejects a lone UTF-16 surrogate in a tag value (hub#863)", () => {
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    expect(parseNostrEvent({ ...good(), tags: [["u", loneHigh]] })).toEqual({
      ok: false,
      reason: "tags",
    });
    expect(parseNostrEvent({ ...good(), tags: [["challenge", `x${loneLow}`]] })).toEqual({
      ok: false,
      reason: "tags",
    });
  });

  test("still accepts a well-formed supplementary character (paired surrogates)", () => {
    // U+10000 is one supplementary scalar, encoded as a surrogate pair.
    // Rejecting every surrogate would break emoji / non-BMP content.
    const pair = String.fromCharCode(0xd800, 0xdc00);
    expect(pair.isWellFormed()).toBe(true);
    expect(parseNostrEvent({ ...good(), content: pair }).ok).toBe(true);
    expect(parseNostrEvent({ ...good(), tags: [["t", "😀"]] }).ok).toBe(true);
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
