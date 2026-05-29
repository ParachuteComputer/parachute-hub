/**
 * RFC 8707 (Resource Indicators for OAuth 2.0) resource-binding helpers.
 *
 * An MCP client connecting to a single vault (`<origin>/vault/<name>/mcp`)
 * discovers the hub as its authorization server via the RFC 9728 challenge
 * (`WWW-Authenticate: Bearer resource_metadata=…`) → per-vault Protected
 * Resource Metadata. A spec-following client then sends the `resource`
 * parameter on `/oauth/authorize` naming that exact MCP endpoint.
 *
 * Before this module the hub dropped `resource` on the floor: the consent
 * screen advertised the ENTIRE scope catalog (every vault + hub:admin +
 * scribe:admin …) and the minted token's audience was derived purely from
 * the operator's manual vault-picker choice. Two failures fell out:
 *
 *   1. Scary consent — a friend connecting to ONE vault saw the whole hub's
 *      scope surface.
 *   2. Broad-scope rejection — an unnamed `vault:read` token (the shape a
 *      client gets when it never picks a specific vault) is REJECTED by a
 *      current-line vault (`findBroadVaultScopes`), because hub-issued tokens
 *      must carry resource-narrowed `vault:<name>:<verb>` scopes + a matching
 *      `aud=vault.<name>`.
 *
 * This module consumes `resource` end-to-end: when it resolves to a per-vault
 * MCP resource we derive `<name>`, narrow the consent scope list to that
 * vault's named scopes, lock the picker to `<name>`, and mint named scopes so
 * `inferAudience` stamps `aud=vault.<name>`.
 *
 * Source of truth for scope shape: `parachute-patterns/patterns/oauth-scopes.md`.
 */

import { VAULT_VERBS } from "./jwt-audience.ts";

/**
 * Two recognised per-vault resource shapes, both rooted at the hub origin:
 *
 *   - the MCP endpoint:  `<origin>/vault/<name>/mcp`  (the canonical RFC 8707
 *     resource indicator the PRM `resource` field advertises and a spec-
 *     following client echoes back);
 *   - the PRM document:  `<origin>/vault/<name>/.well-known/oauth-protected-resource`
 *     (some clients send the metadata URL itself as the resource).
 *
 * A trailing slash and any query/fragment are tolerated. Capture group 1 is
 * the vault instance name (same `[^/]+` shape `vaultInstanceNameFor` derives
 * from a `/vault/<name>` path).
 */
const VAULT_MCP_PATH_RE = /^\/vault\/([^/]+)\/mcp\/?$/;
const VAULT_PRM_PATH_RE = /^\/vault\/([^/]+)\/\.well-known\/oauth-protected-resource\/?$/;

/**
 * Resolve the RFC 8707 `resource` parameter to a vault instance name, or null
 * when it isn't a per-vault MCP resource (absent, malformed, off-origin, or a
 * non-vault path). Off-origin resources return null deliberately: we only
 * narrow consent for resources the hub itself fronts, so a `resource` naming
 * some third party's URL can't drive the vault-narrowing path.
 *
 * `boundOrigins` is the hub's own origin set (issuer + loopback + tailnet +
 * funnel — same set the same-origin CSRF gate uses). A resource whose origin
 * isn't in that set is treated as not-ours.
 *
 * The vault name is NOT validated against the live services.json here — that
 * check stays where it already lives (the consent picker / submit defenses).
 * This helper's only job is shape recognition + name extraction.
 */
export function resolveResourceVault(
  resource: string | null | undefined,
  boundOrigins: readonly string[],
): string | null {
  if (!resource) return null;
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    return null;
  }
  if (!boundOrigins.includes(parsed.origin)) return null;
  const mcp = VAULT_MCP_PATH_RE.exec(parsed.pathname);
  if (mcp?.[1]) return safeDecode(mcp[1]);
  const prm = VAULT_PRM_PATH_RE.exec(parsed.pathname);
  if (prm?.[1]) return safeDecode(prm[1]);
  return null;
}

/**
 * Decode a path segment, returning null on a malformed percent-escape rather
 * than throwing (a malformed `resource` must degrade to the unbound flow, not
 * 500 the authorize handler). Vault names are `[a-zA-Z0-9_-]` in practice so
 * this is belt-and-suspenders.
 */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Rewrite the requested scope list for a resource-bound vault flow.
 *
 *   - unnamed `vault:<verb>`        → `vault:<name>:<verb>` (the narrow,
 *     audience-correct shape vault accepts);
 *   - already-named `vault:<other>:<verb>` is LEFT UNTOUCHED — a client that
 *     explicitly named a different vault is not silently re-pointed; the
 *     downstream picker / assignment defenses decide whether that's allowed.
 *   - non-vault scopes (`scribe:transcribe`, `hub:admin`, …) pass through
 *     unchanged — resource-binding only narrows the vault verbs.
 *
 * Idempotent: a scope already shaped `vault:<name>:<verb>` for THIS name is
 * returned as-is, so re-running over a narrowed list is a no-op.
 */
export function narrowResourceVaultScopes(scopes: readonly string[], vaultName: string): string[] {
  return scopes.map((s) => {
    const parts = s.split(":");
    const verb = parts[1];
    if (parts.length === 2 && parts[0] === "vault" && verb && VAULT_VERBS.has(verb)) {
      return `vault:${vaultName}:${verb}`;
    }
    return s;
  });
}
