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
 * Source of truth for scope shape: `docs/contracts/oauth-scopes.md`.
 */
import { ACCOUNT_VAULTS_UNNARROWED, accountVaultsScope } from "@openparachute/door-contract";

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
 * The same two shapes for the ROOT MCP door, which carries no vault name:
 *
 *   - the MCP endpoint:  `<origin>/mcp`
 *   - the PRM document:  `<origin>/.well-known/oauth-protected-resource/mcp`
 *     (path-suffixed per the MCP spec's per-resource discovery convention —
 *     see the handler in `hub-server.ts`, which authors this document from
 *     the hub's own scope registry).
 *
 * Root `/mcp` is not a single-vault endpoint: vault derives the target from
 * the token (`deriveVaultFromToken`) and re-dispatches through the per-vault
 * machinery with the audience pin intact. Verified live against a hub with
 * three vaults — the same URL served `parachute-vault/alpha` to an
 * `aud=vault.alpha` token and `parachute-vault/beta` to an `aud=vault.beta`
 * one, and each token 401'd (`audience mismatch`) at the other's per-vault
 * path.
 */
const ROOT_MCP_PATH_RE = /^\/mcp\/?$/;
const ROOT_PRM_PATH_RE = /^\/\.well-known\/oauth-protected-resource\/mcp\/?$/;

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
  if (mcp?.[1]) return decodeVaultName(mcp[1]);
  const prm = VAULT_PRM_PATH_RE.exec(parsed.pathname);
  if (prm?.[1]) return decodeVaultName(prm[1]);
  return null;
}

/**
 * True when the RFC 8707 `resource` names the hub's ROOT MCP door (or its PRM
 * document). Same origin gate as `resolveResourceVault` — a resource we don't
 * front can't drive any narrowing.
 *
 * This is deliberately a SEPARATE predicate rather than a new return value on
 * `resolveResourceVault`, because the root door has **no vault name to narrow
 * to**. `resolveResourceVault` answers "which vault?"; the honest answer for
 * root is "none yet — the consent picker decides." Folding root into its
 * return type would hand callers a name-shaped value that isn't a name.
 *
 * Callers pair this with `narrowRootMcpScopes`, never with
 * `narrowResourceVaultScopes`: there is nothing to name the scopes after.
 */
export function isRootMcpResource(
  resource: string | null | undefined,
  boundOrigins: readonly string[],
): boolean {
  if (!resource) return false;
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    return false;
  }
  if (!boundOrigins.includes(parsed.origin)) return false;
  return ROOT_MCP_PATH_RE.test(parsed.pathname) || ROOT_PRM_PATH_RE.test(parsed.pathname);
}

/** Canonical vault-name shape — mirrors `VAULT_SCOPED_RE`'s name group. */
const VAULT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Decode a captured path segment into a vault name, returning null when it
 * isn't a well-formed vault name. Two failure modes both fall through to the
 * unbound flow (no narrowing, no junk mint):
 *
 *   - malformed percent-escape (`%GG`) → `decodeURIComponent` throws → null.
 *     A bad `resource` must degrade gracefully, not 500 the authorize handler.
 *   - decoded value isn't `[a-zA-Z0-9_-]+` → null. The `[^/]+` path capture
 *     admits anything between slashes; a crafted `resource=…/vault/%2F..%2Fadmin/mcp`
 *     decodes to `/../admin`, which would otherwise mint a token stamped
 *     `aud=vault./../admin`. Harmless (the resource server rejects it) but it's
 *     audit-log noise + a minting path for non-vault names. Anchoring the name
 *     to the canonical shape closes it. Matches `VAULT_SCOPED_RE`'s name group
 *     so what we accept here is exactly what a vault scope can name.
 */
function decodeVaultName(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return VAULT_NAME_RE.test(decoded) ? decoded : null;
}

