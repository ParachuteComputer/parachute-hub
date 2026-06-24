/**
 * Hub-as-OAuth-CLIENT engine (Phase 4b-2, agent-connectors design 2026-06-18).
 *
 * A Parachute hub is a spec-compliant OAuth *issuer* (RFC 8414 / 9728 / 7591,
 * PKCE S256, authorization_code + refresh_token). 4b-2 makes THIS hub act as a
 * *client* of ANOTHER hub's issuer (or any RFC-compliant MCP issuer): discover →
 * dynamic-client-register → build an authorize URL the operator's browser
 * follows → exchange the returned code → refresh / revoke headlessly.
 *
 * Every function takes an injected `fetchFn` so the engine is fully unit-testable
 * offline (the tests mock all network). The default is the global `fetch`.
 *
 * Security: the PKCE verifier + every token are SECRETS — this module never logs
 * them. Callers persist them only to the 0600 flow / grant stores.
 */
import { createHash, randomBytes } from "node:crypto";

/** A typed error for any OAuth-client failure (discovery, DCR, token exchange). */
export class OAuthClientError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "OAuthClientError";
  }
}

export type FetchFn = typeof fetch;

/** Default outbound timeout for every OAuth-client request. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Shorter timeout for best-effort DISCOVERY probes. Discovery tries several
 * well-known candidates in priority order (path-inserted, host-root, OIDC), so a
 * full 15s per probe could stack into a long wall-clock wait on a slow/firewalled
 * remote. These metadata GETs are quick when they exist; a tight ceiling bounds
 * the worst case while still tolerating a sluggish responder.
 */
const DISCOVERY_PROBE_TIMEOUT_MS = 6_000;

/**
 * `fetch` with an AbortController timeout. The hub has no shared fetch wrapper,
 * so this lives here for all outbound OAuth-client calls — a slow/hung remote
 * issuer must not stall the approve request indefinitely.
 */
export async function fetchWithTimeout(
  url: string,
  init: (RequestInit & { timeout?: number }) | undefined = undefined,
  fetchFn: FetchFn = fetch,
): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT_MS, ...rest } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetchFn(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ===========================================================================
// PKCE
// ===========================================================================

/** Generate a PKCE code verifier — 32 random bytes, base64url. SECRET. */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** S256 challenge for a verifier (matches `auth-codes.ts:verifyPkce`). */
export function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Random single-use `state` — 32 random bytes, base64url. */
export function generateState(): string {
  return randomBytes(32).toString("base64url");
}

// ===========================================================================
// Discovery (RFC 9728 → RFC 8414)
// ===========================================================================

export interface DiscoveryResult {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
  readonly revocationEndpoint?: string;
  /** From RFC 9728 protected-resource metadata, falling back to RFC 8414. */
  readonly scopesSupported?: readonly string[];
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new OAuthClientError(`invalid mcp url: ${url}`);
  }
}

