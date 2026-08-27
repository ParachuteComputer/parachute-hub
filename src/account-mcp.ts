/**
 * Account-level MCP tools for the self-host hub — the payload behind
 * `/account/mcp`.
 *
 * Cloud's twin lives in the identity worker (`account-mcp.ts`). Coverage tools
 * (list-vaults, create-vault, query-notes) plus hub-only grant-access /
 * revoke-access / list-access (pubkey → one `user_vaults` row). create-note is
 * the first cross-vault write tool: `vault` is required, write is checked
 * per call, a 60s `vault:<name>:write` mint fans to REST. Cloud grants are
 * D1-ownership shaped, not `user_vaults`. Coverage is hub-shaped:
 *
 *   - Bearer is the cloud-shaped connection grant: `account:self:vaults`
 *     (legacy blanket / narrowed) or composed `account:self:vaults:*:<verb>`,
 *     plus `parachute:host:admin` as the operator bypass. REST `account:self:read`
 *     does NOT open this door — that scope lists vaults and usage, not notes.
 *   - NIP-98 is the Buzz path. First-admin → every vault + create. Anyone
 *     else → `user_vaults` ∩ services.json (fail-closed; read verb required).
 *     Auto-provisioned key-only users have no rows → empty list, no create.
 *
 * query-notes fans out through a 60s `vault:<name>:read` mint, the same
 * authority `account-usage.ts` already uses for the friend home tiles. A
 * failed vault becomes that vault's `{ vault, error }` — never a whole-call
 * failure.
 */
import type { Database } from "bun:sqlite";
import {
  ACCOUNT_VAULTS_UNNARROWED,
  COMPOSED_VERB_RANK,
  type ComposedVaultVerb,
  accountVaultsGrant,
  composedAccountGrant,
  composedVerbSatisfies,
} from "@openparachute/door-contract";
import { type AccountVaultMeta, listVaultsWithMeta } from "./account-api.ts";
import { HOST_ADMIN_SCOPE, provisionVault } from "./admin-vaults.ts";
import { GrantError, callerCanAdminVault, grantAccess, listAccess, revokeAccess } from "./grant-access.ts";
import { signAccessToken } from "./jwt-sign.ts";
import { getUserById, isFirstAdmin, vaultVerbsForUserVault } from "./users.ts";

/** Hub account sentinel — account ≡ box. */
export const HUB_ACCOUNT_ID = "self";

/** Per-vault timeout for the query-notes fan-out. */
export const FANOUT_TIMEOUT_MS = 10_000;

/** Per-vault `limit` ceiling on a fan-out query. */
export const MAX_NOTES_LIMIT = 100;

const ACCOUNT_MCP_CLIENT_ID = "parachute-account";
const FANOUT_TOKEN_TTL_SECONDS = 60;

export type AccountMcpAuthKind = "bearer" | "nostr";

export interface AccountConnectionGrant {
  wildcard: ComposedVaultVerb | null;
  vaults: Map<string, ComposedVaultVerb>;
  create: boolean;
}

export interface AccountMcpPrincipal {
  userId: string;
  scopes: string[];
  authKind: AccountMcpAuthKind;
  clientId: string | undefined;
  /** First-admin, or a Bearer that already carries host:admin. */
  isHubAdmin: boolean;
  /** Present on Bearer (null only for NIP-98). host:admin is a synthetic wildcard. */
  grant: AccountConnectionGrant | null;
}

export class AccountToolError extends Error {
  constructor(
    public readonly errorType: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AccountToolError";
  }
}

export interface Coverage {
  covered: "all" | "listed";
  vaults: AccountVaultMeta[];
  names: string[];
  create: boolean;
}

export interface AccountToolContext {
  db: Database;
  issuer: string;
  manifestPath: string;
  principal: AccountMcpPrincipal;
  now?: () => Date;
  runCommand?: (cmd: readonly string[]) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  signToken?: typeof signAccessToken;
}

export interface AccountMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: AccountToolContext): Promise<unknown>;
}

function raiseVaultVerb(
  map: Map<string, ComposedVaultVerb>,
  name: string,
  verb: ComposedVaultVerb,
): void {
  const cur = map.get(name);
  if (!cur || COMPOSED_VERB_RANK[verb] > COMPOSED_VERB_RANK[cur]) map.set(name, verb);
}

/**
 * Unify legacy Wave A `account:<id>:vaults` with the composed grammar.
 * Returns null when the set confers nothing that opens this door.
 */
