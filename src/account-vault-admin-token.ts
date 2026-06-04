/**
 * `POST /account/vault-admin-token/<name>` — friend-facing vault ADMIN deep-link.
 *
 * The non-admin sibling of `GET /admin/vault-admin-token/<name>`
 * (`admin-vault-admin-token.ts`). Both mint a `vault:<name>:admin` JWT and
 * hand it to the vault's own admin SPA via a `#token=<jwt>` URL fragment — the
 * SPA reads `location.hash` on bootstrap, then strips it. The admin sibling is
 * gated `isFirstAdmin` and returns JSON for the hub SPA's fetch; THIS surface
 * is gated on ASSIGNMENT (an individual user holds `admin` on a vault they're
 * assigned to) and is a server-rendered POST → 303 redirect, matching the
 * no-JS posture of the rest of `/account/*`.
 *
 * Why this exists: an assigned user is ALREADY authorized for `vault:<name>:admin`
 * (`vaultVerbsForUserVault` returns `["read","write","admin"]` for their vault,
 * 2026-05-30; vault gates mirror/backup config + token rotation on that scope).
 * The authority existed; the only missing piece was a friend-reachable HTTP
 * unlock + a button. With this, an individual user can open their vault's admin
 * SPA — token mint/revoke, **and the Git-backup / mirror config** — without
 * host-admin. The deep-link lands on the vault admin home (`managementUrl`,
 * `/admin/` by default), whose "Git backup →" link reaches `VaultMirror`.
 *
 * Authorization — the same three-gate spine as `/account/vault-token/<name>`
 * (`account-vault-token.ts`), here pinned to the single `admin` verb:
 *
 *   1. **Session.** A valid hub session cookie (the user's). No session → 401.
 *   2. **Assignment.** `<name>` MUST be one of the user's `user_vaults`
 *      assignments AND that assignment's role must grant `admin`. Read via
 *      `vaultVerbsForUserVault` (`null` for an unassigned vault → 403; a role
 *      that doesn't grant `admin` → 403). The first admin (empty
 *      `assignedVaults`, no `user_vaults` rows) gets `null` here too — by
 *      design, the same as `/account/vault-token`: admins use the SPA's
 *      `/admin/vault-admin-token` path, not this friend surface.
 *
 * CSRF: double-submit cookie, same `__csrf` field + `verifyCsrfToken` as
 * `/account/vault-token`, `/account/change-password`, and `/logout`. A
 * cross-site POST without the matching cookie/form token → 400.
 *
 * Force-change-password gate (item F / hub#469): if `!user.passwordChanged`,
 * 303 → `/account/change-password` BEFORE minting — identical to the gate
 * `/account/vault-token` applies post-#550. An admin-created/reset user lands
 * with a temp password and `password_changed: false`; without this gate they
 * could mint a `vault:<name>:admin` deep-link token (10-min TTL, but still) and
 * keep using the temp password instead of rotating it. Placed AFTER the
 * authority gates (so an unassigned/garbage request still gets its 403/400) and
 * BEFORE the mint. This does NOT reintroduce the bypass #469 closed.
 *
 * Mint: `signAccessToken` (the same machinery the OAuth issuer + admin paths
 * use) with `scopes: ["vault:<name>:admin"]`, `audience: "vault.<name>"`,
 * `iss`: the hub origin, `sub`: the user id, `vaultScope: [<name>]`, and the
 * SAME short 10-min TTL as the admin sibling (`VAULT_ADMIN_TOKEN_TTL_SECONDS`):
 * this is a deep-link bootstrap token, not a long-lived headless credential
 * (that's `/account/vault-token`). A `tokens` registry row records it
 * (`created_via='cli_mint'`, `userId` = the user) so it's revocable.
 *
 * Response: 303 → `<vault-url><managementUrl>#token=<jwt>`. 303 (See Other) so
 * the browser re-issues the navigation as GET. The token rides the URL
 * fragment, which is never sent to the server — same contract the hub SPA's
 * `VaultsList` "Manage" button uses (vault PR #219).
 */
import type { Database } from "bun:sqlite";
import { renderAdminError } from "./admin-login-ui.ts";
import { VAULT_ADMIN_TOKEN_TTL_SECONDS } from "./admin-vault-admin-token.ts";
import { CSRF_FIELD_NAME, verifyCsrfToken } from "./csrf.ts";
import { recordTokenMint, signAccessToken } from "./jwt-sign.ts";
import { findActiveSession } from "./sessions.ts";
import { getUserById, vaultVerbsForUserVault } from "./users.ts";
import { VAULT_NAME_CHARSET_RE } from "./vault-name.ts";

/** Lowercase-only vault-name charset — single source of truth in vault-name.ts. */
const VAULT_NAME_RE = VAULT_NAME_CHARSET_RE;
/** client_id stamped on the minted JWT + registry row. Matches the admin sibling. */
const ACCOUNT_VAULT_ADMIN_CLIENT_ID = "parachute-hub-spa";

