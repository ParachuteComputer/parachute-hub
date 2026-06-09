/**
 * Tests for `POST/GET/DELETE /admin/channels` — one-action vault-channel
 * provisioning (frictionless channel setup PR 3).
 *
 * The channel + vault HTTP calls are mocked via an injectable `fetchImpl` that
 * records every request (method, URL, decoded Authorization bearer, parsed
 * JSON body) and returns scripted responses. Tokens are real (minted by the
 * actual `signAccessToken` against a real signing key), so we can decode the
 * JWT claims (scope/aud/vault_scope) the way channel/vault would.
 *
 * Coverage:
 *   - 401 with no/invalid session cookie (operator gate).
 *   - 403 for a signed-in non-first-admin (friend).
 *   - happy path provisions all three: asserts the channel-config POST body, the
 *     trigger POST body (incl. action.auth.bearer + substituted webhook URL +
 *     substituted name), and the returned connect lines.
 *   - unknown vault → 400.
 *   - a failing downstream step → clear `provision_failed` error naming the step.
 *   - idempotent re-POST (channel replace + trigger upsert succeed again).
 *   - GET lists (never tokens).
 *   - DELETE tears down both sides.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { type ChannelsDeps, handleChannels, substituteTrigger } from "../admin-channels.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "../sessions.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const HUB_ORIGIN = "https://hub.test";
const CHANNEL_ORIGIN = "http://127.0.0.1:1941";
const VAULT_ORIGIN = "http://127.0.0.1:1940";

interface Harness {
  db: Database;
  cleanup: () => void;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "phub-admin-channels-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  return {
    db,
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

// ---------------------------------------------------------------------------
// Mock fetch — records requests, returns scripted responses by (method, path).
// ---------------------------------------------------------------------------

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
    let body: unknown = undefined;
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
    const key = `${method} ${path}`;
    const responder = routes[key];
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

/** The channel's prescribed trigger template (mirrors CHANNEL_VAULT_TRIGGER_TEMPLATE). */
const TRIGGER_TEMPLATE = {
  name: "channel_inbound_<channel>",
  events: ["created"],
  when: {
    tags: ["#channel-message/inbound"],
    has_metadata: ["channel"],
    missing_metadata: ["channel_inbound_rendered_at"],
  },
  action: {
    webhook: "<hub-origin>/channel/api/vault/inbound",
    send: "json",
  },
};

function baseDeps(fetchImpl: typeof fetch): ChannelsDeps {
  return {
    db: harness.db,
    hubOrigin: HUB_ORIGIN,
    channelOrigin: CHANNEL_ORIGIN,
    resolveVaultOrigin: (v) => (v === "default" ? VAULT_ORIGIN : null),
    fetchImpl,
  };
}

function scopeOf(jwt: string): string[] {
  const claims = decodeJwt(jwt) as { scope?: string };
  return (claims.scope ?? "").split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Operator gate
// ---------------------------------------------------------------------------

describe("operator gate", () => {
  test("401 when no session cookie is present", async () => {
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "POST",
      body: JSON.stringify({ channelName: "eng", vault: "default" }),
    });
    const res = await handleChannels(req, "", baseDeps(fetchImpl));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
  });

  test("401 when the cookie is garbage (no matching session)", async () => {
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "POST",
      headers: { cookie: "parachute_hub_session=nope" },
      body: JSON.stringify({ channelName: "eng", vault: "default" }),
    });
    const res = await handleChannels(req, "", baseDeps(fetchImpl));
    expect(res.status).toBe(401);
  });

  test("403 for a signed-in non-first-admin (friend)", async () => {
    const cookie = await friendCookie();
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ channelName: "eng", vault: "default" }),
    });
    const res = await handleChannels(req, "", baseDeps(fetchImpl));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("not_admin");
  });
});

// ---------------------------------------------------------------------------
// POST — happy path
// ---------------------------------------------------------------------------

