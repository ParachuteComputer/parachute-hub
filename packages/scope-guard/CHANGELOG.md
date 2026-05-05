# Changelog

All notable changes to `@openparachute/scope-guard` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) loosely; versions follow [SemVer](https://semver.org/) with the pre-1.0 governance described in [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md).

The library's RC cadence is independent of `@openparachute/hub`'s — they ship from the same repo but aren't coupled in version.

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
