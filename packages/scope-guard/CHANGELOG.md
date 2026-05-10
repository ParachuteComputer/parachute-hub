# Changelog

All notable changes to `@openparachute/scope-guard` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) loosely; versions follow [SemVer](https://semver.org/) with the pre-1.0 governance described in [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md).

The library's RC cadence is independent of `@openparachute/hub`'s — they ship from the same repo but aren't coupled in version.

## 0.2.0 — 2026-05-10

Adds enforcement of the hub's revocation list (hub#212 Phase 4 RS-side foundation). **This is a behaviour-breaking minor for adopters**: any vault / scribe / parachute-agent / third-party RS that bumps from `0.1.x` will start rejecting JWTs whose `jti` appears in `<hub-origin>/.well-known/parachute-revocation.json`. Adopt only after testing against a revoked-token fixture (or equivalent integration test).

### Added

- **`RevocationCache`** — per-`ScopeGuard` consumer of the hub's revocation list. Fetches `<origin>/.well-known/parachute-revocation.json` lazily on first use; refreshes synchronously when older than the 60s TTL (matching hub's published `Cache-Control: max-age=60`); single-flight (concurrent validations during a refresh share one fetch). Exposed for direct use as `createRevocationCache`, with `defaultRevocationFetcher`, `RevocationFetcher`, `RevocationListBody`, `RevocationCheckOutcome`, and the `REVOCATION_CACHE_TTL_MS` constant.
- **`createScopeGuard` options** — `revocationFetcher` (test seam for the list source), `revocationTtlMs` (override the default 60s; tests use small values), `revocationNow` (test seam for time inside the cache).
- **`guard.resetRevocationCache()`** — drops the cached list. Tests use this to start from a clean fail-closed state; production callers shouldn't need it.
- **`HubJwtErrorCode`** gains `"revoked"` and `"revocation_unavailable"`.
  - `revoked` — the token's `jti` appears in the revocation list. The token has been intentionally retired by the operator.
  - `revocation_unavailable` — couldn't load the list and we have no last-good cache yet, so we fail-closed and reject. Operationally distinct from `revoked` so operators chasing a regression can tell "hub is down" from "this token has been retired."

### Changed

- **`validateHubJwt` now consults the revocation cache** as the LAST step in the validation pipeline (signature → iss → shape → audience → revocation). Cheaper checks reject first, so a bad signature never costs a network roundtrip. Tokens without a `jti` claim skip the lookup entirely (lists are keyed by jti; pre-revocation-list legacy tokens stay valid until natural expiry).
- **Failure semantics**:
  - **Fail-open with last-good cache** — if a refresh fails but a previous successful fetch is still in memory, keep using it. Worst-case a revoked token is accepted ~60s past revocation while the hub is unreachable; that's the published convergence target.
  - **Fail-closed on first-fetch failure** — if no last-good cache exists yet (process startup or persistent hub outage from cold start), reject all hub-issued JWTs as `revocation_unavailable` until a fetch succeeds.
  - **Backoff** — on a failed refresh with last-good in memory, the next attempt waits another full TTL window (~60s) rather than retrying every validation. Avoids a thundering herd against a downed hub. Worst-case revocation latency degrades to ~2× TTL during outages.

### Migration notes for adopters (vault, scribe, parachute-agent)

- The behaviour change is automatic on dep bump — there's no opt-in flag. Adding a flag would add misconfiguration surface; consistent enforcement is the entire point of the migration.
- The hub publishes `parachute-revocation.json` from `0.5.7` onwards. If your hub is older than that, **do not bump scope-guard** until the operator upgrades — the missing endpoint will fail-closed every JWT until the cache populates (which it can't, because the endpoint 404s).
- Add an integration test that mints a hub JWT, revokes it via the hub's admin path, and asserts that scope-guard rejects with `code: "revoked"` after the cache TTL elapses. Without that test you're shipping an unverified upgrade.

## 0.1.0 — 2026-05-05

First stable release. Promoted from `0.1.0-rc.1` after the API surface stabilised across the vault → scribe → parachute-agent migration sequence.

### Added

- **`createScopeGuard({ hubOrigin, jwks?, jwksGetter? })`** — factory bound to a hub origin. Holds the JWKS getter so the cache lives across requests. `hubOrigin` accepts a string or a resolver function (the function form lets consumers layer their own env-var precedence, e.g. parachute-agent's `PARACHUTE_AGENT_HUB_ORIGIN` over `PARACHUTE_HUB_ORIGIN`).
- **`guard.validateHubJwt(token, { expectedAudience? })`** — JWKS-backed verify. Pins `iss` to the configured hub origin (without that, anyone could mint a token against any RSA key and pass JWKS verification). Strict-checks `aud` (RFC 7519 string-or-array) when supplied. Throws `HubJwtError` with a coarse `code` on failure.
- **`HubJwtError.code`** taxonomy — `signature | issuer | expired | kid | jwks | audience | shape`. Single error class; consumers branch on `code` rather than catching subclasses.
- **`hasScope(granted, required)`** — generic `<resource>:<verb>` and `<resource>:<name>:<verb>` matcher with `admin ⊇ write ⊇ read` inheritance. The library is the engine, not the dictionary; per-service scope vocabularies and cross-resource catch-alls stay in each service.
- **`parseScopes(raw)` / `extractBearer(authHeader)` / `looksLikeJwt(token)`** — string helpers every consumer reaches for.
- **JWKS cache controls** — defaults: 5min `cacheMaxAge`, 30s `cooldown`. Override via the `jwks` option, or inject a `jwksGetter` directly to bypass the cache entirely (tests and non-default JWKS topologies).
- **`guard.resetJwksCache()`** — drops the cached JWKS getter for the bound origin. Tests use this to switch fake JWKS endpoints between cases.

### Design notes

- The library lives as a sub-package of `parachute-hub` because the hub owns the JWT-issuance side and the scope vocabulary. It's published independently to npm as `@openparachute/scope-guard`.
- See [`parachute-hub/docs/design/2026-04-29-scope-guard-library.md`](https://github.com/ParachuteComputer/parachute-hub/blob/main/docs/design/2026-04-29-scope-guard-library.md) for full rationale, alternatives considered, and the migration sequence.
