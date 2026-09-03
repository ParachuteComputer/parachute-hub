/**
 * Channel roster fetcher (channel-attached vaults PR 4).
 *
 * The design note's gate for this row is "fixture 39002 with a wrong
 * signature rejected; role map parsed", plus the trust-on-first-use
 * properties the pin exists for. Every event here is signed with a REAL
 * keypair generated inside the test — a hand-written `sig` field would make
 * the signature assertions vacuous, since the thing under test is precisely
 * whether a bad signature is noticed.
 *
 * The relay is a real loopback `Bun.serve`, so the NIP-98 header, the filter
 * body, and the JSON round-trip are all exercised rather than stubbed. The
 * fake asserts the inbound NIP-98 event the way Buzz does (kind, `u`,
 * `method`, `payload`), which is the only check we have that the hub's
 * outbound signer matches `buzz-relay`'s verifier.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { BUZZ_NSEC_FILE_ENV } from "../buzz-reader-key.ts";
import {
  DEFAULT_ROSTER_TIMEOUT_MS,
  fetchChannelRoster,
  parseRosterTags,
} from "../channel-roster.ts";
import { getChannelVault, upsertChannelVault } from "../channel-vaults.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  NOSTR_AUTH_KIND,
  type NostrEvent,
  parseNostrEvent,
  verifyNostrEvent,
} from "../nostr-event.ts";
import { pubkeyForSecret, signNostrEvent } from "../nostr-http-sign.ts";

const RELAY_HOST = "buzz.techne.coop";
const CHANNEL = "3ff68a58-3f97-409a-b531-45d388b3c827";
const VAULT = "parachute";

function randomSecret(): string {
  return Buffer.from(schnorr.utils.randomSecretKey()).toString("hex");
}

/** A relay-shaped kind 39002 for `channel`, signed by `secret`. */
function rosterEvent(
  secret: string,
  channel: string,
  members: readonly [string, string][],
  createdAt = 1_800_000_000,
): NostrEvent {
  const tags: string[][] = [["d", channel]];
  for (const [pubkey, role] of members) tags.push(["p", pubkey, "", role]);
  return signNostrEvent({ created_at: createdAt, kind: 39002, tags, content: "" }, secret);
}

interface FakeRelay {
  origin: string;
  stop: () => void;
  /** Every `Authorization` value the fake saw on `/query`. */
  seenAuth: string[];
  /** Every filter body the fake saw on `/query`. */
  seenFilters: unknown[];
}

/**
 * Loopback stand-in for the Buzz REST bridge: NIP-11 on `GET /`, the event
 * array on `POST /query`. `nip11Self` is what it advertises; `events` is what
 * it serves. `authCheck` mirrors the relay's NIP-98 verification so a signer
 * regression fails here rather than in production.
 */
function startFakeRelay(cfg: {
  nip11Self?: string | null;
  events: readonly unknown[];
  nip11Status?: number;
  queryStatus?: number;
}): FakeRelay {
  const seenAuth: string[] = [];
  const seenFilters: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") {
        if (cfg.nip11Status && cfg.nip11Status !== 200) {
          return new Response("nope", { status: cfg.nip11Status });
        }
        const doc: Record<string, unknown> = { name: "fake", supported_nips: [98] };
        if (cfg.nip11Self !== null && cfg.nip11Self !== undefined) doc.self = cfg.nip11Self;
        return Response.json(doc, { headers: { "content-type": "application/nostr+json" } });
      }
      if (req.method === "POST" && url.pathname === "/query") {
        const auth = req.headers.get("authorization") ?? "";
        seenAuth.push(auth);
        const body = new Uint8Array(await req.arrayBuffer());
        try {
          seenFilters.push(JSON.parse(new TextDecoder().decode(body)));
        } catch {
          seenFilters.push(null);
        }
        // Buzz decodes the token with STANDARD base64 and checks u/method/payload.
        const token = auth.replace(/^Nostr\s+/i, "");
        const parsed = parseNostrEvent(JSON.parse(Buffer.from(token, "base64").toString("utf8")));
        if (!parsed.ok) return new Response("bad auth", { status: 401 });
        const ev = parsed.event;
        const tag = (n: string) => ev.tags.find((t) => t[0] === n)?.[1];
        const payload = createHash("sha256").update(body).digest("hex");
        if (
          ev.kind !== NOSTR_AUTH_KIND ||
          !verifyNostrEvent(ev).ok ||
          tag("u") !== url.href ||
          tag("method") !== "POST" ||
          tag("payload") !== payload
        ) {
          return new Response("bad auth", { status: 401 });
        }
        if (cfg.queryStatus && cfg.queryStatus !== 200) {
          return new Response("nope", { status: cfg.queryStatus });
        }
        return Response.json(cfg.events);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    seenAuth,
    seenFilters,
  };
}

