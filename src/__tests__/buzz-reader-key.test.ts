/**
 * The hub's Buzz reader key: where it is loaded from, what it refuses, and
 * that nothing it refuses ends up quoted back at the caller.
 *
 * Paired with the outbound NIP-98 signer, because the signer is the only
 * consumer of the loaded key and the two are only correct together: a key
 * that loads but produces a header Buzz rejects is not a working config
 * surface.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  BUZZ_NSEC_FILE_ENV,
  BUZZ_READER_KEY_FILENAME,
  buzzReaderKeyPath,
  loadBuzzReaderKey,
} from "../buzz-reader-key.ts";
import { decodeNpub, decodeNsec } from "../nip19.ts";
import { NOSTR_AUTH_KIND, parseNostrEvent, tagValue, verifyNostrEvent } from "../nostr-event.ts";
import { nip98AuthHeader, pubkeyForSecret, signNostrEvent } from "../nostr-http-sign.ts";

// NIP-19 spec vector (the `nsec` half of the published pair).
const SPEC_NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const SPEC_HEX = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "phub-reader-key-"));
}

describe("decodeNsec", () => {
  test("decodes the NIP-19 spec vector", () => {
    expect(decodeNsec(SPEC_NSEC)).toBe(SPEC_HEX);
  });

  test("refuses the wrong human-readable part in both directions", () => {
    expect(
      decodeNsec("npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6"),
    ).toBeNull();
    expect(decodeNpub(SPEC_NSEC)).toBeNull();
  });

  test("refuses a bad checksum, uppercase, and a truncated paste", () => {
    expect(decodeNsec(`${SPEC_NSEC.slice(0, 62)}q`)).toBeNull();
    expect(decodeNsec(SPEC_NSEC.toUpperCase())).toBeNull();
    expect(decodeNsec(SPEC_NSEC.slice(0, 40))).toBeNull();
  });
});

describe("buzzReaderKeyPath", () => {
  test("defaults to <configDir>/buzz-reader.nsec", () => {
    expect(buzzReaderKeyPath({}, "/tmp/ph")).toBe(join("/tmp/ph", BUZZ_READER_KEY_FILENAME));
  });

  test("PARACHUTE_BUZZ_NSEC_FILE wins and is trimmed", () => {
    expect(buzzReaderKeyPath({ [BUZZ_NSEC_FILE_ENV]: "  /keys/buzz.nsec " }, "/tmp/ph")).toBe(
      "/keys/buzz.nsec",
    );
  });

  test("an empty override falls back rather than resolving to nothing", () => {
    expect(buzzReaderKeyPath({ [BUZZ_NSEC_FILE_ENV]: "   " }, "/tmp/ph")).toBe(
      join("/tmp/ph", BUZZ_READER_KEY_FILENAME),
    );
  });
});

describe("loadBuzzReaderKey", () => {
  test("a missing file is not_configured — the ordinary state, not an error", () => {
    const dir = tmp();
    try {
      const res = loadBuzzReaderKey({}, dir);
      expect(res).toMatchObject({ ok: false, reason: "not_configured" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads an nsec, skipping comments and blank lines", () => {
    const dir = tmp();
    try {
      writeFileSync(
        join(dir, BUZZ_READER_KEY_FILENAME),
        `# hub reader key, seated in techne\n\n${SPEC_NSEC}\n# rotated 2026-09-03\n`,
      );
      const res = loadBuzzReaderKey({}, dir);
      expect(res.ok).toBe(true);
      expect(res.ok && res.key.secretKeyHex).toBe(SPEC_HEX);
      expect(res.ok && res.key.pubkey).toBe(pubkeyForSecret(SPEC_HEX));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads a bare hex key too", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, BUZZ_READER_KEY_FILENAME), `${SPEC_HEX}\n`);
      const res = loadBuzzReaderKey({}, dir);
      expect(res.ok && res.key.secretKeyHex).toBe(SPEC_HEX);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty or comment-only file is `empty`, distinct from not_configured", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, BUZZ_READER_KEY_FILENAME), "# nothing here yet\n\n");
      expect(loadBuzzReaderKey({}, dir)).toMatchObject({ ok: false, reason: "empty" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a directory at the path is unreadable, not not_configured", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, BUZZ_READER_KEY_FILENAME));
      expect(loadBuzzReaderKey({}, dir)).toMatchObject({ ok: false, reason: "unreadable" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a malformed key is refused and NEVER echoed back", () => {
    const dir = tmp();
    try {
      const secretish = "nsec1totallybogusbutsecretlookingvalue";
      writeFileSync(join(dir, BUZZ_READER_KEY_FILENAME), `${secretish}\n`);
      const res = loadBuzzReaderKey({}, dir);
      expect(res).toMatchObject({ ok: false, reason: "malformed" });
      expect(JSON.stringify(res)).not.toContain("bogus");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uppercase hex is refused rather than normalized", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, BUZZ_READER_KEY_FILENAME), `${SPEC_HEX.toUpperCase()}\n`);
      expect(loadBuzzReaderKey({}, dir)).toMatchObject({ ok: false, reason: "malformed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("outbound NIP-98 signing", () => {
  test("signNostrEvent round-trips through the hub's own verifier", () => {
    const secret = Buffer.from(schnorr.utils.randomSecretKey()).toString("hex");
    const event = signNostrEvent(
      { created_at: 1_800_000_000, kind: 1, tags: [["t", "x"]], content: "hi" },
      secret,
    );
    expect(event.pubkey).toBe(pubkeyForSecret(secret));
    expect(verifyNostrEvent(event)).toEqual({ ok: true });
  });

  test("a malformed secret throws WITHOUT quoting the secret", () => {
    let message = "";
    try {
      signNostrEvent({ created_at: 1, kind: 1, tags: [], content: "" }, "nsec1leakme");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("64 lowercase hex");
    expect(message).not.toContain("leakme");
  });

  test("the header is `Nostr <STANDARD base64>` — Buzz does not decode base64url", () => {
    const secret = Buffer.from(schnorr.utils.randomSecretKey()).toString("hex");
    const body = new TextEncoder().encode('[{"kinds":[39002]}]');
    const header = nip98AuthHeader({
      secretKeyHex: secret,
      url: "https://buzz.techne.coop/query",
      method: "post",
      body,
      createdAt: 1_800_000_000,
      nonce: "fixed",
    });
    expect(header).toStartWith("Nostr ");
    const token = header.slice("Nostr ".length);
    // Standard base64 never emits `-` or `_`; base64url never emits `+` or `/`.
    expect(token).not.toMatch(/[-_]/);
    const parsed = parseNostrEvent(JSON.parse(Buffer.from(token, "base64").toString("utf8")));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event.kind).toBe(NOSTR_AUTH_KIND);
    expect(verifyNostrEvent(parsed.event)).toEqual({ ok: true });
    expect(tagValue(parsed.event, "u")).toBe("https://buzz.techne.coop/query");
    // Method is upper-cased on the wire even when the caller was sloppy.
    expect(tagValue(parsed.event, "method")).toBe("POST");
    expect(tagValue(parsed.event, "payload")).toBe(createHash("sha256").update(body).digest("hex"));
  });

  test("no payload tag when there is no body, and a fresh nonce each call", () => {
    const secret = Buffer.from(schnorr.utils.randomSecretKey()).toString("hex");
    const decode = (h: string) =>
      JSON.parse(Buffer.from(h.slice("Nostr ".length), "base64").toString("utf8"));
    const one = decode(
      nip98AuthHeader({ secretKeyHex: secret, url: "https://r/x", method: "GET" }),
    );
    const two = decode(
      nip98AuthHeader({ secretKeyHex: secret, url: "https://r/x", method: "GET" }),
    );
    expect(one.tags.some((t: string[]) => t[0] === "payload")).toBe(false);
    // Distinct ids even at the same second — Buzz rejects a replayed id.
    expect(one.id).not.toBe(two.id);
  });
});
