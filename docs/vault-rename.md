# Vault rename

`POST /vaults/<old>/rename` with `{"new_name":"<new>"}` and
`parachute vault rename <old> <new>` now rename a vault with its hub identity.
The account alias is `POST /account/vaults/<old>/rename`. Both require
`parachute:host:admin`, as deletion does. The hub door advertises
`vault_rename: true`; cloud still advertises false. This is an honest per-door
wire-contract capability, not a change to the contract type. The existing
false conformance vector describes cloud and remains unchanged.

The vault CLI owns filesystem moves, SQLite backup, vault.yaml, default_vault,
and services.json self-registration. Its rename command is offline: it has no
cross-process lock, and rollback copies a VACUUM snapshot over vault.db.
The hub stops the vault module before
`parachute-vault rename old new --yes`, then commits the identity cascade in one
SQLite transaction. Every vault on the host is briefly offline during the
rename; a success response includes a warning stating this. Without a supervisor,
the hub refuses with 503 `supervisor_unavailable` before running the CLI.
A CLI failure leaves identity untouched. A transaction failure rolls it back,
restores connection metadata, and attempts the reverse CLI rename while the
module remains stopped. The hub attempts to restart on every exit path,
including a failed stop. Restart failures append to error descriptions or become
warnings on a committed rename. The response includes the backup path, new
mounts, counts, revoked jtis, reservation expiry, and repair warnings.

## Token policy

JWT claims cannot be edited. Vault's `auth.ts` checks `aud=vault.<name>` and
scope-guard enforces the named vault scope, so old-name JWTs cannot authorize
against the renamed vault. `handleTokenRefresh` derives scopes and audience
from the stored refresh row and current user assignments. Rename updates those
rows without changing their refresh hash, family, jti, or revocation state.
The next refresh therefore issues the new name. Already rotated predecessors
retain their historical state; grace replay uses the rescoped live tip.

Unrefreshable registered tokens naming the old vault are revoked, published on
the existing revocation feed, and returned as `tokens_revoked` plus
`tokens_revoked_count`; the operator must re-mint them. This includes credential
connections and agent connector mints, including tokens with additional scopes.

Revoking the access jti on a refresh row would also revoke refresh. Instead, a
durable hub-settings tombstone reserves the old name for the 15-minute OAuth
access TTL plus 60 seconds of clock margin after CLI completion. This also
covers unregistered interactive mints (at most 10 minutes), which have no jtis
in the registry to enumerate. Longer-lived registered mints are revoked.
All hub provisioning callers, setup, and the `parachute vault create <name>`
passthrough honor the reservation; rename into a reserved name is also refused.
Unused old-name auth codes are invalidated, and signing/refresh insertion refuses
reserved names, preventing an in-flight mint from persisting an old-name family.
A direct `parachute-vault create` bypasses hub identity policy, just as direct
module deletion does; operators must use the hub surface during this interval.

## Vault-name audit

- `grants.scopes`: exact `vaultScopeName` comparison and ordered scope rewrite.
  `tokens.scopes`: the policy above; no SQL LIKE matching.
- `user_vaults.vault_name`, `invites.vault_name`, `vault_caps.vault_name`, and
  `channel_vaults.vault`: exact equality updates. Invite tokens/hashes, usage,
  revocation state, caps, roles, and channel reconciliation metadata survive.
- `auth_codes.scopes`: unused matching codes invalidated; restart authorization.
  `hub_settings.setup_vault_name`: updated. Rename tombstones are historical
  reservations, not aliases, and stay keyed by the old name.
- `connections.json`: source/provisioned vault and provisioned scope updated;
  metadata restored if the DB commit fails. Credential holders must renew.
  Event connections with revoked vault reply JWTs need re-provisioning.
  Trigger IDs and sink parameters belong to modules and are not rewritten.
- `agent-grants.json` and pending OAuth flows: connector specifications are
  operator-approved desired targets, with identity keys derived from targets.
  They are not automatically re-approved for a new target. Their registered
  old-name vault JWTs are revoked by the token cascade. Update the agent's
  definition and request/approve a replacement grant; remote MCP URLs and OAuth
  consent flows require reconnection. Saved client URLs likewise need updating.
- Agent/channel configuration and vault note contents are module-owned.
  Response warnings identify that repair boundary; the hub does not silently
  rewrite arbitrary module configuration or note text.
- `services.json` and `/vault/<name>` routing/discovery: CLI selfRegister writes,
  hub re-reads. Account `GET /account/vaults`, account MCP discovery, well-known
  metadata and the door URL template derive names from this manifest and the
  rewritten assignments/caps, so they require no additional stored rename.
- Module-ops, supervisor and process-state identify the module as `vault`, not
  a vault instance. Service IDs, ports and daemon PID paths remain unchanged.
  Default-vault selection and vault-owned paths/configuration follow the CLI.
- Client registration scopes describe allowed namespaces, not existing vault
  identity/consent. Sessions, signing keys, attribution archives, audit records,
  and revoked token history remain historical or user/module keyed.

The SQLite transaction and connection-file compensation protect handled
failures, not sudden process/power loss between filesystem and DB commits.
The module CLI backup and reported reverse-rename outcome support recovery.
No services were restarted during development; tests inject the CLI, stop, and restart.

## Validation

- `bun run typecheck`: passed.
- `bun test ./src/__tests__/admin-vaults-rename.test.ts ./src/__tests__/admin-vaults.test.ts ./src/__tests__/account-api.test.ts ./src/__tests__/jwt-sign.test.ts ./src/__tests__/oauth-handlers.test.ts ./src/__tests__/grants.test.ts ./src/__tests__/invites.test.ts ./src/__tests__/channel-vaults.test.ts ./src/__tests__/vault-caps.test.ts`:
  488 passed, 0 failed, 1,814 assertions across 9 files (19 rename tests).
- `bunx biome check` on the touched files: passed for all 10 TypeScript files;
  Biome does not check Markdown.
- No live-state access or service restart. The companion vault PR is unchanged.
