/**
 * `/api/channel-vault` + `/api/channel-vaults*` (channel-attached vaults PR 1).
 *
 * The two gates are the point of this file:
 *
 *   - the READ side is authentication-only, so an ordinary non-admin bearer
 *     gets a 200 and an unauthenticated request gets a 401;
 *   - the operator side is `parachute:host:admin`, the same gate as
 *     POST /vaults, so a channel cannot annex a hub's storage.
 *
 * Plus the attach contract: default name, the 400 on a vault that is not
 * installed, idempotent re-attach, conflict on a rebind, and detach.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ADMIN_SCOPE } from "../admin-vaults.ts";
import {
  handleAttachChannelVault,
  handleDetachChannelVault,
  handleGetChannelVault,
  handleListChannelVaults,
  handleSyncChannelVaults,
} from "../api-channel-vaults.ts";
import { getChannelVault, upsertChannelVault } from "../channel-vaults.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { createUser } from "../users.ts";

const ISSUER = "https://hub.test";
const CHANNEL = "3ff68a58-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const RELAY = "buzz.unforced.dev";

interface Harness {
  db: Database;
  dir: string;
  manifestPath: string;
  cleanup: () => void;
}

function manifestWithVaults(...names: string[]): string {
  return JSON.stringify({
    services: [
      {
        name: "parachute-vault",
        port: 4101,
        paths: names.map((n) => `/vault/${n}`),
        health: "/health",
        version: "0.0.0-test",
      },
    ],
  });
}

let h: Harness;
let userSeq = 0;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "phub-api-channel-vaults-"));
  const manifestPath = join(dir, "services.json");
  // `ch-3ff68a58` is the name `defaultChannelVaultName(CHANNEL)` proposes; it
  // is installed here so the default-name path has something to bind to.
  writeFileSync(manifestPath, manifestWithVaults("existing", "ch-3ff68a58"));
  h = {
    db: openHubDb(hubDbPath(dir)),
    dir,
    manifestPath,
    cleanup: () => {
      h.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
afterEach(() => h.cleanup());

async function bearerWith(scopes: string[]): Promise<string> {
  userSeq += 1;
  const user = await createUser(h.db, `operator${userSeq}`, "any-password", {
    allowMulti: true,
    passwordChanged: true,
  });
  const minted = await signAccessToken(h.db, {
    sub: user.id,
    scopes,
    audience: "hub",
    clientId: "parachute-hub-spa",
    issuer: ISSUER,
    ttlSeconds: 600,
  });
  return minted.token;
}

function req(path: string, bearer?: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return new Request(`${ISSUER}${path}`, { ...init, headers });
}

function jsonReq(path: string, bearer: string, method: string, body: unknown): Request {
  return req(path, bearer, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deps() {
  return { db: h.db, issuer: ISSUER, manifestPath: h.manifestPath };
}

describe("GET /api/channel-vault — the read side", () => {
  test("401 unauthenticated", async () => {
    const res = await handleGetChannelVault(
      req(`/api/channel-vault?relay=${RELAY}&channel=${CHANNEL}`),
      deps(),
    );
    expect(res.status).toBe(401);
  });

  test("200 for ANY authenticated bearer — a vault name is not a secret", async () => {
    upsertChannelVault(h.db, { relayHost: RELAY, channelId: CHANNEL, vault: "existing" });
    // Deliberately NOT host:admin, and with no grant on the vault at all.
    const bearer = await bearerWith(["vault:other:read"]);
    const res = await handleGetChannelVault(
      req(`/api/channel-vault?relay=${RELAY}&channel=${CHANNEL}`, bearer),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ vault: "existing", mode: "sync", synced_at: null });
  });

  test("404 when the channel is unbound", async () => {
    const bearer = await bearerWith(["vault:other:read"]);
    const res = await handleGetChannelVault(
      req(`/api/channel-vault?relay=${RELAY}&channel=${CHANNEL}`, bearer),
      deps(),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("not_found");
  });

  test("the relay is matched case-insensitively and scheme-free", async () => {
    upsertChannelVault(h.db, { relayHost: RELAY, channelId: CHANNEL, vault: "existing" });
    const bearer = await bearerWith(["vault:other:read"]);
    const res = await handleGetChannelVault(
      req(
        `/api/channel-vault?relay=${encodeURIComponent("wss://Buzz.Unforced.DEV/")}&channel=${CHANNEL}`,
        bearer,
      ),
      deps(),
    );
    expect(res.status).toBe(200);
  });

  test("400 when relay or channel is missing", async () => {
    const bearer = await bearerWith(["vault:other:read"]);
    expect((await handleGetChannelVault(req("/api/channel-vault", bearer), deps())).status).toBe(
      400,
    );
    expect(
      (await handleGetChannelVault(req(`/api/channel-vault?relay=${RELAY}`, bearer), deps()))
        .status,
    ).toBe(400);
  });

  test("405 on a non-GET", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleGetChannelVault(
      req(`/api/channel-vault?relay=${RELAY}&channel=${CHANNEL}`, bearer, { method: "POST" }),
      deps(),
    );
    expect(res.status).toBe(405);
  });
});

describe("POST /api/channel-vaults — attach", () => {
  test("401 unauthenticated, 403 without host:admin", async () => {
    const unauth = await handleAttachChannelVault(
      req("/api/channel-vaults", undefined, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      deps(),
    );
    expect(unauth.status).toBe(401);

    const weak = await bearerWith(["vault:existing:admin"]);
    const res = await handleAttachChannelVault(
      jsonReq("/api/channel-vaults", weak, "POST", { relay: RELAY, channel: CHANNEL }),
      deps(),
    );
    expect(res.status).toBe(403);
  });

  test("binds an installed vault, defaulting the name to ch-<first-8>", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleAttachChannelVault(
      jsonReq("/api/channel-vaults", bearer, "POST", { relay: RELAY, channel: CHANNEL }),
      deps(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      vault: string;
      mode: string;
      created: boolean;
      synced_at: string | null;
    };
    expect(body.vault).toBe("ch-3ff68a58");
    expect(body.mode).toBe("sync");
    expect(body.created).toBe(true);
    // Nothing has synced yet — this PR grants nobody anything.
    expect(body.synced_at).toBeNull();
    expect(getChannelVault(h.db, RELAY, CHANNEL)?.vault).toBe("ch-3ff68a58");
  });

  test("attaching twice with the same vault is an idempotent 200 no-op", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const first = await handleAttachChannelVault(
      jsonReq("/api/channel-vaults", bearer, "POST", { relay: RELAY, channel: CHANNEL }),
      deps(),
    );
    expect(first.status).toBe(201);
    const created = (await first.json()) as { created_at: string };

    const second = await handleAttachChannelVault(
      jsonReq("/api/channel-vaults", bearer, "POST", { relay: RELAY, channel: CHANNEL }),
      deps(),
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      created: boolean;
      vault: string;
      created_at: string;
    };
    expect(body.created).toBe(false);
    expect(body.vault).toBe("ch-3ff68a58");
    // The no-op really is a no-op: the original row is untouched.
    expect(body.created_at).toBe(created.created_at);
    expect(h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM channel_vaults").get()?.n).toBe(
      1,
    );
  });

  test("409 when the channel is already attached to a DIFFERENT vault", async () => {
    upsertChannelVault(h.db, { relayHost: RELAY, channelId: CHANNEL, vault: "existing" });
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleAttachChannelVault(
      jsonReq("/api/channel-vaults", bearer, "POST", {
        relay: RELAY,
        channel: CHANNEL,
        vault: "ch-3ff68a58",
      }),
      deps(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("already_bound");
    // Never a silent rebind — the operator has to detach first.
    expect(getChannelVault(h.db, RELAY, CHANNEL)?.vault).toBe("existing");
  });

  test("attaching to a vault that is not installed on this hub is a 400", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleAttachChannelVault(
      jsonReq("/api/channel-vaults", bearer, "POST", {
        relay: RELAY,
        channel: CHANNEL,
        vault: "not-installed",
      }),
      deps(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("vault_not_found");
    // Fail-closed: no binding pointing at a name that resolves to nothing.
    expect(getChannelVault(h.db, RELAY, CHANNEL)).toBeNull();
  });

  test("the relay is stored lower-cased and scheme-free", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleAttachChannelVault(
      jsonReq("/api/channel-vaults", bearer, "POST", {
        relay: `wss://${RELAY.toUpperCase()}/`,
        channel: CHANNEL,
        vault: "existing",
      }),
      deps(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { vault: string; relay_host: string };
    expect(body.vault).toBe("existing");
    expect(body.relay_host).toBe(RELAY);
    expect(getChannelVault(h.db, RELAY, CHANNEL)?.vault).toBe("existing");
  });

  test("400 on a bad relay, a bad channel, and an invalid vault name", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const bad = async (body: unknown) =>
      (await handleAttachChannelVault(jsonReq("/api/channel-vaults", bearer, "POST", body), deps()))
        .status;
    expect(await bad({ channel: CHANNEL })).toBe(400);
    expect(await bad({ relay: "wss://relay.example/path", channel: CHANNEL })).toBe(400);
    expect(await bad({ relay: RELAY, channel: "a/b" })).toBe(400);
    expect(await bad({ relay: RELAY, channel: CHANNEL, vault: "Not Valid" })).toBe(400);
    // `admin` is in RESERVED_VAULT_NAMES.
    expect(await bad({ relay: RELAY, channel: CHANNEL, vault: "admin" })).toBe(400);
  });

  test("400 without a JSON content-type", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleAttachChannelVault(
      req("/api/channel-vaults", bearer, { method: "POST", body: "not json" }),
      deps(),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /api/channel-vaults — list", () => {
  test("403 without host:admin", async () => {
    const bearer = await bearerWith(["vault:existing:read"]);
    const res = await handleListChannelVaults(req("/api/channel-vaults", bearer), deps());
    expect(res.status).toBe(403);
  });

  test("lists every binding, ordered, with an optional ?vault= filter", async () => {
    upsertChannelVault(h.db, { relayHost: "b.example", channelId: "c2", vault: "shared" });
    upsertChannelVault(h.db, { relayHost: "a.example", channelId: "c1", vault: "shared" });
    upsertChannelVault(h.db, { relayHost: "a.example", channelId: "c9", vault: "solo" });
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);

    const all = await handleListChannelVaults(req("/api/channel-vaults", bearer), deps());
    expect(all.status).toBe(200);
    const body = (await all.json()) as {
      channel_vaults: Array<{ relay_host: string; channel_id: string; vault: string }>;
    };
    expect(body.channel_vaults.map((r) => `${r.relay_host}/${r.channel_id}`)).toEqual([
      "a.example/c1",
      "a.example/c9",
      "b.example/c2",
    ]);

    const filtered = await handleListChannelVaults(
      req("/api/channel-vaults?vault=shared", bearer),
      deps(),
    );
    const fbody = (await filtered.json()) as { channel_vaults: Array<{ channel_id: string }> };
    expect(fbody.channel_vaults.map((r) => r.channel_id)).toEqual(["c1", "c2"]);
  });
});

describe("DELETE /api/channel-vaults — detach", () => {
  test("403 without host:admin", async () => {
    const bearer = await bearerWith(["vault:existing:admin"]);
    const res = await handleDetachChannelVault(
      req(`/api/channel-vaults?relay=${RELAY}&channel=${CHANNEL}`, bearer, { method: "DELETE" }),
      deps(),
    );
    expect(res.status).toBe(403);
  });

  test("removes the binding and reports the vault it pointed at", async () => {
    upsertChannelVault(h.db, { relayHost: RELAY, channelId: CHANNEL, vault: "existing" });
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleDetachChannelVault(
      req(`/api/channel-vaults?relay=${RELAY}&channel=${CHANNEL}`, bearer, { method: "DELETE" }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: true, vault: "existing" });
    expect(getChannelVault(h.db, RELAY, CHANNEL)).toBeNull();
  });

  test("detaching an unbound channel is a 200 no-op", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleDetachChannelVault(
      req(`/api/channel-vaults?relay=${RELAY}&channel=${CHANNEL}`, bearer, { method: "DELETE" }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: false, vault: null });
  });
});

describe("POST /api/channel-vaults/sync — one reconcile pass on demand", () => {
  /** A pass that reports one ok binding, without touching a relay. */
  function fakeRun(calls: number[]) {
    return async () => {
      calls.push(1);
      return {
        ran: true,
        bindings: [
          {
            relayHost: RELAY,
            channelId: CHANNEL,
            vault: "existing",
            status: "ok" as const,
            members: 2,
            granted: 1,
            removed: 1,
            createdUsers: 1,
            unchanged: 1,
            deferred: 0,
            errors: 0,
          },
        ],
      };
    };
  }

  test("405 on anything but POST", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleSyncChannelVaults(req("/api/channel-vaults/sync", bearer), deps());
    expect(res.status).toBe(405);
  });

  test("401 unauthenticated, 403 without host:admin — this route WRITES grants", async () => {
    const calls: number[] = [];
    const d = { ...deps(), runReconcile: fakeRun(calls) };
    const anon = await handleSyncChannelVaults(
      req("/api/channel-vaults/sync", undefined, { method: "POST" }),
      d,
    );
    expect(anon.status).toBe(401);

    const bearer = await bearerWith(["vault:existing:admin"]);
    const res = await handleSyncChannelVaults(
      req("/api/channel-vaults/sync", bearer, { method: "POST" }),
      d,
    );
    expect(res.status).toBe(403);
    // The gate is checked BEFORE any reconcile runs.
    expect(calls).toHaveLength(0);
  });

  test("host:admin gets per-binding counts", async () => {
    const calls: number[] = [];
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    const res = await handleSyncChannelVaults(
      req("/api/channel-vaults/sync", bearer, { method: "POST" }),
      { ...deps(), runReconcile: fakeRun(calls) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      ran: true,
      results: [
        {
          relay_host: RELAY,
          channel_id: CHANNEL,
          vault: "existing",
          status: "ok",
          members: 2,
          granted: 1,
          removed: 1,
          created_users: 1,
          unchanged: 1,
          deferred: 0,
          errors: 0,
        },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  test("a hub with no reader key answers ran:false with a reason, not an error", async () => {
    const bearer = await bearerWith([HOST_ADMIN_SCOPE]);
    // No `runReconcile` override: the REAL pass runs, and a test hub has no
    // Buzz reader key, which is exactly the state being asserted.
    const res = await handleSyncChannelVaults(
      req("/api/channel-vaults/sync", bearer, { method: "POST" }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ran: false, reason: "not_configured", results: [] });
  });
});
