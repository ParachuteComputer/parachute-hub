/**
 * `POST/GET/DELETE /admin/channels` — one-action vault-channel provisioning.
 *
 * The backend half of "frictionless channel setup": make "add a vault-backed
 * channel" ONE hub action that provisions everything, leaning on the hub's
 * existing token-minting + operator session so the human never mints tokens,
 * invents secrets, or edits YAML.
 *
 * Gated EXACTLY like `/admin/channel-token` + `/admin/vault-admin-token`: a
 * cookie-gated operator session pinned to the first admin (`isFirstAdmin`).
 * Friends pinned to a vault use the OAuth flow for their assigned scopes; they
 * don't provision channels through this endpoint.
 *
 * The hub is the JWT issuer — every token here is minted off the operator's
 * session via `signAccessToken` (the same machinery `admin-channel-token.ts` +
 * `admin-vault-admin-token.ts` use). NO secrets are invented (the channel runs
 * JWT-only — no `webhookSecret`).
 *
 * ## POST /admin/channels — body `{ channelName, vault }`
 *
 * All steps are server-to-server over loopback (the hub knows the channel's +
 * vault's loopback ports from services.json). The PUBLIC origin (`hubOrigin`) is
 * used only for the webhook URL the vault calls back on + the copy-paste connect
 * lines the UI shows; the internal vault/channel calls use loopback.
 *
 *   1. Validate `vault` exists in services.json → 400 if not.
 *   2. Mint `vault:<vault>:write` — the channel writes replies + ensureSchema.
 *   3. Mint `channel:admin` (call the channel config API) + `channel:send` (the
 *      trigger's `action.auth.bearer`).
 *   4. POST `<channel>/api/channels` (Bearer channel:admin) — write channels.json
 *      + hot-add the channel. JWT-only (NO webhookSecret).
 *   5. GET `<channel>/.parachute/config` → take `triggerTemplate`; substitute the
 *      channel name into `name`/`when`, set `action.webhook` to the hub-proxied
 *      inbound URL, and set `action.auth.bearer = <channel:send>`.
 *   6. Mint `vault:<vault>:admin`; POST `<vault>/vault/<vault>/api/triggers`
 *      (Bearer vault:admin) with the substituted trigger.
 *   7. Return `{ ok, channel, vault, connect: { mcpAdd, launch } }`.
 *
 * Idempotent / re-runnable: every downstream step is an upsert (channel config
 * replace, trigger upsert), so re-POSTing the same channel completes a partial
 * provision rather than erroring. A failing step returns a clear error naming
 * the step.
 *
 * ## GET /admin/channels — proxy the channel config API list. Never tokens.
 *
 * ## DELETE /admin/channels/:name — tear down both sides (best-effort):
 *   - DELETE `<channel>/api/channels/:name`
 *   - DELETE `<vault>/vault/<vault>/api/triggers/channel_inbound_<name>`
 *   reports partial failures.
 */
import type { Database } from "bun:sqlite";
import { signAccessToken } from "./jwt-sign.ts";
import { findSession, parseSessionCookie } from "./sessions.ts";
import { isFirstAdmin } from "./users.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";

/** Short TTL — these tokens are used immediately for the provisioning calls. */
const PROVISION_TOKEN_TTL_SECONDS = 60;
/**
 * The channel:send token is the trigger's persisted `action.auth.bearer` — it
 * must outlive the request (the vault re-presents it on every inbound webhook).
 * Long-lived to match the daemon's headless-credential posture (~90d).
 */
const TRIGGER_BEARER_TTL_SECONDS = 90 * 24 * 60 * 60;
const CHANNEL_AUDIENCE = "channel";
const PROVISION_CLIENT_ID = "parachute-hub-spa";

/**
 * Channel + trigger name charset. The channel name lands in a services.json
 * key, a vault trigger name (`channel_inbound_<name>`), a URL path segment, and
 * an MCP server name — keep it to a conservative slug to close injection across
 * all of them. Mirrors the slug shape the channel launcher enforces.
 */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export interface ChannelsDeps {
  db: Database;
  /** Public hub origin — webhook URL + connect lines + minted-token `iss`. */
  hubOrigin: string;
  /** Loopback origin for the channel daemon, e.g. `http://127.0.0.1:1941`, or null when channel isn't installed. */
  channelOrigin: string | null;
  /**
   * Resolve a vault's loopback origin (e.g. `http://127.0.0.1:1940`) from
   * services.json, or `null` when no vault by that name is installed. Read at
   * request time so a freshly-created vault provisions without a hub restart.
   */
  resolveVaultOrigin: (vaultName: string) => string | null;
  /** Test seam — `globalThis.fetch` in production. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to the real `signAccessToken`. */
  signToken?: typeof signAccessToken;
  /** Test seam for the clock. */
  now?: () => Date;
}

