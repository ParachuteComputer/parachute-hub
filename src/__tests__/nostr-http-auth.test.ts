/**
 * NIP-98 request auth (hub#833 (c)).
 *
 * Watch-fail: these tests signed against an unpatched verify (no replay
 * cache, no u/method bind) before the implementation landed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import type { Database } from "bun:sqlite";
import { NOSTR_AUTH_KIND, type NostrEvent, nostrEventId } from "../nostr-event.ts";
import {
  NIP98_MAX_SKEW_SECONDS,
  NostrReplayCache,
  authenticateNostrRequest,
  extractNostrEvent,
  verifyNostrHttpEvent,
} from "../nostr-http-auth.ts";
import { requireScope } from "../admin-auth.ts";
import { createUser } from "../users.ts";
import { bindPubkeyFromHttpAuth, findPubkeyLink } from "../pubkey-links.ts";
import { issuePubkeyChallenge, linkPubkey } from "../pubkey-links.ts";

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const SECRET = hexToBytes("aa".repeat(32));
const PUBKEY = bytesToHex(schnorr.getPublicKey(SECRET));

function signEvent(parts: {
  created_at?: number;
  kind?: number;
  tags?: string[][];
  content?: string;
}): NostrEvent {
  const unsigned = {
    pubkey: PUBKEY,
    created_at: parts.created_at ?? Math.floor(Date.now() / 1000),
    kind: parts.kind ?? NOSTR_AUTH_KIND,
    tags: parts.tags ?? [],
    content: parts.content ?? "",
  };
  const id = nostrEventId(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), SECRET));
  return { ...unsigned, id, sig };
}

function nostrHeader(event: NostrEvent): string {
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64url")}`;
}

function reqFor(
  url: string,
  method: string,
  event: NostrEvent,
  body?: string,
): Request {
  return new Request(url, {
    method,
    headers: {
      authorization: nostrHeader(event),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

describe("extractNostrEvent", () => {
  test("parses a base64url event", () => {
    const event = signEvent({
      tags: [
        ["u", "http://127.0.0.1:1939/api/me"],
        ["method", "GET"],
      ],
    });
    const req = reqFor("http://127.0.0.1:1939/api/me", "GET", event);
    expect(extractNostrEvent(req).id).toBe(event.id);
  });

  test("rejects Bearer", () => {
    const req = new Request("http://127.0.0.1:1939/api/me", {
      headers: { authorization: "Bearer abc" },
    });
    expect(() => extractNostrEvent(req)).toThrow(/Nostr/);
  });
});

describe("verifyNostrHttpEvent", () => {
  test("accepts a fresh GET with matching u and method", () => {
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({ tags: [["u", url], ["method", "GET"]] });
    const replay = new NostrReplayCache();
    verifyNostrHttpEvent(reqFor(url, "GET", event), event, { replay });
  });

  test("rejects a replayed event id", () => {
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({ tags: [["u", url], ["method", "GET"]] });
    const replay = new NostrReplayCache();
    verifyNostrHttpEvent(reqFor(url, "GET", event), event, { replay });
    expect(() => verifyNostrHttpEvent(reqFor(url, "GET", event), event, { replay })).toThrow(
      /already been used/,
    );
  });

  test("rejects u mismatch", () => {
    const event = signEvent({
      tags: [
        ["u", "http://evil.example/api/me"],
        ["method", "GET"],
      ],
    });
    expect(() =>
      verifyNostrHttpEvent(
        reqFor("http://127.0.0.1:1939/api/me", "GET", event),
        event,
        { replay: new NostrReplayCache() },
      ),
    ).toThrow(/u tag/);
  });

  test("rejects method mismatch", () => {
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({ tags: [["u", url], ["method", "POST"]] });
    expect(() =>
      verifyNostrHttpEvent(reqFor(url, "GET", event), event, { replay: new NostrReplayCache() }),
    ).toThrow(/method tag/);
  });

  test("rejects created_at outside the 60s window", () => {
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({
      created_at: Math.floor(Date.now() / 1000) - (NIP98_MAX_SKEW_SECONDS + 5),
      tags: [["u", url], ["method", "GET"]],
    });
    expect(() =>
      verifyNostrHttpEvent(reqFor(url, "GET", event), event, { replay: new NostrReplayCache() }),
    ).toThrow(/60s window/);
  });

  test("requires payload sha256 hex when the body is non-empty", () => {
    const url = "http://127.0.0.1:1939/api/account/tokens";
    const body = '{"scope":"vault:work:read"}';
    const hash = createHash("sha256").update(body, "utf8").digest("hex");
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", hash],
      ],
    });
    const replay = new NostrReplayCache();
    verifyNostrHttpEvent(reqFor(url, "POST", event, body), event, {
      replay,
      body: new TextEncoder().encode(body),
    });

    const bad = signEvent({
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", "00".repeat(32)],
      ],
    });
    expect(() =>
      verifyNostrHttpEvent(reqFor(url, "POST", bad, body), bad, {
        replay: new NostrReplayCache(),
        body: new TextEncoder().encode(body),
      }),
    ).toThrow(/payload tag/);
  });
});

describe("authenticateNostrRequest", () => {
  let db: Database;
  let configDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "phub-nip98-"));
    db = openHubDb(hubDbPath(configDir));
  });
  afterEach(() => {
    db.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("unknown pubkey is 401 when auto-provision is off", async () => {
    await createUser(db, "owner", "correct-horse-battery-staple", {
      passwordChanged: true,
    });
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({ tags: [["u", url], ["method", "GET"]] });
    await expect(
      authenticateNostrRequest(db, reqFor(url, "GET", event), {
        autoProvision: false,
        replay: new NostrReplayCache(),
      }),
    ).rejects.toThrow(/not linked/);
  });

  test("linked pubkey authenticates as that user", async () => {
    const owner = await createUser(db, "owner", "correct-horse-battery-staple", {
      passwordChanged: true,
    });
    const friend = await createUser(db, "alice", "correct-horse-battery-staple", {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: ["work"],
    });
    const now = new Date();
    const { challenge } = issuePubkeyChallenge(db, friend.id, now);
    const linked = linkPubkey(db, {
      userId: friend.id,
      pubkey: PUBKEY,
      challenge,
      proofEvent: JSON.stringify({ id: "0".repeat(64), pubkey: PUBKEY, kind: 27235, tags: [] }),
      now,
    });
    expect(linked.ok).toBe(true);

    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({ tags: [["u", url], ["method", "GET"]] });
    const principal = await authenticateNostrRequest(db, reqFor(url, "GET", event), {
      autoProvision: false,
      replay: new NostrReplayCache(),
    });
    expect(principal.userId).toBe(friend.id);
    expect(principal.provisioned).toBe(false);
    expect(principal.isHubAdmin).toBe(false);
    expect(principal.scopes).toContain("vault:work:read");
    expect(principal.scopes).toContain("vault:work:admin");
    expect(owner.id).not.toBe(friend.id);
  });

  test("auto-provision creates a key-only user and binds the pubkey", async () => {
    await createUser(db, "owner", "correct-horse-battery-staple", {
      passwordChanged: true,
    });
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({ tags: [["u", url], ["method", "GET"]] });
    const principal = await authenticateNostrRequest(db, reqFor(url, "GET", event), {
      autoProvision: true,
      replay: new NostrReplayCache(),
    });
    expect(principal.provisioned).toBe(true);
    expect(principal.isHubAdmin).toBe(false);
    expect(principal.pubkey).toBe(PUBKEY);
    expect(principal.scopes).toEqual([]);
    const link = findPubkeyLink(db, PUBKEY);
    expect(link?.userId).toBe(principal.userId);
  });

  test("auto-provision refuses when the hub has no owner yet", async () => {
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({ tags: [["u", url], ["method", "GET"]] });
    await expect(
      authenticateNostrRequest(db, reqFor(url, "GET", event), {
        autoProvision: true,
        replay: new NostrReplayCache(),
      }),
    ).rejects.toThrow(/existing hub owner/);
  });

  test("read-role assignment does not get write or admin scopes", async () => {
    await createUser(db, "owner", "correct-horse-battery-staple", {
      passwordChanged: true,
    });
    const friend = await createUser(db, "reader", "correct-horse-battery-staple", {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: ["shared"],
      role: "read",
    });
    const now = new Date();
    const { challenge } = issuePubkeyChallenge(db, friend.id, now);
    expect(
      linkPubkey(db, {
        userId: friend.id,
        pubkey: PUBKEY,
        challenge,
        proofEvent: JSON.stringify({ id: "0".repeat(64), pubkey: PUBKEY, kind: 27235, tags: [] }),
        now,
      }).ok,
    ).toBe(true);
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({ tags: [["u", url], ["method", "GET"]] });
    const principal = await authenticateNostrRequest(db, reqFor(url, "GET", event), {
      autoProvision: false,
      replay: new NostrReplayCache(),
    });
    expect(principal.scopes).toEqual(["vault:shared:read"]);
  });

  test("requireScope: provisioned key-user cannot take parachute:host:admin", async () => {
    await createUser(db, "owner", "correct-horse-battery-staple", {
      passwordChanged: true,
    });
    const url = "http://127.0.0.1:1939/api/users";
    const event = signEvent({ tags: [["u", url], ["method", "GET"]] });
    process.env.PARACHUTE_NOSTR_AUTO_PROVISION = "1";
    try {
      await expect(
        requireScope(db, reqFor(url, "GET", event), "parachute:host:admin", "http://127.0.0.1:1939"),
      ).rejects.toThrow(/parachute:host:admin/);
    } finally {
      delete process.env.PARACHUTE_NOSTR_AUTO_PROVISION;
    }
  });
});

describe("bindPubkeyFromHttpAuth", () => {
  let db: Database;
  let configDir: string;
  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "phub-nip98-bind-"));
    db = openHubDb(hubDbPath(configDir));
  });
  afterEach(() => {
    db.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("refuses a pubkey already bound to another user", async () => {
    const a = await createUser(db, "owner", "correct-horse-battery-staple", {
      passwordChanged: true,
    });
    const b = await createUser(db, "bob", "correct-horse-battery-staple", {
      allowMulti: true,
      passwordChanged: true,
    });
    const ok = bindPubkeyFromHttpAuth(db, {
      userId: a.id,
      pubkey: PUBKEY,
      proofEvent: "{}",
      proofEventId: "1".repeat(64),
    });
    expect(ok.ok).toBe(true);
    const taken = bindPubkeyFromHttpAuth(db, {
      userId: b.id,
      pubkey: PUBKEY,
      proofEvent: "{}",
      proofEventId: "2".repeat(64),
    });
    expect(taken).toEqual({ ok: false, reason: "pubkey_taken" });
  });
});
