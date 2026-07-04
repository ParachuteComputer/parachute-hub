/**
 * Human-readable explanations for first-party Parachute OAuth scopes.
 *
 * Used by the consent screen to render each requested scope with a
 * one-sentence description, and by `/.well-known/oauth-authorization-server`
 * to populate `scopes_supported` (closes cli#68).
 *
 * Keep these short and operator-facing. The reader is the hub's owner
 * deciding whether to grant a third-party app access — they need to
 * understand *what data the app will see* in plain language, not the
 * technical contract.
 *
 * Third-party module scopes pass through here without an entry —
 * `explainScope` falls back to the raw scope string and the consent UI
 * renders them verbatim. cli#56 (drop SERVICE_SPECS) plus the eventual
 * `parachute.json` `scopes.defines` field will let modules ship their
 * own descriptions; until then, the canonical Parachute scopes are
 * hardcoded here.
 *
 * Source of truth for the scope shape:
 * `docs/contracts/oauth-scopes.md`.
 */

export interface ScopeExplanation {
  /** One-sentence operator-facing description of what the scope grants. */
  label: string;
  /**
   * "admin" scopes are highlighted in the consent UI — broad damage
   * potential if the requesting app is compromised, so we make the
   * operator look at them twice.
   */
  level: "read" | "write" | "admin" | "send";
}

export const SCOPE_EXPLANATIONS: Record<string, ScopeExplanation> = {
  "vault:read": {
    label: "Read your notes, tags, attachments, and vault config.",
    level: "read",
  },
  "vault:write": {
    label: "Create, edit, and delete notes, tags, and attachments.",
    level: "write",
  },
  "vault:admin": {
    label:
      "Read and write everything, plus admin: config & settings, triggers & automation, GitHub backup, and minting access tokens.",
    level: "admin",
  },
  // Optional-module scopes (scribe / agent / surface). These are in
  // FIRST_PARTY_SCOPES (= Object.keys(this map)) but the modules may not be
  // installed — so they're GATED in `OPTIONAL_MODULE_SCOPES` (oauth-handlers.ts)
  // and only advertised in `scopes_supported` when the service is in
  // services.json. If you add scopes for another optional module here, add a
  // matching gate there too, or a vault-only hub will over-advertise them (the
  // bug behind hub#489).
  "scribe:transcribe": {
    label: "Send audio to Scribe for transcription.",
    level: "write",
  },
  "scribe:admin": {
    label: "Manage Scribe configuration (provider keys, models, quotas).",
    level: "admin",
  },
  "agent:send": {
    label: "Post messages to your Agent.",
    level: "send",
  },
  // Surface Git Transport scopes (surface-host). `surface:read` = clone/fetch a
  // surface's hub-hosted git repo; `surface:write` = push to it. Named forms
  // (`surface:<name>:<verb>`) collapse to these via the 3→2-segment rule in
  // `isKnownScope`. surface-host's module.json declares them too; listing them
  // here makes them first-party (mintable + a consent label) even on a hub
  // where surface-host isn't installed.
  "surface:read": {
    label: "Clone and fetch a surface's source (its hub-hosted git repo).",
    level: "read",
  },
  "surface:write": {
    label: "Push to a surface's source (its hub-hosted git repo).",
    level: "write",
  },
  "hub:admin": {
    label: "Manage hub identity (user accounts, signing keys, registered OAuth clients).",
    level: "admin",
  },
  "parachute:host:admin": {
    label:
      "Provision and manage vaults across this host (create new vaults, configure cross-vault settings).",
    level: "admin",
  },
  // Fine-grained host scopes (#213) — the `parachute auth rotate-operator
  // --scope-set <set>` vocabulary. Each is a narrowing of `parachute:host:admin`:
  // an operator who wants a tighter token mints with one of these and uses
  // it in place of the broad operator.token. Operator-only (non-requestable).
  "parachute:host:install": {
    label: "Install or upgrade Parachute modules on this host.",
    level: "admin",
  },
  "parachute:host:start": {
    label: "Lifecycle Parachute modules on this host (start, stop, restart, status).",
    level: "admin",
  },
  "parachute:host:expose": {
    label: "Bring tailnet or public exposure layers up and down on this host.",
    level: "admin",
  },
  "parachute:host:auth": {
    label: "Mint hub-issued tokens and manage user accounts on this host.",
    level: "admin",
  },
  "parachute:host:vault": {
    label: "Administer vaults on this host (create, configure, delete).",
    level: "admin",
  },
};

