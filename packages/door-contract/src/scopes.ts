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

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * The COMPOSED account-scope grammar (unified `/mcp` — Phase 1).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The ratified unified-MCP design collapses the many per-resource MCP endpoints
 * into ONE `/mcp` gateway. Its OAuth consent composes a single grant spanning the
 * account, its vaults (a wildcard over every owned vault, a set of named vaults,
 * or one vault — each at a verb), the "create new vaults" capability, and future
 * modules. The whole composed grant rides on ONE `aud="account"` token; the
 * gateway decomposes it per-call into 60s single-audience mints.
 *
 * Because the composed grant is decomposed by the gateway (never handed to a
 * resource server directly), ALL composed vault/module authority is encoded
 * INSIDE the `account:` namespace — deliberately NOT as a raw `vault:<name>:<verb>`
 * scope, which `inferAudience` would stamp as a vault audience and route around
 * the gateway. The `account:<id>:…` prefix keeps every composed grant on the
 * account token where the gateway owns decomposition.
 *
 * This Phase-1 PR only DEFINES + PARSES the grammar. Nothing emits or mints these
 * forms yet; consent, minting, and the gateway are later phases that consume this
 * vocabulary. Every new form below is NON-REQUESTABLE — a client can never
 * pre-narrow or pre-widen itself into one; the consent step is the sole author.
 *
 * The composed granted forms (all built by consent, never requested):
 *   - `account:<id>:vaults:*:<verb>`      — WILDCARD vault grant: every vault the
 *                                            account owns, at `<verb>`. `*` can
 *                                            never collide with a vault name (the
 *                                            vault-name charset excludes `*`).
 *   - `account:<id>:vaults:<vault>:<verb>` — a PER-VAULT grant at `<verb>` (5-part).
 *   - `account:<id>:vault-create`          — the "create new vaults" capability
 *                                            (3-part; a distinct `vault-create`
 *                                            verb-slot, NOT a member of the
 *                                            `vaults` family).
 *   - `account:<id>:mod:<module>:<verb>`   — a MODULE grant (future modules).
 *
 * `<verb>` here is the three-rung vault/module ladder `read|write|admin` (NOT the
 * two-rung account ladder `read|admin` — a composed vault grant can be `write`).
 *
 * The LEGACY Wave A forms keep their exact meaning, frozen — existing tokens and
 * refresh families must parse identically:
 *   - `account:<id>:vaults`          — the blanket account-vaults connection grant.
 *   - `account:<id>:vaults:<vault>`  — the consent-narrowed 4-part grant.
 * Neither carries a verb; they remain `accountVaultsGrant`'s domain and are NOT
 * folded into the composed coverage below (which is verb-carrying).
 */

/** The three-rung composed vault/module verb ladder (`admin ⊇ write ⊇ read`). */
export type ComposedVaultVerb = "read" | "write" | "admin";

/** `admin ⊇ write ⊇ read` — the rank used for "requiredVerb ≤ grantedVerb" checks. */
export const COMPOSED_VERB_RANK: Record<ComposedVaultVerb, number> = {
  read: 0,
  write: 1,
  admin: 2,
};

/** Narrow an arbitrary string to a composed vault/module verb. */
export function isComposedVaultVerb(s: string): s is ComposedVaultVerb {
  return s === "read" || s === "write" || s === "admin";
}

/**
 * Does a `granted` verb satisfy a `required` verb on the composed ladder? `admin`
 * satisfies `write` and `read`; `write` satisfies `read`. The later gateway/mint
 * phases use this for "the call needs `read`, the grant carries `write` → allow".
 */
export function composedVerbSatisfies(
  granted: ComposedVaultVerb,
  required: ComposedVaultVerb,
): boolean {
  return COMPOSED_VERB_RANK[granted] >= COMPOSED_VERB_RANK[required];
}

/** The wildcard vault-slot sentinel (`account:<id>:vaults:*:<verb>`). */
export const COMPOSED_VAULTS_WILDCARD = "*";
/** The `vaults` family segment (composed vault grants + legacy Wave A forms). */
export const COMPOSED_VAULTS_SEGMENT = "vaults";
/** The 3-part "create new vaults" capability verb-slot. */
export const COMPOSED_VAULT_CREATE_VERB = "vault-create";
/** The `mod` family segment (`account:<id>:mod:<module>:<verb>`). */
export const COMPOSED_MODULE_SEGMENT = "mod";

/** A parsed composed account scope — the discriminated union over every family. */
export type ComposedAccountScope =
  | { kind: "wildcard-vaults"; id: string; verb: ComposedVaultVerb }
  | { kind: "vault"; id: string; vault: string; verb: ComposedVaultVerb }
  | { kind: "vault-create"; id: string }
  | { kind: "module"; id: string; module: string; verb: ComposedVaultVerb }
  | { kind: "legacy-blanket"; id: string }
  | { kind: "legacy-vault"; id: string; vault: string };

