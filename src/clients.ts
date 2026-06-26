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

/**
 * Cross-hub-origin redirect_uri expansion for hub-served DCR clients
 * (surface#118; the "hub assist" half of the fix).
 *
 * THE PROBLEM. A hub-served module (surface-host, notes) registers its OAuth
 * client at install time, when the only origin it knows is the loopback hub
 * URL (`http://127.0.0.1:1939`). Once the operator runs `parachute expose`,
 * the browser loads the surface from the PUBLIC hub origin and the
 * surface-client runtime computes its `redirect_uri` from `window.location.
 * origin` (the public one) — which was never registered. Authorize-time
 * matching is deliberately strict exact-match (`requireRegisteredRedirectUri`,
 * RFC 8252 anti-open-redirect), so the public-origin redirect_uri is rejected
 * ("Redirect mismatch") and no off-localhost user can sign in.
 *
 * THE FIX. At DCR time, for each submitted redirect_uri WHOSE ORIGIN IS ONE
 * OF THE HUB'S OWN KNOWN ORIGINS (issuer, expose-state hubOrigin, platform
 * origin, loopback aliases — i.e. the same set `buildHubBoundOrigins`
 * produces), ALSO register the same PATH on every OTHER known hub origin. A
 * loopback-registered hub-served client thus becomes valid on the public hub
 * origin too, without ever loosening the strict authorize-time match.
 *
 * THE INVARIANT (no open redirect). Expansion ONLY ever produces URIs rooted
 * at the hub's OWN known origins. A submitted redirect_uri whose origin is
 * FOREIGN — a separate-origin surface on its own domain (e.g. my-vault-ui at
 * `https://notes.example`), a third-party app — is stored VERBATIM: not
 * expanded onto any hub origin, and not dropped. Only hub-origin-rooted URIs
 * receive the cross-origin fan-out. Because authorize-time matching stays
 * strict exact-match against this stored set, an attacker who registers a
 * foreign redirect_uri gets back exactly what they submitted (no hub-origin
 * variant minted for them), and a hub-origin-rooted URI only ever fans out to
 * other hub origins the operator already controls.
 *
 * Order-preserving + de-duplicated: the originally-submitted URIs come first
 * (preserving caller order), with the synthesized hub-origin variants
 * appended in a stable order; duplicates are collapsed.
 */
export function expandRedirectUrisForHubOrigins(
  submitted: readonly string[],
  hubOrigins: readonly string[],
): string[] {
  // Parse the hub's known origins into a Set for membership tests. Malformed
  // entries are skipped — the function fails safe (no expansion) rather than
  // throwing.
  const hubOriginSet = new Set<string>();
  for (const raw of hubOrigins) {
    try {
      hubOriginSet.add(new URL(raw).origin);
    } catch {
      // Skip malformed hub origin.
    }
  }

  // Preserve submitted order + dedupe; append synthesized variants after.
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (uri: string) => {
    if (seen.has(uri)) return;
    seen.add(uri);
    out.push(uri);
  };

  // 1) Every submitted URI is stored as-is (foreign + hub-origin alike). This
  //    is what guarantees a foreign redirect_uri is never dropped.
  for (const uri of submitted) push(uri);

  // 2) For each submitted URI rooted at a hub origin, synthesize the same path
  //    on every OTHER hub origin. Foreign-origin URIs are skipped here — they
  //    never spawn a hub-origin variant (the open-redirect guard).
  if (hubOriginSet.size > 1) {
    for (const uri of submitted) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        continue;
      }
      if (!hubOriginSet.has(parsed.origin)) continue; // foreign → no expansion
      const pathSuffix = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      for (const origin of hubOriginSet) {
        if (origin === parsed.origin) continue;
        push(`${origin}${pathSuffix}`);
      }
    }
  }

  return out;
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
  // hub#663: reject control chars (C0 0x00-0x1f + DEL 0x7f) in the RAW input
  // BEFORE URL parsing normalizes/strips them. A `\r`/`\n`/NUL smuggled into a
  // redirect_uri is a header/log-injection vector even though our exact-match +
  // verbatim foreign-storage neutralize it downstream — spec-forbidden hygiene.
  // (Charcode scan rather than a control-char regex literal, which biome's
  // noControlCharactersInRegex rightly flags as an easy footgun.)
  for (let i = 0; i < uri.length; i++) {
    const c = uri.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  try {
    const u = new URL(uri);
    if (u.protocol === "javascript:" || u.protocol === "data:") return false;
    // hub#663: reject userinfo (`https://x@evil.com/cb`). A redirect target
    // carrying credentials is spec-forbidden and an open-redirect / phishing
    // shape; the protocol allowlist alone let it through.
    if (u.username !== "" || u.password !== "") return false;
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