/**
 * Sorted list of every first-party scope the hub recognizes. Used as the
 * baseline for `scopes_supported` in the OAuth-AS metadata; module-declared
 * scopes (cli#68) are unioned on top.
 */
export const FIRST_PARTY_SCOPES = Object.keys(SCOPE_EXPLANATIONS).sort();

/**
 * Scopes the hub will not mint via the public OAuth flow. Operator-only —
 * available exclusively through local mint paths that have already proven
 * the caller is the on-box operator:
 *
 *   - `parachute auth rotate-operator` writes the long-lived operator token
 *     (`~/.parachute/operator.token`, mode 0600) for service accounts.
 *   - `GET /admin/host-admin-token` exchanges a valid `parachute_hub_session`
 *     cookie (set by `/login` after a password check) for a
 *     short-lived JWT consumed by the in-tree vault-management SPA.
 *
 * Both surfaces predicate on local-operator identity that the public OAuth
 * flow can't establish. Listed here so the issuer can:
 *
 *   1. Reject early at `/oauth/authorize` with RFC 6749 `invalid_scope`
 *      rather than letting the request walk to the consent screen.
 *   2. Hide non-requestable scopes from `scopes_supported` in the AS
 *      metadata — clients shouldn't be advertised what we always reject.
 *      RFC 8414 §2 says `scopes_supported` is the list a client *can*
 *      request, so omitting these is the spec-compliant call.
 *
 * Service-admin scopes (`hub:admin`, `scribe:admin`) are on this list as of
 * 2026-06-30. They read as "delegable to a tooling app," but in practice a
 * vault MCP connector (e.g. Claude) is pointed at the hub-level authorization
 * server by the vault's protected-resource metadata, so the full hub catalog —
 * including `hub:admin` (manage signing keys, registered clients, user
 * accounts) — gets advertised on its consent screen and, if approved, minted
 * into its token. That's wildly over-privileged for a vault reader (cf.
 * hub#671, where the agent-grants client had to hardcode least-privilege to
 * dodge exactly this). The scope-narrowing that should strip it only fires
 * when the client echoes a resolvable RFC 8707 vault `resource`, which MCP
 * clients often don't. Every legitimate hub-admin / scribe-admin use is
 * operator-bearer or session based (operator token, DCR self-registration via
 * `requireScope`, the admin SPA host-admin token) — none route through
 * `/oauth/authorize` — so making these non-requestable fails closed against
 * third-party requests without breaking any first-party operator path.
 * `parachute:host:*` remains for the original reason: it provisions/destroys
 * vaults (cross-vault sovereignty the operator alone owns).
 */
export const NON_REQUESTABLE_SCOPES: ReadonlySet<string> = new Set([
  "parachute:host:admin",
  "parachute:host:install",
  "parachute:host:start",
  "parachute:host:expose",
  "parachute:host:auth",
  "parachute:host:vault",
  // Service-admin scopes: operator-only, never requestable via /oauth/authorize.
  "hub:admin",
  "scribe:admin",
]);

