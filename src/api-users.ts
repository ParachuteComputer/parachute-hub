/**
 * `/api/users*` — admin endpoints for managing hub user accounts.
 *
 * Multi-user Phase 2 PR 2 (per-user multi-vault membership). Design:
 * [`parachute.computer/design/2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/).
 * Tracker: hub#252. Builds on PR 1 (hub#279) which shipped migration v8
 * + the `validateUsername` / `validatePassword` validators, and Phase 2
 * PR 1 (admin password reset). PR 2 lifts the single `assigned_vault`
 * column into the `user_vaults` many-to-many table (migration v10) so a
 * user can have access to multiple vaults.
 *
 * Surfaces:
 *
 *   GET    /api/users                       list users (host:admin)
 *   POST   /api/users                       create user (host:admin)
 *   DELETE /api/users/:id                   hard-delete user (host:admin)
 *   POST   /api/users/:id/reset-password    admin password reset (host:admin)
 *   PATCH  /api/users/:id/vaults            edit a user's vault list (host:admin)
 *   GET    /api/users/vaults                vault-name list for the
 *                                           assigned-vault dropdown
 *                                           (host:admin)
 *
 * Wire shape is snake_case (matches `/api/grants`, `/api/auth/tokens`).
 * Responses never include `password_hash` — hashes never leave the DB.
 *
 * Phase 1 shipped list / create / delete. Phase 2 PR 1 adds admin
 * password reset (this file's `handleResetUserPassword`) — the highest-
 * pain operator UX gap from Phase 1 was "friend forgot their password
 * → operator has to delete+recreate," which is destructive-feeling
 * even though vaults are independent of accounts. Reassign-vault and
 * other edits land in later Phase 2 PRs.
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
  getFirstAdminId,
  getUserById,
  getUserByUsernameCI,
  isFirstAdmin,
  listUsers,
  resetUserPassword,
  setUserVaults,
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
 * Wire shape for a user row. Mirrors the schema but renames for snake_
 * case-on-the-wire / camelCase-in-TS: `password_changed`,
 * `assigned_vaults`, `created_at`. **`password_hash` is never present**
 * — it's the one column that must not leak.
 *
 * `assigned_vaults` replaces the Phase 1 `assigned_vault: string | null`
 * shape (multi-user Phase 2 PR 2). Empty array = "no vault narrowing"
 * for admin posture; a non-empty array lists every vault the user has
 * access to.
 */
export interface UserWireShape {
  id: string;
  username: string;
  password_changed: boolean;
  assigned_vaults: string[];
  created_at: string;
}

