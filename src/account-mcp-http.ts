/**
 * `/account/mcp` — the hub's account-level MCP door.
 *
 * Transport framing is transcribed from the cloud identity worker's
 * `account-mcp-http.ts` (itself transcribed from the vault door): Accept-both
 * 406 / Content-Type 415 / parse-error 400 / notifications-202 / GET-405 /
 * DELETE-200 / protocol-version. Keep them in lockstep; a divergence presents
 * as an opaque connector failure.
 *
 * Auth runs BEFORE any JSON-RPC:
 *   - `Authorization: Nostr <event>` → NIP-98 (hub#882). Any resolved hub
 *     user opens the door; coverage is assignment, not account:self:*.
 *   - `Authorization: Bearer <jwt>` → an account-vaults connection grant
 *     (`account:self:vaults` / composed forms, `aud=account`) or
 *     `parachute:host:admin` (operator bypass). REST `account:self:read`
 *     does not open this door.
 *
 * Cookie sessions never open this door. Wildcard CORS is correct: nothing
 * here is ambient-auth.
 */
import type { Database } from "bun:sqlite";
import { ACCOUNT_VAULTS_UNNARROWED } from "@openparachute/door-contract";
import type { AccountApiDeps } from "./account-api.ts";
import {
  ACCOUNT_MCP_TOOLS,
  type AccountMcpPrincipal,
  type AccountToolContext,
  AccountToolError,
  buildAccountConnectionGrant,
} from "./account-mcp.ts";
import {
  AdminAuthError,
  adminAuthErrorResponse,
  extractBearerToken,
  nostrAutoProvisionEnabled,
} from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { validateAccessToken } from "./jwt-sign.ts";
import {
  NostrHttpAuthError,
  type NostrReplayCache,
  authenticateNostrRequest,
  isNostrAuthorization,
} from "./nostr-http-auth.ts";
import { isFirstAdmin } from "./users.ts";

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

function result(id: JsonRpcId, value: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result: value };
}
function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}
function isJsonRpc(m: unknown): m is JsonRpcMessage {
  return !!m && typeof m === "object" && (m as JsonRpcMessage).jsonrpc === "2.0";
}
function isRequest(m: JsonRpcMessage): boolean {
  return typeof m.method === "string" && m.id !== undefined;
}

function withMcpCors(res: Response): Response {
  res.headers.set("access-control-allow-origin", "*");
  res.headers.set("access-control-expose-headers", "WWW-Authenticate");
  return res;
}

function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, DELETE, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version",
      "access-control-max-age": "86400",
    },
  });
}

function jsonRpcHttpError(status: number, code: number, message: string): Response {
  return withMcpCors(
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

export interface AccountMcpDeps extends AccountApiDeps {
  replay?: NostrReplayCache;
  fetchImpl?: AccountToolContext["fetchImpl"];
  signToken?: AccountToolContext["signToken"];
}

function accountMcpResource(issuer: string): string {
  return `${issuer.replace(/\/$/, "")}/account/mcp`;
}

function accountMcpChallenge(issuer: string): string {
  const origin = issuer.replace(/\/$/, "");
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/account/mcp"`;
}

/** RFC 9728 PRM for `/account/mcp`. Public + wildcard CORS. */
export function accountMcpProtectedResource(issuer: string): Response {
  const origin = issuer.replace(/\/$/, "");
  return withMcpCors(
    new Response(
      JSON.stringify({
        resource: `${origin}/account/mcp`,
        authorization_servers: [origin],
        scopes_supported: [ACCOUNT_VAULTS_UNNARROWED],
        bearer_methods_supported: ["header"],
        resource_documentation: "https://parachute.computer",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
        },
      },
    ),
  );
}

function authFailure(
  status: 401 | 403,
  error: string,
  message: string,
  issuer: string,
  scope?: string,
): Response {
  const challenge = [
    accountMcpChallenge(issuer),
    `error="${error}"`,
    `error_description="${message.replace(/"/g, "'")}"`,
  ];
  if (status === 403 && scope) challenge.push(`scope="${scope}"`);
  return withMcpCors(
    new Response(JSON.stringify({ error, error_description: message }), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "WWW-Authenticate": challenge.join(", "),
      },
    }),
  );
}

