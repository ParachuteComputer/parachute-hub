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
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, fetchFn);
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
 * Discover the issuer + endpoints for a remote MCP URL.
 *
 *   1. RFC 9728: GET <mcp-origin>/.well-known/oauth-protected-resource →
 *      authorization_servers[0] = issuer (+ scopes_supported).
 *   2. RFC 8414: GET <issuer>/.well-known/oauth-authorization-server →
 *      authorization_endpoint, token_endpoint, registration_endpoint,
 *      revocation_endpoint (+ scopes_supported fallback).
 *
 * If the resource has no 9728 doc, falls back to treating the MCP origin itself
 * as the issuer and reading its 8414 doc directly (8414-only resources).
 */
export async function discover(mcpUrl: string, fetchFn: FetchFn = fetch): Promise<DiscoveryResult> {
  const origin = originOf(mcpUrl);

  // Step 1 — RFC 9728 (best-effort; some resources only expose 8414).
  let issuer: string | undefined;
  let prScopes: string[] | undefined;
  try {
    const pr = await fetchJson(
      `${origin}/.well-known/oauth-protected-resource`,
      fetchFn,
      "protected-resource discovery",
    );
    const servers = asStringArray(pr.authorization_servers);
    issuer = servers?.[0];
    prScopes = asStringArray(pr.scopes_supported);
  } catch {
    // No 9728 doc — fall back to the MCP origin as issuer.
    issuer = undefined;
  }
  if (!issuer) issuer = origin;

  // Step 2 — RFC 8414 on the issuer.
  const as = await fetchJson(
    `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
    fetchFn,
    "authorization-server discovery",
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
