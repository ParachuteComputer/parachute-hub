/**
 * Channel membership reconciler — the write half of channel-attached vaults
 * (design "Channel-attached vaults — membership becomes access", §2; build
 * plan row 5).
 *
 * Takes the roster PR 4 can prove (`fetchChannelRoster`) and turns it into
 * ordinary `user_vaults` rows on the bound vault. Nothing downstream knows a
 * Buzz channel exists: `vaultVerbsForUserVault`, `callerCanAdminVault`, the
 * OAuth mint cap and the account MCP all read the same rows they always read.
 * That is the design's central bet — membership becomes access through the
 * hub's EXISTING grant table, not through a parallel authority.
 *
 * ## The role map, and the two roles it will never write
 *
 * | Buzz role | `user_vaults.role` | verbs |
 * |---|---|---|
 * | owner, admin | `member` | read, write |
 * | member | `member` | read, write |
 * | bot | `member` | read, write |
 * | guest | `read` | read |
 *
 * `member` is read+write with NO `admin` (`vaultVerbsForRole`), and `admin` is
 * exactly what `callerCanAdminVault` reads — so a synced principal can use the
 * vault fully and cannot hand it to anybody. Channel authority is not hub
 * authority: a channel OWNER lands as `member` like everyone else, because the
 * alternative is that anyone who can make themselves a channel owner can make
 * themselves a hub granter. `write` and `admin` are unreachable from this
 * module by construction — {@link hubRoleForRosterRole} is total over
 * `RosterRole` and returns only `member` or `read`.
 *
 * ## Provenance: which rows are mine to remove
 *
 * Revocation is the reason this module exists, and revocation means DELETING
 * rows — so the one thing it must never do is delete a row a human made. Every
 * row the reconciler writes carries
 * `granted_via = "channel:<relay-host>:<channel-id>"` (migration v22's
 * attribution column; see `GrantVia`). Removal matches that string EXACTLY,
 * scoped to the bound vault, so:
 *
 *   - an operator grant (`granted_via` NULL / `mcp` / `cli` / `api`) is
 *     invisible to the sweep and survives a roster that omits its pubkey;
 *   - a row written by a DIFFERENT channel binding on the same vault is
 *     likewise not ours to remove;
 *   - and the label doubles as the answer to "why does this account have
 *     access?", which no separate boolean column would give.
 *
 * The same string is the `user_pubkeys` label for accounts this module
 * creates, so an operator can see the channel an account came from as well as
 * the channel a grant came from.
 *
 * A pre-existing OPERATOR row is not upgraded, downgraded, or relabelled
 * either: if a pubkey in the roster already has a hand-made row on the vault,
 * the human's decision stands and the reconciler counts it as `deferred`. The
 * reconciler's job is to be the source of truth for the rows IT owns, not to
 * become the source of truth for the vault.
 *
 * ## Freeze, don't drop
 *
 * Every remote failure is a value, never an exception (PR 4's contract). On
 * any `ok:false` the binding is left completely alone: no row is written, no
 * row is removed, and `synced_at` stays stale so `doctor` and
 * `list-channels` show the freeze. Only `last_error` / `last_attempt_at`
 * (migration v24, diagnostics) move. The failure mode this protects against is
 * the bad one: a relay that is merely unreachable must not read as "every
 * member has left".
 *
 * `mode = 'frozen'` bindings are skipped before any network call, and so is
 * any mode this build does not recognise — fail-closed at the reader, the same
 * posture `vaultVerbsForRole` takes on a role it doesn't know.
 *
 * ## Poll, plus a live edge
 *
 * The design pairs a 60-second poll with a live subscription as an
 * invalidation edge, cutting worst-case revocation from ~70s to one round
 * trip in the common case. This module owns the poll;
 * `channel-subscription.ts` owns the websocket half and calls back in here.
 * It changes only WHEN {@link reconcileBinding} runs, never what it does — a
 * live event causes a roster fetch, and the roster is still the only thing
 * that decides a grant.
 *
 * The two share ONE re-entrancy guard ({@link startChannelReconciler}'s
 * `running`), so a burst of relay events cannot stack a second pass on top of
 * a poll that is already walking the same rows.
 */
