> Moved from parachute-patterns/patterns/oauth-scopes.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# OAuth scopes

## Convention

Parachute OAuth tokens carry **whitespace-separated scope strings**
(OAuth 2.0 §3.3). Every scope follows the same shape:

```
<service>[:<resource>]*:<action>
```

- First segment — the service (vault, scribe, agent, surface, hub, or any
  third-party module's declared name).
- Last segment — the action (`read`, `write`, `admin`, or a service-specific
  verb like `transcribe`, `send`).
- Middle segments (zero or more) — a resource hierarchy that narrows the
  scope. Two narrowing segments are in use: `vault:<name>:<verb>`
  (per-vault), which is **the enforced shape** for hub-issued JWTs —
  see Parser rules below — and `surface:<name>:<verb>` (per-surface,
  enforced at the hub's authenticated git endpoint — Surface Git
  Transport, 2026-06-30).

## Scopes (launch set + later additions)

| Scope | Grants |
| --- | --- |
| `vault:<name>:read` | Read the named vault via REST + MCP |
| `vault:<name>:write` | Write + read (inheritance) |
| `vault:<name>:admin` | Write + read + `/.parachute/config*` |
| `scribe:transcribe` | POST audio to scribe's transcription endpoint |
| `scribe:admin` | Manage scribe config |
| `hub:admin` | Manage hub services catalog + OAuth config (Reserved; not yet enforced) |
| `parachute:host:admin` | Drive the hub's vault instance-lifecycle *transactions* (`POST /vaults` / `DELETE /vaults/<name>`) and other host-level admin (operator-only-mintable; not requestable from third-party clients). The provisioning *UX* lives in vault's own surface — see [`hub-module-boundary.md`](./hub-module-boundary.md). |
| `surface:<name>:read` | Fetch/clone the named surface's hub-hosted git repo (Surface Git Transport) |
| `surface:<name>:write` | Push to the named surface's repo (write ⊇ read at the git endpoint) |
| `surface:admin` | surface-host module admin — the hub↔surface-host notify bearer + the credential endpoint |
| `account:<id>:read` | Read the account: list the owner's vaults, read their caps/usage (Parachute App campaign, Phase 2 — the `/account/*` door contract). Cookie-minted only via `POST /account/token`; **not requestable** from third-party clients. On self-host `<id>` is the sentinel `self` (account ≡ box). |
| `account:<id>:admin` | Every account mutation: create/delete/import vaults, mint per-vault tokens, set caps. `admin ⊇ read`. Cookie-minted only via `POST /account/token`; **not requestable**. |

Third-party modules declare their own namespace (`my-service:read`, etc.)
and the hub renders consent for those scopes the same way.

**Retired `agent:*` namespace.** Historical Agent modules used
`agent:read` / `agent:send` / `agent:admin`. The module and its dedicated
token-mint endpoint are retired; these scopes are no longer issued by Hub.
Migration records remain under
[`../migrations/`](../migrations/) for operators archiving old installs.

## Inheritance

```
admin ⊇ write ⊇ read       (vault)
write ⊇ read               (surface:<name>, at the git endpoint)
admin ⊇ read               (account:<id>, at the /account/* validator)
```

- `vault:<name>:admin` satisfies any check for `vault:<name>:write` or
  `vault:<name>:read` on the same vault. Inheritance is per-resource —
  `vault:work:admin` does **not** satisfy a `vault:personal:read` check.
- `surface:<name>:write` satisfies a `surface:<name>:read` check at the
  hub's git endpoint (fetch is implied by push authority). Same
  per-resource rule: no cross-surface inheritance, and module-level
  `surface:admin` is a separate axis (it does not imply per-surface git
  access).
- The live agent module's verbs (`agent:read` / `agent:send` /
  `agent:admin`) do **not** form the read/write/admin tree — `send` is
  its own axis. (The *retired containers* agent's `agent:admin` ⊇
  `agent:write` ⊇ `agent:read` tree died with that module 2026-05-20.)
- **Non-inheritance scopes exact-match only.** `scribe:admin` does **not**
  currently imply `scribe:transcribe` — each non-inheritance-tree scope
  stands alone. This is deliberate: we add inheritance per-service
  when the verb set clearly lines up as read/write/admin.