/**
 * Per-vault `vault:<name>:admin` scopes ARE requestable via the public OAuth
 * flow (single-consent change, 2026-05-29). A user may grant a named vault's
 * admin scope to an OAuth client — e.g. Claude MCP minting an admin token for
 * a vault — but only within the one guardrail that survives the simplification:
 * a user may only delegate authority they themselves hold. That guardrail is
 * enforced at the shared mint choke-point (`capScopesToUserAuthority` applied
 * inside `issueAuthCodeRedirect` in `oauth-handlers.ts`): an OAuth flow caps
 * named vault verbs to those the consenting user actually holds on that vault.
 * `vaultVerbsForRole` returns admin for an assigned user (2026-05-30: any
 * assigned user holds full vault authority on their own vault), so a non-owner
 * can delegate `vault:<their-vault>:admin` to their client. The cap still
 * drops admin (and every verb) for a vault the user is NOT assigned to
 * (held=null), and an admin-only request the cap empties is refused outright
 * (never minted as a zero-scope token). The hub owner (isFirstAdmin) holds
 * admin everywhere by construction.
 *
 * `vault:<name>:admin` also remains mintable by operator-proving local paths,
 * all of which require already-established authority:
 *   - the session-cookie-gated `/admin/vault-admin-token/:name` endpoint
 *     (the vault SPA's Manage link + setup wizard); and
 *   - `POST /api/auth/mint-token` under the capability-attenuation model —
 *     a `parachute:host:auth` bearer (any requestable scope, now incl.
 *     `vault:<name>:admin` — an intentional de-escalation widening that
 *     landed with the single-consent change), a `parachute:host:admin`
 *     bearer (box-wide → one-vault), or a `vault:<name>:admin` bearer
 *     (same-vault subset). The same model governs `POST /api/auth/revoke-token`
 *     (revoke what you could mint). See `canGrant` in `scope-attenuation.ts`
 *     and the guards in `api-mint-token.ts` / `api-revoke-token.ts`.
 *
 * The matcher is pattern-based because the set is open-ended — every vault
 * instance the operator creates implies a new scope, and we don't want to
 * enumerate them. It is still used by `isVaultAdminScope` (the mint-token
 * de-escalation recognizer) and `explainScope` / `VAULT_VERB_RE` (so the
 * consent screen renders the admin badge and `scopeIsAdmin` recognizes the
 * named admin form — load-bearing: the same-hub and trust-by-name auto-mint
 * gates rely on `scopeIsAdmin` to keep admin consent-gated).
 */
const VAULT_ADMIN_RE = /^vault:[a-zA-Z0-9_-]+:admin$/;

/**
 * Any per-vault scope: `vault:<name>:<verb>` for verb ∈ {read, write, admin}.
 * Captures the name in group 1 and the verb in group 2. Used by the
 * mint-token capability-attenuation model to recognise the scopes a
 * `vault:<name>:admin` bearer may attenuate to (same-vault subsets).
 */
const VAULT_SCOPED_RE = /^vault:([a-zA-Z0-9_-]+):(read|write|admin)$/;

/**
 * True when `scope` is a per-vault admin scope (`vault:<name>:admin`).
 * Exported so the mint-token path can recognise the one non-requestable
 * scope it conditionally admits for `parachute:host:admin` bearers.
 */
export function isVaultAdminScope(scope: string): boolean {
  return VAULT_ADMIN_RE.test(scope);
}

/**
 * Extract the vault name from ANY per-vault scope (`vault:<name>:<verb>` for
 * verb ∈ {read, write, admin}), or null if the scope isn't per-vault-scoped.
 * Used by the mint-token attenuation model to (a) match a `vault:<name>:admin`
 * bearer against same-vault requested scopes, and (b) derive the `vault_scope`
 * pin for every vault-scoped mint regardless of verb.
 */
export function vaultScopeName(scope: string): string | null {
  const m = VAULT_SCOPED_RE.exec(scope);
  return m ? (m[1] ?? null) : null;
}

