/**
 * Module backends for the account MCP — live-list + JSON-RPC forward.
 *
 * Vault is the first implementation. A second module (scribe, surface, …)
 * is another object of this shape, not another REST clone.
 *
 * OPEN (module #2): hub-native names win against a backend (filtered here).
 * Two BACKENDS defining the same tool name have no resolution rule yet —
 * leave that until a second backend actually exists.
 *
 * Schema source: one covered vault's live `tools/list` stands in for all
 * installed vaults. Assumption — same vault-core version across vaults
 * (`parachute upgrade` keeps them together). Candidates are tried in
 * highest-verb order; only if every covered vault is down do we degrade
 * to hub-native only.
 */
import { COMPOSED_VERB_RANK, type ComposedVaultVerb } from "@openparachute/door-contract";
import type { AccountVaultMeta } from "./account-api.ts";
import {
  hopCacheKey,
  lookupHopToken,
  parseAccountMcpHopTtl,
  storeHopToken,
} from "./account-mcp-hop.ts";
import {
  ACCOUNT_MCP_CLIENT_ID,
  type AccountMcpPrincipal,
  type AccountToolContext,
  AccountToolError,
  FANOUT_TIMEOUT_MS,
  HUB_NATIVE_TOOL_NAMES,
  installedVaults,
  resolveCoverage,
  verbForVault,
} from "./account-mcp.ts";
import { signAccessToken } from "./jwt-sign.ts";

export interface ListedMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ModuleMcpBackend {
  readonly id: string;
  listTools(ctx: AccountToolContext): Promise<readonly ListedMcpTool[]>;
  callTool(name: string, args: Record<string, unknown>, ctx: AccountToolContext): Promise<unknown>;
}

const UNION_CATALOG_LINE =
  "Catalog caveat: advertised from one covered vault's live list (highest verb this connection holds). Calling this against a different covered vault may return Unknown tool if that vault grants a lower verb.";

const VAULT_FIELD_DESCRIPTION =
  "Target vault by name. Omit on query-notes to fan the query across every reachable vault; required on every other vault-shaped tool.";

const listCache = new WeakMap<AccountToolContext, Promise<readonly ListedMcpTool[]>>();

export function vaultMcpUrl(vault: AccountVaultMeta): string {
  const origin =
    typeof vault.port === "number" && vault.port > 0
      ? `http://127.0.0.1:${vault.port}`
      : vault.url.replace(/\/vault\/[^/]+\/?$/, "");
  return `${origin.replace(/\/$/, "")}/vault/${vault.name}/mcp`;
}

