/**
 * Native OAuth handlers for the hub. Each handler is a pure function over
 * `(db, req)` returning a `Response` — no global state, no side channels —
 * so the test harness can drive the full OAuth dance without standing up
 * `Bun.serve` or going near the network.
 *
 * Endpoints implemented:
 *   - GET  /.well-known/oauth-authorization-server  (RFC 8414 metadata)
 *   - GET  /oauth/authorize                          (login → consent → code)
 *   - POST /oauth/authorize                          (form posts: login + consent)
 *   - POST /oauth/authorize/approve                  (operator-driven inline DCR approval, #208)
 *   - POST /oauth/token                              (grant_type=authorization_code | refresh_token)
 *   - POST /oauth/register                           (RFC 7591 DCR)
 *   - POST /oauth/revoke                             (RFC 7009 token revocation)
 *
 * `client_credentials` is intentionally unimplemented — it's not in the
 * launch surface (no machine-to-machine clients yet); the token endpoint
 * stubs it with `unsupported_grant_type`.
 *
 * HTML for login + consent + error views lives in `oauth-ui.ts` so the
 * handlers stay focused on protocol logic and the templates stay focused
 * on presentation.
 */
import type { Database } from "bun:sqlite";
import { AdminAuthError, adminAuthErrorResponse, requireScope } from "./admin-auth.ts";
import { renderTotpChallenge } from "./admin-login-ui.ts";
import {
  AuthCodeExpiredError,
  AuthCodeNotFoundError,
  AuthCodePkceMismatchError,
  AuthCodeRedirectMismatchError,
  AuthCodeUsedError,
  issueAuthCode,
  redeemAuthCode,
} from "./auth-codes.ts";
import {
  type ClientStatus,
  type OAuthClient,
  type RegisteredClient,
  approveClient,
  getClient,
  isValidRedirectUri,
  registerClient,
  requireRegisteredRedirectUri,
  verifyClientSecret,
} from "./clients.ts";
import { CSRF_FIELD_NAME, ensureCsrfToken, verifyCsrfToken } from "./csrf.ts";
import { isCoveredByGrant, isCoveredByGrantForClientName, recordGrant } from "./grants.ts";
import { consumeFirstClientAutoApproveWindow } from "./hub-settings.ts";
import { VAULT_VERBS, inferAudience } from "./jwt-audience.ts";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  RefreshTokenInsertError,
  findRefreshToken,
  findTokenRowByJti,
  revokeFamily,
  signAccessToken,
  signRefreshToken,
} from "./jwt-sign.ts";
import {
  type AuthorizeFormParams,
  renderApprovePending,
  renderConsent,
  renderError,
  renderLogin,
  renderUnknownClient,
} from "./oauth-ui.ts";
import { isSameOriginRequest } from "./origin-check.ts";
import { buildPendingLoginCookie, createPendingLogin } from "./pending-login.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import { narrowResourceVaultScopes, resolveResourceVault } from "./resource-binding.ts";
import { isNonRequestableScope, isRequestableScope, scopeIsAdmin } from "./scope-explanations.ts";
import { findUnknownScopes, loadDeclaredScopes } from "./scope-registry.ts";
import {
  type ServicesManifest,
  // Hot-path OAuth flows use the lenient reader so a single malformed
  // services.json row (e.g. from a buggy module install) doesn't crash
  // the entire OAuth dispatch. See hub#406.
  readManifestLenient as readServicesManifest,
} from "./services-manifest.ts";
import {
  SESSION_TTL_MS,
  buildSessionCookie,
  createSession,
  findActiveSession,
  findSession,
  parseSessionCookie,
} from "./sessions.ts";
import { isTotpEnrolled } from "./two-factor-store.ts";
import {
  getUserById,
  getUserByUsername,
  isFirstAdmin,
  vaultVerbsForUserVault,
  verifyPassword,
} from "./users.ts";
import { listVaultNames } from "./vault-names.ts";
import { isVaultEntry, shortName, vaultInstanceNameFor } from "./well-known.ts";

/** Verbs whose unnamed `vault:<verb>` form needs picker disambiguation. */
function unnamedVaultVerbs(scopes: string[]): string[] {
  const verbs: string[] = [];
  for (const s of scopes) {
    const parts = s.split(":");
    const verb = parts[1];
    if (parts.length === 2 && parts[0] === "vault" && verb && VAULT_VERBS.has(verb)) {
      verbs.push(verb);
    }
  }
  return verbs;
}

/** Rewrite each unnamed `vault:<verb>` to `vault:<picked>:<verb>`. */
function narrowVaultScopes(scopes: string[], pickedVault: string): string[] {
  return scopes.map((s) => {
    const parts = s.split(":");
    const verb = parts[1];
    if (parts.length === 2 && parts[0] === "vault" && verb && VAULT_VERBS.has(verb)) {
      return `vault:${pickedVault}:${verb}`;
    }
    return s;
  });
}

/**
 * Derive the `vault_scope` claim value for a given hub user. Multi-user
 * Phase 2 PR 2 (design 2026-05-20-multi-user-phase-1.md §Phase 2 —
 * many-to-many membership via the `user_vaults` table).
 *
 *   - `userId` resolves to no row → `[]`. Defensive: the caller already
 *     validated the user existed (auth-code redemption / refresh row's
 *     user_id), but a delete-between-mint-and-now race shouldn't 500.
 *     Empty is the safe sentinel — the scope-bearing `scope` claim is
 *     still the gate.
 *   - First admin → `[]`. Admin posture is unrestricted by design (see
 *     `isFirstAdmin`). The consent picker is the source of truth and
 *     the scope-guard reads an empty `vault_scope` claim as "no
 *     narrowing" — first admin can request scope against any vault.
 *   - Non-admin user → the list of vault names from `user_vaults`. The
 *     scope-guard at vault/notes/scribe enforces that the user can
 *     only request scope against vaults in their list (Phase 1 pinned
 *     to a single vault; Phase 2 lifts that to N). A non-admin with
 *     zero assignments returns `[]` — distinct semantics from the
 *     admin's `[]` because the consent picker plus the picked-must-
 *     match-assignment defense in `handleConsentSubmit` enforces that
 *     non-admin tokens carry a non-empty `vault_scope`.
 *
 * Always returns an array (never undefined) so the JWT carries the claim
 * unconditionally — readers don't have to distinguish "absent" from "empty."
 */
export function vaultScopeForUser(db: Database, userId: string): string[] {
  if (isFirstAdmin(db, userId)) return [];
  const user = getUserById(db, userId);
  if (!user) return [];
  return [...user.assignedVaults];
}

export interface OAuthDeps {
  /** Hub origin used for `iss`, `authorization_endpoint`, etc. */
  issuer: string;
  /** Override the clock for deterministic tests. */
  now?: () => Date;
  /**
   * Resolve the declared-scope set the issuer is willing to sign. Production
   * walks `services.json` + each module's `.parachute/module.json`
   * `scopes.defines` and unions with `FIRST_PARTY_SCOPES`. Tests inject a
   * pinned set so the gate is deterministic without a fixture services.json.
   * See cli#71 + `oauth-scopes.md`.
   */
  loadDeclaredScopes?: () => ReadonlySet<string>;
  /**
   * Resolve the installed-services manifest used to populate the `services`
   * catalog in /oauth/token responses (cli#81). Production reads
   * `~/.parachute/services.json`; tests inject a fixture.
   */
  loadServicesManifest?: () => ServicesManifest;
  /**
   * Set of origins (`scheme://host:port`) the hub considers itself bound to.
   * Drives the same-origin defense on cookie-based POST endpoints: a request
   * whose Origin/Referer matches any bound origin is accepted; everything
   * else is rejected as cross-origin. Production wires this from
   * `buildHubBoundOrigins` with the hub's port + expose-state hostname so
   * loopback + tailnet + funnel access all work without restarting hub
   * after `parachute expose`. Tests inject deterministic sets. When absent,
   * the gate falls back to `[issuer]` — pre-#245 behavior — so callers that
   * don't yet thread this through stay correct on a single-origin hub.
   */
  hubBoundOrigins?: () => readonly string[];
}

export interface ServicesCatalogEntry {
  url: string;
  version: string;
}

export type ServicesCatalog = Record<string, ServicesCatalogEntry>;

/**
 * Build the `services` map embedded in /oauth/token responses. Each entry maps
 * a short service name (`vault`, `scribe`, `notes`, …) to its absolute URL +
 * version, so OAuth clients don't have to re-probe `/.well-known/parachute.json`
 * to know where vault lives.
 *
 * URL source: `entry.paths[*]` from services.json verbatim — never hardcode
 * `/vault/default`. Users who installed with `parachute install vault
 * --vault-name work` have `paths: ["/vault/work"]` in their manifest, and the
 * catalog URL must follow that. The custom-vault-name regression test in
 * oauth-handlers.test.ts pins this for single-vault.
 *
 * Filtering: only services for which the token has at least one scope are
 * included. A scope `vault:read` admits the `vault` service; a token with only
 * `scribe:transcribe` gets a catalog with no vault entry. The check is on the
 * audience prefix (`<aud>:<verb>`) — same shape `inferAudience` uses.
 *
 * Multi-vault (closes #247): emits per-vault keys `vault:<name>` alongside
 * the collapsed `vault` key. A scope `vault:boulder:write` admits only
 * boulder → emits `vault:boulder` (and the legacy `vault` key, pointing at
 * boulder so it resolves consistently). A broad scope `vault:read` admits
 * every vault on the hub → emits `vault:<name>` for each vault path plus
 * the legacy `vault` key (pointing at `entry.paths[0]` of the first vault,
 * unchanged from Phase 1). Notes' OAuthCallback (notes#115 ships the
 * picker; per-vault consumer change is the post-#247 Notes-side PR) reads
 * `services["vault:<name>"]` so it stops collapsing multi-vault grants
 * onto a single VaultRecord URL.
 *
 * Pre-popover clients still see `services.vault` and behave unchanged —
 * that key never goes away. Per-vault keys are additive.
 */
export function buildServicesCatalog(
  manifest: ServicesManifest,
  issuer: string,
  scopes: readonly string[],
): ServicesCatalog {
  // Two scope-derived sets:
  //   - audiences: bare service prefix (`vault`, `scribe`) → admits the
  //     collapsed key + every per-vault key.
  //   - namedVaults: per-vault narrowed scopes (`vault:<name>:<verb>`) →
  //     admits only `vault:<name>` and the collapsed `vault`.
  //
  // A token with both `vault:read` and `vault:boulder:write` should land in
  // the "any vault" bucket — the bare scope is permissive, the named one
  // is informational. Detect this via the bare-prefix presence; the named
  // scope's per-vault narrowing still works for clients that prefer it.
  const audiences = new Set<string>();
  const namedVaults = new Set<string>();
  for (const s of scopes) {
    const parts = s.split(":");
    if (
      parts.length === 3 &&
      parts[0] === "vault" &&
      parts[1] &&
      parts[2] &&
      VAULT_VERBS.has(parts[2])
    ) {
      namedVaults.add(parts[1]);
      audiences.add("vault");
      continue;
    }
    const colon = s.indexOf(":");
    if (colon > 0) audiences.add(s.slice(0, colon));
  }
  const broadVaultScope =
    audiences.has("vault") &&
    scopes.some((s) => {
      const parts = s.split(":");
      return (
        parts.length === 2 &&
        parts[0] === "vault" &&
        parts[1] !== undefined &&
        VAULT_VERBS.has(parts[1])
      );
    });

  // Count total admitted vault paths across the manifest. Per-vault keys
  // are only worth emitting when there are >1 admitted vaults to
  // disambiguate (or when the token's own scopes are per-vault narrowed —
  // a per-vault scope is an explicit consumer signal that the per-vault
  // key matters even on a single-vault hub). The check is on admitted
  // paths, not raw vault rows: a broad token on a multi-path vault row
  // sees N paths; a per-vault token sees only its own.
  let admittedVaultPathCount = 0;
  if (audiences.has("vault")) {
    for (const entry of manifest.services) {
      if (!isVaultEntry(entry)) continue;
      const paths = entry.paths.length > 0 ? entry.paths : ["/"];
      for (const path of paths) {
        const instance = vaultInstanceNameFor(entry.name, path);
        if (broadVaultScope || namedVaults.has(instance)) admittedVaultPathCount++;
      }
    }
  }
  const emitPerVaultKeys = admittedVaultPathCount > 1 || namedVaults.size > 0;

  const base = issuer.replace(/\/$/, "");
  const catalog: ServicesCatalog = {};
  for (const entry of manifest.services) {
    if (isVaultEntry(entry)) {
      if (!audiences.has("vault")) continue;
      // Walk every path the row exposes. Real multi-vault on the hub is a
      // single `parachute-vault` row with N paths (one per vault instance);
      // legacy per-vault rows (`parachute-vault-<name>`) are handled by the
      // same loop because each contributes one path.
      const paths = entry.paths.length > 0 ? entry.paths : ["/"];
      for (const path of paths) {
        const instance = vaultInstanceNameFor(entry.name, path);
        const admit = broadVaultScope || namedVaults.has(instance);
        if (!admit) continue;
        if (emitPerVaultKeys) {
          const perVaultKey = `vault:${instance}`;
          if (!catalog[perVaultKey]) {
            catalog[perVaultKey] = { url: `${base}${path}`, version: entry.version };
          }
        }
        // Collapsed `vault` key stays for backwards compat. First admitted
        // vault wins (deterministic — `entry.paths[0]` for a broad scope,
        // or the only admitted instance for a per-vault scope).
        if (!catalog.vault) {
          catalog.vault = { url: `${base}${path}`, version: entry.version };
        }
      }
      continue;
    }
    const key = shortName(entry.name);
    if (!audiences.has(key)) continue;
    if (catalog[key]) continue;
    const path = entry.paths[0] ?? "/";
    catalog[key] = { url: `${base}${path}`, version: entry.version };
  }
  return catalog;
}

