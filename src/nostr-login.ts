/**
 * `/api/auth/nostr/*` — the human key door. A cooperative member who holds a
 * Nostr key (and no usable password) signs in to the hub with it.
 *
 * Design: team-vault `Design/Human key door — sign in with a Nostr key`
 * (https://parachute.techne.coop/n/01M1J1CHW7KM8FD35FR1AH06HK). This file is
 * rows 1–3 of that note's build plan: the challenge store, the verify route,
 * and the 2FA divert. The browser UI (row 4) is a separate change; nothing
 * here renders HTML.
 *
 * ## Why this exists
 *
 * Every session the hub mints today comes from a password path (`createSession`
 * has four call sites, all of them password). But `ensureUserForPubkey` and
 * `resolveNostrPrincipal` both create key-only users with `randomBytes(32)` as
 * the password and `password_changed = 1` — the hash is real and the secret
 * exists nowhere, so `verifyPassword` can never pass. A key-only member can
 * drive MCP and the CLI over NIP-98 but cannot open `/account/`, cannot reach
 * the OAuth consent screen, and cannot get an app token. This door is the
 * missing entry: prove possession of a linked key, get the SAME session the
 * password door mints.
 *
 * ## Routes
 *
 *   GET  /api/auth/nostr/challenge → {challenge, expires_at, event_template}
 *   POST /api/auth/nostr/verify    → Set-Cookie + {ok, redirect}
 *                                    or {requires_2fa, redirect} + pending cookie
 *
 * Both are ANONYMOUS — there is no session yet, that is the whole point.
 *
 * ## The ceremony
 *
 * Deliberately the same shape as the `/api/account/pubkeys` linkage ceremony
 * (`api-account-pubkeys.ts`), so one signer implementation covers both: a
 * NIP-98-shaped kind-27235 event carrying
 *
 *   ["u",         "<this hub>/api/auth/nostr/verify"]
 *   ["method",    "POST"]
 *   ["challenge", "<the nonce just issued>"]
 *
 * and a `content` that is a legible sign-in sentence naming the origin (see
 * {@link signInStatement}). The differences from linkage are all consequences
 * of there being no session:
 *
 *   - The nonce is NOT user-bound (there is no user to bind it to) and lives
 *     in process memory rather than `pubkey_challenges`, whose `user_id`
 *     column is `NOT NULL REFERENCES users(id)`.
 *   - The statement names the ORIGIN only, never an account. At challenge time
 *     the hub does not know who is signing; at verify time the key names the
 *     account, so there is no account to state.
 *   - The rate limiters key on the client IP, not on a user id.
 *
 * ## Storage: a process-local Map, on purpose
 *
 * Same posture and the same stated reason as `pending-login.ts`: the window is
 * 5 minutes, so a hub restart means the member clicks "sign in" again, and a
 * schema migration for a 5-minute-lived ephemeral row buys nothing. Single-use
 * consumption is a `Map.delete` on a single-threaded runtime, which is as
 * atomic as the DB transaction would have been.
 *
 * ## What defends what
 *
 *   - REPLAY: the server-issued, single-use nonce is PRIMARY — it is deleted
 *     before the session is minted, so a second verify with the same nonce is
 *     a 401 no matter how valid the signature is. The `created_at` window and
 *     the `u` / `method` binding are belts. (`NostrReplayCache` is explicitly
 *     NOT used here: its TTL is 121 s, shorter than the nonce window, so it
 *     would be the weaker of the two and add nothing.)
 *   - NONCE FIXATION: the nonce is bound to nothing the client supplies and is
 *     minted only by `GET /challenge`. A nonce an attacker plants on a victim
 *     authenticates whoever signs it — i.e. the attacker's own key if the
 *     attacker signs, which gets them their own account.
 *   - CONFUSED DEPUTY: the statement in `content` says, in words a signer pane
 *     shows a human, which hub is asking and that signing starts a session
 *     there. Legibility, not cryptography — the same honest limit
 *     `linkageStatement` documents.
 *   - CROSS-SERVICE SIGNATURE REUSE: the `u` tag must name an origin this hub
 *     answers on AND the verify path, so a NIP-98 signature harvested for
 *     another service — or another hub — is not spendable here.
 *   - SESSION FIXATION: `createSession` always mints a fresh 32-byte id; no
 *     client-supplied session id exists anywhere on this path.
 *
 * ## What the door does NOT do
 *
 *   - It never writes grants. No `grantAccess`, no `upsertUserVault`, no
 *     `bindPubkey*`. Verbs stay whatever an operator or the channel-vault
 *     reconciler already wrote. This door only maps an existing link to an
 *     existing user and mints a session.
 *   - It never provisions. An unlinked key is a 401 `unknown_pubkey`, full
 *     stop — `PARACHUTE_NOSTR_AUTO_PROVISION` is not consulted here, because
 *     auto-provisioning a BROWSER SESSION is a strictly larger decision than
 *     auto-provisioning an MCP principal and deserves its own design pass.
 */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { mintSessionAndRedirect, safeNext } from "./admin-handlers.ts";