/** NIP-01 pubkey shape: 32 bytes, lowercase hex. */
const NOSTR_PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * The attribution claim carried on a vault hop token (hub#937).
 *
 * Several agents, each holding their own Nostr key, routinely link to ONE hub
 * user. The hop token's `sub` is that shared user, so a vault writing
 * `created_by`/`last_updated_by` from `sub` cannot tell two agents apart.
 * This names the key that actually signed the NIP-98 request; the vault turns
 * it into `created_via`/`last_updated_via` = `nostr:<pubkey>`.
 *
 * Why nested under `permissions` rather than a top-level claim:
 * `@openparachute/scope-guard` (what vault, scribe, and agent all validate
 * with) returns a FIXED claim surface — `sub`, `scopes`, `aud`, `jti`,
 * `client_id`, `vault_scope`, `permissions` — and DROPS everything else. A new
 * top-level claim would be invisible to every consumer until scope-guard cut
 * a release and each one upgraded. `permissions` is scope-guard's documented
 * verbatim passthrough, so it is the one carrier that works today.
 *
 * Emitted ONLY for a NIP-98-authenticated principal. A password / cookie /
 * OAuth Bearer connection has no signing key, and stamping one would fabricate
 * attribution. Contract: parachute-vault `docs/contracts/nostr-principal-attribution.md`.
 */
export function principalAttributionClaims(
  principal: AccountMcpPrincipal,
): { permissions: { principal_pubkey: string } } | null {
  if (principal.authKind !== "nostr") return null;
  const pubkey = principal.pubkey;
  // Defensive: the NIP-98 path only reaches here with a verified event pubkey,
  // but a malformed value must be dropped rather than shipped — the vault
  // fails soft on a bad claim and we should not make it exercise that path.
  if (typeof pubkey !== "string" || !NOSTR_PUBKEY_RE.test(pubkey)) return null;
  return { permissions: { principal_pubkey: pubkey } };
}

export async function mintVaultMcpToken(
  ctx: AccountToolContext,
  vault: AccountVaultMeta,
  verb: ComposedVaultVerb,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const hop = parseAccountMcpHopTtl(env);
  const nowMs = (ctx.now?.() ?? new Date()).getTime();
  const attribution = principalAttributionClaims(ctx.principal);
  // hub#937: the cache key MUST include the signer. Two agents on the same hub
  // user share (userId, vault, verb, issuer), so without this the first
  // agent's token — carrying the first agent's pubkey — would be handed to the
  // second, reintroducing the exact misattribution this change fixes (and
  // silently, since the token is otherwise valid). `null` for non-NIP-98
  // connections keeps their key byte-identical to before.
  const key = hopCacheKey(
    ctx.principal.userId,
    vault.name,
    verb,
    ctx.issuer,
    attribution?.permissions.principal_pubkey ?? null,
  );
  if (hop.reuse) {
    const cached = lookupHopToken(key, nowMs);
    if (cached) return cached;
  }
  const sign = ctx.signToken ?? signAccessToken;
  const minted = await sign(ctx.db, {
    sub: ctx.principal.userId,
    scopes: [`vault:${vault.name}:${verb}`],
    audience: `vault.${vault.name}`,
    clientId: ACCOUNT_MCP_CLIENT_ID,
    issuer: ctx.issuer,
    ttlSeconds: hop.ttlSeconds,
    vaultScope: [vault.name],
    ...(attribution ? { extraClaims: attribution } : {}),
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  });
  if (hop.reuse) {
    storeHopToken(key, minted.token, nowMs + hop.ttlSeconds * 1000, nowMs);
  }
  return minted.token;
}

async function parseJsonRpcResult(res: Response, vaultName: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    let detail = `vault responded ${res.status}`;
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      if (typeof body.error === "string") detail = body.error;
      else if (typeof body.message === "string") detail = body.message;
    } catch {
      // keep status-only detail
    }
    throw new AccountToolError("vault_error", detail, { status: res.status, vault: vaultName });
  }
  let parsed: { result?: unknown; error?: { message?: unknown; code?: unknown } };
  const trimmed = text.trim();
  if (trimmed.startsWith("event:") || trimmed.includes("\ndata:")) {
    const dataLines = [...text.matchAll(/^data:\s*(.*)$/gm)].map((m) => m[1] ?? "");
    const last = dataLines.at(-1);
    if (!last) {
      throw new AccountToolError("vault_error", "empty SSE MCP response", { vault: vaultName });
    }
    parsed = JSON.parse(last) as typeof parsed;
  } else {
    parsed = JSON.parse(text) as typeof parsed;
  }
  if (parsed.error) {
    const msg = typeof parsed.error.message === "string" ? parsed.error.message : "vault MCP error";
    throw new AccountToolError("vault_error", msg, {
      vault: vaultName,
      ...(parsed.error.code !== undefined ? { code: parsed.error.code } : {}),
    });
  }
  return parsed.result;
}

export async function postVaultMcp(
  ctx: AccountToolContext,
  vault: AccountVaultMeta,
  verb: ComposedVaultVerb,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const token = await mintVaultMcpToken(ctx, vault, verb);
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const res = await fetchImpl(vaultMcpUrl(vault), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params ? { params } : {}),
    }),
    signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS),
  });
  return parseJsonRpcResult(res, vault.name);
}

function injectVaultSelector(tool: {
  name: string;
  description?: unknown;
  inputSchema?: unknown;
}): ListedMcpTool {
  const rawSchema =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? (tool.inputSchema as Record<string, unknown>)
      : { type: "object" };
  const properties = {
    ...((rawSchema.properties && typeof rawSchema.properties === "object"
      ? rawSchema.properties
      : {}) as Record<string, unknown>),
    vault: { type: "string", description: VAULT_FIELD_DESCRIPTION },
  };
  const schema: Record<string, unknown> = { ...rawSchema, properties };
  if (tool.name !== "query-notes") {
    const req = Array.isArray(schema.required)
      ? schema.required.filter((x): x is string => typeof x === "string")
      : [];
    if (!req.includes("vault")) schema.required = [...req, "vault"];
  }
  const base = typeof tool.description === "string" ? tool.description : tool.name;
  const description = base.includes("Catalog caveat:") ? base : `${base}\n\n${UNION_CATALOG_LINE}`;
  return { name: tool.name, description, inputSchema: schema };
}

/**
 * Covered vaults, highest verb first, then name. Schema-source tries this
 * order and takes the first `tools/list` that succeeds.
 */
export function schemaSourceCandidates(
  ctx: AccountToolContext,
  vaults: readonly AccountVaultMeta[],
): AccountVaultMeta[] {
  return [...vaults].sort((a, b) => {
    const rank =
      COMPOSED_VERB_RANK[verbForVault(ctx, b.name)] - COMPOSED_VERB_RANK[verbForVault(ctx, a.name)];
    if (rank !== 0) return rank;
    return a.name.localeCompare(b.name);
  });
}

