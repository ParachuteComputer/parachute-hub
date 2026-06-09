/**
 * Tests for the general Connections engine (2026-06-09 modular-UI architecture,
 * P5) — `GET /api/connections/catalog`, `GET/POST /admin/connections`,
 * `DELETE /admin/connections/:id`.
 *
 * The catalog is built from injected module manifests. The vault + channel HTTP
 * calls are mocked via an injectable `fetchImpl` that records every request
 * (method, URL, decoded bearer, parsed body) and returns scripted responses.
 * Tokens are real (minted by the actual `signAccessToken`), so we can decode the
 * JWT claims (scope/aud) the way channel/vault would.
 *
 * The whole point of the engine is GENERALITY: the webhook + scope come from the
 * SINK ACTION's declaration, not hardcoded per module. The tests assert that —
 * e.g. a synthetic sink module ("widget") with a different endpoint/scope
 * provisions a trigger with THAT endpoint + THAT scope.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import {
  type ConnectionsDeps,
  type InstalledModuleInfo,
  buildCatalog,
  buildWebhook,
  eventsForSourceEvent,
  handleConnections,
  handleConnectionsCatalog,
  whenFromFilter,
} from "../admin-connections.ts";
import { readConnections } from "../connections-store.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { type ModuleManifest, validateModuleManifest } from "../module-manifest.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const HUB_ORIGIN = "https://hub.test";
const CHANNEL_ORIGIN = "http://127.0.0.1:1941";
const VAULT_ORIGIN = "http://127.0.0.1:1940";

interface Harness {
  db: Database;
  storePath: string;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-connections-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  return {
    db,
    storePath: join(dir, "connections.json"),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.cleanup();
});

async function adminCookie(): Promise<{ cookie: string; userId: string }> {
  const user = await createUser(harness.db, "operator", "hunter2");
  const session = createSession(harness.db, { userId: user.id });
  return {
    cookie: buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000)),
    userId: user.id,
  };
}

async function friendCookie(): Promise<string> {
  await createUser(harness.db, "admin", "admin-passphrase");
  const friend = await createUser(harness.db, "alice", "alice-passphrase", { allowMulti: true });
  const session = createSession(harness.db, { userId: friend.id });
  return buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
}

// --- Mock fetch -------------------------------------------------------------

interface RecordedReq {
  method: string;
  url: string;
  bearer: string | null;
  body: unknown;
}
type Responder = (req: RecordedReq) => Response;

function mockFetch(routes: Record<string, Responder>): {
  fetchImpl: typeof fetch;
  calls: RecordedReq[];
} {
  const calls: RecordedReq[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const auth =
      (init?.headers as Record<string, string> | undefined)?.authorization ??
      (init?.headers as Record<string, string> | undefined)?.Authorization ??
      null;
    const bearer = auth ? auth.replace(/^Bearer\s+/i, "") : null;
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const path = new URL(url).pathname;
    const rec: RecordedReq = { method, url, bearer, body };
    calls.push(rec);
    const responder = routes[`${method} ${path}`];
    if (!responder) return new Response("no route", { status: 599 });
    return responder(rec);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function ok(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function scopeOf(jwt: string): string[] {
  const claims = decodeJwt(jwt) as { scope?: string };
  return (claims.scope ?? "").split(/\s+/).filter(Boolean);
}

// --- Module fixtures --------------------------------------------------------

const VAULT_MANIFEST: ModuleManifest = {
  name: "vault",
  manifestName: "@openparachute/vault",
  port: 1940,
  paths: ["/vault"],
  health: "/health",
  events: [
    {
      key: "note.created",
      title: "A note was created",
      filterSchema: { type: "object", properties: { tags: { type: "array" } } },
    },
    { key: "note.updated", title: "A note was updated" },
    // A declared event with NO vault-trigger verb mapping — used to exercise
    // the clean `unsupported_event` 400 (vs a downstream 500).
    { key: "note.deleted", title: "A note was deleted" },
  ],
  actions: [{ key: "note.create", title: "Create a note", inputSchema: {} }],
};

const CHANNEL_MANIFEST: ModuleManifest = {
  name: "channel",
  manifestName: "parachute-channel",
  port: 1941,
  paths: ["/channel"],
  health: "/health",
  events: [{ key: "message.received", title: "A message arrived" }],
  actions: [
    {
      key: "message.deliver",
      title: "Deliver an inbound message",
      endpoint: "/api/vault/inbound",
      scope: "channel:send",
      provision: { type: "vault-trigger" },
    },
  ],
};

/** A synthetic sink module that proves the engine is NOT channel-hardcoded. */
const WIDGET_MANIFEST: ModuleManifest = {
  name: "widget",
  manifestName: "widget",
  port: 1955,
  paths: ["/widget"],
  health: "/health",
  actions: [
    {
      key: "thing.do",
      title: "Do a thing",
      endpoint: "/hooks/incoming",
      scope: "widget:trigger",
      provision: { type: "vault-trigger" },
    },
  ],
};