function toWire(u: User): UserWireShape {
  return {
    id: u.id,
    username: u.username,
    password_changed: u.passwordChanged,
    assigned_vaults: [...u.assignedVaults],
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
  assignedVaults: string[];
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
  // `assigned_vaults` is optional — omitted, explicit null, or empty
  // array all mean "no vault narrowing." Multi-user Phase 2 PR 2: the
  // wire shape moved from `assigned_vault: string | null` (single name)
  // to `assigned_vaults: string[]` (array). We accept both camelCase
  // `assignedVaults` (current SPA send) and snake_case `assigned_vaults`
  // (defensive — matches the response wire shape). Empty strings in the
  // array are rejected; the validation against services.json runs in
  // the handler.
  let assignedVaults: string[] = [];
  const rawVaults =
    Object.hasOwn(obj, "assignedVaults") && obj.assignedVaults !== undefined
      ? obj.assignedVaults
      : Object.hasOwn(obj, "assigned_vaults") && obj.assigned_vaults !== undefined
        ? obj.assigned_vaults
        : undefined;
  if (rawVaults === null || rawVaults === undefined) {
    assignedVaults = [];
  } else if (Array.isArray(rawVaults)) {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const v of rawVaults) {
      if (typeof v !== "string" || v.length === 0) {
        return {
          ok: false,
          status: 400,
          error: "invalid_request",
          description: '"assigned_vaults" must be an array of non-empty strings',
        };
      }
      if (!seen.has(v)) {
        seen.add(v);
        result.push(v);
      }
    }
    assignedVaults = result;
  } else {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: '"assigned_vaults" must be an array of strings (or omitted / null for none)',
    };
  }
  return { ok: true, body: { username, password, assignedVaults } };
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
  const { username, password, assignedVaults } = parsed.body;

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

  // Validate every `assigned_vaults` entry against the live services.json
  // vault list. A stale name (vault since removed) is rejected at create
  // time. Empty list = "no narrowing" and skips the manifest read.
  if (assignedVaults.length > 0) {
    const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
    const known = new Set(listVaultNamesFromPath(manifestPath));
    const unknown = assignedVaults.filter((v) => !known.has(v));
    if (unknown.length > 0) {
      return jsonError(
        400,
        "assigned_vault_not_found",
        `assigned vault(s) ${unknown.map((n) => `"${n}"`).join(", ")} not registered in services.json`,
      );
    }
  }

  // Persist. The admin-created path lands `passwordChanged: false` so the
  // user gets force-redirected through `/account/change-password` on
  // first sign-in. The wizard's first-admin path and the env-seed path
  // both set `passwordChanged: true` explicitly — neither touches this
  // endpoint. `allowMulti: true` because multi-user is the whole point —
  // `createUser`'s single-user guard would otherwise 500 once the first
  // admin exists.
  try {
    const created = await createUser(deps.db, username, password, {
      allowMulti: true,
      passwordChanged: false,
      assignedVaults,
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
  //
  // The `getFirstAdminId` helper (users.ts) is the single source of
  // truth for "who is the admin" — same SELECT also gates the SPA
  // bearer-mint endpoint (admin-host-admin-token.ts) and drives the
  // non-admin login-redirect default.
  const firstAdminId = getFirstAdminId(deps.db);
  if (firstAdminId && firstAdminId === userId) {
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

// ---------------------------------------------------------------------------
// PATCH /api/users/:id/vaults — replace a user's vault assignments
// ---------------------------------------------------------------------------

interface UpdateVaultsBody {
  assigned_vaults: string[];
}

async function parseUpdateVaultsBody(
  req: Request,
): Promise<{ ok: true; body: UpdateVaultsBody } | ParseErr> {
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
  // Accept both `assigned_vaults` (snake_case, primary) and
  // `assignedVaults` (camelCase, defensive) — same shape as parseCreateBody.
  const rawVaults =
    Object.hasOwn(obj, "assigned_vaults") && obj.assigned_vaults !== undefined
      ? obj.assigned_vaults
      : Object.hasOwn(obj, "assignedVaults") && obj.assignedVaults !== undefined
        ? obj.assignedVaults
        : undefined;
  if (rawVaults === undefined) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: '"assigned_vaults" is required (array of strings; pass [] to clear)',
    };
  }
  if (!Array.isArray(rawVaults)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: '"assigned_vaults" must be an array of strings',
    };
  }
  const seen = new Set<string>();
  const list: string[] = [];
  for (const v of rawVaults) {
    if (typeof v !== "string" || v.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "invalid_request",
        description: '"assigned_vaults" entries must be non-empty strings',
      };
    }
    if (!seen.has(v)) {
      seen.add(v);
      list.push(v);
    }
  }
  return { ok: true, body: { assigned_vaults: list } };
}

/**
 * PATCH /api/users/:id/vaults — replace the user's vault assignments
 * atomically (multi-user Phase 2 PR 2).
 *
 * Body: `{ "assigned_vaults": ["maya", "family"] }`. Pass `[]` to clear
 * every assignment (the user retains their account but loses every per-
 * vault grant — no narrowing for admins; "no access" for non-admins).
 *
 * Order of checks (mirrors `handleResetUserPassword`):
 *
 *   1. Method gate (405 on non-PATCH).
 *   2. Bearer carries `parachute:host:admin` (401 / 403 via `requireScope`).
 *   3. Parse body (400 on shape).
 *   4. Target user exists (404 `not_found`).
 *   5. Target is NOT the first admin (403 `cannot_edit_first_admin_vaults`)
 *      — admin posture is unrestricted by design (`isFirstAdmin`); the
 *      first admin's "vault membership" is implicit and shouldn't be
 *      mutated. Mirrors the first-admin-undeletable rail.
 *   6. Every requested vault name is registered in services.json
 *      (400 `assigned_vault_not_found`).
 *   7. `setUserVaults` — atomic DELETE+INSERT inside one transaction.
 *
 * Response on success: `200 { ok: true, user: <wire shape> }` with the
 * updated `assigned_vaults` reflected.
 */