// --- helpers ---------------------------------------------------------------

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function htmlResponse(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extra },
  });
}

function redirectResponse(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...extra } });
}

function htmlError(title: string, message: string, status: number): Response {
  return htmlResponse(renderError({ title, message, status }), status);
}

function oauthErrorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return redirectResponse(u.toString());
}

// --- /.well-known/oauth-protected-resource ---------------------------------

/**
 * RFC 9728 (April 2025) — OAuth 2.0 Protected Resource Metadata. The
 * resource-server-side companion to `authorizationServerMetadata`. MCP
 * clients (since the 2025-06-18 spec draft) probe this endpoint to
 * discover which authorization server signs tokens for the resource,
 * which scopes the resource accepts, and how tokens are presented.
 *
 * Hub-as-resource posture: hub itself is the protected resource. The
 * authorization server is also hub (the issuer). The advertised scopes
 * mirror `authorizationServerMetadata.scopes_supported` — same set, same
 * filtering (operator-only scopes hidden per RFC 8414 §2 framing).
 *
 * Per-vault metadata could also live at
 * `/vault/<name>/.well-known/oauth-protected-resource` to scope the
 * advertised resource indicator and scope subset to one vault. Deferred
 * until an MCP client actually probes that path — today the spec
 * accepts the hub-level form for the resource indicator.
 *
 * Closes hub#393.
 */
export function protectedResourceMetadata(deps: OAuthDeps): Response {
  const iss = deps.issuer;
  const declared = (deps.loadDeclaredScopes ?? loadDeclaredScopes)();
  return jsonResponse({
    resource: iss,
    authorization_servers: [iss],
    scopes_supported: Array.from(declared).filter(isRequestableScope),
    bearer_methods_supported: ["header"],
    resource_documentation: "https://parachute.computer",
    // Intentional omission: `resource_signing_alg_values_supported` +
    // `signed_metadata`. Hub serves the resource metadata document
    // unsigned today — MCP clients that probe for a signed metadata
    // JWT will fall back to verifying the resource via the
    // authorization-server's JWKS-signed access tokens. When the signed
    // metadata path lands here (likely once a downstream MCP client
    // requires it for offline verification), add the alg list + the
    // `signed_metadata` JWT alongside.
  });
}

// --- /.well-known/oauth-authorization-server -------------------------------

export function authorizationServerMetadata(deps: OAuthDeps): Response {
  const iss = deps.issuer;
  // Advertise the full declared-scope set — FIRST_PARTY ∪ each registered
  // module's `scopes.defines` — so standards-following clients discover
  // third-party scopes (e.g. parachute-agent's `agent:*`) the same way they discover
  // first-party ones. The token-issuance path already consults
  // `loadDeclaredScopes` (see #90); metadata had to follow or the issuer's
  // public advertisement would be a strict subset of what it'll actually
  // sign. Closes #91.
  const declared = (deps.loadDeclaredScopes ?? loadDeclaredScopes)();
  return jsonResponse({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // Operator-only scopes (NON_REQUESTABLE_SCOPES) are intentionally absent
    // — RFC 8414 §2 frames `scopes_supported` as "the OAuth 2.0 [...] scope
    // values that this authorization server supports" for clients to request.
    // Advertising what we always reject would mislead clients.
    scopes_supported: Array.from(declared).filter(isRequestableScope),
  });
}

/** Find any requested scopes that the public flow refuses to mint. */
function findNonRequestableScopes(scopes: readonly string[]): string[] {
  return scopes.filter(isNonRequestableScope);
}

// --- /oauth/authorize ------------------------------------------------------

function parseAuthorizeFormParams(url: URL): AuthorizeFormParams | { error: string } {
  const required = (k: string) => {
    const v = url.searchParams.get(k);
    return v && v.length > 0 ? v : null;
  };
  const clientId = required("client_id");
  const redirectUri = required("redirect_uri");
  const responseType = required("response_type");
  const scope = url.searchParams.get("scope") ?? "";
  const codeChallenge = required("code_challenge");
  const codeChallengeMethod = required("code_challenge_method");
  if (!clientId) return { error: "missing client_id" };
  if (!redirectUri) return { error: "missing redirect_uri" };
  if (!responseType) return { error: "missing response_type" };
  if (!codeChallenge) return { error: "missing code_challenge" };
  if (!codeChallengeMethod) return { error: "missing code_challenge_method" };
  return {
    clientId,
    redirectUri,
    responseType,
    scope,
    codeChallenge,
    codeChallengeMethod,
    state: url.searchParams.get("state"),
    // RFC 8707 resource indicator (optional). When present and resolvable to
    // a per-vault MCP resource, drives the narrow-consent + named-scope path.
    resource: url.searchParams.get("resource"),
  };
}

/**
 * "App not yet approved" page (#74) for /oauth/authorize. When the request
 * carries a valid operator session AND a same-origin Origin/Referer, render
 * the inline approve form (#208) so one click flips the client to `approved`
 * and the OAuth flow re-enters at consent. Otherwise render the unauth CTAs
 * (Sign-in primary + shareable deep link secondary; the CLI fallback was
 * retired in rc.19).
 *
 * The session-bound approve gate mirrors the same-origin DCR auto-approve
 * gate on `/oauth/register` (#199, #200): valid session cookie + matching
 * Origin/Referer = trusted operator action. Cross-origin or session-less
 * GETs see the unauth CTA; the button never renders for them, so the POST
 * handler can't be tricked into approving via a hand-crafted form either
 * (CSRF token won't match).
 *
 * BOTH branches plumb the original `/oauth/authorize?...` URL into the
 * rendered page so the OAuth flow can resume after the operator's action:
 *
 *   - Authed branch: form's `return_to` is the authorize URL; the approve
 *     POST handler 302s there after flipping status (open-redirect defense
 *     in the POST handler validates `return_to` is hub-relative).
 *   - Unauth branch: CTA's `next` is the authorize URL; `/login` 302s there
 *     after sign-in (`safeNext` in admin-handlers.ts gates the target to
 *     hub-relative paths). The operator lands back on this same page,
 *     now authenticated → enters the authed branch above → one-click
 *     approve resumes the OAuth flow.
 *
 * Pre-fix the unauth CTA pointed at `/admin/approve-client/<id>` (the SPA
 * approve page) — which approves the client but discards the in-flight
 * authorize URL, so the calling app (e.g. Claude MCP via Claude.ai) is
 * never told and the user loops on retry. Caught when Aaron hit it on the
 * Render deploy via Claude.ai's MCP connector.
 */
function pendingClientResponse(
  db: Database,
  req: Request,
  client: OAuthClient,
  authorizeUrl: URL,
  deps: OAuthDeps,
): Response {
  const requestedScopes = (authorizeUrl.searchParams.get("scope") ?? "")
    .split(" ")
    .filter((s) => s.length > 0);
  // Vault hint (closes #244): Notes' VaultPopover (notes#115) sets this on
  // the authorize URL when kicking OAuth for a specific vault. Empty-string
  // values normalize to undefined so the approve UI omits the row rather
  // than rendering a blank vault label.
  const vaultParam = authorizeUrl.searchParams.get("vault");
  const requestedVault = vaultParam && vaultParam.length > 0 ? vaultParam : undefined;
  const session = findActiveSession(db, req, deps.now ?? (() => new Date()));
  const sameOrigin = isSameOriginRequest(req, resolveBoundOrigins(deps));

  // Trust-by-client_name auto-approve (closes hub#409). When the requesting
  // user has previously approved a client with the SAME client_name AND the
  // current request's scopes are covered by that prior grant, auto-promote
  // this pending client to approved + carry on as if status had been
  // approved from the start.
  //
  // Motivation: CLI MCP clients (Claude Code et al.) re-DCR each session,
  // each landing a fresh client_id. Strict (user, client_id) approval forces
  // the operator to click Approve every single time even though they
  // already approved the same client by name on every prior session. Aaron
  // 2026-05-26: "once we've approved something like claude once it should
  // not need admin approval every other time."
  //
  // Constraints (security guardrails kept):
  //   1. Requires an active operator session — anonymous DCR can't ride
  //      another operator's prior trust.
  //   2. Requires same-origin — defends against an attacker registering a
  //      malicious "claude-code" client on a different hub and tricking
  //      the operator into authorizing it.
  //   3. Requires a non-empty client_name — DCR allows omitting it, in
  //      which case the prior-grant lookup has nothing to match against.
  //   4. Requires scope coverage — a strict superset (the new request asks
  //      for scopes the prior grant didn't cover) falls through to the
  //      approve-pending screen so the operator explicitly approves the
  //      addition.
  //   5. Non-admin scopes only — `*:admin` scopes (hub:admin, vault:*:admin
  //      if it ever becomes requestable) require explicit per-session
  //      consent. This guard mirrors the same-hub-auto-trust gate's
  //      treatment of admin scopes (handleAuthorizeGet ~line 854).
  //      NOTE: `scopeIsAdmin` has a documented blind spot for
  //      module-declared admin scopes (e.g. a hypothetical `runner:admin`
  //      registered via a module manifest's scopes.defines). See
  //      `src/scope-explanations.ts:191`. A future module that makes a
  //      module-admin scope requestable via public DCR would silently
  //      bypass this guard. Worth a tighter scope-classification helper
  //      when that becomes a real risk.
  if (
    session &&
    sameOrigin &&
    client.clientName &&
    requestedScopes.length > 0 &&
    !requestedScopes.some(scopeIsAdmin) &&
    isCoveredByGrantForClientName(db, session.userId, client.clientName, requestedScopes)
  ) {
    console.log(
      `[oauth] auto-approved pending client by prior client_name trust client_id=${client.clientId} client_name=${JSON.stringify(client.clientName)} user_id=${session.userId} scopes=${requestedScopes.join(" ")} (hub#409)`,
    );
    approveClient(db, client.clientId);
    // Re-record the grant for this fresh client_id so the standard
    // (user, client_id) consent-skip path also fires on the IMMEDIATE
    // continuation below — without this, the very next /oauth/authorize
    // dispatch would re-enter the "is grant covered?" check against the
    // new client_id, find nothing (we matched by name, not id), and
    // render the consent screen anyway.
    recordGrant(db, session.userId, client.clientId, requestedScopes, deps.now?.() ?? new Date());
    // Fall through to the standard approved-client flow: re-fetch the
    // refreshed row + let handleAuthorizeGet continue past the
    // status-check + into the consent-skip / same-hub auto-trust path.
    const refreshed = getClient(db, client.clientId);
    if (refreshed && refreshed.status === "approved") {
      return handleAuthorizeGet(db, req, deps);
    }
    // If for some reason the refresh failed, fall through to render the
    // approve-pending page (defensive — should never happen given the
    // approveClient call just above).
  }
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  // Hub-relative URL of the original `/oauth/authorize?...` request. Used in
  // BOTH branches so the post-approve path (authed: form's `return_to`) and
  // the post-login path (unauthed: CTA's `next`) round-trip the operator
  // back to the same OAuth flow. Without `loginNextUrl` on the unauth
  // branch, the operator post-login would land on the SPA approve page
  // with no knowledge of the in-flight authorize URL — the SPA approves
  // the client but the OAuth flow never completes, the calling app (e.g.
  // Claude MCP) is never told, and the user loops on retry. Fix lands the
  // unauth flow on the same authorize URL, post-login the operator hits
  // the authed branch's inline approve form, and the flow resumes.
  const returnTo = `${authorizeUrl.pathname}${authorizeUrl.search}`;
  if (session && sameOrigin) {
    // Plumb redirect_uri + state for the Deny path (hub#390): an operator
    // who clicks Deny gets routed back to the client's redirect_uri with
    // an RFC 6749 §4.1.2.1 error response. redirect_uri is required by
    // the spec on /oauth/authorize so it's reliably present; state is
    // optional per the spec, so undefined-passes-through.
    //
    // We round-trip both values through hidden form inputs rather than
    // re-parsing them from `return_to` in the handler. Reason: keeps the
    // handler stateless about authorize-URL shape — it just reads the
    // form. State is also not stored server-side (it never was; OAuth
    // state lives in the query string by design).
    const requestRedirectUri = authorizeUrl.searchParams.get("redirect_uri") ?? "";
    const requestState = authorizeUrl.searchParams.get("state") ?? undefined;
    return htmlResponse(
      renderApprovePending({
        clientName: client.clientName ?? client.clientId,
        clientId: client.clientId,
        redirectUris: client.redirectUris,
        requestedScopes,
        ...(requestedVault !== undefined && { requestedVault }),
        hubOrigin: deps.issuer,
        approveForm: {
          csrfToken: csrf.token,
          returnTo,
          redirectUri: requestRedirectUri,
          ...(requestState !== undefined && { state: requestState }),
        },
        loginNextUrl: returnTo,
      }),
      403,
      extra,
    );
  }
  return htmlResponse(
    renderApprovePending({
      clientName: client.clientName ?? client.clientId,
      clientId: client.clientId,
      redirectUris: client.redirectUris,
      requestedScopes,
      ...(requestedVault !== undefined && { requestedVault }),
      hubOrigin: deps.issuer,
      loginNextUrl: returnTo,
    }),
    403,
    extra,
  );
}

/**
 * JSON response for pending clients hitting /oauth/token. Carries two
 * actionability hints alongside the OAuth error so consumers (Notes, future
 * cross-origin SPAs) can surface an inline approval path instead of dead-
 * ending on a CLI message:
 *
 *   - `approve_url` — hub-served SPA route the operator can open in a
 *     browser to approve the client in one click. Same-origin to the hub.
 *   - `cli_alternative` — the `parachute auth approve-client <id>` shell
 *     command, retained for terminal-first operators or scripted flows.
 *
 * Spec note: the OAuth error class stays `invalid_client` per RFC 6749 §5.2
 * — "this client cannot use this endpoint right now" is the semantic match.
 * `access_denied` is reserved for /authorize "user said no" flows; using it
 * here would conflate two distinct error families and break clients doing
 * strict spec-shaped handling. The extra fields are spec-permitted
 * extensions ("other parameters").
 */
