/**
 * `/api/account/pubkeys*` — the Nostr-pubkey linkage ceremony (hub#833
 * phase 1a; team-vault design "2026-08-22 Multi-user Parachute — draft for
 * reaction" §3). Mounted under the existing `/api/account/*` self-service
 * surface (`api-account-2fa.ts` routes here), so it inherits that file's
 * posture verbatim:
 *
 *   1. session cookie (else 401) — identity comes from `session.userId`,
 *      NEVER from a request body. There is no client-supplied user id
 *      anywhere on this surface, so there is no cross-account write path.
 *   2. CSRF double-submit `__csrf` on every mutation (else 403).
 *   3. same-origin belt, applied by the hub-server dispatcher before we run.
 *   4. per-action validation.
 *
 * Routes (`subpath` is relative to `/api/account/pubkeys`):
 *
 *   GET  ""           → the caller's own linked keys
 *   POST "/challenge" → mint a single-use challenge + the event template
 *   POST "/verify"    → present a signed NIP-01 event; link on success
 *   POST "/unlink"    → drop one of the caller's own links
 *
 * ## The ceremony
 *
 * `/challenge` returns 32 bytes of CSPRNG entropy plus the exact event the
 * client must sign — a NIP-98-shaped kind-27235 event whose `content` is a
 * legible statement (see `linkageStatement`) and which carries three tags:
 *
 *   ["u",         "<this hub>/api/account/pubkeys/verify"]
 *   ["method",    "POST"]
 *   ["challenge", "<the value just issued>"]
 *
 * `/verify` then requires ALL of:
 *
 *   - a well-shaped, bounded NIP-01 event (`nostr-event.ts` — every field
 *     type- and length-checked before any hashing or curve math)
 *   - `kind === 27235`
 *   - `created_at` within ±5 minutes of the hub's clock
 *   - the `u` tag naming an origin this hub answers on AND the verify path
 *   - the `method` tag exactly `POST`
 *   - `content` exactly the linkage statement for THIS session's account and
 *     that origin
 *   - a recomputed NIP-01 id matching the claimed `id`
 *   - a BIP-340 Schnorr signature over that id verifying against the claimed
 *     x-only pubkey
 *   - a challenge that exists, belongs to THIS user, is unconsumed, and is
 *     unexpired — consumed atomically with the link write
 *
 * Four independent defenses stack here. Against REPLAY: the server-issued
 * single-use challenge (primary), the `created_at` window, and the `u`/`method`
 * binding that stops a NIP-98 signature harvested for another service — or
 * another hub — from being replayed at this one. Against a CONFUSED DEPUTY
 * (getting a victim to sign the attacker's challenge, so the victim's key
 * lands on the attacker's account): the statement in `content`, which names
 * the account being linked in words a signer can show a human.
 *
 * ## Hub-local, no relay
 *
 * Nothing here talks to a nostr relay, resolves NIP-05, or fetches a profile.
 * The hub only ever verifies a signature it was handed. That is the entire
 * network surface: none.
 *
 * ## What a linked key grants
 *
 * Nothing. No scope, no claim, no authentication path. A linked key is an
 * attribution label; `sub` remains the only principal the hub authorizes on.
 * See `pubkey-links.ts` and migration v17.
 */
import type { Database } from "bun:sqlite";
import {
  NOSTR_AUTH_KIND,
  type NostrEvent,
  nostrEventId,
  parseNostrEvent,
  tagValue,
  verifyNostrEvent,
} from "./nostr-event.ts";
import {
  type LinkedPubkey,
  issuePubkeyChallenge,
  linkPubkey,
  listUserPubkeys,
  purgeExpiredChallenges,
  unlinkPubkey,
} from "./pubkey-links.ts";
import {
  changePasswordRateLimiter,
  pubkeyChallengeRateLimiter,
  pubkeyVerifyRateLimiter,
} from "./rate-limit.ts";
import { PASSWORD_MAX_LEN, getUserById, validateUsername, verifyPassword } from "./users.ts";

/** Path the signed event's `u` tag must name. Also where this surface mounts. */
export const PUBKEY_VERIFY_PATH = "/api/account/pubkeys/verify";

