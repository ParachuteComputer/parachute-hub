/**
 * NIP-98 HTTP request authentication (hub#833 (c)).
 *
 * A request carrying `Authorization: Nostr <base64url(json event)>` proves
 * the caller holds the private key for `event.pubkey`. That pubkey maps to a
 * hub user via `user_pubkeys`. Unknown keys may create a key-only user when
 * `autoProvision` is on — the Buzz-shaped onboarding: agents already have
 * keys; they do not get hub passwords.
 *
 * Replay: NIP-98's ±60s `created_at` window is not enough (the linkage
 * ceremony already refused to rely on it). This module also rejects an
 * event id it has seen until well after that window closes.
 *
 * The cookie + password first-link path in `api-account-pubkeys.ts` is
 * unchanged. This path never asks for a password: the signature *is* the
 * possession proof.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  NOSTR_AUTH_KIND,
  type NostrEvent,
  parseNostrEvent,
  tagValue,
  verifyNostrEvent,
} from "./nostr-event.ts";
import { bindPubkeyFromHttpAuth, findPubkeyLink } from "./pubkey-links.ts";
import { isHttpsRequest } from "./request-protocol.ts";
import {
  createUser,
  getFirstAdminId,
  getUserById,
  isFirstAdmin,
  vaultVerbsForUserVault,
} from "./users.ts";

/** NIP-98 clock skew, seconds. Spec window. */
export const NIP98_MAX_SKEW_SECONDS = 60;

/**
 * How long a used event id stays rejected. Must be ≥ 2× the skew window so
 * an event still inside ±60s cannot be replayed after eviction.
 */
export const NIP98_REPLAY_TTL_MS = 2 * NIP98_MAX_SKEW_SECONDS * 1000 + 1000;

export type NostrHttpAuthFailure =
  | "missing_authorization"
  | "malformed_authorization"
  | "invalid_event"
  | "bad_signature"
  | "wrong_kind"
  | "expired"
  | "replayed"
  | "url_mismatch"
  | "method_mismatch"
  | "payload_mismatch"
  | "unknown_pubkey"
  | "pubkey_taken";

export class NostrHttpAuthError extends Error {
  override name = "NostrHttpAuthError";
  constructor(
    public readonly status: number,
    public readonly code: NostrHttpAuthFailure,
    message: string,
  ) {
    super(message);
  }
}

export class NostrReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs: number = NIP98_REPLAY_TTL_MS) {}

  /**
   * Returns true if this id was already consumed and is still inside TTL.
   * Records the id on first sight.
   */
  consume(id: string, nowMs: number): boolean {
    this.gc(nowMs);
    const exp = this.seen.get(id);
    if (exp !== undefined && exp > nowMs) return true;
    this.seen.set(id, nowMs + this.ttlMs);
    return false;
  }

  private gc(nowMs: number): void {
    for (const [id, exp] of this.seen) {
      if (exp <= nowMs) this.seen.delete(id);
    }
  }
}

const defaultReplay = new NostrReplayCache();

export function extractNostrEvent(req: Request): NostrEvent {
  const header = req.headers.get("authorization");
  if (!header) {
    throw new NostrHttpAuthError(401, "missing_authorization", "missing Authorization header");
  }
  const match = header.match(/^Nostr\s+(\S+)$/i);
  if (!match || !match[1]) {
    throw new NostrHttpAuthError(
      401,
      "malformed_authorization",
      "Authorization header must be 'Nostr <base64 event>'",
    );
  }
  let json: string;
  try {
    json = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    throw new NostrHttpAuthError(401, "malformed_authorization", "Nostr token is not base64url");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new NostrHttpAuthError(401, "malformed_authorization", "Nostr token is not JSON");
  }
  const parsed = parseNostrEvent(raw);
  if (!parsed.ok) {
    throw new NostrHttpAuthError(401, "invalid_event", `Nostr event rejected: ${parsed.reason}`);
  }
  return parsed.event;
}