function modulesOf(...manifests: ModuleManifest[]): InstalledModuleInfo[] {
  return manifests.map((manifest) => ({
    short: manifest.name,
    manifest,
    mount: manifest.paths[0] ?? null,
  }));
}

function baseDeps(fetchImpl: typeof fetch, modules: InstalledModuleInfo[]): ConnectionsDeps {
  return {
    db: harness.db,
    hubOrigin: HUB_ORIGIN,
    modules,
    resolveVaultOrigin: (v) => (v === "default" ? VAULT_ORIGIN : null),
    channelOrigin: CHANNEL_ORIGIN,
    storePath: harness.storePath,
    fetchImpl,
  };
}

// ===========================================================================
// Pure derivation units
// ===========================================================================

describe("derivation units", () => {
  test("eventsForSourceEvent maps note.created/updated to vault verbs", () => {
    expect(eventsForSourceEvent("note.created")).toEqual(["created"]);
    expect(eventsForSourceEvent("note.updated")).toEqual(["updated"]);
  });

  test("eventsForSourceEvent throws (not a silent fallback) on an unmappable event", () => {
    // note.deleted is a real vault event but has no trigger verb — fail loud.
    expect(() => eventsForSourceEvent("note.deleted")).toThrow(/no vault-trigger event mapping/);
    expect(() => eventsForSourceEvent("bogus")).toThrow();
  });

  test("whenFromFilter maps filter keys 1:1 to the trigger predicate", () => {
    expect(
      whenFromFilter({
        tags: ["#channel-message/inbound"],
        has_metadata: ["channel"],
        missing_metadata: ["channel_inbound_rendered_at"],
        has_content: true,
        ignored: "x",
      }),
    ).toEqual({
      tags: ["#channel-message/inbound"],
      has_metadata: ["channel"],
      missing_metadata: ["channel_inbound_rendered_at"],
      has_content: true,
    });
    expect(whenFromFilter(undefined)).toEqual({});
  });

  test("buildWebhook joins origin + mount + endpoint, trimming slashes", () => {
    expect(buildWebhook(`${HUB_ORIGIN}/`, "/channel", "/api/vault/inbound")).toBe(
      `${HUB_ORIGIN}/channel/api/vault/inbound`,
    );
    expect(buildWebhook(HUB_ORIGIN, "widget", "hooks/incoming")).toBe(
      `${HUB_ORIGIN}/widget/hooks/incoming`,
    );
  });
});

// ===========================================================================
// Catalog
// ===========================================================================