export function buildAccountConnectionGrant(
  scopes: readonly string[],
  accountId: string = HUB_ACCOUNT_ID,
): AccountConnectionGrant | null {
  const composed = composedAccountGrant(scopes, accountId);
  let wildcard = composed.wildcard;
  const vaults = new Map(composed.vaults);
  let create = composed.create;
  if (scopes.includes(ACCOUNT_VAULTS_UNNARROWED)) {
    create = true;
    if (wildcard === null) wildcard = "read";
  }
  const legacy = accountVaultsGrant(scopes, accountId);
  if (legacy !== null) {
    create = true;
    if ("blanket" in legacy) {
      if (wildcard === null) wildcard = "read";
    } else {
      for (const name of legacy.vaults) raiseVaultVerb(vaults, name, "read");
    }
  }
  if (scopes.includes(HOST_ADMIN_SCOPE)) {
    return { wildcard: "admin", vaults, create: true };
  }
  const opensDoor = wildcard !== null || vaults.size > 0 || create;
  return opensDoor ? { wildcard, vaults, create } : null;
}

function canCreate(principal: AccountMcpPrincipal): boolean {
  if (principal.authKind === "nostr") return principal.isHubAdmin;
  return principal.grant?.create === true;
}

function assignedReadable(
  db: Database,
  userId: string,
  installed: AccountVaultMeta[],
): AccountVaultMeta[] {
  const user = getUserById(db, userId);
  const assigned = new Set(user?.assignedVaults ?? []);
  return installed.filter((v) => {
    if (!assigned.has(v.name)) return false;
    const verbs = vaultVerbsForUserVault(db, userId, v.name);
    return verbs?.includes("read");
  });
}

/**
 * Live coverage. NIP-98 is assignment. Bearer is the connection grant ∩
 * currently installed vaults (and ∩ assignment when the subject is not
 * first-admin). host:admin is unrestricted.
 */
export function resolveCoverage(
  db: Database,
  principal: AccountMcpPrincipal,
  installed: AccountVaultMeta[],
): Coverage {
  if (principal.authKind === "nostr") {
    if (principal.isHubAdmin || isFirstAdmin(db, principal.userId)) {
      return {
        covered: "all",
        vaults: installed,
        names: installed.map((v) => v.name),
        create: true,
      };
    }
    const vaults = assignedReadable(db, principal.userId, installed);
    return { covered: "listed", vaults, names: vaults.map((v) => v.name), create: false };
  }

  const grant = principal.grant;
  const create = grant?.create === true;
  const owned =
    principal.isHubAdmin || isFirstAdmin(db, principal.userId)
      ? installed
      : assignedReadable(db, principal.userId, installed);

  if (!grant || grant.wildcard !== null) {
    const covered = grant?.wildcard !== null || principal.isHubAdmin ? "all" : "listed";
    return { covered, vaults: owned, names: owned.map((v) => v.name), create };
  }
  const vaults = owned.filter((v) => grant.vaults.has(v.name));
  return { covered: "listed", vaults, names: vaults.map((v) => v.name), create };
}

function installedVaults(ctx: AccountToolContext): AccountVaultMeta[] {
  return listVaultsWithMeta(ctx.manifestPath, ctx.issuer);
}

function isUnrestricted(db: Database, principal: AccountMcpPrincipal): boolean {
  return principal.isHubAdmin || isFirstAdmin(db, principal.userId);
}

/**
 * Per-call write check. Opening the account door (list/query) is not write.
 * First-admin / host:admin are unrestricted. Everyone else needs the `write`
 * verb on that vault's `user_vaults` row. A Bearer named subset that does not
 * include the vault cannot write it even if assignment would allow.
 */
export function canWriteVault(
  db: Database,
  principal: AccountMcpPrincipal,
  vaultName: string,
): boolean {
  if (isUnrestricted(db, principal)) return true;
  if (principal.authKind === "bearer" && principal.grant) {
    if (principal.grant.wildcard === "admin") return true;
    if (principal.grant.wildcard === null && !principal.grant.vaults.has(vaultName)) {
      return false;
    }
    const named = principal.grant.vaults.get(vaultName);
    if (named !== undefined && !composedVerbSatisfies(named, "write")) return false;
  }
  return vaultVerbsForUserVault(db, principal.userId, vaultName)?.includes("write") === true;
}