import {
  NOSTR_AUTH_KIND,
  type NostrEvent,
  parseNostrEvent,
  tagValue,
  verifyNostrEvent,
} from "./nostr-event.ts";
import { buildPendingLoginCookie, createPendingLogin } from "./pending-login.ts";
import { findPubkeyLink } from "./pubkey-links.ts";
import {
  clientIpFromRequest,
  nostrLoginChallengeRateLimiter,
  nostrLoginVerifyRateLimiter,
} from "./rate-limit.ts";
import { isTotpEnrolled } from "./two-factor-store.ts";
import { getUserById } from "./users.ts";

/** Path the signed event's `u` tag must name. Also where the verify route mounts. */
export const NOSTR_LOGIN_VERIFY_PATH = "/api/auth/nostr/verify";
/** Where the challenge route mounts. */
export const NOSTR_LOGIN_CHALLENGE_PATH = "/api/auth/nostr/challenge";

/**
 * How long a sign-in nonce stays spendable. Five minutes — the same window
 * `pending-login.ts` uses, and long enough to unlock a phone, open a signer,
 * and read the statement before approving.
 */
export const NOSTR_LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Accepted clock skew on the event's `created_at`, in seconds.
 *
 * ±5 minutes, matching `VERIFY_MAX_CREATED_AT_SKEW_SECONDS` on the linkage
 * ceremony and deliberately NOT NIP-98's ±60 s (`nostr-http-auth.ts`). NIP-98's
 * window suits a machine-to-machine request signed a moment before it is sent;
 * this one is signed by a human on a phone whose clock drifts, on a self-hosted
 * box whose clock also drifts. The single-use nonce — not this window — is what
 * prevents replay, so tightening it buys nothing and locks out real signers.
 * Applied in both directions: a far-future timestamp is as suspect as a stale one.
 */
export const NOSTR_LOGIN_MAX_CREATED_AT_SKEW_SECONDS = 300;

/**
 * How long past expiry a spent-or-stale nonce is remembered, so `/verify` can
 * answer `challenge_expired` rather than `unknown_challenge`.
 *
 * Distinguishing the two is safe here in a way it is NOT on the linkage
 * surface: a linkage challenge is USER-BOUND, so an "expired vs unknown" split
 * would be an oracle for "does this challenge belong to my account". A sign-in
 * nonce is bound to nobody — the only party who can hold one is whoever asked
 * for it — so telling them "that one timed out, ask for another" leaks nothing
 * and is the difference between a member retrying and a member giving up.
 */
const EXPIRED_NONCE_GRACE_MS = 10 * 60 * 1000;

/**
 * Hard ceiling on live nonces. The per-IP limiter bounds any single client, but
 * the endpoint is anonymous, so a botnet across many IPs could otherwise grow
 * the Map without bound. At the cap we drop the OLDEST entries (Map preserves
 * insertion order, and entries are inserted in issue order, so the oldest are
 * also the closest to expiry). Losing a nonce under flood means one member
 * clicks sign-in twice; unbounded memory means the hub dies.
 */
export const MAX_LIVE_CHALLENGES = 10_000;

/**
 * Floor between `MAX_LIVE_CHALLENGES` eviction warnings. Hitting the cap at
 * all means something anomalous is happening (a nonce flood, or a hub that
 * needs a higher ceiling) and is worth ONE log line to make it visible — but
 * a sustained flood evicts on every `issueLoginChallenge` call, and logging
 * every one of those would be its own resource-exhaustion vector.
 */