export interface AccountVaultAdminTokenDeps {
  db: Database;
  /** Hub origin for this request — `iss` of the minted token + base of the redirect URL. */
  hubOrigin: string;
  /**
   * The vault's declared `managementUrl` (from its `.parachute/module.json`),
   * resolved by the route handler at request time. Either an absolute URL or a
   * path relative to the vault's mounted URL. Defaults to `/admin/` (vault's
   * canonical value) when the handler can't resolve one — that's where the
   * admin sibling's deep-link lands too.
   */
  managementUrl?: string;
  /** Test seam for the clock (mint). */
  now?: () => Date;
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/**
 * Resolve a vault's `managementUrl` against the vault's hub-mounted URL.
 * Absolute URL → returned verbatim; path → joined onto the vault URL after
 * trimming a trailing slash. Mirrors `resolveManagementUrl` in the SPA's
 * `web/ui/src/lib/api.ts` so hub-server and SPA deep-links agree.
 */
function resolveManagementUrl(vaultUrl: string, managementUrl: string): string {
  if (/^https?:\/\//i.test(managementUrl)) return managementUrl;
  const base = vaultUrl.replace(/\/+$/, "");
  const tail = managementUrl.startsWith("/") ? managementUrl : `/${managementUrl}`;
  return `${base}${tail}`;
}

export async function handleAccountVaultAdminTokenPost(
  req: Request,
  vaultName: string,
  deps: AccountVaultAdminTokenDeps,
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
        message: "Please sign in before opening your vault's admin tools.",
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

  // CSRF — verify before any state change, same shape + 400 as the other
  // `/account/*` POSTs.
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

  // Vault-name shape guard — reject anything that can't be a services.json key
  // before any DB / authority work. Same posture as the other vault-token mints.
  if (!VAULT_NAME_RE.test(vaultName)) {
    return htmlResponse(
      renderAdminError({
        title: "Invalid vault name",
        message: `"${vaultName}" is not a valid vault name.`,
      }),
      400,
    );
  }

  // Gate 2 — assignment + admin-verb cap. `vaultVerbsForUserVault` returns:
  //   - null  → no assignment for this vault → 403.
  //   - [...] → the verbs the assignment role permits; must include `admin`.
  // Assigned users hold read/write/admin on their vault (2026-05-30); the first
  // admin has no `user_vaults` rows so gets `null` here and a 403 — by design,
  // admins use the SPA path. This is the cap to the user's actual authority.
  const allowed = vaultVerbsForUserVault(deps.db, user.id, vaultName);
  if (allowed === null || !allowed.includes("admin")) {
    return htmlResponse(
      renderAdminError({
        title: "Not your vault to manage",
        message: `You don't have admin access to a vault named "${vaultName}". Ask the hub operator if you think this is wrong.`,
      }),
      403,
    );
  }

  // Force-change-password gate (item F / hub#469). An admin-created/reset user
  // with `password_changed: false` is sent to the change-password rail BEFORE
  // minting — same gate `/account/vault-token` applies, so a temp-password
  // handoff can't be parlayed into a vault-admin deep-link. Placed AFTER the
  // authority gates (an unassigned/garbage request still gets its 403/400) and
  // BEFORE the mint. 303 so the browser re-issues as GET. Does NOT reintroduce
  // the bypass #469 closed.
  if (!user.passwordChanged) {
    return new Response(null, {
      status: 303,
      headers: { location: "/account/change-password", "cache-control": "no-store" },
    });
  }

  // Mint the vault-admin deep-link token. Short TTL (10 min, matching the admin
  // sibling) — it's a bootstrap token the vault SPA trades for its session, not
  // a long-lived headless credential (that's `/account/vault-token`).
  const scope = `vault:${vaultName}:admin`;
  const audience = `vault.${vaultName}`;
  const minted = await signAccessToken(deps.db, {
    sub: user.id,
    scopes: [scope],
    audience,
    clientId: ACCOUNT_VAULT_ADMIN_CLIENT_ID,
    issuer: deps.hubOrigin,
    ttlSeconds: VAULT_ADMIN_TOKEN_TTL_SECONDS,
    vaultScope: [vaultName],
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  recordTokenMint(deps.db, {
    jti: minted.jti,
    createdVia: "cli_mint",
    subject: user.id,
    // Anchor the registry row to the user's id so the operator's token registry
    // + the revocation list attribute it correctly.
    userId: user.id,
    clientId: ACCOUNT_VAULT_ADMIN_CLIENT_ID,
    scopes: [scope],
    expiresAt: minted.expiresAt,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  // Build the redirect target: <vault-url><managementUrl>#token=<jwt>. The
  // vault URL is the hub-mounted path (`<hubOrigin>/vault/<name>`); the
  // managementUrl (default `/admin/`) is the vault admin SPA entry point. The
  // JWT rides the URL fragment — never sent to the server — exactly as the hub
  // SPA's "Manage" button does (vault PR #219).
  const trimmedOrigin = deps.hubOrigin.replace(/\/+$/, "");
  const vaultUrl = `${trimmedOrigin}/vault/${vaultName}`;
  const target = resolveManagementUrl(vaultUrl, deps.managementUrl ?? "/admin/");
  const sep = target.includes("#") ? "&" : "#";
  const location = `${target}${sep}token=${minted.token}`;

  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store" },
  });
}