const listVaultsTool: AccountMcpTool = {
  name: "list-vaults",
  description:
    "List the vaults this connection can reach. Returns each vault's name, URL, and version, " +
    "plus whether the grant covers ALL of the hub's vaults or a specific listed subset.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const coverage = resolveCoverage(ctx.db, ctx.principal, installedVaults(ctx));
    return {
      covered: coverage.covered,
      vaults: coverage.vaults.map((v) => ({ name: v.name, url: v.url, version: v.version })),
    };
  },
};

const createVaultTool: AccountMcpTool = {
  name: "create-vault",
  description:
    "Create a new vault on this hub. Returns the new vault's name and URL. " +
    "Does not return a vault token — mint one out of band if you need a credential.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The vault name (lowercase letters, numbers, hyphens, and underscores).",
      },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (!canCreate(ctx.principal)) {
      throw new AccountToolError(
        "create_not_granted",
        "This connection was not granted permission to create vaults.",
      );
    }
    const rawName = typeof args.name === "string" ? args.name : "";
    const provisioned = await provisionVault(rawName, {
      issuer: ctx.issuer,
      manifestPath: ctx.manifestPath,
      ...(ctx.runCommand ? { runCommand: ctx.runCommand } : {}),
    });
    if (!provisioned.ok) {
      const message = provisioned.message;
      if (provisioned.status === 400 && /reserved/i.test(message)) {
        throw new AccountToolError("reserved", "That name is reserved. Please choose another.");
      }
      if (provisioned.status === 400) {
        throw new AccountToolError(
          "invalid_name",
          "Use lowercase letters, numbers, hyphens, and underscores.",
        );
      }
      throw new AccountToolError("server_error", message);
    }
    if (!provisioned.created) {
      throw new AccountToolError("vault_taken", "That vault name is already taken.");
    }
    return { name: provisioned.entry.name, url: provisioned.entry.url };
  },
};

type VaultQueryEntry = { vault: string; notes: unknown } | { vault: string; error: string };

function buildNotesQuery(args: Record<string, unknown>): string {
  const p = new URLSearchParams();
  if (typeof args.search === "string" && args.search.length > 0) p.set("search", args.search);
  const rawTags = Array.isArray(args.tag)
    ? args.tag
    : typeof args.tag === "string"
      ? [args.tag]
      : [];
  for (const t of rawTags) if (typeof t === "string" && t.length > 0) p.append("tag", t);
  if (args.metadata && typeof args.metadata === "object")
    p.set("metadata", JSON.stringify(args.metadata));
  const rawLimit =
    typeof args.limit === "number"
      ? args.limit
      : typeof args.limit === "string"
        ? Number.parseInt(args.limit, 10)
        : undefined;
  if (rawLimit !== undefined && Number.isFinite(rawLimit)) {
    const clamped = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_NOTES_LIMIT);
    p.set("limit", String(clamped));
  }
  return p.toString();
}