const EVICTION_WARN_INTERVAL_MS = 60 * 1000;

interface LoginChallenge {
  /** Absolute expiry (ms epoch). */
  expiresAtMs: number;
}

const challenges = new Map<string, LoginChallenge>();

/** ms-epoch of the last eviction warning; 0 means "never warned". */
let lastEvictionWarnAtMs = 0;

function gc(nowMs: number): void {
  for (const [nonce, c] of challenges) {
    if (c.expiresAtMs + EXPIRED_NONCE_GRACE_MS <= nowMs) challenges.delete(nonce);
  }
}

/** Test-only: drop every issued nonce, and the eviction-warning cooldown, between cases. */
export function _resetNostrLoginChallenges(): void {
  challenges.clear();
  lastEvictionWarnAtMs = 0;
}

export interface IssuedLoginChallenge {
  challenge: string;
  /** ISO-8601, the wire spelling. */
  expiresAt: string;
}

/**
 * Mint a fresh single-use sign-in nonce. 32 bytes of CSPRNG entropy, lowercase
 * hex — the same spelling `issuePubkeyChallenge` uses, so a client that already
 * speaks the linkage ceremony needs no new parsing.
 */
export function issueLoginChallenge(now: Date = new Date()): IssuedLoginChallenge {
  const nowMs = now.getTime();
  gc(nowMs);
  let evicted = false;
  while (challenges.size >= MAX_LIVE_CHALLENGES) {
    const oldest = challenges.keys().next();
    if (oldest.done) break;
    challenges.delete(oldest.value);
    evicted = true;
  }
  if (evicted && nowMs - lastEvictionWarnAtMs >= EVICTION_WARN_INTERVAL_MS) {
    lastEvictionWarnAtMs = nowMs;
    console.warn(
      `nostr-login: MAX_LIVE_CHALLENGES (${MAX_LIVE_CHALLENGES}) reached — evicting oldest sign-in nonces. Possible nonce flood.`,
    );
  }
  const challenge = randomBytes(32).toString("hex");
  challenges.set(challenge, { expiresAtMs: nowMs + NOSTR_LOGIN_CHALLENGE_TTL_MS });
  return { challenge, expiresAt: new Date(nowMs + NOSTR_LOGIN_CHALLENGE_TTL_MS).toISOString() };
}

export type ConsumeChallengeResult = "ok" | "unknown" | "expired";

/**
 * Spend a nonce. Single-use: the entry is DELETED on the way out for every
 * outcome that isn't "unknown", so a second call with the same value can never
 * return `ok`. Deletion happens before the caller mints anything, which is what
 * makes the replay defense primary rather than advisory.
 *
 * An expired entry is deleted and reported as `expired` (see
 * {@link EXPIRED_NONCE_GRACE_MS} for why that distinction is safe here).
 */
export function consumeLoginChallenge(
  challenge: string,
  now: Date = new Date(),
): ConsumeChallengeResult {
  const nowMs = now.getTime();
  const entry = challenges.get(challenge);
  if (!entry) return "unknown";
  challenges.delete(challenge);
  if (entry.expiresAtMs <= nowMs) return "expired";
  return "ok";
}

/**
 * The human-readable statement the signed event's `content` must carry.
 *
 * The `linkageStatement` shape (EIP-4361 / SIWE discipline: the bytes a human
 * is asked to sign have to say what signing them means), minus the account
 * line — at challenge time the hub does not know who is about to sign, and at
 * verify time the key itself names the account, so there is nothing to state.
 *
 * `origin` is the one the event's own `u` tag names, which `checkBinding` has
 * already required to be an origin this hub answers on — so the statement and
 * the endpoint binding can never disagree, and the origin is never taken from
 * the incoming request's Host.
 *
 * Unlike `linkageStatement` this interpolates NOTHING untrusted: the origin
 * comes from a fixed server-side set, never from user input, so there is no
 * charset to escape and no reason this can ever throw.
 */
