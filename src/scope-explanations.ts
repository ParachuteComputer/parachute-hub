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
 * `parachute-patterns/patterns/oauth-scopes.md`.
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
    label: "Full vault access plus configuration changes (rotate tokens, change settings).",
    level: "admin",
  },
  "scribe:transcribe": {
    label: "Send audio to Scribe for transcription.",
    level: "write",
  },
  "scribe:admin": {
    label: "Manage Scribe configuration (provider keys, models, quotas).",
    level: "admin",
  },
  "channel:send": {
    label: "Post messages to your Channel.",
    level: "send",
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
 *     cookie (set by `/admin/login` after a password check) for a
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
 * Why `parachute:host:admin` is on this list and `hub:admin` is not:
 * `parachute:host:admin` provisions and destroys vaults — cross-vault
 * data sovereignty that the operator alone owns. `hub:admin` is service
 * management (signing keys, registered clients, user accounts) which an
 * operator may legitimately delegate to a tooling app. The asymmetry is
 * intentional: the blast radius of compromised cross-vault admin doesn't
 * justify third-party requestability.
 */
export const NON_REQUESTABLE_SCOPES: ReadonlySet<string> = new Set(["parachute:host:admin"]);

/** True when the scope can appear in a public `/oauth/authorize` request. */
export function isRequestableScope(scope: string): boolean {
  return !NON_REQUESTABLE_SCOPES.has(scope);
}

export function explainScope(scope: string): ScopeExplanation | null {
  return SCOPE_EXPLANATIONS[scope] ?? null;
}

export function scopeIsAdmin(scope: string): boolean {
  return explainScope(scope)?.level === "admin";
}