/**
 * Render the "Unknown application" page surfaced by /oauth/authorize when
 * `getClient(db, clientId)` returns null. Promotes the recovery affordance
 * (a "Reset connection" button that clears `lens:dcr:*` localStorage on the
 * hub's own origin) when the request's redirect_uri points at one of the
 * hub's bound origins — that's the Notes-mounted-at-hub-origin case where
 * we can safely run inline JS against the SPA's storage.
 *
 * Root-cause shape (rc.11 fresh-machine connect bug): an operator who wipes
 * `~/.parachute/hub.db` between testing iterations strands their browser's
 * cached client_id, and the SPA has no signal to clear it without
 * operator action. The hub-side fix is to give the operator one click on
 * the error page. See `renderUnknownClient` in oauth-ui.ts for the full
 * design + the localStorage key the snippet clears.
 *
 * Cross-origin SPA redirect_uris fall back to the static error variant —
 * we can't reach a third-party SPA's storage from this page. Malformed
 * redirect_uris likewise fall back (we never trust an unparsed URL).
 */
function unknownClientResponse(
  clientId: string,
  redirectUri: string | null,
  deps: OAuthDeps,
): Response {
  const selfOriginRedirectPath = resolveSelfOriginRedirectPath(redirectUri, deps);
  return htmlResponse(
    renderUnknownClient({
      clientId,
      selfOriginRedirectPath,
    }),
    400,
  );
}

/**
 * Parse a redirect_uri and return its pathname iff its origin is one the
 * hub serves itself (any entry in `hubBoundOrigins`). Returns null when
 * the URL is missing, malformed, or points at a non-hub origin — the
 * caller falls back to a static error in those cases. The pathname is
 * what the "Reset connection" button navigates to after clearing the
 * SPA's cached client_id; e.g. for `http://localhost:1939/notes/oauth/callback`
 * we return `/notes/oauth/callback`. The SPA then routes that internally
 * (Notes' /oauth/callback handler harmlessly errors on missing code +
 * state, and the user gets dropped onto the connect screen for a fresh
 * DCR — that's the recovery path).
 *
 * Pathname-only (not the full URL) is deliberate: same-origin navigation
 * is trivially safe, and we don't want to surface a redirect that
 * leaves the hub's origin even when the redirect_uri claims it. If a
 * future SPA needs different recovery semantics, this is the seam.
 */
function resolveSelfOriginRedirectPath(redirectUri: string | null, deps: OAuthDeps): string | null {
  if (!redirectUri) return null;
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return null;
  }
  const bound = resolveBoundOrigins(deps);
  if (!bound.includes(parsed.origin)) return null;
  return parsed.pathname || "/";
}

function pendingClientJson(clientId: string, issuer: string): Response {
  const base = issuer.replace(/\/$/, "");
  return jsonResponse(
    {
      error: "invalid_client",
      error_description: "client is registered but has not been approved by the hub operator (#74)",
      approve_url: `${base}/admin/approve-client/${encodeURIComponent(clientId)}`,
      cli_alternative: `parachute auth approve-client ${clientId}`,
    },
    401,
  );
}

/**
 * GET /oauth/authorize — entrypoint. Validates client + redirect_uri, then
 * either renders the login form (no session) or the consent screen (session
 * present). All authorize-time params are echoed back via hidden inputs so
 * the form POST keeps the binding intact.
 *
 * ## Silent-approve flow (skip-consent gate, hub#75, hub#236)
 *
 * Cross-surface session smoothness ("first Notes use prompts for consent;
 * subsequent uses are seamless") rides on a single gate further down in
 * this function. The end-to-end flow:
 *
 *   1. **First use.** A client lands on `/oauth/authorize` with scope `S`.
 *      The user has a session but no prior `grants` row for this
 *      (user, client) pair. `isCoveredByGrant` returns false; the gate
 *      falls through; the consent screen renders. User clicks approve →
 *      `handleAuthorizePost` records a `grants` row keyed on
 *      (user_id, client_id) with the approved scopes, then mints the
 *      auth code.
 *   2. **Subsequent use, same scopes.** Same client lands on
 *      `/oauth/authorize` with scope `S` again. `isCoveredByGrant` finds
 *      the row and returns true. The gate fires: auth code minted
 *      directly via `issueAuthCodeRedirect`; no consent screen renders;
 *      operator sees a silent redirect. This is the seamless second-use
 *      experience.
 *   3. **Subsequent use, subset.** Client asks for scope `S' ⊂ S`. The
 *      grant covers every requested scope; gate fires.
 *   4. **Subsequent use, novel scope.** Client asks for scope `S''`
 *      where `S'' ⊄ S` (a strict superset, or any new scope). The grant
 *      doesn't cover the new ask; gate falls through; consent re-renders
 *      with the new scope explicit. User must approve to extend the grant.
 *   5. **Grant revoked.** Operator revokes via `/admin/permissions` or
 *      `parachute auth revoke-grant`. The next /authorize re-renders
 *      consent — already-minted refresh tokens keep working until they
 *      expire (or are revoked separately via `/oauth/revoke`).
 *
 * Two important constraints on the gate itself:
 *
 *   - **Unnamed vault verbs (`vault:read`) always render consent.** The
 *     vault-picker UI is the only path that binds an unnamed scope to a
 *     specific vault (grants store narrowed `vault:<name>:<verb>`, so
 *     `vault:read` never matches a stored grant literally). Re-flowing
 *     with `vault:read` must always show the picker even if any prior
 *     grant exists.
 *   - **Client re-registration breaks the grant link.** Dynamic Client
 *     Registration mints a fresh `client_id` each time; grants are keyed
 *     on `(user_id, client_id)` so a re-registered client looks brand-
 *     new and re-prompts for consent. (Intentional: the operator should
 *     re-consent to an app whose registration was destroyed and re-made
 *     — that's a stronger signal of "this is the same app I trusted"
 *     than the redirect URI alone.)
 *
 * The full grant-scope subset semantics live in `grants.ts`
 * `isCoveredByGrant`; the gate itself is the if-block below the
 * "Skip-consent gate" comment in this function.
 *
 * Pinned by the regression test "first-use consent → silent-approve →
 * novel scope re-prompts" in `oauth-handlers.test.ts` (hub#236), plus
 * the per-branch tests in the same describe block (subset / superset /
 * revoke / unnamed-vault / re-registered-client).
 */
export function handleAuthorizeGet(db: Database, req: Request, deps: OAuthDeps): Response {
  const url = new URL(req.url);
  const parsed = parseAuthorizeFormParams(url);
  if ("error" in parsed) {
    return htmlError("Invalid authorization request", parsed.error, 400);
  }
  if (parsed.responseType !== "code") {
    return oauthErrorRedirect(
      parsed.redirectUri,
      "unsupported_response_type",
      "only response_type=code is supported",
      parsed.state,
    );
  }
  if (parsed.codeChallengeMethod !== "S256") {
    return oauthErrorRedirect(
      parsed.redirectUri,
      "invalid_request",
      "PKCE S256 is required",
      parsed.state,
    );
  }
  let client = getClient(db, parsed.clientId);
  if (!client) {
    // Can't safely redirect — we don't trust the redirect_uri until we've
    // matched it against a registered client. Render an HTML error that
    // promotes a one-click recovery when the redirect_uri points at one
    // of our own origins (the canonical fresh-machine repro: an operator
    // wiped hub.db, the SPA still holds the old client_id in
    // localStorage, the recovery is "clear that key and reload the SPA").
    return unknownClientResponse(parsed.clientId, parsed.redirectUri, deps);
  }
  if (client.status !== "approved") {
    // Single-consent change (2026-05-29): the separate operator "approve this
    // client" gate is retired — the user's OAuth consent IS the authorization.
    // A request carrying a valid session auto-approves the pending client and
    // FALLS THROUGH into the normal consent path below (resource-narrow →
    // non-requestable gate → skip-consent / same-hub → consent render). A
    // session-less request still renders the unauth "App not yet approved"
    // page (`pendingClientResponse`), whose sign-in CTA (`loginNextUrl`)
    // round-trips back to this authorize URL; after login the user re-enters
    // WITH a session → hits this auto-approve branch → consent.
    //
    // We resolve the session via the same `parseSessionCookie` + `findSession`
    // pair the consent path uses below (not `findActiveSession`) so the
    // auto-approve predicate and the consent render agree on session identity.
    const earlySessionId = parseSessionCookie(req.headers.get("cookie"));
    const earlySession = earlySessionId ? findSession(db, earlySessionId) : null;
    if (!earlySession) {
      return pendingClientResponse(db, req, client, url, deps);
    }
    console.log(
      `[oauth] auto-approved client on user consent (single-consent) client_id=${client.clientId} user_id=${earlySession.userId} (2026-05-29)`,
    );
    approveClient(db, client.clientId);

    // Trust-by-client_name carry-over (hub#409, preserved through the
    // single-consent change). Notes/Claude DCR a fresh client_id per session;
    // when the user has a prior grant under the SAME client_name that covers
    // the requested scopes, re-link must stay SILENT. The skip-consent gate
    // below keys on (user, client_id) and the fresh client_id has no grant
    // yet — so we re-record that prior coverage onto the fresh client_id here.
    // The mint downstream goes through `issueAuthCodeRedirect`, which caps to
    // held authority, so this carry-over can never silently re-grant an
    // un-held verb. Guarded identically to the in-`pendingClientResponse`
    // block: same-origin + non-empty client_name + non-admin requested scopes
    // (`scopeIsAdmin` recognizes the named admin form now — load-bearing) +
    // prior-grant coverage. When it doesn't apply, fall through to the consent
    // render (the single-consent payoff: one consent screen, then silent).
    const earlyRequested = parsed.scope.split(" ").filter((s) => s.length > 0);
    if (
      isSameOriginRequest(req, resolveBoundOrigins(deps)) &&
      client.clientName &&
      earlyRequested.length > 0 &&
      !earlyRequested.some(scopeIsAdmin) &&
      isCoveredByGrantForClientName(db, earlySession.userId, client.clientName, earlyRequested)
    ) {
      console.log(
        `[oauth] carried prior client_name trust onto fresh client_id=${client.clientId} client_name=${JSON.stringify(client.clientName)} user_id=${earlySession.userId} scopes=${earlyRequested.join(" ")} (hub#409)`,
      );
      recordGrant(
        db,
        earlySession.userId,
        client.clientId,
        earlyRequested,
        deps.now?.() ?? new Date(),
      );
    }

    // Re-fetch so `client.status` reflects `approved` for the rest of this
    // function (the same-hub gate and consent props read `client`). Fall
    // through on success; if the refresh somehow failed, render the unauth
    // pending page defensively (should never happen given approveClient).
    const refreshed = getClient(db, client.clientId);
    if (!refreshed || refreshed.status !== "approved") {
      return pendingClientResponse(db, req, client, url, deps);
    }
    client = refreshed;
  }
  try {
    requireRegisteredRedirectUri(client, parsed.redirectUri);
  } catch {
    return htmlError(
      "Redirect mismatch",
      "The redirect_uri does not match any URI registered for this app.",
      400,
    );
  }

  // RFC 8707 resource binding. When the client named a per-vault MCP
  // resource (`<origin>/vault/<name>/mcp` or its PRM URL), narrow the
  // requested vault verbs to the named `vault:<name>:<verb>` form BEFORE any
  // downstream processing. Two effects:
  //
  //   1. The consent screen shows ONLY that vault's scopes (the picker locks
  //      to <name>) instead of the whole-hub catalog — a friend connecting to
  //      one vault no longer sees `hub:admin`, `scribe:admin`, or every other
  //      vault's verbs.
  //   2. The minted token carries the named scope, so `inferAudience` stamps
  //      `aud=vault.<name>` and a current-line vault accepts it (an unnamed
  //      `vault:read` token is rejected by `findBroadVaultScopes`).
  //
  // Narrowing happens before the non-requestable gate (below) on purpose: if
  // a resource-bound client somehow asked for `vault:admin`, narrowing makes
  // it `vault:<name>:admin`, which IS non-requestable — so the gate correctly
  // blocks it. Read/write narrow to the requestable named form. Non-vault
  // scopes and already-named scopes for other vaults pass through unchanged.
  //
  // No resource, or a resource that isn't one of our per-vault MCP resources
  // (off-origin, malformed, non-vault path) → `boundVault` is null and the
  // flow is byte-for-byte the pre-#461 behavior (manual picker, etc.).
  const boundVault = resolveResourceVault(parsed.resource, resolveBoundOrigins(deps));
  if (boundVault) {
    const narrowed = narrowResourceVaultScopes(
      parsed.scope.split(" ").filter((s) => s.length > 0),
      boundVault,
    );
    // Rewrite `parsed.scope` so the narrowed named scopes flow through every
    // downstream consumer: the login-redirect query round-trip, the consent
    // props + hidden inputs, the skip-consent grant lookup, and the
    // auth-code mint.
    parsed.scope = narrowed.join(" ");
  }

  // Operator-only scope gate (#96). Reject any request that names a scope
  // we'll never mint via this flow — `parachute:host:admin` and friends.
  // Per RFC 6749 §4.1.2.1, errors that aren't redirect-uri-related are
  // delivered by redirect with `error=invalid_scope`.
  const requestedScopes = parsed.scope.split(" ").filter((s) => s.length > 0);
  const blocked = findNonRequestableScopes(requestedScopes);
  if (blocked.length > 0) {
    return oauthErrorRedirect(
      parsed.redirectUri,
      "invalid_scope",
      `requested scopes are not available via the public authorization endpoint: ${blocked.join(", ")}`,
      parsed.state,
    );
  }

  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? findSession(db, sessionId) : null;
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  if (!session) {
    return htmlResponse(renderLogin({ params: parsed, csrfToken: csrf.token }), 200, extra);
  }

  // Multi-user Phase 2 PR 2: non-admin users see the picker narrowed to
  // their assigned vault list — they can't pick a vault they don't own.
  // First admin (admin posture) sees the full dropdown of every vault on
  // the hub.
  //
  // Two shapes for non-admin users emerge:
  //   - exactly one assigned vault → picker renders locked to that name
  //     (same shape as Phase 1; smallest diff for the common case).
  //   - two or more assigned vaults → picker renders a free dropdown
  //     filtered to those names — user picks one per consent.
  //
  // Defensive null-coalesce: the session points at a deleted user
  // shouldn't 500; treat as admin posture (the broader scope-validation
  // gate will catch any actual privilege issue).
  //
  // Resolved here (before the fast-paths) because the stale-assignment
  // predicate below — which gates both skip-consent (#75) and same-hub
  // auto-trust (hub#312) — needs both the user's assignment AND the live
  // vault list. Keeping the manifest read in the hot path is the price of
  // closing the silent-mint-on-stale-vault gap; the read is one JSON parse
  // off-disk per /authorize.
  const user = getUserById(db, session.userId);
  const userIsAdmin = isFirstAdmin(db, session.userId);
  // Non-admin user's assigned vaults; admin posture (or no row) → empty.
  const assignedVaults: string[] = userIsAdmin ? [] : (user?.assignedVaults ?? []);
  const manifest = (deps.loadServicesManifest ?? readServicesManifest)();
  const vaultNames = listVaultNames(manifest);

  // Stale-assignment predicate (hub#284, generalized in Phase 2 PR 2 from
  // single-vault to N-vault). For a non-admin user, "stale" means at
  // least one of their assigned vaults no longer exists in services.json
  // AND no vault in their list still exists — i.e. they have *zero*
  // valid vaults to consent against. The banner surfaces this state with
  // an admin-remediation hint instead of silently minting a token
  // against a missing vault. If at least one of their vaults still
  // exists, the consent flow proceeds normally — the missing ones drop
  // out of the picker without ceremony.
  //
  // Admin users are never stale (they aren't pinned to any vault list).
  const remainingValidVaults = assignedVaults.filter((v) => vaultNames.includes(v));
  const hasStaleAssignment = assignedVaults.length > 0 && remainingValidVaults.length === 0;

  // Skip-consent gate (#75). If the user has previously granted every
  // requested scope to this client, mint the auth code immediately. Three
  // important constraints:
  //   - Unnamed vault verbs (`vault:read`) need the picker even if a prior
  //     grant exists, because the operator's vault choice isn't recorded
  //     literally — grants store narrowed `vault:<name>:<verb>` scopes, so
  //     a fresh unnamed request never matches. Force consent to re-pick.
  //   - The grant covers `requestedScopes` exactly when every requested
  //     scope appears in the stored set. A strict superset (client wants
  //     something new) falls through to the consent screen.
  //   - Stale-assignment (above) also forces the consent render so the
  //     banner explains the broken state rather than silently minting a
  //     token against the missing vault.
  //   - The user is admin OR has at least one assigned vault (hub#429
  //     reviewer fold, follow-up). A zero-vault non-admin whose prior
  //     grants survived a `setUserVaults(_, [])` admin action would
  //     otherwise silently re-mint a token against the now-revoked
  //     vault assignment — the grants table has no FK cascade from
  //     `user_vaults`, so deleting assignments doesn't revoke grants.
  //     Same privesc shape as the same-hub auto-trust gate below;
  //     identical guard (`userHasVaultPosture`). Force fall-through to
  //     the consent render where the zero-vault gate in
  //     `handleConsentSubmit` also refuses (defense in depth). This
  //     also transitively defends the trust-by-client_name auto-
  //     promote path (~line 554) which recursively re-enters
  //     `handleAuthorizeGet` after promoting the pending client.
  const hasUnnamedVault = unnamedVaultVerbs(requestedScopes).length > 0;
  const userHasVaultPosture = userIsAdmin || assignedVaults.length > 0;
  if (
    !hasStaleAssignment &&
    !hasUnnamedVault &&
    userHasVaultPosture &&
    isCoveredByGrant(db, session.userId, client.clientId, requestedScopes)
  ) {
    console.log(
      `consent skipped: existing grant covers requested scope client_id=${client.clientId} user_id=${session.userId} scopes=${requestedScopes.join(" ")}`,
    );
    return issueAuthCodeRedirect(db, parsed, requestedScopes, session.userId, deps);
  }

  // Same-hub auto-trust gate (hub#312, parachute-app design §6). When the
  // DCR registrant authenticated as the operator (bearer hub:admin OR
  // session-cookie + same-origin), the resulting client is "owned by this
  // hub" — the operator who installed the app IS the implicit consent for
  // each UI the app registers. Skip the consent screen and mint the auth
  // code immediately, but only when:
  //
  //   1. The client is marked same_hub=true in the DB (set at DCR time).
  //   2. None of the requested scopes are admin-level — admin scopes
  //      (`*:admin`, `hub:admin`, per-vault `vault:<name>:admin` is non-
  //      requestable so never reaches here) are high-power enough that we
  //      still want explicit consent as a sanity gate.
  //   3. No unnamed vault verbs are requested — those need the picker to
  //      narrow `vault:<verb>` → `vault:<name>:<verb>` before mint.
  //   4. The user's assigned_vaults list is not stale (hub#284 reviewer
  //      fold) — otherwise the same-hub gate would silently mint a token
  //      for a removed vault before the consent-render path's stale
  //      detection ever runs.
  //   5. The user is admin OR has at least one assigned vault (Phase 2
  //      PR 2 reviewer fold). A zero-vault non-admin has
  //      `hasStaleAssignment=false` (length===0 short-circuits the stale
  //      predicate above) and would otherwise sail through the auto-
  //      trust gate. The resulting `vault_scope: []` claim is the admin
  //      "unrestricted" sentinel — minting it for a non-admin grants
  //      hub-wide vault access. Force fall-through to the consent
  //      render where the zero-vault gate in `handleConsentSubmit` also
  //      refuses (defense in depth).
  //
  // The grant is also recorded so subsequent flows with the same scopes
  // hit the standard skip-consent gate above. Logged so an operator
  // auditing "who did this" can trace it back to a same-hub DCR.
  const hasAdminScope = requestedScopes.some(scopeIsAdmin);
  if (
    client.sameHub &&
    !hasAdminScope &&
    !hasUnnamedVault &&
    !hasStaleAssignment &&
    userHasVaultPosture
  ) {
    console.log(
      `[oauth] auto-approved same-hub client client_id=${client.clientId} user_id=${session.userId} scopes=${requestedScopes.join(" ")} (hub#312)`,
    );
    // The grant is recorded INSIDE issueAuthCodeRedirect with the CAPPED
    // scopes (single choke-point, single source of truth) so the next
    // /authorize for this (user, client, scopes) hits the standard
    // skip-consent path (#75) — and can never replay an un-held verb. The
    // `!hasAdminScope` guard above already keeps admin scopes off this path
    // (they fall through to consent), so the cap is a no-op here for the
    // common case, but it still runs unconditionally for defense in depth.
    return issueAuthCodeRedirect(db, parsed, requestedScopes, session.userId, deps);
  }

  return htmlResponse(
    renderConsent(
      consentProps(client, parsed, vaultNames, csrf.token, assignedVaults, userIsAdmin),
    ),
    200,
    extra,
  );
}

