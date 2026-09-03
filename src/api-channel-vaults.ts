/**
 * `/api/channel-vault` + `/api/channel-vaults*` — the HTTP surface over the
 * `channel_vaults` binding table (migration v23).
 *
 * PR 1 of the design "Channel-attached vaults — membership becomes access".
 * Two surfaces with deliberately different gates:
 *
 *   GET    /api/channel-vault?relay=&channel=   the READ side. Any
 *          authenticated principal (NIP-98 or Bearer), no membership check.
 *          A vault NAME is not a secret — every read of the vault itself is
 *          separately ACL'd — and an agent has to learn the name before it can
 *          ask for anything. 404 when the channel is unbound.
 *
 *   GET    /api/channel-vaults[?vault=]          operator surfaces, all gated on
 *   POST   /api/channel-vaults                   `parachute:host:admin` — the
 *   DELETE /api/channel-vaults?relay=&channel=   SAME gate as POST /vaults. v1
 *          is operator-only on purpose (design §1, "Who creates it"): a channel
 *          must not be able to annex a hub's storage, so the authority to
 *          attach is the authority to create a vault, not membership of the
 *          channel.
 *
 * POST attaches a channel to a vault that is ALREADY installed on this hub; it
 * never creates one. Naming an uninstalled vault is a 400 — run
 * `parachute vault create <name>` first, then attach. Keeping provisioning out
 * of the attach path is deliberate: PR 1 ships the binding and nothing else,
 * and an attach that can conjure storage has a far larger blast radius than
 * one that can only point at storage the operator already made. It also keeps
 * this endpoint free of the supervisor/services.json orchestration that
 * `POST /vaults` owns, so there is exactly one way to create a vault.
 *
 * Not here (PRs 4–5): the roster fetcher, the reconciler, and any write to
 * `user_vaults`. This endpoint set never grants anything, and never creates
 * anything.
 */
import type { Database } from "bun:sqlite";
import {
  type AdminAuthError,
  adminAuthErrorResponse,
  requireAuthenticated,
  requireScope,
} from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE, listVaultInstanceNames } from "./admin-vaults.ts";
import {
  type ChannelVault,
  defaultChannelVaultName,
  getChannelVault,
  listChannelVaults,
  normalizeChannelId,
  normalizeRelayHost,
  removeChannelVault,
  upsertChannelVault,
} from "./channel-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { RESERVED_VAULT_NAMES, VAULT_NAME_CHARSET_RE } from "./vault-name.ts";

export interface ChannelVaultsDeps {
  db: Database;
  /** Hub origin — JWT `iss` validation, and the origin a created vault is described against. */
  issuer: string;
  /**
   * SET of origins the hub answers on (loopback ∪ expose-state ∪ platform ∪
   * per-request `issuer`), built via `buildHubBoundOrigins` — same
   * cross-origin tolerance every other `/api/*` gate has (hub#516 parity).
   */
  knownIssuers?: readonly string[];
  /** Override the services.json path. Defaults to `~/.parachute/services.json`. */
  manifestPath?: string;
  /** Test seam for the clock. */
  now?: () => Date;
}

/** One binding on the wire. snake_case, matching `/api/vault-caps` + `/api/users`. */
export interface ChannelVaultWire {
  relay_host: string;
  channel_id: string;
  vault: string;
  mode: string;
  relay_self_pubkey: string | null;
  synced_at: string | null;
  created_at: string;
}

function toWire(b: ChannelVault): ChannelVaultWire {
  return {
    relay_host: b.relayHost,
    channel_id: b.channelId,
    vault: b.vault,
    mode: b.mode,
    relay_self_pubkey: b.relaySelfPubkey,
    synced_at: b.syncedAt,
    created_at: b.createdAt,
  };
}

/**
 * `no-store` on every response, matching every other `/api/*` surface: these
 * answers change the moment an operator attaches or detaches, and a cached
 * 404 would keep an agent reporting "unbound" after the binding landed.
 */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

/**
 * Validate a vault instance name at this edge with EXACTLY the rules
 * `provisionVault` applies (charset + reserved set), so a name this endpoint
 * accepts is a name the create path accepts. Returns an error message or null.
 */
function vaultNameProblem(name: string): string | null {
  if (!VAULT_NAME_CHARSET_RE.test(name)) {
    return "vault name must contain only lowercase letters, numbers, hyphens, and underscores";
  }
  if (RESERVED_VAULT_NAMES.has(name)) return `"${name}" is a reserved vault name`;
  return null;
}

interface Target {
  relayHost: string;
  channelId: string;
}

type TargetResult = { ok: true; target: Target } | { ok: false; response: Response };

/**
 * Pull + normalize `(relay, channel)` from the query string. `relay` is
 * lower-cased and scheme-stripped so the hub and parachute-mcp agree on one
 * key; both refuse anything that isn't a single path segment.
 */
function targetFromQuery(url: URL): TargetResult {
  const relayHost = normalizeRelayHost(url.searchParams.get("relay"));
  if (!relayHost) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_request",
        "`relay` is required and must be a single host (no path, no whitespace)",
      ),
    };
  }
  const channelId = normalizeChannelId(url.searchParams.get("channel"));
  if (!channelId) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_request",
        "`channel` is required and must be a single path segment",
      ),
    };
  }
  return { ok: true, target: { relayHost, channelId } };
}

/**
 * GET /api/channel-vault?relay=&channel= — "which vault backs this channel?"
 *
 * Gated on authentication ONLY: any NIP-98 principal or hub Bearer. There is no
 * membership check because the hub cannot verify one (a NIP-98 request carries
 * no proof of channel membership — see the design's "What the hub can actually
 * verify today"), and because the answer is a name rather than data.
 */