import type { Database } from "bun:sqlite";
import { loadBuzzReaderKey } from "./buzz-reader-key.ts";
import {
  type FetchChannelRosterResult,
  type RosterFetchOptions,
  type RosterRole,
  fetchChannelRoster,
} from "./channel-roster.ts";
import {
  type ChannelBindingKey,
  type ChannelSubscriptionDeps,
  type ChannelSubscriptions,
  type SubscriptionState,
  startChannelSubscriptions,
} from "./channel-subscription.ts";
import {
  type ChannelVault,
  isChannelVaultMode,
  listChannelVaults,
  markChannelVaultFailure,
  markChannelVaultSynced,
} from "./channel-vaults.ts";
import { GrantError, ensureUserForPubkey } from "./grant-access.ts";
import { findPubkeyLink, pubkeysForUser } from "./pubkey-links.ts";
import { isHubAdmin, removeUserVault as removeUserVaultDefault, upsertUserVault } from "./users.ts";

/** How often the hub polls each `sync` binding. Design §2: 60 seconds. */
export const CHANNEL_RECONCILE_INTERVAL_MS = 60_000;

/**
 * How long the same (binding, reason) failure stays quiet after being logged
 * once. A relay that is down stays down for hours and is polled every minute;
 * without this, one unreachable relay writes ~1400 identical lines a day into
 * hub.log and buries everything else. Fifteen minutes keeps the fact visible
 * on any human timescale while making the log survivable.
 */
export const FAILURE_LOG_INTERVAL_MS = 15 * 60_000;

/** The prefix every reconciler-written `granted_via` / key label starts with. */
export const CHANNEL_GRANT_VIA_PREFIX = "channel:";

/**
 * The provenance label for one binding: `channel:<relay-host>:<channel-id>`.
 *
 * `relay_host` is already normalized (lower-cased, scheme-less, no slashes or
 * whitespace — `normalizeRelayHost`) and so is `channel_id`, so this is stable
 * and comparable with `=`. It is never PARSED back apart: a relay host may
 * legitimately carry a `:port`, which would make splitting on `:` ambiguous.
 * Equality is the only operation this string needs.
 */
export function channelGrantVia(relayHost: string, channelId: string): `channel:${string}` {
  return `${CHANNEL_GRANT_VIA_PREFIX}${relayHost}:${channelId}`;
}

/** Was this `granted_via` written by SOME channel reconciler? */
export function isChannelGrantVia(via: string | null | undefined): boolean {
  return typeof via === "string" && via.startsWith(CHANNEL_GRANT_VIA_PREFIX);
}

/**
 * Buzz role → `user_vaults.role`. Total over `RosterRole`, and its range is
 * `member | read` — the two non-granting roles. See the table in the module
 * header for why `owner` is not special.
 */
export function hubRoleForRosterRole(role: RosterRole): "member" | "read" {
  return role === "guest" ? "read" : "member";
}

/** Why a binding produced no reconcile. */
export type ReconcileSkipReason =
  /** `mode = 'frozen'` — the operator asked for the grants to be held. */
  | "frozen"
  /** A `mode` value this build does not recognise. Fail closed. */
  | "unknown_mode";