describe("POST /admin/channels — provision", () => {
  test("provisions all three: channel config body, trigger body, connect lines", async () => {
    const { cookie, userId } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({
      "POST /api/channels": () => ok({ ok: true, name: "eng", transport: "vault", live: true }),
      "GET /.parachute/config": () => ok({ channels: [], triggerTemplate: TRIGGER_TEMPLATE }),
      "POST /vault/default/api/triggers": () => ok({ ok: true, name: "channel_inbound_eng" }),
    });
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ channelName: "eng", vault: "default" }),
    });
    const res = await handleChannels(req, "", baseDeps(fetchImpl));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      ok: boolean;
      channel: string;
      vault: string;
      connect: { mcpAdd: string; launch: string };
    };
    expect(out.ok).toBe(true);
    expect(out.channel).toBe("eng");
    expect(out.vault).toBe("default");
    // Connect lines use the PUBLIC origin + the channel-prefixed MCP name.
    expect(out.connect.mcpAdd).toBe(
      `claude mcp add --transport http --scope user channel-eng ${HUB_ORIGIN}/channel/mcp/eng`,
    );
    expect(out.connect.launch).toBe(
      "claude --dangerously-load-development-channels=server:channel-eng --dangerously-skip-permissions",
    );

    // --- Channel config POST body: vault transport, loopback vaultUrl, a real
    // vault:default:write token, NO webhookSecret.
    const cfgCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/api/channels"));
    expect(cfgCall).toBeDefined();
    const cfgBody = cfgCall!.body as {
      name: string;
      transport: string;
      config: { vault: string; vaultUrl: string; token: string; webhookSecret?: string };
    };
    expect(cfgBody.name).toBe("eng");
    expect(cfgBody.transport).toBe("vault");
    expect(cfgBody.config.vault).toBe("default");
    expect(cfgBody.config.vaultUrl).toBe(VAULT_ORIGIN);
    expect(cfgBody.config).not.toHaveProperty("webhookSecret");
    // The config-write bearer carries channel:admin.
    expect(scopeOf(cfgCall!.bearer!)).toEqual(["channel:admin"]);
    // The embedded write token is a real vault:default:write JWT.
    expect(scopeOf(cfgBody.config.token)).toEqual(["vault:default:write"]);
    expect((decodeJwt(cfgBody.config.token) as { aud?: string }).aud).toBe("vault.default");

    // --- Trigger POST body: substituted name, substituted webhook, the
    // channel:send bearer in action.auth.bearer.
    const trigCall = calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/vault/default/api/triggers"),
    );
    expect(trigCall).toBeDefined();
    const trig = trigCall!.body as {
      name: string;
      when: Record<string, unknown>;
      action: { webhook: string; send?: string; auth?: { bearer?: string } };
    };
    expect(trig.name).toBe("channel_inbound_eng");
    expect(trig.action.webhook).toBe(`${HUB_ORIGIN}/channel/api/vault/inbound`);
    expect(trig.action.send).toBe("json"); // template field preserved
    expect(trig.action.auth?.bearer).toBeDefined();
    expect(scopeOf(trig.action.auth!.bearer!)).toEqual(["channel:send"]);
    expect((decodeJwt(trig.action.auth!.bearer!) as { aud?: string }).aud).toBe("channel");
    // The trigger-register bearer (Authorization header) carries vault:default:admin.
    expect(scopeOf(trigCall!.bearer!)).toEqual(["vault:default:admin"]);

    // Minted tokens are NEVER echoed in the response.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(cfgBody.config.token);
    expect(serialized).not.toContain(trig.action.auth!.bearer);

    // sub = the operator.
    expect((decodeJwt(cfgBody.config.token) as { sub?: string }).sub).toBe(userId);
  });

  test("unknown vault → 400", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ channelName: "eng", vault: "ghost" }),
    });
    const res = await handleChannels(req, "", baseDeps(fetchImpl));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_vault");
    // No downstream calls when the vault doesn't exist.
    expect(calls.length).toBe(0);
  });

  test("a failing downstream step → clear provision_failed naming the step", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({
      "POST /api/channels": () => new Response("boom", { status: 500 }),
    });
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ channelName: "eng", vault: "default" }),
    });
    const res = await handleChannels(req, "", baseDeps(fetchImpl));
    expect(res.status).toBe(502);
    const out = (await res.json()) as { error: string; step: string; error_description: string };
    expect(out.error).toBe("provision_failed");
    expect(out.step).toBe("channel_config");
    expect(out.error_description).toContain("channel_config");
  });

  test("invalid channelName → 400 before any downstream call", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ channelName: "bad name!", vault: "default" }),
    });
    const res = await handleChannels(req, "", baseDeps(fetchImpl));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    expect(calls.length).toBe(0);
  });

  test("idempotent re-POST completes again (channel replace + trigger upsert)", async () => {
    const { cookie } = await adminCookie();
    let channelPosts = 0;
    let triggerPosts = 0;
    const { fetchImpl } = mockFetch({
      "POST /api/channels": () => {
        channelPosts += 1;
        return ok({ ok: true, name: "eng", transport: "vault", live: true });
      },
      "GET /.parachute/config": () => ok({ channels: [], triggerTemplate: TRIGGER_TEMPLATE }),
      "POST /vault/default/api/triggers": () => {
        triggerPosts += 1;
        return ok({ ok: true, name: "channel_inbound_eng" });
      },
    });
    const deps = baseDeps(fetchImpl);
    const mkReq = () =>
      new Request(`${HUB_ORIGIN}/admin/channels`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ channelName: "eng", vault: "default" }),
      });
    expect((await handleChannels(mkReq(), "", deps)).status).toBe(200);
    expect((await handleChannels(mkReq(), "", deps)).status).toBe(200);
    expect(channelPosts).toBe(2);
    expect(triggerPosts).toBe(2);
  });

  test("503 when the channel module is not installed", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({});
    const deps = { ...baseDeps(fetchImpl), channelOrigin: null };
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ channelName: "eng", vault: "default" }),
    });
    const res = await handleChannels(req, "", deps);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("channel_unavailable");
  });
});

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

