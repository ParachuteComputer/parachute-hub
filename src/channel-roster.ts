/**
 * Channel roster fetcher — the read half of channel-attached vaults (design
 * "Channel-attached vaults — membership becomes access", §2 (a); build plan
 * row 4).
 *
 * Answers exactly one question: **who is currently in this Buzz channel, and
 * with what role, according to the relay itself?** It does not grant anything.
 * Turning a roster into `user_vaults` rows is the reconciler's job (PR 5) and
 * lives in a separate module on purpose — this one has no authority, so it can
 * be reviewed as a parser plus two HTTP calls.
 *
 * ## What the relay gives us
 *
 * Buzz publishes a NIP-29 **kind 39002** member list per channel, signed by
 * the relay's own keypair, with one `["p", <pubkey>, "", <role>]` tag per
 * member (`buzz-relay/src/handlers/side_effects.rs`, `group_members_tags`).
 * It is re-emitted on every membership change. That event is an offline-
 * verifiable attestation by the relay: if the signature checks out against a
 * key we already trust, the roster is what the relay says it is, and no
 * intermediary — including whoever served us the HTTP response — can have
 * edited it.
 *
 * The event is stored channel-scoped, so reading it needs an authenticated
 * pubkey that can reach the channel. Hence `POST /query` with NIP-98, signed
 * with the hub's Buzz reader key (`buzz-reader-key.ts`).
 *
 * ## Trust-on-first-use, and why the mismatch is fatal
 *
 * "Verify against the relay's key" begs the question of which key. The relay
 * advertises it as the NIP-11 `self` field (`buzz-relay/src/nip11.rs`), which
 * we fetch over the same connection we are already trusting for the roster —
 * so on the FIRST fetch, NIP-11 buys us nothing an attacker in that position
 * could not forge. What it buys is everything AFTER the first fetch: the key
 * is pinned into `channel_vaults.relay_self_pubkey`, and a later `self` that
 * differs is `relay_key_changed` — refused, not re-pinned. An attacker who
 * gets one poll cannot convert it into a standing ability to author rosters.
 *
 * The pin is written only after a roster event has actually verified against
 * the advertised key, so a relay that answers NIP-11 but has no roster to
 * show cannot burn the one-time pin.
 *
 * ## Never throws for a remote failure
 *
 * Every outcome is a value. A relay that is down, slow, unauthorized, or
 * lying produces `{ok:false, reason}`; the binding row is left exactly as it
 * was, which is what makes the design's "relay unreachable → freeze, don't
 * drop" answer implementable one layer up. The only exceptions that escape
 * are programmer errors (a bad argument), never network or parse failures.
 */
import type { Database } from "bun:sqlite";
import { loadBuzzReaderKey } from "./buzz-reader-key.ts";
import { getChannelVault, pinRelaySelfPubkey } from "./channel-vaults.ts";
import { type NostrEvent, parseNostrEvent, verifyNostrEvent } from "./nostr-event.ts";
import { nip98AuthHeader } from "./nostr-http-sign.ts";

/** NIP-29 group-members kind. Buzz signs these with the relay keypair. */
export const KIND_GROUP_MEMBERS = 39002;

/**
 * Buzz's `MemberRole` (`buzz-core/src/channel.rs`). `bot` sits outside the
 * hierarchy at permission level 0 rather than below `guest`, which is why
 * this is a set and not an ordered ladder.
 */
export const ROSTER_ROLES = ["owner", "admin", "member", "guest", "bot"] as const;
export type RosterRole = (typeof ROSTER_ROLES)[number];

export function isRosterRole(value: string): value is RosterRole {
  return (ROSTER_ROLES as readonly string[]).includes(value);
}

export interface RosterEntry {
  /** 64-char lowercase hex x-only pubkey. */
  pubkey: string;
  role: RosterRole;
}

/**
 * Bound on the size of a roster event we are willing to hash and verify. A
 * channel with 2000 members is already far outside anything Buzz runs; the
 * number exists so a hostile response cannot make us sha256 an unbounded
 * array. `parseNostrEvent`'s default of 20 tags is sized for a three-tag
 * auth event and would reject any real channel.
 */