/**
 * Anti-privilege-escalation cap (THE security crux of the single-consent
 * change, 2026-05-29). A user may only delegate authority they themselves
 * hold: the OAuth consent that authorizes a client must never grant a named
 * vault verb the consenting user doesn't actually hold on that vault.
 *
 * For each scope shaped `vault:<name>:<verb>` (verb ∈ VAULT_VERBS) when the
 * user is NOT the hub owner, the verb is admitted only if it appears in
 * `vaultVerbsForUserVault(db, userId, name)` (the verbs the user holds on
 * that vault, derived from their `user_vaults` role). Otherwise the scope is
 * DROPPED. Non-vault scopes and unnamed `vault:<verb>` (which never reach
 * mint without picker-narrowing) pass through untouched.
 *
 * The owner (`isFirstAdmin`) bypasses the cap entirely — they hold admin on
 * every vault by construction (admin posture is the unrestricted sentinel;
 * see `vaultScopeForUser`). Owner=isFirstAdmin is the Phase-1 definition of
 * "holds admin everywhere"; revisit when multi-admin lands.
 *
 * Security argument (documented at the call site too):
 *   - The authority source of truth today is `isFirstAdmin` for owner-wide
 *     authority and `user_vaults.role` (via `vaultVerbsForRole`) for assigned
 *     users.
 *   - `vaultVerbsForRole` provably never returns `admin` for an assigned user
 *     (it maps write→[read,write], read→[read], unknown→[]), so this helper
 *     drops `vault:<name>:admin` for every non-owner BY CONSTRUCTION — without
 *     hardcoding "drop admin". It reads the held verb set and admits only
 *     held verbs, so it's forward-compatible: if a future role ever granted
 *     admin, the cap would admit it automatically.
 *   - Applied inside `issueAuthCodeRedirect` (the single choke-point ALL mint
 *     paths funnel through: consent-submit, skip-consent, and same-hub
 *     auto-trust), the CAPPED set is what gets both recorded (`recordGrant`)
 *     and minted (`issueAuthCode`). No mint path can bypass it, and a later
 *     skip-consent flow can never replay an un-held admin verb because it was
 *     never recorded.
 */
function capScopesToUserAuthority(
  db: Database,
  userId: string,
  scopes: readonly string[],
  opts: { userIsAdmin: boolean },
): string[] {
  if (opts.userIsAdmin) return [...scopes];
  return scopes.filter((s) => {
    const parts = s.split(":");
    if (parts.length !== 3 || parts[0] !== "vault") return true; // non-named — pass through
    const name = parts[1];
    const verb = parts[2];
    if (name === undefined || verb === undefined || !VAULT_VERBS.has(verb)) return true;
    // Named vault verb requested by a non-owner: admit only if the user holds
    // it. `vaultVerbsForUserVault` returns null for an unassigned vault (drop)
    // or the held verb list (today read/write only — never admin).
    const held = vaultVerbsForUserVault(db, userId, name);
    return held !== null && (held as readonly string[]).includes(verb);
  });
}

/**
 * Mint an auth code and redirect to the client's redirect_uri. The SINGLE
 * mint choke-point — shared by the consent-submit path (`handleConsentSubmit`),
 * the skip-consent path (#75), and the same-hub auto-trust path (hub#312) in
 * `handleAuthorizeGet`. Caller is responsible for having already validated the
 * client + redirect_uri and for having narrowed unnamed `vault:<verb>` scopes
 * to their named form (so the cap below sees final shapes).
 *
 * This is the single choke-point for two responsibilities, so NO mint path can
 * bypass them:
 *   1. Anti-privilege-escalation cap (`capScopesToUserAuthority`): a non-owner
 *      can only delegate vault verbs they hold; un-held verbs (notably admin)
 *      are dropped. An admin-only request from a non-owner caps to EMPTY → we
 *      refuse with `invalid_scope` rather than mint a zero-scope token. EVERY
 *      auth code is minted through here, so the cap runs before every mint —
 *      even when a stale `grants` row already lists an un-held admin verb (the
 *      cap, not the grant lookup, is what blocks the mint).
 *   2. Grant recording (`recordGrant`) with the CAPPED scopes for THIS mint —
 *      so a later skip-consent flow re-entering with the same (user, client)
 *      can never replay an un-held verb. UNION semantics make this idempotent.
 *
 * Not the ONLY `recordGrant` call in this module, though: two other guarded
 * fast-path records exist — the trust-by-client_name auto-promote in
 * `pendingClientResponse` (~L585) and the auto-approve carry-over in
 * `handleAuthorizeGet` (~L895). Both are gated by `!some(scopeIsAdmin)`, so
 * neither can ever record an admin verb, and any mint they unlock still flows
 * back through this function's cap. So the invariant "no minted token, and no
 * grant row, ever carries an un-held admin verb" holds across all paths.
 */
function issueAuthCodeRedirect(
  db: Database,
  params: AuthorizeFormParams,
  scopes: string[],
  userId: string,
  deps: OAuthDeps,
): Response {
  // Anti-privesc cap at the single choke-point. Runs AFTER any narrowing the
  // callers did (unnamed `vault:admin` → `vault:<picked>:admin`), so it sees
  // the final named shapes. Owner (isFirstAdmin) bypasses — holds admin
  // everywhere by construction.
  const userIsAdmin = isFirstAdmin(db, userId);
  const cappedScopes = capScopesToUserAuthority(db, userId, scopes, { userIsAdmin });

  // Drop-not-refuse UX, with one hard floor: if capping leaves an EMPTY set
  // (e.g. a non-owner requested ONLY `vault:<name>:admin`, which they don't
  // hold), never mint a zero-scope token — refuse with a clear invalid_scope.
  // A request that started empty (no scopes at all) is a separate, legitimate
  // "session token only" case the consent UI supports, so we only refuse when
  // the cap itself removed every scope.
  if (cappedScopes.length === 0 && scopes.length > 0) {
    return oauthErrorRedirect(
      params.redirectUri,
      "invalid_scope",
      "You can grant only the access you hold on this vault; an admin grant requires hub-owner authority.",
      params.state,
    );
  }

  // Record the grant with the CAPPED scopes (single source of truth) so
  // skip-consent re-entry can never widen back to an un-held verb.
  recordGrant(db, userId, params.clientId, cappedScopes, deps.now?.() ?? new Date());

  const code = issueAuthCode(db, {
    clientId: params.clientId,
    userId,
    redirectUri: params.redirectUri,
    scopes: cappedScopes,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    now: deps.now,
  });
  const u = new URL(params.redirectUri);
  u.searchParams.set("code", code.code);
  if (params.state) u.searchParams.set("state", params.state);
  return redirectResponse(u.toString());
}