describe("GET /admin/channels — list", () => {
  test("proxies the channel listing; never tokens", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({
      "GET /api/channels": () =>
        ok({ channels: [{ name: "eng", transport: "vault", vault: "default" }] }),
    });
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "GET",
      headers: { cookie },
    });
    const res = await handleChannels(req, "", baseDeps(fetchImpl));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; channels: { channels: unknown[] } };
    expect(out.ok).toBe(true);
    // The list bearer is channel:admin; the channel GET never returns secrets.
    const getCall = calls.find((c) => c.method === "GET" && c.url.endsWith("/api/channels"));
    expect(scopeOf(getCall!.bearer!)).toEqual(["channel:admin"]);
    expect(JSON.stringify(out)).not.toContain("token");
    expect(JSON.stringify(out)).not.toContain("webhookSecret");
  });
});

// ---------------------------------------------------------------------------
// DELETE — teardown
// ---------------------------------------------------------------------------

describe("DELETE /admin/channels/:name — teardown", () => {
  test("tears down both the channel and the vault trigger", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl, calls } = mockFetch({
      // resolveChannelVault reads the listing to learn the bound vault.
      "GET /api/channels": () =>
        ok({ channels: [{ name: "eng", transport: "vault", vault: "default" }] }),
      "DELETE /api/channels/eng": () => ok({ ok: true }),
      "DELETE /vault/default/api/triggers/channel_inbound_eng": () => ok({ ok: true }),
    });
    const req = new Request(`${HUB_ORIGIN}/admin/channels/eng`, {
      method: "DELETE",
      headers: { cookie },
    });
    const res = await handleChannels(req, "/eng", baseDeps(fetchImpl));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const chanDel = calls.find((c) => c.method === "DELETE" && c.url.endsWith("/api/channels/eng"));
    expect(chanDel).toBeDefined();
    expect(scopeOf(chanDel!.bearer!)).toEqual(["channel:admin"]);

    const trigDel = calls.find(
      (c) =>
        c.method === "DELETE" && c.url.endsWith("/vault/default/api/triggers/channel_inbound_eng"),
    );
    expect(trigDel).toBeDefined();
    expect(scopeOf(trigDel!.bearer!)).toEqual(["vault:default:admin"]);
  });

  test("partial failure (vault trigger DELETE errors) → 207 with the failing step named", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({
      "GET /api/channels": () =>
        ok({ channels: [{ name: "eng", transport: "vault", vault: "default" }] }),
      "DELETE /api/channels/eng": () => ok({ ok: true }),
      "DELETE /vault/default/api/triggers/channel_inbound_eng": () =>
        new Response("nope", { status: 500 }),
    });
    const req = new Request(`${HUB_ORIGIN}/admin/channels/eng`, {
      method: "DELETE",
      headers: { cookie },
    });
    const res = await handleChannels(req, "/eng", baseDeps(fetchImpl));
    expect(res.status).toBe(207);
    const out = (await res.json()) as { ok: boolean; partial: boolean; errors: { step: string }[] };
    expect(out.ok).toBe(false);
    expect(out.partial).toBe(true);
    expect(out.errors.some((e) => e.step === "vault_trigger")).toBe(true);
  });

  test("404 from the channel DELETE is treated as already-gone (idempotent)", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({
      "GET /api/channels": () => ok({ channels: [] }), // not listed → vault unknown
      "DELETE /api/channels/eng": () => new Response("not found", { status: 404 }),
    });
    const req = new Request(`${HUB_ORIGIN}/admin/channels/eng`, {
      method: "DELETE",
      headers: { cookie },
    });
    const res = await handleChannels(req, "/eng", baseDeps(fetchImpl));
    // Channel side is fine (404 = gone); vault side can't resolve the bound
    // vault from an empty listing → reported as a partial.
    expect(res.status).toBe(207);
    const out = (await res.json()) as { errors: { step: string }[] };
    expect(out.errors.some((e) => e.step === "vault_trigger")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Method guard
// ---------------------------------------------------------------------------

describe("method guard", () => {
  test("405 on PUT /admin/channels", async () => {
    const { cookie } = await adminCookie();
    const { fetchImpl } = mockFetch({});
    const req = new Request(`${HUB_ORIGIN}/admin/channels`, {
      method: "PUT",
      headers: { cookie },
    });
    const res = await handleChannels(req, "", baseDeps(fetchImpl));
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// substituteTrigger — unit
// ---------------------------------------------------------------------------

describe("substituteTrigger", () => {
  test("substitutes <channel>/<hub-origin>, fills webhook + auth.bearer, trims origin slash", async () => {
    const out = substituteTrigger(TRIGGER_TEMPLATE, "eng", `${HUB_ORIGIN}/`, "SEND_BEARER");
    expect(out.name).toBe("channel_inbound_eng");
    expect(out.action.webhook).toBe(`${HUB_ORIGIN}/channel/api/vault/inbound`);
    expect(out.action.auth?.bearer).toBe("SEND_BEARER");
    expect(out.action.send).toBe("json");
    // when-clause is preserved untouched (no placeholders in it here).
    expect(out.when.tags).toEqual(["#channel-message/inbound"]);
  });
});
