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
