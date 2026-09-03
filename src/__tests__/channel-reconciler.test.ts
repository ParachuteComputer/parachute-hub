/**
 * Channel membership reconciler (channel-attached vaults PR 5).
 *
 * The design note's gate for this row is "fake relay: remove a member, row
 * gone within 90s; relay unreachable → rows retained, `synced_at` stale". Both
 * are here, plus the properties that make the removal half safe to run
 * unattended: an operator's hand-made grant is never swept, `write`/`admin` is
 * never written, a `frozen` binding is never even fetched, and a steady-state
 * pass writes no rows at all.
 *
 * The relay is the real loopback `Bun.serve` fake from `channel-roster.test.ts`
 * with real keypairs and real signatures — the reconciler is only as
 * trustworthy as the roster it is handed, so stubbing the fetcher out for the
 * happy paths would test the easy half. `fetchImpl` is stubbed only where the
 * point IS a transport failure.
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
  CHANNEL_RECONCILE_INTERVAL_MS,
  channelGrantVia,
  hubRoleForRosterRole,
  isChannelGrantVia,
  reconcileBinding,
  runReconcileOnce,
  startChannelReconciler,
} from "../channel-reconciler.ts";
import type { FetchChannelRosterResult } from "../channel-roster.ts";
import { getChannelVault, upsertChannelVault } from "../channel-vaults.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import {
  NOSTR_AUTH_KIND,
  type NostrEvent,
  parseNostrEvent,
  verifyNostrEvent,
} from "../nostr-event.ts";
import { pubkeyForSecret, signNostrEvent } from "../nostr-http-sign.ts";
import { findPubkeyLink } from "../pubkey-links.ts";
import {
  createUser,
  removeUserVault as removeUserVaultReal,
  upsertUserVault,
  vaultVerbsForRole,
} from "../users.ts";

const RELAY_HOST = "buzz.techne.coop";
const CHANNEL = "3ff68a58-3f97-409a-b531-45d388b3c827";
const VAULT = "parachute";
const VIA = channelGrantVia(RELAY_HOST, CHANNEL);

function randomSecret(): string {
  return Buffer.from(schnorr.utils.randomSecretKey()).toString("hex");
}

/** A relay-shaped kind 39002 for `channel`, signed by `secret`. */
function rosterEvent(
  secret: string,
  members: readonly [string, string][],
  createdAt = 1_800_000_000,
): NostrEvent {
  const tags: string[][] = [["d", CHANNEL]];
  for (const [pubkey, role] of members) tags.push(["p", pubkey, "", role]);
  return signNostrEvent({ created_at: createdAt, kind: 39002, tags, content: "" }, secret);
}

interface FakeRelay {
  origin: string;
  stop: () => void;
  /** Swap the served roster between passes. */
  setEvents: (events: readonly unknown[]) => void;
  queries: number;
}

/** Loopback stand-in for the Buzz REST bridge — NIP-11 on `/`, events on `/query`. */
function startFakeRelay(self: string, events: readonly unknown[]): FakeRelay {
  let served: readonly unknown[] = events;
  const state = { queries: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") {
        return Response.json({ name: "fake", self, supported_nips: [98] });
      }
      if (req.method === "POST" && url.pathname === "/query") {
        const body = new Uint8Array(await req.arrayBuffer());
        const token = (req.headers.get("authorization") ?? "").replace(/^Nostr\s+/i, "");
        let ev: NostrEvent;
        try {
          const parsed = parseNostrEvent(JSON.parse(Buffer.from(token, "base64").toString("utf8")));
          if (!parsed.ok) return new Response("bad auth", { status: 401 });
          ev = parsed.event;
        } catch {
          return new Response("bad auth", { status: 401 });
        }
        const tag = (n: string) => ev.tags.find((t) => t[0] === n)?.[1];
        if (
          ev.kind !== NOSTR_AUTH_KIND ||
          !verifyNostrEvent(ev).ok ||
          tag("u") !== url.href ||
          tag("method") !== "POST" ||
          tag("payload") !== createHash("sha256").update(body).digest("hex")
        ) {
          return new Response("bad auth", { status: 401 });
        }
        state.queries++;
        return Response.json(served);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    setEvents: (e) => {
      served = e;
    },
    get queries() {
      return state.queries;
    },
  };
}