async function fetchJson(
  url: string,
  fetchFn: FetchFn,
  what: string,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      { headers: { accept: "application/json" }, ...(timeoutMs ? { timeout: timeoutMs } : {}) },
      fetchFn,
    );
  } catch (err) {
    throw new OAuthClientError(`${what}: request to ${url} failed`, err);
  }
  if (!res.ok) {
    throw new OAuthClientError(`${what}: ${url} returned ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new OAuthClientError(`${what}: ${url} returned non-JSON`, err);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthClientError(`${what}: ${url} returned a non-object body`);
  }
  return body as Record<string, unknown>;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

/**
 * RFC 9728 §3.1 / RFC 8414 §3.1 well-known URL candidates for a resource or
 * issuer URL. The spec INSERTS the well-known segment after the host while
 * PRESERVING the URL's path: `https://h/p` → `https://h/.well-known/<seg>/p`.
 * We try the path-inserted form FIRST (correct when the resource/issuer carries
 * a path — e.g. an MCP served at `/mcp`, or a multi-tenant issuer at `/tenant`),
 * then the host-root form (`https://h/.well-known/<seg>`) as a fallback for
 * path-less deployments + older servers. De-duplicated, in priority order.
 */
function wellKnownCandidates(url: string, segment: string): string[] {
  const u = new URL(url);
  // The query string is intentionally excluded (u.pathname omits it) — RFC 9728
  // §3.1 builds the well-known URL from the resource PATH only.
  const path = u.pathname.replace(/\/+$/, ""); // drop trailing slash(es)
  const root = `${u.origin}/.well-known/${segment}`;
  const out = path ? [`${u.origin}/.well-known/${segment}${path}`, root] : [root];
  return [...new Set(out)];
}

/**
 * Fetch the first candidate URL (in priority order) that returns a valid JSON
 * object. Lets discovery probe the path-inserted well-known location first, then
 * fall back to the host root. If EVERY candidate fails, throws an
 * OAuthClientError naming all tried locations (so a failure points at every
 * probe, not just the last).
 */
async function fetchJsonFirst(
  urls: string[],
  fetchFn: FetchFn,
  what: string,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return await fetchJson(url, fetchFn, what, timeoutMs);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new OAuthClientError(
    `${what}: no metadata found — tried ${urls.length} location(s): ${errors.join(" | ")}`,
  );
}

/**
 * Discover the issuer + endpoints for a remote MCP URL.
 *
 *   1. RFC 9728: GET <mcp>/.well-known/oauth-protected-resource[/<path>] →
 *      authorization_servers[0] = issuer (+ scopes_supported). The path-inserted
 *      location is tried first (the modern MCP shape: an MCP at `/mcp` advertises
 *      at `/.well-known/oauth-protected-resource/mcp`, and its auth server often
 *      lives on a SEPARATE host), then the host root.
 *   2. RFC 8414 / OIDC: GET <issuer>/.well-known/oauth-authorization-server then
 *      /.well-known/openid-configuration (each path-inserted then host-root) →
 *      authorization_endpoint, token_endpoint, registration_endpoint,
 *      revocation_endpoint (+ scopes_supported fallback).
 *
 * If the resource has no 9728 doc, falls back to treating the MCP origin itself
 * as the issuer and reading its 8414/OIDC doc directly (8414-only resources).
 */
export async function discover(mcpUrl: string, fetchFn: FetchFn = fetch): Promise<DiscoveryResult> {
  const origin = originOf(mcpUrl);

  // Step 1 — RFC 9728 protected-resource metadata (best-effort; some resources
  // only expose 8414). Probe the PATH-INSERTED location first (an MCP served at
  // `/mcp` advertises at `/.well-known/oauth-protected-resource/mcp`), then the
  // host root — this is what lets a resource whose auth server lives on a
  // SEPARATE host be discovered at all.
  let issuer: string | undefined;
  let prScopes: string[] | undefined;
  try {
    const pr = await fetchJsonFirst(
      wellKnownCandidates(mcpUrl, "oauth-protected-resource"),
      fetchFn,
      "protected-resource discovery",
      DISCOVERY_PROBE_TIMEOUT_MS,
    );
    const servers = asStringArray(pr.authorization_servers);
    issuer = servers?.[0];
    prScopes = asStringArray(pr.scopes_supported);
  } catch {
    // No 9728 doc anywhere — fall back to the MCP origin as issuer.
    issuer = undefined;
  }
  if (!issuer) issuer = origin;

  // The issuer comes from the (attacker-influenceable) PRM doc — validate it
  // parses as a URL so a malformed value surfaces as an OAuthClientError rather
  // than a raw TypeError out of the candidate construction below.
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new OAuthClientError(`authorization_servers[0] is not a valid URL: ${issuer}`);
  }

  // Step 2 — RFC 8414 / OIDC metadata on the issuer. Path-inserted before host
  // root, and `oauth-authorization-server` before `openid-configuration`, so an
  // issuer that sits at a path or only serves OIDC discovery still resolves. Plus
  // the OIDC Discovery 1.0 §4.1 APPEND form (`<issuer-with-path>/.well-known/
  // openid-configuration`) for a path-ful issuer — distinct from the 8414 INSERT.
  const asCandidates = [
    ...wellKnownCandidates(issuer, "oauth-authorization-server"),
    ...wellKnownCandidates(issuer, "openid-configuration"),
  ];
  if (issuerUrl.pathname.replace(/\/+$/, "")) {
    asCandidates.push(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  }
  const as = await fetchJsonFirst(
    [...new Set(asCandidates)],
    fetchFn,
    "authorization-server discovery",
    DISCOVERY_PROBE_TIMEOUT_MS,
  );

  const authorizationEndpoint = asString(as.authorization_endpoint);
  const tokenEndpoint = asString(as.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new OAuthClientError(
      "authorization-server metadata missing authorization_endpoint or token_endpoint",
    );
  }
  const asIssuer = asString(as.issuer) ?? issuer;
  const asScopes = asStringArray(as.scopes_supported);

  return {
    issuer: asIssuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(asString(as.registration_endpoint)
      ? { registrationEndpoint: asString(as.registration_endpoint) }
      : {}),
    ...(asString(as.revocation_endpoint)
      ? { revocationEndpoint: asString(as.revocation_endpoint) }
      : {}),
    // 9728 scopes win (they describe THIS resource); 8414 is the fallback.
    ...((prScopes ?? asScopes) ? { scopesSupported: prScopes ?? asScopes } : {}),
  };
}

// ===========================================================================
// Least-privilege scope derivation for Parachute-vault MCP URLs (#671)
// ===========================================================================

/**
 * `…/vault/<name>/mcp` — a Parachute vault MCP endpoint. Anchored: the path must
 * END at `/mcp` right after the vault name so a longer path
 * (`/vault/x/mcp/extra`) doesn't masquerade as a vault MCP. `<name>` is the
 * vault-name charset (the same conservative slug `validateVaultName` enforces —
 * a non-empty run of letters/digits/`._-`), captured group 1.
 */
const VAULT_MCP_PATH_RE = /\/vault\/([a-z0-9][a-z0-9._-]*)\/mcp\/?$/i;

/**
 * Derive the least-privilege OAuth scope to request when starting an mcp-grant
 * OAuth flow against a remote MCP URL (#671).
 *
 * The OAuth-start path historically requested the resource's ENTIRE advertised
 * `scopes_supported`. For a Parachute vault MCP that set includes broad scopes
 * (`hub:admin`, `vault:<name>:write`, …) — wildly over-privileged for an agent
 * that only needs to READ the vault. So when the target URL is a Parachute vault
 * MCP (`…/vault/<name>/mcp`), request a single least-privilege
 * `vault:<name>:read` scope instead of the full set. Write is a deliberate
 * future knob, not the default.
 *
 * For any non-vault-shaped MCP URL (or one with no parseable vault name), returns
 * `null` — the caller keeps the existing behavior (request `scopes_supported`, or
 * omit `scope` when the resource advertises none).
 */
export function deriveVaultScopeFromMcpUrl(mcpUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpUrl);
  } catch {
    return null;
  }
  const match = VAULT_MCP_PATH_RE.exec(parsed.pathname);
  const name = match?.[1];
  if (!name) return null;
  return `vault:${name}:read`;
}