/**
 * POST /oauth/authorize — handles two distinct submissions:
 *   - login form: `__action=login` with username + password. On success,
 *     create a session, set the cookie, redirect back to GET /oauth/authorize
 *     so the user lands on the consent screen.
 *   - consent submission: `__action=consent` with `approve=yes|no`. On
 *     approve, mint an auth code and redirect to the client's redirect_uri.
 *     On deny, redirect with `error=access_denied`.
 */
export async function handleAuthorizePost(
  db: Database,
  req: Request,
  deps: OAuthDeps,
): Promise<Response> {
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    // Same response shape for missing-cookie, missing-form-field, and mismatch
    // — we don't want to leak which side failed. The browser can recover by
    // GETting /oauth/authorize again, which mints a fresh cookie + token.
    return htmlError(
      "Invalid form submission",
      "The form's CSRF token did not match. Reload the page and try again.",
      400,
    );
  }
  // Token is already verified above; reuse the form value for re-rendering
  // any error views so the next submit keeps the same cookie/form pairing.
  const csrfToken = typeof formCsrf === "string" ? formCsrf : "";
  const action = String(form.get("__action") ?? "");
  if (action === "login") return await handleLoginSubmit(db, req, form, deps, csrfToken);
  if (action === "consent") return await handleConsentSubmit(db, req, form, deps, csrfToken);
  return htmlError("Invalid form submission", "Unknown form action.", 400);
}

async function handleLoginSubmit(
  db: Database,
  req: Request,
  form: Awaited<ReturnType<Request["formData"]>>,
  _deps: OAuthDeps,
  csrfToken: string,
): Promise<Response> {
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const params = paramsFromForm(form);
  if (!username || !password) {
    return htmlResponse(
      renderLogin({ params, csrfToken, errorMessage: "Username and password are required." }),
      400,
    );
  }
  const user = getUserByUsername(db, username);
  if (!user) {
    return htmlResponse(
      renderLogin({ params, csrfToken, errorMessage: "Invalid credentials." }),
      401,
    );
  }
  const ok = await verifyPassword(user, password);
  if (!ok) {
    return htmlResponse(
      renderLogin({ params, csrfToken, errorMessage: "Invalid credentials." }),
      401,
    );
  }

  // Where to land after a successful sign-in: back at GET /oauth/authorize
  // with the original query string so the user resumes the OAuth flow on the
  // consent screen with full params re-validated.
  const authorizeReturnUrl = buildAuthorizeReturnUrl(params);

  // 2FA gate (hub#473 — security fix). The OAuth login POST is the MORE-common
  // sign-in path (every OAuth client: vault, notes-ui, `parachute auth login`).
  // It must enforce the second factor exactly like `/login` does: after the
  // password verifies, if the user has TOTP enrolled, do NOT mint a session.
  // Stash a pending-login whose `next` is the FULL /oauth/authorize return URL
  // (so the post-TOTP redirect resumes the OAuth flow), and render the TOTP
  // challenge. The challenge form posts to `/login/2fa` — the shared
  // completion path (`handleAdminLoginTotpPost`) — which verifies the factor,
  // mints the session, and 302s to the stored `next`. The pending-login cookie
  // is scoped `Path=/login`, so it rides the `/login/2fa` POST. Without this
  // gate a 2FA-enrolled user could obtain a full session with password ONLY.
  if (isTotpEnrolled(db, user.id)) {
    const pendingToken = createPendingLogin(user.id, authorizeReturnUrl);
    return htmlResponse(renderTotpChallenge({ next: authorizeReturnUrl, csrfToken }), 200, {
      "set-cookie": buildPendingLoginCookie(pendingToken, req),
    });
  }

  const session = createSession(db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000), {
    secure: isHttpsRequest(req),
  });
  return redirectResponse(authorizeReturnUrl, { "set-cookie": cookie });
}

/**
 * Build the `/oauth/authorize?...` return URL (path + query, same-origin) that
 * a successful sign-in redirects back to so the OAuth flow resumes on the
 * consent screen. Shared by the password-only path and the post-TOTP path
 * (the latter via the pending-login's `next`).
 */
function buildAuthorizeReturnUrl(params: AuthorizeFormParams): string {
  const u = new URL("/oauth/authorize", "http://placeholder");
  for (const [k, v] of Object.entries(authorizeParamsToQuery(params))) {
    u.searchParams.set(k, v);
  }
  return `${u.pathname}${u.search}`;
}

async function handleConsentSubmit(
  db: Database,
  req: Request,
  form: Awaited<ReturnType<Request["formData"]>>,
  deps: OAuthDeps,
  csrfToken: string,
): Promise<Response> {
  const params = paramsFromForm(form);
  // RFC 8707 resource binding — defense-in-depth (mirror of the GET handler).
  // The consent form's hidden inputs already carry the narrowed named scopes
  // (the GET handler rewrote `parsed.scope` before rendering), but a hand-
  // crafted POST could re-supply an unnamed `vault:read` alongside the
  // `resource` field. Re-narrow here so the minted token is always named +
  // correctly-audienced regardless of what the form body claims. Same
  // semantics as the GET path: only when `resource` resolves to one of our
  // per-vault MCP resources; no-op otherwise (manual-pick path unchanged).
  const boundVault = resolveResourceVault(params.resource, resolveBoundOrigins(deps));
  if (boundVault) {
    params.scope = narrowResourceVaultScopes(
      params.scope.split(" ").filter((s) => s.length > 0),
      boundVault,
    ).join(" ");
  }
  const approve = String(form.get("approve") ?? "") === "yes";
  const sessionId = parseSessionCookie(req.headers.get("cookie"));
  const session = sessionId ? findSession(db, sessionId) : null;
  if (!session) {
    // Session expired between login and consent submit. Send back to login.
    return htmlResponse(
      renderLogin({
        params,
        csrfToken,
        errorMessage: "Your session expired — please sign in again.",
      }),
      401,
    );
  }
  const client = getClient(db, params.clientId);
  if (!client) {
    // Same shape as the GET handler — see the comment there. Reaching
    // this branch on the consent POST means the client_id was deleted
    // between render and submit (vanishingly rare) or the form was
    // hand-crafted; the recovery affordance is still the right answer
    // for both cases.
    return unknownClientResponse(params.clientId, params.redirectUri, deps);
  }
  if (client.status !== "approved") {
    // Defensive: consent only renders for approved clients, so a non-approved
    // status here means the row was unapproved between render and submit (or
    // the form was hand-crafted). The approve UI requires a known authorize
    // URL to round-trip via `return_to`, which we don't reconstruct here —
    // surface the static error pointing at the web approval path (the
    // canonical recovery post-#277; rc.19 retired the CLI mention from
    // every browser-visible surface so the path advertised here matches
    // what the unauth GET-on-pending page now shows).
    return htmlError(
      "App not yet approved",
      `This client_id is registered but has not been approved. Sign in as admin and approve at /admin/approve-client/${client.clientId}, or send the link to your hub operator.`,
      403,
    );
  }
  try {
    requireRegisteredRedirectUri(client, params.redirectUri);
  } catch {
    return htmlError(
      "Redirect mismatch",
      "The redirect_uri does not match any URI registered for this app.",
      400,
    );
  }
  if (!approve) {
    return oauthErrorRedirect(
      params.redirectUri,
      "access_denied",
      "user denied the authorization request",
      params.state,
    );
  }
  let scopes = params.scope.split(" ").filter((s) => s.length > 0);
  // Defense-in-depth (#96). The GET handler already rejects non-requestable
  // scopes before consent renders, but a hand-crafted POST could carry one
  // anyway — block it here too.
  const blockedHere = findNonRequestableScopes(scopes);
  if (blockedHere.length > 0) {
    return oauthErrorRedirect(
      params.redirectUri,
      "invalid_scope",
      `requested scopes are not available via the public authorization endpoint: ${blockedHere.join(", ")}`,
      params.state,
    );
  }
  // Multi-user Phase 2 PR 2: non-admin users are pinned to a list of one
  // or more vaults via `user_vaults`. The consent screen renders the
  // picker narrowed to that list and any named scopes (`vault:<name>:
  // <verb>`) requested by the client must target a vault in the list.
  // The server-side defense here refuses any mint where the user's
  // submission disagrees, so a hand-crafted POST or a misbehaving SPA
  // can't bypass the narrowing. First admin (admin posture) keeps the
  // existing picker-as-source-of-truth behavior (empty `assignedVaults`).
  const userIsAdmin = isFirstAdmin(db, session.userId);
  const sessionUser = getUserById(db, session.userId);
  const assignedVaults: string[] = userIsAdmin ? [] : (sessionUser?.assignedVaults ?? []);
  const isPinned = assignedVaults.length > 0;
  // By design: the resource-bound re-narrow above does NOT check the bound
  // vault exists in services.json for the admin path — admin (isPinned=false)
  // can already consent to any vault via the manual picker, so the asymmetry
  // (named-scope mint against a possibly-missing vault) is deliberate, not an
  // oversight. Non-admins still hit the assignment + stale-vault defenses below.

  // Zero-vault non-admin gate (Phase 2 PR 2 reviewer fold). A non-admin
  // user with no `user_vaults` rows is a known-but-not-yet-assigned
  // posture — they can sign in to /account/, change their password, and
  // see the home page, but they have no vaults to authorize against.
  // Block any vault-scoped consent at the submit boundary so an OAuth
  // client can't trick them into minting a token: an empty `vault_scope`
  // claim is the admin "unrestricted" sentinel (see `vaultScopeForUser`),
  // and we must keep that sentinel reserved for true admins. Non-vault
  // scopes (`scribe:transcribe`, etc.) still consent normally — only
  // `vault:...` scopes are gated here. The defense pairs with the GET-
  // path same-hub-auto-trust gate below (which falls through to the
  // consent render that would otherwise show the picker).
  if (!userIsAdmin && assignedVaults.length === 0) {
    const submittedScopes = params.scope.split(" ").filter((s) => s.length > 0);
    const hasVaultScope = submittedScopes.some((s) => {
      if (s === "vault:read" || s === "vault:write" || s === "vault:admin") return true;
      const parts = s.split(":");
      return parts.length === 3 && parts[0] === "vault" && parts[2] && VAULT_VERBS.has(parts[2]);
    });
    if (hasVaultScope) {
      return htmlError(
        "No vaults assigned",
        "vault_scope_mismatch: you have no assigned vaults on this hub yet, so you can't authorize an app for vault access. Ask the hub admin to assign you at least one vault via /admin/users, then try again.",
        400,
      );
    }
  }

  // Vault picker (Q1 of the vault-config-and-scopes design): an unnamed
  // `vault:<verb>` scope is ambiguous about which vault it grants access to.
  // Force the operator to pick before the JWT is minted, then rewrite the
  // unnamed scope to `vault:<picked>:<verb>` so vault's strict per-resource
  // enforcement (Phase 1) sees a name it can match against the URL.
  const unnamedVerbs = unnamedVaultVerbs(scopes);
  if (unnamedVerbs.length > 0) {
    const pickedVault = String(form.get("vault_pick") ?? "").trim();
    if (!pickedVault) {
      return htmlError(
        "Pick a vault",
        "This app requested vault access without naming a vault. Pick which vault to grant access to and try again.",
        400,
      );
    }
    const manifest = (deps.loadServicesManifest ?? readServicesManifest)();
    const validNames = listVaultNames(manifest);
    if (!validNames.includes(pickedVault)) {
      // Stale-assignment branch (hub#284, generalized Phase 2 PR 2). The
      // user is consenting via an assignment that points at a vault no
      // longer in services.json. The new copy names the actual condition
      // (assignment removed) and points at the admin remediation surface.
      //
      // The check fires when the picked vault is in the user's assigned
      // list — narrows the special-case to the "user is consenting via
      // a now-stale assignment" shape rather than swallowing every
      // Unknown-vault. A hand-crafted POST naming a never-existed vault
      // still hits the generic branch.
      if (isPinned && assignedVaults.includes(pickedVault)) {
        return htmlError(
          "Assigned vault was removed",
          `Your assigned vault "${pickedVault}" is no longer registered on this hub. Ask the hub admin to reassign you to an existing vault via /admin/users, then try again.`,
          400,
        );
      }
      return htmlError(
        "Unknown vault",
        `vault "${pickedVault}" is not registered on this host.`,
        400,
      );
    }
    // Server-side defense: non-admin user submitted a vault that's not in
    // their assigned list. The picker rendered as narrowed, so a UI-path
    // user couldn't reach this — but a hand-crafted form bypassing the
    // narrowed input lands here. Refuse the mint instead of silently
    // overwriting; the explicit error tells the operator the assignment
    // is load-bearing.
    if (isPinned && !assignedVaults.includes(pickedVault)) {
      return htmlError(
        "Vault assignment mismatch",
        `vault_scope_mismatch: the picked vault "${pickedVault}" is not in your vault assignment. Ask the hub admin to update your assignment, or pick a vault shown on the consent screen.`,
        400,
      );
    }
    scopes = narrowVaultScopes(scopes, pickedVault);
  }

  // Server-side defense for named-vault scopes (`vault:<name>:<verb>`) too.
  // A non-admin user can't request scope against any vault outside their
  // assignment list — same invariant as the picker check above, applied
  // to scopes that arrived already-named (e.g. a client that knows the
  // user's vault and asked for `vault:bob:read` directly). Admin posture
  // (`isPinned === false`) skips this check.
  if (isPinned) {
    const mismatched: string[] = [];
    for (const s of scopes) {
      const parts = s.split(":");
      if (
        parts.length === 3 &&
        parts[0] === "vault" &&
        parts[1] &&
        parts[2] &&
        VAULT_VERBS.has(parts[2]) &&
        !assignedVaults.includes(parts[1])
      ) {
        mismatched.push(s);
      }
    }
    if (mismatched.length > 0) {
      return htmlError(
        "Vault assignment mismatch",
        `vault_scope_mismatch: requested scopes ${mismatched.join(", ")} target a vault outside your assignment.`,
        400,
      );
    }

    // Stale-assignment defense (hub#284, generalized Phase 2 PR 2). A
    // named scope shaped `vault:<assigned>:<verb>` passes the mismatch
    // check above but points at a vault that no longer exists in
    // services.json. Minting a token here would silently issue scope
    // against a vault the resource server can't find — the user thinks
    // consent succeeded but the subsequent API calls fail with no
    // actionable signal. Refuse the mint and surface the same admin-
    // remediation hint the GET path's banner uses.
    const namedStaleScopes: string[] = [];
    for (const s of scopes) {
      const parts = s.split(":");
      if (
        parts.length === 3 &&
        parts[0] === "vault" &&
        parts[1] !== undefined &&
        parts[2] &&
        VAULT_VERBS.has(parts[2]) &&
        assignedVaults.includes(parts[1])
      ) {
        namedStaleScopes.push(s);
      }
    }
    if (namedStaleScopes.length > 0) {
      // Only consult the manifest when there's something to check — keeps
      // the no-vault-scope hot path off-disk for the common admin flows.
      const manifest = (deps.loadServicesManifest ?? readServicesManifest)();
      const validNames = listVaultNames(manifest);
      // Collect the stale vault names embedded in the named scopes.
      const staleNames = new Set<string>();
      for (const s of namedStaleScopes) {
        const parts = s.split(":");
        if (parts[1] !== undefined && !validNames.includes(parts[1])) {
          staleNames.add(parts[1]);
        }
      }
      if (staleNames.size > 0) {
        const exemplar = [...staleNames][0];
        return htmlError(
          "Assigned vault was removed",
          `Your assigned vault "${exemplar}" is no longer registered on this hub. Ask the hub admin to reassign you to an existing vault via /admin/users, then try again.`,
          400,
        );
      }
    }
  }

  // The grant is recorded (or extended) INSIDE issueAuthCodeRedirect with the
  // CAPPED scopes — the single mint choke-point owns both the anti-privesc cap
  // and the recordGrant so no path can record an un-held verb. UNION semantics
  // there mean a subset re-flow still matches a prior grant, and an admin-only
  // request from a non-owner caps to empty → refused (no zero-scope token).
  // (#75 skip-consent depends on this recording.)
  return issueAuthCodeRedirect(db, params, scopes, session.userId, deps);
}