async function queryOneVault(
  ctx: AccountToolContext,
  vault: AccountVaultMeta,
  args: Record<string, unknown>,
): Promise<VaultQueryEntry> {
  const sign = ctx.signToken ?? signAccessToken;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const qs = buildNotesQuery(args);
  const minted = await sign(ctx.db, {
    sub: ctx.principal.userId,
    scopes: [`vault:${vault.name}:read`],
    audience: `vault.${vault.name}`,
    clientId: ACCOUNT_MCP_CLIENT_ID,
    issuer: ctx.issuer,
    ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    vaultScope: [vault.name],
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  });
  const origin =
    typeof vault.port === "number" && vault.port > 0
      ? `http://127.0.0.1:${vault.port}`
      : vault.url.replace(/\/vault\/[^/]+\/?$/, "");
  const url = `${origin.replace(/\/$/, "")}/vault/${vault.name}/api/notes${qs ? `?${qs}` : ""}`;
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${minted.token}`, accept: "application/json" },
    signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = `vault responded ${res.status}`;
    try {
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.error === "string") detail = body.error;
    } catch {
      // Non-JSON error body — keep the status-only detail.
    }
    return { vault: vault.name, error: detail };
  }
  const notes = await res.json();
  return { vault: vault.name, notes };
}

async function fanOut(
  ctx: AccountToolContext,
  targets: AccountVaultMeta[],
  args: Record<string, unknown>,
): Promise<VaultQueryEntry[]> {
  const settled = await Promise.allSettled(targets.map((v) => queryOneVault(ctx, v, args)));
  return settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : {
          vault: targets[i]!.name,
          error: s.reason instanceof Error ? s.reason.message : "query failed",
        },
  );
}

const queryNotesTool: AccountMcpTool = {
  name: "query-notes",
  description:
    "Search notes across the vaults this connection can reach. Omit `vault` to fan the query out " +
    "(results are grouped per vault, not ranked across vaults); pass `vault` to target one. " +
    "Supports keyword `search`, `tag` and `metadata` filters, and `limit`.",
  inputSchema: {
    type: "object",
    properties: {
      vault: {
        type: "string",
        description:
          "Target a single vault by name. Must be one of the reachable vaults. Omit to query all.",
      },
      search: { type: "string", description: "Full-text keyword query." },
      tag: {
        type: ["string", "array"],
        items: { type: "string" },
        description: "Restrict to notes carrying this tag (or any of these tags).",
      },
      metadata: {
        type: "object",
        description: 'Structured metadata filters, e.g. {"status":{"eq":"open"}}.',
      },
      limit: { type: "number", description: "Maximum notes per vault (default 50)." },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const coverage = resolveCoverage(ctx.db, ctx.principal, installedVaults(ctx));
    let targets = coverage.vaults;
    if (typeof args.vault === "string" && args.vault.length > 0) {
      const wanted = args.vault.toLowerCase();
      const hit = coverage.vaults.find((v) => v.name === wanted);
      if (!hit) {
        throw new AccountToolError(
          "vault_not_covered",
          `Vault "${args.vault}" is not among the vaults this connection can reach.`,
        );
      }
      targets = [hit];
    }
    const results = await fanOut(ctx, targets, args);
    return { vaults_queried: targets.map((v) => v.name), results };
  },
};

function noteWriteBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof args.content === "string") body.content = args.content;
  if (typeof args.path === "string") body.path = args.path;
  if (Array.isArray(args.tags)) body.tags = args.tags;
  if (args.metadata && typeof args.metadata === "object") body.metadata = args.metadata;
  if (typeof args.if_exists === "string") body.if_exists = args.if_exists;
  return body;
}

async function postNoteToVault(
  ctx: AccountToolContext,
  vault: AccountVaultMeta,
  body: Record<string, unknown>,
): Promise<unknown> {
  const sign = ctx.signToken ?? signAccessToken;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const minted = await sign(ctx.db, {
    sub: ctx.principal.userId,
    scopes: [`vault:${vault.name}:write`],
    audience: `vault.${vault.name}`,
    clientId: ACCOUNT_MCP_CLIENT_ID,
    issuer: ctx.issuer,
    ttlSeconds: FANOUT_TOKEN_TTL_SECONDS,
    vaultScope: [vault.name],
    ...(ctx.now !== undefined ? { now: ctx.now } : {}),
  });
  const origin =
    typeof vault.port === "number" && vault.port > 0
      ? `http://127.0.0.1:${vault.port}`
      : vault.url.replace(/\/vault\/[^/]+\/?$/, "");
  const url = `${origin.replace(/\/$/, "")}/vault/${vault.name}/api/notes`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${minted.token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = `vault responded ${res.status}`;
    try {
      const errBody = (await res.json()) as Record<string, unknown>;
      if (typeof errBody.error === "string") detail = errBody.error;
    } catch {
      // Non-JSON error body — keep the status-only detail.
    }
    throw new AccountToolError("vault_error", detail, { status: res.status, vault: vault.name });
  }
  return res.json();
}

