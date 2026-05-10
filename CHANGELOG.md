# Changelog

All notable changes to `@openparachute/hub` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) loosely; versions follow [SemVer](https://semver.org/) with the pre-1.0 RC governance described in [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md).

## [0.5.8-rc.11] - 2026-05-10

Holistic restructure of the integrated hub experience — the bigger redesign Aaron asked for after rc.10's small relabel ("clicked Vault on discovery, took me to hub management — there's confusion between use vs admin"). Discovery page split into Use / Admin; the admin SPA relocates to `/admin/*` with 301 redirects from the prior `/vault` and `/hub/*` mounts. Closes hub#231.

### Changed

- **Discovery page (`/`) restructured** into two `<section>`s:
  - **Use** — per-service primary affordances. Browse notes (the Notes PWA, which is the vault-content browse path); Transcribe audio (Scribe); Run agents (Agent). Entries are dynamic, derived from `services.json`; only installed services appear, paths come from the registered mount (so custom paths still work). Vault deliberately omitted — its content is browsed via Notes; provisioning lives under Admin.
  - **Admin** — three always-visible cards: Vaults (`/admin/vaults`), Permissions (`/admin/permissions`), Tokens (`/admin/tokens`). Renders synchronously so an operator sees admin even if the well-known fetch is slow.
- **Admin SPA mounts at `/admin/*` (was `/vault` + `/hub/*`).** Single mount; the SPA's basename is `/admin`; Vite build base is `/admin/`; assets resolve at `/admin/assets/*`. main.tsx and App.tsx simplified — `isHubMount` and the dual-mount detection both gone.
- **Brand renamed** from "Parachute Hub" to "Parachute Admin" (it's unambiguously admin now). Subtitle is route-derived ("vaults" / "permissions" / "tokens") via `useLocation` — updates on client-side nav.

### Added

- **301 back-compat redirects** for every pre-rename SPA URL:
  - `/vault` → `/admin/vaults`
  - `/vault/new` → `/admin/vaults/new`
  - `/hub/vaults*` → `/admin/vaults*` (this redirect predated #231; now retargets at the final mount instead of bouncing through the interim `/vault`)
  - `/hub/permissions` → `/admin/permissions`
  - `/hub/tokens` → `/admin/tokens`
  - `/hub` (bare) → `/admin/vaults`
  - All preserve query strings; method-agnostic (no POST endpoint at any of these paths).

### Compatibility

- **`/vault/<name>/*` (per-vault content proxy) is unchanged** — that's user-facing vault data (Notes PWA, etc.), not the admin SPA. Stays where it is.
- **Pre-rename `/vault/<unknown>/*` SPA-shell fallback removed.** Under the prior shape, an unregistered vault name fell through to the SPA shell (which would client-side render a 404). Now it 404s directly. No operator workflow relied on the SPA-shell fallback.
- **Pre-rename `/hub/*` SPA mount removed.** Known prefixes 301 to the new locations; unknown `/hub/*` paths 404 (was: SPA shell). Documented in the dispatch comments.

### Out of scope (deferred — separate issues)

- Module.json `useUrl` / `adminUrl` fields (cross-repo work; future Phase 2 follow-up).
- Vault-side per-instance admin UI (filed as vault#283).
- Discovery functionality beyond the Use/Admin split — status pills, real-time health, etc. (Phase 3 if anyone wants).

### Test gate

All test suites pass. New coverage in this PR:

- **`hub.test.ts`** rewritten for the new discovery shape — 15 tests covering the Use/Admin section structure, dynamic Use entries from services.json, hardcoded Admin entries, the synchronous-Admin-render guarantee, and absence of the retired aggregate-by-module-type code.
- **`hub-server.test.ts`** retired the pre-rename `/vault` and `/hub/*` SPA tests; added 9 new tests across the new `/admin/*` SPA mount (vaults / vaults/new / permissions / tokens / assets / 503 + 405 surfaces) and every 301 redirect (`/vault`, `/vault/new`, `/hub/vaults*`, `/hub/permissions`, `/hub/tokens`, `/hub` bare) including query-string preservation.
- **`App.test.tsx`** rewritten to use `MemoryRouter`'s `initialEntries` (subtitle is now router-derived; no more `Object.defineProperty(window.location, ...)`). Covers route-derived subtitle, single-mount nav structure, and per-route component rendering (including the 404 fallback).

Typecheck (both packages): clean. biome: clean. UI build + `verify-base`: clean (asserts `/admin/`-prefixed asset URLs).

(Test-count numbers intentionally omitted — the canonical-vs-combined ambiguity is tracked at hub#219.)

## [0.5.8-rc.10] - 2026-05-10

UX polish on the admin SPA — addresses the "/hub/tokens feels inside of the /vault UI" concern Aaron raised after rc.9. Three small changes; no API surface change, no behavior change beyond labels and visual grouping.

### Changed

- **Brand subtitle is now context-aware.** "Parachute Hub <span>vault management</span>" was a misnomer — the SPA is cross-vault provisioning under `/vault/*`, not per-vault management. Subtitle now derives from the active mount:
  - `/vault/*` → "vault provisioning"
  - `/hub/*` → "host admin"
  - origin root → falls back to "vault provisioning"
- **Nav links are visually grouped.** Three logical clusters separated by thin vertical dividers (decorative, `aria-hidden="true"`):
  - **Vaults** (vault provisioning)
  - **Permissions, Tokens** (host admin)
  - **Discovery** (top-level)
  
  No new entries; just hierarchy. New `.nav-divider` CSS class — single rule, mirrors the existing `--border` token.
- **Header doc-comment in `App.tsx`** explaining what this SPA is and isn't:
  - It IS hub admin: cross-vault provisioning + cross-cutting host concerns.
  - It is NOT a vault-internal admin UI — vault has its own MCP endpoint for AI clients and the Notes PWA for human content browsing.
  - Per-instance vault admin (config / schemas) doesn't have a UI today; if/when it does, it'll be vault-served (analogous to agent's own admin).

### Added

- **`web/ui/src/App.test.tsx`** — first test file for `App`. Eight new tests: six subtitle cases (covering `/vault`, `/vault/new`, `/hub/tokens`, `/hub/permissions`, bare `/hub`, and origin root) plus two nav-structure assertions (link order + divider presence with `aria-hidden`).

### Out of scope (deferred — separate issues)

- URL renames (`/vault` → `/admin/vaults`, `/hub/permissions` → `/admin/permissions`).
- Vault-side per-instance admin UI.

### Test gate

- web/ui: 77 pass / 0 fail (was 69; +8 across the App test file).
- hub: 1194 pass / 0 fail (unchanged — no backend touched).
- typecheck (both packages): clean. biome: clean. UI build + verify-base: clean.

## [0.5.8-rc.9] - 2026-05-10

End-to-end bugfix surfaced from manual testing of `/hub/tokens` (Phase 2 admin UI from rc.8): the SPA's session-bearer (minted by `GET /admin/host-admin-token`) carried only `parachute:host:admin`, but the new admin endpoints (`/api/auth/mint-token`, `/api/auth/revoke-token`, `/api/auth/tokens`) gate on `parachute:host:auth`. SPA failed with `Couldn't load tokens: bearer token lacks parachute:host:auth` on first load.

### Fixed

- **`HOST_ADMIN_SCOPES`** in `src/admin-host-admin-token.ts` now includes both `parachute:host:admin` AND `parachute:host:auth`. Brings the SPA's session-bearer in line with the `--scope-set admin` operator-token semantics from hub#214 / #222 (admin = superset of all narrower scope-sets, including `auth`). Both scopes are already in `NON_REQUESTABLE_SCOPES`, so the security envelope is unchanged — the SPA bearer is still mintable only via the local cookie path.

### Added

- **End-to-end regression test** in `src/__tests__/admin-host-admin-token.test.ts`: mints a JWT through the SPA cookie flow, then exercises `GET /api/auth/tokens` with that bearer and asserts 200 (was 403 pre-fix). The Phase 2 backend tests minted operator-style tokens with `:host:auth` directly — they didn't exercise the full SPA session flow, leaving this gap. New test pins it.

### Why this slipped past Phase 2 reviews

The new admin endpoints' tests minted bearer tokens with the right scope directly via `mintOperatorToken({ scopeSet: "admin" })`. None walked the path the SPA actually takes — cookie → host-admin-token → `:host:admin`-only JWT → admin endpoint. The dual-scope semantics that the operator-side already had via the `admin` scope-set wasn't mirrored to the SPA-side mint until manual end-to-end testing surfaced the mismatch. Regression test now covers the full flow so a future shape divergence here can't reach production.

### Test gate

- hub: 1194 pass / 0 fail (was 1193; +1 for the new regression test).
- typecheck + biome: clean.

## [0.5.8-rc.8] - 2026-05-10

Phase 2 of hub#212: admin UI for token management at `/hub/tokens`. Operators get a browser surface for the registry that backed `parachute auth mint-token`, `parachute auth revoke-token`, and the new HTTP endpoints from rc.7. Refs hub#212 (umbrella stays open through Phase 6).

### Added

- **`/hub/tokens` route** in the SPA. Three actions:
  - **List** — paginated, status-filtered (Show all / Live only / Revoked only) view of every registry row. Each row surfaces jti (truncated, full on hover), identity (`user_id ?? subject`), scope, status pill (live / expired / revoked), `created_via` provenance, dates, and an expandable `<details>` for the `permissions` JSON.
  - **Mint** — inline form (toggle from page header). Fields: scope (required), audience (optional, inferred from scope on the hub side), expires_in (seconds), subject (defaults to operator's sub), permissions (JSON object, validated client-side). On success, the JWT is shown ONCE in a `mint-banner` with copy-to-clipboard and a clear "this is the only time" warning — no DB-side recovery.
  - **Revoke** — per-row button (live tokens only) → confirm dialog → `POST /api/auth/revoke-token`. Mirrors the Permissions page's revoke flow exactly.
- **Three new API helpers in `web/ui/src/lib/api.ts`** — `listTokens(opts)`, `mintToken(input)`, `revokeToken(jti)`. All follow the established Bearer + clearCachedToken-on-401/403 pattern from `createVault` / `listGrants`. Types match the rc.7 wire shape verbatim (snake_case, parsed `permissions`).
- **Cursor pagination via "Load more" button** at the bottom of the list. Appends the next page in place; clears the button when `next_cursor` goes null.

### Changed

- **`web/ui/src/App.tsx`** — added `/hub/tokens` route alongside `/hub/permissions`. Renamed the local `isPermissionsMount` constant to `isHubMount` (now the mount hosts more than one route). Nav adds a "Tokens" link.

### Visual posture

- Reused every existing CSS class — `.vault-row`, `.tag` / `.tag.muted`, `.list-header`, `.empty-rich`, `.error-banner`, `.section`, `.mint-banner`, `.field-error`. Zero new CSS, zero new design system.

### Test gate

- hub: 1193 pass / 0 fail (unchanged from rc.7 — purely additive UI work).
- web UI: 66 pass / 0 fail (was 47 pre-existing; +19 across list rendering, status pills, filter pills, mint form validation + happy path, revoke confirm flow, "Load more" pagination, and one end-to-end integration that walks mint → see in list → revoke → see status update).
- typecheck (both): clean. biome: clean. UI build verified — `dist/index.html` carries `/vault/`-prefixed asset URLs per the post-build regression check.

## [0.5.8-rc.7] - 2026-05-10

Two new HTTP endpoints — backend foundation for hub#212 Phase 2 (admin UI for token management). Closes hub#220. The admin UI itself ships in a follow-up rc.8 PR; these endpoints have standalone value for any operator-tooling that wants programmatic registry access.

### Added

- **`POST /api/auth/revoke-token`** (closes #220). HTTP companion to `parachute auth revoke-token <jti>` from hub#221. Body: `{ jti }`. Auth: bearer with `parachute:host:auth` scope (admin scope-set carries it as a superset; narrow `--scope-set auth` operator tokens carry it directly — same gate as `POST /api/auth/mint-token`). Idempotent: re-revoking an already-revoked jti returns 200 with the original `revoked_at` (matches CLI semantics from #221). Returns 200 `{ jti, revoked_at }` on success; OAuth-spec error shapes (`invalid_request`/`invalid_token`/`insufficient_scope`/`not_found`/`method_not_allowed`) on failure.
- **`GET /api/auth/tokens`** (admin token list endpoint). Cursor-paginated list of registry rows, newest-first. Default page size 50, capped at 200. Supports `?revoked=true|false|all` and `?subject=<value>` filters; the subject filter matches against either `user_id` (OAuth rows) or `subject` (CLI/operator/service mints) so callers don't need to know which mint path created the row. Cursor is opaque base64; malformed cursors silently reset to page 1. Same `parachute:host:auth` gate.
- **`listTokens(db, opts)` helper in `src/jwt-sign.ts`** — the SQL + cursor logic backing the new list endpoint. Surface mirrors what `findTokenRowByJti` and friends already export from this module; reusable for any future programmatic registry-walking needs (admin UI, audit tools, CLI list command).

### Out of scope (Phase 2 follow-up: rc.8)

- The admin UI itself (`/hub/tokens` route — list view, mint form, revoke flow). UI builds atop these merged endpoints in the next PR.
- Bulk revoke / revoke-by-subject HTTP endpoints — file as separate enhancements if the UI surfaces a need.

## [0.5.8-rc.6] - 2026-05-10

Workspace consumes `@openparachute/scope-guard@0.2.1` — a packaging fix for NodeNext-strict consumers (agent's tsc + vitest). Hub itself is unaffected at runtime: hub's auth paths never go through scope-guard (they use the local `validateAccessToken` against the on-box DB), and the workspace consumes scope-guard via Bun's bundler resolution, which already resolved 0.2.0's extensionless imports correctly. Test gate unchanged.

### Changed

- **`@openparachute/scope-guard` 0.2.0 → 0.2.1** — adds explicit `.js` extensions to relative imports in published `dist/`. See `packages/scope-guard/CHANGELOG.md` for the full surface change. **Vault and scribe auto-pick the new patch on next `bun install` (their pin is `^0.2.0`); no downstream PR needed.** Agent updates its exact-pin separately.

## [0.5.8-rc.5] - 2026-05-10

Aligns the `parachute auth mint-token` CLI gate with the HTTP companion (`POST /api/auth/mint-token`) and the new `revoke-token` CLI: all three now gate on `parachute:host:auth` rather than the historically-narrower `hub:admin`. Closes hub#222. Backwards-compatible widening — operators with `admin` scope-set tokens (the default) are unaffected; operators with the narrow `--scope-set auth` operator token gain the ability the scope-set was always meant to grant per the #214 design.

### Changed

- **`parachute auth mint-token` CLI** now requires `parachute:host:auth` scope on the operator token instead of `hub:admin`. Previously, the CLI's gate was tighter than the HTTP endpoint's gate (which already used `:host:auth`), making the `auth` scope-set silently insufficient for CLI mints — the very operation it's named for. The asymmetry was identified during hub#221 review (the new `revoke-token` CLI's gate); this PR closes it.
- Error message updated: `lacks hub:admin scope` → `lacks parachute:host:auth scope`. Hint text updated to reflect that `--scope-set auth` is now sufficient (was: only `admin`).

### Compatibility

- **Operators with `admin` scope-set tokens** (the default from `parachute auth rotate-operator` with no `--scope-set` flag): no change. The `admin` scope-set is a superset that includes `parachute:host:auth`, so the gate still passes.
- **Operators with `--scope-set auth` tokens**: gain CLI mint-token access (intended design, finally honoured).
- **Operators with `--scope-set install/start/expose/vault` tokens**: still rejected. None of those carry `:host:auth`, by design.
- **No migration needed.** Anyone whose previous workflow worked still works.

## [0.5.8-rc.4] - 2026-05-10

Adds the operator-facing `parachute auth revoke-token <jti>` CLI — the missing companion to Phase 1's `revoked_at` column and revocation-list endpoint. Without this, end-to-end Phase 4 testing required reaching into `~/.parachute/hub/hub.db` with `sqlite3` and flipping the bit by hand. Distinct from the existing `revoke-grant` (retires OAuth *consent grants*) and `/oauth/revoke` (RFC 7009 refresh-token revocation): this revokes any *registry-row token* (CLI mints, operator mints, OAuth-issued access tokens) by jti.

### Added

- **`parachute auth revoke-token <jti>`** — flips `revoked_at` on the `tokens` row keyed by jti. Idempotent: re-revoking an already-revoked jti prints the existing `revoked_at` and exits 0. Not-found exits 1 with a clear "no token with jti X found in registry". On success, prints `revoked: jti=X, identity=..., scope=...` for operator audit trail. The `identity=` field surfaces `tokenRowIdentity(row)` — `userId` for OAuth-issued rows, `subject` for CLI / operator / service mints — so operators grepping on `identity=` get the right value regardless of which mint path created the token.
  - Auth gate: requires `parachute:host:auth` scope on the local `~/.parachute/operator.token` (the `auth` or `admin` scope-set covers this; narrower sets like `install`/`start`/`expose`/`vault` do not). Same gate semantics as `POST /api/auth/mint-token`.
  - Auto-rotation banner (when the operator token is within 7d of expiry) goes to stderr; stdout stays focused on the revocation outcome.
  - End-to-end semantics: revoke happens immediately in the local DB; the revocation list endpoint (`/.well-known/parachute-revocation.json`) picks the change up on its next 60s poll cycle; resource servers running `@openparachute/scope-guard@^0.2.0` then reject the JWT on subsequent requests.

### Out of scope (deferred)

- HTTP analog (`POST /api/auth/revoke-token`) — would mirror `api-mint-token.ts`'s ~80-LOC shape; deferred per the brief's <50 LOC budget for "ergonomically a few extra lines." Filed as a follow-up issue.
- Bulk revoke (`--all-by-subject`, `--all-by-client`).
- Revoke-by-subject convenience wrapper.
- Admin UI revocation surface — Phase 2.

## [0.5.8-rc.3] - 2026-05-10

Foundation work for [hub#212](https://github.com/ParachuteComputer/parachute-hub/issues/212) Phase 4 (RS-side revocation enforcement). Hub itself ships unchanged at the runtime surface — its own `validateAccessToken` already consults the local DB. The change here is in the workspace-vendored `@openparachute/scope-guard` package, which moves to `0.2.0` with revocation-list enforcement folded into `validateHubJwt`. Vault / scribe / parachute-agent will adopt independently in follow-up PRs once Aaron publishes scope-guard 0.2.0 to npm.

### Changed

- **`@openparachute/scope-guard` 0.1.0 → 0.2.0** — adds revocation-list enforcement to `validateHubJwt`, splits new `HubJwtErrorCode` values (`"revoked"`, `"revocation_unavailable"`). See `packages/scope-guard/CHANGELOG.md` for the full surface change.
- The workspace-vendored scope-guard is consumed at runtime only by tests in this repo (hub's own auth paths use the local `validateAccessToken`). Hub tests pass unchanged — zero new failures.

### Out of scope (this PR)

- Vault / scribe / parachute-agent dep bumps + adoption (separate PRs after Aaron publishes scope-guard 0.2.0).
- Admin UI for revocation listing (Phase 2).
- `pvt_*` deprecation (Phase 6).
- `UsedOperatorToken.refreshed` cleanup (Phase 2 followup, hub#216).

## [0.5.8-rc.2] - 2026-05-09

Token registry + mint API + revocation list endpoint — Phase 1 of the hub-as-sole-AS migration tracked in [#212](https://github.com/ParachuteComputer/parachute-hub/issues/212). Five components, all hub-side, additive (no breaking changes to existing surfaces). Closes Phase 1 and absorbs Phase 5 (CLI relocation — the canonical `parachute auth mint-token` already exists per #179, this PR extends it).

### Added

- **Token registry: `tokens` table v6 migration (Component 1).** Generalizes the OAuth-refresh-only `tokens` table into a unified registry across every issued JWT class. Three new columns: `permissions TEXT` (JSON, fine-grained constraints per the auth-architecture research doc §11.3), `created_via TEXT NOT NULL DEFAULT 'oauth_refresh'` (provenance: `oauth_refresh` / `cli_mint` / `operator_mint`), `subject TEXT` (non-user identity for service / operator mints — operator-mint rows store `"operator"` here while leaving `user_id` NULL). The `user_id` column drops its NOT NULL constraint (CLI/operator mints aren't tied to a hub user; OAuth-refresh rows still set it). SQLite has no `ALTER COLUMN` to drop NOT NULL, so the migration uses the recreate-and-rename pattern inside the migration transaction (atomic; nothing references `tokens` so the drop is safe). Existing rows backfill `created_via='oauth_refresh'` automatically via the column default. New indexes: `tokens_revoked` (powers the revocation-list filter), `tokens_subject` (lookup by non-user mint). Existing indexes (`tokens_user`, `tokens_active_refresh`, `tokens_family`) recreated post-rename. Pre-Phase-1 tokens (already issued before this migration) stay valid but unregistered; they expire on their own (15-min access tokens drained within the hour; pre-#213 365d operator tokens cap at their original expiry).
- **`POST /api/auth/mint-token` HTTP endpoint (Component 3).** New file `src/api-mint-token.ts`. Companion to the CLI for automation that doesn't have local CLI access. Auth: `Authorization: Bearer <token>` whose `scope` claim contains `parachute:host:auth` (the new narrow scope from #213). Body shape: `{ scope, audience?, expires_in?, subject?, permissions? }` — same semantics as the CLI's `--scope` / `--aud` / `--expires-in` / `--sub` / `--permissions` flags. Returns `{ jti, token, expires_at, scope, permissions? }`. 401 / 403 / 400 / 405 surfaces match the OAuth error vocabulary. Wired into `hub-server.ts` dispatch. Every mint writes a registry row identical to the CLI path (`created_via='cli_mint'`).
- **`GET /.well-known/parachute-revocation.json` revocation list endpoint (Component 5).** New file `src/api-revocation-list.ts`. Public endpoint (no auth — the list is harmless to expose; opaque jtis only). Returns `{ generated_at, jtis: [...] }` filtered to `revoked_at IS NOT NULL AND expires_at > now`. Already-expired jtis are filtered out (consumers' own `exp` check rejects them anyway; listing is noise). `Cache-Control: public, max-age=60` matches the polling cadence Phase 4 will wire on the resource-server side. Wildcard CORS posture identical to `/.well-known/jwks.json` — resource servers fetch this cross-origin.
- **`recordTokenMint(db, opts)` helper in `src/jwt-sign.ts`.** The non-OAuth-refresh mint path; writes a registry row with the chosen `created_via` and `subject`. Used by `parachute auth mint-token`, the new HTTP endpoint, and the operator-mint paths.
- **`revokeTokenByJti(db, jti, now)` helper in `src/jwt-sign.ts`.** Idempotent revocation: returns `true` when a row was updated (was un-revoked before), `false` when no row matches or the row was already revoked. Powers the future `/admin/tokens` admin UI revoke action (Phase 2) and any other explicit-revoke surface.
- **`listActiveRevocations(db, now)` helper in `src/jwt-sign.ts`.** Returns the snapshot of currently-revoked-and-not-yet-expired jtis. Powers the revocation list endpoint.
- **`tokenRowIdentity(row)` helper in `src/jwt-sign.ts`.** Returns the canonical "who is this token for" string — `userId ?? subject ?? ""`. Collapses the OAuth-vs-non-OAuth distinction for callers that don't care.
- **`TokenCreatedVia` type exported from `src/jwt-sign.ts`** — `"oauth_refresh" | "cli_mint" | "operator_mint"`.

### Changed

- **`parachute auth mint-token` extended (Component 2).** New flags:
  - `--permissions <JSON>` — JSON object encoding fine-grained constraints beyond OAuth scope. Round-trips into the JWT's `permissions` claim. Validated to be a JSON object (not a primitive, not an array); malformed JSON or non-object payloads are rejected with a usage error.
  - `--expires-in <integer-seconds>` — canonical lifetime flag. Matches OAuth's `expires_in` claim semantics (the JWT `exp` is `iat + expires_in`). Integer-seconds only; values like `1d` go through the legacy `--ttl` flag.
  - `--ttl` is now the **deprecated alias**: still works, still accepts the duration-string form (`90d` / `24h` / `30m` / `60s`), but emits a one-line stderr deprecation notice on use (`--ttl is deprecated; use --expires-in <seconds> instead (will be removed in 0.6.0)`). Passing both `--ttl` and `--expires-in` together is a usage error.
  - Help text rewritten with the multi-scope syntax, the `--permissions` example, and the deprecation note.
  - Every successful mint writes a `tokens` registry row (`created_via='cli_mint'`, `subject=<--sub or operator's sub>`, `user_id NULL` per the design — CLI mints aren't user-tied at the row level).
- **Operator-token mints write to the registry (Component 4).** `mintOperatorToken` now calls `recordTokenMint(...)` after signing — `created_via='operator_mint'`, `subject="operator"`, `user_id NULL`. Auto-rotation rows from #213's `useOperatorTokenWithAutoRotate` get registered too. Both the original and the rotated row exist (the original isn't auto-revoked on rotation; it stays valid until its own `exp`). A future "revoke prior on rotation" toggle is a Phase 2 candidate; for now we accept the slightly larger registry for the simpler invariant.
- **`signRefreshToken` explicitly stamps `created_via='oauth_refresh'`.** Previously the column didn't exist; v6's column default would handle pre-existing rows but new inserts go through this path now. Belt-and-suspenders with the migration default.
- **`RefreshTokenRow.userId` is now `string | null`.** Reflects the v6 schema. OAuth callsites (`oauth-handlers.ts:1054`, line 1069 — refresh-token rotation path) add a runtime guard: if `findRefreshToken` returns a row with `userId === null` (shouldn't happen because `findRefreshToken` filters by `refresh_token_hash IS NOT NULL`, and only OAuth-refresh rows have a hash), surface a clean `invalid_grant` rather than letting the type-system lie cascade. Defense-in-depth; the runtime path is unreachable on a correct schema but the guard makes the contract explicit.
- **`SignAccessTokenOpts.extraClaims` now used for the `permissions` claim too.** Previously only `pa_scope_set` rode this seam (#213). The `extraClaims` shape is unchanged; it just has more callers now.

### Migration / impact

- **Operators upgrading from 0.5.7-rc.* or 0.5.7 stable:** the v6 migration runs automatically on next `openHubDb()`. Existing OAuth refresh-token rows are backfilled with `created_via='oauth_refresh'`; their `permissions` and `subject` stay NULL. No data loss, no downtime.
- **Operators with operator.token files from 0.5.7 or earlier:** still valid (the JWT carries its own `exp`, signed by hub's existing keys, validated by `validateAccessToken`). They don't have a registry row, but that's harmless — `validateAccessToken` only consults the registry to check `revoked_at`, and a missing row is treated as not-revoked. The next `parachute auth rotate-operator` (or the auto-rotation from #213) will register the new token.
- **OAuth refresh-token rotation:** unchanged behavior. The new `userId` nullability guard is defense-in-depth; the runtime path is unreachable on correctly-shaped rows.
- **Pre-existing access tokens:** still valid until expiry. The 15-minute default TTL means any pre-Phase-1 access tokens drain within the hour after deploy.

### Out of scope (deferred to later phases of #212)

- **Phase 2: admin UI `/admin/tokens` route** — list / revoke / inspect rows. Daytime work.
- **Phase 4: vault / agent / scribe revocation-list consumers** — fetch `/.well-known/parachute-revocation.json` on a 60s TTL and reject any presented JWT whose `jti` appears. Resource-server side; this PR ships the issuer-side endpoint only.
- **Phase 5: `parachute vault tokens create` → `parachute auth mint-token`** — partially absorbed into this PR (the canonical CLI path already exists; the `vault tokens create` path becomes a removable alias). Final cutover deferred to a Phase 5 cleanup PR.
- **Phase 6: `pvt_*` deprecation in vault** — vault-side; out of scope here.
- **Per-CLI-command scope-set enforcement (Phase 2 of #213)** — separate followup.

### Tests

`bun test ./src`: **1153 pass / 0 fail** (was 1118 / 0 on the 0.5.8-rc.1 tip). 35 new cases:

- `src/__tests__/jwt-sign.test.ts` (+7): v6 schema shape via `PRAGMA table_info(tokens)`, `recordTokenMint` round-trip, duplicate-jti throws `RefreshTokenInsertError`, `revokeTokenByJti` idempotency + flips `revoked_at`, `listActiveRevocations` filters by `revoked_at AND expires_at>now`, `tokenRowIdentity` returns `userId ?? subject`, `signRefreshToken` stamps `created_via='oauth_refresh'`.
- `src/__tests__/auth.test.ts` (+9): every mint writes registry row (`created_via='cli_mint'`), `--permissions` JSON object round-trips into JWT + registry, `--permissions` malformed JSON rejected, `--permissions` non-object (array) rejected, `--expires-in` (canonical) sets JWT TTL, `--expires-in` non-integer rejected, `--expires-in` over 365d cap rejected, `--ttl` deprecation notice on stderr but still works, both `--ttl` and `--expires-in` together rejected.
- `src/__tests__/operator-token.test.ts` (+2): `mintOperatorToken` writes registry row (`created_via='operator_mint'`, `subject='operator'`, `user_id NULL`), auto-rotation writes a fresh row for the rotated token while leaving the original row in place.
- `src/__tests__/api-mint-token.test.ts` (+11, new file): 401 no auth, 401 non-Bearer, 401 invalid bearer, 403 bearer without `parachute:host:auth`, happy path with admin operator token (registry row written, JWT round-trips), happy path with `--scope-set=auth` narrow operator token, `permissions` round-trip, 400 missing scope, 400 expires_in over cap, 400 permissions non-object, 405 non-POST.
- `src/__tests__/api-revocation-list.test.ts` (+6, new file): empty list initially, returns revoked jti, filters out already-expired, OAuth-refresh rows participate (cross-class revocation), 405 non-GET, `revokeTokenByJti` idempotency.

`bunx biome check .`: 171 files, no findings. `bun run typecheck`: clean.

## [0.5.8-rc.1] - 2026-05-09

Operator-token hardening — first slice of the hub-as-sole-AS migration arc tracked in #212. This PR is scoped to #213's three pieces; the broader registry + revocation infrastructure lands in 0.5.8-rc.2 (#212 Phase 1).

### Changed

- **Default operator-token lifetime: 365d → 90d (closes #213, piece A).** `OPERATOR_TOKEN_TTL_SECONDS` drops from `365 * 86400` to `90 * 86400` in `src/operator-token.ts`. Pre-existing operator tokens already on-disk keep their original 365d lifetime (the JWT carries its own `exp`); only freshly-minted tokens (via `parachute auth set-password` / `rotate-operator` / the new auto-rotation path) get the 90d ceiling. The previous 1-year window was too forgiving for a secret whose only revocation channel today is "wait for it to expire" — 90d gives a tighter blast-radius without requiring operators to remember rotation cadence (auto-rotation handles that, see below).
- **Opportunistic auto-rotation on use (closes #213, piece A).** New helper `useOperatorTokenWithAutoRotate(db, { issuer, configDir })` in `src/operator-token.ts` is the canonical "use the operator token in a CLI flow" path. It reads `~/.parachute/operator.token`, validates against the hub's signing keys + issuer, and: (1) if remaining lifetime > 7d, returns the token unchanged; (2) if within 7d of expiry AND the token's `aud` claim is `"operator"` (the privilege-escalation guard — see below), re-mints with the same scope-set + a fresh 90d expiry, writes back to disk, and returns the new token; (3) if jose rejects the JWT (signature mismatch, wrong issuer, or fully expired), the error bubbles for the caller to render. `parachute auth mint-token` is the first consumer; the auto-rotation banner lands on stderr only (pipe purity preserved). An operator who exercises the CLI at least weekly never sees an expiry surprise. New `OPERATOR_TOKEN_AUTO_ROTATE_THRESHOLD_SECONDS = 7 * 86400` constant.
- **Privilege-escalation guard on auto-rotation: only `aud: "operator"` JWTs auto-rotate.** A hand-stashed scope-narrow JWT (e.g. `aud: "scribe"` + `scope: "scribe:transcribe"`) at `~/.parachute/operator.token` must NOT be silently upgraded to a full operator token by the hub. The audience check in `useOperatorTokenWithAutoRotate` is the gate: only legitimate operator tokens (which carry `aud: "operator"`) participate in auto-rotation. The pre-existing `hub:admin` scope check in `runMintToken` stays in place as a second belt — together they preserve the privilege-escalation guard the existing test (`operator token without hub:admin scope is rejected`) pins.
- **`OPERATOR_TOKEN_SCOPES` now includes the new fine-grained host scopes.** The `admin` scope-set is the superset of all narrow sets (per the new vocabulary, see below) — pre-existing 5 scopes (`hub:admin`, `parachute:host:admin`, `vault:admin`, `scribe:admin`, `channel:send`) plus the 5 new fine-grained `parachute:host:install/start/expose/auth/vault` scopes. Resource servers (vault, scribe, channel) ignore unknown scopes; they only check what they care about. The constant is kept exported as `OPERATOR_TOKEN_SCOPES` (alias for `OPERATOR_TOKEN_SCOPE_SETS.admin`) for back-compat with callers that imported it directly.

### Added

- **`parachute auth rotate-operator --scope-set <set>` (closes #213, piece B).** Named scope-sets the operator can mint under, each a narrowing of the broad `parachute:host:admin` blanket. Six sets: `install` (`parachute:host:install` + `vault:read` for new-vault discovery during install), `start` (`parachute:host:start`), `expose` (`parachute:host:expose`), `auth` (`parachute:host:auth`), `vault` (`parachute:host:vault`), `admin` (default — superset of all). The mint default is `admin` for back-compat: `rotate-operator` without flags produces today's full-scope operator token. The scope-set is recorded in the JWT via a new custom claim `pa_scope_set`, so the auto-rotation path can preserve the operator's chosen narrowing across re-mints. Phase 1 of #213 ships the vocabulary + flag; Phase 2 (separate follow-up) will wire per-command enforcement so an `install`-only token can't, say, run `parachute expose public`. Until then, `--scope-set` is a tool the cautious operator can opt into without breaking anyone.
- **Five new operator-only scopes in `scope-explanations.ts` + `NON_REQUESTABLE_SCOPES`.** `parachute:host:install`, `parachute:host:start`, `parachute:host:expose`, `parachute:host:auth`, `parachute:host:vault`. All carry `level: "admin"` (highlighted in the consent UI if anyone tries to render them) and all are in `NON_REQUESTABLE_SCOPES` — the public OAuth flow rejects requests for these with `invalid_scope`, exactly like `parachute:host:admin`. They're operator-only; the only legitimate path to a JWT carrying any of them is local mint via `rotate-operator --scope-set <set>`.
- **`extraClaims?: Record<string, unknown>` on `signAccessToken` opts.** Minimally-invasive seam to embed custom claims on signed JWTs. Used by `mintOperatorToken` to embed `pa_scope_set`. Reserved claims (`scope`, `client_id`, `sub`, `iss`, `iat`, `exp`, `aud`, `jti`) are owned by the function and overwrite any colliding key passed via `extraClaims`.

### Security

- **`writeOperatorTokenFile` now `chmod 0600`s the file post-rename (closes #213, piece C, write side).** Defense-in-depth: `fs.writeFile(tmp, ..., { mode: 0o600 })` honors the create-mode hint when creating a new file, but on some platforms (Linux, macOS) the rename preserves the prior inode's mode if the destination already existed with looser permissions. Forcing `chmod 0o600` on the tmp file before rename ensures the post-write mode is exactly 0600 regardless of any pre-existing destination permissions.
- **`readOperatorTokenFile` warns when the file is group-/world-readable (closes #213, piece C, read side).** New `warnIfWorldReadable` helper stat()s the file post-read and, if any of the 0o077 mode bits are set, prints a one-line stderr warning (`parachute: operator token file at <path> has mode <mode> ...`) plus the remediation hint (`chmod 0600 <path>`). Warning, not error: a hard failure here would lock the operator out of every CLI command with no in-CLI way to recover. The warning is silent when the file is exactly 0600. Stat failures (file vanished between read and stat, platform doesn't expose mode bits) are swallowed — the read already succeeded; this is signal, not a gate.

### Out of scope (deliberately deferred)

- Token registry (per-jti row in hub.db) — that's #212 Phase 1 (lands in 0.5.8-rc.2 alongside the mint API and revocation list endpoint).
- CLI commands gating on the new fine-grained scopes — that's the Phase 2 follow-up to #213. Today the only gate is `hub:admin` (in `mint-token`).
- Server-side auto-rotation for operator tokens presented to hub HTTP endpoints — today the auto-rotation only fires in CLI flows that hold a DB handle (e.g. `parachute auth mint-token`). Server-side rotation requires a header-based "here's your new token" protocol and matching CLI write-back; out of scope for #213.

### Tests

`bun test ./src`: 1118 pass / 0 fail (was 1100 / 0 on the 0.5.7 tip). 18 new cases:

- `src/__tests__/operator-token.test.ts` — 12 new cases: 90d / 7d constants, default scope-set + `pa_scope_set` claim, `--scope-set=start` mints `parachute:host:start` only, `install` set carries `vault:read`, `admin` superset structural assertion, file-permission warning on 0o644 read + no-warning on 0o600, auto-rotate happy path / no-rotate when fresh / no-rotate non-operator-audience JWT (privilege guard) / null when no file / jose rejects fully-expired.
- `src/__tests__/auth.test.ts` — 6 new cases: `rotate-operator --scope-set start` round-trip, `rotate-operator --scope-set admin` (default) emits full set, invalid `--scope-set=wallet` rejected with usage message, unknown flag rejected, `parachute auth mint-token` auto-rotation banner lands on stderr only (pipe purity).

## [0.5.7] - 2026-05-09

Promotes the 0.5.7-rc cycle (rc.1 through rc.6, all landed 2026-05-08) to stable. Three big themes:

1. **Layer-aware proxy + single tailnet ingress (#187, #198, #202).** `tailscale serve` collapses to a single catchall (`https://443/ → http://127.0.0.1:hub`); the hub does layer detection (`loopback` / `tailnet` / `public` from forwarder headers) and gates `publicExposure: "loopback"` services per request. Closes the silent-502 / silent-404 class on trailing-slash mounts and `FIRST_PARTY_FALLBACKS` `stripPrefix` derivation, plus `notes-serve` resolution from bun's global dirs and post-spawn liveness check on `parachute start`.
2. **OAuth DCR friction-reduction (#200, #209).** Same-origin DCR auto-approves when a valid session cookie + matching `Origin`/`Referer` is present; cross-origin SPAs land on a pending-client page with an inline "Approve and continue" button (operator session + CSRF + Origin gates). Closes the cross-origin SPA recovery gap that previously required dropping to `parachute auth approve-client <id>` in a terminal.
3. **Port-collision class closed across read + write + install (#204, #207, #210).** `validateManifest` rejects duplicate ports on read; `upsertService` rejects duplicate-port writes (defense-in-depth for the boot-overwrite root causes fixed upstream in scribe#41 / agent#146); `parachute status` warns inline on canonical-port drift; `parachute install` no longer writes `PORT=` to service `.env` files because `services.json` is authoritative per the 4-tier `resolvePort` ladder (scribe#41 / agent#146 / agent#148 / patterns#45).

Plus #188 (rate-limit floor on `POST /admin/login`), #191 (warn when 2FA not enrolled before public exposure), and #193 (housekeeping: refreshed stale comment, canonical test invocation in CLAUDE.md, biome fix-up).

### Added

- **`assignServicePort` rewritten — services.json is authoritative; no more `.env` PORT writes (closes #206 — #210).** Pre-#210 the install path read the service's `.env`, preserved any pre-existing PORT (`source: "preserved"`), and otherwise wrote `PORT=<assigned>` into the file via `parseEnvFile` / `upsertEnvLine` / `writeEnvFile`. Post-#210 the function is a thin wrapper over `assignPort`: it picks a port (canonical → unassigned reservation → past-range with warning) and returns `{ port, source, warning? }`. The `.env` is not read, not created, not mutated. Operators who edit `services.json` to fix a duplicate-port collision (after the read-time #204 / write-time #207 gates flag one) no longer get re-stamped by a stale `.env` PORT on the next `parachute install`. The `installDir`-stamping, services.json seed/update, and auto-wire / scribe-provider code paths in `commands/install.ts` are unchanged. Picked option A from the hub#206 design conversation; alternatives B (warn on disagreement, keep `.env` precedence) and C (interactive reconcile) added behavioral surface for what's now a pure-historical concern. Tests: `port-assign.test.ts` `assignServicePort (hub#206 — services.json is authoritative)` describe block (4 cases) + 3 inverted cases in `install.test.ts`. Pre-#210 `.env` round-trip cases are intentionally gone.
- **`POST /oauth/authorize/approve` — operator-driven inline DCR client approval (closes #208 — #209).** New endpoint in `oauth-handlers.ts:handleApproveClientPost`, wired into `hub-server.ts` dispatch. Three-belt security model: (1) valid CSRF token (double-submit cookie, same `__csrf` shape as `/admin/login` and the existing `/oauth/authorize` POST), (2) active operator session via `findActiveSession(db, req)`, (3) `Origin`/`Referer` matches issuer via the `originMatchesIssuer` helper introduced in #200. All three must pass — the form never renders without a session, so a hand-crafted POST without a valid session-bound CSRF token can't slip through. Form embeds the original `/oauth/authorize?...` URL as `return_to`; `return_to` is validated to be a hub-relative path starting with `/oauth/authorize?` (open-redirect defense). Failure modes: 403 invalid CSRF / cross-origin Origin, 401 no session, 404 unknown client_id, 400 bad return_to. Companion `oauth-ui.ts:renderApprovePending` page shows `client_name`, `client_id`, `redirect_uris`, requested scopes — operator can verify before clicking. CLI-fallback hint stays visible in both branches. Tests: 13 cases in `oauth-handlers.test.ts` (`describe("inline approve button on pending /oauth/authorize (#208)")`) including end-to-end three-step round-trip.
- **`upsertService` rejects writes that would land a duplicate port in `services.json` (closes #205 — #207).** New `assertNoDuplicatePorts(entries, where)` helper extracted out of `validateManifest` so both read and write paths apply the same gate. After the in-memory upsert merge but before `writeManifest`, the helper runs across `current.services`; if two distinct services would share a port the call throws `ServicesManifestError` with the same message shape as the read path. The previous shape would write the corrupt manifest, leave bad state on disk, and only surface the fault on the next `readManifest`. Same multi-vault carve-out as the read side. Tests: `services-manifest.test.ts` `upsertService duplicate-port rejection (hub#205)` describe block (5 cases).
- **`services-manifest.ts:validateManifest` rejects manifests with duplicate ports across distinct services (closes #195 — validation part — #204).** New per-port pass at the end of `validateManifest`: if two entries share a port, throw `ServicesManifestError` with a message of the shape `<manifestPath>: duplicate port 1944 — claimed by both "parachute-scribe" and "parachute-agent". Edit services.json to give each service a unique port.`. The previous shape silently accepted a `services.json` like `[{name: "parachute-scribe", port: 1944}, {name: "parachute-agent", port: 1944}]` — both rows landed, the OS let one process bind, and the hub reverse-proxy quietly routed everyone to whoever won the race. That's exactly how 2026-05-08's `/agent → scribe` miswire happened. The underlying boot-overwrite bugs are fixed in parachute-scribe#41 and parachute-agent#146; this is the hub-side gate so the same class can't recur silently. Multi-vault is the deliberate exception — the gate fires only when at least one of the conflicting names isn't a `parachute-vault*` row.
- **`parachute status` warns inline when a known service is at a non-canonical port (closes #195 — drift-warning part — #204).** New continuation line `  ! canonical port is <N>` printed beneath any first-party service whose actual `services.json` port differs from `FIRST_PARTY_FALLBACKS[<short>].manifest.port`. Operator-visible signal that an upgrade or boot rewrote a port off canonical, even when the duplicate-port gate hasn't tripped yet. Warning, not error: exit code stays 0. Drift fires for stopped services too. New `canonicalPortForManifest(manifestName)` helper in `src/service-spec.ts`. Tests: `services-manifest.test.ts` `duplicate port rejection` describe block (5 cases) + `status.test.ts` `canonical-port drift warning` describe block (6 cases).
- **`/oauth/register` auto-approves when a valid session cookie + matching Origin/Referer is present (closes #199 — #200).** Companion path to the operator-bearer (`hub:admin`) auto-approve introduced in #74. Surfaced 2026-05-08 when Aaron tried to link Notes to a vault and hit "App not yet approved" on `POST /oauth/authorize` — every fresh `client_id` from a browser SPA needed a terminal drop-out. Two gates: (1) `findActiveSession(db, req)` — un-expired session row keyed by the `parachute_hub_session` cookie, (2) `originMatchesIssuer(req, issuer)` — `URL.origin` exact match (scheme + host + port) against the request's `Origin` (or `Referer` as fallback). Belt-and-suspenders CSRF defense alongside the cookie's `SameSite=Lax` attribute. SPA-side companion work: parachute-agent#140 + parachute-notes#106. New `findActiveSession(db, req, now?)` exported from `src/sessions.ts` (refactored out of `admin-handlers.ts`). Tests: 10 regression cases in `oauth-handlers.test.ts` `DCR auto-approve via session cookie (#199)`.
- **Per-IP rate-limit on `POST /admin/login` (5 attempts / 15-minute sliding window) (closes #185 — #188).** Lands as a brute-force floor under `/admin/login`, which became reachable from every layer (loopback / tailnet / public) when 0.5.3-rc.1 collapsed the access-control matrix into the hub. On a cloudflare-fronted hub, that means the open internet — until #186 / #191 ships 2FA-on-login, this is the only thing slowing credential grinding. New module `src/rate-limit.ts` keeps a sliding-window timestamp list per IP and is wired into `handleAdminLoginPost` *after* CSRF (so cross-site junk doesn't burn slots) but *before* credential check (so 401s, missing-user, and eventually 2FA failures all count toward the same bucket). Exhaustion returns `429 Too Many Requests` with a `Retry-After` header. New `clientIpFromRequest` IP-extraction helper: priority order is `CF-Connecting-IP` → `X-Forwarded-For` first hop → `UNKNOWN_IP_SENTINEL`. Storage: in-memory `Map<ip, timestamps[]>` for the lifetime of the hub process. New `AdminLoginDeps` test seam injects `now` for time-deterministic tests.
- **`parachute expose public` warns when 2FA is not enrolled (closes #186 — #191).** Lands as the next layer of defense after #188's `/admin/login` rate-limit floor. Both bringup paths (`expose-cloudflare.ts` and the public branch of `expose.ts`) now check `readVaultAuthStatus().hasTotp` after the tunnel is up but before returning, and print a contextual warning + the one-line `parachute auth 2fa enroll` remediation when 2FA is absent. Warning-only by design — hard-gating would surprise operators mid-flow. Tailnet exposure is moot (tailscale-authed at the proxy) so the warning is public-layer only. New `is2FAEnrolled()` + `printPublic2FAWarning()` helper module (`src/commands/expose-2fa-warning.ts`). New `vaultHome` and `vaultAuthStatus` test seams on `ExposeCloudflareOpts` and `ExposeOpts` — production callers omit; tests inject either a tmp `vaultHome` or a pre-computed `VaultAuthStatus`.

### Fixed

- **`notes-serve.ts` resolves `@openparachute/notes` from bun's global install dirs in addition to `process.cwd()` (closes #194 — resolution part — #202).** New helper `resolveNotesDistFrom({ cwd, home, resolveSync, existsSync })` walks three candidate bases in order: (1) `process.cwd()`, (2) `~/.bun/install/global/node_modules`, (3) `~/.bun/install/global`. The cwd-only version (pre-#202) was the bug: hub itself doesn't depend on `@openparachute/notes`, so when `parachute start notes` is run from the hub repo dir, the cwd-relative resolve walks ancestral node_modules and finds nothing. Bun does NOT auto-consult the global install dir, so bun-linked installs failed silently. Failure path now reports every candidate that was tried plus an actionable hint (`bun add -g @openparachute/notes` / `parachute install notes`). Tactical operator workaround Aaron had at `~/.parachute/services.json` (notes entry with `installDir`) becomes unnecessary post-merge but is safe to leave.
- **`parachute start <svc>` no longer reports success when the spawned process dies before settling (closes #194 — start-success part — #202).** New `LifecycleOpts.startSettleMs` (default 250ms in production) defines a post-spawn window: after `r.spawner.spawn(cmd, ...)` returns a pid, we sleep `startSettleMs` then re-check `r.alive(pid)`. If the process is dead by then, we clear the pidfile, log `✗ <svc> failed to start: spawned pid X but the process exited within Yms` plus `Tail the log for details: tail -50 <logFile>`, and return non-zero. The previous shape reported `✓ <svc> started (pid X)` based solely on the spawn returning a pid — leaving the operator chasing a phantom 502 with no signal that the daemon was already gone. Slow-startup services that take >250ms to fail still surface eventually via `parachute status` / log inspection. Tests: 5 cases in `notes-serve.test.ts` for resolve order, 3 cases in `lifecycle.test.ts` for the post-spawn settle-poll.
- **Trailing-slash mount paths now match sub-paths in `findServiceUpstream` / `findVaultUpstream` (closes #197 — #198).** A services.json entry written with `paths: ["/notes/"]` (trailing slash) used to match only the exact pathname `/notes/` and never any sub-path, because `pathname.startsWith("/notes//")` is always false (URLs don't have double slashes). Operator-visible symptom on Aaron's box: notes blank screen — the SPA shell loaded at `/notes/` but every `/notes/assets/*.js` request 404'd from hub. Fix: normalize trailing slashes (`path.replace(/\/+$/, "") || "/"`) before the equality + prefix check, in both matchers. The `|| "/"` branch keeps a bare-root mount `"/"` stable rather than collapsing to the empty string.
- **`proxyToService` / `proxyToVault` honor `stripPrefix` from `FIRST_PARTY_FALLBACKS` when the on-disk entry omits it (closes #196 — #198).** Scribe v0.4.0 doesn't write `stripPrefix: true` to its services.json entry — the declaration only lives in hub's `SCRIBE_FALLBACK.manifest.stripPrefix` (`src/service-spec.ts`). Pre-#198 routing went through hub which wasn't consulting the fallback registry. Result: `/scribe/health` got forwarded verbatim to scribe, scribe served bare paths and 404'd. Fix: new `stripPrefixFor(entry)` helper consulted by both proxies — explicit on-entry wins, otherwise consult `FIRST_PARTY_FALLBACKS` keyed by short name, default `false` (preserving existing keep-prefix default for unknown / third-party services). Scribe-side companion is parachute-scribe#40. Tests: trailing-slash regression coverage + 3-rung precedence tests for FIRST_PARTY_FALLBACKS stripPrefix derivation in `hub-server.test.ts`.

### Changed

- **Hub-side request-layer detection (`layerOf`) — every request reaching `127.0.0.1:1939` is classified into `loopback` / `tailnet` / `public` (#187).** Inspects the proxy headers each trusted forwarder injects: `Tailscale-User-Login` (tailnet, authed via `tailscale serve`), `Tailscale-Funnel-Request: ?1` (public, Tailscale Funnel — verified against `serve.go addTailscaleIdentityHeaders`), `CF-Ray` / `CF-Connecting-IP` (public, cloudflared tunnel), or none of the above (loopback). Spoofing isn't a concern: hub binds 127.0.0.1, so external requests can't reach the listener except via these forwarders. Drives `publicExposure: "loopback"` enforcement on `/<svc>/*` and `/vault/<name>/*` dispatch — `proxyToService` and `proxyToVault` now consult `effectivePublicExposure(entry)` and 404 when the layer mismatches. Hub-owned routes (`/`, `/admin/*`, `/api/*`, `/hub/*`, `/oauth/*`, `/.well-known/*`, `/vault/*` SPA mount, `POST /vaults`) are NOT layer-blocked — they reach all layers and rely on app-level auth. (Reviewer fold: `layerOf` matches `Tailscale-Funnel-Request: ?1` by structured-header value, not presence; `warnLegacyRoot` typed as `void` with the unused binding dropped.)
- **`parachute expose tailnet up` / `parachute expose public` collapse to a single tailscale rule (#187).** Pre-collapse the planner emitted one mount per service: hub root, well-known, four OAuth proxies, `/vault/`, plus one per non-vault service — eight mounts for a baseline vault+notes install. New shape: `tailscale serve --bg --https=443 --set-path=/ http://127.0.0.1:<hubPort>/` and the hub does all internal dispatch. `parachute expose public` (Tailscale Funnel) emits the symmetric single rule. Closes the symmetry gap with the cloudflare side that shipped in #178 on 0.5.2; the access-control matrix now lives uniformly in the hub regardless of which forwarder admitted the request. `partitionByExposure` removed from the tailnet plan layer. Legacy `paths: ["/"]` entries warn but no longer get rewritten in-memory.
- **Refresh stale comment on `effectivePublicExposure` in `src/service-spec.ts` (closes #189 — #193).** The pre-#187 comment said `auth-required` services were "treated as loopback at launch." Post-#187 (layer-aware proxy + collapse tailnet to single catchall) `auth-required` reaches all layers and the service self-gates — the loopback-block is the dedicated `loopback` value's job. Comment now spells out the matrix (allowed → all layers, service self-gates; loopback → hub layer-gates; auth-required → all layers, service self-gates, field documents intent). Code unchanged.
- **Canonicalize test-count invocation in `CLAUDE.md` (closes #190 — #193).** New "Test gate counts in commit messages and PR descriptions" subsection under "Running" pins `bun test ./src` (the `package.json` `"test"` script, what CI runs) as the source of gate counts quoted in commit messages and PR descriptions, and calls out that `bun test src/__tests__/` pulls in `packages/scope-guard/` tests and reports an inflated count.
- **`bunx biome check src/commands/expose-public-auto.ts --write` fix-up (closes #192 — #193).** Pure formatting + import-order fixes (organizeImports + format). No semantic change. Rest of the repo passes `bunx biome check .` clean.

### Doc

- **`port-assign.ts` / `service-spec.ts` / `help.ts` doc comments rewritten (#210).** Pre-#210 wording ("CLI is the port authority… writes `PORT=<port>` into `~/.parachute/<svc>/.env`… idempotent, an existing PORT in .env wins") was load-bearing for the old behavior; the new wording explains that `services.json` is the single source of truth at boot per the 4-tier ladder, that operator override is now "edit services.json" (or `parachute config` once that lands), and that pre-#210 stale `.env` PORT lines on existing operator machines are harmless and untouched.

### Migration / impact

- **Operators with `parachute expose tailnet` already up (#187):** re-run after upgrading. The teardown-then-bringup sweep in `exposeUp` handles old multi-mount state correctly via the recorded `entries[]` in `expose-state.json`.
- **Operators with `publicExposure: "loopback"` services (#187):** materially equivalent (those routes were unreachable from tailnet/public before because the plan withheld them; now they're 404 because the hub gate fires).
- **Operators with `auth-required` services that lacked an actual auth gate (#187):** were withheld pre-collapse, now reach all layers and rely on the service to gate. Verify your service is actually auth-gating before relying on this.
- **Operators with stale `PORT=` lines in `~/.parachute/<svc>/.env` (#210):** ignored by services that follow the documented 4-tier ladder (scribe ≥ #41, agent ≥ #146 / #148, future modules per parachute-patterns#45). They can be left alone or trimmed by hand. Future `parachute install` runs will not re-add or rewrite them.

## [0.5.2] - 2026-05-06

### Added

- **Hub-as-unified-proxy: services.json-driven `/<svc>/*` dispatch on `:1939`.** Until now the hub only proxied `/vault/<name>/*` paths into a backend port; every other module (scribe, notes, agent) had to be reached through tailscale's per-mount routing or through the module's own listener. The hub now does a single dispatch step after every specific handler runs (`/`, `/admin/*`, `/oauth/*`, `/.well-known/*`, `/hub/*`, `/vault/*`, `/api/*`): longest-prefix lookup against every non-vault `services.json` row, forward to `127.0.0.1:<port>`. Reads `services.json` per-request so a `parachute install <svc>` made seconds ago is reachable without a hub restart — same dynamism as the well-known doc and `/vault/<name>/*` proxy. Hub becomes the unified portal; agent containers and external clients use one URL. Subsumes most of hub#178; future PRs can simplify tailscale serve / cloudflare expose configs to a single ingress (everything → `hub:1939`). Vault routing (`/vault/*`) is unchanged and still owns the SPA-fallback seam from #173. (#182, #183)
- **`stripPrefix?: boolean` on `ServiceEntry` (services.json) and `ModuleManifest` (`.parachute/module.json`).** Per-service path-rewrite hint for the hub's `/<svc>/*` proxy. Default `false` (or absent) preserves the matched mount prefix when forwarding — matches what notes / agent / vault expect (each strips internally or routes by the prefix). When `true`, the hub strips the prefix before forwarding so the backend sees a bare path: `hub:1939/scribe/v1/audio/transcriptions` reaches scribe as `/v1/audio/transcriptions`. Carried through `seedEntryFromManifest` so a third-party module can declare its preference once in its own `module.json`. **SCRIBE_FALLBACK ships `stripPrefix: true`** because parachute-scribe's HTTP routes are bare today; eventually scribe should accept its own `--mount` flag and join the prefix-aware convention (tracked in parachute-scribe#39), at which point this field can be set to `false` (or removed) for the scribe entry. Why a field rather than uniform behavior: the conventions differ per module — assuming uniformity 404s every scribe request at the backend. (#182, #183)

### Changed

- **Hub's path-routing extracted to shared helpers.** Loopback-fetch + 502-on-unreachable shape lifted out of `proxyToVault` into `proxyRequest(req, port, serviceLabel, targetPath?)`; `findServiceUpstream` exported for downstream use. `proxyRequest` accepts an optional `targetPath` argument so callers that want to rewrite the forwarded path (e.g. `proxyToService` when `stripPrefix` is set) pass a string; callers preserving the path (e.g. `proxyToVault`, default `proxyToService`) omit it. The comment on `proxyRequest` now explicitly notes the non-equivalence with the tailscale strip convention — `tailscale serve <mount>=<target>` strips the mount before forwarding (which is why `serviceProxyTarget` in `commands/expose.ts` makes mount and target byte-equal); the hub does no stripping unless told to. Vault routing unchanged. (#182, #183)

### Migration / impact

- Operators with services.json entries lacking `stripPrefix`: continue to work, default `false` (existing prefix-aware behavior).
- Fresh installs of scribe via `SCRIBE_FALLBACK`: get `stripPrefix: true` automatically — `hub:1939/scribe/*` now correctly routes to scribe.
- Tailscale serve / cloudflare expose configs unchanged today; can be simplified to a single ingress in a future PR.
- paraclaw#143's scribe skill works after this release.

## [0.5.1] - 2026-05-06

### Added

- **`parachute auth mint-token --scope <scope> [--aud <aud>] [--ttl <duration>] [--sub <sub>]`** — issues a single scope-narrow JWT against the operator's identity, signed with the same key as OAuth-issued tokens. Stdout-pipeable (`parachute auth mint-token --scope scribe:transcribe | pbcopy`); errors to stderr. Audience defaults via the same inference rule the OAuth flow uses (named `vault:<name>:<verb>` → `vault.<name>`, otherwise the first colon-prefixed scope's namespace, fallback `hub`). TTL defaults to 90d, caps at 365d. Operator-bearer required: the presented `~/.parachute/operator.token` must carry `hub:admin` scope. Targets the agent-secret-injection flow (scribe-as-skill) and other on-box callers that want a tight bearer without running the OAuth dance. (#179, #180)

### Changed

- **`inferAudience` hoisted to `src/jwt-audience.ts`** — shared between `/oauth/token` issuance and `parachute auth mint-token`, eliminating the drift class where CLI mints and OAuth mints could diverge on audience semantics (a divergence here means tokens minted via CLI fail audience strict-check at the resource server even though scopes match). (#180)

### Fixed

- **`parachute restart|stop|logs <svc>` against installDir-less third-party rows.** A services.json entry whose name isn't a first-party short and whose row was written before the `installDir` contract (PR #84) used to hit the generic `unknown service "<svc>"` path — misleading, since the row exists; just with a stale shape. `lifecycle.resolveTargets` now returns the entry with `spec: undefined` for that case so `stop`/`logs` work via pidfile/logfile semantics keyed by short name. `start` still has to fail (no startCmd to invoke), but with an actionable message: *"services.json entry has no installDir, so the start command can't be resolved. Re-run `parachute install <path-to-X>` to refresh its registration, or upgrade the module to a version that self-registers with installDir."* The genuinely-unknown path (no first-party fallback AND no row in services.json) still surfaces `unknown service`. This is a third-party graceful-degradation fix, **not** a promotion-to-first-party — the committed-core line (vault/notes/scribe/hub) drawn 2026-04-25 is unchanged, and the FIRST_PARTY_FALLBACKS constant (renamed from SERVICE_SPECS in #70) stays a fallback for the four pre-manifest first-party packages, not a registry to grow. Compatible with the third-party-via-installDir path added in #84. (#177)

## 0.5.0 — 2026-05-05

First clean stable promotion to `@latest` since the package was renamed from `@openparachute/cli` in 0.3.0. The previous `@latest` (`0.3.0-rc.1`) was an RC promoted to `@latest` in the early pre-launch rush — that violated the "RC versioning before `@latest`" rule from governance. **This release corrects the governance posture by promoting a non-RC stable to `@latest`.**

### Added

- **Vault-management SPA** at `/vault` (`web/ui/`, Vite + React + TypeScript). Phase 1 ships list + create with single-emit `pvt_*` token banner. Mount-aware `basename` swaps route sets between `/vault/*` (vault list / new / detail) and `/hub/*` (cross-vault permissions). (#157, #161, #163, #173)
- **Per-vault grants admin UI** at `/hub/permissions` — operator-controlled view of which client/scope grants are recorded in the hub's grants table, with revoke. (#162, #165)
- **Native OAuth issuance** at `/oauth/authorize`, `/oauth/token`, `/oauth/revoke` with refresh-token rotation, RFC 7009 revocation, scope-validation, branded consent UI, declared-scope advertising in AS metadata, refresh-rotation hardening, and skip-consent-when-already-granted shortcut. (#66, #69, #70, #76, #79, #82, #99, #101, #104, #106, #107, #108, #115, #118, #119, #120, #150)
- **`parachute:host:admin` scope** for the unified `parachute setup` walk-through, locked behind a session-cookie path so the public OAuth flow can't request it. (#95, #96, #98, #110, #112)
- **Create-vault flow + OAuth scope picker** during the host-setup walkthrough. (#95)
- **Config portal** rendering each module's `configSchema` as a form, with a writeable surface back to the running module. (#114)
- **`parachute upgrade <service>`** for both bun-linked dev installs and npm-installed services. (#117)
- **Dynamic `/.well-known/parachute.json`** built from `services.json` on every request, with plural-array shape for every kind (vaults, notes, agent, etc.). (#105, #135, #138, #142)
- **Dynamic `/vault/<name>/*` proxy routing** so newly-created vaults are reachable on tailnet immediately, without `parachute expose` re-runs. (#144, #145)
- **Native Cloudflare Tunnel** support for `parachute expose public`, with `--tunnel-name` flag for stable public URLs. (#29, #32, #151, #153)
- **`@openparachute/scope-guard`** sub-package: hub-issued JWT validation library shared between vault, scribe, and (soon) parachute-agent. JWKS-backed verify, audience strict-check, generic `<resource>:<verb>` / `<resource>:<name>:<verb>` scope matcher with `admin ⊇ write ⊇ read` inheritance, single `HubJwtError.code` taxonomy. Independent RC cadence from the hub. (#121, #152)
- **Vault-admin-token mint** at `/admin/vault-admin-token` returning a per-vault-audience JWT (`aud: vault.<name>`); SPA auto-mints + refreshes on 401. (#173)
- **`RESERVED_VAULT_NAMES`** extension to block `new` and `assets` from being used as a vault short-name (would shadow `/vault/new` SPA route or `/vault/assets/*` Vite asset pattern). (#173)
- **Home page tile-per-module-type** collapse — `/` renders a single tile per module rather than per-instance, with deep links into each module's surface. (#170)
- **Third-party modules via `installDir` + `module.json`** so non-first-party modules (currently parachute-agent, formerly paraclaw) can install through `parachute install <local-path>` and participate in the hub's scope/manifest registry. (#83, #84, #90)
- **services.json `claw` → `agent` migration** at read-time. Legacy entries with `name: "claw"` and `paths[0] === "/claw"` are silently rewritten to `name: "agent"` with `paths: ["/agent"]` (and any `/claw/*` paths/health rerouted in lockstep). Idempotent, narrow trigger. (#174)

### Changed

- **`@openparachute/cli` → `@openparachute/hub`** (rename completed in 0.3.0-rc.1). The bin name `parachute` is unchanged. The "CLI" framing was always partial — the package now bundles the daemon (`:1939` discovery, OAuth issuance, vault management SPA), and `parachute` is one of its surfaces.
- **`/hub/vaults` → `/vault`** for module-pattern symmetry. The SPA now mounts at the same shape every other module uses (`/<short-name>/*`). Old `/hub/vaults*` URLs 301-redirect. (#173)
- **`SERVICE_SPECS` → `FIRST_PARTY_FALLBACKS`** semantic shift — the constant is now a fallback for first-party packages (vault, notes, scribe, channel) rather than a gating list. Modules install through `<installDir>/.parachute/module.json` first; the fallback only kicks in for the four packages that pre-date the manifest convention. (#70)
- **Homepage `MODULE_ORDER` + `MODULE_LABELS`** rename `claw` / `Claw` → `agent` / `Agent` to match the renamed daemon. (#174)
- **Detached lifecycle process group**: `parachute start|stop|restart` now SIGTERMs the whole process group, so wrapped start commands (`pnpm exec`, `tsx`, etc.) actually restart instead of orphaning. (#88, #93)
- **`parachute start|stop|restart|logs hub`** now manages the hub itself the same way it manages every other module — no more separate command surface. (#166, #167)
- **`bun link` detection in `parachute install`**: the bun global node_modules tree is checked for an existing symlink before `bun add -g` runs, so locally-developed services don't 404 against npm. (#89, #94)
- **`scope-registry`** uses `installDir` from `services.json` to locate `module.json`, fixing third-party module scope reads. (#90)
- **`parachute install`** uses `manifest.name` (not `manifestName`) as the `services.json` key, log line, and auto-start short-name — fixes the divergence regression where modules whose npm package name differed from their short name (e.g. paraclaw shipping `name: "claw"` + `manifestName: "paraclaw"`) installed under the wrong key. (#85, #86)

### Fixed

- `vault-admin-token` audience mismatch — hub minted with broad `aud: vault` while resource servers strict-checked `aud: vault.<name>`. Now mints with the per-vault audience the resource server expects. (#173)
- `iss` claim is now set on every hub-issued JWT. (#77, #79)
- `client_secret` is now enforced on `/oauth/token` for confidential clients. (#101)
- `recordGrant` is now transaction-wrapped, with audit logging on the skip-consent shortcut. (#119, #120, #150)
- `/.well-known/parachute.json` emits one `vaults` entry per path for multi-path vault services. (#142)
- "Manual hub" detection bug + vault-name unification regression. (#143, #148, #149)

### Deprecated

- **Legacy `~/.parachute/services.json` shape** with `name: "claw"` + `paths: ["/claw"]` rows is auto-migrated to `name: "agent"` + `paths: ["/agent"]` on read. The migration is idempotent and silent; no operator action required beyond reinstalling parachute-agent (formerly paraclaw) from npm.

### Retired

- `src/deploy/` was moved to the separate `parachute-cloud` repo. The hub no longer contains the `parachute deploy` provider integration. (#146, #147)

### Security

- Refresh-token rotation now invalidates the prior token on use; rotation hardening covered the pre-launch surface. (#106, #107, #108, #115)
- Operator-approval gate added to Dynamic Client Registration so unauthenticated DCR can't silently mint clients. (#104)

### Governance

- This release corrects the pre-launch RC-on-`@latest` posture by promoting a non-RC stable. Future RC versions will land on the `rc` dist-tag (`npm publish --tag rc`); promotion to `@latest` is a deliberate `npm dist-tag add` step.

## 0.3.0 — 2026-04-26

- **Renamed `@openparachute/cli` → `@openparachute/hub`** to reflect that the package is no longer just a CLI. The `parachute` binary is one surface; the long-running daemon (discovery on `:1939`, OAuth issuance, vault SPA) is another. (#60, #61, #62)
- See [release notes for 0.3.0](https://github.com/ParachuteComputer/parachute-hub/releases/tag/v0.3.0) for the full pre-rename changelog.
