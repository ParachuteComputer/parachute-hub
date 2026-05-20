# Changelog

All notable changes to `@openparachute/scope-guard` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) loosely; versions follow [SemVer](https://semver.org/) with the pre-1.0 governance described in [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md).

The library's RC cadence is independent of `@openparachute/hub`'s — they ship from the same repo but aren't coupled in version.

## 0.3.0-rc.1 — 2026-05-20

Adds `vault_scope` claim surfacing + the `enforceVaultScope` defense-in-depth check (hub multi-user Phase 1 PR 5 — see [`2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/)). **Additive — no behavior change for existing adopters.** A bump from `0.2.x` to `0.3.0` does NOT start rejecting any token that `0.2.x` accepted; the new helper is opt-in and the new claim is surfaced as `[]` (unrestricted) when absent.

### Added

- **`HubJwtClaims.vaultScope: string[]`** — parsed from the JWT's `vault_scope` claim. Non-empty for non-admin users (a single-element list naming their `assigned_vault` per Phase 1; Phase 2 widens to multi-vault without a wire-shape change). Empty `[]` for admin users, pre-PR-4 tokens, and any token where the claim is absent or malformed. The lib normalizes all three "no pin" cases to `[]` so consumers don't need to distinguish.
- **`enforceVaultScope(claims, requestVaultName) → boolean`** — opt-in helper for resource servers. Returns `true` if `claims.vaultScope` is `[]` OR contains `requestVaultName`; returns `false` if `vaultScope` is non-empty and excludes the target. Consumers call it from inside their hub-JWT auth path (after `validateHubJwt`, before dispatching to the per-vault handler) and translate `false` to a 403 with `error: "vault_scope_mismatch"`. See `parachute-vault/src/auth.ts`'s `authenticateHubJwt` for the canonical wire-up.

### Why it's a minor bump, not a patch

The claim surface (`HubJwtClaims.vaultScope`) is a new required field on a public interface — adopters who structurally type the claims object (e.g. TypeScript callers that destructure `{ sub, scopes, aud, jti, clientId }`) keep working, but any caller that *constructs* a `HubJwtClaims` value (test fakes, mocks) now needs to provide `vaultScope` or it won't typecheck. That's the breaking-shape ripple that earns a minor over a patch. The runtime behavior is purely additive — the lib reads a new claim if present and surfaces `[]` if absent.

### Adoption notes

- **Vault**: adopt the helper inside `authenticateHubJwt` — derive the target vault from the request path, call `enforceVaultScope(claims, vaultName)`, return 403 with `vault_scope_mismatch` on false. See vault PR for the canonical pattern.
- **Scribe**: no-touch. Scribe's surface is per-vault-orthogonal (`scribe:transcribe` / `scribe:admin` aren't vault-named); a token's `vault_scope` is informational only at scribe. If a future scribe route accepts tokens that *do* name a vault (e.g. a per-vault transcription audit log), wire in `enforceVaultScope` at that route.
- **Notes**: no-touch. Notes is a frontend SPA; it holds the user's token and proxies through vault. The defense-in-depth check fires at vault, not at notes.
- **Parachute-agent**: not yet adopted. Agent's `parachute:agent:*` scopes don't carry a vault pin; `vault_scope` is informational. If an agent route ever dispatches to a vault on behalf of the user, that route should call `enforceVaultScope` before forwarding.

### Compatibility

- **No behavior change** for any existing adopter that doesn't call `enforceVaultScope`. The lib still validates JWTs identically — the new field is additive.
- **bundler-resolution consumers (vault, scribe, hub workspace):** unaffected.
- **NodeNext-strict consumers (agent's tsc + vitest):** unaffected. The `.js`-extension convention from 0.2.1 carries forward.

## 0.2.1 — 2026-05-10

Packaging fix. **0.2.0 is non-functional under NodeNext-strict consumers** — every non-bun adopter on `tsc + Node ESM + "moduleResolution": "nodenext"` should upgrade to 0.2.1 immediately.

### Fixed

- **Relative imports in published `dist/` now carry explicit `.js` extensions.** Source imports like `from "./validate"` were emitted into dist verbatim by tsc, which works for bun + `"moduleResolution": "bundler"` (vault, scribe, hub workspace) but breaks NodeNext: `Cannot find module ".../dist/parse"`. Type information collapses to `any`/`unknown` at the consumer; downstream paths that touch `HubJwtError.code` then fail TS18046 ("'err' is of type 'unknown'"). Added `.js` to every relative import in `src/index.ts` and `src/validate.ts` (the only non-test source files with relative imports); tsc now emits the extensions verbatim and NodeNext resolution succeeds.

### Compatibility

- **No behaviour change.** Every API surface is identical to 0.2.0. This is a pure packaging fix.
- **bundler-resolution consumers (vault, scribe, hub workspace):** unaffected. Bun resolves `.js` back to `.ts` transparently; the explicit extension is a no-op for them.
- **NodeNext-strict consumers (agent's tsc + vitest):** 0.2.0 was unusable; 0.2.1 works.
- **Vault and scribe** (currently on `^0.2.0`) auto-pick 0.2.1 on next `bun install` — no PR needed downstream.
- **Agent** updates its `minimumReleaseAgeExclude` pin from `0.2.0` to `0.2.1` (still exact-version-pinned per their governance).

### Forward-looking note

The internal convention going forward: relative imports in scope-guard source MUST carry `.js` extensions. The `index.ts` header comment now spells this out so the next contributor doesn't re-introduce the bug. Long-term, we'd add an `eslint-plugin-import` `extensions` rule (or biome equivalent if/when one ships) to mechanically enforce — out of scope for 0.2.1.

## 0.2.0 — 2026-05-10

Adds enforcement of the hub's revocation list (hub#212 Phase 4 RS-side foundation). **This is a behaviour-breaking minor for adopters**: any vault / scribe / parachute-agent / third-party RS that bumps from `0.1.x` will start rejecting JWTs whose `jti` appears in `<hub-origin>/.well-known/parachute-revocation.json`. Adopt only after testing against a revoked-token fixture (or equivalent integration test).

### Added

- **Revocation-list consumer** — `validateHubJwt` now fetches `<origin>/.well-known/parachute-revocation.json` lazily on first use; refreshes synchronously when older than the 60s TTL (matching hub's published `Cache-Control: max-age=60`); single-flight (concurrent validations during a refresh share one fetch). The cache is managed internally by `createScopeGuard` — downstream RSes should NOT instantiate their own caches; `ScopeGuard` owns the lifecycle so the validation pipeline stays the single source of truth. The only seam exposed is `revocationFetcher` (see `createScopeGuard` options below) for callers who need to compose around the network layer (logging, auth headers, alternative transports). Public exports: `defaultRevocationFetcher`, the `RevocationFetcher` and `RevocationListBody` types, and the `REVOCATION_CACHE_TTL_MS` constant.
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