export const MAX_ROSTER_TAGS = 2048;

/**
 * Why a fetch produced no roster.
 *
 *   - `not_configured` — no Buzz reader key on this hub. The ordinary state
 *     of a hub that has not opted in; not an error.
 *   - `key_unreadable` — a key file exists but could not be loaded. Distinct
 *     from `not_configured` so an operator typo is visible as a typo.
 *   - `not_bound` — no `channel_vaults` row for this (relay, channel).
 *   - `relay_unreachable` — DNS, TCP, TLS, timeout, or a non-JSON response.
 *   - `relay_rejected` — the relay answered with a non-2xx status. Usually
 *     "the reader key is not seated in this community/channel", which is an
 *     operator problem, not an outage — worth its own reason so `frozen`
 *     doesn't get blamed on the network.
 *   - `relay_self_unknown` — NIP-11 carried no usable `self` pubkey, so
 *     there is nothing to verify against.
 *   - `relay_key_changed` — NIP-11 `self` differs from the pinned value.
 *     Refused; see the module header.
 *   - `no_roster` — the relay answered but returned no 39002 for this
 *     channel.
 *   - `bad_signature` — a 39002 was returned but is not validly signed by
 *     the relay's `self` key (wrong signer, forged id, or bad sig).
 */
export type RosterFailure =
  | "not_configured"
  | "key_unreadable"
  | "not_bound"
  | "relay_unreachable"
  | "relay_rejected"
  | "relay_self_unknown"
  | "relay_key_changed"
  | "no_roster"
  | "bad_signature";

export interface RosterSuccess {
  ok: true;
  roster: RosterEntry[];
  /** `created_at` of the 39002 the roster came from. Unix SECONDS. */
  eventCreatedAt: number;
  /** The relay `self` key the event verified against (pinned or advertised). */
  relaySelfPubkey: string;
  /** True when THIS call performed the trust-on-first-use pin. */
  pinned: boolean;
  /** `p` tags dropped for an unknown role or a malformed pubkey. */
  skipped: number;
}

export interface RosterFetchFailure {
  ok: false;
  reason: RosterFailure;
  /**
   * Operator-facing context. Never carries secret material and never carries
   * the relay's response body — only a status code or a short shape note.
   */
  detail?: string;
}

export type FetchChannelRosterResult = RosterSuccess | RosterFetchFailure;

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Parse `["p", <pubkey>, <relay>, <role>]` tags into typed entries.
 *
 * Pure, exported for tests and for the reconciler's fixtures. Rules, all of
 * them "drop the entry, keep the roster":
 *
 *   - A role outside {@link ROSTER_ROLES} is skipped and counted. Buzz could
 *     add a role tomorrow; a hub that refused the whole roster over one
 *     unknown word would drop every member's access on a Buzz upgrade, which
 *     is a far worse failure than not granting one new-role member.
 *   - A missing role, or a pubkey that is not 64 lowercase hex, is likewise
 *     skipped and counted. (Not normalized: `nostr-event.ts` and
 *     `pubkey-links.ts` both refuse to case-fold a key, because two
 *     spellings become two rows.)
 *   - A duplicate pubkey keeps its FIRST entry, matching `tagValue`'s
 *     first-wins convention. The whole tag array is covered by the relay's
 *     signature, so a duplicate can only have come from the relay.
 *   - Non-`p` tags (notably `d`) are ignored, not counted.
 */
export function parseRosterTags(tags: readonly (readonly string[])[]): {
  roster: RosterEntry[];
  skipped: number;
} {
  const roster: RosterEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const tag of tags) {
    if (tag[0] !== "p") continue;
    const pubkey = tag[1];
    const role = tag[3];
    if (typeof pubkey !== "string" || !HEX64.test(pubkey)) {
      skipped++;
      continue;
    }
    if (typeof role !== "string" || !isRosterRole(role)) {
      skipped++;
      continue;
    }
    if (seen.has(pubkey)) continue;
    seen.add(pubkey);
    roster.push({ pubkey, role });
  }
  return { roster, skipped };
}