/** What one binding's pass did. */
export interface ReconcileBindingResult {
  relayHost: string;
  channelId: string;
  vault: string;
  /**
   * `ok` — the roster was fetched and the vault now matches it.
   * `failed` — the roster could not be fetched; nothing was changed.
   * `skipped` — the binding is not in `sync` mode; no network call was made.
   */
  status: "ok" | "failed" | "skipped";
  /** `RosterFailure` word on `failed`, {@link ReconcileSkipReason} on `skipped`. */
  reason?: string;
  /** Operator-facing context from the fetcher. Never secret. */
  detail?: string;
  /** Members in the roster (0 on a failure or skip). */
  members: number;
  /** Rows written (created or role/label-corrected) this pass. */
  granted: number;
  /** Rows removed because their pubkey is no longer in the roster. */
  removed: number;
  /** Key-only hub accounts created for pubkeys the hub had never seen. */
  createdUsers: number;
  /** Roster entries whose row was already correct — no write at all. */
  unchanged: number;
  /**
   * Roster entries left alone because a human already made a row for them, or
   * because they are a hub admin (unrestricted by construction — the same
   * no-op `grantAccess` performs).
   */
  deferred: number;
  /** Roster entries that could not be given an account. See the log line. */
  errors: number;
}

/** What a whole pass did. */
export interface ReconcileRunResult {
  /** False when the pass short-circuited before touching any binding. */
  ran: boolean;
  /**
   * Why it short-circuited: `not_configured` / `key_unreadable` (no usable
   * Buzz reader key on this hub) or `no_sync_bindings`.
   */
  reason?: "not_configured" | "key_unreadable" | "no_sync_bindings";
  bindings: ReconcileBindingResult[];
}

/**
 * Cross-tick memory for the failure-log rate limiter. Held by the scheduler so
 * a repeated failure is quiet ACROSS polls; a one-shot CLI run gets a fresh
 * one and therefore always prints.
 */
export interface FailureLogLimiter {
  last: Map<string, number>;
}

export function createFailureLogLimiter(): FailureLogLimiter {
  return { last: new Map() };
}

export interface ReconcilerDeps {
  db: Database;
  /** Injectable clock. */
  now?: () => Date;
  /** Roster fetcher seam. Defaults to the real {@link fetchChannelRoster}. */
  fetchRoster?: (
    db: Database,
    relayHost: string,
    channelId: string,
    opts: RosterFetchOptions,
  ) => Promise<FetchChannelRosterResult>;
  /** Passed through to the fetcher (env, origin override, timeout). */
  rosterOptions?: RosterFetchOptions;
  /** Log sink. Defaults to `console.log` — hub.log. */
  log?: (line: string) => void;
  /** Shared rate-limiter state. A fresh one is made per call when omitted. */
  limiter?: FailureLogLimiter;
  /** Quiet window for a repeated (binding, reason). */
  failureLogIntervalMs?: number;
  /**
   * Row-removal seam. Defaults to the real {@link removeUserVaultDefault}.
   * Test-only in practice — exists so the removal sweep's all-or-nothing
   * transaction (a thrown exception mid-sweep must leave every grant
   * untouched) can be exercised without needing a real SQLite failure.
   */
  removeUserVault?: typeof removeUserVaultDefault;
}

interface ExistingRow {
  role: string;
  granted_via: string | null;
}

function existingUserVault(db: Database, userId: string, vault: string): ExistingRow | null {
  return (
    db
      .query<ExistingRow, [string, string]>(
        "SELECT role, granted_via FROM user_vaults WHERE user_id = ? AND vault_name = ?",
      )
      .get(userId, vault) ?? null
  );
}

/**
 * Every `user_vaults` row on `vault` that THIS binding wrote. The exact-match
 * `granted_via` predicate is the whole safety property of the removal sweep —
 * see the module header.
 */
function rowsOwnedByBinding(db: Database, vault: string, via: string): { user_id: string }[] {
  return db
    .query<{ user_id: string }, [string, string]>(
      "SELECT user_id FROM user_vaults WHERE vault_name = ? AND granted_via = ? ORDER BY user_id ASC",
    )
    .all(vault, via);
}

/**
 * Reconcile ONE binding against the relay's current roster.
 *
 * Order matters: additions first, then the removal sweep. A member whose role
 * changed is re-written before the sweep looks at them, so a role change can
 * never be observed as a removal. Both halves run inside one pass but NOT one
 * transaction — `ensureUserForPubkey` is async (argon2 for the throwaway
 * password) and a SQLite transaction cannot span an await. Every individual
 * write is atomic on its own, and a pass that dies halfway leaves a partially
 * synced vault that the next pass, 60 seconds later, completes. Not holding a
 * write lock across argon2 hashes matters more here: the hub's request handlers
 * share this database.
 */