/**
 * Accepted clock skew on the event's `created_at`, in seconds. NIP-98 suggests
 * ~60s; we allow 5 minutes because a self-hosted box's clock and a phone-based
 * signer's clock drift more than a datacenter's, and the single-use challenge
 * — not this window — is what actually prevents replay. Applied in BOTH
 * directions: a far-future timestamp is as suspect as a stale one.
 */
export const VERIFY_MAX_CREATED_AT_SKEW_SECONDS = 300;

/** Max length of the optional human label on a linked key. */
export const MAX_PUBKEY_LABEL_LEN = 64;

/**
 * The human-readable statement the signed event's `content` must carry.
 *
 * ## Why an opaque challenge alone is not enough
 *
 * A single-use challenge stops REPLAY, but it does not stop a CONFUSED DEPUTY.
 * Consider Mallory, who holds a hub account but no key: she calls `/challenge`
 * with her own session, gets an opaque 64-hex string, and puts it in front of a
 * victim in some unrelated "sign this to continue" prompt. A NIP-07 browser
 * signer will happily sign an arbitrary event. If the only thing under the
 * signature were a random hex blob, the victim could not tell what they were
 * agreeing to — and Mallory would submit the result with her own session and
 * end up with the victim's key linked to HER account. Attribution would then
 * resolve every one of Mallory's writes to the victim's npub, which is exactly
 * the property this feature exists to provide.
 *
 * So the ceremony puts a legible sentence under the signature, naming the
 * account and the hub the key is being bound to. This is the Sign-In-with-X
 * discipline (EIP-4361's "statement"): the bytes a human is asked to sign have
 * to say what signing them means. `/verify` recomputes the statement from the
 * SESSION's user — never from anything in the request — and requires an exact
 * match, so a signature produced against a statement naming Mallory cannot be
 * accepted as one naming the victim, and vice versa.
 *
 * The honest limit: this is a LEGIBILITY defense, not a cryptographic one. It
 * works because the victim's signer shows them the content before they approve.
 * A victim who blind-signs is still phishable, and no hub-side check can fix
 * that. It converts an invisible attack into a visible one.
 *
 * The origin is the one named by the event's own `u` tag, which `checkBinding`
 * has already required to be an origin this hub answers on — so the statement
 * and the endpoint binding can never disagree.
 *
 * ## Why the username is escaped and refused (hub#833 HIGH-1)
 *
 * The account name is the ONLY untrusted-charset value in the statement, and a
 * legibility defense whose text an attacker can shape is no defense. Two things
 * make the sentence un-forgeable regardless of what reached `users.username`:
 *
 *   - The account sits ALONE on its own line, and its value is
 *     `JSON.stringify`'d (quoted + escaped) rather than bare-interpolated into
 *     a quoted slot. A crafted username can neither break out of the quotes nor
 *     smuggle a trailing clause that reads as naming a DIFFERENT account, and a
 *     signer pane that truncates cannot hide the `Account:` prefix and leave a
 *     forged tail behind.
 *   - We REFUSE to build the statement at all when `validateUsername` rejects
 *     the name. `createUser` now runs the validator (hub#864), so new writes
 *     cannot land a hostile username. Existing rows (and a seeded first-user
 *     `admin`) are grandfathered and still cannot run the ceremony
 *     (`username_unlinkable`) until renamed. The ceremony must not trust that
 *     the row was gated: an account whose username the validator rejects
 *     simply cannot run it.
 *
 * @throws if `validateUsername(username)` fails — callers on this surface guard
 * with the same check first and return `username_unlinkable`, so this throw is
 * the last-line invariant, never a live 500 path.
 */
export function linkageStatement(origin: string, username: string): string {
  const check = validateUsername(username);
  if (!check.valid) {
    throw new Error(
      `refusing to build a linkage statement for a username validateUsername rejects (${check.reason})`,
    );
  }
  // EIP-4361 / SIWE shape: one legible sentence, the bound account isolated on
  // its own line, its value JSON-encoded. `validateUsername` (and createUser)
  // pin the charset to [a-z0-9_-] for new writes; the encoding is still
  // defense-in-depth for grandfathered rows that reached the DB before #864.
  return [
    `${origin} asks you to link a Nostr key to a Parachute account.`,
    "",
    `Account: ${JSON.stringify(username)}`,
    "",
    "Signing binds the Nostr public key in this event to the account named above, on this hub. Do not sign if that account is not yours.",
  ].join("\n");
}

