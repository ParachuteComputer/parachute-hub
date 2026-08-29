import type { Database } from "bun:sqlite";
/**
 * Account-level MCP door (`/account/mcp`).
 *
 * Coverage:
 *   - transport-parity (Accept 406 / CT 415 / parse 400 / notifications 202 /
 *     GET 405 / DELETE 200 / initialize / ping / tools/list);
 *   - auth: missing, wrong Bearer scope, NIP-98 linked user, auto-provision;
 *   - coverage: Bearer/first-admin = all vaults; friend = assigned ∩ installed;
 *     auto-provisioned = empty; read-role still lists + queries;
 *   - create-vault: owner yes, friend no, no token in the tool result;
 *   - query-notes: fan-out attribution + one-vault failure isolation +
 *     vault_not_covered fail-closed; sort/include_content/order_by/offset
 *     forwarded to vault REST;
 *   - grant-access: grant-first creates a key-only user; one-row upsert;
 *     friend write can grant their vault, read cannot; owner unrestricted
 *     is a no-op; revoke leaves the user; list-access is pubkey-shaped;
 *   - create-note / update-note: vault required; write-audience mint;
 *     catalog-hidden below write; PATCH encodes path ids;
 *   - descriptor advertises account_mcp_endpoint (see account-api.test).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { handleAccountCapabilities } from "../account-api.ts";
import { accountMcpProtectedResource, handleAccountMcp } from "../account-mcp-http.ts";
import { ACCOUNT_MCP_TOOLS } from "../account-mcp.ts";
import { hubDbPath, openHubDb } from "../hub-db.ts";
import { signAccessToken } from "../jwt-sign.ts";
import { NOSTR_AUTH_KIND, type NostrEvent, nostrEventId } from "../nostr-event.ts";
import { NostrReplayCache } from "../nostr-http-auth.ts";
import { bindPubkeyFromHttpAuth, findPubkeyLink } from "../pubkey-links.ts";
import { upsertService } from "../services-manifest.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser, getUserById, vaultVerbsForUserVault } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";
const MCP_URL = `${ISSUER}/account/mcp`;
const BOTH_ACCEPT = "application/json, text/event-stream";
const HOST_ADMIN_SCOPE = "parachute:host:admin";
const ACCOUNT_WRITE_SCOPE = "account:self:write";
const ACCOUNT_READ_SCOPE = "account:self:read";
const ACCOUNT_VAULTS_SCOPE = "account:self:vaults";
const ACCOUNT_VAULTS_UNNARROWED = "account:vaults";

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

const OWNER_SECRET = hexToBytes("11".repeat(32));
const OWNER_PUBKEY = bytesToHex(schnorr.getPublicKey(OWNER_SECRET));
const FRIEND_SECRET = hexToBytes("22".repeat(32));
const FRIEND_PUBKEY = bytesToHex(schnorr.getPublicKey(FRIEND_SECRET));
const OTHER_SECRET = hexToBytes("33".repeat(32));
const OTHER_PUBKEY = bytesToHex(schnorr.getPublicKey(OTHER_SECRET));

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signEvent(
  secret: Uint8Array,
  parts: { created_at?: number; kind?: number; tags?: string[][]; content?: string },
): NostrEvent {
  const unsigned = {
    pubkey: bytesToHex(schnorr.getPublicKey(secret)),
    created_at: parts.created_at ?? Math.floor(Date.now() / 1000),
    kind: parts.kind ?? NOSTR_AUTH_KIND,
    tags: parts.tags ?? [],
    content: parts.content ?? "",
  };
  const id = nostrEventId(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secret));
  return { ...unsigned, id, sig };
}

function nostrHeader(event: NostrEvent): string {
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64url")}`;
}

function rpc(
  method: string,
  params?: Record<string, unknown>,
  id: number | string | null = 1,
): unknown {
  return { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
}

function vaultCreateJson(name: string): string {
  return JSON.stringify({
    name,
    token: `hubjwt.${name}.access`,
    paths: {
      vault_dir: `/home/test/.parachute/vault/${name}`,
      vault_db: `/home/test/.parachute/vault/${name}/vault.db`,
      vault_config: `/home/test/.parachute/vault/${name}/config.yaml`,
    },
    set_as_default: false,
  });
}

interface Harness {
  db: Database;
  dir: string;
  manifestPath: string;
  ownerId: string;
  friendId: string;
  replay: NostrReplayCache;
  cleanup: () => void;
}

async function makeHarness(vaultNames: string[] = ["beta", "personal"]): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "phub-account-mcp-"));
  const db = openHubDb(hubDbPath(dir));
  rotateSigningKey(db);
  const manifestPath = join(dir, "services.json");
  const paths = vaultNames.map((n) => `/vault/${n}`);
  writeFileSync(
    manifestPath,
    JSON.stringify({
      services: [
        { name: "parachute-vault", port: 4101, paths, health: "/health", version: "0.4.2" },
      ],
    }),
  );
  const owner = await createUser(db, "owner", "correct-horse-battery-staple", {
    passwordChanged: true,
  });
  const friend = await createUser(db, "alice", "correct-horse-battery-staple", {
    allowMulti: true,
    passwordChanged: true,
    assignedVaults: ["beta"],
  });
  const now = new Date();
  bindPubkeyFromHttpAuth(db, {
    userId: owner.id,
    pubkey: OWNER_PUBKEY,
    proofEvent: "{}",
    proofEventId: "a".repeat(64),
    label: "test",
    now,
  });
  bindPubkeyFromHttpAuth(db, {
    userId: friend.id,
    pubkey: FRIEND_PUBKEY,
    proofEvent: "{}",
    proofEventId: "b".repeat(64),
    label: "test",
    now,
  });
  return {
    db,
    dir,
    manifestPath,
    ownerId: owner.id,
    friendId: friend.id,
    replay: new NostrReplayCache(),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function bearer(h: Harness, scopes: string[], sub?: string): Promise<string> {
  const minted = await signAccessToken(h.db, {
    sub: sub ?? h.ownerId,
    scopes,
    audience: "account",
    clientId: "parachute-hub-spa",
    issuer: ISSUER,
    ttlSeconds: 600,
  });
  return minted.token;
}

function jwtScope(req: Request): string {
  const parts = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").split(".");
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString()) as {
      scope?: string;
    };
    return payload.scope ?? "";
  } catch {
    return "";
  }
}

function toolsForMintedScope(scope: string): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  const verb = scope.includes(":admin") ? "admin" : scope.includes(":write") ? "write" : "read";
  const read = [
    "query-notes",
    "list-tags",
    "find-path",
    "vault-info",
    "doctor",
    "request-attachment-download",
    "read-attachment",
  ];
  const write = [...read, "create-note", "update-note", "delete-note", "request-attachment-upload"];
  const admin = [
    ...write,
    "manage-token",
    "update-tag",
    "delete-tag",
    "rename-tag",
    "merge-tags",
    "prune-schema",
  ];
  const names = verb === "admin" ? admin : verb === "write" ? write : read;
  return names.map((name) => ({
    name,
    description: `${name} (vault MCP)`,
    inputSchema: {
      type: "object",
      properties:
        name === "query-notes"
          ? {
              search: { type: "string" },
              sort: { type: "string" },
              include_content: { type: "boolean" },
              order_by: { type: "string" },
              cursor: { type: "string" },
            }
          : {},
    },
  }));
}

function jsonRpcOk(value: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: 1, result: value });
}

function mcpTextResult(payload: unknown): Response {
  return jsonRpcOk({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
}

interface VaultMcpCall {
  url: string;
  method: string;
  rpc: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  scope: string;
  vault: string;
}

async function routeVaultMcp(
  input: string | URL | Request,
  init: RequestInit | undefined,
  hooks: {
    onList?: (call: VaultMcpCall) => unknown | Response | Promise<unknown | Response>;
    onCall?: (call: VaultMcpCall) => unknown | Response | Promise<unknown | Response>;
    onRequest?: (call: VaultMcpCall) => void;
  } = {},
): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = req.url;
  let rpc: VaultMcpCall["rpc"] = {};
  try {
    rpc = JSON.parse(await req.text()) as VaultMcpCall["rpc"];
  } catch {
    rpc = {};
  }
  const call: VaultMcpCall = {
    url,
    method: req.method,
    rpc,
    scope: jwtScope(req),
    vault: url.match(/\/vault\/([^/]+)\/mcp/)?.[1] ?? "",
  };
  hooks.onRequest?.(call);
  if (rpc.method === "tools/list") {
    const custom = await hooks.onList?.(call);
    if (custom instanceof Response) return custom;
    if (custom !== undefined) return jsonRpcOk(custom);
    return jsonRpcOk({ tools: toolsForMintedScope(call.scope) });
  }
  if (rpc.method === "tools/call") {
    const custom = await hooks.onCall?.(call);
    if (custom instanceof Response) return custom;
    if (custom !== undefined) {
      if (custom && typeof custom === "object" && "content" in custom) return jsonRpcOk(custom);
      return mcpTextResult(custom);
    }
    if (rpc.params?.name === "query-notes") return mcpTextResult([]);
    return mcpTextResult({ ok: true });
  }
  return new Response("not mcp", { status: 404 });
}

function mcpDeps(
  h: Harness,
  extra: {
    fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    runCommand?: (
      cmd: readonly string[],
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    autoProvisionEnv?: string;
  } = {},
) {
  return {
    db: h.db,
    issuer: ISSUER,
    manifestPath: h.manifestPath,
    replay: h.replay,
    fetchImpl: extra.fetchImpl ?? ((input, init) => routeVaultMcp(input, init)),
    ...(extra.runCommand ? { runCommand: extra.runCommand } : {}),
  };
}

function nostrReq(
  secret: Uint8Array,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Request {
  const encoded = JSON.stringify(body);
  const bytes = new TextEncoder().encode(encoded);
  const event = signEvent(secret, {
    content: `${Date.now()}-${Math.random()}`,
    tags: [
      ["u", MCP_URL],
      ["method", "POST"],
      ["payload", sha256Hex(bytes)],
    ],
  });
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      authorization: nostrHeader(event),
      accept: BOTH_ACCEPT,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: encoded,
  });
}

function bearerReq(token: string | null, body: unknown, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", BOTH_ACCEPT);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(MCP_URL, {
    method: "POST",
    ...init,
    headers,
    body: JSON.stringify(body),
  });
}

function parseTool(rpcBody: { result?: { content?: Array<{ text?: string }> } }): unknown {
  const text = rpcBody.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing tool text");
  expect(text).not.toMatch(/vault_token|"token":|eyJ/);
  return JSON.parse(text);
}

describe("account MCP — descriptor + PRM", () => {
  test("capabilities descriptor advertises account_mcp_endpoint", async () => {
    const h = await makeHarness();
    try {
      const res = handleAccountCapabilities(
        new Request(`${ISSUER}/.well-known/parachute-account`),
        {
          db: h.db,
          issuer: ISSUER,
        },
      );
      const body = (await res.json()) as { account_mcp_endpoint: string };
      expect(body.account_mcp_endpoint).toBe(MCP_URL);
    } finally {
      h.cleanup();
    }
  });

  test("PRM names the account-MCP resource and account:vaults", async () => {
    const res = accountMcpProtectedResource(ISSUER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(body.resource).toBe(MCP_URL);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual([ACCOUNT_VAULTS_UNNARROWED]);
  });
});

describe("account MCP — transport", () => {
  test("401 with no Authorization, RFC 9728 challenge", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(bearerReq(null, rpc("initialize")), mcpDeps(h));
      expect(res.status).toBe(401);
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain("resource_metadata=");
      expect(challenge).toContain("/.well-known/oauth-protected-resource/account/mcp");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    } finally {
      h.cleanup();
    }
  });

  test("403 Bearer without account-vaults or host:admin", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, ["vault:beta:read"]);
      const res = await handleAccountMcp(bearerReq(token, rpc("initialize")), mcpDeps(h));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("insufficient_scope");
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain(`scope="${ACCOUNT_VAULTS_UNNARROWED}"`);
    } finally {
      h.cleanup();
    }
  });

  test("403 Bearer account:self:read — REST read is not an MCP credential", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_READ_SCOPE]);
      const res = await handleAccountMcp(bearerReq(token, rpc("initialize")), mcpDeps(h));
      expect(res.status).toBe(403);
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain(`scope="${ACCOUNT_VAULTS_UNNARROWED}"`);
    } finally {
      h.cleanup();
    }
  });

  test("401 Bearer account-vaults with a vault audience", async () => {
    const h = await makeHarness();
    try {
      const minted = await signAccessToken(h.db, {
        sub: h.ownerId,
        scopes: [ACCOUNT_VAULTS_SCOPE],
        audience: "vault.beta",
        clientId: "parachute-hub-spa",
        issuer: ISSUER,
        ttlSeconds: 600,
      });
      const res = await handleAccountMcp(bearerReq(minted.token, rpc("initialize")), mcpDeps(h));
      expect(res.status).toBe(401);
    } finally {
      h.cleanup();
    }
  });

  test("406 unless Accept lists both json and event-stream", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const res = await handleAccountMcp(
        bearerReq(token, rpc("ping"), { headers: { accept: "application/json" } }),
        mcpDeps(h),
      );
      expect(res.status).toBe(406);
    } finally {
      h.cleanup();
    }
  });

  test("415 unless Content-Type is json", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const res = await handleAccountMcp(
        bearerReq(token, rpc("ping"), { headers: { "content-type": "text/plain" } }),
        mcpDeps(h),
      );
      expect(res.status).toBe(415);
    } finally {
      h.cleanup();
    }
  });

  test("GET is 405 after auth; DELETE is 200", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const get = await handleAccountMcp(
        new Request(MCP_URL, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        }),
        mcpDeps(h),
      );
      expect(get.status).toBe(405);
      const del = await handleAccountMcp(
        new Request(MCP_URL, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        }),
        mcpDeps(h),
      );
      expect(del.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("notification-only POST is 202", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const res = await handleAccountMcp(
        bearerReq(token, { jsonrpc: "2.0", method: "notifications/initialized" }),
        mcpDeps(h),
      );
      expect(res.status).toBe(202);
    } finally {
      h.cleanup();
    }
  });

  test("OPTIONS preflight is 204 with MCP headers", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(new Request(MCP_URL, { method: "OPTIONS" }), mcpDeps(h));
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-headers")).toContain("Mcp-Protocol-Version");
    } finally {
      h.cleanup();
    }
  });
});

describe("account MCP — initialize + tools", () => {
  test("Bearer account:self:vaults initializes and lists the account-MCP tools", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const init = await handleAccountMcp(
        bearerReq(token, rpc("initialize", { protocolVersion: "2025-11-25" })),
        mcpDeps(h),
      );
      expect(init.status).toBe(200);
      const initBody = (await init.json()) as {
        result: { serverInfo: { name: string }; protocolVersion: string; instructions?: string };
      };
      expect(initBody.result.serverInfo.name).toBe("parachute-account");
      expect(initBody.result.protocolVersion).toBe("2025-11-25");
      expect(initBody.result.instructions).toMatch(/union of what SOME covered vault/);

      const listed = await handleAccountMcp(bearerReq(token, rpc("tools/list")), mcpDeps(h));
      const listBody = (await listed.json()) as {
        result: {
          tools: Array<{
            name: string;
            description?: string;
            inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
          }>;
        };
      };
      const names = listBody.result.tools.map((t) => t.name);
      for (const n of ACCOUNT_MCP_TOOLS.map((t) => t.name)) expect(names).toContain(n);
      expect(names).toContain("query-notes");
      expect(names).toContain("create-note");
      expect(names).toContain("delete-note");
      expect(names).toContain("list-tags");
      expect(names).toContain("manage-token");
      expect(names[0]).toBe("list-vaults");
      const qn = listBody.result.tools.find((t) => t.name === "query-notes");
      expect(qn?.inputSchema?.properties).toHaveProperty("vault");
      expect(qn?.inputSchema?.required ?? []).not.toContain("vault");
      expect(qn?.description).toMatch(/Catalog caveat/);
      const del = listBody.result.tools.find((t) => t.name === "delete-note");
      expect(del?.inputSchema?.required).toContain("vault");
    } finally {
      h.cleanup();
    }
  });

  test("NIP-98 first-admin initializes", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(nostrReq(OWNER_SECRET, rpc("initialize")), mcpDeps(h));
      expect(res.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });
});

describe("account MCP — list-vaults coverage", () => {
  test("Bearer host:admin lists every installed vault", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const res = await handleAccountMcp(
        bearerReq(token, rpc("tools/call", { name: "list-vaults", arguments: {} })),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as {
        covered: string;
        vaults: Array<{ name: string }>;
      };
      expect(payload.covered).toBe("all");
      expect(payload.vaults.map((v) => v.name).sort()).toEqual(["beta", "personal"]);
    } finally {
      h.cleanup();
    }
  });

  test("NIP-98 first-admin lists every installed vault", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(
        nostrReq(OWNER_SECRET, rpc("tools/call", { name: "list-vaults", arguments: {} })),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as {
        covered: string;
        vaults: Array<{ name: string }>;
      };
      expect(payload.covered).toBe("all");
      expect(payload.vaults.map((v) => v.name).sort()).toEqual(["beta", "personal"]);
    } finally {
      h.cleanup();
    }
  });

  test("NIP-98 friend lists only assigned vaults", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(
        nostrReq(FRIEND_SECRET, rpc("tools/call", { name: "list-vaults", arguments: {} })),
        mcpDeps(h),
      );
      expect(res.status).toBe(200);
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as {
        covered: string;
        vaults: Array<{ name: string }>;
      };
      expect(payload.covered).toBe("listed");
      expect(payload.vaults.map((v) => v.name)).toEqual(["beta"]);
    } finally {
      h.cleanup();
    }
  });

  test("auto-provisioned key lists nothing", async () => {
    const h = await makeHarness();
    const prev = process.env.PARACHUTE_NOSTR_AUTO_PROVISION;
    process.env.PARACHUTE_NOSTR_AUTO_PROVISION = "1";
    try {
      const res = await handleAccountMcp(
        nostrReq(OTHER_SECRET, rpc("tools/call", { name: "list-vaults", arguments: {} })),
        mcpDeps(h),
      );
      expect(res.status).toBe(200);
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as {
        covered: string;
        vaults: Array<{ name: string }>;
      };
      expect(payload.covered).toBe("listed");
      expect(payload.vaults).toEqual([]);
    } finally {
      if (prev === undefined) process.env.PARACHUTE_NOSTR_AUTO_PROVISION = undefined;
      else process.env.PARACHUTE_NOSTR_AUTO_PROVISION = prev;
      h.cleanup();
    }
  });
});

describe("account MCP — create-vault", () => {
  test("NIP-98 first-admin can create; result has no token", async () => {
    const h = await makeHarness(["default"]);
    try {
      const runCommand = async () => {
        upsertService(
          {
            name: "parachute-vault",
            port: 4101,
            paths: ["/vault/default", "/vault/work"],
            health: "/health",
            version: "0.4.2",
          },
          h.manifestPath,
        );
        return { exitCode: 0, stdout: vaultCreateJson("work"), stderr: "" };
      };
      const res = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", { name: "create-vault", arguments: { name: "work" } }),
        ),
        mcpDeps(h, { runCommand }),
      );
      expect(res.status).toBe(200);
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as Record<string, unknown>;
      expect(payload.name).toBe("work");
      expect(payload.url).toBe(`${ISSUER}/vault/work`);
      expect(payload.vault_token).toBeUndefined();
      expect(payload.token).toBeUndefined();
      const raw = JSON.stringify(payload);
      expect(raw).not.toContain("hubjwt");
    } finally {
      h.cleanup();
    }
  });

  test("NIP-98 friend cannot create", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", { name: "create-vault", arguments: { name: "work" } }),
        ),
        mcpDeps(h),
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/Unknown tool: create-vault/);
    } finally {
      h.cleanup();
    }
  });

  test("Bearer account:self:vaults can create; still no token in the tool result", async () => {
    const h = await makeHarness(["default"]);
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const runCommand = async () => {
        upsertService(
          {
            name: "parachute-vault",
            port: 4101,
            paths: ["/vault/default", "/vault/work"],
            health: "/health",
            version: "0.4.2",
          },
          h.manifestPath,
        );
        return { exitCode: 0, stdout: vaultCreateJson("work"), stderr: "" };
      };
      const res = await handleAccountMcp(
        bearerReq(token, rpc("tools/call", { name: "create-vault", arguments: { name: "work" } })),
        mcpDeps(h, { runCommand }),
      );
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as Record<string, unknown>;
      expect(payload.name).toBe("work");
      expect(payload.vault_token).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("existing name is vault_taken", async () => {
    const h = await makeHarness(["work"]);
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const res = await handleAccountMcp(
        bearerReq(token, rpc("tools/call", { name: "create-vault", arguments: { name: "work" } })),
        mcpDeps(h),
      );
      const body = (await res.json()) as { error?: { data?: { error_type?: string } } };
      expect(body.error?.data?.error_type).toBe("vault_taken");
    } finally {
      h.cleanup();
    }
  });
});

describe("account MCP — query-notes", () => {
  test("fans out with per-vault attribution; one failure is isolated", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onCall: ({ vault, rpc }) => {
            if (rpc.params?.name !== "query-notes") return undefined;
            if (vault === "personal") throw new Error("personal is down");
            return [{ id: "n-beta" }];
          },
        });
      const res = await handleAccountMcp(
        bearerReq(
          token,
          rpc("tools/call", { name: "query-notes", arguments: { search: "hello" } }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as {
        vaults_queried: string[];
        results: Array<{ vault: string; notes?: unknown; error?: string }>;
      };
      expect(payload.vaults_queried.sort()).toEqual(["beta", "personal"]);
      const byVault = Object.fromEntries(payload.results.map((r) => [r.vault, r]));
      expect(byVault.beta?.notes).toEqual([{ id: "n-beta" }]);
      expect(byVault.personal?.error).toMatch(/personal is down/);
    } finally {
      h.cleanup();
    }
  });

  test("friend targeting an unassigned vault is vault_not_covered", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", { name: "query-notes", arguments: { vault: "personal" } }),
        ),
        mcpDeps(h),
      );
      const body = (await res.json()) as { error?: { data?: { error_type?: string } } };
      expect(body.error?.data?.error_type).toBe("vault_not_covered");
    } finally {
      h.cleanup();
    }
  });

  test("forwards sort/include_content/cursor as MCP arguments, not REST query params", async () => {
    const h = await makeHarness();
    try {
      const seen: Array<Record<string, unknown> | undefined> = [];
      const urls: string[] = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onRequest: ({ url, rpc }) => {
            if (rpc.method === "tools/call") urls.push(url);
          },
          onCall: ({ rpc }) => {
            seen.push(rpc.params?.arguments);
            return [{ id: "n-beta" }];
          },
        });
      const res = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", {
            name: "query-notes",
            arguments: {
              vault: "beta",
              sort: "desc",
              include_content: true,
              order_by: "updated_at",
              offset: 2,
              limit: 3,
              cursor: "",
            },
          }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      expect(res.status).toBe(200);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toContain("/vault/beta/mcp");
      expect(urls[0]).not.toContain("/api/notes");
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        sort: "desc",
        include_content: true,
        order_by: "updated_at",
        offset: 2,
        limit: 3,
        cursor: "",
      });
      expect(seen[0]).not.toHaveProperty("vault");
    } finally {
      h.cleanup();
    }
  });

  test("does not allowlist sort — unknown values ride through to vault MCP", async () => {
    const h = await makeHarness();
    try {
      const seen: Array<Record<string, unknown> | undefined> = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onCall: ({ rpc }) => {
            seen.push(rpc.params?.arguments);
            return [];
          },
        });
      await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", {
            name: "query-notes",
            arguments: { vault: "beta", sort: "newest" },
          }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]?.sort).toBe("newest");
    } finally {
      h.cleanup();
    }
  });

  test("tools/list advertises live query-notes schema plus injected vault", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const listed = await handleAccountMcp(bearerReq(token, rpc("tools/list")), mcpDeps(h));
      const listBody = (await listed.json()) as {
        result: {
          tools: Array<{
            name: string;
            description?: string;
            inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
          }>;
        };
      };
      const qn = listBody.result.tools.find((t) => t.name === "query-notes");
      expect(qn?.inputSchema?.properties).toHaveProperty("sort");
      expect(qn?.inputSchema?.properties).toHaveProperty("include_content");
      expect(qn?.inputSchema?.properties).toHaveProperty("order_by");
      expect(qn?.inputSchema?.properties).toHaveProperty("vault");
      expect(qn?.inputSchema?.required ?? []).not.toContain("vault");
      expect(qn?.description).toMatch(/Catalog caveat/);
    } finally {
      h.cleanup();
    }
  });

  test("friend can query their assigned vault", async () => {
    const h = await makeHarness();
    try {
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, { onCall: () => [{ id: "n-beta" }] });
      const res = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", { name: "query-notes", arguments: { vault: "beta" } }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as {
        vaults_queried: string[];
      };
      expect(payload.vaults_queried).toEqual(["beta"]);
    } finally {
      h.cleanup();
    }
  });
});

describe("account MCP — create-note", () => {
  test("owner forwards JSON-RPC to the named vault with a write-or-higher mint", async () => {
    const h = await makeHarness();
    try {
      const seen: Array<{ url: string; method: string; scope: string; args: unknown }> = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onCall: ({ url, method, scope, rpc }) => {
            seen.push({ url, method, scope, args: rpc.params?.arguments });
            return { id: "n1", path: "Log/hello" };
          },
        });
      const res = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "create-note",
            arguments: { vault: "beta", path: "Log/hello", content: "hi" },
          }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      const out = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as { id: string };
      expect(out.id).toBe("n1");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toContain("/vault/beta/mcp");
      expect(seen[0]?.url).not.toContain("/api/notes");
      expect(seen[0]?.method).toBe("POST");
      expect(seen[0]?.scope).toMatch(/^vault:beta:(write|admin)$/);
      expect(seen[0]?.args).toEqual({ path: "Log/hello", content: "hi" });
    } finally {
      h.cleanup();
    }
  });

  test("read-role cannot create-note — Unknown tool, no tools/call", async () => {
    const h = await makeHarness();
    const readerSecret = hexToBytes("44".repeat(32));
    const readerPub = bytesToHex(schnorr.getPublicKey(readerSecret));
    const methods: string[] = [];
    try {
      const reader = await createUser(h.db, "reader", "correct-horse-battery-staple", {
        allowMulti: true,
        passwordChanged: true,
        assignedVaults: ["beta"],
        role: "read",
      });
      bindPubkeyFromHttpAuth(h.db, {
        userId: reader.id,
        pubkey: readerPub,
        proofEvent: "{}",
        proofEventId: "d".repeat(64),
        label: "test",
        now: new Date(),
      });
      const res = await handleAccountMcp(
        nostrReq(
          readerSecret,
          rpc("tools/call", {
            name: "create-note",
            arguments: { vault: "beta", content: "nope" },
          }),
        ),
        mcpDeps(h, {
          fetchImpl: (input, init) =>
            routeVaultMcp(input, init, {
              onRequest: ({ rpc }) => methods.push(rpc.method ?? ""),
            }),
        }),
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/Unknown tool: create-note/);
      expect(methods).toEqual(["tools/list"]);
    } finally {
      h.cleanup();
    }
  });

  test("first-admin Bearer named beta:read cannot create-note on beta", async () => {
    const h = await makeHarness();
    const methods: string[] = [];
    try {
      const token = await bearer(h, ["account:self:vaults:beta:read"], h.ownerId);
      const res = await handleAccountMcp(
        bearerReq(
          token,
          rpc("tools/call", { name: "create-note", arguments: { vault: "beta", content: "nope" } }),
        ),
        mcpDeps(h, {
          fetchImpl: (input, init) =>
            routeVaultMcp(input, init, {
              onRequest: ({ rpc }) => methods.push(rpc.method ?? ""),
            }),
        }),
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/Unknown tool: create-note/);
      expect(methods).toEqual(["tools/list"]);
    } finally {
      h.cleanup();
    }
  });

  test("friend Bearer named beta:read cannot create-note even with write assignment", async () => {
    const h = await makeHarness();
    const methods: string[] = [];
    try {
      const token = await bearer(h, ["account:self:vaults:beta:read"], h.friendId);
      const res = await handleAccountMcp(
        bearerReq(
          token,
          rpc("tools/call", { name: "create-note", arguments: { vault: "beta", content: "nope" } }),
        ),
        mcpDeps(h, {
          fetchImpl: (input, init) =>
            routeVaultMcp(input, init, {
              onRequest: ({ rpc }) => methods.push(rpc.method ?? ""),
            }),
        }),
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/Unknown tool: create-note/);
      expect(methods).toEqual(["tools/list"]);
    } finally {
      h.cleanup();
    }
  });

  test("friend NIP-98 write-role can create-note on the assigned vault", async () => {
    const h = await makeHarness();
    try {
      const seen: string[] = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onCall: ({ scope }) => {
            seen.push(scope);
            return { id: "n-friend" };
          },
        });
      const res = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", {
            name: "create-note",
            arguments: { vault: "beta", content: "from friend" },
          }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      const out = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as { id: string };
      expect(out.id).toBe("n-friend");
      expect(seen).toEqual(["vault:beta:admin"]);
    } finally {
      h.cleanup();
    }
  });

  test("unassigned vault is vault_not_covered", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", {
            name: "create-note",
            arguments: { vault: "personal", content: "nope" },
          }),
        ),
        mcpDeps(h),
      );
      const body = (await res.json()) as { error?: { data?: { error_type?: string } } };
      expect(body.error?.data?.error_type).toBe("vault_not_covered");
    } finally {
      h.cleanup();
    }
  });

  test("tools/list hides create-note and grant tools from a read-role caller", async () => {
    const h = await makeHarness();
    const readerSecret = hexToBytes("55".repeat(32));
    const readerPub = bytesToHex(schnorr.getPublicKey(readerSecret));
    try {
      const reader = await createUser(h.db, "reader2", "correct-horse-battery-staple", {
        allowMulti: true,
        passwordChanged: true,
        assignedVaults: ["beta"],
        role: "read",
      });
      bindPubkeyFromHttpAuth(h.db, {
        userId: reader.id,
        pubkey: readerPub,
        proofEvent: "{}",
        proofEventId: "e".repeat(64),
        label: "test",
        now: new Date(),
      });
      const listed = await handleAccountMcp(nostrReq(readerSecret, rpc("tools/list")), mcpDeps(h));
      const names = (
        (await listed.json()) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((t) => t.name);
      expect(names).toContain("list-vaults");
      expect(names).toContain("query-notes");
      expect(names).not.toContain("create-note");
      expect(names).not.toContain("update-note");
      expect(names).not.toContain("grant-access");
      expect(names).not.toContain("create-vault");
      expect(names).not.toContain("manage-token");
    } finally {
      h.cleanup();
    }
  });
});

describe("account MCP — update-note", () => {
  test("owner forwards JSON-RPC update-note with a write-or-higher mint", async () => {
    const h = await makeHarness();
    try {
      const seen: Array<{ url: string; method: string; scope: string; args: unknown }> = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onCall: ({ url, method, scope, rpc }) => {
            seen.push({ url, method, scope, args: rpc.params?.arguments });
            return { id: "n1", path: "Log/hello", content: "there" };
          },
        });
      const res = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "update-note",
            arguments: { vault: "beta", id: "n1", content: "there" },
          }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      const out = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as { id: string; content: string };
      expect(out.id).toBe("n1");
      expect(out.content).toBe("there");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toContain("/vault/beta/mcp");
      expect(seen[0]?.method).toBe("POST");
      expect(seen[0]?.scope).toMatch(/^vault:beta:(write|admin)$/);
      expect(seen[0]?.args).toEqual({ id: "n1", content: "there" });
    } finally {
      h.cleanup();
    }
  });

  test("path id stays in MCP arguments, not a REST URL", async () => {
    const h = await makeHarness();
    try {
      const seen: Array<{ url: string; args: Record<string, unknown> | undefined }> = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onCall: ({ url, rpc }) => {
            seen.push({ url, args: rpc.params?.arguments });
            return { id: "n1", path: "Log/hello" };
          },
        });
      const res = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "update-note",
            arguments: { vault: "beta", id: "Log/hello", append: " more", force: true },
          }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toContain("/vault/beta/mcp");
      expect(seen[0]?.url).not.toContain("/api/notes");
      expect(seen[0]?.args).toEqual({ id: "Log/hello", append: " more", force: true });
    } finally {
      h.cleanup();
    }
  });

  test("read-role cannot update-note — Unknown tool, no tools/call", async () => {
    const h = await makeHarness();
    const readerSecret = hexToBytes("66".repeat(32));
    const readerPub = bytesToHex(schnorr.getPublicKey(readerSecret));
    const methods: string[] = [];
    try {
      const reader = await createUser(h.db, "reader3", "correct-horse-battery-staple", {
        allowMulti: true,
        passwordChanged: true,
        assignedVaults: ["beta"],
        role: "read",
      });
      bindPubkeyFromHttpAuth(h.db, {
        userId: reader.id,
        pubkey: readerPub,
        proofEvent: "{}",
        proofEventId: "f".repeat(64),
        label: "test",
        now: new Date(),
      });
      const res = await handleAccountMcp(
        nostrReq(
          readerSecret,
          rpc("tools/call", {
            name: "update-note",
            arguments: { vault: "beta", id: "n1", content: "nope" },
          }),
        ),
        mcpDeps(h, {
          fetchImpl: (input, init) =>
            routeVaultMcp(input, init, {
              onRequest: ({ rpc }) => methods.push(rpc.method ?? ""),
            }),
        }),
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/Unknown tool: update-note/);
      expect(methods).toEqual(["tools/list"]);
    } finally {
      h.cleanup();
    }
  });

  test("first-admin Bearer named beta:read cannot update-note on beta", async () => {
    const h = await makeHarness();
    const methods: string[] = [];
    try {
      const token = await bearer(h, ["account:self:vaults:beta:read"], h.ownerId);
      const res = await handleAccountMcp(
        bearerReq(
          token,
          rpc("tools/call", {
            name: "update-note",
            arguments: { vault: "beta", id: "n1", content: "nope" },
          }),
        ),
        mcpDeps(h, {
          fetchImpl: (input, init) =>
            routeVaultMcp(input, init, {
              onRequest: ({ rpc }) => methods.push(rpc.method ?? ""),
            }),
        }),
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/Unknown tool: update-note/);
      expect(methods).toEqual(["tools/list"]);
    } finally {
      h.cleanup();
    }
  });

  test("friend NIP-98 write-role can update-note on the assigned vault", async () => {
    const h = await makeHarness();
    try {
      const seen: Array<{ method: string; scope: string }> = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onCall: ({ method, scope }) => {
            seen.push({ method, scope });
            return { id: "n-friend", content: "edited" };
          },
        });
      const res = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", {
            name: "update-note",
            arguments: { vault: "beta", id: "n-friend", append: " more" },
          }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      const out = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as { id: string };
      expect(out.id).toBe("n-friend");
      expect(seen).toEqual([{ method: "POST", scope: "vault:beta:admin" }]);
    } finally {
      h.cleanup();
    }
  });

  test("unassigned vault is vault_not_covered", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", {
            name: "update-note",
            arguments: { vault: "personal", id: "n1", content: "nope" },
          }),
        ),
        mcpDeps(h),
      );
      const body = (await res.json()) as { error?: { data?: { error_type?: string } } };
      expect(body.error?.data?.error_type).toBe("vault_not_covered");
    } finally {
      h.cleanup();
    }
  });
});
describe("account MCP — vault module proxy", () => {
  test("schema-source is one tools/list POST to the highest-verb vault", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const lists: string[] = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onRequest: ({ vault, rpc }) => {
            if (rpc.method === "tools/list") lists.push(vault);
          },
        });
      await handleAccountMcp(bearerReq(token, rpc("tools/list")), mcpDeps(h, { fetchImpl }));
      expect(lists).toEqual(["beta"]);
    } finally {
      h.cleanup();
    }
  });

  test("schema-source falls back to the next covered vault when the highest-verb one is down", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const lists: string[] = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onList: ({ vault }) => {
            lists.push(vault);
            if (vault === "beta") throw new Error("beta down");
            return { tools: toolsForMintedScope("vault:personal:admin") };
          },
        });
      const listed = await handleAccountMcp(
        bearerReq(token, rpc("tools/list")),
        mcpDeps(h, { fetchImpl }),
      );
      const names = (
        (await listed.json()) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((t) => t.name);
      expect(lists).toEqual(["beta", "personal"]);
      expect(names).toContain("query-notes");
      expect(names).toContain("manage-token");
      expect(names).toContain("list-vaults");
    } finally {
      h.cleanup();
    }
  });

  test("schema-source all down degrades to hub-native only", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const fetchImpl = async () => {
        throw new Error("all vaults down");
      };
      const listed = await handleAccountMcp(
        bearerReq(token, rpc("tools/list")),
        mcpDeps(h, { fetchImpl }),
      );
      expect(listed.status).toBe(200);
      const names = (
        (await listed.json()) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((t) => t.name);
      expect(names).toEqual([
        "list-vaults",
        "create-vault",
        "grant-access",
        "revoke-access",
        "list-access",
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("no vaults installed: hub-native only, no fetch", async () => {
    const h = await makeHarness([]);
    let fetched = 0;
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const listed = await handleAccountMcp(
        bearerReq(token, rpc("tools/list")),
        mcpDeps(h, {
          fetchImpl: async () => {
            fetched += 1;
            return new Response("nope", { status: 500 });
          },
        }),
      );
      const names = (
        (await listed.json()) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((t) => t.name);
      expect(names).toEqual(["list-vaults", "create-vault"]);
      expect(fetched).toBe(0);
      const queried = await handleAccountMcp(
        bearerReq(token, rpc("tools/call", { name: "query-notes", arguments: {} })),
        mcpDeps(h, {
          fetchImpl: async () => {
            fetched += 1;
            return new Response("nope", { status: 500 });
          },
        }),
      );
      const body = (await queried.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/Unknown tool: query-notes/);
      expect(fetched).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("list-tags and manage-token exist only because the live list included them", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const listed = await handleAccountMcp(bearerReq(token, rpc("tools/list")), mcpDeps(h));
      const names = (
        (await listed.json()) as { result: { tools: Array<{ name: string }> } }
      ).result.tools.map((t) => t.name);
      expect(names).toContain("list-tags");
      expect(names).toContain("manage-token");
    } finally {
      h.cleanup();
    }
  });

  test("read-attachment image content is passed through, not stringified", async () => {
    const h = await makeHarness();
    try {
      const image = {
        content: [
          { type: "image", data: "abc", mimeType: "image/png" },
          { type: "text", text: '{"id":"att1"}' },
        ],
      };
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onCall: ({ rpc }) => {
            if (rpc.params?.name === "read-attachment") return image;
            return undefined;
          },
        });
      const res = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "read-attachment",
            arguments: { vault: "beta", attachment_id: "att1" },
          }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      const body = (await res.json()) as {
        result: { content: Array<{ type: string; data?: string; mimeType?: string }> };
      };
      expect(body.result.content[0]).toEqual({
        type: "image",
        data: "abc",
        mimeType: "image/png",
      });
    } finally {
      h.cleanup();
    }
  });

  test("delete-note forwards to vault MCP", async () => {
    const h = await makeHarness();
    try {
      const seen: Array<{ name?: string; args?: Record<string, unknown> }> = [];
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, {
          onCall: ({ rpc }) => {
            seen.push({ name: rpc.params?.name, args: rpc.params?.arguments });
            return { deleted: true };
          },
        });
      const res = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", { name: "delete-note", arguments: { vault: "beta", id: "n1" } }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      expect(res.status).toBe(200);
      expect(seen).toEqual([{ name: "delete-note", args: { id: "n1" } }]);
    } finally {
      h.cleanup();
    }
  });
});

describe("account MCP — NIP-98 bind", () => {
  test("payload mismatch is 401", async () => {
    const h = await makeHarness();
    try {
      const body = rpc("ping");
      const encoded = JSON.stringify(body);
      const event = signEvent(OWNER_SECRET, {
        tags: [
          ["u", MCP_URL],
          ["method", "POST"],
          ["payload", "0".repeat(64)],
        ],
      });
      const res = await handleAccountMcp(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            authorization: nostrHeader(event),
            accept: BOTH_ACCEPT,
            "content-type": "application/json",
          },
          body: encoded,
        }),
        mcpDeps(h),
      );
      expect(res.status).toBe(401);
    } finally {
      h.cleanup();
    }
  });
});

describe("account MCP — extra pins", () => {
  test("ping returns {}", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const res = await handleAccountMcp(bearerReq(token, rpc("ping")), mcpDeps(h));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { result: unknown };
      expect(body.result).toEqual({});
    } finally {
      h.cleanup();
    }
  });

  test("invalid JSON is 400 parse error", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const res = await handleAccountMcp(
        new Request(MCP_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            accept: BOTH_ACCEPT,
            "content-type": "application/json",
          },
          body: "{not json",
        }),
        mcpDeps(h),
      );
      expect(res.status).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  test("Bearer host:admin with aud=hub (operator SPA mint) still opens", async () => {
    const h = await makeHarness();
    try {
      const minted = await signAccessToken(h.db, {
        sub: h.ownerId,
        scopes: [HOST_ADMIN_SCOPE],
        audience: "hub",
        clientId: "parachute-hub-spa",
        issuer: ISSUER,
        ttlSeconds: 600,
      });
      const res = await handleAccountMcp(bearerReq(minted.token, rpc("initialize")), mcpDeps(h));
      expect(res.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("Bearer leftover un-narrowed account:vaults still opens as a blanket grant", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_UNNARROWED]);
      const res = await handleAccountMcp(
        bearerReq(token, rpc("tools/call", { name: "list-vaults", arguments: {} })),
        mcpDeps(h),
      );
      expect(res.status).toBe(200);
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as { covered: string };
      expect(payload.covered).toBe("all");
    } finally {
      h.cleanup();
    }
  });

  test("Bearer account:self:write cannot open the door", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_WRITE_SCOPE]);
      const res = await handleAccountMcp(bearerReq(token, rpc("initialize")), mcpDeps(h));
      expect(res.status).toBe(403);
    } finally {
      h.cleanup();
    }
  });

  test("Bearer narrowed account:self:vaults:beta lists only beta", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, ["account:self:vaults:beta"]);
      const res = await handleAccountMcp(
        bearerReq(token, rpc("tools/call", { name: "list-vaults", arguments: {} })),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as { covered: string; vaults: Array<{ name: string }> };
      expect(payload.covered).toBe("listed");
      expect(payload.vaults.map((v) => v.name)).toEqual(["beta"]);
    } finally {
      h.cleanup();
    }
  });

  test("NIP-98 read-role still lists and queries the assigned vault", async () => {
    const h = await makeHarness();
    const readerSecret = hexToBytes("44".repeat(32));
    const readerPub = bytesToHex(schnorr.getPublicKey(readerSecret));
    try {
      const reader = await createUser(h.db, "reader", "correct-horse-battery-staple", {
        allowMulti: true,
        passwordChanged: true,
        assignedVaults: ["beta"],
        role: "read",
      });
      bindPubkeyFromHttpAuth(h.db, {
        userId: reader.id,
        pubkey: readerPub,
        proofEvent: "{}",
        proofEventId: "c".repeat(64),
        label: "test",
        now: new Date(),
      });
      const listed = await handleAccountMcp(
        nostrReq(readerSecret, rpc("tools/call", { name: "list-vaults", arguments: {} })),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await listed.json()) as { result: { content: Array<{ text: string }> } },
      ) as { vaults: Array<{ name: string }> };
      expect(payload.vaults.map((v) => v.name)).toEqual(["beta"]);
      const fetchImpl = (input: string | URL | Request, init?: RequestInit) =>
        routeVaultMcp(input, init, { onCall: () => [{ id: "n-beta" }] });
      const queried = await handleAccountMcp(
        nostrReq(
          readerSecret,
          rpc("tools/call", { name: "query-notes", arguments: { vault: "beta" } }),
        ),
        mcpDeps(h, { fetchImpl }),
      );
      expect(queried.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });
});

describe("account MCP — hubFetch wiring", () => {
  test("unauthed POST is 401 JSON with PRM challenge, not HTML", async () => {
    const h = await makeHarness();
    try {
      const { hubFetch } = await import("../hub-server.ts");
      const handler = hubFetch(h.dir, {
        getDb: () => h.db,
        manifestPath: h.manifestPath,
        issuer: ISSUER,
      });
      const res = await handler(
        new Request(MCP_URL, {
          method: "POST",
          headers: { accept: BOTH_ACCEPT, "content-type": "application/json" },
          body: JSON.stringify(rpc("initialize")),
        }),
      );
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type") ?? "").toContain("json");
      expect(res.headers.get("www-authenticate") ?? "").toContain(
        "/.well-known/oauth-protected-resource/account/mcp",
      );
      const text = await res.text();
      expect(text.toLowerCase()).not.toContain("<html");
    } finally {
      h.cleanup();
    }
  });

  test("GET PRM is public and advertises account:vaults", async () => {
    const h = await makeHarness();
    try {
      const { hubFetch } = await import("../hub-server.ts");
      const handler = hubFetch(h.dir, {
        getDb: () => h.db,
        manifestPath: h.manifestPath,
        issuer: ISSUER,
      });
      const res = await handler(
        new Request(`${ISSUER}/.well-known/oauth-protected-resource/account/mcp`),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { scopes_supported: string[]; resource: string };
      expect(body.resource).toBe(MCP_URL);
      expect(body.scopes_supported).toEqual([ACCOUNT_VAULTS_UNNARROWED]);
    } finally {
      h.cleanup();
    }
  });
});

describe("account MCP — grant-access", () => {
  test("NIP-98 owner grant-first: unknown pubkey becomes a key-only user and can list the vault", async () => {
    const h = await makeHarness();
    try {
      const granted = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await granted.json()) as { result: { content: Array<{ text: string }> } },
      ) as {
        pubkey: string;
        vault: string;
        role: string;
        created_user: boolean;
        unrestricted: boolean;
        user_id: string;
      };
      expect(payload.pubkey).toBe(OTHER_PUBKEY);
      expect(payload.vault).toBe("beta");
      expect(payload.role).toBe("write");
      expect(payload.created_user).toBe(true);
      expect(payload.unrestricted).toBe(false);
      const link = findPubkeyLink(h.db, OTHER_PUBKEY);
      expect(link?.userId).toBe(payload.user_id);
      expect(vaultVerbsForUserVault(h.db, payload.user_id, "beta")).toEqual([
        "read",
        "write",
        "admin",
      ]);
      expect(vaultVerbsForUserVault(h.db, payload.user_id, "personal")).toBeNull();

      const listed = await handleAccountMcp(
        nostrReq(OTHER_SECRET, rpc("tools/call", { name: "list-vaults", arguments: {} })),
        mcpDeps(h),
      );
      const coverage = parseTool(
        (await listed.json()) as { result: { content: Array<{ text: string }> } },
      ) as { covered: string; vaults: Array<{ name: string }> };
      expect(coverage.covered).toBe("listed");
      expect(coverage.vaults.map((v) => v.name)).toEqual(["beta"]);
    } finally {
      h.cleanup();
    }
  });

  test("second grant upserts role and does not wipe other vaults", async () => {
    const h = await makeHarness();
    try {
      await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "personal", role: "read" },
          }),
        ),
        mcpDeps(h),
      );
      const second = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "read" },
          }),
        ),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await second.json()) as { result: { content: Array<{ text: string }> } },
      ) as { created_user: boolean; user_id: string };
      expect(payload.created_user).toBe(false);
      expect(vaultVerbsForUserVault(h.db, payload.user_id, "beta")).toEqual(["read"]);
      expect(getUserById(h.db, payload.user_id)?.assignedVaults.sort()).toEqual([
        "beta",
        "personal",
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("friend with write on beta can grant beta, not personal", async () => {
    const h = await makeHarness();
    try {
      const ok = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "read" },
          }),
        ),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await ok.json()) as { result: { content: Array<{ text: string }> } },
      ) as { vault: string; user_id: string };
      expect(payload.vault).toBe("beta");
      expect(vaultVerbsForUserVault(h.db, payload.user_id, "beta")).toEqual(["read"]);
      expect(vaultVerbsForUserVault(h.db, payload.user_id, "personal")).toBeNull();

      const denied = await handleAccountMcp(
        nostrReq(
          FRIEND_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "personal", role: "read" },
          }),
        ),
        mcpDeps(h),
      );
      const body = (await denied.json()) as { error?: { data?: { error_type?: string } } };
      expect(body.error?.data?.error_type).toBe("grant_not_permitted");
    } finally {
      h.cleanup();
    }
  });

  test("read-role assignee cannot grant", async () => {
    const h = await makeHarness();
    const readerSecret = hexToBytes("44".repeat(32));
    const readerPub = bytesToHex(schnorr.getPublicKey(readerSecret));
    try {
      const reader = await createUser(h.db, "reader", "correct-horse-battery-staple", {
        allowMulti: true,
        passwordChanged: true,
        assignedVaults: ["beta"],
        role: "read",
      });
      bindPubkeyFromHttpAuth(h.db, {
        userId: reader.id,
        pubkey: readerPub,
        proofEvent: "{}",
        proofEventId: "c".repeat(64),
        label: "test",
        now: new Date(),
      });
      const res = await handleAccountMcp(
        nostrReq(
          readerSecret,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "read" },
          }),
        ),
        mcpDeps(h),
      );
      const body = (await res.json()) as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toMatch(/Unknown tool: grant-access/);
    } finally {
      h.cleanup();
    }
  });

  test("granting the owner pubkey is unrestricted and writes no user_vaults row", async () => {
    const h = await makeHarness();
    try {
      const res = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OWNER_PUBKEY, vault: "beta", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as { unrestricted: boolean; user_id: string };
      expect(payload.unrestricted).toBe(true);
      expect(payload.user_id).toBe(h.ownerId);
      expect(getUserById(h.db, h.ownerId)?.assignedVaults).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  test("invalid pubkey / missing vault / unknown vault / npub", async () => {
    const h = await makeHarness();
    try {
      const npub = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: "npub1qqqqqqq", vault: "beta", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      expect(
        ((await npub.json()) as { error?: { data?: { error_type?: string } } }).error?.data
          ?.error_type,
      ).toBe("invalid_pubkey");

      const missing = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      expect(
        ((await missing.json()) as { error?: { data?: { error_type?: string } } }).error?.data
          ?.error_type,
      ).toBe("invalid_vault");

      const unknown = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "ghost", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      expect(
        ((await unknown.json()) as { error?: { data?: { error_type?: string } } }).error?.data
          ?.error_type,
      ).toBe("vault_not_installed");

      const badRole = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "admin" },
          }),
        ),
        mcpDeps(h),
      );
      expect(
        ((await badRole.json()) as { error?: { data?: { error_type?: string } } }).error?.data
          ?.error_type,
      ).toBe("invalid_role");
    } finally {
      h.cleanup();
    }
  });

  test("revoke drops the row, leaves the user, refuses the owner", async () => {
    const h = await makeHarness();
    try {
      const granted = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      const g = parseTool(
        (await granted.json()) as { result: { content: Array<{ text: string }> } },
      ) as { user_id: string };

      const revoked = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "revoke-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta" },
          }),
        ),
        mcpDeps(h),
      );
      const r = parseTool(
        (await revoked.json()) as { result: { content: Array<{ text: string }> } },
      ) as { revoked: boolean };
      expect(r.revoked).toBe(true);
      expect(getUserById(h.db, g.user_id)).not.toBeNull();
      expect(vaultVerbsForUserVault(h.db, g.user_id, "beta")).toBeNull();
      expect(findPubkeyLink(h.db, OTHER_PUBKEY)?.userId).toBe(g.user_id);

      const ownerRevoke = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "revoke-access",
            arguments: { pubkey: OWNER_PUBKEY, vault: "beta" },
          }),
        ),
        mcpDeps(h),
      );
      expect(
        ((await ownerRevoke.json()) as { error?: { data?: { error_type?: string } } }).error?.data
          ?.error_type,
      ).toBe("target_is_hub_admin");
    } finally {
      h.cleanup();
    }
  });

  test("list-access is pubkey-shaped; friend sees only vaults they can admin", async () => {
    const h = await makeHarness();
    try {
      await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "personal", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "read" },
          }),
        ),
        mcpDeps(h),
      );

      const ownerList = await handleAccountMcp(
        nostrReq(OWNER_SECRET, rpc("tools/call", { name: "list-access", arguments: {} })),
        mcpDeps(h),
      );
      const ownerRows = parseTool(
        (await ownerList.json()) as { result: { content: Array<{ text: string }> } },
      ) as { access: Array<{ pubkey: string; vault: string; role: string }> };
      expect(
        ownerRows.access
          .filter((a) => a.pubkey === OTHER_PUBKEY)
          .map((a) => a.vault)
          .sort(),
      ).toEqual(["beta", "personal"]);

      const friendList = await handleAccountMcp(
        nostrReq(FRIEND_SECRET, rpc("tools/call", { name: "list-access", arguments: {} })),
        mcpDeps(h),
      );
      const friendRows = parseTool(
        (await friendList.json()) as { result: { content: Array<{ text: string }> } },
      ) as { access: Array<{ pubkey: string; vault: string }> };
      expect(friendRows.access.every((a) => a.vault === "beta")).toBe(true);
      expect(friendRows.access.some((a) => a.pubkey === OTHER_PUBKEY)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("Bearer host:admin can grant", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [HOST_ADMIN_SCOPE]);
      const res = await handleAccountMcp(
        bearerReq(
          token,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "personal", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as { created_user: boolean; vault: string; user_id: string };
      expect(payload.created_user).toBe(true);
      expect(payload.vault).toBe("personal");
      expect(vaultVerbsForUserVault(h.db, payload.user_id, "personal")).toEqual([
        "read",
        "write",
        "admin",
      ]);
    } finally {
      h.cleanup();
    }
  });

  test("first-admin Bearer named beta:read cannot grant personal or beta", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, ["account:self:vaults:beta:read"]);
      const personal = await handleAccountMcp(
        bearerReq(
          token,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "personal", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      expect(
        (
          (await personal.json()) as {
            result?: { isError?: boolean; content?: Array<{ text?: string }> };
          }
        ).result?.content?.[0]?.text,
      ).toMatch(/Unknown tool: grant-access/);
      const beta = await handleAccountMcp(
        bearerReq(
          token,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      expect(
        (
          (await beta.json()) as {
            result?: { isError?: boolean; content?: Array<{ text?: string }> };
          }
        ).result?.content?.[0]?.text,
      ).toMatch(/Unknown tool: grant-access/);
    } finally {
      h.cleanup();
    }
  });

  test("first-admin Bearer account:self:vaults (coverage wildcard) can grant personal", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_VAULTS_SCOPE]);
      const res = await handleAccountMcp(
        bearerReq(
          token,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "personal", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      const payload = parseTool(
        (await res.json()) as { result: { content: Array<{ text: string }> } },
      ) as { vault: string; created_user: boolean };
      expect(payload.vault).toBe("personal");
      expect(payload.created_user).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("friend Bearer named beta:read cannot grant even with write assignment", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, ["account:self:vaults:beta:read"], h.friendId);
      const res = await handleAccountMcp(
        bearerReq(
          token,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      expect(
        (
          (await res.json()) as {
            result?: { isError?: boolean; content?: Array<{ text?: string }> };
          }
        ).result?.content?.[0]?.text,
      ).toMatch(/Unknown tool: grant-access/);
    } finally {
      h.cleanup();
    }
  });

  test("username collision on both n-prefixes refuses rather than granting the wrong user", async () => {
    const h = await makeHarness();
    try {
      await createUser(h.db, `n${OTHER_PUBKEY.slice(0, 31)}`, "correct-horse-battery-staple", {
        allowMulti: true,
        passwordChanged: true,
      });
      await createUser(h.db, `n${OTHER_PUBKEY.slice(1, 32)}`, "correct-horse-battery-staple", {
        allowMulti: true,
        passwordChanged: true,
      });
      const res = await handleAccountMcp(
        nostrReq(
          OWNER_SECRET,
          rpc("tools/call", {
            name: "grant-access",
            arguments: { pubkey: OTHER_PUBKEY, vault: "beta", role: "write" },
          }),
        ),
        mcpDeps(h),
      );
      expect(
        ((await res.json()) as { error?: { data?: { error_type?: string } } }).error?.data
          ?.error_type,
      ).toBe("username_taken");
      expect(findPubkeyLink(h.db, OTHER_PUBKEY)).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
