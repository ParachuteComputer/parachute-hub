/**
 * The account-door scope grammar — `account:<id>:<verb>`, `admin ⊇ read`.
 *
 * Both doors gate their `/account/*` surface on this grammar and re-implement it
 * separately today: the self-host hub pins `<id>` to the `self` sentinel
 * (account ≡ box, `src/scope-explanations.ts`), the hosted cloud uses the
 * per-user account id (`workers/identity/src/account-auth.ts` with its own
 * `AccountVerb` + `ACCOUNT_VERB_RANK`). The grammar and the verb ladder are
 * identical; this is the shared definition.
 *
 * This is the account-scope sibling of `@openparachute/scope-guard`'s vault
 * scope matcher — kept here (not there) because it's part of the door/account
 * contract, not the resource-server JWT-validation surface scope-guard owns.
 */

/** The two-rung account verb ladder. */
export type AccountVerb = "read" | "admin";

/** `admin ⊇ read`. */
export const ACCOUNT_VERB_RANK: Record<AccountVerb, number> = { read: 0, admin: 1 };

/** The self-host account sentinel — on a hub the account IS the box. */
export const ACCOUNT_SELF_ID = "self";

/** `account:self:admin` — the self-host canonical admin scope. */
export const ACCOUNT_SELF_ADMIN_SCOPE = "account:self:admin";
/** `account:self:read` — the self-host canonical read scope. */
export const ACCOUNT_SELF_READ_SCOPE = "account:self:read";

export function isAccountVerb(s: string): s is AccountVerb {
  return s === "read" || s === "admin";
}

/** Build the `account:<id>:<verb>` scope string. */
export function accountScope(id: string, verb: AccountVerb): string {
  return `account:${id}:${verb}`;
}

/**
 * Parse an `account:<id>:<verb>` scope. Returns `null` for anything that is not
 * exactly a 3-part account scope with a known verb (a 2-part `account:admin`, a
 * vault scope, a malformed string) — mirrors both doors' decomposition.
 */
export function parseAccountScope(scope: string): { id: string; verb: AccountVerb } | null {
  const parts = scope.split(":");
  if (parts.length !== 3) return null;
  const [resource, id, verb] = parts as [string, string, string];
  if (resource !== "account" || id.length === 0 || !isAccountVerb(verb)) return null;
  return { id, verb };
}

/**
 * Does the granted scope set satisfy `verb` on `accountId`? `admin` satisfies a
 * `read` requirement; a scope for a different `<id>` never matches. Identical to
 * cloud's `hasAccountScope` and the semantics the hub's exact-string gate
 * assumes (`account:self:admin` covers `account:self:read`).
 */
export function hasAccountScope(
  granted: readonly string[],
  accountId: string,
  verb: AccountVerb,
): boolean {
  const reqRank = ACCOUNT_VERB_RANK[verb];
  for (const s of granted) {
    const d = parseAccountScope(s);
    if (!d) continue;
    if (d.id !== accountId) continue;
    if (ACCOUNT_VERB_RANK[d.verb] >= reqRank) return true;
  }
  return false;
}

/**
 * The account-vaults scope family (Wave A) — the SINGLE deliberate exception to
 * the account wall. `account:<id>:{admin,read}` stay non-requestable (an OAuth
 * client can never ask for the whole account); the ONE requestable account scope
 * is the account-MCP connection scope `account:<id>:vaults`, which opens exactly
 * the narrow account-MCP surface (list-vaults + create-vault + query-across).
 *
 * Two forms carry the grant:
 *   - `account:vaults` — the un-narrowed, PRM-advertised request form (no id yet;
 *     the door binds the id at consent).
 *   - `account:<id>:vaults` — the consent-bound BLANKET grant: every vault the
 *     account owns.
 *   - `account:<id>:vaults:<vault>` — the consent-NARROWED grant: only the named
 *     vault(s). The narrowing rides the SCOPE STRING (not a side `vault_scope`
 *     claim, which doesn't survive token refresh), so a set of 4-part scopes is
 *     how "these specific vaults" is expressed on the wire.
 *
 * The 4-part narrowed form is deliberately NOT requestable — a client asks for
 * the blanket/un-narrowed form and the CONSENT step narrows it; a client cannot
 * pre-narrow itself into a specific-vault grant.
 */