async function authenticateBearer(
  db: Database,
  req: Request,
  expectedIssuer: string | readonly string[],
): Promise<AccountMcpPrincipal> {
  const token = extractBearerToken(req);
  let validated: Awaited<ReturnType<typeof validateAccessToken>>;
  try {
    validated = await validateAccessToken(db, token, expectedIssuer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminAuthError(401, `invalid token: ${msg}`);
  }
  const sub = typeof validated.payload.sub === "string" ? validated.payload.sub : null;
  if (!sub) throw new AdminAuthError(401, "token missing required `sub` claim");
  const scopeClaim = (validated.payload as { scope?: unknown }).scope;
  const scopes =
    typeof scopeClaim === "string" ? scopeClaim.split(/\s+/).filter((s) => s.length > 0) : [];
  const grant = buildAccountConnectionGrant(scopes);
  if (grant === null) {
    throw new AdminAuthError(
      403,
      "the account MCP requires an account-vaults connection scope (account:vaults) or parachute:host:admin",
      ACCOUNT_VAULTS_UNNARROWED,
    );
  }
  const hostAdmin = scopes.includes(HOST_ADMIN_SCOPE);
  if (!hostAdmin) {
    const aud = typeof validated.payload.aud === "string" ? validated.payload.aud : undefined;
    if (aud !== "account") {
      throw new AdminAuthError(401, "token audience must be `account`");
    }
  }
  const clientIdRaw = (validated.payload as { client_id?: unknown }).client_id;
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw : undefined;
  return {
    userId: sub,
    scopes,
    authKind: "bearer",
    clientId,
    isHubAdmin: isFirstAdmin(db, sub) || hostAdmin,
    grant,
  };
}

async function authenticate(
  db: Database,
  req: Request,
  deps: AccountMcpDeps,
  body: Uint8Array,
): Promise<AccountMcpPrincipal> {
  if (isNostrAuthorization(req)) {
    const principal = await authenticateNostrRequest(db, req, {
      autoProvision: nostrAutoProvisionEnabled(),
      now: deps.now,
      replay: deps.replay,
      body,
    });
    return {
      userId: principal.userId,
      scopes: principal.scopes,
      authKind: "nostr",
      clientId: `nostr:${principal.pubkey}`,
      isHubAdmin: principal.isHubAdmin,
      grant: null,
    };
  }
  return authenticateBearer(db, req, deps.knownIssuers ?? [deps.issuer]);
}

async function handleToolCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  ctx: AccountToolContext,
): Promise<JsonRpcMessage> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  const tool = ACCOUNT_MCP_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return result(id, {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    });
  }
  try {
    const out = await tool.execute(args, ctx);
    return result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
  } catch (err) {
    if (err instanceof AccountToolError) {
      return rpcError(id, INVALID_PARAMS, err.message, { error_type: err.errorType, ...err.extra });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return result(id, { content: [{ type: "text", text: `Error: ${message}` }], isError: true });
  }
}

function instructions(): string {
  return (
    "The Parachute hub account MCP — one connection across the vaults this key or token can use. " +
    "Use list-vaults to see them, create-vault to add one (hub owner / account write), " +
    "and query-notes to search across them (omit `vault` to fan out, pass it to target one)."
  );
}

