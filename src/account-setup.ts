/**
 * `/account/setup/<token>` — invite redemption (design
 * 2026-06-04-individual-users-and-vault-operations.md §7).
 *
 * Server-rendered (NOT the SPA), mirroring `/login` + the setup wizard's
 * account-claim flow (`setup-wizard.ts` `handleSetupAccountPost`). A brand-new
 * invitee opens the link with no session and no JS:
 *
 *   GET  → render the "pick username + password (+ vault name)" form.
 *   POST → redeem: look up the invite by sha256(token), validate it's still
 *          redeemable, validate credentials, provision the vault, create the
 *          user, stamp the invite used, mint a session, 302 → /account/.
 *
 * Redeem ORDERING (the re-usability guarantee, mirroring the wizard):
 *   1. lookup + validate the invite (not-found/expired/used/revoked)
 *   2. validate username/password (+ vault name)
 *   3. provision the vault (idempotent-safe)
 *   4. createUser (the commit point)
 *   5. consumeInvite — stamp used_at + redeemed_user_id ONLY AFTER (4) commits
 *   6. createSession + cookie + 302
 *
 * Because the invite is consumed only after the user row commits, a
 * createUser exception (UNIQUE collision, disk full, anything) leaves the
 * invite re-usable — the invitee can simply retry. `consumeInvite`'s
 * `used_at IS NULL` guard makes the stamp itself single-use / race-free.
 *
 * What an invite pre-authorizes: EXACTLY one account + the one named/created
 * vault at the baked-in role — NEVER host:admin, NEVER another vault. The new
 * user gets `assignedVaults:[that vault]` with the invite's role; nothing
 * grants admin posture (the first-admin-by-earliest-row heuristic is
 * untouched — an invited user is never the earliest row).
 */
import type { Database } from "bun:sqlite";
import { renderAdminError, renderInviteSetup } from "./admin-login-ui.ts";
import { type RunResult, provisionVault } from "./admin-vaults.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import {
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  InviteUsedError,
  assertInviteRedeemable,
  consumeInvite,
} from "./invites.ts";
import { checkAndRecord, clientIpFromRequest } from "./rate-limit.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "./sessions.ts";
import {
  PASSWORD_MAX_LEN,
  UsernameTakenError,
  createUser,
  getUserByUsernameCI,
  validatePassword,
  validateUsername,
} from "./users.ts";
import { validateVaultName } from "./vault-name.ts";

export interface AccountSetupDeps {
  db: Database;
  /** Hub origin — JWT `iss` for any vault bootstrap mint + the URL base. */
  hubOrigin: string;
  manifestPath?: string;
  /** Test seam: vault provisioning shell-out. */
  runCommand?: (cmd: readonly string[]) => Promise<RunResult>;
  /** Test seam: clock for the rate limiter. */
  now?: () => Date;
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/**
 * Map an invite-rejection error to a status + user-facing copy. Not-found →
 * 404 (don't confirm the token shape); expired/used/revoked → 410 Gone (the
 * link existed but is no longer redeemable).
 */
function rejectInvite(err: unknown): Response {
  if (err instanceof InviteNotFoundError) {
    return htmlResponse(
      renderAdminError({
        title: "Invite not found",
        message:
          "This invite link is not valid. Check that you copied the whole link, or ask your hub operator for a new one.",
      }),
      404,
    );
  }
  if (err instanceof InviteExpiredError) {
    return htmlResponse(
      renderAdminError({
        title: "Invite expired",
        message: "This invite link has expired. Ask your hub operator for a new one.",
      }),
      410,
    );
  }
  if (err instanceof InviteUsedError) {
    return htmlResponse(
      renderAdminError({
        title: "Invite already used",
        message:
          "This invite link has already been used to create an account. If that wasn't you, contact your hub operator.",
      }),
      410,
    );
  }
  if (err instanceof InviteRevokedError) {
    return htmlResponse(
      renderAdminError({
        title: "Invite revoked",
        message: "This invite link has been revoked by your hub operator. Ask them for a new one.",
      }),
      410,
    );
  }
  // Unexpected — fail closed.
  return htmlResponse(
    renderAdminError({ title: "Invite error", message: "Could not process this invite link." }),
    500,
  );
}

/** GET /account/setup/<token> — render the claim form (or a rejection page). */
export function handleAccountSetupGet(
  req: Request,
  rawToken: string,
  deps: AccountSetupDeps,
): Response {
  const now = (deps.now ?? (() => new Date()))();
  let invite: ReturnType<typeof assertInviteRedeemable>;
  try {
    invite = assertInviteRedeemable(deps.db, rawToken, now);
  } catch (err) {
    return rejectInvite(err);
  }
  const csrf = ensureCsrfToken(req);
  const setCookie: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  return htmlResponse(
    renderInviteSetup({
      token: rawToken,
      csrfToken: csrf.token,
      pinnedVaultName: invite.vaultName,
      provisionVault: invite.provisionVault,
    }),
    200,
    setCookie,
  );
}

/** POST /account/setup/<token> — redeem the invite (see file docstring for ordering). */
export async function handleAccountSetupPost(
  req: Request,
  rawToken: string,
  deps: AccountSetupDeps,
): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();

