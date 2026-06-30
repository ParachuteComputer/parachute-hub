/**
 * `/account/setup/<token>` — invite redemption (design
 * 2026-06-04-individual-users-and-vault-operations.md §7).
 *
 * Server-rendered (NOT the SPA), mirroring `/login` + the setup wizard's
 * account-claim flow (`setup-wizard.ts` `handleSetupAccountPost`). A brand-new
 * invitee opens the link with no session and no JS:
 *
 * MULTI-USE (v15, DEMO-PREP-2026-06-25 Workstream B): this same surface is the
 * PUBLIC SIGNUP PAGE (B4). A multi-use invite link (`max_uses > 1`) lets many
 * strangers redeem the one link until its seats run out — each redeem creates
 * a fresh account + vault. Such a link also collects the redeemer's EMAIL (B2,
 * so the operator can reach signups) and STAMPS a per-vault storage cap (B4)
 * onto each provisioned vault. A legacy single-use admin/friends invite
 * (`max_uses = 1`, the default) behaves exactly as before — no email field, no
 * cap, single redeem.
 *
 *   GET  → render the "pick username + password (+ email, + vault name)" form.
 *   POST → redeem: look up the invite by sha256(token), validate it's still
 *          redeemable (seats left, not expired/revoked), validate credentials
 *          (+ email for public links), provision the vault (stamping its cap),
 *          create the user, record the redemption (bump used_count, capture
 *          email), mint a session, 302 → /account/.
 *
 * Redeem ORDERING (the re-usability guarantee, mirroring the wizard):
 *   1. lookup + validate the invite (not-found/expired/used/revoked)
 *   2. validate username/password (+ vault name). A pre-named invite
 *      (invite.username set) ENFORCES the username — the form field is
 *      ignored and the invite's name is used; if it's been taken since
 *      mint, the invitee is told to ask the operator for a new link
 *      (the invite stays unconsumed so the operator can revoke + re-mint).
 *   3. resolve the vault:
 *      - provision_vault=1 → provision (must FRESHLY CREATE — reject a
 *        pre-existing name; silently attaching the new user to someone
 *        else's vault would be a cross-tenant breach)
 *      - provision_vault=0 + vault_name → SHARED-VAULT invite: assign the
 *        admin's EXISTING vault at the invite's role (no provisioning).
 *        The vault must still exist in services.json (the vault-delete
 *        cascade revokes pending invites, so this re-check is defense in
 *        depth against manual manifest edits).
 *   4. createUser (the commit point) — and INSIDE its transaction (the
 *      `withinTx` hook): recordInviteRedemption (bump used_count + stamp
 *      used_at/email/redeemed_user_id) AND, for a capped provisioning link,
 *      setVaultCap. All three commit atomically with the user row.
 *   5. createSession + cookie + 302
 *
 * Because the redemption is recorded only inside the user-row transaction, a
 * createUser exception (UNIQUE collision, disk full, anything) rolls back the
 * used_count bump + cap write together — the seat stays available and the
 * invitee can simply retry. `recordInviteRedemption`'s `used_count < max_uses`
 * guard makes the increment itself exhaustion-safe / race-free.
 *
 * What an invite pre-authorizes: EXACTLY one account + the one named/created/
 * shared vault at the baked-in role — NEVER host:admin, NEVER another vault.
 * The new user gets `assignedVaults:[that vault]` with the invite's role;
 * nothing grants admin posture (the first-admin-by-earliest-row heuristic is
 * untouched — an invited user is never the earliest row). The shared-vault
 * shape is admin-authorized by construction: only a host:admin bearer can
 * mint an invite, and that same authority can already assign any user to any
 * vault via POST /api/users. The role ('read' or 'write') is enforced at
 * every mint chokepoint via `vaultVerbsForRole` and at the vault by
 * scope-guard.
 */