let dir: string;
let db: Database;
let env: NodeJS.ProcessEnv;
let relaySecret: string;
let relayPubkey: string;
const relays: FakeRelay[] = [];
const logs: string[] = [];
/** Monotonic injectable clock so `synced_at` comparisons are unambiguous. */
let clock: number;
const now = () => new Date(clock);

const alice = "1".repeat(64);
const bob = "2".repeat(64);
const carol = "3".repeat(64);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "phub-channel-reconciler-"));
  db = openHubDb(hubDbPath(dir));
  clock = Date.parse("2026-09-03T12:00:00.000Z");
  logs.length = 0;
  const keyPath = join(dir, "reader.nsec");
  writeFileSync(keyPath, `${randomSecret()}\n`, { mode: 0o600 });
  env = { [BUZZ_NSEC_FILE_ENV]: keyPath };
  relaySecret = randomSecret();
  relayPubkey = pubkeyForSecret(relaySecret);
  // A hub owner has to exist before grant-first may create key-only accounts.
  await createUser(db, "owner", "correct-horse-battery", { passwordChanged: true });
  upsertChannelVault(db, { relayHost: RELAY_HOST, channelId: CHANNEL, vault: VAULT }, now);
});

afterEach(() => {
  for (const r of relays.splice(0)) r.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function fake(events: readonly unknown[]): FakeRelay {
  const r = startFakeRelay(relayPubkey, events);
  relays.push(r);
  return r;
}

function depsFor(relay: FakeRelay) {
  return {
    db,
    now,
    log: (line: string) => logs.push(line),
    rosterOptions: { env, originFor: () => relay.origin, timeoutMs: 5_000 },
  };
}

function binding() {
  const b = getChannelVault(db, RELAY_HOST, CHANNEL);
  if (!b) throw new Error("binding vanished");
  return b;
}

interface RowShape {
  user_id: string;
  role: string;
  granted_via: string | null;
  created_at: string;
}

function rows(): RowShape[] {
  return db
    .query<RowShape, [string]>(
      "SELECT user_id, role, granted_via, created_at FROM user_vaults WHERE vault_name = ? ORDER BY created_at ASC, user_id ASC",
    )
    .all(VAULT);
}

function roleFor(pubkey: string): string | undefined {
  const link = findPubkeyLink(db, pubkey);
  if (!link) return undefined;
  return rows().find((r) => r.user_id === link.userId)?.role;
}

describe("role map", () => {
  test("guest reads, everybody else is a member, and nothing else is reachable", () => {
    expect(hubRoleForRosterRole("guest")).toBe("read");
    for (const role of ["owner", "admin", "member", "bot"] as const) {
      expect(hubRoleForRosterRole(role)).toBe("member");
    }
    // The property that matters: neither mapped role can re-grant.
    expect(vaultVerbsForRole("member")).toEqual(["read", "write"]);
    expect(vaultVerbsForRole("read")).toEqual(["read"]);
    expect(vaultVerbsForRole("write")).toContain("admin");
  });

  test("the provenance label is binding-scoped and recognisable", () => {
    expect(VIA).toBe(`channel:${RELAY_HOST}:${CHANNEL}`);
    expect(isChannelGrantVia(VIA)).toBe(true);
    for (const via of [null, undefined, "mcp", "cli", "api"]) {
      expect(isChannelGrantVia(via)).toBe(false);
    }
    expect(channelGrantVia(RELAY_HOST, "other")).not.toBe(VIA);
  });
});

describe("reconcileBinding", () => {
  test("materialises a roster: guest → read, everyone else → member, never write/admin", async () => {
    const relay = fake([
      rosterEvent(relaySecret, [
        [alice, "owner"],
        [bob, "member"],
        [carol, "guest"],
      ]),
    ]);
    const result = await reconcileBinding(binding(), depsFor(relay));

    expect(result.status).toBe("ok");
    expect(result.members).toBe(3);
    expect(result.granted).toBe(3);
    expect(result.createdUsers).toBe(3);
    expect(result.removed).toBe(0);

    expect(roleFor(alice)).toBe("member");
    expect(roleFor(bob)).toBe("member");
    expect(roleFor(carol)).toBe("read");
    // The lockdown invariant, asserted over the whole table rather than per row.
    for (const r of rows()) {
      expect(r.role === "member" || r.role === "read").toBe(true);
      expect(r.granted_via).toBe(VIA);
    }
    expect(binding().syncedAt).toBe(new Date(clock).toISOString());
    expect(binding().lastError).toBeNull();
  });

  test("a pubkey new to the hub gets a key-only user and a channel-labelled link", async () => {
    const relay = fake([rosterEvent(relaySecret, [[alice, "member"]])]);
    await reconcileBinding(binding(), depsFor(relay));

    const link = findPubkeyLink(db, alice);
    expect(link).not.toBeNull();
    expect(link?.label).toBe(VIA);
    // Operator-attested, not a possession proof — no event is stored.
    expect(link?.proofEventId).toBe("");
    const user = db
      .query<{ username: string; hub_role: string }, [string]>(
        "SELECT username, hub_role FROM users WHERE id = ?",
      )
      .get(link?.userId ?? "");
    expect(user?.hub_role).toBe("user");
  });

  test("removing a member from the roster removes the row on the next pass", async () => {
    const relay = fake([
      rosterEvent(relaySecret, [
        [alice, "member"],
        [bob, "member"],
      ]),
    ]);
    await reconcileBinding(binding(), depsFor(relay));
    expect(rows()).toHaveLength(2);

    // Bob is removed on the relay; the relay re-emits 39002.
    relay.setEvents([rosterEvent(relaySecret, [[alice, "member"]], 1_800_000_100)]);
    clock += CHANNEL_RECONCILE_INTERVAL_MS;
    const second = await reconcileBinding(binding(), depsFor(relay));

    expect(second.removed).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(roleFor(alice)).toBe("member");
    expect(roleFor(bob)).toBeUndefined();
    // The account and its key link survive — only the grant is revoked.
    expect(findPubkeyLink(db, bob)).not.toBeNull();
    expect(
      logs.some((l) => l.includes("vault access removed") && l.includes("not_in_roster")),
    ).toBe(true);
  });

  test("removal sweep is all-or-nothing: a throw on the second row leaves every grant untouched", async () => {
    const relay = fake([
      rosterEvent(relaySecret, [
        [alice, "member"],
        [bob, "member"],
      ]),
    ]);
    await reconcileBinding(binding(), depsFor(relay));
    expect(rows()).toHaveLength(2);

    // Both drop out of the roster in the same tick — two candidates for the
    // removal sweep, so a throw on the second exercises the transaction
    // rolling back the first row's already-applied delete too.
    relay.setEvents([rosterEvent(relaySecret, [], 1_800_000_100)]);
    clock += CHANNEL_RECONCILE_INTERVAL_MS;

    let calls = 0;
    const flakyRemove: typeof removeUserVaultReal = (removeDb, userId, vaultName, removeNow) => {
      calls++;
      if (calls === 2) throw new Error("simulated failure mid-sweep");
      return removeUserVaultReal(removeDb, userId, vaultName, removeNow);
    };
    const result = await reconcileBinding(binding(), {
      ...depsFor(relay),
      removeUserVault: flakyRemove,
    });

    expect(calls).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.errors).toBe(1);
    // Rolled back: both rows survive, including the one the fake had already
    // (really) deleted before it threw on the second.
    expect(rows()).toHaveLength(2);
    expect(logs.some((l) => l.includes("removal sweep failed") && l.includes("rolled back"))).toBe(
      true,
    );
  });

  test("a role change is applied, never observed as a removal", async () => {
    const relay = fake([rosterEvent(relaySecret, [[alice, "member"]])]);
    await reconcileBinding(binding(), depsFor(relay));
    expect(roleFor(alice)).toBe("member");

    relay.setEvents([rosterEvent(relaySecret, [[alice, "guest"]], 1_800_000_100)]);
    clock += CHANNEL_RECONCILE_INTERVAL_MS;
    const second = await reconcileBinding(binding(), depsFor(relay));

    expect(second.granted).toBe(1);
    expect(second.removed).toBe(0);
    expect(roleFor(alice)).toBe("read");
  });

  test("a second pass over an unchanged roster writes no rows and still advances synced_at", async () => {
    const relay = fake([
      rosterEvent(relaySecret, [
        [alice, "member"],
        [carol, "guest"],
      ]),
    ]);
    await reconcileBinding(binding(), depsFor(relay));
    const before = rows();
    const firstSync = binding().syncedAt;

    clock += CHANNEL_RECONCILE_INTERVAL_MS;
    const second = await reconcileBinding(binding(), depsFor(relay));

    expect(second.status).toBe("ok");
    expect(second.unchanged).toBe(2);
    expect(second.granted).toBe(0);
    expect(second.removed).toBe(0);
    expect(second.createdUsers).toBe(0);
    // No churn: the same rows, byte for byte, including created_at.
    expect(rows()).toEqual(before);
    expect(binding().syncedAt).not.toBe(firstSync);
    expect(binding().syncedAt).toBe(new Date(clock).toISOString());
  });

  test("an unreachable relay freezes: rows retained, synced_at unchanged", async () => {
    const relay = fake([
      rosterEvent(relaySecret, [
        [alice, "member"],
        [bob, "member"],
      ]),
    ]);
    await reconcileBinding(binding(), depsFor(relay));
    const before = rows();
    const firstSync = binding().syncedAt;
    expect(before).toHaveLength(2);

    clock += CHANNEL_RECONCILE_INTERVAL_MS;
    const deps = depsFor(relay);
    const failing = {
      ...deps,
      rosterOptions: {
        ...deps.rosterOptions,
        fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
      },
    };
    const second = await reconcileBinding(binding(), failing);

    expect(second.status).toBe("failed");
    expect(second.reason).toBe("relay_unreachable");
    expect(second.removed).toBe(0);
    expect(second.granted).toBe(0);
    expect(rows()).toEqual(before);
    expect(binding().syncedAt).toBe(firstSync);
    // Diagnostics move so the freeze is visible; access does not.
    expect(binding().lastError).toBe("relay_unreachable");
    expect(binding().lastAttemptAt).toBe(new Date(clock).toISOString());
  });

  test("the failure log is rate-limited per (binding, reason)", async () => {
    const relay = fake([]);
    const deps = depsFor(relay);
    const limiter = { last: new Map<string, number>() };
    const failing = {
      ...deps,
      limiter,
      rosterOptions: {
        ...deps.rosterOptions,
        fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
      },
    };
    await reconcileBinding(binding(), failing);
    const afterFirst = logs.filter((l) => l.includes("roster fetch failed")).length;
    expect(afterFirst).toBe(1);

    // Five more minutes of one-a-minute polling: still one line.
    for (let i = 0; i < 5; i++) {
      clock += CHANNEL_RECONCILE_INTERVAL_MS;
      await reconcileBinding(binding(), failing);
    }
    expect(logs.filter((l) => l.includes("roster fetch failed")).length).toBe(1);

    // Past the quiet window it speaks again — a persistent outage must not go
    // permanently silent.
    clock += 16 * 60_000;
    await reconcileBinding(binding(), failing);
    expect(logs.filter((l) => l.includes("roster fetch failed")).length).toBe(2);
  });

  test("an operator-granted row survives a roster that omits its pubkey", async () => {
    // A human grants bob `write` by hand, then bob is not in the channel.
    const person = await createUser(db, "bob-human", "another-good-password", {
      allowMulti: true,
      passwordChanged: true,
    });
    upsertUserVault(db, person.id, VAULT, "write", now, {
      grantedByUserId: "someone",
      grantedVia: "cli",
    });

    const relay = fake([rosterEvent(relaySecret, [[alice, "member"]])]);
    const result = await reconcileBinding(binding(), depsFor(relay));

    expect(result.removed).toBe(0);
    const kept = rows().find((r) => r.user_id === person.id);
    expect(kept?.role).toBe("write");
    expect(kept?.granted_via).toBe("cli");
  });

  test("an operator-granted row for a pubkey IN the roster is left exactly as the human set it", async () => {
    const person = await createUser(db, "alice-human", "another-good-password", {
      allowMulti: true,
      passwordChanged: true,
    });
    // Link alice's key to that account, then grant `write` by hand.
    const { bindPubkeyOperatorAttested } = await import("../pubkey-links.ts");
    bindPubkeyOperatorAttested(db, { userId: person.id, pubkey: alice, label: "operator" });
    upsertUserVault(db, person.id, VAULT, "write", now, { grantedVia: "mcp" });

    const relay = fake([rosterEvent(relaySecret, [[alice, "guest"]])]);
    const result = await reconcileBinding(binding(), depsFor(relay));

    expect(result.deferred).toBe(1);
    expect(result.granted).toBe(0);
    const row = rows().find((r) => r.user_id === person.id);
    expect(row?.role).toBe("write");
    expect(row?.granted_via).toBe("mcp");
    // And the key's original label is not rewritten by the sync.
    expect(findPubkeyLink(db, alice)?.label).toBe("operator");
  });

  test("a row survives while EITHER of a user's two linked keys is in the roster, and is removed once neither is", async () => {
    // One hub account, two linked keys (the "an agent's and a human's" case
    // the removal-sweep comment describes) — both seated in the channel.
    const person = await createUser(db, "dual-key-user", "another-good-password", {
      allowMulti: true,
      passwordChanged: true,
    });
    const { bindPubkeyOperatorAttested } = await import("../pubkey-links.ts");
    bindPubkeyOperatorAttested(db, { userId: person.id, pubkey: alice, label: "operator" });
    bindPubkeyOperatorAttested(db, { userId: person.id, pubkey: bob, label: "operator" });

    const relay = fake([
      rosterEvent(relaySecret, [
        [alice, "member"],
        [bob, "member"],
      ]),
    ]);
    await reconcileBinding(binding(), depsFor(relay));
    expect(rows().filter((r) => r.user_id === person.id)).toHaveLength(1);

    // The roster drops bob but keeps alice — one of the two keys is still
    // seated, so the row must survive untouched.
    relay.setEvents([rosterEvent(relaySecret, [[alice, "member"]], 1_800_000_100)]);
    clock += CHANNEL_RECONCILE_INTERVAL_MS;
    const second = await reconcileBinding(binding(), depsFor(relay));
    expect(second.removed).toBe(0);
    expect(rows().find((r) => r.user_id === person.id)?.role).toBe("member");

    // Now the roster drops alice too — neither linked key is seated, so the
    // row goes.
    relay.setEvents([rosterEvent(relaySecret, [], 1_800_000_200)]);
    clock += CHANNEL_RECONCILE_INTERVAL_MS;
    const third = await reconcileBinding(binding(), depsFor(relay));
    expect(third.removed).toBe(1);
    expect(rows().find((r) => r.user_id === person.id)).toBeUndefined();
  });

  test("a hub admin in the roster gets no row (unrestricted by construction)", async () => {
    const admin = db
      .query<{ id: string }, []>("SELECT id FROM users WHERE hub_role = 'admin'")
      .get();
    const { bindPubkeyOperatorAttested } = await import("../pubkey-links.ts");
    bindPubkeyOperatorAttested(db, { userId: admin?.id ?? "", pubkey: alice, label: "operator" });

    const relay = fake([rosterEvent(relaySecret, [[alice, "owner"]])]);
    const result = await reconcileBinding(binding(), depsFor(relay));

    expect(result.deferred).toBe(1);
    expect(rows()).toHaveLength(0);
  });

  test("a frozen binding is skipped without any network call", async () => {
    const relay = fake([rosterEvent(relaySecret, [[alice, "member"]])]);
    await reconcileBinding(binding(), depsFor(relay));
    const before = rows();
    const firstSync = binding().syncedAt;
    const queriesBefore = relay.queries;

    upsertChannelVault(db, {
      relayHost: RELAY_HOST,
      channelId: CHANNEL,
      vault: VAULT,
      mode: "frozen",
    });
    relay.setEvents([rosterEvent(relaySecret, [], 1_800_000_100)]);
    clock += CHANNEL_RECONCILE_INTERVAL_MS;
    const skipped = await reconcileBinding(binding(), depsFor(relay));

    expect(skipped.status).toBe("skipped");
    expect(skipped.reason).toBe("frozen");
    expect(relay.queries).toBe(queriesBefore);
    expect(rows()).toEqual(before);
    expect(binding().syncedAt).toBe(firstSync);
  });

  test("an unrecognised mode is skipped too — fail closed", async () => {
    db.prepare("UPDATE channel_vaults SET mode = 'wide-open'").run();
    const relay = fake([rosterEvent(relaySecret, [[alice, "member"]])]);
    const result = await reconcileBinding(binding(), depsFor(relay));
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("unknown_mode");
    expect(rows()).toHaveLength(0);
  });
});

describe("runReconcileOnce", () => {
  test("does nothing, and says why, without a reader key", async () => {
    const relay = fake([rosterEvent(relaySecret, [[alice, "member"]])]);
    const result = await runReconcileOnce({
      ...depsFor(relay),
      rosterOptions: { env: {}, configDir: join(dir, "empty"), originFor: () => relay.origin },
    });
    expect(result).toEqual({ ran: false, reason: "not_configured", bindings: [] });
    expect(rows()).toHaveLength(0);
  });

  test("does nothing when no binding is in sync mode", async () => {
    db.prepare("UPDATE channel_vaults SET mode = 'frozen'").run();
    const relay = fake([]);
    const result = await runReconcileOnce(depsFor(relay));
    expect(result).toEqual({ ran: false, reason: "no_sync_bindings", bindings: [] });
  });

  test("runs every sync binding and reports per binding", async () => {
    upsertChannelVault(
      db,
      { relayHost: RELAY_HOST, channelId: "second-channel", vault: VAULT, mode: "frozen" },
      now,
    );
    const relay = fake([rosterEvent(relaySecret, [[alice, "member"]])]);
    const result = await runReconcileOnce(depsFor(relay));

    expect(result.ran).toBe(true);
    // The frozen binding is filtered out before the pass, not skipped inside it.
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.channelId).toBe(CHANNEL);
    expect(result.bindings[0]?.status).toBe("ok");
    expect(result.bindings[0]?.granted).toBe(1);
  });
});