async function handleOne(m: JsonRpcMessage, ctx: AccountToolContext): Promise<JsonRpcMessage> {
  const { id = null, method, params } = m;
  try {
    switch (method) {
      case "initialize": {
        const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return result(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "parachute-account", version: "0.1.0" },
          instructions: instructions(),
        });
      }
      case "tools/list":
        return result(id, {
          tools: ACCOUNT_MCP_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call":
        return await handleToolCall(id, params, ctx);
      case "ping":
        return result(id, {});
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
  }
}

function translateAuthError(err: unknown, issuer: string): Response {
  if (err instanceof NostrHttpAuthError) {
    return authFailure(err.status === 403 ? 403 : 401, "invalid_token", err.message, issuer);
  }
  if (err instanceof AdminAuthError) {
    const res = adminAuthErrorResponse(err);
    const challenge = res.headers.get("www-authenticate") ?? accountMcpChallenge(issuer);
    const withMeta = challenge.includes("resource_metadata=")
      ? challenge
      : `${accountMcpChallenge(issuer)}, ${challenge}`;
    const headers = new Headers(res.headers);
    headers.set("www-authenticate", withMeta);
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-expose-headers", "WWW-Authenticate");
    return new Response(res.body, { status: res.status, headers });
  }
  const message = err instanceof Error ? err.message : "unauthorized";
  return authFailure(401, "invalid_token", message, issuer);
}

/**
 * Handle a request at `/account/mcp`. Auth first, then Streamable-HTTP
 * JSON-response mode. `app.all` equivalent: every method is owned so the
 * path never falls through to the `/account/` HTML home.
 */
export async function handleAccountMcp(req: Request, deps: AccountMcpDeps): Promise<Response> {
  if (req.method === "OPTIONS") return preflight();

  let body = new Uint8Array();
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") {
    body = new Uint8Array(await req.arrayBuffer());
  }

  let principal: AccountMcpPrincipal;
  try {
    principal = await authenticate(deps.db, req, deps, body);
  } catch (err) {
    return translateAuthError(err, deps.issuer);
  }

  if (req.method === "DELETE") return withMcpCors(new Response(null, { status: 200 }));
  if (req.method !== "POST") {
    return withMcpCors(
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }),
        {
          status: 405,
          headers: { Allow: "POST, DELETE, OPTIONS", "Content-Type": "application/json" },
        },
      ),
    );
  }

  const accept = req.headers.get("accept") ?? "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    return jsonRpcHttpError(
      406,
      -32000,
      "Not Acceptable: Client must accept both application/json and text/event-stream",
    );
  }
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    return jsonRpcHttpError(
      415,
      -32000,
      "Unsupported Media Type: Content-Type must be application/json",
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return jsonRpcHttpError(400, PARSE_ERROR, "Parse error: Invalid JSON");
  }

  const rawMessages = Array.isArray(raw) ? raw : [raw];
  const messages: JsonRpcMessage[] = [];
  for (const m of rawMessages) {
    if (!isJsonRpc(m))
      return jsonRpcHttpError(400, PARSE_ERROR, "Parse error: Invalid JSON-RPC message");
    messages.push(m);
  }

  const isInit = messages.some((m) => m.method === "initialize");
  if (!isInit) {
    const pv = req.headers.get("mcp-protocol-version");
    if (pv !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) {
      return jsonRpcHttpError(
        400,
        -32000,
        `Bad Request: Unsupported protocol version: ${pv} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
      );
    }
  }

  const requests = messages.filter(isRequest);
  if (requests.length === 0) {
    return withMcpCors(new Response(null, { status: 202 }));
  }

  const ctx: AccountToolContext = {
    db: deps.db,
    issuer: deps.issuer,
    manifestPath: deps.manifestPath ?? SERVICES_MANIFEST_PATH,
    principal,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.runCommand !== undefined ? { runCommand: deps.runCommand } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.signToken !== undefined ? { signToken: deps.signToken } : {}),
  };
  const responses: JsonRpcMessage[] = [];
  for (const m of requests) responses.push(await handleOne(m, ctx));

  const payload = responses.length === 1 ? responses[0] : responses;
  return withMcpCors(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

export { accountMcpResource };