// ===========================================================================
// Dynamic client registration (RFC 7591)
// ===========================================================================

export interface RegisterResult {
  readonly clientId: string;
}

/** Register THIS hub as a public OAuth client at the issuer's DCR endpoint. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchFn: FetchFn = fetch,
): Promise<RegisterResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      registrationEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_name: "Parachute Hub (agent connector)",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      },
      fetchFn,
    );
  } catch (err) {
    throw new OAuthClientError("dynamic client registration request failed", err);
  }
  if (!res.ok) {
    throw new OAuthClientError(`dynamic client registration returned ${res.status}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new OAuthClientError("dynamic client registration returned non-JSON", err);
  }
  const clientId = asString((body as Record<string, unknown>)?.client_id);
  if (!clientId) {
    throw new OAuthClientError("dynamic client registration response missing client_id");
  }
  return { clientId };
}

// ===========================================================================
// Authorize URL
// ===========================================================================

export interface BuildAuthorizeUrlOpts {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope?: string;
  readonly state: string;
  readonly codeChallenge: string;
}

/** Build the authorize URL the operator's browser follows (PKCE S256). */
export function buildAuthorizeUrl(opts: BuildAuthorizeUrlOpts): string {
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  if (opts.scope) url.searchParams.set("scope", opts.scope);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ===========================================================================
// Token exchange + refresh
// ===========================================================================

export interface TokenResult {
  readonly access_token: string;
  readonly refresh_token?: string;
  /** ISO — computed from `expires_in` at exchange time. Absent if not advertised. */
  readonly expiresAt?: string;
  readonly scope?: string;
}

async function postToken(
  tokenEndpoint: string,
  form: Record<string, string>,
  fetchFn: FetchFn,
  now: () => Date,
): Promise<TokenResult> {
  const body = new URLSearchParams(form);
  let res: Response;
  try {
    res = await fetchWithTimeout(
      tokenEndpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
      },
      fetchFn,
    );
  } catch (err) {
    throw new OAuthClientError("token request failed", err);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // fall through — handled by the !res.ok branch / missing-token branch
  }
  if (!res.ok) {
    const err = asString(parsed.error) ?? `http ${res.status}`;
    const desc = asString(parsed.error_description);
    throw new OAuthClientError(`token endpoint error: ${err}${desc ? ` (${desc})` : ""}`);
  }
  const accessToken = asString(parsed.access_token);
  if (!accessToken) {
    throw new OAuthClientError("token response missing access_token");
  }
  let expiresAt: string | undefined;
  const expiresIn = parsed.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
    expiresAt = new Date(now().getTime() + expiresIn * 1000).toISOString();
  }
  return {
    access_token: accessToken,
    ...(asString(parsed.refresh_token) ? { refresh_token: asString(parsed.refresh_token) } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(asString(parsed.scope) ? { scope: asString(parsed.scope) } : {}),
  };
}

