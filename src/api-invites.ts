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
 *
 * v15 (DEMO-PREP Workstream B) extends POST /api/invites with `max_uses`
 * (multi-use public-signup links, default 1 = single-use) and
 * `vault_cap_bytes` (per-vault storage cap stamped at provision, B4). A
 * multi-use PROVISIONING link with no explicit `vault_cap_bytes` auto-defaults
 * to ~1 GB (DEFAULT_VAULT_CAP_BYTES) so a public link never provisions
 * uncapped by omission; single-use friends links stay uncapped unless opted
 * in. The list/create wire shape gains `max_uses`, `used_count`, `email`
 * (latest redeemer, B2), and `vault_cap_bytes`. `expires_in` already bounded
 * the link lifetime (B1's expiry). A multi-use link can't pre-name a username
 * or pin a single new vault name (every seat past the first would collide —
 * rejected at mint).
 */
import type { Database } from "bun:sqlite";
import { type AdminAuthError, adminAuthErrorResponse, requireScope } from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { setSetting } from "./hub-settings.ts";
import {
  DEFAULT_INVITE_TTL_SECONDS,
  type Invite,
  type InviteStatus,
  findInviteByHash,
  inviteStatus,
  issueInvite,
  listInvites,
  revokeInvite,
  usernameReservedByPendingInvite,
} from "./invites.ts";
import { getUserByUsernameCI, validateUsername } from "./users.ts";
import { DEFAULT_VAULT_CAP_BYTES } from "./vault-caps.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";
import { listVaultNamesFromPath } from "./vault-names.ts";

export interface ApiInvitesDeps {
  db: Database;
  /** Hub origin — JWT `iss` validation AND the base for the redemption URL. */
  issuer: string;
  /**
   * SET of origins the hub answers on (loopback ∪ expose-state ∪ platform ∪
   * per-request `issuer`), built via `buildHubBoundOrigins`. The bearer's
   * `iss` is validated against THIS set rather than the single `issuer`, so a
   * credential minted under a still-valid prior origin keeps working across an
   * origin switch (hub#516 parity). The redemption URL still uses the single
   * canonical `issuer`. Absent → falls back to `[issuer]` (the prior strict
   * per-request behavior; tests/non-HTTP callers unaffected).
   */
  knownIssuers?: readonly string[];
  manifestPath?: string;
  now?: () => Date;
}

/** Roles an invite may grant. `'write'` = owner (full vault admin); `'read'` = read-only (shared). */
const ALLOWED_ROLES = new Set(["read", "write"]);
/** Cap an invite TTL so a typo can't mint a ~forever link. 90 days. */
const MAX_INVITE_TTL_SECONDS = 90 * 24 * 60 * 60;
/**
 * Cap `max_uses` (v15) so a typo can't mint a runaway public-signup link on a
 * shared box. 1000 is comfortably above any demo cohort while still bounding
 * the abuse surface. The DEMO-PREP shared box uses small values (tens of seats).
 */
const MAX_INVITE_USES = 1000;
/**
 * Ceiling on a per-vault cap an invite may carry (v15, B4). 100 GiB — far
 * above the ~1 GB default, but bounds a fat-finger that would make the cap
 * meaningless on a shared box. The minimum is 1 byte (a positive integer).
 */
const MAX_VAULT_CAP_BYTES = 100 * 1024 * 1024 * 1024;

interface InviteWireShape {
  /** sha256 hash — the stable id for list/revoke. NOT the raw token. */
  id: string;
  status: InviteStatus;
  vault_name: string | null;
  username: string | null;
  role: string;
  provision_vault: boolean;
  default_mirror: string | null;
  /** v15 — how many accounts this link may create (1 = single-use). */
  max_uses: number;
  /** v15 — how many it has created so far. */
  used_count: number;
  /** v15 — most-recent redeemer's email (B2), or null. */
  email: string | null;
  /** v15 — per-vault storage cap to stamp at provision (B4), or null (uncapped). */
  vault_cap_bytes: number | null;
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
    username: invite.username,
    role: invite.role,
    provision_vault: invite.provisionVault,
    default_mirror: invite.defaultMirror,
    max_uses: invite.maxUses,
    used_count: invite.usedCount,
    email: invite.email,
    vault_cap_bytes: invite.vaultCapBytes,
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
  username: string | null;
  role: string;
  provisionVault: boolean;
  defaultMirror: string | null;
  expiresInSeconds: number;
  /** v15 — how many accounts the link may create (default 1 = single-use). */
  maxUses: number;
  /** v15 — per-vault storage cap (bytes) to stamp at provision, or null (uncapped). */
  vaultCapBytes: number | null;
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

  // username — optional. null/omitted = redeemer picks their own. Validated
  // with the SAME vocabulary as /api/users (charset + length + reserved).
  let username: string | null = null;
  const rawUsername =
    Object.hasOwn(obj, "username") && obj.username !== undefined ? obj.username : undefined;
  if (rawUsername !== undefined && rawUsername !== null) {
    if (typeof rawUsername !== "string" || rawUsername.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: '"username" must be a non-empty string or null',
      };
    }
    const u = validateUsername(rawUsername);
    if (!u.valid) {
      return {
        ok: false,
        status: 400,
        error: "invalid_username",
        description:
          u.reason === "length"
            ? "username must be 2-32 characters long"
            : u.reason === "reserved"
              ? "username is reserved (admin, root, system, setup, parachute, hub)"
              : "username must contain only lowercase letters, digits, hyphens, and underscores ([a-z0-9_-])",
      };
    }
    username = u.name;
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

  // max_uses — v15. Default 1 (single-use, the legacy shape). A positive
  // integer ≤ MAX_INVITE_USES. >1 = a multi-use public-signup link.
  let maxUses = 1;
  const rawMaxUses =
    Object.hasOwn(obj, "max_uses") && obj.max_uses !== undefined
      ? obj.max_uses
      : Object.hasOwn(obj, "maxUses") && obj.maxUses !== undefined
        ? obj.maxUses
        : undefined;
  if (rawMaxUses !== undefined && rawMaxUses !== null) {
    if (
      typeof rawMaxUses !== "number" ||
      !Number.isInteger(rawMaxUses) ||
      rawMaxUses < 1 ||
      rawMaxUses > MAX_INVITE_USES
    ) {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: `"max_uses" must be an integer between 1 and ${MAX_INVITE_USES}`,
      };
    }
    maxUses = rawMaxUses;
  }

  // vault_cap_bytes — v15, B4. Optional per-vault storage cap stamped at
  // provision. null/omitted = uncapped (legacy). A positive integer
  // ≤ MAX_VAULT_CAP_BYTES.
  let vaultCapBytes: number | null = null;
  const rawCap =
    Object.hasOwn(obj, "vault_cap_bytes") && obj.vault_cap_bytes !== undefined
      ? obj.vault_cap_bytes
      : Object.hasOwn(obj, "vaultCapBytes") && obj.vaultCapBytes !== undefined
        ? obj.vaultCapBytes
        : undefined;
  if (rawCap !== undefined && rawCap !== null) {
    if (
      typeof rawCap !== "number" ||
      !Number.isInteger(rawCap) ||
      rawCap < 1 ||
      rawCap > MAX_VAULT_CAP_BYTES
    ) {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: `"vault_cap_bytes" must be a positive integer ≤ ${MAX_VAULT_CAP_BYTES} (100 GiB)`,
      };
    }
    vaultCapBytes = rawCap;
  }

  return {
    ok: true,
    body: {
      vaultName,
      username,
      role,
      provisionVault,
      defaultMirror,
      expiresInSeconds,
      maxUses,
      vaultCapBytes,
    },
  };
}