/** Shape of the prescribed trigger the channel serves at `/.parachute/config`. */
interface TriggerTemplate {
  name: string;
  events: string[];
  when: Record<string, unknown>;
  action: {
    webhook: string;
    send?: string;
    auth?: { bearer?: string };
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export async function handleChannels(
  req: Request,
  /** Path after `/admin/channels` — `""` for the collection, `/<name>` for an item. */
  subPath: string,
  deps: ChannelsDeps,
): Promise<Response> {
  // --- Operator gate (mirrors admin-channel-token / admin-vault-admin-token).
  const sid = parseSessionCookie(req.headers.get("cookie"));
  const session = sid ? findSession(deps.db, sid) : null;
  if (!session) {
    return jsonError(401, "unauthenticated", "no admin session — sign in at /login first");
  }
  if (!isFirstAdmin(deps.db, session.userId)) {
    return jsonError(
      403,
      "not_admin",
      "channel provisioning is restricted to the hub admin — your account home is at /account/",
    );
  }

  if (deps.channelOrigin === null) {
    return jsonError(
      503,
      "channel_unavailable",
      "the channel module is not installed on this hub",
    );
  }

  const method = req.method;
  const itemName = subPath.startsWith("/") ? decodeURIComponent(subPath.slice(1)) : "";

  if (itemName === "" && method === "GET") {
    return listChannels(deps);
  }
  if (itemName === "" && method === "POST") {
    return provisionChannel(req, session.userId, deps);
  }
  if (itemName !== "" && method === "DELETE") {
    return teardownChannel(itemName, session.userId, deps);
  }
  return jsonError(405, "method_not_allowed", "use POST/GET on /admin/channels or DELETE on /admin/channels/:name");
}

// ---------------------------------------------------------------------------
// POST — provision
// ---------------------------------------------------------------------------

async function provisionChannel(
  req: Request,
  userId: string,
  deps: ChannelsDeps,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const channelOrigin = deps.channelOrigin as string; // null-checked by caller

  let body: { channelName?: unknown; vault?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "invalid_request", "request body must be JSON");
  }
  const channelName = typeof body.channelName === "string" ? body.channelName.trim() : "";
  const vault = typeof body.vault === "string" ? body.vault.trim() : "";

  if (!CHANNEL_NAME_RE.test(channelName)) {
    return jsonError(400, "invalid_request", `channelName "${channelName}" is not a valid identifier`);
  }
  if (!VAULT_NAME_CHARSET_RE.test(vault)) {
    return jsonError(400, "invalid_request", `vault "${vault}" is not a valid identifier`);
  }

  // Step 1 — vault must exist in services.json.
  const vaultOrigin = deps.resolveVaultOrigin(vault);
  if (vaultOrigin === null) {
    return jsonError(400, "unknown_vault", `no vault named "${vault}" in this hub`);
  }

  // Steps 2–3 — mint the three tokens off the operator's session.
  let vaultWriteToken: string;
  let channelAdminToken: string;
  let channelSendToken: string;
  try {
    vaultWriteToken = (await mint(deps, userId, {
      scopes: [`vault:${vault}:write`],
      audience: `vault.${vault}`,
      vaultScope: [vault],
      ttlSeconds: TRIGGER_BEARER_TTL_SECONDS, // the channel keeps this for its lifetime
    })).token;
    channelAdminToken = (await mint(deps, userId, {
      scopes: ["channel:admin"],
      audience: CHANNEL_AUDIENCE,
      vaultScope: [],
      ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
    })).token;
    channelSendToken = (await mint(deps, userId, {
      scopes: ["channel:send"],
      audience: CHANNEL_AUDIENCE,
      vaultScope: [],
      ttlSeconds: TRIGGER_BEARER_TTL_SECONDS, // persisted as the trigger bearer
    })).token;
  } catch (err) {
    return stepError("mint_tokens", err);
  }

  // Step 4 — write the channel (upsert: POST replaces an existing entry). NO
  // webhookSecret — JWT-only.
  try {
    const res = await fetchImpl(`${channelOrigin}/api/channels`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${channelAdminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: channelName,
        transport: "vault",
        config: { vault, vaultUrl: vaultOrigin, token: vaultWriteToken },
      }),
    });
    if (!res.ok) {
      return stepError("channel_config", await describeRemote(res));
    }
  } catch (err) {
    return stepError("channel_config", err);
  }

  // Step 5 — fetch the channel's prescribed trigger template + substitute.
  let trigger: TriggerTemplate;
  try {
    const res = await fetchImpl(`${channelOrigin}/.parachute/config`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      return stepError("channel_config_fetch", await describeRemote(res));
    }
    const cfg = (await res.json()) as { triggerTemplate?: TriggerTemplate };
    if (!cfg.triggerTemplate || typeof cfg.triggerTemplate !== "object") {
      return stepError(
        "channel_config_fetch",
        new Error("channel /.parachute/config returned no triggerTemplate"),
      );
    }
    trigger = substituteTrigger(cfg.triggerTemplate, channelName, deps.hubOrigin, channelSendToken);
  } catch (err) {
    return stepError("channel_config_fetch", err);
  }

  // Step 6 — register the trigger on the vault (upsert: POST replaces by name).
  try {
    const vaultAdminToken = (await mint(deps, userId, {
      scopes: [`vault:${vault}:admin`],
      audience: `vault.${vault}`,
      vaultScope: [vault],
      ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
    })).token;
    const res = await fetchImpl(`${vaultOrigin}/vault/${vault}/api/triggers`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${vaultAdminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(trigger),
    });
    if (!res.ok) {
      return stepError("vault_trigger", await describeRemote(res));
    }
  } catch (err) {
    return stepError("vault_trigger", err);
  }

  // Step 7 — connect lines for the UI. Built from the PUBLIC origin so the
  // copy-paste one-liners work over the expose, not just loopback.
  const origin = deps.hubOrigin.replace(/\/+$/, "");
  return json(200, {
    ok: true,
    channel: channelName,
    vault,
    connect: {
      mcpAdd: `claude mcp add --transport http --scope user channel-${channelName} ${origin}/channel/mcp/${channelName}`,
      launch: `claude --dangerously-load-development-channels=server:channel-${channelName} --dangerously-skip-permissions`,
    },
  });
}