export interface ExchangeCodeOpts {
  readonly tokenEndpoint: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  /** Test seam for the clock (expiresAt computation). */
  readonly now?: () => Date;
}

/** Exchange an authorization code for tokens (PKCE). */
export function exchangeCode(
  opts: ExchangeCodeOpts,
  fetchFn: FetchFn = fetch,
): Promise<TokenResult> {
  return postToken(
    opts.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.codeVerifier,
      client_id: opts.clientId,
    },
    fetchFn,
    opts.now ?? (() => new Date()),
  );
}

export interface RefreshTokenOpts {
  readonly tokenEndpoint: string;
  readonly refreshToken: string;
  readonly clientId: string;
  readonly now?: () => Date;
}

/** Refresh an access token. */
export function refreshToken(
  opts: RefreshTokenOpts,
  fetchFn: FetchFn = fetch,
): Promise<TokenResult> {
  return postToken(
    opts.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
    },
    fetchFn,
    opts.now ?? (() => new Date()),
  );
}

// ===========================================================================
// Revocation (RFC 7009) — best-effort
// ===========================================================================

export interface RevokeRemoteOpts {
  readonly revocationEndpoint: string;
  readonly refreshToken: string;
  readonly clientId: string;
}

/**
 * Best-effort revoke the refresh token at the issuer's revocation endpoint.
 * Swallows all errors — revocation is a courtesy; a failure must not block the
 * local teardown (the grant material is dropped regardless).
 */
export async function revokeRemote(
  opts: RevokeRemoteOpts,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  try {
    await fetchWithTimeout(
      opts.revocationEndpoint,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: opts.refreshToken,
          token_type_hint: "refresh_token",
          client_id: opts.clientId,
        }).toString(),
      },
      fetchFn,
    );
  } catch {
    // Best-effort — never throw.
  }
}

/**
 * The OAuth-client module surface, gathered as an interface so it can be injected
 * into the grants handler for testing (a fake replaces the real network calls).
 */
export interface OAuthClient {
  generateCodeVerifier(): string;
  generateCodeChallenge(verifier: string): string;
  generateState(): string;
  discover(mcpUrl: string, fetchFn?: FetchFn): Promise<DiscoveryResult>;
  registerClient(
    registrationEndpoint: string,
    redirectUri: string,
    fetchFn?: FetchFn,
  ): Promise<RegisterResult>;
  buildAuthorizeUrl(opts: BuildAuthorizeUrlOpts): string;
  exchangeCode(opts: ExchangeCodeOpts, fetchFn?: FetchFn): Promise<TokenResult>;
  refreshToken(opts: RefreshTokenOpts, fetchFn?: FetchFn): Promise<TokenResult>;
  revokeRemote(opts: RevokeRemoteOpts, fetchFn?: FetchFn): Promise<void>;
}

/** The real OAuth-client implementation (the default injected into the handler). */
export const realOAuthClient: OAuthClient = {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  discover,
  registerClient,
  buildAuthorizeUrl,
  exchangeCode,
  refreshToken,
  revokeRemote,
};
