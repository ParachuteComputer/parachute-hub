/**
 * OAuth client registry. Backs the `/oauth/register` endpoint (RFC 7591
 * Dynamic Client Registration) and the client-lookup side of
 * `/oauth/authorize` and `/oauth/token`.
 *
 * Two flavors:
 *   - **Public clients** (PKCE-only): no `client_secret`. Browser-side apps
 *     register themselves with one or more `redirect_uris` and rely on PKCE
 *     for the auth-code exchange. `client_secret_hash` is NULL for these.
 *   - **Confidential clients**: server-side apps. We mint a random
 *     `client_secret` on registration, store its sha256 hash, return the
 *     plaintext exactly once. The token endpoint enforces client_secret per
 *     RFC 6749 §3.2.1 (closes #72).
 *
 * Status column (`pending` | `approved`): every row carries one. New
 * self-registrations default to `pending`; registrations that authenticate
 * with an operator token bearing `hub:admin` (the install-time path for
 * first-party modules) land as `approved`.
 *
 * Single-consent change (2026-05-29): the separate operator "approve this
 * client" gate was retired. The user's OAuth consent IS the authorization —
 * `handleAuthorizeGet` now session-gates a `pending` client: a request
 * carrying a valid session auto-approves the client (status → `approved`,
 * audit-logged) and FALLS THROUGH to the normal consent screen; a session-
 * less request still renders the unauth "App not yet approved" page whose
 * sign-in CTA round-trips back to authorize (after login the user re-enters
 * with a session → auto-approve → consent). The `status` column, the DCR
 * `pending` default, the `/oauth/token` pending rejection, and the
 * `parachute auth approve-client` / SPA approve surfaces all persist but are
 * near-vestigial — kept for defense-in-depth and back-compat. Motivation:
 * Notes/Claude DCR a fresh `client_id` per instance, so a per-client_id
 * approval gate re-prompted the operator constantly.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";

export type ClientStatus = "pending" | "approved";

export interface OAuthClient {
  clientId: string;
  /** SHA-256 hex digest of the client secret. Null for public clients. */
  clientSecretHash: string | null;
  redirectUris: string[];
  scopes: string[];
  clientName: string | null;
  registeredAt: string;
  /** Whether the client may participate in OAuth flows. See file header. */
  status: ClientStatus;
  /**
   * True when the DCR registrant authenticated as the operator of this hub
   * (bearer `hub:admin` OR session-cookie + same-origin). The
   * `/oauth/authorize` consent gate auto-approves same-hub clients for
   * non-admin scopes — the operator who registered the client is the
   * implicit consent. External DCR clients (unauthenticated, or auto-
   * approved via the wizard window) land `sameHub: false` and require
   * explicit consent regardless of scope (closes hub#312, parachute-app
   * design §6).
   */
  sameHub: boolean;
}

export class ClientNotFoundError extends Error {
  constructor(clientId: string) {
    super(`oauth client "${clientId}" is not registered`);
    this.name = "ClientNotFoundError";
  }
}

export class InvalidRedirectUriError extends Error {
  constructor(uri: string) {
    super(`redirect_uri "${uri}" is not registered for this client`);
    this.name = "InvalidRedirectUriError";
  }
}

interface Row {
  client_id: string;
  client_secret_hash: string | null;
  redirect_uris: string;
  scopes: string;
  client_name: string | null;
  registered_at: string;
  status: string;
  same_hub: number;
}

function rowToClient(r: Row): OAuthClient {
  return {
    clientId: r.client_id,
    clientSecretHash: r.client_secret_hash,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
    scopes: r.scopes.split(" ").filter((s) => s.length > 0),
    clientName: r.client_name,
    registeredAt: r.registered_at,
    status: r.status === "approved" ? "approved" : "pending",
    sameHub: r.same_hub === 1,
  };
}