/** POST /api/invites — create an invite, return the single-emit URL + token. */
export async function handleCreateInvite(req: Request, deps: ApiInvitesDeps): Promise<Response> {
  if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
  let authUserId: string;
  try {
    // `requireScope` returns the validated claims; the admin's `sub` is the
    // `created_by` audit anchor (guaranteed present — it throws otherwise).
    const auth = await requireScope(
      deps.db,
      req,
      HOST_ADMIN_SCOPE,
      deps.knownIssuers ?? [deps.issuer],
    );
    authUserId = auth.sub;
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const parsed = await parseCreateBody(req);
  if (!parsed.ok) return jsonError(parsed.status, parsed.error, parsed.description);
  const {
    vaultName,
    username,
    role,
    provisionVault,
    defaultMirror,
    expiresInSeconds,
    maxUses,
    vaultCapBytes,
  } = parsed.body;
  const now = (deps.now ?? (() => new Date()))();

  // Shape gates over the three supported invite shapes:
  //
  //   1. provision_vault=true (+ optional pinned NEW name) — redemption
  //      provisions a fresh vault for the redeemer. Role must be 'write':
  //      the redeemer is the vault's ONLY user, so a read-only sole user
  //      would leave the new vault permanently un-writable.
  //   2. provision_vault=false + vault_name — SHARED-VAULT invite: redemption
  //      assigns the redeemer to the admin's EXISTING vault at `role` ('read'
  //      or 'write'). The vault must exist NOW (services.json) — pinning a
  //      nonexistent name is a typo, not a future reservation. Issuing is
  //      host:admin-gated, the same authority that can already assign any
  //      user to any vault via POST /api/users — the invite only packages
  //      that assignment as a deliverable link. The vault-delete cascade
  //      (`revokeInvitesForVault`) revokes pending shared invites when the
  //      pinned vault is deleted, and the redeem path re-checks existence.
  //   3. provision_vault=false with NO name — account-only (assignedVaults=[]).
  if (provisionVault && role !== "write") {
    return jsonError(
      400,
      "invalid_request",
      'a provisioned vault\'s sole user must hold write — use role "write", or share an existing vault (provision_vault=false + vault_name) for read-only access',
    );
  }

  // Multi-use coherence gates (v15). A link that creates many accounts can't:
  //   - pre-name a username (one name can't be reused across redeemers), or
  //   - pin a single NEW vault name (every redeemer would collide on it —
  //     the redeem path's freshly-created invariant rejects the 2nd onward).
  // Either combination would make every seat past the first dead-on-arrival,
  // so reject at mint. (A multi-use SHARED-vault invite — provision_vault=false
  // + an existing vault_name — IS coherent: many users joining one vault; it's
  // not blocked here.)
  if (maxUses > 1) {
    if (username !== null) {
      return jsonError(
        400,
        "invalid_request",
        "a multi-use link (max_uses > 1) can't pre-name a username — one username can't be shared across signups. Omit \"username\".",
      );
    }
    if (provisionVault && vaultName !== null) {
      return jsonError(
        400,
        "invalid_request",
        'a multi-use provisioning link (max_uses > 1) can\'t pin a single vault name — every signup would collide on it. Omit "vault_name" so each signup names their own vault.',
      );
    }
  }

  // A per-vault cap only applies to a vault THIS link provisions. Pinning a
  // cap on a non-provisioning invite (account-only or shared-existing-vault)
  // has nothing to stamp — reject the contradiction at mint.
  if (vaultCapBytes !== null && !provisionVault) {
    return jsonError(
      400,
      "invalid_request",
      '"vault_cap_bytes" only applies to a provisioning invite (provision_vault=true) — a non-provisioning link has no vault to cap',
    );
  }
  if (vaultName !== null && !provisionVault) {
    const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
    const known = new Set(listVaultNamesFromPath(manifestPath));
    if (!known.has(vaultName)) {
      return jsonError(
        400,
        "vault_not_found",
        `vault "${vaultName}" is not registered on this hub — shared-vault invites must name an existing vault`,
      );
    }
  }

  // Pre-named username: catch collisions at MINT time (the redeem-time check
  // stays authoritative, but an enforced name that's already taken makes the
  // link dead-on-arrival — fail fast for the admin instead).
  if (username !== null) {
    if (getUserByUsernameCI(deps.db, username) !== null) {
      return jsonError(409, "username_taken", `username "${username}" is already in use`);
    }
    if (usernameReservedByPendingInvite(deps.db, username, now)) {
      return jsonError(
        409,
        "username_reserved",
        `username "${username}" is already reserved by another pending invite — revoke that invite first or pick a different name`,
      );
    }
  }

  // Auto-apply the ~1 GB default cap to a PUBLIC-SIGNUP (multi-use,
  // provisioning) link when the admin didn't set one explicitly — the
  // DEMO-PREP decision is "1 GB per vault, configurable," so a multi-use
  // signup link on a shared box should never provision UNcapped by omission.
  // An explicit cap (any value, validated above) is honored as-is; a
  // single-use friends link stays uncapped unless the admin opts in.
  const effectiveVaultCapBytes =
    vaultCapBytes === null && maxUses > 1 && provisionVault
      ? DEFAULT_VAULT_CAP_BYTES
      : vaultCapBytes;

  const issued = issueInvite(deps.db, {
    createdBy: authUserId,
    vaultName,
    username,
    role,
    provisionVault,
    defaultMirror,
    expiresInSeconds,
    maxUses,
    vaultCapBytes: effectiveVaultCapBytes,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  // Q2 (hub-parity P2, the raw-token reality): a multi-use link IS the
  // public signup page (the operator mints it to broadcast) — persisting
  // ITS raw token so the account descriptor can advertise `signup_path`
  // does NOT weaken the hash-only posture of single-use friend invites,
  // which never write this row. The newest public link wins (overwrites any
  // prior value); `activePublicSignupPath` (invites.ts) re-validates
  // liveness on every read and lazily clears a revoked/exhausted/expired one.
  if (maxUses > 1) {
    setSetting(deps.db, "public_signup_token", issued.rawToken, deps.now ?? (() => new Date()));
  }
  const status = inviteStatus(issued.invite, now);
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
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);
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
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.knownIssuers ?? [deps.issuer]);
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