import type { Database } from "bun:sqlite";
import { recordLoginUnlock } from "./admin-lock.ts";
import { renderAdminError, renderInviteSetup } from "./admin-login-ui.ts";
import { type RunResult, provisionVault } from "./admin-vaults.ts";
import { SERVICES_MANIFEST_PATH } from "./config.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import {
  InviteExhaustedError,
  InviteExpiredError,
  InviteNotFoundError,
  InviteRevokedError,
  InviteUsedError,
  assertInviteRedeemable,
  recordInviteRedemption,
} from "./invites.ts";
import { clientIpFromRequest, signupRateLimiter } from "./rate-limit.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import { SESSION_TTL_MS, buildSessionCookie, createSession } from "./sessions.ts";
import {
  PASSWORD_MAX_LEN,
  UsernameTakenError,
  createUser,
  getUserByUsernameCI,
  validateEmail,
  validatePassword,
  validateUsername,
} from "./users.ts";
import { setVaultCap } from "./vault-caps.ts";
import { validateVaultName } from "./vault-name.ts";
import { listVaultNamesFromPath } from "./vault-names.ts";

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
  if (err instanceof InviteExhaustedError) {
    return htmlResponse(
      renderAdminError({
        title: "Signups closed",
        message:
          "This signup link has reached its maximum number of accounts. Ask your hub operator for a new link.",
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
      pinnedUsername: invite.username,
      role: invite.role,
      provisionVault: invite.provisionVault,
      collectEmail: collectsEmail(invite),
    }),
    200,
    setCookie,
  );
}

/**
 * Whether this redemption captures the redeemer's email (B2). Multi-use
 * public-signup links collect it (the operator must be able to reach the
 * stranger who signed up); legacy single-use admin invites don't bother
 * (the admin already knows who they handed the link to). The signal: a
 * multi-use link (`max_uses > 1`). Public-signup links always mint with
 * `max_uses > 1`, so this cleanly distinguishes them from the friends flow.
 */
