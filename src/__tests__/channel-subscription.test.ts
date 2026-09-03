/**
 * Live membership subscription (channel-attached vaults PR 5 follow-up).
 *
 * The relay here is a real loopback `Bun.serve` websocket speaking the
 * fragment of the Nostr relay protocol the hub uses — proactive `AUTH`
 * challenge, `OK`, `REQ`/`CLOSE`, `EVENT` — with real keypairs and real
 * signatures. Stubbing the socket out would test the easy half; the whole
 * risk in this module is wire shape (does the 22242 carry the tags Buzz
 * checks?) and lifecycle (does a drop reconnect and re-REQ?).
 *
 * What is NOT exercised here, and cannot be from a test: a real Buzz relay.
 * The filter shapes are derived from `buzz-relay`'s source — `req.rs`'s
 * `p_gated_filters_authorized` and `extract_channel_id_from_filters`,
 * `buzz-core/src/filter.rs`'s `#h` fallback — not from a live connection.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { ServerWebSocket } from "bun";
import { BUZZ_NSEC_FILE_ENV } from "../buzz-reader-key.ts";
import { startChannelReconciler } from "../channel-reconciler.ts";
import type { FetchChannelRosterResult } from "../channel-roster.ts";
import { KIND_GROUP_MEMBERS } from "../channel-roster.ts";
import {
  type ChannelBindingKey,
  KIND_CLIENT_AUTH,
  KIND_MEMBER_REMOVED,
  startChannelSubscriptions,
} from "../channel-subscription.ts";
import { getChannelVault, pinRelaySelfPubkey, upsertChannelVault } from "../channel-vaults.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { type NostrEvent, verifyNostrEvent } from "../nostr-event.ts";
import { pubkeyForSecret, signNostrEvent } from "../nostr-http-sign.ts";

const RELAY_HOST = "buzz.techne.coop";
const CHANNEL = "3ff68a58-3f97-409a-b531-45d388b3c827";
const OTHER_CHANNEL = "9d1f2b40-1111-4222-8333-444455556666";
const VAULT = "parachute";
const alice = "1".repeat(64);

function randomSecret(): string {
  return Buffer.from(schnorr.utils.randomSecretKey()).toString("hex");
}

interface ReqFrame {
  subId: string;
  filter: Record<string, unknown>;
}

interface FakeWsRelay {
  url: string;
  stop(): void;
  /** Every kind 22242 the hub sent us. */
  auths: NostrEvent[];
  /** Every REQ, in order, across all connections. */
  reqs: ReqFrame[];
  /** Every CLOSE sub id. */
  closes: string[];
  /** How many websocket connections have been opened, ever. */
  connections: number;
  challenge: string;
  /** Push an EVENT to every open socket on the given subscription. */
  broadcast(subId: string, event: unknown): void;
  /** Drop every open socket without shutting the server down. */
  dropAll(): void;
}

/** Loopback stand-in for a Buzz relay websocket. */
function startFakeWsRelay(opts: { authOk?: boolean } = {}): FakeWsRelay {
  const authOk = opts.authOk ?? true;
  const challenge = "challenge-abc123";
  const sockets = new Set<ServerWebSocket<unknown>>();
  const state = { auths: [] as NostrEvent[], reqs: [] as ReqFrame[], closes: [] as string[] };
  let connections = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected a websocket upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        connections++;
        sockets.add(ws);
        // Buzz challenges proactively (NOSTR.md, "NIP-42 authentication").
        ws.send(JSON.stringify(["AUTH", challenge]));
      },
      message(ws, raw) {
        let frame: unknown;
        try {
          frame = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (!Array.isArray(frame)) return;
        if (frame[0] === "AUTH") {
          const event = frame[1] as NostrEvent;
          state.auths.push(event);
          ws.send(JSON.stringify(["OK", event.id, authOk, authOk ? "" : "auth-required: nope"]));
          return;
        }
        if (frame[0] === "REQ") {
          state.reqs.push({ subId: String(frame[1]), filter: frame[2] as Record<string, unknown> });
          ws.send(JSON.stringify(["EOSE", String(frame[1])]));
          return;
        }
        if (frame[0] === "CLOSE") state.closes.push(String(frame[1]));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    get auths() {
      return state.auths;
    },
    get reqs() {
      return state.reqs;
    },
    get closes() {
      return state.closes;
    },
    get connections() {
      return connections;
    },
    challenge,
    broadcast(subId, event) {
      for (const ws of sockets) ws.send(JSON.stringify(["EVENT", subId, event]));
    },
    dropAll() {
      for (const ws of sockets) ws.close();
    },
  };
}