export async function handleUpdateUserVaults(
  req: Request,
  userId: string,
  deps: ApiUsersDeps,
): Promise<Response> {
  if (req.method !== "PATCH") {
    return jsonError(405, "method_not_allowed", "use PATCH");
  }
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const parsed = await parseUpdateVaultsBody(req);
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.error, parsed.description);
  }
  const target = getUserById(deps.db, userId);
  if (!target) {
    return jsonError(404, "not_found", `no user with id "${userId}"`);
  }
  // First-admin protection — admin posture is "unrestricted" by design
  // (`isFirstAdmin` short-circuits `vaultScopeForUser` to `[]`). Pinning
  // the first admin to a vault list would muddy that semantic. The SPA
  // disables this row's button as a UX hint; the server check is
  // authoritative.
  if (isFirstAdmin(deps.db, userId)) {
    return jsonError(
      403,
      "cannot_edit_first_admin_vaults",
      "the first admin's vault membership is unrestricted by design — no vault list to edit",
    );
  }
  // Validate every vault name against the live services.json list.
  const assignedVaults = parsed.body.assigned_vaults;
  if (assignedVaults.length > 0) {
    const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
    const known = new Set(listVaultNamesFromPath(manifestPath));
    const unknown = assignedVaults.filter((v) => !known.has(v));
    if (unknown.length > 0) {
      return jsonError(
        400,
        "assigned_vault_not_found",
        `assigned vault(s) ${unknown.map((n) => `"${n}"`).join(", ")} not registered in services.json`,
      );
    }
  }
  const ok = setUserVaults(deps.db, userId, assignedVaults);
  if (!ok) {
    return jsonError(404, "not_found", `no user with id "${userId}"`);
  }
  console.log(
    `user vaults updated: id=${userId} username=${target.username} vaults=${assignedVaults.join(",")}`,
  );
  const fresh = getUserById(deps.db, userId);
  return new Response(JSON.stringify({ ok: true, user: fresh ? toWire(fresh) : null }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// POST /api/users/:id/reset-password — admin-initiated password reset
// ---------------------------------------------------------------------------

interface ResetPasswordBody {
  new_password: string;
}

async function parseResetPasswordBody(
  req: Request,
): Promise<{ ok: true; body: ResetPasswordBody } | ParseErr> {
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
  const newPassword = obj.new_password;
  if (typeof newPassword !== "string" || newPassword.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request",
      description: '"new_password" must be a non-empty string',
    };
  }
  // Same CPU-DoS cap as `parseCreateBody` — bound the payload BEFORE
  // argon2id touches it. 413 (request entity too large) is the canonical
  // RFC 7231 status for "body fits, but a specific field exceeds policy."
  if (newPassword.length > PASSWORD_MAX_LEN) {
    return {
      ok: false,
      status: 413,
      error: "password_too_long",
      description: `password length must be ≤ ${PASSWORD_MAX_LEN} characters`,
    };
  }
  return { ok: true, body: { new_password: newPassword } };
}

/**
 * Resource-server revocation-cache TTL surfaced in the reset-password
 * response (smoke 2026-05-27, finding 3). Mirrors
 * `REVOCATION_CACHE_TTL_MS = 60_000` in
 * `packages/scope-guard/src/revocation-cache.ts`. Duplicated as a
 * constant here (not imported) because hub never imports scope-guard
 * — hub is the issuer + revocation-list publisher; scope-guard runs
 * at resource servers (vault, scribe, etc.) on the validation side.
 * Crossing that dependency boundary just to share a constant would
 * invert the architecture. If the TTL ever changes, update both
 * places (the scope-guard CHANGELOG entry pins the wire contract;
 * this constant is the operator-facing surface).
 */
export const REVOCATION_LAG_SECONDS = 60;

/**
 * POST /api/users/:id/reset-password — admin sets a new temp password
 * for a non-admin user. The user is force-redirected through
 * `/account/change-password` on next sign-in (same rail as admin-created
 * users), so the admin's chosen value is genuinely a "temporary one-
 * time handoff" string rather than a long-lived password.
 *
 * Order of checks (mirrors `handleDeleteUser` for the first-admin gate
 * and `handleCreateUser` for the parse / validate pipeline):
 *
 *   1. Method gate (405 on non-POST).
 *   2. Bearer carries `parachute:host:admin` (401 / 403 via `requireScope`).
 *   3. Parse + cap body (400 on shape, 413 on > PASSWORD_MAX_LEN).
 *   4. Target user exists (404 `not_found`).
 *   5. Target is NOT the first admin (403 `cannot_reset_first_admin`).
 *      Admin self-service uses `/account/change-password`; admin-reset
 *      is for friends only. Mirrors the first-admin-undeletable rail.
 *   6. `validatePassword(new_password)` (400 `invalid_password`).
 *   7. `resetUserPassword` — rotates hash, flips `password_changed=0`,
 *      revokes the user's still-active tokens, all in one tx.
 *
 * Response on success: `200 { ok: true, user: <wire shape>,
 * revocation_lag_seconds: 60 }`. We deliberately don't echo the
 * password — the admin already typed it and will hand it to the
 * friend out-of-band (Signal, in-person — same as the create-user
 * default-password flow).
 *
 * **Revocation propagation lag** (smoke 2026-05-27, finding 3):
 * `resetUserPassword` marks tokens revoked in hub's DB immediately
 * AND hub's `/.well-known/parachute-revocation.json` reflects the
 * new revocation on the next fetch. BUT resource servers (vault,
 * scribe, etc.) cache the revocation list via scope-guard's
 * `REVOCATION_CACHE_TTL_MS = 60_000` — they may continue accepting
 * the revoked token for up to 60 seconds after this call returns.
 *
 * - Friend-forgot-pw recovery path: fine. No adversary; the user
 *   re-authenticates and the lag is invisible.
 * - Stolen-device / "kill the friend's tokens NOW" path: a
 *   meaningful exposure window. Operator should also restart the
 *   affected resource servers (`parachute restart vault`, etc.) to
 *   flush the cache immediately.
 *
 * The `revocation_lag_seconds` field in the response surfaces this
 * to API clients (admin SPA's reset-password success banner) so
 * the lag isn't a silent gotcha. The TTL is deliberate (network-
 * cost tradeoff per the scope-guard CHANGELOG); changing it is a
 * separate design question (cf. smoke 2026-05-27 Bug 3 mitigation
 * option 2: inline cache-bust trigger).
 */
export async function handleResetUserPassword(
  req: Request,
  userId: string,
  deps: ApiUsersDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", "use POST");
  }
  try {
    await requireScope(deps.db, req, HOST_ADMIN_SCOPE, deps.issuer);
  } catch (err) {
    return adminAuthErrorResponse(err as AdminAuthError);
  }
  const parsed = await parseResetPasswordBody(req);
  if (!parsed.ok) {
    return jsonError(parsed.status, parsed.error, parsed.description);
  }
  const target = getUserById(deps.db, userId);
  if (!target) {
    return jsonError(404, "not_found", `no user with id "${userId}"`);
  }
  // First-admin protection. The earliest-created row is the wizard or
  // env-seeded admin by construction (Phase 1 has no role model). Reset
  // by admin would be a self-action — the admin should use the normal
  // `/account/change-password` rotate flow instead, which requires
  // knowing the current password (genuine credential rotation, not a
  // recovery reset). Pairs with the first-admin-undeletable rail above.
  if (isFirstAdmin(deps.db, userId)) {
    return jsonError(
      403,
      "cannot_reset_first_admin",
      "the first admin must use /account/change-password directly — admin password reset is for friend accounts",
    );
  }
  const validity = validatePassword(parsed.body.new_password);
  if (!validity.valid) {
    return jsonError(
      400,
      "invalid_password",
      "password must be at least 12 characters (passphrase-friendly; no complexity rules)",
    );
  }
  // `resetUserPassword` is idempotent on a missing row — returns false
  // when the target vanished between `getUserById` and this call. Same
  // race-tolerant 404 as `handleDeleteUser` for that path.
  const ok = await resetUserPassword(deps.db, userId, parsed.body.new_password);
  if (!ok) {
    return jsonError(404, "not_found", `no user with id "${userId}"`);
  }
  console.log(`password reset by admin: id=${userId} username=${target.username}`);
  // Re-read so the response carries the updated `password_changed=false`
  // + bumped `updated_at`. Cheap (single SELECT). Saves the SPA a refetch
  // to see the row's "pending first login" badge come back.
  const fresh = getUserById(deps.db, userId);
  // `revocation_lag_seconds`: smoke 2026-05-27 finding 3. Resource
  // servers cache the revocation list for up to 60s; surface that so
  // the SPA's success banner can warn operators in the
  // stolen-device-recovery threat model. See REVOCATION_LAG_SECONDS
  // doc + handler docstring above.
  return new Response(
    JSON.stringify({
      ok: true,
      user: fresh ? toWire(fresh) : null,
      revocation_lag_seconds: REVOCATION_LAG_SECONDS,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    },
  );
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