/**
 * POST /oauth/authorize/approve — operator-driven inline approval of a
 * pending DCR client (closes #208). The cross-origin SPA case the
 * same-origin DCR auto-approve (#199, #200) doesn't cover: an SPA on a
 * different origin can't ride the cookie path during DCR, so its
 * freshly-registered client_id lands `pending` and the operator hits
 * "App not yet approved" on /oauth/authorize. This endpoint flips that
 * client to `approved` in one click and redirects back into the OAuth flow.
 *
 * Three-belt security model. All three must pass:
 *
 *   1. Valid CSRF token (double-submit cookie). Defends against a malicious
 *      cross-origin POST that rides the session cookie's SameSite=Lax.
 *      Token was minted at GET render time and embedded in the form.
 *   2. Active operator session (`findActiveSession`). The operator must be
 *      logged into this hub from the browser submitting the form — no
 *      session means no operator authority to approve anything.
 *   3. Origin/Referer matches a hub-bound origin (`isSameOriginRequest`).
 *      Same shape as the DCR auto-approve gate (#199, #200, #245): a same-
 *      origin POST proves the form was rendered by *this hub*, not a forged
 *      page. Bound origins include issuer + loopback + tailnet hostname
 *      (#245); pre-#245 was issuer-only and rejected legitimate operator
 *      paths from loopback / tailnet.
 *
 * `return_to` validation: the form embeds the original authorize URL so
 * the post-approve redirect lands the operator back on `/oauth/authorize`
 * with the now-approved client. We refuse anything that doesn't start with
 * `/oauth/authorize?` — open-redirect defense, plus a hand-crafted form
 * trying to use this endpoint as a generic redirect-after-approve gadget
 * shouldn't succeed at smuggling an off-path target.
 */
export async function handleApproveClientPost(
  db: Database,
  req: Request,
  deps: OAuthDeps,
): Promise<Response> {
  const form = await req.formData();
  const formCsrf = form.get(CSRF_FIELD_NAME);
  if (!verifyCsrfToken(req, typeof formCsrf === "string" ? formCsrf : null)) {
    return htmlError(
      "Invalid form submission",
      "The form's CSRF token did not match. Reload the page and try again.",
      403,
    );
  }
  const session = findActiveSession(db, req, deps.now ?? (() => new Date()));
  if (!session) {
    return htmlError(
      "Sign in required",
      "You must be signed in to this hub to approve an app. Sign in and try again.",
      401,
    );
  }
  const bound = resolveBoundOrigins(deps);
  if (!isSameOriginRequest(req, bound)) {
    // Diagnostic: log the headers we saw + the bound set so an operator
    // chasing a rejection on a real deploy can see exactly what didn't
    // match. The same-origin check is the most opaque CSRF gate — without
    // this log, a misconfigured hub_settings.hub_origin or a proxy
    // stripping Origin/Referer produces a flat 403 with no way to debug.
    // Headers logged are non-sensitive (Origin/Referer/Host are public);
    // the bound set is hub's own configuration. Body content not logged.
    console.warn(
      `[oauth] approve POST same-origin check failed. headers: ` +
        `origin=${JSON.stringify(req.headers.get("origin"))} ` +
        `referer=${JSON.stringify(req.headers.get("referer"))} ` +
        `host=${JSON.stringify(req.headers.get("host"))} ` +
        `xff-host=${JSON.stringify(req.headers.get("x-forwarded-host"))} ` +
        `xff-proto=${JSON.stringify(req.headers.get("x-forwarded-proto"))}. ` +
        `bound origins: ${JSON.stringify(bound)}`,
    );
    return htmlError(
      "Cross-origin request rejected",
      "The approve form must be submitted from this hub's own origin.",
      403,
    );
  }
  const clientId = String(form.get("client_id") ?? "");
  if (!clientId) {
    return htmlError("Invalid form submission", "Missing client_id.", 400);
  }
  const client = getClient(db, clientId);
  if (!client) {
    return htmlError("Unknown application", "This client_id is not registered with this hub.", 404);
  }

  // Deny branch (hub#390): RFC 6749 §4.1.2.1 — when the resource owner
  // denies an access request, the AS bounces back to the client's
  // redirect_uri with `error=access_denied` (+ original state). Validate
  // redirect_uri against the client's registered URIs to prevent open
  // redirect via a hand-crafted form; refuse with 400 if it doesn't match.
  // Deny does NOT mutate the client row — the client stays `pending` and
  // the operator can revisit later from /admin/permissions or re-trigger
  // OAuth from the calling app.
  //
  // The decision default is `"approve"` — that covers both back-compat
  // (older forms that don't carry the field at all) AND any unexpected
  // value (e.g. `decision="garbage"`). The reasoning: only the literal
  // string `"deny"` triggers the destructive-from-the-client's-perspective
  // path; everything else is treated as the safe, prior behavior. A user
  // can't accidentally land on the error redirect by clicking a malformed
  // button.
  const decision = String(form.get("decision") ?? "approve");
  if (decision === "deny") {
    const denyRedirectUri = String(form.get("redirect_uri") ?? "");
    if (!denyRedirectUri || !client.redirectUris.includes(denyRedirectUri)) {
      return htmlError(
        "Invalid form submission",
        "The redirect_uri does not match any URI registered for this app.",
        400,
      );
    }
    const stateRaw = form.get("state");
    const denyState = typeof stateRaw === "string" && stateRaw.length > 0 ? stateRaw : undefined;
    // `new URL()` could in principle throw if a legacy code path bypassed
    // `isValidRedirectUri` at registration and wrote a non-http(s) URI.
    // Current DCR enforces validity at write time, so this catch is
    // belt-and-suspenders, but cost is near-zero.
    let target: URL;
    try {
      target = new URL(denyRedirectUri);
    } catch {
      return htmlError(
        "Invalid form submission",
        "The registered redirect_uri for this app is not a valid URL.",
        400,
      );
    }
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "The user denied the authorization request.");
    if (denyState !== undefined) target.searchParams.set("state", denyState);
    return redirectResponse(target.toString());
  }

  // Approve branch (default — also the back-compat path for any form that
  // doesn't carry an explicit `decision` field). Validate return_to BEFORE
  // the DB mutation: if an authenticated operator submits a hand-crafted
  // form with a bad return_to, we refuse without committing the client to
  // `approved`. Practical risk is low (all three belts already passed),
  // but ordering matters — validate, then mutate.
  const returnTo = String(form.get("return_to") ?? "");
  if (!isSafeAuthorizeReturnTo(returnTo)) {
    return htmlError(
      "Invalid form submission",
      "The return_to value is not a hub-relative /oauth/authorize URL.",
      400,
    );
  }
  approveClient(db, clientId);
  return redirectResponse(returnTo);
}

/**
 * Validate a form-submitted `return_to` value. Must be a hub-relative URL
 * (no scheme, no double-slash) targeting `/oauth/authorize` with a query
 * string — anything else is either an open-redirect attempt or a misuse of
 * the endpoint. Empty string is rejected (the form always supplies one).
 *
 * Exported so the SPA approve-client endpoint (`handleApproveClient` in
 * admin-clients.ts) can apply the same gate when echoing a `return_to` back
 * to the caller — workstream D. Single helper = single shape of "what's a
 * valid OAuth-resume target?" for the whole hub.
 */
export function isSafeAuthorizeReturnTo(value: string): boolean {
  if (!value) return false;
  // Reject scheme-relative ("//evil.example/foo") and absolute URLs. Only
  // single-slash root-relative paths are allowed.
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  // Must target the authorize endpoint with a query string. The OAuth flow
  // re-enters via GET /oauth/authorize?<original-params>; anything off-path
  // is a misuse.
  return value.startsWith("/oauth/authorize?");
}

function paramsFromForm(form: Awaited<ReturnType<Request["formData"]>>): AuthorizeFormParams {
  return {
    clientId: String(form.get("client_id") ?? ""),
    redirectUri: String(form.get("redirect_uri") ?? ""),
    responseType: String(form.get("response_type") ?? "code"),
    scope: String(form.get("scope") ?? ""),
    codeChallenge: String(form.get("code_challenge") ?? ""),
    codeChallengeMethod: String(form.get("code_challenge_method") ?? "S256"),
    state: (form.get("state") as string | null) ?? null,
    resource: (form.get("resource") as string | null) ?? null,
  };
}

function authorizeParamsToQuery(p: AuthorizeFormParams): Record<string, string> {
  const q: Record<string, string> = {
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: p.responseType,
    scope: p.scope,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
  };
  if (p.state) q.state = p.state;
  // Round-trip the RFC 8707 resource indicator through the login redirect so
  // the resource-bound narrowing survives a sign-in (it re-enters GET
  // /oauth/authorize with the original params).
  if (p.resource) q.resource = p.resource;
  return q;
}

// --- /oauth/token ----------------------------------------------------------

/**
 * Extract a presented client_secret from either the `Authorization: Basic`
 * header (RFC 6749 §2.3.1 preferred) or the form-body `client_secret`. If
 * both are present, the header wins — the spec says clients SHOULD use one
 * mechanism per request; when they don't, picking deterministically (header
 * = the more-secure form, harder to log accidentally than a body field)
 * keeps the auth gate predictable.
 *
 * Returns `{ clientId, clientSecret }` so callers can cross-check the body's
 * `client_id` against the header's. RFC §2.3.1 doesn't explicitly require
 * matching, but a mismatch is a client bug we shouldn't paper over.
 *
 * Returns null secret when no credential was presented at all.
 */
function extractClientCredentials(
  req: Request,
  form: Awaited<ReturnType<Request["formData"]>>,
): { headerClientId: string | null; clientSecret: string | null } {
  const auth = req.headers.get("authorization");
  // RFC 7235 §2.1 — auth-scheme is case-insensitive ("Basic" / "basic" / "BASIC").
  if (auth && /^basic\s+/i.test(auth)) {
    try {
      const decoded = atob(auth.replace(/^basic\s+/i, "").trim());
      const colon = decoded.indexOf(":");
      if (colon >= 0) {
        // RFC 6749 §2.3.1 mandates form-encoding the basic-auth values
        // (because client_id may legitimately contain `:`). Decode them
        // back so a client that registered the spec-correct way works.
        const headerClientId = decodeURIComponent(decoded.slice(0, colon));
        const clientSecret = decodeURIComponent(decoded.slice(colon + 1));
        return { headerClientId, clientSecret };
      }
    } catch {
      // Malformed base64 → treat as no header credential, fall through to
      // form body. The auth gate will reject if the client is confidential
      // and didn't also send a body secret.
    }
  }
  const bodySecret = form.get("client_secret");
  return {
    headerClientId: null,
    clientSecret: typeof bodySecret === "string" && bodySecret.length > 0 ? bodySecret : null,
  };
}

/**
 * 401 response shape for token-endpoint client-auth failures. WWW-Authenticate
 * declares Basic per RFC 6749 §5.2 + RFC 7235 — it tells a compliant client
 * "this endpoint accepts Basic auth" so it can retry with credentials.
 */
function clientAuthFailure(description: string): Response {
  return jsonResponse({ error: "invalid_client", error_description: description }, 401, {
    "www-authenticate": 'Basic realm="hub"',
  });
}

/**
 * Gate the per-grant handlers behind RFC 6749 §3.2.1 client authentication.
 * Public clients (clientSecretHash == null) pass through unchanged — PKCE
 * already binds their auth-code redemption. Confidential clients must
 * present a matching client_secret via Basic header or form body.
 *
 * Returns null on success; a 401 Response on failure for the caller to
 * return directly.
 */