/** A relay-shaped kind 39002 for `channel`, signed by `secret`. */
function rosterEvent(secret: string, channel = CHANNEL, createdAt = 1_800_000_000): NostrEvent {
  return signNostrEvent(
    {
      created_at: createdAt,
      kind: KIND_GROUP_MEMBERS,
      tags: [
        ["d", channel],
        ["p", alice, "", "member"],
      ],
      content: "",
    },
    secret,
  );
}

/** A relay-shaped kind 44101 (member removed) for `channel`. */
function memberRemovedEvent(secret: string, channel = CHANNEL): NostrEvent {
  return signNostrEvent(
    {
      created_at: 1_800_000_001,
      kind: KIND_MEMBER_REMOVED,
      tags: [
        ["p", alice],
        ["h", channel],
      ],
      content: JSON.stringify({ type: "member_removed", channel_id: channel }),
    },
    secret,
  );
}

let dir: string;
let db: Database;
let env: NodeJS.ProcessEnv;
let relaySecret: string;
let relayPubkey: string;
let relay: FakeWsRelay;
/** The reader key's public half — the pubkey Buzz will see us AUTH with. */
let readerPubkey: string;
const logs: string[] = [];
const requests: ChannelBindingKey[][] = [];
let reconcileBusy = false;
const now = () => new Date(Date.parse("2026-09-03T12:00:00.000Z"));

function subDeps(overrides: Record<string, unknown> = {}) {
  return {
    db,
    env,
    log: (line: string) => logs.push(line),
    now,
    wsUrlFor: () => relay.url,
    requestReconcile: (only: readonly ChannelBindingKey[]) => {
      if (reconcileBusy) return false;
      requests.push([...only]);
      return true;
    },
    // Small enough to keep the suite quick, large enough that a burst inside
    // one window is unambiguous.
    debounceMs: 60,
    minBackoffMs: 10,
    maxBackoffMs: 40,
    authGraceMs: 5_000,
    ...overrides,
  };
}

/** Poll for a condition rather than guessing a sleep. */
async function until(predicate: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phub-channel-subscription-"));
  db = openHubDb(hubDbPath(dir));
  logs.length = 0;
  requests.length = 0;
  reconcileBusy = false;
  const keyPath = join(dir, "reader.nsec");
  const readerSecret = randomSecret();
  readerPubkey = pubkeyForSecret(readerSecret);
  writeFileSync(keyPath, `${readerSecret}\n`, { mode: 0o600 });
  env = { [BUZZ_NSEC_FILE_ENV]: keyPath };
  relaySecret = randomSecret();
  relayPubkey = pubkeyForSecret(relaySecret);
  relay = startFakeWsRelay();
  upsertChannelVault(db, { relayHost: RELAY_HOST, channelId: CHANNEL, vault: VAULT }, now);
  pinRelaySelfPubkey(db, RELAY_HOST, CHANNEL, relayPubkey);
});

