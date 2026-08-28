/**
 * Copy-paste MCP connect URLs and Claude Code commands.
 *
 * Humans are pointed at:
 *   - `/mcp` — one URL; the consent picker chooses this vault XOR all
 *     assigned vaults. Root PRM stays vault-only (catalog-copy must not
 *     mix `account:vaults` with `vault:*` — that combination is
 *     `invalid_scope`).
 *   - `/vault/<name>/mcp` — skip the picker; one assigned vault.
 *
 * `/account/mcp` stays the honest single-family discovery door (its PRM
 * advertises `account:vaults` alone). Do not put it in human-facing
 * onboarding copy — the picker at `/mcp` is the choice.
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

/** `<hub-origin>/mcp` — picker chooses this vault or all assigned vaults. */
export function rootMcpEndpoint(trimmedOrigin: string): string {
  return `${trimmedOrigin}/mcp`;
}

/** OAuth `claude mcp add` for the hub root. Server name `parachute`. */
export function rootClaudeMcpAddCommand(trimmedOrigin: string): string {
  return `claude mcp add --transport http parachute ${rootMcpEndpoint(trimmedOrigin)}`;
}

/** `<hub-origin>/account/mcp` — honest single-family discovery door. */
export function accountMcpEndpoint(trimmedOrigin: string): string {
  return `${trimmedOrigin}/account/mcp`;
}

/** OAuth `claude mcp add` for `/account/mcp`. Server name `parachute-account`. */
export function accountClaudeMcpAddCommand(trimmedOrigin: string): string {
  return `claude mcp add --transport http parachute-account ${accountMcpEndpoint(trimmedOrigin)}`;
}