/** The verb rung that opens the account-MCP surface. */
export const ACCOUNT_VAULTS_VERB = "vaults";

/** The un-narrowed, PRM-advertised request form (`account:vaults`, id bound at consent). */
export const ACCOUNT_VAULTS_UNNARROWED = "account:vaults";

/** Build the consent-bound blanket account-vaults scope (`account:<id>:vaults`). */
export function accountVaultsScope(id: string): string {
  return `account:${id}:${ACCOUNT_VAULTS_VERB}`;
}

/**
 * Is `scope` a REQUESTABLE account scope? The account wall stays closed to
 * everything except the account-vaults connection scope:
 *   - `account:vaults` (un-narrowed, PRM form) → requestable.
 *   - `account:<id>:vaults` (consent-bound blanket) → requestable.
 *   - `account:<id>:{admin,read}`, `account:admin`, `account:read` → NOT.
 *   - `account:<id>:vaults:<vault>` (4-part, consent-narrowed) → NOT (consent
 *     narrows; a client can't pre-narrow itself).
 *
 * Exact-lowercase: casing variants (`Account:...`, `...:Vaults`) fail closed.
 */
export function isRequestableAccountScope(scope: string): boolean {
  const parts = scope.split(":");
  if (parts[0] !== "account") return false;
  if (parts.length === 2) return parts[1] === "vaults";
  if (parts.length === 3) {
    const [, id, verb] = parts as [string, string, string];
    return verb === ACCOUNT_VAULTS_VERB && id.length > 0;
  }
  return false;
}

/**
 * Parse an `account:<id>:vaults[:<vault>]` scope into its id + (optional) vault.
 *   - 3-part `account:<id>:vaults` → `{ id, vault: null }` (blanket).
 *   - 4-part `account:<id>:vaults:<vault>` → `{ id, vault }` (narrowed).
 *   - anything else (wrong resource, wrong verb, empty id/vault, extra parts) →
 *     `null`.
 * Fail-closed: an empty id or empty vault name yields `null`.
 */
export function parseAccountVaultsScope(
  scope: string,
): { id: string; vault: string | null } | null {
  const parts = scope.split(":");
  if (parts[0] !== "account") return null;
  if (parts.length === 3) {
    const [, id, verb] = parts as [string, string, string];
    if (verb !== ACCOUNT_VAULTS_VERB || id.length === 0) return null;
    return { id, vault: null };
  }
  if (parts.length === 4) {
    const [, id, verb, vault] = parts as [string, string, string, string];
    if (verb !== ACCOUNT_VAULTS_VERB || id.length === 0 || vault.length === 0) return null;
    return { id, vault };
  }
  return null;
}

/**
 * Derive what an account-vaults grant COVERS for `accountId` from a granted
 * scope set:
 *   - `{ blanket: true }` — a bare 3-part `account:<accountId>:vaults` is present
 *     (blanket always wins; it covers every vault the account owns).
 *   - `{ vaults: [...] }` — no blanket, but one or more 4-part
 *     `account:<accountId>:vaults:<vault>` are present (the de-duped set of the
 *     specifically-granted vault names).
 *   - `null` — no account-vaults scope for THIS id at all.
 * Scopes for a different `<id>` are ignored (a grant for account A never covers
 * account B).
 */
export function accountVaultsGrant(
  grantedScopes: readonly string[],
  accountId: string,
): { blanket: true } | { vaults: string[] } | null {
  const vaults: string[] = [];
  for (const s of grantedScopes) {
    const parsed = parseAccountVaultsScope(s);
    if (!parsed || parsed.id !== accountId) continue;
    if (parsed.vault === null) return { blanket: true };
    if (!vaults.includes(parsed.vault)) vaults.push(parsed.vault);
  }
  return vaults.length > 0 ? { vaults } : null;
}