/**
 * Guard reused by `/challenge` and `/verify`: an account whose username the
 * validator rejects cannot run the ceremony, because `linkageStatement` (its
 * only legibility anchor) would refuse to build for it. Returns a clean 400
 * rather than letting `linkageStatement` throw into a 500. See HIGH-1 above.
 */
function unlinkableUsername(username: string): Response | null {
  if (validateUsername(username).valid) return null;
  return jsonError(
    400,
    "username_unlinkable",
    "this account's username cannot be used in the linkage ceremony — an operator must rename it to a valid username first",
  );
}

/** Lowercase hex, 64 chars — the NIP-01 canonical x-only pubkey spelling. */
const PUBKEY_RE = /^[0-9a-f]{64}$/;

/**
 * Labels are echoed back to the caller and will be rendered by a UI, so they
 * are restricted to printable, single-line text. Control characters (including
 * newlines, and the C1 range) are refused rather than stripped — silently
 * mutating what the user typed is worse than telling them no.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const LABEL_FORBIDDEN_RE = /[\u0000-\u001f\u007f-\u009f]/;

export interface AccountPubkeysDeps {
  db: Database;
  /**
   * Origins this hub legitimately answers on (`buildHubBoundOrigins`). The
   * signed event's `u` tag must name one of them. Wired in production by
   * `hub-server.ts`; when ABSENT (the unit-test shape, mirroring
   * `ApiMintTokenDeps.knownVaultNames`) only the PATH component of `u` is
   * checked. The origin binding is defense-in-depth against cross-service
   * signature reuse — the server-issued, user-bound, single-use challenge is
   * the primary replay defense and is unconditional.
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

function linkWire(link: LinkedPubkey): Record<string, unknown> {
  // Deliberately does NOT include `proof_event` (bulky, and a self-service
  // list has no use for it) or `user_id` (the caller IS the user; echoing it
  // back adds an id to a response for no reason).
  return {
    pubkey: link.pubkey,
    label: link.label,
    proof_event_id: link.proofEventId,
    linked_at: link.linkedAt,
    last_verified_at: link.lastVerifiedAt,
  };
}

/**
 * The signed-in principal, as established from the session by the caller.
 * `username` is needed only to build and re-check the linkage statement.
 * Nothing on this surface accepts a client-supplied identity.
 */
export interface PubkeyCeremonyUser {
  id: string;
  username: string;
}

/**
 * Router. `subpath` is relative to `/api/account/pubkeys` ("" for the
 * collection). The caller (`handleApiAccount`) has already established the
 * session and, for POSTs, the CSRF token.
 */
export async function handleAccountPubkeys(
  req: Request,
  subpath: string,
  user: PubkeyCeremonyUser,
  body: Record<string, unknown>,
  deps: AccountPubkeysDeps,
): Promise<Response> {
  const now = deps.now ?? (() => new Date());

  if (req.method === "GET") {
    if (subpath !== "") return jsonError(404, "not_found", "no route at that path");
    return json(200, { pubkeys: listUserPubkeys(deps.db, user.id).map(linkWire) });
  }
  if (req.method !== "POST") {
    return jsonError(405, "method_not_allowed", "use GET or POST");
  }

  switch (subpath) {
    case "/challenge":
      return handleChallenge(req, user, deps, now);
    case "/verify":
      return handleVerify(req, user, body, deps, now);
    case "/unlink":
      return handleUnlink(user.id, body, deps);
    default:
      return jsonError(404, "not_found", `no route at /api/account/pubkeys${subpath}`);
  }
}

/**
 * POST /challenge — issue a single-use, user-bound, TTL-bounded challenge and
 * return the exact event the client must sign. Returning the template (rather
 * than documenting it) means the client never has to reconstruct the `u` tag
 * from its own notion of the hub's URL, which is the field most likely to be
 * got wrong on a multi-origin box.
 */