/**
 * Guard an interpolated composed-scope SLOT (an account `id`, a `vault` name, or
 * a `module` name) before a builder concatenates it into a scope string. A slot
 * may never be:
 *   - empty (`""`) — a builder must never emit a scope with a blank segment;
 *   - the wildcard sentinel `*` — wildcard authority is expressed ONLY by the
 *     dedicated `composedWildcardVaultsScope` builder; smuggling `*` through a
 *     name slot would forge a wildcard grant a consenting user never approved;
 *   - a value containing `:` — the scope separator, which would inject EXTRA
 *     segments (e.g. a `vault` of `"x:*"` becomes `…:vaults:x:*:<verb>`, forging
 *     a wildcard, or shifts the verb slot).
 *   - a value containing WHITESPACE — OAuth `scope` claims are space-delimited, so
 *     a space/tab/newline in a slot splits the scope on the wire into a fragment
 *     that can re-parse as a VALID (e.g. legacy) grant — it would NOT fail closed
 *     the way `:` does. Defense-in-depth: real slot sources are charset-constrained
 *     today, but this validation layer must be complete.
 * Throws a clear Error on violation so a malformed grant can never be built (and
 * therefore never minted) — fail-closed at construction time. Well-typed callers
 * pass real ids/names and never trip this; it exists to reject smuggled sentinels
 * and separator-injection at the door.
 */