/**
 * Rewrite the requested scope list for a resource-bound vault flow, returning
 * ONLY scopes usable in the resulting vault-audience token:
 *
 *   - unnamed `vault:<verb>`        → `vault:<name>:<verb>` (the narrow,
 *     audience-correct shape vault accepts);
 *   - already-named `vault:<other>:<verb>` is LEFT UNTOUCHED — a client that
 *     explicitly named a different vault is not silently re-pointed; the
 *     downstream picker / assignment defenses decide whether that's allowed.
 *   - non-vault scopes (`scribe:*`, `agent:send`, `hub:admin`, …) are
 *     DROPPED. This flow mints a token stamped `aud=vault.<name>` (RFC 8707),
 *     so a scribe/agent/hub scope inside it is unusable — keeping it only
 *     inflates the consent surface a friend sees when connecting ONE vault.
 *     That "scary consent" is the failure mode this module exists to kill
 *     (see the header docstring): the verb-narrowing alone left the foreign
 *     scopes riding through, so a client that over-requests the whole-hub
 *     catalog (claude.ai reads it from the AS-metadata `scopes_supported`)
 *     still surfaced `scribe:admin` + `agent:send` on the consent screen.
 *     A client that genuinely wants a scribe token runs a separate flow
 *     naming the scribe resource.
 *
 * Idempotent: an already-narrowed list contains only `vault:` scopes, so a
 * second pass has nothing left to drop and `vault:<name>:<verb>` for THIS name
 * is returned as-is.
 */
export function narrowResourceVaultScopes(scopes: readonly string[], vaultName: string): string[] {
  const out: string[] = [];
  for (const s of scopes) {
    const parts = s.split(":");
    if (parts[0] !== "vault") continue; // drop scribe:/agent:/hub:/… — foreign to a vault-audience token
    const verb = parts[1];
    if (parts.length === 2 && verb && VAULT_VERBS.has(verb)) {
      out.push(`vault:${vaultName}:${verb}`);
    } else {
      out.push(s); // already-named (incl. other vaults) or malformed vault scope — downstream defenses decide
    }
  }
  return out;
}

/**
 * The root-`/mcp` counterpart of `narrowResourceVaultScopes`: keep vault
 * scopes and the account-MCP connection grant (`account:vaults` /
 * `account:self:vaults`), drop everything else.
 *
 * Root `/mcp` is two token shapes at one URL, branched on what arrives:
 * vault-audience Bearer still names one vault; `account:vaults` mints
 * `aud=account` and is answered by account-MCP. The same argument that drops
 * `scribe:*` / `agent:send` / `hub:admin` from a per-vault consent applies
 * verbatim: those scopes are unusable in either token this door mints, and
 * carrying them only inflates the consent surface.
 *
 * `account:vaults` cannot be combined with other scopes (authorize already
 * refuses that). This filter still keeps both if a client asked for both —
 * the combine check, not this function, is the refusal. Named
 * `account:self:vaults:<vault>` forms are NOT the connection grant and are
 * dropped here.
 *
 * What this deliberately does NOT do is name vault scopes. Unnamed
 * `vault:<verb>` is left exactly as requested; the consent picker supplies
 * the name. Already-named `vault:<name>:<verb>` rides through untouched.
 *
 * A request that carries ONLY foreign scopes narrows to the empty list. The
 * root authorize handler refuses that case with `invalid_scope`.
 *
 * Idempotent: a second pass has nothing left to drop.
 */
export function isAccountVaultsRootScope(scope: string): boolean {
  return scope === ACCOUNT_VAULTS_UNNARROWED || scope === accountVaultsScope("self");
}

export function narrowRootMcpScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => s.split(":")[0] === "vault" || isAccountVaultsRootScope(s));
}

/**
 * Audience for a token minted against root `/mcp`.
 *
 * Vault-named grants stay on `fallbackAudience` (`inferAudience` →
 * `vault.<name>`). An account-vaults-only grant has no named vault and
 * `inferAudience` already returns `"account"` — accept that instead of
 * rejecting an empty vault-name set.
 *
 * Returns `null` when the grant is neither (foreign-only / empty) — the
 * token handler turns that into `invalid_target`.
 */
export function resolveRootMcpTokenAudience(
  grantedVaultNames: ReadonlySet<string>,
  fallbackAudience: string,
): string | null {
  if (grantedVaultNames.size > 0) return fallbackAudience;
  if (fallbackAudience === "account") return "account";
  return null;
}