describe("GET /api/connections/catalog", () => {
  test("returns events + actions read from installed module manifests", () => {
    const cat = buildCatalog(modulesOf(VAULT_MANIFEST, CHANNEL_MANIFEST));
    expect(cat.events).toContainEqual({
      module: "vault",
      key: "note.created",
      title: "A note was created",
      filterSchema: { type: "object", properties: { tags: { type: "array" } } },
    });
    expect(cat.actions).toContainEqual({
      module: "channel",
      key: "message.deliver",
      title: "Deliver an inbound message",
      inputSchema: null,
      provision: { type: "vault-trigger" },
    });
  });

  test("catalog endpoint is operator-gated (401 with no session)", async () => {
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/api/connections/catalog`);
    const res = await handleConnectionsCatalog(req, baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST)));
    expect(res.status).toBe(401);
  });

  test("catalog endpoint returns the catalog for an admin", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/api/connections/catalog`, { headers: { cookie } });
    const res = await handleConnectionsCatalog(
      req,
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, CHANNEL_MANIFEST)),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { events: unknown[]; actions: unknown[] };
    // vault: 3 events + 1 action; channel: 1 event + 1 action.
    expect(out.events.length).toBe(4);
    expect(out.actions.length).toBe(2);
  });
});

// ===========================================================================
// Operator gate
// ===========================================================================

describe("operator gate", () => {
  test("401 with no session cookie", async () => {
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const res = await handleConnections(req, "", baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST)));
    expect(res.status).toBe(401);
  });

  test("403 for a non-first-admin (friend)", async () => {
    const cookie = await friendCookie();
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({}),
    });
    const res = await handleConnections(req, "", baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST)));
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// POST — validation
// ===========================================================================

describe("POST /admin/connections — validation", () => {
  test("400 on unknown event", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        source: { module: "vault", vault: "default", event: "note.imaginary" },
        sink: { module: "channel", action: "message.deliver" },
      }),
    });
    const res = await handleConnections(
      req,
      "",
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, CHANNEL_MANIFEST)),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_event");
    expect(calls.length).toBe(0);
  });

  test("400 unsupported_event on a declared-but-unmappable event (note.deleted)", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        // note.deleted IS a declared vault event (passes the catalog check) but
        // has no vault-trigger verb → clean 400, no downstream provisioning.
        source: { module: "vault", vault: "default", event: "note.deleted" },
        sink: { module: "widget", action: "thing.do" },
      }),
    });
    const res = await handleConnections(
      req,
      "",
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, WIDGET_MANIFEST)),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unsupported_event");
    expect(calls.length).toBe(0);
  });

  test("400 on unknown action", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        source: { module: "vault", vault: "default", event: "note.created" },
        sink: { module: "channel", action: "message.imaginary" },
      }),
    });
    const res = await handleConnections(
      req,
      "",
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, CHANNEL_MANIFEST)),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_action");
  });

  test("400 on unknown vault", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        source: { module: "vault", vault: "ghost", event: "note.created" },
        sink: { module: "widget", action: "thing.do" },
      }),
    });
    const res = await handleConnections(
      req,
      "",
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, WIDGET_MANIFEST)),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_vault");
  });
});

// ===========================================================================
// POST — GENERAL provision (synthetic widget sink — proves no channel-hardcoding)
// ===========================================================================

