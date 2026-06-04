/**
 * `POST /account/vault-token/<name>` — friend-facing scoped vault token mint.
 *
 * A non-admin friend with a hub session is ALREADY authorized for their
 * assigned vault(s): the OAuth issuer mints `vault:<assigned>:read|write` for
 * them on the no-token connect path. This endpoint lets the same friend mint
 * that same authority *in token form* — a long-lived bearer for a script or
 * headless client that can't open a browser to do interactive OAuth. It is
 * the same authority, just materialized; no escalation.
 *
 * Authorization — the security spine of this surface. The mint is capped to
 * the caller's own authority by three gates, in order:
 *
 *   1. **Session.** A valid, unexpired hub session cookie is required (the
 *      friend's). No session → 401. (Resolved via `findActiveSession`, the
 *      same gate `/account/change-password` uses.)
 *   2. **Assignment.** The requested `<name>` MUST be one of the session
 *      user's `user_vaults` assignments. A vault the user is not assigned to
 *      → 403. This is what blocks "mint for a vault I'm not assigned" and
 *      cross-vault minting. Read directly from `user_vaults` via
 *      `vaultVerbsForUserVault` (which returns `null` for an unassigned
 *      vault), NOT from the verb-blind `assignedVaults` array.
 *   3. **Scope cap.** The requested verb MUST be one the user's assignment
 *      role permits. As of 2026-05-30 an assigned user holds the full set
 *      `["read", "write", "admin"]` on their vault (`vaultVerbsForUserVault`),
 *      so this surface mints admin tokens too — consistent with the OAuth
 *      flow. A verb outside the held set, or for an unassigned vault, → 403.
 *
 * The first admin (unrestricted, empty `assignedVaults`) has no `user_vaults`
 * rows, so gate 2 returns `null` for every vault and the admin gets a 403
 * here too — by design. Admins mint vault tokens through the admin SPA's
 * tokens page (`/admin/vault-admin-token/<name>` → `/api/auth/mint-token`),
 * not this friend surface. This endpoint is exclusively the friend path.
 *
 * CSRF: double-submit cookie, same `__csrf` field + `verifyCsrfToken` as
 * `/account/change-password` and `/logout`. A cross-site POST without the
 * matching cookie/form token → 400.
 *
 * Rate limit: `vaultTokenMintRateLimiter`, per-user (10 / 10 min). Fires
 * after CSRF (so a junk cross-site POST doesn't burn the victim's bucket)
 * and before the mint. A floor against a stolen-cookie mint flood, not the
 * primary defense.
 *
 * Mint: `signAccessToken` (the same machinery the OAuth issuer + admin paths
 * use — no hand-rolled JWT signing) with:
 *   - `scopes: ["vault:<name>:<verb>"]`
 *   - `audience: "vault.<name>"` (via `inferAudience`; vault validates this
 *     against its URL-derived name — identical to the OAuth + admin mints)
 *   - `iss`: the hub origin
 *   - `sub`: the friend's user id
 *   - `vaultScope: [<name>]` — pins the token to that one vault (defense in
 *     depth, mirrors the admin vault-token + the rule-2/3 mints in
 *     `api-mint-token.ts`)
 *   - `ttlSeconds`: 90 days (`ACCOUNT_VAULT_TOKEN_TTL_SECONDS`, matching the
 *     CLI/api-mint default)
 * and a `tokens` registry row via `recordTokenMint` (`created_via='cli_mint'`,
 * `userId` = the friend) so the token shows up in the revocation list and the
 * operator's token registry.
 *
 * Response: a re-render of `/account/` (server-rendered, no-JS posture) with
 * the token shown ONCE in a banner. The hub keeps no plaintext copy, so this
 * is the only moment the token string is visible.
 */
import type { Database } from "bun:sqlite";
import {
  ACCOUNT_VAULT_TOKEN_TTL_SECONDS,
  type MintedTokenView,
  renderAccountHome,
} from "./account-home-ui.ts";
import { renderAdminError } from "./admin-login-ui.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { userHasVaultGrant } from "./grants.ts";
import { inferAudience } from "./jwt-audience.ts";
import { recordTokenMint, signAccessToken } from "./jwt-sign.ts";
import { vaultTokenMintRateLimiter } from "./rate-limit.ts";
import { findActiveSession } from "./sessions.ts";
import { isTotpEnrolled } from "./two-factor-store.ts";
import { type VaultVerb, getUserById, isFirstAdmin, vaultVerbsForUserVault } from "./users.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";