export function signInStatement(origin: string): string {
  return [
    `${origin} asks you to sign in to Parachute with your Nostr key.`,
    "",
    "Signing proves you hold the private key for the public key in this event and starts a browser session for the account it is linked to, on this hub. Do not sign if you did not just ask to sign in here.",
  ].join("\n");
}

/**
 * Whether the key door diverts a TOTP-enrolled user to the second factor.
 *
 * Default ON — an nsec sitting in a browser extension or on a phone is easier
 * to lift than a password plus a TOTP seed, and the hub has no per-user session
 * revoke, so a session minted from a stolen key cannot be cut short. A member
 * who has chosen 2FA has said they want the second factor; a new door must not
 * quietly be the one that skips it.
 *
 * `PARACHUTE_NOSTR_LOGIN_2FA=off` (trimmed, case-insensitive) is the escape
 * hatch, for an operator who has decided their key custody is the stronger
 * factor. `off` is the ONLY spelling that turns it off — not `0` / `false` /
 * `no`. Anything else, including unset, keeps the divert.
 */
export const NOSTR_LOGIN_2FA_ENV = "PARACHUTE_NOSTR_LOGIN_2FA";

export function nostrLoginRequires2fa(): boolean {
  const v = (process.env[NOSTR_LOGIN_2FA_ENV] ?? "").trim().toLowerCase();
  return v !== "off";
}

