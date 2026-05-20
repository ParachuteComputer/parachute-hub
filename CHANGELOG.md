# Changelog

All notable changes to `@openparachute/hub` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) loosely; versions follow [SemVer](https://semver.org/) with the pre-1.0 RC governance described in [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md).

## [0.5.10-rc.15] - 2026-05-20

Multi-user Phase 1 — PR 4 of 5: OAuth vault_scope claim + consent-picker lock (hub#252, design [`parachute.computer/design/2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/)). Builds on PR 3 (rc.14) which shipped the force-change-password flow. This release wires the *OAuth issuer* side: hub-minted tokens now carry a `vault_scope` claim derived from the user's `assigned_vault`, the consent picker is locked-and-displayed for non-admin users, and the server-side defense refuses mints whose picked vault disagrees with the user's assignment.

Backend surface:

- `src/jwt-sign.ts` — `SignAccessTokenOpts` gains an optional `vaultScope: string[]` field. Every minted JWT carries a `vault_scope` claim (defaults to `[]` when omitted — admins / unpinned mints; non-empty single-element list for assigned users). The claim is load-bearing for PR 5's scope-guard at vault / notes / scribe, which will consume it to enforce per-user vault narrowing downstream. Empty `[]` is the explicit "no per-user restriction" sentinel (rather than absent) so consumers never have to distinguish absent-vs-empty.
- `src/oauth-handlers.ts`:
  - **New `vaultScopeForUser(db, userId)` helper** — derives the claim value from `users.assigned_vault`. Null assignment (admin posture) → `[]`. Non-null → `[name]`. Read at JWT mint time on both the auth-code grant + refresh-token grant paths, so an admin-side `assigned_vault` change picks up on the user's next refresh.
  - **`handleAuthorizeGet`** — looks up the signed-in user and threads their `assigned_vault` into `consentProps` as `lockedVault`. The consent picker renders the assigned-vault name as a read-only label with an "Assigned vault — admin-managed; you can't change this here" note, plus a hidden `vault_pick` input carrying the locked value. Admin users (assigned_vault null) keep the existing free dropdown unchanged.
  - **`handleConsentSubmit`** — server-side defense per Aaron's pin "refuses mints whose picked vault disagrees with assigned_vault" rather than silent overwrite. Two checks for non-admin users: (1) when an unnamed `vault:<verb>` scope was disambiguated via `vault_pick`, refuse 400 if the picked vault ≠ `assigned_vault`; (2) when a named `vault:<other>:<verb>` arrived directly in the request scope, refuse 400. Wire error body is HTML with title "Vault assignment mismatch" and the description `vault_scope_mismatch: …` followed by the assigned-vault name. Admins (assigned_vault null) bypass both checks.
  - **`signAccessToken` call sites** — both the auth-code grant (`handleTokenAuthorizationCode`) and refresh grant (`handleTokenRefresh`) now pass `vaultScope: vaultScopeForUser(db, userId)`. Re-derived at every mint (not snapshotted onto the refresh-token row) so admin-side `assigned_vault` changes take effect on the user's next refresh.
- `src/vault-names.ts` (new) — consolidates the two pre-PR-4 private copies of the "walk services.json, emit vault instance names" helper. `oauth-handlers.ts` and `api-users.ts` both used to carry a private `listVaultNames` reading the same source; PR 4 lifts them into one place + adds `handleConsentSubmit`'s server-side defense as a third caller. Exports `listVaultNames(manifest)` for the in-memory shape (consent picker, server-side defense) and `listVaultNamesFromPath(manifestPath)` for the reads-from-disk shape (`/api/users/vaults` + `POST /api/users` validation).
- `src/oauth-ui.ts` — `VaultPicker` interface gains optional `lockedVault: string`. New `renderVaultPicker` branch renders the locked-vault row + admin-managed note + hidden `vault_pick` input when set; CSS styles for `.vault-picker-locked` / `.vault-locked-row` / `.vault-locked-badge` / `.vault-locked-note` follow the existing chrome palette. The "approve disabled" gate is now scoped to the empty-and-not-locked case so locked-vault forms keep their Approve button enabled.
- `src/admin-host-admin-token.ts`, `src/admin-vault-admin-token.ts`, `src/api-mint-token.ts`, `src/operator-token.ts` — every other `signAccessToken` caller updated to pass `vaultScope` explicitly. Host-admin / api-mint / operator → `[]` (no per-user pin; these are operator-driven paths). Vault-admin-token → `[vaultName]` (mirrors the per-vault scope already in the token).
- `src/api-users.ts` — switched off the local `listVaultNames` and now imports `listVaultNamesFromPath` from the shared module. No behavior change.

Tests + gates:

- `src/__tests__/jwt-sign.test.ts` — 3 new tests covering `vault_scope=[]`, `vault_scope=["bob"]`, and the back-compat default (omitting `vaultScope` still emits `[]`).
- `src/__tests__/oauth-handlers.test.ts` — 7 new tests covering: admin user sees the free dropdown; non-admin user sees the locked picker with the admin-managed note; non-admin happy path mints with `vault_scope=["default"]` and narrowed scope; admin path mints with `vault_scope=[]`; disagreeing `vault_pick` returns 400 `vault_scope_mismatch`; disagreeing named scope (e.g. `vault:other:read` for a user assigned to `default`) returns 400 `vault_scope_mismatch`; named scope matching the assigned vault passes happy path; refresh flow re-derives `vault_scope` from current `assigned_vault`.
- `src/__tests__/vault-names.test.ts` (new) — 9 tests for the shared helper: empty manifest, single-entry-multi-path shape, per-vault-entry shape, manifest-suffix fallback for missing paths, dedup across mixed shapes, sorted output (deterministic order), `listVaultNamesFromPath` reads disk, and a cross-caller parity check pinning `listVaultNamesFromPath` ≡ `listVaultNames(readManifest(...))`.

Gate: `bun test ./src` — **1574 pass / 0 fail / 31219 expects across 83 files** (+19 over rc.14 baseline 1555). SPA: `cd web/ui && bun run test` — **133 pass / 0 fail across 10 files** (unchanged — no SPA changes this PR). typecheck + biome clean (root + web/ui). SPA build clean.

Smoke: see PR description.

What's NOT in PR 4:

- Consumer-side enforcement at vault / notes / scribe — PR 5 (scope-guard verification). The claim is *emitted* in rc.15; the *consumption* lands in rc.16 alongside the resource-server scope-guard surface.
- Multi-vault per user (`assigned_vaults: string[]`) — Phase 2.
- Don't-show-other-vaults UI (the Phase 2 hardening of the picker) — Phase 2. Phase 1 ships lock-the-picker per the design's decision-pin.

## [0.5.10-rc.14] - 2026-05-20

Multi-user Phase 1 — PR 3 of 5: force-change-password flow (hub#252, design [`parachute.computer/design/2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/)). Builds on PR 2 (rc.13) which shipped the admin `/api/users` surface for creating accounts with `password_changed: false`. This release wires the *user* side: a session-level redirect at the login boundary that lands admin-created users on a server-rendered change-password form before they can reach the rest of the hub.

Backend surface:

- `src/admin-handlers.ts` — `loginRedirectTarget(user, next)` helper: when `user.passwordChanged === false`, return `/account/change-password?next=<encoded original-next>` (or the bare path when next is the post-login default); otherwise return `next` (today's behavior). The `/login` POST mints the session cookie as normal and 302s to the helper's target. **Session-level redirect, not token-level** — the user IS authenticated, they're just expected to change their admin-typed default before continuing. Per design §sign-in flow change.
- `src/api-account.ts` (new) — `/account/*` user-self-service surface.
  - **`GET /account/change-password`** — server-rendered HTML form. Requires an active session (otherwise 302 → `/login?next=/account/change-password`). Renders the "first-time login" heading when `password_changed === false`; renders the "Change your password" heading when `true` (direct-nav path: any signed-in user can rotate their password — the redirect at `/login` is the *only* flag-gated behavior). Falls back to `/login` if the session points at a deleted user.
  - **`POST /account/change-password`** — `application/x-www-form-urlencoded` body with `current_password`, `new_password`, `new_password_confirm`, `next`. Order of checks: 401 (no session) → 400 (CSRF) → 400 (missing field) → 413 (new > `PASSWORD_MAX_LEN`, **before** argon2id touches it; same CPU-DoS defense as `/api/users` POST) → 400 `invalid_password` (PR 1's 12-char validator) → 400 `password_mismatch` (new ≠ confirm) → 401 `invalid_credentials` (verifyPassword) → 400 `password_unchanged` (new === current, *after* verify so we don't leak that a guessed new matches an unverified current) → 302 to `next` with `password_changed = 1`. On error the page re-renders with an inline error banner; the session cookie is untouched (the user stays signed in). Session cookies on other devices stay valid through their natural 24h expiry — Phase 2 adds explicit "sign out everywhere" per the design's trade-off discussion.
  - **`markPasswordChanged(db, userId, now?)`** — idempotent UPDATE that flips the flag and bumps `updated_at`. Lives next to the POST handler for now; lift into `users.ts` when PR 4 (or a Phase 2 admin-reset path) adds a second call site.
- `src/account-change-password-ui.ts` (new) — pure renderer for the two-mode form. Same chrome family as `admin-login-ui.ts` (`/login`): inline CSS, no third-party fonts, no SPA bundle. Form works without JS; an inline `<script>` adds fast-feedback validation (mirroring the three server checks: min length, confirm match, current ≠ new).
- `src/hub-server.ts` — route table extended (`/account/change-password` GET + POST). Dispatch placed adjacent to `/login` and `/logout` since the three surfaces share the session-cookie posture.

Tests + gates:

- `src/__tests__/api-account.test.ts` (new) — 18 tests covering: GET no-session 302 (with `next` preservation through `/login`), GET first-time vs rotate mode by flag, GET against stale-user session, POST happy path (hash updates, flag flips, 302 to next, default lands on `/admin/vaults`), every POST validation branch (no session, CSRF mismatch, wrong current, too short, too long with elapsed-time floor < 200ms asserting cap fires before argon2id, mismatch confirm, unchanged after verify), failure-re-render keeps session cookie. `markPasswordChanged` unit tests for the happy path + idempotent re-call.
- `src/__tests__/admin-handlers.test.ts` — 4 new `loginRedirectTarget` tests: passwordChanged=false with next= encodes the original destination into the change-password URL, no-next= → bare `/account/change-password`, passwordChanged=true → existing behavior unchanged, unsafe next= can't leak through the encoder. Updated 6 existing login-POST tests to pass `passwordChanged: true` on `createUser` (matches wizard-admin posture; old tests pre-dated the force-change behavior and would otherwise land on the change-password URL).

Gate: `bun test ./src` — **1553 pass / 0 fail / 31176 expects across 82 files** (+23 over rc.13 baseline 1530). SPA: `cd web/ui && bun run test` — **133 pass / 0 fail across 10 files** (unchanged — no SPA changes this PR). typecheck + biome clean (root + web/ui). SPA build clean.

Smoke: see PR description.

What's NOT in PR 3:

- OAuth issuer `vault_scope` claim + per-user scope narrowing — PR 4.
- End-to-end verification + scope-guard reach-through — PR 5.
- 2FA enrollment inline on first sign-in — Phase 1.5 PR 6 (optional, design §2FA-orientation).
- Admin-reset-another-user's-password — Phase 2 (design §6: Phase 1's recovery shape is delete + re-create).
- "Sign out everywhere" / cross-session invalidation on password change — Phase 2 self-service profile page.

## [0.5.10-rc.13] - 2026-05-20

Multi-user Phase 1 — PR 2 of 5: admin `/admin/users` page + API (hub#252, design [`parachute.computer/design/2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/)). Builds on PR 1's `users` table foundation (rc.12): wires the `validateUsername` / `validatePassword` validators into a four-endpoint admin surface, adds the SPA route, and adds the FK-aware delete-user helper that keeps token audit rows intact while letting the parent users row drop.

Backend surface:

- `src/api-users.ts` (new) — four endpoints, all `parachute:host:admin`-gated (same gate as `/api/grants`, `/vaults`, destructive `/api/modules/:short/*`). Snake-case wire shape; `password_hash` is **never** returned.
  - **`GET /api/users`** — list users sorted by `created_at ASC` (consistent with first-admin selector). Returns `{ users: [{ id, username, password_changed, assigned_vault, created_at }, …] }`.
  - **`POST /api/users`** — body `{ username, password, assignedVault?: string | null }`. Order of checks: 413 `password_too_long` if `password.length > PASSWORD_MAX_LEN` (256) — fires **before** argon2id touches the body, mitigating the CPU-DoS shape; 400 `invalid_username` (length / format / reserved); 400 `invalid_password` (< 12 chars); 400 `assigned_vault_not_found` if the vault isn't in services.json; 409 `username_taken` case-insensitive; 201 with `{ user: {…} }` on success. Admin-created users land with `password_changed: false` so PR 3's `/login` force-redirect catches them on first sign-in.
  - **`DELETE /api/users/:id`** — 404 unknown id; 403 `first_admin_undeletable` when the target row is the earliest `created_at` (safety rail to prevent self-locking the hub); 204 on success. Delete flow: revoke all the user's tokens (`tokens.revoked_at = now`), null out `tokens.user_id` (and backfill `subject` with the username so the audit trail isn't anchored to a vanished PK), drop their `sessions` + `grants` (non-cascading FKs), then drop the users row. All wrapped in a single transaction.
  - **`GET /api/users/vaults`** — sorted vault-instance-name list from services.json (`vaultInstanceNameFor` + `isVaultEntry`). Feeds the SPA's assigned-vault dropdown. Mirrors the (private) `listVaultNames` in `oauth-handlers.ts` so PR 4's issuer-side validation reads from the same source.
- `src/users.ts` — adds `getUserByUsernameCI(db, username)` (case-insensitive lookup; `COLLATE NOCASE` — defense in depth against legacy mixed-case rows shadowing the validator-pinned lowercase form) and `deleteUser(db, userId)` (the FK-aware sweep above; returns `false` for unknown ids so the API layer can 404-or-204 by race).
- `src/hub-server.ts` — route table extended (`/api/users`, `/api/users/vaults`, `/api/users/<id>`); per-id route falls through after the literal `vaults` segment is pre-empted so `vaults` can't be mistaken for an id.

Frontend surface:

- `web/ui/src/routes/Users.tsx` (new) — three-section page. (1) Users table with columns Username · Assigned vault · Password set · Created · Actions; `assigned_vault: null` renders as `—` (tooltip explains "no per-vault restriction (admin-level access)"); `password_changed: false` renders as "pending first login"; first row carries a "first admin" badge and a disabled Delete button with tooltip "First admin can't be deleted (would self-lock the hub)". (2) Collapsible Create-user form below the table — username + password + assigned-vault dropdown (`"No restriction (admin-level access)"` is the first option mapping to `null`; subsequent options are vault names from `/api/users/vaults`); client-side validates username regex + length and password ≥ 12 chars before posting (server is authoritative — the client check is fast feedback). On success the form clears and a banner says "User &lt;name&gt; created. They'll be prompted to change their password on first sign-in." (3) Delete confirmation inline dialog mirroring `Permissions.tsx`'s revoke pattern — click → confirm → DELETE → table refresh.
- `web/ui/src/lib/api.ts` — `listUsers()`, `createUser(input)`, `deleteUser(id)`, `listUserVaults()`. `deleteUser`'s 403 path deliberately does **not** clear the cached bearer (403 here is "first_admin_undeletable" policy, not auth failure — clearing the token wouldn't help).
- `web/ui/src/App.tsx` — `/users` route mounted; `Users` link added to the nav between Modules and Permissions; subtitle helper recognises `/users`.

Tests + gates:

- `src/__tests__/api-users.test.ts` (new) — 28 tests covering: auth boundary (401 / 403) on every endpoint, GET happy path (no hash leakage, snake-case shape, created_at order), POST happy paths (with and without `assigned_vault`), every POST validation branch (username length / format / reserved, password too short, 413 with elapsed-time floor ≤ 200ms to assert the cap fires before argon2id), 409 conflict case-insensitive, 400 `assigned_vault_not_found`, DELETE 404 unknown id, DELETE 403 first-admin-undeletable, DELETE 204 with token revocation + user_id NULL + subject backfilled with username, GET `/api/users/vaults` with empty and populated services.json.
- `src/__tests__/users.test.ts` — `getUserByUsernameCI` + `deleteUser` unit coverage (3 + 2 tests).
- `web/ui/src/routes/Users.test.tsx` (new) — 13 tests covering: loading state, empty state, list with sample data, listUsers failure, first-admin Delete disabled + tooltip, delete confirm dialog (cancel + confirm + error), create form hidden by default, vault dropdown options include the synthetic No-restriction entry, create happy path posts the right body and refreshes the list, client-side rejects 11-char password, 409 conflict surface.
- `src/App.test.tsx` — nav-link-order assertion updated to include the new Users link.

Gate: `bun test ./src` — **1530 pass / 0 fail / 31120 expects across 81 files** (+33 over rc.12 baseline 1497). SPA: `cd web/ui && bun run test` — **133 pass / 0 fail across 10 files** (+13 over rc.12 baseline 120). typecheck + biome clean (root + web/ui). SPA build clean (`vite build` + `verify-base.mjs` green).

Smoke: spun up a hub against `PARACHUTE_HOME=/tmp/hub-mu-pr2`, walked the wizard, opened `/admin/users` — first admin in the list with Delete disabled. Created `testuser` with `verylongpassword123` and assigned vault → user appeared with "pending first login" status. `curl -X DELETE` against the first admin returned 403 `first_admin_undeletable`. UI-deleted `testuser` → row removed, no errors. `curl -X POST` with a 300-char password returned 413 `password_too_long`.

What's NOT in PR 2 (deferred to later PRs in the chain):

- `/login` force-change-password redirect + `/account/change-password` form — PR 3.
- OAuth issuer `vault_scope` claim + per-user scope narrowing — PR 4.
- End-to-end verification + scope-guard reach-through — PR 5.
- Edit-existing-user (reassign vault, reset password) — Phase 2 (Phase 1's admin recovery shape is "delete + re-create").
- 2FA enrollment inline on first sign-in — Phase 1.5 PR 6 (optional, design §2FA-orientation).

## [0.5.10-rc.12] - 2026-05-20

Multi-user Phase 1 — PR 1 of 5: users table foundation (hub#252, design [`parachute.computer/design/2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/)). Schema-only foundation that the admin-creates-user surface (PR 2), force-change-password flow (PR 3), and OAuth issuer integration (PR 4) build on. No UI surface, no API endpoints — just migration v8 + `User`-type extensions + reusable username/password validators wired through the wizard's and env-seed paths.

Surface summary:
- `src/hub-db.ts` — migration v8. Two `ALTER TABLE` on `users` (`password_changed INTEGER NOT NULL DEFAULT 0` + `assigned_vault TEXT` nullable) plus a `UPDATE users SET password_changed = 1` backfill so existing rows (wizard admin, env-seeded admin) don't get spurious force-change redirects on first sign-in.
- `src/users.ts` — `User` gains `passwordChanged: boolean` + `assignedVault: string | null`. `CreateUserOpts` gains optional `passwordChanged` (default `false`) and `assignedVault` (default `null`); `createUser` persists both. `rowToUser` translates the 0/1 INTEGER to TS `boolean`. New `validateUsername(name)` helper (charset `[a-z0-9_-]`, length 2-32, case-insensitive reserved list `admin`/`root`/`system`/`setup`/`parachute`/`hub`, returns discriminated union with `format`/`length`/`reserved` reasons). New `validatePassword(password)` helper (12-char minimum, no complexity rules, returns discriminated union with `too_short` reason). Neither validator is wired into a caller yet — PR 2's `POST /api/users` and PR 3's `POST /account/change-password` consume them.
- `src/commands/serve.ts` — `seedInitialAdminIfNeeded` now passes `{ passwordChanged: true }` so env-seeded admins skip the force-change-password redirect on first sign-in (they chose their password via `PARACHUTE_INITIAL_ADMIN_PASSWORD`).
- `src/setup-wizard.ts` — `handleSetupAccountPost` now passes `{ passwordChanged: true }` to `createUser` so the wizard's first-admin (who picked their own password through the form) doesn't get the force-change-password redirect.

What's NOT in PR 1 (deferred to later PRs in the chain):
- Admin SPA `/admin/users` page + API endpoints (`GET`/`POST`/`PATCH`/`DELETE /api/users`) — PR 2.
- `/login` force-change-password redirect + `/account/change-password` form — PR 3.
- OAuth issuer `vault_scope` claim + per-user scope narrowing — PR 4.
- End-to-end verification + scope-guard reach-through — PR 5.

Gate: `bun test ./src` — **1497 pass / 0 fail / 31038 expects across 80 files** (+15 over rc.11 baseline 1482). SPA: `cd web/ui && bun run test` — **120 pass / 0 fail across 9 files** (unchanged — no SPA surface touched). typecheck + biome clean (root + web/ui).

## [0.5.10-rc.11] - 2026-05-20

Fresh-machine connect bug + done-screen token-reveal UX. Two issues surfaced on Aaron's fresh-machine wizard testing pass, folded together.

**Item 1 — `/oauth/authorize` recovery affordance for stale SPA client_ids.** Canonical fresh-machine repro: operator wipes `~/.parachute/hub.db` between testing iterations, walks the wizard again, opens Notes at `/notes/`, clicks Connect — and lands on "Unknown application, this client_id is not registered with this hub." Root cause: Notes' OAuth layer caches its DCR-issued `client_id` in localStorage keyed by `(issuer, redirectUri)`. The browser holds the cache across hub.db resets (same hostname, same redirect, same localStorage), so the SPA keeps using a dangling client_id that the new hub.db has never seen. Hub correctly rejects (RFC 6749 §3.1.2 — never grant authorize against an unregistered client) but the operator is stranded and the SPA has no signal to clear its cache. Hub-side fix: when `/oauth/authorize` (GET or POST consent) finds `client = null` AND the request's `redirect_uri` points at an origin the hub itself serves (any entry in `hubBoundOrigins`), render a recovery page with a "Reset connection & reload" button. The inline JS clears every `lens:dcr:*` key from localStorage on the hub's origin (Notes' DCR cache prefix) and navigates to the redirect_uri's pathname so the SPA reloads and runs a fresh DCR. Cross-origin or malformed redirect_uris fall back to the static error variant — we can't safely reach a third-party SPA's storage from this page. Notes ships the canonical-mounted-at-hub-origin shape; future Parachute SPAs that follow the same pattern get the affordance for free.

**Item 2 — done-screen Bearer token masked by default.** The wizard's done step rendered the auto-minted operator token verbatim inside a `<pre>` block, making it shoulder-surf-able, screencast-leakable, and over-the-shoulder-photo-able from the moment the operator finished setup. Fix: render the visible `<pre id="mcp-cmd">` with the Bearer token replaced by a row of `•` characters (count clamped to 8–40 so very-short or very-long tokens don't render comically; the JTI-derived token format is fixed-width so the clamp is purely visual). Stash the real command as JSON-encoded text inside a hidden `<script type="application/json" id="mcp-cmd-real">` block — script-element content is raw text per the HTML spec (entity references aren't parsed), so JSON encoding round-trips through `textContent + JSON.parse` cleanly. Surface two buttons: **Show token** toggles the visible `<pre>` between masked and revealed (auto-hides after 10s so a stray reveal can't leak into a subsequent screencast), **Copy** always reads from the JSON stash and writes the real command to the clipboard regardless of mask state. The visible mask is a UX nicety; the clipboard path is load-bearing — Aaron's pattern of "copy command, paste, hit enter" must keep working without the operator ever revealing.

Surface summary:
- `src/oauth-ui.ts` — new `UnknownClientViewProps` type + `renderUnknownClient(props)` template that builds the "Unknown application" page with an optional inline-JS recovery button. The button clears `lens:dcr:*` localStorage keys and navigates to `selfOriginRedirectPath` (the redirect_uri's pathname, when the URL parses against a bound origin). New `.unknown-client-actions` + `.fine` style hooks.
- `src/oauth-handlers.ts` — `handleAuthorizeGet` + `handleAuthorizePost` now route the `getClient(...) === null` branch through `unknownClientResponse(clientId, redirectUri, deps)` which calls `resolveSelfOriginRedirectPath` to decide whether to surface the recovery affordance. The operator-driven approve POST (`/oauth/authorize/approve`) keeps the static `htmlError` variant — it's a different surface (operator-shaped, not SPA-shaped).
- `src/setup-wizard.ts` — `renderMcpTile`'s minted-token branch now emits a masked `<pre>` + a JSON-encoded `<script type="application/json">` stash + Show + Copy buttons wired through a single IIFE. The `</script>` escape (`<\/`) inside the JSON keeps a hostile token from breaking out of the stash element. New `.mcp-cmd-actions` + `.btn-mcp-aux` + `.mcp-cmd-wrap[data-state="revealed"]` styles. The bare (no-token) branch is unchanged — it never had a token to mask.
- Tests: `src/__tests__/oauth-handlers.test.ts` +5 covering the unknown-client recovery affordance — GET path (renders for self-origin redirect_uri, falls back to static for unbound/malformed redirect_uris, falls back to `[issuer]` when `hubBoundOrigins` is unset) + the consent-POST symmetric path (same shape — pins so a future refactor can't drop the recovery path on the POST). `src/__tests__/oauth-ui.test.ts` +4 covering `renderUnknownClient` directly (client_id escaped, recovery button + data-target + lens:dcr present when self-origin, escaped data-target on hostile input, omitted recovery + static fallback when null). `src/__tests__/setup-wizard.test.ts` +2 + 1 updated covering: visible `<pre>` is masked by default, JSON stash holds the real command, both buttons present and wired to read the JSON stash via JSON.parse, auto-hide timer wired, JSON encoder escapes `</script>` so a hostile token can't break out (decode round-trips).

Gate: `bun test ./src` — **1482 pass / 0 fail / 30953 expects across 80 files** (+2 over rc.10 baseline 1480). SPA: `cd web/ui && bun run test` — **120 pass / 0 fail across 9 files** (unchanged — no SPA surface touched). typecheck + biome clean (root + web/ui).

## [0.5.10-rc.10] - 2026-05-20

Operator-settable module install channel (closes hub#275). The runtime module installer (`bun add -g <pkg>@<channel>`) had `@latest` hardcoded in `runInstall` / `runUpgrade`, which forced operators tracking the RC chain to hand-edit the npm spec on every upgrade. This PR adds a `module_install_channel` hub_settings key (`"latest" | "rc"`), bootstraps it from `PARACHUTE_MODULE_CHANNEL` on first read so a fresh-machine deploy can lock its channel via env var, surfaces the current value in `GET /api/modules`, and adds a `PUT /api/modules/channel` endpoint + small admin SPA toggle on `/admin/modules` so the operator can switch channels at runtime. Aaron's fresh-machine deploys can set `PARACHUTE_MODULE_CHANNEL=rc` to track the RC chain automatically. After the first seed the row is the source of truth — env var changes on subsequent boots are ignored (admin must use the toggle or the API).

Surface summary:
- `src/hub-settings.ts` — new `module_install_channel` key on the `HubSettingKey` union; `ModuleInstallChannel` type + `MODULE_INSTALL_CHANNELS` + `isModuleInstallChannel` validator; `PARACHUTE_MODULE_CHANNEL_ENV` constant + `DEFAULT_MODULE_INSTALL_CHANNEL`; `getModuleInstallChannel(db, { env?, warn? })` reads with first-call env-var seed (valid → seed + return, invalid → warn + seed "latest" + return, unset → seed "latest" + return); `setModuleInstallChannel(db, channel)` writes. Corrupted-row defense: falls back to "latest" silently.
- `src/api-modules-ops.ts` — `runInstall` + `runUpgrade` read `getModuleInstallChannel(deps.db)` on every op (no restart needed for toggle changes), construct `<pkg>@<channel>` for `bun add -g`, and the log/failure messages echo the channel-resolved spec so tailing operators see which channel was used.
- `src/api-modules.ts` — `module_install_channel` field on the GET response (so the SPA reads the toggle's initial state in one roundtrip); new `handleApiModulesChannel` for `PUT /api/modules/channel` bearer-gated on `parachute:host:admin` (same scope boundary as install/upgrade/uninstall — destructive-ish operator-only) with body `{ channel: "latest" | "rc" }`. 405 on non-PUT, 401 on missing/invalid bearer, 403 on insufficient scope, 400 on malformed body or invalid channel value, 200 + echo on success.
- `src/hub-server.ts` — wires `/api/modules/channel` route before the `/api/modules/:short/*` dispatcher so the channel path doesn't shadow through `parseModulesPath`.
- `web/ui/src/lib/api.ts` — `ModuleInstallChannel` type on the `ModulesCatalog`; `setModuleChannel(channel)` PUT helper.
- `web/ui/src/routes/Modules.tsx` — `ChannelToggle` radio component at the top of `/admin/modules` (Stable / Release candidates). Default reflects current channel; optimistic update on change with server-echo confirmation; rollback to error state on failure. Copy: "All future module installs and upgrades use this channel. Existing installed modules are unaffected — use Upgrade to pull a newer version." Disabled when supervisor is unavailable.
- `web/ui/src/styles.css` — `.channel-toggle` fieldset styles matching the brand tokens.
- Tests: `src/__tests__/hub-settings.test.ts` +9 covering bootstrap (no-env default, valid env, invalid env warns + falls back, empty env, persistence after seed, set-then-read round-trip, corrupted-row fallback) + `isModuleInstallChannel` validator boundaries. `src/__tests__/api-modules.test.ts` +9 covering the GET channel field surfacing + the PUT endpoint (auth gate, scope gate, body validation, happy-path write, toggle-back). `src/__tests__/api-modules-ops.test.ts` +2 covering rc-channel install + upgrade construct `<pkg>@rc`, and toggling back to latest takes effect on next install. `web/ui/src/routes/Modules.test.tsx` +5 covering toggle render state for both channels, POST on toggle to rc, no-op on same-channel click, error rollback on failed PUT. Existing test fixtures updated for the new required `module_install_channel` field.

Gate: `bun test ./src` — **1470 pass / 0 fail / 30898 expects across 80 files** (+23 over rc.9 baseline 1447). SPA: `bun run test` — **120 pass / 0 fail across 9 files** (+5 over rc.9 baseline 115). typecheck + biome clean.

## [0.5.10-rc.9] - 2026-05-20

Wizard done-screen polish + typed vault-name threading (closes hub#272, #267). Both items are first-boot wizard refinements that build on the just-merged rc.8 (supervisor lifecycle hardening) and the just-merged vault#342 (`PARACHUTE_VAULT_NAME` env-var support in vault's first-boot path). One PR, two logical commits + the rc.9 bump.

**Item 1 (#272) — done-screen polish: auto-mint operator token + direct module-install tiles.** The done screen previously sent the operator to `/admin/vaults` (wrong surface — they wanted `/admin/modules`) and surfaced a bare MCP install command that 401s on first use because Claude Code wouldn't have a Bearer token yet. Two fixes ride together. (a) On the expose-step POST (the canonical "wizard finished" transition), mint a fresh full-scope operator token under `OPERATOR_TOKEN_SCOPE_SETS.admin`, persist it once in a new `setup_minted_token` row in `hub_settings`, and render it on the done screen as `--header "Authorization: Bearer <token>"` pre-filled on the `claude mcp add` command with a one-click Copy button (inline `navigator.clipboard.writeText` — no SPA bundle). The row is single-use: the GET handler deletes it after one read so a refresh / back-button doesn't re-disclose the secret. The jti is still in the `tokens` registry so revocation via `/admin/tokens` works as usual; the wizard log records the jti for traceability. Mint failures are non-fatal (the fallback shape renders the bare command + a pointer to `/admin/tokens`). (b) A new "What's next?" section renders Install Notes + Install Scribe tiles above the existing MCP-connect tile, each posting to a new `/admin/setup/install/<short>` endpoint that gates on session + CSRF + supervisor-mode and drives the same `runInstall` pipeline `/api/modules/<short>/install` uses. Op poll is per-module via `?op_<short>=<id>` (multiple in-flight installs supported); the done page auto-refreshes every 2s while any op is pending/running. "Already installed" state shown when the curated module is already in services.json. The admin-UI tile retargets `/admin/modules` (was `/admin/vaults`) so the fallback link lands on the install surface, not the vaults list.

**Item 2 (#267) — typed vault name threading via PARACHUTE_VAULT_NAME.** Vault#342 added env-var support to vault's first-boot path (`resolveFirstBootVaultName` reads `PARACHUTE_VAULT_NAME`, falls back to `default` when absent or invalid). Hub now exercises that contract end-to-end. The wizard's vault step renders a text input (restored from the fold-B hidden shape in rc.6); the POST handler validates with a `validateVaultName` helper that mirrors vault's strict contract (lowercase alphanumeric + hyphens/underscores, 2–32 chars, `list` reserved); valid input persists to a new `setup_vault_name` hub_settings row for the done-step renderer; the typed name is passed to the supervised vault child via a new `spawnEnv` field on `ApiModulesOpsDeps` (merged into `SpawnRequest.env` at spawn time). Empty input falls back to `default` and omits the env override — vault's own fallback path handles that, no need to thread a redundant value. Invalid input (uppercase, special chars, too-short, too-long) renders the form with a clear error banner + preserved input. The done screen pulls from `setup_vault_name` first (vault's first-boot may not have authoritatively re-written services.json by the time the operator sees the screen), with a `firstVaultName(manifestPath)` fallback.

Surface summary:
- `src/vault-name.ts` (new) — `validateVaultName` mirrored from vault's contract; `DEFAULT_VAULT_NAME = "default"` constant.
- `src/setup-wizard.ts` — vault-step gets a text input + server-side validation; `handleSetupVaultPost` threads `PARACHUTE_VAULT_NAME` via new `spawnEnv` field; `handleSetupExposePost` auto-mints an operator token; `renderDoneStep` carries `mintedToken` + `installTiles` props; new `renderMcpTile` / `renderInstallTiles` / `renderInstallTile` / `buildInstallTiles` helpers + new `handleSetupInstallPost` for the per-module install POST; the done-step renderer auto-refreshes every 2s while any install op is pending/running.
- `src/api-modules-ops.ts` — new `spawnEnv` field on `ApiModulesOpsDeps`, merged into the supervisor's `SpawnRequest.env`. Backwards-compatible (the field is optional + only set when non-empty).
- `src/hub-settings.ts` — two new keys on the `HubSettingKey` union: `setup_minted_token` (single-use, consumed on first done-render) + `setup_vault_name`.
- `src/hub-server.ts` — wires `handleSetupInstallPost` at `/admin/setup/install/<short>`.
- `src/__tests__/setup-wizard.test.ts` — +17 new tests covering: auto-mint at expose POST, done-screen Bearer header rendering, single-use consume, fallback shape; install-tile rendering (idle / installed / op-poll), install POST happy path + rejections (vault / unknown / no-session / no-supervisor); vault name validation, env-var passthrough, default fallback, done-screen surfacing typed name, vault-step pre-fill after error. One existing test updated for the restored input. `src/__tests__/vault-name.test.ts` (new) — 11 tests on the validator (boundary lengths, reserved name, invalid chars, whitespace trim).

Gate: `bun test ./src` — **1446 pass / 0 fail / 30838 expects across 80 files**. +28 over rc.8 (1418 → 1446). typecheck + biome clean.

Smoke (covered in the PR body).

## [0.5.10-rc.8] - 2026-05-20

Supervisor lifecycle hardening bundle (closes hub#263, #264, #265). Three follow-up items from the hub#262 reviewer pass, all on the supervisor's stop/upgrade code path. One PR, two logical commits + the rc.8 bump.

**Item 1 (#263) + Item 2 (#264) — `Supervisor.stop()` now awaits child exit with SIGKILL escalation.** Previously `stop()` sent SIGTERM and returned synchronously. No correctness bug on Render (the OS reaps children when hub exits as PID 1), but children's final log lines never made it through hub's stdout pipe before the platform tore the container down — the last 100ms of vault's logs (often the most diagnostic) vanished from Render's log viewer. And a wedged module that ignored SIGTERM would leak until the container itself was recycled. Same code path, one fix: send SIGTERM, `await Promise.race([proc.exited, setTimeout(killTimeoutMs)])`, escalate to SIGKILL if the timeout wins, then await exit either way. Default 5s timeout (configurable via `SupervisorOpts.killTimeoutMs` so tests can use a small value). `restart()` is simplified — `stop()` already awaits exit, so the post-stop `await entry.proc.exited` block is now redundant.

**Item 3 (#265) — test for upgrade-on-unsupervised-module path.** The upgrade endpoint in `api-modules-ops.ts` has a branch where `bun add -g` succeeds but `supervisor.restart(short)` returns undefined (module is in services.json but never spawned — e.g. seeded by a pre-supervisor `parachute install`). The branch correctly marks the operation `failed` with a "try install first" log line, but it had no test. Added one: writes a services.json row, skips `supervisor.start()`, POSTs `/api/modules/vault/upgrade`, polls the operation, asserts `status: "failed"` + the canonical message.

Surface summary:
- `src/supervisor.ts` — new `killTimeoutMs` opt (default 5000); `stop()` awaits race(exited, timeout) with SIGKILL escalation; `restart()` simplified.
- `src/__tests__/supervisor.test.ts` — existing operator-stop test rewritten to await the new async stop; +2 new tests (SIGKILL escalation, well-behaved await-before-return).
- `src/__tests__/api-modules-ops.test.ts` — +1 new test (upgrade on installed-but-not-supervised).

Gate: `bun test ./src` — **1418 pass / 0 fail / 30746 expects across 79 files**. +3 over rc.7 (1415 → 1418). typecheck + biome clean.

No smoke — these are correctness fixes provable by tests. The SIGKILL escalation is exercised end-to-end in the test by feeding a fake child whose `kill()` only resolves `exited` on SIGKILL.

## [0.5.10-rc.7] - 2026-05-19

Post-wizard polish bundle (hub#268). Three related items caught while walking the rc.6 wizard on a fresh machine. One PR, three logical commits + the rc.7 bump.

**Item 1 — Discovery page doesn't refresh after module install.** Install Notes via `/admin/modules`, click home (`/`), and the new Notes tile didn't appear without a manual reload. The `/.well-known/parachute.json` doc is already built per-request, but the doc response had no `cache-control` header and the client-side fetch ran without `cache: 'no-store'` — so the browser's HTTP cache returned the previous (stale) services list. Belt-and-suspenders fix: `cache-control: no-store` on the well-known JSON response (server) + `cache: 'no-store'` on the client fetch + a `pageshow` listener that re-runs `loadServices()` when the page is restored from bfcache (`event.persisted === true`). Now a fresh GET, a bfcache restore, and a Cmd-R all see the current services list.

**Item 2 — First-boot wizard asks how the hub will be reached.** New "expose" step (between vault and done) presents three radio options: localhost (default), Tailscale tailnet (with the `tailscale serve --bg --https=1939 http://localhost:1939` snippet), or public URL (with a link to the deploy docs + a hint that `PARACHUTE_HUB_ORIGIN` is the env var to set). The answer persists in a new `hub_settings` key/value table (migration v7, key `setup_expose_mode`); the done page reshapes its "Your hub is reachable at:" tile based on the choice. The wizard's job here is to ask + inform — the operator runs the actual networking step themselves. The new step pushes `done` to step 5 in the progress header.

**Item 3 — Auto-approve the first OAuth client after wizard.** On the canonical onboarding (install hub → wizard → install Notes → authorize), the manual approve-client step between Notes-registers and OAuth-flow-completes is friction without value — the operator literally just set up the hub for that purpose. The wizard's expose-step POST opens a 60-minute window (stored as `pending_first_client_auto_approve_until` in `hub_settings`). The next `/oauth/register` within the window is auto-approved + the window cleared (single-use). Subsequent clients fall through to the standard pending-approval flow. Logged as `[oauth] auto-approved first client clientId=… within wizard window` so operators can see what happened. The bearer + same-origin-session auto-approve paths still take precedence — they never reach the window-consume code, so the window stays available for the canonical first un-authenticated client.

Surface summary:
- 2 new modules: `src/hub-settings.ts` (KV accessor + auto-approve window helpers) + the v7 migration in `src/hub-db.ts` (`hub_settings` table).
- 1 new test file: `src/__tests__/hub-settings.test.ts` — 14 tests covering the KV API, `isSetupExposeMode` validation, and the open/check/consume/clear lifecycle of the auto-approve window (including malformed timestamps, expiry, and re-open after consume).
- 5 modules edited: `src/hub-server.ts` (cache-control on well-known + `/admin/setup/expose` route), `src/hub.ts` (no-store fetch + pageshow listener), `src/setup-wizard.ts` (new expose step + reachable tile + `handleSetupExposePost` + auto-approve window open + done-page expose-mode awareness), `src/oauth-handlers.ts` (consume-window check in `handleRegister`).
- 3 test files edited: `src/__tests__/setup-wizard.test.ts` (+11 tests: deriveWizardState shape, expose step rendering, done-page expose-mode variants, `handleSetupExposePost` shape — valid/invalid mode, missing session, missing CSRF, idempotent), `src/__tests__/oauth-handlers.test.ts` (+6 tests: auto-approve within window, after expiry, single-use, no-window default, precedence over session-cookie path, malformed timestamp), `src/__tests__/hub-server.test.ts` (+1 test: cache-control on well-known) + 2 existing tests updated for the new expose gate, `src/__tests__/hub.test.ts` (+2 tests: client-side `cache: 'no-store'` + `pageshow` re-fetch).

Gate: `bun test ./src` — **1415 pass / 0 fail / 30734 expects across 79 files**. +32 over rc.6 (1383 → 1415). The pre-existing `status > all-healthy returns 0 and prints table` env-flake passed this run too. typecheck + biome clean.

Local smoke (`http://localhost:11949`, fresh `PARACHUTE_HOME=/tmp/hub-bundle-smoke-1`):
- Walked the wizard end-to-end three times (localhost / tailnet / public). Each chose its radio, hit Continue, landed on the done page with the right reachable tile.
- After each walk, `getSetting(hub.db, 'setup_expose_mode')` reflected the answer and `getSetting(hub.db, 'pending_first_client_auto_approve_until')` was set ~60min in the future.
- Verified `/.well-known/parachute.json` response carries `cache-control: no-store` (curl `-I`); discovery page bundle contains `cache: 'no-store'` + the `pageshow` listener.
- Auto-approve smoke: registered an OAuth client via curl POST to `/oauth/register` within the window → response showed `"status": "approved"`. Second registration within the same window → `"status": "pending"`. Setting expires correctly; consume clears it.
- The `bun add` install path still fails in Aaron's dev env (stale paraclaw→parachute-agent lockfile from the rename); the wizard correctly surfaces `status: failed` for the vault step. Not on this PR's critical path — same issue rc.6 documented.

## [0.5.10-rc.6] - 2026-05-19

Two blocking bugs caught by fresh-machine testing on rc.5 (neither caught by the unit suite or reviewer because both only manifest over `http://localhost`).

**Bug 1 — CSRF + session cookies dropped over HTTP.** `buildCsrfCookie`, `buildSessionCookie`, and `buildSessionClearCookie` unconditionally included the `Secure` attribute. Browsers silently drop `Secure` cookies on plain HTTP, so on `http://localhost:1939`:

- GET `/admin/setup` Set-Cookie with CSRF token T1 + Secure → browser drops it
- POST `/admin/setup/account` carries `__csrf=T1` in form body but no cookie in headers
- `verifyCsrfToken` finds no cookie token → returns false
- Wizard returns 400 "Invalid form submission. Reload and try again."

Fix: new `src/request-protocol.ts` exports an `isHttpsRequest(req)` helper that checks (1) `new URL(req.url).protocol === "https:"`, (2) `X-Forwarded-Proto: https` (reverse-proxy deployments), (3) defaults false. Each cookie-mint helper now accepts `{ secure?: boolean }` (default true). `ensureCsrfToken` reads `isHttpsRequest(req)` automatically; the four session-cookie callsites (`admin-handlers.ts` login/logout, `oauth-handlers.ts` login, `setup-wizard.ts` account POST) each pass the bit through explicitly. Posture stays secure-by-default — every callsite has to *prove* the request is plain HTTP to omit `Secure`. Audit confirmed no other Set-Cookie strings exist outside these three helpers.

**Bug 2 — `/` doesn't funnel to /admin/setup on a fresh hub.** Pre-rc.6, GET `/` on a hub with no admin rendered the static discovery portal — which carries no usable signal on a fresh hub. Aaron had to manually navigate to `/admin/setup` to escape.

Fix: when `userCount(db) === 0`, GET `/` and `/hub.html` 302 to `/admin/setup`. The redirect sits between the `/admin/setup*` dispatch block (passes through unaffected) and the JSON-shaped 503 lockout gate. 302 (not 301) so the redirect disappears the moment the wizard finishes. HTML routes get HTML responses; the JSON 503 stays correct for API + SPA + OAuth callers that branch on the structured body.

Surface summary:
- 1 new module: `src/request-protocol.ts` — single `isHttpsRequest` helper, no deps.
- 1 new test file: `src/__tests__/request-protocol.test.ts` — 5 tests covering https://, http://, X-Forwarded-Proto in both directions, and proxy header normalization.
- 5 modules edited: `src/csrf.ts` + `src/sessions.ts` (helper signatures + protocol-aware ensureCsrfToken), `src/admin-handlers.ts` + `src/oauth-handlers.ts` + `src/setup-wizard.ts` (thread `isHttpsRequest(req)` through cookie-mint callsites), `src/hub-server.ts` (fresh-hub `/` redirect block).
- 4 test files edited: `src/__tests__/csrf.test.ts` (+3 assertions), `src/__tests__/sessions.test.ts` (+3 assertions), `src/__tests__/setup-gate.test.ts` (replace stale `/` assertion with two 302 assertions), `src/__tests__/hub-server.test.ts` (update pre-admin-lockout test for new `/` spec; seed admin in signed-out-indicator test).

Gate: `bun test ./src` — **1383 pass / 0 fail / 30653 expects across 78 files**. +15 over rc.5 (1368 → 1383). The pre-existing `status > all-healthy returns 0 and prints table` env-flake passed this run too. typecheck + biome clean.

Local smoke (`http://localhost:11942`, fresh `PARACHUTE_HOME`):
- `GET /` → 302 `/admin/setup` (Bug 2 fixed)
- `GET /hub.html` → 302 `/admin/setup` (Bug 2 same)
- CSRF cookie Set-Cookie on HTTP: `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` — NO `Secure` (Bug 1 fixed)
- Full wizard chain with `curl --cookie-jar` (the actual browser-equivalent test): GET wizard → POST account → cookies persist with `secure: false` flag in jar → resumed wizard renders vault step → POST vault enqueues op → done-state branches work.
- Vault `bun add` still fails in Aaron's dev env from the stale workspace lockfile (paraclaw→parachute-agent rename) — wizard correctly surfaces `status: failed` to the operator. Not on this PR's critical path.

## [0.5.10-rc.5] - 2026-05-18

First-boot web wizard at `/admin/setup` (closes #259, Phase 1B). Replaces the static placeholder that hub#258 shipped with a three-step server-rendered flow that walks a fresh operator through admin-account creation + first-vault provisioning without leaving the browser. Pairs with the Phase 1A module-management API + supervisor (hub#262) — Phase 1B is the wizard that drives the same install path from the operator's first visit instead of the SPA's `/admin/modules` page.

**The wizard.** New `src/setup-wizard.ts`. Server-rendered HTML (no SPA bundle, no JS) so a fresh container with no admin yet stays reachable through any browser. Step progression is derived from DB + services.json on every GET, so a re-visit after a partial setup resumes at the right step — no client-side state to lose. The three steps:

- **Welcome + account** (POST `/admin/setup/account`). Username + password + confirm, with server-side validation (2–64 chars, password ≥ 8, confirm matches). On success: `createUser` → session cookie → 303 to `/admin/setup` (which re-derives state and renders step 3). The env-var seed path (`PARACHUTE_INITIAL_ADMIN_USERNAME` / `PARACHUTE_INITIAL_ADMIN_PASSWORD`) still works and is documented as an "alt-path" disclosure on the welcome screen.
- **Vault** (POST `/admin/setup/vault`). Vault-name field (default `default`), gated by the just-minted admin session cookie. Drives the same internal `runInstall` helper the `/api/modules/:short/install` API uses — newly exported from `api-modules-ops.ts` so non-API callers can reach the install pipeline without re-fabricating an HTTP request + bearer-mint dance. Returns a 303 to `/admin/setup?op=<id>` so the wizard's poll-page renders next.
- **Done**. Side-by-side tiles: "Open the admin UI" + "Connect Claude Code (MCP)" with the copy-pasteable `claude mcp add` line carrying the vault name + hub origin the operator just chose. Renders one-shot via `?just_finished=1`; once the setup state is "complete" without that query, the route 301s to `/login` so a stale bookmark lands somewhere useful.

**Pre-admin gate threading.** `shouldGateForSetup` in `hub-server.ts` now opens through the wizard's three sub-paths (`/admin/setup`, `/admin/setup/account`, `/admin/setup/vault`) — every other `/admin/*` and `/api/*` route still 503s with `setup_required` until the admin row exists. The 301 from `/admin/setup` to `/login` now fires only when BOTH admin and vault are in place (the wizard's "done" state); admin-only states resume at step 3.

**Shared install seam.** `api-modules-ops.ts` now exports `runInstall`, `specFor`, and `getDefaultOperationsRegistry` so the wizard can drive the same install → services.json-seed → supervisor-spawn sequence the SPA's `/admin/modules` page uses. The operation registry is the process-singleton both code paths share, so a stale `/api/modules/operations/:id` poll from a SPA tab can pick up an op the wizard created (and vice versa). The `OperationsRegistry` interface is now exported for the same reason.

Surface summary:
- 1 new module: `src/setup-wizard.ts`.
- 1 new test file: `src/__tests__/setup-wizard.test.ts` — 19 tests covering pure state derivation, GET-render branches, account-step POST (happy path + validation errors + CSRF rejection + idempotent re-post), vault-step POST (supervisor-required, session-required, install-op-enqueued, name-validation), and end-to-end through `hubFetch`.
- 3 modules edited: `src/hub-server.ts` (route the three wizard surfaces, remove the static placeholder), `src/api-modules-ops.ts` (export internal helpers), `src/__tests__/setup-gate.test.ts` (update two assertions to reflect the wizard's new shape — placeholder→form, admin-only state resumes at step 3 instead of 301-ing to login).

Gate: `bun test ./src` 1367 pass / 1 fail (pre-existing `status > all-healthy returns 0` env flake, same as rc.4) / 30614 expects across 77 files. +19 over rc.4 (all in `setup-wizard.test.ts`). typecheck clean. biome clean. SPA build clean.

Local smoke documented in the PR body. Verified `parachute serve` against a fresh `PARACHUTE_HOME`: pre-admin `/api/me` 503s with `setup_required`; `/admin/setup` renders the account form; POST creates the admin row + sets session cookie + 303s back; resumed wizard renders the vault form; vault POST enqueues an install op + 303s to `?op=<id>`; op-poll page renders status + log + auto-refresh meta; with admin + vault both present, `/admin/setup` 301s to `/login` and `?just_finished=1` renders the success screen with the correct MCP install command (`claude mcp add --transport http parachute-<name> <origin>/vault/<name>/mcp`). The real `bun add -g @openparachute/vault@latest` step is environmental — Aaron's dev box has a broken global lockfile from the paraclaw→parachute-agent rename so the install errors; the wizard correctly surfaces the failure to the operator and the path is wired end-to-end. A clean container won't hit that.

## [0.5.10-rc.4] - 2026-05-18

Fold reviewer security nit on hub#262: destructive POST endpoints (`install` / `restart` / `upgrade` / `uninstall`) now require `parachute:host:admin` (was `parachute:host:auth`). The `:auth` scope reads the catalog; `:admin` mutates it. SPA path unaffected (host-admin token carries both scopes); narrow `--scope-set auth` automation tokens now correctly get 403 on destructive operations. Also drops dead `existsSync` import. +1 test asserting the 403 path.

## [0.5.10-rc.3] - 2026-05-18

Admin module management for v0.6 Render self-host (closes #260, Phase 1A). The cloud-deployed hub starts empty; this PR makes vault / notes / scribe installable from the SPA so a friend who clicks Deploy can stand up the full stack without leaving the browser.

**Per-module child supervisor.** New `src/supervisor.ts` attaches each module as a Bun.spawn child, line-prefixes their stdout/stderr into hub's own (so Render's log viewer shows `[vault] …` alongside `[scribe] …`), and restarts on crash with a sliding-window budget (3 in 60s by default; then `crashed`). Idempotent `start()`, explicit `restart()`, `list()`/`get()` for the API surface. The on-box `parachute start <svc>` path stays on `commands/lifecycle.ts` — different ownership.

**Boot-time auto-start.** `parachute serve` reads services.json after admin-seed and hands each registered module to the supervisor. Empty services.json (fresh container) is a no-op — hub HTTP server still comes up so the operator can install via UI. Per-module `.env` is layered under `PARACHUTE_HUB_ORIGIN` (live env wins on collision).

**Module management API.** Six endpoints under `/api/modules/*`, all bearer-gated on `parachute:host:auth`:

- `GET /api/modules` — curated catalog (vault/notes/scribe) joined with services.json + supervisor state + npm `@latest` probe (3s timeout, 5min cache). Returns `supervisor_available: false` under CLI mode so the SPA disables actions cleanly.
- `POST /api/modules/:short/install` — async. `bun add -g @openparachute/<svc>@latest` → seed services.json → supervisor.start. Returns 202 + `{operation_id}`. Idempotent: already-running short-circuits to `succeeded`.
- `POST /api/modules/:short/restart` — sync. supervisor.restart. Returns the new state.
- `POST /api/modules/:short/upgrade` — async. `bun add @latest` → supervisor.restart.
- `POST /api/modules/:short/uninstall` — sync. Stop child → remove services.json row → `bun remove -g`. Each step idempotent.
- `GET /api/modules/operations/:id` — poll an async op (`pending` → `running` → `succeeded`|`failed`). The SPA polls every 1s.

Curated-only for v0.6 — `parseModulesPath` refuses non-vault/notes/scribe shorts. Channel is exploration, not committed-core; marketplace is Phase 2.

**`/admin/modules` SPA page.** New `web/ui/src/routes/Modules.tsx`. Lists every curated module with status badge (`running` / `stopped` / `crashed` / `starting` / `restarting` / not-installed), version pair (installed → latest), and per-row action buttons. Async ops show inline progress + the operation log; sync errors stay on the row banner until the next action.

**Container plumbing.** Dockerfile sets `BUN_INSTALL=/parachute/modules` so modules installed via `bun add` land on the persistent disk and survive container restarts. The runtime stage chowns `/parachute` to uid 1000 (the non-root `bun` user) so the volume is writable on first boot. render.yaml carries the env defaults Render injects on Deploy.

Surface summary:
- 6 new modules: `src/supervisor.ts`, `src/commands/serve-boot.ts`, `src/api-modules.ts`, `src/api-modules-ops.ts`, `web/ui/src/routes/Modules.tsx`, `web/ui/src/routes/Modules.test.tsx`.
- 6 modules edited: `src/commands/serve.ts` (boot-spawn wiring), `src/hub-server.ts` (HubFetchDeps.supervisor + 6 route additions), `web/ui/src/lib/api.ts` (6 new client helpers), `web/ui/src/App.tsx` (nav + route), `Dockerfile` (BUN_INSTALL + chown), `render.yaml` (env defaults).

Gate: `bun test ./src` 1347 pass / 1 fail (pre-existing `status > all-healthy returns 0` env flake) / 30555 expects across 76 files. +40 over rc.2 (12 supervisor + 6 serve-boot + 8 api-modules + 14 api-modules-ops). `cd web/ui && bun run test` 115 pass / 0 fail (+10 Modules.test.tsx). typecheck clean. biome clean.

Container smoke deferred to the operator's Render dashboard verification — local docker build was not exercised in this PR (no docker daemon available). The supervisor + boot-spawn + module-mgmt-API layers are unit-tested against stubbed spawn/run seams; the Render-side smoke (build image → install vault via UI → restart container → verify persistence) is the final v0.6 gate before promotion to stable.

Phase 1B (real-time module status updates, per-module log streaming in the SPA) is deferred to a follow-up PR — this one is already ~1300 LOC across both server + SPA.

## [0.5.10-rc.2] - 2026-05-18

Reviewer nits folded — render.yaml comments + DB close on stop + CONFIG_DIR note.

- **`render.yaml`** — comment the `plan: starter` line (persistent disks
  aren't on Render's free tier; Render auto-resizes online if you want to
  upgrade later). Also comment the `PARACHUTE_HUB_ORIGIN` env entry with
  the issuer-claim caveat (leave blank to derive from request origin on
  first boot; set BEFORE issuing OAuth tokens — tokens minted with one
  issuer claim won't validate against another).
- **`src/commands/serve.ts`** — `stop()` now closes the hub DB handle in
  addition to stopping the Bun server, so test harnesses don't leak the
  underlying SQLite handle across runs. Return type widened to
  `() => Promise<void>`; `src/cli.ts` SIGINT/SIGTERM handler awaits it.
- **`src/commands/serve.ts`** — added a note above the `CONFIG_DIR` /
  `WELL_KNOWN_DIR` imports documenting that they're evaluated at
  module-load time from `process.env.PARACHUTE_HOME`; the `env` seam on
  `serve()` cannot reroute them. Tests should set `PARACHUTE_HOME`
  before importing for path isolation.

Gate: `bun test ./src` 1307 pass / 1 fail (same pre-existing
`status > all-healthy returns 0` env flake). typecheck clean. biome clean.

## [0.5.10-rc.1] - 2026-05-18

Render self-host foundation (closes #258). Three sub-changes ship together so
the container-deploy path arrives in one revert-able PR:

- **`Dockerfile`** — multi-stage `oven/bun:1.3-alpine` build. Stage 1 installs
  with `--frozen-lockfile --ignore-scripts`, then runs `bun run build:spa`
  explicitly so the install layer stays source-independent. Stage 2 copies the
  built SPA + `node_modules` + source, declares `PARACHUTE_HOME=/parachute` as
  the persistent-disk mount, exposes 1939, runs as non-root `bun` user under
  `tini` for clean signal handling, and entrypoints `bun src/cli.ts serve`.
  `.dockerignore` prunes the build context (node_modules, .git, dist, OS
  junk, CHANGELOG, etc.) so layer caches stay tight.
- **`render.yaml`** — Render Blueprint. One web service backed by the
  Dockerfile, persistent 1 GB disk mounted at `/parachute` (`PARACHUTE_HOME`),
  `/health` health check, and `sync: false` placeholders for the public
  origin + admin seed env vars so a fresh deploy prompts the operator for
  each via the dashboard rather than baking secrets into the repo.
- **`parachute serve` foreground entrypoint** — new subcommand for the
  container-supervisor shape. Reads `PORT` (default 1939), `PARACHUTE_HUB_ORIGIN`,
  and `PARACHUTE_BIND_HOST` from env; binds the hub HTTP listener on
  `0.0.0.0` by default; auto-writes the static `hub.html` on a fresh disk
  so `/` serves a discovery page without `parachute expose` having to run
  first.
- **Env-driven first-boot seed + `/admin/setup` placeholder + pre-admin
  503 gate.** `parachute serve` reads `PARACHUTE_INITIAL_ADMIN_USERNAME` +
  `PARACHUTE_INITIAL_ADMIN_PASSWORD` on first boot; when no admin row
  exists and both are set, seeds the admin via `createUser`, logs
  `seeded initial admin "<name>" from PARACHUTE_INITIAL_ADMIN_*` to stdout,
  and proceeds. Boot-time idempotent — once an admin exists the env vars
  are ignored, so leaving them set across restarts is safe. When no admin
  and no seed, the hub still comes up and a placeholder page lives at
  `/admin/setup` pointing at the env-var path; admin-onboarding-coupled
  surfaces (`/login`, `/logout`, `/admin/*` except `/admin/setup`,
  `/api/*`) return `{error: "setup_required", setup_url: "/admin/setup"}`
  until an admin is configured. `/health`, `/`, `/.well-known/*`,
  `/oauth/*`, and content proxies (`/vault/*`, generic `/<service>/*`)
  pass through the gate untouched — third-party OAuth and JWKS-driven
  verification don't depend on admin onboarding. Once any admin exists,
  the gate is a no-op. The real wizard ships in hub#259.

`hub-server.ts` also gains a `/health` route (200 JSON with status +
service + version) that's been advertised in the issue but wasn't
actually wired before, plus env-aware `parseArgs` so `bun src/hub-server.ts`
works without any flags when `PORT` / `PARACHUTE_HUB_ORIGIN` /
`PARACHUTE_BIND_HOST` are set (the container path).

Gate: `bun test ./src` 1307 pass / 1 fail (same pre-existing
`status > all-healthy returns 0` env flake carried since 0.5.9-rc.8) /
30443 expects across 72 files. +19 over 0.5.9 (5 in `serve.test.ts`,
9 in `setup-gate.test.ts`, 5 incremental coverage in `hub-server.test.ts`).
typecheck clean. biome clean.

## [0.5.9] - 2026-05-17

Stable release. Promotes from `0.5.9-rc.9` after pre-stable polish + auth-hygiene
pass. Same code as rc.9; only the version suffix drops. Headline arc since
`0.5.7`:

- **Hub self-upgrade** (#251) — `parachute upgrade hub` now works. Operators on
  pre-0.5 installs (and anyone going forward) can keep current via the same
  dispatcher they already have, no manual `bun add -g @openparachute/hub` step.
- **Response shape consistency** (#227) — all 503 `!getDb` guards now return
  JSON `{error, error_description}` instead of the historical split between
  plain text and JSON. Client-side error parsers handle one shape.
- **Admin pagination canonical pattern** (#229) — `loadingMore` + `disabled`
  shape pinned in `web/ui/CLAUDE.md` as the convention for paginated admin
  views; new views adopt it directly.
- **Operator-token rotation telemetry** (#216) — `UsedOperatorToken.refreshed:
  boolean` replaced with a tagged `status: RotationStatus` discriminated union
  surfacing the three operationally distinct skip cases (`fresh` / `rotated` /
  `skipped: { aud-mismatch | no-sub | no-scope-set }`). No production caller
  read `.refreshed`; the `.rotated` companion field is unchanged.
- **Auto-rotation defense-in-depth** (#224) — refuses to rotate tokens lacking
  a recognized `pa_scope_set` claim instead of silently widening to admin
  scope. Closes a test-author footgun and a hypothetical scope-widening surface.
- **OAuth silent-approve regression pin** (#236) — end-to-end test walks the
  full "first-use consent → silent-approve → novel-scope re-prompts" state
  machine. JSDoc on `handleAuthorizeGet` documents the five-step flow and the
  two gate constraints.

**Coming from `@openparachute/cli@0.2.4`?** That package was renamed to
`@openparachute/hub` on 2026-04-26. Operators on the legacy package name should
`bun remove -g @openparachute/cli` then `bun add -g @openparachute/hub` to land
on this release. From 0.5.9 onward, `parachute upgrade hub` self-upgrades.

**Migration risk (rc.9 carrying over)**: operators holding operator-tokens
minted before hub#213 (~2026-05-09) may hit `skipped: no-scope-set` on the
rotation path. Recovery is the one-command `parachute auth rotate-operator`.
Risk surface bounded — pre-#213 tokens age out by ~2026-08-07 via the 90-day
default TTL.

## [0.5.9-rc.9] - 2026-05-16

Pre-stable auth hygiene bundle (closes #216, #224, #236).

**#216 — Disambiguate `UsedOperatorToken.refreshed` semantics.** The prior `refreshed: boolean` field on `useOperatorTokenWithAutoRotate`'s return value conflated three operationally distinct outcomes under a single `false` value: token is fresh, token is within window but rotation skipped by the audience guard, or token is within window but rotation skipped by a missing `sub` claim. Replace with a tagged union `status: RotationStatus = { kind: "fresh" } | { kind: "rotated" } | { kind: "skipped"; reason: "aud-mismatch" | "no-sub" | "no-scope-set" }`. No production caller read `.refreshed` (audited via grep — only test sites); the `rotated` companion field that callers actually branch on is unchanged. Future telemetry / admin UI (hub#212 Phase 2 territory) can branch on `skipped.reason`.

**#224 — Refuse to auto-rotate without a recognized `pa_scope_set` claim.** The audit traced a "test paradox" to its root: when a JWT carries `aud: operator` + short TTL but lacks (or has an unrecognized) `pa_scope_set` claim, the prior auto-rotation path silently widened it to the default scope-set (admin). No live operational risk — legitimately-issued operator tokens always carry the claim — but the widening surface was a defense-in-depth gap and a test-author footgun. Now returns `status: { kind: "skipped", reason: "no-scope-set" }` instead of widening; operators with a legacy or hand-crafted token without the claim must `parachute auth rotate-operator` to recover. A new "Test-author note" section in `useOperatorTokenWithAutoRotate`'s docstring spells out the two safe shapes for tests that stash JWTs at the operator path (long TTL or non-operator audience) so the pre-#222 + #222 trace doesn't re-surface.

**#236 — Pin OAuth silent-approve gate end-to-end + document flow.** The skip-consent gate in `handleAuthorizeGet` (the load-bearing piece of "first Notes use prompts for consent; subsequent uses are seamless") had per-branch tests but no single end-to-end test walking the operator-visible state machine. Add a "first-use consent → silent-approve → novel-scope re-prompts" regression test that exercises the full flow in one body: fresh state, consent screen, approve, second-use silent-approve, third-use with novel scope re-prompts. The novel-scope assertion is the security-critical leg — silent-approve must not silently approve scopes the user never consented to. Plus a JSDoc block on `handleAuthorizeGet` spelling out the five-step flow (first → silent → subset → novel → revoke), the two gate constraints (unnamed-vault verbs, client re-registration), and pointing at the regression test. Operator-facing prose (parachute.computer blog) is the site tentacle's territory.

Gate: `bun test ./src` 1286 pass / 1 fail (same pre-existing `status > all-healthy returns 0` env flake) / 30386 expects across 70 files. +2 tests over rc.8 (no-scope-set skip regression in operator-token; end-to-end silent-approve flow in oauth-handlers). typecheck clean. biome clean.

## [0.5.9-rc.8] - 2026-05-16

Pre-stable polish bundle (closes #227, #229, #219).

**#227 — Normalize 503 response shape across all `!getDb` guards.** The dispatch surface in `src/hub-server.ts` had two shapes for the same "hub is unconfigured" 503: plain-text bodies on older endpoints (`/oauth/*`, `/login`, `/vaults`, `/admin/host-admin-token`, `/api/grants/*`, `/api/oauth/clients/*`) and JSON `{error: "service_unavailable", error_description: …}` on newer ones (`/api/auth/*`, introduced in hub#215/#226). A consumer that gets a 503 from hub no longer has to branch on content-type to extract the message. New module-scope helper `dbNotConfigured()` is the single source of truth so future endpoints can't drift. Regression test (originally hub#139) was extended to hit every DB-dependent route and assert the JSON shape on each; the standalone `/oauth/authorize` 503 test also asserts the body.

**#229 — Pin "Load more" disabled-state as the canonical pagination pattern.** hub#228 introduced the `loadingMore` boolean + `disabled` attribute + early-return shape on Tokens.tsx's pagination button. This commit makes the pattern discoverable so future paginated admin surfaces (Permissions.tsx is the noted peer, currently unpaginated) don't reinvent. Three deltas: a new "Pagination convention" section in `web/ui/CLAUDE.md` spelling out the three ingredients and the failure mode they prevent; a canonical-pattern block comment on Tokens.tsx `loadMore`; a marker in Permissions.tsx's docstring under "Pagination:". No hook extraction — only one paginated surface today; defers to a future `useLoadMore` lift when a third consumer lands. F1 test in `Tokens.test.tsx` already pins the disabled-during-load behaviour; no new tests needed.

**#219 — Clarify CLAUDE.md test-count language for scope-guard.** The prior wording made `bun test ./src` canonical and called everything else "inflated," which ambiguated hub#217's review (reviewer cited a number including scope-guard; tentacle cited hub-only). Rewrite as a 3-row table — three invocations, three numbers, three when-to-cite cases. Default stays hub-only; cite as a pair (hub + scope-guard) when scope-guard is load-bearing in the PR. Explicit don't-cite on `bun test src` (no `./`) because Bun's path resolver pulls both suites in one run and exhibits cross-suite interference (12 errors in the combined run that don't reproduce in either suite alone).

Gate: `bun test ./src` 1284 pass / 1 fail (same pre-existing `status > all-healthy returns 0` env flake — reproduces on rc.7 with no diff applied) / 30369 expects across 70 files. +18 tests over rc.7 (every-route JSON 503 assertions; existing #139 cases extended with more endpoints). web/ui vitest 103 pass. typecheck clean. biome clean.

## [0.5.9-rc.7] - 2026-05-16

`parachute upgrade hub` now works — the dispatcher can self-upgrade (closes #251). Before this PR, `parachute upgrade hub` failed with `unknown service "hub". known: vault, notes, scribe, channel` because `resolveTargets` only consulted `FIRST_PARTY_FALLBACKS`, which deliberately excludes hub itself (hub isn't a fallback-registry entry — it's the dispatcher, and `FIRST_PARTY_FALLBACKS` is a transitional vendored-manifest fallback for committed-core modules per the workspace governance note). Users on a pre-0.5 install had no path back to current via the same dispatcher they already had; they had to `bun add -g @openparachute/hub@latest` by hand.

**Fix.** Special-case `hub` in `src/commands/upgrade.ts` `resolveTargets`:

- `parachute upgrade hub` synthesizes a `ResolvedTarget` keyed by the new `HUB_PACKAGE` constant (`@openparachute/hub`) exported from `hub-control.ts`. No services.json row is required (hub isn't in services.json); `findGlobalInstall("@openparachute/hub")` is the sole locate path and works the same for npm-installed and `bun link` checkouts.
- The sweep path (`parachute upgrade` with no arg) now upgrades hub first, then every services.json entry. Hub-first ordering avoids a downstream service restart racing the dispatcher swap mid-sweep. The empty-manifest path no longer errors — hub is always upgradeable, even on a fresh install where no other services exist.
- `unknown service` error message includes `hub` in the known list so the help is consistent with `parachute logs` (which has always accepted `hub`).

**Restart.** Reuses the existing `lifecycle.restart(HUB_SVC, …)` path, which routes through `startHubSvc` / `stopHubSvc` (the hub's own lifecycle seams via `ensureHubRunning` / `stopHub`). No new restart code; the CLI process running the upgrade is separate from the daemon being upgraded, so killing+respawning the daemon doesn't kill the in-flight upgrade flow.

**Help text.** `parachute upgrade --help` mentions hub explicitly + notes the closed issue.

Gate: `bun test ./src` 1284 pass / 1 fail (same pre-existing `status > all-healthy returns 0` env flake — reproduces on rc.6 with no diff applied) / 30302 expects across 70 files. +5 tests over rc.6 (hub-as-target npm path, empty-manifest hub upgrade, hub-as-target bun-linked path, hub --tag forwarding, sweep-includes-hub ordering; existing partial-failure sweep test updated to seed hub). typecheck clean. biome clean.

## [0.5.9-rc.6] - 2026-05-12

`/oauth/authorize`'s approve-pending UI (the page operators see when a DCR-registered client lands on the authorize endpoint before being approved) now surfaces the **vault hint** from the authorize URL (closes #244). Notes' VaultPopover (notes#115) passes `vault=<name>` on `/oauth/authorize` when kicking the OAuth flow for a specific vault; before this PR hub silently ignored it in the rendered page. On a multi-vault hub (4 vaults: boulder, default, gitcoin, techne) the operator had no way to tell which vault they were approving for. Single-vault hubs unaffected — the row omits when the hint is absent.

Surface: `ApprovePendingViewProps` in `src/oauth-ui.ts` gets a new optional `requestedVault?: string` field. `renderApprovePending` renders a `vault: <name>` row in the existing `approve-meta` section, between `client_id` and `redirect_uris`, when the field is set. `handleAuthorizeGet` in `src/oauth-handlers.ts` reads the `vault` query param from the authorize URL and threads it through to both `renderApprovePending` call sites (with-session inline-form path + no-session CLI-only path). Empty-string `vault=` values normalize to undefined so the UI never renders a blank label.

Gate: `bun test ./src` 1279 pass / 1 fail (same pre-existing env flake) / 30288 expects across 70 files. +2 tests over rc.5 (with-vault-hint render, empty-string-param normalize). typecheck clean. biome clean.

## [0.5.9-rc.5] - 2026-05-12

Cookie-based POST endpoints (`/oauth/authorize/approve`, `/oauth/register` auto-approve, the DCR auto-approve path) now accept requests from any **hub-bound origin**, not just the configured `issuer` URL (closes #245). Previously, an operator hitting hub admin at `http://localhost:1939/login` then submitting the approve form got "Cross-origin request rejected" because Origin (loopback) didn't match issuer (tailnet). Same failure mode for tailnet→tailnet flows where Tailscale Serve stripped the Origin/Referer headers — the strict check returned false and 403'd a legitimate operator path.

**Bound-origin set.** Hub now considers itself bound to:

1. The configured `issuer` URL (current behavior; always included).
2. Loopback aliases on hub's listen port (`http://localhost:<port>`, `http://127.0.0.1:<port>`).
3. The `hubOrigin` from `expose-state.json` if set (typically the tailnet/funnel hostname after `parachute expose`; read per-request so a post-start expose is reflected without restart).

Any Origin/Referer matching one of these is accepted; everything else rejected. URL.origin comparison preserves scheme + host + port strictness — a request from `http://localhost:1940` (different port) still rejects, as does `https://localhost:1939` (scheme mismatch).

**Header-stripped fallback.** When both Origin AND Referer are absent (Tailscale Serve / reverse-proxy edge case), the check falls back to the request's `Host` header against the host:port of each bound origin. Host is browser-controlled but reflects "what the browser thought it was talking to"; matching it against a bound origin preserves the same-origin signal in legitimate proxy-stripped flows without weakening the gate for actual third-party attackers (the CSRF token + SameSite=Lax session cookie remain the real auth defense — the Origin check is a belt-on-suspenders layer).

**Surface.** New module `src/origin-check.ts` exporting `buildHubBoundOrigins({issuer, loopbackPort?, exposeHubOrigin?})` and `isSameOriginRequest(req, boundOrigins)`. `OAuthDeps` gets a new optional `hubBoundOrigins?: () => readonly string[]` field; production threads it from `hub-server.ts` `hubFetch`. Three call sites updated (`handleAuthorizeGet`, `handleApproveClientPost`, `handleRegister`); all retain previous behavior when `hubBoundOrigins` isn't provided (fallback to `[issuer]`) so tests + downstream consumers stay correct on single-origin hubs.

**Rename.** Internal helper `originMatchesIssuer` → `isSameOriginRequest` — the name now matches what it does (matches against a bound-origin set, not just the issuer). Two doc-comment references in `oauth-handlers.ts` and two test comments in `oauth-handlers.test.ts` updated.

**Defense semantics preserved.** Real third-party origins still reject. Pre-#245 callers without the new dep stay on issuer-only behavior. Empty bound-origin set fails closed (rejects everything).

Gate: `bun test ./src` 1277 pass / 1 fail (pre-existing env flake — same as previous rcs) / 30280 expects across 70 files. +24 tests over rc.4 (origin-check coverage). typecheck clean. biome clean.

## [0.5.9-rc.4] - 2026-05-12

`buildServicesCatalog` (the helper that populates the `services` map in `/oauth/token` responses) now emits **per-vault `vault:<name>` keys** alongside the legacy collapsed `vault` key when there are multiple vaults to disambiguate (closes #247).

**Motivation.** Notes' multi-vault popover (notes#115) shipped, and the deferred Phase 2 work from `buildServicesCatalog`'s docstring is now blocking real use. On Aaron's 4-vault hub (default + boulder + gitcoin + techne), every connect-vault flow in Notes was getting the same `services.vault.url = /vault/default` regardless of which vault the OAuth grant actually narrowed to — so multiple VaultRecords collided in Notes' store (vaultId is URL-derived) and only one entry showed in Manage Vaults despite multiple OAuth grants.

**What changed.** When the token's scopes admit a single vault on a single-vault hub, the catalog is unchanged — `services.vault.url` only. When the token's scopes narrow to a specific vault (`vault:boulder:write`) or when multiple vaults are admitted on a multi-vault hub, per-vault keys are added:

```json
{
  "services": {
    "vault": { "url": "https://hub.example/vault/default", "version": "0.4.4" },
    "vault:default": { "url": "https://hub.example/vault/default", "version": "0.4.4" },
    "vault:boulder": { "url": "https://hub.example/vault/boulder", "version": "0.4.4" },
    "vault:gitcoin": { "url": "https://hub.example/vault/gitcoin", "version": "0.4.4" },
    "vault:techne":  { "url": "https://hub.example/vault/techne",  "version": "0.4.4" }
  }
}
```

**Backwards compat.** The collapsed `vault` key is never removed — pre-popover clients keep working without changes. Per-vault keys are purely additive. On a per-vault-narrowed token (e.g. `vault:boulder:write`), the collapsed `vault` key points at the only admitted vault (boulder), so legacy single-vault clients on a multi-vault hub happen to land on the correctly-scoped URL too.

**Emit rule.** Per-vault keys fire when (a) there are >1 admitted vault paths to disambiguate, OR (b) the token carries any per-vault-narrowed scope (`vault:<name>:<verb>`). The latter is an explicit consumer signal that the per-vault key matters even on single-vault hubs — so a Notes consumer reading `services["vault:default"]` works uniformly regardless of hub vault count.

Both manifest shapes for multi-vault are handled: the modern single-row-multi-path layout (`parachute-vault` with `paths: ["/vault/default", "/vault/boulder", ...]` — what Aaron's hub uses) and the legacy per-vault-row layout (`parachute-vault-<name>` rows).

**Notes-side follow-up (separate PR).** `OAuthCallback` in `parachute-notes` will be updated to prefer `token.services?.["vault:<name>"]?.url` over `token.services?.vault?.url` when the token's `vault` claim is set. That change lands after this PR merges and the next `@openparachute/hub` is on npm; tracked as a Notes-side issue.

Gate: `bun test ./src` 1253 pass / 1 fail (pre-existing env flake — same as rc.3) / 30250 expects across 69 files. +8 tests over rc.3 (multi-vault catalog coverage). typecheck clean. biome clean.

## [0.5.9-rc.3] - 2026-05-12

`parachute status` now reveals **where each service is running from** alongside the version/health columns (closes #243). The new `SOURCE` column classifies each row as either `bun-linked → <basename> @ <git-short-sha>` (the operator has a local checkout `bun link`'d in) or `npm (<version>)` (installed from a published package under bun globals). For bun-linked rows where `services.json`'s cached `version` lags the live `package.json` at the checkout, a `STALE: services.json cached <X>; live package.json <Y>` continuation line surfaces beneath the row.

Motivation: 2026-05-11 the operator spent ~30 minutes chasing a stale `parachute-notes 0.3.11-rc.1` in `parachute status` while the actual served bundle was the freshly-built 0.3.15-rc.1. Three separate steps were needed to diagnose: check `parachute status`, check the local `package.json`, check `~/.parachute/services.json`. Now the drift is visible at a glance.

Implementation: new pure helper module `src/install-source.ts` with full test-seam coverage (`bunGlobalPrefixes`, `resolveBunGlobal`, `readJson`, `readGitHead` all injectable). `src/commands/status.ts` calls `detectInstallSource` per row and `detectHubInstallSource` for the internal hub row, and renders the new column + STALE continuation line. No network. Single optional `git rev-parse --short HEAD` shell-out per bun-linked row, with a 1.5s timeout — failures degrade silently to "no SHA" rather than blocking status. The hub itself is classified the same way as the services it manages, by climbing from `import.meta.dir` to the nearest `package.json`.

Out of scope (separate follow-up): fixing `parachute upgrade` so it refreshes the cached `services.json.version` on bun-linked rebuild. The STALE indicator surfaces the drift; the upgrade path that creates it is a separate issue.

Gate: `bun test ./src` ran 1246 tests across 69 files / 30242 expects. Pass/fail varies by environment because the existing `status > all-healthy returns 0 and prints table` test reads the real `~/.parachute/` configDir rather than isolating to its temp dir (pre-existing, present on `main` — reproduced via `git stash`). Clean envs see 1246 pass / 0 fail; envs with a stale `~/.parachute/scribe/run/scribe.pid` (operator PID file pointing at a no-longer-running process) see 1245 pass / 1 fail because `processState` returns `stopped` and skips the scribe probe. Worth a follow-up to isolate the test's configDir, but unrelated to this change. typecheck clean. biome clean.

## [0.5.9-rc.2] - 2026-05-11

Post-Pass-1 cleanup (#240 follow-up). Two cohesive changes:

1. **`admin-config-ui.ts` → `admin-login-ui.ts` rename (closes #241).** #240 retired the legacy `/admin/config` server-rendered portal and trimmed this file from 534 → 257 LOC; what's left is `renderAdminLogin` + `renderAdminError` + shared chrome. The filename now matches the content. Mechanical rename: single importer (`src/admin-handlers.ts`) updated; cross-file docstring references in `web/ui/CLAUDE.md` and `web/ui/src/styles.css` refreshed; the file's own preamble rewritten to drop the stale "config portal lived here" history (kept a one-line note pointing at #240 + #241 for archeology).

2. **`## Architecture surfaces` table added to `parachute-hub/CLAUDE.md`.** Pass 2 audit confirmed the hub's HTTP surface area is structurally coherent post-#240 — six distinct layers (discovery / login / SPA / OAuth / API / well-known), each matched to its audience's constraints. The table is the at-a-glance reference; the route-by-route detail stays in `src/hub-server.ts`'s header docstring (the executable source of truth). Lets future tentacles + reviewers orient without reverse-engineering the dispatcher.

## [0.5.9-rc.1] - 2026-05-11

Integration-debt cleanup after the SPA-rework chain that landed 2026-05-10 (#233 admin SPA mount, #234 `/login` rename, #235 signed-in indicator, #237 token UI). The rework migrated three admin surfaces (vaults/permissions/tokens) into the SPA but left two legacy server-rendered admin pages dangling; this PR closes the immediate friction.

1. **Post-login default lands in the SPA, not the legacy portal.** `safeNext` in `admin-handlers.ts` now defaults to `/admin/vaults` (the SPA home). Previously the missing-/unsafe-`next=` fallback was `/admin/config`, which post-rework was a half-built page showing an empty state because no module declares a `configSchema`. The default is now named (`POST_LOGIN_DEFAULT`) so the meaning is explicit.

2. **Legacy `/admin/config` server-rendered portal retired.** `src/admin-config.ts` (module discovery + JSON config read/write) deleted; `src/admin-config-ui.ts` trimmed to just the still-load-bearing login + error rendering; the corresponding GET/POST handlers in `src/admin-handlers.ts` dropped. The hub still listens at `/admin/config` and `/admin/config/<name>` but returns 301 → `/admin/vaults` so any bookmark or stale post-login redirect lands somewhere useful. The module-config surface as designed in #46 didn't gain a configSchema-declaring module before the SPA rework subsumed the page; the right shape going forward is a per-module SPA + module.json `uiUrl` (already implemented in agent, scribe to follow). The deletion frees ~760 LOC (220 admin-config.ts + 277 admin-config-ui.ts + 230 admin-handlers.ts + 281 admin-config tests) plus removes the dev-proxy entry in `web/ui/vite.config.ts`.

3. **OAuth pending-approval inline UX.** Hub's `/oauth/token` response for pending DCR clients (`pendingClientJson`) now carries two new fields alongside the spec-shaped `error: "invalid_client"`:

   - `approve_url` — hub-served SPA deep link to `/admin/approve-client/<client_id>` so the operator can approve from a browser without dropping to a terminal.
   - `cli_alternative` — the `parachute auth approve-client <id>` shell command, retained for terminal-first operators.

   New SPA route `/admin/approve-client/:clientId` (in `web/ui/src/routes/ApproveClient.tsx`) fetches client details, renders name + redirect_uris + requested scopes + a registered-at timestamp, and exposes a single Approve button. Two new bearer-gated admin endpoints back it: `GET /api/oauth/clients/:id` (details) and `POST /api/oauth/clients/:id/approve` (idempotent flip to approved, emits an audit log line `client approved: client_id=… approver_sub=…` on actual state change). The pre-existing `POST /oauth/authorize/approve` endpoint is untouched — it stays tightly coupled to the authorize-flow `return_to` shape and serves the inline same-origin approve form in `/oauth/authorize`'s HTML response; the new endpoints solve the deep-link case it couldn't.

   The spec error class stays `invalid_client` per RFC 6749 §5.2 — that's the right semantic for "this client cannot use this endpoint right now"; `access_denied` is reserved for `/authorize` "user said no" flows.

   Notes-side surfacing of `approve_url` (rendering it as a clickable link instead of the CLI message) is a separate follow-up dispatch.

## [0.5.8] - 2026-05-10

Promotes the 0.5.8-rc cycle (rc.1 through rc.16, all landed 2026-05-09 / 2026-05-10) to stable. Hub#212 (the multi-phase migration toward hub-as-sole-AS) lands Phases 1, 2, and Phase 4's hub-side foundation; an end-to-end auth UX cleanup pathway (A through F) makes the resulting surface coherent for operators. Five themes:

1. **Token registry + mint API + revocation list endpoint (hub#212 Phase 1).** `tokens` table v6 generalizes the OAuth-refresh-only registry into a unified row-per-issued-JWT shape with `permissions` (JSON), `created_via` (`oauth_refresh` / `cli_mint` / `operator_mint`), and `subject` for non-user mints. New endpoints: `POST /api/auth/mint-token` (HTTP companion to `parachute auth mint-token`), `POST /api/auth/revoke-token` (HTTP companion to the new `revoke-token` CLI), `GET /api/auth/tokens` (cursor-paginated list with `?revoked=` / `?subject=` / `?created_via=` filters), `GET /.well-known/parachute-revocation.json` (public revocation list, 60s cache). Operator-token mints and OAuth-refresh signs both write registry rows now, so revocation is uniform across mint paths.

2. **`/admin/tokens` admin UI (hub#212 Phase 2).** Browser surface for the registry: list (status pills, `created_via` source pills, per-row source chips, cursor pagination), mint (inline form with one-time JWT reveal banner), revoke (per-row confirm flow). Composes the two filter dimensions (status × source) with URL-backed state so refresh + share preserve the operator's view.

3. **Phase 4 hub-side foundation.** `@openparachute/scope-guard` 0.2.0 adds revocation-list enforcement to `validateHubJwt` (new `HubJwtErrorCode` values: `"revoked"`, `"revocation_unavailable"`); 0.2.1 fixes NodeNext-strict packaging for downstream consumers (agent's tsc + vitest). Vault, scribe, and parachute-agent adopt independently in their own PRs once these scope-guard versions are on npm.

4. **Operator-token hardening (hub#213).** Default operator-token lifetime drops 365d → 90d. Opportunistic auto-rotation on use: when the local operator token is within 7d of expiry AND has `aud: "operator"` (privilege-escalation guard), `useOperatorTokenWithAutoRotate` re-mints with the same scope-set + a fresh 90d expiry. New `--scope-set <set>` flag on `rotate-operator` mints narrowed operator tokens (`install` / `start` / `expose` / `auth` / `vault` / `admin`); the chosen set rides on a `pa_scope_set` claim so auto-rotation preserves the narrowing. `writeOperatorTokenFile` forces 0600 post-rename; `readOperatorTokenFile` warns when the file is group-/world-readable. CLI mint-token gate aligned to `parachute:host:auth` (matching the HTTP endpoint and the new `revoke-token` CLI) so the `auth` scope-set is finally sufficient.

5. **Auth UX cleanup pathway (A–F).**
   - **A** — Discovery-page sections relabeled `Use` → `Services`, with per-service tightened labels and an ownership-axis sub-text ("Surfaces provided by services running on this hub.").
   - **B** — Login surface rename: `/admin/login` → `/login`, `/admin/logout` → `/logout`. 301 redirects from the old paths preserve `?next=` for OAuth flows and bookmarks.
   - **C** — Signed-in indicator on hub-served surfaces. New `GET /api/me` returns session identity + per-session CSRF (reused from the existing cookie or freshly minted with Set-Cookie). Discovery page renders server-side; admin SPA hydrates via `useEffect`. Both consume one mental model.
   - **D** — `module.json:uiUrl` pattern (cross-repo with patterns#52, notes#109, paraclaw#152). Discovery page Services tiles render dynamically from each service's `installDir/.parachute/module.json:uiUrl` via a new `loadServiceUiMetadata` mirroring the existing `loadManagementUrls`. `SERVICE_LABELS` / `SERVICE_ORDER` / `isVaultName` retired. No services.json schema change — read at request time so service-boot `upsertService` overwrites can't clobber it (the C-not-B trace lives in the `loadServiceUiMetadata` docstring).
   - **E** — Silent-approve validation for cross-surface OAuth flow smoothness; pinned the regression in hub#236.
   - **F** — `/admin/tokens` token list grouping by `created_via`: dual filter pills (status × source) + per-row source chips (OAuth / Operator / CLI mint).

### Security

- **`asPathOrUrl` rejects protocol-relative paths** (`//evil.com`) for both `uiUrl` and `managementUrl`. Previously the path branch accepted any string starting with `/`, but `new URL("//evil.com", base)` resolves to the foreign origin — a malicious third-party `module.json` could turn a discovery tile into an off-origin redirect. Regression tests pin both fields since they share the helper.
- **`/api/auth/mint-token`, `/api/auth/revoke-token`, `/api/auth/tokens` all gate on `parachute:host:auth`.** The `admin` scope-set carries it as a superset; the narrow `--scope-set auth` operator token carries it directly. `HOST_ADMIN_SCOPES` (the SPA's session-bearer mint) extended to include `parachute:host:auth` so the SPA hits the registry endpoints without falling back to operator tokens.

### Operator impact / migration

- **v6 `tokens` migration runs automatically on next `openHubDb()`.** Existing OAuth refresh-token rows backfill `created_via='oauth_refresh'`; their `permissions` and `subject` stay NULL. Pre-Phase-1 access tokens (15-min default TTL) drain within an hour of deploy. Pre-existing operator tokens stay valid; the next `rotate-operator` (or auto-rotation) registers the new token.
- **Pre-rename `/admin/login` and `/admin/logout` URLs 301-redirect** to `/login` / `/logout` with `?next=` preserved. No operator action required.
- **No re-install required for downstream services to surface in Discovery** — the moment notes / agent ship `module.json:uiUrl` (already done in notes#109 and paraclaw#152), the next discovery refresh picks up the new tiles.
- **`--ttl` on `parachute auth mint-token` is now deprecated** in favor of `--expires-in <integer-seconds>`. `--ttl` still works (with a stderr deprecation notice) until 0.6.0.

### Out of scope (deferred)

- **Phase 6 — `pvt_*` deprecation in vault.** Vault-side; gated on Aaron's explicit go-ahead.
- **Per-CLI-command scope-set enforcement** (the second half of hub#213) — separate followup so a `--scope-set install` operator token can't, say, run `parachute expose public`.
- **Admin UI bulk-revoke** (`--all-by-subject`, `--all-by-client`).

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
