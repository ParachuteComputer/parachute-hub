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
 *     vault_not_covered fail-closed;
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
import { bindPubkeyFromHttpAuth } from "../pubkey-links.ts";
import { upsertService } from "../services-manifest.ts";
import { rotateSigningKey } from "../signing-keys.ts";
import { createUser } from "../users.ts";

const ISSUER = "http://127.0.0.1:1939";
const MCP_URL = `${ISSUER}/account/mcp`;
const BOTH_ACCEPT = "application/json, text/event-stream";
const HOST_ADMIN_SCOPE = "parachute:host:admin";
const ACCOUNT_ADMIN_SCOPE = "account:self:admin";
const ACCOUNT_WRITE_SCOPE = "account:self:write";
const ACCOUNT_READ_SCOPE = "account:self:read";

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
    ...(extra.fetchImpl ? { fetchImpl: extra.fetchImpl } : {}),
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

  test("PRM names the account-MCP resource and account:self:read", async () => {
    const res = accountMcpProtectedResource(ISSUER);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
    };
    expect(body.resource).toBe(MCP_URL);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.scopes_supported).toEqual([ACCOUNT_READ_SCOPE]);
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

  test("403 Bearer without account:self:* or host:admin", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, ["vault:beta:read"]);
      const res = await handleAccountMcp(bearerReq(token, rpc("initialize")), mcpDeps(h));
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("insufficient_scope");
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).toContain(`scope="${ACCOUNT_READ_SCOPE}"`);
    } finally {
      h.cleanup();
    }
  });

  test("406 unless Accept lists both json and event-stream", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_READ_SCOPE]);
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
      const token = await bearer(h, [ACCOUNT_READ_SCOPE]);
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
      const token = await bearer(h, [ACCOUNT_READ_SCOPE]);
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
      const token = await bearer(h, [ACCOUNT_READ_SCOPE]);
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
  test("Bearer account:self:read initializes and lists the three tools", async () => {
    const h = await makeHarness();
    try {
      const token = await bearer(h, [ACCOUNT_READ_SCOPE]);
      const init = await handleAccountMcp(
        bearerReq(token, rpc("initialize", { protocolVersion: "2025-11-25" })),
        mcpDeps(h),
      );
      expect(init.status).toBe(200);
      const initBody = (await init.json()) as {
        result: { serverInfo: { name: string }; protocolVersion: string };
      };
      expect(initBody.result.serverInfo.name).toBe("parachute-account");
      expect(initBody.result.protocolVersion).toBe("2025-11-25");

      const listed = await handleAccountMcp(bearerReq(token, rpc("tools/list")), mcpDeps(h));
      const listBody = (await listed.json()) as { result: { tools: Array<{ name: string }> } };
      expect(listBody.result.tools.map((t) => t.name)).toEqual(
        ACCOUNT_MCP_TOOLS.map((t) => t.name),
      );
      expect(listBody.result.tools.map((t) => t.name)).toEqual([
        "list-vaults",
        "create-vault",
        "query-notes",
      ]);
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
      const body = (await res.json()) as { error?: { data?: { error_type?: string } } };
      expect(body.error?.data?.error_type).toBe("create_not_granted");
    } finally {
      h.cleanup();
    }
  });

  test("Bearer account:self:write can create; still no token in the tool result", async () => {
    const h = await makeHarness(["default"]);
    try {
      const token = await bearer(h, [ACCOUNT_WRITE_SCOPE]);
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
      const token = await bearer(h, [ACCOUNT_ADMIN_SCOPE]);
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
      const fetchImpl = async (input: string | URL | Request) => {
        const href =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : (input as Request).url;
        if (href.includes("/vault/beta/")) {
          return Response.json([{ id: "n-beta" }], { status: 200 });
        }
        throw new Error("personal is down");
      };
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

  test("friend can query their assigned vault", async () => {
    const h = await makeHarness();
    try {
      const fetchImpl = async () => Response.json([{ id: "n-beta" }], { status: 200 });
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