describe("POST /admin/connections — general vault-trigger provision", () => {
  test("derives webhook + scope from the SINK ACTION declaration (not hardcoded)", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({
      "POST /vault/default/api/triggers": () => ok({ ok: true }),
    });
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        id: "w1",
        source: {
          module: "vault",
          vault: "default",
          event: "note.updated",
          filter: { tags: ["#urgent"], has_metadata: ["owner"] },
        },
        sink: { module: "widget", action: "thing.do" },
      }),
    });
    const res = await handleConnections(
      req,
      "",
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, WIDGET_MANIFEST)),
    );
    expect(res.status).toBe(200);

    const trigCall = calls.find((c) => c.url.endsWith("/vault/default/api/triggers"));
    expect(trigCall).toBeDefined();
    const trig = trigCall!.body as {
      name: string;
      events: string[];
      when: Record<string, unknown>;
      action: { webhook: string; auth: { bearer: string } };
    };
    // Webhook comes from widget's mount + the action's declared endpoint.
    expect(trig.action.webhook).toBe(`${HUB_ORIGIN}/widget/hooks/incoming`);
    // The persisted bearer carries the action's DECLARED scope (widget:trigger),
    // with the audience taken from the scope namespace.
    expect(scopeOf(trig.action.auth.bearer)).toEqual(["widget:trigger"]);
    expect((decodeJwt(trig.action.auth.bearer) as { aud?: string }).aud).toBe("widget");
    // events from the source event verb; when from the filter, 1:1.
    expect(trig.events).toEqual(["updated"]);
    expect(trig.when).toEqual({ tags: ["#urgent"], has_metadata: ["owner"] });
    expect(trig.name).toBe("conn_w1");
    // The trigger-register Authorization bearer is vault:default:admin.
    expect(scopeOf(trigCall!.bearer!)).toEqual(["vault:default:admin"]);

    // Persisted record carries the provisioned trigger name + vault for teardown.
    const stored = readConnections(harness.storePath);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe("w1");
    expect(stored[0]!.provisioned.triggerName).toBe("conn_w1");
    expect(stored[0]!.provisioned.vault).toBe("default");
    // Bearer tokens are NEVER persisted in the record.
    expect(JSON.stringify(stored[0])).not.toContain(trig.action.auth.bearer);
  });

  test("a failing vault-trigger step → 502 provision_failed naming the step", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({
      "POST /vault/default/api/triggers": () => new Response("boom", { status: 500 }),
    });
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        id: "w1",
        source: { module: "vault", vault: "default", event: "note.created" },
        sink: { module: "widget", action: "thing.do" },
      }),
    });
    const res = await handleConnections(
      req,
      "",
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, WIDGET_MANIFEST)),
    );
    expect(res.status).toBe(502);
    const out = (await res.json()) as { error: string; step: string };
    expect(out.error).toBe("provision_failed");
    expect(out.step).toBe("vault_trigger");
    // Nothing persisted on failure.
    expect(readConnections(harness.storePath)).toHaveLength(0);
  });

  test("a module CANNOT declare a cross-namespace action.scope → no escalating bearer (M1)", () => {
    // The webhook bearer is minted at the sink action's DECLARED scope. The only
    // defense against a malicious module declaring `vault:default:admin` and
    // tricking the hub into minting a 90-day cross-module token is the manifest
    // validator's namespace rule — so a manifest carrying such a scope can never
    // reach the engine in the first place. Prove it's rejected at the boundary.
    expect(() =>
      validateModuleManifest(
        {
          name: "widget",
          manifestName: "widget",
          port: 1955,
          paths: ["/widget"],
          health: "/health",
          actions: [
            {
              key: "thing.do",
              title: "Do",
              endpoint: "/hooks/incoming",
              scope: "vault:default:admin", // ← escalation attempt
              provision: { type: "vault-trigger" },
            },
          ],
        },
        "widget/.parachute/module.json",
      ),
    ).toThrow(/namespace "vault" does not match module name "widget"/);
    // The legitimate widget (own-namespace scope) parses fine, and THAT is what
    // the engine mints from — verified end-to-end in the provision test above
    // (bearer carries `widget:trigger`, never a vault scope).
    const okm = validateModuleManifest(
      {
        name: "widget",
        manifestName: "widget",
        port: 1955,
        paths: ["/widget"],
        health: "/health",
        actions: [
          { key: "thing.do", title: "Do", endpoint: "/hooks/incoming", scope: "widget:trigger" },
        ],
      },
      "widget/.parachute/module.json",
    );
    expect(okm.actions?.[0]?.scope).toBe("widget:trigger");
  });
});

// ===========================================================================
// POST — channel-backed connection (parity with hub#624)
// ===========================================================================