async function listVaultToolsUncached(ctx: AccountToolContext): Promise<readonly ListedMcpTool[]> {
  const coverage = resolveCoverage(ctx.db, ctx.principal, installedVaults(ctx));
  if (coverage.vaults.length === 0) return [];
  for (const vault of schemaSourceCandidates(ctx, coverage.vaults)) {
    try {
      const result = await postVaultMcp(ctx, vault, verbForVault(ctx, vault.name), "tools/list");
      const tools =
        result && typeof result === "object" && Array.isArray((result as { tools?: unknown }).tools)
          ? (result as { tools: unknown[] }).tools
          : null;
      if (!tools) continue;
      return tools
        .filter(
          (t): t is { name: string; description?: unknown; inputSchema?: unknown } =>
            !!t && typeof t === "object" && typeof (t as { name?: unknown }).name === "string",
        )
        .filter((t) => !HUB_NATIVE_TOOL_NAMES.has(t.name))
        .map(injectVaultSelector);
    } catch {
      // Try the next covered vault (highest-verb first). Empty catch continues.
    }
  }
  return [];
}

export function listVaultModuleTools(ctx: AccountToolContext): Promise<readonly ListedMcpTool[]> {
  let pending = listCache.get(ctx);
  if (!pending) {
    pending = listVaultToolsUncached(ctx);
    listCache.set(ctx, pending);
  }
  return pending;
}

function coveredVault(ctx: AccountToolContext, raw: unknown): AccountVaultMeta {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new AccountToolError("invalid_vault", "vault is required.");
  }
  const coverage = resolveCoverage(ctx.db, ctx.principal, installedVaults(ctx));
  const wanted = raw.toLowerCase();
  const hit = coverage.vaults.find((v) => v.name === wanted);
  if (!hit) {
    throw new AccountToolError(
      "vault_not_covered",
      `Vault "${raw}" is not among the vaults this connection can reach.`,
    );
  }
  return hit;
}

function stripVaultArg(args: Record<string, unknown>): Record<string, unknown> {
  const { vault: _vault, ...rest } = args;
  return rest;
}

function notesFromMcpResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    throw new Error("vault MCP result was not an object");
  }
  const rec = result as { isError?: unknown; content?: Array<{ type?: unknown; text?: unknown }> };
  if (rec.isError === true) {
    const text = rec.content?.find((c) => c.type === "text")?.text;
    throw new Error(typeof text === "string" ? text : "query failed");
  }
  const text = rec.content?.find((c) => c.type === "text")?.text;
  if (typeof text !== "string") throw new Error("vault MCP result had no text content");
  return JSON.parse(text) as unknown;
}

async function queryOneVaultMcp(
  ctx: AccountToolContext,
  vault: AccountVaultMeta,
  args: Record<string, unknown>,
): Promise<{ vault: string; notes: unknown } | { vault: string; error: string }> {
  try {
    const result = await postVaultMcp(ctx, vault, "read", "tools/call", {
      name: "query-notes",
      arguments: args,
    });
    return { vault: vault.name, notes: notesFromMcpResult(result) };
  } catch (err) {
    return {
      vault: vault.name,
      error: err instanceof Error ? err.message : "query failed",
    };
  }
}

async function queryNotesOverlay(
  args: Record<string, unknown>,
  ctx: AccountToolContext,
): Promise<{
  vaults_queried: string[];
  results: Array<{ vault: string; notes?: unknown; error?: string }>;
}> {
  const coverage = resolveCoverage(ctx.db, ctx.principal, installedVaults(ctx));
  let targets = coverage.vaults;
  if (typeof args.vault === "string" && args.vault.length > 0) {
    targets = [coveredVault(ctx, args.vault)];
  }
  const stripped = stripVaultArg(args);
  const settled = await Promise.allSettled(targets.map((v) => queryOneVaultMcp(ctx, v, stripped)));
  return {
    vaults_queried: targets.map((v) => v.name),
    results: settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : {
            vault: targets[i]!.name,
            error: s.reason instanceof Error ? s.reason.message : "query failed",
          },
    ),
  };
}

export async function callVaultModuleTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AccountToolContext,
): Promise<unknown> {
  if (name === "query-notes") return queryNotesOverlay(args, ctx);

  const hit = coveredVault(ctx, args.vault);
  const verb = verbForVault(ctx, hit.name);
  return postVaultMcp(ctx, hit, verb, "tools/call", {
    name,
    arguments: stripVaultArg(args),
  });
}

export const vaultModuleBackend: ModuleMcpBackend = {
  id: "vault",
  listTools: listVaultModuleTools,
  callTool: callVaultModuleTool,
};