export async function handleGetChannelVault(
  req: Request,
  deps: ChannelVaultsDeps,
): Promise<Response> {
  if (req.method !== "GET") return jsonError(405, "method_not_allowed", "use GET");
  try {
    await requireAuthenticated(deps.db, req, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const target = targetFromQuery(new URL(req.url));
  if (!target.ok) return target.response;

  const binding = getChannelVault(deps.db, target.target.relayHost, target.target.channelId);
  if (!binding) {
    return jsonError(404, "not_found", "no vault is attached to that channel on this hub");
  }
  return json(200, {
    vault: binding.vault,
    mode: binding.mode,
    synced_at: binding.syncedAt,
  });
}

/** GET /api/channel-vaults[?vault=] — every binding (host:admin). */
export async function handleListChannelVaults(
  req: Request,
  deps: ChannelVaultsDeps,
): Promise<Response> {
  if (req.method !== "GET") return jsonError(405, "method_not_allowed", "use GET");
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const vaultFilter = new URL(req.url).searchParams.get("vault") ?? undefined;
  const rows = listChannelVaults(deps.db, vaultFilter);
  return json(200, { channel_vaults: rows.map(toWire) });
}

interface AttachBody {
  relay?: unknown;
  channel?: unknown;
  vault?: unknown;
}

/**
 * POST /api/channel-vaults — attach a channel to a vault (host:admin).
 *
 * Body: `{ relay, channel, vault? }`.
 *
 *   - `vault` omitted → `ch-<first-8-of-channel>` (design §1, "Naming").
 *   - The vault MUST already be installed on this hub. An uninstalled name is a
 *     400: this route binds, it does not provision. Checking against
 *     services.json — the same source `POST /vaults` re-reads after a create —
 *     also means a typo'd name fails loudly instead of writing a binding that
 *     points at nothing.
 *
 * Re-attaching the same channel to the same vault is an idempotent no-op (200,
 * `created: false`). Re-attaching to a DIFFERENT vault is a 409, not a silent
 * rebind — moving a channel means detaching first, deliberately. There is no
 * `--force`: a rebind silently moves every future member grant to another
 * vault, which is exactly the kind of thing that should cost two commands.
 */
export async function handleAttachChannelVault(
  req: Request,
  deps: ChannelVaultsDeps,
): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }

  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return jsonError(400, "invalid_request", "Content-Type must be application/json");
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(400, "invalid_request", `invalid JSON body: ${msg}`);
  }
  if (!raw || typeof raw !== "object") {
    return jsonError(400, "invalid_request", "request body must be a JSON object");
  }
  const body = raw as AttachBody;

  const relayHost = normalizeRelayHost(typeof body.relay === "string" ? body.relay : undefined);
  if (!relayHost) {
    return jsonError(
      400,
      "invalid_request",
      "`relay` is required and must be a single host (no path, no whitespace)",
    );
  }
  const channelId = normalizeChannelId(typeof body.channel === "string" ? body.channel : undefined);
  if (!channelId) {
    return jsonError(
      400,
      "invalid_request",
      "`channel` is required and must be a single path segment",
    );
  }
  if (body.vault !== undefined && typeof body.vault !== "string") {
    return jsonError(400, "invalid_request", "`vault` must be a string when present");
  }
  const vault =
    typeof body.vault === "string" && body.vault.trim() !== ""
      ? body.vault.trim()
      : defaultChannelVaultName(channelId);
  const problem = vaultNameProblem(vault);
  if (problem) return jsonError(400, "invalid_request", problem);

  // Already bound? Same vault is the idempotent no-op; a different vault is a
  // conflict the operator has to resolve with an explicit detach.
  const existing = getChannelVault(deps.db, relayHost, channelId);
  if (existing) {
    if (existing.vault === vault) {
      return json(200, { ...toWire(existing), created: false });
    }
    return jsonError(
      409,
      "already_bound",
      `channel ${channelId} on ${relayHost} is already attached to vault "${existing.vault}" — detach it first`,
    );
  }

  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  if (!listVaultInstanceNames(manifestPath).has(vault)) {
    return jsonError(
      400,
      "vault_not_found",
      `vault "${vault}" is not installed on this hub — create it with \`parachute vault create ${vault}\` first`,
    );
  }

  const binding = upsertChannelVault(deps.db, { relayHost, channelId, vault }, deps.now);
  return json(201, { ...toWire(binding), created: true });
}

/**
 * DELETE /api/channel-vaults?relay=&channel= — drop a binding (host:admin).
 *
 * Removes the ROW only. The vault, and anything already granted on it, are
 * untouched: destroying a vault is `DELETE /vaults/<name>` and its cascade.
 * Idempotent — deleting an absent binding is a 200 with `removed: false`.
 */
export async function handleDetachChannelVault(
  req: Request,
  deps: ChannelVaultsDeps,
): Promise<Response> {
  if (req.method !== "DELETE") return jsonError(405, "method_not_allowed", "use DELETE");
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const target = targetFromQuery(new URL(req.url));
  if (!target.ok) return target.response;

  const before = getChannelVault(deps.db, target.target.relayHost, target.target.channelId);
  const removed = removeChannelVault(deps.db, target.target.relayHost, target.target.channelId);
  return json(200, {
    relay_host: target.target.relayHost,
    channel_id: target.target.channelId,
    vault: before?.vault ?? null,
    removed,
  });
}