function handleChallenge(
  req: Request,
  user: PubkeyCeremonyUser,
  deps: AccountPubkeysDeps,
  now: () => Date,
): Response {
  // HIGH-1: never hand out a template whose statement we could not later
  // recompute and exact-match — refuse before issuing (and burning) a
  // challenge that could never be verified.
  const unlinkable = unlinkableUsername(user.username);
  if (unlinkable) return unlinkable;

  const gate = pubkeyChallengeRateLimiter.checkAndRecord(user.id, now());
  if (!gate.allowed) return tooManyAttempts(gate.retryAfterSeconds ?? 1);

  // Opportunistic housekeeping — expired rows are already unusable; this only
  // stops the table growing. Cheap indexed DELETE on an already-write path.
  purgeExpiredChallenges(deps.db, now());

  const issued = issuePubkeyChallenge(deps.db, user.id, now());
  const origin = requestOrigin(req);
  return json(200, {
    challenge: issued.challenge,
    expires_at: issued.expiresAt,
    event_template: {
      kind: NOSTR_AUTH_KIND,
      // The legible statement — see `linkageStatement`. A signer that shows
      // the user what they are about to sign shows them this sentence.
      content: linkageStatement(origin, user.username),
      tags: [
        ["u", `${origin}${PUBKEY_VERIFY_PATH}`],
        ["method", "POST"],
        ["challenge", issued.challenge],
      ],
    },
  });
}

/**
 * The origin to advertise in the event template. Taken from the request URL —
 * i.e. the origin the client actually reached us on, which is the one their
 * next request will use too. This is only ever used to BUILD a template; the
 * `u` tag presented at `/verify` is validated against `hubBoundOrigins`, not
 * against this.
 */