/**
 * Lowercase-only vault-name charset (item I) — single source of truth in
 * vault-name.ts, matching what vault's init enforces. Was `[a-zA-Z0-9_-]`; the
 * uppercase superset let a mint name drift from vault's lowercase URL-derived
 * name, so the minted token's `vault.<Name>` audience wouldn't validate.
 */
const VAULT_NAME_RE = VAULT_NAME_CHARSET_RE;
/** Verbs this surface will ever mint. `admin` is deliberately absent. */
const ALLOWED_VERBS: readonly VaultVerb[] = ["read", "write", "admin"];
/** client_id stamped on the minted JWT + registry row. */
const ACCOUNT_VAULT_TOKEN_CLIENT_ID = "parachute-account";

export interface AccountVaultTokenDeps {
  db: Database;
  /** Hub origin for this request — `iss` of the minted token. */
  hubOrigin: string;
  /** Test seam for the clock (rate limiter + mint). */
  now?: () => Date;
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/**
 * Build the `mintableVerbs` map the account-home renderer needs: each of the
 * user's assigned vaults → the verbs its role permits. Used both on the
 * success re-render (so every tile keeps its mint affordance) and the error
 * re-render. Mirrors the GET handler's construction.
 */
function buildMintableVerbs(
  db: Database,
  userId: string,
  assignedVaults: readonly string[],
): Record<string, VaultVerb[]> {
  const map: Record<string, VaultVerb[]> = {};
  for (const v of assignedVaults) {
    const verbs = vaultVerbsForUserVault(db, userId, v);
    if (verbs && verbs.length > 0) map[v] = verbs;
  }
  return map;
}

export async function handleAccountVaultTokenPost(
  req: Request,
  vaultName: string,
  deps: AccountVaultTokenDeps,
): Promise<Response> {
  if (req.method !== "POST") {
    return htmlResponse("method not allowed", 405);
  }

  // Gate 1 — session. No identity, no mint.
  const session = findActiveSession(deps.db, req);
  if (!session) {
    return htmlResponse(
      renderAdminError({
        title: "Not signed in",
        message: "Please sign in before minting an access token.",
      }),
      401,
    );
  }
  const user = getUserById(deps.db, session.userId);
  if (!user) {
    return htmlResponse(
      renderAdminError({
        title: "Account not found",
        message: "The signed-in account no longer exists. Please sign in again.",
      }),
      401,
    );
  }

  // CSRF — verify before any state change / rate-limit bucket touch, same
  // shape + 400 status as `/account/change-password`.
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

  // Helper to re-render the account home (success banner or inline error).
  // Re-resolves the CSRF token + 2FA state so the page stays fully usable.
  const renderHome = (
    status: number,
    extras: { mintedToken?: MintedTokenView; mintError?: string },
  ): Response => {
    const csrf = ensureCsrfToken(req);
    const setCookie: Record<string, string> = csrf.setCookie
      ? { "set-cookie": csrf.setCookie }
      : {};
    const adminFlag = isFirstAdmin(deps.db, user.id);
    return htmlResponse(
      renderAccountHome({
        username: user.username,
        assignedVaults: user.assignedVaults,
        passwordChanged: user.passwordChanged,
        hubOrigin: deps.hubOrigin,
        isFirstAdmin: adminFlag,
        csrfToken: csrf.token,
        twoFactorEnabled: isTotpEnrolled(deps.db, user.id),
        mintableVerbs: buildMintableVerbs(deps.db, user.id, user.assignedVaults),
        connectedVault: user.assignedVaults.some((v) => userHasVaultGrant(deps.db, user.id, v)),
        ...extras,
      }),
      status,
      setCookie,
    );
  };

  // Vault-name shape guard — reject anything that can't be a services.json
  // key before any DB / authority work (router can hand us arbitrary path
  // segments). Same posture as `/admin/vault-admin-token`.
  if (!VAULT_NAME_RE.test(vaultName)) {
    return renderHome(400, { mintError: `"${vaultName}" is not a valid vault name.` });
  }

  // Verb parse — must be one of read/write/admin (this surface's vocabulary).
  // Anything else is rejected here, well before authority is even consulted;
  // the per-vault authority cap (gate 3 below) then drops verbs the user
  // doesn't actually hold.
  const verbRaw = form.get("verb");
  const verb = typeof verbRaw === "string" ? verbRaw : "";
  if (!ALLOWED_VERBS.includes(verb as VaultVerb)) {
    return renderHome(400, {
      mintError: "Pick an access level (read, write, or admin).",
    });
  }
  const requestedVerb = verb as VaultVerb;

  // Gate 2 + 3 — assignment + scope cap. `vaultVerbsForUserVault` returns:
  //   - null  → the user has NO assignment for this vault (gate 2 fail): 403.
  //   - []    → assignment exists but its role grants no mintable verb
  //             (fail-closed for an unknown role): 403.
  //   - [...] → the verbs the assignment role permits. The requested verb
  //             must be in this set (gate 3): else 403.
  // This is the cap to the user's actual authority — it blocks minting for an
  // unassigned vault or a verb the role doesn't grant. Assigned users hold
  // read/write/admin on their vault (2026-05-30), so admin mints for an
  // assigned vault; the cap still refuses admin (and everything else) for a
  // vault the user isn't assigned (`allowedForUser === null`).
  const allowedForUser = vaultVerbsForUserVault(deps.db, user.id, vaultName);
  if (allowedForUser === null) {
    return renderHome(403, {
      mintError: `You're not assigned to a vault named "${vaultName}", so you can't mint a token for it. Ask the hub operator if you think this is wrong.`,
    });
  }
  if (!allowedForUser.includes(requestedVerb)) {
    return renderHome(403, {
      mintError: `Your access to "${vaultName}" doesn't allow minting a ${requestedVerb} token.`,
    });
  }

  // Force-change-password gate (item F / hub#469, NARROW). A user the admin
  // created/reset lands with `password_changed: false` and an admin-known temp
  // password. Without this gate an authorized friend could mint a LONG-LIVED
  // vault token here and then keep using (or never rotate) the temp password —
  // the token outlives any later rotation, defeating the "temp password is a
  // one-time handoff" model. So an authorized-but-unrotated friend is sent to
  // the change-password rail BEFORE minting anything. Placed AFTER the
  // authority gates (so an unassigned/garbage request still gets its 403/400,
  // preserving those semantics) and BEFORE the rate-limit + mint. 303 (See
  // Other) so the browser re-issues as GET. Narrow #469 fix — gates
  // token-minting specifically; the broad per-request /account/* wall is
  // deferred to Aaron's design call.
  if (!user.passwordChanged) {
    return new Response(null, {
      status: 303,
      headers: { location: "/account/change-password", "cache-control": "no-store" },
    });
  }

  // Rate limit — after CSRF + authority shape, before the mint. Per-user.
  const rlNow = (deps.now ?? (() => new Date()))();
  const gate = vaultTokenMintRateLimiter.checkAndRecord(user.id, rlNow);
  if (!gate.allowed) {
    return renderHome(429, {
      mintError: `Too many token-mint attempts. Try again in ${gate.retryAfterSeconds ?? 1} seconds.`,
    });
  }

  // Mint — the same machinery the OAuth issuer + admin paths use. The scope
  // is exactly the capped `vault:<name>:<verb>`; the audience binds the token
  // to that one vault; `vaultScope` pins it as defense in depth.
  const scope = `vault:${vaultName}:${requestedVerb}`;
  const audience = inferAudience([scope]); // → `vault.<name>`
  const minted = await signAccessToken(deps.db, {
    sub: user.id,
    scopes: [scope],
    audience,
    clientId: ACCOUNT_VAULT_TOKEN_CLIENT_ID,
    issuer: deps.hubOrigin,
    ttlSeconds: ACCOUNT_VAULT_TOKEN_TTL_SECONDS,
    vaultScope: [vaultName],
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  recordTokenMint(deps.db, {
    jti: minted.jti,
    createdVia: "cli_mint",
    subject: user.id,
    // Anchor the registry row to the friend's user id so the operator's
    // token registry + the revocation list attribute it correctly, and a
    // future per-user revoke surface can find it.
    userId: user.id,
    clientId: ACCOUNT_VAULT_TOKEN_CLIENT_ID,
    scopes: [scope],
    expiresAt: minted.expiresAt,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  return renderHome(200, {
    mintedToken: {
      vaultName,
      verb: requestedVerb,
      token: minted.token,
      expiresInDays: Math.round(ACCOUNT_VAULT_TOKEN_TTL_SECONDS / (24 * 60 * 60)),
    },
  });
}