/**
 * Substitute the channel name + hub origin + send-bearer into the channel's
 * prescribed trigger template. The template carries `<channel>` placeholders in
 * `name`/`when` and `<hub-origin>` in `action.webhook`, plus an (empty/absent)
 * `action.auth.bearer` for the hub to fill.
 */
export function substituteTrigger(
  template: TriggerTemplate,
  channelName: string,
  hubOrigin: string,
  sendBearer: string,
): TriggerTemplate {
  const origin = hubOrigin.replace(/\/+$/, "");
  const replace = (s: string): string =>
    s.replace(/<channel>/g, channelName).replace(/<hub-origin>/g, origin);

  // Deep-walk strings, substituting placeholders. Keeps the channel as the
  // owner of the trigger SHAPE — the hub only fills the placeholders + bearer.
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return replace(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };

  const substituted = walk(template) as TriggerTemplate;
  // Fill the inbound webhook URL with the hub-proxied path + the channel:send
  // bearer the vault re-presents on each inbound callback.
  substituted.action = {
    ...substituted.action,
    webhook: `${origin}/channel/api/vault/inbound`,
    auth: { ...(substituted.action.auth ?? {}), bearer: sendBearer },
  };
  return substituted;
}

// ---------------------------------------------------------------------------
// GET — list (proxy channel config API; never tokens)
// ---------------------------------------------------------------------------

async function listChannels(deps: ChannelsDeps): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const channelOrigin = deps.channelOrigin as string;
  // List is operator-only metadata; mint a short channel:admin to read it.
  // (The channel GET /api/channels gates on channel:admin and never returns
  // secrets — see parachute-channel daemon-config-api.)
  let adminToken: string;
  try {
    adminToken = (await mintAdminListToken(deps)).token;
  } catch (err) {
    return stepError("mint_tokens", err);
  }
  try {
    const res = await fetchImpl(`${channelOrigin}/api/channels`, {
      headers: { authorization: `Bearer ${adminToken}`, accept: "application/json" },
    });
    if (!res.ok) {
      return stepError("channel_config", await describeRemote(res));
    }
    const listed = (await res.json()) as unknown;
    return json(200, { ok: true, channels: listed });
  } catch (err) {
    return stepError("channel_config", err);
  }
}

// ---------------------------------------------------------------------------
// DELETE — teardown both sides (best-effort)
// ---------------------------------------------------------------------------