function authenticateClient(
  client: OAuthClient,
  req: Request,
  form: Awaited<ReturnType<Request["formData"]>>,
  bodyClientId: string,
): Response | null {
  if (!client.clientSecretHash) return null; // public client: no secret required
  const { headerClientId, clientSecret } = extractClientCredentials(req, form);
  if (!clientSecret) {
    return clientAuthFailure("client_secret required for confidential client");
  }
  // If the Basic header was used, its client_id must match the body's —
  // RFC 6749 §3.2.1 says the auth identifies the client; a body claiming
  // a different client_id is a bug or an attempt to confuse the gate.
  if (headerClientId !== null && headerClientId !== bodyClientId) {
    return clientAuthFailure("authorization header client_id does not match request body");
  }
  if (!verifyClientSecret(client, clientSecret)) {
    return clientAuthFailure("client_secret mismatch");
  }
  return null;
}

/**
 * POST /oauth/token — supports `authorization_code` + `refresh_token`.
 * Confidential clients (registered with a client_secret) must authenticate
 * via the Authorization: Basic header or a form-body `client_secret` per
 * RFC 6749 §2.3.1; public clients (PKCE-only) need no client_secret because
 * PKCE already binds the redemption. Errors return the RFC 6749 §5.2 shape:
 * 400/401 + `{error, error_description}`.
 */
export async function handleToken(db: Database, req: Request, deps: OAuthDeps): Promise<Response> {
  const form = await req.formData();
  const grantType = String(form.get("grant_type") ?? "");
  if (grantType === "authorization_code")
    return await handleTokenAuthorizationCode(db, req, form, deps);
  if (grantType === "refresh_token") return await handleTokenRefresh(db, req, form, deps);
  return jsonResponse(
    {
      error: "unsupported_grant_type",
      error_description: `grant_type "${grantType}" is not supported`,
    },
    400,
  );
}

async function handleTokenAuthorizationCode(
  db: Database,
  req: Request,
  form: Awaited<ReturnType<Request["formData"]>>,
  deps: OAuthDeps,
): Promise<Response> {
  const code = String(form.get("code") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const codeVerifier = String(form.get("code_verifier") ?? "");
  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return jsonResponse(
      { error: "invalid_request", error_description: "missing required parameter" },
      400,
    );
  }
  const client = getClient(db, clientId);
  if (!client) {
    return jsonResponse({ error: "invalid_client", error_description: "unknown client_id" }, 401);
  }
  if (client.status !== "approved") return pendingClientJson(client.clientId, deps.issuer);
  const authFailure = authenticateClient(client, req, form, clientId);
  if (authFailure) return authFailure;
  let redeemed: ReturnType<typeof redeemAuthCode>;
  try {
    redeemed = redeemAuthCode(db, { code, clientId, redirectUri, codeVerifier, now: deps.now });
  } catch (err) {
    return mapAuthCodeError(err);
  }
  // Scope-validation gate (cli#71). Reject any requested scope that the
  // issuer never declared — `FIRST_PARTY_SCOPES` ∪ each module's `module.json`
  // `scopes.defines`. Per RFC 6749 §5.2: `error: "invalid_scope"`. We add
  // `invalid_scopes: [...]` as an extension field so clients can report the
  // exact culprits without re-parsing the description string.
  const declared = (deps.loadDeclaredScopes ?? loadDeclaredScopes)();
  const unknown = findUnknownScopes(redeemed.scopes, declared);
  if (unknown.length > 0) {
    return jsonResponse(
      {
        error: "invalid_scope",
        error_description: `unknown scopes: ${unknown.join(", ")}`,
        invalid_scopes: unknown,
      },
      400,
    );
  }
  const audience = inferAudience(redeemed.scopes);
  const access = await signAccessToken(db, {
    sub: redeemed.userId,
    scopes: redeemed.scopes,
    audience,
    clientId: redeemed.clientId,
    issuer: deps.issuer,
    // vault_scope claim — Phase 2 per-user vault pin (Phase 1 had a single
    // `assigned_vault` column; Phase 2 PR 2 generalized to `assigned_vaults`
    // via `user_vaults`). Non-empty list for non-admin users with at least
    // one assigned vault; empty for first-admin (unrestricted sentinel).
    // Zero-vault non-admin is also empty by `vaultScopeForUser`, but the
    // OAuth flow refuses to mint a vault-scoped token for them upstream
    // (see the zero-vault gate in `handleConsentSubmit` + the same-hub
    // auto-trust posture check), so we never reach here with that user
    // posture. The narrowing in `handleConsentSubmit` already rewrote
    // `vault:<verb>` → `vault:<assigned>:<verb>`, so the auth code's
    // scopes are pre-aligned; this claim is the explicit "owned vaults"
    // signal PR 5 consumes downstream.
    vaultScope: vaultScopeForUser(db, redeemed.userId),
    now: deps.now,
  });
  // Phase 1 (#212) registry exemption: code-grant access tokens piggyback
  // on the paired refresh token's `tokens` row (they share `jti` by
  // design). We don't write a separate access-token row — revocation acts
  // on the shared jti / family, and the 15-min access TTL bounds the
  // window before per-jti re-validation is needed. A separate per-jti
  // access-token row would double registry write volume on every OAuth
  // grant + every refresh rotation; not worth the trade today.
  const refresh = signRefreshToken(db, {
    jti: access.jti,
    userId: redeemed.userId,
    clientId: redeemed.clientId,
    scopes: redeemed.scopes,
    now: deps.now,
  });
  const services = buildServicesCatalog(
    (deps.loadServicesManifest ?? readServicesManifest)(),
    deps.issuer,
    redeemed.scopes,
  );
  return jsonResponse({
    access_token: access.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: redeemed.scopes.join(" "),
    services,
  });
}

async function handleTokenRefresh(
  db: Database,
  req: Request,
  form: Awaited<ReturnType<Request["formData"]>>,
  deps: OAuthDeps,
): Promise<Response> {
  const refreshToken = String(form.get("refresh_token") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  if (!refreshToken || !clientId) {
    return jsonResponse(
      { error: "invalid_request", error_description: "missing required parameter" },
      400,
    );
  }
  const client = getClient(db, clientId);
  if (!client) {
    return jsonResponse({ error: "invalid_client", error_description: "unknown client_id" }, 401);
  }
  if (client.status !== "approved") return pendingClientJson(client.clientId, deps.issuer);
  const authFailure = authenticateClient(client, req, form, clientId);
  if (authFailure) return authFailure;
  const row = findRefreshToken(db, refreshToken);
  if (!row) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "refresh_token not found" },
      400,
    );
  }
  if (row.clientId !== clientId) {
    return jsonResponse({ error: "invalid_grant", error_description: "client_id mismatch" }, 400);
  }
  // Refresh-token rows always have a non-null user_id (the caller's hub
  // user). Post-v6 the column is nullable to accommodate non-OAuth mints
  // (operator/cli mints), but those rows have no `refresh_token_hash` so
  // `findRefreshToken` can't return them. Defensive: surface a clean
  // invalid_grant if a hand-crafted row shows up here without a user.
  if (!row.userId) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "refresh_token has no associated user" },
      400,
    );
  }
  const refreshUserId: string = row.userId;
  const now = deps.now?.() ?? new Date();
  if (row.revokedAt) {
    // Replay of an already-rotated refresh token. Per RFC 6819 §5.2.2.3 the
    // working assumption is theft — the legitimate client received a new
    // refresh token at the prior rotation, so anyone presenting the old one
    // either lost a race (rare) or stole it (the case we must defend
    // against). Either way: revoke every descendant in the family so the
    // attacker can't keep refreshing, and force the legitimate client to
    // re-authorize. Cheaper than tracking which call was first.
    revokeFamily(db, row.familyId, now);
    return jsonResponse(
      { error: "invalid_grant", error_description: "refresh_token revoked" },
      400,
    );
  }
  if (now.getTime() > new Date(row.expiresAt).getTime()) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "refresh_token expired" },
      400,
    );
  }
  // Rotate: revoke the old refresh row, mint a new access + refresh pair
  // bound to the same family so a future replay of *any* descendant can
  // walk the chain.
  //
  // Mint the access token *before* opening the rotation transaction. JWT
  // signing is async (jose returns a Promise) and bun:sqlite's
  // `db.transaction()` is sync — running async work inside the closure
  // would silently break atomicity. Once we have the JWT, the UPDATE
  // (revoke old) + INSERT (mint new refresh row) commit or roll back as
  // a unit, so a mid-rotation crash can't dead-old-without-replacement
  // (#107).
  const audience = inferAudience(row.scopes);
  const access = await signAccessToken(db, {
    sub: refreshUserId,
    scopes: row.scopes,
    audience,
    clientId: row.clientId,
    issuer: deps.issuer,
    // vault_scope claim — re-derived from the user's *current*
    // `assigned_vaults` at refresh time (not snapshotted onto the refresh-
    // token row). An admin who changes a user's vault assignments between
    // mint and refresh sees the new value on the next refresh; existing
    // access tokens carry their original claim until their 15-minute TTL
    // elapses. Same posture as the design's "OAuth issuer reads
    // `assigned_vaults` at mint time, not at session-creation time" pin.
    vaultScope: vaultScopeForUser(db, refreshUserId),
    now: deps.now,
  });
  let refresh: ReturnType<typeof signRefreshToken>;
  try {
    refresh = db.transaction(() => {
      db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ?").run(now.toISOString(), row.jti);
      return signRefreshToken(db, {
        jti: access.jti,
        userId: refreshUserId,
        clientId: row.clientId,
        scopes: row.scopes,
        familyId: row.familyId,
        now: deps.now,
      });
    })();
  } catch (err) {
    // Concurrent rotation: a sibling refresh of the same row already
    // committed and ours collides on the `tokens.jti` PRIMARY KEY (or any
    // other INSERT-time DB error). Surface a clean `invalid_grant` 400 —
    // RFC 6749 §5.2 — instead of letting the SQLite error bubble as a 500
    // (#108). The transaction is already rolled back at this point, so
    // the row's revoked_at is unchanged for the losing request.
    if (err instanceof RefreshTokenInsertError) {
      return jsonResponse(
        { error: "invalid_grant", error_description: "refresh_token rotation conflict" },
        400,
      );
    }
    throw err;
  }
  const services = buildServicesCatalog(
    (deps.loadServicesManifest ?? readServicesManifest)(),
    deps.issuer,
    row.scopes,
  );
  return jsonResponse({
    access_token: access.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh.token,
    scope: row.scopes.join(" "),
    services,
  });
}

// --- /oauth/revoke ---------------------------------------------------------

/**
 * POST /oauth/revoke — RFC 7009 token revocation.
 *
 * Accepts `token` + optional `token_type_hint` (`refresh_token` or
 * `access_token`) form-encoded. Authenticates the client (confidential
 * clients via `client_secret`; public clients pass through with PKCE-style
 * client_id-only auth, same gate as the token endpoint).
 *
 * Lookup strategy: try the refresh-token-hash first when the hint is
 * `refresh_token` or absent (the common case — clients usually revoke
 * refresh tokens), then fall back to JWT decode + jti lookup for access
 * tokens. JWT decode here is unverified-decode of the payload only; we
 * just need the jti to find the row. A signature check would be
 * ceremonial — if the row exists we own it; if it doesn't, we return 200
 * anyway per spec.
 *
 * Response: 200 with empty body on success OR when the token is unknown
 * (RFC 7009 §2.2 — "the authorization server responds with HTTP status
 * code 200 [...] or if the client submitted an invalid token"). We
 * intentionally don't surface "found vs not-found" so a caller probing
 * with random strings can't enumerate live tokens.
 *
 * Closes #73.
 */
export async function handleRevoke(
  db: Database,
  req: Request,
  _deps: OAuthDeps,
): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") ?? "");
  const hint = String(form.get("token_type_hint") ?? "");
  const bodyClientId = String(form.get("client_id") ?? "");
  if (!token || !bodyClientId) {
    return jsonResponse(
      { error: "invalid_request", error_description: "missing required parameter" },
      400,
    );
  }
  const client = getClient(db, bodyClientId);
  if (!client) {
    return jsonResponse({ error: "invalid_client", error_description: "unknown client_id" }, 401);
  }
  const authFailure = authenticateClient(client, req, form, bodyClientId);
  if (authFailure) return authFailure;

  // Lookup. Hint is advisory per RFC 7009 §2.1 — clients that get it wrong
  // still expect revocation to succeed, so we always try both shapes.
  const now = new Date();
  let row = hint === "access_token" ? null : findRefreshToken(db, token);
  if (!row) {
    const jti = unverifiedJtiOf(token);
    if (jti) row = findTokenRowByJti(db, jti);
    if (!row && hint === "access_token" && !row) {
      // hint said access_token but the JWT didn't decode; check
      // refresh-token shape as a last resort.
      row = findRefreshToken(db, token);
    }
  }
  if (row && row.clientId !== client.clientId) {
    // RFC 7009 §2.1: revocation must be authenticated to the same client
    // the token was issued to. A different client presenting a valid
    // token is invalid_grant; we collapse it to 200 to avoid existence
    // disclosure to unrelated clients.
    return new Response(null, { status: 200 });
  }
  if (row && !row.revokedAt) {
    db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ?").run(now.toISOString(), row.jti);
  }
  return new Response(null, { status: 200 });
}

/**
 * Best-effort jti extraction for revocation lookup. Not signature-checked —
 * we only need the claim to find a row. If the row doesn't exist or the
 * client doesn't own it, the caller bails out anyway.
 */
function unverifiedJtiOf(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      jti?: unknown;
    };
    return typeof json.jti === "string" ? json.jti : null;
  } catch {
    return null;
  }
}

function mapAuthCodeError(err: unknown): Response {
  if (err instanceof AuthCodeNotFoundError) {
    return jsonResponse({ error: "invalid_grant", error_description: "code not found" }, 400);
  }
  if (err instanceof AuthCodeExpiredError) {
    return jsonResponse({ error: "invalid_grant", error_description: "code expired" }, 400);
  }
  if (err instanceof AuthCodeUsedError) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "code already redeemed" },
      400,
    );
  }
  if (err instanceof AuthCodePkceMismatchError) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "code_verifier mismatch" },
      400,
    );
  }
  if (err instanceof AuthCodeRedirectMismatchError) {
    return jsonResponse(
      { error: "invalid_grant", error_description: "redirect_uri mismatch" },
      400,
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: "server_error", error_description: msg }, 500);
}