/**
 * A `fetch`-shaped function. Narrower than `typeof fetch` on purpose: Bun's
 * global carries extras (`preconnect`) that a test double has no business
 * implementing, and this module only ever calls it as a function.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Injectable seams. Defaults are the real network. */
export interface RosterFetchOptions {
  fetchImpl?: FetchLike;
  /**
   * Origin to address a relay host at. Defaults to `https://<host>` — the
   * scheme Buzz assumes when it builds the URL it expects the NIP-98 `u` tag
   * to equal. Overridden only by tests pointing at a loopback fake.
   */
  originFor?: (relayHost: string) => string;
  /** Per-request timeout, milliseconds. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  /** Unix SECONDS for the NIP-98 events. Injectable for determinism. */
  nowSeconds?: () => number;
}

/** Default per-request timeout. Two of these run per poll, worst case. */
export const DEFAULT_ROSTER_TIMEOUT_MS = 10_000;

function originFor(relayHost: string, opts: RosterFetchOptions): string {
  return opts.originFor ? opts.originFor(relayHost) : `https://${relayHost}`;
}

/**
 * Fetch the relay's NIP-11 document and return its `self` pubkey.
 *
 * `GET <origin>/` with `Accept: application/nostr+json`. Exported because a
 * `doctor`-style check (not this PR) wants exactly this and nothing else.
 */
export async function fetchRelaySelfPubkey(
  relayHost: string,
  opts: RosterFetchOptions = {},
): Promise<{ ok: true; pubkey: string } | RosterFetchFailure> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${originFor(relayHost, opts)}/`;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/nostr+json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_ROSTER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "relay_unreachable", detail: "NIP-11 request failed" };
  }
  if (!res.ok) {
    return { ok: false, reason: "relay_rejected", detail: `NIP-11 status ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "relay_unreachable", detail: "NIP-11 body is not JSON" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "relay_self_unknown", detail: "NIP-11 body is not an object" };
  }
  const self = (body as Record<string, unknown>).self;
  // Lowercase hex only, same rule as everywhere else a pubkey enters the hub.
  if (typeof self !== "string" || !HEX64.test(self)) {
    return { ok: false, reason: "relay_self_unknown", detail: "NIP-11 has no usable self pubkey" };
  }
  return { ok: true, pubkey: self };
}

/**
 * Fetch the raw 39002 events for one channel over the NIP-98 REST bridge.
 *
 * Body is a NIP-01 filter ARRAY — `[{kinds:[39002],"#d":[<channel>]}]` — which
 * is what `POST /query` deserializes (`buzz-relay/src/api/bridge.rs`,
 * `query_events_authed`). The response is a JSON array of events.
 *
 * The `#d` filter is what makes this a per-channel query: 39002 is an
 * addressable event whose `d` tag is the channel uuid. The relay ALSO filters
 * results to channels the authenticated pubkey can reach, so an unseated
 * reader key gets an empty array rather than somebody else's roster.
 */