afterEach(() => {
  relay.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every `user_vaults` row on the bound vault. */
function grantRows(): unknown[] {
  return db
    .query("SELECT user_id, role, granted_via FROM user_vaults WHERE vault_name = ?")
    .all(VAULT);
}

describe("startChannelSubscriptions", () => {
  test("never starts without a configured reader key", () => {
    const subs = startChannelSubscriptions(
      subDeps({ env: {}, configDir: join(dir, "nothing-here") }),
    );
    expect(subs).toBeNull();
    expect(relay.connections).toBe(0);
  });

  test("answers the AUTH challenge with a 22242 carrying relay + challenge", async () => {
    const subs = startChannelSubscriptions(subDeps());
    expect(subs).not.toBeNull();
    await until(() => relay.auths.length > 0);

    const auth = relay.auths[0];
    expect(auth).toBeDefined();
    if (!auth) throw new Error("no auth event");
    expect(auth.kind).toBe(KIND_CLIENT_AUTH);
    expect(verifyNostrEvent(auth).ok).toBe(true);
    expect(auth.pubkey).toBe(readerPubkey);
    // The two tags Buzz's `verify_nip42_event` looks up by name.
    expect(auth.tags.find((t) => t[0] === "challenge")?.[1]).toBe(relay.challenge);
    expect(auth.tags.find((t) => t[0] === "relay")?.[1]).toBe(relay.url);
    subs?.stop();
  });

  test("subscribes per channel with one #h, plus the #p-gated membership filter", async () => {
    upsertChannelVault(db, { relayHost: RELAY_HOST, channelId: OTHER_CHANNEL, vault: VAULT }, now);
    pinRelaySelfPubkey(db, RELAY_HOST, OTHER_CHANNEL, relayPubkey);
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 3);

    const rosterReqs = relay.reqs.filter((r) =>
      (r.filter.kinds as number[] | undefined)?.includes(KIND_GROUP_MEMBERS),
    );
    expect(rosterReqs.length).toBe(2);
    // ONE `#h` value each — two would make the subscription global, and a
    // global sub never receives a channel-scoped 39002.
    for (const req of rosterReqs) expect((req.filter["#h"] as string[]).length).toBe(1);
    expect(new Set(rosterReqs.map((r) => (r.filter["#h"] as string[])[0]))).toEqual(
      new Set([CHANNEL, OTHER_CHANNEL]),
    );

    const memberReq = relay.reqs.find((r) =>
      (r.filter.kinds as number[] | undefined)?.includes(KIND_MEMBER_REMOVED),
    );
    expect(memberReq).toBeDefined();
    // Buzz's p-gate: every `#p` value must equal the authenticated pubkey.
    expect(memberReq?.filter["#p"]).toEqual([readerPubkey]);
    subs?.stop();
  });

  test("a 39002 signed by the pinned key requests one reconcile", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    relay.broadcast(`pc-ch:${CHANNEL}`, rosterEvent(relaySecret));

    await until(() => requests.length > 0);
    expect(requests.length).toBe(1);
    expect(requests[0]).toEqual([{ relayHost: RELAY_HOST, channelId: CHANNEL }]);
    subs?.stop();
  });

  test("a 44101 signed by the pinned key requests a reconcile too", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    relay.broadcast("pc-member", memberRemovedEvent(relaySecret));

    await until(() => requests.length > 0);
    expect(requests[0]).toEqual([{ relayHost: RELAY_HOST, channelId: CHANNEL }]);
    subs?.stop();
  });

  test("an event from the wrong key is ignored", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    // Validly signed — by somebody who is not the relay.
    relay.broadcast(`pc-ch:${CHANNEL}`, rosterEvent(randomSecret()));

    await Bun.sleep(200);
    expect(requests).toEqual([]);
    expect(logs.some((l) => l.includes("not signed by the pinned relay key"))).toBe(true);
    subs?.stop();
  });

  test("an event with a forged signature is ignored", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    const good = rosterEvent(relaySecret);
    // Right signer, wrong signature — the id still matches the payload, so
    // this reaches the Schnorr check rather than the id check.
    relay.broadcast(`pc-ch:${CHANNEL}`, { ...good, sig: "0".repeat(128) });

    await Bun.sleep(200);
    expect(requests).toEqual([]);
    subs?.stop();
  });

  test("an event for a channel this hub is not bound to is ignored", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    relay.broadcast(`pc-ch:${CHANNEL}`, rosterEvent(relaySecret, OTHER_CHANNEL));

    await Bun.sleep(200);
    expect(requests).toEqual([]);
    subs?.stop();
  });

  test("an unpinned binding ignores events and leaves the pin to the poll", async () => {
    upsertChannelVault(db, { relayHost: RELAY_HOST, channelId: OTHER_CHANNEL, vault: VAULT }, now);
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 3);
    relay.broadcast(`pc-ch:${OTHER_CHANNEL}`, rosterEvent(relaySecret, OTHER_CHANNEL));

    await Bun.sleep(200);
    expect(requests).toEqual([]);
    subs?.stop();
  });

  test("a burst of events becomes one reconcile", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    for (let i = 0; i < 5; i++) {
      relay.broadcast(`pc-ch:${CHANNEL}`, rosterEvent(relaySecret, CHANNEL, 1_800_000_000 + i));
    }

    await until(() => requests.length > 0);
    await Bun.sleep(200);
    expect(requests.length).toBe(1);
    expect(requests[0]?.length).toBe(1);
    subs?.stop();
  });

  test("a request that lands during a running pass is retried, not dropped", async () => {
    reconcileBusy = true;
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    relay.broadcast(`pc-ch:${CHANNEL}`, rosterEvent(relaySecret));

    // The guard says busy — nothing runs, and nothing is lost.
    await Bun.sleep(200);
    expect(requests).toEqual([]);
    reconcileBusy = false;
    await until(() => requests.length > 0);
    expect(requests[0]).toEqual([{ relayHost: RELAY_HOST, channelId: CHANNEL }]);
    subs?.stop();
  });

  test("a dropped connection reconnects and re-REQs", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    const before = relay.reqs.length;
    relay.dropAll();

    await until(() => relay.connections >= 2 && relay.reqs.length > before);
    expect(relay.connections).toBeGreaterThanOrEqual(2);
    // And the reconnected socket still works.
    relay.broadcast(`pc-ch:${CHANNEL}`, rosterEvent(relaySecret));
    await until(() => requests.length > 0);
    expect(requests.length).toBe(1);
    subs?.stop();
  });

  test("a relay that rejects AUTH is logged once and never subscribes", async () => {
    relay.stop();
    relay = startFakeWsRelay({ authOk: false });
    const subs = startChannelSubscriptions(subDeps());
    await until(() => logs.length > 0);
    expect(logs.some((l) => l.includes("rejected NIP-42 auth"))).toBe(true);
    expect(relay.reqs).toEqual([]);
    subs?.stop();
  });

  test("an unreachable relay never throws and never writes a grant", async () => {
    // Port 1 on loopback: nothing listens, and connecting fails fast.
    const subs = startChannelSubscriptions(subDeps({ wsUrlFor: () => "ws://127.0.0.1:1" }));
    expect(subs).not.toBeNull();
    await Bun.sleep(300);
    expect(requests).toEqual([]);
    expect(grantRows()).toEqual([]);
    subs?.stop();
  });

  test("the subscription path never writes or removes a grant itself", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    relay.broadcast(`pc-ch:${CHANNEL}`, rosterEvent(relaySecret));
    relay.broadcast("pc-member", memberRemovedEvent(relaySecret));

    await until(() => requests.length > 0);
    await Bun.sleep(150);
    // The reconcile was REQUESTED (the stub records it) and nothing else
    // happened: no row, no account, no removal. Membership becomes access
    // only through the roster fetch.
    expect(requests.length).toBeGreaterThan(0);
    expect(grantRows()).toEqual([]);
    subs?.stop();
  });

  test("refresh() adds a newly attached binding and drops a detached one", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);

    upsertChannelVault(db, { relayHost: RELAY_HOST, channelId: OTHER_CHANNEL, vault: VAULT }, now);
    pinRelaySelfPubkey(db, RELAY_HOST, OTHER_CHANNEL, relayPubkey);
    subs?.refresh();
    await until(() =>
      relay.reqs.some((r) => (r.filter["#h"] as string[] | undefined)?.[0] === OTHER_CHANNEL),
    );

    db.query("DELETE FROM channel_vaults WHERE channel_id = ?").run(OTHER_CHANNEL);
    subs?.refresh();
    await until(() => relay.closes.includes(`pc-ch:${OTHER_CHANNEL}`));
    expect(relay.closes).toContain(`pc-ch:${OTHER_CHANNEL}`);
    subs?.stop();
  });

  test("stop() closes every socket and fires no further reconciles", async () => {
    const subs = startChannelSubscriptions(subDeps());
    await until(() => relay.reqs.length >= 2);
    relay.broadcast(`pc-ch:${CHANNEL}`, rosterEvent(relaySecret));
    subs?.stop();

    await Bun.sleep(200);
    expect(requests).toEqual([]);
    expect(subs?.states().size).toBe(0);
  });
});