export async function reconcileBinding(
  binding: ChannelVault,
  deps: ReconcilerDeps,
): Promise<ReconcileBindingResult> {
  const db = deps.db;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(line));
  const base = {
    relayHost: binding.relayHost,
    channelId: binding.channelId,
    vault: binding.vault,
    members: 0,
    granted: 0,
    removed: 0,
    createdUsers: 0,
    unchanged: 0,
    deferred: 0,
    errors: 0,
  };

  if (binding.mode !== "sync") {
    // `frozen` is the operator's deliberate hold; an unrecognised mode is a
    // hand-edited or future value, and doing nothing is the fail-closed
    // reading of it. Neither makes a network call.
    const reason: ReconcileSkipReason = isChannelVaultMode(binding.mode)
      ? "frozen"
      : "unknown_mode";
    return { ...base, status: "skipped", reason };
  }

  const fetchRoster = deps.fetchRoster ?? fetchChannelRoster;
  const result = await fetchRoster(
    db,
    binding.relayHost,
    binding.channelId,
    deps.rosterOptions ?? {},
  );

  if (!result.ok) {
    // FREEZE. No user_vaults write of any kind, and `synced_at` untouched.
    markChannelVaultFailure(db, binding.relayHost, binding.channelId, result.reason, now());
    logFailure(binding, result.reason, result.detail, deps, log);
    return {
      ...base,
      status: "failed",
      reason: result.reason,
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    };
  }

  const via = channelGrantVia(binding.relayHost, binding.channelId);
  const out = { ...base, status: "ok" as const, members: result.roster.length };
  const rosterKeys = new Set(result.roster.map((e) => e.pubkey));

  for (const entry of result.roster) {
    const role = hubRoleForRosterRole(entry.role);
    let userId: string;
    try {
      const link = findPubkeyLink(db, entry.pubkey);
      if (link) {
        userId = link.userId;
      } else {
        // New key: a key-only account plus an operator-attested link labelled
        // with this binding, exactly the shape `grant-access` creates. B (the
        // Nostr sign-in door) then lights up with no rework — the account,
        // the link and the grant already exist and are correctly attributed.
        const created = await ensureUserForPubkey(db, entry.pubkey, now, { label: via });
        userId = created.userId;
        if (created.created) out.createdUsers++;
      }
    } catch (err) {
      // `no_hub_owner` (empty hub), `username_taken`, `pubkey_taken`. One
      // member that cannot be given an account must not sink the roster —
      // the other members' access is still correct.
      out.errors++;
      const code = err instanceof GrantError ? err.errorType : "error";
      log(
        `channel reconcile: could not provision member relay=${binding.relayHost} ` +
          `channel=${binding.channelId} pubkey=${entry.pubkey} reason=${code}`,
      );
      continue;
    }

    if (isHubAdmin(db, userId)) {
      // Unrestricted by construction (`vaultScopeForUser` returns []), so a
      // row would add nothing and the sentinel `grantAccess` protects — an
      // admin has no rows — should not be broken by a roster. Same no-op.
      out.deferred++;
      continue;
    }

    const existing = existingUserVault(db, userId, binding.vault);
    if (existing && !isChannelGrantVia(existing.granted_via)) {
      // A human granted this. Their role stands, whatever the channel says:
      // a hand-made `write` must not be silently narrowed to `member`, and a
      // hand-made `read` must not be silently widened. Left for the operator.
      out.deferred++;
      continue;
    }
    if (existing && existing.role === role && existing.granted_via === via) {
      // Already exactly right — no write, so a steady-state pass causes no
      // row churn at all (`created_at` and `updated_at` both stand still).
      out.unchanged++;
      continue;
    }
    // Either new, or a role change, or a row another binding on this vault
    // owned. `upsertUserVault` preserves `created_at` on conflict.
    upsertUserVault(db, userId, binding.vault, role, now, {
      // No grantor: no hub account and no key made this decision — the relay's
      // signed roster did. Fabricating a user id here would put a human's name
      // on an automated grant, which is the exact failure `granted_by_*` was
      // added to prevent. `granted_via` carries the true story.
      grantedByUserId: null,
      grantedByPubkey: null,
      grantedVia: via,
    });
    out.granted++;
  }

  // The removal sweep. Only rows this binding wrote, only on this vault, and
  // only for users NONE of whose linked keys are in the roster (a hub account
  // may carry several keys — an agent's and a human's — and any one of them
  // being seated is enough to keep the access).
  const removeVault = deps.removeUserVault ?? removeUserVaultDefault;
  const candidates = rowsOwnedByBinding(db, binding.vault, via).filter((row) => {
    const keys = pubkeysForUser(db, row.user_id);
    return !keys.some((k) => rosterKeys.has(k));
  });
  if (candidates.length > 0) {
    // ONE transaction for the whole sweep — unlike the additions loop above
    // (which cannot span a transaction: `ensureUserForPubkey` awaits argon2),
    // removal is synchronous end to end, so the all-or-nothing property is
    // free. A thrown exception partway through must not leave some grants
    // revoked and others not: the next pass, 60 seconds later, gets a clean
    // slate to retry the whole sweep from, same freeze-don't-half-drop
    // posture as an unreachable relay.
    let removedUserIds: string[] = [];
    try {
      db.transaction(() => {
        removedUserIds = [];
        for (const row of candidates) {
          if (removeVault(db, row.user_id, binding.vault, now)) removedUserIds.push(row.user_id);
        }
      })();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      out.errors++;
      log(
        `channel reconcile: removal sweep failed vault=${binding.vault} relay=${binding.relayHost} ` +
          `channel=${binding.channelId} detail=${detail} (rolled back — no grants were removed)`,
      );
      removedUserIds = [];
    }
    for (const userId of removedUserIds) {
      out.removed++;
      // The row is gone by design (revoke is a delete, not a tombstone), so
      // this line is the only surviving record. Same key=value shape as
      // `revokeAccess`'s audit line.
      log(
        `channel reconcile: vault access removed vault=${binding.vault} subject_user_id=${userId} ` +
          `relay=${binding.relayHost} channel=${binding.channelId} reason=not_in_roster`,
      );
    }
  }

  markChannelVaultSynced(db, binding.relayHost, binding.channelId, now());
  return out;
}

