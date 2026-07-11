/**
 * The shared vault-scope validator for a per-vault token mint
 * (`POST /account/vaults/<name>/token`) — the ONE implementation replacing the
 * two that grew independently: hub's `parseScopesBody` (`account-api.ts`, the
 * scope-shape part) and cloud's local `validateVaultScopes`
 * (`workers/identity/src/account-api.ts`). Pure, no runtime dependencies — the
 * cross-repo derived-key lesson: reconcile behavior in ONE place both doors
 * import, don't keep two impls in sync by hand.
 *
 * Pinned semantics (reconciles the two doors' prior behavior):
 *   - `undefined` / `null` / `[]` (absent, explicit null, or an empty array) →
 *     the default read+write pair for the vault (hub's prior lenient reading —
 *     hub is the door with real users today; cloud's prior `[]` → reject
 *     changes to match in P3).
 *   - Every entry must be exactly `vault:<vaultName>:{read|write|admin}` for
 *     THIS vault name — a different vault, a non-vault resource
 *     (`account:*`), an unknown verb, or a non-string entry all reject the
 *     WHOLE request (`{ ok: false }`), never a partial scope list.
 *   - The result is de-duplicated (cloud's prior `Set` behavior).
 */

/** The three verbs mintable on a per-vault token. */
const MINTABLE_VAULT_VERBS = new Set(["read", "write", "admin"]);

/**
 * Why a scopes request was rejected — carries the door's wire error code so a
 * door adopting this validator keeps its exact HTTP error without re-deriving
 * the split (hub's `parseScopesBody` distinguishes these two today):
 *   - `invalid_request` — the value is structurally wrong: not an array, or an
 *     entry that isn't a string. "You sent me garbage."
 *   - `invalid_scope` — every entry is a string, but at least one isn't
 *     `vault:<vaultName>:{read|write|admin}`. "Well-formed, but not mintable here."
 */
export type VaultScopesReason = "invalid_request" | "invalid_scope";

/** A conformant scopes array, or the sentinel rejection with its wire reason. */
export type VaultScopesResult =
  | { ok: true; scopes: string[] }
  | { ok: false; reason: VaultScopesReason };

/**
 * Validate a requested `scopes` value against `vaultName`. `requested` is
 * `unknown` because it comes straight off a parsed JSON body — the caller
 * hasn't type-narrowed it yet.
 */
export function validateVaultScopes(requested: unknown, vaultName: string): VaultScopesResult {
  if (requested === undefined || requested === null) {
    return { ok: true, scopes: defaultVaultScopes(vaultName) };
  }
  // Whole-array structural check FIRST (byte-exact with hub's `parseScopesBody`,
  // which does `!Array.isArray || requested.some(non-string)` before the per-entry
  // scope loop): a non-array, or ANY non-string entry, is `invalid_request` — even
  // when a well-formed-but-wrong scope string sits earlier in the array. Without
  // this pre-scan a mixed array like `["vault:other:read", 123]` would positionally
  // report `invalid_scope`, flipping hub's wire code on adoption (P2/P3).
  if (!Array.isArray(requested) || requested.some((s) => typeof s !== "string")) {
    return { ok: false, reason: "invalid_request" };
  }
  if (requested.length === 0) {
    return { ok: true, scopes: defaultVaultScopes(vaultName) };
  }
  const scopes = new Set<string>();
  for (const s of requested as string[]) {
    const parts = s.split(":");
    if (parts.length !== 3) return { ok: false, reason: "invalid_scope" };
    const [resource, name, verb] = parts as [string, string, string];
    if (resource !== "vault" || name !== vaultName || !MINTABLE_VAULT_VERBS.has(verb)) {
      return { ok: false, reason: "invalid_scope" };
    }
    scopes.add(s);
  }
  return { ok: true, scopes: [...scopes] };
}

function defaultVaultScopes(vaultName: string): string[] {
  return [`vault:${vaultName}:read`, `vault:${vaultName}:write`];
}