function assertComposedSlot(kind: "id" | "vault" | "module", value: string): void {
  if (value.length === 0) {
    throw new Error(`composed scope ${kind} slot must not be empty`);
  }
  if (value === COMPOSED_VAULTS_WILDCARD) {
    throw new Error(
      `composed scope ${kind} slot must not be "*" — wildcard is composedWildcardVaultsScope's job, never a name`,
    );
  }
  if (value.includes(":")) {
    throw new Error(
      `composed scope ${kind} slot must not contain ":" (got ${JSON.stringify(value)})`,
    );
  }
  if (/\s/.test(value)) {
    throw new Error(
      `composed scope ${kind} slot must not contain whitespace (got ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Build the wildcard vault grant `account:<id>:vaults:*:<verb>`. Throws if `id`
 * is empty, `*`, or contains `:` (see `assertComposedSlot`). */
export function composedWildcardVaultsScope(id: string, verb: ComposedVaultVerb): string {
  assertComposedSlot("id", id);
  return `account:${id}:${COMPOSED_VAULTS_SEGMENT}:${COMPOSED_VAULTS_WILDCARD}:${verb}`;
}

/**
 * Build a per-vault grant `account:<id>:vaults:<vault>:<verb>`. Throws if `id` or
 * `vault` is empty, `*`, or contains `:` (see `assertComposedSlot`). */
export function composedVaultScope(id: string, vault: string, verb: ComposedVaultVerb): string {
  assertComposedSlot("id", id);
  assertComposedSlot("vault", vault);
  return `account:${id}:${COMPOSED_VAULTS_SEGMENT}:${vault}:${verb}`;
}

/**
 * Build the "create new vaults" capability `account:<id>:vault-create`. Throws if
 * `id` is empty, `*`, or contains `:` (see `assertComposedSlot`). */
export function composedVaultCreateScope(id: string): string {
  assertComposedSlot("id", id);
  return `account:${id}:${COMPOSED_VAULT_CREATE_VERB}`;
}

/**
 * Build a module grant `account:<id>:mod:<module>:<verb>`. Throws if `id` or
 * `module` is empty, `*`, or contains `:` (see `assertComposedSlot`). */
export function composedModuleScope(id: string, module: string, verb: ComposedVaultVerb): string {
  assertComposedSlot("id", id);
  assertComposedSlot("module", module);
  return `account:${id}:${COMPOSED_MODULE_SEGMENT}:${module}:${verb}`;
}

/**
 * Parse ANY composed account scope into its discriminated shape, or `null` for
 * anything unrecognized (fail-closed — mirrors `parseAccountVaultsScope`). This
 * recognizer is deliberately a SUPERSET: it covers both the new composed families
 * AND the legacy Wave A forms so that a single pass extracts `<id>` from every
 * `account:`-namespaced grant.
 *
 * §1.4 guardrail (unified-MCP design): the CLOUD door's cross-account mint gate
 * (`parachute-cloud workers/identity/src/oauth-token.ts`, `denyForeignAccountMint`)
 * id-checks only the forms its parser RECOGNIZES — a form that parses to `null`
 * would SKIP the id check. The composed forms are non-requestable (thus
 * unreachable by that gate today), but when a later phase makes them mintable the
 * gate must already extract their `<id>`. Recognizing every family HERE is what
 * lets the gate reject a foreign-id composed scope then.
 *
 * The `account:<id>:{read|admin}` account-verb ladder is intentionally NOT a
 * composed form (it is `parseAccountScope`'s domain) and yields `null` here.
 *
 * Fail-closed rules: `account` resource required, `<id>` non-empty, verbs from the
 * composed ladder, and `*` is ONLY ever the wildcard sentinel — it is never
 * accepted as a concrete vault OR module name (a 4-part `account:<id>:vaults:*`
 * and a 5-part `account:<id>:mod:*:<verb>` both → `null`).
 */
export function parseComposedAccountScope(scope: string): ComposedAccountScope | null {
  const parts = scope.split(":");
  if (parts[0] !== "account") return null;
  const id = parts[1];
  if (!id || id.length === 0) return null;

  if (parts.length === 3) {
    const slot = parts[2] as string;
    if (slot === COMPOSED_VAULTS_SEGMENT) return { kind: "legacy-blanket", id };
    if (slot === COMPOSED_VAULT_CREATE_VERB) return { kind: "vault-create", id };
    return null;
  }

  if (parts.length === 4) {
    // Legacy Wave A consent-narrowed form `account:<id>:vaults:<vault>`. `*` is
    // never a concrete vault name, so a `*` in the vault slot fails closed.
    const [, , family, vault] = parts as [string, string, string, string];
    if (family !== COMPOSED_VAULTS_SEGMENT) return null;
    if (vault.length === 0 || vault === COMPOSED_VAULTS_WILDCARD) return null;
    return { kind: "legacy-vault", id, vault };
  }

  if (parts.length === 5) {
    const [, , family, target, verb] = parts as [string, string, string, string, string];
    if (!isComposedVaultVerb(verb)) return null;
    if (family === COMPOSED_VAULTS_SEGMENT) {
      if (target === COMPOSED_VAULTS_WILDCARD) return { kind: "wildcard-vaults", id, verb };
      if (target.length === 0) return null;
      return { kind: "vault", id, vault: target, verb };
    }
    if (family === COMPOSED_MODULE_SEGMENT) {
      // `*` is never a concrete module name — a `*` in the module slot fails
      // closed (mirrors the vault slot above), so a wildcard sentinel can never
      // be smuggled in to forge an all-modules grant.
      if (target.length === 0 || target === COMPOSED_VAULTS_WILDCARD) return null;
      return { kind: "module", id, module: target, verb };
    }
    return null;
  }

  return null;
}

/**
 * The coverage a COMPOSED grant confers for one account id — derived from the
 * verb-carrying composed forms plus the create capability and modules:
 *   - `wildcard` — the highest wildcard verb granted (`account:<id>:vaults:*:<verb>`),
 *     or `null` if no wildcard vault grant is present. A wildcard covers every
 *     owned vault at that verb.
 *   - `vaults`   — a Map of vault-name → highest explicitly-granted verb
 *     (`account:<id>:vaults:<vault>:<verb>`).
 *   - `create`   — whether `account:<id>:vault-create` is present.
 *   - `modules`  — a Map of module-name → highest granted verb
 *     (`account:<id>:mod:<module>:<verb>`).
 * Duplicate/overlapping grants collapse to the highest verb per key. Foreign-id
 * scopes are ignored. The LEGACY (verb-less) `account:<id>:vaults[:<vault>]` forms
 * are NOT folded in here — they carry no verb and remain `accountVaultsGrant`'s
 * domain; this keeps legacy Wave A semantics untouched.
 */
export interface ComposedAccountCoverage {
  wildcard: ComposedVaultVerb | null;
  vaults: Map<string, ComposedVaultVerb>;
  create: boolean;
  modules: Map<string, ComposedVaultVerb>;
}

/** Fold `<verb>` into `map[key]`, keeping the higher rung. */
function raiseVerb(
  map: Map<string, ComposedVaultVerb>,
  key: string,
  verb: ComposedVaultVerb,
): void {
  const cur = map.get(key);
  if (!cur || COMPOSED_VERB_RANK[verb] > COMPOSED_VERB_RANK[cur]) map.set(key, verb);
}

export function composedAccountGrant(
  grantedScopes: readonly string[],
  accountId: string,
): ComposedAccountCoverage {
  const coverage: ComposedAccountCoverage = {
    wildcard: null,
    vaults: new Map(),
    create: false,
    modules: new Map(),
  };
  for (const s of grantedScopes) {
    const parsed = parseComposedAccountScope(s);
    if (!parsed || parsed.id !== accountId) continue;
    switch (parsed.kind) {
      case "wildcard-vaults":
        if (
          !coverage.wildcard ||
          COMPOSED_VERB_RANK[parsed.verb] > COMPOSED_VERB_RANK[coverage.wildcard]
        ) {
          coverage.wildcard = parsed.verb;
        }
        break;
      case "vault":
        raiseVerb(coverage.vaults, parsed.vault, parsed.verb);
        break;
      case "vault-create":
        coverage.create = true;
        break;
      case "module":
        raiseVerb(coverage.modules, parsed.module, parsed.verb);
        break;
      // Legacy verb-less forms are not part of the composed (verb-carrying)
      // coverage — they stay in `accountVaultsGrant`.
      case "legacy-blanket":
      case "legacy-vault":
        break;
    }
  }
  return coverage;
}
