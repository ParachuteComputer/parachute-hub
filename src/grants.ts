/**
 * Grants — record of "user U has approved scope-set S for client C".
 *
 * Closes #75. The OAuth consent screen is UX, not protocol — RFC 6749 §3
 * doesn't mandate it. Once a user has approved a set of scopes for a given
 * client, re-running the same flow with the same (or a subset of) scopes
 * shouldn't show consent again. Token-endpoint scope validation still gates
 * actual issuance, so this is purely about not re-asking the human.
 *
 * Storage: one row per (user_id, client_id) in the `grants` table (created
 * in hub-db migration v3). The `scopes` column is a space-separated set of
 * every scope the user has ever approved for this client — recording is
 * UNION semantics, not overwrite. That way, a user who approved [a, b, c]
 * once and later approves only [a, b] for an incremental flow doesn't lose
 * their c grant; the next flow asking [a, c] still skips consent.
 *
 * Skip rule: a flow may skip consent iff every requested scope is already
 * in the grant's set. A strict superset (the client wants something new)
 * shows the consent screen with the full requested set so the user is
 * approving the new addition explicitly. A strict subset skips.
 *
 * Re-registered clients have a fresh client_id, so grants are not carried
 * across — a re-registered app must earn consent again. That's by design:
 * if the client_id changed, the operator can't tell from the URL whether
 * it's the same app or an impostor.
 */

import type { Database } from "bun:sqlite";

export interface Grant {
  userId: string;
  clientId: string;
  scopes: string[];
  grantedAt: string;
}

interface GrantRow {
  user_id: string;
  client_id: string;
  scopes: string;
  granted_at: string;
}

function rowToGrant(row: GrantRow): Grant {
  return {
    userId: row.user_id,
    clientId: row.client_id,
    scopes: row.scopes.split(" ").filter((s) => s.length > 0),
    grantedAt: row.granted_at,
  };
}

/** Look up the grant for (user, client). Returns null when none exists. */
export function findGrant(db: Database, userId: string, clientId: string): Grant | null {
  const row = db
    .prepare(
      "SELECT user_id, client_id, scopes, granted_at FROM grants WHERE user_id = ? AND client_id = ?",
    )
    .get(userId, clientId) as GrantRow | undefined;
  return row ? rowToGrant(row) : null;
}

/**
 * Record a consent approval. Merges `newScopes` into any existing grant for
 * (user, client) — UNION semantics — and bumps `granted_at` to `now`. Empty
 * `newScopes` is a no-op (we don't want to insert empty rows).
 */
export function recordGrant(
  db: Database,
  userId: string,
  clientId: string,
  newScopes: readonly string[],
  now: Date = new Date(),
): Grant {
  // Wrapped in a transaction so the read-merge-write is atomic. Without
  // this, two concurrent consents for the same (user, client) could both
  // SELECT the same prior row and then race to INSERT OR REPLACE, with the
  // later writer's UNION missing scopes the earlier writer added.
  return db.transaction(() => {
    const existing = findGrant(db, userId, clientId);
    const merged = new Set<string>(existing?.scopes ?? []);
    for (const s of newScopes) {
      if (s.length > 0) merged.add(s);
    }
    const scopes = Array.from(merged).sort();
    const grantedAt = now.toISOString();
    db.prepare(
      `INSERT OR REPLACE INTO grants (user_id, client_id, scopes, granted_at)
       VALUES (?, ?, ?, ?)`,
    ).run(userId, clientId, scopes.join(" "), grantedAt);
    return { userId, clientId, scopes, grantedAt };
  })();
}

/**
 * Test whether `requestedScopes` is fully covered by the existing grant —
 * the rule for skipping the consent screen. Returns false when:
 *   - no grant exists for (user, client), or
 *   - any requested scope is missing from the grant's set, or
 *   - `requestedScopes` is empty (we don't auto-approve "ask for nothing"
 *     flows; they're almost certainly client bugs and showing consent will
 *     surface that to the operator).
 */