/**
 * Mint-time shape guard: reject scopes that LOOK like a *named* per-vault scope
 * (`vault:<name>:<verb>`, three+ colon-segments, first segment `vault`
 * case-insensitively to catch `VAULT:…`) but are malformed — i.e. they don't
 * match the strict `vault:<name>:<read|write|admin>` shape (`VAULT_SCOPED_RE`).
 *
 * Returns true for (i.e. ADMITS):
 *   - well-formed named scopes `vault:<name>:<read|write|admin>`;
 *   - the canonical *unnamed* two-segment scopes `vault:read|write|admin`
 *     (legitimate OAuth/consent forms — keys in `SCOPE_EXPLANATIONS`, narrowed
 *     to a named vault at consent time) and any other non-three-segment
 *     `vault`-prefixed string — those aren't attempting the named shape, so
 *     they're out of this guard's remit and keep their existing behaviour;
 *   - every non-vault scope (`scribe:transcribe`, `parachute:host:*`, …).
 *
 * Returns false for (i.e. REJECTS) only a `vault`-prefixed string with three
 * or more colon-segments that fails `VAULT_SCOPED_RE`:
 *   `vault:work:ADMIN` (uppercase verb), `vault::admin` (empty name),
 *   `vault:work:read:admin` (extra segment), `VAULT:work:admin` (uppercase
 *   resource).
 *
 * Why this exists (defensive hygiene — adversarial audit, 2026-05-28): a
 * `parachute:host:auth` bearer can today mint those four malformed strings.
 * `isNonRequestableScope`'s strict regexes don't match them, so `canGrant`
 * rule 1 admits them as "requestable" — the mint succeeds (200) carrying the
 * literal junk string and writes a registry row. They grant ZERO access today
 * (the vault consumer's `decomposeVaultScope` is case-sensitive + anchored and
 * rejects all four), so this is NOT exploitable now. The value is (a) registry
 * hygiene (no junk rows) and (b) a backstop against a FUTURE consumer-
 * normalization regression — if vault ever started case-folding scope verbs,
 * those junk tokens could silently become live admin. A strict mint-time shape
 * check closes that door now.
 *
 * Orthogonal to authority: this is an input-shape check applied to ALL mint
 * callers (host:auth, host:admin, vault:<name>:admin) before any `canGrant`
 * attenuation. It does not affect non-vault scopes or the unnamed `vault:<verb>`
 * forms.
 */
export function isWellFormedOrNonVaultScope(scope: string): boolean {
  const segments = scope.split(":");
  // Only constrain the *named* per-vault shape: first segment names the vault
  // resource (case-insensitive, to catch `VAULT:`) AND there are three or more
  // segments (an attempt at `vault:<name>:<verb>`). The unnamed two-segment
  // forms (`vault:read|write|admin`) and a bare `vault` are out of remit.
  const firstSegment = segments[0] ?? "";
  if (firstSegment.toLowerCase() !== "vault" || segments.length < 3) {
    return true;
  }
  return VAULT_SCOPED_RE.test(scope);
}

/** True when the scope is non-requestable via the public OAuth flow. */
export function isNonRequestableScope(scope: string): boolean {
  // Per-vault `vault:<name>:admin` is NO LONGER globally non-requestable
  // (single-consent change, 2026-05-29). It flows through the public OAuth
  // consent path and through `canGrant` rule 1, capped to the consenting
  // user's held authority at the `issueAuthCodeRedirect` choke-point. The
  // host-level operator scopes AND the service-admin scopes (hub:admin,
  // scribe:admin) stay non-requestable here (see NON_REQUESTABLE_SCOPES).
  //
  // Item C — case-insensitive guard. The membership check is exact-string,
  // but Parachute scope tokens are canonically lowercase. A casing variant
  // like `PARACHUTE:HOST:AUTH` would slip past a raw `Set.has` and be treated
  // as requestable — minting a junk-but-harmless token today (consumers are
  // case-sensitive + anchored, so it grants nothing), but a backstop against
  // a future consumer that case-folds. Normalize to lowercase before the
  // membership check so every casing of a host-level scope is refused.
  return NON_REQUESTABLE_SCOPES.has(scope.toLowerCase());
}

