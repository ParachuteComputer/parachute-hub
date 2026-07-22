# @openparachute/door-contract

## 0.5.0

The `account:<id>:vaults` scope grammar (Wave A PR1) — the foundation the cloud
Wave A PRs consume as a pinned dependency (a cloud pin-bump follows). Wave A is
an account-level MCP connection (list-vaults + create-vault + query-across-vaults)
opened by a NEW narrow requestable scope, the SINGLE deliberate exception to the
account wall. Purely additive: new exports + one optional descriptor field, zero
change to any existing signature or behavior.

New in `scopes.ts` (re-exported from the package root):

- `isRequestableAccountScope(scope)` — the account wall stays closed except for
  the account-vaults connection scope. `account:vaults` (un-narrowed, the
  PRM-advertised request form) and `account:<id>:vaults` (consent-bound blanket)
  are requestable; `account:<id>:{admin,read}`, `account:admin`, `account:read`,
  and the 4-part `account:<id>:vaults:<vault>` (consent-narrowed — consent
  narrows, a client can't pre-narrow itself) are NOT. Exact-lowercase; casing
  variants fail closed.
- `ACCOUNT_VAULTS_VERB` (`"vaults"`), `ACCOUNT_VAULTS_UNNARROWED`
  (`"account:vaults"`), and `accountVaultsScope(id)` → `account:<id>:vaults`.
- `parseAccountVaultsScope(scope)` — 3-part → `{ id, vault: null }` (blanket),
  4-part → `{ id, vault }` (narrowed), else `null` (fail-closed on empty id/vault
  or extra parts).
- `accountVaultsGrant(grantedScopes, accountId)` — the coverage-set deriver:
  `{ blanket: true }` when a bare 3-part scope for this id is present (blanket
  always wins), else `{ vaults: [...] }` (the de-duped set of narrowed vault
  names for this id), else `null`. Foreign-id scopes are ignored.

The narrowing rides the SCOPE STRING (a set of 4-part scopes), NOT a side
`vault_scope` claim — a vault_scope wouldn't survive token refresh, whereas the
scope string does. The existing `account:<id>:<verb>` grammar
(`parseAccountScope` / `hasAccountScope` / `NON_REQUESTABLE_SCOPES`) and the REST
read/admin ladder are untouched.

`ParachuteAccountDescriptor` gains an optional `account_mcp_endpoint?: string` —
the account-MCP endpoint a client opens against the `account:<id>:vaults` scope.
Unset today (no door advertises it yet; `checkAccountDescriptor` does not require
it). This bump does NOT flip the `auth` field required — that flip stays gated on
both doors serving it (its own later PR), out of scope for this additive change.

## 0.4.0

The auth block + the session/token wire canon (hub-parity P0). `signup_path` and
`app_client_id` on `ParachuteAccountDescriptor` move from required to OPTIONAL
(a door advertises each only when it applies — hub's `signup_path` only while an
active public invite exists (Q2), a door with no reserved native client omits
`app_client_id`); `checkAccountDescriptor` validates both only when present. Adds
`AccountAuthDescriptor` (`methods`, `signin_path`) + optional `auth` on the
descriptor — drives the app's front-door branch (magic-link form vs a
ceremony-hop to the door's own sign-in page); optional in 0.4.0 so cloud@main
keeps typechecking pre-P3, required from 0.5.0. `AccountRoute` gains
`optional?: boolean`; `GET /account` and the `/account/vaults/<name>/caps`
routes are now marked optional in `ACCOUNT_ROUTES` (hub-only — cloud routes
`GET /account` to its SPA shell and derives caps from plan, not a per-vault
knob). New wire types written down once from the app's pinned shapes:
`AccountSessionResponse` (`GET /account/session`), `AccountTokenMintResponse`
(`POST /account/token`), `VaultTokenMintResponse`
(`POST /account/vaults/<name>/token`) — each with a matching `check*`
conformance helper. `ACCOUNT_ERROR_CODES` pins the shared `/account/*` error
vocabulary both doors already mirror. New `vault-scopes.ts`:
`validateVaultScopes(requested, vaultName)`, the ONE shared scope-shape
validator replacing hub's `parseScopesBody` scope logic and cloud's local
`validateVaultScopes` (cross-repo derived-key lesson) — absent/null/empty
requests default to `vault:<name>:{read,write}`, every entry must be exactly
`vault:<name>:{read|write|admin}`, results are de-duplicated. Additive to the
type surface; no existing call signature changes.

Review-fold (P0 review):
- `validateVaultScopes` now returns `{ ok: false; reason: "invalid_request" |
  "invalid_scope" }` on rejection (was a bare `{ ok: false }`) — the `reason`
  carries the door's wire error code so a door adopting the shared validator
  (P2/P3) keeps its exact HTTP error without re-deriving the split
  (`invalid_request` = non-array / non-string entry; `invalid_scope` =
  well-formed string naming the wrong resource/vault/verb, matching hub's
  `parseScopesBody`). New `VaultScopesReason` type. Nothing consumes the
  validator yet, so this is pure additive design.
- `ACCOUNT_ERROR_CODES` was born incomplete; added the codes both doors already
  emit but the pin missed: `account_suspended`, `not_found` (cloud),
  `method_not_allowed`, `server_error` (hub). Now the real union.
- Hardened the new conformance checkers: `checkAccountSessionResponse` requires
  `email`/`username` to be a string when present (not merely present);
  `checkVaultTokenMintResponse` requires the `vault:<name>` services entry to
  carry a string `url`; `isParseableTimestamp` now enforces true ISO-8601
  (rejecting `Date.parse`-lenient locale strings like `"January 1, 2026"`).

## 0.3.0

Adds the optional `vault_url_template` field to `ParachuteAccountDescriptor` — a
`{name}`-placeholder template a client substitutes to preview a vault's address
pre-creation, door-agnostically (cloud has both path + subdomain forms, so only
the door can render the right one). `checkAccountDescriptor` validates it only
when present (must be a string containing `{name}`). Additive; no breaking change.

## 0.2.0

C4 (Parachute App campaign, parachute-cloud#116) — the account-door descriptor.
Extends `ParachuteAccountDescriptor` (served at `GET /.well-known/parachute-account`)
with `signup_path`, `app_client_id`, `capabilities` (`AccountCapabilities`), and
`plans` (`AccountPlanSummary[]`) so a client learns where to sign up, which
first-party client to use, what the door can do, and its plan ladder without
hardcoding. Adds the `checkAccountDescriptor(actual, {issuer, door})` conformance
helper (mirrors `checkAuthorizationServerMetadata`) so both doors' descriptors
are pinned. Additive; no breaking changes.

## 0.1.0

Initial extraction (Cloud+Hub shared-core campaign, parachute-cloud#116,
Phase A). The shared OAuth-issuer + `/account/*` door contract, previously
duplicated across the self-host hub and the hosted cloud:

- token wire constants (`ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_MS`,
  `REFRESH_GRACE_MS`, `TOKEN_TYPE`, `SIGNING_ALG`) + `AccessTokenClaims` /
  `TokenResponse` types;
- the `account:<id>:<verb>` scope grammar + `hasAccountScope`;
- RFC 8414 / 9728 discovery-doc vectors;
- the `/account/*` route table + request/response types;
- the shared conformance corpus (`check*` helpers).

Consumed test-only by the hub in this release (drift-detector parity test);
runtime adoption in both doors + cloud conformance-suite adoption follow in
Phase B.
