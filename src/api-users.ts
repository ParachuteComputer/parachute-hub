/**
 * `/api/users*` — admin endpoints for managing hub user accounts.
 *
 * Multi-user Phase 1, PR 2 of 5. Design:
 * [`parachute.computer/design/2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/).
 * Tracker: hub#252. Builds on PR 1 (hub#279) which shipped migration v8 +
 * the `validateUsername` / `validatePassword` validators this layer wires
 * through.
 *
 * Surfaces:
 *
 *   GET    /api/users             list users (host:admin)
 *   POST   /api/users             create user (host:admin)
 *   DELETE /api/users/:id         hard-delete user (host:admin)
 *   GET    /api/users/vaults      vault-name list for the assigned-vault
 *                                 dropdown (host:admin)
 *
 * Wire shape is snake_case (matches `/api/grants`, `/api/auth/tokens`).
 * Responses never include `password_hash` — hashes never leave the DB.
 *
 * Phase 1 deliberately ships only list / create / delete. Editing a user
 * (reassign vault, reset password) is Phase 2 work — Phase 1's admin
 * recovery shape is "delete + re-create" per the design doc's §6.
 *
 * Auth: every endpoint requires a bearer token carrying the
 * `parachute:host:admin` scope. Same gate as `/api/grants`, `/vaults`,
 * and the destructive `/api/modules/:short/*` actions. The SPA mints
 * one via `/admin/host-admin-token` from the session cookie; the SPA's
 * `lib/auth.ts` caches it in module-scoped memory (never `localStorage`).
 *
 * First-admin-undeletable: enforced server-side via
 * `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`. Per design §7
 * the safety rail is absolute — Phase 1 has no role model, so the
 * first-created admin is *the* admin by construction. A malicious or
 * buggy SPA bypassing the row-level disabled-button can't get past
 * the API check.
 */
import type { Database } from "bun:sqlite";
import { type AdminAuthError, adminAuthErrorResponse, requireScope } from "./admin-auth.ts";
import { HOST_ADMIN_SCOPE } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import {
  PASSWORD_MAX_LEN,
  type User,
  UsernameTakenError,
  createUser,
  deleteUser,
  getUserById,
  getUserByUsernameCI,
  listUsers,
  validatePassword,
  validateUsername,
} from "./users.ts";
import { listVaultNamesFromPath } from "./vault-names.ts";

export interface ApiUsersDeps {
  db: Database;
  /** Hub origin — JWT `iss` validation. */
  issuer: string;
  /** Override services.json path. Defaults to `~/.parachute/services.json`. */
  manifestPath?: string;
}

/**
 * Wire shape for a user row. Mirrors the DB columns but renames for
 * snake_case-on-the-wire camelCase-in-TS: `password_changed`,
 * `assigned_vault`, `created_at`. **`password_hash` is never present**
 * — it's the one column that must not leak.
 */
export interface UserWireShape {
  id: string;
  username: string;
  password_changed: boolean;
  assigned_vault: string | null;
  created_at: string;
}

function toWire(u: User): UserWireShape {
  return {
    id: u.id,
    username: u.username,
    password_changed: u.passwordChanged,
    assigned_vault: u.assignedVault,
    created_at: u.createdAt,
  };
}

function jsonError(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** GET /api/users — list users, ordered by `created_at ASC`. */
export async function handleListUsers(req: Request, deps: ApiUsersDeps): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const users = listUsers(deps.db).map(toWire);
  return new Response(JSON.stringify({ users }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

interface CreateUserBody {
  username: string;
  password: string;
  assignedVault: string | null;
}

interface ParseOk {
  ok: true;
  body: CreateUserBody;
}
interface ParseErr {
  ok: false;
  status: number;
  error: string;
  description: string;
}

async function parseCreateBody(req: Request): Promise<ParseOk | ParseErr> {
  const ctype = req.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: "Content-Type must be application/json",
    };
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: `invalid JSON body: ${msg}`,
    };
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
  const username = obj.username;
  if (typeof username !== "string" || username.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: '"username" must be a non-empty string',
    };
  }
  const password = obj.password;
  if (typeof password !== "string" || password.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: '"password" must be a non-empty string',
    };
  }
  // Cap incoming password length BEFORE any validator or argon2id touches
  // it. Argon2id over an arbitrarily-large body is a CPU-DoS shape: a
  // 1MB password would burn ~seconds of single-thread time. The
  // `PASSWORD_MAX_LEN` const from PR 1 (256 chars) is comfortably above
  // any human passphrase (Diceware 8-word is ~55 chars). 413 is the
  // canonical RFC 7231 status for "request entity too large" — the
  // body itself is in-bounds but a specific field exceeds policy.
  if (password.length > PASSWORD_MAX_LEN) {
    return {
      ok: false,
      status: 413,
      error: "password_too_long",
      description: `password length must be ≤ ${PASSWORD_MAX_LEN} characters`,
    };
  }
  // `assigned_vault` is optional — omitted (undefined) or explicit null
  // both mean "no restriction (admin-level access)." Empty string is
  // rejected as a confused client send (would otherwise persist as ""
  // and never resolve in services.json).
  let assignedVault: string | null = null;
  if (Object.hasOwn(obj, "assignedVault")) {
    const v = obj.assignedVault;
    if (v === null) {
      assignedVault = null;
    } else if (typeof v === "string" && v.length > 0) {
      assignedVault = v;
    } else if (typeof v !== "undefined") {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: '"assignedVault" must be a non-empty string or null',
      };
    }
  }
  return { ok: true, body: { username, password, assignedVault } };
}