/** Rate-limited one-line failure report, keyed by (binding, reason). */
function logFailure(
  binding: ChannelVault,
  reason: string,
  detail: string | undefined,
  deps: ReconcilerDeps,
  log: (line: string) => void,
): void {
  const limiter = deps.limiter ?? createFailureLogLimiter();
  const windowMs = deps.failureLogIntervalMs ?? FAILURE_LOG_INTERVAL_MS;
  const key = `${binding.relayHost} ${binding.channelId} ${reason}`;
  const at = (deps.now ?? (() => new Date()))().getTime();
  const previous = limiter.last.get(key);
  if (previous !== undefined && at - previous < windowMs) return;
  limiter.last.set(key, at);
  const why = `reason=${reason}${detail ? ` detail=${detail}` : ""}`;
  log(
    `channel reconcile: roster fetch failed relay=${binding.relayHost} channel=${binding.channelId} ` +
      `vault=${binding.vault} ${why} (grants retained, synced_at left stale)`,
  );
}

/**
 * One full pass over every `sync` binding.
 *
 * Two cheap gates before any work: no usable reader key means the hub has not
 * opted into channel-attached vaults at all (`not_configured` is the ordinary
 * state of most hubs, not an error), and no `sync` binding means there is
 * nothing to poll. Both are re-checked EVERY tick rather than at boot, so an
 * operator who attaches a channel — or drops the key file in — does not have
 * to restart the hub. Bindings run in the order `listChannelVaults` returns
 * (relay, channel), so a pass is deterministic.
 *
 * Never throws: one binding's unexpected error is logged and counted, and the
 * remaining bindings still run.
 */