  // (1) Look up + validate the invite BEFORE any work.
  let invite: ReturnType<typeof assertInviteRedeemable>;
  try {
    invite = assertInviteRedeemable(deps.db, rawToken, now);
  } catch (err) {
    return rejectInvite(err);
  }

  // CSRF — double-submit, same shape as /account/change-password + /login.
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return htmlResponse(
      renderAdminError({
        title: "Invalid form submission",
        message: "The form's CSRF token did not match. Reload the page and try again.",
      }),
      400,
    );
  }

  // Rate limit — reuse the /login IP bucket so a redeem flood and a login
  // flood share the same throttle. After CSRF (so a junk cross-site POST
  // doesn't burn the bucket), before any account/vault work.
  const clientIp = clientIpFromRequest(req);
  const gate = checkAndRecord(clientIp, now);
  if (!gate.allowed) {
    return htmlResponse(
      renderAdminError({
        title: "Too many attempts",
        message: `Please wait ${gate.retryAfterSeconds ?? 60} seconds and try again.`,
      }),
      429,
    );
  }

  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("password_confirm") ?? "");

  const csrf = ensureCsrfToken(req);
  const setCookie: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  // Re-render the form with an inline error, preserving what the invitee typed.
  const rerender = (status: number, message: string, vaultNameEcho?: string): Response =>
    htmlResponse(
      renderInviteSetup({
        token: rawToken,
        csrfToken: csrf.token,
        pinnedVaultName: invite.vaultName,
        provisionVault: invite.provisionVault,
        username,
        ...(vaultNameEcho !== undefined ? { vaultName: vaultNameEcho } : {}),
        errorMessage: message,
      }),
      status,
      setCookie,
    );

  // (2) Validate credentials with the SAME validators as /api/users.
  const u = validateUsername(username);
  if (!u.valid) {
    return rerender(
      400,
      "Username must be 2–32 lowercase letters, digits, _ or - (and not a reserved word).",
    );
  }
  if (password.length > PASSWORD_MAX_LEN) {
    return rerender(413, `Password must be ≤ ${PASSWORD_MAX_LEN} characters.`);
  }
  const p = validatePassword(password);
  if (!p.valid) {
    return rerender(400, "Password must be at least 12 characters.");
  }
  if (password !== confirm) {
    return rerender(400, "The two passwords don't match.");
  }
  // Case-insensitive uniqueness — same gate as /api/users.
  if (getUserByUsernameCI(deps.db, username) !== null) {
    return rerender(409, `The username "${username}" is already taken. Pick another.`);
  }

  // Resolve the vault name: pinned by the invite, or chosen by the invitee.
  // The invitee-chosen name goes through the FULL `validateVaultName` (the
  // same 2–32 + charset + reserved contract vault's init enforces), not just
  // the charset regex — otherwise a 33–64 char name slips past here and fails
  // at the vault CLI with a generic provision error.
  let vaultName: string | null = null;
  if (invite.provisionVault) {
    if (invite.vaultName !== null) {
      vaultName = invite.vaultName;
    } else {
      const chosen = String(form.get("vault_name") ?? "").trim();
      const v = validateVaultName(chosen);
      if (!v.ok) {
        return rerender(400, v.error, chosen);
      }
      vaultName = v.name;
    }
  } else if (invite.vaultName !== null) {
    // Account-only invite that assigns an existing vault.
    vaultName = invite.vaultName;
  }

  // (3) Provision the vault (idempotent-safe). Routed through the SAME
  // createVault path the wizard/SPA use, so the new vault gets the §3
  // internal-live-mirror default for free. Done BEFORE createUser so a
  // provisioning failure doesn't leave a vault-less account; the invite is
  // still unconsumed at this point, so the invitee can retry.
  if (invite.provisionVault && vaultName !== null) {
    const provisioned = await provisionVault(vaultName, {
      issuer: deps.hubOrigin,
      ...(deps.manifestPath !== undefined ? { manifestPath: deps.manifestPath } : {}),
      ...(deps.runCommand !== undefined ? { runCommand: deps.runCommand } : {}),
      ...(invite.defaultMirror !== null ? { defaultMirror: invite.defaultMirror } : {}),
    });
    if (!provisioned.ok) {
      return rerender(
        provisioned.status === 400 ? 400 : 502,
        provisioned.status === 400
          ? provisioned.message
          : "Could not provision your vault. Please try again, or ask your hub operator.",
        invite.vaultName === null ? (vaultName ?? undefined) : undefined,
      );
    }
  }

  // (4) Create the user + consume the invite ATOMICALLY — the COMMIT POINT.
  // The invite is consumed INSIDE createUser's transaction (the `withinTx`
  // hook), so the two single-use guarantees compose:
  //
  //   - Single-use under concurrency: two redeems of one invite both pass
  //     `assertInviteRedeemable` above, but only one's `consumeInvite` UPDATE
  //     (`used_at IS NULL AND revoked_at IS NULL`) changes a row. The loser's
  //     hook throws `InviteUsedError`, which rolls back ITS user insert — no
  //     orphan account. Exactly one account results.
  //   - Re-usable on failure: if createUser throws (UNIQUE collision, etc.)
  //     before the hook, the invite was never touched; if the hook itself
  //     throws (lost race), the consume + the user insert roll back together.
  //     Either way nothing commits, so the invite stays re-usable.
  //
  // passwordChanged: TRUE (the invitee chose their own password → no force-
  // change). assignedVaults pins them to exactly their one vault at the
  // invite's role. allowMulti because the first admin already exists.
  let userId: string;
  try {
    const created = await createUser(deps.db, username, password, {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: vaultName !== null ? [vaultName] : [],
      role: invite.role,
      withinTx: (newUserId) => {
        if (!consumeInvite(deps.db, invite.tokenHash, newUserId, now)) {
          // Lost the redeem race (or a concurrent revoke landed). Throw to
          // roll back this user insert; surfaced as the used/410 path below.
          throw new InviteUsedError();
        }
      },
    });
    userId = created.id;
  } catch (err) {
    if (err instanceof InviteUsedError) {
      return rejectInvite(err);
    }
    if (err instanceof UsernameTakenError) {
      return rerender(409, `The username "${username}" is already taken. Pick another.`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[account-setup] createUser failed for "${username}": ${msg}`);
    return rerender(500, "Could not create your account. Please try again.");
  }

  // (6) Sign the invitee in + land them on /account/.
  const session = createSession(deps.db, { userId });
  const sessionCookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000), {
    secure: isHttpsRequest(req),
  });
  return new Response(null, {
    status: 302,
    headers: { location: "/account/", "cache-control": "no-store", "set-cookie": sessionCookie },
  });
}
