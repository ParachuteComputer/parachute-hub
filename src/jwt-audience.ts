/**
 * Audience derivation for hub-issued JWTs. Used by both:
 *   - `/oauth/token` (auth_code redemption + refresh rotation)
 *   - `parachute auth mint-token` (CLI shortcut for scope-narrow tokens)
 *
 * Per the vault-config-and-scopes design (Phase 1+2):
 *   - A named `vault:<name>:<verb>` → `vault.<name>` (RFC 8707-style resource
 *     binding; vault enforces this strict-equality against the URL-derived
 *     vault name).
 *   - An unnamed `<service>:<verb>` → `<service>` (legacy shape; vault's
 *     strict-check rejects unnamed `vault:*` audiences, so the consent
 *     picker rewrites those before this is reached).
 *   - Fallback: `hub` (no namespaced scope).
 *
 * Named vault scopes win over unnamed ones — an OAuth flow that mixes
 * `vault:work:read` + `scribe:transcribe` audiences is grounded on the vault
 * (the more sensitive resource), and tokens are issued per-flow anyway.
 *
 * Hoisted from `oauth-handlers.ts` so CLI mints and OAuth mints can't diverge
 * on audience semantics — a divergence here means tokens minted via CLI fail
 * audience strict-check at the resource server even though scopes match.
 */

export const VAULT_VERBS = new Set(["read", "write", "admin"]);

export function inferAudience(scopes: readonly string[]): string {
  for (const s of scopes) {
    const parts = s.split(":");
    const name = parts[1];
    const verb = parts[2];
    if (parts.length === 3 && parts[0] === "vault" && name && verb && VAULT_VERBS.has(verb)) {
      return `vault.${name}`;
    }
  }
  for (const s of scopes) {
    const colon = s.indexOf(":");
    if (colon > 0) return s.slice(0, colon);
  }
  return "hub";
}