describe("POST /admin/connections — channel-backed (the #624 flow as a connection)", () => {
  test("provisions channel config + trigger, returns connect lines", async () => {
    const { cookie, userId } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({
      "POST /api/channels": () => ok({ ok: true, name: "eng", transport: "vault" }),
      "POST /vault/default/api/triggers": () => ok({ ok: true }),
    });
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        source: {
          module: "vault",
          vault: "default",
          event: "note.created",
          filter: {
            tags: ["#channel-message/inbound"],
            has_metadata: ["channel"],
            missing_metadata: ["channel_inbound_rendered_at"],
          },
        },
        sink: { module: "channel", action: "message.deliver", params: { channel: "eng" } },
      }),
    });
    const res = await handleConnections(
      req,
      "",
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, CHANNEL_MANIFEST)),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      ok: boolean;
      connection: { id: string };
      connect?: { mcpAdd: string; launch: string };
    };
    expect(out.ok).toBe(true);
    // Derived channel id.
    expect(out.connection.id).toBe("channel-eng");
    // Connect lines (parity with #624).
    expect(out.connect?.mcpAdd).toBe(
      `claude mcp add --transport http --scope user channel-eng ${HUB_ORIGIN}/channel/mcp/eng`,
    );
    expect(out.connect?.launch).toContain("server:channel-eng");

    // Channel config POST: vault transport, loopback vaultUrl, real
    // vault:default:write token, NO webhookSecret.
    const cfgCall = calls.find((c) => c.url.endsWith("/api/channels"));
    expect(cfgCall).toBeDefined();
    const cfgBody = cfgCall!.body as {
      name: string;
      transport: string;
      config: { vault: string; vaultUrl: string; token: string; webhookSecret?: string };
    };
    expect(cfgBody.name).toBe("eng");
    expect(cfgBody.config.vaultUrl).toBe(VAULT_ORIGIN);
    expect(cfgBody.config).not.toHaveProperty("webhookSecret");
    expect(scopeOf(cfgCall!.bearer!)).toEqual(["channel:admin"]);
    expect(scopeOf(cfgBody.config.token)).toEqual(["vault:default:write"]);

    // Trigger: webhook from channel mount + message.deliver endpoint; bearer
    // carries channel:send; predicate from the filter.
    const trigCall = calls.find((c) => c.url.endsWith("/vault/default/api/triggers"));
    const trig = trigCall!.body as {
      name: string;
      when: Record<string, unknown>;
      action: { webhook: string; auth: { bearer: string } };
    };
    expect(trig.action.webhook).toBe(`${HUB_ORIGIN}/channel/api/vault/inbound`);
    expect(scopeOf(trig.action.auth.bearer)).toEqual(["channel:send"]);
    expect((decodeJwt(trig.action.auth.bearer) as { aud?: string }).aud).toBe("channel");
    expect(trig.when).toEqual({
      tags: ["#channel-message/inbound"],
      has_metadata: ["channel"],
      missing_metadata: ["channel_inbound_rendered_at"],
    });
    expect(trig.name).toBe("conn_channel-eng");

    // sub = the operator on every minted token.
    expect((decodeJwt(cfgBody.config.token) as { sub?: string }).sub).toBe(userId);
    // No tokens echoed in the response.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(cfgBody.config.token);
    expect(serialized).not.toContain(trig.action.auth.bearer);
  });

  test("503 when the channel module is not installed (channelOrigin null)", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({});
    const deps = {
      ...baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, CHANNEL_MANIFEST)),
      channelOrigin: null,
    };
    const req = new Request(`${HUB_ORIGIN}/admin/connections`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        source: { module: "vault", vault: "default", event: "note.created" },
        sink: { module: "channel", action: "message.deliver", params: { channel: "eng" } },
      }),
    });
    const res = await handleConnections(req, "", deps);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("channel_unavailable");
  });
});

// ===========================================================================
// GET — list
// ===========================================================================