Canonical implementations:
- vault — [`parachute-vault/src/scopes.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/src/scopes.ts)
  (`hasScope`, `hasScopeForVault`, `findBroadVaultScopes`,
  `parseScopes`, `verbForMethod`). Per-vault narrowing landed in
  [PR #180](https://github.com/ParachuteComputer/parachute-vault/pull/180).

## Parser rules

- **Split on whitespace** for the scope string; **split on `:`** for each
  scope.
- **`vault:<name>:<verb>` is the enforced shape** — hub-issued JWTs MUST
  carry resource-bound vault scopes. The hub's OAuth picker rewrites a
  client's unnamed `vault:<verb>` request to `vault:<picked>:<verb>`
  before issuing the auth code (see [parachute-hub/src/oauth-handlers.ts]).
  Vault rejects bare `vault:<verb>` from JWT-shaped bearers.
- **Per-vault audience binding.** Hub-issued vault JWTs carry
  `aud=vault.<name>` and vault strict-checks it on each request — a token
  scoped for one vault cannot be replayed against another.
- **Vault-bound consent drops foreign scopes.** When a client sends an
  RFC 8707 `resource=<origin>/vault/<name>/mcp` indicator (an MCP client
  connecting to one vault), the hub narrows the consent — and the minted
  token — to that vault's `vault:<name>:<verb>` scopes and **drops** any
  non-vault scope (`scribe:*`, `agent:send`, `hub:admin`). Those are
  unusable inside an `aud=vault.<name>` token and would only inflate the
  consent surface a friend sees connecting a single vault. A client that
  legitimately wants a `scribe:` token runs a separate flow naming the scribe
  resource. (hub#487; see `parachute-hub/src/resource-binding.ts`.)
- **`pvt_*` tokens — retired (superseded).** This bullet used to say
  `pvt_*` tokens were unaffected (issue-time-scoped in vault's own DB,
  bypassing JWT validation). The module-minted `pvt_*` path was retired
  entirely (vault#412; the vault 0.6.0 path) — **hub-minted JWTs are the
  only token issuance**. See the supersession banner on
  [`token-auth.md`](./token-auth.md) and
  [`tag-scoped-tokens.md`](./tag-scoped-tokens.md) for the current model.
- **Issuer (`iss`) validation is set-tolerant on scope-guard ≥ 0.5.0.**
  One box can be reachable on several URLs at once (loopback, `sslip.io`,
  custom domain), so resource servers accept a token whose `iss` is *any
  member of the hub's published origin set* (`PARACHUTE_HUB_ORIGINS`),
  not just the single `PARACHUTE_HUB_ORIGIN`. The JWKS signature verify
  runs FIRST and unconditionally; the set is hub/operator-controlled
  only and never derived from a request `Host`. See
  [`../migrations/2026-06-25-multi-origin-iss-set.md`](../migrations/2026-06-25-multi-origin-iss-set.md).
- **Empty resource segments are preserved verbatim** (`vault::read` stays
  `vault::read`, so it can't satisfy any vault check — a one-line defence
  against a malformed DB row).
- **Unknown scopes pass through** the parser untouched. They simply won't
  match anything, which is the right failure mode for a future-scope that
  reaches an old server.

## Operator-only scopes

Some scopes are marked **non-requestable** — the hub will refuse to issue
them to any third-party OAuth client. They can only be minted on the
operator-token path (the locally-stored `~/.parachute/operator.token`
that ships with hub install).

- `parachute:host:admin` — the vault instance-lifecycle *transactions* on
  the hub: `POST /vaults` / `DELETE /vaults/<name>`. Cross-vault data
  sovereignty; high blast radius. The asymmetry vs `hub:admin` (which IS
  requestable) is deliberate: `hub:admin` manages service registration,
  `parachute:host:admin` creates and destroys long-lived data resources
  on the host filesystem. Ownership split per
  [`hub-module-boundary.md`](./hub-module-boundary.md): the hub owns the
  provisioning *transaction* (an identity transaction — token mints,
  grants, lifecycle cascades); the module's own surface owns the
  provisioning *UX* (vault's daemon-level `/vault/admin/`, which drives
  these endpoints with a host-admin Bearer minted from the operator's
  session).

Implementation: hub maintains a `NON_REQUESTABLE_SCOPES` set checked at
`/oauth/authorize` request time; `invalid_scope` per RFC 6749 if a third
party requests one.

## 403 response shape

When a request is authenticated but under-scoped, modules return:

```json
{
  "error": "Forbidden",
  "error_type": "insufficient_scope",
  "message": "This endpoint requires the 'vault:write' scope.",
  "required_scope": "vault:write",
  "granted_scopes": ["vault:read"]
}
```

`error_type: "insufficient_scope"` is the machine-readable key clients
should branch on (so they can present "Reconnect with broader access" UI
without parsing the human message).

## HTTP ↔ scope mapping

Vault's default, reused verbatim by any API-surface module with the same
verb set:

| Method | Scope |
| --- | --- |
| `GET` / `HEAD` / `OPTIONS` | `<service>:read` |
| `POST` / `PUT` / `PATCH` / `DELETE` | `<service>:write` |
| `/.parachute/config*` (regardless of method) | `<service>:admin` |

MCP tools are partitioned by intended effect, not by HTTP verb — see the
per-tool gate table in vault's PR #97.

## Soft-launch back-compat

v0.2-era tokens carry a legacy `permission` column (`"full"` or `"read"`)
instead of a scope string. For **one release cycle after enforcement
lands**, these are mapped on the fly by
`legacyPermissionToScopes(permission)`:

- `"full"` / `"admin"` / `"write"` → `[vault:read, vault:write, vault:admin]`
- `"read"` → `[vault:read]`

A one-shot per-process-per-token warning is logged on first use so
operators can see which tokens need rotation. The mapper is marked
`@deprecated`; remove it one release after v0.4.

The OAuth `token_endpoint_auth_methods_supported`/`scopes_supported`
metadata similarly keeps `full` + `read` alongside the `vault:*` scopes
for one release cycle so legacy clients don't hard-break on discovery.

## Rules

- **Declare scopes up front** in your module's `.parachute/module.json`
  under `scopes.defines`. The hub renders consent prompts from this list.
- **Use OAuth-standard whitespace serialization**, not comma-separated.
  Parsers MUST accept any whitespace run including `\t` + `\n`.
- **Don't invent synonyms.** A module adding a new verb should add the
  verb, not alias an existing scope. New scopes are additive and cheap.
- **Respect the `admin ⊇ write ⊇ read` contract** when your module has
  exactly that verb set. If your verbs are `send` / `admin`, don't force
  them into the read/write/admin tree — they're separate axes.
- **`vault:admin` (or any `:admin`) gates `/.parachute/config*`** on that
  module. This is the cross-cutting rule every module should honour.

## Future: deeper per-resource narrowing

`vault:<name>:<verb>` (per-vault) is **enforced today** — see Parser
rules. The narrowing axis can go deeper; not yet designed:

- `vault:work:notes/inbox/:read` — read one path prefix inside one vault
  (notional; not yet designed).
- `scribe:groq:transcribe` — use only the `groq` provider on scribe.

The parser already knows to split on `:`; the matcher is what gains the
"most-specific-grant-wins" logic when we flip this on.

## Where this applies

- `parachute-vault` — reference implementation + enforcement (PR #97).
- `parachute-scribe` — scopes declared under `x-scopes` in the config
  schema; enforcement follows once hub starts issuing JWTs. See scribe's
  CLAUDE.md ("Scopes declared, not yet enforced").
- `parachute-surface` (surface-host) — declares `surface:read` /
  `surface:write` / `surface:admin` in `.parachute/module.json`; the
  per-surface `surface:<name>:<verb>` form is enforced by the **hub** at
  `/git/<name>` (`parachute-hub/src/git-transport.ts`, `requiredAccess`),
  and `surface:admin` gates the hub→surface-host notify + credential
  endpoints.
- `parachute-notes` — requests `vault:read vault:write scribe:transcribe`
  on first-run OAuth consent.

## Open questions

- When does `scribe:admin ⊃ scribe:transcribe` land? Not today, by the
  "exact-match for non-vault" rule. Likely when scribe grows a second
  non-admin verb and the tree clearly forms.
- Rotation / step-up story: a token granted `vault:read` requests
  `vault:write` later via refresh flow, hub re-prompts. Specced in the
  module-architecture design doc, not yet implemented.

## See also

- [`oauth-dcr-approval.md`](./oauth-dcr-approval.md) — the
  `pending` → `approved` lifecycle for OAuth clients registered via
  Dynamic Client Registration. Orthogonal to scopes (a client must be
  *approved* before its requested scopes are even evaluated).