export function isCoveredByGrant(
  db: Database,
  userId: string,
  clientId: string,
  requestedScopes: readonly string[],
): boolean {
  if (requestedScopes.length === 0) return false;
  const grant = findGrant(db, userId, clientId);
  if (!grant) return false;
  const granted = new Set(grant.scopes);
  for (const s of requestedScopes) {
    if (!granted.has(s)) return false;
  }
  return true;
}

/**
 * Find the most-recent grant for a user across any client matching the
 * given client_name. Used to support "trust an app by name" — once a
 * user approves a `client_name` like `"claude-code"`, future DCRs with
 * the same name auto-trust without re-asking. Returns null when no
 * grant exists for any client of this name.
 *
 * Why: CLI MCP clients (Claude Code et al.) re-DCR on every `mcp add`
 * (or every session), each landing a fresh `client_id`. Strict
 * (user, client_id) grants force re-approval every time even though
 * the operator has approved the same app many times before. Matching
 * by client_name reflects the operator's actual mental model — "I
 * approved Claude" — not the protocol's mental model — "I approved
 * this specific client_id."
 *
 * Tradeoff: an attacker who can register a client with a known-trusted
 * name (e.g. `"claude-code"`) gets auto-trust on first authorize. The
 * defenses we kept:
 *   1. Admin-scope flows still show consent (handled by the caller,
 *      not this helper).
 *   2. The audit log records each auto-trust event with both client_ids
 *      (the original trusted one + the freshly auto-trusted one).
 *   3. The Permissions admin SPA shows trusted client_names so the
 *      operator can revoke trust by name.
 *
 * Closes hub#409 (Aaron 2026-05-26: "asking for approval every time…
 * once we've approved something like Claude once it should not need
 * admin approval every other time").
 */
export function findGrantByClientName(
  db: Database,
  userId: string,
  clientName: string,
): Grant | null {
  if (!clientName) return null;
  const row = db
    .prepare(
      `SELECT g.user_id, g.client_id, g.scopes, g.granted_at
       FROM grants g
       JOIN clients c ON g.client_id = c.client_id
       WHERE g.user_id = ? AND c.client_name = ?
       ORDER BY g.granted_at DESC
       LIMIT 1`,
    )
    .get(userId, clientName) as GrantRow | undefined;
  return row ? rowToGrant(row) : null;
}

/**
 * Test whether `requestedScopes` is covered by ANY grant for the given
 * client_name + user. The client_name-keyed counterpart to
 * `isCoveredByGrant`. Used by /oauth/authorize to skip BOTH the
 * approve-pending screen + the consent screen when the operator has
 * previously approved a same-named client with sufficient scopes.
 */
export function isCoveredByGrantForClientName(
  db: Database,
  userId: string,
  clientName: string,
  requestedScopes: readonly string[],
): boolean {
  if (requestedScopes.length === 0) return false;
  const grant = findGrantByClientName(db, userId, clientName);
  if (!grant) return false;
  const granted = new Set(grant.scopes);
  for (const s of requestedScopes) {
    if (!granted.has(s)) return false;
  }
  return true;
}

/** All grants for a user, ordered most-recent first. Used by `parachute auth list-grants`. */
export function listGrantsForUser(db: Database, userId: string): Grant[] {
  const rows = db
    .prepare(
      "SELECT user_id, client_id, scopes, granted_at FROM grants WHERE user_id = ? ORDER BY granted_at DESC",
    )
    .all(userId) as GrantRow[];
  return rows.map(rowToGrant);
}

/**
 * Delete a grant. Returns true when a row was removed; false when no grant
 * existed for (user, client). Note this does not revoke existing tokens —
 * an operator who wants to revoke active sessions runs `/oauth/revoke` (or
 * its CLI wrapper) separately. Removing the grant only forces the next
 * /oauth/authorize flow to show consent again.
 */
export function revokeGrant(db: Database, userId: string, clientId: string): boolean {
  const res = db
    .prepare("DELETE FROM grants WHERE user_id = ? AND client_id = ?")
    .run(userId, clientId);
  return res.changes > 0;
}