async function teardownChannel(
  channelName: string,
  userId: string,
  deps: ChannelsDeps,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const channelOrigin = deps.channelOrigin as string;

  if (!CHANNEL_NAME_RE.test(channelName)) {
    return jsonError(400, "invalid_request", `channel name "${channelName}" is not a valid identifier`);
  }

  const errors: { step: string; detail: string }[] = [];

  // Channel side — DELETE the channel config entry.
  try {
    const adminToken = (await mint(deps, userId, {
      scopes: ["channel:admin"],
      audience: CHANNEL_AUDIENCE,
      vaultScope: [],
      ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
    })).token;
    const res = await fetchImpl(`${channelOrigin}/api/channels/${encodeURIComponent(channelName)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    // 404 = already gone → treat as success (idempotent teardown).
    if (!res.ok && res.status !== 404) {
      errors.push({ step: "channel_config", detail: await remoteDetail(res) });
    }
  } catch (err) {
    errors.push({ step: "channel_config", detail: errMsg(err) });
  }

  // Vault side — DELETE the inbound trigger. We don't know which vault the
  // channel was bound to from the name alone, so derive it from the channel
  // listing (best-effort) and delete `channel_inbound_<name>` on that vault.
  const vault = await resolveChannelVault(channelName, deps).catch(() => null);
  if (vault) {
    const vaultOrigin = deps.resolveVaultOrigin(vault);
    if (vaultOrigin) {
      try {
        const vaultAdminToken = (await mint(deps, userId, {
          scopes: [`vault:${vault}:admin`],
          audience: `vault.${vault}`,
          vaultScope: [vault],
          ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
        })).token;
        const triggerName = `channel_inbound_${channelName}`;
        const res = await fetchImpl(
          `${vaultOrigin}/vault/${vault}/api/triggers/${encodeURIComponent(triggerName)}`,
          { method: "DELETE", headers: { authorization: `Bearer ${vaultAdminToken}` } },
        );
        if (!res.ok && res.status !== 404) {
          errors.push({ step: "vault_trigger", detail: await remoteDetail(res) });
        }
      } catch (err) {
        errors.push({ step: "vault_trigger", detail: errMsg(err) });
      }
    } else {
      errors.push({ step: "vault_trigger", detail: `vault "${vault}" no longer installed` });
    }
  } else {
    // Couldn't determine the bound vault — the channel side is torn down, but
    // the trigger may linger. Surface it as a partial failure, not a hard error.
    errors.push({
      step: "vault_trigger",
      detail: "could not determine the bound vault — its inbound trigger may need manual removal",
    });
  }

  if (errors.length > 0) {
    return json(207, { ok: false, channel: channelName, partial: true, errors });
  }
  return json(200, { ok: true, channel: channelName });
}

/**
 * Best-effort: read the channel listing to find which vault `channelName` is
 * bound to. Returns null when the channel isn't listed or carries no vault.
 */
async function resolveChannelVault(channelName: string, deps: ChannelsDeps): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const channelOrigin = deps.channelOrigin as string;
  const adminToken = (await mintAdminListToken(deps)).token;
  const res = await fetchImpl(`${channelOrigin}/api/channels`, {
    headers: { authorization: `Bearer ${adminToken}`, accept: "application/json" },
  });
  if (!res.ok) return null;
  const parsed = (await res.json()) as { channels?: Array<{ name?: string; vault?: string }> };
  const list = Array.isArray(parsed?.channels) ? parsed.channels : [];
  const match = list.find((c) => c?.name === channelName);
  return match && typeof match.vault === "string" ? match.vault : null;
}

// ---------------------------------------------------------------------------
// Mint helpers
// ---------------------------------------------------------------------------

interface MintSpec {
  scopes: string[];
  audience: string;
  vaultScope: string[];
  ttlSeconds: number;
}

async function mint(deps: ChannelsDeps, userId: string, spec: MintSpec) {
  const sign = deps.signToken ?? signAccessToken;
  return sign(deps.db, {
    sub: userId,
    scopes: spec.scopes,
    audience: spec.audience,
    clientId: PROVISION_CLIENT_ID,
    issuer: deps.hubOrigin,
    ttlSeconds: spec.ttlSeconds,
    vaultScope: spec.vaultScope,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}

/** A short channel:admin token, used for the read-only list/lookup paths. */
async function mintAdminListToken(deps: ChannelsDeps) {
  const sign = deps.signToken ?? signAccessToken;
  // List/lookup happens with no per-request user in scope beyond the gate; use
  // a fixed operator subject. The session gate already authorized the caller.
  return sign(deps.db, {
    sub: "operator",
    scopes: ["channel:admin"],
    audience: CHANNEL_AUDIENCE,
    clientId: PROVISION_CLIENT_ID,
    issuer: deps.hubOrigin,
    ttlSeconds: PROVISION_TOKEN_TTL_SECONDS,
    vaultScope: [],
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** A clear "step X failed" error so a partial provision never returns ambiguously. */
function stepError(step: string, cause: unknown): Response {
  return json(502, {
    error: "provision_failed",
    step,
    error_description: `provisioning failed at step "${step}": ${errMsg(cause)}`,
  });
}

function errMsg(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

/** Build an Error describing a non-ok downstream response (status + short body). */
async function describeRemote(res: Response): Promise<Error> {
  return new Error(await remoteDetail(res));
}

async function remoteDetail(res: Response): Promise<string> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 300);
  } catch {
    // ignore — status alone is informative enough
  }
  return `downstream ${res.status}${text ? `: ${text}` : ""}`;
}
