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