function requestOrigin(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

/**
 * POST /verify {event, label?} — the proof step.
 *
 * Order is load-bearing and cheap-to-expensive:
 *
 *   0. username linkability (HIGH-1 — refuse an account whose username the
 *      validator rejects before touching the request at all)
 *   1. label validation (pure string check — reject before anything else so a
 *      bad label can't burn a challenge)
 *   2. event shape + bounds (`parseNostrEvent`; no hashing yet)
 *   3. kind / created_at / `u` / `method` / challenge-tag presence — all pure
 *   4. the legible statement in `content` (see `linkageStatement`), recomputed
 *      from the SESSION's user and the `u` tag's already-validated origin
 *   5. rate limit (before any curve math)
 *   6. NIP-01 id recomputation, then BIP-340 verification
 *   6b. first-link password step-up (HIGH-2 — only when the account has zero
 *      linked keys; reuses the `/2fa/disable` password + rate-limit posture)
 *   7. challenge consumption + link write, atomically
 *
 * Nothing before step 7 writes to the database, so every rejection above
 * leaves the user's challenge spendable. Step 7's own failures are covered in
 * `linkPubkey`'s docstring (a challenge that validated there stays consumed).
 */
async function handleVerify(
  req: Request,
  user: PubkeyCeremonyUser,
  body: Record<string, unknown>,
  deps: AccountPubkeysDeps,
  now: () => Date,
): Promise<Response> {
  // 0. HIGH-1: refuse the ceremony for an account whose username the validator
  //    rejects (see `linkageStatement` / `unlinkableUsername`). Runs first so a
  //    hostile username that reached the DB through an ungated write path can
  //    neither be matched against a forged statement nor 500 the handler.
  const unlinkable = unlinkableUsername(user.username);
  if (unlinkable) return unlinkable;

  // 1. Label.
  let label: string | null = null;
  if (body.label !== undefined && body.label !== null) {
    if (
      typeof body.label !== "string" ||
      body.label.length > MAX_PUBKEY_LABEL_LEN ||
      LABEL_FORBIDDEN_RE.test(body.label)
    ) {
      return jsonError(
        400,
        "invalid_label",
        `label must be printable single-line text of at most ${MAX_PUBKEY_LABEL_LEN} characters`,
      );
    }
    label = body.label;
  }

  // 2. Event shape. One generic error for every shape failure — the granular
  //    reason is a debugging nicety with no wire value and a small
  //    fingerprinting cost.
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
  const binding = checkBinding(event, req, deps, now());
  if (!binding.ok) return binding.res;
  const challenge = tagValue(event, "challenge");
  if (challenge === null || challenge.length === 0) {
    return jsonError(400, "invalid_event", "event must carry a `challenge` tag");
  }

  // 4. The legible statement. Recomputed from the SESSION's username and the
  //    origin the event's own (already origin-validated) `u` tag names — never
  //    from anything else in the body. A signature produced against a
  //    statement naming a DIFFERENT account cannot be presented here, which is
  //    what stops the confused-deputy link described on `linkageStatement`.
  const expectedStatement = linkageStatement(binding.origin, user.username);
  if (event.content !== expectedStatement) {
    return jsonError(
      400,
      "invalid_event",
      "event content must be the linkage statement this hub issued for this account — request a fresh challenge and sign its `content` verbatim",
    );
  }

  // 5. Rate limit before the elliptic-curve work.
  const gate = pubkeyVerifyRateLimiter.checkAndRecord(user.id, now());
  if (!gate.allowed) return tooManyAttempts(gate.retryAfterSeconds ?? 1);

  // 6. Proof of possession. `id_mismatch` and `bad_signature` collapse into
  //    one response: both mean "this event does not prove you hold that key,"
  //    and telling an attacker which of the two failed is free information.
  const verified = verifyNostrEvent(event);
  if (!verified.ok) {
    return jsonError(
      401,
      "proof_failed",
      "the event's signature does not prove possession of the claimed pubkey",
    );
  }

  // 6b. First-link step-up (hub#833 HIGH-2). Linking the FIRST key to an
  //     account is a consequential, durable state change: every later write by
  //     that user can resolve to this key, and once linked it becomes the
  //     oldest-wins primary. A session cookie alone must not authorize that —
  //     a hijacked session could otherwise bind an ATTACKER-held key to a
  //     victim who has no key yet, poisoning attribution with no prior consent.
  //     So the FIRST link re-confirms the current password, the same step-up
  //     `/2fa/disable` and `/password` require, reusing the same argon2id rate-
  //     limit bucket. Subsequent links do NOT: the user has already proved
  //     possession of a key on this account, oldest-wins keeps the primary
  //     stable, and a later link can neither displace it nor forge a new
  //     primary. Placed AFTER proof-of-possession so a hijacked session with no
  //     valid signed event never reaches the argon2id verify, and BEFORE the
  //     commit so a wrong password never consumes the challenge.
  if (listUserPubkeys(deps.db, user.id).length === 0) {
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) {
      return jsonError(
        401,
        "password_required",
        "Re-enter your current password to link your first key to this account.",
      );
    }
    if (password.length > PASSWORD_MAX_LEN) {
      return jsonError(
        413,
        "password_too_long",
        `Password must be ≤ ${PASSWORD_MAX_LEN} characters.`,
      );
    }
    // Rate-limit before argon2id — a stolen session must not get an unbounded
    // grind window (shares the `/password` + `/2fa/disable` bucket).
    const pwGate = changePasswordRateLimiter.checkAndRecord(user.id, now());
    if (!pwGate.allowed) return tooManyAttempts(pwGate.retryAfterSeconds ?? 1);
    const fullUser = getUserById(deps.db, user.id);
    if (fullUser === null || !(await verifyPassword(fullUser, password))) {
      return jsonError(401, "invalid_credentials", "That password is incorrect.");
    }
  }

  // 7. Commit.
  const result = linkPubkey(deps.db, {
    userId: user.id,
    pubkey: event.pubkey,
    challenge,
    proofEvent: JSON.stringify(event),
    proofEventId: nostrEventId(event),
    label,
    now: now(),
  });
  if (!result.ok) {
    switch (result.reason) {
      case "challenge_invalid":
        // One message for "never existed" / "already spent" / "expired" /
        // "belongs to someone else" — distinguishing them would be an oracle.
        return jsonError(
          400,
          "challenge_invalid",
          "challenge is unknown, already used, or expired — request a fresh one",
        );
      case "pubkey_taken":
        // Says THAT the key is spoken for, never BY WHOM. The caller proved
        // possession, so learning the key is in use is not a leak; learning
        // which account holds it would be.
        return jsonError(
          409,
          "pubkey_taken",
          "that public key is already linked to an account on this hub",
        );
      case "too_many_pubkeys":
        return jsonError(409, "too_many_pubkeys", "this account has reached its linked-key limit");
    }
  }

  return json(200, { linked: true, relinked: result.relinked, ...linkWire(result.link) });
}