// --- /oauth/register -------------------------------------------------------

interface RegisterRequestBody {
  redirect_uris?: string[];
  scope?: string;
  client_name?: string;
  token_endpoint_auth_method?: string;
}

/**
 * Resolve the hub-bound origin set for a given `OAuthDeps`. Pre-#245 this
 * was implicit (just `deps.issuer`); post-#245 callers can thread a richer
 * set through `deps.hubBoundOrigins` so loopback + tailnet + funnel access
 * all match. Fallback to `[issuer]` keeps callers that haven't migrated
 * correct on single-origin hubs.
 */
function resolveBoundOrigins(deps: OAuthDeps): readonly string[] {
  if (deps.hubBoundOrigins) return deps.hubBoundOrigins();
  return [deps.issuer];
}

/**
 * POST /oauth/register — RFC 7591 Dynamic Client Registration.
 *
 * Approval gate (closes #74). New rows land as `pending` by default and
 * cannot participate in OAuth flows until an operator runs
 * `parachute auth approve-client <id>`. Two bypass paths:
 *
 * 1. **Operator-bearer** (#74). `Authorization: Bearer <operator-token>` whose
 *    token carries the `hub:admin` scope — the install-time path used by
 *    first-party modules so `parachute install vault` can self-register
 *    without a human follow-up.
 * 2. **Operator-session** (#199). A valid `parachute_hub_session` cookie
 *    plus a same-origin `Origin`/`Referer` header. The browser path: an
 *    operator hitting their own SPA from their own browser is by definition
 *    operator-authenticated, so re-requiring approval is friction without
 *    benefit. CSRF defense is `isSameOriginRequest` + the cookie's
 *    `SameSite=Lax` attribute.
 *
 * If a bearer is presented but invalid or insufficient, we reject with the
 * RFC 6750 shape rather than silently downgrading to the public path: a
 * caller who tried to authenticate but failed wants to know why, not get
 * `pending` back and wonder why their module can't OAuth.
 *
 * Access-control matrix (status):
 *   no auth                       → pending
 *   bearer (hub:admin)            → approved (#74)
 *   bearer (other scope)          → 403 insufficient_scope
 *   bearer (malformed)            → 401 invalid_token
 *   session cookie + same-origin  → approved (#199)
 *   session cookie + cross-origin → pending (CSRF defense)
 *   session cookie + no Origin/Referer → pending
 *   expired/unknown session       → pending
 *
 * Same-hub marker (closes hub#312). Orthogonal to status — the marker
 * records "was this client registered BY this hub's operator". Wired here:
 *
 *   bearer (hub:admin)            → same_hub=true
 *   session cookie + same-origin  → same_hub=true
 *   first-client wizard window    → same_hub=false (auto-approved, but the
 *                                   registrant is external — wizard window
 *                                   approves, doesn't claim ownership)
 *   anything else                 → same_hub=false
 *
 * The same_hub marker drives the consent-screen auto-trust path at
 * `/oauth/authorize` for non-admin scopes (parachute-app design §6).
 */
export async function handleRegister(
  db: Database,
  req: Request,
  deps: OAuthDeps,
): Promise<Response> {
  let body: RegisterRequestBody;
  try {
    body = (await req.json()) as RegisterRequestBody;
  } catch {
    return jsonResponse(
      { error: "invalid_client_metadata", error_description: "body must be JSON" },
      400,
    );
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    return jsonResponse(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required and must be non-empty",
      },
      400,
    );
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isValidRedirectUri(uri)) {
      return jsonResponse(
        { error: "invalid_redirect_uri", error_description: `invalid redirect_uri "${uri}"` },
        400,
      );
    }
  }
  // Operator-bearer auto-approve. No header → public DCR path (status=pending).
  // Header present → must validate as a hub:admin operator token; any failure
  // is surfaced (don't silently fall through to pending).
  //
  // Both operator-authenticated paths (bearer + session-cookie) also mark
  // same_hub=true so the consent-screen gate at /oauth/authorize can auto-
  // trust the client for non-admin scopes (hub#312).
  let status: ClientStatus = "pending";
  let sameHub = false;
  if (req.headers.get("authorization")) {
    try {
      await requireScope(db, req, "hub:admin", deps.issuer);
      status = "approved";
      sameHub = true;
    } catch (err) {
      if (err instanceof AdminAuthError) return adminAuthErrorResponse(err);
      throw err;
    }
  }
  // Operator-session auto-approve (closes #199). The browser path:
  // operator-authenticated SPA on the hub's own origin can self-register a
  // client without dropping to a terminal. Two gates: (1) a live (un-expired)
  // session row keyed by the cookie, (2) Origin/Referer matches the issuer
  // origin so a cross-site forgery can't ride the cookie. Quietly stays
  // `pending` on any failure — unlike the bearer path, we don't surface an
  // error, because absence of session/origin is the *normal* unauthenticated
  // public-DCR shape.
  if (status === "pending") {
    const session = findActiveSession(db, req, deps.now ?? (() => new Date()));
    if (session && isSameOriginRequest(req, resolveBoundOrigins(deps))) {
      status = "approved";
      sameHub = true;
    }
  }
  // First-client auto-approve window (hub#268 Item 3). The wizard's expose
  // step opens a 60-minute window where the very next registration is
  // auto-approved. Single-use — the consume call clears the row on
  // success, so client #2 falls through to the standard pending-approval
  // flow. Logged so an operator chasing odd behavior can see it fired
  // and which client got the free pass.
  //
  // Wizard-window approval does NOT set same_hub=true. The window says
  // "approve the next external client" — the registrant is still external
  // (a browser, a third-party app, an install script). Approval ≠
  // ownership; the operator deliberately ran the wizard but didn't
  // register-as-themselves the way the bearer/session paths do.
  let autoApprovedByWizardWindow = false;
  if (status === "pending") {
    if (consumeFirstClientAutoApproveWindow(db, deps.now ?? (() => new Date()))) {
      status = "approved";
      autoApprovedByWizardWindow = true;
    }
  }
  const confidential = body.token_endpoint_auth_method === "client_secret_post";
  const scopes = (body.scope ?? "").split(" ").filter((s) => s.length > 0);
  let registered: RegisteredClient;
  try {
    registered = registerClient(db, {
      redirectUris,
      scopes,
      clientName: body.client_name,
      confidential,
      status,
      sameHub,
      now: deps.now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: "invalid_client_metadata", error_description: msg }, 400);
  }
  if (autoApprovedByWizardWindow) {
    console.log(
      `[oauth] auto-approved first client clientId=${registered.client.clientId} within wizard window (hub#268 Item 3)`,
    );
  }
  if (sameHub) {
    console.log(
      `[oauth] same-hub DCR registration clientId=${registered.client.clientId} (hub#312)`,
    );
  }
  const respBody: Record<string, unknown> = {
    client_id: registered.client.clientId,
    redirect_uris: registered.client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
    client_id_issued_at: Math.floor(new Date(registered.client.registeredAt).getTime() / 1000),
    status: registered.client.status,
    same_hub: registered.client.sameHub,
  };
  if (registered.client.scopes.length > 0) respBody.scope = registered.client.scopes.join(" ");
  if (registered.client.clientName) respBody.client_name = registered.client.clientName;
  if (registered.clientSecret) respBody.client_secret = registered.clientSecret;
  return jsonResponse(respBody, 201);
}

function consentProps(
  client: OAuthClient,
  params: AuthorizeFormParams,
  vaultNames: string[],
  csrfToken: string,
  assignedVaults: readonly string[],
  userIsAdmin: boolean,
) {
  const scopes = params.scope.split(" ").filter((s) => s.length > 0);
  const unnamedVerbs = unnamedVaultVerbs(scopes);
  // Multi-user Phase 2 PR 2 stale-assignment branch (hub#284 generalized
  // from one vault to N). A non-admin user whose entire vault list has
  // been removed from services.json — admin removed / renamed the vaults
  // without reassigning. The banner surfaces this state with an admin-
  // remediation hint instead of silently minting against a missing vault.
  //
  // The user-facing surface is "your assigned vault(s) were removed" —
  // the banner names the first stale vault as the canonical example. The
  // exact list is unimportant for the recovery path (operator goes to
  // /admin/users either way), and pluralizing the banner copy doesn't
  // change the action.
  //
  // Security posture: we deliberately do NOT relax the picked-must-be-in-
  // assigned-list check. Stale-assignment is admin-remediated.
  const remainingValidAssigned = assignedVaults.filter((v) => vaultNames.includes(v));
  const hasStaleAssignment = assignedVaults.length > 0 && remainingValidAssigned.length === 0;
  const staleAssignedVault =
    hasStaleAssignment && assignedVaults[0] !== undefined ? assignedVaults[0] : undefined;
  // A named scope like `vault:<old>:<verb>` requested by the client where
  // <old> is one of the user's stale vaults. The server-side named-scope
  // defense allows this through because the scope matches an assigned
  // vault, but the token it mints would point at a vault that no longer
  // exists. Gate Approve on this case too so the user doesn't burn a
  // consent into a token that fails at the resource server.
  const hasNamedStaleVaultScope =
    hasStaleAssignment &&
    scopes.some((s) => {
      const parts = s.split(":");
      if (
        parts.length !== 3 ||
        parts[0] !== "vault" ||
        parts[1] === undefined ||
        parts[2] === undefined ||
        !VAULT_VERBS.has(parts[2])
      ) {
        return false;
      }
      // Named for one of the user's vaults — and given hasStaleAssignment,
      // none of the user's vaults exist on this hub, so this scope points
      // at a stale name.
      return assignedVaults.includes(parts[1]);
    });

  // Multi-user Phase 2 PR 2: non-admin users see the picker narrowed to
  // their assigned vault list. Four shapes emerge:
  //
  //   - Single assigned vault (still valid) → render locked to that name
  //     (same shape as Phase 1).
  //   - Two-or-more assigned vaults → render a dropdown filtered to the
  //     user's list. Same control as the admin dropdown but narrowed.
  //   - Stale-assigned (all vaults gone) → render no-vaults-available so
  //     the form gracefully rejects an Approve click instead of silently
  //     submitting a missing name.
  //   - First admin (admin posture, empty `assignedVaults`) → full hub-
  //     wide dropdown of every vault on the hub.
  //   - Zero-vault non-admin (Phase 2 PR 2 reviewer fold) → no-vaults-
  //     available so the form gracefully rejects an Approve click. The
  //     prior shape rendered the full hub-wide list for non-admins with
  //     zero assignments, which let them pick a vault they had no
  //     business consenting to. The consent-submit gate refuses any
  //     vault-scoped POST from a zero-vault non-admin (defense in depth);
  //     this branch keeps the picker UI honest.
  let vaultPicker: VaultPickerProps | undefined;
  if (unnamedVerbs.length > 0) {
    if (hasStaleAssignment) {
      vaultPicker = { unnamedVerbs, availableVaults: [] };
    } else if (remainingValidAssigned.length === 1) {
      const only = remainingValidAssigned[0];
      if (only !== undefined) {
        vaultPicker = { unnamedVerbs, availableVaults: [only], lockedVault: only };
      }
    } else if (remainingValidAssigned.length > 1) {
      vaultPicker = { unnamedVerbs, availableVaults: remainingValidAssigned };
    } else if (userIsAdmin) {
      // Admin posture (no assignments) → full hub-wide list.
      vaultPicker = { unnamedVerbs, availableVaults: vaultNames };
    } else {
      // Zero-vault non-admin → no-vaults-available picker with the
      // "ask your admin to assign you" copy. The Approve button renders
      // disabled (same shape as the empty-services-json case) so the
      // form can't post a hand-picked name. The consent-submit gate
      // refuses any vault-scoped POST from this user too (defense in
      // depth — see `handleConsentSubmit`).
      vaultPicker = { unnamedVerbs, availableVaults: [], emptyReason: "no-assignments" };
    }
  }
  // Named-scope display: substitute unnamed `vault:<verb>` rows with the
  // resolved form the operator will actually consent to.
  //   - Non-admin with exactly one valid assigned vault → render that name.
  //   - Stale-assigned → null; the row carries the `<TBD>` placeholder.
  //     The banner explains why a name isn't bound.
  //   - Non-admin with multiple assigned vaults → null sentinel (the user
  //     hasn't picked yet).
  //   - Admin with exactly one vault available → render that name.
  //   - Admin with multiple / no vaults → null sentinel.
  let displayVault: string | null = null;
  if (!hasStaleAssignment && remainingValidAssigned.length === 1) {
    const only = remainingValidAssigned[0];
    if (only !== undefined) displayVault = only;
  } else if (
    !hasStaleAssignment &&
    assignedVaults.length === 0 &&
    unnamedVerbs.length > 0 &&
    vaultNames.length === 1
  ) {
    // Admin with a single vault on the hub: pre-check pattern from Phase 1.
    const only = vaultNames[0];
    if (only) displayVault = only;
  }
  return {
    params,
    clientId: client.clientId,
    clientName: client.clientName ?? client.clientId,
    scopes,
    csrfToken,
    vaultPicker,
    displayVault,
    staleAssignedVault,
    // Approve stays enabled for non-vault scopes even when assigned_vault
    // is stale — the user can still consent to e.g. `scribe:transcribe`
    // without a working vault. Disable only when the requested scope
    // depends on a vault (unnamed verb that needs the picker, or a named
    // verb against the stale assignment).
    blockApproveForStaleAssignment:
      staleAssignedVault !== undefined && (unnamedVerbs.length > 0 || hasNamedStaleVaultScope),
  };
}

interface VaultPickerProps {
  unnamedVerbs: string[];
  availableVaults: string[];
  lockedVault?: string;
  emptyReason?: "no-assignments" | "no-vaults-on-hub";
}
