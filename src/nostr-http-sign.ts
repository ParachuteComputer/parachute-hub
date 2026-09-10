/**
 * The OUTBOUND half of NIP-98: signing an HTTP Auth event so the hub can call
 * somebody else's relay. `nostr-http-auth.ts` is the inbound half (verifying
 * events other people signed at us); this is its mirror, kept in a separate
 * file because the two have opposite trust postures and opposite inputs — one
 * takes an attacker-shaped `Request`, the other takes the hub's own secret
 * key.
 *
 * Pure: no DB, no config, no network. Everything comes in as an argument.
 *
 * ## Handling the secret
 *
 * `secretKeyHex` is a private key. It is accepted as hex (not as an `nsec`,
 * not as a path) so that the decoding and file-reading live in exactly one
 * place — `buzz-reader-key.ts` — and this module never has to decide what a
 * malformed secret looks like. Consequences, all deliberate:
 *
 *   - Nothing here logs, and no thrown message interpolates the key. A
 *     structurally invalid key surfaces as a generic error, because a
 *     `@noble/curves` exception can carry its input.
 *   - The key never reaches `process.argv`; the hub signs in-process rather
 *     than shelling out to `nak`.
 *
 * ## Wire details that are easy to get wrong
 *
 * Buzz's relay decodes the `Authorization: Nostr <…>` token with **standard**
 * base64, not base64url (`buzz-relay/src/api/bridge.rs`,
 * `verify_bridge_auth_with_options`). The hub's own inbound verifier accepts
 * base64url. They are the same alphabet for most payloads and differ exactly
 * when a chunk lands on `+` or `/`, which is a coin flip per request — so
 * "it worked on my machine" proves nothing. Standard base64 is what we emit.
 *
 * The `u` tag must be the URL the *relay* expects, which for Buzz is
 * `<scheme>://<tenant host><path>` with no port and no query
 * (`nip98_expected_url`). The caller passes the URL it will actually fetch;
 * they must agree.
 *
 * A `nonce` tag is included on every event. Buzz rejects a replayed event id
 * community-wide via a shared Redis seen-set, and two polls with an identical
 * body inside the same second would otherwise hash to the same id and the
 * second would be refused as a replay.
 */
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { NOSTR_AUTH_KIND, type NostrEvent, nostrEventId } from "./nostr-event.ts";

/**
 * Sign a NIP-01 event with a raw 32-byte secret key (64-char lowercase hex).
 *
 * The id is computed from the canonical serialization and the BIP-340
 * signature is over its 32 RAW bytes — the exact inverse of
 * `verifyNostrEvent`, which is what the round-trip tests lean on.
 *
 * Throws a message-free-ish `Error` when the key is not 64 hex characters.
 * The invalid value is NOT included: an operator who pasted a truncated nsec
 * would otherwise find the rest of it in a log line.
 */
export function signNostrEvent(
  unsigned: {
    pubkey?: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
  },
  secretKeyHex: string,
): NostrEvent {
  if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) {
    throw new Error("nostr secret key must be 64 lowercase hex characters");
  }
  const secret = Uint8Array.from(Buffer.from(secretKeyHex, "hex"));
  const pubkey = Buffer.from(schnorr.getPublicKey(secret)).toString("hex");
  const base = {
    pubkey,
    created_at: unsigned.created_at,
    kind: unsigned.kind,
    tags: unsigned.tags,
    content: unsigned.content,
  };
  const id = nostrEventId(base);
  const sig = Buffer.from(schnorr.sign(Uint8Array.from(Buffer.from(id, "hex")), secret)).toString(
    "hex",
  );
  return { ...base, id, sig };
}

/** x-only public key (64-char lowercase hex) for a secret key. */
export function pubkeyForSecret(secretKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(secretKeyHex)) {
    throw new Error("nostr secret key must be 64 lowercase hex characters");
  }
  return Buffer.from(
    schnorr.getPublicKey(Uint8Array.from(Buffer.from(secretKeyHex, "hex"))),
  ).toString("hex");
}

export interface Nip98SignInput {
  /** 64-char lowercase hex secret key. Never logged. */
  secretKeyHex: string;
  /** Absolute URL, exactly as the request will be made. */
  url: string;
  /** HTTP method, upper-cased on the wire. */
  method: string;
  /** Raw request body bytes. Omit (or pass empty) for a body-less request. */
  body?: Uint8Array;
  /** Unix SECONDS. Injectable so tests are not clock-dependent. */
  createdAt?: number;
  /** Injectable nonce so a test can assert two calls differ. */
  nonce?: string;
}

/**
 * Build the value for an `Authorization` header: `Nostr <base64(event json)>`.
 *
 * Tag order is `u`, `method`, `nonce`, then `payload` when there is a body —
 * matching what `buzz-acp`'s `RestClient::sign_nip98` emits, so a wire capture
 * of a hub poll and of an agent poll look alike. Order is not semantically
 * load-bearing (readers look tags up by name) but it is covered by the id, so
 * it is worth being deliberate about.
 */
export function nip98AuthHeader(input: Nip98SignInput): string {
  const tags: string[][] = [
    ["u", input.url],
    ["method", input.method.toUpperCase()],
    ["nonce", input.nonce ?? crypto.randomUUID()],
  ];
  if (input.body && input.body.byteLength > 0) {
    tags.push(["payload", createHash("sha256").update(input.body).digest("hex")]);
  }
  const event = signNostrEvent(
    {
      created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
      kind: NOSTR_AUTH_KIND,
      tags,
      content: "",
    },
    input.secretKeyHex,
  );
  // STANDARD base64 — see the module header. Buzz's decoder is not base64url.
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}
