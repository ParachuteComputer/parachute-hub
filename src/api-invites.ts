/**
 * `/api/invites*` — admin endpoints for one-time invite links (design
 * 2026-06-04-individual-users-and-vault-operations.md §7).
 *
 *   POST   /api/invites        create an invite → { invite, url } (host:admin)
 *                              The `url` carries the raw token and is the ONLY
 *                              time it's retrievable — the hub stores only its
 *                              sha256.
 *   GET    /api/invites        list invites with derived status (host:admin)
 *   DELETE /api/invites/:id     revoke a pending invite by sha256 hash (host:admin)
 *
 * Auth: every endpoint requires a bearer carrying `parachute:host:admin` —
 * the same gate as `/api/users` and `/vaults`. The SPA mints one via
 * `/admin/host-admin-token` from the session cookie.
 *
 * Wire shape is snake_case (matches `/api/users`). An invite's raw token
 * NEVER appears in a GET/list response — only in the POST-create `url`.
 */
import type { Database } from "bun:sqlite";
import { type AdminAuthError, adminAuthErrorResponse, requireScope } from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import {
  DEFAULT_INVITE_TTL_SECONDS,
  type Invite,
  type InviteStatus,
  findInviteByHash,
  inviteStatus,
  issueInvite,
  listInvites,
  revokeInvite,
} from "./invites.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";

export interface ApiInvitesDeps {
  db: Database;
  /** Hub origin — JWT `iss` validation AND the base for the redemption URL. */
  issuer: string;
  manifestPath?: string;
  now?: () => Date;
}

/** Roles an invite may grant. `'write'` = owner (full vault admin); `'read'` = read-only (shared). */
const ALLOWED_ROLES = new Set(["read", "write"]);
/** Cap an invite TTL so a typo can't mint a ~forever link. 90 days. */
const MAX_INVITE_TTL_SECONDS = 90 * 24 * 60 * 60;

interface InviteWireShape {
  /** sha256 hash — the stable id for list/revoke. NOT the raw token. */
  id: string;
  status: InviteStatus;
  vault_name: string | null;
  role: string;
  provision_vault: boolean;
  default_mirror: string | null;
  expires_at: string;
  used_at: string | null;
  redeemed_user_id: string | null;
  revoked_at: string | null;
  created_at: string;
}

function toWire(invite: Invite, status: InviteStatus): InviteWireShape {
  return {
    id: invite.tokenHash,
    status,
    vault_name: invite.vaultName,
    role: invite.role,
    provision_vault: invite.provisionVault,
    default_mirror: invite.defaultMirror,
    expires_at: invite.expiresAt,
    used_at: invite.usedAt,
    redeemed_user_id: invite.redeemedUserId,
    revoked_at: invite.revokedAt,
    created_at: invite.createdAt,
  };
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function redeemUrl(issuer: string, rawToken: string): string {
  const base = issuer.replace(/\/$/, "");
  return `${base}/account/setup/${rawToken}`;
}

interface CreateInviteBody {
  vaultName: string | null;
  role: string;
  provisionVault: boolean;
  defaultMirror: string | null;
  expiresInSeconds: number;
}

interface ParseErr {
  ok: false;
  status: number;
  error: string;
  description: string;
}

async function parseCreateBody(
  req: Request,
): Promise<{ ok: true; body: CreateInviteBody } | ParseErr> {
  const ctype = req.headers.get("content-type") ?? "";
  // Allow an empty body — every field has a default. Only enforce JSON when
  // a body is actually present.
  let raw: unknown = {};
  if (ctype.toLowerCase().includes("application/json")) {
    try {
      const text = await req.text();
      raw = text.trim() === "" ? {} : JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: `invalid JSON body: ${msg}`,
      };
    }
  }
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "request body must be a JSON object",
    };
  }
  const obj = raw as Record<string, unknown>;

  // vault_name — optional. null/omitted = redeemer names their own vault.
  let vaultName: string | null = null;
  const rawVault =
    Object.hasOwn(obj, "vault_name") && obj.vault_name !== undefined
      ? obj.vault_name
      : Object.hasOwn(obj, "vaultName") && obj.vaultName !== undefined
        ? obj.vaultName
        : undefined;
  if (rawVault !== undefined && rawVault !== null) {
    if (typeof rawVault !== "string" || rawVault.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: '"vault_name" must be a non-empty string or null',
      };
    }
    if (!VAULT_NAME_CHARSET_RE.test(rawVault)) {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description:
          "vault name must contain only lowercase letters, numbers, hyphens, and underscores",
      };
    }
    vaultName = rawVault;
  }

  // role — default 'write' (owner).
  let role = "write";
  const rawRole = obj.role;
  if (rawRole !== undefined && rawRole !== null) {
    if (typeof rawRole !== "string" || !ALLOWED_ROLES.has(rawRole)) {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: '"role" must be "read" or "write"',
      };
    }
    role = rawRole;
  }

  // provision_vault — default true (the primary flow).
  let provisionVault = true;
  const rawProvision =
    Object.hasOwn(obj, "provision_vault") && obj.provision_vault !== undefined
      ? obj.provision_vault
      : Object.hasOwn(obj, "provisionVault") && obj.provisionVault !== undefined
        ? obj.provisionVault
        : undefined;
  if (rawProvision !== undefined) {
    if (typeof rawProvision !== "boolean") {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: '"provision_vault" must be a boolean',
      };
    }
    provisionVault = rawProvision;
  }

  // default_mirror — optional 'internal' | 'off'.
  let defaultMirror: string | null = null;
  const rawMirror =
    Object.hasOwn(obj, "default_mirror") && obj.default_mirror !== undefined
      ? obj.default_mirror
      : Object.hasOwn(obj, "defaultMirror") && obj.defaultMirror !== undefined
        ? obj.defaultMirror
        : undefined;
  if (rawMirror !== undefined && rawMirror !== null) {
    if (rawMirror !== "internal" && rawMirror !== "off") {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: '"default_mirror" must be "internal" or "off"',
      };
    }
    defaultMirror = rawMirror;
  }

  // expires_in — seconds; default 7 days; capped at 90 days.
  let expiresInSeconds = DEFAULT_INVITE_TTL_SECONDS;
  const rawExpiry =
    Object.hasOwn(obj, "expires_in") && obj.expires_in !== undefined
      ? obj.expires_in
      : Object.hasOwn(obj, "expiresIn") && obj.expiresIn !== undefined
        ? obj.expiresIn
        : undefined;
  if (rawExpiry !== undefined && rawExpiry !== null) {
    if (typeof rawExpiry !== "number" || !Number.isFinite(rawExpiry) || rawExpiry <= 0) {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: '"expires_in" must be a positive number of seconds',
      };
    }
    if (rawExpiry > MAX_INVITE_TTL_SECONDS) {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: `"expires_in" must be ≤ ${MAX_INVITE_TTL_SECONDS} seconds (90 days)`,
      };
    }
    expiresInSeconds = Math.floor(rawExpiry);
  }

  return { ok: true, body: { vaultName, role, provisionVault, defaultMirror, expiresInSeconds } };
}