describe("startChannelReconciler", () => {
  test("never starts without a configured reader key", () => {
    let started = 0;
    const reconciler = startChannelReconciler({
      db,
      log: (l) => logs.push(l),
      rosterOptions: { env: {}, configDir: join(dir, "empty") },
      setIntervalFn: () => {
        started++;
        return 1;
      },
      clearIntervalFn: () => {},
    });
    expect(reconciler).toBeNull();
    expect(started).toBe(0);
    // `not_configured` is the ordinary state of a hub that hasn't opted in —
    // it must not nag on every boot.
    expect(logs).toEqual([]);
  });

  test("says so once when the key file exists but is unusable", () => {
    const bad = join(dir, "bad.nsec");
    writeFileSync(bad, "not-a-key\n");
    const reconciler = startChannelReconciler({
      db,
      log: (l) => logs.push(l),
      rosterOptions: { env: { [BUZZ_NSEC_FILE_ENV]: bad } },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    expect(reconciler).toBeNull();
    expect(logs.some((l) => l.includes("malformed"))).toBe(true);
  });

  test("arms a 60-second poll when a key is configured, and a tick reconciles", async () => {
    const relay = fake([rosterEvent(relaySecret, [[alice, "member"]])]);
    let tick: (() => void) | undefined;
    let intervalMs = 0;
    const reconciler = startChannelReconciler({
      ...depsFor(relay),
      // Poll-only: this test is about the timer, and the live half would
      // otherwise dial the real `buzz.techne.coop` out of a fixture.
      liveSubscriptions: false,
      setIntervalFn: (cb, ms) => {
        tick = cb;
        intervalMs = ms;
        return 1;
      },
      clearIntervalFn: () => {},
    });
    expect(reconciler).not.toBeNull();
    expect(intervalMs).toBe(CHANNEL_RECONCILE_INTERVAL_MS);

    tick?.();
    // The tick fires the pass WITHOUT awaiting it (an interval callback cannot
    // await), so poll for the effect rather than guessing a sleep — creating a
    // key-only account runs argon2 and is not microtask-fast.
    for (let i = 0; i < 100 && roleFor(alice) === undefined; i++) await Bun.sleep(20);
    expect(roleFor(alice)).toBe("member");
    reconciler?.stop();
  });

  test("two overlapping ticks do not run concurrently — the second is a no-op while the first is in flight", async () => {
    let fetchCalls = 0;
    let resolveFetch: ((r: FetchChannelRosterResult) => void) | undefined;
    // A roster fetch that never settles until the test says so — this holds
    // the pass "in flight" for as long as the test needs, so a second tick
    // fired while it is running can be observed hitting the `running` guard
    // rather than racing a fast fetch.
    const blockingFetchRoster = (): Promise<FetchChannelRosterResult> => {
      fetchCalls++;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    };

    let tick: (() => void) | undefined;
    const reconciler = startChannelReconciler({
      db,
      now,
      log: (l) => logs.push(l),
      rosterOptions: { env },
      fetchRoster: blockingFetchRoster,
      liveSubscriptions: false,
      setIntervalFn: (cb) => {
        tick = cb;
        return 1;
      },
      clearIntervalFn: () => {},
    });
    expect(reconciler).not.toBeNull();

    tick?.();
    // Give the first pass's fetch call a chance to run (it's synchronous up
    // to the `await fetchRoster(...)`, so this should already be true, but a
    // microtask tick keeps this robust either way).
    await Bun.sleep(0);
    expect(fetchCalls).toBe(1);

    // A second tick while the first is still blocked on its fetch — the
    // `running` guard in `startChannelReconciler` must make this a no-op:
    // no second `fetchRoster` call, no second pass.
    tick?.();
    await Bun.sleep(20);
    expect(fetchCalls).toBe(1);

    // Let the first pass finish.
    resolveFetch?.({ ok: false, reason: "relay_unreachable" });
    for (let i = 0; i < 100 && binding().lastError === null; i++) await Bun.sleep(20);
    expect(binding().lastError).toBe("relay_unreachable");

    // The guard is an in-flight lock, not a permanent one: now that the first
    // pass has finished, a fresh tick runs a fresh pass.
    tick?.();
    await Bun.sleep(20);
    expect(fetchCalls).toBe(2);
    resolveFetch?.({ ok: false, reason: "relay_unreachable" });

    reconciler?.stop();
  });
});