/**
 * The seam between the two halves: a live event must run a REAL reconcile
 * pass through `startChannelReconciler`, sharing its re-entrancy guard, with
 * no poll tick involved. The roster fetch is stubbed to fail — the assertion
 * is that a pass RAN (which is all the subscription may cause), not what it
 * concluded.
 */
describe("startChannelReconciler + live subscription", () => {
  test("a live 39002 runs a reconcile pass with no poll tick", async () => {
    let fetchCalls = 0;
    const reconciler = startChannelReconciler({
      db,
      now,
      log: (l) => logs.push(l),
      rosterOptions: { env },
      fetchRoster: async (): Promise<FetchChannelRosterResult> => {
        fetchCalls++;
        return { ok: false, reason: "relay_unreachable" };
      },
      liveSubscriptions: {
        wsUrlFor: () => relay.url,
        debounceMs: 60,
        minBackoffMs: 10,
        maxBackoffMs: 40,
      },
      // The timer is captured and never fired: everything below is the
      // subscription's doing.
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    expect(reconciler).not.toBeNull();
    await until(() => relay.reqs.length >= 2);

    relay.broadcast(`pc-ch:${CHANNEL}`, rosterEvent(relaySecret));
    await until(() => fetchCalls > 0);
    expect(fetchCalls).toBe(1);
    // The pass really ran: the freeze path recorded its diagnostics.
    await until(() => getChannelVault(db, RELAY_HOST, CHANNEL)?.lastError !== null);
    expect(getChannelVault(db, RELAY_HOST, CHANNEL)?.lastError).toBe("relay_unreachable");
    // And still nothing was granted from the event itself.
    expect(grantRows()).toEqual([]);

    expect(reconciler?.subscriptionStates().get(RELAY_HOST)).toBe("connected");
    reconciler?.stop();
  });

  test("a subscription that cannot connect never stops the poll", async () => {
    let fetchCalls = 0;
    let tick: (() => void) | undefined;
    const reconciler = startChannelReconciler({
      db,
      now,
      log: (l) => logs.push(l),
      rosterOptions: { env },
      fetchRoster: async (): Promise<FetchChannelRosterResult> => {
        fetchCalls++;
        return { ok: false, reason: "relay_unreachable" };
      },
      // Nothing listens on port 1 — the socket half is a permanent failure.
      liveSubscriptions: { wsUrlFor: () => "ws://127.0.0.1:1", minBackoffMs: 10, maxBackoffMs: 20 },
      setIntervalFn: (cb) => {
        tick = cb;
        return 1;
      },
      clearIntervalFn: () => {},
    });
    expect(reconciler).not.toBeNull();
    await Bun.sleep(120);

    tick?.();
    await until(() => fetchCalls > 0);
    expect(fetchCalls).toBe(1);
    reconciler?.stop();
  });

  test("stop() takes the sockets down with the timer", async () => {
    const reconciler = startChannelReconciler({
      db,
      now,
      log: (l) => logs.push(l),
      rosterOptions: { env },
      liveSubscriptions: { wsUrlFor: () => relay.url, debounceMs: 60 },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    await until(() => relay.reqs.length >= 2);
    reconciler?.stop();
    expect(reconciler?.subscriptionStates().size).toBe(0);
  });
});
