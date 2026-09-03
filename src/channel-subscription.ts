/**
 * Live membership subscription — the invalidation edge for channel-attached
 * vaults (design "Channel-attached vaults — membership becomes access", §2;
 * build plan row 5's deferred follow-up).
 *
 * `channel-reconciler.ts` polls every `sync` binding once a minute. That is
 * correct but slow: a member removed one second after a pass waits the better
 * part of 60s for their vault access to go away. This module opens one
 * authenticated websocket per bound relay and lets the relay TELL us, so the
 * common case becomes one round trip instead of one poll interval.
 *
 * **It changes only WHEN a reconcile runs, never what it does.** No grant is
 * written or removed from an event on this socket. Every event does exactly
 * one thing: ask the reconciler to run a pass over the affected binding, which
 * re-fetches the signed roster over NIP-98 and reconciles from that. The
 * roster remains the single source of truth, so a forged or replayed
 * notification can at worst cost us one wasted `POST /query`.
 *
 * ## Which kinds actually work, and why it is not only 44100/44101
 *
 * The obvious subscription is Buzz's relay-signed membership notifications,
 * kind 44100 (member added) and 44101 (member removed). They are stored
 * community-globally (`channel_id = None`) and tagged `p` = target pubkey,
 * `h` = channel id (`buzz-relay/src/handlers/side_effects.rs`,
 * `emit_membership_notification`). But both kinds are in Buzz's
 * `P_GATED_KINDS` (`buzz-core/src/kind.rs`), and `req.rs`'s
 * `p_gated_filters_authorized` REJECTS any global REQ naming them unless the
 * filter carries a `#p` whose every value equals the authenticated pubkey:
 *
 * ```text
 * CLOSED  restricted: p-gated events require #p matching your pubkey
 * ```
 *
 * That gate exists to stop one member eavesdropping on everybody else's
 * membership changes and DMs, and it applies to the hub's reader key like any
 * other. So `{"kinds":[44100,44101],"#h":[<channel>]}` — the shape the design
 * note assumed — is not a subscription Buzz will accept, and
 * `{"kinds":[44100,44101],"#p":[<reader>]}` only ever fires when the READER
 * KEY ITSELF is seated or unseated. Useful (it means the hub's own access to
 * the channel changed) but silent on every other member.
 *
 * The signal that actually covers other members is the one the roster fetcher
 * already trusts: **kind 39002**, the NIP-29 member list. Buzz re-emits it on
 * every membership change — `add_member` and `remove_member` both call
 * `emit_group_discovery_events` immediately BEFORE
 * `emit_membership_notification` — signed by the same relay keypair, through
 * `dispatch_persistent_event`, which fans out live. It is stored
 * channel-scoped, and a REQ carrying a single `#h` is therefore a
 * channel-scoped subscription (`extract_channel_id_from_filters`), which the
 * global p-gate never runs against at all. The `#h` filter matches even
 * though a 39002 carries `d` rather than `h`, via the documented
 * `StoredEvent.channel_id` fallback in `buzz-core/src/filter.rs`.
 *
 * So this module opens both, per relay:
 *
 *   - one channel-scoped REQ **per bound channel** for 39002 — the real edge.
 *     One per channel, not one for all of them: two distinct `#h` values in a
 *     filter set make the subscription global again, and a global 39002 sub
 *     receives nothing (channel-scoped events never reach global subs);
 *   - one global REQ for 44100/44101 with `#p` = the reader key — narrow, but
 *     it is the literal notification the design named and it costs one filter.
 *
 * ## What is verified before a reconcile is requested
 *
 * Signature, then signer. An event is acted on only when it verifies AND its
 * `pubkey` equals the binding's pinned `relay_self_pubkey` — the same key the
 * roster fetcher pinned trust-on-first-use. A binding with no pin yet is
 * IGNORED rather than pinned from here: the pin is a one-time trust decision
 * and it belongs to the path that can also verify a roster against it. The
 * 60-second poll performs it on its next tick.
 *
 * ## Never the reason the hub is worse off
 *
 * The poll is the backstop and this is the accelerator, so every failure here
 * is inert: a relay that refuses AUTH, closes the socket, or CLOSEs a
 * subscription produces a rate-limited log line and a capped-backoff
 * reconnect, and the timer in `channel-reconciler.ts` keeps running
 * untouched. Requests are debounced, and they route through the SAME
 * re-entrancy guard the poller uses, so a burst of events becomes one pass and
 * a pass never overlaps a pass.
 *
 * Nothing here logs key material. The AUTH event this module signs carries
 * only a public key and a signature; no event JSON is ever logged.
 */