async function fetchRosterEvents(
  relayHost: string,
  channelId: string,
  secretKeyHex: string,
  opts: RosterFetchOptions,
): Promise<{ ok: true; events: unknown[] } | RosterFetchFailure> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${originFor(relayHost, opts)}/query`;
  const filters = [{ kinds: [KIND_GROUP_MEMBERS], "#d": [channelId] }];
  const body = new TextEncoder().encode(JSON.stringify(filters));
  const authorization = nip98AuthHeader({
    secretKeyHex,
    url,
    method: "POST",
    body,
    createdAt: opts.nowSeconds?.(),
  });
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_ROSTER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "relay_unreachable", detail: "query request failed" };
  }
  if (!res.ok) {
    // 401/403 here almost always means "this key is not seated in the
    // community or the channel". Status only — the body can echo request
    // material we signed.
    return { ok: false, reason: "relay_rejected", detail: `query status ${res.status}` };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { ok: false, reason: "relay_unreachable", detail: "query body is not JSON" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "relay_unreachable", detail: "query body is not an array" };
  }
  return { ok: true, events: parsed };
}

/**
 * Pick the newest well-formed 39002 for `channelId` out of a relay response.
 *
 * Newest-wins because 39002 is addressable: the relay replaces it on every
 * membership change, and a response that somehow carries two is a stale copy
 * plus a current one. The `d` tag is re-checked here rather than trusted from
 * the filter — the filter is a request, the tag is signed.
 */
function selectRosterEvent(events: readonly unknown[], channelId: string): NostrEvent | null {
  let best: NostrEvent | null = null;
  for (const raw of events) {
    const parsed = parseNostrEvent(raw, { maxTags: MAX_ROSTER_TAGS });
    if (!parsed.ok) continue;
    const event = parsed.event;
    if (event.kind !== KIND_GROUP_MEMBERS) continue;
    const d = event.tags.find((t) => t[0] === "d")?.[1];
    if (d !== channelId) continue;
    if (best === null || event.created_at > best.created_at) best = event;
  }
  return best;
}

/**
 * Fetch and verify one channel's roster.
 *
 * Order is load-bearing:
 *
 *   1. reader key — cheapest, and `not_configured` must never look like an
 *      outage;
 *   2. binding row — tells us whether a key is already pinned;
 *   3. NIP-11 `self`, compared against the pin BEFORE the roster request, so
 *      a relay we no longer trust never sees a signed NIP-98 event from us;
 *   4. `POST /query`;
 *   5. signature verification against `self`;
 *   6. the trust-on-first-use pin, last, only on a verified roster.
 *
 * The row is never written on any failure path.
 */
export async function fetchChannelRoster(
  db: Database,
  relayHost: string,
  channelId: string,
  opts: RosterFetchOptions = {},
): Promise<FetchChannelRosterResult> {
  const loaded = loadBuzzReaderKey(opts.env, opts.configDir);
  if (!loaded.ok) {
    return loaded.reason === "not_configured"
      ? { ok: false, reason: "not_configured", detail: `no reader key at ${loaded.path}` }
      : { ok: false, reason: "key_unreadable", detail: `reader key ${loaded.reason}` };
  }

  const binding = getChannelVault(db, relayHost, channelId);
  if (binding === null) return { ok: false, reason: "not_bound" };

  const nip11 = await fetchRelaySelfPubkey(relayHost, opts);
  if (!nip11.ok) return nip11;

  const pinnedKey = binding.relaySelfPubkey;
  if (pinnedKey !== null && pinnedKey !== nip11.pubkey) {
    // Deliberately does NOT re-pin and does NOT continue to /query. Pubkeys
    // are public, so naming both in `detail` leaks nothing and is the only
    // way an operator can tell a rotation from an interception.
    return {
      ok: false,
      reason: "relay_key_changed",
      detail: `relay advertises ${nip11.pubkey}, pinned ${pinnedKey}`,
    };
  }

  const fetched = await fetchRosterEvents(relayHost, channelId, loaded.key.secretKeyHex, opts);
  if (!fetched.ok) return fetched;

  const event = selectRosterEvent(fetched.events, channelId);
  if (event === null) {
    return { ok: false, reason: "no_roster", detail: `no kind ${KIND_GROUP_MEMBERS} for channel` };
  }

  // Two independent checks. The author check is the one that matters here:
  // a validly-signed event from SOME key proves only that somebody signed it,
  // and the whole design rests on it being the relay that did.
  if (event.pubkey !== nip11.pubkey) {
    return {
      ok: false,
      reason: "bad_signature",
      detail: "roster not signed by the relay self key",
    };
  }
  const verified = verifyNostrEvent(event);
  if (!verified.ok) return { ok: false, reason: "bad_signature", detail: verified.reason };

  const pinned = pinnedKey === null && pinRelaySelfPubkey(db, relayHost, channelId, nip11.pubkey);
  const { roster, skipped } = parseRosterTags(event.tags);
  return {
    ok: true,
    roster,
    eventCreatedAt: event.created_at,
    relaySelfPubkey: nip11.pubkey,
    pinned,
    skipped,
  };
}