export interface NostrLoginDeps {
  db: Database;
  /**
   * Origins this hub legitimately answers on. The signed event's `u` tag must
   * name one of them.
   *
   * Wired in production from `linkageBoundOrigins` — i.e. `buildHubBoundOrigins`
   * with the REQUEST-SOURCED issuer dropped. That is stricter than the general
   * bound-origin set the OAuth same-origin checks use, and deliberately so: the
   * general set includes an origin `resolveIssuer` derived from the incoming
   * Host when nothing is configured, and a Host-derived origin is
   * attacker-influenceable. If it were accepted here, an attacker could POST
   * with `Host: evil.example`, get that origin into the set, and thereby make a
   * signature over a statement reading "evil.example asks you to sign in"
   * spendable at the real hub — a confused-deputy path to a session as the
   * victim. Same reasoning as hub#833 MEDIUM-1, which drew the line for a
   * durable proof; a session mint deserves it at least as much.
   *
   * When ABSENT (the unit-test shape) only the PATH component of `u` is
   * checked. The origin binding is defense-in-depth; the server-issued
   * single-use nonce is the primary replay defense and is unconditional.
   */
  hubBoundOrigins?: readonly string[];
  /** Test seam for time. */
  now?: () => Date;
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

function jsonError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

function tooManyAttempts(retryAfterSeconds: number): Response {
  return json(
    429,
    {
      error: "too_many_attempts",
      error_description: `Too many attempts. Try again in ${retryAfterSeconds} seconds.`,
    },
    { "retry-after": String(retryAfterSeconds) },
  );
}

/**
 * The origin to advertise in the event template. Taken from the request URL —
 * the origin the client actually reached us on, which is the one their verify
 * request will use too. Only ever used to BUILD a template; the `u` tag
 * presented at `/verify` is validated against `deps.hubBoundOrigins`, never
 * against this. (So a Host-forged template simply produces a signature the
 * verify step refuses.)
 */
function requestOrigin(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

/**
 * Router. `subpath` is relative to `/api/auth/nostr`.
 */
export async function handleNostrLogin(
  req: Request,
  subpath: string,
  deps: NostrLoginDeps,
): Promise<Response> {
  const now = deps.now ?? (() => new Date());
  switch (subpath) {
    case "/challenge":
      if (req.method !== "GET") return jsonError(405, "method_not_allowed", "use GET");
      return handleChallenge(req, deps, now);
    case "/verify":
      if (req.method !== "POST") return jsonError(405, "method_not_allowed", "use POST");
      return handleVerify(req, deps, now);
    default:
      return jsonError(404, "not_found", `no route at /api/auth/nostr${subpath}`);
  }
}

/**
 * GET /challenge — issue a single-use, TTL-bounded nonce plus the exact event
 * the client must sign.
 *
 * Returning the template (rather than documenting it) means the client never
 * reconstructs the `u` tag from its own notion of the hub's URL, which is the
 * field most likely to be got wrong on a multi-origin box.
 *
 * GET, not POST, because it is a pure read of fresh entropy: no session, no
 * CSRF token to double-submit, nothing to protect. A CSRF'd GET here would
 * hand an attacker a nonce that authenticates whoever signs it — which is the
 * attacker's own key, i.e. their own account.
 */
function handleChallenge(req: Request, _deps: NostrLoginDeps, now: () => Date): Response {
  // Per-IP: the route is anonymous, so there is no identity to key on. Bounds
  // Map growth from a single client; `MAX_LIVE_CHALLENGES` bounds it across
  // clients.
  const gate = nostrLoginChallengeRateLimiter.checkAndRecord(clientIpFromRequest(req), now());
  if (!gate.allowed) return tooManyAttempts(gate.retryAfterSeconds ?? 1);

  const issued = issueLoginChallenge(now());
  const origin = requestOrigin(req);
  return json(200, {
    challenge: issued.challenge,
    expires_at: issued.expiresAt,
    event_template: {
      kind: NOSTR_AUTH_KIND,
      content: signInStatement(origin),
      tags: [
        ["u", `${origin}${NOSTR_LOGIN_VERIFY_PATH}`],
        ["method", "POST"],
        ["challenge", issued.challenge],
      ],
    },
  });
}

/**
 * POST /verify {event, next?} — the proof step.
 *
 * Order is load-bearing, cheap-to-expensive, and side-effect-free until the
 * last possible moment:
 *
 *   1. per-IP rate limit (before ANY parsing — this endpoint is anonymous, so
 *      the limiter is the only thing standing between a stranger and unbounded
 *      sha256 + BIP-340 work)
 *   2. body shape, then event shape (`parseNostrEvent`; no hashing yet)
 *   3. kind / created_at / exactly-one `u` / `method` / `challenge` — all pure
 *   4. the legible statement in `content`, recomputed from the `u` tag's
 *      already-validated origin
 *   5. NIP-01 id recomputation, then BIP-340 verification
 *   6. NONCE CONSUMPTION — single-use, deleted here, before anything is minted
 *   7. `findPubkeyLink` → the user
 *   8. 2FA divert, or session mint
 *
 * Nothing before step 6 mutates any state, so every rejection above leaves the
 * member's nonce spendable and they can retry with a corrected event. From step
 * 6 the nonce is spent whatever happens after — including an unlinked key —
 * which is the correct posture: the nonce's job is "this ceremony ran once".
 */
async function handleVerify(
  req: Request,
  deps: NostrLoginDeps,
  now: () => Date,
): Promise<Response> {
  // 1. Rate limit first. Unlike the linkage ceremony (session-gated, keyed by
  //    user) there is no prior gate at all here.
  const gate = nostrLoginVerifyRateLimiter.checkAndRecord(clientIpFromRequest(req), now());
  if (!gate.allowed) return tooManyAttempts(gate.retryAfterSeconds ?? 1);

  // Login-CSRF belt. A session-minting POST is worth protecting from a
  // cross-site form even though it carries no ambient credential: forcing a
  // victim's browser into an ATTACKER's session is how a later action gets
  // attributed to the attacker's account. When an Origin header is present it
  // must name a bound origin; when it is absent (a non-browser client — CLI,
  // curl, a native signer) we let it through, because a browser always sends
  // Origin on a cross-origin POST and its absence is therefore evidence the
  // request is not a browser's.
  const originHeader = req.headers.get("origin");
  const bound = deps.hubBoundOrigins;
  if (originHeader && bound !== undefined && bound.length > 0) {
    let ok = false;
    if (originHeader !== "null") {
      try {
        ok = new Set(bound).has(new URL(originHeader).origin);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      return jsonError(
        403,
        "csrf_origin_mismatch",
        "request Origin does not match this hub's origin — cross-site sign-in is not allowed",
      );
    }
  }

  // 2. Body + event shape. `invalid_request` is the malformed-body code;
  //    `invalid_event` covers an event that is present but not a NIP-01 event.
  let body: Record<string, unknown>;
  try {
    const parsedBody: unknown = await req.json();
    if (parsedBody === null || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      return jsonError(400, "invalid_request", "body must be a JSON object");
    }
    body = parsedBody as Record<string, unknown>;
  } catch {
    return jsonError(400, "invalid_request", "body must be a JSON object");
  }
  if (body.event === undefined || body.event === null) {
    return jsonError(400, "invalid_request", "body must carry a signed `event`");
  }
  if (body.next !== undefined && typeof body.next !== "string") {
    return jsonError(400, "invalid_request", "`next` must be a string when present");
  }
  const parsed = parseNostrEvent(body.event);
  if (!parsed.ok) {
    return jsonError(
      400,
      "invalid_event",
      "event must be a NIP-01 event object with hex id/pubkey/sig, an integer kind and created_at, a string content, and bounded string tags",
    );
  }
  const event = parsed.event;

  // 3. Binding checks — all pure, all before any hashing.
  const binding = checkBinding(event, deps, now());
  if (!binding.ok) return binding.res;
  const challenge = tagValue(event, "challenge");
  if (challenge === null || challenge.length === 0) {
    return jsonError(400, "invalid_event", "event must carry a `challenge` tag");
  }

  // 4. The legible statement, recomputed from the `u` tag's already-validated
  //    origin — never from the request's Host, and never from the body.
  if (event.content !== signInStatement(binding.origin)) {
    return jsonError(
      400,
      "invalid_event",
      "event content must be the sign-in statement this hub issued — request a fresh challenge and sign its `content` verbatim",
    );
  }

  // 5. Proof of possession. `id_mismatch` and `bad_signature` collapse into one
  //    response: both mean "this event does not prove you hold that key", and
  //    telling an attacker which of the two failed is free information.
  if (!verifyNostrEvent(event).ok) {
    return jsonError(
      401,
      "proof_failed",
      "the event's signature does not prove possession of the claimed pubkey",
    );
  }

  // 6. Spend the nonce. Deleted here, before any session exists — so a replay
  //    of this exact request, however well-formed, gets `unknown_challenge`.
  const spend = consumeLoginChallenge(challenge, now());
  if (spend === "unknown") {
    return jsonError(
      401,
      "unknown_challenge",
      "challenge is unknown or has already been used — request a fresh one",
    );
  }
  if (spend === "expired") {
    return jsonError(
      401,
      "challenge_expired",
      "challenge has expired — request a fresh one and sign it within five minutes",
    );
  }

  // 7. Principal. `user_pubkeys.pubkey` is the PRIMARY KEY, so a key names at
  //    most one user hub-wide. Auto-provision is deliberately NOT consulted:
  //    an unlinked key is a dead end here, and an operator (`parachute auth
  //    link-pubkey`) or the channel-vault reconciler is the way in. Same
  //    `unknown_pubkey` code `resolveNostrPrincipal` returns, so a client can
  //    treat the two surfaces alike.
  const link = findPubkeyLink(deps.db, event.pubkey);
  if (!link) {
    return jsonError(401, "unknown_pubkey", "Nostr pubkey is not linked to a hub user");
  }
  const user = getUserById(deps.db, link.userId);
  if (!user) {
    // Defensive: `user_pubkeys.user_id` is a FK, so a link without a user
    // should be impossible. Same code — from the caller's side the key does
    // not name a usable account either way, and the split would be a probe.
    return jsonError(401, "unknown_pubkey", "Nostr pubkey is not linked to a hub user");
  }

  const next = safeNext(typeof body.next === "string" ? body.next : null);

  // 8a. 2FA divert. The same two lines the password doors run
  //     (`admin-handlers.ts` `/login`, `oauth-handlers.ts` `/oauth/authorize`):
  //     stash a pending-login keyed by an opaque cookie token and hand back the
  //     "second factor required" shape. NO session is minted here — the caller
  //     completes at `/login/2fa`, which is the shared completion path and the
  //     only other place `createSession` runs for an interactive login.
  //
  //     `/login/2fa` is POST-only today (the password doors RENDER the
  //     challenge form themselves rather than redirecting to it). Handing the
  //     caller `redirect: "/login/2fa"` is the contract row 4's UI acts on; the
  //     GET renderer for that path is row 4's to add.
  if (nostrLoginRequires2fa() && isTotpEnrolled(deps.db, user.id)) {
    const pendingToken = createPendingLogin(user.id, next);
    return json(
      200,
      { requires_2fa: true, redirect: "/login/2fa" },
      { "set-cookie": buildPendingLoginCookie(pendingToken, req) },
    );
  }

  // 8b. Mint. `mintSessionAndRedirect` is the password door's own minting
  //     path — createSession + recordLoginUnlock + buildSessionCookie +
  //     loginRedirectTarget — so this door gets the same cookie, the same
  //     90-day rolling TTL, and the same force-change-password / friend-rewrite
  //     redirect rules, by construction rather than by copying them. It returns
  //     a 302 because its browser callers post a form; this door's callers are
  //     `fetch()`, so we re-dress the SAME cookie + the SAME resolved target as
  //     JSON rather than re-deriving either.
  const minted = mintSessionAndRedirect(deps.db, req, user, next);
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  for (const cookie of minted.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return new Response(
    JSON.stringify({ ok: true, redirect: minted.headers.get("location") ?? next }),
    { status: 200, headers },
  );
}

type BindingResult = { ok: true; origin: string } | { ok: false; res: Response };

type BindingTagName = "u" | "method" | "challenge";

/**
 * Return the first security-critical binding tag that appears more than once.
 * `tagValue` is first-wins for general Nostr use, but a tag that decides who
 * gets a session must have one unambiguous reading — a verifier that took the
 * first `u` and a proxy that took the last would disagree about what was
 * signed.
 */
function duplicateBindingTag(event: NostrEvent): BindingTagName | null {
  const seen = new Set<BindingTagName>();
  for (const tag of event.tags) {
    const name = tag[0];
    if (name !== "u" && name !== "method" && name !== "challenge") continue;
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return null;
}

/**
 * Kind / freshness / endpoint-binding checks. On success it hands back the
 * origin the `u` tag named — validated against `hubBoundOrigins` — so the
 * caller builds the sign-in statement against the SAME origin the signature is
 * bound to, rather than a second, independently-derived one. Every failure
 * collapses to `invalid_event`, on purpose: the granular reason is in
 * `error_description` for a human, and the code is one bucket so a prober
 * learns nothing from the shape.
 */
function checkBinding(event: NostrEvent, deps: NostrLoginDeps, now: Date): BindingResult {
  const generic = (why: string): BindingResult => ({
    ok: false,
    res: jsonError(400, "invalid_event", why),
  });

  const duplicate = duplicateBindingTag(event);
  if (duplicate !== null) {
    return generic(`event must carry exactly one \`${duplicate}\` tag`);
  }

  if (event.kind !== NOSTR_AUTH_KIND) {
    return generic(`event kind must be ${NOSTR_AUTH_KIND}`);
  }

  const skew = Math.abs(Math.floor(now.getTime() / 1000) - event.created_at);
  if (skew > NOSTR_LOGIN_MAX_CREATED_AT_SKEW_SECONDS) {
    return generic(
      `event created_at must be within ${NOSTR_LOGIN_MAX_CREATED_AT_SKEW_SECONDS}s of the hub's clock`,
    );
  }

  // Case-SENSITIVE against the canonical spelling the template hands out. This
  // is a binding token, not an HTTP method being dispatched on — accepting
  // "post" would widen what a harvested signature could match for no benefit.
  if (tagValue(event, "method") !== "POST") {
    return generic("event must carry a `method` tag of POST");
  }

  const u = tagValue(event, "u");
  if (u === null) return generic("event must carry a `u` tag naming this hub's verify endpoint");
  let parsedU: URL;
  try {
    parsedU = new URL(u);
  } catch {
    return generic("event `u` tag must be an absolute URL");
  }
  if (parsedU.pathname !== NOSTR_LOGIN_VERIFY_PATH) {
    return generic(`event \`u\` tag must name ${NOSTR_LOGIN_VERIFY_PATH}`);
  }
  const bound = deps.hubBoundOrigins;
  if (bound !== undefined && bound.length > 0 && !bound.includes(parsedU.origin)) {
    return generic("event `u` tag names an origin this hub does not answer on");
  }
  return { ok: true, origin: parsedU.origin };
}