/**
 * Absolute URL the NIP-98 `u` tag must equal.
 *
 * Hub binds 127.0.0.1:1939 over plain HTTP. Tailscale Serve, cloudflared,
 * and Render terminate TLS at the edge and forward HTTP, so `req.url` is
 * `http://<public-host>/…` while the client POSTed — and signed —
 * `https://<public-host>/…`. Same reconstruction as `resolveIssuer`'s
 * request fallback: upgrade the scheme when `isHttpsRequest` is true
 * (URL protocol or `X-Forwarded-Proto: https`). Host, path, and query
 * stay on `req.url`. We do not honor `X-Forwarded-Host` here, and we do
 * not substitute stored `hub_origin` — loopback NIP-98 stays bound to
 * loopback.
 */
export function requestAbsoluteUrl(req: Request): string {
  const url = new URL(req.url);
  if (isHttpsRequest(req) && url.protocol === "http:") {
    url.protocol = "https:";
    return url.href;
  }
  return req.url;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Verify the event is a NIP-98 auth event for *this* request. Does not
 * resolve a hub user.
 */
export function verifyNostrHttpEvent(
  req: Request,
  event: NostrEvent,
  opts: {
    now?: () => Date;
    replay?: NostrReplayCache;
    /** Raw body bytes; required when the request has a body. */
    body?: Uint8Array;
  } = {},
): void {
  const now = opts.now?.() ?? new Date();
  const replay = opts.replay ?? defaultReplay;

  const verified = verifyNostrEvent(event);
  if (!verified.ok) {
    throw new NostrHttpAuthError(
      401,
      "bad_signature",
      verified.reason === "id_mismatch"
        ? "Nostr event id does not match payload"
        : "Nostr event signature is invalid",
    );
  }
  if (event.kind !== NOSTR_AUTH_KIND) {
    throw new NostrHttpAuthError(401, "wrong_kind", `Nostr event kind must be ${NOSTR_AUTH_KIND}`);
  }

  const createdAtMs = event.created_at * 1000;
  const skewMs = NIP98_MAX_SKEW_SECONDS * 1000;
  if (Math.abs(now.getTime() - createdAtMs) > skewMs) {
    throw new NostrHttpAuthError(
      401,
      "expired",
      "Nostr event created_at is outside the 60s window",
    );
  }

  if (replay.consume(event.id, now.getTime())) {
    throw new NostrHttpAuthError(401, "replayed", "Nostr event id has already been used");
  }

  const u = tagValue(event, "u");
  const expectedUrl = requestAbsoluteUrl(req);
  if (u !== expectedUrl) {
    throw new NostrHttpAuthError(
      401,
      "url_mismatch",
      "Nostr event u tag must equal this request URL",
    );
  }
  const method = tagValue(event, "method");
  if (!method || method.toUpperCase() !== req.method.toUpperCase()) {
    throw new NostrHttpAuthError(
      401,
      "method_mismatch",
      "Nostr event method tag must equal this request method",
    );
  }

  const body = opts.body ?? new Uint8Array();
  const payload = tagValue(event, "payload");
  if (body.byteLength === 0) {
    if (payload) {
      throw new NostrHttpAuthError(
        401,
        "payload_mismatch",
        "Nostr event payload tag must be absent when the body is empty",
      );
    }
  } else {
    const expected = sha256Hex(body);
    if (payload !== expected) {
      throw new NostrHttpAuthError(
        401,
        "payload_mismatch",
        "Nostr event payload tag must be sha256 hex of the request body",
      );
    }
  }
}

export interface NostrPrincipal {
  userId: string;
  username: string;
  pubkey: string;
  /** True when this request created the hub user. */
  provisioned: boolean;
  /**
   * Hub-admin unrestricted sentinel is first-admin only. Key-native users
   * never become first-admin by auto-provision (the owner row already exists).
   */
  isHubAdmin: boolean;
  /** `vault:<name>:<verb>` for assigned vaults. Empty for first-admin. */
  scopes: string[];
}

function usernameForPubkey(pubkey: string): string {
  // validateUsername: [a-z0-9_-] 2–32. Hex is in charset.
  return `n${pubkey.slice(0, 31)}`;
}

/**
 * Map a verified pubkey to a hub user. Existing `user_pubkeys` row wins.
 * When `autoProvision` is true and the key is unknown, create a key-only
 * user (random unusable password, password_changed=1, key already bound).
 */
export async function resolveNostrPrincipal(
  db: Database,
  event: NostrEvent,
  opts: { autoProvision: boolean; now?: () => Date },
): Promise<NostrPrincipal> {
  const nowFn = opts.now ?? (() => new Date());
  const now = nowFn();
  const existing = findPubkeyLink(db, event.pubkey);
  if (existing) {
    const user = getUserById(db, existing.userId);
    if (!user) {
      throw new NostrHttpAuthError(401, "unknown_pubkey", "linked user no longer exists");
    }
    return principalFromUser(db, user.id, user.username, event.pubkey, false);
  }
  if (!opts.autoProvision) {
    throw new NostrHttpAuthError(401, "unknown_pubkey", "Nostr pubkey is not linked to a hub user");
  }
  if (getFirstAdminId(db) === null) {
    throw new NostrHttpAuthError(
      401,
      "unknown_pubkey",
      "Nostr auto-provision requires an existing hub owner",
    );
  }

  const password = randomBytes(32).toString("base64url");
  let username = usernameForPubkey(event.pubkey);
  let user;
  try {
    user = await createUser(db, username, password, {
      allowMulti: true,
      passwordChanged: true,
      assignedVaults: [],
      now: nowFn,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "UsernameTakenError") {
      username = `n${event.pubkey.slice(1, 32)}`;
      user = await createUser(db, username, password, {
        allowMulti: true,
        passwordChanged: true,
        assignedVaults: [],
        now: nowFn,
      });
    } else {
      throw err;
    }
  }

  const bound = bindPubkeyFromHttpAuth(db, {
    userId: user.id,
    pubkey: event.pubkey,
    proofEvent: JSON.stringify(event),
    proofEventId: event.id,
    label: "nip98",
    now,
  });
  if (!bound.ok) {
    throw new NostrHttpAuthError(
      401,
      "pubkey_taken",
      "Nostr pubkey is already bound to another user",
    );
  }
  return principalFromUser(db, user.id, user.username, event.pubkey, true);
}

function principalFromUser(
  db: Database,
  userId: string,
  username: string,
  pubkey: string,
  provisioned: boolean,
): NostrPrincipal {
  const admin = isFirstAdmin(db, userId);
  const user = getUserById(db, userId);
  const scopes: string[] = [];
  if (!admin && user) {
    for (const name of user.assignedVaults) {
      const verbs = vaultVerbsForUserVault(db, userId, name) ?? [];
      for (const verb of verbs) scopes.push(`vault:${name}:${verb}`);
    }
  }
  return { userId, username, pubkey, provisioned, isHubAdmin: admin, scopes };
}

export async function authenticateNostrRequest(
  db: Database,
  req: Request,
  opts: {
    autoProvision: boolean;
    now?: () => Date;
    replay?: NostrReplayCache;
    body?: Uint8Array;
  },
): Promise<NostrPrincipal> {
  const event = extractNostrEvent(req);
  verifyNostrHttpEvent(req, event, {
    now: opts.now,
    replay: opts.replay,
    body: opts.body,
  });
  return resolveNostrPrincipal(db, event, {
    autoProvision: opts.autoProvision,
    now: opts.now,
  });
}

export function isNostrAuthorization(req: Request): boolean {
  const header = req.headers.get("authorization");
  return !!header && /^Nostr\s+/i.test(header);
}