describe("GET /admin/connections — list", () => {
  test("lists persisted connections; never a token", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({
      "POST /vault/default/api/triggers": () => ok({ ok: true }),
    });
    const deps = baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, WIDGET_MANIFEST));
    // Create one.
    await handleConnections(
      new Request(`${HUB_ORIGIN}/admin/connections`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          id: "w1",
          source: { module: "vault", vault: "default", event: "note.created" },
          sink: { module: "widget", action: "thing.do" },
        }),
      }),
      "",
      deps,
    );
    const res = await handleConnections(
      new Request(`${HUB_ORIGIN}/admin/connections`, { method: "GET", headers: { cookie } }),
      "",
      deps,
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      ok: boolean;
      connections: Array<{ id: string; source: unknown; sink: unknown }>;
    };
    expect(out.ok).toBe(true);
    expect(out.connections).toHaveLength(1);
    expect(out.connections[0]!.id).toBe("w1");
    expect(JSON.stringify(out)).not.toContain("eyJ"); // no JWT
  });
});

// ===========================================================================
// DELETE — teardown
// ===========================================================================

describe("DELETE /admin/connections/:id — teardown", () => {
  test("tears down the vault trigger + removes the record", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({
      "POST /vault/default/api/triggers": () => ok({ ok: true }),
      "DELETE /vault/default/api/triggers/conn_w1": () => ok({ ok: true }),
    });
    const deps = baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, WIDGET_MANIFEST));
    await handleConnections(
      new Request(`${HUB_ORIGIN}/admin/connections`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          id: "w1",
          source: { module: "vault", vault: "default", event: "note.created" },
          sink: { module: "widget", action: "thing.do" },
        }),
      }),
      "",
      deps,
    );
    expect(readConnections(harness.storePath)).toHaveLength(1);

    const res = await handleConnections(
      new Request(`${HUB_ORIGIN}/admin/connections/w1`, { method: "DELETE", headers: { cookie } }),
      "/w1",
      deps,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const trigDel = calls.find(
      (c) => c.method === "DELETE" && c.url.endsWith("/vault/default/api/triggers/conn_w1"),
    );
    expect(trigDel).toBeDefined();
    expect(scopeOf(trigDel!.bearer!)).toEqual(["vault:default:admin"]);
    // Record gone.
    expect(readConnections(harness.storePath)).toHaveLength(0);
  });

  test("channel-sink teardown also removes the channel config entry", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({
      "POST /api/channels": () => ok({ ok: true }),
      "POST /vault/default/api/triggers": () => ok({ ok: true }),
      "DELETE /api/channels/eng": () => ok({ ok: true }),
      "DELETE /vault/default/api/triggers/conn_channel-eng": () => ok({ ok: true }),
    });
    const deps = baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST, CHANNEL_MANIFEST));
    await handleConnections(
      new Request(`${HUB_ORIGIN}/admin/connections`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({
          source: { module: "vault", vault: "default", event: "note.created" },
          sink: { module: "channel", action: "message.deliver", params: { channel: "eng" } },
        }),
      }),
      "",
      deps,
    );
    const res = await handleConnections(
      new Request(`${HUB_ORIGIN}/admin/connections/channel-eng`, {
        method: "DELETE",
        headers: { cookie },
      }),
      "/channel-eng",
      deps,
    );
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/channels/eng"))).toBe(
      true,
    );
    expect(
      calls.some(
        (c) =>
          c.method === "DELETE" && c.url.endsWith("/vault/default/api/triggers/conn_channel-eng"),
      ),
    ).toBe(true);
  });

  test("404 deleting an unknown connection", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({});
    const res = await handleConnections(
      new Request(`${HUB_ORIGIN}/admin/connections/ghost`, {
        method: "DELETE",
        headers: { cookie },
      }),
      "/ghost",
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST)),
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Method guard
// ===========================================================================

describe("method guard", () => {
  test("405 on PUT /admin/connections", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({});
    const res = await handleConnections(
      new Request(`${HUB_ORIGIN}/admin/connections`, { method: "PUT", headers: { cookie } }),
      "",
      baseDeps(fetchImpl, modulesOf(VAULT_MANIFEST)),
    );
    expect(res.status).toBe(405);
  });
});