/** POST /api/users — create user. */
export async function handleCreateUser(req: Request, deps: ApiUsersDeps): Promise<Response> {
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", "use POST");
  }
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const parsed = await parseCreateBody(req);
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.error, parsed.description);
  }
  const { username, password, assignedVault } = parsed.body;

  // PR 1's username validator — charset + length + reserved-word check.
  const u = validateUsername(username);
  if (!u.valid) {
    const description = describeUsernameReason(u.reason);
    return jsonError(400, "invalid_username", description);
  }
  // PR 1's password validator — 12-char floor only.
  const p = validatePassword(password);
  if (!p.valid) {
    return jsonError(
      400,
      "invalid_password",
      "password must be at least 12 characters (passphrase-friendly; no complexity rules)",
    );
  }

  // Case-insensitive uniqueness check — the validator pins lowercase
  // for new inputs, but a legacy mixed-case row in the DB shouldn't be
  // shadowed by an accidental same-letters-different-case new user.
  if (getUserByUsernameCI(deps.db, username) !== null) {
    return jsonError(409, "username_taken", `username "${username}" is already in use`);
  }

  // Validate `assigned_vault` against the live services.json vault list.
  // A stale name (vault since removed) is rejected at create time per
  // design §security/`assigned_vault validation`. NULL means "no
  // restriction" and skips the check.
  if (assignedVault !== null) {
    const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
    const known = new Set(listVaultNamesFromPath(manifestPath));
    if (!known.has(assignedVault)) {
      return jsonError(
        400,
        "assigned_vault_not_found",
        `assigned_vault "${assignedVault}" is not registered in services.json`,
      );
    }
  }

  // Persist. The admin-created path lands `passwordChanged: false` so the
  // user gets force-redirected through `/account/change-password` on
  // first sign-in (PR 3). The wizard's first-admin path and the env-
  // seed path both set `passwordChanged: true` explicitly — neither of
  // those touches this endpoint. `allowMulti: true` because Phase 1 is
  // the whole point — `createUser`'s single-user guard would otherwise
  // 500 here once the first admin exists.
  try {
    const created = await createUser(deps.db, username, password, {
      allowMulti: true,
      passwordChanged: false,
      assignedVault,
    });
    return new Response(JSON.stringify({ user: toWire(created) }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    // Race: another POST landed between our CI check and createUser's
    // INSERT and snagged the username. Surface as the same 409.
    if (err instanceof UsernameTakenError) {
      return jsonError(409, "username_taken", err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return jsonError(500, "server_error", `failed to create user: ${msg}`);
  }
}

/** DELETE /api/users/:id — hard-delete + token revocation + session/grant cleanup. */
export async function handleDeleteUser(
  req: Request,
  userId: string,
  deps: ApiUsersDeps,
): Promise<Response> {
  if (req.method !== "DELETE") {
    return jsonError(405, "method_not_allowed", "use DELETE");
  }
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const target = getUserById(deps.db, userId);
  if (!target) {
    return jsonError(404, "not_found", `no user with id "${userId}"`);
  }

  // First-admin-undeletable. The earliest-created row is the wizard or
  // env-seeded admin by construction — Phase 1 has no role model, so
  // the first admin is *the* admin. Deleting them would self-lock the
  // hub. Per design §7 the API returns 403 with `first_admin_undeletable`
  // (the design doc says 409; aligning to 403 here because the resource
  // exists and the request is forbidden by policy rather than blocked
  // by a state conflict — RFC 7231 §6.5.3 fits cleaner than §6.5.8.
  // Either is defensible; the wire `error` string is the part the SPA
  // matches on for the "first admin can't be deleted" surface).
  const firstAdminRow = deps.db
    .query<{ id: string }, []>("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
    .get();
  if (firstAdminRow && firstAdminRow.id === userId) {
    return jsonError(
      403,
      "first_admin_undeletable",
      "the first-created admin cannot be deleted (would self-lock the hub)",
    );
  }

  // `deleteUser` (users.ts) atomically revokes the user's tokens
  // (`tokens.revoked_at = now`, then NULLs `user_id` so the FK doesn't
  // block the parent delete; backfills `subject` with the username so
  // the audit trail isn't anchored to a vanished primary key), drops
  // their sessions + grants (both have non-cascading FKs on user_id),
  // and finally deletes the users row. Idempotent — false return path
  // happens only if the row vanished between `getUserById` and this
  // call, which we treat as a race-tolerant 204.
  const removed = deleteUser(deps.db, userId);
  if (!removed) {
    // Race: row deleted by a concurrent request. Operator's intent
    // (no such user) is already satisfied — same shape as the grant-
    // revoke race in `admin-grants.ts`.
    return new Response(null, { status: 204 });
  }
  console.log(`user deleted: id=${userId} username=${target.username}`);
  return new Response(null, { status: 204 });
}

/**
 * GET /api/users/vaults — vault-name list for the assigned-vault
 * dropdown. Same `parachute:host:admin` scope gate as the other
 * `/api/users*` endpoints. Returns `{ vaults: string[] }` (sorted) so
 * the SPA can populate the dropdown without a second roundtrip.
 *
 * This is the canonical surface for "which vaults could a user be
 * pinned to?" — PR 4's OAuth issuer reads through the same
 * services.json source.
 */
export async function handleListVaults(req: Request, deps: ApiUsersDeps): Promise<Response> {
  if (req.method !== "GET") {
    return jsonError(405, "method_not_allowed", "use GET");
  }
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
  const vaults = listVaultNamesFromPath(manifestPath);
  return new Response(JSON.stringify({ vaults }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function describeUsernameReason(reason: "format" | "length" | "reserved"): string {
  switch (reason) {
    case "length":
      return "username must be 2-32 characters long";
    case "format":
      return "username must contain only lowercase letters, digits, hyphens, and underscores ([a-z0-9_-])";
    case "reserved":
      return "username is reserved (admin, root, system, setup, parachute, hub)";
  }
}