let dir: string;
let db: Database;
let readerSecret: string;
let env: NodeJS.ProcessEnv;
const relays: FakeRelay[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phub-channel-roster-"));
  db = openHubDb(hubDbPath(dir));
  readerSecret = randomSecret();
  const keyPath = join(dir, "reader.nsec");
  writeFileSync(keyPath, `# hub buzz reader\n${readerSecret}\n`, { mode: 0o600 });
  env = { [BUZZ_NSEC_FILE_ENV]: keyPath };
  upsertChannelVault(db, { relayHost: RELAY_HOST, channelId: CHANNEL, vault: VAULT });
});
afterEach(() => {
  for (const r of relays.splice(0)) r.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fake(cfg: Parameters<typeof startFakeRelay>[0]): FakeRelay {
  const r = startFakeRelay(cfg);
  relays.push(r);
  return r;
}

function optsFor(relay: FakeRelay) {
  return { env, originFor: () => relay.origin, timeoutMs: 5_000 };
}

describe("parseRosterTags", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const c = "c".repeat(64);

  test("maps every Buzz role and ignores the d tag", () => {
    const { roster, skipped } = parseRosterTags([
      ["d", CHANNEL],
      ["p", a, "", "owner"],
      ["p", b, "", "guest"],
      ["p", c, "", "bot"],
    ]);
    expect(roster).toEqual([
      { pubkey: a, role: "owner" },
      { pubkey: b, role: "guest" },
      { pubkey: c, role: "bot" },
    ]);
    expect(skipped).toBe(0);
  });

  test("skips and counts an unknown role rather than failing the roster", () => {
    const { roster, skipped } = parseRosterTags([
      ["p", a, "", "member"],
      ["p", b, "", "archivist"],
    ]);
    expect(roster).toEqual([{ pubkey: a, role: "member" }]);
    expect(skipped).toBe(1);
  });

  test("skips a malformed or missing pubkey, and a missing role", () => {
    const { roster, skipped } = parseRosterTags([
      ["p", "not-hex", "", "member"],
      ["p", a.toUpperCase(), "", "member"],
      ["p", b],
      ["p", c, "", "admin"],
    ]);
    expect(roster).toEqual([{ pubkey: c, role: "admin" }]);
    expect(skipped).toBe(3);
  });

  test("first entry wins for a duplicated pubkey", () => {
    const { roster } = parseRosterTags([
      ["p", a, "", "guest"],
      ["p", a, "", "owner"],
    ]);
    expect(roster).toEqual([{ pubkey: a, role: "guest" }]);
  });
});

describe("fetchChannelRoster", () => {
  test("first fetch verifies, parses roles, and pins relay_self_pubkey", async () => {
    const relaySecret = randomSecret();
    const relayPubkey = pubkeyForSecret(relaySecret);
    const alice = "1".repeat(64);
    const bob = "2".repeat(64);
    const relay = fake({
      nip11Self: relayPubkey,
      events: [
        rosterEvent(relaySecret, CHANNEL, [
          [alice, "owner"],
          [bob, "guest"],
        ]),
      ],
    });

    expect(getChannelVault(db, RELAY_HOST, CHANNEL)?.relaySelfPubkey).toBeNull();

    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({
      ok: true,
      roster: [
        { pubkey: alice, role: "owner" },
        { pubkey: bob, role: "guest" },
      ],
      eventCreatedAt: 1_800_000_000,
      relaySelfPubkey: relayPubkey,
      pinned: true,
      skipped: 0,
    });
    expect(getChannelVault(db, RELAY_HOST, CHANNEL)?.relaySelfPubkey).toBe(relayPubkey);

    // The relay saw a NIP-98 event it accepted, and the filter we promised.
    expect(relay.seenAuth[0]).toStartWith("Nostr ");
    expect(relay.seenFilters[0]).toEqual([{ kinds: [39002], "#d": [CHANNEL] }]);
  });

  test("a second fetch against the same key reports pinned:false", async () => {
    const relaySecret = randomSecret();
    const relayPubkey = pubkeyForSecret(relaySecret);
    const relay = fake({
      nip11Self: relayPubkey,
      events: [rosterEvent(relaySecret, CHANNEL, [["3".repeat(64), "member"]])],
    });

    expect((await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay))).ok).toBe(true);
    const again = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(again).toMatchObject({ ok: true, pinned: false });
  });

  test("rejects a 39002 signed by a key that is not the relay's self", async () => {
    const relaySecret = randomSecret();
    const impostorSecret = randomSecret();
    const relay = fake({
      nip11Self: pubkeyForSecret(relaySecret),
      // Genuine signature — by the wrong signer. The event verifies as a
      // nostr event and must STILL be refused.
      events: [rosterEvent(impostorSecret, CHANNEL, [["4".repeat(64), "owner"]])],
    });

    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(getChannelVault(db, RELAY_HOST, CHANNEL)?.relaySelfPubkey).toBeNull();
  });

  test("rejects a 39002 whose signature does not match its own id", async () => {
    const relaySecret = randomSecret();
    const relayPubkey = pubkeyForSecret(relaySecret);
    const good = rosterEvent(relaySecret, CHANNEL, [["5".repeat(64), "owner"]]);
    // Flip one hex digit of the signature: right signer, right id, dead sig.
    const bad = { ...good, sig: `${good.sig.slice(0, 127)}${good.sig.endsWith("0") ? "1" : "0"}` };
    const relay = fake({ nip11Self: relayPubkey, events: [bad] });

    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(getChannelVault(db, RELAY_HOST, CHANNEL)?.relaySelfPubkey).toBeNull();
  });

  test("rejects a 39002 whose tags were edited after signing (id mismatch)", async () => {
    const relaySecret = randomSecret();
    const good = rosterEvent(relaySecret, CHANNEL, [["6".repeat(64), "guest"]]);
    const tampered = {
      ...good,
      tags: [
        ["d", CHANNEL],
        ["p", "6".repeat(64), "", "owner"],
      ],
    };
    const relay = fake({ nip11Self: pubkeyForSecret(relaySecret), events: [tampered] });

    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  test("a NIP-11 self that differs from the pin is relay_key_changed, never re-pinned", async () => {
    const pinned = pubkeyForSecret(randomSecret());
    upsertChannelVault(db, {
      relayHost: RELAY_HOST,
      channelId: CHANNEL,
      vault: VAULT,
      relaySelfPubkey: pinned,
    });
    const newSecret = randomSecret();
    const relay = fake({
      nip11Self: pubkeyForSecret(newSecret),
      // A perfectly valid roster under the NEW key: content is not the point.
      events: [rosterEvent(newSecret, CHANNEL, [["7".repeat(64), "owner"]])],
    });

    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({ ok: false, reason: "relay_key_changed" });
    expect(getChannelVault(db, RELAY_HOST, CHANNEL)?.relaySelfPubkey).toBe(pinned);
    // Refused before we sign anything at the new key's relay.
    expect(relay.seenAuth).toHaveLength(0);
  });

  test("relay unreachable yields relay_unreachable and leaves the row untouched", async () => {
    const before = getChannelVault(db, RELAY_HOST, CHANNEL);
    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, {
      env,
      originFor: () => "http://127.0.0.1:1",
      fetchImpl: () => Promise.reject(new Error("connection refused")),
    });
    expect(res).toMatchObject({ ok: false, reason: "relay_unreachable" });
    expect(getChannelVault(db, RELAY_HOST, CHANNEL)).toEqual(before);
  });

  test("a non-2xx from the relay is relay_rejected, with the status and no body", async () => {
    const relaySecret = randomSecret();
    const relay = fake({
      nip11Self: pubkeyForSecret(relaySecret),
      events: [],
      queryStatus: 403,
    });
    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({ ok: false, reason: "relay_rejected", detail: "query status 403" });
    expect(getChannelVault(db, RELAY_HOST, CHANNEL)?.relaySelfPubkey).toBeNull();
  });

  test("an empty result set is no_roster, not an empty roster", async () => {
    const relay = fake({ nip11Self: pubkeyForSecret(randomSecret()), events: [] });
    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({ ok: false, reason: "no_roster" });
  });

  test("a 39002 for a different channel does not satisfy this channel", async () => {
    const relaySecret = randomSecret();
    const other = "00000000-0000-4000-8000-000000000000";
    const relay = fake({
      nip11Self: pubkeyForSecret(relaySecret),
      events: [rosterEvent(relaySecret, other, [["8".repeat(64), "owner"]])],
    });
    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({ ok: false, reason: "no_roster" });
  });

  test("the newest 39002 wins when the relay returns more than one", async () => {
    const relaySecret = randomSecret();
    const old = "a".repeat(64);
    const current = "b".repeat(64);
    const relay = fake({
      nip11Self: pubkeyForSecret(relaySecret),
      events: [
        rosterEvent(relaySecret, CHANNEL, [[old, "owner"]], 1_800_000_000),
        rosterEvent(relaySecret, CHANNEL, [[current, "owner"]], 1_800_000_500),
      ],
    });
    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({
      ok: true,
      roster: [{ pubkey: current, role: "owner" }],
      eventCreatedAt: 1_800_000_500,
    });
  });

  test("a roster larger than parseNostrEvent's default tag bound still parses", async () => {
    const relaySecret = randomSecret();
    const members: [string, string][] = Array.from({ length: 50 }, (_, i) => [
      i.toString(16).padStart(64, "0"),
      "member",
    ]);
    const relay = fake({
      nip11Self: pubkeyForSecret(relaySecret),
      events: [rosterEvent(relaySecret, CHANNEL, members)],
    });
    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res.ok).toBe(true);
    expect(res.ok && res.roster).toHaveLength(50);
  });

  test("NIP-11 without a self pubkey is relay_self_unknown", async () => {
    const relay = fake({ nip11Self: null, events: [] });
    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, optsFor(relay));
    expect(res).toMatchObject({ ok: false, reason: "relay_self_unknown" });
  });

  test("an unbound channel is not_bound and never touches the network", async () => {
    const relay = fake({ nip11Self: pubkeyForSecret(randomSecret()), events: [] });
    const res = await fetchChannelRoster(db, RELAY_HOST, "unbound-channel", optsFor(relay));
    expect(res).toMatchObject({ ok: false, reason: "not_bound" });
    expect(relay.seenAuth).toHaveLength(0);
  });

  test("no reader key is not_configured, not a throw", async () => {
    const relay = fake({ nip11Self: pubkeyForSecret(randomSecret()), events: [] });
    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, {
      ...optsFor(relay),
      env: { [BUZZ_NSEC_FILE_ENV]: join(dir, "absent.nsec") },
    });
    expect(res).toMatchObject({ ok: false, reason: "not_configured" });
  });

  test("a malformed reader key is key_unreadable and leaks nothing", async () => {
    const bad = join(dir, "bad.nsec");
    writeFileSync(bad, "nsec1thisisnotavalidkeyatall\n");
    const relay = fake({ nip11Self: pubkeyForSecret(randomSecret()), events: [] });
    const res = await fetchChannelRoster(db, RELAY_HOST, CHANNEL, {
      ...optsFor(relay),
      env: { [BUZZ_NSEC_FILE_ENV]: bad },
    });
    expect(res).toMatchObject({ ok: false, reason: "key_unreadable" });
    expect(JSON.stringify(res)).not.toContain("thisisnotavalid");
  });

  test("the default timeout is a bounded number, not infinity", () => {
    expect(DEFAULT_ROSTER_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_ROSTER_TIMEOUT_MS)).toBe(true);
  });
});