import type { Database } from "bun:sqlite";
import { loadBuzzReaderKey } from "./buzz-reader-key.ts";
import { KIND_GROUP_MEMBERS, MAX_ROSTER_TAGS } from "./channel-roster.ts";
import { type ChannelVault, getChannelVault, listChannelVaults } from "./channel-vaults.ts";
import { type NostrEvent, parseNostrEvent, tagValue, verifyNostrEvent } from "./nostr-event.ts";
import { signNostrEvent } from "./nostr-http-sign.ts";

/** NIP-42 AUTH event kind. */
export const KIND_CLIENT_AUTH = 22242;

/** Buzz relay-signed "member added" notification. */
export const KIND_MEMBER_ADDED = 44100;

/** Buzz relay-signed "member removed" notification. */
export const KIND_MEMBER_REMOVED = 44101;

/**
 * How long events are collected before one reconcile is requested. Adding
 * five people to a channel emits five 39002 replacements back to back; the
 * point of the window is that they cost one roster fetch, not five.
 */
export const SUBSCRIPTION_DEBOUNCE_MS = 1_500;

/** First reconnect delay. Doubles per consecutive failure. */
export const SUBSCRIPTION_MIN_BACKOFF_MS = 1_000;

/** Ceiling on the reconnect delay — a relay that is down is retried gently. */
export const SUBSCRIPTION_MAX_BACKOFF_MS = 60_000;

/**
 * How long the same (relay, reason) subscription failure stays quiet after
 * being logged once. Same fifteen minutes, and same reasoning, as
 * `FAILURE_LOG_INTERVAL_MS` in the reconciler: a relay that is unreachable
 * stays unreachable, and a reconnect loop must not bury hub.log.
 */
export const SUBSCRIPTION_LOG_INTERVAL_MS = 15 * 60_000;

/**
 * How long to wait for the relay's AUTH challenge before subscribing anyway.
 * Buzz challenges proactively on connect (`NOSTR.md`, "NIP-42
 * authentication: Proactive challenge"), so this is a belt for a relay that
 * does not — without it, a non-challenging relay would leave us connected and
 * permanently silent.
 */
export const SUBSCRIPTION_AUTH_GRACE_MS = 3_000;

/** Which binding a live event says changed. */
export interface ChannelBindingKey {
  relayHost: string;
  channelId: string;
}

/** Connection state, for `doctor`-style reporting. */
export type SubscriptionState = "connecting" | "connected" | "reconnecting" | "stopped";

/**
 * The subset of the WHATWG `WebSocket` API this module uses. Narrower than
 * `typeof WebSocket` on purpose, for the same reason `FetchLike` is narrower
 * than `typeof fetch`: a test double has no business implementing
 * `binaryType` or `bufferedAmount`.
 */
export interface SubscriptionSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface ChannelSubscriptionDeps {
  db: Database;
  /**
   * Ask the reconciler to run a pass over these bindings. MUST route through
   * the poller's re-entrancy guard and return `false` when a pass is already
   * in flight — this module re-arms its debounce on `false` rather than
   * stacking a second pass.
   */
  requestReconcile: (only: readonly ChannelBindingKey[]) => boolean;
  log?: (line: string) => void;
  /** Shared with the poller so one dead relay is quiet across both paths. */
  limiter?: { last: Map<string, number> };
  env?: NodeJS.ProcessEnv;
  configDir?: string;
  /** Websocket URL for a relay host. Default `wss://<host>`. */
  wsUrlFor?: (relayHost: string) => string;
  /** Socket constructor seam. Default the global `WebSocket`. */
  createSocket?: (url: string) => SubscriptionSocket;
  debounceMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  authGraceMs?: number;
  logIntervalMs?: number;
  /** Unix SECONDS for the AUTH event. Injectable for determinism. */
  nowSeconds?: () => number;
  /** Injectable clock for the log rate limiter. */
  now?: () => Date;
}