/** POST /api/invites — create an invite, return the single-emit URL + token. */
export async function handleCreateInvite(req: Request, deps: ApiInvitesDeps): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  let authUserId: string;
  try {
    // `requireScope` returns the validated claims; the admin's `sub` is the
    // `created_by` audit anchor (guaranteed present — it throws otherwise).
    const auth = await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
    authUserId = auth.sub;
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const parsed = await parseCreateBody(req);
  if (!parsed.ok) return jsonError(parsed.status, parsed.error, parsed.description);
  const { vaultName, role, provisionVault, defaultMirror, expiresInSeconds } = parsed.body;

  // SECURITY: a pinned vault_name with provision_vault=false would assign the
  // redeeming user to a PRE-EXISTING vault as owner-admin — a cross-tenant
  // breach, since the owner-vs-shared role split isn't built. Shared-vault
  // invites aren't supported yet, so reject this combination outright (defense
  // in depth — the redeem path rejects it too). The supported shapes are:
  // provision_vault=true (+ optional pinned name → provisions THAT name), or
  // provision_vault=false with NO name (account-only, assignedVaults=[]).
  if (vaultName !== null && !provisionVault) {
    return jsonError(
      400,
      "invalid_request",
      "shared-vault invites (provision_vault=false with a vault_name) aren't supported yet — omit vault_name for an account-only invite, or set provision_vault=true to provision a new vault",
    );
  }

  const issued = issueInvite(deps.db, {
    createdBy: authUserId,
    vaultName,
    role,
    provisionVault,
    defaultMirror,
    expiresInSeconds,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const status = inviteStatus(issued.invite, (deps.now ?? (() => new Date()))());
  return new Response(
    JSON.stringify({
      invite: toWire(issued.invite, status),
      // Single-emit: the raw token only ever appears here.
      token: issued.rawToken,
      url: redeemUrl(deps.issuer, issued.rawToken),
    }),
    { status: 201, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

/** GET /api/invites — list invites, newest first, status-annotated. */
export async function handleListInvites(req: Request, deps: ApiInvitesDeps): Promise<Response> {
  if (req.method !== "GET") return jsonError(405, "method_not_allowed", "use GET");
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const now = (deps.now ?? (() => new Date()))();
  const invites = listInvites(deps.db, now).map((i) => toWire(i, i.status));
  return new Response(JSON.stringify({ invites }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** DELETE /api/invites/:id — revoke a pending invite by its sha256 hash. */
export async function handleRevokeInvite(
  req: Request,
  id: string,
  deps: ApiInvitesDeps,
): Promise<Response> {
  if (req.method !== "DELETE") return jsonError(405, "method_not_allowed", "use DELETE");
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const existing = findInviteByHash(deps.db, id);
  if (!existing) return jsonError(404, "not_found", `no invite with id "${id}"`);
  const now = (deps.now ?? (() => new Date()))();
  const revoked = revokeInvite(deps.db, id, now);
  if (!revoked) {
    // Already redeemed or revoked — nothing to do, but report the terminal
    // state so the SPA can refresh rather than silently swallowing.
    const status = inviteStatus(existing, now);
    return jsonError(409, "invite_not_pending", `invite is already ${status}`);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
