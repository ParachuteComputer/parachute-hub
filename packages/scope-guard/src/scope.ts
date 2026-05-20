/**
 * Generic scope matcher with `admin ⊇ write ⊇ read` inheritance.
 *
 * Two shapes are recognized for inheritance:
 *
 *   - **Broad**     `<resource>:<verb>`               e.g. `vault:read`
 *   - **Narrowed**  `<resource>:<name>:<verb>`        e.g. `vault:work:write`
 *
 * Matching rules:
 *
 *   - Exact-string match always wins.
 *   - For broad-vs-broad and narrowed-vs-broad queries on the same resource,
 *     a granted scope satisfies the query if its verb rank is ≥ the required
 *     verb rank (admin=2, write=1, read=0).
 *   - Narrowed grants satisfy broad queries on the same resource (a
 *     `vault:work:write` token is *more* constrained than `vault:write`, but
 *     it's strictly enough to satisfy a `vault:write` check).
 *   - Broad grants do NOT satisfy narrowed queries through this function —
 *     consumers that want the reverse semantics (e.g. "this URL names vault
 *     `work`; does the token authorize it?") should write a per-resource
 *     wrapper or pass the resource-pinned form into `required` themselves.
 *   - Different `<resource>` never matches.
 *   - Verbs outside the `admin/write/read` ladder (e.g. `scribe:transcribe`)
 *     get exact-match-only treatment — `scribe:admin` does NOT imply
 *     `scribe:transcribe`. Cross-resource catch-alls are policy and belong
 *     in the consumer.
 */

type Verb = "read" | "write" | "admin";

const VERB_RANK: Record<Verb, number> = { read: 0, write: 1, admin: 2 };

function isVerb(s: string): s is Verb {
  return s === "read" || s === "write" || s === "admin";
}

interface Decomposed {
  resource: string;
  /** `null` for broad form (`<resource>:<verb>`), the name otherwise. */
  name: string | null;
  verb: Verb;
}

function decompose(scope: string): Decomposed | null {
  const parts = scope.split(":");
  if (parts.length === 2) {
    const resource = parts[0];
    const verb = parts[1];
    if (!resource || !verb || !isVerb(verb)) return null;
    return { resource, name: null, verb };
  }
  if (parts.length === 3) {
    const resource = parts[0];
    const name = parts[1];
    const verb = parts[2];
    if (!resource || !name || !verb || !isVerb(verb)) return null;
    return { resource, name, verb };
  }
  return null;
}

/**
 * Enforce the `vault_scope` claim: does this token authorize a request
 * targeting `requestVaultName`?
 *
 * The claim is the multi-user Phase 1 per-user vault pin — see
 * [`2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/).
 * Hub mints `vault_scope: [<assigned_vault>]` for non-admin users and
 * `vault_scope: []` for admin / unpinned users. Pre-PR-4 tokens lack the
 * claim entirely; the validate path surfaces those as `[]`.
 *
 * Decision matrix:
 *   - `vaultScope === []` → returns `true`. No per-user restriction —
 *     admin tokens, pre-PR-4 tokens, and any explicit "no pin" mint.
 *     This is the unrestricted sentinel; the upstream scope-string check
 *     (which always names the resource for hub-issued tokens) remains the
 *     primary gate, and `vault_scope` adds nothing here.
 *   - `vaultScope` contains `requestVaultName` → returns `true`. The user
 *     is pinned to a list that includes the target vault.
 *   - `vaultScope` is non-empty and excludes `requestVaultName` → returns
 *     `false`. The user is pinned to a different vault; the request must
 *     be refused with 403. This is the defense-in-depth case the claim
 *     exists for — even if a scope string somehow names the wrong vault
 *     (token-mint bug, manual edit, third-party RS not enforcing the
 *     scope-string vocabulary correctly), this check stops cross-vault
 *     access at the consumer.
 *
 * Phase 1 always has length ≤1; the list shape carries Phase 2 multi-vault
 * forward without a wire-shape change. The check is the same either way.
 *
 * Consumers use this from inside their hub-JWT auth path, *after*
 * `validateHubJwt` returns claims, *before* dispatching to the per-vault
 * handler. See `parachute-vault/src/auth.ts`'s `authenticateHubJwt` for
 * the canonical wire-up.
 */
export function enforceVaultScope(
  claims: { vaultScope: string[] },
  requestVaultName: string,
): boolean {
  if (claims.vaultScope.length === 0) return true;
  return claims.vaultScope.includes(requestVaultName);
}

/**
 * Does `granted` satisfy `required`?
 *
 *   - Exact string match → true
 *   - Both sides decompose to the inheritance ladder, same resource, and
 *     (a) required is broad form (any matching-resource grant with verb
 *     rank ≥ required satisfies), or
 *     (b) required is narrowed and granted is the same narrowed name
 *     with verb rank ≥ required.
 *   - Otherwise → false.
 */
export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;

  const reqD = decompose(required);
  if (!reqD) return false;
  const reqRank = VERB_RANK[reqD.verb];

  for (const g of granted) {
    const gD = decompose(g);
    if (!gD) continue;
    if (gD.resource !== reqD.resource) continue;

    if (reqD.name === null) {
      // Broad query: any same-resource grant (broad OR narrowed) with verb
      // rank ≥ required satisfies. Narrowed grant is strictly more specific
      // than broad query — token holder has access to a subset, not none.
      if (VERB_RANK[gD.verb] >= reqRank) return true;
    } else {
      // Narrowed query: only grants pinned to the same name (or the same
      // narrowed name) satisfy — broad grants do NOT satisfy narrowed
      // queries through this function. See module doc for rationale.
      if (gD.name === reqD.name && VERB_RANK[gD.verb] >= reqRank) return true;
    }
  }
  return false;
}