export interface RegisterClientOpts {
  redirectUris: string[];
  scopes?: string[];
  clientName?: string;
  /** Defaults to public (PKCE-only). Set to true for a server-side client. */
  confidential?: boolean;
  /** Override the generated client_id. Mostly for tests + first-party seeds. */
  clientId?: string;
  /**
   * Approval status to write. Defaults to `approved` — direct callers
   * (tests, install-time first-party seeds) want a row that can OAuth.
   * The public DCR endpoint (`POST /oauth/register`) passes `pending`
   * explicitly so self-served registrations require operator approval
   * before they can run an OAuth flow (closes #74).
   */
  status?: ClientStatus;
  /**
   * True when the registrant is the operator of this hub (bearer hub:admin
   * OR session-cookie + same-origin POST). Drives the consent-screen
   * auto-approve for non-admin scopes (closes hub#312). Defaults to false
   * — direct callers (tests, install-time seeds) opt in explicitly.
   */
  sameHub?: boolean;
  now?: () => Date;
}

export interface RegisteredClient {
  client: OAuthClient;
  /** Plaintext secret for confidential clients. NOT recoverable from the DB. */
  clientSecret: string | null;
}

export function registerClient(db: Database, opts: RegisterClientOpts): RegisteredClient {
  if (opts.redirectUris.length === 0) {
    throw new Error("registerClient: at least one redirect_uri is required");
  }
  for (const uri of opts.redirectUris) {
    if (!isValidRedirectUri(uri)) {
      throw new Error(`registerClient: invalid redirect_uri "${uri}"`);
    }
  }
  const clientId = opts.clientId ?? randomUUID();
  const clientSecret = opts.confidential ? randomBytes(32).toString("base64url") : null;
  const clientSecretHash = clientSecret
    ? createHash("sha256").update(clientSecret).digest("hex")
    : null;
  const registeredAt = (opts.now?.() ?? new Date()).toISOString();
  const scopes = (opts.scopes ?? []).join(" ");
  const status: ClientStatus = opts.status ?? "approved";
  const sameHub = opts.sameHub ?? false;
  db.prepare(
    `INSERT INTO clients
     (client_id, client_secret_hash, redirect_uris, scopes, client_name, registered_at, status, same_hub)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    clientId,
    clientSecretHash,
    JSON.stringify(opts.redirectUris),
    scopes,
    opts.clientName ?? null,
    registeredAt,
    status,
    sameHub ? 1 : 0,
  );
  return {
    client: {
      clientId,
      clientSecretHash,
      redirectUris: opts.redirectUris,
      scopes: opts.scopes ?? [],
      clientName: opts.clientName ?? null,
      registeredAt,
      status,
      sameHub,
    },
    clientSecret,
  };
}

/**
 * Promote a `pending` client to `approved`. Idempotent — calling on an
 * already-approved row is a no-op. Returns true when the row was found and
 * is now approved (whether by this call or already), false when no such
 * client exists. Used by `parachute auth approve-client`.
 */
export function approveClient(db: Database, clientId: string): boolean {
  const existing = getClient(db, clientId);
  if (!existing) return false;
  if (existing.status === "approved") return true;
  db.prepare("UPDATE clients SET status = 'approved' WHERE client_id = ?").run(clientId);
  return true;
}

/** List clients filtered by status. Used by `parachute auth pending-clients`. */
export function listClientsByStatus(db: Database, status: ClientStatus): OAuthClient[] {
  const rows = db
    .query<Row, [string]>("SELECT * FROM clients WHERE status = ? ORDER BY registered_at")
    .all(status);
  return rows.map(rowToClient);
}

export function getClient(db: Database, clientId: string): OAuthClient | null {
  const row = db.query<Row, [string]>("SELECT * FROM clients WHERE client_id = ?").get(clientId);
  return row ? rowToClient(row) : null;
}

/**
 * Returns the registered redirect URI matching `candidate` exactly, or throws.
 * RFC 8252 + 6749 require exact-match for redirect URIs (no wildcards, no
 * loose comparison) — anything looser is an open-redirect waiting to happen.
 */
export function requireRegisteredRedirectUri(client: OAuthClient, candidate: string): string {
  if (!client.redirectUris.includes(candidate)) {
    throw new InvalidRedirectUriError(candidate);
  }
  return candidate;
}

export function verifyClientSecret(client: OAuthClient, presented: string): boolean {
  if (!client.clientSecretHash) return false;
  const presentedHash = createHash("sha256").update(presented).digest("hex");
  return timingSafeEqualHex(client.clientSecretHash, presentedHash);
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Light validation — refuses obviously-wrong shapes (relative paths, javascript:
 * URIs). Doesn't try to match a registered URI; that's `requireRegisteredRedirectUri`.
 */
export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "javascript:" || u.protocol === "data:") return false;
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
