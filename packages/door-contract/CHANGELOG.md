# @openparachute/door-contract

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