function collectsEmail(invite: { maxUses: number }): boolean {
  return invite.maxUses > 1;
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

  // Rate limit — a DEDICATED signup bucket (per-IP, 60/15min), NOT the /login
  // bucket. A public multi-use signup link is redeemed by a room of people
  // sharing one NAT'd egress IP, so the /login-sized 5/15min cap would 429 the
  // ~6th legitimate signer mid-demo. Generous-but-bounded: the invite's own
  // max_uses + expiry are the primary bound; this is the abuse floor. After
  // CSRF (so a junk cross-site POST doesn't burn the bucket), before any
  // account/vault work.
  const clientIp = clientIpFromRequest(req);
  const gate = signupRateLimiter.checkAndRecord(clientIp, now);
  if (!gate.allowed) {
    return htmlResponse(
      renderAdminError({
        title: "Too many attempts",
        message: `Please wait ${gate.retryAfterSeconds ?? 60} seconds and try again.`,
      }),
      429,
    );
  }

  // Pre-named invite → the invite's username is ENFORCED (the form renders it
  // read-only and any submitted value is ignored — server is the source of
  // truth, same posture as the pinned vault name).
  const username =
    invite.username !== null ? invite.username : String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("password_confirm") ?? "");
  // Email (B2) — captured only for public-signup links (multi-use). The raw
  // value is echoed back on a re-render so the redeemer doesn't retype it.
  const collectEmail = collectsEmail(invite);
  const emailRaw = String(form.get("email") ?? "").trim();

  const csrf = ensureCsrfToken(req);
  const setCookie: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  // Re-render the form with an inline error, preserving what the invitee typed.
  const rerender = (status: number, message: string, vaultNameEcho?: string): Response =>
    htmlResponse(
      renderInviteSetup({
        token: rawToken,
        csrfToken: csrf.token,
        pinnedVaultName: invite.vaultName,
        pinnedUsername: invite.username,
        role: invite.role,
        provisionVault: invite.provisionVault,
        collectEmail,
        username,
        ...(collectEmail ? { email: emailRaw } : {}),
        ...(vaultNameEcho !== undefined ? { vaultName: vaultNameEcho } : {}),
        errorMessage: message,
      }),
      status,
      setCookie,
    );

  // (2) Validate credentials with the SAME validators as /api/users. Runs for
  // the pre-named case too — defense in depth against a hand-edited invites
  // row carrying a name the vocabulary forbids.
  const u = validateUsername(username);
  if (!u.valid) {
    return rerender(
      400,
      invite.username !== null
        ? "This invite's pre-set username is not valid. Ask your hub operator for a new invite."
        : "Username must be 2–32 lowercase letters, digits, _ or - (and not a reserved word).",
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
  // (2b) Email (B2) — required + format-validated ONLY for public-signup
  // (multi-use) links, where the operator must be able to reach the stranger
  // who signed up. Legacy single-use admin invites don't collect it. The
  // canonical form is lowercased/trimmed by validateEmail.
  let email: string | null = null;
  if (collectEmail) {
    if (emailRaw.length === 0) {
      return rerender(400, "Enter your email so the hub operator can reach you.");
    }
    const e = validateEmail(emailRaw);
    if (!e.valid) {
      return rerender(400, "Enter a valid email address (e.g. you@example.com).");
    }
    email = e.email;
  }
  // Case-insensitive uniqueness — same gate as /api/users. For a pre-named
  // invite the name can't be changed by the invitee, so a collision (someone
  // took the name between mint and redeem) needs the operator to revoke +
  // re-mint; the invite stays unconsumed either way.
  //
  // Username-existence oracle, accepted trade-off: a 409 here confirms to the
  // bearer that a given name is taken. The probe is gated behind a single-use,
  // unexpired invite token (256-bit, sha256-at-rest) — not an open endpoint —
  // and for the pre-named case the probed name was chosen by the ADMIN at
  // mint (where it was already validated against existing users), not
  // attacker-supplied. The same disclosure already exists for the (more
  // privileged) callers of /api/users and the setup wizard.
  if (getUserByUsernameCI(deps.db, username) !== null) {
    return rerender(
      409,
      invite.username !== null
        ? `The username "${username}" chosen for this invite is already taken. Ask your hub operator for a new invite.`
        : `The username "${username}" is already taken. Pick another.`,
    );
  }

  // Resolve the vault name: pinned by the invite, or chosen by the invitee.
  // The invitee-chosen name goes through the FULL `validateVaultName` (the
  // same 2–32 + charset + reserved contract vault's init enforces), not just
  // the charset regex — otherwise a 33–64 char name slips past here and fails
  // at the vault CLI with a generic provision error.
  let vaultName: string | null = null;
  if (invite.provisionVault) {
    // Defense in depth against a hand-edited invites row: the API refuses to
    // MINT provision_vault=1 with role != 'write' (a fresh vault's SOLE user
    // must hold write — a read-only owner would leave the new vault
    // permanently un-writable). Honor the same invariant at redeem so a row
    // that bypassed the API can't create that dead-end. The invite stays
    // unconsumed; the operator re-mints a valid one.
    if (invite.role !== "write") {
      return rerender(
        400,
        "This invite is not valid (a new vault's owner must have write access). Ask your hub operator for a new invite.",
      );
    }
    if (invite.vaultName !== null) {
      vaultName = invite.vaultName;
    } else {
      // Unpinned name: the invitee names their own vault. The field is
      // OPTIONAL (no-JS server-side default) — a blank submission defaults
      // the vault name to the chosen username. Either way the resolved name
      // runs through the full validator; a username that isn't a valid vault
      // name (e.g. too long, disallowed chars) re-renders asking for an
      // explicit vault name with the validator's error.
      const submitted = String(form.get("vault_name") ?? "").trim();
      const chosen = submitted === "" ? username : submitted;
      const v = validateVaultName(chosen);
      if (!v.ok) {
        // Echo the resolved name only if the invitee typed one; a blank
        // (username-derived) failure shouldn't pre-fill the vault box.
        return rerender(400, v.error, submitted === "" ? undefined : submitted);
      }
      vaultName = v.name;
    }
  } else if (invite.vaultName !== null) {
    // SHARED-VAULT invite: assign the redeemer to the admin's EXISTING vault
    // at the invite's baked-in role ('read' or 'write') — no provisioning.
    // Admin-authorized by construction: only a host:admin bearer can mint an
    // invite, and that same authority can already assign any user to any
    // vault via POST /api/users; the invite packages that assignment as a
    // deliverable link. The role is enforced downstream at every mint
    // chokepoint (`vaultVerbsForRole`: read → ["read"]) and at the vault by
    // scope-guard — a read-role redeemer can never obtain a write-capable
    // token for this (or any other) vault.
    //
    // The vault must still exist: the vault-delete cascade
    // (`revokeInvitesForVault`) revokes pending invites pinned to a deleted
    // vault, so this re-check is defense in depth (manual services.json
    // edits, restored DB). The invite stays unconsumed on this rejection.
    const manifestPath = deps.manifestPath ?? SERVICES_MANIFEST_PATH;
    const known = new Set(listVaultNamesFromPath(manifestPath));
    if (!known.has(invite.vaultName)) {
      return rerender(
        400,
        "The vault this invite shares no longer exists on this hub. Ask your hub operator for a new invite.",
      );
    }
    vaultName = invite.vaultName;
  }

  // (3) Provision the vault — must FRESHLY CREATE it (see the security
  // invariant on the `!provisioned.created` check below). Routed through the
  // SAME createVault path the wizard/SPA use, so the new vault gets the §3
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
    // SECURITY INVARIANT: an invite redeem may grant access ONLY to a vault
    // that was FRESHLY CREATED during this redeem. `provisionVault` returns
    // `created:true` (HTTP 201) for a new vault, `created:false` (HTTP 200)
    // when the name ALREADY EXISTS — in which case it hands back SOMEONE
    // ELSE'S vault. Attaching the new user there as owner would be a cross-
    // tenant breach. Reject any non-created (already-existing) result; the
    // invitee must choose a different, unused name. This also closes the
    // concurrent-redeem race on a new name: first redeem 201, second 200 →
    // second rejected.
    if (!provisioned.created) {
      return rerender(
        409,
        `A vault named "${vaultName}" already exists. Choose a different name.`,
        // Echo the typed name only if the invitee chose it explicitly; a
        // username-derived collision shouldn't pre-fill the vault box.
        invite.vaultName === null && String(form.get("vault_name") ?? "").trim() !== ""
          ? vaultName
          : undefined,
      );
    }

    // NOTE: the per-vault storage cap (B4) is PERSISTED below, inside
    // createUser's transaction (the `withinTx` hook), so the cap write +
    // redemption record + user insert all commit (or roll back) atomically —
    // no stranded cap row for a vault whose account creation failed. The
    // vault itself is provisioned here (the CLI shell-out can't join the
    // sqlite tx), but the cap METADATA is hub-DB state, so it belongs in the
    // atomic hook.
  }

  // (4) Create the user + record the redemption ATOMICALLY — the COMMIT POINT.
  // The redemption is recorded INSIDE createUser's transaction (the `withinTx`
  // hook), so the seat-accounting guarantees compose:
  //
  //   - Exhaustion under concurrency: two redeems of the LAST seat both pass
  //     `assertInviteRedeemable` above, but only one's `recordInviteRedemption`
  //     UPDATE (`used_count < max_uses AND revoked_at IS NULL`) changes a row.
  //     The loser's hook throws (InviteExhaustedError for a multi-use link,
  //     InviteUsedError for single-use), which rolls back ITS user insert — no
  //     orphan account. Exactly one account per remaining seat results.
  //   - Re-usable on failure: if createUser throws (UNIQUE collision, etc.)
  //     before the hook, used_count was never bumped; if the hook itself
  //     throws (lost race), the increment + the user insert roll back together.
  //     Either way nothing commits, so the seat stays available.
  //
  // The email (B2) is recorded with the redemption (latest redeemer) AND on
  // the account row (`users.email`, the canonical per-account field) below.
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
      ...(email !== null ? { email } : {}),
      withinTx: (newUserId) => {
        if (!recordInviteRedemption(deps.db, invite.tokenHash, newUserId, email, now)) {
          // Lost the redeem race (or a concurrent revoke landed). Throw the
          // shape-appropriate error to roll back this user insert; surfaced
          // as the 410 path below.
          throw invite.maxUses > 1 ? new InviteExhaustedError() : new InviteUsedError();
        }
        // (3b) Persist the per-vault storage cap (B4) atomically with the
        // account + redemption. Only for a freshly-provisioned vault carrying
        // an invite cap; legacy/uncapped links leave the vault with no
        // vault_caps row ("uncapped" for the Phase-2 reader). The vault was
        // confirmed freshly created above; `setVaultCap` is a plain upsert.
        if (invite.provisionVault && vaultName !== null && invite.vaultCapBytes !== null) {
          setVaultCap(deps.db, vaultName, invite.vaultCapBytes, now);
        }
      },
    });
    userId = created.id;
  } catch (err) {
    if (err instanceof InviteUsedError || err instanceof InviteExhaustedError) {
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
  recordLoginUnlock(deps.db, session.id);
  const sessionCookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000), {
    secure: isHttpsRequest(req),
  });
  return new Response(null, {
    status: 302,
    headers: { location: "/account/", "cache-control": "no-store", "set-cookie": sessionCookie },
  });
}
