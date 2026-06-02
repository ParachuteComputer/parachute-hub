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

/**
 * RFC 8707 resource → `aud` binding for the token endpoint (#511).
 *
 * Background: Claude's MCP connector (Claude Desktop / claude.ai / mobile)
 * sends `resource=<origin>/vault/<name>/mcp` on the token request and then
 * validates the returned access token's `aud` *equals that exact resource
 * URL* (RFC 8707 §2 + the MCP auth spec). Pre-#511 the hub minted `aud`
 * purely from scopes (`inferAudience` → `"vault.default"`) and dropped the
 * `resource` param at the token step, so the connector rejected the
 * credential client-side and never called `/mcp`.
 *
 * Fix: when the request carries a `resource` that (a) resolves — via the
 * caller-supplied `resolveResource` (the existing `resolveResourceVault`
 * partial-applied with the hub's bound origins) — to a hub-fronted per-vault
 * MCP resource, AND (b) that resource's vault matches the scope-derived
 * audience (`vault.<name>`), we widen `aud` to the array
 * `[scopeAudience, resourceUrl]`. RFC 7519 §4.1.3 allows `aud` to be an
 * array; the vault's scope-guard checks membership (`auds.includes`), so the
 * array still satisfies the vault's `expectedAudience = "vault.<name>"` while
 * also matching the connector's `resource` check.
 *
 * GUARD (security-critical): a `resource` that does NOT resolve to the same
 * vault as the scope-derived aud is IGNORED — we mint the bare scope string,
 * exactly as today. An arbitrary or foreign `resource` value must never be
 * able to stamp a junk audience into the token. Ignore, never error.
 *
 * Returns the bare `scopeAudience` string when there's no resource, the
 * resource doesn't resolve, or it resolves to a different vault. Returns the
 * two-element array `[scopeAudience, resourceUrl]` only on a clean match.
 */
export function bindResourceAudience(
  scopeAudience: string,
  resource: string | null | undefined,
  resolveResource: (resource: string | null | undefined) => string | null,
): string | string[] {
  if (!resource) return scopeAudience;
  const resourceVault = resolveResource(resource);
  // Only bind when the resource resolves to a hub-fronted per-vault MCP
  // resource AND its vault name matches the scope-derived `vault.<name>`.
  if (resourceVault && `vault.${resourceVault}` === scopeAudience) {
    return [scopeAudience, resource];
  }
  return scopeAudience;
}