export async function runReconcileOnce(
  deps: ReconcilerDeps,
  only?: readonly ChannelBindingKey[],
): Promise<ReconcileRunResult> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const key = loadBuzzReaderKey(deps.rosterOptions?.env, deps.rosterOptions?.configDir);
  if (!key.ok) {
    return {
      ran: false,
      reason: key.reason === "not_configured" ? "not_configured" : "key_unreadable",
      bindings: [],
    };
  }
  let bindings = listChannelVaults(deps.db).filter((b) => b.mode === "sync");
  if (only !== undefined) {
    // A live-subscription-driven pass touches only the bindings the relay
    // said changed. The `sync` filter still applies and the rows are still
    // re-read from the DB, so a binding frozen or detached between the event
    // and this call is correctly skipped rather than reconciled from a stale
    // snapshot.
    const wanted = new Set(only.map((k) => `${k.relayHost} ${k.channelId}`));
    bindings = bindings.filter((b) => wanted.has(`${b.relayHost} ${b.channelId}`));
  }
  if (bindings.length === 0) return { ran: false, reason: "no_sync_bindings", bindings: [] };

  const results: ReconcileBindingResult[] = [];
  for (const binding of bindings) {
    try {
      results.push(await reconcileBinding(binding, deps));
    } catch (err) {
      // A reconcile should never throw (the fetcher returns values and every
      // per-member failure is caught), but a bug here must not stop the other
      // bindings or take the timer down.
      const detail = err instanceof Error ? err.message : String(err);
      log(
        `channel reconcile: unexpected error relay=${binding.relayHost} ` +
          `channel=${binding.channelId} vault=${binding.vault} detail=${detail}`,
      );
      results.push({
        relayHost: binding.relayHost,
        channelId: binding.channelId,
        vault: binding.vault,
        status: "failed",
        reason: "internal_error",
        members: 0,
        granted: 0,
        removed: 0,
        createdUsers: 0,
        unchanged: 0,
        deferred: 0,
        errors: 1,
      });
    }
  }
  return { ran: true, bindings: results };
}

/** Handle to stop a running reconciler (shutdown + test cleanup). */
export interface ChannelReconciler {
  /** Stops the poll timer AND every live subscription socket. */
  stop(): void;
  /**
   * Live-subscription state per relay host. Empty when subscriptions are off
   * (`liveSubscriptions: false`) or when no `sync` binding exists yet.
   * Diagnostics only — nothing reads it to decide access.
   */
  subscriptionStates(): Map<string, SubscriptionState>;
}

export interface ChannelReconcilerDeps<H = unknown> extends ReconcilerDeps {
  /** Poll cadence. Default {@link CHANNEL_RECONCILE_INTERVAL_MS}. */
  intervalMs?: number;
  /** Injectable scheduler (default `setInterval`). Tests drive ticks manually. */
  setIntervalFn?: (cb: () => void, ms: number) => H;
  /** Injectable clear (default `clearInterval`). */
  clearIntervalFn?: (handle: H) => void;
  /**
   * The live subscription half. Omit for the real thing; pass overrides
   * (a loopback `wsUrlFor`, shorter backoffs) to point it at a fake; pass
   * `false` to run poll-only.
   *
   * `false` exists for tests that are about the timer and would otherwise
   * dial a real relay host out of a fixture — it is not an operator surface,
   * and there is deliberately no env var for it: a subscription that fails is
   * already inert, so an operator who wants poll-only already has it.
   */
  liveSubscriptions?: false | Partial<ChannelSubscriptionDeps>;
}

