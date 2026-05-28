/**
 * Capability attenuation — the shared authority model behind both the
 * mint side (`/api/auth/mint-token`, hub#452) and the revoke side
 * (`/api/auth/revoke-token`). The two endpoints are symmetric: you may
 * revoke exactly what you could have minted.
 *
 * `canGrant(bearerScopes, scope)` answers: could a bearer holding
 * `bearerScopes` mint a token carrying `scope`? It is the single source of
 * truth for "is `scope` within this bearer's authority" — mint uses it to
 * gate what a request may issue; revoke uses it to gate what a request may
 * tear down (every recorded scope on the target jti must be `canGrant`-able).
 *
 * `hasMintingAuthority(bearerScopes)` is the cheap entry gate: does the
 * bearer hold ANY authority at all (host:auth, host:admin, or some
 * `vault:<*>:admin`)? A bearer with none can neither mint nor revoke via
 * attenuation, so both endpoints 403 it before any per-scope work.
 *
 * Pure functions — no DB, no I/O — so they're trivially testable and both
 * handlers stay thin.
 */
import { isNonRequestableScope, isVaultAdminScope, vaultScopeName } from "./scope-explanations.ts";

/**
 * Bearer scope that authorises minting any *requestable* scope (rule 1 of the
 * attenuation model). The operator's admin scope-set carries this; a narrow
 * `--scope-set=auth` operator token carries it too.
 */
export const MINT_HOST_AUTH_SCOPE = "parachute:host:auth";
/**
 * Bearer scope that authorises minting `vault:<name>:admin` (rule 2).
 * `parachute:host:admin` already implies box-wide administration of every
 * vault on the hub, so minting a vault-pinned admin from it is a privilege
 * *reduction* (de-escalation), not an escalation — see the design doc
 * `2026-05-28-operator-mintable-vault-admin.md`.
 */
export const MINT_HOST_ADMIN_SCOPE = "parachute:host:admin";

/**
 * Capability attenuation: can a bearer holding `bearerScopes` mint a token
 * carrying `requestedScope`? True iff the requested scope is a subset of the
 * bearer's own authority under one of three rules:
 *
 *   1. requestable + bearer has `parachute:host:auth`;
 *   2. `vault:<N>:admin` + bearer has `parachute:host:admin`;
 *   3. `vault:<N>:<verb>` + bearer has `vault:<N>:admin` (same `<N>`).
 *
 * Pure function — no DB, no I/O — so it's trivially testable and the guard in
 * each handler is a single `scopes.filter((s) => !canGrant(bearerScopes, s))`.
 *
 * On the revoke side this is the symmetric rule: a target jti is revocable by
 * a non-host:auth bearer iff EVERY one of its recorded scopes is `canGrant`-able
 * — i.e. the bearer could have minted that token, so it may also tear it down.
 * Cross-vault and host-authority targets are never `canGrant`-able by a mere
 * `vault:<N>:admin` bearer, so it can neither mint nor revoke them.
 */
export function canGrant(bearerScopes: string[], requestedScope: string): boolean {
  // Rule 1 — host:auth mints any requestable scope.
  if (!isNonRequestableScope(requestedScope) && bearerScopes.includes(MINT_HOST_AUTH_SCOPE)) {
    return true;
  }
  // Rule 2 — host:admin attenuates to a named vault's admin.
  if (isVaultAdminScope(requestedScope) && bearerScopes.includes(MINT_HOST_ADMIN_SCOPE)) {
    return true;
  }
  // Rule 3 — vault:<N>:admin attenuates to any same-vault subset (incl. admin).
  const requestedVault = vaultScopeName(requestedScope);
  if (requestedVault !== null && bearerScopes.includes(`vault:${requestedVault}:admin`)) {
    return true;
  }
  return false;
}

/**
 * Does the bearer hold ANY minting authority? Entry gate before per-scope
 * checks — a bearer with none (e.g. a read-only token) can mint (or revoke
 * via attenuation) nothing, so both endpoints 403 it early rather than
 * walking every scope to the same end.
 */
export function hasMintingAuthority(bearerScopes: string[]): boolean {
  return (
    bearerScopes.includes(MINT_HOST_AUTH_SCOPE) ||
    bearerScopes.includes(MINT_HOST_ADMIN_SCOPE) ||
    bearerScopes.some((s) => isVaultAdminScope(s))
  );
}
