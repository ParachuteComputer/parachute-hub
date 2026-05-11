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
import { isCoveredByGrant, recordGrant } from "./grants.ts";
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
} from "./oauth-ui.ts";
import { isNonRequestableScope, isRequestableScope } from "./scope-explanations.ts";
import { findUnknownScopes, loadDeclaredScopes } from "./scope-registry.ts";
import {
  type ServicesManifest,
  readManifest as readServicesManifest,
} from "./services-manifest.ts";
import {
  SESSION_TTL_MS,
  buildSessionCookie,
  createSession,
  findActiveSession,
  findSession,
  parseSessionCookie,
} from "./sessions.ts";
import { getUserByUsername, verifyPassword } from "./users.ts";
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

/**
 * Vault instance names registered on this host, derived from services.json.
 * Walks both manifest shapes — single-entry-multi-path (`paths: ["/vault/work",
 * "/vault/personal"]`) and per-vault entries (`parachute-vault-work`) — by
 * delegating each (name, path) pair to the canonical `vaultInstanceNameFor`
 * helper. Entries with no paths still resolve to a name via the helper's
 * manifest-suffix fallback (#143).
 */
function listVaultNames(manifest: ServicesManifest): string[] {
  const names = new Set<string>();
  for (const svc of manifest.services) {
    if (!isVaultEntry(svc)) continue;
    const paths = svc.paths.length > 0 ? svc.paths : [undefined];
    for (const path of paths) {
      names.add(vaultInstanceNameFor(svc.name, path));
    }
  }
  return Array.from(names).sort();
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
 * URL source: `entry.paths[0]` from services.json verbatim — never hardcode
 * `/vault/default`. Users who installed with `parachute install vault
 * --vault-name work` have `paths: ["/vault/work"]` in their manifest, and the
 * catalog URL must follow that. The custom-vault-name regression test in
 * oauth-handlers.test.ts pins this.
 *
 * Filtering: only services for which the token has at least one scope are
 * included. A scope `vault:read` admits the `vault` service; a token with only
 * `scribe:transcribe` gets a catalog with no vault entry. The check is on the
 * audience prefix (`<aud>:<verb>`) — same shape `inferAudience` uses.
 *
 * Multi-vault: Phase 1 collapses every vault entry under the single key
 * `vault`, first matching `parachute-vault*` row wins. Per-vault keys
 * (`services.vault.work.url` or `services["vault:work"].url`) are deferred
 * to a future design once notes ships its vault picker; multi-vault clients
 * need to probe `/.well-known/parachute.json` for the full vaults array
 * until then.
 */
export function buildServicesCatalog(
  manifest: ServicesManifest,
  issuer: string,
  scopes: readonly string[],
): ServicesCatalog {
  const audiences = new Set<string>();
  for (const s of scopes) {
    const colon = s.indexOf(":");
    if (colon > 0) audiences.add(s.slice(0, colon));
  }
  const base = issuer.replace(/\/$/, "");
  const catalog: ServicesCatalog = {};
  for (const entry of manifest.services) {
    const path = entry.paths[0] ?? "/";
    const key = isVaultEntry(entry) ? "vault" : shortName(entry.name);
    if (!audiences.has(key)) continue;
    if (catalog[key]) continue; // first vault wins; deterministic for clients
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
  };
}

/**
 * "App not yet approved" page (#74) for /oauth/authorize. When the request
 * carries a valid operator session AND a same-origin Origin/Referer, render
 * the inline approve form (#208) so one click flips the client to `approved`
 * and the OAuth flow re-enters at consent. Otherwise fall back to the
 * pre-#208 CLI-only message ("ask operator to run `parachute auth
 * approve-client <id>`").
 *
 * The session-bound approve gate mirrors the same-origin DCR auto-approve
 * gate on `/oauth/register` (#199, #200): valid session cookie + matching
 * Origin/Referer = trusted operator action. Cross-origin or session-less
 * GETs see the CLI-fallback message; the button never renders for them, so
 * the POST handler can't be tricked into approving via a hand-crafted form
 * either (CSRF token won't match).
 *
 * The form's `return_to` carries the original `/oauth/authorize?...` URL so
 * the post-approve redirect lands the operator back on the same flow with
 * the now-approved client. The POST handler validates `return_to` is a
 * hub-relative path before following it (open-redirect defense).
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
  const session = findActiveSession(db, req, deps.now ?? (() => new Date()));
  const sameOrigin = originMatchesIssuer(req, deps.issuer);
  const csrf = ensureCsrfToken(req);
  const extra: Record<string, string> = csrf.setCookie ? { "set-cookie": csrf.setCookie } : {};
  if (session && sameOrigin) {
    const returnTo = `${authorizeUrl.pathname}${authorizeUrl.search}`;
    return htmlResponse(
      renderApprovePending({
        clientName: client.clientName ?? client.clientId,
        clientId: client.clientId,
        redirectUris: client.redirectUris,
        requestedScopes,
        approveForm: { csrfToken: csrf.token, returnTo },
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
  const client = getClient(db, parsed.clientId);
  if (!client) {
    // Can't safely redirect — we don't trust the redirect_uri until we've
    // matched it against a registered client. Render an HTML error.
    return htmlError("Unknown application", "This client_id is not registered with this hub.", 400);
  }
  if (client.status !== "approved") {
    return pendingClientResponse(db, req, client, url, deps);
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

  // Skip-consent gate (#75). If the user has previously granted every
  // requested scope to this client, mint the auth code immediately. Two
  // important constraints:
  //   - Unnamed vault verbs (`vault:read`) need the picker even if a prior
  //     grant exists, because the operator's vault choice isn't recorded
  //     literally — grants store narrowed `vault:<name>:<verb>` scopes, so
  //     a fresh unnamed request never matches. Force consent to re-pick.
  //   - The grant covers `requestedScopes` exactly when every requested
  //     scope appears in the stored set. A strict superset (client wants
  //     something new) falls through to the consent screen.
  const hasUnnamedVault = unnamedVaultVerbs(requestedScopes).length > 0;
  if (!hasUnnamedVault && isCoveredByGrant(db, session.userId, client.clientId, requestedScopes)) {
    console.log(
      `consent skipped: existing grant covers requested scope client_id=${client.clientId} user_id=${session.userId} scopes=${requestedScopes.join(" ")}`,
    );
    return issueAuthCodeRedirect(db, parsed, requestedScopes, session.userId, deps);
  }

  const manifest = (deps.loadServicesManifest ?? readServicesManifest)();
  const vaultNames = listVaultNames(manifest);
  return htmlResponse(
    renderConsent(consentProps(client, parsed, vaultNames, csrf.token)),
    200,
    extra,
  );
}

/**
 * Mint an auth code and redirect to the client's redirect_uri. Shared by
 * the consent-submit path (`handleConsentSubmit`) and the skip-consent path
 * in `handleAuthorizeGet` (#75). Caller is responsible for having already
 * validated the client + redirect_uri + scopes.
 */
function issueAuthCodeRedirect(
  db: Database,
  params: AuthorizeFormParams,
  scopes: string[],
  userId: string,
  deps: OAuthDeps,
): Response {
  const code = issueAuthCode(db, {
    clientId: params.clientId,
    userId,
    redirectUri: params.redirectUri,
    scopes,
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
  _req: Request,
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
  const session = createSession(db, { userId: user.id });
  const cookie = buildSessionCookie(session.id, Math.floor(SESSION_TTL_MS / 1000));
  // Redirect back to GET /oauth/authorize with the original query string so
  // the user lands on the consent screen with full params re-validated.
  const u = new URL("/oauth/authorize", "http://placeholder");
  for (const [k, v] of Object.entries(authorizeParamsToQuery(params))) {
    u.searchParams.set(k, v);
  }
  return redirectResponse(`${u.pathname}${u.search}`, { "set-cookie": cookie });
}

async function handleConsentSubmit(
  db: Database,
  req: Request,
  form: Awaited<ReturnType<Request["formData"]>>,
  deps: OAuthDeps,
  csrfToken: string,
): Promise<Response> {
  const params = paramsFromForm(form);
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
    return htmlError("Unknown application", "This client_id is not registered with this hub.", 400);
  }
  if (client.status !== "approved") {
    // Defensive: consent only renders for approved clients, so a non-approved
    // status here means the row was unapproved between render and submit (or
    // the form was hand-crafted). The approve UI requires a known authorize
    // URL to round-trip via `return_to`, which we don't reconstruct here —
    // surface the static error and let the operator restart from the SPA.
    return htmlError(
      "App not yet approved",
      `This client_id is registered but has not been approved. Run \`parachute auth approve-client ${client.clientId}\` from a terminal, then try again.`,
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
      return htmlError(
        "Unknown vault",
        `vault "${pickedVault}" is not registered on this host.`,
        400,
      );
    }
    scopes = narrowVaultScopes(scopes, pickedVault);
  }
  // Record (or extend) the grant so the next /oauth/authorize for this
  // (user, client) with these scopes — or any subset — can skip the consent
  // screen (#75). UNION semantics: if the user previously granted [a, b, c]
  // and now grants [a, d], the row becomes [a, b, c, d]. Subset re-flows
  // still match.
  recordGrant(db, session.userId, client.clientId, scopes, deps.now?.() ?? new Date());
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
 *   3. Origin/Referer matches the issuer (`originMatchesIssuer`). Same
 *      shape as the DCR auto-approve gate (#199, #200): a same-origin POST
 *      proves the form was rendered by *this hub*, not a forged page.
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
  if (!originMatchesIssuer(req, deps.issuer)) {
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
  // Validate return_to BEFORE the DB mutation: if an authenticated operator
  // submits a hand-crafted form with a bad return_to, we refuse without
  // committing the client to `approved`. Practical risk is low (all three
  // belts already passed), but ordering matters — validate, then mutate.
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
 */
function isSafeAuthorizeReturnTo(value: string): boolean {
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
 * CSRF defense for the cookie-based DCR auto-approve path (closes #199).
 *
 * Compares the request's `Origin` (or `Referer` as fallback) against the
 * configured issuer origin. URL.origin compares scheme + host + port —
 * port-only mismatches reject. A request with neither header is treated as
 * suspicious and rejected: cookie-bearing POSTs from same-origin browsers
 * always send Origin (per Fetch standard) and almost always send Referer,
 * so a header-stripped request is more likely a curl probe or a privacy
 * extension on a third-party site than a legitimate same-origin caller.
 *
 * SameSite=Lax on the session cookie (sessions.ts:buildSessionCookie) is the
 * browser-side defense layer; this function is the server-side belt.
 */
function originMatchesIssuer(req: Request, issuer: string): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === new URL(issuer).origin;
    } catch {
      return false;
    }
  }
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === new URL(issuer).origin;
    } catch {
      return false;
    }
  }
  return false;
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
 *    benefit. CSRF defense is `originMatchesIssuer` + the cookie's
 *    `SameSite=Lax` attribute.
 *
 * If a bearer is presented but invalid or insufficient, we reject with the
 * RFC 6750 shape rather than silently downgrading to the public path: a
 * caller who tried to authenticate but failed wants to know why, not get
 * `pending` back and wonder why their module can't OAuth.
 *
 * Access-control matrix:
 *   no auth                       → pending
 *   bearer (hub:admin)            → approved (#74)
 *   bearer (other scope)          → 403 insufficient_scope
 *   bearer (malformed)            → 401 invalid_token
 *   session cookie + same-origin  → approved (#199)
 *   session cookie + cross-origin → pending (CSRF defense)
 *   session cookie + no Origin/Referer → pending
 *   expired/unknown session       → pending
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
  let status: ClientStatus = "pending";
  if (req.headers.get("authorization")) {
    try {
      await requireScope(db, req, "hub:admin", deps.issuer);
      status = "approved";
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
    if (session && originMatchesIssuer(req, deps.issuer)) {
      status = "approved";
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
      now: deps.now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: "invalid_client_metadata", error_description: msg }, 400);
  }
  const respBody: Record<string, unknown> = {
    client_id: registered.client.clientId,
    redirect_uris: registered.client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: confidential ? "client_secret_post" : "none",
    client_id_issued_at: Math.floor(new Date(registered.client.registeredAt).getTime() / 1000),
    status: registered.client.status,
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
) {
  const scopes = params.scope.split(" ").filter((s) => s.length > 0);
  const unnamedVerbs = unnamedVaultVerbs(scopes);
  return {
    params,
    clientId: client.clientId,
    clientName: client.clientName ?? client.clientId,
    scopes,
    csrfToken,
    vaultPicker:
      unnamedVerbs.length > 0 ? { unnamedVerbs, availableVaults: vaultNames } : undefined,
  };
}
