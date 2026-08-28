/**
 * Copy-paste MCP connect URLs and Claude Code commands.
 *
 * Two doors, two names — do not mix them:
 *   - `/account/mcp` — whole house / all assigned vaults (`account:vaults`)
 *   - `/vault/<name>/mcp` — one assigned vault (`vault:<name>:*`)
 *
 * Root `/mcp` is a convenience alias for NIP-98 and for a Bearer that
 * already has `aud=account`. OAuth discovery at root advertises vault
 * scopes only; a generic client that catalog-copies that list cannot
 * learn `account:vaults` (and must not be taught it there — combining
 * the two families is `invalid_scope`). Point OAuth clients at
 * `/account/mcp` for the house, `/vault/<name>/mcp` for one vault.
 */

/** `<hub-origin>/vault/<name>/mcp` — one assigned vault. */
export function assignedVaultMcpEndpoint(trimmedOrigin: string, vaultName: string): string {
  return `${trimmedOrigin}/vault/${vaultName}/mcp`;
}

/** OAuth `claude mcp add` for one assigned vault. Server name `parachute-<name>`. */
export function assignedVaultClaudeMcpAddCommand(trimmedOrigin: string, vaultName: string): string {
  return `claude mcp add --transport http parachute-${vaultName} ${assignedVaultMcpEndpoint(
    trimmedOrigin,
    vaultName,
  )}`;
}

/** `<hub-origin>/account/mcp` — all assigned vaults. */
export function accountMcpEndpoint(trimmedOrigin: string): string {
  return `${trimmedOrigin}/account/mcp`;
}

/** OAuth `claude mcp add` for the whole house. Server name `parachute-account`. */
export function accountClaudeMcpAddCommand(trimmedOrigin: string): string {
  return `claude mcp add --transport http parachute-account ${accountMcpEndpoint(trimmedOrigin)}`;
}
