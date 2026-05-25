# Changelog

All notable changes to `@openparachute/hub` are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) loosely; versions follow [SemVer](https://semver.org/) with the pre-1.0 RC governance described in [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md).

## [0.5.13-rc.40] - 2026-05-25

**fix(hub) + feat(hub): OAuth approve POST same-origin hotfix (hub#375) + unify state vocabulary across CLI + admin SPA + well-known doc (workstream F, hub#374).**

### Fixed (hub#375 hotfix)

- **OAuth approve POST no longer rejects from the public Render URL when `hub_settings.hub_origin` is stale.** The same-origin gate at `handleApproveClientPost` builds its bound-origin set from `deps.issuer` via `resolveIssuer`, whose precedence is `hub_settings.hub_origin` > `PARACHUTE_HUB_ORIGIN` > request-derived. If an operator stored `hub_origin` to a non-public URL (e.g. a loopback value entered during initial setup via the admin SPA), the bound set excluded the public Render URL — the browser POST from `https://<svc>.onrender.com` got rejected with `Cross-origin request rejected`. Fix: `buildHubBoundOrigins` now accepts an optional `platformOrigin` and `hub-server.ts` passes `process.env.RENDER_EXTERNAL_URL`. The platform-injected URL is trusted independently, so a stale stored config can't lock the operator out of cookie-POST flows arriving from the public URL. Added a diagnostic `console.warn` on same-origin failure logging Origin/Referer/Host/X-Forwarded-Host/X-Forwarded-Proto + the bound set — future opaque rejections leave a trail in Render logs.

### Workstream F — state vocab unification (hub#374)

**feat(hub): unify state vocabulary across CLI + admin SPA + well-known doc.**

The 2026-05-25 UX audit (§2.3, §2.7) flagged three different vocabularies for the same module-supervisor concept: CLI said `running` / `stopped` / `-`; admin SPA said `Active` / `Pending-OAuth` / `Disabled`; the supervisor's internal state model said `active` / `pending-oauth` / `disabled`. Workstream F aligns every user-facing surface on the four canonical states from [parachute-patterns/patterns/design-system.md §6](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/design-system.md): `active` / `pending` / `inactive` / `failing`.

Wire shapes are stable. The mapping happens at the emit-time site: `services-manifest.ts` normalizes pre-F values (`pending-oauth`, `disabled`) to canonical on read, and the SPA + CLI render-time helpers map supervisor lifecycle states (`running`, `starting`, etc.) onto the rollup vocabulary.

### Changed

- **`parachute status` columns** (`src/commands/status.ts`, `src/help.ts`). Pre-F: `SERVICE PORT VERSION PROCESS PID UPTIME HEALTH LATENCY SOURCE` — `PROCESS` (`running` / `stopped` / `-`) and `HEALTH` (`ok` / `down` / `http <code>`) encoded the same rollup in two columns. Post-F: `SERVICE PORT VERSION STATE PID UPTIME LATENCY SOURCE` — single `STATE` column with one of `active` / `pending` / `inactive` / `failing`. Probe-failure detail (`http 503`, `ECONNREFUSED`) survives on a continuation line (`  ! probe: <detail>`) so operators don't lose the diagnosis.

- **Admin SPA `/admin/modules` status badges** (`web/ui/src/routes/Modules.tsx`, `web/ui/src/styles.css`). Both the module-row supervisor badge and the per-UI sub-unit badge now render the four canonical states. New CSS classes `.status-active`, `.status-pending`, `.status-inactive`, `.status-failing`. Module-row label is now the rollup state (e.g. `active`) rather than the raw supervisor status (`running`). New `web/ui/src/lib/state.ts` houses the supervisor → unified-state mapping in one place.

- **`UiSubUnitStatus` (services.json + wire)** (`src/services-manifest.ts`, `src/__tests__/services-manifest.test.ts`). Canonical values are now `active` / `pending` / `inactive` / `failing`. Pre-F values (`pending-oauth`, `disabled`) are still accepted on read and normalized to canonical so downstream emit surfaces (well-known doc, `/api/modules`) always see the new vocab. New tests pin the normalization boundary in `services-manifest.test.ts` and end-to-end through `/api/modules` in `api-modules.test.ts`.

### Back-compat (retire one rc-chain after this lands)

- **CSS class aliases**: `.status-pending-oauth` and `.status-disabled` continue to paint correctly (mirror the colors of `.status-pending` and `.status-inactive` respectively) so any out-of-tree consumer still rendering legacy class names doesn't lose its palette during the cutover.
- **services-manifest input aliases**: `pending-oauth` / `disabled` accepted on read; normalized to canonical before persisting.
- **SPA render-time alias**: `unifiedStateForUi` accepts legacy values so a stale row served before the storage normalizer fold doesn't get an unstyled badge.

### Patterns check

- Adopts [parachute-patterns/patterns/design-system.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/design-system.md) §6 (state vocabulary) and §7 (status badge component).
- Companion adoption in vault/app/scribe/runner SDKs is a follow-up — they may continue emitting legacy values for one release cycle (hub normalizes at the storage boundary).

### Verification

- `bun run typecheck` clean (server + web/ui).
- `bun test ./src`: 1962 pass / 0 fail (3 new tests).
- `bun run test` (web/ui): 213 pass / 0 fail (2 new tests).
- No version bump per governance Rule 2 — collects into the next rc-chain ship decision.

## [0.5.13-rc.39] - 2026-05-25

**feat(hub): well-known fan-out reads vault's declared uiUrl + retires the hardcoded Browse Vault tile + `/admin/approve-client` supports OAuth resume (workstreams C/4 + D).**

Two coupled changes from the 2026-05-25 UX audit. Both are hub-side; the vault declaration and patterns docs ship in parallel (vault@0.4.8-rc.9, patterns#96/#97 merged).

### Added

- **Vault uiUrl fan-out** (hub#371, workstream C/4). `loadServiceUiMetadata` no longer skips vault entries; `buildWellKnown` applies the per-instance mount-path prefix (`/vault/<name>` + vault's declared `/admin/` = `/vault/<name>/admin/`) so each vault gets its own discovery tile via the well-known doc, data-driven rather than hardcoded. Includes a defensive guard that warns + skips emission when a vault uiUrl is missing the required leading slash. Three new unit tests pin single-instance prefix, multi-path fan-out, and absolute-URL pass-through.

- **`/admin/approve-client/<id>` supports OAuth resume via `?return_to=<authorize-url>`** (hub#372, workstream D). The SPA approve route now accepts an optional `return_to` query param (same-origin gated). On successful approve, the server echoes `redirect_to` and the SPA `window.location.assign`s back into the parked OAuth flow. Without `return_to`, the route preserves the existing "you may now return to your app" success state for the legitimate share-with-another-admin case. The audit's "two surfaces, one route" model documented in [patterns/oauth-dcr-approval.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/oauth-dcr-approval.md). No callsite is changed today — D opens the seam for future flows.

### Removed

- **Hardcoded "Browse Vault" tile in `renderGetStarted`** (hub#371). The tile added in hub#342 is now redundant — hub's Services section renders vault's admin entry per-vault automatically via the well-known-driven path. The home page's data-driven shape now scales to any future installed module that declares uiUrl.

### Patterns check

- Adopts [patterns/module-ui-declaration.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/module-ui-declaration.md)'s multi-instance form for vault.
- Implements the resume-affordance side of [patterns/oauth-dcr-approval.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/oauth-dcr-approval.md)'s "two cases, one route" model.

### Verification

- `bun run typecheck` clean (server + web/ui).
- `bun test ./src`: 1958 pass / 0 fail.
- `bun run test` (web/ui): 211 pass / 0 fail.
- Container smoke CI: ✓ on both fix commits.
- Pending: live verify on Render redeploy + workstream B's app rc.13 + vault rc.9 + scribe rc.8 installed via wizard upgrade.

## [0.5.13-rc.38] - 2026-05-25

**fix(hub): unauthenticated OAuth approve CTA preserves the in-flight authorize URL through login — closes the MCP-OAuth dead-end loop.**

The next bug Aaron hit after rc.37 unstuck the home page: linking a new vault to Claude via MCP showed "App not yet approved", he approved on the SPA, got "Approved. Return to the app and retry" — but never got redirected back to Claude. Returning to Claude and retrying re-showed the approval prompt (loop). Root cause: when the operator wasn't already signed in on the hub origin, the "App not yet approved" page's CTA pointed at `/login?next=/admin/approve-client/<id>`. After login the user landed on the SPA approve route, which discarded the original `/oauth/authorize?<params>` URL — so the OAuth flow never resumed and the `redirect_uri` callback to Claude never fired.

### Fixed

- **Unauthenticated approve CTA now preserves the full OAuth flow context** (hub#369). `pendingClientResponse` (`src/oauth-handlers.ts`) hoists `returnTo = ${authorizeUrl.pathname}${authorizeUrl.search}` out of the authed-only branch and passes it as `loginNextUrl` to `renderApprovePending` for both branches. `renderUnauthenticatedApproveCtas` (`src/oauth-ui.ts`) now builds `loginHref = /login?next=${encodeURIComponent(loginNextUrl)}`. After login the user lands back on the original `/oauth/authorize` URL (now signed in, same-origin), the inline "Approve and continue" form renders, one click triggers `approveClient` + 302 back to the same URL, status is now `approved`, the flow proceeds through consent → `redirect_uri` callback to Claude. The shareable deep link continues to point at `/admin/approve-client/<id>` for the share-with-another-admin path (no in-flight OAuth flow to resume there).

### Patterns check

- Reinforces the round-trip invariant: any flow that detours through `/login` must carry its return target as `?next=` (same-origin gated via `safeNext` in `src/admin-handlers.ts:63`). The authed branch already did this since #208; the unauth branch was the gap.
- No new pattern; doesn't touch a pattern boundary.

### Verification

- `bun run typecheck` clean.
- `bun test ./src`: 1946 pass / 0 fail (+1 from rc.37 — new round-trip assertion in `oauth-ui.test.ts` + regression guard in `oauth-handlers.test.ts`).
- Container smoke CI: ✓ on the fix commit.
- Live verify pending on Render redeploy after rc.38 publishes.

## [0.5.13-rc.37] - 2026-05-25

**fix(hub): home page Get Started + Services + Admin all broken by a SyntaxError in the inline `<script>`.**

(rc.36 never published — `noUncheckedIndexedAccess` typecheck failure on the new regression test caught by release CI. rc.37 fixes the typecheck and is the published rollup.)

After rc.35 landed and the iss-mismatch unstuck the wizard install, the home page at `/` rendered with the Services section stuck at "Loading…" and the Admin section empty. Root cause: a single regex literal inside the IIFE — `/\/+$/` — silently degenerated to `//+$/` in the served HTML, because `\/` inside `HTML_TEMPLATE`'s backtick template literal collapses to `/`. The browser parsed the leading `//` as a line comment, the rest of the regex bled into the comment, the IIFE never executed, and `renderAdmin()` + `renderServices()` + `renderGetStarted()` all silently failed.

### Fixed

- **Home page IIFE no longer breaks at parse time** (hub#366). Switched the regex to a `/[/]+$/` character class — forward-slash inside `[]` needs no escape, so the template literal preserves it intact. Same semantics, no escaping surface. Latent since hub#342 introduced the `renderGetStarted` vault-path slicing (every other regex in the script is escape-free, so this was the first regex to need a forward-slash escape; the bug only surfaced once a vault was installed and the path branch executed).

### Added

- **Inline `<script>` parse-check regression test** (hub#366). `hub.test.ts` now extracts the rendered `<script>` body and parse-checks it with `new Function(scriptBody)`. Content assertions pass on the broken HTML because they only check substrings; only a parse-check catches the SyntaxError that breaks the browser at runtime. Catches any future template-escaping bug at test time.

### Patterns check

- Reinforces "test the bytes you ship": content/snapshot assertions miss execution-level bugs in inline scripts/CSS/template-served code. A parse-check or behavioral test is the right shape when serving executable code from a template literal.

### Verification

- `bun run typecheck` clean.
- `bun test ./src`: 1945 pass / 0 fail (+1 from rc.35).
- Container smoke CI: ✓ on `ac09e17`.
- Live verify pending on Render redeploy after rc.37 publishes.

## [0.5.13-rc.35] - 2026-05-25

**fix(hub): Render-injected `RENDER_EXTERNAL_URL` now auto-detected as OAuth issuer + propagates to supervised modules — fixes `unexpected "iss" claim value` after wizard install.**

The next bug Aaron hit after rc.34's chain landed: wizard install completed, then the first authed call to vault returned `401: hub JWT verification failed: unexpected "iss" claim value`. Hub minted JWTs with the public Render URL as `iss`; vault's `validateHubJwt` compared against `process.env.PARACHUTE_HUB_ORIGIN` (unset on the spawned child) and fell back to `http://127.0.0.1:1939` — mismatch, reject.

### Fixed

- **Hub auto-detects `RENDER_EXTERNAL_URL` at boot when no explicit issuer is configured** (hub#365). New `resolveStartupIssuer` helper in `commands/serve.ts` formalizes the precedence: `--issuer` flag > `PARACHUTE_HUB_ORIGIN` env > `RENDER_EXTERNAL_URL` env > undefined. Trailing slashes stripped; empty / bare-slash values collapse to undefined. Same precedence mirrored into `hub-server.ts`'s standalone-entrypoint `parseArgs` (the alternate boot path advertised by the Dockerfile comment), so both entry points behave identically on Render.

- **Supervised modules now inherit `PARACHUTE_HUB_ORIGIN` from `deps.issuer`** (hub#365). `spawnSupervised` in `api-modules-ops.ts` (the install/restart spawn path) was missing this env-var propagation — siblings at the boot path (`bootSupervisedModules`) and lifecycle path (`lifecycle.start`) already had it from prior hub#357. Now all three spawn sites are symmetric: child vault/scribe/app processes see the same issuer string the hub itself uses to mint JWTs, so the `iss` claim round-trips correctly.

### Patterns check

- Reinforces the `bun-container-deploy.md` pattern (rc.34): platform-injected env vars (`PORT`, `RENDER_EXTERNAL_URL`, `X-Forwarded-*`) all need explicit propagation/derivation discipline. This is the third such gotcha in the chain (PORT → X-Forwarded-Host → iss origin); each one slipped past the others.
- No new patterns introduced.

### Verification

- `bun run typecheck` clean.
- `bun test ./src`: 1944 pass / 0 fail (+12 from rc.34 — 6 `resolveStartupIssuer` precedence tests in serve.test.ts, 1 `runInstall` propagation regression in api-modules-ops.test.ts, 5 `parseArgs` precedence tests in hub-server.test.ts).
- Container smoke CI: ✓ on `3ccddf8`.
- Operator workaround for pre-rc.35 deploys: set `PARACHUTE_HUB_ORIGIN` to the public URL in Render's Environment tab. After rc.35 picks up automatically — no manual config needed for the default Render path.

## [0.5.13-rc.34] - 2026-05-24

**fix(hub): Render container deploy now fully functional end-to-end + tag-triggered release CI.**

The rc.29 → rc.34 chain closed the remaining bugs surfaced by live SSH-in-Render-deploy debugging (each fix unblocked the next reachable bug). Versions rc.29–rc.33 never published to npm (some were CI failures, others were intermediate work under the old "every PR bumps rc.N" policy). rc.34 is the published rollup.

### Fixed

- **`/parachute/modules` ownership bug** (hub#355). After all the env-var fixes shipped in rc.28, the wizard install STILL failed with `error: An internal error occurred (AccessDenied)`. Root cause via live SSH: docker-entrypoint.sh ran `mkdir -p /parachute/modules/bin` AS ROOT, creating `/parachute/modules/` parent dir as root-owned. The subsequent `chown -R bun:bun /parachute/modules/bin` only fixed the leaf. The parent stayed `drwxr-sr-x root:bun` permanently. Bun-user couldn't create `/parachute/modules/install/` → AccessDenied. Fix: drop the conditional chown shortcut; always `chown -R bun:bun /parachute/tmp /parachute/modules` on every start.

- **OAuth discovery published `http://` URLs over HTTPS** (hub#355). The notes app's `/oauth/register` call was blocked by browser Mixed Content because hub's discovery doc carried `http://parachute-hub.onrender.com/...` even though the page loaded over HTTPS. Render terminates TLS at the edge and forwards plain HTTP to hub; `req.url.origin` was `http://`. Fix: `resolveIssuer` now uses the existing `isHttpsRequest()` helper (which honors `X-Forwarded-Proto`) and upgrades the URL scheme to https when appropriate.

- **Supervised modules inherited hub's PORT** (hub#356, hub#357). Once the wizard install completed for the first time, vault crashed immediately with `EADDRINUSE on port 1939` (hub's port). Render injects `PORT=1939` into the container env; Bun.spawn's `env: process.env` propagates that PORT to every supervised child. Vault reads `process.env.PORT` first → tries to bind hub's port. Fix: explicit `PORT: String(entry.port)` injection at all three spawn sites — `spawnSupervised`, `lifecycle.start`, `bootSupervisedModules`. Scribe was affected too; app + runner ignored PORT and escaped by coincidence.

- **Reverse proxy didn't forward `X-Forwarded-*` to children** (hub#358). After all PORT fixes landed, vault's OAuth metadata still published loopback URLs as the issuer (`http://127.0.0.1:1940/vault/default`) when fetched via the hub proxy. Vault's `getBaseUrl` correctly honors `X-Forwarded-Host` / `X-Forwarded-Proto` — but hub's `proxyRequest` deleted Host without setting `X-Forwarded-Host`. Fix: capture Host before deleting, then `headers.set('x-forwarded-host', publicHost)`; also synthesize `X-Forwarded-Proto` from `isHttpsRequest` when the edge didn't already set it. Preserve already-set forwarded headers for nested proxy chains.

### Added

- **Tag-triggered release CI** (hub#359, hub#360, hub#361). `.github/workflows/release.yml` ships hub via npm Trusted Publishing (OIDC, no `NPM_TOKEN`) + ghcr.io container image on tag push. Tag patterns: `v[X.Y.Z][-rc.N]` publishes hub; `scope-guard-v[X.Y.Z][-rc.N]` publishes the workspace's scope-guard package on independent cadence. `RELEASING.md` documents both flows + one-time Trusted Publisher setup. Uses node 24 (npm 11.5+ required for OIDC). Image lands on `ghcr.io/parachutecomputer/parachute-hub` with tags `:rc` / `:stable` / `:vX.Y.Z[-rc.N]`.

- **Test hermeticity fix** (hub#362). Two tests in hub-server.test.ts depended on the host machine's `~/.parachute/services.json` having a vault row to bypass the wizard-funnel redirect. CI has no such file → 302 → test fail. Fix: both tests now `writeManifest({ services: [vaultEntry("default")] })` and pass explicit `manifestPath`. Now hermetic in any environment.

### Patterns check

- New cross-cutting pattern doc: [`parachute-patterns/patterns/bun-container-deploy.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/bun-container-deploy.md) — codifies the four env-var requirements + `Bun.spawn` env-inheritance gotcha + the three load-bearing pitfalls (`mkdir`-as-root, platform-injected `PORT`, reverse-proxy header forwarding) for any future bun-based module deployed to a container + persistent-disk setup.
- New release pattern doc: [`parachute-patterns/patterns/release-ci.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/release-ci.md) — canonical workflow shape used here + rolled out to vault / scribe / app / runner / notes.
- [`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md) Rule 2 updated 2026-05-24: PRs no longer bump rc.N per-commit. Bump + tag together only when shipping.

### Verification

- `bun run typecheck` clean.
- `bun test ./src`: 1932 pass / 0 fail (3 new tests added across this chain, 1 test made hermetic).
- Live verification on Aaron's fresh Render deploy: hub running as bun user (PID 7), vault + app + scribe all spawned, OAuth discovery publishes `https://parachute-hub.onrender.com/...` across all 5 endpoints, `/oauth/register` returns 201, vault's OAuth metadata via hub-proxied URL correctly shows `https://parachute-hub.onrender.com/vault/default` as issuer.
- First CI publish of rc.34: ✅ test + publish-npm + publish-image all green; npm `@rc` dist-tag now at 0.5.13-rc.34; ghcr image published.

## [0.5.13-rc.28] - 2026-05-24

**fix(hub): Render install EACCES finally resolved + drop `PARACHUTE_HUB_ORIGIN` prompt + tini `-g` signal forwarding.**

### Fixed

- **Render install EACCES finally resolved** (closes hub#349 actual root cause). All previous fixes (#350 chown, #351 TMPDIR, #352 spawn env-inheritance, #353 banner) addressed real bugs but missed the load-bearing one: bun's `bun add -g` symlinks binaries to `$BUN_INSTALL_BIN`, which defaults to `/usr/local/bin/` when unset. That system path isn't writable by the non-root `bun` user, so every install failed at `symlinkat()` with EACCES. Fix: `ENV BUN_INSTALL_BIN=/parachute/modules/bin` in the Dockerfile so binaries land on the persistent disk. `PATH` also extended so hub + child processes resolve the installed binaries. Entrypoint pre-creates `/parachute/modules/bin/` and chowns to bun, idempotently. Verified locally by reproducing in a Docker volume mount and stracing the failing syscall — `symlinkat(..., AT_FDCWD, "/usr/local/bin/<binary>") = -1 EACCES`.

### Changed

- Render Blueprint UX: `PARACHUTE_HUB_ORIGIN` no longer surfaces as a prompted env var. Most operators use Render's auto-assigned URL where hub auto-derives the issuer from request origin. Operators with a custom domain set it manually in the Render Environment tab (documented in the render.yaml comment block).
- Dockerfile: tini gains `-g` flag for process-group signal forwarding. Fixes the `[FATAL tini (1)] Unexpected error when forwarding signal: 'Operation not permitted'` log line operators were seeing on Render — the error was cosmetic for the running container but indicated shutdown signals might not reach hub cleanly on container redeploy.

### Patterns check

- No pattern shifts. Surface polish on the Render deploy first-boot UX (continues the rc.27 arc of "make Render's prompted env vars match what most operators actually need") plus a niche container-config workaround plus the load-bearing `BUN_INSTALL_BIN` fix that finally closes hub#349. No changes to hub source code.

### Verification

- `bun run typecheck` clean.
- `bun test ./src` clean (no `src/` changes).
- Reproduced the EACCES locally via Docker volume + `bun add -g` + strace; confirmed `BUN_INSTALL_BIN=/parachute/modules/bin` resolves it cleanly for vault, scribe, app, runner.

## [0.5.13-rc.27] - 2026-05-23

**fix(hub): drop admin env vars from default Render deploy + make bootstrap token banner prominent.**

Aaron's framing: on first-time setup we don't want admin username/password as default config variables prompted in Render's dashboard — we just want to make sure the bootstrap token is easy to spot in the logs.

### Changed

- Render deploy default flow simplified: removed `PARACHUTE_INITIAL_ADMIN_USERNAME` / `PARACHUTE_INITIAL_ADMIN_PASSWORD` as prompted fields in `render.yaml`. New default: operators check Render Logs for the bootstrap token (now in a visually prominent banner with ═ delimiters), visit `/admin/setup`, paste the token, create admin. Operators who want env-var seeding can still set these env vars manually in the Render dashboard — hub honors them via `seedInitialAdminIfNeeded`. Cleaner secret hygiene: no admin passwords stored in Render's env-var dashboard.
- The bootstrap-token banner in hub's startup logs now uses ═ delimiters + ALL-CAPS heading, making it easy to spot when scrolling through container logs. The `parachute-bootstrap-` prefix on the token line is preserved so operators can grep for that exact string.
- README "Hosted (Render)" section updated to lead with the bootstrap-token-from-logs flow.

### Patterns check

- No pattern shifts. Surface polish on the Render deploy + first-boot operator experience; complements the rc.26 spawn-env fix that unblocked Render module installs. Cross-refs hub#337 / hub#347 (Render deploy infrastructure).

### Verification

- `bun run typecheck` clean.
- `bun test ./src` — banner tests updated, all pass.

## [0.5.13-rc.26] - 2026-05-23

**fix(hub): `Bun.spawn` subprocess calls now inherit `process.env` (closes the real-real root cause of [hub#349](https://github.com/ParachuteComputer/parachute-hub/issues/349)).**

`Bun.spawn` defaults to an **EMPTY** env when `env` is not passed — it does NOT inherit the parent's environment the way `child_process.spawn` does in Node. Every place in hub that called `Bun.spawn` without an explicit `env: process.env` was handing the child a clean env: no `PATH`, no `HOME`, no `TMPDIR`, no `BUN_INSTALL`, no `PARACHUTE_*`. The Render install failure was the visible symptom (#350's chown + #351's `TMPDIR=/parachute/tmp` were both necessary but neither sufficient — the spawned `bun add -g` subprocess never saw the env vars set in the Dockerfile), but the same class of bug was sitting in 13 other call sites waiting to bite.

### Fixed

- Fixed: hub's `Bun.spawn` subprocess calls now inherit the parent's environment (`env: process.env`). Bun.spawn defaults to an EMPTY env, which meant subprocess `bun add -g` didn't see `TMPDIR`, `BUN_INSTALL`, or any other env vars set by the Dockerfile or operator. This was the actual root cause of the Render install EACCES — even after rc.25 set `TMPDIR=/parachute/tmp` in the Dockerfile ENV, hub's spawned `bun add` didn't inherit it. Closes hub#349 (real-real root cause; prior chown + TMPDIR fixes were necessary but not sufficient). Fixed across 14 `Bun.spawn` call sites — every non-test spawn in `src/` now propagates env, which prevents the same class of bug from surprising operators with subprocess calls.

### What landed

The fix is mechanical: add `env: process.env` to the `Bun.spawn` options at every call site that didn't already set `env`. For the two seams that conditionally merged `process.env` only when a per-call override was provided (`src/supervisor.ts:defaultSpawnFn`, `src/commands/lifecycle.ts:defaultSpawner`), the default branch now also sets `env: process.env`; the override branch's `{ ...process.env, ...opts.env }` merge is unchanged.

Call sites updated:

1. `src/api-modules-ops.ts:defaultRun` — admin SPA install/upgrade (the Render-failure trigger)
2. `src/commands/install.ts:defaultRunner` — CLI install
3. `src/admin-vaults.ts:defaultRunCommand` — admin SPA vault ops
4. `src/commands/expose-auth-preflight.ts:defaultInteractiveRunner` — Tailscale auth check
5. `src/commands/auth.ts:defaultRunner` — `parachute auth` forwarding to vault
6. `src/commands/expose-cloudflare.ts:defaultCloudflaredSpawner` — `cloudflared` subprocess (needs `HOME` for `~/.cloudflared/`)
7. `src/commands/expose-interactive.ts:defaultInteractiveRunner` — interactive expose flows
8. `src/commands/vault-tokens-create-interactive.ts:defaultInteractiveRunner` — interactive vault token mint
9. `src/commands/vault.ts:dispatchVault` — `parachute vault <args>` forwarder
10. `src/commands/lifecycle.ts:defaultSpawner` — module daemon spawner (default branch + per-call merge preserved)
11. `src/commands/lifecycle.ts` tail-spawner — `parachute logs -f` `tail -f`
12. `src/commands/upgrade.ts:defaultRunner` — `parachute upgrade` (both `.run` and `.capture`)
13. `src/hub-control.ts:defaultHubSpawner` — `parachute serve` background hub
14. `src/supervisor.ts:defaultSpawnFn` — supervised module subprocess (default branch + per-call merge preserved)
15. `src/tailscale/run.ts:defaultRunner` — every `tailscale ...` shell-out

Each site has an inline comment pointing back to `api-modules-ops.ts:defaultRun` for the rationale (DRY on the "why").

### Verification

- `bun run typecheck` clean.
- `bun test ./src` — 1921 pass / 0 fail (+2 from `src/__tests__/spawn-env-propagation.test.ts` regression test: positive case asserts `env: process.env` propagates, negative-control case asserts that omitting `env` produces an empty-env child — locks the Bun.spawn behavior so a future regression is caught here, not in production on Render).
- `bunx biome check src/` clean.

### Patterns check

- No pattern shifts. The "spawned subprocesses inherit env unless deliberately scrubbed" expectation is a Unix-tooling convention shared with `child_process.spawn`'s default; this PR makes hub's `Bun.spawn` usage conform to that convention. Worth noting in [`parachute-patterns/patterns/`](https://github.com/ParachuteComputer/parachute-patterns/tree/main/patterns) as a Bun-runtime gotcha for future modules in the ecosystem (vault, scribe, app — all of which also use `Bun.spawn`), but the doc is out-of-scope for this hub-only PR.

## [0.5.13-rc.25] - 2026-05-23

**fix(hub): `TMPDIR=/parachute/tmp` so bun installs work on cross-mount filesystems (closes [hub#349](https://github.com/ParachuteComputer/parachute-hub/issues/349) root cause).**

Aaron ran `bun add -g --verbose cowsay` inside a Render shell and surfaced the actual failure mode:

```
info: cannot move files from tempdir: RenameAcrossMountPoints, using fallback
error: Failed to link cowsay: EACCES
```

The Render container's filesystem layout has `/parachute` mounted as a separate block device (`/dev/nvme16n1` on ext4). Bun's default tempdir is `/tmp` — on the container's overlay filesystem. When `bun add -g <pkg>` extracts the package and `rename()`s files from `/tmp/.bun-tmp-*` into `/parachute/modules/install/global/node_modules/...`, the kernel rejects with `EXDEV` (`RenameAcrossMountPoints`). Bun's fallback copy path then hits `EACCES` on a follow-up step and the link phase fails. Same-filesystem `bun add` in `/tmp/test` succeeds; cross-filesystem `bun add -g` fails.

The previous fix in [#350](https://github.com/ParachuteComputer/parachute-hub/pull/350) (entrypoint chown of `/parachute`) was defensive hardening against stale disk ownership — useful, but not the actual root cause. This PR pins `TMPDIR` to `/parachute/tmp` so bun's extraction tempdir lives on the same filesystem as `BUN_INSTALL=/parachute/modules`, and `rename()` succeeds.

### Fixed

- **Render install failure resolved**: `bun add -g <module>` was failing with `Failed to link X: EACCES` on Render deploys. Root cause: Render mounts the persistent disk as a separate block device (`/dev/nvme*` on `/parachute`), and bun's default tempdir (`/tmp`, on the container's overlay filesystem) means cross-mount `rename()` fails with `EXDEV` during the link phase. Fix: `TMPDIR=/parachute/tmp` in the Dockerfile so bun's tempdir is on the same filesystem as `BUN_INSTALL=/parachute/modules`. Entrypoint script now creates `/parachute/tmp` and chowns it to bun. Resolves the install-blocker that prevented operators from installing modules via the admin SPA. Closes hub#349 (the real root cause, not the disk-ownership theory that earlier PRs addressed defensively).

### What landed

- **`Dockerfile`** — `ENV TMPDIR=/parachute/tmp` added alongside the existing `PARACHUTE_HOME` / `BUN_INSTALL` block in the runtime stage. Inline comment block explains the EXDEV / cross-mount diagnosis so the next operator doesn't have to re-derive it.
- **`docker-entrypoint.sh`** — after the existing chown-if-needed block, `mkdir -p /parachute/tmp && chown bun:bun /parachute/tmp` ensures the tempdir exists and is writable by the bun user. Both ops are idempotent and microseconds — safe to run on every startup. Drop-to-bun via `gosu` is unchanged.

### Verification

- `bun test ./src` clean (no source change).
- `bun run typecheck` clean (no TS impact).
- Dockerfile + entrypoint diff reviewed manually; placement of `TMPDIR` in the ENV block + the tmpdir-create step in the entrypoint mirror the existing patterns for `BUN_INSTALL` + chown-if-needed.

### Patterns check

- No pattern shifts. The "TMPDIR-on-same-filesystem-as-target" pattern is a Unix invariant (`rename(2)` requires source + dest on the same filesystem; `EXDEV` is the standard cross-mount errno). The change is internal to the container build — no cross-repo coordination needed.

## [0.5.13-rc.24] - 2026-05-23

**fix(hub): Dockerfile entrypoint chowns `/parachute` on startup (handles stale-ownership disks from older deploys) (closes [hub#349](https://github.com/ParachuteComputer/parachute-hub/issues/349)).**

Aaron's reproducer (2026-05-23): `error: Failed to link @openparachute/vault: EACCES` on a Render deploy whose persistent disk was provisioned during the hub 0.5.11 era — long before the current `chown -R bun:bun /parachute` line was added to the Dockerfile. Render preserves disk ownership across deploys, and chown-at-build only affects the image layer, not the mounted volume. Result: a uid-0-owned `/parachute` mounted into a container running as uid 1000, and every `bun add` write fails with EACCES.

### Fixed

- Dockerfile entrypoint now idempotently chowns `/parachute` to `bun:bun` at startup, fixing the EACCES install failure on Render deploys whose persistent disk dates from before the chown-at-build line was added. Drops to the `bun` user via `gosu` after the chown — tini still wraps the tree for signal forwarding. Closes hub#349.

### What landed

- **`docker-entrypoint.sh`** (new) — POSIX `sh` script. Runs as root briefly: if `stat -c '%u' /parachute` is not `1000` (the bun uid), runs `chown -R bun:bun /parachute` and logs the prior uid. Then `exec gosu bun "$@"` drops privileges to the bun user before handing off to the `CMD`. Idempotent — fresh disks (already owned by uid 1000) skip the chown.
- **`Dockerfile`** — installs `gosu` alongside `tini` in the runtime stage; removes the build-time `USER bun` directive (the entrypoint script does the drop now); copies `docker-entrypoint.sh` to `/usr/local/bin/`, makes it executable, and wires it as the entrypoint after `tini --`. The CMD (`bun src/cli.ts serve`) is unchanged. The pre-existing build-time `chown -R bun:bun /parachute` stays — it handles the fresh-image case so the runtime chown is genuinely a no-op for new deploys; the runtime chown handles the carry-over disk case.

### Verification

- `bun test ./src` clean (no code change in `src/`).
- `bun run typecheck` clean (no TS impact).
- Dockerfile reviewed manually: layer order verified (gosu install before entrypoint copy; `USER bun` removed; tini still wraps the tree).

### Patterns check

- No pattern shifts. The "root-briefly-then-drop" pattern is the canonical Docker-on-persistent-disk shape (used by oven/bun-alpine's own conventions for non-root operation under mounted volumes). The change is internal to the container build — no cross-repo coordination needed.

## [0.5.13-rc.23] - 2026-05-23

**feat(hub): `/api/hub` endpoint + Hub Version Badge in admin SPA (version visibility) (closes [hub#348](https://github.com/ParachuteComputer/parachute-hub/issues/348)).**

Aaron's framing (2026-05-23, mid-install): "I can't really tell with mine if it's updated or not. And I'm not sure how I would queue it to update or if it just already did." Render auto-deploys on every push to source; the operator doesn't actively trigger updates and needs to see the result land somewhere visible. The CLI surface `parachute status` already shows version + uptime + install-source; this PR mirrors it for the admin SPA.

### Added

- `/api/hub` endpoint + Hub Version Badge in admin SPA. Operators can now see at a glance what version of hub they're running, when it last started, and how it's installed (npm tag, bun-linked checkout, or container). Especially useful for Render deployers tracking auto-deploys from main. Click the badge for a detail panel + manual refresh button.

### What landed

- **`src/api-hub.ts`** — new `GET /api/hub` handler. Bearer-gated on `parachute:host:admin` (same as `/vaults` and `/api/grants`). Returns `{ version, started_at, uptime_ms, source, bun_linked_path?, git_head?, container_build_time? }`. `source` reuses `detectHubInstallSource` from install-source.ts with one container override: when `PARACHUTE_HOME === "/parachute"` (the Render Blueprint pin) we surface `"container"` instead of `"bun-linked from /app"` — operator-friendly. `started_at` is captured once at module load (`HUB_PROCESS_STARTED_AT`); `uptime_ms` is computed server-side so the client doesn't deal with clock skew. `PARACHUTE_BUILD_TIME` env var passes through opportunistically as `container_build_time` (not surfaced when unset).
- **`src/hub-server.ts`** — wires the new `/api/hub` route alongside `/api/me`; adds it to the route-table docstring.
- **`web/ui/src/lib/api.ts`** — `getHubStatus()` + `HubStatus` / `HubStatusSource` types. Same `getHostAdminToken()` bearer pattern as the other admin endpoints; 401/403 clears the cached token.
- **`web/ui/src/components/HubVersionBadge.tsx`** — persistent footer affordance. Renders `Hub <version> · running <uptime> · <source>` on one muted line. Click expands an inline detail panel with the full source label (bun-linked path + git head when applicable), formatted UTC timestamps for started + built, plus a Refresh button. Auto-refreshes every 30s while mounted and on tab focus. 401/403 collapses to render-null (no redirect loop — the SPA's other surfaces handle auth flow).
- **`web/ui/src/App.tsx`** — mounts `<HubVersionBadge />` at the bottom of the page, gated on `me?.hasSession` so it never renders for signed-out visitors (the badge would 401 anyway).
- **`web/ui/src/styles.css`** — `.hub-version-badge` + panel styling. Muted single line above a `1px` top-border, expandable `<dl>` grid for the detail rows.

### Verification

- `bun test ./src` 1919 pass / 0 fail (delta: +7 new tests in `src/__tests__/api-hub.test.ts` — 405 / 401 / 403 gate; happy path shape; uptime increments between calls; `PARACHUTE_HOME=/parachute` overrides to `container`; `PARACHUTE_BUILD_TIME` passes through).
- `cd web/ui && bunx vitest run` 203 pass / 0 fail (delta: +10 new tests in `HubVersionBadge.test.tsx` — `formatUptime` boundaries; null-on-pending render; happy-path render; null-on-401; click-expand panel; refresh button refetches; container_build_time surfaces).
- `bun run typecheck` clean.
- `cd web/ui && bun run build` clean (`verify-base.mjs` passes; `/admin/`-prefixed asset URLs intact).

### Patterns check

- No pattern shifts. New `/api/*` endpoint follows the canonical bearer-gated read shape established by `/api/grants`, `/api/tokens`, `/api/modules` — `requireScope(parachute:host:admin)`, snake-case wire fields, `cache-control: no-store`. SPA-side, the badge follows the existing `getHostAdminToken()` cached-bearer pattern; auto-refresh + focus-refresh mirror what the Modules page already does for the supervisor status poll.

## [0.5.13-rc.22] - 2026-05-23

**fix(hub): Render Blueprint default channel `latest`, not `rc` (rc is now opt-in for dev/testing).**

Per Aaron: "I don't want it all to be rc, just for that to be a choice. Most people installing via render want latest for hub and latest for other modules. But flexibility is key here. And for me, I want to be testing it with rc."

Changes:

- `render.yaml`: `PARACHUTE_INSTALL_CHANNEL` value `rc` → `latest`. Comment updated to reflect that rc is the opt-in choice (set in Render dashboard) rather than the default.
- `README.md`: "Hosted (Render)" section now leads with "stable by default" and surfaces the rc-flip in a bold callout.
- The rc.20 CHANGELOG entry for hub#337/#339 remains accurate as historical record (Aaron's testing did rely on rc-as-default during that rc chain); this rc reverses the default for the canonical operator path.

Existing Render deploys with the env var manually set in the dashboard are unaffected — Render doesn't auto-overwrite operator-set env vars on Blueprint redeploys.

## [0.5.13-rc.21] - 2026-05-23

**fix(hub): `parachute logs <svc>` no longer misreports a running daemon as not-started (closes [hub#335](https://github.com/ParachuteComputer/parachute-hub/issues/335)).**

Aaron's reproducer (during install testing 2026-05-23): `parachute logs app --tail 5` printed `no logs yet for app. \`parachute start app\` to begin.` — even though parachute-app was up (curl through the proxy returned 200). The misleading "start the service" hint was emitted on a single condition (`!existsSync(logFile)`), conflating two distinct shapes: (1) daemon never started, (2) daemon is running but the hub-managed log file isn't at the expected path (because the module spawned itself outside `parachute start`, or the file was deleted mid-run, or stdout/stderr was redirected elsewhere).

### Changed

- `logs()` consults `processState(svc, configDir)` on the missing-file path. When the pidfile is present + the process is alive, surfaces `<svc> is running (pid <N>) but no log file at <path>` instead of the start-hint. Stale pidfile (or no pidfile) keeps the original `parachute start <svc>` hint — that's still the right message when the daemon really isn't up.
- `LogsOpts` gains an `alive?: AliveFn` seam (defaults to the group-aware `defaultAlive` from hub#88) so tests can drive the pidfile-alive branch deterministically.
- Happy-path tail behavior unchanged: when the log file exists, we read + print it, regardless of pidfile state. Post-mortem logs from a stopped daemon stay readable.

### What landed

- **`src/commands/lifecycle.ts`** — `logs()` adds the `processState` branch on the missing-file path; `LogsOpts` extended with `alive`.
- **`src/__tests__/lifecycle.test.ts`** — three new tests: running daemon + missing log file (asserts the new alive-but-no-log shape), stale pidfile + missing log file (asserts fall-through to original start-hint), log file exists + dead pidfile (asserts tail prints regardless).

### Verification

- `bun test ./src` 1915 pass / 0 fail (delta: +3 new tests in the `parachute logs` block).
- `bun run typecheck` clean.

### Patterns check

- No pattern shifts. Lifecycle's pidfile contract ([`process-state.ts`](./src/process-state.ts)) and `logPath` shape are unchanged; this fix consumes `processState` exactly as documented.

## [0.5.13-rc.20] - 2026-05-23

**feat(hub): comprehensive UI pass — wizard done-screen + Modules page Open + discovery quick-start (closes [hub#342](https://github.com/ParachuteComputer/parachute-hub/issues/342)).**

Closes the "I just installed it, where is it?" friction Aaron hit (two reports, 2026-05-22 → 23): (1) install-tile log lines overflowed the wizard card → text size jumped, page stretched; (2) "no clear way to go from setting up parachute to actually using parachute." Plus the architectural pivot Aaron named: Open and Configure aren't meaningfully different — each module ships its own UI handling both viewing and configuring. Hub becomes a dispatcher to that UI; the in-hub config form retires.

### Architectural framing

Per [`module-ui-declaration.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/module-ui-declaration.md) + [`module-surfaces.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/module-surfaces.md): each committed-core module exposes a canonical admin UI at `/<short>/admin` (or wherever its `managementUrl` declares). Hub's job is dispatch — point operators at the right module's UI; the module's own SPA handles view + configure via internal scope gates. The pre-#342 "Configure" link to a hub-side config form was an artifact of scribe being the only schema-backed module; with scribe + runner shipping their own SPAs (scribe#53, runner#8 — filed alongside), hub's generic config form becomes redundant.

### Changed

- **Install-log overflow CSS** — `.op-log` gains `overflow-x: auto`, `.log-lines li` gain `white-space: pre-wrap` + `overflow-wrap: anywhere`. `.install-tile` gains `min-width: 0` so the grid track can shrink below intrinsic content width. Aaron's reproducer: install long-package-name modules → page stretches off-screen. Fixed.
- **Wizard done-screen leads with "Start using your vault"** — new lead tile above the MCP / install / admin tiles. When parachute-app is installed, links to `/app/notes/` (the canonical Notes-as-UI surface per parachute-app §17). When app isn't installed yet, falls back to the vault's own admin UI at `/vault/<name>/admin/`. Either way, the operator has one obvious "start using" target rather than three competing "next step" tiles.
- **Wizard install-tile post-success: "Use it now" link** — terminal-state install tiles (succeeded + already-installed) now lead with "Use it now" pointing at the module's canonical UI (`/app/notes/` for App, `/scribe/admin/` for Scribe, etc. — per `USE_IT_NOW_URLS`). "Manage modules" stays as the secondary affordance. The link table mirrors `module-ui-declaration.md`'s `uiUrl` / `managementUrl` semantics.
- **Admin SPA Modules page: Open + Configure collapse into a single Open button** — `ModuleRow` swaps the `<Link to="/modules/<short>/config">Configure</Link>` for an `<a href={management_url}>Open</a>` (full-page nav, since the module owns its surface). Modules without a declared `management_url` (scribe, runner today) render a disabled `<button>` with a tooltip pointing at the per-module follow-up issue — gentler than 404-on-click. `management_url` is a new wire field on the `/api/modules` shape: hub resolves each installed module's `managementUrl ?? uiUrl` from `.parachute/module.json` against its mount path. The pre-#342 in-hub config form code at `/admin/modules/:short/config` stays in place (back-compat for stale bookmarks) but no SPA surface links to it anymore; a future PR deletes it after the migration period.
- **Discovery page (`/`) "Get started" section** — new section above the Services grid, hidden until at least one prereq is met. Two hardcoded tiles when applicable: "Open Notes" → `/app/notes/` (when parachute-app is installed); "Browse Vault" → `/vault/<first-vault>/admin/` (when vault is installed). Driven off the unauth `/.well-known/parachute.json` — no Bearer required, fresh installs still see a sensible empty state.
- **Admin SPA nav: installed-services quick access** — new "Services ▾" dropdown between Modules and Users. One entry per installed module that declares a `management_url`; modules without one appear disabled with the same follow-up tooltip the Modules page surfaces. Native `<details>`/`<summary>` for the toggle, absolute-positioned panel, no JS framework dance. Fetches the same `/api/modules` catalog the Modules page reads; failure is silent (dropdown collapses).

### Deprecated

- `/admin/modules/:short/config` (the generic per-module config form) — file gets a deprecation docstring; SPA surface no longer links to it. Deletion follow-up tracked in this PR's body. Scribe + runner's own admin SPAs (scribe#53, runner#8) replace its purpose.

### What landed

- **`src/setup-wizard.ts`** — `.op-log` + `.log-lines li` overflow constraints; `.install-tile` gains `min-width: 0`; new `.start-using` block; new `renderStartUsingTile(vaultName, appInstalled)`; `RenderDoneStepProps` gains optional `appInstalled`; `handleSetupGet`'s done branch reads `isModuleInstalled("app", manifestPath)` and threads it through; new `USE_IT_NOW_URLS` table; install-tile renderer adds the "Use it now" primary CTA on succeeded + already-installed states.
- **`src/api-modules.ts`** — `ModuleWireShape` gains `management_url: string | null`; new `readModuleManifest` dep on `ApiModulesDeps`; manifest read resolves `managementUrl ?? uiUrl` against the entry's mount path (first non-`.parachute` path); errors are quiet per-entry.
- **`src/hub-server.ts`** — threads `readModuleManifest` through to `handleApiModules`.
- **`src/hub.ts`** — new `<section id="get-started-section">` above Services; new `renderGetStarted(services)` JS that conditionally renders Notes / Vault tiles based on which modules are installed.
- **`web/ui/src/lib/api.ts`** — `ModuleListing` gains `management_url`.
- **`web/ui/src/routes/Modules.tsx`** — `ModuleRow` renders Open instead of Configure; disabled fallback with `NO_UI_FOLLOWUPS` tooltip.
- **`web/ui/src/routes/ModuleConfig.tsx`** — deprecation docstring; route + handler stay for back-compat.
- **`web/ui/src/App.tsx`** — new `InstalledServicesDropdown`; `useEffect` to fetch modules on signed-in transition.
- **`web/ui/src/styles.css`** — `.nav-dropdown` + `.nav-dropdown-panel` + `.nav-dropdown-item` styles.

### Verification

- `bun run typecheck` clean.
- `bun test ./src` 1909 pass / 0 fail (delta: +7 new tests — five in `setup-wizard.test.ts` covering the lead tile + Use it now + log-overflow CSS, two in `api-modules.test.ts` covering `management_url` resolution + the null-fallthrough case).
- `cd web/ui && bunx vitest run` 193 pass / 0 fail (delta: +5 new tests — three in `Modules.test.tsx` covering Open active / disabled / no-Configure, two in `App.test.tsx` covering the nav dropdown empty + populated states).
- `bunx biome check src/` clean.
- `bun run build:spa` clean (the postinstall hook + prepack rebuild path).

### Follow-ups

- [parachute-scribe#53](https://github.com/ParachuteComputer/parachute-scribe/issues/53) — ship scribe admin SPA (currently config endpoints + schema only; Open button shows disabled-with-tooltip until this lands).
- [parachute-runner#8](https://github.com/ParachuteComputer/parachute-runner/issues/8) — ship runner admin SPA (currently admin endpoints only; same gap).
- Future PR: delete `web/ui/src/routes/ModuleConfig.tsx` + the `/api/modules/:short/config{,/schema}` endpoints once at least one rc cycle confirms no operator is bookmarking the legacy path.

### Cross-references

- [`module-ui-declaration.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/module-ui-declaration.md) — `uiUrl` vs `managementUrl` semantics.
- [`module-surfaces.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/module-surfaces.md) — canonical surfaces per module.
- [`runtime-tenancy-contract.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/runtime-tenancy-contract.md) — how the dispatched-to module reads its mount + hub origin from injected meta tags.

## [0.5.13-rc.19] - 2026-05-23

**chore(hub): retire `kind` from types + manifest parser + `KNOWN_MODULES` + `upgrade.ts` build branch (closes [hub#330](https://github.com/ParachuteComputer/parachute-hub/issues/330)).**

Completes hub#301 Phase C/D. Phase A ([hub#327](https://github.com/ParachuteComputer/parachute-hub/pull/327)) made `kind` optional in the manifest validator; Phase B retired `kind` from the per-module `.parachute/module.json` files in vault, scribe, runner, and app (vault#359, scribe#52, runner#7, app#29 — all merged); patterns#84 dropped the field from the canonical module-protocol pattern docs. This PR finishes the cleanup by deleting hub's remaining references.

### Removed

- `kind` field fully retired from hub. Removed the `ModuleKind` type alias, `ServiceKind` type alias, the `asKind` parser, and all `kind:` declarations in `KNOWN_MODULES` / `FIRST_PARTY_FALLBACKS`. The `upgrade.ts` `kind === "frontend"` branch (which ran `bun run build` post-install for notes-daemon on the bun-linked path) also retires — notes-daemon's `prepublishOnly` script builds `dist/` at publish time and its `files` array ships `dist/`, so consumers don't need a post-install rebuild. Module authors who still ship `kind` in `module.json` aren't broken: the validator silently ignores it.

### What landed

- **`src/module-manifest.ts`** — deleted `ModuleKind` export, the `kind?: ModuleKind` field from `ModuleManifest`, the `asKind` parser function, and the validator's `kind` write-through.
- **`src/service-spec.ts`** — deleted the `ServiceKind` type alias, the `kind?: ServiceKind` field from `ServiceSpec`, the `kind: ModuleKind` field from `KnownModule`, the import-time `ModuleKind` alias, and the `kind:` value on every `KNOWN_MODULES` entry (vault, scribe, runner, app) + on both `FIRST_PARTY_FALLBACKS` (notes, channel). `composeServiceSpec`, `synthesizeManifestForKnownModule`, and `getSpec`'s synthesis path no longer set `kind`. `effectivePublicExposure` collapses to a single signal: `extras.hasAuth === false` ⇒ "auth-required", else "allowed" — same outcome for every module today (scribe is the canonical `hasAuth: false` case).
- **`src/commands/upgrade.ts`** — dropped the `if (target.spec?.kind === "frontend") { bun run build }` branch and the now-unused `packageHasScript` helper. Updated the file's docstring to remove the "bun run build (frontend kind, if `build` script exists)" line.
- **Tests** — collapsed `module-manifest.test.ts`'s five "kind is no longer validated" sub-tests into one "kind values in module.json are silently ignored" test that pins the new behavior (parsed manifest exposes no `kind` field). Refactored `upgrade.test.ts`'s "bun-linked frontend: runs bun run build" test into the inverse assertion: `bun run build` is NOT invoked even when a module declares a `build` script. Removed `kind:` from `readModuleManifest` fixtures in `hub-server.test.ts`, `post-install.test.ts`, `api-modules-ops.test.ts`, `install.test.ts`, and `lifecycle.test.ts` — those fixtures are typed against `ModuleManifest`, so the field deletion cascades into the test surface.

### Verification

- Notes-daemon's `prepublishOnly` runs `bun run build` (verified in `parachute-notes/packages/notes-daemon/package.json`); the `files` array publishes `dist/`. Post-install rebuild on the consumer side was never load-bearing — npm tarballs ship complete.
- `bun run typecheck` clean; `bun test ./src` 1902 pass / 0 fail (delta from rc.18: −5 tests, all from the module-manifest kind sub-test collapse + the upgrade frontend-build test refactor); `bunx biome check src/` clean.

### Back-compat

- Third-party + first-party `module.json` files that still declare `kind` keep parsing fine — the validator silently ignores the field, no warnings, no errors.
- Modules previously installed under any `kind` value continue to start, restart, upgrade, and expose normally. The `effectivePublicExposure` defaults preserve the previous behavior for every known module (vault / scribe / runner / app / notes / channel).
- The bun-linked-checkout `parachute upgrade notes` path no longer runs `bun run build` post-pull. Operators running notes-daemon from a local checkout who relied on this can run `bun run build` themselves; the published npm tarball already includes `dist/`.

## [0.5.13-rc.18] - 2026-05-23

**feat(hub): `parachute install` accepts `--channel rc|latest` + honors `PARACHUTE_INSTALL_CHANNEL` env; Render deploy cascades rc across modules.**

`parachute install <svc>` previously ran `bun add -g <pkg>` (bun resolves bare names to `@latest`). For Aaron's canonical Render deploy — hub container shipped from `main`, which tracks the rc chain per [governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md) — the admin SPA's `/admin/modules` install flow would land vault / app / scribe / runner at `@latest` regardless. The cluster's version axis silently fragmented: hub on rc, modules on stable. Closes [hub#337](https://github.com/ParachuteComputer/parachute-hub/issues/337) (sibling to [hub#338](https://github.com/ParachuteComputer/parachute-hub/pull/338), which fixed the same shape for `parachute upgrade`).

### Added

- `parachute install <svc>` now accepts `--channel rc|latest` and honors a `PARACHUTE_INSTALL_CHANNEL` env var (default: `latest`). The `bun add -g <pkg>@<channel>` composition reflects the resolved channel; `--tag <name>` still wins over both for programmatic exact-version pins. Closes [hub#337](https://github.com/ParachuteComputer/parachute-hub/issues/337).
- Admin SPA install API (`POST /api/modules/:short/install`) now accepts an optional JSON body `{ "channel": "rc" | "latest" }` for per-call overrides, and honors the same `PARACHUTE_INSTALL_CHANNEL` env var. Precedence (highest → lowest): body channel > env var > `hub_settings.module_install_channel` (the existing admin SPA toggle, hub#275) > `latest`.
- Render deploy now sets `PARACHUTE_INSTALL_CHANNEL=rc` (`render.yaml`) so operators forking the repo to deploy from `main` (which tracks rc) get an rc-cascade: hub at rc plus all modules installed via the admin SPA also at rc. This is the canonical "rc dev deploy" shape; flip to `latest` (or remove the key) once 1.0 lands.

### What landed

- **`resolveInstallChannel` (`src/commands/install.ts`)** — precedence chain: `--tag` > `--channel` > `PARACHUTE_INSTALL_CHANNEL` env > `"latest"`. Garbage env values (e.g. `PARACHUTE_INSTALL_CHANNEL=banana`) warn + fall back to `latest` rather than crashing the install path — operator typos at the platform layer can't take down installs.
- **CLI flag (`src/cli.ts`)** — `--channel rc|latest` for `parachute install`. Validated at argv-parse time (invalid value → exit 1 with an actionable error). Mirrors the `--channel` shape already on `parachute upgrade` (hub#338) so the operator surface is uniform.
- **Help text (`src/help.ts:installHelp`)** — documents the new `--channel` flag, the `PARACHUTE_INSTALL_CHANNEL` env var, and the precedence relative to `--tag`. Includes worked examples for both forms.
- **API install (`src/api-modules-ops.ts:handleInstall` + `runInstall`)** — reads optional `{ channel }` from the request body, threads through `runInstall`'s new `channelOverride` parameter. The new `resolveApiInstallChannel` helper applies the precedence chain. Existing `hub_settings.module_install_channel` (admin SPA toggle, hub#275) is preserved as the cluster-wide default below env-var override.
- **`Dockerfile` docstring** — documents `PARACHUTE_INSTALL_CHANNEL` in the operator-facing env-var table at the top.
- **`render.yaml`** — sets `PARACHUTE_INSTALL_CHANNEL=rc` as the deploy-default, with an inline comment explaining the rc-cascade rationale and the flip-to-latest direction.

### Back-compat

Defaults to `latest` when nothing's set, which is what bun resolves bare names to anyway — so a `parachute install vault` with no flag, no env, and no admin-toggle still produces the byte-identical `bun add -g @openparachute/vault` invocation as pre-#337. Explicit channel / env-set / DB-stored channel paths flow through to `<pkg>@<channel>`. Existing API callers (no body, or body without `channel`) keep working unchanged.

### Tests

`bun test ./src` — 1906 pass / 0 fail (was 1889 in rc.17; +17 new cases across `src/__tests__/install.test.ts`, `src/__tests__/api-modules-ops.test.ts`, and `src/__tests__/cli.test.ts`). New coverage: CLI default-channel back-compat (no @latest suffix); env-driven rc; `--channel` flag winning over env; `--tag` winning over both; garbage env value with warning; bun-link short-circuit ignores channel; local-path install bypasses channel; CLI rejects missing / invalid `--channel` values; API body `{ channel }` override winning over hub_settings; API body invalid channel → 400; API missing body → fallback to hub_settings; API env-var > hub_settings; API body > env > hub_settings; API garbage env warns + falls back. `bun run typecheck` clean. `bunx biome check src/` clean.

### Intentionally not changed

- **`parachute upgrade`** — hub#338's channel-preservation + downgrade-refusal shape stays as-is. Upgrade detects channel from the installed version string by default; the `--channel` override is already there. Out of scope for #337.
- **`parachute setup`** — interactive wizard already accepts `--tag`; surfaces the install command per-service. Channel cascade flows through the env var the same way.
- **Existing `PARACHUTE_MODULE_CHANNEL` env (hub#275)** — kept as-is; it's a one-time DB-seed used by the admin SPA toggle. `PARACHUTE_INSTALL_CHANNEL` is the new per-call/per-platform default that doesn't write to the DB. The two coexist — `INSTALL_CHANNEL` is the cluster cascade, `MODULE_CHANNEL` is the admin's stored preference.

### Cross-references

- [hub#337](https://github.com/ParachuteComputer/parachute-hub/issues/337) — closes.
- [hub#338](https://github.com/ParachuteComputer/parachute-hub/pull/338) — sibling `parachute upgrade` channel fix (rc.17).
- [governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md) — RC versioning convention informing the rc-cascade direction.

## [0.5.13-rc.17] - 2026-05-23

**fix(hub): `parachute upgrade` preserves the operator's channel + refuses silent downgrades.**

`parachute upgrade <svc>` previously ran `bun add -g <pkg>@latest` unconditionally on the npm-installed path. When `@latest` pointed at a prior stable (the typical state mid-rc-chain), an operator on `@rc` got silently downgraded. Aaron's reproducer ([hub#332](https://github.com/ParachuteComputer/parachute-hub/issues/332)):

```
$ parachute upgrade hub
hub: bun add -g @openparachute/hub@latest
installed @openparachute/hub@0.5.10 with binaries:
 - parachute
hub: 0.5.13-rc.13 → 0.5.10; restarting…
```

Per [governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md), pre-1.0 operators on the dev chain stay on `@rc`; `@latest` is the explicit-stable channel. `parachute upgrade` now respects that.

### What landed

- **Channel auto-detection (`src/commands/upgrade.ts:detectChannel`)** — reads the installed `package.json` `version` and infers the channel: a trailing `-rc(\.\d+)?$` (e.g. `0.5.13-rc.13`, `0.5.13-rc`) → `@rc`; anything else → `@latest`. The npm branch composes `bun add -g <pkg>@<detected-channel>` instead of the old hardcoded `@latest`.
- **Downgrade refusal (`src/commands/upgrade.ts:upgradeNpm`)** — before running `bun add -g`, resolves `npm view <pkg>@<channel> version` and compares to the installed version with an inline semver comparator (no new dependency). If the resolved target is lower, aborts with an actionable message that includes the exact `bun add -g <pkg>@<version>` command to force the downgrade, plus a `--channel rc` hint when the operator's on stable. Fail-open: a flaky `npm view` (network down, registry unreachable) skips the guard rather than blocking.
- **`--channel rc|latest` flag (`src/cli.ts`, `src/help.ts`)** — operator override. Wins over auto-detection.
- **`--allow-downgrade` flag (`src/cli.ts`)** — opt-in bypass of the refusal.
- **`--tag <name>`** — still works, still ignored when bun-linked. Takes precedence over `--channel` for programmatic callers.
- **Help text (`src/help.ts:upgradeHelp`)** — documents the new flags + the auto-detection rule.

### Tests

`bun test ./src` — 1889 pass / 0 fail (was 1880 in rc.16; +9 new cases in `src/__tests__/upgrade.test.ts` covering: `detectChannel` rc/latest discrimination including the `-rc` (no `.N`) edge case; `compareVersions` ordering (stable > matching rc, lower triple < higher rc); rc auto-detection from a rc.13-suffixed installed version; stable auto-detection from a clean version; `--channel rc` override against stable detection; downgrade refusal when `@rc` resolves to a lower version; `--allow-downgrade` bypass; Aaron's exact reproducer driven through the fix (rc.13 → rc.14 via `@rc`, not rc.13 → 0.5.10 via `@latest`); and `tag` precedence over both auto-detection and `--channel`). `bun run typecheck` clean. `bunx biome check src/` clean.

### Install command — same bug?

`parachute install <svc>` runs `bun add -g <pkg>` (no `@latest` literal but bun resolves an unsuffixed package to `@latest`). For install that's by design — there's no installed version to read a channel from. The fresh-install default-channel question is a separate concern; tracked at [hub#337](https://github.com/ParachuteComputer/parachute-hub/issues/337).

### Cross-references

- [hub#332](https://github.com/ParachuteComputer/parachute-hub/issues/332) — closes.
- [governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md) — RC versioning convention.

## [0.5.13-rc.16] - 2026-05-23

**fix(hub): update operator-facing help text post-Notes-as-app migration.**

Aaron's audit script ([`parachute-patterns/scripts/audit-canonical-refs.sh`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/scripts/audit-canonical-refs.sh)) flagged four operator-facing references in `src/help.ts` (the output of `parachute install --help`, `parachute setup --help`, `parachute status --help`) that still framed `parachute install notes` as the canonical install path. Post-Notes-as-app migration (Phase 2, 2026-05-21), the canonical path is `parachute install app` — the host module that auto-bootstraps Notes under `/app/notes` on first `parachute-app serve` (parachute-app §17 Phase 2.1). The notes-daemon (`parachute install notes`) still works for back-compat but is no longer the recommended path.

### What landed

- **`installHelp` examples (`src/help.ts:70-72`)** — `parachute install app # installs app (auto-bootstraps Notes)` now leads; the legacy `parachute install notes` line moved below and is annotated as `back-compat: legacy notes-daemon (Phase 2 deprecating)`.
- **`setupHelp` description (`src/help.ts:96`)** — `(vault, notes, scribe; channel is exploratory …)` → `(vault, app, scribe; channel is exploratory …)`.
- **`setupHelp` description (`src/help.ts:103`)** — `summary banner with the running URLs (hub, vault, notes, scribe)` → `(hub, vault, app, scribe)`.
- **`statusHelp` example (`src/help.ts:156-159`)** — example row replaced from a stopped `parachute-notes` daemon at port 1942 → a running `parachute-app` at port 1946 with the canonical `/app/notes` URL. Version pinned to `0.2.0-rc.4` (current published `@openparachute/app@latest` on npm; local checkout is rc.7 but the example mirrors what an `npm install` operator would see).

### Intentionally not touched

- **`notes-serve.ts:135`** — error message text mentioning `parachute install notes` (back-compat path is still wired; the error fires from `parachute install notes` itself when notes can't be resolved, so the hint is correct in context).
- **Test files referencing port 1942 (`status.test.ts`, `setup.test.ts`, `hub-server.test.ts`, etc.)** — these exercise the daemon back-compat code paths and should continue testing them.
- **`hub-settings.ts:16` historical motivator comment** — narration of the original onboarding arc, not operator-visible.
- **Launch-day docs** (`LAUNCH_SMOKE.md`, `BETA-EMAIL-launch-day.md`, `RELEASE-NOTES-launch-day.md`) — historical reference per workspace `CLAUDE.md`.

### Tests

`bun run typecheck` clean. `bun test ./src` — passing, count unchanged (no test assertions on the exact help-text strings that changed; `cli.test.ts` uses loose regex matchers like `/parachute install/` which still pass).

### Cross-references

- Audit script catch: [`parachute-patterns/scripts/audit-canonical-refs.sh`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/scripts/audit-canonical-refs.sh) — first block (`parachute install notes`) + fourth block (hardcoded port 1942 outside parachute-notes).
- Notes-as-app migration arc: [`parachute-patterns/migrations/2026-05-21-notes-as-app.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/migrations/2026-05-21-notes-as-app.md).
- [parachute-notes#154](https://github.com/ParachuteComputer/parachute-notes/issues/154) — notes-daemon deprecation arc.
- [#324](https://github.com/ParachuteComputer/parachute-hub/pull/324) — wizard switched to install app (sibling cleanup).
- [#326](https://github.com/ParachuteComputer/parachute-hub/pull/326) — notes module tagline cleanup (sibling audit catch).
- parachute-app §17 Phase 2.1 — `bootstrap-default-apps` auto-installs notes-ui under `/app/notes`.

## [0.5.13-rc.15] - 2026-05-22

**fix(hub): auto-drop legacy short-name rows in services.json on read (rescues operators tripped by parachute-app#13 / parachute-runner#4).**

Aaron walked a fresh install on 2026-05-22 and hit `duplicate port 1946 — claimed by both "parachute-app" and "app"`. Root cause was upstream: parachute-app's self-register (pre-app#13) wrote a row keyed by the short name `"app"`, while hub's install path stamped a row keyed by `"parachute-app"` (the canonical `manifestName`). The two rows shared a port, tripped read-side `assertNoDuplicatePorts`, and left services.json unbootable until the operator hand-edited the file. parachute-runner had the same shape (fixed in runner#4). The new [`parachute-patterns/patterns/services-json-row-conventions.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/services-json-row-conventions.md) doc captures the convention so future modules don't recreate it.

**The fix.** Hub's install path was already writing `name: manifestName` correctly (verified against [hub#324](https://github.com/ParachuteComputer/parachute-hub/issues/324)'s KNOWN_MODULES[`app`] entry → `entryName = spec.manifestName` → seed-row `name: manifest.manifestName`); no install-time change was needed. The remaining concern was the on-disk legacy state Aaron and other early operators were left holding. Hub now auto-heals on read:

- **`dropLegacyShortNameRows` in `src/services-manifest.ts`** runs before shape validation. For every same-port row pair, if one is named `parachute-<X>` and the other is named `<X>` (same `<X>`), drop the short-name row. The cleaned shape is re-validated, the file is rewritten on disk, and a one-line warning lands on stderr citing the affected name + the pattern doc.
- **Idempotent.** A second `readManifest` against the cleaned file is a no-op (no rewrite, no warning).
- **Narrow heuristic.** Only fires on structural matches (`parachute-X` ↔ `X` at the same port). A deliberate third-party row literally named `"app"` on a different port is left alone. A `parachute-app` + `agent` collision on the same port (Aaron's ambient case, unrelated stale row from the retired agent module) still throws the normal duplicate-port error — that's a separate problem with its own resolution.

**Intentionally not addressed.**

- The `NOTES_FALLBACK.manifest.name = "notes"` and `CHANNEL_FALLBACK.manifest.name = "channel"` short-name shapes in `src/service-spec.ts` are correct per the `ModuleManifest` schema (`name` IS the short identifier; `manifestName` is the services.json key). Seed-row writes through `seedEntryFromManifest` pull `manifest.manifestName`, not `manifest.name`. No change needed.
- Operators on a lone short-name row (no manifestName twin) keep working unchanged — auto-rewriting standalone legacy names would surprise operators who hand-edit services.json deliberately. The de-dupe intervenes only when the duplicate would otherwise break reads.

**Tests.** Six new cases in `src/__tests__/services-manifest.test.ts` under `legacy short-name row de-dupe`: drops the short-name twin on a port match (`parachute-app` + `app` → keeps `parachute-app`); rewrites the file on disk so the next read is clean; leaves a lone short-name row alone; leaves a deliberate third-party short-name row on a different port alone; lets a non-matching same-port collision (`parachute-app` + `agent`) still throw `duplicate port` (different problem class); idempotent second read no-ops (mtime unchanged). `bun test ./src` → 1874 pass, 0 fail. `bun run typecheck` clean.

**Cross-refs.** [parachute-app#13](https://github.com/ParachuteComputer/parachute-app/pull/13) + [parachute-runner#4](https://github.com/ParachuteComputer/parachute-runner/pull/4) (the symmetric self-register fixes that resolved the upstream bug); [parachute-patterns#77](https://github.com/ParachuteComputer/parachute-patterns/pull/77) (the pattern doc); [hub#324](https://github.com/ParachuteComputer/parachute-hub/pull/324) (the PR that added `app` to KNOWN_MODULES — hub's install side was correct, the duplicate originated upstream).

**Amendment — also clean retired-module rows ([hub#334](https://github.com/ParachuteComputer/parachute-hub/issues/334)).** The legacy-short-name de-dupe above handles the `parachute-<X>` ↔ `<X>` self-register pattern, but it didn't resolve Aaron's actual reproducer: his services.json carried a stale `agent` row (parachute-agent was retired 2026-05-20) at port 1946 colliding with the new `parachute-app` row at the same port. `agent` is not the short-name twin of `parachute-app`, so the legacy-short-name pass left both rows alone and the duplicate-port read gate still tripped. Bundling the retired-row fix into rc.15 because both changes are services.json-load-time de-dupe hygiene with the same shape — a reviewer can land them together. Added auto-cleanup of services.json rows for retired modules (e.g. `agent`, retired 2026-05-20). Hub now drops these rows on load with a warning + replacement hint. Closes [hub#334](https://github.com/ParachuteComputer/parachute-hub/issues/334).

- **`RETIRED_MODULES` registry in `src/service-spec.ts`**: `Record<string, { retiredAt: string; replacement?: string }>` next to `KNOWN_MODULES`. Initial entry: `agent` (retired 2026-05-20, replacement `parachute-app or parachute-runner`). Curation note in the JSDoc: only add a name here when the module is *explicitly* retired (see `parachute-patterns/migrations/`). `notes` (the daemon, deprecating Phase 2 as of 2026-05-22) is *not* added — its retirement waits for Phase 3.
- **`dropRetiredModuleRows` in `src/services-manifest.ts`** runs before `dropLegacyShortNameRows` (order matters — removing a retired row might unmask a legacy-short-name pair underneath). Retirement is unconditional — a retired row is dropped whether or not anything else collides with it. Per-row stderr warning cites the retirement date, names the replacement (when one exists), and includes a `ps aux | grep parachute-<name>` snippet so operators can stop a still-running legacy daemon.
- **Five new tests** in `src/__tests__/services-manifest.test.ts` under `retired-module row de-dupe (hub#334)`: drops a row named `agent`; retirement is unconditional (no collision partner required); no-op on a clean manifest; Aaron's reproducer (`agent + parachute-app` at port 1946) resolves to just `parachute-app`; interaction — a manifest with both a retired row AND a legacy-short-name pair has both cleaned in the correct order.
- **Cascade-renamed `"agent"` to `"someapp"`** in unrelated test fixtures (`lifecycle.test.ts`, `hub-server.test.ts`, `install.test.ts`, `status.test.ts`, `scope-registry.test.ts`, and the duplicate-port + upsert sections of `services-manifest.test.ts`) where the literal name was being used as a generic third-party module placeholder. With `agent` now in `RETIRED_MODULES`, those rows would be GC'd mid-test; renamed to `someapp` (not a real module) to keep the tests testing what they were testing.
- **`claw → agent` migration tests updated** to reflect that the rewritten `agent` row is now dropped by the retired-module GC on the subsequent read — the claw migration is effectively a one-step retirement (`claw → agent → dropped`).

`bun test ./src` → 1880 pass, 0 fail. `bun run typecheck` clean.

## [0.5.13-rc.14] - 2026-05-22

**feat(hub): `kind` field no longer validated in module.json (closes [#301](https://github.com/ParachuteComputer/parachute-hub/issues/301) Phase A more aggressively than initially planned; folded per [#327](https://github.com/ParachuteComputer/parachute-hub/issues/327) into rc.14).**

The `kind ∈ {"api" | "frontend" | "tool"}` trichotomy conflated two concerns: "is this served as static UI?" and "what's the module's role?" In practice hub only branches on `kind === "frontend"` (in `commands/upgrade.ts`, to decide whether to run `bun run build`); api-vs-tool is observationally identical. Per Aaron's direction on the [#301](https://github.com/ParachuteComputer/parachute-hub/issues/301) Phase A fold ([#327](https://github.com/ParachuteComputer/parachute-hub/issues/327)): stop validating it entirely. The field is no longer enforced — present, absent, valid, typo'd, wrong-typed, all accepted. Routing branches downstream use `=== "frontend"` style checks which gracefully handle undefined/other values as the backend-proxy default.

**What landed (vs the rc.13 → rc.14 in-flight version).**

- **`asKind` in `src/module-manifest.ts`** is now a pass-through narrower: returns the value if it's one of `"api" | "frontend" | "tool"`, otherwise returns `undefined`. No throws, no warnings. The validator no longer inspects the field's intent.
- **`ModuleManifest.kind` is now optional** in the type. The single downstream read site (`commands/upgrade.ts:376` — `target.spec?.kind === "frontend"`) gracefully treats undefined and other values as the backend-proxy default.
- **`ServiceSpec.kind` is now optional** in `src/service-spec.ts` to mirror the manifest relaxation. Same downstream consumer, already-graceful handling.
- **Removed the soft-warning log line.** The initial rc.14 version (soft-warn approach) defaulted missing kind to `"api"` and emitted a warning. Per Aaron's fold direction: missing kind is genuinely fine, not a "you should know" situation, so the warning is gone too.
- **`validateModuleManifest` + `readModuleManifest` retain the optional `logger` parameter** for forward-compatibility with future validator soft-warnings, even though the kind warning it was originally added for has been removed.

**Why this unblocks app.** parachute-app's `0.2.0-rc.5` shipped `.parachute/module.json` without `kind`. The validator's pre-fold strict-require turned that into a boot-time crash. App's `0.2.0-rc.6` (now correcting to `kind: "api"` per the routing-semantics fold in app#14 — app is a backend that proxies, not a static-served frontend) is unblocked once hub rc.14 propagates; future app releases can drop the field entirely.

**Out of scope (intentional).**

- Phases B–D from [#301](https://github.com/ParachuteComputer/parachute-hub/issues/301): the explicit `static: boolean` field, per-module migrations (notes/vault/scribe/runner dropping `kind`), and the eventual full removal of `kind` from the manifest schema. Phase A — now the validator no longer inspects the field — is the validator-side surface area only.

**Tests.** Renamed suite to `kind is no longer validated (hub#327)` in `src/__tests__/module-manifest.test.ts` — six cases covering: missing kind → undefined; explicit `frontend` / `api` / `tool` pass through; invalid values (`"static"`, `"backend"`, `null`, `42`) also accepted (narrowed to `undefined`); defensive check that `kind === "frontend"` still survives the validator (the one routing branch in `commands/upgrade.ts` intact). `bun run typecheck` clean. `bun test ./src` — passes. `cd web/ui && bun run test` unchanged.

## [0.5.13-rc.13] - 2026-05-22

**fix(hub): notes module tagline reflects deprecation (caught by audit script post-cleanup).**

The `notes` entry in `NOTES_FALLBACK` (`src/service-spec.ts`) carried the pre-migration tagline `"Notes PWA backed by your vault."`, which made sense when notes-daemon was the canonical install path. Post-Notes-as-app migration (notes-daemon deprecation tracked in parachute-notes#154; wizard switched to `app` in #324), the tagline is stale — operators scanning the discovery surfaces shouldn't see notes-daemon framed as the canonical PWA. Audit script flagged it post-cleanup-wave as one of the last operator-visible stale refs.

**What landed.**

- **`NOTES_FALLBACK.manifest.tagline`** in `src/service-spec.ts:296` updated to `"Notes PWA — daemon deprecated 2026-05-22; install `app` for the current path."`. Telegraphs the deprecation + points operators at `parachute install app` (which auto-bootstraps notes-ui under `/app/notes` via parachute-app §17 Phase 2.1). Mirrors the tone the retired `parachute-agent` spec used before it was removed from the fallbacks.
- **Assertion sites in `src/__tests__/well-known.test.ts:364, 371`** updated to match the new copy. The test exercises tagline-pass-through behavior; the literal string was incidental but had to track the spec.

**Out of scope (intentional).**

- The rest of the `NOTES_FALLBACK` entry (port `1942`, paths `["/notes"]`, health, startCmd, postInstallFooter). The daemon is still installable for back-compat — only the operator-facing tagline copy changed. Full daemon retirement lands in parachute-notes#154 Phase 3 once `app` is fully shipped and the redirect window (hub#316) is no longer load-bearing.

**Tests.** `bun run typecheck` clean. `bun test ./src` — passing, count unchanged. `cd web/ui && bun run test` unchanged. `bunx biome check src/` clean.

**Cross-references.** Audit script catch post-cleanup-wave. parachute-notes#154 — notes-daemon deprecation. #324 — wizard recommends `app` over notes-daemon (the previous rc in this chain). parachute-app §17 Phase 2.1 — bootstrap-default-apps auto-installs notes-ui.

## [0.5.13-rc.12] - 2026-05-22

**fix(hub): wizard prompts to install app (not notes-daemon) — auto-bootstrap handles notes-ui (#323).**

The setup wizard's done-step install tiles still telegraphed `notes` as the canonical first install — operators walking through saw an "Install Notes" tile, i.e., the notes-daemon. With the Notes-as-app migration in progress (notes-daemon deprecation tracked in parachute-notes#154; parachute-app §17 Phase 2.1 auto-bootstraps `@openparachute/notes-ui` as a sub-unit on first `parachute-app serve` boot) the wizard should prompt `app` instead. App's bootstrap-default-apps step then installs notes-ui under `/app/notes` automatically, so the operator gets Notes-the-UX without having to know about the daemon-vs-app split.

**What landed.**

- **`INSTALL_TILE_PROPS` in `src/setup-wizard.ts`** swaps the first tile from `notes` → `app`. Tagline telegraphs the auto-bootstrap so the architecture is legible from the wizard ("Host module for Parachute UIs — auto-installs Notes on first boot."). Order preserved: app → scribe.
- **`CURATED_MODULES` in `src/api-modules.ts`** now lists `["vault", "app", "notes", "scribe", "runner"]`. App slots between vault and notes — `notes` stays curated as the back-compat install path for operators on pre-app architecture (`/api/modules/notes/install` + `parachute install notes` still work). The wizard tile is what changed; the install surface kept the broader compatibility lane.
- **`KNOWN_MODULES["app"]` in `src/service-spec.ts`** carries the bootstrap data the install pathway needs pre-self-register: `package: "@openparachute/app"`, `manifestName: "parachute-app"`, `canonicalPort: 1946`, `kind: "frontend"`, `canonicalPaths: ["/app", "/.parachute"]`, `canonicalHealth: "/app/healthz"`, `extras.hasAuth: true` (app's `/app/admin` + per-UI surfaces gate behind hub-issued JWTs per design doc §6), `extras.startCmd: () => ["parachute-app", "serve"]` (backward-compat fallback for rows without `installDir`). Post-install, `<installDir>/.parachute/module.json` is authoritative — KNOWN_MODULES is just the pre-install bootstrap shape.
- **`PORT_RESERVATIONS`** entry added: `{ port: 1946, name: "parachute-app", status: "assigned" }`. Status `assigned` keeps the `assignPort` fallback walker from handing 1946 to a colliding third-party module.
- **`parachute setup` CLI BLURBS** in `src/commands/setup.ts` add `app` + `runner` entries the table had been missing. App's blurb telegraphs the "recommended over notes-daemon" framing; notes's blurb adds the "(notes-daemon; superseded by `app`)" suffix.

**Out of scope (intentional).**

- Removing `notes` from `CURATED_MODULES`. Notes-daemon stays installable for operators on pre-app architecture — only the wizard's recommendation surface changed. The full daemon retirement lands in parachute-notes#154's Phase 3 once `app` is fully shipped and the redirect window (hub#316) is no longer load-bearing.

**Tests.** `bun run typecheck` clean. `bun test ./src` 1862 pass (was 1861; +1 net — added the `app row carries package + display props from KNOWN_MODULES` test; updated the wizard done-screen tile test (app+scribe, asserting Notes is no longer surfaced + app sits before scribe in render order), the wizard already-installed test (seeds `parachute-app` instead of `parachute-notes`), the wizard op-poll test (`?op_app=<id>` instead of `?op_notes=<id>`), the api-modules curated-list test (vault → app → notes → scribe → runner), the port-assign third-party-walks test (1947 instead of 1946 because 1946 is now assigned to parachute-app), and the setup CLI all-installed test (seeds `parachute-app` alongside the other shorts). `cd web/ui && bun run test` 188 pass (unchanged — no SPA copy mentions Notes-as-first-install). `bunx biome check src/` clean.

**Cross-references.** Issue hub#323 (this PR). parachute-notes#154 — notes-daemon deprecation. parachute-app §17 Phase 2.1 — bootstrap-default-apps. hub#316 — `/notes/*` → `/app/notes/*` 301 redirect (Phase 2 of the migration arc). The wizard tile change is the last operator-facing surface that recommended notes-daemon as the canonical first install — every other surface (`/api/modules` install catalog, `/.well-known/parachute.json`, the discovery page) now ride on services.json + module.json, which app self-registers on boot.

## [0.5.13-rc.11] - 2026-05-22

**fix(hub): consent surfaces stale `assigned_vault` cleanly with picker fallback (#284).**

Multi-user Phase 2 polish surfaced during the hub#283 reviewer pass. A user has `assigned_vault: "default"` pinned on their row; an admin later removes the "default" vault from services.json (uninstall, rename, retire) without reassigning the user. Pre-rc.11 the user landed on `/oauth/authorize`, the locked-picker UI rendered the missing name, the form posted it, and `handleConsentSubmit` rejected the submission with a generic 400 reading `vault "default" is not registered on this host`. The user couldn't tell whether hub itself was broken, whether their account was misconfigured, or whether they should call the admin — the failure had no actionable signal.

**What landed.**

- **GET handler stale-detect.** `consentProps` (`src/oauth-handlers.ts`) compares the user's `assignedVault` against the live `listVaultNames(manifest)` and sets a new `staleAssignedVault` prop when the named vault is missing. The consent template renders a `<p class="stale-assignment-banner" role="alert">` above the scope list with the copy "**Your assigned vault was removed.** The vault `<name>` is no longer registered on this hub. Ask the hub admin to reassign you to an existing vault via `/admin/users`, then try signing in again."
- **Picker pivot.** When stale, the vault-picker section renders the no-vaults-available shape (`availableVaults: []`, no `lockedVault`) rather than the locked-picker rendering the missing name. The Approve button renders disabled — the user has no valid mint path until admin remediation, so the only viable next steps are Deny (which propagates `error=access_denied` back to the client) or close the tab and contact the admin.
- **Approve-stays-enabled fallback for non-vault scopes.** When the requested scope is vault-free (e.g. `scribe:transcribe`), the banner still surfaces for visibility but Approve stays enabled — the user can still consent to non-vault access without a working assignment. New `blockApproveForStaleAssignment` prop captures this distinction: set true only when the request has an unnamed `vault:<verb>` OR a named `vault:<assignedVault>:<verb>` scope. The picker fallback path's answer to "does it work if user has no permitted alt?" is: yes for non-vault scopes; for vault scopes the picker section reads "no vaults available" + Approve is gated until admin remediation.
- **POST handler defense.** `handleConsentSubmit` carries the same admin-remediation hint at both server-side defense sites — the picker-driven `validNames.includes(pickedVault)` check at oauth-handlers.ts:988 AND the named-scope mismatch site at line 1041. The picker site narrows the special-case to "pickedVault === assignedVault" (a hand-crafted POST naming a never-existed vault still hits the generic "Unknown vault" 400). The named-scope site fires when scope `vault:<assigned>:<verb>` would mint a token pointing at a vault that doesn't exist. Both return the new "Assigned vault was removed" 400 with body naming the stale name + the `/admin/users` remediation hint, matching the GET path's banner copy so the picker-bypass POST and the natural form-render arrive at the same recovery story.
- **Security posture preserved.** Stale-assignment does NOT relax the picked-must-match-assigned check or let the user pick any other vault. Doing so would let assignment-binding be circumvented by getting an admin to remove the assigned vault. Stale-assignment is an admin-remediated state, not a self-service vault-pick override.

**Tests.** `bun run typecheck` clean. `bun test ./src` 1856 pass (was 1848; +8 — 5 in the new `handleAuthorizeGet — stale assigned_vault surfaces banner` describe covering unnamed-vault-scope + named-vault-scope + non-vault-scope + admin-user-never-banners + intact-assignment-pre-#284-clean, 3 in `handleAuthorizePost — stale assigned_vault clean 400` covering picker-bypass POST + never-existed-vault-still-generic + named-stale-scope-refused). `cd web/ui && bun run test` 188 pass (unchanged — SPA admin list flag deferred to Phase 2 per the issue's "Optional for this PR" scope). `bunx biome check src/` clean.

**Cross-references.** Issue hub#284 — surfaced during hub#283 reviewer pass. Multi-user Phase 1 design doc `parachute.computer/design/2026-05-20-multi-user-phase-1.md`. The decision-pin "server-side defense refuses mints whose POST disagrees with assigned_vault rather than silent overwrite" (PR 4 of Phase 1) is the framing this PR's stale-assignment defense rides on — same posture, sharper user-facing copy. Admin-side surfacing (red badge in `/admin/users` SPA list flagging users with stale `assigned_vault`) deferred to Phase 2 per the issue body.

## [0.5.13-rc.10] - 2026-05-22

**feat(hub): rate-limit `/login` + `/account/change-password` against brute-force / credential-stuffing (#282).**

Auth-surface hardening surfaced during the hub#281 reviewer pass. The `/login` per-IP rate-limit floor (5 attempts / 15 min, hub#188) had already landed; this PR completes the auth-surface sweep by adding a parallel per-user floor on `/account/change-password`, which is the only other interactive POST that calls `argon2id` verify. Threat shape on change-password is different from /login — the endpoint is session-gated, so the worry isn't open-internet brute-force; it's a compromised session (stolen cookie) hammering verifications against the current password without bound.

**What landed.**

- **`RateLimiter` class** in `src/rate-limit.ts`. The sliding-window algorithm from hub#188 lifted out of the module-level singleton into a class with constructor-parameterized `maxAttempts` + `windowMs`. Each instance owns its own bucket map — limiters with different capacities don't share state. Existing `checkAndRecord` / `__resetForTests` top-level exports stay as backward-compat shims for hub#188's `/login` call sites + tests.
- **`loginRateLimiter` singleton.** Per-IP, 5 attempts per 15 min (`MAX_ATTEMPTS` / `WINDOW_MS`). Same behavior as before the refactor; wired into `handleAdminLoginPost` via the backward-compat `checkAndRecord` shim — no change at the call site.
- **`changePasswordRateLimiter` singleton.** Per-user, 3 attempts per 5 min (`CHANGE_PASSWORD_MAX_ATTEMPTS` / `CHANGE_PASSWORD_WINDOW_MS`). Tighter than `/login` because the legitimate-user path here is "I'm rotating my password" — typing the current password wrong 3 times in 5 minutes is already an outlier, and a session-hijack attacker shouldn't get a 5-shot grind window against argon2id.
- **`/account/change-password` POST wired** (`src/api-account.ts`). Gate fires *after* CSRF (so a junk cross-site POST doesn't burn a bucket slot for the victim's session) but *before* `verifyPassword`. Keyed by `user.id` rather than IP because the endpoint is session-gated — identity is already established, and keying by user-id means an attacker rotating egress IPs against the same stolen cookie can't get fresh buckets per IP. 429 response carries `Retry-After: <seconds>` header and re-renders the change-password form with an inline `"Too many password-change attempts. Try again in N seconds."` banner — same UX shape as the existing `/login` 429 path.
- **IP extraction stays as-is** (`clientIpFromRequest`): `CF-Connecting-IP` → `X-Forwarded-For` first hop → `UNKNOWN_IP_SENTINEL`. Documented assumption: hub trusts these headers when set, which means hub MUST be behind a reverse proxy (cloudflared, nginx) that strips them from external requests. Direct-loopback callers without these headers fall through to the sentinel, which is the intended bound (all curl-from-same-host requests share one bucket).

**Tests.** `bun run typecheck` clean. `bun test ./src` 1848 pass (was 1836; +12 — 9 in the rate-limit suite covering the new `RateLimiter` class shape + the `changePasswordRateLimiter` singleton's configured thresholds, 4 in `api-account` covering the wired gate: exhaustion → 429, per-user independence, gate-fires-before-argon2id timing pin, CSRF-failure-does-not-burn-bucket invariant). `bunx biome check src/` clean.

**Cross-references.** Issue hub#282. Threat-model framing from the hub#281 reviewer's pass: "A compromised session (stolen cookie) could hammer argon2id verifications against the current password without bound." Bucket-parameter choice rationale lives in the `rate-limit.ts` header docstring + the inline comment at the wire site in `api-account.ts`. Config-via-env-var deferred — code constants are the v0.6 shape per the issue's "low-medium priority" framing; hub_settings overrides land if operators report tuning needs.

## [0.5.13-rc.9] - 2026-05-22

**feat(hub): `/notes/*` → `/app/notes/*` redirect (Phase 2 of Notes migration arc).**

Phase 2 of the Notes-as-app migration (parachute-app design doc §16). The notes-daemon retires over four phases; this PR adds the hub-side redirect window so operators with existing `/notes/*` bookmarks transparently land on the apps-hosted Notes (`parachute-app add @openparachute/notes-ui --name notes --path /app/notes`). Phase 3 (parachute-notes v0.5) retires the redirect entirely once the legacy daemon is fully decommissioned.

**What landed.**

- **`/notes`, `/notes/`, `/notes/*` → 301 → `/app/notes[/...]`.** Method-agnostic, matches the shape of the existing back-compat 301s in hub-server's dispatch. Query string is preserved verbatim. The new redirect block sits between the legacy `/admin/login`-style 301s and the CORS preflight handler — it fires before the generic services.json proxy (which is where `/notes/*` would otherwise route to notes-daemon).
- **`hub_settings.notes_redirect_disabled` opt-out flag.** Default `false` (redirect on); set to `true` to skip the redirect and fall through to the legacy services.json proxy. The escape hatch covers the deprecation-window case where an operator runs notes-as-module without parachute-app installed yet — without the opt-out they'd hit redirect → 404. Stored as `"true"` / absent-row in the bare KV `hub_settings` table; `setNotesRedirectDisabled(false)` clears the row rather than writing `"false"` so the canonical "redirect on" default is an absent-row state. New helpers: `isNotesRedirectDisabled`, `setNotesRedirectDisabled`.
- **Throttled migration log.** `[notes-migration] redirect /notes/foo → /app/notes/foo` fires on each hit, throttled per-path to one line per 60 seconds — operators see migration activity without flooding stdout if a misconfigured PWA loops.
- **Boundary check on the match predicate.** `/notes`, `/notes/`, `/notes/*` match; `/notesy`, `/notes-archive`, `/vault/default/notes` do NOT (the prefix-with-no-boundary case that would otherwise capture unrelated paths).
- **Lazy DB read.** The dispatch only consults `getDb` when the path actually matches a legacy notes prefix — every non-notes request still skips the DB entirely (the `/health` route + several CORS preflight tests assert this).

**Tests.** `bun run typecheck` clean. `bun test ./src` 1836 pass (was 1805; +31 — 5 in hub-server's redirect-routing block, 22 in the new notes-redirect helper suite, 4 in hub-settings for the new flag). `cd web/ui && bun run test` 188 pass (unchanged — SPA not touched). `bunx biome check src/` clean.

**Cross-references.** parachute-app design doc §16 names the four-phase Notes migration; this PR lands Phase 2. The opt-out flag retires when Phase 3 ships (parachute-notes v0.5 fully retires the module form + the redirect goes away).

## [0.5.13-rc.8] - 2026-05-22

**feat(hub): ServiceEntry hierarchical `uis` schema extension (#313) — parachute-app sub-unit discovery.**

Foundational schema work for parachute-app (per parachute-app design doc §12). apps wants hub's discovery surfaces — the well-known doc + admin SPA Modules view — to render the App module with each hosted UI (Gitcoin Brain, Unforced Brain, …) expanded as a sub-row, mirroring the per-instance shape vault already gives for `/vault/default`, `/vault/work`, etc. Today services.json entries are flat (`paths: ["/vault/default", "/vault/gitcoin"]`); this PR teaches the schema to carry display metadata per sub-unit so the discovery row can show a name + icon + status, not just a path.

The extension is purely additive: existing flat entries (vault / scribe / notes / runner) continue to round-trip byte-identically — the `uis` field is optional throughout the read + write paths.

**What landed.**

- **`ServiceEntry.uis: Record<string, UiSubUnit>` on `src/services-manifest.ts`.** New `UiSubUnit` type carries `displayName` + `path` (required) plus optional `tagline`, `iconUrl`, `version`, `oauthClientId`, and `status` (`"active" | "pending-oauth" | "disabled"`). Validation runs in `validateEntry` → `validateUis` → `validateUiSubUnit`; the error messages name the offending sub-unit key so operators with N rows can jump straight to the offender.
- **Well-known doc surfaces the sub-units.** `WellKnownServicesEntry.uis?: WellKnownUiSubUnit[]` mirrors the on-disk shape with the map key promoted to `name` and `path` joined onto the canonical origin into a deep-linkable `url`. `iconUrl` follows the same path-or-absolute-URL rule the services-level `uiUrl` uses. Empty map → field omitted (keeps the public contract tight); absent `uis` → field omitted (pre-#313 byte-identical for every existing module).
- **`GET /api/modules` surfaces `uis: UiSubUnitWireShape[]` per row.** Snake-case wire keys (`display_name`, `oauth_client_id`, `icon_url`) to match the surrounding response. Empty array when the row doesn't declare `uis` — uniform shape across modules so the SPA can `.map` unconditionally.
- **Admin SPA Modules view renders a `<details>`-wrapped "Hosted UIs" section per installed module with sub-units.** Each sub-row shows icon + displayName + path (same-origin anchor, not `<Link>` — the sub-unit lives outside the SPA's basename) + tagline + a status badge using the existing `status-<state>` class palette. Status falls back to `"active"` when absent. Empty / absent `uis` → section omitted entirely.

**UiSubUnit shape (the canonical contract):**

```ts
export interface UiSubUnit {
  displayName: string;
  tagline?: string;
  path: string;
  iconUrl?: string;
  version?: string;
  oauthClientId?: string;
  status?: "active" | "pending-oauth" | "disabled";
}
```

`oauthClientId` is the load-bearing field for app's "install-once, multi-vault" pattern (design doc §6): each hosted UI gets its own OAuth client at install time, the operator sees the id verbatim on the approval surface, and revoking the client retires the UI's access in one shot without touching siblings.

**Out of scope (deliberate).** Vault still uses flat `paths: ["/vault/default", "/vault/gitcoin"]`; a future PR can migrate vault to the hierarchical shape for per-instance display metadata. The flat shape continues to work through hub's existing path-prefix routing — the point of this PR is to make the hierarchical option available, not to retire the flat one.

**Tests.** `bun run typecheck` clean (root + `web/ui`). `bun test ./src` 1805 pass (was 1781; +24 — 13 in services-manifest, 8 in well-known, 3 in api-modules). `cd web/ui && bun run test` 188 pass (was 183; +5 covering the SPA's Hosted UIs section across empty, populated, status-badge, icon, and sub-unit-count cases). `bunx biome check src/` clean.

## [0.5.13-rc.7] - 2026-05-22

**feat(hub): mark same-hub DCR clients for auto-trust (#312) — parachute-app integration.**

Foundational for parachute-app's friend-deploy story (per parachute-app design doc §6 + apps Phase 2.0): apps installs UIs by calling hub's DCR endpoint with the operator bearer; hub now records those as "same-hub" and skips the consent screen at `/oauth/authorize` for non-admin scopes. The operator who installed the app IS the implicit consent for each UI it registers — a per-UI consent click was friction without security value.

This generalizes hub#270's "auto-approve first OAuth client after wizard" — now any same-hub app auto-approves, not just the first.

**What landed.**

- **Migration v9.** Adds `INTEGER NOT NULL DEFAULT 0` column `same_hub` to the `clients` table. Pre-existing rows backfill to 0 (the safe default — they keep requiring consent).
- **DCR registration (`POST /oauth/register`).** Marks new clients `same_hub=true` when the registrant authenticated as the operator: bearer with `hub:admin` (the install-time path used by parachute-app + first-party modules) OR session-cookie + same-origin POST (the operator's own browser). Wizard-window auto-approve (#268) does NOT set same_hub — that path approves an external registrant, doesn't claim ownership. The response body echoes `same_hub` so callers can verify the marker landed.
- **Authorize gate (`GET /oauth/authorize`).** New silent-approve gate after the existing scope-coverage gate (#75): when `client.same_hub === true` AND no requested scope is admin-level AND no unnamed vault verb is present (picker still needed for those), the consent HTML is skipped and the auth code minted immediately. A `grants` row is also recorded so subsequent flows hit the standard #75 path uniformly. Logged as `[oauth] auto-approved same-hub client client_id=<id> user_id=<id> scopes=<list>` for audit.
- **Admin SPA surface.** `/api/oauth/clients/<id>` adds `same_hub: boolean` so future per-client SPA badging (same-hub vs external) can read it directly.

**Auto-approve rule (the load-bearing conditional in `handleAuthorizeGet`):**

```ts
const hasAdminScope = requestedScopes.some(scopeIsAdmin);
if (client.sameHub && !hasAdminScope && !hasUnnamedVault) {
  console.log(`[oauth] auto-approved same-hub client ... (hub#312)`);
  recordGrant(db, session.userId, client.clientId, requestedScopes);
  return issueAuthCodeRedirect(db, parsed, requestedScopes, session.userId, deps);
}
```

Admin scopes (`hub:admin`, anything `scopeIsAdmin` returns true for) stay on the consent path — even for same-hub clients, the operator should still click for high-power. `parachute:host:admin` + per-vault `vault:<name>:admin` are non-requestable so they never reach this gate anyway.

**Backwards compatibility.** Migration backfills every pre-existing row to `same_hub=0`. They continue to require consent for everything — the safe default. Operators who want to upgrade an existing client to same-hub trust will need a future admin action (out of scope for this PR; the SPA's existing approve-client view doesn't currently expose same_hub editing). The 13 new tests in `DCR same-hub auto-trust (hub#312)` cover the full matrix: DCR marker for each auth path, authorize gate for each scope shape, migration backfill, and audit log emission.

**Tests.** `bun run typecheck` clean. `bun test ./src` 1781 pass (was 1767; +14 — 13 in the new same-hub describe block, 1 in admin-clients). `bunx biome check src/` clean. SPA tests unchanged — no SPA route changes in this PR.

## [0.5.13-rc.6] - 2026-05-21

**refactor(hub): retire VAULT/SCRIBE/RUNNER FALLBACKs — modules now self-register canonically.**

Closes the endgame of the FIRST_PARTY_FALLBACKS arc: vault (vault#356, 0.4.8-rc.4), scribe (scribe#50, 0.4.4-rc.4), and runner (runner#3, 0.1.0-rc.4) each now write their own services.json row at boot via filesystem-direct `selfRegister`. Hub previously vendored a `*_FALLBACK` entry per module so the bun-link dev case (module on disk, never booted) still rendered in the admin SPA catalog and could be installed; now those entries retire — services.json is the canonical source for installed modules, and `module.json` (read from `<installDir>/.parachute/module.json`) is the canonical source for the static manifest.

**What's removed.** `VAULT_FALLBACK`, `SCRIBE_FALLBACK`, `RUNNER_FALLBACK` are gone from `FIRST_PARTY_FALLBACKS` in `src/service-spec.ts`. The remaining entries are `NOTES_FALLBACK` (frontend with a hub-side static-serve shim; retires once notes self-registers, notes#105) and `CHANNEL_FALLBACK` (exploration tier; may retire before it ever ships module.json).

**What replaces them.** A new `KNOWN_MODULES` table carries the minimum hub needs pre-self-register: npm package + manifestName + canonical port / paths / health / kind + display props + imperative `extras` (vault's `init`, scribe's `postInstallFooter`, vault's `/mcp` URL suffix, hasAuth posture). The static-manifest fields are deliberately separate from FIRST_PARTY_FALLBACKS so a future re-introduction of vendored manifest data has to be explicit. `synthesizeManifestForKnownModule(km)` synthesizes a minimal `ModuleManifest` from these fields for graceful-degrade when `module.json` is unreadable (legacy installs from before the contract, test fixtures that mock the disk path).

**The contract going forward.**

- Module **installed** (services.json row present) → operations work using the row's fields. Operator-authoritative.
- Module **not installed** (no row) → `module_not_installed` 404. Hub no longer falls back to vendored manifest data that would lie about an absent module.
- Module's lifecycle commands (start/restart) re-resolve the spec from `<installDir>/.parachute/module.json` so the module is authoritative for its own startCmd / paths.

**Consumers updated.**

- `src/service-spec.ts` — split into FALLBACK + KNOWN_MODULES; `shortNameForManifest`, `knownServices`, `canonicalPortForManifest`, `effectivePublicExposure`, `getSpec` consult both tables. New helpers: `KnownModule` type, `composeKnownModuleSpec(km, manifest)`, `synthesizeManifestForKnownModule(km)`.
- `src/api-modules.ts` — `lookupModule(short)` local helper hides the FALLBACK / KNOWN_MODULES split from the catalog rendering path.
- `src/api-modules-config.ts` — `manifestNameForShort` + `fallbackPathsForShort` + `fallbackStripPrefixForShort` mirror the same pattern. The not-installed → 404 path now applies uniformly to all three retired shorts.
- `src/api-modules-ops.ts` — `specFor` delegates to the unified `getSpec`. New `resolveSpawnSpec(short, installDir)` reads module.json post-`bun add -g` so the supervisor spawns with the module's own canonical startCmd. Graceful-degrade falls back to the synthesized manifest when module.json is unreadable.
- `src/commands/install.ts` — new `kind: "known-module"` `ResolvedTarget` variant for CLI installs of vault / scribe / runner; reads module.json, falls back to `synthesizeManifestForKnownModule` with a clear log line.
- `src/commands/lifecycle.ts` — `specForEntry` prefers `composeKnownModuleSpec(km, manifest)` (module.json wins) over the imperative `extras.startCmd` for KNOWN_MODULES shorts when installDir is stamped.
- `src/commands/setup.ts` — `ServiceChoice` carries the minimal subset of spec data the survey + summary banner need so the pre-install path doesn't require a full ServiceSpec.
- `src/install-source.ts`, `src/hub-server.ts` — small lookups updated to consult both tables.

**Backward compatibility for legacy services.json rows.** KNOWN_MODULES carries an imperative `extras.startCmd` for vault / scribe / runner mirroring the module's canonical declaration. Rows that pre-date installDir stamping (so module.json can't be read because installDir is unknown) still spawn via this fallback startCmd. Once the module reboots and self-registers with installDir, lifecycle reads module.json directly — the imperative startCmd is the bootstrap-only path.

**Tests.** `bun test ./src` 1767 pass (was 1762; +5 in a new `handleApiModulesConfig — FALLBACK retirement (hub#310)` describe block pinning the "not installed → 404 across vault/scribe/runner" + "self-registered row → upstream URL composed from entry" contract). Existing fixtures updated to write the now-authoritative `stripPrefix: true` on scribe rows that previously relied on the vendored fallback for that field (`api-modules-config.test.ts`, `hub-server.test.ts`). `bun run typecheck` clean. `bunx biome check src/` clean. `cd web/ui && bun run test` 183 pass — unchanged, SPA-only changes wouldn't be exercised by this PR.

**NOT retired in this PR.** `NOTES_FALLBACK` stays — notes is a frontend served by hub's `notes-serve.ts` shim, so its startCmd is hub-side logic (port + mount derived from the entry); when notes ships its own server it can self-register and this fallback retires alongside the shim (notes#105). `CHANNEL_FALLBACK` similarly stays (exploration tier).

## [0.5.13-rc.4] - 2026-05-21

**feat(hub): admin SPA ModuleConfig dereferences $ref in schema definitions (#303).**

Closes the friction that hub#260's first-pass `ModuleConfig` form left: the renderer walked `schema.properties` directly with no awareness of `$ref` / `definitions` / `$defs`, so a module reusing a shared property block had to inline it per call-site. Scribe#47 took that workaround for `apiKeyAndModel` across openai/gemini/groq cleanup providers; after this PR scribe can revert to a clean `$ref` shape (tracked as a follow-up on the scribe side, not folded here).

**What landed:** a new `web/ui/src/lib/json-schema.ts` with a `dereferenceSchema(schema, root?)` helper. The signature:

```ts
export function dereferenceSchema(schema: JsonSchema, root?: JsonSchema): JsonSchema
```

`ModuleConfig.tsx` calls it ONCE at fetch time — every downstream walk (property iteration, switch on `type`, future structural rendering) sees fully-expanded property objects. The renderer stays `$ref`-unaware; the resolve-once pass is the single seam.

**Resolution rules** (Draft-07-compatible subset, all unit-tested):

- `#/definitions/<name>` → `root.definitions[<name>]`
- `#/$defs/<name>` → `root.$defs[<name>]` (newer keyword)
- Nested refs (a → b → c) recurse to fully resolve
- Sibling keywords on a `$ref`-bearing object (e.g. `{$ref, title}`) MERGE over the resolved value — matches what tools commonly support and what call-sites use to override `title` / `description` per-use
- Circular refs (a → b → a) — visited-set detection, throws clearly
- Unknown definition paths — throws clearly
- External refs (URLs / file paths) — refused with a clear error
- Path-based refs (`#/properties/foo`) — supported via the generic pointer walker
- JSON Pointer escapes (`~0` / `~1`) handled per RFC 6901
- A broken schema lifts to the page's `error` load state with a "Schema $ref resolution failed — <message>" prefix so the operator sees a clean failure mode rather than a render crash; the module-side schema needs the actual fix

**Explicitly out of scope** (deferred to a follow-up): structured rendering of `oneOf` / `anyOf` / `allOf` arms. The resolver does recurse into those arms so a `$ref` inside resolves, but the SPA still shows them via the unsupported-type fallback (JSON debug view). Adding structural rendering for those is a separate concern.

**Tests** (`cd web/ui && bun run test`): 183 pass (was 169; +14 across `json-schema.test.ts` and a new `$ref dereferencing` describe block in `ModuleConfig.test.tsx`). Highlights: definitions/`$defs`/nested/circular/unknown/external/no-refs/sibling-merge/`oneOf`-recursion/pointer-escapes plus the end-to-end "writeOnly password input renders from a `$ref`-using schema" + "broken `$ref` surfaces as the error load state" integrations. `bun run typecheck` clean (root + web/ui). `bun test ./src` (hub) 1762 pass — unchanged, since the SPA changes don't touch the server. `bun run build` for web/ui clean. `bunx biome check .` clean.

## [0.5.13-rc.3] - 2026-05-21

**fix(hub): route /.parachute/* to module's bare endpoint regardless of stripPrefix (#307).**

Closes the hub#305 follow-up the rc.2 changelog flagged. The admin SPA's `/admin/modules/runner/config` button 404'd against runner because the proxy at `/api/modules/:short/config[/schema]` only honored two upstream shapes: `stripPrefix: true` → bare `/.parachute/config`, `stripPrefix: false` → `<mount>/.parachute/config`. Runner ships `paths: ["/runner", "/.parachute"]` with `stripPrefix: false` (its `/runner/jobs` admin routes want the literal `/runner` prefix; only its universal-protocol endpoints sit at the bare URL), so the proxy built `http://127.0.0.1:1945/runner/.parachute/config` — which runner's HTTP server doesn't match.

**Fix:** `resolveUpstream` + `buildUpstreamPath` in `src/api-modules-config.ts` now detect when a module declares `/.parachute` in its `paths[]` and route to the bare `/.parachute/config[/schema]` URL regardless of `stripPrefix`. The asymmetry rationale:

- **Runner-shape** (new): `/.parachute` in `paths[]`, `stripPrefix: false`. The module is announcing "I serve the universal module-protocol endpoints at the bare URL." Bare-route.
- **Scribe-shape** (unchanged): `paths: ["/scribe"]`, `stripPrefix: true`. The hub strips the mount on every request, so bare-route falls out naturally — same upstream URL as before this fix.
- **Vault/notes-shape** (unchanged): no `/.parachute` in `paths[]`, `stripPrefix: false`. The module routes its `.parachute/config` per-mount (vault's `.parachute/config` is per-vault, scoped under `/vault/<name>` — routing it bare would lose the vault-name context). Mount-preserved as before.

The detection looks at both the live services.json entry's `paths` (operator-authoritative) and the FIRST_PARTY_FALLBACKS vendored `paths` (so a `bun link` install without a written entry still routes correctly). A trailing slash and a `/.parachute/<subpath>` declaration both count as "hosts the bare URL."

**Tests** (`bun test ./src`): 1762 pass (was 1755; +7 in `api-modules-config.test.ts` covering runner GET-schema / GET-values / PUT, runner-without-services.json-entry, vault unchanged, scribe unchanged, mixed-paths-order runner shape). The new tests live in a dedicated `hostsBareParachute (hub#307)` describe block so future drift here surfaces in one suite. No fix changes outside `api-modules-config.ts` — same surface contract for every other call site.

**Smoke:** verify-via-tests only (live runner-supervised setup wasn't running locally during this PR).

`bun run typecheck` clean. `bunx biome check src/` clean.

## [0.5.13-rc.2] - 2026-05-21

**feat(hub): runner added to FIRST_PARTY_FALLBACKS + CURATED_MODULES — admin SPA can install runner (hub#305).**

Closes the v0.6 friend-deploy gap that hub#304 left: the admin SPA install catalog renders from `FIRST_PARTY_FALLBACKS ∩ CURATED_MODULES`, and runner was in neither set, so operators landing on `/admin/modules` post-hub#304 had no UI affordance to install runner. After this PR the catalog renders four cards (vault → notes → scribe → runner), and clicking Install on runner kicks off the same `bun add @openparachute/runner` + supervised-spawn flow the other three modules use.

**New entries:**

- `service-spec.ts` — `RUNNER_FALLBACK` constant + `runner: RUNNER_FALLBACK` key on the `FIRST_PARTY_FALLBACKS` record. Mirror of `parachute-runner/.parachute/module.json` (rc.3 vintage, 2026-05-21). `kind: "tool"`, port `1945`, `paths: ["/runner", "/.parachute"]`, `health: "/runner/healthz"`, `startCmd: ["parachute-runner", "serve"]`, `stripPrefix: false` (runner's HTTP handler matches `/runner/jobs` + `/.parachute/config` literally — no internal mount strip). `extras.hasAuth: true` matches runner's posture (`runner:admin` scope gates everything past `/healthz`).
- `api-modules.ts` — `CURATED_MODULES` grows from `["vault", "notes", "scribe"]` to `["vault", "notes", "scribe", "runner"]`. Order is recommended install order; runner is last because it depends on a working vault + scribe.

**Tests** (`bun test ./src`): 1755 pass (was 1754; +1 — new `runner row carries package + display props` spot-check on the `GET /api/modules` wire shape). The existing `200 + curated list on fresh container` test updates its `expected` from three entries to four. No SPA-side test changes — `web/ui/src/routes/Modules.test.tsx` already drives module rendering off a per-test catalog fixture, not a hardcoded curated-list length.

**Not in scope (follow-up):**

- The `api-modules-config.ts` proxy for `/.parachute/config[/schema]` builds the upstream URL as `<paths[0]>/.parachute/config[/schema]`. For runner with `paths[0] === "/runner"` and `stripPrefix: false`, that produces `/runner/.parachute/config` — which runner's HTTP server does NOT match (it matches `/.parachute/config` literally, no `/runner/` prefix). The Configure button in the admin SPA will therefore 404 for runner until that proxy learns to use `/.parachute` from the module's `paths[]` when present. Tracked as a follow-up.
- `PORT_RESERVATIONS` still labels slot 1945 as `"unassigned"`. The pattern doc says "first-party modules claim a slot the moment they ship"; runner ships rc.3 today, so a future doc-only PR can promote the entry to `"parachute-runner"`. Left out here to keep the PR a registry add.

`bun run typecheck` clean. `cd web/ui && bun run test`: 169 pass (no SPA change). `bunx biome check src/` clean.

## [0.5.13-rc.1] - 2026-05-21

**feat(hub): admin SPA install + upgrade UI — closes Phase 1 critical-path (hub#260).**

`/admin/modules` now lays out as two clearly-grouped sections: **Installed modules** on top + **Install a module** below. The install + upgrade actions have been wired since hub#262 (the catalog page rendered them inline per-row), but pre-this-PR there was no visual grouping — an operator scanning a fresh-deploy hub had to read past three tagline-plus-meta blocks to find the Install buttons. With the split, an empty hub lands on a near-empty Installed section + a clear "Install a module" catalog underneath; a populated hub lands on its modules up top + a smaller "available to add" list underneath.

**Install card** (the new `InstallableCard` component) is visually lighter than the existing `ModuleRow`: a name+tagline+package+latest-version line with a single Install button. No status badge (nothing to be installed yet), no meta grid, no per-row Configure / Restart / Uninstall sub-actions. Distinct shape because the only affordance is one action — "get me this module."

**In-flight install handling**: while an install op is pending, the corresponding card disappears from the catalog (replaced by a small "Install in progress — see In progress above" hint) so a fast-finger operator can't kick off a second op against the same module before the first lands. Belt-and-suspenders against the ~50ms gap before the new op settles into `pendingOps`; the per-button `disabled={installing}` was already there.

**Upgrade affordance** stays where hub#262 put it — inline on each installed `ModuleRow` row. The button label reads "Upgrade to v{latest}" when `installed_version !== latest_version` and "Up to date" (disabled) otherwise. The available-version detection is driven entirely off `latest_version` in the `GET /api/modules` response (hub#262 added this field with a 5-minute in-memory cache); no SPA-side npm lookup, no second roundtrip.

**Backend**: zero changes. Existing endpoints (`POST /api/modules/<short>/install` / `/upgrade` async, `POST /api/modules/<short>/restart` / `/uninstall` sync, `GET /api/modules/operations/<id>` poll) shipped via hub#262 already expose the right shape. The `latest_version` field on each module row was added the same PR.

**Available-modules list source**: the entries in `FIRST_PARTY_FALLBACKS` that intersect `CURATED_MODULES` (`vault`, `notes`, `scribe`). The hardcoded list comes off the existing backend wire shape — `available: true` filters in, `installed: false` keeps it in the catalog after install. Third-party / `module.json`-shipping modules aren't part of v0.6 (per hub#260 scope); they retire when each module ships its own `.parachute/module.json`.

CSS: new `.install-list`, `.install-card`, `.modules-installed > h2` / `.modules-installable > h2` rules in `web/ui/src/styles.css` for the section grouping + lighter install-card chrome. No new bundle dependencies; SPA bundle still ~303 KB.

`bun run typecheck` clean (root + web/ui). `bun test ./src`: 1754 pass (no backend change). `cd web/ui && bun run test`: 169 pass (was 161, +8 covering the new section split, in-flight install hide, install + upgrade kick-off, supervisor-unavailable disabled-install path). `bunx biome check` clean.

## [0.5.12-rc.5] - 2026-05-21

**refactor(hub): factor shared installDir-stamp + well-known regen between CLI and API install paths (#293).**

Co-locates the two post-install responsibilities (stamp `installDir` on the services.json row, regenerate `/.well-known/parachute.json`) into a new `src/post-install.ts` so the CLI install path (`commands/install.ts`) and the API install path (`api-modules-ops.ts`) can't drift again. Background: hub#292 added both responsibilities inline in the API path after hub#298 caught that the API had diverged from the CLI on the installDir stamp — modules silently disappeared from the discovery page. The duplication is the failure mode.

New surface:

- `stampInstallDirOnRow({ manifestName, installDir, servicesJsonPath })` — idempotent stamp helper; returns true when a write happened.
- `refreshWellKnown({ servicesJsonPath, canonicalOrigin, wellKnownPath, log, readModuleManifest? })` — regen-only wrapper around `regenerateWellKnown` with error-to-log semantics.
- `finalizeModuleInstall(opts)` — paired entry point (stamp + regen) for callers that do both at one point.

Call-site changes:

- API `runInstall` / `runUpgrade` keep their pre-spawn `stampInstallDirOnRow` + post-spawn `refreshWellKnown` shape (the two ops happen at different timing points), now via the shared helpers.
- API `handleUninstall` swaps its inline regen for `refreshWellKnown`.
- CLI `install` calls `finalizeModuleInstall` at its terminal stamping point — adds well-known regen to interactive CLI installs (a small operator-visible enhancement; the live HTTP path already rebuilt per-request, this keeps the on-disk inspection artifact in sync). The mid-install intermediate stamp uses `stampInstallDirOnRow`. Test seam: `InstallOpts.wellKnownPath` defaults to `WELL_KNOWN_PATH` only when `manifestPath` is the production default, so the existing test suite (which uses tempdir `manifestPath`) never writes to `~/.parachute/well-known/`.

Pure refactor on the API path — no behavior change. CLI install now regenerates the well-known doc (small enhancement, was a gap). New test asserts CLI- and API-path inputs through `finalizeModuleInstall` produce byte-identical well-known docs.

`bun test ./src`: 1754 pass (was 1746; +8 from the new post-install suite). `bun run typecheck` + `bunx biome check src/` clean.

## [0.5.12-rc.4] - 2026-05-21

**feat(hub): admin SPA module-config form (hub#260) — Phase 1 critical-path.**

The admin SPA at `/admin/modules/<short>/config` now renders a generic per-module configuration form, driven entirely by each module's own `/.parachute/config/schema` declaration. Friends deploying via Render can now configure scribe (transcription provider, cleanup provider, port, etc.) from the browser without dropping to a terminal — the last UI gap on the v0.6 single-container Phase 1 critical path.

Architecture — Option A (hub mints `<short>:admin` token at proxy time):

The SPA's session-derived bearer carries `parachute:host:admin`, but modules enforce per-module scopes on `/.parachute/config*` (e.g. scribe requires `scribe:admin`). Two choices to bridge the gap:

- **Option A** (this PR): hub mints a short-lived (60s TTL) `<short>:admin` JWT on each proxied request, drops the SPA bearer, and forwards with the minted token. Audit-friendly (each proxy mint is one signed JWT), keeps modules ignorant of hub's session model, and reuses the existing `signAccessToken` pipeline. The minted token is NOT recorded in the tokens registry — it's a one-shot proxy artifact.
- Option B (rejected): modules treat `parachute:host:admin` as a master scope that overrides all per-module scopes. Centralizes hub's vocabulary in every module's auth gate; couples module auth surfaces to hub's session model; harder to audit (no clear "who is acting on this module right now" trail).

Renderer — hand-rolled, NOT `@rjsf/core`:

The brief recommended `@rjsf/core` (industry-standard React JSON Schema Form library). The decision here is to hand-roll a focused renderer for the schema vocabulary Parachute modules actually use today: `string` / `number` / `integer` / `boolean`, `enum`, `default`, `title`, `description`, `minimum` / `maximum`, `writeOnly`. Rationale:

- Bundle savings: @rjsf + ajv + plugins is ~250 KB; the SPA build today ships 301 KB total. The library would double our bundle.
- Schema vocabulary: scribe's schema (the only module with a live schema today) uses none of @rjsf's heavy-hitter features (oneOf / anyOf / dependencies / conditionals). Hand-rolling matches the actual scribe schema shape exactly.
- Growth path: if/when a module ships a schema feature the hand-roll doesn't cover, lift in @rjsf at that point. Today's call is "no debt, no library."

writeOnly UX (Draft-07 secret-handling, forward-looking):

scribe's current schema has no `writeOnly` fields, but the next module that needs a config-side secret (e.g. agent with API keys) will. The renderer implements the canonical pattern:

- `writeOnly: true` string → `<input type="password">` with `autocomplete="new-password"`.
- The module's `GET /.parachute/config` response omits writeOnly keys by convention. SPA infers "stored value exists" from "schema marks writeOnly AND value absent in GET response" and shows a `••••••••` placeholder.
- Hint copy: "Leave blank to keep the current value." A blank password input the user didn't touch has `dirty: false` and is NOT included in the PUT payload — the module preserves its stored secret.
- A user-typed value flips `dirty: true` and IS included; the module overwrites the stored secret.

The pattern works for every module that ships a writeOnly field on the same `dirty-only-PUT` shape, no per-module branches needed.

Form-state shape:

- `draft`: user's edited values per field (keyed by property name).
- `dirty`: per-field "did the user touch this?" gate.
- Submit builds the PUT payload from `{name: draft[name] for name if dirty[name]}` — *only changed fields*. This is what makes the writeOnly preserve-on-blank semantics safe across all field types, not just secrets: a user who edits two fields and submits doesn't accidentally re-send the other 10 fields' current values back to the module (no churn on the underlying config.json, no "did the value just change?" noise in restart-required signals).

Implementation:

- `src/api-modules-config.ts` (new) — `handleApiModulesConfig` + `parseModulesConfigPath`. GET schema, GET values, PUT values. Validates `parachute:host:admin` on the SPA bearer; mints a `<short>:admin` JWT via `signAccessToken` for proxy use; forwards to `http://127.0.0.1:<modulePort>/.parachute/config[/schema]` (honors per-module `stripPrefix`); pipes the response body verbatim so module-side validation errors reach the SPA with their original `{error, message, errors[]}` shape. Special-case: upstream 404 on a GET surfaces as `no_config_schema` (not the raw 404) so the SPA can render a "module has no operator-editable config" empty state distinct from "module not installed."
- `src/hub-server.ts` — dispatcher entry ahead of the install/restart/upgrade/uninstall switch (those routes use `parseModulesPath` which doesn't match the `/config` suffix shape).
- `web/ui/src/routes/ModuleConfig.tsx` (new) — the SPA page. Switch-based renderer per schema property type. Five terminal states: loading / no_schema / not_installed / error / ok. writeOnly handling per-field.
- `web/ui/src/lib/api.ts` — three new fetch helpers (`getModuleConfigSchema`, `getModuleConfigValues`, `putModuleConfigValues`) + four new exported types (`ConfigSchemaProperty`, `ModuleConfigSchema`, `ModuleConfigValues`, `ModuleConfigPutResult`).
- `web/ui/src/App.tsx` — `/modules/:short/config` route mount + subtitle disambiguation for the per-module sub-page.
- `web/ui/src/routes/Modules.tsx` — "Configure" link per installed module row. Stays enabled even when supervisor is offline (config endpoints are served by the module itself, not the supervisor).
- `web/ui/src/styles.css` — minimal styles for the new page + `.btn` rule so the Configure `<Link>` looks like the sibling action buttons.

Tests:

- `src/__tests__/api-modules-config.test.ts` (new, 18 tests) — path parser shape coverage; 401 / 403 / 405 auth boundary; not-installed → 404; mint-and-forward (decodes the JWT the fake upstream receives + asserts scope=`<short>:admin`, audience=`<short>`, iss=hub, ttl=60s); GET schema / GET values / PUT body forwarding; 4xx verbatim; upstream 404 → `no_config_schema`; upstream unreachable → 502; stripPrefix true (scribe-shape) vs false (notes-shape) → correct upstream path.
- `web/ui/src/routes/ModuleConfig.test.tsx` (new, 12 tests) — loading / no_schema / not_installed / error states; scribe golden fixture renders per-property correctly; submit sends only dirty fields; empty-submit rejected inline; restart_required list rendering; 4xx surfaces field errors; writeOnly renders as password input with placeholder; untouched writeOnly NOT sent; user-typed writeOnly IS sent.

Gates:

- hub: 1746 pass (1728 before, +18 new in `src/__tests__/api-modules-config.test.ts`).
- web/ui: 160 pass (148 before, +12 new in `src/routes/ModuleConfig.test.tsx`).
- typecheck + biome clean across root + web/ui.
- SPA build clean (301 KB total — no library inflation).

Smoke posture:

Aaron is testing rc.3 in parallel against the live local hub + scribe, so this PR does not run a live smoke against the same hub (a side-by-side fresh-hub instance would diverge on issuer / JWKS and the running scribe would reject the minted JWT). Unit tests cover end-to-end JWT shape (decode + scope/audience/issuer assertions), proxy URL composition for both stripPrefix flavors, and the writeOnly safety property. Aaron tests the end-to-end SPA + live scribe write on rc.4 once this lands.

## [0.5.12-rc.3] - 2026-05-21

**fix(hub): `parachute restart hub` detects orphan bun proc on bound port.**

When the `hub.port` file is missing or stale but a bun process is still holding port 1939, `parachute restart hub` previously reported `hub wasn't running.` while the orphan continued occupying the port — the subsequent `parachute start hub` then failed with `hub: port 1939 unavailable.` The only recovery was a manual `lsof` + `kill`. Surfaced during fresh-machine CORS testing 2026-05-20 (hub#287).

`stopHub` now falls back to probing the canonical hub port (1939) via `lsof -ti :<port> -sTCP:LISTEN` when the pidfile is absent or its PID is dead. If a process is bound, it's treated as an orphan hub: the operator sees `Detected orphan hub process holding port 1939 (PID 12345); stopping it.` and `stopHub` runs the standard SIGTERM → SIGKILL escalation against the adopted PID. `parachute restart hub` therefore now works end-to-end against the stale-pidfile case — the bug repro from hub#287 — without manual cleanup.

`ensureHubRunning`'s port-unavailable error also now names the holder when `lsof` can resolve a PID, pointing the operator at `parachute restart hub` (the orphan-aware path) rather than the bare `lsof -iTCP:1939` hint.

Implementation:

- `src/hub-control.ts` — new `defaultPidOnPort` helper wrapping `lsof -ti :<port> -sTCP:LISTEN` (macOS + Linux; Windows out of scope for v0.6). New `PidOnPortFn` type + injectable `pidOnPort` seam on both `EnsureHubOpts` and `StopHubOpts` so tests don't shell out. `stopHub` now resolves its target PID in two stages: pidfile-first (existing behavior when the file is present + live), then port-probe fallback when the pidfile is missing or stale. Orphan adoption emits a clear stderr line before signalling. `ensureHubRunning`'s port-unavailable throw is enhanced to name the holder + recommend `parachute restart hub` when a PID is resolvable.
- `src/__tests__/hub-control.test.ts` — pidOnPort stub added to existing stop/start tests (so the real `lsof` against the actually-running local hub on 1939 doesn't bleed into the test harness). Four new tests for hub#287: stale pidfile + orphan-on-port adoption; missing pidfile + orphan-on-port adoption; no orphan reported + no pidfile (genuine no-op); orphan PID reported but already dead (race-window cleanup).

Cross-platform note: `lsof` is the de facto orphan-PID probe on macOS + Linux and ships by default on both. Windows is out of scope for the v0.6 cloud-deploy + owner-operated targets; if/when Windows lands, the seam is already injectable per the `PidOnPortFn` interface.

Tests:

- hub: 1728 pass (1723 before; +4 hub#287 stopHub orphan-adoption tests in `src/__tests__/hub-control.test.ts`, +1 hub#287 ensureHubRunning orphan-hint test).
- web/ui: 148 pass (unchanged).
- typecheck + biome: clean.

## [0.5.12-rc.2] - 2026-05-21

**feat(hub): runtime-settable hub_origin via admin SPA.**

Operators on Render (or anywhere with a custom domain) can now set the canonical hub URL from the admin SPA at `/admin/settings` without redeploying. The stored value is the OAuth issuer claim hub stamps into every JWT, so flipping the canonical URL takes effect on the very next request without a hub restart.

Resolution precedence (per request, no caching):

1. `hub_settings.hub_origin` — operator-set canonical URL from the admin SPA. New in this rc.
2. `PARACHUTE_HUB_ORIGIN` env / `--issuer` flag — deploy-time setting (unchanged).
3. `new URL(req.url).origin` — local-dev fallback (unchanged).

The admin SPA's `/admin/settings` page surfaces three states distinctly: "from settings" / "from env var PARACHUTE_HUB_ORIGIN" / "from request origin", so an operator can tell which precedence rung is active without inspecting the DB or env. Helper text warns that changing the issuer invalidates any tokens already in circulation (the `iss` claim won't match the new issuer on verification).

Implementation:

- `src/hub-settings.ts` — `HubSettingKey` gains `hub_origin`; new helpers `getHubOrigin`, `setHubOrigin`. Unlike `module_install_channel` this helper does NOT auto-seed from env — the env var is its own precedence layer in `resolveIssuer` and auto-seeding would collapse the source attribution.
- `src/hub-server.ts` — new `resolveIssuer(req, db, configuredIssuer)` + `resolveIssuerSource(...)` helpers. `oauthDeps(req)` and the `/.well-known/parachute.json` canonical-origin site now route through resolveIssuer. Per-request resolution so PUTs take effect on the next request without restart.
- `src/api-settings-hub-origin.ts` — new module hosting `handleApiSettingsHubOrigin` (GET + PUT) and the pure `validateHubOrigin` validator (scheme http/https, hostname required, no trailing slash, no path/query/fragment). Bearer-gated on `parachute:host:admin` (same boundary as `/api/modules/channel`).
- `src/hub-server.ts` — dispatcher routes `/api/settings/hub-origin` to the new handler with the precedence-resolved issuer + source threaded through.
- `web/ui/src/routes/Settings.tsx` — new SPA page at `/admin/settings`. Current-value readout + source label, input field pre-filled from stored value, Save + Reset CTAs, server-error surfacing.
- `web/ui/src/App.tsx` — nav link to `/settings` + route mounting.
- `web/ui/src/routes/Modules.tsx` — "More hub settings at /settings" link added to the channel toggle for discoverability.
- `web/ui/src/lib/api.ts` — `getHubOriginSetting` + `setHubOriginSetting` + `HubOriginSetting` / `IssuerSource` types.

Tests:

- `src/__tests__/hub-settings.test.ts` — appended `hub-settings — hub_origin` describe (6 tests): round-trip, overwrite, clear, empty-string normalization, no auto-seed from env.
- `src/__tests__/hub-origin-resolution.test.ts` (new, 12 tests) — precedence chain + source attribution + mid-flight change-takes-effect.
- `src/__tests__/api-settings-hub-origin.test.ts` (new, 30 tests) — validator unit tests, auth gating (405/401/403), GET shape across all three sources, PUT validation + write, change-takes-effect-on-next-request end-to-end.
- `web/ui/src/routes/Settings.test.tsx` (new, 10 tests) — initial render across the three source states, save round-trip + refetch, server-error surfacing, empty-input clear, reset, reset-disabled-when-no-stored, load-failure retry.
- `web/ui/src/App.test.tsx` — nav-order assertion bumped to include Settings.

Smoke (local hub on `PARACHUTE_HOME=/tmp/hub-origin-smoke`):

1. Fresh boot → `GET /api/settings/hub-origin` → `{"hub_origin":null,"resolved_issuer":"http://127.0.0.1:19390","source":"request"}` ✓
2. `PUT {"hub_origin":"https://hub.example.com"}` → 200 + value echoed ✓
3. `GET /.well-known/oauth-authorization-server` → `issuer: "https://hub.example.com"` (no restart) ✓
4. Re-minted token's iss claim decodes to `https://hub.example.com` ✓
5. `PUT {"hub_origin":null}` → 200, well-known issuer flips back to `http://127.0.0.1:19390` ✓
6. PUT a fresh value, kill hub, restart with same `PARACHUTE_HOME` → well-known issuer still reflects the persisted value ✓

Hub gate: 1721 pass (up from 1672, +49 new). SPA gate: 148 pass (up from 138, +10 new). Typecheck + biome clean across root + web/ui. SPA build clean.

## [0.5.12-rc.1] - 2026-05-21

First-boot path hardening (from Aaron's real Render deploy testing):

- **Bootstrap token for wizard mode** (security). When no admin exists AND no env-seed credentials, hub generates a one-time bootstrap token, logs it on startup, and requires it on the account-creation form. Closes the race where an attacker could claim a freshly-deployed hub's admin account before the operator. Env-seeded admins bypass the token (already claimed via env config).
- **Wizard kicks in when admin exists but no vault**. Previously, env-seeded admins skipped the wizard entirely and had to manually find `/admin/modules` + `/admin/vaults`. Now the wizard auto-redirect on `/` and `/hub.html` fires when either (no admin) OR (admin exists but no vault).
- **`/admin/vaults` gated on vault module installed**. When no vault module is installed, the page renders an empty-state CTA pointing at `/admin/modules` instead of showing an empty vault list with a "New vault" button that can't succeed. Removes the "where am I?" confusion Aaron hit.

Token shape: `parachute-bootstrap-<43 base64url chars>` (~63 chars). Lives in process memory only — regenerated on every restart, never persisted. Constant-time compare via `crypto.timingSafeEqual`. Single-use: consumed on successful admin claim. Subsequent claim attempts return 410 Gone.

Implementation:

- `src/bootstrap-token.ts` — generate / verify / consume helpers, isolated module for clean test surface.
- `src/commands/serve.ts` — mints the token + logs the multi-line `[wizard]` banner when `seedInitialAdminIfNeeded` returns `needs-setup`. New `formatBootstrapTokenBanner(token)` helper for testability.
- `src/setup-wizard.ts` — `renderAccountStep` gains `requireBootstrapToken` + `bootstrapToken` props; `handleSetupAccountPost` enforces the token gate when `getBootstrapToken()` is set. Wrong token → 401 (form re-renders with empty token field, username preserved); already-claimed → 410 Gone.
- `src/hub-server.ts` — extended the `/` and `/hub.html` redirect to fire when `hasVaultInstalled(manifestPath)` is false (alongside the existing `userCount === 0` gate). New `hasVaultInstalled` helper reads services.json on demand.
- `web/ui/src/lib/api.ts` — `listVaults()` now returns `{ vaults, moduleInstalled }` instead of `VaultListing[]`. Detects vault module from any `parachute-vault[-<name>]` services-array entry.
- `web/ui/src/routes/VaultsList.tsx` — when `moduleInstalled` is false AND vault list is empty, renders the "Install vault module" empty state with a CTA to `/modules` instead of "Create a vault" pointing at `/vaults/new`. Header CTA also flips to "Install vault module" so the operator can't click into a doomed `/vaults/new` flow.

Tests:

- `src/__tests__/bootstrap-token.test.ts` (new, 13 tests) — module lifecycle, format, constant-time semantics, length-mismatched rejects, prefix-stripped rejects.
- `src/__tests__/setup-wizard.test.ts` — appended `bootstrap token gate` describe (7 tests): GET shows/hides field by token presence, POST with correct/wrong/missing token, 410 on already-claimed, on-box CLI back-compat with no token.
- `src/__tests__/setup-gate.test.ts` — Issue 2 redirect (env-seed admin no vault → `/` → 302 /admin/setup), `/hub.html` likewise, admin+vault renders discovery, wizard at /admin/setup with env-seed admin renders vault step without token field.
- `src/__tests__/serve.test.ts` — `formatBootstrapTokenBanner` shape + `[wizard]` prefix on every line; wiring tests that confirm `seedInitialAdminIfNeeded` itself doesn't mint (the mint is in the caller).
- `web/ui/src/lib/api.test.ts` — `listVaults` returns the new `{ vaults, moduleInstalled }` shape; module detection covers `parachute-vault`, `parachute-vault-<name>`, ignores non-vault services.
- `web/ui/src/routes/VaultsList.test.tsx` — empty-state branch flip on `moduleInstalled` false.

Hub test gate: 1672 pass (up from 1641, +31 new). SPA test gate: 138 pass (up from 134, +4 new). Typecheck + biome clean across root + web/ui.

## [0.5.11] - 2026-05-21

Stable release. Bug-fix-only release covering issues Aaron surfaced during fresh-machine testing of 0.5.10:

- **Modules on discovery page** (#292) — `runInstall` now stamps `installDir` on the services.json row (was diverged from the CLI install path) + regenerates the well-known doc after install/upgrade/uninstall. Modules installed via `/admin/modules` or the wizard now appear on `/` discovery without needing a hub restart.
- **Approval page resolved scopes** (#294) — server-rendered approve-pending page substitutes unnamed `vault:<verb>` scopes to `vault:*:<verb>` form, matching the SPA approve page and the consent screen. Operator sees the scope shape that will actually appear in minted tokens.
- **`parachute serve` banner** (#295) — startup line shows `http://localhost:<port>` when bound to `0.0.0.0`, with the bind address noted parenthetically. Pasting the bind address into a browser tripped Chrome's `0.0.0.0` block and surfaced as cross-origin errors.

See individual rc entries below for full detail.

## [0.5.11-rc.3] - 2026-05-21

**fix(serve): print localhost in banner when bound to 0.0.0.0 (operators couldn't navigate to bind address).**

Aaron hit this on rc.2 testing: `parachute serve` printed `listening on http://0.0.0.0:1939` and pasting that URL into Chrome failed (browser refuses to navigate to `0.0.0.0`; even when it resolves, mixing the bind-address origin with other URLs like `localhost:1939` trips cross-origin checks). `0.0.0.0` is a kernel-side meta-address ("listen on all interfaces") — not an operator-usable URL.

Fix shape:

- Extracted `formatListeningBanner(...)` in `src/commands/serve.ts`. When the bind hostname is `0.0.0.0`, the banner now prints `http://localhost:<port>` with a parenthetical `(bound on all interfaces: 0.0.0.0:<port>)` so operators get a navigable URL while still seeing the actual bind address for diagnostic purposes.
- When the operator has explicitly chosen a hostname via `PARACHUTE_BIND_HOST` (e.g. `127.0.0.1`, a LAN IP), the banner prints that hostname directly with no parenthetical — the operator knows what they wired.
- Bind behaviour is unchanged: `Bun.serve({ hostname })` still receives the original `0.0.0.0` / `PARACHUTE_BIND_HOST` value, so containers + LAN exposure paths keep working exactly as before. Banner-only cosmetic fix.

Tests added in `src/__tests__/serve.test.ts`:
- `0.0.0.0` → banner displays `localhost` + parenthetical bind disclosure (URL precedes disclosure precedes contextual block).
- `127.0.0.1` → banner displays the loopback verbatim, no bind disclosure.
- `192.168.1.10` → banner displays the LAN IP verbatim, no bind disclosure.
- Contextual block carries `PARACHUTE_HOME`, db, issuer, admin state; undefined issuer renders as `<request-origin>`.

## [0.5.11-rc.2] - 2026-05-20

**fix(approve-pending): substitute unnamed vault scopes with wildcard form (matches SPA + consent).**

Aaron hit this on rc.1 testing: the server-rendered `ApprovePendingView` (the "App not yet approved — Sign in as admin to approve" page on `/oauth/authorize` for a pending client) showed raw OAuth scopes like `vault:read` and `vault:write` rather than the resolved `vault:*:read` / `vault:*:write` form. The SPA's `/admin/approve-client/<id>` view (hub#289) already substituted correctly; this brings the server-rendered version in line.

Root cause: `renderApprovePending` rendered `requestedScopes` directly with no display-time substitution. Both branches (unauth viewer with sign-in CTA + authenticated admin with inline approve form) got the raw scope shape.

Fix shape:

- Documented the `'*'` mode on `substituteVaultDisplay(scope, displayVault)` — the literal string `'*'` renders unnamed `vault:<verb>` scopes as `vault:*:<verb>`. Already-named vault scopes (`vault:work:read`) and non-vault scopes (`scribe:transcribe`, `channel:send`) pass through unchanged.
- `renderApprovePending` now maps requested scopes through `substituteVaultDisplay(s, '*')` before rendering.
- Surfaces an inline explanation below the scope list when any scope renders with `*`: "a specific vault is selected during sign-in via the consent picker (or the user's assigned vault for multi-user setups). The `*` shows the unbound shape." Omitted when all scopes are non-vault or already-named. Mirrors the SPA's pattern in `ApproveClient.tsx`.

Tests added in `src/__tests__/oauth-ui.test.ts`:
- `substituteVaultDisplay` `'*'` mode: substitutes unnamed → wildcard, leaves non-vault + already-named pass-through.
- `renderApprovePending` renders `vault:*:read` / `vault:*:write` (not raw) for unnamed input.
- Wildcard explanation surfaces when any scope is unnamed-vault; absent for all-non-vault, all-already-named, and empty-scope inputs.
- Authenticated admin branch gets the same substitution + explanation.

Cross-reference: hub#289 (the SPA + consent renderer that already did this).

## [0.5.11-rc.1] - 2026-05-20

**fix: regenerate well-known after install/upgrade/uninstall so discovery page reflects current state.**

Aaron hit this on fresh-install testing: after installing a module via `/admin/modules` (or the first-boot wizard), the new module didn't appear on `/`. Two related bugs:

1. **`runInstall` / `runUpgrade` did not stamp `installDir` on the seed services.json row.** The live `/.well-known/parachute.json` build in `hub-server.ts` calls `loadServiceUiMetadata(...)`, which skips entries without an `installDir` (it reads `<installDir>/.parachute/module.json` to find `uiUrl`). Without the stamp, the well-known doc shipped the new row but had no `uiUrl`, so the discovery page's tile renderer (`if (!svc.uiUrl) continue`) silently dropped it. The CLI `parachute install <svc>` already stamped `installDir` post-install — the API path didn't.

2. **No on-disk regen of `/.well-known/parachute.json` after state-changing ops.** The live HTTP response builds per request (since hub#135), so the discovery page itself recovers as soon as #1 is fixed. But the on-disk artifact at `~/.parachute/well-known/parachute.json` had stayed stale since the last `parachute expose` — useful for `cat`-based inspection and any tooling that reads the file directly to be kept in sync.

Fix shape:

- Extracted `regenerateWellKnown(...)` helper in `src/well-known.ts`. Reads services.json, walks each module's `.parachute/module.json` (vault → `managementUrl`; non-vault → `uiUrl` + `displayName`), builds the doc with `buildWellKnown`, writes via `writeWellKnownFile`. Mirrors hub-server's per-request build so the disk doc and the live HTTP build don't drift.
- `runInstall` / `runUpgrade` now call `stampInstallDir(spec, deps)` (using the same `findGlobalInstall` resolver the existing bun-add-retry path already uses) and then regen post-spawn / post-restart. Errors in the regen step land on the operation log instead of failing the op — the on-disk artifact is inspection-only.
- `runUninstall` calls `regenerateWellKnown` after removing the services.json row + running `bun remove -g`.

Tests:
- `runInstall` happy path → installDir lands on the row + on-disk well-known includes the new module.
- `runInstall` failure (bun add fails + findGlobalInstall null) → no well-known regen (asserted by file absence + no `regenerated` log line — no partial state).
- `runUpgrade` regenerates with the row's current version on the doc.
- `runUninstall` regenerates without the removed module (and keeps unrelated rows).
- Regen is idempotent across two consecutive install ops on the same module.

Test gate: `bun test ./src` → 1627 pass (was 1622, +5 new).

Cross-reference: hub#271's "discovery refresh" was a browser-cache fix (`Cache-Control: no-store` on `/.well-known/parachute.json` + `cache: 'no-store'` on the page's fetch). This rc is the server-side companion — the page now also has fresh data to fetch (because the row carries `installDir`, the live build can surface `uiUrl`).

## [0.5.10] - 2026-05-20

Stable release covering the v0.6 multi-user foundation + Gitcoin Brain UI compatibility. Cumulative changes since `0.5.9`:

- **Multi-user Phase 1** (PRs 1-5): users table + admin SPA + force-change-password + OAuth vault_scope claim + scope-guard enforcement. Admins can create per-user accounts with assigned vaults; users are scoped to their vault; cross-vault access returns 403.
- **First-boot wizard** (#262, #266, #271, #274): web-based setup at `/admin/setup` — admin account, vault provisioning, expose-mode configuration, auto-mint operator token, install Notes/Scribe inline. Eliminates CLI-only onboarding for cloud deploys.
- **Module install channel** (#276): operator-selectable `latest` / `rc` channel via env var or admin SPA toggle. Determines which channel module installs pull from.
- **Supervisor lifecycle hardening** (#273): `stop()` awaits child exit; SIGKILL fallback after configurable timeout; better test coverage.
- **CORS support** (#286, #288): `/oauth/*` cross-origin support with echo-origin + credentials for SPA OAuth flows (DCR, token exchange).
- **Approval UX** (#289): web-based approval replaces CLI `parachute auth approve-client` message; shareable admin link; resolved (named) scopes shown on consent.
- **Notes-connect recovery** (#277): "Unknown application" page now offers a one-click "Reset connection" button when SPA's cached client_id is stale.
- **Token visibility on done screen** (#277): MCP install command's Bearer token is masked by default + reveal-on-click + always-working copy.
- **Discovery refresh** (#271): module install through `/admin/modules` reflects in the discovery page without manual refresh.

See individual rc entries below for full detail.

## [0.5.10-rc.19] - 2026-05-20

Three approval / consent UX fixes Aaron hit while testing the Gitcoin Brain UI OAuth flow against his self-hosted hub. Same session as the rc.17 / rc.18 CORS work — different layer, same posture (third-party SPA → self-hosted hub).

**Issue 1 — Stale "ask the operator to run CLI" message on the unapproved-client page.** When a user lands on `/oauth/authorize` for a client that isn't yet approved AND they don't have an operator session, hub used to render:

> Ask the operator to run `parachute auth approve-client <id>` from a terminal, then try again.

This predated the web approval path that shipped in #277 (`/admin/approve-client/<id>` SPA route). The CLI mention is now retired in the browser path; the surface points operators at the web flow instead:

  1. **Primary CTA**: "Sign in as admin to approve" → links to `/login?next=/admin/approve-client/<client_id>` so the admin lands directly on the approval page after sign-in.
  2. **Secondary section**: "Or send this link to your hub admin" with the fully-qualified deep link `<hub_origin>/admin/approve-client/<client_id>` in a `<code>` block + a Copy-to-clipboard button (with "Copied!" feedback). The link works in any browser session — the admin opens it, hits the sign-in flow if not authed, lands on the approval page.

  The authenticated-admin branch (#208's one-click approve form) is unchanged — that's the easy path when the operator is already signed in to this hub from this browser. The CLI is still available for terminal-first operators who already know `parachute auth approve-client`; we just stop pointing new users there from a browser they're already in.

**Issue 2 — Consent / approval screens showed raw `vault:read` instead of the resolved `vault:<name>:read` form.** Hub narrows unnamed `vault:<verb>` scopes to `vault:<picked>:<verb>` at token-mint via the picker (or the user's `assigned_vault` for multi-user setups). But the consent screen rendered the raw OAuth request, which:

  - Implied vault-wide unrestricted access (when hub *always* pins a specific vault).
  - Surprised operators when the actual token carried a different shape than what they consented to.

  Display logic now substitutes:

  - **Non-admin user** (`assigned_vault` set) → `vault:<assigned>:read` on the consent row.
  - **Admin user, single-vault hub** → `vault:<only-vault>:read` on the consent row (the picker pre-checks the only available vault, so the displayed scope matches what default-Approve will mint).
  - **Admin user, multi-vault hub** → `vault:<TBD>:read` placeholder + an inline italic hint pointing at the picker below ("A specific vault is picked below before approving"). When the operator clicks a radio and reloads, the next render shows the chosen vault.
  - **Operator approval page (SPA)** — pending-client admin landing: `vault:read` → `vault:*:read` with an explanation that "a specific vault is selected during sign-in via the consent picker (or the user's assigned vault for multi-user setups)." Different from the consent screen because no per-user binding has happened at this point in the flow.

  `explainScope` now recognizes `vault:<name>:<verb>` and `vault:*:<verb>` via a pattern fallback so the styling + label come through. Per-vault admin (`vault:<name>:admin`) is intentionally excluded — that scope is `NON_REQUESTABLE`.

**Issue 3 — Shareable admin approval link.** Covered by Issue 1's deep-link section: fully-qualified URL + Copy button (`navigator.clipboard.writeText` with a graceful fallback to range-select for older browsers / sandboxed iframes that lack the async clipboard API). Visual feedback flips the button label to "Copied!" for 1.6s.

Code shape:

- **`src/oauth-ui.ts`** — `ApprovePendingViewProps` gains `hubOrigin` (required, to build the fully-qualified deep link) and drops the conditional CLI hint from both branches. New `renderUnauthenticatedApproveCtas(hubOrigin, clientId)` helper renders the Sign-in CTA + shareable-link block + inline clipboard JS. `ConsentViewProps` gains optional `displayVault: string | null | undefined` (undefined → no substitution / back-compat; null → `<TBD>` placeholder; string → named substitution). New exported `substituteVaultDisplay(scope, displayVault)` does the mapping. New CSS for `.approve-actions`, `.approve-signin-cta`, `.approve-share`, `.approve-share-row`, `.approve-share-link`, `.approve-share-copy`, `.scope-pending-note`.
- **`src/oauth-handlers.ts`** — `pendingClientResponse` threads `deps.issuer` through as `hubOrigin`. `consentProps` computes `displayVault` from `lockedVault` (non-admin → assigned vault) / `vaultNames` (admin + single-vault → that vault) / falls back to `null` (admin + multi-vault → `<TBD>` placeholder).
- **`src/scope-explanations.ts`** — `explainScope` matches `^vault:[a-zA-Z0-9_*-]+:(read|write)$` and returns the unnamed-verb entry, so the consent UI keeps the same explanation + level styling for `vault:work:read`, `vault:*:read`, etc.
- **`web/ui/src/routes/ApproveClient.tsx`** — `resolveScopeForDisplay(scope)` rewrites unnamed `vault:<verb>` → `vault:*:<verb>` for display; `isUnnamedVaultScope(scope)` gates whether to render the inline wildcard explanation.

Gate: `bun test ./src` — **1621 pass / 0 fail / 31388 expects across 84 files** (+21 over rc.18 baseline 1600). Hub typecheck + biome clean. SPA: 135 vitest tests pass, `bun run build` ships a fresh `dist/`.

Smoke (against `PARACHUTE_HOME=/tmp/hub-approval-ux` local hub):

- `GET /oauth/authorize?client_id=<pending>...` in a private window (no session): page renders "Sign in as admin to approve" button (linking to `/login?next=/admin/approve-client/<id>`), a shareable code block with the fully-qualified `https://hub.../admin/approve-client/<id>` URL, and a "Copy link" button. No CLI message.
- Clicking the Sign-in CTA hits `/login?next=...`; entering credentials lands on `/admin/approve-client/<id>` (the SPA route).
- Consent screen for a non-admin user with `assigned_vault: "default"` requesting `vault:read` renders `<code class="scope-name">vault:default:read</code>` (not `vault:read`).
- ApproveClient SPA for a fresh DCR with `scopes: ["vault:read", "vault:write"]` renders `vault:*:read` and `vault:*:write` with the wildcard-explanation hint.

Cross-references:

- #277 — web-based approval (`/admin/approve-client/<id>` SPA route) shipped earlier in the rc.18 chain. This PR points the unapproved-client surface at it.
- #284 — related stale-`assigned_vault` followup (multi-user Phase 1 PR 4 fanout).

## [0.5.10-rc.18] - 2026-05-20

Follow-up to rc.17's CORS work: switch the `/oauth/*` posture from static `Access-Control-Allow-Origin: *` + `Allow-Credentials: false` to echo-origin + `Allow-Credentials: true` + `Vary: Origin`. The rc.17 shape worked for SPAs fetching with `credentials: 'omit'`, but Aaron's Gitcoin Brain UI on `https://unforced-dev.github.io` (and most SPA frameworks by default) fetches with `credentials: 'include'`, which browsers refuse to combine with a wildcard ACAO. The browser console error was:

> Response to preflight request doesn't pass access control check: The value of the 'Access-Control-Allow-Origin' header in the response must not be the wildcard '*' when the request's credentials mode is 'include'.

The fix matches the canonical OAuth-authz-server posture (Auth0, Okta, Keycloak): echo the request's `Origin` header verbatim and set `Allow-Credentials: true`, with `Vary: Origin` for cache correctness (without it a browser/CDN can cache a response for one origin and reuse it for a different origin, breaking CORS in unpredictable ways). When the request arrives with no `Origin` header (non-browser caller like a `curl` probe without `-H Origin: …`), fall back to the rc.17 shape — wildcard `*` + `Allow-Credentials: false` — since non-browser callers don't enforce CORS but the response should still be well-formed.

Why this isn't a security regression vs `*`: browsers already restrict response readability by Origin under SOP — an attacker page issuing a `fetch(hub, {credentials: 'include'})` only gets to read the response if the server echoes that origin back in ACAO. Echoing back the origin the browser already sent reveals nothing the attacker couldn't reach by standing up their own server. The protocol-level gates (PKCE + `redirect_uri` matching + the operator-driven approval flow in #74/#199) still bound what a malicious cross-origin caller can *do*. For OAuth endpoints specifically — bearer-token-based, not cookie-based, designed for cross-origin SPA access by RFC 7591 DCR + RFC 6749 — echo-anything is the canonical posture. (For the broader `/api/*` admin surface, an allowlist is the right shape; that surface stays same-origin-only and isn't touched here.)

Code shape:

- **`src/cors.ts`** — `applyCorsHeaders` and `corsPreflightResponse` now take the `Request` as their first arg so they can read the `Origin` header per-call. The static-headers constants (`CORS_RESPONSE_HEADERS`, `CORS_PREFLIGHT_HEADERS`) keep only the request-independent pieces (Expose-Headers, Methods, Allow-Headers, Max-Age); the Origin / Credentials / Vary triple is computed per-request by a new `corsOriginHeaders(req)` helper that branches on Origin presence. File-level docstring expanded with the rc.17→rc.18 rationale and the why-this-isn't-an-allowlist note.
- **`src/hub-server.ts`** — every `applyCorsHeaders(...)` and `corsPreflightResponse(...)` call site now threads `req` through. Six `/oauth/*` route blocks plus the pre-dispatch OPTIONS handler.
- **`src/__tests__/cors.test.ts`** — existing tests reshaped from `expect(ACAO).toBe("*")` to `expect(ACAO).toBe(<origin>)` + `expect(Credentials).toBe("true")`. New cases pin: the no-Origin fallback (`*` + credentials:false), the Aaron-shaped request (`Origin: https://unforced-dev.github.io` → echoed verbatim), `Vary: Origin` presence on every echo-origin branch (regression guard against losing it).

Gate: `bun test ./src` — **1600 pass / 0 fail / 31331 expects across 84 files** (+5 over rc.17 baseline 1595). typecheck + biome clean.

Smoke (against `bun src/hub-server.ts --port 11939 --issuer https://parachute.taildf9ce2.ts.net`):

- `OPTIONS /oauth/register` with `Origin: https://unforced-dev.github.io` → `HTTP/1.1 204 No Content` + `Access-Control-Allow-Origin: https://unforced-dev.github.io` + `Access-Control-Allow-Credentials: true` + `Vary: Origin` + the unchanged Methods/Allow-Headers/Max-Age preamble. (Was on rc.17: `Access-Control-Allow-Origin: *` + `Allow-Credentials: false` — which the browser then rejected on the credentials:'include' fetch.)
- `OPTIONS /oauth/register` with no Origin header → `204` + `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Credentials: false` (the non-browser-caller fallback).
- `OPTIONS /api/me` from a third-party origin → still no `Access-Control-Allow-Origin` echo (scope discipline preserved).

## [0.5.10-rc.17] - 2026-05-20

CORS support on the public OAuth surface so third-party SPAs can talk to a self-hosted hub from a foreign origin. Caught when Aaron's Gitcoin Brain UI at `https://unforced-dev.github.io` tried to OAuth-register with his hub at `https://parachute.taildf9ce2.ts.net`: the browser's preflight on `POST /oauth/register` got back a 405 without CORS headers and blocked the actual request, breaking the entire third-party-SPA story. OAuth Dynamic Client Registration (RFC 7591) is *designed* for cross-origin use — arbitrary SPAs register → authorize → exchange tokens — so wildcard CORS on the OAuth endpoints is the correct posture, not a workaround.

Backend surface:

- **New `src/cors.ts`** — single-source-of-truth for the CORS posture. Exports `CORS_RESPONSE_HEADERS` (the headers folded onto actual responses), `CORS_PREFLIGHT_HEADERS` (superset for OPTIONS preflights), `isCorsAllowedRoute(pathname)` (predicate matching `/oauth/*`), `corsPreflightResponse()` (204 + preflight headers), and `applyCorsHeaders(response)` (folds the response headers onto an existing Response). File-level comment lays out the matrix, the `Allow-Origin: *` + `Allow-Credentials: false` rationale, and per-header justification (Authorization + Content-Type + X-Requested-With in `Allow-Headers`; `Max-Age: 86400` for a 24h preflight cache; WWW-Authenticate in `Expose-Headers` so cross-origin SPAs can read RFC 6750 error responses).
- **`src/hub-server.ts`** — two changes:
  - Pre-dispatch OPTIONS preflight handler at the top of `hubFetch` (after the 301 redirects, before `/health`): `if (req.method === "OPTIONS" && isCorsAllowedRoute(pathname)) return corsPreflightResponse()`. This intercepts before the per-route handlers, so an OPTIONS to `/oauth/register` doesn't hit the POST-only handler's 405 branch — preflight is a CORS-protocol artifact, not a "real" request to the endpoint.
  - Each `/oauth/*` route block (`/oauth/authorize`, `/oauth/authorize/approve`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`) wraps its returns in `applyCorsHeaders(...)` so error branches (405 method-not-allowed, 503 db-not-configured) carry CORS too. Without that, the SPA can't read the error body — the browser shows it as an opaque network failure.

Scope discipline:

- **In-scope**: `/oauth/*` only. The four `/.well-known/*` documents (oauth-authorization-server, parachute.json, jwks.json, parachute-revocation.json) are *also* cross-origin endpoints but already carry their own inline CORS handling (narrower `Allow-Methods: GET, OPTIONS` since they're read-only) and predate this module. `isCorsAllowedRoute` intentionally excludes them so there's one CORS posture per route family — see the comment in `src/cors.ts`.
- **Out-of-scope (still same-origin-only, no CORS headers)**: `/api/*` (admin Bearer surface), `/admin/*` (SPA shell), `/login` / `/logout` / `/account/*` (interactive session pages), `/vault/*` and other module content proxies. Those *do* consult cookies / minted bearers tied to the operator's hub origin; opening them cross-origin would unwire CSRF defenses for no third-party benefit. Tests in `src/__tests__/cors.test.ts` pin both directions: every `/oauth/*` route gets CORS, every listed out-of-scope route does not.

Why wildcard origin (`*`) and not an allowlist: these endpoints are public by design. The OAuth protocol (RFC 6749) plus DCR (RFC 7591) put the access-control gate inside the protocol — PKCE, redirect_uri matching, the operator-driven approval flow in #74/#199 — not at the network layer. Wildcard origin is the canonical posture for OAuth authorization servers (Okta, Auth0, Keycloak); narrowing at this layer breaks legitimate third-party SPAs without preventing any attack the protocol doesn't already cover. Wildcard is safe with `Allow-Credentials: false` because none of these endpoints consult cookies — bearer tokens travel in the Authorization header, which credentials:false + origin:* allows.

Gate: `bun test ./src` — **1595 pass / 0 fail / 31295 expects across 84 files** (+20 over rc.16 baseline 1575). typecheck + biome clean (root).

Smoke (against `bun src/hub-server.ts --port 11939 --issuer https://parachute.taildf9ce2.ts.net`):

- `OPTIONS /oauth/register` with `Origin: https://unforced-dev.github.io` → `HTTP/1.1 204 No Content` + `Access-Control-Allow-Origin: *` + `Access-Control-Allow-Methods: GET, POST, OPTIONS` + `Access-Control-Allow-Headers: Authorization, Content-Type, X-Requested-With` + `Access-Control-Max-Age: 86400`. (Was: 405 with no CORS headers — the original bug.)
- `POST /oauth/register` with `Origin: https://unforced-dev.github.io` and a valid DCR body → `HTTP/1.1 201 Created` + `Access-Control-Allow-Origin: *` + the new client row in the response body.
- `OPTIONS /api/me` and `OPTIONS /login` from the same third-party origin → no `Access-Control-Allow-Origin` header in the response (scope discipline preserved).

Follow-up (filed by orchestrator): admin-configurable CORS allowlist on `/api/*` + module content routes (`/vault/*`, etc.). The wildcard posture isn't appropriate for those — they need per-operator origin allowlisting. Out of scope for this PR.

## [0.5.10-rc.16] - 2026-05-20

Multi-user Phase 1 — PR 5 of 5: scope-guard `vault_scope` enforcement (hub#285, design [`parachute.computer/design/2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/)). PR 4 (rc.15) wired hub to mint `vault_scope: [<assigned_vault>]` on every JWT; PR 5 adds the consumer-side surface so resource servers (vault first; scribe + notes don't need it) can refuse cross-vault access as defense-in-depth.

Workspace bump only — hub itself is unchanged; the substance lives in `packages/scope-guard/`:

- `@openparachute/scope-guard` 0.2.1 → 0.3.0-rc.1 (minor bump because `HubJwtClaims` gains a required field). New surfaces:
  - **`HubJwtClaims.vaultScope: string[]`** — parsed from the `vault_scope` claim. Non-empty for non-admin users (Phase 1: single-element list naming `assigned_vault`); empty `[]` for admin users, pre-PR-4 tokens, and any malformed value. All "no pin" shapes collapse to `[]` so consumers don't distinguish absent from empty.
  - **`enforceVaultScope(claims, requestVaultName) → boolean`** — opt-in helper. Returns true if `vaultScope` is `[]` (admin/unpinned) OR contains the target vault name; false otherwise. Consumers translate `false` to a 403 with `error: "vault_scope_mismatch"`.

Defense-in-depth, not the primary gate. PR 4's `narrowVaultScopes` already produces tokens whose `scope` claim names the exact assigned vault (`vault:<assigned>:<verb>`), and vault's existing scope-string check is the primary control. `vault_scope` is the second layer for the case where a token-mint bug or third-party RS not enforcing the vocabulary correctly produces a scope string naming the wrong vault — the check kicks in before any vault data is touched.

Consumer adoption: **vault** wires `enforceVaultScope` into `authenticateHubJwt` in a follow-up after this release publishes; **scribe** + **notes** + **parachute-agent** are no-touch (scopes aren't vault-named today).

Token-shape compatibility: pre-PR-4 tokens lack the `vault_scope` claim entirely. The validate path surfaces those as `vaultScope: []` — admin-equivalent for vault-pin purposes. Without this back-compat, every existing operator-token would start 403-ing the moment vault wires in `enforceVaultScope`.

Gate: hub `bun test ./src` → **1575 pass / 0 fail** (unchanged). scope-guard `bun test packages/scope-guard/src` → **99 pass / 0 fail / 177 expects** (+5 `vault_scope` claim-parsing cases on validate, +3 `enforceVaultScope` shape cases on the helper, +1 on-wire-null fail-open case from the post-merge reviewer-nit fold). typecheck + biome clean.

(Entry backfilled retroactively in rc.17 — the merge for hub#285 didn't include a hub-side CHANGELOG block since the substance was scope-guard's own package. Adding it here so the hub CHANGELOG sequence is unbroken.)

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