/** True when the scope can appear in a public `/oauth/authorize` request. */
export function isRequestableScope(scope: string): boolean {
  return !isNonRequestableScope(scope);
}

/**
 * Recognize narrowed vault scopes (`vault:<name>:<verb>`) and the wildcard
 * display form (`vault:*:<verb>`) — both render with the same explanation as
 * the corresponding unnamed `vault:<verb>` row, since they describe the same
 * permission scoped to a specific (or unspecified-at-mint-time) vault.
 *
 * The hub narrows unnamed `vault:read` → `vault:<name>:read` at consent /
 * token-mint via the picker (Q1 of the vault-config-and-scopes design); the
 * consent screen now surfaces that narrowed form so the user sees the scope
 * shape that will appear in the token. `vault:*:read` is the display-only
 * shape we use on the operator approval page where no per-user vault has
 * been selected yet (a specific vault is chosen during sign-in).
 *
 * Includes `admin` (single-consent change, 2026-05-29). `vault:<name>:admin`
 * is now requestable via OAuth, so it reaches the consent screen and MUST get
 * the `vault:admin` explanation (level `"admin"`) — both so the consent UI
 * renders the admin badge and so `scopeIsAdmin("vault:<name>:admin")` returns
 * true. That second effect is LOAD-BEARING: the same-hub auto-trust gate
 * (`!hasAdminScope`) and the trust-by-client_name gate
 * (`!requestedScopes.some(scopeIsAdmin)`) rely on `scopeIsAdmin` recognizing
 * the named admin form to keep admin grants consent-gated (never silently
 * auto-minted). If this regex dropped `admin`, those gates would treat a
 * named admin scope as non-admin and auto-mint it.
 */
const VAULT_VERB_RE = /^vault:[a-zA-Z0-9_*-]+:(read|write|admin)$/;

/**
 * Named per-surface scopes (`surface:<name>:<verb>` for verb ∈ {read, write}) —
 * the Surface Git Transport grant shape (Decisions-locked #2: read = clone,
 * write = push). The 3→2-segment collapse means the hub validates every
 * `surface:<name>:<verb>` off the declared unnamed `surface:read`/`surface:write`,
 * so the consent screen must render the named form with the SAME operator-facing
 * label — else `surface:gitcoin-brain:write` shows raw. Parallel to
 * `VAULT_VERB_RE`. (No named `admin` form: surface admin is the unnamed,
 * module-level `surface:admin`.)
 */
const SURFACE_VERB_RE = /^surface:[a-zA-Z0-9_*-]+:(read|write)$/;

export function explainScope(scope: string): ScopeExplanation | null {
  const direct = SCOPE_EXPLANATIONS[scope];
  if (direct) return direct;
  if (VAULT_VERB_RE.test(scope)) {
    const verb = scope.split(":")[2] as "read" | "write" | "admin";
    return SCOPE_EXPLANATIONS[`vault:${verb}`] ?? null;
  }
  if (SURFACE_VERB_RE.test(scope)) {
    const verb = scope.split(":")[2] as "read" | "write";
    return SCOPE_EXPLANATIONS[`surface:${verb}`] ?? null;
  }
  return null;
}

/**
 * Module-declared scopes (e.g. `runner:admin`) don't participate in
 * `scopeIsAdmin` because `SCOPE_EXPLANATIONS` only covers core scopes —
 * `explainScope` returns null for them, so `scopeIsAdmin` returns false.
 * This is deliberate for now: module-declared admin scopes aren't
 * requestable via the public OAuth flow (they're host-admin-minted only).
 * If module-declared admin scopes ever become public-requestable, this
 * function needs to consult the live module-scope registry too — otherwise
 * a `runner:admin` (or similar) grant would silently bypass the admin-
 * scope guardrails. See the regression test pinning this gap.
 */
export function scopeIsAdmin(scope: string): boolean {
  return explainScope(scope)?.level === "admin";
}