/** Handle returned by {@link startChannelSubscriptions}. */
export interface ChannelSubscriptions {
  /**
   * Re-read the `sync` bindings and bring the sockets in line: connect to a
   * newly bound relay, drop one that no longer has bindings, and add/remove
   * per-channel subscriptions on a socket that is already up. Called from the
   * poll tick, which is why a binding attached at runtime by the CLI goes
   * live within one poll interval rather than instantly.
   */
  refresh(): void;
  /** Current state per relay host. Diagnostics only. */
  states(): Map<string, SubscriptionState>;
  stop(): void;
}

const bindingKey = (relayHost: string, channelId: string) => `${relayHost} ${channelId}`;

/** `sync` bindings grouped by relay host. */
function syncBindingsByHost(db: Database): Map<string, Map<string, ChannelVault>> {
  const out = new Map<string, Map<string, ChannelVault>>();
  for (const b of listChannelVaults(db)) {
    if (b.mode !== "sync") continue;
    let channels = out.get(b.relayHost);
    if (channels === undefined) {
      channels = new Map();
      out.set(b.relayHost, channels);
    }
    channels.set(b.channelId, b);
  }
  return out;
}

/**
 * Start the live subscriptions — or don't.
 *
 * Returns `null` when no Buzz reader key is loadable, for the same reason
 * `startChannelReconciler` does: an opt-in feature costs a hub that has not
 * opted in exactly nothing. The caller has already made that check, so this
 * one is belt-and-braces rather than the primary gate.
 *
 * Returns a handle with NO sockets open when there are no `sync` bindings
 * yet; {@link ChannelSubscriptions.refresh} opens them when one appears.
 */