/**
 * Start the 60-second poll — or don't.
 *
 * Returns `null`, and starts NO timer, when the hub has no usable Buzz reader
 * key. That is the ordinary state of a hub that has not opted into
 * channel-attached vaults, and an opt-in feature should cost such a hub
 * exactly nothing: no timer, no wakeups, no log line every minute about a file
 * that was never meant to exist. An operator who adds the key restarts the
 * hub, which is the same ceremony every other credential file already asks
 * for.
 *
 * The presence of a `sync` binding is deliberately NOT a start condition — it
 * is re-checked on every tick — because bindings are attached at runtime while
 * the key is not.
 *
 * Ticks never overlap: a poll that is still running (a slow relay against a
 * 10s timeout) makes the next tick a no-op rather than stacking a second pass
 * on the same rows. Errors are swallowed and logged; an interval callback must
 * never take the hub down.
 */
export function startChannelReconciler<H = ReturnType<typeof setInterval>>(
  deps: ChannelReconcilerDeps<H>,
): ChannelReconciler | null {
  const log = deps.log ?? ((line: string) => console.log(line));
  const key = loadBuzzReaderKey(deps.rosterOptions?.env, deps.rosterOptions?.configDir);
  if (!key.ok) {
    if (key.reason !== "not_configured") {
      // A key file that exists but cannot be used is an operator typo, not an
      // opt-out — say so once, at boot, and stay off.
      log(
        `parachute hub: Buzz reader key at ${key.path} is ${key.reason}; channel membership sync is OFF until it is fixed.`,
      );
    }
    return null;
  }

  const intervalMs = deps.intervalMs ?? CHANNEL_RECONCILE_INTERVAL_MS;
  const setIntervalFn =
    deps.setIntervalFn ?? ((cb: () => void, ms: number) => setInterval(cb, ms) as unknown as H);
  const clearIntervalFn =
    deps.clearIntervalFn ??
    ((h: H) => clearInterval(h as unknown as ReturnType<typeof setInterval>));
  // One limiter for the life of the timer — that is what makes the rate limit
  // hold ACROSS ticks rather than resetting every minute.
  const limiter = deps.limiter ?? createFailureLogLimiter();

  // THE re-entrancy guard — one flag, shared by the timer and the live
  // subscription. `tryRun` returning false is how the subscription learns a
  // pass is in flight; it re-arms its debounce rather than stacking a second
  // pass on the same rows.
  let running = false;
  function tryRun(only?: readonly ChannelBindingKey[]): boolean {
    if (running) return false;
    running = true;
    void runReconcileOnce({ ...deps, limiter }, only)
      .catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        log(`parachute hub: channel reconcile pass threw unexpectedly (${detail}); ignoring.`);
      })
      .finally(() => {
        running = false;
      });
    return true;
  }

  // Started before the timer so the sockets are up for the first minute
  // rather than after it. `null` here (no key — already checked above, or a
  // deliberate `false`) simply means poll-only; nothing downstream cares.
  const subscriptions: ChannelSubscriptions | null =
    deps.liveSubscriptions === false
      ? null
      : startChannelSubscriptions({
          db: deps.db,
          log,
          limiter,
          requestReconcile: tryRun,
          ...(deps.rosterOptions?.env !== undefined ? { env: deps.rosterOptions.env } : {}),
          ...(deps.rosterOptions?.configDir !== undefined
            ? { configDir: deps.rosterOptions.configDir }
            : {}),
          ...(deps.now !== undefined ? { now: deps.now } : {}),
          ...deps.liveSubscriptions,
        });

  const handle = setIntervalFn(() => {
    // Bindings attached or detached at runtime by the CLI go live on the next
    // tick rather than instantly — the hub has no change feed on its own
    // tables, and a poll interval of staleness on a socket set is invisible
    // next to the poll the socket is accelerating.
    subscriptions?.refresh();
    tryRun();
  }, intervalMs);
  // A membership poll is a background chore; it must not be the reason the
  // process stays alive.
  (handle as { unref?: () => void }).unref?.();

  return {
    stop() {
      clearIntervalFn(handle);
      subscriptions?.stop();
    },
    subscriptionStates() {
      return subscriptions?.states() ?? new Map();
    },
  };
}
