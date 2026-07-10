# @openparachute/door-contract

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
