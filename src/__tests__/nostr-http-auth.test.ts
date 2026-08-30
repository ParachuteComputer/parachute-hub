/**
 * NIP-98 request auth (hub#833 (c)).
 *
 * Watch-fail: these tests signed against an unpatched verify (no replay
 * cache, no u/method bind) before the implementation landed.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { requireScope } from "../admin-auth.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { NOSTR_AUTH_KIND, type NostrEvent, nostrEventId } from "../nostr-event.ts";
import {
  NIP98_MAX_SKEW_SECONDS,
  NostrReplayCache,
  authenticateNostrRequest,
  extractNostrEvent,
  requestAbsoluteUrl,
  verifyNostrHttpEvent,
} from "../nostr-http-auth.ts";
import { bindPubkeyFromHttpAuth, findPubkeyLink } from "../pubkey-links.ts";
import { issuePubkeyChallenge, linkPubkey } from "../pubkey-links.ts";
import { bindRequestPeer } from "../request-layer.ts";
import { createUser } from "../users.ts";

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
  extraHeaders?: Record<string, string>,
): Request {
  return new Request(url, {
    method,
    headers: {
      authorization: nostrHeader(event),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
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

describe("requestAbsoluteUrl", () => {
  test("loopback http is unchanged — no stored origin, no header rewrite", () => {
    const req = new Request("http://127.0.0.1:1939/mcp", { method: "POST" });
    expect(requestAbsoluteUrl(req)).toBe("http://127.0.0.1:1939/mcp");
  });

  test("X-Forwarded-Proto https upgrades the scheme on an http request URL", () => {
    // Tonight's hole: Tailscale Serve terminates TLS and forwards HTTP.
    // Hub sees http://uni.taildf9ce2.ts.net/mcp; the client signed https.
    const req = new Request("http://uni.taildf9ce2.ts.net/mcp", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(requestAbsoluteUrl(req)).toBe("https://uni.taildf9ce2.ts.net/mcp");
  });

  test("keeps host/path/query from req.url — not X-Forwarded-Host", () => {
    const req = new Request("http://uni.taildf9ce2.ts.net/mcp?x=1", {
      method: "POST",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
      },
    });
    expect(requestAbsoluteUrl(req)).toBe("https://uni.taildf9ce2.ts.net/mcp?x=1");
  });

  test("direct https req.url is a no-op even without X-Forwarded-Proto", () => {
    const req = new Request("https://uni.taildf9ce2.ts.net/mcp", { method: "POST" });
    expect(requestAbsoluteUrl(req)).toBe("https://uni.taildf9ce2.ts.net/mcp");
  });

  test("loopback peer + forged XFP does not upgrade (hub#915)", () => {
    const req = new Request("http://uni.taildf9ce2.ts.net/mcp", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(requestAbsoluteUrl(req, "127.0.0.1")).toBe("http://uni.taildf9ce2.ts.net/mcp");
    expect(requestAbsoluteUrl(req, "::1")).toBe("http://uni.taildf9ce2.ts.net/mcp");
    expect(requestAbsoluteUrl(req, "::ffff:127.0.0.1")).toBe("http://uni.taildf9ce2.ts.net/mcp");
  });

  test("loopback peer + XFP + X-Forwarded-For still upgrades (Tailscale Serve)", () => {
    const req = new Request("http://uni.taildf9ce2.ts.net/mcp", {
      method: "POST",
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-for": "100.64.0.12",
      },
    });
    expect(requestAbsoluteUrl(req, "127.0.0.1")).toBe("https://uni.taildf9ce2.ts.net/mcp");
  });

  test("loopback peer + XFP + Tailscale-User-Login still upgrades", () => {
    const req = new Request("http://uni.taildf9ce2.ts.net/mcp", {
      method: "POST",
      headers: {
        "x-forwarded-proto": "https",
        "tailscale-user-login": "aaron@example.com",
      },
    });
    expect(requestAbsoluteUrl(req, "127.0.0.1")).toBe("https://uni.taildf9ce2.ts.net/mcp");
  });

  test("unknown peer still upgrades — hub#914 tests, fail-closed to public", () => {
    const req = new Request("http://uni.taildf9ce2.ts.net/mcp", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(requestAbsoluteUrl(req)).toBe("https://uni.taildf9ce2.ts.net/mcp");
    expect(requestAbsoluteUrl(req, null)).toBe("https://uni.taildf9ce2.ts.net/mcp");
  });

  test("hubFetch bindRequestPeer is enough — no explicit peerAddr needed", () => {
    const req = new Request("http://uni.taildf9ce2.ts.net/mcp", {
      method: "POST",
      headers: { "x-forwarded-proto": "https" },
    });
    bindRequestPeer(req, "127.0.0.1");
    expect(requestAbsoluteUrl(req)).toBe("http://uni.taildf9ce2.ts.net/mcp");
  });
});

describe("verifyNostrHttpEvent", () => {
  test("accepts a fresh GET with matching u and method", () => {
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
    });
    const replay = new NostrReplayCache();
    verifyNostrHttpEvent(reqFor(url, "GET", event), event, { replay });
  });

  test("rejects a replayed event id", () => {
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
    });
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
      verifyNostrHttpEvent(reqFor("http://127.0.0.1:1939/api/me", "GET", event), event, {
        replay: new NostrReplayCache(),
      }),
    ).toThrow(/u tag/);
  });

  test("accepts https u-tag when X-Forwarded-Proto says the client used TLS — tonight's hole", () => {
    const publicUrl = "https://uni.taildf9ce2.ts.net/mcp";
    const behindTls = "http://uni.taildf9ce2.ts.net/mcp";
    const event = signEvent({
      tags: [
        ["u", publicUrl],
        ["method", "POST"],
      ],
    });
    verifyNostrHttpEvent(
      reqFor(behindTls, "POST", event, undefined, { "x-forwarded-proto": "https" }),
      event,
      { replay: new NostrReplayCache() },
    );
  });

  test("rejects the internal http u-tag on a TLS-terminated request", () => {
    const behindTls = "http://uni.taildf9ce2.ts.net/mcp";
    const event = signEvent({
      tags: [
        ["u", behindTls],
        ["method", "POST"],
      ],
    });
    expect(() =>
      verifyNostrHttpEvent(
        reqFor(behindTls, "POST", event, undefined, { "x-forwarded-proto": "https" }),
        event,
        { replay: new NostrReplayCache() },
      ),
    ).toThrow(/u tag/);
  });

  test("rejects a captured https u-tag replayed on loopback with forged XFP (hub#915)", () => {
    const publicUrl = "https://uni.taildf9ce2.ts.net/mcp";
    const behindTls = "http://uni.taildf9ce2.ts.net/mcp";
    const event = signEvent({
      tags: [
        ["u", publicUrl],
        ["method", "POST"],
      ],
    });
    expect(() =>
      verifyNostrHttpEvent(
        reqFor(behindTls, "POST", event, undefined, { "x-forwarded-proto": "https" }),
        event,
        { replay: new NostrReplayCache(), peerAddr: "127.0.0.1" },
      ),
    ).toThrow(/u tag/);
  });

  test("rejects method mismatch", () => {
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "POST"],
      ],
    });
    expect(() =>
      verifyNostrHttpEvent(reqFor(url, "GET", event), event, { replay: new NostrReplayCache() }),
    ).toThrow(/method tag/);
  });

  test("rejects created_at outside the 60s window", () => {
    const url = "http://127.0.0.1:1939/api/me";
    const event = signEvent({
      created_at: Math.floor(Date.now() / 1000) - (NIP98_MAX_SKEW_SECONDS + 5),
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
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
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
    });
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
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
    });
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
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
    });
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
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
    });
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
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
    });
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
    const event = signEvent({
      tags: [
        ["u", url],
        ["method", "GET"],
      ],
    });
    process.env.PARACHUTE_NOSTR_AUTO_PROVISION = "1";
    try {
      await expect(
        requireScope(
          db,
          reqFor(url, "GET", event),
          "parachute:host:admin",
          "http://127.0.0.1:1939",
        ),
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