const createNoteTool: AccountMcpTool = {
  name: "create-note",
  description:
    "Create a note in one vault this connection can write. `vault` is required — this " +
    "door does not invent a target. Does not return a vault token.",
  inputSchema: {
    type: "object",
    properties: {
      vault: {
        type: "string",
        description: "Target vault by name. Must be a reachable vault this connection can write.",
      },
      content: { type: "string", description: "Note body (markdown)." },
      path: { type: "string", description: "Note path (e.g. 'Log/hello')." },
      tags: { type: "array", items: { type: "string" }, description: "Tags to apply." },
      metadata: { type: "object", description: "Metadata fields to set." },
      if_exists: {
        type: "string",
        enum: ["error", "ignore", "update", "replace"],
        description: "What to do when `path` already names a note. Default error.",
      },
    },
    required: ["vault"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    if (typeof args.vault !== "string" || args.vault.length === 0) {
      throw new AccountToolError("invalid_vault", "vault is required.");
    }
    const coverage = resolveCoverage(ctx.db, ctx.principal, installedVaults(ctx));
    const wanted = args.vault.toLowerCase();
    const hit = coverage.vaults.find((v) => v.name === wanted);
    if (!hit) {
      throw new AccountToolError(
        "vault_not_covered",
        `Vault "${args.vault}" is not among the vaults this connection can reach.`,
      );
    }
    if (!canWriteVault(ctx.db, ctx.principal, hit.name)) {
      throw new AccountToolError(
        "write_not_granted",
        `This connection cannot write vault "${hit.name}".`,
      );
    }
    const note = await postNoteToVault(ctx, hit, noteWriteBody(args));
    return { vault: hit.name, note };
  },
};

function installedNameSet(ctx: AccountToolContext): Set<string> {
  return new Set(installedVaults(ctx).map((v) => v.name));
}

function throwGrant(err: unknown): never {
  if (err instanceof GrantError) throw new AccountToolError(err.errorType, err.message);
  throw err;
}

const grantAccessTool: AccountMcpTool = {
  name: "grant-access",
  description:
    "Give a Nostr pubkey access to one vault. Creates a key-only hub user if the " +
    "pubkey is not yet linked. Writes one user_vaults row — does not replace the " +
    "target's other vaults. Role is read or write and cannot be granted unless you " +
    "can admin that vault.",
  inputSchema: {
    type: "object",
    properties: {
      pubkey: {
        type: "string",
        description: "64-character lowercase-hex x-only Nostr public key.",
      },
      vault: { type: "string", description: "Installed vault name." },
      role: {
        type: "string",
        enum: ["read", "write"],
        description: 'Access role. "write" is full vault authority (read/write/admin).',
      },
    },
    required: ["pubkey", "vault", "role"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    try {
      return await grantAccess(
        ctx.db,
        ctx.principal,
        args,
        installedNameSet(ctx),
        ctx.now ?? (() => new Date()),
      );
    } catch (err) {
      throwGrant(err);
    }
  },
};

const revokeAccessTool: AccountMcpTool = {
  name: "revoke-access",
  description:
    "Remove one vault grant from a Nostr pubkey. Leaves the hub user and any other " +
    "vaults in place. Refuses the hub owner (unrestricted by construction).",
  inputSchema: {
    type: "object",
    properties: {
      pubkey: {
        type: "string",
        description: "64-character lowercase-hex x-only Nostr public key.",
      },
      vault: { type: "string", description: "Installed vault name." },
    },
    required: ["pubkey", "vault"],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    try {
      return revokeAccess(ctx.db, ctx.principal, args, installedNameSet(ctx));
    } catch (err) {
      throwGrant(err);
    }
  },
};

const listAccessTool: AccountMcpTool = {
  name: "list-access",
  description:
    "List pubkey → vault grants this connection can admin. Omit `vault` for every " +
    "such grant; pass it to filter to one vault. Password-only users without a " +
    "linked key are not included.",
  inputSchema: {
    type: "object",
    properties: {
      vault: {
        type: "string",
        description: "Restrict to one installed vault. Omit to list every vault you can admin.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, ctx) {
    try {
      return listAccess(ctx.db, ctx.principal, args, installedNameSet(ctx));
    } catch (err) {
      throwGrant(err);
    }
  },
};

/** Order is stable so `tools/list` is deterministic. */
export const ACCOUNT_MCP_TOOLS: readonly AccountMcpTool[] = [
  listVaultsTool,
  createVaultTool,
  queryNotesTool,
  createNoteTool,
  grantAccessTool,
  revokeAccessTool,
  listAccessTool,
];

/**
 * Catalog filtered by what this principal can actually call. Admin-shaped
 * tools (grant/revoke/list-access) and write tools are invisible below the
 * verb, not just refused. Same pattern as the vault door.
 */
export function toolsForPrincipal(ctx: AccountToolContext): readonly AccountMcpTool[] {
  const installed = installedVaults(ctx);
  const coverage = resolveCoverage(ctx.db, ctx.principal, installed);
  const canWrite = coverage.vaults.some((v) => canWriteVault(ctx.db, ctx.principal, v.name));
  const canAdmin = coverage.vaults.some((v) =>
    callerCanAdminVault(ctx.db, ctx.principal, v.name),
  );
  const create = canCreate(ctx.principal);
  return ACCOUNT_MCP_TOOLS.filter((t) => {
    if (t.name === "create-vault") return create;
    if (t.name === "create-note") return canWrite;
    if (t.name === "grant-access" || t.name === "revoke-access" || t.name === "list-access") {
      return canAdmin;
    }
    return true;
  });
}
