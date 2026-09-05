/**
 * `channel_vaults` data access (migration v23, channel-attached vaults PR 1).
 *
 * Covers the store contract the HTTP edge and the later reconciler both lean
 * on: upsert preserves `created_at` and `synced_at`, the inverse lookup filters
 * by vault, normalization agrees with parachute-mcp's `relayHostOf`, and the
 * default name is `ch-<first-8-of-uuid>`.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_VAULT_MODES,
  defaultChannelVaultName,
  getChannelVault,
  isChannelVaultMode,
  listChannelVaults,
  normalizeChannelId,
  normalizeRelayHost,
  pinRelaySelfPubkey,
  removeChannelVault,
  removeChannelVaultsForVault,
  upsertChannelVault,
} from "../channel-vaults.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";

const CHANNEL = "3ff68a58-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

let dir: string;
let db: Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "phub-channel-vaults-"));
  db = openHubDb(hubDbPath(dir));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeRelayHost", () => {
  test("strips the scheme + trailing slashes and lower-cases, like relayHostOf", () => {
    expect(normalizeRelayHost("wss://Buzz.Unforced.DEV/")).toBe("buzz.unforced.dev");
    expect(normalizeRelayHost("https://relay.example//")).toBe("relay.example");
    expect(normalizeRelayHost("  relay.example  ")).toBe("relay.example");
  });

  test("refuses empty, path-bearing, and traversal-shaped values", () => {
    expect(normalizeRelayHost("")).toBeUndefined();
    expect(normalizeRelayHost("   ")).toBeUndefined();
    expect(normalizeRelayHost(undefined)).toBeUndefined();
    expect(normalizeRelayHost("wss://relay.example/path")).toBeUndefined();
    expect(normalizeRelayHost("..")).toBeUndefined();
    expect(normalizeRelayHost("relay example")).toBeUndefined();
  });
});

describe("normalizeChannelId", () => {
  test("trims but does NOT lower-case (the id is opaque)", () => {
    expect(normalizeChannelId("  ABC-123  ")).toBe("ABC-123");
  });
  test("refuses anything that is not a single path segment", () => {
    expect(normalizeChannelId("")).toBeUndefined();
    expect(normalizeChannelId("a/b")).toBeUndefined();
    expect(normalizeChannelId("../x")).toBeUndefined();
    expect(normalizeChannelId("a b")).toBeUndefined();
  });
});

describe("defaultChannelVaultName", () => {
  test("is ch-<first-8-of-uuid>, lower-cased", () => {
    expect(defaultChannelVaultName(CHANNEL)).toBe("ch-3ff68a58");
    expect(defaultChannelVaultName("3FF68A58-XXXX")).toBe("ch-3ff68a58");
  });
});

describe("mode", () => {
  test("only sync and frozen are modes", () => {
    expect([...CHANNEL_VAULT_MODES]).toEqual(["sync", "frozen"]);
    expect(isChannelVaultMode("sync")).toBe(true);
    expect(isChannelVaultMode("frozen")).toBe(true);
    expect(isChannelVaultMode("write")).toBe(false);
  });
});

describe("upsert / get / list / remove", () => {
  test("upsert writes a sync binding that has never synced", () => {
    const b = upsertChannelVault(db, {
      relayHost: "relay.example",
      channelId: CHANNEL,
      vault: "ch-3ff68a58",
    });
    expect(b.mode).toBe("sync");
    expect(b.syncedAt).toBeNull();
    expect(b.relaySelfPubkey).toBeNull();
    expect(getChannelVault(db, "relay.example", CHANNEL)?.vault).toBe("ch-3ff68a58");
  });

  test("re-upsert preserves created_at and synced_at while updating the vault", () => {
    const first = upsertChannelVault(
      db,
      { relayHost: "relay.example", channelId: CHANNEL, vault: "one" },
      () => new Date("2026-09-01T00:00:00.000Z"),
    );
    // Stand in for a later reconciler having stamped a sync.
    db.prepare("UPDATE channel_vaults SET synced_at = ?").run("2026-09-01T12:00:00.000Z");

    const second = upsertChannelVault(
      db,
      { relayHost: "relay.example", channelId: CHANNEL, vault: "two", mode: "frozen" },
      () => new Date("2026-09-05T00:00:00.000Z"),
    );
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.syncedAt).toBe("2026-09-01T12:00:00.000Z");
    expect(second.vault).toBe("two");
    expect(second.mode).toBe("frozen");
  });

  test("get returns null for an unbound channel", () => {
    expect(getChannelVault(db, "relay.example", "nope")).toBeNull();
  });

  test("list is ordered and filters by vault (one vault may back many channels)", () => {
    upsertChannelVault(db, { relayHost: "b.example", channelId: "c2", vault: "shared" });
    upsertChannelVault(db, { relayHost: "a.example", channelId: "c1", vault: "shared" });
    upsertChannelVault(db, { relayHost: "a.example", channelId: "c9", vault: "solo" });

    expect(listChannelVaults(db).map((b) => `${b.relayHost}/${b.channelId}`)).toEqual([
      "a.example/c1",
      "a.example/c9",
      "b.example/c2",
    ]);
    expect(listChannelVaults(db, "shared").map((b) => b.channelId)).toEqual(["c1", "c2"]);
    expect(listChannelVaults(db, "absent")).toEqual([]);
  });

  test("remove is idempotent and scoped to the (relay, channel) pair", () => {
    upsertChannelVault(db, { relayHost: "a.example", channelId: "c1", vault: "v" });
    upsertChannelVault(db, { relayHost: "b.example", channelId: "c1", vault: "v" });

    expect(removeChannelVault(db, "a.example", "c1")).toBe(true);
    expect(removeChannelVault(db, "a.example", "c1")).toBe(false);
    expect(getChannelVault(db, "b.example", "c1")).not.toBeNull();
  });

  test("removeChannelVaultsForVault drops every binding for one vault only", () => {
    upsertChannelVault(db, { relayHost: "a.example", channelId: "c1", vault: "doomed" });
    upsertChannelVault(db, { relayHost: "b.example", channelId: "c2", vault: "doomed" });
    upsertChannelVault(db, { relayHost: "c.example", channelId: "c3", vault: "keeper" });

    expect(removeChannelVaultsForVault(db, "doomed")).toBe(2);
    expect(listChannelVaults(db).map((b) => b.vault)).toEqual(["keeper"]);
  });
});

describe("pinRelaySelfPubkey", () => {
  const KEY_A = "a".repeat(64);
  const KEY_B = "b".repeat(64);

  test("pins once on a NULL column and refuses to overwrite afterwards", () => {
    upsertChannelVault(db, { relayHost: "a.example", channelId: "c1", vault: "v" });
    expect(getChannelVault(db, "a.example", "c1")?.relaySelfPubkey).toBeNull();

    expect(pinRelaySelfPubkey(db, "a.example", "c1", KEY_A)).toBe(true);
    expect(getChannelVault(db, "a.example", "c1")?.relaySelfPubkey).toBe(KEY_A);

    // The whole point of trust-on-first-use: a second, different key does not
    // land, and the call reports that it changed nothing.
    expect(pinRelaySelfPubkey(db, "a.example", "c1", KEY_B)).toBe(false);
    expect(getChannelVault(db, "a.example", "c1")?.relaySelfPubkey).toBe(KEY_A);

    // Re-pinning the SAME key is also a no-op — idempotent, not an error.
    expect(pinRelaySelfPubkey(db, "a.example", "c1", KEY_A)).toBe(false);
  });

  test("is scoped to one binding and a missing row is false, not a throw", () => {
    upsertChannelVault(db, { relayHost: "a.example", channelId: "c1", vault: "v" });
    upsertChannelVault(db, { relayHost: "b.example", channelId: "c1", vault: "v" });

    expect(pinRelaySelfPubkey(db, "a.example", "c1", KEY_A)).toBe(true);
    expect(getChannelVault(db, "b.example", "c1")?.relaySelfPubkey).toBeNull();
    expect(pinRelaySelfPubkey(db, "absent.example", "c9", KEY_A)).toBe(false);
  });
});
