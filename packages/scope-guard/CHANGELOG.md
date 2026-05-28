# Changelog

All notable changes to `@openparachute/scope-guard` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) loosely; versions follow [SemVer](https://semver.org/) with the pre-1.0 governance described in [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md).

The library's RC cadence is independent of `@openparachute/hub`'s — they ship from the same repo but aren't coupled in version.

## 0.4.0-rc.2 — 2026-05-28

Surfaces the raw `permissions` claim on `HubJwtClaims` (additive) so resource servers (e.g. vault reading `permissions.scoped_tags` for tag-scoping) can read it without re-decoding the token. scope-guard passes the object through verbatim — a non-null plain object surfaces; absent / null / non-object (string, number, array) leaves `permissions` `undefined`, distinct from an empty `{}`. Auth-unification arc C0.

## 0.4.0-rc.1 — 2026-05-22

Adds the hub#218 jti-presence hardening: hub-signed JWTs that lack a `jti` claim are rejected by default. **Behaviour-breaking minor** — any adopter that bumps from `0.3.x` will start rejecting jti-less hub-signed tokens. The default is the security floor; an `allowMissingJti: true` opt-out is available for operators with pre-Phase-1 legacy tokens still in flight.

### Why this is hardening, not a bug fix

Per hub#218 (and the conservative-today choice in hub#217 Phase 4), `validateHubJwt` previously *skipped* the revocation lookup for tokens without `jti` — they passed validation entirely. All legitimate hub-issued tokens carry `jti` per the token-registry contract introduced in hub#212 Phase 1 (the `tokens` table is keyed by jti; every mint path — `signAccessToken`, `recordTokenMint`, `signRefreshToken` — stamps one). A jti-less, hub-signed JWT is therefore an anomaly: either a pre-Phase-1 legacy issuance path that should have aged out, or a token forged by an attacker who got a signing key but skipped the registry path. Accepting it is the conservative-today choice; the stricter posture is to reject because revocation cannot be enforced on tokens we can't index.

### Added

- **`HubJwtError(code: "shape", "hub JWT missing required \`jti\` claim")`** for jti-less or empty-jti tokens. Surfaces alongside the existing `sub`-shape rejection so consumers can branch on `code: "shape"` and inspect the message for the specific missing-field detail.
- **`CreateScopeGuardOptions.allowMissingJti?: boolean`** — operator opt-out for the strict default. When `true`, jti-less tokens validate successfully (with revocation-lookup skipped, since lists are keyed by jti). When `false` (the default), jti-less tokens are rejected as `code: "shape"`. The opt-out exists for the transition window where operators have legitimate pre-Phase-1 tokens in flight; it's NOT a steady-state configuration.
- **`CreateScopeGuardOptions.missingJtiLogger?: (info) => void`** — observability seam for the opt-out path. When `allowMissingJti: true` and a jti-less token is accepted, the logger fires with `{ sub, aud, iat }` so operators can monitor the legacy-token decay curve before flipping strict-mode back on. Optional — omitting it gives silent accept.

### Changed

- **`validateHubJwt` rejects jti-less tokens by default.** The jti-presence check runs after signature + iss + sub + audience (so a forged or malformed token's signature failure surfaces first — no information leak about whether the forgery happened to carry a jti) but before the revocation lookup (which depends on jti existing). Tokens that DO carry jti still go through revocation enforcement unchanged.
- **Empty-string `jti` ("")** is treated identically to a missing claim — the same `code: "shape"` rejection. Accepting it would let a forger bypass the registry contract by emitting `jti: ""`.

### Migration notes for adopters (vault, scribe, parachute-agent)

- **The behaviour change is automatic on dep bump.** Adopters that pick up `0.4.0` will start rejecting any hub-signed JWT without `jti`. Pre-Phase-1 hubs (older than `0.5.7`, before the token-registry contract) issued some tokens without `jti`; those tokens will be rejected once the consumer dep-bumps. Hub mints from `0.5.7` onwards all carry jti, so the practical exposure is "tokens minted before 2026-05 that haven't yet expired."
- **Operators with legacy tokens in flight** set `allowMissingJti: true` in their `createScopeGuard({ ... })` call during a transition window. Once the legacy decay curve flattens (visible via `missingJtiLogger` traffic dropping to zero), flip back to the strict default.
- **Adopting consumers should add a regression test** that exercises both paths: (a) a hand-built jti-less token is rejected with `code: "shape"` under the strict default, (b) the same token is accepted under `allowMissingJti: true`.

### Compatibility

- **bundler-resolution consumers (vault, scribe, hub workspace):** behavior change as above. The `vaultScope` claim surface from 0.3.0 carries forward unchanged.
- **NodeNext-strict consumers (agent's tsc + vitest):** behavior change as above. The `.js`-extension convention from 0.2.1 carries forward.
- **The new options (`allowMissingJti`, `missingJtiLogger`)** are both optional — the type signature change is additive at the construction site.

### Hub-side audit

Confirmed (via `git grep "SignJWT\\|setJti"` over hub's `src/`) that every JWT mint path in hub goes through `signAccessToken` (`src/jwt-sign.ts`), which always stamps jti via `randomBytes(16).toString("base64url")` when none is supplied. Callers: `oauth-handlers.ts` (auth-code + refresh grants), `api-mint-token.ts`, `operator-token.ts`, `admin-host-admin-token.ts`, `admin-vault-admin-token.ts`, `api-modules-config.ts`, `commands/auth.ts`. No raw `new SignJWT(...)` calls outside `signAccessToken`. The hub side is clean — no mint-path patches needed for this release.

## [0.3.0] - 2026-05-20

Stable release. Multi-user Phase 1 vault scope enforcement.

- **`vault_scope` claim required field** on `HubJwtClaims` (#285): tokens now carry a `vault_scope: string[]` claim. `[]` = unrestricted (admin); `["vault-name"]` = pinned to that vault. Back-compat: absent claim → `[]` (pre-PR-4 tokens still work).
- **`enforceVaultScope(claims, requestVaultName)` helper** (#285): resource servers (vault, notes, scribe) call this to refuse cross-vault access when a token's `vault_scope` doesn't include the requested vault. Returns `true` if `vault_scope` is empty OR `requestVaultName` is in it.
- **Defensive parsing** (#285): malformed `vault_scope` (non-array, null, mixed types) → fallback to `[]`. Primary security gate is the scope-string check; `vault_scope` is defense-in-depth.

Adopters: vault@0.4.6 consumes this version. Notes and scribe pass through unchanged (no vault-bound tokens at the consumer side).

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