/**
 * Kind / freshness / endpoint-binding checks. On success it hands back the
 * origin the `u` tag named — validated against `hubBoundOrigins` — so the
 * caller can build the linkage statement against the SAME origin the signature
 * is bound to, rather than a second, independently-derived one. Every failure
 * collapses to the same `invalid_event` body as the shape check above, on
 * purpose.
 */
type BindingResult = { ok: true; origin: string } | { ok: false; res: Response };

function checkBinding(
  event: NostrEvent,
  req: Request,
  deps: AccountPubkeysDeps,
  now: Date,
): BindingResult {
  const generic = (why: string): BindingResult => ({
    ok: false,
    res: jsonError(400, "invalid_event", why),
  });

  if (event.kind !== NOSTR_AUTH_KIND) {
    return generic(`event kind must be ${NOSTR_AUTH_KIND}`);
  }

  const skew = Math.abs(Math.floor(now.getTime() / 1000) - event.created_at);
  if (skew > VERIFY_MAX_CREATED_AT_SKEW_SECONDS) {
    return generic(
      `event created_at must be within ${VERIFY_MAX_CREATED_AT_SKEW_SECONDS}s of the hub's clock`,
    );
  }

  // `method` is compared case-SENSITIVELY against the canonical spelling the
  // template hands out. This is a binding token, not an HTTP method being
  // dispatched on — accepting "post" would widen what a harvested signature
  // could match for no benefit.
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
  if (parsedU.pathname !== PUBKEY_VERIFY_PATH) {
    return generic(`event \`u\` tag must name ${PUBKEY_VERIFY_PATH}`);
  }
  const bound = deps.hubBoundOrigins;
  if (bound !== undefined && bound.length > 0 && !bound.includes(parsedU.origin)) {
    return generic("event `u` tag names an origin this hub does not answer on");
  }
  // `req` is unused because the `u`-origin binding is deliberately checked
  // against a NON-REQUEST-SOURCED origin set, never the incoming request's
  // Host. This matters more here than for the OAuth same-origin checks: this
  // ceremony writes a DURABLE proof, and `resolveIssuer` falls back to the
  // request's own (Host-derived) origin when no hub_origin / PARACHUTE_ISSUER /
  // expose-state is configured (plain `parachute serve` before `expose`). A
  // Host-derived origin is attacker-influenceable and must not anchor a stored
  // proof, so the wiring (`linkageBoundOrigins` in hub-server.ts, keyed off
  // `resolveIssuerSource`) drops the request-sourced issuer from the set it
  // passes as `deps.hubBoundOrigins` — leaving only loopback / expose /
  // platform origins. The origin handed back is thus one the hub can vouch for
  // independently of this request, and it is the one the SIGNATURE covers.
  // (MEDIUM-1: this closes the gap the earlier "checked against the hub's own
  // origin set rather than the incoming Host" claim skipped over.)
  void req;
  return { ok: true, origin: parsedU.origin };
}

/**
 * POST /unlink {pubkey} — drop one of the caller's own links.
 *
 * Self-only: `unlinkPubkey`'s DELETE carries the `user_id` predicate, so a
 * pubkey belonging to another account is a no-op. The response is the SAME
 * shape (`200 {unlinked: false}`) for "you had no such link" and "someone else
 * holds that key" — a 404-vs-403 split would tell any signed-in user whether
 * an arbitrary key is linked on this hub.
 *
 * **Unlink does not rewrite history.** `tokens.subject_pubkey` rows already
 * written keep naming the key, because an audit row records what was true at
 * mint time. And unlink does NOT revoke tokens: in phase 1 a linked key
 * carries no authority, so there is nothing minted under it to revoke. A later
 * phase that DOES grant authority from a key must revisit that — flagged here
 * rather than buried.
 */
function handleUnlink(
  userId: string,
  body: Record<string, unknown>,
  deps: AccountPubkeysDeps,
): Response {
  const pubkey = body.pubkey;
  if (typeof pubkey !== "string" || !PUBKEY_RE.test(pubkey)) {
    return jsonError(
      400,
      "invalid_pubkey",
      "pubkey must be a 64-character lowercase-hex x-only public key",
    );
  }
  return json(200, { unlinked: unlinkPubkey(deps.db, userId, pubkey) });
}
