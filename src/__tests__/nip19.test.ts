/**
 * NIP-19 `npub` decoding + the `parseGrantPubkey` edge that uses it.
 *
 * Coverage:
 *   - an INTEROP VECTOR: the `npub` published in the NIP-19 spec itself,
 *     decoded to the hex the spec pairs it with (the only test here that
 *     could catch a wrong charset, HRP expansion, or bit-regrouping)
 *   - rejection of every near-miss: bad checksum, wrong HRP (`nsec1…`),
 *     wrong payload length, non-canonical padding, illegal characters,
 *     uppercase
 *   - `parseGrantPubkey`: npub → hex, hex passthrough, uppercase hex still
 *     refused (not normalized), and the error shape on every rejection
 *
 * Fixtures whose provenance isn't a published spec were generated with a
 * throwaway bech32 *encoder* (BIP-173 §checksum) rather than by hand — the
 * comment above each says what it encodes.
 */
import { describe, expect, test } from "bun:test";
import { GrantError, parseGrantPubkey } from "../grant-access.ts";
import { decodeNpub } from "../nip19.ts";

/** NIP-19 spec vector: this npub is defined to be this hex. */
const SPEC_NPUB = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";
const SPEC_HEX = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";

/** NIP-19 spec vector for a *secret* key — right bech32, wrong HRP. */
const SPEC_NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

/** Generated: hrp `npub` over bytes 0x01..0x20. Checksum-valid, 32 bytes. */
const GEN_NPUB = "npub1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g7rusqdknev3";
const GEN_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

/** Generated: hrp `npub` over 31 bytes. Checksum-valid, wrong payload length. */
const NPUB_31_BYTES = "npub1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g7rupzhmml";

/** Generated: hrp `npub` over 33 bytes. Checksum-valid, wrong payload length. */
const NPUB_33_BYTES = "npub1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g7ruszzhd5de4";

/**
 * Generated: `GEN_NPUB`'s 52 data words with the trailing pad bits set to a
 * non-zero value, re-checksummed. Right length, valid checksum, non-canonical
 * — BIP-173 says reject.
 */
const NPUB_DIRTY_PADDING = "npub1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5z5tpwxqergd3c8g7ruspsq8v3r";

describe("decodeNpub", () => {
  test("NIP-19 spec vector decodes to the spec's hex", () => {
    expect(decodeNpub(SPEC_NPUB)).toBe(SPEC_HEX);
  });

  test("decodes a generated npub to its bytes", () => {
    expect(decodeNpub(GEN_NPUB)).toBe(GEN_HEX);
  });

  test("rejects a bad checksum (last char flipped)", () => {
    const flipped = `${SPEC_NPUB.slice(0, -1)}q`;
    expect(flipped).not.toBe(SPEC_NPUB);
    expect(decodeNpub(flipped)).toBeNull();
  });

  test("rejects a transposition the checksum is meant to catch", () => {
    // Swap two adjacent data chars — the whole point of the BCH checksum.
    const chars = [...SPEC_NPUB];
    [chars[10], chars[11]] = [chars[11] as string, chars[10] as string];
    expect(decodeNpub(chars.join(""))).toBeNull();
  });

  test("rejects the wrong HRP (nsec, note, plain hex)", () => {
    expect(decodeNpub(SPEC_NSEC)).toBeNull();
    expect(decodeNpub(`note1${SPEC_NPUB.slice(5)}`)).toBeNull();
    expect(decodeNpub(SPEC_HEX)).toBeNull();
  });

  test("rejects the wrong payload length", () => {
    expect(decodeNpub(NPUB_31_BYTES)).toBeNull();
    expect(decodeNpub(NPUB_33_BYTES)).toBeNull();
  });

  test("rejects non-canonical trailing padding", () => {
    expect(NPUB_DIRTY_PADDING.length).toBe(GEN_NPUB.length);
    expect(decodeNpub(NPUB_DIRTY_PADDING)).toBeNull();
  });

  test("rejects characters outside the bech32 charset", () => {
    // `b`, `i`, `o`, `1` are excluded from the data charset on purpose.
    expect(decodeNpub(`npub1b${SPEC_NPUB.slice(6)}`)).toBeNull();
    expect(decodeNpub(`npub1o${SPEC_NPUB.slice(6)}`)).toBeNull();
  });

  test("rejects uppercase and mixed case rather than normalizing", () => {
    expect(decodeNpub(SPEC_NPUB.toUpperCase())).toBeNull();
    expect(decodeNpub(`NPUB1${SPEC_NPUB.slice(5)}`)).toBeNull();
  });

  test("rejects the empty string and obvious junk without throwing", () => {
    expect(decodeNpub("")).toBeNull();
    expect(decodeNpub("npub1")).toBeNull();
    expect(decodeNpub("npub1qqqqqqq")).toBeNull();
  });
});

describe("parseGrantPubkey", () => {
  const HEX = "aa".repeat(32);

  function rejection(raw: unknown): GrantError {
    try {
      parseGrantPubkey(raw);
    } catch (err) {
      return err as GrantError;
    }
    throw new Error("expected parseGrantPubkey to throw");
  }

  test("accepts an npub and returns lowercase hex", () => {
    expect(parseGrantPubkey(SPEC_NPUB)).toBe(SPEC_HEX);
    expect(parseGrantPubkey(GEN_NPUB)).toBe(GEN_HEX);
  });

  test("passes lowercase hex through untouched", () => {
    expect(parseGrantPubkey(HEX)).toBe(HEX);
    expect(parseGrantPubkey(SPEC_HEX)).toBe(SPEC_HEX);
  });

  test("still refuses uppercase hex — normalizing would split one key in two", () => {
    expect(rejection(HEX.toUpperCase()).errorType).toBe("invalid_pubkey");
  });

  test("refuses a malformed npub with the invalid_pubkey shape", () => {
    for (const bad of [
      "npub1qqqqqqq",
      `${SPEC_NPUB.slice(0, -1)}q`,
      NPUB_31_BYTES,
      NPUB_33_BYTES,
      NPUB_DIRTY_PADDING,
    ]) {
      const err = rejection(bad);
      expect(err).toBeInstanceOf(GrantError);
      expect(err.errorType).toBe("invalid_pubkey");
      expect(err.message).toContain("npub");
    }
  });

  test("refuses an nsec — a secret key must never be pasted here", () => {
    expect(rejection(SPEC_NSEC).errorType).toBe("invalid_pubkey");
  });

  test("refuses missing, empty, and non-string input", () => {
    expect(rejection(undefined).message).toContain("required");
    expect(rejection("").message).toContain("required");
    expect(rejection(42).errorType).toBe("invalid_pubkey");
    expect(rejection({ pubkey: HEX }).errorType).toBe("invalid_pubkey");
  });

  test("refuses hex of the wrong length", () => {
    expect(rejection("aa".repeat(31)).errorType).toBe("invalid_pubkey");
    expect(rejection("aa".repeat(33)).errorType).toBe("invalid_pubkey");
  });
});