export function startChannelSubscriptions(
  deps: ChannelSubscriptionDeps,
): ChannelSubscriptions | null {
  const loaded = loadBuzzReaderKey(deps.env, deps.configDir);
  if (!loaded.ok) return null;
  const readerPubkey = loaded.key.pubkey;

  const log = deps.log ?? ((line: string) => console.log(line));
  const limiter = deps.limiter ?? { last: new Map<string, number>() };
  const now = deps.now ?? (() => new Date());
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const wsUrlFor = deps.wsUrlFor ?? ((host: string) => `wss://${host}`);
  const createSocket =
    deps.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SubscriptionSocket);
  const debounceMs = deps.debounceMs ?? SUBSCRIPTION_DEBOUNCE_MS;
  const minBackoffMs = deps.minBackoffMs ?? SUBSCRIPTION_MIN_BACKOFF_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? SUBSCRIPTION_MAX_BACKOFF_MS;
  const authGraceMs = deps.authGraceMs ?? SUBSCRIPTION_AUTH_GRACE_MS;
  const logIntervalMs = deps.logIntervalMs ?? SUBSCRIPTION_LOG_INTERVAL_MS;

  let stopped = false;

  /** One line per (relay, reason) per window. Never carries event material. */
  function rateLimited(key: string, line: string): void {
    const at = now().getTime();
    const previous = limiter.last.get(key);
    if (previous !== undefined && at - previous < logIntervalMs) return;
    limiter.last.set(key, at);
    log(line);
  }

  // ---- debounce -----------------------------------------------------------

  const pending = new Map<string, ChannelBindingKey>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function fire(): void {
    debounceTimer = null;
    if (stopped || pending.size === 0) return;
    // `requestReconcile` is the poller's guard. A `false` means a pass is
    // already running — the events we are holding may have arrived while that
    // pass was reading a pre-change roster, so they must not be dropped. Wait
    // one more window and try again; the retry terminates as soon as the
    // in-flight pass finishes.
    const only = [...pending.values()];
    if (!deps.requestReconcile(only)) {
      debounceTimer = setTimeout(fire, debounceMs);
      (debounceTimer as { unref?: () => void }).unref?.();
      return;
    }
    pending.clear();
  }

  function requestReconcileFor(binding: ChannelBindingKey): void {
    if (stopped) return;
    pending.set(bindingKey(binding.relayHost, binding.channelId), {
      relayHost: binding.relayHost,
      channelId: binding.channelId,
    });
    if (debounceTimer !== null) return;
    debounceTimer = setTimeout(fire, debounceMs);
    (debounceTimer as { unref?: () => void }).unref?.();
  }

  // ---- one relay ----------------------------------------------------------

  /** The `#p`-gated global membership subscription id (one per connection). */
  const MEMBER_SUB_ID = "pc-member";
  const channelSubId = (channelId: string) => `pc-ch:${channelId}`;

  class RelayConnection {
    readonly host: string;
    /** channelId → binding, refreshed from the DB on every (re)connect. */
    channels = new Map<string, ChannelVault>();
    state: SubscriptionState = "connecting";
    private socket: SubscriptionSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private graceTimer: ReturnType<typeof setTimeout> | null = null;
    private attempt = 0;
    private authEventId: string | null = null;
    private subscribed = new Set<string>();
    private closed = false;
    /** Guards against a late `onclose` from a socket we already replaced. */
    private generation = 0;

    constructor(host: string, channels: Map<string, ChannelVault>) {
      this.host = host;
      this.channels = channels;
      this.connect();
    }

    private clearTimers(): void {
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      if (this.graceTimer !== null) clearTimeout(this.graceTimer);
      this.reconnectTimer = null;
      this.graceTimer = null;
    }

    private connect(): void {
      if (this.closed || stopped) return;
      const generation = ++this.generation;
      this.authEventId = null;
      this.subscribed.clear();
      let socket: SubscriptionSocket;
      try {
        socket = createSocket(wsUrlFor(this.host));
      } catch (err) {
        // A malformed URL, or no WebSocket in this runtime. Not fatal.
        const detail = err instanceof Error ? err.message : String(err);
        rateLimited(
          `sub ${this.host} open_failed`,
          `channel subscription: could not open socket relay=${this.host} detail=${detail} (poll unaffected)`,
        );
        this.scheduleReconnect();
        return;
      }
      this.socket = socket;
      socket.onopen = () => {
        if (generation !== this.generation) return;
        this.state = "connected";
        // Belt for a relay that does not challenge — see
        // SUBSCRIPTION_AUTH_GRACE_MS.
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (generation === this.generation) this.sendSubscriptions();
        }, authGraceMs);
        (this.graceTimer as { unref?: () => void }).unref?.();
      };
      socket.onmessage = (event) => {
        if (generation !== this.generation) return;
        this.onMessage(event.data);
      };
      socket.onerror = () => {
        // `onclose` always follows; the reconnect is driven from there so a
        // single failure cannot schedule two.
      };
      socket.onclose = () => {
        if (generation !== this.generation) return;
        this.socket = null;
        this.clearTimers();
        if (this.closed || stopped) {
          this.state = "stopped";
          return;
        }
        this.state = "reconnecting";
        this.scheduleReconnect();
      };
    }

    private scheduleReconnect(): void {
      if (this.closed || stopped) return;
      const delay = Math.min(maxBackoffMs, minBackoffMs * 2 ** this.attempt);
      this.attempt++;
      this.state = "reconnecting";
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        // Bindings may have changed while we were down; take the current set.
        // A throw here means the DB went away underneath us (shutdown race) —
        // stop rather than crash a timer callback.
        let fresh: Map<string, ChannelVault> | undefined;
        try {
          fresh = syncBindingsByHost(deps.db).get(this.host);
        } catch {
          this.state = "stopped";
          return;
        }
        if (fresh === undefined || fresh.size === 0) {
          // Nothing left to watch here. `refresh` will drop us.
          this.state = "stopped";
          return;
        }
        this.channels = fresh;
        this.connect();
      }, delay);
      (this.reconnectTimer as { unref?: () => void }).unref?.();
    }

    private send(frame: unknown): void {
      try {
        this.socket?.send(JSON.stringify(frame));
      } catch {
        // A socket that died between the state check and the write. The
        // `onclose` handler owns the recovery.
      }
    }

    /** REQ every channel this connection watches, plus the global `#p` sub. */
    private sendSubscriptions(): void {
      // The backoff resets HERE, not on `onopen`. A relay that accepts the TCP
      // connection and then drops us (auth rejected, reader key unseated)
      // would otherwise reset the counter on every attempt and reconnect flat
      // out forever; resetting only once we are actually subscribed means
      // that loop backs off like any other failure.
      this.attempt = 0;
      for (const channelId of this.channels.keys()) this.subscribeChannel(channelId);
      if (!this.subscribed.has(MEMBER_SUB_ID)) {
        this.subscribed.add(MEMBER_SUB_ID);
        // Global, and therefore subject to Buzz's p-gate: `#p` must be
        // exactly the authenticated pubkey. See the module header.
        this.send([
          "REQ",
          MEMBER_SUB_ID,
          { kinds: [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED], "#p": [readerPubkey], limit: 0 },
        ]);
      }
    }

    private subscribeChannel(channelId: string): void {
      const subId = channelSubId(channelId);
      if (this.subscribed.has(subId)) return;
      this.subscribed.add(subId);
      // ONE `#h` value: two would make this a global subscription, which can
      // never receive a channel-scoped 39002. `limit: 0` asks for live only —
      // the current roster is the poll's job, not ours.
      this.send(["REQ", subId, { kinds: [KIND_GROUP_MEMBERS], "#h": [channelId], limit: 0 }]);
    }

    private unsubscribeChannel(channelId: string): void {
      const subId = channelSubId(channelId);
      if (!this.subscribed.delete(subId)) return;
      this.send(["CLOSE", subId]);
    }

    /** Bring subscriptions in line with a new binding set, socket permitting. */
    setChannels(channels: Map<string, ChannelVault>): void {
      const previous = this.channels;
      this.channels = channels;
      if (this.state !== "connected") return;
      for (const channelId of previous.keys()) {
        if (!channels.has(channelId)) this.unsubscribeChannel(channelId);
      }
      for (const channelId of channels.keys()) this.subscribeChannel(channelId);
    }

    private onMessage(data: unknown): void {
      if (typeof data !== "string") return;
      let frame: unknown;
      try {
        frame = JSON.parse(data);
      } catch {
        return;
      }
      if (!Array.isArray(frame) || typeof frame[0] !== "string") return;
      switch (frame[0]) {
        case "AUTH":
          if (typeof frame[1] === "string") this.answerAuth(frame[1]);
          return;
        case "OK":
          this.onOk(frame);
          return;
        case "EVENT":
          this.onEvent(frame[2]);
          return;
        case "CLOSED":
          rateLimited(
            `sub ${this.host} closed`,
            `channel subscription: relay closed a subscription relay=${this.host} ` +
              `sub=${typeof frame[1] === "string" ? frame[1] : "?"} ` +
              `reason=${typeof frame[2] === "string" ? frame[2] : "?"} (poll unaffected)`,
          );
          return;
        default:
          // NOTICE, EOSE, COUNT, and anything a future relay adds.
          return;
      }
    }

    /**
     * Answer a NIP-42 challenge with a kind 22242 event.
     *
     * `relay` must be the URL the relay expects — for Buzz,
     * `<ws|wss>://<tenant host>` with no path
     * (`buzz-relay/src/api/bridge.rs`, `nip42_expected_relay_url`), compared
     * after trailing-slash normalization. `created_at` must be within ±60s of
     * the relay's clock. The key is re-read per challenge so an operator who
     * rotates it does not have to restart the hub.
     */
    private answerAuth(challenge: string): void {
      const key = loadBuzzReaderKey(deps.env, deps.configDir);
      if (!key.ok) {
        rateLimited(
          `sub ${this.host} key_${key.reason}`,
          `channel subscription: Buzz reader key is ${key.reason}; not authenticating to ${this.host}.`,
        );
        return;
      }
      let event: NostrEvent;
      try {
        event = signNostrEvent(
          {
            created_at: nowSeconds(),
            kind: KIND_CLIENT_AUTH,
            tags: [
              ["relay", wsUrlFor(this.host)],
              ["challenge", challenge],
            ],
            content: "",
          },
          key.key.secretKeyHex,
        );
      } catch {
        // Content-free on purpose: a signing error must not put any part of
        // the key in hub.log.
        rateLimited(
          `sub ${this.host} sign_failed`,
          `channel subscription: could not sign the NIP-42 AUTH event for ${this.host}.`,
        );
        return;
      }
      this.authEventId = event.id;
      this.send(["AUTH", event]);
    }

    private onOk(frame: readonly unknown[]): void {
      if (this.authEventId === null || frame[1] !== this.authEventId) return;
      this.authEventId = null;
      if (this.graceTimer !== null) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
      if (frame[2] === true) {
        this.sendSubscriptions();
        return;
      }
      rateLimited(
        `sub ${this.host} auth_rejected`,
        `channel subscription: relay rejected NIP-42 auth relay=${this.host} ` +
          `reason=${typeof frame[3] === "string" ? frame[3] : "?"} (poll unaffected)`,
      );
      // Nothing more can happen on this connection — Buzz pins `AuthState`
      // to `Failed` for its life and refuses a second attempt. Drop it and
      // let the backoff (which `sendSubscriptions` never reset) space out the
      // retries; the operator's real fix is to seat the reader key.
      try {
        this.socket?.close();
      } catch {
        // Already closing; `onclose` still owns the reconnect.
      }
    }

    /**
     * One live event → at most one reconcile request.
     *
     * Cheap checks first, curve math last: shape, then kind, then the channel
     * this event names, then that we are bound to it, then the pinned signer,
     * and only then the signature.
     */
    private onEvent(raw: unknown): void {
      const parsed = parseNostrEvent(raw, { maxTags: MAX_ROSTER_TAGS });
      if (!parsed.ok) return;
      const event = parsed.event;

      let channelId: string | null;
      if (event.kind === KIND_GROUP_MEMBERS) {
        // 39002 is addressable: the channel is its `d` tag.
        channelId = tagValue(event, "d");
      } else if (event.kind === KIND_MEMBER_ADDED || event.kind === KIND_MEMBER_REMOVED) {
        channelId = tagValue(event, "h");
      } else {
        return;
      }
      if (channelId === null) return;

      // Cheap in-memory guard first: is this even a channel we subscribed
      // for? Then re-read the row, because the pin is written by the POLL and
      // the snapshot this connection was built from may predate it — without
      // the re-read, a freshly attached binding would ignore live events for
      // a whole extra interval after the poll pinned its key. A `frozen` or
      // detached binding drops out here too.
      if (!this.channels.has(channelId)) return;
      let binding: ChannelVault | null;
      try {
        binding = getChannelVault(deps.db, this.host, channelId);
      } catch {
        // DB closed underneath a live socket (shutdown race). Inert.
        return;
      }
      if (binding === null || binding.mode !== "sync") return;
      if (binding.relaySelfPubkey === null) {
        // Trust-on-first-use is the roster fetcher's decision, not ours — it
        // is the path that can check a key against a roster before pinning
        // it. Drop the event; the next poll pins and then this works.
        return;
      }
      if (event.pubkey !== binding.relaySelfPubkey) {
        // Somebody other than the relay signed something that looks like a
        // roster. Both keys are public, so naming them leaks nothing.
        rateLimited(
          `sub ${this.host} wrong_signer`,
          `channel subscription: ignoring an event not signed by the pinned relay key relay=${this.host} channel=${channelId} signer=${event.pubkey} pinned=${binding.relaySelfPubkey}`,
        );
        return;
      }
      if (!verifyNostrEvent(event).ok) {
        rateLimited(
          `sub ${this.host} bad_signature`,
          `channel subscription: ignoring an event with a bad signature relay=${this.host} channel=${channelId}`,
        );
        return;
      }
      requestReconcileFor({ relayHost: this.host, channelId });
    }

    close(): void {
      this.closed = true;
      this.generation++;
      this.clearTimers();
      this.state = "stopped";
      try {
        this.socket?.close();
      } catch {
        // Already closed.
      }
      this.socket = null;
    }
  }

  const connections = new Map<string, RelayConnection>();

  function refresh(): void {
    if (stopped) return;
    let desired: Map<string, Map<string, ChannelVault>>;
    try {
      desired = syncBindingsByHost(deps.db);
    } catch (err) {
      // A closed database (shutdown race) or a missing table on an older
      // schema. Never take the poll down over it.
      const detail = err instanceof Error ? err.message : String(err);
      rateLimited(
        "sub refresh_failed",
        `channel subscription: could not read channel bindings (${detail}); live subscriptions unchanged.`,
      );
      return;
    }
    for (const [host, connection] of connections) {
      if (!desired.has(host)) {
        connection.close();
        connections.delete(host);
      }
    }
    for (const [host, channels] of desired) {
      const existing = connections.get(host);
      if (existing === undefined) {
        connections.set(host, new RelayConnection(host, channels));
      } else {
        existing.setChannels(channels);
      }
    }
  }

  refresh();

  return {
    refresh,
    states() {
      const out = new Map<string, SubscriptionState>();
      for (const [host, connection] of connections) out.set(host, connection.state);
      return out;
    },
    stop() {
      stopped = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      pending.clear();
      for (const connection of connections.values()) connection.close();
      connections.clear();
    },
  };
}
